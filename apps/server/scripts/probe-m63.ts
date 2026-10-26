/**
 * M63 探针（轻松创作 Agent 化：四模式决策契约 + 归一 + 结构确认闸 + 动态面板 + 角色注册表）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m63.ts [--section=route|confirm|side-cards|legacy|roles]
 *
 * 隔离策略：isolatedEnv('m63', bridge templates+prompts) 即可——本探针只断言「纯函数契约」：
 *   决策 schema / 归一 / preflightDecision 结构闸 / computeSideCards 投影 / roles 注册表。
 *   零 DB、零网络、零模型调用、零 run/workflow（确认执行链由切片 3 落地，其可测部分收敛到 routeDecisionOf 分派 + preflightDecision）。
 *
 * 断言聚焦 M63 契约（护栏「可见不静默」逐条锚定）：
 *   - route：agentRouteReplySchema/agentReplySchema strict；buildTemplateCatalog 非空且排除 easy-*（conversationOnly）；
 *     normalizeAgentReply 四形归一（clarify→null / plan→easy 旁注 / template / chain / synth）；route 承载 easy 抛错；
 *     未注册 roleKey / 能力越界回落 planner 并留痕；幽灵 asset 剔除；synth 高危 action / 步数上限拒绝；decisionHash 确定性。
 *   - confirm：routeDecisionOf 分派（agentMode≠1 / easy 决策 → null；route 决策 → 权威决策）；preflightDecision 目录漂移 /
 *     链段漂移 / synth 正过闸 / route 缺载荷；materializeInputSpec + toWorkflowToken 的 prev 语义。
 *   - side-cards：planning / ready+route / ready+plan / ready 空 / draft / 有 run（review→chainProgress→result→progress→artifacts）逐态断言。
 *   - legacy：无 roleKey/team 的旧 plan 形归一为 easy·planner；agentMode=false 会话侧卡走 planCard；老 clarify/plan 形仍可解析（零回归）。
 *   - roles：4 角齐全、resolveRole 回落、roleCan 边界（planner 可 synth / operator 不可 easy·synth）、renderRolesForPrompt 覆盖、personaPrompt 不抛。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元（保 parseProbeOutput 精确）。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup: envCleanup } = isolatedEnv('m63', { bridge: ['templates', 'prompts'] })

const SECTIONS = ['route', 'confirm', 'side-cards', 'legacy', 'roles'] as const

/** 最小合法轻方案（3 镜×10 秒=30 秒，narration；plan 形内嵌 creationPlanSchema，同 M62 逐字复用） */
function makePlan() {
  return {
    title: '小镖客', summary: '一次护送', genre: 'story' as const, duration: 30,
    aspectRatio: '9:16' as const, language: 'zh-CN' as const, mode: 'slideshow' as const, style: '古风',
    script: '风沙起。刀出鞘。人未归。',
    lines: [{ id: 'l1', text: '风沙起' }, { id: 'l2', text: '刀出鞘' }, { id: 'l3', text: '人未归' }],
    shots: [
      { id: 's1', duration: 10, image_prompt: '大漠', motion_prompt: '推近', lines: ['l1'] },
      { id: 's2', duration: 10, image_prompt: '少年', motion_prompt: '环绕', lines: ['l2'] },
      { id: 's3', duration: 10, image_prompt: '归马', motion_prompt: '下移', lines: ['l3'] },
    ],
  }
}

/** synth 正例 YAML：单 literal 步（无 prompt_tpl、无外部依赖 → validateTemplateText ok、无 warnings）。key 由归一层强制重写为 agent-s{sid}-*。 */
const SYNTH_OK_YAML = 'name: 智能临时流程\nsteps:\n  - key: say\n    action: literal\n    inputs:\n      text: hello\n'

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m63')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  const { agentDecisionSchema, agentRouteReplySchema, inputSpecItemSchema, SYNTH_STEPS_MAX } = await import('../src/services/creation-chat/agent/decision-schema')
  const { agentReplySchema, parseAgentReply } = await import('../src/services/creation-chat/agent/reply-schema')
  const { normalizeAgentReply, decisionHashOf, toWorkflowToken } = await import('../src/services/creation-chat/agent/normalize')
  const { buildTemplateCatalog } = await import('../src/services/creation-chat/agent/template-catalog')
  const { computeSideCards } = await import('../src/services/creation-chat/side-cards')
  const { preflightDecision, materializeInputSpec } = await import('../src/services/creation-chat/agent-run')
  const { routeDecisionOf } = await import('../src/services/creation-chat/route-execution')
  const { ROLE_CARDS, resolveRole, getRole, isRegisteredRole, roleCan, renderRolesForPrompt, personaPrompt, FALLBACK_ROLE } = await import('../src/services/creation-chat/agent/roles')
  const { creationPlanSchema } = await import('../src/services/creation-chat/contract')

  const catalog = buildTemplateCatalog()
  const ctx = { sessionId: 7, allowedAssetIds: new Set<number>([1, 2]) }
  const keysOf = (cards: { key: string }[]) => cards.map((c) => c.key).join('>')

  const runners: Record<string, () => Promise<void>> = {
    // ================= route：契约 strict + 目录 + 四形归一 + 可见拒绝 =================
    route: async () => {
      check(catalog.length > 0 && !catalog.some((t) => t.key.startsWith('easy-')), `可调度目录非空（${catalog.length} 项）且不含 easy-* 批准链`)
      // 目录项均带 version（snapshot 依赖）
      check(catalog.every((t) => Number.isInteger(t.version) && t.version > 0), '目录每项均为正整数 version（快照/漂移核验前置）')
      // agentRouteReplySchema strict：多余键拒
      const tplKey = catalog[0]!.key
      const goodRoute = { kind: 'route', mode: 'template', message: '走专业模板', rationale: '需求匹配', templateRun: { templateKey: tplKey } }
      check(agentRouteReplySchema.safeParse(goodRoute).success, '合法 route·template 回复通过 strict schema')
      check(!agentRouteReplySchema.safeParse({ ...goodRoute, bogus: 1 }).success, 'route 回复带未知键 → strict 拒绝')
      // agentReplySchema 三形判别联合
      check(agentReplySchema.safeParse({ kind: 'clarify', message: '再说明下', questions: ['想要多长'] }).success, 'clarify 形通过三形联合')
      check(agentReplySchema.safeParse({ kind: 'plan', message: '方案如下', plan: makePlan() }).success, 'plan 形（无 roleKey/team）通过三形联合（旧形超集）')
      // parseAgentReply：截断 / 非法 → invalid_plan（可见拒绝，不静默猜测）
      let trunc = false
      try { parseAgentReply('{"kind":"clarify"', 'length') } catch { trunc = true }
      check(trunc, 'parseAgentReply finishReason=length → 抛 invalid_plan（截断不猜测）')
      let badJson = false
      try { parseAgentReply('not json') } catch { badJson = true }
      check(badJson, 'parseAgentReply 非 JSON → 抛 invalid_plan')
      // normalizeAgentReply 四形
      check(normalizeAgentReply({ kind: 'clarify', message: 'x', questions: ['y'] } as never, catalog, ctx) === null, 'clarify 归一 → null（无决策）')
      const easyDecision = normalizeAgentReply({ kind: 'plan', message: '好', plan: makePlan() } as never, catalog, ctx)
      check(easyDecision?.mode === 'easy' && easyDecision.roleKey === 'planner', 'plan 形归一 → mode=easy·planner 旁注')
      // route·template 归一：命中目录 + snapshot 注入 + 幽灵 asset 剔除
      const tplDecision = normalizeAgentReply({
        kind: 'route', mode: 'template', message: 'm', rationale: 'r', roleKey: 'ghost-role',
        templateRun: { templateKey: tplKey, inputSpec: { cover: { kind: 'asset', assetId: 999, source: 'x' }, ok: { kind: 'asset', assetId: 1, source: 'y' } } },
      } as never, catalog, ctx)
      check(tplDecision?.mode === 'template' && tplDecision.roleKey === 'planner', '未注册 roleKey 归一回落 planner')
      check(!!tplDecision?.templateRun && tplDecision.templateRun.catalogSnapshot.key === tplKey && tplDecision.templateRun.catalogSnapshot.version === catalog[0]!.version, 'template 归一注入 catalogSnapshot（key+version）')
      const coverKept = tplDecision?.templateRun?.inputSpec?.['cover']
      const okKept = tplDecision?.templateRun?.inputSpec?.['ok']
      check(!coverKept && okKept?.kind === 'asset', '幽灵 asset(999) 剔除、会话内 asset(1) 保留（不编造来料）')
      check(!!tplDecision && tplDecision.capabilityNotes.some((n) => n.includes('999')), '剔除幽灵 asset 留痕 capabilityNotes')
      // route·chain 归一（≥2 段）
      const chainKeys = [catalog[0]!.key, catalog[1]!.key]
      const chainDecision = normalizeAgentReply({ kind: 'route', mode: 'chain', message: 'm', rationale: 'r', chain: chainKeys.map((k) => ({ templateKey: k })) } as never, catalog, ctx)
      check(chainDecision?.mode === 'chain' && (chainDecision.chain?.length ?? 0) === 2, 'chain 归一：两段模板各成段')
      // route 承载 easy → 抛错（easy 必须走 plan 完整契约）
      let easyViaRoute = false
      try { normalizeAgentReply({ kind: 'route', mode: 'easy', message: 'm', rationale: 'r' } as never, catalog, ctx) } catch { easyViaRoute = true }
      check(easyViaRoute, 'route 形承载 mode=easy → 拒绝（防绕开 creationPlanSchema 硬闸）')
      // route·template 目标不在目录 → route_invalid
      let notInCat = false
      try { normalizeAgentReply({ kind: 'route', mode: 'template', message: 'm', rationale: 'r', templateRun: { templateKey: 'no-such-template-xyz' } } as never, catalog, ctx) } catch { notInCat = true }
      check(notInCat, 'route·template 目标不在可调度目录 → 抛错（可见拒绝）')
      // synth 高危 action / 步数上限
      let danger = false
      try { normalizeAgentReply({ kind: 'route', mode: 'synth', message: 'm', rationale: 'r', synth: { yaml: 'name: x\nsteps:\n  - key: d\n    action: asset_delete\n    inputs: {}\n' } } as never, catalog, ctx) } catch { danger = true }
      check(danger, 'synth 高危动作(asset_delete) → 拒绝（前置危险拦截）')
      const manySteps = Array.from({ length: SYNTH_STEPS_MAX + 1 }, (_, i) => `  - key: s${i}\n    action: literal\n    inputs:\n      text: x`).join('\n')
      let tooMany = false
      try { normalizeAgentReply({ kind: 'route', mode: 'synth', message: 'm', rationale: 'r', synth: { yaml: `name: x\nsteps:\n${manySteps}\n` } } as never, catalog, ctx) } catch { tooMany = true }
      check(tooMany, `synth 步数超上限(${SYNTH_STEPS_MAX}) → 拒绝`)
      // decisionHash 确定性（同决策同哈希 → 确认闸语义）
      const d1 = normalizeAgentReply(goodRoute as never, catalog, ctx)
      const d2 = normalizeAgentReply(goodRoute as never, catalog, ctx)
      check(!!d1 && !!d2 && decisionHashOf(d1) === decisionHashOf(d2), 'decisionHash 对同一归一决策确定性一致（幂等/作废语义基座）')
      // inputSpecItemSchema discriminatedUnion：kind 越界拒
      check(!inputSpecItemSchema.safeParse({ kind: 'unknown', value: 1 }).success, 'inputSpec kind 越界 → 契约拒绝')
    },

    // ================= confirm：routeDecisionOf 分派 + preflightDecision 结构闸 =================
    confirm: async () => {
      // routeDecisionOf：agentMode≠1 → null（legacy/easy 会话逐字走旧路）
      const asSession = (o: Record<string, unknown>) => o as unknown as Parameters<typeof routeDecisionOf>[0]
      check(routeDecisionOf(asSession({ agentMode: 0, decision: null })) === null, 'agentMode=0 会话 routeDecisionOf → null（分派回 easy）')
      const easyDecision = normalizeAgentReply({ kind: 'plan', message: '好', plan: makePlan() } as never, catalog, ctx)
      check(routeDecisionOf(asSession({ agentMode: 1, decision: JSON.stringify(easyDecision) })) === null, 'agent 会话但 mode=easy → routeDecisionOf 仍 null（easy 走 confirmEasy）')
      const tplDecision = normalizeAgentReply({ kind: 'route', mode: 'template', message: 'm', rationale: 'r', templateRun: { templateKey: catalog[0]!.key } } as never, catalog, ctx)
      check(routeDecisionOf(asSession({ agentMode: 1, decision: JSON.stringify(tplDecision) }))?.mode === 'template', 'agent 会话 mode=template → routeDecisionOf 返回权威决策（分派 confirmRoute）')
      check(routeDecisionOf(asSession({ agentMode: 1, decision: '{bad json' })) === null, 'decision 解析失败 → routeDecisionOf 兜底 null（不崩）')
      // preflightDecision：目录漂移（版本不符）→ template_drift，绝不 ready
      const staleTpl = normalizeAgentReply({ kind: 'route', mode: 'template', message: 'm', rationale: 'r', templateRun: { templateKey: catalog[0]!.key } } as never, catalog, ctx)!
      const drifted = { ...staleTpl, templateRun: { ...staleTpl.templateRun!, catalogSnapshot: { key: staleTpl.templateRun!.catalogSnapshot.key, version: staleTpl.templateRun!.catalogSnapshot.version + 999 } } }
      const pfDrift = preflightDecision(drifted, catalog)
      check(pfDrift.ready === false && pfDrift.issues.some((i) => i.code === 'template_drift'), 'preflight：模板版本漂移 → template_drift 且不 ready')
      // preflight：synth 正例 YAML → ready（validateTemplateText 过、无 warnings）
      const synthDecision = normalizeAgentReply({ kind: 'route', mode: 'synth', message: 'm', rationale: 'r', synth: { yaml: SYNTH_OK_YAML } } as never, catalog, ctx)!
      const pfSynth = preflightDecision(synthDecision, catalog)
      check(pfSynth.ready === true && pfSynth.summary?.mode === 'synth', 'preflight：合法 synth 模板 → ready（结构闸通过）')
      // preflight：route 缺载荷 → route_invalid
      const emptyDecision = agentDecisionSchema.parse({ mode: 'template', roleKey: 'planner', confidence: 0.6, rationale: 'r' })
      const pfEmpty = preflightDecision(emptyDecision, catalog)
      check(pfEmpty.ready === false && pfEmpty.summary === null, 'preflight：template 决策缺 templateRun 载荷 → route_invalid·summary=null')
      // materializeInputSpec + toWorkflowToken：prev 语义
      const withInput = normalizeAgentReply({
        kind: 'route', mode: 'template', message: 'm', rationale: 'r',
        templateRun: { templateKey: catalog[0]!.key, inputSpec: { t: { kind: 'text', value: 'hi' }, n: { kind: 'number', value: 3 }, d: { kind: 'default' } } },
      } as never, catalog, ctx)!
      const mat = materializeInputSpec(withInput)
      check(mat['t'] === 'hi' && mat['n'] === 3 && !('d' in mat), 'materializeInputSpec：text/number 落值、default 不参与物化')
      check(toWorkflowToken({ kind: 'text', value: 'hi' }) === 'hi' && toWorkflowToken({ kind: 'prev', ref: 'script' }) === '$prev.assets:script' && toWorkflowToken({ kind: 'default' }) === undefined, 'toWorkflowToken：text 透传 / prev 补 $prev.assets: 前缀 / default→undefined')
    },

    // ================= side-cards：各会话态 → 卡片流投影（顺序敏感） =================
    'side-cards': async () => {
      const base = { agentMode: true, decisionMode: null, hasPlan: false, confirmable: false, workflowId: null, chainAwaiting: false, hasRun: false, runStatus: null, hasReview: false, hasResult: false, hasArtifacts: false, hasReverseDeliverable: false, awaitingClarify: false } as const
      check(keysOf(computeSideCards({ ...base, status: 'planning' })) === 'planning', 'planning 态 → 仅 planning 卡')
      check(keysOf(computeSideCards({ ...base, status: 'draft' })) === 'guide', 'draft 无 run 无反推产物 → guide 引导卡')
      // 纯图片反推交付：draft·无方案·无 run 但携反推产物 → 右侧抬 reverseAnalysis 成果卡（取代 guide）
      check(keysOf(computeSideCards({ ...base, status: 'draft', hasReverseDeliverable: true })) === 'reverseAnalysis', 'draft + 反推产物 → reverseAnalysis 成果卡')
      // clarify 追问态：draft·无方案·无 run 时抬「待你补充」卡，取代固定 guide（体现对话上下文）
      check(keysOf(computeSideCards({ ...base, status: 'draft', awaitingClarify: true })) === 'clarify', 'draft + clarify 追问 → clarify 待补充卡')
      check(keysOf(computeSideCards({ ...base, status: 'draft', awaitingClarify: true, hasReverseDeliverable: true })) === 'reverseAnalysis', '反推产物优先于 clarify 卡（交付不被追问遮盖）')
      // 反推产物不得劫持成片流：ready+plan 仍走 planCard（成片侧分析仍随方案留在对话流）
      check(keysOf(computeSideCards({ ...base, status: 'ready', hasPlan: true, hasReverseDeliverable: true })) === 'planCard', 'ready+plan 携反推产物 → 仍 planCard（反推不劫持成片）')
      check(keysOf(computeSideCards({ ...base, status: 'ready', decisionMode: 'template' })) === 'decisionCard', 'ready + route 决策 → decisionCard')
      check(keysOf(computeSideCards({ ...base, status: 'ready', hasPlan: true })) === 'planCard', 'ready + easy 方案 → planCard')
      check(keysOf(computeSideCards({ ...base, status: 'ready' })) === 'guide', 'ready 但无方案/决策 → guide（兜底）')
      // 有 run：review→chainProgress→result→progress→artifacts 定序
      const full = computeSideCards({ ...base, status: 'started', hasRun: true, runStatus: 'running', hasReview: true, workflowId: 12, hasResult: true, hasArtifacts: true })
      check(keysOf(full) === 'review>chainProgress>result>progress>artifacts', '有 run 全态 → review>chainProgress>result>progress>artifacts 定序')
      // 完成态无审阅/无链：result>progress>artifacts
      const done = computeSideCards({ ...base, status: 'started', hasRun: true, runStatus: 'completed', hasResult: true, hasArtifacts: true })
      check(keysOf(done) === 'result>progress>artifacts', '完成态（无 review/chain）→ result>progress>artifacts')
      // 制作中裸 run：仅 progress
      check(keysOf(computeSideCards({ ...base, status: 'started', hasRun: true, runStatus: 'running' })) === 'progress', '裸 run 制作中 → 仅 progress')
    },

    // ================= legacy：老会话逐字旧路径（零回归锁） =================
    legacy: async () => {
      // 无 roleKey/team 的旧 plan 形 → mode=easy·planner·team 空
      const d = normalizeAgentReply({ kind: 'plan', message: '好', plan: makePlan() } as never, catalog, ctx)
      check(d?.mode === 'easy' && d?.roleKey === 'planner' && (d?.team.length ?? -1) === 0, '旧 plan 形（无角色字段）归一 → easy·planner·空编队（零回归）')
      // agentMode=false 会话侧卡 → planCard（easy/legacy 面板），非 decisionCard
      check(keysOf(computeSideCards({ status: 'ready', agentMode: false, decisionMode: null, hasPlan: true, confirmable: true, workflowId: null, chainAwaiting: false, hasRun: false, runStatus: null, hasReview: false, hasResult: false, hasArtifacts: false, hasReverseDeliverable: false, awaitingClarify: false })) === 'planCard', 'legacy/easy 会话 ready → planCard（沿用旧批准面板）')
      // 老三形联合可解析老 clarify / 老 plan（新字段可选，向后兼容）
      check(agentReplySchema.safeParse({ kind: 'clarify', message: '问', questions: ['问题'] }).success, '老 clarify 回复仍解析（联合向后兼容）')
      check(agentReplySchema.safeParse({ kind: 'plan', message: '方案', plan: makePlan() }).success, '老 plan 回复仍解析（roleKey/team 可选）')
      // creationPlanSchema 逐字不动：基线轻方案仍通过（哈希不变式基座）
      check(creationPlanSchema.safeParse(makePlan()).success, '基线轻方案通过 creationPlanSchema（逐字零回归）')
      // route 分支为 strict 且缺必填键被拒（新增分支不放宽、也不影响老 plan/clarify 解析）
      check(!agentReplySchema.safeParse({ kind: 'route', mode: 'template' }).success, 'route 分支缺 message/rationale → strict 拒绝（新形不放宽契约）')
    },

    // ================= roles：注册表 + 回落 + 能力边界 + 人设加载 =================
    roles: async () => {
      const keys = ROLE_CARDS.map((r) => r.key)
      check(['planner', 'screenwriter', 'storyboard', 'operator'].every((k) => keys.includes(k)), `4 角色注册齐全（当前：${keys.join(', ')}）`)
      check(resolveRole('no-such-role').key === FALLBACK_ROLE && isRegisteredRole('no-such-role') === false, '未注册 key 归一回落 planner + isRegisteredRole=false')
      check(isRegisteredRole('operator') && getRole('operator')?.name === '运营', '已注册 key → getRole 命中中文名')
      const planner = getRole('planner')!
      const operator = getRole('operator')!
      check(roleCan(planner, 'synth'), 'planner 可产出 synth（唯一临时模板角色）')
      check(!roleCan(operator, 'synth') && !roleCan(operator, 'easy'), 'operator 声明不含 synth/easy（能力边界）')
      check(roleCan(planner, 'template', 'anything') && !roleCan(operator, 'template', 'not-in-list'), "templateKeys '*' 放行全目录 / 列表外模板拒（operator）")
      const prompt = renderRolesForPrompt()
      check(['planner', 'screenwriter', 'storyboard', 'operator'].every((k) => prompt.includes(k)), 'renderRolesForPrompt 覆盖全部角色 key（注入路由提示）')
      let personaOk = true
      try { for (const k of keys) personaPrompt(k) } catch { personaOk = false }
      check(personaOk, 'personaPrompt 对全角色不抛（读失败降级空串，不致命）')
    },
  }

  await runSections({ log, title: 'M63', checker, sections: SECTIONS, runners, cleanup: envCleanup })
}

void main()
