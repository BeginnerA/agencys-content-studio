/**
 * docx / epub 文档解析（spec §2.2）：二进制 → 纯文本（供 text_split 章节切分）。
 * 依赖（用户拍板 2026-09-17， d3-force 例外原则）：
 * - mammoth：docx → raw text（纯解析库）；
 * - fflate：epub zip 解包（自带类型； 探针亦用其 zipSync 合成样本）。
 * XHTML 正文提取复用 G8 的 extractReadableText（spec §2.8 共用纯函数）。
 * 表格/文本框/批注/docx 图片保真明确排除（spec §8）；DRM epub 不支持。
 */
import { unzipSync, strFromU8 } from 'fflate'
import mammoth from 'mammoth'
import { extractReadableText } from './fetch-source'

// ⚠ fflate 字符串互转的第二参语义与直觉相反：true = latin1（中文乱码/截断），缺省/false = UTF-8。
// 实测 fflate 0.8.3：strFromU8(utf8Bytes, true) → "ç¬¬ä¸€…"。一律用无参形态（UTF-8 默认）。
const utf8 = (b: Uint8Array): string => strFromU8(b)

export class DocParseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'DocParseError'
  }
}

export type DocFormat = 'docx' | 'epub'

/** 按扩展名判定文档格式（非 docx/epub → null） */
export function docFormatByExt(name: string): DocFormat | null {
  const e = name.toLowerCase()
  if (e.endsWith('.docx')) return 'docx'
  if (e.endsWith('.epub')) return 'epub'
  return null
}

/** zip 路径归一（epub 内 OPF href 相对解析：去 ./、处理 ../） */
function resolveZipPath(baseDir: string, href: string): string {
  const joined = baseDir ? `${baseDir}/${href}` : href
  const out: string[] = []
  for (const seg of joined.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

/** container.xml → OPF 全路径（纯函数级解析；找不到 → DocParseError） */
export function findOpfPath(files: Record<string, Uint8Array>): string {
  const container = files['META-INF/container.xml'] ?? files['meta-inf/container.xml']
  if (!container) throw new DocParseError('no_container', 'epub 缺 META-INF/container.xml（非合法 epub？）')
  const m = /full-path\s*=\s*"([^"]+)"|full-path\s*=\s*'([^']+)'/.exec(utf8(container))
  const path = (m?.[1] ?? m?.[2] ?? '').trim()
  if (!path || !files[path]) throw new DocParseError('no_opf', `container.xml 指向的 OPF 不存在：${path || '(空)'}`)
  return path
}

export interface EpubSpineItem {
  /** zip 内文件路径 */
  path: string
  /** manifest 标题（可能缺） */
  title: string
}

/**
 * OPF → spine 线性读取序列（导出供探针直测）：
 * manifest（id → href+title）× spine（idref 顺序）；跳过非文档 media-type（图片等）。
 */
export function parseEpubSpine(opfXml: string, opfPath: string): EpubSpineItem[] {
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : ''
  const items = new Map<string, { path: string; title: string }>()
  for (const m of opfXml.matchAll(/<item\b[^>]*>/gi)) {
    const tag = m[0]
    const id = /id\s*=\s*"([^"]+)"/.exec(tag)?.[1]
    const href = /href\s*=\s*"([^"]+)"/.exec(tag)?.[1]
    const mediaType = /media-type\s*=\s*"([^"]*)"/.exec(tag)?.[1] ?? ''
    const title = /title\s*=\s*"([^"]*)"/.exec(tag)?.[1] ?? ''
    if (!id || !href) continue
    if (mediaType && !/xhtml|html|xml/.test(mediaType)) continue // 图片/样式/字体跳过
    items.set(id, { path: resolveZipPath(baseDir, decodeURIComponent(href.split('#')[0]!)), title })
  }
  const out: EpubSpineItem[] = []
  for (const m of opfXml.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = /idref\s*=\s*"([^"]+)"/.exec(m[0])?.[1]
    const it = idref ? items.get(idref) : undefined
    if (it) out.push({ path: it.path, title: it.title })
  }
  if (out.length === 0) throw new DocParseError('empty_spine', 'epub spine 为空或无文档项')
  return out
}

/** epub 字节 → 按 spine 顺序拼接的纯文本（章间空行分隔；XHTML 提取复用 extractReadableText） */
export function epubToText(buf: Uint8Array): string {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(buf)
  } catch {
    throw new DocParseError('bad_zip', 'epub 解包失败（非 zip / 已损坏 / DRM 加密？）')
  }
  const opfPath = findOpfPath(files)
  const spine = parseEpubSpine(utf8(files[opfPath]!), opfPath)
  const parts: string[] = []
  for (const item of spine) {
    const data = files[item.path]
    if (!data) continue // spine 指向缺失文件 → 宽容跳过（epub 制作瑕疵常见）
    const text = extractReadableText(utf8(data))
    if (text) parts.push(text)
  }
  if (parts.length === 0) throw new DocParseError('no_text', 'epub 各章均未提取到正文')
  return parts.join('\n\n')
}

/**
 * 解析入口：docx → mammoth raw text；epub → fflate spine 提取。
 * 空文本 / 未知扩展 / 损坏 → DocParseError（导入侧 400 明示）。
 */
export async function parseDocBuffer(name: string, buf: Uint8Array): Promise<{ text: string; format: DocFormat }> {
  const format = docFormatByExt(name)
  if (!format) throw new DocParseError('bad_format', `非 docx/epub：${name}`)
  let text = ''
  if (format === 'docx') {
    try {
      const r = await mammoth.extractRawText({ buffer: Buffer.from(buf) })
      text = r.value ?? ''
    } catch (err) {
      throw new DocParseError('bad_docx', `docx 解析失败：${(err as Error).message}`)
    }
  } else {
    text = epubToText(buf)
  }
  const NL = String.fromCharCode(10)
  text = text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, NL)
    .replace(/\n{4,}/g, `${NL}${NL}${NL}`)
    .trim()
  if (!text) throw new DocParseError('empty_doc', `${name} 未提取到文本内容（空文档或内容全为非文本对象）`)
  return { text, format }
}
