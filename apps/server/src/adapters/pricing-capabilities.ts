/**
 * [M33] 模型参考定价单一真源表（Tier A 基建，沿用 M32 video-capabilities 范式）。
 *
 * 背景：与视频档位同构的病——平台可核实的「参考定价」此前完全不参与建实例体验：新建实例定价框恒空、
 * 需用户手填（`settings.pricing` 全局表无种子、`resolveUnitPrice` 四级回退仅用于事后计价）。M33 把
 * 「经供应商公开定价页核实的参考价」收敛为唯一真源，供 `model-suggest` 端点在建实例时自动带出（Tier A）。
 *
 * 纪律（对齐 M32 §七，不降级）：
 *   - 仅登记**经供应商公开定价页 / 文档核实**的参考价，逐条附来源锚点；不按模型名猜测。
 *   - 未命中（未知 provider / 无核实依据的 model）→ `null`（fail-closed，前端回落手填）。
 *   - 口径：取**标准非折扣牌价**（DeepSeek 记高峰·缓存未命中全价，谷时/缓存命中更低已在 source 注明；
 *     阿里云取基础档 ≤ 阈值档价），预算视角**从不低估成本**。
 *
 * 关键零漂移约束：本表**仅用于「建实例预填」**，绝不注入 `resolveUnitPrice` 的事后计价回退链
 * （计价仍是「实例 pricing → 全局 settings.pricing → null」）。probe-m33 cost-zero-drift 节断言此边界。
 */
import type { UsageUnit } from '../services/usage'

export type PricingServiceType = 'llm' | 'image' | 'video' | 'audio'

export interface ModelPricing {
  /** 按 unit 索引的参考价（元/计价单位，与实例 apiConfigs.pricing 同基数口径：tokens=元/百万、char=元/千、image/second=元/个） */
  prices: Partial<Record<UsageUnit, number>>
  /** 来源标注（供应商公开定价页 / 文档锚点 + 口径说明），供前端「为何是这个值」提示（M37 前置） */
  source: string
}

/** 各服务能力类型允许的计价单位（真源表逐行守卫：填错单位即视为未核实 → 不背书） */
const UNITS_BY_SERVICE: Record<PricingServiceType, UsageUnit[]> = {
  llm: ['tokens_in', 'tokens_out'],
  image: ['image'],
  video: ['second'],
  audio: ['char'],
}

/**
 * 已核实参考定价真源表：providerKey → 精确 model（小写） → ModelPricing。
 * 首批仅登记能对上供应商官方定价页且模型名与预置目录一致的条目；其余留空回落手填。
 */
const PRICING_TABLE: Record<string, Record<string, ModelPricing>> = {
  deepseek_llm: {
    'deepseek-flash': { prices: { tokens_in: 2, tokens_out: 8 }, source: 'DeepSeek 官方定价页·高峰缓存未命中全价（谷时减半、缓存命中更低）' },
    'deepseek-v4-pro': { prices: { tokens_in: 9, tokens_out: 27 }, source: 'DeepSeek 官方定价页·高峰缓存未命中全价（谷时 4.5/13.5）' },
  },
  aliyun_qwen_llm: {
    'qwen3.8-max': { prices: { tokens_in: 12, tokens_out: 36 }, source: '阿里云百炼定价页·≤1M 档标准价（Batch 半价 / 缓存折扣另计）' },
    'qwen3.7-plus': { prices: { tokens_in: 2, tokens_out: 8 }, source: '阿里云百炼定价页·基础档 ≤256K（256K–1M 6/24；限时 8 折另计）' },
    'qwen3.8-flash': { prices: { tokens_in: 0.8, tokens_out: 2.7 }, source: '阿里云百炼定价页·≤1M 档标准价' },
  },
  aliyun_wan_image: {
    'wan2.7-image': { prices: { image: 0.2 }, source: '阿里云百炼定价页·万相文生图' },
    'wan2.7-image-pro': { prices: { image: 0.5 }, source: '阿里云百炼定价页·万相文生图 Pro' },
  },
  // 视频/音频、MiniMax / 火山 Seedance / Pollinations / SiliconFlow / OpenAI / Google 等：
  // 秒价需分辨率分档 / 非 CNY 公开牌价 / 逐模型锚点未取净 → 无核实依据，一律不登记（回落手填，绝不猜价）。
}

/**
 * 依 serviceType + providerKey + 精确 model 解析已核实参考定价；未命中返回 null（不猜、不回退通用默认）。
 * serviceType 用于单位守卫：行内单位与能力类型不符 → 视为未核实（防表内填错造成虚假成本背书）。
 */
export function resolveModelPricing(
  serviceType: PricingServiceType,
  providerKey: string,
  model: string,
): ModelPricing | null {
  const byModel = PRICING_TABLE[providerKey]
  if (!byModel) return null
  const m = (model || '').trim().toLowerCase()
  if (!m) return null
  const hit = byModel[m]
  if (!hit) return null
  const allowed = UNITS_BY_SERVICE[serviceType]
  if (!allowed) return null
  const units = Object.keys(hit.prices)
  if (!units.length || units.some((u) => !allowed.includes(u as UsageUnit))) return null
  return hit
}
