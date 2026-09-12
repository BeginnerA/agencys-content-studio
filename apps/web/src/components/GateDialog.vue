<script setup lang="ts">
import { ref, computed } from 'vue'
import MarkdownPreview from './MarkdownPreview.vue'
import { confirmDialog } from '../lib/confirm'

const props = defineProps<{
  stepTitle: string
  message: string
  /** 产物全文（可编辑覆盖） */
  artifactText?: string
  artifactName?: string
  /** [M2] 模板声明 skip_label 后显示「跳过」按钮（免审放行、产物保留） */
  skipLabel?: string
  busy?: boolean
}>()

const emit = defineEmits<{
  decided: [action: 'approve' | 'reject' | 'skip' | 'abort', payload: { note?: string; textOverride?: string }]
}>()

const tab = ref<'view' | 'edit'>('view')
const edited = ref(props.artifactText ?? '')
const note = ref('')

const showEdit = computed(() => !!props.artifactText && tab.value === 'edit')

function approve() {
  emit('decided', 'approve', {
    textOverride: showEdit.value && edited.value !== props.artifactText ? edited.value : undefined,
  })
}

function reject() {
  if (!note.value.trim()) {
    alert('驳回需填写修改意见（将注入重跑的 LLM 输入）')
    return
  }
  emit('decided', 'reject', { note: note.value.trim() })
}

/** [M2] 免审放行：产物保留直接通过（模板声明 skip_label 才出现此按钮） */
function skip() {
  emit('decided', 'skip', {})
}

async function abort() {
  const ok = await confirmDialog({
    title: '中止运行',
    message: '确认中止该运行？当前步骤产物保留，run 置 cancelled。',
    confirmText: '中止运行',
    danger: true,
  })
  if (ok) emit('decided', 'abort', {})
}
</script>

<template>
  <div class="gate panel">
    <div class="ghead">
      <div class="tt">
        <span class="dot" /> 人工闸门 · {{ stepTitle }}
      </div>
      <div class="act">
        <button class="btn sm" :disabled="busy" @click="abort">中止</button>
        <button v-if="skipLabel" class="btn sm skip" :disabled="busy" @click="skip">{{ skipLabel }}</button>
        <button class="btn sm ok" :disabled="busy" @click="approve">批准继续</button>
        <button class="btn sm danger" :disabled="busy" @click="reject">驳回重跑</button>
      </div>
    </div>

    <div class="msg">{{ message }}</div>

    <template v-if="artifactText">
      <div class="tabs">
        <button :class="{ on: tab === 'view' }" @click="tab = 'view'">预览产物</button>
        <button :class="{ on: tab === 'edit' }" @click="tab = 'edit'">审阅修改</button>
      </div>
      <div v-if="tab === 'view'" class="doc">
        <MarkdownPreview :source="artifactText" />
      </div>
      <div v-else class="doc">
        <div class="muted" style="margin-bottom: 6px">
          修改后文本将覆盖产物再继续（不改则原样通过）。{{ artifactName }}
        </div>
        <textarea v-model="edited" rows="18" class="editor mono" />
      </div>
    </template>

    <div v-if="!artifactText" class="muted" style="padding: 10px 0 4px">
      本步骤无可预览文本产物，直接批准、跳过或驳回。
    </div>

    <div v-if="skipLabel" class="muted" style="padding: 2px 0 0; font-size: 11.5px">
      「{{ skipLabel }}」= 免审放行：产物保留并继续下游，不产生修改。
    </div>

    <div class="note-row">
      <input v-model="note" type="text" placeholder="驳回意见（可选，批准/跳过时忽略）：指出要修改的点…" />
    </div>
  </div>
</template>

<style scoped>
.gate {
  border-left: 3px solid var(--warn);
  padding: 12px 16px;
  margin-bottom: 14px;
  background: linear-gradient(90deg, rgb(245 158 11 / 6%), transparent 42%);
}

.ghead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.tt {
  font-weight: 600;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 7px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--warn);
  animation: pulse 1.4s infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

.act {
  display: flex;
  gap: 8px;
}

/* [M2] 免审放行：中性次主按钮（介于批准与驳回之间） */
.btn.skip {
  border-color: rgb(148 163 184 / 32%);
  color: #b9c7dc;
}

.btn.skip:hover {
  border-color: rgb(165 180 252 / 55%);
  color: #c7d2fe;
  background: var(--accent-weak);
}

.msg {
  margin: 10px 0 4px;
  font-size: 13px;
  color: var(--text-2);
  background: var(--warn-weak);
  padding: 8px 12px;
  border-radius: 8px;
}

.tabs {
  display: flex;
  gap: 4px;
  margin: 10px 0 8px;
}

.tabs button {
  border: 1px solid transparent;
  background: none;
  font-size: 12px;
  padding: 4px 13px;
  border-radius: 999px;
  cursor: pointer;
  color: var(--text-2);
  transition: all 0.15s;
}

.tabs button:hover {
  color: #fff;
  background: var(--hover);
}

.tabs button.on {
  background: var(--accent-weak);
  border-color: rgb(99 102 241 / 45%);
  color: #a5b4fc;
}

.doc {
  max-height: 46vh;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 16px;
  background: var(--code-bg);
}

.editor {
  border: none;
  outline: none;
  width: 100%;
  font-size: 12.5px;
  line-height: 1.7;
  background: transparent;
  color: var(--text);
  padding: 0;
}

.note-row {
  margin-top: 10px;
}
</style>
