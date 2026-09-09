import type { RunStatus, StepStatus, TaskStatus } from './types'

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function fmtSize(bytes: number | null | undefined): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function fmtDur(sec: number | null | undefined): string {
  if (!sec) return '—'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return m > 0 ? `${m}m${s}s` : `${s}s`
}

export function fmtMs(ms: number | null | undefined): string {
  if (!ms) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export interface StatusMeta {
  text: string
  cls: string
}

const RUN_TEXT: Record<RunStatus, string> = {
  queued: '排队中',
  running: '运行中',
  waiting_input: '待审阅',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

export function runStatus(s: RunStatus): StatusMeta {
  return { text: RUN_TEXT[s] ?? s, cls: s }
}

const STEP_TEXT: Record<StepStatus, string> = {
  pending: '等待',
  running: '执行中',
  waiting_input: '待审阅',
  succeeded: '成功',
  skipped: '已跳过',
  failed: '失败',
  cancelled: '已取消',
}

export function stepStatus(s: StepStatus): StatusMeta {
  return { text: STEP_TEXT[s] ?? s, cls: s }
}

/** skipped 原因（step.output.skipped.reason）展示文案 */
export function skipReasonText(reason: string | undefined): string {
  if (reason === 'user_skip') return '免审放行'
  if (reason === 'upstream_skipped') return '上游依赖已跳过'
  if (reason === 'when_condition') return '条件不满足'
  return '已跳过'
}

const TASK_TEXT: Record<TaskStatus, string> = {
  pending: '等待',
  processing: '生成中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
}

export function taskStatus(s: TaskStatus): StatusMeta {
  return { text: TASK_TEXT[s] ?? s, cls: s }
}

export const PURPOSE_TEXT: Record<string, string> = {
  source: '素材',
  brief: '题材简报',
  script: '剧本',
  storyboard: '分镜',
  shot_image: '镜头图',
  final_video: '成片',
  thumbnail: '封面',
  reference_character: '角色参考',
  archive: '归档',
}

export function purposeText(p: string): string {
  return PURPOSE_TEXT[p] ?? p
}

export const KIND_TEXT: Record<string, string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
  file: '文件',
}
