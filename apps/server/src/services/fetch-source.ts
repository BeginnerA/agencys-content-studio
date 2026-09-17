/**
 * [M25·G8] 轻量通用抓取（spec §2.8）：任意 URL → 正文文本 → source 资产。
 * - assertSafeUrl：SSRF 硬守卫（仅 http/https、仅 80/443、拒回环/RFC1918/链路本地/ULA/管理域；
 *   已知局限：DNS 解析后指向内网不可拦——本机 hosts 自伤场景，登记 spec §5）。
 * - extractReadableText：确定性零依赖正文提取（与 epub XHTML 提取共用，spec §2.8/§2.2）。
 * - fetchSourceText：原生 fetch（timeout 15s / ≤5MB / 重定向 ≤3 跳逐跳复查守卫）。
 * 无站点适配、无批量爬取、手动触发（用户拍板 2026-09-17）。
 */

export class FetchGuardError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'FetchGuardError'
  }
}

/** 抓取上限（字节）与超时（毫秒） */
export const FETCH_MAX_BYTES = 5 * 1024 * 1024
export const FETCH_TIMEOUT_MS = 15_000

/** IPv4 私有/保留段判定（纯函数，探针直测） */
export function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (!(a >= 0 && a <= 255 && b >= 0 && b <= 255 && Number(m[3]) <= 255 && Number(m[4]) <= 255)) return true // 畸形四元组按拒绝处理
  if (a === 127 || a === 0 || a === 10) return true // 回环 / 本网络 / 私网 A
  if (a === 192 && b === 168) return true // 私网 B
  if (a === 172 && b >= 16 && b <= 31) return true // 私网 B 段
  if (a === 169 && b === 254) return true // 链路本地
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  return false
}

/** IPv6 回环 / 链路本地 / ULA 判定（简化：::1、fe80*、fc/fd 开头） */
export function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === '::1') return true
  if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true
  // IPv4-mapped ::ffff:127.0.0.1
  const mapped = /^::ffff:(.+)$/.exec(h)
  if (mapped && isPrivateIpv4(mapped[1]!)) return true
  return false
}

/**
 * SSRF 守卫（纯函数）：合法返回 URL，非法抛 FetchGuardError。
 * 拒绝：非 http(s)、显式端口非 80/443、localhost/*.local/*.internal/空主机、IPv4/IPv6 私有段与裸数字主机。
 */
export function assertSafeUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new FetchGuardError('bad_url', `URL 非法：${raw.slice(0, 120)}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new FetchGuardError('bad_protocol', `仅支持 http/https：${u.protocol}`)
  }
  let host = u.hostname.toLowerCase()
  if (host.startsWith('[') || host.includes(':')) {
    if (isPrivateIpv6(host)) throw new FetchGuardError('private_host', `拒绝 IPv6 私有/回环地址：${host}`)
    return u
  }
  if (host.endsWith('.') ) host = host.slice(0, -1)
  if (!host) throw new FetchGuardError('bad_host', 'URL 缺主机名')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new FetchGuardError('private_host', `拒绝本机/管理域主机：${host}`)
  }
  if (/^\d+$/.test(host)) throw new FetchGuardError('private_host', `拒绝裸数字主机：${host}`) // 十进制单标签 IPv4 形态
  if (isPrivateIpv4(host)) throw new FetchGuardError('private_host', `拒绝 IPv4 私有/保留地址：${host}`)
  if (u.port && u.port !== '80' && u.port !== '443') {
    throw new FetchGuardError('bad_port', `仅允许 80/443 端口：${u.port}`)
  }
  return u
}

/** HTML 实体解码（常见命名实体 + 数字实体；两轮替换保 &amp;#x 嵌套形态一次） */
export function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·' }
  return s
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body: string) => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        const code = Number.parseInt(body.slice(2), 16)
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all
      }
      if (body.startsWith('#')) {
        const code = Number.parseInt(body.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all
      }
      return named[body.toLowerCase()] ?? all
    })
}

/** 去注释 + 去非内容标签块（script/style 等，含跨行） */
const NOISE_TAG_RE = /<!--[\s\S]*?-->|<(script|style|noscript|template|svg|iframe|form|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi

/** 块级/换行标签 → 换行标记（在去标签前注入 \n 语义） */
const BLOCK_RE = /<\/?(p|div|br|h[1-6]|li|tr|section|article|blockquote|pre)[^>]*>/gi

/**
 * 正文提取（纯函数，零依赖确定性）：
 * ①噪声标签块整体剔除 → ②<article>/<main> 优先区（无则全篇）→ ③块级标签转换行 →
 * ④去剩余标签 → ⑤实体解码 → ⑥行内空白归一 + 压缩连续空行 + trim。
 * 标题（hN）输出为独立纯文本行（不加 `#` 前缀——保 text_split 默认 `^第X章` 行首正则可命中）。
 */
export function extractReadableText(html: string): string {
  let doc = html.replace(NOISE_TAG_RE, ' ')
  for (const tag of ['article', 'main']) {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(doc)
    if (m && m[1]!.replace(/<[^>]*>/g, '').trim().length > 200) {
      doc = m[1]!
      break
    }
  }
  const withBreaks = doc.replace(BLOCK_RE, '\n')
  const text = withBreaks
    .replace(/<[^>]*>/g, ' ')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => decodeEntities(line).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

/** 反爬/空页判定阈值：提取正文 < 200 字符视为失败（spec §2.8） */
export const FETCH_MIN_CHARS = 200

/** 抓取主函数（网络；实弹专用，探针只直测上方纯函数） */
export async function fetchSourceText(rawUrl: string): Promise<{ text: string; title: string; finalUrl: string }> {
  let url = assertSafeUrl(rawUrl)
  const agent = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  let res: Response | null = null
  for (let hop = 0; hop <= 3; hop++) {
    res = await fetch(url, { signal: agent, redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (compatible; agencys-content-studio/1.0)' } }).catch((err: Error) => {
      throw new FetchGuardError('fetch_failed', `抓取失败：${err.message}`)
    })
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!loc) break
    if (hop === 3) throw new FetchGuardError('too_many_redirects', '重定向超过 3 跳')
    url = assertSafeUrl(new URL(loc, url).toString()) // 逐跳复查守卫
  }
  if (!res || !res.ok) throw new FetchGuardError('bad_status', `抓取返回 ${res?.status ?? '???'}`)
  const ct = res.headers.get('content-type') ?? ''
  if (!/text\/html|text\/plain|application\/xhtml/.test(ct)) {
    throw new FetchGuardError('bad_content_type', `不支持的内容类型：${ct.slice(0, 60)}`)
  }
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.byteLength > FETCH_MAX_BYTES) throw new FetchGuardError('too_large', '页面超过 5MB 上限')
  const htmlText = new TextDecoder('utf-8').decode(buf)
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(htmlText)?.[1]?.trim() ?? ''
  const text = extractReadableText(htmlText)
  if (text.length < FETCH_MIN_CHARS) {
    throw new FetchGuardError('too_short', `提取正文仅 ${text.length} 字符（反爬页/空页？请改用文件导入）`)
  }
  return { text, title, finalUrl: url.toString() }
}
