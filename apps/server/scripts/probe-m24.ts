/**
 * M24 探针（内容质量与国际化）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m24.ts [--section=summary|eval|translate|bilingual|compliance]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录
 * （独立 studio.db + workspace），不触碰开发库（同 probe-m3~m23）。零网络、零计费：
 * 直测服务层纯函数与注册面，不触发引擎执行、真实生成与 LLM 调用（LLM 通道走 e2e 实弹）。
 *
 * section（默认 all；P0 冒烟骨架，P1/P2/P3 逐批填充全矩阵，spec §7）：
 *   summary    [P1] name 四型 / 合并构造 / 截断护栏（P0 已直测）+ upsert 幂等保 id / recall types / 钩子开关（P1 补）
 *   eval       [P1] parseEvalScores / aggregateEvalMatrix / renderEvalReport（P0 已直测）+ 变体展开（P1 补）
 *   translate  [P2] target_lang 默认 zh 回归 / 命名规范纯函数 / params.lang（P2 填充）
 *   bilingual  [P2] buildBilingualSrt 矩阵 / 翻译契约解析 / resolveVoiceChain 七级（P2 填充）
 *   compliance [P3] 词库解析 / scanText 命中矩阵 / parseLlmVerdict / overallStatus（P0 已直测）+ 写回/视图（P3 补）
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
// 清理历史残留：libsql 在 Windows 下不释放文件句柄（close 后仍 EBUSY）——本次运行在创建自己的目录前
// 清掉旧的（占用中则跳过，自动收敛为最多一份）。
import { sweepStaleProbeTempDirs, writeProbePidSentinel } from './probe-lib'

const TMP_PREFIX = 'acs-probe-m24-'
// 清理历史残留（跳过存活并行探针目录，避免并行 --jobs≥2 下嵌套回归子探针与顶层同名探针互删 SQLite 库）
sweepStaleProbeTempDirs(TMP_PREFIX)
const TMP = mkdtempSync(join(tmpdir(), TMP_PREFIX))
writeProbePidSentinel(TMP)
process.env.CSTUDIO_ROOT = REPO_ROOT
process.env.CSTUDIO_DATA = join(TMP, 'data')
process.env.CSTUDIO_WORKSPACE = join(TMP, 'workspace')
mkdirSync(process.env.CSTUDIO_DATA, { recursive: true })
mkdirSync(process.env.CSTUDIO_WORKSPACE, { recursive: true })
// [P2] 模板/提示词桥接：junction（零拷贝）指向真实 workspace/templates・prompts（translate 节读结构断言；探针只读不写）
const bridgeReadOnly = (sub: 'templates' | 'prompts'): void => {
  const real = join(REPO_ROOT, 'workspace', sub)
  const tmp = join(process.env.CSTUDIO_WORKSPACE!, sub)
  if (existsSync(tmp) || !existsSync(real)) return
  try {
    symlinkSync(real, tmp, 'junction')
  } catch {
    cpSync(real, tmp, { recursive: true })
  }
}
bridgeReadOnly('templates')
bridgeReadOnly('prompts')
const COMPLIANCE_TMP = join(process.env.CSTUDIO_WORKSPACE, 'compliance')
mkdirSync(COMPLIANCE_TMP, { recursive: true })

const SECTIONS = ['summary', 'eval', 'translate', 'bilingual', 'compliance'] as const

/**
 * 模型桥接（同 probe-m3）：隔离 data/ 指向临时目录，而 embedding 模型属外部资产——
 * 建 junction（零拷贝）指向仓库真实 data/models；无真模型则留空（调用侧 embeddingStatus 判 SKIP）。
 */
const bridgeModels = (): void => {
  const realModels = join(REPO_ROOT, 'data', 'models')
  const tmpModels = join(process.env.CSTUDIO_DATA!, 'models')
  if (existsSync(tmpModels) || !existsSync(realModels)) return
  try {
    symlinkSync(realModels, tmpModels, 'junction')
  } catch {
    cpSync(realModels, tmpModels, { recursive: true })
  }
}

const canon = (v: unknown): string => JSON.stringify(v)

async function main(): Promise<void> {
  // src 模块全部动态加载（环境变量已隔离）
  const { createLogger } = await import('../src/logger')
  const { summaryName, buildMergeInput, guardSummaryLen, SummaryParamError, SUMMARY_DEFAULT_MAX_CHARS } = await import(
    '../src/services/memory-summary'
  )
  const { clampScore, parseEvalScores, aggregateEvalMatrix, renderEvalReport, compositeOf } = await import('../src/services/eval')
  const { normalizeText, parseRules, scanText, parseLlmVerdict, overallStatus, stripCodeFence } = await import(
    '../src/services/compliance'
  )
  const { loadRules } = await import('../src/services/compliance')
  const { KNOWN_ACTIONS } = await import('../src/pipeline/loader')
  const { listActionKeys } = await import('../src/pipeline/actions')

  const log = createLogger('probe-m24')
  let failed = 0
  const check = (cond: boolean, msg: string): void => {
    if (cond) log.info(`  PASS  ${msg}`)
    else {
      failed += 1
      log.error(`  FAIL  ${msg}`)
    }
  }

  // ================= summary：摘要纯函数面（P0 冒烟；DB/钩子面 P1 补） =================
  const sectionSummary = async (): Promise<void> => {
    // name 四型约定
    check(summaryName('project', {}) === 'summary:project', 'summaryName project → summary:project')
    check(summaryName('series', { seriesId: 7 }) === 'summary:series:7', 'summaryName series+id → summary:series:7')
    check(summaryName('episode', { episodeId: 3 }) === 'summary:episode:3', 'summaryName episode → summary:episode:3')
    check(summaryName('custom', { name: '卷一' }) === 'summary:custom:卷一', 'summaryName custom → summary:custom:卷一')
    const bad = (fn: () => string): boolean => {
      try {
        fn()
        return false
      } catch (e) {
        return e instanceof SummaryParamError
      }
    }
    check(bad(() => summaryName('series', {})), 'series 缺 series_id → SummaryParamError')
    check(bad(() => summaryName('series', { seriesId: 0 })), 'series id=0 → SummaryParamError')
    check(bad(() => summaryName('episode', { episodeId: 1.5 })), 'episode 非整数 → SummaryParamError')
    check(bad(() => summaryName('custom', { name: '  ' })), 'custom 空白 name → SummaryParamError')
    check(bad(() => summaryName('custom', { name: 'a\u0000b' })), 'custom 含 NUL → SummaryParamError')
    // 合并输入构造
    check(buildMergeInput(null, '新料', true) === '新料', 'merge 无既有 → 仅新素材')
    check(buildMergeInput('旧摘要', '新料', false) === '新料', 'merge=false → 仅新素材')
    check(buildMergeInput('旧摘要', '新料', true) === '【既有摘要】\n旧摘要\n\n【新素材】\n新料', 'merge 有既有 → 既有+新料结构')
    check(buildMergeInput('  ', '新料', true) === '新料', '既有摘要空白 → 视同无既有')
    // 截断护栏
    check(guardSummaryLen('  摘要  ', 600) === '摘要', 'guard trim 通过')
    let threw = false
    try {
      guardSummaryLen('   ', 600)
    } catch {
      threw = true
    }
    check(threw, 'guard 空白输出 → 抛错')
    const limit = Math.floor(SUMMARY_DEFAULT_MAX_CHARS * 1.5)
    threw = false
    try {
      guardSummaryLen('字'.repeat(limit), SUMMARY_DEFAULT_MAX_CHARS)
    } catch {
      threw = true
    }
    check(!threw, `guard 恰在上限（${limit}）通过`)
    threw = false
    try {
      guardSummaryLen('字'.repeat(limit + 1), SUMMARY_DEFAULT_MAX_CHARS)
    } catch {
      threw = true
    }
    check(threw, `guard 超限（${limit + 1}）抛错`)
    // ---- [P1] DB 面：幂等 / recall types / 自动钩子门控（隔离库；embed 本地计算零网络计费，同 probe-m3 先例）----
    const { db, initDb } = await import('../src/db')
    const { eq: deq } = await import('drizzle-orm')
    const { episodes, pipelineRuns, pipelineSteps, projects, settings } = await import('../src/db/schema')
    const { upsertMemory, recallMemories } = await import('../src/services/memory')
    const { getSummaryContent } = await import('../src/services/memory-summary')
    const { isAutoSummaryEnabled, gatherEpisodeContext, handleRunSettled } = await import('../src/services/memory-autosummary')
    const writeTextAssetFn = (await import('../src/services/storage')).writeTextAsset
    await initDb()
    bridgeModels()
    const { embeddingStatus } = await import('../src/services/embedding')
    const embOk = (await embeddingStatus()).ready
    if (!embOk) {
      log.warn('SKIP  summary DB 面 —— embedding 模型未就绪（运行 pnpm --filter @acs/server model:prepare）', {})
      return
    }
    const T0 = 1_700_000_000_000
    const [proj] = await db
      .insert(projects)
      .values({ name: 'M24 探针', genre: 'other', templateKey: 'x', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
      .returning()
    const pid = proj!.id

    const u1 = await upsertMemory({ projectId: pid, type: 'summary', name: 'summary:project', content: '第一版摘要' })
    const u2 = await upsertMemory({ projectId: pid, type: 'summary', name: 'summary:project', content: '第二版摘要更新' })
    check(u1.created && !u2.created && u1.id === u2.id, '具名 upsert：二次写保 id / created=false')
    check((await getSummaryContent(pid, 'summary:project')) === '第二版摘要更新', 'getSummaryContent 读回最新')
    check((await getSummaryContent(pid, 'summary:none')) === null, '无同名摘要 → null')

    await upsertMemory({ projectId: pid, type: 'note', content: '独立笔记与摘要无关' })
    const onlySummary = await recallMemories({ projectId: pid, query: '摘要', limit: 5, types: ['summary'] })
    check(onlySummary.length > 0 && onlySummary.every((r) => r.type === 'summary'), 'recall types=[summary] 只返回摘要')
    const noFilter = await recallMemories({ projectId: pid, query: '摘要', limit: 5 })
    check(noFilter.length >= onlySummary.length && noFilter.some((r) => r.type === 'note'), '无 types → 超集（含 note）')

    // 钩子门控矩阵
    check((await isAutoSummaryEnabled()) === false, 'memory.auto_summary 缺省关')
    const mkRun = async (status: string): Promise<number> =>
      (
        await db
          .insert(pipelineRuns)
          .values({ projectId: pid, templateKey: 'x', status, input: '{}', createdAt: T0, updatedAt: T0 })
          .returning()
      )[0]!.id
    const runId = await mkRun('completed')
    const [ep] = await db
      .insert(episodes)
      .values({ projectId: pid, seriesId: 1, number: 1, title: '第一集', latestRunId: runId, createdAt: T0, updatedAt: T0 })
      .returning()
    check((await gatherEpisodeContext(runId)) === null, '开关关：命中也跳过（零行为）')
    await db.insert(settings).values({ key: 'memory.auto_summary', value: 'true', updatedAt: T0 })
    check((await gatherEpisodeContext(runId)) === null, '开关开但无素材 → null')
    const epAsset = await writeTextAssetFn(pid, { name: 'ep1.md', content: '第一集剧本：主角北上', purpose: 'script', runId })
    await db.update(episodes).set({ contentAssetId: epAsset.id }).where(deq(episodes.id, ep!.id))
    const ctxHit = await gatherEpisodeContext(runId)
    check(ctxHit != null && ctxHit.episodeId === ep!.id && ctxHit.sourceText.includes('北上'), '命中 → contentAssetId 装配素材')
    await db.update(episodes).set({ contentAssetId: null }).where(deq(episodes.id, ep!.id))
    const ctxTop = await gatherEpisodeContext(runId)
    check(ctxTop != null && ctxTop.sourceText.includes('北上'), 'content 缺失 → run 文本产物 top3 回退')
    await db.update(episodes).set({ contentAssetId: epAsset.id }).where(deq(episodes.id, ep!.id))
    const runRunning = await mkRun('running')
    await db.update(episodes).set({ latestRunId: runRunning }).where(deq(episodes.id, ep!.id))
    check((await gatherEpisodeContext(runRunning)) === null, 'run 非 completed → 跳过')
    await db.update(episodes).set({ latestRunId: runId }).where(deq(episodes.id, ep!.id))
    check((await gatherEpisodeContext(await mkRun('completed'))) === null, '无集关联 run → 跳过')
    await db
      .insert(pipelineSteps)
      .values({ runId, seq: 1, stepKey: 'sum', actionKey: 'memory_summary', status: 'succeeded', createdAt: T0, updatedAt: T0 })
    check((await gatherEpisodeContext(runId)) === null, '模板含 memory_summary 步 → 跳过（防双份计费）')
    await db.delete(pipelineSteps).where(deq(pipelineSteps.runId, runId))
    const captured: { p?: import('../src/services/memory-summary').SummarizeParams } = {}
    const fake = async (p: import('../src/services/memory-summary').SummarizeParams) => {
      captured.p = p
      return { memoryId: 999, created: true, name: `summary:episode:${p.episodeId}`, chars: 10, mergedFromChars: 0, sourceChars: p.sourceText.length, usage: null, provider: 'fake', model: 'fake' }
    }
    const done = await handleRunSettled(runId, { summarize: fake })
    check(
      done === 'done' && captured.p?.level === 'episode' && captured.p?.episodeId === ep!.id && captured.p?.runId === runId,
      'handleRunSettled：注入假 summarizer 命中 + 参数透传',
    )
    await db.update(settings).set({ value: 'false' }).where(deq(settings.key, 'memory.auto_summary'))
    check((await handleRunSettled(runId, { summarize: fake })) === 'skip', '开关复关 → skip')
  }

  // ================= eval：评分纯函数三件套（P0 冒烟；变体展开 P1 补） =================
  const sectionEval = async (): Promise<void> => {
    check(clampScore(8.54) === 8.5 && clampScore(-2) === 0 && clampScore(11) === 10, 'clampScore 钳制+一位小数')
    check(clampScore('8' as unknown) === null && clampScore(NaN) === null, 'clampScore 非数值 → null')
    const okJson = '{"scores":[{"asset_id":1,"consistency":8.5,"style":7,"quality":6.5,"note":"n1"},{"asset_id":2,"consistency":9,"style":9,"quality":9,"note":"n2"}]}'
    const p1 = parseEvalScores('```json\n' + okJson + '\n```', [1, 2, 3])
    check(p1.parsed && p1.scores.length === 2 && p1.skipped === 0, 'parseEvalScores 围栏 + 正常两行')
    check(p1.scores[0]?.assetId === 1 && p1.scores[1]?.quality === 9, 'asset_id 对齐透传')
    const p2 = parseEvalScores('{"scores":[{"asset_id":99,"consistency":1,"style":1,"quality":1},{"consistency":5,"style":5,"quality":5},{"asset_id":1,"consistency":5,"style":5,"quality":5},{"asset_id":1,"consistency":6,"style":6,"quality":6}]}', [1, 2])
    check(p2.parsed && p2.scores.length === 1 && p2.skipped === 3, '越界 id / 缺 id / 重复 id 各跳过计数')
    const p3 = parseEvalScores('这不是 JSON', [1])
    check(!p3.parsed && p3.scores.length === 0, '全坏 → parsed:false（降级 raw 报告信号）')
    const p4 = parseEvalScores('[{"asset_id":1,"consistency":10,"style":0,"quality":5.5}]', [1])
    check(p4.parsed && p4.scores.length === 1, 'root 直接数组宽容')
    const p5 = parseEvalScores('{"scores":[{"asset_id":1,"consistency":8,"style":"x","quality":5}]}', [1])
    check(p5.parsed && p5.scores.length === 0 && p5.skipped === 1, '任一维非法 → 整行作废')
    // 聚合
    const scores = [
      { assetId: 1, consistency: 8, style: 6, quality: 7, note: 'a' },
      { assetId: 2, consistency: 6, style: 6, quality: 6, note: 'b' },
      { assetId: 3, consistency: 9, style: 9, quality: 9, note: 'c' },
    ]
    const groups = [
      { label: 'B组', assetIds: [2] },
      { label: 'A组', assetIds: [1, 3] },
    ]
    const agg = aggregateEvalMatrix(scores, groups)
    check(canon(agg.variants.map((v) => v.label)) === canon(['A组', 'B组']), 'variants 输出 label 字典序（确定性）')
    const av = agg.variants.find((v) => v.label === 'A组')!
    const bv = agg.variants.find((v) => v.label === 'B组')!
    check(compositeOf(scores[0]!) === 7 && av.n === 2 && av.mean === 8 && av.min === 7 && av.max === 9, 'A组 n/mean/min/max')
    check(av.dims.consistency.mean === 8.5 && av.dims.quality.max === 9, 'A组三维分布')
    check(bv.missing === 0 && bv.rank === 2 && av.rank === 1, '排名：A 第一 B 第二')
    const agg2 = aggregateEvalMatrix([], [{ label: '空组', assetIds: [1] }])
    check(agg2.variants[0]?.n === 0 && agg2.variants[0]?.missing === 1 && agg2.variants[0]?.mean === 0, '空评分 → n0/missing1/mean0 不抛')
    // 并列稳定性：同 mean 按 label 字典序
    const tie = aggregateEvalMatrix(
      [
        { assetId: 1, consistency: 7, style: 7, quality: 7, note: '' },
        { assetId: 2, consistency: 7, style: 7, quality: 7, note: '' },
      ],
      [
        { label: 'Z', assetIds: [1] },
        { label: 'Y', assetIds: [2] },
      ],
    )
    check(tie.variants.find((v) => v.label === 'Y')?.rank === 1 && tie.variants.find((v) => v.label === 'Z')?.rank === 2, '并列 → label 字典序定名次')
    // 报告
    const md = renderEvalReport(agg, scores, groups)
    check(md.includes('| 变体 | 排名 |') && md.includes('```csv') && md.includes('asset_id,label,consistency'), '报告含 md 表头 + CSV 段')
    check(md.split('\n').some((l) => l.startsWith('1,A组,8,6,7,a')), 'CSV 明细行结构')
    const mdNote = renderEvalReport(
      aggregateEvalMatrix([{ assetId: 1, consistency: 1, style: 1, quality: 1, note: '含,逗"号' }], [{ label: 'G', assetIds: [1] }]),
      [{ assetId: 1, consistency: 1, style: 1, quality: 1, note: '含,逗"号' }],
      [{ label: 'G', assetIds: [1] }],
    )
    check(mdNote.includes('"含,逗""号"'), 'CSV note 逗号/引号转义')
    // ---- [P1] 端点校验矩阵（EvalParamError 在 LLM/DB 之前；不触发真实调用）----
    const { runConsistencyEval, scoreConsistencyEval, EvalParamError } = await import('../src/services/eval-service')
    const paramErr = async (fn: () => Promise<unknown>): Promise<'param' | 'other' | 'none'> => {
      try {
        await fn()
        return 'none'
      } catch (e) {
        return e instanceof EvalParamError ? 'param' : 'other'
      }
    }
    check((await paramErr(() => runConsistencyEval({ project_id: 1, template_key: 'x', variants: [] }))) === 'param', 'run：variants 空 → 400 语义')
    check((await paramErr(() => runConsistencyEval({ project_id: 1, template_key: 'x', variants: [{ label: 'A' }] }))) === 'param', 'run：1 组 → 错（需 2–6）')
    check((await paramErr(() => runConsistencyEval({ project_id: 1, template_key: 'x', variants: [{ label: 'A' }, { label: 'A' }] }))) === 'param', 'run：label 重复 → 错')
    check(
      (await paramErr(() => runConsistencyEval({ project_id: 1, template_key: 'nonexistent-m24-tpl', variants: [{ label: 'A' }, { label: 'B' }] }))) === 'other',
      'run：模板不存在 → InvalidRunInputError（兜底 400）',
    )
    check(
      (await paramErr(() => scoreConsistencyEval({ project_id: 1, groups: Array.from({ length: 7 }, (_, i) => ({ label: `g${i}`, asset_ids: [i + 1] })) }))) === 'param',
      'score：7 组超上限',
    )
    check((await paramErr(() => scoreConsistencyEval({ project_id: 1, groups: [{ label: 'A', asset_ids: [1, 1] }] }))) === 'param', 'score：组内重复资产')
    check((await paramErr(() => scoreConsistencyEval({ project_id: 1, groups: [{ label: 'A', asset_ids: [1] }, { label: 'B', asset_ids: [1] }] }))) === 'param', 'score：跨组重复资产')
    check(
      (await paramErr(() => scoreConsistencyEval({ project_id: 1, groups: [{ label: 'A', asset_ids: Array.from({ length: 25 }, (_, i) => i + 1) }] }))) === 'param',
      'score：25 图超上限 24',
    )
    check((await paramErr(() => scoreConsistencyEval({ project_id: 1, groups: [{ label: ' ', asset_ids: [1] }] }))) === 'param', 'score：label 空白')
    check((await paramErr(() => scoreConsistencyEval({ project_id: 1, groups: [{ label: 'A', asset_ids: [999999] }] }))) === 'other', 'score：不存在资产 → RefResolveError（兜底 400）')
  }

  // ================= [P2] translate：platform-adapt v2 / translate-export / 命名规范（8 断言） =================
  const sectionTranslate = async (): Promise<void> => {
    const { loadTemplate } = await import('../src/pipeline/loader')
    const { interpolate } = await import('../src/pipeline/refs')
    const { loadPromptTemplate } = await import('../src/services/llm')
    // ---- 形态 A：platform-adapt v2（target_lang 缺省 zh = 回归基准）----
    const pa = loadTemplate('platform-adapt')
    check(pa.version === 3, `T1 platform-adapt 现行 v3（v2 target_lang + v3 合规末步；实际 version=${pa.version}）`)
    const tl = pa.inputs.find((i) => i.key === 'target_lang') as { kind?: string; required?: boolean; default?: unknown } | undefined
    check(tl?.default === 'zh' && tl?.kind === 'text' && tl?.required !== true, `T2 target_lang 缺省 zh（${canon(tl)}）`)
    const adaptStep = pa.steps.find((s) => s.key === 'adapt')
    check((adaptStep?.inputs as Record<string, unknown> | undefined)?.['target_lang'] === 'input.target_lang', 'T3 adapt 步接线 input.target_lang（ai_text 全量注入自动进 prompt）')
    check(adaptStep?.params?.['name_tpl'] === 'adapt.md' && adaptStep?.params?.['output_purpose'] === 'export', 'T4 zh 回归：产物名/purpose 逐字不变')
    check(loadPromptTemplate('adapt-text.md').includes('target_lang'), 'T5 adapt-text.md 含目标语言语义段')
    // ---- 形态 B：translate-export 链 ----
    const te = loadTemplate('translate-export')
    check(te.steps.map((s) => s.key).join(',') === 'ingest,translate,remember', `T6 步骤链 [ingest,translate,remember]（${te.steps.map((s) => s.key).join('/')}）`)
    const trStep = te.steps.find((s) => s.key === 'translate')
    check(
      trStep?.params?.['prompt_tpl'] === 'translate-text.md' && trStep?.params?.['output_purpose'] === 'export',
      `T7 translate 步 params（${canon(trStep?.params)}）`,
    )
    check(interpolate(String(trStep?.params?.['name_tpl']), { target_lang: 'en' }) === 'translated-en.md', 'T8 命名规范：translated-{lang}.md 内插（params.lang 命名契约）')
    const memStep = te.steps.find((s) => s.key === 'remember')
    check(memStep?.action === 'memory_write' && memStep?.params?.['type'] === 'translation', 'T8b 经验沉淀 memory_write type=translation')
  }

  // ================= [P2] bilingual：buildBilingualSrt / 翻译契约解析 / voice_map 七级（12 断言） =================
  const sectionBilingual = async (): Promise<void> => {
    const { buildBilingualSrt, parseSrtCues } = await import('../src/services/creation/gen/subtitle')
    const { parseLineTranslations } = await import('../src/pipeline/actions/subtitle')
    const { resolveVoiceChain } = await import('../src/pipeline/actions/tts')
    const segs = [
      { id: '1', startMs: 0, endMs: 1500, text: '你好世界' },
      { id: '2', startMs: 1500, endMs: 3200, text: '第二句' },
    ]
    const dst = new Map<string, string>([['1', 'Hello world']])
    // ---- buildBilingualSrt 矩阵 ----
    const both = buildBilingualSrt(segs, dst, 'both')
    check(both.bilingual !== null && both.bilingual.includes('你好世界\nHello world'), 'BS1 both：双语 cue = 原文\\n译文')
    check(both.target !== null && both.target.includes('Hello world') && !both.target.includes('你好'), 'BS2 both：纯目标语产物不含原文')
    const merged = buildBilingualSrt(segs, dst, 'merged')
    check(merged.target === null && merged.bilingual !== null, 'BS3 merged：仅双语（target=null）')
    check(merged.bilingual!.includes('第二句') && parseSrtCues(merged.bilingual!)[1]!.text === '第二句', 'BS4 缺失句回退原文（cue 无双语换行）')
    check(both.bilingual!.includes('00:00:01,500'), 'BS5 ms→SRT 时间戳换算（1500ms → 00:00:01,500）')
    check(buildBilingualSrt([], dst, 'both').bilingual === null, 'BS6 空段 → 双 null')
    check(buildBilingualSrt([{ id: 'x', startMs: 5000, endMs: 1000, text: '倒挂' }], new Map(), 'both').bilingual!.includes('00:00:05,000 --> 00:00:05,000'), 'BS7 end<start 收敛不早于 start')
    // ---- 翻译契约解析 ----
    const p1 = parseLineTranslations('[{"id":1,"text":"你好","dst":"Hello"},{"id":"2","text":"再见","dst":"Bye"}]')
    check(p1.get('1') === 'Hello' && p1.get('2') === 'Bye', 'PC1 根数组 + 数字/字符串 id 对齐')
    const p2 = parseLineTranslations('```json\n{"lines":[{"id":"a","dst":"A!"}]}\n```')
    check(p2.get('a') === 'A!', 'PC2 围栏 + {lines} 包裹宽容')
    check(parseLineTranslations('坏输入没 JSON').size === 0 && parseLineTranslations('[{"id":1,"dst":""},{"id":2}]').size === 0, 'PC3 坏输入/空 dst → 空 map（全量回退原文）')
    // ---- resolveVoiceChain 七级（voice_map）----
    const h1 = resolveVoiceChain({ langVoice: 'Cherry', paramVoice: 'alex' })
    check(h1.voice === 'Cherry' && h1.source === 'voice_map', `VM1 voice_map 命中（${h1.voice}/${h1.source}）`)
    const h2 = resolveVoiceChain({ lineVoice: 'Serena', langVoice: 'Cherry' })
    check(h2.source === 'line', `VM2 line 优先于 voice_map（${h2.source}）`)
    const h3 = resolveVoiceChain({ paramVoice: 'alex', settingsVoice: 's', instanceVoice: 'i' })
    check(h3.voice === 'alex' && h3.source === 'params', 'VM3 不传 langVoice：旧行为逐字不变（params 级）')
    check(resolveVoiceChain({ langVoice: '成年女声、清爽亲和', paramVoice: 'alex' }).source === 'params', 'VM4 非 ASCII 短语 → 跳级降级')
  }

  // ================= compliance：词库与判定纯函数（P0 冒烟；写回/视图 P3 补） =================
  const sectionCompliance = async (): Promise<void> => {
    check(stripCodeFence('```json\n{"a":1}\n```') === '{"a":1}', 'stripCodeFence 剥围栏')
    check(normalizeText('ＣＵＥ　测') === 'cue 测', 'normalizeText 全角→半角 + 小写')
    const rules = parseRules('# 注释\n\n广告|最好|block\n广告|第一|block\n医疗|无效退款\n坏行无词段||\n广告|最好|block\n辱骂|xx|BLOCK')
    check(rules.length === 4, `parseRules 有效行 4（注释/空行/坏行/重复剔除）：${rules.length}`)
    check(rules.some((r) => r.word === '无效退款' && r.level === 'warn'), '级别缺省 → warn')
    check(rules.filter((r) => r.word === '最好').length === 1, '重复词保留首见')
    check(rules.some((r) => r.word === 'xx' && r.level === 'warn'), '级别非法（BLOCK 大写）→ warn 兜底')
    // 临时词库文件 → loadRules 现读
    writeFileSync(join(COMPLIANCE_TMP, 'words.txt'), '广告|最好|block\n广告|行业领先|warn\n')
    const loaded = loadRules()
    check(loaded.source === 'file' && loaded.rules.length === 2, 'loadRules 现读临时词库')
    const hits = scanText('这是"最好"的产品，行业领先，BEST 时代', [
      { category: '广告', word: '最好', level: 'block' },
      { category: '广告', word: '行业领先', level: 'warn' },
      { category: '广告', word: 'ＢＥＳＴ', level: 'warn' },
    ])
    check(hits.length === 3 && hits[0]?.level === 'block', 'scanText：block 先 + 全角词命中（ＢＥＳＴ→best）')
    check(hits.find((h) => h.word === '最好')?.count === 1 && hits.find((h) => h.word === 'ＢＥＳＴ') != null, '命中计数与全角归一')
    check(scanText('', [{ category: 'c', word: 'x', level: 'warn' }]).length === 0, '空文本零命中')
    check(scanText('aaabb', [{ category: 'c', word: 'ab', level: 'warn' }])[0]?.count === 1, '重叠计数不重复（ab 非重叠推进）')
    // LLM 复审解析
    const v1 = parseLlmVerdict('{"verdict":"risk","items":[{"category":"广告合规","quote":"最好","reason":"绝对化用语"}]}')
    check(v1?.verdict === 'risk' && v1.items.length === 1, 'parseLlmVerdict 正常')
    check(parseLlmVerdict('坏 JSON') === null && parseLlmVerdict('[1,2]') === null, '坏 JSON / 非对象 → null（降级）')
    check(parseLlmVerdict('{"verdict":"maybe","items":[]}') === null, 'verdict 非法 → null')
    check(parseLlmVerdict('{"verdict":"pass","items":[{"category":"x"}]}')?.items.length === 0, 'items 缺 reason → 行剔除')
    // 综合判定矩阵
    check(overallStatus([{ word: 'w', category: 'c', level: 'block', count: 1 }], null) === 'block', 'block 词库 → block（LLM null 不影响）')
    check(overallStatus([], { verdict: 'block', items: [] }) === 'block', 'LLM block → block')
    check(overallStatus([{ word: 'w', category: 'c', level: 'warn', count: 1 }], null) === 'warn', 'warn 命中 → warn')
    check(overallStatus([{ word: 'w', category: 'c', level: 'warn', count: 1 }], { verdict: 'pass', items: [] }) === 'warn', '词库 warn + LLM pass → warn（并集）')
    check(overallStatus([], { verdict: 'risk', items: [] }) === 'warn', '无命中 + LLM risk → warn')
    check(overallStatus([], null) === 'pass', '双轨皆干净 → pass')
    // 注册面（loader 白名单 + action registry 双同步）
    const known = KNOWN_ACTIONS as readonly string[]
    check(known.includes('memory_summary') && known.includes('compliance_check'), 'KNOWN_ACTIONS 含两新 action')
    const keys = listActionKeys()
    check(keys.includes('memory_summary') && keys.includes('compliance_check'), 'action registry 已注册两新 action')

    // ---- [P3] 标记写回 / rules 只读视图 / on_block 双语义（隔离库 + llm_review=false 零 LLM 零计费）----
    const { readFileSync } = await import('node:fs')
    const { db, initDb } = await import('../src/db')
    await initDb()
    const { eq: deq } = await import('drizzle-orm')
    const { assets: assetsTbl, pipelineRuns, pipelineSteps, projects } = await import('../src/db/schema')
    const { absPathOf, writeTextAsset } = await import('../src/services/storage')
    const { recordCompliance, rulesView, BASE_RULES } = await import('../src/services/compliance')
    const { complianceCheck } = await import('../src/pipeline/actions/compliance-check')
    const { StepError } = await import('../src/pipeline/types')
    const T0 = 1_700_000_000_000
    const [proj] = await db
      .insert(projects)
      .values({ name: 'M24 合规探针', genre: 'other', templateKey: 'x', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
      .returning()
    const pid = proj!.id
    const [run] = await db
      .insert(pipelineRuns)
      .values({ projectId: pid, templateKey: 'x', status: 'running', input: '{}', createdAt: T0, updatedAt: T0 })
      .returning()
    const [step] = await db
      .insert(pipelineSteps)
      .values({ runId: run!.id, seq: 1, stepKey: 'cc', actionKey: 'compliance_check', status: 'running', createdAt: T0, updatedAt: T0 })
      .returning()
    // rulesView：本节临时词库（2 条均广告类）聚合 + 缺失不抛
    const view = rulesView()
    check(view.total === 2 && view.byCategory['广告'] === 2 && view.source === 'file', `rulesView 聚合（${JSON.stringify(view)}）`)
    rmSync(join(COMPLIANCE_TMP, 'words.txt'))
    const viewMissing = rulesView()
    // [M36·G12.2] 词库缺失不再返空静默：启用内置 BASE_RULES 兜底（source='builtin'），仍不 500
    check(viewMissing.source === 'builtin' && viewMissing.total === BASE_RULES.length, `rulesView 词库缺失 → builtin 兜底 ${viewMissing.total} 条（不 500/不返空）`)
    writeFileSync(join(COMPLIANCE_TMP, 'words.txt'), '广告|最好|block\n广告|行业领先|warn\n')
    // recordCompliance 写回结构（merge 保留既有键 / 二次覆盖 / 不存在 → null）
    const marked = await writeTextAsset(pid, {
      name: 'marked.md',
      content: '行业领先的内容',
      purpose: 'text',
      stepId: step!.id,
      runId: run!.id,
      params: { quality: { ok: true } },
    })
    const m1 = await recordCompliance(marked.id, {
      status: 'warn',
      hits: [{ word: '行业领先', category: '广告', level: 'warn', count: 1 }],
      llm: null,
      checkedAt: T0,
    })
    const m1p = JSON.parse(m1?.params ?? '{}') as Record<string, unknown>
    check(m1p['quality'] != null && (m1p['compliance'] as { status?: string } | undefined)?.status === 'warn', '写回 merge：保留既有 quality 键 + 新增 compliance')
    const m2 = await recordCompliance(marked.id, { status: 'block', hits: [], llm: { verdict: 'block', items: [] }, checkedAt: T0 + 1 })
    const m2p = JSON.parse(m2?.params ?? '{}') as Record<string, unknown>
    const m2c = m2p['compliance'] as { status?: string; llm?: { verdict?: string } }
    check(m2p['quality'] != null && m2c?.status === 'block' && m2c?.llm?.verdict === 'block', '二次写覆盖 compliance（不累积历史）')
    check((await recordCompliance(999999, { status: 'pass', hits: [], llm: null, checkedAt: T0 })) === null, '不存在资产 → null')
    // compliance_check action（mock ctx；当前隔离词库：最好=block / 行业领先=warn）
    const mkCtx = (params: Record<string, unknown>, contentIds: number[], input: Record<string, unknown> = {}) =>
      ({
        run: { id: run!.id, projectId: pid },
        step: { id: step!.id },
        template: {},
        def: { key: 'cc', params },
        input: { ...input },
        settings: {},
        log: () => {},
        assetIdsOf: (k: string) => (k === 'content' ? contentIds : []),
        assetsOf: async (ids: number[]) => {
          const out = []
          for (const i of ids) {
            const r = (await db.select().from(assetsTbl).where(deq(assetsTbl.id, i)).limit(1))[0]
            if (r) out.push(r)
          }
          return out
        },
        readText: async (id: number) => {
          const r = (await db.select().from(assetsTbl).where(deq(assetsTbl.id, id)).limit(1))[0]
          return r?.relPath ? readFileSync(absPathOf(r.relPath), 'utf8') : ''
        },
      }) as unknown as import('../src/pipeline/context').StepContext
    const readMark = async (id: number): Promise<Record<string, unknown> | undefined> => {
      const r = (await db.select().from(assetsTbl).where(deq(assetsTbl.id, id)).limit(1))[0]
      return ((r ? JSON.parse(r.params ?? '{}') : {}) as Record<string, unknown>)['compliance'] as Record<string, unknown> | undefined
    }
    const bad = await writeTextAsset(pid, { name: 'bad.md', content: '这是最好的产品，行业领先', purpose: 'text', stepId: step!.id, runId: run!.id })
    let serr: unknown = null
    try {
      await complianceCheck(mkCtx({ llm_review: false }, [bad.id]))
    } catch (e) {
      serr = e
    }
    check(serr instanceof StepError, 'on_block 缺省 fail：block 命中 → StepError（拦截导出）')
    const badMark = await readMark(bad.id)
    check(badMark?.status === 'block' && ((badMark?.hits as unknown[]) ?? []).length >= 1, '拦截同时标记仍写回 params.compliance')
    const rpts = await db.select().from(assetsTbl).where(deq(assetsTbl.purpose, 'compliance_report'))
    const rp = JSON.parse(rpts.at(-1)?.params ?? '{}') as Record<string, unknown>
    check(rp.overall === 'block' && rp.wordbook === 2 && rp.llmReview === false, `fail 前报告仍落库（${JSON.stringify(rp)}）`)
    const resMark = await complianceCheck(mkCtx({ llm_review: false, on_block: 'mark' }, [bad.id]))
    check(typeof resMark.assetIds[0] === 'number', 'on_block=mark：block 也只标记不失败')
    const good = await writeTextAsset(pid, { name: 'good.md', content: '今天天气不错，适合散步', purpose: 'text', stepId: step!.id, runId: run!.id })
    await complianceCheck(mkCtx({ llm_review: false }, [good.id]))
    check((await readMark(good.id))?.status === 'pass', '干净文本 → pass 标记且放行')
    const resLit = await complianceCheck(mkCtx({ llm_review: false }, [], { content: '一段普通文本' }))
    check(resLit.assetIds.length === 1, 'input.content 字面文本 → 仅入报告（无资产标记路径）')
  }

  const runners: Record<string, () => Promise<void>> = {
    summary: sectionSummary,
    eval: sectionEval,
    translate: sectionTranslate,
    bilingual: sectionBilingual,
    compliance: sectionCompliance,
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
    console.log(`\n==== M24 探针结果: ${failed > 0 ? `${failed} 项失败` : '全部通过'} ====`)
    try {
      rmSync(TMP, { recursive: true, force: true })
    } catch {
      console.log(`临时目录未完全清理（Windows libsql 句柄；下次运行自动清理）: ${TMP}`)
    }
    process.exitCode = failed > 0 ? 1 : 0
  }
}

void main()
