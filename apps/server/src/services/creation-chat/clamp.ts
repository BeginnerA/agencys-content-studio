/**
 * 轻松创作 ier A 后置钳制。
 *
 * 背景：LLM 生成 `CreationPlan` 时不知道当前 video 实例能力档位（`resolveVideoCaps`）；
 * 常在 `preflightPlan` 阶段抛 `duration_unsupported` / `aspect_unsupported` / `capabilities_unverified`，
 * 用户被迫「重新规划」。本特性引入 clamp：
 * - **有 caps（真源表命中）**：shot.duration 就近上取合法档位；plan.aspectRatio 不在集合内
 *   → 改为 `caps.aspectRatios[0]`（默认竖屏优先）；钳制后重算 plan.duration（保持
 *   `contract.ts` superRefine 的「镜头时长和 = 总时长」不变式）。
 * - **无 video 实例（hasVideo=false）**：`plan.mode='dynamic'` 强制降级 `'slideshow'`
 *   （多图配音），reason='视频能力未背书'。
 *
 * 红线：
 * - 只调数值/枚举，**不动 script / lines / shots 文本内容**（保留 LLM 创意）。
 * - **不静默降级**：每次钳制记入 `ClampReport.notes`，`planning.ts` 将 notes 追加到
 *   `assistant message` 尾部（「因当前视频模型能力上限：镜头 S3 时长 20→15 秒；...」）。
 * - **clamp 后仍走 preflightPlan**：若还有病态（如 `caps.aspectRatios=[]`），走原 throw 路径。
 */
import type { VideoModelCaps } from '../../adapters/video-capabilities'
import { creationPlanSchema, type CreationPlan } from './contract'
import { assertDialogueCapacity } from './dialogue'

export interface ClampReport {
  /** 每镜钳制明细（LLM 输出 → 钳后值）；未钳制的镜头不列 */
  shotDurations: Array<{ id: string; from: number; to: number }>
  /** 画幅钳制（LLM 输出 → 钳后值） */
  aspectRatio?: { from: string; to: string }
  /** 模式降级（dynamic → slideshow） */
  mode?: { from: string; to: string; reason: string }
  /** 供 assistant message 追加的人类可读短句 */
  notes: string[]
  /** 是否发生过任何钳制（false = plan 原样返回） */
  changed: boolean
}

/** 就近上取合法档位；若都小于目标值 → 取最大档；空集合 → 原值 */
function snapToCapsDuration(target: number, durations: number[]): number {
  if (!durations.length) return target
  const sorted = [...durations].sort((a, b) => a - b)
  for (const d of sorted) if (d >= target) return d
  return sorted[sorted.length - 1]!
}

/**
 * 依视频能力真源表钳制方案。
 * @param plan LLM 原方案（不改动，本函数返回新对象）
 * @param caps 真源表命中的能力（null = 未登记模型，跳过数值钳制）
 * @param hasVideo 是否配置了 video 实例（false = 强制 slideshow）
 */
export function clampPlanToCaps(
  plan: CreationPlan,
  caps: VideoModelCaps | null,
  hasVideo: boolean,
): { plan: CreationPlan; report: ClampReport } {
  const report: ClampReport = { shotDurations: [], notes: [], changed: false }
  let next: CreationPlan = { ...plan, shots: plan.shots.map((s) => ({ ...s })), lines: [...plan.lines] }

  if (plan.performance === 'dialogue') {
    if (!hasVideo || !caps) {
      report.notes.push('人物对白需求已保留，当前视频能力未就绪，请检查配置；不会改为旁白或图文')
      return { plan, report }
    }
    const durations = [...caps.durations].sort((a, b) => a - b)
    for (const shot of next.shots) {
      const duration = durations.find((d) => d >= shot.duration)
      if (!duration) {
        report.notes.push(`人物对白镜头 ${shot.id} 超出支持镜长，请调整方案；不能缩短或截断对白`)
        return { plan, report }
      }
      shot.duration = duration
    }
    next.duration = next.shots.reduce((sum, s) => sum + s.duration, 0)
    try {
      creationPlanSchema.parse(next)
      assertDialogueCapacity(next)
    } catch {
      report.notes.push('人物对白镜长调整后总时长或台词容量不合法，请修改方案后重新确认')
      return { plan, report }
    }
    report.shotDurations = next.shots.filter((s, i) => s.duration !== plan.shots[i]!.duration)
      .map((s, i) => ({ id: s.id, from: plan.shots.find((p) => p.id === s.id)!.duration, to: s.duration }))
    report.changed = report.shotDurations.length > 0
    if (report.changed) report.notes.push(`人物对白镜长向上调整，总时长 ${plan.duration}→${next.duration}s`)
    return { plan: next, report }
  }

  // ① 无 video 实例 → 强制降级 slideshow（有 caps 也不改，因为 hasVideo=false 意味着无 video endpoint）
  if (!hasVideo && next.mode === 'dynamic') {
    report.mode = { from: 'dynamic', to: 'slideshow', reason: '视频能力未背书（无可用 video 实例）' }
    report.notes.push('模式 dynamic→slideshow（未配置视频实例）')
    report.changed = true
    next = { ...next, mode: 'slideshow' }
  }

  // ② 有 caps 时按档位钳制（未登记模型跳过，交 preflight fail-closed）
  if (caps) {
    // 镜头时长
    for (const shot of next.shots) {
      if (!caps.durations.includes(shot.duration)) {
        const snapped = snapToCapsDuration(shot.duration, caps.durations)
        if (snapped !== shot.duration) {
          report.shotDurations.push({ id: shot.id, from: shot.duration, to: snapped })
          shot.duration = snapped
          report.changed = true
        }
      }
    }
    if (report.shotDurations.length > 0) {
      const detail = report.shotDurations.map((s) => `${s.id} ${s.from}→${s.to}s`).join('；')
      report.notes.push(`镜头时长钳制：${detail}`)
    }
    // 总时长重算（superRefine 要求镜头时长和 = duration）
    const sum = next.shots.reduce((acc, s) => acc + s.duration, 0)
    if (sum !== next.duration) {
      // 保持整数（clamp 到 30–60 契约范围）；越界不视为错误，交给 preflight/LLM 处理
      const rounded = Math.max(30, Math.min(60, Math.round(sum)))
      if (rounded !== next.duration) {
        report.notes.push(`成片时长 ${next.duration}→${rounded}s（重算镜头和）`)
        next = { ...next, duration: rounded }
        report.changed = true
      }
    }
    // 画幅
    if (next.aspectRatio && !caps.aspectRatios.includes(next.aspectRatio as '9:16' | '16:9' | '1:1')) {
      const fallback = caps.aspectRatios[0]
      if (fallback) {
        report.aspectRatio = { from: next.aspectRatio, to: fallback }
        report.notes.push(`画幅 ${next.aspectRatio}→${fallback}（当前模型仅支持 ${caps.aspectRatios.join('/')}）`)
        next = { ...next, aspectRatio: fallback }
        report.changed = true
      }
    }
  }

  return { plan: next, report }
}
