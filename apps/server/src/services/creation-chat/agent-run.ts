/**
 * 轻松创作 Agent 化编排层。
 * 设计原则：easy 主路径逐字零回归——本模块只在会话 agentMode=1 时介入，且
 *  - clarify/plan 两形仍复用 planning.ts 既有下游（clamp/refs/projectMeta/preflightPlan/planHash），本模块只补「决策旁注 + 角色署名 + handoff 留痕」；
 *  - route 形（template/chain/synth）为新增执行形态，本模块负责归一（normalizeAgentReply）→ 决策校验（preflightDecision）→ 落库（decision/decisionHash/preflight + handoff + 助手 route 消息）。
 * 护栏：物化输入只引用会话可用素材；模板须命中目录 + 版本一致；synth YAML 全量过 validateTemplateText；一切失败「可见拒绝」（抛 CreationError → 外层回 draft 态透出），绝不静默执行、绝不绕开确认闸。
 * 本模块只做「规划期决策 + 校验落库」，不建 run / 不起 workflow / 不落盘临时模板（那些是确认环节的执行分派）。
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { creationMessages, creationSessions, projects, type CreationSession } from '../../db/schema'
import { loadPromptTemplate, type ChatMessage } from '../llm'
import { loadTemplate, validateTemplateText } from '../../pipeline/loader'
import { prepareRunInput } from '../run-create'
import { CreationError, type PlanningReply } from './contract'
import { creationWrite } from './store'
import type { AgentDecision } from './agent/decision-schema'
import { normalizeAgentReply, decisionHashOf, type NormalizeContext } from './agent/normalize'
import { buildTemplateCatalog, renderCatalogForPrompt, type CatalogEntry } from './agent/template-catalog'
import { getRole, renderRolesForPrompt, resolveRole } from './agent/roles'
import type { AgentReply } from './agent/reply-schema'

/** 新会话是否默认进入 agent 模式（回退开关：CREATION_AGENT_MODE=0|off|false 即整体关闭，逐字回到 legacy 硬编码二选一） */
export function agentModeEnabled(): boolean {
  const v = (process.env.CREATION_AGENT_MODE ?? '').trim().toLowerCase()
  return !(v === '0' || v === 'off' || v === 'false')
}

/** agent 模式追加的路由上下文注入（四模式判定提示 + 可调度目录 + 角色注册表 + 本会话可用素材 id） */
export function buildAgentSystemMessages(opts: { catalog: CatalogEntry[]; allowedAssetIds: number[] }): ChatMessage[] {
  const ids = opts.allowedAssetIds.length ? opts.allowedAssetIds.join(', ') : '（本会话暂无可用素材，route 的 asset/assets 不得引用任何 id）'
  return [
    { role: 'system', content: loadPromptTemplate('agent-route.md') },
    { role: 'system', content: `【可调度模板目录】route 形态的 templateKey 必须逐字取自下方 key（easy 主路径见《方案契约》，与本目录无关）：\n${renderCatalogForPrompt(opts.catalog)}` },
    { role: 'system', content: `【角色注册表】roleKey / team[].roleKey 必须是下列已登记 key 之一（拿不准用 planner）：\n${renderRolesForPrompt()}` },
    { role: 'system', content: `【本会话可用素材 id】route 的 inputSpec 中 asset / assets 只能引用以下素材 id，绝不编造其它 id：${ids}` },
  ]
}

/** route 决策校验结果（confirm 消费；与 easy 的 CreationPreflight 分列，不覆写其结构） */
export interface DecisionPreflight {
  ready: boolean
  issues: Array<{ code: string; message: string }>
  /** 供确认卡展示的摘要（模式 + 目标/段数/步数），不含金额（金额在 confirm 时按物化输入最终核算） */
  summary: { mode: 'template' | 'chain' | 'synth'; templateKeys: string[]; stepCount?: number } | null
}

/** 输入物化：template 直调用的具体 input（default/prev 不参与单模板物化——prev 仅链内运行期解析） */
export function materializeInputSpec(decision: AgentDecision): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [field, item] of Object.entries(decision.templateRun?.inputSpec ?? {})) {
    switch (item.kind) {
      case 'text': out[field] = item.value; break
      case 'number': out[field] = item.value; break
      case 'boolean': out[field] = item.value; break
      case 'asset': out[field] = item.assetId; break
      case 'assets': out[field] = item.assetIds; break
      case 'default':
      case 'prev': break
    }
  }
  return out
}

/** 目录命中 + 版本一致核验（漂移即失效，须重新规划；绝不静默用新版执行） */
function entryFresh(catalog: CatalogEntry[], key: string, version: number): CatalogEntry | null {
  const now = catalog.find((t) => t.key === key)
  return now && now.version === version ? now : null
}

/**
 * route 决策校验（纯函数、零副作用、零计费）：
 * - template：目标须命中目录且版本一致，物化输入过 prepareRunInput（loadTemplate+normalize+validate）；
 * - chain：逐段目标须命中目录且版本一致（段间 prev 运行期解析，此处不物化）；
 * - synth：临时 YAML 全量过 validateTemplateText（action 白名单天然由校验器把守）。
 * 成本预估与预算硬闸留待确认环节（物化真实输入 + 端点快照后才能准确计价），这里只做「能不能执行」的结构闸。
 */
export function preflightDecision(decision: AgentDecision, catalog: CatalogEntry[]): DecisionPreflight {
  const issues: Array<{ code: string; message: string }> = []
  if (decision.mode === 'template' && decision.templateRun) {
    const { templateKey, catalogSnapshot } = decision.templateRun
    if (!entryFresh(catalog, templateKey, catalogSnapshot.version)) {
      issues.push({ code: 'template_drift', message: `模板「${templateKey}」在决策后已变更或已不在可调度目录，请重新规划确认` })
    } else {
      try {
        prepareRunInput(loadTemplate(templateKey), materializeInputSpec(decision))
      } catch (err) {
        issues.push({ code: 'route_input_invalid', message: `模板「${templateKey}」输入校验未通过：${err instanceof Error ? err.message : String(err)}` })
      }
    }
    return { ready: issues.length === 0, issues, summary: { mode: 'template', templateKeys: [templateKey] } }
  }
  if (decision.mode === 'chain' && decision.chain) {
    const keys: string[] = []
    for (const seg of decision.chain) {
      keys.push(seg.templateKey)
      if (!entryFresh(catalog, seg.templateKey, seg.catalogSnapshot.version)) {
        issues.push({ code: 'template_drift', message: `链路段「${seg.templateKey}」在决策后已变更或已不在可调度目录，请重新规划确认` })
      } else {
        try { loadTemplate(seg.templateKey) } catch (err) {
          issues.push({ code: 'route_input_invalid', message: `链路段「${seg.templateKey}」加载失败：${err instanceof Error ? err.message : String(err)}` })
        }
      }
    }
    return { ready: issues.length === 0, issues, summary: { mode: 'chain', templateKeys: keys } }
  }
  if (decision.mode === 'synth' && decision.synth) {
    const res = validateTemplateText(decision.synth.yaml, decision.synth.templateKey)
    if (!res.ok) issues.push({ code: 'synth_invalid', message: `临时模板校验未通过：${res.errors.join('；')}` })
    else if (res.warnings.length) issues.push({ code: 'synth_warning', message: `临时模板提示：${res.warnings.join('；')}` })
    return { ready: issues.length === 0, issues, summary: { mode: 'synth', templateKeys: [decision.synth.templateKey], stepCount: decision.synth.stepCount } }
  }
  // easy 由 preflightPlan 处理；route 缺载荷视为非法
  return { ready: false, issues: [{ code: 'route_invalid', message: '调度决策缺少可执行载荷，请重新规划' }], summary: null }
}

/** 事务句柄类型（与 db.transaction 回调入参同源；勿用 typeof db——事务对象缺 batch） */
type CreationTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** 换角留痕：与上一条助手消息署名不同则在事务内先插一条 system handoff（首条 = 无历史，也留痕）；planning.ts easy 分支同用 */
export async function insertHandoffIfChanged(tx: CreationTx, sessionId: number, roleKey: string, content: string): Promise<void> {
  const [lastAssistant] = await tx.select().from(creationMessages)
    .where(and(eq(creationMessages.sessionId, sessionId), eq(creationMessages.role, 'assistant')))
    .orderBy(desc(creationMessages.id)).limit(1)
  const prior = lastAssistant?.agentRole ?? null
  if (prior === roleKey) return
  await tx.insert(creationMessages).values({ sessionId, role: 'system', agentRole: roleKey, content, payload: JSON.stringify({ kind: 'handoff', roleKey }), createdAt: Date.now() })
}

/**
 * route 决策落库（规划期，不含执行）：归一 → 校验 → 乐观锁写 decision/decisionHash/preflight + 助手 route 消息 + 换角留痕。
 * 归一或校验失败按 CreationError 抛出，由 sendCreationMessage 外层 catch 回 draft 态并透出错误（可见拒绝）。
 */
export async function persistRouteDecision(
  sessionId: number,
  claimed: CreationSession,
  reply: AgentReply,
  catalog: CatalogEntry[],
  ctx: NormalizeContext,
): Promise<void> {
  const decision = normalizeAgentReply(reply, catalog, ctx)
  if (!decision) throw new CreationError('route_invalid', '调度决策归一失败，请重新规划', 422)
  const pf = preflightDecision(decision, catalog)
  const hash = decisionHashOf(decision)
  const message = reply.kind === 'route' ? reply.message : '已生成执行计划'
  const roleCard = getRole(decision.roleKey) ?? resolveRole(decision.roleKey)
  await creationWrite(() => db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(and(eq(projects.id, claimed.projectId), isNull(projects.deletedAt)))
    if (!project) throw new CreationError('project_deleted', '项目已删除，规划结果未采纳', 409)
    const updated = await tx.update(creationSessions).set({
      status: pf.ready ? 'ready' : 'draft',
      plan: null, planHash: null, preflight: JSON.stringify(pf),
      decision: JSON.stringify(decision), decisionHash: hash,
      planRevision: claimed.planRevision + 1,
      error: pf.ready ? null : (pf.issues.map((i) => i.message).join('；') || '调度未通过预检'),
      updatedAt: Date.now(),
    }).where(and(eq(creationSessions.id, sessionId), eq(creationSessions.status, 'planning'), eq(creationSessions.planRevision, claimed.planRevision))).returning()
    if (!updated.length) throw new CreationError('conflict', '会话版本已变化，旧回复未采纳', 409)
    await insertHandoffIfChanged(tx, sessionId, roleCard.key, `⏭ 本次由「${roleCard.name}」为你规划执行`)
    await tx.insert(creationMessages).values({
      sessionId, role: 'assistant', agentRole: roleCard.key, content: message,
      payload: JSON.stringify({
        kind: 'route', revision: claimed.planRevision + 1, mode: decision.mode, roleKey: decision.roleKey,
        confidence: decision.confidence, rationale: decision.rationale, ready: pf.ready,
        ...(decision.escalateTo ? { escalateTo: decision.escalateTo } : {}),
        ...(decision.capabilityNotes.length ? { capabilityNotes: decision.capabilityNotes } : {}),
      }),
      createdAt: Date.now(),
    })
    // 智能立项建议值（route 也可带 project）：仅未转正 draft 行落 name/genre/brief，模板取真实执行目标；缺失则留待 confirm
    const tplKey = decision.mode === 'template' ? decision.templateRun?.templateKey : decision.mode === 'synth' ? decision.synth?.templateKey : undefined
    if (tplKey && project.status === 'draft') {
      await tx.update(projects).set({ templateKey: tplKey, updatedAt: Date.now() }).where(eq(projects.id, claimed.projectId))
    }
  }))
}

/** 供 planning.ts 复用：确保调用方拿到与规划同批目录（避免二次扫盘；catalog 注入与归一须同源） */
export { buildTemplateCatalog }
export type { PlanningReply }
