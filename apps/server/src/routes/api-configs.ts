import { Hono } from 'hono'
import { and, asc, desc, eq, ne } from 'drizzle-orm'
import { db } from '../db'
import { apiConfigs, apiProviders } from '../db/schema'
import { resolveApiKey, writeSecret } from '../services/secrets'
import { chatComplete, providerDefaultUrl } from '../services/llm'
import { resolveEndpoint, getImageAdapter } from '../adapters/provider'
import { synthSpeech } from '../services/tts'
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
      defaultUrl: p.defaultUrl,
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

// POST /api-configs/fetch-models —— 在线拉取供应商可用模型目录（OpenAI 兼容 GET {baseUrl}/models）
// body: { provider_key, base_url?, api_key?, config_id? }
// 端点/密钥优先级：显式传参 > 编辑实例存量（config_id）> 目录 defaultUrl；无 key 亦尝试（部分网关目录公开）。
// 在线失败 / 为空 → 回退目录 presetModels，并在 note 中说明原因。
apiRoutes.post('/api-configs/fetch-models', h(async (c) => {
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const providerKey = body['provider_key']
  if (typeof providerKey !== 'string' || !providerKey) throw new HttpError(400, 'bad_provider', 'provider_key 必填')
  const providerRows = await db.select().from(apiProviders).where(eq(apiProviders.key, providerKey)).limit(1)
  const provider = providerRows[0]
  if (!provider) throw new HttpError(400, 'bad_provider', `供应商 ${providerKey} 不存在`)
  const preset = (safeJson(provider.presetModels, []) as unknown[]).filter(
    (m): m is string => typeof m === 'string' && !!m,
  )

  let baseUrl = typeof body['base_url'] === 'string' && body['base_url'].trim() ? body['base_url'].trim() : ''
  let apiKey = typeof body['api_key'] === 'string' && body['api_key'].trim() ? body['api_key'].trim() : ''
  const configId = typeof body['config_id'] === 'number' ? body['config_id'] : null
  if (configId !== null) {
    const cfgRows = await db.select().from(apiConfigs).where(eq(apiConfigs.id, configId)).limit(1)
    const cfg = cfgRows[0]
    if (cfg) {
      if (!baseUrl) baseUrl = cfg.baseUrl?.trim() ?? ''
      if (!apiKey) apiKey = resolveApiKey(cfg.apiKeyRef) || ''
    }
  }
  if (!baseUrl) baseUrl = provider.defaultUrl?.trim() ?? ''

  let liveError = ''
  let models: string[] = []
  if (!baseUrl) {
    liveError = '端点未配置（实例与目录均无 baseUrl）'
  } else {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: controller.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        liveError = `HTTP ${res.status}${text ? ` ${text.slice(0, 160)}` : ''}`
      } else {
        models = normalizeModelIds(await res.json().catch(() => null))
      }
    } catch (e) {
      liveError = e instanceof Error ? e.message : String(e)
    } finally {
      clearTimeout(timer)
    }
  }
  if (models.length > 0) {
    // 预置模型置顶，其余字母序（网关混合目录下常用项优先可见）
    const set = new Set(models)
    const head: string[] = []
    for (const m of preset) if (set.has(m)) head.push(m)
    const headSet = new Set(head)
    const rest = models.filter((m) => !headSet.has(m)).sort((a, b) => a.localeCompare(b))
    return c.json({ models: [...head, ...rest].slice(0, 800), source: 'live' })
  }
  return c.json({
    models: preset,
    source: 'preset',
    note: liveError ? `在线目录获取失败（${liveError.slice(0, 200)}），已回退预置列表` : '在线目录为空，已回退预置列表',
  })
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
    // base_url 留空 → 供应商目录 defaultUrl 兜底（与 image 分支 resolveEndpoint 行为对齐）
    const baseUrl = (cfg.baseUrl?.trim() || (await providerDefaultUrl(cfg.providerKey))).replace(/\/+$/, '')
    await chatComplete([{ role: 'user', content: 'ping' }], {
      baseUrl,
      apiKey: resolveApiKey(cfg.apiKeyRef),
      model: cfg.model ?? 'deepseek-chat',
    }, { maxTokens: 4, timeoutMs: 30_000, allowReasoningOnly: true })
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
  if (cfg.serviceType === 'audio') {
    // 真实合成 1 句最短音频（成本极低，等价 llm ping）；音色尊重实例 extra.voice（如 SiliconFlow "模型:音色" 格式）
    const extra = safeJson(cfg.extra, {}) as Record<string, unknown>
    const voice = typeof extra['voice'] === 'string' && extra['voice'] ? extra['voice'] : undefined
    const buf = await synthSpeech('ping', {
      providerKey: cfg.providerKey,
      baseUrl: (cfg.baseUrl?.trim() || (await providerDefaultUrl(cfg.providerKey))).replace(/\/+$/, ''),
      apiKey: resolveApiKey(cfg.apiKeyRef),
      model: cfg.model ?? 'tts-1',
      voice,
    }, { voice, timeoutMs: 30_000 })
    return c.json({ ok: true, ms: Date.now() - t0, bytes: buf.byteLength, voice: voice ?? 'alloy', note: '语音合成成功（1 句，注意计费）' })
  }
  if (cfg.serviceType === 'video') {
    throw new HttpError(501, 'no_test', '视频生成需轮询且成本高，请用真实 run 验证（勿用连通测试触发计费）')
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

/** 兼容三种模型目录形态：[{id}] / {data:[{id}]} / {models:[{id}|'id']} */
function normalizeModelIds(json: unknown): string[] {
  let arr: unknown[] = []
  if (Array.isArray(json)) {
    arr = json
  } else if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>
    if (Array.isArray(obj['data'])) arr = obj['data'] as unknown[]
    else if (Array.isArray(obj['models'])) arr = obj['models'] as unknown[]
  }
  const ids = new Set<string>()
  for (const item of arr) {
    const id =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object'
          ? (item as Record<string, unknown>)['id'] ?? (item as Record<string, unknown>)['name']
          : null
    if (typeof id === 'string' && id.trim()) ids.add(id.trim())
  }
  return [...ids]
}
