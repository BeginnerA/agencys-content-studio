/** M17[llm-assist]：prompt-expand（未配置 400 / env 注入成功径 / instruction / 不落库 / 用量）+ extract 双径（断言体逐字搬自原 probe-m17.ts） */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { M17Ctx } from './ctx'

export async function run(ctx: M17Ctx): Promise<void> {
  const { check, jreq, db, usageRecords, assets, eq, PID, ENT, RUN1, docNode, mkAsset, env, absPathOf, ensureProjectDirs, stubFetch } = ctx
  {
    const c1 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: 'AI 辅助' })
    const C: number = c1.body.canvas.id
    const mkNode = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${C}/nodes`, body)).body.node.id
    const TL = await mkNode({ kind: 'text', spec: { text: '窗边的猫' }, x: 0, y: 0 })
    const TL_EMPTY = await mkNode({ kind: 'text', spec: { text: ' ' }, x: 0, y: 100 })
    const GL = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: '生成词' }, x: 300, y: 0 })
    const NE = await mkNode({ kind: 'entity', entityId: ENT, x: 300, y: 200 })

    // ---- 未配置 LLM → 400 引导 Settings ----
    const nf = await jreq('POST', `/api/v1/nodes/${TL}/prompt-expand`, {})
    check(nf.status === 400 && String(nf.body?.error?.message ?? '').includes('LLM 未配置'), 'prompt-expand：未配置 → 400「LLM 未配置」')

    // ---- env 注入 + fetch stub 捕获 → 成功径 ----
    env.llm.baseUrl = 'http://probe-llm.local/v1'
    env.llm.apiKey = 'probe-key'
    const chatCap: { req: { url: string; auth: string; body: any } | null } = { req: null }
    const chatStub = (async (input: any, init?: RequestInit): Promise<Response> => {
      chatCap.req = {
        url: String(input),
        auth: String((init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? ''),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '  扩写后的提示词：窗边的猫，柔光特写  ' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch
    globalThis.fetch = chatStub

    const ok1 = await jreq('POST', `/api/v1/nodes/${TL}/prompt-expand`, {})
    check(ok1.status === 200 && ok1.body?.prompt === '扩写后的提示词：窗边的猫，柔光特写', 'prompt-expand：成功径 → 200 且 trim')
    // 仓库 .env 可能覆盖 AGENT_LLM_MODEL（本探针仅覆盖 baseUrl/apiKey）→ 动态比对 env.llm.model
    check(ok1.body?.provider === 'env' && ok1.body?.model === env.llm.model, 'prompt-expand：provider/model 来源（env 兜底）')
    check(chatCap.req?.url === 'http://probe-llm.local/v1/chat/completions' && chatCap.req?.auth === 'Bearer probe-key', 'prompt-expand：请求 URL/Authorization')
    check(
      chatCap.req?.body?.messages?.[1]?.content === '原提示词：\n窗边的猫' && !String(chatCap.req?.body?.messages?.[1]?.content).includes('补充要求'),
      'prompt-expand：user 消息 = 原提示词（无 instruction）',
    )
    check(chatCap.req?.body?.max_tokens === 2000 && chatCap.req?.body?.stream === false, 'prompt-expand：max_tokens 2000 / stream false')

    // instruction 透传 + gen 源
    const ok2 = await jreq('POST', `/api/v1/nodes/${TL}/prompt-expand`, { instruction: ' 更诗意 ' })
    check(ok2.status === 200 && String(chatCap.req?.body?.messages?.[1]?.content).includes('补充要求：更诗意'), 'prompt-expand：instruction trim 后透传（补充要求）')
    const ok3 = await jreq('POST', `/api/v1/nodes/${GL}/prompt-expand`, {})
    check(ok3.status === 200 && chatCap.req?.body?.messages?.[1]?.content === '原提示词：\n生成词', 'prompt-expand：gen 节点（spec.prompt）源 → 200')

    // 不落库 + 用量落库（3 次成功 × tokens_in/out）
    const d = await jreq('GET', `/api/v1/canvases/${C}`)
    check(docNode(d.body, TL)?.spec?.text === '窗边的猫' && docNode(d.body, GL)?.spec?.prompt === '生成词', 'prompt-expand：不落库（节点 spec 不变）')
    const us = await db.select().from(usageRecords).where(eq(usageRecords.projectId, PID))
    check(us.length === 6 && us.filter((r) => r.unit === 'tokens_in').length === 3 && us.every((r) => r.kind === 'llm'), 'prompt-expand：用量 3×2 行（tokens_in/out）')

    // ---- 错误族 ----
    const e1 = await jreq('POST', `/api/v1/nodes/${NE}/prompt-expand`, {})
    check(e1.status === 400 && String(e1.body?.error?.message ?? '').includes('仅文本节点或生成节点可扩写提示词'), 'prompt-expand：entity 节点 → 400')
    const e2 = await jreq('POST', `/api/v1/nodes/${TL_EMPTY}/prompt-expand`, {})
    check(e2.status === 400 && String(e2.body?.error?.message ?? '').includes('内容为空'), 'prompt-expand：空内容 → 400')
    const e3 = await jreq('POST', `/api/v1/nodes/${TL}/prompt-expand`, { instruction: 5 })
    check(e3.status === 400 && String(e3.body?.error?.message ?? '').includes('instruction 需为字符串'), 'prompt-expand：instruction 非串 → 400')
    check((await jreq('POST', `/api/v1/nodes/999999/prompt-expand`, {})).status === 404, 'prompt-expand：节点不存在 → 404')

    // ---- 还原网络与 LLM 配置 ----
    globalThis.fetch = stubFetch
    env.llm.baseUrl = ''
    env.llm.apiKey = ''

    // ---- extract：gen 源（无 body 宽容读体）----
    const gx = (await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'gen', spec: { genKind: 'image', prompt: '提示源' }, x: 100, y: 500 })).body.node.id
    const ex1 = await jreq('POST', `/api/v1/nodes/${gx}/extract`)
    const ex1Spec = JSON.parse(String(ex1.body?.node?.spec ?? 'null')) as { text?: string } | null // API 返回原始 DB 行，spec 为 JSON 字符串
    check(ex1.status === 201 && ex1.body?.node?.kind === 'text' && ex1Spec?.text === '提示源', 'extract：gen 源 → 201 文本节点（无 body）')
    check(ex1.body?.node?.x === 360 && ex1.body?.node?.y === 500, 'extract：缺省位置 = 源右侧 +260')
    const ex2 = await jreq('POST', `/api/v1/nodes/${gx}/extract`, { x: 42, y: 24 })
    check(ex2.status === 201 && ex2.body?.node?.x === 42 && ex2.body?.node?.y === 24, 'extract：显式 x/y 生效')

    // ---- extract：文本资产源 ----
    ensureProjectDirs(PID) // texts/ 目录（探针隔离 workspace 下按需创建）
    const AT2 = await mkAsset(PID, 'text', '文本资产甲')
    const relT = join(String(PID), 'texts', 'probe-text.txt')
    writeFileSync(absPathOf(relT), '文本资产内容')
    await db.update(assets).set({ relPath: relT }).where(eq(assets.id, AT2))
    const NA = await mkNode({ kind: 'asset', assetId: AT2, x: 0, y: 600 })
    const ex3 = await jreq('POST', `/api/v1/nodes/${NA}/extract`, {})
    const ex3Spec = JSON.parse(String(ex3.body?.node?.spec ?? 'null')) as { text?: string } | null
    check(ex3.status === 201 && ex3Spec?.text === '文本资产内容', 'extract：文本资产全文 → 文本节点')

    // ---- extract：错误族 ----
    const AT3a = await mkAsset(PID, 'text', '文本资产乙')
    const AT3b = await mkAsset(PID, 'text', '文本资产丙')
    const PIMG = await mkAsset(PID, 'image', '提取用图')
    await db.update(assets).set({ relPath: join(String(PID), 'texts', 'gone-text.txt') }).where(eq(assets.id, AT3b))
    const badA = await mkNode({ kind: 'asset', assetId: PIMG, x: 0, y: 700 })
    const badB = await mkNode({ kind: 'asset', assetId: AT3a, x: 0, y: 800 })
    const badC = await mkNode({ kind: 'asset', assetId: AT3b, x: 0, y: 900 })
    const badD = await mkNode({ kind: 'run', runId: RUN1, x: 0, y: 1000 })
    check((await jreq('POST', `/api/v1/nodes/${badA}/extract`, {})).status === 400, 'extract：图片资产 → 400')
    check(String((await jreq('POST', `/api/v1/nodes/${badB}/extract`, {})).body?.error?.message ?? '').includes('缺少文件路径'), 'extract：无 relPath → 400 缺少文件路径')
    check(String((await jreq('POST', `/api/v1/nodes/${badC}/extract`, {})).body?.error?.message ?? '').includes('读取失败'), 'extract：文件缺失 → 400 读取失败')
    check((await jreq('POST', `/api/v1/nodes/${badD}/extract`, {})).status === 400, 'extract：run 节点 → 400')
    check((await jreq('POST', `/api/v1/nodes/999999/extract`, {})).status === 404, 'extract：节点不存在 → 404')
  }
}
