/**
 * 决策归一（LLM 输出 = 建议值，服务端权威归一；project-meta sanitizeProjectMeta 同律）。
 * 归一不是转录：每一项越界/编造都可能变成真实计费，所以能力越界拉回、幽灵引用剔除、
 * synth 全文过校验器，全部「可见不静默」（capabilityNotes 随决策落库、面板可检视）。
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { CreationError, hashJson } from '../contract'
import type { AgentReply } from './reply-schema'
import { SYNTH_FORBIDDEN_ACTIONS, SYNTH_STEPS_MAX, agentDecisionSchema, inputSpecItemSchema, type AgentDecision, type AgentMode, type InputSpecItem } from './decision-schema'
import { FALLBACK_ROLE, getRole, resolveRole, roleCan, type RoleCard } from './roles'
import type { CatalogEntry } from './template-catalog'

export interface NormalizeContext {
  sessionId: number
  /** 本会话可用资产 id（已编译 refs ∪ 本轮上传附件）：inputSpec 的 asset/assets 引用只能落在此集合，禁止 LLM 编造 */
  allowedAssetIds: Set<number>
}

/** 未注册角色 → 回落策划（兜底角色能力最全）；能力越界 → 由 planner（全能）承接并留痕 */
function applyCapability(role: RoleCard, mode: AgentMode, targetKeys: string[], notes: string[]): RoleCard {
  if (roleCan(role, mode)) return role
  const planner = getRole(FALLBACK_ROLE)!
  notes.push(`${role.name}不具备「${mode}」执行能力，已由${planner.name}承接本次规划`)
  return planner
}

/** 模板引用核验：必须命中目录（conversationOnly 天然不在目录内） */
function requireCatalogEntry(catalog: CatalogEntry[], key: unknown, what: string): CatalogEntry {
  if (typeof key !== 'string' || !key) throw new CreationError('route_invalid', `${what}缺少有效模板 key`, 422)
  const entry = catalog.find((t) => t.key === key)
  if (!entry) throw new CreationError('route_invalid', `${what}引用的模板「${key}」不在可调度目录内（对话专用模板或不存在），请重新规划`, 422)
  return entry
}

/** 输入物化声明核验：asset 引用必须在会话可用集合内（幽灵 id 剔除并留痕，不编造执行输入） */
function sanitizeInputSpec(raw: Record<string, unknown> | undefined, ctx: NormalizeContext, notes: string[]): Record<string, InputSpecItem> {
  const out: Record<string, InputSpecItem> = {}
  for (const [field, value] of Object.entries(raw ?? {})) {
    const parsed = inputSpecItemSchema.safeParse(value)
    if (!parsed.success) {
      notes.push(`输入「${field}」的取值声明不符合契约，已剔除（将按模板默认值或预检拦截处理）`)
      continue
    }
    const item = parsed.data
    if (item.kind === 'asset' && !ctx.allowedAssetIds.has(item.assetId)) {
      notes.push(`输入「${field}」引用的素材 #${item.assetId} 不在本会话可用集合内，已剔除（不编造来料）`)
      continue
    }
    if (item.kind === 'assets') {
      const kept = item.assetIds.filter((id) => ctx.allowedAssetIds.has(id))
      if (kept.length !== item.assetIds.length) notes.push(`输入「${field}」有 ${item.assetIds.length - kept.length} 个素材不在本会话可用集合内，已剔除`)
      if (!kept.length) continue
      out[field] = { ...item, assetIds: kept }
      continue
    }
    out[field] = item
  }
  return out
}

/** InputSpecItem → workflow inputSpec token 文法（$prev.* 产物 / 字面量字符串，int/bool 由下游 normalizeInput 转型） */
export function toWorkflowToken(item: InputSpecItem): string | undefined {
  switch (item.kind) {
    case 'text': return item.value
    case 'number': return String(item.value)
    case 'boolean': return String(item.value)
    case 'asset': return String(item.assetId)
    case 'assets': return JSON.stringify(item.assetIds)
    case 'prev': return item.ref.startsWith('$prev.') ? item.ref : `$prev.assets:${item.ref}`
    case 'default': return undefined
  }
}

/** synth YAML 权威重写：key 强制为仿制前缀键、注入 visibility/builtin、危险动作与步数闸门在过校验器之前先行拒绝 */
function sanitizeSynthYaml(rawYaml: unknown, ctx: NormalizeContext, notes: string[]): { name: string; templateKey: string; yaml: string; stepCount: number; yamlHash: string } {
  if (typeof rawYaml !== 'string' || !rawYaml.trim()) throw new CreationError('route_invalid', '临时模板缺少 YAML 内容', 422)
  let doc: unknown
  try {
    doc = parseYaml(rawYaml)
  } catch (err) {
    throw new CreationError('synth_invalid', `临时模板 YAML 解析失败：${(err as Error).message}`, 422)
  }
  if (typeof doc !== 'object' || !doc || Array.isArray(doc)) throw new CreationError('synth_invalid', '临时模板内容为空或非对象', 422)
  const obj = doc as Record<string, unknown>
  const steps = obj['steps']
  if (!Array.isArray(steps) || !steps.length) throw new CreationError('synth_invalid', '临时模板缺少 steps', 422)
  if (steps.length > SYNTH_STEPS_MAX) throw new CreationError('synth_invalid', `临时模板步数 ${steps.length} 超过上限 ${SYNTH_STEPS_MAX}`, 422)
  const actions = steps.map((s) => (s && typeof s === 'object' ? (s as { action?: unknown }).action : undefined)).filter((a): a is string => typeof a === 'string')
  const dangerous = actions.filter((a) => (SYNTH_FORBIDDEN_ACTIONS as readonly string[]).includes(a) || /^delete|_drop|overwrite/i.test(a))
  if (dangerous.length) throw new CreationError('synth_invalid', `临时模板含高危动作（${dangerous.join(', ')}），不允许执行`, 422)
  const name = typeof obj['name'] === 'string' && obj['name'].trim() ? String(obj['name']).trim().slice(0, 100) : `智能临时流程 ${ctx.sessionId}`
  // 仿制 key：agent-s{会话id}- 前缀（会话清理据此删除；不进专业选择器）
  const slug = String(obj['key'] ?? name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'flow'
  const templateKey = `agent-s${ctx.sessionId}-${slug}`.slice(0, 60)
  obj['key'] = templateKey
  obj['name'] = name
  obj['visibility'] = 'conversation'
  obj['builtin'] = false
  const yaml = stringifyYaml(obj, { lineWidth: 0 })
  return { name, templateKey, yaml, stepCount: steps.length, yamlHash: hashJson(yaml) }
}

/** 三形回复 → 权威决策（clarify 无决策返回 null；plan 派生 easy 旁注；route 全量归一） */
export function normalizeAgentReply(reply: AgentReply, catalog: CatalogEntry[], ctx: NormalizeContext): AgentDecision | null {
  if (reply.kind === 'clarify') return null
  const notes: string[] = []
  if (reply.kind === 'plan') {
    // easy 主路径零回归：plan 列/planHash 用原样 reply.plan，decision 仅展示旁注
    const role = applyCapability(resolveRole(reply.roleKey), 'easy', [], notes)
    const team = (reply.team ?? []).filter((t) => getRole(t.roleKey)).map((t) => ({ ...t, roleKey: resolveRole(t.roleKey).key }))
    return agentDecisionSchema.parse({
      mode: 'easy',
      roleKey: role.key,
      team,
      confidence: 1,
      rationale: reply.message.slice(0, 2000),
      plan: reply.plan,
      ...(notes.length ? { capabilityNotes: notes } : {}),
    })
  }
  // route：mode 决定载荷形态，逐形归一；所有失败都是「可见拒绝」（抛错→draft 态透出，不静默执行）
  const requested = resolveRole(reply.roleKey)
  let role = requested
  let mode = reply.mode
  const templateKeys: string[] = []
  if (mode === 'template') templateKeys.push(typeof reply.templateRun?.templateKey === 'string' ? reply.templateRun.templateKey : '')
  if (mode === 'chain') reply.chain?.forEach((seg) => templateKeys.push(typeof seg?.templateKey === 'string' ? seg.templateKey : ''))
  if (mode === 'easy') {
    // route 形不许承载 easy：easy 必须走 plan 形完整方案契约（防绕开 creationPlanSchema 硬闸）
    throw new CreationError('route_invalid', '单条成片诉求请以方案形态（plan）返回并给出完整创作方案', 422)
  }
  role = applyCapability(role, mode, templateKeys, notes)
  if (role.key !== requested.key) notes.push(`原定发言角色「${requested.name}」能力不覆盖本次执行，已改由「${role.name}」负责`)
  const team = (reply.team ?? [])
    .map((t) => ({ entry: t, role: getRole(t.roleKey) }))
    .filter((x): x is { entry: typeof x.entry; role: RoleCard } => !!x.role)
    .map((x) => ({ roleKey: x.role.key, stage: x.entry.stage }))
  const escalateTo = reply.escalateTo
    ? (() => {
      const key = typeof reply.escalateTo?.templateKey === 'string' ? reply.escalateTo.templateKey : ''
      const reason = typeof reply.escalateTo?.reason === 'string' ? reply.escalateTo.reason.slice(0, 300) : ''
      if (!key || !catalog.some((t) => t.key === key)) {
        notes.push('升级建议的目标模板不在可调度目录内，已剔除')
        return undefined
      }
      return { templateKey: key, reason: reason || '建议升级到专业链' }
    })()
    : undefined
  const base = {
    mode,
    roleKey: role.key,
    team,
    confidence: reply.confidence ?? 0.5,
    rationale: reply.rationale,
    ...(escalateTo ? { escalateTo } : {}),
    // 持 live notes 引用：sanitizeInputSpec 在各 mode 分支内追加留痕（幽灵 asset 剔除等），
    // 分支末尾的 parse 在其后执行 → 实时反映全部「可见不静默」记录（不能在此按 length 早判，否则丢痕）。
    capabilityNotes: notes,
  }
  if (mode === 'template') {
    const entry = requireCatalogEntry(catalog, reply.templateRun?.templateKey, '单模板执行')
    const inputSpec = sanitizeInputSpec(reply.templateRun?.inputSpec as Record<string, unknown> | undefined, ctx, notes)
    return agentDecisionSchema.parse({ ...base, templateRun: { templateKey: entry.key, catalogSnapshot: { key: entry.key, version: entry.version }, inputSpec } })
  }
  if (mode === 'chain') {
    const segs = reply.chain ?? []
    if (segs.length < 2) throw new CreationError('route_invalid', '链式执行至少需要两个段落', 422)
    const chain = segs.map((seg, i) => {
      const entry = requireCatalogEntry(catalog, seg.templateKey, `链第 ${i + 1} 段`)
      const inputSpec = sanitizeInputSpec(seg.inputSpec as Record<string, unknown> | undefined, ctx, notes)
      return {
        templateKey: entry.key,
        catalogSnapshot: { key: entry.key, version: entry.version },
        title: (typeof seg.title === 'string' && seg.title.trim() ? seg.title.trim() : entry.name).slice(0, 100),
        inputSpec,
      }
    })
    return agentDecisionSchema.parse({ ...base, chain })
  }
  // synth：全 planner 专属（applyCapability 已保证）；yaml 重写 → 校验器硬闸在 preflight 执行前，这里只做前置危险拦截
  const synth = sanitizeSynthYaml(reply.synth?.yaml, ctx, notes)
  const inputSpec = sanitizeInputSpec(reply.synth?.inputSpec as Record<string, unknown> | undefined, ctx, notes)
  return agentDecisionSchema.parse({ ...base, synth: { ...synth, inputSpec } })
}

/** 确认闸哈希：语义同 planHash（决策任何实质变化都作废旧确认） */
export function decisionHashOf(decision: AgentDecision): string {
  return hashJson(decision)
}
