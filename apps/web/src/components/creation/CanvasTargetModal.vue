<script setup lang="ts">
/**
 * 送入创作画布（跨模块联动；spec §2.8）
 * - 列出项目画布（可新建）→ 把当前步骤产物批量落为目标画布的素材节点（网格错位摆放）
 * - 完成后 emit done(canvasId)（父级负责提示并跳转 /creation）
 */
import { computed, onMounted, ref } from 'vue'
import { creationApi } from '../../lib/api'
import type { CanvasListItem } from '../../lib/types'
import Icon from '../common/Icon.vue'
import Modal from '../common/Modal.vue'

const props = defineProps<{
  projectId: number
  assets: Array<{ id: number; name: string }>
}>()
const emit = defineEmits<{ done: [canvasId: number]; close: [] }>()

const list = ref<CanvasListItem[]>([])
const selId = ref<number | null>(null)
const newName = ref('')
const loading = ref(false)
const busy = ref(false)
const err = ref('')

const selName = computed(
  () => list.value.find((c) => c.id === selId.value)?.name ?? '',
)

async function load(): Promise<void> {
  loading.value = true
  err.value = ''
  try {
    const r = await creationApi.list(props.projectId)
    list.value = r.items
    const first = r.items[0]
    if (selId.value == null && first) selId.value = first.id
    if (selId.value != null && !r.items.some((c) => c.id === selId.value))
      selId.value = first?.id ?? null
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
onMounted(() => void load())

async function createNew(): Promise<void> {
  busy.value = true
  err.value = ''
  try {
    const r = await creationApi.create(
      props.projectId,
      newName.value.trim() || undefined,
    )
    newName.value = ''
    await load()
    selId.value = r.canvas.id
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function submit(): Promise<void> {
  const canvasId = selId.value
  if (canvasId == null || !props.assets.length) return
  busy.value = true
  err.value = ''
  try {
    for (let i = 0; i < props.assets.length; i++) {
      const item = props.assets[i]
      if (!item) continue
      await creationApi.addNode(canvasId, {
        kind: 'asset',
        assetId: item.id,
        x: 60 + (i % 3) * 280,
        y: 60 + Math.floor(i / 3) * 220,
      })
    }
    emit('done', canvasId)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal title="送入创作画布" :width="540" @close="emit('close')">
    <div class="ct-body">
      <div class="muted mini">
        将
        {{ assets.length }}
        项产物作为素材节点放入目标画布（可在创作画布中继续引用 / 编辑 / 生成）：
      </div>

      <div v-if="loading" class="muted">画布列表加载中…</div>
      <div v-else-if="!list.length" class="muted">
        该项目暂无画布，先新建一个：
      </div>
      <div v-else class="ct-list">
        <button
          v-for="c in list"
          :key="c.id"
          type="button"
          class="ct-item"
          :class="{ on: c.id === selId }"
          @click="selId = c.id"
        >
          <Icon name="wand" :size="13" />
          <span class="ct-name">{{ c.name }}</span>
          <span class="muted mini">{{ c.nodeCount }} 节点</span>
        </button>
      </div>

      <div class="ct-new">
        <input
          v-model="newName"
          type="text"
          placeholder="新画布名称（留空 = 未命名画布）"
          @keydown.enter="createNew"
        />
        <button
          type="button"
          class="btn sm"
          :disabled="busy"
          @click="createNew"
        >
          <Icon name="plus" :size="12" /> 新建
        </button>
      </div>

      <div v-if="err" class="err-text">{{ err }}</div>
    </div>

    <template #footer>
      <button type="button" class="btn" :disabled="busy" @click="emit('close')">
        取消
      </button>
      <button
        type="button"
        class="btn primary"
        :disabled="busy || selId == null || !assets.length"
        @click="submit"
      >
        <Icon name="wand" :size="12" />
        {{ busy ? '送入中…' : `送入「${selName || '…'}」` }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.ct-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mini {
  font-size: 11.5px;
}

.ct-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 260px;
  overflow-y: auto;
}

.ct-item {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--code-bg);
  color: var(--text);
  padding: 7px 11px;
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
}

.ct-item:hover {
  border-color: var(--accent);
}

.ct-item.on {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgb(99 102 241 / 26%);
}

.ct-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.ct-new {
  display: flex;
  gap: 8px;
}

.ct-new input {
  flex: 1;
  font-size: 12.5px;
}
</style>
