<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import type { PromptsApi } from './use-prompts'

const props = defineProps<{ p: PromptsApi }>()
const { pSelected, pText, pSaving, pErr, pDirty, savePrompt, removePrompt } =
  props.p
</script>

<template>
  <section class="panel editor">
    <div v-if="!pSelected" class="empty" style="padding: 80px 0">
      左侧选择一个提示词开始编辑
    </div>
    <template v-else>
      <div class="ehead">
        <span class="tt mono">{{ pSelected }}</span>
        <span class="badge" :class="pDirty ? 'queued' : 'succeeded'">{{
          pDirty ? '未保存' : '已同步'
        }}</span>
        <div class="acts">
          <button class="btn sm danger" @click="removePrompt(pSelected)">
            <Icon name="trash" :size="12" /> 删除
          </button>
        </div>
      </div>
      <div v-if="pErr" class="err-text">{{ pErr }}</div>
      <div class="edit">
        <div class="ed">
          <textarea
            v-model="pText"
            class="yaml"
            spellcheck="false"
            :aria-label="`${pSelected} 提示词编辑器`"
          ></textarea>
        </div>
      </div>
      <div class="ebar">
        <span class="muted">Markdown 文本 · 保存后模板引用即时指向新内容</span>
        <button
          class="btn primary"
          :disabled="!pDirty || pSaving"
          @click="savePrompt"
        >
          <Icon name="check" :size="13" :stroke-width="2.2" />
          {{ pSaving ? '保存中…' : '保存' }}
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
/* ---------- 编辑器区 ---------- */
.editor {
  flex: 1;
  min-width: 0;
  padding: 14px;
  display: flex;
  flex-direction: column;
  /* 与左侧列表面板（max-height: calc(100vh - 130px)）等高，两栏对齐 */
  height: calc(100vh - 130px);
}

.ehead {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  flex-wrap: wrap;
  flex: none;
}

.ehead .tt {
  font-size: 14.5px;
  font-weight: 700;
}

.ehead .acts {
  margin-left: auto;
  display: inline-flex;
  gap: 8px;
}

.edit {
  display: flex;
  gap: 10px;
  align-items: stretch;
  flex: 1;
  min-height: 0;
}

.ed {
  flex: 1;
  min-width: 0;
  display: flex;
}

textarea.yaml {
  flex: 1;
  width: 100%;
  height: 100%;
  min-height: 0;
  resize: none;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.6;
  tab-size: 2;
  background: var(--code-bg);
}

.ebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  flex: none;
}
</style>
