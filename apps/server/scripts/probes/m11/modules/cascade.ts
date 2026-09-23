/**
 * [M11·拆分] scripts/probe-m11.ts 的 rerun / cascade 两节（≤800 行红线拆分，断言逐字保留）。
 * 运行期服务在本模块内动态 import（入口已建立隔离环境），与拆分前 main() 内 import 时序等价。
 */
import { eq } from 'drizzle-orm'
import type { M11Ctx } from '../ctx'

export async function sectionRerun(ctx: M11Ctx): Promise<void> {
  const { WorkbenchError, resetStepForRerun } = await import('../../../../src/services/shot')
  const { seedRun, check, errOf, getTask, getStep, getRun, setStepStatus, setRunStatus } = ctx

  // ---- 复用模式（默认）：succeeded 任务不动、tasksReset = 非 succeeded 数 ----
  const s1 = await seedRun()
  const r1 = await resetStepForRerun(s1.runId, 'gen_images', {})
  check(
    r1.hasTasks && r1.tasksTotal === 2 && r1.tasksSucceeded === 1 && r1.tasksReset === 1,
    `复用模式计数（total=${r1.tasksTotal} succ=${r1.tasksSucceeded} reset=${r1.tasksReset}）`,
  )
  const t1r = await getTask(s1.t1)
  check(t1r.status === 'succeeded' && t1r.attempts === 3, '复用模式：succeeded 任务未动（status/attempts）')
  const t2r = await getTask(s1.t2)
  check(t2r.status === 'failed' && t2r.attempts === 2 && t2r.errorMsg === '生成失败', '复用模式：failed 任务未动（执行期幂等段归零）')
  const st1 = await getStep(s1.imgStepId)
  const ru1 = await getRun(s1.runId)
  check(st1.status === 'pending' && st1.error === null && st1.completedAt === null, 'step → pending（清 error/completedAt）')
  check(
    ru1.status === 'queued' && ru1.error === null && ru1.completedAt === null && ru1.currentStepKey === null,
    'run → queued（清 error/completedAt/currentStepKey）',
  )

  // ---- reset_tasks=true：全量归零 + resultAssetId 保留 ----
  const s2 = await seedRun()
  const r2 = await resetStepForRerun(s2.runId, 'gen_images', { resetTasks: true })
  check(r2.tasksTotal === 2 && r2.tasksSucceeded === 1 && r2.tasksReset === 2, `全量：tasksReset=total（${r2.tasksReset}）`)
  const t1r2 = await getTask(s2.t1)
  check(
    t1r2.status === 'pending' && t1r2.attempts === 0 && t1r2.completedAt === null && t1r2.errorMsg === null,
    '全量：succeeded 任务归零（pending/attempts/errorMsg/completedAt）',
  )
  check(t1r2.resultAssetId === s2.imgA, `全量：resultAssetId 保留（${t1r2.resultAssetId}）`)
  const t2r2 = await getTask(s2.t2)
  check(t2r2.status === 'pending' && t2r2.attempts === 0, '全量：failed 任务归零')

  // ---- 无任务步骤（ffmpeg_merge）：hasTasks=false 选项忽略 ----
  const s3 = await seedRun()
  const r3 = await resetStepForRerun(s3.runId, 'compose_video', {})
  check(!r3.hasTasks && r3.tasksTotal === 0 && r3.tasksReset === 0, '无任务步骤：hasTasks=false / tasksReset=0')
  const s4 = await seedRun()
  const r4 = await resetStepForRerun(s4.runId, 'compose_video', { resetTasks: true })
  check(!r4.hasTasks && r4.tasksReset === 0 && (await getRun(s4.runId)).status === 'queued', '无任务 + reset_tasks=true：不报错（选项忽略）')

  // ---- 校验拒绝矩阵 ----
  const s5 = await seedRun()
  const eNf = await errOf(() => resetStepForRerun(s5.runId, 'nope', {}))
  check(eNf instanceof WorkbenchError && eNf.code === 'not_found', '未知步骤 → not_found')
  const eSkip = await errOf(() => resetStepForRerun(s5.runId, 'subtitle', {}))
  check(eSkip instanceof WorkbenchError && eSkip.code === 'bad_step_status', 'skipped 目标 → bad_step_status')
  await setStepStatus(s5.voiceStepId, 'failed')
  const eOther = await errOf(() => resetStepForRerun(s5.runId, 'gen_images', {}))
  check(eOther instanceof WorkbenchError && eOther.code === 'other_failed', '存在其他失败步骤 → other_failed')
  await setStepStatus(s5.voiceStepId, 'succeeded')
  await setRunStatus(s5.runId, 'running')
  const eAct = await errOf(() => resetStepForRerun(s5.runId, 'gen_images', {}))
  check(eAct instanceof WorkbenchError && eAct.code === 'run_active', 'run running → run_active')
  await setRunStatus(s5.runId, 'queued')
  const eAct2 = await errOf(() => resetStepForRerun(s5.runId, 'gen_images', {}))
  check(eAct2 instanceof WorkbenchError && eAct2.code === 'run_active', 'run queued → run_active')
  await setRunStatus(s5.runId, 'cancelled')
  const eCan = await errOf(() => resetStepForRerun(s5.runId, 'gen_images', {}))
  check(eCan instanceof WorkbenchError && eCan.code === 'run_cancelled', 'run cancelled → run_cancelled')
  await setRunStatus(s5.runId, 'weird')
  const eBad = await errOf(() => resetStepForRerun(s5.runId, 'gen_images', {}))
  check(eBad instanceof WorkbenchError && eBad.code === 'bad_status', '未知 run 状态 → bad_status')
}

export async function sectionCascade(ctx: M11Ctx): Promise<void> {
  const { WorkbenchError, resetStepForRerun, describeChainRerun, resetChainForRerun } = await import('../../../../src/services/shot')
  const { pipelineRuns, pipelineSteps, genTasks } = await import('../../../../src/db/schema')
  const { db, pid, T0, check, errOf, getStep, getRun, getTask, setStepStatus, setRunStatus, mkStep } = ctx

  // 线性快照模板（无 after → 默认依赖前一步），与种子步骤键一一对应；templateForRun 采用快照
  const chainKeysList = ['make_storyboard', 'gen_images', 'voice', 'subtitle', 'compose_video']
  const actionOf = (k: string): string =>
    k === 'gen_images' ? 'ai_image' : k === 'voice' ? 'tts' : k === 'subtitle' ? 'subtitle' : k === 'compose_video' ? 'ffmpeg_merge' : 'ai_text'
  const snapOf = (key: string) => JSON.stringify({
    key,
    version: 1,
    name: 'cascade probe',
    genre: 'other',
    inputs: [],
    defaults: {},
    steps: chainKeysList.map((k) => ({ key: k, action: actionOf(k), title: k, inputs: {} })),
  })

  /**
   * 种子（用户真实卡点）：make_storyboard(succ) → gen_images(succ, t1 succ + t2 failed)
   * → voice(FAILED) → subtitle(pending) → compose_video(pending)；run=failed。
   * 单步重跑 gen_images 因 voice failed 被禁（other_failed）；级联则把 voice 及下游纳入重置集合→放行。
   */
  const seedChainRun = async (opts?: { templateKey?: string; status?: string }): Promise<{ runId: number; ms: number; gi: number; vo: number; sub: number; t1: number; t2: number; mst: number }> => {
    const templateKey = opts?.templateKey ?? 'probe-cascade'
    const status = opts?.status ?? 'failed'
    const runId = (
      await db
        .insert(pipelineRuns)
        .values({
          projectId: pid,
          templateKey,
          templateSnapshot: snapOf(templateKey),
          status,
          input: JSON.stringify({ episode_number: 1 }),
          currentStepKey: 'voice',
          createdAt: T0,
          updatedAt: T0,
        })
        .returning()
    )[0]!.id
    const ms = await mkStep(runId, 1, 'make_storyboard', 'ai_text')
    const gi = await mkStep(runId, 2, 'gen_images', 'ai_image')
    const vo = await mkStep(runId, 3, 'voice', 'tts', 'failed')
    const sub = await mkStep(runId, 4, 'subtitle', 'subtitle', 'pending')
    await mkStep(runId, 5, 'compose_video', 'ffmpeg_merge', 'pending')
    const mkT = async (stepId: number, status: string, params: Record<string, unknown>): Promise<number> =>
      (
        await db
          .insert(genTasks)
          .values({ projectId: pid, runId, stepId, kind: 'image', provider: 'probe', params: JSON.stringify(params), status, attempts: 1, createdAt: T0, updatedAt: T0 })
          .returning()
      )[0]!.id
    const t1 = await mkT(gi, 'succeeded', { shotId: 's01' })
    const t2 = await mkT(gi, 'failed', { shotId: 's02' })
    const mst = await mkT(ms, 'succeeded', {})
    await mkT(vo, 'failed', {})
    // 预置旧产物（级联清 output 断言）
    await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [999] }) }).where(eq(pipelineSteps.id, gi))
    await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [998] }) }).where(eq(pipelineSteps.id, vo))
    return { runId, ms, gi, vo, sub, t1, t2, mst }
  }

  // ---- A. 对比：单步重跑被禁、级联放行 ----
  const a = await seedChainRun()
  const eSingle = await errOf(() => resetStepForRerun(a.runId, 'gen_images', {}))
  check(eSingle instanceof WorkbenchError && eSingle.code === 'other_failed', 'A 单步重跑 gen_images（下游 voice failed）→ other_failed（现状死角）')
  const dA = await describeChainRerun(a.runId, 'gen_images', { resetTasks: true })
  const chainA = dA.chain.map((c) => c.stepKey)
  check(
    JSON.stringify(chainA) === JSON.stringify(['gen_images', 'voice', 'subtitle', 'compose_video']),
    `A 级联集合=目标+传递下游（实际 ${chainA.join('/')}）`,
  )
  check(!chainA.includes('make_storyboard'), 'A 上游 make_storyboard 不入级联集合')
  check(dA.chargedSteps === 2 && dA.totalTasksToRun === 5, `A 预览计数（charged=${dA.chargedSteps} totalToRun=${dA.totalTasksToRun}，gen_images2+voice1+subtitle1整体+compose1整体）`)
  const rA = await resetChainForRerun(a.runId, 'gen_images', { resetTasks: true })
  check(rA.chain.length === 4 && (await getRun(a.runId)).status === 'queued', 'A 执行：4 步入 pending、run → queued')
  const giA = await getStep(a.gi)
  const voA = await getStep(a.vo)
  check(giA.status === 'pending' && giA.output === null && voA.status === 'pending' && voA.output === null, 'A 级联步清 output 并置 pending')
  const t1A = await getTask(a.t1)
  const t2A = await getTask(a.t2)
  check(t1A.status === 'pending' && t2A.status === 'pending', 'A 目标步 reset_tasks=true：gen_images 全量任务归零')
  const msA = await getStep(a.ms)
  const mstA = await getTask(a.mst)
  check(msA.status === 'succeeded' && mstA.status === 'succeeded', 'A 防重复扣费：上游 make_storyboard 步骤/任务保持 succeeded 未动')

  // ---- B. 目标复用（resetTasks=false）：仅重置非 succeeded，下游仍全量 ----
  const b = await seedChainRun()
  const rB = await resetChainForRerun(b.runId, 'gen_images', { resetTasks: false })
  const giB = rB.chain.find((c) => c.isTarget)!
  const voB = rB.chain.find((c) => c.stepKey === 'voice')!
  check(giB.tasksToRun === 1 && giB.tasksTotal === 2, 'B 目标复用：gen_images tasksToRun=非succeeded数（1/2）')
  check(voB.tasksToRun === voB.tasksTotal && voB.tasksTotal === 1, 'B 下游 voice 一律全量重置（1/1）')
  const t1B = await getTask(b.t1)
  const t2B = await getTask(b.t2)
  check(t1B.status === 'succeeded' && t2B.status === 'pending', 'B 复用：succeeded 任务不动、failed 归零')

  // ---- C. 级联范围外 failed 拒绝：从 subtitle 起级联（voice failed 在上游、不在集合）----
  const cRun = await seedChainRun()
  await setStepStatus(cRun.sub, 'succeeded') // 使目标步合法（succeeded），专测范围外 failed 判定
  const eC = await errOf(() => describeChainRerun(cRun.runId, 'subtitle', { resetTasks: false }))
  check(eC instanceof WorkbenchError && eC.code === 'other_failed', 'C 级联范围外存在 failed（voice）→ other_failed')

  // ---- D. 上游未就绪拒绝：make_storyboard 非 failed 但 pending ----
  const dRun = await seedChainRun()
  await setStepStatus(dRun.ms, 'pending')
  await setStepStatus(dRun.vo, 'succeeded') // 消除 in-chain failed，使失败收敛不干扰，专测上游判定
  const eD = await errOf(() => describeChainRerun(dRun.runId, 'gen_images', { resetTasks: false }))
  check(eD instanceof WorkbenchError && eD.code === 'upstream_not_ready', 'D 上游 make_storyboard pending（非终态）→ upstream_not_ready')

  // ---- E. cancelled / running run 拒绝 + easy-video 守卫（仅 completed 拦、failed 放行）----
  const eRun = await seedChainRun()
  await setRunStatus(eRun.runId, 'cancelled')
  const eE = await errOf(() => describeChainRerun(eRun.runId, 'gen_images', {}))
  check(eE instanceof WorkbenchError && eE.code === 'run_cancelled', 'E cancelled run → run_cancelled（引导续跑）')
  // E2：easy-video + failed → 守卫放行（用户真实卡点场景），级联集合正常解析
  const evRun = await seedChainRun({ templateKey: 'easy-video' })
  const dEV = await describeChainRerun(evRun.runId, 'gen_images', { resetTasks: true })
  check(dEV.chain.length === 4 && dEV.chain[0]!.stepKey === 'gen_images', 'E2 easy-video+failed → 守卫放行，级联集合=目标+下游（4 步）')
  // E3：easy-video + completed → 额外生成，creation_confirmation_required 拦截
  const evcRun = await seedChainRun({ templateKey: 'easy-video', status: 'completed' })
  const eE3 = await errOf(() => describeChainRerun(evcRun.runId, 'gen_images', {}))
  check(eE3 instanceof WorkbenchError && eE3.code === 'creation_confirmation_required', 'E3 easy-video+completed → creation_confirmation_required（额外生成需重新确认）')
}
