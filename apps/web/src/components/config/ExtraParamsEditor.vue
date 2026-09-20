<script setup lang="ts">
/**
 * [M38] 扩展参数结构化编辑器：按服务端单一真源清单（extra-schema）动态渲染表单，
 * 替代 ApiConfigForm 高级区那个「鬼才知道配啥」的裸 JSON textarea。
 *
 * 父组件负责拉取 fields 与剥离/合并（本组件不感知 JSON 框），职责边界同 VideoCapsEditor：
 * - props.fields：本实例可结构化配置的扩展参数（provider+serviceType 决定）；
 * - props.initial：编辑回显时命中的已知 key 子集（新值留空 → 按 field.default 预填）；
 * - buildExtra()：产出「表单托管的已知 key」对象（空值省略、类型归一、必填校验）；
 * - managedKeys：本组件托管的 key 列表（父组件据此从 JSON 框剥离，二者互不覆盖）。
 *
 * 纪律：仅渲染服务端登记的字段，不猜 key；未知透传参数仍留在父组件 JSON 框（高级兜底）。
 *
 * [M39] 逐模型联动防护：fields 会随实例所选模型重拉（音色的候选/默认是模型级事实）——
 * - 脏值保护：用户手动改过的 key 在重建时保留现值，不被切模型冲掉；
 * - select 回显保护：现值不在新候选集时动态追加「当前值」项，编辑既有实例不丢值、不误导。
 */
import { computed, ref, watch } from 'vue'
import type { ExtraField } from '../../lib/types'

const props = defineProps<{
  fields: ExtraField[]
  /** 编辑回显：命中的已知 key 子集（无则 {}；新建亦传 {}） */
  initial?: Record<string, unknown> | null
}>()

/** 文本类值（text/select/number/url-list/json 统一存字符串，提交时按类型归一） */
const strVals = ref<Record<string, string>>({})
/** 布尔值（checkbox） */
const boolVals = ref<Record<string, boolean>>({})
/** 回显时该 key 是否真实存在于 extra（区分「显式 false」与「未设置」） */
const initialKeys = ref<Set<string>>(new Set())
/** [M39] 用户手动改过的 key：fields 变化重建时保留现值（切模型不冲掉手选音色） */
const dirtyKeys = ref<Set<string>>(new Set())
const err = ref('')

function markDirty(key: string): void {
  dirtyKeys.value = new Set(dirtyKeys.value).add(key)
}

/** 归一化出控件初值（字符串侧）：initial 命中优先，否则 field.default，否则空 */
function seedStr(f: ExtraField): string {
  const src = props.initial ?? {}
  const raw = f.key in src ? src[f.key] : f.default
  if (raw === undefined || raw === null) return ''
  switch (f.type) {
    case 'url-list':
      return Array.isArray(raw) ? raw.join('\n') : String(raw)
    case 'json':
      return typeof raw === 'object' ? JSON.stringify(raw, null, 2) : String(raw)
    default:
      return String(raw)
  }
}

function reseed(): void {
  const s: Record<string, string> = {}
  const b: Record<string, boolean> = {}
  const keys = new Set<string>()
  const src = props.initial ?? {}
  for (const f of props.fields) {
    // [M39] 脏值保护：用户改过的 key 保留现值（含空串），不按新 fields/initial 重建
    const dirty = dirtyKeys.value.has(f.key)
    if (f.type === 'boolean') {
      if (dirty && f.key in boolVals.value) {
        b[f.key] = boolVals.value[f.key] ?? false
      } else {
        const raw = f.key in src ? src[f.key] : f.default
        b[f.key] = typeof raw === 'boolean' ? raw : !!raw
      }
    } else {
      s[f.key] = dirty && f.key in strVals.value ? (strVals.value[f.key] ?? '') : seedStr(f)
    }
    if (f.key in src) keys.add(f.key)
  }
  strVals.value = s
  boolVals.value = b
  initialKeys.value = keys
  err.value = ''
}

/** [M39] select 回显保护：现值不在登记候选集时追加「当前值」项（不丢值、不误导；提交仍按现值写回） */
function selectOptions(f: ExtraField): { value: string; label: string }[] {
  const opts = f.options ?? []
  const cur = String(strVals.value[f.key] ?? '').trim()
  if (cur && !opts.some((o) => o.value === cur)) return [...opts, { value: cur, label: `${cur}（当前值）` }]
  return opts
}

watch(() => [props.fields, props.initial], reseed, { immediate: true, deep: true })

const managedKeys = computed(() => props.fields.map((f) => f.key))

function fail(msg: string): { ok: false; values: Record<string, unknown>; error: string } {
  err.value = msg
  return { ok: false, values: {}, error: msg }
}

/** 组装并校验：产出表单托管的已知 key（空值省略、类型归一、必填/JSON 校验） */
function buildExtra(): { ok: boolean; values: Record<string, unknown>; error?: string } {
  err.value = ''
  const out: Record<string, unknown> = {}
  for (const f of props.fields) {
    if (f.type === 'boolean') {
      if (boolVals.value[f.key] === true) out[f.key] = true
      else if (initialKeys.value.has(f.key)) out[f.key] = false
      continue
    }
    const s = String(strVals.value[f.key] ?? '').trim()
    if (f.type === 'number') {
      if (!s) {
        if (f.required) return fail(`「${f.label}」为必填`)
        continue
      }
      const n = Number(s)
      if (!Number.isFinite(n)) return fail(`「${f.label}」需为数字`)
      out[f.key] = n
      continue
    }
    if (f.type === 'url-list') {
      const lines = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
      if (lines.length) out[f.key] = lines
      continue
    }
    if (f.type === 'json') {
      if (!s) continue
      try {
        const parsed = JSON.parse(s) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail(`「${f.label}」需为 JSON 对象`)
        out[f.key] = parsed
      } catch {
        return fail(`「${f.label}」JSON 语法错误：请检查双引号与括号配对`)
      }
      continue
    }
    // text / select
    if (s) out[f.key] = s
    else if (f.required) return fail(`「${f.label}」为必填`)
  }
  return { ok: true, values: out }
}

defineExpose({ buildExtra, managedKeys })
</script>

<template>
  <section v-if="fields.length" class="xparams">
    <div class="xhead">
      <b>扩展参数</b>
      <span class="note">以下选项已按供应商能力自动列出，留空即用系统默认</span>
    </div>

    <div v-for="f in fields" :key="f.key" class="xfld">
      <!-- 开关 -->
      <label v-if="f.type === 'boolean'" class="xcheck">
        <input v-model="boolVals[f.key]" type="checkbox" @change="markDirty(f.key)" />
        <span>{{ f.label }}</span>
      </label>

      <!-- 下拉 -->
      <label v-else-if="f.type === 'select'" class="xin">
        <span class="xlab">{{ f.label }}<em v-if="f.required" class="req">必填</em></span>
        <select v-model="strVals[f.key]" @change="markDirty(f.key)">
          <option value="">—— 使用默认 ——</option>
          <option v-for="o in selectOptions(f)" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </label>

      <!-- 多行 URL -->
      <label v-else-if="f.type === 'url-list'" class="xin">
        <span class="xlab">{{ f.label }}</span>
        <textarea v-model="strVals[f.key]" rows="2" spellcheck="false" placeholder="每行一个 URL" @input="markDirty(f.key)"></textarea>
      </label>

      <!-- JSON -->
      <label v-else-if="f.type === 'json'" class="xin">
        <span class="xlab">{{ f.label }}</span>
        <textarea v-model="strVals[f.key]" class="code" rows="2" spellcheck="false" :placeholder="f.placeholder || '{}'" @input="markDirty(f.key)"></textarea>
      </label>

      <!-- 数字 / 文本 -->
      <label v-else class="xin">
        <span class="xlab">{{ f.label }}<em v-if="f.required" class="req">必填</em></span>
        <input v-model="strVals[f.key]" :type="f.type === 'number' ? 'number' : 'text'" :placeholder="f.placeholder || ''" @input="markDirty(f.key)" />
      </label>

      <span v-if="f.help" class="note">{{ f.help }}</span>
    </div>

    <span v-if="err" class="note warn">{{ err }}</span>
  </section>
</template>

<style scoped>
.xparams {
  margin: 2px 0 12px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
}

.xhead {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 10px;
}

.xhead b {
  font-size: 13px;
  color: var(--text-1);
}

.xfld {
  margin-bottom: 10px;
}

.xfld:last-of-type {
  margin-bottom: 0;
}

.xin {
  display: block;
  font-size: 12px;
  color: var(--text-2);
}

.xlab {
  display: block;
  margin-bottom: 4px;
}

.req {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10.5px;
  font-style: normal;
  color: var(--warn);
  border: 1px solid var(--warn);
}

.xin input,
.xin select,
.xin textarea {
  display: block;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  background: var(--bg);
  color: var(--text-1);
}

.xin textarea {
  resize: vertical;
}

.xcheck {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-1);
  cursor: pointer;
}

.code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.note {
  display: block;
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--text-3);
  word-break: break-word;
}

.note.warn {
  color: var(--warn);
}
</style>
