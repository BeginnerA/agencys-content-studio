import { Hono } from 'hono'
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm'
import { db } from '../db'
import { apiConfigs, apiProviders, vendorCredentials } from '../db/schema'
import { resolveApiKey, writeSecret } from '../services/secrets'
import { chatComplete, providerDefaultUrl } from '../services/llm'
import { resolveEndpoint, getImageAdapter } from '../adapters/provider'
import { resolveVideoCaps } from '../adapters/video-capabilities'
import { probeAliyunWanVideoEndpoint } from '../adapters/aliyun-wan-video'
import { probePollinationsVideoEndpoint } from '../adapters/pollinations-video'
import { probeSiliconflowVideoEndpoint } from '../adapters/siliconflow-video'
import { probeVolcengineVideoEndpoint } from '../adapters/volcengine-video'
import { defaultTtsModel, synthSpeech } from '../services/tts'
import { HttpError, h, idParam, notFound } from './helpers'

export const apiRoutes = new Hono()

const SERVICE_TYPES = ['llm', 'image', 'video', 'audio']

/** DashScope 原生协议行（万相文生图/视频、千问图像、千问 TTS）无 OpenAI 兼容 /models 端点，模型目录由预置提供 */
const NATIVE_DASHSCOPE_PROVIDER_KEYS = new Set(['aliyun_wan_image', 'aliyun_qwen_image', 'aliyun_wan_video', 'aliyun_qwen_tts'])

/**
 * 提供零计费连通探针的视频供应商（其余视频供应商如 minimax_video 仅能用真实 run 验证）。
 * /api-providers 的 testable 能力位与下方 /:id/test 视频分支的探针路由共用，需两处同步维护。
 */
const TESTABLE_VIDEO_PROVIDER_KEYS = new Set([
  'aliyun_wan_video',
  'volcengine_video',
  'siliconflow_video',
  'pollinations_video',
])

/** 实例是否支持「测试连接」：llm/image/audio 恒可（走真实最小生成/合成 ping）；video 仅上表探针供应商。 */
function isConfigTestable(serviceType: string, providerKey: string): boolean {
  if (serviceType === 'video') return TESTABLE_VIDEO_PROVIDER_KEYS.has(providerKey)
  return true
}

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

  // credential_id 优先；否则回退到旧的 per-instance key 逻辑
  const credentialId = typeof body['credential_id'] === 'number' ? body['credential_id'] : null
  let apiKeyRef = 'local'
  if (!credentialId) {
    // 无凭证关联时沿用旧逻辑：body.api_key 明文 → secrets.json
    if (body['api_key'] !== undefined) {
      if (typeof body['api_key'] !== 'string' || !body['api_key']) throw new HttpError(400, 'bad_key', 'api_key 非法')
      writeSecret(`local:cfg:${serviceType}:${providerKey}`, body['api_key'])
      apiKeyRef = `local:cfg:${serviceType}:${providerKey}`
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

  // DashScope 原生协议行在线拉取必 404（无 /models 端点）；直接回退预置目录并说明原因
  if (NATIVE_DASHSCOPE_PROVIDER_KEYS.has(providerKey)) {
    return c.json({
      models: preset,
      source: 'preset',
      note: '该供应商为 DashScope 原生协议（无 /models 接口），模型目录由平台预置',
    })
  }

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

// GET /api-configs/video-caps?provider_key=&model= —— [M32] 视频模型能力单一真源表只读查询
// 命中：{ supported:true, caps }（前端据此自动背书、去「已核实」勾选）；未命中：{ supported:false }（回退手填声明）。
apiRoutes.get('/api-configs/video-caps', h(async (c) => {
  const providerKey = c.req.query('provider_key') ?? ''
  const model = c.req.query('model') ?? ''
  if (!providerKey) throw new HttpError(400, 'bad_provider', 'provider_key 必填')
  const caps = resolveVideoCaps(providerKey, model)
  if (!caps) return c.json({ supported: false, providerKey, model })
  return c.json({ supported: true, providerKey, model, caps })
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

// POST /api-configs/:id/test —— 连通性测试：llm 1 次最小对话；image 生成 1 张、audio 1 句（真实计费）；video 零计费探针
apiRoutes.post('/api-configs/:id/test', h(async (c) => {
  const id = idParam(c)
  const rows = await db.select().from(apiConfigs).where(eq(apiConfigs.id, id)).limit(1)
  const cfg = rows[0]
  if (!cfg) return notFound(c, `配置 ${id}`)
  const t0 = Date.now()
  // 密钥解析：credential 优先，fallback 到实例级 apiKeyRef
  const testApiKey = await resolveConfigApiKey(cfg)
  const testBaseUrl = await resolveConfigBaseUrl(cfg)
  if (cfg.serviceType === 'llm') {
    // model 留空 → 供应商目录预置首项兜底；无预置目录（自定义网关行）时报错提示填写
    let model = cfg.model ?? ''
    if (!model) {
      const provRows = await db
        .select({ preset: apiProviders.presetModels })
        .from(apiProviders)
        .where(eq(apiProviders.key, cfg.providerKey))
        .limit(1)
      const presets = safeJson(provRows[0]?.preset ?? null, []) as unknown[]
      model = presets.find((m): m is string => typeof m === 'string' && !!m) ?? ''
    }
    if (!model) throw new HttpError(400, 'no_model', '实例未配置模型且该供应商无预置模型，请在实例中填写模型名')
    await chatComplete([{ role: 'user', content: 'ping' }], {
      baseUrl: testBaseUrl,
      apiKey: testApiKey,
      model,
      providerKey: cfg.providerKey,
    }, { maxTokens: 16, timeoutMs: 30_000, allowReasoningOnly: true, allowEmptyContent: true })
    return c.json({ ok: true, ms: Date.now() - t0, note: 'llm 最小对话成功' })
  }
  if (cfg.serviceType === 'image') {
    const endpoint = await resolveEndpoint('image', cfg.providerKey)
    const adapter = getImageAdapter(endpoint.providerKey)
    // 各家测试尺寸约束：万相最短边 512（256 会被调度拒绝）→ 用合法小尺寸；
    // 千问图像 max/plus 仅固定枚举、OpenAI 官方 gpt-image/dall-e 尺寸亦为固定枚举 → 不传用官方默认；
    // 其余家（SiliconFlow/火山 Seedream/Pollinations/Gemini）256x256 实测可用或由适配器升级档位
    const testSize =
      cfg.providerKey === 'aliyun_wan_image'
        ? '1024x1024'
        : cfg.providerKey === 'aliyun_qwen_image' || cfg.providerKey === 'openai_image'
          ? undefined
          : '256x256'
    const img = await adapter.generate({
      prompt: 'a tiny red square on white background, minimal test',
      size: testSize,
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
      baseUrl: testBaseUrl,
      apiKey: testApiKey,
      model: cfg.model ?? (await defaultTtsModel(cfg.providerKey)),
      voice,
      extra,
    }, { voice, timeoutMs: 30_000 })
    return c.json({ ok: true, ms: Date.now() - t0, bytes: buf.byteLength, voice: voice ?? 'alloy', note: '语音合成成功（1 句，注意计费）' })
  }
  if (cfg.serviceType === 'video') {
    // 视频生成成本高，统一用零计费探针验证「端点+鉴权」（不创建任务）
    const baseUrl = testBaseUrl
    const apiKey = testApiKey
    if (cfg.providerKey === 'aliyun_wan_video') {
      const note = await probeAliyunWanVideoEndpoint({ baseUrl, apiKey })
      return c.json({ ok: true, ms: Date.now() - t0, note })
    }
    if (cfg.providerKey === 'volcengine_video') {
      const note = await probeVolcengineVideoEndpoint({ baseUrl, apiKey })
      return c.json({ ok: true, ms: Date.now() - t0, note })
    }
    if (cfg.providerKey === 'siliconflow_video') {
      const note = await probeSiliconflowVideoEndpoint({ baseUrl, apiKey })
      return c.json({ ok: true, ms: Date.now() - t0, note })
    }
    if (cfg.providerKey === 'pollinations_video') {
      const note = await probePollinationsVideoEndpoint({ baseUrl, apiKey })
      return c.json({ ok: true, ms: Date.now() - t0, note })
    }
    throw new HttpError(501, 'no_test', '该视频供应商暂未提供连通探针（探针需实测验证后启用），请用真实 run 验证')
  }
  throw new HttpError(501, 'no_test', `${cfg.serviceType} 类型暂不支持连通测试`)
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
