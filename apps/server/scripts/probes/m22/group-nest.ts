/** M22[P2] group-nest：组嵌套（服务语义 + 快照兼容）（断言体逐字搬自原 probe-m22.ts） */
import type { M22Ctx } from './ctx'

export async function run(ctx: M22Ctx): Promise<void> {
  const { check, db, proj, T0, canvases, canvasNodes, canvasGroups, eq, GroupError, createGroup, updateGroup, deleteGroup, createSnapshot, restoreSnapshot, buildCanvasDoc } = ctx
  const [cv] = await db.insert(canvases).values({ projectId: proj!.id, name: 'M22 嵌套画布', createdAt: T0, updatedAt: T0 }).returning()
  const mkNode = async (title: string, x: number, y: number): Promise<{ id: number }> => {
    const [row] = await db
      .insert(canvasNodes)
      .values({ canvasId: cv!.id, kind: 'text', title, spec: '{"text":"t"}', x, y, createdAt: T0, updatedAt: T0 })
      .returning()
    return row!
  }
  const n1 = await mkNode('N1', 100, 200)
  const n2 = await mkNode('N2', 400, 200)
  const n3 = await mkNode('N3', 100, 600)
  const n4 = await mkNode('N4', 800, 200)
  const catchCode = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      await fn()
      return 'no-error'
    } catch (err) {
      return err instanceof GroupError ? err.code : `other:${(err as Error).message}`
    }
  }

  const gA = await createGroup(cv!.id, { nodeIds: [n1.id, n2.id], title: 'A' })
  check(gA.parentId === null && gA.x === 100 && gA.y === 200, '顶层组：parentId=null + 锚点=节点包围盒左上')
  // 纯组装入（groupIds）：新组为父，已建组提升为子
  const gB = await createGroup(cv!.id, { groupIds: [gA.id], title: 'B' })
  const [gA2] = await db.select().from(canvasGroups).where(eq(canvasGroups.id, gA.id))
  check(gB.parentId === null && gA2!.parentId === gB.id, 'groupIds 装入：子组 parentId 指向新父组')
  check(gB.x === gA2!.x && gB.y === gA2!.y, '纯组锚点=子组锚点（无节点成员）')
  check((await catchCode(() => createGroup(cv!.id, { groupIds: [gA.id] }))) === 'group_already_nested', '已嵌套组再装入 → group_already_nested')
  check((await catchCode(() => createGroup(cv!.id, { groupIds: [999999] }))) === 'group_not_in_canvas', '子组不属画布 → group_not_in_canvas')
  check((await catchCode(() => createGroup(cv!.id, {}))) === 'bad_node_ids', 'nodeIds/groupIds 全空 → bad_node_ids')
  check((await catchCode(() => createGroup(cv!.id, { nodeIds: [n3.id], parentId: 999999 }))) === 'group_not_in_canvas', 'parentId 不存在 → group_not_in_canvas')
  const gC = await createGroup(cv!.id, { nodeIds: [n3.id], parentId: gB.id, title: 'C' })
  check(gC.parentId === gB.id, 'parentId 建组：直接嵌套其下')
  // 移组防环（自环 / 直接父子环 / 隔代后代环）与拓扑合法移入
  check((await catchCode(() => updateGroup(cv!.id, gB.id, { parentId: gB.id }))) === 'group_cycle', '自环：组移入自身 → group_cycle')
  check((await catchCode(() => updateGroup(cv!.id, gB.id, { parentId: gC.id }))) === 'group_cycle', '环：父组移入其直接子组 → group_cycle')
  check((await catchCode(() => updateGroup(cv!.id, gB.id, { parentId: gA.id }))) === 'group_cycle', '环：父组移入其后代组 → group_cycle')
  const movedC = await updateGroup(cv!.id, gC.id, { parentId: gA.id })
  check(movedC != null && movedC.parentId === gA.id, '正常移入：C → A（拓扑合法）')
  const liftedC = await updateGroup(cv!.id, gC.id, { parentId: null })
  check(liftedC != null && liftedC.parentId === null, '移出到顶层：parentId=null')
  check((await catchCode(() => updateGroup(cv!.id, gC.id, { parentId: 999999 }))) === 'group_not_in_canvas', '移入目标不存在 → group_not_in_canvas')
  // deleteGroup：子组提升（保守不丢组）
  await deleteGroup(cv!.id, gB.id)
  const [gA3] = await db.select().from(canvasGroups).where(eq(canvasGroups.id, gA.id))
  const gone = await db.select().from(canvasGroups).where(eq(canvasGroups.id, gB.id))
  check(gone.length === 0 && gA3!.parentId === null, 'deleteGroup：子组提升顶层（不丢组）')
  // 快照含 parentId 重放往返
  const gD = await createGroup(cv!.id, { nodeIds: [n4.id], parentId: gA.id, title: 'D' })
  const snap = await createSnapshot(cv!.id, '嵌套快照')
  await deleteGroup(cv!.id, gA.id)
  await restoreSnapshot(cv!.id, snap.id)
  const [gD2] = await db.select().from(canvasGroups).where(eq(canvasGroups.id, gD.id))
  const [gA4] = await db.select().from(canvasGroups).where(eq(canvasGroups.id, gA.id))
  const [n4After] = await db.select().from(canvasNodes).where(eq(canvasNodes.id, n4.id))
  check(gD2 != null && gD2.parentId === gA.id && gA4 != null && gA4.parentId === null, '快照恢复往返：嵌套关系（parentId）完整')
  check(n4After!.groupId === gD.id, '快照恢复：节点 groupId 归属恢复')
  // [M22 实弹补盲] buildCanvasDoc 输出 parentId（前端嵌套渲染读模型，doc.ts 投影曾漏列）
  const nestDoc = await buildCanvasDoc(cv!.id)
  const docGA = nestDoc?.groups.find((g) => g.id === gA.id)
  const docGD = nestDoc?.groups.find((g) => g.id === gD.id)
  check(docGA != null && docGA.parentId === null && docGD != null && docGD.parentId === gA.id, 'buildCanvasDoc：groups 输出含 parentId（嵌套读模型）')
}
