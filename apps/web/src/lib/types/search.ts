/** 全局搜索类型（GET /search 响应） */

export interface SearchItem {
  id: number
  title: string
  subtitle: string | null
  /** 前端路由路径（可直接 router.push） */
  url: string
}

export interface SearchGroup {
  domain: string
  label: string
  items: SearchItem[]
}

export interface SemanticHit {
  entity: 'memory' | 'asset'
  id: number
  title: string
  snippet: string
  score: number
  url: string
}

export interface SearchResult {
  q: string
  /** 关键词命中（空组不出现；域序固定 项目→运行→资产→实体→画布→发布→剧集→批次→排产） */
  groups: SearchGroup[]
  semantic: {
    /** 模型可用且执行成功 */
    available: boolean
    /** 模型不可用/运行期错误已降级（关键词照常） */
    degraded: boolean
    /** 后台正在补齐文本资产索引（首搜触发） */
    indexing: boolean
    hits: SemanticHit[]
  }
}
