/**
 * M13 探针（素材链补全六项）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m13.ts [--section=style-multi|vision|video-refs|upload|polish|states|regression]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录
 * （独立 studio.db + workspace），不触碰开发库（同 probe-m3~m12）。LLM 全链由 globalThis.fetch
 * stub 拦截（AGENT_LLM_* 指向假端点），全程零网络、零计费；提示词文件从仓库 workspace/prompts
 * 复制进隔离目录（loadPromptTemplate 读隔离 PROMPTS_DIR）。
 *
 * section（默认 all）：
 *   style-multi stylePresetIdsOf 矩阵（数组/单值回退/去重/坏 JSON/负值过滤）+ combineStyleSnippets +
 *               resolveProjectStyleSnippets（绑定顺序/停用跳过/不存在跳过/单值回退）+ injectStyleAnchor 单值回归
 *   vision      extractSnippetFromText 矩阵 + extractStyleSnippetFromAssets：fetch stub 断言多模态请求体
 *               （messages content 数组含 image_url data URI）+ 失败路径（空/超限/跨项目/非图）+ 用量 runId=NULL
 *   video-refs  collectSetRefAssetIds 矩阵（场景/别名/道具/无图跳过/双命中 ≤2/同图去重）+ planVideoRefs 四分支
 *   upload      POST /entities/:id/ref-images（app.request 内存 HTTP new FormData）：入库/挂接/sha256 复用/
 *               purpose=reference_kind/失败路径（全局/非图/空文件/超限 413/404）
 *   polish      parsePolishOutput 矩阵 + polishAppearance stub + POST /entities/polish 批量容错（失败收集不阻断/
 *               空白输出 failed/全局跳过用量/去重/边界 400）
 *   states      PRAGMA 迁移列（默认 '[]' NOT NULL + 幂等）+ upsertEntity 覆盖语义（非空覆盖/空数组不覆盖）+
 *               normalizeSpec 保留 + HTTP 读写（清洗/替换/清空/坏 JSON → []/非角色忽略/坏类型 400）
 *   regression  probe:m7 / probe:m8 / probe:m10 / probe:m11 / probe:m12 子进程全绿
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Asset } from '../src/db/schema'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
// 清理历史残留：libsql 在 Windows 下不释放文件句柄（close 后仍 EBUSY）——本进程退出时 db 文件必留；
// 本次运行在创建自己的目录前清掉旧的（占用中则跳过，自动收敛为最多一份）。
import { sweepStaleProbeTempDirs, writeProbePidSentinel } from './probe-lib'

const TMP_PREFIX = 'acs-probe-m13-'
// 清理历史残留（跳过存活并行探针目录，避免并行 --jobs≥2 下嵌套回归子探针与顶层同名探针互删 SQLite 库）
sweepStaleProbeTempDirs(TMP_PREFIX)
const TMP = mkdtempSync(join(tmpdir(), TMP_PREFIX))
writeProbePidSentinel(TMP)
process.env.CSTUDIO_ROOT = REPO_ROOT
process.env.CSTUDIO_DATA = join(TMP, 'data')
process.env.CSTUDIO_WORKSPACE = join(TMP, 'workspace')
// LLM 假端点（globalThis.fetch stub 拦截，不外发）；env.ts 在模块加载时读取 → 必须先行设置。
// dotenv 不覆盖已存在环境变量（仓库 .env 即使有真配置也不生效）。
process.env.AGENT_LLM_BASE_URL = 'http://probe-m13.local/v1'
process.env.AGENT_LLM_API_KEY = 'probe-key'
process.env.AGENT_LLM_MODEL = 'probe-model-vision'
mkdirSync(process.env.CSTUDIO_DATA, { recursive: true })
mkdirSync(process.env.CSTUDIO_WORKSPACE, { recursive: true })

const SECTIONS = ['style-multi', 'vision', 'video-refs', 'upload', 'polish', 'states', 'regression'] as const

// ---- fetch stub：录制 LLM 请求 + 可编程响应（OpenAI 兼容格式）----
interface StubCall {
  url: string
  body: Record<string, unknown>
}
const stubCalls: StubCall[] = []
let stubReply: (call: StubCall) => { status: number; body: unknown } = () => ({ status: 200, body: {} })

/** OpenAI 兼容成功响应（choices[0].message.content + usage） */
const llmReply = (
  content: string,
  usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
): { status: number; body: unknown } => ({
  status: 200,
  body: { choices: [{ message: { content }, finish_reason: 'stop' }], usage },
})

const stubFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  let body: Record<string, unknown> = {}
  if (typeof init?.body === 'string') {
    try {
      body = JSON.parse(init.body) as Record<string, unknown>
    } catch {
      /* 非 JSON body */
    }
  }
  const call: StubCall = { url: typeof input === 'string' ? input : String(input), body }
  stubCalls.push(call)
  const r = stubReply(call)
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

async function main(): Promise<void> {
  const origFetch = globalThis.fetch
  globalThis.fetch = stubFetch

  // src 模块全部动态加载（环境变量已隔离）
  const { db, initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')
  const { assets, characters, projects, stylePresets, usageRecords } = await import('../src/db/schema')
  const { eq } = await import('drizzle-orm')
  const { PROMPTS_DIR } = await import('../src/env')
  const { absPathOf, importFiles } = await import('../src/services/storage')
  const { attachRefAssets, upsertEntity } = await import('../src/services/character')
  const { app } = await import('../src/app')

  // 提示词文件就位（隔离 workspace；style-extract.md / entity-polish.md 由 ① ⑤ 运行时读取）
  mkdirSync(PROMPTS_DIR, { recursive: true })
  for (const f of ['style-extract.md', 'entity-polish.md']) {
    cpSync(join(REPO_ROOT, 'workspace', 'prompts', f), join(PROMPTS_DIR, f))
  }

  const log = createLogger('probe-m13')
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

  const mkProject = async (name: string, settings = '{}'): Promise<number> =>
    (
      await db
        .insert(projects)
        .values({ name, genre: 'other', templateKey: 'mengbao-episode', settings, tags: '[]', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!.id
  const mkPreset = async (name: string, snippet: string, o: { isActive?: number } = {}): Promise<number> =>
    (
      await db
        .insert(stylePresets)
        .values({ name, snippet, description: null, sortOrder: 0, isActive: o.isActive ?? 1, createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!.id
  /** 真图资产（真实文件落盘，assetToDataUri 可读；同名不同内容自动区分 sha256） */
  const mkImage = async (pid: number, name: string): Promise<Asset> =>
    (await importFiles(pid, [{ name, data: new TextEncoder().encode(`probe-m13-img:${name}`) }], { purpose: 'reference_scene' }))[0]!
  const assetRow = async (id: number) => (await db.select().from(assets).where(eq(assets.id, id)).limit(1))[0]!
  const charRow = async (id: number) => (await db.select().from(characters).where(eq(characters.id, id)).limit(1))[0]!
  const usageRows = async (pid: number) => db.select().from(usageRecords).where(eq(usageRecords.projectId, pid))
  const usageTotal = async (): Promise<number> => (await db.select().from(usageRecords)).length

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

  // ================= sections =================

  /** ① ② 风格多预设：解析矩阵 + DB 顺序/停用跳过 + M8 单值注入等价 */
  const sectionStyleMulti = async (): Promise<void> => {
    const { stylePresetIdsOf, combineStyleSnippets, resolveProjectStyleSnippets, resolveProjectStyleSnippet, stripStyleWrapper } =
      await import('../src/services/style-preset')
    const { injectStyleAnchor } = await import('../src/pipeline/actions/ai-image')

    // ---- stylePresetIdsOf 矩阵 ----
    check(JSON.stringify(stylePresetIdsOf('{"style_preset_ids":[3,1,3]}')) === '[3,1]', '数组键：去重保序 [3,1]')
    check(JSON.stringify(stylePresetIdsOf('{"style_preset_ids":[3],"style_preset_id":9}')) === '[3]', '数组键优先于单值键')
    check(JSON.stringify(stylePresetIdsOf('{"style_preset_id":5}')) === '[5]', '单值键回退 → [5]')
    check(stylePresetIdsOf('{"style_preset_ids":[]}').length === 0, '空数组不回退单值（显式清空）')
    check(JSON.stringify(stylePresetIdsOf('{"style_preset_ids":[3,0,-2,2.5,"x",4]}')) === '[3,4]', '非整数/≤0/字符串过滤')
    check(JSON.stringify(stylePresetIdsOf('{"style_preset_ids":["7"]}')) === '[7]', '数字字符串 Number 归一')
    check(stylePresetIdsOf('not-json').length === 0, '坏 JSON → []')
    check(stylePresetIdsOf('{}').length === 0, '缺键 → []')

    // ---- combineStyleSnippets ----
    check(combineStyleSnippets([' a ', 'b', '']) === 'a；b', '多词块 trim + 「；」拼接')
    check(combineStyleSnippets(['x']) === 'x', '单词块原样')
    check(combineStyleSnippets([]) === null, '空数组 → null')
    check(combineStyleSnippets(['  ', '']) === null, '全空白 → null')

    // ---- stripStyleWrapper：展示壳剥离（出图注入前）----
    check(stripStyleWrapper('（画风：日系二次元赛璐璐,japanese anime style, cel shading）') === 'japanese anime style, cel shading', '全角壳+半角逗号 → 取英文段')
    check(stripStyleWrapper('(画风:2D动漫风格,2d animation style)') === '2d animation style', '半角壳+半角冒号 → 取英文段')
    check(stripStyleWrapper('（画风：水墨国风，ink painting）') === 'ink painting', '全角逗号亦可分隔')
    check(stripStyleWrapper('（画风：纯中文无英文）') === '纯中文无英文', '无逗号（纯中文壳）→ 壳内全文')
    check(stripStyleWrapper('flat anime style, soft colors') === 'flat anime style, soft colors', '无壳纯词块 → 原样（零副作用）')
    check(stripStyleWrapper('   ') === '', '空白 → 空')
    check(combineStyleSnippets(['（画风：赛博霓虹,cyberpunk, neon）', 'ink wash']) === 'cyberpunk, neon；ink wash', 'combine 逐块剥壳后拼接')

    // ---- resolveProjectStyleSnippets：DB 造数（绑定顺序 / 停用跳过 / 不存在跳过 / 空白词块跳过）----
    const pB = await mkPreset('探针B（后绑定先顺序）', 'B style block')
    const pA = await mkPreset('探针A', 'A style block')
    const pC = await mkPreset('探针C（停用）', 'C style block', { isActive: 0 })
    const pEmpty = await mkPreset('探针D（空白词块）', '   ')
    const pidMulti = await mkProject('M13 探针项目（多预设）', JSON.stringify({ style_preset_ids: [pB, pA, pC, 999999, pEmpty] }))
    const rMulti = await resolveProjectStyleSnippets(pidMulti)
    check(
      rMulti.length === 2 && rMulti[0]!.id === pB && rMulti[1]!.id === pA,
      `多预设按绑定顺序解析（实际 [${rMulti.map((x) => x.id).join(',')}]）`,
    )
    check(rMulti[0]!.snippet === 'B style block' && rMulti[1]!.name === '探针A', '词块/名称透传')
    const rFirst = await resolveProjectStyleSnippet(pidMulti)
    check(rFirst?.id === pB, '旧单数封装 = 复数首个（M8 签名零改动）')

    const pidLegacy = await mkProject('M13 探针项目（单值回退）', JSON.stringify({ style_preset_id: pA }))
    const rLegacy = await resolveProjectStyleSnippets(pidLegacy)
    check(rLegacy.length === 1 && rLegacy[0]!.id === pA, '旧单值键回退解析')
    const pidNone = await mkProject('M13 探针项目（未绑定）', '{}')
    check((await resolveProjectStyleSnippets(pidNone)).length === 0, '未绑定 → 空（宽容降级）')
    const pidBad = await mkProject('M13 探针项目（坏 JSON）', 'not-json')
    check((await resolveProjectStyleSnippets(pidBad)).length === 0, 'settings 坏 JSON → 空')

    // ---- injectStyleAnchor：单值行为与 M8 逐字等价 ----
    const shots = [{ id: 's1', image_prompt: ' 日出 ' }]
    const rWrap = injectStyleAnchor(shots, combineStyleSnippets(['（画风：日系动漫,anime style, cel shading）']))
    check(rWrap[0]!.image_prompt === '日出\n视觉风格：anime style, cel shading', '端到端：带壳预设经注入链→图像 prompt 不含「画风」/括号')
    const r1 = injectStyleAnchor(shots, 'ink wash')
    check(r1[0]!.image_prompt === '日出\n视觉风格：ink wash', '单值注入逐字「视觉风格：{snippet}」（M8 等价）')
    check(injectStyleAnchor(shots, null) === shots && injectStyleAnchor(shots, '  ') === shots, '空/未绑定 → 原引用零注入')
    const r2 = injectStyleAnchor(shots, combineStyleSnippets(['ink wash', 'neon glow']))
    check(r2[0]!.image_prompt === '日出\n视觉风格：ink wash；neon glow', 'combine 后注入「视觉风格：A；B」')
    check(shots[0]!.image_prompt === ' 日出 ', '纯函数不修改入参')
  }

  /** ① 视觉提取：解析矩阵 + fetch stub 多模态请求体 + 失败路径 + 用量 */
  const sectionVision = async (): Promise<void> => {
    const { extractSnippetFromText, extractStyleSnippetFromAssets, MAX_SNIPPET_CHARS } =
      await import('../src/services/style-preset')

    // ---- extractSnippetFromText 矩阵 ----
    check(extractSnippetFromText('(画风：赛博朋克霓虹,cyberpunk neon)') === '（画风：赛博朋克霓虹,cyberpunk neon）', '标准格式 → 全角规范')
    check(extractSnippetFromText('（画风: 水墨,ink wash）') === '（画风：水墨,ink wash）', '全角括号 + 半角冒号归一')
    check(extractSnippetFromText('```\n(画风：像素风,pixel art)\n```') === '（画风：像素风,pixel art）', '围栏剥离后命中')
    check(extractSnippetFromText('这是一段没有格式的画风描述') === '这是一段没有格式的画风描述', '未命中 → 全文宽容回退')
    check(extractSnippetFromText('  \n 多行\n文本 \n ') === '多行\n文本', '回退路径 trim')
    check(extractSnippetFromText(`(画风：${'x'.repeat(500)})`).length === MAX_SNIPPET_CHARS, `超长截断 cap=${MAX_SNIPPET_CHARS}`)
    check(extractSnippetFromText('') === '', '空串 → 空')

    // ---- 集成：fetch stub 断言多模态请求体 ----
    const pid = await mkProject('M13 探针项目（视觉提取）')
    const img1 = await mkImage(pid, 'vision-a.png')
    const img2 = await mkImage(pid, 'vision-b.png')

    stubCalls.length = 0
    stubReply = () => llmReply('(画风：赛博朋克霓虹,cyberpunk neon city, rain reflections)')
    const r = await extractStyleSnippetFromAssets(pid, [img1.id, img2.id])
    check(r.snippet === '（画风：赛博朋克霓虹,cyberpunk neon city, rain reflections）', '提取 → 规范 snippet')
    check(r.provider === 'env' && r.model === 'probe-model-vision', `来源 provider/model（${r.provider}/${r.model}）`)
    check(stubCalls.length === 1, `单次 LLM 调用（实际 ${stubCalls.length}）`)
    const call = stubCalls[0]!
    check(call.url.endsWith('/chat/completions'), `端点路径 /chat/completions（${call.url}）`)
    check(call.body['model'] === 'probe-model-vision' && call.body['stream'] === false, '请求体 model/stream')
    const msgs = call.body['messages'] as Array<{ role: string; content: unknown }>
    check(Array.isArray(msgs) && msgs.length === 2 && msgs[0]!.role === 'system' && msgs[1]!.role === 'user', 'messages = [system, user]')
    check(typeof msgs[0]!.content === 'string' && (msgs[0]!.content as string).includes('画风'), 'system = style-extract.md（含「画风」规则）')
    const parts = msgs[1]!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>
    check(Array.isArray(parts) && parts[0]!.type === 'text', 'user content 为分片数组（首项 text）')
    const imgParts = parts.filter((p) => p.type === 'image_url')
    check(
      imgParts.length === 2 && imgParts.every((p) => (p.image_url?.url ?? '').startsWith('data:image/png;base64,')),
      '含 2 项 image_url 且为 data URI（image/png）',
    )
    const usages = await usageRows(pid)
    check(usages.length === 2 && usages.every((u) => u.runId === null), `用量 2 行 runId=NULL（实际 ${usages.length}）`)

    // ---- 校验失败路径 ----
    const e0 = await errOf(() => extractStyleSnippetFromAssets(pid, []))
    check(e0 instanceof Error && e0.message.includes('至少 1 张'), '空 asset_ids → 抛错')
    const e5 = await errOf(() => extractStyleSnippetFromAssets(pid, [img1.id, img1.id, img1.id, img1.id, img1.id]))
    check(e5 instanceof Error && e5.message.includes('最多 4 张'), '超 4 张 → 抛错')
    const pidOther = await mkProject('M13 探针项目（跨项目）')
    const eCross = await errOf(() => extractStyleSnippetFromAssets(pidOther, [img1.id]))
    check(eCross instanceof Error && eCross.message.includes('不属于本项目'), '跨项目资产 → 抛错')
    const audio = (await importFiles(pid, [{ name: 'vision-audio.mp3', data: new TextEncoder().encode('probe-m13-audio') }], { purpose: 'voice' }))[0]!
    const eKind = await errOf(() => extractStyleSnippetFromAssets(pid, [audio.id]))
    check(eKind instanceof Error && eKind.message.includes('非图片'), '非图资产 → 抛错（assetToDataUri）')

    // ---- stub 围栏 + 半角（全链）----
    stubReply = () => llmReply('```\n（画风: 水墨,ink wash）\n```')
    const r2 = await extractStyleSnippetFromAssets(pid, [img1.id])
    check(r2.snippet === '（画风：水墨,ink wash）', 'stub 围栏 + 半角归一（全链）')
  }

  /** ③ 视频参考图：collectSetRefAssetIds 矩阵 + planVideoRefs 四分支 */
  const sectionVideoRefs = async (): Promise<void> => {
    const { collectSetRefAssetIds, planVideoRefs } = await import('../src/pipeline/actions/ai-video')
    const { loadEntityIndex } = await import('../src/services/character')

    const pid = await mkProject('M13 探针项目（视频参考图）')
    const sImg = await mkImage(pid, 'set-scene.png')
    const pImg = await mkImage(pid, 'set-prop.png')
    await upsertEntity({ projectId: pid, kind: 'scene', name: '村口老槐树', aliases: ['村口'], refAssetIds: [sImg.id] })
    await upsertEntity({ projectId: pid, kind: 'prop', name: '虎头帽', refAssetIds: [pImg.id] })
    await upsertEntity({ projectId: pid, kind: 'prop', name: '无图道具' })
    await upsertEntity({ projectId: pid, kind: 'prop', name: '同图道具', refAssetIds: [sImg.id] })

    const sceneIndex = await loadEntityIndex(pid, 'scene')
    const propIndex = await loadEntityIndex(pid, 'prop')
    const mkShot = (o: { location?: string; props?: string[] }): { id: string; image_prompt: string; location?: string; props?: string[] } => ({
      id: 's1',
      image_prompt: 'p',
      ...o,
    })

    const c1 = collectSetRefAssetIds(mkShot({ location: '村口老槐树' }), sceneIndex, propIndex)
    check(c1.length === 1 && c1[0] === sImg.id, '场景名命中 → refAssetIds[0]')
    const c2 = collectSetRefAssetIds(mkShot({ location: '村口' }), sceneIndex, propIndex)
    check(c2.length === 1 && c2[0] === sImg.id, '场景别名命中（村口）')
    const c3 = collectSetRefAssetIds(mkShot({ props: ['虎头帽'] }), sceneIndex, propIndex)
    check(c3.length === 1 && c3[0] === pImg.id, '道具命中')
    const c4 = collectSetRefAssetIds(mkShot({ props: ['无图道具', '虎头帽'] }), sceneIndex, propIndex)
    check(c4.length === 1 && c4[0] === pImg.id, '道具按序跳过无图命中（首个有图项）')
    const c5 = collectSetRefAssetIds(mkShot({ location: '村口老槐树', props: ['虎头帽'] }), sceneIndex, propIndex)
    check(c5.length === 2 && c5[0] === sImg.id && c5[1] === pImg.id, '双命中 ≤2（场景在前）')
    const c6 = collectSetRefAssetIds(mkShot({ location: '不存在的场景' }), sceneIndex, propIndex)
    check(c6.length === 0, '未命中 → 空')
    const c7 = collectSetRefAssetIds(mkShot({ location: '村口老槐树', props: ['同图道具'] }), sceneIndex, propIndex)
    check(c7.length === 1 && c7[0] === sImg.id, '场景/道具同图 → 保序去重')
    const c8 = collectSetRefAssetIds(mkShot({}), sceneIndex, propIndex)
    check(c8.length === 0, '无 location/props → 空')

    // ---- planVideoRefs 四分支 + 判定顺序 ----
    const p1 = planVideoRefs({ hasFirstFrame: false, setRefIds: [1, 2], refCap: 'base64' })
    check(p1.reason === 'ok' && JSON.stringify(p1.inject) === '[1,2]', '无首帧 + 有图 + 有能力 → ok 注入全部')
    const p2 = planVideoRefs({ hasFirstFrame: true, setRefIds: [1], refCap: 'base64' })
    check(p2.reason === 'frame_first' && p2.inject.length === 0, '有首帧 → frame_first 跳过（Wan 互斥规避）')
    const p3 = planVideoRefs({ hasFirstFrame: false, setRefIds: [1], refCap: 'none' })
    check(p3.reason === 'no_cap' && p3.inject.length === 0, '供应商无能力 → no_cap 跳过')
    const p4 = planVideoRefs({ hasFirstFrame: false, setRefIds: [], refCap: 'base64' })
    check(p4.reason === 'none' && p4.inject.length === 0, '无参考图 → none')
    const p5 = planVideoRefs({ hasFirstFrame: true, setRefIds: [], refCap: 'none' })
    check(p5.reason === 'none', '空集判定先于 no_cap（分支优先级）')
  }

  /** ④ 上传通道：POST /entities/:id/ref-images 全链 + sha256 复用 + 失败路径 */
  const sectionUpload = async (): Promise<void> => {
    const pid = await mkProject('M13 探针项目（上传通道）')
    const scene = await upsertEntity({ projectId: pid, kind: 'scene', name: '上传场景', appearance: 'x' })
    const eid = scene.id

    const fd = (name: string, bytes: Uint8Array): FormData => {
      const form = new FormData()
      form.append('file', new File([bytes as unknown as BlobPart], name, { type: 'image/png' }))
      return form
    }
    const upload = async (id: number, form: FormData): Promise<{ status: number; body: any }> => {
      const res = await app.request(`/api/v1/entities/${id}/ref-images`, { method: 'POST', body: form })
      let json: any = null
      try {
        json = await res.json()
      } catch {
        /* 非 JSON */
      }
      return { status: res.status, body: json }
    }

    const bytes1 = new TextEncoder().encode('upload-ref-1')
    const up1 = await upload(eid, fd('ref-a.png', bytes1))
    check(up1.status === 201 && up1.body?.entity?.refAssetIds?.length === 1, `上传 201 + refAssetIds 追加（${up1.status}）`)
    check(up1.body?.entity?.refAssets?.length === 1 && up1.body?.entity?.refAssets?.[0]?.urls?.thumb, 'entity 视图含 refAssets 缩略')
    const aid = up1.body?.asset?.id as number
    const aRow = await assetRow(aid)
    check(aRow.kind === 'image' && aRow.purpose === 'reference_scene', `资产行 kind/purpose（${aRow.purpose}）`)
    check(!!aRow.relPath && existsSync(absPathOf(aRow.relPath)), '文件真实落盘（隔离 workspace）')
    check(up1.body?.asset?.urls?.file === `/api/v1/assets/${aid}/file`, 'asset 视图 toAssetView 结构')

    // sha256 复用：同字节 → 同一资产行（不重复落盘/插行）
    const up2 = await upload(eid, fd('ref-a.png', bytes1))
    check(up2.status === 201 && up2.body?.asset?.id === aid, '同字节复用原资产行（sha256）')
    check((await db.select().from(assets).where(eq(assets.projectId, pid))).length === 1, '资产表行数不变（复用）')

    // 并集挂接：新字节 → 第二张
    const up3 = await upload(eid, fd('ref-b.png', new TextEncoder().encode('upload-ref-2')))
    check(up3.status === 201 && up3.body?.entity?.refAssetIds?.length === 2, '并集追加第二张（长度 2）')

    // 失败路径
    const globalE = await upsertEntity({ projectId: null, kind: 'scene', name: '全局场景（上传拒绝）' })
    const upG = await upload(globalE.id, fd('g.png', new TextEncoder().encode('g1')))
    check(upG.status === 400 && upG.body?.error?.code === 'bad_ref_assets', `全局实体 → 400 bad_ref_assets（${upG.status}）`)
    const upTxt = await upload(eid, fd('note.txt', new TextEncoder().encode('hello')))
    check(upTxt.status === 400 && upTxt.body?.error?.code === 'not_image', `非图片扩展 → 400 not_image（${upTxt.status}）`)
    const upEmpty = await upload(eid, fd('empty.png', new Uint8Array(0)))
    check(upEmpty.status === 400 && upEmpty.body?.error?.code === 'no_file', `空文件 → 400 no_file（${upEmpty.status}）`)
    const up404 = await upload(999999, fd('x.png', new TextEncoder().encode('x2')))
    check(up404.status === 404, `实体不存在 → 404（${up404.status}）`)
    const upBig = await upload(eid, fd('big.png', new Uint8Array(10 * 1024 * 1024 + 1)))
    check(upBig.status === 413 && upBig.body?.error?.code === 'too_large', `>10MB → 413 too_large（${upBig.status}）`)

    // attachRefAssets 幂等（服务层直调）
    const added = await attachRefAssets(pid, '上传场景', [aid], 'scene')
    check(added === 0, 'attachRefAssets 重挂同图 → added=0（并集幂等）')
  }

  /** ⑤ 批量润色：解析矩阵 + stub 直调 + HTTP 批量容错/用量/边界 */
  const sectionPolish = async (): Promise<void> => {
    const { parsePolishOutput, polishAppearance } = await import('../src/services/entity-polish')

    // ---- parsePolishOutput 矩阵 ----
    check(parsePolishOutput('  圆脸大眼  ') === '圆脸大眼', 'trim')
    check(parsePolishOutput('```\n圆脸大眼，虎头帽\n```') === '圆脸大眼，虎头帽', '围栏剥离')
    check(parsePolishOutput('"圆脸大眼"') === '圆脸大眼', '成对双引号剥离')
    check(parsePolishOutput('“圆脸大眼”') === '圆脸大眼', '成对中文引号剥离')
    check(parsePolishOutput('以下是润色结果：\n\n圆脸大眼，虎头帽，红袄') === '圆脸大眼，虎头帽，红袄', '多段取最长（弃引导语）')
    check(parsePolishOutput('a\n\nbb\n\nccc') === 'ccc', '多段取最长（通用）')
    check(parsePolishOutput('') === '' && parsePolishOutput('   ') === '', '空/空白 → 空')

    // ---- polishAppearance（fetch stub）----
    const pid = await mkProject('M13 探针项目（润色）')
    const c1 = await upsertEntity({ projectId: pid, kind: 'character', name: '润色角色甲', appearance: '圆脸 大眼 虎头帽' })
    stubCalls.length = 0
    stubReply = () => llmReply(' 圆脸大眼，虎头帽，大红绸面红袄 ')
    const row = await charRow(c1.id)
    const pr = await polishAppearance(row)
    check(pr.appearance === '圆脸大眼，虎头帽，大红绸面红袄', 'polishAppearance 清洗后结果')
    check(pr.provider === 'env' && pr.model === 'probe-model-vision' && pr.usage?.totalTokens === 30, 'provider/model/usage 透传')
    const umsgs = stubCalls[0]!.body['messages'] as Array<{ role: string; content: string }>
    check(umsgs[0]!.role === 'system' && umsgs[0]!.content.includes('润色'), 'system = entity-polish.md（含「润色」）')
    const payload = JSON.parse(umsgs[1]!.content) as { kind: string; name: string; appearance: string }
    check(payload.kind === 'character' && payload.name === '润色角色甲' && payload.appearance === '圆脸 大眼 虎头帽', 'user JSON 载荷（档案快照）')

    // ---- HTTP 批量：失败收集不阻断 + usage ----
    const c2 = await upsertEntity({ projectId: pid, kind: 'character', name: '润色角色乙', appearance: '乙原描述' })
    const c3 = await upsertEntity({ projectId: pid, kind: 'character', name: '润色角色丙', appearance: '丙原描述' })
    let nth = 0
    stubReply = () => {
      nth += 1
      if (nth === 2) return { status: 500, body: { error: 'boom' } }
      return llmReply(`润色结果-${nth}`)
    }
    const before = (await usageRows(pid)).length
    const rp = await jreq('POST', '/api/v1/entities/polish', { ids: [c1.id, c2.id, c3.id] })
    check(rp.status === 200 && rp.body?.ok === true, `批量润色 200（${rp.status}）`)
    check(
      rp.body?.polished?.length === 2 && rp.body?.failed?.length === 1,
      `polished=2 / failed=1（实际 ${rp.body?.polished?.length}/${rp.body?.failed?.length}）`,
    )
    const fRow = rp.body?.failed?.[0]
    check(fRow?.id === c2.id && String(fRow?.error).includes('500'), `失败项 = 乙 且错误含 HTTP 500（${fRow?.error}）`)
    check((await charRow(c1.id)).appearance === '润色结果-1', '甲 已更新')
    check((await charRow(c2.id)).appearance === '乙原描述', '乙 失败未改（不阻断）')
    check((await charRow(c3.id)).appearance === '润色结果-3', '丙 继续执行已更新')
    check((await usageRows(pid)).length - before === 4, `成功 2 项 × 2 行用量（${(await usageRows(pid)).length - before}）`)

    // 全局实体：成功但跳过用量（projectId NULL）
    const g1 = await upsertEntity({ projectId: null, kind: 'character', name: '全局润色角色', appearance: '全局原描述' })
    nth = 0
    stubReply = () => {
      nth += 1
      return nth === 1 ? llmReply('全局润色结果') : llmReply('   ')
    }
    const totalBefore = await usageTotal()
    const rg = await jreq('POST', '/api/v1/entities/polish', { ids: [g1.id] })
    check(rg.body?.polished?.length === 1 && (await charRow(g1.id)).appearance === '全局润色结果', '全局实体润色成功')
    check((await usageTotal()) === totalBefore, '全局实体跳过用量记录（projectId NULL）')

    // 空白输出 → failed 空输出分支（第二轮 stub 返回 '   '）
    const rEmpty = await jreq('POST', '/api/v1/entities/polish', { ids: [c3.id] })
    check(
      rEmpty.body?.failed?.[0]?.id === c3.id && String(rEmpty.body?.failed?.[0]?.error).includes('输出为空'),
      `空白输出 → failed「润色输出为空」（${rEmpty.body?.failed?.[0]?.error}）`,
    )
    check((await charRow(c3.id)).appearance === '润色结果-3', '空白输出未覆盖既有值')

    // 去重 + 边界
    nth = 0
    stubReply = () => llmReply('幂等结果')
    const rDup = await jreq('POST', '/api/v1/entities/polish', { ids: [c1.id, c1.id] })
    check(rDup.body?.polished?.length === 1, '重复 id 去重（polished=1）')
    const rNoIds = await jreq('POST', '/api/v1/entities/polish', { ids: [] })
    check(rNoIds.status === 400 && rNoIds.body?.error?.code === 'bad_ids', `空 ids → 400 bad_ids（${rNoIds.status}）`)
    const rTooMany = await jreq('POST', '/api/v1/entities/polish', { ids: Array.from({ length: 11 }, (_, i) => i + 1) })
    check(rTooMany.status === 400 && rTooMany.body?.error?.code === 'too_many_ids', `11 项 → 400 too_many_ids（${rTooMany.status}）`)
    const rMissing = await jreq('POST', '/api/v1/entities/polish', { ids: [999999] })
    check(rMissing.body?.failed?.[0]?.error === '素材不存在', '不存在的 id → failed「素材不存在」（不炸）')
  }

  /** ⑥ states 变体：迁移列 + 覆盖语义 + normalizeSpec + HTTP 读写 */
  const sectionStates = async (): Promise<void> => {
    const { normalizeSpec } = await import('../src/pipeline/actions/character-sync')

    // ---- 迁移列 ----
    const cols = await sqlite.execute("PRAGMA table_info('characters')")
    const colMap = new Map(
      (cols.rows as unknown as Array<{ name: string; dflt_value: string | null; notnull: number }>).map((r) => [r.name, r]),
    )
    const st = colMap.get('states')
    check(!!st, 'characters.states 列存在（幂等迁移）')
    check((st?.dflt_value ?? '').includes('[]') && st?.notnull === 1, `states 默认 '[]' NOT NULL（${st?.dflt_value}）`)
    await initDb() // 重复执行 → 幂等
    const colsAgain = await sqlite.execute("PRAGMA table_info('characters')")
    check(
      (colsAgain.rows as unknown as Array<{ name: string }>).filter((r) => r.name === 'states').length === 1,
      '重复 initDb 幂等（states 单列）',
    )
    const t = Date.now()
    await sqlite.execute({
      sql: 'INSERT INTO characters (name, aliases, ref_asset_ids, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: ['迁移旧行（M13）', '[]', '[]', '{}', t, t],
    })
    const back = await sqlite.execute("SELECT states FROM characters WHERE name = '迁移旧行（M13）'")
    check((back.rows as unknown as Array<{ states: string }>)[0]?.states === '[]', '旧行 DB 级默认 states=[]')

    // ---- upsertEntity 覆盖语义 ----
    const pid = await mkProject('M13 探针项目（states）')
    const u1 = await upsertEntity({ projectId: pid, kind: 'character', name: '变体角色', states: ['第1场：完好'] })
    check(u1.created && JSON.parse((await charRow(u1.id)).states).join() === '第1场：完好', '创建写入 states')
    await upsertEntity({ projectId: pid, kind: 'character', name: '变体角色', appearance: '新外观' })
    check((JSON.parse((await charRow(u1.id)).states) as string[]).length === 1, '未传 states → 保留')
    await upsertEntity({ projectId: pid, kind: 'character', name: '变体角色', states: [] })
    check((JSON.parse((await charRow(u1.id)).states) as string[]).length === 1, '空数组 → 不覆盖')
    await upsertEntity({ projectId: pid, kind: 'character', name: '变体角色', states: ['第5场受伤：额头绷带', '第9场：泥水满身'] })
    const after = JSON.parse((await charRow(u1.id)).states) as string[]
    check(after.length === 2 && after[0] === '第5场受伤：额头绷带', '非空数组 → 覆盖（内容字段语义）')

    // ---- normalizeSpec 保留 ----
    const ns = normalizeSpec({ name: 'A', states: [' s1 ', 's1', '', 5, 's2'] })
    check(!!ns && JSON.stringify(ns.states) === '["s1","s2"]', 'normalizeSpec：trim/去重/过滤非串')
    check(normalizeSpec({ name: 'B' })?.states === undefined, '无 states → undefined')
    check(normalizeSpec({ name: 'C', states: 'x' })?.states === undefined, '非数组 → undefined')
    check(normalizeSpec({ name: 'D', states: [] })?.states === undefined, '空数组 → undefined（省略）')

    // ---- HTTP 读写 ----
    const cr = await jreq('POST', '/api/v1/entities', { kind: 'character', project_id: pid, name: 'HTTP 变体', states: [' 第3场：奔跑 ', '第3场：奔跑', ''] })
    check(cr.status === 201 && JSON.stringify(cr.body?.entity?.states) === '["第3场：奔跑"]', 'POST 清洗入库 + 响应 states')
    const hid = cr.body?.entity?.id as number
    const up = await jreq('PUT', `/api/v1/entities/${hid}`, { states: ['第5场受伤：额头绷带'] })
    check(JSON.stringify(up.body?.entity?.states) === '["第5场受伤：额头绷带"]', 'PUT 替换 states')
    const clear = await jreq('PUT', `/api/v1/entities/${hid}`, { states: [] })
    check(JSON.stringify(clear.body?.entity?.states) === '[]', 'PUT 空数组 → 清空')
    await db.update(characters).set({ states: 'not-json' }).where(eq(characters.id, hid))
    const badJson = await jreq('GET', `/api/v1/entities/${hid}`)
    check(JSON.stringify(badJson.body?.entity?.states) === '[]', '坏 JSON → [] 容错（读侧）')
    const sc = await jreq('POST', '/api/v1/entities', { kind: 'scene', project_id: pid, name: 'states 场景', states: ['不应生效'] })
    check(sc.status === 201 && JSON.stringify(sc.body?.entity?.states) === '[]', 'POST scene + states → 忽略（仅角色）')
    const scId = sc.body?.entity?.id as number
    const scUp = await jreq('PUT', `/api/v1/entities/${scId}`, { states: ['x'] })
    check(JSON.stringify(scUp.body?.entity?.states) === '[]', 'PUT scene + states → 忽略')
    const badType = await jreq('PUT', `/api/v1/entities/${hid}`, { states: 'abc' })
    check(badType.status === 400 && badType.body?.error?.code === 'bad_states', `states 非数组 → 400 bad_states（${badType.status}）`)
  }

  /** ⑦ 回归：前序探针子进程全绿 */
  const sectionRegression = async (): Promise<void> => {
    const { spawnSync } = await import('node:child_process')
    const probes = ['probe:m7', 'probe:m8', 'probe:m10', 'probe:m11', 'probe:m12']
    const childEnv = { ...process.env }
    delete childEnv.CSTUDIO_ROOT
    delete childEnv.CSTUDIO_DATA
    delete childEnv.CSTUDIO_WORKSPACE
    delete childEnv.AGENT_LLM_BASE_URL
    delete childEnv.AGENT_LLM_API_KEY
    delete childEnv.AGENT_LLM_MODEL
    for (const p of probes) {
      // 直接以 tsx 运行前序探针脚本（M26 runner 收敛后无 probe:<id> 包脚本，经 process.execPath 与 run-probes 同款启动式）
      const script = join(REPO_ROOT, 'apps', 'server', 'scripts', `${p.replace('probe:', 'probe-')}.ts`)
      const r = spawnSync(process.execPath, ['--import', 'tsx', script], {
        cwd: join(REPO_ROOT, 'apps', 'server'),
        env: childEnv,
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
    'style-multi': sectionStyleMulti,
    vision: sectionVision,
    'video-refs': sectionVideoRefs,
    upload: sectionUpload,
    polish: sectionPolish,
    states: sectionStates,
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
    console.log(`\n==== M13 探针结果: ${failed > 0 ? `${failed} 项失败` : '全部通过'} ====`)
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
