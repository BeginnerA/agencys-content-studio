/**
 * 逐角色一致性评价编排（consistency-eval）。
 *
 * 一 run × 一实体一行落 character_consistency_results（重评覆盖，幂等 upsert）；
 * 评价与 quality_issues 分离——门禁重跑会清空重建该阶段问题，直接写问题表会被吞，
 * 故 final 阶段 checker 只消费本结果表重建问题，本服务只在被显式调用时触达评分链。
 *
 * 流程：出镜实体（执行快照输入）→ 本 run 出图集（按镜头参数命中实体、最新 ≤24 张）→
 * 基准参考图（已分层实体取 enabled base 行；未分层回落扁平列前 4 张；两路径均先剔除脏数据）→
 * 逐实体串行调用既有评分链（复用 A/B 评测的评分契约与提示词，每次调用自带用量记录）→ 结果 upsert。
 *
 * 失败口径：评分调用异常 / LLM 输出不可解析 / 无可评图 / 无基准参考 → score=null 且 note 记原因，
 * 绝不产假分；note 落库前一律经共享清洗（供应商错误可能携带 baseUrl/密钥片段，本表会经只读端点回显）。
 * run 存在性由调用方（路由）负责 404；本文件不携带 HTTP 语义。
 */
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../db'
import { assets, characterConsistencyResults, characters, execInputs, execSnapshots, genTasks, pipelineRuns } from '../db/schema'
import { GLOBAL_POOL_ID } from './global-pool'
import { listEntityRefs } from './entity-references'
import { sanitizeErrorNote } from './error-note'
import { scoreConsistencyEval } from './eval-service'

/** 单实体出图抽样上限（对齐既有评分链的被评图总数上限：一次调用至多 24 张） */
const ASSET_SAMPLE_MAX = 24
/** 扁平列回落路径的参考取用上限（对齐出图逐镜单角色参考上限；分层 base 行不设此限） */
const FLAT_REF_MAX = 4

/** 逐实体评价汇总（与结果表行一一对应；score=null 表示本次未能给出分数，note 记原因） */
export interface EntityEvalSummary {
  entityId: number
  name: string
  score: number | null
  assetTotal: number
  assetSampled: number
  refCount: number
  note: string | null
}

/** params JSON 宽容解析：只取本镜头命中的实体 id（正整数），坏 JSON/缺键一律按未命中 */
function parseEntityIds(paramsJson: string): number[] {
  try {
    const v = JSON.parse(paramsJson) as unknown
    const ids = (v as { entityIds?: unknown } | null)?.entityIds
    return Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
  } catch {
    return []
  }
}

/** refAssetIds JSON 列宽容解析：非数组/坏 JSON → []；仅保留正整数 id（与分层登记服务的扁平列口径一致） */
function parseNumArr(s: string): number[] {
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
  } catch {
    return []
  }
}

/**
 * 出镜实体集合：本 run 执行快照冻结输入里 srcKind='entity' 且带版本指针的行。
 * 谓词与既有质量分「角色一致性维度」的同款查询逐字对齐（exec_inputs 经 snapshot 归属 run）。
 */
async function listAppearingEntityIds(runId: number): Promise<number[]> {
  const rows = await db
    .select({ entityId: execInputs.srcId })
    .from(execInputs)
    .innerJoin(execSnapshots, eq(execInputs.snapshotId, execSnapshots.id))
    .where(and(eq(execSnapshots.runId, runId), eq(execInputs.srcKind, 'entity'), isNotNull(execInputs.versionId)))
    .groupBy(execInputs.srcId)
    .orderBy(execInputs.srcId)
  return rows.map((r) => r.entityId)
}

/**
 * 资产可评性过滤（出图路径与参考路径共用的脏数据剔除）：存在、未删除、kind='image'、
 * 归属 ∈ {本 run 项目, 全局素材池}——历史扁平列可能挂着跨项目资产 id，
 * 不排除会把越界引用送进评分链（评分入口按项目域强校验，届时整次评价误报「评分失败」）。
 */
async function eligibleImageIds(projectId: number, ids: number[]): Promise<Set<number>> {
  const uniq = [...new Set(ids)]
  if (uniq.length === 0) return new Set()
  const rows = await db
    .select({ id: assets.id })
    .from(assets)
    .where(
      and(
        inArray(assets.id, uniq),
        eq(assets.kind, 'image'),
        isNull(assets.deletedAt),
        inArray(assets.projectId, [projectId, GLOBAL_POOL_ID]),
      ),
    )
  return new Set(rows.map((r) => r.id))
}

/** 本 run 出图任务 → 逐实体出图集（params.entityIds 命中；同资产去重，完成时间新者在前） */
async function buildEntityAssetMap(runId: number): Promise<Map<number, number[]>> {
  const taskRows = await db
    .select({ resultAssetId: genTasks.resultAssetId, params: genTasks.params, completedAt: genTasks.completedAt })
    .from(genTasks)
    .where(
      and(
        eq(genTasks.runId, runId),
        eq(genTasks.kind, 'image'),
        eq(genTasks.status, 'succeeded'),
        isNotNull(genTasks.resultAssetId),
      ),
    )
  const byEntity = new Map<number, Map<number, number>>() // entityId → (assetId → 完成时间)
  for (const t of taskRows) {
    const assetId = t.resultAssetId as number
    const completed = t.completedAt ?? 0 // 存量行缺完成时间按最旧排尾
    for (const eid of parseEntityIds(t.params)) {
      const seen = byEntity.get(eid) ?? new Map<number, number>()
      if (!seen.has(assetId) || (seen.get(assetId) ?? 0) < completed) seen.set(assetId, completed)
      byEntity.set(eid, seen)
    }
  }
  const out = new Map<number, number[]>()
  for (const [eid, seen] of byEntity) {
    out.set(
      eid,
      [...seen.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([assetId]) => assetId),
    )
  }
  return out
}

/** 单实体参考候选：有登记行 → 仅 enabled base（base 为空即「无基准」，不把状态/视角行当基准）；无任何登记行 → 扁平列回落（评价时前 4 截断） */
interface RefCandidate {
  base: number[]
  /** null = 实体已有登记行（扁平列不再是基准真源） */
  flat: number[] | null
}

async function collectRefCandidates(entityId: number, refAssetIdsJson: string): Promise<RefCandidate> {
  try {
    const refs = await listEntityRefs(entityId)
    if (refs.length > 0) return { base: refs.filter((r) => r.enabled && r.role === 'base').map((r) => r.assetId), flat: null }
  } catch {
    // 分层读失败（实体恰被并发删除等）不阻断评价：按未分层处理，回落扁平列
  }
  return { base: [], flat: parseNumArr(refAssetIdsJson) }
}

/**
 * 逐角色一致性评价主入口：对 run 的每个出镜实体串行评分并 upsert 结果行。
 * 单实体评分异常只影响该实体（score=null + note），不中断其余实体；
 * 实体在结果表之外（已全部删除的行不出现在出镜集合）不写库。
 */
export async function runConsistencyEval(runId: number): Promise<{ runId: number; results: EntityEvalSummary[] }> {
  const [run] = await db.select({ id: pipelineRuns.id, projectId: pipelineRuns.projectId }).from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
  if (!run) throw new Error(`run ${runId} 不存在`) // 调用方（路由）已 404 校验；此处兜底防误用

  const appearing = await listAppearingEntityIds(runId)
  if (appearing.length === 0) return { runId, results: [] }
  const entities = await db
    .select({ id: characters.id, name: characters.name, refAssetIds: characters.refAssetIds })
    .from(characters)
    .where(inArray(characters.id, appearing))
    .orderBy(characters.id)
  if (entities.length === 0) return { runId, results: [] } // 出镜实体已全部删除：无可评价

  const assetMap = await buildEntityAssetMap(run.id)
  const refPlan = new Map<number, RefCandidate>()
  const allIds: number[] = []
  for (const row of entities) {
    const plan = await collectRefCandidates(row.id, row.refAssetIds)
    refPlan.set(row.id, plan)
    allIds.push(...(assetMap.get(row.id) ?? []), ...plan.base, ...(plan.flat ?? []))
  }
  const eligible = await eligibleImageIds(run.projectId, allIds)

  const results: EntityEvalSummary[] = []
  for (const row of entities) {
    const imgs = (assetMap.get(row.id) ?? []).filter((id) => eligible.has(id))
    const sampled = imgs.slice(0, ASSET_SAMPLE_MAX)
    const plan = refPlan.get(row.id) ?? { base: [], flat: [] }
    const refs =
      plan.flat === null
        ? plan.base.filter((id) => eligible.has(id)) // 已分层实体：基准只认真源 base 行（状态/视角行不当基准用）
        : plan.flat.filter((id) => eligible.has(id)).slice(0, FLAT_REF_MAX) // 未分层实体：扁平列前 4（旧项目零改动语义）

    let score: number | null = null
    let model: string | null = null
    let provider: string | null = null
    let note: string | null = null

    if (sampled.length === 0) {
      note = '本 run 无该角色出图'
    } else if (refs.length === 0) {
      note = '无基准参考图，无法评价跨镜一致性'
    } else {
      try {
        const res = await scoreConsistencyEval({
          project_id: run.projectId,
          groups: [{ label: row.name, asset_ids: sampled }],
          reference_asset_ids: refs,
        })
        model = res.model
        provider = res.provider
        const variant = res.aggregate?.variants[0]
        if (res.parse_failed || !res.aggregate || !variant) {
          note = '评分输出不可解析，见评测报告'
        } else if (variant.n === 0) {
          // LLM 回了合法 JSON 但没有一张图拿到有效分：聚合表此时落 0 均分，那是假分，不落
          note = '评分输出无有效逐图分数，见评测报告'
        } else {
          score = variant.dims.consistency.mean
        }
      } catch (err) {
        note = `评分失败：${sanitizeErrorNote((err as Error)?.message ?? err)}`
      }
    }

    const evaluatedAt = Date.now()
    results.push({ entityId: row.id, name: row.name, score, assetTotal: imgs.length, assetSampled: sampled.length, refCount: refs.length, note })
    await db
      .insert(characterConsistencyResults)
      .values({
        runId: run.id,
        entityId: row.id,
        score,
        assetTotal: imgs.length,
        assetSampled: sampled.length,
        refCount: refs.length,
        model,
        provider,
        note,
        evaluatedAt,
      })
      .onConflictDoUpdate({
        target: [characterConsistencyResults.runId, characterConsistencyResults.entityId],
        set: { score, assetTotal: imgs.length, assetSampled: sampled.length, refCount: refs.length, model, provider, note, evaluatedAt },
      })
  }

  return { runId, results }
}
