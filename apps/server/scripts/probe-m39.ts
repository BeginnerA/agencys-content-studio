/**
 * M39 探针（扩展参数逐模型能力下沉：audio.voice / image.size profile + model 参数贯穿）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m39.ts [--section=registry|route|preflight]
 *
 * 隔离策略：isolatedEnv('m39', bridge templates/prompts) 一次性临时目录（独立 studio.db + workspace），
 * 必须先于任何 src 动态 import。零网络、零付费模型调用、零计费：resolveExtraSchema/defaultVoice/
 * defaultImageSize 为纯函数；route 节 app.request 内存执行且 extra-schema 端点只读；preflightPlan 只读计算。
 *
 * 分节：
 *   - registry：逐模型命中（aliyun qwen3-tts 系专属枚举/默认；未注册模型回落 provider 级 4 音色；
 *     openai 两代音色差异；siliconflow CosyVoice2 候选=合成后「模型:音色」完整串；pollinations qwen 枚举 /
 *     elevenlabs text 无假默认；image 命中族→select 档位或 text 核实约束、未命中→provider 级）；
 *     defaultVoice / defaultImageSize 回落链（profile→provider 级→空/'1024x1024'）；
 *   - route：extra-schema 带/不带 model 双形态（不带 = M38 现行为，旧调用兼容；缺参 400）；
 *   - preflight：音色兜底升级为模型级（siliconflow CosyVoice2 未配 voice → ready 且取模型级默认，
 *     provider 级无默认仍被逐模型事实补上）；未核实音色集（elevenlabs 实例）无默认 → 仍 missing_voice（不猜）；
 *     图像未配 size → 逐模型默认（qwen-image-max 不再注入非法 1024x1024）；[1-4]K 档位透传（wan2.7 系）。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup: envCleanup } = isolatedEnv('m39', { bridge: ['templates', 'prompts'] })
process.env.PROBE_M39_KEY = 'probe-m39-offline-secret-key-9c3a'

const SECTIONS = ['registry', 'route', 'preflight'] as const

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m39')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  // ================= registry：逐模型 profile 解析（纯函数，不触库） =================
  const registry = async (): Promise<void> => {
    const { resolveExtraSchema, defaultVoice, defaultImageSize } = await import('../src/adapters/extra-params')
    const voiceField = (p: string, m?: string) => resolveExtraSchema(p, 'audio', m).find((f) => f.key === 'voice')
    const sizeField = (p: string, m?: string) => resolveExtraSchema(p, 'image', m).find((f) => f.key === 'size')

    // 阿里云千问 TTS：qwen3-tts 系逐模型专属枚举（官方音色列表核实），qwen-tts 老一代回落 provider 级
    const instruct = voiceField('aliyun_bailian_tts', 'qwen3-tts-instruct-flash')
    check(!!instruct && instruct.type === 'select' && (instruct.options ?? []).some((o) => o.value === 'Eldric Sage') && (instruct.options ?? []).every((o) => !o.value.startsWith('Jennifer')), 'aliyun qwen3-tts-instruct-flash：专属枚举（含 Eldric Sage、不含 flash 系独有 Jennifer）')
    check(!!instruct && instruct.default === 'Cherry' && !!instruct.help && instruct.help.includes('instruct'), 'instruct profile：默认 Cherry + help 标注情绪指令能力')
    const flash = voiceField('aliyun_bailian_tts', 'qwen3-tts-flash-2025-11-17')
    check(!!flash && flash.type === 'select' && (flash.options ?? []).some((o) => o.value === 'Jennifer') && (flash.options ?? []).some((o) => o.value === 'Roy'), 'qwen3-tts-flash（含快照版）：36 音色集含美语/方言音色')
    const legacy = voiceField('aliyun_bailian_tts', 'qwen-tts')
    check(!!legacy && legacy.type === 'select' && (legacy.options ?? []).length === 4 && (legacy.options ?? []).some((o) => o.value === 'Chelsie'), '未注册 profile 的 qwen-tts：回落 provider 级 4 音色（行为不劣于 M38）')

    // OpenAI：gpt-4o-mini-tts 11 音色 vs tts-1 系 9 音色（ballad/verse 仅前者）
    const oai4o = voiceField('openai_audio', 'gpt-4o-mini-tts')
    check(!!oai4o && (oai4o.options ?? []).some((o) => o.value === 'ballad') && (oai4o.options ?? []).some((o) => o.value === 'verse') && oai4o.default === 'alloy', 'gpt-4o-mini-tts：11 音色含 ballad/verse')
    const oaiTts1 = voiceField('openai_audio', 'tts-1-hd')
    check(!!oaiTts1 && (oaiTts1.options ?? []).length === 9 && !(oaiTts1.options ?? []).some((o) => o.value === 'ballad'), 'tts-1/tts-1-hd：9 音色不含 ballad')

    // SiliconFlow：CosyVoice2 官方 8 预置音色，候选/默认合成「模型:音色」完整串（编辑器零新语义）
    const cosy = voiceField('siliconflow_audio', 'FunAudioLLM/CosyVoice2-0.5B')
    check(!!cosy && cosy.type === 'select' && (cosy.options ?? []).every((o) => o.value.startsWith('FunAudioLLM/CosyVoice2-0.5B:')) && (cosy.options ?? []).some((o) => o.value === 'FunAudioLLM/CosyVoice2-0.5B:alex'), 'CosyVoice2：候选为合成后「模型:音色」完整串')
    check(!!cosy && cosy.default === 'FunAudioLLM/CosyVoice2-0.5B:alex', 'CosyVoice2：模型级默认 alex（官方预置，存库含前缀）')
    const sfNoModel = voiceField('siliconflow_audio')
    check(!!sfNoModel && sfNoModel.type === 'text' && sfNoModel.default === undefined, 'siliconflow 不传 model：仍 provider 级 text 无默认（不猜）')
    const sfOther = voiceField('siliconflow_audio', 'fnlp/MOSS-TTSD-v0.5')
    check(!!sfOther && sfOther.type === 'text', 'siliconflow 未核实模型（MOSS-TTSD）：回落 provider 级 text')

    // Pollinations 网关：qwen 系实测枚举；elevenlabs/kokoro 未核实 → text 无假默认（不注入 alloy 致运行时 400）
    const polQwen = voiceField('pollinations_audio', 'qwen/qwen3-tts-flash')
    check(!!polQwen && polQwen.type === 'select' && (polQwen.options ?? []).some((o) => o.value === 'Cherry') && polQwen.default === 'alloy', 'pollinations qwen/：实测枚举（alloy/Cherry/echo/nova）+ 默认 alloy')
    const polElv = voiceField('pollinations_audio', 'elevenlabs/eleven-flash-v2.5')
    check(!!polElv && polElv.type === 'text' && polElv.default === undefined, 'pollinations elevenlabs/：text 且无默认（枚举未核实，不猜 alloy 假默认）')

    // 图像：命中族 → select 官方档位 / text 核实约束；未命中 → provider 级通用文本框
    const wanPro = sizeField('aliyun_bailian_image', 'wan2.7-image-pro')
    check(!!wanPro && wanPro.type === 'select' && (wanPro.options ?? []).some((o) => o.value === '4K') && wanPro.default === '2K', 'wan2.7-image-pro：1K/2K/4K 档位（默认 2K）')
    const wan = sizeField('aliyun_bailian_image', 'wan2.7-image')
    check(!!wan && wan.type === 'select' && !(wan.options ?? []).some((o) => o.value === '4K'), 'wan2.7-image：仅 1K/2K（不含 4K）')
    const wan22 = sizeField('aliyun_bailian_image', 'wan2.2-t2i-flash')
    check(!!wan22 && wan22.type === 'text' && !!wan22.help && wan22.help.includes('512'), 'wan2.2：text + 官方宽高 [512,1440] 约束 help（非通用文案）')
    const qmax = sizeField('aliyun_bailian_image', 'qwen-image-max')
    check(!!qmax && qmax.type === 'select' && (qmax.options ?? []).every((o) => /^[0-9]{3,4}x[0-9]{3,4}$/.test(o.value)) && qmax.default === '1664x928', 'qwen-image-max：官方固定 5 档 WxH（默认 1664x928）')
    const q3 = sizeField('aliyun_bailian_image', 'qwen-image-3.0-pro')
    check(!!q3 && q3.type === 'text' && !!q3.help && q3.help.includes('2048'), 'qwen-image-3.0：text + [512,2048] 自定义范围 help')
    const genericSize = sizeField('openai_image', 'probe-img')
    check(!!genericSize && genericSize.type === 'text' && genericSize.default === '1024x1024', '未注册尺寸族（openai_image）：provider 级通用 1024x1024 文本框')

    // defaultVoice / defaultImageSize 回落链
    check(defaultVoice('aliyun_bailian_tts', 'qwen3-tts-flash') === 'Cherry' && defaultVoice('openai_audio', 'gpt-4o-mini-tts') === 'alloy', 'defaultVoice：命中 profile 用模型级默认')
    check(defaultVoice('siliconflow_audio', 'FunAudioLLM/CosyVoice2-0.5B') === 'FunAudioLLM/CosyVoice2-0.5B:alex', 'defaultVoice：CosyVoice2 → 合成后完整串')
    check(defaultVoice('siliconflow_audio', 'fnlp/MOSS-TTSD-v0.5') === '', 'defaultVoice：未核实模型回落 provider 级（无默认→空，不猜）')
    check(defaultVoice('pollinations_audio', 'elevenlabs/eleven-flash-v2.5') === '', 'defaultVoice：未核实音色集 → 空（交由显式配置）')
    check(defaultVoice('aliyun_bailian_tts') === 'Cherry' && defaultVoice('unknown_audio') === '', 'defaultVoice：不传 model/未知供应商 = M38 现行为')
    check(defaultImageSize('aliyun_bailian_image', 'qwen-image-plus') === '1664x928', 'defaultImageSize：max/plus → 官方默认档（避开非法 1024x1024）')
    check(defaultImageSize('aliyun_bailian_image', 'wan2.7-image') === '2K' && defaultImageSize('aliyun_bailian_image', 'wan2.6-t2i') === '1024x1024', 'defaultImageSize：2.7 档 2K / 2.6 系 1024x1024')
    check(defaultImageSize('openai_image', 'probe-img') === '1024x1024', 'defaultImageSize：未注册族 → 1024x1024 通用兜底')
  }

  // ================= route：extra-schema 带/不带 model 双形态 =================
  const route = async (): Promise<void> => {
    const { initDb } = await import('../src/db')
    await initDb()
    const jget = async (path: string): Promise<{ status: number; body: any }> => {
      const { app } = await import('../src/app')
      const res = await app.request(path)
      let json: any = null
      try { json = await res.json() } catch { /* non-json */ }
      return { status: res.status, body: json }
    }

    const base = 'http://localhost/api/v1/api-configs/extra-schema'
    const without = await jget(`${base}?provider_key=siliconflow_audio&service_type=audio`)
    check(without.status === 200 && without.body?.fields?.find((f: any) => f.key === 'voice')?.type === 'text', '不带 model：与 M38 现行为一致（provider 级 text，旧调用兼容）')
    const withModel = await jget(`${base}?provider_key=siliconflow_audio&service_type=audio&model=${encodeURIComponent('FunAudioLLM/CosyVoice2-0.5B')}`)
    const voice = withModel.body?.fields?.find((f: any) => f.key === 'voice')
    check(withModel.status === 200 && voice?.type === 'select' && (voice?.options ?? []).every((o: any) => String(o.value).includes(':')), '带 model：命中 profile → 合成后「模型:音色」候选')
    const bad = await jget(`${base}?service_type=audio`)
    check(bad.status === 400, '缺 provider_key → 400（现行为不变）')
  }

  // ================= preflight：逐模型兜底 / 未核实仍显式配置 / 尺寸模型级默认 =================
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

    const seed = async (audio: { providerKey: string; model: string; voice?: string }, image: { providerKey: string; model: string; size?: string }): Promise<void> => {
      for (const s of ['llm', 'audio', 'image']) await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, s))
      const ins = (v: Record<string, unknown>) => db.insert(apiConfigs).values({ name: String(v.name), providerKey: v.providerKey, serviceType: v.serviceType, apiKeyRef: 'env:PROBE_M39_KEY', baseUrl: 'http://localhost:0/offline', model: v.model, extra: JSON.stringify(v.extra ?? {}), pricing: v.pricing ?? '{}', isActive: 1, isDefault: 1, priority: 0, createdAt: t, updatedAt: t } as never)
      await ins({ name: 'llm', providerKey: 'deepseek_llm', serviceType: 'llm', model: 'probe-llm', pricing: '{"tokens_in":2,"tokens_out":8}' })
      await ins({ name: 'audio', providerKey: audio.providerKey, serviceType: 'audio', model: audio.model, extra: audio.voice ? { voice: audio.voice } : {}, pricing: '{"char":0.1}' })
      await ins({ name: 'image', providerKey: image.providerKey, serviceType: 'image', model: image.model, extra: image.size ? { size: image.size } : {}, pricing: '{"image":0.1}' })
    }
    const plan = creationPlanSchema.parse({
      title: 'M39 探针方案', summary: '三镜', genre: 'science', duration: 30, aspectRatio: '9:16',
      language: 'zh-CN', mode: 'slideshow', style: '轻松科普', script: '一。\n二。\n三。',
      lines: [{ id: 'l1', text: '一' }, { id: 'l2', text: '二' }, { id: 'l3', text: '三' }],
      shots: [
        { id: 's1', duration: 10, image_prompt: 'A', motion_prompt: '推近', lines: ['l1'] },
        { id: 's2', duration: 10, image_prompt: 'B', motion_prompt: '环绕', lines: ['l2'] },
        { id: 's3', duration: 10, image_prompt: 'C', motion_prompt: '下移', lines: ['l3'] },
      ],
      refs: [],
    })
    const run = async (audio: { providerKey: string; model: string; voice?: string }, image: { providerKey: string; model: string; size?: string }, name: string) => {
      await seed(audio, image)
      return preflightPlan(await mkProject(name), plan as never)
    }
    const oaiImg = { providerKey: 'openai_image', model: 'probe-img' }

    // 逐模型音色兜底：provider 级无默认的 siliconflow，实例选中 CosyVoice2 → 模型级默认补上（M38 语义的合理演进）
    const pfCosy = await run({ providerKey: 'siliconflow_audio', model: 'FunAudioLLM/CosyVoice2-0.5B' }, oaiImg, 'm39-pf-cosy')
    check(pfCosy.ready, `siliconflow+CosyVoice2 未配 voice：预检就绪（逐模型官方默认兜底）${pfCosy.issues.length ? ' 实际 issues=' + JSON.stringify(pfCosy.issues) : ''}`)
    check(pfCosy.execution?.voice === 'FunAudioLLM/CosyVoice2-0.5B:alex', '执行音色 = 模型级默认（含「模型:音色」前缀，适配器可直发）')

    // 未核实音色集仍不猜：elevenlabs 实例（provider 级亦无默认）→ missing_voice
    const pfElv = await run({ providerKey: 'pollinations_audio', model: 'elevenlabs/eleven-flash-v2.5' }, oaiImg, 'm39-pf-elevenlabs')
    check(pfElv.issues.some((i) => i.code === 'missing_voice'), 'elevenlabs 实例无 voice 且音色集未核实 → 仍 missing_voice（不注入假默认）')

    // provider 级回落不变：未注册 profile 模型沿用 M38 行为
    const pfLegacy = await run({ providerKey: 'aliyun_bailian_tts', model: 'qwen-tts' }, oaiImg, 'm39-pf-legacy')
    check(pfLegacy.ready && pfLegacy.execution?.voice === 'Cherry', 'qwen-tts（无 profile）：回落 provider 级默认 Cherry')
    const pfExplicit = await run({ providerKey: 'aliyun_bailian_tts', model: 'qwen3-tts-flash', voice: 'Serena' }, oaiImg, 'm39-pf-explicit')
    check(pfExplicit.ready && pfExplicit.execution?.voice === 'Serena', '显式配置 voice=Serena：覆盖逐模型默认')

    // 尺寸：未配置 → 逐模型默认（qwen-image-max 官方默认档，1024x1024 对其非法不再注入）
    const pfMax = await run({ providerKey: 'pollinations_audio', model: 'qwen/qwen3-tts-flash', voice: 'nova' }, { providerKey: 'aliyun_bailian_image', model: 'qwen-image-max' }, 'm39-pf-imagemax')
    check(pfMax.ready && pfMax.execution?.imageSize === '1664x928', `qwen-image-max 未配 size：兜底官方默认 1664x928${pfMax.execution ? '（实际 ' + pfMax.execution.imageSize + '）' : ''}`)
    // [1-4]K 档位合法透传（wan2.7 系，M38 正则不认致静默回落）
    const pfWan2k = await run({ providerKey: 'pollinations_audio', model: 'qwen/qwen3-tts-flash', voice: 'nova' }, { providerKey: 'aliyun_bailian_image', model: 'wan2.7-image', size: '2K' }, 'm39-pf-wan2k')
    check(pfWan2k.ready && pfWan2k.execution?.imageSize === '2K', 'wan2.7 显式 size=2K：官方档位合法透传（正则扩展 [1-4]K）')
    // 未注册族兜底仍 1024x1024（行为不劣于 M38）
    const pfGeneric = await run({ providerKey: 'pollinations_audio', model: 'qwen/qwen3-tts-flash', voice: 'nova' }, oaiImg, 'm39-pf-generic')
    check(pfGeneric.ready && pfGeneric.execution?.imageSize === '1024x1024', '未注册尺寸族未配 size：通用兜底 1024x1024 不变')
  }

  const runners: Record<string, () => Promise<void>> = { registry, route, preflight }
  await runSections({ log, title: 'M39', checker, sections: SECTIONS, runners, cleanup: envCleanup })
}

void main()
