<script setup lang="ts">
/**
 * [M26-split] 排产日历 · 新建计划弹窗（自 ScheduleCalendar.vue 原样搬出，行为零变更）：
 * 表单状态与提交逻辑真源留父级（watch 模板加载 / submitForm 校验 / err 同源），本组件纯装配：
 * v-model 透传六个表单字段，操作经 emit 转交；复用全局 Modal（Teleport + backdrop + Esc）。
 */
import { computed } from 'vue'
import Icon from '../../components/common/Icon.vue'
import Modal from '../../components/common/Modal.vue'
import DatePicker from '../../components/common/DatePicker.vue'
import { filterSelectable } from '../../lib/scene'
import type {
  Project,
  TemplateDetail,
  TemplateMeta,
} from '../../lib/types'

const props = defineProps<{
  projects: Project[]
  templates: TemplateMeta[]
  formTemplateDetail: TemplateDetail | null
  formInputsLoading: boolean
  err: string
  creating: boolean
}>()
// [入口收口] 排程选模板不呈现轻松创作批准链模板（无 recipe、到点必失败）
const selectableTpls = computed(() => filterSelectable(props.templates))

const emit = defineEmits<{
  close: []
  submit: []
  'add-group': []
  'remove-group': [idx: number]
}>()

const projectId = defineModel<number | ''>('projectId', { required: true })
const formName = defineModel<string>('formName', { required: true })
const formTemplateKey = defineModel<string>('formTemplateKey', {
  required: true,
})
const formScheduledAt = defineModel<string>('formScheduledAt', {
  required: true,
})
const formNote = defineModel<string>('formNote', { required: true })
const formInputs = defineModel<Array<Record<string, unknown>>>('formInputs', {
  required: true,
})
</script>

<template>
  <!-- 新建弹窗（复用全局 Modal 组件：Teleport + backdrop + Esc层 + 滚动 body） -->
  <Modal title="新建排产计划" :width="640" @close="emit('close')">
    <!-- 基本信息：双列布局 -->
    <div class="form-section">
      <div class="form-row2">
        <label class="fld">
          计划名称
          <input v-model="formName" placeholder="例：每日更新第5集" />
        </label>
        <label class="fld">
          项目 <span class="req">*</span>
          <select v-model="projectId">
            <option value="">请选择</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">
              {{ p.name }}
            </option>
          </select>
        </label>
      </div>
      <div class="form-row2">
        <label class="fld">
          模板
          <select v-model="formTemplateKey">
            <option v-for="t in selectableTpls" :key="t.key" :value="t.key">
              {{ t.name }}
            </option>
          </select>
        </label>
        <label class="fld">
          触发时间 <span class="req">*</span>
          <DatePicker
            v-model="formScheduledAt"
            placeholder="选择日期和时间"
            :with-time="true"
          />
        </label>
      </div>
    </div>

    <!-- 输入数据：动态表单 -->
    <div class="form-section">
      <div class="section-head">
        <span class="section-title">输入数据</span>
        <span class="section-hint">每组对应一次运行</span>
      </div>
      <div v-if="formInputsLoading" class="tpl-loading">加载模板定义中…</div>
      <div v-else-if="!formTemplateDetail?.inputs?.length" class="tpl-hint">
        该模板无输入字段
      </div>
      <div v-else class="tpl-groups">
        <div v-for="(row, ridx) in formInputs" :key="ridx" class="tpl-card">
          <div class="tpl-card-head">
            <span class="tpl-card-num">#{{ ridx + 1 }}</span>
            <button
              v-if="formInputs.length > 1"
              type="button"
              class="tpl-card-del"
              aria-label="删除此组"
              @click="emit('remove-group', ridx)"
            >
              <Icon name="x" :size="12" :stroke-width="2" /> 删除
            </button>
          </div>
          <div class="tpl-card-body">
            <div
              v-for="def in formTemplateDetail!.inputs"
              :key="def.key"
              class="fld-row"
              :class="{
                'fld-wide': def.kind === 'text' || def.kind === 'files',
              }"
            >
              <label class="fld-sm">
                {{ def.label || def.key }}
                <span v-if="def.required" class="req">*</span>
              </label>
              <input
                v-if="def.kind === 'text'"
                v-model="row[def.key]"
                type="text"
                :placeholder="
                  def.default !== undefined ? String(def.default) : ''
                "
              />
              <input
                v-else-if="def.kind === 'int'"
                v-model="row[def.key]"
                type="number"
                step="1"
                :placeholder="
                  def.default !== undefined ? String(def.default) : ''
                "
              />
              <label v-else-if="def.kind === 'bool'" class="toggle">
                <input
                  v-model="row[def.key]"
                  type="checkbox"
                  :true-value="true"
                  :false-value="false"
                />
                <span class="toggle-track"></span>
                <span class="toggle-text">{{
                  row[def.key] ? '是' : '否'
                }}</span>
              </label>
              <input
                v-else-if="def.kind === 'files'"
                v-model="row[def.key]"
                type="text"
                placeholder="资产 id，逗号分隔"
              />
            </div>
          </div>
        </div>
        <button
          type="button"
          class="btn sm ghost tpl-add"
          @click="emit('add-group')"
        >
          <Icon name="plus" :size="12" /> 添加一组
        </button>
      </div>
    </div>

    <!-- 备注 -->
    <label class="fld">
      备注
      <input v-model="formNote" placeholder="可选" />
    </label>

    <div v-if="err" class="err-text" role="alert">{{ err }}</div>

    <template #footer>
      <button class="btn" @click="emit('close')">取消</button>
      <button class="btn primary" :disabled="creating" @click="emit('submit')">
        {{ creating ? '创建中…' : '创建计划' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
/* ── 弹窗表单（随 ScheduleFormModal 拆出） ── */
.form-section {
  margin-bottom: 18px;
}
.form-section:last-of-type {
  margin-bottom: 12px;
}
.section-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.section-hint {
  font-size: 11px;
  color: var(--text-3);
}
.form-row2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 16px;
}
.form-row2 :deep(.dp) {
  margin-top: 5px;
}

/* 模板输入卡片 */
.tpl-loading,
.tpl-hint {
  font-size: 12px;
  color: var(--text-3);
  padding: 12px 0;
}
.tpl-groups {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tpl-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  overflow: hidden;
}
.tpl-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--chip-bg);
  border-bottom: 1px solid var(--border);
}
.tpl-card-num {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
}
.tpl-card-del {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: none;
  border: none;
  color: var(--text-3);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition:
    color 0.15s,
    background 0.15s;
}
.tpl-card-del:hover {
  color: var(--bad);
  background: var(--bad-weak);
}
.tpl-card-body {
  padding: 12px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 14px;
}
.fld-wide {
  grid-column: 1 / -1;
}
.fld-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.fld-sm {
  font-size: 11px;
  color: var(--text-3);
  display: flex;
  align-items: center;
  gap: 3px;
}
.fld-sm .req {
  color: var(--bad);
  font-size: 12px;
}
.fld-row > input[type='text'],
.fld-row > input[type='number'] {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  color: var(--text);
  font-size: 13px;
  transition: border-color 0.15s;
}
.fld-row > input:focus {
  border-color: var(--accent);
  outline: none;
}

/* toggle 开关 */
.toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text);
}
.toggle input[type='checkbox'] {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}
.toggle-track {
  width: 32px;
  height: 18px;
  border-radius: 9px;
  background: var(--border-strong);
  position: relative;
  transition: background 0.2s;
  flex-shrink: 0;
}
.toggle-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.2s;
}
.toggle input:checked + .toggle-track {
  background: var(--accent);
}
.toggle input:checked + .toggle-track::after {
  transform: translateX(14px);
}
.toggle input:focus-visible + .toggle-track {
  box-shadow: 0 0 0 2px var(--accent-weak);
}
.toggle-text {
  font-size: 12px;
  color: var(--text-2);
}

.tpl-add {
  margin-top: 4px;
  align-self: flex-start;
}
.ghost {
  background: none;
  border: 1px dashed var(--border-strong);
  color: var(--text-2);
}
.ghost:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-weak);
}
</style>
