import { Hono } from 'hono'
import { and, asc, count, desc, eq, inArray, ne } from 'drizzle-orm'
import { db } from '../db'
import { apiConfigs, apiProviders, vendorCredentials } from '../db/schema'
import { deleteSecret, resolveApiKey, writeSecret } from '../services/secrets'
import { vendorPriorityRank } from '../db/seed'
import { providerDefaultUrl } from '../services/llm'
import { resolveVideoCaps } from '../adapters/video-capabilities'
import { resolveExtraSchema } from '../adapters/extra-params'
import { resolveModelPricing, type PricingServiceType } from '../adapters/pricing-capabilities'
// 连通测试用例 + 模型目录拉取直连 kit（协议实现与用例服务已抽包，adapters/ 下不再有对应实现文件）
import { fetchModelList, listMusicAdapterKeys, testConnection } from '@agencys/ai-provider-kit'
import { defaultTtsModel, synthSpeech } from '../services/tts'
import { HttpError, h, idParam, notFound } from './helpers'

export const apiRoutes = new Hono()

const SERVICE_TYPES = ['llm', 'image', 'video', 'audio', 'music']

/**
 * 提供零计费连通探针的视频供应商（其余视频供应商如 minimax_video 仅能用真实 run 验证）。
 * /api-providers 的 testable 能力位与下方 /:id/test 视频分支的探针路由共用，需两处同步维护。
 */
const TESTABLE_VIDEO_PROVIDER_KEYS = new Set([
  'aliyun_bailian_video',
  'volcengine_video',
])

/** 实例是否支持「测试连接」：llm/image/audio/music 恒可（走真实最小生成/合成 ping，music 覆盖面 = kit 音乐注册表已接入供应商）；video 仅上表探针供应商。 */
const TESTABLE_MUSIC_PROVIDER_KEYS = new Set(listMusicAdapterKeys())
function isConfigTestable(serviceType: string, providerKey: string): boolean {
  if (serviceType === 'video') return TESTABLE_VIDEO_PROVIDER_KEYS.has(providerKey)
  if (serviceType === 'music') return TESTABLE_MUSIC_PROVIDER_KEYS.has(providerKey)
  return true
}

// GET /api-providers —— 供应商目录（预置 + 已建 config 关联态；火山方舟/阿里千问优先展示，其余保持原序）
apiRoutes.get('/api-providers', h(async (c) => {
  const providerRows = await db.select().from(apiProviders).orderBy(asc(apiProviders.serviceType), asc(apiProviders.key))
  const providers = providerRows.sort((a, b) => vendorPriorityRank(a.vendor) - vendorPriorityRank(b.vendor))
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
      vendor: p.vendor,
      description: p.description,
      defaultUrl: p.defaultUrl,
      presetModels: safeJson(p.presetModels, []),
      isActive: p.isActive === 1,
      testable: isConfigTestable(p.serviceType, p.key),
      configs: (byProvider.get(p.key) ?? []).map((cfg) => ({
        id: cfg.id,
        name: cfg.name,
        serviceType: cfg.serviceType,
        model: cfg.model,
        credentialId: cfg.credentialId,
        isDefault: cfg.isDefault === 1,
        isActive: cfg.isActive === 1,
      })),
    })),
  })
}))

// GET /api-configs —— 配置列表（key 脱敏：仅尾 4 位）
apiRoutes.get('/api-configs', h(async (c) => {
  const rows = await db.select().from(apiConfigs).orderBy(asc(apiConfigs.serviceType), desc(apiConfigs.isDefault), asc(apiConfigs.priority))
  // 批量查询关联凭证信息
  const credIds = [...new Set(rows.map((r) => r.credentialId).filter((id): id is number => id != null))]
  const creds = credIds.length > 0
    ? await db.select().from(vendorCredentials).where(inArray(vendorCredentials.id, credIds))
    : []
  const credMap = new Map(creds.map((cr) => [cr.id, cr]))
  return c.json({
    items: rows.map((r) => {
      const cred = r.credentialId != null ? credMap.get(r.credentialId) : null
      return {
        id: r.id,
        providerKey: r.providerKey,
        serviceType: r.serviceType,
        credentialId: r.credentialId,
        credentialVendor: cred?.vendor ?? null,
        credentialName: cred?.name ?? null,
        name: r.name,
        baseUrl: r.baseUrl,
        apiKeyRef: r.apiKeyRef,
        apiKeyMasked: maskKey(cred ? resolveApiKey(cred.apiKeyRef) : resolveApiKey(r.apiKeyRef)),
        model: r.model,
        extra: safeJson(r.extra, {}),
        pricing: safeJson(r.pricing, {}),
        priority: r.priority,
        isDefault: r.isDefault === 1,
        isActive: r.isActive === 1,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }
    }),
  })
}))

// POST /api-configs —— 新建配置 {provider_key, service_type, name, credential_id?, base_url?, api_key?, api_key_ref?, model?, extra?, pricing?, is_default?}
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

  // credential_id 优先；否则回退到 per-instance key 逻辑
  const credentialId = typeof body['credential_id'] === 'number' ? body['credential_id'] : null
  let apiKeyRef = 'local'
  let pendingApiKey: string | null = null
  if (!credentialId) {
    // 无凭证关联：api_key 明文留到插入后按「实例 id 专属槽」写入（见下），避免同供应商多实例互相覆盖
    if (body['api_key'] !== undefined) {
      if (typeof body['api_key'] !== 'string' || !body['api_key']) throw new HttpError(400, 'bad_key', 'api_key 非法')
      pendingApiKey = body['api_key']
    } else if (typeof body['api_key_ref'] === 'string' && body['api_key_ref']) {
      apiKeyRef = body['api_key_ref']
    }
  }
  const t = Date.now()
  const row = await db
    .insert(apiConfigs)
    .values({
      providerKey,
      serviceType,
      credentialId,
      name: name.trim(),
      baseUrl: typeof body['base_url'] === 'string' && body['base_url'] ? body['base_url'] : null,
      apiKeyRef,
      model: typeof body['model'] === 'string' ? body['model'] : null,
      extra: body['extra'] && typeof body['extra'] === 'object' ? JSON.stringify(body['extra']) : '{}',
      pricing: body['pricing'] && typeof body['pricing'] === 'object' ? JSON.stringify(body['pricing']) : '{}',
      priority: typeof body['priority'] === 'number' ? body['priority'] : 0,
      isDefault: body['is_default'] === true ? 1 : 0,
      isActive: 1,
      createdAt: t,
      updatedAt: t,
    })
    .returning()
  // 实例级明文 Key：取得自增 id 后写入 id 专属密钥槽并回填 ref（同供应商多实例互不覆盖）
  const created = row[0]
  if (created && pendingApiKey) {
    const ref = `local:cfg:${serviceType}:${providerKey}:${created.id}`
    writeSecret(ref, pendingApiKey)
    await db.update(apiConfigs).set({ apiKeyRef: ref, updatedAt: Date.now() }).where(eq(apiConfigs.id, created.id))
    created.apiKeyRef = ref
  }
  if (created?.isDefault === 1) await clearOtherDefaults(created.id, serviceType as string)
  return c.json({ config: created }, 201)
}))

// POST /api-configs/fetch-models —— 在线拉取供应商可用模型目录（协议分派与预置回退由 kit services/fetch-models 承担）
// body: { provider_key, base_url?, api_key?, config_id?, credential_id? }
// 端点/密钥优先级：显式传参 > 编辑实例存量（config_id）> 凭证（credential_id）> 目录 defaultUrl。零写库。
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

  // 端点/密钥优先级：显式传参 > 编辑实例存量（config_id）> 凭证（credential_id）> 目录 defaultUrl
  let baseUrl = typeof body['base_url'] === 'string' && body['base_url'].trim() ? body['base_url'].trim() : ''
  let apiKey = typeof body['api_key'] === 'string' && body['api_key'].trim() ? body['api_key'].trim() : ''
  const configId = typeof body['config_id'] === 'number' ? body['config_id'] : null
  if (configId !== null) {
    const cfgRows = await db.select().from(apiConfigs).where(eq(apiConfigs.id, configId)).limit(1)
    const cfg = cfgRows[0]
    if (cfg) {
      // 密钥/端点解析须凭证感知：共享凭证场景下实例 apiKeyRef 可能仍为 'local'（无 Key），
      // 真实密钥存于 vendor_credentials.apiKeyRef —— 与连通测试 resolveConfigApiKey 同源，
      // 否则在线拉取会漏掉 Authorization 头导致 401（如阿里千问 compatible-mode）。
      if (!apiKey) apiKey = await resolveConfigApiKey(cfg)
      if (!baseUrl) baseUrl = await resolveConfigBaseUrl(cfg)
    }
  }
  // 新建实例尚未落库（无 config_id）：Key 存于前端所选供应商凭证 → 直接按 credential_id 解析。
  const credentialId = typeof body['credential_id'] === 'number' ? body['credential_id'] : null
  if (credentialId !== null && (!apiKey || !baseUrl)) {
    const credRows = await db.select().from(vendorCredentials).where(eq(vendorCredentials.id, credentialId)).limit(1)
    const cred = credRows[0]
    if (cred) {
      if (!apiKey) apiKey = resolveApiKey(cred.apiKeyRef) || ''
      if (!baseUrl) baseUrl = cred.baseUrl?.trim() ?? ''
    }
  }
  if (!baseUrl) baseUrl = provider.defaultUrl?.trim() ?? ''

  // 协议分派（DashScope 原生 / OpenAI 兼容）+ 归一 + 预置回退 + 排序上限：交由 kit fetchModelList 服务
  const result = await fetchModelList({
    providerKey,
    serviceType: provider.serviceType,
    baseUrl,
    apiKey,
    presetModels: preset,
  })
  return c.json(result)
}))

// GET /api-configs/video-caps?provider_key=&model= —— 视频模型能力单一真源表只读查询
// 命中：{ supported:true, caps }（前端据此自动背书、去「已核实」勾选）；未命中：{ supported:false }（回退手填声明）。
apiRoutes.get('/api-configs/video-caps', h(async (c) => {
  const providerKey = c.req.query('provider_key') ?? ''
  const model = c.req.query('model') ?? ''
  if (!providerKey) throw new HttpError(400, 'bad_provider', 'provider_key 必填')
  const caps = resolveVideoCaps(providerKey, model)
  if (!caps) return c.json({ supported: false, providerKey, model })
  return c.json({ supported: true, providerKey, model, caps })
}))

// GET /api-configs/extra-schema?provider_key=&service_type=&model= —— 扩展参数单一真源只读查询
// 返回该实例可结构化配置的扩展参数清单（前端据此动态渲染表单，替代裸 JSON 天书框）。零网络、零计费、零写库。
// 可选 model：命中逐模型 profile 时返回模型级候选/默认；不传或未命中回落 provider 级（旧调用行为不变）。
apiRoutes.get('/api-configs/extra-schema', h(async (c) => {
  const providerKey = c.req.query('provider_key') ?? ''
  const serviceType = c.req.query('service_type') ?? ''
  const model = c.req.query('model') ?? ''
  if (!providerKey || !serviceType) throw new HttpError(400, 'bad_provider', 'provider_key 与 service_type 必填')
  return c.json({ providerKey, serviceType, fields: resolveExtraSchema(providerKey, serviceType, model || undefined) })
}))

// GET /api-configs/model-suggest?provider_key=&model=&service_type= —— 选中即生成：跨通道 Tier A 只读建议
// 命中任一即 supported:true：参考定价（全通道，resolveModelPricing）+ 视频能力档位（复用）+ 默认通道建议（该类型当前无实例）。
// 三者皆无 → { supported:false }（前端全手填）。只读、零网络、零计费、零写库；不改事后计价口径。
apiRoutes.get('/api-configs/model-suggest', h(async (c) => {
  const providerKey = c.req.query('provider_key') ?? ''
  const model = c.req.query('model') ?? ''
  const serviceType = c.req.query('service_type') ?? ''
  if (!providerKey) throw new HttpError(400, 'bad_provider', 'provider_key 必填')
  if (!SERVICE_TYPES.includes(serviceType)) throw new HttpError(400, 'bad_type', `service_type 需为 ${SERVICE_TYPES.join('|')}`)
  const pricing = resolveModelPricing(serviceType as PricingServiceType, providerKey, model)
  const caps = serviceType === 'video' ? resolveVideoCaps(providerKey, model) : null
  const cnt = await db.select({ n: count() }).from(apiConfigs).where(eq(apiConfigs.serviceType, serviceType))
  const suggestDefault = (cnt[0]?.n ?? 0) === 0
  const supported = !!pricing || !!caps || suggestDefault
  const res: Record<string, unknown> = { supported, serviceType, providerKey, model }
  if (pricing) res.pricing = pricing
  if (caps) res.caps = caps
  if (suggestDefault) res.suggestDefault = true
  return c.json(res)
}))

// PUT /api-configs/:id —— 更新（同字段；api_key 传明文则覆盖；credential_id / pricing 可更新）
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
  if (body['pricing'] !== undefined && typeof body['pricing'] === 'object') patch['pricing'] = JSON.stringify(body['pricing'])
  if (body['priority'] !== undefined) patch['priority'] = Number(body['priority']) || 0
  if (body['is_default'] !== undefined) patch['isDefault'] = body['is_default'] === true ? 1 : 0
  if (body['is_active'] !== undefined) patch['isActive'] = body['is_active'] === true ? 1 : 0
  if (body['credential_id'] !== undefined) patch['credentialId'] = typeof body['credential_id'] === 'number' ? body['credential_id'] : null
  if (body['api_key'] !== undefined) {
    if (typeof body['api_key'] !== 'string' || !body['api_key']) throw new HttpError(400, 'bad_key', 'api_key 非法')
    // 实例级独立 Key 按 id 专属槽存储，避免同供应商多实例互相覆盖
    const ref = `local:cfg:${cfg.serviceType}:${cfg.providerKey}:${id}`
    writeSecret(ref, body['api_key'])
    patch['apiKeyRef'] = ref
  }
  const updated = await db.update(apiConfigs).set(patch).where(eq(apiConfigs.id, id)).returning()
  if (updated[0]?.isDefault === 1) await clearOtherDefaults(id, cfg.serviceType)
  return c.json({ config: updated[0] })
}))

// DELETE /api-configs/:id —— 删除
apiRoutes.delete('/api-configs/:id', h(async (c) => {
  const id = idParam(c)
  const rows = await db.select().from(apiConfigs).where(eq(apiConfigs.id, id)).limit(1)
  const cfg = rows[0]
  if (!cfg) return notFound(c, `配置 ${id}`)
  await db.delete(apiConfigs).where(eq(apiConfigs.id, id))
  // 仅回收「实例 id 专属」密钥槽；旧版共享槽可能被同供应商其它实例共用，勿删
  if (cfg.apiKeyRef === `local:cfg:${cfg.serviceType}:${cfg.providerKey}:${id}`) deleteSecret(cfg.apiKeyRef)
  return c.json({ ok: true })
}))

// POST /api-configs/:id/test —— 连通测试：chat/image/video 派发至 kit testConnection（Template Method 探针 + 最小生成）；
// audio 保留宿主 synthSpeech（覆盖 OpenAI 兼容 /audio/speech，kit 探针仅覆盖阿里/火山私有协议）
apiRoutes.post('/api-configs/:id/test', h(async (c) => {
  const id = idParam(c)
  const rows = await db.select().from(apiConfigs).where(eq(apiConfigs.id, id)).limit(1)
  const cfg = rows[0]
  if (!cfg) return notFound(c, `配置 ${id}`)
  const t0 = Date.now()
  // 密钥/端点解析：credential 优先 fallback 实例级 apiKeyRef；baseUrl 实例 > 凭证 > 目录 defaultUrl
  const testApiKey = await resolveConfigApiKey(cfg)
  const testBaseUrl = await resolveConfigBaseUrl(cfg)
  const extra = safeJson(cfg.extra, {}) as Record<string, unknown>

  if (cfg.serviceType === 'audio') {
    const voice = typeof extra['voice'] === 'string' && extra['voice'] ? extra['voice'] : undefined
    const buf = await synthSpeech('ping', {
      providerKey: cfg.providerKey,
      baseUrl: testBaseUrl,
      apiKey: testApiKey,
      model: cfg.model ?? (await defaultTtsModel(cfg.providerKey)),
      voice,
      extra,
    }, { voice, timeoutMs: 30_000 })
    return c.json({ ok: true, ms: Date.now() - t0, bytes: buf.byteLength, voice: voice ?? 'alloy', note: '语音合成成功（1 句，注意计费）' })
  }

  // 视频非探针供应商（如 minimax_video）无零计费探针 → 501（与 isConfigTestable 同口径，需真实 run 验证）
  if (cfg.serviceType === 'video' && !TESTABLE_VIDEO_PROVIDER_KEYS.has(cfg.providerKey)) {
    throw new HttpError(501, 'no_test', '该视频供应商暂未提供连通探针（探针需实测验证后启用），请用真实 run 验证')
  }

  // chat / image / video / music 统一派发至 kit testConnection（宿主 DB service_type 'llm' → kit 'chat' 语义）
  let serviceType: 'chat' | 'image' | 'video' | 'music'
  if (cfg.serviceType === 'llm') serviceType = 'chat'
  else if (cfg.serviceType === 'image') serviceType = 'image'
  else if (cfg.serviceType === 'video') serviceType = 'video'
  else if (cfg.serviceType === 'music') serviceType = 'music'
  else throw new HttpError(501, 'no_test', `${cfg.serviceType} 类型暂不支持连通测试`)

  // chat 且实例未填模型 → 传目录预置首项供 kit 兑底（仍无则 kit testConnection 报错）
  let presetModels: string[] | undefined
  if (serviceType === 'chat' && !cfg.model) {
    const provRows = await db
      .select({ preset: apiProviders.presetModels })
      .from(apiProviders)
      .where(eq(apiProviders.key, cfg.providerKey))
      .limit(1)
    const presets = safeJson(provRows[0]?.preset ?? null, []) as unknown[]
    presetModels = presets.filter((m): m is string => typeof m === 'string' && !!m)
  }

  const res = await testConnection({
    serviceType,
    providerKey: cfg.providerKey,
    baseUrl: testBaseUrl,
    apiKey: testApiKey,
    model: cfg.model ?? undefined,
    extra,
    presetModels,
  })
  return c.json({ ok: res.ok, ms: res.ms ?? Date.now() - t0, note: res.note, ...res.detail })
}))

/** 密钥解析：credential 优先，fallback 到实例级 apiKeyRef */
async function resolveConfigApiKey(cfg: typeof apiConfigs.$inferSelect): Promise<string> {
  if (cfg.credentialId != null) {
    const credRows = await db.select().from(vendorCredentials).where(eq(vendorCredentials.id, cfg.credentialId)).limit(1)
    const cred = credRows[0]
    if (cred) {
      const key = resolveApiKey(cred.apiKeyRef)
      if (key) return key
    }
  }
  return resolveApiKey(cfg.apiKeyRef)
}

/** Base URL 解析：实例 > 凭证 > 目录 defaultUrl */
async function resolveConfigBaseUrl(cfg: typeof apiConfigs.$inferSelect): Promise<string> {
  if (cfg.baseUrl?.trim()) return cfg.baseUrl.trim().replace(/\/+$/, '')
  if (cfg.credentialId != null) {
    const credRows = await db.select().from(vendorCredentials).where(eq(vendorCredentials.id, cfg.credentialId)).limit(1)
    const cred = credRows[0]
    if (cred?.baseUrl?.trim()) return cred.baseUrl.trim().replace(/\/+$/, '')
  }
  return (await providerDefaultUrl(cfg.providerKey)).replace(/\/+$/, '')
}

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
