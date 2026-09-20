/**
 * [M33.1] 供应商「模型目录」在线元数据适配层（Tier A 基建，沿用 M32/M33 单一真源 + fail-closed 范式）。
 *
 * 背景：M33 用人工核实的 7 条 `PRICING_TABLE` 兜价，覆盖面小、仍在「要用户配」。M33.1 把「建实例只填
 * Key + 选模型」落地——选模型时按供应商在线目录接口**自动带出参考定价**，供应商接口给得出价就带、
 * 给不了就交核实表兜底 / 未计价（**绝不按模型名猜价**）。
 *
 * 现实（Step 0 现场实测锁定，非按文档猜）：
 *   - DashScope 原生 `GET /api/v1/models` 返回 `output.models[]`，LLM 价按 `type: input_token/output_token`、
 *     `price_unit: 每百万tokens`（与平台计价口径**完全一致，零换算**）给出，且 `range_name==='Default'??首组`
 *     的标准全价档可精确复现 `PRICING_TABLE`（qwen3.8-max 12/36、plus 2/8、flash 0.8/2.7）。
 *   - OpenAI / DeepSeek / Google 等 OpenAI 兼容口 `GET /models` 只给 `id`（无价格）→ 归一为 id-only。
 *
 * 纪律红线（继承 M32/M33，不降级）：
 *   - **不猜价**：仅归一接口明确返回、且单位与能力类型匹配的价；图/视频/语音价按分辨率·张·万字符分档、
 *     `type` 命名杂乱、多档无法判定用户实际计费档 → 一律不从 live 带（返回 pricing 缺席），交核实表 / 手填。
 *   - **不低估**：LLM 取 `Default`/首组**标准全价**档（非缓存 / 非 Batch / 非折扣）。
 *   - **零漂移**：本层结果**仅用于建实例预填**，绝不注入 `resolveUnitPrice` 事后计价链（probe cost-drift 断言）。
 */
import type { UsageUnit } from '../services/usage'
import type { ModelPricing, PricingServiceType } from './pricing-capabilities'

/** 在线目录归一后的单个模型条目（供前端「选中即生成」带出定价 / 上下文） */
export interface ModelEntry {
  id: string
  /** 展示名（供应商目录提供时带上，前端可选展示） */
  name?: string
  /** 参考定价（仅命中且可归一时给出；否则缺席 → 前端回落核实表 / 手填 / 未计价） */
  pricing?: ModelPricing
  /** 上下文窗口（token，供应商目录提供时带上，供展示；不参与计价） */
  context?: { input?: number; output?: number }
}

/** DashScope 每百万 token 价单位（与平台 tokens 计价口径同源，零换算） */
const DASHSCOPE_TOKEN_UNIT = '每百万tokens'

interface DashScopePriceItem {
  type?: string
  price?: string
  price_unit?: string
  price_name?: string
}
interface DashScopePriceGroup {
  range_name?: string
  prices?: DashScopePriceItem[]
}
interface DashScopeModel {
  model?: string
  name?: string
  provider?: string
  prices?: DashScopePriceGroup[]
  model_info?: { max_input_tokens?: number; max_output_tokens?: number; context_window?: number }
}

/**
 * 从 DashScope 单个模型解析标准全价档参考定价（仅 LLM / 元百万 token）。
 * 取 `range_name==='Default'` 组，否则首组；组内 type=input_token/output_token、单位必须「每百万tokens」，
 * 且价可解析为有限非负数 → tokens_in/tokens_out。缓存 / Batch / 其它 type 一律忽略（非标准全价、不猜）。
 */
function dashscopePricing(model: DashScopeModel): ModelPricing | null {
  const groups = Array.isArray(model.prices) ? model.prices : []
  if (!groups.length) return null
  const group = groups.find((g) => g.range_name === 'Default') ?? groups[0]
  if (!group) return null
  const items = Array.isArray(group.prices) ? group.prices : []
  const prices: Partial<Record<UsageUnit, number>> = {}
  for (const it of items) {
    if (it.price_unit !== DASHSCOPE_TOKEN_UNIT) continue
    const v = typeof it.price === 'string' ? Number.parseFloat(it.price) : NaN
    if (!Number.isFinite(v) || v < 0) continue
    if (it.type === 'input_token') prices.tokens_in = v
    else if (it.type === 'output_token') prices.tokens_out = v
  }
  if (prices.tokens_in == null && prices.tokens_out == null) return null
  return { prices, source: `DashScope 官方目录·标准全价档（${group.range_name || 'Default'}，元/百万 token，非缓存/非 Batch）` }
}

/** 兼容多页合并后的 `{output:{models:[...]}}` / 裸 `{models:[...]}` / 单页对象，取出 DashScope 模型数组 */
function parseDashscopeModels(json: unknown): DashScopeModel[] {
  if (!json || typeof json !== 'object') return []
  const obj = json as Record<string, unknown>
  const out = obj['output']
  const models =
    out && typeof out === 'object'
      ? (out as Record<string, unknown>)['models']
      : obj['models']
  return Array.isArray(models) ? (models as DashScopeModel[]) : []
}

/**
 * DashScope 原生目录归一（仅 llm 带价）。非 llm（图/视频/语音）返回 []——不从 live 猜价（见文件头纪律）。
 * llm：仅保留有 token 全价档的文本模型（自然过滤 qwen-image / tts 等目录项），按 model id 去重。
 */
function normalizeDashscopeList(serviceType: PricingServiceType, json: unknown): ModelEntry[] {
  if (serviceType !== 'llm') return []
  const entries: ModelEntry[] = []
  const seen = new Set<string>()
  for (const m of parseDashscopeModels(json)) {
    const id = typeof m.model === 'string' ? m.model.trim() : ''
    if (!id || seen.has(id.toLowerCase())) continue
    const pricing = dashscopePricing(m)
    if (!pricing) continue
    seen.add(id.toLowerCase())
    const entry: ModelEntry = { id, pricing }
    if (typeof m.name === 'string' && m.name.trim()) entry.name = m.name.trim()
    const mi = m.model_info
    if (mi && (mi.max_input_tokens != null || mi.max_output_tokens != null)) {
      entry.context = { input: mi.max_input_tokens, output: mi.max_output_tokens }
    }
    entries.push(entry)
  }
  return entries
}

/** OpenAI 兼容口归一：[{id}] / {data:[{id}]} / {models:[{id}|'id']} → id-only（这些接口不返回价格，不猜） */
function normalizeCompatList(json: unknown): ModelEntry[] {
  let arr: unknown[] = []
  if (Array.isArray(json)) {
    arr = json
  } else if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>
    if (Array.isArray(obj['data'])) arr = obj['data'] as unknown[]
    else if (Array.isArray(obj['models'])) arr = obj['models'] as unknown[]
  }
  const seen = new Set<string>()
  const entries: ModelEntry[] = []
  for (const item of arr) {
    const id =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object'
          ? ((item as Record<string, unknown>)['id'] ?? (item as Record<string, unknown>)['name'])
          : null
    if (typeof id !== 'string' || !id.trim()) continue
    const key = id.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ id: id.trim() })
  }
  return entries
}

/**
 * 依 serviceType + providerKey 归一供应商模型目录 JSON → ModelEntry[]。
 * aliyun_*（DashScope 原生）走带价归一（仅 llm）；其余走 OpenAI 兼容口 id-only。
 */
export function normalizeModelList(
  serviceType: PricingServiceType,
  providerKey: string,
  json: unknown,
): ModelEntry[] {
  if (providerKey.startsWith('aliyun_')) return normalizeDashscopeList(serviceType, json)
  return normalizeCompatList(json)
}

/** 从 ModelEntry[] 抽 id（预置项置顶 + 其余字母序，沿用旧 fetch-models 排序语义） */
export function sortEntriesWithPreset(entries: ModelEntry[], preset: string[]): ModelEntry[] {
  const set = new Set(entries.map((e) => e.id))
  const head: ModelEntry[] = []
  const headIds = new Set<string>()
  for (const p of preset) {
    if (!set.has(p)) continue
    const e = entries.find((x) => x.id === p)
    if (e && !headIds.has(p)) {
      head.push(e)
      headIds.add(p)
    }
  }
  const rest = entries.filter((e) => !headIds.has(e.id)).sort((a, b) => a.id.localeCompare(b.id))
  return [...head, ...rest]
}
