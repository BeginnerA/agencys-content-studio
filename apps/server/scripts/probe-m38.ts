/**
 * M38 探针（扩展参数单一真源注册表 + 音色 Tier A 默认兜底）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m38.ts [--section=registry|preflight]
 *
 * 隔离策略：isolatedEnv('m38', bridge templates/prompts) 一次性临时目录（独立 studio.db + workspace），
 * 必须先于任何 src 动态 import。零网络、零付费模型调用、零计费：resolveExtraSchema/defaultVoice 为纯函数，
 * preflightPlan 为只读函数（仅读 api_configs + 计算预估，绝不触发生成）。
 *
 * 分节：
 *   - registry：resolveExtraSchema 逐供应商字段完整/类型正确（voice 枚举+默认、volcengine appid.required、
 *     llm vision=boolean、video 不含 creationCapabilities、未知 → []）；defaultVoice 逐 provider 命中，
 *     无安全默认（siliconflow/未知）→ 空串（不猜）；
 *   - preflight：audio 实例 extra.voice 为空 → 按真源默认兜底（ready、execution.voice=默认），
 *     显式配置覆盖默认，clone: 仍拒（红线），无默认供应商仍 missing_voice（不注入占位）。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup: envCleanup } = isolatedEnv('m38', { bridge: ['templates', 'prompts'] })
process.env.PROBE_M38_KEY = 'probe-m38-offline-secret-key-b7e1'

const SECTIONS = ['registry', 'preflight'] as const

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m38')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  // ================= registry：字段清单 + 默认音色（纯函数，不触库） =================
  const registry = async (): Promise<void> => {
    const { resolveExtraSchema, defaultVoice } = await import('../src/adapters/extra-params')

    const aliyun = resolveExtraSchema('aliyun_qwen_tts', 'audio')
    const aVoice = aliyun.find((f) => f.key === 'voice')
    check(!!aVoice && aVoice.type === 'select' && aVoice.default === 'Cherry' && (aVoice.options ?? []).some((o) => o.value === 'Cherry'), 'aliyun voice：select + 默认 Cherry + 枚举含 Cherry')
    check(aliyun.some((f) => f.key === 'emotion_param') && aliyun.some((f) => f.key === 'emotion_map'), 'aliyun 含情绪透传字段（emotion_param/emotion_map）')
    check(!aliyun.some((f) => f.key === 'appid'), 'aliyun 无 appid（仅火山需要）')

    const volc = resolveExtraSchema('volcengine_audio', 'audio')
    const vAppid = volc.find((f) => f.key === 'appid')
    const vCluster = volc.find((f) => f.key === 'cluster')
    const vVoice = volc.find((f) => f.key === 'voice')
    check(!!vAppid && vAppid.required === true, 'volcengine appid：required=true（无默认，适配器强依赖）')
    check(!!vCluster && vCluster.default === 'volcano_tts', 'volcengine cluster：默认 volcano_tts')
    check(!!vVoice && vVoice.type === 'text' && vVoice.default === 'BV700_streaming', 'volcengine voice：text + 默认 BV700_streaming（对齐适配器）')

    const openai = resolveExtraSchema('openai_audio', 'audio').find((f) => f.key === 'voice')
    check(!!openai && openai.type === 'select' && openai.default === 'alloy', 'openai voice：select + 默认 alloy')
    const poll = resolveExtraSchema('pollinations_audio', 'audio').find((f) => f.key === 'voice')
    check(!!poll && (poll.options ?? []).some((o) => o.value === 'Cherry') && poll.default === 'alloy', 'pollinations voice：含 Cherry（Qwen 原生）+ 默认 alloy')
    const sfVoice = resolveExtraSchema('siliconflow_audio', 'audio').find((f) => f.key === 'voice')
    check(!!sfVoice && sfVoice.type === 'text' && sfVoice.default === undefined, 'siliconflow voice：text 无默认（模型:音色 格式，不猜）')

    const img = resolveExtraSchema('openai_image', 'image').find((f) => f.key === 'size')
    check(!!img && img.type === 'text' && img.default === '1024x1024', 'image size：text + 默认 1024x1024')

    const llm = resolveExtraSchema('deepseek_llm', 'llm').find((f) => f.key === 'vision')
    check(!!llm && llm.type === 'boolean', 'llm vision：boolean（参考视频/图片解析需 true）')

    const volcVideo = resolveExtraSchema('volcengine_video', 'video')
    check(volcVideo.some((f) => f.key === 'referenceImageUrls' && f.type === 'url-list') && volcVideo.some((f) => f.key === 'generateAudio' && f.type === 'boolean') && volcVideo.some((f) => f.key === 'watermark' && f.type === 'boolean'), 'volcengine video：参考 URL 列表 + generateAudio/watermark 开关')
    check(!volcVideo.some((f) => f.key === 'creationCapabilities'), 'creationCapabilities 不纳入注册表（由 VideoCapsEditor 专管）')
    const pollVideo = resolveExtraSchema('pollinations_video', 'video')
    check(pollVideo.some((f) => f.key === 'seed' && f.type === 'number') && pollVideo.some((f) => f.key === 'audio' && f.type === 'boolean'), 'pollinations video：seed 数字 + audio 开关')
    const miniVideo = resolveExtraSchema('minimax_video', 'video')
    check(miniVideo.every((f) => f.type === 'url-list') && miniVideo.length === 3, 'minimax video：仅三类参考 URL 列表（无 generateAudio/watermark）')
    check(resolveExtraSchema('unknown_provider', 'weird').length === 0, '未知供应商/通道 → 空（回退裸 JSON 透传，不猜）')

    check(defaultVoice('aliyun_qwen_tts') === 'Cherry' && defaultVoice('openai_audio') === 'alloy' && defaultVoice('pollinations_audio') === 'alloy' && defaultVoice('volcengine_audio') === 'BV700_streaming', 'defaultVoice：aliyun→Cherry / openai·pollinations→alloy / volcengine→BV700_streaming')
    check(defaultVoice('siliconflow_audio') === '' && defaultVoice('unknown_audio') === '', 'defaultVoice：siliconflow/未知 → 空（无安全默认，不注入占位音色）')
  }

  // ================= preflight：音色 Tier A 默认兜底 / clone 拒绝 / 无默认仍报错 =================
  const preflight = async (): Promise<void> => {
    const { initDb, db } = await import('../src/db')
    await initDb()
    const { apiConfigs, projects } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    const { creationPlanSchema } = await import('../src/services/creation-chat/contract')
    const { preflightPlan } = await import('../src/services/creation-chat/preflight')

    const t = Date.now()
    const mkProject = async (name: string): Promise<number> =>
      (await db.insert(projects).values({ name, genre: 'talking_head', templateKey: 'easy-video', status: 'active', settings: '{}', tags: '[]', createdAt: t, updatedAt: t } as never).returning())[0]!.id

    // slideshow 仅需 llm + audio(+voice) + image（不触 video 档位复杂度）
    const seed = async (audio: { providerKey: string; voice?: string }): Promise<void> => {
      for (const s of ['llm', 'audio', 'image']) await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, s))
      const ins = (v: Record<string, unknown>) => db.insert(apiConfigs).values({ name: String(v.name), providerKey: v.providerKey, serviceType: v.serviceType, apiKeyRef: 'env:PROBE_M38_KEY', baseUrl: 'http://localhost:0/offline', model: v.model, extra: JSON.stringify(v.extra ?? {}), pricing: v.pricing ?? '{}', isActive: 1, isDefault: 1, priority: 0, createdAt: t, updatedAt: t } as never)
      await ins({ name: 'llm', providerKey: 'deepseek_llm', serviceType: 'llm', model: 'probe-llm', pricing: '{"tokens_in":2,"tokens_out":8}' })
      await ins({ name: 'audio', providerKey: audio.providerKey, serviceType: 'audio', model: 'probe-tts', extra: audio.voice ? { voice: audio.voice } : {}, pricing: '{"char":0.1}' })
      await ins({ name: 'image', providerKey: 'openai_image', serviceType: 'image', model: 'probe-img', pricing: '{"image":0.1}' })
    }
    const plan = creationPlanSchema.parse({
      title: 'M38 探针方案', summary: '三镜', genre: 'science', duration: 30, aspectRatio: '9:16',
      language: 'zh-CN', mode: 'slideshow', style: '轻松科普', script: '一。\n二。\n三。',
      lines: [{ id: 'l1', text: '一' }, { id: 'l2', text: '二' }, { id: 'l3', text: '三' }],
      shots: [
        { id: 's1', duration: 10, image_prompt: 'A', motion_prompt: '推近', lines: ['l1'] },
        { id: 's2', duration: 10, image_prompt: 'B', motion_prompt: '环绕', lines: ['l2'] },
        { id: 's3', duration: 10, image_prompt: 'C', motion_prompt: '下移', lines: ['l3'] },
      ],
      refs: [],
    })
    const run = async (audio: { providerKey: string; voice?: string }, name: string) => {
      await seed(audio)
      return preflightPlan(await mkProject(name), plan as never)
    }

    const pfAliyun = await run({ providerKey: 'aliyun_qwen_tts' }, 'm38-pf-aliyun-nodefault')
    check(pfAliyun.ready, `aliyun 未配 voice：预检就绪（Tier A 默认兜底，不再强制手填）${pfAliyun.issues.length ? ' 实际 issues=' + JSON.stringify(pfAliyun.issues) : ''}`)
    check(pfAliyun.execution?.voice === 'Cherry', '兜底执行音色 = 供应商真源默认 Cherry')

    const pfOpenai = await run({ providerKey: 'openai_audio' }, 'm38-pf-openai-nodefault')
    check(pfOpenai.ready && pfOpenai.execution?.voice === 'alloy', 'openai 未配 voice：就绪且默认 alloy')

    const pfExplicit = await run({ providerKey: 'openai_audio', voice: 'nova' }, 'm38-pf-explicit')
    check(pfExplicit.ready && pfExplicit.execution?.voice === 'nova', '显式配置 voice=nova：覆盖默认')

    const pfClone = await run({ providerKey: 'openai_audio', voice: 'clone:5' }, 'm38-pf-clone')
    check(pfClone.issues.some((i) => i.code === 'missing_voice'), 'clone: 音色 → 仍拒 missing_voice（轻松创作不用克隆声音，红线不降）')

    const pfSf = await run({ providerKey: 'siliconflow_audio' }, 'm38-pf-siliconflow')
    check(pfSf.issues.some((i) => i.code === 'missing_voice'), 'siliconflow 无 voice 且无安全默认 → 仍 missing_voice（不猜、不注入占位）')
  }

  const runners: Record<string, () => Promise<void>> = { registry, preflight }
  await runSections({ log, title: 'M38', checker, sections: SECTIONS, runners, cleanup: envCleanup })
}

void main()
