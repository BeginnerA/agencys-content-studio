import { writeTextAsset } from '../../services/storage'
import type { StepContext } from '../context'
import type { StepResult } from '../types'

/**
 * [M9] text_split：长文本按章节切分（小说改编链第 2 段）。
 * inputs.source（资产 id 数组，按序拼接全部文本资产）→ 三级正则（用户 > AI > 默认）切分 →
 * 章节范围过滤 → min_chapters 校验 → 产物 [manifest, ...逐章资产]（顺序即契约：
 * 下游 ai_text batch 读首个资产 JSON，item.asset_id 取逐章全文）。
 * 纯函数 splitChapters / parseChapterRange 导出供探针直接断言。
 */

export interface ChapterSlice {
  /** 切分顺序号（1-based；与 Toonflow chapterIndex 自增同义，不依赖原文编号） */
  index: number
  /** 章标题（捕获组 2；可能为空串） */
  title: string
  /** 所属卷标题（无卷识别 → null） */
  reel: string | null
  /** 章节正文（含章头行，到下一章头/卷头/文末） */
  content: string
  /** [M25·G6] per_source=true 时归属源文件名（逐 source 独立切分；缺省不落盘字段） */
  source_book?: string
}

/** 默认章头正则（对齐 Toonflow DEFAULT_CHAPTER_REGEX：组1=章号 组2=标题；^ 行首锚定防正文「第X章」引用误切） */
export const DEFAULT_CHAPTER_REGEX = /^第\s*([0-9０-９零一二三四五六七八九十百千万两]+)\s*[章回节]\s*([^\n\r]*)/gm

/** 卷头正则（行首；对齐 Toonflow REEL_REGEX） */
export const REEL_REGEX = /^(第[\d一二三四五六七八九十百千两]+卷)\s*([^\n第]*)/gm

/**
 * 章节范围解析："1-30" / "1,3,5-9" → 顺序号数组（升序去重）。
 * 空串/非法（含 5-3 / 非数字段）→ null（调用方抛错指引）。
 */
export function parseChapterRange(spec: string): number[] | null {
  const s = spec.trim()
  if (!s) return null
  const out = new Set<number>()
  for (const partRaw of s.split(/[,，、]/)) {
    const part = partRaw.trim()
    if (!part) return null
    const rangeM = /^(\d+)\s*(?:-|~|至)\s*(\d+)$/.exec(part)
    if (rangeM) {
      const a = Number(rangeM[1]!)
      const b = Number(rangeM[2]!)
      if (a < 1 || b < a || b - a > 999) return null
      for (let i = a; i <= b; i++) out.add(i)
      continue
    }
    if (/^\d+$/.test(part)) {
      const n = Number(part)
      if (n < 1) return null
      out.add(n)
      continue
    }
    return null
  }
  return [...out].sort((x, y) => x - y)
}

/**
 * 切分主函数（纯函数）：
 * 卷标记（REEL_REGEX）与章标记（chapterRe；null 用默认链）按位置合并扫描；
 * 卷头终结当前章（卷头行不落入上一章），其后章归属新卷；首个章头前文本丢弃；
 * 无章标记 → 整文单章（title=''，由 min_chapters 拦截）。
 */
export function splitChapters(
  text: string,
  chapterRe: RegExp | null,
): { chapters: ChapterSlice[]; skippedHeadChars: number } {
  const chRe = chapterRe
    ? new RegExp(chapterRe.source, chapterRe.flags.includes('g') ? chapterRe.flags : `${chapterRe.flags}g`)
    : new RegExp(DEFAULT_CHAPTER_REGEX.source, 'gm')
  const reelRe = new RegExp(REEL_REGEX.source, REEL_REGEX.flags)

  type Mark = { kind: 'reel' | 'chapter'; at: number; title: string }
  const marks: Mark[] = []
  for (const m of text.matchAll(reelRe)) {
    marks.push({ kind: 'reel', at: m.index ?? 0, title: m[0].trim() })
  }
  for (const m of text.matchAll(chRe)) {
    marks.push({ kind: 'chapter', at: m.index ?? 0, title: (m[2] ?? '').trim() })
  }
  // 位置升序；同位置章标记优先（章头行内含卷词时不让卷标记抢先）
  marks.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === 'chapter' ? -1 : 1))

  const chapters: ChapterSlice[] = []
  let skippedHeadChars = 0
  let reel: string | null = null
  let current: { head: number; title: string; reel: string | null } | null = null
  const flush = (end: number): void => {
    if (!current) return
    chapters.push({
      index: chapters.length + 1,
      title: current.title,
      reel: current.reel,
      content: text.slice(current.head, end).trim(),
    })
    current = null
  }
  for (const mk of marks) {
    if (mk.kind === 'reel') {
      flush(mk.at)
      reel = mk.title
      continue
    }
    flush(mk.at)
    if (chapters.length === 0) skippedHeadChars = mk.at
    current = { head: mk.at, title: mk.title, reel }
  }
  flush(text.length)
  // 全文无章标记 → 整文单章（title=''；由调用方 min_chapters 拦截，空文本除外）
  if (chapters.length === 0 && text.trim()) {
    chapters.push({ index: 1, title: '', reel: null, content: text.trim() })
  }

  return { chapters, skippedHeadChars }
}

/**
 * 章节切分 action。
 * params：min_chapters（默认 2）/ output_purpose（默认 chapters）/ regex_max_chars（默认 300）。
 * inputs：source（必需）/ chapter_regex（选填，透传 input）/ chapter_range（选填，透传 input）/ ai_regex（选填，上游资产）。
 */
export async function textSplit(ctx: StepContext): Promise<StepResult> {
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const minChapters =
    typeof params['min_chapters'] === 'number' ? Math.max(1, Math.floor(params['min_chapters'])) : 2
  const outputPurpose =
    typeof params['output_purpose'] === 'string' && params['output_purpose'] ? params['output_purpose'] : 'chapters'
  const maxRegexChars = typeof params['regex_max_chars'] === 'number' ? params['regex_max_chars'] : 300
  // [M25·G6] 多部合并：逐 source 独立切分、index 跨书续编（默认 false = 现行为逐字不变）
  const perSource = params['per_source'] === true

  // —— 1. 源资产：按序拼接（非文本跳过；全非文本抛错） ——
  const srcIds = ctx.assetIdsOf('source')
  if (srcIds.length === 0) throw new Error('inputs.source 无文本资产（请先选择小说文件）')
  const srcRows = await ctx.assetsOf(srcIds)
  const textParts: string[] = []
  const usedIds: number[] = []
  const usedNames: string[] = []
  for (const a of srcRows) {
    if (a.kind !== 'text') {
      ctx.log(`非文本资产跳过：${a.name}（${a.kind}）`)
      continue
    }
    textParts.push(await ctx.readText(a.id))
    usedIds.push(a.id)
    usedNames.push(a.name)
  }
  if (textParts.length === 0) throw new Error('inputs.source 全部为非文本资产，无法切分')
  const fullText = textParts.join('\n\n')
  ctx.log(`小说文本就绪：${usedNames.join('、')}（合计 ${fullText.length} 字符）`)
  // —— 2. 三级正则：用户 > AI > 默认链 ——
  const userRaw = typeof ctx.input['chapter_regex'] === 'string' ? (ctx.input['chapter_regex'] as string) : ''
  const userPick = extractRegexCandidate(userRaw)
  const aiIds = ctx.assetIdsOf('ai_regex')
  let aiPick: string | null = null
  if (aiIds.length > 0) {
    aiPick = extractRegexCandidate(await ctx.readText(aiIds[0]!))
  }
  let regex: RegExp | null = null
  let regexSource: 'user' | 'ai' | 'default' = 'default'
  if (userPick) {
    regexSource = 'user'
    regex = compileChapterRegex(userPick, maxRegexChars)
  } else if (aiPick) {
    regexSource = 'ai'
    regex = compileChapterRegex(aiPick, maxRegexChars)
  }
  ctx.log(`章节正则来源：${regexSource === 'default' ? '默认正则链' : regexSource === 'user' ? '用户自定义' : 'AI 生成'}`)

  // —— 3. 切分（per_source：逐源独立切 + index 跨书续编；默认：拼接全文单切，逐字现行为） ——
  let all: ChapterSlice[] = []
  let skippedHeadChars = 0
  const books: Array<{ name: string; count: number }> = []
  if (perSource) {
    let offset = 0
    for (let i = 0; i < textParts.length; i++) {
      const r = splitChapters(textParts[i]!, regex)
      for (const ch of r.chapters) {
        ch.index = ++offset
        ch.source_book = usedNames[i]!
      }
      books.push({ name: usedNames[i]!, count: r.chapters.length })
      all.push(...r.chapters)
      skippedHeadChars += r.skippedHeadChars
    }
    ctx.log(`逐源切分（per_source）：${books.map((b) => `${b.name}=${b.count}章`).join('，')}，合计 ${all.length} 章`)
  } else {
    const r = splitChapters(fullText, regex)
    all = r.chapters
    skippedHeadChars = r.skippedHeadChars
  }
  if (skippedHeadChars > 0) ctx.log(`首个章头前 ${skippedHeadChars} 字符未纳入章节（前言/标题区）`)

  // —— 4. 范围过滤 + 下限校验 ——
  const rangeRaw = typeof ctx.input['chapter_range'] === 'string' ? (ctx.input['chapter_range'] as string).trim() : ''
  let selected = all
  if (rangeRaw) {
    const nums = parseChapterRange(rangeRaw)
    if (!nums) throw new Error(`章节范围格式非法：「${rangeRaw}」（示例 1-30 / 1,3,5-9）`)
    const set = new Set(nums)
    selected = all.filter((c) => set.has(c.index))
    ctx.log(`章节范围 ${rangeRaw}：保留 ${selected.length}/${all.length} 章`)
  }
  if (selected.length < minChapters) {
    throw new Error(
      `切分后章节数 ${selected.length} 少于 min_chapters=${minChapters}（已识别 ${all.length} 章）：` +
        '可调整章节范围 / 检查章节正则（chapter_regex）/ 开启 with_ai_split 由 AI 生成正则 / 调小 min_chapters',
    )
  }

  // —— 5. 落库：逐章资产 + manifest（manifest 第一 = batch field 读入口） ——
  const written: Array<{ ch: ChapterSlice; assetId: number; assetName: string }> = []
  for (const ch of selected) {
    const base = ch.title
      ? `第${String(ch.index).padStart(3, '0')}章-${ch.title}`
      : `第${String(ch.index).padStart(3, '0')}章`
    const asset = await writeTextAsset(ctx.run.projectId, {
      name: `${base}.md`,
      content: ch.content,
      purpose: outputPurpose,
      stepId: ctx.step.id,
      runId: ctx.run.id,
      tags: ['chapter'],
      params: perSource
        ? { index: ch.index, reel: ch.reel, chars: ch.content.length, source_book: ch.source_book }
        : { index: ch.index, reel: ch.reel, chars: ch.content.length },
    })
    written.push({ ch, assetId: asset.id, assetName: asset.name })
  }
  const regexUsed = regex ? regex.source : DEFAULT_CHAPTER_REGEX.source
  const manifestDoc = {
    source: { asset_ids: usedIds, names: usedNames, chars: fullText.length },
    regex_source: regexSource,
    regex_used: regexUsed,
    total: all.length,
    selected: selected.length,
    range: rangeRaw || null,
    skipped_head_chars: skippedHeadChars,
    reels: [...new Set(all.map((c) => c.reel).filter((r): r is string => !!r))],
    // [M25·G6] 仅 per_source 附加（默认路径 manifest 逐字不变）；下游逐章继承，图谱归并即「合并改编」
    ...(perSource ? { per_source: true, books } : {}),
    chapters: written.map(({ ch, assetId, assetName }) => ({
      index: ch.index,
      reel: ch.reel,
      title: ch.title,
      name: assetName,
      asset_id: assetId,
      chars: ch.content.length,
      ...(perSource ? { source_book: ch.source_book } : {}),
    })),
  }
  const manifestAsset = await writeTextAsset(ctx.run.projectId, {
    name: '章节索引.json',
    content: JSON.stringify(manifestDoc, null, 2),
    purpose: outputPurpose,
    format: 'chapter-manifest-json',
    stepId: ctx.step.id,
    runId: ctx.run.id,
    tags: ['chapter_manifest'],
    params: { total: all.length, selected: selected.length, regex_source: regexSource },
  })
  ctx.log(`章节切分完成：${selected.length} 章（manifest asset#${manifestAsset.id}）`)
  return { assetIds: [manifestAsset.id, ...written.map((w) => w.assetId)] }
}

/** 正则候选提取：剥围栏 → 取首个非空行 → `/pattern/flags` 形态取本体（运行时统一 gm 编译） */
function extractRegexCandidate(raw: string): string | null {
  const stripped = raw.replace(/```[a-z]*/gi, '').trim()
  const first = stripped
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!first) return null
  const slashM = /^\/(.+)\/[a-z]*$/.exec(first)
  return slashM ? slashM[1]! : first
}

/** 编译章节正则：长度上限（ReDoS 缓解）+ 统一 gm 标志 + 失败指引 */
function compileChapterRegex(pattern: string, maxChars: number): RegExp {
  if (pattern.length > maxChars) {
    throw new Error(`章节正则过长（${pattern.length} > ${maxChars} 字符），请简化正则（防 ReDoS）`)
  }
  try {
    return new RegExp(pattern, 'gm')
  } catch (err) {
    throw new Error(
      `章节正则编译失败：${(err as Error).message}（示例：第\\s*(\\d+)\\s*章\\s*([^\\n\\r]*)）`,
    )
  }
}
