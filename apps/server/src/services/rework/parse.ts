/**
 * 精确返修 · 显式字幕自然语言解析（precision-rework 规格 §3.1/§4/§7；P12）。
 *
 * 定位：把「字幕指令」入口的一句自然语言，转换成与其它入口逐字同构的结构化 SubtitleChange[]，
 * 再交由唯一预览编译器 buildSubtitlePreview 产出可确认预览——解析本身不执行任何修改、不重置任务。
 *
 * 红线（对齐既有 planRework 范式，但按字幕语义更严）：
 * - 只处理显式字幕模式：不猜「改一句话」是改声音还是字幕；混合/歧义诉求一律 unclear 整单不执行。
 * - parse-once 领用：每个 requestKey 先落 state='parsing' 台账再调模型；超时/结果未知标 'uncertain'
 *   且**绝不自动重发**；同键重放回放既有解析，不重复计费。
 * - 成本透明：沿用已配置 LLM + 预算 + 用量记账；未知价格须先确认（accept_unpriced），不计为 0。
 * - 零媒体计费：仅一次文本模型调用；网络在探针层被桩化。
 */
import { z } from 'zod'
import { chatCompleteDetailed, type ChatMessage } from '../llm'
import { recordUsage, resolveUnitPrice } from '../usage'
import { checkBudget } from '../budget'
import { requiredEndpoint } from '../creation-chat/preflight'
import { hashJson } from '../creation-chat/contract'
import type { SubtitleChange } from './contract'
import { assessSubtitleCapability } from './baseline'
import { buildSubtitlePreview, type SubtitlePreview } from './preview'
import { upsertReworkRequest, advanceReworkRequestState } from './ledger'
import type { ReworkRequest } from '../../db/schema'
import type { ReworkError, SubtitleCue } from './subtitle-text'

const MAX_INSTRUCTION = 2000
const round = (n: number): number => Math.round(n * 1e6) / 1e6
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
/** 派生预览键：与解析行分开登记（解析领用一条 + 预览回执一条），同解析必得同预览键（幂等回放） */
const previewKey = (requestKey: string): string => `${requestKey}#pvp`

/** 模型回复顶层宽容（多余键忽略、单字段坏不致整次已付费解析作废），逐条在 sanitize 映射后再进契约 */
const replySchema = z.object({ changes: z.unknown().optional(), unclear: z.unknown().optional() }).catchall(z.unknown())

export interface ParseEstimate {
  /** 已知解析费（元）；无单价时为 0 并进 unpriced 清单，绝不按 0 冒充免费 */
  knownCost: number
  /** 价格未知的计价项（须用户显式接受后才调模型） */
  unpriced: string[]
  /** 输入/输出 token 单价是否均已配置 */
  priced: boolean
  /** 本次实际模型调用次数（回放/未计价拦断时为 0） */
  modelCalls: number
}

export type ParseResult =
  | { outcome: 'unpriced'; message: string; estimate: ParseEstimate }
  | { outcome: 'conflict'; parseRequestId: string; message: string }
  | { outcome: 'uncertain'; parseRequestId: string | null; message: string; unclear: string | null; estimate: ParseEstimate }
  | { outcome: 'blocked'; parseRequestId: string | null; code: string; message: string; errors?: ReworkError[] }
  | { outcome: 'ready' | 'replayed'; parseRequestId: string; requestId: string; preview: SubtitlePreview; changes: SubtitleChange[]; estimate: ParseEstimate }

const UNKNOWN_TARGET = '没能从这条指令解析出明确的字幕修改。请说清楚要改第几句、改成什么（新文字 / 起止时间 / 整体提前或延后多少毫秒）；如果你其实想改的是配音、台词文本或画面，本入口不做，请走对应入口。'

/** 解析器提示词（cue 表 = 当前有效基准，模型只见 ordinal 不见内部 cueId） */
function parseMessages(cues: SubtitleCue[], instruction: string): ChatMessage[] {
  const table = cues.map((c, i) => ({ cue_index: i + 1, text: c.text, start_ms: c.startMs, end_ms: c.endMs }))
  return [
    {
      role: 'system',
      content: [
        '你是成片「显示字幕」精确返修指令解析器：把用户一句话翻译成对现有字幕的结构化修改。',
        '只输出严格 JSON（无解释、无 Markdown 代码块）：{"changes":[...],"unclear":null}',
        'changes 每一项只能是下列三种之一（cue_index 从 1 开始，指代下方字幕表第几条）：',
        '  改文字：{"cue_index":1,"text":"新的完整字幕文字"}',
        '  改起止：{"cue_index":2,"start_ms":3000,"end_ms":5000}（整数毫秒，起点<终点）',
        '  整体平移：{"cue_indexes":[1,3],"shift_ms":200}（选中若干条同时前移/后移，正数延后、负数提前，整数毫秒）',
        '规则：',
        '1) 只改显示字幕（文字与时间轴），不改配音、不改台词文本本身、不改画面、不增删字幕条数、不调换顺序。',
        '2) 改文字时 text 必须是完整新字幕（整体替换原句），不要写「同上」「再短一点」这类依赖上下文的表述。',
        '3) 一条字幕在一次请求里只能命中一种操作一次；同条既改文字又改时间做不到 → 写进 unclear。',
        '4) 指令含糊、无法唯一定位到第几句、或同时夹带了「改字幕以外」的诉求（配音/台词/画面/音乐）时：changes 给空数组，unclear 用中文说明本入口做不到或还需要什么信息。绝不猜。',
        '5) unclear 为字符串或 null（能完整解析时为 null）。cue_index 不得超过现有字幕条数。',
        `当前成片显示字幕共 ${cues.length} 条：`,
        JSON.stringify(table),
      ].join('\n'),
    },
    { role: 'user', content: `字幕返修指令：${instruction}` },
  ]
}

/** 模型回复归一：映射 cue_index→cueId（越界/看不懂一律 unclear，不猜）；unclear 有值即整单不执行 */
function sanitizeReply(raw: { changes?: unknown; unclear?: unknown }, cues: SubtitleCue[]): { changes: SubtitleChange[] | null; unclear: string | null } {
  const said = typeof raw.unclear === 'string' && raw.unclear.trim() ? raw.unclear.trim().slice(0, 1200) : null
  if (said) return { changes: null, unclear: said }
  const list = Array.isArray(raw.changes) ? raw.changes : []
  if (!list.length) return { changes: null, unclear: UNKNOWN_TARGET }
  const idOf = (n: number): string | null => (Number.isInteger(n) && n >= 1 && n <= cues.length ? cues[n - 1]!.id : null)
  const changes: SubtitleChange[] = []
  for (const item of list) {
    const o = asRecord(item)
    if (typeof o.cue_index === 'number' && typeof o.text === 'string') {
      const id = idOf(o.cue_index)
      if (!id) return { changes: null, unclear: `指令里第 ${o.cue_index} 句字幕不存在（当前共 ${cues.length} 句），无法确定你指的是哪一句，请说明。` }
      changes.push({ kind: 'subtitle-text', cueId: id, text: o.text })
    } else if (typeof o.cue_index === 'number' && typeof o.start_ms === 'number' && typeof o.end_ms === 'number') {
      const id = idOf(o.cue_index)
      if (!id) return { changes: null, unclear: `指令里第 ${o.cue_index} 句字幕不存在（当前共 ${cues.length} 句），无法确定你指的是哪一句，请说明。` }
      changes.push({ kind: 'subtitle-time', cueId: id, startMs: o.start_ms, endMs: o.end_ms })
    } else if (Array.isArray(o.cue_indexes) && typeof o.shift_ms === 'number') {
      const ids: string[] = []
      for (const n of o.cue_indexes) {
        const id = typeof n === 'number' ? idOf(n) : null
        if (!id) return { changes: null, unclear: `平移指令里第 ${String(n)} 句字幕不存在（当前共 ${cues.length} 句），无法确定你指的是哪一句，请说明。` }
        ids.push(id)
      }
      changes.push({ kind: 'subtitle-shift', cueIds: ids, deltaMs: o.shift_ms })
    } else {
      return { changes: null, unclear: '解析结果里有一条字幕修改看不懂要做什么（需要「第几句改成什么文字」「第几句起止时间」或「若干句整体平移多少毫秒」之一），请说得更具体些。' }
    }
  }
  return { changes, unclear: null }
}

const RESEND_WARN = '字幕解析请求超时或结果未知，系统不会自动重发；如仍需解析，请另发一条新的解析请求（注意可能再次产生一次解析费用）。'

/**
 * 显式字幕自然语言解析（唯一入口，前端不重算）。
 * 步骤：能力/基准 → 端点与单价 → 未计价须确认 → 预算 → parse-once 领用 → 模型 → 归一 → 同一预览编译器。
 */
export async function parseSubtitleInstruction(p: {
  runId: number
  stepKey?: string
  requestKey: string
  instruction: string
  sessionId?: number | null
  acceptUnpriced?: boolean
}): Promise<ParseResult> {
  const stepKey = p.stepKey ?? 'compose'
  const instruction = typeof p.instruction === 'string' ? p.instruction.trim() : ''
  if (instruction.length < 2 || instruction.length > MAX_INSTRUCTION) {
    return { outcome: 'blocked', parseRequestId: null, code: 'bad_instruction', message: `字幕指令需为 2-${MAX_INSTRUCTION} 字符，请重新表述` }
  }
  if (typeof p.requestKey !== 'string' || p.requestKey.length === 0 || p.requestKey.length > 100) {
    return { outcome: 'blocked', parseRequestId: null, code: 'bad_request_key', message: 'request_key 需为 1-100 字符的字符串（幂等键）' }
  }

  const { capability, baseline } = await assessSubtitleCapability(p.runId, stepKey)
  if (!baseline) return { outcome: 'blocked', parseRequestId: null, code: capability.code, message: `该成片暂不支持字幕解析返修：${capability.message}` }

  const ep = await requiredEndpoint('llm')
  const messages = parseMessages(baseline.cues, instruction)
  const prices = await Promise.all((['tokens_in', 'tokens_out'] as const).map((unit) => resolveUnitPrice({
    configId: ep.configId, provider: ep.providerKey, model: ep.model, kind: 'llm', unit,
  })))
  const priced = prices[0] !== null && prices[1] !== null
  const unpriced: string[] = []
  if (prices[0] === null) unpriced.push(`${ep.providerKey} / ${ep.model}（解析输入 tokens）`)
  if (prices[1] === null) unpriced.push(`${ep.providerKey} / ${ep.model}（解析输出 tokens）`)
  const gateEstimate: ParseEstimate = { knownCost: 0, unpriced, priced, modelCalls: 0 }

  // 未知价格须先确认（不计为 0、不静默调模型）：确认前零模型调用、零台账领用
  if (!priced && !p.acceptUnpriced) {
    return { outcome: 'unpriced', message: '解析模型单价未配置，确认接受未知解析费后才会调用模型解析。', estimate: gateEstimate }
  }
  // 预算预检：按消息规模与输出上限保守估算（未计价项按 0，与 planRework 同口径）
  const budget = await checkBudget({ projectId: baseline.projectId, estimatedCost: round(Buffer.byteLength(JSON.stringify(messages)) * (prices[0] ?? 0) + 2400 * (prices[1] ?? 0)) })
  if (budget) return { outcome: 'blocked', parseRequestId: null, code: budget.code, message: budget.message }

  // parse-once 领用：先落 parsing，杜绝同键重复调模型；异指令同键冲突
  const instrFp = hashJson({ instruction, stepKey, f: baseline.fingerprint })
  const reg = await upsertReworkRequest({
    projectId: baseline.projectId,
    runId: p.runId,
    stepKey,
    sessionId: p.sessionId ?? null,
    requestKey: p.requestKey,
    requestHash: instrFp,
    baseFingerprint: baseline.fingerprint,
    state: 'parsing',
  })
  if (reg.outcome === 'conflict') {
    return { outcome: 'conflict', parseRequestId: reg.row.id, message: '同一解析键不能用于不同字幕指令，请换新解析键' }
  }
  if (reg.outcome === 'replayed') return await replayParsed(reg.row, p, stepKey)

  // created：唯一一次模型调用
  let result
  try {
    result = await chatCompleteDetailed(messages, { ...ep, baseUrl: ep.baseUrl.replace(/\/+$/, ''), model: ep.model! }, { maxTokens: 24000, temperature: 0.2, allowEmptyContent: true, timeoutMs: 600_000 })
  } catch {
    const est: ParseEstimate = { knownCost: 0, unpriced, priced, modelCalls: 1 }
    await advanceReworkRequestState(reg.row.id, 'uncertain', { result: { message: RESEND_WARN, unclear: null, estimate: est } })
    return { outcome: 'uncertain', parseRequestId: reg.row.id, message: RESEND_WARN, unclear: null, estimate: est }
  }

  // 用量落库（每次解析两条：tokens_in/out），并折算本次实际解析费
  for (const [index, unit] of (['tokens_in', 'tokens_out'] as const).entries()) await recordUsage({
    projectId: baseline.projectId, runId: p.runId, kind: 'llm', provider: ep.providerKey, model: ep.model,
    quantity: result.usage ? (index === 0 ? result.usage.promptTokens : result.usage.completionTokens) : 0,
    unit, unitPrice: result.usage ? prices[index] : null,
    meta: { requestKey: p.requestKey, purpose: 'subtitle_parse' },
  })
  const usage = result.usage
  const realizedCost = priced && usage ? round(usage.promptTokens * (prices[0] as number) + usage.completionTokens * (prices[1] as number)) : 0
  const estimate: ParseEstimate = { knownCost: realizedCost, unpriced, priced, modelCalls: 1 }

  if (ep.apiKey && result.content.includes(ep.apiKey)) {
    await advanceReworkRequestState(reg.row.id, 'blocked', { result: { code: 'unsafe_output', message: '模型输出包含敏感信息，已拒绝' } })
    return { outcome: 'blocked', parseRequestId: reg.row.id, code: 'unsafe_output', message: '模型输出包含敏感信息，已拒绝保存' }
  }
  if (result.finishReason === 'length') {
    await advanceReworkRequestState(reg.row.id, 'uncertain', { result: { message: '字幕解析结果被截断，请缩短指令后另发新解析请求', unclear: null, estimate } })
    return { outcome: 'uncertain', parseRequestId: reg.row.id, message: '字幕解析结果被截断，请缩短指令后另发新解析请求', unclear: null, estimate }
  }
  const stripped = result.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  let reply: unknown
  try { reply = JSON.parse(stripped) as unknown } catch {
    await advanceReworkRequestState(reg.row.id, 'uncertain', { result: { message: '字幕解析结果不符合契约，请换一种说法另发新解析请求', unclear: null, estimate } })
    return { outcome: 'uncertain', parseRequestId: reg.row.id, message: '字幕解析结果不符合契约，请换一种说法另发新解析请求', unclear: null, estimate }
  }
  const parsed = replySchema.safeParse(reply)
  if (!parsed.success) {
    await advanceReworkRequestState(reg.row.id, 'uncertain', { result: { message: '字幕解析结果不符合契约，请换一种说法另发新解析请求', unclear: null, estimate } })
    return { outcome: 'uncertain', parseRequestId: reg.row.id, message: '字幕解析结果不符合契约，请换一种说法另发新解析请求', unclear: null, estimate }
  }
  const mapped = sanitizeReply(parsed.data, baseline.cues)
  if (mapped.unclear || !mapped.changes) {
    const unclear = mapped.unclear ?? UNKNOWN_TARGET
    await advanceReworkRequestState(reg.row.id, 'uncertain', { result: { unclear, message: unclear, estimate } })
    return { outcome: 'uncertain', parseRequestId: reg.row.id, message: unclear, unclear, estimate }
  }
  return await finalizeReady(p, stepKey, reg.row.id, mapped.changes, estimate)
}

/** 转同一预览编译器并落 ready 回执（解析行记 changes + 预览 requestId，回放可复原） */
async function finalizeReady(
  p: { runId: number; requestKey: string; sessionId?: number | null },
  stepKey: string,
  parseRequestId: string,
  changes: SubtitleChange[],
  estimate: ParseEstimate,
): Promise<ParseResult> {
  const pv = await buildSubtitlePreview({ runId: p.runId, stepKey, requestKey: previewKey(p.requestKey), sessionId: p.sessionId ?? null, changes })
  if (pv.outcome === 'blocked') {
    await advanceReworkRequestState(parseRequestId, 'blocked', { result: { code: pv.code, message: pv.message, errors: pv.errors ?? null } })
    return { outcome: 'blocked', parseRequestId, code: pv.code, message: pv.message, errors: pv.errors }
  }
  if (pv.outcome === 'conflict') {
    await advanceReworkRequestState(parseRequestId, 'uncertain', { result: { message: pv.message, unclear: null, estimate } })
    return { outcome: 'conflict', parseRequestId, message: pv.message }
  }
  await advanceReworkRequestState(parseRequestId, 'ready', { changes, result: { previewRequestId: pv.requestId, estimate } })
  return { outcome: pv.outcome, parseRequestId, requestId: pv.requestId, preview: pv.preview, changes, estimate }
}

/** 同键回放：绝不再调模型；按解析行既有状态复原预览/待澄清/拦断原因（超时/parsing 未定 → 不重发） */
async function replayParsed(row: ReworkRequest, p: { runId: number; requestKey: string; sessionId?: number | null }, stepKey: string): Promise<ParseResult> {
  const stored = safeObj(row.resultJson)
  const estimate = (stored.estimate as ParseEstimate | undefined) ?? { knownCost: 0, unpriced: [], priced: true, modelCalls: 0 }
  if (row.state === 'ready') {
    const changes = safeArr(row.changesJson) as SubtitleChange[]
    const pv = await buildSubtitlePreview({ runId: p.runId, stepKey, requestKey: previewKey(p.requestKey), sessionId: p.sessionId ?? null, changes })
    if (pv.outcome === 'blocked') return { outcome: 'blocked', parseRequestId: row.id, code: pv.code, message: pv.message, errors: pv.errors }
    if (pv.outcome === 'conflict') return { outcome: 'conflict', parseRequestId: row.id, message: pv.message }
    return { outcome: pv.outcome, parseRequestId: row.id, requestId: pv.requestId, preview: pv.preview, changes, estimate: { ...estimate, modelCalls: 0 } }
  }
  if (row.state === 'blocked') {
    return { outcome: 'blocked', parseRequestId: row.id, code: typeof stored.code === 'string' ? stored.code : 'blocked', message: typeof stored.message === 'string' ? stored.message : '解析已被拦断', errors: Array.isArray(stored.errors) ? (stored.errors as ReworkError[]) : undefined }
  }
  // parsing（领用后进程中断、结果未知）与 uncertain 均不自动重发
  const message = row.state === 'parsing' ? RESEND_WARN : (typeof stored.message === 'string' ? stored.message : '上次字幕解析未能确定，请另发新解析请求')
  const unclear = typeof stored.unclear === 'string' ? stored.unclear : null
  return { outcome: 'uncertain', parseRequestId: row.id, message, unclear, estimate: { ...estimate, modelCalls: 0 } }
}

function safeObj(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  } catch { return {} }
}
function safeArr(text: string): unknown[] {
  try {
    const v = JSON.parse(text) as unknown
    return Array.isArray(v) ? v : []
  } catch { return [] }
}
