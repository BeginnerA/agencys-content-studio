<script setup lang="ts">
import { computed, ref } from 'vue'
import Modal from '../common/Modal.vue'
import Icon from '../common/Icon.vue'
import { exportApi } from '../../lib/api'
import type { ExportAssetLite, RunAssetLite } from '../../lib/types'
import { fmtSize, purposeText, KIND_TEXT } from '../../lib/format'

const props = defineProps<{ runId: number }>()
const emit = defineEmits<{ done: [assetId: number]; close: [] }>()

const loading = ref(true)
const err = ref('')
const assets = ref<RunAssetLite[]>([])
const selected = ref<Set<number>>(new Set())
const name = ref('')
const busy = ref(false)
const result = ref<ExportAssetLite | null>(null)

/** 按 purpose 分组（保持资产序） */
const groups = computed(() => {
  const map = new Map<string, RunAssetLite[]>()
  for (const a of assets.value) {
    const key = a.purpose ?? 'other'
    const arr = map.get(key) ?? []
    arr.push(a)
    map.set(key, arr)
  }
  return [...map.entries()].map(([purpose, items]) => ({ purpose, items }))
})

const allChecked = computed(() => assets.value.length > 0 && selected.value.size === assets.value.length)
const totalSize = computed(() =>
  assets.value.filter((a) => selected.value.has(a.id)).reduce((n, a) => n + (a.fileSize ?? 0), 0),
)

function toggle(id: number) {
  const s = new Set(selected.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  selected.value = s
}

function toggleGroup(items: RunAssetLite[]) {
  const s = new Set(selected.value)
  const allIn = items.every((a) => s.has(a.id))
  for (const a of items) {
    if (allIn) s.delete(a.id)
    else s.add(a.id)
  }
  selected.value = s
}

function toggleAll() {
  selected.value = allChecked.value ? new Set() : new Set(assets.value.map((a) => a.id))
}

async function submit() {
  if (!selected.value.size) {
    err.value = '至少勾选 1 个资产'
    return
  }
  busy.value = true
  err.value = ''
  try {
    const res = await exportApi.create(props.runId, {
      name: name.value.trim() || undefined,
      asset_ids: [...selected.value],
    })
    result.value = res.asset
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function init() {
  loading.value = true
  try {
    const res = await exportApi.runAssets(props.runId)
    assets.value = res.items
    selected.value = new Set(res.items.map((a) => a.id)) // 默认全选
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
init()
</script>

<template>
  <Modal title="导出发布包" :width="640" @close="emit('close')">
    <div v-if="loading" class="empty">加载中…</div>

    <template v-else-if="!result">
      <div v-if="!assets.length" class="empty">该 run 暂无产物——执行步骤产出资产后可导出</div>
      <template v-else>
        <div class="bar">
          <label class="all">
            <input type="checkbox" :checked="allChecked" @change="toggleAll" />
            全选（{{ selected.size }}/{{ assets.length }}）
          </label>
          <span class="muted">共 {{ fmtSize(totalSize) }}</span>
        </div>

        <div class="groups">
          <div v-for="g in groups" :key="g.purpose" class="group">
            <div class="gh">
              <label class="all">
                <input
                  type="checkbox"
                  :checked="g.items.every((a) => selected.has(a.id))"
                  @change="toggleGroup(g.items)"
                />
                {{ purposeText(g.purpose) }}
              </label>
              <span class="muted">{{ g.items.length }} 项</span>
            </div>
            <label v-for="a in g.items" :key="a.id" class="item">
              <input type="checkbox" :checked="selected.has(a.id)" @change="toggle(a.id)" />
              <span class="nm">{{ a.name }}</span>
              <span class="chip">{{ KIND_TEXT[a.kind] ?? a.kind }}</span>
              <span v-if="a.width && a.height" class="chip">{{ a.width }}×{{ a.height }}</span>
              <span v-if="a.duration" class="chip">{{ a.duration.toFixed(1) }}s</span>
              <span class="muted sz">{{ fmtSize(a.fileSize) }}</span>
            </label>
          </div>
        </div>

        <label class="fld">
          包名（留空自动：项目_模板_runID）
          <input v-model="name" type="text" placeholder="如：萌宝镖客_第5集_发布包" />
        </label>
        <div class="muted tip">包内结构：manifest.json + video/cover/text/other 分目录；store 不压缩</div>
      </template>
    </template>

    <template v-else>
      <div class="done">
        <Icon name="check" :size="28" />
        <div>
          <div class="dt">发布包已生成</div>
          <div class="muted">{{ result.name }} · {{ fmtSize(result.fileSize) }}</div>
        </div>
      </div>
    </template>

    <div v-if="err" class="err-text">{{ err }}</div>

    <template #footer>
      <template v-if="!result">
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn primary" :disabled="busy || !selected.size" @click="submit">
          {{ busy ? '打包中…' : `生成发布包（${selected.size} 项）` }}
        </button>
      </template>
      <template v-else>
        <button class="btn" @click="emit('done', result.id)">关闭</button>
        <a class="btn primary" :href="exportApi.fileUrl(result.id, true)"><Icon name="download" :size="14" /> 下载</a>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.all {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  cursor: pointer;
}

.groups {
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 10px;
  margin-bottom: 12px;
}

.group .gh {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 0 4px;
  border-bottom: 1px dashed var(--border);
  margin-bottom: 4px;
}

.gh .all {
  font-weight: 600;
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  padding: 3px 4px;
  border-radius: 6px;
  cursor: pointer;
}

.item:hover {
  background: var(--hover);
}

.item .nm {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 260px;
}

.item .sz {
  margin-left: auto;
}

.tip {
  margin-top: -6px;
}

.done {
  display: flex;
  align-items: center;
  gap: 14px;
  color: var(--ok);
  padding: 18px 4px;
}

.dt {
  font-weight: 600;
  color: var(--text);
}
</style>
