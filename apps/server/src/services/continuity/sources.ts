import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../../db'
import { assets, contentVersions, execSnapshots, pipelineRuns, pipelineSteps } from '../../db/schema'
import { recordAssetTextVersion } from '../provenance'
import { absPathOf, projectAbsDir } from '../storage'
import { ContinuityError, DocRefSchema, SourcePickSchema, SourceSchema, TemplateSchema,
  type DocRef, type Executor, type Source, type SourceCandidate, type SourcePick, type Unit } from './contract'
import { canonicalHash } from './fold'
import { resolveUnit } from './scope'

const SnapshotSchema = SourcePickSchema.omit({ versionId: true }).extend({ seenHash: DocRefSchema.shape.hash })
const invalid = (status: 400 | 404 | 409 = 409): never => { throw new ContinuityError('continuity_source_invalid', status) }
const changed = (): never => { throw new ContinuityError('continuity_source_changed', 409) }
const bytesHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
function object(text: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text ?? '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch { /* Never expose raw stored input or parser errors. */ }
  return invalid(400)
}
function outputIds(output: Record<string, unknown>): number[] {
  const ids = [...(Array.isArray(output.asset_ids) ? output.asset_ids : []), ...(output.asset_id === undefined ? [] : [output.asset_id])]
  if (ids.some(id => !Number.isSafeInteger(id) || (id as number) <= 0)) return invalid(400)
  return [...new Set(ids as number[])].sort((a, b) => a - b)
}
function fileText(projectId: number, relPath: string | null): string {
  if (!relPath) return invalid(404)
  const abs = resolve(absPathOf(relPath)), rel = relative(resolve(projectAbsDir(projectId)), abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return invalid(404)
  let bytes: Buffer
  try { bytes = readFileSync(abs) } catch { return invalid(404) }
  const text = bytes.toString('utf8')
  if (createHash('sha256').update(bytes).digest('hex') !== bytesHash(text)) return changed()
  return text
}
function sourceText(projectId: number, relPath: string | null): string {
  const text = fileText(projectId, relPath)
  if (text.length > 120_000) throw new ContinuityError('continuity_context_too_large', 413)
  return text
}

/** Immutable version content, read through the caller's transaction, not global provenance reads. */
export async function readContinuityVersion(ex: Executor, projectId: number, ref: DocRef): Promise<string> {
  if (!DocRefSchema.safeParse(ref).success || !Number.isSafeInteger(projectId) || projectId <= 0) return invalid(400)
  const [version] = await ex.select().from(contentVersions).where(and(eq(contentVersions.id, ref.versionId),
    eq(contentVersions.projectId, projectId), eq(contentVersions.objKind, 'asset'), eq(contentVersions.objId, ref.assetId))).limit(1)
  if (!version) return invalid(404)
  if (version.payloadKind !== 'file' || version.sha256 !== ref.hash) return changed()
  const text = fileText(projectId, version.relPath)
  if (bytesHash(text) !== ref.hash) return changed()
  return text
}
async function versions(ex: Executor, projectId: number, assetId: number) {
  return ex.select().from(contentVersions).where(and(eq(contentVersions.projectId, projectId),
    eq(contentVersions.objKind, 'asset'), eq(contentVersions.objId, assetId))).orderBy(desc(contentVersions.revision))
}
async function runStep(unit: Unit, runId: number, stepId: number, ex: Executor) {
  const [run] = await ex.select().from(pipelineRuns).where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.projectId, unit.projectId))).limit(1)
  const [step] = await ex.select().from(pipelineSteps).where(and(eq(pipelineSteps.id, stepId), eq(pipelineSteps.runId, runId))).limit(1)
  if (!run || !step || object(run.input).episode_number !== unit.unitOrdinal) return invalid(404)
  const parsed = run.templateSnapshot === null ? null : TemplateSchema.safeParse(object(run.templateSnapshot))
  if (parsed && !parsed.success) return invalid(400)
  const template = parsed?.data ?? null
  const definition = template?.steps.find(s => s.key === step.stepKey)
  if (template && (template.key !== run.templateKey || !definition || definition.action !== step.actionKey)) return invalid(409)
  const output = object(step.output)
  const gate = output.gate ?? null
  const historicalScript = run.templateKey === 'mengbao-episode' && step.stepKey === 'write_script'
  // Missing template history alone does not establish that an unknown legacy step was gated.
  const requiresGate = !!definition?.gate || gate !== null || historicalScript
  const approved = !requiresGate || (typeof gate === 'object' && gate !== null && 'decision' in gate && gate.decision === 'approve')
  const declaredRole = definition?.params?.continuity_role === 'episode_script' || historicalScript
  return { run, step, outputIds: outputIds(output), gate, approved, declaredRole,
    templateSnapshotHash: canonicalHash(template), hasTemplate: template !== null }
}
async function locate(projectId: number, episodeId: number, pick: Omit<SourcePick, 'versionId'>, ex: Executor) {
  const unit = await resolveUnit(projectId, episodeId, ex)
  const [asset] = await ex.select().from(assets).where(and(eq(assets.id, pick.assetId), eq(assets.projectId, projectId))).limit(1)
  if (!asset || asset.deletedAt !== null) return invalid(404)
  if (asset.kind !== 'text') return invalid(400)
  if (!asset.runId || !asset.stepId) return invalid(404)
  let current = await runStep(unit, pick.runId, pick.stepId, ex)
  if (!current.outputIds.includes(asset.id)) return invalid(409)
  const inheritedViaRunId = pick.runId === asset.runId && pick.stepId === asset.stepId ? null : pick.runId
  const seen = new Set<number>()
  while (current.run.id !== asset.runId || current.step.id !== asset.stepId) {
    if (seen.has(current.run.id)) return invalid(409)
    seen.add(current.run.id)
    if (current.step.status !== 'succeeded' || !current.approved) return invalid(409)
    const parentId = current.run.resumedFromRunId
    if (!parentId) return invalid(404)
    if (seen.has(parentId)) return invalid(409)
    const steps = await ex.select().from(pipelineSteps).where(and(eq(pipelineSteps.runId, parentId), eq(pipelineSteps.stepKey, current.step.stepKey)))
    if (steps.length !== 1) return invalid(404)
    const parent = await runStep(unit, parentId, steps[0]!.id, ex)
    if (parent.run.templateKey !== current.run.templateKey || !parent.outputIds.includes(asset.id)) return invalid(404)
    current = parent
  }
  const [snapshot] = await ex.select({ id: execSnapshots.id }).from(execSnapshots).where(and(
    eq(execSnapshots.projectId, projectId), eq(execSnapshots.execKind, 'pipeline_step'), eq(execSnapshots.runId, asset.runId),
    eq(execSnapshots.stepId, asset.stepId), eq(execSnapshots.templateKey, current.run.templateKey))).limit(1)
  return { unit, asset, ...current, inheritedViaRunId, history: current.hasTemplate && snapshot ? 'known' as const : 'history_unavailable' as const }
}
function makeSource(located: Awaited<ReturnType<typeof locate>>, versionId: number, hash: string): Source {
  const { unit, run, step, asset, history, inheritedViaRunId, templateSnapshotHash } = located
  const identity = { ...unit, runId: run.id, stepId: step.id, assetId: asset.id, versionId, hash, templateKey: run.templateKey,
    templateSnapshotHash, stepKey: step.stepKey, outputHash: canonicalHash(located.outputIds), gateHash: canonicalHash(located.gate) }
  // Missing execution history is an independent warning, not a change of the selected source.
  return { ...identity, fingerprint: canonicalHash(identity), history, inheritedViaRunId }
}
function requireApproved(located: Awaited<ReturnType<typeof locate>>) {
  if (located.step.status !== 'succeeded' || !located.approved) invalid(409)
}

/** Selecting an old immutable version is allowed for review/drafts; this does NOT approve it. */
export async function readSource(projectId: number, episodeId: number, pick: SourcePick, ex: Executor): Promise<{ source: Source; text: string }> {
  if (!SourcePickSchema.safeParse(pick).success) return invalid(400)
  const located = await locate(projectId, episodeId, pick, ex)
  const [version] = await ex.select().from(contentVersions).where(and(eq(contentVersions.id, pick.versionId),
    eq(contentVersions.projectId, projectId), eq(contentVersions.objKind, 'asset'), eq(contentVersions.objId, pick.assetId))).limit(1)
  if (!version) return invalid(404)
  if (!version.sha256) return changed()
  const text = await readContinuityVersion(ex, projectId, { assetId: pick.assetId, versionId: pick.versionId, hash: version.sha256 })
  if (text.length > 120_000) throw new ContinuityError('continuity_context_too_large', 413)
  return { source: makeSource(located, pick.versionId, version.sha256), text }
}

/** Call before confirming/freezing/consuming, with the same executor as that operation. */
export async function assertCurrentSource(source: Source, ex: Executor): Promise<void> {
  if (!SourceSchema.safeParse(source).success) return invalid(400)
  const { fingerprint, history: _history, inheritedViaRunId: _via, ...identity } = source
  if (canonicalHash(identity) !== fingerprint) return changed()
  const located = await locate(source.projectId, source.unitId, source, ex)
  requireApproved(located)
  const current = sourceText(source.projectId, located.asset.relPath)
  const latest = (await versions(ex, source.projectId, source.assetId))[0]
  if (!latest) return invalid(404)
  if (latest.id !== source.versionId || bytesHash(current) !== source.hash) return changed()
  const text = await readContinuityVersion(ex, source.projectId, { assetId: source.assetId, versionId: source.versionId, hash: source.hash })
  if (bytesHash(text) !== bytesHash(current) || makeSource(located, source.versionId, source.hash).fingerprint !== source.fingerprint) return changed()
}

export async function captureSource(projectId: number, episodeId: number, raw: unknown): Promise<Source> {
  const parsed = SnapshotSchema.safeParse(raw)
  if (!parsed.success) return invalid(400)
  const pick = parsed.data
  const before = await locate(projectId, episodeId, pick, db)
  requireApproved(before)
  if (bytesHash(sourceText(projectId, before.asset.relPath)) !== pick.seenHash) return changed()
  // Fingerprint the source independently of a not-yet-existing version ID.
  const fingerprint = makeSource(before, 1, pick.seenHash).fingerprint
  return db.transaction(async tx => {
    const current = await locate(projectId, episodeId, pick, tx)
    requireApproved(current)
    const text = sourceText(projectId, current.asset.relPath)
    if (bytesHash(text) !== pick.seenHash || makeSource(current, 1, pick.seenHash).fingerprint !== fingerprint) return changed()
    let version = (await versions(tx, projectId, pick.assetId))[0]
    if (!version) version = await recordAssetTextVersion({ asset: current.asset, content: text, source: 'baseline', executor: tx })
    // Even an existing baseline must agree with its real immutable file and the working copy.
    await readContinuityVersion(tx, projectId, { assetId: pick.assetId, versionId: version.id, hash: pick.seenHash })
    const source = makeSource(current, version.id, pick.seenHash)
    await assertCurrentSource(source, tx)
    return source
  })
}

export async function listSources(projectId: number, episodeId: number): Promise<SourceCandidate[]> {
  const unit = await resolveUnit(projectId, episodeId, db)
  const runs = await db.select().from(pipelineRuns).where(eq(pipelineRuns.projectId, projectId))
  const result: SourceCandidate[] = []
  for (const run of runs) {
    let input: Record<string, unknown>
    try { input = object(run.input) } catch { continue }
    if (input.episode_number !== unit.unitOrdinal) continue
    const steps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, run.id))
    for (const step of steps) {
      let ids: number[]
      try { ids = outputIds(object(step.output)) } catch { continue }
      for (const assetId of ids) {
        const [asset] = await db.select().from(assets).where(and(eq(assets.id, assetId), eq(assets.projectId, projectId))).limit(1)
        if (!asset || asset.kind !== 'text' || asset.deletedAt !== null) continue
        let text: string
        try { text = sourceText(projectId, asset.relPath) } catch { continue }
        const rows = await versions(db, projectId, assetId)
        const refs = rows.flatMap(v => {
          const parsed = DocRefSchema.safeParse({ assetId, versionId: v.id, hash: v.sha256 })
          return parsed.success ? [parsed.data] : []
        })
        const candidate: SourceCandidate = { runId: asset.runId ?? run.id, stepId: asset.stepId ?? step.id,
          stepKey: step.stepKey, title: step.title ?? step.stepKey, assetId, versionId: rows[0]?.id ?? null,
          versions: refs, currentHash: bytesHash(text), confirmable: false, reasons: [], declaredRole: false,
          inheritedViaRunId: asset.runId === run.id && asset.stepId === step.id ? null : run.id }
        try {
          const located = await locate(projectId, episodeId, { runId: run.id, stepId: step.id, assetId }, db)
          candidate.runId = located.run.id; candidate.stepId = located.step.id
          candidate.stepKey = located.step.stepKey; candidate.title = located.step.title ?? located.step.stepKey
          candidate.declaredRole = located.declaredRole
          if (!located.declaredRole) candidate.reasons.push('undeclared_role')
          if (located.history === 'history_unavailable') candidate.reasons.push('history_unavailable')
          if (located.step.status !== 'succeeded') candidate.reasons.push('step_not_succeeded')
          if (!located.approved) candidate.reasons.push('gate_not_approved')
          if (!rows.length) candidate.reasons.push('version_uncaptured')
          else {
            await assertCurrentSource(makeSource(located, rows[0]!.id, candidate.currentHash), db)
            // 设计 §6.1：只有模板声明 continuity_role 的步骤算剧本角色；历史模板无快照时允许人工显式指定（仍标 undeclared_role），
            // 已知模板里的审查报告等未声明步骤不得被当作可确认来源。
            candidate.confirmable = located.declaredRole || located.history === 'history_unavailable'
          }
        } catch (e) {
          if (!(e instanceof ContinuityError)) throw e
          candidate.reasons.push(e.status === 404 ? 'source_missing' : e.code)
        }
        result.push(candidate)
      }
    }
  }
  return result
}
