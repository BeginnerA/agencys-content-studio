/**
 * M70 Task 12：轻松创作 / 专业入口共享的「连续性入口状态」薄封装（brief 12.3）。
 * 拥有 target / approval 状态并内部复用 Task 11 的 useContinuityApproval（epoch、冻结幂等键、忙态所有权）。
 * 对外只暴露：设置目标、预览/冻结状态、失效、以及「属于当前目标」的只读批准值。
 * 关键纪律：批准值只有在冻结时的目标签名 === 当前目标签名时才可读——目标一变立即回到 null，
 * 各入口 adapter 因此拿不到旧包（brief 12.1「目标变化后不带旧包」）。
 */
import { computed, ref, watch, type Ref } from 'vue'
import { continuityApi } from '../../lib/api/continuity'
import {
  useContinuityApproval,
  type ContinuityApprovalApi,
} from '../../composables/use-continuity-approval'
import type { Approval, TargetRequest } from '../../lib/types/continuity'
import type { CreationDetail } from '../../lib/types/creation-chat'

const signatureOf = (t: TargetRequest | null): string =>
  t ? JSON.stringify(t) : ''

export interface CreationContinuity {
  target: Ref<TargetRequest | null>
  state: ContinuityApprovalApi
  /** 仅当批准冻结于当前目标时为非 null（旧目标包不可见） */
  approval: Ref<Approval | null>
  /** 当前目标是否已冻结出可复用批准 */
  frozen: Ref<boolean>
  setTarget: (t: TargetRequest | null) => void
  /** 关闭/取消入口：清目标 + 作废在途 preview/freeze 响应 */
  clear: () => void
  /** 输入/参数/集号变化：作废批准与在途响应（目标保留，重新预览） */
  invalidate: () => void
}

export function useCreationContinuity(
  projectId: Ref<number>,
  api: Pick<typeof continuityApi, 'preview' | 'freeze'> = continuityApi,
): CreationContinuity {
  const target = ref<TargetRequest | null>(null)
  const state = useContinuityApproval(target, projectId, api)
  const frozenSignature = ref('')

  // 冻结成功即记录「冻结时的目标签名」；sync flush 保证同一 tick 内提交入口也能读到批准。
  watch(
    state.approval,
    (value) => {
      frozenSignature.value = value ? signatureOf(target.value) : ''
    },
    { flush: 'sync' },
  )

  const approval = computed<Approval | null>(() => {
    const value = state.approval.value
    if (!value) return null
    return frozenSignature.value === signatureOf(target.value) ? value : null
  })
  const frozen = computed(() => approval.value !== null)

  function setTarget(t: TargetRequest | null): void {
    // 同步作废：不依赖 watch 的 flush 时机，旧包在下一语句即不可见。
    frozenSignature.value = ''
    state.invalidate()
    target.value = t
  }

  function clear(): void {
    setTarget(null)
  }

  function invalidate(): void {
    frozenSignature.value = ''
    state.invalidate()
  }

  return { target, state, approval, frozen, setTarget, clear, invalidate }
}

export interface RouteContinuity {
  cx: CreationContinuity
  /** 打开 route 承接预览：目标 = 会话当前决策（revision/hash），执行体由服务端重导 */
  open: () => void
}

/** route 决策入口包装：决策修订/哈希变化 = 新目标，旧批准立即作废。 */
export function useRouteContinuity(
  detail: Ref<CreationDetail | null>,
  api: Pick<typeof continuityApi, 'preview' | 'freeze'> = continuityApi,
): RouteContinuity {
  const cx = useCreationContinuity(
    computed(() => detail.value?.session.projectId ?? 0),
    api,
  )
  watch(
    () => [
      detail.value?.session.decisionHash,
      detail.value?.session.planRevision,
    ],
    () => cx.invalidate(),
  )
  function open(): void {
    const s = detail.value?.session
    if (!s?.decisionHash) return
    cx.setTarget({
      kind: 'route',
      sessionId: s.id,
      decisionRevision: s.planRevision,
      decisionHash: s.decisionHash,
    })
    void cx.state.load()
  }
  return { cx, open }
}
