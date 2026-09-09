import { spawnSync } from 'node:child_process'
import { env } from '../env'

let cached: string | null | undefined

/**
 * 定位可用 ffmpeg：env.CSTUDIO_FFMPEG_PATH 优先，其次 PATH 探测。
 * 结果进程内缓存；health 接口据此报告。
 */
export function resolveFfmpeg(): string | null {
  if (cached !== undefined) return cached
  const candidates = [env.ffmpegPath, 'ffmpeg'].filter((c) => c.length > 0)
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
