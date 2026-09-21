<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AssetPreviewer from '../../components/asset/previewer/index.vue'
import { assetApi } from '../../lib/api'
import type { Asset, CreationArtifact } from '../../lib/types'
import type { useEasyCreate } from './use-creation-chat'

const props = defineProps<{ s: ReturnType<typeof useEasyCreate> }>()
const artifacts = computed(() => props.s.state.detail?.artifacts)
const preview = ref<Asset | null>(null)
const loading = ref<number | null>(null)
const error = ref('')
const brokenThumbs = ref<number[]>([])
let request = 0
watch(() => props.s.state.currentId, () => {
  request++
  preview.value = null
  loading.value = null
  error.value = ''
  brokenThumbs.value = []
})
async function open(a: CreationArtifact): Promise<void> {
  if (!a.available || loading.value !== null) return
  const token = ++request
  loading.value = a.assetId
  error.value = ''
  try {
    const { asset } = await assetApi.detail(a.assetId)
    if (token === request) preview.value = asset
  } catch {
    if (token === request) error.value = '素材当前不可用，请更新状态后重试。'
  } finally {
    if (token === request) loading.value = null
  }
}
</script>

<template>
  <section v-if="s.state.detail?.progress" class="panel ec-artifacts" aria-label="已有成果">
    <h2>已有成果</h2>
    <p class="muted">只读预览，恢复制作时会继续复用可用成果。</p>
    <p v-if="!artifacts?.shots.length && !artifacts?.documents.length" class="muted">暂无可核实的成果。素材生成后会自动显示。</p>
    <p v-if="error" role="alert" class="err-text">{{ error }}</p>
    <ol class="ec-artifacts-shots">
      <li v-for="shot in artifacts?.shots ?? []" :key="shot.shotId" class="ec-artifacts-shot">
        <h3>第 {{ shot.index }} 镜 · {{ shot.duration }} 秒</h3>
        <p>{{ shot.text || '此镜无台词' }}</p>
        <button v-if="shot.image?.available" class="ec-artifacts-image" type="button" :disabled="loading !== null" :aria-label="`预览第 ${shot.index} 镜画面`" @click="open(shot.image)">
          <img v-if="!brokenThumbs.includes(shot.image.assetId)" :src="`/api/v1/assets/${shot.image.assetId}/thumb?v=2`" :alt="`第 ${shot.index} 镜画面`" loading="lazy" @error="brokenThumbs.push(shot.image.assetId)" />
          <span v-else>缩略图暂不可用，点击查看原图</span>
        </button>
        <div v-else class="ec-artifacts-image ec-artifacts-placeholder">{{ shot.image ? '画面素材不可用' : '画面尚未生成' }}</div>
        <div class="ec-artifacts-actions">
          <span v-if="shot.image?.reused" class="badge">画面已复用</span>
          <button v-if="shot.video" class="btn sm" type="button" :disabled="!shot.video.available || loading !== null" @click="open(shot.video)">{{ shot.video.available ? '预览视频' : '视频素材不可用' }}{{ shot.video.reused ? ' · 已复用' : '' }}</button>
          <span v-else class="muted">暂无视频</span>
          <button v-for="(voice, i) in shot.voices" :key="voice.assetId" class="btn sm" type="button" :disabled="!voice.available || loading !== null" @click="open(voice)">{{ voice.available ? `试听配音 ${i + 1}` : '配音不可用' }}{{ voice.reused ? ' · 已复用' : '' }}</button>
          <span v-if="!shot.voices.length" class="muted">暂无配音</span>
        </div>
      </li>
    </ol>
    <div v-if="artifacts?.documents.length" class="ec-artifacts-documents">
      <h3>字幕与批准文本</h3>
      <button v-for="doc in artifacts.documents" :key="`${doc.label}-${doc.assetId}`" class="btn sm" type="button" :disabled="!doc.available || loading !== null" @click="open(doc)">{{ doc.label }}{{ doc.available ? '' : ' · 素材不可用' }}{{ doc.reused ? ' · 已复用' : '' }}</button>
    </div>
    <p v-if="loading !== null" role="status">正在加载预览…</p>
    <AssetPreviewer v-if="preview" :assets="[preview]" :index="0" @close="preview = null" />
  </section>
</template>

<style scoped>
.ec-artifacts { padding: 16px 18px; min-width: 0; }
.ec-artifacts h2 { font-size: 16px; margin: 0 0 8px; }
.ec-artifacts h3 { font-size: 14px; margin: 0; }
.ec-artifacts p { line-height: 1.6; overflow-wrap: anywhere; }
.ec-artifacts-shots { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.ec-artifacts-shot { padding: 12px; border: 1px solid var(--border); border-radius: 10px; min-width: 0; background: var(--panel-2); }
.ec-artifacts-image { width: 100%; aspect-ratio: 16 / 9; display: flex; align-items: center; justify-content: center; padding: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; color: var(--text-2); background: var(--panel); }
button.ec-artifacts-image { cursor: pointer; }
.ec-artifacts-image img { width: 100%; height: 100%; object-fit: contain; }
.ec-artifacts-placeholder { font-size: 13px; }
.ec-artifacts-actions, .ec-artifacts-documents { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; align-items: center; }
.ec-artifacts-documents h3 { width: 100%; }
.ec-artifacts .btn { min-height: 44px; white-space: normal; }
.ec-artifacts button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 600px) { .ec-artifacts-shots { grid-template-columns: 1fr; } }
</style>
