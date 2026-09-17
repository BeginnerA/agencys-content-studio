/** M22[P0] schema：parent_id 列就绪 + 读写往返（断言体逐字搬自原 probe-m22.ts） */
import type { M22Ctx } from './ctx'

export async function run(ctx: M22Ctx): Promise<void> {
  const { check, sqlite, db, proj, T0, canvases, canvasGroups } = ctx
  const cols = await sqlite.execute("PRAGMA table_info('canvas_groups')")
  const names = new Set((cols.rows as unknown as Array<{ name: string }>).map((r) => r.name))
  check(names.has('parent_id'), 'canvas_groups.parent_id 列就绪（建表带列 / ensureColumn 双路径）')

  const [cv] = await db.insert(canvases).values({ projectId: proj!.id, name: 'M22 画布', createdAt: T0, updatedAt: T0 }).returning()
  const [g1] = await db.insert(canvasGroups).values({ canvasId: cv!.id, title: '父组', createdAt: T0 }).returning()
  const [g2] = await db.insert(canvasGroups).values({ canvasId: cv!.id, title: '子组', parentId: g1!.id, createdAt: T0 }).returning()
  check(g1!.parentId === null && g2!.parentId === g1!.id, '组嵌套读写往返（顶层 NULL / 子组指向父 id）')
}
