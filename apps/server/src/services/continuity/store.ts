import { randomUUID } from 'node:crypto'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { assets, contentContinuityRecords as records, type Asset } from '../../db/schema'
import { currentRevision, recordAssetTextVersion } from '../provenance'
import { absPathOf, ensureProjectDirs, relPathOf, sha256Hex, writeTextAsset } from '../storage'
import { ContextDocSchema, ContinuityError, EntryDocSchema, UseDocSchema, type DocRef, type Executor, type Unit } from './contract'
import { canonicalHash } from './fold'
import { resolveUnit } from './scope'

const purposes = { entry: 'continuity_entry', context: 'continuity_context', consumption: 'continuity_use' } as const
const schemas = { entry: EntryDocSchema, context: ContextDocSchema, consumption: UseDocSchema }
const pending = new WeakMap<Executor, Set<string>>()

/** Own the transaction boundary so rollback (including a failed commit) reclaims ONLY its files.
 * Callers publishing document pointers use this instead of a bare db.transaction.
 * A bare Executor cannot notify a file writer of an outer rollback; reject that unsafe usage.
 * A concurrent writer makes the driver fail with SQLITE_BUSY before any statement of ours runs;
 * bounded retries let this transaction observe the committed winner and reject via its own CAS.
 */
const isBusy = (e: unknown): boolean => e instanceof Error
  && ((e as { code?: string }).code === 'SQLITE_BUSY' || e.message.includes('SQLITE_BUSY'))
export async function documentTransaction<T>(fn: (ex: Executor) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const files = new Set<string>()
    try {
      return await db.transaction(async tx => {
        pending.set(tx, files)
        try { return await fn(tx) } finally { pending.delete(tx) }
      })
    } catch (e) {
      for (const file of files) {
        try { unlinkSync(absPathOf(file)) } catch { /* Unpublished orphan is never valid; do not touch any older file. */ }
      }
      if (attempt < 4 && isBusy(e)) {
        await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt))
        continue
      }
      throw e
    }
  }
}

/** New random working file + immutable version, using only the caller's executor. */
export async function writeDocument(ex: Executor, unit: Unit, rowType: keyof typeof purposes, doc: unknown, assetId?: number): Promise<DocRef> {
  const journal = pending.get(ex)
  if (!journal) throw new ContinuityError('continuity_unsupported', 400)
  if (!Object.hasOwn(purposes, rowType)) throw new ContinuityError('continuity_unsupported', 400)
  const actualUnit = await resolveUnit(unit.projectId, unit.unitId, ex)
  if (canonicalHash(actualUnit) !== canonicalHash(unit)) throw new ContinuityError('continuity_source_changed', 409)
  const content = JSON.stringify(doc)
  if (content.length > 200_000) throw new ContinuityError('continuity_context_too_large', 413)
  const parsed = schemas[rowType].safeParse(doc)
  if (!parsed.success) throw new ContinuityError('continuity_evidence_invalid', 400)
  const docUnit = 'unit' in parsed.data ? parsed.data.unit : 'target' in parsed.data ? parsed.data.target.unit : unit
  if (canonicalHash(docUnit) !== canonicalHash(unit)) throw new ContinuityError('continuity_source_invalid', 400)
  const hash = sha256Hex(Buffer.from(content)), purpose = purposes[rowType]
  let asset: Asset
  if (assetId !== undefined) {
    const [old] = await ex.select().from(assets).where(and(eq(assets.id, assetId), eq(assets.projectId, unit.projectId), isNull(assets.deletedAt))).limit(1)
    if (!old) throw new ContinuityError('continuity_source_invalid', 404)
    if (old.purpose !== purpose || old.kind !== 'text' || old.runId !== null || old.stepId !== null) throw new ContinuityError('continuity_conflict', 409)
    const owners = await ex.select().from(records).where(eq(records.documentAssetId, old.id))
    if (owners.some(r => r.rowType !== rowType || r.unitId !== unit.unitId || (rowType === 'entry' && r.status !== 'draft'))) {
      throw new ContinuityError('continuity_conflict', 409)
    }
    ensureProjectDirs(unit.projectId)
    const relPath = relPathOf(unit.projectId, purpose, `${randomUUID()}.json`)
    journal.add(relPath)
    writeFileSync(absPathOf(relPath), content, { flag: 'wx' })
    const updated = await ex.update(assets).set({ relPath, sha256: hash, fileSize: Buffer.byteLength(content), updatedAt: Date.now() })
      .where(and(eq(assets.id, old.id), eq(assets.relPath, old.relPath!), isNull(assets.deletedAt))).returning()
    if (updated.length !== 1) throw new ContinuityError('continuity_conflict', 409)
    asset = updated[0]!
  } else {
    // writeTextAsset chooses its timestamp prefix internally. Capture the path before its DB insert,
    // including insert failures. The UUID ensures this is not another writer's file.
    const insert: typeof ex.insert = ((table: Parameters<typeof ex.insert>[0]) => {
      const builder = ex.insert(table)
      return new Proxy(builder, { get(target, prop, receiver) {
        if (prop !== 'values') return Reflect.get(target, prop, receiver)
        return (value: typeof assets.$inferInsert) => {
          if (typeof value.relPath === 'string') journal.add(value.relPath)
          return builder.values(value)
        }
      } })
    }) as typeof ex.insert
    asset = await writeTextAsset(unit.projectId, { name: `${randomUUID()}.json`, content, purpose, format: 'continuity-json', runId: null }, { insert })
  }
  // Existing provenance filenames are deterministic. Compute the exact next path with the same ex
  // before writing and refuse any collision, rather than overwriting a pre-existing orphan/version.
  const revision = await currentRevision('asset', asset.id, ex) + 1
  const versionPath = join(String(unit.projectId), 'versions', `v-asset-${asset.id}-${revision}-${hash.slice(0, 8)}.${asset.ext ?? 'txt'}`)
  if (existsSync(absPathOf(versionPath))) throw new ContinuityError('continuity_conflict', 409)
  journal.add(versionPath)
  const version = await recordAssetTextVersion({ asset, content, source: assetId === undefined ? 'generate' : 'edit', executor: ex })
  return { assetId: asset.id, versionId: version.id, hash }
}
