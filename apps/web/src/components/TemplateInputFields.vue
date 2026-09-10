<script setup lang="ts">
import { ref } from 'vue'
import type { Asset, TemplateDetail } from '../lib/types'

const props = defineProps<{
  tpl: TemplateDetail | null
  /** 项目资产（files 类字段的选择源） */
  assets: Asset[]
  /** 受控值（单组输入） */
  values: Record<string, unknown>
  /** 紧凑模式（批量表单行内：text 单行、files 折叠为计数按钮） */
  dense?: boolean
}>()

const emit = defineEmits<{ change: [key: string, value: unknown] }>()

/** dense 模式下展开的 files 字段 key */
const openKey = ref('')

function textOf(k: string): string {
  const v = props.values[k]
  return typeof v === 'string' ? v : ''
}
function numOf(k: string): string {
  const v = props.values[k]
  return v === undefined || v === '' ? '' : String(v)
}
function picked(k: string): number[] {
  return (props.values[k] as number[] | undefined) ?? []
}
function onText(k: string, e: Event) {
  emit('change', k, (e.target as HTMLTextAreaElement).value)
}
function onNum(k: string, e: Event) {
  emit('change', k, (e.target as HTMLInputElement).value)
}
function toggleAsset(k: string, id: number) {
  const arr = [...picked(k)]
  const i = arr.indexOf(id)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(id)
  emit('change', k, arr)
}
</script>

<template>
  <div class="tif" :class="{ dense }">
    <template v-for="inp in tpl?.inputs ?? []" :key="inp.key">
      <label v-if="inp.kind === 'text'" class="fld">
        {{ inp.label }} <span v-if="inp.required" class="req">*</span>
        <textarea v-if="!dense" :value="textOf(inp.key)" rows="3" @input="onText(inp.key, $event)" />
        <input v-else type="text" :value="textOf(inp.key)" @input="onText(inp.key, $event)" />
      </label>

      <label v-else-if="inp.kind === 'int'" class="fld">
        {{ inp.label }} <span v-if="inp.required" class="req">*</span>
        <input type="number" :value="numOf(inp.key)" @input="onNum(inp.key, $event)" />
      </label>

      <label v-else-if="inp.kind === 'bool'" class="fld row">
        <input
          type="checkbox"
          :checked="values[inp.key] === true"
          @change="emit('change', inp.key, ($event.target as HTMLInputElement).checked)"
        />
        <span>{{ inp.label }}</span>
        <em v-if="inp.default === true" class="muted" style="font-size: 11px">默认开启</em>
      </label>

      <div v-else-if="inp.kind === 'files'" class="fld">
        <template v-if="dense">
          <button type="button" class="btn sm" @click="openKey = openKey === inp.key ? '' : inp.key">
            {{ inp.label }}（{{ picked(inp.key).length }}）
            <span class="caret">{{ openKey === inp.key ? '▴' : '▾' }}</span>
          </button>
          <div v-if="openKey === inp.key" class="picklist">
            <label v-for="a in assets" :key="a.id" class="opt">
              <input type="checkbox" :checked="picked(inp.key).includes(a.id)" @change="toggleAsset(inp.key, a.id)" />
              <span>#{{ a.id }}</span> {{ a.name }}
              <em>{{ a.purpose }}</em>
            </label>
            <div v-if="!assets.length" class="muted">项目暂无资产</div>
          </div>
        </template>
        <template v-else>
          <div class="tlabel">
            {{ inp.label }}
            <span class="muted">（选 {{ picked(inp.key).length }} 项）</span>
          </div>
          <div v-if="assets.length" class="picklist">
            <label v-for="a in assets" :key="a.id" class="opt">
              <input type="checkbox" :checked="picked(inp.key).includes(a.id)" @change="toggleAsset(inp.key, a.id)" />
              <span>#{{ a.id }}</span> {{ a.name }}
              <em>{{ a.purpose }}</em>
            </label>
          </div>
          <div v-else class="muted">项目暂无资产——可先在项目页上传素材。</div>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.caret {
  font-size: 10px;
  color: var(--text-3);
}

.tlabel {
  font-size: 12px;
  color: var(--text-2);
}

.picklist {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 8px;
  margin-top: 5px;
}

.dense .picklist {
  max-height: 150px;
}

.opt {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  padding: 2px 4px;
  cursor: pointer;
}

.opt:hover {
  background: var(--hover);
  border-radius: 5px;
}

.opt em {
  color: var(--text-3);
  font-style: normal;
  margin-left: auto;
  font-size: 11px;
}
</style>
