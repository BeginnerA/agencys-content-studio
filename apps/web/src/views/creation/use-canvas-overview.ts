/** [M28] 创作画布：CanvasOverview；依赖显式注入，原函数体保持不变。 */
import { computed, nextTick, ref } from 'vue'
import type { CanvasDocNode } from '../../lib/types'
import type { CanvasState } from './use-canvas-state'
import type { CanvasRuns } from './use-canvas-runs'

type Dependencies = Pick<CanvasState, 'nodes' | 'selectedIds' | 'selectedEdgeId' | 'boardRef'>
  & Pick<CanvasRuns, 'RUN_TERMINAL' | 'RUN_TEXT'>

export function useCanvasOverview(deps: Dependencies) {
  const { nodes, RUN_TERMINAL, RUN_TEXT, selectedIds, selectedEdgeId, boardRef } = deps

  // ===== [M17] 全局状态总览（doc 派生，零端点） =====
  const showOverview = ref(false)
  interface OvRow {
    id: number
    title: string
    kind: string
    dot: string
    summary: string
    rank: number
  }
  const KIND_SHORT: Record<string, string> = { asset: '素材', text: '文本', entity: '实体', run: '运行' }

  function genKindShort(n: CanvasDocNode): string {
    const s = n.spec
    const gk = s && typeof s === 'object' && 'genKind' in s ? s.genKind : null
    if (gk === 'video') return '视频'
    if (gk === 'audio') return '音频'
    if (gk === 'compose') return '合成'
    return '图片'
  }

  /** 严重度：失败(0) > 未就绪/损坏(1) > 运行中/排队(2) > 就绪(3) > 完成/空闲(4) */
  const overviewRows = computed<OvRow[]>(() => {
    const rows: OvRow[] = []
    for (const n of nodes.value) {
      let rank = 4
      let dot = 'idle'
      let summary = ''
      const kindText = n.kind === 'gen' ? genKindShort(n) : (KIND_SHORT[n.kind] ?? n.kind)
      if (n.kind === 'gen') {
        if (n.status === 'failed') {
          rank = 0
          dot = 'bad'
          summary = n.latestTask?.errorMsg ?? '生成失败'
        } else if (n.specError) {
          rank = 1
          dot = 'warn'
          summary = n.specError
        } else if (n.status === 'pending' || n.status === 'processing') {
          rank = 2
          dot = 'run'
          summary = n.status === 'pending' ? '排队中' : '生成中'
        } else if (n.readiness && !n.readiness.ready) {
          rank = 1
          dot = 'warn'
          summary = n.readiness.problems[0] ?? '未就绪'
        } else if (n.canRun) {
          rank = 3
          dot = 'ok'
          summary = '已就绪'
        } else if (n.status === 'succeeded') {
          dot = 'ok'
          summary = '已完成'
        } else {
          summary = '空闲'
        }
      } else if (n.kind === 'run') {
        const st = n.run?.status
        if (!st) {
          rank = 1
          dot = 'warn'
          summary = '运行数据缺失'
        } else if (st === 'failed') {
          rank = 0
          dot = 'bad'
          summary = '运行失败'
        } else if (!RUN_TERMINAL.has(st)) {
          rank = 2
          dot = 'run'
          summary = `${RUN_TEXT[st] ?? st} · 步骤 ${n.run?.steps.succeeded ?? 0}/${n.run?.steps.total ?? 0}`
        } else {
          dot = st === 'completed' ? 'ok' : 'idle'
          summary = RUN_TEXT[st] ?? st
        }
      } else if (n.kind === 'text') {
        const t = n.spec && 'text' in n.spec ? n.spec.text : ''
        summary = t ? t.replace(/\s+/g, ' ').slice(0, 26) : '（空文本）'
      } else if (n.kind === 'entity') {
        if (n.entity) summary = `${n.entity.name} · 参考 ${n.entity.refCount}`
        else {
          rank = 1
          dot = 'warn'
          summary = '实体缺失'
        }
      } else if (n.asset) {
        summary = n.asset.name
      } else if (n.assetId == null) {
        summary = '空节点'
      } else {
        rank = 1
        dot = 'warn'
        summary = '资产缺失'
      }
      rows.push({ id: n.id, title: n.title, kind: kindText, dot, summary, rank })
    }
    return rows.sort((a, b) => a.rank - b.rank)
  })

  /** 总览点击 → 选中 + 视口居中（节点卡宽 220；中心偏移 110/70） */
  function focusNode(id: number): void {
    const n = nodes.value.find((x) => x.id === id)
    if (!n) return
    selectedIds.value = [id]
    selectedEdgeId.value = null
    void nextTick(() => boardRef.value?.centerOn(n.x + 110, n.y + 70))
  }

  return {
    showOverview,
    KIND_SHORT,
    genKindShort,
    overviewRows,
    focusNode,
  }
}

export type CanvasOverview = ReturnType<typeof useCanvasOverview>
