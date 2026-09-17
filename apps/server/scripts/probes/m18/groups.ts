/** M18[P6] groups：画布分组（CRUD + 跨组拒绝 + 解组 + 读模型）（断言体逐字搬自原 probe-m18.ts） */
import type { M18Ctx } from './ctx'

export async function run(ctx: M18Ctx): Promise<void> {
  const { check, mkProject, jreq } = ctx
  const PID = await mkProject('M18 分组')
  const C = (await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '分组画布' })).body.canvas.id
  const addN = async (cid: number, body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${cid}/nodes`, body)).body.node.id
  const N1 = await addN(C, { kind: 'gen', spec: { genKind: 'image', prompt: 'a' }, x: 100, y: 200 })
  const N2 = await addN(C, { kind: 'gen', spec: { genKind: 'image', prompt: 'b' }, x: 20, y: 40 })
  const N3 = await addN(C, { kind: 'text', spec: { text: 'c' }, x: 500, y: 500 })

  check((await jreq('POST', `/api/v1/canvases/${C}/groups`, { nodeIds: [] })).status === 400, 'groups：空 nodeIds → 400')
  const bad = await jreq('POST', `/api/v1/canvases/${C}/groups`, { nodeIds: [999999] })
  check(bad.status === 400 && bad.body?.error?.code === 'node_not_in_canvas', 'groups：节点不属本画布 → 400 node_not_in_canvas')

  const g = await jreq('POST', `/api/v1/canvases/${C}/groups`, { nodeIds: [N1, N2], title: '第一组', color: 'blue' })
  const GID = g.body?.group?.id
  check(
    g.status === 201 && GID > 0 && g.body.group.x === 20 && g.body.group.y === 40 && g.body.group.collapsed === 0,
    '建组 → 201，锚点=成员包围盒左上（20,40）',
  )
  check(g.body?.group?.title === '第一组' && g.body?.group?.color === 'blue', '建组：title/color 落库')

  const doc1 = (await jreq('GET', `/api/v1/canvases/${C}`)).body
  check(
    Array.isArray(doc1.groups) && doc1.groups.length === 1 && doc1.groups[0].id === GID && doc1.groups[0].collapsed === false,
    'doc.groups：1 组（collapsed 布尔）',
  )
  const byId = new Map<number, any>(doc1.nodes.map((n: any) => [n.id, n]))
  check(
    byId.get(N1)?.groupId === GID && byId.get(N2)?.groupId === GID && byId.get(N3)?.groupId == null,
    'doc 节点：成员 groupId 归属，非成员 null',
  )

  const dup = await jreq('POST', `/api/v1/canvases/${C}/groups`, { nodeIds: [N1, N3] })
  check(
    dup.status === 400 && dup.body?.error?.code === 'already_grouped' && String(dup.body?.error?.message ?? '').includes(String(N1)),
    '跨组拒绝：成员已属他组 → 400 列出违规',
  )

  const pCol = await jreq('PATCH', `/api/v1/canvases/${C}/groups/${GID}`, { collapsed: true })
  check(pCol.status === 200 && pCol.body?.group?.collapsed === 1, 'PATCH：collapsed=true → 1 落库')
  check((await jreq('PATCH', `/api/v1/canvases/${C}/groups/${GID}`, { title: '   ' })).status === 400, 'PATCH：空 title → 400')
  const pColor = await jreq('PATCH', `/api/v1/canvases/${C}/groups/${GID}`, { color: 'notacolor' })
  check(pColor.status === 200 && pColor.body?.group?.color === null, 'PATCH：非白名单色 → null 回退')
  check((await jreq('PATCH', `/api/v1/canvases/${C}/groups/999999`, { title: 'x' })).status === 404, 'PATCH：不存在组 → 404')

  const del = await jreq('DELETE', `/api/v1/canvases/${C}/groups/${GID}`)
  check(del.status === 200 && del.body?.ok === true, '解组 → 200 {ok}')
  const doc2 = (await jreq('GET', `/api/v1/canvases/${C}`)).body
  check(doc2.groups.length === 0 && doc2.nodes.every((n: any) => n.groupId == null), '解组：组行移除 + 成员归属清空')
  check((await jreq('DELETE', `/api/v1/canvases/${C}/groups/${GID}`)).status === 404, '解组：重复删除 → 404')

  // 空组保留（删成员节点不级联删组）
  const G2 = (await jreq('POST', `/api/v1/canvases/${C}/groups`, { nodeIds: [N3], title: '将空组' })).body.group.id
  await jreq('DELETE', `/api/v1/nodes/${N3}`)
  const doc3 = (await jreq('GET', `/api/v1/canvases/${C}`)).body
  check(doc3.groups.some((x: any) => x.id === G2), '删成员节点 → 空组保留（不级联删组）')
  const pXY = await jreq('PATCH', `/api/v1/canvases/${C}/groups/${G2}`, { x: 7, y: 9 })
  check(pXY.status === 200 && pXY.body.group.x === 7 && pXY.body.group.y === 9, '空组：锚点 x/y 可 PATCH')
}
