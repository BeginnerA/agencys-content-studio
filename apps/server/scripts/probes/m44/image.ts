import { eq } from 'drizzle-orm'
import type { Checker } from '../../probe-lib'
import type { StepContext } from '../../../src/pipeline/context'

export async function probeDialogueImage({ check }: Checker, ctx: StepContext): Promise<void> {
  const { db } = await import('../../../src/db')
  const { apiConfigs, genTasks, pipelineRuns, pipelineSteps } = await import('../../../src/db/schema')
  const { resolveEndpoint, getImageAdapter } = await import('../../../src/adapters/provider')
  const { aiImage } = await import('../../../src/pipeline/actions/ai-image')
  const { recipeOf } = await import('../../../src/services/creation-chat/recipe')
  const { compileDialogueShot } = await import('../../../src/services/creation-chat/dialogue')
  const { saveGeneratedMedia } = await import('../../../src/services/net')
  const now = Date.now(), provider = 'gemini_image', model = 'gemini-2.5-flash-image'
  const [cfg] = await db.insert(apiConfigs).values({ name: '离线首帧', serviceType: 'image', providerKey: provider, model,
    baseUrl: 'http://localhost:0', apiKeyRef: 'env:PROBE_M44_KEY', isActive: 1, createdAt: now, updatedAt: now }).returning()
  const endpoint = await resolveEndpoint('image', provider, { configId: cfg!.id })
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6QAAAABJRU5ErkJggg=='
  const ref = await saveGeneratedMedia({ projectId: ctx.run.projectId, kind: 'image', purpose: 'reference', prompt: '离线参考', params: {}, source: { kind: 'base64', data: png, mime: 'image/png' } })
  const recipe = recipeOf(ctx.run)!
  recipe.videoMode = 'i2v'
  recipe.endpoints.image = { configId: endpoint.configId, configHash: endpoint.configHash, provider, model, unitPrice: 0.1 }
  recipe.refs = [{ assetId: ref.id, hash: ref.sha256!, kind: 'image', role: 'subject', shotId: 's1' }]
  recipe.plan.refs = recipe.refs
  const [run] = await db.insert(pipelineRuns).values({ projectId: ctx.run.projectId, templateKey: 'easy-dialogue', input: JSON.stringify({ recipe: JSON.stringify(recipe) }), createdAt: now, updatedAt: now }).returning()
  const [step] = await db.insert(pipelineSteps).values({ runId: run!.id, seq: 0, stepKey: 'frames', actionKey: 'ai_image', createdAt: now, updatedAt: now }).returning()
  const imageCtx: StepContext = { ...ctx, run: run!, step: step!, def: { key: 'frames', action: 'ai_image', title: '首帧', inputs: {}, params: { use_character_refs: false, use_style_preset: false }, batch: { field: 'shots', maxConcurrent: 1, retry: 0 } },
    settings: { image: { ...recipe.endpoints.image, size: '1024x1024' } },
    assetIdsOf: (key) => key === 'shots' ? [1] : [], readText: async () => JSON.stringify(recipe.plan.shots) }
  const adapter = getImageAdapter(provider), generate = adapter.generate
  let calls = 0
  adapter.generate = async (request) => {
    const shot = recipe.plan.shots[calls++]!
    check(request.prompt === compileDialogueShot(recipe.plan, shot.id).imagePrompt, '首帧实际请求包含批准角色外貌与统一风格')
    check((request.referenceImages?.length ?? 0) === (shot.id === 's1' ? 1 : 0), '逐镜批准主体参考被首帧实际消费且不串镜')
    return { kind: 'base64', data: png, mime: 'image/png' }
  }
  try {
    const output = await aiImage(imageCtx)
    const tasks = await db.select().from(genTasks).where(eq(genTasks.stepId, step!.id))
    check(output.assetIds.length === 4 && tasks.every((t, i) => t.prompt === compileDialogueShot(recipe.plan, recipe.plan.shots[i]!.id).imagePrompt), '首帧任务保存完整角色提示快照')
    await aiImage(imageCtx)
    check(calls === 4, '首帧恢复复用原资产，零重复生成')
  } finally {
    adapter.generate = generate
    await db.update(apiConfigs).set({ isActive: 0 }).where(eq(apiConfigs.id, cfg!.id))
  }
}
