import type { Checker } from '../../probe-lib'
import type { CreationPlan } from '../../../src/services/creation-chat/contract'

export async function probePlanning({ check }: Checker, plan: CreationPlan): Promise<void> {
  const { clampPlanToCaps } = await import('../../../src/services/creation-chat/clamp')
  const { resolveVideoCaps } = await import('@agencys/ai-provider-kit')
  const caps = resolveVideoCaps('volcengine_video', 'doubao-seedance-2-0-260128')!
  const none = clampPlanToCaps(plan, null, false)
  check(none.plan.mode === 'dynamic' && none.plan.performance === 'dialogue', '缺视频仍保留人物对白需求，不降级图文')
  check(none.report.notes.some((s) => s.includes('对白')), '缺少对白能力原因可见')
  const short = clampPlanToCaps(plan, { ...caps, durations: [5] }, true)
  check(short.plan.shots.every((s) => s.duration === 8), '对白不压短镜头以迎合供应商档位')
  const raised = clampPlanToCaps(plan, { ...caps, durations: [10] }, true)
  check(raised.plan.duration === 40 && raised.plan.shots.every((s) => s.duration === 10), '允许向上调整对白镜长，并重算合法总长')
  const overflowPlan = { ...plan, duration: 40, shots: [...plan.shots, { ...plan.shots[0]!, id: 's5' }] }
  const overflow = clampPlanToCaps(overflowPlan, { ...caps, durations: [15] }, true)
  check(overflow.plan.shots.every((s) => s.duration === 8), '上取导致全片超过 60 秒时不输出伪合法总时长')
  const { compileDialogueShot, assertDialogueCapacity } = await import('../../../src/services/creation-chat/dialogue')
  const compiled = compileDialogueShot(plan, 's1')
  check(compiled.prompt.includes(plan.lines[0]!.text) && !compiled.prompt.includes(plan.lines[1]!.text), '每镜仅编译对应逐字台词')
  check(compiled.prompt.includes(plan.cast![0]!.voice) && compiled.prompt.includes(plan.cast![1]!.appearance), '完整注入说话声线与同框角色外貌')
  check(compiled.prompt.includes('不添加旁白') && compiled.prompt.includes('不生成画内字幕'), '原生音画约束明确禁止旁白和画内字幕')
  check(compileDialogueShot(plan, 's1').dialogueHash === compiled.dialogueHash, '对白指纹稳定，可供返修和缓存共用')
  let rejected = false
  try { assertDialogueCapacity({ ...plan, lines: plan.lines.map((l) => ({ ...l, text: '字'.repeat(100) })) }) } catch { rejected = true }
  check(rejected, '台词明显超出镜长容量时在生成前拒绝')
}
