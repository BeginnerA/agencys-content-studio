/**
 * M33 探针（AI 配置智能化：定价 Tier A 真源表 + 选中即生成建议端点）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m33.ts [--section=registry|endpoint|cost-drift]
 *
 * 隔离策略：isolatedEnv('m33', bridge templates/prompts) 一次性临时目录（独立 studio.db + workspace），
 * 必须先于任何 src 动态 import。零网络、零付费、零计费：resolveModelPricing 为纯查表；
 * model-suggest 端点只读 api_configs 计数 + 纯函数解析，绝不触发生成/计价写入。app.request 内存执行。
 *
 * 分节：
 *   - registry：resolveModelPricing 逐条命中官方核实价 + 大小写/trim 归一；未核实/未知供应商/单位不符 fail-closed（null，不猜价）。
 *   - endpoint：GET /model-suggest 命中态（pricing / video caps / suggestDefault）、全未命中 supported:false、非法 service_type→400。
 *   - cost-drift：参考定价表**不参与**事后计价——resolveUnitPrice 仍「实例 > 全局 > null」，命中表也不改变（零漂移红线）。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup: envCleanup } = isolatedEnv('m33', { bridge: ['templates', 'prompts'] })
process.env.PROBE_M33_KEY = 'probe-m33-offline-secret-key-7a1e'

const SECTIONS = ['registry', 'metadata', 'endpoint', 'fetch-endpoint', 'cost-drift'] as const

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m33')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  const seedConfig = async (v: {
    serviceType: string
    providerKey: string
    model: string
    pricing?: string
  }): Promise<void> => {
    const { initDb, db } = await import('../src/db')
    const { apiConfigs } = await import('../src/db/schema')
    await initDb()
    const t = Date.now()
    await db.insert(apiConfigs).values({
      name: `m33-${v.providerKey}`, providerKey: v.providerKey, serviceType: v.serviceType,
      apiKeyRef: 'env:PROBE_M33_KEY', baseUrl: 'http://localhost:0/offline', model: v.model,
      extra: '{}', pricing: v.pricing ?? '{}', isActive: 1, isDefault: 1, priority: 0,
      createdAt: t, updatedAt: t,
    } as never)
  }

  const clearService = async (serviceType: string): Promise<void> => {
    const { initDb, db } = await import('../src/db')
    const { apiConfigs } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    await initDb()
    await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, serviceType))
  }

  const jget = async (path: string): Promise<{ status: number; body: any }> => {
    const { app } = await import('../src/app')
    const res = await app.request(path)
    let json: any = null
    try { json = await res.json() } catch { /* non-json */ }
    return { status: res.status, body: json }
  }

  const jpost = async (path: string, body: unknown): Promise<{ status: number; body: any }> => {
    const { app } = await import('../src/app')
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    let json: any = null
    try { json = await res.json() } catch { /* non-json */ }
    return { status: res.status, body: json }
  }

  const runners: Record<string, () => Promise<void>> = {
    // ================= registry：命中官方核实价 + fail-closed（不猜价） =================
    registry: async () => {
      const { resolveModelPricing } = await import('../src/adapters/pricing-capabilities')
      const ds = resolveModelPricing('llm', 'deepseek_llm', 'deepseek-flash')
      check(!!ds && ds.prices.tokens_in === 2 && ds.prices.tokens_out === 8 && !!ds.source, 'deepseek-flash 命中高峰全价 2/8（元/百万 token）+ 来源锚点')
      const pro = resolveModelPricing('llm', 'deepseek_llm', 'deepseek-v4-pro')
      check(!!pro && pro.prices.tokens_in === 9 && pro.prices.tokens_out === 27, 'deepseek-v4-pro 命中 9/27')
      const qmax = resolveModelPricing('llm', 'aliyun_qwen_llm', 'qwen3.8-max')
      check(!!qmax && qmax.prices.tokens_in === 12 && qmax.prices.tokens_out === 36, 'qwen3.8-max 命中 12/36')
      const qflash = resolveModelPricing('llm', 'aliyun_qwen_llm', 'qwen3.8-flash')
      check(!!qflash && qflash.prices.tokens_in === 0.8 && qflash.prices.tokens_out === 2.7, 'qwen3.8-flash 命中 0.8/2.7')
      const wan = resolveModelPricing('image', 'aliyun_wan_image', 'wan2.7-image')
      check(!!wan && wan.prices.image === 0.2, 'wan2.7-image 命中 0.2 元/张')
      check(resolveModelPricing('llm', 'deepseek_llm', '  DeepSeek-Flash  ')?.prices.tokens_out === 8, 'model 大小写 / 首尾空格归一后仍命中')
      // fail-closed：未核实一律 null（不猜、不回退通用默认）
      check(resolveModelPricing('llm', 'openai_llm', 'gpt-5') === null, '未登记模型（openai）→ null（回落手填）')
      check(resolveModelPricing('llm', 'mystery_llm', 'deepseek-flash') === null, '未知供应商 → null（不猜）')
      check(resolveModelPricing('video', 'aliyun_wan_image', 'wan2.7-image') === null, '单位守卫：image 条目按 video 请求 → null（防表内填错造成虚假背书）')
      check(resolveModelPricing('llm', 'deepseek_llm', '') === null, '空 model → null')
      check(resolveModelPricing('video', 'minimax_video', 'MiniMax-H3') === null, '视频未登记秒价 → null（首批仅 LLM+万相图，视频回落手填）')
    },

    // ================= [M33.1] metadata：在线目录归一（仅 LLM 带价 / 不猜 / 单位守卫 / 兼容口 id-only） =================
    metadata: async () => {
      const { normalizeModelList } = await import('../src/adapters/model-metadata')
      const ds = { output: { models: [
        { model: 'qwen3.8-max', name: 'Qwen3.8-Max', prices: [{ range_name: 'Default', prices: [
          { type: 'input_token', price: '12', price_unit: '每百万tokens' },
          { type: 'output_token', price: '36', price_unit: '每百万tokens' },
          { type: 'input_token_cache', price: '1.5', price_unit: '每百万tokens' },
          { type: 'input_token_batch', price: '6', price_unit: '每百万tokens' },
        ] }], model_info: { max_input_tokens: 991808, max_output_tokens: 131072 } },
        { model: 'qwen3.7-plus', prices: [
          { range_name: '输入<=256k', prices: [{ type: 'input_token', price: '2', price_unit: '每百万tokens' }, { type: 'output_token', price: '8', price_unit: '每百万tokens' }] },
          { range_name: '256k<输入<=1m', prices: [{ type: 'input_token', price: '6', price_unit: '每百万tokens' }, { type: 'output_token', price: '24', price_unit: '每百万tokens' }] },
        ] },
        { model: 'qwen-image-3.0', prices: [{ range_name: 'Default', prices: [{ type: 'qima_input_1k', price: '0.02', price_unit: '每张' }] }] },
      ] } }
      const eLlm = normalizeModelList('llm', 'aliyun_qwen_llm', ds)
      const max = eLlm.find((m) => m.id === 'qwen3.8-max')
      check(!!max && max.pricing?.prices.tokens_in === 12 && max.pricing?.prices.tokens_out === 36, 'metadata: qwen3.8-max 归一 12/36（忽略 cache/batch）')
      check(!!max && max.context?.input === 991808 && max.context?.output === 131072, 'metadata: context 带出（max_input/output_tokens）')
      const plus = eLlm.find((m) => m.id === 'qwen3.7-plus')
      check(!!plus && plus.pricing?.prices.tokens_in === 2 && plus.pricing?.prices.tokens_out === 8, 'metadata: 分档无 Default → 取首组/基础档 2/8（与核实表一致，不取高档不猜）')
      check(!eLlm.some((m) => m.id === 'qwen-image-3.0'), 'metadata: image 条目无 token 全价档 → LLM 列表自然排除')
      check(normalizeModelList('image', 'aliyun_wan_image', ds).length === 0, 'metadata: 非 llm serviceType → 空（不从 live 猜图/视频/语音价）')
      const compat = normalizeModelList('llm', 'openai_llm', { data: [{ id: 'gpt-5' }, { id: 'gpt-5' }, 'o3'] })
      check(compat.length === 2 && compat.every((e) => !e.pricing), 'metadata: OpenAI 兼容口 id-only、去重、无价（不猜）')
    },

    // ================= endpoint：选中即生成建议（命中 / 全未命中 / 参数校验） =================
    endpoint: async () => {
      await clearService('llm')
      await clearService('video')
      await clearService('image')
      await clearService('audio')
      // 定价命中（llm 无实例：supported 由 pricing + suggestDefault 共同成立）
      const rPricing = await jget('/api/v1/api-configs/model-suggest?provider_key=deepseek_llm&service_type=llm&model=deepseek-flash')
      check(rPricing.status === 200 && rPricing.body?.supported === true && rPricing.body?.pricing?.prices?.tokens_in === 2, 'GET model-suggest（deepseek-flash）→ supported 且带参考定价 2/8')
      check(rPricing.body?.suggestDefault === true, '该类型当前无实例 → suggestDefault:true（默认通道建议）')
      // 播种一个 llm 实例后：默认通道建议消失
      await seedConfig({ serviceType: 'llm', providerKey: 'deepseek_llm', model: 'deepseek-flash' })
      const rNoDefault = await jget('/api/v1/api-configs/model-suggest?provider_key=deepseek_llm&service_type=llm&model=deepseek-flash')
      check(rNoDefault.body?.suggestDefault === undefined, '该类型已有实例 → 不再 suggestDefault')
      // 视频命中 caps（minimax 无参考定价，但 caps 命中 → supported）
      const rCaps = await jget('/api/v1/api-configs/model-suggest?provider_key=minimax_video&service_type=video&model=MiniMax-H3')
      check(rCaps.body?.supported === true && !!rCaps.body?.caps && rCaps.body?.caps?.resolutions?.join() === '768P,2K', 'video 命中 → 带 caps（复用 M32 真源表）')
      check(rCaps.body?.pricing === undefined, 'minimax 视频未登记定价 → pricing 缺席（不猜价）')
      // 全未命中：已有 video 实例 + 未背书供应商/模型 → supported:false
      await seedConfig({ serviceType: 'video', providerKey: 'minimax_video', model: 'MiniMax-H3' })
      const rMiss = await jget('/api/v1/api-configs/model-suggest?provider_key=mystery_video&service_type=video&model=x')
      check(rMiss.body?.supported === false && rMiss.body?.pricing === undefined && rMiss.body?.caps === undefined, '未背书 + 已有实例 → supported:false（前端全手填）')
      // 参数校验
      const rBad = await jget('/api/v1/api-configs/model-suggest?provider_key=x&service_type=bogus&model=y')
      check(rBad.status === 400, '非法 service_type → 400')
    },

    // ================= [M33.1] fetch-endpoint：在线拉取端点（阿里原生带价 / 失败回退 preset / 兼容口仅 id） =================
    'fetch-endpoint': async () => {
      const real = globalThis.fetch
      try {
        globalThis.fetch = (async (url: unknown) => {
          const u = String(url)
          if (!u.includes('dashscope.aliyuncs.com/api/v1/models')) {
            return { ok: false, status: 404, async text() { return 'not found' } }
          }
          return {
            ok: true, status: 200,
            async json() { return { output: { total: 1, page_no: 1, page_size: 100, models: [
              { model: 'qwen3.8-max', prices: [{ range_name: 'Default', prices: [{ type: 'input_token', price: '12', price_unit: '每百万tokens' }, { type: 'output_token', price: '36', price_unit: '每百万tokens' }] }] },
            ] } } },
          }
        }) as never
        const rLive = await jpost('/api/v1/api-configs/fetch-models', { provider_key: 'aliyun_qwen_llm', api_key: 'probe' })
        check(rLive.status === 200 && rLive.body?.source === 'live' && rLive.body?.models?.[0]?.id === 'qwen3.8-max' && rLive.body?.models?.[0]?.pricing?.prices?.tokens_in === 12, 'fetch: 阿里千问 LLM 走原生口 → live + 带价 12/36')

        globalThis.fetch = (async () => { throw new Error('boom') }) as never
        const rFail = await jpost('/api/v1/api-configs/fetch-models', { provider_key: 'aliyun_qwen_llm', api_key: 'probe' })
        check(rFail.body?.source === 'preset' && Array.isArray(rFail.body?.models) && rFail.body?.models.length > 0, 'fetch: 在线失败 → 回退 preset（id-only 列表非空）')
        check(typeof rFail.body?.note === 'string' && rFail.body.note.includes('回退'), 'fetch: 回退附 note 说明原因')

        globalThis.fetch = (async () => ({ ok: true, status: 200, async json() { return { data: [{ id: 'gpt-5' }] } } })) as never
        const rCompat = await jpost('/api/v1/api-configs/fetch-models', { provider_key: 'openai_llm', base_url: 'https://api.openai.com/v1', api_key: 'probe' })
        check(rCompat.body?.source === 'live' && rCompat.body?.models?.[0]?.id === 'gpt-5' && rCompat.body?.models?.[0]?.pricing === undefined, 'fetch: OpenAI 兼容 → live 仅 id、无价（不猜）')
      } finally {
        globalThis.fetch = real
      }
    },

    // ================= cost-drift：参考定价表不参与事后计价（零漂移红线） =================
    'cost-drift': async () => {
      const { resolveUnitPrice } = await import('../src/services/usage')
      const { resolveModelPricing } = await import('../src/adapters/pricing-capabilities')
      await clearService('llm')
      // 无实例定价、无全局定价 → 计价 null（即便参考表命中 2/8，也不注入计价链路）
      await seedConfig({ serviceType: 'llm', providerKey: 'deepseek_llm', model: 'deepseek-flash', pricing: '{}' })
      const viaTable = await resolveUnitPrice({ kind: 'llm', provider: 'deepseek_llm', model: 'deepseek-flash', unit: 'tokens_in' })
      check(viaTable === null, '参考表命中但无实例/全局定价 → 计价 null（真源表不注入事后计价）')
      check(resolveModelPricing('llm', 'deepseek_llm', 'deepseek-flash')?.prices.tokens_in === 2, '同时参考表仍命中 2（仅用于建实例预填）')
      // 实例定价优先且生效（预填落库后按实例价，非表价）
      await clearService('llm')
      await seedConfig({ serviceType: 'llm', providerKey: 'deepseek_llm', model: 'deepseek-flash', pricing: '{"tokens_in":5,"tokens_out":8}' })
      const viaInstance = await resolveUnitPrice({ kind: 'llm', provider: 'deepseek_llm', model: 'deepseek-flash', unit: 'tokens_in' })
      check(viaInstance === 5 / 1_000_000, '实例定价存在 → 计价值取实例（5/百万），与参考表口径独立（零漂移）')
      // [M33.1] 即便在线目录归一出 live 价，只要未落进实例 pricing，事后计价仍不受影响（真源/元数据不注入计价链）
      const { normalizeModelList } = await import('../src/adapters/model-metadata')
      const liveEntry = normalizeModelList('llm', 'aliyun_qwen_llm', { output: { models: [{ model: 'qwen3.8-max', prices: [{ range_name: 'Default', prices: [{ type: 'input_token', price: '12', price_unit: '每百万tokens' }, { type: 'output_token', price: '36', price_unit: '每百万tokens' }] }] }] } }).find((m) => m.id === 'qwen3.8-max')
      check(liveEntry?.pricing?.prices.tokens_in === 12, 'cost-drift: 在线目录归一 qwen3.8-max live 12（仅供预填）')
      await clearService('llm')
      await seedConfig({ serviceType: 'llm', providerKey: 'aliyun_qwen_llm', model: 'qwen3.8-max', pricing: '{}' })
      const viaLive = await resolveUnitPrice({ kind: 'llm', provider: 'aliyun_qwen_llm', model: 'qwen3.8-max', unit: 'tokens_in' })
      check(viaLive === null, 'cost-drift: live 元数据命中但不写实例 pricing → 事后计价仍 null（不进计价链）')
    },
  }

  await runSections({ log, title: 'M33', checker, sections: SECTIONS, runners, cleanup: envCleanup })
}

void main()
