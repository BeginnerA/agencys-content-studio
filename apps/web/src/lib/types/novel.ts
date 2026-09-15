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
  chapters?: Array<{ index?: number; reel?: string | null; title?: string; name?: string; asset_id?: number; chars?: number }>
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

export interface NovelBoardData {
  run_id: number
  /** run 内存在 text_split 步骤 */
  found: boolean
  step: { key: string; status: string } | null
  split: { manifest: NovelManifestDoc; chapters: NovelBoardChapter[] } | null
  graph: { asset_id: number; name: string; doc: NovelBoardGraphDoc | null } | null
  plan: { asset_id: number; name: string; doc: NovelBoardPlanDoc | null } | null
  scripts: Array<{ asset_id: number; name: string; ep: number | null }>
  events: { total: number; done: number; failed: number } | null
}
