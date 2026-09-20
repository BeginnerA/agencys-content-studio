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

const SECTIONS = ['registry', 'endpoint', 'cost-drift'] as const

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
    },
  }

  await runSections({ log, title: 'M33', checker, sections: SECTIONS, runners, cleanup: envCleanup })
}

void main()
