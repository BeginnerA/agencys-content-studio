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
    match: async () => {},
    route: async () => {},
  },
})
