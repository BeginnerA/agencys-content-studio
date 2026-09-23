/**
 * M46 探针（轻松创作第五批：角色 / 风格预设软提示注入）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m46.ts [--section=unit|inject|contract]
 *
 * 隔离策略：isolatedEnv('m46') 一次性临时目录（独立 studio.db + workspace），必须在任何 src import 前调用。
 * 模板目录只读拷贝进隔离区（planning 的 requiredEndpoint/preflight 需 easy-video），prompts 走 junction 桥接。
 * 零网络、零付费：fetch 全阻断，仅放行假 LLM 端点（/chat/completions）并捕获其 messages 供注入断言。
 *
 * 断言三类不变量：
 *  - unit：applyCreationPresets 读-合并写（仅写提供键 / 去重保序 / 截断 cap），resolveCreationPresetHint
 *    据项目绑定拼「画风基线 + 可复用角色」软提示（跳过已停用风格、如实标注缺项），未绑定 → null。
 *  - inject：sendCreationMessage 携带 stylePresetIds/characterPresetIds 时，规划模型收到的 messages 里
 *    出现软提示 system 分片（含所选风格名 + 角色名）；不携带时零变更（无该分片）。
 *  - contract：messageSchema 接受合法预设 id 数组、拒越界 / 未知键；messageFingerprint 不含预设
 *    （改预选不作废幂等）。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedEnv, makeChecker, REPO_ROOT, runSections, type Checker } from './probe-lib'

const { cleanup: envCleanup, tmp } = isolatedEnv('m46', { bridge: ['prompts'] })
cpSync(join(REPO_ROOT, 'workspace', 'templates'), join(tmp, 'workspace', 'templates'), { recursive: true })
process.env.PROBE_M46_KEY = 'probe-offline-secret-key-46a1'

const SECTIONS = ['unit', 'inject', 'contract'] as const

/** 3 镜 × 10 秒 = 30 秒（与 M45 同夹具） */
function makePlan(mode: 'dynamic' | 'slideshow') {
  return {
    title: '咖啡冲煮三分钟', summary: '用三段讲清风味来源', genre: 'science' as const, duration: 30,
    aspectRatio: '9:16' as const, language: 'zh-CN' as const, mode, style: '轻松科普',
    script: '豆子决定风味。\n水温影响萃取。\n研磨匹配时间。',
    lines: [
      { id: 'l1', text: '豆子决定风味' },
      { id: 'l2', text: '水温影响萃取' },
      { id: 'l3', text: '研磨匹配时间' },
    ],
    shots: [
      { id: 's1', duration: 10, image_prompt: '咖啡豆特写', motion_prompt: '缓慢推近', lines: ['l1'] },
      { id: 's2', duration: 10, image_prompt: '手冲注水', motion_prompt: '水流环绕', lines: ['l2'] },
      { id: 's3', duration: 10, image_prompt: '研磨刻度', motion_prompt: '镜头下移', lines: ['l3'] },
    ],
  }
}

const VIDEO = { providerKey: 'aliyun_bailian_video', model: 'Wan3.0-I2V' }

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m46')
  const checker: Checker = makeChecker(log)
  const check = checker.check
  const originalFetch = globalThis.fetch

  // ---- LLM 响应 stub：捕获 messages，仅放行 /chat/completions ----
  interface StubCall { url: string; body: Record<string, unknown> }
  const stubCalls: StubCall[] = []
  let llmContent = '{}'
  const stubFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input)
    let body: Record<string, unknown> = {}
    if (typeof init?.body === 'string') { try { body = JSON.parse(init.body) as Record<string, unknown> } catch { /* 非 JSON */ } }
    if (!url.startsWith('http://localhost:0/offline') || !url.includes('/chat/completions')) throw new Error('探针禁止外部网络 / 媒体生成')
    stubCalls.push({ url, body })
    return new Response(JSON.stringify({ choices: [{ message: { content: llmContent }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  globalThis.fetch = stubFetch

  // engine stub：规划末尾不真正起 run
  const { engine } = await import('../src/pipeline/engine')
  engine.startRun = ((runId: number) => { void runId; return 'started' }) as typeof engine.startRun
  engine.isRunning = (() => false) as typeof engine.isRunning

  const { initDb, db } = await import('../src/db')
  await initDb()
  const { apiConfigs, characters, projects, stylePresets } = await import('../src/db/schema')
  const { eq } = await import('drizzle-orm')

  const mkProject = async (settingsJson = '{}'): Promise<number> => {
    const t = Date.now()
    return (await db.insert(projects).values({ name: `m46-${t}`, brief: 'b', genre: 'other', templateKey: 'easy-video', status: 'draft', settings: settingsJson, tags: '[]', createdAt: t, updatedAt: t }).returning())[0]!.id
  }
  const seedEndpoints = async (): Promise<void> => {
    for (const kind of ['llm', 'audio', 'image', 'video'] as const) await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, kind))
    const t = Date.now()
    const insert = (v: Record<string, unknown>): Promise<unknown> => db.insert(apiConfigs).values({ name: String(v.name), providerKey: v.providerKey, serviceType: v.serviceType, apiKeyRef: 'env:PROBE_M46_KEY', baseUrl: 'http://localhost:0/offline', model: v.model, extra: JSON.stringify(v.extra ?? {}), pricing: String(v.pricing ?? '{}'), isActive: 1, isDefault: 1, priority: 0, createdAt: t, updatedAt: t } as never)
    await insert({ name: 'llm', providerKey: 'deepseek_llm', serviceType: 'llm', model: 'probe-llm', pricing: '{"tokens_in":2,"tokens_out":8}' })
    await insert({ name: 'audio', providerKey: 'openai_audio', serviceType: 'audio', model: 'probe-tts', extra: { voice: 'alloy' }, pricing: '{"char":0.1}' })
    await insert({ name: 'image', providerKey: 'openai_image', serviceType: 'image', model: 'probe-img', pricing: '{"image":0.1}' })
    await insert({ name: 'video', serviceType: 'video', pricing: '{"second":0.1}', ...VIDEO })
  }
  const seedStyle = async (name: string, snippet: string, isActive = 1): Promise<number> => {
    const t = Date.now()
    return (await db.insert(stylePresets).values({ name, snippet, description: null, sortOrder: 0, isActive, createdAt: t, updatedAt: t }).returning())[0]!.id
  }
  const seedChar = async (name: string, appearance: string, voice: string, projectId: number | null): Promise<number> => {
    const t = Date.now()
    return (await db.insert(characters).values({ projectId, kind: 'character', name, aliases: '[]', summary: null, appearance, negative: null, voice, states: '[]', refAssetIds: '[]', meta: '{}', createdAt: t, updatedAt: t }).returning())[0]!.id
  }
  const settingsOf = async (id: number): Promise<Record<string, unknown>> => {
    const row = (await db.select().from(projects).where(eq(projects.id, id)))[0]!
    try { return JSON.parse(row.settings) as Record<string, unknown> } catch { return {} }
  }

  const runners: Record<string, () => Promise<void>> = {
    // ============ unit：applyCreationPresets 读-合并写 / resolveCreationPresetHint 软提示构建 ============
    unit: async () => {
      const { applyCreationPresets, resolveCreationPresetHint, MAX_STYLE_PRESET_BIND, MAX_CHARACTER_PRESET_BIND } = await import('../src/services/creation-chat/presets')
      const sCyber = await seedStyle('赛博朋克', 'neon cyberpunk, high contrast')
      const sInk = await seedStyle('水墨', 'ink wash painting, monochrome')
      const sOff = await seedStyle('停用风格', 'SHOULD_NOT_APPEAR', 0)
      const cGlobal = await seedChar('阿镖', '少年镖客·短打·背负木匣', '清亮少年音', null)

      const p = await mkProject()
      await applyCreationPresets(p, [sCyber, sInk, sOff], [cGlobal])
      const st = await settingsOf(p)
      check(JSON.stringify(st['style_preset_ids']) === JSON.stringify([sCyber, sInk, sOff]), 'applyCreationPresets 原样去重保序落 style_preset_ids（含 id 顺序，停用与否交由 resolve 判定）')
      check(JSON.stringify(st['character_preset_ids']) === JSON.stringify([cGlobal]), 'applyCreationPresets 落 character_preset_ids')

      const hint = await resolveCreationPresetHint(p)
      check(!!hint && hint.includes('【预设基线（软提示）】') && hint.includes('画风基线'), '绑定了风格 → 软提示含基线前缀与画风段')
      check(!!hint && hint.includes('赛博朋克') && hint.includes('水墨') && !hint.includes('SHOULD_NOT_APPEAR') && !hint.includes('停用风格'), '软提示跳过停用风格（复用 resolveProjectStyleSnippets 真值）')
      check(!!hint && hint.includes('可复用角色') && hint.includes('阿镖') && hint.includes('少年镖客') && hint.includes('清亮少年音'), '软提示含可复用角色 + 外貌 / 声线核心特征')

      // 截断：风格 > cap、角色 > cap
      const manyIds = Array.from({ length: MAX_STYLE_PRESET_BIND + 5 }, (_, i) => 9000 + i)
      const pTrunc = await mkProject()
      await applyCreationPresets(pTrunc, manyIds, manyIds)
      const stT = await settingsOf(pTrunc)
      check((stT['style_preset_ids'] as number[]).length === MAX_STYLE_PRESET_BIND, `风格绑定截断到 cap=${MAX_STYLE_PRESET_BIND}`)
      check((stT['character_preset_ids'] as number[]).length === MAX_CHARACTER_PRESET_BIND, `角色绑定截断到 cap=${MAX_CHARACTER_PRESET_BIND}`)

      // 去重
      const pDedup = await mkProject()
      await applyCreationPresets(pDedup, [sCyber, sCyber, sInk], undefined)
      check(JSON.stringify((await settingsOf(pDedup))['style_preset_ids']) === JSON.stringify([sCyber, sInk]), '重复 id 去重保序')

      // 仅写提供键：只提供角色 → 风格键保持原值不动
      const pPartial = await mkProject(JSON.stringify({ style_preset_ids: [sInk], theme: 'keepme' }))
      await applyCreationPresets(pPartial, undefined, [cGlobal])
      const stP = await settingsOf(pPartial)
      check(JSON.stringify(stP['style_preset_ids']) === JSON.stringify([sInk]) && stP['theme'] === 'keepme', '未提供风格入参 → 既有 style_preset_ids 与其它 settings 键原样保留（读-合并写非覆盖）')
      check(JSON.stringify(stP['character_preset_ids']) === JSON.stringify([cGlobal]), '提供角色入参 → 落 character_preset_ids')

      // 未绑定 → null（零变更）
      const pEmpty = await mkProject()
      check((await resolveCreationPresetHint(pEmpty)) === null, '未绑定任何预设 → resolveCreationPresetHint 返回 null')
      await applyCreationPresets(pEmpty, undefined, undefined)
      check(JSON.stringify(await settingsOf(pEmpty)) === '{}', 'applyCreationPresets 两入参均缺省 → 空转，settings 逐字节不变')

      // 绑定项指向不存在 id → 风格 / 角色皆缺位 → null（不编造）
      const pGhost = await mkProject(JSON.stringify({ style_preset_ids: [777777], character_preset_ids: [888888] }))
      check((await resolveCreationPresetHint(pGhost)) === null, '绑定 id 全部失效 → 软提示 null（跳过缺失，绝不编造）')
    },

    // ============ inject：sendCreationMessage 携带预设 → 规划模型 messages 出现软提示；不携带 → 零变更 ============
    inject: async () => {
      const { createSession } = await import('../src/services/creation-chat/planning')
      const { parsePlanningReply } = await import('../src/services/creation-chat/contract')
      await seedEndpoints()
      const sCyber = await seedStyle(' Inject赛博', 'neon inject')
      const cHero = await seedChar('注入侠', '披风·银甲', '低沉男声', null)
      llmContent = JSON.stringify({ kind: 'plan', message: '方案已生成', plan: makePlan('dynamic') })
      check(parsePlanningReply(llmContent).kind === 'plan', '规划 stub 回复符合 plan 契约（放行完整一轮）')

      // 携带预设：新建会话即触发规划
      const bound = stubCalls.length
      await createSession({ content: '做一条赛博风短视频。', requestKey: `m46inj1${Date.now()}`, stylePresetIds: [sCyber], characterPresetIds: [cHero] })
      const call = stubCalls[bound]
      const sysOf = (c: StubCall | undefined): string => Array.isArray(c?.body.messages)
        ? (c!.body.messages as Array<{ role: string; content: unknown }>).filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')
        : ''
      const boundSys = sysOf(call)
      check(!!call, '携带预设 → 触发一次规划 LLM 调用')
      check(boundSys.includes('【预设基线（软提示）】') && boundSys.includes('Inject赛博') && boundSys.includes('注入侠'), '绑定预设 → messages 注入软提示 system 分片（含风格名 + 角色名）')

      // 不携带预设（全新会话）：无软提示分片
      const unbound = stubCalls.length
      await createSession({ content: '做一条普通短视频。', requestKey: `m46inj2${Date.now()}` })
      const unboundSys = sysOf(stubCalls[unbound])
      check(!!stubCalls[unbound] && !unboundSys.includes('【预设基线（软提示）】'), '不携带预设 → 规划 messages 无软提示分片（零变更）')
    },

    // ============ contract：messageSchema 约束 / 指纹不含预设 ============
    contract: async () => {
      const { messageSchema, messageFingerprint } = await import('../src/services/creation-chat/contract')
      const ok = messageSchema.safeParse({ content: 'x', requestKey: 'abcdefgh', stylePresetIds: [1, 2], characterPresetIds: [3] })
      check(ok.success, 'messageSchema 接受合法预设 id 数组')
      check(!messageSchema.safeParse({ content: 'x', requestKey: 'abcdefgh', stylePresetIds: Array.from({ length: 7 }, (_, i) => i + 1) }).success, '风格 id 超 max=6 → 拒')
      check(!messageSchema.safeParse({ content: 'x', requestKey: 'abcdefgh', characterPresetIds: Array.from({ length: 5 }, (_, i) => i + 1) }).success, '角色 id 超 max=4 → 拒')
      check(!messageSchema.safeParse({ content: 'x', requestKey: 'abcdefgh', hacker: 1 }).success, '.strict() 拒未知键')
      check(!messageSchema.safeParse({ content: 'x', requestKey: 'abcdefgh', stylePresetIds: [0] }).success, '非正整数 id → 拒')
      const base = { content: '同一句话', requestKey: 'abcdefgh', attachments: [1, 2] }
      const withPreset = { ...base, stylePresetIds: [9], characterPresetIds: [8] }
      check(messageFingerprint(base as never) === messageFingerprint(withPreset as never), 'messageFingerprint 忽略预设 → 改预选不作废幂等')
    },
  }

  await runSections({ log, title: 'M46', checker, sections: SECTIONS, runners, cleanup: () => { globalThis.fetch = originalFetch; envCleanup() } })
}
void main()
