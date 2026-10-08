/**
 * M62 探针（轻松创作「路由信号扩展」：小说改编 → novel-adapt；素材拼片/相册 → photo-montage）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m62.ts [--section=signals|priority|gating|sanitize|drift]
 *
 * 隔离策略：route-hint 是纯函数（读模板目录派生白名单/label），isolatedEnv('m62', bridge templates) 即可，
 *   零 DB、零网络、零模型调用（M62 只扩信号集，不碰钱路径提示词、不改 planningReplySchema）。
 *
 * 断言聚焦 M62 契约：
 *   - 小说改编复合判定：小说/原著/网文 + 改编动作命中 novel-adapt；片段/梗概/选段/简介排除词守卫；
 *     仅「小说风格」无改编动作不误报；
 *   - 素材拼片：强混剪词无须前置；弱词（合成/拼成…句式）双前置（hasImageRef + 图/照片/素材）才命中；
 *   - 优先级：小说+连载取 novel-adapt（整本改编正确入口）；反推词+拼片词取 image-reverse（反推优先）；
 *     「3 分钟相册」先于超时长取 photo-montage，「3 分钟故事片」仍 video-plan（零回归）；
 *   - sanitize 白名单收口：两新目标 label 按真源回填；批准链/越界目标仍被拒（回归锁）；
 *   - 全量 7 目标模板真源在位且非批准链；routeHint 结构上不可能进 plan（strict 拒键）→ 不进 planHash。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元（保 parseProbeOutput 精确）。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup: envCleanup } = isolatedEnv('m62', { bridge: ['templates'] })

const SECTIONS = ['signals', 'priority', 'gating', 'sanitize', 'drift'] as const

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
  const log = createLogger('probe-m62')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  const { deriveRouteHint, sanitizeRouteHint } = await import('../src/services/creation-chat/route-hint')
  const { listTemplates } = await import('../src/pipeline/loader')
  const base = { plan: null, hasVideoContentRef: false, hasVision: false } as const

  const runners: Record<string, () => Promise<void>> = {
    // ================= signals：小说改编三措辞 → novel-adapt；强混剪词/弱词正例 → photo-montage；反例锁 =================
    signals: async () => {
      check(deriveRouteHint({ ...base, userText: '将《万千戏台做你的光》小说改编成短剧' })?.target === 'novel-adapt', '「小说改编成短剧」→ novel-adapt')
      check(deriveRouteHint({ ...base, userText: '把这部原著改编成剧本' })?.target === 'novel-adapt', '「原著改编成剧本」→ novel-adapt')
      check(deriveRouteHint({ ...base, userText: '把这篇网文改成短剧' })?.target === 'novel-adapt', '「网文改成短剧」→ novel-adapt')
      check(deriveRouteHint({ ...base, userText: '把小说片段改编成一段视频' }) === null, '含「片段」排除词 → null（有节选走轻成片即可）')
      check(deriveRouteHint({ ...base, userText: '念一段小说梗概做个视频' }) === null, '含「梗概」排除词 → null')
      check(deriveRouteHint({ ...base, userText: '讲个小说风格的故事' }) === null, '仅「小说」字样无改编动作 → null（复合判定守卫）')
      check(deriveRouteHint({ ...base, userText: '把上次拍的素材混剪一下' })?.target === 'photo-montage', '「混剪」强词（无参考前置）→ photo-montage')
      check(deriveRouteHint({ ...base, userText: '做个电子相册' })?.target === 'photo-montage', '「电子相册」强词 → photo-montage')
      check(deriveRouteHint({ ...base, userText: '做一个相册视频' })?.target === 'photo-montage', '「相册视频」强词 → photo-montage')
      check(deriveRouteHint({ ...base, hasImageRef: true, userText: '把这些图片合成一个视频' })?.target === 'photo-montage', '图片参考 + 「图片…合成…视频」→ photo-montage（弱词正例）')
      check(deriveRouteHint({ ...base, hasImageRef: true, userText: '把这几张照片拼成视频' })?.target === 'photo-montage', '图片参考 + 「照片拼成视频」→ photo-montage（弱词正例）')
      check(deriveRouteHint({ ...base, userText: '把这段文案做成视频' }) === null, '无图类词/无图片参考的「做成视频」→ null（弱词双前置防线）')
    },

    // ================= priority：定序反例（小说→连载、反推→拼片、相册→超时长） =================
    priority: async () => {
      check(deriveRouteHint({ ...base, userText: '把这部小说改编成连载短剧' })?.target === 'novel-adapt', '小说改编 + 连载同时命中 → novel-adapt 优先（整本改编正确入口）')
      check(deriveRouteHint({ ...base, userText: '改编成连载短剧' })?.target === 'series-setup', '无小说字样的「改编成连载」→ series-setup（零回归）')
      check(deriveRouteHint({ ...base, hasImageRef: true, hasVision: true, userText: '把这些图反推提示词再拼成视频' })?.target === 'image-reverse', '反推词 + 拼片词同时命中 → image-reverse 优先（反推是参考图第一用途）')
      check(deriveRouteHint({ ...base, userText: '做个 3 分钟的相册视频' })?.target === 'photo-montage', '「3 分钟相册视频」→ photo-montage（先于超时长，不误路由 video-plan）')
      check(deriveRouteHint({ ...base, userText: '做一个 3 分钟的故事短片' })?.target === 'video-plan', '「3 分钟故事片」→ video-plan（超时长零回归）')
    },

    // ================= gating：弱词双前置防线（hasImageRef × 图类词）；强词不受限 =================
    gating: async () => {
      check(deriveRouteHint({ ...base, userText: '把这些图片合成一个视频' }) === null, '弱词句式但未采纳图片参考 → null（双前置：hasImageRef 缺失）')
      check(deriveRouteHint({ ...base, hasImageRef: true, userText: '把刚才的东西合成一个视频' }) === null, '有图片参考但无「图/照片/素材」字样 → null（双前置：图类词缺失）')
      check(deriveRouteHint({ ...base, userText: '帮我混剪一下' })?.target === 'photo-montage', '强词不受双前置限制（无参考也命中）→ photo-montage（对照锚）')
    },

    // ================= sanitize：两新目标 label 真源回填；批准链/越界仍拒（回归锁） =================
    sanitize: async () => {
      const novelName = listTemplates().find((m) => m.key === 'novel-adapt')?.name ?? ''
      const montageName = listTemplates().find((m) => m.key === 'photo-montage')?.name ?? ''
      check(novelName.length > 0 && sanitizeRouteHint({ target: 'novel-adapt', reason: '整本改编走专业链' })?.label === novelName, 'novel-adapt 目标 → label 按模板真源回填')
      check(montageName.length > 0 && sanitizeRouteHint({ target: 'photo-montage', reason: '素材直接拼片' })?.label === montageName, 'photo-montage 目标 → label 按模板真源回填')
      check(sanitizeRouteHint({ target: 'easy-video', reason: '批准链不可作专业路由目标' }) === null, '批准链模板（easy-video）目标 → 仍被拒（回归锁）')
      check(sanitizeRouteHint({ target: 'not-a-real-template', reason: '越界目标' }) === null, '白名单外目标 → 仍被拒（回归锁）')
    },

    // ================= drift：全量 7 目标在位且非批准链；routeHint 结构上进不了 plan（strict 拒键） =================
    drift: async () => {
      const { isCreationTemplate } = await import('../src/services/creation-chat/recipe')
      const { creationPlanSchema } = await import('../src/services/creation-chat/contract')
      const keys = new Set(listTemplates().map((m) => m.key))
      for (const t of ['novel-adapt', 'series-setup', 'mengbao-episode', 'video-reverse', 'image-reverse', 'photo-montage', 'video-plan']) {
        check(keys.has(t) && !isCreationTemplate(t), `路由目标 ${t} 模板真源在位且非轻松创作批准链`)
      }
      // 结构不变式：plan schema 为 strict，routeHint 不是其字段 → 它永远进不了 plan → 永远进不了 hashJson({plan,execution})=planHash
      check(creationPlanSchema.safeParse(makePlan()).success, '基线轻方案可通过 schema（对照）')
      check(!creationPlanSchema.safeParse({ ...makePlan(), routeHint: { target: 'novel-adapt', label: 'x', reason: 'y' } }).success, '方案 strict schema 拒 routeHint 键 → 不进 planHash（不变式回归）')
    },
  }

  await runSections({ log, title: 'M62', checker, sections: SECTIONS, runners, cleanup: envCleanup })
}

void main()
