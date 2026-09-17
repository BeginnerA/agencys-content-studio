/** M17[node-kinds]：text/entity/run 建/改/删全链 + 派生读模型 + 错误族（断言体逐字搬自原 probe-m17.ts） */
import type { M17Ctx } from './ctx'

export async function run(ctx: M17Ctx): Promise<void> {
  const { check, jreq, docNode, db, canvasNodes, eq, mkEntity, characters, PID, ENT, ENT_G, ENT_EMPTY, ENT_OTHER, A1, RUN1, RUN2, RUN_OTHER } = ctx
  {
    const c1 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '节点全型' })
    const C: number = c1.body.canvas.id

    // ---- text 节点 ----
    const nt = await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'text', spec: { text: '窗边的猫' }, x: 10, y: 10 })
    check(nt.status === 201 && nt.body?.node?.kind === 'text', 'POST 文本节点 → 201')
    const NT: number = nt.body.node.id
    let d = await jreq('GET', `/api/v1/canvases/${C}`)
    let dn = docNode(d.body, NT)
    check(dn?.spec?.text === '窗边的猫' && dn?.readiness?.ready === true && dn?.assetId === null, '文本节点读模型：spec.text / ready / assetId null')
    check(dn?.canRun === null && dn?.editCapability === null && dn?.title === `文本 #${NT}`, '文本节点：canRun/editCapability null + 默认标题')
    const tu = await jreq('PATCH', `/api/v1/nodes/${NT}`, { spec: { text: '改后文案' } })
    check(tu.status === 200, 'PATCH 文本节点 spec → 200')
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    check(docNode(d.body, NT)?.spec?.text === '改后文案', '文本节点 spec 持久化')
    check((await jreq('PATCH', `/api/v1/nodes/${NT}`, { spec: { text: 5 } })).status === 400, 'PATCH 文本 spec 非字符串 → 400')
    check((await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'text', spec: 'x', x: 0, y: 0 })).status === 400, 'POST 文本节点非对象 spec → 400')

    // 空文本 → readiness；坏 spec 宽容
    const nt2 = await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'text', spec: { text: '  ' }, x: 10, y: 100 })
    const NT2: number = nt2.body.node.id
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    dn = docNode(d.body, NT2)
    check(dn?.readiness?.ready === false && dn?.readiness?.problems?.some((p: string) => p.includes('文本为空')), '文本节点空文本 → readiness 不 ready')
    await db.update(canvasNodes).set({ spec: '{bad' }).where(eq(canvasNodes.id, NT2))
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    dn = docNode(d.body, NT2)
    check(dn?.spec === null && typeof dn?.specError === 'string' && dn?.readiness?.ready === false, '文本节点坏 spec → specError 宽容')
    await db.update(canvasNodes).set({ spec: JSON.stringify({ text: ' ' }) }).where(eq(canvasNodes.id, NT2))

    // ---- entity 节点 ----
    const ne = await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'entity', entityId: ENT, x: 300, y: 10 })
    check(ne.status === 201 && ne.body?.node?.kind === 'entity', 'POST 实体节点（项目实体）→ 201')
    const NE: number = ne.body.node.id
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    dn = docNode(d.body, NE)
    check(dn?.spec?.entityId === ENT && dn?.entity?.name === '角色甲' && dn?.entity?.refCount === 2, '实体节点读模型：entity 摘要（name/refCount）')
    check(dn?.entity?.asset?.id === A1 && dn?.title === '角色甲', '实体节点：首张参考图缩略 + 默认标题=实体名')
    check((await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'entity', entityId: ENT_G, x: 300, y: 120 })).status === 201, 'POST 实体节点（全局实体）→ 201（允许）')
    const neEmpty = await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'entity', entityId: ENT_EMPTY, x: 300, y: 240 })
    const NE_EMPTY: number = neEmpty.body.node.id
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    check(docNode(d.body, NE_EMPTY)?.readiness?.problems?.some((p: string) => p.includes('实体无参考图')), '实体无参考图 → readiness problem')
    check((await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'entity', entityId: ENT_OTHER, x: 0, y: 0 })).status === 400, '实体节点他项目实体 → 400（项目域）')
    check((await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'entity', entityId: 999999, x: 0, y: 0 })).status === 400, '实体节点不存在 entityId → 400')
    check((await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'entity', entityId: 'x', x: 0, y: 0 })).status === 400, '实体节点非法 entityId → 400')
    // 实体删除 → 宽容降级
    const entTmp = await mkEntity(PID, '临时实体', [A1])
    const neTmp = await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'entity', entityId: entTmp, x: 0, y: 400 })
    const NE_TMP: number = neTmp.body.node.id
    await db.delete(characters).where(eq(characters.id, entTmp))
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    check(docNode(d.body, NE_TMP)?.readiness?.problems?.some((p: string) => p.includes('实体不存在或已删除')), '实体删除后 → readiness「实体不存在或已删除」')

    // ---- run 节点 ----
    const nr = await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'run', runId: RUN1, x: 600, y: 10 })
    check(nr.status === 201 && nr.body?.node?.kind === 'run', 'POST 运行节点 → 201')
    const NRun: number = nr.body.node.id
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    dn = docNode(d.body, NRun)
    check(dn?.spec?.runId === RUN1 && dn?.run?.status === 'running' && dn?.run?.templateKey === 'mengbao-episode', '运行节点读模型：run 摘要（status/templateKey）')
    check(dn?.run?.steps?.total === 3 && dn?.run?.steps?.succeeded === 2, '运行节点：steps 计数 {succeeded:2,total:3}')
    check(dn?.title === `运行 #${RUN1}` && dn?.canRun === null, '运行节点：默认标题 + canRun null')
    check((await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'run', runId: RUN_OTHER, x: 0, y: 0 })).status === 400, '运行节点他项目 run → 400')
    check((await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'run', runId: 999999, x: 0, y: 0 })).status === 400, '运行节点不存在 runId → 400')
    const nr2 = await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'run', runId: RUN2, x: 600, y: 120 })
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    dn = docNode(d.body, nr2.body.node.id)
    check(dn?.run?.status === 'completed' && dn?.run?.steps?.succeeded === 1 && dn?.run?.steps?.total === 2, '运行节点：终态派生（completed + 1/2）')

    // ---- spec / seq / adoptedTaskId 错误族 ----
    check((await jreq('PATCH', `/api/v1/nodes/${NRun}`, { spec: { runId: RUN2 } })).status === 400, 'PATCH run 节点 spec → 400')
    check((await jreq('PATCH', `/api/v1/nodes/${NE}`, { spec: { entityId: ENT_G } })).status === 400, 'PATCH entity 节点 spec → 400')
    check((await jreq('PATCH', `/api/v1/nodes/${NT}`, { adoptedTaskId: 1 })).status === 400, 'PATCH 文本节点 adoptedTaskId → 400（仅 gen）')
    const seqOk = await jreq('PATCH', `/api/v1/nodes/${NT}`, { seq: 3 })
    check(seqOk.status === 200, 'PATCH seq=3 → 200')
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    check(docNode(d.body, NT)?.seq === 3, 'seq 持久化到读模型')
    check((await jreq('PATCH', `/api/v1/nodes/${NT}`, { seq: 0 })).status === 400, 'PATCH seq=0 → 400')
    check((await jreq('PATCH', `/api/v1/nodes/${NT}`, { seq: 'a' })).status === 400, 'PATCH seq 非数字 → 400')
    check((await jreq('PATCH', `/api/v1/nodes/${NT}`, { seq: null })).status === 200, 'PATCH seq=null → 200（清除）')
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    check(docNode(d.body, NT)?.seq === null, 'seq 清除 → null')

    // ---- 删除族 ----
    check((await jreq('DELETE', `/api/v1/nodes/${NRun}`)).status === 200, 'DELETE 运行节点 → 200')
    check((await jreq('DELETE', `/api/v1/nodes/999999`)).status === 404, 'DELETE 不存在节点 → 404')
    check((await jreq('PATCH', `/api/v1/nodes/999999`, { x: 1 })).status === 404, 'PATCH 不存在节点 → 404')
  }
}
