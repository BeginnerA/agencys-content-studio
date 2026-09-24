import { Hono } from 'hono'
import { and, asc, desc, eq, inArray, isNull, ne, notInArray } from 'drizzle-orm'
import { db } from '../db'
import { genTasks, pipelineRuns, pipelineSteps, projects, assets, creationSessions } from '../db/schema'
import { engine, recoverInterruptedState, refreshGlobalConcurrency } from '../pipeline/engine'
import { templateForRun } from '../pipeline/loader'
import { createRunRow, InvalidRunInputError } from '../services/run-create'
import { checkBudget } from '../services/budget'
import { randomUUID } from 'node:crypto'
import { isAmbiguousSubmitted, isCreationTemplate } from '../services/creation-chat/recipe'
import { retryCreation } from '../services/creation-chat/execution'
import { CreationError } from '../services/creation-chat/contract'
import { PARAM_GROUPS, readRunParams, validateRunParams } from '../services/run-params'
import { existsSync, openSync, closeSync, fstatSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { RUN_LOGS_DIR } from '../env'
import { HttpError, h, idParam, notFound, wb } from './helpers'
import { resetStepForRerun, describeChainRerun, resetChainForRerun } from '../services/shot'
import { mapRunToEpisode } from '../services/series'

export const runsRoutes = new Hono()

// GET /runs —— 运行列表（?project_id=&status=）
runsRoutes.get('/runs', h(async (c) => {
  const conds = []
  const projectId = c.req.query('project_id')
  if (projectId) conds.push(eq(pipelineRuns.projectId, Number(projectId)))
  const status = c.req.query('status')
  if (status) conds.push(eq(pipelineRuns.status, status))
  const rows = await db
    .select()
    .from(pipelineRuns)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(pipelineRuns.createdAt))
    .limit(100)
  return c.json({ items: rows.map(toRunView) })
}))

// POST /projects/:id/runs —— 启动 run（校验模板输入 → 快照 → engine 异步执行）
runsRoutes.post('/projects/:id/runs', h(async (c) => {
  const projectId = idParam(c)
  const projRows = await db.select().from(projects).where(and(eq(projects.id, projectId), isNull(projects.deletedAt))).limit(1)
  const project = projRows[0]
  if (!project) return notFound(c, `项目 ${projectId}`)
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const templateKey = typeof body['template_key'] === 'string' ? body['template_key'] : project.templateKey
  const input = body['input']
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'bad_input', 'input 需为对象（brief 文本 / setting_docs 资产 id 数组 / episode_number 整数）')
  }
  let run
  // [F06] 预算闸门：与 creation-chat / workflow advance 同源，超阈即拦截（避免普通运行入口绕过熔断）
  const budgetHit = await checkBudget({ projectId })
  if (budgetHit) throw new HttpError(409, budgetHit.code, budgetHit.message)
  try {
    run = await createRunRow({ projectId, templateKey, input: input as Record<string, unknown> })
  } catch (err) {
    if (err instanceof InvalidRunInputError) throw new HttpError(400, err.code, err.message)
    throw err
  }
  engine.startRun(run.id)
  // [M14] 剧集联动（后置回写 latest_run_id；宽容降级：无剧/无集/失败均不影响 run）
  await linkEpisode(projectId, run.input, run.id)
  return c.json({ run: toRunView(run) }, 202)
}))

// GET /runs/:id —— 运行详情（run + steps 全部字段 + 解析）
runsRoutes.get('/runs/:id', h(async (c) => {
  const run = await findRun(idParam(c))
  if (!run) return notFound(c, `run ${c.req.param('id')}`)
  const steps = await db
    .select()
    .from(pipelineSteps)
    .where(eq(pipelineSteps.runId, run.id))
    .orderBy(asc(pipelineSteps.seq))
  // [恢复收口] 反查归属轻松创作会话（creation_sessions.run_id 单向持有；同 run 多会话取最新一条），
  // 专业端据此把「断点续跑/任务重试」死路换成直达会话的恢复入口
  const sessionRows = await db
    .select({ id: creationSessions.id })
    .from(creationSessions)
    .where(eq(creationSessions.runId, run.id))
    .orderBy(desc(creationSessions.id))
    .limit(1)
  const creationSessionId = sessionRows[0]?.id ?? null
  // [方案C] 专业端「断点续跑」能否就地恢复：轻松创作 run 若存在「受理状态不明」任务（可能已计费），
  // retryCreation 会拒 needs_verification → 前端改呈现直达会话核验链接；否则放行就地续跑。
  const ambiguousTaskIds: number[] = []
  if (isCreationTemplate(run.templateKey) && ['failed', 'cancelled'].includes(run.status)) {
    const tRows = await db
      .select({ id: genTasks.id, status: genTasks.status, attempts: genTasks.attempts, taskId: genTasks.taskId, resultAssetId: genTasks.resultAssetId })
      .from(genTasks)
      .where(eq(genTasks.runId, run.id))
    for (const t of tRows) if (isAmbiguousSubmitted(t)) ambiguousTaskIds.push(t.id)
  }
  const resumeNeedsVerification = ambiguousTaskIds.length > 0
  return c.json({
    run: toRunView(run),
    creationSessionId,
    resumeNeedsVerification,
    ambiguousTaskIds,
    steps: steps.map((s) => ({
      id: s.id,
      seq: s.seq,
      stepKey: s.stepKey,
      actionKey: s.actionKey,
      title: s.title,
      status: s.status,
      attempts: s.attempts,
      input: safeParse(s.input),
      output: safeParse(s.output),
      error: s.error,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
    })),
  })
}))

// GET /runs/:id/log —— 运行日志尾部（?tail= 行数，默认 300，clamp 1..2000；返回 {log}）
// 大文件仅读尾部 512KB，避免全量读盘
runsRoutes.get('/runs/:id/log', h(async (c) => {
  const run = await findRun(idParam(c))
  if (!run) return notFound(c, `run ${c.req.param('id')}`)
  const tailNum = Number(c.req.query('tail'))
  const tail = Number.isFinite(tailNum) && tailNum > 0 ? Math.min(Math.floor(tailNum), 2000) : 300
  const logFile = join(RUN_LOGS_DIR, `${run.id}.log`)
  if (!existsSync(logFile)) return c.json({ log: '' })
  const lines = readTailLines(logFile, tail)
  return c.json({ log: lines.join('\n') })
}))

// POST /runs/:id/gate —— 闸门决策 {step_key, decision: approve|reject|skip, note?, text_override?}
// skip 仅当模板该步骤 gate 声明了 skip_label 时允许（免审放行，产物保留）
runsRoutes.post('/runs/:id/gate', h(async (c) => {
  const runId = idParam(c)
  const run = await findRun(runId)
  if (!run) return notFound(c, `run ${runId}`)
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const stepKey = body['step_key']
  const decision = body['decision']
  if (typeof stepKey !== 'string' || !stepKey) throw new HttpError(400, 'bad_step_key', 'step_key 必填')
  const note = typeof body['note'] === 'string' ? body['note'] : undefined
  const textOverride = typeof body['text_override'] === 'string' ? body['text_override'] : undefined
  if (decision === 'approve') {
    await engine.approveGate(runId, stepKey, { note, textOverride })
  } else if (decision === 'reject') {
    await engine.rejectGate(runId, stepKey, { note })
  } else if (decision === 'skip') {
    // skip 需模板声明 skip_label（免审语义是模板作者显式授权的）
    const tpl = templateForRun(run)
    const def = tpl.steps.find((s) => s.key === stepKey)
    if (!def?.gate?.skip_label) {
      throw new HttpError(400, 'bad_skip', `步骤 ${stepKey} 的 gate 未声明 skip_label，不允许跳过`)
    }
    await engine.skipGate(runId, stepKey, { note })
  } else {
    throw new HttpError(400, 'bad_decision', 'decision 需为 approve|reject|skip')
  }
  const fresh = await findRun(runId)
  return c.json({ run: toRunView(fresh!) })
}))

// POST /runs/:id/cancel —— 取消（幂等）
runsRoutes.post('/runs/:id/cancel', h(async (c) => {
  const runId = idParam(c)
  const run = await findRun(runId)
  if (!run) return notFound(c, `run ${runId}`)
  await engine.cancelRun(runId)
  const fresh = await findRun(runId)
  return c.json({ run: toRunView(fresh!) })
}))

// POST /runs/:id/resume —— 断点续跑：failed(interrupted)/cancelled → 新 run 复制（succeeded 步骤标记跳过）
runsRoutes.post('/runs/:id/resume', h(async (c) => {
  const runId = idParam(c)
  const src = await findRun(runId)
  if (!src) return notFound(c, `run ${runId}`)
  // [方案C] 轻松创作批准链 run：不在专业端走朴素 generic resume（其迁移会把已拿到外部 taskId 的在途任务归零重投=重复计费风险），
  // 而委派会话恢复真源 retryCreation（verified 列表留空：有 taskId 者仅恢复查询、有产物者复用缓存、仅拦「受理状态不明」）。
  // 存在受理状态不明任务时 retryCreation 抛 needs_verification(409) → 引导回会话核验；无则就地安全续跑并返回新 run。
  if (isCreationTemplate(src.templateKey)) {
    const sess = await db
      .select()
      .from(creationSessions)
      .where(eq(creationSessions.runId, runId))
      .orderBy(desc(creationSessions.id))
      .limit(1)
    const s = sess[0]
    if (!s) {
      throw new HttpError(409, 'creation_confirmation_required', '该运行由轻松创作发起，请在轻松创作中核验并恢复，避免重复计费')
    }
    try {
      const { runId: newRunId } = await retryCreation(s.id, {
        runId,
        planHash: s.planHash,
        planRevision: s.planRevision,
        idempotencyKey: randomUUID(),
        verifiedFailedTaskIds: [],
      })
      const newRun = await findRun(newRunId)
      if (!newRun) throw new HttpError(500, 'resume_failed', '续跑已提交但新 run 未生成，请到轻松创作会话中查看')
      return c.json({ run: toRunView(newRun) }, 202)
    } catch (e) {
      if (e instanceof CreationError) throw new HttpError(e.status, e.code, e.message)
      // retryCreation 的停机型普通 Error（已批准模板/方案/资产/项目漂移、assertRecipeSources 抛错）：
      // 专业端无法处理，一律归为「须回会话核验」409（不泄漏成 400 bad_request），与 needs_verification 同类引导
      throw new HttpError(409, 'creation_confirmation_required', `该轻松创作 run 无法就地续跑（${e instanceof Error ? e.message : String(e)}），请回到轻松创作会话处理`)
    }
  }
  if (!['failed', 'cancelled'].includes(src.status)) {
    throw new HttpError(400, 'bad_status', `仅 failed/cancelled 可续跑（当前 ${src.status}）；如需重跑请直接新建 run`)
  }
  // [审计G2] resume 去重：同一源 run 只允许存在一个进行中的派生 run——gen_tasks 已整体迁移到
  // 首个派生 run，第二个派生 run 重跑付费步骤会全量重新提交（二次扣费）；派生均已终态则允许再次续跑
  // [审计G4] 闸门复查刷新全局上限：startRun 同步读缓存，陈旧缓存会把本应 defer 的 run 拉起真实执行链
  await refreshGlobalConcurrency()
  const activeResume = await db
    .select({ id: pipelineRuns.id })
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.resumedFromRunId, runId), notInArray(pipelineRuns.status, ['completed', 'failed', 'cancelled'])))
    .limit(1)
  if (activeResume.length) {
    throw new HttpError(409, 'already_resumed', `该 run 已有进行中的续跑派生 run（#${activeResume[0]!.id}），请等待其结束或先取消，避免重复计费`)
  }
  // [审计G3] 预算闸门：resume 创建新 run 并重新提交失败步骤 = 新付费承诺，与 POST /projects/:id/runs 同源拦截
  const budgetHit = await checkBudget({ projectId: src.projectId })
  if (budgetHit) throw new HttpError(409, budgetHit.code, budgetHit.message)
  const t = Date.now()
  // [审计G4] 新 run + 步骤复制 + gen_tasks 迁移单事务原子落库（中途崩溃不留缺步孤儿 run；创作线事务先例同源）
  const newRun = await db.transaction(async (tx) => {
    const run = (
      await tx
        .insert(pipelineRuns)
        .values({
          projectId: src.projectId,
          templateKey: src.templateKey,
          status: 'queued',
          input: src.input,
          // 续跑继承源 run 模板快照（断点续跑语义与源 run 一致）
          templateSnapshot: src.templateSnapshot,
          resumedFromRunId: src.id,
          createdAt: t,
          updatedAt: t,
        })
        .returning()
    )[0]!
    const steps = await tx
      .select()
      .from(pipelineSteps)
      .where(eq(pipelineSteps.runId, src.id))
      .orderBy(asc(pipelineSteps.seq))
    for (const s of steps) {
      // 断点续跑：succeeded/skipped（含免审放行痕迹）保留终态直接跳过；其余重置 pending 续跑
      const keep = s.status === 'succeeded' || s.status === 'skipped'
      const newStep = (
        await tx
          .insert(pipelineSteps)
          .values({
            runId: run.id,
            seq: s.seq,
            stepKey: s.stepKey,
            actionKey: s.actionKey,
            title: s.title,
            status: keep ? s.status : 'pending',
            input: keep ? s.input : null,
            output: keep ? s.output : null,
            attempts: keep ? s.attempts : 0,
            createdAt: t,
            updatedAt: t,
          })
          .returning()
      )[0]!
      // 断点续跑幂等：把旧 run 待重跑步骤的 gen_task 迁移到新 step——终态步骤保留产物
      // 引用（ai_image 等按 stepId 幂等复用成功图），failed/cancelled/pending 归零重置续跑
      if (!keep) {
        await tx
          .update(genTasks)
          .set({ runId: run.id, stepId: newStep.id, status: 'pending', attempts: 0, errorMsg: null, updatedAt: t })
          .where(and(eq(genTasks.runId, src.id), eq(genTasks.stepId, s.id), ne(genTasks.status, 'succeeded')))
      }
      await tx
        .update(genTasks)
        .set({ runId: run.id, stepId: newStep.id, updatedAt: t })
        .where(and(eq(genTasks.runId, src.id), eq(genTasks.stepId, s.id), eq(genTasks.status, 'succeeded')))
    }
    return run
  })
  engine.startRun(newRun.id)
  // [M14] 续跑同款联动（latest_run_id 指向本集最新 run）
  await linkEpisode(newRun.projectId, newRun.input, newRun.id)
  return c.json({ run: toRunView(newRun) }, 202)
}))

// POST /runs/:id/steps/:stepKey/rerun —— [M11] 引擎级单步重跑（复用/重置该步子任务；succeeded 步骤全跳过）
runsRoutes.post('/runs/:id/steps/:stepKey/rerun', h(async (c) => {
  const runId = idParam(c)
  const stepKey = c.req.param('stepKey')
  if (!stepKey) throw new HttpError(400, 'bad_step_key', 'stepKey 路径参数缺失')
  let body: Record<string, unknown> = {}
  const raw = await c.req.text()
  if (raw.trim()) {
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
    }
  }
  const resetTasks = body['reset_tasks'] === true
  const result = await wb(() => resetStepForRerun(runId, stepKey, { resetTasks }))
  engine.startRun(runId)
  const note = !result.hasTasks
    ? `已重置「${result.stepKey}」并重新入队（该步骤无子任务，将整体重新执行；下游产物不变，如需生效请重跑下游或重新合成）`
    : resetTasks
      ? `已重置「${result.stepKey}」及全部 ${result.tasksTotal} 个子任务并重新入队（将全量重新执行）`
      : `已重置「${result.stepKey}」并重新入队；成功子任务将复用（${result.tasksSucceeded} 个），预计执行 ${result.tasksReset} 个`
  return c.json({
    ok: true,
    run_id: runId,
    step_key: result.stepKey,
    has_tasks: result.hasTasks,
    tasks_total: result.tasksTotal,
    tasks_succeeded: result.tasksSucceeded,
    note,
  })
}))

// GET /runs/:id/steps/:stepKey/rerun-cascade —— 级联重跑预览（只读：级联步骤清单 + 预估计费子任务数；?reset_tasks=1 影响目标步复用/全量口径）
runsRoutes.get('/runs/:id/steps/:stepKey/rerun-cascade', h(async (c) => {
  const runId = idParam(c)
  const stepKey = c.req.param('stepKey')
  if (!stepKey) throw new HttpError(400, 'bad_step_key', 'stepKey 路径参数缺失')
  const resetTasks = c.req.query('reset_tasks') === '1' || c.req.query('reset_tasks') === 'true'
  const view = await wb(() => describeChainRerun(runId, stepKey, { resetTasks }))
  return c.json({ ...view, run_id: view.runId, step_key: view.stepKey })
}))

// POST /runs/:id/steps/:stepKey/rerun-cascade —— 级联重跑（从该步起重跑到末尾：目标步尊重 reset_tasks，下游一律全量重置后 startRun）
runsRoutes.post('/runs/:id/steps/:stepKey/rerun-cascade', h(async (c) => {
  const runId = idParam(c)
  const stepKey = c.req.param('stepKey')
  if (!stepKey) throw new HttpError(400, 'bad_step_key', 'stepKey 路径参数缺失')
  let body: Record<string, unknown> = {}
  const raw = await c.req.text()
  if (raw.trim()) {
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
    }
  }
  const resetTasks = body['reset_tasks'] === true
  const result = await wb(() => resetChainForRerun(runId, stepKey, { resetTasks }))
  engine.startRun(runId)
  return c.json({
    ok: true,
    run_id: result.runId,
    step_key: result.stepKey,
    chain: result.chain,
    total_tasks_to_run: result.totalTasksToRun,
    charged_steps: result.chargedSteps,
    note: result.note,
  }, 202)
}))

// GET /runs/:id/steps/:stepKey/revisions —— [M21] 步骤文本产物版本链（倒序 + current 标记）
// 数据源：同 run 同 step 的 kind='text' 未删资产行（每次文本写入/reject 重跑/text_override 定稿各产生一版）
runsRoutes.get('/runs/:id/steps/:stepKey/revisions', h(async (c) => {
  const runId = idParam(c)
  const stepKey = c.req.param('stepKey')
  if (!stepKey) throw new HttpError(400, 'bad_step_key', 'stepKey 路径参数缺失')
  const run = await findRun(runId)
  if (!run) return notFound(c, `run ${runId}`)
  const stepRows = await db
    .select()
    .from(pipelineSteps)
    .where(and(eq(pipelineSteps.runId, runId), eq(pipelineSteps.stepKey, stepKey)))
    .limit(1)
  const step = stepRows[0]
  if (!step) return notFound(c, `步骤 ${stepKey}`)
  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.runId, runId), eq(assets.stepId, step.id), eq(assets.kind, 'text'), isNull(assets.deletedAt)))
    .orderBy(desc(assets.createdAt), desc(assets.id))
  // current = 步骤当前产物（output.asset_ids[0]）；无文本产物 → 空列表（非 404）
  const output = safeParse(step.output) as { asset_ids?: number[] } | null
  const currentId = output?.asset_ids?.[0]
  return c.json({
    items: rows.map((a) => ({ assetId: a.id, name: a.name, createdAt: a.createdAt, current: a.id === currentId })),
  })
}))

// PATCH /runs/:id/params —— [M21] 集级参数热调（受限 + 留痕）
// 状态门：queued|running|waiting_input；组内字段级深合并（改 image.model 不影响既有 image.size）；不可删键
// 生效：未执行步骤经 createStepContext 每步重读 run.input（已开始步骤与 in-flight 任务不受影响）
// 留痕：run.input._params_log 追加 { at, changes:[{group,key,from,to}], source:'user' }
runsRoutes.patch('/runs/:id/params', h(async (c) => {
  const runId = idParam(c)
  const run = await findRun(runId)
  if (!run) return notFound(c, `run ${runId}`)
  if (!['queued', 'running', 'waiting_input'].includes(run.status)) {
    throw new HttpError(409, 'run_settled', `run 已终态（${run.status}）：参数热调仅限排队/运行/等待审阅中的 run`)
  }
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const { params, errors } = validateRunParams(body['params'])
  if (errors.length > 0) throw new HttpError(400, 'bad_params', errors.join('；'))
  // 组内字段级深合并 + 变更清单（仅实际变化键入 changes；无变化 → 幂等返回，不写留痕）
  const root = safeParse(run.input)
  const input = (root && typeof root === 'object' && !Array.isArray(root) ? { ...(root as Record<string, unknown>) } : {}) as Record<string, unknown>
  const oldParams = readRunParams(run.input)
  const merged: Record<string, Record<string, unknown>> = {}
  for (const g of PARAM_GROUPS) {
    const old = oldParams[g]
    if (old && Object.keys(old).length) merged[g] = { ...old }
  }
  const changes: Array<{ group: string; key: string; from: unknown; to: unknown }> = []
  for (const [g, fields] of Object.entries(params)) {
    const group = (merged[g] ??= {})
    for (const [k, v] of Object.entries(fields ?? {})) {
      if (group[k] === v) continue
      changes.push({ group: g, key: k, from: group[k] ?? null, to: v })
      group[k] = v
    }
  }
  if (changes.length === 0) return c.json({ run: toRunView(run), applied: [] })
  const plog = Array.isArray(input['_params_log']) ? [...(input['_params_log'] as unknown[])] : []
  plog.push({ at: Date.now(), changes, source: 'user' })
  input['_params'] = merged
  input['_params_log'] = plog
  // [M21 评审修复] 条件写：仅当仍处可热调状态才落库（闭合前置检查与写入之间的终态竞态窗口）
  const upd = await db
    .update(pipelineRuns)
    .set({ input: JSON.stringify(input), updatedAt: Date.now() })
    .where(and(eq(pipelineRuns.id, runId), inArray(pipelineRuns.status, ['queued', 'running', 'waiting_input'])))
  if (upd.rowsAffected === 0) throw new HttpError(409, 'run_settled', 'run 已终态：本次参数未写入（与终态并发）')
  const fresh = await findRun(runId)
  return c.json({ run: toRunView(fresh!), applied: changes })
}))

// POST /system/recover —— 手动触发崩溃恢复（幂等；诊断用）
runsRoutes.post('/system/recover', h(async (c) => {
  const { requeued } = await recoverInterruptedState()
  await Promise.allSettled(requeued.map((id) => engine.startRun(id)))
  return c.json({ ok: true, requeued })
}))

async function findRun(id: number) {
  const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)).limit(1)
  return rows[0] ?? null
}

/** [M14] 剧集联动（后置回写；宽容降级：任何异常不阻断 run 启动） */
async function linkEpisode(projectId: number, inputJson: string | null, runId: number): Promise<void> {
  try {
    const epNum = (JSON.parse(inputJson ?? '{}') as { episode_number?: unknown }).episode_number
    await mapRunToEpisode(projectId, epNum, runId)
  } catch {
    /* 宽容跳过 */
  }
}

function safeParse(s: string | null): unknown {
  if (!s) return null
  try { return JSON.parse(s) } catch { return s }
}

/** 读取文件尾部行（最多 tail 行；大文件仅读尾部 512KB，截断处丢弃残行） */
function readTailLines(file: string, tail: number): string[] {
  const MAX_BYTES = 512 * 1024
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - MAX_BYTES)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    let text = buf.toString('utf8')
    if (start > 0) {
      const nl = text.indexOf('\n')
      if (nl >= 0) text = text.slice(nl + 1)
    }
    return text.split(/\r?\n/).filter(Boolean).slice(-tail)
  } finally {
    closeSync(fd)
  }
}

function toRunView(r: typeof pipelineRuns.$inferSelect): Record<string, unknown> {
  let templateVersion: number | undefined
  if (r.templateSnapshot) {
    try {
      templateVersion = (JSON.parse(r.templateSnapshot) as { version?: number }).version
    } catch {
      templateVersion = undefined
    }
  }
  return {
    id: r.id,
    projectId: r.projectId,
    templateKey: r.templateKey,
    templateVersion,
    batchId: r.batchId,
    batchSeq: r.batchSeq,
    status: r.status,
    currentStepKey: r.currentStepKey,
    input: safeParse(r.input),
    summary: safeParse(r.summary),
    error: r.error,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}