import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { assets, type Asset } from '../db/schema'
import { createLogger } from '../logger'
import { resolveFfmpeg } from './ffmpeg'
import { absPathOf } from './storage'

// [M12] 图像有效性检测：ffmpeg signalstats 单帧像素统计（复用 ffmpeg-static，零新依赖）。
// 判定「损坏 / 黑图 / 纯色空白」三类异常，结果写 assets.params.quality（零新列）。
// 保守策略：阈值宁漏报不误报（暗调/风格化纯色属正常创作），ffmpeg 不可用 → ok=null 宽容不标记。

const log = createLogger('image-check')

/** 单次检测超时（毫秒） */
const TIMEOUT_MS = 15_000

/** stderr 采集上限（防极端输出撑爆内存；signalstats 输出很小，仅为兜底） */
const MAX_STDERR = 512 * 1024

/** 近纯色判定：动态范围（YMAX-YMIN）小于该值视为全图无细节 */
const FLAT_RANGE = 4

/** 黑图判定：平均亮度（YAVG）不高于该值（limited range 纯黑基准 Y=16 恰在边界，含等号） */
const BLACK_AVG = 16

export interface ImageQualityStats {
  ymin: number
  ymax: number
  yavg: number
  satavg: number
}

export type ImageQualityReason = 'ok' | 'black' | 'flat' | 'broken' | 'no_file' | 'ffmpeg_unavailable'

export interface ImageQuality {
  /** true=正常；false=异常（black/flat/broken/no_file）；null=无法检测（ffmpeg_unavailable） */
  ok: boolean | null
  reason: ImageQualityReason
  stats?: ImageQualityStats
}

/** 中文化 reason（board/列表徽标 title 用） */
export const QUALITY_TEXT: Record<ImageQualityReason, string> = {
  ok: '正常',
  black: '疑似黑图',
  flat: '疑似纯色空白图',
  broken: '疑似损坏图',
  no_file: '文件缺失',
  ffmpeg_unavailable: '无法检测（ffmpeg 不可用）',
}

/**
 * 检测单张图片：ffmpeg signalstats 统计首个完整帧。
 * 文件缺失 → no_file；ffmpeg 不可用 → ok=null 宽容；解码失败/无统计 → broken。
 */
export async function checkImageFile(absPath: string): Promise<ImageQuality> {
  try {
    if (!statSync(absPath).isFile()) return { ok: false, reason: 'no_file' }
  } catch {
    return { ok: false, reason: 'no_file' }
  }
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) return { ok: null, reason: 'ffmpeg_unavailable' }
  const stderr = await runStats(ffmpeg, absPath)
  if (stderr === null) return { ok: false, reason: 'broken' }
  const stats = parseStats(stderr)
  if (!stats) return { ok: false, reason: 'broken' }
  const range = stats.ymax - stats.ymin
  if (range < FLAT_RANGE) {
    // 含等号：PNG 纯黑（0,0,0）经 yuv limited 转换后 Y=16，与黑基准恰在边界（实弹校准见 probe-m12）
    if (stats.yavg <= BLACK_AVG) return { ok: false, reason: 'black', stats }
    return { ok: false, reason: 'flat', stats }
  }
  return { ok: true, reason: 'ok', stats }
}

/** 读取资产 → 检测（仅 image）→ merge params.quality 写回 → 返回新行；资产不存在/非图/无文件路径 → null */
export async function checkAndRecordAsset(assetId: number): Promise<Asset | null> {
  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), isNull(assets.deletedAt)))
    .limit(1)
  const a = rows[0]
  if (!a || a.kind !== 'image' || !a.relPath) return null
  const quality = await checkImageFile(absPathOf(a.relPath))
  return recordQuality(a, quality)
}

/** 检测结果 merge 进 params.quality（保留既有键；零新列） */
export async function recordQuality(a: Asset, quality: ImageQuality): Promise<Asset> {
  let params: Record<string, unknown> = {}
  if (a.params) {
    try {
      const parsed = JSON.parse(a.params) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) params = parsed as Record<string, unknown>
    } catch {
      params = {}
    }
  }
  params['quality'] = { ...quality, checkedAt: Date.now() }
  const rows = await db
    .update(assets)
    .set({ params: JSON.stringify(params), updatedAt: Date.now() })
    .where(eq(assets.id, a.id))
    .returning()
  return rows[0]!
}

/** fire-and-forget 写时检测：生成/上传落盘后调用；任何失败仅日志，不影响主链 */
export function scheduleImageCheck(asset: { id: number; kind: string; relPath: string | null }): void {
  if (asset.kind !== 'image' || !asset.relPath) return
  void (async () => {
    try {
      const updated = await checkAndRecordAsset(asset.id)
      if (updated) {
        let q: ImageQuality | null = null
        try {
          q = (JSON.parse(updated.params ?? '{}') as { quality?: ImageQuality }).quality ?? null
        } catch {
          q = null
        }
        if (q && q.ok === false) log.warn(`asset#${asset.id} 图像检测异常：${q.reason}`)
      }
    } catch (err) {
      log.warn(`asset#${asset.id} 图像检测失败：${(err as Error).message}`)
    }
  })()
}

/** spawn ffmpeg 跑 signalstats，返回 stderr 全文；失败/超时 → null */
function runStats(ffmpeg: string, src: string): Promise<string | null> {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'info',
      '-i', src,
      '-vf', 'signalstats,metadata=print',
      '-frames:v', '1',
      '-f', 'null', '-',
    ]
    let out = ''
    let settled = false
    const done = (v: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => {
      child.kill()
      done(null)
    }, TIMEOUT_MS)
    const child = spawn(ffmpeg, args, { windowsHide: true })
    child.stderr.on('data', (chunk: Buffer) => {
      out += String(chunk)
      if (out.length > MAX_STDERR) out = out.slice(-MAX_STDERR / 2)
    })
    child.on('error', () => done(null))
    child.on('close', (code) => {
      if (code !== 0) return done(null)
      done(out)
    })
  })
}

/** 解析 signalstats 首个完整帧的 YMIN/YMAX/YAVG/SATAVG（缺失核心三值 → null）；导出供 probe-m12 直测容错 */
export function parseStats(stderr: string): ImageQualityStats | null {
  const vals = new Map<string, number>()
  const re = /lavfi\.signalstats\.(YMIN|YMAX|YAVG|SATAVG)=([\d.]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stderr)) !== null) {
    if (!vals.has(m[1]!)) vals.set(m[1]!, Number(m[2]))
  }
  const ymin = vals.get('YMIN')
  const ymax = vals.get('YMAX')
  const yavg = vals.get('YAVG')
  if (ymin === undefined || ymax === undefined || yavg === undefined) return null
  if (!Number.isFinite(ymin) || !Number.isFinite(ymax) || !Number.isFinite(yavg)) return null
  return { ymin, ymax, yavg, satavg: vals.get('SATAVG') ?? 0 }
}
