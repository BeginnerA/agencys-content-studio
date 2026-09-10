<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import Modal from '../components/Modal.vue'
import { ApiError, promptApi, templateApi } from '../lib/api'
import type { PromptItem, TemplateDetail, TemplateMeta, TemplateStepDef, TemplateValidation } from '../lib/types'
import { fmtSize, fmtTime } from '../lib/format'

function msg(e: unknown): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
}

// ===== 顶层页签：模板 / 提示词 =====
const tab = ref<'tpl' | 'prompt'>('tpl')

// ===== 模板区状态 =====
const metas = ref<TemplateMeta[]>([])
const metasLoading = ref(true)
const listErr = ref('')
const selected = ref<string | null>(null)
const yamlText = ref('')
const baseline = ref('')
const detail = ref<TemplateDetail | null>(null)
const validation = ref<TemplateValidation | null>(null)
const validating = ref(false)
const saving = ref(false)
const loadErr = ref('')
const actionErr = ref('')

const dirty = computed(() => selected.value !== null && yamlText.value !== baseline.value)
/** 实时解析结果：优先校验产物（编辑中实时结构），否则已保存版本 */
const liveTpl = computed<TemplateDetail | null>(() => validation.value?.template ?? detail.value)

async function refreshMetas(autoOpen = false) {
  metasLoading.value = true
  try {
    const r = await templateApi.list()
    metas.value = r.items
    listErr.value = ''
    if (autoOpen && !selected.value && metas.value.length) await openTemplate(metas.value[0]!.key)
  } catch (e) {
    listErr.value = msg(e)
  } finally {
    metasLoading.value = false
  }
}

let openSeq = 0
async function openTemplate(key: string) {
  if (dirty.value && !confirm('当前修改尚未保存，确定放弃并切换？')) return
  const seq = ++openSeq
  stopValidate()
  selected.value = key
  loadErr.value = ''
  actionErr.value = ''
  validation.value = null
  try {
    const r = await templateApi.detail(key)
    if (seq !== openSeq) return
    detail.value = r.template
    yamlText.value = r.yaml
    baseline.value = r.yaml
  } catch (e) {
    if (seq !== openSeq) return
    detail.value = null
    loadErr.value = msg(e)
  }
}

// ===== 实时校验（防抖 800ms）=====
let timer: number | null = null
let valSeq = 0
function stopValidate() {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
}

watch(yamlText, () => {
  stopValidate()
  if (!dirty.value) {
    validation.value = null
    validating.value = false
    return
  }
  timer = window.setTimeout(() => void doValidate(), 800)
})

async function doValidate() {
  const seq = ++valSeq
  validating.value = true
  try {
    const r = await templateApi.validate(yamlText.value, selected.value ?? undefined)
    if (seq === valSeq) validation.value = r
  } catch (e) {
    if (seq === valSeq) validation.value = { ok: false, errors: [msg(e)], warnings: [] }
  } finally {
    if (seq === valSeq) validating.value = false
  }
}

async function save() {
  if (!selected.value || saving.value) return
  saving.value = true
  actionErr.value = ''
  stopValidate()
  try {
    const r = await templateApi.update(selected.value, yamlText.value)
    baseline.value = yamlText.value
    detail.value = r.template
    validation.value = null
    await refreshMetas()
  } catch (e) {
    actionErr.value = msg(e)
  } finally {
    saving.value = false
  }
}

// ===== 新建 / 另存为副本 / 删除 =====
const newDlg = ref(false)
const newKey = ref('')
const newErr = ref('')
const creating = ref(false)

const copyDlg = ref(false)
const copyKey = ref('')
const copyErr = ref('')
const copying = ref(false)

/** 最小合法骨架（manual_ingest 在 KNOWN_ACTIONS 内） */
function skeleton(key: string): string {
  return `key: ${key}
version: 1
name: ${key}
genre: talk
inputs: []
steps:
  - key: ingest
    action: manual_ingest
    title: 素材导入
    inputs: {}
`
}

/** 副本 yaml：key 行替换为目标 key（无 key 行则补一行） */
function withKey(text: string, key: string): string {
  return /^key:.*$/m.test(text) ? text.replace(/^key:.*$/m, `key: ${key}`) : `key: ${key}\n${text}`
}

function openNew() {
  newDlg.value = true
  newKey.value = ''
  newErr.value = ''
}

async function doCreate() {
  const key = newKey.value.trim()
  if (!/^[\w-]+$/.test(key)) {
    newErr.value = 'key 仅允许字母/数字/下划线/中划线'
    return
  }
  creating.value = true
  try {
    await templateApi.create(key, skeleton(key))
    newDlg.value = false
    await refreshMetas()
    await openTemplate(key)
  } catch (e) {
    newErr.value = msg(e)
  } finally {
    creating.value = false
  }
}

function openCopy() {
  if (!selected.value) return
  copyDlg.value = true
  copyKey.value = `${selected.value}-copy`
  copyErr.value = ''
}

async function doCopy() {
  const key = copyKey.value.trim()
  if (!/^[\w-]+$/.test(key)) {
    copyErr.value = 'key 仅允许字母/数字/下划线/中划线'
    return
  }
  copying.value = true
  try {
    await templateApi.create(key, withKey(yamlText.value, key))
    copyDlg.value = false
    await refreshMetas()
    await openTemplate(key)
  } catch (e) {
    copyErr.value = msg(e)
  } finally {
    copying.value = false
  }
}

async function removeTemplate(key: string, name: string) {
  if (!confirm(`删除模板「${name}」（${key}）？\n文件将从 workspace/templates 移除，且不可撤销。`)) return
  actionErr.value = ''
  try {
    await templateApi.remove(key)
    if (selected.value === key) {
      selected.value = null
      detail.value = null
      yamlText.value = ''
      baseline.value = ''
      validation.value = null
    }
    await refreshMetas()
  } catch (e) {
    actionErr.value = msg(e)
  }
}

/** textarea 内 tab → 2 空格（spec：tab=2） */
function onTab(e: KeyboardEvent) {
  const el = e.target as HTMLTextAreaElement
  const s = el.selectionStart
  const en = el.selectionEnd
  yamlText.value = yamlText.value.slice(0, s) + '  ' + yamlText.value.slice(en)
  requestAnimationFrame(() => {
    el.selectionStart = el.selectionEnd = s + 2
  })
}

// ===== 只读信息：inputs 表 + steps 流程图（svg 竖排）=====
const KIND_TEXT: Record<string, string> = { text: '文本', int: '整数', bool: '开关', files: '文件' }

function kindText(k: string): string {
  return KIND_TEXT[k] ?? k
}

function fmtDefault(v: unknown): string {
  if (v === undefined || v === null || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

interface FlowBadge {
  text: string
  cls: 'gate' | 'batch' | 'when' | 'any'
  tip: string
}

interface FlowBox {
  i: number
  y: number
  key: string
  title: string
  action: string
  badges: FlowBadge[]
}

interface FlowEdge {
  d: string
}

/** 流程图几何（viewBox 宽度固定 560；盒宽+走廊） */
const BOX = { x: 56, w: 468, h: 56, gap: 30, top: 16 }
const CORRIDOR = BOX.x - 22
const BADGE_SLOT = 30

const flow = computed(() => {
  const steps: TemplateStepDef[] = liveTpl.value?.steps ?? []
  const boxes: FlowBox[] = []
  const edges: FlowEdge[] = []
  const idxByKey = new Map<string, number>()
  steps.forEach((s, i) => idxByKey.set(s.key, i))
  steps.forEach((s, i) => {
    const y = BOX.top + i * (BOX.h + BOX.gap)
    const badges: FlowBadge[] = []
    if (s.gate) badges.push({ text: '闸', cls: 'gate', tip: `人工闸门（${s.gate.mode}）` })
    if (s.batch) badges.push({ text: '批', cls: 'batch', tip: `批量字段：${s.batch.field}` })
    if (s.when) badges.push({ text: '条', cls: 'when', tip: '条件步骤（满足才执行）' })
    if (s.when_any) badges.push({ text: '或', cls: 'any', tip: 'OR 条件组（任一满足）' })
    boxes.push({ i, y, key: s.key, title: s.title, action: s.action, badges })
    // 依赖边：after 显式声明；缺省 = 前一步；[] = 无依赖
    const deps = s.after !== undefined ? s.after : i > 0 ? [steps[i - 1]!.key] : []
    for (const dep of deps) {
      const j = idxByKey.get(dep)
      if (j === undefined || j >= i) continue
      const yj = BOX.top + j * (BOX.h + BOX.gap)
      if (j === i - 1) {
        edges.push({ d: `M ${BOX.x + BOX.w / 2} ${yj + BOX.h} L ${BOX.x + BOX.w / 2} ${y}` })
      } else {
        // 跨步依赖：绕左侧走廊
        edges.push({
          d: `M ${BOX.x + 12} ${yj + BOX.h} L ${CORRIDOR} ${yj + BOX.h} L ${CORRIDOR} ${y + BOX.h / 2} L ${BOX.x - 6} ${y + BOX.h / 2}`,
        })
      }
    }
  })
  const height = BOX.top + Math.max(steps.length, 1) * (BOX.h + BOX.gap)
  return { boxes, edges, height }
})

// ===== 提示词区 =====
const prompts = ref<PromptItem[]>([])
const pLoading = ref(true)
const pListErr = ref('')
const pSelected = ref<string | null>(null)
const pText = ref('')
const pBaseline = ref('')
const pSaving = ref(false)
const pErr = ref('')

const pDirty = computed(() => pSelected.value !== null && pText.value !== pBaseline.value)

async function refreshPrompts() {
  pLoading.value = true
  try {
    const r = await promptApi.list()
    prompts.value = r.items
    pListErr.value = ''
  } catch (e) {
    pListErr.value = msg(e)
  } finally {
    pLoading.value = false
  }
}

async function openPrompt(name: string) {
  if (pDirty.value && !confirm('当前提示词修改尚未保存，确定放弃并切换？')) return
  pSelected.value = name
  pErr.value = ''
  try {
    const r = await promptApi.get(name)
    pText.value = r.content
    pBaseline.value = r.content
  } catch (e) {
    pErr.value = msg(e)
  }
}

async function savePrompt() {
  if (!pSelected.value || pSaving.value) return
  pSaving.value = true
  pErr.value = ''
  try {
    await promptApi.put(pSelected.value, pText.value)
    pBaseline.value = pText.value
    await refreshPrompts()
  } catch (e) {
    pErr.value = msg(e)
  } finally {
    pSaving.value = false
  }
}

async function removePrompt(name: string) {
  if (!confirm(`删除提示词「${name}」？引用它的模板将出现「引用缺失」提示。`)) return
  pErr.value = ''
  try {
    await promptApi.remove(name)
    if (pSelected.value === name) {
      pSelected.value = null
      pText.value = ''
      pBaseline.value = ''
    }
    await refreshPrompts()
    await refreshMetas()
  } catch (e) {
    pErr.value = msg(e)
  }
}

const newPromptDlg = ref(false)
const newPromptName = ref('')
const newPromptErr = ref('')
const newPromptCreating = ref(false)

function openNewPrompt() {
  newPromptDlg.value = true
  newPromptName.value = ''
  newPromptErr.value = ''
}

async function doCreatePrompt() {
  const name = newPromptName.value.trim().replace(/\\/g, '/')
  if (!name) {
    newPromptErr.value = '请输入文件相对路径（如 cover-talking.md 或 sub/dir/name.md）'
    return
  }
  newPromptCreating.value = true
  try {
    await promptApi.put(name, '')
    newPromptDlg.value = false
    await refreshPrompts()
    await openPrompt(name)
  } catch (e) {
    newPromptErr.value = msg(e)
  } finally {
    newPromptCreating.value = false
  }
}

onMounted(() => {
  void refreshMetas(true)
  void refreshPrompts()
})
</script>

<template>
  <div>
    <div class="page-h">
      <h1>模板</h1>
      <span class="sub">workspace 文件即事实源 · 保存后下一 run 即时生效</span>
      <div class="tabs" role="tablist" aria-label="模板与提示词切换">
        <button
          class="tab"
          role="tab"
          :aria-selected="tab === 'tpl'"
          :class="{ on: tab === 'tpl' }"
          @click="tab = 'tpl'"
        >
          <Icon name="doc" :size="13" /> 模板
        </button>
        <button
          class="tab"
          role="tab"
          :aria-selected="tab === 'prompt'"
          :class="{ on: tab === 'prompt' }"
          @click="tab = 'prompt'"
        >
          <Icon name="sparkles" :size="13" /> 提示词
        </button>
      </div>
    </div>

    <!-- ===== 模板页签 ===== -->
    <div v-if="tab === 'tpl'" class="split">
      <aside class="panel list" aria-label="模板文件列表">
        <div class="lhead">
          <span>模板文件（{{ metas.length }}）</span>
          <button class="btn sm" @click="openNew"><Icon name="plus" :size="12" :stroke-width="2.2" /> 新建</button>
        </div>
        <div v-if="listErr" class="err-text">{{ listErr }}</div>
        <div v-if="metasLoading" class="empty">加载中…</div>
        <div v-else-if="!metas.length" class="empty">workspace/templates 下暂无模板</div>
        <button
          v-for="m in metas"
          :key="m.key"
          class="item"
          :class="{ active: selected === m.key }"
          @click="openTemplate(m.key)"
        >
          <div class="r1">
            <span class="k mono">{{ m.key }}</span>
            <span
              v-if="m.promptsDirty"
              class="badge skip"
              title="params.prompt_tpl 引用的提示词文件缺失"
            >引用缺失</span>
          </div>
          <div class="nm">{{ m.name }}</div>
          <div class="r2">
            <span class="chip">{{ m.genre }}</span>
            <span class="chip">v{{ m.version }}</span>
            <span class="chip">{{ m.stepCount }} 步</span>
          </div>
          <div class="r3 muted">{{ fmtTime(m.updatedAt) }}</div>
        </button>
      </aside>

      <section class="panel editor">
        <div v-if="!selected" class="empty" style="padding: 80px 0">左侧选择一个模板开始编辑</div>
        <template v-else>
          <div class="ehead">
            <span class="tt mono">{{ selected }}</span>
            <span class="badge" :class="dirty ? 'queued' : 'succeeded'">{{ dirty ? '未保存' : '已同步' }}</span>
            <span v-if="liveTpl" class="muted">v{{ liveTpl.version }} · {{ liveTpl.steps.length }} 步</span>
            <div class="acts">
              <button class="btn sm" :disabled="!yamlText" @click="openCopy">
                <Icon name="doc" :size="12" /> 另存为副本
              </button>
              <button class="btn sm danger" @click="removeTemplate(selected, liveTpl?.name ?? selected)">
                <Icon name="trash" :size="12" /> 删除
              </button>
            </div>
          </div>
          <div v-if="loadErr" class="err-text">{{ loadErr }}</div>
          <div v-if="actionErr" class="err-text">{{ actionErr }}</div>

          <div class="edit">
            <div class="ed">
              <textarea
                v-model="yamlText"
                class="yaml"
                spellcheck="false"
                :aria-label="`${selected} 模板 YAML 编辑器`"
                @keydown.tab.prevent="onTab"
              ></textarea>
            </div>
            <div class="lint" aria-live="polite" aria-label="校验结果">
              <div class="lh">校验</div>
              <div v-if="validating" class="muted">校验中…</div>
              <div v-else-if="!dirty" class="lk ok"><Icon name="check" :size="13" :stroke-width="2.4" /> 与文件一致</div>
              <template v-else-if="validation">
                <div v-if="validation.ok" class="lk ok">
                  <Icon name="check" :size="13" :stroke-width="2.4" /> 校验通过
                  <span v-if="validation.warnings.length" class="muted">（{{ validation.warnings.length }} 警告）</span>
                </div>
                <div v-else class="lk bad">
                  <Icon name="x" :size="13" :stroke-width="2.4" /> {{ validation.errors.length }} 项错误
                </div>
                <ul v-if="validation.errors.length" class="er">
                  <li v-for="(er, i) in validation.errors" :key="'e' + i">{{ er }}</li>
                </ul>
                <ul v-if="validation.warnings.length" class="wr">
                  <li v-for="(w, i) in validation.warnings" :key="'w' + i">{{ w }}</li>
                </ul>
              </template>
              <div v-else class="muted">编辑后自动校验…</div>
            </div>
          </div>
          <div class="ebar">
            <span class="muted">tab = 2 空格 · 保存由服务端二次校验（原子写，失败保留原文件）</span>
            <button
              class="btn primary"
              :disabled="!dirty || saving || (validation !== null && !validation.ok)"
              @click="save"
            >
              <Icon name="check" :size="13" :stroke-width="2.2" /> {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>

          <!-- 只读信息：inputs 声明表 + steps 流程图 -->
          <div v-if="liveTpl" class="info">
            <div class="ih">输入声明</div>
            <table v-if="liveTpl.inputs.length" class="tbl">
              <thead>
                <tr>
                  <th>key</th>
                  <th>label</th>
                  <th>类型</th>
                  <th>必填</th>
                  <th>默认</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="inp in liveTpl.inputs" :key="inp.key">
                  <td class="mono">{{ inp.key }}</td>
                  <td>{{ inp.label ?? '—' }}</td>
                  <td>{{ kindText(inp.kind) }}</td>
                  <td>{{ inp.required ? '是' : '否' }}</td>
                  <td class="mono">{{ fmtDefault(inp.default) }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="muted">未声明输入</div>

            <div class="ih">步骤流程（依赖与徽标）</div>
            <svg
              class="flow"
              :viewBox="`0 0 560 ${flow.height}`"
              role="img"
              aria-label="步骤依赖流程图"
            >
              <defs>
                <marker
                  id="flow-arr"
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M0 0 L8 4 L0 8 z" class="farr" />
                </marker>
              </defs>
              <path
                v-for="(e, i) in flow.edges"
                :key="'e' + i"
                :d="e.d"
                class="fedge"
                marker-end="url(#flow-arr)"
              />
              <g v-for="b in flow.boxes" :key="'b' + b.i">
                <rect :x="BOX.x" :y="b.y" :width="BOX.w" :height="BOX.h" rx="10" class="fbox" />
                <text :x="BOX.x + 14" :y="b.y + 23" class="fk">{{ b.i + 1 }}. {{ b.key }}</text>
                <text :x="BOX.x + 14" :y="b.y + 42" class="ft">{{ b.title }}</text>
                <text :x="BOX.x + BOX.w - 14" :y="b.y + 23" text-anchor="end" class="fa">
                  {{ b.action }}
                </text>
                <g v-for="(bd, bi) in b.badges" :key="bi">
                  <title>{{ bd.tip }}</title>
                  <rect
                    :x="BOX.x + BOX.w - 14 - 24 - bi * BADGE_SLOT"
                    :y="b.y + 31"
                    width="24"
                    height="16"
                    rx="5"
                    class="fb"
                    :class="bd.cls"
                  />
                  <text
                    :x="BOX.x + BOX.w - 14 - 12 - bi * BADGE_SLOT"
                    :y="b.y + 43"
                    text-anchor="middle"
                    class="fbt"
                    :class="bd.cls"
                  >
                    {{ bd.text }}
                  </text>
                </g>
              </g>
            </svg>
            <div class="legend">
              <span class="lg"><i class="dot gate" />闸门 gate</span>
              <span class="lg"><i class="dot batch" />批量 batch</span>
              <span class="lg"><i class="dot when" />条件 when</span>
              <span class="lg"><i class="dot any" />OR 组 when_any</span>
            </div>
          </div>
        </template>
      </section>
    </div>

    <!-- ===== 提示词页签 ===== -->
    <div v-else class="split">
      <aside class="panel list" aria-label="提示词文件列表">
        <div class="lhead">
          <span>提示词（{{ prompts.length }}）</span>
          <button class="btn sm" @click="openNewPrompt">
            <Icon name="plus" :size="12" :stroke-width="2.2" /> 新建
          </button>
        </div>
        <div v-if="pListErr" class="err-text">{{ pListErr }}</div>
        <div v-if="pLoading" class="empty">加载中…</div>
        <div v-else-if="!prompts.length" class="empty">workspace/prompts 下暂无文件</div>
        <button
          v-for="p in prompts"
          :key="p.name"
          class="item"
          :class="{ active: pSelected === p.name }"
          @click="openPrompt(p.name)"
        >
          <div class="r1"><span class="k mono">{{ p.name }}</span></div>
          <div class="r3 muted">{{ fmtSize(p.size) }} · {{ fmtTime(p.updatedAt) }}</div>
        </button>
      </aside>

      <section class="panel editor">
        <div v-if="!pSelected" class="empty" style="padding: 80px 0">左侧选择一个提示词开始编辑</div>
        <template v-else>
          <div class="ehead">
            <span class="tt mono">{{ pSelected }}</span>
            <span class="badge" :class="pDirty ? 'queued' : 'succeeded'">{{ pDirty ? '未保存' : '已同步' }}</span>
            <div class="acts">
              <button class="btn sm danger" @click="removePrompt(pSelected)">
                <Icon name="trash" :size="12" /> 删除
              </button>
            </div>
          </div>
          <div v-if="pErr" class="err-text">{{ pErr }}</div>
          <div class="edit">
            <div class="ed">
              <textarea
                v-model="pText"
                class="yaml"
                spellcheck="false"
                :aria-label="`${pSelected} 提示词编辑器`"
              ></textarea>
            </div>
          </div>
          <div class="ebar">
            <span class="muted">Markdown 文本 · 保存后模板引用即时指向新内容</span>
            <button class="btn primary" :disabled="!pDirty || pSaving" @click="savePrompt">
              <Icon name="check" :size="13" :stroke-width="2.2" /> {{ pSaving ? '保存中…' : '保存' }}
            </button>
          </div>
        </template>
      </section>
    </div>

    <!-- 新建模板 -->
    <Modal v-if="newDlg" title="新建模板" :width="420" @close="newDlg = false">
      <label class="fld">
        key（文件名，仅字母/数字/下划线/中划线）
        <input v-model="newKey" type="text" placeholder="my-template" @keydown.enter="doCreate" />
      </label>
      <div class="muted" style="margin-bottom: 8px">将以最小骨架创建 workspace/templates/&lt;key&gt;.yaml</div>
      <div v-if="newErr" class="err-text">{{ newErr }}</div>
      <template #footer>
        <button class="btn" @click="newDlg = false">取消</button>
        <button class="btn primary" :disabled="creating" @click="doCreate">
          {{ creating ? '创建中…' : '创建' }}
        </button>
      </template>
    </Modal>

    <!-- 另存为副本 -->
    <Modal v-if="copyDlg" title="另存为副本" :width="420" @close="copyDlg = false">
      <label class="fld">
        新 key
        <input v-model="copyKey" type="text" @keydown.enter="doCopy" />
      </label>
      <div class="muted" style="margin-bottom: 8px">当前编辑器内容将存为新模板（yaml 内 key 同步替换）</div>
      <div v-if="copyErr" class="err-text">{{ copyErr }}</div>
      <template #footer>
        <button class="btn" @click="copyDlg = false">取消</button>
        <button class="btn primary" :disabled="copying" @click="doCopy">
          {{ copying ? '创建中…' : '创建副本' }}
        </button>
      </template>
    </Modal>

    <!-- 新建提示词 -->
    <Modal v-if="newPromptDlg" title="新建提示词" :width="460" @close="newPromptDlg = false">
      <label class="fld">
        文件相对路径（支持子目录）
        <input v-model="newPromptName" type="text" placeholder="cover-talking.md" @keydown.enter="doCreatePrompt" />
      </label>
      <div class="muted" style="margin-bottom: 8px">将在 workspace/prompts 下创建空文件（限定目录内，防越界）</div>
      <div v-if="newPromptErr" class="err-text">{{ newPromptErr }}</div>
      <template #footer>
        <button class="btn" @click="newPromptDlg = false">取消</button>
        <button class="btn primary" :disabled="newPromptCreating" @click="doCreatePrompt">
          {{ newPromptCreating ? '创建中…' : '创建' }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
/* ---------- 页签 ---------- */
.tabs {
  margin-left: auto;
  display: inline-flex;
  gap: 3px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 3px;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 500;
  padding: 5px 13px;
  border-radius: 7px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.tab:hover {
  color: var(--text);
  background: var(--hover);
}

.tab.on {
  background: linear-gradient(135deg, rgb(139 92 246 / 26%), rgb(79 70 229 / 22%));
  color: #fff;
}

/* ---------- 分栏骨架 ---------- */
.split {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.list {
  width: 264px;
  flex: none;
  padding: 10px;
  max-height: calc(100vh - 130px);
  overflow-y: auto;
}

.lhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 4px 10px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 500;
  border-bottom: 1px solid var(--border);
  margin-bottom: 8px;
}

.item {
  display: block;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text);
  border-radius: 10px;
  padding: 8px 10px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.item:hover {
  background: var(--hover);
}

.item.active {
  background: rgb(99 102 241 / 14%);
  border-color: rgb(99 102 241 / 32%);
}

.item .r1 {
  display: flex;
  align-items: center;
  gap: 7px;
  justify-content: space-between;
}

.item .k {
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item .nm {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item .r2 {
  display: flex;
  gap: 5px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.item .r3 {
  margin-top: 5px;
  font-size: 11px;
}

/* ---------- 编辑器区 ---------- */
.editor {
  flex: 1;
  min-width: 0;
  padding: 14px;
}

.ehead {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.ehead .tt {
  font-size: 14.5px;
  font-weight: 700;
}

.ehead .acts {
  margin-left: auto;
  display: inline-flex;
  gap: 8px;
}

.edit {
  display: flex;
  gap: 10px;
  align-items: stretch;
}

.ed {
  flex: 1;
  min-width: 0;
}

textarea.yaml {
  width: 100%;
  height: 430px;
  resize: vertical;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.6;
  tab-size: 2;
  background: var(--code-bg);
}

.lint {
  width: 244px;
  flex: none;
  height: 430px;
  overflow-y: auto;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 11px;
  font-size: 12px;
}

.lint .lh {
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 8px;
  font-size: 12px;
}

.lint .lk {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
}

.lint .lk.ok {
  color: var(--ok);
}

.lint .lk.bad {
  color: var(--bad);
}

.lint ul {
  margin: 8px 0 0;
  padding-left: 16px;
  display: grid;
  gap: 6px;
  word-break: break-word;
}

.lint .er li {
  color: #fca5a5;
}

.lint .wr li {
  color: var(--warn);
}

.ebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
}

/* ---------- 只读信息 ---------- */
.info {
  margin-top: 18px;
  border-top: 1px dashed var(--border);
  padding-top: 4px;
}

.ih {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-2);
  margin: 14px 0 8px;
}

.flow {
  width: 100%;
  height: auto;
  max-width: 720px;
  display: block;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.flow text {
  font-family: var(--mono);
}

.fbox {
  fill: #131c31;
  stroke: rgb(148 163 184 / 26%);
}

.fk {
  fill: #e8edf6;
  font-size: 12.5px;
  font-weight: 600;
}

.ft {
  fill: #66738e;
  font-size: 11px;
}

.fa {
  fill: #66738e;
  font-size: 10.5px;
}

.fedge {
  stroke: #3b4a6b;
  stroke-width: 1.4;
  fill: none;
}

.farr {
  fill: #3b4a6b;
}

.fb.gate {
  fill: rgb(139 92 246 / 16%);
  stroke: #a78bfa;
}

.fb.batch {
  fill: rgb(34 197 94 / 14%);
  stroke: #4ade80;
}

.fb.when,
.fb.any {
  fill: rgb(245 158 11 / 14%);
  stroke: #fbbf24;
}

.fbt.gate {
  fill: #c4b5fd;
  font-size: 10px;
}

.fbt.batch {
  fill: #86efac;
  font-size: 10px;
}

.fbt.when,
.fbt.any {
  fill: #fcd34d;
  font-size: 10px;
}

.legend {
  display: flex;
  gap: 14px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.lg {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-3);
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 3px;
  display: inline-block;
  border: 1px solid;
}

.dot.gate {
  background: rgb(139 92 246 / 30%);
  border-color: #a78bfa;
}

.dot.batch {
  background: rgb(34 197 94 / 26%);
  border-color: #4ade80;
}

.dot.when,
.dot.any {
  background: rgb(245 158 11 / 26%);
  border-color: #fbbf24;
}
</style>
