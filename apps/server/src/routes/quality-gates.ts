/**
 * Quality gates routes — multi-stage quality check REST endpoints.
 *
 * Provides endpoints to trigger quality checks across five pipeline stages
 * (outline → episode → scene → dialogue → final), query gate status and
 * associated issues, and manage exemptions for blocking issues.
 *
 * Endpoints:
 *   POST /runs/:id/quality-gates              — trigger all-stage check
 *   GET  /runs/:id/quality-gates              — query all gates for a run
 *   GET  /runs/:id/quality-gates/:stage       — query single stage gate + issues
 *   POST /quality-gates/issues/:id/exempt     — exempt a blocking issue
 *   POST /quality-gates/issues/:id/unexempt   — cancel an exemption
 *   POST /runs/:id/consistency-eval           — run per-character consistency evaluation (calls the scoring model)
 *   GET  /runs/:id/character-consistency      — read persisted consistency results + aggregated issues (no LLM)
 */
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { characterConsistencyResults, characters, pipelineRuns, qualityGates, qualityIssues } from '../db/schema.js'
import { runAllStages, type GateStatus, type Stage } from '../services/stage-check.js'
import { exemptIssue, unexemptIssue } from '../services/gate-eval.js'
import { runConsistencyEval } from '../services/consistency-eval.js'
import { HttpError, h, idParam, notFound } from './helpers.js'

export const qualityGatesRoutes = new Hono()

/** Valid stage names for path parameter validation. */
const VALID_STAGES: Stage[] = ['outline', 'episode', 'scene', 'dialogue', 'final']

// ─── POST /runs/:id/quality-gates — trigger all-stage check ─────────────────

qualityGatesRoutes.post('/runs/:id/quality-gates', h(async (c) => {
  const runId = idParam(c)

  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', 'Request body is not valid JSON')
  })

  const episodeIdx = body['episodeIdx']
  if (typeof episodeIdx !== 'number' || !Number.isInteger(episodeIdx) || episodeIdx < 0) {
    throw new HttpError(400, 'bad_episode_idx', 'episodeIdx must be a non-negative integer')
  }

  const gates: GateStatus[] = await runAllStages(runId, episodeIdx)

  return c.json({ gates }, 201)
}))

// ─── GET /runs/:id/quality-gates — query all gates for a run ────────────────

qualityGatesRoutes.get('/runs/:id/quality-gates', h(async (c) => {
  const runId = idParam(c)

  const rawEpisode = c.req.query('episodeIdx')
  const episodeIdx = rawEpisode !== undefined ? parseInt(rawEpisode, 10) : 0
  if (!Number.isInteger(episodeIdx) || episodeIdx < 0) {
    throw new HttpError(400, 'bad_episode_idx', 'episodeIdx must be a non-negative integer')
  }

  const rows = await db
    .select()
    .from(qualityGates)
    .where(
      and(
        eq(qualityGates.runId, runId),
        eq(qualityGates.episodeIdx, episodeIdx),
      ),
    )

  return c.json({ gates: rows })
}))

// ─── GET /runs/:id/quality-gates/:stage — query single stage gate + issues ──

qualityGatesRoutes.get('/runs/:id/quality-gates/:stage', h(async (c) => {
  const runId = idParam(c)
  const stage = c.req.param('stage') as Stage

  if (!VALID_STAGES.includes(stage)) {
    throw new HttpError(400, 'bad_stage', `stage must be one of: ${VALID_STAGES.join(', ')}`)
  }

  const rawEpisode = c.req.query('episodeIdx')
  const episodeIdx = rawEpisode !== undefined ? parseInt(rawEpisode, 10) : 0
  if (!Number.isInteger(episodeIdx) || episodeIdx < 0) {
    throw new HttpError(400, 'bad_episode_idx', 'episodeIdx must be a non-negative integer')
  }

  // Fetch the gate row
  const gateRows = await db
    .select()
    .from(qualityGates)
    .where(
      and(
        eq(qualityGates.runId, runId),
        eq(qualityGates.episodeIdx, episodeIdx),
        eq(qualityGates.stage, stage),
      ),
    )
    .limit(1)

  if (gateRows.length === 0) {
    return c.json({ error: { code: 'not_found', message: `Gate for stage '${stage}' not found` } }, 404)
  }

  // Fetch associated issues with parsed evidence JSON
  const issueRows = await db
    .select()
    .from(qualityIssues)
    .where(
      and(
        eq(qualityIssues.runId, runId),
        eq(qualityIssues.episodeIdx, episodeIdx),
        eq(qualityIssues.stage, stage),
      ),
    )

  const issues = issueRows.map((row) => ({
    ...row,
    evidence: safeParseJson(row.evidence),
  }))

  return c.json({ gate: gateRows[0], issues })
}))

// ─── POST /quality-gates/issues/:id/exempt — exempt a blocking issue ────────

qualityGatesRoutes.post('/quality-gates/issues/:id/exempt', h(async (c) => {
  const rawId = c.req.param('id')
  const issueId = Number(rawId)
  if (!Number.isInteger(issueId) || issueId <= 0) {
    throw new HttpError(400, 'bad_id', `Issue id must be a positive integer, got: ${rawId}`)
  }

  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', 'Request body is not valid JSON')
  })

  const reason = body['reason']
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new HttpError(400, 'bad_reason', 'reason must be a non-empty string')
  }

  try {
    const gate = await exemptIssue(issueId, 'user', reason.trim())
    return c.json({ gate })
  } catch (err) {
    throw new HttpError(400, 'exempt_failed', (err as Error).message)
  }
}))

// ─── POST /quality-gates/issues/:id/unexempt — cancel an exemption ──────────

qualityGatesRoutes.post('/quality-gates/issues/:id/unexempt', h(async (c) => {
  const rawId = c.req.param('id')
  const issueId = Number(rawId)
  if (!Number.isInteger(issueId) || issueId <= 0) {
    throw new HttpError(400, 'bad_id', `Issue id must be a positive integer, got: ${rawId}`)
  }

  try {
    const gate = await unexemptIssue(issueId)
    return c.json({ gate })
  } catch (err) {
    throw new HttpError(400, 'unexempt_failed', (err as Error).message)
  }
}))

// ─── POST /runs/:id/consistency-eval — per-character consistency evaluation ──

qualityGatesRoutes.post('/runs/:id/consistency-eval', h(async (c) => {
  const runId = idParam(c)

  const runRows = await db
    .select({ id: pipelineRuns.id })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1)
  if (runRows.length === 0) return notFound(c, `run ${runId}`)

  const result = await runConsistencyEval(runId)
  return c.json(result)
}))

// ─── GET /runs/:id/character-consistency — persisted results (no LLM) ───────

qualityGatesRoutes.get('/runs/:id/character-consistency', h(async (c) => {
  const runId = idParam(c)

  const rows = await db
    .select({
      entityId: characterConsistencyResults.entityId,
      episodeIdx: characterConsistencyResults.episodeIdx,
      name: characters.name,
      score: characterConsistencyResults.score,
      assetTotal: characterConsistencyResults.assetTotal,
      assetSampled: characterConsistencyResults.assetSampled,
      refCount: characterConsistencyResults.refCount,
      model: characterConsistencyResults.model,
      provider: characterConsistencyResults.provider,
      note: characterConsistencyResults.note,
      evaluatedAt: characterConsistencyResults.evaluatedAt,
    })
    .from(characterConsistencyResults)
    .leftJoin(characters, eq(characterConsistencyResults.entityId, characters.id))
    .where(eq(characterConsistencyResults.runId, runId))
    .orderBy(characterConsistencyResults.entityId)

  // Issues produced by the consistency checker, grouped per target entity
  const issueRows = await db
    .select({ targetId: qualityIssues.targetId, severity: qualityIssues.severity })
    .from(qualityIssues)
    .where(
      and(
        eq(qualityIssues.runId, runId),
        eq(qualityIssues.checker, 'character.consistency'),
        eq(qualityIssues.targetType, 'entity'),
      ),
    )
  const severitiesByEntity = new Map<string, string[]>()
  for (const i of issueRows) {
    if (i.targetId === null) continue
    const list = severitiesByEntity.get(i.targetId) ?? []
    list.push(i.severity)
    severitiesByEntity.set(i.targetId, list)
  }

  const entities = rows.map((row) => {
    const severities = severitiesByEntity.get(String(row.entityId)) ?? []
    return { ...row, issues: { count: severities.length, severities } }
  })

  return c.json({ runId, entities })
}))

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Safely parse a JSON string, returning the original value on failure. */
function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}
