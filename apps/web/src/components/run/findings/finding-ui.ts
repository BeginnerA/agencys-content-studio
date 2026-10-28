// M69 审片面板的展示文案与表单状态（纯常量/类型，无副作用）。
import type {
  FindingView,
  FindingsList,
  ReviewCategory,
  ReviewScopeKind,
} from '../../../lib/types/findings'

export type FindingSegment = NonNullable<
  FindingsList['timeline']
>['segments'][number]

export interface FindingFormState {
  category: ReviewCategory
  severity: FindingView['severity']
  scopeKind: ReviewScopeKind
  shotId: string
  startMs: number
  endMs: number
  note: string
}

export const CATEGORY_TEXT: Record<ReviewCategory, string> = {
  visual: '画面',
  prop: '道具连续',
  lip_sync: '口型',
  subtitle: '字幕',
  audio: '音频',
  pacing: '节奏',
  other: '其他',
}

export const STATUS_TEXT: Record<FindingView['status'], string> = {
  open: '待处理',
  in_rework: '返修中',
  pending_recheck: '待复检',
  verified: '已确认',
  dismissed: '已忽略',
}

export const STATUS_BADGE: Record<FindingView['status'], string> = {
  open: 'queued',
  in_rework: 'running',
  pending_recheck: 'queued',
  verified: 'succeeded',
  dismissed: 'cancelled',
}

export const SEVERITY_TEXT: Record<FindingView['severity'], string> = {
  blocker: '阻断',
  major: '重要',
  minor: '轻微',
}

export const SEVERITY_BADGE: Record<FindingView['severity'], string> = {
  blocker: 'failed',
  major: 'queued',
  minor: 'skip',
}

export const RECHECK_TEXT: Record<
  NonNullable<FindingView['recheck']>['state'],
  string
> = {
  changed: '证据已变化',
  unchanged: '证据未变化',
  unverifiable: '无法自动比对',
}

/** 类别 → 允许的范围（与后端 categoryAllowsScope 同口径） */
export function allowedScopes(category: ReviewCategory): ReviewScopeKind[] {
  if (category === 'lip_sync') return ['shot']
  if (category === 'pacing') return ['time', 'global']
  return ['shot', 'time', 'global']
}
