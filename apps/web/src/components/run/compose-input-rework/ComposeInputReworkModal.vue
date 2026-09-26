<script setup lang="ts">
/**
 * 合成输入本地返修弹窗（切片2 §6 受控闸）：表单本地收集变更（不预先直写草稿）→ 服务端结构化预览
 * （逐处旧→新 + 影响 + 成本诚实 + 风险，零执行）→ 原子确认（本地续跑、零付费、旧 gate 作废必复审）。
 * 预览/影响/费用/过期一律展示后端返回值，前端零推算（规格 §4/§9）。能力不支持时显示真实原因，不伪造可编辑态。
 * 仅覆盖真实 ComposeConfig 字段（转场/时长/BGM·SFX 音量/BGM 淡入/字幕烧录 + BGM 换绑/移除 + 逐镜音效换绑/移除）；
 * clamp/枚举/assetId 归属/同步骤候选由服务端真源裁决，非法变更在预览期 fail closed。
 */
import { computed, ref, toRef } from 'vue'
import Modal from '../../common/Modal.vue'
import Icon from '../../common/Icon.vue'
import { useComposeInputRework } from './use-compose-input-rework'
import type { ComposeInputDiffView } from '../../../lib/types/rework'

const props = defineProps<{ runId: number; projectId: number; stepKey?: string }>()
const emit = defineEmits<{ close: []; applied: [requestId: string] }>()

const {
  capability, baseBgm, baseSfx, candidates, form, loading, submitting, applying, loadError, previewError,
  preview, supported, dirty, changeCount, load, onFormEdited, requestPreview, applyConfirmed, guardClose,
} = useComposeInputRework(toRef(props, 'runId'), computed(() => props.stepKey), computed(() => props.projectId), {
  onApplied: (id) => emit('applied', id),
})

const appliedNote = ref('')

const TRANSITIONS: Array<{ value: string; label: string }> = [
  { value: 'none', label: '无转场' },
  { value: 'fade', label: '淡入淡出' },
  { value: 'fadeblack', label: '经黑场淡入' },
  { value: 'slideleft', label: '左滑' },
  { value: 'slideright', label: '右滑' },
  { value: 'dissolve', label: '溶解' },
]

const FIELD_LABELS: Record<string, string> = {
  transition: '转场',
  transition_duration: '转场时长（秒）',
  bgm_volume: 'BGM 音量',
  bgm_fade: 'BGM 淡入（秒）',
  sfx_volume: '音效音量',
  subtitleBurn: '字幕烧录',
}

function fieldLabel(d: ComposeInputDiffView): string {
  if (d.kind === 'bgm') return 'BGM 配乐'
  if (d.kind === 'sfx') return `音效 · ${d.field}`
  return FIELD_LABELS[d.field] ?? d.field
}

function assetLabel(id: unknown): string {
  if (id === null || id === undefined) return '（无）'
  const c = candidates.value.find((a) => a.id === id)
  if (c) return c.name
  const s = baseSfx.value.find((x) => x.assetId === id)
  if (s) return s.name || `#${String(id)}`
  return `#${String(id)}`
}

/** diff 值显示：布尔→开/关；bgm/sfx/选片数字→资产名；其余原样 */
function fmtVal(d: ComposeInputDiffView, v: unknown): string {
  if (v === null || v === undefined) return '（无）'
  if (typeof v === 'boolean') return v ? '开' : '关'
  if ((d.kind === 'bgm' || d.kind === 'sfx' || d.kind === 'shot-select') && typeof v === 'number') return assetLabel(v)
  return String(v)
}

async function onClose() {
  if (!(await guardClose())) return
  emit('close')
}

async function onApply() {
  const ok = await applyConfirmed()
  if (ok) appliedNote.value = '已确认：新版本已登记，本地重合成已入队，旧成片批准已作废待复审'
}

function chooseBgm(v: number | 'keep' | 'remove') {
  form.value.bgmChoice = v
  onFormEdited()
}

/** 逐镜音效下拉：'keep' | 'remove' | String(assetId) → 回写归一化到 BgmChoice 语义 */
function sfxSelectValue(shotId: string): string {
  const c = form.value.sfxChoices[shotId]
  if (c === undefined || c === 'keep') return 'keep'
  if (c === 'remove') return 'remove'
  return String(c)
}

function onSfxSelect(shotId: string, raw: string) {
  form.value.sfxChoices = {
    ...form.value.sfxChoices,
    [shotId]: raw === 'keep' ? 'keep' : raw === 'remove' ? 'remove' : Number(raw),
  }
  onFormEdited()
}

load()
</script>

<template>
  <Modal title="合成输入受控返修" :width="720" @close="onClose">
    <div v-if="loading" class="crw-state">加载中…</div>
    <div v-else-if="loadError" class="crw-state">
      <div class="crw-bad">{{ loadError }}</div>
      <button class="btn" @click="load()">重试</button>
    </div>
    <div v-else-if="!supported" class="crw-state" role="alert">
      <div class="crw-bad">{{ capability?.message || '当前运行不支持合成输入受控返修' }}</div>
      <div class="crw-hint">原因码：{{ capability?.code }}。返修只在有可返修成片且依赖可复验时开放；无成片请用「合成设置」直接保存草稿。</div>
      <button class="btn" @click="load()">重新检查</button>
    </div>
    <div v-else class="crw-body">
      <!-- ===== 合成配置（真实 _compose 字段） ===== -->
      <section class="crw-sec">
        <div class="crw-lb"><Icon name="crop" :size="12" /> 合成配置</div>
        <div class="crw-grid">
          <label class="crw-field">
            <span>转场</span>
            <select v-model="form.transition" :disabled="submitting || applying" @change="onFormEdited()">
              <option v-for="o in TRANSITIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </label>
          <label class="crw-field">
            <span>转场时长（0.1–2 秒）</span>
            <input v-model.number="form.transitionDuration" type="number" min="0.1" max="2" step="0.1" :disabled="submitting || applying" @input="onFormEdited()" />
          </label>
          <label class="crw-field">
            <span>BGM 音量（{{ Math.round(form.bgmVolume * 100) }}%）</span>
            <input v-model.number="form.bgmVolume" type="range" min="0" max="1" step="0.05" :disabled="submitting || applying" @input="onFormEdited()" />
          </label>
          <label class="crw-field">
            <span>BGM 淡入（0–2 秒）</span>
            <input v-model.number="form.bgmFade" type="number" min="0" max="2" step="0.1" :disabled="submitting || applying" @input="onFormEdited()" />
          </label>
          <label class="crw-field">
            <span>音效音量（{{ Math.round(form.sfxVolume * 100) }}%）</span>
            <input v-model.number="form.sfxVolume" type="range" min="0" max="2" step="0.05" :disabled="submitting || applying" @input="onFormEdited()" />
          </label>
          <label class="crw-check">
            <input v-model="form.subtitleBurn" type="checkbox" :disabled="submitting || applying" @change="onFormEdited()" />
            <span>成片烧录字幕</span>
          </label>
        </div>
      </section>

      <!-- ===== BGM 换绑 / 移除（已存在项目音频；不在此上传新素材） ===== -->
      <section class="crw-sec">
        <div class="crw-lb"><Icon name="speaker-wave" :size="12" /> 配乐（BGM）</div>
        <div class="crw-cur">
          当前：{{ baseBgm.name || '（无）' }}
          <span v-if="form.bgmChoice === 'remove'" class="crw-tag danger">将移除</span>
          <span v-else-if="typeof form.bgmChoice === 'number'" class="crw-tag">将换绑 → {{ assetLabel(form.bgmChoice) }}</span>
        </div>
        <div class="crw-btnrow">
          <button class="btn sm" :class="{ primary: form.bgmChoice === 'keep' }" :disabled="submitting || applying" @click="chooseBgm('keep')">保持当前</button>
          <button class="btn sm danger" :class="{ primary: form.bgmChoice === 'remove' }" :disabled="submitting || applying || baseBgm.assetId === null" @click="chooseBgm('remove')">移除 BGM</button>
        </div>
        <div v-if="candidates.length" class="crw-list">
          <div v-for="a in candidates" :key="a.id" class="crw-item">
            <Icon name="speaker-wave" :size="13" />
            <span class="crw-nm" :title="a.name">{{ a.name }}</span>
            <span class="grow" />
            <button
              class="btn sm"
              :class="{ primary: form.bgmChoice === a.id }"
              :disabled="submitting || applying"
              @click="chooseBgm(a.id)"
            >
              {{ form.bgmChoice === a.id ? '已选' : '选用' }}
            </button>
          </div>
        </div>
        <div v-else class="crw-hint">项目内暂无可换绑的音频素材（上传新素材请在「合成设置」走原绑定路径，不进入本返修闸）。</div>
      </section>

      <!-- ===== 逐镜音效（per-shot SFX）换绑 / 移除（仅当前已绑音效的镜；不在此新增） ===== -->
      <section v-if="baseSfx.length" class="crw-sec">
        <div class="crw-lb"><Icon name="speaker-wave" :size="12" /> 镜头音效（SFX）</div>
        <div class="crw-hint">仅列出当前已绑定音效的镜头——可换成项目内其它音频或移除；新增音效请走「合成设置 / 镜头工作台」的原绑定路径。</div>
        <div class="crw-sfx">
          <div v-for="s in baseSfx" :key="s.shotId" class="crw-sfxrow">
            <span class="crw-sfxnm" :title="s.shotId">{{ s.name || s.shotId }}</span>
            <select
              class="crw-sfxsel"
              :value="sfxSelectValue(s.shotId)"
              :disabled="submitting || applying"
              @change="onSfxSelect(s.shotId, ($event.target as HTMLSelectElement).value)"
            >
              <option value="keep">保持当前音效</option>
              <option value="remove">移除音效</option>
              <option v-for="a in candidates" :key="a.id" :value="String(a.id)" :disabled="a.id === s.assetId">换成：{{ a.name }}</option>
            </select>
          </div>
        </div>
      </section>

      <div class="crw-actions">
        <button class="btn btn-primary" :disabled="!dirty || submitting || applying" @click="requestPreview()">
          {{ submitting ? '预览请求中…' : '预览变更（' + changeCount + '）' }}
        </button>
      </div>

      <div v-if="previewError" class="crw-bad crw-live" role="alert">{{ previewError }}</div>
      <p v-if="appliedNote && !preview" class="crw-ok" role="status">{{ appliedNote }}</p>

      <section v-if="preview" class="crw-preview" aria-label="变更预览">
        <h4 class="crw-h4">变更确认</h4>
        <ul class="crw-diffs">
          <li v-for="(d, i) in preview.diffs" :key="i">
            <b>{{ fieldLabel(d) }}</b>
            <span class="crw-before">{{ fmtVal(d, d.before) }}</span>
            →
            <span class="crw-after">{{ fmtVal(d, d.after) }}</span>
          </li>
        </ul>
        <ul class="crw-impact">
          <li>本地重新合成：0 次模型调用、不产生用量计费，但需编码时间</li>
          <li v-if="preview.impact.resetSteps.length">重置步骤：{{ preview.impact.resetSteps.join('、') }}</li>
          <li v-if="preview.impact.keepNotes.length">保留：{{ preview.impact.keepNotes.join('；') }}</li>
          <li>新版本需重新复核：旧成片批准不自动沿用</li>
        </ul>
        <ul v-if="preview.risks.length" class="crw-risks">
          <li v-for="(risk, i) in preview.risks" :key="i">提示：{{ risk }}</li>
        </ul>
        <button class="btn btn-primary" :disabled="applying || submitting" @click="onApply">
          {{ applying ? '确认提交中…' : '确认并本地重合成' }}
        </button>
      </section>
    </div>

    <template #footer>
      <span class="crw-tip">变更在确认前不落库；未确认直接关闭不影响现有成片</span>
      <button class="btn" @click="onClose">关闭</button>
    </template>
  </Modal>
</template>

<style scoped>
.crw-state {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
  padding: 12px 0;
  font-size: 13px;
}
.crw-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 13px;
}
.crw-sec {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.crw-lb {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 12.5px;
}
.crw-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 16px;
}
.crw-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-2);
}
.crw-field select,
.crw-field input[type='number'] {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font-size: 13px;
}
.crw-field input[type='range'] {
  width: 100%;
}
.crw-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: center;
  cursor: pointer;
  font-size: 12.5px;
}
.crw-cur {
  font-size: 12.5px;
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 8px;
}
.crw-tag {
  padding: 1px 7px;
  border-radius: 6px;
  background: var(--accent-weak);
  color: var(--accent-h);
  font-size: 11.5px;
}
.crw-tag.danger {
  background: color-mix(in srgb, var(--bad) 12%, transparent);
  color: var(--bad);
}
.crw-btnrow {
  display: flex;
  gap: 8px;
}
.crw-sfx {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
}
.crw-sfxrow {
  display: flex;
  align-items: center;
  gap: 10px;
}
.crw-sfxnm {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--text-2);
}
.crw-sfxsel {
  flex: 0 0 auto;
  min-width: 180px;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font-size: 12.5px;
}
.crw-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 200px;
  overflow-y: auto;
}
.crw-item {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 10px;
}
.crw-nm {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grow {
  flex: 1;
}
.crw-actions {
  display: flex;
  justify-content: flex-end;
}
.crw-bad {
  color: var(--bad);
  font-size: 13px;
}
.crw-ok {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-2);
  font-size: 13px;
}
.crw-hint {
  color: var(--text-3);
  font-size: 12px;
}
.crw-live {
  padding: 8px 10px;
  border: 1px solid var(--bad);
  border-radius: 8px;
}
.crw-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-2);
  font-size: 13px;
}
.crw-h4 {
  margin: 0;
  font-size: 13px;
}
.crw-diffs,
.crw-impact,
.crw-risks {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.crw-before {
  text-decoration: line-through;
  color: var(--text-3);
  margin: 0 6px;
}
.crw-after {
  color: var(--bad);
  font-weight: 600;
}
.crw-risks li {
  color: var(--text-3);
}
.crw-tip {
  margin-right: auto;
  font-size: 11.5px;
  color: var(--text-3);
}
@media (max-width: 720px) {
  .crw-grid {
    grid-template-columns: 1fr;
  }
}
</style>
