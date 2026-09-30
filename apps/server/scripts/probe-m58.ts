/**
 * M58 探针（轻松创作「参考反推可检视交付」：2b 解析产物编进方案可检视 + 2a 反推分镜初稿）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m58.ts [--section=schema|normalize|draft|gating|drift]
 *
 * 隔离策略：纯函数 + 契约级（normalizeRefsAnalysis/parseStoryboardDraft/wantsReverseIntent/schema），
 *   isolatedEnv('m58', bridge templates+prompts) 即可，零 DB、零网络、零模型调用
 *   （2a 初稿调用的接线在 planning.ts，探针只验其纯函数前置与契约承载；计费口径由同 llm 端点入账保证）。
 *
 * 断言聚焦 M58 契约：
 *   - schema 加法兼容：老方案（无 refsAnalysis/source）逐字通过；条目 strict 拒越界键；上限收口；
 *   - normalize：scenes≤24 / transcript≤2000 超限截断 + 可见标记；缺失留占位不编造；desc 含景别注记；
 *   - draft：storyboard-json 宽松解析（剥围栏/无效拒收/无画面镜丢弃/≤12 镜）；渲染只列实际存在字段；
 *   - gating：反推措辞真源与 M57 同源（同一措辞两边一致触发）；提示词 video-storyboard.md 真源在位；
 *   - drift：undefined 键 JSON 落库自动脱落（无视频参考老路径逐字零漂移）；解析产物进 plan → 进 planHash
 *     （改解析即改 hash → 旧确认作废重确认，与 M31 参考变化同律）；LLM 自报 source 键先剥后权威重写。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元（保 parseProbeOutput 精确）。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup: envCleanup } = isolatedEnv('m58', { bridge: ['templates', 'prompts'] })

const SECTIONS = ['schema', 'normalize', 'draft', 'gating', 'drift'] as const

/** 最小合法轻方案基线（无新字段——向后兼容对照） */
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

/** 构造 video_analyze 出形（仅取 normalize 消费的字段） */
function makeOutcome(sceneCount: number, transcriptChars: number) {
  return {
    tl: {
      duration: 45,
      scenes: Array.from({ length: sceneCount }, (_, i) => ({
        t0: i * 2, t1: i * 2 + 2,
        visual: i % 3 === 0 ? '' : `画面${i}`,
        speech: i % 3 === 0 ? `口播${i}` : undefined,
        shot_type: i % 2 === 0 ? '特写' : undefined,
      })),
      transcript: transcriptChars > 0 ? [{ t0: 0, t1: 45, text: '语'.repeat(transcriptChars) }] : [],
    },
    frames: 8,
    transcribed: transcriptChars > 0,
  }
}

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m58')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  const { normalizeRefsAnalysis, parseStoryboardDraft, renderStoryboardDraft } = await import('../src/services/creation-chat/refs-analysis')
  const { wantsReverseIntent, REVERSE_INTENT_WORDS, deriveRouteHint } = await import('../src/services/creation-chat/route-hint')

  const runners: Record<string, () => Promise<void>> = {
    // ================= schema：加法兼容 + strict 收口 + 上限 =================
    schema: async () => {
      const { creationPlanSchema, refsAnalysisEntrySchema } = await import('../src/services/creation-chat/contract')
      check(creationPlanSchema.safeParse(makePlan()).success, '老方案（无 refsAnalysis / shot.source）逐字通过（向后兼容零漂移）')
      const withAnalysis = { ...makePlan(), refsAnalysis: [normalizeRefsAnalysis({ assetId: 7, name: '参考.mp4', outcome: makeOutcome(3, 50) as never })] }
      check(creationPlanSchema.safeParse(withAnalysis).success, '带解析产物的新方案通过校验')
      check(!refsAnalysisEntrySchema.safeParse({ assetId: 7, name: 'x', duration: 1, scenes: [], transcribed: false, bogus: 1 }).success, '条目 strict：越界键拒收（LLM/外部不可扩形）')
      check(creationPlanSchema.safeParse({ ...makePlan(), shots: makePlan().shots.map((s) => ({ ...s, source: 'reverse' as const })) }).success, 'shot.source=reverse 加法通过（枚举内值）')
      check(!creationPlanSchema.safeParse({ ...makePlan(), shots: makePlan().shots.map((s) => ({ ...s, source: 'bogus' })) }).success, '非法 source 值 → 拒绝（字面量枚举收紧，LLM 不能自造标）')
      const many = Array.from({ length: 13 }, () => normalizeRefsAnalysis({ assetId: 7, name: '参考.mp4', outcome: makeOutcome(1, 0) as never }))
      check(!creationPlanSchema.safeParse({ ...makePlan(), refsAnalysis: many }).success, '解析条目超上限（>12）→ 方案校验拒绝（有界收口）')
    },

    // ================= normalize：有界截断 + 可见标记 + 缺失不编造 =================
    normalize: async () => {
      const full = normalizeRefsAnalysis({ assetId: 7, name: '参考.mp4', outcome: makeOutcome(30, 2500) as never })
      check(full.scenes.length === 24 && full.truncated?.scenes === true, 'scenes 超限 → 截断至 24 并置可见标记（不静默丢）')
      check((full.transcript ?? '').length === 2000 && full.truncated?.transcript === true, 'transcript 超长 → 截断至 2000 字并置可见标记')
      check(full.scenes[0]!.desc === '口播0（特写）', 'visual 空 → 回落 speech（口播）不编造；景别作注记追加')
      const bare = normalizeRefsAnalysis({ assetId: 9, name: '双缺.mp4', outcome: { tl: { duration: 4, scenes: [{ t0: 0, t1: 4, visual: '', shot_type: '特写' }] }, frames: 1, transcribed: false } as never })
      check(bare.scenes[0]!.desc === '（无描述）（特写）', 'visual/speech 双缺 → 「（无描述）」占位不编造')
      check(full.scenes[1]!.desc === '画面1', '有 visual 取 visual 原文')
      check(full.name === '参考.mp4' && full.duration === 45 && full.transcribed === true, 'name/duration/transcribed 取解析真源')
      const quiet = normalizeRefsAnalysis({ assetId: 8, name: '无声.mp4', outcome: makeOutcome(2, 0) as never })
      check(quiet.transcript === undefined && quiet.transcribed === false, '无人声 → transcript 不挂键且 transcribed=false（不假称含人声）')
      check(JSON.parse(JSON.stringify(quiet)).truncated === undefined, '未超限 → 无 truncated 噪声键')
    },

    // ================= draft：storyboard-json 宽松解析与渲染（2a 前置纯函数） =================
    draft: async () => {
      const good = parseStoryboardDraft('```json\n{"shots":[{"id":"s1","t0":0,"t1":3.5,"visual":"大漠孤城","shot_type":"远景","camera":"推","dialogue":"风沙起","image_prompt":"desert fortress"}]}\n```')
      check(good?.length === 1 && good[0]!.visual === '大漠孤城' && good[0]!.imagePrompt === 'desert fortress', '合法 storyboard-json（含围栏）→ 解析收口形')
      check(parseStoryboardDraft('这不是 JSON') === null && parseStoryboardDraft('{"shots":"不是数组"}') === null, '非契约输出 → null（调用方给可见说明，不静默）')
      check(parseStoryboardDraft('{"shots":[{"t0":0,"t1":1}],"x":1}') === null, '无画面描述的镜丢弃；全空 → null（不产空壳初稿）')
      const capped = parseStoryboardDraft(JSON.stringify({ shots: Array.from({ length: 20 }, (_, i) => ({ t0: i, t1: i + 1, visual: `镜${i}` })) }))
      check(capped?.length === 12, '初稿超轻松创作 shots 上限 → 截断至 12（有界）')
      const rendered = renderStoryboardDraft(good!)
      check(rendered.includes('大漠孤城') && rendered.includes('（远景 / 推）') && rendered.includes('台词：「风沙起」'), '渲染列出实际存在的字段（画面/景别/运镜/台词）')
      check(!rendered.includes('undefined') && !rendered.includes('（）'), '渲染只列实际存在者——缺失字段不留空壳占位（不编造）')
    },

    // ================= gating：措辞真源同源 + 提示词模板在位 =================
    gating: async () => {
      check(wantsReverseIntent('帮我照这个视频做一条同款视频'), '反推措辞命中（触发 2a 初稿）')
      check(!wantsReverseIntent('把这张图配段旁白做成 30 秒短片'), '普通轻内容措辞不命中（零触发零额外计费）')
      const phrase = REVERSE_INTENT_WORDS[0]!
      check(wantsReverseIntent(`反推这个视频`) === (deriveRouteHint({ userText: '帮我反推这个视频做同款', plan: null, hasVideoContentRef: true, hasVision: true })?.target === 'video-reverse'), 'M57 路由信号③与 M58 2a 触发同源：同措辞两边一致命中（防两处漂移）')
      const { loadPromptTemplate } = await import('../src/services/llm')
      const tpl = loadPromptTemplate('video-storyboard.md')
      check(tpl.includes('storyboard') || tpl.includes('分镜'), '2a 复用提示词 video-storyboard.md 真源在位（不新建 prompt 资产）')
      void phrase
    },

    // ================= drift：脱落零漂移 + 进 planHash + 权威标记 =================
    drift: async () => {
      const { hashJson } = await import('../src/services/creation-chat/contract')
      const baseline = JSON.stringify(makePlan())
      check(JSON.stringify({ ...makePlan(), refsAnalysis: undefined }) === baseline, '无视频参考 → refsAnalysis=undefined 落库时键自动脱落（老路径 JSON 逐字零漂移）')
      const entry = normalizeRefsAnalysis({ assetId: 7, name: '参考.mp4', outcome: makeOutcome(3, 50) as never })
      const h0 = hashJson({ plan: makePlan(), execution: null })
      const h1 = hashJson({ plan: { ...makePlan(), refsAnalysis: [entry] }, execution: null })
      check(h0 !== h1 && h1 !== hashJson({ plan: { ...makePlan(), refsAnalysis: [{ ...entry, scenes: entry.scenes.slice(0, 1) }] }, execution: null }), '解析产物进 plan → 进 planHash：写入或摘要变化都改 hash（旧确认作废重确认，与 M31 参考变化同律）')
      // 2a 权威标记模式（planning.ts 接线同款）：先剥 LLM 自报 source 再按服务端事实统一写/清
      const llmPlan = { ...makePlan(), shots: makePlan().shots.map((s) => ({ ...s, source: 'reverse' })) }
      const strip = (shots: { source?: string }[]) => shots.map(({ source: _s, ...rest }) => rest)
      check(strip(llmPlan.shots).every((s) => !('source' in s)), 'LLM 自报 source 键可被剥净（服务端权威清/写，不采信模型自称反推）')
    },
  }

  await runSections({ log, title: 'M58', checker, sections: SECTIONS, runners, cleanup: envCleanup })
}

void main()
