/**
 * M57 探针（轻松创作「意图驱动的智能载体路由」：方案产出时由服务端确定性派生一条专业链方向建议）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m57.ts [--section=signals|gating|sanitize|priority|drift]
 *
 * 隔离策略：routeHint 是纯函数（读模板目录派生白名单/label），isolatedEnv('m57', bridge templates) 即可，
 *   零 DB、零网络、零模型调用（M57 不碰钱路径提示词、不改 planningReplySchema）。
 *
 * 断言聚焦 M57 契约：
 *   - 四类越界信号（连载/多角色短剧质感/视频反推/超 60s 单条）各命中对应专业模板，无信号返 null；
 *   - vision 缺失时反推类建议不产出（沿用 M31 不降级）；
 *   - sanitize 白名单收口：越界/批准链/不存在模板/空理由一律丢弃，label 按真源回填，reason 截断 ≤80；
 *   - 优先级：连载信号高于质感信号；
 *   - 目标模板在位非批准链；routeHint 结构上不可能进 plan（strict 拒键）→ 不进 planHash（改建议不作废方案）。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元（保 parseProbeOutput 精确）。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup: envCleanup } = isolatedEnv('m57', { bridge: ['templates'] })

const SECTIONS = ['signals', 'gating', 'sanitize', 'priority', 'drift'] as const

/** 最小合法轻方案（3 镜×10 秒=30 秒，narration；供 drift 节验证 strict schema） */
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

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m57')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  const { deriveRouteHint, sanitizeRouteHint } = await import('../src/services/creation-chat/route-hint')
  const { listTemplates } = await import('../src/pipeline/loader')
  const base = { plan: null, hasVideoContentRef: false, hasVision: false } as const

  const runners: Record<string, () => Promise<void>> = {
    // ================= signals：四类越界信号各命中对应专业模板；轻内容本分不误报 =================
    signals: async () => {
      check(deriveRouteHint({ ...base, userText: '我想做一部连载短剧，一共二十集' })?.target === 'series-setup', '连载/多集 → series-setup')
      check(deriveRouteHint({ ...base, userText: '这是第二季，要继续做下去' })?.target === 'series-setup', '季度/续集措辞 → series-setup')
      check(deriveRouteHint({ ...base, userText: '两个孩子对手戏，要定妆照和背景音乐' })?.target === 'mengbao-episode', '多角色短剧质感（对手戏/定妆/BGM）→ mengbao-episode')
      check(deriveRouteHint({ ...base, userText: '想要逐句配音、角色形象一致' })?.target === 'mengbao-episode', '逐句配音/形象一致 → mengbao-episode')
      check(deriveRouteHint({ ...base, userText: '帮我反推这个视频的分镜，做同款视频', hasVideoContentRef: true, hasVision: true })?.target === 'video-reverse', '视频反推（有内容参考+vision）→ video-reverse')
      check(deriveRouteHint({ ...base, userText: '这条要 90 秒' })?.target === 'video-plan', '超 60s 单条（90 秒）→ video-plan')
      check(deriveRouteHint({ ...base, userText: '做一个 3 分钟的长片' })?.target === 'video-plan', '超 60s 单条（3 分钟）→ video-plan')
      check(deriveRouteHint({ ...base, userText: '把这张图配段旁白做成 30 秒短片' }) === null, '普通轻内容诉求 → null（不猜、不打扰）')
      check(deriveRouteHint({ ...base, userText: '一分钟以内的口播介绍新品' }) === null, '恰好 1 分钟（60s，未越界）→ null（边界不误报）')
    },

    // ================= gating：能力闸（无 vision 不产反推；无反推参考不产反推） =================
    gating: async () => {
      check(deriveRouteHint({ ...base, userText: '照这个视频的风格做同款', hasVideoContentRef: true, hasVision: false }) === null, '有反推参考但规划模型无 vision → 反推建议不产出（不降级）')
      check(deriveRouteHint({ ...base, userText: '照这个视频的风格做同款', hasVideoContentRef: false, hasVision: true }) === null, '有 vision 但未采纳内容解析参考 → 反推建议不产出')
    },

    // ================= sanitize：白名单收口（越界/批准链/不存在/空理由丢弃；label 真源回填；reason 截断） =================
    sanitize: async () => {
      const realName = listTemplates().find((m) => m.key === 'series-setup')?.name ?? ''
      check(realName.length > 0 && sanitizeRouteHint({ target: 'series-setup', reason: '立项为连载系列' })?.label === realName, '合法目标 → label 按模板真源回填（不采信入参）')
      check(sanitizeRouteHint({ target: 'easy-video', reason: '内部模板不可作专业路由目标' }) === null, '批准链模板（easy-video）目标 → 丢弃')
      check(sanitizeRouteHint({ target: 'not-a-real-template', reason: '越界目标' }) === null, '不在 ROUTE_TARGETS 白名单的目标 → 丢弃')
      check(sanitizeRouteHint({ target: 'video-plan', reason: '   ' }) === null, '空/空白理由 → 丢弃（不产 noise 建议）')
      check(sanitizeRouteHint(undefined) === null && sanitizeRouteHint(null) === null, '空输入 → null（向后兼容，缺建议不报错）')
      check(sanitizeRouteHint({ target: 'mengbao-episode', reason: '理'.repeat(200) })?.reason.length === 80, '超长理由 → 截断至 80 字（可见文案有界）')
      check((deriveRouteHint({ ...base, userText: '我想做一部连载短剧，一共二十集' })?.reason.length ?? 0) <= 80, 'detect 产出的理由同样在 80 字内（同源收口）')
    },

    // ================= priority：信号优先级（连载高于质感；避免多信号乱序） =================
    priority: async () => {
      check(deriveRouteHint({ ...base, userText: '连载短剧，两个主角对手戏还要定妆' })?.target === 'series-setup', '同时含连载与多角色质感信号 → 连载优先（先立系列再逐集）')
    },

    // ================= drift：目标模板在位且非批准链；routeHint 结构上进不了 plan（strict 拒键）=================
    drift: async () => {
      const { isCreationTemplate } = await import('../src/services/creation-chat/recipe')
      const { creationPlanSchema } = await import('../src/services/creation-chat/contract')
      const keys = new Set(listTemplates().map((m) => m.key))
      for (const t of ['series-setup', 'mengbao-episode', 'video-reverse', 'video-plan']) {
        check(keys.has(t) && !isCreationTemplate(t), `路由目标 ${t} 模板真源在位且非轻松创作批准链`)
      }
      // 结构不变式：plan schema 为 strict，routeHint 不是其字段 → 它永远进不了 plan → 永远进不了 hashJson({plan,execution})=planHash
      check(creationPlanSchema.safeParse(makePlan()).success, '基线轻方案可通过 schema（对照）')
      check(!creationPlanSchema.safeParse({ ...makePlan(), routeHint: { target: 'series-setup', label: 'x', reason: 'y' } }).success, '方案 strict schema 拒 routeHint 键 → routeHint 不可能进 plan → 不进 planHash（改建议不作废已确认方案）')
    },
  }

  await runSections({ log, title: 'M57', checker, sections: SECTIONS, runners, cleanup: envCleanup })
}

void main()
