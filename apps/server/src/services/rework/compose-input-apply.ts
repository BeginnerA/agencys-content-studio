/**
 * 精确返修 · 合成输入本地返修：原子确认与本地续跑（切片2 规格 §5/§10）。
 *
 * 镜像字幕 applySubtitleRework 的「重验优先 + 条件领用 + 提交后启动」范式，但合成输入四类变更
 * 需在 run 仍 completed 时落真源（BGM/SFX helper 内含 requireEditableRun + 非 tx-aware 全局写、
 * 候选改选走 rebuildShotOutput），故采分层时序：
 *   预飞行重验（全只读，任何 mutate 之前）：新鲜能力/依赖指纹 + 重跑资产校验/语义编译复现同 previewHash
 *   → Phase-1 资产/选片变更（bindBgmFromAsset/removeBgm/bindSfxFromAsset/removeSfx + rebuildShotOutput，run 仍 completed）
 *   → Phase-2 末事务（原子领用 request ready→applied、_compose 并入 nextConfig、run→queued、
 *      compose step succeeded→pending 并作废旧 gate、resultJson 回执——条件更新任一落空整体回滚）
 *   → Phase-3 事务提交后 engine.startRun（不改引擎；queued 恢复路径兜底进程中断）。
 * 验收红线（规格 §10）：未确认不改任何状态（预飞行不过→零 mutate）；过期即 stale_preview 拒绝；
 * applied 回执顶层短路保重发幂等不二次入队；仅重置本地合成步、零 gen_task 新增/重置、零供应商调用。
 *
 * 并发诚实取舍：Phase-1 非幂等（换绑每次 insert+softDelete）且必须先于 run 翻 queued，故置于事务外。
 * 真并发双 apply 时两方各自 Phase-1 换绑后仅一方领用到 Phase-2，败方 Phase-1 换绑行残留为孤儿
 * （无害、软删可回溯、不泄漏进赢家 run 终态）。本地单机假设下 sequential，顶层 applied 短路覆盖重发。
 */
import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { pipelineRuns, pipelineSteps, reworkRequests, type ReworkRequest } from '../../db/schema'
import { engine } from '../../pipeline/engine'
import { hashJson } from '../creation-chat/contract'
import { bindBgmFromAsset, removeBgm, bindSfxFromAsset, removeSfx } from '../compose-config'
import { rebuildShotOutput } from '../shot/reset'
import { selectedMapOf, type ShotSpec } from '../shot/helpers'
import { assessComposeInputCapability } from './capability'
import { compileComposeInputChanges, type ComposeInputChange } from './compose-input'
import { validateAssetBindings, currentFromBaseline, type ComposeInputPreview, type ComposeInputSelection } from './compose-input-preview'
import { getReworkRequest } from './ledger'

export interface ComposeInputApplyReceipt {
  runId: number
  stepKey: string
  baseFingerprint: string
  previewHash: string
  /** 已重置步骤（恒仅本地合成步；候选改选换绑不重置生成步，保持 succeeded 令引擎跳过重生） */
  resetSteps: string[]
  /** 旧终审批 gate 是否作废（新版本必复审） */
  gateInvalidated: boolean
  /** 确认前后在用 BGM 资产 id（换绑记目标 assetId，非新注册行 id；无 BGM 变更则 from===to） */
  bgmFrom: number | null
  bgmTo: number | null
  /** 候选改选明细（在用旧值→新候选） */
  selections: Array<{ shotId: string; fromAssetId: number; toAssetId: number }>
  /** 镜头时长返修明细（切片2b）：shotId → 旧覆盖秒（null=无覆盖）→ 新覆盖秒；已增量合并进 _compose.shot_durations */
  durations: Array<{ shotId: string; fromSec: number | null; toSec: number }>
  /** 已入队标记（回执固定；真实执行由既有引擎/恢复路径推进） */
  enqueued: true
  appliedAt: number
}

export type ComposeInputApplyOutcome =
  | { outcome: 'applied' | 'replayed'; requestId: string; result: ComposeInputApplyReceipt }
  | { outcome: 'rejected'; requestId: string | null; code: string; message: string }

/** 事务内领用失败哨兵：回滚后按终态复查翻译为回放或确定性拒绝 */
class ClaimRejected extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ClaimRejected'
  }
}

function receiptOf(row: ReworkRequest): ComposeInputApplyReceipt | null {
  try {
    const r = JSON.parse(row.resultJson) as ComposeInputApplyReceipt
    if (
      typeof r.runId === 'number' && typeof r.stepKey === 'string' &&
      typeof r.baseFingerprint === 'string' && typeof r.previewHash === 'string' &&
      Array.isArray(r.resetSteps) && typeof r.gateInvalidated === 'boolean' &&
      (r.bgmFrom === null || typeof r.bgmFrom === 'number') &&
      (r.bgmTo === null || typeof r.bgmTo === 'number') &&
      Array.isArray(r.selections) && (r.durations === undefined || Array.isArray(r.durations)) && r.enqueued === true && typeof r.appliedAt === 'number'
    ) return r
    return null
  } catch {
    return null
  }
}

const stale = (requestId: string, message: string): ComposeInputApplyOutcome => ({
  outcome: 'rejected', requestId, code: 'stale_preview', message: `${message}，请重新预览确认后再提交`,
})

/**
 * 确认应用一个已就绪的合成输入返修预览（唯一写路径；四入口经 routes 层汇聚于此）。
 * requestId 定位台账行；previewHash 必须与服务端固定预览逐字一致（防确认后前端篡改/预览错位）。
 */
export async function applyComposeInputRework(p: { requestId: string; previewHash: string }): Promise<ComposeInputApplyOutcome> {
  let row: ReworkRequest
  try {
    row = await getReworkRequest(p.requestId)
  } catch {
    return { outcome: 'rejected', requestId: p.requestId, code: 'not_found', message: '返修请求不存在' }
  }
  // 先查已应用回执（早于任何漂移/busy 判定）：响应丢失重发返回第一次的结果，绝不二次推进
  if (row.state === 'applied') {
    const past = receiptOf(row)
    if (!past) return { outcome: 'rejected', requestId: row.id, code: 'corrupt_receipt', message: '已应用回执损坏，请人工核对合成输入后再操作' }
    return { outcome: 'replayed', requestId: row.id, result: past }
  }
  if (row.state !== 'ready') {
    return { outcome: 'rejected', requestId: row.id, code: 'not_ready', message: `请求当前状态为 ${row.state}，仅就绪预览可确认` }
  }
  let preview: ComposeInputPreview
  try {
    preview = JSON.parse(row.previewJson) as ComposeInputPreview
  } catch {
    return { outcome: 'rejected', requestId: row.id, code: 'corrupt_receipt', message: '预览回执损坏，请重新预览' }
  }
  if (preview.previewHash !== p.previewHash) {
    return stale(row.id, '确认携带的 previewHash 与服务端固定预览不一致')
  }

  /* 预飞行重验（全只读）：新鲜依赖指纹 + 重跑资产校验/语义编译，复现同 previewHash，否则 stale */
  const { capability, baseline } = await assessComposeInputCapability(row.runId, row.stepKey)
  if (!capability.supported || !baseline) return stale(row.id, capability.message)
  if (baseline.fingerprint !== row.baseFingerprint || baseline.fingerprint !== preview.baseFingerprint) {
    return stale(row.id, '依赖基准已变化（配置/换绑/选片/媒体或上游重跑）')
  }
  let changes: ComposeInputChange[]
  try {
    changes = JSON.parse(row.changesJson) as ComposeInputChange[]
  } catch {
    return stale(row.id, '台账变更载荷损坏')
  }
  const current = currentFromBaseline(baseline)
  const { errors: assetErrors, selections } = await validateAssetBindings({ changes, projectId: baseline.projectId, runId: baseline.runId, current })
  if (assetErrors.length > 0) return stale(row.id, assetErrors[0]?.message ?? '资产校验在当前基准失败')
  const compiled = compileComposeInputChanges({ changes, current })
  if (!compiled.ok) return stale(row.id, compiled.errors[0]?.message ?? '变更在当前基准上不可应用')
  const repreviewHash = hashJson({ f: baseline.fingerprint, c: compiled.normalized.changes })
  if (repreviewHash !== preview.previewHash) return stale(row.id, '当前基准重算的预览指纹与确认时不一致（基准已漂移）')

  const { nextConfig } = compiled.normalized
  // 时长返修明细（旧→新）：从 diff 取（仅记录实际改变者），与 nextConfig.shot_durations 增量合并一致
  const durations = compiled.normalized.diffs
    .filter((d) => d.kind === 'shot-duration')
    .map((d) => ({ shotId: d.field, fromSec: (d.before as number | null) ?? null, toSec: d.after as number }))
  const bgmChange = compiled.normalized.changes.find((c) => c.kind === 'bgm') as Extract<ComposeInputChange, { kind: 'bgm' }> | undefined
  const bgmFrom = baseline.bgm.assetId
  const bgmTo = bgmChange ? bgmChange.assetId : baseline.bgm.assetId

  /* Phase-1：资产/选片变更落真源（run 仍 completed——helper 内含 requireEditableRun + 非 tx-aware 全局写，
     必须先于 run 翻 queued）。registerAsset 纯 db.insert 不读盘；rebuildShotOutput 仅重写生成步 output。 */
  try {
    for (const c of compiled.normalized.changes) {
      if (c.kind === 'bgm') {
        if (c.assetId === null) await removeBgm(row.runId)
        else await bindBgmFromAsset(row.runId, c.assetId)
      } else if (c.kind === 'sfx') {
        if (c.assetId === null) await removeSfx(row.runId, c.shotId)
        else await bindSfxFromAsset(row.runId, c.shotId, c.assetId)
      }
    }
    for (const sel of selections) {
      await applyShotSelection(sel)
    }
  } catch (err) {
    // Phase-1 失败：request 尚未领用、run/step 状态未动；bind* 内部 softDelete+insert 保单次换绑原子
    return { outcome: 'rejected', requestId: row.id, code: 'storage_failed', message: `合成输入资产变更失败：${(err as Error).message}` }
  }

  /* Phase-2：末事务原子领用——request ready→applied、_compose 并入 nextConfig、run→queued、
     compose step succeeded→pending 作废旧 gate、resultJson 回执；任一条件更新落空整体回滚。 */
  let receipt: ComposeInputApplyReceipt
  try {
    receipt = await db.transaction(async (tx) => {
      const claimed = await tx
        .update(reworkRequests)
        .set({ state: 'applied', updatedAt: Date.now() })
        .where(and(eq(reworkRequests.id, row.id), eq(reworkRequests.state, 'ready')))
        .returning()
      if (!claimed.length) throw new ClaimRejected('already_claimed', '请求已被并发处理')
      const runRows = await tx.select().from(pipelineRuns).where(eq(pipelineRuns.id, row.runId)).limit(1)
      const run = runRows[0]
      if (!run) throw new ClaimRejected('stale_run', '运行已不存在')
      if (run.status !== 'completed' && run.status !== 'failed') {
        throw new ClaimRejected('run_active', `运行状态为 ${run.status}，等待收敛后再确认`)
      }
      let inputObj: Record<string, unknown>
      try {
        inputObj = JSON.parse(run.input) as Record<string, unknown>
      } catch {
        throw new ClaimRejected('bad_input', 'run.input 不是合法 JSON，无法写入合成配置')
      }
      // 配置并入真源 _compose（用 compile 的 nextConfig，不重抄 clamp；无 config 变更则不触碰 _compose）
      if (nextConfig) inputObj._compose = nextConfig
      const stepRows = await tx.select().from(pipelineSteps).where(eq(pipelineSteps.id, baseline.stepId)).limit(1)
      const step = stepRows[0]
      if (!step || step.status !== 'succeeded') throw new ClaimRejected('stale_step', '合成步骤状态已变化，请重新预览确认')
      // run：写 _compose + 入队（条件领用旧状态，半途被人改则整体回滚）
      const now = Date.now()
      const moved = await tx
        .update(pipelineRuns)
        .set({ input: JSON.stringify(inputObj), status: 'queued', error: null, completedAt: null, currentStepKey: null, updatedAt: now })
        .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.status, run.status)))
        .returning()
      if (!moved.length) throw new ClaimRejected('stale_run', '运行状态在确认瞬间变化，已整体回滚')
      // compose step：仅重置已确认本地合成步；旧 gate 批准删除作废（新版本必复审），历史 asset_ids 保留
      let out: Record<string, unknown> = {}
      try {
        out = JSON.parse(step.output ?? '{}') as Record<string, unknown>
      } catch {
        /* 损坏 output 按无 gate 处理：重置时整体留原 output 不动 */
      }
      const hasGate = 'gate' in out
      const stepPatch: Record<string, unknown> = { status: 'pending', error: null, completedAt: null, updatedAt: now }
      if (hasGate) {
        const { gate: _void, ...rest } = out
        stepPatch.output = JSON.stringify(rest)
      }
      const stepMoved = await tx
        .update(pipelineSteps)
        .set(stepPatch)
        .where(and(eq(pipelineSteps.id, step.id), eq(pipelineSteps.status, 'succeeded')))
        .returning()
      if (!stepMoved.length) throw new ClaimRejected('stale_step', '合成步骤状态在确认瞬间变化，已整体回滚')
      const rc: ComposeInputApplyReceipt = {
        runId: run.id,
        stepKey: row.stepKey,
        baseFingerprint: baseline.fingerprint,
        previewHash: preview.previewHash,
        resetSteps: [row.stepKey],
        gateInvalidated: hasGate,
        bgmFrom,
        bgmTo,
        selections: selections.map((s) => ({ shotId: s.shotId, fromAssetId: s.fromAssetId, toAssetId: s.toAssetId })),
        durations,
        enqueued: true,
        appliedAt: now,
      }
      await tx.update(reworkRequests).set({ resultJson: JSON.stringify(rc), updatedAt: Date.now() }).where(eq(reworkRequests.id, row.id))
      return rc
    })
  } catch (err) {
    if (err instanceof ClaimRejected) {
      // 落锤失败方复查终态：赢家已完整提交则回放其回执（等价响应丢失重发）；否则透出真实原因
      const after = await getReworkRequest(row.id)
      if (after.state === 'applied') {
        const past = receiptOf(after)
        if (past) return { outcome: 'replayed', requestId: after.id, result: past }
      }
      return { outcome: 'rejected', requestId: row.id, code: err.code === 'already_claimed' ? 'conflict' : err.code, message: err.message }
    }
    throw err
  }

  // Phase-3：事务提交后才启动现有引擎（不改引擎；queued 恢复路径兜底进程中断）
  engine.startRun(row.runId)
  return { outcome: 'applied', requestId: row.id, result: receipt }
}

/**
 * 候选改选落真源：按产出步当前「在用映射」重建 asset_ids，仅把目标镜换成新候选（同步骤同类由校验期保证）。
 * 免分镜免磁盘——镜头序列隐式取自该步 output 的在用 shotId 映射（selectedMapOf），不触 gen_task、不改生成步状态，
 * 引擎重合成时 succeeded 生成步自动跳过 → 零重生、零付费。多条同镜改选按序重取 step 累积生效。
 */
async function applyShotSelection(sel: ComposeInputSelection): Promise<void> {
  const rows = await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, sel.stepId)).limit(1)
  const step = rows[0]
  if (!step) throw new Error(`候选改选产出步 ${sel.stepKey} 已不存在`)
  const { selected } = await selectedMapOf(step)
  const shots: ShotSpec[] = Array.from(selected.keys()).map((id) => ({ id }))
  await rebuildShotOutput(step, shots, { shotId: sel.shotId, assetId: sel.toAssetId })
}
