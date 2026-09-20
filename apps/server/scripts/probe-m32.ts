/**
 * M32 探针（视频能力/默认单一真源表 + Tier A 智能默认引擎）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m32.ts [--section=registry|preflight|equivalence|degrade|normalize]
 *
 * 隔离策略：isolatedEnv('m32', bridge templates/prompts) 一次性临时目录（独立 studio.db + workspace），
 * 必须先于任何 src 动态 import。零网络、零付费模型调用、零计费：preflightPlan 为纯只读函数，
 * 只读取 api_configs + 计算档位/预估，绝不触发生成；engine 不在本探针路径内。
 *
 * 分节：
 *   - registry：resolveVideoCaps 对 4 家背书供应商逐字段命中、siliconflow/未知供应商 fail-closed（null）；
 *   - preflight：不写 creationCapabilities、仅设 provider+model → dynamic 预检就绪（Tier A 背书）；未知供应商 → capabilities_unverified；
 *   - equivalence：同一 provider+model，「显式存储 caps」与「按表背书」两条路径的 execution 字段完全一致；
 *   - degrade：t2v-only（pollinations）方案含首帧 → 仍 first_frame_unsupported（红线不降）；
 *   - normalize：clampDuration / mapResolution / snapPollinationsDuration 逐值与迁移前适配器实现一致。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup: envCleanup } = isolatedEnv('m32', { bridge: ['templates', 'prompts'] })
process.env.PROBE_M32_KEY = 'probe-m32-offline-secret-key-9c3f'

const SECTIONS = ['registry', 'preflight', 'equivalence', 'degrade', 'normalize'] as const

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m32')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  const mkProject = async (name: string): Promise<number> => {
    const { initDb, db } = await import('../src/db')
    const { projects } = await import('../src/db/schema')
    await initDb()
    const t = Date.now()
    return (await db.insert(projects).values({ name, genre: 'talking_head', templateKey: 'easy-video', status: 'active', settings: '{}', tags: '[]', createdAt: t, updatedAt: t } as never).returning())[0]!.id
  }

  // 仅播种 llm/audio/image 基础端点 + 一个可配 provider/model/caps 的 video 端点
  const seed = async (video: { providerKey: string; model: string; caps?: unknown }): Promise<void> => {
    const { initDb, db } = await import('../src/db')
    await initDb()
    const { apiConfigs } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    for (const s of ['llm', 'audio', 'video', 'image']) await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, s))
    const t = Date.now()
    const insert = (v: Record<string, unknown>) => db.insert(apiConfigs).values({ name: String(v.name), providerKey: v.providerKey, serviceType: v.serviceType, apiKeyRef: 'env:PROBE_M32_KEY', baseUrl: 'http://localhost:0/offline', model: v.model, extra: JSON.stringify(v.extra ?? {}), pricing: v.pricing ?? '{}', isActive: 1, isDefault: 1, priority: 0, createdAt: t, updatedAt: t } as never)
    await insert({ name: 'llm', providerKey: 'deepseek_llm', serviceType: 'llm', model: 'probe-llm', pricing: '{"tokens_in":2,"tokens_out":8}' })
    await insert({ name: 'audio', providerKey: 'openai_audio', serviceType: 'audio', model: 'probe-tts', extra: { voice: 'probe-voice' }, pricing: '{"char":0.1}' })
    await insert({ name: 'image', providerKey: 'openai_image', serviceType: 'image', model: 'probe-img', pricing: '{"image":0.1}' })
    await insert({ name: 'video', providerKey: video.providerKey, serviceType: 'video', model: video.model, extra: video.caps ? { creationCapabilities: video.caps } : {}, pricing: '{"second":0.1}' })
  }

  const buildPlan = async (mode: 'dynamic', opts: { aspectRatio?: string; duration?: number; firstFrame?: boolean } = {}) => {
    const { creationPlanSchema } = await import('../src/services/creation-chat/contract')
    const shots = [
      { id: 's1', duration: opts.duration ?? 10, image_prompt: 'A', motion_prompt: '推近', lines: ['l1'] },
      { id: 's2', duration: opts.duration ?? 10, image_prompt: 'B', motion_prompt: '环绕', lines: ['l2'] },
      { id: 's3', duration: opts.duration ?? 10, image_prompt: 'C', motion_prompt: '下移', lines: ['l3'] },
    ]
    const refs = opts.firstFrame ? [{ assetId: 900, kind: 'image', role: 'first_frame', hash: 'a'.repeat(64), shotId: 's1' }] : []
    return creationPlanSchema.parse({
      title: 'M32 探针方案', summary: '三镜', genre: 'science', duration: (opts.duration ?? 10) * 3,
      aspectRatio: opts.aspectRatio ?? '9:16', language: 'zh-CN', mode, style: '轻松科普',
      script: '一。\n二。\n三。',
      lines: [{ id: 'l1', text: '一' }, { id: 'l2', text: '二' }, { id: 'l3', text: '三' }],
      shots, refs,
    })
  }

  const preflight = async (projectId: number, plan: unknown) => {
    const { preflightPlan } = await import('../src/services/creation-chat/preflight')
    return preflightPlan(projectId, plan as never)
  }

  const runners: Record<string, () => Promise<void>> = {
    // ================= registry：命中逐字段 + fail-closed =================
    registry: async () => {
      const { resolveVideoCaps } = await import('../src/adapters/video-capabilities')
      const mini = resolveVideoCaps('minimax_video', 'MiniMax-H3')
      check(!!mini && mini.modes.join() === 'i2v,t2v' && mini.durations[0] === 4 && mini.durations[mini.durations.length - 1] === 15 && mini.resolutions.join() === '768P,2K' && mini.defaultResolution === '768P', 'minimax 背书档位：i2v+t2v / 4–15 秒 / 768P·2K（对齐迁移前约束）')
      const volc = resolveVideoCaps('volcengine_video', 'doubao-seedance-2-0-mini')
      check(!!volc && volc.resolutions.join() === '480p,720p' && volc.defaultResolution === '720p' && volc.durations[0] === 4 && volc.durations[volc.durations.length - 1] === 15, 'volcengine 背书档位：480p·720p / 4–15 秒')
      const aliyun = resolveVideoCaps('aliyun_wan_video', 'wan3.0-video-prime')
      check(!!aliyun && aliyun.durations[0] === 2 && aliyun.resolutions.includes('1080p'), 'aliyun 背书档位：2–30 秒 / 含 1080p')
      const pollMinimax = resolveVideoCaps('pollinations_video', 'minimax/minimax-h3-max-turbo')
      check(!!pollMinimax && pollMinimax.modes.join() === 't2v' && pollMinimax.durations.join() === '5,10,15' && pollMinimax.resolutions.join() === '480p', 'pollinations·minimax：t2v-only / 5,10,15 / 480p（无首帧注入）')
      const pollOther = resolveVideoCaps('pollinations_video', 'google/veo-3.1-fast')
      check(!!pollOther && pollOther.durations.join() === '5,10' && pollOther.resolutions.join() === '720p', 'pollinations·非 minimax：5,10 / 720p')
      check(resolveVideoCaps('siliconflow_video', 'Wan2.2-I2V-A14B') === null, 'siliconflow 不自动背书（产出时长未文档化 → fail-closed 须显式声明）')
      check(resolveVideoCaps('unknown_video', 'x') === null, '未知供应商 → null（不猜）')
    },

    // ================= preflight：Tier A 背书生效 / 未知供应商报错 =================
    preflight: async () => {
      await seed({ providerKey: 'minimax_video', model: 'MiniMax-H3' })
      const pid = await mkProject('m32-pf-auto')
      const pf = await preflight(pid, await buildPlan('dynamic'))
      check(pf.ready, `minimax 无 creationCapabilities 声明：dynamic 预检就绪（Tier A 按表背书）${pf.issues.length ? ' 实际 issues=' + JSON.stringify(pf.issues) : ''}`)
      check(pf.execution?.videoMode === 'i2v' && pf.execution?.resolution === '768P', '背书执行：videoMode=i2v、resolution 归一为 768P')
      const durs = Object.values(pf.execution?.requestDurations ?? {})
      check(durs.length === 3 && durs.every((d) => d === 10), '背书按镜头就近取档（10s→10s）')

      await seed({ providerKey: 'unknown_video', model: 'weird-model' })
      const pid2 = await mkProject('m32-pf-unknown')
      const pf2 = await preflight(pid2, await buildPlan('dynamic'))
      check(pf2.issues[0]?.code === 'capabilities_unverified', '未知供应商 → capabilities_unverified（fail-closed，不猜档位）')
    },

    // ================= equivalence：显式存储 vs 按表背书 → execution 完全一致 =================
    equivalence: async () => {
      const stored = { model: 'volcengine-seed', verified: true, modes: ['i2v', 't2v'], durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], aspectRatios: ['9:16', '16:9', '1:1'], resolution: '720p' }
      await seed({ providerKey: 'volcengine_video', model: 'volcengine-seed', caps: stored })
      const pidA = await mkProject('m32-eq-stored')
      const pfA = await preflight(pidA, await buildPlan('dynamic'))
      await seed({ providerKey: 'volcengine_video', model: 'volcengine-seed' })
      const pidB = await mkProject('m32-eq-derived')
      const pfB = await preflight(pidB, await buildPlan('dynamic'))
      check(!!pfA.execution && !!pfB.execution, '两条路径均产出执行快照')
      check(pfA.execution?.videoMode === pfB.execution?.videoMode && pfA.execution?.resolution === pfB.execution?.resolution, 'videoMode / resolution 一致')
      check(JSON.stringify(pfA.execution?.requestDurations) === JSON.stringify(pfB.execution?.requestDurations), 'requestDurations 逐镜一致')
      check(pfA.estimate.videoSeconds === pfB.estimate.videoSeconds, '预估视频秒数一致（存储 vs 背书零漂移）')
    },

    // ================= degrade：t2v-only 含首帧仍停机（红线不降） =================
    degrade: async () => {
      await seed({ providerKey: 'pollinations_video', model: 'minimax/minimax-h3-max-turbo' })
      const pid = await mkProject('m32-degrade')
      const pf = await preflight(pid, await buildPlan('dynamic', { firstFrame: true }))
      check(pf.issues.some((i) => i.code === 'first_frame_unsupported'), 'pollinations（t2v-only）方案含首帧 → first_frame_unsupported（绝不静默降级文生）')
    },

    // ================= normalize：逐值等价迁移前适配器实现 =================
    normalize: async () => {
      const { clampDuration, mapResolution, snapPollinationsDuration } = await import('../src/adapters/video-capabilities')
      check(clampDuration('minimax_video', 'MiniMax-H3', 3) === 4 && clampDuration('minimax_video', 'MiniMax-H3', 20) === 15 && clampDuration('minimax_video', 'MiniMax-H3', undefined) === 5, 'minimax 时长夹到 4–15、缺省 5（旧 normalizeDuration 等价）')
      check(clampDuration('volcengine_video', 'doubao-seedance-2', 8) === 8, 'volcengine 时长区间内透传')
      check(mapResolution('minimax_video', '1080p') === '2K' && mapResolution('minimax_video', '720p') === '768P' && mapResolution('minimax_video', undefined) === '768P', 'minimax 分辨率归一：1080p→2K，其余→768P')
      check(mapResolution('volcengine_video', '480p') === '480p' && mapResolution('volcengine_video', '1080p') === '720p', 'volcengine 分辨率归一：仅 480p 保留，其余→720p')
      check(snapPollinationsDuration('minimax/x', 7) === 5 && snapPollinationsDuration('minimax/x', 8) === 10 && snapPollinationsDuration('minimax/x', 13) === 15 && snapPollinationsDuration('google/veo', 6) === 6, 'pollinations 取档：minimax ≤7→5/8–12→10/≥13→15，其余四舍五入透传')
    },
  }

  await runSections({ log, title: 'M32', checker, sections: SECTIONS, runners, cleanup: envCleanup })
}

void main()
