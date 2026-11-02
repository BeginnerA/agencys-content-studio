// M70 共用承接预览/冻结状态（brief 11.4）：preview 默认不含 plans；target/输入/参数/includePlans
// 任一变化使 epoch 递增并清 approval；异步响应只有当前 ticket 可落地；卸载/切项目不写旧结果。
// 冻结幂等：operationKey 只在目标签名变化时换新；重复冻结按钮可禁但后端仍幂等。
import { computed, ref, watch, type Ref } from 'vue'
import { continuityApi, freezeBody } from '../lib/api/continuity'
import type {
  Acceptance,
  Approval,
  DuplicateCostAcceptance,
  Preview,
  TargetRequest,
} from '../lib/types/continuity'

export interface ContinuityApprovalApi {
  preview: Ref<Preview | null>
  approval: Ref<Approval | null>
  includePlans: Ref<boolean>
  busy: Ref<boolean>
  error: Ref<string>
  canFreeze: Ref<boolean>
  load: () => Promise<void>
  freeze: (
    accepted: Acceptance[],
    duplicateCostAcceptance?: DuplicateCostAcceptance,
  ) => Promise<Approval | null>
  invalidate: () => void
}

const signatureOf = (t: TargetRequest | null): string =>
  t ? JSON.stringify(t) : ''

export function useContinuityApproval(
  target: Ref<TargetRequest | null>,
  projectId: Ref<number>,
  api: Pick<typeof continuityApi, 'preview' | 'freeze'> = continuityApi,
): ContinuityApprovalApi {
  const preview = ref<Preview | null>(null)
  const approval = ref<Approval | null>(null)
  const includePlans = ref(false)
  const busy = ref(false)
  const error = ref('')

  let epoch = 0
  // 忙态所有权：busy 只由「最新一次真实请求」释放；旧 ticket 的迟到响应不得替新请求解锁。
  let activeTicket = 0
  // 冻结幂等键：同一目标签名复用同 key（重复冻结=幂等回放），签名变化才换新 key。
  let freezeKey: string | null = null
  let lastSignature = ''

  function invalidate(): void {
    epoch += 1
    preview.value = null
    approval.value = null
  }

  async function load(): Promise<void> {
    if (!target.value || !Number.isSafeInteger(projectId.value)) return
    const ticket = ++epoch
    activeTicket = ticket
    busy.value = true
    error.value = ''
    try {
      const result = await api.preview(projectId.value, {
        target: target.value,
        includePlans: includePlans.value,
      })
      if (ticket !== epoch) return
      preview.value = result.preview
    } catch (e) {
      if (ticket !== epoch) return
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (activeTicket === ticket) busy.value = false
    }
  }

  async function freeze(
    accepted: Acceptance[],
    duplicateCostAcceptance?: DuplicateCostAcceptance,
  ): Promise<Approval | null> {
    const current = target.value
    if (!current || !preview.value || busy.value) return null
    const ticket = ++epoch
    activeTicket = ticket
    busy.value = true
    error.value = ''
    const signature = signatureOf(current)
    if (freezeKey === null || signature !== lastSignature) {
      freezeKey = `fz_${crypto.randomUUID()}`
      lastSignature = signature
    }
    try {
      const result = await api.freeze(
        projectId.value,
        freezeBody({
          target: current,
          includePlans: includePlans.value,
          previewHash: preview.value.doc.previewHash,
          acceptedGaps: accepted,
          operationKey: freezeKey,
          ...(duplicateCostAcceptance ? { duplicateCostAcceptance } : {}),
        }),
      )
      if (ticket !== epoch) return null
      approval.value = result.approval
      return result.approval
    } catch (e) {
      if (ticket !== epoch) return null
      // 冻结失败（409 冲突/预算/网络）不得留下旧批准：调用方拿到 null 才会重新走 preview→freeze。
      approval.value = null
      error.value = e instanceof Error ? e.message : String(e)
      return null
    } finally {
      if (activeTicket === ticket) busy.value = false
    }
  }

  // 目标变化（含深度字段）或 includePlans 变化：旧响应作废、批准清空（brief 11.4 epoch 协议）。
  watch(
    target,
    () => {
      invalidate()
      freezeKey = null
      lastSignature = ''
    },
    { deep: true },
  )
  watch(includePlans, () => {
    invalidate()
  })

  const canFreeze = computed(
    () => preview.value?.canFreeze === true && !busy.value,
  )

  return {
    preview,
    approval,
    includePlans,
    busy,
    error,
    canFreeze,
    load,
    freeze,
    invalidate,
  }
}

export type { ContinuityApprovalApi as ContinuityApprovalState }
