/** M18[P1] p1-schema：迁移与兜底（列/表/索引 + schema 读写冒烟 + initDb 幂等）（断言体逐字搬自原 probe-m18.ts） */
import type { M18Ctx } from './ctx'

export async function run(ctx: M18Ctx): Promise<void> {
  const { check, db, sqlite, T0, initDb, canvasGroups, canvasSnapshots, eq } = ctx
  const cvCols = await sqlite.execute("PRAGMA table_info('canvases')")
  const cvNames = new Set((cvCols.rows as unknown as Array<{ name: string }>).map((r) => r.name))
  check(cvNames.has('deleted_at'), 'canvases.deleted_at 列存在（ensureColumn）')
  const cnCols = await sqlite.execute("PRAGMA table_info('canvas_nodes')")
  const cnNames = new Set((cnCols.rows as unknown as Array<{ name: string }>).map((r) => r.name))
  check(cnNames.has('group_id'), 'canvas_nodes.group_id 列存在（ensureColumn）')

  const tbl = async (name: string): Promise<number> => {
    const r = await sqlite.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`)
    return r.rows.length
  }
  const idx = async (name: string): Promise<number> => {
    const r = await sqlite.execute(`SELECT name FROM sqlite_master WHERE type='index' AND name='${name}'`)
    return r.rows.length
  }
  check((await tbl('canvas_groups')) === 1, 'canvas_groups 表存在（ensureTable）')
  check((await tbl('canvas_snapshots')) === 1, 'canvas_snapshots 表存在（ensureTable）')
  check((await idx('idx_canvas_groups_canvas')) === 1, 'canvas_groups 索引存在')
  check((await idx('idx_canvas_snapshots_canvas')) === 1, 'canvas_snapshots 索引存在')

  // ---- schema 读写冒烟（drizzle 导出直用）----
  const [g] = await db.insert(canvasGroups).values({ canvasId: 1, title: '组甲', createdAt: T0 }).returning()
  check(g!.collapsed === 0 && g!.x === 0 && g!.color === null, 'canvas_groups 插入默认值（collapsed=0 / x=0 / color=null）')
  const [gUp] = await db
    .update(canvasGroups)
    .set({ collapsed: 1, title: '组乙', color: 'blue' })
    .where(eq(canvasGroups.id, g!.id))
    .returning()
  check(gUp!.collapsed === 1 && gUp!.title === '组乙' && gUp!.color === 'blue', 'canvas_groups PATCH 持久化（collapsed/title/color）')

  const [s] = await db
    .insert(canvasSnapshots)
    .values({ canvasId: 1, label: '冒烟', doc: JSON.stringify({ nodes: [], edges: [], groups: [] }), createdAt: T0 })
    .returning()
  const sRows = await db.select().from(canvasSnapshots).where(eq(canvasSnapshots.id, s!.id))
  check(sRows.length === 1 && JSON.parse(sRows[0]!.doc).nodes.length === 0, 'canvas_snapshots 插入/读回（doc JSON 往返）')

  // ---- initDb 幂等：二次执行（ensureX 全 no-op + migrate 跳过）----
  await initDb()
  check(true, 'initDb 二次执行无异常（幂等）')

  // 清理冒烟行
  await db.delete(canvasSnapshots).where(eq(canvasSnapshots.id, s!.id))
  await db.delete(canvasGroups).where(eq(canvasGroups.id, g!.id))
}
