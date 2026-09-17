/** M17[run-node]：多 run 节点批查独立派生 + 行删除宽容降级 + title/seq/坐标 + batch 移动 + copy 深拷（断言体逐字搬自原 probe-m17.ts） */
import type { M17Ctx } from './ctx'

export async function run(ctx: M17Ctx): Promise<void> {
  const { check, jreq, db, pipelineRuns, eq, PID, RUN1, RUN2, docNode } = ctx
  {
    const c1 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '运行节点' })
    const C: number = c1.body.canvas.id
    const mkNode = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${C}/nodes`, body)).body.node.id
    const NR1 = await mkNode({ kind: 'run', runId: RUN1, x: 0, y: 0 })
    const NR2 = await mkNode({ kind: 'run', runId: RUN2, x: 0, y: 100 })
    let d = await jreq('GET', `/api/v1/canvases/${C}`)
    const dn1 = docNode(d.body, NR1)
    const dn2 = docNode(d.body, NR2)
    check(
      dn1?.run?.id === RUN1 && dn1?.run?.status === 'running' && dn1?.run?.steps?.total === 3 && dn1?.run?.steps?.succeeded === 2,
      '多 run 批查：NR1 独立派生（running 2/3）',
    )
    check(
      dn2?.run?.id === RUN2 && dn2?.run?.status === 'completed' && dn2?.run?.steps?.total === 2 && dn2?.run?.steps?.succeeded === 1,
      '多 run 批查：NR2 独立派生（completed 1/2，不串）',
    )
    // run 行删除 → 宽容降级（节点保留 / run null / status null / spec 仍可读）
    await db.delete(pipelineRuns).where(eq(pipelineRuns.id, RUN2))
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    const dn2b = docNode(d.body, NR2)
    check(dn2b !== undefined && dn2b?.run === null && dn2b?.status === null && dn2b?.spec?.runId === RUN2, 'run 行删除 → 宽容降级（节点/ spec 保留，run/status null）')
    check(docNode(d.body, NR1)?.run?.id === RUN1, 'run 行删除：其他 run 节点不受影响（批查隔离）')
    // title / seq / 坐标（通用 PATCH 字段对 run 生效）
    check((await jreq('PATCH', `/api/v1/nodes/${NR2}`, { title: '巡检运行', seq: 9 })).status === 200, 'PATCH run 节点 title/seq → 200')
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    check(docNode(d.body, NR2)?.title === '巡检运行' && docNode(d.body, NR2)?.seq === 9, 'run 节点 title/seq 落库')
    const rb = await jreq('POST', `/api/v1/canvases/${C}/nodes/batch`, { updates: [{ id: NR1, x: 50, y: 60 }, { id: NR2, x: 70, y: 80 }] })
    check(rb.status === 200 && rb.body?.updated === 2, 'batch：run 节点批量移动 → {updated:2}')
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    check(docNode(d.body, NR1)?.x === 50 && docNode(d.body, NR2)?.y === 80, 'batch：run 节点坐标落库')
    // copy 深拷（spec.runId 保留 → 派生同源摘要；API 返回原始 DB 行，spec 为 JSON 字符串）
    const cp = await jreq('POST', `/api/v1/canvases/${C}/nodes/copy`, { ids: [NR1] })
    const cpSpec = JSON.parse(String(cp.body?.nodes?.[0]?.spec ?? 'null')) as { runId?: number } | null
    check(cp.status === 201 && cpSpec?.runId === RUN1, 'copy：run 节点深拷（spec.runId 保留）')
    const cpId: number = cp.body.nodes[0].id
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    check(docNode(d.body, cpId)?.run?.id === RUN1 && docNode(d.body, cpId)?.run?.steps?.total === 3, 'copy：新 run 节点派生同源摘要')
  }
}
