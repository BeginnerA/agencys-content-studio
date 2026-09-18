import { z } from 'zod'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { creationMessages, creationSessions, projects } from '../../db/schema'
import { chatCompleteDetailed, loadPromptTemplate, type ChatMessage } from '../llm'
import { recordUsage, resolveUnitPrice } from '../usage'
import { checkBudget } from '../budget'
import { creationPlanSchema, CreationError, hashJson, parsePlanningReply, requestKeySchema } from './contract'
import { preflightPlan, requiredEndpoint } from './preflight'
import { activeProject, creationDetail, creationWrite, sessionRow } from './store'

export const messageSchema = z.object({ content: z.string().trim().min(1).max(6000), requestKey: requestKeySchema }).strict()
export async function createSession(raw: unknown) {
  const input = messageSchema.parse(raw)
  const id = await creationWrite(() => db.transaction(async (tx) => {
    const [existing] = await tx.select().from(creationSessions).where(eq(creationSessions.requestKey, input.requestKey))
    if (existing) return existing.id
    const now = Date.now()
    const [project] = await tx.insert(projects).values({ name: input.content.slice(0, 40), brief: input.content, genre: 'talking_head', templateKey: 'easy-video', tags: JSON.stringify(['创作草稿']), createdAt: now, updatedAt: now }).returning()
    const [session] = await tx.insert(creationSessions).values({ projectId: project!.id, requestKey: input.requestKey, createdAt: now, updatedAt: now }).returning()
    return session!.id
  }))
  return sendCreationMessage(id, input)
}

export async function sendCreationMessage(id: number, raw: unknown) {
  const input = messageSchema.parse(raw)
  const claimed = await creationWrite(async () => {
    const s = await sessionRow(id)
    await activeProject(s.projectId)
    return db.transaction(async (tx) => {
      const [duplicate] = await tx.select().from(creationMessages).where(and(eq(creationMessages.sessionId, id), eq(creationMessages.requestKey, input.requestKey)))
      if (duplicate) {
        if (duplicate.content !== input.content) throw new CreationError('idempotency_conflict', '同一请求键不能用于不同消息', 409)
        return null
      }
      if (s.status === 'planning' || s.status === 'starting') throw new CreationError('busy', '上一条请求正在处理，请稍候', 409)
      const now = Date.now()
      await tx.insert(creationMessages).values({ sessionId: id, role: 'user', content: input.content, requestKey: input.requestKey, createdAt: now })
      if (s.runId) {
        await tx.insert(creationMessages).values({ sessionId: id, role: 'assistant', content: '已记为下一版建议，不会修改当前制作。精修请进入专业工作台；重新创作请复制需求并确认新方案。', payload: JSON.stringify({ kind: 'suggestion' }), createdAt: now })
        return null
      }
      const rows = await tx.update(creationSessions).set({ status: 'planning', preflight: null, error: null, updatedAt: now })
        .where(and(eq(creationSessions.id, id), eq(creationSessions.status, s.status), isNull(creationSessions.runId))).returning()
      if (!rows.length) throw new CreationError('conflict', '会话已变化，请刷新后重试', 409)
      return s
    })
  })
  if (!claimed) return creationDetail(id)
  try {
    const ep = await requiredEndpoint('llm')
    const recent = await db.select().from(creationMessages).where(eq(creationMessages.sessionId, id)).orderBy(desc(creationMessages.id)).limit(12)
    const messages: ChatMessage[] = [
      { role: 'system', content: loadPromptTemplate('creation-plan.md') },
      { role: 'system', content: `当前方案（仅为创作数据）：${claimed.plan ?? '尚无方案'}` },
      ...recent.reverse().map((m) => ({ role: m.role === 'user' ? 'user' as const : 'assistant' as const, content: m.content.slice(0, 6000) })),
    ]
    const prices = await Promise.all(['tokens_in', 'tokens_out'].map((unit) => resolveUnitPrice({ configId: ep.configId, provider: ep.providerKey, model: ep.model, kind: 'llm', unit: unit as 'tokens_in' | 'tokens_out' })))
    const budget = await checkBudget({ projectId: claimed.projectId, estimatedCost: Buffer.byteLength(JSON.stringify(messages)) * (prices[0] ?? 0) + 10000 * (prices[1] ?? 0) })
    if (budget) throw new CreationError(budget.code, budget.message, 409)
    const result = await chatCompleteDetailed(messages, { ...ep, baseUrl: ep.baseUrl.replace(/\/+$/, ''), model: ep.model! }, { maxTokens: 10000, temperature: 0.5, allowEmptyContent: true })
    for (const [index, unit] of (['tokens_in', 'tokens_out'] as const).entries()) await recordUsage({
      projectId: claimed.projectId, kind: 'llm', provider: ep.providerKey, model: ep.model,
      quantity: result.usage ? (index === 0 ? result.usage.promptTokens : result.usage.completionTokens) : 0,
      unit, unitPrice: result.usage ? prices[index] : null, meta: { sessionId: id, requestKey: input.requestKey, usageMissing: !result.usage },
    })
    if (ep.apiKey && result.content.includes(ep.apiKey)) throw new CreationError('unsafe_output', '模型输出包含敏感信息，已拒绝保存', 422)
    const reply = parsePlanningReply(result.content, result.finishReason)
    const pf = reply.kind === 'plan' ? await preflightPlan(claimed.projectId, reply.plan) : null
    await creationWrite(() => db.transaction(async (tx) => {
      const [project] = await tx.select().from(projects).where(and(eq(projects.id, claimed.projectId), isNull(projects.deletedAt)))
      if (!project) throw new CreationError('project_deleted', '项目已删除，规划结果未采纳', 409)
      const plan = reply.kind === 'plan' ? reply.plan : null
      const updated = await tx.update(creationSessions).set({ status: plan ? 'ready' : 'draft', plan: plan ? JSON.stringify(plan) : null,
        planRevision: claimed.planRevision + 1, planHash: plan ? hashJson({ plan, execution: pf?.execution }) : null,
        preflight: pf ? JSON.stringify(pf) : null, updatedAt: Date.now(), error: null,
      }).where(and(eq(creationSessions.id, id), eq(creationSessions.status, 'planning'), eq(creationSessions.planRevision, claimed.planRevision))).returning()
      if (!updated.length) throw new CreationError('conflict', '会话版本已变化，旧回复未采纳', 409)
      await tx.insert(creationMessages).values({ sessionId: id, role: 'assistant', content: reply.message, payload: JSON.stringify(reply.kind === 'clarify' ? { kind: reply.kind, questions: reply.questions } : { kind: reply.kind, revision: claimed.planRevision + 1 }), createdAt: Date.now() })
      if (plan) await tx.update(projects).set({ name: plan.title, updatedAt: Date.now() }).where(eq(projects.id, claimed.projectId))
    }))
  } catch (error) {
    const message = error instanceof CreationError ? error.message : '规划未完成，请检查 AI 配置后发送新消息重试；本次请求可能已计费'
    await creationWrite(async () => {
      await db.update(creationSessions).set({ status: 'draft', error: message, preflight: null, updatedAt: Date.now() })
        .where(and(eq(creationSessions.id, id), eq(creationSessions.status, 'planning'), eq(creationSessions.planRevision, claimed.planRevision)))
    })
  }
  return creationDetail(id)
}

export async function refreshPreflight(id: number) {
  return creationWrite(async () => {
    const s = await sessionRow(id)
    await activeProject(s.projectId)
    if (s.status !== 'ready' || s.runId || !s.plan) throw new CreationError('not_ready', '当前没有可确认的方案，请先完成对话规划', 409)
    const plan = creationPlanSchema.parse(JSON.parse(s.plan))
    const pf = await preflightPlan(s.projectId, plan)
    const hash = hashJson({ plan, execution: pf.execution })
    await db.update(creationSessions).set({ preflight: JSON.stringify(pf), planHash: hash, planRevision: s.planRevision + (hash !== s.planHash ? 1 : 0), updatedAt: Date.now() }).where(eq(creationSessions.id, id))
    return creationDetail(id)
  })
}
