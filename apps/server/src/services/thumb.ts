import { spawn } from 'node:child_process'
import { mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveFfmpeg } from './ffmpeg'
import { absPathOf, projectAbsDir } from './storage'

// 缩略图服务：ffmpeg 生成 480px WebP 磁盘缓存（projects/<pid>/thumbs/<assetId>.webp）。
// 图片取整帧；视频抽 ~0.1s 处首帧（避开淡入黑帧），失败退回第 0 帧。
// 生成失败（ffmpeg 缺失/源异常）返回 null：图片回退原图、视频由前端回退占位/客户端抽帧。

/** 可直接生成缩略图的图片扩展名（gif 取首帧） */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])

/** 可抽帧生成封面的视频扩展名 */
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi'])

/** 单次生成超时（毫秒） */
const TIMEOUT_MS = 30_000

/** 视频抽帧时间点（秒）：避开可能的淡入黑帧 */
const VIDEO_SEEK_SEC = 0.1

/** 失败负缓存时长（毫秒）：坏源短期内不重复触发 ffmpeg */
const FAIL_TTL_MS = 5 * 60_000

/** in-flight 去重：同一资产并发请求只触发一次生成 */
const inflight = new Map<string, Promise<string | null>>()

/** 失败负缓存（out 路径 → 失败时间戳） */
const failed = new Map<string, number>()

/** 缩略图缓存绝对路径 */
export function thumbAbsPath(projectId: number, assetId: number): string {
  return join(projectAbsDir(projectId), 'thumbs', `${assetId}.webp`)
}

export interface ThumbAsset {
  id: number
  projectId: number
  ext: string | null
  relPath: string | null
}

/**
 * 确保缩略图已生成（磁盘缓存命中直接返回；并发请求去重）。
 * 返回缩略图绝对路径；不支持/生成失败 → null。
 */
export function ensureThumb(asset: ThumbAsset): Promise<string | null> {
  if (!asset.relPath) return Promise.resolve(null)
  const ext = (asset.ext ?? '').replace(/^\./, '').toLowerCase()
  const isVideo = VIDEO_EXT.has(ext)
  if (!isVideo && !IMAGE_EXT.has(ext)) return Promise.resolve(null)
  const out = thumbAbsPath(asset.projectId, asset.id)
  if (exists(out)) return Promise.resolve(out)
  const failedAt = failed.get(out)
  if (failedAt !== undefined && Date.now() - failedAt < FAIL_TTL_MS) return Promise.resolve(null)
  const running = inflight.get(out)
  if (running) return running
  const task = generate(absPathOf(asset.relPath), out, isVideo)
    .then((result) => {
      if (result) failed.delete(out)
      else failed.set(out, Date.now())
      return result
    })
    .finally(() => inflight.delete(out))
  inflight.set(out, task)
  return task
}

/** 生成缩略图：视频先 seek 抽帧、失败退回第 0 帧；图片单次整帧 */
async function generate(src: string, out: string, isVideo: boolean): Promise<string | null> {
  if (!resolveFfmpeg() || !exists(src)) return null
  mkdirSync(dirname(out), { recursive: true })
  const seeks: Array<number | null> = isVideo ? [VIDEO_SEEK_SEC, null] : [null]
  for (const seek of seeks) {
    if (await extractFrame(src, out, seek)) return out
  }
  return null
}

/** 单次抽帧（tmp + rename 原子写，避免半成品被缓存命中；成功返回 true） */
function extractFrame(src: string, out: string, seekSec: number | null): Promise<boolean> {
  return new Promise((resolve) => {
    const ffmpeg = resolveFfmpeg()
    if (!ffmpeg) return resolve(false)
    // 临时文件与目标同目录（同卷 rename 原子）；扩展名保持 .webp 供 ffmpeg 推断封装格式
    const tmp = `${out}.${process.pid}.${Date.now()}.tmp.webp`
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      ...(seekSec !== null ? ['-ss', String(seekSec)] : []),
      '-i', src,
      // scale 表达式内逗号需转义（spawn 无 shell，不可依赖引号包裹）
      '-vf', 'scale=min(480\\,iw):-2',
      '-c:v', 'libwebp', '-quality', '78',
      '-frames:v', '1',
      tmp,
    ]
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!ok) cleanup(tmp)
      resolve(ok)
    }
    const timer = setTimeout(() => {
      child.kill()
      done(false)
    }, TIMEOUT_MS)
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' })
    child.on('error', () => done(false))
    child.on('close', (code) => {
      if (code !== 0 || !exists(tmp)) return done(false)
      try {
        renameSync(tmp, out)
        done(true)
      } catch {
        done(false)
      }
    })
  })
}

function exists(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}

function cleanup(p: string): void {
  try { unlinkSync(p) } catch { /* 无临时文件则忽略 */ }
}
