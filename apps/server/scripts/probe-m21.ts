/**
 * M21 探针（工作台体验——检索·通知·键盘流）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m21.ts [--section=search|revisions|concurrency|hot-params|tags-sql|settings-kv]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录
 * （独立 studio.db + workspace），不触碰开发库（同 probe-m3~m19）。零网络、零计费：
 * 直测服务层函数与纯函数，不触发引擎执行与真实生成。
 *
 * section（默认 all；P0 骨架就绪，各节断言随 P1~P3 增补）：
 *   search        [P1] 关键词九域 LIKE/转义/数字 id + 语义降级 + 首搜索引/reindex 幂等
 *   revisions     [P2] Gate 文本产物版本链（倒序 + current 标记 + 跨 step 隔离）
 *   concurrency   [P3] 全局闸门（active ≤ max / defer 归一 queued / pump 补位 / 幂等 / 批协同重试）
 *   hot-params    [P3] 热调（深合并 / 校验 / 状态门 / _params_log 留痕 / 生效路径）
 *   tags-sql      [P1] ?tag= SQL 过滤（分页不错位 + 引号精确匹配）
 *   settings-kv   [P1] notify / concurrency 两 key 读写与默认值
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
// 清理历史残留：libsql 在 Windows 下不释放文件句柄（close 后仍 EBUSY）——本进程退出时 db 文件必留；
// 本次运行在创建自己的目录前清掉旧的（占用中则跳过，自动收敛为最多一份）。
const TMP_PREFIX = 'acs-probe-m21-'
for (const name of readdirSync(tmpdir())) {
  if (name.startsWith(TMP_PREFIX)) {
    try {
      rmSync(join(tmpdir(), name), { recursive: true, force: true })
    } catch {
      /* 占用中（并行探针）→ 跳过 */
    }
  }
}
const TMP = mkdtempSync(join(tmpdir(), TMP_PREFIX))
process.env.CSTUDIO_ROOT = REPO_ROOT
process.env.CSTUDIO_DATA = join(TMP, 'data')
process.env.CSTUDIO_WORKSPACE = join(TMP, 'workspace')
mkdirSync(process.env.CSTUDIO_DATA, { recursive: true })
mkdirSync(process.env.CSTUDIO_WORKSPACE, { recursive: true })

const SECTIONS = ['search', 'revisions', 'concurrency', 'hot-params', 'tags-sql', 'settings-kv'] as const

async function main(): Promise<void> {
  // src 模块全部动态加载（环境变量已隔离）
  const { db, initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')
  const { assets, batches, canvases, characters, episodes, pipelineRuns, pipelineSteps, projects, publications, schedules, series, settings } = await import('../src/db/schema')
  const { and, desc, eq, inArray, isNull } = await import('drizzle-orm')
  const { app } = await import('../src/app')

  const log = createLogger('probe-m21')
  let failed = 0
  const check = (cond: boolean, msg: string): void => {
    if (cond) log.info(`  PASS  ${msg}`)
    else {
      failed += 1
      log.error(`  FAIL  ${msg}`)
    }
  }

  // ---- setup：隔离库 + 种子项目 ----
  await initDb()
  const T0 = 1_700_000_000_000
  const mkProject = async (name: string): Promise<number> =>
    (
      await db
        .insert(projects)
        .values({ name, genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!.id
  const pid = await mkProject('M21 探针项目')

  const mkRun = async (status: string, input: string): Promise<number> =>
    (
      await db
        .insert(pipelineRuns)
        .values({ projectId: pid, templateKey: 'mengbao-episode', status, input, createdAt: Date.now(), updatedAt: Date.now() })
        .returning()
    )[0]!.id

  const mkAsset = async (v: { kind: string; name: string; tags?: string[]; runId?: number; stepId?: number; createdAt?: number }): Promise<number> => {
    const at = v.createdAt ?? Date.now()
    return (
      await db
        .insert(assets)
        .values({
          projectId: pid,
          kind: v.kind,
          name: v.name,
          tags: JSON.stringify(v.tags ?? []),
          runId: v.runId ?? null,
          stepId: v.stepId ?? null,
          createdAt: at,
          updatedAt: at,
        })
        .returning()
    )[0]!.id
  }

  // settings KV upsert/read（镜像 system.ts PUT /settings/:key 语义）
  const putSetting = async (key: string, value: unknown): Promise<void> => {
    const val = JSON.stringify(value)
    const existing = await db.select({ id: settings.id }).from(settings).where(eq(settings.key, key)).limit(1)
    if (existing.length) await db.update(settings).set({ value: val, updatedAt: Date.now() }).where(eq(settings.id, existing[0]!.id))
    else await db.insert(settings).values({ key, value: val, updatedAt: Date.now() })
  }
  const getSetting = async (key: string): Promise<unknown> => {
    const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1)
    return rows.length ? (JSON.parse(rows[0]!.value) as unknown) : undefined
  }

  /** app.request 内存 HTTP（零网络）：返回状态码 + JSON body */
  const jreq = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const init: RequestInit = { method }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const res = await app.request(path, init)
    let json: any = null
    try {
      json = await res.json()
    } catch {
      /* 非 JSON 响应 */
    }
    return { status: res.status, body: json }
  }

  // ================= 1. search =================

  async function sectionSearch(): Promise<void> {
    // ---- [P0] 基建：assets 语义索引两列到位（ensureSchemaColumns 兜底） ----
    const cols = await sqlite.execute("PRAGMA table_info('assets')")
    const names = new Set((cols.rows as unknown as Array<{ name: string }>).map((r) => r.name))
    check(names.has('embedding') && names.has('embedding_model'), 'assets.embedding / embedding_model 两列已建（列级兜底生效）')

    const ins = await db
      .insert(assets)
      .values({
        projectId: pid,
        kind: 'text',
        name: 'm21-骨架文本资产.md',
        createdAt: T0 + 10,
        updatedAt: T0 + 10,
        embedding: JSON.stringify([0.1, 0.2, 0.3]),
        embeddingModel: 'bge-small-zh-v1.5@512',
      })
      .returning()
    const row = (await db.select().from(assets).where(eq(assets.id, ins[0]!.id)))[0]!
    check(
      row.embeddingModel === 'bge-small-zh-v1.5@512' && JSON.parse(row.embedding ?? '[]').length === 3,
      'embedding/embedding_model 写入读回往返（JSON number[] + model tag）',
    )

    // ---- [P1] 端点：关键词九域命中矩阵（种子数据） ----
    await mkProject('晨光计划剧组')
    await mkProject('50%OFF大促')
    await mkProject('50XOFF活动')
    await mkProject('a_b命名')
    await mkProject('axb命名')
    const srun = await mkRun('completed', JSON.stringify({ prompt: '晨光下的追逐' }))
    await mkAsset({ kind: 'image', name: '晨光分镜-初稿.png' })
    await db.insert(characters).values({ name: '阿木', kind: 'character', summary: '少年游侠', createdAt: T0, updatedAt: T0 })
    await db.insert(batches).values({ projectId: pid, templateKey: 'mengbao-episode', name: '晨光批次一', createdAt: T0, updatedAt: T0 })
    await db.insert(canvases).values({ projectId: pid, name: '晨光主画布', createdAt: T0, updatedAt: T0 })
    await db.insert(publications).values({ projectId: pid, platform: 'douyin', title: '晨光预告片', url: 'https://example.com/chenguang', createdAt: T0, updatedAt: T0 })
    await db.insert(schedules).values({ projectId: pid, name: '晨光排产', templateKey: 'mengbao-episode', cronExpr: 'once', scheduledAt: T0, createdAt: T0, updatedAt: T0 })
    const [ser] = await db.insert(series).values({ projectId: pid, name: '晨光系列', createdAt: T0, updatedAt: T0 }).returning()
    await db.insert(episodes).values({ projectId: pid, seriesId: ser!.id, number: 1, title: '晨光启程', createdAt: T0, updatedAt: T0 })

    const r1 = await jreq('GET', `/api/v1/search?q=${encodeURIComponent('晨光')}`)
    check(r1.status === 200, 'GET /search 200')
    const gs1 = (r1.body?.groups ?? []) as Array<{ domain: string; items: Array<{ url: string }> }>
    const domainSet = new Set(gs1.map((g) => g.domain))
    check(
      ['projects', 'runs', 'assets', 'canvases', 'publications', 'episodes', 'batches', 'schedules'].every((d) => domainSet.has(d)),
      `八域同词全命中（${[...domainSet].join('/')}）`,
    )
    check(gs1.every((g) => g.items.every((i) => typeof i.url === 'string' && i.url.startsWith('/'))), '每条结果携带跳转 url 映射')

    const rE = await jreq('GET', `/api/v1/search?q=${encodeURIComponent('阿木')}`)
    const entItems = ((rE.body?.groups ?? []) as Array<{ domain: string; items: Array<{ title: string }> }>).find((g) => g.domain === 'entities')?.items ?? []
    check(entItems.length === 1 && entItems[0]!.title === '阿木', '实体域命中（characters.name）')

    // ---- [P1] 端点：LIKE 转义（% / _ 不误配） ----
    const rPct = await jreq('GET', `/api/v1/search?q=${encodeURIComponent('50%')}`)
    const pctNames = ((rPct.body?.groups ?? []) as Array<{ domain: string; items: Array<{ title: string }> }>).find((g) => g.domain === 'projects')?.items.map((i) => i.title) ?? []
    check(pctNames.length === 1 && pctNames[0] === '50%OFF大促', '% 转义：仅命中字面 %（50XOFF 不误配）')
    const rUnd = await jreq('GET', `/api/v1/search?q=${encodeURIComponent('a_b')}`)
    const undNames = ((rUnd.body?.groups ?? []) as Array<{ domain: string; items: Array<{ title: string }> }>).find((g) => g.domain === 'projects')?.items.map((i) => i.title) ?? []
    check(undNames.length === 1 && undNames[0] === 'a_b命名', '_ 转义：仅命中字面 _（axb 不误配）')

    // ---- [P1] 端点：数字 q / 空 q / 超长 / 不命中 ----
    const rNum = await jreq('GET', `/api/v1/search?q=${srun}`)
    const runItems = ((rNum.body?.groups ?? []) as Array<{ domain: string; items: Array<{ title: string }> }>).find((g) => g.domain === 'runs')?.items ?? []
    check(runItems.some((i) => i.title === `运行 #${srun}`), '纯数字 q：runs 按 id 精确命中')
    const rEmpty = await jreq('GET', '/api/v1/search?q=')
    check(rEmpty.status === 400 && rEmpty.body?.error?.code === 'bad_query', '空 q → 400 bad_query')
    const rLong = await jreq('GET', `/api/v1/search?q=${'a'.repeat(101)}`)
    check(rLong.status === 400 && rLong.body?.error?.code === 'bad_query', 'q >100 字符 → 400 bad_query')
    const rMiss = await jreq('GET', `/api/v1/search?q=${encodeURIComponent('不存在的词xyz')}`)
    check(rMiss.status === 200 && (rMiss.body?.groups ?? []).length === 0, '不命中 → groups 空数组（非报错）')

    // ---- [P1] 语义降级 + reindex（无模型环境） ----
    check(
      r1.body?.semantic?.available === false && r1.body?.semantic?.degraded === true && r1.body?.semantic?.hits?.length === 0,
      '无模型环境语义段降级（available:false / degraded:true / hits 空，不抛错）',
    )
    check(r1.body?.semantic?.indexing === false, '降级时 indexing:false（不触发后台索引）')
    const rRe = await jreq('POST', '/api/v1/search/reindex')
    check(
      rRe.status === 503 && rRe.body?.error?.code === 'model_unavailable' && String(rRe.body?.error?.message).includes('model:prepare'),
      'reindex 无模型 → 503 model_unavailable + model:prepare 指引',
    )
  }

  // ================= 2. revisions =================

  async function sectionRevisions(): Promise<void> {
    // ---- [P0] 基建：版本链数据源（runId+stepId+kind='text' 倒序）语义 ----
    const runId = await mkRun('waiting_input', '{}')
    const stepId = 101 // assets.stepId 无外键约束（列级关联，探针直接造数）
    const v1 = await mkAsset({ kind: 'text', name: '剧本-初版.md', runId, stepId, createdAt: T0 + 1000 })
    const v2 = await mkAsset({ kind: 'text', name: '剧本-审阅定稿.md', runId, stepId, createdAt: T0 + 2000 })
    const v3 = await mkAsset({ kind: 'text', name: '剧本-重跑.md', runId, stepId, createdAt: T0 + 3000 })
    const chainOf = async (rid: number, sid: number) =>
      db
        .select()
        .from(assets)
        .where(and(eq(assets.runId, rid), eq(assets.stepId, sid), eq(assets.kind, 'text'), isNull(assets.deletedAt)))
        .orderBy(desc(assets.createdAt))

    const chain = await chainOf(runId, stepId)
    check(chain.length === 3 && chain[0]!.id === v3 && chain[2]!.id === v1, '版本链倒序（最新在前；current 语义基座）')

    const other = await mkAsset({ kind: 'text', name: '他步产物.md', runId, stepId: 102, createdAt: T0 + 4000 })
    const chain2 = await chainOf(runId, stepId)
    check(chain2.length === 3 && !chain2.some((a) => a.id === other), '跨 step 不混入（stepId 过滤严密）')

    await db.update(assets).set({ deletedAt: T0 + 9000 }).where(eq(assets.id, v1))
    const chain3 = await chainOf(runId, stepId)
    check(chain3.length === 2 && !chain3.some((a) => a.id === v1), '软删版本不出现（deletedAt IS NULL 过滤）')

    // ---- [P2] 端点：revisions（倒序 + current 标记 + 空列表 + 404） ----
    // 端点按 runId+stepKey 定位 pipeline_steps 行 → 需真实步骤行（上段链为裸 stepId 造数，此处补真库）
    const rRun = await mkRun('waiting_input', '{}')
    const [rStep] = await db
      .insert(pipelineSteps)
      .values({ runId: rRun, seq: 1, stepKey: 'script', actionKey: 'llm_text', title: '剧本', status: 'waiting_input', createdAt: T0, updatedAt: T0 })
      .returning()
    const ra1 = await mkAsset({ kind: 'text', name: '审阅版-1.md', runId: rRun, stepId: rStep!.id, createdAt: T0 + 100 })
    await mkAsset({ kind: 'text', name: '审阅版-2.md', runId: rRun, stepId: rStep!.id, createdAt: T0 + 200 })
    const ra3 = await mkAsset({ kind: 'text', name: '审阅版-3.md', runId: rRun, stepId: rStep!.id, createdAt: T0 + 300 })
    // current 指向 output.asset_ids[0]——故意设为非最新版，验证标记独立于排序
    await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [ra1] }) }).where(eq(pipelineSteps.id, rStep!.id))

    const rRev = await jreq('GET', `/api/v1/runs/${rRun}/steps/script/revisions`)
    check(rRev.status === 200 && (rRev.body?.items ?? []).length === 3, 'GET revisions 200 + 3 版文本产物')
    check(rRev.body?.items?.[0]?.assetId === ra3 && rRev.body?.items?.[2]?.assetId === ra1, '版本链倒序（createdAt DESC：最新在前）')
    check(
      rRev.body?.items?.[0]?.current === false && rRev.body?.items?.[2]?.current === true,
      'current 标记 = step.output.asset_ids[0]（独立于排序，精确指向）',
    )
    check(
      (rRev.body?.items ?? []).every((it: { assetId?: number; name?: string; createdAt?: number }) => typeof it.assetId === 'number' && typeof it.name === 'string' && typeof it.createdAt === 'number'),
      '条目含 assetId / name / createdAt 字段',
    )

    // 无文本产物步骤 → 空列表（非 404）
    await db
      .insert(pipelineSteps)
      .values({ runId: rRun, seq: 2, stepKey: 'empty', actionKey: 'llm_text', title: '空步', status: 'pending', createdAt: T0, updatedAt: T0 })
    const rRev2 = await jreq('GET', `/api/v1/runs/${rRun}/steps/empty/revisions`)
    check(rRev2.status === 200 && Array.isArray(rRev2.body?.items) && rRev2.body.items.length === 0, '无文本产物步骤 → 空列表（非 404）')

    // run / step 不存在 → 404
    const rRev3 = await jreq('GET', '/api/v1/runs/999999/steps/script/revisions')
    check(rRev3.status === 404, 'run 不存在 → 404')
    const rRev4 = await jreq('GET', `/api/v1/runs/${rRun}/steps/nope/revisions`)
    check(rRev4.status === 404, 'stepKey 不存在 → 404')
  }

  // ================= 3. concurrency =================

  async function sectionConcurrency(): Promise<void> {
    // ---- [P0] 基建：settings 'concurrency' KV 切换（全局闸门配置存储基座） ----
    check((await getSetting('concurrency')) === undefined, '初始无 concurrency key（缺省 = 服务层默认 3 的读取前提）')
    await putSetting('concurrency', { max: 2 })
    const cv = (await getSetting('concurrency')) as { max?: number }
    check(cv.max === 2, 'concurrency KV 写入读回（{max:2}）')
    await putSetting('concurrency', { max: 5 })
    const cv2 = (await getSetting('concurrency')) as { max?: number }
    check(cv2.max === 5, 'concurrency KV 二次写入覆盖（upsert 语义）')

    // ---- [P3] 单元：resolveConcurrencyMax 读取链（settings → env → 默认 3）+ 1–6 clamp ----
    const { engine, onRunSettled, resolveConcurrencyMax, refreshGlobalConcurrency, currentGlobalMax } = await import('../src/pipeline/engine')
    await putSetting('concurrency', { max: 3 })
    check((await resolveConcurrencyMax()) === 3, 'settings {max:3} → 3（读取链命中）')
    await putSetting('concurrency', { max: 0 })
    check((await resolveConcurrencyMax()) === 1, '越界下回（max:0 → clamp 1）')
    await putSetting('concurrency', { max: 99 })
    check((await resolveConcurrencyMax()) === 6, '越界上回（max:99 → clamp 6）')
    await putSetting('concurrency', { max: 'abc' })
    check((await resolveConcurrencyMax()) === 3, '非法值回落（settings 无效 → env 未设 → 默认 3）')
    await db.delete(settings).where(eq(settings.key, 'concurrency'))
    process.env.CSTUDIO_GLOBAL_MAX_CONCURRENT = '5'
    check((await resolveConcurrencyMax()) === 5, 'settings 缺失 → env 兜底（5）')
    process.env.CSTUDIO_GLOBAL_MAX_CONCURRENT = '99'
    check((await resolveConcurrencyMax()) === 6, 'env 越界 clamp（99 → 6）')
    delete process.env.CSTUDIO_GLOBAL_MAX_CONCURRENT
    check((await resolveConcurrencyMax()) === 3, 'settings/env 均缺失 → 默认 3')

    // ---- [P3] 集成：闸门 active ≤ max / defer 归一 queued / 幂等吸收 / pumpGlobal 补位 ----
    await putSetting('concurrency', { max: 2 })
    check((await refreshGlobalConcurrency()) === 2 && currentGlobalMax() === 2, 'refresh 后缓存生效（startRun 同步闸门读取）')

    // 空模板快照 run：执行链零步骤 → 快速 completed（不触外部依赖/LLM）；batch 可选（批协同断言用）
    const mkEmptyRun = async (status: string, batch?: { batchId: number; batchSeq: number }): Promise<number> =>
      (
        await db
          .insert(pipelineRuns)
          .values({
            projectId: pid,
            templateKey: 'm21-probe-empty',
            templateSnapshot: JSON.stringify({ key: 'm21-probe-empty', version: 1, name: '探针空模板', steps: [] }),
            status,
            input: '{}',
            batchId: batch?.batchId ?? null,
            batchSeq: batch?.batchSeq ?? null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
          .returning()
      )[0]!.id

    const gateIds: number[] = []
    for (let i = 0; i < 5; i++) gateIds.push(await mkEmptyRun('queued'))
    const wId = await mkEmptyRun('waiting_input')

    // 同步段（无 await 隔断：startRun 同步占位，执行链尚未推进，断言可精确观察）
    const rets = gateIds.map((id) => engine.startRun(id))
    check(rets.filter((r) => r === 'started').length === 2, '循环 startRun：前 2 个 started（槽位未满）')
    check(rets.filter((r) => r === 'deferred').length === 3, '溢出 3 个 deferred（全局闸门 active ≤ max=2）')
    check(engine.activeCount() === 2, 'activeCount === max（同步闸门不超发）')
    check(gateIds.slice(2).every((id) => !engine.isRunning(id)), 'deferred run 未进入 active')
    check(engine.startRun(gateIds[0]!) === 'running', '重复 startRun 幂等（已在 active → running）')
    check(engine.startRun(wId) === 'deferred', 'waiting_input run 闸门已满 → deferred（不抢占在跑槽位）')

    // defer 归一：waiting_input → queued（异步写；紧轮询观察前置态——泵只挑 queued）
    let sawQueued = false
    const wDeadline = Date.now() + 5000
    while (Date.now() < wDeadline) {
      const st = (await db.select({ s: pipelineRuns.status }).from(pipelineRuns).where(eq(pipelineRuns.id, wId)).limit(1))[0]!.s
      if (st === 'queued') { sawQueued = true; break }
      if (st === 'completed') break // 极速路径：已被泵拉起走完（queued 中间态被错过）
      await new Promise((r) => setTimeout(r, 3))
    }
    check(sawQueued, 'defer 归一：waiting_input → queued（不触碰终态，供泵前置）')

    // 泵补位全链：5+1 个 run 最终全 completed（若泵失效，deferred 的将永远滞留 queued）
    const allDeadline = Date.now() + 10_000
    let allDone = false
    while (Date.now() < allDeadline) {
      const rows = await db
        .select({ s: pipelineRuns.status })
        .from(pipelineRuns)
        .where(inArray(pipelineRuns.id, [...gateIds, wId]))
      if (rows.length === gateIds.length + 1 && rows.every((r) => r.s === 'completed')) { allDone = true; break }
      await new Promise((r) => setTimeout(r, 20))
    }
    check(allDone, 'pumpGlobal 补位：deferred run 全链推进至 completed（无滞留 queued）')
    check(engine.activeCount() === 0, '收敛后 active 归零')

    // ---- [P3] 批协同：全局 run settle → 批 pump 重试（deferred 批 run 不滞留 queued；spec §2.4 两泵互补） ----
    // 镜像 index.ts 装配（settle → notifyRunSettled）——批 pump 的「重试」触发器由此就位
    const { notifyRunSettled } = await import('../src/services/batch')
    onRunSettled((id) => {
      void notifyRunSettled(id).catch(() => {})
    })

    const [bRow] = await db
      .insert(batches)
      .values({
        projectId: pid,
        templateKey: 'm21-probe-empty',
        name: '探针批（全局闸门协同）',
        status: 'running',
        schedule: JSON.stringify({ max_concurrent: 1 }),
        total: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .returning()
    const g1 = await mkEmptyRun('queued')
    const g2 = await mkEmptyRun('queued')
    const bRun1 = await mkEmptyRun('queued', { batchId: bRow!.id, batchSeq: 1 })

    // 同步块（无 await 隔断）：全局槽位占满 → 批 run defer，状态可精确断言
    check(
      [engine.startRun(g1), engine.startRun(g2)].every((r) => r === 'started') && engine.activeCount() === 2,
      '批协同：全局槽位占满（2 started + active=2）',
    )
    check(engine.startRun(bRun1) === 'deferred' && !engine.isRunning(bRun1), '批内 run 满槽 defer（滞留 queued，未进 active）')

    // 全局 run 自然 settle → settle 监听 → notifyRunSettled → pumpStalledBatches → 批 pump 重试 → bRun1 开跑
    let bDone = false
    const bDeadline = Date.now() + 8000
    while (Date.now() < bDeadline) {
      const st = (await db.select({ s: pipelineRuns.status }).from(pipelineRuns).where(eq(pipelineRuns.id, bRun1)).limit(1))[0]?.s
      if (st === 'completed') { bDone = true; break }
      await new Promise((r) => setTimeout(r, 20))
    }
    check(bDone, '全局 settle 触发批 pump 重试：deferred 批 run 最终 completed（两泵互补无滞留）')

    // 批收敛：bRun1 完成 → notifyRunSettled(batchId) → pump 终态判定
    let bBatchDone = false
    const bbDeadline = Date.now() + 3000
    while (Date.now() < bbDeadline) {
      const st = (await db.select({ s: batches.status }).from(batches).where(eq(batches.id, bRow!.id)).limit(1))[0]?.s
      if (st === 'completed') { bBatchDone = true; break }
      await new Promise((r) => setTimeout(r, 20))
    }
    check(bBatchDone, '批收敛：run 全终态 → batch completed（settle → 批 pump 终态判定）')

    // ---- [P3 补] 批间救援：批 run settle 释放槽位 → 扫描救起其它停滞批（属批分支不阻断扫描） ----
    // 场景：批 C 双 run 占满全局槽位；批 D 的 run defer 滞留 queued。
    // 缺口版（notifyRunSettled 属批分支 return）下：批 C settle 只 pump(C)，dRun1 无任何触发器 → 永久 queued → FAIL
    const [cRow] = await db
      .insert(batches)
      .values({
        projectId: pid,
        templateKey: 'm21-probe-empty',
        name: '探针批 C（settle 释放槽位）',
        status: 'running',
        schedule: JSON.stringify({ max_concurrent: 2 }),
        total: 2,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .returning()
    const [dRow] = await db
      .insert(batches)
      .values({
        projectId: pid,
        templateKey: 'm21-probe-empty',
        name: '探针批 D（等待批间救援）',
        status: 'running',
        schedule: JSON.stringify({ max_concurrent: 1 }),
        total: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .returning()
    const cRun1 = await mkEmptyRun('queued', { batchId: cRow!.id, batchSeq: 1 })
    const cRun2 = await mkEmptyRun('queued', { batchId: cRow!.id, batchSeq: 2 })
    const dRun1 = await mkEmptyRun('queued', { batchId: dRow!.id, batchSeq: 1 })

    // 同步块（无 await 隔断）：批 C 双 run 占满全局 → 批 D 的 run defer
    check(
      [engine.startRun(cRun1), engine.startRun(cRun2)].every((r) => r === 'started') && engine.activeCount() === 2,
      '批间救援：批 C 双 run 占满全局（2 started + active=2）',
    )
    check(engine.startRun(dRun1) === 'deferred' && !engine.isRunning(dRun1), '批 D run 满槽 defer（滞留 queued，未进 active）')

    // cRun1/cRun2 自然 settle → notifyRunSettled（属批）→ pump(C) + 扫描停滞批 → pump(D) → dRun1 开跑
    let dDone = false
    const dDeadline = Date.now() + 8000
    while (Date.now() < dDeadline) {
      const st = (await db.select({ s: pipelineRuns.status }).from(pipelineRuns).where(eq(pipelineRuns.id, dRun1)).limit(1))[0]?.s
      if (st === 'completed') {
        dDone = true
        break
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    check(dDone, '批间救援：批 C settle → 扫描救起批 D 的 deferred run（缺口版永久滞留）')

    // 批 D 收敛：dRun1 settle → notifyRunSettled → pump(D) 终态判定
    let dBatchDone = false
    const ddDeadline = Date.now() + 3000
    while (Date.now() < ddDeadline) {
      const st = (await db.select({ s: batches.status }).from(batches).where(eq(batches.id, dRow!.id)).limit(1))[0]?.s
      if (st === 'completed') {
        dBatchDone = true
        break
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    check(dBatchDone, '批 D 收敛：run 全终态 → batch completed')

    // 恢复 key（settings-kv 节断言 GET /settings 含 concurrency）
    await putSetting('concurrency', { max: 3 })
  }

  // ================= 4. hot-params =================

  async function sectionHotParams(): Promise<void> {
    // ---- [P0] 基建：run.input JSON 读写往返（_params/_params_log 存储基座） ----
    const runId = await mkRun('running', JSON.stringify({ template: 'x', _params: { image: { model: 'm1', size: '1024x1024' } } }))
    const before = JSON.parse((await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)))[0]!.input) as {
      template: string
      _params: Record<string, Record<string, unknown>>
      _params_log?: Array<{ at: number; changes: Array<{ group: string; key: string; from: unknown; to: unknown }>; source: string }>
    }
    check(before._params.image!.model === 'm1', 'run.input._params 读取（JSON 往返保真）')

    // 深合并 + 留痕写回（模拟端点写回路径）
    const merged = { ...before, _params: { ...before._params, image: { ...before._params.image, model: 'm2' } } }
    const plog = merged._params_log ?? []
    plog.push({ at: Date.now(), changes: [{ group: 'image', key: 'model', from: 'm1', to: 'm2' }], source: 'user' })
    merged._params_log = plog
    await db.update(pipelineRuns).set({ input: JSON.stringify(merged), updatedAt: Date.now() }).where(eq(pipelineRuns.id, runId))

    const after = JSON.parse((await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)))[0]!.input) as typeof before
    check(after._params.image!.model === 'm2' && after._params.image!.size === '1024x1024', '深合并写回（改 model 保留 size）')
    check(after._params_log!.length === 1 && after._params_log![0]!.changes[0]!.from === 'm1', '_params_log 追加（from/to 留痕）')
    check(after.template === 'x', 'input 其他键逐字保留')

    // ---- [P3] 端点：PATCH /runs/:id/params（深合并 / 白名单 400 / 状态门 409 / 留痕 / 生效路径） ----
    const { readRunParams } = await import('../src/services/run-params')
    const hRun = await mkRun('running', JSON.stringify({ template: 'x', _params: { image: { model: 'm1', size: '1024x1024' }, llm: { temperature: 0.7 } } }))

    const h1 = await jreq('PATCH', `/api/v1/runs/${hRun}/params`, { params: { image: { model: 'm2' } } })
    check(h1.status === 200 && (h1.body?.applied ?? []).length === 1, 'PATCH 200 + applied 1 项（仅变化键）')
    const c0 = h1.body?.applied?.[0] ?? {}
    check(c0.group === 'image' && c0.key === 'model' && c0.from === 'm1' && c0.to === 'm2', 'applied 条目含 group/key/from/to')
    const hRow = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, hRun)))[0]!
    const hInput = JSON.parse(hRow.input) as {
      template: string
      _params: Record<string, Record<string, unknown>>
      _params_log: Array<{ at: number; changes: Array<{ group: string; key: string; from: unknown; to: unknown }>; source: string }>
    }
    check(hInput._params.image!.model === 'm2' && hInput._params.image!.size === '1024x1024', '深合并写回（改 model 保留 size）')
    check(hInput._params.llm!.temperature === 0.7, '未提交的组保留原值')
    check(
      hInput._params_log.length === 1 &&
        hInput._params_log[0]!.source === 'user' &&
        hInput._params_log[0]!.changes[0]!.from === 'm1' &&
        hInput._params_log[0]!.changes[0]!.to === 'm2',
      '_params_log 追加 {at, changes:[{group,key,from,to}], source:user}',
    )
    check(hInput.template === 'x', 'input 其他键逐字保留')
    check(readRunParams(hRow.input).image?.model === 'm2', 'readRunParams 生效路径读到新值（未执行步骤将采用）')

    // 越界数字 clamp / 非法值 400 / 未知键 400（白名单）
    const h2 = await jreq('PATCH', `/api/v1/runs/${hRun}/params`, { params: { llm: { temperature: 9 } } })
    check(h2.status === 200 && h2.body?.applied?.[0]?.to === 2, '越界数字 clamp（temperature 9 → 2）')
    const h3 = await jreq('PATCH', `/api/v1/runs/${hRun}/params`, { params: { image: { size: 'not-a-size' } } })
    check(h3.status === 400 && h3.body?.error?.code === 'bad_params', '非法取值 → 400 bad_params（格式校验）')
    const h4 = await jreq('PATCH', `/api/v1/runs/${hRun}/params`, { params: { image: { bogus: 'x' } } })
    check(h4.status === 400 && h4.body?.error?.code === 'bad_params', '未知键 → 400 bad_params（字段白名单）')
    const h4b = await jreq('PATCH', `/api/v1/runs/${hRun}/params`, { params: { nope: { a: 1 } } })
    check(h4b.status === 400 && h4b.body?.error?.code === 'bad_params', '未知组 → 400 bad_params（分组白名单）')

    // 无变化提交 → 幂等（applied 空 + 不追留痕）
    const h5 = await jreq('PATCH', `/api/v1/runs/${hRun}/params`, { params: { image: { model: 'm2' } } })
    const hRow2 = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, hRun)))[0]!
    const logLen = (JSON.parse(hRow2.input) as { _params_log: unknown[] })._params_log.length
    check(h5.status === 200 && (h5.body?.applied ?? []).length === 0 && logLen === 2, '无变化提交：applied 空且不追加留痕（幂等）')

    // 状态门：终态 409 / 不存在 404
    const hDone = await mkRun('completed', '{}')
    const h6 = await jreq('PATCH', `/api/v1/runs/${hDone}/params`, { params: { llm: { temperature: 1 } } })
    check(h6.status === 409 && h6.body?.error?.code === 'run_settled', '终态 run → 409 run_settled')
    const h7 = await jreq('PATCH', '/api/v1/runs/999999/params', { params: { llm: { temperature: 1 } } })
    check(h7.status === 404, 'run 不存在 → 404')
  }

  // ================= 5. tags-sql =================

  async function sectionTagsSql(): Promise<void> {
    // ---- [P0] 基建：tags JSON 数组 + SQL 精确成员匹配（json_each；分页不错位基座） ----
    const t1 = await mkAsset({ kind: 'image', name: '打标-1.png', tags: ['风景', '夜景'], createdAt: T0 + 100 })
    await mkAsset({ kind: 'image', name: '打标-2.png', tags: ['夜景'], createdAt: T0 + 200 })
    await mkAsset({ kind: 'image', name: '打标-3.png', tags: ['人像'], createdAt: T0 + 300 })

    // 与端点等价 SQL：LIMIT 1 OFFSET 0 必须命中匹配行（旧内存过滤会拿到第一条非匹配行——分页错位）
    const JSON_EQ = 'json_valid(tags) AND EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?) AND deleted_at IS NULL'
    const q1 = await sqlite.execute({
      sql: `SELECT id FROM assets WHERE ${JSON_EQ} ORDER BY id LIMIT 1 OFFSET 0`,
      args: ['夜景'],
    })
    const ids = (q1.rows as unknown as Array<{ id: number }>).map((r) => r.id)
    check(ids.length === 1 && ids[0] === t1, 'SQL 层 tag 过滤 + LIMIT 1 命中即匹配行（修复内存过滤分页错位）')

    const q2 = await sqlite.execute({ sql: `SELECT id FROM assets WHERE ${JSON_EQ}`, args: ['夜景'] })
    check((q2.rows as unknown as unknown[]).length === 2, 'JSON 精确成员匹配（"夜景" 命中 2 行）')

    const q3 = await sqlite.execute({ sql: `SELECT id FROM assets WHERE ${JSON_EQ}`, args: ['夜'] })
    check((q3.rows as unknown as unknown[]).length === 0, '成员级匹配防子串误配（"夜" ≠ "夜景"）')

    // ---- [P1] 端点：?tag= SQL 过滤与分页（独立项目；4 行 = 夜景×3 + 人像×1） ----
    const tp = await mkProject('M21 tags 项目')
    const mkTagAsset = async (name: string, tags: string[], at: number): Promise<number> =>
      (await db.insert(assets).values({ projectId: tp, kind: 'image', name, tags: JSON.stringify(tags), createdAt: at, updatedAt: at }).returning())[0]!.id
    const a1 = await mkTagAsset('tag-1.png', ['风景', '夜景'], T0 + 501)
    await mkTagAsset('tag-2.png', ['夜景'], T0 + 502)
    await mkTagAsset('tag-3.png', ['人像'], T0 + 503)
    const a4 = await mkTagAsset('tag-4.png', ['夜景', "主角's线"], T0 + 504)

    const rT1 = await jreq('GET', `/api/v1/projects/${tp}/assets?tag=${encodeURIComponent('夜景')}&limit=2&offset=0`)
    check(rT1.status === 200 && rT1.body.items.length === 2 && rT1.body.total === 3, 'tag=夜景 limit=2 → 2 条匹配且 total=3（total 与过滤同源）')
    const rT2 = await jreq('GET', `/api/v1/projects/${tp}/assets?tag=${encodeURIComponent('夜景')}&limit=2&offset=2`)
    check(rT2.body.items.length === 1 && rT2.body.items[0].id === a1, 'offset=2 → 恰余第 3 条匹配（分页不错位核心断言）')
    const rT3 = await jreq('GET', `/api/v1/projects/${tp}/assets?tag=${encodeURIComponent("主角's线")}`)
    check(rT3.body.items.length === 1 && rT3.body.items[0].id === a4, '中文 + 单引号 tag 正常命中（参数绑定无注入面）')
    const rT4 = await jreq('GET', `/api/v1/projects/${tp}/assets?tag=${encodeURIComponent('不存在')}`)
    check(rT4.body.items.length === 0 && rT4.body.total === 0, '无匹配 tag → 空列表 + total=0')

    // ---- [P1 补] json_each 精确成员匹配：LIKE 方案三类缺陷场景（含引号漏查/反斜杠漏查/跨元素拼接串误配） ----
    const tp2 = await mkProject('M21 tags 精确匹配项目')
    const mk2 = async (name: string, tags: string[], at: number): Promise<number> =>
      (await db.insert(assets).values({ projectId: tp2, kind: 'image', name, tags: JSON.stringify(tags), createdAt: at, updatedAt: at }).returning())[0]!.id
    const b1 = await mk2('tagq-1.png', ['say"hi'], T0 + 601)
    const b2 = await mk2('tagq-2.png', ['back\\slash'], T0 + 602)
    await mk2('tagq-3.png', ['夜景', '人像'], T0 + 603)

    const rQ1 = await jreq('GET', `/api/v1/projects/${tp2}/assets?tag=${encodeURIComponent('say"hi')}`)
    check(rQ1.body.items.length === 1 && rQ1.body.items[0].id === b1, '含双引号 tag 精确命中（LIKE 引号包裹式必漏查）')
    const rQ2 = await jreq('GET', `/api/v1/projects/${tp2}/assets?tag=${encodeURIComponent('back\\slash')}`)
    check(rQ2.body.items.length === 1 && rQ2.body.items[0].id === b2, '含反斜杠 tag 精确命中（LIKE 转义与 JSON 转义不对齐必漏查）')
    const rQ3 = await jreq('GET', `/api/v1/projects/${tp2}/assets?tag=${encodeURIComponent('夜景","人像')}`)
    check(rQ3.body.items.length === 0 && rQ3.body.total === 0, '跨元素拼接串零命中（LIKE 子串式必误配 ["夜景","人像"]）')
  }

  // ================= 6. settings-kv =================

  async function sectionSettingsKv(): Promise<void> {
    // ---- [P0] 基建：notify key 读写往返（通知开关存储基座） ----
    check((await getSetting('notify')) === undefined, '初始无 notify key（缺省 = 服务层默认全开的前提）')
    await putSetting('notify', { enabled: true, run_terminal: true, gate: true, batch: true })
    const nv = (await getSetting('notify')) as { enabled?: boolean; gate?: boolean }
    check(nv.enabled === true && nv.gate === true, 'notify KV 写入读回（四开关结构）')

    // ---- [P1] 端点：GET /settings 可见探针写入（KV 表就绪） ----
    const rSet = await jreq('GET', '/api/v1/settings')
    const keys = ((rSet.body?.items ?? []) as Array<{ key: string }>).map((it) => it.key)
    check(rSet.status === 200 && keys.includes('notify') && keys.includes('concurrency'), 'GET /settings 含 notify / concurrency 两 key（PUT 端点先例可用）')

    // ---- [P3 补] PUT /settings/:key 端点：concurrency 即改即生效（刷新引擎内存缓存；原先仅启动时载入） ----
    const { currentGlobalMax } = await import('../src/pipeline/engine')
    const rPut = await jreq('PUT', '/api/v1/settings/concurrency', { max: 4 })
    check(rPut.status === 200 && currentGlobalMax() === 4, 'PUT concurrency → 引擎缓存即时刷新（无需重启）')
    const rPut2 = await jreq('PUT', '/api/v1/settings/concurrency', { max: 3 })
    check(rPut2.status === 200 && currentGlobalMax() === 3, '恢复默认 3（缓存同步回落）')
  }

  // ================= 分发 =================

  const runners: Record<string, () => Promise<void>> = {
    search: sectionSearch,
    revisions: sectionRevisions,
    concurrency: sectionConcurrency,
    'hot-params': sectionHotParams,
    'tags-sql': sectionTagsSql,
    'settings-kv': sectionSettingsKv,
  }
  const arg = process.argv.find((a) => a.startsWith('--section='))
  const wanted = arg ? arg.slice('--section='.length) : 'all'
  if (wanted !== 'all' && !(SECTIONS as readonly string[]).includes(wanted)) {
    log.error(`未知 section：${wanted}（已实现：${SECTIONS.join(' / ')}；all = 全部）`)
    process.exitCode = 1
    return
  }

  try {
    for (const name of (wanted === 'all' ? SECTIONS : [wanted]) as readonly string[]) {
      console.log(`\n──── section: ${name} ────`)
      await runners[name]!()
    }
  } catch (err) {
    failed += 1
    console.error(`\n探针异常终止: ${(err as Error).stack ?? err}`)
  } finally {
    console.log(`\n==== M21 探针结果: ${failed > 0 ? `${failed} 项失败` : '全部通过'} ====`)
    try {
      sqlite.close() // 释放 db 连接（Windows 下句柄可能仍被 libsql 持有 → 失败不阻断）
    } catch {
      /* 已关闭或未初始化 */
    }
    try {
      rmSync(TMP, { recursive: true, force: true })
    } catch {
      console.log(`临时目录未完全清理（Windows libsql 句柄；下次运行自动清理）: ${TMP}`)
    }
    process.exitCode = failed > 0 ? 1 : 0
  }
}

void main()
