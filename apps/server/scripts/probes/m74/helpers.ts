/**
 * 角色一致性探针 — 共享测试夹具与调用助手。
 *
 * 提供两件事：
 *   1. test()：把会抛异常的断言体包成一条 PASS/FAIL 计数，单条失败不中断整节；
 *   2. api()/callRaw()/sql 计数：全部经真实应用实例发 HTTP（路径自带 /api/v1 前缀），
 *      读侧统计走原生 SQL（只作读断言，不用来伪造被测状态）。
 */
import type { Checker } from '../../probe-lib'

/** 断言体包装：抛错即记一条 FAIL（带原因），成功记一条 PASS。 */
export async function test(checker: Checker, name: string, body: () => void | Promise<void>) {
  try {
    await body()
    checker.check(true, name)
  } catch (e) {
    checker.check(false, `${name}: ${(e as Error).message}`)
  }
}

/** 惰性取真实应用实例（必须在隔离环境与建库完成后加载）。 */
export async function getApp() {
  const { app } = await import('../../../src/app')
  return app
}

/** 经真实应用发一次带 /api/v1 前缀的请求（产品挂载路径，不自建路由）。 */
export async function api(path: string, init?: RequestInit): Promise<Response> {
  const app = await getApp()
  return app.request('/api/v1' + path, init)
}

/** JSON 请求体（统一 content-type）。 */
export function jsonInit(method: string, body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

/** 请求结果三件套：状态码 + 解析后的错误码 + 原文（错误文案要逐字比对，不能只看码）。 */
export interface CallResult {
  status: number
  data: any // eslint-disable-line @typescript-eslint/no-explicit-any
  code: string | null
  message: string
  body: string
}

export async function call(method: string, path: string, body?: unknown): Promise<CallResult> {
  const res = await api(path, jsonInit(method, body))
  const text = await res.text()
  let data: any = null // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    data = JSON.parse(text)
  } catch {
    /* 非 JSON 响应保留原文 */
  }
  const code = typeof data?.error?.code === 'string' ? (data.error.code as string) : null
  const message = typeof data?.error?.message === 'string' ? (data.error.message as string) : text
  return { status: res.status, data, code, message, body: text }
}

/** 取回某实体的扁平参考列（派生列是只读核对对象，经原生 SQL 读，不经被测写面）。 */
export async function flatRefIds(entityId: number): Promise<number[]> {
  const { sqlite } = await import('../../../src/db')
  const r = await sqlite.execute({ sql: 'SELECT ref_asset_ids AS v FROM characters WHERE id = ?', args: [entityId] })
  const row = r.rows[0] as { v: string } | undefined
  if (!row) return []
  try {
    const v = JSON.parse(row.v)
    return Array.isArray(v) ? v.map(Number) : []
  } catch {
    return []
  }
}

/** 原生 SQL 计数（只读断言用）。 */
export async function count(sql: string, args: Array<number | string> = []): Promise<number> {
  const { sqlite } = await import('../../../src/db')
  const r = await sqlite.execute({ sql, args })
  return Number((r.rows[0] as { n: number } | undefined)?.n ?? 0)
}

/** 原生 SQL 取行（只读断言用）。 */
export async function rowsOf<T = Record<string, unknown>>(sql: string, args: Array<number | string> = []): Promise<T[]> {
  const { sqlite } = await import('../../../src/db')
  const r = await sqlite.execute({ sql, args })
  return r.rows as unknown as T[]
}

/** 分层登记行按启用集重算出的扁平参考集（与派生同步同一口径：基准→状态→视角、同层按行号升序、去重）。 */
export async function recomputeRefIds(entityId: number): Promise<number[]> {
  const roleOrder: Record<string, number> = { base: 0, state: 1, view: 2 }
  const rows = await rowsOf<{ assetId: number; role: string; id: number }>(
    'SELECT asset_id AS assetId, role, id FROM entity_references WHERE entity_id = ? AND enabled = 1',
    [entityId],
  )
  const sorted = rows
    .filter((r) => roleOrder[r.role] !== undefined)
    .sort((a, b) => roleOrder[a.role]! - roleOrder[b.role]! || a.id - b.id)
  const out: number[] = []
  for (const r of sorted) if (!out.includes(r.assetId)) out.push(r.assetId)
  return out
}
