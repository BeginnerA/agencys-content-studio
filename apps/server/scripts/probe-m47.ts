/**
 * M47 离线探针：免 ASR 核验对白执行链（路 B，huobao 式原生出声 + 估算字幕）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m47.ts [--section=recipe|preflight|execution|srt|action|merge|plan]
 *
 * 隔离策略：isolatedEnv('m47', bridge templates/prompts) 一次性临时目录（独立 studio.db + workspace），
 * 必须在任何 src 动态 import 前调用。零网络、零付费：除 plan 节 stub 回放 LLM 响应外，
 * 其余分节 globalThis.fetch 全阻断（触网即抛）。
 *
 * 断言面：
 *  - recipe：estimatedDialogue 键三分支合法性（互斥/守卫）+ 存量 narration/strict recipe 序列化与哈希逐字不变
 *    + frozenSettings 字幕步 ASR 解析分流；
 *  - preflight：dialogue_asr 三层策略分流（ON→missing_asr 零回归 / OFF+背书→estimated 快照 / OFF+未背书→422）
 *    + dialogueMode 顶层透出不进 execution → planHash 逐字不变；
 *  - execution：冻结闸条件放行（estimated 对白可开始制作并冻结免核验 recipe；strict 对白仍 dialogue_unavailable）；
 *  - srt：estimatedDialogueSrt 纯函数（字数占比分配/跨镜单调连续/越界与空台词拒绝）；
 *  - action：dialogue_subtitle estimated 分支零网络零计费 + params 诚实标注 + 重入复用 + 静音守卫；
 *  - merge：ffmpeg-merge estimated 分支同源重算匹配 / 陈旧字幕拒绝 / 成片 params 标注 + 缺原声轨拒绝；
 *  - plan：规划注入三段式（ON 逐字现状 / OFF+背书免核验指令 / OFF+未背书降级旁白）。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元（保 parseProbeOutput 精确）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isolatedEnv, makeChecker, runSections } from './probe-lib'
import type { Asset } from '../src/db/schema'

const { cleanup } = isolatedEnv('m47', { bridge: ['templates', 'prompts'] })
process.env.PROBE_M47_KEY = 'offline-m47'

const SECTIONS = ['recipe', 'preflight', 'execution', 'srt', 'action', 'motion', 'merge', 'plan'] as const

const { createLogger } = await import('../src/logger')
/** 多角色对白 fixture（与 M44 探针同一份现场数据，零回归对照）。 */
function dialogueFixture() {
  const texts = ['信怎么不见了？', '我把信放在抽屉里了。', '可是抽屉里没有啊。', '别着急，我陪你一起找。']
  return {
    title: '寻找信件', summary: '两人一起找信', genre: 'story' as const, duration: 32,
    aspectRatio: '9:16' as const, language: 'zh-CN' as const, mode: 'dynamic' as const,
    style: '生活写实', script: texts.join('\n'),
    lines: texts.map((text, i) => ({ id: `l${i + 1}`, text, speaker: i % 2 ? 'b' : 'a' })),
    shots: texts.map((_, i) => ({ id: `s${i + 1}`, duration: 8, image_prompt: '两人在书房面对面交谈', motion_prompt: '固定机位，对手倾听', lines: [`l${i + 1}`], characters: ['a', 'b'] })),
    refs: [], performance: 'dialogue' as const,
    cast: [
      { id: 'a', name: '小林', appearance: '短发，蓝色衬衣', voice: '青年女性，清亮自然' },
      { id: 'b', name: '小陈', appearance: '黑发，灰色毛衣', voice: '青年男性，温和低沉' },
    ],
  }
}
/** narration 变体：剥除对白专属字段（speaker/cast/characters），走存量旁白契约。 */
function narrationFixture() {
  const raw = JSON.parse(JSON.stringify(dialogueFixture())) as Record<string, unknown>
  delete raw.performance
  delete raw.cast
  raw.mode = 'slideshow'
  raw.lines = (raw.lines as Array<Record<string, unknown>>).map(({ speaker: _speaker, ...line }) => line)
  raw.shots = (raw.shots as Array<Record<string, unknown>>).map(({ characters: _characters, ...shot }) => shot)
  return raw
}
const log = createLogger('probe-m47')
const checker = makeChecker(log)
const check = checker.check

/** fetch 全阻断包装：任何网络请求即抛（断言「零付费零联网」的机械保证）。 */
async function noNetwork<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => { throw new Error(`探针禁止网络请求: ${String(input)}`) }) as typeof fetch
  try { return await fn() } finally { globalThis.fetch = original }
}

const errOf = async (fn: () => unknown): Promise<Error | null> => {
  try { await fn(); return null } catch (err) { return err instanceof Error ? err : new Error(String(err)) }
}
const codeOf = async (fn: () => unknown): Promise<string> => {
  const e = await errOf(fn)
  return e && typeof (e as { code?: unknown }).code === 'string' ? (e as unknown as { code: string }).code : e ? 'other' : 'none'
}

const pin = (configId: number, provider: string, model: string, unitPrice: number | null = 0.1) =>
  ({ configId, configHash: 'a'.repeat(64), provider, model, unitPrice })
const asrPin = { configId: 9, configHash: 'a'.repeat(64), provider: 'openai_audio', model: 'whisper-1' as const,
  protocol: 'openai_verbose_json' as const, policy: 'verbatim-segments-v1' as const, unitPrice: 0.02 }
const reqDurations = (plan: { shots: Array<{ id: string; duration: number }> }) =>
  Object.fromEntries(plan.shots.map((s) => [s.id, s.duration]))

const srtMs = (stamp: string): number => {
  const m = /^(\d+):(\d+):(\d+),(\d{3})$/.exec(stamp.trim())
  if (!m) throw new Error(`非法 SRT 时间戳: ${stamp}`)
  return ((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000) + Number(m[4])
}
const parseSrt = (srt: string): Array<{ id: number; start: number; end: number; text: string }> =>
  srt.trim().split(/\r?\n\r?\n/).map((block) => {
    const rows = block.split(/\r?\n/)
    const [start, end] = rows[1]!.split(' --> ')
    return { id: Number(rows[0]), start: srtMs(start!), end: srtMs(end!), text: rows.slice(2).join(' ') }
  })

/** 构造免核验对白「逐镜原声视频已生成」现场：真实 FFmpeg 合成样片 + estimated recipe run/step + StepContext。 */
async function buildEstimatedHarness(name: string, opts: { audioSource?: string; stripAudio?: boolean } = {}) {
  const { db } = await import('../src/db')
  const { inArray } = await import('drizzle-orm')
  const { projects, pipelineRuns, pipelineSteps, assets: assetsTbl } = await import('../src/db/schema')
  const { ensureProjectDirs, registerAsset, relPathOf, absPathOf, readTextAsset } = await import('../src/services/storage')
  const { resolveFfmpeg } = await import('../src/services/ffmpeg')
  const { recipeSchema } = await import('../src/services/creation-chat/recipe')
  const { compileDialogueShot } = await import('../src/services/creation-chat/dialogue')
  const { creationPlanSchema, hashJson } = await import('../src/services/creation-chat/contract')
  const { loadTemplate } = await import('../src/pipeline/loader')
  const now = Date.now()
  const plan = creationPlanSchema.parse(dialogueFixture())
  const [project] = await db.insert(projects).values({ name, createdAt: now, updatedAt: now }).returning()
  const recipe = recipeSchema.parse({ sessionId: 1, plan, endpoints: { video: pin(1, 'volcengine_video', 'doubao-seedance-2-0-260128') },
    videoMode: 't2v', requestDurations: reqDurations(plan), imageSize: '1024x1024', resolution: '720p',
    templateHash: hashJson(loadTemplate('easy-dialogue')), sources: [1, 2, 3].map((id) => ({ id, hash: 'c'.repeat(64) })), refs: [], estimatedDialogue: true })
  const [run] = await db.insert(pipelineRuns).values({ projectId: project!.id, templateKey: 'easy-dialogue',
    input: JSON.stringify({ recipe: JSON.stringify(recipe), motion: true, i2v: false }), createdAt: now, updatedAt: now }).returning()
  const [step] = await db.insert(pipelineSteps).values({ runId: run!.id, seq: 1, stepKey: 'captions', actionKey: 'dialogue_subtitle', createdAt: now, updatedAt: now }).returning()
  ensureProjectDirs(project!.id)
  const clips: Asset[] = []
  for (const [i, shot] of plan.shots.entries()) {
    const relPath = relPathOf(project!.id, 'shot_video', `${name}-${shot.id}`.replace(/[^\w.-]/g, '_') + '.mp4')
    const path = absPathOf(relPath)
    const audio = opts.audioSource ?? `sine=frequency=${440 + i * 100}:duration=7`
    const gen = spawnSync(resolveFfmpeg()!, ['-n', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x240:r=25:d=8',
      '-f', 'lavfi', '-i', audio, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
    if (gen.status !== 0) throw new Error(gen.stderr)
    if (opts.stripAudio) {
      const stripped = `${path}.noaudio.mp4`
      const cut = spawnSync(resolveFfmpeg()!, ['-n', '-v', 'error', '-i', path, '-an', '-c:v', 'copy', stripped], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
      if (cut.status !== 0) throw new Error(cut.stderr ?? '去音轨失败')
      writeFileSync(path, readFileSync(stripped))
    }
    clips.push(await registerAsset(project!.id, { name: shot.id, kind: 'video', purpose: 'shot_video', relPath,
      params: { shotId: shot.id, dialogueHash: compileDialogueShot(plan, shot.id).dialogueHash }, runId: run!.id }))
  }
  const ctx = { run: run!, step: step!, template: { key: 'easy-dialogue', version: 1, name: '探针', genre: 'story', inputs: [], steps: [] },
    def: { key: 'captions', action: 'dialogue_subtitle', title: '估算字幕', inputs: {} }, input: {}, settings: {}, log: () => {},
    assetIdsOf: (key: string) => key === 'motion_clips' ? clips.map((c) => c.id) : [], readText: readTextAsset,
    pathOf: async (id: number) => absPathOf(clips.find((c) => c.id === id)!.relPath!),
    assetsOf: async (ids: number[]) => {
      if (!ids.length) return []
      const rows = await db.select().from(assetsTbl).where(inArray(assetsTbl.id, ids))
      return ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => !!r)
    } }
  return { plan, recipe, run: run!, ctx: ctx as never }
}

/**
 * 构造免核验/严格对白「motion 步已全镜成功」现场，直供 ai_video 动作离线复跑（queue 空→只走生成后原声核验块）。
 * 专为补上 execution 节 stub startRun 从未真实执行 ai_video 的覆盖盲区（dialogueSource 误调 bug 因此逃逸）。
 */
async function buildMotionHarness(name: string, opts: { stripAudio?: boolean; strict?: boolean; tamperHash?: boolean } = {}) {
  const { db } = await import('../src/db')
  const { inArray } = await import('drizzle-orm')
  const { projects, pipelineRuns, pipelineSteps, assets: assetsTbl, genTasks } = await import('../src/db/schema')
  const { ensureProjectDirs, registerAsset, relPathOf, absPathOf } = await import('../src/services/storage')
  const { resolveFfmpeg } = await import('../src/services/ffmpeg')
  const { recipeSchema } = await import('../src/services/creation-chat/recipe')
  const { compileDialogueShot } = await import('../src/services/creation-chat/dialogue')
  const { creationPlanSchema, hashJson } = await import('../src/services/creation-chat/contract')
  const { loadTemplate } = await import('../src/pipeline/loader')
  const now = Date.now()
  const plan = creationPlanSchema.parse(dialogueFixture())
  const [project] = await db.insert(projects).values({ name, createdAt: now, updatedAt: now }).returning()
  const recipe = recipeSchema.parse({ sessionId: 1, plan, endpoints: { video: pin(1, 'volcengine_video', 'doubao-seedance-2-0-260128') },
    videoMode: 't2v', requestDurations: reqDurations(plan), imageSize: '1024x1024', resolution: '720p',
    templateHash: hashJson(loadTemplate('easy-dialogue')), sources: [1, 2, 3].map((id) => ({ id, hash: 'c'.repeat(64) })), refs: [],
    ...(opts.strict ? { asr: asrPin } : { estimatedDialogue: true }) })
  const [run] = await db.insert(pipelineRuns).values({ projectId: project!.id, templateKey: 'easy-dialogue',
    input: JSON.stringify({ recipe: JSON.stringify(recipe), motion: true, i2v: false }), createdAt: now, updatedAt: now }).returning()
  const [step] = await db.insert(pipelineSteps).values({ runId: run!.id, seq: 1, stepKey: 'motion', actionKey: 'ai_video', status: 'running', createdAt: now, updatedAt: now }).returning()
  ensureProjectDirs(project!.id)
  const clips: Asset[] = []
  for (const [i, shot] of plan.shots.entries()) {
    const relPath = relPathOf(project!.id, 'shot_video', `${name}-${shot.id}`.replace(/[^\w.-]/g, '_') + '.mp4')
    const path = absPathOf(relPath)
    const audio = `sine=frequency=${440 + i * 100}:duration=7`
    const gen = spawnSync(resolveFfmpeg()!, ['-n', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x240:r=25:d=8',
      '-f', 'lavfi', '-i', audio, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
    if (gen.status !== 0) throw new Error(gen.stderr)
    if (opts.stripAudio) {
      const stripped = `${path}.noaudio.mp4`
      const cut = spawnSync(resolveFfmpeg()!, ['-n', '-v', 'error', '-i', path, '-an', '-c:v', 'copy', stripped], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
      if (cut.status !== 0) throw new Error(cut.stderr ?? '去音轨失败')
      writeFileSync(path, readFileSync(stripped))
    }
    const dialogueHash = opts.tamperHash && i === 0 ? 'deadbeef' : compileDialogueShot(plan, shot.id).dialogueHash
    clips.push(await registerAsset(project!.id, { name: shot.id, kind: 'video', purpose: 'shot_video', relPath,
      params: { shotId: shot.id, dialogueHash }, runId: run!.id }))
    await db.insert(genTasks).values({ projectId: project!.id, runId: run!.id, stepId: step!.id, kind: 'video', status: 'succeeded',
      params: JSON.stringify({ shotId: shot.id }), attempts: 1, resultAssetId: clips[clips.length - 1]!.id, createdAt: now, updatedAt: now, completedAt: now } as never)
  }
  const clipIds = clips.map((c) => c.id)
  const ctx = { run: run!, step: step!, template: { key: 'easy-dialogue', version: 1, name: '探针', genre: 'story', inputs: [], steps: [] },
    def: { key: 'motion', action: 'ai_video', title: '对白视频', inputs: {}, batch: { field: 'shots', maxConcurrent: 1, retry: 0 }, params: { prompt_field: 'image_prompt' } },
    input: {}, settings: { video: { provider: 'volcengine_video', model: 'doubao-seedance-2-0-260128' } }, log: () => {},
    assetIdsOf: (key: string) => key === 'shots' ? [clipIds[0]!] : [], readText: async () => JSON.stringify(plan.shots),
    pathOf: async (id: number) => absPathOf(clips.find((c) => c.id === id)!.relPath!),
    assetsOf: async (ids: number[]) => {
      if (!ids.length) return []
      const rows = await db.select().from(assetsTbl).where(inArray(assetsTbl.id, ids))
      return ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => !!r)
    } }
  return { plan, recipe, run: run!, clips, ctx: ctx as never }
}

await runSections({ log, title: 'M47', checker, cleanup, sections: SECTIONS, runners: {
  // ============ recipe：estimatedDialogue 三分支 + 存量哈希逐字不变 ============
  recipe: async () => {
    const { creationPlanSchema, hashJson } = await import('../src/services/creation-chat/contract')
    const { recipeSchema, frozenSettings } = await import('../src/services/creation-chat/recipe')
    const { loadTemplate } = await import('../src/pipeline/loader')
    const { db, initDb } = await import('../src/db')
    const { projects, pipelineRuns, pipelineSteps, creationSessions } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    const { ensureProjectDirs, writeTextAsset } = await import('../src/services/storage')
    await initDb()
    await noNetwork(async () => {
      const dialoguePlan = creationPlanSchema.parse(dialogueFixture())
      const narrationPlan = creationPlanSchema.parse(narrationFixture())
      const mk = (over: Record<string, unknown> = {}) => recipeSchema.parse({ sessionId: 1, plan: dialoguePlan,
        endpoints: { video: pin(1, 'volcengine_video', 'doubao-seedance-2-0-260128') }, videoMode: 't2v',
        requestDurations: reqDurations(dialoguePlan), imageSize: '1024x1024', resolution: '720p',
        templateHash: hashJson(loadTemplate('easy-dialogue')), sources: [1, 2, 3].map((id) => ({ id, hash: 'c'.repeat(64) })), refs: [], ...over })
      const estimated = mk({ estimatedDialogue: true })
      check(estimated.estimatedDialogue === true && estimated.asr === undefined, 'estimated 对白 recipe：免核验标记合法且无 ASR 快照')
      const strict = mk({ asr: asrPin })
      check(strict.estimatedDialogue === undefined && strict.asr?.model === 'whisper-1', 'strict 对白 recipe：ASR 快照路线维持原约束（标记缺席即零新增键）')
      check(!JSON.stringify(strict).includes('estimatedDialogue'), 'strict recipe 序列化不增 estimatedDialogue 键（JSON.stringify 跳过 undefined）')
      check(hashJson(strict) === hashJson(mk({ asr: asrPin, estimatedDialogue: undefined })), '同哈希基线：带/不带显式 undefined 的可选键序列化逐字一致')
      check(String(await errOf(() => recipeSchema.parse(mk()))).includes('免核验'), '对白缺 ASR 又缺标记 → 拒绝（不静默开放）')
      check(String(await errOf(() => mk({ asr: asrPin, estimatedDialogue: true }))).includes('互斥'), 'ASR 快照与免核验标记互斥')
      const narration = recipeSchema.parse({ sessionId: 1, plan: narrationPlan,
        endpoints: { audio: pin(2, 'openai_audio', 'tts-1') }, videoMode: 'none', requestDurations: {}, voice: '亲和女声',
        imageSize: '1024x1024', resolution: '720p', templateHash: hashJson(loadTemplate('easy-video')),
        sources: [1, 2, 3].map((id) => ({ id, hash: 'c'.repeat(64) })), refs: [] })
      check(!JSON.stringify(narration).includes('estimatedDialogue'), '存量 narration recipe 零新增键（planHash 基线不动）')
      check(String(await errOf(() => recipeSchema.parse({ ...narration, estimatedDialogue: true }))).includes('旁白不得携带'), '旁白携带免核验标记 → 拒绝')
      check(String(await errOf(() => mk({ estimatedDialogue: true, videoMode: 'none' }))).includes('原生视频'), 'estimated 仍强制原生视频实例（红线不放宽）')
      check(String(await errOf(() => mk({ estimatedDialogue: true, endpoints: { video: pin(1, 'volcengine_video', 'doubao-seedance-2-0-260128'), audio: pin(2, 'openai_audio', 'tts-1') }, voice: '旁白声' }))).includes('TTS'),
        'estimated 仍禁用独立 TTS 音色（红线不放宽）')
      // frozenSettings 分流：estimated 字幕步零 ASR 解析；无标记 strict 字幕步仍要求 asr 批准快照
      const now = Date.now()
      const [project] = await db.insert(projects).values({ name: 'M47 recipe', createdAt: now, updatedAt: now }).returning()
      ensureProjectDirs(project!.id)
      const contents = [dialoguePlan.script, JSON.stringify(dialoguePlan.lines), JSON.stringify(dialoguePlan.shots)]
      const sources = []
      for (const [i, spec] of [{ name: '已批准脚本.md', purpose: 'script', format: 'markdown' }, { name: '已批准台词.json', purpose: 'lines', format: 'lines-json' }, { name: '已批准分镜.json', purpose: 'storyboard', format: 'storyboard-json' }].entries()) {
        const a = await writeTextAsset(project!.id, { ...spec, content: contents[i]! })
        sources.push({ id: a.id, hash: hashJson(contents[i]!) })
      }
      const frozen = recipeSchema.parse({ ...estimated, sessionId: 1, sources })
      const [row] = await db.insert(pipelineRuns).values({ projectId: project!.id, templateKey: 'easy-dialogue',
        input: JSON.stringify({ recipe: JSON.stringify(frozen), motion: true, i2v: false, script: [sources[0]!.id], lines: [sources[1]!.id], shots: [sources[2]!.id] }),
        templateSnapshot: JSON.stringify(loadTemplate('easy-dialogue')), createdAt: now, updatedAt: now }).returning()
      await db.insert(pipelineSteps).values({ runId: row!.id, seq: 1, stepKey: 'captions', actionKey: 'dialogue_subtitle', createdAt: now, updatedAt: now })
      // assertRecipeSources 要求 run 关联已批准会话（approvedPlan 哈希 ≡ hashJson(recipe)）
      await db.insert(creationSessions).values({ projectId: project!.id, requestKey: `m47-recipe-${now}`, status: 'started',
        approvedPlan: JSON.stringify(frozen), runId: row!.id, plan: JSON.stringify(dialoguePlan), planRevision: 1, planHash: hashJson(frozen),
        preflight: '{}', runHistory: '[]', createdAt: now, updatedAt: now })
      const runLike = { ...row!, input: JSON.stringify({ recipe: JSON.stringify(frozen), motion: true, i2v: false,
        script: [sources[0]!.id], lines: [sources[1]!.id], shots: [sources[2]!.id] }) }
      const settings = await frozenSettings(runLike as never, 'dialogue_subtitle')
      check(!!settings, 'frozenSettings：estimated 字幕步零 ASR 解析即放行（端点与素材批准链照常核验）')
      // 对照：strict 对白 recipe（带 asr 无标记）仍走 resolveStrictAsrEndpoint——本节未配 ASR 实例即拒绝（不静默零 ASR 放行）
      // 两侧哈希都取 recipeSchema.parse 归一形态，键序与 recipeOf 重解析逐字一致（assertRecipeSources 方能通过）
      const strictRecipe = recipeSchema.parse({ ...frozen, estimatedDialogue: undefined, asr: asrPin })
      await db.update(creationSessions).set({ approvedPlan: JSON.stringify(strictRecipe) }).where(eq(creationSessions.id, 1))
      const strictRun = { ...runLike, input: JSON.stringify({ ...JSON.parse(runLike.input), recipe: JSON.stringify(strictRecipe) }) }
      const strictErr = await errOf(() => frozenSettings(strictRun as never, 'dialogue_subtitle'))
      check(!!strictErr && String(strictErr).includes('whisper-1'), 'strict 字幕步仍强制解析 ASR 快照：无 ASR 实例即拒绝（estimated 零 ASR 分流不误放）')
    })
  },

  // ============ preflight：策略分流 + dialogueMode 顶层透出不改哈希 ============
  preflight: async () => {
    const { db, initDb } = await import('../src/db')
    const { apiConfigs, projects, settings } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    const { creationPlanSchema } = await import('../src/services/creation-chat/contract')
    const { preflightPlan } = await import('../src/services/creation-chat/preflight')
    await initDb()
    await db.delete(apiConfigs)
    await db.delete(settings)
    const now = Date.now()
    const insertCfg = async (v: Record<string, unknown>) => {
      await db.insert(apiConfigs).values({ name: String(v.name), providerKey: v.providerKey, serviceType: v.serviceType, apiKeyRef: 'env:PROBE_M47_KEY',
        baseUrl: 'http://localhost:0/offline', model: v.model, extra: JSON.stringify(v.extra ?? {}), pricing: JSON.stringify(v.pricing ?? {}),
        isActive: 1, isDefault: 1, priority: 0, createdAt: now, updatedAt: now } as never)
    }
    await insertCfg({ name: 'llm', providerKey: 'deepseek_llm', serviceType: 'llm', model: 'probe-llm' })
    await insertCfg({ name: 'video', providerKey: 'volcengine_video', serviceType: 'video', model: 'doubao-seedance-2-0-260128', pricing: { second: 0.1 } })
    await insertCfg({ name: 'image', providerKey: 'openai_image', serviceType: 'image', model: 'probe-img', pricing: { image: 0.1 } })
    await insertCfg({ name: 'audio', providerKey: 'openai_audio', serviceType: 'audio', model: 'probe-tts', pricing: { char: 0.01 } })
    const [project] = await db.insert(projects).values({ name: 'M47 预检', createdAt: now, updatedAt: now }).returning()
    const plan = creationPlanSchema.parse(dialogueFixture())
    await noNetwork(async () => {
      let pf = await preflightPlan(project!.id, plan)
      check(pf.dialogueMode === 'strict' && !pf.ready && pf.issues.some((i) => i.code === 'missing_asr'),
        '默认严格（未配 ASR）：missing_asr 拒绝语义零回归，dialogueMode=strict')
      await db.update(projects).set({ settings: JSON.stringify({ dialogue_asr: { strict: false } }) }).where(eq(projects.id, project!.id))
      pf = await preflightPlan(project!.id, plan)
      check(pf.ready && pf.dialogueMode === 'estimated' && pf.execution?.estimatedDialogue === true && !pf.execution.asr && !pf.execution.voice && !pf.execution.endpoints.audio,
        '项目覆盖 OFF + 背书模型：免核验快照（零 ASR、零 TTS），dialogueMode=estimated')
      check(pf.estimate.asrSeconds === undefined && pf.estimate.voiceChars === 0 && pf.estimate.videoSeconds === 32,
        '免核验费用预估不含 ASR 秒数与 TTS 字符，仅视频秒数')
      check(pf.dialogueMode === 'estimated' && !('dialogueMode' in pf.execution!),
        'dialogueMode 仅顶层透出：不进 execution → 免核验不改 planHash（顶层加法先例）')
      await db.update(projects).set({ settings: '{}' }).where(eq(projects.id, project!.id))
      await db.insert(settings).values({ key: 'dialogue_asr', value: JSON.stringify({ strict: false }), updatedAt: now })
      pf = await preflightPlan(project!.id, plan)
      check(pf.dialogueMode === 'estimated', '全局 OFF（无项目覆盖）→ 继承走免核验')
      const [project2] = await db.insert(projects).values({ name: 'M47 预检-项目开', settings: JSON.stringify({ dialogue_asr: { strict: true } }), createdAt: now, updatedAt: now }).returning()
      pf = await preflightPlan(project2!.id, plan)
      check(pf.dialogueMode === 'strict' && !pf.ready && pf.issues.some((i) => i.code === 'missing_asr'), '项目覆盖 ON 压过全局 OFF → 维持现状严格路线')
      await db.delete(settings)
      await db.update(projects).set({ settings: JSON.stringify({ dialogue_asr: { strict: false } }) }).where(eq(projects.id, project2!.id))
      await db.update(apiConfigs).set({ model: 'doubao-seedance-1-0-pro-250528' }).where(eq(apiConfigs.serviceType, 'video'))
      pf = await preflightPlan(project2!.id, plan)
      check(!pf.ready && pf.issues.some((i) => i.code === 'native_dialogue_unsupported'), 'OFF 但未命中原生对白背书 → 422 可行动拒绝（不假开放免核验）')
      const narration = creationPlanSchema.parse(narrationFixture())
      pf = await preflightPlan(project!.id, narration)
      check(pf.ready && pf.dialogueMode === null && !!pf.execution?.voice && pf.estimate.voiceChars > 0, '旁白会话零回归：dialogueMode=null、TTS 音色照常')
    })
  },

  // ============ execution：冻结闸条件放行（estimated 可开始制作，strict 仍冻结） ============
  execution: async () => {
    const { db, initDb } = await import('../src/db')
    const { apiConfigs, creationSessions, pipelineRuns, projects, settings } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    const { creationPlanSchema, hashJson } = await import('../src/services/creation-chat/contract')
    const { recipeSchema } = await import('../src/services/creation-chat/recipe')
    const { preflightPlan } = await import('../src/services/creation-chat/preflight')
    const { confirmCreation } = await import('../src/services/creation-chat/execution')
    const { snapshotStrictAsr } = await import('../src/services/strict-asr')
    const { loadTemplate } = await import('../src/pipeline/loader')
    const engine = await import('../src/pipeline/engine')
    await initDb()
    await db.delete(apiConfigs)
    await db.delete(settings)
    const now = Date.now()
    const insertCfg = async (v: Record<string, unknown>) => {
      await db.insert(apiConfigs).values({ name: String(v.name), providerKey: v.providerKey, serviceType: v.serviceType, apiKeyRef: 'env:PROBE_M47_KEY',
        baseUrl: 'http://localhost:0/offline', model: v.model, extra: JSON.stringify(v.extra ?? {}), pricing: JSON.stringify(v.pricing ?? {}),
        isActive: 1, isDefault: 1, priority: 0, createdAt: now, updatedAt: now } as never)
    }
    await insertCfg({ name: 'llm', providerKey: 'deepseek_llm', serviceType: 'llm', model: 'probe-llm' })
    await insertCfg({ name: 'video', providerKey: 'volcengine_video', serviceType: 'video', model: 'doubao-seedance-2-0-260128', pricing: { second: 0.1 } })
    await insertCfg({ name: 'image', providerKey: 'openai_image', serviceType: 'image', model: 'probe-img', pricing: { image: 0.1 } })
    await insertCfg({ name: 'audio', providerKey: 'openai_audio', serviceType: 'audio', model: 'probe-tts', pricing: { char: 0.01 } })
    await insertCfg({ name: 'asr', providerKey: 'openai_audio', serviceType: 'audio', model: 'tts-1', extra: { asr_model: 'whisper-1', asr_protocol: 'openai_verbose_json' }, pricing: { asr: { model: 'whisper-1', second: 0.02 } } })
    const plan = creationPlanSchema.parse(dialogueFixture())
    const templateHash = hashJson(loadTemplate('easy-dialogue'))
    const origStart = engine.engine.startRun.bind(engine.engine)
    const started: number[] = []
    engine.engine.startRun = ((runId: number): 'started' => { started.push(runId); return 'started' }) as typeof engine.engine.startRun
    try {
      await noNetwork(async () => {
        const [project] = await db.insert(projects).values({ name: 'M47 免核验执行', settings: JSON.stringify({ dialogue_asr: { strict: false } }), createdAt: now, updatedAt: now }).returning()
        const pf = await preflightPlan(project!.id, plan)
        check(pf.ready && pf.dialogueMode === 'estimated', '执行节基线：OFF + 背书 → 预检就绪免核验')
        const key = `m47-exec-${now}`
        await db.insert(creationSessions).values({ projectId: project!.id, requestKey: key, status: 'ready', plan: JSON.stringify(plan),
          planRevision: 1, planHash: hashJson({ plan, execution: pf.execution }), preflight: JSON.stringify(pf), runHistory: '[]', createdAt: now, updatedAt: now })
        const [session] = await db.select().from(creationSessions).where(eq(creationSessions.requestKey, key))
        const confirmed = await confirmCreation(session!.id, { planRevision: 1, planHash: hashJson({ plan, execution: pf.execution }), idempotencyKey: `m47idem-${now}`, acceptUnpriced: true })
        check(confirmed.runId > 0 && started.length === 1, '免核验对白「开始制作」放行：冻结闸不再无条件拒绝并真实启动')
        const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, confirmed.runId))
        const frozen = recipeSchema.parse(JSON.parse(JSON.parse(run!.input!).recipe))
        check(run!.templateKey === 'easy-dialogue' && frozen.estimatedDialogue === true && !frozen.asr && !frozen.voice,
          'run 冻结免核验 recipe：无 ASR 快照、无 TTS 音色')
        // strict 对白：预检可通过（ASR 已配）但执行仍冻结（dialogue_unavailable，等真实接 ASR 另立项解冻）
        const asr = await snapshotStrictAsr()
        const execution = { plan, endpoints: { video: pin(2, 'volcengine_video', 'doubao-seedance-2-0-260128'), image: pin(3, 'openai_image', 'probe-img') },
          videoMode: 'i2v' as const, requestDurations: reqDurations(plan), imageSize: '1024x1024', resolution: '720p', templateHash, refs: [], asr }
        const [strictProject] = await db.insert(projects).values({ name: 'M47 严格执行', createdAt: now, updatedAt: now }).returning()
        const strictKey = `m47-exec-strict-${now}`
        await db.insert(creationSessions).values({ projectId: strictProject!.id, requestKey: strictKey, status: 'ready', plan: JSON.stringify(plan),
          planRevision: 1, planHash: hashJson({ plan, execution }), preflight: '{"ready":true,"issues":[],"execution":null,"estimate":{"knownCost":0,"unpriced":[],"imageCount":4,"videoSeconds":32,"voiceChars":0,"refCount":0,"videoAnalysisCount":0,"asrSeconds":32},"planningModel":null,"resolutionOptions":null,"brandSummary":null,"dialogueMode":"strict"}', runHistory: '[]', createdAt: now, updatedAt: now })
        const [strictSession] = await db.select().from(creationSessions).where(eq(creationSessions.requestKey, strictKey))
        check(await codeOf(() => confirmCreation(strictSession!.id, { planRevision: 1, planHash: hashJson({ plan, execution }), idempotencyKey: `m47idem-s-${now}`, acceptUnpriced: true })) === 'dialogue_unavailable',
          'strict 对白执行链保持冻结：dialogue_unavailable 且给出可行动的关闭指引')
        check(started.length === 1, '冻结闸拒绝不启动任何 run')
      })
    } finally { engine.engine.startRun = origStart }
  },

  // ============ srt：估算字幕纯函数（分配/单调/越界/空台词拒绝） ============
  srt: async () => {
    const { creationPlanSchema, hashJson } = await import('../src/services/creation-chat/contract')
    const { estimatedDialogueSrt, estimatedValidationHash, ESTIMATED_DIALOGUE_POLICY } = await import('../src/services/creation-chat/dialogue-media')
    const plan = creationPlanSchema.parse(dialogueFixture())
    const clips = plan.shots.map((s: { id: string; duration: number }) => ({ shotId: s.id, duration: s.duration, videoDuration: 8 }))
    const cueTexts = plan.lines.map((l: { text: string }) => l.text)
    const cues = parseSrt(estimatedDialogueSrt(plan, clips))
    check(cues.length === plan.lines.length && cues.every((c, i) => c.id === i + 1), '逐句一条 cue，序号连续')
    check(cues.every((c) => c.end > c.start), '每条估算字幕区间为正')
    check(cues.every((c, i) => i === 0 || c.start >= cues[i - 1]!.end), '跨镜时间戳单调不回退')
    const totalMs = plan.shots.reduce((n: number, s: { duration: number }) => n + s.duration, 0) * 1000
    check(cues.every((c) => c.end <= totalMs), '全部 cue 落在成片总长内')
    const window = Math.min(plan.shots[0]!.duration, 8)
    const shotWeights = plan.shots[0]!.lines.map((id: string) => [...plan.lines.find((l: { id: string }) => l.id === id)!.text].length)
    const firstShare = shotWeights[0]! / shotWeights.reduce((a: number, b: number) => a + b, 0)
    check(cues[0]!.start === Math.round(0.3 * 1000), '首镜首句固定 0.3s 起播余量')
    check(cues[0]!.end === Math.round((0.3 + firstShare * (window - 0.3)) * 1000), '首句终点按归一字数占比分配（非均分）')
    check(cues[0]!.text === cueTexts[0]!, 'cue 文本为批准台词逐字')
    check(estimatedValidationHash(clips.map((c: { shotId: string; duration: number; videoDuration: number }) => ({ ...c, timing: { videoStart: 0, audioStart: 0, videoDuration: c.videoDuration, audioDuration: c.videoDuration } })))
      === hashJson({ policy: ESTIMATED_DIALOGUE_POLICY, clips: clips.map(({ shotId, duration, videoDuration }: { shotId: string; duration: number; videoDuration: number }) => ({ shotId, duration, videoDuration })) }),
      '估算校验哈希只冻结台词窗口三要素（与字幕步同源）')
    check(String(await errOf(() => estimatedDialogueSrt(plan, [{ shotId: 's9', duration: 8, videoDuration: 8 }]))).includes('不在批准分镜'), '幽灵镜头拒绝')
    check(String(await errOf(() => estimatedDialogueSrt(plan, clips.map((c: { shotId: string; duration: number; videoDuration: number }, i: number) => i === 0 ? { ...c, videoDuration: 0.4 } : c)))).includes('窗口不足'),
      '实测时长窗口不足起播余量 → 拒绝')
    // 空台词镜头守卫为防御性兜底（对白 schema 本身要求每镜至少一句，故绕开 schema 直测纯函数）
    const silentShot = structuredClone(dialogueFixture())
    silentShot.shots[0]!.lines = []
    check(String(await errOf(() => estimatedDialogueSrt(silentShot as never, silentShot.shots.map((s: { id: string; duration: number }) => ({ shotId: s.id, duration: s.duration, videoDuration: 8 }))))).includes('没有台词'),
      '空台词镜头拒绝估算（不产空洞 cue）')
    const padded = structuredClone(dialogueFixture())
    padded.lines[0]!.text = '超长台词。'.repeat(20)
    padded.shots[0]!.duration = 2
    padded.duration = 26
    check(!!await errOf(() => estimatedDialogueSrt(creationPlanSchema.parse(padded), padded.shots.map((s: { id: string; duration: number }) => ({ shotId: s.id, duration: s.duration, videoDuration: 8 })))),
      '窗口区间被越界时拒绝（不截断不伪造）')
  },

  // ============ action：dialogue_subtitle estimated 分支（零网络零计费 + 守卫） ============
  action: async () => {
    const harness = await buildEstimatedHarness('M47 字幕动作')
    const { db } = await import('../src/db')
    const { assets, genTasks, usageRecords, pipelineRuns, apiConfigs } = await import('../src/db/schema')
    const { eq, and } = await import('drizzle-orm')
    const { readTextAsset } = await import('../src/services/storage')
    const { dialogueSubtitle } = await import('../src/pipeline/actions/dialogue-subtitle')
    const { recipeSchema } = await import('../src/services/creation-chat/recipe')
    await db.delete(apiConfigs)
    await noNetwork(async () => {
      const first = await dialogueSubtitle(harness.ctx)
      const subtitleId = first.assetIds[0]!
      const [sub] = await db.select().from(assets).where(eq(assets.id, subtitleId))
      const params = JSON.parse(sub!.params!)
      check(params.estimated === true && params.policy === 'estimated-lines-v1' && typeof params.validationHash === 'string' && params.validationHash.length === 64,
        '估算字幕资产诚实标注 estimated + policy + validationHash')
      const srt = await readTextAsset(subtitleId)
      check(srt.includes(harness.plan.lines[0]!.text) && srt.includes(harness.plan.lines[3]!.text), '四镜台词全部进估算字幕')
      const audios = await db.select().from(assets).where(and(eq(assets.purpose, 'dialogue_audio'), eq(assets.runId, harness.run.id)))
      check(audios.length === 4 && audios.every((a) => JSON.parse(a.params ?? '{}').estimated === true), '逐镜原声轨 wav 登记为 dialogue_audio 资产供溯源')
      check((await db.select().from(genTasks).where(eq(genTasks.runId, harness.run.id))).length === 0
        && (await db.select().from(usageRecords).where(eq(usageRecords.runId, harness.run.id))).length === 0,
        'estimated 分支零 genTasks、零 usageRecords（零付费承诺的机械保证）')
      const second = await dialogueSubtitle(harness.ctx)
      check(second.assetIds[0] === subtitleId, '重入复用同源估算字幕（不重写资产）')
      const silent = await buildEstimatedHarness('M47 静音守卫', { audioSource: 'anullsrc=r=16000:cl=mono:d=8' })
      check(String(await errOf(() => dialogueSubtitle(silent.ctx))).includes('静音'), '静音原声轨在估算字幕步即拒绝（非静音守卫不放宽）')
      const strictRecipe = recipeSchema.parse({ ...harness.recipe, estimatedDialogue: undefined, asr: asrPin })
      const strictRunRow = { ...harness.run, input: JSON.stringify({ ...JSON.parse(harness.run.input!), recipe: JSON.stringify(strictRecipe) }) }
      const strictCtx = { ...harness.ctx as object, run: strictRunRow }
      check(await codeOf(() => dialogueSubtitle(strictCtx as never)) === 'missing_asr', '无标记 strict 字幕步仍强制解析 ASR 快照：分流不误放（estimated 不触 ASR，strict 无实例即拒）')
    })
  },

  // ============ motion：ai_video 步原声核验块按路线分流（免核验不误调 strict 专用 dialogueSource） ============
  motion: async () => {
    const { aiVideo } = await import('../src/pipeline/actions/ai-video')
    const { initDb } = await import('../src/db')
    await initDb()
    await noNetwork(async () => {
      const est = await buildMotionHarness('M47 对白视频步')
      check(est.recipe.estimatedDialogue === true && !est.recipe.asr, 'motion 基线：免核验 recipe 无 ASR 快照')
      const res = await aiVideo(est.ctx)
      check(res.assetIds.length === 4, '免核验对白 ai_video 全镜复用成功产物并通过原声核验（修复前此步误抛「缺少批准的严格 ASR 快照」）')
      // 免核验跳过 strict 专用身份校验 → 篡改 dialogueHash 不影响 motion 步（改由合成/审阅把关）
      const estTamper = await buildMotionHarness('M47 免核验-篡改哈希', { tamperHash: true })
      check((await aiVideo(estTamper.ctx)).assetIds.length === 4, '免核验跳过 dialogueSource 身份校验：篡改 dialogueHash 不影响 motion 步')
    })
    // 原声音轨实测守卫不因分流而放宽（guard 不能一刀切跳过 inspectDialogueMedia）
    const noAudio = await buildMotionHarness('M47 对白视频步-缺原声', { stripAudio: true })
    check(String(await errOf(() => aiVideo(noAudio.ctx))).includes('音轨'), '缺原声轨视频仍被拒（媒体实测守卫不放宽）')
    // strict 路线仍调 dialogueSource：篡改哈希被身份校验拦下（证明 guard 仅放行 estimated、不空转 strict）
    const strict = await buildMotionHarness('M47 严格-篡改哈希', { strict: true, tamperHash: true })
    check(String(await errOf(() => aiVideo(strict.ctx))).includes('不属于当前批准'), 'strict 路线仍执行 dialogueSource 身份校验：篡改对白哈希被拒')
  },

  // ============ merge：estimated 合成同源重算 + 陈旧/缺原声拒绝 ============
  merge: async () => {
    const harness = await buildEstimatedHarness('M47 合成')
    const { db } = await import('../src/db')
    const { assets, usageRecords } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    const { absPathOf } = await import('../src/services/storage')
    const { ffmpegMerge } = await import('../src/pipeline/actions/ffmpeg-merge')
    const { dialogueSubtitle } = await import('../src/pipeline/actions/dialogue-subtitle')
    const { inspectDialogueMedia } = await import('../src/services/creation-chat/dialogue-media')
    await noNetwork(async () => {
      const subtitle = (await dialogueSubtitle(harness.ctx)).assetIds[0]!
      const mergeCtx = { ...harness.ctx as object,
        def: { key: 'compose', action: 'ffmpeg_merge', title: '对白合成', inputs: {}, params: { strict_delivery: true, fps: 25 } },
        assetIdsOf: (key: string) => key === 'subtitle' ? [subtitle] : (harness.ctx as { assetIdsOf: (k: string) => number[] }).assetIdsOf(key) }
      const result = await ffmpegMerge(mergeCtx as never)
      const [out] = await db.select().from(assets).where(eq(assets.id, result.assetIds[0]!))
      const timing = inspectDialogueMedia(absPathOf(out!.relPath!))
      const params = JSON.parse(out!.params!)
      check(timing.videoDuration >= 31.5 && timing.audioDuration > 27, '免核验合成交付 32 秒级原声双流成片')
      check(params.performance === 'dialogue' && params.dialogue_subtitles_estimated === true && params.dialogue_review_required === true && params.voices === 0,
        '成片 params 诚实标注估算字幕并强制人工审阅')
      check(Array.isArray(params.dialogue_clips) && params.dialogue_clips.length === 4 && params.dialogue_clips.every((c: { videoDuration?: number }) => typeof c.videoDuration === 'number'),
        '成片 clips 溯源携带实测 videoDuration（估算窗口来自实测非计划值）')
      const costsAfter = await db.select().from(usageRecords).where(eq(usageRecords.runId, harness.run.id))
      check(costsAfter.length === 0, '估算合成零网络、零新增计费')
      // 篡改估算字幕内容 → 同源重算比对拒绝陈旧
      const [sub] = await db.select().from(assets).where(eq(assets.id, subtitle))
      const bytes = readFileSync(absPathOf(sub!.relPath!))
      writeFileSync(absPathOf(sub!.relPath!), bytes.toString('utf8').replace(harness.plan.lines[0]!.text, '不相干的台词文本'))
      check(String(await errOf(() => ffmpegMerge(mergeCtx as never))).includes('陈旧'), '篡改估算字幕 → 合成拒绝，不消费陈旧产物')
      writeFileSync(absPathOf(sub!.relPath!), bytes)
      check(!!await errOf(async () => {
        const originalParams = JSON.parse(sub!.params!)
        await db.update(assets).set({ params: JSON.stringify({ ...originalParams, validationHash: 'f'.repeat(64) }) }).where(eq(assets.id, subtitle))
        await ffmpegMerge(mergeCtx as never)
      }), 'validationHash 不符（跨路线/陈旧字幕）同样拒绝')
      writeFileSync(absPathOf(sub!.relPath!), readFileSync(absPathOf(sub!.relPath!)))
    })
    // 缺原声轨 → 字幕步来源实测守卫拒绝（合成步共用同族守卫）
    const noAudio = await buildEstimatedHarness('M47 缺原声', { stripAudio: true })
    check(String(await errOf(async () => {
      const ds = (await import('../src/pipeline/actions/dialogue-subtitle')).dialogueSubtitle
      await ds(noAudio.ctx)
    })).includes('音轨'), '缺原声音轨的视频在字幕步即拒绝（禁止替换为 TTS 红线不动）')
  },

  // ============ plan：规划注入三段式（真实写链口径：stub LLM 回放捕获 messages） ============
  plan: async () => {
    const { db, initDb } = await import('../src/db')
    const { apiConfigs, creationSessions, projects, settings } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    const { sendCreationMessage } = await import('../src/services/creation-chat/planning')
    await initDb()
    await db.delete(apiConfigs)
    await db.delete(settings)
    const now = Date.now()
    const insertCfg = async (v: Record<string, unknown>) => {
      await db.insert(apiConfigs).values({ name: String(v.name), providerKey: v.providerKey, serviceType: v.serviceType, apiKeyRef: 'env:PROBE_M47_KEY',
        baseUrl: 'http://localhost:0/offline', model: v.model, extra: JSON.stringify(v.extra ?? {}), pricing: JSON.stringify(v.pricing ?? {}),
        isActive: 1, isDefault: 1, priority: 0, createdAt: now, updatedAt: now } as never)
    }
    await insertCfg({ name: 'llm', providerKey: 'deepseek_llm', serviceType: 'llm', model: 'probe-llm', pricing: { tokens_in: 2, tokens_out: 8 } })
    await insertCfg({ name: 'video', providerKey: 'volcengine_video', serviceType: 'video', model: 'doubao-seedance-2-0-260128', pricing: { second: 0.1 } })
    await insertCfg({ name: 'image', providerKey: 'openai_image', serviceType: 'image', model: 'probe-img', pricing: { image: 0.1 } })
    await insertCfg({ name: 'audio', providerKey: 'openai_audio', serviceType: 'audio', model: 'probe-tts', extra: { voice: 'probe-voice' }, pricing: { char: 0.1 } })
    const planJson = JSON.stringify(dialogueFixture())
    const captured: string[][] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input)
      if (!url.includes('localhost:0')) throw new Error(`规划节仅允许触达 stub LLM: ${url}`)
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content: unknown }> }
      captured.push((body.messages ?? []).filter((m) => m.role === 'system').map((m) => String(m.content ?? '')))
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: 'plan', message: '已按需求生成方案', plan: JSON.parse(planJson) }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const mkSession = async (policySettings?: string): Promise<number> => {
        const t = Date.now()
        const [project] = await db.insert(projects).values({ name: 'M47 规划注入', genre: 'other', templateKey: 'easy-video', status: 'draft', ...(policySettings ? { settings: policySettings } : {}), tags: JSON.stringify(['轻松创作']), createdAt: t, updatedAt: t }).returning()
        const key = `m47-plan-${t}-${Math.random().toString(36).slice(2, 7)}`
        await db.insert(creationSessions).values({ projectId: project!.id, requestKey: key, status: 'draft', planRevision: 0, runHistory: '[]', createdAt: t, updatedAt: t })
        const [session] = await db.select().from(creationSessions).where(eq(creationSessions.requestKey, key))
        return session!.id
      }
      const capability = (messages: string[]): string => messages.find((m) => m.includes('【人物对白能力】')) ?? ''
      await sendCreationMessage(await mkSession(), { content: '两个好友在书房找一封信，需要人物对话。', requestKey: `m47msg-a-${Date.now()}` })
      let injected = capability(captured.pop() ?? [])
      check(injected.includes('必须保留 performance=dialogue') && !injected.includes('免核验'), '默认 ON：现状指令逐字保留（不得降级旁白或图文）')
      await sendCreationMessage(await mkSession(JSON.stringify({ dialogue_asr: { strict: false } })), { content: '两个好友在书房找一封信，需要人物对话。', requestKey: `m47msg-b-${Date.now()}` })
      injected = capability(captured.pop() ?? [])
      check(injected.includes('免核验对白路线') && injected.includes('字幕按批准台词估算') && injected.includes('人工审阅') && injected.includes('产出 performance=dialogue'),
        'OFF + 背书：允许产出对白并声明免核验/估算字幕/人工审阅为准')
      await db.update(apiConfigs).set({ model: 'doubao-seedance-1-0-pro-250528' }).where(eq(apiConfigs.serviceType, 'video'))
      await sendCreationMessage(await mkSession(JSON.stringify({ dialogue_asr: { strict: false } })), { content: '两个好友在书房找一封信，需要人物对话。', requestKey: `m47msg-c-${Date.now()}` })
      injected = capability(captured.pop() ?? [])
      check(injected.includes('未命中原生对白背书') && injected.includes('改用 performance=narration'), 'OFF + 未背书：维持路 A 降级旁白指令（不产出会被预检拒绝的对白）')
      check(captured.every((messages) => !messages.some((m) => m.includes('【人物对白能力】'))), '每轮规划仅注入一条对白能力指令（无重复分片）')
    } finally { globalThis.fetch = original }
  },
} })
