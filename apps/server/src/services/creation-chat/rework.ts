import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { creationMessages, creationSessions, pipelineRuns, type CreationSession, type PipelineRun } from '../../db/schema'
import { engine } from '../../pipeline/engine'
import { chatCompleteDetailed, type ChatMessage } from '../llm'
import { recordUsage, resolveUnitPrice } from '../usage'
import { checkBudget } from '../budget'
import { writeTextAsset } from '../storage'
import { resetShotsForRework, type ReworkStepReset } from '../shot/reset'
import {
  CreationError, creationPlanSchema, hashJson, reworkApplySchema, reworkReplySchema, reworkRequestSchema,
  type CreationPlan, type ReworkOp,
} from './contract'
import { assertRecipeSources, recipeOf, recipeSchema, type CreationRecipe } from './recipe'
import { requiredEndpoint, type CreationPreflight } from './preflight'
import { activeProject, creationWrite, parseJson, sessionRow } from './store'
import { throughShotLayer } from './candidates'
import { jsonRecord } from './projection'

/**
 * [M42] 自然语言局部返修：一句话定位镜头 → LLM 解析成预览（第一次调用，只花文本模型小额费用、零媒体计费）
 * → 用户显式确认 → 同事务改写批准链（新分镜版本 + run.input + approvedPlan + planHash）→ 只重置目标镜任务 → 续跑。
 *
 * 可返修范围按模式收口（不猜、不让用户花进不了成片的钱）：
 * - slideshow（图文成片）：改「画面提示词」→ 重做该镜画面；
 * - dynamic（动态成片）：改「动态提示词」→ 重做该镜视频。
 * 动态模式下的首帧不在本入口重做：新首帧必然要求该镜视频随之重做，而引擎的批准任务守卫
 * 会拒绝对已批准 run 静默改写视频任务参数（首帧资产 id 变化即参数变化）。要改动态片的画面，
 * 请复制需求重新规划整版——这与「不削弱批准链权威」的同一条红线一致，故此处不做半步支持。
 */

type ReworkField = 'image' | 'motion'

export interface ReworkTarget {
  shotId: string
  index: number
  /** 原提示词 → 新提示词（前端 diff 卡片用；未参与本次改动的侧为 null） */
  imageFrom: string | null
  imagePrompt: string | null
  motionFrom: string | null
  motionPrompt: string | null
  /** 该镜该侧重生成费用（元）；单价未知 → null 并同步进 unpriced */
  imageCost: number | null
  motionCost: number | null
}

export interface ReworkPreview {
  instruction: string
  unclear: string | null
  targets: ReworkTarget[]
  /** 解析期可见提示（越界字段被忽略等）；不静默丢弃用户的任何诉求 */
  notes: string[]
  estimate: { knownCost: number; unpriced: string[] }
  planRevision: number
  planHash: string
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6
const money = (n: number): string => `¥${n.toFixed(2)}`
/** 未知值 → 可读对象（LLM 回复归一用；非对象一律空对象） */
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

/** 本模式可落地的返修字段（dynamic 且无视频能力 → 空集，一律 unclear） */
export function reworkFields(plan: CreationPlan, videoMode: string): ReworkField[] {
  if (plan.mode !== 'dynamic') return ['image']
  return videoMode === 'none' ? [] : ['motion']
}

const reworkStepKey = (plan: CreationPlan): string => (plan.mode === 'dynamic' ? 'motion' : 'images')

const fieldLabel = (field: ReworkField): string => (field === 'image' ? '画面提示词' : '动态提示词')

interface AppliedChange { shotId: string; field: ReworkField; from: string; to: string }

/** ops → 新方案（服务端重算，不信前端带来的任何数字/字段）；越界镜头与无改动逐项拒绝 */
function applyOps(plan: CreationPlan, ops: readonly ReworkOp[], fields: ReworkField[]): { plan: CreationPlan; changed: AppliedChange[]; notes: string[] } {
  const next = plan.shots.map((s) => ({ ...s }))
  const changed: AppliedChange[] = []
  const notes: string[] = []
  const seen = new Set<string>()
  for (const op of ops) {
    if (seen.has(op.shot_id)) throw new CreationError('duplicate_shot', `镜头 ${op.shot_id} 重复提交`, 400)
    seen.add(op.shot_id)
    const idx = plan.shots.findIndex((s) => s.id === op.shot_id)
    if (idx < 0) throw new CreationError('unknown_shot', `镜头 ${op.shot_id} 不在当前已批准分镜中，请重新解析返修指令`, 409)
    const shot = next[idx]!
    for (const field of ['image', 'motion'] as const) {
      const raw = field === 'image' ? op.image_prompt : op.motion_prompt
      if (raw === undefined) continue
      if (!fields.includes(field)) {
        notes.push(`第 ${idx + 1} 镜的${fieldLabel(field)}在本模式下不通过局部返修重做，已忽略`)
        continue
      }
      const to = raw.trim()
      const from = field === 'image' ? shot.image_prompt : shot.motion_prompt
      if (!to || to === from.trim()) continue
      if (field === 'image') shot.image_prompt = to
      else shot.motion_prompt = to
      changed.push({ shotId: shot.id, field, from, to })
    }
  }
  if (!changed.length) {
    throw new CreationError('no_change', '没有可执行的提示词改动（与当前方案一致，或该模式不支持这类返修），请重新解析', 409)
  }
  return { plan: creationPlanSchema.parse({ ...plan, shots: next }), changed, notes }
}

/** 费用重算（单价口径与执行期 remainingCost 完全一致：图像按张、视频按批准秒数） */
function estimateOf(recipe: CreationRecipe, changed: readonly AppliedChange[]): { targets: ReworkTarget[]; unpriced: string[]; knownCost: number } {
  const targets = new Map<string, ReworkTarget>()
  const unpriced = new Set<string>()
  let knownCost = 0
  for (const c of changed) {
    const index = recipe.plan.shots.findIndex((s) => s.id === c.shotId)
    const t = targets.get(c.shotId) ?? {
      shotId: c.shotId, index: index + 1,
      imageFrom: null, imagePrompt: null, motionFrom: null, motionPrompt: null, imageCost: null, motionCost: null,
    }
    if (c.field === 'image') {
      t.imageFrom = c.from; t.imagePrompt = c.to
      const ep = recipe.endpoints.image
      if (!ep || ep.unitPrice === null) unpriced.add(`${ep ? `${ep.provider} / ${ep.model}` : '未绑定图像实例'}（画面）`)
      else { t.imageCost = round((t.imageCost ?? 0) + ep.unitPrice); knownCost += ep.unitPrice }
    } else {
      t.motionFrom = c.from; t.motionPrompt = c.to
      const ep = recipe.endpoints.video
      const secs = recipe.requestDurations[c.shotId] ?? recipe.plan.shots[index]?.duration ?? 0
      if (!ep || ep.unitPrice === null) unpriced.add(`${ep ? `${ep.provider} / ${ep.model}` : '未绑定视频实例'}（动态镜头 ${secs} 秒）`)
      else { t.motionCost = round((t.motionCost ?? 0) + ep.unitPrice * secs); knownCost += ep.unitPrice * secs }
    }
    targets.set(c.shotId, t)
  }
  return {
    targets: [...targets.values()].sort((a, b) => a.index - b.index),
    unpriced: [...unpriced],
    knownCost: round(knownCost),
  }
}

/** 解析器提示词（镜头表 = 已批准方案真源，只给本模式能落地的字段） */
function parseMessages(plan: CreationPlan, fields: ReworkField[], instruction: string): ChatMessage[] {
  const table = plan.shots.map((s, i) => ({
    shot_index: i + 1,
    shot_id: s.id,
    ...(fields.includes('image') ? { image_prompt: s.image_prompt } : {}),
    ...(fields.includes('motion') ? { motion_prompt: s.motion_prompt } : {}),
    台词: s.lines.map((id) => plan.lines.find((l) => l.id === id)?.text ?? '').join(' '),
  }))
  const scope = fields.includes('motion')
    ? '本方案是动态成片：只能给出 motion_prompt（会重做该镜视频）。'
    : '本方案是图文成片：只能给出 image_prompt（会重做该镜画面）。'
  return [
    {
      role: 'system',
      content: [
        '你是视频成片流水线的「局部返修指令解析器」：把用户一句话定位到成片中的具体镜头，并给出该镜头的新提示词。',
        '只输出严格 JSON（无解释文字、无 Markdown 代码块）：{"targets":[{"shot_index":1,"image_prompt":"…","motion_prompt":"…"}],"unclear":null}',
        '规则：',
        '1) 新提示词会整体替换原提示词，因此必须完整自包含（保留原提示词里仍然需要的主体/构图/光线/风格信息），不要写「同上」「再亮一点」这类依赖上下文的表述。',
        '2) 只输出确实需要修改的字段；未要求修改的字段一律省略，不要照抄原值。',
        `3) ${scope} 其它类型的提示词改动做不到，请写进 unclear 说明原因。`,
        '4) 只改提示词：不得改动台词文本、时长、镜头顺序或增删镜头。',
        '5) 涉及文案/台词/配音/字幕/音乐/整体风格/加删镜头等超出单镜提示词返修的要求 → targets 给空数组，并在 unclear 里说明本入口做不到、应复制需求重新规划整版。',
        '6) 指代不清、无法唯一定位镜头（如「那个画面」「第二段里的小狗」）→ targets 给空数组，unclear 说明还需要什么信息。绝不猜。',
        '7) shot_index 从 1 开始且不得超过现有镜头数；unclear 为字符串或 null（能完整解析时为 null）。',
        `当前成片 ${plan.shots.length} 镜（模式 ${plan.mode}，画幅 ${plan.aspectRatio}，整体风格 ${plan.style}）：`,
        JSON.stringify(table),
      ].join('\n'),
    },
    { role: 'user', content: `返修指令：${instruction}` },
  ]
}

const NO_TARGET = '没能从这条指令里唯一定位到要返修的镜头，或该诉求超出局部返修范围（本入口只重做单个镜头的画面/动态提示词）。可以说得更具体些，例如「第 2 镜：改成夜晚街景，霓虹反光」；若要改文案、配音、音乐或整体风格，请复制需求重新规划整版。'

/** LLM 回复归一：越界/歧义一律 unclear（不猜），可执行部分逐字段核验 */
function sanitizeReply(raw: { targets?: unknown; unclear?: unknown }, plan: CreationPlan, fields: ReworkField[]): { ops: ReworkOp[]; unclear: string | null; notes: string[] } {
  const said = typeof raw.unclear === 'string' && raw.unclear.trim() ? raw.unclear.trim().slice(0, 1200) : null
  const notes: string[] = []
  const ops: ReworkOp[] = []
  const list = Array.isArray(raw.targets) ? raw.targets : []
  const used = new Set<string>()
  for (const item of list) {
    const o = asRecord(item)
    const byId = typeof o.shot_id === 'string' ? plan.shots.findIndex((s) => s.id === o.shot_id) : -1
    const n = typeof o.shot_index === 'number' ? o.shot_index : Number(o.shot_index)
    const idx = byId >= 0 ? byId : Number.isInteger(n) && n >= 1 && n <= plan.shots.length ? n - 1 : -1
    if (idx < 0) return { ops: [], unclear: said ?? NO_TARGET, notes }
    const shot = plan.shots[idx]!
    if (used.has(shot.id)) return { ops: [], unclear: said ?? `第 ${idx + 1} 镜被重复给出要求，无法确定以哪一条为准，请拆分说明`, notes }
    used.add(shot.id)
    const op: ReworkOp = { shot_id: shot.id }
    for (const field of ['image', 'motion'] as const) {
      const value = o[field === 'image' ? 'image_prompt' : 'motion_prompt']
      if (typeof value !== 'string' || !value.trim()) continue
      const to = value.trim()
      const max = field === 'image' ? 1600 : 1200
      if (to.length > max) return { ops: [], unclear: `第 ${idx + 1} 镜的新${fieldLabel(field)}过长（${to.length} 字，上限 ${max}），请精简后重说`, notes }
      if (!fields.includes(field)) {
        notes.push(`第 ${idx + 1} 镜的${fieldLabel(field)}在本模式下不能通过局部返修重做，已忽略该项`)
        continue
      }
      const from = field === 'image' ? shot.image_prompt : shot.motion_prompt
      if (to === from.trim()) continue
      if (field === 'image') op.image_prompt = to
      else op.motion_prompt = to
    }
    if (op.image_prompt === undefined && op.motion_prompt === undefined) continue
    ops.push(op)
  }
  if (!ops.length) return { ops: [], unclear: said ?? NO_TARGET, notes }
  // 有可执行目标时 unclear 降级为可见提示（不隐藏用户越界诉求，但也不再阻断确认）
  if (said) notes.push(said)
  return { ops, unclear: null, notes }
}

async function reworkContext(id: number): Promise<{ session: CreationSession; run: PipelineRun; recipe: CreationRecipe; planHash: string }> {
  const session = await sessionRow(id)
  await activeProject(session.projectId)
  if (!session.runId || !session.approvedPlan || !session.planHash) {
    throw new CreationError('no_run', '会话尚未开始制作，没有可返修的镜头；请继续对话完善方案', 409)
  }
  const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, session.runId))
  if (!run || run.projectId !== session.projectId) throw new CreationError('bad_run', '制作记录归属异常，不能返修', 409)
  if (run.status !== 'completed' && run.status !== 'failed') {
    throw new CreationError('rework_busy', run.status === 'waiting_input'
      ? '制作正在等待审阅，请先完成审阅决策再返修' : '本轮制作尚未收敛，请完成或失败后再返修', 409)
  }
  if (engine.isRunning(run.id)) throw new CreationError('rework_busy', '制作任务仍在途，请稍候再试', 409)
  let recipe: CreationRecipe | null = null
  try { recipe = recipeOf(run) } catch { recipe = null }
  if (!recipe) throw new CreationError('bad_run', '该制作不是轻松创作批准链，无法在会话内返修', 409)
  return { session, run, recipe, planHash: session.planHash }
}

function describePreview(preview: ReworkPreview): string {
  if (preview.unclear) return `局部返修未定位到镜头：${preview.unclear}`
  const list = preview.targets.map((t) => `第 ${t.index} 镜（${t.imagePrompt ? fieldLabel('image') : fieldLabel('motion')}）`).join('、')
  const price = preview.estimate.knownCost > 0 ? money(preview.estimate.knownCost) : '0.00 元'
  return `已解析返修指令：${list}；预估费用 ${price}${preview.estimate.unpriced.length ? `，另有 ${preview.estimate.unpriced.length} 项价格未知` : ''}。确认后才会开始重新生成。`
}

/**
 * 第一步：解析返修指令（幂等：同 requestKey 同指令回放上次解析，不重复调用模型）。
 * 全程零媒体计费；LLM 费用按 sessionId 记账，进 planningUsage 透明展示。
 */
export async function planRework(id: number, raw: unknown): Promise<ReworkPreview> {
  const request = reworkRequestSchema.parse(raw)
  const fingerprint = hashJson({ instruction: request.instruction })
  const open = await creationWrite(async () => {
    const ctx = await reworkContext(id)
    const prior = await db.select().from(creationMessages).where(and(eq(creationMessages.sessionId, id), eq(creationMessages.requestKey, request.requestKey)))
    for (const m of prior) {
      const p = jsonRecord(m.payload)
      if (p.kind !== 'rework_plan') continue
      if (p.fingerprint !== fingerprint) throw new CreationError('idempotency_conflict', '同一解析键不能用于不同返修指令', 409)
      return null
    }
    return ctx
  })
  if (!open) {
    const rows = await db.select().from(creationMessages).where(and(eq(creationMessages.sessionId, id), eq(creationMessages.requestKey, request.requestKey)))
    const replay = rows.map((m) => parseJson<Record<string, unknown>>(m.payload, {})).find((p) => p.kind === 'rework_plan' && p.preview)
    if (!replay) throw new CreationError('replay_failed', '上次解析结果读取失败，请换新的解析键重试', 409)
    return replay.preview as ReworkPreview
  }
  const { session, recipe } = open
  const fields = reworkFields(recipe.plan, recipe.videoMode)
  const ep = await requiredEndpoint('llm')
  const messages = parseMessages(recipe.plan, fields, request.instruction)
  const prices = await Promise.all(['tokens_in', 'tokens_out'].map((unit) => resolveUnitPrice({
    configId: ep.configId, provider: ep.providerKey, model: ep.model, kind: 'llm', unit: unit as 'tokens_in' | 'tokens_out',
  })))
  const budget = await checkBudget({ projectId: session.projectId, estimatedCost: Buffer.byteLength(JSON.stringify(messages)) * (prices[0] ?? 0) + 2000 * (prices[1] ?? 0) })
  if (budget) throw new CreationError(budget.code, budget.message, 409)
  const result = await chatCompleteDetailed(messages, { ...ep, baseUrl: ep.baseUrl.replace(/\/+$/, ''), model: ep.model! }, { maxTokens: 4000, temperature: 0.2, allowEmptyContent: true })
  for (const [index, unit] of (['tokens_in', 'tokens_out'] as const).entries()) await recordUsage({
    projectId: session.projectId, kind: 'llm', provider: ep.providerKey, model: ep.model,
    quantity: result.usage ? (index === 0 ? result.usage.promptTokens : result.usage.completionTokens) : 0,
    unit, unitPrice: result.usage ? prices[index] : null,
    meta: { sessionId: id, requestKey: request.requestKey, purpose: 'rework_plan' },
  })
  if (ep.apiKey && result.content.includes(ep.apiKey)) throw new CreationError('unsafe_output', '模型输出包含敏感信息，已拒绝保存', 422)
  if (result.finishReason === 'length') throw new CreationError('invalid_plan', '返修解析被截断，请缩短指令后重试', 422)
  const stripped = result.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  let reply: unknown
  try { reply = JSON.parse(stripped) as unknown } catch {
    throw new CreationError('invalid_plan', '返修解析结果不符合契约，请换一种说法重试；尚未启动任何生成', 422)
  }
  const parsed = reworkReplySchema.safeParse(reply)
  if (!parsed.success) throw new CreationError('invalid_plan', '返修解析结果不符合契约，请换一种说法重试；尚未启动任何生成', 422)
  const ops = sanitizeReply(parsed.data, recipe.plan, fields)
  const { targets, unpriced, knownCost } = estimateOf(recipe, ops.ops.map((op) => toChanges(recipe.plan, op)))
  const preview: ReworkPreview = {
    instruction: request.instruction, unclear: ops.unclear, targets, notes: ops.notes,
    estimate: { knownCost, unpriced }, planRevision: session.planRevision, planHash: open.planHash,
  }
  await creationWrite(() => db.insert(creationMessages).values({
    sessionId: id, role: 'system', content: describePreview(preview), requestKey: request.requestKey,
    payload: JSON.stringify({ kind: 'rework_plan', fingerprint, preview }), createdAt: Date.now(),
  }))
  return preview
}

/** 单项 op → 变更明细（复用同一份费用口径；解析期与确认期算法唯一） */
function toChanges(plan: CreationPlan, op: ReworkOp): AppliedChange {
  const shot = plan.shots.find((s) => s.id === op.shot_id)!
  if (op.image_prompt !== undefined) return { shotId: shot.id, field: 'image', from: shot.image_prompt, to: op.image_prompt }
  return { shotId: shot.id, field: 'motion', from: shot.motion_prompt, to: op.motion_prompt ?? '' }
}

/**
 * 第二步：确认执行返修。服务端按 ops 重算费用与未计价项（不信前端数字）→ 预算门禁 →
 * 批准链改写与任务重置同事务（保证 assertRecipeSources 执行期自校验继续成立）→ 幂等锚点为 kind='rework' 消息。
 */
export async function applyRework(id: number, raw: unknown): Promise<{ runId: number | null }> {
  const request = reworkApplySchema.parse(raw)
  // 整个确认包在 shot 层翻译下：resetShotsForRework 抛的 WorkbenchError（run_active / other_failed / no_task …）
  // 原样保留状态码与真实原因，不经路由塌成 503 掩盖「其实是没有该镜任务」这类可读失败。
  const prepared = await throughShotLayer(() => creationWrite(async () => {
    const { session, run, recipe, planHash } = await reworkContext(id)
    const prior = await db.select().from(creationMessages).where(and(eq(creationMessages.sessionId, id), eq(creationMessages.requestKey, request.idempotencyKey)))
    if (prior.some((m) => jsonRecord(m.payload).kind === 'rework')) return null
    if (session.planRevision !== request.planRevision || planHash !== request.planHash) {
      throw new CreationError('stale_plan', '方案已更新，返修解析作废，请重新解析后再确认', 409)
    }
    const fields = reworkFields(recipe.plan, recipe.videoMode)
    const { plan: newPlan, changed, notes } = applyOps(recipe.plan, request.ops, fields)
    const { unpriced, knownCost } = estimateOf(recipe, changed)
    if (unpriced.length && !request.acceptUnpriced) throw new CreationError('unpriced', '存在未知价格的生成项，请显式接受未计价项后再确认返修', 409)
    const budget = await checkBudget({ projectId: session.projectId, estimatedCost: knownCost })
    if (budget) throw new CreationError(budget.code, budget.message, 409)
    // 改写前批准链必须自洽（源资产摘要 / 模板哈希 / 会话归属）；不自洽即停机，不写半成品
    await assertRecipeSources(run, recipe)
    const now = Date.now()
    const revision = session.planRevision + 1
    const content = JSON.stringify(newPlan.shots)
    return db.transaction(async (tx) => {
      // 分镜版本链：新提示词写成新的文本资产（原样 JSON.stringify，与确认期同口径），旧版本保留可回溯
      const asset = await writeTextAsset(session.projectId, {
        name: '已批准分镜.json', purpose: 'storyboard', format: 'storyboard-json', content, runId: run.id,
        params: { creationSessionId: id, revision, rework: true },
      }, tx)
      const newRecipe = recipeSchema.parse({
        ...recipe, plan: newPlan,
        sources: [recipe.sources[0]!, recipe.sources[1]!, { id: asset.id, hash: hashJson(content) }],
      })
      const pf = parseJson<CreationPreflight>(session.preflight, {} as CreationPreflight)
      if (!pf.execution) throw new CreationError('configuration_changed', '预检快照缺失，请重新预检后再返修', 409)
      // 原地替换 plan（保持 execution 键序）→ planHash 与确认期算法逐字一致
      pf.execution.plan = newPlan
      const newPlanHash = hashJson({ plan: newPlan, execution: pf.execution })
      const claimed = await tx.update(creationSessions).set({
        plan: JSON.stringify(newPlan), approvedPlan: JSON.stringify(newRecipe), planRevision: revision, planHash: newPlanHash,
        preflight: JSON.stringify(pf), updatedAt: now,
      }).where(and(
        // 条件更新领用旧版本与旧哈希（并发下只有一人能把 planRevision 推到下一格）
        eq(creationSessions.id, id), eq(creationSessions.planRevision, session.planRevision),
        eq(creationSessions.planHash, planHash), eq(creationSessions.runId, run.id),
      )).returning()
      if (!claimed.length) throw new CreationError('conflict', '方案已被修改，请重新解析返修指令后再确认', 409)
      // run.input 是执行期唯一解析源（引擎每步重新 resolveInputs）：分镜引用与批准快照一并改写
      const input = JSON.parse(run.input) as Record<string, unknown>
      input.shots = [asset.id]
      input.recipe = JSON.stringify(newRecipe)
      const moved = await tx.update(pipelineRuns).set({ input: JSON.stringify(input), updatedAt: now })
        .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.status, run.status))).returning()
      if (!moved.length) throw new CreationError('conflict', '制作记录状态已变化，请刷新后重试', 409)
      const stepKey = reworkStepKey(recipe.plan)
      const steps: ReworkStepReset[] = [
        { stepKey, shots: changed.map((c) => ({ shotId: c.shotId, prompt: c.to })) },
        // 合成步本地重做（零模型调用）：让新镜头直接进成片，不再要求用户手动重新合成
        { stepKey: 'compose', shots: [] },
      ]
      const reset = await resetShotsForRework(run.id, steps, { allowCreation: true }, tx)
      const list = new Set(changed.map((c) => `第 ${recipe.plan.shots.findIndex((s) => s.id === c.shotId) + 1} 镜（${fieldLabel(c.field)}）`))
      await tx.insert(creationMessages).values({
        sessionId: id, role: 'system',
        content: `已开始局部返修：${[...list].join('、')}。预估费用 ${money(knownCost)}，完成后成片会自动重新合成（本地合成不再计费）。${notes.length ? `（${notes.join('；')}）` : ''}`,
        requestKey: request.idempotencyKey,
        payload: JSON.stringify({
          kind: 'rework', runId: run.id, revision, storyboardAssetId: asset.id, stepKey,
          targets: changed.map((c) => ({ shotId: c.shotId, field: c.field, to: c.to })),
          resetTaskIds: reset.resetTaskIds, estimate: { knownCost, unpriced },
        }),
        createdAt: now,
      })
      return { runId: run.id }
    })
  }))
  if (!prepared) return { runId: null }
  engine.startRun(prepared.runId)
  return prepared
}
