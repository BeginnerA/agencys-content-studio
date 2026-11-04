/**
 * 角色一致性工程化探针 — 隔离环境搭建与播种。
 *
 * 职责：
 *   1. 一次性临时根目录（数据 + 工作区），必须在任何服务端模块加载前设置——环境单量在首次加载时固化；
 *   2. 复制迁移与模板/提示词（评分链会读提示词真源文件），把磁盘上尚未被 git 跟踪的最新迁移一并补齐；
 *   3. 应用全部迁移后断言两张新表存在，且风格预设表带负向词列；
 *   4. 播种：项目 / 两个角色（一个带状态条目、一个不带）/ 真实落盘的图片资产 / 分层登记行 /
 *      出图任务行 / 执行快照输入；
 *   5. 默认禁真实外发：任何未经桩替fetch 调用都计数后抛错（评分链节自行装桩并在结束后还原）。
 *
 * 播种口径：能被真实服务或端点产生的状态一律不直插库——直插会绕过守卫，让缺口的回归看不出来。
 * 只有「服务运行历史的输入夹具」（运行记录行、出图任务行）没有可调用形态，才由本文件直建并在注释里标明。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isolatedEnv, localMigrationPaths, REPO_ROOT } from '../../probe-lib'

// ── 隔离环境（必须先于任何 src 模块加载）────────────────────────────────────
const env = isolatedEnv('m74')
process.env.CSTUDIO_ROOT = env.tmp
// 评分链端点取值兜底：无供应商配置时读这三个环境变量，桩地址指向环回丢弃端口（见 fetch 桩模块）。
// 模型名取一个探针专属值，好让「评分来源随结果落库」这条断言不被环境默认值蒙混过去。
process.env.AGENT_LLM_BASE_URL = 'http://127.0.0.1:9/acs-m74-stub'
process.env.AGENT_LLM_API_KEY = 'stub-key'
process.env.AGENT_LLM_MODEL = 'stub-scorer-model'

const originalFetch = globalThis.fetch
let blockedFetchAttempts = 0
globalThis.fetch = async () => {
  blockedFetchAttempts += 1
  throw new Error('探针环境禁止未 mocks 的外发')
}

/** 未被替身拦截的 fetch 被真实调用的次数（大于 0 即说明有一处链路绕过了桩）。 */
export function blockedAttempts(): number {
  return blockedFetchAttempts
}

// ── 迁移 / 模板 / 提示词复制 ────────────────────────────────────────────────
const tracked = execFileSync('git', ['ls-files', '-z', '--', 'apps/server/drizzle', 'workspace/templates', 'workspace/prompts'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
}).split('\0').filter(Boolean)

// 新生成的迁移文件在提交前尚未被 git 跟踪，而迁移记账已登记它；缺文件会让临时库整体迁移失败。
const migrations = localMigrationPaths()
for (const rel of migrations) if (!tracked.includes(rel)) tracked.push(rel)
// 本里程碑的两张新表与负向词列就在最新一条迁移里，缺失即说明建表面没落地
assert.ok(
  migrations.some((rel) => rel.endsWith('0007_m74_character_consistency.sql')),
  '分层与一致性结果建表迁移必须存在于迁移目录',
)

for (const rel of tracked) {
  assert.ok(!rel.includes('..') && !rel.endsWith('.env'))
  const target = join(env.tmp, rel)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(join(REPO_ROOT, rel), target)
}

export const migrationsDir = join(env.tmp, 'apps/server/drizzle')
export const temporaryRoot = env.tmp

// ── 建库（惰性单例）────────────────────────────────────────────────────────
let closeDatabase: (() => void) | undefined
let initializing: Promise<void> | undefined

export function cleanup() {
  closeDatabase?.()
  globalThis.fetch = originalFetch
  env.cleanup()
}

export function initDatabase(): Promise<void> {
  return (initializing ??= buildDatabase())
}

async function buildDatabase(): Promise<void> {
  const { createClient } = await import('@libsql/client')
  const { drizzle } = await import('drizzle-orm/libsql')
  const { migrate } = await import('drizzle-orm/libsql/migrator')

  const client = createClient({ url: `file:${join(env.tmp, 'data/studio.db')}` })
  try {
    await migrate(drizzle(client), { migrationsFolder: migrationsDir })
    for (const name of ['entity_references', 'character_consistency_results']) {
      const hit = await client.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?", args: [name] })
      assert.equal(hit.rows.length, 1, `${name} 表必须在迁移后存在（建表面缺失）`)
    }
    // 风格预设的负向词列（免漂移负向约束的落库面）必须由同一条迁移补上
    const cols = await client.execute({ sql: 'PRAGMA table_info(style_presets)' })
    const colNames = (cols.rows as unknown as Array<{ name: string }>).map((r) => r.name)
    assert.ok(colNames.includes('negative'), `style_presets 需有 negative 列，实得列：${colNames.join(',')}`)
  } finally {
    client.close()
  }

  const runtimeEnv = await import('../../../src/env')
  assert.equal(runtimeEnv.ROOT, resolve(env.tmp))
  assert.equal(runtimeEnv.DATA_DIR, resolve(env.tmp, 'data'))
  assert.equal(runtimeEnv.WORKSPACE_DIR, resolve(env.tmp, 'workspace'))

  const { initDb, sqlite } = await import('../../../src/db')
  closeDatabase = () => sqlite.close()
  await initDb()

  // 运行库开启外键约束：清理夹具时裸删父行会被拒，必须先经删除端点或服务级联函数带走子行
  const fk = await sqlite.execute({ sql: 'PRAGMA foreign_keys' })
  assert.equal(Number((fk.rows[0] as Record<string, unknown>).foreign_keys), 1, '运行库必须处于外键开启态（级联面才成立）')

  await seed()
}

// ── 真实落盘图片资产 ───────────────────────────────────────────────────────

/** 最小合法 PNG（一像素）+ 末尾追加区分字节：既能让「读盘转 data URI」通过，又保证同项目内不撞哈希去重。 */
function pngBytes(label: string): Uint8Array {
  const base = Uint8Array.from(
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  )
  const tail = new TextEncoder().encode(`|${label}`)
  const out = new Uint8Array(base.length + tail.length)
  out.set(base, 0)
  out.set(tail, base.length)
  return out
}

let assetSeq = 0

/** 真实导入服务落盘一张图片资产（与上传参考图同一条写入通道，评分链会读盘转 data URI）。 */
export async function newImageAsset(projectId: number, label: string): Promise<number> {
  assetSeq += 1
  const { importFiles } = await import('../../../src/services/storage')
  const rows = await importFiles(projectId, [{ name: `m74-${assetSeq}-${label}.png`, data: pngBytes(`${assetSeq}-${label}`) }], { purpose: 'reference_character' })
  const row = rows[0]
  if (!row) throw new Error(`图片资产落盘失败：${label}`)
  return row.id
}

/** 真实导入服务落盘一份文本资产（用于「非图片不可登记为参考图」的负向夹具）。 */
export async function newTextAsset(projectId: number, label: string): Promise<number> {
  assetSeq += 1
  const { importFiles } = await import('../../../src/services/storage')
  const rows = await importFiles(projectId, [{ name: `m74-${assetSeq}-${label}.md`, data: new TextEncoder().encode(`TEXT:${assetSeq}:${label}`) }], { purpose: 'reference_character' })
  const row = rows[0]
  if (!row) throw new Error(`文本资产落盘失败：${label}`)
  return row.id
}

// ── 播种 ────────────────────────────────────────────────────────────────────

export interface SeededFixture {
  projectId: number
  runId: number
  entityA: number
  entityB: number
  /** 角色A 的历史扁平参考（后被自动固化为基准行） */
  aFlat: number[]
  /** 角色A 的状态变体参考 / 多视角参考 */
  aState: number
  aView: number
  /** 角色B 的扁平参考（未分层） */
  bFlat: number[]
  /** 本运行出图资产（按任务行归属到实体） */
  outA: number[]
  outB: number[]
}

let seeded: SeededFixture | undefined

export async function getSeededRunId(): Promise<number> {
  await initDatabase()
  return (await seededFixture()).runId
}

export async function getSeededEntityIds(): Promise<{ a: number; b: number; projectId: number }> {
  await initDatabase()
  const f = await seededFixture()
  return { a: f.entityA, b: f.entityB, projectId: f.projectId }
}

async function seededFixture(): Promise<SeededFixture> {
  if (!seeded) throw new Error('播种尚未完成（应在建库初始化后调用）')
  return seeded
}

/** 经真实端点创建一条运行记录没有服务形态（运行由编排引擎产生），故直建：它是被消费的历史输入，不是被测状态。 */
export async function newRunFixture(projectId: number): Promise<number> {
  const { db } = await import('../../../src/db')
  const { pipelineRuns } = await import('../../../src/db/schema')
  const now = Date.now()
  const [row] = await db
    .insert(pipelineRuns)
    .values({ projectId, templateKey: 'mengbao-episode', input: JSON.stringify({ episode_number: 1 }), status: 'completed', createdAt: now, updatedAt: now })
    .returning()
  if (!row) throw new Error('运行记录创建失败')
  return row.id
}

/** 出图任务行同上：评价的输入历史，无服务形态可造「已成功」的出图结果。 */
export async function newTaskFixture(projectId: number, runId: number, entityId: number, assetId: number, shotId: string, completedAt: number): Promise<void> {
  const { db } = await import('../../../src/db')
  const { genTasks } = await import('../../../src/db/schema')
  const now = Date.now()
  await db.insert(genTasks).values({
    projectId,
    runId,
    kind: 'image',
    params: JSON.stringify({ shotId, entityIds: [entityId], resultAssetId: assetId }),
    status: 'succeeded',
    resultAssetId: assetId,
    createdAt: now,
    updatedAt: completedAt,
    completedAt,
  })
}

/** 出镜集合的真实来源：执行快照 + 其 srcKind='entity' 且带版本指针的输入行（经快照服务写入）。 */
export async function newAppearingSnapshot(projectId: number, runId: number, entityIds: number[]): Promise<void> {
  const { recordExecSnapshot } = await import('../../../src/services/provenance')
  let ordinal = 0
  const inputs = []
  for (const entityId of entityIds) {
    ordinal += 1
    inputs.push({ role: 'reference', srcKind: 'entity' as const, srcId: entityId, versionId: await entityVersionId(entityId), shotId: `shot-${ordinal}`, ordinal })
  }
  await recordExecSnapshot({ projectId, execKind: 'pipeline_step', runId, templateKey: 'mengbao-episode', inputs })
}

/** 实体的任一历史版本指针（执行快照输入要求带版本才算「出镜」）。 */
async function entityVersionId(entityId: number): Promise<number> {
  const { and, eq } = await import('drizzle-orm')
  const { db } = await import('../../../src/db')
  const { contentVersions } = await import('../../../src/db/schema')
  const [row] = await db
    .select({ id: contentVersions.id })
    .from(contentVersions)
    .where(and(eq(contentVersions.objKind, 'entity'), eq(contentVersions.objId, entityId)))
    .limit(1)
  if (!row) throw new Error(`实体 ${entityId} 无版本记录`)
  return row.id
}

async function seed(): Promise<void> {
  const { call } = await import('./helpers')
  const { attachRefAssetsById } = await import('../../../src/services/character')
  const { addEntityRef } = await import('../../../src/services/entity-references')

  // 项目与实体经真实端点创建（挂载面本身也在被测范围内）
  const proj = await call('POST', '/projects', { name: '分层一致性播种项目' })
  assert.equal(proj.status, 201, `播种项目创建失败：${proj.status} ${proj.body}`)
  const projectId = proj.data.project.id as number

  const aFlat = [await newImageAsset(projectId, '甲历史一'), await newImageAsset(projectId, '甲历史二')]
  const aState = await newImageAsset(projectId, '甲状态受伤')
  const aView = await newImageAsset(projectId, '甲视角背面')
  const bFlat = [await newImageAsset(projectId, '乙基准一'), await newImageAsset(projectId, '乙基准二'), await newImageAsset(projectId, '乙基准三')]

  const entA = await call('POST', '/entities', {
    project_id: projectId,
    name: '角色甲',
    kind: 'character',
    appearance: '圆脸短发、左眉有疤',
    negative: '多余手指',
    states: ['第1场：受伤', '第2场：疲惫'],
  })
  assert.equal(entA.status, 201, `播种角色甲创建失败：${entA.status} ${entA.body}`)
  const entityA = entA.data.entity.id as number

  const entB = await call('POST', '/entities', { project_id: projectId, name: '角色乙', kind: 'character', appearance: '长卷发' })
  assert.equal(entB.status, 201, `播种角色乙创建失败：${entB.status} ${entB.body}`)
  const entityB = entB.data.entity.id as number

  // 历史扁平参考经真实挂接服务写入（并集去重 + 实体版本）
  assert.equal(await attachRefAssetsById(entityA, aFlat, 'edit', projectId), aFlat.length)
  assert.equal(await attachRefAssetsById(entityB, bFlat, 'edit', projectId), bFlat.length)

  // 分层登记经真实服务写入：状态行与视角行各一条；历史两张在此过程中被自动固化为基准行
  await addEntityRef({ entityId: entityA, assetId: aState, role: 'state', stateKey: '第1场：受伤' })
  await addEntityRef({ entityId: entityA, assetId: aView, role: 'view', viewKey: '背面' })

  const runId = await newRunFixture(projectId)
  const outA = [await newImageAsset(projectId, '甲出图一'), await newImageAsset(projectId, '甲出图二'), await newImageAsset(projectId, '甲出图三')]
  const outB = [await newImageAsset(projectId, '乙出图一'), await newImageAsset(projectId, '乙出图二')]
  let clock = 1000
  for (const [i, assetId] of outA.entries()) await newTaskFixture(projectId, runId, entityA, assetId, `shot-a${i + 1}`, (clock += 1000))
  for (const [i, assetId] of outB.entries()) await newTaskFixture(projectId, runId, entityB, assetId, `shot-b${i + 1}`, (clock += 1000))

  // 出镜集合的真源是执行快照输入，经真实快照服务写入（srcKind='entity' 且带版本指针才算出镜）
  await newAppearingSnapshot(projectId, runId, [entityA, entityB])

  seeded = { projectId, runId, entityA, entityB, aFlat, aState, aView, bFlat, outA, outB }
}
