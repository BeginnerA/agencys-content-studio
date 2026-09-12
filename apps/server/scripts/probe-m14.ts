/**
 * M14 探针（平台层：集级参数覆盖 / 剧集实体 / Web 静态托管）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m14.ts [--section=params|series|static|regression]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE / CSTUDIO_WEB_DIST 指向一次性临时目录
 * （独立 studio.db + workspace + webdist），不触碰开发库（同 probe-m3~m13）。LLM 假端点 + globalThis.fetch
 * stub 兜底（零网络、零计费）。M14 四节均不真跑流水线：HTTP POST /runs 前将 engine.startRun 置空
 * （实例属性覆盖），只验创建链路、_params 快照与剧集联动回写。模板文件从仓库 workspace/templates
 * 复制进隔离目录（loadTemplate 读隔离 TEMPLATES_DIR）。
 *
 * section（默认 all）：
 *   params     validateRunParams 矩阵（分组/字段/类型/尺寸正则/resolution 枚举/clamp/空值剔除/未知键）+
 *              normalizeRunParamsOrThrow 严格抛错 + readRunParams 容错（坏 JSON/非法静默忽略/读侧 clamp）+
 *              prepareRunInput（_params 保留快照 / 非法 → bad_params / 全空省略 / 未知输入键仍静默丢弃 /
 *              参数校验先于输入校验）+ HTTP 真链路 400/202 + createStepContext 三层叠加（run > 项目 > 模板；
 *              无 _params 逐字等价旧行为；坏快照容错）
 *   series     剧集实体 HTTP 全链：建剧（1..N 集行 / name·total 校验 / 资产归属 / 一项目一剧 409）+
 *              派生 status（无 run=行值 / 悬挂 runId 回落 / queued run 优先）+ 集编辑（title/status 白名单/
 *              资产归属/bad_patch/404）+ 扩容缩容（409 episode_in_use / 缺号不重建）+ 删除边界 +
 *              mapRunToEpisode 四分支直测 + HTTP 建 run 联动回写 latest_run_id + _params 入快照 +
 *              宽容降级（无剧/无集行 → 202 不阻断）
 *   static     Web 静态托管：命中文件 MIME / SPA 深链回退 / /api 前缀 JSON 404 优先 / 目录不命中回退 /
 *              穿越防护（%2e%2e、%2f 编码、反斜杠、非法编码等向量均不泄露 dist 外文件）
 *   regression probe:m7 / m8 / m10 / m11 / m12 / m13 子进程全绿
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Asset, PipelineRun, PipelineStep } from '../src/db/schema'
import type { Template, TemplateStepDef } from '../src/pipeline/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
// 清理历史残留：libsql 在 Windows 下不释放文件句柄（close 后仍 EBUSY）——本进程退出时 db 文件必留；
// 本次运行在创建自己的目录前清掉旧的（占用中则跳过，自动收敛为最多一份）。
const TMP_PREFIX = 'acs-probe-m14-'
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
process.env.CSTUDIO_WEB_DIST = join(TMP, 'webdist')
// LLM 假端点（globalThis.fetch stub 拦截，不外发）；env.ts 在模块加载时读取 → 必须先行设置。
// dotenv 不覆盖已存在环境变量（仓库 .env 即使有真配置也不生效）。
process.env.AGENT_LLM_BASE_URL = 'http://probe-m14.local/v1'
process.env.AGENT_LLM_API_KEY = 'probe-key'
process.env.AGENT_LLM_MODEL = 'probe-model-m14'
mkdirSync(process.env.CSTUDIO_DATA, { recursive: true })
mkdirSync(process.env.CSTUDIO_WORKSPACE, { recursive: true })

// ---- 静态托管预置：env 模块加载时固化 WEB_DIST、app 模块加载时 existsSync 判定 → 必须先建 dist ----
const WEBDIST = process.env.CSTUDIO_WEB_DIST
const INDEX_HTML = '<!doctype html><html><head><title>ACS M14 Probe</title></head><body><div id="app">ACS-M14-PROBE-INDEX</div></body></html>'
const APP_JS = 'window.__M14_PROBE__ = "M14_PROBE_JS"\n'
mkdirSync(join(WEBDIST, 'assets'), { recursive: true })
writeFileSync(join(WEBDIST, 'index.html'), INDEX_HTML)
writeFileSync(join(WEBDIST, 'assets', 'app.js'), APP_JS)
writeFileSync(join(WEBDIST, 'favicon.png'), 'PROBE-PNG-BYTES')
// dist 外机密文件（穿越防护断言其内容不泄露）
const SECRET = 'M14-TOP-SECRET-9f3a2c'
writeFileSync(join(TMP, 'secret.txt'), SECRET)

const SECTIONS = ['params', 'series', 'static', 'regression'] as const

// ---- fetch stub：录制请求 + 可编程响应（M14 无真实 LLM 调用，作为兜底安全网）----
let stubReply: () => { status: number; body: unknown } = () => ({ status: 200, body: {} })
const stubFetch = (async (): Promise<Response> => {
  const r = stubReply()
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

async function main(): Promise<void> {
  const origFetch = globalThis.fetch
  globalThis.fetch = stubFetch

  // src 模块全部动态加载（环境变量已隔离）
  const { db, initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')
  const { episodes, pipelineRuns, projects } = await import('../src/db/schema')
  const { importFiles } = await import('../src/services/storage')
  const { engine } = await import('../src/pipeline/engine')
  const { app } = await import('../src/app')

  // 模板文件就位（隔离 workspace；run 创建链路 loadTemplateOrThrow 读隔离 TEMPLATES_DIR）
  const TPL_SRC = join(REPO_ROOT, 'workspace', 'templates')
  const TPL_DST = join(process.env.CSTUDIO_WORKSPACE!, 'templates')
  mkdirSync(TPL_DST, { recursive: true })
  for (const f of readdirSync(TPL_SRC)) {
    if (/\.ya?ml$/.test(f)) cpSync(join(TPL_SRC, f), join(TPL_DST, f))
  }

  // HTTP POST /runs 会触发 engine 真跑流水线 → 实例属性覆盖为 no-op（只验创建链路/快照/联动回写）
  engine.startRun = () => {}

  const log = createLogger('probe-m14')
  let failed = 0
  const check = (cond: boolean, msg: string): void => {
    if (cond) log.info(`  PASS  ${msg}`)
    else {
      failed += 1
      log.error(`  FAIL  ${msg}`)
    }
  }
  const errOf = async (fn: () => Promise<unknown>): Promise<unknown> => {
    try {
      await fn()
      return null
    } catch (err) {
      return err
    }
  }

  // ---- setup：隔离库 + 种子工厂 ----
  await initDb()
  const T0 = 1_700_000_000_000

  const mkProject = async (name: string, settings = '{}', templateKey = 'mengbao-episode'): Promise<number> =>
    (
      await db
        .insert(projects)
        .values({ name, genre: 'other', templateKey, settings, tags: '[]', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!.id
  /** 真图资产（真实文件落盘；同名不同内容自动区分 sha256） */
  const mkImage = async (pid: number, name: string): Promise<Asset> =>
    (await importFiles(pid, [{ name, data: new TextEncoder().encode(`probe-m14-img:${pid}:${name}`) }], { purpose: 'reference_scene' }))[0]!

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
  /** 从剧集列表出参中取指定集号 */
  const epOf = (body: any, n: number): any =>
    (Array.isArray(body?.episodes) ? body.episodes : []).find((e: any) => e.number === n)

  // ================= sections =================

  /** ① params：集级参数覆盖（校验矩阵 + run 链路 + context 三层叠加） */
  const sectionParams = async (): Promise<void> => {
    const { validateRunParams, normalizeRunParamsOrThrow, readRunParams, RunParamsError } =
      await import('../src/services/run-params')
    const { prepareRunInput, InvalidRunInputError } = await import('../src/services/run-create')
    const { createStepContext } = await import('../src/pipeline/context')

    // ---- validateRunParams 矩阵 ----
    check(validateRunParams(undefined).errors.length === 0 && Object.keys(validateRunParams(undefined).params).length === 0, '缺省 → {} 无错')
    check(validateRunParams(null).errors.length === 0, 'null → 无错')
    check(validateRunParams('x').errors.length === 1, '非对象 → 错误')
    check(validateRunParams([]).errors.length === 1, '数组 → 错误（需为对象）')
    check(validateRunParams({ nope: {} }).errors[0]!.includes('不是可覆盖分组'), '未知分组 → 错误')
    check(validateRunParams({ image: [] }).errors[0]!.includes('需为对象'), 'image 数组 → 错误')
    check(validateRunParams({ image: null }).errors.length === 0, 'image null → 忽略')
    check(validateRunParams({ image: { size: '832x1248' } }).params.image!.size === '832x1248', 'image.size 合法')
    check(validateRunParams({ image: { size: ' 832X1248 ' } }).params.image!.size === '832X1248', 'image.size trim + 大小写 X')
    check(validateRunParams({ image: { size: 'abc' } }).errors[0]!.includes('宽x高'), 'image.size 非法 → 错误（含提示）')
    check(validateRunParams({ image: { provider: '  openai  ' } }).params.image!.provider === 'openai', 'image.provider trim')
    check(validateRunParams({ image: { provider: '' } }).params.image === undefined, '空串剔除 → 组省略')
    check(validateRunParams({ image: { unknown_key: 'x' } }).errors.length === 1, '未知字段 → 错误')
    check(validateRunParams({ video: { resolution: '720p' } }).params.video!.resolution === '720p', 'video.resolution 720p 合法')
    check(validateRunParams({ video: { resolution: '720P' } }).params.video!.resolution === '720P', 'video.resolution 720P 合法（大小写）')
    check(validateRunParams({ video: { resolution: '360p' } }).errors.length === 1, 'video.resolution 非法 → 错误')
    check(validateRunParams({ video: { duration: 0 } }).params.video!.duration === 1, 'video.duration clamp 下限 1')
    check(validateRunParams({ video: { duration: 99 } }).params.video!.duration === 30, 'video.duration clamp 上限 30')
    check(validateRunParams({ video: { duration: 'abc' } }).errors.length === 1, 'video.duration 非数 → 错误')
    check(validateRunParams({ llm: { temperature: 3 } }).params.llm!.temperature === 2, 'llm.temperature clamp 2')
    check(validateRunParams({ llm: { temperature: -1 } }).params.llm!.temperature === 0, 'llm.temperature clamp 0')
    check(validateRunParams({ llm: { max_tokens: 100 } }).params.llm!.max_tokens === 256, 'llm.max_tokens clamp 256')
    check(validateRunParams({ llm: { max_tokens: 99999999 } }).params.llm!.max_tokens === 65536, 'llm.max_tokens clamp 65536')
    check(validateRunParams({ llm: { max_tokens: 300.7 } }).params.llm!.max_tokens === 301, 'llm.max_tokens 取整')
    check(validateRunParams({ llm: { max_tokens: '4096' } }).params.llm!.max_tokens === 4096, 'llm.max_tokens 数字字符串归一')
    check(validateRunParams({ audio: { voice: ' zh-CN-Xiaoxiao ' } }).params.audio!.voice === 'zh-CN-Xiaoxiao', 'audio.voice trim')
    check(Object.keys(validateRunParams({ audio: {} }).params).length === 0, '空组对象 → 不写入')

    // ---- normalizeRunParamsOrThrow / readRunParams ----
    check(JSON.stringify(normalizeRunParamsOrThrow({ llm: { temperature: 1.5 } })) === '{"llm":{"temperature":1.5}}', '严格模式：合法透传')
    const thrown = await errOf(async () => normalizeRunParamsOrThrow({ llm: { temperature: 'x' } }))
    check(thrown instanceof RunParamsError, '严格模式：非法 → RunParamsError')
    check(JSON.stringify(readRunParams('{"_params":{"image":{"size":"832x1248"}}}')) === '{"image":{"size":"832x1248"}}', 'readRunParams 正常解析')
    check(Object.keys(readRunParams('not-json')).length === 0, 'readRunParams 坏 JSON → {}')
    check(Object.keys(readRunParams(null)).length === 0, 'readRunParams null → {}')
    check(Object.keys(readRunParams('{}')).length === 0, 'readRunParams 缺键 → {}')
    check(Object.keys(readRunParams('{"_params":{"bad":{}}}')).length === 0, 'readRunParams 非法分组 → 静默 {}')
    check(readRunParams('{"_params":{"llm":{"temperature":3}}}').llm?.temperature === 2, 'readRunParams 读侧亦 clamp（不可信快照）')

    // ---- prepareRunInput（手工最小模板）----
    const tpl = {
      key: 'probe-m14',
      version: 1,
      name: '探针模板',
      genre: 'other',
      inputs: [
        { key: 'brief', label: '简报', kind: 'text', required: true },
        { key: 'episode_number', kind: 'int', required: false },
      ],
      steps: [],
    } as unknown as Template
    const p1 = prepareRunInput(tpl, { brief: 'b', _params: { llm: { temperature: 1.25 } } })
    check(p1.brief === 'b' && (p1['_params'] as any).llm.temperature === 1.25, '_params 保留进快照')
    check(!('episode_number' in p1), '未声明输入键不落快照')
    const p2 = prepareRunInput(tpl, { brief: 'b' })
    check(!('_params' in p2), '无 _params → 不写键（逐字等价旧行为）')
    const p3 = prepareRunInput(tpl, { brief: 'b', _params: { image: { size: '' } } })
    check(!('_params' in p3), '全空值 _params → 省略键')
    const p4 = prepareRunInput(tpl, { brief: 'b', unknown: 'x' })
    check(!('unknown' in p4), '未知输入键 → 静默丢弃（M4 口径不变）')
    const p5 = await errOf(async () => prepareRunInput(tpl, { brief: 'b', _params: { llm: { temperature: 'x' } } }))
    check(p5 instanceof InvalidRunInputError && p5.code === 'bad_params', '非法 _params → InvalidRunInputError(bad_params)')
    const p6 = await errOf(async () => prepareRunInput(tpl, { _params: { llm: { temperature: 'x' } } }))
    check(p6 instanceof InvalidRunInputError && p6.code === 'bad_params', '缺必填 + 非法 _params → 先报 bad_params（参数先行）')
    const p7 = await errOf(async () => prepareRunInput(tpl, {}))
    check(p7 instanceof InvalidRunInputError && p7.code === 'bad_input', '缺必填 → bad_input')

    // ---- HTTP 真链路：参数非法 400 / 合法 202 快照 ----
    const pidP = await mkProject('M14 探针项目 P（参数）')
    const hb1 = await jreq('POST', `/api/v1/projects/${pidP}/runs`, { template_key: 'video-plan', input: { genre: 'x', _params: { image: { size: 'nope' } } } })
    check(hb1.status === 400 && hb1.body?.error?.code === 'bad_params', `HTTP 非法 image.size → 400 bad_params（${hb1.status}）`)
    const hb2 = await jreq('POST', `/api/v1/projects/${pidP}/runs`, { template_key: 'video-plan', input: { genre: 'x', _params: { video: { resolution: '1440p' } } } })
    check(hb2.status === 400 && hb2.body?.error?.code === 'bad_params', 'HTTP resolution 1440p → 400 bad_params')
    const runCountBefore = (await db.select().from(pipelineRuns)).length
    const hOk = await jreq('POST', `/api/v1/projects/${pidP}/runs`, { template_key: 'video-plan', input: { genre: 'x', _params: { video: { resolution: '1080p', duration: 99 }, llm: { temperature: 1.5 } } } })
    check(hOk.status === 202, `HTTP 合法 _params → 202（${hOk.status}）`)
    const snap = hOk.body?.run?.input?._params
    check(snap?.video?.duration === 30 && snap?.video?.resolution === '1080p' && snap?.llm?.temperature === 1.5, '快照为 clamp 后值')
    const runCountAfter = (await db.select().from(pipelineRuns)).length
    check(runCountAfter === runCountBefore + 1, `400 两连不建 run 行（${runCountBefore} → ${runCountAfter}，仅合法 +1）`)

    // ---- createStepContext 三层叠加（run > 项目 > 模板）----
    const ctxTpl = {
      key: 'probe-m14-ctx',
      version: 1,
      name: '探针上下文模板',
      genre: 'other',
      inputs: [],
      defaults: { image: { provider: 'tpl-p', model: 'tpl-m', size: '1024x1024' }, llm: { temperature: 0.8 } },
      steps: [],
    } as unknown as Template
    const ctxDef = { key: 'probe-step', action: 'noop', title: '探针步骤', inputs: {} } as unknown as TemplateStepDef
    const ctxStep = { id: 1, runId: 990001, key: 'probe-step', status: 'running' } as unknown as PipelineStep
    const mkRunLike = (input: Record<string, unknown>): PipelineRun =>
      ({
        id: 990001,
        projectId: 990001,
        templateKey: 'probe-m14-ctx',
        status: 'queued',
        currentStepKey: null,
        input: JSON.stringify(input),
        templateSnapshot: null,
        summary: null,
        error: null,
        batchId: null,
        batchSeq: null,
        createdAt: 0,
        updatedAt: 0,
      }) as unknown as PipelineRun
    const ctxOf = (runInput: Record<string, unknown>) =>
      createStepContext({
        run: mkRunLike(runInput),
        step: ctxStep,
        template: ctxTpl,
        def: ctxDef,
        input: {},
        projectSettings: { image: { provider: 'proj-p' }, llm: { temperature: 0.5 } },
      })
    const ctxRun = await ctxOf({ _params: { image: { provider: 'run-p', size: '832x1248' }, video: { resolution: '720p' } } })
    check(
      JSON.stringify(ctxRun.settings.image) === JSON.stringify({ provider: 'run-p', model: 'tpl-m', size: '832x1248' }),
      `三层叠加：run > 项目 > 模板 逐键取最高优先（${JSON.stringify(ctxRun.settings.image)}）`,
    )
    check(ctxRun.settings.llm?.temperature === 0.5, '项目 settings 覆盖模板 defaults')
    check(JSON.stringify(ctxRun.settings.video) === JSON.stringify({ resolution: '720p' }), 'run 独有组 → 仅 run 键')
    check(JSON.stringify(ctxRun.settings.audio) === '{}', '三层全缺组 → {}')
    const ctxNone = await ctxOf({})
    check(
      JSON.stringify(ctxNone.settings.image) === JSON.stringify({ ...(ctxTpl.defaults!.image as object), provider: 'proj-p' }),
      '无 _params：逐字等价旧行为（模板 defaults + 项目覆盖）',
    )
    const ctxBad = await ctxOf({ _params: { image: { size: 'nope' } } })
    check(
      JSON.stringify(ctxBad.settings.image) === JSON.stringify({ provider: 'proj-p', model: 'tpl-m', size: '1024x1024' }),
      '坏 _params 快照 → 静默忽略（容错）',
    )
  }

  /** ② series：剧集实体全链（HTTP + 服务直测 + run 联动） */
  const sectionSeries = async (): Promise<void> => {
    const { mapRunToEpisode, findEpisodeByNumber } = await import('../src/services/series')

    // ---- 唯一索引（(project_id, number) 项目内唯一）----
    const idxRows = await sqlite.execute("PRAGMA index_list('episodes')")
    const idx = (idxRows.rows as unknown as Array<{ name: string; unique: number }>).find((r) => r.name === 'idx_episodes_project_number')
    check(!!idx && idx.unique === 1, 'episodes (project_id, number) 唯一索引存在')

    // ---- 项目 A：无剧 → 空视图；不存在项目 → 404 ----
    const pidA = await mkProject('M14 探针项目 A（剧集）')
    const empty = await jreq('GET', `/api/v1/projects/${pidA}/series`)
    check(empty.status === 200 && empty.body?.series === null && Array.isArray(empty.body?.episodes) && empty.body.episodes.length === 0, '无剧项目 → { series: null, episodes: [] }')
    const missP = await jreq('GET', '/api/v1/projects/999999/series')
    check(missP.status === 404, '不存在项目 → 404')

    // ---- 建剧参数矩阵（均不落库）----
    const badName1 = await jreq('POST', `/api/v1/projects/${pidA}/series`, { name: '   ', total_episodes: 3 })
    check(badName1.status === 400 && badName1.body?.error?.code === 'bad_name', '空白 name → 400 bad_name')
    const badName2 = await jreq('POST', `/api/v1/projects/${pidA}/series`, { total_episodes: 3 })
    check(badName2.status === 400 && badName2.body?.error?.code === 'bad_name', '缺 name → 400 bad_name')
    for (const t of [0, 1.5, 1000, undefined]) {
      const r = await jreq('POST', `/api/v1/projects/${pidA}/series`, { name: 'x', total_episodes: t })
      check(r.status === 400 && r.body?.error?.code === 'bad_total', `total_episodes=${String(t)} → 400 bad_total`)
    }
    const pidB = await mkProject('M14 探针项目 B（资产）')
    const assetB = await mkImage(pidB, 'probe-m14-b.png')
    const badAsset1 = await jreq('POST', `/api/v1/projects/${pidA}/series`, { name: 'x', total_episodes: 1, content_asset_id: assetB.id })
    check(badAsset1.status === 400 && badAsset1.body?.error?.code === 'bad_asset', '跨项目 content_asset_id → 400 bad_asset')
    for (const v of [0, -3, 'abc']) {
      const r = await jreq('POST', `/api/v1/projects/${pidA}/series`, { name: 'x', total_episodes: 1, content_asset_id: v })
      check(r.status === 400 && r.body?.error?.code === 'bad_asset', `content_asset_id=${String(v)} → 400 bad_asset`)
    }

    // ---- 正式建剧（3 集）----
    const cr = await jreq('POST', `/api/v1/projects/${pidA}/series`, { name: ' 探针短剧 ', total_episodes: 3 })
    check(cr.status === 201, `建剧 201（${cr.status}）`)
    check(cr.body?.series?.name === '探针短剧' && cr.body?.series?.totalEpisodes === 3 && cr.body?.series?.projectId === pidA, 'series 出参（name trim / total / projectId）')
    const seriesId = cr.body?.series?.id as number
    const eps0 = (Array.isArray(cr.body?.episodes) ? cr.body.episodes : []) as any[]
    check(eps0.length === 3 && eps0.map((e) => e.number).join() === '1,2,3', '生成 1..N 集行')
    check(eps0.every((e) => e.status === 'locked' && e.rowStatus === 'locked' && e.runStatus === null && e.latestRunId === null), '初始行态 locked / runStatus null')
    const dupIns = await errOf(() =>
      Promise.resolve(
        db.insert(episodes).values({ projectId: pidA, seriesId, number: 1, status: 'locked', createdAt: 0, updatedAt: 0 }),
      ),
    )
    check(dupIns !== null, '重复 (project, number) 插入 → UNIQUE 约束拒绝')
    const dup = await jreq('POST', `/api/v1/projects/${pidA}/series`, { name: '二剧', total_episodes: 1 })
    check(dup.status === 409 && dup.body?.error?.code === 'series_exists', '一项目一剧 → 409 series_exists')
    const ls0 = await jreq('GET', `/api/v1/projects/${pidA}/series`)
    check(ls0.body?.episodes?.length === 3 && ls0.body.episodes[0].seriesId === seriesId, 'GET 列表 3 集（seriesId 透传）')

    // ---- 集编辑（title / status / 资产归属 / bad_patch / 404）----
    const ep1Id = epOf(ls0.body, 1).id as number
    const ep2Id = epOf(ls0.body, 2).id as number
    const ep3Id = epOf(ls0.body, 3).id as number
    const e1 = await jreq('PATCH', `/api/v1/episodes/${ep1Id}`, { title: '  第一集·起风  ' })
    check(e1.status === 200 && e1.body?.episode?.title === '第一集·起风', 'PATCH title trim 入库')
    const e2 = await jreq('PATCH', `/api/v1/episodes/${ep1Id}`, { title: 123 })
    check(e2.status === 400 && e2.body?.error?.code === 'bad_title', 'title 非串 → 400 bad_title')
    const e3 = await jreq('PATCH', `/api/v1/episodes/${ep1Id}`, { status: 'running' })
    check(e3.status === 400 && e3.body?.error?.code === 'bad_status', 'status 非白名单 → 400 bad_status')
    const e4 = await jreq('PATCH', `/api/v1/episodes/${ep1Id}`, { status: 'planning' })
    check(e4.status === 200 && e4.body?.episode?.rowStatus === 'planning' && e4.body?.episode?.status === 'planning', '手工态 planning（无 run → 派生=行值）')
    const e5 = await jreq('PATCH', `/api/v1/episodes/${ep1Id}`, {})
    check(e5.status === 400 && e5.body?.error?.code === 'bad_patch', '空 patch → 400 bad_patch')
    const e6 = await jreq('PATCH', '/api/v1/episodes/999999', { title: 'x' })
    check(e6.status === 404, '不存在集 → 404')
    const e7 = await jreq('PATCH', `/api/v1/episodes/${ep2Id}`, { content_asset_id: assetB.id })
    check(e7.status === 400 && e7.body?.error?.code === 'bad_asset', '跨项目资产绑定 → 400 bad_asset')
    const assetA = await mkImage(pidA, 'probe-m14-a.png')
    const e8 = await jreq('PATCH', `/api/v1/episodes/${ep2Id}`, { content_asset_id: assetA.id })
    check(e8.status === 200 && e8.body?.episode?.contentAssetId === assetA.id, '本项目资产绑定 ok')

    // ---- 扩容 / 缩容 ----
    const up5 = await jreq('PATCH', `/api/v1/series/${seriesId}`, { total_episodes: 5 })
    check(up5.status === 200 && up5.body?.episodes?.map((e: any) => e.number).join() === '1,2,3,4,5', '扩容 3→5 追集')
    const up0 = await jreq('PATCH', `/api/v1/series/${seriesId}`, { total_episodes: 0 })
    check(up0.status === 400 && up0.body?.error?.code === 'bad_total', '集数 0 → 400 bad_total')
    const upMiss = await jreq('PATCH', '/api/v1/series/999999', { total_episodes: 3 })
    check(upMiss.status === 404, '不存在剧 → 404')
    const ep5Id = epOf(up5.body, 5).id as number
    await jreq('PATCH', `/api/v1/episodes/${ep5Id}`, { content_asset_id: assetA.id })
    const down409 = await jreq('PATCH', `/api/v1/series/${seriesId}`, { total_episodes: 3 })
    check(down409.status === 409 && down409.body?.error?.code === 'episode_in_use', '缩容删除占用集 → 409 episode_in_use')
    const still5 = await jreq('GET', `/api/v1/projects/${pidA}/series`)
    check(still5.body?.episodes?.length === 5, '409 后无部分删除（仍 5 集）')
    await jreq('PATCH', `/api/v1/episodes/${ep5Id}`, { content_asset_id: null })
    const down3 = await jreq('PATCH', `/api/v1/series/${seriesId}`, { total_episodes: 3 })
    check(down3.status === 200 && down3.body?.episodes?.map((e: any) => e.number).join() === '1,2,3', '解绑后缩容 5→3')

    // ---- 删集 + 缺号不重建 ----
    const delEp = await jreq('DELETE', `/api/v1/episodes/${ep3Id}`)
    check(delEp.status === 200 && delEp.body?.ok === true, '删集 3 → ok')
    const grow4 = await jreq('PATCH', `/api/v1/series/${seriesId}`, { total_episodes: 4 })
    check(grow4.body?.episodes?.map((e: any) => e.number).join() === '1,2,4', '扩容不重建缺号（1,2,4）')
    const delEp404 = await jreq('DELETE', '/api/v1/episodes/999999')
    check(delEp404.status === 404, '删不存在集 → 404')

    // ---- mapRunToEpisode 四分支直测 ----
    const m1 = await mapRunToEpisode(pidA, 'x', 111)
    check(m1.linked === false && m1.reason === 'no_episode_number', '无/坏集号 → no_episode_number')
    const pidC = await mkProject('M14 探针项目 C（无剧）')
    const m2 = await mapRunToEpisode(pidC, 1, 111)
    check(m2.linked === false && m2.reason === 'no_series', '项目无剧 → no_series')
    const m3 = await mapRunToEpisode(pidA, 99, 111)
    check(m3.linked === false && m3.reason === 'no_episode_row', '集号不存在 → no_episode_row')
    const m4 = await mapRunToEpisode(pidA, 1, 555001)
    check(m4.linked === true, '集存在 → linked')
    const m5 = await mapRunToEpisode(pidA, '4', 555002)
    check(m5.linked === true, '数字字符串集号归一 → linked')
    const ep1Row = await findEpisodeByNumber(pidA, 1)
    check(ep1Row?.latestRunId === 555001, 'mapRunToEpisode 回写 latest_run_id')
    const ls1 = await jreq('GET', `/api/v1/projects/${pidA}/series`)
    const v1 = epOf(ls1.body, 1)
    check(v1.latestRunId === 555001 && v1.runStatus === null && v1.status === 'planning', '悬挂 runId（join 未命中）→ 派生回落行值 planning')

    // ---- HTTP 建 run 联动（engine 已置空，只验创建/快照/回写）----
    const runO = await jreq('POST', `/api/v1/projects/${pidA}/runs`, {
      template_key: 'mengbao-episode',
      input: { brief: '探针联动', episode_number: 2, _params: { video: { resolution: '720p', duration: 8 } } },
    })
    check(runO.status === 202, `HTTP 建 run 202（${runO.status}：${runO.body?.error?.message ?? ''}）`)
    const runId = runO.body?.run?.id as number
    check(runO.body?.run?.status === 'queued', 'run 初态 queued')
    check(runO.body?.run?.input?._params?.video?.resolution === '720p' && runO.body?.run?.input?._params?.video?.duration === 8, 'run.input._params 入快照')
    const ls2 = await jreq('GET', `/api/v1/projects/${pidA}/series`)
    const v2 = epOf(ls2.body, 2)
    check(v2.latestRunId === runId, 'HTTP 联动：episode 2 latest_run_id 回写')
    check(v2.runStatus === 'queued' && v2.status === 'queued' && v2.rowStatus === 'locked', '派生 status=queued（run 优先，行值不变）')
    const noRow = await jreq('POST', `/api/v1/projects/${pidA}/runs`, { template_key: 'mengbao-episode', input: { brief: 'x', episode_number: 99 } })
    check(noRow.status === 202, `集号无对应集行 → 202（联动宽容降级：no_episode_row 不阻断，${noRow.status}）`)
    const noSeries = await jreq('POST', `/api/v1/projects/${pidC}/runs`, { template_key: 'mengbao-episode', input: { brief: 'x', episode_number: 1 } })
    check(noSeries.status === 202, `项目无剧建 run（有集号）→ 202（宽容降级：no_series 不阻断，${noSeries.status}）`)
    const pidCList = await jreq('GET', `/api/v1/projects/${pidC}/series`)
    check(pidCList.body?.series === null, '无剧项目仍无剧（联动未误建）')

    // ---- 删除边界 ----
    const delSeries409 = await jreq('DELETE', `/api/v1/series/${seriesId}`)
    check(delSeries409.status === 409 && delSeries409.body?.error?.code === 'series_in_use', '剧有 run/资产占用 → 409 series_in_use')
    const pidD = await mkProject('M14 探针项目 D（删剧）')
    const crD = await jreq('POST', `/api/v1/projects/${pidD}/series`, { name: '待删剧', total_episodes: 2 })
    const delOk = await jreq('DELETE', `/api/v1/series/${crD.body?.series?.id}`)
    check(delOk.status === 200 && delOk.body?.ok === true, '无占用剧 → 删除 ok')
    const gone = await jreq('GET', `/api/v1/projects/${pidD}/series`)
    check(gone.body?.series === null && gone.body?.episodes?.length === 0, '删剧后 → 空视图（集行级联清理）')
    const delSeries404 = await jreq('DELETE', '/api/v1/series/999999')
    check(delSeries404.status === 404, '删不存在剧 → 404')
  }

  /** ③ static：Web 静态托管（命中 / SPA 回退 / api 优先 / 穿越防护） */
  const sectionStatic = async (): Promise<void> => {
    const hitIndex = await app.request('/')
    check(hitIndex.status === 200 && (hitIndex.headers.get('content-type') ?? '').includes('text/html'), `'/' → 200 text/html（SPA 回退）`)
    check((await hitIndex.text()).includes('ACS-M14-PROBE-INDEX'), 'index.html 内容命中')

    const js = await app.request('/assets/app.js')
    check(
      js.status === 200 && (js.headers.get('content-type') ?? '').includes('text/javascript') && (await js.text()).includes('M14_PROBE_JS'),
      '/assets/app.js 命中（MIME text/javascript）',
    )
    const png = await app.request('/favicon.png')
    check(png.status === 200 && (png.headers.get('content-type') ?? '').includes('image/png'), 'favicon.png MIME image/png')

    const deep = await app.request('/projects/12/timeline')
    check(deep.status === 200 && (await deep.text()).includes('ACS-M14-PROBE-INDEX'), '深链 → index.html 回退')
    const dir = await app.request('/assets')
    check(dir.status === 200 && (await dir.text()).includes('ACS-M14-PROBE-INDEX'), '目录路径不命中 → SPA 回退')

    const apiMiss = await app.request('/api/v1/nonexistent')
    let apiBody: any = null
    try {
      apiBody = await apiMiss.json()
    } catch {
      /* 非 JSON */
    }
    check(
      apiMiss.status === 404 && apiBody?.error?.code === 'not_found' && (apiMiss.headers.get('content-type') ?? '').includes('application/json'),
      '/api/* 未命中 → JSON 404（优先于 SPA 回退）',
    )

    const vectors = ['/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/a%2f..%2f..%2fsecret.txt', '/..%5Csecret.txt', '/../secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt']
    for (const v of vectors) {
      const res = await app.request(v)
      const text = await res.text()
      check(!text.includes(SECRET), `穿越防护 ${v} → 不泄露 dist 外文件（${res.status}）`)
    }
    const badEnc = await app.request('/%E0%A4%A')
    check(badEnc.status === 200 && (await badEnc.text()).includes('ACS-M14-PROBE-INDEX'), '非法百分号编码 → 不失守（回退 index）')
  }

  /** ④ regression：前序探针子进程全绿 */
  const sectionRegression = async (): Promise<void> => {
    const { spawnSync } = await import('node:child_process')
    const probes = ['probe:m7', 'probe:m8', 'probe:m10', 'probe:m11', 'probe:m12', 'probe:m13']
    const childEnv = { ...process.env }
    delete childEnv.CSTUDIO_ROOT
    delete childEnv.CSTUDIO_DATA
    delete childEnv.CSTUDIO_WORKSPACE
    delete childEnv.CSTUDIO_WEB_DIST
    delete childEnv.AGENT_LLM_BASE_URL
    delete childEnv.AGENT_LLM_API_KEY
    delete childEnv.AGENT_LLM_MODEL
    for (const p of probes) {
      const r = spawnSync('npm', ['run', p], {
        cwd: join(REPO_ROOT, 'apps', 'server'),
        env: childEnv,
        shell: true,
        encoding: 'utf8',
        timeout: 15 * 60_000,
      })
      const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
      const tail = out
        .split('\n')
        .filter((l) => l.includes('探针结果') || l.includes('FAIL'))
        .slice(-3)
        .join(' | ')
      check(r.status === 0, `${p} 全绿（exit=${String(r.status)}${r.status === 0 ? '' : `；${tail || out.slice(-300).trim()}`}）`)
    }
  }

  // ================= 分发 =================
  const runners: Record<string, () => Promise<void>> = {
    params: sectionParams,
    series: sectionSeries,
    static: sectionStatic,
    regression: sectionRegression,
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
    console.log(`\n==== M14 探针结果: ${failed > 0 ? `${failed} 项失败` : '全部通过'} ====`)
    globalThis.fetch = origFetch // 还原网络栈
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
