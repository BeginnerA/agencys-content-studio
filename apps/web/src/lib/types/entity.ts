import type { AssetUrls } from './base'

// ===== [M3] 记忆与角色 =====

export interface MemoryItem {
  id: number
  scope: 'project' | 'global'
  projectId: number | null
  type: string
  name: string | null
  content: string
  embeddingModel: string | null
  hasEmbedding: boolean
  /** 语义检索模式（q 给定）下的相似度 */
  score?: number
  meta?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface CharacterRefAsset {
  id: number
  name: string
  urls: AssetUrls
}

/** [M8] 实体素材类型：角色 / 场景 / 道具（单表多态，kind 列） */
export type EntityKind = 'character' | 'scene' | 'prop'

export interface EntityItem {
  id: number
  projectId: number | null
  scope: 'project' | 'global'
  kind: EntityKind
  name: string
  aliases: string[]
  summary: string | null
  appearance: string | null
  negative: string | null
  /** 声线（仅 kind=character 有意义；scene/prop 恒为 null） */
  voice: string | null
  /** [M13] 状态变体（仅 kind=character 有意义；「剧情节点：状态短语」；scene/prop 恒为 []） */
  states: string[]
  refAssetIds: number[]
  refAssets: CharacterRefAsset[]
  meta?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

/** [M8] 风格预设（平台级通用画风词块；[M13] 项目经 settings.style_preset_ids 数组多选绑定，旧单值键兼容回退） */
export interface StylePresetItem {
  id: number
  name: string
  snippet: string
  description: string | null
  sortOrder: number
  /** 1=启用 / 0=停用 */
  isActive: number
  createdAt: number
  updatedAt: number
}

/** [M13] 参考图视觉提取结果（POST /style-presets/extract；不落库，供表单预填） */
export interface StyleExtractResult {
  snippet: string
  provider: string
  model: string
}

/** [M13] 批量润色结果（POST /entities/polish；failed 项不改动，可重选重试） */
export interface EntityPolishResult {
  ok: boolean
  polished: Array<{ id: number; name: string; appearance: string }>
  failed: Array<{ id: number; error: string }>
}

/** [M19 P6] 参考图批量生成任务视图（无 run 异步队列；GET /entities/ref-gen/tasks） */
export interface EntityRefGenTask {
  id: number
  entityId: number
  /** 实体名（服务层已按主数据带出；已删除时回退「素材#{id}」） */
  entityName: string
  variantIndex: number
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled'
  errorMsg: string | null
  resultAssetId: number | null
  updatedAt: number
}

/** [M19 P6] 发起结果（202 入队即返；tasks 按实体去重后顺序 × variants 展开） */
export interface EntityRefGenIssueResult {
  ok: boolean
  tasks: Array<{ id: number; entityId: number }>
  count: number
  note?: string
}

export interface MemoryStatus {
  ready: boolean
  modelDir: string
  modelName: string
  dims: number | null
  count: number
  missingEmbedding: number
  error?: string
}
