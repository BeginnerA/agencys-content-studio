<script setup lang="ts">
import { ref } from 'vue'
import type {
  Asset,
  PrefillSource,
  Publication,
  TemplateDetail,
  TemplateInputDef,
} from '../../lib/types'
import { fmtTime, PLATFORM_TEXT, purposeText } from '../../lib/format'
import { uploadFiles } from '../../lib/api'
import AssetPreviewer from '../asset/previewer/index.vue'
import Icon from '../common/Icon.vue'
import ProvenanceBadge from '../common/ProvenanceBadge.vue'

const props = defineProps<{
  tpl: TemplateDetail | null
  /** 项目资产（files 类字段的选择源） */
  assets: Asset[]
  /** 项目发布记录（publications 类字段的选择源，复盘回灌专用） */
  publications?: Publication[]
  /** 受控值（单组输入） */
  values: Record<string, unknown>
  /** 自动预填来源映射（命中 last_run / brief 的字段标 chip；用户编辑后父层剔除） */
  sources?: Record<string, PrefillSource>
  /** 紧凑模式（批量表单行内：text 单行、files 折叠为计数按钮） */
  dense?: boolean
  /** 项目 id：传入则 files 字段支持表单内直接上传素材（无需先回项目页） */
  projectId?: number
}>()

const emit = defineEmits<{
  change: [key: string, value: unknown]
  /** 表单内上传成功：把新资产回传父层并入 assets 选择源（去重由父层负责） */
  'assets-appended': [added: Asset[]]
  /** 上传失败/提示（父层可选展示） */
  notice: [message: string]
}>()

/** dense 模式下展开的 files 字段 key */
const openKey = ref('')

/** 表单内上传：隐藏 input 触发中的 files 字段 key + 进行中标记 */
const fileInput = ref<HTMLInputElement | null>(null)
const uploadTargetKey = ref('')
const uploading = ref(false)

function acceptOf(key: string): string {
  const inp = props.tpl?.inputs.find((i) => i.key === key)
  return inp?.accept?.length ? inp.accept.join(',') : ''
}

/**
 * accept 扩展名 → 资产 kind 映射（与服务端 storage.kindByExt 同源）。
 * docx/epub 导入时已在服务端转成 md 文本资产，故归 text。
 */
const EXT_KIND: Record<string, string> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', bmp: 'image',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video',
  mp3: 'audio', wav: 'audio', aac: 'audio', m4a: 'audio', flac: 'audio',
  md: 'text', txt: 'text', json: 'text', yaml: 'text', yml: 'text', csv: 'text',
  srt: 'text', vtt: 'text', log: 'text', ini: 'text', toml: 'text',
  docx: 'text', epub: 'text',
}
const KIND_WORDS = new Set(['image', 'video', 'audio', 'text', 'archive'])

/** 单个资产是否契合该 files 字段的 accept（无 accept / 无法识别的 accept → 一律放行，绝不误藏） */
function assetMatchesAccept(asset: Asset, accept?: string[]): boolean {
  if (!accept?.length) return true
  const exts = new Set<string>()
  const kinds = new Set<string>()
  for (const raw of accept) {
    const t = raw.trim().toLowerCase()
    if (!t) continue
    if (t.startsWith('.')) {
      const e = t.slice(1)
      exts.add(e)
      const k = EXT_KIND[e]
      if (k) kinds.add(k)
    } else if (KIND_WORDS.has(t)) {
      kinds.add(t)
    }
  }
  // accept 既非扩展名也非已知 kind 词（历史/自定义写法）→ 无法判定，放行避免误藏合法资产
  if (!exts.size && !kinds.size) return true
  const aext = (asset.ext || '').toLowerCase().replace(/^\./, '')
  if (aext && exts.has(aext)) return true
  if (asset.kind && kinds.has(asset.kind)) return true
  return false
}

/** files 字段的候选列表：按 accept 智能过滤后的项目资产 */
function visibleAssets(inp: TemplateInputDef): Asset[] {
  return props.assets.filter((a) => assetMatchesAccept(a, inp.accept))
}

/** 点击「上传素材」→ 记录目标字段并打开系统文件选择器 */
function triggerUpload(key: string) {
  if (!props.projectId || uploading.value) return
  uploadTargetKey.value = key
  // 先命令式写 accept 再 click：避免 :accept 响应式绑定要到 nextTick 才更新、首次点击过滤失效
  if (fileInput.value) fileInput.value.accept = acceptOf(key)
  fileInput.value?.click()
}

/** 文件选定 → 上传入库 → 回传父层并入选择源 → 自动勾选新资产 */
async function onFilesChosen(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = '' // 清空以便重复选同一文件
  const key = uploadTargetKey.value
  if (!key || !props.projectId || !files.length) return
  uploading.value = true
  try {
    const created = await uploadFiles(props.projectId, 'source', files)
    if (created.length) {
      emit('assets-appended', created)
      // 自动勾选本次上传的资产（去重合并到当前已选）
      const merged = [...picked(key)]
      for (const a of created) if (!merged.includes(a.id)) merged.push(a.id)
      emit('change', key, merged)
    }
    emit('notice', `已上传 ${created.length} 个素材并勾选`)
  } catch (err) {
    emit('notice', `上传失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    uploading.value = false
    uploadTargetKey.value = ''
  }
}

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

/** 自动预填来源（ 改挂统一徽标；仅标注本轮新增的自动值，模板自身默认不加噪） */
function srcChip(k: string): string {
  const s = props.sources?.[k]
  if (s === 'last_run') return '沿用上次运行'
  if (s === 'brief') return '来自项目简介'
  return ''
}
</script>

<template>
  <div class="tif" :class="{ dense }">
    <!-- 表单内上传：全局隐藏 input，由 files 字段的「上传素材」按钮触发 -->
    <input
      v-if="projectId"
      ref="fileInput"
      type="file"
      multiple
      :accept="uploadTargetKey ? acceptOf(uploadTargetKey) : ''"
      class="tif-file-input"
      @change="onFilesChosen"
    />
    <template v-for="inp in tpl?.inputs ?? []" :key="inp.key">
      <label v-if="inp.kind === 'text'" class="fld">
        {{ inp.label }} <span v-if="inp.required" class="req">*</span>
        <ProvenanceBadge v-if="srcChip(inp.key)" kind="auto" :text="srcChip(inp.key)" title="系统自动预填，可直接修改" />
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
        <ProvenanceBadge v-if="srcChip(inp.key)" kind="auto" :text="srcChip(inp.key)" title="系统自动预填，可直接修改" />
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
          <button
            v-if="projectId"
            type="button"
            class="btn sm upl"
            :disabled="uploading"
            @click="triggerUpload(inp.key)"
          >
            <Icon name="upload" :size="12" /> {{ uploading ? '上传中…' : '上传' }}
          </button>
          <div v-if="openKey === inp.key" class="picklist">
            <label v-for="a in visibleAssets(inp)" :key="a.id" class="opt">
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
            <div v-if="!visibleAssets(inp).length" class="muted">
              {{
                assets.length
                  ? `项目内无符合「${inp.accept?.join(' / ') || inp.label}」的资产——点上方上传` 
                  : '项目暂无资产'
              }}
            </div>
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
            <button
              v-if="projectId"
              type="button"
              class="btn sm upl"
              :disabled="uploading"
              @click="triggerUpload(inp.key)"
            >
              <Icon name="upload" :size="12" /> {{ uploading ? '上传中…' : '上传素材' }}
            </button>
          </div>
          <p v-if="!inp.required" class="tif-hint muted">
            可留空；不必全选，只勾选与本次创作相关的文件即可（多选会一并作为参考叠加，选多无关项会稀释重点）。
          </p>
          <div v-if="visibleAssets(inp).length" class="picklist">
            <label v-for="a in visibleAssets(inp)" :key="a.id" class="opt">
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
          <div v-else class="muted">
            {{
              assets.length
                ? `项目里有 ${assets.length} 个资产，但没有符合「${inp.accept?.join(' / ') || inp.label}」类型的——点上方「上传素材」添加`
                : '项目暂无资产——点上方「上传素材」直接添加，或先到项目页上传。'
            }}
          </div>
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
.tif-file-input {
  display: none;
}

.upl {
  margin-left: 8px;
  vertical-align: middle;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

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
