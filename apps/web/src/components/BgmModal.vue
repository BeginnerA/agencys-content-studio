<script setup lang="ts">
/**
 * [M11] 配乐（BGM）弹窗（spec §4.3）
 * - 当前 BGM：名称 + 试听（资产 file URL）+ 移除
 * - 候选：项目音频资产（?kind=audio，点击绑定 → 复制行，不污染源资产）
 * - 上传：multipart 音频文件绑定（mp3/wav/aac/m4a/flac，≤200MB 服务端校验）
 * - 音量：0–100% → _compose.bgm_volume（独立保存；与绑定分离）
 * - 全部操作不触发执行：提示「重新合成后生效」；操作成功 emit changed（父级刷新 BGM 名）
 */
import { onMounted, ref } from 'vue'
import { composeApi, projectApi } from '../lib/api'
import type { Asset } from '../lib/types'
import Icon from './Icon.vue'
import Modal from './Modal.vue'

const props = defineProps<{ runId: number; projectId: number }>()
const emit = defineEmits<{ close: []; changed: [] }>()

const bgm = ref<Asset | null>(null)
const candidates = ref<Asset[]>([])
const loading = ref(true)
const busy = ref(false)
const err = ref('')
const notice = ref('')
const volume = ref(25)
const previewId = ref<number | null>(null)
const uploadInput = ref<HTMLInputElement | null>(null)

onMounted(async () => {
  try {
    const b = await composeApi.getBgm(props.runId)
    bgm.value = b.bgm
    const c = await composeApi.getConfig(props.runId)
    const v = c.config.bgm_volume
    volume.value = Math.round((typeof v === 'number' ? v : 0.25) * 100)
    if (props.projectId > 0) {
      const r = await projectApi.assets(props.projectId, '?kind=audio&limit=50')
      candidates.value = r.items
    }
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
})

/** 操作封装：busy → 执行 → notice + emit changed / 失败 err */
async function wrap(fn: () => Promise<void>, okMsg: string) {
  if (busy.value) return
  busy.value = true
  err.value = ''
  notice.value = ''
  try {
    await fn()
    notice.value = okMsg
    emit('changed')
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

/** 当前绑定命中候选（复制行经 params.source_asset_id 回指源资产） */
function isBound(a: Asset): boolean {
  const p = bgm.value?.params
  if (!p || typeof p !== 'object') return false
  return (p as Record<string, unknown>)['source_asset_id'] === a.id
}

function bind(a: Asset) {
  void wrap(async () => {
    const r = await composeApi.bindBgm(props.runId, a.id)
    bgm.value = r.bgm
  }, 'BGM 已绑定（重新合成后生效）')
}

function remove() {
  void wrap(async () => {
    await composeApi.removeBgm(props.runId)
    bgm.value = null
    previewId.value = null
  }, 'BGM 已移除（重新合成后生效）')
}

function pickUpload() {
  uploadInput.value?.click()
}

async function onUploadPicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  await wrap(async () => {
    const r = await composeApi.uploadBgm(props.runId, file)
    bgm.value = r.bgm
  }, 'BGM 已上传并绑定（重新合成后生效）')
}

function saveVolume() {
  const v = Math.min(1, Math.max(0, volume.value / 100))
  void wrap(async () => {
    await composeApi.updateConfig(props.runId, { bgm_volume: v })
  }, '音量已保存（重新合成后生效）')
}

function togglePreview(a: Asset) {
  previewId.value = previewId.value === a.id ? null : a.id
}

function fmtDur(sec: number | null): string {
  if (!sec) return '—'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
</script>

<template>
  <Modal title="配乐（BGM）" :width="580" @close="emit('close')">
    <div class="bg">
      <div v-if="loading" class="muted">加载中…</div>
      <template v-else>
        <!-- 当前 BGM -->
        <div class="bg-sec">
          <div class="bg-lb">当前 BGM</div>
          <div v-if="bgm" class="bg-cur">
            <div class="bg-row">
              <Icon name="speaker-wave" :size="13" />
              <span class="bg-nm" :title="bgm.name">{{ bgm.name }}</span>
              <span class="muted mono">{{ fmtDur(bgm.duration) }}</span>
              <span class="grow" />
              <button class="btn sm danger" :disabled="busy" @click="remove">
                <Icon name="trash" :size="12" /> 移除
              </button>
            </div>
            <audio class="bg-audio" controls preload="none" :src="bgm.urls.file" />
          </div>
          <div v-else class="muted bg-none">未绑定 BGM——从下方候选选择或上传新文件</div>
        </div>

        <!-- 音量 -->
        <div class="bg-sec">
          <div class="bg-lb">混音音量（{{ volume }}%）<span class="muted bg-lb-tip">语音为主轨，BGM 默认 25%</span></div>
          <div class="bg-vol">
            <input v-model.number="volume" type="range" min="0" max="100" step="5" :disabled="busy" />
            <button class="btn sm" :disabled="busy" @click="saveVolume">保存音量</button>
          </div>
        </div>

        <!-- 候选 -->
        <div class="bg-sec">
          <div class="bg-lb">项目音频素材<span class="muted bg-lb-tip">点击「绑定」使用（复制行，不动源资产）</span></div>
          <div v-if="candidates.length" class="bg-list">
            <div v-for="a in candidates" :key="a.id" class="bg-item">
              <div class="bg-row">
                <Icon name="speaker-wave" :size="13" />
                <span class="bg-nm" :title="a.name">{{ a.name }}</span>
                <span class="muted mono">{{ fmtDur(a.duration) }}</span>
                <span class="grow" />
                <button class="bg-mini" :disabled="busy" @click="togglePreview(a)">
                  {{ previewId === a.id ? '收起' : '试听' }}
                </button>
                <button
                  class="btn sm"
                  :class="{ primary: !isBound(a) }"
                  :disabled="busy || isBound(a)"
                  @click="bind(a)"
                >
                  {{ isBound(a) ? '已绑定' : '绑定' }}
                </button>
              </div>
              <audio v-if="previewId === a.id" class="bg-audio" controls preload="none" :src="a.urls.file" />
            </div>
          </div>
          <div v-else class="muted bg-none">项目内暂无音频素材——可在「素材」页导入后回来绑定</div>
        </div>

        <!-- 上传 -->
        <div class="bg-sec">
          <div class="bg-lb">上传音频</div>
          <div class="bg-row">
            <button class="btn sm" :disabled="busy" @click="pickUpload">
              <Icon name="upload" :size="12" /> 选择文件上传并绑定
            </button>
            <span class="muted bg-lb-tip">mp3 / wav / aac / m4a / flac，≤200MB</span>
          </div>
          <input
            ref="uploadInput"
            type="file"
            class="bg-file"
            accept="audio/*,.mp3,.wav,.aac,.m4a,.flac"
            @change="onUploadPicked"
          />
        </div>

        <div v-if="err" class="err-text">{{ err }}</div>
        <div v-if="notice" class="bg-notice"><Icon name="check" :size="12" /> {{ notice }}</div>
      </template>
    </div>

    <template #footer>
      <span class="muted bg-tip">绑定 / 音量 / 移除均不触发生成，需「重新合成」后进入成片</span>
      <button class="btn" @click="emit('close')">关闭</button>
    </template>
  </Modal>
</template>

<style scoped>
.bg {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 13px;
}

.bg-sec {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.bg-lb {
  font-weight: 600;
  font-size: 12.5px;
}

.bg-lb-tip {
  margin-left: 8px;
  font-weight: 400;
  font-size: 11.5px;
}

.bg-cur {
  display: flex;
  flex-direction: column;
  gap: 7px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px 11px;
}

.bg-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.grow {
  flex: 1;
}

.bg-nm {
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bg-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 260px;
  overflow-y: auto;
}

.bg-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 10px;
}

.bg-audio {
  width: 100%;
  height: 30px;
}

.bg-none {
  font-size: 12px;
}

.bg-vol {
  display: flex;
  align-items: center;
  gap: 10px;
}

.bg-vol input[type='range'] {
  flex: 1;
  max-width: 320px;
}

/* 试听按钮（本地化，不依赖父组件 scoped 类） */
.bg-mini {
  border: none;
  background: none;
  color: var(--accent-h);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
  transition: background 0.15s;
}

.bg-mini:hover:not(:disabled) {
  background: var(--accent-weak);
}

.bg-mini:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.bg-file {
  display: none;
}

.bg-notice {
  display: flex;
  align-items: center;
  gap: 7px;
  background: var(--ok-weak);
  color: var(--ok);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12.5px;
}

.bg-tip {
  margin-right: auto;
  font-size: 11.5px;
}
</style>
