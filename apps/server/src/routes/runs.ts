import { Hono } from 'hono'
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { pipelineRuns, pipelineSteps, projects } from '../db/schema'
import { engine, recoverInterruptedState } from '../pipeline/engine'
import { loadTemplate } from '../pipeline/loader'
import { validateRunInput } from '../pipeline/refs'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RUN_LOGS_DIR } from '../env'
import { HttpError, h, idParam, notFound } from './helpers'

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
  let template
  try {
    template = loadTemplate(templateKey)
  } catch (err) {
    throw new HttpError(400, 'bad_template', (err as Error).message)
  }
  const input = body['input']
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'bad_input', 'input 需为对象（brief 文本 / setting_docs 资产 id 数组 / episode_number 整数）')
  }
  const norm = normalizeInput(template.inputs, input as Record<string, unknown>)
  validateRunInput(template, norm)
  const t = Date.now()
  const row = await db
    .insert(pipelineRuns)
    .values({
      projectId,
      templateKey,
      status: 'queued',
      input: JSON.stringify(norm),
      createdAt: t,
      updatedAt: t,
    })
    .returning()
  const run = row[0]!
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

// GET /runs/:id/log —— 运行日志尾部（最近 300 行）
runsRoutes.get('/runs/:id/log', h(async (c) => {
  const run = await findRun(idParam(c))
  if (!run) return notFound(c, `run ${c.req.param('id')}`)
  const logFile = join(RUN_LOGS_DIR, `${run.id}.log`)
  if (!existsSync(logFile)) return c.json({ lines: [] })
  const text = readFileSync(logFile, 'utf8')
  const lines = text.split(/\r?\n/).filter(Boolean).slice(-300)
  return c.json({ lines })
}))

// POST /runs/:id/gate —— 闸门决策 {step_key, decision: approve|reject, note?, text_override?}
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
  } else {
    throw new HttpError(400, 'bad_decision', 'decision 需为 approve|reject')
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
    await db.insert(pipelineSteps).values({
      runId: newRun.id,
      seq: s.seq,
      stepKey: s.stepKey,
      actionKey: s.actionKey,
      title: s.title,
      status: s.status === 'succeeded' ? 'succeeded' : 'pending', // 成功步骤直接跳过
      input: s.status === 'succeeded' ? s.input : null,
      output: s.status === 'succeeded' ? s.output : null,
      attempts: s.status === 'succeeded' ? s.attempts : 0,
      createdAt: t,
      updatedAt: t,
    })
  }
  engine.startRun(newRun.id)
  return c.json({ run: toRunView(newRun) }, 202)
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

/** 按模板 inputs 声明归一化：int 转 number、files 保持 id 数组、text 收 string */
function normalizeInput(defs: { key: string; kind: string }[], raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const def of defs) {
    const v = raw[def.key]
    if (v === undefined || v === null || v === '') continue
    if (def.kind === 'int') {
      const n = typeof v === 'number' ? v : Number(v)
      if (!Number.isInteger(n)) throw new HttpError(400, 'bad_input', `input.${def.key} 需为整数`)
      out[def.key] = n
    } else if (def.kind === 'files') {
      const ids = Array.isArray(v) ? v.map(Number) : [Number(v)]
      if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
        throw new HttpError(400, 'bad_input', `input.${def.key} 需为资产 id 数组`)
      }
      out[def.key] = ids
    } else {
      out[def.key] = typeof v === 'string' ? v : JSON.stringify(v)
    }
  }
  return out
}

function safeParse(s: string | null): unknown {
  if (!s) return null
  try { return JSON.parse(s) } catch { return s }
}

function toRunView(r: typeof pipelineRuns.$inferSelect): Record<string, unknown> {
  return {
    id: r.id,
    projectId: r.projectId,
    templateKey: r.templateKey,
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
