import { eq } from 'drizzle-orm'
import type { CreationPlan } from '../../../src/services/creation-chat/contract'

/** 构造完整批准链的离线夹具；不开放产品确认入口，不启动引擎。 */
export async function seedDialogueRun(plan: CreationPlan, templateKey = 'easy-dialogue', i2v = false) {
  const { db, initDb } = await import('../../../src/db')
  const { apiConfigs, projects, creationSessions, pipelineRuns } = await import('../../../src/db/schema')
  const { loadTemplate } = await import('../../../src/pipeline/loader')
  const { hashJson } = await import('../../../src/services/creation-chat/contract')
  const { recipeSchema } = await import('../../../src/services/creation-chat/recipe')
  const { preflightPlan } = await import('../../../src/services/creation-chat/preflight')
  const { ensureProjectDirs, writeTextAsset } = await import('../../../src/services/storage')
  await initDb()
  await db.update(apiConfigs).set({ isActive: 0, isDefault: 0 })
  process.env.PROBE_M44_KEY = 'offline-m44'
  const now = Date.now()
  const add = async (serviceType: string, providerKey: string, model: string, extra: object, pricing: object) => {
    const [row] = await db.insert(apiConfigs).values({ name: '离线对白链', serviceType, providerKey, model, extra: JSON.stringify(extra), pricing: JSON.stringify(pricing),
      baseUrl: 'http://localhost:0/v1', apiKeyRef: 'env:PROBE_M44_KEY', isDefault: 1, isActive: 1, createdAt: now, updatedAt: now }).returning()
    return row!
  }
  await add('llm', 'openai_compatible', 'offline-text', {}, {})
  const video = await add('video', 'volcengine_video', 'doubao-seedance-2-0-260128', {
    creationCapabilities: { model: 'doubao-seedance-2-0-260128', verified: true, modes: i2v ? ['i2v'] : ['t2v'], durations: [8], aspectRatios: ['9:16'], resolution: '720p' },
  }, { second: 0.1 })
  await add('image', 'gemini_image', 'gemini-2.5-flash-image', {}, { image: 0.2 })
  const audio = await add('audio', 'openai_audio', 'tts-1', { asr_model: 'whisper-1', asr_protocol: 'openai_verbose_json' }, { asr: { model: 'whisper-1', second: 0.02 } })
  const [project] = await db.insert(projects).values({ name: '离线对白链', status: 'active', createdAt: now, updatedAt: now }).returning()
  ensureProjectDirs(project!.id)
  const pf = await preflightPlan(project!.id, plan)
  if (!pf.ready || !pf.execution) throw new Error(JSON.stringify(pf.issues))
  const [session] = await db.insert(creationSessions).values({ projectId: project!.id, requestKey: `m44-${project!.id}`, status: 'started', plan: JSON.stringify(plan),
    planRevision: 1, planHash: hashJson({ plan, execution: pf.execution }), preflight: JSON.stringify(pf), createdAt: now, updatedAt: now }).returning()
  const sources = []
  for (const [i, content] of [plan.script, JSON.stringify(plan.lines), JSON.stringify(plan.shots)].entries()) {
    const asset = await writeTextAsset(project!.id, { content, name: ['批准脚本.md', '批准台词.json', '批准分镜.json'][i]!, purpose: ['script', 'lines', 'storyboard'][i]! })
    sources.push({ id: asset.id, hash: hashJson(content) })
  }
  const template = loadTemplate(templateKey)
  const recipe = recipeSchema.parse({ ...pf.execution, sessionId: session!.id, sources, templateHash: hashJson(template) })
  const [run] = await db.insert(pipelineRuns).values({ projectId: project!.id, templateKey, templateSnapshot: JSON.stringify(template), status: 'failed',
    input: JSON.stringify({ recipe: JSON.stringify(recipe), script: [sources[0]!.id], lines: [sources[1]!.id], shots: [sources[2]!.id], motion: true, i2v }), createdAt: now, updatedAt: now }).returning()
  const [linked] = await db.update(creationSessions).set({ approvedPlan: JSON.stringify(recipe), runId: run!.id }).where(eq(creationSessions.id, session!.id)).returning()
  return { project: project!, session: linked!, run: run!, recipe, video, audio, pf, template }
}
