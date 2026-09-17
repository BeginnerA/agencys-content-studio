import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db'
import { assets } from '../db/schema'
import { assertProjectAssets } from '../pipeline/refs'
import { InvalidRunInputError, loadTemplateOrThrow } from './run-create'
import { createBatch } from './batch'
import { chatCompleteDetailed, loadPromptTemplate, type ChatContentPart } from './llm'
import { recordLlmUsage } from './usage'
import { assetToDataUri } from './asset-ref'
import { writeTextAsset } from './storage'
import { aggregateEvalMatrix, parseEvalScores, renderEvalReport, type EvalGroup, type EvalScore } from './eval'

// [M24·F2] 一致性 A/B 评测编排（spec §2.3）：生成侧全复用 batch（零新调度），
// 评分侧 = 多模态 LLM（参考图在前，assetToDataUri 同 style-preset 先例）→ 纯函数三件套（services/eval.ts）。
// 参数错误 → EvalParamError（fail() 兜底 400）；模板缺失沿用 InvalidRunInputError；LLM 未配置由路由层转 400 llm_unavailable。

const GROUPS_MAX = 6
const ASSETS_MAX = 24

export class EvalParamError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'EvalParamError'
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null)

/** 对照批次提交：base_input + input_patch 展开 → createBatch（组间串行调度复用 batch 机制） */
export async function runConsistencyEval(body: Record<string, unknown>): Promise<{ batch_id: number; run_ids: number[]; labels: string[] }> {
  const projectId = posInt(body.project_id)
  if (!projectId) throw new EvalParamError('project_id 需为正整数')
  const templateKey = typeof body.template_key === 'string' ? body.template_key.trim() : ''
  if (!templateKey) throw new EvalParamError('template_key 必填')
  const baseInput = body.base_input === undefined || isObj(body.base_input) ? (body.base_input as Record<string, unknown> | undefined) : null
  if (baseInput === null && body.base_input !== undefined) throw new EvalParamError('base_input 需为对象')
  const vRaw = body.variants
  if (!Array.isArray(vRaw) || vRaw.length < 2 || vRaw.length > GROUPS_MAX) {
    throw new EvalParamError(`variants 需为 2–${GROUPS_MAX} 组 [{ label, input_patch }]`)
  }
  const labels: string[] = []
  const inputs: Array<Record<string, unknown>> = []
  for (const [i, v] of vRaw.entries()) {
    if (!isObj(v)) throw new EvalParamError(`variants[${i}] 需为对象`)
    const label = typeof v.label === 'string' ? v.label.trim() : ''
    if (!label) throw new EvalParamError(`variants[${i}].label 必填（组名）`)
    if (labels.includes(label)) throw new EvalParamError(`label「${label}」重复`)
    const patch = v.input_patch
    if (patch !== undefined && !isObj(patch)) throw new EvalParamError(`variants[${i}].input_patch 需为对象`)
    labels.push(label)
    inputs.push({ ...(baseInput ?? {}), ...(patch ?? {}) })
  }
  loadTemplateOrThrow(templateKey) // 模板不存在 → InvalidRunInputError(bad_template)（fail() → 400）
  const name = `eval:${labels.join('/')}`.slice(0, 80)
  const { batch, runIds } = await createBatch({ projectId, templateKey, name, inputs })
  return { batch_id: batch.id, run_ids: runIds, labels }
}

export interface ScoreEvalResult {
  matrix: Array<Record<string, unknown>> | null
  aggregate: ReturnType<typeof aggregateEvalMatrix> | null
  report_asset_id: number
  skipped: number
  parse_failed: boolean
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null
  provider: string
  model: string
}

/** 资产存在性 + image kind + 项目域校验（越组/缺失 → 400 语义）；返回 id→label 映射 */
async function assertImageAssets(projectId: number, ids: number[], what: string): Promise<void> {
  if (ids.length === 0) return
  await assertProjectAssets(projectId, ids, what) // 非法/越项目 → RefResolveError（fail() → 400）
  const rows = await db
    .select({ id: assets.id, kind: assets.kind })
    .from(assets)
    .where(and(inArray(assets.id, ids), isNull(assets.deletedAt)))
  const missing = ids.filter((id) => !rows.some((r) => r.id === id))
  if (missing.length > 0) throw new EvalParamError(`${what} 不存在：${missing.join(',')}`)
  const notImage = rows.filter((r) => r.kind !== 'image').map((r) => r.id)
  if (notImage.length > 0) throw new EvalParamError(`${what} 含非图片资产：${notImage.join(',')}`)
}

/**
 * 评分矩阵：groups（≤6、图总数 ≤24）+ 可选参考图 → 多模态 LLM 逐图评分 → 矩阵/聚合/报告资产。
 * LLM 输出全坏 → parsed:false 降级：报告资产落 raw（不出假分），matrix/aggregate 为 null。
 */
export async function scoreConsistencyEval(body: Record<string, unknown>): Promise<ScoreEvalResult> {
  const projectId = posInt(body.project_id)
  if (!projectId) throw new EvalParamError('project_id 需为正整数')
  const gRaw = body.groups
  if (!Array.isArray(gRaw) || gRaw.length < 1 || gRaw.length > GROUPS_MAX) throw new EvalParamError(`groups 需为 1–${GROUPS_MAX} 组 [{ label, asset_ids }]`)
  const groups: EvalGroup[] = []
  const labelById = new Map<number, string>()
  for (const [i, g] of gRaw.entries()) {
    if (!isObj(g)) throw new EvalParamError(`groups[${i}] 需为对象`)
    const label = typeof g.label === 'string' ? g.label.trim() : ''
    if (!label) throw new EvalParamError(`groups[${i}].label 必填`)
    const aRaw = g.asset_ids
    if (!Array.isArray(aRaw) || aRaw.length === 0) throw new EvalParamError(`groups[${i}].asset_ids 需为非空数组`)
    const ids = aRaw.map(Number)
    if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new EvalParamError(`groups[${i}].asset_ids 含非法 id`)
    for (const id of ids) {
      if (labelById.has(id)) throw new EvalParamError(`资产 ${id} 重复出现在「${labelById.get(id)}」与「${label}」`)
      labelById.set(id, label)
    }
    groups.push({ label, assetIds: ids })
  }
  const allIds = [...labelById.keys()]
  if (allIds.length > ASSETS_MAX) throw new EvalParamError(`被评图总数 ${allIds.length} 超上限 ${ASSETS_MAX}`)
  const refRaw = body.reference_asset_ids
  if (refRaw !== undefined && !Array.isArray(refRaw)) throw new EvalParamError('reference_asset_ids 需为数组')
  const refIds = (refRaw ?? []).map(Number)
  if (refIds.some((n) => !Number.isInteger(n) || n <= 0)) throw new EvalParamError('reference_asset_ids 含非法 id')

  await assertImageAssets(projectId, allIds, '被评资产')
  await assertImageAssets(projectId, refIds, '参考资产')

  // 多模态消息：参考图在前 → 被评图（每图前文字标注 asset_id/组）→ 收尾指令
  const cache = new Map<number, string>()
  const parts: ChatContentPart[] = []
  for (const id of refIds) {
    parts.push({ type: 'text', text: `【角色参考图 asset#${id}】` })
    parts.push({ type: 'image_url', image_url: { url: await assetToDataUri(id, cache) } })
  }
  for (const g of groups) {
    for (const id of g.assetIds) {
      parts.push({ type: 'text', text: `【待评图 asset_id=${id} · 组=${g.label}】` })
      parts.push({ type: 'image_url', image_url: { url: await assetToDataUri(id, cache) } })
    }
  }
  parts.push({ type: 'text', text: `共 ${allIds.length} 张待评图，asset_id 集合：[${allIds.join(', ')}]。请按契约输出 scores JSON（每 asset_id 恰好一条）。` })

  const res = await chatCompleteDetailed([
    { role: 'system', content: loadPromptTemplate('eval-consistency.md') },
    { role: 'user', content: parts },
  ])
  await recordLlmUsage({ projectId, runId: null, provider: res.provider, model: res.model, usage: res.usage })

  const parsed = parseEvalScores(res.content, allIds)
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  if (!parsed.parsed) {
    // 全坏降级：raw 落报告资产（人工可判读，不出假分）
    const report = await writeTextAsset(projectId, {
      name: `eval-report-${ts}.md`,
      content: `# 一致性评测报告（解析失败降级）\n\nLLM 输出不可解析为评分 JSON，原始输出如下（供人工判读）：\n\n---\n\n${res.content}\n`,
      purpose: 'eval_report',
      params: { stage: 'parse_failed', groups: groups.map((g) => g.label), assets: allIds.length, model: res.model },
      tags: ['eval'],
    })
    return { matrix: null, aggregate: null, report_asset_id: report.id, skipped: 0, parse_failed: true, usage: res.usage, provider: res.provider, model: res.model }
  }
  const aggregate = aggregateEvalMatrix(parsed.scores, groups)
  const md = renderEvalReport(aggregate, parsed.scores, groups)
  const report = await writeTextAsset(projectId, {
    name: `eval-report-${ts}.md`,
    content: md,
    purpose: 'eval_report',
    params: { groups: groups.map((g) => g.label), assets: allIds.length, scored: aggregate.overall.n, mean: aggregate.overall.mean, model: res.model },
    tags: ['eval'],
  })
  return {
    matrix: parsed.scores.map((s): Record<string, unknown> => ({ asset_id: s.assetId, label: labelById.get(s.assetId) ?? null, consistency: s.consistency, style: s.style, quality: s.quality, note: s.note })),
    aggregate,
    report_asset_id: report.id,
    skipped: parsed.skipped,
    parse_failed: false,
    usage: res.usage,
    provider: res.provider,
    model: res.model,
  }
}

export type { EvalScore }
