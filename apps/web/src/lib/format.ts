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
  reference_scene: '场景参考',
  reference_prop: '道具参考',
  archive: '归档',
  characters: '角色设定',
  sets: '场景道具',
  set_log: '素材建档',
  subtitle: '字幕',
  voice: '配音',
  lines: '台词',
  export: '成稿',
  // [M9] 小说改编链
  chapters: '章节',
  events: '事件',
  graph: '事件图谱',
  plan: '分集规划',
  regex: '切分正则',
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
  archive: '归档',
}

export const PLATFORM_TEXT: Record<string, string> = {
  douyin: '抖音',
  wechat_channels: '视频号',
  kuaishou: '快手',
  xiaohongshu: '小红书',
  bilibili: 'B站',
  other: '其他',
}

/** 成本展示：0 → ¥0；< 1 元 4 位小数；否则 2 位（null/undefined → —） */
export function fmtCost(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  if (n === 0) return '¥0'
  return `¥${n < 1 ? n.toFixed(4) : n.toFixed(2)}`
}

const BATCH_TEXT: Record<string, string> = {
  running: '进行中',
  completed: '已完成',
  partial_failed: '部分失败',
  failed: '失败',
  cancelled: '已取消',
}

/** 批次状态展示（badge class 直接用 batch status；partial_failed 全局补 warn 色） */
export function batchStatus(s: string): StatusMeta {
  return { text: BATCH_TEXT[s] ?? s, cls: s }
}

/** 数量展示（≥1 万缩为「x.x 万」） */
export function fmtQty(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(Math.round(n))
}

/** 输入摘要（前 3 键，超 80 字截断；批次内运行的行内标识） */
export function inputSummary(input: Record<string, unknown> | null | undefined): string {
  if (!input) return '—'
  const s = Object.entries(input)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ')
  return s.length > 80 ? s.slice(0, 80) + '…' : s
}
