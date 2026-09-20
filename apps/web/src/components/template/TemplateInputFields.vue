<script setup lang="ts">
import { ref } from 'vue'
import type {
  Asset,
  PrefillSource,
  Publication,
  TemplateDetail,
} from '../../lib/types'
import { fmtTime, PLATFORM_TEXT, purposeText } from '../../lib/format'
import AssetPreviewer from '../asset/previewer/index.vue'
import Icon from '../common/Icon.vue'

const props = defineProps<{
  tpl: TemplateDetail | null
  /** 项目资产（files 类字段的选择源） */
  assets: Asset[]
  /** 项目发布记录（publications 类字段的选择源，复盘回灌专用） */
  publications?: Publication[]
  /** 受控值（单组输入） */
  values: Record<string, unknown>
  /** [M34] 自动预填来源映射（命中 last_run / brief 的字段标 chip；用户编辑后父层剔除） */
  sources?: Record<string, PrefillSource>
  /** 紧凑模式（批量表单行内：text 单行、files 折叠为计数按钮） */
  dense?: boolean
}>()

const emit = defineEmits<{ change: [key: string, value: unknown] }>()

/** dense 模式下展开的 files 字段 key */
const openKey = ref('')

function textOf(k: string): string {
  const v = props.values[k]
  return typeof v === 'string' ? v : ''
}
function numOf(k: string): string {
  const v = props.values[k]
  return v === undefined || v === '' ? '' : String(v)
}
function picked(k: string): number[] {
  return (props.values[k] as number[] | undefined) ?? []
}
function onText(k: string, e: Event) {
  emit('change', k, (e.target as HTMLTextAreaElement).value)
}
function onNum(k: string, e: Event) {
  emit('change', k, (e.target as HTMLInputElement).value)
}
function toggleAsset(k: string, id: number) {
  const arr = [...picked(k)]
  const i = arr.indexOf(id)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(id)
  emit('change', k, arr)
}

/** 预览：点击候选项的预览入口，打开统一资产查看器（←/→ 翻看候选；Esc 关闭） */
const previewIdx = ref<number | null>(null)

/** 发布记录展示标签：登记标题 > 关联资产名 > 兜底（旧记录无标题时不至于满屏「无标题」） */
function pubLabel(p: Publication): string {
  if (p.title?.trim()) return p.title.trim()
  const a = p.assetId ? props.assets.find((x) => x.id === p.assetId) : undefined
  return a?.name ?? '未命名发布'
}

function openPreview(id: number) {
  const i = props.assets.findIndex((a) => a.id === id)
  if (i >= 0) previewIdx.value = i
}

/** [M34] 自动预填来源 chip（仅标注本轮新增的 Tier A/B 自动值；模板自身默认不加噪） */
function srcChip(k: string): string {
  const s = props.sources?.[k]
  if (s === 'last_run') return '↺ 沿用上次运行'
  if (s === 'brief') return '✦ 来自项目简介'
  return ''
}
</script>

<template>
  <div class="tif" :class="{ dense }">
    <template v-for="inp in tpl?.inputs ?? []" :key="inp.key">
      <label v-if="inp.kind === 'text'" class="fld">
        {{ inp.label }} <span v-if="inp.required" class="req">*</span>
        <em v-if="srcChip(inp.key)" class="src-chip">{{ srcChip(inp.key) }}</em>
        <textarea
          v-if="!dense"
          :value="textOf(inp.key)"
          rows="3"
          @input="onText(inp.key, $event)"
        />
        <input
          v-else
          type="text"
          :value="textOf(inp.key)"
          @input="onText(inp.key, $event)"
        />
      </label>

      <label v-else-if="inp.kind === 'int'" class="fld">
        {{ inp.label }} <span v-if="inp.required" class="req">*</span>
        <em v-if="srcChip(inp.key)" class="src-chip">{{ srcChip(inp.key) }}</em>
        <input
          type="number"
          :value="numOf(inp.key)"
          @input="onNum(inp.key, $event)"
        />
      </label>

      <label v-else-if="inp.kind === 'bool'" class="fld row">
        <input
          type="checkbox"
          :checked="values[inp.key] === true"
          @change="
            emit('change', inp.key, ($event.target as HTMLInputElement).checked)
          "
        />
        <span>{{ inp.label }}</span>
        <em v-if="inp.default === true" class="muted" style="font-size: 11px"
          >默认开启</em
        >
      </label>

      <div v-else-if="inp.kind === 'files'" class="fld">
        <template v-if="dense">
          <button
            type="button"
            class="btn sm"
            @click="openKey = openKey === inp.key ? '' : inp.key"
          >
            {{ inp.label }}（{{ picked(inp.key).length }}）
            <span class="caret">{{ openKey === inp.key ? '▴' : '▾' }}</span>
          </button>
          <div v-if="openKey === inp.key" class="picklist">
            <label v-for="a in assets" :key="a.id" class="opt">
              <input
                type="checkbox"
                :checked="picked(inp.key).includes(a.id)"
                @change="toggleAsset(inp.key, a.id)"
              />
              <span>#{{ a.id }}</span> {{ a.name }}
              <span class="opt-tail">
                <em>{{ purposeText(a.purpose) }}</em>
                <button
                  type="button"
                  class="pv"
                  :title="`预览「${a.name}」内容`"
                  :aria-label="`预览 ${a.name} 内容`"
                  @click.stop.prevent="openPreview(a.id)"
                >
                  <Icon name="eye" :size="12" />
                </button>
              </span>
            </label>
            <div v-if="!assets.length" class="muted">项目暂无资产</div>
          </div>
        </template>
        <template v-else>
          <div class="tlabel">
            {{ inp.label }}
            <span class="req-badge" :class="inp.required ? 'must' : 'opt'">{{
              inp.required ? '必填' : '选填'
            }}</span>
            <em v-if="inp.accept?.length" class="acc-hint"
              >仅 {{ inp.accept.join(' / ') }}</em
            >
            <span class="muted">（选 {{ picked(inp.key).length }} 项）</span>
          </div>
          <p v-if="!inp.required" class="tif-hint muted">
            可留空；不必全选，只勾选与本次创作相关的文件即可（多选会一并作为参考叠加，选多无关项会稀释重点）。
          </p>
          <div v-if="assets.length" class="picklist">
            <label v-for="a in assets" :key="a.id" class="opt">
              <input
                type="checkbox"
                :checked="picked(inp.key).includes(a.id)"
                @change="toggleAsset(inp.key, a.id)"
              />
              <span>#{{ a.id }}</span> {{ a.name }}
              <span class="opt-tail">
                <em>{{ purposeText(a.purpose) }}</em>
                <button
                  type="button"
                  class="pv"
                  :title="`预览「${a.name}」内容`"
                  :aria-label="`预览 ${a.name} 内容`"
                  @click.stop.prevent="openPreview(a.id)"
                >
                  <Icon name="eye" :size="12" />
                </button>
              </span>
            </label>
          </div>
          <div v-else class="muted">项目暂无资产——可先在项目页上传素材。</div>
        </template>
      </div>

      <div v-else-if="inp.kind === 'publications'" class="fld">
        <div class="tlabel">
          {{ inp.label }}
          <span class="req-badge" :class="inp.required ? 'must' : 'opt'">{{
            inp.required ? '必填' : '选填'
          }}</span>
          <span class="muted">（选 {{ picked(inp.key).length }} 项）</span>
        </div>
        <p class="tif-hint muted">
          直接勾选要复盘的发布记录即可，无需再导出/上传
          CSV；勾选后系统自动汇总各项指标，并带出每条发布对应的创作来源链路。
        </p>
        <div v-if="publications?.length" class="picklist">
          <label v-for="p in publications" :key="p.id" class="opt">
            <input
              type="checkbox"
              :checked="picked(inp.key).includes(p.id)"
              @change="toggleAsset(inp.key, p.id)"
            />
            <span class="pub-title">{{ pubLabel(p) }}</span>
            <span class="opt-tail">
              <em>{{ PLATFORM_TEXT[p.platform] ?? p.platform }}</em>
              <em v-if="p.metrics?.views">曝光 {{ p.metrics.views }}</em>
              <em>{{ fmtTime(p.publishedAt) }}</em>
            </span>
          </label>
        </div>
        <div v-else class="muted">
          本项目暂无发布记录——请先在「图文笔记」等成品运行后点「标记发布」登记。
        </div>
      </div>
    </template>

    <!-- 预览：点击候选项的预览入口打开统一查看器（←/→ 翻看候选；Esc 关闭） -->
    <AssetPreviewer
      v-if="previewIdx !== null"
      :assets="assets"
      :index="previewIdx"
      @close="previewIdx = null"
    />
  </div>
</template>

<style scoped>
.caret {
  font-size: 10px;
  color: var(--text-3);
}

.tlabel {
  font-size: 12px;
  color: var(--text-2);
}

.req-badge {
  display: inline-block;
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10px;
  font-style: normal;
  vertical-align: 1px;
}

.req-badge.must {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 14%, transparent);
}

.req-badge.opt {
  color: var(--text-3);
  background: var(--hover);
}

.acc-hint {
  margin-left: 4px;
  font-size: 11px;
  font-style: normal;
  color: var(--text-3);
}

.tif-hint {
  margin: 4px 0 0;
  font-size: 11.5px;
  line-height: 1.5;
}

.src-chip {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10px;
  font-style: normal;
  vertical-align: 1px;
  color: var(--accent-h);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.picklist {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 8px;
  margin-top: 5px;
}

.dense .picklist {
  max-height: 150px;
}

.opt {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  padding: 2px 4px;
  cursor: pointer;
}

.opt:hover {
  background: var(--hover);
  border-radius: 5px;
}

.opt-tail {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.opt-tail em {
  color: var(--text-3);
  font-style: normal;
  font-size: 11px;
}

.pub-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
}

/* 预览按钮：图标按钮（aria-label 齐备），hover/focus 状态明确 */
.pv {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 3px;
  border: none;
  border-radius: 5px;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  line-height: 0;
}

.pv:hover {
  color: var(--accent-h);
  background: var(--hover);
}
</style>
