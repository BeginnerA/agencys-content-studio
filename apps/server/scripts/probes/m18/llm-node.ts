/** M18[P4] llm-node：LLM 节点（端口矩阵 v3 + specProblems/parseNodeSpec + 未配置引导 + stub 执行链 + 产物文本下游装载）（断言体逐字搬自原 probe-m18.ts） */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { M18Ctx } from './ctx'

export async function run(ctx: M18Ctx): Promise<void> {
  const { check, db, mkProject, mkAsset, jreq, settleTasks, stubFetch, apiConfigs, assets, usageRecords, and, eq, relPathOf, absPathOf, T0 } = ctx
  const { validateNewEdge, productKindOf, parseNodeSpec, specProblems, planNodeInputs } = await import('../../../src/services/creation')
  const { preflightNode } = await import('../../../src/services/creation/gen')
  const llmSpec = parseNodeSpec({ genKind: 'llm', prompt: '请总结' })
  const throwsWith = (fn: () => unknown, kw: string): boolean => {
    try {
      fn()
      return false
    } catch (e) {
      return (e as Error).message.includes(kw)
    }
  }

  // ---- productKindOf / 端口矩阵 v3（纯函数） ----
  check(productKindOf(llmSpec) === 'text', 'productKindOf(llm) = text（产物文本类型）')
  const toLlm = { id: 9, kind: 'gen', spec: llmSpec }
  const toImage = { id: 10, kind: 'gen', spec: parseNodeSpec({ genKind: 'image', prompt: 'x' }) }
  const textFrom = { id: 1, kind: 'text' }
  const llmFrom = { id: 2, kind: 'gen', spec: llmSpec }
  const entFrom = { id: 3, kind: 'entity' }
  const imgFrom = { id: 4, kind: 'asset', assetKind: 'image' }
  const vidFrom = { id: 5, kind: 'asset', assetKind: 'video' }

  check(validateNewEdge(toLlm, 'text', 1, [], textFrom) === null, 'text 端口：llm 目标 + text 源 → 允许')
  check(validateNewEdge(toLlm, 'text', 2, [], llmFrom) === null, 'text 端口：llm 目标 + llm 产物源 → 允许')
  check(validateNewEdge(toLlm, 'text', 4, [], imgFrom)?.includes('文本素材来源需为文本节点或 LLM 节点') === true, 'text 端口：image 源 → 拒（来源文案）')
  check(validateNewEdge(toImage, 'text', 1, [], textFrom)?.includes('文本素材端口仅 LLM 节点支持') === true, 'text 端口：image 目标 → 拒')
  const four = [1, 2, 3, 4].map((f) => ({ from: f, to: 9, port: 'text' }))
  check(validateNewEdge(toLlm, 'text', 5, four, textFrom)?.includes('文本素材上限 4 段') === true, 'text 端口：第 5 条 → 上限 4 段')

  check(validateNewEdge(toLlm, 'reference', 4, [], imgFrom) === null, 'reference：llm 目标 + image 源 → 允许')
  check(validateNewEdge(toLlm, 'reference', 3, [], entFrom) === null, 'reference：llm 目标 + entity 源 → 允许')
  const fourRef = [1, 2, 3, 4].map((f) => ({ from: f, to: 9, port: 'reference' }))
  check(validateNewEdge(toLlm, 'reference', 5, fourRef, imgFrom)?.includes('LLM生成节点参考图上限 4 张') === true, 'reference：llm 第 5 张 → 上限 4 张')
  check(validateNewEdge(toLlm, 'reference', 5, [], vidFrom)?.includes('参考图来源需为图片素材/生成图/实体节点') === true, 'reference：llm 目标 + video 源 → 拒')

  check(validateNewEdge(toLlm, 'prompt', 1, [], textFrom) === null, 'prompt：llm 目标 + text 源 → 允许')
  check(validateNewEdge(toLlm, 'prompt', 4, [], imgFrom)?.includes('提示词端口仅接受文本节点或 LLM 节点') === true, 'prompt：image 源 → 拒')

  // ---- specProblems / parseNodeSpec ----
  check(specProblems({ genKind: 'llm', prompt: '' }, false).some((p) => p.includes('指令为空')) === true, 'specProblems：llm 空指令 → 问题')
  check(specProblems({ genKind: 'llm', prompt: '写' }, false).length === 0, 'specProblems：llm 有指令 → 无问题')
  check(specProblems({ genKind: 'llm', prompt: '' }, true).length === 0, 'specProblems：prompt 端口提供指令 → 无问题')
  check(parseNodeSpec({ genKind: 'llm', prompt: 'x', temperature: 1.5, maxTokens: 8000 }).temperature === 1.5, 'parseNodeSpec：temperature/maxTokens 透传')
  check(throwsWith(() => parseNodeSpec({ genKind: 'llm', prompt: 'x', temperature: 2.5 }), 'temperature'), 'parseNodeSpec：temperature>2 → 拒')
  check(throwsWith(() => parseNodeSpec({ genKind: 'llm', prompt: 'x', maxTokens: 1.5 }), 'maxTokens'), 'parseNodeSpec：maxTokens 非整数 → 拒')

  // ---- planNodeInputs（纯函数）：text 素材装载（trim/空跳过/上限）+ prompt 端口 ----
  const plan = planNodeInputs(
    llmSpec,
    9,
    [1, 2, 3, 4, 5, 6].map((f) => ({ from: f, to: 9, port: 'text' })).concat([{ from: 7, to: 9, port: 'prompt' }]),
    new Map([
      [1, { assetId: null, mediaKind: null, text: '素材甲' }],
      [2, { assetId: null, mediaKind: null, text: '  素材乙  ' }],
      [3, { assetId: null, mediaKind: null, text: '' }],
      [4, { assetId: null, mediaKind: null, text: '素材丙' }],
      [5, { assetId: null, mediaKind: null, text: '素材丁' }],
      [6, { assetId: null, mediaKind: null, text: '素材戊' }],
      [7, { assetId: null, mediaKind: null, text: '端口指令' }],
    ]),
  )
  check(
    plan.textInputs.length === 4 && plan.textInputs[0] === '素材甲' && plan.textInputs[1] === '素材乙' && plan.textInputs[3] === '素材丁',
    'plan：textInputs 装载（trim；第 5、6 段被上限截断）',
  )
  check(plan.problems.some((p) => p.includes('暂无文本或为空')) === true, 'plan：空文本素材 → 问题')
  check(plan.problems.some((p) => p.includes('文本素材超过上限 4 段')) === true, 'plan：超上限 → 问题')
  check(plan.promptText === '端口指令', 'plan：prompt 端口指令装载')

  // ---- 执行链（HTTP 全链 + fetch stub） ----
  const PID = await mkProject('M18 LLM')
  const C = (await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: 'LLM 画布' })).body.canvas.id
  const mkNode = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${C}/nodes`, body)).body.node.id

  // 未配置 LLM（探针顶部已屏蔽 env；无 api_configs）→ preflight 引导 + run 400
  const NL0 = await mkNode({ kind: 'gen', spec: { genKind: 'llm', prompt: '未配置测试' }, x: 0, y: 0 })
  const pf0 = await preflightNode(NL0)
  check(pf0.problems.some((p) => p.includes('LLM 未配置')) === true, '未配置：preflight problems 含「LLM 未配置」引导')
  const r0 = await jreq('POST', `/api/v1/nodes/${NL0}/run`, {})
  check(r0.status === 400 && String(r0.body?.error?.message ?? '').includes('LLM 未配置'), '未配置：run → 400 引导文案')

  // 配置探针 LLM（实例级 llm 实例）
  await db.insert(apiConfigs).values({
    providerKey: 'probe-llm',
    serviceType: 'llm',
    name: 'probe LLM',
    baseUrl: 'https://probe.invalid/v1',
    apiKeyRef: 'env:PROBE_M18_LLM_KEY',
    model: 'probe-model',
    priority: 0,
    isDefault: 1,
    isActive: 1,
    createdAt: T0,
    updatedAt: T0,
  })
  process.env.PROBE_M18_LLM_KEY = 'probe-key-m18'
  const pf1 = await preflightNode(NL0)
  check(!pf1.problems.some((p) => p.includes('LLM 未配置')), '已配置：preflight 不再报「LLM 未配置」')

  // fetch stub：chat/completions → 固定文本 + usage；捕获请求体供断言
  const captured: Array<{ url: string; body: any }> = []
  const LLM_REPLY = '【探针】总结：素材要点已提炼。'
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    captured.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
    return new Response(
      JSON.stringify({ choices: [{ message: { content: LLM_REPLY }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 48, total_tokens: 168 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch

  // 素材链：text 节点 → text 端口；参考图 → reference 端口；llm 节点（temperature/maxTokens 透传）
  const NTX = await mkNode({ kind: 'text', spec: { text: '资料：萌宝镖客是一部短剧。' }, x: 0, y: 200 })
  const NL1 = await mkNode({ kind: 'gen', spec: { genKind: 'llm', prompt: '请总结资料', temperature: 0.3, maxTokens: 900 }, x: 300, y: 0 })
  check((await jreq('POST', `/api/v1/canvases/${C}/edges`, { from: NTX, to: NL1, port: 'text' })).status === 201, '建边：text 端口 → 201')
  const pngRel = relPathOf(PID, 'creation_ref', 'probe-ref.png')
  mkdirSync(dirname(absPathOf(pngRel)), { recursive: true })
  writeFileSync(
    absPathOf(pngRel),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  )
  const AIM = await mkAsset(PID, 'image', '参考图', { relPath: pngRel })
  const NAIM = await mkNode({ kind: 'asset', assetId: AIM, x: 0, y: 400 })
  check((await jreq('POST', `/api/v1/canvases/${C}/edges`, { from: NAIM, to: NL1, port: 'reference' })).status === 201, '建边：reference 端口（llm）→ 201')

  const r1 = await jreq('POST', `/api/v1/nodes/${NL1}/run`, {})
  check(r1.status === 200 && r1.body?.taskIds?.length === 1, 'run → 任务入队')
  const st = await settleTasks([r1.body.taskIds[0]])
  check(st.get(r1.body.taskIds[0]) === 'succeeded', 'llm 执行 → succeeded（stub 端点）')

  // 请求体断言（最后一发）
  const reqBody = captured[captured.length - 1]?.body
  check(captured[captured.length - 1]?.url === 'https://probe.invalid/v1/chat/completions', '请求 URL = baseUrl + /chat/completions')
  check(reqBody?.model === 'probe-model' && reqBody?.temperature === 0.3 && reqBody?.max_tokens === 900, '请求体：model/temperature/maxTokens 透传')
  const userMsg = reqBody?.messages?.[1]
  check(Array.isArray(userMsg?.content) && userMsg.content[0]?.type === 'text' && String(userMsg.content[0].text).includes('--- 素材 1 ---') && String(userMsg.content[0].text).includes('指令：请总结资料'), '多模态：文本素材段 + 指令拼接')
  check(
    Array.isArray(userMsg?.content) && userMsg.content.some((p: any) => p.type === 'image_url' && String(p.image_url?.url).startsWith('data:image/png;base64,')),
    '多模态：参考图 data URI 分片',
  )

  // 落库断言：产物资产 + 文件内容 + params
  const outs = await db.select().from(assets).where(and(eq(assets.projectId, PID), eq(assets.purpose, 'creation_llm')))
  const outT = outs[0]
  check(!!outT && outT.kind === 'text' && outT.mime === 'text/markdown' && outT.ext === 'md', '产物：text 资产（text/markdown；md）')
  check(outT?.name === `LLM 文本 #${NL1}.md`, '产物命名：LLM 文本 #<nodeId>.md')
  if (outT?.relPath) {
    const content = readFileSync(absPathOf(outT.relPath), 'utf8')
    check(content === LLM_REPLY, '产物文件内容 = 模型返回')
  } else {
    check(false, '产物文件存在')
  }
  const pOut = JSON.parse(String(outT?.params ?? '{}')) as Record<string, unknown>
  check(pOut.materials === 1 && pOut.images === 1 && pOut.canvasId === C && pOut.nodeId === NL1, '产物 params：materials=1 / images=1 / canvasId/nodeId')

  // 用量：tokens_in/out 两行
  const urs = await db.select().from(usageRecords).where(eq(usageRecords.projectId, PID))
  check(
    urs.some((u) => u.kind === 'llm' && u.unit === 'tokens_in' && u.quantity === 120) && urs.some((u) => u.kind === 'llm' && u.unit === 'tokens_out' && u.quantity === 48),
    '用量：tokens_in=120 / tokens_out=48',
  )

  // 读模型
  const doc = await jreq('GET', `/api/v1/canvases/${C}`)
  const nd = (doc.body?.nodes ?? []).find((n: any) => n.id === NL1)
  check(nd?.status === 'succeeded' && nd?.displayTask?.asset?.kind === 'text', '读模型：succeeded + displayTask.asset.kind=text')

  // ---- 产物文本下游装载：llm 产物 → 下游 llm（prompt / text 端口） ----
  const NL2 = await mkNode({ kind: 'gen', spec: { genKind: 'llm', prompt: '基于指令改写' }, x: 600, y: 0 })
  check((await jreq('POST', `/api/v1/canvases/${C}/edges`, { from: NL1, to: NL2, port: 'prompt' })).status === 201, '建边：llm 产物 → prompt 端口 → 201')
  const pf2 = await preflightNode(NL2)
  check(pf2.plan.promptText === LLM_REPLY, '下游装载：llm 产物文本 → plan.promptText（prompt 端口）')
  check(pf2.problems.length === 0, '下游装载：preflight 无问题')
  const NL3 = await mkNode({ kind: 'gen', spec: { genKind: 'llm', prompt: '合并素材' }, x: 600, y: 200 })
  check((await jreq('POST', `/api/v1/canvases/${C}/edges`, { from: NL1, to: NL3, port: 'text' })).status === 201, '建边：llm 产物 → text 端口 → 201')
  const pf3 = await preflightNode(NL3)
  check(pf3.plan.textInputs.length === 1 && pf3.plan.textInputs[0] === LLM_REPLY, '下游装载：llm 产物文本 → textInputs（text 端口）')

  // 链二段执行：指令 = 上游产物文本
  const r2 = await jreq('POST', `/api/v1/nodes/${NL2}/run`, {})
  const st2 = await settleTasks([r2.body?.taskIds?.[0] ?? -1])
  check(r2.status === 200 && st2.get(r2.body?.taskIds?.[0] ?? -1) === 'succeeded', '下游执行：llm 链二段 succeeded')
  const req2 = captured[captured.length - 1]?.body
  check(String(req2?.messages?.[1]?.content) === LLM_REPLY, '下游执行：无素材时指令直传（content 字符串）')

  // ---- 产物文件缺失降级：装载留空 + problem（不炸） ----
  if (outT?.relPath) {
    rmSync(absPathOf(outT.relPath), { force: true })
    const pf4 = await preflightNode(NL2)
    check(pf4.plan.promptText === null && pf4.problems.some((p) => p.includes('暂无文本或为空')) === true, '产物文件缺失：装载降级 → promptText=null + 问题')
  }

  // ---- 清理（防影响后续 section）：还原 fetch + 删实例 + 清 env ----
  globalThis.fetch = stubFetch
  await db.delete(apiConfigs).where(and(eq(apiConfigs.providerKey, 'probe-llm'), eq(apiConfigs.serviceType, 'llm')))
  delete process.env.PROBE_M18_LLM_KEY
}
