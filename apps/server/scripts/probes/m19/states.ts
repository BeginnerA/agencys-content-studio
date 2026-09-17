/** M19[states]：characters.states 列 JSON 往返 + parseStateEntry 分隔符矩阵 + matchStateEntry 场/集/文本三级匹配（中文数字）+ injectStateAnchors 注入格式/多条取最后/零 diff + ai-image 集成真步执行（fetch stub 零外发：prompt 快照/注入顺序/日志）（断言体逐字搬自原 probe-m19.ts） */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { M19Ctx } from './ctx'

export async function run(ctx: M19Ctx): Promise<void> {
  const { check, db, T0, mkProject, eq, characters, genTasks, pipelineRuns, projects } = ctx
  {
    const ai = await import('../../../src/pipeline/actions/ai-image')
    const { injectStateAnchors, matchStateEntry, parseStateEntry } = ai
    const { loadEntityIndex, upsertEntity } = await import('../../../src/services/character')
    const { apiConfigs, pipelineSteps, stylePresets } = await import('../../../src/db/schema')
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

    // ---- [P1] characters.states 列 JSON 往返 ----
    const spS = (await db.insert(stylePresets).values({ name: '探针状态画风', snippet: 'ink wash', createdAt: T0, updatedAt: T0 }).returning())[0]!.id
    const pidS = await mkProject('M19 状态注入', JSON.stringify({ style_preset_ids: [spS] }))
    const c = (
      await db
        .insert(characters)
        .values({
          projectId: pidS,
          kind: 'character',
          name: '状态测试角色',
          aliases: '[]',
          states: JSON.stringify(['第5场受伤：额头绷带']),
          refAssetIds: '[]',
          createdAt: T0,
          updatedAt: T0,
        })
        .returning()
    )[0]!
    const parsed = JSON.parse(c.states) as string[]
    check(parsed.length === 1 && parsed[0] === '第5场受伤：额头绷带', 'characters.states JSON 往返（{剧情节点}：{状态短语} 格式）')

    // ---- [P7] parseStateEntry：分隔符矩阵 ----
    const pe1 = parseStateEntry('第5场受伤：额头绷带')
    check(pe1.node === '第5场受伤' && pe1.phrase === '额头绷带', 'parseStateEntry 全角冒号分割 node/phrase')
    const pe2 = parseStateEntry('第3集落水: 湿透校服')
    check(pe2.node === '第3集落水' && pe2.phrase === '湿透校服', 'parseStateEntry 半角冒号同权 + 两侧空白剔除')
    const pe3 = parseStateEntry('换装：红袄：白裙')
    check(pe3.node === '换装' && pe3.phrase === '红袄：白裙', 'parseStateEntry 首个冒号分割（余下冒号归短语）')
    const pe4 = parseStateEntry('雨夜街头')
    check(pe4.node === '雨夜街头' && pe4.phrase === '', 'parseStateEntry 无分隔 → node=全串、phrase 空')
    const pe5 = parseStateEntry(undefined)
    check(pe5.node === '' && pe5.phrase === '', 'parseStateEntry 非字符串 → 空条目（不抛）')

    // ---- [P7] matchStateEntry：场 / 集 / 文本三级匹配矩阵 ----
    const m1 = matchStateEntry('第5场受伤：额头绷带', { scene: 5, episode: 1, text: 's05 巷口' })
    check(m1.hit && m1.mode === 'scene', '场次定位词与 shot.scene 数值相等命中')
    const m2 = matchStateEntry('第5场受伤：额头绷带', { scene: 4, episode: 5, text: '第5场受伤 s05 巷口' })
    check(!m2.hit && m2.mode === 'scene', '场次不等 → 不命中，且不回落集数/文本（场档独占）')
    const m3 = matchStateEntry('第5场受伤：额头绷带', { text: '第5场受伤 s05' })
    check(!m3.hit && m3.mode === 'scene', 'shot 无 scene（存量分镜）→ 场档降级不命中，不做文本兜底')
    const m4 = matchStateEntry('第五场受伤：绷带', { scene: 5 })
    check(m4.hit && m4.mode === 'scene', '中文数字「第五场」→ 5（阿拉伯/中文同权）')
    check(matchStateEntry('第十二场：雪夜', { scene: 12 }).hit, '中文数字「十二」→ 12（十位起）')
    check(matchStateEntry('第二十场：雪夜', { scene: 20 }).hit, '中文数字「二十」→ 20（spec 一至二十）')
    check(!matchStateEntry('第二十一场：雪夜', { scene: 20 }).hit, '中文数字不可解析 → 不命中（不误判）')
    check(matchStateEntry('第5场次受伤：绷带', { scene: 5 }).hit, '「第N场次」写法同档命中')
    const m5 = matchStateEntry('第3集落水：湿透校服', { scene: 9, episode: 3 })
    check(m5.hit && m5.mode === 'episode', '无场次词 → 集数档与 run episode_number 对齐')
    const m6 = matchStateEntry('第3集落水：湿透校服', { scene: 9 })
    check(!m6.hit && m6.mode === 'episode', 'episode 缺失 → 集数档不命中（降级）')
    const m7 = matchStateEntry('第5场第3集：雪', { scene: 5, episode: 3 })
    check(m7.mode === 'scene' && m7.hit, '场/集同现 → 场次档优先（判定顺序即优先级）')
    const m8 = matchStateEntry('淋雨：全身湿透', { scene: 1, episode: 2, text: 's07 巷口 淋雨奔跑的小女孩' })
    check(m8.hit && m8.mode === 'text', '无定位词 → 节点串包含于 shot 文本（id+location+image_prompt）')
    check(!matchStateEntry('淋雨：全身湿透', { text: 's07 教室' }).hit, '无定位词且文本不含节点 → 不命中')
    check(!matchStateEntry('：只有短语', { text: '任意文本' }).hit, '空节点（仅短语）→ 不命中（避免空串恒包含）')

    // ---- [P7] injectStateAnchors：注入格式 / 多条取最后 / 零 diff ----
    await db.delete(characters).where(eq(characters.id, c.id)) // 避免旧样板行干扰索引断言
    await upsertEntity({ projectId: pidS, kind: 'character', name: '状态角色', appearance: '圆脸大眼，虎头帽红袄', states: ['第5场受伤：额头绷带', '第5场复发：绷带与拐杖'] })
    await upsertEntity({ projectId: pidS, kind: 'character', name: '集数角色', appearance: '少年，蓝校服', states: ['第3集落水：湿透校服'] })
    await upsertEntity({ projectId: pidS, kind: 'character', name: '无状态角色', appearance: '老者，灰长衫' })
    await upsertEntity({ projectId: pidS, kind: 'scene', name: '巷口', appearance: '青石窄巷，暖灯' })
    const idxS = await loadEntityIndex(pidS, 'character')
    const shotsIn = [
      { id: 's05', scene: 5, location: '巷口', characters: ['状态角色'], image_prompt: 'P5' },
      { id: 's06', scene: 6, location: '教室', characters: ['状态角色'], image_prompt: 'P6' },
      { id: 's03', scene: 3, location: '河边', characters: ['集数角色'], image_prompt: 'P3' },
      { id: 's07', scene: 7, characters: ['无状态角色'], image_prompt: 'P7' },
      { id: 's08', scene: 8, image_prompt: 'P8' },
      { id: 's09', scene: 9, characters: ['查无此人'], image_prompt: 'P9' },
    ]
    const inj = injectStateAnchors(shotsIn, idxS, 3)
    check(inj.shots[0]!.image_prompt === 'P5\n状态锚定（状态角色·第5场复发）：绷带与拐杖', `多条命中取 states 数组最后一条（实际 ${JSON.stringify(inj.shots[0]!.image_prompt)}）`)
    check(inj.shots[1]!.image_prompt === 'P6', 'scene=6 无命中条目 → 原文不变')
    check(inj.shots[2]!.image_prompt === 'P3\n状态锚定（集数角色·第3集落水）：湿透校服', '集数档经 episode 入参命中')
    check(inj.shots[3]!.image_prompt === 'P7' && inj.shots[4]!.image_prompt === 'P8', '无 states / 无 characters 镜原文不变')
    check(inj.shots[5]!.image_prompt === 'P9', '角色未命中索引 → 静默不注入（未命中报告归角色锚定段）')
    check(inj.injected === 2, `injected=${inj.injected}（仅实注 2 镜）`)
    check(
      inj.details.length === 2 && inj.details[0]!.includes('s05') && inj.details[0]!.includes('绷带与拐杖'),
      `details 逐条明细供日志（${inj.details.join(' | ')}）`,
    )
    check(shotsIn[0]!.image_prompt === 'P5', '入参数组不被修改（纯函数）')
    check(injectStateAnchors([{ ...shotsIn[2]! }], idxS).shots[0]!.image_prompt === 'P3', 'episode 未传（run.input 无 episode_number）→ 集数档不命中')
    const shotsNoState = [{ id: 'x1', scene: 5, characters: ['无状态角色'], image_prompt: 'X' }]
    const zero = injectStateAnchors(shotsNoState, idxS, 3)
    check(zero.shots === shotsNoState && zero.injected === 0 && zero.details.length === 0, '无 states → 零 diff（返回入参数组引用，不造新对象）')

    // ---- [P7] ai-image 集成：真实 step 执行（fetch stub 零外发）→ 任务 prompt 快照含状态锚定 + 注入顺序 + 日志 ----
    const { createStepContext } = await import('../../../src/pipeline/context')
    const { writeTextAsset } = await import('../../../src/services/storage')
    const { RUN_LOGS_DIR } = await import('../../../src/env')
    const origFetch = globalThis.fetch
    await db.insert(apiConfigs).values({
      providerKey: 'openai_image',
      serviceType: 'image',
      name: '探针状态图像',
      baseUrl: 'http://probe-state.local/v1',
      apiKeyRef: 'env:PROBE_M19_STATE_KEY',
      model: 'state-model',
      priority: 0,
      isDefault: 1,
      isActive: 1,
      createdAt: T0,
      updatedAt: T0,
    })
    process.env.PROBE_M19_STATE_KEY = 'probe-key-state'
    const PNG1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const stateReqs: Array<{ url: string }> = []
    globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.includes('/images/generations')) {
        stateReqs.push({ url })
        return new Response(JSON.stringify({ data: [{ b64_json: PNG1X1 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const runRow = (
        await db
          .insert(pipelineRuns)
          .values({
            projectId: pidS,
            templateKey: 'mengbao-episode',
            status: 'running',
            input: JSON.stringify({ episode_number: 3 }),
            createdAt: T0,
            updatedAt: T0,
          })
          .returning()
      )[0]!
      const stepRow = (
        await db
          .insert(pipelineSteps)
          .values({ runId: runRow.id, seq: 1, stepKey: 'gen_images', actionKey: 'ai_image', title: 'gen_images', status: 'running', createdAt: T0, updatedAt: T0 })
          .returning()
      )[0]!
      const defS = { key: 'gen_images', action: 'ai_image', title: 'gen_images', inputs: {}, params: {}, batch: { field: 'shots', maxConcurrent: 2, retry: 0 } }
      const sbAsset = await writeTextAsset(pidS, {
        name: 'storyboard-state.json',
        content: JSON.stringify({ shots: shotsIn }),
        purpose: 'storyboard',
        format: 'json',
        stepId: stepRow.id,
        runId: runRow.id,
      })
      const ctxS = await createStepContext({
        run: runRow,
        step: stepRow,
        template: { key: 'probe-m19-states', version: 1, name: '探针', genre: 'other', inputs: [], steps: [defS] },
        def: defS,
        input: { shots: [sbAsset.id] },
        projectSettings: JSON.parse(((await db.select().from(projects).where(eq(projects.id, pidS)))[0]!).settings) as Record<string, unknown>,
      })
      const res = await ai.aiImage(ctxS)
      check(res.assetIds.length === shotsIn.length, `ai_image 全链执行完成（${res.assetIds.length}/${shotsIn.length} 镜，stub 端点零外发）`)
      check(stateReqs.length === shotsIn.length && stateReqs.every((r) => r.url === 'http://probe-state.local/v1/images/generations'), '出图请求全部落 stub 端点')
      const tRows = await db.select().from(genTasks).where(eq(genTasks.runId, runRow.id))
      const promptOf = (shotId: string): string =>
        tRows.find((r) => (JSON.parse(r.params ?? '{}') as { shotId?: string }).shotId === shotId)?.prompt ?? ''
      const p5 = promptOf('s05')
      check(p5.includes('状态锚定（状态角色·第5场复发）：绷带与拐杖'), '任务 prompt 快照含状态锚定段（快照即一致性硬证据）')
      check(
        p5.includes('角色锚定（状态角色）') && p5.indexOf('角色锚定') < p5.indexOf('状态锚定') && p5.indexOf('状态锚定') < p5.indexOf('场景锚定（巷口）') && p5.indexOf('场景锚定') < p5.indexOf('视觉风格'),
        '注入链顺序 = 角色 → 状态 → 场景/道具 → 风格（逐段叠加位置可核）',
      )
      check(promptOf('s03').includes('状态锚定（集数角色·第3集落水）'), 'episode 取 run.input.episode_number（集数档真链命中）')
      check(
        ['s06', 's07', 's08', 's09'].every((id) => !promptOf(id).includes('状态锚定')),
        '无 states / 无命中镜任务 prompt 不含状态段（ai-image 零 diff 到任务快照）',
      )
      check(promptOf('s07').includes('角色锚定（无状态角色）'), '无 states 角色仍照常角色锚定（旧行为不变）')
      const logTxt = existsSync(join(RUN_LOGS_DIR, `${runRow.id}.log`)) ? readFileSync(join(RUN_LOGS_DIR, `${runRow.id}.log`), 'utf8') : ''
      check(logTxt.includes('状态锚定注入 2 镜') && logTxt.includes('s05 状态角色「第5场复发」'), 'run 日志留痕：注入镜数 + 逐条明细（spec §5 验收口径）')
      await sleep(600) // 排空 scheduleImageCheck fire-and-forget（避免打到已关闭的探针库）
    } finally {
      globalThis.fetch = origFetch
      await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, 'image'))
      delete process.env.PROBE_M19_STATE_KEY
    }
    check((await db.select().from(apiConfigs)).length === 0, '集成段收尾清理 image 端点与环境变量（不污染后续节）')
  }
}
