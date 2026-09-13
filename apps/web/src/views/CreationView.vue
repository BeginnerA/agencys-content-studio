<script setup lang="ts">
/**
 * [M16] 创作画布页（spec §2.4；URL ?project=&canvas= 为单一真源）
 * - 布局：左侧素材面板（拖入 / 单击送至视口中心）+ 中部 CreationBoard + 右侧 CreationInspector（选中时覆盖）
 * - 数据：creationApi.doc 全量读模型；socket join canvas:{id} room，canvas.changed → 350ms 防抖静默重拉
 * - 操作：拖拽落点乐观更新 + PATCH；其余走 creationApi → 重拉（400 文案 toast）
 * - 联动：送去运行（RunFormModal prefillInput setting_docs）/ 导出模板草案（Modal + 复制）/ 画布管理（新建·复制·删除）
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CreationBoard from '../components/CreationBoard.vue'
import CreationInspector from '../components/CreationInspector.vue'
import Icon from '../components/Icon.vue'
import Modal from '../components/Modal.vue'
import RunFormModal from '../components/RunFormModal.vue'
import { creationApi, entityApi, exportApi, projectApi, runApi, uploadFiles, type AddNodeBody, type CanvasNodePatch } from '../lib/api'
import { createCanvasHistory } from '../lib/canvas-history'
import { confirmDialog } from '../lib/confirm'
import { getSocket, studioOff, studioOn } from '../lib/socket'
import type { StudioEventMap } from '../lib/socket'
import type {
  Asset, CanvasArrangeMode, CanvasDoc, CanvasDocEdge, CanvasDocNode, CanvasExportResult, CanvasListItem,
  CanvasViewport, CreationNodeSpec, EntityItem, EntityNodeSpec, Project, RunNodeSpec, TemplateValidation, TextNodeSpec,
} from '../lib/types'

const route = useRoute()
const router = useRouter()

// ===== 目标（route.query 单一真源）=====
const projectId = ref<number | null>(null)
const canvasId = ref<number | null>(null)

const doc = ref<CanvasDoc | null>(null)
const loading = ref(false)
const err = ref('')

const selectedIds = ref<number[]>([])
const selectedEdgeId = ref<number | null>(null)
/** [M17] 撤销/重做命令栈（移动/新建/删除/连线/复制入栈；选中/视口不入栈） */
const history = createCanvasHistory()
const boardRef = ref<InstanceType<typeof CreationBoard> | null>(null)
/** [M17] 命令栈按钮状态（嵌套 ref → computed 供模板解包） */
const canUndo = computed(() => history.canUndo.value)
const canRedo = computed(() => history.canRedo.value)
const undoTitle = computed(() => (history.undoLabel.value ? `撤销：${history.undoLabel.value}（Ctrl+Z）` : '撤销（Ctrl+Z）'))
const redoTitle = computed(() => (history.redoLabel.value ? `重做：${history.redoLabel.value}（Ctrl+Shift+Z）` : '重做（Ctrl+Shift+Z）'))

const nodes = computed<CanvasDocNode[]>(() => doc.value?.nodes ?? [])
const edges = computed<CanvasDocEdge[]>(() => doc.value?.edges ?? [])
/** 单选详情（多选 → null；P5 批量浮动条浮出） */
const selNode = computed<CanvasDocNode | null>(() => {
  const ids = selectedIds.value
  if (ids.length !== 1) return null
  return nodes.value.find((n) => n.id === ids[0]) ?? null
})
const selEdge = computed<CanvasDocEdge | null>(() =>
  selectedEdgeId.value == null ? null : (edges.value.find((e) => e.id === selectedEdgeId.value) ?? null),
)
const activeProjectId = computed(() => doc.value?.canvas.projectId ?? projectId.value ?? 0)

// ===== toast =====
const toastMsg = ref('')
let toastTimer: number | null = null
function toast(msg: string): void {
  toastMsg.value = msg
  if (toastTimer != null) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toastMsg.value = ''
    toastTimer = null
  }, 3600)
}

// ===== 目录（项目 / 画布 / 素材面板）=====
const projects = ref<Project[]>([])
const canvases = ref<CanvasListItem[]>([])
const listErr = ref('')
const palette = ref<Asset[]>([])
const paletteLoading = ref(false)
const paletteErr = ref('')
/** [M17] 素材面板 Tab（图片/视频/音频/实体；前三个沿用资产列表查询，实体走 /entities 合并三 kind） */
const palKind = ref<'image' | 'video' | 'audio' | 'entity'>('image')
/** [M17] 实体 Tab 数据（character+scene+prop 合并） */
const palEntities = ref<EntityItem[]>([])
const fileInput = ref<HTMLInputElement | null>(null)

async function loadLists(): Promise<void> {
  try {
    const p = await projectApi.list()
    projects.value = p.items
    listErr.value = ''
    const first = p.items[0]
    if (projectId.value == null && first) goProject(first.id)
  } catch (e) {
    listErr.value = e instanceof Error ? e.message : String(e)
  }
}

async function loadCanvases(): Promise<void> {
  const pid = projectId.value
  if (pid == null) {
    canvases.value = []
    return
  }
  try {
    const r = await creationApi.list(pid)
    if (projectId.value !== pid) return
    canvases.value = r.items
    const first = r.items[0]
    if (canvasId.value == null && first) goCanvas(first.id)
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  }
}

async function loadPalette(): Promise<void> {
  const pid = projectId.value
  if (pid == null) {
    palette.value = []
    palEntities.value = []
    return
  }
  paletteLoading.value = true
  paletteErr.value = ''
  try {
    if (palKind.value === 'entity') {
      // [M17] 实体 Tab：项目域 + 全局（服务端 ?project_id= 视角），三 kind 合并展示
      const params = `&project_id=${pid}`
      const [c, s, p] = await Promise.all([
        entityApi.list('character', params),
        entityApi.list('scene', params),
        entityApi.list('prop', params),
      ])
      if (projectId.value !== pid) return
      palEntities.value = [...c.items, ...s.items, ...p.items]
      return
    }
    const r = await projectApi.assets(pid, `?limit=120&kind=${palKind.value}`)
    if (projectId.value !== pid) return
    palette.value = r.items
  } catch (e) {
    paletteErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    paletteLoading.value = false
  }
}
watch(palKind, () => void loadPalette())

function goProject(pid: number): void {
  void router.replace({ path: '/creation', query: { project: String(pid) } })
}
function goCanvas(cid: number | null): void {
  const q: Record<string, string> = {}
  if (projectId.value != null) q.project = String(projectId.value)
  if (cid != null) q.canvas = String(cid)
  void router.replace({ path: '/creation', query: q })
}

const projSel = computed({
  get: () => (projectId.value == null ? '' : String(projectId.value)),
  set: (v: string) => {
    const id = Number(v)
    if (Number.isFinite(id) && id > 0) goProject(id)
  },
})
const canvasSel = computed({
  get: () => (canvasId.value == null ? '' : String(canvasId.value)),
  set: (v: string) => {
    const id = Number(v)
    if (Number.isFinite(id) && id > 0) goCanvas(id)
  },
})

// 文档拉取序列守卫（须先于下方 URL watch 声明：其 immediate 回调会同步触发 loadDoc）
let docSeq = 0

// ===== URL 同步 =====
function syncFromQuery(): void {
  const q = route.query
  const p = typeof q.project === 'string' && /^\d+$/.test(q.project) ? Number(q.project) : null
  const c = typeof q.canvas === 'string' && /^\d+$/.test(q.canvas) ? Number(q.canvas) : null
  const projChanged = p !== projectId.value
  const canvasChanged = c !== canvasId.value
  projectId.value = p
  canvasId.value = c
  if (projChanged) {
    void loadCanvases()
    void loadPalette()
  }
  if (canvasChanged) {
    selectedIds.value = []
    selectedEdgeId.value = null
    doc.value = null
    history.clear() // 换画布：命令栈失效
    if (c != null) void loadDoc()
  }
}
watch(() => route.query, syncFromQuery, { immediate: true })

// ===== 文档拉取（静默对账）=====
async function loadDoc(silent = false): Promise<void> {
  const id = canvasId.value
  if (id == null) return
  const seq = ++docSeq
  if (!silent) {
    loading.value = true
    err.value = ''
  }
  try {
    const d = await creationApi.doc(id)
    if (seq !== docSeq || canvasId.value !== id) return
    doc.value = d
    err.value = ''
    if (projectId.value == null) {
      projectId.value = d.canvas.projectId
      void loadCanvases()
      void loadPalette()
    }
    const nodeIdSet = new Set(d.nodes.map((n) => n.id))
    selectedIds.value = selectedIds.value.filter((id) => nodeIdSet.has(id))
    if (selectedEdgeId.value != null && !d.edges.some((e) => e.id === selectedEdgeId.value)) selectedEdgeId.value = null
  } catch (e) {
    if (!silent) err.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (!silent && seq === docSeq) loading.value = false
  }
}

let refreshTimer: number | null = null
function scheduleRefresh(): void {
  if (refreshTimer != null) window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null
    void loadDoc(true)
  }, 350)
}

// ===== socket（canvas room；手动 join/leave）=====
const socket = getSocket()
let joinedCanvas: number | null = null

function joinCanvasRoom(id: number): void {
  if (joinedCanvas === id) return
  if (joinedCanvas != null) socket.emit('leave', `canvas:${joinedCanvas}`)
  socket.emit('join', `canvas:${id}`)
  joinedCanvas = id
}
function leaveCanvasRoom(): void {
  if (joinedCanvas != null) {
    socket.emit('leave', `canvas:${joinedCanvas}`)
    joinedCanvas = null
  }
}
watch(
  canvasId,
  (id) => {
    if (id != null) joinCanvasRoom(id)
    else leaveCanvasRoom()
  },
  // immediate：URL 同步 watch（更早注册）已在 setup 期设置 canvasId，
  // 若不立即执行，首次进入/刷新（带 ?canvas=）会错失 null→id 变化而漏 join 房间
  { immediate: true },
)

function onCanvasEvent(p: StudioEventMap['canvas.changed']): void {
  if (canvasId.value != null && p.canvasId === canvasId.value) scheduleRefresh()
}

// ===== 选择 =====
function onSelect(ids: number[]): void {
  selectedIds.value = ids
  if (ids.length) selectedEdgeId.value = null
}
function onSelectEdge(id: number | null): void {
  selectedEdgeId.value = id
  if (id != null) selectedIds.value = []
}
function onClearSelection(): void {
  selectedIds.value = []
  selectedEdgeId.value = null
}

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

// ===== [M17] 批量编排（多选浮动条 / 顶栏整理）=====
const ARRANGE_LABEL: Record<CanvasArrangeMode, string> = {
  layered: '分层整理',
  grid: '按序号排列',
  'align-left': '左对齐',
  'align-right': '右对齐',
  'align-top': '顶对齐',
  'align-bottom': '底对齐',
  'distribute-h': '水平分布',
  'distribute-v': '垂直分布',
}
const batchBusy = ref(false)

/** 整理/对齐/分布（positions 快照入栈；失败 toast） */
async function runArrange(mode: CanvasArrangeMode, nodeIds?: number[]): Promise<void> {
  const cid = canvasId.value
  if (cid == null || !nodes.value.length) return
  batchBusy.value = true
  try {
    const targets = nodeIds ? nodes.value.filter((n) => nodeIds.includes(n.id)) : nodes.value
    const before = targets.map((n) => ({ id: n.id, x: n.x, y: n.y }))
    const r = await creationApi.arrange(cid, mode === 'grid' ? { mode, nodeIds, sortBy: 'seq' } : { mode, nodeIds })
    const after = r.positions
    history.push({
      label: ARRANGE_LABEL[mode],
      undo: async () => {
        await creationApi.batchNodes(cid, before)
        await loadDoc(true)
      },
      redo: async () => {
        await creationApi.batchNodes(cid, after)
        await loadDoc(true)
      },
    })
    await loadDoc(true)
    toast(`${ARRANGE_LABEL[mode]}：更新 ${r.updated} 个节点`)
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  } finally {
    batchBusy.value = false
  }
}
function batchArrange(mode: CanvasArrangeMode): void {
  void runArrange(mode, [...selectedIds.value])
}
function arrangeAll(mode: 'layered' | 'grid'): void {
  void runArrange(mode)
}

/** 编号：按 x 序（同 x 按 y）编 seq 1..N → batch 一条命令 */
async function batchNumber(): Promise<void> {
  const cid = canvasId.value
  const sel = nodes.value.filter((n) => selectedIds.value.includes(n.id))
  if (cid == null || sel.length < 2) return
  const sorted = [...sel].sort((a, b) => a.x - b.x || a.y - b.y)
  const before = sorted.map((n) => ({ id: n.id, seq: n.seq ?? null }))
  const updates = sorted.map((n, i) => ({ id: n.id, seq: i + 1 }))
  batchBusy.value = true
  try {
    await creationApi.batchNodes(cid, updates)
    history.push({
      label: `编号 1–${updates.length}`,
      undo: async () => {
        await creationApi.batchNodes(cid, before)
        await loadDoc(true)
      },
      redo: async () => {
        await creationApi.batchNodes(cid, updates)
        await loadDoc(true)
      },
    })
    await loadDoc(true)
    toast(`已按 x 序编号 1–${updates.length}`)
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  } finally {
    batchBusy.value = false
  }
}

/** 规则式串联（相邻对建边；created 可变引用，全跳过时提示原因） */
async function batchChain(): Promise<void> {
  const cid = canvasId.value
  const ids = [...selectedIds.value]
  if (cid == null || ids.length < 2) return
  batchBusy.value = true
  try {
    const r = await creationApi.chainNodes(cid, ids)
    let created = r.created.map((e) => e.id)
    if (!created.length) {
      toast(`未能串联：${r.skipped[0]?.reason ?? '无可连接的相邻对'}`)
      return
    }
    history.push({
      label: `串联 ${created.length} 条边`,
      undo: async () => {
        await Promise.all(created.map((id) => creationApi.removeEdge(id)))
        await loadDoc(true)
      },
      redo: async () => {
        const rr = await creationApi.chainNodes(cid, ids)
        created = rr.created.map((e) => e.id)
        await loadDoc(true)
      },
    })
    await loadDoc(true)
    toast(r.skipped.length ? `已串联 ${created.length} 条边，跳过 ${r.skipped.length} 对` : `已串联 ${created.length} 条边`)
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  } finally {
    batchBusy.value = false
  }
}

/** 批量执行（只入队就绪节点；不入栈） */
async function batchRun(): Promise<void> {
  const cid = canvasId.value
  const ids = [...selectedIds.value]
  if (cid == null || ids.length < 2) return
  batchBusy.value = true
  try {
    const r = await creationApi.runBatch(cid, { nodeIds: ids })
    await loadDoc(true)
    if (r.started.length && r.skipped.length) toast(`已入队 ${r.started.length} 个节点，跳过 ${r.skipped.length} 个（未就绪）`)
    else if (r.started.length) toast(`已入队 ${r.started.length} 个节点执行`)
    else toast(`无可执行节点：${r.skipped[0]?.problems.join('；') ?? '均未就绪'}`)
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  } finally {
    batchBusy.value = false
  }
}

// ===== [M17] 导出 zip（打包为 archive 资产 → 下载复用资产文件端点） =====
const exportBusy = ref(false)
const showExport = ref(false)
const exportResult = ref<CanvasExportResult | null>(null)

async function onExportZip(): Promise<void> {
  const cid = canvasId.value
  if (cid == null) return
  exportBusy.value = true
  try {
    exportResult.value = await creationApi.exportZip(cid)
    showExport.value = true
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  } finally {
    exportBusy.value = false
  }
}

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

// ===== 素材面板 =====
function paletteDragStart(ev: DragEvent, a: Asset): void {
  ev.dataTransfer?.setData('text/acs-asset-id', String(a.id))
  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy'
}

let paletteSeq = 0
async function paletteClick(a: Asset): Promise<void> {
  const cid = canvasId.value
  if (cid == null) return
  const at = boardRef.value?.centerWorld() ?? { x: 160, y: 120 }
  const jitter = (paletteSeq++ % 5) * 26
  try {
    await addNodesCommand(cid, [{ kind: 'asset', assetId: a.id, x: at.x + jitter, y: at.y + jitter }], '新建素材节点')
    toast('已加入素材节点')
    void loadDoc(true)
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  }
}

/** [M17] 实体 Tab：类型标签 + 拖入 / 单击送至视口中心（建 entity 节点） */
const ENT_KIND_TEXT: Record<EntityItem['kind'], string> = { character: '角色', scene: '场景', prop: '道具' }
function paletteEntityDragStart(ev: DragEvent, e: EntityItem): void {
  ev.dataTransfer?.setData('text/acs-entity-id', String(e.id))
  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy'
}
async function paletteEntityClick(e: EntityItem): Promise<void> {
  const cid = canvasId.value
  if (cid == null) return
  const at = boardRef.value?.centerWorld() ?? { x: 160, y: 120 }
  const jitter = (paletteSeq++ % 5) * 26
  try {
    await addNodesCommand(cid, [{ kind: 'entity', entityId: e.id, x: at.x + jitter, y: at.y + jitter }], '新建实体节点')
    toast('已加入实体节点')
    void loadDoc(true)
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err))
  }
}
async function onDropEntity(p: { entityId: number; x: number; y: number }): Promise<void> {
  const cid = canvasId.value
  if (cid == null) return
  try {
    await addNodesCommand(cid, [{ kind: 'entity', entityId: p.entityId, x: p.x, y: p.y }], '新建实体节点')
    toast('已加入实体节点')
    void loadDoc(true)
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err))
  }
}

function pickFiles(): void {
  fileInput.value?.click()
}
async function onFilePicked(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return
  const at = boardRef.value?.centerWorld() ?? { x: 160, y: 120 }
  await onDropFiles({ files, x: at.x, y: at.y })
}

// ===== 画布管理（改名 / 新建 / 复制 / 删除）=====
const renamingCanvas = ref(false)
const canvasNameDraft = ref('')
const canvasNameInput = ref<HTMLInputElement | null>(null)

function startRenameCanvas(): void {
  if (!doc.value) return
  canvasNameDraft.value = doc.value.canvas.name
  renamingCanvas.value = true
  void nextTick(() => canvasNameInput.value?.select())
}
async function saveCanvasName(): Promise<void> {
  if (!renamingCanvas.value) return
  renamingCanvas.value = false
  const cid = canvasId.value
  const name = canvasNameDraft.value.trim()
  if (cid == null || !doc.value || !name || name === doc.value.canvas.name) return
  try {
    await creationApi.update(cid, { name })
    toast('画布已改名')
    void loadDoc(true)
    void loadCanvases()
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  }
}

async function createCanvas(): Promise<void> {
  const pid = projectId.value
  if (pid == null) return
  try {
    const r = await creationApi.create(pid)
    await loadCanvases()
    goCanvas(r.canvas.id)
    toast('已新建画布')
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  }
}

async function duplicateCanvas(): Promise<void> {
  const cid = canvasId.value
  if (cid == null) return
  try {
    const r = await creationApi.duplicate(cid)
    await loadCanvases()
    goCanvas(r.canvas.id)
    toast('画布已复制')
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  }
}

async function removeCanvas(): Promise<void> {
  const cid = canvasId.value
  if (cid == null || !doc.value) return
  const ok = await confirmDialog({
    title: '删除画布',
    message: `删除画布「${doc.value.canvas.name}」及其全部节点与连线？产物资产会保留在资产库。`,
    confirmText: '删除画布',
    danger: true,
  })
  if (!ok) return
  try {
    await creationApi.remove(cid)
    doc.value = null
    await loadCanvases()
    const next = canvases.value[0]
    goCanvas(next ? next.id : null)
    toast('画布已删除')
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  }
}

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

// ===== 联动②：导出模板草案 =====
const showDraft = ref(false)
const draftBusy = ref(false)
const draftYaml = ref('')
const draftValidation = ref<TemplateValidation | null>(null)

async function openDraft(): Promise<void> {
  const cid = canvasId.value
  if (cid == null) return
  draftBusy.value = true
  try {
    const r = await creationApi.templateDraft(cid)
    draftYaml.value = r.yaml
    draftValidation.value = r.validation
    showDraft.value = true
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  } finally {
    draftBusy.value = false
  }
}
async function copyDraft(): Promise<void> {
  try {
    await navigator.clipboard.writeText(draftYaml.value)
    toast('YAML 已复制到剪贴板')
  } catch {
    toast('复制失败（剪贴板不可用，可手动全选复制）')
  }
}

// ===== 生命周期 =====
onMounted(() => {
  studioOn('canvas.changed', onCanvasEvent)
  void loadLists()
})
onBeforeUnmount(() => {
  studioOff('canvas.changed', onCanvasEvent)
  leaveCanvasRoom()
  if (refreshTimer != null) window.clearTimeout(refreshTimer)
  if (toastTimer != null) window.clearTimeout(toastTimer)
  if (runPollTimer != null) window.clearInterval(runPollTimer)
})
</script>

<template>
  <div class="crt-page">
    <!-- ===== 顶栏 ===== -->
    <div class="crt-bar">
      <select v-model="projSel" class="sel" title="项目">
        <option v-for="p in projects" :key="p.id" :value="String(p.id)">{{ p.name }}</option>
      </select>
      <span class="bar-sep">/</span>
      <input
        v-if="renamingCanvas"
        ref="canvasNameInput"
        v-model="canvasNameDraft"
        class="canvas-name-in"
        @keydown.enter="saveCanvasName"
        @keydown.esc="renamingCanvas = false"
        @blur="saveCanvasName"
      />
      <select v-else-if="canvases.length" v-model="canvasSel" class="sel" title="画布">
        <option v-for="c in canvases" :key="c.id" :value="String(c.id)">
          {{ c.name }}（{{ c.nodeCount }} 节点）
        </option>
      </select>
      <span v-else class="muted">暂无画布</span>
      <button
        v-if="canvasId != null && !renamingCanvas"
        type="button"
        class="btn sm"
        title="重命名当前画布"
        @click="startRenameCanvas"
      >
        <Icon name="pencil" :size="11" />
      </button>
      <button type="button" class="btn sm" title="新建空画布" :disabled="projectId == null" @click="createCanvas">
        <Icon name="plus" :size="11" /> 新建
      </button>
      <button
        type="button"
        class="btn sm"
        title="复制当前画布（节点与连线一并复制）"
        :disabled="canvasId == null"
        @click="duplicateCanvas"
      >
        <Icon name="copy" :size="11" /> 复制
      </button>
      <button
        type="button"
        class="btn sm danger"
        title="删除当前画布"
        :disabled="canvasId == null"
        @click="removeCanvas"
      >
        <Icon name="trash" :size="11" />
      </button>

      <span class="sp" />
      <span v-if="listErr" class="muted" :title="listErr">目录加载失败</span>
      <span v-if="loading" class="muted">加载中…</span>
      <button type="button" class="btn sm" :disabled="!canUndo" :title="undoTitle" @click="onUndo">
        <Icon name="undo" :size="12" />
      </button>
      <button type="button" class="btn sm" :disabled="!canRedo" :title="redoTitle" @click="onRedo">
        <Icon name="redo" :size="12" />
      </button>
      <button type="button" class="btn sm" title="适应视图（0）" :disabled="canvasId == null" @click="boardRef?.fit()">
        <Icon name="zoom-in" :size="12" /> 适应视图
      </button>
      <button
        type="button"
        class="btn sm"
        title="把画布素材节点/产物预填到运行表单（setting_docs）"
        :disabled="!runAssetIds.length"
        @click="openSendRun"
      >
        <Icon name="play" :size="11" /> 送去运行
      </button>
      <button
        type="button"
        class="btn sm"
        title="导出为模板草案（低保真 YAML + 校验自检，不落盘）"
        :disabled="canvasId == null || draftBusy"
        @click="openDraft"
      >
        <Icon name="doc" :size="11" /> {{ draftBusy ? '导出中…' : '模板草案' }}
      </button>
      <button
        type="button"
        class="btn sm"
        title="一键整理布局（按上下游分层排列；可撤销）"
        :disabled="canvasId == null || batchBusy || !nodes.length"
        @click="arrangeAll('layered')"
      >
        <Icon name="arrange" :size="11" /> 整理布局
      </button>
      <button
        type="button"
        class="btn sm"
        title="按故事板序号排列（grid；有 seq 优先，行优先）"
        :disabled="canvasId == null || batchBusy || !nodes.length"
        @click="arrangeAll('grid')"
      >
        <Icon name="flow" :size="11" /> 按序号
      </button>
      <button
        type="button"
        class="btn sm"
        title="打包导出画布产物（zip + manifest）"
        :disabled="canvasId == null || exportBusy"
        @click="onExportZip"
      >
        <Icon name="download" :size="11" /> {{ exportBusy ? '打包中…' : '导出' }}
      </button>
      <button
        type="button"
        class="btn sm"
        :class="{ primary: showOverview }"
        title="全局状态总览（按严重度排序；点击定位）"
        :disabled="canvasId == null"
        @click="showOverview = !showOverview"
      >
        <Icon name="eye" :size="11" /> 总览
      </button>
    </div>

    <div v-if="err" class="errbar">
      <Icon name="alert" :size="13" />
      <span class="eb-t">{{ err }}</span>
      <button type="button" class="btn sm" @click="loadDoc()">重试</button>
    </div>

    <!-- ===== 舞台 ===== -->
    <div class="crt-stage">
      <!-- 左：素材面板 -->
      <aside v-if="canvasId != null" class="crt-palette" aria-label="素材面板">
        <div class="pal-h">
          <div class="pal-tabs">
            <button type="button" class="pal-tab" :class="{ on: palKind === 'image' }" @click="palKind = 'image'">图片</button>
            <button type="button" class="pal-tab" :class="{ on: palKind === 'video' }" @click="palKind = 'video'">视频</button>
            <button type="button" class="pal-tab" :class="{ on: palKind === 'audio' }" @click="palKind = 'audio'">音频</button>
            <button type="button" class="pal-tab" :class="{ on: palKind === 'entity' }" @click="palKind = 'entity'">实体</button>
          </div>
          <button type="button" class="iconbtn" title="上传素材到项目" @click="pickFiles">
            <Icon name="upload" :size="12" />
          </button>
        </div>
        <div v-if="paletteLoading" class="muted mini">加载中…</div>
        <div v-else-if="palKind === 'entity' && !palEntities.length" class="muted mini">该项目暂无实体素材，可在「实体馆」页创建。</div>
        <div v-else-if="palKind !== 'entity' && !palette.length" class="muted mini">该项目暂无此类素材，可上传，或从流水线抽屉「送入创作画布」。</div>
        <div v-else-if="palKind === 'entity'" class="pal-list">
          <button
            v-for="e in palEntities"
            :key="e.id"
            type="button"
            class="pal-item"
            draggable="true"
            :title="`${e.name}（${ENT_KIND_TEXT[e.kind]}；拖入画布 / 单击送至视口中心）`"
            @dragstart="paletteEntityDragStart($event, e)"
            @click="paletteEntityClick(e)"
          >
            <img
              v-if="e.refAssets[0]"
              :src="e.refAssets[0].urls.thumb ?? e.refAssets[0].urls.file"
              loading="lazy"
              alt=""
            />
            <span v-else class="pal-ph">无参考图</span>
            <span class="pal-name">{{ e.name }}</span>
            <span class="pal-ebadge">{{ ENT_KIND_TEXT[e.kind] }} · {{ e.refAssetIds.length }}图</span>
          </button>
        </div>
        <div v-else class="pal-list">
          <button
            v-for="a in palette"
            :key="a.id"
            type="button"
            class="pal-item"
            draggable="true"
            :title="`${a.name}（拖入画布 / 单击送至视口中心）`"
            @dragstart="paletteDragStart($event, a)"
            @click="paletteClick(a)"
          >
            <img v-if="a.urls.thumb || a.kind === 'image'" :src="a.urls.thumb ?? a.urls.file" loading="lazy" alt="" />
            <span class="pal-name">{{ a.name }}</span>
          </button>
        </div>
        <div v-if="paletteErr" class="err-text mini">{{ paletteErr }}</div>
        <input
          ref="fileInput"
          type="file"
          multiple
          accept="image/*,video/*,audio/*,.md,.txt,.json"
          class="hidden-file"
          @change="onFilePicked"
        />
      </aside>

      <!-- 中：画布 -->
      <div class="crt-board">
        <CreationBoard
          v-if="canvasId != null && doc"
          :key="canvasId"
          ref="boardRef"
          :nodes="nodes"
          :edges="edges"
          :selected-ids="selectedIds"
          :selected-edge-id="selectedEdgeId"
          :initial-viewport="doc.canvas.viewport"
          @select="onSelect"
          @select-edge="onSelectEdge"
          @moved="onMoved"
          @nudge="onNudge"
          @connect="onConnect"
          @create-node="onCreateNode"
          @drop-files="onDropFiles"
          @drop-asset="onDropAsset"
          @drop-entity="onDropEntity"
          @viewport-settled="onViewportSettled"
          @delete-selected="onDeleteSelected"
          @copy-selected="onCopySelected"
          @undo="onUndo"
          @redo="onRedo"
        />

        <!-- [M17] 多选批量浮动条 -->
        <div v-if="canvasId != null && doc && selectedIds.length >= 2" class="batch-bar panel">
          <span class="bb-n">已选 {{ selectedIds.length }}</span>
          <span class="bb-sep" />
          <button type="button" class="btn sm" :disabled="batchBusy" title="左对齐" @click="batchArrange('align-left')">左对齐</button>
          <button type="button" class="btn sm" :disabled="batchBusy" title="右对齐" @click="batchArrange('align-right')">右对齐</button>
          <button type="button" class="btn sm" :disabled="batchBusy" title="顶对齐" @click="batchArrange('align-top')">顶对齐</button>
          <button type="button" class="btn sm" :disabled="batchBusy" title="底对齐" @click="batchArrange('align-bottom')">底对齐</button>
          <span class="bb-sep" />
          <button type="button" class="btn sm" :disabled="batchBusy" title="水平等间距分布" @click="batchArrange('distribute-h')">水平分布</button>
          <button type="button" class="btn sm" :disabled="batchBusy" title="垂直等间距分布" @click="batchArrange('distribute-v')">垂直分布</button>
          <button type="button" class="btn sm" :disabled="batchBusy" title="对选中集分层整理" @click="batchArrange('layered')">整理</button>
          <span class="bb-sep" />
          <button type="button" class="btn sm" :disabled="batchBusy" title="按选中顺序对相邻对自动建边（规则式）" @click="batchChain">串联</button>
          <button type="button" class="btn sm" :disabled="batchBusy" title="按 x 序编 seq 1..N（故事板序号）" @click="batchNumber">编号</button>
          <button type="button" class="btn sm" :disabled="batchBusy" title="复制选中（偏移 +40,+40）" @click="onCopySelected">复制</button>
          <span class="bb-sep" />
          <button type="button" class="btn sm primary" :disabled="batchBusy" title="批量执行（只入队就绪节点）" @click="batchRun">
            <Icon name="play" :size="11" /> 执行
          </button>
          <button type="button" class="btn sm danger" :disabled="batchBusy" title="删除选中节点" @click="onDeleteSelected()">
            <Icon name="trash" :size="11" /> 删除
          </button>
        </div>

        <!-- 空态引导 -->
        <div v-else class="crt-guide">
          <div class="gd-card panel">
            <Icon name="wand" :size="30" />
            <div class="gd-t">创作画布</div>
            <p class="muted gd-desc">
              自由摆放素材与生成节点、拖拽端口连线组织引用关系；双击空白新建生成节点，就地生成 / 编辑，
              产物可一键送去运行或导出为模板草案。左键拖拽框选（平移用空格 / 中键），Del 删除 / Ctrl+Z 撤销。
            </p>
            <div class="gd-sec">
              <div class="gd-h">选择画布</div>
              <div v-if="canvases.length" class="chips">
                <button
                  v-for="c in canvases"
                  :key="c.id"
                  type="button"
                  class="chip chipbtn"
                  @click="goCanvas(c.id)"
                >
                  {{ c.name }}（{{ c.nodeCount }}）
                </button>
              </div>
              <div v-else class="muted">该项目暂无画布</div>
            </div>
            <button type="button" class="btn primary" :disabled="projectId == null" @click="createCanvas">
              <Icon name="plus" :size="13" /> 新建画布
            </button>
          </div>
        </div>
      </div>

      <!-- 右：检查器（选中时覆盖） -->
      <CreationInspector
        v-if="canvasId != null && (selNode || selEdge)"
        :node="selNode"
        :edge="selEdge"
        :nodes="nodes"
        :edges="edges"
        :canvas-id="canvasId"
        :project-id="activeProjectId"
        :apply-patch="applyNodePatch"
        :apply-run="applyNodeRun"
        :apply-extract="applyNodeExtract"
        :apply-delete="applyDeleteFromInspector"
        :apply-remove-edge="applyRemoveEdge"
        @refresh="loadDoc(true)"
        @clear="onClearSelection"
        @notice="toast"
      />

      <!-- [M17] 全局状态总览抽屉（doc 派生；点击定位） -->
      <aside v-if="showOverview && canvasId != null" class="ov-drawer panel" aria-label="全局状态总览">
        <div class="ov-h">
          <span>总览</span>
          <span class="muted mini">{{ nodes.length }} 节点</span>
          <button type="button" class="iconbtn" title="收起" @click="showOverview = false">
            <Icon name="x" :size="12" />
          </button>
        </div>
        <div class="muted mini ov-legend">按严重度排序：失败 › 未就绪 › 运行中 › 就绪 › 完成 / 空闲；点击行定位到节点。</div>
        <div v-if="!overviewRows.length" class="muted mini">画布暂无节点</div>
        <div v-else class="ov-list">
          <button
            v-for="r in overviewRows"
            :key="r.id"
            type="button"
            class="ov-row"
            :class="{ active: selectedIds.includes(r.id) }"
            :title="r.summary"
            @click="focusNode(r.id)"
          >
            <span class="ov-dot" :class="r.dot" />
            <span class="ov-title">{{ r.title }}</span>
            <span class="ov-kind muted mini">{{ r.kind }}</span>
            <span class="ov-sum">{{ r.summary }}</span>
          </button>
        </div>
      </aside>
    </div>

    <!-- toast -->
    <Transition name="toast">
      <div v-if="toastMsg" class="crt-toast">{{ toastMsg }}</div>
    </Transition>

    <!-- 送去运行（模板表单；产物预填 setting_docs） -->
    <RunFormModal
      v-if="showRun && activeProjectId"
      :project-id="activeProjectId"
      :prefill-input="runPrefillInput"
      @done="onRunStarted"
      @close="showRun = false"
    />

    <!-- 模板草案 -->
    <Modal v-if="showDraft" title="模板草案（低保真导出）" :width="760" @close="showDraft = false">
      <div class="draft-body">
        <div class="draft-meta">
          <span v-if="draftValidation" class="badge" :class="draftValidation.ok ? 'succeeded' : 'failed'">
            {{ draftValidation.ok ? '校验通过' : '校验未通过' }}
          </span>
          <span class="muted mini">仅供人工整理为正式模板（workspace/templates）；不自动落盘。</span>
        </div>
        <ul v-if="draftValidation && draftValidation.errors.length" class="prob">
          <li v-for="(e2, i) in draftValidation.errors" :key="i">{{ e2 }}</li>
        </ul>
        <ul v-if="draftValidation && draftValidation.warnings.length" class="warnlist">
          <li v-for="(w, i) in draftValidation.warnings" :key="i">{{ w }}</li>
        </ul>
        <pre class="yaml mono">{{ draftYaml }}</pre>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="showDraft = false">关闭</button>
        <button type="button" class="btn primary" @click="copyDraft">
          <Icon name="copy" :size="12" /> 复制 YAML
        </button>
      </template>
    </Modal>

    <!-- [M17] 导出画布产物 zip -->
    <Modal v-if="showExport && exportResult" title="导出画布产物" :width="560" @close="showExport = false">
      <div class="exp-meta">
        <div class="em-row"><span class="em-k">打包</span><span class="em-v">{{ exportResult.stats.packed }} 个产物</span></div>
        <div class="em-row"><span class="em-k">跳过</span><span class="em-v">{{ exportResult.stats.skipped }} 个（缺失产物 / 不打包类型）</span></div>
        <div class="em-row"><span class="em-k">文件</span><span class="em-v mono">{{ exportResult.asset.name }}</span></div>
      </div>
      <div class="muted mini">zip 内含 manifest.json 与按序号命名的产物（seq-title-assetId.ext）；下载后可直接解包核对。</div>
      <template #footer>
        <button type="button" class="btn" @click="showExport = false">关闭</button>
        <a class="btn primary" :href="exportApi.fileUrl(exportResult.asset.id, true)">
          <Icon name="download" :size="12" /> 下载 zip
        </a>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.crt-page {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: calc(100vh - 44px);
  min-height: 420px;
}

.crt-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.sel {
  width: auto;
  max-width: 280px;
  padding: 5px 8px;
  font-size: 12px;
}

.bar-sep {
  color: var(--text-3);
}

.canvas-name-in {
  width: 240px;
  padding: 5px 8px;
  font-size: 12.5px;
}

.sp {
  flex: 1;
}

.errbar {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--bad);
  background: var(--bad-weak);
  border: 1px solid rgb(248 113 113 / 30%);
  border-radius: 9px;
  padding: 7px 12px;
  font-size: 12.5px;
}

.eb-t {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.crt-stage {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--bg);
}

.crt-palette {
  width: 208px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  background: var(--panel);
  border-right: 1px solid var(--border);
  overflow-y: auto;
}

.pal-h {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
}

.pal-tabs {
  display: flex;
  gap: 4px;
}

.pal-tab {
  border: 1px solid var(--border);
  background: var(--code-bg);
  color: var(--text-3);
  font-size: 10.5px;
  padding: 2px 8px;
  border-radius: 999px;
  cursor: pointer;
  font-family: inherit;
}

.pal-tab.on {
  color: #fff;
  border-color: var(--accent);
}

.pal-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.pal-item {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 3px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--code-bg);
  padding: 3px;
  cursor: grab;
  overflow: hidden;
  font-family: inherit;
}

.pal-item:hover {
  border-color: var(--accent);
}

.pal-item img {
  display: block;
  width: 100%;
  height: 62px;
  object-fit: cover;
  border-radius: 5px;
  pointer-events: none;
}

.pal-name {
  font-size: 10px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
}

.pal-ebadge {
  position: absolute;
  top: 6px;
  right: 6px;
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  pointer-events: none;
}

.pal-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 62px;
  border-radius: 5px;
  border: 1px dashed var(--border);
  font-size: 10px;
  color: var(--text-3);
}

.mini {
  font-size: 11px;
}

.iconbtn {
  display: flex;
  border: none;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 3px;
  border-radius: 6px;
}

.iconbtn:hover {
  background: var(--hover);
  color: #fff;
}

.hidden-file {
  display: none;
}

.crt-board {
  position: relative;
  flex: 1;
  min-width: 0;
}

.crt-guide {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 20px;
}

.gd-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  max-width: 520px;
  padding: 26px 28px;
  text-align: center;
}

.gd-t {
  font-weight: 700;
  font-size: 16px;
}

.gd-desc {
  font-size: 12.5px;
  line-height: 1.8;
  margin: 0;
}

.gd-sec {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.gd-h {
  font-size: 12px;
  color: var(--text-2);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
}

.chipbtn {
  cursor: pointer;
  font-family: inherit;
}

.chipbtn:hover {
  border-color: var(--accent);
  color: #fff;
}

.crt-toast {
  position: fixed;
  left: 50%;
  bottom: 30px;
  transform: translateX(-50%);
  background: var(--panel-2, var(--panel));
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  padding: 9px 18px;
  font-size: 12.5px;
  color: var(--text);
  box-shadow: 0 10px 30px rgb(0 0 0 / 40%);
  z-index: 40;
  max-width: 72vw;
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}

.draft-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.draft-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.prob {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--bad);
  line-height: 1.7;
}

.warnlist {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--warn);
  line-height: 1.7;
}

.yaml {
  margin: 0;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 11.5px;
  line-height: 1.6;
  max-height: 52vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

/* ===== [M17] 批量浮动条 / 总览抽屉 / 导出弹窗 ===== */
.batch-bar {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: center;
  max-width: calc(100% - 24px);
  padding: 7px 10px;
  border-radius: 10px;
  z-index: 5;
  box-shadow: 0 10px 30px rgb(0 0 0 / 45%);
}

.bb-n {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}

.bb-sep {
  width: 1px;
  height: 18px;
  background: var(--border);
}

.ov-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 312px;
  max-width: 88vw;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 12px 14px;
  border-left: 1px solid var(--border);
  box-shadow: -14px 0 30px rgb(0 0 0 / 34%);
  overflow-y: auto;
  z-index: 7;
}

.ov-h {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 13.5px;
}

.ov-h .iconbtn {
  margin-left: auto;
}

.ov-legend {
  line-height: 1.6;
}

.ov-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ov-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--code-bg);
  color: var(--text);
  padding: 6px 9px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
}

.ov-row:hover {
  border-color: var(--accent);
}

.ov-row.active {
  border-color: var(--accent);
  background: var(--hover);
}

.ov-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-3);
}

.ov-dot.bad {
  background: var(--bad);
}

.ov-dot.warn {
  background: var(--warn);
}

.ov-dot.run {
  background: var(--accent);
}

.ov-dot.ok {
  background: var(--ok);
}

.ov-title {
  flex: 0 1 auto;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ov-kind {
  flex: none;
}

.ov-sum {
  flex: 1;
  min-width: 0;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-3);
}

.exp-meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}

.em-row {
  display: flex;
  gap: 8px;
  font-size: 12.5px;
}

.em-k {
  flex: none;
  width: 44px;
  color: var(--text-3);
}

.em-v {
  min-width: 0;
  word-break: break-all;
}
</style>
