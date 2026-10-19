/**
 * sideCards 服务端权威计算：把「上下文智能显示」的裁决权收归后端，可探针断言。
 * 前端只做组件注册表渲染，不再靠一堆 v-if 拼显隐。
 * 卡片清单与顺序由「会话控制态 + 是否 route 决策 + run 真实状态」派生：
 *   规划中 → planning；待确认 → route 走 decisionCard / easy 走 planCard（预检未过 confirmable=false）；
 *   制作中 → (chain 有 workflow → chainProgress) + (审阅闸 → review) + progress + (有成果 → artifacts)；
 *   完成 → result + artifacts；失败/取消 → recovery + progress + artifacts；空闲/需求含糊 → guide。
 *   纯图片反推交付（draft·无方案·无 run·最新一轮含反推产物）→ reverseAnalysis 成果卡（取代 guide，把交付物抬到右侧权威区）。
 * props 只带渲染分支所需的最小标记，完整数据（plan/decision/progress/artifacts/result）仍在 detail 顶层，不重复下发。
 */
import type { AgentMode } from './agent/decision-schema'

export interface SideCard {
  key: string
  props: Record<string, unknown>
}

export interface SideCardsInput {
  /** 会话控制态（creation_sessions.status）：draft/planning/ready/starting/started */
  status: string
  /** 是否 agent 会话（agent_mode=1）；legacy/easy 会话为 false */
  agentMode: boolean
  /** route 决策模式（template/chain/synth）；easy 或无 decision 时为 null */
  decisionMode: AgentMode | null
  /** 是否已有 easy 批准方案 */
  hasPlan: boolean
  /** ready 态是否真的可确认（status=ready 且预检 ready） */
  confirmable: boolean
  /** chain 工作流 id（有则制作中出 chainProgress） */
  workflowId: number | null
  /** chain 段间待续跑批准（有已落定段 + 仍有后续段未起 + 链 active）：出 chainAwaiting 批准卡 */
  chainAwaiting: boolean
  /** run 是否已存在（session.runId 非空） */
  hasRun: boolean
  /** run 真实状态（投影 progress.status：queued/running/paused/waiting_input/completed/failed/cancelled）；无 run 为 null */
  runStatus: string | null
  /** 是否处于中途审阅闸（投影 progress.review 非空） */
  hasReview: boolean
  /** 是否已产出成片（投影 result 非空） */
  hasResult: boolean
  /** 是否有可查看产物（documents/shots 非空） */
  hasArtifacts: boolean
  /** 最新一轮 assistant 消息是否携图片反推产物（纯反推交付；仅在 draft·无方案·无 run 时抬为右侧成果卡） */
  hasReverseDeliverable: boolean
}

/**
 * 计算卡片流。纯函数、无 IO，输入全部来自 creationDetail 已就绪的会话/投影态。
 * 返回顺序 = 前端渲染顺序（自上而下）。
 */
export function computeSideCards(i: SideCardsInput): SideCard[] {
  // 规划在途：只出进度卡，避免与后续态混叠
  if (i.status === 'planning') return [{ key: 'planning', props: {} }]

  // 尚未起 run：按待确认 / 引导分派
  if (!i.hasRun) {
    if (i.status === 'ready') {
      if (i.decisionMode && i.decisionMode !== 'easy') return [{ key: 'decisionCard', props: { mode: i.decisionMode, confirmable: i.confirmable } }]
      if (i.hasPlan) return [{ key: 'planCard', props: { confirmable: i.confirmable } }]
      return [{ key: 'guide', props: {} }]
    }
    // draft / starting 前瞬态 / 需求含糊（clarify 后回到 draft）：
    // 若本轮是纯图片反推交付（无方案无 run但携反推产物）→ 右侧出成果卡；否则引导卡。
    if (i.hasReverseDeliverable) return [{ key: 'reverseAnalysis', props: {} }]
    return [{ key: 'guide', props: {} }]
  }

  // 已有 run：制作中 / 审阅 / 完成，按 run 真实状态派生（控制态 started 不回写，run 态才是真相）。
  // 失败/取消的 issue 与恢复操作由 progress 卡（CreationProgress）自带，不单列 recovery 卡避免重复。
  const cards: SideCard[] = []
  if (i.hasReview) cards.push({ key: 'review', props: {} })
  if (i.workflowId) cards.push({ key: 'chainProgress', props: { workflowId: i.workflowId } })
  // 段间批准卡：落在 chainProgress 之后，明示「本段已完成·待你批准继续下一段」（对话内批准闭环）
  if (i.chainAwaiting) cards.push({ key: 'chainAwaiting', props: { workflowId: i.workflowId } })
  if (i.hasResult) cards.push({ key: 'result', props: {} })
  cards.push({ key: 'progress', props: { status: i.runStatus } })
  if (i.hasArtifacts) cards.push({ key: 'artifacts', props: {} })
  return cards
}
