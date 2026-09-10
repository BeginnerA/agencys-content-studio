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
 *   character  角色建档闭环：预置角色 + 纯函数注入断言 + ingest→char_sync 实弹（定妆照归属/幂等）
 *   contract  文本输出契约：validateTextOutput（characters-json / lines-json v2 / storyboard-json 回归）
 *   tts  声线六级链 + 情绪基调词/透传载荷（纯函数，无网络）
 *   subtitle  measured 字幕对齐：splitDisplayLines 分层切行 + planMeasuredSrt 比例分配/合并/leadIn（纯函数，无 LLM/ffprobe）
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

const SECTIONS = ['migrate', 'memory', 'memory-action', 'character', 'contract', 'tts', 'subtitle'] as const

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

/** character section 的内联模板（ingest 产 brief 资产 → char_sync 多资产逐个尝试解析取第一个 characters 数组） */
const TPL_M3_CHARACTER = `key: probe-m3-character
version: 1
name: M3 角色建档探针
genre: other
inputs:
  - key: brief
    label: 简报
    kind: text
    required: true
steps:
  - key: ingest
    action: manual_ingest
    title: 素材入库
    inputs:
      docs: assets purpose=characters
      brief: input.brief
  - key: char_sync
    action: character_sync
    title: 角色建档
    after: [ingest]
    inputs:
      characters: steps.ingest.assets
      ref_images: assets purpose=reference_character
    params:
      project: true
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

  const sectionCharacter = async (): Promise<void> => {
    await initDb()
    const { db } = await import('../src/db')
    const { assets, characters, pipelineRuns, pipelineSteps, projects } = await import('../src/db/schema')
    const { loadTemplate } = await import('../src/pipeline/loader')
    const { engine } = await import('../src/pipeline/engine')
    const { readTextAsset, writeTextAsset } = await import('../src/services/storage')
    const { loadCharacterIndex, upsertCharacter } = await import('../src/services/character')
    const { injectCharacterAnchors } = await import('../src/pipeline/actions/ai-image')
    const { and, asc, eq } = await import('drizzle-orm')

    const t = Date.now()
    const proj = (
      await db
        .insert(projects)
        .values({ name: 'M3 角色探针', genre: 'other', templateKey: 'probe-m3-character', settings: '{}', tags: '[]', createdAt: t, updatedAt: t })
        .returning()
    )[0]!

    // —— 1. 预置角色（含别名「小宝」；供纯函数命中） ——
    const pre = await upsertCharacter({
      projectId: proj.id,
      name: '萌宝',
      aliases: ['小宝'],
      appearance: '圆脸大眼、胖乎乎的三岁半男孩（第一版）',
      negative: '成人化五官、写实比例',
      voice: '软糯童声',
      summary: '三岁半男主角',
    })
    check(pre.created, `预置角色「萌宝」新建 #${pre.id}`)

    // —— 2. 纯函数：注入 / 别名命中 / 未命中 / 不改入参 ——
    const idx = await loadCharacterIndex(proj.id)
    const shotsIn = [
      { id: 's1', image_prompt: 'P1', characters: ['萌宝'] },
      { id: 's2', image_prompt: 'P2', characters: ['小宝'] },
      { id: 's3', image_prompt: 'P3', characters: ['查无此人'] },
      { id: 's4', image_prompt: 'P4' },
    ]
    const inj = injectCharacterAnchors(shotsIn, idx)
    check(
      inj.shots[0]!.image_prompt.includes('角色锚定（萌宝）：') && inj.shots[0]!.image_prompt.includes('必须剔除：'),
      's1 注入锚定（appearance + negative 段）',
    )
    check(inj.shots[1]!.image_prompt.includes('角色锚定（萌宝）：'), 's2 别名「小宝」命中同一角色')
    check(inj.shots[2]!.image_prompt === 'P3' && inj.shots[3]!.image_prompt === 'P4', 's3 未命中 / s4 无 characters 原文不变')
    check(inj.missing.length === 1 && inj.missing[0] === '查无此人', `missing=[${inj.missing.join(',')}]`)
    check(inj.injected === 2, `injected=${inj.injected}（=2）`)
    check(shotsIn[0]!.image_prompt === 'P1' && shotsIn[1]!.image_prompt === 'P2', '入参数组未被修改')

    // —— 3. 引擎链路：角色档案资产 + 定妆照 → ingest → char_sync ——
    await writeTextAsset(proj.id, {
      name: 'characters.json',
      content: JSON.stringify({
        characters: [
          { name: '萌宝', aliases: ['小宝'], appearance: '圆脸大眼、虎头帽红袄（第二版）', negative: '成人化五官', voice: '软糯童声' },
          { name: '灰灰', appearance: '灰毛垂耳小狼，眼睛亮晶晶', negative: '恐怖獠牙', voice: '清亮少年音' },
        ],
      }),
      purpose: 'characters',
      format: 'characters-json',
      tags: ['characters'],
    })
    // 定妆照两张：一张 shotId 精确归属（灰灰）、一张资产名兜底归属（萌宝）
    const refA = (
      await db
        .insert(assets)
        .values({
          projectId: proj.id,
          kind: 'image',
          purpose: 'reference_character',
          name: '灰灰-定妆照.png',
          mime: 'image/png',
          ext: 'png',
          params: JSON.stringify({ shotId: '灰灰' }),
          tags: '[]',
          createdAt: t,
          updatedAt: t,
        })
        .returning()
    )[0]!
    const refB = (
      await db
        .insert(assets)
        .values({
          projectId: proj.id,
          kind: 'image',
          purpose: 'reference_character',
          name: '萌宝造型照.png',
          mime: 'image/png',
          ext: 'png',
          tags: '[]',
          createdAt: t,
          updatedAt: t,
        })
        .returning()
    )[0]!

    const tplFile = join(process.env.CSTUDIO_WORKSPACE!, 'templates', 'probe-m3-character.yaml')
    writeFileSync(tplFile, TPL_M3_CHARACTER, 'utf8')
    check(loadTemplate('probe-m3-character').steps.length === 2, '角色探针模板加载（steps=2）')

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
    const startRun = async (): Promise<number> => {
      const now = Date.now()
      const run = (
        await db
          .insert(pipelineRuns)
          .values({
            projectId: proj.id,
            templateKey: 'probe-m3-character',
            status: 'queued',
            input: JSON.stringify({ brief: '萌宝镖客第 1 集：角色档案同步' }),
            templateSnapshot: JSON.stringify(loadTemplate('probe-m3-character')),
            createdAt: now,
            updatedAt: now,
          })
          .returning()
      )[0]!
      engine.startRun(run.id)
      await pollCompleted(run.id)
      return run.id
    }
    const charRow = async (name: string) =>
      (await db.select().from(characters).where(and(eq(characters.projectId, proj.id), eq(characters.name, name))).limit(1))[0]
    const objCount = async (): Promise<number> => {
      const rows = (await sqlite.execute(`SELECT COUNT(*) AS n FROM characters WHERE project_id = ${proj.id}`)).rows as unknown as Array<{ n: number }>
      return Number(rows[0]!.n)
    }

    // run1：萌宝 updated（预置命中）+ 灰灰 created；定妆照 2 张挂接（shotId 精确 + 名称兜底）
    const run1Id = await startRun()
    const r1 = new Map((await stepsOf(run1Id)).map((s) => [s.stepKey, s]))
    check(['ingest', 'char_sync'].every((k) => r1.get(k)?.status === 'succeeded'), 'run1 两步全部 succeeded')
    const log1Ids = parseIds(r1.get('char_sync')!)
    check(log1Ids.length === 1 && (await assetRow(log1Ids[0]!)).purpose === 'character_log', 'run1 char_sync 产物 purpose=character_log')
    const log1 = JSON.parse(await readTextAsset(log1Ids[0]!)) as { created: string[]; updated: string[]; refAttached: number; scope: string }
    check(log1.created.join(',') === '灰灰' && log1.updated.join(',') === '萌宝', `run1 建档 created=[${log1.created}] updated=[${log1.updated}]`)
    check(log1.refAttached === 2 && log1.scope === 'project', `run1 定妆照挂接 ${log1.refAttached} 张（shotId + 名称兜底）`)
    const p1 = JSON.parse((await assetRow(log1Ids[0]!)).params ?? '{}') as { created?: number; updated?: number }
    check(p1.created === 1 && p1.updated === 1, `run1 params 徽标计数（created=${p1.created} updated=${p1.updated}）`)
    check((await objCount()) === 2, `run1 后项目域角色 2 行（实际 ${await objCount()}）`)
    const gb = await charRow('萌宝')
    const gh = await charRow('灰灰')
    check(
      gb?.refAssetIds === JSON.stringify([refB.id]) && gh?.refAssetIds === JSON.stringify([refA.id]),
      '定妆照归属正确（灰灰=shotId 精确、萌宝=资产名兜底）',
    )

    // run2：同项目再跑 → 全 updated、行数不增、挂接幂等（去重后 0 新增）
    const run2Id = await startRun()
    const r2 = new Map((await stepsOf(run2Id)).map((s) => [s.stepKey, s]))
    check(['ingest', 'char_sync'].every((k) => r2.get(k)?.status === 'succeeded'), 'run2 两步全部 succeeded')
    const log2Ids = parseIds(r2.get('char_sync')!)
    const log2 = JSON.parse(await readTextAsset(log2Ids[0]!)) as { created: string[]; updated: string[]; refAttached: number }
    check(log2.created.length === 0 && log2.updated.length === 2 && log2.refAttached === 0, 'run2 走 updated 分支（行不增、挂接去重 0 新增）')
    check((await objCount()) === 2, `run2 后项目域角色仍 2 行（实际 ${await objCount()}）`)
  }

  const sectionContract = async (): Promise<void> => {
    await initDb()
    const { validateTextOutput } = await import('../src/pipeline/actions/ai-text')
    const throwsWith = (fn: () => void, needle: string): boolean => {
      try {
        fn()
        return false
      } catch (err) {
        return (err as Error).message.includes(needle)
      }
    }

    // —— characters-json：全字段 / 剥围栏 / 最小样本通过；缺 appearance / 空数组抛错 ——
    const okChar = JSON.stringify({
      characters: [
        {
          name: '萌宝',
          appearance: '圆脸大眼、虎头帽红袄',
          aliases: ['小宝'],
          summary: '三岁半男主',
          negative: '成人化五官',
          voice: '软糯童声',
          ref_prompt: '三视图，纯白底',
        },
      ],
    })
    check(validateTextOutput(okChar, 'characters-json') === 1, 'characters-json 全字段样本通过')
    check(validateTextOutput('```json\n' + okChar + '\n```', 'characters-json') === 1, 'characters-json 剥围栏样本通过')
    check(validateTextOutput('{"characters":[{"name":"a","appearance":"b"}]}', 'characters-json') === 1, 'characters-json 最小样本（仅 name/appearance）通过')
    check(throwsWith(() => validateTextOutput('{"characters":[{"name":"萌宝"}]}', 'characters-json'), 'appearance'), '缺 appearance → 抛错（含 appearance）')
    check(throwsWith(() => validateTextOutput('{"characters":[]}', 'characters-json'), 'characters'), 'characters 空数组 → 抛错')

    // —— lines-json v2：四字段通过 / 旧样本兼容 / speaker 非字符串 / 缺 text ——
    const okLines = JSON.stringify({
      lines: [{ id: 'l1', text: '我不怕！', est_ms: 1600, speaker: '萌宝', voice_hint: '软糯童声', emotion_hint: '坚定' }],
    })
    check(validateTextOutput(okLines, 'lines-json') === 1, 'lines-json 四字段样本通过')
    check(validateTextOutput(JSON.stringify({ lines: [{ id: 'l1', text: '我不怕！', est_ms: 1600 }] }), 'lines-json') === 1, 'lines-json 旧样本向后兼容')
    check(throwsWith(() => validateTextOutput('{"lines":[{"id":"l1","text":"你好","speaker":123}]}', 'lines-json'), 'speaker'), 'speaker 非字符串 → 抛错')
    check(throwsWith(() => validateTextOutput('{"lines":[{"id":"l1"}]}', 'lines-json'), 'text'), '缺 text → 抛错')

    // —— storyboard-json 回归 ——
    check(validateTextOutput('{"shots":[{"id":"s1","image_prompt":"P1"}]}', 'storyboard-json') === 1, 'storyboard-json 合法样本通过（回归）')
    check(throwsWith(() => validateTextOutput('{"shots":[{"id":"s1"}]}', 'storyboard-json'), 'image_prompt'), '缺 image_prompt → 抛错（回归）')
  }

  const sectionTts = async (): Promise<void> => {
    await initDb()
    const { parseEmotionKey, resolveVoiceChain } = await import('../src/pipeline/actions/tts')
    const { resolveEmotionPayload } = await import('../src/services/tts')

    // —— 情绪基调词 ——
    check(parseEmotionKey('干笑——语气虚浮带躲闪，语速偏慢') === '干笑', 'parseEmotionKey 分隔符前段 → 干笑')
    check(parseEmotionKey('平平的') === '平平的', 'parseEmotionKey 无分隔符短词原样')
    check(parseEmotionKey('这是一个很长的无分隔符短语') === '这是一个很长', 'parseEmotionKey 无分隔符截前 6 字')
    check(parseEmotionKey('') === '', 'parseEmotionKey 空串 → 空')

    // —— 声线六级链 ——
    const full = { lineVoice: 'L', charVoice: 'C', paramVoice: 'P', settingsVoice: 'S', instanceVoice: 'I' }
    const r1 = resolveVoiceChain(full)
    check(r1.voice === 'L' && r1.source === 'line', '声线链 L1 line 优先')
    check(resolveVoiceChain({ ...full, lineVoice: undefined }).source === 'character', '声线链 L2 角色库')
    check(resolveVoiceChain({ charVoice: undefined, paramVoice: 'P', settingsVoice: 'S', instanceVoice: 'I' }).source === 'params', '声线链 L3 params')
    check(resolveVoiceChain({ paramVoice: undefined, settingsVoice: 'S', instanceVoice: 'I' }).source === 'settings', '声线链 L4 settings')
    check(resolveVoiceChain({ settingsVoice: undefined, instanceVoice: 'I' }).source === 'instance', '声线链 L5 实例')
    check(resolveVoiceChain({}).voice === 'alloy' && resolveVoiceChain({}).source === 'default', '声线链 L6 兑底 alloy/default')

    // —— 情绪透传载荷 ——
    const em = resolveEmotionPayload('干笑', { param: 'emotion', map: { 干笑: 'cheerful' } })
    check(em !== null && em.param === 'emotion' && em.value === 'cheerful', 'resolveEmotionPayload map 命中 → 映射值')
    check(resolveEmotionPayload('干笑', { param: 'emotion' })?.value === '干笑', 'resolveEmotionPayload 无 map → 基调词原样')
    check(resolveEmotionPayload('', { param: 'emotion' }) === null && resolveEmotionPayload('干笑', undefined) === null, 'resolveEmotionPayload 无 key/未声明 → null')
  }

  const sectionSubtitle = async (): Promise<void> => {
    await initDb()
    const { splitDisplayLines, planMeasuredSrt } = await import('../src/pipeline/actions/subtitle')
    const cp = (s: string): number => Array.from(s).length
    const span = (ls: Array<{ start_ms: number; end_ms: number }>): number => ls.reduce((s, l) => s + (l.end_ms - l.start_ms), 0)

    // —— splitDisplayLines：主切句末标点 → 次切逗号 → 硬切 ——
    const s1 = splitDisplayLines('今天天气真好。', 18)
    check(s1.length === 1 && s1[0] === '今天天气真好。', 'split 短句 1 行原样')
    const s2 = splitDisplayLines('甲'.repeat(10) + '。' + '乙'.repeat(10) + '。' + '丙'.repeat(10) + '。' + '丁'.repeat(7) + '。', 18)
    check(s2.length >= 3 && s2.every((t) => cp(t) <= 18), `split 多句号分段（${s2.length} 行，每行 ≤18）`)
    const s3 = splitDisplayLines('无'.repeat(25), 18)
    check(s3.length === 2 && cp(s3[0]!) === 18 && cp(s3[1]!) === 7, 'split 无标点硬切 18+7')
    const s4 = splitDisplayLines('前'.repeat(10) + '，' + '中'.repeat(10) + '，' + '后'.repeat(13), 18)
    check(s4.length === 3 && s4.every((t) => cp(t) <= 18), 'split 逗号次切（3 行，每行 ≤18）')

    // —— planMeasuredSrt：比例分配 / 首尾相接 / leadIn / 抛错 / 短行合并 ——
    const p1 = planMeasuredSrt([{ id: '1', text: '今天天气真好，出门走走。阳光明媚。' }], [6000])
    check(
      p1.length === 2 && span(p1) === 6000 && p1[0]!.start_ms === 0 && p1[p1.length - 1]!.end_ms === 6000,
      'measured 单句 Σ行时长=6000、首 0 末 6000',
    )
    check(p1[0]!.id === '1.1' && p1[1]!.id === '1.2' && p1[1]!.start_ms === p1[0]!.end_ms, '行 id=句id.行序 且句内首尾相接')

    const p2 = planMeasuredSrt([{ id: '1', text: '第一句。' }, { id: '2', text: '第二句。' }], [3000, 5000])
    check(p2[0]!.end_ms === 3000 && p2.find((l) => l.id.startsWith('2.'))!.start_ms === 3000, 'measured 句间首尾相接')
    check(p2[p2.length - 1]!.end_ms === 8000, 'measured 双句末行 end=8000')

    const p3 = planMeasuredSrt([{ id: '1', text: '第一句。' }, { id: '2', text: '第二句。' }], [3000, 5000], { leadInMs: 500 })
    check(p3[0]!.start_ms === 500 && p3[p3.length - 1]!.end_ms === 8500, 'measured leadIn 500 → 首行 500 / 末行 8500')

    const throwsMsg = (fn: () => void, needle: string): boolean => {
      try {
        fn()
        return false
      } catch (err) {
        return (err as Error).message.includes(needle)
      }
    }
    check(throwsMsg(() => planMeasuredSrt([{ id: '1', text: 'a' }, { id: '2', text: 'b' }], [1000]), '不一致'), '句数≠时长数 → 抛错（含不一致）')

    const p4 = planMeasuredSrt([{ id: '1', text: '好。今天天气真不错，出门走走吧。' }], [3000])
    check(p4.length === 1 && span(p4) === 3000, 'measured 短行合并（2 行→1 行、句总时长不变）')
  }

  // ================= 分发 =================

  const runners: Record<string, () => Promise<void>> = {
    migrate: sectionMigrate,
    memory: sectionMemory,
    'memory-action': sectionMemoryAction,
    character: sectionCharacter,
    contract: sectionContract,
    tts: sectionTts,
    subtitle: sectionSubtitle,
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
