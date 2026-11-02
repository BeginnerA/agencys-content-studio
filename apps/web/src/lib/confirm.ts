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
import { continuityApi, freezeBody } from './api/continuity'
import { resumePlanOf, resumeRun, resumeTarget } from './continuity-entry'
import type { Acceptance } from './types/continuity'
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
  const label =
    (
      {
        audio: '语音',
        image: '图像',
        video: '视频',
        asr: '原声转写 ASR',
      } as Record<string, string>
    )[d.service] ?? d.service
  return `${label}：${d.from} → ${d.to ?? '当前无可用配置'}（配置 / 价格变化）`
}

/** 运行详情与画布共用：先读取最新风险，再确认；取消或切换目标不提交。 */
export async function confirmRunResume(
  id: number,
  isCurrent: () => boolean,
): Promise<{ run: Run } | null> {
  if (!isCurrent()) return null
  const detail = await runApi.detail(id)
  if (!isCurrent()) return null
  if (!['failed', 'cancelled'].includes(detail.run.status))
    throw new Error('运行状态已变化，请更新状态后再操作。')
  const drift = detail.resumeConfigDrift ?? []
  if (drift.some((d) => d.to === null)) {
    throw new Error(
      `${drift.map(configDriftText).join('；')}。请先检查配置是否启用、协议是否合格及凭据是否可用，再重试。`,
    )
  }
  const needVerify = detail.resumeNeedsVerification === true
  // M70：目标判定只认服务端预检（off=旧语义；inherit=免费复用；rerun=先冻新包）。
  const plan = resumePlanOf(detail)
  if (plan.kind === 'blocked') throw new Error(plan.reason)
  const kind = plan.kind
  const notes = [
    `将从 run #${id} 新建续跑运行，复用已成功产物；后续制作可能产生费用。`,
  ]
  if (kind === 'inherit')
    notes.push(
      '源运行已持久继承前集承接包：本次免费复用同一继承证据，不重新冻结。',
    )
  let preview: {
    doc: {
      previewHash: string
      gaps: Array<{ key: string; fingerprint: string; kind: string }>
    }
    canFreeze: boolean
    blockers: string[]
    unknownUseId: number | null
  } | null = null
  let acceptedGaps: Acceptance[] = []
  if (kind === 'rerun') {
    // 需重跑：先免费读目标（不建 run）；不可冻结/缺口/未知费用均在下方确认面明示。
    const res = await continuityApi.preview(detail.run.projectId, {
      target: resumeTarget(id),
      includePlans: false,
    })
    if (!isCurrent()) return null
    preview = res.preview
    if (!preview.canFreeze) {
      throw new Error(
        `该续跑需重新冻结承接包，但当前预览不可冻结：${preview.blockers.join('；') || '承接来源或范围不满足要求'}。请先在剧情台账补齐来源或修正剧集范围。`,
      )
    }
    if (preview.doc.gaps.length) {
      acceptedGaps = preview.doc.gaps.map((g) => ({
        key: g.key,
        fingerprint: g.fingerprint,
        reason: '断点续跑确认按缺口继续',
      }))
      notes.push(
        `承接存在 ${preview.doc.gaps.length} 处缺口（${preview.doc.gaps.map((g) => g.kind).join('、')}）：继续将按缺口继续执行，不会自动补齐。`,
      )
    }
    if (preview.unknownUseId !== null)
      notes.push(
        `未知费用遗留 #${preview.unknownUseId}：该笔消费可能已被计费，继续将重新提交并可能重复计费。`,
      )
    notes.push('本次续跑需重新冻结承接包（冻结免费，实际制作可能产生费用）。')
  }
  if (needVerify)
    notes.push(
      `${detail.ambiguousTaskIds?.length ?? 0} 个任务已提交但无回执，可能已被计费。请先在供应商侧核验失败；继续将重新提交，可能产生重复费用。`,
    )
  if (drift.length)
    notes.push(
      `已批准配置已变化：${drift.map(configDriftText).join('；')}。继续将改用当前配置，模型、协议或价格可能与批准时不同。`,
    )
  const ok = await confirmDialog({
    title: '断点续跑',
    message: notes.join('\n'),
    confirmText:
      needVerify && drift.length
        ? '已核验并接受当前配置'
        : needVerify
          ? '已核验，继续重发'
          : drift.length
            ? '接受改用当前配置'
            : '开始续跑',
  })
  if (!ok || !isCurrent()) return null
  const extra: Record<string, unknown> = {}
  if (needVerify) extra.confirm_ambiguous = true
  if (drift.length) extra.accept_config_drift = true
  let approval = null
  const unknownUseId = preview?.unknownUseId ?? null
  if (kind === 'rerun' && preview) {
    // 用户已在本确认面同意缺口与未知费用：冻新包，随后 resume 携批准 + 确切 useId 三键。
    const frozen = await continuityApi.freeze(
      detail.run.projectId,
      freezeBody({
        target: resumeTarget(id),
        includePlans: false,
        previewHash: preview.doc.previewHash,
        acceptedGaps,
        operationKey: `fz_resume_${id}_${preview.doc.previewHash.slice(0, 12)}`,
        ...(unknownUseId !== null
          ? { duplicateCostAcceptance: { useId: unknownUseId, accepted: true } }
          : {}),
      }),
    )
    if (!isCurrent()) return null
    approval = frozen.approval
  }
  const outcome = await resumeRun(
    { run: { resume: runApi.resume } },
    {
      runId: id,
      kind,
      approval,
      unknownUseId,
      acceptedDuplicateCost: unknownUseId !== null,
      acceptedUnknownUseId: unknownUseId,
      extra,
    },
  )
  if (!outcome.sent) throw new Error(outcome.message)
  return outcome.result as { run: Run }
}
