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
import { creationApi, projectApi, uploadFiles } from '../lib/api'
import { confirmDialog } from '../lib/confirm'
import { getSocket, studioOff, studioOn } from '../lib/socket'
import type { StudioEventMap } from '../lib/socket'
import type {
  Asset, CanvasDoc, CanvasDocEdge, CanvasDocNode, CanvasListItem, CanvasViewport, Project, TemplateValidation,
} from '../lib/types'

const route = useRoute()
const router = useRouter()

// ===== 目标（route.query 单一真源）=====
const projectId = ref<number | null>(null)
const canvasId = ref<number | null>(null)

const doc = ref<CanvasDoc | null>(null)
const loading = ref(false)
const err = ref('')

const selectedId = ref<number | null>(null)
const selectedEdgeId = ref<number | null>(null)
const boardRef = ref<InstanceType<typeof CreationBoard> | null>(null)

const nodes = computed<CanvasDocNode[]>(() => doc.value?.nodes ?? [])
const edges = computed<CanvasDocEdge[]>(() => doc.value?.edges ?? [])
const selNode = computed<CanvasDocNode | null>(() =>
  selectedId.value == null ? null : (nodes.value.find((n) => n.id === selectedId.value) ?? null),
)
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
    return
  }
  paletteLoading.value = true
  paletteErr.value = ''
  try {
    const r = await projectApi.assets(pid, '?limit=120&kind=image')
    if (projectId.value !== pid) return
    palette.value = r.items
  } catch (e) {
    paletteErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    paletteLoading.value = false
  }
}

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
    selectedId.value = null
    selectedEdgeId.value = null
    doc.value = null
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
    if (selectedId.value != null && !d.nodes.some((n) => n.id === selectedId.value)) selectedId.value = null
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
function onSelect(id: number | null): void {
  selectedId.value = id
  if (id != null) selectedEdgeId.value = null
}
function onSelectEdge(id: number | null): void {
  selectedEdgeId.value = id
  if (id != null) selectedId.value = null
}

// ===== 画布交互 → 写操作 =====
async function onNodeMoved(p: { id: number; x: number; y: number }): Promise<void> {
  if (doc.value) {
    doc.value = { ...doc.value, nodes: doc.value.nodes.map((n) => (n.id === p.id ? { ...n, x: p.x, y: p.y } : n)) }
  }
  try {
    await creationApi.updateNode(p.id, { x: p.x, y: p.y })
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
    void loadDoc(true)
  }
}

async function onConnect(p: { from: number; to: number; port: string }): Promise<void> {
  const cid = canvasId.value
  if (cid == null) return
  try {
    await creationApi.addEdge(cid, p)
    toast('已连线')
    void loadDoc(true)
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  }
}

async function onCreateNode(p: { x: number; y: number }): Promise<void> {
  const cid = canvasId.value
  if (cid == null) return
  try {
    const r = await creationApi.addNode(cid, { kind: 'gen', spec: { genKind: 'image', prompt: '' }, x: p.x, y: p.y })
    await loadDoc(true)
    selectedId.value = r.node.id
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
    for (let i = 0; i < assets.length; i++) {
      const a = assets[i]
      if (!a) continue
      await creationApi.addNode(cid, {
        kind: 'asset',
        assetId: a.id,
        x: p.x + (i % 3) * 36,
        y: p.y + (i % 3) * 36,
      })
    }
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
    await creationApi.addNode(cid, { kind: 'asset', assetId: p.assetId, x: p.x, y: p.y })
    toast('已加入素材节点')
    void loadDoc(true)
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
  }
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
    await creationApi.addNode(cid, { kind: 'asset', assetId: a.id, x: at.x + jitter, y: at.y + jitter })
    toast('已加入素材节点')
    void loadDoc(true)
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e))
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
  toast(`已启动运行 #${id}`)
  void router.push({ path: `/runs/${id}` })
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
          <span>素材（图片）</span>
          <button type="button" class="iconbtn" title="上传素材到项目" @click="pickFiles">
            <Icon name="upload" :size="12" />
          </button>
        </div>
        <div v-if="paletteLoading" class="muted mini">加载中…</div>
        <div v-else-if="!palette.length" class="muted mini">项目暂无图片素材，可上传，或从流水线抽屉「送入创作画布」。</div>
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
          :selected-id="selectedId"
          :selected-edge-id="selectedEdgeId"
          :initial-viewport="doc.canvas.viewport"
          @select="onSelect"
          @select-edge="onSelectEdge"
          @node-moved="onNodeMoved"
          @connect="onConnect"
          @create-node="onCreateNode"
          @drop-files="onDropFiles"
          @drop-asset="onDropAsset"
          @viewport-settled="onViewportSettled"
        />

        <!-- 空态引导 -->
        <div v-else class="crt-guide">
          <div class="gd-card panel">
            <Icon name="wand" :size="30" />
            <div class="gd-t">创作画布</div>
            <p class="muted gd-desc">
              自由摆放素材与生成节点、拖拽端口连线组织引用关系；双击空白新建生成节点，就地生成 / 编辑，
              产物可一键送去运行或导出为模板草案。
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
        @refresh="loadDoc(true)"
        @clear="onSelect(null); onSelectEdge(null)"
        @notice="toast"
      />
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

.pal-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.pal-item {
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
</style>
