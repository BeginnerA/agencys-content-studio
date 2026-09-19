<script setup lang="ts">
// 资产缩略图（统一网格卡片的媒体层）
// 设计要点（与「榫卯拼块」logo 台面同源 token）：
// - 类型感知：图片/视频/音频/文档各有专属占位，杜绝空白与破损图
// - 视频：服务端 WebP 封面优先；缺失/失败时进入视口惰性抽首帧（file 端点支持 Range）
// - 任何媒体加载失败都回退到占位，绝不把 alt 文本暴露成「多行文件名」
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Asset } from '../../lib/types'
import { fmtDur, purposeText } from '../../lib/format'
import Icon from '../common/Icon.vue'

const props = defineProps<{ asset: Asset; pickable?: boolean }>()

/** 文本/结构化文档扩展名：走文档占位而非通用文件占位 */
const DOC_EXTS = new Set([
  'md',
  'markdown',
  'json',
  'yaml',
  'yml',
  'txt',
  'csv',
  'log',
  'ini',
  'toml',
  'srt',
  'vtt',
  'ass',
  'xml',
  'html',
])

type Media = 'image' | 'video' | 'audio' | 'doc' | 'file'

const media = computed<Media>(() => {
  const a = props.asset
  if (a.kind === 'image' || a.kind === 'video' || a.kind === 'audio')
    return a.kind
  if (a.kind === 'text' || DOC_EXTS.has((a.ext || '').toLowerCase()))
    return 'doc'
  return 'file'
})

const PH_ICON: Record<Media, string> = {
  image: 'photo',
  video: 'play',
  audio: 'speaker-wave',
  doc: 'doc',
  file: 'doc',
}

const extLabel = computed(() =>
  (props.asset.ext || 'FILE').toUpperCase().slice(0, 4),
)
const phIcon = computed(() => PH_ICON[media.value])

// ===== 图片：thumb 优先，回退原图；失败即占位 =====
const imgSrc = computed(() =>
  media.value === 'image'
    ? props.asset.urls.thumb || props.asset.urls.file
    : '',
)
const imgFailed = ref(false)
watch(imgSrc, () => {
  imgFailed.value = false
})

// ===== 视频：服务端封面优先；无封面或加载失败回退客户端抽首帧 =====
const videoThumbSrc = computed(() => props.asset.urls.thumb)
const videoThumbFailed = ref(false)
watch(videoThumbSrc, () => {
  videoThumbFailed.value = false
})

const needFrame = computed(
  () =>
    media.value === 'video' && (!videoThumbSrc.value || videoThumbFailed.value),
)
const videoSrc = computed(() => props.asset.urls.file)
const inView = ref(false)
const frameReady = ref(false)
const frameFailed = ref(false)
const rootEl = ref<HTMLElement | null>(null)
let io: IntersectionObserver | null = null

watch(videoSrc, () => {
  frameReady.value = false
  frameFailed.value = false
})

function markFrame() {
  frameReady.value = true
}

/** preload 只保证元数据，主动 seek 才会解码出首帧 */
function onMeta(e: Event) {
  const v = e.target as HTMLVideoElement
  if (v.readyState >= 2) {
    markFrame()
    return
  }
  try {
    v.currentTime = Math.min(0.1, (v.duration || 1) / 10)
  } catch {
    /* 忽略 seek 异常 */
  }
}

/** 元素是否(接近)进入视口；IO 在后台标签页可能不回调，故先同步判定一次 */
function nearViewport(el: HTMLElement, margin = 240): boolean {
  const r = el.getBoundingClientRect()
  return r.top < window.innerHeight + margin && r.bottom > -margin
}

/** 需要客户端抽帧时进入视口才加载（服务端封面失败会二次触发） */
function ensureFrameInView() {
  if (!needFrame.value || inView.value) return
  if (rootEl.value && nearViewport(rootEl.value)) {
    inView.value = true
    io?.disconnect()
    io = null
    return
  }
  if (typeof IntersectionObserver === 'undefined') {
    inView.value = true
    return
  }
  if (io || !rootEl.value) return
  io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      inView.value = true
      io?.disconnect()
      io = null
    },
    { rootMargin: '240px 0px' },
  )
  io.observe(rootEl.value)
}

onMounted(() => {
  ensureFrameInView()
})

// 服务端封面加载失败 → 回退抽帧路径（失败发生在 mounted 之后）
watch(needFrame, (need) => {
  if (need) ensureFrameInView()
})

onBeforeUnmount(() => {
  io?.disconnect()
  io = null
})

/** 右下角浮层：影音显示时长，图片显示像素尺寸 */
const corner = computed(() => {
  const a = props.asset
  if (a.kind === 'video' || a.kind === 'audio')
    return a.duration ? fmtDur(a.duration) : ''
  if (media.value === 'image' && a.width && a.height)
    return `${a.width}×${a.height}`
  return ''
})
</script>

<template>
  <span ref="rootEl" class="thumb">
    <!-- 图片 -->
    <template v-if="media === 'image'">
      <img
        v-if="imgSrc && !imgFailed"
        class="media"
        :src="imgSrc"
        :alt="asset.name"
        loading="lazy"
        decoding="async"
        @error="imgFailed = true"
      />
      <span v-else class="ph ph-image">
        <Icon name="photo" :size="26" />
        <em class="ph-ext">{{ extLabel }}</em>
      </span>
    </template>

    <!-- 视频：服务端封面优先，缺失/失败回退客户端抽帧；占位常驻底层 -->
    <template v-else-if="media === 'video'">
      <span class="ph ph-video">
        <span class="ph-ring">
          <Icon name="play" :size="17" :stroke-width="2.2" />
        </span>
      </span>
      <img
        v-if="videoThumbSrc && !videoThumbFailed"
        class="media"
        :src="videoThumbSrc"
        :alt="asset.name"
        loading="lazy"
        decoding="async"
        @error="videoThumbFailed = true"
      />
      <video
        v-else-if="inView && !frameFailed"
        class="media frame"
        :class="{ on: frameReady }"
        :src="videoSrc"
        muted
        playsinline
        preload="auto"
        @loadedmetadata="onMeta"
        @loadeddata="markFrame"
        @seeked="markFrame"
        @error="frameFailed = true"
      />
    </template>

    <!-- 音频：波形占位 -->
    <span v-else-if="media === 'audio'" class="ph ph-audio">
      <span class="wave" aria-hidden="true">
        <i v-for="n in 5" :key="n" />
      </span>
      <Icon name="speaker-wave" :size="18" />
    </span>

    <!-- 文档 / 其他文件 -->
    <span v-else class="ph" :class="`ph-${media}`">
      <Icon :name="phIcon" :size="26" />
      <em class="ph-ext">{{ extLabel }}</em>
    </span>

    <!-- 左上：用途 -->
    <span v-if="asset.purpose" class="bd bd-purpose">{{
      purposeText(asset.purpose)
    }}</span>

    <!-- 右下：时长 / 像素尺寸 -->
    <span v-if="corner" class="bd bd-corner">
      <Icon
        v-if="asset.kind === 'video'"
        name="play"
        :size="9"
        :stroke-width="2.6"
      />
      {{ corner }}
    </span>

    <!-- 悬停操作提示（状态由父卡片通过 CSS 变量下发） -->
    <span class="veil" aria-hidden="true">
      <span class="veil-btn">
        <Icon :name="pickable ? 'check' : 'eye'" :size="18" />
      </span>
    </span>
  </span>
</template>

<style scoped>
.thumb {
  position: relative;
  display: block;
  aspect-ratio: 9 / 12;
  background: var(--img-ph);
  overflow: hidden;
}

/* 媒体层：随卡片 hover 轻微放大（transform 不触发重排） */
.media {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scale(var(--thumb-zoom, 1));
  transition: transform 0.3s cubic-bezier(0.22, 0.61, 0.36, 1);
}

/* 视频首帧：就绪后淡入 */
.frame {
  position: absolute;
  inset: 0;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.3s ease;
}

.frame.on {
  opacity: 1;
}

/* ===== 品牌同源占位（卯槽底 + 类型微光）===== */
.ph {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  color: var(--text-3);
  background:
    radial-gradient(112% 78% at 50% 8%, rgb(99 102 241 / 13%), transparent 62%),
    var(--img-ph);
}

.ph-image {
  color: var(--text-3);
}

.ph-video {
  background:
    radial-gradient(112% 78% at 50% 8%, rgb(139 92 246 / 17%), transparent 62%),
    var(--img-ph);
}

.ph-audio {
  color: var(--ok);
  background:
    radial-gradient(112% 78% at 50% 8%, rgb(34 197 94 / 14%), transparent 62%),
    var(--img-ph);
}

.ph-doc,
.ph-file {
  color: var(--text-2);
}

/* 视频中央播放圆钮（毛玻璃） */
.ph-ring {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 999px;
  color: #fff;
  background: rgb(10 14 24 / 44%);
  border: 1px solid rgb(255 255 255 / 16%);
  backdrop-filter: blur(6px);
  box-shadow:
    0 8px 20px -10px rgb(0 0 0 / 80%),
    0 0 0 5px rgb(139 92 246 / 8%);
}

/* 音频波形 */
.wave {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 26px;
}

.wave i {
  width: 3px;
  border-radius: 2px;
  background: currentColor;
  opacity: 0.75;
}

.wave i:nth-child(1) {
  height: 8px;
}

.wave i:nth-child(2) {
  height: 15px;
}

.wave i:nth-child(3) {
  height: 26px;
}

.wave i:nth-child(4) {
  height: 12px;
}

.wave i:nth-child(5) {
  height: 20px;
}

/* 扩展名徽章（文档 / 图片兜底） */
.ph-ext {
  font-family: var(--mono);
  font-size: 10.5px;
  font-style: normal;
  font-weight: 600;
  letter-spacing: 0.09em;
  padding: 2px 9px;
  border-radius: 999px;
  color: #a5b4fc;
  background: var(--accent-weak);
  border: 1px solid rgb(99 102 241 / 22%);
}

/* ===== 浮层角标 ===== */
.bd {
  position: absolute;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: calc(100% - 12px);
  padding: 1.5px 7px;
  border-radius: 999px;
  font-size: 10.5px;
  line-height: 1.55;
  color: #fff;
  background: rgb(10 14 24 / 62%);
  backdrop-filter: blur(4px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bd-purpose {
  top: 6px;
  left: 6px;
}

.bd-corner {
  right: 6px;
  bottom: 6px;
}

/* 底部渐隐，保证右下角标可读性 */
.thumb::after {
  content: '';
  position: absolute;
  z-index: 1;
  inset: auto 0 0 0;
  height: 40%;
  background: linear-gradient(180deg, transparent, rgb(6 10 20 / 45%));
  pointer-events: none;
}

/* ===== 悬停操作提示 ===== */
.veil {
  position: absolute;
  z-index: 3;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgb(6 10 20 / 40%);
  opacity: var(--veil, 0);
  transition: opacity 0.2s ease;
  pointer-events: none;
}

.veil-btn {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 999px;
  color: #fff;
  background: rgb(255 255 255 / 14%);
  border: 1px solid rgb(255 255 255 / 24%);
  backdrop-filter: blur(8px);
  transform: scale(calc(0.9 + var(--veil, 0) * 0.1));
  transition: transform 0.2s cubic-bezier(0.22, 0.61, 0.36, 1);
}

@media (prefers-reduced-motion: reduce) {
  .media,
  .frame,
  .veil,
  .veil-btn {
    transition: none;
  }
}
</style>
