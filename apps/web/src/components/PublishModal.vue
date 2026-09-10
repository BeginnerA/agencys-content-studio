<script setup lang="ts">
import { ref } from 'vue'
import Modal from './Modal.vue'
import { publicationApi } from '../lib/api'
import { PLATFORM_TEXT } from '../lib/format'
import type { Publication } from '../lib/types'

const props = defineProps<{
  projectId: number
  /** 关联 run（可空：允许登记非流水线内容） */
  runId?: number | null
  /** 可选资产（id/name） */
  assetOptions: Array<{ id: number; name: string }>
  /** 预选资产 */
  defaultAssetId?: number | null
  /** 编辑模式 */
  publication?: Publication | null
}>()

const emit = defineEmits<{ done: []; close: [] }>()

const p = props.publication
const platform = ref<string>(p?.platform ?? 'douyin')
const url = ref(p?.url ?? '')
const assetId = ref<number | ''>(p?.assetId ?? props.defaultAssetId ?? '')
const publishedDate = ref(p?.publishedAt ? toDateInput(p.publishedAt) : '')
const metric = ref<Record<string, string>>({
  views: str(p?.metrics?.views),
  likes: str(p?.metrics?.likes),
  comments: str(p?.metrics?.comments),
  favorites: str(p?.metrics?.favorites),
  shares: str(p?.metrics?.shares),
})
const note = ref(p?.note ?? '')
const busy = ref(false)
const err = ref('')

const PLATFORMS = Object.keys(PLATFORM_TEXT)
const METRICS = [
  { k: 'views', t: '播放' },
  { k: 'likes', t: '点赞' },
  { k: 'comments', t: '评论' },
  { k: 'favorites', t: '收藏' },
  { k: 'shares', t: '转发' },
] as const

function str(n: number | undefined): string {
  return n ? String(n) : ''
}
function toDateInput(ms: number): string {
  const d = new Date(ms)
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function submit() {
  busy.value = true
  err.value = ''
  try {
    const metrics: Record<string, number> = {}
    for (const m of METRICS) metrics[m.k] = Number(metric.value[m.k] || 0)
    const body: Record<string, unknown> = {
      project_id: props.projectId,
      platform: platform.value,
      url: url.value.trim() || undefined,
      asset_id: assetId.value === '' ? undefined : assetId.value,
      // 日期取当地中午避免时区边界
      published_at: publishedDate.value ? new Date(publishedDate.value + 'T12:00:00').getTime() : undefined,
      metrics,
      note: note.value.trim() || undefined,
    }
    if (p?.id) {
      await publicationApi.update(p.id, body)
    } else {
      await publicationApi.create({ ...body, run_id: props.runId ?? undefined })
    }
    emit('done')
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal :title="p?.id ? '编辑发布记录' : '标记发布'" :width="520" @close="emit('close')">
    <div class="grid2">
      <label class="fld">
        平台 <span class="req">*</span>
        <select v-model="platform" aria-label="发布平台">
          <option v-for="k in PLATFORMS" :key="k" :value="k">{{ PLATFORM_TEXT[k] }}</option>
        </select>
      </label>
      <label class="fld">
        发布日期
        <input v-model="publishedDate" type="date" />
      </label>
    </div>
    <label class="fld">
      作品链接
      <input v-model="url" type="text" placeholder="https://…" />
    </label>
    <label v-if="!p?.id" class="fld">
      关联资产（可选）
      <select v-model="assetId">
        <option value="">不关联</option>
        <option v-for="a in assetOptions" :key="a.id" :value="a.id">#{{ a.id }} {{ a.name }}</option>
      </select>
    </label>
    <div class="fld">
      指标（手工回填，仅存不算）
      <div class="metrics">
        <label v-for="m in METRICS" :key="m.k" class="mcell">
          {{ m.t }}
          <input v-model="metric[m.k]" type="number" min="0" placeholder="0" />
        </label>
      </div>
    </div>
    <label class="fld">
      备注
      <input v-model="note" type="text" placeholder="可选" />
    </label>
    <div v-if="err" class="err-text">{{ err }}</div>
    <template #footer>
      <button class="btn" @click="emit('close')">取消</button>
      <button class="btn primary" :disabled="busy" @click="submit">{{ busy ? '保存中…' : '保存' }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 14px;
}

.metrics {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 8px;
  margin-top: 5px;
}

.mcell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11.5px;
  color: var(--text-2);
}
</style>
