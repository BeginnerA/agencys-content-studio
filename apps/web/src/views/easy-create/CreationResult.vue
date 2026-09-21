<script setup lang="ts">
import { computed } from 'vue'
import Icon from '../../components/common/Icon.vue'
import { fmtDur } from '../../lib/format'
import type { useEasyCreate } from './use-creation-chat'

const props = defineProps<{ s: ReturnType<typeof useEasyCreate> }>()

const result = computed(() => props.s.state.detail?.result ?? null)
const runId = computed(() => props.s.state.detail?.session.runId ?? null)
const projectId = computed(
  () => props.s.state.detail?.session.projectId ?? null,
)
const fileUrl = computed(() =>
  result.value ? `/api/v1/assets/${result.value.videoId}/file` : '',
)
const downloadUrl = computed(() =>
  fileUrl.value ? `${fileUrl.value}?download=1` : '',
)
const coverUrl = computed(() =>
  result.value?.coverId
    ? `/api/v1/assets/${result.value.coverId}/thumb?v=2`
    : null,
)
</script>

<template>
  <div v-if="result" class="card panel ok-card" aria-label="成片结果">
    <header class="rh">
      <h2><Icon name="check" :size="16" /> 制作完成</h2>
      <span v-if="result.duration" class="chip">{{
        fmtDur(result.duration)
      }}</span>
    </header>
    <p class="note">
      已通过基础交付检查（可解码、时长与旁白字幕完整）。基础检查不等于内容质量或事实准确性保证。
    </p>

    <video
      class="player"
      :src="fileUrl"
      :poster="coverUrl ?? undefined"
      controls
      preload="metadata"
      playsinline
    />

    <footer class="rf">
      <a class="btn ok" :href="downloadUrl" download>
        <Icon name="download" :size="14" /> 下载 MP4
      </a>
      <RouterLink v-if="runId" class="btn" :to="`/runs/${runId}`">
        <Icon name="external" :size="13" /> 查看制作详情
      </RouterLink>
      <RouterLink v-if="projectId" class="btn sm" :to="`/projects/${projectId}`"
        >查看项目</RouterLink
      >
    </footer>
  </div>
</template>

<style scoped>
.card {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background:
    linear-gradient(180deg, rgb(34 197 94 / 7%), transparent 34%), var(--panel);
}

.ok-card {
  border-color: rgb(34 197 94 / 34%);
}

.rh {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.rh h2 {
  font-size: 15px;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 700;
  color: var(--ok);
}

.rh h2 .ic {
  color: var(--ok);
}

.note {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.6;
}

.player {
  width: 100%;
  max-height: 60vh;
  border-radius: 12px;
  background: #000;
  border: 1px solid var(--border-strong);
  object-fit: contain;
  box-shadow: var(--shadow);
}

.rf {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
