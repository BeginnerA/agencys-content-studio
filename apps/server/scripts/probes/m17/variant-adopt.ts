/** M17[variant-adopt]：纯函数快照（parseResolution/buildComposeArgs/extendTaskParams）+ variants 执行通道 + 变体采纳（断言体逐字搬自原 probe-m17.ts） */
import type { M17Ctx } from './ctx'

export async function run(ctx: M17Ctx): Promise<void> {
  const {
    check, jreq, db, genTasks, eq, inArray, PID, docNode, mkAsset, mkTask, settleTasks,
    parseResolution, buildComposeArgs, extendTaskParams,
  } = ctx
  {
    // ---- 纯函数快照：parseResolution ----
    const rz = parseResolution('1080x1920')
    check(rz.width === 1080 && rz.height === 1920, 'parseResolution：WxH → {1080,1920}')
    let rzMsg = ''
    try {
      parseResolution('1080')
    } catch (e) {
      rzMsg = (e as Error).message
    }
    check(rzMsg.includes('需 WxH'), 'parseResolution：缺 x → 抛「需 WxH」')
    rzMsg = ''
    try {
      parseResolution('1081x1920')
    } catch (e) {
      rzMsg = (e as Error).message
    }
    check(rzMsg.includes('正偶数'), 'parseResolution：奇数宽 → 抛「正偶数」')

    // ---- 纯函数快照：buildComposeArgs ----
    const fcOf = (args: string[]): string => {
      const i = args.indexOf('-filter_complex')
      return i >= 0 ? args[i + 1]! : ''
    }
    const argsN2 = buildComposeArgs({
      videoPaths: ['v1.mp4', 'v2.mp4'],
      audioPaths: ['a1.mp3'],
      outPath: 'o.mp4',
      fps: 30,
      size: { width: 1080, height: 1920 },
    })
    check(argsN2[0] === '-y' && argsN2.filter((a) => a === '-i').length === 3, 'buildComposeArgs：-y + 3 路 -i（视频 2 先行 / 音频 1 后）')
    check(
      fcOf(argsN2).includes('scale=1080:1920') && fcOf(argsN2).includes('concat=n=2:v=1:a=0[vout]') && fcOf(argsN2).includes('amix=inputs=1:duration=longest[aout]'),
      'buildComposeArgs：N=2 逐段归一 + concat + M=1 amix',
    )
    check(
      argsN2.includes('[vout]') && argsN2.includes('[aout]') && argsN2.includes('libx264') && argsN2.includes('aac') && argsN2.includes('+faststart'),
      'buildComposeArgs：maps / 编码 libx264+aac / faststart',
    )
    const argsN1 = buildComposeArgs({ videoPaths: ['v1.mp4'], audioPaths: [], outPath: 'o.mp4', fps: 24 })
    check(
      !argsN1.includes('-filter_complex') &&
        argsN1.join(' ') === '-y -i v1.mp4 -map 0:v -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -r 24 -an -movflags +faststart o.mp4',
      'buildComposeArgs：N=1 无音频 → 无 filter + -map 0:v + -r 24 + -an（精确快照）',
    )

    // ---- 纯函数快照：extendTaskParams ----
    const eA = extendTaskParams({ a: 1 }, { genKind: 'audio', prompt: 'P', voice: 'nova', speed: 1.2 })
    check(eA['a'] === 1 && eA['voice'] === 'nova' && eA['speed'] === 1.2 && Object.keys(eA).length === 3, 'extendTaskParams：audio 附加 voice/speed')
    const eC = extendTaskParams({ a: 1 }, { genKind: 'compose', prompt: '' })
    check(eC['a'] === 1 && eC['fps'] === null && Object.keys(eC).length === 2, 'extendTaskParams：compose 附加 fps=null')
    const eI = extendTaskParams({ a: 1 }, { genKind: 'image', prompt: 'P' })
    check(eI['a'] === 1 && Object.keys(eI).length === 1, 'extendTaskParams：image 原样（probe-m16 快照保护）')

    // ---- 执行通道：variants=2 → 2 任务入队 ----
    const c1 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '变体执行' })
    const CV: number = c1.body.canvas.id
    const GV = (await jreq('POST', `/api/v1/canvases/${CV}/nodes`, { kind: 'gen', spec: { genKind: 'image', prompt: '变体' }, x: 0, y: 0 })).body.node.id
    const rv2 = await jreq('POST', `/api/v1/nodes/${GV}/run`, { variants: 2 })
    check(
      rv2.status === 200 && rv2.body?.ok === true && Array.isArray(rv2.body.taskIds) && rv2.body.taskIds.length === 2 && rv2.body.taskId === rv2.body.taskIds[0],
      'nodes/run：variants=2 → 200 {ok, taskId=首条, taskIds×2}',
    )
    const rv2Ids: number[] = rv2.body.taskIds
    const rows0 = await db.select({ id: genTasks.id }).from(genTasks).where(eq(genTasks.canvasNodeId, GV))
    check(rows0.length === 2 && rv2Ids.every((tid) => rows0.some((t) => t.id === tid)), 'nodes/run：库中恰好 2 条任务行（canvasNodeId 归属）')
    check((await jreq('POST', `/api/v1/nodes/${GV}/run`)).status === 400, 'nodes/run：无 body 再跑 → 400 busy（宽容读体 + 进行中检测）')
    check((await jreq('POST', `/api/v1/nodes/${GV}/run`, { variants: 5 })).status === 400, 'nodes/run：variants=5 → 400')
    check((await jreq('POST', `/api/v1/nodes/${GV}/run`, { variants: 0 })).status === 400, 'nodes/run：variants=0 → 400')
    check((await jreq('POST', `/api/v1/nodes/${GV}/run`, { variants: 1.5 })).status === 400, 'nodes/run：variants=1.5 → 400')

    // ---- 收敛：未配置图片端点 → 两任务自然失败（执行器真实接线） ----
    const settled0 = await settleTasks(rv2Ids)
    check([...settled0.values()].every((st) => st === 'failed'), `nodes/run：variants 任务收敛（未配置 → failed；实际 ${[...settled0.values()].join('/')}）`)
    const failedRows = await db.select({ errorMsg: genTasks.errorMsg, attempts: genTasks.attempts }).from(genTasks).where(inArray(genTasks.id, rv2Ids))
    check(failedRows.every((t) => (t.errorMsg ?? '').length > 0 && t.attempts >= 2), 'nodes/run：失败附 errorMsg + attempts=2（重试耗尽）')

    // ---- 终态后重跑（busy 解除）→ 新批次；取消清理 ----
    const rv2b = await jreq('POST', `/api/v1/nodes/${GV}/run`, { variants: 2 })
    check(rv2b.status === 200 && rv2b.body?.taskIds?.length === 2, 'nodes/run：终态后重跑 → 200 新批次 ×2')
    const batch2: number[] = rv2b.body.taskIds
    check((await jreq('POST', `/api/v1/tasks/${batch2[0]}/cancel`)).status === 200, 'tasks/:id/cancel：进行中任务 → 200')
    await jreq('POST', `/api/v1/tasks/${batch2[1]}/cancel`)
    const settled1 = await settleTasks(batch2)
    check([...settled1.values()].every((st) => st === 'cancelled' || st === 'failed'), `nodes/run：重跑批次收敛（取消清理；实际 ${[...settled1.values()].join('/')}）`)
    const rows1 = await db.select({ id: genTasks.id }).from(genTasks).where(eq(genTasks.canvasNodeId, GV))
    check(rows1.length === 4, 'nodes/run：两批共 4 条任务行（画廊历史共存）')

    // ---- 变体画廊 → 采纳闭环 ----
    const A1x = await mkAsset(PID, 'image', '变体甲')
    const A2x = await mkAsset(PID, 'image', '变体乙')
    const tv1 = await mkTask(PID, { canvasNodeId: GV, status: 'succeeded', resultAssetId: A1x })
    const tv2 = await mkTask(PID, { canvasNodeId: GV, status: 'succeeded', resultAssetId: A2x })
    let d = await jreq('GET', `/api/v1/canvases/${CV}`)
    let dn = docNode(d.body, GV)
    check(dn?.displayTaskId === tv2 && dn?.assetId === A2x, '变体画廊：未采纳 → 最新成功（tv2）')
    check(dn?.results?.length === 2 && dn?.results?.[0]?.taskId === tv2, '变体画廊：results 仅成功产物 2 条（新→旧）')
    check((await jreq('PATCH', `/api/v1/nodes/${GV}`, { adoptedTaskId: tv1 })).status === 200, '变体采纳：PATCH adoptedTaskId=tv1 → 200')
    d = await jreq('GET', `/api/v1/canvases/${CV}`)
    dn = docNode(d.body, GV)
    check(dn?.displayTaskId === tv1 && dn?.assetId === A1x && dn?.results?.length === 2, '变体采纳：displayTask→tv1（results 不变）')
  }
}
