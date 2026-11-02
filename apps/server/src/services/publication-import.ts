/**
 * 发布数据导入装配与匹配：纯函数，零 IO、零 db。
 * 更新保护靠「patch 白名单」构造性成立：patch 只含 metrics/url/publishedAt/title 四键，
 * runId/assetId/abGroup/note 永不出现在更新集——路由只 set patch，保护无需额外判断。
 */
import type { Publication } from '../db/schema'
import type { ParsedTable } from './table-parse'

export type MappingField =
  | 'title' | 'url' | 'publishedAt'
  | 'views' | 'likes' | 'comments' | 'favorites' | 'shares'
  | 'abGroup'

export type ImportMapping = Partial<Record<MappingField, number>>

export const MAPPING_FIELDS: readonly MappingField[] = [
  'title', 'url', 'publishedAt', 'views', 'likes', 'comments', 'favorites', 'shares', 'abGroup',
]

export class ImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ImportError'
  }
}

export interface AssembledRow {
  rowIndex: number
  platform: string
  title: string | null
  url: string | null
  publishedAt: number | null
  abGroup: string | null
  metrics: { views: number; likes: number; comments: number; favorites: number; shares: number }
}

export interface ImportPlan {
  updates: Array<{
    id: number
    row: AssembledRow
    patch: { metrics: string; url: string | null; publishedAt: number | null; title: string | null }
  }>
  creates: AssembledRow[]
  duplicates: number
}

const METRIC_KEYS: readonly (keyof AssembledRow['metrics'])[] = ['views', 'likes', 'comments', 'favorites', 'shares']

export function parseMapping(raw: unknown): ImportMapping {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ImportError('bad_mapping', 'mapping 需为对象')
  }
  const out: ImportMapping = {}
  let useful = 0
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(MAPPING_FIELDS as readonly string[]).includes(k)) {
      throw new ImportError('bad_mapping', `mapping 未知字段：${k}`)
    }
    if (v === null || v === undefined || v === '') continue
    if (!Number.isInteger(v) || (v as number) < 0) {
      throw new ImportError('bad_mapping', `mapping.${k} 需为非负整数列索引`)
    }
    out[k as MappingField] = v as number
    useful++
  }
  if (useful === 0) throw new ImportError('bad_mapping', 'mapping 至少映射一个字段')
  return out
}

const DATE_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/

/** 日期字符串 → ms：xlsx 路产出的 'YYYY-MM-DD HH:mm' 与 CSV 文本（2026/1/5 10:00、2026-01-05）按本地时区解析 */
export function toMs(s: string | null): number | null {
  if (!s) return null
  const t = s.trim()
  const m = DATE_RE.exec(t)
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)).getTime()
  }
  if (/^\d{12,13}$/.test(t)) return Number(t)
  return null
}

function dayOf(ms: number | null): string {
  if (ms === null) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function cellOf(row: string[], idx: number): string | null {
  return idx >= 0 && idx < row.length ? row[idx]!.trim() : null
}

function numOf(s: string | null): number {
  if (!s) return 0
  const n = Number(s.replace(/[,，\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export function assembleRows(
  table: ParsedTable,
  mapping: ImportMapping,
  platform: string,
): { rows: AssembledRow[]; warnings: string[] } {
  const warnings: string[] = []
  const warnedCols = new Set<MappingField>()
  const pick = (r: string[], f: MappingField): string | null => {
    const idx = mapping[f]
    if (idx === undefined) return null
    if (idx >= r.length) {
      if (!warnedCols.has(f)) {
        warnings.push(`列索引越界：${f}（第 ${idx} 列不存在，按缺失处理）`)
        warnedCols.add(f)
      }
      return null
    }
    return cellOf(r, idx)
  }
  const rows: AssembledRow[] = table.rows.map((r, i) => {
    const rawAt = pick(r, 'publishedAt')
    const ms = toMs(rawAt)
    if (rawAt && ms === null) warnings.push(`第 ${i + 2} 行发布时间无法解析：${rawAt.slice(0, 40)}（置空）`)
    return {
      rowIndex: i,
      platform,
      title: pick(r, 'title') || null,
      url: pick(r, 'url') || null,
      publishedAt: ms,
      abGroup: pick(r, 'abGroup') || null,
      metrics: {
        views: numOf(pick(r, 'views')),
        likes: numOf(pick(r, 'likes')),
        comments: numOf(pick(r, 'comments')),
        favorites: numOf(pick(r, 'favorites')),
        shares: numOf(pick(r, 'shares')),
      },
    }
  })
  return { rows, warnings }
}

type Metrics = AssembledRow['metrics']

function safeMetrics(raw: string | null): Metrics {
  const out: Metrics = { views: 0, likes: 0, comments: 0, favorites: 0, shares: 0 }
  try {
    const m = JSON.parse(raw ?? '{}') as Record<string, unknown>
    for (const k of METRIC_KEYS) {
      const n = Number(m[k] ?? 0)
      if (Number.isFinite(n) && n > 0) out[k] = Math.floor(n)
    }
  } catch {
    /* 损坏 JSON 按全零 */
  }
  return out
}

/** 文件内去重键：URL 优先；无 URL 用 平台|标题|同日 */
function dedupeKey(r: AssembledRow): string {
  if (r.url) return `u:${r.url}`
  return `t:${r.platform}|${r.title ?? ''}|${dayOf(r.publishedAt)}`
}

export function matchRows(rows: AssembledRow[], existing: Publication[]): ImportPlan {
  const plan: ImportPlan = { updates: [], creates: [], duplicates: 0 }
  // 同文件去重：同匹配键取最后一条（后行覆盖前行）
  const lastByKey = new Map<string, AssembledRow>()
  for (const r of rows) lastByKey.set(dedupeKey(r), r)
  plan.duplicates = rows.length - lastByKey.size

  const claimed = new Set<number>()
  for (const r of lastByKey.values()) {
    let hit: Publication | undefined
    if (r.url) {
      hit = existing.find((e) => e.platform === r.platform && (e.url ?? '').trim() === r.url)
    }
    if (!hit && r.title) {
      hit = existing.find(
        (e) =>
          e.platform === r.platform &&
          (e.title ?? '').trim() === r.title &&
          e.publishedAt !== null &&
          r.publishedAt !== null &&
          dayOf(e.publishedAt) === dayOf(r.publishedAt),
      )
    }
    if (hit && !claimed.has(hit.id)) {
      claimed.add(hit.id)
      const ex = safeMetrics(hit.metrics)
      const merged = {} as Metrics
      for (const k of METRIC_KEYS) merged[k] = r.metrics[k] > 0 ? r.metrics[k] : ex[k]
      const exUrl = (hit.url ?? '').trim()
      const exTitle = (hit.title ?? '').trim()
      plan.updates.push({
        id: hit.id,
        row: r,
        patch: {
          metrics: JSON.stringify(merged),
          url: exUrl ? exUrl : r.url,
          publishedAt: hit.publishedAt ?? r.publishedAt,
          title: exTitle ? exTitle : r.title,
        },
      })
    } else {
      plan.creates.push(r)
    }
  }
  return plan
}
