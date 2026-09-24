<script setup lang="ts">
/**
 * 集级参数热调面板（C7）：
 * - 生效值：run.input._params（run 覆盖 > 项目设置 > 模板默认；仅未执行步骤读取新值）
 * - 编辑：白名单字段（image/video/audio/llm）→ PATCH /runs/:id/params → 刷新 run
 * - 留痕：run.input._params_log 倒序（时间 + group.key: from → to）
 * - 仅 queued/running/waiting_input 可编辑；终态只读
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { runApi } from '../../lib/api'
import { fmtTime } from '../../lib/format'
import type { ParamChange, Run } from '../../lib/types'
import Icon from '../../components/common/Icon.vue'

const props = defineProps<{ run: Run; actionKeys?: string[] }>()
const emit = defineEmits<{ changed: [] }>()

interface FieldDef {
  key: string
  ph: string
  numeric?: boolean
}
interface ParamLogEntry {
  at: number
  changes: ParamChange[]
  source: string
}

/** 白名单字段（与服务端 services/run-params RULES 对齐） */
const GROUPS: Array<{ key: string; label: string; fields: FieldDef[] }> = [
  {
    key: 'image',
    label: '图像',
    fields: [
      { key: 'provider', ph: '如 dashscope' },
      { key: 'model', ph: '覆盖模板默认模型' },
      { key: 'size', ph: '宽x高（如 832x1248）' },
    ],
  },
  {
    key: 'video',
    label: '视频',
    fields: [
      { key: 'provider', ph: '如 dashscope' },
      { key: 'model', ph: '覆盖模板默认模型' },
      { key: 'resolution', ph: '480p/720p/1080p' },
      { key: 'duration', ph: '1–30 秒', numeric: true },
    ],
  },
  {
    key: 'audio',
    label: '音频',
    fields: [
      { key: 'provider', ph: '如 minimax' },
      { key: 'voice', ph: '音色 id' },
    ],
  },
  {
    key: 'llm',
    label: 'LLM',
    fields: [
      { key: 'temperature', ph: '0–2', numeric: true },
      { key: 'max_tokens', ph: '256–65536', numeric: true },
    ],
  },
]

const canEdit = computed(() =>
  ['queued', 'running', 'waiting_input'].includes(props.run.status),
)

/**
 * 参数组可见性：只暴露「本 run 步骤实际会读取」的组。
 * 服务端仅这些 action 读 ctx.settings.<group>，热调对其余步骤无意义（改了不生效），隐藏以免死字段误导：
 * ai_image→image；ai_video/ffmpeg_merge→video；tts→audio；ai_text/subtitle→llm。
 * 步骤未加载或该模板无上述动作时保守全显示，避免误隐藏。
 */
const ALL_GROUPS = ['image', 'video', 'audio', 'llm'] as const
type GroupKey = (typeof ALL_GROUPS)[number]
const ACTION_GROUP: Record<string, GroupKey> = {
  ai_image: 'image',
  ai_video: 'video',
  ffmpeg_merge: 'video',
  tts: 'audio',
  ai_text: 'llm',
  subtitle: 'llm',
}
const visibleGroupKeys = computed<GroupKey[]>(() => {
  const keys = props.actionKeys ?? []
  if (!keys.length) return [...ALL_GROUPS]
  const used = new Set<GroupKey>()
  for (const k of keys) {
    const g = ACTION_GROUP[k]
    if (g) used.add(g)
  }
  return used.size ? ALL_GROUPS.filter((g) => used.has(g)) : [...ALL_GROUPS]
})
const shownGroups = computed(() =>
  GROUPS.filter((g) => (visibleGroupKeys.value as string[]).includes(g.key)),
)

const curParams = computed<Record<string, Record<string, unknown>>>(() => {
  const raw = props.run.input?._params
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as Record<string, Record<string, unknown>>
})

const paramLog = computed<ParamLogEntry[]>(() => {
  const raw = props.run.input?._params_log
  if (!Array.isArray(raw)) return []
  return [...(raw as ParamLogEntry[])].reverse()
})

const fk = (g: string, f: string): string => `${g}.${f}`

/** 某组生效键值（模板专用；规避动态索引在 noUncheckedIndexedAccess 下的 undefined 收窄） */
function curEntries(g: string): Array<{ k: string; v: unknown }> {
  const grp = curParams.value[g]
  return grp ? Object.entries(grp).map(([k, v]) => ({ k, v })) : []
}

/** 编辑表单（字符串承载；空 = 不提交该字段；数字字段提交前转 Number） */
const form = reactive<Record<string, string>>({})

function fillForm(): void {
  for (const g of GROUPS) {
    for (const f of g.fields) {
      const v = curParams.value[g.key]?.[f.key]
      form[fk(g.key, f.key)] = v === undefined || v === null ? '' : String(v)
    }
  }
}
onMounted(fillForm)
// run 切换时重填（运行中 socket 刷新不覆盖正在编辑的内容）
watch(() => props.run.id, fillForm)

const saving = ref(false)
const hint = ref('')
const errMsg = ref('')
let hintTimer: number | undefined

function buildParams(): Record<string, Record<string, unknown>> | null {
  const out: Record<string, Record<string, unknown>> = {}
  for (const g of shownGroups.value) {
    for (const f of g.fields) {
      const raw = (form[fk(g.key, f.key)] ?? '').trim()
      if (!raw) continue
      if (f.numeric) {
        const n = Number(raw)
        if (!Number.isFinite(n)) {
          errMsg.value = `${g.label}.${f.key} 需为数字`
          return null
        }
        ;(out[g.key] ??= {})[f.key] = n
      } else {
        ;(out[g.key] ??= {})[f.key] = raw
      }
    }
  }
  return out
}

async function save(): Promise<void> {
  if (saving.value) return
  errMsg.value = ''
  hint.value = ''
  const params = buildParams()
  if (!params) return
  if (Object.keys(params).length === 0) {
    hint.value = '未填写任何参数'
    return
  }
  saving.value = true
  try {
    const res = await runApi.updateParams(props.run.id, params)
    const n = res.applied.length
    hint.value =
      n === 0
        ? '无变化（未产生留痕）'
        : `已生效 ${n} 项（后续未执行步骤读取新值）`
    emit('changed')
  } catch (e) {
    errMsg.value = e instanceof Error && e.message ? e.message : '提交失败'
  } finally {
    saving.value = false
    if (hintTimer) window.clearTimeout(hintTimer)
    hintTimer = window.setTimeout(() => {
      hint.value = ''
    }, 4000)
  }
}

function fmtVal(v: unknown): string {
  if (v === undefined || v === null) return '—'
  return String(v)
}

onBeforeUnmount(() => {
  if (hintTimer) window.clearTimeout(hintTimer)
})
</script>

<template>
  <div class="panel pp-card">
    <div class="pp-head">
      <h3><Icon name="sliders" :size="13" /> 参数热调</h3>
      <span class="pp-sub"
        >run 覆盖 &gt; 项目设置 &gt; 模板默认；仅未执行步骤读取新值</span
      >
    </div>

    <!-- 生效值 -->
    <div class="pp-cur">
      <div v-for="g in shownGroups" :key="g.key" class="pp-row">
        <span class="pp-gt">{{ g.label }}</span>
        <template v-if="curEntries(g.key).length">
          <span v-for="e in curEntries(g.key)" :key="e.k" class="pp-kv mono"
            >{{ e.k }}: {{ e.v }}</span
          >
        </template>
        <span v-else class="pp-none">未覆盖</span>
      </div>
    </div>

    <!-- 编辑（终态只读） -->
    <template v-if="canEdit">
      <div v-for="g in shownGroups" :key="g.key" class="pp-grp">
        <div class="pp-gl">{{ g.label }}</div>
        <div class="pp-fields">
          <label v-for="f in g.fields" :key="f.key" class="pp-field">
            <span class="pp-fl mono">{{ f.key }}</span>
            <input
              v-model="form[fk(g.key, f.key)]"
              type="text"
              :placeholder="f.ph"
              :aria-label="`${g.label} ${f.key}`"
            />
          </label>
        </div>
      </div>
      <div class="pp-actions">
        <button
          class="btn primary"
          type="button"
          :disabled="saving"
          @click="save"
        >
          {{ saving ? '提交中…' : '应用热调' }}
        </button>
        <span v-if="errMsg" class="pp-hint err">{{ errMsg }}</span>
        <span v-else-if="hint" class="pp-hint ok">{{ hint }}</span>
      </div>
    </template>
    <div v-else class="pp-ro">run 已终态，参数不可再调（历史留痕见下）</div>

    <!-- 留痕时间线 -->
    <div v-if="paramLog.length" class="pp-log">
      <div class="pp-gl">热调留痕</div>
      <div v-for="(it, i) in paramLog" :key="i" class="pp-logrow">
        <span class="pp-lt mono">{{ fmtTime(it.at) }}</span>
        <span class="pp-lc">
          <span v-for="(c, j) in it.changes" :key="j" class="pp-chg mono"
            >{{ c.group }}.{{ c.key }}: {{ fmtVal(c.from) }} →
            {{ fmtVal(c.to) }}</span
          >
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pp-card {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.pp-head h3 {
  margin: 0 0 3px;
  font-size: 13.5px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
}

.pp-sub {
  margin-left: 8px;
  font-size: 11px;
  color: var(--text-3);
}

.pp-cur {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.pp-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.pp-gt {
  font-size: 12px;
  color: var(--text-3);
  width: 34px;
  flex: none;
}

.pp-kv {
  font-size: 11.5px;
  color: var(--text-2);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 1px 7px;
}

.pp-none {
  font-size: 11.5px;
  color: var(--text-3);
}

.pp-grp {
  border-top: 1px dashed var(--border);
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.pp-gl {
  font-size: 11.5px;
  color: var(--text-3);
}

.pp-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px 10px;
}

.pp-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.pp-fl {
  font-size: 10.5px;
  color: var(--text-3);
}

.pp-field input {
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 8px;
  font-size: 12px;
  color: var(--text);
  font-family: inherit;
  min-width: 0;
}

.pp-field input:focus {
  outline: none;
  border-color: var(--accent);
}

.pp-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.pp-hint {
  font-size: 11.5px;
  color: var(--text-3);
}

.pp-hint.err {
  color: var(--bad);
}

.pp-hint.ok {
  color: var(--ok);
}

.pp-ro {
  font-size: 12px;
  color: var(--text-3);
}

.pp-log {
  border-top: 1px dashed var(--border);
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pp-logrow {
  display: flex;
  gap: 9px;
  font-size: 11.5px;
  align-items: baseline;
}

.pp-lt {
  color: var(--text-3);
  flex: none;
}

.pp-lc {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pp-chg {
  color: var(--text-2);
}
</style>
