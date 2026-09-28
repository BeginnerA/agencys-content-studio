import type { Checker } from '../../probe-lib'
import type { CreationPlan } from '../../../src/services/creation-chat/contract'

export async function probeRecipe({ check }: Checker, plan: CreationPlan): Promise<void> {
  const { recipeSchema, isCreationTemplate } = await import('../../../src/services/creation-chat/recipe')
  const { hashJson } = await import('../../../src/services/creation-chat/contract')
  const endpoint = { configId: 1, configHash: 'a'.repeat(64), provider: 'openai_audio', model: 'tts-1', unitPrice: 0.01 }
  const legacyPlan = { ...plan } as Record<string, unknown>
  delete legacyPlan.performance
  delete legacyPlan.cast
  legacyPlan.lines = plan.lines.map(({ speaker: _speaker, ...line }) => line)
  legacyPlan.shots = plan.shots.map(({ characters: _characters, ...shot }) => shot)
  const legacy = {
    sessionId: 1, plan: legacyPlan, endpoints: { audio: endpoint }, videoMode: 'none', requestDurations: {},
    voice: 'alloy', imageSize: '1024x1024', resolution: '720p', templateHash: 'b'.repeat(64),
    sources: [1, 2, 3].map((id) => ({ id, hash: 'c'.repeat(64) })), refs: [],
  }
  const parsed = recipeSchema.parse(legacy)
  check(JSON.stringify(parsed) === JSON.stringify(legacy) && hashJson(parsed) === hashJson(legacy), '历史 recipe 序列化和 hash 逐字不变')
  check(!recipeSchema.safeParse({ ...legacy, voice: undefined }).success, '历史旁白仍强制 voice')
  check(!recipeSchema.safeParse({ ...legacy, endpoints: {} }).success, '历史旁白仍强制 audio')
  const dialogue = {
    ...legacy, plan, voice: undefined,
    endpoints: { video: { ...endpoint, provider: 'volcengine_video', model: 'doubao-seedance-2-0-260128' } },
    videoMode: 't2v', requestDurations: Object.fromEntries(plan.shots.map((s) => [s.id, s.duration])),
    asr: { ...endpoint, model: 'whisper-1', protocol: 'openai_verbose_json', policy: 'verbatim-segments-v1' },
  }
  check(recipeSchema.safeParse(dialogue).success, '对白不需要 TTS，冻结独立 ASR 模型和策略')
  check(!recipeSchema.safeParse({ ...dialogue, asr: undefined }).success, '对白缺少 ASR 快照拒绝')
  check(!recipeSchema.safeParse({ ...dialogue, asr: { ...dialogue.asr, model: 'tts-1' } }).success, 'TTS 模型不能冒充 ASR')
  check(!recipeSchema.safeParse({ ...dialogue, videoMode: 'none' }).success, '对白不可无视频')
  check(!recipeSchema.safeParse({ ...dialogue, endpoints: { ...dialogue.endpoints, audio: endpoint } }).success, '对白拒绝夹带 TTS 执行配置')
  check(!recipeSchema.safeParse({ ...legacy, asr: dialogue.asr }).success, '旁白不注入对白执行字段')
  for (const changed of [
    { ...dialogue, asr: { ...dialogue.asr, unitPrice: 0.02 } },
    { ...dialogue, asr: { ...dialogue.asr, configHash: 'd'.repeat(64) } },
    { ...dialogue, plan: { ...plan, cast: plan.cast!.map((c) => ({ ...c, voice: c.voice + '略紧张' })) } },
  ]) check(hashJson(changed) !== hashJson(dialogue), 'ASR 价格、配置和角色声线变化均改变批准摘要')
  const { loadTemplate } = await import('../../../src/pipeline/loader')
  const { getAction } = await import('../../../src/pipeline/actions')
  for (const key of ['easy-dialogue']) {
    check(isCreationTemplate(key), '对白模板纳入统一批准链与专业端阻断集合')
    const template = loadTemplate(key)
    check(template.steps.every((s) => s.action !== 'tts') && template.steps.find((s) => s.key === 'captions')?.action === 'dialogue_subtitle', '对白 DAG 原声转写且不含 TTS')
    check(template.steps.find((s) => s.key === 'compose')?.gate?.mode === 'required' && template.steps.find((s) => s.key === 'frames')?.gate?.mode === 'required', '对白模板同时强制首帧与最终人工审阅')
    check(template.steps.every((s) => typeof getAction(s.action) === 'function'), '对白模板 action 均已注册')
  }
}
