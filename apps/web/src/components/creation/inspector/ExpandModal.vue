<script setup lang="ts">
/**
 * [M26-split] 检查器「AI 扩写」对照弹窗（自 inspector/index.vue 原样搬出，行为零变更）：
 * 原文 / 可编辑草稿双栏 + 补充要求 + 扩写/应用。状态仍归 useInspectorForm，
 * 经 v-model 双向绑定草稿与补充要求，本组件纯展示 + 事件透传。
 */
import Icon from '../../common/Icon.vue'
import Modal from '../../common/Modal.vue'

defineProps<{
  /** 扩写原文（只读展示） */
  src: string
  /** 扩写错误信息 */
  err: string
  /** 扩写请求进行中 */
  busy: boolean
  /** 执行/删除等外层操作进行中（禁用应用按钮） */
  opBusy: boolean
}>()

/** 草稿与补充要求双向绑定（真源在父级 composable） */
const draft = defineModel<string>('draft', { required: true })
const instruction = defineModel<string>('instruction', { required: true })

const emit = defineEmits<{ close: []; expand: []; apply: [] }>()
</script>

<template>
  <Modal title="AI 扩写" :width="720" @close="emit('close')">
    <div class="exp-body">
      <div class="exp-col">
        <div class="exp-h">原文</div>
        <pre class="exp-pre">{{ src }}</pre>
      </div>
      <div class="exp-col">
        <div class="exp-h">扩写结果（可编辑后应用）</div>
        <textarea
          v-model="draft"
          class="exp-ta"
          rows="10"
          placeholder="点击「开始扩写」生成…"
        />
      </div>
    </div>
    <div class="frow">
      <label class="flabel">补充要求（可选）</label>
      <input
        v-model="instruction"
        type="text"
        placeholder="如：更电影感、补充光影细节、控制在 120 字内…"
        @keydown.enter="emit('expand')"
      />
    </div>
    <div v-if="err" class="err-text">{{ err }}</div>
    <template #footer>
      <button type="button" class="btn" @click="emit('close')">
        关闭
      </button>
      <button type="button" class="btn" :disabled="busy" @click="emit('expand')">
        <Icon name="sparkles" :size="12" />
        {{ busy ? '扩写中…' : draft ? '重新扩写' : '开始扩写' }}
      </button>
      <button
        type="button"
        class="btn primary"
        :disabled="busy || opBusy || !draft.trim()"
        @click="emit('apply')"
      >
        <Icon name="check" :size="12" /> 应用
      </button>
    </template>
  </Modal>
</template>

<style scoped>
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
