import { and, eq, inArray, isNull } from 'drizzle-orm'
import { characters, episodes, projects, series } from '../../db/schema'
import { ContinuityError, SubjectSchema, UnitSchema, type Executor, type Subject, type Unit } from './contract'

export async function resolveUnit(projectId: number, episodeId: number, ex: Executor): Promise<Unit> {
  if (![projectId, episodeId].every(id => Number.isSafeInteger(id) && id > 0)) throw new ContinuityError('continuity_source_invalid', 400)
  const [row] = await ex.select({ projectId: projects.id, scopeId: series.id, unitId: episodes.id, unitOrdinal: episodes.number })
    .from(episodes).innerJoin(projects, eq(projects.id, episodes.projectId)).innerJoin(series, eq(series.id, episodes.seriesId))
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt), eq(episodes.id, episodeId), eq(series.projectId, projectId))).limit(1)
  if (!row) throw new ContinuityError('continuity_source_invalid', 404)
  const unit = UnitSchema.safeParse({ ...row, scopeKind: 'series', unitKind: 'episode' })
  if (!unit.success) throw new ContinuityError('continuity_source_invalid', 400)
  return unit.data
}

/** Structural evidence validation is pure; entity ownership is a same-executor service guard. */
export async function validateSubjects(projectId: number, subjects: Subject[], ex: Executor): Promise<void> {
  if (!SubjectSchema.array().safeParse(subjects).success) throw new ContinuityError('continuity_evidence_invalid', 400)
  const ids = [...new Set(subjects.flatMap(s => s.entityId === null ? [] : [s.entityId]))]
  if (!ids.length) return
  const owned = await ex.select({ id: characters.id }).from(characters)
    .where(and(eq(characters.projectId, projectId), inArray(characters.id, ids)))
  if (owned.length !== ids.length) throw new ContinuityError('continuity_source_invalid', 404)
}
