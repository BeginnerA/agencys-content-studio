<script setup lang="ts">
import { ref } from 'vue'
import type { Asset } from '../lib/types'
import { fmtSize, fmtTime, purposeText } from '../lib/format'
import Modal from './Modal.vue'
import Icon from './Icon.vue'

const props = defineProps<{ assets: Asset[]; loading?: boolean; pickable?: boolean }>()
const emit = defineEmits<{ pick: [asset: Asset] }>()

const selected = ref<Asset | null>(null)

function preview(a: Asset) {
  if (props.pickable) emit('pick', a)
  else selected.value = a
}
</script>

<template>
  <div>
    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="!assets.length" class="empty">暂无资产</div>
    <div v-else class="grid">
      <div v-for="a in assets" :key="a.id" class="cell" @click="preview(a)">
        <div class="thumb">
          <img v-if="a.kind === 'image' && a.urls.thumb" :src="a.urls.thumb" loading="lazy" :alt="a.name" />
          <img v-else-if="a.kind === 'video'" :src="a.urls.thumb ?? undefined" class="video-ico" :alt="a.name" />
          <div v-else class="file-ico">{{ a.ext.toUpperCase().slice(0, 4) }}</div>
          <div v-if="a.kind === 'video'" class="play">
            <Icon name="play" :size="10" :stroke-width="2" />
            {{ a.duration ? Math.round(a.duration) + 's' : '' }}
          </div>
          <div class="purp">{{ purposeText(a.purpose) }}</div>
        </div>
        <div class="meta">
          <div class="nm" :title="a.name">{{ a.name }}</div>
          <div class="sz">{{ fmtSize(a.fileSize) }} · {{ fmtTime(a.createdAt) }}</div>
        </div>
      </div>
    </div>

    <Modal v-if="selected" :title="selected.name" :width="880" @close="selected = null">
      <div v-if="selected.kind === 'image'" class="imgwrap">
        <img :src="selected.urls.file" />
      </div>
      <video v-else-if="selected.kind === 'video'" :src="selected.urls.file" controls class="vid" />
      <div v-else class="txtwrap">
        <a class="btn sm" :href="selected.urls.file" target="_blank">打开原文</a>
        <div class="muted mono">purpose={{ selected.purpose }} · {{ fmtSize(selected.fileSize) }} · {{ fmtTime(selected.createdAt) }}</div>
      </div>
      <template v-if="selected.prompt" #footer>
        <details class="prmt">
          <summary>提示词快照（可溯源）</summary>
          <pre>{{ selected.prompt }}</pre>
        </details>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}

.cell {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.12s, box-shadow 0.12s, border-color 0.12s;
}

.cell:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 26px -16px rgb(0 0 0 / 70%);
  border-color: rgb(99 102 241 / 45%);
}

.thumb {
  position: relative;
  aspect-ratio: 9/12;
  background: var(--img-ph);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.file-ico {
  font-family: var(--mono);
  font-size: 20px;
  color: var(--text-3);
}

.video-ico {
  opacity: 0.85;
}

.play {
  position: absolute;
  left: 6px;
  bottom: 22px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: rgb(0 0 0 / 62%);
  backdrop-filter: blur(3px);
  color: #fff;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
}

.purp {
  position: absolute;
  left: 6px;
  bottom: 5px;
  background: rgb(10 14 24 / 60%);
  color: #fff;
  font-size: 10.5px;
  padding: 1px 8px;
  border-radius: 999px;
  max-width: 80%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  padding: 7px 9px;
}

.nm {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sz {
  color: var(--text-3);
  font-size: 11px;
  margin-top: 2px;
}

.imgwrap {
  text-align: center;
}

.imgwrap img {
  max-width: 100%;
  max-height: 62vh;
  border-radius: 8px;
}

.vid {
  width: 100%;
  max-height: 62vh;
  border-radius: 8px;
}

.txtwrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}

.prmt summary {
  cursor: pointer;
  color: var(--text-2);
  font-size: 12px;
}

.prmt pre {
  max-height: 180px;
  overflow-y: auto;
  white-space: pre-wrap;
  font-size: 11.5px;
  color: #b9c7dc;
  font-family: var(--mono);
  background: var(--code-bg);
  border: 1px solid var(--border);
  padding: 10px;
  border-radius: 8px;
  margin: 8px 0 0;
}
</style>
