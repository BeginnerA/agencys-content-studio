import { Hono } from 'hono'
import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm'
import { db } from '../db'
import { genTasks, pipelineRuns, pipelineSteps, projects } from '../db/schema'
import { engine, recoverInterruptedState } from '../pipeline/engine'
import { templateForRun } from '../pipeline/loader'
import { createRunRow, InvalidRunInputError } from '../services/run-create'
import { existsSync, openSync, closeSync, fstatSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { RUN_LOGS_DIR } from '../env'
import { HttpError, h, idParam, notFound, wb } from './helpers'
import { resetStepForRerun } from '../services/shot-workbench'

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
  try {
    run = await createRunRow({ projectId, templateKey, input: input as Record<string, unknown> })
  } catch (err) {
    if (err instanceof InvalidRunInputError) throw new HttpError(400, err.code, err.message)
    throw err
  }
  engine.startRun(run.id)
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
  return c.json({
    run: toRunView(run),
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
  if (!['failed', 'cancelled'].includes(src.status)) {
    throw new HttpError(400, 'bad_status', `仅 failed/cancelled 可续跑（当前 ${src.status}）；如需重跑请直接新建 run`)
  }
  const t = Date.now()
  const newRun = (
    await db
      .insert(pipelineRuns)
      .values({
        projectId: src.projectId,
        templateKey: src.templateKey,
        status: 'queued',
        input: src.input,
        // 续跑继承源 run 模板快照（断点续跑语义与源 run 一致）
        templateSnapshot: src.templateSnapshot,
        createdAt: t,
        updatedAt: t,
      })
      .returning()
  )[0]!
  const steps = await db
    .select()
    .from(pipelineSteps)
    .where(eq(pipelineSteps.runId, src.id))
    .orderBy(asc(pipelineSteps.seq))
  for (const s of steps) {
    // 断点续跑：succeeded/skipped（含免审放行痕迹）保留终态直接跳过；其余重置 pending 续跑
    const keep = s.status === 'succeeded' || s.status === 'skipped'
    const newStep = (
      await db
        .insert(pipelineSteps)
        .values({
          runId: newRun.id,
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
      await db
        .update(genTasks)
        .set({ runId: newRun.id, stepId: newStep.id, status: 'pending', attempts: 0, errorMsg: null, updatedAt: t })
        .where(and(eq(genTasks.runId, src.id), eq(genTasks.stepId, s.id), ne(genTasks.status, 'succeeded')))
    }
    await db
      .update(genTasks)
      .set({ runId: newRun.id, stepId: newStep.id, updatedAt: t })
      .where(and(eq(genTasks.runId, src.id), eq(genTasks.stepId, s.id), eq(genTasks.status, 'succeeded')))
  }
  engine.startRun(newRun.id)
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