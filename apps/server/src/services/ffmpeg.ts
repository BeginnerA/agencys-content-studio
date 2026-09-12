import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import ffmpegStatic from 'ffmpeg-static'
import { env } from '../env'

// 内置二进制（pnpm install 时由 postinstall 下载，授权见 pnpm-workspace.yaml allowBuilds）；
// ffmpeg-static 类型为 string | null（平台不支持时为 null），ffprobe-static 无类型声明：createRequire 引入（导出形态 { path: string }）
const ffmpegStaticPath = ffmpegStatic ?? ''
const ffprobeStaticPath = (createRequire(import.meta.url)('ffprobe-static') as { path?: string }).path ?? ''

let cached: string | null | undefined

/**
 * 定位可用 ffmpeg（三级兜底）：env.CSTUDIO_FFMPEG_PATH 显式指定 → 内置二进制（ffmpeg-static）
 * → 系统 PATH。逐级 spawn -version 实测，损坏/缺失（如下载失败）自动跳到下一级；
 * 结果进程内缓存；health 接口据此报告。
 */
export function resolveFfmpeg(): string | null {
  if (cached !== undefined) return cached
  const candidates = [env.ffmpegPath, ffmpegStaticPath, 'ffmpeg'].filter((c) => c.length > 0)
  for (const candidate of candidates) {
    try {
      const r = spawnSync(candidate, ['-version'], { stdio: 'ignore', timeout: 5000 })
      if (!r.error && r.status === 0) {
        cached = candidate
        return cached
      }
    } catch {
      // 继续尝试下一个候选
    }
  }
  cached = null
  return cached
}

let probeCached: string | null | undefined

/** 定位 ffprobe（三级兜底：env → 内置 ffprobe-static → PATH）——时长探测用 */
export function resolveFfprobe(): string | null {
  if (probeCached !== undefined) return probeCached
  const candidates = [env.ffprobePath, ffprobeStaticPath, 'ffprobe'].filter((c) => c.length > 0)
  for (const candidate of candidates) {
    try {
      const r = spawnSync(candidate, ['-version'], { stdio: 'ignore', timeout: 5000 })
      if (!r.error && r.status === 0) {
        probeCached = candidate
        return probeCached
      }
    } catch {
      // 继续尝试下一个候选
    }
  }
  probeCached = null
  return probeCached
}

/** 探测媒体文件时长（秒）；ffprobe 缺失/失败 → null（调用方自行兜底） */
export function probeMediaDuration(file: string): number | null {
  const ffprobe = resolveFfprobe()
  if (!ffprobe) return null
  try {
    const r = spawnSync(
      ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true },
    )
    if (r.error || r.status !== 0) return null
    const n = Number(String(r.stdout ?? '').trim())
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}
