<script setup lang="ts">
/**
 * 新建问题表单（面板子组件）：类别/严重度/范围/备注。
 * 纯展示 + 本地联动（类别收窄范围），提交与状态由父面板负责。
 */
import { computed } from 'vue'
import {
  CATEGORY_TEXT,
  allowedScopes,
  type FindingFormState,
  type FindingSegment,
} from './finding-ui'

const form = defineModel<FindingFormState>({ required: true })

const props = defineProps<{
  segments: FindingSegment[]
  acting: boolean
  needsShot: boolean
  formatMs: (ms: number) => string
}>()

const emit = defineEmits<{ submit: []; cancel: [] }>()

/** 由本次表单的类别本地推算：props.scopes 在 v-model 更新后同 tick 仍是旧值 */
const scopes = computed(() => allowedScopes(form.value.category))

const canSubmit = computed(
  () =>
    !props.acting &&
    !!form.value.note.trim() &&
    (!props.needsShot || !!form.value.shotId),
)

function onCategoryChange(): void {
  if (!scopes.value.includes(form.value.scopeKind))
    form.value.scopeKind = scopes.value[0]!
}
</script>

<template>
  <div class="form">
    <div class="frow">
      <select v-model="form.category" @change="onCategoryChange">
        <option v-for="(t, k) in CATEGORY_TEXT" :key="k" :value="k">
          {{ t }}
        </option>
      </select>
      <select v-model="form.severity">
        <option value="blocker">阻断</option>
        <option value="major">重要</option>
        <option value="minor">轻微</option>
      </select>
    </div>
    <div class="frow">
      <select v-model="form.scopeKind">
        <option v-if="scopes.includes('shot')" value="shot">当前镜头</option>
        <option v-if="scopes.includes('time')" value="time">时间窗</option>
        <option v-if="scopes.includes('global')" value="global">全片</option>
      </select>
      <select v-if="needsShot" v-model="form.shotId">
        <option value="" disabled>选择镜头</option>
        <option
          v-for="s in segments"
          :key="s.shotId ?? s.startMs"
          :value="s.shotId ?? ''"
        >
          {{ s.shotId ?? '—' }}（{{ formatMs(s.startMs) }}–{{
            formatMs(s.endMs)
          }}）
        </option>
      </select>
      <template v-if="form.scopeKind === 'time'">
        <input v-model.number="form.startMs" type="number" min="0" step="100" />
        –
        <input v-model.number="form.endMs" type="number" min="0" step="100" />
      </template>
    </div>
    <textarea
      v-model="form.note"
      rows="2"
      maxlength="2000"
      placeholder="描述问题（必填，≤2000 字）"
    />
    <div class="frow end">
      <button class="btn sm" @click="emit('cancel')">取消</button>
      <button
        class="btn sm primary"
        :disabled="!canSubmit"
        @click="emit('submit')"
      >
        记录问题
      </button>
    </div>
  </div>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 6px 0 8px;
}
.frow {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.frow.end {
  justify-content: flex-end;
}
.form select,
.form input,
.form textarea {
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid rgb(148 163 184 / 25%);
  background: var(--bg);
  color: inherit;
}
.form textarea {
  width: 100%;
  resize: vertical;
}
</style>
