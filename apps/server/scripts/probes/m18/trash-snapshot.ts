/** M18[P3] trash-snapshot：回收站与快照（软删/在途取消/列表/restore/purge + 保留 id 重放/自动备份/上限/冲突 409）（断言体逐字搬自原 probe-m18.ts） */
import type { M18Ctx } from './ctx'

export async function run(ctx: M18Ctx): Promise<void> {
  const { check, db, mkProject, mkAsset, jreq, genTasks, inArray, canvases, canvasNodes, canvasEdges, canvasSnapshots, eq, T0 } = ctx
  const PID = await mkProject('M18 安全')
  const mkCanvas = async (name: string): Promise<number> =>
    (await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name })).body.canvas.id
  const mkNode = async (canvasId: number, body: unknown): Promise<number> =>
    (await jreq('POST', `/api/v1/canvases/${canvasId}/nodes`, body)).body.node.id

  // ---------- C1：快照主体（asset→compose 边 + 任务挂靠） ----------
  const C1 = await mkCanvas('主画布')
  const AV = await mkAsset(PID, 'video', '快照视频', { duration: 1 })
  const NAV = await mkNode(C1, { kind: 'asset', assetId: AV, x: 0, y: 0 })
  const NC = await mkNode(C1, { kind: 'gen', spec: { genKind: 'compose', resolution: '160x120' }, x: 300, y: 0 })
  const e1 = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: NAV, to: NC, port: 'video' })
  const EID = e1.body.edge.id
  const TASK = (
    await db
      .insert(genTasks)
      .values({ projectId: PID, runId: null, stepId: null, canvasNodeId: NC, kind: 'compose', params: '{}', status: 'succeeded', createdAt: T0, updatedAt: T0 })
      .returning()
  )[0]!.id

  // ---------- C2：回收站全链（软删 / 在途取消 / 列表 / restore / purge） ----------
  const C2 = await mkCanvas('待删画布')
  const N2 = await mkNode(C2, { kind: 'gen', spec: { genKind: 'image', prompt: 'x' }, x: 0, y: 0 })
  const mkTask = async (status: string): Promise<number> =>
    (
      await db
        .insert(genTasks)
        .values({ projectId: PID, runId: null, stepId: null, canvasNodeId: N2, kind: 'image', params: '{}', status, createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!.id
  const TP = await mkTask('pending')
  const TQ = await mkTask('processing')

  const del = await jreq('DELETE', `/api/v1/canvases/${C2}`)
  check(del.status === 200 && del.body?.mode === 'trashed' && typeof del.body?.deletedAt === 'number' && del.body?.cancelled === 2, 'DELETE → 软删（mode=trashed / cancelled=2）')
  const tsk = await db.select().from(genTasks).where(inArray(genTasks.id, [TP, TQ]))
  check(tsk.length === 2 && tsk.every((t) => t.status === 'cancelled' && t.errorMsg === 'user cancelled' && t.completedAt != null), '在途任务自动取消（pending/processing → cancelled + errorMsg）')
  const listA = await jreq('GET', `/api/v1/projects/${PID}/canvases`)
  check(!(listA.body?.items ?? []).some((i: any) => i.id === C2), '默认列表排除已删画布')
  const listT = await jreq('GET', `/api/v1/projects/${PID}/canvases?trash=1`)
  const tItem = (listT.body?.items ?? []).find((i: any) => i.id === C2)
  check(!!tItem && typeof tItem.deletedAt === 'number' && tItem.nodeCount === 1, 'trash 列表：含 deletedAt + nodeCount（1）')
  check((await jreq('GET', `/api/v1/canvases/${C2}`)).status === 404, '已删画布 doc → 404')
  check((await jreq('PATCH', `/api/v1/canvases/${C2}`, { name: 'x' })).status === 404, '已删画布 PATCH → 404')
  check((await jreq('POST', `/api/v1/canvases/${C2}/nodes`, { kind: 'text', spec: { text: 'x' }, x: 0, y: 0 })).status === 404, '已删画布建节点 → 404')
  check((await jreq('GET', `/api/v1/canvases/${C2}/snapshots`)).status === 404, '已删画布快照列表 → 404')
  check((await jreq('DELETE', `/api/v1/canvases/${C2}`)).status === 404, '二次 DELETE（已在回收站）→ 404')

  const rActive = await jreq('POST', `/api/v1/canvases/${C1}/restore`, {})
  check(rActive.status === 400 && rActive.body?.error?.code === 'bad_state', 'restore 活跃画布 → 400 bad_state')
  const rr = await jreq('POST', `/api/v1/canvases/${C2}/restore`, {})
  check(rr.status === 200 && rr.body?.canvas?.deletedAt === null, 'restore → 200（已删→deletedAt=null）')
  check((await jreq('GET', `/api/v1/canvases/${C2}`)).status === 200, '恢复后 doc 可读（200）')
  const listB = await jreq('GET', `/api/v1/projects/${PID}/canvases`)
  check((listB.body?.items ?? []).some((i: any) => i.id === C2), '恢复后回默认列表')
  check((await jreq('POST', '/api/v1/canvases/999999/restore', {})).status === 404, 'restore 不存在 → 404')
  const pActive = await jreq('POST', `/api/v1/canvases/${C1}/purge`, {})
  check(pActive.status === 400 && pActive.body?.error?.code === 'bad_state', 'purge 活跃画布 → 400 bad_state')
  await jreq('DELETE', `/api/v1/canvases/${C2}`)
  const pg = await jreq('POST', `/api/v1/canvases/${C2}/purge`, {})
  check(pg.status === 200, '先软删后 purge → 200')
  check((await db.select().from(canvases).where(eq(canvases.id, C2))).length === 0, 'purge：canvases 行已删')
  check((await db.select().from(canvasNodes).where(eq(canvasNodes.canvasId, C2))).length === 0, 'purge 级联：canvas_nodes 零行')
  check((await db.select().from(canvasEdges).where(eq(canvasEdges.canvasId, C2))).length === 0, 'purge 级联：canvas_edges 零行')
  check((await db.select().from(genTasks).where(inArray(genTasks.id, [TP, TQ]))).length === 2, 'purge 留痕：gen_tasks 行保留（2）')
  check((await jreq('POST', `/api/v1/canvases/${C2}/purge`, {})).status === 404, '重复 purge → 404')
  check((await jreq('POST', '/api/v1/canvases/999999/purge', {})).status === 404, 'purge 不存在 → 404')

  // ---------- C1 快照：创建 / 列表 / 默认 label / 保留 id 重放 / 自动备份 ----------
  const s1 = await jreq('POST', `/api/v1/canvases/${C1}/snapshots`, { label: '基线' })
  check(s1.status === 201 && s1.body?.snapshot?.label === '基线' && s1.body?.snapshot?.id > 0, '快照创建 → 201（label=基线）')
  const SID = s1.body.snapshot.id
  const ls1 = await jreq('GET', `/api/v1/canvases/${C1}/snapshots`)
  const it1 = (ls1.body?.items ?? [])[0]
  check(ls1.status === 200 && ls1.body?.items?.length === 1 && it1?.nodeCount === 2 && it1?.edgeCount === 1 && it1?.groupCount === 0 && it1?.doc === undefined, '快照列表：统计 node=2/edge=1/group=0（不含 doc）')
  const s2 = await jreq('POST', `/api/v1/canvases/${C1}/snapshots`, {})
  check(s2.status === 201 && s2.body?.snapshot?.label === '快照 2', '默认 label = 「快照 N」')

  await jreq('POST', `/api/v1/canvases/${C1}/nodes/delete`, { ids: [NC] })
  check((await jreq('GET', `/api/v1/canvases/${C1}`)).body?.nodes?.length === 1, '改乱：删除节点后 doc 仅剩 1')
  const r1 = await jreq('POST', `/api/v1/canvases/${C1}/snapshots/${SID}/restore`, {})
  check(r1.status === 200 && r1.body?.ok === true && r1.body?.restored?.nodes === 2 && r1.body?.restored?.edges === 1 && r1.body?.restored?.groups === 0, '恢复 → 200（restored nodes:2/edges:1/groups:0）')
  const docBack = await jreq('GET', `/api/v1/canvases/${C1}`)
  const nodeIds = new Set((docBack.body?.nodes ?? []).map((n: any) => n.id))
  const edgeIds = (docBack.body?.edges ?? []).map((e: any) => e.id)
  check(nodeIds.has(NAV) && nodeIds.has(NC), '保留 id 重放：节点 id 原样回插（含已删的 NC）')
  check(edgeIds.length === 1 && edgeIds[0] === EID, '保留 id 重放：边 id 原样（EID）')
  const claim = await db
    .select({ nid: canvasNodes.id })
    .from(genTasks)
    .innerJoin(canvasNodes, eq(genTasks.canvasNodeId, canvasNodes.id))
    .where(eq(genTasks.id, TASK))
  check(claim.length === 1 && claim[0]!.nid === NC, '任务历史认领：gen_tasks.canvasNodeId 仍指向回插节点（不孤儿）')
  const ls2 = await jreq('GET', `/api/v1/canvases/${C1}/snapshots`)
  const backupItem = (ls2.body?.items ?? []).find((i: any) => i.id === r1.body.backupSnapshotId)
  check(!!backupItem && String(backupItem.label).includes('恢复前备份'), '恢复前自动备份快照已创建（label 含「恢复前备份」）')

  // ---------- 冲突 409：快照行 id 被他画布显式占用（先释放 C1 的 NAV id → C3 直插占用） ----------
  await jreq('POST', `/api/v1/canvases/${C1}/nodes/delete`, { ids: [NAV] })
  const docPre = await jreq('GET', `/api/v1/canvases/${C1}`)
  check(docPre.body?.nodes?.length === 1 && docPre.body?.edges?.length === 0, '冲突预置：删 NAV 后 doc 1 节点 0 边')
  const C3 = await mkCanvas('占用画布')
  await db
    .insert(canvasNodes)
    .values({ id: NAV, canvasId: C3, kind: 'gen', spec: JSON.stringify({ genKind: 'image', prompt: '占位' }), x: 0, y: 0, createdAt: T0, updatedAt: T0 })
  const r409 = await jreq('POST', `/api/v1/canvases/${C1}/snapshots/${SID}/restore`, {})
  check(r409.status === 409 && r409.body?.error?.code === 'conflict', '冲突：快照行 id 被他画布占用 → 409 conflict')
  const doc409 = await jreq('GET', `/api/v1/canvases/${C1}`)
  check(doc409.body?.nodes?.length === 1 && doc409.body?.edges?.length === 0, '409 事务回滚：原文档零变动（1 节点 0 边）')

  // ---------- 快照删除（域限定） ----------
  const delS2 = await jreq('DELETE', `/api/v1/canvases/${C1}/snapshots/${s2.body.snapshot.id}`)
  check(delS2.status === 200, '快照 DELETE → 200')
  check((await jreq('DELETE', `/api/v1/canvases/${C1}/snapshots/${s2.body.snapshot.id}`)).status === 404, '已删快照再删 → 404')

  // ---------- C4：上限 20（手动 400 / auto 驱逐最旧） ----------
  const C4 = await mkCanvas('上限画布')
  const N4 = await mkNode(C4, { kind: 'gen', spec: { genKind: 'image', prompt: 'x' }, x: 0, y: 0 })
  const s4 = await jreq('POST', `/api/v1/canvases/${C4}/snapshots`, { label: 'S1' })
  check(s4.status === 201, '上限画布：首个快照 201')
  const fill = await db
    .insert(canvasSnapshots)
    .values(
      Array.from({ length: 19 }, (_, k) => ({ canvasId: C4, label: `S${k + 2}`, doc: JSON.stringify({ nodes: [], edges: [], groups: [] }), createdAt: T0 + k + 2 })),
    )
    .returning({ id: canvasSnapshots.id })
  const oldestFillId = fill[0]!.id
  const s21 = await jreq('POST', `/api/v1/canvases/${C4}/snapshots`, {})
  check(s21.status === 400 && String(s21.body?.error?.message ?? '').includes('上限'), '上限 20：手动创建满额 → 400（提示清理）')
  const delS1 = await jreq('DELETE', `/api/v1/canvases/${C4}/snapshots/${s4.body.snapshot.id}`)
  check(delS1.status === 200, '满额删除一条 → 200')
  const sx = await jreq('POST', `/api/v1/canvases/${C4}/snapshots`, { label: '回位' })
  check(sx.status === 201, '腾位后重建 → 201（回 20）')
  const r5 = await jreq('POST', `/api/v1/canvases/${C4}/snapshots/${sx.body.snapshot.id}/restore`, {})
  check(r5.status === 200 && r5.body?.restored?.nodes === 1, '满额 restore：auto 备份驱逐最旧不阻断（restored.nodes=1）')
  const ls5 = await jreq('GET', `/api/v1/canvases/${C4}/snapshots`)
  check(ls5.body?.items?.length === 20, 'C4：auto 备份后总量仍为 20（驱逐最旧）')
  check(!(ls5.body?.items ?? []).some((i: any) => i.id === oldestFillId), 'C4：最旧快照被驱逐')
  check((ls5.body?.items ?? []).some((i: any) => String(i.label).includes('恢复前备份')), 'C4：恢复前备份快照存在')
  check((await jreq('GET', `/api/v1/canvases/${C4}`)).body?.nodes?.[0]?.id === N4, 'C4 恢复后节点 id 保留（N4）')

  // ---------- 错误族与域限定 ----------
  check((await jreq('DELETE', `/api/v1/canvases/${C4}/snapshots/${SID}`)).status === 404, '快照删除域限定：他画布快照 → 404')
  check((await jreq('GET', '/api/v1/canvases/999999/snapshots')).status === 404, '画布不存在 → 快照列表 404')
  check((await jreq('POST', '/api/v1/canvases/999999/snapshots', {})).status === 404, '画布不存在 → 创建快照 404')
  check((await jreq('POST', `/api/v1/canvases/${C1}/snapshots/999999/restore`, {})).status === 404, '快照不存在 → restore 404')
  check((await jreq('DELETE', `/api/v1/canvases/${C1}/snapshots/999999`)).status === 404, '快照不存在 → DELETE 404')
}
