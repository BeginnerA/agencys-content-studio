/**
 * 轻松创作（智能创作）规划阶段式进度 composable（自 ConversationPanel.vue 原样搬出，行为零变更）：
 * 行业 AI 对话标准——长等待要让用户看到「到哪一步了」。服务端规划是同步一次性模型调用（推理模型整段
 * 思考期无可见输出，token 级流式对结构化 JSON 方案无意义），故经 session.planning 透出阶段 + 秒数；
 * POST 返回前的窗口服务端尚未登记，本地秒表补位，气泡从第 0 秒起连续计时。
 */
import { computed, onScopeDispose, ref, watch } from 'vue'

const PHASE_LABELS: Record<
  'analyzing' | 'refs' | 'caps' | 'model' | 'validating',
  string
> = {
  analyzing: '理解需求中',
  refs: '核验并理解参考素材中（多模态解析，可能较慢）',
  caps: '探测模型能力与预检条件中',
  model: '调用模型生成方案中（推理模型整段思考后才返回，请耐心等待）',
  validating: '方案校验与制作预检中',
}

export function usePlanningPhase(
  planning: () => boolean,
  sessionPlanning: () => { phase: keyof typeof PHASE_LABELS; elapsedSec: number } | null | undefined,
) {
  const localPlanSec = ref(0)
  let planTimer: ReturnType<typeof setInterval> | null = null
  watch(planning, (active) => {
    if (active && !planTimer) {
      localPlanSec.value = 0
      planTimer = setInterval(() => {
        localPlanSec.value++
      }, 1000)
    } else if (!active && planTimer) {
      clearInterval(planTimer)
      planTimer = null
    }
  })
  onScopeDispose(() => {
    if (planTimer) clearInterval(planTimer)
  })
  const planningPhaseLabel = computed(() => {
    const p = sessionPlanning()
    return p ? PHASE_LABELS[p.phase] : '接收请求中'
  })
  const planningElapsed = computed(() => {
    const p = sessionPlanning()
    return Math.max(p?.elapsedSec ?? 0, localPlanSec.value)
  })
  return { planningPhaseLabel, planningElapsed }
}
