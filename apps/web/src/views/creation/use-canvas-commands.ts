/** [M28] 创作画布：CanvasCommands；依赖显式注入，原函数体保持不变。 */
import { creationApi, uploadFiles, type AddNodeBody, type CanvasNodePatch } from '../../lib/api'
import type { CanvasDocNode, CanvasViewport, CreationNodeSpec, EntityNodeSpec, RunNodeSpec, TextNodeSpec } from '../../lib/types'
import type { CanvasState } from './use-canvas-state'
import type { CanvasDocument } from './use-canvas-doc'
import type { CanvasTarget } from './use-canvas-target'

type Dependencies = Pick<CanvasState, 'doc' | 'canvasId' | 'nodes' | 'history' | 'toast' | 'selectedIds' | 'selectedEdgeId' | 'projectId' | 'edges'>
  & Pick<CanvasDocument, 'loadDoc'>
  & Pick<CanvasTarget, 'loadPalette'>

export function useCanvasCommands(deps: Dependencies) {
  const { doc, canvasId, nodes, history, toast, loadDoc, selectedIds, selectedEdgeId, projectId, loadPalette, edges } = deps

  // ===== 写操作辅助（乐观更新 / 命令栈）=====
  /** 批量移动乐观更新（本地先落点；失败由调用方重拉对账） */
  function optimisticMove(moves: Array<{ id: number; x: number; y: number }>): void {
    if (!doc.value) return
    const by = new Map(moves.map((m) => [m.id, m]))
    doc.value = {
      ...doc.value,
      nodes: doc.value.nodes.map((n) => {
        const m = by.get(n.id)
        return m ? { ...n, x: m.x, y: m.y } : n
      }),
    }
  }

  /** 批量移动提交（拖动组 / 方向键微移）→ nodes/batch + 入撤销栈一条 */
  async function commitMoves(moves: Array<{ id: number; x: number; y: number }>, label: string): Promise<void> {
    const cid = canvasId.value
    if (cid == null || !moves.length) return
    const before = moves.map((m) => {
      const n = nodes.value.find((x) => x.id === m.id)
      return { id: m.id, x: n?.x ?? m.x, y: n?.y ?? m.y }
    })
    optimisticMove(moves)
    try {
      await creationApi.batchNodes(cid, moves.map((m) => ({ id: m.id, x: m.x, y: m.y })))
      history.push({
        label,
        undo: async () => {
          optimisticMove(before)
          await creationApi.batchNodes(cid, before)
        },
        redo: async () => {
          optimisticMove(moves)
          await creationApi.batchNodes(cid, moves)
        },
      })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
      void loadDoc(true)
    }
  }
  function onMoved(moves: Array<{ id: number; x: number; y: number }>): void {
    void commitMoves(moves, moves.length > 1 ? `移动 ${moves.length} 个节点` : '移动节点')
  }
  function onNudge(moves: Array<{ id: number; x: number; y: number }>): void {
    void commitMoves(moves, '微移节点')
  }

  /** 新建节点批 → 入撤销栈（undo 批量删除 / redo 重建；id 为可变引用） */
  async function addNodesCommand(cid: number, bodies: AddNodeBody[], label: string): Promise<number[]> {
    const created = await Promise.all(bodies.map((b) => creationApi.addNode(cid, b)))
    let ids = created.map((r) => r.node.id)
    history.push({
      label,
      undo: async () => {
        await Promise.all(ids.map((id) => creationApi.removeNode(id)))
        const del = new Set(ids)
        selectedIds.value = selectedIds.value.filter((x) => !del.has(x))
        await loadDoc(true)
      },
      redo: async () => {
        const again = await Promise.all(bodies.map((b) => creationApi.addNode(cid, b)))
        ids = again.map((r) => r.node.id)
        selectedIds.value = ids
        await loadDoc(true)
      },
    })
    return ids
  }

  /** 快照重建 create body（删除撤销用；损坏 spec → 抛错清栈） */
  function nodeCreateBody(n: CanvasDocNode): AddNodeBody {
    const pos = { x: n.x, y: n.y }
    const spec = n.spec
    if (n.kind === 'gen') {
      if (!spec) throw new Error(`节点 #${n.id} spec 缺失，无法重建`)
      return { kind: 'gen', spec: spec as CreationNodeSpec, ...pos }
    }
    if (n.kind === 'text') {
      if (!spec || !('text' in spec)) throw new Error(`节点 #${n.id} spec 缺失，无法重建`)
      return { kind: 'text', spec: { text: (spec as TextNodeSpec).text }, ...pos }
    }
    if (n.kind === 'entity') {
      if (!spec || !('entityId' in spec)) throw new Error(`节点 #${n.id} spec 缺失，无法重建`)
      return { kind: 'entity', entityId: (spec as EntityNodeSpec).entityId, ...pos }
    }
    if (n.kind === 'run') {
      if (!spec || !('runId' in spec)) throw new Error(`节点 #${n.id} spec 缺失，无法重建`)
      return { kind: 'run', runId: (spec as RunNodeSpec).runId, ...pos }
    }
    return { kind: 'asset', assetId: n.assetId ?? 0, ...pos }
  }

  // ===== 画布交互 → 写操作 =====
  async function onConnect(p: { from: number; to: number; port: string }): Promise<void> {
    const cid = canvasId.value
    if (cid == null) return
    try {
      const r = await creationApi.addEdge(cid, p)
      let edgeId = r.edge.id
      toast('已连线')
      history.push({
        label: '连线',
        undo: async () => {
          await creationApi.removeEdge(edgeId)
          await loadDoc(true)
        },
        redo: async () => {
          const rr = await creationApi.addEdge(cid, p)
          edgeId = rr.edge.id
          await loadDoc(true)
        },
      })
      void loadDoc(true)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  async function onCreateNode(p: { x: number; y: number }): Promise<void> {
    const cid = canvasId.value
    if (cid == null) return
    try {
      const body: AddNodeBody = { kind: 'gen', spec: { genKind: 'image', prompt: '' }, x: p.x, y: p.y }
      const ids = await addNodesCommand(cid, [body], '新建节点')
      await loadDoc(true)
      selectedIds.value = ids
      selectedEdgeId.value = null
      toast('已新建生成节点，请在右侧编辑参数')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  async function onDropFiles(p: { files: File[]; x: number; y: number }): Promise<void> {
    const pid = projectId.value
    const cid = canvasId.value
    if (pid == null || cid == null) return
    try {
      const assets = await uploadFiles(pid, 'reference', p.files)
      const bodies: AddNodeBody[] = []
      for (let i = 0; i < assets.length; i++) {
        const a = assets[i]
        if (!a) continue
        bodies.push({ kind: 'asset', assetId: a.id, x: p.x + (i % 3) * 36, y: p.y + (i % 3) * 36 })
      }
      await addNodesCommand(cid, bodies, `新建 ${bodies.length} 个素材节点`)
      toast(`已上传 ${assets.length} 个文件并建为素材节点`)
      void loadDoc(true)
      void loadPalette()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  async function onDropAsset(p: { assetId: number; x: number; y: number }): Promise<void> {
    const cid = canvasId.value
    if (cid == null) return
    try {
      await addNodesCommand(cid, [{ kind: 'asset', assetId: p.assetId, x: p.x, y: p.y }], '新建素材节点')
      toast('已加入素材节点')
      void loadDoc(true)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  /** [M17] 删除选中（快照重建逆操作；undo: POST nodes 重映射 + gen 任务认领 + POST edges + PATCH extras）
   *  rethrow=true（Inspector 调用）：错误上抛、成功静默（由 Inspector 显示）；false：本地 toast */
  async function onDeleteSelected(rethrow = false): Promise<void> {
    const cid = canvasId.value
    const ids = [...selectedIds.value]
    if (cid == null || !ids.length) return
    const idSet = new Set(ids)
    const snap: Array<{
      oldId: number
      /** [M17] 当前代实际节点 id（任务历史认领源；redo/undo 循环中随重建更新） */
      curId: number
      body: AddNodeBody
      title: string | null
      seq: number | null
      adoptedTaskId: number | null
    }> = []
    try {
      for (const id of ids) {
        const n = nodes.value.find((x) => x.id === id)
        if (!n) continue
        snap.push({ oldId: id, curId: id, body: nodeCreateBody(n), title: n.title, seq: n.seq ?? null, adoptedTaskId: n.adoptedTaskId ?? null })
      }
    } catch (e) {
      if (rethrow) throw e
      toast(e instanceof Error ? e.message : String(e))
      return
    }
    // 关联边快照（含悬挂到保留节点的边；内部边 from/to 均在删除集内）
    const relEdges: Array<{ from: number; to: number; port: string }> = []
    for (const e of edges.value) {
      if (idSet.has(e.from) || idSet.has(e.to)) relEdges.push({ from: e.from, to: e.to, port: e.port })
    }
    let curIds = ids
    try {
      await creationApi.deleteNodes(cid, ids)
      selectedIds.value = []
      selectedEdgeId.value = null
      await loadDoc(true)
    } catch (e) {
      if (rethrow) throw e
      toast(e instanceof Error ? e.message : String(e))
      return
    }
    if (!rethrow) toast(`已删除 ${snap.length} 个节点`)
    history.push({
      label: `删除 ${snap.length} 个节点`,
      undo: async () => {
        // 重建（id 重映射 → 边重建 → extras 恢复；任一步失败 → 上抛清栈）
        const idMap = new Map<number, number>()
        const newIds: number[] = []
        for (const s of snap) {
          // [M17] gen 节点重建附带认领任务历史（源=curId：任务实际所在的一代 id；否则 adoptedTaskId 恢复必失败）
          const r = await creationApi.addNode(
            cid,
            s.body.kind === 'gen' ? { ...s.body, restoreFromNodeId: s.curId } : s.body,
          )
          s.curId = r.node.id
          idMap.set(s.oldId, r.node.id)
          newIds.push(r.node.id)
          const patch: CanvasNodePatch = {}
          if (s.title != null) patch.title = s.title
          if (s.seq != null) patch.seq = s.seq
          if (s.adoptedTaskId != null) patch.adoptedTaskId = s.adoptedTaskId
          if (Object.keys(patch).length) await creationApi.updateNode(r.node.id, patch)
        }
        for (const e of relEdges) {
          await creationApi.addEdge(cid, {
            from: idMap.get(e.from) ?? e.from,
            to: idMap.get(e.to) ?? e.to,
            port: e.port,
          })
        }
        curIds = newIds
        selectedIds.value = newIds
        await loadDoc(true)
      },
      redo: async () => {
        await creationApi.deleteNodes(cid, curIds)
        selectedIds.value = []
        await loadDoc(true)
      },
    })
  }

  /** [M17] 复制选中（Ctrl+D：偏移 +40,+40；内部边重映射） */
  async function onCopySelected(): Promise<void> {
    const cid = canvasId.value
    const ids = [...selectedIds.value]
    if (cid == null || !ids.length) return
    let newIds: number[] = []
    const doCopy = async (): Promise<void> => {
      const r = await creationApi.copyNodes(cid, ids)
      newIds = r.nodes.map((n) => n.id)
      selectedIds.value = newIds
      selectedEdgeId.value = null
      await loadDoc(true)
    }
    try {
      await doCopy()
      toast(`已复制 ${newIds.length} 个节点`)
      history.push({
        label: `复制 ${newIds.length} 个节点`,
        undo: async () => {
          await creationApi.deleteNodes(cid, newIds)
          const del = new Set(newIds)
          selectedIds.value = selectedIds.value.filter((x) => !del.has(x))
          await loadDoc(true)
        },
        redo: async () => {
          await doCopy()
        },
      })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  /** [M17] 撤销 / 重做（失败 → toast + 清栈提示；对账重拉） */
  async function onUndo(): Promise<void> {
    const label = history.undoLabel.value
    try {
      await history.undo()
      if (label) toast(`已撤销：${label}`)
    } catch (e) {
      toast(`撤销失败：${e instanceof Error ? e.message : String(e)}（撤销栈已清空）`)
      void loadDoc(true)
    }
  }
  async function onRedo(): Promise<void> {
    const label = history.redoLabel.value
    try {
      await history.redo()
      if (label) toast(`已重做：${label}`)
    } catch (e) {
      toast(`重做失败：${e instanceof Error ? e.message : String(e)}（撤销栈已清空）`)
      void loadDoc(true)
    }
  }

  // ===== [M17] Inspector 写命令接线（props 回调；写操作入撤销栈，await 返回即已落库） =====
  /** 取单节点 patch 覆盖字段的当前值（表单变化判定 + 撤销逆操作源） */
  function patchCurrent(n: CanvasDocNode, patch: CanvasNodePatch): CanvasNodePatch {
    const cur: CanvasNodePatch = {}
    if ('x' in patch) cur.x = n.x
    if ('y' in patch) cur.y = n.y
    if ('title' in patch) cur.title = n.title
    if ('spec' in patch && n.spec) cur.spec = n.spec
    if ('seq' in patch) cur.seq = n.seq
    if ('adoptedTaskId' in patch) cur.adoptedTaskId = n.adoptedTaskId
    return cur
  }

  /** PATCH 单节点（改名/spec/文本/采纳）→ nodes/batch + 入撤销栈（逆操作 = 覆盖字段旧值回写） */
  async function applyNodePatch(p: { id: number; patch: CanvasNodePatch; label: string }): Promise<void> {
    const cid = canvasId.value
    if (cid == null) return
    const n = nodes.value.find((x) => x.id === p.id)
    const before = n ? patchCurrent(n, p.patch) : {}
    await creationApi.batchNodes(cid, [{ id: p.id, ...p.patch }])
    history.push({
      label: p.label,
      undo: async () => {
        await creationApi.batchNodes(cid, [{ id: p.id, ...before }])
        await loadDoc(true)
      },
      redo: async () => {
        await creationApi.batchNodes(cid, [{ id: p.id, ...p.patch }])
        await loadDoc(true)
      },
    })
    await loadDoc(true)
  }

  /** 执行节点（表单有变化先落库并入栈；执行本身不入栈） */
  async function applyNodeRun(p: { id: number; variants: number; savePatch?: CanvasNodePatch }): Promise<void> {
    const cid = canvasId.value
    if (cid == null) return
    const n = nodes.value.find((x) => x.id === p.id)
    if (p.savePatch && n) {
      const cur = patchCurrent(n, p.savePatch)
      if (JSON.stringify(cur) !== JSON.stringify(p.savePatch)) {
        await applyNodePatch({ id: p.id, patch: p.savePatch, label: '保存参数' })
      }
    }
    await creationApi.run(p.id, p.variants > 1 ? p.variants : undefined)
    await loadDoc(true)
  }

  /** 提取文本节点（undo 删除新节点 / redo 重提；id 可变引用）→ 选中新节点 */
  async function applyNodeExtract(id: number): Promise<void> {
    const cid = canvasId.value
    if (cid == null) return
    const r = await creationApi.extractText(id)
    let newId = r.node.id
    history.push({
      label: '提取文本节点',
      undo: async () => {
        await creationApi.removeNode(newId)
        selectedIds.value = selectedIds.value.filter((x) => x !== newId)
        await loadDoc(true)
      },
      redo: async () => {
        const rr = await creationApi.extractText(id)
        newId = rr.node.id
        await loadDoc(true)
        selectedIds.value = [newId]
        selectedEdgeId.value = null
      },
    })
    await loadDoc(true)
    selectedIds.value = [newId]
    selectedEdgeId.value = null
  }

  /** 断开连线（undo 重连 / redo 再断；edgeId 可变引用） */
  async function applyRemoveEdge(id: number): Promise<void> {
    const cid = canvasId.value
    if (cid == null) return
    const e = edges.value.find((x) => x.id === id)
    await creationApi.removeEdge(id)
    if (selectedEdgeId.value === id) selectedEdgeId.value = null
    if (e) {
      let curId = id
      history.push({
        label: '断开连线',
        undo: async () => {
          const r = await creationApi.addEdge(cid, { from: e.from, to: e.to, port: e.port })
          curId = r.edge.id
          await loadDoc(true)
        },
        redo: async () => {
          await creationApi.removeEdge(curId)
          await loadDoc(true)
        },
      })
    }
    await loadDoc(true)
  }

  /** Inspector 删除入口（错误上抛由 Inspector 显示；成功提示由 Inspector notice 承担） */
  async function applyDeleteFromInspector(): Promise<void> {
    await onDeleteSelected(true)
  }

  async function onViewportSettled(v: CanvasViewport): Promise<void> {
    const cid = canvasId.value
    if (cid == null) return
    try {
      await creationApi.update(cid, { viewport: v })
    } catch {
      // 视口持久化失败静默（不影响创作）
    }
  }

  return {
    optimisticMove,
    commitMoves,
    onMoved,
    onNudge,
    addNodesCommand,
    nodeCreateBody,
    onConnect,
    onCreateNode,
    onDropFiles,
    onDropAsset,
    onDeleteSelected,
    onCopySelected,
    onUndo,
    onRedo,
    patchCurrent,
    applyNodePatch,
    applyNodeRun,
    applyNodeExtract,
    applyRemoveEdge,
    applyDeleteFromInspector,
    onViewportSettled,
  }
}

export type CanvasCommands = ReturnType<typeof useCanvasCommands>
