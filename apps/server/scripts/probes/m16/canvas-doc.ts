/** M16① canvas-doc：画布/节点/边 CRUD 全链 + 派生读模型 + 宽容 + 级联（断言体逐字搬自原 probe-m16.ts） */
import type { M16Ctx } from './ctx'

export async function run(ctx: M16Ctx): Promise<void> {
  const { check, jreq, PID, A1, A2, A_OTHER, db, canvasNodes, eq, count, mkTask, docNode, edgeCount } = ctx
  // 项目不存在 → 404
  const miss = await jreq('POST', '/api/v1/projects/999999/canvases', { name: 'x' })
  check(miss.status === 404 && miss.body?.error?.code === 'not_found', 'POST 不存在项目建画布 → 404 not_found')

  // 建画布（含默认名）
  const c1 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '主画布' })
  check(c1.status === 201 && c1.body?.canvas?.id > 0, 'POST 建画布 → 201')
  const C1: number = c1.body.canvas.id
  const c2 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '   ' })
  check(c2.status === 201 && c2.body?.canvas?.name === '未命名画布', 'POST 建画布空名 → 默认「未命名画布」')
  const C2: number = c2.body.canvas.id

  // 空文档
  const d0 = await jreq('GET', `/api/v1/canvases/${C1}`)
  check(d0.status === 200 && d0.body?.nodes?.length === 0 && d0.body?.edges?.length === 0, 'GET 空画布 → 200 空文档')
  check(
    JSON.stringify(d0.body?.canvas?.viewport) === JSON.stringify({ x: 0, y: 0, zoom: 1 }),
    'viewport 默认 {0,0,1}',
  )

  // PATCH：改名 + viewport clamp
  const p1 = await jreq('PATCH', `/api/v1/canvases/${C1}`, { name: '改名', viewport: { x: 10, y: 20, zoom: 99 } })
  check(p1.status === 200 && p1.body?.canvas?.name === '改名', 'PATCH 画布改名 → 200')
  const d1 = await jreq('GET', `/api/v1/canvases/${C1}`)
  check(d1.body?.canvas?.viewport?.zoom === 10 && d1.body?.canvas?.viewport?.x === 10, 'viewport zoom clamp 到 10')
  const pBad = await jreq('PATCH', `/api/v1/canvases/${C1}`, { viewport: { x: 'a', y: 0, zoom: 1 } })
  check(pBad.status === 400, 'PATCH 非法 viewport → 400')

  // 建节点
  const n1r = await jreq('POST', `/api/v1/canvases/${C1}/nodes`, { kind: 'asset', assetId: A1, x: 10, y: 20 })
  check(n1r.status === 201 && n1r.body?.node?.kind === 'asset', 'POST 素材节点 → 201')
  const N1: number = n1r.body.node.id
  const nOther = await jreq('POST', `/api/v1/canvases/${C1}/nodes`, { kind: 'asset', assetId: A_OTHER, x: 0, y: 0 })
  check(nOther.status === 400, 'POST 素材节点他项目资产 → 400（项目域校验）')
  const n2r = await jreq('POST', `/api/v1/canvases/${C1}/nodes`, {
    kind: 'gen',
    spec: { genKind: 'image', prompt: '一只猫' },
    x: 300,
    y: 0,
  })
  check(n2r.status === 201, 'POST 图像生成节点 → 201')
  const N2: number = n2r.body.node.id
  const n3r = await jreq('POST', `/api/v1/canvases/${C1}/nodes`, {
    kind: 'gen',
    spec: { genKind: 'video', prompt: '运镜', duration: 5 },
    x: 600,
    y: 0,
  })
  check(n3r.status === 201, 'POST 视频生成节点 → 201')
  const N3: number = n3r.body.node.id
  const n4r = await jreq('POST', `/api/v1/canvases/${C1}/nodes`, {
    kind: 'gen',
    spec: { genKind: 'image', prompt: '', edit: { mode: 'inpaint' } },
    x: 300,
    y: 300,
  })
  check(n4r.status === 201, 'POST 编辑节点（inpaint）→ 201')
  const N4: number = n4r.body.node.id
  // [M17] 无产物图像 gen 节点：作为「上游无产物」用例源（视频 gen 已不可作 reference 源）
  const n5r = await jreq('POST', `/api/v1/canvases/${C1}/nodes`, {
    kind: 'gen',
    spec: { genKind: 'image', prompt: '无产物源' },
    x: 900,
    y: 0,
  })
  check(n5r.status === 201, 'POST 图像生成节点（无任务）→ 201')
  const N5: number = n5r.body.node.id
  const nBad = await jreq('POST', `/api/v1/canvases/${C1}/nodes`, { kind: 'gen', spec: { genKind: 'xxx' }, x: 0, y: 0 })
  check(nBad.status === 400, 'POST 非法 spec → 400')
  const kBad = await jreq('POST', `/api/v1/canvases/${C1}/nodes`, { kind: 'xxx', x: 0, y: 0 })
  check(kBad.status === 400 && kBad.body?.error?.code === 'bad_kind', 'POST 非法 kind → 400 bad_kind')

  // PATCH 节点
  const u1 = await jreq('PATCH', `/api/v1/nodes/${N1}`, { x: 1, y: 2, title: '素材甲节点' })
  check(u1.status === 200 && u1.body?.node?.x === 1 && u1.body?.node?.title === '素材甲节点', 'PATCH 节点坐标+标题 → 200')
  const uSpec = await jreq('PATCH', `/api/v1/nodes/${N1}`, { spec: { genKind: 'image', prompt: 'x' } })
  check(uSpec.status === 400, 'PATCH 素材节点改 spec → 400')

  // 边矩阵
  const e1 = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N1, to: N2, port: 'reference' })
  check(e1.status === 201, 'POST reference 边（素材→图像）→ 201')
  const eDup = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N1, to: N2, port: 'reference' })
  check(eDup.status === 400, '重复边 → 400')
  const eFFBad = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N1, to: N2, port: 'first_frame' })
  check(eFFBad.status === 400, '首帧到图像节点 → 400（仅视频）')
  const eFF = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N1, to: N3, port: 'first_frame' })
  check(eFF.status === 201, '首帧到视频节点 → 201')
  const eFF2 = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N2, to: N3, port: 'first_frame' })
  check(eFF2.status === 400, '首帧第二条 → 400（≤1）')
  const eSrcBad = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N1, to: N2, port: 'source' })
  check(eSrcBad.status === 400, '源图到非编辑节点 → 400')
  const eSrc = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N1, to: N4, port: 'source' })
  check(eSrc.status === 201, '源图到编辑节点 → 201')
  const eSelf = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N2, to: N2, port: 'reference' })
  check(eSelf.status === 400, '自环 → 400')
  const eC1 = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N2, to: N3, port: 'reference' })
  check(eC1.status === 201, '图像→视频 reference 边 → 201')
  const eC2 = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N2, to: N5, port: 'reference' })
  check(eC2.status === 201, '图像→图像 reference 边 → 201')
  const eCycle = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N5, to: N2, port: 'reference' })
  check(eCycle.status === 400, '环（N2→N5→N2）→ 400 拒绝')
  const ePort = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N1, to: N2, port: 'foo' })
  check(ePort.status === 400, '非法端口 → 400')
  const eFmt = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: 'x', to: N2, port: 'reference' })
  check(eFmt.status === 400, 'from 非整数 → 400')
  // 跨画布
  const nc2 = await jreq('POST', `/api/v1/canvases/${C2}/nodes`, { kind: 'gen', spec: { genKind: 'image', prompt: 'B' }, x: 0, y: 0 })
  const NX: number = nc2.body.node.id
  const eCross = await jreq('POST', `/api/v1/canvases/${C2}/edges`, { from: N1, to: NX, port: 'reference' })
  check(eCross.status === 400, '跨画布节点连线 → 400')

  // 派生读模型：任务状态映射
  await mkTask(PID, { canvasNodeId: N2, status: 'pending' })
  await mkTask(PID, { canvasNodeId: N2, status: 'succeeded', resultAssetId: A2 })
  const d2 = await jreq('GET', `/api/v1/canvases/${C1}`)
  const dn2 = docNode(d2.body, N2)
  check(dn2?.status === 'succeeded' && dn2?.latestTask?.resultAssetId === A2, '派生状态：最新任务 succeeded 映射')
  check(dn2?.asset?.id === A2 && dn2?.asset?.urls?.thumb !== null, 'gen 节点结果资产冗余（含缩略 URL）')
  check(dn2?.tasks?.length === 2, '任务历史最近 5 条透传')
  check(dn2?.readiness?.ready === true && dn2?.canRun === true, 'readiness：prompt 非空 + 上游素材就绪 → 可运行')
  await mkTask(PID, { canvasNodeId: N2, status: 'processing' })
  const d3 = await jreq('GET', `/api/v1/canvases/${C1}`)
  const dn2b = docNode(d3.body, N2)
  check(dn2b?.status === 'processing' && dn2b?.canCancel === true && dn2b?.canRun === false, 'busy：processing → canCancel / 禁 run')

  // readiness：编辑节点问题清单（无 prompt / 无 mask / source 已连但上游就绪）
  const dn4 = docNode(d3.body, N4)
  check(
    dn4?.readiness?.problems?.some((p: string) => p.includes('局部重绘需填写提示词')) &&
      dn4?.readiness?.problems?.some((p: string) => p.includes('缺少蒙版')),
    '编辑节点 readiness：inpaint 缺 prompt/蒙版 → problems 列出',
  )
  check(dn4?.editCapability !== null && dn4?.editCapability?.inpaint === false, '编辑节点 editCapability 快照（无端点 → false）')
  // 上游无产物：加一条来自 gen（无产物）节点的 reference 边（N5 无任务 → 无产物）
  const eUp = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N5, to: N4, port: 'reference' })
  check(eUp.status === 201, '编辑节点可再挂 reference 上游')
  // N5 无任务 → N4 的 reference 来自 N5（无产物）→ 问题
  const d4 = await jreq('GET', `/api/v1/canvases/${C1}`)
  const dn4b = docNode(d4.body, N4)
  check(
    dn4b?.readiness?.problems?.some((p: string) => p.includes('暂无成功产物')),
    '上游 gen 无产物 → readiness 列出「暂无成功产物」',
  )

  // 宽容：坏 spec
  await db.update(canvasNodes).set({ spec: '{bad json' }).where(eq(canvasNodes.id, N2))
  const d5 = await jreq('GET', `/api/v1/canvases/${C1}`)
  const dn2c = docNode(d5.body, N2)
  check(dn2c?.spec === null && typeof dn2c?.specError === 'string' && dn2c?.canRun === false, '坏 spec → specError + 禁 run（不炸）')
  await db.update(canvasNodes).set({ spec: JSON.stringify({ genKind: 'image', prompt: '一只猫' }) }).where(eq(canvasNodes.id, N2))

  // 列表 nodeCount
  const list = await jreq('GET', `/api/v1/projects/${PID}/canvases`)
  const item1 = (list.body?.items ?? []).find((x: any) => x.id === C1)
  check(item1?.nodeCount === 5, '画布列表 nodeCount=5')

  // 级联：删节点清边
  const nDel = await jreq('DELETE', `/api/v1/nodes/${N1}`)
  check(nDel.status === 200, 'DELETE 节点 → 200')
  const d6 = await jreq('GET', `/api/v1/canvases/${C1}`)
  check(
    (d6.body?.edges ?? []).every((e: any) => e.from !== N1 && e.to !== N1),
    '删节点 → 级联清理其全部连线',
  )

  // duplicate：id 全映射
  const dup = await jreq('POST', `/api/v1/canvases/${C1}/duplicate`, { name: '副本' })
  check(dup.status === 201 && dup.body?.canvas?.name === '副本', 'POST duplicate → 201')
  const CD: number = dup.body.canvas.id
  const dOrig = await jreq('GET', `/api/v1/canvases/${C1}`)
  const dCopy = await jreq('GET', `/api/v1/canvases/${CD}`)
  check(
    dCopy.body?.nodes?.length === dOrig.body?.nodes?.length && dCopy.body?.edges?.length === dOrig.body?.edges?.length,
    'duplicate：节点数/边数一致',
  )
  const origIds = new Set((dOrig.body?.nodes ?? []).map((n: any) => n.id))
  const copyIds = new Set((dCopy.body?.nodes ?? []).map((n: any) => n.id))
  check([...copyIds].every((id) => !origIds.has(id as number)), 'duplicate：节点 id 全部重映射')
  check((dCopy.body?.edges ?? []).every((e: any) => copyIds.has(e.from) && copyIds.has(e.to)), 'duplicate：边指向新节点集')

  // 404 全家桶
  check((await jreq('GET', '/api/v1/canvases/999999')).status === 404, 'GET 不存在画布 → 404')
  check((await jreq('PATCH', '/api/v1/canvases/999999', { name: 'x' })).status === 404, 'PATCH 不存在画布 → 404')
  check((await jreq('DELETE', '/api/v1/canvases/999999')).status === 404, 'DELETE 不存在画布 → 404')
  check((await jreq('PATCH', '/api/v1/nodes/999999', { x: 1 })).status === 404, 'PATCH 不存在节点 → 404')
  check((await jreq('DELETE', '/api/v1/nodes/999999')).status === 404, 'DELETE 不存在节点 → 404')
  check((await jreq('DELETE', '/api/v1/edges/999999')).status === 404, 'DELETE 不存在边 → 404')

  // [M18] 变更：DELETE 画布 → 软删（进回收站）；节点/边物理保留以支持恢复（原「物理级联清空」语义废弃）
  const nodeBefore = Number((await db.select({ n: count() }).from(canvasNodes).where(eq(canvasNodes.canvasId, C1)))[0]?.n ?? -1)
  const edgeBefore = await edgeCount(C1)
  const c1Del = await jreq('DELETE', `/api/v1/canvases/${C1}`)
  check(c1Del.status === 200, 'DELETE 画布 → 200（M18：软删进回收站）')
  check((await jreq('GET', `/api/v1/canvases/${C1}`)).status === 404, '软删后 GET → 404（正常读取过滤回收站项）')
  const nodeLeft = Number((await db.select({ n: count() }).from(canvasNodes).where(eq(canvasNodes.canvasId, C1)))[0]?.n ?? -1)
  check(
    nodeBefore > 0 && nodeLeft === nodeBefore && edgeBefore > 0 && (await edgeCount(C1)) === edgeBefore,
    '软删 → 节点/边物理保留（可恢复；M18 适配替代原「级联清空」断言）',
  )
}
