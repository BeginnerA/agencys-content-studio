<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Modal from '../common/Modal.vue'
import TemplatePicker from '../template/TemplatePicker.vue'
import TemplateInputFields from '../template/TemplateInputFields.vue'
import ProvenanceBadge from '../common/ProvenanceBadge.vue'
import ContinuityPreview from './ContinuityPreview.vue'
import { manualTarget, submitManualRun } from '../../lib/continuity-entry'
import { useCreationContinuity } from '../../views/easy-create/use-creation-continuity'
import type {
  Asset,
  Episode,
  PrefillSource,
  Publication,
  TemplateDetail,
  TemplateMeta,
  VideoOverride,
} from '../../lib/types'
import {
  projectApi,
  publicationApi,
  runApi,
  seriesApi,
  templateApi,
} from '../../lib/api'
import { filterSelectable } from '../../lib/scene'

const props = defineProps<{
  projectId: number
  initialTemplateKey?: string
  defaultTemplateKey?: string
  /** 输入预填（如剧集地图「起作」带 episode_number；仅覆盖模板声明的键） */
  prefillInput?: Record<string, unknown>
}>()
const emit = defineEmits<{ done: [runId: number]; close: [] }>()

const templates = ref<TemplateMeta[]>([])
const tplKey = ref('')
const tpl = ref<TemplateDetail | null>(null)
const assets = ref<Asset[]>([])
/** 项目发布记录（publications 类输入的选择源，复盘回灌直接勾选） */
const publications = ref<Publication[]>([])
const form = ref<Record<string, unknown>>({})
/** 自动预填来源映射（key → last_run/brief；用户编辑即剔除，驱动字段 chip） */
const sourceMap = ref<Record<string, PrefillSource>>({})
// ===== M70 跨集剧情连续性（brief 12.3）：专用开关默认关；保留槽位隐藏；批准随输入/集号失效 =====
const RESERVED_INPUTS = ['with_continuity', 'continuity_context']
const episodes = ref<Episode[]>([])
const continuity = useCreationContinuity(computed(() => props.projectId))
const continuityOn = ref(false)
const showContinuityPreview = ref(false)
/** 模板声明了 with_continuity（须为 bool 输入）才可启用——与 run-binding 的声明闸门同口径 */
const supportsContinuity = computed(
  () =>
    tpl.value?.inputs.some(
      (i) => i.key === 'with_continuity' && i.kind === 'bool',
    ) === true,
)
/** 保留槽位（with_continuity/continuity_context）不呈现为普通字段，由专用开关与批准包接管 */
const displayTpl = computed<TemplateDetail | null>(() =>
  tpl.value
    ? {
        ...tpl.value,
        inputs: tpl.value.inputs.filter(
          (i) => !RESERVED_INPUTS.includes(i.key),
        ),
      }
    : null,
)
const episodeNumber = computed(() => Number(form.value['episode_number']))
const episode = computed(
  () => episodes.value.find((e) => e.number === episodeNumber.value) ?? null,
)
/** 无效范围（无合法集 / 项目无该集）先提示建剧集，开关不可用 */
const continuityRangeHint = computed(() => {
  if (!supportsContinuity.value) return ''
  if (!Number.isSafeInteger(episodeNumber.value) || episodeNumber.value <= 0)
    return '当前集号无效：请先在项目中建立剧集（无效范围不允许启用承接）'
  if (!episode.value) return '项目中尚无该集：请先建立剧集再启用承接'
  return ''
})
const continuityReady = computed(
  () => supportsContinuity.value && episode.value !== null,
)
/** G8 视频覆盖合法档位（null → 前端回退现硬编码手填） */
const videoOverride = ref<VideoOverride | null>(null)
const RES_DEFAULT = ['480p', '720p', '1080p']
const resolutionOptions = computed(() =>
  videoOverride.value?.selectableResolutions?.length
    ? videoOverride.value.selectableResolutions
    : RES_DEFAULT,
)
const durationMin = computed(() => videoOverride.value?.durations?.[0] ?? 1)
const durationMax = computed(() => {
  const d = videoOverride.value?.durations
  return d?.length ? d[d.length - 1] : 30
})
/** 集级参数覆盖（run.input._params；全空 = 不覆盖，继承项目 settings / 模板 defaults） */
const adv = ref({
  imageSize: '',
  resolution: '',
  duration: '',
  voice: '',
  temperature: '',
})

/** action → 可覆盖参数分组：仅当模板实际用到对应生成环节时才显示相应字段 */
const ACTION_GROUP: Record<string, 'image' | 'video' | 'audio' | 'llm'> = {
  ai_image: 'image',
  ai_video: 'video',
  tts: 'audio',
  ai_text: 'llm',
}
/** 当前模板涉及的参数分组集合（据 steps[].action 推导） */
const activeGroups = computed(() => {
  const s = new Set<'image' | 'video' | 'audio' | 'llm'>()
  for (const st of tpl.value?.steps ?? []) {
    const g = ACTION_GROUP[st.action]
    if (g) s.add(g)
  }
  return s
})
const showImage = computed(() => activeGroups.value.has('image'))
const showVideo = computed(() => activeGroups.value.has('video'))
const showAudio = computed(() => activeGroups.value.has('audio'))
const showLlm = computed(() => activeGroups.value.has('llm'))
/** 模板不涉及任何可覆盖环节 → 整块「本集参数覆盖」不显示 */
const hasOverride = computed(() => activeGroups.value.size > 0)

function resetAdv(): void {
  adv.value = {
    imageSize: '',
    resolution: '',
    duration: '',
    voice: '',
    temperature: '',
  }
}
const err = ref('')
const notice = ref('')
const busy = ref(false)
const loading = ref(false)
const loadingDetail = ref(false)

/** 用户编辑任一预填字段 → 写入值并剔除该 key 的来源 chip（接管后不再标自动） */
function onFieldChange(k: string, v: unknown): void {
  form.value[k] = v
  if (k in sourceMap.value) {
    const next = { ...sourceMap.value }
    delete next[k]
    sourceMap.value = next
  }
}

/** 第二步：选中模板 → 加载详情 + 回填默认值 */
async function selectTemplate(key: string) {
  // 换模板 = 换承接目标：旧批准一律作废，专用开关回到默认关
  continuity.clear()
  continuityOn.value = false
  showContinuityPreview.value = false
  tplKey.value = key
  tpl.value = null
  form.value = {}
  sourceMap.value = {}
  videoOverride.value = null
  resetAdv()
  err.value = ''
  loadingDetail.value = true
  try {
    const res = await templateApi.detail(key)
    tpl.value = res.template
    const defaults = (res.template.defaults ?? {}) as Record<string, unknown>
    for (const inp of res.template.inputs) {
      // 输入预填同源：优先 inputs.default（模板声明级），兼容旧 defaults[inp.key] 写法
      const d = inp.default !== undefined ? inp.default : defaults[inp.key]
      if (inp.kind === 'int') form.value[inp.key] = d ?? ''
      else if (inp.kind === 'bool') form.value[inp.key] = d === true
      else if (inp.kind === 'files') form.value[inp.key] = []
      else if (inp.kind === 'publications') form.value[inp.key] = []
      else if (inp.kind === 'multi_select')
        form.value[inp.key] = Array.isArray(d) ? [...d] : []
      else form.value[inp.key] = d ?? ''
    }
    // G6 输入预填（历史 run + brief）+ G8 视频合法档位；失败非致命→回落模板默认
    try {
      const pf = await templateApi.prefill(props.projectId, key)
      for (const [k, iv] of Object.entries(pf.inputs)) {
        form.value[k] = iv.value
        if (iv.source === 'last_run' || iv.source === 'brief')
          sourceMap.value[k] = iv.source
      }
      videoOverride.value = pf.overrides?.video ?? null
    } catch {
      videoOverride.value = null
    }
    // 起作预填（如 episode_number）：覆盖模板默认值 / 预填（仅模板声明的键，用户上下文非自动）
    if (props.prefillInput) {
      for (const inp of res.template.inputs) {
        const pv = props.prefillInput[inp.key]
        if (pv !== undefined) {
          form.value[inp.key] = pv
          if (inp.key in sourceMap.value) {
            const next = { ...sourceMap.value }
            delete next[inp.key]
            sourceMap.value = next
          }
        }
      }
    }
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loadingDetail.value = false
  }
}

/** 返回第一步（重选模板） */
function backToPicker() {
  continuity.clear()
  continuityOn.value = false
  showContinuityPreview.value = false
  tplKey.value = ''
  tpl.value = null
  form.value = {}
  sourceMap.value = {}
  videoOverride.value = null
  resetAdv()
  err.value = ''
}

/** 表单内上传新素材：并入 assets 选择源（按 id 去重，新的置前） */
function onAssetsAppended(added: Asset[]): void {
  const existing = new Set(assets.value.map((a) => a.id))
  const fresh = added.filter((a) => !existing.has(a.id))
  if (fresh.length) assets.value = [...fresh, ...assets.value]
}

/** 归一化表单值 → run input（保留槽位 with_continuity/continuity_context 只由批准包注入） */
function buildInput(): Record<string, unknown> | null {
  if (!tpl.value) return null
  // 归一化：空字符串 → 未填
  const input: Record<string, unknown> = {}
  for (const inp of tpl.value.inputs) {
    if (RESERVED_INPUTS.includes(inp.key)) continue
    const v = form.value[inp.key]
    if (
      inp.required &&
      (v === '' || v === undefined || (Array.isArray(v) && v.length === 0))
    ) {
      err.value = `请填写必填项「${inp.label}」`
      return null
    }
    if (inp.kind === 'int') input[inp.key] = Number(v)
    else if (inp.kind === 'float') input[inp.key] = Number(v)
    else if (inp.kind === 'bool') input[inp.key] = v === true
    else if (inp.kind === 'files') input[inp.key] = (v as number[]) ?? []
    else if (inp.kind === 'publications') input[inp.key] = (v as number[]) ?? []
    else if (inp.kind === 'multi_select') input[inp.key] = (v as string[]) ?? []
    else input[inp.key] = v ?? ''
  }
  // 集级参数覆盖（非空才附 _params；服务端白名单校验 + clamp，非法会 400）
  // 仅提交当前模板实际涉及的分组，隐藏字段一律忽略（双保险，防残留值误提交）
  const p: Record<string, Record<string, unknown>> = {}
  if (showImage.value && adv.value.imageSize.trim())
    p.image = { size: adv.value.imageSize.trim() }
  if (showVideo.value) {
    const resolution = adv.value.resolution
    const duration = adv.value.duration.trim()
      ? Number(adv.value.duration)
      : undefined
    if (resolution || (duration !== undefined && Number.isFinite(duration))) {
      p.video = {}
      if (resolution) p.video.resolution = resolution
      if (duration !== undefined && Number.isFinite(duration))
        p.video.duration = duration
    }
  }
  if (showAudio.value && adv.value.voice.trim())
    p.audio = { voice: adv.value.voice.trim() }
  if (showLlm.value) {
    const temperature = adv.value.temperature.trim()
      ? Number(adv.value.temperature)
      : undefined
    if (temperature !== undefined && Number.isFinite(temperature))
      p.llm = { temperature }
  }
  if (Object.keys(p).length > 0) input['_params'] = p
  return input
}

/** 打开共享承接预览面：目标 = 当前模板 + 当前集 + 当前输入（与最终 run input 同源） */
function openContinuity() {
  err.value = ''
  if (!tpl.value) return
  if (!continuityReady.value || !episode.value) {
    err.value = continuityRangeHint.value
    return
  }
  const fields = buildInput()
  if (!fields) return
  continuity.setTarget(
    manualTarget({
      episodeId: episode.value.id,
      templateKey: tpl.value.key,
      fields,
      withContinuity: true,
    }),
  )
  showContinuityPreview.value = true
  void continuity.state.load()
}

/** 专用开关（默认关）：关闭清批准；开启即打开预览（不绕过共享批准面） */
function onContinuityToggle() {
  err.value = ''
  if (!continuityOn.value) {
    showContinuityPreview.value = false
    continuity.clear()
    return
  }
  if (!continuityReady.value) {
    continuityOn.value = false
    err.value = continuityRangeHint.value
    return
  }
  openContinuity()
}

function onFrozen() {
  showContinuityPreview.value = false
  notice.value = '承接包已冻结，可启动本集（批准随输入变化自动失效）'
}

// 集号 / brief / 任何输入或 _params 变化 → 旧批准立即失效；面板开着重载免费预览
watch(
  [form, adv],
  () => {
    continuity.invalidate()
    if (showContinuityPreview.value && continuationTargetExists())
      void continuity.state.load()
  },
  { deep: true },
)
function continuationTargetExists(): boolean {
  return continuity.target.value !== null
}

async function submit() {
  if (!tpl.value || busy.value) return
  const input = buildInput()
  if (!input) return
  err.value = ''
  notice.value = ''
  // 连续性启用：必须有当前目标的批准，否则不发请求（打开预览引导确认）
  if (continuityOn.value && !continuity.approval.value) {
    openContinuity()
    err.value = '请先在本集承接预览中确认并冻结承接包，再启动（未批准不会提交）'
    return
  }
  busy.value = true
  try {
    const outcome = await submitManualRun(
      { run: runApi },
      {
        projectId: props.projectId,
        templateKey: tpl.value.key,
        input,
        withContinuity: continuityOn.value,
        approval: continuity.approval.value,
      },
    )
    if (!outcome.sent) {
      err.value = outcome.message
      return
    }
    emit('done', outcome.result.run.id)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function init() {
  loading.value = true
  try {
    const [tRes, aRes, pubRes] = await Promise.all([
      templateApi.list(),
      projectApi.assets(props.projectId, '?limit=100'),
      publicationApi.list(`?project_id=${props.projectId}`),
    ])
    // 承接开关只在「项目已有合法剧集」时可用：集表失败不阻断启动表单（开关回落不可用 + 提示先建剧集）
    try {
      episodes.value = (await seriesApi.get(props.projectId)).episodes
    } catch {
      episodes.value = []
    }
    // 启动选卡不呈现轻松创作批准链模板（选它们无 recipe 无法启动）
    templates.value = filterSelectable(tRes.items)
    assets.value = aRes.items
    publications.value = pubRes.items
    // 接力入口（initialTemplateKey 命中）直达表单；否则停在选卡段（不再自动选中字母序第一个）
    const initKey = props.initialTemplateKey
    if (initKey && tRes.items.some((t) => t.key === initKey))
      await selectTemplate(initKey)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
init()
</script>

<template>
  <Modal title="启动流水线（新建 Run）" :width="680" @close="emit('close')">
    <div v-if="loading" class="empty">加载中…</div>
    <template v-else>
      <!-- 第一步：场景选卡（默认入口，按「出成品 / 做规划 / 发布与复盘」分组） -->
      <template v-if="!tplKey">
        <div class="lead muted">
          选择要做什么——产出类模板直接出成品；选题、策划、适配、复盘等辅助模板按需单独使用。
          <template v-if="defaultTemplateKey"
            >带「默认」标记的是本项目常用模板。</template
          >
        </div>
        <TemplatePicker
          :templates="templates"
          :default-key="defaultTemplateKey"
          @select="selectTemplate"
        />
      </template>
      <!-- 第二步：输入表单 -->
      <template v-else>
        <div class="sel-h">
          <button type="button" class="lnk" @click="backToPicker">
            ← 重选模板
          </button>
          <span class="sel-nm">{{ tpl?.name ?? tplKey }}</span>
        </div>
        <div v-if="loadingDetail" class="empty">加载中…</div>
        <template v-else-if="tpl">
          <div class="desc muted" style="margin-bottom: 10px">
            {{ tpl.description }}
          </div>
          <TemplateInputFields
            v-if="displayTpl"
            :tpl="displayTpl"
            :assets="assets"
            :publications="publications"
            :values="form"
            :sources="sourceMap"
            :project-id="projectId"
            @change="onFieldChange"
            @assets-appended="onAssetsAppended"
            @notice="notice = $event"
          />
          <!-- M70 跨集剧情连续性：专用开关（默认关）+ 共享承接预览/冻结；保留槽位不呈现为普通字段 -->
          <div v-if="supportsContinuity" class="cont">
            <label class="cont-sw">
              <input
                v-model="continuityOn"
                type="checkbox"
                :disabled="busy"
                @change="onContinuityToggle"
              />
              使用已确认跨集剧情（默认关闭；启用后需先冻结承接包）
            </label>
            <p v-if="continuityRangeHint" class="err-text">
              {{ continuityRangeHint }}
            </p>
            <template v-else-if="continuityOn">
              <p class="muted cont-hint">
                {{
                  continuity.frozen.value
                    ? '承接包已冻结；改动集号 / brief / 参数会自动失效，需重新确认。'
                    : '尚未冻结批准：启动前必须在本集承接预览中确认缺口与费用风险。'
                }}
              </p>
              <button
                type="button"
                class="btn cont-open"
                :disabled="busy"
                @click="openContinuity"
              >
                {{
                  continuity.frozen.value ? '重新查看承接包' : '打开承接预览'
                }}
              </button>
            </template>
            <div v-if="showContinuityPreview" class="cont-panel">
              <ContinuityPreview :state="continuity.state" @frozen="onFrozen" />
              <button
                type="button"
                class="btn"
                @click="showContinuityPreview = false"
              >
                关闭预览（不提交）
              </button>
            </div>
          </div>
          <!-- 集级参数覆盖：runtime 叠加，仅本 run 生效（优先于项目设置/模板默认）；按模板用到的生成环节动态显隐 -->
          <details v-if="hasOverride" class="adv">
            <summary>
              本集参数覆盖（可选）——仅本 run 生效，优先于项目设置
              <!-- 补齐 caps_suggest 来源标注：合法域非手拍，由平台能力真源表收窄 -->
              <ProvenanceBadge
                v-if="videoOverride"
                kind="auto"
                text="能力表合法域"
                :title="`时长/分辨率可选域由平台能力真源表按本模型（${videoOverride.model}）收窄，越界会被服务端 clamp`"
              />
            </summary>
            <div class="adv-grid">
              <label v-if="showImage" class="fld"
                >出图尺寸
                <input
                  v-model="adv.imageSize"
                  placeholder="宽x高，如 832x1248（默认用项目设置）"
                />
              </label>
              <label v-if="showVideo" class="fld"
                >视频清晰度
                <select v-model="adv.resolution">
                  <option value="">默认</option>
                  <option v-for="r in resolutionOptions" :key="r" :value="r">
                    {{ r }}
                  </option>
                </select>
                <span v-if="videoOverride?.defaultResolution" class="cap-hint"
                  >推荐 {{ videoOverride.defaultResolution }}（本模型
                  {{ videoOverride.model }}）</span
                >
              </label>
              <label v-if="showVideo" class="fld"
                >单镜时长（秒）
                <input
                  v-model="adv.duration"
                  type="number"
                  :min="durationMin"
                  :max="durationMax"
                  :placeholder="`${durationMin}–${durationMax}（默认用项目设置）`"
                />
                <span v-if="videoOverride" class="cap-hint"
                  >推荐 {{ videoOverride.defaultDuration }}s（本模型
                  {{ durationMin }}–{{ durationMax }}s）</span
                >
              </label>
              <label v-if="showAudio" class="fld"
                >配音音色
                <input
                  v-model="adv.voice"
                  placeholder="如 Cherry（默认用项目设置）"
                />
              </label>
              <label v-if="showLlm" class="fld"
                >LLM 温度
                <input
                  v-model="adv.temperature"
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  placeholder="0–2（默认用项目设置）"
                />
              </label>
            </div>
          </details>
        </template>
      </template>

      <div v-if="notice" class="muted" style="margin-top: 8px">
        {{ notice }}
      </div>
      <div v-if="err" class="err-text">{{ err }}</div>
    </template>

    <template #footer>
      <button class="btn" @click="emit('close')">取消</button>
      <button
        class="btn primary"
        :disabled="busy || !tpl || !tplKey"
        @click="submit"
      >
        {{ busy ? '启动中…' : '启动' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.lead {
  margin-bottom: 10px;
}

.sel-h {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.lnk {
  border: none;
  background: none;
  padding: 0;
  color: var(--accent-h);
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
}

.lnk:hover {
  text-decoration: underline;
}

.sel-nm {
  font-size: 14px;
  font-weight: 600;
}

.desc {
  margin-top: -4px;
}

.adv {
  margin-top: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
}

.adv summary {
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text-2);
  user-select: none;
}

.adv-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px 12px;
  margin-top: 4px;
}

.cap-hint {
  margin-top: 2px;
  font-size: 11px;
  font-style: normal;
  color: var(--accent-h);
}

.cont {
  margin-top: 12px;
  border: 1px solid var(--accent);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cont-sw {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.cont-hint {
  margin: 0;
  font-size: 12px;
}

.cont-open {
  align-self: flex-start;
}

.cont-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
