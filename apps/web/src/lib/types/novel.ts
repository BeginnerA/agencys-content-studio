// ===== [M9] 小说改编链（GET /runs/:id/novel-board 契约） =====

/** 章节索引.json（切分 manifest；后端已解析，字段宽松防御） */
export interface NovelManifestDoc {
  source?: { asset_ids?: number[]; names?: string[]; chars?: number }
  regex_source?: string
  regex_used?: string
  total?: number
  selected?: number
  range?: string | null
  skipped_head_chars?: number
  reels?: string[]
  /** [M25·G6] 多部合并（per_source=true 时服务端附加） */
  per_source?: boolean
  books?: Array<{ name?: string; count?: number }>
  /** [M25·G7] 增量连载批次记录 */
  appended_at?: unknown[]
  chapters?: Array<{ index?: number; reel?: string | null; title?: string; name?: string; asset_id?: number; chars?: number; source_book?: string }>
}

/** 章节行（服务端规范化 + 事件提取任务状态） */
export interface NovelBoardChapter {
  index: number
  title: string
  reel: string | null
  name: string
  asset_id: number
  chars: number
  /** pending/processing/succeeded/failed/cancelled；无任务 → null */
  event_status: string | null
  /** [M25·G6] 多部合并归属书名（非 per_source → null） */
  source_book?: string | null
}

/** 事件图谱（event-graph.json，展示用字段宽松） */
export interface NovelBoardGraphDoc {
  overview?: string
  characters?: Array<{ name?: string; role?: string; arc?: string }>
  key_events?: Array<{ id?: string; name?: string; summary?: string; chapters?: number[]; intensity?: number; kind?: string }>
}

/** 分集规划（plan.json，episodes 为准） */
export interface NovelBoardPlanDoc {
  title?: string
  episode_count?: number
  episodes?: Array<{
    ep?: number
    title?: string
    chapters?: number[]
    synopsis?: string
    opening_hook?: string
    ending_hook?: string
    key_event_ids?: string[]
    chapter_events?: unknown
  }>
}

/** [M25·G3] 服务端确定性力导向布局（graph.layout；脏 doc → null 前端降级表视图） */
export interface GraphLayout {
  nodes: Array<{ id: string; kind: 'event' | 'character'; label: string; weight?: number; x: number; y: number; r: number }>
  links: Array<{ source: string; target: string; kind: string }>
  width: number
  height: number
}

export interface NovelBoardData {
  run_id: number
  /** run 内存在 text_split 步骤 */
  found: boolean
  step: { key: string; status: string } | null
  split: { manifest: NovelManifestDoc; chapters: NovelBoardChapter[] } | null
  graph: { asset_id: number; name: string; doc: NovelBoardGraphDoc | null; layout?: GraphLayout | null } | null
  plan: { asset_id: number; name: string; doc: NovelBoardPlanDoc | null } | null
  scripts: Array<{ asset_id: number; name: string; ep: number | null }>
  events: { total: number; done: number; failed: number } | null
}
