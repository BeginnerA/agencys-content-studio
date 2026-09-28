/**
 * 第五期 · 交付包认证：逐格式工程文件纯解析器（规格 2026-09-28 §5）。
 *
 * **纯函数**：输入已生成工程文件文本 + 格式 + fpsHint（EDL 无内禀帧率，由 manifest 注入），输出结构化事实。
 * 只做 `JSON.parse` / 轻量标签扫描 / 有理秒与时码算术——**不引 schema/DTD 库、不 IO、不查库**；
 * 任何解析异常均归为 `wellformed=false` 并诚实带原因，绝不抛（破损包不伪造通过，也不误崩服务）。
 */
import { CERT_DURATION_TOLERANCE_FRAMES, type CertFormat } from './types'

/** 解析出的工程文件事实（缺字段即 null/空，不臆造填充）。 */
export interface AnalyzedProjectFile {
  fmt: CertFormat
  wellformed: boolean
  /** 结构/解析问题原因（wellformed=false 时给）。 */
  reason?: string
  fps: number | null
  /** 声明总时长（帧）；EDL 无内禀总长 → null。 */
  totalFrames: number | null
  /** 镜头段数（V 轨）；不可判 → null。 */
  segmentCount: number | null
  /** 越过声明总长的 clip 计数（offset+dur > total+tol）。 */
  overflowCount: number
  /** 同轨起点非单调递增的违例计数。 */
  orderingViolationCount: number
  /** 时长不匹配违例计数（EDL：ro-ri != so-si 超容差）。 */
  durationMismatchCount: number
  /** 工程文件内媒体引用（包内相对路径 media/...；EDL reel 有损 → 空）。 */
  mediaRefs: string[]
  /** 字幕条数（FCPXML title / OTIO Markdown 轨 / EDL 无 → null）。 */
  subtitleCount: number | null
}

/** `N/Ds`（有理秒，分子即帧）→ 帧数；非法 → null。 */
function rationalFrames(v: string | null | undefined): number | null {
  if (!v) return null
  const m = v.match(/^\s*(\d+)\s*\/\s*(\d+)\s*s?\s*$/)
  return m ? parseInt(m[1]!, 10) : null
}

/** `1/Ns`（frameDuration）→ N（整帧率）；非法 → null。 */
function fpsFromFrameDuration(v: string | null | undefined): number | null {
  if (!v) return null
  const m = v.match(/1\s*\/\s*(\d+)\s*s/)
  return m ? parseInt(m[1]!, 10) : null
}

/** `HH:MM:SS:FF`（NDF）→ 帧（需 fps）；非法 → null。 */
function timecodeToFrames(tc: string, fps: number): number | null {
  const m = tc.match(/^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/)
  if (!m) return null
  const [, hh, mm, ss, ff] = m as unknown as [string, string, string, string, string]
  const f = Math.round(fps) || 25
  return (Number(hh) * 3600 + Number(mm) * 60 + Number(ss)) * f + Number(ff)
}

/** 抽取属性值（`attr="..."`），首个匹配。 */
function attr(html: string, tag: string, name: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*?\\b${name}="([^"]*)"`)
  const m = html.match(re)
  return m ? m[1]! : null
}

/** 安全 URL 解码：畸形百分号编码回退原文（解析器绝不抛的契约）。 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** XML 标签配平 + 单根 + 无未转义裸 & 扫描（忽略 <?...?> 与 <!...>）。 */
function xmlWellFormed(xml: string): { ok: boolean; reason?: string } {
  if (!xml.startsWith('<?xml')) return { ok: false, reason: '缺 XML 声明头' }
  const stack: string[] = []
  let roots = 0
  const re = /<(\/?)([A-Za-z_][\w.-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/?)>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const closing = m[1] === '/'
    const name = m[2]!
    const selfClose = m[4] === '/'
    if (closing) {
      const top = stack.pop()
      if (top !== name) return { ok: false, reason: `标签不配平：期望 </${top ?? name}>，实为 </${name}>` }
    } else if (!selfClose) {
      if (stack.length === 0) roots += 1
      stack.push(name)
    }
  }
  if (stack.length > 0) return { ok: false, reason: `存在未闭合标签：<${stack[stack.length - 1]}>` }
  if (roots !== 1) return { ok: false, reason: `根元素数 ${roots}（应为 1）` }
  if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(xml)) return { ok: false, reason: '存在未转义的裸 & 实体' }
  return { ok: true }
}

/** FCPXML 解析。 */
function analyzeFcpxml(text: string): AnalyzedProjectFile {
  const base: AnalyzedProjectFile = { fmt: 'fcpxml', wellformed: false, fps: null, totalFrames: null, segmentCount: null, overflowCount: 0, orderingViolationCount: 0, durationMismatchCount: 0, mediaRefs: [], subtitleCount: 0 }
  const wf = xmlWellFormed(text)
  if (!wf.ok) return { ...base, reason: wf.reason }
  const fps = fpsFromFrameDuration(attr(text, 'format', 'frameDuration')) ?? 25
  const totalFrames = rationalFrames(attr(text, 'sequence', 'duration'))
  // V1 首 spine（无 role 属性）的 asset-clip 段数
  const vSpine = text.split(/<spine\b/)[1] ?? ''
  const vClips = [...vSpine.matchAll(/<asset-clip\b([^>]*)/g)]
  let overflow = 0
  let prevOffset = -1
  let ordering = 0
  for (const cm of vClips) {
    const off = rationalFrames((cm[1] ?? '').match(/offset="([^"]*)"/)?.[1])
    const dur = rationalFrames((cm[1] ?? '').match(/duration="([^"]*)"/)?.[1])
    if (off === null || dur === null) { overflow += 1; continue } // 时间值缺失/畸形 → 记违例
    if (totalFrames !== null && off + dur > totalFrames + CERT_DURATION_TOLERANCE_FRAMES) overflow += 1
    if (off < prevOffset) ordering += 1
    prevOffset = off
  }
  const mediaRefs = [...text.matchAll(/<asset\b[^>]*?src="file:\/\/([^"]*)"/g)].map((mm) => safeDecode(mm[1]!))
  const subtitleCount = (text.match(/<title\b[^>]*?ref="rTitle"/g) ?? []).length
  return { ...base, wellformed: true, fps, totalFrames, segmentCount: vClips.length, overflowCount: overflow, orderingViolationCount: ordering, mediaRefs, subtitleCount }
}

/** OTIO 解析。 */
function analyzeOtio(text: string): AnalyzedProjectFile {
  const base: AnalyzedProjectFile = { fmt: 'otio', wellformed: false, fps: null, totalFrames: null, segmentCount: null, overflowCount: 0, orderingViolationCount: 0, durationMismatchCount: 0, mediaRefs: [], subtitleCount: 0 }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (e) {
    return { ...base, reason: `JSON 解析失败：${(e as Error).message}` }
  }
  const o = doc as Record<string, unknown>
  if (typeof o.OTIO_SCHEMA !== 'string' || !o.OTIO_SCHEMA.includes('Timeline')) return { ...base, reason: '缺 OTIO_SCHEMA=...Timeline' }
  const tracks = (o.tracks as Record<string, unknown> | undefined)?.children
  if (!Array.isArray(tracks)) return { ...base, reason: '缺 tracks.children 数组' }
  const meta = (o.metadata ?? {}) as Record<string, unknown>
  const fps = typeof meta.fps === 'number' ? meta.fps : null
  const totalFrames = (((o.source_range as Record<string, unknown> | undefined)?.duration as Record<string, unknown> | undefined)?.value as number | undefined) ?? null
  let overflow = 0
  let segmentCount: number | null = null
  let subtitleCount: number | null = null
  const mediaRefs: string[] = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    const schema = typeof n.OTIO_SCHEMA === 'string' ? n.OTIO_SCHEMA : ''
    if (schema.includes('Clip')) {
      const sr = n.source_range as Record<string, unknown> | undefined
      const start = ((sr?.start_time as Record<string, unknown> | undefined)?.value as number | undefined) ?? 0
      const dur = ((sr?.duration as Record<string, unknown> | undefined)?.value as number | undefined) ?? 0
      if (totalFrames !== null && start + dur > totalFrames + CERT_DURATION_TOLERANCE_FRAMES) overflow += 1
      const mr = n.media_reference as Record<string, unknown> | undefined
      if (mr && typeof mr.target_url === 'string' && !mediaRefs.includes(mr.target_url)) mediaRefs.push(mr.target_url)
    }
    const children = n.children
    if (Array.isArray(children)) for (const c of children) walk(c)
  }
  for (const t of tracks) {
    const tn = t as Record<string, unknown>
    const clips = ((tn.children as unknown[] | undefined) ?? []).filter((c) => {
      const cs = (c as Record<string, unknown>)?.OTIO_SCHEMA
      return typeof cs === 'string' && cs.includes('Clip')
    })
    if (tn.kind === 'Video') segmentCount = clips.length
    if (tn.kind === 'Markdown') subtitleCount = clips.length
    walk(t)
  }
  return { ...base, wellformed: true, fps, totalFrames, segmentCount, overflowCount: overflow, mediaRefs, subtitleCount }
}

/** EDL 解析。 */
function analyzeEdl(text: string, fpsHint: number): AnalyzedProjectFile {
  const base: AnalyzedProjectFile = { fmt: 'edl', wellformed: false, fps: fpsHint, totalFrames: null, segmentCount: null, overflowCount: 0, orderingViolationCount: 0, durationMismatchCount: 0, mediaRefs: [], subtitleCount: null }
  const lines = text.split(/\r?\n/)
  const hasTitle = lines.some((l) => /^TITLE:/.test(l))
  const hasFcm = lines.some((l) => /^FCM:/.test(l))
  if (!hasTitle || !hasFcm) return { ...base, reason: '缺 TITLE: 或 FCM: 头' }
  // 事件行：NNNN  reel  track  type  si so ri ro [...]
  const evRe = /^(\d{4})\s+(\S+)\s+(V|AA|A|B)\s+([CD])\s+(\d{2}:\d{2}:\d{2}:\d{2})\s+(\d{2}:\d{2}:\d{2}:\d{2})\s+(\d{2}:\d{2}:\d{2}:\d{2})\s+(\d{2}:\d{2}:\d{2}:\d{2})/
  const events = lines.map((l) => evRe.exec(l)).filter((x): x is RegExpExecArray => x !== null)
  if (events.length === 0) return { ...base, reason: '无可解析的事件行' }
  let mismatch = 0
  let prevRecordIn = new Map<string, number>()
  let ordering = 0
  let vCount = 0
  for (const ev of events) {
    const track = ev[3]!
    const si = timecodeToFrames(ev[5]!, fpsHint)
    const so = timecodeToFrames(ev[6]!, fpsHint)
    const ri = timecodeToFrames(ev[7]!, fpsHint)
    const ro = timecodeToFrames(ev[8]!, fpsHint)
    if (si === null || so === null || ri === null || ro === null) { mismatch += 1; continue }
    if (Math.abs(so - si - (ro - ri)) > CERT_DURATION_TOLERANCE_FRAMES) mismatch += 1 // 源/记录时长不一致
    if (track === 'V') vCount += 1
    const prev = prevRecordIn.get(track)
    if (prev !== undefined && ri < prev) ordering += 1
    prevRecordIn.set(track, ri)
  }
  return { ...base, wellformed: true, segmentCount: vCount, durationMismatchCount: mismatch, orderingViolationCount: ordering }
}

/** 按格式分派解析（fpsHint 供 EDL 用，缺省 25）。 */
export function analyzeProjectFile(text: string, fmt: CertFormat, fpsHint = 25): AnalyzedProjectFile {
  if (fmt === 'fcpxml') return analyzeFcpxml(text)
  if (fmt === 'otio') return analyzeOtio(text)
  return analyzeEdl(text, fpsHint)
}
