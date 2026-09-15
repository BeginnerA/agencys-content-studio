<script setup lang="ts">
/**
 * [M19] 合成设置弹窗（spec §4；由 M11 BgmModal 升级扩展）
 * - 配乐（BGM）：绑定/移除/音量/上传（原 M11 功能逐字保留）
 * - 字幕样式：run 级 brand.subtitle 覆盖（开关 + 9 字段表单）
 *   · 百分比字段显示 ×100（size_pct 0.018 → 1.8%），保存 ÷100
 *   · 开关关闭保存 → brand.subtitle = null（清除 run 级覆盖，回落项目/平台/默认）
 * - 水印/片头/片尾：复用 BrandSettings scope='run'（三态覆盖 + 继承值与来源摘要）
 * - [M19] 镜头音效（SFX）：汇总条数 + 全局音量（绑定入口在工作台镜头卡片）
 * - [M19] 多画幅原生渲染（B 路径）：勾选启用 + 画幅多选（≤3）+ 策略；关闭 = 清除配置（合成链逐字节不变）
 * - 全部操作不触发执行：提示「重新合成后生效」；操作成功 emit changed
 */
import { onMounted, ref } from 'vue'
import { isKnownAspect, ASPECT_OPTIONS, ASPECT_STRATEGY_OPTIONS } from '../../lib/aspect'
import { composeApi, projectApi } from '../../lib/api'
import type { Asset, AspectStrategy, AspectValue, SubtitleStyleConfig } from '../../lib/types'
import BrandSettings from '../brand/BrandSettings.vue'
import Icon from '../common/Icon.vue'
import Modal from '../common/Modal.vue'

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

// ---------- [M19] 镜头音效（SFX 汇总；绑定入口在工作台镜头卡片） ----------

const sfxCount = ref(0)
const sfxVolume = ref(100)

// ---------- [M19] 多画幅原生渲染（B 路径：合成内多路输出） ----------

const maOn = ref(false)
const maAspects = ref<AspectValue[]>([])
const maStrategy = ref<AspectStrategy>('crop')
/** run 级是否已持久化 multi_aspect（决定「清除」按钮可用态） */
const maPersisted = ref(false)

// ---------- [M19] 字幕样式（run 级覆盖） ----------

/** 表单缺省值（与服务端 buildSubtitleStyle 公式基线一致；仅展示用） */
const SUB_DEFAULTS = {
  font: 'Noto Sans CJK SC',
  size: 1.8, // %
  color: '#FFFFFF',
  outlineColor: '#000000',
  outline: 0.09, // %
  shadow: 0,
  marginV: 2, // %
  alignment: 2 as 2 | 5 | 8,
  bold: false,
}

const subOn = ref(false)
const subFont = ref(SUB_DEFAULTS.font)
const subSize = ref(SUB_DEFAULTS.size)
const subColor = ref(SUB_DEFAULTS.color)
const subOutlineColor = ref(SUB_DEFAULTS.outlineColor)
const subOutline = ref(SUB_DEFAULTS.outline)
const subShadow = ref(SUB_DEFAULTS.shadow)
const subMarginV = ref(SUB_DEFAULTS.marginV)
const subAlign = ref<2 | 5 | 8>(SUB_DEFAULTS.alignment)
const subBold = ref(SUB_DEFAULTS.bold)
/** run 级是否已持久化字幕配置（决定「清除」按钮可用态） */
const subPersisted = ref(false)

/** 存储值 → 显示百分比（0.018 → 1.8；容忍脏数据） */
function showPct(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? +(v * 100).toFixed(3) : fallback
}

/** 显示百分比 → 存储值（1.8 → 0.018；前端温和 clamp，服务端硬 clamp 兜底） */
function storePct(v: number, lo: number, hi: number): number {
  const c = Math.min(hi, Math.max(lo, Number(v) || 0))
  return Number((c / 100).toFixed(5))
}

/** run 级配置回填（缺省字段用展示默认值；null/undefined → 开关关） */
function fillSubForm(s: SubtitleStyleConfig | null | undefined) {
  const cfg = s && typeof s === 'object' ? s : undefined
  subPersisted.value = !!cfg
  subOn.value = !!cfg
  subFont.value = typeof cfg?.font === 'string' && cfg.font ? cfg.font : SUB_DEFAULTS.font
  subSize.value = showPct(cfg?.size_pct, SUB_DEFAULTS.size)
  subColor.value = typeof cfg?.color === 'string' ? cfg.color : SUB_DEFAULTS.color
  subOutlineColor.value = typeof cfg?.outline_color === 'string' ? cfg.outline_color : SUB_DEFAULTS.outlineColor
  subOutline.value = showPct(cfg?.outline_pct, SUB_DEFAULTS.outline)
  subShadow.value = typeof cfg?.shadow === 'number' && Number.isFinite(cfg.shadow) ? cfg.shadow : SUB_DEFAULTS.shadow
  subMarginV.value = showPct(cfg?.margin_v_pct, SUB_DEFAULTS.marginV)
  subAlign.value = cfg?.alignment === 5 || cfg?.alignment === 8 ? cfg.alignment : 2
  subBold.value = cfg?.bold === true
}

onMounted(async () => {
  try {
    const b = await composeApi.getBgm(props.runId)
    bgm.value = b.bgm
    const c = await composeApi.getConfig(props.runId)
    const v = c.config.bgm_volume
    volume.value = Math.round((typeof v === 'number' ? v : 0.25) * 100)
    const sv = c.config.sfx_volume
    sfxVolume.value = Math.round((typeof sv === 'number' ? sv : 1) * 100)
    const brand = c.config.brand
    fillSubForm(brand && typeof brand === 'object' ? brand.subtitle : undefined)
    const ma = c.config.multi_aspect
    maPersisted.value = !!ma && typeof ma === 'object'
    maOn.value = ma?.enabled === true
    maAspects.value = Array.isArray(ma?.aspects) ? ma.aspects.filter(isKnownAspect).slice(0, 3) : []
    maStrategy.value = ma?.strategy === 'pad' ? 'pad' : 'crop'
    if (props.projectId > 0) {
      const r = await projectApi.assets(props.projectId, '?kind=audio&limit=50')
      candidates.value = r.items
    }
    const s = await composeApi.listSfx(props.runId)
    sfxCount.value = s.items.length
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

/** [M19] SFX 全局音量（显示百分数；存储 0–2，服务端同口径 clamp） */
function saveSfxVolume() {
  const v = Math.min(2, Math.max(0, sfxVolume.value / 100))
  void wrap(async () => {
    await composeApi.updateConfig(props.runId, { sfx_volume: v })
    sfxVolume.value = Math.round(v * 100)
  }, '音效音量已保存（重新合成后生效）')
}

/** 画幅勾选切换（去重；上限 3 项——编码耗时 ×(1+k)，与服务端 normalizeMultiAspect 同口径） */
function toggleAspect(v: AspectValue) {
  err.value = ''
  const i = maAspects.value.indexOf(v)
  if (i >= 0) {
    maAspects.value.splice(i, 1)
    return
  }
  if (maAspects.value.length >= 3) {
    err.value = '最多勾选 3 个画幅（每多一路 = 多一遍完整编码）'
    return
  }
  maAspects.value.push(v)
}

/** 保存多画幅：开 → 提交配置；关 → 清除 multi_aspect（合成回到单路，filter 链与现行为一致） */
function saveMultiAspect() {
  void wrap(async () => {
    if (!maOn.value) {
      await composeApi.updateConfig(props.runId, { multi_aspect: null })
      maPersisted.value = false
      maAspects.value = []
      return
    }
    if (maAspects.value.length === 0) throw new Error('启用多画幅时请至少勾选 1 个画幅')
    const cfg = { enabled: true, aspects: [...maAspects.value], strategy: maStrategy.value }
    await composeApi.updateConfig(props.runId, { multi_aspect: cfg })
    maPersisted.value = true
    maAspects.value = cfg.aspects
    maStrategy.value = cfg.strategy
  }, maOn.value ? '多画幅原生渲染已保存（重新合成后生效）' : '多画幅原生渲染已关闭（重新合成后回落单路）')
}

/** 保存字幕样式：开关开 → 提交 patch；开关关 → 清除 run 级覆盖（null 回落继承） */
function saveSubtitle() {
  void wrap(async () => {
    if (!subOn.value) {
      await composeApi.updateConfig(props.runId, { brand: { subtitle: null } })
      fillSubForm(undefined)
      return
    }
    const patch: SubtitleStyleConfig = {
      font: subFont.value.trim() || undefined,
      size_pct: storePct(subSize.value, 0.8, 6),
      color: subColor.value,
      outline_color: subOutlineColor.value,
      outline_pct: storePct(subOutline.value, 0, 0.5),
      shadow: Math.round(Math.min(8, Math.max(0, Number(subShadow.value) || 0))),
      margin_v_pct: storePct(subMarginV.value, 0, 10),
      alignment: subAlign.value,
      bold: subBold.value,
    }
    await composeApi.updateConfig(props.runId, { brand: { subtitle: patch } })
    fillSubForm(patch)
  }, subOn.value ? '字幕样式已保存（重新合成后生效）' : '字幕样式覆盖已清除（回落项目/平台配置）')
}

/** 恢复表单为默认基线（不提交；保存后生效） */
function resetSubForm() {
  fillSubForm(undefined)
  subOn.value = true
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
  <Modal title="合成设置" :width="620" @close="emit('close')">
    <div class="bg">
      <div v-if="loading" class="muted">加载中…</div>
      <template v-else>
        <!-- ===== 配乐（BGM）[M11] ===== -->
        <div class="bg-sec">
          <div class="bg-lb"><Icon name="speaker-wave" :size="12" /> 配乐（BGM）</div>
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

          <div class="bg-lb bg-lb-sub">混音音量（{{ volume }}%）<span class="muted bg-lb-tip">语音为主轨，BGM 默认 25%</span></div>
          <div class="bg-vol">
            <input v-model.number="volume" type="range" min="0" max="100" step="5" :disabled="busy" />
            <button class="btn sm" :disabled="busy" @click="saveVolume">保存音量</button>
          </div>

          <div class="bg-lb bg-lb-sub">项目音频素材<span class="muted bg-lb-tip">点击「绑定」使用（复制行，不动源资产）</span></div>
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

          <div class="bg-row">
            <button class="btn sm" :disabled="busy" @click="pickUpload">
              <Icon name="upload" :size="12" /> 上传音频并绑定
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

        <div class="bg-sep" />

        <!-- ===== 镜头音效（SFX）[M19] ===== -->
        <div class="bg-sec">
          <div class="bg-lb"><Icon name="bolt" :size="12" /> 镜头音效（SFX）</div>
          <div class="muted bg-none">
            已绑定 {{ sfxCount }} 镜{{ sfxCount ? '（各镜起点叠加配音/配乐之上）' : '——在工作台镜头卡片点「音效」绑定（上传或选项目音频）' }}
          </div>
          <div class="bg-lb bg-lb-sub">音效音量（{{ sfxVolume }}%）<span class="muted bg-lb-tip">默认 100%，上限 200%</span></div>
          <div class="bg-vol">
            <input v-model.number="sfxVolume" type="range" min="0" max="200" step="5" :disabled="busy" />
            <button class="btn sm" :disabled="busy" @click="saveSfxVolume">保存音效音量</button>
          </div>
        </div>

        <div class="bg-sep" />

        <!-- ===== 字幕样式 [M19] ===== -->
        <div class="bg-sec">
          <label class="bg-ck">
            <input v-model="subOn" type="checkbox" :disabled="busy" />
            <span class="bg-lb">自定义字幕样式<span class="muted bg-lb-tip">run 级覆盖；未启用时继承项目/平台配置或默认（字号 1.8% 高 / 底边距 2%）</span></span>
          </label>

          <div class="st-grid" :class="{ off: !subOn }">
            <div class="st-row">
              <span class="st-lb">字体</span>
              <input v-model="subFont" type="text" class="st-txt grow" spellcheck="false" placeholder="Noto Sans CJK SC" :disabled="busy || !subOn" />
            </div>
            <div class="st-row">
              <span class="st-lb">字号</span>
              <input v-model.number="subSize" type="number" class="st-num" min="0.8" max="6" step="0.1" :disabled="busy || !subOn" />
              <span class="muted">%</span>
              <span class="st-lb st-lb-2">描边</span>
              <input v-model.number="subOutline" type="number" class="st-num" min="0" max="0.5" step="0.01" :disabled="busy || !subOn" />
              <span class="muted">%</span>
              <span class="st-lb st-lb-2">阴影</span>
              <input v-model.number="subShadow" type="number" class="st-num" min="0" max="8" step="1" :disabled="busy || !subOn" />
            </div>
            <div class="st-row">
              <span class="st-lb">字色</span>
              <input v-model="subColor" type="color" class="st-color" :disabled="busy || !subOn" />
              <span class="muted mono">{{ subColor.toUpperCase() }}</span>
              <span class="st-lb st-lb-2">描边色</span>
              <input v-model="subOutlineColor" type="color" class="st-color" :disabled="busy || !subOn" />
              <span class="muted mono">{{ subOutlineColor.toUpperCase() }}</span>
            </div>
            <div class="st-row">
              <span class="st-lb">底边距</span>
              <input v-model.number="subMarginV" type="number" class="st-num" min="0" max="10" step="0.5" :disabled="busy || !subOn" />
              <span class="muted">%</span>
              <span class="st-lb st-lb-2">对齐</span>
              <select v-model.number="subAlign" class="st-sel" :disabled="busy || !subOn">
                <option :value="2">底部居中</option>
                <option :value="5">中部居中</option>
                <option :value="8">顶部居中</option>
              </select>
            </div>
            <div class="st-row">
              <label class="bg-ck">
                <input v-model="subBold" type="checkbox" :disabled="busy || !subOn" /> <span class="muted">加粗</span>
              </label>
            </div>
          </div>

          <div class="bg-row">
            <button class="btn sm" :class="{ primary: subOn }" :disabled="busy || (!subOn && !subPersisted)" @click="saveSubtitle">
              <Icon name="check" :size="12" /> {{ subOn ? '保存样式' : '清除覆盖（用继承）' }}
            </button>
            <button class="btn sm" :disabled="busy || !subOn" @click="resetSubForm">恢复默认</button>
            <span class="muted bg-lb-tip">保存后重新合成生效；字号占成片高度百分比</span>
          </div>
        </div>

        <div class="bg-sep" />

        <!-- ===== [M19] 水印 / 片头 / 片尾（run 级覆盖；显示继承值与来源） ===== -->
        <BrandSettings scope="run" :run-id="runId" :project-id="projectId" @changed="emit('changed')" />

        <div class="bg-sep" />

        <!-- ===== 多画幅原生渲染（B 路径）[M19] ===== -->
        <div class="bg-sec">
          <label class="bg-ck">
            <input v-model="maOn" type="checkbox" :disabled="busy" />
            <span class="bg-lb"><Icon name="crop" :size="12" /> 多画幅原生渲染<span class="muted bg-lb-tip">合成时一次输出多路（各画幅独立重算字幕尺寸与水印定位）</span></span>
          </label>
          <div class="ma-chips" :class="{ off: !maOn }">
            <button
              v-for="o in ASPECT_OPTIONS"
              :key="o.value"
              type="button"
              class="ma-chip"
              :class="{ on: maAspects.includes(o.value) }"
              :disabled="busy || !maOn"
              :title="o.label"
              @click="toggleAspect(o.value)"
            >
              {{ o.short }}
            </button>
          </div>
          <div class="bg-row">
            <span class="st-lb">策略</span>
            <select v-model="maStrategy" class="st-sel" :disabled="busy || !maOn">
              <option v-for="o in ASPECT_STRATEGY_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <span class="muted bg-lb-tip">{{ ASPECT_STRATEGY_OPTIONS.find((o) => o.value === maStrategy)?.hint }}</span>
          </div>
          <div class="bg-row">
            <button class="btn sm" :class="{ primary: maOn }" :disabled="busy || (!maOn && !maPersisted)" @click="saveMultiAspect">
              <Icon name="check" :size="12" /> {{ maOn ? '保存多画幅' : '清除多画幅配置' }}
            </button>
            <span class="muted bg-lb-tip">
              已勾 {{ maAspects.length }}/3{{ maOn ? ` · 编码 ×${maAspects.length + 1}（与主画幅同比例项自动跳过）` : '' }}；
              只想补一份其他比例请用运行详情页「派生画幅」（A 路径）
            </span>
          </div>
        </div>

        <div v-if="err" class="err-text">{{ err }}</div>
        <div v-if="notice" class="bg-notice"><Icon name="check" :size="12" /> {{ notice }}</div>
      </template>
    </div>

    <template #footer>
      <span class="muted bg-tip">绑定 / 音量 / 样式 / 画幅均不触发生成，需「重新合成」后进入成片</span>
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

.bg-sep {
  border-top: 1px dashed var(--border);
}

.bg-lb {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 12.5px;
}

.bg-lb-sub {
  margin-top: 4px;
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
  max-height: 220px;
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

.bg-ck {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
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

/* ===== [M19] 字幕样式表单 ===== */

.st-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  transition: opacity 0.15s;
}

.st-grid.off {
  opacity: 0.55;
}

.st-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.st-lb {
  min-width: 44px;
  font-size: 12px;
  color: var(--text-2);
}

.st-lb-2 {
  margin-left: 10px;
}

.st-txt {
  /* 覆盖全局 input width:100%（行内伸缩布局） */
  width: auto;
  min-width: 180px;
  padding: 3px 8px;
  font-size: 12.5px;
}

.st-num {
  /* 覆盖全局 input width:100% */
  width: 68px;
  padding: 3px 7px;
  font-size: 12.5px;
}

.st-sel {
  /* 覆盖全局 select width:100%：按内容宽收缩 */
  width: auto;
  max-width: 140px;
  padding: 3px 8px;
  font-size: 12.5px;
}

.st-color {
  width: 34px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: none;
  cursor: pointer;
}

/* ===== [M19] 多画幅勾选 chips ===== */

.ma-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  transition: opacity 0.15s;
}

.ma-chips.off {
  opacity: 0.55;
}

.ma-chip {
  padding: 4px 12px;
  font-size: 12.5px;
  color: var(--text-2);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s,
    background 0.15s;
}

.ma-chip:hover:not(:disabled) {
  border-color: rgb(99 102 241 / 55%);
  color: var(--text);
}

.ma-chip.on {
  color: #fff;
  background: var(--accent-h, #6366f1);
  border-color: var(--accent-h, #6366f1);
}

.ma-chip:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
