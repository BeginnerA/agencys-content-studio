/**
 * M36 探针（运营配置自动化：G12.1 平台目录 + G12.2 合规内置基础词 + G12.3 建议采纳 + G12.4 排期节奏）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m36.ts [--section=g12-catalog|g12-baserules|g12-suggest|g12-cadence]
 *
 * 隔离策略：isolatedEnv('m36', bridge templates/prompts) 一次性临时目录（独立 studio.db + workspace），
 * 必须先于任何 src 动态 import。零网络、零付费、零计费：
 *   - G12.1 静态目录 + settings 表读写（app.request 内存执行）
 *   - G12.2 loadRules 显式临时目录（空 → builtin 兜底；有文件 → 仅文件规则，回归关键）
 *   - G12.3 suggestRules 读 assets.params（不触发 LLM）；appendRules 写临时 COMPLIANCE_DIR
 *   - G12.4 expandCadence 纯日期数学 + createSchedule 逐条落库（不触发调度）
 *
 * 注意：isolated workspace 不含 compliance/words.txt → 全程 COMPLIANCE_DIR 初始为空，G12.2 兜底与
 *   G12.3 dedup（对 BASE_RULES）均确定。每次运行新建临时目录，跨运行零污染。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup: envCleanup } = isolatedEnv('m36', { bridge: ['templates', 'prompts'] })

const SECTIONS = ['g12-catalog', 'g12-baserules', 'g12-suggest', 'g12-cadence'] as const
const DAY = 86_400_000

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m36')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  // ---------- 通用 seed helpers ----------
  const insertProject = async (tag: string, opts: { templateKey?: string } = {}): Promise<number> => {
    const { initDb, db } = await import('../src/db')
    const { projects } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    await initDb()
    const t = Date.now()
    const name = `probe-m36-${tag}`
    await db.insert(projects).values({
      name,
      genre: 'drama_short',
      brief: null,
      templateKey: opts.templateKey ?? 'mengbao-episode',
      status: 'active',
      settings: '{}',
      tags: '[]',
      createdAt: t,
      updatedAt: t,
    } as never)
    const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.name, name)).limit(1)
    return (row as { id: number }).id
  }

  const insertAssetWithCompliance = async (
    projectId: number,
    llmItems: Array<{ category: string; quote: string; reason: string }>,
    hits: Array<{ word: string; category: string; level: string; count: number }> = [],
  ): Promise<number> => {
    const { initDb, db } = await import('../src/db')
    const { assets } = await import('../src/db/schema')
    const { desc } = await import('drizzle-orm')
    await initDb()
    const t = Date.now()
    await db.insert(assets).values({
      projectId,
      kind: 'text',
      purpose: 'export',
      name: `compliance-carrier-${t}.md`,
      params: JSON.stringify({ compliance: { status: 'warn', hits, llm: { verdict: 'risk', items: llmItems }, checkedAt: t } }),
      tags: '[]',
      createdAt: t,
      updatedAt: t,
    } as never)
    const [row] = await db.select({ id: assets.id }).from(assets).orderBy(desc(assets.id)).limit(1)
    return (row as { id: number }).id
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

  const runners: Record<string, () => Promise<void>> = {
    // ================= G12.1：平台目录 + 预设 Tier A 补全 =================
    'g12-catalog': async () => {
      const { PLATFORM_CATALOG, seedMissing, catalogByPlatform } = await import('../src/services/platform-catalog')

      check(PLATFORM_CATALOG.length === 8, `目录覆盖 8 平台（实际 ${PLATFORM_CATALOG.length}）`)
      check(catalogByPlatform('douyin')?.aspect === '9:16', '目录 douyin 画幅 9:16（与既有默认一致）')
      check(catalogByPlatform('xiaohongshu')?.aspect === '4:5', '目录 小红书 4:5')
      check(catalogByPlatform('bilibili')?.maxDuration === 600, '目录 B站 时长 600')
      check(catalogByPlatform('wechat')?.kind === 'text' && catalogByPlatform('wechat')?.maxDuration === 0, '图文平台 公众号 kind=text、无时长维度')
      check(catalogByPlatform('nonexistent') === null, '未登记平台键 → null（不猜测）')
      check(seedMissing([]).length === 8, 'seedMissing([]) → 全 8 条')
      const sm = seedMissing(['douyin', 'bilibili'])
      check(sm.length === 6 && !sm.some((c) => c.platform === 'douyin' || c.platform === 'bilibili'), 'seedMissing 排除已存在平台，只补其余 6')

      // 端点：GET catalog
      await clearAll()
      const cat = await jget('/api/v1/exports/presets/catalog')
      check(cat.status === 200 && Array.isArray(cat.body?.items) && cat.body.items.length === 8, 'GET /exports/presets/catalog 200 → 8 条')

      // 默认预设仅 5 视频平台（回归零漂移：不含图文平台）
      const def = await jget('/api/v1/exports/presets')
      const defPlats: string[] = (def.body?.items ?? []).map((p: { platform: string }) => p.platform)
      check(def.status === 200 && defPlats.length === 5, `默认预设 5 视频平台（实际 ${defPlats.length}）`)
      check(defPlats.includes('douyin') && !defPlats.includes('wechat') && !defPlats.includes('zhihu'), '默认含 douyin、不含图文 wechat/zhihu（派生自目录 video 子集）')
      const dy = (def.body.items as Array<Record<string, unknown>>).find((p) => p.platform === 'douyin')
      check(dy?.aspect === '9:16' && dy?.maxDuration === 60 && !('watermark' in (dy ?? {})), 'douyin 预设值逐字零漂移（无 watermark 键）')

      // seed → 补 3 图文
      const seed1 = await jpost('/api/v1/exports/presets/seed', {})
      check(seed1.status === 200 && seed1.body?.added === 3, `seed 补入 3 图文平台（added=${seed1.body?.added}）`)
      const seededPlats: string[] = (seed1.body?.items ?? []).map((p: { platform: string }) => p.platform)
      check(seededPlats.includes('wechat') && seededPlats.includes('zhihu') && seededPlats.includes('toutiao'), 'seed 后含 wechat/zhihu/toutiao')
      // 幂等：再 seed 不新增
      const seed2 = await jpost('/api/v1/exports/presets/seed', {})
      check(seed2.status === 200 && seed2.body?.added === 0, '二次 seed 全在位 → added=0（不覆盖用户配置）')
      // 指定不存在平台键 → added 0（忽略）
      const seed3 = await jpost('/api/v1/exports/presets/seed', { platforms: ['nonexistent'] })
      check(seed3.status === 200 && seed3.body?.added === 0, '指定未知平台 → 目录无匹配 → added=0')
      // platforms 非数组 → 400
      const badSeed = await jpost('/api/v1/exports/presets/seed', { platforms: 'x' })
      check(badSeed.status === 400 && badSeed.body?.error?.code === 'bad_input', 'platforms 非数组 → 400 bad_input')
    },

    // ================= G12.2：合规内置基础词（仅文件缺失兜底） =================
    'g12-baserules': async () => {
      const { loadRules, BASE_RULES } = await import('../src/services/compliance')

      // 空目录 → builtin 兜底（修复静默空转）
      const emptyDir = mkdtempSync(join(tmpdir(), 'acs-m36-empty-'))
      const missing = loadRules(emptyDir)
      check(missing.source === 'builtin' && missing.rules.length === BASE_RULES.length && missing.rules.length > 0, '文件缺失 → source=builtin + 非空基准地板（不再静默空转）')
      check(BASE_RULES.some((r) => r.word === '最好' && r.level === 'block'), 'BASE_RULES 含《广告法》绝对化词（最好=block）')

      // 有文件 → source=file 且**不并入** BASE_RULES（回归关键：现网命中集零变化）
      const fileDir = mkdtempSync(join(tmpdir(), 'acs-m36-file-'))
      writeFileSync(join(fileDir, 'words.txt'), '广告|自定义词A|block\n医疗|自定义词B|warn\n', 'utf8')
      const loaded = loadRules(fileDir)
      check(loaded.source === 'file' && loaded.rules.length === 2, '文件在位 → source=file + 仅文件 2 条')
      check(!loaded.rules.some((r) => BASE_RULES.some((b) => b.word === r.word)), '文件在位时绝不并入 BASE_RULES（probe-m24 现网零回归关键）')

      // 端点：GET /compliance/rules → total>0（永不为空，兜底生效）+ source ∈ {file,builtin}
      await clearAll()
      const rv = await jget('/api/v1/compliance/rules')
      check(rv.status === 200 && typeof rv.body?.total === 'number' && rv.body.total > 0, 'GET /compliance/rules 200 → total>0（缺失也非空）')
      check(rv.body?.source === 'file' || rv.body?.source === 'builtin', `source ∈ {file,builtin}（实际 ${rv.body?.source}）`)
      check(typeof rv.body?.byCategory === 'object' && Object.keys(rv.body.byCategory ?? {}).length > 0, 'byCategory 非空')
    },

    // ================= G12.3：合规词库补充建议 + 采纳写入 =================
    'g12-suggest': async () => {
      const { suggestRules, appendRules } = await import('../src/services/compliance-suggest')
      await clearAll()
      const pid = await insertProject('g12-suggest')
      // '最好' 在内置 BASE_RULES 中 → 建议应被去重剔除；仅 '全网最低价' / '限量抢购' 为候选
      await insertAssetWithCompliance(pid, [
        { category: '广告合规', quote: '最好', reason: '绝对化用语' },
        { category: '广告合规', quote: '全网最低价', reason: '夸大宣传' },
      ])
      await insertAssetWithCompliance(pid, [{ category: '促销', quote: '限量抢购', reason: '诱导' }])

      const sug = await suggestRules(pid)
      check(Array.isArray(sug) && sug.length >= 2, `项目域聚合 → 候选 ${sug.length} 条`)
      check(sug.every((s) => s.level === 'warn'), '建议一律 warn 起步（升 block 交人工）')
      check(sug.some((s) => s.word.includes('全网最低价')) && sug.some((s) => s.word.includes('限量抢购')), '候选含两个非词库风险词')
      check(!sug.some((s) => s.word === '最好'), '候选剔除词库已有词（最好 ∈ BASE_RULES）')
      const global = await suggestRules(null)
      check(global.length >= sug.length, '全域建议 ⊇ 项目建议')

      // appendRules：建文件 + 去重 + 坏行容错（空词跳过、含 | 清洗）
      const ap1 = await appendRules([
        { category: '测试', word: '限量抢购', level: 'warn' },
        { category: '测试', word: '   ', level: 'warn' }, // 空词 → 跳过
        { category: '特殊', word: 'a|b', level: 'block' }, // | 清洗为空格，合法
      ])
      check(ap1.added === 2, `追加有效 2 条（空词跳过、| 清洗；实际 added=${ap1.added}）`)
      check(ap1.total >= 2 && ap1.total === ap1.added, '新建文件 total = 本次 added（文件此前不存在）')
      const ap2 = await appendRules([{ category: '测试', word: '限量抢购', level: 'warn' }])
      check(ap2.added === 0 && ap2.total === ap1.total, '重复采纳幂等 → added=0（(category,word) 去重）')
      const afterFile = (await import('../src/services/compliance')).loadRules()
      check(afterFile.source === 'file' && afterFile.rules.some((r) => r.word === '限量抢购'), '写入后 loadRules → file 且命中新词')

      // 端点：GET suggest + POST rules（含 400 校验）
      await clearAll()
      const pid2 = await insertProject('g12-suggest-ep')
      await insertAssetWithCompliance(pid2, [{ category: '广告合规', quote: '史上最低价', reason: '夸大' }])
      const sEp = await jget(`/api/v1/compliance/suggest?project_id=${pid2}`)
      check(sEp.status === 200 && Array.isArray(sEp.body?.items), 'GET /compliance/suggest 200 → {items}')
      const postOk = await jpost('/api/v1/compliance/rules', { rules: [{ category: 'x', word: '史上最低价', level: 'warn' }] })
      check(postOk.status === 200 && postOk.body?.added === 1, `POST /compliance/rules 200 → added=1（实际 ${postOk.body?.added}）`)
      const badRules = await jpost('/api/v1/compliance/rules', { rules: 'x' })
      check(badRules.status === 400 && badRules.body?.error?.code === 'bad_rules', 'rules 非数组 → 400 bad_rules')
      const emptyRules = await jpost('/api/v1/compliance/rules', { rules: [] })
      check(emptyRules.status === 400 && emptyRules.body?.error?.code === 'bad_rules', 'rules 空数组 → 400 bad_rules')
    },

    // ================= G12.4：排期发布节奏模板 =================
    'g12-cadence': async () => {
      const { expandCadence } = await import('../src/services/cadence')
      const startAt = Date.now() + 10 * DAY // 确保未来，规避过滤

      // daily：count 个升序、间隔恰 1 天
      const d = expandCadence({ startAt, count: 7, cadence: { kind: 'daily' } })
      check(d.errors.length === 0 && d.timestamps.length === 7, 'daily count=7 → 7 条无错')
      check(d.timestamps.every((t, i) => i === 0 || t - d.timestamps[i - 1] === DAY), 'daily 相邻间隔恰 24h')
      check(d.timestamps[0] === startAt && d.timestamps[6] === startAt + 6 * DAY, 'daily 首=startAt、末=startAt+6d（保时刻）')

      // interval intervalDays=3
      const iv = expandCadence({ startAt, count: 4, cadence: { kind: 'interval', intervalDays: 3 } })
      check(iv.timestamps.length === 4 && iv.timestamps[1] - iv.timestamps[0] === 3 * DAY, 'interval 3 天间隔')

      // weekly：命中起始 weekday → 首条 = startAt、间隔 7 天
      const w = new Date(startAt).getUTCDay()
      const wk = expandCadence({ startAt, count: 3, cadence: { kind: 'weekly', weekdays: [w] } })
      check(wk.timestamps[0] === startAt && wk.timestamps.length === 3 && wk.timestamps[1] - wk.timestamps[0] === 7 * DAY, 'weekly 命中起始 weekday → 首=startAt、7d 递增')
      const wk2 = expandCadence({ startAt, count: 2, cadence: { kind: 'weekly', weekdays: [(w + 1) % 7] } })
      check(wk2.timestamps[0] === startAt + DAY, 'weekly 次一 weekday → 首条向后 1 天')

      // 校验错误分支（不抛、timestamps 空）
      check(expandCadence({ startAt, count: 0, cadence: { kind: 'daily' } }).errors.length > 0, 'count=0 → errors')
      check(expandCadence({ startAt, count: 61, cadence: { kind: 'daily' } }).errors.length > 0, 'count>60 → errors')
      check(expandCadence({ startAt, count: 3, cadence: { kind: 'interval', intervalDays: 1 } }).errors.length > 0, 'intervalDays=1 → errors')
      check(expandCadence({ startAt, count: 3, cadence: { kind: 'weekly', weekdays: [] } }).errors.length > 0, 'weekdays=[] → errors')
      check(expandCadence({ startAt, count: 3, cadence: { kind: 'weekly', weekdays: [9] } }).errors.length > 0, 'weekday 越界 9 → errors')
      check(expandCadence({ startAt: Number.NaN, count: 3, cadence: { kind: 'daily' } }).errors.length > 0, 'startAt 非有限数 → errors')

      // 未来过滤：起始在过去 → 全丢弃、errors 空
      const past = expandCadence({ startAt: Date.now() - 5 * DAY, count: 3, cadence: { kind: 'daily' } })
      check(past.errors.length === 0 && past.timestamps.length === 0, 'startAt 过去 → 时间戳全过滤为空、无 errors')

      // 端点：preview + bulk 建
      await clearAll()
      const pv = await jpost('/api/v1/schedules/cadence-preview', { start_at: startAt, count: 3, cadence: { kind: 'daily' } })
      check(pv.status === 200 && Array.isArray(pv.body?.timestamps) && pv.body.timestamps.length === 3, 'POST /schedules/cadence-preview 200 → 3 timestamps')
      const pvBad = await jpost('/api/v1/schedules/cadence-preview', { start_at: startAt, count: 0, cadence: { kind: 'daily' } })
      check(pvBad.status === 200 && pvBad.body?.errors?.length > 0, 'preview 非法 → 200 + errors（预览不拒、供前端提示）')

      const pid = await insertProject('g12-cadence')
      const bulk = await jpost(`/api/v1/projects/${pid}/schedules/cadence`, {
        start_at: startAt,
        count: 5,
        cadence: { kind: 'daily' },
        name_prefix: '日更',
        input_template: [{ seq: 1 }],
      })
      check(bulk.status === 201 && Array.isArray(bulk.body?.created) && bulk.body.created.length === 5, 'POST projects/:id/schedules/cadence 201 → 建 5 条')
      check(bulk.body?.skipped === 0, '全部未来 → skipped=0')
      check(bulk.body.created[0].name === '日更 #1' && bulk.body.created[4].name === '日更 #5', '名称带 #序')
      check(bulk.body.created.every((s: { status: string }) => s.status === 'pending'), '批量建均 pending（复用单条 createSchedule 语义）')
      const { initDb, db } = await import('../src/db')
      const { schedules } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      await initDb()
      const rows = await db.select({ id: schedules.id }).from(schedules).where(eq(schedules.projectId, pid))
      check(rows.length === 5, `落库 5 条 schedules（实际 ${rows.length}）`)

      const badBulk = await jpost(`/api/v1/projects/${pid}/schedules/cadence`, {
        start_at: startAt,
        count: 3,
        cadence: { kind: 'interval', intervalDays: 1 },
        input_template: [{ seq: 1 }],
      })
      check(badBulk.status === 400 && badBulk.body?.error?.code === 'bad_cadence', '非法 cadence 批量建 → 400 bad_cadence')
      const badTpl = await jpost(`/api/v1/projects/${pid}/schedules/cadence`, {
        start_at: startAt,
        count: 3,
        cadence: { kind: 'daily' },
        input_template: [],
      })
      check(badTpl.status === 400 && badTpl.body?.error?.code === 'bad_input_template', 'input_template 空 → 400 bad_input_template')
    },
  }

  await runSections({ log, title: 'M36', checker, sections: SECTIONS, runners, cleanup: envCleanup })
}

void main()
