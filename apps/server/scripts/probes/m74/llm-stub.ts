/**
 * 角色一致性探针 — 评分链 fetch 桩。
 *
 * 形态与既有 OpenAI 兼容桩一致：可变的 reply 决策函数 + 包壳的 llmReply + 用完还原原始 fetch。
 * 桩替掉的是**协议层出口**（评分链最终会走一次 globalThis.fetch），因此被评图/参考图的读盘、
 * 提示词组装、用量记录、结果落库全部是真实链路，只有最后一次 HTTP 是回放的。
 *
 * 不外发证明的取证面：
 *   - 每次调用都记 url，allowlist 之外的地址数恒为 0（见 outboundViolations）；
 *   - 桩生效前环境是「一旦调用即抛错」的禁运 fetch，其被触发次数单独计数（见 bootstrap）。
 */

/** 桩服务地址：环回 + 丢弃端口（九号端口按协议不转发任何服务），即使桩失效也打不到任何供应商。 */
export const STUB_BASE_URL = 'http://127.0.0.1:9/acs-m74-stub'

/** 回放形态：合法分数 / 坏输出 / 合法但零有效分 / 供应商错误（错误文案夹带凭据，验清洗）。 */
export type StubReplyKind = 'score' | 'garbage' | 'empty' | 'provider500'

interface StubCall {
  url: string
  body: string
  /** 本次请求体里回读到的被评图 id 集合（即服务实际送进评分链的抽样集） */
  assetIds: number[]
  /** 本次回放的评分 JSON 里第一张图的三维取值（非评分形态为空） */
  dims: Record<ScoreDim, number> | null
}

const calls: StubCall[] = []
let scoreValue = 8
let replyKind: StubReplyKind = 'score'

/** 供应商 500 文案里故意放的三类凭据形态（落库前后都必须被抹掉）。 */
export const LEAK_URL = 'https://provider-host.example/v1/chat/completions'
export const LEAK_KEY = 'sk-ABCDEFGHIJKLMNOPQRSTUV'
export const LEAK_TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** 被评图 id 集合从请求体里回读（评分契约把集合写在收尾指令文本中）。 */
const ID_SET = /asset_id 集合：\[([\d,\s]+)\]/

function idsFrom(raw: string): number[] {
  return (ID_SET.exec(raw)?.[1] ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
}

/**
 * 回放分数的三个维度：各给一个互不相同的值。
 * 产品只采纳「一致性」那一路，另两维故意错开一档、两档——三维同值的回放会让「读错维度」
 * 也撞出正确分数，断言就失去意义。
 */
const DIM_STEPS = { consistency: 0, style: 1, quality: 2 } as const
export type ScoreDim = keyof typeof DIM_STEPS

/** 某一维度的回放值（与真实评分同界，钳在 0–10）。 */
export function dimReplyValue(base: number, dim: ScoreDim): number {
  return Math.min(10, Math.max(0, base + DIM_STEPS[dim]))
}

/** OpenAI 兼容包壳（内容字段承载评分 JSON）。 */
export function llmReply(content: string): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    },
  }
}

/** 设置回放分数（合法评分 JSON：一致性维取该值，其余两维各错开一档）。 */
export function replyScore(value: number): void {
  replyKind = 'score'
  scoreValue = value
}

/** 设置回放形态（不可解析文本 / 零有效分 / 供应商错误）。 */
export function replyAs(kind: Exclude<StubReplyKind, 'score'>): void {
  replyKind = kind
}

function buildReply(ids: number[]): { status: number; body: unknown; dims: Record<ScoreDim, number> | null } {
  if (replyKind === 'provider500') {
    return {
      status: 500,
      body: { error: { message: `密钥 ${LEAK_KEY} 请求 ${LEAK_URL} 签名 ${LEAK_TOKEN} 被拒` } },
      dims: null,
    }
  }
  const dims: Record<ScoreDim, number> = {
    consistency: dimReplyValue(scoreValue, 'consistency'),
    style: dimReplyValue(scoreValue, 'style'),
    quality: dimReplyValue(scoreValue, 'quality'),
  }
  const content =
    replyKind === 'score'
      ? JSON.stringify({
          scores: ids.map((asset_id) => ({
            asset_id,
            consistency: dims.consistency,
            style: dims.style,
            quality: dims.quality,
            note: 'stub',
          })),
        })
      : replyKind === 'empty'
        ? JSON.stringify({ scores: [] })
        : '这不是评分 JSON，人类读得懂但机器解析不了'
  return { ...llmReply(content), dims: replyKind === 'score' ? dims : null }
}

let installed = false
let originalFetch: typeof fetch | undefined

/** 装上桩 fetch（幂等：重复调用只刷新决策，不叠加包装）。 */
export function installStubFetch(): void {
  if (!installed) {
    originalFetch = globalThis.fetch
    installed = true
  }
  const stub = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input)
    const raw = typeof init?.body === 'string' ? init.body : ''
    const ids = idsFrom(raw)
    const r = buildReply(ids)
    calls.push({ url, body: raw, assetIds: ids, dims: r.dims })
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  globalThis.fetch = stub
}

/** 还原真实 fetch 引用（探针环境下即还原回「禁运」拦截器）。 */
export function restoreFetch(): void {
  if (installed && originalFetch) globalThis.fetch = originalFetch
  installed = false
}

/** 桩累计被调用次数（用于「只读端点零外发」「空出镜集合零评分调用」这类计数断言）。 */
export function stubCallCount(): number {
  return calls.length
}

/** 落在允许地址之外的请求（恒应为空——这是「桩未外发」的直接证据）。 */
export function outboundViolations(): string[] {
  return calls.filter((c) => !c.url.startsWith(STUB_BASE_URL)).map((c) => c.url)
}

/** 全部被记录的目标地址（去重，供报告取证列出真实外发白名单）。 */
export function outboundTargets(): string[] {
  return [...new Set(calls.map((c) => c.url))]
}

/**
 * 每次评分请求实际带上的被评图 id 集合（按调用顺序）。
 * 取证面是「送进模型的样本」，不是服务自己报的计数——抽样方向写反只有在这里才看得见。
 */
export function callAssetIdSets(): number[][] {
  return calls.map((c) => c.assetIds)
}

/**
 * 最近一次真实回放给评分链的三维取值（从桩记下的响应载荷里读，不是断言侧另算一份）。
 * 配合「入库分恰好等于一致性维」的断言使用：产品若改读别的维度或自算综合分，立刻撞红。
 */
export function lastSentScoreDims(): Record<ScoreDim, number> | null {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const dims = calls[i]!.dims
    if (dims) return dims
  }
  return null
}
