import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { eq } from 'drizzle-orm'
import type { Checker } from '../../probe-lib'
import type { StepContext } from '../../../src/pipeline/context'
import type { Asset } from '../../../src/db/schema'

export async function probeDialogueVideo({ check }: Checker, ctx: StepContext, sample: Asset): Promise<void> {
  const { db } = await import('../../../src/db')
  const { apiConfigs, genTasks, pipelineRuns, pipelineSteps, usageRecords } = await import('../../../src/db/schema')
  const { resolveEndpoint } = await import('../../../src/adapters/provider')
  const { getVideoAdapter } = await import('../../../src/adapters/video')
  const { aiVideo } = await import('../../../src/pipeline/actions/ai-video')
  const { recipeOf } = await import('../../../src/services/creation-chat/recipe')
  const { compileDialogueShot } = await import('../../../src/services/creation-chat/dialogue')
  const { absPathOf, relPathOf } = await import('../../../src/services/storage')
  const { resolveFfmpeg } = await import('../../../src/services/ffmpeg')
  const rejection = async (fn: () => Promise<unknown>): Promise<string> => { try { await fn(); return '' } catch (error) { return String(error) } }
  for (const [provider, model] of [['volcengine_video', 'doubao-seedance-2-0-260128'], ['aliyun_bailian_video', 'wan3.0-video']] as const) {
    const now = Date.now()
    const [cfg] = await db.insert(apiConfigs).values({ name: '离线视频', serviceType: 'video', providerKey: provider, model,
      baseUrl: 'http://localhost:0', apiKeyRef: 'env:PROBE_M44_KEY', isActive: 1, createdAt: now, updatedAt: now,
      extra: JSON.stringify({ generateAudio: false, promptExtend: true, referenceVideoUrls: ['https://invalid.example/unapproved.mp4'] }) }).returning()
    const endpoint = await resolveEndpoint('video', provider, { configId: cfg!.id })
    const recipe = recipeOf(ctx.run)!
    recipe.endpoints.video = { configId: endpoint.configId, configHash: endpoint.configHash, provider, model, unitPrice: 0.1 }
    const [run] = await db.insert(pipelineRuns).values({ projectId: ctx.run.projectId, templateKey: 'easy-dialogue', input: JSON.stringify({ recipe: JSON.stringify(recipe) }), createdAt: now, updatedAt: now }).returning()
    const [step] = await db.insert(pipelineSteps).values({ runId: run!.id, seq: 1, stepKey: 'motion', actionKey: 'ai_video', createdAt: now, updatedAt: now }).returning()
    const videoCtx: StepContext = { ...ctx, run: run!, step: step!, def: { key: 'motion', action: 'ai_video', title: '原生对白', inputs: {}, params: { prompt_field: 'motion_prompt' }, batch: { field: 'shots', maxConcurrent: 1, retry: 0 } },
      settings: { video: { ...recipe.endpoints.video, resolution: '720p', aspect_ratio: '9:16' } },
      assetIdsOf: (key) => key === 'shots' ? [1] : [], readText: async () => JSON.stringify(recipe.plan.shots) }
    const adapter = getVideoAdapter(provider)
    const generate = adapter.generate
    let calls = 0
    adapter.generate = async (request) => {
      const compiled = compileDialogueShot(recipe.plan, recipe.plan.shots[calls++]!.id)
      check(request.prompt === compiled.prompt, '视频实际请求完整逐字台词、角色、声线与画面提示')
      check(request.extra?.generateAudio === true && (provider !== 'aliyun_bailian_video' || request.extra?.promptExtend === false), '实例 extra 不可覆盖强制原声和禁止扩写参数')
      check(Array.isArray(request.extra?.referenceVideoUrls) && request.extra.referenceVideoUrls.length === 0, '未批准的实例参考媒体不可混入对白请求')
      return { kind: 'base64', data: readFileSync(absPathOf(sample.relPath!)).toString('base64'), mime: 'video/mp4' }
    }
    try {
      const output = await aiVideo(videoCtx)
      const rows = await videoCtx.assetsOf(output.assetIds)
      check(rows.length === 4 && rows.every((a, i) => JSON.parse(a.params!).dialogueHash === compileDialogueShot(recipe.plan, recipe.plan.shots[i]!.id).dialogueHash), '原生视频资产保存逐镜对白指纹')
      const tasks = await db.select().from(genTasks).where(eq(genTasks.stepId, step!.id))
      check(tasks.every((t) => JSON.parse(t.params).audioOptions?.generateAudio === true), '完整音频选项进入任务快照')
      await aiVideo(videoCtx)
      check(calls === 4, '视频恢复复用既有产物，不重复生成')
    } finally { adapter.generate = generate }
    const fetch = globalThis.fetch
    let body: { generate_audio?: boolean; parameters?: { audio?: boolean; prompt_extend?: boolean }; input?: { prompt?: string }; content?: Array<{ type: string; text?: string }> } = {}
    globalThis.fetch = async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ id: 'mock-video', output: { task_id: 'mock-video' } })) }
    try {
      await adapter.generate({ prompt: compileDialogueShot(recipe.plan, 's1').prompt, model, baseUrl: endpoint.baseUrl, apiKey: 'offline', duration: 8, resolution: '720p', aspectRatio: '9:16', extra: { generateAudio: true, promptExtend: false } })
      check(provider === 'volcengine_video' ? body.generate_audio === true : body.parameters?.audio === true && body.parameters.prompt_extend === false, '供应商 HTTP 契约正确下发原生音频开关')
    } finally { globalThis.fetch = fetch }
    if (provider === 'volcengine_video') {
      const path = absPathOf(relPathOf(ctx.run.projectId, 'shot_video', 'missing-audio.mp4'))
      const silent = spawnSync(resolveFfmpeg()!, ['-n', '-v', 'error', '-i', absPathOf(sample.relPath!), '-an', '-c:v', 'copy', path], { encoding: 'utf8', windowsHide: true })
      if (silent.status !== 0) throw new Error(silent.stderr)
      const [badRun] = await db.insert(pipelineRuns).values({ projectId: ctx.run.projectId, templateKey: 'easy-dialogue', input: run!.input, createdAt: now, updatedAt: now }).returning()
      const [badStep] = await db.insert(pipelineSteps).values({ runId: badRun!.id, seq: 1, stepKey: 'motion', actionKey: 'ai_video', createdAt: now, updatedAt: now }).returning()
      const broken = { ...videoCtx, run: badRun!, step: badStep! }
      let submits = 0
      adapter.generate = async () => { submits++; return { kind: 'base64', data: readFileSync(path).toString('base64'), mime: 'video/mp4' } }
      try {
        check((await rejection(() => aiVideo(broken))).includes('原声音轨'), '原声缺失必须保留可定位的本地核验错误')
        check(!!await rejection(() => aiVideo(broken)) && submits === 4, '无声视频重入不自动重新生成，也不误算已有资产为成功')
        const failed = await db.select().from(genTasks).where(eq(genTasks.runId, badRun!.id))
        const costs = await db.select().from(usageRecords).where(eq(usageRecords.runId, badRun!.id))
        check(failed.length === 4 && failed.every((t) => t.status === 'failed' && t.resultAssetId) && costs.length === 4, '无声产物与已发生费用完整保留且不重复计费')
      } finally { adapter.generate = generate }
    }
    await db.update(apiConfigs).set({ isActive: 0 }).where(eq(apiConfigs.id, cfg!.id))
  }
}
