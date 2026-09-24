/**
 * 运行入参预填服务（G6 输入预填 + G8 视频覆盖合法档位）。
 *
 * 治理「选模板 → 填 inputs → 覆盖参数」里系统本已知/可确定推导却逼用户手填的缺口：
 *   - G6：按「上次同模板 run 真实入参（Tier A 精确复用）+ 项目 brief（Tier B 白名单放置）」预填；
 *   - G8：视频清晰度/时长覆盖项按能力真源表给合法档位（时长边界为主，域对齐防 400）。
 *
 * 纪律（对齐既有真源，不降级）：
 *   - **零成本**：纯 DB 读取 + 静态真源表推导，不发起任何 LLM / 网络调用（区别于 G7）。
 *   - **不猜测 / 不误填**：媒体类（files/publications）输入不从历史 run 复用；brief 仅放置原文、不改写。
 *   - **可追溯**：每个自动值携 `source`（template_default / last_run / brief / caps_suggest），前端标注来源。
 *   - **不改执行契约**：仅产出建 run 前表单候选值；`_params` 三层叠加语义零触碰。
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { apiConfigs, pipelineRuns, projects } from '../db/schema'
import { loadTemplate } from '../pipeline/loader'
import type { Template, TemplateInputDef } from '../pipeline/types'
import { resolveVideoCaps } from '../adapters/video-capabilities'

export type PrefillSource = 'template_default' | 'last_run' | 'brief'

export interface PrefillInputValue {
  value: string | number | boolean
  source: PrefillSource
}

/** G8 视频覆盖候选（域对齐：可选下拉 = caps ∩ 输入白名单，防 validateRunParams 400） */
export interface VideoOverride {
  providerKey: string
  model: string
  /** 合法时长档位（秒，升序）——用于收窄时长数字输入 min/max */
  durations: number[]
  defaultDuration: number
  /** caps 输出档位（仅展示性提示） */
  resolutions: string[]
  /** 覆盖下拉实际可选项 = caps ∩ {480p,720p,1080p}；交集空则回落全量 */
  selectableResolutions: string[]
  /** 推荐默认（仅当 ∈ selectableResolutions 否则 null） */
  defaultResolution: string | null
  source: 'caps_suggest'
}

export interface PrefillResult {
  projectId: number
  templateKey: string
  inputs: Record<string, PrefillInputValue>
  lastRunId: number | null
  overrides: { video: VideoOverride | null }
}

/** 资源不存在（路由层转 404） */
export class PrefillError extends Error {
  constructor(
    public code: 'template_not_found' | 'project_not_found',
    message: string,
  ) {
    super(message)
    this.name = 'PrefillError'
  }
}

/** run-params video.resolution 输入白名单域（与 services/run-params RULES 对齐） */
const RESOLUTION_WHITELIST = ['480p', '720p', '1080p']

/** brief 放置白名单：key 或 label 命中其一（大小写不敏感）方视为「可承接项目简介」的文本输入 */
const BRIEF_RE =
  /(简介|主题|选题|方向|标题|文案|大纲|梗概|idea|topic|theme|title|brief|description|summary|outline|synopsis)/i

function isMediaInput(inp: TemplateInputDef): boolean {
  return inp.kind === 'files' || inp.kind === 'publications'
}

function safeJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 按输入 kind 归一标量值（int→number、bool→boolean、其余→string） */
function coerce(v: unknown, inp: TemplateInputDef): string | number | boolean {
  if (inp.kind === 'int') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  if (inp.kind === 'bool') return v === true || v === 'true'
  return typeof v === 'string' ? v : String(v)
}

/** 有效值判定：非空标量（跳过 undefined/null/空串/对象/数组） */
function usableScalar(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'object') return false
  if (typeof v === 'string' && v.trim() === '') return false
  return true
}

/** G8：解析有效视频实例档位（project.settings.video 优先，回落默认 video 实例），复用 resolveVideoCaps */
async function resolveVideoOverride(
  template: Template,
  settingsVideo: Record<string, unknown> | null,
): Promise<VideoOverride | null> {
  const usesVideo = template.steps.some((s) => s.action === 'ai_video' || s.action === 'ffmpeg_merge')
  if (!usesVideo) return null

  let providerKey = ''
  let model = ''
  if (settingsVideo && typeof settingsVideo.provider === 'string' && typeof settingsVideo.model === 'string') {
    providerKey = settingsVideo.provider.trim()
    model = settingsVideo.model.trim()
  }
  if (!providerKey || !model) {
    const [inst] = await db
      .select({ providerKey: apiConfigs.providerKey, model: apiConfigs.model })
      .from(apiConfigs)
      .where(and(eq(apiConfigs.serviceType, 'video'), eq(apiConfigs.isDefault, 1)))
      .limit(1)
    if (inst) {
      providerKey = inst.providerKey
      model = inst.model ?? ''
    }
  }
  if (!providerKey || !model) return null

  const caps = resolveVideoCaps(providerKey, model)
  if (!caps) return null // 未登记模型 → 不背书（前端回退手填）

  const intersect = caps.resolutions.filter((r) => RESOLUTION_WHITELIST.includes(r))
  const selectable = intersect.length ? intersect : [...RESOLUTION_WHITELIST]
  const defaultResolution = intersect.includes(caps.defaultResolution) ? caps.defaultResolution : null
  return {
    providerKey,
    model,
    durations: caps.durations,
    defaultDuration: caps.defaultDuration,
    resolutions: caps.resolutions,
    selectableResolutions: selectable,
    defaultResolution,
    source: 'caps_suggest',
  }
}

/**
 * 依 (projectId, templateKey) 解析预填候选值。
 * 输入值优先级（后覆盖前，逐 key 记最终 source）：template_default < last_run < brief。
 * template/project 不存在 → 抛 PrefillError（路由转 404）。
 */
export async function resolveRunPrefill(projectId: number, templateKey: string): Promise<PrefillResult> {
  let template: Template
  try {
    template = loadTemplate(templateKey)
  } catch {
    throw new PrefillError('template_not_found', `模板「${templateKey}」不存在`)
  }

  const [proj] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1)
  if (!proj) throw new PrefillError('project_not_found', `项目 #${projectId} 不存在`)

  const inputs: Record<string, PrefillInputValue> = {}
  const defaults = (template.defaults ?? {}) as Record<string, unknown>

  // ① template_default（模板声明级，兼容旧 defaults[key]）
  for (const inp of template.inputs) {
    if (isMediaInput(inp)) continue
    const d = inp.default !== undefined ? inp.default : defaults[inp.key]
    if (usableScalar(d)) inputs[inp.key] = { value: coerce(d, inp), source: 'template_default' }
  }

  // ② last_run（最近一条 input 可解析的同模板 run 的精确标量值复用；媒体类 / 内部键 _ 前缀排除）
  let lastRunId: number | null = null
  const runRows = await db
    .select({ id: pipelineRuns.id, input: pipelineRuns.input })
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.projectId, projectId), eq(pipelineRuns.templateKey, templateKey)))
    .orderBy(desc(pipelineRuns.updatedAt))
    .limit(10)
  for (const r of runRows) {
    const parsed = safeJsonObject(r.input)
    if (!parsed) continue
    lastRunId = r.id
    for (const inp of template.inputs) {
      if (isMediaInput(inp)) continue
      const v = parsed[inp.key]
      if (!usableScalar(v)) continue
      inputs[inp.key] = { value: coerce(v, inp), source: 'last_run' }
    }
    break // 仅取最近一条可解析 run
  }

  // ③ brief（白名单命中的仍为空 text 输入 → 放置项目简介原文，不改写；无 brief 回落项目名）
  const briefText = (proj.brief && proj.brief.trim()) || (proj.name && proj.name.trim()) || ''
  if (briefText) {
    for (const inp of template.inputs) {
      if (inp.kind !== 'text') continue
      if (inputs[inp.key]) continue // 已有 default / last_run 值不覆盖
      const hay = `${inp.key} ${inp.label ?? ''}`
      if (BRIEF_RE.test(hay)) inputs[inp.key] = { value: briefText, source: 'brief' }
    }
  }

  // ④ G8 视频覆盖合法档位
  const settingsJson = safeJsonObject(proj.settings)
  const settingsVideo =
    settingsJson && settingsJson.video && typeof settingsJson.video === 'object' && !Array.isArray(settingsJson.video)
      ? (settingsJson.video as Record<string, unknown>)
      : null
  const video = await resolveVideoOverride(template, settingsVideo)

  return { projectId, templateKey, inputs, lastRunId, overrides: { video } }
}
