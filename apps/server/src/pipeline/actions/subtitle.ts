import { writeFileSync } from 'node:fs'
import { probeMediaDuration } from '../../services/ffmpeg'
import { loadPromptTemplate, chatCompleteDetailed, resolveLlmEndpoint } from '../../services/llm'
import { absPathOf, ensureProjectDirs, registerAsset, relPathOf } from '../../services/storage'
import { recordLlmUsage } from '../../services/usage'
import type { StepContext } from '../context'
import type { StepResult } from '../types'

export interface TimingLine {
  id: string
  text: string
  start_ms: number
  end_ms: number
}

/**
 * subtitle：对白/口播切句定时 → SRT 字幕资产（spec §5.3/§7.1）。
 * 双模式：
 *  - measured：提供 voices 输入（tts 配音资产序列，句序与台词一致）→ ffprobe 逐句实测时长，
 *    splitDisplayLines 切显示行 + planMeasuredSrt 比例分配 → 字幕与音频帧级对齐；
 *  - estimated：无 voices（或 params.mode=estimated）→ LLM 按 params.prompt_tpl 切句估时。
 * 输入（二选一，同时提供以 script 优先）：
 *  - script: 对白全文资产（口播文案 md/剧本）
 *  - lines:  台词 JSON 资产（{lines:[{id,text,est_ms?}]}，est_ms 作 LLM/回退参考时长）
 * 产物：text 资产（purpose=subtitle，mime text/plain，ext srt），params.mode 记录对齐路径。
 * 模板作者可在此步挂 gate 人工核对字幕。
 */
export async function subtitle(ctx: StepContext): Promise<StepResult> {
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const tplFile = typeof params['prompt_tpl'] === 'string' && params['prompt_tpl'] ? params['prompt_tpl'] : 'lines-timing.md'
  const source = await collectSource(ctx)
  ctx.log(`字幕切句输入：${source.lines.length} 句台词（${source.text.length} 字符）`)

  // mode 判定（spec §7.1）：提供 voices → measured 实测对齐；params.mode 可强制 estimated
  const voiceIds = ctx.assetIdsOf('voices')
  const modeParam = typeof params['mode'] === 'string' ? params['mode'] : undefined
  let mode: 'measured' | 'estimated' = voiceIds.length > 0 ? 'measured' : 'estimated'
  if (modeParam === 'estimated') mode = 'estimated'
  if (modeParam === 'measured' && voiceIds.length === 0) {
    mode = 'estimated'
    ctx.log('mode=measured 但未提供 voices 输入，已回退 estimated（LLM 估时）')
  }

  let timed: TimingLine[]
  let assetParams: Record<string, unknown>
  let promptSnapshot: string
  if (mode === 'measured') {
    if (voiceIds.length !== source.lines.length) {
      throw new Error(`measured 字幕：voices 数量(${voiceIds.length}) 与台词句数(${source.lines.length}) 不一致（防错位）`)
    }
    const voices = await ctx.assetsOf(voiceIds)
    const durationsMs: number[] = []
    let fallbackCount = 0
    for (let i = 0; i < voices.length; i++) {
      const a = voices[i]!
      const line = source.lines[i]!
      const sec = a.relPath ? probeMediaDuration(absPathOf(a.relPath)) : null
      const dMs = sec !== null ? Math.round(sec * 1000) : (line.estMs ?? line.text.length * 180)
      if (sec === null) {
        fallbackCount += 1
        ctx.log(`句 ${line.id} 音频实测失败，回退估时 ${dMs}ms`)
      }
      durationsMs.push(dMs)
    }
    timed = planMeasuredSrt(source.lines, durationsMs)
    const sumD = durationsMs.reduce((s, x) => s + x, 0)
    const lastEnd = timed[timed.length - 1]!.end_ms
    if (sumD > 0 && Math.abs(lastEnd - sumD) / sumD > 0.02) {
      ctx.log(`警告：字幕末行结束 ${lastEnd}ms 与实测累加 ${sumD}ms 偏差超 2%（防错位防线）`)
    }
    ctx.log(`字幕 measured：${voiceIds.length} 句实测累加 ${sumD}ms${fallbackCount ? `（${fallbackCount} 句回退估时）` : ''}`)
    assetParams = { mode, lines: timed.length, durationMs: lastEnd, sentenceCount: source.lines.length, voiceCount: voiceIds.length }
    promptSnapshot = `measured 实测对齐：voices=[${voiceIds.join(',')}] durations=[${durationsMs.join(',')}]ms`
  } else {
    ctx.log(`字幕 estimated：LLM 切句估时（提示词 ${tplFile}）`)
    const templateText = loadPromptTemplate(tplFile)
    const userPrompt = `${templateText}\n\n===== 待定时台词 =====\n${source.text}`
    const ep = await resolveLlmEndpoint()
    ctx.log(`调用 LLM 切句定时：${ep.model}…`)
    const llmCfg = (ctx.settings.llm ?? {}) as Record<string, unknown>
    const res = await chatCompleteDetailed(
      [
        { role: 'system', content: '你是字幕时间轴标注引擎，只输出任务要求的最小 JSON 本体，不输出任何解释性文字或 markdown 围栏。' },
        { role: 'user', content: userPrompt },
      ],
      ep,
      {
        temperature: 0.2,
        maxTokens: typeof llmCfg['max_tokens'] === 'number' ? llmCfg['max_tokens'] : 12000,
      },
    )
    // [M4] 用量记录（estimated 分支单次 LLM 调用；measured 分支零调用不记录）
    await recordLlmUsage({ projectId: ctx.run.projectId, runId: ctx.run.id, stepId: ctx.step.id,
      provider: res.provider, model: res.model, usage: res.usage })
    const content = res.content
    timed = parseTimedLines(content)
    if (timed.length !== source.lines.length) {
      ctx.log(`字幕句数与输入台词不一致（${timed.length}/${source.lines.length}），以 LLM 切句结果为准`)
    }
    assetParams = { model: ep.model, lines: timed.length, durationMs: timed.length ? timed[timed.length - 1]!.end_ms : 0, mode: 'estimated' }
    promptSnapshot = userPrompt
  }

  const srt = toSrt(timed)
  assertSrt(srt, timed)

  const fileName = `${Date.now()}-subtitle.srt`
  const relPath = relPathOf(ctx.run.projectId, 'subtitle', fileName)
  ensureProjectDirs(ctx.run.projectId)
  writeFileSync(absPathOf(relPath), srt, 'utf8')
  const asset = await registerAsset(ctx.run.projectId, {
    stepId: ctx.step.id,
    runId: ctx.run.id,
    kind: 'text',
    purpose: 'subtitle',
    relPath,
    name: fileName,
    mime: 'text/plain',
    ext: 'srt',
    fileSize: Buffer.byteLength(srt, 'utf8'),
    prompt: promptSnapshot.slice(0, 4000),
    params: assetParams,
    tags: ['subtitle'],
  })
  ctx.log(`字幕已生成 asset#${asset.id}（${timed.length} 条，末条结束 ${msToClock(timed[timed.length - 1]!.end_ms)}）`)
  return { assetIds: [asset.id] }
}

/** 汇集台词来源：script 全文优先；否则 lines JSON（est_ms 注入提示词作参考） */
async function collectSource(ctx: StepContext): Promise<{ text: string; lines: Array<{ id: string; text: string; estMs?: number }> }> {
  const scriptIds = ctx.assetIdsOf('script')
  if (scriptIds.length > 0) {
    const text = await ctx.readText(scriptIds[0]!).catch(() => '')
    const trimmed = text.trim()
    if (trimmed) {
      return {
        text: trimmed,
        lines: trimmed
          .split(/\r?\n/)
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t, i) => ({ id: String(i + 1), text: t })),
      }
    }
  }
  const lineIds = ctx.assetIdsOf('lines')
  if (lineIds.length === 0) throw new Error('subtitle 需要 inputs.script（对白全文）或 inputs.lines（台词 JSON）')
  const raw = await ctx.readText(lineIds[0]!)
  const obj = JSON.parse(raw) as { lines?: unknown[] } | unknown[]
  const list = Array.isArray(obj) ? obj : ((obj as { lines?: unknown[] }).lines ?? [])
  const items: Array<{ id: string; text: string; estMs?: number }> = []
  for (let i = 0; i < list.length; i++) {
    const rec = list[i] as Record<string, unknown>
    const text = typeof rec['text'] === 'string' ? rec['text'].trim() : ''
    if (!text) continue
    const estMs = typeof rec['est_ms'] === 'number' && Number.isFinite(rec['est_ms']) ? rec['est_ms'] : undefined
    const id = typeof rec['id'] === 'string' ? rec['id'] : String(i + 1)
    items.push({ id, text, estMs })
  }
  const text = items
    .map((it) => `${it.id}${typeof it.estMs === 'number' ? `（参考 ${it.estMs}ms）` : ''}: ${it.text}`)
    .join('\n')
  return { text, lines: items }
}

/** 解析 LLM 产物：剥 markdown 围栏 → JSON lines → 字段校验（id/text/start_ms/end_ms） */
function parseTimedLines(raw: string): TimingLine[] {
  const noFence = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim()
  const start = noFence.indexOf('{')
  if (start < 0) throw new Error(`字幕定时 LLM 返回无 JSON：${raw.slice(0, 120)}`)
  let obj: unknown
  try {
    obj = JSON.parse(noFence.slice(start))
  } catch (err) {
    throw new Error(`字幕定时 JSON 解析失败：${(err as Error).message}（返回开头：${raw.slice(0, 120)}）`)
  }
  const list = Array.isArray(obj) ? (obj as unknown[]) : ((obj as { lines?: unknown[] }).lines ?? [])
  if (!Array.isArray(list) || list.length === 0) throw new Error('字幕定时结果缺 lines 数组')
  const out: TimingLine[] = []
  for (const item of list) {
    const rec = item as Record<string, unknown>
    const text = typeof rec['text'] === 'string' ? rec['text'].trim() : ''
    if (!text) continue
    const startMs = Number(rec['start_ms'])
    const endMs = Number(rec['end_ms'])
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      throw new Error(`字幕行「${text.slice(0, 30)}」缺合法 start_ms/end_ms`)
    }
    if (endMs <= startMs) throw new Error(`字幕行「${text.slice(0, 30)}」时间非法（end<=start）`)
    out.push({ id: String(rec['id'] ?? out.length + 1), text, start_ms: Math.round(startMs), end_ms: Math.round(endMs) })
  }
  // 时间单调自检（允许 LLM 将句末与下句首轻微重叠，超过 500ms 视为乱序）
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.start_ms < out[i - 1]!.end_ms - 500) {
      throw new Error(`字幕时间轴乱序：句 ${out[i]!.id} 起始早于上句结束（SRT 单调性校验失败）`)
    }
  }
  return out
}

/** TimingLine[] → SRT 文本（HH:MM:SS,mmm 格式由本函数保证合法） */
function toSrt(lines: TimingLine[]): string {
  return lines
    .map((l, i) => `${i + 1}\n${msToClock(l.start_ms)} --> ${msToClock(l.end_ms)}\n${l.text}\n`)
    .join('\n')
}

/** SRT 时间戳：h:mm:ss 或 hh:mm:ss,mmm（小时可超 2 位） */
function msToClock(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const milli = ms % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`
}

/** 解析自检：段数 > 0 且时间戳单调不减（spec §5.3 校验） */
function assertSrt(srt: string, timed: TimingLine[]): void {
  if (timed.length === 0) throw new Error('SRT 为空（无字幕段）')
  const blocks = srt.trim().split(/\r?\n\r?\n/)
  if (blocks.length !== timed.length) throw new Error(`SRT 段数异常（${blocks.length}/${timed.length}）`)
  const re = /(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/
  let prevEnd = -1
  for (const b of blocks) {
    const mt = b.match(re)
    if (!mt) throw new Error('SRT 时间戳行格式非法')
    const toMs = (p: string[]): number =>
      Number(p[0]) * 3_600_000 + Number(p[1]) * 60_000 + Number(p[2]) * 1000 + Number(p[3])
    const start = toMs([mt[1]!, mt[2]!, mt[3]!, mt[4]!])
    const end = toMs([mt[5]!, mt[6]!, mt[7]!, mt[8]!])
    if (start < prevEnd) throw new Error('SRT 时间轴非单调')
    if (end <= start) throw new Error('SRT 段时间非法')
    prevEnd = end
  }
}

/** 显示行切分（spec §7.1-3）：先按「。！？；!?;」→ 仍超 maxChars 按「，、,」→ 仍超按 code point 硬切；trim + 去空段 */
export function splitDisplayLines(text: string, maxChars: number): string[] {
  const max = Math.max(1, Math.floor(maxChars))
  const out: string[] = []
  for (const primary of splitKeeping(text, '。！？；!?;')) {
    const seg = primary.trim()
    if (!seg) continue
    if (cpLen(seg) <= max) {
      out.push(seg)
      continue
    }
    for (const secondary of splitKeeping(seg, '，、,')) {
      const sub = secondary.trim()
      if (!sub) continue
      if (cpLen(sub) <= max) {
        out.push(sub)
        continue
      }
      const chars = Array.from(sub)
      for (let i = 0; i < chars.length; i += max) {
        const piece = chars.slice(i, i + max).join('').trim()
        if (piece) out.push(piece)
      }
    }
  }
  return out
}

/** measured 时间轴（spec §7.1-4/5）：行时长按 code point 比例分配句时长（末行=余量）、句内短行合并、句间首尾相接 */
export function planMeasuredSrt(
  lines: Array<{ id: string; text: string }>,
  durationsMs: number[],
  opts?: { maxCharsPerLine?: number; minMs?: number; leadInMs?: number },
): TimingLine[] {
  if (lines.length !== durationsMs.length) {
    throw new Error(`measured 字幕：句数 ${lines.length} 与时长数 ${durationsMs.length} 不一致（防错位）`)
  }
  const maxChars = opts?.maxCharsPerLine ?? 18
  const minMs = opts?.minMs ?? 800
  let cursor = Math.max(0, Math.round(opts?.leadInMs ?? 0))
  const out: TimingLine[] = []
  for (let i = 0; i < lines.length; i++) {
    const d = Math.max(0, Math.round(durationsMs[i]!))
    const segs = splitDisplayLines(lines[i]!.text, maxChars)
    if (segs.length === 0) continue
    const counts = segs.map(cpLen)
    const total = Math.max(1, counts.reduce((s, x) => s + x, 0))
    let rows = segs.map((text, j) => ({
      text,
      dur: j === segs.length - 1 ? 0 : Math.round((d * counts[j]!) / total),
    }))
    rows[rows.length - 1]!.dur = Math.max(0, d - rows.reduce((s, r) => s + r.dur, 0))
    // 短行句内合并：首行并入其后一行，否则并入前一行（文本直接拼接、时长相加）；单行句保持原样
    while (rows.length > 1) {
      const idx = rows.findIndex((r) => r.dur < minMs)
      if (idx < 0) break
      if (idx === 0) {
        rows = [{ text: rows[0]!.text + rows[1]!.text, dur: rows[0]!.dur + rows[1]!.dur }, ...rows.slice(2)]
      } else {
        const merged = { text: rows[idx - 1]!.text + rows[idx]!.text, dur: rows[idx - 1]!.dur + rows[idx]!.dur }
        rows = [...rows.slice(0, idx - 1), merged, ...rows.slice(idx + 1)]
      }
    }
    for (let j = 0; j < rows.length; j++) {
      out.push({ id: `${lines[i]!.id}.${j + 1}`, text: rows[j]!.text, start_ms: cursor, end_ms: cursor + rows[j]!.dur })
      cursor += rows[j]!.dur
    }
  }
  return out
}

/** 逐字符扫描切分：分隔符保留在段尾 */
function splitKeeping(text: string, delimiters: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of text) {
    cur += ch
    if (delimiters.includes(ch)) {
      out.push(cur)
      cur = ''
    }
  }
  if (cur) out.push(cur)
  return out
}

/** code point 计数（代理对算 1） */
function cpLen(s: string): number {
  return Array.from(s).length
}
