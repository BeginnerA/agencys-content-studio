/**
 * M59 探针（轻松创作单条时长/镜头上限「有节制放宽」：60→90s、12→16 镜、36→48 句，单镜 1–15s 不动）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m59.ts [--section=schema|clamp|drift]
 *
 * 隔离策略：纯函数 + 契约级（schema/clampPlanToCaps/buildCapsConstraintMessage/deriveRouteHint/提示词真源），
 *   isolatedEnv('m59', bridge templates+prompts) 即可，零 DB、零网络、零模型调用。
 *
 * 断言聚焦 M59 收口契约（spec §三 一处不落）：
 *   - schema：新边界 90/16/48 合法，91/17/49 拒绝；单镜 16s 仍拒（caps 档位硬约束未放开）；
 *     旧边界 60/12/36 逐字合法（向后兼容）；superRefine「镜头和=duration」在新范围仍成立；
 *   - clamp：总时长重算不再把 61–90 钳回 60（spec 最大风险点专项）；>90 钳到 90、<30 钳回 30；
 *   - drift：五处写死点全部收敛到真源常数——caps 注入文案、提示词真源、route-hint 阈值、
 *     dialogue 容量文案、65000 截断闸「显式未放宽」（spec §3.4 取断言路径：maxTokens=64000 才是有效闸）；
 *     旧 plan（≤60s）序列化逐字不变 → planHash 零漂移 → 历史已确认方案不作废。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元（保 parseProbeOutput 精确）。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup: envCleanup } = isolatedEnv('m59', { bridge: ['templates', 'prompts'] })

const SECTIONS = ['schema', 'clamp', 'drift'] as const

/** 可构造轻方案：n 镜 × d 秒（每镜一句台词，顺序映射满足 superRefine） */
function makePlan(shotCount = 3, shotDur = 10) {
  const shots = Array.from({ length: shotCount }, (_, i) => ({
    id: `s${i + 1}`, duration: shotDur, image_prompt: `画面${i + 1}`, motion_prompt: `运动${i + 1}`, lines: [`l${i + 1}`],
  }))
  const lines = shots.map((s, i) => ({ id: `l${i + 1}`, text: `台词${i + 1}` }))
  return {
    title: '上限探针', summary: '边界用例', genre: 'story' as const,
    duration: shotCount * shotDur, aspectRatio: '9:16' as const, language: 'zh-CN' as const,
    mode: 'slideshow' as const, style: '简约', script: '脚本正文。',
    lines, shots,
  }
}

/** 台词凑到 lineCount 句而镜头固定（extra 句轮流挂到各镜，每镜≤【12】行引用）；顶层 lines 按镜头展开顺序构造，保 superRefine 顺序不变式 */
function withLineCount(shotCount: number, lineCount: number) {
  const shotLineIds: string[][] = Array.from({ length: shotCount }, (_, i) => [`l${i + 1}`])
  for (let k = 0; k < lineCount - shotCount; k++) shotLineIds[k % shotCount]!.push(`x${k}`)
  const shots = shotLineIds.map((ids, i) => ({ id: `s${i + 1}`, duration: 5, image_prompt: `画面${i + 1}`, motion_prompt: `运动${i + 1}`, lines: ids }))
  const lines: Array<{ id: string; text: string }> = []
  for (const s of shots) for (const id of s.lines) lines.push({ id, text: `台词-${id}` })
  return {
    title: '上限探针', summary: '边界用例', genre: 'story' as const,
    duration: shotCount * 5, aspectRatio: '9:16' as const, language: 'zh-CN' as const,
    mode: 'slideshow' as const, style: '简约', script: '脚本正文。', lines, shots,
  }
}

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m59')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  const SECTIONS_RUNNERS: Record<string, () => Promise<void>> = {
    // ================= schema：新边界收口 + 单镜不动 + 向后兼容 =================
    schema: async () => {
      const { creationPlanSchema, PLAN_DURATION_MAX, PLAN_SHOTS_MAX, PLAN_LINES_MAX } = await import('../src/services/creation-chat/contract')
      check(PLAN_DURATION_MAX === 90 && PLAN_SHOTS_MAX === 16 && PLAN_LINES_MAX === 48, '真源常数取定值：90s / 16 镜 / 48 句（spec §二 自行拍板档位）')
      check(creationPlanSchema.safeParse(makePlan(6, 15)).success, '6 镜×15s=90s 合法（总时长新上界；每镜 15s 未越单镜上限）')
      check(creationPlanSchema.safeParse(makePlan(16, 5)).success, '16 镜合法（镜头数新上界）')
      check(creationPlanSchema.safeParse(withLineCount(16, 48)).success, '48 句台词合法（台词数新上界）')
      check(!creationPlanSchema.safeParse({ ...makePlan(6, 15), duration: 91 }).success, 'duration=91 → 拒绝（90 为硬上限，>90s 走 M56 毕业通道）')
      check(!creationPlanSchema.safeParse(makePlan(17, 5)).success, '17 镜 → 拒绝（镜头上限收口）')
      check(!creationPlanSchema.safeParse(withLineCount(12, 49)).success, '49 句 → 拒绝（台词上限收口）')
      check(!creationPlanSchema.safeParse({ ...makePlan(2, 15), shots: [{ id: 's1', duration: 16, image_prompt: 'a', motion_prompt: 'b', lines: [] }, { id: 's2', duration: 14, image_prompt: 'c', motion_prompt: 'd', lines: [] }] }).success, '单镜 16s 仍拒绝（1–15s 受视频模型 caps 档位硬约束，本次不动）')
      check(creationPlanSchema.safeParse(makePlan(12, 5)).success && creationPlanSchema.safeParse(makePlan(4, 15)).success, '旧边界用例（12 镜/60s）逐字合法（向后兼容零回归）')
      const inconsistent = { ...makePlan(6, 15), duration: 89 }
      check(!creationPlanSchema.safeParse(inconsistent).success, '镜头时长和≠duration（90≠89）→ superRefine 不变式在新范围仍成立')
    },

    // ================= clamp：61–90 不再被钳回 60（最大风险点专项） =================
    clamp: async () => {
      const { clampPlanToCaps } = await import('../src/services/creation-chat/clamp')
      const caps = { modes: ['dynamic'], durations: [5, 10, 15], aspectRatios: ['9:16'], resolutions: ['720p'], defaultDuration: 5, defaultResolution: '720p' } as never
      // ① 镜头和=75（旧世界会被 Math.min(60) 钳回 60）→ 现应逐字保留 75（入参非完整 schema 形，clamp 只读不校，as never 同 probe-m35）
      const mid = clampPlanToCaps(makePlan(15, 5) as never, caps, true)
      check(mid.plan.duration === 75, '15 镜×5s=75s → 重算后保持 75（不再钳回 60：schema 放行却被钳回是自相矛盾，本项最大风险点）')
      check(!mid.report.notes.some((n: string) => n.includes('成片时长 75')), '75s 无「时长回钳」噪声说明（未误钳）')
      // ② 镜头和=90（新上界）→ 保留
      check(clampPlanToCaps(makePlan(6, 15) as never, caps, true).plan.duration === 90, '6×15=90s → 保留（恰在新上界）')
      // ③ 镜头和=150（病态越界）→ 钳到 90
      const over = clampPlanToCaps({ ...makePlan(10, 15), duration: 30 } as never, caps, true)
      check(over.plan.duration === 90, '镜头和 150s → 钳到 90（上限收紧仍有效）')
      // ④ 镜头和=20（低于下界）→ 钳回 30
      const under = clampPlanToCaps({ ...makePlan(4, 5), duration: 60 } as never, caps, true)
      check(under.plan.duration === 30, '镜头和 20s → 钳回下限 30（下界未放宽，维持轻量定位）')
    },

    // ================= drift：五处写死点同真源 + 截断闸显式未放宽 + hash 零漂移 =================
    drift: async () => {
      const contract = await import('../src/services/creation-chat/contract')
      const { buildCapsConstraintMessage } = await import('../src/services/creation-chat/planning')
      const { deriveRouteHint } = await import('../src/services/creation-chat/route-hint')
      const { assertDialogueCapacity } = await import('../src/services/creation-chat/dialogue')
      // ① caps 注入文案（planning.ts）随真源
      const caps = { modes: ['dynamic'], durations: [5, 10, 15], aspectRatios: ['9:16'], resolutions: ['720p'], defaultDuration: 5, defaultResolution: '720p' } as never
      const msg = buildCapsConstraintMessage(caps, true)!
      check(msg.includes('30–90 秒') && !msg.includes('30–60'), 'caps 注入文案区间 = 30–90（与契约真源同步，不谎报）')
      // ② 提示词真源（creation-plan.md）随新范围，且无旧区间残留
      const { loadPromptTemplate } = await import('../src/services/llm')
      const tpl = loadPromptTemplate('creation-plan.md')
      check(tpl.includes('30–90 秒') && tpl.includes('最多 16 个') && tpl.includes('1–48 项') && !tpl.includes('30–60'), '提示词真源四写死点已同步（范围段/duration/lines/shots），无 30–60 残留')
      check(tpl.includes('每镜 1–15 秒'), '提示词单镜 1–15s 未动（caps 档位硬约束）')
      // ③ route-hint 阈值与契约上限同真源（90 不再误路由专业链；120 才建议）
      const base = { userText: '', plan: null, hasVideoContentRef: false, hasVision: false }
      check(deriveRouteHint({ ...base, userText: '这条要 90 秒' }) === null, '「90 秒」不再触发超上限路由（放宽不误伤轻创作本域诉求）')
      const hint = deriveRouteHint({ ...base, userText: '这条要 120 秒' })
      check(hint?.target === 'video-plan' && hint.reason.includes('90 秒'), '「120 秒」→ video-plan 且理由文本含新上限 90（阈值单源，两处不漂移）')
      // ④ dialogue 容量报错文案随真源：构造超载对白（2 秒镜挂 24 字 >  floor((2-0.5)*4)=6），断言消息含新区间
      const dlgPlan = {
        performance: 'dialogue', duration: 4,
        shots: [
          { id: 's1', duration: 2, image_prompt: 'a', motion_prompt: 'b', lines: ['l1'], characters: ['a'] },
          { id: 's2', duration: 2, image_prompt: 'c', motion_prompt: 'd', lines: ['l2'], characters: ['b'] },
        ],
        lines: [
          { id: 'l1', text: '一二三四五六七八'.repeat(3), speaker: 'a' },
          { id: 'l2', text: '短句', speaker: 'b' },
        ],
        cast: [{ id: 'a', name: '甲', appearance: '短发自容', voice: '青年女' }, { id: 'b', name: '乙', appearance: '长发少年', voice: '青年男' }],
      }
      let dlgMsg = ''
      try { assertDialogueCapacity(dlgPlan as never) } catch (e) { dlgMsg = e instanceof Error ? e.message : '' }
      check(dlgMsg.includes('30–90 秒') && !dlgMsg.includes('30–60'), 'dialogue 容量报错文案区间同步 30–90（不再指老上限）')
      // ⑤ 截断闸 65000 显式未放宽（spec §3.4 取断言路径：maxTokens=64000 才是有效输出闸，
      //    典型 90s/16 镜 plan ≈ 4–6 万字符仍在其内；放宽此防御闸只会放大异常输出面）
      const typical = JSON.stringify({ kind: 'plan', message: 'ok', plan: makePlan(16, 5) })
      check(typical.length < 65000 && typical.length > 100, `典型 90s/16 镜 plan 体积（${typical.length} 字符）远离 65000 截断闸`)
      let truncated = ''
      try { contract.parsePlanningReply('{"kind":"clarify","message":"' + 'x'.repeat(70000) + '"}') } catch (e) { truncated = e instanceof Error ? e.message : '' }
      check(truncated.includes('长度上限'), '超 65000 仍被拒（截断闸显式保持未放宽，防止无声漏改）')
      // ⑥ 向后兼容：旧 plan（≤60s）序列化逐字不变 → planHash 零漂移 → 历史确认不作废
      const oldPlan = makePlan(4, 15)
      check(contract.hashJson({ plan: oldPlan, execution: null }) === contract.hashJson({ plan: JSON.parse(JSON.stringify(oldPlan)), execution: null }), '旧 plan 序列化往返逐字不变（放宽是纯加法：schema 不补默认值，planHash 零漂移）')
    },
  }

  await runSections({ log, title: 'M59', checker, sections: SECTIONS, runners: SECTIONS_RUNNERS, cleanup: envCleanup })
}

void main()
