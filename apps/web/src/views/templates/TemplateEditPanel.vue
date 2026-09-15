<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import type { TemplatesApi } from './use-templates'

const props = defineProps<{ t: TemplatesApi }>()
const { selected, yamlText, validation, validating, saving, dirty, save, onTab } = props.t
</script>

<template>
            <div class="edit">
              <div class="ed">
                <textarea
                  v-model="yamlText"
                  class="yaml"
                  spellcheck="false"
                  :aria-label="`${selected} 模板 YAML 编辑器`"
                  @keydown.tab.prevent="onTab"
                ></textarea>
              </div>
              <div class="lint" aria-live="polite" aria-label="校验结果">
                <div class="lh">校验</div>
                <div v-if="validating" class="muted">校验中…</div>
                <div v-else-if="!dirty" class="lk ok"><Icon name="check" :size="13" :stroke-width="2.4" /> 与文件一致</div>
                <template v-else-if="validation">
                  <div v-if="validation.ok" class="lk ok">
                    <Icon name="check" :size="13" :stroke-width="2.4" /> 校验通过
                    <span v-if="validation.warnings.length" class="muted">（{{ validation.warnings.length }} 警告）</span>
                  </div>
                  <div v-else class="lk bad">
                    <Icon name="x" :size="13" :stroke-width="2.4" /> {{ validation.errors.length }} 项错误
                  </div>
                  <ul v-if="validation.errors.length" class="er">
                    <li v-for="(er, i) in validation.errors" :key="'e' + i">{{ er }}</li>
                  </ul>
                  <ul v-if="validation.warnings.length" class="wr">
                    <li v-for="(w, i) in validation.warnings" :key="'w' + i">{{ w }}</li>
                  </ul>
                </template>
                <div v-else class="muted">编辑后自动校验…</div>
              </div>
            </div>
            <div class="ebar">
              <span class="muted">tab = 2 空格 · 保存由服务端二次校验（原子写，失败保留原文件）</span>
              <button
                class="btn primary"
                :disabled="!dirty || saving || (validation !== null && !validation.ok)"
                @click="save"
              >
                <Icon name="check" :size="13" :stroke-width="2.2" /> {{ saving ? '保存中…' : '保存' }}
              </button>
            </div>
</template>

<style scoped>
.edit {
  display: flex;
  gap: 10px;
  align-items: stretch;
}

.ed {
  flex: 1;
  min-width: 0;
}

textarea.yaml {
  width: 100%;
  height: 430px;
  resize: vertical;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.6;
  tab-size: 2;
  background: var(--code-bg);
}

.lint {
  width: 244px;
  flex: none;
  height: 430px;
  overflow-y: auto;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 11px;
  font-size: 12px;
}

.lint .lh {
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 8px;
  font-size: 12px;
}

.lint .lk {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
}

.lint .lk.ok {
  color: var(--ok);
}

.lint .lk.bad {
  color: var(--bad);
}

.lint ul {
  margin: 8px 0 0;
  padding-left: 16px;
  display: grid;
  gap: 6px;
  word-break: break-word;
}

.lint .er li {
  color: #fca5a5;
}

.lint .wr li {
  color: var(--warn);
}

.ebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
}

</style>
