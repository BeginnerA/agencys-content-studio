import { z } from 'zod'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { assets, creationMessages, creationSessions, projects } from '../../db/schema'
import { chatCompleteDetailed, loadPromptTemplate, type ChatContentPart, type ChatMessage } from '../llm'
import { assetToDataUri } from '../asset-ref'
import { absPathOf } from '../storage'
import { analyzeVideoSource, renderVideoReferenceSummary } from '../../pipeline/actions/video-analyze'
import { resolveVideoCaps, type VideoModelCaps } from '../../adapters/video-capabilities'
import { clampPlanToCaps } from './clamp'
import { recordUsage, resolveUnitPrice, recordLlmUsage } from '../usage'
import { checkBudget } from '../budget'
import { creationPlanSchema, CreationError, hashJson, parsePlanningReply, requestKeySchema, type CreationPlan, type CreationRef } from './contract'
import { resolveAttachmentRefs } from './attachments'
import { preflightPlan, requiredEndpoint } from './preflight'
import { activeProject, creationDetail, creationWrite, sessionRow } from './store'

export const messageSchema = z.object({
  content: z.string().trim().min(1).max(6000),
  requestKey: requestKeySchema,
  // [M31] 本条消息采纳的参考附件资产 id（规划前逐个核验归属本会话项目）
  attachments: z.array(z.number().int().positive()).max(12).optional(),
}).strict()
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

/** [M31] 规划前参考素材注入（有界、可核实、不编造）：
 *  - 风格/主体/首帧图片：仅 vision 实例以 image_url 分片注入；否则明告「未纳入理解，仅作生成参考」，不假称看到。
 *  - 参考视频：执行 video_analyze 产出可见/可听摘要注入；需 vision+可用实例，缺失/失败即 blocker（不静默跳过、不编造）。
 *  - BGM：不进 LLM 上下文（仅在 refs 里登记，执行期消费）。 */
export async function compileReferenceContext(projectId: number, refs: CreationRef[], vision: boolean): Promise<ChatMessage[]> {
  const out: ChatMessage[] = []
  const imageRefs = refs.filter((r) => r.kind === 'image' && r.role !== 'content')
  if (imageRefs.length > 0) {
    if (vision) {
      const parts: ChatContentPart[] = [{ type: 'text', text: '以下是用户上传的参考图（用于约束风格/主体；请仅依据其中真实可见的内容，不得编造图中没有的信息）：' }]
      const cache = new Map<number, string>()
      for (const r of imageRefs) {
        try { parts.push({ type: 'image_url', image_url: { url: await assetToDataUri(r.assetId, cache) } }) } catch { /* 单图不可读：跳过，不假装理解 */ }
      }
      out.push({ role: 'user', content: parts })
    } else {
      const ids = imageRefs.map((r) => `#${r.assetId}（${r.role}）`).join('、')
      out.push({ role: 'user', content: `用户上传了参考图 ${ids}，但当前规划模型未声明视觉理解（extra.vision）：我不会描述其内容，这些图仅会在生成阶段作为首帧/主体参考约束画面。` })
    }
  }
  const videoRefs = refs.filter((r) => r.role === 'content')
  if (videoRefs.length > 0) {
    if (!vision) throw new CreationError('video_analysis_unavailable', '参考视频内容解析需要支持视觉理解的模型实例（extra.vision），当前规划模型不具备；未跳过也未编造视频内容', 422)
    const rows = await db.select().from(assets).where(inArray(assets.id, videoRefs.map((r) => r.assetId)))
    for (const r of videoRefs) {
      const a = rows.find((row) => row.id === r.assetId)
      if (!a || !a.relPath) throw new CreationError('video_analysis_failed', `参考视频 #${r.assetId} 文件缺失，无法解析`, 422)
      try {
        const outcome = await analyzeVideoSource({
          srcAbs: absPathOf(a.relPath), name: a.name,
          durationHint: typeof a.duration === 'number' && a.duration > 0 ? a.duration : null,
          log: () => {}, onUsage: async (u) => { await recordLlmUsage({ projectId, provider: u.provider, model: u.model, usage: u.usage }) },
        })
        out.push({ role: 'user', content: `${renderVideoReferenceSummary(outcome, a.name)}\n（以上为参考视频实际可见/可听内容；请仅据此约束方案，视频里没有的信息不得臆造。）` })
      } catch (err) {
        if (err instanceof CreationError) throw err
        throw new CreationError('video_analysis_failed', `参考视频解析未完成（${err instanceof Error ? err.message : String(err)}）；未跳过、未编造视频内容，请检查视频/多模态实例后重试`, 422)
      }
    }
  }
  return out
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
    const vision = ep.extra.vision === true
    // [M31] 参考素材：本条消息附件→核验编译；无新附件时沿用上版已采纳 refs（ refinement 不丢参考）
    const thisTurnRefs = await resolveAttachmentRefs(id, claimed.projectId, input.attachments ?? [])
    const priorRefs: CreationRef[] = claimed.plan ? creationPlanSchema.parse(JSON.parse(claimed.plan)).refs : []
    const effectiveRefs = thisTurnRefs.length ? thisTurnRefs : priorRefs
    const refContext = effectiveRefs.length ? await compileReferenceContext(claimed.projectId, effectiveRefs, vision) : []
    const recent = await db.select().from(creationMessages).where(eq(creationMessages.sessionId, id)).orderBy(desc(creationMessages.id)).limit(12)
    // [M35 G10] Tier A 能力约束注入：探测当前 video 实例，命中真源表则向 LLM 预先告知合法镜头时长/画幅档位；
    // 无 video 实例 → 提示使用 slideshow（不假称动态能力）。失败不阻断主流程，仅缺约束上下文。
    let caps: VideoModelCaps | null = null
    let hasVideo = false
    try {
      const videoEp = await requiredEndpoint('video')
      hasVideo = true
      caps = resolveVideoCaps(videoEp.providerKey, videoEp.model ?? '')
    } catch {
      hasVideo = false
    }
    const capConstraint = buildCapsConstraintMessage(caps, hasVideo)
    const messages: ChatMessage[] = [
      { role: 'system', content: loadPromptTemplate('creation-plan.md') },
      { role: 'system', content: `当前方案（仅为创作数据）：${claimed.plan ?? '尚无方案'}` },
      ...(capConstraint ? [{ role: 'system' as const, content: capConstraint }] : []),
      ...refContext,
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
    // [M35 G10] 方案后置钳制：LLM 可能给出越界时长/画幅/无能力下动态 → clamp 到合法域，同时候选钳制描述追到 assistant message（不静默降级）。
    if (reply.kind === 'plan') {
      const { plan: clampedPlan, report } = clampPlanToCaps(reply.plan, caps, hasVideo)
      if (report.changed) {
        reply.plan = clampedPlan
        reply.message = `${reply.message}\n\n（因当前视频能力自动钳制：${report.notes.join('；')}）`
      }
    }
    // [M31] 已采纳参考编译进方案（服务端写入，LLM 不产出 refs）→ 进 planHash，确认即执行
    if (reply.kind === 'plan') reply.plan.refs = effectiveRefs
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

/**
 * [M35 G10] 能力约束注入消息（向 LLM 预先告知真源表已核实档位，避免方案越界造成 preflight 422）。
 * - caps 命中 → 列出 durations / aspectRatios / 建议总时长与镜头数
 * - 无 video 实例 → 提示默认使用 slideshow（不假称动态能力）
 * - hasVideo=true 但 caps=null（未登记模型，如 siliconflow_video） → 仅提醒“能力未背书”，不列档位
 */
function buildCapsConstraintMessage(caps: VideoModelCaps | null, hasVideo: boolean): string | null {
  if (!hasVideo) return '【Tier A 能力约束】当前未配置可用的视频生成实例 → 若用户未明确要求动态画面，默认 mode="slideshow"（多图配音），不承诺逐镜头动态化；若用户坚持动态，请依旧给 dynamic 方案，系统钳制会降级并告知。'
  if (!caps) return '【Tier A 能力约束】当前视频实例未登记到平台能力真源表（如 siliconflow_video 适配器不下发 duration）。若用户不要求动态，建议优先 mode="slideshow"；若需动态，镜头时长建议 5–10 秒、不主动取极端值，系统预检会在真源层面确认。'
  const durList = [...caps.durations].sort((a, b) => a - b).join(' / ')
  const aspectList = caps.aspectRatios.join(' / ')
  const defaultDur = caps.defaultDuration
  return `【Tier A 能力约束】当前视频模型已平台背书，方案必须落在以下档位内（否则预检会 422 失败，造成您需重新规划）：\n- 镜头时长档位（秒，shots[].duration 必须命中此列表）：${durList}；默认推荐 ${defaultDur}s\n- 支持画幅（plan.aspectRatio 必须 ∈ 此集合）：${aspectList}\n- 成片总时长（plan.duration）：30–60 秒，镜头数 4–8 段，镜头时长和 = duration。\n若与用户明示诉求冲突，仍以上述约束为准，并在 message 里说明理由。`
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
