<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Modal from '../common/Modal.vue'
import Icon from '../common/Icon.vue'
import TemplateInputFields from '../template/TemplateInputFields.vue'
import type { Asset, TemplateDetail, TemplateMeta } from '../../lib/types'
import { batchApi, projectApi, templateApi } from '../../lib/api'
import { genreText, groupTemplates } from '../../lib/scene'

const props = defineProps<{ projectId: number; defaultTemplateKey?: string }>()
const emit = defineEmits<{ done: [batchId: number]; close: [] }>()

const loading = ref(true)
const templates = ref<TemplateMeta[]>([])
/** [入口改造] 模板下拉按场景分组（optgroup） */
const tplGroups = computed(() => groupTemplates(templates.value))
const tplKey = ref('')
const tpl = ref<TemplateDetail | null>(null)
const assets = ref<Asset[]>([])
const err = ref('')

// 输入组：每行完整一份值（独立可改；添加行=复制末行并递增 episode 类 int）
const rows = ref<Array<Record<string, unknown>>>([])
const name = ref('')
const maxc = ref(1)
const busy = ref(false)

// 批量粘贴 JSON
const showPaste = ref(false)
const pasteText = ref('')

/** 按模板 inputs 构造一行默认值（与 RunFormModal 同口径） */
function makeRow(): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  const t = tpl.value
  if (!t) return row
  const defaults = (t.defaults ?? {}) as Record<string, unknown>
  for (const inp of t.inputs) {
    const d = inp.default !== undefined ? inp.default : defaults[inp.key]
    if (inp.kind === 'int') row[inp.key] = d ?? ''
    else if (inp.kind === 'bool') row[inp.key] = d === true
    else if (inp.kind === 'files') row[inp.key] = []
    else row[inp.key] = d ?? ''
  }
  return row
}

function cloneRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row))
    out[k] = Array.isArray(v) ? [...v] : v
  return out
}

/** 末行复制 + episode 类 int 字段自增（key 含 'episode' 约定） */
function addRow() {
  const last = rows.value[rows.value.length - 1] ?? makeRow()
  const row = cloneRow(last)
  for (const inp of tpl.value?.inputs ?? []) {
    if (
      inp.kind === 'int' &&
      inp.key.toLowerCase().includes('episode') &&
      typeof row[inp.key] === 'number'
    ) {
      row[inp.key] = (row[inp.key] as number) + 1
    }
  }
  rows.value.push(row)
}

function copyRow(i: number) {
  const row = rows.value[i]
  if (row) rows.value.splice(i + 1, 0, cloneRow(row))
}

function removeRow(i: number) {
  if (rows.value.length <= 1) return
  rows.value.splice(i, 1)
}

function applyPaste() {
  try {
    const arr = JSON.parse(pasteText.value) as unknown
    if (!Array.isArray(arr) || !arr.length) throw new Error('需为非空数组')
    rows.value = arr.map((o) => ({
      ...makeRow(),
      ...(o as Record<string, unknown>),
    }))
    err.value = ''
    showPaste.value = false
    pasteText.value = ''
  } catch (e) {
    err.value = `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`
  }
}

/** 行头摘要（前 3 键） */
function summaryOf(row: Record<string, unknown>): string {
  const s = Object.entries(row)
    .filter(
      ([, v]) =>
        v !== null &&
        v !== undefined &&
        v !== '' &&
        !(Array.isArray(v) && !v.length),
    )
    .slice(0, 3)
    .map(
      ([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(',')}]` : String(v)}`,
    )
    .join(' · ')
  return s.length > 72 ? s.slice(0, 72) + '…' : s
}

// 模板切换：重载 schema + 重置为 1 行
watch(tplKey, async (key) => {
  err.value = ''
  if (!key) {
    tpl.value = null
    rows.value = []
    return
  }
  try {
    const res = await templateApi.detail(key)
    tpl.value = res.template
    rows.value = [makeRow()]
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
})

async function init() {
  loading.value = true
  try {
    const [tRes, aRes] = await Promise.all([
      templateApi.list('?picker=1'),
      projectApi.assets(props.projectId, '?limit=200'),
    ])
    templates.value = tRes.items
    assets.value = aRes.items
    // [优化] 预选项目默认模板（命中且在列）；否则回退列表第一个
    const initKey = props.defaultTemplateKey
    tplKey.value =
      initKey && tRes.items.some((t) => t.key === initKey)
        ? initKey
        : (tRes.items[0]?.key ?? '')
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
init()

const count = computed(() => rows.value.length)

async function submit() {
  if (!tpl.value || !rows.value.length) return
  // 逐行归一化（与 RunFormModal 同口径：空串→未填、int→Number、files→数组）
  const inputs: Record<string, unknown>[] = []
  for (let i = 0; i < rows.value.length; i++) {
    const row = rows.value[i] ?? {}
    const input: Record<string, unknown> = {}
    for (const inp of tpl.value.inputs) {
      const v = row[inp.key]
      if (
        inp.required &&
        (v === '' || v === undefined || (Array.isArray(v) && v.length === 0))
      ) {
        err.value = `第 ${i + 1} 组「${inp.label}」未填`
        return
      }
      if (inp.kind === 'int') input[inp.key] = Number(v)
      else if (inp.kind === 'bool') input[inp.key] = v === true
      else if (inp.kind === 'files') input[inp.key] = (v as number[]) ?? []
      else input[inp.key] = v ?? ''
    }
    inputs.push(input)
  }
  busy.value = true
  err.value = ''
  try {
    const res = await batchApi.create(props.projectId, {
      template_key: tpl.value.key,
      name: name.value.trim() || undefined,
      schedule: { max_concurrent: maxc.value },
      inputs,
    })
    emit('done', res.batch.id)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal title="批量运行（新建批次）" :width="860" @close="emit('close')">
    <div v-if="loading" class="empty">加载中…</div>
    <template v-else>
      <div class="grid2">
        <label class="fld">
          模板
          <select v-model="tplKey">
            <optgroup v-for="g in tplGroups" :key="g.key" :label="g.label">
              <option v-for="t in g.items" :key="t.key" :value="t.key">
                {{ t.name }}（{{ genreText(t.genre) }} · {{ t.stepCount }} 步）
              </option>
            </optgroup>
          </select>
        </label>
        <label class="fld">
          批次名（留空自动）
          <input
            v-model="name"
            type="text"
            :placeholder="tpl ? `${tpl.name} × ${count}` : ''"
          />
        </label>
      </div>

      <div class="fld">
        调度
        <div class="seg">
          <button
            type="button"
            v-for="c in [1, 2, 3]"
            :key="c"
            :class="{ on: maxc === c }"
            @click="maxc = c"
          >
            {{ c === 1 ? '串行（推荐）' : `并发 ${c}` }}
          </button>
        </div>
        <span class="muted hint">gate 挂起计入占用，批次自动暂停推进</span>
      </div>

      <template v-if="tpl">
        <div class="rows-h">
          <span class="bt">输入组（{{ count }} 组 → {{ count }} 个 run）</span>
          <div style="margin-left: auto; display: flex; gap: 6px">
            <button class="btn sm" @click="showPaste = !showPaste">
              批量粘贴 JSON
            </button>
            <button class="btn sm primary" @click="addRow">
              <Icon name="plus" :size="12" :stroke-width="2.2" /> 添加行
            </button>
          </div>
        </div>

        <div v-if="showPaste" class="paj">
          <textarea
            v-model="pasteText"
            rows="4"
            placeholder='[{"episode_number": 5, "with_motion": false}, {"episode_number": 6}]'
          />
          <button class="btn sm" @click="applyPaste">解析并替换输入组</button>
        </div>

        <div class="rows">
          <div v-for="(row, i) in rows" :key="i" class="row-card">
            <div class="rh">
              <span class="idx mono">#{{ i + 1 }}</span>
              <span class="muted">{{ summaryOf(row) }}</span>
              <div class="rops">
                <button class="btn sm" @click="copyRow(i)">复制</button>
                <button
                  class="btn sm danger"
                  :disabled="count <= 1"
                  @click="removeRow(i)"
                >
                  删除
                </button>
              </div>
            </div>
            <TemplateInputFields
              :tpl="tpl"
              :assets="assets"
              :values="row"
              dense
              @change="(k, v) => (row[k] = v)"
            />
          </div>
        </div>
      </template>

      <div v-if="err" class="err-text">{{ err }}</div>
    </template>

    <template #footer>
      <button class="btn" @click="emit('close')">取消</button>
      <button class="btn primary" :disabled="busy || !tpl" @click="submit">
        {{ busy ? '创建中…' : `创建批次（${count} 组）` }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 14px;
}

.seg {
  display: inline-flex;
  gap: 3px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 3px;
  margin-top: 5px;
}

.seg button {
  border: none;
  background: none;
  color: var(--text-2);
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 7px;
  cursor: pointer;
}

.seg button.on {
  background: var(--accent-weak);
  color: #a5b4fc;
}

.hint {
  margin-left: 8px;
}

.rows-h {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 0 8px;
}

.bt {
  font-weight: 600;
  font-size: 13.5px;
}

.paj {
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 420px;
  overflow-y: auto;
  padding-right: 4px;
}

.row-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 12px 2px;
  background: var(--panel-2);
}

.rh {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}

.idx {
  font-size: 12px;
  color: var(--accent-h);
}

.rops {
  margin-left: auto;
  display: flex;
  gap: 5px;
}
</style>
