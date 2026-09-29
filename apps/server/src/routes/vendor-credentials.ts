import { Hono } from 'hono'
import { asc, eq } from 'drizzle-orm'
import { db } from '../db'
import { apiConfigs, vendorCredentials } from '../db/schema'
import { resolveApiKey, writeSecret, deleteSecret } from '../services/secrets'
import { vendorPriorityRank, SEED_VENDOR_KEYS } from '../db/seed'
import { HttpError, h, idParam, notFound } from './helpers'

export const vendorRoutes = new Hono()

// GET /vendor-credentials —— 列出在用密钥保管条目（Key 脱敏 + 关联实例数 + source 内置/自建）；
// 火山方舟/阿里千问优先展示，其余按名称原序；用户在页面删除过的内置条目（软删 isActive=0）不展示
vendorRoutes.get('/vendor-credentials', h(async (c) => {
  const credRows = (await db.select().from(vendorCredentials).orderBy(asc(vendorCredentials.name)))
    .filter((r) => r.isActive === 1)
  const rows = credRows.sort((a, b) => vendorPriorityRank(a.vendor) - vendorPriorityRank(b.vendor))
  const configs = await db.select({ id: apiConfigs.id, credentialId: apiConfigs.credentialId }).from(apiConfigs)
  const countByCredential = new Map<number, number>()
  for (const cfg of configs) {
    if (cfg.credentialId != null) {
      countByCredential.set(cfg.credentialId, (countByCredential.get(cfg.credentialId) ?? 0) + 1)
    }
  }
  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      vendor: r.vendor,
      name: r.name,
      baseUrl: r.baseUrl,
      apiKeyMasked: maskKey(resolveApiKey(r.apiKeyRef)),
      hasKey: !!resolveApiKey(r.apiKeyRef),
      extra: safeJson(r.extra, {}),
      isActive: r.isActive === 1,
      source: SEED_VENDOR_KEYS.has(r.vendor) ? 'seed' : 'user',
      configCount: countByCredential.get(r.id) ?? 0,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  })
}))

// POST /vendor-credentials —— 新建/更新密钥保管条目 {vendor, name?, api_key?, base_url?, extra?}
// vendor 已存在时视为更新（幂等 upsert 语义；命中软删行则复活）
vendorRoutes.post('/vendor-credentials', h(async (c) => {
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const vendor = body['vendor']
  if (typeof vendor !== 'string' || !vendor.trim()) throw new HttpError(400, 'bad_vendor', 'vendor 必填')
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(vendor.trim())) {
    throw new HttpError(400, 'bad_vendor', 'vendor 仅允许字母/数字/下划线/连字符，1–32 位')
  }
  const name = typeof body['name'] === 'string' && body['name'].trim() ? body['name'].trim() : vendor

  // 检查是否已存在
  const existing = await db.select().from(vendorCredentials).where(eq(vendorCredentials.vendor, vendor)).limit(1)
  if (existing[0]) {
    // 已存在 → 走更新逻辑（若曾被页面删除则复活）
    return await updateCredential(c, existing[0]!.id, body, true)
  }

  // 新建
  let apiKeyRef = 'local'
  if (body['api_key'] !== undefined) {
    if (typeof body['api_key'] !== 'string' || !body['api_key']) throw new HttpError(400, 'bad_key', 'api_key 非法')
    const ref = `local:vendor:${vendor}`
    writeSecret(ref, body['api_key'])
    apiKeyRef = ref
  }
  const t = Date.now()
  const row = await db.insert(vendorCredentials).values({
    vendor,
    name,
    apiKeyRef,
    baseUrl: typeof body['base_url'] === 'string' && body['base_url'] ? body['base_url'] : null,
    extra: body['extra'] && typeof body['extra'] === 'object' ? JSON.stringify(body['extra']) : '{}',
    isActive: 1,
    createdAt: t,
    updatedAt: t,
  }).returning()
  return c.json({ credential: formatCredential(row[0]!) }, 201)
}))

// PUT /vendor-credentials/:id —— 更新凭证
vendorRoutes.put('/vendor-credentials/:id', h(async (c) => {
  const id = idParam(c)
  const rows = await db.select().from(vendorCredentials).where(eq(vendorCredentials.id, id)).limit(1)
  if (!rows[0]) return notFound(c, `凭证 ${id}`)
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  return await updateCredential(c, id, body)
}))

// DELETE /vendor-credentials/:id —— 删除（需检查无关联实例）。内置厂商 = 软删（isActive=0，
// 重启不被 seed 补回，同名重新添加可复活）；用户自建条目 = 物理删。两者均同步删本地密钥。
vendorRoutes.delete('/vendor-credentials/:id', h(async (c) => {
  const id = idParam(c)
  const rows = await db.select().from(vendorCredentials).where(eq(vendorCredentials.id, id)).limit(1)
  const cred = rows[0]
  if (!cred) return notFound(c, `凭证 ${id}`)
  // 检查关联实例
  const linked = await db.select({ id: apiConfigs.id }).from(apiConfigs).where(eq(apiConfigs.credentialId, id)).limit(1)
  if (linked[0]) {
    throw new HttpError(400, 'has_configs', `该凭证下还有关联实例，请先解除关联或删除实例`)
  }
  // 清理密钥
  if (cred.apiKeyRef.startsWith('local:vendor:')) {
    deleteSecret(cred.apiKeyRef)
  }
  if (SEED_VENDOR_KEYS.has(cred.vendor)) {
    await db.update(vendorCredentials)
      .set({ isActive: 0, apiKeyRef: 'local', updatedAt: Date.now() })
      .where(eq(vendorCredentials.id, id))
  } else {
    await db.delete(vendorCredentials).where(eq(vendorCredentials.id, id))
  }
  return c.json({ ok: true })
}))

/** 内部：更新凭证字段（revive=true 时顺带复活软删行，供 POST upsert 新建同名条目使用） */
async function updateCredential(c: any, id: number, body: Record<string, unknown>, revive = false): Promise<Response> {
  const rows = await db.select().from(vendorCredentials).where(eq(vendorCredentials.id, id)).limit(1)
  const cred = rows[0]
  if (!cred) return notFound(c, `凭证 ${id}`)
  const patch: Record<string, unknown> = { updatedAt: Date.now() }
  if (revive && cred.isActive === 0) patch['isActive'] = 1
  if (body['name'] !== undefined) {
    if (typeof body['name'] !== 'string' || !body['name'].trim()) throw new HttpError(400, 'bad_name', 'name 非法')
    patch['name'] = body['name'].trim()
  }
  if (body['base_url'] !== undefined) patch['baseUrl'] = body['base_url'] ? String(body['base_url']) : null
  if (body['extra'] !== undefined && typeof body['extra'] === 'object') patch['extra'] = JSON.stringify(body['extra'])
  if (body['is_active'] !== undefined) patch['isActive'] = body['is_active'] === true ? 1 : 0
  if (body['api_key'] !== undefined) {
    if (typeof body['api_key'] !== 'string' || !body['api_key']) throw new HttpError(400, 'bad_key', 'api_key 非法')
    const ref = `local:vendor:${cred.vendor}`
    writeSecret(ref, body['api_key'])
    patch['apiKeyRef'] = ref
  }
  const updated = await db.update(vendorCredentials).set(patch).where(eq(vendorCredentials.id, id)).returning()
  return c.json({ credential: formatCredential(updated[0]!) })
}

function formatCredential(r: typeof vendorCredentials.$inferSelect) {
  return {
    id: r.id,
    vendor: r.vendor,
    name: r.name,
    baseUrl: r.baseUrl,
    apiKeyMasked: maskKey(resolveApiKey(r.apiKeyRef)),
    hasKey: !!resolveApiKey(r.apiKeyRef),
    extra: safeJson(r.extra, {}),
    isActive: r.isActive === 1,
    source: SEED_VENDOR_KEYS.has(r.vendor) ? 'seed' : 'user',
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 4) return '****'
  return `****${key.slice(-4)}`
}

function safeJson(s: string | null, fallback: unknown): unknown {
  if (!s) return fallback
  try { return JSON.parse(s) } catch { return fallback }
}
