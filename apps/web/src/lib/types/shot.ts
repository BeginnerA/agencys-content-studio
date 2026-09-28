import type { StepStatus, TaskStatus } from './base'

// ===== 镜头工作台（GET /runs/:id/shot-board 契约） =====

/** 同镜历史版本（缩略图懒加载；urls 为引用） */
export interface ShotVersion {
  id: number
  name: string
  createdAt: number
  width: number | null
  height: number | null
  duration: number | null
  prompt: string | null
  /** 版本来源：task=步骤任务产物 / upload=本地上传入库 */
  source: 'task' | 'upload'
  /** 收藏标记（1=已收藏；版本清理保留豁免） */
  isFavorite: number
  /** 图像检测摘要（无/坏数据 → null，前端不显示徽标） */
  quality: Pick<ImageQuality, 'ok' | 'reason'> | null
  urls: { file: string; thumb: string | null }
}

/** 镜头对应生成任务摘要（无任务 → null） */
export interface ShotTaskLite {
  id: number
  status: TaskStatus
  attempts: number
  errorMsg: string | null
  prompt: string | null
}

export interface ShotBoardShot {
  shotId: string
  order: number
  imagePrompt: string
  motionPrompt: string
  /** 分镜 per-shot 时长（null = 用全局 duration_per_shot） */
  duration: number | null
  task: ShotTaskLite | null
  /** 当前 output.asset_ids 中命中该镜的资产（null = 未选中/无产物） */
  selectedAssetId: number | null
  versions: ShotVersion[]
  /** 分镜对象全量（大编辑器字段回显/动态键值行） */
  raw: Record<string, unknown>
}

/** 合成新鲜度（run 无 ffmpeg_merge 步骤 → board.compose 为 null） */
export interface ShotBoardCompose {
  stepKey: string
  composedAt: number | null
  /** true/false/null（null = 旧产物无快照，无法判定，UI 降级为常态提示） */
  stale: boolean | null
}

export interface ShotBoardData {
  step: {
    id: number
    key: string
    title: string | null
    action: string
    status: StepStatus
  }
  shots: ShotBoardShot[]
  compose: ShotBoardCompose | null
  /** 返修可用性（不抛错判定：活跃 run / 其他 failed 步骤等） */
  repairable: { ok: boolean; reason: string | null }
  /** 审阅闸门暂停：本步持有 waiting_input 人工闸→仅开放逐镜重出（其余工作台操作仍锁） */
  gateRegenerate: boolean
  /** 闸门暂停且非轻松创作：开放逐镜改词＋保存并重生成（批准链模板仍只可同词重出） */
  gateEdit: boolean
}

/** 分镜字段级编辑项（edit / regenerate 复用） */
export interface ShotEditItem {
  shot_id: string
  image_prompt?: string
  motion_prompt?: string
  duration?: number
}

/** 选片/选镜提交项（shot_id 不重复；asset 需属该步骤任务组且 kind 匹配） */
export interface ShotPick {
  shot_id: string
  asset_id: number
}

/**
 * 结构性编辑操作（POST /runs/:id/shots/mutate）；前端建议序列 add* → patch* → remove* → reorder。
 */
export type ShotOp =
  | { op: 'reorder'; order: string[] }
  | { op: 'add'; shot: Record<string, unknown> }
  | { op: 'remove'; shot_id: string }
  | { op: 'patch'; shot_id: string; fields: Record<string, unknown> }

// ===== 旧版本清理与收藏 / 图像检测 =====

/** 图像有效性检测结果（assets.params.quality 契约；ok=null 表示无法判定） */
export interface ImageQuality {
  ok: boolean | null
  reason: string
  stats?: { ymin: number; ymax: number; yavg: number; satavg: number }
  checkedAt?: number
}

/** 版本清理结果（shots/cleanup 与 assets/cleanup-versions 共用；groups=命中版本组数） */
export interface CleanupResult {
  ok: boolean
  groups: number
  cleaned: number
  kept: number
  note: string
}

/** 清空回收站文件结果（物理删除回收站内资产文件；files=回收文件数；记录保留） */
export interface GcResult {
  ok: boolean
  files: number
  freed_bytes: number
  note: string
}
