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
import { runApi } from './api/runs'
import type { ResumeConfigDrift, Run } from './types/base'

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

/** 同型号也可能改价或改协议；不把所有不可用原因误报成删除。 */
export function configDriftText(d: ResumeConfigDrift): string {
  const label = ({ audio: '语音', image: '图像', video: '视频', asr: '原声转写 ASR' } as Record<string, string>)[d.service] ?? d.service
  return `${label}：${d.from} → ${d.to ?? '当前无可用配置'}（配置 / 价格变化）`
}

/** 运行详情与画布共用：先读取最新风险，再确认；取消或切换目标不提交。 */
export async function confirmRunResume(id: number, isCurrent: () => boolean): Promise<{ run: Run } | null> {
  if (!isCurrent()) return null
  const detail = await runApi.detail(id)
  if (!isCurrent()) return null
  if (!['failed', 'cancelled'].includes(detail.run.status)) throw new Error('运行状态已变化，请更新状态后再操作。')
  const drift = detail.resumeConfigDrift ?? []
  if (drift.some((d) => d.to === null)) {
    throw new Error(`${drift.map(configDriftText).join('；')}。请先检查配置是否启用、协议是否合格及凭据是否可用，再重试。`)
  }
  const needVerify = detail.resumeNeedsVerification === true
  const notes = [`将从 run #${id} 新建续跑运行，复用已成功产物；后续制作可能产生费用。`]
  if (needVerify) notes.push(`${detail.ambiguousTaskIds?.length ?? 0} 个任务已提交但无回执，可能已被计费。请先在供应商侧核验失败；继续将重新提交，可能产生重复费用。`)
  if (drift.length) notes.push(`已批准配置已变化：${drift.map(configDriftText).join('；')}。继续将改用当前配置，模型、协议或价格可能与批准时不同。`)
  const ok = await confirmDialog({
    title: '断点续跑', message: notes.join('\n'),
    confirmText: needVerify && drift.length ? '已核验并接受当前配置' : needVerify ? '已核验，继续重发' : drift.length ? '接受改用当前配置' : '开始续跑',
  })
  if (!ok || !isCurrent()) return null
  const body: Record<string, unknown> = {}
  if (needVerify) body.confirm_ambiguous = true
  if (drift.length) body.accept_config_drift = true
  return runApi.resume(id, body)
}
