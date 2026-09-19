<script setup lang="ts">
/**
 * 模板配置速查弹层：把 YAML 模板字段/动作/输入类型翻译成通俗说明。
 * 供 TemplatesView「字段速查」按钮打开；内容数据来自 lib/template-dict.ts。
 */
import Modal from '../common/Modal.vue'
import { HELP_GROUPS } from '../../lib/template-dict'

const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <Modal title="模板配置速查（字段说明）" :width="720" @close="emit('close')">
    <p class="lead muted">
      模板是一份 YAML
      说明书：启动时问使用者什么、流水线按什么步骤做什么。下面每个字段都可以组合使用——不需要全部用到。
    </p>
    <section
      v-for="g in HELP_GROUPS"
      :key="g.title"
      class="grp"
      :aria-label="g.title"
    >
      <h3 class="grp-t">{{ g.title }}</h3>
      <p v-if="g.note" class="grp-note">{{ g.note }}</p>
      <ul class="items">
        <li v-for="it in g.items" :key="it.name" class="it">
          <div class="it-h">
            <code class="it-n">{{ it.name }}</code>
            <code v-if="it.example" class="it-ex">{{ it.example }}</code>
          </div>
          <div class="it-d">{{ it.desc }}</div>
        </li>
      </ul>
    </section>
  </Modal>
</template>

<style scoped>
.lead {
  font-size: 12.5px;
  line-height: 1.7;
  margin: 0 0 14px;
}

.grp {
  margin-bottom: 18px;
}

.grp:last-child {
  margin-bottom: 0;
}

.grp-t {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}

.grp-note {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.6;
  margin: 6px 0 2px;
}

.items {
  list-style: none;
  margin: 0;
  padding: 0;
}

.it {
  padding: 7px 2px 8px;
  border-bottom: 1px dashed rgb(148 163 184 / 14%);
}

.it:last-child {
  border-bottom: none;
}

.it-h {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.it-n {
  font-family: var(--mono);
  font-size: 12.5px;
  font-weight: 600;
  color: #a5b4fc;
}

.it-ex {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-3);
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 0 6px;
  line-height: 1.7;
  word-break: break-all;
}

.it-d {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.65;
  margin-top: 3px;
}
</style>
