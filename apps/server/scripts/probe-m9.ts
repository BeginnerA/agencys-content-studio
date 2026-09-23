/**
 * M9 探针（小说改编链：章节切分 → 事件图谱 → 改编剧本）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m9.ts [--section=split|batch|contracts|api|template]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录
 * （独立 studio.db + workspace），不触碰开发库（同 probe-m3/m6/m8）。零网络、零计费。
 *
 * section（默认 all）：
 *   split     纯函数 splitChapters / parseChapterRange 边界 + textSplit 全流程（mock ctx 落真实隔离库）
 *   batch     ai_text batch 纯函数：extractBatchItems / batchItemId / buildItemPrompt
 *   contracts validateTextOutput 三新契约：event-json / graph-json / plan-json（正例 + 负例消息）
 *   api       buildNovelBoard 聚合读 + GET /runs/:id/novel-board（app.request 内存 HTTP，零网络）
 *   template  novel-adapt 契约（version=2：M25·G1 扩 accept docx/epub 升版，余面逐字不变）+ 5 提示词存在性 + validateTemplateText 正反例
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
import { sweepStaleProbeTempDirs, writeProbePidSentinel } from './probe-lib'

const TMP_PREFIX = 'acs-probe-m9-'
// 清理历史残留（跳过存活并行探针目录，避免并行 --jobs≥2 下嵌套回归子探针与顶层同名探针互删 SQLite 库）
sweepStaleProbeTempDirs(TMP_PREFIX)
const TMP = mkdtempSync(join(tmpdir(), TMP_PREFIX))
writeProbePidSentinel(TMP)
process.env.CSTUDIO_ROOT = REPO_ROOT
process.env.CSTUDIO_DATA = join(TMP, 'data')
process.env.CSTUDIO_WORKSPACE = join(TMP, 'workspace')
mkdirSync(process.env.CSTUDIO_DATA, { recursive: true })
mkdirSync(process.env.CSTUDIO_WORKSPACE, { recursive: true })

const SECTIONS = ['split', 'batch', 'contracts', 'api', 'template'] as const

async function main(): Promise<void> {
  // src 模块全部动态加载（环境变量已隔离）
  const { initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')

  const log = createLogger('probe-m9')
  let failed = 0
  const check = (cond: boolean, msg: string): void => {
    if (cond) log.info(`  PASS  ${msg}`)
    else {
      failed += 1
      log.error(`  FAIL  ${msg}`)
    }
  }
  const errOf = async (fn: () => Promise<unknown>): Promise<Error | null> => {
    try {
      await fn()
      return null
    } catch (err) {
      return err as Error
    }
  }
  const throwsSync = (fn: () => unknown): Error | null => {
    try {
      fn()
      return null
    } catch (err) {
      return err as Error
    }
  }

  // ---- setup：隔离库初始化 ----
  await initDb()

  /** 建一个探针专用项目行，返回 id */
  const newProject = async (name: string, key: string): Promise<number> => {
    const { db } = await import('../src/db')
    const { projects } = await import('../src/db/schema')
    const t = Date.now()
    const row = (
      await db
        .insert(projects)
        .values({ name, genre: 'other', templateKey: key, settings: '{}', tags: '[]', createdAt: t, updatedAt: t })
        .returning()
    )[0]!
    return row.id
  }

  /** 建一个探针专用 run 行，返回 id */
  const insertRun = async (pid: number, input: Record<string, unknown>): Promise<number> => {
    const { db } = await import('../src/db')
    const { pipelineRuns } = await import('../src/db/schema')
    const t = Date.now()
    const row = (
      await db
        .insert(pipelineRuns)
        .values({
          projectId: pid,
          templateKey: 'novel-adapt',
          status: 'running',
          input: JSON.stringify(input),
          createdAt: t,
          updatedAt: t,
        })
        .returning()
    )[0]!
    return row.id
  }

  /** 建一个探针专用 step 行，返回 id */
  const insertStep = async (runId: number, seq: number, stepKey: string, actionKey: string): Promise<number> => {
    const { db } = await import('../src/db')
    const { pipelineSteps } = await import('../src/db/schema')
    const t = Date.now()
    const row = (
      await db
        .insert(pipelineSteps)
        .values({ runId, seq, stepKey, actionKey, status: 'succeeded', createdAt: t, updatedAt: t })
        .returning()
    )[0]!
    return row.id
  }

  /** 写 step.output（StepOutputDoc：{asset_ids}） */
  const setStepOutput = async (stepId: number, assetIds: number[]): Promise<void> => {
    const { db } = await import('../src/db')
    const { pipelineSteps } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: assetIds }) }).where(eq(pipelineSteps.id, stepId))
  }

  /** 建一条 gen_task 行（M9 文本任务） */
  const insertTask = async (
    pid: number,
    runId: number,
    stepId: number,
    itemId: string,
    status: string,
    resultAssetId: number | null,
  ): Promise<void> => {
    const { db } = await import('../src/db')
    const { genTasks } = await import('../src/db/schema')
    const t = Date.now()
    await db.insert(genTasks).values({
      projectId: pid,
      runId,
      stepId,
      kind: 'text',
      params: JSON.stringify({ itemId, itemKey: 'index', output_purpose: 'events', name: `item-${itemId}.json` }),
      status,
      resultAssetId,
      attempts: 1,
      createdAt: t,
      updatedAt: t,
    })
  }

  // ================= sections =================

  const sectionSplit = async (): Promise<void> => {
    await initDb()
    const { splitChapters, parseChapterRange, textSplit } = await import('../src/pipeline/actions/text-split')
    const { writeTextAsset, readTextAsset } = await import('../src/services/storage')
    const { db } = await import('../src/db')
    const { assets } = await import('../src/db/schema')
    const { inArray } = await import('drizzle-orm')

    // —— 1. parseChapterRange ——
    check(JSON.stringify(parseChapterRange('1-5')) === '[1,2,3,4,5]', "'1-5' → 1..5")
    check(JSON.stringify(parseChapterRange('1,3,5-9')) === '[1,3,5,6,7,8,9]', "'1,3,5-9' → 升序去重")
    check(JSON.stringify(parseChapterRange('2、4，6')) === '[2,4,6]', '中文顿号/逗号分隔')
    check(JSON.stringify(parseChapterRange('3~5')) === '[3,4,5]', "'3~5' 波浪号区间")
    check(JSON.stringify(parseChapterRange('3至5')) === '[3,4,5]', "'3至5' 汉字区间")
    check(JSON.stringify(parseChapterRange('5,1-2')) === '[1,2,5]', '乱序输入 → 升序输出')
    check(parseChapterRange('3-1') === null, '反向区间 3-1 → null')
    check(parseChapterRange('0-3') === null, '0 起始 → null')
    check(parseChapterRange('abc') === null, '非数字 → null')
    check(parseChapterRange('') === null, '空串 → null')
    check(parseChapterRange('1,,3') === null, '空段 → null')

    // —— 2. splitChapters：默认链（章 + 行内引用不误切 + 前言） ——
    const novel = [
      '前言：这是一段引子。',
      '第1章 陨落的天才',
      '正文一。见第2章说明。',
      '第2章 退婚',
      '正文二。',
      '第3章 三年之约',
      '正文三。',
    ].join('\n')
    const r1 = splitChapters(novel, null)
    check(r1.chapters.length === 3, `默认链识别 3 章（实际 ${r1.chapters.length}）`)
    check(r1.chapters[0]!.title === '陨落的天才' && r1.chapters[1]!.title === '退婚', '章标题取捕获组 2')
    check(r1.chapters[0]!.content.startsWith('第1章 陨落的天才'), '章正文含章头行')
    check(r1.chapters[0]!.content.includes('见第2章说明'), '行内「第2章」引用不误切（仍在第 1 章内）')
    check(r1.chapters[2]!.content.includes('正文三'), '末章正文到文末')
    check(r1.skippedHeadChars === novel.indexOf('第1章 陨落的天才'), `前言字符数记录（${r1.skippedHeadChars}）`)
    check(r1.chapters.every((c) => c.reel === null), '无卷标记 → reel 全为 null')
    check(r1.chapters[1]!.index === 2 && r1.chapters[2]!.index === 3, 'index 为切分顺序号 1-based')

    // —— 3. splitChapters：中文数字 + 卷章合并 ——
    const cn = ['第一章 风起', '甲。', '第二章 云涌', '乙。', '第十章 终局', '丙。'].join('\n')
    const r2 = splitChapters(cn, null)
    check(r2.chapters.length === 3 && r2.chapters[2]!.title === '终局', '中文数字章号识别')
    const reel = ['第一卷 少年', '第1章 起点', '甲。', '第2章 转折', '乙。', '第二卷 风云', '第3章 高潮', '丙。'].join('\n')
    const r3 = splitChapters(reel, null)
    check(r3.chapters.length === 3, `卷章合并仍 3 章（实际 ${r3.chapters.length}）`)
    check(
      r3.chapters[0]!.reel === '第一卷 少年' && r3.chapters[1]!.reel === '第一卷 少年' && r3.chapters[2]!.reel === '第二卷 风云',
      '章归属当前卷、卷切换后归属新卷',
    )
    check(!r3.chapters[1]!.content.includes('第二卷'), '卷头行不落入上一章')

    // —— 4. splitChapters：无章标记单章 + 自定义正则 ——
    const r4 = splitChapters('一篇没有章节标记的短文。', null)
    check(r4.chapters.length === 1 && r4.chapters[0]!.title === '' && r4.chapters[0]!.index === 1, '无章标记 → 整文单章（title 空）')
    const jie = ['第1节 起', 'A。', '第2节 承', 'B。'].join('\n')
    const custom = new RegExp('第\\s*([0-9]+)\\s*节\\s*([^\\n\\r]*)', 'gm')
    const r5 = splitChapters(jie, custom)
    check(r5.chapters.length === 2 && r5.chapters[1]!.title === '承', '自定义正则（节）生效')

    // —— 5. textSplit 全流程（mock ctx → 真实隔离库落盘） ——
    const pid = await newProject('M9 切分探针', 'probe-m9-split')
    const runId = await insertRun(pid, { adapt_brief: '探针' })
    const stepId = await insertStep(runId, 2, 'split_chapters', 'text_split')
    const src = await writeTextAsset(pid, { name: '测试小说.txt', content: novel, purpose: 'source', runId })

    const mkCtx = (
      input: Record<string, unknown>,
      params: Record<string, unknown>,
      assetIds: Record<string, number[]>,
    ): Parameters<typeof textSplit>[0] =>
      ({
        run: { id: runId, projectId: pid },
        step: { id: stepId },
        def: { params },
        input,
        assetIdsOf: (k: string): number[] => assetIds[k] ?? [],
        assetsOf: async (ids: number[]) => {
          const rows = await db.select().from(assets).where(inArray(assets.id, ids))
          const byId = new Map(rows.map((r) => [r.id, r]))
          return ids.map((i) => byId.get(i)).filter(Boolean)
        },
        readText: (id: number) => readTextAsset(id),
        log: (): void => {},
      }) as unknown as Parameters<typeof textSplit>[0]

    const res = await textSplit(mkCtx({}, {}, { source: [src.id] }))
    check(res.assetIds.length === 4, `产物 [manifest, 3 章]（实际 ${res.assetIds.length}）`)
    const manifest = JSON.parse(await readTextAsset(res.assetIds[0]!)) as {
      regex_source: string
      total: number
      selected: number
      range: string | null
      chapters: Array<{ index: number; name: string; asset_id: number; chars: number }>
    }
    check(manifest.regex_source === 'default', `regex_source=default（${manifest.regex_source}）`)
    check(manifest.total === 3 && manifest.selected === 3, 'total/selected=3')
    check(manifest.range === null, 'range=null（未指定）')
    check(manifest.chapters[0]!.name === '第001章-陨落的天才.md', `章资产名（${manifest.chapters[0]!.name}）`)
    check(manifest.chapters[0]!.asset_id === res.assetIds[1], 'manifest 章 asset_id 与产物顺序一致')
    check(manifest.chapters[0]!.chars > 0, '章 chars 记录')
    const purposeRows = await db.select().from(assets).where(inArray(assets.id, res.assetIds))
    check(purposeRows.every((r) => r.purpose === 'chapters'), '全部产物 purpose=chapters')

    // 范围过滤
    const res2 = await textSplit(mkCtx({ chapter_range: '1-2' }, {}, { source: [src.id] }))
    const m2 = JSON.parse(await readTextAsset(res2.assetIds[0]!)) as { selected: number; range: string | null }
    check(res2.assetIds.length === 3 && m2.selected === 2 && m2.range === '1-2', 'chapter_range=1-2 → [manifest, 2 章]')

    // 用户正则优先
    const res3 = await textSplit(mkCtx({ chapter_regex: '^第\\s*([0-9]+)\\s*章\\s*([^\\n\\r]*)' }, {}, { source: [src.id] }))
    const m3 = JSON.parse(await readTextAsset(res3.assetIds[0]!)) as { regex_source: string }
    check(m3.regex_source === 'user', `用户正则优先（${m3.regex_source}）`)

    // AI 正则资产（剥围栏）
    const aiAsset = await writeTextAsset(pid, {
      name: '章节切分正则.md',
      content: '```\n第\\s*([0-9]+)\\s*章\\s*([^\\n\\r]*)\n```',
      purpose: 'regex',
      runId,
    })
    const res4 = await textSplit(mkCtx({}, {}, { source: [src.id], ai_regex: [aiAsset.id] }))
    const m4 = JSON.parse(await readTextAsset(res4.assetIds[0]!)) as { regex_source: string }
    check(m4.regex_source === 'ai', `AI 正则资产生效（剥围栏，${m4.regex_source}）`)

    // 用户正则优先于 AI 正则
    const res5 = await textSplit(
      mkCtx({ chapter_regex: '^第\\s*([0-9]+)\\s*章\\s*([^\\n\\r]*)' }, {}, { source: [src.id], ai_regex: [aiAsset.id] }),
    )
    const m5 = JSON.parse(await readTextAsset(res5.assetIds[0]!)) as { regex_source: string }
    check(m5.regex_source === 'user', '用户 > AI 优先级')

    // 异常路径
    const flat = await writeTextAsset(pid, { name: '无标记.txt', content: '整篇文章没有章节标记。', purpose: 'source', runId })
    const err1 = await errOf(() => textSplit(mkCtx({}, {}, { source: [flat.id] })))
    check(err1 !== null && err1.message.includes('min_chapters'), `整文单章 → min_chapters 拦截（${err1?.message.slice(0, 40)}）`)
    const err2 = await errOf(() => textSplit(mkCtx({ chapter_range: 'abc' }, {}, { source: [src.id] })))
    check(err2 !== null && err2.message.includes('章节范围格式非法'), '非法 range → 抛错指引')
    const err3 = await errOf(() => textSplit(mkCtx({ chapter_regex: '(' }, {}, { source: [src.id] })))
    check(err3 !== null && err3.message.includes('编译失败'), '非法正则 → 编译失败抛错')
    const err4 = await errOf(() => textSplit(mkCtx({}, {}, {})))
    check(err4 !== null && err4.message.includes('无文本资产'), '空 source → 抛错')
  }

  const sectionBatch = async (): Promise<void> => {
    await initDb()
    const { extractBatchItems, batchItemId, buildItemPrompt } = await import('../src/pipeline/actions/ai-text')

    // —— extractBatchItems ——
    check(extractBatchItems({ chapters: [{ index: 1 }, { index: 2 }] }, 'chapters').length === 2, 'obj[field] 数组提取')
    check(extractBatchItems([{ ep: 1 }], 'episodes').length === 1, '根数组提取')
    check(extractBatchItems({ episodes: [] }, 'episodes').length === 0, '空数组 → 0')
    check(extractBatchItems({ chapters: 'x' }, 'chapters').length === 0, '非数组 → 0')
    check(extractBatchItems(null, 'chapters').length === 0, 'null → 0')
    check(extractBatchItems({ chapters: [{ index: 1 }, null, 's', [1]] }, 'chapters').length === 1, '非对象项过滤')

    // —— batchItemId ——
    check(batchItemId({ index: 3 }, 0, 'index') === '3', 'item_key 命中')
    check(batchItemId({ id: 'E1' }, 0, null) === 'E1', '缺 item_key → 探测 id')
    check(batchItemId({ index: 5 }, 0, null) === '5', '探测 index')
    check(batchItemId({ ep: 2 }, 0, null) === '2', '探测 ep')
    check(batchItemId({}, 7, null) === 'pos:7', '全部缺失 → pos:{序号} 兜底')
    check(batchItemId({ index: 0 }, 0, 'index') === '0', '0 值有效（非 null 判定）')

    // —— buildItemPrompt ——
    const p = buildItemPrompt({
      templateText: 'TPL',
      staticSections: ['--- brief / b.md ---\n要求'],
      itemJson: '{"index":1}',
      itemAssetSection: '--- 章节原文 / 第001章.md ---\n正文',
    })
    check(p.startsWith('TPL\n\n===== 输入资料 =====\n'), '模板 + 输入资料头')
    check(p.includes('--- brief / b.md ---\n要求'), '静态 section 注入')
    check(p.includes('--- item ---\n{"index":1}'), 'item JSON section')
    check(p.includes('--- 章节原文 / 第001章.md ---\n正文'), 'item 资产 section（带标题）')
    const p2 = buildItemPrompt({ templateText: 'T', staticSections: ['--- a ---'], itemJson: '{}' })
    check(!p2.includes('章节原文') && p2.includes('--- a ---') && p2.includes('--- item ---'), '无资产 section 不追加')
  }

  const sectionContracts = async (): Promise<void> => {
    await initDb()
    const { validateTextOutput } = await import('../src/pipeline/actions/ai-text')

    // —— event-json ——
    const ev = JSON.stringify({
      chapter_index: 1,
      title: '陨落的天才',
      core_event: '萧炎修为尽失，立誓三年后雪耻。',
      sub_events: [],
      characters: ['萧炎'],
      main_relation: '退婚结怨',
      intensity: 4,
      notes: '',
    })
    check(validateTextOutput(ev, 'event-json') === 1, 'event-json 合法 → 1')
    check(validateTextOutput('```json\n' + ev + '\n```', 'event-json') === 1, '围栏剥离后通过')
    const evBad1 = throwsSync(() => validateTextOutput(JSON.stringify({ chapter_index: '1', core_event: 'x' }), 'event-json'))
    check(evBad1 !== null && evBad1.message.includes('chapter_index'), 'chapter_index 非整数抛错')
    const evBad2 = throwsSync(() => validateTextOutput(JSON.stringify({ chapter_index: 1, core_event: '  ' }), 'event-json'))
    check(evBad2 !== null && evBad2.message.includes('core_event'), 'core_event 空白抛错')

    // —— graph-json ——
    const g1 = JSON.stringify({
      overview: '梗概',
      characters: [{ name: '萧炎', role: '主角', arc: '从陨落到雪耻' }],
      key_events: [
        { id: 'E1', name: '退婚', summary: '结怨', chapters: [1, 2], intensity: 5, kind: '转折' },
        { id: 'E2', name: '拜师', summary: '成长', chapters: [3], intensity: 3, kind: '主线' },
      ],
    })
    check(validateTextOutput(g1, 'graph-json') === 2, 'graph-json 合法 → key_events 数')
    const gBad1 = throwsSync(() => validateTextOutput(JSON.stringify({ key_events: [] }), 'graph-json'))
    check(gBad1 !== null && gBad1.message.includes('key_events'), 'key_events 空抛错')
    const gBad2 = throwsSync(() =>
      validateTextOutput(JSON.stringify({ key_events: [{ name: 'x', chapters: [] }] }), 'graph-json'),
    )
    check(gBad2 !== null && gBad2.message.includes('chapters'), 'chapters 空抛错')
    const gBad3 = throwsSync(() =>
      validateTextOutput(JSON.stringify({ characters: [{ role: 'x' }], key_events: [{ name: 'x', chapters: [1] }] }), 'graph-json'),
    )
    check(gBad3 !== null && gBad3.message.includes('缺 name'), '角色缺 name 抛错')

    // —— plan-json ——
    const plan = JSON.stringify({
      title: '三年之约',
      episode_count: 1,
      episodes: [
        {
          ep: 1,
          title: '退婚之辱',
          chapters: [1, 2],
          synopsis: '冲突-升级-反转-钩子。',
          opening_hook: '测灵石碎裂。',
          ending_hook: '红帖三日后到。',
          key_event_ids: ['E1'],
          chapter_events: [{ chapter_index: 1, core_event: '陨落', characters: ['萧炎'], key_moments: ['跪祠'] }],
        },
      ],
    })
    check(validateTextOutput(plan, 'plan-json') === 1, 'plan-json 合法 → episodes 数')
    check(
      validateTextOutput(JSON.stringify({ episodes: [{ ep: 1, chapters: [1], synopsis: 'x' }] }), 'plan-json') === 1,
      'chapter_events 缺省宽容通过',
    )
    const pBad1 = throwsSync(() => validateTextOutput(JSON.stringify({ episodes: [] }), 'plan-json'))
    check(pBad1 !== null && pBad1.message.includes('episodes'), 'episodes 空抛错')
    const pBad2 = throwsSync(() =>
      validateTextOutput(JSON.stringify({ episodes: [{ ep: '1', chapters: [1], synopsis: 'x' }] }), 'plan-json'),
    )
    check(pBad2 !== null && pBad2.message.includes('非整数 ep'), 'ep 非整数抛错')
    const pBad3 = throwsSync(() =>
      validateTextOutput(JSON.stringify({ episodes: [{ ep: 1, chapters: [], synopsis: 'x' }] }), 'plan-json'),
    )
    check(pBad3 !== null && pBad3.message.includes('chapters'), 'chapters 空抛错')
    const pBad4 = throwsSync(() =>
      validateTextOutput(
        JSON.stringify({ episodes: [{ ep: 1, chapters: [1], synopsis: 'x', chapter_events: [{ chapter_index: 'a', core_event: 'x' }] }] }),
        'plan-json',
      ),
    )
    check(pBad4 !== null && pBad4.message.includes('chapter_index'), 'chapter_events 内 chapter_index 非整数抛错')

    // —— 非 M9 格式回归 ——
    check(validateTextOutput('普通文本', 'script') === 0, '未校验格式 → 0（回归）')
  }

  const sectionApi = async (): Promise<void> => {
    await initDb()
    const { app } = await import('../src/app')
    const { buildNovelBoard } = await import('../src/services/novel-board')
    const { writeTextAsset } = await import('../src/services/storage')
    const pid = await newProject('M9 看板探针', 'probe-m9-api')

    // —— 组装：run + 6 步骤 + 产物资产 + gen_tasks ——
    const runId = await insertRun(pid, { adapt_brief: '改编为 2 集短剧' })
    await insertStep(runId, 1, 'ingest', 'manual_ingest')
    const splitStep = await insertStep(runId, 2, 'split_chapters', 'text_split')
    const eventsStep = await insertStep(runId, 3, 'extract_events', 'ai_text')
    const graphStep = await insertStep(runId, 4, 'merge_events', 'ai_text')
    const planStep = await insertStep(runId, 5, 'plan_episodes', 'ai_text')
    const adaptStep = await insertStep(runId, 6, 'adapt_script', 'ai_text')

    const ch1 = await writeTextAsset(pid, { name: '第001章-陨落的天才.md', content: '第1章 陨落的天才\n正文。', purpose: 'chapters', stepId: splitStep, runId })
    const ch2 = await writeTextAsset(pid, { name: '第002章-退婚.md', content: '第2章 退婚\n正文。', purpose: 'chapters', stepId: splitStep, runId })
    const manifest = await writeTextAsset(pid, {
      name: '章节索引.json',
      content: JSON.stringify({
        source: { asset_ids: [1], names: ['测试小说.txt'], chars: 100 },
        regex_source: 'default',
        total: 2,
        selected: 2,
        range: null,
        chapters: [
          { index: 1, title: '陨落的天才', reel: null, name: ch1.name, asset_id: ch1.id, chars: 30 },
          { index: 2, title: '退婚', reel: null, name: ch2.name, asset_id: ch2.id, chars: 20 },
        ],
      }),
      purpose: 'chapters',
      format: 'chapter-manifest-json',
      stepId: splitStep,
      runId,
    })
    await setStepOutput(splitStep, [manifest.id, ch1.id, ch2.id])

    const ev1 = await writeTextAsset(pid, { name: '第001章-事件.json', content: '{"chapter_index":1,"core_event":"x"}', purpose: 'events', format: 'event-json', stepId: eventsStep, runId })
    const ev2 = await writeTextAsset(pid, { name: '第002章-事件.json', content: '{"chapter_index":2,"core_event":"y"}', purpose: 'events', format: 'event-json', stepId: eventsStep, runId })
    await setStepOutput(eventsStep, [ev1.id, ev2.id])

    const graph = await writeTextAsset(pid, { name: '事件图谱.json', content: '{"overview":"梗概","key_events":[]}', purpose: 'graph', format: 'graph-json', stepId: graphStep, runId })
    await setStepOutput(graphStep, [graph.id])

    const planA = await writeTextAsset(pid, { name: '分集规划.json', content: '{"title":"t","episode_count":2,"episodes":[]}', purpose: 'plan', format: 'plan-json', stepId: planStep, runId })
    await setStepOutput(planStep, [planA.id])

    const sc1 = await writeTextAsset(pid, { name: '第01集-改编剧本.md', content: '# 第1集', purpose: 'script', stepId: adaptStep, runId })
    const sc2 = await writeTextAsset(pid, { name: '第02集-改编剧本.md', content: '# 第2集', purpose: 'script', stepId: adaptStep, runId })
    // 故意反序写入 output → 验证 novel-board 仍按 ep 排序
    await setStepOutput(adaptStep, [sc2.id, sc1.id])

    await insertTask(pid, runId, eventsStep, '1', 'succeeded', ev1.id)
    await insertTask(pid, runId, eventsStep, '2', 'failed', null)
    await insertTask(pid, runId, adaptStep, '1', 'succeeded', sc1.id)
    await insertTask(pid, runId, adaptStep, '2', 'succeeded', sc2.id)

    // —— buildNovelBoard 服务层 ——
    const board = await buildNovelBoard(runId)
    check(board !== null && board.found === true, 'found=true')
    check(board!.step?.key === 'split_chapters', `step.key=split_chapters（${board!.step?.key}）`)
    check(board!.split?.chapters.length === 2, 'split.chapters=2')
    check(board!.split?.chapters[0]!.event_status === 'succeeded', '章1 event_status=succeeded')
    check(board!.split?.chapters[1]!.event_status === 'failed', '章2 event_status=failed')
    check(board!.events?.total === 2 && board!.events?.done === 1 && board!.events?.failed === 1, 'events 统计 {2,1,1}')
    check((board!.graph?.doc as { overview?: string })?.overview === '梗概', 'graph doc 解析')
    check((board!.plan?.doc as { episode_count?: number })?.episode_count === 2, 'plan doc 解析')
    check(
      board!.scripts.length === 2 && board!.scripts[0]!.ep === 1 && board!.scripts[1]!.ep === 2,
      `scripts 按 ep 排序（output 反序仍正序：${board!.scripts.map((x) => x.ep).join(',')}）`,
    )
    check(board!.scripts[0]!.asset_id === sc1.id, 'scripts[0] 对应第 1 集资产')

    // —— 异常输入 ——
    check((await buildNovelBoard(999999)) === null, 'run 不存在 → null')

    // —— HTTP（内存） ——
    const res = await app.request(`/api/v1/runs/${runId}/novel-board`)
    check(res.status === 200, `GET novel-board 200（${res.status}）`)
    const body = (await res.json()) as { run_id: number; found: boolean; scripts: unknown[] }
    check(body.run_id === runId && body.found === true && body.scripts.length === 2, 'HTTP body 结构')

    const res404 = await app.request('/api/v1/runs/999999/novel-board')
    check(res404.status === 404, `run 不存在 → 404（${res404.status}）`)

    const run2 = await insertRun(pid, {})
    const resNo = await app.request(`/api/v1/runs/${run2}/novel-board`)
    const bodyNo = (await resNo.json()) as { found: boolean; split: unknown; step: unknown }
    check(resNo.status === 200 && bodyNo.found === false && bodyNo.split === null && bodyNo.step === null, '无 text_split → found=false 空看板')
  }

  const sectionTemplate = async (): Promise<void> => {
    await initDb()
    const { loadTemplate, validateTemplateText, missingPromptsOf } = await import('../src/pipeline/loader')
    const { TEMPLATES_DIR, PROMPTS_DIR } = await import('../src/env')

    const srcTplDir = join(REPO_ROOT, 'workspace', 'templates')
    const srcPromptDir = join(REPO_ROOT, 'workspace', 'prompts')

    // —— 1. 5 提示词文件存在性 ——
    const promptFiles = ['split-regex.md', 'chapter-events.md', 'event-graph.md', 'plan-episodes.md', 'adapt-script.md']
    for (const f of promptFiles) {
      check(existsSync(join(srcPromptDir, f)), `提示词 ${f} 存在`)
    }

    // —— 2. 真实文件文本校验（validateTemplateText；先拷 prompts + templates，保证 prompt/next 引用可探测） ——
    mkdirSync(PROMPTS_DIR, { recursive: true })
    cpSync(srcPromptDir, PROMPTS_DIR, { recursive: true })
    mkdirSync(TEMPLATES_DIR, { recursive: true })
    cpSync(join(srcTplDir, 'novel-adapt.yaml'), join(TEMPLATES_DIR, 'novel-adapt.yaml'))
    cpSync(join(srcTplDir, 'series-setup.yaml'), join(TEMPLATES_DIR, 'series-setup.yaml')) // next 引用校验用
    const realText = readFileSync(join(srcTplDir, 'novel-adapt.yaml'), 'utf8')
    const v = validateTemplateText(realText, 'novel-adapt')
    check(v.ok === true, `novel-adapt 文本校验通过（errors: ${v.errors.join('; ') || '无'}）`)
    check(v.warnings.length === 0, `零 warning（${v.warnings.join('; ') || '无'}）`)

    // —— 3. 完整 loader 路径（隔离目录，模板已在位） ——
    const t = loadTemplate('novel-adapt', true)
    check(t.version === 2, `version=2（实际 ${t.version}；M25·G1 扩 accept docx/epub 升版，步骤/输入面逐字不变）`) // [M25·P4 同步]
    check(t.steps.length === 7, `steps=7（实际 ${t.steps.length}）`)
    check(t.inputs.length === 8, `inputs=8（实际 ${t.inputs.length}）`)
    check(missingPromptsOf(t).length === 0, `5 个 prompt_tpl 文件齐备（缺：${missingPromptsOf(t).join(',') || '无'}）`)
    check(t.scene === 'plan' && (t.next ?? []).includes('series-setup'), 'scene=plan / next 含 series-setup')

    const keys = t.steps.map((s) => s.key).join(',')
    check(
      keys === 'ingest,make_split_regex,split_chapters,extract_events,merge_events,plan_episodes,adapt_script',
      `步骤序列（${keys}）`,
    )
    const stepOf = (k: string) => t.steps.find((s) => s.key === k)

    // ingest
    const ing = stepOf('ingest')!
    check(ing.action === 'manual_ingest' && ing.inputs['docs'] === 'input.novel' && ing.inputs['brief'] === 'input.adapt_brief', 'ingest 输入契约')

    // make_split_regex
    const msr = stepOf('make_split_regex')!
    check(msr.action === 'ai_text' && String(msr.when).includes('with_ai_split'), 'make_split_regex when 绑 with_ai_split')
    check(msr.inputs['novel'] === 'input.novel', 'make_split_regex.inputs.novel')
    check(msr.params?.['prompt_tpl'] === 'split-regex.md' && msr.params?.['max_input_chars'] === 30000, 'make_split_regex 参数（prompt/max_input_chars）')
    check(msr.params?.['output_purpose'] === 'regex', 'make_split_regex.output_purpose=regex')

    // split_chapters
    const sc = stepOf('split_chapters')!
    check(sc.action === 'text_split', `split_chapters.action=text_split（${sc.action}）`)
    check(
      sc.inputs['source'] === 'input.novel' &&
        sc.inputs['chapter_regex'] === 'input.chapter_regex' &&
        sc.inputs['chapter_range'] === 'input.chapter_range' &&
        sc.inputs['ai_regex'] === 'steps.make_split_regex.asset',
      'split_chapters 输入契约（source/chapter_regex/chapter_range/ai_regex）',
    )
    check(sc.params?.['min_chapters'] === 2 && sc.params?.['output_purpose'] === 'chapters', 'split_chapters 参数（min_chapters/output_purpose）')
    check(
      sc.gate?.mode === 'required' && String(sc.gate?.when).includes('with_split_review') && sc.gate?.skip_label === '切分无误',
      'split_chapters gate（when=with_split_review/skip_label）',
    )

    // extract_events
    const ee = stepOf('extract_events')!
    check(ee.batch?.field === 'chapters' && ee.batch?.maxConcurrent === 3 && ee.batch?.retry === 1, 'extract_events batch（chapters/3/1）')
    check(ee.inputs['chapters'] === 'steps.split_chapters.assets' && ee.inputs['brief'] === 'steps.ingest.asset', 'extract_events 输入契约')
    check(
      ee.params?.['output_format'] === 'event-json' && ee.params?.['item_key'] === 'index' && ee.params?.['name_tpl'] === '第{index:03d}章-事件.json',
      'extract_events 参数（event-json/item_key/name_tpl）',
    )

    // merge_events
    const me = stepOf('merge_events')!
    check(
      me.inputs['events'] === 'steps.extract_events.assets' && me.inputs['brief'] === 'steps.ingest.asset' && me.params?.['output_format'] === 'graph-json',
      'merge_events 输入/格式契约',
    )

    // plan_episodes
    const pe = stepOf('plan_episodes')!
    check(
      pe.inputs['graph'] === 'steps.merge_events.asset' && pe.inputs['events'] === 'steps.extract_events.assets' && pe.params?.['output_format'] === 'plan-json',
      'plan_episodes 输入/格式契约',
    )
    check(pe.gate?.mode === 'required' && String(pe.gate?.when).includes('with_plan_review'), 'plan_episodes gate（with_plan_review）')

    // adapt_script
    const ad = stepOf('adapt_script')!
    check(ad.batch?.field === 'episodes' && ad.batch?.maxConcurrent === 2 && ad.batch?.retry === 1, 'adapt_script batch（episodes/2/1）')
    check(ad.inputs['episodes'] === 'steps.plan_episodes.asset' && ad.inputs['brief'] === 'steps.ingest.asset', 'adapt_script 输入契约')
    check(
      ad.params?.['item_key'] === 'ep' && ad.params?.['name_tpl'] === '第{ep:02d}集-改编剧本.md' && ad.params?.['output_purpose'] === 'script',
      'adapt_script 参数（item_key/name_tpl/output_purpose）',
    )
    check(ad.gate?.mode === 'required' && String(ad.gate?.when).includes('with_script_review'), 'adapt_script gate（with_script_review）')

    // —— 4. validateTemplateText 负例 ——
    const bad = validateTemplateText('key: novel-bad\nname: x\n', 'novel-bad')
    check(bad.ok === false, '缺 steps → 校验失败')
    const badKey = validateTemplateText('key: other\nsteps: [{key: s, action: manual_ingest, inputs: {docs: []}}]\n', 'novel-adapt')
    check(badKey.ok === false, 'key 不一致 → 校验失败')
  }

  // ================= 分发 =================

  const runners: Record<string, () => Promise<void>> = {
    split: sectionSplit,
    batch: sectionBatch,
    contracts: sectionContracts,
    api: sectionApi,
    template: sectionTemplate,
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
    console.log(`\n==== M9 探针结果: ${failed > 0 ? `${failed} 项失败` : '全部通过'} ====`)
    try {
      sqlite.close()
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
