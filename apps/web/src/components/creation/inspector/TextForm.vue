<script setup lang="ts">
import type { CanvasDocNode } from '../../../lib/types'
import Icon from '../../common/Icon.vue'
import type { InspectorApi, InspectorForm } from './use-inspector-form'

const props = defineProps<{
  node: CanvasDocNode
  form: InspectorForm
  saveText: InspectorApi['saveText']
  openExpand: InspectorApi['openExpand']
}>()
const form = props.form
</script>

<template>
      <!-- ===== [M17] text 节点：文本内容 ===== -->
      <template v-if="node.kind === 'text'">
        <section class="sec">
          <div class="sec-h">文本内容</div>
          <div class="frow">
            <textarea v-model="form.fText" rows="7" placeholder="输入文本…（连到生成节点的「提示词」端口即可作为其提示词）" @blur="saveText" />
          </div>
          <div class="frow-ops">
            <button type="button" class="btn sm" :disabled="form.opBusy || form.expandBusy" title="AI 扩写文本" @click="openExpand">
              <Icon name="sparkles" :size="12" /> AI 扩写
            </button>
            <button type="button" class="btn sm" :disabled="form.opBusy" title="立即保存文本" @click="saveText">
              <Icon name="check" :size="12" /> 保存文本
            </button>
          </div>
          <div class="muted mini">失焦自动保存；提取自生成节点的文本也会落到这里的独立节点。</div>
          <div v-if="node.specError" class="err-text">{{ node.specError }}</div>
        </section>
      </template>
</template>

<style scoped>
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

.mini {
  font-size: 11px;
}

/* ===== [M17] 新增块：frow-ops / notes / vsel / 画廊 / 弹窗 ===== */
.frow-ops {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

</style>
