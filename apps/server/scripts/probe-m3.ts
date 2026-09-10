/**
 * M3 探针（记忆/角色/契约/情绪/对齐/模板）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m3.ts [--section=migrate|memory|...]
 *
 * 隔离策略：CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录（独立 studio.db + workspace），
 * 不触碰开发库（同 probe-m2a）。
 *
 * section（默认 all = 全部已实现；未列出的 section 由后续任务逐段加入）：
 *   migrate  空库 migrate 自动建 memories/characters 两表 + 4 索引
 *   memory   embedding 服务冒烟（维度 / cosine / status）+ upsert/recall/reindex 断言
 *   memory-action  记忆 action 闭环：run1 召回占位 + 沉淀 → run2 召回命中（memory_write/memory_recall 实弹）
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL；2 = 前置缺失（模型未就绪，memory 相关 section 输出 SKIP）。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
// 清理历史残留：libsql 在 Windows 下不释放文件句柄（close 后仍 EBUSY）——本进程退出时 db 文件必留；
// 本次运行在创建自己的目录前清掉旧的（占用中则跳过，自动收敛为最多一份）。
const TMP_PREFIX = 'acs-probe-m3-'
for (const name of readdirSync(tmpdir())) {
  if (name.startsWith(TMP_PREFIX)) {
    try {
      rmSync(join(tmpdir(), name), { recursive: true, force: true })
    } catch { /* 占用中（并行探针）→ 跳过 */ }
  }
}
const TMP = mkdtempSync(join(tmpdir(), TMP_PREFIX))
process.env.CSTUDIO_ROOT = REPO_ROOT
process.env.CSTUDIO_DATA = join(TMP, 'data')
process.env.CSTUDIO_WORKSPACE = join(TMP, 'workspace')
mkdirSync(process.env.CSTUDIO_DATA, { recursive: true })
mkdirSync(process.env.CSTUDIO_WORKSPACE, { recursive: true })

const SECTIONS = ['migrate', 'memory', 'memory-action'] as const

/** memory-action section 的内联模板（写临时 templates 目录；manual_ingest 产 brief 资产，无 LLM/网络依赖） */
const TPL_M3_MEMORY = `key: probe-m3-memory
version: 1
name: M3 记忆 action 探针
genre: other
inputs:
  - key: topic
    label: 主题
    kind: text
    required: true
  - key: brief
    label: 简报
    kind: text
    required: true
steps:
  - key: recall
    action: memory_recall
    title: 记忆召回
    inputs:
      query: input.topic
    params:
      limit: 3
      scope: project
  - key: ingest
    action: manual_ingest
    title: 入库
    after: [recall]
    inputs:
      brief: input.brief
  - key: remember
    action: memory_write
    title: 沉淀
    after: [ingest]
    inputs:
      content: steps.ingest.asset
    params:
      scope: project
      type: style
      name: probe-latest
`

async function main(): Promise<void> {
  // src 模块全部动态加载（环境变量已隔离）
  const { initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')

  const log = createLogger('probe-m3')
  let failed = 0
  let skipReason: string | null = null
  const check = (cond: boolean, msg: string): void => {
    if (cond) log.info(`  PASS  ${msg}`)
    else {
      failed += 1
      log.error(`  FAIL  ${msg}`)
    }
  }

  /**
   * 模型桥接：隔离环境把 data/ 指向临时目录，而模型（45MB）属外部资产——
   * 建 junction（零拷贝）把隔离 data/models 指向仓库真实 data/models；无真模型则留空（status 报 SKIP）。
   * junction 失败退化为按目录复制。
   */
  const bridgeModels = async (): Promise<void> => {
    const realModels = join(REPO_ROOT, 'data', 'models')
    const tmpModels = join(process.env.CSTUDIO_DATA!, 'models')
    if (existsSync(tmpModels) || !existsSync(realModels)) return
    try {
      symlinkSync(realModels, tmpModels, 'junction')
      log.info(`模型目录已 junction：${tmpModels} → ${realModels}`)
    } catch (e) {
      log.warn(`junction 失败（${(e as Error).message}），退化为复制…`)
      cpSync(realModels, tmpModels, { recursive: true })
    }
  }

  // ================= sections =================

  const sectionMigrate = async (): Promise<void> => {
    await initDb()
    const r = await sqlite.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('memories','characters') ORDER BY name",
    )
    const names = (r.rows as unknown as Array<{ name: string }>).map((x) => x.name)
    check(names.join(',') === 'characters,memories', `memories/characters 两表存在（${names.join(',')}）`)
    const ri = await sqlite.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_memories_project','idx_memories_name','idx_characters_project','idx_characters_name')",
    )
    check(ri.rows.length === 4, `4 个索引存在（实际 ${ri.rows.length}）`)
  }

  const sectionMemory = async (): Promise<void> => {
    await initDb()
    await bridgeModels()
    const { embed, cosine, embeddingStatus } = await import('../src/services/embedding')
    const st0 = await embeddingStatus()
    log.info(`embeddingStatus: ready=${st0.ready} modelName=${st0.modelName} dims=${st0.dims} dir=${st0.modelDir}`)
    if (!st0.ready) {
      skipReason = `embedding 模型未就绪：${st0.error}`
      log.warn(`SKIP  memory section —— ${skipReason}`)
      return
    }
    const v = await embed('阳光明媚，正适合户外走走')
    check(v.length > 0, `embed 维度 > 0（${v.length}）`)
    const self = cosine(v, v)
    check(Math.abs(self - 1) < 1e-3, `cosine 自相似 ≈ 1（${self.toFixed(4)}）`)
    const st1 = await embeddingStatus()
    check(st1.dims === v.length, `status 维度与实测一致（${st1.dims} === ${v.length}）`)

    // —— 记忆服务：upsert / 近义召回 / reindex ——
    const { upsertMemory, recallMemories, reindexMemories } = await import('../src/services/memory')

    // 写入 3 条具名记忆（具名 = 同域同名 upsert 幂等，模板默认用它）
    const mA = await upsertMemory({ projectId: null, type: 'note', name: 'probe-weather-a', content: '今天天气真好，适合出门散步' })
    const mB = await upsertMemory({ projectId: null, type: 'note', name: 'probe-weather-b', content: '阳光明媚，正适合户外走走' })
    const mC = await upsertMemory({ projectId: null, type: 'note', name: 'probe-weather-c', content: '我讨厌下雨天' })
    check(mA.created && mB.created && mC.created, `upsertMemory 新增 3 条（created=${mA.created},${mB.created},${mC.created}）`)

    // 同名 upsert 幂等：id 保持、行数不增
    const mA2 = await upsertMemory({ projectId: null, type: 'note', name: 'probe-weather-a', content: '今天天气真好，适合出门散步' })
    const nRows = (await sqlite.execute('SELECT COUNT(*) AS n FROM memories')).rows as unknown as Array<{ n: number }>
    check(!mA2.created && mA2.id === mA.id && Number(nRows[0]!.n) === 3, `同名 upsert 幂等（id=${mA2.id} 保持、行数=${nRows[0]!.n}）`)

    // 近义召回：正向天气条目应排在反语义条目之前
    const hits = await recallMemories({ projectId: null, query: '出去遛弯天气不错', limit: 3 })
    check(hits.length === 3, `recall 命中 3 条（${hits.map((x) => `${x.name}:${x.score.toFixed(3)}`).join(' / ')}）`)
    check(hits[0]?.name !== 'probe-weather-c', `top1 为正向天气条目（${hits[0]?.name} score=${hits[0]?.score.toFixed(4)}）`)

    // reindex 全量重算 → 召回稳定
    const rx = await reindexMemories()
    check(rx.total === 3 && rx.rebuilt === 3 && rx.skipped === 0, `reindex 计数（total=${rx.total} rebuilt=${rx.rebuilt} skipped=${rx.skipped}）`)
    const hits2 = await recallMemories({ projectId: null, query: '出去遛弯天气不错', limit: 3 })
    check(hits2.length === hits.length && hits2[0]!.id === hits[0]!.id, `reindex 后召回稳定（top1 id=${hits2[0]?.id}）`)
  }

  const sectionMemoryAction = async (): Promise<void> => {
    await initDb()
    await bridgeModels()
    const { embeddingStatus } = await import('../src/services/embedding')
    const st = await embeddingStatus()
    if (!st.ready) {
      skipReason = `embedding 模型未就绪：${st.error}`
      log.warn(`SKIP  memory-action section —— ${skipReason}`)
      return
    }
    const { db } = await import('../src/db')
    const { assets, pipelineRuns, pipelineSteps, projects } = await import('../src/db/schema')
    const { loadTemplate } = await import('../src/pipeline/loader')
    const { engine } = await import('../src/pipeline/engine')
    const { readTextAsset } = await import('../src/services/storage')
    const { asc, eq } = await import('drizzle-orm')

    // 内联模板写临时 templates 目录（loadTemplate 走隔离 workspace）
    const tplFile = join(process.env.CSTUDIO_WORKSPACE!, 'templates', 'probe-m3-memory.yaml')
    writeFileSync(tplFile, TPL_M3_MEMORY, 'utf8')
    check(loadTemplate('probe-m3-memory').steps.length === 3, '记忆 action 探针模板加载（steps=3）')

    const t = Date.now()
    const proj = (
      await db
        .insert(projects)
        .values({ name: 'M3 记忆 action 探针', genre: 'other', templateKey: 'probe-m3-memory', settings: '{}', tags: '[]', createdAt: t, updatedAt: t })
        .returning()
    )[0]!

    const runOf = async (runId: number) => (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1))[0]!
    const stepsOf = async (runId: number) => db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId)).orderBy(asc(pipelineSteps.seq))
    const assetRow = async (id: number) => (await db.select().from(assets).where(eq(assets.id, id)).limit(1))[0]!
    const parseIds = (s: { output: string | null }): number[] => {
      try {
        return (JSON.parse(s.output ?? '{}') as { asset_ids?: number[] }).asset_ids ?? []
      } catch {
        return []
      }
    }
    const pollCompleted = async (runId: number): Promise<void> => {
      const deadline = Date.now() + 30000
      for (;;) {
        if ((await runOf(runId)).status === 'completed') return
        if (Date.now() > deadline) throw new Error(`超时等待 run#${runId} completed`)
        await new Promise((r) => setTimeout(r, 150))
      }
    }
    const startRun = async (brief: string): Promise<number> => {
      const now = Date.now()
      const run = (
        await db
          .insert(pipelineRuns)
          .values({
            projectId: proj.id,
            templateKey: 'probe-m3-memory',
            status: 'queued',
            input: JSON.stringify({ topic: '写作风格偏好', brief }),
            templateSnapshot: JSON.stringify(loadTemplate('probe-m3-memory')),
            createdAt: now,
            updatedAt: now,
          })
          .returning()
      )[0]!
      engine.startRun(run.id)
      await pollCompleted(run.id)
      return run.id
    }
    const memCount = async (): Promise<number> => {
      const rows = (await sqlite.execute(`SELECT COUNT(*) AS n FROM memories WHERE project_id = ${proj.id}`)).rows as unknown as Array<{ n: number }>
      return Number(rows[0]!.n)
    }

    // —— run1：项目域空库 → 召回占位 + 沉淀记忆 ——
    const run1Id = await startRun('第一版风格样本：强调口语化短句，避免书面长句')
    const r1 = new Map((await stepsOf(run1Id)).map((s) => [s.stepKey, s]))
    check(['recall', 'ingest', 'remember'].every((k) => r1.get(k)?.status === 'succeeded'), 'run1 三步全部 succeeded')
    const recall1Ids = parseIds(r1.get('recall')!)
    const recall1 = recall1Ids.length === 1 ? await readTextAsset(recall1Ids[0]!) : ''
    check(recall1Ids.length === 1 && (await assetRow(recall1Ids[0]!)).purpose === 'memory', 'run1 recall 产物 purpose=memory')
    check(recall1.includes('无相关记忆'), 'run1 首跑空召回（占位资产）')
    const log1Ids = parseIds(r1.get('remember')!)
    check(log1Ids.length === 1 && (await assetRow(log1Ids[0]!)).purpose === 'memory_log', 'run1 remember 产物 purpose=memory_log')
    check((await memCount()) === 1, `项目域记忆 1 行（实际 ${await memCount()}）`)

    // —— run2：同项目再跑 → 召回命中 run1 沉淀（记忆闭环） ——
    const run2Id = await startRun('第二版风格样本：口语化短句')
    const r2 = new Map((await stepsOf(run2Id)).map((s) => [s.stepKey, s]))
    check(['recall', 'ingest', 'remember'].every((k) => r2.get(k)?.status === 'succeeded'), 'run2 三步全部 succeeded')
    const recall2Ids = parseIds(r2.get('recall')!)
    const recall2 = recall2Ids.length === 1 ? await readTextAsset(recall2Ids[0]!) : ''
    check(recall2.includes('相似度'), 'run2 召回含相似度段落')
    check(recall2.includes('第一版风格样本'), 'run2 召回命中 run1 沉淀（闭环）')
    const p2 = JSON.parse((await assetRow(recall2Ids[0]!)).params ?? '{}') as { count?: number; topScore?: number }
    check((p2.count ?? 0) >= 1, `recall params.count=${p2.count}（topScore=${p2.topScore === undefined ? '—' : p2.topScore.toFixed(3)}）`)
    check((await memCount()) === 1, `run2 后项目域记忆仍 1 行（同名 upsert，实际 ${await memCount()}）`)
  }

  // ================= 分发 =================

  const runners: Record<string, () => Promise<void>> = {
    migrate: sectionMigrate,
    memory: sectionMemory,
    'memory-action': sectionMemoryAction,
  }
  const arg = process.argv.find((a) => a.startsWith('--section='))
  const wanted = arg ? arg.slice('--section='.length) : 'all'
  if (wanted !== 'all' && !(SECTIONS as readonly string[]).includes(wanted)) {
    log.error(`未知 section：${wanted}（已实现：${SECTIONS.join(' / ')}；all = 全部）`)
    process.exitCode = 1
    return
  }

  try {
    for (const name of wanted === 'all' ? SECTIONS : [wanted]) {
      console.log(`\n──── section: ${name} ────`)
      await runners[name]!()
    }
  } catch (err) {
    failed += 1
    console.error(`\n探针异常终止: ${(err as Error).stack ?? err}`)
  } finally {
    const verdict =
      failed > 0 ? `${failed} 项失败` : skipReason ? `SKIP（${skipReason}）` : '全部通过'
    console.log(`\n==== M3 探针结果: ${verdict} ====`)
    try {
      sqlite.close() // 释放 db 连接（Windows 下句柄可能仍被 libsql 持有 → 失败不阻断）
    } catch { /* 已关闭或未初始化 */ }
    try {
      rmSync(TMP, { recursive: true, force: true })
    } catch {
      console.log(`临时目录未完全清理（Windows libsql 句柄；下次运行自动清理）: ${TMP}`)
    }
    process.exitCode = failed > 0 ? 1 : skipReason ? 2 : 0
  }
}

void main()
