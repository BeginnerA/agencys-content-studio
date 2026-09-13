<script setup lang="ts">
/**
 * [M16] 创作画布检查器（spec §2.6；交互体例对齐 M15 CanvasDrawer）
 * - gen 节点：spec 表单（genKind/prompt/尺寸/端点覆盖/编辑模式）+ 执行（表单先自动保存）· 取消
 *   + 就绪度问题 / 编辑能力提示 / 任务历史（≤5）/ 结果预览 / 入边出边管理
 * - asset 节点：预览 / 改名 / 删除
 * - 边选中：端点信息 + 断开
 * - 蒙版编辑器（EditBrushModal）内联；「设为实体参考图」内联面板；所有操作 emit refresh 由父级全量重拉
 */
import { computed, nextTick, ref, watch } from 'vue'
import type {
  Asset, CanvasAssetLite, CanvasDocEdge, CanvasDocNode, CanvasEditMode, CanvasGenTaskLite,
  CreationNodeSpec, EntityItem, EntityKind, NodeSpecEdit,
} from '../lib/types'
import { assetApi, creationApi, entityApi, taskApi } from '../lib/api'
import { confirmDialog } from '../lib/confirm'
import { fmtMs, fmtTime, KIND_TEXT, purposeText } from '../lib/format'
import AssetPreviewer from './AssetPreviewer.vue'
import EditBrushModal from './EditBrushModal.vue'
import Icon from './Icon.vue'

const props = defineProps<{
  node: CanvasDocNode | null
  edge: CanvasDocEdge | null
  nodes: CanvasDocNode[]
  edges: CanvasDocEdge[]
  canvasId: number
  projectId: number
}>()
const emit = defineEmits<{ refresh: []; clear: []; notice: [msg: string] }>()

const opErr = ref('')
const opBusy = ref(false)

// ===== 通用文案 =====
const TASK_TEXT: Record<string, string> = { pending: '等待', processing: '生成中', succeeded: '成功', failed: '失败', cancelled: '已取消' }
const TASK_CLS: Record<string, string> = { pending: 'pending', processing: 'processing', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled' }
const PORT_TEXT: Record<string, string> = { reference: '参考图', first_frame: '首帧', last_frame: '尾帧', source: '源图（编辑底图）' }
const EDIT_MODE_TEXT: Record<CanvasEditMode, string> = { inpaint: '局部重绘', erase: '消除', outpaint: '扩图' }
const ENT_KIND_LABEL: Record<EntityKind, string> = { character: '角色', scene: '场景', prop: '道具' }

function stText(s: string | null): string {
  return s && s !== 'idle' ? (TASK_TEXT[s] ?? s) : ''
}
function stCls(s: string | null): string | undefined {
  return s ? (TASK_CLS[s] ?? 'pending') : undefined
}
function nodeIcon(n: CanvasDocNode): string {
  if (n.kind === 'asset') return 'photo'
  if (!n.spec) return 'alert'
  if (n.spec.edit) return 'brush'
  return n.spec.genKind === 'video' ? 'video' : 'photo'
}
function assetThumb(a: CanvasAssetLite | null): string | null {
  if (!a) return null
  return a.urls.thumb ?? (a.kind === 'image' ? a.urls.file : null)
}
function nodeTitle(id: number): string {
  return props.nodes.find((n) => n.id === id)?.title ?? `节点 #${id}`
}

// ===== 标题改名 =====
const titleDraft = ref('')
const renaming = ref(false)
const titleEl = ref<HTMLInputElement | null>(null)

function startRename(): void {
  titleDraft.value = props.node?.title ?? ''
  renaming.value = true
  void nextTick(() => titleEl.value?.select())
}
async function saveTitle(): Promise<void> {
  const n = props.node
  if (!n || !renaming.value) return
  renaming.value = false
  const t = titleDraft.value.trim()
  if (!t || t === n.title) return
  opErr.value = ''
  try {
    await creationApi.updateNode(n.id, { title: t })
    emit('notice', '标题已更新')
    emit('refresh')
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  }
}

// ===== gen 节点：spec 表单 =====
const fGenKind = ref<'image' | 'video'>('image')
const fPrompt = ref('')
const fSize = ref('')
const fDuration = ref('')
const fResolution = ref('')
const fAspectRatio = ref('')
const fProvider = ref('')
const fModel = ref('')
const fStyle = ref(true)
const fEditMode = ref<'' | CanvasEditMode>('')
const fAngle = ref('')
const fXScale = ref('')
const fYScale = ref('')

function formSnapshot(): string {
  return JSON.stringify({
    g: fGenKind.value, p: fPrompt.value, s: fSize.value, d: fDuration.value, r: fResolution.value,
    ar: fAspectRatio.value, pr: fProvider.value, m: fModel.value, st: fStyle.value, em: fEditMode.value,
    a: fAngle.value, xs: fXScale.value, ys: fYScale.value,
  })
}
let formBase = ''
const formTouched = ref(false)
// 实体挂接面板开合（node 变更 watch 会重置它，故必须先于该 watch 声明）
const entOpen = ref(false)

function fillForm(n: CanvasDocNode | null): void {
  const s = n?.spec ?? null
  fGenKind.value = s?.genKind ?? 'image'
  fPrompt.value = s?.prompt ?? ''
  fSize.value = s?.size ?? ''
  fDuration.value = s?.duration != null ? String(s.duration) : ''
  fResolution.value = s?.resolution ?? ''
  fAspectRatio.value = s?.aspectRatio ?? ''
  fProvider.value = s?.provider ?? ''
  fModel.value = s?.model ?? ''
  fStyle.value = s?.useStylePreset !== false
  fEditMode.value = s?.edit?.mode ?? ''
  fAngle.value = s?.edit?.expand?.angle != null ? String(s.edit.expand.angle) : ''
  fXScale.value = s?.edit?.expand?.xScale != null ? String(s.edit.expand.xScale) : ''
  fYScale.value = s?.edit?.expand?.yScale != null ? String(s.edit.expand.yScale) : ''
  formBase = formSnapshot()
  formTouched.value = false
}
watch(
  () => `${props.node?.id ?? ''}:${props.edge?.id ?? ''}`,
  () => {
    opErr.value = ''
    entOpen.value = false
    fillForm(props.node)
  },
  { immediate: true },
)
watch([fGenKind, fPrompt, fSize, fDuration, fResolution, fAspectRatio, fProvider, fModel, fStyle, fEditMode, fAngle, fXScale, fYScale], () => {
  formTouched.value = formSnapshot() !== formBase
})

/** 组装 spec（over.maskAssetId 供蒙版保存直填；表单为空的可选项不落库） */
function buildSpec(over?: { maskAssetId?: number }): CreationNodeSpec {
  const spec: CreationNodeSpec = { genKind: fGenKind.value, prompt: fPrompt.value.trim() }
  const size = fSize.value.trim()
  if (size) spec.size = size
  const duration = Number(fDuration.value)
  if (fGenKind.value === 'video' && fDuration.value.trim() && Number.isFinite(duration) && duration > 0) spec.duration = duration
  const resolution = fResolution.value.trim()
  if (resolution) spec.resolution = resolution
  const aspectRatio = fAspectRatio.value.trim()
  if (aspectRatio) spec.aspectRatio = aspectRatio
  const provider = fProvider.value.trim()
  if (provider) spec.provider = provider
  const model = fModel.value.trim()
  if (model) spec.model = model
  spec.useStylePreset = fStyle.value
  if (fGenKind.value === 'image' && fEditMode.value) {
    const edit: NodeSpecEdit = { mode: fEditMode.value }
    if (fEditMode.value === 'outpaint') {
      const expand: { angle?: number; xScale?: number; yScale?: number } = {}
      const a = Number(fAngle.value)
      if (fAngle.value.trim() && Number.isFinite(a)) expand.angle = a
      const xs = Number(fXScale.value)
      if (fXScale.value.trim() && Number.isFinite(xs)) expand.xScale = xs
      const ys = Number(fYScale.value)
      if (fYScale.value.trim() && Number.isFinite(ys)) expand.yScale = ys
      if (Object.keys(expand).length) edit.expand = expand
    } else {
      const mid = over?.maskAssetId ?? props.node?.spec?.edit?.maskAssetId
      if (mid) edit.maskAssetId = mid
    }
    spec.edit = edit
  }
  return spec
}

async function saveSpec(): Promise<void> {
  const n = props.node
  if (!n) return
  opBusy.value = true
  opErr.value = ''
  try {
    await creationApi.updateNode(n.id, { spec: buildSpec() })
    emit('notice', 'spec 已保存')
    emit('refresh')
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    opBusy.value = false
  }
}

// ===== 蒙版编辑器 =====
const showBrush = ref(false)
const sourceNode = computed<CanvasDocNode | null>(() => {
  const n = props.node
  if (!n) return null
  const e = props.edges.find((x) => x.to === n.id && x.port === 'source')
  if (!e) return null
  return props.nodes.find((x) => x.id === e.from) ?? null
})
const sourceAsset = computed<CanvasAssetLite | null>(() => sourceNode.value?.asset ?? null)
const currentMaskId = computed<number | null>(() => props.node?.spec?.edit?.maskAssetId ?? null)

function openBrush(): void {
  if (!sourceAsset.value) return
  showBrush.value = true
}
async function onMaskSaved(assetId: number): Promise<void> {
  showBrush.value = false
  const n = props.node
  if (!n) return
  opBusy.value = true
  opErr.value = ''
  try {
    await creationApi.updateNode(n.id, { spec: buildSpec({ maskAssetId: assetId }) })
    emit('notice', `蒙版已保存并应用（资产 #${assetId}）`)
    emit('refresh')
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    opBusy.value = false
  }
}

const capHint = computed<string | null>(() => {
  const n = props.node
  const cap = n?.editCapability
  if (!n?.spec?.edit || !cap) return null
  const mode = n.spec.edit.mode
  const ok = mode === 'outpaint' ? cap.outpaint : cap.inpaint
  return ok ? null : `当前图像端点未声明「${EDIT_MODE_TEXT[mode]}」能力，执行将失败（可在高级选项指定支持编辑的端点）`
})

// ===== 执行 / 取消 / 删除 =====
const runTitle = computed(() => {
  const n = props.node
  if (!n) return ''
  if (n.status === 'pending' || n.status === 'processing') return '节点正在执行中'
  if (n.canRun === true) return '执行该节点（当前表单会先自动保存）'
  return n.readiness?.problems.join('；') || '节点未就绪'
})

async function doRun(): Promise<void> {
  const n = props.node
  if (!n) return
  opBusy.value = true
  opErr.value = ''
  try {
    await creationApi.updateNode(n.id, { spec: buildSpec() })
    await creationApi.run(n.id)
    emit('notice', `节点「${n.title}」已入队执行`)
    emit('refresh')
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    opBusy.value = false
  }
}

async function doCancel(): Promise<void> {
  const t = props.node?.latestTask
  if (!t) return
  opBusy.value = true
  opErr.value = ''
  try {
    await taskApi.cancel(t.id)
    emit('notice', `任务 #${t.id} 已取消`)
    emit('refresh')
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    opBusy.value = false
  }
}

async function cancelTaskRow(t: CanvasGenTaskLite): Promise<void> {
  opBusy.value = true
  opErr.value = ''
  try {
    await taskApi.cancel(t.id)
    emit('notice', `任务 #${t.id} 已取消`)
    emit('refresh')
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    opBusy.value = false
  }
}

async function removeNode(): Promise<void> {
  const n = props.node
  if (!n) return
  const ok = await confirmDialog({
    title: '删除节点',
    message: `删除「${n.title}」及与其相连的所有边？产物资产会保留在资产库。`,
    confirmText: '删除节点',
    danger: true,
  })
  if (!ok) return
  opBusy.value = true
  opErr.value = ''
  try {
    await creationApi.removeNode(n.id)
    emit('clear')
    emit('notice', '节点已删除')
    emit('refresh')
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    opBusy.value = false
  }
}

// ===== 连线 =====
const incoming = computed<CanvasDocEdge[]>(() => {
  const n = props.node
  return n ? props.edges.filter((e) => e.to === n.id) : []
})
const outgoing = computed<CanvasDocEdge[]>(() => {
  const n = props.node
  return n ? props.edges.filter((e) => e.from === n.id) : []
})
const edgeFrom = computed<CanvasDocNode | null>(() => {
  const e = props.edge
  return e ? props.nodes.find((n) => n.id === e.from) ?? null : null
})
const edgeTo = computed<CanvasDocNode | null>(() => {
  const e = props.edge
  return e ? props.nodes.find((n) => n.id === e.to) ?? null : null
})

async function dropEdge(id: number): Promise<void> {
  opBusy.value = true
  opErr.value = ''
  try {
    await creationApi.removeEdge(id)
    emit('notice', '连线已断开')
    emit('refresh')
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    opBusy.value = false
  }
}

// ===== 预览 =====
const previewAssets = ref<Asset[]>([])
const previewIdx = ref<number | null>(null)

async function openPreview(assetId: number | null): Promise<void> {
  if (assetId == null) return
  opErr.value = ''
  try {
    const { asset } = await assetApi.detail(assetId)
    previewAssets.value = [asset]
    previewIdx.value = 0
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  }
}
function onPreviewChanged(updated: Asset): void {
  previewAssets.value = previewAssets.value.map((a) => (a.id === updated.id ? updated : a))
}

// ===== 设为实体参考图（内联面板） =====
const entKind = ref<EntityKind>('character')
const entList = ref<EntityItem[]>([])
const entLoading = ref(false)
const entBusy = ref<number | null>(null)
const entErr = ref('')

async function loadEntities(): Promise<void> {
  entLoading.value = true
  entErr.value = ''
  try {
    const r = await entityApi.list(entKind.value, `&project_id=${props.projectId}`)
    entList.value = r.items
  } catch (e) {
    entErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    entLoading.value = false
  }
}
function toggleEntities(): void {
  entOpen.value = !entOpen.value
  if (entOpen.value) void loadEntities()
}
watch(entKind, () => {
  if (entOpen.value) void loadEntities()
})

async function attachTo(e: EntityItem): Promise<void> {
  const n = props.node
  if (!n || n.assetId == null) return
  entBusy.value = e.id
  entErr.value = ''
  try {
    const r = await creationApi.attachRefAssets(e.id, [n.assetId])
    emit('notice', `已挂接「${e.name}」参考图（新增 ${r.added ?? 0} 张）`)
    entOpen.value = false
  } catch (err) {
    entErr.value = err instanceof Error ? err.message : String(err)
  } finally {
    entBusy.value = null
  }
}
</script>

<template>
  <aside class="ci" aria-label="节点检查器">
    <div v-if="!node && !edge" class="ci-empty">
      <Icon name="wand" :size="24" />
      <p class="muted">
        未选中节点。<br />
        单击节点查看与编辑属性；双击空白新建生成节点；拖拽右侧圆点到目标节点左侧圆点连线。
      </p>
    </div>

    <!-- ===== 节点视图 ===== -->
    <template v-else-if="node">
      <div class="ci-head">
        <Icon :name="nodeIcon(node)" :size="15" />
        <input
          v-if="renaming"
          ref="titleEl"
          v-model="titleDraft"
          class="ci-title-in"
          @keydown.enter="saveTitle"
          @keydown.esc="renaming = false"
          @blur="saveTitle"
        />
        <div v-else class="tt" :title="node.title" @dblclick="startRename">{{ node.title }}</div>
        <button type="button" class="iconbtn" title="改名" @click="startRename">
          <Icon name="pencil" :size="12" />
        </button>
        <button type="button" class="iconbtn" title="取消选中" @click="emit('clear')">
          <Icon name="x" :size="13" />
        </button>
      </div>
      <div class="sub mono">
        #{{ node.id }} ·
        {{ node.kind === 'asset' ? '素材' : node.spec?.genKind === 'video' ? '视频生成' : '图片生成' }}
        <template v-if="node.spec?.edit"> · 编辑（{{ EDIT_MODE_TEXT[node.spec.edit.mode] }}）</template>
      </div>
      <div v-if="node.kind === 'gen'" class="ci-status">
        <span v-if="stText(node.status)" class="badge" :class="stCls(node.status)">{{ stText(node.status) }}</span>
        <span v-if="node.latestTask" class="muted">{{ fmtTime(node.latestTask.createdAt) }}</span>
        <span v-if="node.latestTask && node.latestTask.attempts > 1" class="muted">尝试 {{ node.latestTask.attempts }}</span>
      </div>

      <!-- ===== gen：spec 表单 ===== -->
      <template v-if="node.kind === 'gen'">
        <section class="sec">
          <div class="sec-h">生成参数</div>
          <div class="frow">
            <label class="flabel">生成类型</label>
            <select v-model="fGenKind">
              <option value="image">图片</option>
              <option value="video">视频</option>
            </select>
          </div>
          <div class="frow">
            <label class="flabel">提示词</label>
            <textarea
              v-model="fPrompt"
              rows="3"
              :placeholder="fEditMode === 'inpaint' ? '要画什么（局部重绘必填）' : fEditMode === 'erase' ? '可留空（走消除默认提示词）' : '描述要生成的画面…'"
            />
          </div>
          <div v-if="fGenKind === 'image'" class="frow">
            <label class="flabel">画面尺寸</label>
            <input v-model="fSize" type="text" placeholder="如 832x1248（留空走项目/模板默认）" />
          </div>
          <template v-else>
            <div class="frow">
              <label class="flabel">时长（秒）</label>
              <input v-model="fDuration" type="number" min="1" step="1" placeholder="如 5（留空走默认）" />
            </div>
            <div class="frow">
              <label class="flabel">分辨率</label>
              <input v-model="fResolution" type="text" placeholder="如 480p / 768p（留空走默认）" />
            </div>
            <div class="frow">
              <label class="flabel">画幅比</label>
              <input v-model="fAspectRatio" type="text" placeholder="如 9:16（留空走默认）" />
            </div>
          </template>

          <div class="frow">
            <label class="flabel">编辑模式</label>
            <select v-model="fEditMode" :disabled="fGenKind === 'video'">
              <option value="">无（普通生成）</option>
              <option value="inpaint">局部重绘（涂抹后重画）</option>
              <option value="erase">消除（涂抹后去除）</option>
              <option value="outpaint">扩图（向外扩展画布）</option>
            </select>
          </div>
          <div v-if="fGenKind === 'video' && fEditMode" class="muted mini">视频节点不支持编辑模式，保存时将忽略。</div>

          <template v-if="fGenKind === 'image' && fEditMode && fEditMode !== 'outpaint'">
            <div class="maskrow">
              <div class="maskinfo">
                <span class="muted">蒙版：</span>
                <span v-if="currentMaskId != null" class="mono">资产 #{{ currentMaskId }}</span>
                <span v-else class="warn-t">未设置（执行前必需）</span>
              </div>
              <button
                type="button"
                class="btn sm"
                :disabled="!sourceAsset"
                :title="sourceAsset ? '在源图上涂抹要编辑的区域' : '请先连接源图（source 端口）'"
                @click="openBrush"
              >
                <Icon name="brush" :size="12" /> 打开蒙版编辑器…
              </button>
            </div>
            <div v-if="!sourceAsset" class="muted mini">请从上游节点的输出端口连线到本节点左侧的「源图」输入端口，作为编辑底图。</div>
          </template>

          <div v-if="fGenKind === 'image' && fEditMode === 'outpaint'" class="expandrow">
            <div class="frow3">
              <label class="flabel">旋转角</label>
              <input v-model="fAngle" type="number" step="1" placeholder="默认" />
            </div>
            <div class="frow3">
              <label class="flabel">横向倍率</label>
              <input v-model="fXScale" type="number" step="0.1" min="1" placeholder="如 1.5" />
            </div>
            <div class="frow3">
              <label class="flabel">纵向倍率</label>
              <input v-model="fYScale" type="number" step="0.1" min="1" placeholder="如 1.5" />
            </div>
          </div>

          <details class="fold">
            <summary>高级（端点覆盖 / 风格预设）</summary>
            <div class="frow">
              <label class="flabel">端点</label>
              <input v-model="fProvider" type="text" placeholder="如 aliyun_wan_image（留空自动解析）" />
            </div>
            <div class="frow">
              <label class="flabel">模型</label>
              <input v-model="fModel" type="text" placeholder="如 wan2.6-t2i（留空走端点默认）" />
            </div>
            <label class="chk">
              <input v-model="fStyle" type="checkbox" />
              <span>套用项目风格预设（图片生成）</span>
            </label>
          </details>

          <div class="ops">
            <button type="button" class="btn sm" :disabled="opBusy" @click="saveSpec">
              <Icon name="check" :size="12" /> 保存 spec
            </button>
            <span v-if="formTouched" class="muted mini">有未保存修改（执行时会自动保存）</span>
          </div>
        </section>

        <!-- ===== gen：就绪度 ===== -->
        <section class="sec">
          <div class="sec-h">就绪度</div>
          <div v-if="node.specError" class="err-text">{{ node.specError }}</div>
          <template v-else-if="node.readiness">
            <div v-if="node.readiness.ready" class="ok-t">
              <Icon name="check" :size="12" /> 已就绪，可执行
            </div>
            <ul v-else class="prob">
              <li v-for="(p, i) in node.readiness.problems" :key="i">{{ p }}</li>
            </ul>
          </template>
          <div v-if="capHint" class="warn-t mini">{{ capHint }}</div>
        </section>
      </template>

      <!-- ===== 操作 ===== -->
      <section class="sec">
        <div class="sec-h">操作</div>
        <div class="ops">
          <button
            v-if="node.kind === 'gen'"
            type="button"
            class="btn sm primary"
            :disabled="opBusy || (node.canRun !== true && !formTouched)"
            :title="runTitle"
            @click="doRun"
          >
            <Icon name="play" :size="12" /> 执行
          </button>
          <button
            v-if="node.kind === 'gen' && node.canCancel"
            type="button"
            class="btn sm"
            :disabled="opBusy"
            title="取消进行中的任务"
            @click="doCancel"
          >
            <Icon name="stop" :size="12" /> 取消任务
          </button>
          <span class="sp" />
          <button type="button" class="btn sm danger" :disabled="opBusy" title="删除节点（保留产物资产）" @click="removeNode">
            <Icon name="trash" :size="12" /> 删除节点
          </button>
        </div>
        <div v-if="opErr" class="err-text">{{ opErr }}</div>
      </section>

      <!-- ===== gen：任务历史 ===== -->
      <section v-if="node.kind === 'gen'" class="sec">
        <div class="sec-h">任务历史（最近 {{ node.tasks.length }} 条）</div>
        <div v-if="!node.tasks.length" class="muted">暂无任务</div>
        <div v-else class="tlist">
          <div v-for="t in node.tasks" :key="t.id" class="trow">
            <span class="mono tid">#{{ t.id }}</span>
            <span class="badge" :class="stCls(t.status)">{{ TASK_TEXT[t.status] ?? t.status }}</span>
            <span v-if="t.attempts > 1" class="muted">尝试 {{ t.attempts }}</span>
            <span v-if="t.status === 'succeeded' && t.completedAt" class="muted mono">{{ fmtMs(t.completedAt - t.createdAt) }}</span>
            <span v-if="t.errorMsg" class="t-err" :title="t.errorMsg">{{ t.errorMsg }}</span>
            <span class="sp" />
            <button
              v-if="t.status === 'succeeded' && t.resultAssetId != null"
              type="button"
              class="btn sm"
              @click="openPreview(t.resultAssetId)"
            >
              查看
            </button>
            <button
              v-if="t.status === 'pending' || t.status === 'processing'"
              type="button"
              class="btn sm danger"
              :disabled="opBusy"
              @click="cancelTaskRow(t)"
            >
              取消
            </button>
          </div>
        </div>
      </section>

      <!-- ===== gen：结果 ===== -->
      <section v-if="node.kind === 'gen' && node.assetId != null" class="sec">
        <div class="sec-h">结果（#{{ node.assetId }}）</div>
        <button type="button" class="resbox" title="点击预览" @click="openPreview(node.assetId)">
          <img v-if="assetThumb(node.asset)" :src="assetThumb(node.asset)!" alt="" />
          <span v-else class="muted">{{ node.asset ? (KIND_TEXT[node.asset.kind] ?? node.asset.kind) : '资产缺失' }}</span>
        </button>
      </section>

      <!-- ===== asset 节点：素材信息 ===== -->
      <template v-else-if="node.kind === 'asset'">
        <section class="sec">
          <div class="sec-h">素材</div>
          <button v-if="node.asset" type="button" class="resbox" title="点击预览" @click="openPreview(node.assetId)">
            <img v-if="assetThumb(node.asset)" :src="assetThumb(node.asset)!" alt="" />
            <span v-else class="muted">{{ KIND_TEXT[node.asset.kind] ?? node.asset.kind }}</span>
          </button>
          <div v-else class="err-text">引用的资产已不存在（#{{ node.assetId ?? '?' }}）</div>
          <div v-if="node.asset" class="kvs">
            <div class="kv">
              <span class="k">类型</span>
              <span class="v">
                {{ KIND_TEXT[node.asset.kind] ?? node.asset.kind }}
                <template v-if="node.asset.purpose"> · {{ purposeText(node.asset.purpose) }}</template>
              </span>
            </div>
            <div v-if="node.asset.width && node.asset.height" class="kv">
              <span class="k">尺寸</span>
              <span class="v mono">{{ node.asset.width }}×{{ node.asset.height }}</span>
            </div>
            <div v-if="node.asset.duration" class="kv">
              <span class="k">时长</span>
              <span class="v mono">{{ node.asset.duration }}s</span>
            </div>
          </div>
        </section>
      </template>

      <!-- ===== 连线 ===== -->
      <section class="sec">
        <div class="sec-h">连线（入 {{ incoming.length }} · 出 {{ outgoing.length }}）</div>
        <div v-if="!incoming.length && !outgoing.length" class="muted">无连线</div>
        <div v-else class="elist">
          <div v-for="e in incoming" :key="e.id" class="erow">
            <span class="edir mono">←</span>
            <span class="etitle" :title="nodeTitle(e.from)">{{ nodeTitle(e.from) }}</span>
            <span class="eport">{{ PORT_TEXT[e.port] ?? e.port }}</span>
            <button type="button" class="iconbtn" title="断开" @click="dropEdge(e.id)">
              <Icon name="x" :size="11" />
            </button>
          </div>
          <div v-for="e in outgoing" :key="'o' + e.id" class="erow">
            <span class="edir mono">→</span>
            <span class="etitle" :title="nodeTitle(e.to)">{{ nodeTitle(e.to) }}</span>
            <span class="eport">{{ PORT_TEXT[e.port] ?? e.port }}</span>
            <button type="button" class="iconbtn" title="断开" @click="dropEdge(e.id)">
              <Icon name="x" :size="11" />
            </button>
          </div>
        </div>
      </section>

      <!-- ===== 联动：设为实体参考图 ===== -->
      <section v-if="node.assetId != null" class="sec">
        <div class="sec-h">联动</div>
        <button type="button" class="btn sm" :disabled="node.assetId == null" @click="toggleEntities">
          <Icon name="link" :size="12" /> {{ entOpen ? '收起' : '设为实体参考图…' }}
        </button>
        <template v-if="entOpen">
          <div class="frow">
            <label class="flabel">实体类型</label>
            <select v-model="entKind">
              <option value="character">角色</option>
              <option value="scene">场景</option>
              <option value="prop">道具</option>
            </select>
          </div>
          <div v-if="entLoading" class="muted">加载中…</div>
          <div v-else-if="!entList.length" class="muted">该项目下暂无{{ ENT_KIND_LABEL[entKind] }}实体</div>
          <div v-else class="entlist">
            <button
              v-for="e in entList"
              :key="e.id"
              type="button"
              class="entitem"
              :disabled="entBusy === e.id"
              :title="`把产物 #${node.assetId} 挂为该实体的参考图`"
              @click="attachTo(e)"
            >
              <span class="entname">{{ e.name }}</span>
              <span class="muted mini">{{ e.refAssets?.length ?? 0 }} 张参考图</span>
            </button>
          </div>
          <div v-if="entErr" class="err-text">{{ entErr }}</div>
        </template>
      </section>
    </template>

    <!-- ===== 边视图 ===== -->
    <template v-else-if="edge">
      <div class="ci-head">
        <Icon name="link" :size="14" />
        <div class="tt">连线 #{{ edge.id }}</div>
        <button type="button" class="iconbtn" title="取消选中" @click="emit('clear')">
          <Icon name="x" :size="13" />
        </button>
      </div>
      <section class="sec">
        <div class="kv"><span class="k">起点</span><span class="v">{{ edgeFrom ? edgeFrom.title : `#${edge.from}` }}</span></div>
        <div class="kv">
          <span class="k">终点</span>
          <span class="v">{{ edgeTo ? edgeTo.title : `#${edge.to}` }} · {{ PORT_TEXT[edge.port] ?? edge.port }}</span>
        </div>
        <div class="ops">
          <button type="button" class="btn sm danger" :disabled="opBusy" @click="dropEdge(edge.id)">
            <Icon name="trash" :size="12" /> 断开连线
          </button>
        </div>
        <div v-if="opErr" class="err-text">{{ opErr }}</div>
      </section>
    </template>

    <!-- 蒙版编辑器（自持） -->
    <EditBrushModal
      v-if="showBrush && node?.spec?.edit && sourceAsset"
      :project-id="projectId"
      :base-url="sourceAsset.urls.file"
      :base-name="sourceAsset.name"
      @close="showBrush = false"
      @saved="onMaskSaved"
    />
    <!-- 结果预览（自持） -->
    <AssetPreviewer
      v-if="previewIdx !== null && previewAssets.length"
      :assets="previewAssets"
      :index="previewIdx"
      @close="previewIdx = null"
      @changed="onPreviewChanged"
    />
  </aside>
</template>

<style scoped>
.ci {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 340px;
  max-width: 92vw;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 15px 18px;
  background: var(--panel);
  border-left: 1px solid var(--border);
  box-shadow: -14px 0 30px rgb(0 0 0 / 34%);
  overflow-y: auto;
  z-index: 6;
  animation: ci-in 0.18s ease;
}

@keyframes ci-in {
  from {
    transform: translateX(22px);
    opacity: 0;
  }
}

.ci-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 36px 12px;
  text-align: center;
  color: var(--text-3);
}

.ci-empty p {
  font-size: 12px;
  line-height: 1.7;
  margin: 0;
}

.ci-head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--text-2);
}

.tt {
  flex: 1;
  min-width: 0;
  font-weight: 700;
  font-size: 13.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: text;
}

.ci-title-in {
  flex: 1;
  min-width: 0;
  padding: 4px 7px;
  font-size: 13px;
}

.iconbtn {
  display: flex;
  flex: none;
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

.sub {
  font-size: 11px;
  color: var(--text-3);
  word-break: break-all;
  margin-top: -4px;
}

.ci-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  flex-wrap: wrap;
}

.sec {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--border);
  padding-top: 10px;
}

.sec-h {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
  letter-spacing: 0.4px;
}

.frow {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.flabel {
  font-size: 11.5px;
  color: var(--text-3);
}

.frow select,
.frow input,
.frow textarea {
  font-size: 12.5px;
  padding: 6px 9px;
}

.frow3 {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
}

.frow3 input {
  font-size: 12px;
  padding: 5px 8px;
}

.expandrow {
  display: flex;
  gap: 8px;
}

.maskrow {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.maskinfo {
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.fold summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-2);
}

.fold summary:hover {
  color: #fff;
}

.fold {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.chk {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
}

.chk input {
  width: auto;
}

.ops {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.sp {
  flex: 1;
}

.mini {
  font-size: 11px;
}

.ok-t {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--ok);
}

.warn-t {
  font-size: 12px;
  color: var(--warn);
}

.prob {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--warn);
  line-height: 1.7;
}

.tlist {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.trow {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  padding: 3px 0;
  min-width: 0;
  flex-wrap: wrap;
}

.tid {
  color: var(--text-3);
  flex: none;
}

.t-err {
  flex: 1;
  min-width: 90px;
  color: var(--bad);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.resbox {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--code-bg);
  overflow: hidden;
  cursor: pointer;
  padding: 0;
  min-height: 84px;
}

.resbox:hover {
  border-color: var(--accent);
}

.resbox img {
  display: block;
  width: 100%;
  max-height: 190px;
  object-fit: contain;
}

.kvs {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.kv {
  display: flex;
  gap: 8px;
  font-size: 12px;
}

.kv .k {
  flex: none;
  width: 48px;
  color: var(--text-3);
}

.kv .v {
  min-width: 0;
  color: var(--text-2);
  word-break: break-all;
}

.elist {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.erow {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  min-width: 0;
}

.edir {
  flex: none;
  color: var(--text-3);
}

.etitle {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}

.eport {
  flex: none;
  font-size: 10.5px;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-3);
}

.entlist {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
  overflow-y: auto;
}

.entitem {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--code-bg);
  color: var(--text);
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}

.entitem:hover {
  border-color: var(--accent);
}

.entname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
