import { computed, ref, type ComputedRef } from 'vue'
import type { Run } from '../../lib/types'

/**
 * 续跑链折叠：同一创作的断点续跑派生 run（resumedFromRunId 串链）折叠为最新一条（head），
 * 被取代的历史 run 收进 head 可展开查看。
 *
 * 纯计算 + 展开态，依赖注入独立运行列表；从 use-project-detail.ts 拆出
 * （行为零变更，导出同名解构保持装配面不变）。
 */
export function useResumeChains(standaloneRuns: ComputedRef<Run[]>) {
  /** head=未被任何独立运行引用为续跑来源；history=沿 resumedFromRunId 向旧回溯（不含 head 自身） */
  const resumeChains = computed(() => {
    const pool = standaloneRuns.value // 批内子运行另有批次折叠，不参与续跑归组
    const byId = new Map(pool.map((r) => [r.id, r]))
    const referenced = new Set<number>()
    for (const r of pool)
      if (r.resumedFromRunId != null && byId.has(r.resumedFromRunId))
        referenced.add(r.resumedFromRunId)
    const historyByHead = new Map<number, Run[]>()
    const memberIds = new Set<number>()
    for (const r of pool) {
      if (referenced.has(r.id)) continue // 被取代的旧 run，随 head 展开呈现
      const history: Run[] = []
      const seen = new Set<number>([r.id])
      let cur = r
      while (
        cur.resumedFromRunId != null &&
        byId.has(cur.resumedFromRunId) &&
        !seen.has(cur.resumedFromRunId)
      ) {
        cur = byId.get(cur.resumedFromRunId)!
        seen.add(cur.id)
        history.push(cur)
      }
      if (history.length) {
        historyByHead.set(r.id, history)
        for (const m of history) memberIds.add(m.id)
      }
    }
    return { historyByHead, memberIds }
  })

  const expandedChains = ref<Set<number>>(new Set())

  /** 该 run 是否为续跑链 head（有被折叠的历史） */
  function isChainHead(run: Run): boolean {
    return resumeChains.value.historyByHead.has(run.id)
  }

  /** head 的被折叠历史（旧→新排序展示更自然） */
  function chainHistory(runId: number): Run[] {
    return (resumeChains.value.historyByHead.get(runId) ?? []).slice().reverse()
  }

  function toggleChain(runId: number) {
    const s = expandedChains.value
    if (s.has(runId)) s.delete(runId)
    else s.add(runId)
  }

  return { resumeChains, expandedChains, isChainHead, chainHistory, toggleChain }
}
