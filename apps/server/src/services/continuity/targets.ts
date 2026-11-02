import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { episodes, pipelineRuns } from '../../db/schema'
import { loadTemplate } from '../../pipeline/loader'
import type { Template } from '../../pipeline/types'
import type { LlmEndpoint } from '../llm'
import { ContinuityError, TargetRequestSchema, TemplateSchema,
  type Executor, type Target, type TargetRequest, type Unit } from './contract'
import { canonicalHash } from './fold'
import { continuityIO } from './runtime'
import { resolveUnit } from './scope'
import { resolveRouteContinuityTarget } from './route-bridge'
import { resolveWorkflowContinuityTarget } from './workflow-bridge'

export const TARGET_LIMITS = { render: 24_000, input: 160_000 } as const
const LLM_FALLBACK = { temperature: 0, maxTokens: 24_000, timeoutMs: 600_000 } as const

export type MaterializedTarget = {
  target: Target
  input: Record<string, unknown>
  template: Template
  maxChars: number
}

const unsupported = (): never => { throw new ContinuityError('continuity_unsupported', 400) }
const invalid = (): never => { throw new ContinuityError('continuity_source_invalid', 400) }
const missing = (): never => { throw new ContinuityError('continuity_source_invalid', 404) }

/** Only protocol/host/path survive: credentials, query strings and fragments never reach hashes or logs. */
export function sanitizeBaseUrl(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch { return '' }
}

/** A template may lower the render cap for its own prompts; it can never raise the 24000 hard cap. */
export function maxRenderChars(template: Template): number {
  const raw = template.defaults?.['continuity']
  const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)['max_render_chars'] : undefined
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(TARGET_LIMITS.render, value) : TARGET_LIMITS.render
}

/** Exactly one explicitly declared non-batch episode_script ai_text step may consume the pack. */
export function targetStep(template: Template): Template['steps'][number] {
  const found = template.steps.filter(step => step.action === 'ai_text' && !step.batch
    && (step.params as Record<string, unknown> | undefined)?.['continuity_role'] === 'episode_script')
  if (found.length !== 1) unsupported()
  return found[0]!
}

const declaredInput = (template: Template, wanted: string): Template['inputs'][number] | undefined =>
  template.inputs.find(input => input.key === wanted)

/** Targets must declare the two mandatory continuity inputs; missing declarations are unsupported. */
export function requireTargetInputs(template: Template): void {
  const brief = declaredInput(template, 'brief')
  const episode = declaredInput(template, 'episode_number')
  if (!brief || brief.kind !== 'text' || !episode || episode.kind !== 'int') unsupported()
}

function declaredValue(kind: Template['inputs'][number]['kind'], value: unknown): boolean {
  switch (kind) {
    case 'bool': return typeof value === 'boolean'
    case 'int': return typeof value === 'number' && Number.isInteger(value)
    case 'float': return typeof value === 'number' && Number.isFinite(value)
    case 'text': case 'date': return typeof value === 'string' && value.trim().length > 0
    case 'select': return typeof value === 'string' && value.length > 0
    case 'multi_select': return Array.isArray(value) && value.every(entry => typeof entry === 'string')
    default: return value !== null && value !== undefined
  }
}

/** Continuity is always on for a target run; the ledger slot is reserved, never caller-supplied. */
export function effectiveInput(template: Template, unit: Unit, raw: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { ...raw }
  delete input['continuity_context']
  if (declaredInput(template, 'episode_number') && input['episode_number'] !== unit.unitOrdinal) invalid()
  if (declaredInput(template, 'with_continuity')) input['with_continuity'] = true
  for (const def of template.inputs) {
    if (def.required && !declaredValue(def.kind, input[def.key])) invalid()
  }
  return input
}

export function llmOptions(template: Template): { temperature: number; maxTokens: number; timeoutMs: number } {
  const raw = template.defaults?.['llm']
  const defaults = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const temperature = typeof defaults['temperature'] === 'number' && Number.isFinite(defaults['temperature'])
    ? defaults['temperature'] : LLM_FALLBACK.temperature
  const maxTokens = typeof defaults['max_tokens'] === 'number' && Number.isInteger(defaults['max_tokens']) && defaults['max_tokens'] > 0
    ? defaults['max_tokens'] : LLM_FALLBACK.maxTokens
  return { temperature, maxTokens, timeoutMs: LLM_FALLBACK.timeoutMs }
}

/** 模板快照哈希（JSON round-trip 规范化：文件加载与快照解析的模板哈希恒等）。 */
export function snapshotHashOf(template: Template): string {
  const normalized = JSON.parse(JSON.stringify(template)) as Template
  return canonicalHash(normalized)
}

/** 续跑目标模板只认源 run 快照：缺失/非法/key 不符一律 unsupported，
 * 绝不静默换成最新版模板或自动关闭 with_continuity。 */
export function resumeSnapshotTemplate(run: { templateKey: string; templateSnapshot: string | null }): Template {
  if (!run.templateSnapshot) return unsupported()
  let snapshot: unknown
  try { snapshot = JSON.parse(run.templateSnapshot) } catch { return unsupported() }
  const parsed = TemplateSchema.safeParse(snapshot)
  if (!parsed.success || parsed.data.key !== run.templateKey) return unsupported()
  return parsed.data
}

function finish(unit: Unit, request: TargetRequest, template: Template, stepKey: string,
    input: Record<string, unknown>, projectId: number, endpoint: LlmEndpoint): MaterializedTarget {
  const templateSnapshotHash = snapshotHashOf(template)
  // Credential-free configuration identity: provider/model, sanitized endpoint, options, template and project only.
  const configHash = canonicalHash({ kind: 'continuity_config', provider: endpoint.providerKey, model: endpoint.model,
    baseUrl: sanitizeBaseUrl(endpoint.baseUrl), options: llmOptions(template),
    template: { key: template.key, version: template.version, snapshotHash: templateSnapshotHash },
    project: projectId, params: input['_params'] ?? null })
  return {
    target: { unit, request, templateKey: template.key, templateSnapshotHash, stepKey,
      inputHash: canonicalHash(input), configHash },
    input, template, maxChars: maxRenderChars(template),
  }
}

/** Manual targets read the current real template library; resume targets read the original run snapshot. */
export async function materializeTarget(projectId: number, request: TargetRequest, ex: Executor,
    endpoint: LlmEndpoint): Promise<MaterializedTarget> {
  if (request.kind === 'route') {
    // 定位信息只是线索：实际决策/模板/输入由 route-bridge 从会话行重导出（纯解析，无副作用）；
    // 模板级支持性（单非 batch 目标步 + 必备声明）与本管线其余 kind 同闸。
    const material = await resolveRouteContinuityTarget(projectId, request, ex)
    const step = targetStep(material.template)
    requireTargetInputs(material.template)
    const input = effectiveInput(material.template, material.unit, material.input)
    return finish(material.unit, request, material.template, step.key, input, projectId, endpoint)
  }
  if (request.kind === 'workflow') {
    // 定位信息只是线索：实际段/模板/输入由 workflow-bridge 从链状态重导出（纯解析，无副作用）。
    const material = await resolveWorkflowContinuityTarget(projectId, request, ex)
    const step = targetStep(material.template)
    requireTargetInputs(material.template)
    const input = effectiveInput(material.template, material.unit, material.input)
    return finish(material.unit, request, material.template, step.key, input, projectId, endpoint)
  }
  if (request.kind === 'manual') {
    const unit = await resolveUnit(projectId, request.episodeId, ex)
    let template: Template
    try { template = loadTemplate(request.templateKey) } catch { return missing() }
    const step = targetStep(template)
    requireTargetInputs(template)
    const input = effectiveInput(template, unit, request.input)
    return finish(unit, request, template, step.key, input, projectId, endpoint)
  }
  const [run] = await ex.select().from(pipelineRuns).where(and(eq(pipelineRuns.id, request.runId), eq(pipelineRuns.projectId, projectId))).limit(1)
  if (!run) return missing()
  const template = resumeSnapshotTemplate(run)
  let raw: Record<string, unknown>
  try {
    const parsedInput: unknown = JSON.parse(run.input)
    if (!parsedInput || typeof parsedInput !== 'object' || Array.isArray(parsedInput)) return invalid()
    raw = parsedInput as Record<string, unknown>
  } catch { return invalid() }
  if (typeof raw['episode_number'] !== 'number' || !Number.isInteger(raw['episode_number'])) return invalid()
  const [episode] = await ex.select({ id: episodes.id }).from(episodes)
    .where(and(eq(episodes.projectId, projectId), eq(episodes.number, raw['episode_number']))).limit(1)
  if (!episode) return missing()
  const unit = await resolveUnit(projectId, episode.id, ex)
  const step = targetStep(template)
  requireTargetInputs(template)
  const input = effectiveInput(template, unit, raw)
  return finish(unit, request, template, step.key, input, projectId, endpoint)
}

/** Endpoint resolution happens at invocation, before any write transaction; freeze passes it back explicitly. */
export async function resolveTarget(projectId: number, request: TargetRequest, ex: Executor): Promise<MaterializedTarget> {
  const parsed = TargetRequestSchema.safeParse(request)
  if (!parsed.success) return invalid()
  return materializeTarget(projectId, parsed.data, ex, await continuityIO().endpoint())
}
