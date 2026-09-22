import { computed, reactive, watch } from 'vue'
import { creationChatApi, newRequestKey } from '../../lib/api/creation-chat'
import type {
  CreationDetail,
  CreationReworkApplyBody,
  CreationReworkOp,
  CreationReworkPreview,
  CreationReworkTarget,
} from '../../lib/types/creation-chat'

// ===== [M42] 自然语言局部返修（独立于消息输入框：默认发信「记录下一版建议」的语义不得被劫持成返修费用） =====

interface Host {
  currentId: number
  detail: CreationDetail | null
  error: string
  notice: string
}

/** 服务端 reworkRequestSchema.instruction 同约束（2–2000 字）；越界值由 Zod 拒绝，本地先挡住空转 */
const MIN_INSTRUCTION = 2
const MAX_INSTRUCTION = 2000
/** 只有 run 收敛（完成或失败）才有「已批准的镜头」可返修：制作中不给出会烧钱的入口 */
const SETTLED = new Set(['completed', 'failed'])

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 预览 → 确认载荷：只回传镜头与新提示词，金额 / 版本 / 未计价项全部由服务端按当前方案重算 */
function opsOf(targets: readonly CreationReworkTarget[]): CreationReworkOp[] {
  return targets.map((t) => ({
    shot_id: t.shotId,
    ...(t.imagePrompt !== null ? { image_prompt: t.imagePrompt } : {}),
    ...(t.motionPrompt !== null ? { motion_prompt: t.motionPrompt } : {}),
  }))
}

/**
 * 两步式返修状态机：解析（一次文本模型小额调用，零媒体计费）→ 用户看逐镜「原→新」与预估费用 → 显式确认才重置目标镜。
 * 晚到响应保护沿用 use-first-input 的 epoch 范式；幂等键按 `{signature,key}` 先例（同签名复用，连点不重复计费）。
 */
export function createRework(host: Host, hooks: {
  commit: (id: number, detail: CreationDetail) => void
  polling: () => void
}, api: Pick<typeof creationChatApi, 'reworkPlan' | 'reworkApply'> = creationChatApi) {
  const state = reactive({
    open: false,
    instruction: '',
    busy: false,
    /** 解析成功的预览；确认执行、方案推进或 run 重新开跑后即作废（旧 planHash 去确认必被服务端拒） */
    preview: null as CreationReworkPreview | null,
    acceptUnpriced: false,
    error: '',
    /** 每成功一次返修 +1：成果面板据此丢弃过期的候选缓存（该镜会有新版本） */
    stamp: 0,
  })
  let epoch = 0
  let parseTicket = { signature: '', key: '' }
  let applyTicket = { signature: '', key: '' }
  const live = (token: number, id: number) => token === epoch && host.currentId === id

  const canUse = computed(() => {
    const d = host.detail
    return !!d?.session.runId && !!d.session.planHash && SETTLED.has(d.progress?.status ?? '')
  })
  const targets = computed(() => state.preview?.targets ?? [])
  const unclear = computed(() => state.preview?.unclear ?? '')
  const notes = computed(() => state.preview?.notes ?? [])
  const unpriced = computed(() => state.preview?.estimate.unpriced ?? [])
  const knownCost = computed(() => state.preview?.estimate.knownCost ?? 0)
  /** 确认闸：有可执行目标、run 仍收敛、且未在途 */
  const confirmable = computed(
    () => canUse.value && !!state.preview && !unclear.value && targets.value.length > 0 && !state.busy,
  )
  const tooLong = computed(() => state.instruction.length > MAX_INSTRUCTION)
  /** 已动笔但还不够定位镜头的长度：主按钮禁用时给出成因提示 */
  const tooShort = computed(() => {
    const n = state.instruction.trim().length
    return n > 0 && n < MIN_INSTRUCTION
  })

  // 切会话 / 方案推进（含返修后 revision+1）/ run 重新开跑 → 上一次解析立即作废，不留可点的确认按钮
  watch(
    () => `${host.currentId}|${host.detail?.session.planHash ?? ''}|${host.detail?.session.planRevision ?? 0}|${host.detail?.progress?.status ?? ''}`,
    () => {
      state.preview = null
      state.acceptUnpriced = false
      state.error = ''
    },
  )

  function toggle(): void {
    if (!canUse.value && !state.open) return
    state.open = !state.open
    state.error = ''
  }

  function close(): void {
    state.open = false
    state.preview = null
    state.acceptUnpriced = false
    state.error = ''
  }

  /** 第一步：解析返修指令。同指令 + 同方案版本复用解析键（连点不重复调用模型；换说法或方案推进即新键） */
  async function parse(): Promise<boolean> {
    const id = host.currentId
    const s = host.detail?.session
    if (!id || !s?.planHash || state.busy || !canUse.value) return false
    const instruction = state.instruction.trim()
    if (instruction.length < MIN_INSTRUCTION) {
      state.error = '请写清楚要返修第几镜、改成什么样子，例如「第 2 镜：改成夜晚街景，霓虹反光」。'
      return false
    }
    const token = ++epoch
    state.busy = true
    state.error = ''
    const signature = JSON.stringify([id, s.planHash, s.planRevision, instruction])
    if (signature !== parseTicket.signature) parseTicket = { signature, key: newRequestKey('rwp') }
    try {
      const res = await api.reworkPlan(id, { instruction, requestKey: parseTicket.key })
      if (!live(token, id)) return false
      const { reworkPreview, ...detail } = res
      hooks.commit(id, detail as CreationDetail)
      if (!reworkPreview) {
        state.error = '解析结果未随响应返回，请点击「更新状态」后重试；尚未启动任何生成。'
        return false
      }
      state.preview = reworkPreview
      state.acceptUnpriced = false
      host.notice = reworkPreview.unclear
        ? '这条指令没能在当前成片中定位到镜头；本入口只重做单个镜头的画面 / 动态提示词。'
        : ''
      return !reworkPreview.unclear
    } catch (e) {
      if (live(token, id)) state.error = message(e)
      return false
    } finally {
      if (live(token, id)) state.busy = false
    }
  }

  /** 第二步：确认执行（会重新生成目标镜、可能计费）。失败保留幂等键：同一次确认的网络重试不二次重置 */
  async function apply(): Promise<boolean> {
    const preview = state.preview
    const id = host.currentId
    if (!preview || preview.unclear || !id || state.busy || !confirmable.value) return false
    if (unpriced.value.length && !state.acceptUnpriced) {
      state.error = '存在未知价格的生成项，请先勾选接受未计价项再确认。'
      return false
    }
    const token = ++epoch
    state.busy = true
    state.error = ''
    const ops = opsOf(preview.targets)
    const signature = JSON.stringify([id, preview.planHash, preview.planRevision, ops])
    if (signature !== applyTicket.signature) applyTicket = { signature, key: newRequestKey('rw') }
    try {
      const body: CreationReworkApplyBody = {
        planRevision: preview.planRevision,
        planHash: preview.planHash,
        idempotencyKey: applyTicket.key,
        acceptUnpriced: state.acceptUnpriced,
        ops,
      }
      hooks.commit(id, await api.reworkApply(id, body))
      if (!live(token, id)) return false
      // 方案已推进：旧预览与旧解析键一并作废，下一次返修必须重新解析（服务端 stale_plan 的镜像保护）
      state.preview = null
      state.instruction = ''
      state.acceptUnpriced = false
      state.open = false
      state.stamp += 1
      applyTicket = { signature: '', key: '' }
      parseTicket = { signature: '', key: '' }
      host.notice = '已开始局部返修：只有目标镜头会重新生成，完成后成片会自动重新合成。'
      hooks.polling()
      return true
    } catch (e) {
      if (live(token, id)) state.error = message(e)
      return false
    } finally {
      if (live(token, id)) state.busy = false
    }
  }

  /** 切会话 / 离开详情页：丢弃未完成的解析与预览（不跨会话复用，避免把上一版的确认提交到新会话） */
  function reset(): void {
    epoch++
    state.open = false
    state.instruction = ''
    state.busy = false
    state.preview = null
    state.acceptUnpriced = false
    state.error = ''
    parseTicket = { signature: '', key: '' }
    applyTicket = { signature: '', key: '' }
  }

  return {
    state,
    canUse,
    targets,
    unclear,
    notes,
    unpriced,
    knownCost,
    confirmable,
    tooLong,
    tooShort,
    minInstruction: MIN_INSTRUCTION,
    maxInstruction: MAX_INSTRUCTION,
    toggle,
    close,
    parse,
    apply,
    reset,
  }
}

export type ReworkApi = ReturnType<typeof createRework>
