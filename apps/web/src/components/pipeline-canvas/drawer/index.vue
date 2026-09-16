<script setup lang="ts">
/**
 * [M15] 节点抽屉（spec §2.4）
 * - run 态：操作（闸门三决策 / 单步重跑 RerunModal / 重新合成 / 任务行内 retry·cancel）+ 输入 + 产物 + 日志
 * - template 态：设计态信息（gate / 依赖 / 条件 / 批量 / 产物用途 / 引用清单；无运行字段与操作）
 * - [M23] template 态 + 编辑模式：画布内编辑区（标题 / 输入字段；本地草稿，patch 经 emit('edit') 回流）
 * - node.key / status / assetIds 变化重载各分区；操作后 emit refresh 由父级全量重拉（REST 对账）
 * ---- [M28] 已拆分：交互逻辑经 use-canvas-drawer.ts 装配（行为零变更）----
 */
import type { DrawerSel } from './use-canvas-drawer'
import { useCanvasDrawer } from './use-canvas-drawer'
import { fmtMs, fmtTime, KIND_TEXT, purposeText, skipReasonText, stepStatus, taskStatus } from '../../../lib/format'
import type { EditNodeState, StepOverride } from '../../../lib/types'
import AssetPreviewer from '../../asset/previewer/index.vue'
import CanvasTargetModal from '../../creation/CanvasTargetModal.vue'
import GateDialog from '../../run/GateDialog.vue'
import Icon from '../../common/Icon.vue'
import RerunModal from '../../run/RerunModal.vue'

const props = defineProps<{
  runId: number | null
  sel: DrawerSel
  log: string
  projectId: number | null
  /** [M23] 画布内编辑：编辑模式下选中节点的编辑区视图（非编辑态 → null/不传） */
  editNode?: EditNodeState | null
}>()
const emit = defineEmits<{
  close: []
  refresh: []
  'open-canvas': [canvasId: number]
  /** [M23] 编辑草稿转交（patch 结构对齐 P3 edits.steps[]） */
  edit: [key: string, patch: StepOverride]
}>()

// ---- M28 装配：状态/操作经 composable；模板标识符解构直用 ----
const { rn, tn, notice, opErr, gateBusy, gateErr, gateText, gateTextName, gateVisible, gateSkipLabel, onGateDecided, showRerun, recomposeBusy, rerunStep, onRerunDone, doRecompose, tasks, tasksLoading, taskBusy, taskErr, retryTask, cancelTask, assets, assetsLoading, previewIdx, onAssetChanged, REF_KIND_TEXT, refs, inputJson, depText, condText, batchText, logEl, logLines, logText, showSend, sendItems, onSendDone } = useCanvasDrawer(props, emit)

// ---- [M23] 编辑区输入转交（受控：值经父级 useCanvasEdit overlay 回流） ----
function onEditTitle(e: Event): void {
  if (!props.editNode) return
  emit('edit', props.editNode.key, { title: (e.target as HTMLInputElement).value })
}
function onEditText(fieldKey: string, e: Event): void {
  if (!props.editNode) return
  emit('edit', props.editNode.key, { texts: { [fieldKey]: (e.target as HTMLInputElement).value } })
}
</script>

<template>
  <aside class="dr" aria-label="节点详情">
    <div class="dr-head">
      <div class="tt-wrap">
        <div class="tt" :title="sel.node.title">{{ sel.node.title }}</div>
        <div class="sub mono">#{{ sel.node.seq + 1 }} · {{ sel.node.key }} · {{ sel.node.action }}</div>
      </div>
      <button type="button" class="x" title="关闭（保持节点选中）" @click="emit('close')">
        <Icon name="x" :size="14" />
      </button>
    </div>

    <!-- ===== run 态：状态行 ===== -->
    <div v-if="rn" class="dr-status">
      <span class="badge" :class="rn.status === 'skipped' ? 'skip' : rn.status">{{ stepStatus(rn.status).text }}</span>
      <span v-if="rn.durationMs != null" class="muted">耗时 {{ fmtMs(rn.durationMs) }}</span>
      <span v-if="rn.attempts > 0" class="muted">尝试 {{ rn.attempts }}</span>
      <span v-if="rn.startedAt" class="muted">{{ fmtTime(rn.startedAt) }}</span>
    </div>
    <div v-if="rn && rn.error" class="err-text">{{ rn.error }}</div>
    <div v-if="rn && rn.skippedReason" class="muted sk">跳过原因：{{ skipReasonText(rn.skippedReason) }}</div>
    <div v-if="rn && rn.gateTrace" class="muted sk">
      上轮闸门：{{ rn.gateTrace.decision === 'approve' ? '批准' : '驳回' }}
      <template v-if="rn.gateTrace.note">（{{ rn.gateTrace.note }}）</template>
      · {{ fmtTime(rn.gateTrace.at) }}
    </div>

    <!-- ===== run 态：操作区 ===== -->
    <section v-if="rn" class="sec">
      <div class="sec-h">操作</div>

      <GateDialog
        v-if="gateVisible"
        :step-title="sel.node.title"
        :message="rn ? rn.gate?.message ?? '' : ''"
        :artifact-text="gateText || undefined"
        :artifact-name="gateTextName || undefined"
        :skip-label="gateSkipLabel"
        :busy="gateBusy"
        @decided="onGateDecided"
      />
      <div v-if="gateErr" class="err-text">{{ gateErr }}</div>

      <div v-if="!gateVisible" class="ops">
        <button
          v-if="rn.actions.rerun"
          type="button"
          class="btn sm"
          :disabled="!rn.actions.rerun.allowed || rerunStep === null"
          :title="rn.actions.rerun.allowed ? '重跑该步骤（可复用成功子任务）' : rn.actions.rerun.reason ?? ''"
          @click="showRerun = true"
        >
          <Icon name="refresh" :size="12" /> 单步重跑…
        </button>
        <button
          v-if="rn.actions.recompose"
          type="button"
          class="btn sm"
          :disabled="!rn.actions.recompose.allowed || recomposeBusy"
          :title="rn.actions.recompose.allowed ? '重置合成并重新执行（本地 ffmpeg）' : rn.actions.recompose.reason ?? ''"
          @click="doRecompose"
        >
          <Icon name="film" :size="12" /> {{ recomposeBusy ? '提交中…' : '重新合成' }}
        </button>
        <span v-if="!rn.actions.rerun && !rn.actions.recompose" class="muted">当前状态无可用操作</span>
      </div>
      <div
        v-if="!gateVisible && rn.actions.rerun && !rn.actions.rerun.allowed && rn.actions.rerun.reason"
        class="muted reason"
      >
        {{ rn.actions.rerun.reason }}
      </div>
      <div
        v-if="!gateVisible && rn.actions.recompose && !rn.actions.recompose.allowed && rn.actions.recompose.reason"
        class="muted reason"
      >
        {{ rn.actions.recompose.reason }}
      </div>

      <div v-if="notice" class="notice-box">{{ notice }}</div>
      <div v-if="opErr" class="err-text">{{ opErr }}</div>
    </section>

    <!-- ===== run 态：子任务 ===== -->
    <section v-if="rn && rn.stepId != null" class="sec">
      <div class="sec-h">子任务（{{ tasks.length }}）</div>
      <div v-if="tasksLoading" class="muted">加载中…</div>
      <div v-else-if="!tasks.length" class="muted">该步骤为整体执行型（无子任务）</div>
      <div v-else class="tlist">
        <div v-for="t in tasks" :key="t.id" class="trow">
          <span class="mono tid">#{{ t.id }}</span>
          <span class="badge" :class="taskStatus(t.status).cls">{{ taskStatus(t.status).text }}</span>
          <span class="muted tkind mono">{{ t.kind }}</span>
          <span v-if="t.errorMsg" class="t-err" :title="t.errorMsg">{{ t.errorMsg }}</span>
          <span class="sp" />
          <button
            v-if="(t.status === 'failed' || t.status === 'cancelled') && rn.actions.taskRetry"
            type="button"
            class="btn sm"
            :disabled="taskBusy === t.id"
            title="重新入队该任务"
            @click="retryTask(t)"
          >
            重试
          </button>
          <button
            v-if="t.status === 'pending' || t.status === 'processing'"
            type="button"
            class="btn sm danger"
            :disabled="taskBusy === t.id"
            title="取消该任务"
            @click="cancelTask(t)"
          >
            取消
          </button>
        </div>
      </div>
      <div v-if="taskErr" class="err-text">{{ taskErr }}</div>
    </section>

    <!-- ===== [M23] template 态：画布内编辑（本地草稿；E3） ===== -->
    <section v-if="editNode" class="sec">
      <div class="sec-h sh-row">
        <span>画布内编辑</span>
        <span class="sp" />
        <span class="etag">草稿</span>
      </div>
      <div class="efld">
        <label class="efl" :for="`edt-title-${editNode.key}`">
          步骤标题
          <em v-if="editNode.titleDirty" class="edot" title="已修改" />
        </label>
        <input
          :id="`edt-title-${editNode.key}`"
          type="text"
          :class="{ ebad: editNode.title.trim() === '' }"
          :value="editNode.title"
          placeholder="标题不能为空"
          @input="onEditTitle"
        />
        <div v-if="editNode.title.trim() === ''" class="err-text eerr">标题不能为空</div>
      </div>
      <div class="efld">
        <div class="efl">输入字段</div>
        <div v-if="editNode.fields.length" class="eflist">
          <div v-for="f in editNode.fields" :key="f.key" class="efrow">
            <label class="efk mono" :for="`edt-${editNode.key}-${f.key}`">
              {{ f.key }}
              <em v-if="f.dirty" class="edot" title="已修改" />
            </label>
            <input
              v-if="f.editable"
              :id="`edt-${editNode.key}-${f.key}`"
              type="text"
              :value="f.value"
              @input="onEditText(f.key, $event)"
            />
            <div v-else class="efro" :title="f.value">
              <span class="efro-t mono">{{ f.value }}</span>
              <span class="efro-tag">只读</span>
            </div>
          </div>
        </div>
        <div v-else class="muted">该步骤无输入字段</div>
      </div>
      <div class="muted hint">编辑为本地草稿，不改动原模板文件；重置与退出编辑在顶栏操作。</div>
    </section>

    <!-- ===== template 态：设计信息 ===== -->
    <section v-if="tn" class="sec">
      <div class="sec-h">设计态</div>
      <div class="kv">
        <span class="k">闸门</span>
        <span v-if="tn.gate" class="v">
          {{ tn.gate.mode }} · {{ tn.gate.message }}<em v-if="tn.gate.skipLabel">（免审放行：{{ tn.gate.skipLabel }}）</em>
        </span>
        <span v-else class="v muted">无</span>
      </div>
      <div class="kv"><span class="k">依赖</span><span class="v mono">{{ depText }}</span></div>
      <div class="kv"><span class="k">条件</span><span class="v mono">{{ condText }}</span></div>
      <div class="kv"><span class="k">批量</span><span class="v">{{ batchText }}</span></div>
      <div class="kv"><span class="k">产物</span><span class="v">{{ tn.output ? purposeText(tn.output.purpose) : '—' }}</span></div>
      <div class="muted hint">模板画布为设计态预览；运行状态与操作请切换到运行画布。</div>
    </section>

    <!-- ===== 输入引用（两态共用） ===== -->
    <section class="sec">
      <div class="sec-h">输入引用</div>
      <div v-if="refs.length" class="refs">
        <div v-for="(r, i) in refs" :key="i" class="refrow">
          <span class="rfield mono">{{ r.field }}</span>
          <span class="rkind" :data-k="r.kind">{{ REF_KIND_TEXT[r.kind] }}</span>
          <span class="rref mono" :title="r.ref">{{ r.ref }}</span>
        </div>
      </div>
      <div v-else class="muted">无引用（纯静态输入）</div>
      <details v-if="rn && inputJson" class="fold">
        <summary>输入快照（step.input）</summary>
        <pre class="pre mono">{{ inputJson }}</pre>
      </details>
    </section>

    <!-- ===== run 态：产物 ===== -->
    <section v-if="rn" class="sec">
      <div class="sec-h sh-row">
        <span>产物（{{ rn.assetIds.length }}）</span>
        <span class="sp" />
        <button
          v-if="rn.assetIds.length && projectId != null"
          type="button"
          class="btn sm"
          title="把本步骤产物送入创作画布作为素材节点"
          @click="showSend = true"
        >
          <Icon name="wand" :size="11" /> 送入创作画布…
        </button>
      </div>
      <div v-if="assetsLoading" class="muted">加载中…</div>
      <div v-else-if="!rn.assetIds.length" class="muted">此步骤暂无产物</div>
      <template v-else>
        <div class="thumbs">
          <button v-for="(a, i) in assets" :key="a.id" type="button" class="thumb" :title="a.name" @click="previewIdx = i">
            <img v-if="a.urls.thumb || a.kind === 'image'" :src="a.urls.thumb ?? a.urls.file" loading="lazy" alt="" />
            <span v-else class="tkindbox">{{ KIND_TEXT[a.kind] ?? a.kind }}</span>
            <span class="tname">{{ a.name }}</span>
          </button>
        </div>
        <div v-if="rn.assetIds.length > assets.length" class="muted more">
          仅展示前 {{ assets.length }} 项（共 {{ rn.assetIds.length }}）
        </div>
      </template>
    </section>

    <!-- ===== run 态：日志（按 [stepKey] 过滤） ===== -->
    <section v-if="rn" class="sec">
      <div class="sec-h">日志（{{ logLines.length }} 行 · 按 [{{ sel.node.key }}] 过滤）</div>
      <pre ref="logEl" class="log mono">{{ logText || '暂无该步骤日志' }}</pre>
    </section>

    <!-- 重跑弹窗（复用 M11） -->
    <RerunModal
      v-if="showRerun && rerunStep && runId != null"
      :run-id="runId"
      :step="rerunStep"
      @close="showRerun = false"
      @done="onRerunDone"
    />
    <!-- [M16] 送入创作画布 -->
    <CanvasTargetModal
      v-if="showSend && projectId != null && rn"
      :project-id="projectId"
      :assets="sendItems"
      @done="onSendDone"
      @close="showSend = false"
    />
    <!-- 产物预览（自持） -->
    <AssetPreviewer
      v-if="previewIdx !== null && assets.length"
      :assets="assets"
      :index="previewIdx"
      @close="previewIdx = null"
      @changed="onAssetChanged"
    />
  </aside>
</template>

<style scoped>
.dr {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 420px;
  max-width: 92vw;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px 18px;
  background: var(--panel);
  border-left: 1px solid var(--border);
  box-shadow: -14px 0 30px rgb(0 0 0 / 34%);
  overflow-y: auto;
  z-index: 6;
  animation: dr-in 0.18s ease;
}

@keyframes dr-in {
  from {
    transform: translateX(26px);
    opacity: 0;
  }
}

.dr-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.tt-wrap {
  flex: 1;
  min-width: 0;
}

.tt {
  font-weight: 700;
  font-size: 14.5px;
}

.sub {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
  word-break: break-all;
}

.x {
  display: flex;
  border: none;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
}

.x:hover {
  background: var(--hover);
  color: #fff;
}

.dr-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  flex-wrap: wrap;
}

.sk {
  font-size: 12px;
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

.sh-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ops {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.reason {
  font-size: 11.5px;
}

.notice-box {
  border: 1px solid rgb(34 197 94 / 30%);
  background: var(--ok-weak);
  color: var(--ok);
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 12px;
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
  padding: 4px 2px;
  min-width: 0;
}

.tid {
  color: var(--text-3);
  flex: none;
}

.tkind {
  flex: none;
}

.t-err {
  flex: 1;
  min-width: 0;
  color: var(--bad);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sp {
  flex: 1;
}

.refs {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.refrow {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  min-width: 0;
}

.rfield {
  flex: none;
  color: var(--accent-h);
  font-size: 11.5px;
}

.rkind {
  flex: none;
  font-size: 10.5px;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-2);
}

.rkind[data-k='step'] {
  color: var(--ok);
  border-color: rgb(34 197 94 / 35%);
}

.rkind[data-k='assets-purpose'] {
  color: var(--warn);
  border-color: rgb(251 191 36 / 35%);
}

.rref {
  font-size: 11.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fold summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-2);
}

.fold summary:hover {
  color: #fff;
}

.pre {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px 11px;
  font-size: 11.5px;
  line-height: 1.6;
  overflow: auto;
  max-height: 220px;
  margin: 6px 0 0;
  white-space: pre-wrap;
  word-break: break-all;
}

.thumbs {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}

.thumb {
  display: flex;
  flex-direction: column;
  gap: 3px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 3px;
  background: var(--code-bg);
  cursor: pointer;
  overflow: hidden;
}

.thumb:hover {
  border-color: var(--accent);
}

.thumb img {
  display: block;
  width: 100%;
  height: 56px;
  object-fit: cover;
  border-radius: 5px;
}

.tkindbox {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 56px;
  font-size: 11px;
  color: var(--text-3);
  background: rgb(148 163 184 / 7%);
  border-radius: 5px;
}

.tname {
  font-size: 10px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.more {
  font-size: 11px;
}

.log {
  min-height: 140px;
  max-height: 300px;
  overflow: auto;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px 11px;
  font-size: 11px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}

.kv {
  display: flex;
  gap: 8px;
  font-size: 12px;
}

.kv .k {
  flex: none;
  width: 56px;
  color: var(--text-3);
}

.kv .v {
  min-width: 0;
  color: var(--text-2);
  word-break: break-all;
}

.kv .v em {
  font-style: normal;
  color: var(--warn);
}

.hint {
  font-size: 11.5px;
}

/* ---- [M23] 画布内编辑区 ---- */
.etag {
  font-size: 10.5px;
  color: var(--warn);
  border: 1px solid rgb(251 191 36 / 35%);
  border-radius: 999px;
  padding: 1px 8px;
  font-weight: 400;
}

.efld {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.efl {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--text-2);
}

.edot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warn);
  flex: none;
}

input.ebad {
  border-color: var(--bad);
}

.eerr {
  font-size: 11px;
}

.eflist {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.efrow {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.efk {
  font-size: 11px;
  color: var(--accent-h);
  display: flex;
  align-items: center;
  gap: 4px;
}

.efro {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 5px 8px;
  min-width: 0;
}

.efro-t {
  flex: 1;
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.efro-tag {
  flex: none;
  font-size: 10px;
  color: var(--text-3);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 6px;
}
</style>
