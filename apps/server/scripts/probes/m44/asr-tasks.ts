import { spawnSync } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { eq, inArray } from 'drizzle-orm'
import type { Checker } from '../../probe-lib'
import type { CreationPlan } from '../../../src/services/creation-chat/contract'
import type { StepContext } from '../../../src/pipeline/context'
import type { Asset } from '../../../src/db/schema'

export async function probeAsrTasks(checker: Checker, plan: CreationPlan): Promise<void> {
  const { check } = checker
  const { db, initDb } = await import('../../../src/db')
  const { apiConfigs, projects, pipelineRuns, pipelineSteps, genTasks, assets, usageRecords } = await import('../../../src/db/schema')
  const { absPathOf, ensureProjectDirs, registerAsset, relPathOf, readTextAsset } = await import('../../../src/services/storage')
  const { resolveFfmpeg } = await import('../../../src/services/ffmpeg')
  const { snapshotStrictAsr } = await import('../../../src/services/strict-asr')
  const { recipeSchema } = await import('../../../src/services/creation-chat/recipe')
  const { compileDialogueShot } = await import('../../../src/services/creation-chat/dialogue')
  const { dialogueSubtitle } = await import('../../../src/pipeline/actions/dialogue-subtitle')
  await initDb()
  await db.delete(apiConfigs)
  process.env.PROBE_M44_KEY = 'offline-m44'
  const now = Date.now()
  await db.insert(apiConfigs).values({ name: '离线 ASR', providerKey: 'openai_audio', serviceType: 'audio', model: 'tts-1',
    baseUrl: 'http://localhost:0/v1', apiKeyRef: 'env:PROBE_M44_KEY', extra: JSON.stringify({ asr_model: 'whisper-1', asr_protocol: 'openai_verbose_json' }),
    pricing: JSON.stringify({ asr: { model: 'whisper-1', second: 0.02 } }), isDefault: 1, isActive: 1, createdAt: now, updatedAt: now })
  const asr = await snapshotStrictAsr()
  const recipe = recipeSchema.parse({ sessionId: 1, plan, endpoints: { video: { configId: 1, configHash: 'a'.repeat(64), unitPrice: 0.1, provider: 'volcengine_video', model: 'doubao-seedance-2-0-260128' } },
    videoMode: 't2v', requestDurations: Object.fromEntries(plan.shots.map((s) => [s.id, s.duration])), imageSize: '1024x1024', resolution: '720p',
    templateHash: 'b'.repeat(64), sources: [1, 2, 3].map((id) => ({ id, hash: 'c'.repeat(64) })), refs: [], asr })
  const [project] = await db.insert(projects).values({ name: 'M44 ASR 任务', createdAt: now, updatedAt: now }).returning()
  const [run] = await db.insert(pipelineRuns).values({ projectId: project!.id, templateKey: 'easy-dialogue', input: JSON.stringify({ recipe: JSON.stringify(recipe) }), createdAt: now, updatedAt: now }).returning()
  const [step] = await db.insert(pipelineSteps).values({ runId: run!.id, seq: 1, stepKey: 'captions', actionKey: 'dialogue_subtitle', createdAt: now, updatedAt: now }).returning()
  ensureProjectDirs(project!.id)
  const clips: Asset[] = []
  for (const [i, shot] of plan.shots.entries()) {
    const relPath = relPathOf(project!.id, 'shot_video', `task-${shot.id}.mp4`)
    const result = spawnSync(resolveFfmpeg()!, ['-n', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x240:r=25:d=8',
      '-f', 'lavfi', '-i', `sine=frequency=${440 + i * 100}:duration=7`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', absPathOf(relPath)], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
    if (result.status !== 0) throw new Error(result.stderr)
    clips.push(await registerAsset(project!.id, { name: shot.id, kind: 'video', purpose: 'shot_video', relPath,
      params: { shotId: shot.id, dialogueHash: compileDialogueShot(plan, shot.id).dialogueHash }, runId: run!.id }))
  }
  const ctx: StepContext = { run: run!, step: step!, template: { key: 'easy-dialogue', version: 1, name: '探针', genre: 'story', inputs: [], steps: [] },
    def: { key: 'captions', action: 'dialogue_subtitle', title: '实测字幕', inputs: {} }, input: {}, settings: {}, log: () => {},
    assetIdsOf: (key) => key === 'motion_clips' ? clips.map((c) => c.id) : [], readText: readTextAsset,
    pathOf: async (id) => absPathOf(clips.find((c) => c.id === id)!.relPath!),
    assetsOf: async (ids) => ids.length ? db.select().from(assets).where(inArray(assets.id, ids)) : [] }
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (_url, options) => {
    const body = options?.body as FormData
    check(body.get('model') === 'whisper-1' && body.get('response_format') === 'verbose_json', '任务请求固定严格 ASR 协议')
    const text = plan.lines[calls++]!.text
    return new Response(JSON.stringify({ text, segments: [{ start: 0.5, end: 3, text }] }), { status: 200 })
  }
  try {
    const first = await dialogueSubtitle(ctx)
    const srt = await readTextAsset(first.assetIds[0]!)
    check(calls === 4 && srt.includes('00:00:24,500'), '四镜独立转写，字幕使用实测分段和镜头偏移')
    const second = await dialogueSubtitle(ctx)
    const costs = await db.select().from(usageRecords).where(eq(usageRecords.runId, run!.id))
    check(calls === 4 && second.assetIds[0] === first.assetIds[0], '重复执行复用原声核验和字幕，不再次联网')
    check(costs.length === 4 && costs.every((c) => c.kind === 'asr' && c.quantity > 6.9 && c.quantity < 7.2 && c.cost !== null), '仅按实际提交音轨秒数记账一次，无 TTS 用量')
    const tasks = await db.select().from(genTasks).where(eq(genTasks.stepId, step!.id))
    check(tasks.length === 4 && tasks.every((t) => t.kind === 'asr' && t.status === 'succeeded' && t.attempts === 1), '逐镜 ASR 任务成功状态可恢复')
    check(clips.every((c) => readFileSync(absPathOf(c.relPath!)).length > 0), '核验后原视频产物保留')
    await (await import('./compose')).probeDialogueCompose(checker, ctx, first.assetIds[0]!)
    await (await import('./video')).probeDialogueVideo(checker, ctx, clips[0]!)
    await (await import('./image')).probeDialogueImage(checker, ctx)
    const { validatedDialogueClip } = await import('../../../src/services/creation-chat/dialogue-cache')
    const rejection = async (fn: () => Promise<unknown>): Promise<string> => { try { await fn(); return '' } catch (error) { return String(error) } }
    check((await validatedDialogueClip(recipe, 's1', clips[0]!, project!.id)).transcript.text === plan.lines[0]!.text && calls === 4, '零付费只读入口复用已校验原声')
    check(!!await rejection(() => validatedDialogueClip(recipe, 's2', clips[0]!, project!.id)), '候选不允许跨台词或跨说话角色复用')
    const changed = structuredClone(recipe)
    changed.plan.cast![0]!.voice += '紧张'
    check(!!await rejection(() => validatedDialogueClip(changed, 's1', clips[0]!, project!.id)), '角色指纹变化不能复用旧原声')
    const { assertDialogueCandidates } = await import('../../../src/services/creation-chat/candidates')
    const candidateFail = async (picks: Array<{ shot_id: string; asset_id: number }>): Promise<string> => { try { await assertDialogueCandidates(recipe, picks, project!.id); return '' } catch (error) { return String(error) } }
    check((await candidateFail([{ shot_id: 's1', asset_id: clips[0]!.id }, { shot_id: 's2', asset_id: clips[1]!.id }])) === '', '对白候选接受带匹配已校验原声缓存的本镜版本')
    check(!!await candidateFail([{ shot_id: 's1', asset_id: clips[1]!.id }]), '对白候选拒绝把其他镜头或其他台词的视频选入本镜')
    const [rawAsset] = await db.select().from(assets).where(eq(assets.id, tasks[0]!.resultAssetId!))
    const originalBytes = readFileSync(absPathOf(rawAsset!.relPath!))
    writeFileSync(absPathOf(rawAsset!.relPath!), '{}')
    check(!!await rejection(() => dialogueSubtitle(ctx)) && calls === 4, '损坏缓存拒绝，不转成付费重新请求')
    writeFileSync(absPathOf(rawAsset!.relPath!), originalBytes)
    const fork = async (): Promise<StepContext> => {
      const [p] = await db.insert(projects).values({ name: 'M44 失败隔离', createdAt: now, updatedAt: now }).returning()
      const [r] = await db.insert(pipelineRuns).values({ projectId: p!.id, templateKey: 'easy-dialogue', input: ctx.run.input, createdAt: now, updatedAt: now }).returning()
      const [s] = await db.insert(pipelineSteps).values({ runId: r!.id, seq: 1, stepKey: 'captions', actionKey: 'dialogue_subtitle', createdAt: now, updatedAt: now }).returning()
      ensureProjectDirs(p!.id)
      const forkIds: number[] = []
      for (const clip of clips) {
        const relPath = relPathOf(p!.id, 'shot_video', `${clip.id}.mp4`)
        copyFileSync(absPathOf(clip.relPath!), absPathOf(relPath))
        const a = await registerAsset(p!.id, { name: clip.name, kind: 'video', purpose: 'shot_video', relPath, params: JSON.parse(clip.params!), runId: r!.id })
        forkIds.push(a.id)
      }
      return { ...ctx, run: r!, step: s!, assetIdsOf: (key) => key === 'motion_clips' ? forkIds : [] }
    }
    for (const bad of [{ text: '错词', segments: [{ start: 1, end: 2, text: '错词' }] }, { text: plan.lines[0]!.text }]) {
      const broken = await fork()
      let requests = 0
      globalThis.fetch = async () => { requests++; return new Response(JSON.stringify(bad)) }
      check((await rejection(() => dialogueSubtitle(broken))).includes('s1'), '错词或缺时间戳时定位具体镜头并阻断')
      check(!!await rejection(() => dialogueSubtitle(broken)) && requests === 1, '校验失败重入仅复用原始响应，不重发 ASR')
      const produced = await db.select().from(assets).where(eq(assets.runId, broken.run.id))
      const paid = await db.select().from(usageRecords).where(eq(usageRecords.runId, broken.run.id))
      check(produced.some((a) => a.purpose === 'dialogue_transcript') && produced.some((a) => a.purpose === 'dialogue_audio') && !produced.some((a) => a.purpose === 'subtitle') && paid.length === 1, '失败仍保留原声、原始转写和一次费用，不伪造字幕成功')
    }
    const unknown = await fork()
    let unknownCalls = 0
    globalThis.fetch = async () => { unknownCalls++; throw new Error('网关连接中断') }
    check(!!await rejection(() => dialogueSubtitle(unknown)), '网络结果未知时停止任务')
    check((await rejection(() => dialogueSubtitle(unknown))).includes('不能自动重发') && unknownCalls === 1, '未知结果必须显式核验，重复执行不自动付费')
    const drift = await fork()
    await db.update(apiConfigs).set({ extra: '{}' }).where(eq(apiConfigs.id, asr.configId))
    check(!!await rejection(() => dialogueSubtitle(drift)) && unknownCalls === 1, '配置漂移在 ASR 提交前阻断')
  } finally { globalThis.fetch = original }
}
