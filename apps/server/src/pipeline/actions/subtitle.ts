import { writeFileSync } from 'node:fs'
import { loadPromptTemplate, chatComplete, resolveLlmEndpoint } from '../../services/llm'
import { absPathOf, ensureProjectDirs, registerAsset, relPathOf } from '../../services/storage'
import type { StepContext } from '../context'
import type { StepResult } from '../types'

interface TimingLine {
  id: string
  text: string
  start_ms: number
  end_ms: number
}

/**
 * subtitle：对白/口播切句定时 → SRT 字幕资产（spec §5.3）。
 * 输入（二选一，同时提供以 script 优先）：
 *  - script: 对白全文资产（口播文案 md/剧本）
 *  - lines:  台词 JSON 资产（{lines:[{id,text,est_ms?}]}，est_ms 作 LLM 参考时长）
 * 执行：LLM 按 params.prompt_tpl（外置提示词）切句并给绝对时间戳（start_ms/end_ms），
 * 返回 JSON lines → 本 action 程序化转 SRT（保证时间戳格式 + 单调校验），
 * 产 text 资产（purpose=subtitle，mime text/plain，ext srt）。
 * 模板作者可在此步挂 gate 人工核对字幕。
 */
export async function subtitle(ctx: StepContext): Promise<StepResult> {
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const tplFile = typeof params['prompt_tpl'] === 'string' && params['prompt_tpl'] ? params['prompt_tpl'] : 'lines-timing.md'
  const source = await collectSource(ctx)
  ctx.log(`字幕切句输入：${source.lines.length} 句台词（${source.text.length} 字符），提示词 ${tplFile}`)

  const templateText = loadPromptTemplate(tplFile)
  const userPrompt = `${templateText}\n\n===== 待定时台词 =====\n${source.text}`
  const ep = await resolveLlmEndpoint()
  ctx.log(`调用 LLM 切句定时：${ep.model}…`)
  const llmCfg = (ctx.settings.llm ?? {}) as Record<string, unknown>
  const content = await chatComplete(
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

  const timed = parseTimedLines(content)
  if (timed.length !== source.lines.length) {
    ctx.log(`字幕句数与输入台词不一致（${timed.length}/${source.lines.length}），以 LLM 切句结果为准`)
  }
  const srt = toSrt(timed)
  assertSrt(srt, timed)

  const fileName = `${Date.now()}-subtitle.srt`
  const relPath = relPathOf(ctx.run.projectId, 'subtitle', fileName)
  ensureProjectDirs(ctx.run.projectId)
  writeFileSync(absPathOf(relPath), srt, 'utf8')
  const asset = await registerAsset(ctx.run.projectId, {
    stepId: ctx.step.id,
    kind: 'text',
    purpose: 'subtitle',
    relPath,
    name: fileName,
    mime: 'text/plain',
    ext: 'srt',
    fileSize: Buffer.byteLength(srt, 'utf8'),
    prompt: userPrompt.slice(0, 4000),
    params: { model: ep.model, lines: timed.length, durationMs: timed.length ? timed[timed.length - 1]!.end_ms : 0 },
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
