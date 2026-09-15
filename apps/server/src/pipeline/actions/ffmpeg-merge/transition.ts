import { TRANSITIONS } from '../../../services/compose-config'
import { clamp, round3 } from './util'

/** [M11] 转场计划（videoLens 段实际长度；offsets = V_k；总长仍 Σd） */
export interface TransitionPlan {
  enabled: boolean
  type: string
  durSec: number
  videoLens: number[]
  offsets: number[]
  totalDur: number
}

/**
 * [M11] 转场计划（§2.5 数学；纯函数，探针直测）：
 * - 禁用：n < 2 / transition = none / 非法值；
 * - T = clamp(durationSec, 0.1, min(2, min(d)))；前 n−1 镜段长 d+T（末镜 d）；
 * - offset o_k = V_k = Σ_{j≤k} d_j（k=1..n−1）；totalDur = Σd。
 */
export function buildTransitionPlan(durations: number[], transition: string, durationSec: number): TransitionPlan {
  const n = durations.length
  const totalDur = round3(durations.reduce((s, d) => s + d, 0))
  const disabled: TransitionPlan = {
    enabled: false,
    type: 'none',
    durSec: 0,
    videoLens: durations.slice(),
    offsets: [],
    totalDur,
  }
  if (n < 2) return disabled
  if (!(TRANSITIONS as readonly string[]).includes(transition) || transition === 'none') return disabled
  const minDur = Math.min(...durations)
  if (!(minDur > 0)) return disabled
  const durSec = round3(clamp(durationSec, 0.1, Math.min(2, minDur)))
  if (!(durSec > 0)) return disabled
  const videoLens = durations.map((d, i) => (i < n - 1 ? round3(d + durSec) : d))
  const offsets: number[] = []
  let acc = 0
  for (let k = 0; k < n - 1; k++) {
    acc = round3(acc + durations[k]!)
    offsets.push(acc)
  }
  return { enabled: true, type: transition, durSec, videoLens, offsets, totalDur: round3(acc + durations[n - 1]!) }
}
