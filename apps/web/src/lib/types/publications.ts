/**
 * 发布回采 / A/B 测试 / 成本聚合 前端类型
 */

/** 发布趋势数据点（按日聚合） */
export interface PublicationTrendItem {
  day: string
  count: number
  views: number
  interactions: number
}

/** A/B 分组对比数据 */
export interface AbGroupItem {
  group: string
  count: number
  views: number
  interactions: number
  platforms: string[]
  avgViews: number
  avgInteractions: number
}

/** 成本分解响应（三维度并行聚合） */
export interface CostBreakdown {
  byProviderModel: { items: CostItem[]; totals: CostTotals }
  byProject: { items: CostItem[]; totals: CostTotals }
  byKind: { items: CostItem[]; totals: CostTotals }
  totals: CostTotals
}

export interface CostItem {
  key: string
  quantity: number
  cost: number
  unpriced: number
  count: number
}

export interface CostTotals {
  quantity: number
  cost: number
  unpriced: number
}

/** 趋势对比基线响应（当前周期 vs 上一周期） */
export interface CompareResult {
  days: number
  current: {
    runs: { total: number; successRate: number }
    cost: { total: number }
    publications: { total: number; views: number; interactions: number }
  }
  previous: {
    runs: { total: number; successRate: number }
    cost: { total: number }
    publications: { total: number; views: number; interactions: number }
  }
  delta: { runsTotal: number; costTotal: number; successRate: number }
}

/** 平台导出预设 */
export interface ExportPreset {
  platform: string
  label: string
  aspect: string
  maxDuration: number
  namingPattern: string
  includeCover: boolean
  includeSubtitle: boolean
  watermark?: boolean
}

/** 导入预览（dry_run=1；mapping 可省时无 preview 块） */
export interface ImportPreview {
  columns: Array<{ index: number; name: string; sample: string[] }>
  preview?: { updateCount: number; newCount: number; duplicates: number }
  sampleRows: Array<Record<string, unknown>>
  warnings: string[]
}

/** 导入结果（dry_run=0） */
export interface ImportResult {
  created: number
  updated: number
  warnings: string[]
}
