<script setup lang="ts">
/**
 * [M23] 设计态落盘 Modal 组（草案预览 edit-draft + 保存为新模板 edit-save + 轻提示 toast）
 * views/canvas/index.vue 拆分：M26 红线纯重构，模板/样式逐字搬移。
 * 状态由父级 useCanvasDesign 提供（props 下行 + v-model:save-key + emit 触发既有方法），行为与内联时完全一致。
 */
import type { TemplateValidation } from '../../lib/types'
import Modal from '../../components/common/Modal.vue'
import Icon from '../../components/common/Icon.vue'

defineProps<{
  showDraft: boolean
  draftValidation: TemplateValidation | null
  draftYaml: string
  showSave: boolean
  saveErr: string
  saveBusy: boolean
  toastMsg: string
}>()
const saveKey = defineModel<string>('saveKey', { required: true })
const emit = defineEmits<{
  'close-draft': []
  copy: []
  'save-from-draft': []
  'close-save': []
  save: []
}>()
</script>

<template>
  <!-- [M23] 编辑草案预览（edit-draft；不落盘，仅受控 edits 应用的 YAML） -->
  <Modal
    v-if="showDraft"
    title="编辑草案（不落盘）"
    :width="760"
    @close="emit('close-draft')"
  >
    <div class="ed-body">
      <div class="ed-meta">
        <span
          v-if="draftValidation"
          class="badge"
          :class="draftValidation.ok ? 'succeeded' : 'failed'"
        >
          {{ draftValidation.ok ? '校验通过' : '校验未通过' }}
        </span>
        <span class="muted mini">
          由当前草稿经受控 edits 应用生成（标题 / 输入文本 /
          调度依赖）；落盘请用「保存为新模板」，原模板文件零改动。
        </span>
      </div>
      <ul v-if="draftValidation && draftValidation.errors.length" class="prob">
        <li v-for="(e2, i) in draftValidation.errors" :key="i">{{ e2 }}</li>
      </ul>
      <ul
        v-if="draftValidation && draftValidation.warnings.length"
        class="warnlist"
      >
        <li v-for="(w, i) in draftValidation.warnings" :key="i">{{ w }}</li>
      </ul>
      <pre class="yaml mono">{{ draftYaml }}</pre>
    </div>
    <template #footer>
      <button type="button" class="btn" @click="emit('close-draft')">
        关闭
      </button>
      <button type="button" class="btn" @click="emit('copy')">
        <Icon name="copy" :size="12" /> 复制 YAML
      </button>
      <button
        type="button"
        class="btn primary"
        @click="emit('save-from-draft')"
      >
        <Icon name="download" :size="12" /> 保存为新模板
      </button>
    </template>
  </Modal>

  <!-- [M23] 保存为新模板（edit-save；key 冲突自动后缀避让） -->
  <Modal
    v-if="showSave"
    title="保存为新模板"
    :width="520"
    @close="emit('close-save')"
  >
    <label class="fld">
      新模板 key（字母/数字/下划线/中划线；冲突自动加后缀）
      <input
        v-model="saveKey"
        type="text"
        spellcheck="false"
        placeholder="xxx-edit"
        @keydown.enter="emit('save')"
      />
    </label>
    <div class="muted mini" style="margin-bottom: 8px">
      保存内容 = 原模板 + 当前草稿（标题 / 输入文本 /
      调度依赖）；原模板文件不会被修改。
    </div>
    <div v-if="saveErr" class="err-text">{{ saveErr }}</div>
    <template #footer>
      <button type="button" class="btn" @click="emit('close-save')">
        取消
      </button>
      <button
        type="button"
        class="btn primary"
        :disabled="saveBusy || !saveKey.trim()"
        @click="emit('save')"
      >
        <Icon name="download" :size="12" /> {{ saveBusy ? '保存中…' : '保存' }}
      </button>
    </template>
  </Modal>

  <!-- [M23] 轻提示（连线拒绝 / 落盘结果） -->
  <div v-if="toastMsg" class="toast-m23" role="status">{{ toastMsg }}</div>
</template>

<style scoped>
/* ===== [M23] 草案/保存 Modal 内体 + 轻提示 ===== */
.ed-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ed-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mini {
  font-size: 11px;
  line-height: 1.6;
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

.toast-m23 {
  position: fixed;
  left: 50%;
  bottom: 26px;
  transform: translateX(-50%);
  z-index: 120;
  max-width: min(560px, 86vw);
  background: rgb(15 23 42 / 93%);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  padding: 8px 16px;
  font-size: 12.5px;
  color: var(--text);
  box-shadow: 0 10px 26px rgb(0 0 0 / 40%);
}
</style>
