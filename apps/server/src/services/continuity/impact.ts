import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { contentContinuityRecords as records, type ContentContinuityRecord } from '../../db/schema'
import { ContinuityError, EntryDocSchema, ImpactViewSchema, UseDocSchema,
  type ImpactRow, type ImpactView } from './contract'
import { readContinuityVersion } from './sources'

/** Task5 §5.5: 影响面三区划分。direct=直接消费承接包的行；indirect=沿真实 basis/consumption 边传播的行；
 * unknown=缺证行（读不回文档或结果未决）——缺证绝不当作零影响空数组。传播只沿真实消费图展开，
 * 不把所有后集笼统算作引用。 */

type AnyRow = ContentContinuityRecord

const asDocRef = (row: AnyRow) =>
  row.documentAssetId !== null && row.documentVersionId !== null && row.documentHash !== null
    ? { assetId: row.documentAssetId, versionId: row.documentVersionId, hash: row.documentHash } : null

async function entryDocOf(row: AnyRow) {
  const ref = asDocRef(row)
  if (!ref) return null
  try { return EntryDocSchema.parse(JSON.parse(await readContinuityVersion(db, row.projectId, ref))) } catch { return null }
}

async function useDocOf(row: AnyRow) {
  const ref = asDocRef(row)
  if (!ref) return null
  try { return UseDocSchema.parse(JSON.parse(await readContinuityVersion(db, row.projectId, ref))) } catch { return null }
}

const mkRow = (row: AnyRow, kind: 'entry' | 'use', reason: string, inheritedViaRunId: number | null): ImpactRow => ({
  recordId: row.id, kind, unitOrdinal: row.unitOrdinal,
  runId: kind === 'use' ? row.runId : row.sourceRunId,
  stepId: kind === 'use' ? row.stepId : row.sourceStepId,
  state: row.status, document: asDocRef(row), reason, inheritedViaRunId,
})

export async function getImpact(projectId: number, recordId: number): Promise<ImpactView> {
  // 影响面锚点：consumption 行（本次调用用到了什么）或 entry 行（本集登记被谁引用）。
  // context 行与不存在/跨项目行一律 404（context 不直接对外代表一次消费）。
  const [target] = await db.select().from(records)
    .where(and(eq(records.projectId, projectId), eq(records.id, recordId))).limit(1)
  if (!target || (target.rowType !== 'consumption' && target.rowType !== 'entry'))
    throw new ContinuityError('continuity_source_invalid', 404)
  const targetDoc = target.rowType === 'consumption' ? await useDocOf(target) : null

  const entryRows = await db.select().from(records)
    .where(and(eq(records.projectId, projectId), eq(records.rowType, 'entry')))
  const useRows = await db.select().from(records)
    .where(and(eq(records.projectId, projectId), eq(records.rowType, 'consumption')))

  // 真实 basis 图：只读得回文档的条目贡献边；releasedBasis 已明确解除，不算活跃依赖。
  const docs = new Map<number, Awaited<ReturnType<typeof entryDocOf>>>()
  for (const e of entryRows) docs.set(e.id, await entryDocOf(e))

  // 多源最短传播：目标消费包条目 / 目标登记本身 0 距，沿 basis 边 +1；同距时取最小条目号作为经由，保证确定性。
  const dist = new Map<number, number>()
  const via = new Map<number, number>()
  if (targetDoc) for (const ref of targetDoc.entries) dist.set(ref.entryId, 0)
  if (target.rowType === 'entry') dist.set(target.id, 0)
  for (let changed = true; changed;) {
    changed = false
    for (const e of entryRows) {
      const doc = docs.get(e.id)
      if (!doc) continue
      for (const ref of doc.basis) {
        const base = dist.get(ref.entryId)
        if (base === undefined) continue
        const candidate = base + 1
        const current = dist.get(e.id)
        const better = current === undefined || candidate < current
          || (candidate === current && (via.get(e.id) ?? Number.MAX_SAFE_INTEGER) > ref.entryId)
        if (better) { dist.set(e.id, candidate); via.set(e.id, ref.entryId); changed = true }
      }
    }
  }

  const direct: ImpactRow[] = []
  const indirect: ImpactRow[] = []
  const unknown: ImpactRow[] = []
  for (const u of useRows) {
    // prepared 从未派发、failed 未发生有效响应：都不构成"已使用"，既不计入实际图也不进 unknown。
    if (u.status !== 'completed' && u.status !== 'unknown' && u.status !== 'dispatching') continue
    const doc = await useDocOf(u)
    // 缺证（读不回 UseDoc）与结果未决的消费行永远进入 unknown，不因其存在而宣称零影响。
    if (!doc) { unknown.push(mkRow(u, 'use', 'use_document_unavailable', null)); continue }
    if (u.status === 'unknown' || u.status === 'dispatching') { unknown.push(mkRow(u, 'use', 'outcome_unknown', null)); continue }
    let min = Number.MAX_SAFE_INTEGER
    let best: number | null = null
    for (const ref of doc.entries) {
      const d = dist.get(ref.entryId)
      if (d === undefined) continue
      if (d < min || (d === min && best !== null && ref.entryId < best)) { min = d; best = ref.entryId }
    }
    if (best === null) continue
    if (min === 0) direct.push(mkRow(u, 'use', 'use_pack', null))
    else indirect.push(mkRow(u, 'use', `use_pack_via_entry:${best}`, null))
  }
  for (const e of entryRows) {
    if (e.id === target.id) continue // 锚点自身不计入自己的影响面
    const doc = docs.get(e.id)
    if (!doc) { unknown.push(mkRow(e, 'entry', 'entry_document_unavailable', null)); continue }
    const d = dist.get(e.id)
    if (d === undefined) continue
    if (d === 0) direct.push(mkRow(e, 'entry', 'entry_basis', doc.source.inheritedViaRunId))
    else indirect.push(mkRow(e, 'entry', `entry_basis_via_entry:${via.get(e.id)!}`, doc.source.inheritedViaRunId))
  }
  const byId = (a: ImpactRow, b: ImpactRow) => a.recordId - b.recordId
  return ImpactViewSchema.parse({ direct: direct.sort(byId), indirect: indirect.sort(byId), unknown: unknown.sort(byId) })
}
