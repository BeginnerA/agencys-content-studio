/**
 * 平台数据导入回灌探针（API 契约失真两处）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m67-api-contract.ts [--section=gate-shape|extra-object]
 *
 * 对应审查发现（契约一致性）：
 *   ③ 审核接口返回类型失真：前端 runs.ts 把 POST /runs/:id/gate 声明为 `RunDetail`（含 steps），
 *      服务端实际只回 `{run}`（与 cancel/resume 同构）→ 调用方 `detail.value = res` 会抹掉步骤列表
 *      与会话反查字段。修复：类型改 `{run}`，调用方改走 detail() 重载；
 *   ⑥ apiConfigs.extra 对象校验：POST/PUT 用 `typeof === 'object'` 放行数组，非对象则静默丢弃，
 *      而读侧恒按 Record 取键（voice / emotion_param / caps）→ 配置期错误要到生成期才暴露。
 *
 * 断言（本探针逐条固定契约，防回归）：
 *   gate-shape  ：gate 响应键集恰为 ['run']；GET /runs/:id 才是全量（run+steps+会话反查）；
 *                 批准后引擎确实推进（形状修正不改行为）；cancel 同构只回 {run}。
 *   extra-object：数组/标量 extra|pricing 一律 400（bad_extra/bad_pricing）；合法对象按原文落库；
 *                 PUT 省略不改、显式 null 清空、非法值不动存量。
 *
 * 隔离：CSTUDIO_* 指向一次性临时目录；fetch 全替换为空 stub（零网络；manual_ingest 不需要模型）。
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedEnv, makeChecker, runSections } from './probe-lib'

const { tmp: TMP, cleanup: envCleanup } = isolatedEnv('m67')

const SECTIONS = ['gate-shape', 'extra-object'] as const
const T0 = 1_700_000_000_000
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 单闸门模板：s1 挂起等审 → s2 在批准后执行 */
const TPL = `key: probe-m67
version: 1
name: M67 契约探针
description: 审核接口返回形状回归
genre: other
inputs:
  - key: brief
    label: 简报
    kind: text
    required: true
steps:
  - key: s1_gate
    action: manual_ingest
    title: 审阅点
    gate:
      mode: required
      message: 探针审阅点
    inputs:
      brief: input.brief
  - key: s2_after
    action: manual_ingest
    title: 批准后继续
    after: [s1_gate]
    inputs:
      brief: input.brief
`

const stubFetch = (async (): Promise<Response> =>
  new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch

async function main(): Promise<void> {
  globalThis.fetch = stubFetch

  const { initDb, db } = await import('../src/db')
  const { apiConfigs, apiProviders, projects } = await import('../src/db/schema')
  const { app } = await import('../src/app')
  const { loadTemplate } = await import('../src/pipeline/loader')
  const { createLogger } = await import('../src/logger')
  const { eq } = await import('drizzle-orm')

  const log = createLogger('probe-m67')
  const checker = makeChecker(log)
  const check = checker.check

  mkdirSync(join(TMP, 'workspace', 'templates'), { recursive: true })
  writeFileSync(join(TMP, 'workspace', 'templates', 'probe-m67.yaml'), TPL, 'utf8')
  await initDb()

  const jreq = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const init: RequestInit = { method }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const res = await app.request(path, init)
    let json: any = null
    try {
      json = await res.json()
    } catch {
      /* 非 JSON */
    }
    return { status: res.status, body: json }
  }

  const mkProject = async (name: string): Promise<number> =>
    (
      await db
        .insert(projects)
        .values({ name, genre: 'other', templateKey: 'probe-m67', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!.id

  const waitStatus = async (runId: number, want: string, timeoutMs = 15_000): Promise<any> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const r = await jreq('GET', `/api/v1/runs/${runId}`)
      if (r.body?.run?.status === want) return r.body
      if (Date.now() > deadline) throw new Error(`超时等待 run ${runId} → ${want}（当前 ${r.body?.run?.status}）`)
      await sleep(120)
    }
  }

  /** 合法 provider key（隔离库已播种目录；缺失则补一条，仅为通过 POST 的目录校验） */
  const ensureProvider = async (): Promise<string> => {
    const rows = await db.select().from(apiProviders).where(eq(apiProviders.serviceType, 'llm')).limit(1)
    if (rows[0]) return rows[0].key
    await db.insert(apiProviders).values({
      key: 'probe-m67-llm',
      name: 'M67 LLM',
      serviceType: 'llm',
      vendor: 'probe',
      defaultUrl: 'https://probe.invalid/v1',
      isActive: 1,
      createdAt: T0,
      updatedAt: T0,
    })
    return 'probe-m67-llm'
  }

  await runSections({
    log,
    title: 'M67 API 契约探针',
    checker,
    sections: SECTIONS,
    runners: {
      'gate-shape': async () => {
        const tpl = loadTemplate('probe-m67')
        check(tpl.steps.length === 2, '探针模板加载（2 步：闸门 + 后继）')
        const pid = await mkProject('M67 契约')
        const started = await jreq('POST', `/api/v1/projects/${pid}/runs`, {
          template_key: 'probe-m67',
          input: { brief: '探针简报' },
        })
        check(started.status === 202, `启动 run → 202（实际 ${started.status}）`)
        const runId = started.body?.run?.id as number
        check(typeof runId === 'number', '响应含 run.id')

        const detail = await waitStatus(runId, 'waiting_input')
        check(detail.steps.some((s: any) => s.stepKey === 's1_gate' && s.status === 'waiting_input'), 'run 挂起于 s1_gate')

        const gated = await jreq('POST', `/api/v1/runs/${runId}/gate`, { step_key: 's1_gate', decision: 'approve' })
        check(gated.status === 200, `审核决策 → 200（实际 ${gated.status}）`)
        check(
          JSON.stringify(Object.keys(gated.body ?? {}).sort()) === JSON.stringify(['run']),
          `gate 响应键集恰为 [run]（实际 [${Object.keys(gated.body ?? {}).join(',')}]）——前端不得按 RunDetail 消费`,
        )
        check(gated.body?.run?.id === runId, 'gate 响应携带同一 run 的最新视图')
        check(gated.body?.steps === undefined && gated.body?.creationSessionId === undefined, 'gate 响应不含 steps / 会话反查（须由 GET 详情补齐）')

        const full = await jreq('GET', `/api/v1/runs/${runId}`)
        const fullKeys = Object.keys(full.body ?? {})
        check(
          ['run', 'steps', 'creationSessionId', 'resumeNeedsVerification', 'ambiguousTaskIds', 'resumeConfigDrift'].every((k) =>
            fullKeys.includes(k),
          ),
          `GET 详情才是全量（键：${fullKeys.join(',')}）`,
        )
        check(Array.isArray(full.body?.steps) && full.body.steps.length === 2, 'GET 详情含全部 2 步（gate 响应替代不了它）')

        const done = await waitStatus(runId, 'completed')
        check(done.steps.some((s: any) => s.stepKey === 's2_after' && s.status === 'succeeded'), '批准后引擎推进 s2（形状修正未改行为）')

        const cancelled = await jreq('POST', `/api/v1/runs/${runId}/cancel`)
        check(
          cancelled.status === 200 &&
            JSON.stringify(Object.keys(cancelled.body ?? {}).sort()) === JSON.stringify(['run']),
          'cancel 与 gate 同构：只回 {run}（前端类型口径一致）',
        )
      },

      'extra-object': async () => {
        const providerKey = await ensureProvider()
        const base = { provider_key: providerKey, service_type: 'llm', name: 'M67 实例' }

        const arrExtra = await jreq('POST', '/api/v1/api-configs', { ...base, extra: [1, 2] })
        check(arrExtra.status === 400 && arrExtra.body?.error?.code === 'bad_extra', `数组 extra → 400 bad_extra（实际 ${arrExtra.status}/${arrExtra.body?.error?.code}）`)
        const strExtra = await jreq('POST', '/api/v1/api-configs', { ...base, extra: 'voice' })
        check(strExtra.status === 400 && strExtra.body?.error?.code === 'bad_extra', '标量 extra → 400 bad_extra（旧实现静默丢弃）')
        const arrPricing = await jreq('POST', '/api/v1/api-configs', { ...base, pricing: [{ image: 1 }] })
        check(arrPricing.status === 400 && arrPricing.body?.error?.code === 'bad_pricing', '数组 pricing → 400 bad_pricing')
        const nullExtra = await jreq('POST', '/api/v1/api-configs', { ...base, extra: null })
        check(nullExtra.status === 201, '显式 null extra 视为空对象（201）')

        const created = await jreq('POST', '/api/v1/api-configs', {
          ...base,
          name: 'M67 合法实例',
          extra: { voice: 'v1', caps: { emotion_param: 'emotion' } },
          pricing: { image: { 'probe-img:m1': { image: 5 } } },
        })
        check(created.status === 201, `合法对象 → 201（实际 ${created.status}）`)
        const id = created.body?.config?.id as number
        check(JSON.stringify(created.body?.config?.extra) === JSON.stringify({ voice: 'v1', caps: { emotion_param: 'emotion' } }), 'extra 按原文回读（对象，不是被丢弃/字符串化）')

        const rejectPut = await jreq('PUT', `/api/v1/api-configs/${id}`, { extra: ['x'] })
        check(rejectPut.status === 400 && rejectPut.body?.error?.code === 'bad_extra', 'PUT 数组 extra → 400（不动存量）')
        const afterReject = await jreq('GET', '/api/v1/api-configs')
        const rowAfterReject = (afterReject.body?.items ?? []).find((c: any) => c.id === id)
        check(rowAfterReject?.extra?.voice === 'v1', '被拒的 PUT 未改写存量 extra')

        const nameOnly = await jreq('PUT', `/api/v1/api-configs/${id}`, { name: 'M67 改名' })
        check(nameOnly.status === 200 && nameOnly.body?.config?.extra?.voice === 'v1', 'PUT 省略 extra → 原值保留')

        const clear = await jreq('PUT', `/api/v1/api-configs/${id}`, { extra: null })
        check(clear.status === 200 && JSON.stringify(clear.body?.config?.extra) === '{}', 'PUT extra:null → 清空为 {}')

        const row = (await db.select().from(apiConfigs).where(eq(apiConfigs.id, id)))[0]
        check(row?.extra === '{}', '落库列本身是空对象 JSON（读侧恒按 Record 取键）')
        check(row?.pricing === JSON.stringify({ image: { 'probe-img:m1': { image: 5 } } }), 'PUT 未触碰 pricing 原文')
      },
    },
    cleanup: envCleanup,
  })
}

void main().catch((err) => {
  console.error(`M67 探针异常：${(err as Error).message}`)
  process.exit(1)
})
