/**
 * M37 探针（收尾与回归 · G13 自动值来源可追溯 — 自动化契约 source 字段一致性锁）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m37.ts [--section=prefill|model-suggest|rules-catalog|suggest-nextsteps|cadence]
 *
 * 定位：M37 前端统一来源徽标（ProvenanceBadge）不改服务端契约；本探针**锁定各自动化端点已有的
 * source/tier 语义契约**——前端标注的可追溯性以这些字段为真源，任何漂移先在此变红。
 *
 * 隔离策略：isolatedEnv('m37', bridge templates/prompts) 一次性临时目录（独立 studio.db + workspace），
 * 必须先于任何 src 动态 import。零网络、零付费、零计费：全为只读查表 / DB 读 / 临时文件写。
 * app.request 内存执行。断言文案内不嵌 PASS/FAIL 词元。
 *
 * 分节：
 *   - prefill：inputs[k].source ∈ {template_default,last_run,brief}；last_run 覆盖 template_default；
 *     overrides.video.source='caps_suggest' 且 defaultResolution ∈ selectableResolutions；未登记 → null。
 *   - model-suggest：命中定价必带非空 source 锚点；video-caps 命中 caps 非空、未登记 supported:false；缺参 400。
 *   - rules-catalog：GET rules source ∈ {file,builtin}（缺失=builtin 全量兜底、在位=file 逐字）；
 *     catalog 每条平台/命名模板非空；seed added=3 幂等重放 0（前端「平台目录」徽标的语义背书）。
 *   - suggest-nextsteps：suggest 恒 warn 起步 + evidence 非空（「建议」徽标不越权）；next-steps kind ∈ 枚举、≤3。
 *   - cadence：preview errors 非空 ⇔ timestamps 空（不静默产出，「节奏模板展开」徽标的前提）。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup: envCleanup } = isolatedEnv('m37', { bridge: ['templates', 'prompts'] })
process.env.PROBE_M37_KEY = 'probe-m37-offline-secret-key-a7e1'

const SECTIONS = ['prefill', 'model-suggest', 'rules-catalog', 'suggest-nextsteps', 'cadence'] as const
const DAY = 86_400_000
const PREFILL_SOURCES = new Set(['template_default', 'last_run', 'brief'])
const STEP_KINDS = new Set(['run', 'publish', 'next_tpl', 'progress', 'workbench'])

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m37')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  // ---------- 通用 helpers（与 probe-m36 同构） ----------
  const insertProject = async (
    tag: string,
    opts: { brief?: string; settings?: string; templateKey?: string } = {},
  ): Promise<number> => {
    const { initDb, db } = await import('../src/db')
    const { projects } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    await initDb()
    const t = Date.now()
    const name = `probe-m37-${tag}`
    await db.insert(projects).values({
      name,
      genre: 'drama_short',
      brief: opts.brief ?? null,
      templateKey: opts.templateKey ?? 'mengbao-episode',
      status: 'active',
      settings: opts.settings ?? '{}',
      tags: '[]',
      createdAt: t,
      updatedAt: t,
    } as never)
    const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.name, name)).limit(1)
    return (row as { id: number }).id
  }

  const insertRun = async (projectId: number, templateKey: string, input: unknown): Promise<void> => {
    const { initDb, db } = await import('../src/db')
    const { pipelineRuns } = await import('../src/db/schema')
    await initDb()
    const t = Date.now()
    await db.insert(pipelineRuns).values({
      projectId,
      templateKey,
      status: 'completed',
      input: JSON.stringify(input),
      createdAt: t,
      updatedAt: t,
    } as never)
  }

  const insertAssetWithCompliance = async (
    projectId: number,
    llmItems: Array<{ category: string; quote: string; reason: string }>,
  ): Promise<void> => {
    const { initDb, db } = await import('../src/db')
    const { assets } = await import('../src/db/schema')
    await initDb()
    const t = Date.now()
    await db.insert(assets).values({
      projectId,
      kind: 'text',
      purpose: 'export',
      name: `m37-carrier-${t}.md`,
      params: JSON.stringify({ compliance: { status: 'warn', hits: [], llm: { verdict: 'risk', items: llmItems }, checkedAt: t } }),
      tags: '[]',
      createdAt: t,
      updatedAt: t,
    } as never)
  }

  const clearAll = async (): Promise<void> => {
    const { initDb, db } = await import('../src/db')
    const { assets, pipelineRuns, projects, publications, schedules, settings } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    await initDb()
    await db.delete(assets)
    await db.delete(pipelineRuns)
    await db.delete(publications)
    await db.delete(schedules)
    await db.delete(projects)
    await db.delete(settings).where(eq(settings.key, 'export_presets'))
  }

  const jget = async (path: string): Promise<{ status: number; body: any }> => {
    const { app } = await import('../src/app')
    const res = await app.request(path)
    let json: any = null
    try {
      json = await res.json()
    } catch {
      /* non-json */
    }
    return { status: res.status, body: json }
  }

  const jpost = async (path: string, body: unknown): Promise<{ status: number; body: any }> => {
    const { app } = await import('../src/app')
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    let json: any = null
    try {
      json = await res.json()
    } catch {
      /* non-json */
    }
    return { status: res.status, body: json }
  }

  /** 隔离 workspace 的词库路径（endpoint/rulesView 默认真源） */
  const wordsFile = (): string =>
    join(process.env.CSTUDIO_WORKSPACE ?? '', 'compliance', 'words.txt')
  const writeWords = (text: string): void => {
    mkdirSync(join(process.env.CSTUDIO_WORKSPACE ?? '', 'compliance'), { recursive: true })
    writeFileSync(wordsFile(), text, 'utf8')
  }
  const removeWords = (): void => {
    if (existsSync(wordsFile())) rmSync(wordsFile())
  }

  const runners: Record<string, () => Promise<void>> = {
    // ================= prefill：G6/G8 来源枚举 + caps_suggest 域自洽 =================
    prefill: async () => {
      await clearAll()
      removeWords()
      const T = 'mengbao-episode'
      const pid = await insertProject('prefill', {
        brief: '萌宝探案题材简报',
        settings: JSON.stringify({ video: { provider: 'minimax_video', model: 'MiniMax-H3' } }),
      })
      const p0 = await jget(`/api/v1/templates/${T}/prefill?project_id=${pid}`)
      check(p0.status === 200 && p0.body?.inputs, 'GET prefill 200 → inputs')
      const srcVals: string[] = Object.values(p0.body.inputs as Record<string, any>).map((v) => v.source)
      check(srcVals.length > 0 && srcVals.every((s) => PREFILL_SOURCES.has(s)), `baseline 各 key source ∈ 枚举（实际 ${[...new Set(srcVals)].join('/')}）`)
      check(p0.body.inputs?.motion?.source === 'template_default', 'bool 默认 → template_default')
      // overrides.video（前端「能力表合法域」徽标的契约真源）
      const ov = p0.body?.overrides?.video
      check(!!ov && ov.source === 'caps_suggest', 'overrides.video.source=caps_suggest（非静默收窄）')
      check(!!ov && (ov.defaultResolution == null || (Array.isArray(ov.selectableResolutions) && ov.selectableResolutions.includes(ov.defaultResolution))), 'defaultResolution ∈ selectableResolutions 或为 null（推荐不出可选域）')
      // last_run 覆盖 template_default
      await insertRun(pid, T, { brief: '上一集简报', episode_number: 7, motion: true })
      const p1 = await jget(`/api/v1/templates/${T}/prefill?project_id=${pid}`)
      check(p1.body.inputs?.episode_number?.source === 'last_run' && p1.body.inputs?.episode_number?.value === 7, 'int → last_run 值 7')
      check(p1.body.inputs?.motion?.source === 'last_run' && p1.body.inputs?.motion?.value === true, 'bool last_run 覆盖 template_default')
      const srcVals1: string[] = Object.values(p1.body.inputs as Record<string, any>).map((v) => v.source)
      check(srcVals1.every((s) => PREFILL_SOURCES.has(s)), '含 last_run 后全 key source 仍在枚举内')
      // 未登记模型 → 无合法域可推导（前端回退手填，不猜）
      const pid2 = await insertProject('prefill-miss', { settings: JSON.stringify({ video: { provider: 'mystery_video', model: 'x' } }) })
      const p2 = await jget(`/api/v1/templates/${T}/prefill?project_id=${pid2}`)
      check(p2.status === 200 && (p2.body?.overrides?.video ?? null) === null, '未登记模型 → overrides.video=null（回退手填）')
    },

    // ================= model-suggest / video-caps：定价锚点 + 背书依据 =================
    'model-suggest': async () => {
      // 命中定价 → 必带非空 source 锚点（前端「平台核实表定价」徽标 hover 内容）
      const hit = await jget('/api/v1/api-configs/model-suggest?provider_key=deepseek_llm&service_type=llm&model=deepseek-flash')
      check(hit.status === 200 && !!hit.body?.pricing, 'llm 命中参考定价（deepseek-flash）')
      check(typeof hit.body?.pricing?.source === 'string' && hit.body.pricing.source.length > 0, `定价带非空核实锚点（${String(hit.body?.pricing?.source).slice(0, 20)}…）`)
      // 未登记 → pricing/caps 双缺席（不猜价不假背书）
      const miss = await jget('/api/v1/api-configs/model-suggest?provider_key=mystery_llm&service_type=llm&model=unknown-x')
      check(miss.status === 200 && miss.body?.pricing === undefined && miss.body?.caps === undefined, '未登记 → pricing/caps 缺席')
      // 非法 service_type → 400
      const bad = await jget('/api/v1/api-configs/model-suggest?provider_key=x&service_type=bogus&model=y')
      check(bad.status === 400, '非法 service_type → 400')
      // video-caps：背书数据存在性（endorse 徽标的唯一依据）
      const caps = await jget('/api/v1/api-configs/video-caps?provider_key=minimax_video&model=MiniMax-H3')
      check(caps.status === 200 && caps.body?.supported === true && Array.isArray(caps.body?.caps?.resolutions) && caps.body.caps.resolutions.length > 0, 'video-caps 命中 → caps.resolutions 非空')
      const capsMiss = await jget('/api/v1/api-configs/video-caps?provider_key=mystery_video&model=x')
      check(capsMiss.status === 200 && capsMiss.body?.supported === false && capsMiss.body?.caps === undefined, 'video-caps 未登记 → supported:false')
      const capsBad = await jget('/api/v1/api-configs/video-caps')
      check(capsBad.status === 400, 'video-caps 缺 provider_key → 400')
    },

    // ================= 词库 source 枚举 + catalog/seed 幂等（自动补全契约） =================
    'rules-catalog': async () => {
      const { BASE_RULES } = await import('../src/services/compliance')
      removeWords()
      const v0 = await jget('/api/v1/compliance/rules')
      check(v0.status === 200 && v0.body?.source === 'builtin' && v0.body?.total === BASE_RULES.length, '词库缺失 → source=builtin 且 total=BASE_RULES（内置徽标前提）')
      writeWords('# probe-m37\n极限词|独家|block\n')
      const v1 = await jget('/api/v1/compliance/rules')
      check(v1.status === 200 && v1.body?.source === 'file' && v1.body?.total === 1, '文件在位 → source=file 仅文件规则（不并内置）')
      check(v1.body?.byCategory?.['极限词'] === 1, 'byCategory 计数正确')

      const cat = await jget('/api/v1/exports/presets/catalog')
      check(cat.status === 200 && Array.isArray(cat.body?.items) && cat.body.items.length === 8, 'GET catalog → 8 平台单一真源')
      check(
        (cat.body?.items ?? []).every((e: any) => !!e.platform && !!e.label && !!e.namingPattern && (e.kind === 'video' || e.kind === 'text')),
        'catalog 每条 platform/label/namingPattern 非空、kind ∈ {video,text}',
      )
      // seed：默认 5 视频在位 → 补 3 图文；重放 added=0（「平台目录」徽标语义：仅补缺失不覆盖）
      const s1 = await jpost('/api/v1/exports/presets/seed', {})
      check(s1.status === 200 && s1.body?.added === 3, `seed 首次 → 补 3 图文（实际 ${s1.body?.added}）`)
      check(Object.keys(s1.body?.items ?? {}).length === 8, 'seed 后共 8 平台预设')
      const s2 = await jpost('/api/v1/exports/presets/seed', {})
      check(s2.status === 200 && s2.body?.added === 0, 'seed 重放幂等 → added=0')
    },

    // ================= 建议恒 warn + evidence（「建议」徽标不越权）+ next-steps 枚举 =================
    'suggest-nextsteps': async () => {
      await clearAll()
      removeWords() // 上节写入的文件清掉 → suggest 对 builtin BASE 去重、POST 从零建文件
      const pid = await insertProject('sg')
      await insertAssetWithCompliance(pid, [
        { category: '广告合规', quote: '无敌性价比', reason: '夸大宣传' },
        { category: '广告合规', quote: '最好', reason: '绝对化用语（BASE 已有 → 应剔除）' },
      ])
      const sg = await jget(`/api/v1/compliance/suggest?project_id=${pid}`)
      check(sg.status === 200 && Array.isArray(sg.body?.items) && sg.body.items.length >= 1, 'GET suggest → items 非空')
      check(
        (sg.body?.items ?? []).every((s: any) => s.level === 'warn' && typeof s.evidence === 'string' && s.evidence.length > 0 && s.times >= 1),
        '每条恒 warn 起步 + evidence 非空 + times≥1（仅建议、依据可见）',
      )
      check(!(sg.body?.items ?? []).some((s: any) => s.word === '最好'), 'BASE 已有词剔除（去重含内置兜底）')
      const ap = await jpost('/api/v1/compliance/rules', { rules: [{ category: '广告合规', word: '无敌性价比', level: 'warn' }] })
      check(ap.status === 200 && ap.body?.added === 1 && ap.body?.total === 1, `POST rules 采纳 → added=1/total=1（实际 ${ap.body?.added}/${ap.body?.total}）`)
      const vFile = await jget('/api/v1/compliance/rules')
      check(vFile.body?.source === 'file', '采纳落盘后 → source 回到 file（采纳动作可追溯生效）')

      const np = await jget(`/api/v1/projects/${pid}/next-steps`)
      check(np.status === 200 && Array.isArray(np.body?.items) && np.body.items.length <= 3, 'GET next-steps 200 → items ≤3')
      check((np.body?.items ?? []).every((s: any) => STEP_KINDS.has(s.kind) && typeof s.title === 'string' && s.title.length > 0), '每条 kind ∈ 枚举 + title 非空（前端「规则引擎」徽标的静态语义）')
    },

    // ================= cadence：errors ⇔ 空产出（不静默展开） =================
    cadence: async () => {
      const startAt = Date.now() + 10 * DAY
      const ok = await jpost('/api/v1/schedules/cadence-preview', { start_at: startAt, count: 3, cadence: { kind: 'daily' } })
      check(ok.status === 200 && (ok.body?.errors ?? []).length === 0 && ok.body?.timestamps?.length === 3, '合法 daily → errors 空 + 3 时间戳')
      const bad = await jpost('/api/v1/schedules/cadence-preview', { start_at: startAt, count: 3, cadence: { kind: 'interval', intervalDays: 99 } })
      check(bad.status === 200 && bad.body?.errors?.length > 0 && (bad.body?.timestamps ?? []).length === 0, '非法 interval=99 → errors 非空 ⇔ timestamps 空（不静默产出）')
      const past = await jpost('/api/v1/schedules/cadence-preview', { start_at: Date.now() - 5 * DAY, count: 3, cadence: { kind: 'daily' } })
      check(past.status === 200 && (past.body?.errors ?? []).length === 0 && (past.body?.timestamps ?? []).length === 0, '起始过去 → 未来过滤清空且无 errors（合法输入零产出是事实非错误）')
    },
  }

  await runSections({ log, title: 'M37', checker, sections: SECTIONS, runners, cleanup: envCleanup })
}

void main()
