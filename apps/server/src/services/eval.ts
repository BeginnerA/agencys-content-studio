import { stripCodeFence } from './compliance'

// [M24·F2] 一致性 A/B 评测纯函数三件套（spec §2.3）：评分解析 / 矩阵聚合 / 报告渲染。
// LLM 调用与 batch 展开在 eval 路由层编排（P1 实装；真实调用走 e2e 实弹，探针不联网）。
// 契约（eval-consistency.md 提示词）：{ scores: [{asset_id, consistency, style, quality, note}] }，0–10 一位小数。

/** 单图评分（asset_id 对齐后被采纳） */
export interface EvalScore {
  assetId: number
  consistency: number
  style: number
  quality: number
  note: string
}

/** 评测组（label = 变体名；assetIds = 该组被评图像资产） */
export interface EvalGroup {
  label: string
  assetIds: number[]
}

export interface ParseEvalResult {
  /** JSON 整体可解析且拿到 scores 数组（false = 全坏 → 调用侧降级 raw 报告，不出假分） */
  parsed: boolean
  scores: EvalScore[]
  /** 坏行/越界 id/重复 id 跳过计数 */
  skipped: number
}

/** 0–10 一位小数（钳制 + 舍入；评分口径统一的唯一出口） */
export function clampScore(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.round(Math.min(10, Math.max(0, v)) * 10) / 10
}

const mean1 = (xs: number[]): number => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10

/**
 * LLM 输出 → 结构化评分：剥围栏 → JSON 解析 → asset_id 与期望集对齐（越界/坏行/重复跳过计数）。
 * 兼容 root 直接为数组的宽容输出；三评分任一非法 → 该行作废（部分分不可信）。
 */
export function parseEvalScores(text: string, expectedIds: number[]): ParseEvalResult {
  const expected = new Set(expectedIds)
  const seen = new Set<number>()
  try {
    const raw = JSON.parse(stripCodeFence(text)) as unknown
    const arr = Array.isArray(raw) ? raw : ((raw as Record<string, unknown>)?.scores ?? null)
    if (!Array.isArray(arr)) return { parsed: false, scores: [], skipped: 0 }
    const scores: EvalScore[] = []
    let skipped = 0
    for (const it of arr) {
      if (!it || typeof it !== 'object') {
        skipped += 1
        continue
      }
      const o = it as Record<string, unknown>
      const id = typeof o.asset_id === 'number' && Number.isInteger(o.asset_id) ? o.asset_id : null
      const c = clampScore(o.consistency)
      const s = clampScore(o.style)
      const q = clampScore(o.quality)
      if (id === null || !expected.has(id) || seen.has(id) || c === null || s === null || q === null) {
        skipped += 1
        continue
      }
      seen.add(id)
      scores.push({ assetId: id, consistency: c, style: s, quality: q, note: typeof o.note === 'string' ? o.note.trim() : '' })
    }
    return { parsed: true, scores, skipped }
  } catch {
    return { parsed: false, scores: [], skipped: 0 }
  }
}

export interface DimStat {
  mean: number
  min: number
  max: number
}

export interface VariantStat {
  label: string
  /** 有分图片数 */
  n: number
  /** 组内未获评分的资产数（解析跳过/LLM 漏答） */
  missing: number
  /** 三维均分的每图综合分聚合 */
  mean: number
  min: number
  max: number
  dims: { consistency: DimStat; style: DimStat; quality: DimStat }
  /** 综合均分排名（1 起；同分按 label 字典序） */
  rank: number
}

export interface EvalAggregate {
  /** 确定性排序：label 字典序（rank 字段另表名次） */
  variants: VariantStat[]
  overall: { n: number; mean: number }
}

/** 单图综合分 = 三维均值（再一位小数） */
export function compositeOf(s: EvalScore): number {
  return Math.round(((s.consistency + s.style + s.quality) / 3) * 10) / 10
}

const dimStat = (xs: number[]): DimStat => ({ mean: mean1(xs), min: Math.min(...xs), max: Math.max(...xs) })

/** 矩阵聚合：per-variant n/mean/min/max + 三维分布 + 排名；无分组 n=0（mean 记 0，不抛） */
export function aggregateEvalMatrix(scores: EvalScore[], groups: EvalGroup[]): EvalAggregate {
  const byId = new Map(scores.map((s) => [s.assetId, s]))
  const stats: Array<Omit<VariantStat, 'rank'>> = groups.map((g) => {
    const owned = g.assetIds.map((id) => byId.get(id)).filter((s): s is EvalScore => Boolean(s))
    const composites = owned.map(compositeOf)
    const zero = { mean: 0, min: 0, max: 0 }
    return {
      label: g.label,
      n: owned.length,
      missing: g.assetIds.length - owned.length,
      mean: composites.length ? mean1(composites) : 0,
      min: composites.length ? Math.min(...composites) : 0,
      max: composites.length ? Math.max(...composites) : 0,
      dims: owned.length
        ? {
            consistency: dimStat(owned.map((s) => s.consistency)),
            style: dimStat(owned.map((s) => s.style)),
            quality: dimStat(owned.map((s) => s.quality)),
          }
        : { consistency: zero, style: zero, quality: zero },
    }
  })
  // rank：mean 降序、同分 label 字典序；输出数组本身按 label 字典序（确定性）
  const ranked: VariantStat[] = stats.map((s) => ({ ...s, rank: 0 }))
  const order = ranked
    .map((_, i) => i)
    .sort((a, b) => {
      const x = ranked[a]!
      const y = ranked[b]!
      return y.mean !== x.mean ? y.mean - x.mean : x.label.localeCompare(y.label)
    })
  order.forEach((idx, rank) => {
    const t = ranked[idx]
    if (t) t.rank = rank + 1
  })
  ranked.sort((a, b) => a.label.localeCompare(b.label))
  const all = scores.map(compositeOf)
  return {
    variants: ranked,
    overall: { n: scores.length, mean: all.length ? mean1(all) : 0 },
  }
}

/** CSV 字段转义（含逗号/引号/换行 → 双引号包裹，内部引号加倍） */
function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/** 报告渲染：markdown 聚合表 + 明细 CSV 段（供 purpose=eval_report 资产，人工复核） */
export function renderEvalReport(agg: EvalAggregate, scores: EvalScore[], groups: EvalGroup[]): string {
  const labelOf = new Map<number, string>()
  for (const g of groups) for (const id of g.assetIds) labelOf.set(id, g.label)
  const lines = [
    `# 一致性 A/B 评测报告`,
    ``,
    `- 有效评分：${agg.overall.n} 图 · 综合均分 ${agg.overall.mean}`,
    `- 结论供人工复核，不作统计显著性声明（spec §8）。`,
    ``,
    `| 变体 | 排名 | n | 均分 | 最低 | 最高 | 一致性 | 风格 | 质量 | 缺分 |`,
    `|---|---|---|---|---|---|---|---|---|---|`,
  ]
  const byLabel = [...agg.variants].sort((a, b) => a.rank - b.rank)
  for (const v of byLabel) {
    lines.push(
      `| ${v.label} | ${v.rank} | ${v.n} | ${v.mean} | ${v.min} | ${v.max} | ${v.dims.consistency.mean} | ${v.dims.style.mean} | ${v.dims.quality.mean} | ${v.missing} |`,
    )
  }
  lines.push(``, `## 明细（CSV）`, ``, '```csv', `asset_id,label,consistency,style,quality,note`)
  for (const s of [...scores].sort((a, b) => a.assetId - b.assetId)) {
    lines.push(`${s.assetId},${labelOf.get(s.assetId) ?? '—'},${s.consistency},${s.style},${s.quality},${csvCell(s.note)}`)
  }
  lines.push('```')
  return `${lines.join('\n')}\n`
}
