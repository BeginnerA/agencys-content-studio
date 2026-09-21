import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { creationMessages, creationSessions, genTasks, pipelineRuns, pipelineSteps, projects, usageRecords, type CreationSession, type PipelineRun } from '../../db/schema'
import { CreationError, initialDraftSchema } from './contract'
import { jsonRecord, loadCreationProjection } from './projection'

/** 只串行化短数据库操作；模型/媒体调用不占锁。数据库条件更新仍是最终仲裁。 */
let tail: Promise<unknown> = Promise.resolve()
export function creationWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = tail.then(fn, fn)
  tail = next.catch(() => undefined)
  return next
}
export async function sessionRow(id: number): Promise<CreationSession> {
  const [session] = await db.select().from(creationSessions).where(eq(creationSessions.id, id))
  if (!session) throw new CreationError('not_found', '创作会话不存在', 404)
  return session
}
export async function activeProject(id: number): Promise<void> {
  const [project] = await db.select().from(projects).where(and(eq(projects.id, id), isNull(projects.deletedAt)))
  if (!project) throw new CreationError('project_deleted', '项目不存在或已删除，无法新增制作', 409)
}
export const parseJson = <T>(raw: string | null, fallback: T): T => {
  try { return raw ? JSON.parse(raw) as T : fallback } catch { return fallback }
}

async function runProjection(session: CreationSession, run: PipelineRun) {
  const steps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, run.id)).orderBy(asc(pipelineSteps.seq))
  const tasks = await db.select().from(genTasks).where(eq(genTasks.runId, run.id))
  return loadCreationProjection(session, run, steps, tasks)
}

export async function creationDetail(id: number) {
  const session = await sessionRow(id)
  const [project] = await db.select().from(projects).where(eq(projects.id, session.projectId))
  const messages = await db.select().from(creationMessages).where(eq(creationMessages.sessionId, id)).orderBy(asc(creationMessages.id))
  const [run] = session.runId ? await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, session.runId)) : []
  const projection = run && run.projectId === session.projectId ? await runProjection(session, run) : null
  const usages = await db.select().from(usageRecords).where(eq(usageRecords.projectId, session.projectId))
  const planning = usages.filter((u) => u.kind === 'llm' && parseJson<Record<string, unknown>>(u.meta, {}).sessionId === id)
  const initial = messages.map((m) => initialDraftSchema.safeParse(jsonRecord(m.payload))).find((p) => p.success)
  return {
    session: {
      id, projectId: session.projectId, status: session.status, plan: parseJson(session.plan, null),
      planRevision: session.planRevision, planHash: session.planHash, preflight: parseJson(session.preflight, null),
      runId: session.runId, runHistory: parseJson(session.runHistory, []), error: session.error,
      initialDraft: initial?.success && initial.data.deferPlanning ? { content: initial.data.content, requestKey: initial.data.requestKey } : null,
      createdAt: session.createdAt, updatedAt: session.updatedAt, projectDeleted: !project || project.deletedAt !== null,
      // [M40] 立项预览：未转正项目以 draft 影子态存在（不进项目列表），确认时才写入完整信息并转正
      project: project
        ? {
            id: project.id, name: project.name, genre: project.genre, templateKey: project.templateKey,
            tags: parseJson<string[]>(project.tags, []), brief: project.brief ?? '',
            status: project.status, isDraft: project.status === 'draft' && project.deletedAt === null,
          }
        : null,
    },
    messages: messages.filter((m) => jsonRecord(m.payload).kind !== 'initial_draft').map((m) => ({ id: m.id, role: m.role, content: m.content, payload: parseJson(m.payload, null), requestKey: m.requestKey, createdAt: m.createdAt })),
    planningUsage: { cost: planning.reduce((n, u) => n + (u.cost ?? 0), 0), unpriced: planning.filter((u) => u.cost === null).length },
    progress: projection?.progress ?? null,
    artifacts: projection?.artifacts ?? { shots: [], documents: [] },
    result: projection?.result ?? null,
  }
}

export async function listCreationSessions() {
  const rows = await db.select({ session: creationSessions, name: projects.name, run: pipelineRuns }).from(creationSessions)
    .innerJoin(projects, and(eq(projects.id, creationSessions.projectId), isNull(projects.deletedAt)))
    // 会话 status 是控制态（started 后不回写）；带出 run 真实状态供列表派生「已完成/失败/取消」显示
    .leftJoin(pipelineRuns, eq(pipelineRuns.id, creationSessions.runId))
    .orderBy(desc(creationSessions.updatedAt)).limit(100)
  return Promise.all(rows.map(async ({ session, name, run }) => ({
    id: session.id, projectId: session.projectId, name, status: session.status, runId: session.runId, updatedAt: session.updatedAt,
    runStatus: run?.projectId !== session.projectId ? null : run.status === 'completed' ? (await runProjection(session, run)).progress.status : run.status,
    // [M31+] 「待确认」须真的可确认：status=ready 但预检未过（缺配置/超预算）时置 false，前端据此改显「待完善配置」，不再误导
    confirmable: session.status === 'ready' && parseJson<{ ready?: boolean } | null>(session.preflight, null)?.ready === true,
  })))
}

export async function notifyCreationSettled(runId: number): Promise<void> {
  await db.update(creationSessions).set({ updatedAt: Date.now() }).where(eq(creationSessions.runId, runId))
}

/** 启动时只对账控制态；从不重新发起规划或媒体请求。 */
export async function reconcileCreationSessions(): Promise<void> {
  await db.update(creationSessions).set({ status: 'draft', error: '规划被服务重启中断，可能已计费。请核验后发送新消息重试', preflight: null, updatedAt: Date.now() }).where(eq(creationSessions.status, 'planning'))
}

