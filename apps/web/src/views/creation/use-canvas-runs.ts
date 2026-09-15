/** [M28] 创作画布：CanvasRuns；依赖显式注入，原函数体保持不变。 */
import { computed, ref, watch } from 'vue'
import { runApi } from '../../lib/api'
import type { CanvasState } from './use-canvas-state'
import type { CanvasCommands } from './use-canvas-commands'
import type { CanvasDocument } from './use-canvas-doc'

type Dependencies = Pick<CanvasState, 'nodes' | 'doc' | 'selNode' | 'toast' | 'activeProjectId' | 'canvasId' | 'boardRef'>
  & Pick<CanvasCommands, 'addNodesCommand'>
  & Pick<CanvasDocument, 'loadDoc'>

export function useCanvasRuns(deps: Dependencies) {
  const { nodes, doc, selNode, toast, activeProjectId, canvasId, boardRef, addNodesCommand, loadDoc } = deps

  // ===== [M17] run 节点轮询（存在非终态 run 时 5s；终态自动停） =====
  const RUN_TEXT: Record<string, string> = { queued: '排队', running: '运行中', waiting_input: '待输入', completed: '完成', failed: '失败', cancelled: '已取消' }
  const RUN_TERMINAL = new Set(['completed', 'failed', 'cancelled'])
  let runPollTimer: number | null = null
  let runPollBusy = false

  function syncRunPoll(): void {
    const live = nodes.value.some((n) => n.kind === 'run' && n.run && !RUN_TERMINAL.has(n.run.status))
    if (live && runPollTimer == null) {
      runPollTimer = window.setInterval(() => void pollRuns(), 5000)
    } else if (!live && runPollTimer != null) {
      window.clearInterval(runPollTimer)
      runPollTimer = null
    }
  }

  async function pollRuns(): Promise<void> {
    if (runPollBusy || !doc.value) return
    const live = nodes.value.filter((n) => n.kind === 'run' && n.run && !RUN_TERMINAL.has(n.run.status))
    if (!live.length) {
      syncRunPoll()
      return
    }
    runPollBusy = true
    try {
      const details = await Promise.all(live.map((n) => runApi.detail(n.run!.id)))
      if (!doc.value) return
      const byId = new Map(details.map((d) => [d.run.id, d]))
      doc.value = {
        ...doc.value,
        nodes: doc.value.nodes.map((n) => {
          if (n.kind !== 'run' || !n.run) return n
          const d = byId.get(n.run.id)
          if (!d) return n
          const succeeded = d.steps.filter((s) => s.status === 'succeeded').length
          return {
            ...n,
            run: {
              ...n.run,
              status: d.run.status,
              startedAt: d.run.startedAt,
              completedAt: d.run.completedAt,
              steps: { succeeded, total: d.steps.length },
            },
          }
        }),
      }
    } catch {
      // 轮询失败静默（下轮重试；不打扰创作）
    } finally {
      runPollBusy = false
      syncRunPoll()
    }
  }
  // doc 变更（含轮询自身回写）→ 同步轮询开关
  watch(nodes, syncRunPoll)

  // ===== 联动①：送去运行（产物 → 既有模板运行）=====
  const showRun = ref(false)
  const runAssetIds = computed<number[]>(() => {
    const sel = selNode.value
    if (sel && sel.assetId != null && (sel.kind === 'asset' || sel.status === 'succeeded')) return [sel.assetId]
    const ids: number[] = []
    for (const n of nodes.value) {
      if (n.assetId == null) continue
      if (n.kind !== 'asset' && n.status !== 'succeeded') continue
      if (n.asset && n.asset.kind !== 'image' && n.asset.kind !== 'text') continue
      ids.push(n.assetId)
    }
    return ids
  })
  const runPrefillInput = computed<Record<string, unknown>>(() => ({ setting_docs: runAssetIds.value }))

  function openSendRun(): void {
    if (!runAssetIds.value.length) {
      toast('画布暂无可送素材（需素材节点或已生成的产物）')
      return
    }
    if (activeProjectId.value == null) return
    showRun.value = true
  }
  function onRunStarted(id: number): void {
    showRun.value = false
    const cid = canvasId.value
    if (cid == null) {
      toast(`已启动运行 #${id}`)
      return
    }
    const at = boardRef.value?.centerWorld() ?? { x: 160, y: 120 }
    void (async () => {
      try {
        await addNodesCommand(cid, [{ kind: 'run', runId: id, x: at.x, y: at.y }], '新建运行节点')
        await loadDoc(true)
        toast(`已启动运行 #${id}，已加入运行节点（进度自动刷新）`)
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e))
      }
    })()
  }

  function disposeRunPoll(): void {
    if (runPollTimer != null) window.clearInterval(runPollTimer)
  }

  return {
    RUN_TEXT,
    RUN_TERMINAL,
    syncRunPoll,
    pollRuns,
    showRun,
    runAssetIds,
    runPrefillInput,
    openSendRun,
    onRunStarted,
    disposeRunPoll,
  }
}

export type CanvasRuns = ReturnType<typeof useCanvasRuns>
