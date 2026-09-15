/**
 * [M28] 镜头工作台共用契约与纯函数（自 ShotBoard.vue 逐字迁移）
 * —— 迁移纪律：常量/函数体逐字保留，仅补 export 前缀供 board 子模块共用
 */
import type { ComposeTransition, RunStep, ShotBoardData } from '../../../lib/types'

// ---- 组件对外契约（自 ShotBoard.vue props/emit 定义迁移，字段与类型逐字）----
export interface ShotBoardProps { runId: number; projectId: number; step: RunStep; active: boolean }
export interface ShotBoardEmits { changed: []; compose: [info: ShotBoardData['compose']] }

/** emit 签名（与 defineEmits<ShotBoardEmits>() 返回结构一致；供状态 composable 参数注入） */
export type ShotBoardEmitFn = {
  <K extends keyof ShotBoardEmits>(event: K, ...args: ShotBoardEmits[K]): void
}

// [M11] 合成设置（转场 / 配乐；配置不触发执行，重新合成后生效）
export const TRANSITIONS: Array<{ value: ComposeTransition; label: string }> = [
  { value: 'none', label: '无（硬切）' },
  { value: 'fade', label: '淡入淡出' },
  { value: 'fadeblack', label: '黑场渐变' },
  { value: 'slideleft', label: '左滑' },
  { value: 'slideright', label: '右滑' },
  { value: 'dissolve', label: '溶解' },
]

/** 转场枚举防御（回显未知值降级 none） */
export function asTransition(v: unknown): ComposeTransition {
  return typeof v === 'string' && TRANSITIONS.some((o) => o.value === v) ? (v as ComposeTransition) : 'none'
}
