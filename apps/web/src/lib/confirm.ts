/**
 * 命令式确认弹窗 API（全局单例 + FIFO 队列）。
 *
 * 用法（替代浏览器原生 confirm）：
 *   const ok = await confirmDialog({ title: '删除角色', message: `确认删除「${name}」？`, danger: true })
 *   if (!ok) return
 *
 * 渲染由 ConfirmHost（App.vue 全局唯一挂载）桥接 ConfirmDialog 完成；
 * 用户确认 resolve(true)，取消 / 遮罩 / Esc / 关闭按钮 resolve(false)。
 */
import { reactive } from 'vue'

export interface ConfirmOptions {
  /** 弹窗标题 */
  title: string
  /** 正文文案（\n 换行，支持 pre-wrap） */
  message: string
  /** 确认按钮文案（默认「确认」） */
  confirmText?: string
  /** 取消按钮文案（默认「取消」） */
  cancelText?: string
  /** 危险操作：红色警示样式（删除类操作置 true） */
  danger?: boolean
}

interface ActiveConfirm {
  opts: ConfirmOptions
  resolve: (ok: boolean) => void
}

export const confirmState = reactive<{
  active: ActiveConfirm | null
  queue: ActiveConfirm[]
}>({ active: null, queue: [] })

/** 打开确认弹窗并等待用户决策；并发调用按 FIFO 排队，一次仅展示一个 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const item: ActiveConfirm = { opts, resolve }
    if (confirmState.active) confirmState.queue.push(item)
    else confirmState.active = item
  })
}

/** 关闭当前弹窗并决议；若有排队项则立即展示下一个 */
export function settleConfirm(ok: boolean) {
  const cur = confirmState.active
  if (!cur) return
  confirmState.active = confirmState.queue.shift() ?? null
  cur.resolve(ok)
}
