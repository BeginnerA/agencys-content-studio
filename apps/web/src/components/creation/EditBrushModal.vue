<script setup lang="ts">
/**
 * [M16] 蒙版笔刷编辑器（inpaint/erase 用；spec §2.7）
 * - 底图 = 源图（source 端口上游最新产物）；白色笔刷 / 橡皮 / 尺寸 / 清空
 * - 导出契约：黑底 + 白笔迹 PNG（最长边 ≤1024）→ uploadFiles(purpose='mask') → emit saved(assetId)
 *   （白 = 要编辑/去除的区域；颜色语义对齐 wanx description_edit_with_mask）
 */
import { onMounted, ref } from 'vue'
import { uploadFiles } from '../../lib/api'
import Icon from '../common/Icon.vue'
import Modal from '../common/Modal.vue'

const props = defineProps<{
  projectId: number
  baseUrl: string
  baseName?: string
}>()
const emit = defineEmits<{ close: []; saved: [assetId: number] }>()

/** 蒙版最长边（控制上传体积；wanx 侧会自行缩放） */
const MAX_EDGE = 1024
const imgEl = ref<HTMLImageElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
const mode = ref<'paint' | 'erase'>('paint')
const brush = ref(48)
const loaded = ref(false)
const dirty = ref(false)
const busy = ref(false)
const err = ref('')

let ctx: CanvasRenderingContext2D | null = null
let drawing = false
let last: { x: number; y: number } | null = null

onMounted(() => {
  const el = imgEl.value
  if (!el) return
  const setup = (): void => {
    const c = canvasEl.value
    const nw = el.naturalWidth
    const nh = el.naturalHeight
    if (!c || !nw || !nh) {
      if (el.complete) err.value = '源图加载失败（尺寸为 0）'
      return
    }
    const k = Math.min(1, MAX_EDGE / Math.max(nw, nh))
    c.width = Math.max(1, Math.round(nw * k))
    c.height = Math.max(1, Math.round(nh * k))
    ctx = c.getContext('2d')
    loaded.value = true
  }
  if (el.complete && el.naturalWidth) setup()
  else {
    el.onload = setup
    el.onerror = () => {
      err.value = '源图加载失败'
    }
  }
})

/** client → canvas 像素（canvas 以 CSS 宽度 100% 展示） */
function pos(ev: PointerEvent): { x: number; y: number } {
  const c = canvasEl.value!
  const rect = c.getBoundingClientRect()
  return {
    x: (ev.clientX - rect.left) * (c.width / Math.max(rect.width, 1)),
    y: (ev.clientY - rect.top) * (c.height / Math.max(rect.height, 1)),
  }
}

/** 笔刷显示尺寸 → canvas 像素 */
function lineWidth(): number {
  const c = canvasEl.value
  if (!c) return brush.value
  const rect = c.getBoundingClientRect()
  if (!rect.width) return brush.value
  return brush.value * (c.width / rect.width)
}

function stroke(
  a: { x: number; y: number },
  b: { x: number; y: number },
): void {
  if (!ctx) return
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = lineWidth()
  ctx.globalCompositeOperation =
    mode.value === 'erase' ? 'destination-out' : 'source-over'
  ctx.strokeStyle = '#ffffff'
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.stroke()
}

function onDown(ev: PointerEvent): void {
  if (!loaded.value || busy.value) return
  ev.preventDefault()
  drawing = true
  ;(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId)
  const p = pos(ev)
  last = p
  stroke(p, p)
  dirty.value = true
}
function onMove(ev: PointerEvent): void {
  if (!drawing || !last) return
  const p = pos(ev)
  stroke(last, p)
  last = p
}
function onUp(ev: PointerEvent): void {
  drawing = false
  last = null
  const el = ev.currentTarget as HTMLElement
  if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId)
}

function clearAll(): void {
  const c = canvasEl.value
  if (!c || !ctx) return
  ctx.clearRect(0, 0, c.width, c.height)
  dirty.value = false
}

async function save(): Promise<void> {
  const c = canvasEl.value
  if (!c) return
  if (!dirty.value) {
    err.value = '请先在源图上涂抹要编辑的区域'
    return
  }
  busy.value = true
  err.value = ''
  try {
    // 导出：黑底 + 白笔迹（透明橡皮区落为黑 = 不编辑）
    const out = document.createElement('canvas')
    out.width = c.width
    out.height = c.height
    const octx = out.getContext('2d')
    if (!octx) throw new Error('无法创建导出画布')
    octx.fillStyle = '#000000'
    octx.fillRect(0, 0, out.width, out.height)
    octx.drawImage(c, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) =>
      out.toBlob(resolve, 'image/png'),
    )
    if (!blob) throw new Error('蒙版导出失败（toBlob 返回空）')
    const file = new File([blob], `mask-${Date.now()}.png`, {
      type: 'image/png',
    })
    const assets = await uploadFiles(props.projectId, 'mask', [file])
    const a = assets[0]
    if (!a) throw new Error('蒙版上传失败（服务端未返回资产）')
    emit('saved', a.id)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal title="蒙版编辑器" :width="920" @close="emit('close')">
    <div class="mb-bar">
      <span class="muted mini">
        底图：{{ baseName || '源图' }} —— 涂抹要编辑的区域（白色笔迹 =
        蒙版范围，导出为黑底白痕）
      </span>
      <span class="sp" />
      <div class="seg">
        <button
          type="button"
          :class="{ on: mode === 'paint' }"
          title="笔刷（涂抹 = 要编辑）"
          @click="mode = 'paint'"
        >
          <Icon name="brush" :size="12" /> 笔刷
        </button>
        <button
          type="button"
          :class="{ on: mode === 'erase' }"
          title="橡皮（擦掉涂抹）"
          @click="mode = 'erase'"
        >
          <Icon name="x" :size="12" /> 橡皮
        </button>
      </div>
      <label class="sz">
        笔刷
        <input v-model.number="brush" type="range" min="8" max="160" step="2" />
        <span class="mono">{{ brush }}</span>
      </label>
      <button
        type="button"
        class="btn sm"
        title="清空所有涂抹"
        @click="clearAll"
      >
        清空
      </button>
    </div>

    <div class="mb-stage">
      <div class="mb-wrap">
        <img ref="imgEl" :src="baseUrl" alt="" draggable="false" />
        <canvas
          ref="canvasEl"
          :class="{ ready: loaded }"
          aria-label="蒙版涂抹画布"
          @pointerdown="onDown"
          @pointermove="onMove"
          @pointerup="onUp"
          @pointercancel="onUp"
        />
      </div>
      <div v-if="!loaded && !err" class="muted loadhint">源图加载中…</div>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>

    <template #footer>
      <button type="button" class="btn" :disabled="busy" @click="emit('close')">
        取消
      </button>
      <button
        type="button"
        class="btn primary"
        :disabled="busy || !loaded"
        @click="save"
      >
        <Icon name="check" :size="12" />
        {{ busy ? '上传中…' : '保存蒙版并应用' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.mb-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.sp {
  flex: 1;
}

.mini {
  font-size: 11.5px;
}

.seg {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.seg button {
  display: flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: none;
  color: var(--text-2);
  font-size: 12px;
  font-family: inherit;
  padding: 5px 10px;
  cursor: pointer;
}

.seg button.on {
  background: var(--accent);
  color: #fff;
}

.sz {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
}

.sz input[type='range'] {
  width: 110px;
}

.sz .mono {
  width: 26px;
  text-align: right;
  color: var(--text-3);
}

.mb-stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  max-height: 62vh;
  min-height: 200px;
}

/* 包裹层随底图收缩：canvas 与底图严格同盒（避免 letterbox 错位） */
.mb-wrap {
  position: relative;
  display: inline-block;
  max-width: 100%;
  max-height: 62vh;
}

.mb-wrap img {
  display: block;
  max-width: 100%;
  max-height: 62vh;
  object-fit: contain;
  user-select: none;
}

.mb-wrap canvas {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  opacity: 0.62;
  cursor: crosshair;
  touch-action: none;
}

.mb-wrap canvas:not(.ready) {
  pointer-events: none;
}

.loadhint {
  position: absolute;
  font-size: 12px;
}
</style>
