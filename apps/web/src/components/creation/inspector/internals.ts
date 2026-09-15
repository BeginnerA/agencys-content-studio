/**
 * [M28] 创作画布检查器共用契约与纯函数（自 CreationInspector.vue 逐字迁移）
 * —— 迁移纪律：常量/函数体逐字保留，仅补 export 前缀供 inspector 子模块共用
 */
import type {
  AnyNodeSpec,
  CanvasAssetLite,
  CanvasDocEdge,
  CanvasDocNode,
  CanvasEditMode,
  ComposeTransition,
  CreationNodeSpec,
  EntityKind,
  TextNodeSpec,
} from '../../../lib/types'
import type { CanvasNodePatch } from '../../../lib/api'

// ---- 组件对外契约（自 CreationInspector.vue props/emit 定义迁移，字段与类型逐字）----
export interface InspectorProps {
  node: CanvasDocNode | null
  edge: CanvasDocEdge | null
  nodes: CanvasDocNode[]
  edges: CanvasDocEdge[]
  canvasId: number
  projectId: number
  /** [M17] 写命令回调（View 执行 + 入撤销栈；await 返回即已落库） */
  applyPatch: (p: { id: number; patch: CanvasNodePatch; label: string }) => Promise<void>
  applyRun: (p: { id: number; variants: number; savePatch?: CanvasNodePatch }) => Promise<void>
  applyExtract: (id: number) => Promise<void>
  applyDelete: () => Promise<void>
  applyRemoveEdge: (id: number) => Promise<void>
}

export interface InspectorEmits { refresh: []; clear: []; notice: [msg: string] }

/** emit 签名（与 defineEmits<InspectorEmits>() 返回结构一致；供状态 composable 参数注入） */
export type InspectorEmitFn = {
  <K extends keyof InspectorEmits>(event: K, ...args: InspectorEmits[K]): void
}

// ===== 通用文案 =====
export const TASK_TEXT: Record<string, string> = { pending: '等待', processing: '生成中', succeeded: '成功', failed: '失败', cancelled: '已取消' }
export const TASK_CLS: Record<string, string> = { pending: 'pending', processing: 'processing', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled' }
export const PORT_TEXT: Record<string, string> = { reference: '参考图', first_frame: '首帧', last_frame: '尾帧', source: '源图（编辑底图）' }
export const EDIT_MODE_TEXT: Record<CanvasEditMode, string> = { inpaint: '局部重绘', erase: '消除', outpaint: '扩图' }
/** [M18] 转场中文标签（TRANSITIONS 枚举，与服务端 / M11 ComposeConfig 同源） */
export const TRANSITION_OPTIONS: Array<{ value: ComposeTransition; label: string }> = [
  { value: 'none', label: '无（硬切）' },
  { value: 'fade', label: '淡入淡出' },
  { value: 'fadeblack', label: '渐黑过渡' },
  { value: 'slideleft', label: '左滑入' },
  { value: 'slideright', label: '右滑入' },
  { value: 'dissolve', label: '溶解' },
]
export const ENT_KIND_LABEL: Record<EntityKind, string> = { character: '角色', scene: '场景', prop: '道具' }
/** [M17] 实体类型文案（实体摘要 kind 为宽 string，兜底原值） */
export function entKindText(k: string): string {
  return ENT_KIND_LABEL[k as EntityKind] ?? k
}
/** [M17] run 节点状态映射（pipeline_runs.status） */
export const RUN_TEXT: Record<string, string> = { queued: '排队', running: '运行中', waiting_input: '待输入', completed: '完成', failed: '失败', cancelled: '已取消' }
export const RUN_CLS: Record<string, string> = { queued: 'pending', running: 'processing', waiting_input: 'pending', completed: 'succeeded', failed: 'failed', cancelled: 'cancelled' }
export const RUN_TERMINAL = new Set(['completed', 'failed', 'cancelled'])

export function stText(s: string | null): string {
  return s && s !== 'idle' ? (TASK_TEXT[s] ?? s) : ''
}
export function stCls(s: string | null): string | undefined {
  return s ? (TASK_CLS[s] ?? 'pending') : undefined
}
/** [M17] spec 类型守卫：是否 gen 规范（含 genKind；spec 已扩为 AnyNodeSpec 联合） */
export function asGenSpec(s: AnyNodeSpec | null | undefined): CreationNodeSpec | null {
  return s && typeof s === 'object' && 'genKind' in s ? (s as CreationNodeSpec) : null
}
/** [M17] spec 类型守卫：是否文本规范（含 text） */
export function asTextSpec(s: AnyNodeSpec | null | undefined): TextNodeSpec | null {
  return s && typeof s === 'object' && 'text' in s ? (s as TextNodeSpec) : null
}

/** [M17] 节点副标题文案（五型全覆盖） */
export function kindLabel(n: CanvasDocNode): string {
  switch (n.kind) {
    case 'asset': return '素材'
    case 'text': return '文本'
    case 'entity': return '实体'
    case 'run': return '运行'
    default: {
      const gk = asGenSpec(n.spec)?.genKind
      if (gk === 'video') return '视频生成'
      if (gk === 'audio') return '音频生成'
      if (gk === 'compose') return '音视频合成'
      if (gk === 'llm') return 'LLM 文本处理'
      return '图片生成'
    }
  }
}
export function nodeIcon(n: CanvasDocNode): string {
  if (n.kind === 'asset') return 'photo'
  if (n.kind === 'text') return 'doc'
  if (n.kind === 'entity') return 'users'
  if (n.kind === 'run') return 'play'
  const s = asGenSpec(n.spec)
  if (!s) return 'alert'
  if (s.edit) return 'brush'
  if (s.genKind === 'video') return 'video'
  if (s.genKind === 'audio') return 'speaker-wave'
  if (s.genKind === 'compose') return 'film'
  if (s.genKind === 'llm') return 'sparkles'
  return 'photo'
}
export function assetThumb(a: CanvasAssetLite | null): string | null {
  if (!a) return null
  return a.urls.thumb ?? (a.kind === 'image' ? a.urls.file : null)
}

