import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isolatedEnv, REPO_ROOT } from '../../probe-lib'

// No src runtime imports until BOTH data/workspace and ROOT have been isolated.
const env = isolatedEnv('m70')
process.env.CSTUDIO_ROOT = env.tmp
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('M70 probe forbids unmocked fetch') }
const paths = execFileSync('git', ['ls-files', '-z', '--', 'apps/server/drizzle', 'workspace/templates', 'workspace/prompts'], {
  cwd: REPO_ROOT, encoding: 'utf8',
}).split('\0').filter(Boolean)
// The generated successor is deliberately uncommitted during this task.
for (const rel of ['apps/server/drizzle/0003_m70_continuity.sql', 'apps/server/drizzle/meta/0003_snapshot.json']) {
  if (existsSync(join(REPO_ROOT, rel)) && !paths.includes(rel)) paths.push(rel)
}
for (const rel of paths) {
  assert.ok(!rel.includes('..') && !rel.endsWith('.env'))
  const target = join(env.tmp, rel)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(join(REPO_ROOT, rel), target)
}
export const migrationsDir = join(env.tmp, 'apps/server/drizzle')
export const temporaryRoot = env.tmp
let closeDatabase: (() => void) | undefined
export function cleanup() {
  closeDatabase?.()
  globalThis.fetch = originalFetch
  env.cleanup()
}

// Sections share one initialization, including concurrent callers; never rerun the old-data seed.
let database: ReturnType<typeof initializeDatabase> | undefined
export function initDatabase() {
  return database ??= initializeDatabase()
}

/** Start at real 0002 with synthetic old data, then upgrade via production initDb. */
async function initializeDatabase() {
  const { createClient } = await import('@libsql/client')
  const { drizzle } = await import('drizzle-orm/libsql')
  const { migrate } = await import('drizzle-orm/libsql/migrator')
  const baseline = join(env.tmp, 'baseline')
  mkdirSync(join(baseline, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta/_journal.json'), 'utf8'))
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 2)
  writeFileSync(join(baseline, 'meta/_journal.json'), JSON.stringify(journal))
  for (const e of journal.entries) copyFileSync(join(migrationsDir, `${e.tag}.sql`), join(baseline, `${e.tag}.sql`))
  const client = createClient({ url: `file:${join(env.tmp, 'data/studio.db')}` })
  try {
    await migrate(drizzle(client), { migrationsFolder: baseline })
    assert.equal((await client.execute("SELECT name FROM sqlite_master WHERE name='content_continuity_records'")).rows.length, 0)
    await client.execute("INSERT INTO projects(id,name,created_at,updated_at) VALUES(7001,'M70 old project',11,12)")
    await client.execute("INSERT INTO content_versions(id,project_id,obj_kind,obj_id,revision,payload_kind,doc,created_at) VALUES(7001,7001,'asset',7001,1,'json','old immutable text',13)")
    await client.execute("INSERT INTO pipeline_runs(id,project_id,template_key,input,created_at,updated_at) VALUES(7001,7001,'old-template','{}',14,15)")
  } finally { client.close() }
  const runtimeEnv = await import('../../../src/env')
  assert.equal(runtimeEnv.ROOT, resolve(env.tmp))
  assert.equal(runtimeEnv.DATA_DIR, resolve(env.tmp, 'data'))
  assert.equal(runtimeEnv.WORKSPACE_DIR, resolve(env.tmp, 'workspace'))
  assert.ok(!existsSync(join(env.tmp, '.env')) && !existsSync(join(env.tmp, 'data/secrets.json')))
  const { initDb, sqlite } = await import('../../../src/db')
  closeDatabase = () => sqlite.close()
  await initDb()
  return { initDb, sqlite }
}
