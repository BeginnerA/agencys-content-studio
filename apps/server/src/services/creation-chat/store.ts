import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { assets, creationMessages, creationSessions, genTasks, pipelineRuns, pipelineSteps, projects, usageRecords, type CreationSession } from '../../db/schema'
import { CreationError } from './contract'

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
export const parseJson = <T>(raw: string | null, fallback: T): T => raw ? JSON.parse(raw) as T : fallback

export async function creationDetail(id: number) {
  const session = await sessionRow(id)
  const [project] = await db.select().from(projects).where(eq(projects.id, session.projectId))
  const messages = await db.select().from(creationMessages).where(eq(creationMessages.sessionId, id)).orderBy(asc(creationMessages.id))
  const [run] = session.runId ? await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, session.runId)) : []
  const steps = run ? await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, run.id)).orderBy(asc(pipelineSteps.seq)) : []
  const tasks = run ? await db.select().from(genTasks).where(eq(genTasks.runId, run.id)) : []
  const media = run ? await db.select().from(assets).where(and(eq(assets.runId, run.id), isNull(assets.deletedAt))) : []
  // [M32] 结果取「最新」通过交付检查的成片：每次重新合成会新增一条 final_video 资产（旧的不删），
  // 而 media 无排序、find 会命中最旧的一条 → 轻松创作永远显示首次合成。按 id 最大取最新，封面同理。
  let result: (typeof media)[number] | undefined
  let cover: (typeof media)[number] | undefined
  for (const a of media) {
    if (a.purpose === 'final_video' && parseJson<Record<string, unknown>>(a.params, {}).delivery_checked === true && (!result || a.id > result.id)) result = a
    if (a.purpose === 'thumbnail' && (!cover || a.id > cover.id)) cover = a
  }
  const uncertain = tasks.filter((t) => t.attempts > 0 && t.status !== 'succeeded')
  const usages = await db.select().from(usageRecords).where(eq(usageRecords.projectId, session.projectId))
  const planning = usages.filter((u) => u.kind === 'llm' && parseJson<Record<string, unknown>>(u.meta, {}).sessionId === id)
  return {
    session: {
      id, projectId: session.projectId, status: session.status, plan: parseJson(session.plan, null),
      planRevision: session.planRevision, planHash: session.planHash, preflight: parseJson(session.preflight, null),
      runId: session.runId, runHistory: parseJson(session.runHistory, []), error: session.error,
      createdAt: session.createdAt, updatedAt: session.updatedAt, projectDeleted: !project || project.deletedAt !== null,
    },
    messages: messages.map((m) => ({ id: m.id, role: m.role, content: m.content, payload: parseJson(m.payload, null), createdAt: m.createdAt })),
    planningUsage: { cost: planning.reduce((n, u) => n + (u.cost ?? 0), 0), unpriced: planning.filter((u) => u.cost === null).length },
    progress: run ? {
      runId: run.id, status: run.status === 'completed' && !result ? 'failed' : run.status,
      currentStep: run.currentStepKey, error: run.status === 'completed' && !result ? '缺少通过基础交付检查的成片' : run.error,
      needsVerification: ['failed', 'cancelled'].includes(run.status) && uncertain.length > 0,
      uncertainTasks: uncertain.map((t) => ({ id: t.id, kind: t.kind, provider: t.provider, hasExternalId: !!t.taskId })),
      completedShots: tasks.filter((t) => t.status === 'succeeded' && t.kind === (parseJson<{ mode?: string }>(session.plan, {}).mode === 'dynamic' ? 'video' : 'image')).length,
      steps: steps.map((s) => ({ key: s.stepKey, title: s.title, status: s.status, error: s.error })),
    } : null,
    result: run?.status === 'completed' && result ? { videoId: result.id, coverId: cover?.id ?? null, duration: result.duration } : null,
  }
}

export async function listCreationSessions() {
  const rows = await db.select({ session: creationSessions, name: projects.name, runStatus: pipelineRuns.status }).from(creationSessions)
    .innerJoin(projects, and(eq(projects.id, creationSessions.projectId), isNull(projects.deletedAt)))
    // 会话 status 是控制态（started 后不回写）；带出 run 真实状态供列表派生「已完成/失败/取消」显示
    .leftJoin(pipelineRuns, eq(pipelineRuns.id, creationSessions.runId))
    .orderBy(desc(creationSessions.updatedAt)).limit(100)
  return rows.map(({ session, name, runStatus }) => ({
    id: session.id, projectId: session.projectId, name, status: session.status, runId: session.runId, updatedAt: session.updatedAt, runStatus: runStatus ?? null,
    // [M31+] 「待确认」须真的可确认：status=ready 但预检未过（缺配置/超预算）时置 false，前端据此改显「待完善配置」，不再误导
    confirmable: session.status === 'ready' && parseJson<{ ready?: boolean } | null>(session.preflight, null)?.ready === true,
  }))
}

export async function notifyCreationSettled(runId: number): Promise<void> {
  await db.update(creationSessions).set({ updatedAt: Date.now() }).where(eq(creationSessions.runId, runId))
}

/** 启动时只对账控制态；从不重新发起规划或媒体请求。 */
export async function reconcileCreationSessions(): Promise<void> {
  await db.update(creationSessions).set({ status: 'draft', error: '规划被服务重启中断，可能已计费。请核验后发送新消息重试', preflight: null, updatedAt: Date.now() }).where(eq(creationSessions.status, 'planning'))
}

