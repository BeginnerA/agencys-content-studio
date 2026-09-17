/** M19[ref-gen]：gen_tasks 无 run 任务模型 + entity-refgen 纯函数（purpose/提示词/params 往返/裁剪/上限）+ 发起校验族零副作用 + 去重变体积量 + 列表认领域/置顶/截断 + 取消 + 启动恢复 + 执行器成功径（fetch stub 零外发：能力位/落盘/挂接/用量/事件/重试/取消弃存）（断言体逐字搬自原 probe-m19.ts） */
import { existsSync } from 'node:fs'
import type { M19Ctx } from './ctx'

export async function run(ctx: M19Ctx): Promise<void> {
  const { check, db, T0, pid, errOf, mkProject, eq, genTasks, characters } = ctx
  {
    // gen_tasks 无 run 任务模型（runId/stepId/canvasNodeId 均 null）
    const t = (
      await db
        .insert(genTasks)
        .values({
          projectId: pid,
          runId: null,
          stepId: null,
          canvasNodeId: null,
          kind: 'image',
          params: JSON.stringify({ entity_id: 1, source: 'entity_ref_gen' }),
          status: 'pending',
          createdAt: T0,
          updatedAt: T0,
        })
        .returning()
    )[0]!
    check(t.runId === null && t.stepId === null && t.canvasNodeId === null, 'gen_tasks 无 run 任务模型（三归属列均 null 可插入）')

    // ==================== [P6 增补] 批量生成参考图 ====================
    const refgen = await import('../../../src/services/entity-refgen')
    const {
      buildRefGenParams,
      cancelEntityRefTask,
      composeEntityRefPrompt,
      listEntityRefTasks,
      parseRefGenParams,
      pickRefAssetIds,
      recoverEntityRefTasks,
      refGenPurpose,
      startEntityRefGen,
    } = refgen
    const { inArray } = await import('drizzle-orm')
    const { onStudioEvent } = await import('../../../src/services/events')
    const { WorkbenchError } = await import('../../../src/services/shot')
    const { combineStyleSnippets, resolveProjectStyleSnippets } = await import('../../../src/services/style-preset')
    const { stylePresets } = await import('../../../src/db/schema')

    // ---- 纯函数：purpose / 提示词组装 / params 往返 / 参考图裁剪 ----
    check(
      refgen.MAX_REFGEN_ITEMS === 10 && refgen.MAX_REFGEN_VARIANTS === 4 && refgen.REFGEN_MAX_REFS === 4 && refgen.REFGEN_MAX_CONCURRENCY === 2,
      '上限常量对齐 spec（≤10 实体 × 1-4 变体 / 参考图 ≤4 / 并发 ≤2）',
    )
    check(
      refGenPurpose('character') === 'reference_character' && refGenPurpose('scene') === 'reference_scene' && refGenPurpose('prop') === 'reference_prop',
      'refGenPurpose 三 kind → reference_{kind}（出图归属目的分流）',
    )
    check(refGenPurpose('bogus') === 'reference_character' && refGenPurpose('') === 'reference_character', '未知/空 kind 回退 reference_character（不造孤儿 purpose）')
    check(
      composeEntityRefPrompt({ appearance: '少年，白衣，剑眉', negative: '现代服饰' }, ['水墨国风', '低饱和']) ===
        '少年，白衣，剑眉\n视觉风格：水墨国风；低饱和\n必须剔除：现代服饰',
      'composeEntityRefPrompt 三段拼接（段间 \\n；多风格词「；」叠加；对齐 ai-image 锚定注入格式）',
    )
    check(composeEntityRefPrompt({ appearance: '  ', negative: '红字' }, ['  ', '']) === '必须剔除：红字', '缺段跳过（空白 appearance/风格不进提示词）')
    check(composeEntityRefPrompt({}, []) === '', 'appearance/negative/风格全缺 → 空串（不注占位文本）')
    const prm = buildRefGenParams({ entityId: 7, variantIndex: 2, size: '1024x1024', refsPlanned: 3 })
    const back = parseRefGenParams(JSON.stringify(prm))
    check(back !== null && back.entity_id === 7 && back.variant_index === 2 && back.size === '1024x1024', 'params 构造/解析往返（域内字段可读回）')
    check(prm['source'] === refgen.REFGEN_SOURCE, 'params.source 域标识写入（列表/恢复认领依据）')
    check(parseRefGenParams(JSON.stringify({ entity_id: 1, source: 'canvas' })) === null, '非本域 params → null（不认领画布/run 任务）')
    check(
      parseRefGenParams('{坏 JSON') === null && parseRefGenParams(JSON.stringify({ source: 'entity_ref_gen', entity_id: 0 })) === null,
      '坏 JSON / entity_id 非正整数 → null（恢复遇脏行不炸）',
    )
    check(parseRefGenParams(JSON.stringify({ source: 'entity_ref_gen', entity_id: 3, variant_index: -1 }))?.variant_index === 0, 'variant_index 负值 → 归零（展示宽容）')
    check(parseRefGenParams(JSON.stringify({ source: 'entity_ref_gen', entity_id: 3 }))?.size === null, '缺 size → null（执行期回落项目/默认尺寸）')
    check(JSON.stringify(pickRefAssetIds([5, 5, 3, 9, 2, 8, 0, -1, 1.5])) === '[5,3,9,2]', 'pickRefAssetIds 去重 + 截 4 + 剔非正整数')

    // ---- 实体样本（项目域 / 全局域 / 缺外观 / 多参考图） ----
    const mkChar = async (
      name: string,
      opts: { projectId?: number | null; kind?: string; appearance?: string | null; negative?: string | null; refAssetIds?: number[] } = {},
    ): Promise<number> =>
      (
        await db
          .insert(characters)
          .values({
            projectId: opts.projectId === undefined ? pid : opts.projectId,
            kind: opts.kind ?? 'character',
            name,
            aliases: '[]',
            appearance: opts.appearance ?? '剑眉星目，白衣长剑',
            negative: opts.negative ?? null,
            states: '[]',
            refAssetIds: JSON.stringify(opts.refAssetIds ?? []),
            createdAt: T0,
            updatedAt: T0,
          })
          .returning()
      )[0]!.id
    const cA = await mkChar('批量角色A')
    const cB = await mkChar('批量场景B', { kind: 'scene', appearance: '山门石阶，晨雾', negative: '现代建筑', refAssetIds: [11, 12, 13, 14, 15] })
    const cNoApp = await mkChar('缺外观角色', { appearance: '   ' })
    const cGlobal = await mkChar('全局角色', { projectId: null })

    const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
      const e = await errOf(fn)
      return e instanceof WorkbenchError ? `${e.code}:${e.status}` : e === null ? '__ok__' : `__other__:${String(e)}`
    }
    const taskCountBefore = (await db.select().from(genTasks)).length

    // ---- 发起校验族（整单拒绝，零副作用） ----
    check((await codeOf(() => startEntityRefGen(0, [cA]))) === 'bad_project_id:400', 'project_id 非正整数 → bad_project_id')
    check((await codeOf(() => startEntityRefGen(999999, [cA]))) === 'not_found:404', '项目不存在 → not_found(404)')
    check((await codeOf(() => startEntityRefGen(pid, 'x'))) === 'bad_entity_ids:400', 'entity_ids 非数组 → bad_entity_ids')
    check((await codeOf(() => startEntityRefGen(pid, []))) === 'bad_entity_ids:400', 'entity_ids 空数组 → bad_entity_ids')
    check(
      (await codeOf(() => startEntityRefGen(pid, Array.from({ length: 11 }, (_, i) => i + 1)))) === 'too_many_entities:400',
      '>10 实体 → too_many_entities（对齐 M13 批量润色上限）',
    )
    check((await codeOf(() => startEntityRefGen(pid, [cA], 5))) === 'bad_variants:400', 'variants=5 → bad_variants')
    check((await codeOf(() => startEntityRefGen(pid, [cA], 0))) === 'bad_variants:400', 'variants=0 → bad_variants')
    check((await codeOf(() => startEntityRefGen(pid, [999999]))) === 'bad_entity_ids:400', '素材不存在 → bad_entity_ids')
    const scopeErr = await errOf(() => startEntityRefGen(pid, [cGlobal]))
    check(scopeErr instanceof WorkbenchError && scopeErr.code === 'bad_entity_scope', '全局库素材（跨域）→ bad_entity_scope')
    check(scopeErr instanceof WorkbenchError && scopeErr.message.includes('全局角色'), 'bad_entity_scope 文案点名素材（前端直接展示）')
    const appErr = await errOf(() => startEntityRefGen(pid, [cNoApp]))
    check(appErr instanceof WorkbenchError && appErr.code === 'no_appearance' && appErr.message.includes('缺外观角色'), '缺 appearance → no_appearance（提示先补全/润色）')
    check((await db.select().from(genTasks)).length === taskCountBefore, '校验失败零副作用（未建任何任务行）')

    // ---- 发起成功：去重 × 变体积量 + 任务行形形态 ----
    const evBuf: Array<{ projectId: number; taskId: number; entityId: number; status: string; error?: string }> = []
    const off = onStudioEvent((e) => {
      if (e.type === 'entity.ref_gen') evBuf.push({ projectId: e.projectId, taskId: e.taskId, entityId: e.entityId, status: e.status, error: e.error })
    })
    const issued = await startEntityRefGen(pid, [cB, cA, cA], 2)
    const idList = issued.tasks.map((x) => x.id)
    check(issued.count === 4 && idList.length === 4, '重复 ids 去重 → 2 实体 × 2 变体 = 4 任务')
    const rowsIssued = await db.select().from(genTasks).where(inArray(genTasks.id, idList))
    check(rowsIssued.every((r) => r.runId === null && r.stepId === null && r.canvasNodeId === null), '批量任务三归属列均 null（无 run 队列，不占引擎槽位）')
    check(rowsIssued.every((r) => r.kind === 'image' && r.projectId === pid), '任务 kind=image + 项目归属正确')
    check(new Set(rowsIssued.map((r) => parseRefGenParams(r.params)!.entity_id)).size === 2, '两实体各得自身任务（params.entity_id 区分）')
    const byEntity = new Map(rowsIssued.map((r) => [parseRefGenParams(r.params)!.entity_id, r]))
    const promptB = byEntity.get(cB)?.prompt ?? ''
    check(promptB.includes('山门石阶，晨雾') && promptB.includes('必须剔除：现代建筑'), '入队提示词 = appearance + 负向（拼接直连，无 LLM 预润色）')
    check(!promptB.includes('视觉风格'), '风格词不在入队快照（执行期现取项配置 → 改风无需重发）')
    check((JSON.parse(byEntity.get(cB)!.params) as Record<string, unknown>)['refs_planned'] === 4, 'refs_planned = 候选去重截断后数量（5 → 4）')
    check(
      rowsIssued.every((r) => (JSON.parse(r.params) as Record<string, unknown>)['size'] === '832x1248'),
      '未配 settings.image.size → 默认 832x1248（竖版人像）',
    )

    // ---- 项目风格词块接入（与 ai-image 注入同源） ----
    const sp1 = (await db.insert(stylePresets).values({ name: '探针画风一', snippet: 'ink wash painting', createdAt: T0, updatedAt: T0 }).returning())[0]!.id
    const sp2 = (await db.insert(stylePresets).values({ name: '探针画风二', snippet: 'high contrast', createdAt: T0, updatedAt: T0 }).returning())[0]!.id
    const pidStyle = await mkProject('M19 风格批量', JSON.stringify({ style_preset_ids: [sp1, sp2] }))
    const snips = (await resolveProjectStyleSnippets(pidStyle)).map((s) => s.snippet)
    check(
      composeEntityRefPrompt({ appearance: '少女，红衣', negative: null }, snips) === '少女，红衣\n视觉风格：ink wash painting；high contrast',
      '项目多风格预设按绑定顺序叠加进提示词（resolveProjectStyleSnippets 同源）',
    )
    check(combineStyleSnippets(snips) === 'ink wash painting；high contrast', 'combineStyleSnippets 多词块「；」连接（无空块污染）')

    // ---- 执行器收敛（未配置 image 端点 → 自然失败，零网络） ----
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    const settleTasks = async (ids: number[]): Promise<Map<number, string>> => {
      const deadline = Date.now() + 60_000
      for (;;) {
        const rs = await db.select({ id: genTasks.id, status: genTasks.status }).from(genTasks).where(inArray(genTasks.id, ids))
        const m = new Map(rs.map((r) => [r.id, r.status]))
        if (rs.every((r) => ['succeeded', 'failed', 'cancelled'].includes(r.status)) || Date.now() > deadline) return m
        await sleep(250)
      }
    }
    const settled = await settleTasks(idList)
    check([...settled.values()].every((s) => s === 'failed'), `未配置 image 端点 → 4 任务均收敛 failed（实际 ${[...settled.values()].join('/')}）`)
    const afterRows = await db.select().from(genTasks).where(inArray(genTasks.id, idList))
    check(afterRows.every((r) => (r.errorMsg ?? '').includes('未配置') && r.attempts >= 2), '失败附端点配置引导文案 + attempts≥2（自动重试 1 次耗尽）')
    check(afterRows.every((r) => r.resultAssetId === null), '失败不落资产（result_asset_id 恒 null）')
    check(((await db.select().from(characters).where(eq(characters.id, cA)))[0])!.refAssetIds === '[]', '失败不挂接参考图（实体 ref_asset_ids 不变）')
    check(
      new Set(evBuf.filter((e) => e.status === 'processing').map((e) => e.taskId)).size === 4,
      '每任务至少一条 processing 事件（页内进度驱动；重试可重发）',
    )
    check(
      evBuf.filter((e) => e.status === 'failed').length === 4 && evBuf.filter((e) => e.status === 'failed').every((e) => (e.error ?? '').length > 0),
      '每任务发 failed 事件并带 error 文本（行内可展开原因）',
    )
    check(evBuf.every((e) => e.projectId === pid && e.entityId > 0), '事件带 projectId/entityId（project room 投递依据，无需 run）')

    // ---- 任务列表（认领域 + 排除 + 置顶 + 截断） ----
    const mkRow = async (
      status: string,
      over: { entityId?: number; runId?: number | null; stepId?: number | null; canvasNodeId?: number | null; source?: string } = {},
    ): Promise<number> =>
      (
        await db
          .insert(genTasks)
          .values({
            projectId: pid,
            runId: over.runId ?? null,
            stepId: over.stepId ?? null,
            canvasNodeId: over.canvasNodeId ?? null,
            kind: 'image',
            params: JSON.stringify({ entity_id: over.entityId ?? cA, variant_index: 0, source: over.source ?? refgen.REFGEN_SOURCE }),
            status,
            createdAt: T0,
            updatedAt: T0,
          })
          .returning()
      )[0]!.id
    const tCanvas = await mkRow('pending', { canvasNodeId: 888888 })
    const tRun = await mkRow('pending', { runId: 777777, stepId: 1 })
    const tForeign = await mkRow('pending', { source: 'other_domain' })
    const tGhost = await mkRow('pending', { entityId: 999999 })
    const list0 = await listEntityRefTasks(pid)
    check(list0.items.filter((i) => idList.includes(i.id)).length === 4, '列表含本次 4 任务（终态可见，供行内重试入口）')
    check(!list0.items.some((i) => i.id === tCanvas), 'canvasNodeId 非 null 的任务不混入（即使 params 属本域）')
    check(!list0.items.some((i) => i.id === tRun), 'run/step 任务不混入（无 run 队列为唯一域）')
    check(!list0.items.some((i) => i.id === tForeign), '非本域 params 任务不混入')
    check(list0.items.some((i) => i.id === tGhost && i.entityName === '素材#999999'), '素材已不存在 → entityName 回退 素材#{id}（不丢行、不空标题）')
    check(list0.items.filter((i) => i.entityId === cA).every((i) => i.entityName === '批量角色A'), 'entityName 取自主数据（前端免二次查）')
    check(list0.counts.failed === 4 && list0.counts.total === list0.items.length, 'counts 按状态汇总且 total 与 items 一致')
    const idxLive = list0.items.findIndex((i) => i.status === 'pending')
    const idxSettled = list0.items.findIndex((i) => i.status === 'failed')
    check(idxLive >= 0 && idxLive < idxSettled, '在途任务置顶（刷新后进度首屏不丢）')
    check((await codeOf(() => listEntityRefTasks(-3))) === 'bad_project_id:400', '列表 project_id 非法 → bad_project_id')
    for (let i = 0; i < 25; i += 1) await mkRow('failed')
    const list1 = await listEntityRefTasks(pid)
    check(list1.items.filter((i) => ['succeeded', 'failed', 'cancelled'].includes(i.status)).length === 20, '终态仅留近 20 条（在途不受限，历史不得撞屏）')

    // ---- 取消（仅 pending/processing） ----
    const tCancel = await mkRow('pending')
    const evN = evBuf.length
    const ck = await cancelEntityRefTask(tCancel)
    const rowC = (await db.select().from(genTasks).where(eq(genTasks.id, tCancel)))[0]!
    check(ck.ok === true && rowC.status === 'cancelled' && rowC.errorMsg === 'user cancelled' && rowC.completedAt !== null, '取消 → cancelled + user cancelled + completedAt')
    check(evBuf.slice(evN).some((e) => e.taskId === tCancel && e.status === 'cancelled'), '取消发 entity.ref_gen(cancelled) 事件')
    check((await codeOf(() => cancelEntityRefTask(tCancel))) === 'bad_status:400', '终态再取消 → bad_status')
    check((await codeOf(() => cancelEntityRefTask(tForeign))) === 'not_ref_gen:400', '非本域任务 → not_ref_gen（不误取消画布/run 任务）')
    const nfCancel = await errOf(() => cancelEntityRefTask(9999999))
    check(nfCancel instanceof WorkbenchError && nfCancel.code === 'not_found' && nfCancel.status === 404, '未知任务 → not_found(404)')
    off()

    // ---- 启动恢复（本域在途 → 失败；他域不动） ----
    const tRec1 = await mkRow('pending')
    const tRec2 = await mkRow('processing')
    const rec = await recoverEntityRefTasks()
    const recRows = await db.select().from(genTasks).where(inArray(genTasks.id, [tRec1, tRec2]))
    check(rec.failed >= 2 && recRows.length === 2 && recRows.every((r) => r.status === 'failed' && r.errorMsg === '服务重启中断'), 'recover → 本域在途置 failed「服务重启中断」')
    const untouched = await db.select().from(genTasks).where(inArray(genTasks.id, [tCanvas, tRun, tForeign]))
    check(untouched.length === 3 && untouched.every((r) => r.status === 'pending'), 'recover 不误伤画布/run/非本域任务（职责边界）')
    check((await recoverEntityRefTasks()).failed === 0, '二次 recover 幂等（无残留在途本域任务）')

    // ---- [P6] 执行器成功径（fetch stub 零外发：能力位 / 落盘 / 挂接 / 用量 / 事件 / 重试 / 取消弃存） ----
    const { apiConfigs, assets: assetTbl, usageRecords } = await import('../../../src/db/schema')
    const { attachRefAssets } = await import('../../../src/services/character')
    const { absPathOf } = await import('../../../src/services/storage')
    const origFetch = globalThis.fetch
    await db.insert(apiConfigs).values({
      providerKey: 'openai_image',
      serviceType: 'image',
      name: '探针图像',
      baseUrl: 'http://probe-img.local/v1',
      apiKeyRef: 'env:PROBE_M19_IMG_KEY',
      model: 'endpoint-default-model',
      priority: 0,
      isDefault: 1,
      isActive: 1,
      createdAt: T0,
      updatedAt: T0,
    })
    process.env.PROBE_M19_IMG_KEY = 'probe-key-m19'
    const PNG1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const imgReqs: Array<{ url: string; body: Record<string, unknown> | null }> = []
    let throwNext = true
    let imgDelayMs = 0
    globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
      if (url.includes('/images/generations')) {
        imgReqs.push({ url, body })
        if (imgDelayMs > 0) await sleep(imgDelayMs)
        if (throwNext) {
          throwNext = false
          return new Response('upstream boom', { status: 500 })
        }
        return new Response(JSON.stringify({ data: [{ b64_json: PNG1X1 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const pidImg = await mkProject(
        'M19 批量出图',
        JSON.stringify({ image: { provider: 'openai_image', model: 'settings-model', size: '1024x1024' }, style_preset_ids: [sp1] }),
      )
      const cImg = await mkChar('出图角色', { projectId: pidImg, appearance: '圆脸大眼，虎头帽红袄', refAssetIds: [999] })
      const ev2: Array<{ projectId: number; taskId: number; entityId: number; status: string; error?: string }> = []
      const off2 = onStudioEvent((e) => {
        if (e.type === 'entity.ref_gen') ev2.push({ projectId: e.projectId, taskId: e.taskId, entityId: e.entityId, status: e.status, error: e.error })
      })
      const issued2 = await startEntityRefGen(pidImg, [cImg], 2)
      const ids2 = issued2.tasks.map((x) => x.id)
      const st2 = await settleTasks(ids2)
      check([...st2.values()].every((s) => s === 'succeeded'), `成功径：首个 5xx 自动重试 → 2 任务均 succeeded（实际 ${[...st2.values()].join('/')}）`)
      const rows2 = await db.select().from(genTasks).where(inArray(genTasks.id, ids2))
      check(rows2.some((r) => r.attempts === 2) && rows2.some((r) => r.attempts === 1), '重试留痕：一条 attempts=2（5xx 后重试成功）、一条 attempts=1')
      check(rows2.every((r) => r.resultAssetId !== null), '成功回写 result_asset_id（变体画廊/溯源头）')
      check(imgReqs.every((r) => r.url === 'http://probe-img.local/v1/images/generations') && imgReqs.length >= 3, '请求落 stub 端点（零真实外发）')
      const body0 = imgReqs[0]?.body ?? {}
      check(body0['model'] === 'settings-model' && body0['size'] === '1024x1024', 'settings.image 配置链生效（model 覆盖端点默认 + size 透传）')
      check(Object.keys(body0).sort().join(',') === 'model,n,prompt,size', '能力位 none（openai_image）→ 请求体不携参考图字段（纯文本锚定降级）')
      const prompt2 = rows2.find((r) => r.status === 'succeeded')?.prompt ?? ''
      check(prompt2.includes('圆脸大眼') && prompt2.includes('视觉风格：ink wash painting'), '成功径提示词含项目风格词块（执行期解析并回写任务）')
      const newAssets = await db.select().from(assetTbl).where(eq(assetTbl.projectId, pidImg))
      check(newAssets.length === 2 && newAssets.every((a) => a.purpose === 'reference_character' && a.kind === 'image'), '落盘 purpose=reference_character（角色 kind 映射）+ kind=image')
      check(newAssets.every((a) => !!a.relPath && existsSync(absPathOf(a.relPath))), '图片文件真实写入项目目录（base64 落盘）')
      check(
        newAssets.every((a) => {
          const p = JSON.parse(a.params ?? '{}') as Record<string, unknown>
          return p['source'] === refgen.REFGEN_SOURCE && p['entity_id'] === cImg && typeof p['task_id'] === 'number'
        }),
        'asset.params 带 source/entity_id/task_id（与 spec 溯源约定一致）',
      )
      const merged = JSON.parse(((await db.select().from(characters).where(eq(characters.id, cImg)))[0])!.refAssetIds) as number[]
      check(merged.length === 3 && merged.includes(999) && newAssets.every((a) => merged.includes(a.id)), '自动挂接：原候选保留 + 新产物并集追加')
      const us2 = await db.select().from(usageRecords).where(eq(usageRecords.projectId, pidImg))
      check(
        us2.length === 2 && us2.every((u) => u.kind === 'image' && u.unit === 'image' && u.quantity === 1 && u.runId === null && u.taskId !== null),
        '用量记账 2 行（image/image/1；无 run，taskId 可溯）',
      )
      check(ev2.filter((e) => e.status === 'succeeded').length === 2 && ev2.every((e) => e.projectId === pidImg), 'succeeded 事件 2 条（页内进度 + 列表刷新触发）')
      const addedAgain = await attachRefAssets(pidImg, '出图角色', [newAssets[0]!.id, newAssets[1]!.id], 'character')
      const merged2 = JSON.parse(((await db.select().from(characters).where(eq(characters.id, cImg)))[0])!.refAssetIds) as number[]
      check(addedAgain === 0 && merged2.length === 3, '重复挂接幂等（并集去重，二次追加 0 条）')

      // 取消竞态：出图不可中断 → 完成后弃存（不落资产、不挂接）
      imgDelayMs = 700
      const issued3 = await startEntityRefGen(pidImg, [cImg], 1)
      const tid3 = issued3.tasks[0]!.id
      for (let i = 0; i < 80; i += 1) {
        const r = (await db.select({ status: genTasks.status }).from(genTasks).where(eq(genTasks.id, tid3)))[0]!
        if (r.status === 'processing') break
        await sleep(50)
      }
      await cancelEntityRefTask(tid3)
      const st3 = await settleTasks([tid3])
      check(st3.get(tid3) === 'cancelled', '取消竞态：已发出的出图完成后弃存（status 保持 cancelled，不被 succeeded 覆盖）')
      check((await db.select().from(assetTbl).where(eq(assetTbl.projectId, pidImg))).length === 2, '弃存不落资产（取消后无新增 asset）')
      check((JSON.parse(((await db.select().from(characters).where(eq(characters.id, cImg)))[0])!.refAssetIds) as number[]).length === 3, '弃存不挂接（ref_asset_ids 不变）')
      imgDelayMs = 0
      // 排空在途执行器（stub 延迟 700ms + 重试间隔）：否则本节结束时后台任务会打到已关闭的探针库（日志噪声）
      await sleep(1500)
      off2()
    } finally {
      globalThis.fetch = origFetch
      await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, 'image'))
      delete process.env.PROBE_M19_IMG_KEY
    }
    check((await db.select().from(apiConfigs)).length === 0, 'stub 段收尾清理 image 端点与环境变量（不污染后续节）')
  }
}
