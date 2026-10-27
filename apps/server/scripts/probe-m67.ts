/**
 * M67 探针（平台数据导入回灌）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m67.ts [--section=parse|match|route]
 *
 * 隔离策略：isolatedEnv('m67') 一次性临时目录（独立 studio.db + workspace），
 * 必须先于任何 src 动态 import。零网络零付费。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup } = isolatedEnv('m67')

const SECTIONS = ['parse', 'match', 'route'] as const

const { createLogger } = await import('../src/logger')
const log = createLogger('probe-m67')
const checker: Checker = makeChecker(log)
const check = checker.check

await runSections({
  log, title: 'M67', checker, cleanup, sections: SECTIONS,
  registry: async () => {
    const { initDb } = await import('../src/db')
    await initDb()
    check(true, '初始化隔离库完成')
  },
  runners: {
    parse: async () => {
      const { parseTable, TableParseError, TABLE_MAX_ROWS } = await import('../src/services/table-parse')
      const { zipSync, strToU8 } = await import('fflate')
      const { makeXlsx } = await import('./probe-m67-fixtures')

      const SI = (t: string): string => `<si><t>${t}</t></si>`
      const STYLES = `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy/m/d h:mm"/></numFmts><cellXfs count="2"><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`
      void makeXlsx; void zipSync; void strToU8; void STYLES; void SI

      // —— 基本读回：共享字符串 / 转义 / 富文本拼接 / 内联串 / 数字 / 无样式日期列原样 ——
      const sheet1 =
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>文本标题</t></is></c><c r="B2"><v>12345</v></c><c r="D2"><v>45413.5208333333</v></c></row>'
      const t1 = parseTable(makeXlsx(sheet1, [SI('标题'), SI('A&amp;B链接'), '<si><r><t>富</t></r><r><t>文本</t></r></si>', SI('发布时间')]), 'xlsx')
      check(t1.header.join('|') === '标题|A&B链接|富文本|发布时间', '表头读回（共享串+XML转义+富文本拼接）')
      check(t1.rows[0]![0] === '文本标题', 'inlineStr 单元格读回')
      check(t1.rows[0]![1] === '12345', '数字单元格读回')
      check(t1.rows[0]![2] === '', '缺 C 列单元格补空串')
      check(t1.rows[0]![3] === '45413.5208333333', '无样式匹配时日期列原样保留数字')

      // —— 日期判定：内置 numFmtId 14 与自定义 formatCode 两路 ——
      const sheet2 =
        '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' +
        '<row r="2"><c r="A2" s="0"><v>45413.5208333333</v></c></row>' +
        '<row r="3"><c r="A3" s="1"><v>45413.5208333333</v></c></row>'
      const t2 = parseTable(makeXlsx(sheet2, [SI('发布时间')], STYLES), 'xlsx')
      check(t2.rows[0]![0] === '2024-05-01 12:30', '内置 numFmtId 14 日期序列号转换')
      check(t2.rows[1]![0] === '2024-05-01 12:30', '自定义 formatCode（含 y/m/d）日期转换')

      // —— CSV：RFC4180 转义与引号内换行 ——
      const t3 = parseTable(Buffer.from('标题,播放\n"含,逗号","含""引号"\n"多\n行",3\n'), 'csv')
      check(t3.header.join('|') === '标题|播放', 'CSV 表头读回')
      check(t3.rows[0]![0] === '含,逗号' && t3.rows[0]![1] === '含"引号', 'CSV 引号包裹与双引号转义')
      check(t3.rows[1]![0] === '多\n行' && t3.rows[1]![1] === '3', 'CSV 引号内换行保留')

      // —— GBK 编码兜底（'x,y\n中文,123' 的 GBK 字节：中=D6D0 文=CEC4；首行 ASCII 表头使断言落在 rows[0]）——
      const t4 = parseTable(Buffer.from([0x78, 0x2c, 0x79, 0x0a, 0xd6, 0xd0, 0xce, 0xc4, 0x2c, 0x31, 0x32, 0x33]), 'csv')
      check(t4.rows[0]![0] === '中文' && t4.rows[0]![1] === '123', 'GBK 编码经 gb18030 兜底解码')

      // —— 错误面 ——
      const big = Buffer.from('标题\n' + Array.from({ length: TABLE_MAX_ROWS + 1 }, (_, i) => `r${i}`).join('\n'))
      let code = ''
      try { parseTable(big, 'csv') } catch (e) { code = e instanceof TableParseError ? e.code : '' }
      check(code === 'too_many_rows', `超 ${TABLE_MAX_ROWS} 行抛 too_many_rows`)
      code = ''
      try { parseTable(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), 'xls') } catch (e) { code = e instanceof TableParseError ? e.code : '' }
      check(code === 'old_xls', 'BIFF 二进制 xls 抛 old_xls')
      code = ''
      try { parseTable(Buffer.from('x'), 'txt') } catch (e) { code = e instanceof TableParseError ? e.code : '' }
      check(code === 'bad_ext', '不支持的扩展名抛 bad_ext')
      code = ''
      try { parseTable(Buffer.from('not a zip'), 'xlsx') } catch (e) { code = e instanceof TableParseError ? e.code : '' }
      check(code === 'bad_zip', '非 zip 容器抛 bad_zip')
    },
    match: async () => {
      const { assembleRows, matchRows, parseMapping, ImportError } = await import('../src/services/publication-import')
      const { db } = await import('../src/db')
      const { publications } = await import('../src/db/schema')
      const { createProject } = await import('./probe-m67-fixtures')

      // —— parseMapping 校验面 ——
      let bad = ''
      try { parseMapping({}) } catch (e) { bad = e instanceof ImportError ? e.code : '' }
      check(bad === 'bad_mapping', '空 mapping 抛 bad_mapping')
      bad = ''
      try { parseMapping({ title: 0, foo: 1 }) } catch (e) { bad = e instanceof ImportError ? e.code : '' }
      check(bad === 'bad_mapping', '未知字段抛 bad_mapping')
      bad = ''
      try { parseMapping({ views: -1 }) } catch (e) { bad = e instanceof ImportError ? e.code : '' }
      check(bad === 'bad_mapping', '负数列索引抛 bad_mapping')
      const m = parseMapping({ title: 0, url: 1, publishedAt: 2, views: 3, likes: 4 })
      check(m.views === 3 && m.title === 0, '合法 mapping 解析')

      // —— assembleRows：日期双通道 / 越界缺列 / 异常日期告警 ——
      const table = {
        header: ['标题', '链接', '时间', '播放', '点赞'],
        rows: [
          ['A 片', 'https://x/1', '2026/1/5 10:00', '1,000', '50'],
          ['B 片', '', '2026/1/6', '2000', ''],
          ['B 片', '', '2026/1/6', '2500', '9'],
          ['坏日期', '', 'not-a-date', '10', '1'],
        ],
        warnings: [],
      }
      const { rows: assembled, warnings } = assembleRows(table, m, 'douyin')
      check(assembled.length === 4, '装配行数一致')
      check(assembled[0]!.metrics.views === 1000, '指标千分位归一')
      check(assembled[0]!.publishedAt !== null, '文本日期（斜杠形态）解析')
      check(warnings.some((w) => w.includes('无法解析')), '异常日期触发告警')
      check(assembled[3]!.publishedAt === null, '异常日期置空')

      const partial = assembleRows(table, parseMapping({ views: 9 }), 'douyin')
      check(partial.rows.every((r) => r.title === null && r.url === null), '未映射字段为空')
      check(partial.warnings.some((w) => w.includes('越界')), '列索引越界告警且按缺失处理')

      // —— matchRows：URL 匹配 / 更新保护 / 同文件去重 / 标题+同日 ——
      const projectId = await createProject()
      const t = Date.now()
      const existing1 = (
        await db
          .insert(publications)
          .values({
            projectId, platform: 'douyin', url: 'https://x/1', title: '旧标题A',
            metrics: JSON.stringify({ views: 999, likes: 0 }), publishedAt: new Date(2026, 0, 1).getTime(),
            abGroup: 'B组', note: '手工备注', runId: 777, assetId: 888, createdAt: t, updatedAt: t,
          })
          .returning()
      )[0]!
      const plan = matchRows(assembled, [existing1])
      check(plan.duplicates === 1, '文件内同键重复行计数（B 片两行取最后）')
      check(plan.updates.length === 1 && plan.creates.length === 2, '划分：A=更新、B 与坏日期=新建')
      const upd = plan.updates[0]!
      check(upd.id === existing1.id, 'URL 精确匹配命中已有记录')
      const pm = JSON.parse(upd.patch.metrics) as Record<string, number>
      check(pm.views === 1000 && pm.likes === 50, 'metrics 非零覆盖、零值保留原值')
      check(upd.patch.title === '旧标题A', 'title 原值非空不覆盖')
      check(!('abGroup' in upd.patch) && !('note' in upd.patch) && !('runId' in upd.patch) && !('assetId' in upd.patch), 'patch 白名单不含保护字段')
      const bRow = plan.creates.find((r) => r.title === 'B 片')!
      check(bRow.metrics.views === 2500 && bRow.metrics.likes === 9, '同键重复取最后一条数值')

      // 标题+同日匹配（URL 缺失）
      const existing2 = (
        await db
          .insert(publications)
          .values({ projectId, platform: 'douyin', title: 'C 片', publishedAt: new Date(2026, 0, 6, 9, 0).getTime(), metrics: '{}', createdAt: t, updatedAt: t })
          .returning()
      )[0]!
      const table2 = { header: ['标题', '时间', '播放'], rows: [['C 片', '2026/1/6', '300'], ['D 片', '2026/1/7', '400']], warnings: [] }
      const m2 = parseMapping({ title: 0, publishedAt: 1, views: 2 })
      const plan2 = matchRows(assembleRows(table2, m2, 'douyin').rows, [existing1, existing2])
      check(plan2.updates.length === 1 && plan2.updates[0]!.id === existing2.id, 'URL 缺失 → 标题全等+同日命中')
      check(plan2.creates.length === 1 && plan2.creates[0]!.title === 'D 片', '未命中 → 新建')
      // 纯函数幂等：同输入两次结果一致（落库幂等在 route 节端到端断言）
      const plan3 = matchRows(assembleRows(table2, m2, 'douyin').rows, [existing1, existing2])
      check(plan3.updates[0]!.id === plan2.updates[0]!.id && plan3.creates.length === plan2.creates.length, '匹配结果对同输入稳定')
    },
    route: async () => {},
  },
})
