<script setup lang="ts">
import type { CanvasDocNode } from '../../../lib/types'
import Icon from '../../common/Icon.vue'
import { ENT_KIND_LABEL } from './internals'
import type { InspectorApi, InspectorForm } from './use-inspector-form'

const props = defineProps<{
  node: CanvasDocNode
  form: InspectorForm
  toggleEntities: InspectorApi['toggleEntities']
  attachTo: InspectorApi['attachTo']
}>()
const form = props.form
</script>

<template>
  <!-- ===== 联动：设为实体参考图 ===== -->
  <section v-if="node.assetId != null" class="sec">
    <div class="sec-h">联动</div>
    <button
      type="button"
      class="btn sm"
      :disabled="node.assetId == null"
      @click="toggleEntities"
    >
      <Icon name="link" :size="12" />
      {{ form.entOpen ? '收起' : '设为实体参考图…' }}
    </button>
    <template v-if="form.entOpen">
      <div class="frow">
        <label class="flabel">实体类型</label>
        <select v-model="form.entKind">
          <option value="character">角色</option>
          <option value="scene">场景</option>
          <option value="prop">道具</option>
        </select>
      </div>
      <div v-if="form.entLoading" class="muted">加载中…</div>
      <div v-else-if="!form.entList.length" class="muted">
        该项目下暂无{{ ENT_KIND_LABEL[form.entKind] }}实体
      </div>
      <div v-else class="entlist">
        <button
          v-for="e in form.entList"
          :key="e.id"
          type="button"
          class="entitem"
          :disabled="form.entBusy === e.id"
          :title="`把产物 #${node.assetId} 挂为该实体的参考图`"
          @click="attachTo(e)"
        >
          <span class="entname">{{ e.name }}</span>
          <span class="muted mini"
            >{{ e.refAssets?.length ?? 0 }} 张参考图</span
          >
        </button>
      </div>
      <div v-if="form.entErr" class="err-text">{{ form.entErr }}</div>
    </template>
  </section>
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

.entlist {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
  overflow-y: auto;
}

.entitem {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--code-bg);
  color: var(--text);
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}

.entitem:hover {
  border-color: var(--accent);
}

.entname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
