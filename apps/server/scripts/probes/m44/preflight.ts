import { eq } from 'drizzle-orm'
import type { Checker } from '../../probe-lib'
import type { CreationPlan } from '../../../src/services/creation-chat/contract'

export async function probeDialoguePreflight({ check }: Checker, plan: CreationPlan): Promise<void> {
  const { db, initDb } = await import('../../../src/db')
  const { apiConfigs, projects } = await import('../../../src/db/schema')
  const { preflightPlan } = await import('../../../src/services/creation-chat/preflight')
  const { loadTemplate } = await import('../../../src/pipeline/loader')
  const { hashJson } = await import('../../../src/services/creation-chat/contract')
  await initDb()
  await db.delete(apiConfigs)
  process.env.PROBE_M44_KEY = 'offline-m44'
  const now = Date.now()
  const [project] = await db.insert(projects).values({ name: '对白预检', createdAt: now, updatedAt: now }).returning()
  const add = async (serviceType: string, providerKey: string, model: string, extra: object, pricing: object) => {
    const [row] = await db.insert(apiConfigs).values({ name: '离线预检', serviceType, providerKey, model, extra: JSON.stringify(extra), pricing: JSON.stringify(pricing),
      baseUrl: 'http://localhost:0/v1', apiKeyRef: 'env:PROBE_M44_KEY', isActive: 1, isDefault: 1, createdAt: now, updatedAt: now }).returning()
    return row!
  }
  await add('llm', 'openai_compatible', 'offline-text', {}, {})
  const video = await add('video', 'volcengine_video', 'doubao-seedance-2-0-260128', {}, { second: 0.1 })
  await add('image', 'gemini_image', 'gemini-2.5-flash-image', {}, { image: 0.2 })
  const audio = await add('audio', 'openai_audio', 'tts-1', { voice: 'clone:不可使用' }, { char: 99, second: 99 })
  const fetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('预检禁止联网') }
  try {
    let pf = await preflightPlan(project!.id, plan)
    check(!pf.ready && pf.issues.some((i) => i.code === 'missing_asr'), '未显式配置严格 ASR 时生成前阻止，不以 TTS 冒充')
    await db.update(apiConfigs).set({ extra: JSON.stringify({ voice: 'clone:不可使用', asr_model: 'whisper-1', asr_protocol: 'openai_verbose_json' }) }).where(eq(apiConfigs.id, audio.id))
    pf = await preflightPlan(project!.id, plan)
    check(pf.ready && !pf.execution?.voice && !pf.execution?.endpoints.audio && pf.execution?.asr?.model === 'whisper-1', '对白不要求 TTS 音色，独立冻结严格 ASR 模型')
    check(pf.estimate.voiceChars === 0 && (pf.estimate as { asrSeconds?: number }).asrSeconds === 32 && pf.estimate.videoSeconds === 32, '对白费用按视频秒数和 ASR 秒数预估，不计 TTS 字符')
    check(pf.estimate.unpriced.some((s) => s.includes('ASR')) && pf.execution?.asr?.unitPrice === null, '未计价 ASR 不读取宿主 TTS 单价，需显式接受')
    check(pf.execution?.templateHash === hashJson(loadTemplate('easy-dialogue')), '对白预检冻结新模板，不污染旧模板哈希')
    check(JSON.stringify(pf.resolutionOptions) === JSON.stringify({ choices: ['480p', '720p'], default: '720p' }) && pf.estimate.imageCount === 4, '保留 M43 视频真源画质选项和 i2v 首帧估价，不虚构 1080p')
    await db.update(apiConfigs).set({ pricing: JSON.stringify({ char: 99, second: 99, asr: { model: 'whisper-1', second: 0.02 } }) }).where(eq(apiConfigs.id, audio.id))
    pf = await preflightPlan(project!.id, plan)
    check(pf.ready && pf.estimate.knownCost === 4.64 && pf.estimate.unpriced.length === 0, '视频、图片、ASR 分价准确累计')
    await db.update(apiConfigs).set({ model: 'doubao-seedance-2-future', extra: JSON.stringify({ creationCapabilities: { model: 'doubao-seedance-2-future', verified: true, modes: ['t2v'], durations: [8], aspectRatios: ['9:16'], resolution: '720p' } }) }).where(eq(apiConfigs.id, video.id))
    pf = await preflightPlan(project!.id, plan)
    check(!pf.ready && pf.issues.some((i) => i.code === 'native_dialogue_unsupported'), '实例自声明不能授权未来原生对白型号')
    await db.update(apiConfigs).set({ model: 'doubao-seedance-2-0-260128', extra: '{}' }).where(eq(apiConfigs.id, video.id))
    pf = await preflightPlan(project!.id, { ...plan, lines: plan.lines.map((l) => ({ ...l, text: '字'.repeat(100) })) })
    check(!pf.ready, '预检拒绝明显超载台词')
    check(calls === 0, '全部对白预检零媒体和 ASR 请求')
  } finally { globalThis.fetch = fetch }
}
