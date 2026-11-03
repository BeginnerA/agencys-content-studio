/**
 * Multi-stage quality check probe — isolated environment bootstrap.
 *
 * Responsibilities:
 *   1. Create a temporary isolated directory (CSTUDIO_DATA / CSTUDIO_WORKSPACE)
 *   2. Copy all migration files (0000–0006) into the temp area
 *   3. Apply migrations via initDb to create quality_issues / quality_gates tables
 *   4. Seed test data for all five pipeline stages
 *   5. Block real fetch (no network calls allowed)
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isolatedEnv, localMigrationPaths, REPO_ROOT } from '../../probe-lib'

// ── Isolated environment (must be set up before any src module loads) ──────
const env = isolatedEnv('m73')
process.env.CSTUDIO_ROOT = env.tmp
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('M73 probe forbids unmocked fetch') }

// ── Copy migration files ────────────────────────────────────────────────────
const paths = execFileSync('git', ['ls-files', '-z', '--', 'apps/server/drizzle', 'workspace/templates', 'workspace/prompts'], {
  cwd: REPO_ROOT, encoding: 'utf8',
}).split('\0').filter(Boolean)

// 迁移以磁盘为准：新生成的迁移在提交前尚未被 git 跟踪，而 journal 已登记它，缺文件会让临时库整体迁移失败
for (const rel of localMigrationPaths()) {
  if (!paths.includes(rel)) paths.push(rel)
}

for (const rel of paths) {
  assert.ok(!rel.includes('..') && !rel.endsWith('.env'))
  const target = join(env.tmp, rel)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(join(REPO_ROOT, rel), target)
}

export const migrationsDir = join(env.tmp, 'apps/server/drizzle')
export const temporaryRoot = env.tmp

// ── Database initialization (lazy singleton) ─────────────────────────────────
let closeDatabase: (() => void) | undefined
let database: ReturnType<typeof initializeDatabase> | undefined

export function cleanup() {
  closeDatabase?.()
  globalThis.fetch = originalFetch
  env.cleanup()
}

export function initDatabase() {
  return database ??= initializeDatabase()
}

/** Apply all migrations and then seed test data for quality-check stages. */
async function initializeDatabase() {
  const { createClient } = await import('@libsql/client')
  const { drizzle } = await import('drizzle-orm/libsql')
  const { migrate } = await import('drizzle-orm/libsql/migrator')

  // Build a clean database with all migrations applied
  const client = createClient({ url: `file:${join(env.tmp, 'data/studio.db')}` })
  try {
    await migrate(drizzle(client), { migrationsFolder: migrationsDir })
    // Verify quality_issues table exists (0006 migration)
    assert.equal(
      (await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='quality_issues'")).rows.length,
      1,
      'quality_issues table must exist after migration',
    )
    // Verify quality_gates table exists (0006 migration)
    assert.equal(
      (await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='quality_gates'")).rows.length,
      1,
      'quality_gates table must exist after migration',
    )
  } finally {
    client.close()
  }

  // Initialize runtime database connection via the app's own initDb
  const runtimeEnv = await import('../../../src/env')
  assert.equal(runtimeEnv.ROOT, resolve(env.tmp))
  assert.equal(runtimeEnv.DATA_DIR, resolve(env.tmp, 'data'))
  assert.equal(runtimeEnv.WORKSPACE_DIR, resolve(env.tmp, 'workspace'))

  const { initDb, sqlite } = await import('../../../src/db')
  closeDatabase = () => sqlite.close()
  await initDb()

  // Seed test data for all five pipeline stages
  await seedQualityCheckData()

  return { initDb, sqlite }
}

// ── Seed data ───────────────────────────────────────────────────────────────

/**
 * Seed test data covering all five pipeline stages:
 *   - 1 project
 *   - 1 pipeline_run (completed)
 *   - 2 content_versions (so outline completeness check passes)
 *   - 2 exec_snapshots (so scene snapshot coverage check passes)
 *   - 10 continuity entry records (8 confirmed → 80% rate, episode check passes)
 *   - 2 review_findings (1 unresolved, for dialogue stage)
 */
async function seedQualityCheckData() {
  const { db } = await import('../../../src/db')
  const {
    projects, pipelineRuns, contentVersions, execSnapshots,
    contentContinuityRecords, reviewFindings,
  } = await import('../../../src/db/schema')

  // Project
  const [project] = await db.insert(projects).values({
    name: 'M73多阶段质量测试项目', createdAt: 1, updatedAt: 1,
  }).returning()
  const pid = project!.id

  // Pipeline run
  const [run] = await db.insert(pipelineRuns).values({
    projectId: pid,
    templateKey: 'mengbao-episode',
    input: JSON.stringify({ episode_number: 1 }),
    status: 'completed',
    createdAt: 1, updatedAt: 1,
  }).returning()
  const runId = run!.id

  // Content versions (2 → outline completeness check passes)
  await db.insert(contentVersions).values([
    {
      projectId: pid, objKind: 'asset', objId: 100, revision: 1,
      payloadKind: 'file', source: 'edit', createdAt: 1,
    },
    {
      projectId: pid, objKind: 'asset', objId: 101, revision: 1,
      payloadKind: 'file', source: 'generate', createdAt: 1,
    },
  ])

  // Execution snapshots (2 → scene snapshot coverage check passes)
  await db.insert(execSnapshots).values([
    {
      projectId: pid, execKind: 'pipeline_step', runId,
      inputHash: 'a'.repeat(64), frozenAt: 1, createdAt: 1,
    },
    {
      projectId: pid, execKind: 'pipeline_step', runId,
      inputHash: 'b'.repeat(64), frozenAt: 1, createdAt: 1,
    },
  ])

  // Continuity records: 1 confirmed entry for episode 1 (100% >= 80% → passes threshold).
  // The unique constraint idx_continuity_confirmed_unit allows only 1 confirmed entry per
  // (project, scopeKind, scopeId, unitKind, unitId), so we use a single confirmed entry.
  // Note: unitId must be > 0 per ck_continuity_unit check constraint.
  await db.insert(contentContinuityRecords).values({
    projectId: pid, scopeKind: 'series', scopeId: 1,
    unitKind: 'episode', unitId: 1, unitOrdinal: 1,
    rowType: 'entry', status: 'confirmed',
    documentAssetId: 1, documentVersionId: 1, documentHash: 'a'.repeat(64),
    runId,
    operationKey: 'entry_m73_confirmed', requestHash: 'b'.repeat(64),
    createdAt: 1, updatedAt: 1,
  })

  // Review findings: 1 unresolved (warning for dialogue stage)
  await db.insert(reviewFindings).values({
    projectId: pid,
    runId,
    baseFinalAssetId: 1,
    scopeKind: 'global',
    category: 'continuity',
    severity: 'major',
    note: 'Test unresolved finding for probe',
    status: 'open',
    baseSnapshot: '{}',
    createdAt: 1, updatedAt: 1,
  })
}

/** Exported run ID accessor (populated after initDatabase). */
export let SEEDED_RUN_ID: number | undefined

/** Resolve the seeded run ID (queries the database). */
export async function getSeededRunId(): Promise<number> {
  if (SEEDED_RUN_ID !== undefined) return SEEDED_RUN_ID
  const { db } = await import('../../../src/db')
  const { pipelineRuns } = await import('../../../src/db/schema')
  const [row] = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).limit(1)
  assert.ok(row, 'seeded run must exist')
  SEEDED_RUN_ID = row!.id
  return SEEDED_RUN_ID!
}
