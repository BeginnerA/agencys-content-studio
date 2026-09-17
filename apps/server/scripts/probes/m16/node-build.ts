/** M16② node-build：输入映射纯矩阵 + 参数快照 + 执行通道失败链（断言体逐字搬自原 probe-m16.ts） */
import type { InputPlan, NodeSpec } from '../../../src/services/creation'
import type { M16Ctx } from './ctx'

export async function run(ctx: M16Ctx): Promise<void> {
  const {
    check,
    jreq,
    PID,
    db,
    genTasks,
    eq,
    mkTask,
    docNode,
    sleep,
    planNodeInputs,
    topoSortGenNodeIds,
    parseViewport,
    safeParseSpec,
    specProblems,
    buildNodeTaskParams,
    appendStyleSnippet,
    buildEditParams,
    wouldCreateCycle,
    recoverCanvasTasks,
  } = ctx
  const imgSpec: NodeSpec = { genKind: 'image', prompt: 'P' }
  const videoSpec: NodeSpec = { genKind: 'video', prompt: 'V' }
  const editSpec: NodeSpec = { genKind: 'image', prompt: '', edit: { mode: 'inpaint' } }
  const up = (m: Array<[number, any]>): Map<number, any> => new Map(m)
  const upImg = (id: number): [number, any] => [id, { assetId: id + 100, mediaKind: 'image' }]

  // reference 上限：image ≤6
  const edges7 = Array.from({ length: 7 }, (_, i) => ({ from: i + 1, to: 100, port: 'reference' }))
  const p7 = planNodeInputs(imgSpec, 100, edges7, up(edges7.map((e) => upImg(e.from))))
  check(
    p7.referenceAssetIds.length === 6 && p7.problems.some((x) => x.includes('参考图超过上限 6 张')),
    '纯矩阵：image reference 上限 6（第 7 条忽略 + problems）',
  )
  // reference 上限：video ≤2
  const edges3 = Array.from({ length: 3 }, (_, i) => ({ from: i + 1, to: 100, port: 'reference' }))
  const p3 = planNodeInputs(videoSpec, 100, edges3, up(edges3.map((e) => upImg(e.from))))
  check(
    p3.referenceAssetIds.length === 2 && p3.problems.some((x) => x.includes('参考图超过上限 2 张')),
    '纯矩阵：video reference 上限 2',
  )
  // first_frame：图像节点拒绝；视频节点取值
  const pFFimg = planNodeInputs(imgSpec, 100, [{ from: 1, to: 100, port: 'first_frame' }], up([upImg(1)]))
  check(pFFimg.firstFrameAssetId === null && pFFimg.problems.some((x) => x.includes('首帧连线仅视频节点可用')), '纯矩阵：首帧仅视频')
  const pFFvideo = planNodeInputs(
    videoSpec,
    100,
    [
      { from: 1, to: 100, port: 'first_frame' },
      { from: 2, to: 100, port: 'last_frame' },
      { from: 3, to: 100, port: 'reference' },
    ],
    up([upImg(1), upImg(2), upImg(3)]),
  )
  check(
    pFFvideo.firstFrameAssetId === 101 && pFFvideo.lastFrameAssetId === 102 && pFFvideo.referenceAssetIds.length === 1,
    '纯矩阵：视频首帧/尾帧/参考多端口映射',
  )
  // source：非编辑拒绝；编辑缺连线；编辑上游无产物不重复报缺
  const pSrcBad = planNodeInputs(imgSpec, 100, [{ from: 1, to: 100, port: 'source' }], up([upImg(1)]))
  check(pSrcBad.sourceAssetId === null && pSrcBad.problems.some((x) => x.includes('源图连线仅编辑节点可用')), '纯矩阵：源图仅编辑节点')
  const pSrcMiss = planNodeInputs(editSpec, 100, [], up([]))
  check(pSrcMiss.problems.some((x) => x.includes('编辑节点缺少源图连线')), '纯矩阵：编辑节点缺 source 连线 → problems')
  const pSrcNoOut = planNodeInputs(
    editSpec,
    100,
    [{ from: 1, to: 100, port: 'source' }],
    up([[1, { assetId: null, mediaKind: null }]]),
  )
  check(
    pSrcNoOut.problems.some((x) => x.includes('暂无成功产物')) &&
      !pSrcNoOut.problems.some((x) => x.includes('编辑节点缺少源图连线')),
    '纯矩阵：编辑上游无产物只报「暂无成功产物」（不重复报缺源）',
  )
  // 上游非图片
  const pVideoUp = planNodeInputs(imgSpec, 100, [{ from: 1, to: 100, port: 'reference' }], up([[1, { assetId: 5, mediaKind: 'video' }]]))
  check(pVideoUp.problems.some((x) => x.includes('不能作为生成输入')), '纯矩阵：非图片产物 → problems（仅图片可入）')

  // topoSort
  const order = topoSortGenNodeIds([1, 2, 3, 4], [
    { from: 1, to: 2 },
    { from: 2, to: 3 },
    { from: 1, to: 4 },
  ])
  check(JSON.stringify(order) === '[1,2,4,3]', 'topoSort：Kahn 稳定顺序 [1,2,4,3]')

  // 解析宽容（纯）
  check(
    parseViewport({ x: 0, y: 0, zoom: 0.01 })?.zoom === 0.1 && parseViewport({ x: 0, y: 0, zoom: 99 })?.zoom === 10,
    'parseViewport：zoom clamp [0.1, 10]',
  )
  check(parseViewport({ x: 0, y: 0, zoom: 'a' }) === null && parseViewport(null) === null, 'parseViewport：非法 → null')
  check(safeParseSpec('{bad').spec === null && safeParseSpec(null).error === 'spec 缺失', 'safeParseSpec：坏 JSON/缺失 → 宽容')
  check(specProblems({ genKind: 'image', prompt: '  ' }).some((x) => x.includes('prompt 为空')), 'specProblems：空 prompt → 问题清单')

  // buildNodeTaskParams 快照
  const specFull: NodeSpec = {
    genKind: 'image',
    prompt: 'P',
    size: '1024x1024',
    duration: 5,
    resolution: '720p',
    aspectRatio: '16:9',
    provider: 'prov',
    model: 'mod',
    useStylePreset: true,
    edit: { mode: 'inpaint', maskAssetId: 42 },
  }
  const planFull: InputPlan = {
    referenceAssetIds: [1, 2],
    firstFrameAssetId: null,
    lastFrameAssetId: null,
    sourceAssetId: 3,
    promptText: null,
    videoAssetIds: [],
    audioAssetIds: [],
    textInputs: [],
    problems: [],
    notes: [],
  }
  const paramsFull = buildNodeTaskParams(specFull, { stylePresetIds: [9], plan: planFull })
  const expectedParams =
    '{"size":"1024x1024","duration":5,"resolution":"720p","aspectRatio":"16:9","useStylePreset":true,"stylePresetIds":[9],' +
    '"edit":{"mode":"inpaint","maskAssetId":42,"expand":null},"input":{"referenceAssetIds":[1,2],"firstFrameAssetId":null,"lastFrameAssetId":null,"sourceAssetId":3}}'
  check(JSON.stringify(paramsFull) === expectedParams, 'buildNodeTaskParams 全字段快照')

  // appendStyleSnippet
  check(appendStyleSnippet('P', 'S') === 'P\n视觉风格：S', 'appendStyleSnippet：拼接')
  check(appendStyleSnippet('', 'S') === '视觉风格：S' && appendStyleSnippet('P', null) === 'P', 'appendStyleSnippet：空基名/空片段')

  // buildEditParams
  let threw = false
  try {
    buildEditParams({ genKind: 'image', prompt: 'p' }, { baseImage: 'b' })
  } catch {
    threw = true
  }
  check(threw, 'buildEditParams：非编辑 spec → 抛')
  threw = false
  try {
    buildEditParams({ genKind: 'image', prompt: 'p', edit: { mode: 'inpaint' } }, { baseImage: 'b' })
  } catch {
    threw = true
  }
  check(threw, 'buildEditParams：inpaint 缺 mask → 抛')
  const ep1 = buildEditParams({ genKind: 'image', prompt: ' 换色 ', edit: { mode: 'inpaint' } }, { baseImage: 'B', mask: 'M' })
  check(
    JSON.stringify(ep1) === '{"mode":"inpaint","baseImage":"B","mask":"M","prompt":"换色"}',
    'buildEditParams：inpaint 映射（prompt trim）',
  )
  const ep2 = buildEditParams({ genKind: 'image', prompt: '', edit: { mode: 'erase' } }, { baseImage: 'B', mask: 'M' })
  check(ep2.mask === 'M' && !('prompt' in ep2), 'buildEditParams：erase 无 prompt 省略')
  const ep3 = buildEditParams(
    { genKind: 'image', prompt: '', size: '1024x1024', edit: { mode: 'outpaint', expand: { angle: 30, xScale: 1.5 } } },
    { baseImage: 'B' },
  )
  check(
    JSON.stringify(ep3.expand) === '{"angle":30,"xScale":1.5}' && ep3.mask === undefined && ep3.size === '1024x1024',
    'buildEditParams：outpaint expand 透传（无 mask）',
  )

  // 环检测纯函数
  check(!wouldCreateCycle([{ from: 1, to: 2 }], 2, 3), 'wouldCreateCycle：延伸链 → false')
  check(wouldCreateCycle([{ from: 1, to: 2 }], 2, 1), 'wouldCreateCycle：直连回边 → true')
  check(wouldCreateCycle([{ from: 1, to: 2 }, { from: 2, to: 3 }], 3, 1), 'wouldCreateCycle：长链回边 → true')

  // ---- 执行通道失败链（无端点配置：任务落库 → 失败透传 → 复位）----
  const cExec = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '执行画布' })
  const CX: number = cExec.body.canvas.id
  const nr = await jreq('POST', `/api/v1/canvases/${CX}/nodes`, { kind: 'gen', spec: { genKind: 'image', prompt: '失败链' }, x: 5, y: 5 })
  const NX: number = nr.body.node.id
  const run1 = await jreq('POST', `/api/v1/nodes/${NX}/run`)
  check(run1.status === 200 && run1.body?.taskId > 0, '执行通道：run → 200 任务入队')
  const tid: number = run1.body.taskId
  const trow = (await db.select().from(genTasks).where(eq(genTasks.id, tid)))[0]!
  check(
    trow.canvasNodeId === NX && trow.runId === null && trow.stepId === null && ['pending', 'processing'].includes(trow.status),
    '任务行：canvasNodeId 归属 + run/step 恒 null',
  )
  check(String(trow.params).includes('referenceAssetIds'), '任务行 params 含输入快照')
  const busy = await jreq('POST', `/api/v1/nodes/${NX}/run`)
  check(busy.status === 400, '执行通道：busy 期间重复 run → 400')
  let st = ''
  let errMsg: string | null = null
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    const rows = await db.select().from(genTasks).where(eq(genTasks.id, tid))
    st = rows[0]?.status ?? ''
    errMsg = rows[0]?.errorMsg ?? null
    if (st === 'failed' || st === 'cancelled' || st === 'succeeded') break
    await sleep(400)
  }
  check(st === 'failed' && !!errMsg, `执行通道：无端点配置 → 自动重试后 failed（errorMsg 透传：${String(errMsg).slice(0, 60)}）`)
  const docAfter = await jreq('GET', `/api/v1/canvases/${CX}`)
  const dn = docNode(docAfter.body, NX)
  check(dn?.status === 'failed' && dn?.canRun === true && dn?.canCancel === false, '失败后复位：failed → 可重跑')
  // 复用端点自然不误伤
  const retry = await jreq('POST', `/api/v1/tasks/${tid}/retry`)
  check(retry.status === 400 && retry.body?.error?.code === 'no_step', 'POST /tasks/:id/retry 对画布任务 → 400 no_step（不误伤）')
  const cancel = await jreq('POST', `/api/v1/tasks/${tid}/cancel`)
  check(cancel.status === 400, 'POST /tasks/:id/cancel 对终态画布任务 → 400（复用既有端点）')

  // recoverCanvasTasks：pending 画布任务 → failed「服务重启中断」
  const tRec = await mkTask(PID, { canvasNodeId: NX, status: 'pending' })
  const rec = await recoverCanvasTasks()
  const tRecAfter = (await db.select().from(genTasks).where(eq(genTasks.id, tRec)))[0]!
  check(rec.failed >= 1 && tRecAfter.status === 'failed' && tRecAfter.errorMsg === '服务重启中断', 'recoverCanvasTasks → failed「服务重启中断」')
  // 既有 run 任务不受 recover 影响
  const tRun = await mkTask(PID, { runId: 424242, stepId: 1, status: 'pending' })
  await recoverCanvasTasks()
  const tRunAfter = (await db.select().from(genTasks).where(eq(genTasks.id, tRun)))[0]!
  check(tRunAfter.status === 'pending', 'recover 仅命中画布任务（run 任务不动）')
}
