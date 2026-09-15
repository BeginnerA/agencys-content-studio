<script setup lang="ts">
/**
 * [M16] 创作画布检查器（spec §2.6；交互体例对齐 M15 CanvasDrawer）
 * - gen 节点：spec 表单（genKind/prompt/尺寸/端点覆盖/编辑模式）+ 执行（表单先自动保存）· 取消
 *   + 就绪度问题 / 编辑能力提示 / 任务历史（≤5）/ 结果预览 / 入边出边管理
 * - asset 节点：预览 / 改名 / 删除
 * - 边选中：端点信息 + 断开
 * - 蒙版编辑器（EditBrushModal）内联；「设为实体参考图」内联面板；所有操作 emit refresh 由父级全量重拉
 * ---- [M28] 已拆分：internals / use-inspector-form / 7 面板子组件（行为零变更；状态经 useInspectorForm 装配）----
 */

import { nextTick, ref } from 'vue'
import type { Asset, CanvasDocEdge, CanvasDocNode } from '../../../lib/types'
import { assetApi, type CanvasNodePatch } from '../../../lib/api'
import { fmtTime } from '../../../lib/format'
import Icon from '../../common/Icon.vue'
import Modal from '../../common/Modal.vue'
import AssetPreviewer from '../../asset/previewer/index.vue'
import EditBrushModal from '../EditBrushModal.vue'
import { EDIT_MODE_TEXT, PORT_TEXT, kindLabel, nodeIcon, stCls, stText } from './internals'
import { useInspectorForm } from './use-inspector-form'
import GenForm from './GenForm.vue'
import TextForm from './TextForm.vue'
import AssetPanel from './AssetPanel.vue'
import EntityPanel from './EntityPanel.vue'
import EntityLinkPanel from './EntityLinkPanel.vue'
import RunPanel from './RunPanel.vue'
import TasksPanel from './TasksPanel.vue'

const props = defineProps<{
  node: CanvasDocNode | null
  edge: CanvasDocEdge | null
  nodes: CanvasDocNode[]
  edges: CanvasDocEdge[]
  canvasId: number
  projectId: number
  /** [M17] 写命令回调（View 执行 + 入撤销栈；await 返回即已落库） */
  applyPatch: (p: { id: number; patch: CanvasNodePatch; label: string }) => Promise<void>
  applyRun: (p: { id: number; variants: number; savePatch?: CanvasNodePatch }) => Promise<void>
  applyExtract: (id: number) => Promise<void>
  applyDelete: () => Promise<void>
  applyRemoveEdge: (id: number) => Promise<void>
}>()
const emit = defineEmits<{ refresh: []; clear: []; notice: [msg: string] }>()

// ---- M28 装配：状态/操作经 composable；模板标识符解构直用 ----
const {
  form,
  genSpec, opErr, opBusy, formTouched, frameBusy, canExtractFrame, fVariants, frameMode, frameTime, runTitle,
  incoming, outgoing, edgeFrom, edgeTo,
  doRun, doCancel, doExtractFrame, removeNode, dropEdge,
  saveSpec, openExpand, doExpand, applyExpand, doExtract, saveText,
  openBrush, onMaskSaved, showBrush, sourceAsset,
  expandOpen, expandBusy, expandErr, expandDraft, expandInstruction, expandSrc,
  cancelTaskRow, adoptResult, toggleEntities, attachTo, openRunDetail, cancelRun,
} = useInspectorForm(props, emit)

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
    await props.applyPatch({ id: n.id, patch: { title: t }, label: '节点改名' })
    emit('notice', '标题已更新')
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
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
        {{ kindLabel(node) }}
        <template v-if="genSpec?.edit"> · 编辑（{{ EDIT_MODE_TEXT[genSpec.edit.mode] }}）</template>
      </div>
      <div v-if="node.kind === 'gen'" class="ci-status">
        <span v-if="stText(node.status)" class="badge" :class="stCls(node.status)">{{ stText(node.status) }}</span>
        <span v-if="node.latestTask" class="muted">{{ fmtTime(node.latestTask.createdAt) }}</span>
        <span v-if="node.latestTask && node.latestTask.attempts > 1" class="muted">尝试 {{ node.latestTask.attempts }}</span>
      </div>

      <GenForm
        v-if="node.kind === 'gen'"
        :node="node"
        :form="form"
        :save-spec="saveSpec"
        :open-expand="openExpand"
        :do-extract="doExtract"
        :open-brush="openBrush"
      />

      <!-- ===== 操作 ===== -->
      <section class="sec">
        <div class="sec-h">操作</div>
        <div class="ops">
          <label v-if="node.kind === 'gen'" class="vsel" title="执行变体数（1-4，建多个任务并行排队）">
            变体
            <select v-model.number="fVariants">
              <option v-for="n in 4" :key="n" :value="n">{{ n }}</option>
            </select>
          </label>
          <button
            v-if="node.kind === 'gen'"
            type="button"
            class="btn sm primary"
            :disabled="opBusy || (node.canRun !== true && !formTouched)"
            :title="runTitle"
            @click="doRun"
          >
            <Icon name="play" :size="12" /> 执行{{ fVariants > 1 ? ` ×${fVariants}` : '' }}
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
          <label v-if="canExtractFrame" class="vsel" title="抽帧位置（首/尾帧可接力 i2v）">
            抽帧
            <select v-model="frameMode">
              <option value="first">首帧</option>
              <option value="last">尾帧</option>
              <option value="custom">指定时刻</option>
            </select>
          </label>
          <input
            v-if="canExtractFrame && frameMode === 'custom'"
            v-model="frameTime"
            class="ft-time"
            type="number"
            min="0"
            step="0.1"
            placeholder="秒"
          />
          <button
            v-if="canExtractFrame"
            type="button"
            class="btn sm"
            :disabled="opBusy || frameBusy"
            title="从视频产物抽取一帧为图片素材节点"
            @click="doExtractFrame"
          >
            <Icon name="photo" :size="12" /> {{ frameBusy ? '抽帧中…' : '抽帧' }}
          </button>
          <span class="sp" />
          <button type="button" class="btn sm danger" :disabled="opBusy" title="删除节点（保留产物资产）" @click="removeNode">
            <Icon name="trash" :size="12" /> 删除节点
          </button>
        </div>
        <div v-if="opErr" class="err-text">{{ opErr }}</div>
      </section>

      <TasksPanel
        v-if="node.kind === 'gen'"
        :node="node"
        :form="form"
        :open-preview="openPreview"
        :cancel-task-row="cancelTaskRow"
        :adopt-result="adoptResult"
      />

      <AssetPanel v-else-if="node.kind === 'asset'" :node="node" :open-preview="openPreview" />

      <TextForm v-else-if="node.kind === 'text'" :node="node" :form="form" :save-text="saveText" :open-expand="openExpand" />

      <EntityPanel v-else-if="node.kind === 'entity'" :node="node" :open-preview="openPreview" />

      <RunPanel v-else-if="node.kind === 'run'" :node="node" :form="form" :open-run-detail="openRunDetail" :cancel-run="cancelRun" />

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

      <EntityLinkPanel
        v-if="node.assetId != null"
        :node="node"
        :form="form"
        :toggle-entities="toggleEntities"
        :attach-to="attachTo"
      />
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

    <!-- AI 扩写（对照弹窗：原文 / 可编辑草稿） -->
    <Modal v-if="expandOpen && node" title="AI 扩写" :width="720" @close="expandOpen = false">
      <div class="exp-body">
        <div class="exp-col">
          <div class="exp-h">原文</div>
          <pre class="exp-pre">{{ expandSrc }}</pre>
        </div>
        <div class="exp-col">
          <div class="exp-h">扩写结果（可编辑后应用）</div>
          <textarea v-model="expandDraft" class="exp-ta" rows="10" placeholder="点击「开始扩写」生成…" />
        </div>
      </div>
      <div class="frow">
        <label class="flabel">补充要求（可选）</label>
        <input v-model="expandInstruction" type="text" placeholder="如：更电影感、补充光影细节、控制在 120 字内…" @keydown.enter="doExpand" />
      </div>
      <div v-if="expandErr" class="err-text">{{ expandErr }}</div>
      <template #footer>
        <button type="button" class="btn" @click="expandOpen = false">关闭</button>
        <button type="button" class="btn" :disabled="expandBusy" @click="doExpand">
          <Icon name="sparkles" :size="12" /> {{ expandBusy ? '扩写中…' : expandDraft ? '重新扩写' : '开始扩写' }}
        </button>
        <button type="button" class="btn primary" :disabled="expandBusy || opBusy || !expandDraft.trim()" @click="applyExpand">
          <Icon name="check" :size="12" /> 应用
        </button>
      </template>
    </Modal>
    <!-- 蒙版编辑器（自持） -->
    <EditBrushModal
      v-if="showBrush && genSpec?.edit && sourceAsset"
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

.vsel {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-3);
}

.ft-time {
  width: 72px;
  font-size: 12px;
  padding: 4px 6px;
}

.vsel select {
  font-size: 12px;
  padding: 4px 6px;
}

.exp-body {
  display: flex;
  gap: 12px;
}

.exp-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.exp-h {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
}

.exp-pre {
  margin: 0;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--code-bg);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 340px;
  overflow-y: auto;
}

.exp-ta {
  font-size: 12.5px;
  min-height: 264px;
  resize: vertical;
}
</style>
