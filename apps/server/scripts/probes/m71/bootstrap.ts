/**
 * 质量基线探针隔离环境
 *
 * 职责：
 *   1. 创建临时隔离目录（CSTUDIO_DATA / CSTUDIO_WORKSPACE 独立）
 *   2. 复制全量迁移文件（0000–0004）到隔离区
 *   3. 通过 initDb 应用迁移，建立 quality_scores 等表
 *   4. 植入评分服务所需的种子数据（project / run / snapshot / input / version / usage / continuity）
 *   5. 禁止真实 fetch（评分服务不调外部模型，网络边界必须封闭）
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isolatedEnv, REPO_ROOT } from '../../probe-lib'

// ── 隔离环境（必须在任何 src 模块加载前完成） ───────────────────────────────
const env = isolatedEnv('m71')
process.env.CSTUDIO_ROOT = env.tmp
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('M71 probe forbids unmocked fetch') }

// ── 复制迁移文件 ──────────────────────────────────────────────────────────
const paths = execFileSync('git', ['ls-files', '-z', '--', 'apps/server/drizzle', 'workspace/templates', 'workspace/prompts'], {
  cwd: REPO_ROOT, encoding: 'utf8',
}).split('\0').filter(Boolean)

// 0004 迁移可能尚未被 git track，显式补入
for (const rel of ['apps/server/drizzle/0004_m71_quality_baseline.sql']) {
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

// ── 数据库初始化（惰性单例） ──────────────────────────────────────────────
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

/** 应用全量迁移（含 0004 quality_scores + role_configs），然后植入种子数据。 */
async function initializeDatabase() {
  const { createClient } = await import('@libsql/client')
  const { drizzle } = await import('drizzle-orm/libsql')
  const { migrate } = await import('drizzle-orm/libsql/migrator')

  // 用全量迁移建立干净数据库
  const client = createClient({ url: `file:${join(env.tmp, 'data/studio.db')}` })
  try {
    await migrate(drizzle(client), { migrationsFolder: migrationsDir })
    // 验证 quality_scores 表已建立
    assert.equal(
      (await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='quality_scores'")).rows.length,
      1,
      'quality_scores table must exist after migration',
    )
    // 验证 role_configs 表已建立（0004 同批迁移）
    assert.equal(
      (await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='role_configs'")).rows.length,
      1,
      'role_configs table must exist after migration',
    )
  } finally {
    client.close()
  }

  // 通过公开 initDb 初始化运行时数据库连接
  const runtimeEnv = await import('../../../src/env')
  assert.equal(runtimeEnv.ROOT, resolve(env.tmp))
  assert.equal(runtimeEnv.DATA_DIR, resolve(env.tmp, 'data'))
  assert.equal(runtimeEnv.WORKSPACE_DIR, resolve(env.tmp, 'workspace'))

  const { initDb, sqlite } = await import('../../../src/db')
  closeDatabase = () => sqlite.close()
  await initDb()

  // 植入种子数据
  await seedQualityData()

  return { initDb, sqlite }
}

// ── 种子数据 ──────────────────────────────────────────────────────────────

/**
 * 植入评分服务所需的完整测试数据：
 *   - 1 个项目
 *   - 1 个 pipeline_run（带 templateSnapshot 元数据）
 *   - 2 个 exec_snapshot（关联到 run）
 *   - 4 条 exec_input（2 条有 versionId，2 条无；1 条 entity 类 superseded 版本）
 *   - 3 个 content_versions（2 个稳定态 edit/generate，1 个不稳定 superseded）
 *   - 3 条 usage_records（2 条有 cost，1 条无）
 *   - 2 条 content_continuity_records context 类型（1 条 frozen，1 条 bound）
 */
async function seedQualityData() {
  const { db } = await import('../../../src/db')
  const {
    projects, pipelineRuns, execSnapshots, execInputs,
    contentVersions, usageRecords, contentContinuityRecords,
  } = await import('../../../src/db/schema')

  // 项目
  const [project] = await db.insert(projects).values({
    name: 'M71评分测试项目', createdAt: 1, updatedAt: 1,
  }).returning()
  const pid = project!.id

  // pipeline_run（带模板快照元数据，供 metadata 收集）
  const templateSnapshot = JSON.stringify({
    version: 'tpl-v3',
    promptVersion: 'prompt-v7',
    model: 'test-model-7b',
    params: { temperature: 0.7, maxTokens: 2048 },
  })
  const [run] = await db.insert(pipelineRuns).values({
    projectId: pid,
    templateKey: 'mengbao-episode',
    templateSnapshot,
    input: JSON.stringify({ episode_number: 1 }),
    status: 'completed',
    createdAt: 1, updatedAt: 1,
  }).returning()
  const runId = run!.id

  // content_versions（3 个版本：2 稳定 + 1 不稳定 superseded）
  const [v1] = await db.insert(contentVersions).values({
    projectId: pid, objKind: 'asset', objId: 100, revision: 1,
    payloadKind: 'file', source: 'edit', createdAt: 1,
  }).returning()
  const [v2] = await db.insert(contentVersions).values({
    projectId: pid, objKind: 'asset', objId: 101, revision: 1,
    payloadKind: 'file', source: 'generate', createdAt: 1,
  }).returning()
  const [v3] = await db.insert(contentVersions).values({
    projectId: pid, objKind: 'entity', objId: 200, revision: 1,
    payloadKind: 'json', source: 'superseded',
    doc: '{"name":"旧版角色"}', createdAt: 1,
  }).returning()

  // exec_snapshots（2 个快照关联到 run）
  const [snap1] = await db.insert(execSnapshots).values({
    projectId: pid, execKind: 'pipeline_step', runId,
    inputHash: 'a'.repeat(64), frozenAt: 1, createdAt: 1,
  }).returning()
  const [snap2] = await db.insert(execSnapshots).values({
    projectId: pid, execKind: 'pipeline_step', runId,
    inputHash: 'b'.repeat(64), frozenAt: 1, createdAt: 1,
  }).returning()

  // exec_inputs（4 条：2 有 versionId + 1 entity/superseded + 1 无 versionId）
  // → 引文完整度 = 2/4 = 0.5
  await db.insert(execInputs).values([
    { snapshotId: snap1!.id, projectId: pid, role: 'text', srcKind: 'asset', srcId: 100, versionId: v1!.id, createdAt: 1 },
    { snapshotId: snap1!.id, projectId: pid, role: 'reference', srcKind: 'asset', srcId: 101, versionId: v2!.id, createdAt: 1 },
    { snapshotId: snap2!.id, projectId: pid, role: 'text', srcKind: 'asset', srcId: 102, versionId: null, createdAt: 1 },
    { snapshotId: snap2!.id, projectId: pid, role: 'prev_text', srcKind: 'asset', srcId: 103, versionId: null, createdAt: 1 },
  ])

  // entity 类 exec_input 指向 superseded 版本 → 影响角色一致性
  // 一致性计算：entity 输入中 version_id IS NOT NULL 的有 1 条（v3），v3.source='superseded' → 不稳定
  // stableCount=0, total=1 → consistencyScore = 0/1 = 0
  await db.insert(execInputs).values({
    snapshotId: snap1!.id, projectId: pid, role: 'reference',
    srcKind: 'entity', srcId: 200, versionId: v3!.id, createdAt: 1,
  })

  // usage_records（3 条：2 有 cost，1 无 → costScore = 2/3 ≈ 0.667）
  await db.insert(usageRecords).values([
    { projectId: pid, runId, kind: 'llm', quantity: 100, unit: 'tokens_in', unitPrice: 0.001, cost: 0.1, createdAt: 1 },
    { projectId: pid, runId, kind: 'llm', quantity: 50, unit: 'tokens_out', unitPrice: 0.002, cost: 0.1, createdAt: 1 },
    { projectId: pid, runId, kind: 'image', quantity: 1, unit: 'image', unitPrice: null, cost: null, createdAt: 1 },
  ])

  // content_continuity_records context 类型（2 条：1 frozen + 1 bound → coherenceScore = 2/2 = 1.0）
  // CHECK 约束要求 context 行 document 三字段非空，unit_id > 0
  await db.insert(contentContinuityRecords).values([
    {
      projectId: pid, scopeKind: 'series', scopeId: 1,
      unitKind: 'episode', unitId: 1, unitOrdinal: 1,
      rowType: 'context', status: 'frozen',
      documentAssetId: 1, documentVersionId: 1, documentHash: 'c'.repeat(64),
      operationKey: 'ctx_m71_frozen', requestHash: 'c'.repeat(64),
      createdAt: 1, updatedAt: 1,
    },
    {
      projectId: pid, scopeKind: 'series', scopeId: 1,
      unitKind: 'episode', unitId: 1, unitOrdinal: 1,
      rowType: 'context', status: 'bound',
      documentAssetId: 2, documentVersionId: 2, documentHash: 'd'.repeat(64),
      operationKey: 'ctx_m71_bound', requestHash: 'd'.repeat(64),
      createdAt: 1, updatedAt: 1,
    },
  ])
}

/** 种子数据中各维度的预期分数（供探针断言使用） */
export const EXPECTED = {
  /** 引文完整度：5 条 exec_input 中 3 条有 versionId（v1, v2, v3）→ 0.6 */
  citationScore: 0.6,
  /** 角色一致性：1 条 entity input 指向 superseded 版本 → 0/1 = 0 */
  consistencyScore: 0,
  /** 剧情连贯度：2 条 context 记录均为已确认状态（frozen/bound）→ 1.0 */
  coherenceScore: 1.0,
  /** 费用效率：3 条 usage 中 2 条有 cost → 2/3 */
  costScore: 2 / 3,
} as const
