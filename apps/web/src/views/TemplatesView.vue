<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import Modal from '../components/Modal.vue'
import TemplateHelpModal from '../components/TemplateHelpModal.vue'
import { ApiError, promptApi, templateApi } from '../lib/api'
import { confirmDialog } from '../lib/confirm'
import { SCENE_LABELS, genreText } from '../lib/scene'
import { KIND_TEXT, actionText } from '../lib/template-dict'
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
/** [说明书改造] 视图模式：guide=说明书视图（默认，普通使用者视角）；edit=YAML 高级编辑 */
const mode = ref<'guide' | 'edit'>('guide')
/** [说明书改造] 字段速查弹层 */
const helpDlg = ref(false)
const yamlText = ref('')
const baseline = ref('')
const detail = ref<TemplateDetail | null>(null)
const validation = ref<TemplateValidation | null>(null)
const validating = ref(false)
const saving = ref(false)
const loadErr = ref('')
const actionErr = ref('')

const dirty = computed(() => selected.value !== null && yamlText.value !== baseline.value)
/** 实时解析结果：编辑中优先校验产物（实时结构），否则已保存版本；说明书视图固定显示已保存版本 */
const liveTpl = computed<TemplateDetail | null>(() =>
  mode.value === 'edit' ? (validation.value?.template ?? detail.value) : detail.value,
)

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
  if (dirty.value) {
    const ok = await confirmDialog({
      title: '放弃未保存修改',
      message: '当前模板修改尚未保存，确定放弃并切换？',
      confirmText: '放弃并切换',
    })
    if (!ok) return
  }
  const seq = ++openSeq
  stopValidate()
  selected.value = key
  // [说明书改造] 切换模板默认回说明书视图
  mode.value = 'guide'
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

// ===== [说明书改造] 视图模式切换：不丢弃编辑内容，未保存徽标持续提示 =====
function toEdit() {
  mode.value = 'edit'
}

function toGuide() {
  mode.value = 'guide'
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
    // [说明书改造] 新模板直接进入编辑（空骨架待填写）
    mode.value = 'edit'
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
    // [说明书改造] 新建副本同样直接进入编辑
    mode.value = 'edit'
  } catch (e) {
    copyErr.value = msg(e)
  } finally {
    copying.value = false
  }
}

async function removeTemplate(key: string, name: string) {
  const ok = await confirmDialog({
    title: '删除模板',
    message: `删除模板「${name}」（${key}）？\n文件将从 workspace/templates 移除，且不可撤销。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
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

/** [说明书改造] 步骤徽标生成：svg 流程图与说明书步骤列表共用 */
function stepBadgesOf(s: TemplateStepDef): FlowBadge[] {
  const badges: FlowBadge[] = []
  if (s.gate) badges.push({ text: '闸', cls: 'gate', tip: `人工闸门（${s.gate.mode}）` })
  if (s.batch) badges.push({ text: '批', cls: 'batch', tip: `批量字段：${s.batch.field}` })
  if (s.when) badges.push({ text: '条', cls: 'when', tip: '条件步骤（满足才执行）' })
  if (s.when_any) badges.push({ text: '或', cls: 'any', tip: 'OR 条件组（任一满足）' })
  return badges
}

/** [说明书改造] 说明书视图的友好徽标文案（编辑模式流程图仍用单字） */
const GUIDE_BADGE_TEXT: Record<FlowBadge['cls'], string> = {
  gate: '人工审阅',
  batch: '批量逐项',
  when: '条件执行',
  any: '条件执行',
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
    const badges = stepBadgesOf(s)
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
  if (pDirty.value) {
    const ok = await confirmDialog({
      title: '放弃未保存修改',
      message: '当前提示词修改尚未保存，确定放弃并切换？',
      confirmText: '放弃并切换',
    })
    if (!ok) return
  }
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
  const ok = await confirmDialog({
    title: '删除提示词',
    message: `删除提示词「${name}」？引用它的模板将出现「引用缺失」提示。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
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
        <div v-if="!selected" class="empty" style="padding: 80px 0">左侧选择一个模板，查看它做什么、要填什么、怎么运行</div>
        <template v-else>
          <div class="ehead">
            <span class="tt">{{ detail?.name ?? selected }}</span>
            <span class="kk mono">{{ selected }}</span>
            <span v-if="detail" class="badge" :class="dirty ? 'queued' : 'succeeded'">{{ dirty ? '未保存' : '已同步' }}</span>
            <span v-if="detail" class="muted">v{{ detail.version }} · {{ detail.steps.length }} 步</span>
            <div class="acts">
              <button v-if="mode === 'edit'" class="btn sm" title="切回说明书视图（编辑内容保留）" @click="toGuide">
                <Icon name="eye" :size="12" /> 返回说明
              </button>
              <button class="btn sm" title="查看全部 YAML 字段的用途说明" @click="helpDlg = true">
                <Icon name="sliders" :size="12" /> 字段速查
              </button>
              <button class="btn sm" title="以当前内容创建新模板" :disabled="!yamlText" @click="openCopy">
                <Icon name="copy" :size="12" /> 另存为副本
              </button>
              <button class="btn sm danger" title="删除模板文件（不可撤销）" @click="removeTemplate(selected, detail?.name ?? selected)">
                <Icon name="trash" :size="12" /> 删除
              </button>
            </div>
          </div>
          <div v-if="loadErr" class="err-text">{{ loadErr }}</div>
          <div v-if="actionErr" class="err-text">{{ actionErr }}</div>

          <!-- ===== 说明书视图（默认）：这个模板做什么 / 填什么 / 跑什么 ===== -->
          <template v-if="mode === 'guide'">
            <template v-if="detail">
              <p class="vdesc">{{ detail.description || '（模板未写介绍）' }}</p>
              <div class="vmeta">
                <span class="chip">{{ genreText(detail.genre) }}</span>
                <span v-if="detail.scene" class="chip">{{ SCENE_LABELS[detail.scene] ?? detail.scene }}</span>
                <span class="chip">v{{ detail.version }}</span>
                <span class="chip">{{ detail.steps.length }} 步</span>
              </div>

              <div class="ih">启动时要填什么</div>
              <table v-if="detail.inputs.length" class="tbl">
                <thead>
                  <tr>
                    <th>字段</th>
                    <th>问题</th>
                    <th>类型</th>
                    <th>必填</th>
                    <th>默认</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="inp in detail.inputs" :key="inp.key">
                    <td class="mono">{{ inp.key }}</td>
                    <td>{{ inp.label ?? '—' }}</td>
                    <td>{{ kindText(inp.kind) }}</td>
                    <td>{{ inp.required ? '是' : '否' }}</td>
                    <td class="mono">{{ fmtDefault(inp.default) }}</td>
                  </tr>
                </tbody>
              </table>
              <div v-else class="muted">此模板不需要填写内容，选中它直接启动即可。</div>

              <div class="ih">流水线会做什么</div>
              <ol class="steplist" role="list">
                <li v-for="(s, i) in detail.steps" :key="s.key" class="step">
                  <span class="s-idx">{{ i + 1 }}</span>
                  <div class="s-r1">
                    <span class="s-title">{{ s.title }}</span>
                    <span class="s-act">{{ actionText(s.action) }}</span>
                    <span
                      v-for="(bd, bi) in stepBadgesOf(s)"
                      :key="bi"
                      class="s-bd"
                      :class="bd.cls"
                      :title="bd.tip"
                    >{{ GUIDE_BADGE_TEXT[bd.cls] }}</span>
                  </div>
                </li>
              </ol>

              <div class="ebar">
                <span class="muted">模板文件：workspace/templates/{{ selected }}.yaml · 保存后下一个新运行立即生效</span>
                <button class="btn primary" title="打开 YAML 编辑器（高级模式）" @click="toEdit">
                  <Icon name="pencil" :size="13" /> 编辑 YAML
                </button>
              </div>
            </template>
          </template>

          <!-- ===== YAML 高级编辑 ===== -->
          <template v-else>
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

    <!-- 字段速查 -->
    <TemplateHelpModal v-if="helpDlg" @close="helpDlg = false" />

    <!-- 新建模板 -->
    <Modal v-if="newDlg" title="新建模板" :width="500" @close="newDlg = false">
      <label class="fld">
        key（文件名，仅字母/数字/下划线/中划线）
        <input v-model="newKey" type="text" placeholder="my-template" @keydown.enter="doCreate" />
      </label>
      <div class="muted" style="margin-bottom: 10px">将以最小骨架创建（从素材导入起步），创建后直接进入编辑器。</div>

      <div class="caps">
        <div class="caps-h">一个模板可以配置什么？</div>
        <ul class="caps-list">
          <li><span class="caps-t">启动表单</span>——运行时先让使用者填写的内容（文字 / 数字 / 开关 / 文件）</li>
          <li><span class="caps-t">流水线步骤</span>——按顺序执行的动作：写稿、出图、配音、合成……</li>
          <li><span class="caps-t">人工审阅闸门</span>——关键步骤暂停，等你批准 / 驳回 / 跳过</li>
          <li><span class="caps-t">批量与条件</span>——数组字段逐项批量执行；满足条件才执行某一步</li>
          <li><span class="caps-t">默认参数</span>——模型 / 音色 / 尺寸等预设，可在项目里覆盖</li>
          <li><span class="caps-t">上下游接力</span>——完成后推荐下一个模板（运行页「下一步建议」）</li>
        </ul>
        <div class="caps-tip">改完点「字段速查」可查每个字段怎么填。</div>
      </div>
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

.ehead .kk {
  font-size: 12px;
  color: var(--text-3);
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

/* ---------- [说明书改造] 说明书视图 ---------- */
.vdesc {
  font-size: 13px;
  line-height: 1.75;
  color: var(--text-2);
  margin: 0;
}

.vmeta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0 2px;
}

.steplist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}

.step {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 9px 12px;
}

.s-idx {
  flex: none;
  width: 21px;
  height: 21px;
  margin-top: 1px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  color: #a5b4fc;
  background: rgb(99 102 241 / 14%);
}

.s-r1 {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.s-title {
  font-size: 13px;
  font-weight: 600;
}

.s-act {
  font-size: 11.5px;
  color: var(--text-3);
}

.s-bd {
  font-size: 10.5px;
  line-height: 1.7;
  padding: 0 7px;
  border-radius: 5px;
  border: 1px solid transparent;
}

.s-bd.gate {
  color: #c4b5fd;
  border-color: rgb(167 139 250 / 45%);
  background: rgb(139 92 246 / 16%);
}

.s-bd.batch {
  color: #86efac;
  border-color: rgb(74 222 128 / 45%);
  background: rgb(34 197 94 / 14%);
}

.s-bd.when,
.s-bd.any {
  color: #fcd34d;
  border-color: rgb(251 191 36 / 45%);
  background: rgb(245 158 11 / 14%);
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

/* ---------- [说明书改造] 新建弹窗能力清单 ---------- */
.caps {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  margin-bottom: 10px;
}

.caps-h {
  font-size: 12.5px;
  font-weight: 600;
  margin-bottom: 7px;
}

.caps-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 5px;
}

.caps-list li {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
}

.caps-t {
  color: var(--text);
  font-weight: 500;
}

.caps-tip {
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--text-3);
}
</style>
