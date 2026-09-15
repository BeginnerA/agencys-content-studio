<script setup lang="ts">
/**
 * [M19] 成片多画幅派生弹窗（spec §2.3 ⑤ A 路径：POST /runs/:id/derive-aspect）
 * - 源 = 本 run 最新 final_video（无成片 → 空态 + 生成禁用）
 * - 画幅四选（与源同比例者置灰）+ 策略 crop/pad；目标尺寸为前端镜像预览，真实尺寸服务端计算
 * - 已派生列表：A 路径件按 params.source_asset_id 命中本源成片，B 路径（合成内原生）件本就在 run 产物内
 * - 幂等复用：同画幅 + 同策略 + 同源成片 → 服务端直接返回既有资产（notice 明示未重复编码）
 */
import { computed, onMounted, ref } from 'vue'
import { ASPECT_OPTIONS, ASPECT_STRATEGY_OPTIONS, aspectLabel, aspectOfSlug, isKnownAspect, isSameAspect, resolveAspectSize } from '../lib/aspect'
import { composeApi, projectApi } from '../lib/api'
import { fmtSize, fmtTime } from '../lib/format'
import type { Asset, AspectStrategy, AspectValue, RunAssetLite } from '../lib/types'
import Icon from './Icon.vue'
import Modal from './Modal.vue'

const props = defineProps<{ runId: number; projectId: number; runAssets: RunAssetLite[] }>()
const emit = defineEmits<{ close: []; changed: [] }>()

const loading = ref(true)
const busy = ref(false)
const err = ref('')
const notice = ref('')
const aspect = ref<AspectValue>('9:16')
const strategy = ref<AspectStrategy>('crop')
const derived = ref<Asset[]>([])

/** 源成片 = 本 run 产物中最新 final_video（runAssets 按 id 升序，与「标记发布」预选同规则） */
const source = computed<RunAssetLite | null>(() => {
  const list = props.runAssets.filter((a) => a.purpose === 'final_video')
  return list.length ? list[list.length - 1]! : null
})

/** 源尺寸（资产缺 width/height → null：不预览目标尺寸，服务端自行 ffprobe） */
const srcSize = computed<{ w: number; h: number } | null>(() => {
  const w = source.value?.width ?? null
  const h = source.value?.height ?? null
  return w && h ? { w, h } : null
})

const target = computed<{ w: number; h: number } | null>(() =>
  srcSize.value ? resolveAspectSize(srcSize.value.w, srcSize.value.h, aspect.value) : null,
)

function sameAspect(v: AspectValue): boolean {
  return srcSize.value ? isSameAspect(srcSize.value.w, srcSize.value.h, v) : false
}

// 默认选中首个与源不同比例的画幅（同比例派生 = 无意义重编码）；源尺寸未知则保留缺省 9:16
const firstDiff = ASPECT_OPTIONS.find((o) => !sameAspect(o.value))
if (firstDiff) aspect.value = firstDiff.value

function paramsOf(a: Asset): Record<string, unknown> {
  return a.params && typeof a.params === 'object' ? (a.params as Record<string, unknown>) : {}
}

/** 派生件画幅（params.aspect 优先，回退 tags slug 反解） */
function aspectOf(a: Asset): AspectValue | null {
  const p = paramsOf(a)
  if (isKnownAspect(p['aspect'])) return p['aspect']
  const slug = (a.tags ?? []).find((t) => /^\d+x\d+$/.test(t))
  return slug ? aspectOfSlug(slug) : null
}

function strategyOf(a: Asset): AspectStrategy {
  return paramsOf(a)['strategy'] === 'pad' ? 'pad' : 'crop'
}

function isNative(a: Asset): boolean {
  return paramsOf(a)['source'] === 'multi_render'
}

/** 是否属本 run：B 路径件在 run 产物内；A 路径件按 source_asset_id 命中本 run 任一成片 */
function belongsToRun(a: Asset): boolean {
  if (props.runAssets.some((r) => r.id === a.id)) return true
  const sid = paramsOf(a)['source_asset_id']
  return typeof sid === 'number' && props.runAssets.some((r) => r.purpose === 'final_video' && r.id === sid)
}

/** 同画幅 + 同策略的既有派生件（生成会命中服务端幂等复用） */
function existingOf(v: AspectValue, s: AspectStrategy): Asset | null {
  return derived.value.find((a) => aspectOf(a) === v && strategyOf(a) === s) ?? null
}

const existing = computed<Asset | null>(() => existingOf(aspect.value, strategy.value))

onMounted(async () => {
  try {
    if (props.projectId > 0) {
      const r = await projectApi.assets(props.projectId, '?kind=video&purpose=final_video_derived&limit=200')
      derived.value = r.items.filter(belongsToRun)
    }
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
})

async function generate() {
  if (!source.value || busy.value || sameAspect(aspect.value)) return
  busy.value = true
  err.value = ''
  notice.value = ''
  try {
    const r = await composeApi.deriveAspect(props.runId, aspect.value, strategy.value)
    if (!derived.value.some((a) => a.id === r.asset.id)) derived.value = [r.asset, ...derived.value]
    const size = r.asset.width && r.asset.height ? `${r.asset.width}x${r.asset.height}` : ''
    notice.value = r.reused
      ? `已复用既有派生画幅 ${aspect.value}${size ? `（${size}）` : ''}——同画幅 + 同策略 + 同源成片，未重复编码`
      : `派生画幅 ${aspect.value} 已生成${size ? `（${size}）` : ''}，已入库为项目资产（资产 #${r.asset.id}）`
    emit('changed')
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal title="派生画幅 · 多比例分发" :width="560" @close="emit('close')">
    <div class="ax">
      <div v-if="loading" class="muted">加载中…</div>
      <template v-else>
        <!-- ===== 源成片 ===== -->
        <div class="ax-sec">
          <div class="ax-lb"><Icon name="film" :size="12" /> 源成片</div>
          <div v-if="source" class="ax-row">
            <Icon name="video" :size="13" />
            <span class="ax-nm" :title="source.name">{{ source.name }}</span>
            <span class="muted mono">{{ source.width && source.height ? `${source.width}x${source.height}` : '尺寸未知' }}</span>
            <span class="muted mono">{{ fmtSize(source.fileSize) }}</span>
            <span class="grow" />
            <a class="ax-mini" :href="`/api/v1/assets/${source.id}/file`" target="_blank" rel="noopener">打开</a>
          </div>
          <div v-else class="muted ax-none">该 run 尚无成片——请先在镜头工作台「重新合成」，再回来派生其他画幅</div>
        </div>

        <!-- ===== 画幅选择 ===== -->
        <div class="ax-sec">
          <div class="ax-lb"><Icon name="arrange" :size="12" /> 目标画幅</div>
          <div class="ax-chips">
            <button
              v-for="o in ASPECT_OPTIONS"
              :key="o.value"
              type="button"
              class="ax-chip"
              :class="{ on: aspect === o.value }"
              :disabled="!source || busy || sameAspect(o.value)"
              :title="sameAspect(o.value) ? '与源成片同比例，无需派生' : o.label"
              @click="aspect = o.value; notice = ''"
            >
              {{ o.short }}
              <span v-if="existingOf(o.value, strategy)" class="ax-dot" title="该画幅 + 当前策略已派生过">·</span>
            </button>
          </div>
          <div class="muted ax-hint">
            {{ ASPECT_OPTIONS.find((o) => o.value === aspect)?.label }}
            <template v-if="target"> · 目标 {{ target.w }}x{{ target.h }}（不放大，向下取偶）</template>
          </div>
        </div>

        <!-- ===== 策略 ===== -->
        <div class="ax-sec">
          <div class="ax-lb"><Icon name="crop" :size="12" /> 适配策略</div>
          <div class="ax-chips">
            <button
              v-for="o in ASPECT_STRATEGY_OPTIONS"
              :key="o.value"
              type="button"
              class="ax-chip"
              :class="{ on: strategy === o.value }"
              :disabled="!source || busy"
              :title="o.hint"
              @click="strategy = o.value; notice = ''"
            >
              {{ o.label }}
            </button>
          </div>
          <div class="muted ax-hint">{{ ASPECT_STRATEGY_OPTIONS.find((o) => o.value === strategy)?.hint }}</div>
        </div>

        <!-- ===== 生成 ===== -->
        <div class="ax-row">
          <button class="btn sm primary" :disabled="!source || busy || sameAspect(aspect)" @click="generate">
            <Icon name="download" :size="12" /> {{ busy ? '派生中（本地重编码，请稍候）…' : '生成该画幅' }}
          </button>
          <span v-if="existing && !busy" class="muted ax-hint">
            已存在资产 #{{ existing.id }}——点击将复用（不重复编码）
          </span>
        </div>

        <!-- ===== 已派生 ===== -->
        <div class="ax-sec">
          <div class="ax-lb"><Icon name="photo" :size="12" /> 本 run 派生产物（{{ derived.length }}）</div>
          <div v-if="derived.length" class="ax-list">
            <div v-for="a in derived" :key="a.id" class="ax-row">
              <Icon name="video" :size="13" />
              <span class="ax-tag" :title="aspectLabel(aspectOf(a) ?? '')">{{ aspectOf(a) ?? '—' }}</span>
              <span class="muted">{{ strategyOf(a) === 'pad' ? '补边' : '裁切' }}</span>
              <span class="muted mono">{{ a.width && a.height ? `${a.width}x${a.height}` : '—' }}</span>
              <span class="muted mono">{{ fmtSize(a.fileSize) }}</span>
              <span v-if="isNative(a)" class="badge" title="合成时一并多路原生渲染（B 路径）">原生多路</span>
              <span class="ax-nm" :title="a.name">{{ a.name }}</span>
              <span class="grow" />
              <span class="muted mono">{{ fmtTime(a.updatedAt) }}</span>
              <a class="ax-mini" :href="a.urls.file" target="_blank" rel="noopener">打开</a>
            </div>
          </div>
          <div v-else class="muted ax-none">还没有派生产物——选好画幅与策略后点「生成该画幅」</div>
        </div>

        <div v-if="err" class="err-text">{{ err }}</div>
        <div v-if="notice" class="ax-notice"><Icon name="check" :size="12" /> {{ notice }}</div>
      </template>
    </div>

    <template #footer>
      <span class="muted ax-tip">A 路径对成片二次编码；若需各画幅独立构图（字幕/水印按比例重算），请在「合成设置 · 多画幅原生渲染」勾选后重新合成</span>
      <button class="btn" @click="emit('close')">关闭</button>
    </template>
  </Modal>
</template>

<style scoped>
.ax {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 13px;
}

.ax-sec {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.ax-lb {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 12.5px;
}

.ax-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.grow {
  flex: 1;
}

.ax-nm {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ax-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ax-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 4px 12px;
  font-size: 12.5px;
  color: var(--text-2);
  background: var(--panel-2, var(--panel));
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}

.ax-chip:hover:not(:disabled) {
  border-color: rgb(99 102 241 / 55%);
  color: var(--text);
}

.ax-chip.on {
  color: #fff;
  background: var(--accent-h, #6366f1);
  border-color: var(--accent-h, #6366f1);
}

.ax-chip:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.ax-dot {
  font-size: 14px;
  line-height: 12px;
}

.ax-hint {
  font-size: 11.5px;
}

.ax-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
}

.ax-list .ax-row {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 10px;
}

.ax-tag {
  flex: none;
  font-weight: 600;
  font-size: 12px;
  color: var(--text);
}

.ax-mini {
  border: none;
  background: none;
  color: var(--accent-h);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
  text-decoration: none;
}

.ax-mini:hover {
  background: var(--accent-weak);
}

.ax-none {
  font-size: 12px;
}

.ax-notice {
  display: flex;
  align-items: center;
  gap: 7px;
  background: var(--ok-weak);
  color: var(--ok);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12.5px;
}

.ax-tip {
  margin-right: auto;
  font-size: 11.5px;
}
</style>
