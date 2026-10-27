/**
 * 表格解析（M67 平台数据导入回灌，spec §3.1）：xlsx / csv → 二维字符串表，纯函数零 IO。
 * 0 新依赖：xlsx 走 fflate 解包 + 最小 sheet XML 读取器（与 doc-parse.ts 同风格）；
 * CSV 手写 RFC4180；GBK 编码走 Node 内置 ICU TextDecoder('gb18030') 兜底。
 * 边界（spec §五）：合并单元格不展开、多 sheet 只读第一张、BIFF 二进制 xls 不支持。
 */
import { unzipSync, strFromU8 } from 'fflate'

export type TableParseCode =
  | 'too_large'
  | 'too_many_rows'
  | 'bad_ext'
  | 'bad_zip'
  | 'bad_xlsx'
  | 'old_xls'
  | 'no_sheet'

export class TableParseError extends Error {
  constructor(
    readonly code: TableParseCode,
    message: string,
  ) {
    super(message)
    this.name = 'TableParseError'
  }
}

export interface ParsedTable {
  header: string[]
  rows: string[][]
  warnings: string[]
}

export const TABLE_MAX_FILE_BYTES = 10 * 1024 * 1024
export const TABLE_MAX_ROWS = 2000
/** zip 炸弹防护：单条目解压后上限（zip 头声明的 originalSize，超限拒绝解包） */
export const TABLE_MAX_ENTRY_BYTES = 128 * 1024 * 1024

// ⚠ fflate 第二参语义：true = latin1（中文乱码），缺省 = UTF-8（doc-parse.ts:13 先例）
const utf8 = (b: Uint8Array): string => strFromU8(b)

function unescapeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Excel 1900 序列号 → ms（epoch 1899-12-30；浮点四舍五入到毫秒） */
function serialToMs(serial: number): number {
  return Math.round((serial - 25569) * 86_400_000)
}

/** 序列号按无时区朴素时间格式化（UTC 字段取值 → 与 Excel 所见一致；下游按本地解析，端到端语义一致） */
function fmtNaive(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/** styles.xml → 样式索引是否日期格式（内置 14–22 或自定义 formatCode 含 y/m/d/h） */
function loadDateStyles(stylesXml: string): (s: number) => boolean {
  const custom = new Map<string, string>()
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"[^>]*\/?>/g)) {
    custom.set(m[1]!, m[2]!)
  }
  const xfsBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)
  const fmtIds: string[] = []
  if (xfsBlock) for (const m of xfsBlock[1]!.matchAll(/<xf\b[^>]*numFmtId="(\d+)"[^>]*\/?>/g)) fmtIds.push(m[1]!)
  const isDateFmt = (id: string): boolean => {
    const n = Number(id)
    if (n >= 14 && n <= 22) return true
    const code = custom.get(id)
    return !!code && /[ymdh]/i.test(code)
  }
  return (s: number) => s >= 0 && s < fmtIds.length && isDateFmt(fmtIds[s]!)
}

/** A1 引用 → 0 基列索引（A=0） */
function colIndex(ref: string): number {
  let n = 0
  for (const ch of ref) {
    if (ch >= 'A' && ch <= 'Z') n = n * 26 + (ch.charCodeAt(0) - 64)
    else break
  }
  return n - 1
}

function parseXlsx(buf: Buffer): ParsedTable {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buf), {
      // zip 炸弹防护：头声明解压后超限的条目直接拒绝（filter 内抛 TableParseError 同步穿出 unzipSync；
      // 不可改为 return false——fflate 对被过滤条目是静默跳过，会退化为误导性的 no_sheet）
      filter: (f) => {
        if (f.originalSize > TABLE_MAX_ENTRY_BYTES) {
          throw new TableParseError('bad_zip', `zip 条目解压后 ${f.originalSize} 字节超上限 ${TABLE_MAX_ENTRY_BYTES}`)
        }
        return true
      },
    })
  } catch (e) {
    if (e instanceof TableParseError) throw e
    throw new TableParseError('bad_zip', 'xlsx 解包失败（加密或损坏？）')
  }
  const sheetKey = Object.keys(files).find((k) => /^xl\/worksheets\/sheet1\.xml$/i.test(k))
  if (!sheetKey) throw new TableParseError('no_sheet', 'xlsx 缺 xl/worksheets/sheet1.xml（多 sheet 仅读第一张）')
  const sheetXml = utf8(files[sheetKey]!)

  const warnings: string[] = []
  const shared: string[] = []
  const sstKey = Object.keys(files).find((k) => /^xl\/sharedStrings\.xml$/i.test(k))
  if (sstKey) {
    for (const m of utf8(files[sstKey]!).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      let text = ''
      for (const t of m[1]!.matchAll(/<t\b[^>]*(?:\/>|>([\s\S]*?)<\/t>)/g)) text += t[1] ?? ''
      shared.push(unescapeXml(text))
    }
  }

  let isDateStyle: ((s: number) => boolean) | null = null
  const stylesKey = Object.keys(files).find((k) => /^xl\/styles\.xml$/i.test(k))
  if (stylesKey) isDateStyle = loadDateStyles(utf8(files[stylesKey]!))

  // 稀疏网格：行号/列号定位，空缺补空串
  const grid = new Map<number, Map<number, string>>()
  for (const rowM of sheetXml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const r = Number(rowM[1]!)
    for (const cM of rowM[2]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cM[1]!
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? ''
      const col = ref ? colIndex(ref) : -1
      if (col < 0) continue
      const t = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n'
      const sAttr = /\bs="(\d+)"/.exec(attrs)?.[1]
      const inner = cM[2] ?? ''
      let val: string | null = null
      if (t === 'inlineStr') {
        let text = ''
        for (const tm of inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += tm[1]!
        val = unescapeXml(text)
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
        if (v !== undefined) {
          if (t === 's') {
            const idx = Number(v)
            if (Number.isInteger(idx) && idx >= 0 && idx < shared.length) val = shared[idx]!
            else warnings.push(`共享字符串索引越界：${v}`)
          } else {
            val = unescapeXml(v)
            // t="str"（公式缓存文本）与 t="b" 均按字符串处理；日期判定仅对数字形态生效
            if (t !== 'str' && isDateStyle?.(Number(sAttr ?? -1))) {
              const n = Number(val)
              if (Number.isFinite(n) && n > 0) val = fmtNaive(serialToMs(n))
            }
          }
        }
      }
      if (val !== null) {
        let row = grid.get(r)
        if (!row) grid.set(r, (row = new Map()))
        row.set(col, val)
      }
    }
  }

  const rowKeys = [...grid.keys()].sort((a, b) => a - b)
  while (rowKeys.length > 0) {
    const last = rowKeys[rowKeys.length - 1]!
    const cells = grid.get(last)!
    if (cells.size === 0 || [...cells.values()].every((c) => c === '')) rowKeys.pop()
    else break
  }
  if (rowKeys.length === 0) return { header: [], rows: [], warnings }
  if (rowKeys.length - 1 > TABLE_MAX_ROWS) {
    throw new TableParseError('too_many_rows', `数据行 ${rowKeys.length - 1} 超上限 ${TABLE_MAX_ROWS}`)
  }
  const width = Math.max(...rowKeys.map((r) => Math.max(...grid.get(r)!.keys()) + 1))
  const dense = rowKeys.map((r) => {
    const cells = grid.get(r)!
    const row: string[] = []
    for (let j = 0; j < width; j++) row.push(cells.get(j) ?? '')
    return row
  })
  const [header, ...rows] = dense
  return { header: header ?? [], rows, warnings }
}

function parseCsv(buf: Buffer): ParsedTable {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    text = new TextDecoder('gb18030').decode(buf)
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let touched = false
  const pushField = (): void => {
    row.push(field)
    field = ''
  }
  const pushRow = (): void => {
    pushField()
    if (touched || row.some((c) => c !== '')) rows.push(row)
    row = []
    touched = false
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
    } else if (ch === '"') {
      inQuotes = true
      touched = true
    } else if (ch === ',') {
      pushField()
      touched = true
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      pushRow()
    } else {
      field += ch
      touched = true
    }
  }
  if (field !== '' || row.length > 0 || touched) pushRow()

  if (rows.length - 1 > TABLE_MAX_ROWS) {
    throw new TableParseError('too_many_rows', `数据行 ${rows.length - 1} 超上限 ${TABLE_MAX_ROWS}`)
  }
  const [header, ...data] = rows
  return { header: header ?? [], rows: data, warnings: [] }
}

/** 入口：按扩展名分发 */
export function parseTable(buf: Buffer, ext: string): ParsedTable {
  if (buf.byteLength > TABLE_MAX_FILE_BYTES) {
    throw new TableParseError('too_large', `文件 ${buf.byteLength} 字节超上限 ${TABLE_MAX_FILE_BYTES}`)
  }
  const e = ext.toLowerCase().replace(/^\./, '')
  if (e === 'csv') return parseCsv(buf)
  if (e === 'xlsx' || e === 'xls') {
    // 仅 .xls 嗅探 PK 魔数（不少平台导出实为 xlsx 改名）；.xlsx 非 zip 容器交由 parseXlsx 抛 bad_zip
    if (e === 'xls' && buf.subarray(0, 2).toString('latin1') !== 'PK') {
      throw new TableParseError('old_xls', '旧版二进制 xls 不支持，请另存为 xlsx/csv')
    }
    try {
      return parseXlsx(buf)
    } catch (err) {
      if (err instanceof TableParseError) throw err
      // 畸形数字实体等非预期异常（String.fromCodePoint 遇码点 >0x10FFFF 抛 RangeError）→ 统一 400 而非 500
      throw new TableParseError('bad_xlsx', 'xlsx 内容解析失败（含畸形实体或数据？）')
    }
  }
  throw new TableParseError('bad_ext', `不支持的扩展名：${ext}（支持 xlsx/csv）`)
}
