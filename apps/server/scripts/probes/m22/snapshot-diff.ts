/** M22[P2] snapshot-diff：diff 纯函数 + branch 重放映射（断言体逐字搬自原 probe-m22.ts） */
import type { CanvasSnapshotDoc } from '../../../src/services/creation/snapshots'
import type { M22Ctx } from './ctx'

export async function run(ctx: M22Ctx): Promise<void> {
  const { check, db, proj, T0, canvases, canvasNodes, canvasGroups, canvasEdges, eq, diffSnapshotDocs, clampDiffValue, createGroup, createSnapshot, branchSnapshot } = ctx
  // ---- 纯函数 diff ----
  const row = (o: Record<string, unknown>): Record<string, unknown> => o
  const baseDoc = {
    nodes: [row({ id: 1, title: 'A', x: 0, spec: null }), row({ id: 2, title: 'B', x: 0, spec: null })],
    edges: [row({ id: 10, from: 1, to: 2, port: 'prompt' })],
    groups: [row({ id: 20, title: 'G', parentId: null })],
  } as unknown as CanvasSnapshotDoc
  const targetDoc = {
    nodes: [row({ id: 1, title: 'A2', x: 5, spec: null }), row({ id: 3, title: 'C', x: 0, spec: null })],
    edges: [row({ id: 10, from: 1, to: 3, port: 'prompt' })],
    groups: [],
  } as unknown as CanvasSnapshotDoc
  const diff = diffSnapshotDocs(baseDoc, targetDoc)
  check(
    diff.summary.nodes.added === 1 && diff.summary.nodes.removed === 1 && diff.summary.nodes.modified === 1 &&
      diff.summary.edges.modified === 1 && diff.summary.groups.removed === 1,
    'diff summary：nodes +1/−1/~1、edges ~1、groups −1',
  )
  check(diff.nodes.added[0]!.id === 3 && diff.nodes.added[0]!.title === 'C' && diff.nodes.removed[0]!.id === 2, 'added/removed 按 id 匹配（标题携带）')
  const modN = diff.nodes.modified[0]!
  check(
    modN.id === 1 && modN.changes.length === 2 &&
      modN.changes[0]!.field === 'title' && modN.changes[0]!.before === 'A' && modN.changes[0]!.after === 'A2' &&
      modN.changes[1]!.field === 'x' && modN.changes[1]!.before === 0 && modN.changes[1]!.after === 5,
    'modified：字段级 changes（title/x，按字段名排序）',
  )
  const modE = diff.edges.modified[0]!
  check(modE.changes.some((c) => c.field === 'to' && c.before === 2 && c.after === 3), 'edge modified：to 端点字段级')
  check(diff.groups.removed[0]!.title === 'G', 'group removed 标题取 title')
  const clipped = clampDiffValue('x'.repeat(250)) as string
  check(clipped.length === 201 && clipped.endsWith('…'), '截断：250 字符 → 200 + 省略号')
  check(typeof clampDiffValue({ a: 'y'.repeat(250) }) === 'string', '对象超长 → stringify 截断为字符串')
  check(JSON.stringify(clampDiffValue({ a: 1 })) === '{"a":1}', '对象未超长 → 保留结构')
  const d2 = diffSnapshotDocs(
    { nodes: [{ id: 9, title: 'x' }], edges: [], groups: [] } as unknown as CanvasSnapshotDoc,
    { nodes: [{ id: 9, title: 'x', spec: null }], edges: [], groups: [] } as unknown as CanvasSnapshotDoc,
  )
  check(d2.nodes.modified.length === 0, 'undefined vs null 视同（旧快照缺列不误报）')

  // ---- branch 重放（db 直测）----
  const [cv] = await db.insert(canvases).values({ projectId: proj!.id, name: 'M22 分支源', createdAt: T0, updatedAt: T0 }).returning()
  const [nb1] = await db
    .insert(canvasNodes)
    .values({ canvasId: cv!.id, kind: 'text', title: 'B1', spec: '{"text":"a"}', x: 0, y: 0, createdAt: T0, updatedAt: T0 })
    .returning()
  const [nb2] = await db
    .insert(canvasNodes)
    .values({ canvasId: cv!.id, kind: 'text', title: 'B2', spec: '{"text":"b"}', x: 0, y: 0, createdAt: T0, updatedAt: T0 })
    .returning()
  const gP = await createGroup(cv!.id, { nodeIds: [nb1!.id], title: 'P' })
  const gQ = await createGroup(cv!.id, { groupIds: [gP.id], title: 'Q' })
  await db.insert(canvasEdges).values({ canvasId: cv!.id, from: nb1!.id, to: nb2!.id, port: 'prompt', createdAt: T0 })
  const snap = await createSnapshot(cv!.id, '分支点')
  const branch = await branchSnapshot(cv!.id, snap.id, '分支画布')
  check(branch != null && branch.name === '分支画布' && branch.projectId === cv!.projectId, 'branch：新画布（同项目 + 指定名）')
  const nList = await db.select().from(canvasNodes).where(eq(canvasNodes.canvasId, branch!.id))
  const gList = await db.select().from(canvasGroups).where(eq(canvasGroups.canvasId, branch!.id))
  const eList = await db.select().from(canvasEdges).where(eq(canvasEdges.canvasId, branch!.id))
  check(nList.length === 2 && gList.length === 2 && eList.length === 1, 'branch：节点/组/边行数齐全')
  const b1 = nList.find((n) => n.title === 'B1')!
  const b2 = nList.find((n) => n.title === 'B2')!
  const pG = gList.find((g) => g.title === 'P')!
  const qG = gList.find((g) => g.title === 'Q')!
  check(pG.id !== gP.id && qG.id !== gQ.id && b1.id !== nb1!.id, 'branch：全新 id 空间（无源 id 复用）')
  check(pG.parentId === qG.id && qG.parentId === null, 'branch：parentId 映射（P → 新 Q）')
  check(b1.groupId === pG.id, 'branch：节点 groupId 映射')
  check(eList[0]!.from === b1.id && eList[0]!.to === b2.id && eList[0]!.port === 'prompt', 'branch：边端点映射')
  check(b1.spec === '{"text":"a"}', 'branch：spec 原样')
  const branch2 = await branchSnapshot(cv!.id, snap.id)
  check(branch2 != null && branch2.name === 'M22 分支源 分支', 'branch：缺省名「{源名} 分支」')
  check((await branchSnapshot(cv!.id, 999999)) === null, 'branch：快照不存在 → null')
}
