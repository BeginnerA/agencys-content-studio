/**
 * [M28] 创作画布板内共用符号（自 CreationBoard.vue 逐字迁移；无状态常量与纯函数）
 * —— 迁移纪律：常量/函数体逐字保留，仅补 export 前缀供 board 子模块共用
 */
import type {
  AnyNodeSpec,
  CanvasDocEdge,
  CanvasDocNode,
  CanvasGroup,
  CanvasViewport,
  CreationNodeSpec,
} from '../../../lib/types'
import { fmtMs } from '../../../lib/format'

// ---- 组件对外契约（自 CreationBoard.vue props/emit 定义迁移，字段与类型逐字）----
export interface BoardProps {
  nodes: CanvasDocNode[]
  edges: CanvasDocEdge[]
  groups: CanvasGroup[]
  selectedIds: number[]
  selectedEdgeId: number | null
  initialViewport: CanvasViewport | null
}

export interface BoardEmits {
  select: [ids: number[]]
  selectEdge: [id: number | null]
  moved: [moves: Array<{ id: number; x: number; y: number }>]
  nudge: [moves: Array<{ id: number; x: number; y: number }>]
  connect: [p: { from: number; to: number; port: string }]
  'create-node': [p: { x: number; y: number }]
  'drop-files': [p: { files: File[]; x: number; y: number }]
  'drop-asset': [p: { assetId: number; x: number; y: number }]
  'drop-entity': [p: { entityId: number; x: number; y: number }]
  'viewport-settled': [v: CanvasViewport]
  'delete-selected': []
  'copy-selected': []
  'group-create': []
  'group-patch': [
    gid: number,
    patch: {
      title?: string
      color?: string | null
      collapsed?: boolean
      parentId?: number | null
    },
  ]
  'group-delete': [gid: number]
  /** [M22] 组条拖拽：后代组锚点批量平移（与 moved 节点平移同源 dx/dy） */
  'groups-moved': [moves: Array<{ id: number; x: number; y: number }>]
  undo: []
  redo: []
}

/** emit 签名（与 defineEmits<BoardEmits>() 返回结构一致；供交互 composable 参数注入） */
export type BoardEmitFn = {
  <K extends keyof BoardEmits>(event: K, ...args: BoardEmits[K]): void
}

// ---- 常量（spec：节点卡宽 220）----
export const NODE_W = 220
export const DEFAULT_H = 140
export const PAD = 70
const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v))

export interface EdgePath {
  id: number
  d: string
  port: string
  sel: boolean
}
export function bezier(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(48, Math.abs(x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

export const ARROW: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}
export function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el?.closest?.('input, textarea, select, [contenteditable="true"]')
}

// ---- 节点卡辅助 ----
export const PORT_TEXT: Record<string, string> = {
  reference: '参考图',
  first_frame: '首帧',
  last_frame: '尾帧',
  source: '源图（编辑底图）',
  prompt: '提示词（文本节点）',
  video: '视频输入（合成）',
  audio: '音频输入（合成）',
  text: '文本素材（LLM）',
}
const TASK_CLS: Record<string, string> = {
  pending: 'pending',
  processing: 'processing',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
}
const TASK_TEXT: Record<string, string> = {
  pending: '等待',
  processing: '生成中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
}
const RUN_CLS: Record<string, string> = {
  queued: 'pending',
  running: 'processing',
  waiting_input: 'pending',
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
}
const RUN_TEXT: Record<string, string> = {
  queued: '排队',
  running: '运行中',
  waiting_input: '待输入',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
}
const ENTITY_KIND_TEXT: Record<string, string> = {
  character: '角色',
  scene: '场景',
  prop: '道具',
}

export function stText(n: CanvasDocNode): string {
  return n.status && n.status !== 'idle'
    ? (TASK_TEXT[n.status] ?? n.status)
    : ''
}
export function stCls(n: CanvasDocNode): string {
  return n.status ? (TASK_CLS[n.status] ?? 'pending') : ''
}
export function runText(n: CanvasDocNode): string {
  return n.kind === 'run' && n.run
    ? (RUN_TEXT[n.run.status] ?? n.run.status)
    : ''
}
export function runCls(n: CanvasDocNode): string {
  return n.kind === 'run' && n.run ? (RUN_CLS[n.run.status] ?? 'pending') : ''
}

/** spec 类型守卫：是否 gen 规范（含 genKind） */
function asGenSpec(s: AnyNodeSpec | null): CreationNodeSpec | null {
  return s && typeof s === 'object' && 'genKind' in s
    ? (s as CreationNodeSpec)
    : null
}
export function inputPortsOf(n: CanvasDocNode): string[] {
  if (n.kind !== 'gen') return []
  const spec = asGenSpec(n.spec)
  if (!spec) return []
  if (spec.genKind === 'compose') return ['video', 'audio']
  if (spec.genKind === 'audio') return ['prompt']
  if (spec.genKind === 'llm') return ['reference', 'text', 'prompt']
  const ports = ['reference']
  if (spec.genKind === 'video') ports.push('first_frame', 'last_frame')
  if (spec.edit) ports.push('source')
  ports.push('prompt')
  return ports
}
export function hasOutPort(n: CanvasDocNode): boolean {
  return n.kind !== 'run'
}
export function genIcon(n: CanvasDocNode): string {
  if (n.kind === 'text') return 'doc'
  if (n.kind === 'entity') return 'users'
  if (n.kind !== 'gen') return 'alert'
  const spec = asGenSpec(n.spec)
  if (!spec) return 'alert'
  if (spec.edit) return 'brush'
  if (spec.genKind === 'video') return 'video'
  if (spec.genKind === 'audio') return 'speaker-wave'
  if (spec.genKind === 'compose') return 'film'
  if (spec.genKind === 'llm') return 'sparkles'
  return 'photo'
}
export function isAudio(n: CanvasDocNode): boolean {
  return asGenSpec(n.spec)?.genKind === 'audio'
}
export function isLlm(n: CanvasDocNode): boolean {
  return asGenSpec(n.spec)?.genKind === 'llm'
}
export function isTextAsset(n: CanvasDocNode): boolean {
  return n.asset?.kind === 'text'
}
export function specLine(n: CanvasDocNode): string {
  const spec = asGenSpec(n.spec)
  if (!spec) return n.specError ?? 'spec 缺失'
  if (spec.genKind === 'compose') {
    const parts = [
      spec.resolution,
      spec.fps != null ? `${spec.fps}fps` : null,
    ].filter(Boolean)
    return parts.length ? parts.join(' · ') : '（连线驱动合成）'
  }
  return spec.prompt || '（空 prompt）'
}
export function promptTitle(n: CanvasDocNode): string {
  return asGenSpec(n.spec)?.prompt ?? ''
}
export function textBody(n: CanvasDocNode): string {
  const s = n.spec
  return s && 'text' in s
    ? s.text || '（空文本）'
    : (n.specError ?? 'spec 缺失')
}
export function kindText(k: string): string {
  return ENTITY_KIND_TEXT[k] ?? k
}
export function thumbOf(n: CanvasDocNode): string | null {
  const a = n.asset
  if (!a || a.kind !== 'image') return null
  return a.urls.thumb ?? a.urls.file
}
export function entityThumb(n: CanvasDocNode): string | null {
  const a = n.entity?.asset
  if (!a || a.kind !== 'image') return null
  return a.urls.thumb ?? a.urls.file
}
export function metaText(n: CanvasDocNode): string {
  const t = n.latestTask
  if (!t) return ''
  if (t.status === 'succeeded' && t.completedAt)
    return fmtMs(t.completedAt - t.createdAt)
  if (t.status === 'failed' && t.attempts > 1) return `尝试 ${t.attempts}`
  return ''
}
