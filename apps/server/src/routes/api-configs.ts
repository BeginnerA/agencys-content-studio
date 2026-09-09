import { Hono } from 'hono'
import { and, asc, desc, eq, ne } from 'drizzle-orm'
import { db } from '../db'
import { apiConfigs, apiProviders } from '../db/schema'
import { resolveApiKey, writeSecret } from '../services/secrets'
import { chatComplete } from '../services/llm'
import { resolveEndpoint, getImageAdapter } from '../adapters/provider'
import { HttpError, h, idParam, notFound } from './helpers'

export const apiRoutes = new Hono()

const SERVICE_TYPES = ['llm', 'image', 'video', 'audio']

// GET /api-providers —— 供应商目录（预置 + 已建 config 关联态）
apiRoutes.get('/api-providers', h(async (c) => {
  const providers = await db.select().from(apiProviders).orderBy(asc(apiProviders.serviceType), asc(apiProviders.key))
  const configs = await db.select().from(apiConfigs)
  const byProvider = new Map<string, typeof configs[number][]>()
  for (const cfg of configs) {
    const list = byProvider.get(cfg.providerKey) ?? []
    list.push(cfg)
    byProvider.set(cfg.providerKey, list)
  }
  return c.json({
    items: providers.map((p) => ({
      key: p.key,
      name: p.name,
      serviceType: p.serviceType,
      description: p.description,
      presetModels: safeJson(p.presetModels, []),
      isActive: p.isActive === 1,
      configs: (byProvider.get(p.key) ?? []).map((cfg) => ({
        id: cfg.id,
        name: cfg.name,
        serviceType: cfg.serviceType,
        model: cfg.model,
        isDefault: cfg.isDefault === 1,
        isActive: cfg.isActive === 1,
      })),
    })),
  })
}))

// GET /api-configs —— 配置列表（key 脱敏：仅尾 4 位）
apiRoutes.get('/api-configs', h(async (c) => {
  const rows = await db.select().from(apiConfigs).orderBy(asc(apiConfigs.serviceType), desc(apiConfigs.isDefault), asc(apiConfigs.priority))
  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      providerKey: r.providerKey,
      serviceType: r.serviceType,
      name: r.name,
      baseUrl: r.baseUrl,
      apiKeyRef: r.apiKeyRef,
      apiKeyMasked: maskKey(resolveApiKey(r.apiKeyRef)),
      model: r.model,
      extra: safeJson(r.extra, {}),
      priority: r.priority,
      isDefault: r.isDefault === 1,
      isActive: r.isActive === 1,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  })
}))

// POST /api-configs —— 新建配置 {provider_key, service_type, name, base_url?, api_key?, api_key_ref?, model?, extra?, is_default?}
apiRoutes.post('/api-configs', h(async (c) => {
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const providerKey = body['provider_key']
  const serviceType = body['service_type']
  const name = body['name']
  if (typeof providerKey !== 'string' || !providerKey) throw new HttpError(400, 'bad_provider', 'provider_key 必填')
  if (!SERVICE_TYPES.includes(serviceType as string)) throw new HttpError(400, 'bad_type', `service_type 需为 ${SERVICE_TYPES.join('|')}`)
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'bad_name', 'name 必填')
  const providerRows = await db.select().from(apiProviders).where(eq(apiProviders.key, providerKey)).limit(1)
  if (!providerRows[0]) throw new HttpError(400, 'bad_provider', `供应商 ${providerKey} 不存在`)

  // 密钥写入：body.api_key 明文 → secrets.json（local）；或 api_key_ref 指向 env 变量
  let apiKeyRef = 'local'
  if (body['api_key'] !== undefined) {
    if (typeof body['api_key'] !== 'string' || !body['api_key']) throw new HttpError(400, 'bad_key', 'api_key 非法')
    writeSecret(`local:cfg:${serviceType}:${providerKey}`, body['api_key'])
    apiKeyRef = `local:cfg:${serviceType}:${providerKey}`
  } else if (typeof body['api_key_ref'] === 'string' && body['api_key_ref']) {
    apiKeyRef = body['api_key_ref']
  }
  const t = Date.now()
  const row = await db
    .insert(apiConfigs)
    .values({
      providerKey,
      serviceType,
      name: name.trim(),
      baseUrl: typeof body['base_url'] === 'string' && body['base_url'] ? body['base_url'] : null,
      apiKeyRef,
      model: typeof body['model'] === 'string' ? body['model'] : null,
      extra: body['extra'] && typeof body['extra'] === 'object' ? JSON.stringify(body['extra']) : '{}',
      priority: typeof body['priority'] === 'number' ? body['priority'] : 0,
      isDefault: body['is_default'] === true ? 1 : 0,
      isActive: 1,
      createdAt: t,
      updatedAt: t,
    })
    .returning()
  if (row[0]?.isDefault === 1) await clearOtherDefaults(row[0]!.id, serviceType as string)
  return c.json({ config: row[0] }, 201)
}))

// PUT /api-configs/:id —— 更新（同字段；api_key 传明文则覆盖）
apiRoutes.put('/api-configs/:id', h(async (c) => {
  const id = idParam(c)
  const rows = await db.select().from(apiConfigs).where(eq(apiConfigs.id, id)).limit(1)
  const cfg = rows[0]
  if (!cfg) return notFound(c, `配置 ${id}`)
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const patch: Record<string, unknown> = { updatedAt: Date.now() }
  if (body['name'] !== undefined) {
    if (typeof body['name'] !== 'string' || !body['name'].trim()) throw new HttpError(400, 'bad_name', 'name 非法')
    patch['name'] = body['name'].trim()
  }
  if (body['base_url'] !== undefined) patch['baseUrl'] = body['base_url'] ? String(body['base_url']) : null
  if (body['model'] !== undefined) patch['model'] = body['model'] ? String(body['model']) : null
  if (body['extra'] !== undefined && typeof body['extra'] === 'object') patch['extra'] = JSON.stringify(body['extra'])
  if (body['priority'] !== undefined) patch['priority'] = Number(body['priority']) || 0
  if (body['is_default'] !== undefined) patch['isDefault'] = body['is_default'] === true ? 1 : 0
  if (body['is_active'] !== undefined) patch['isActive'] = body['is_active'] === true ? 1 : 0
  if (body['api_key'] !== undefined) {
    if (typeof body['api_key'] !== 'string' || !body['api_key']) throw new HttpError(400, 'bad_key', 'api_key 非法')
    writeSecret(`local:cfg:${cfg.serviceType}:${cfg.providerKey}`, body['api_key'])
    patch['apiKeyRef'] = `local:cfg:${cfg.serviceType}:${cfg.providerKey}`
  }
  const updated = await db.update(apiConfigs).set(patch).where(eq(apiConfigs.id, id)).returning()
  if (updated[0]?.isDefault === 1) await clearOtherDefaults(id, cfg.serviceType)
  return c.json({ config: updated[0] })
}))

// DELETE /api-configs/:id —— 删除
apiRoutes.delete('/api-configs/:id', h(async (c) => {
  const id = idParam(c)
  const rows = await db.select().from(apiConfigs).where(eq(apiConfigs.id, id)).limit(1)
  if (!rows[0]) return notFound(c, `配置 ${id}`)
  await db.delete(apiConfigs).where(eq(apiConfigs.id, id))
  return c.json({ ok: true })
}))

// POST /api-configs/:id/test —— 连通性测试：llm 发 1 次最小对话；image 生成 1 张（真实计费，谨慎调用）
apiRoutes.post('/api-configs/:id/test', h(async (c) => {
  const id = idParam(c)
  const rows = await db.select().from(apiConfigs).where(eq(apiConfigs.id, id)).limit(1)
  const cfg = rows[0]
  if (!cfg) return notFound(c, `配置 ${id}`)
  const t0 = Date.now()
  if (cfg.serviceType === 'llm') {
    await chatComplete([{ role: 'user', content: 'ping' }], {
      baseUrl: cfg.baseUrl ?? '',
      apiKey: resolveApiKey(cfg.apiKeyRef),
      model: cfg.model ?? 'deepseek-chat',
    }, { maxTokens: 4, timeoutMs: 30_000 })
    return c.json({ ok: true, ms: Date.now() - t0, note: 'llm 最小对话成功' })
  }
  if (cfg.serviceType === 'image') {
    const endpoint = await resolveEndpoint('image', cfg.providerKey)
    const adapter = getImageAdapter(endpoint.providerKey)
    const img = await adapter.generate({
      prompt: 'a tiny red square on white background, minimal test',
      size: '256x256',
      model: cfg.model ?? undefined,
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      extra: endpoint.extra,
    })
    return c.json({ ok: true, ms: Date.now() - t0, kind: img.kind, note: 'image 生成成功（1 张，注意计费）' })
  }
  throw new HttpError(501, 'no_test', `${cfg.serviceType} 类型暂不支持连通测试`)
}))

/** is_default 唯一性：同 service_type 内其它配置清 default */
async function clearOtherDefaults(id: number, serviceType: string): Promise<void> {
  await db
    .update(apiConfigs)
    .set({ isDefault: 0, updatedAt: Date.now() })
    .where(and(eq(apiConfigs.serviceType, serviceType), ne(apiConfigs.id, id)))
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
