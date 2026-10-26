/** probe-m66 夹具：最小项目播种（列名以 src/db/schema.ts 为准，缺列时按 NOT NULL 约束补齐） */
export async function createProject(): Promise<number> {
  const { db } = await import('../src/db')
  const { projects } = await import('../src/db/schema')
  // schema 适配：projects.created_at / updated_at 为 NOT NULL 且无默认值（其余 NOT NULL 列均有默认值），须显式填毫秒时间戳
  const now = Date.now()
  const rows = await db.insert(projects).values({ name: 'M66探针项目', createdAt: now, updatedAt: now }).returning()
  return rows[0]!.id
}
