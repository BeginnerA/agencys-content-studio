import { spawn } from 'node:child_process'
import { mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveFfmpeg } from './ffmpeg'
import { absPathOf, projectAbsDir } from './storage'

// 缩略图服务：ffmpeg 生成 480px WebP 磁盘缓存（projects/<pid>/thumbs/<assetId>.webp）。
// 生成失败（ffmpeg 缺失/源异常）返回 null，调用方回退原图，不影响资产可访问性。

/** 可生成缩略图的图片扩展名（gif 取首帧） */
const THUMB_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])

/** 单次生成超时（毫秒） */
const TIMEOUT_MS = 30_000

/** in-flight 去重：同一资产并发请求只触发一次生成 */
const inflight = new Map<string, Promise<string | null>>()

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
  if (!THUMB_EXT.has(ext)) return Promise.resolve(null)
  const out = thumbAbsPath(asset.projectId, asset.id)
  if (exists(out)) return Promise.resolve(out)
  const running = inflight.get(out)
  if (running) return running
  const task = generate(absPathOf(asset.relPath), out).finally(() => inflight.delete(out))
  inflight.set(out, task)
  return task
}

/** 用 ffmpeg 生成缩略图（tmp + rename 原子写，避免半成品被缓存命中） */
function generate(src: string, out: string): Promise<string | null> {
  return new Promise((resolve) => {
    const ffmpeg = resolveFfmpeg()
    if (!ffmpeg || !exists(src)) return resolve(null)
    mkdirSync(dirname(out), { recursive: true })
    // 临时文件与目标同目录（同卷 rename 原子）；扩展名保持 .webp 供 ffmpeg 推断封装格式
    const tmp = `${out}.${process.pid}.${Date.now()}.tmp.webp`
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', src,
      // scale 表达式内逗号需转义（spawn 无 shell，不可依赖引号包裹）
      '-vf', 'scale=min(480\\,iw):-2',
      '-c:v', 'libwebp', '-quality', '78',
      '-frames:v', '1',
      tmp,
    ]
    let settled = false
    const done = (result: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (result === null) cleanup(tmp)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      done(null)
    }, TIMEOUT_MS)
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' })
    child.on('error', () => done(null))
    child.on('close', (code) => {
      if (code !== 0 || !exists(tmp)) return done(null)
      try {
        renameSync(tmp, out)
        done(out)
      } catch {
        done(null)
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
