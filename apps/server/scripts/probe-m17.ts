/**
 * M17 探针（创作工作台：全型节点 / 端口矩阵 v2 / 输入计划 v2 / 变体采纳 / 批量操控 / 运行节点 / 导出 / AI 辅助 / 回归）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m17.ts [--section=node-kinds|port-v2|input-v2|batch-ops|variant-adopt|run-node|export|llm-assist]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录（独立 studio.db +
 * workspace），不触碰开发库（同 probe-m2a~m16）。globalThis.fetch stub 兜底（零网络、零计费）。
 * 画布 HTTP 全链经 app.request 内存执行。
 *
 * section（默认 all）：
 *   node-kinds     text/entity/run 建/改/删全链 + 项目域/全局实体 + run 派生读模型（status/steps）+
 *                  seq / spec / adoptedTaskId 错误族 + bad spec 宽容
 *   port-v2        端口矩阵 v2 全组合（prompt/video/audio 端口 × from 类型；entity→reference；run 双向拒连；
 *                  各端口上限；环/自环/跨画布/重复边回归；spec 损坏目标）
 *   input-v2       planNodeInputs v2 纯矩阵（prompt 覆盖 trim / entity 展开截断 + notes / compose 边序）+
 *                  specProblems（audio/compose）+ pickDisplayTask 采纳优先矩阵 + 读模型与 loadInputPlan 集成
 *   batch-ops      computeArrange / chainPortCandidates 纯矩阵 + batch 预校验回滚 + delete 级联计数 +
 *                  copy 深拷/内部边重映射 + chain 全因 skip 记账 + arrange 各 mode 落库 + canvases/run started/skipped +
 *                  restore-claim 快照重建认领（任务历史迁移 / 前置校验不残留 / 错误族）
 *   variant-adopt  parseResolution/buildComposeArgs/extendTaskParams 快照 + variants=2/4 建 N 任务 + busy/错误族 +
 *                  无 body 再跑 + 取消清理 + 终态后重跑 + 变体画廊/采纳闭环
 *   run-node       多 run 节点批查独立派生 + run 行删除宽容降级 + title/seq/坐标 PATCH + batch 移动 + copy 深拷
 *   export         真实文件 zip：条目命名/重名递增/seq 序 + manifest files/skipped + 采纳优先后打包 +
 *                  软删/无路径/缺文件/无产物/实体/运行 skipped + 子集/空数组/未知节点错误族 + 下载链路
 *   llm-assist     prompt-expand（未配置 400 / env 注入 + fetch stub 成功径 / instruction 透传 / 不落库 /
 *                  用量落库）+ extract 双径（gen/文本资产）+ 错误族
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'
import type { NodeSpec } from '../src/services/creation'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
const TMP_PREFIX = 'acs-probe-m17-'
for (const name of readdirSync(tmpdir())) {
  if (name.startsWith(TMP_PREFIX)) {
    try {
      rmSync(join(tmpdir(), name), { recursive: true, force: true })
    } catch {
      /* 占用中（并行探针）→ 跳过 */
    }
  }
}
const TMP = mkdtempSync(join(tmpdir(), TMP_PREFIX))
process.env.CSTUDIO_ROOT = REPO_ROOT
process.env.CSTUDIO_DATA = join(TMP, 'data')
process.env.CSTUDIO_WORKSPACE = join(TMP, 'workspace')
mkdirSync(process.env.CSTUDIO_DATA, { recursive: true })
mkdirSync(process.env.CSTUDIO_WORKSPACE, { recursive: true })

const SECTIONS = ['node-kinds', 'port-v2', 'input-v2', 'batch-ops', 'variant-adopt', 'run-node', 'export', 'llm-assist'] as const

// ---- fetch stub：兜底安全网（本探针零真实外发请求）----
const stubFetch = (async (): Promise<Response> => {
  return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

/** 任务收敛轮询间隔（对齐 probe-m16 执行通道模式） */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function main(): Promise<void> {
  const origFetch = globalThis.fetch
  globalThis.fetch = stubFetch

  // src 模块全部动态加载（环境变量已隔离）
  const { db, initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')
  const { assets, canvasEdges, canvasNodes, characters, genTasks, pipelineRuns, pipelineSteps, projects, usageRecords } = await import('../src/db/schema')
  const { eq, inArray } = await import('drizzle-orm')
  const { app } = await import('../src/app')
  const { env } = await import('../src/env')
  const { loadInputPlan, pickDisplayTask, planNodeInputs, specProblems } = await import('../src/services/creation')
  const { chainPortCandidates, computeArrange } = await import('../src/services/creation-ops')
  const { buildComposeArgs, extendTaskParams, parseResolution } = await import('../src/services/creation-gen')
  const { absPathOf, ensureProjectDirs } = await import('../src/services/storage')

  const log = createLogger('probe-m17')
  let failed = 0
  const check = (cond: boolean, msg: string): void => {
    if (cond) log.info(`  PASS  ${msg}`)
    else {
      failed += 1
      log.error(`  FAIL  ${msg}`)
    }
  }

  // ---- setup：隔离库 + 种子工厂 ----
  await initDb()
  const T0 = 1_700_000_000_000

  const mkProject = async (name: string): Promise<number> =>
    (
      await db
        .insert(projects)
        .values({ name, genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!.id

  const mkAsset = async (projectId: number, kind: string, name: string, purpose?: string): Promise<number> => {
    const mime = kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mpeg' : 'text/plain'
    return (
      await db
        .insert(assets)
        .values({ projectId, kind, name, purpose: purpose ?? null, mime, width: 512, height: 512, createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!.id
  }

  const mkTask = async (
    projectId: number,
    opts: { canvasNodeId?: number; status: string; resultAssetId?: number },
  ): Promise<number> =>
    (
      await db
        .insert(genTasks)
        .values({
          projectId,
          runId: null,
          stepId: null,
          canvasNodeId: opts.canvasNodeId ?? null,
          kind: 'image',
          params: '{}',
          status: opts.status,
          resultAssetId: opts.resultAssetId ?? null,
          createdAt: T0,
          updatedAt: T0,
        })
        .returning()
    )[0]!.id

  const mkEntity = async (projectId: number | null, name: string, refAssetIds: number[]): Promise<number> =>
    (
      await db
        .insert(characters)
        .values({
          projectId,
          kind: 'character',
          name,
          aliases: '[]',
          states: '[]',
          refAssetIds: JSON.stringify(refAssetIds),
          meta: '{}',
          createdAt: T0,
          updatedAt: T0,
        })
        .returning()
    )[0]!.id

  const mkRun = async (projectId: number, templateKey: string, status: string, steps: string[]): Promise<number> => {
    const [row] = await db
      .insert(pipelineRuns)
      .values({
        projectId,
        templateKey,
        status,
        input: '{}',
        createdAt: T0,
        updatedAt: T0,
        startedAt: T0,
        completedAt: status === 'completed' ? T0 + 1000 : null,
      })
      .returning()
    let seq = 1
    for (const st of steps) {
      await db.insert(pipelineSteps).values({
        runId: row!.id,
        seq,
        stepKey: `s${seq}`,
        actionKey: 'llm_text',
        status: st,
        createdAt: T0,
        updatedAt: T0,
      })
      seq += 1
    }
    return row!.id
  }

  /** app.request 内存 HTTP（零网络）：返回状态码 + JSON body */
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
      /* 非 JSON 响应 */
    }
    return { status: res.status, body: json }
  }

  const docNode = (body: any, id: number): any => (Array.isArray(body?.nodes) ? body.nodes : []).find((n: any) => n.id === id)

  /** 任务终态等待（succeeded/failed/cancelled；deadline 到点返回当时状态——宽容不抛） */
  const settleTasks = async (ids: number[]): Promise<Map<number, string>> => {
    const deadline = Date.now() + 25_000
    for (;;) {
      const rows = await db.select({ id: genTasks.id, status: genTasks.status }).from(genTasks).where(inArray(genTasks.id, ids))
      const m = new Map(rows.map((r) => [r.id, r.status]))
      if ([...m.values()].every((s) => s === 'succeeded' || s === 'failed' || s === 'cancelled')) return m
      if (Date.now() > deadline) return m
      await sleep(300)
    }
  }

  // ---- 种子数据 ----
  const PID = await mkProject('M17 探针')
  const OTHER = await mkProject('M17 探针-他项目')
  const A1 = await mkAsset(PID, 'image', '图甲', 'creation')
  const A2 = await mkAsset(PID, 'image', '图乙', 'creation')
  const A3 = await mkAsset(PID, 'image', '图丙', 'creation')
  const AV = await mkAsset(PID, 'video', '视频甲')
  const AA = await mkAsset(PID, 'audio', '音频甲')
  const AT = await mkAsset(PID, 'text', '文本资产')
  const A_OTHER = await mkAsset(OTHER, 'image', '他项目图')
  const ENT = await mkEntity(PID, '角色甲', [A1, A2])
  const ENT_EMPTY = await mkEntity(PID, '角色乙', [])
  const ENT_G = await mkEntity(null, '全局角色', [A1])
  const ENT_OTHER = await mkEntity(OTHER, '他项目角色', [A_OTHER])
  const RUN1 = await mkRun(PID, 'mengbao-episode', 'running', ['succeeded', 'succeeded', 'running'])
  const RUN2 = await mkRun(PID, 'mengbao-episode', 'completed', ['succeeded', 'failed'])
  const RUN_OTHER = await mkRun(OTHER, 'mengbao-episode', 'completed', ['succeeded'])

  // ================= sections =================

  /** ① node-kinds：text/entity/run 建/改/删全链 + 派生读模型 + 错误族 */
  const sectionNodeKinds = async (): Promise<void> => {
    const c1 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '节点全型' })
    const C: number = c1.body.canvas.id

    // ---- text 节点 ----
    const nt = await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'text', spec: { text: '窗边的猫' }, x: 10, y: 10 })
    check(nt.status === 201 && nt.body?.node?.kind === 'text', 'POST 文本节点 → 201')
    const NT: number = nt.body.node.id
    let d = await jreq('GET', `/api/v1/canvases/${C}`)
    let dn = docNode(d.body, NT)
    check(dn?.spec?.text === '窗边的猫' && dn?.readiness?.ready === true && dn?.assetId === null, '文本节点读模型：spec.text / ready / assetId null')
    check(dn?.canRun === null && dn?.editCapability === null && dn?.title === `文本 #${NT}`, '文本节点：canRun/editCapability null + 默认标题')
    const tu = await jreq('PATCH', `/api/v1/nodes/${NT}`, { spec: { text: '改后文案' } })
    check(tu.status === 200, 'PATCH 文本节点 spec → 200')
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    check(docNode(d.body, NT)?.spec?.text === '改后文案', '文本节点 spec 持久化')
    check((await jreq('PATCH', `/api/v1/nodes/${NT}`, { spec: { text: 5 } })).status === 400, 'PATCH 文本 spec 非字符串 → 400')
    check((await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'text', spec: 'x', x: 0, y: 0 })).status === 400, 'POST 文本节点非对象 spec → 400')

    // 空文本 → readiness；坏 spec 宽容
    const nt2 = await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'text', spec: { text: '  ' }, x: 10, y: 100 })
    const NT2: number = nt2.body.node.id
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    dn = docNode(d.body, NT2)
    check(dn?.readiness?.ready === false && dn?.readiness?.problems?.some((p: string) => p.includes('文本为空')), '文本节点空文本 → readiness 不 ready')
    await db.update(canvasNodes).set({ spec: '{bad' }).where(eq(canvasNodes.id, NT2))
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    dn = docNode(d.body, NT2)
    check(dn?.spec === null && typeof dn?.specError === 'string' && dn?.readiness?.ready === false, '文本节点坏 spec → specError 宽容')
    await db.update(canvasNodes).set({ spec: JSON.stringify({ text: ' ' }) }).where(eq(canvasNodes.id, NT2))

    // ---- entity 节点 ----
    const ne = await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'entity', entityId: ENT, x: 300, y: 10 })
    check(ne.status === 201 && ne.body?.node?.kind === 'entity', 'POST 实体节点（项目实体）→ 201')
    const NE: number = ne.body.node.id
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    dn = docNode(d.body, NE)
    check(dn?.spec?.entityId === ENT && dn?.entity?.name === '角色甲' && dn?.entity?.refCount === 2, '实体节点读模型：entity 摘要（name/refCount）')
    check(dn?.entity?.asset?.id === A1 && dn?.title === '角色甲', '实体节点：首张参考图缩略 + 默认标题=实体名')
    check((await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'entity', entityId: ENT_G, x: 300, y: 120 })).status === 201, 'POST 实体节点（全局实体）→ 201（允许）')
    const neEmpty = await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'entity', entityId: ENT_EMPTY, x: 300, y: 240 })
    const NE_EMPTY: number = neEmpty.body.node.id
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    check(docNode(d.body, NE_EMPTY)?.readiness?.problems?.some((p: string) => p.includes('实体无参考图')), '实体无参考图 → readiness problem')
    check((await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'entity', entityId: ENT_OTHER, x: 0, y: 0 })).status === 400, '实体节点他项目实体 → 400（项目域）')
    check((await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'entity', entityId: 999999, x: 0, y: 0 })).status === 400, '实体节点不存在 entityId → 400')
    check((await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'entity', entityId: 'x', x: 0, y: 0 })).status === 400, '实体节点非法 entityId → 400')
    // 实体删除 → 宽容降级
    const entTmp = await mkEntity(PID, '临时实体', [A1])
    const neTmp = await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'entity', entityId: entTmp, x: 0, y: 400 })
    const NE_TMP: number = neTmp.body.node.id
    await db.delete(characters).where(eq(characters.id, entTmp))
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    check(docNode(d.body, NE_TMP)?.readiness?.problems?.some((p: string) => p.includes('实体不存在或已删除')), '实体删除后 → readiness「实体不存在或已删除」')

    // ---- run 节点 ----
    const nr = await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'run', runId: RUN1, x: 600, y: 10 })
    check(nr.status === 201 && nr.body?.node?.kind === 'run', 'POST 运行节点 → 201')
    const NRun: number = nr.body.node.id
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    dn = docNode(d.body, NRun)
    check(dn?.spec?.runId === RUN1 && dn?.run?.status === 'running' && dn?.run?.templateKey === 'mengbao-episode', '运行节点读模型：run 摘要（status/templateKey）')
    check(dn?.run?.steps?.total === 3 && dn?.run?.steps?.succeeded === 2, '运行节点：steps 计数 {succeeded:2,total:3}')
    check(dn?.title === `运行 #${RUN1}` && dn?.canRun === null, '运行节点：默认标题 + canRun null')
    check((await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'run', runId: RUN_OTHER, x: 0, y: 0 })).status === 400, '运行节点他项目 run → 400')
    check((await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'run', runId: 999999, x: 0, y: 0 })).status === 400, '运行节点不存在 runId → 400')
    const nr2 = await jreq('POST', `/api/v1/canvases/${C}/nodes`, { kind: 'run', runId: RUN2, x: 600, y: 120 })
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    dn = docNode(d.body, nr2.body.node.id)
    check(dn?.run?.status === 'completed' && dn?.run?.steps?.succeeded === 1 && dn?.run?.steps?.total === 2, '运行节点：终态派生（completed + 1/2）')

    // ---- spec / seq / adoptedTaskId 错误族 ----
    check((await jreq('PATCH', `/api/v1/nodes/${NRun}`, { spec: { runId: RUN2 } })).status === 400, 'PATCH run 节点 spec → 400')
    check((await jreq('PATCH', `/api/v1/nodes/${NE}`, { spec: { entityId: ENT_G } })).status === 400, 'PATCH entity 节点 spec → 400')
    check((await jreq('PATCH', `/api/v1/nodes/${NT}`, { adoptedTaskId: 1 })).status === 400, 'PATCH 文本节点 adoptedTaskId → 400（仅 gen）')
    const seqOk = await jreq('PATCH', `/api/v1/nodes/${NT}`, { seq: 3 })
    check(seqOk.status === 200, 'PATCH seq=3 → 200')
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    check(docNode(d.body, NT)?.seq === 3, 'seq 持久化到读模型')
    check((await jreq('PATCH', `/api/v1/nodes/${NT}`, { seq: 0 })).status === 400, 'PATCH seq=0 → 400')
    check((await jreq('PATCH', `/api/v1/nodes/${NT}`, { seq: 'a' })).status === 400, 'PATCH seq 非数字 → 400')
    check((await jreq('PATCH', `/api/v1/nodes/${NT}`, { seq: null })).status === 200, 'PATCH seq=null → 200（清除）')
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    check(docNode(d.body, NT)?.seq === null, 'seq 清除 → null')

    // ---- 删除族 ----
    check((await jreq('DELETE', `/api/v1/nodes/${NRun}`)).status === 200, 'DELETE 运行节点 → 200')
    check((await jreq('DELETE', `/api/v1/nodes/999999`)).status === 404, 'DELETE 不存在节点 → 404')
    check((await jreq('PATCH', `/api/v1/nodes/999999`, { x: 1 })).status === 404, 'PATCH 不存在节点 → 404')
  }

  /** ② port-v2：端口矩阵 v2 全组合 + run 拒连 + 环/自环/跨画布/重复边回归 */
  const sectionPortV2 = async (): Promise<void> => {
    const c1 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '端口矩阵 v2' })
    const C: number = c1.body.canvas.id
    const mkNode = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${C}/nodes`, body)).body.node.id
    const edge = (from: number, to: number, port: string) => jreq('POST', `/api/v1/canvases/${C}/edges`, { from, to, port })

    const NAI = await mkNode({ kind: 'asset', assetId: A1, x: 0, y: 0 }) // 图片素材
    const NAV = await mkNode({ kind: 'asset', assetId: AV, x: 0, y: 100 }) // 视频素材
    const NAA = await mkNode({ kind: 'asset', assetId: AA, x: 0, y: 200 }) // 音频素材
    const NAT = await mkNode({ kind: 'asset', assetId: AT, x: 0, y: 300 }) // 文本资产节点
    const NT = await mkNode({ kind: 'text', spec: { text: '提示词甲' }, x: 100, y: 0 })
    const NT2 = await mkNode({ kind: 'text', spec: { text: '提示词乙' }, x: 100, y: 100 })
    const NE = await mkNode({ kind: 'entity', entityId: ENT, x: 100, y: 200 })
    const NGI = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: 'P' }, x: 300, y: 0 })
    const NGV = await mkNode({ kind: 'gen', spec: { genKind: 'video', prompt: 'V' }, x: 300, y: 100 })
    const NGA = await mkNode({ kind: 'gen', spec: { genKind: 'audio', prompt: '朗读' }, x: 300, y: 200 })
    const NGC = await mkNode({ kind: 'gen', spec: { genKind: 'compose' }, x: 300, y: 300 })
    const NGC2 = await mkNode({ kind: 'gen', spec: { genKind: 'compose' }, x: 300, y: 400 })
    const NRun = await mkNode({ kind: 'run', runId: RUN1, x: 600, y: 0 })

    // ---- reference：图片素材 / entity 源 + from 侧类型 ----
    check((await edge(NAI, NGI, 'reference')).status === 201, 'reference：图片素材 → image gen → 201')
    check((await edge(NE, NGI, 'reference')).status === 201, 'reference：entity → image gen → 201')
    check((await edge(NE, NGV, 'reference')).status === 201, 'reference：entity → video gen → 201')
    const eRefBad = await edge(NGV, NGI, 'reference')
    check(
      eRefBad.status === 400 && String(eRefBad.body?.error?.message ?? '').includes('参考图来源需为图片素材/生成图/实体节点'),
      'reference：视频 gen 源 → 400（from 侧文案=期望类型清单）',
    )
    check((await edge(NGA, NGI, 'reference')).status === 400, 'reference：音频 gen 源 → 400')
    check((await edge(NT, NGI, 'reference')).status === 400, 'reference：文本节点源 → 400')
    check((await edge(NGI, NGV, 'reference')).status === 201, 'reference：图片 gen → video gen（第 2 条）→ 201')
    const NGI2 = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: 'P2' }, x: 300, y: 500 })
    check((await edge(NGI2, NGV, 'reference')).status === 400, 'reference：video gen 第 3 条 → 400（上限 2）')

    // ---- prompt：仅 text 节点源 × image/video/audio 目标 ----
    check((await edge(NT, NGI, 'prompt')).status === 201, 'prompt：text → image gen → 201')
    check((await edge(NT, NGI, 'prompt')).status === 400, 'prompt：重复边 → 400')
    check((await edge(NT2, NGI, 'prompt')).status === 400, 'prompt：同目标第二条 → 400（≤1）')
    check((await edge(NT, NGA, 'prompt')).status === 201, 'prompt：text → audio gen → 201')
    check((await edge(NT, NGC, 'prompt')).status === 400, 'prompt：compose 目标 → 400（仅 image/video/audio）')
    check((await edge(NAI, NGV, 'prompt')).status === 400, 'prompt：图片素材源 → 400（仅文本节点）')
    check((await edge(NAT, NGA, 'prompt')).status === 400, 'prompt：文本资产节点源 → 400（仅文本节点）')
    check((await edge(NE, NGA, 'prompt')).status === 400, 'prompt：实体源 → 400')

    // ---- video：仅 compose 目标 × 视频素材/视频 gen/compose 源 ----
    check((await edge(NAV, NGC, 'video')).status === 201, 'video：视频素材 → compose → 201')
    check((await edge(NGV, NGC, 'video')).status === 201, 'video：视频 gen → compose → 201')
    check((await edge(NGC2, NGC, 'video')).status === 201, 'video：compose 产视频 → compose → 201（链式）')
    check((await edge(NAI, NGC, 'video')).status === 400, 'video：图片素材源 → 400（from 侧类型）')
    check((await edge(NAI, NGI, 'video')).status === 400, 'video：非 compose 目标 → 400')
    const NGV2 = await mkNode({ kind: 'gen', spec: { genKind: 'video', prompt: 'V2' }, x: 300, y: 600 })
    check((await edge(NGV2, NGC, 'video')).status === 201, 'video：第 4 条 → 201')
    const NGV3 = await mkNode({ kind: 'gen', spec: { genKind: 'video', prompt: 'V3' }, x: 300, y: 700 })
    check((await edge(NGV3, NGC, 'video')).status === 400, 'video：第 5 条 → 400（上限 4）')

    // ---- audio：仅 compose 目标 × 音频素材/音频 gen 源 ----
    check((await edge(NAA, NGC, 'audio')).status === 201, 'audio：音频素材 → compose → 201')
    check((await edge(NGA, NGC, 'audio')).status === 201, 'audio：音频 gen → compose → 201')
    check((await edge(NAV, NGC, 'audio')).status === 400, 'audio：视频素材源 → 400（from 侧类型）')
    check((await edge(NAA, NGI, 'audio')).status === 400, 'audio：非 compose 目标 → 400')
    const NGA3 = await mkNode({ kind: 'gen', spec: { genKind: 'audio', prompt: 'A3' }, x: 300, y: 800 })
    const NGA4 = await mkNode({ kind: 'gen', spec: { genKind: 'audio', prompt: 'A4' }, x: 300, y: 900 })
    check(
      (await edge(NGA3, NGC, 'audio')).status === 201 && (await edge(NGA4, NGC, 'audio')).status === 201,
      'audio：第 3/4 条 → 201',
    )
    const NGA5 = await mkNode({ kind: 'gen', spec: { genKind: 'audio', prompt: 'A5' }, x: 300, y: 1000 })
    check((await edge(NGA5, NGC, 'audio')).status === 400, 'audio：第 5 条 → 400（上限 4）')

    // ---- run 双向拒连 ----
    check((await edge(NRun, NGI, 'reference')).status === 400, 'run 作源拒连 → 400')
    check((await edge(NGI, NRun, 'reference')).status === 400, 'run 作目标拒连 → 400')
    check((await edge(NRun, NGC, 'video')).status === 400, 'run → compose 任意端口拒连 → 400')

    // ---- 自环 / 重复边 / 环 / 跨画布（回归） ----
    check((await edge(NGI, NGI, 'reference')).status === 400, '自环 → 400')
    const NCa = await mkNode({ kind: 'gen', spec: { genKind: 'compose' }, x: 300, y: 1100 })
    const NCb = await mkNode({ kind: 'gen', spec: { genKind: 'compose' }, x: 300, y: 1200 })
    check((await edge(NCa, NCb, 'video')).status === 201, '环构造：NCa → NCb → 201')
    const eCycle = await edge(NCb, NCa, 'video')
    check(eCycle.status === 400 && String(eCycle.body?.error?.message ?? '').includes('循环引用'), '环（NCa↔NCb）→ 400（环检测文案）')
    check((await edge(NCb, NGV, 'video')).status === 400, 'video：视频 gen 目标 → 400（仅 compose）')
    const c2 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '端口矩阵 v2-乙' })
    const C2: number = c2.body.canvas.id
    const NX = (await jreq('POST', `/api/v1/canvases/${C2}/nodes`, { kind: 'gen', spec: { genKind: 'image', prompt: 'X' }, x: 0, y: 0 })).body.node.id
    check((await edge(NX, NGI, 'reference')).status === 400, '跨画布 from → 400')
    check((await jreq('POST', `/api/v1/canvases/${C2}/edges`, { from: NGI, to: NX, port: 'reference' })).status === 400, '跨画布 to → 400')

    // ---- spec 损坏目标 / 非法端口 ----
    await db.update(canvasNodes).set({ spec: '{bad' }).where(eq(canvasNodes.id, NGI2))
    check((await edge(NAI, NGI2, 'reference')).status === 400, '目标 spec 损坏 → 400（无法连线）')
    await db.update(canvasNodes).set({ spec: JSON.stringify({ genKind: 'image', prompt: 'P2' }) }).where(eq(canvasNodes.id, NGI2))
    check((await edge(NAI, NGI, 'foo')).status === 400, '非法端口 → 400')
  }

  /** ③ input-v2：planNodeInputs v2 / specProblems / pickDisplayTask 纯矩阵 + 读模型与执行侧集成 */
  const sectionInputV2 = async (): Promise<void> => {
    const img: NodeSpec = { genKind: 'image', prompt: '' }
    const vid: NodeSpec = { genKind: 'video', prompt: 'V' }
    const audio: NodeSpec = { genKind: 'audio', prompt: '' }
    const compose: NodeSpec = { genKind: 'compose', prompt: '' }
    const up = (m: Array<[number, any]>): Map<number, any> => new Map(m)

    // ---- prompt 覆盖语义 ----
    const pP = planNodeInputs(img, 100, [{ from: 9, to: 100, port: 'prompt' }], up([[9, { assetId: null, mediaKind: null, text: '  重写的词  ' }]]))
    check(pP.promptText === '重写的词' && pP.problems.length === 0, 'prompt 端口：text 覆盖 + trim + 无问题')
    check(specProblems(img, pP.promptText != null).length === 0, 'specProblems：有 prompt 输入 → 空 spec.prompt 不报')
    const pPe = planNodeInputs(img, 100, [{ from: 9, to: 100, port: 'prompt' }], up([[9, { assetId: null, mediaKind: null, text: ' ' }]]))
    check(pPe.promptText === null && pPe.problems.some((x) => x.includes('暂无文本或为空')), 'prompt 端口：空文本 → problem')
    check(specProblems(img, false).some((x) => x.includes('prompt 为空')), 'specProblems：无 prompt 输入 → 报空 prompt')

    // ---- entity 展开截断 ----
    const refs8 = [1, 2, 3, 4, 5, 6, 7, 8]
    const pE = planNodeInputs(img, 100, [{ from: 7, to: 100, port: 'reference' }], up([[7, { assetId: null, mediaKind: null, refAssetIds: refs8 }]]))
    check(pE.referenceAssetIds.length === 6 && JSON.stringify(pE.referenceAssetIds) === '[1,2,3,4,5,6]', 'entity 展开：image cap 6 截断')
    check(pE.notes.some((x) => x.includes('超上限 6 张，已截断 2 张')), 'entity 展开：notes 记截断数')
    const pEV = planNodeInputs(vid, 100, [{ from: 7, to: 100, port: 'reference' }], up([[7, { assetId: null, mediaKind: null, refAssetIds: refs8 }]]))
    check(
      pEV.referenceAssetIds.length === 2 && pEV.notes.some((x) => x.includes('超上限 2 张，已截断 6 张')),
      'entity 展开：video cap 2 截断 + notes',
    )
    const pEM = planNodeInputs(
      img,
      100,
      [
        { from: 7, to: 100, port: 'reference' },
        { from: 8, to: 100, port: 'reference' },
      ],
      up([
        [7, { assetId: null, mediaKind: null, refAssetIds: refs8 }],
        [8, { assetId: 55, mediaKind: 'image' }],
      ]),
    )
    check(
      pEM.referenceAssetIds.length === 6 && pEM.problems.some((x) => x.includes('参考图超过上限 6 张')),
      'entity 占满 cap → 普通 reference 源 problem',
    )

    // ---- compose 输入边序 / 缺失 ----
    const pC = planNodeInputs(
      compose,
      100,
      [
        { from: 1, to: 100, port: 'video' },
        { from: 2, to: 100, port: 'audio' },
        { from: 3, to: 100, port: 'video' },
      ],
      up([
        [1, { assetId: 201, mediaKind: 'video' }],
        [2, { assetId: 301, mediaKind: 'audio' }],
        [3, { assetId: 202, mediaKind: 'video' }],
      ]),
    )
    check(JSON.stringify(pC.videoAssetIds) === '[201,202]' && JSON.stringify(pC.audioAssetIds) === '[301]', 'compose：video/audio 集合（边序）')
    check(pC.problems.length === 0 && specProblems(compose).length === 0, 'compose：齐备 → 无 problems（specProblems 空）')
    const pCMiss = planNodeInputs(compose, 100, [], up([]))
    check(pCMiss.problems.some((x) => x.includes('合成节点缺少视频输入连线')), 'compose：无 video 输入 → problem')
    const pCBad = planNodeInputs(compose, 100, [{ from: 1, to: 100, port: 'video' }], up([[1, { assetId: 55, mediaKind: 'image' }]]))
    check(
      pCBad.problems.some((x) => x.includes('不能作为视频输入（仅视频）')) && !pCBad.problems.some((x) => x.includes('缺少视频输入连线')),
      'compose：非视频产物 → problem 且不重复报缺',
    )
    const pABad = planNodeInputs(compose, 100, [{ from: 2, to: 100, port: 'audio' }], up([[2, { assetId: 55, mediaKind: 'video' }]]))
    check(pABad.problems.some((x) => x.includes('不能作为音频输入（仅音频）')), 'compose：非音频产物入 audio 端口 → problem')

    // ---- specProblems：audio / 空文本 ----
    check(specProblems(audio).some((x) => x.includes('朗读文本为空')), 'specProblems：audio 空 prompt → 朗读文本为空')
    check(specProblems(audio, true).length === 0, 'specProblems：audio + prompt 输入 → 不报')

    // ---- pickDisplayTask 矩阵 ----
    const T = (id: number, status: string, asset: number | null): { id: number; status: string; resultAssetId: number | null } => ({
      id,
      status,
      resultAssetId: asset,
    })
    const desc = [T(30, 'processing', null), T(29, 'succeeded', 900), T(28, 'succeeded', 901), T(27, 'succeeded', 902), T(26, 'failed', null)]
    check(pickDisplayTask(null, desc)?.id === 29, 'pickDisplayTask：无采纳 → 最新成功')
    check(pickDisplayTask(28, desc)?.id === 28, 'pickDisplayTask：采纳有效 → 采纳优先（非最新）')
    check(pickDisplayTask(26, desc)?.id === 29, 'pickDisplayTask：采纳 failed → 回退最新成功')
    check(pickDisplayTask(999, desc)?.id === 29, 'pickDisplayTask：采纳不存在 → 回退最新成功')
    const desc2 = [T(30, 'succeeded', null), ...desc]
    check(pickDisplayTask(null, desc2)?.id === 29, 'pickDisplayTask：成功但无产物 → 跳过')
    check(pickDisplayTask(null, [T(1, 'failed', null), T(2, 'processing', null)]) === null, 'pickDisplayTask：无成功 → null')

    // ---- 集成：读模型 + 执行侧（真实库全链） ----
    const c1 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '输入计划 v2' })
    const C: number = c1.body.canvas.id
    const mkNode = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${C}/nodes`, body)).body.node.id
    const edge = (from: number, to: number, port: string) => jreq('POST', `/api/v1/canvases/${C}/edges`, { from, to, port })

    const NA = await mkNode({ kind: 'asset', assetId: A1, x: 0, y: 0 })
    const NT = await mkNode({ kind: 'text', spec: { text: '窗边的猫' }, x: 100, y: 0 })
    const NT2 = await mkNode({ kind: 'text', spec: { text: ' ' }, x: 100, y: 100 })
    const G = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: '' }, x: 300, y: 0 })
    const G2 = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: '' }, x: 300, y: 100 })
    const G3 = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: 'D' }, x: 300, y: 200 })
    const GV = await mkNode({ kind: 'gen', spec: { genKind: 'video', prompt: 'V' }, x: 300, y: 300 })

    // prompt 端口供词 → 空 spec.prompt 不报 + ready
    await edge(NT, G, 'prompt')
    await edge(NA, G, 'reference')
    let d = await jreq('GET', `/api/v1/canvases/${C}`)
    let dn = docNode(d.body, G)
    check(dn?.readiness?.ready === true && !dn?.readiness?.problems?.some((p: string) => p.includes('prompt 为空')), '集成：prompt 端口供词 → 空 spec.prompt 不报 + ready')

    // 空文本 → problem
    await edge(NT2, G2, 'prompt')
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    check(docNode(d.body, G2)?.readiness?.problems?.some((p: string) => p.includes('暂无文本或为空')), '集成：空文本源 → 提示词来源 problem')

    // entity 截断 notes（video cap 2：ENT3 refs 3 张 → 截断 1）
    const ENT3 = await mkEntity(PID, '角色丙', [A1, A2, A3])
    const NE3 = await mkNode({ kind: 'entity', entityId: ENT3, x: 100, y: 300 })
    await edge(NE3, GV, 'reference')
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    dn = docNode(d.body, GV)
    check(dn?.readiness?.notes?.some((n: string) => n.includes('超上限 2 张，已截断 1 张')), '集成：entity→video gen 截断 notes 透传')
    check(dn?.readiness?.ready === true, '集成：截断仅 notes 不阻断 ready')

    // 执行侧 loadInputPlan：entity 展开同源
    const nodeRowV = (await db.select().from(canvasNodes).where(eq(canvasNodes.id, GV)))[0]!
    const incomingV = await db.select({ from: canvasEdges.from, to: canvasEdges.to, port: canvasEdges.port }).from(canvasEdges).where(eq(canvasEdges.to, GV))
    const planV = await loadInputPlan(nodeRowV, incomingV, { genKind: 'video', prompt: 'V' })
    check(
      JSON.stringify(planV.referenceAssetIds) === `[${A1},${A2}]` && planV.notes.some((n) => n.includes('已截断 1 张')),
      'loadInputPlan：entity 展开截断（执行侧同源）',
    )

    // 采纳优先：t1（旧，A1） vs t2（新，A2）
    const t1 = await mkTask(PID, { canvasNodeId: G, status: 'succeeded', resultAssetId: A1 })
    const t2 = await mkTask(PID, { canvasNodeId: G, status: 'succeeded', resultAssetId: A2 })
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    dn = docNode(d.body, G)
    check(dn?.displayTaskId === t2 && dn?.assetId === A2, '采纳优先：未采纳 → 最新成功（t2/A2）')
    check(dn?.results?.length === 2 && dn?.displayTask?.asset?.id === A2, '画廊：results 2 条 + displayTask 资产冗余')
    check((await jreq('PATCH', `/api/v1/nodes/${G}`, { adoptedTaskId: t1 })).status === 200, 'PATCH adoptedTaskId=t1 → 200')
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    dn = docNode(d.body, G)
    check(dn?.displayTaskId === t1 && dn?.assetId === A1 && dn?.latestTask?.id === t2, '采纳优先：displayTask=t1（latest 仍 t2）')

    // 下游引用 = 采纳产物（执行侧）
    await edge(G, G3, 'reference')
    const nodeRow3 = (await db.select().from(canvasNodes).where(eq(canvasNodes.id, G3)))[0]!
    const incoming3 = await db.select({ from: canvasEdges.from, to: canvasEdges.to, port: canvasEdges.port }).from(canvasEdges).where(eq(canvasEdges.to, G3))
    const plan3 = await loadInputPlan(nodeRow3, incoming3, { genKind: 'image', prompt: 'D' })
    check(JSON.stringify(plan3.referenceAssetIds) === `[${A1}]`, '执行侧：下游引用 = 采纳产物（A1）')

    // 采纳失败任务 / 他节点任务 / 清除回退
    const t3 = await mkTask(PID, { canvasNodeId: G, status: 'failed' })
    check((await jreq('PATCH', `/api/v1/nodes/${G}`, { adoptedTaskId: t3 })).status === 400, '采纳 failed 任务 → 400')
    const tOther = await mkTask(PID, { canvasNodeId: G2, status: 'succeeded', resultAssetId: A3 })
    check((await jreq('PATCH', `/api/v1/nodes/${G}`, { adoptedTaskId: tOther })).status === 400, '采纳他节点任务 → 400')
    check((await jreq('PATCH', `/api/v1/nodes/${G}`, { adoptedTaskId: null })).status === 200, '清除采纳 → 200')
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    check(docNode(d.body, G)?.displayTaskId === t2, '清除采纳 → 回退最新成功（t2）')
    const plan3b = await loadInputPlan(nodeRow3, incoming3, { genKind: 'image', prompt: 'D' })
    check(JSON.stringify(plan3b.referenceAssetIds) === `[${A2}]`, '执行侧：清除采纳 → 下游回退最新成功（A2）')

    // 成功但无产物不参与显示
    const t4 = await mkTask(PID, { canvasNodeId: G, status: 'succeeded' })
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    dn = docNode(d.body, G)
    check(dn?.displayTaskId === t2 && dn?.latestTask?.id === t4, '成功无产物 → 跳过（display 仍 t2 / latest t4）')
  }

  /** ④ batch-ops：批量操控（batch/delete/copy/chain/arrange/canvases-run）+ computeArrange/chainPortCandidates 纯矩阵 */
  const sectionBatchOps = async (): Promise<void> => {
    // ---- 纯函数：computeArrange ----
    const posEq = (p: Map<number, { x: number; y: number }>, id: number, x: number, y: number): boolean => {
      const v = p.get(id)
      return !!v && v.x === x && v.y === y
    }
    const Ln = [
      { id: 1, x: 500, y: 400, seq: null }, // 根
      { id: 2, x: 100, y: 100, seq: 2 }, // 1→2
      { id: 3, x: 200, y: 300, seq: 1 }, // 1→3
      { id: 4, x: 900, y: 900, seq: null }, // 1→2→4 与 1→4（最长路径=2）
    ]
    const Le = [
      { from: 1, to: 2 },
      { from: 1, to: 3 },
      { from: 2, to: 4 },
      { from: 1, to: 4 },
    ]
    const pl = computeArrange(Ln, { edges: Le, mode: 'layered' })
    check(
      posEq(pl, 1, 100, 100) && posEq(pl, 3, 400, 100) && posEq(pl, 2, 400, 340) && posEq(pl, 4, 700, 100),
      'computeArrange layered：最长路径层深（4 走 1→2→4 而非 1→4）+ 同层 seq 优先（C 行 0 / B 行 1）',
    )
    const Gn = [
      { id: 11, x: 500, y: 0, seq: null },
      { id: 12, x: 0, y: 400, seq: 3 },
      { id: 13, x: 300, y: 200, seq: 1 },
      { id: 14, x: 100, y: 100, seq: 2 },
      { id: 15, x: 700, y: 700, seq: null },
    ]
    const pg = computeArrange(Gn, { edges: [], mode: 'grid', sortBy: 'seq' })
    check(
      posEq(pg, 13, 0, 0) && posEq(pg, 14, 300, 0) && posEq(pg, 12, 600, 0) && posEq(pg, 11, 0, 240) && posEq(pg, 15, 300, 240),
      'computeArrange grid：cols=max(2,ceil(sqrt(5)))=3 + sortBy=seq 优先（13→14→12→11→15）',
    )
    const pg2 = computeArrange(Gn, { edges: [], mode: 'grid' })
    check(posEq(pg2, 12, 0, 0) && posEq(pg2, 14, 300, 0), 'computeArrange grid：无 sortBy → 位置序（x→y→id）')
    const An = [
      { id: 21, x: 100, y: 500, seq: null },
      { id: 22, x: 400, y: 100, seq: null },
      { id: 23, x: 250, y: 300, seq: null },
    ]
    const aL = computeArrange(An, { edges: [], mode: 'align-left' })
    check(posEq(aL, 21, 100, 500) && aL.get(22)?.x === 100 && aL.get(23)?.x === 100, 'computeArrange align-left：全列 x=minX（y 不动）')
    const aR = computeArrange(An, { edges: [], mode: 'align-right' })
    check(aR.get(21)?.x === 400 && aR.get(22)?.x === 400 && aR.get(23)?.x === 400, 'computeArrange align-right：全列 x=maxX')
    const aT = computeArrange(An, { edges: [], mode: 'align-top' })
    check(aT.get(21)?.y === 100 && aT.get(22)?.y === 100 && aT.get(23)?.y === 100, 'computeArrange align-top：全行 y=minY')
    const aB = computeArrange(An, { edges: [], mode: 'align-bottom' })
    check(aB.get(21)?.y === 500 && aB.get(22)?.y === 500 && aB.get(23)?.y === 500, 'computeArrange align-bottom：全行 y=maxY')
    const Dn = [
      { id: 31, x: 0, y: 0, seq: null },
      { id: 32, x: 10, y: 400, seq: null },
      { id: 33, x: 300, y: 100, seq: null },
    ]
    const dh = computeArrange(Dn, { edges: [], mode: 'distribute-h' })
    check(posEq(dh, 31, 0, 0) && posEq(dh, 32, 150, 400) && posEq(dh, 33, 300, 100), 'computeArrange distribute-h：中间点等距（首尾不动）')
    const dv = computeArrange(Dn, { edges: [], mode: 'distribute-v' })
    check(posEq(dv, 31, 0, 0) && posEq(dv, 33, 300, 200) && posEq(dv, 32, 10, 400), 'computeArrange distribute-v：按 y 排序中间点 y=200')
    check(computeArrange([Dn[0]!, Dn[1]!], { edges: [], mode: 'distribute-h' }).size === 0, 'computeArrange distribute：n<3 → 不移动')
    let modeThrew = false
    try {
      computeArrange(Ln, { edges: Le, mode: 'foo' })
    } catch {
      modeThrew = true
    }
    check(modeThrew, 'computeArrange：非法 mode → 抛错')

    // ---- 纯函数：chainPortCandidates ----
    check(
      JSON.stringify(chainPortCandidates({ id: 1, kind: 'text' }, { kind: 'gen', spec: { genKind: 'image', prompt: '' } })) === '["prompt"]',
      'chainPortCandidates：text → image = [prompt]',
    )
    check(
      JSON.stringify(
        chainPortCandidates({ id: 1, kind: 'gen', spec: { genKind: 'image', prompt: 'P' } }, { kind: 'gen', spec: { genKind: 'video', prompt: 'V' } }),
      ) === '["reference","first_frame"]',
      'chainPortCandidates：image → video = [reference, first_frame]（满额兜底序）',
    )
    check(
      JSON.stringify(
        chainPortCandidates({ id: 1, kind: 'gen', spec: { genKind: 'video', prompt: 'V' } }, { kind: 'gen', spec: { genKind: 'compose', prompt: '' } }),
      ) === '["video"]',
      'chainPortCandidates：video → compose = [video]',
    )
    check(chainPortCandidates({ id: 1, kind: 'text' }, { kind: 'gen', spec: { genKind: 'compose', prompt: '' } }).length === 0, 'chainPortCandidates：text → compose = []')
    check(
      chainPortCandidates({ id: 1, kind: 'entity' }, { kind: 'gen', spec: { genKind: 'image', prompt: '' } })[0] === 'reference',
      'chainPortCandidates：entity → image = [reference]（实体直通）',
    )
    check(chainPortCandidates({ id: 1, kind: 'run' }, { kind: 'gen', spec: { genKind: 'image', prompt: '' } }).length === 0, 'chainPortCandidates：run 源 = []')

    // ---- 端点：batch（整组移动 + 预校验回滚） ----
    const cB1 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '批量操控' })
    const CB1: number = cB1.body.canvas.id
    const mkNodeB1 = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${CB1}/nodes`, body)).body.node.id
    const NB1 = await mkNodeB1({ kind: 'gen', spec: { genKind: 'image', prompt: 'B1' }, x: 100, y: 100 })
    const NB2 = await mkNodeB1({ kind: 'gen', spec: { genKind: 'image', prompt: 'B2' }, x: 500, y: 100 })
    const NB3 = await mkNodeB1({ kind: 'text', spec: { text: '批量' }, x: 100, y: 400 })
    const bOk = await jreq('POST', `/api/v1/canvases/${CB1}/nodes/batch`, {
      updates: [
        { id: NB1, x: 110, y: 120 },
        { id: NB2, x: 510, y: 120 },
        { id: NB3, x: 110, y: 420 },
      ],
    })
    check(bOk.status === 200 && bOk.body?.ok === true && bOk.body?.updated === 3, 'batch：3 条整组移动 → 200 {ok,updated:3}')
    let dB = await jreq('GET', `/api/v1/canvases/${CB1}`)
    check(docNode(dB.body, NB2)?.x === 510 && docNode(dB.body, NB2)?.y === 120, 'batch：坐标落库')
    const bRollback = await jreq('POST', `/api/v1/canvases/${CB1}/nodes/batch`, {
      updates: [
        { id: NB1, x: 999, y: 999 },
        { id: NB2, seq: 0 },
      ],
    })
    check(bRollback.status === 400 && String(bRollback.body?.error?.message ?? '').includes('seq 需为 null 或正整数'), 'batch：非法项 → 400（同 PATCH 文案）')
    dB = await jreq('GET', `/api/v1/canvases/${CB1}`)
    check(docNode(dB.body, NB1)?.x === 110 && docNode(dB.body, NB1)?.y === 120, 'batch：预校验失败 → 合法条目也零写入（回滚）')
    check((await jreq('POST', `/api/v1/canvases/${CB1}/nodes/batch`, { updates: [] })).status === 400, 'batch：updates 空 → 400')
    check((await jreq('POST', `/api/v1/canvases/${CB1}/nodes/batch`, { updates: [{ id: 999999, x: 0 }] })).status === 400, 'batch：节点不存在 → 400')

    // ---- 端点：arrange（grid sortBy=seq → layered → 子集 → 错误族） ----
    check(
      (
        await jreq('POST', `/api/v1/canvases/${CB1}/nodes/batch`, {
          updates: [
            { id: NB2, seq: 1 },
            { id: NB1, seq: 2 },
            { id: NB3, seq: 3 },
          ],
        })
      ).status === 200,
      'batch：编号 seq 1..3 → 200',
    )
    const arrG = await jreq('POST', `/api/v1/canvases/${CB1}/arrange`, { mode: 'grid', sortBy: 'seq' })
    check(arrG.status === 200 && arrG.body?.updated === 3, 'arrange：grid sortBy=seq → {updated:3}')
    dB = await jreq('GET', `/api/v1/canvases/${CB1}`)
    check(
      docNode(dB.body, NB2)?.x === 110 &&
        docNode(dB.body, NB2)?.y === 120 &&
        docNode(dB.body, NB1)?.x === 410 &&
        docNode(dB.body, NB1)?.y === 120 &&
        docNode(dB.body, NB3)?.x === 110 &&
        docNode(dB.body, NB3)?.y === 360,
      'arrange grid：seq 序 2 列行优先填充 + 锚定包围盒左上角',
    )
    await jreq('POST', `/api/v1/canvases/${CB1}/edges`, { from: NB1, to: NB2, port: 'reference' })
    const arrL = await jreq('POST', `/api/v1/canvases/${CB1}/arrange`, { mode: 'layered' })
    check(arrL.status === 200 && arrL.body?.updated === 3, 'arrange：layered 全画布 → {updated:3}')
    dB = await jreq('GET', `/api/v1/canvases/${CB1}`)
    check(
      docNode(dB.body, NB1)?.x === 110 &&
        docNode(dB.body, NB1)?.y === 120 &&
        docNode(dB.body, NB3)?.x === 110 &&
        docNode(dB.body, NB3)?.y === 360 &&
        docNode(dB.body, NB2)?.x === 410 &&
        docNode(dB.body, NB2)?.y === 120,
      'arrange layered：NB2 入边 → 列 1 + 同层 seq 排序落库',
    )
    const arrSub = await jreq('POST', `/api/v1/canvases/${CB1}/arrange`, { mode: 'grid', nodeIds: [NB2, NB3] })
    check(arrSub.status === 200 && arrSub.body?.updated === 2 && arrSub.body?.positions?.length === 2, 'arrange：nodeIds 子集 → updated=2 + positions 回执')
    dB = await jreq('GET', `/api/v1/canvases/${CB1}`)
    check(
      docNode(dB.body, NB3)?.x === 110 && docNode(dB.body, NB3)?.y === 120 && docNode(dB.body, NB1)?.x === 110 && docNode(dB.body, NB1)?.y === 120,
      'arrange：子集重排落库（NB3 y 360→120）+ 子集外节点不动',
    )
    check((await jreq('POST', `/api/v1/canvases/${CB1}/arrange`, { mode: 'foo' })).status === 400, 'arrange：非法 mode → 400')
    check((await jreq('POST', `/api/v1/canvases/${CB1}/arrange`, { mode: 'layered', nodeIds: [999999] })).status === 400, 'arrange：不存在 nodeId → 400')

    // ---- 端点：copy（深拷 + 内部边重映射 + 任务归属不迁移）+ delete（级联计数） ----
    const cB2 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '删除复制' })
    const CB2: number = cB2.body.canvas.id
    const mkNodeB2 = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${CB2}/nodes`, body)).body.node.id
    const NC1 = await mkNodeB2({ kind: 'gen', spec: { genKind: 'image', prompt: 'C1' }, x: 0, y: 0 })
    const NC2 = await mkNodeB2({ kind: 'gen', spec: { genKind: 'video', prompt: 'C2' }, x: 300, y: 0 })
    const NC3 = await mkNodeB2({ kind: 'asset', assetId: A1, x: 600, y: 0 })
    const tC1 = await mkTask(PID, { canvasNodeId: NC1, status: 'succeeded', resultAssetId: A1 })
    await jreq('PATCH', `/api/v1/nodes/${NC1}`, { adoptedTaskId: tC1, seq: 5 })
    await jreq('POST', `/api/v1/canvases/${CB2}/edges`, { from: NC1, to: NC2, port: 'reference' })
    await jreq('POST', `/api/v1/canvases/${CB2}/edges`, { from: NC3, to: NC1, port: 'reference' })
    const cp = await jreq('POST', `/api/v1/canvases/${CB2}/nodes/copy`, { ids: [NC1, NC2], offset: { x: 10, y: 20 } })
    check(cp.status === 201 && cp.body?.nodes?.length === 2 && cp.body?.edges?.length === 1, 'copy：2 节点 + 内部边 1 条 → 201（跨集合边不复制）')
    const CP1: number = cp.body.nodes[0].id
    const CP2: number = cp.body.nodes[1].id
    check(
      cp.body.nodes[0].x === 10 && cp.body.nodes[0].y === 20 && cp.body.nodes[0].seq === 5 && cp.body.nodes[0].adoptedTaskId === tC1,
      'copy：位置偏移 + seq/adoptedTaskId 深拷',
    )
    check(cp.body.edges[0].from === CP1 && cp.body.edges[0].to === CP2 && cp.body.edges[0].port === 'reference', 'copy：内部边重映射重建')
    dB = await jreq('GET', `/api/v1/canvases/${CB2}`)
    check(
      docNode(dB.body, CP1)?.adoptedTaskId === tC1 && docNode(dB.body, CP1)?.displayTaskId === null,
      'copy：任务归属不迁移（adoptedTaskId 深拷 / displayTaskId 派生 null）',
    )
    const cp2 = await jreq('POST', `/api/v1/canvases/${CB2}/nodes/copy`, { ids: [NC3] })
    check(cp2.status === 201 && cp2.body?.nodes?.[0]?.x === 640 && cp2.body?.nodes?.[0]?.y === 40, 'copy：offset 缺省 +40,+40')
    check((await jreq('POST', `/api/v1/canvases/${CB2}/nodes/copy`, { ids: [NC1], offset: { x: 'a' } })).status === 400, 'copy：非法 offset → 400')
    const del = await jreq('POST', `/api/v1/canvases/${CB2}/nodes/delete`, { ids: [NC1, NC2] })
    check(del.status === 200 && del.body?.deleted === 2 && del.body?.edges === 2, 'delete：级联边计数 → {deleted:2,edges:2}')
    dB = await jreq('GET', `/api/v1/canvases/${CB2}`)
    check(docNode(dB.body, NC1) === undefined, 'delete：节点已移除')
    check((await jreq('POST', `/api/v1/canvases/${CB2}/nodes/delete`, { ids: [NC1] })).status === 400, 'delete：含已删节点 → 400')

    // ---- 端点：快照重建认领（restoreFromNodeId：gen 任务历史迁移 + 前置校验不残留） ----
    const NR1 = await mkNodeB2({ kind: 'gen', spec: { genKind: 'image', prompt: 'R1' }, x: 0, y: 600 })
    const tR1 = await mkTask(PID, { canvasNodeId: NR1, status: 'succeeded', resultAssetId: A1 })
    await mkTask(PID, { canvasNodeId: NR1, status: 'failed' })
    await jreq('POST', `/api/v1/canvases/${CB2}/nodes/delete`, { ids: [NR1] })
    const rc = await jreq('POST', `/api/v1/canvases/${CB2}/nodes`, {
      kind: 'gen',
      spec: { genKind: 'image', prompt: 'R1' },
      x: 0,
      y: 600,
      restoreFromNodeId: NR1,
    })
    check(rc.status === 201 && rc.body?.claimed === 2, 'restore-claim：重建认领全部任务历史 → {claimed:2}')
    const rcId: number = rc.body.node.id
    check(
      (await jreq('PATCH', `/api/v1/nodes/${rcId}`, { adoptedTaskId: tR1 })).status === 200,
      'restore-claim：认领后采纳 PATCH 通过（任务归属已随重建迁移）',
    )
    dB = await jreq('GET', `/api/v1/canvases/${CB2}`)
    check(docNode(dB.body, rcId)?.displayTaskId === tR1, 'restore-claim：读模型 displayTaskId 恢复为采纳任务')
    const cntBefore = dB.body.nodes.length
    const rcBad = await jreq('POST', `/api/v1/canvases/${CB2}/nodes`, {
      kind: 'gen',
      spec: { genKind: 'image', prompt: 'X' },
      x: 0,
      y: 900,
      restoreFromNodeId: rcId,
    })
    dB = await jreq('GET', `/api/v1/canvases/${CB2}`)
    check(rcBad.status === 400 && dB.body.nodes.length === cntBefore, 'restore-claim：源节点存活 → 400 且不残留新节点（前置校验）')
    check(
      (await jreq('POST', `/api/v1/canvases/${CB2}/nodes`, { kind: 'text', spec: { text: 'T' }, x: 0, y: 900, restoreFromNodeId: 999999 })).status === 400,
      'restore-claim：非 gen 目标 → 400',
    )

    // ---- 端点：chain（规则矩阵 + skip 全因） ----
    const cB3 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '串联规则' })
    const CB3: number = cB3.body.canvas.id
    const mkNodeB3 = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${CB3}/nodes`, body)).body.node.id
    const chainPair = (a: number, b: number) => jreq('POST', `/api/v1/canvases/${CB3}/nodes/chain`, { ids: [a, b] })
    const A4 = await mkAsset(PID, 'image', '图丁', 'creation')
    const NT1 = await mkNodeB3({ kind: 'text', spec: { text: '串联词' }, x: 0, y: 0 })
    const NT2 = await mkNodeB3({ kind: 'text', spec: { text: '串联词2' }, x: 0, y: 100 })
    const NEntB = await mkNodeB3({ kind: 'entity', entityId: ENT, x: 100, y: 300 })
    const NGImg = await mkNodeB3({ kind: 'gen', spec: { genKind: 'image', prompt: 'G' }, x: 300, y: 0 })
    const NGImgBad = await mkNodeB3({ kind: 'gen', spec: { genKind: 'image', prompt: 'G2' }, x: 300, y: 300 })
    const NGVid = await mkNodeB3({ kind: 'gen', spec: { genKind: 'video', prompt: 'V' }, x: 600, y: 0 })
    const NGAud = await mkNodeB3({ kind: 'gen', spec: { genKind: 'audio', prompt: 'A' }, x: 300, y: 200 })
    const NGComp = await mkNodeB3({ kind: 'gen', spec: { genKind: 'compose' }, x: 900, y: 0 })
    const NGComp2 = await mkNodeB3({ kind: 'gen', spec: { genKind: 'compose' }, x: 900, y: 200 })
    const NRunB = await mkNodeB3({ kind: 'run', runId: RUN1, x: 1200, y: 0 })
    const NImg1 = await mkNodeB3({ kind: 'asset', assetId: A1, x: 0, y: 500 })
    const NImg2 = await mkNodeB3({ kind: 'asset', assetId: A2, x: 0, y: 600 })
    const NImg3 = await mkNodeB3({ kind: 'asset', assetId: A3, x: 0, y: 700 })
    const NImg4 = await mkNodeB3({ kind: 'asset', assetId: A4, x: 0, y: 800 })
    const ch1 = await chainPair(NT1, NGImg)
    check(ch1.body?.created?.length === 1 && ch1.body.created[0].port === 'prompt' && ch1.body?.skipped?.length === 0, 'chain：text → image = prompt 边')
    const ch2 = await chainPair(NT1, NGImg)
    check(ch2.body?.created?.length === 0 && ch2.body?.skipped?.[0]?.reason === '该连线已存在', 'chain：重复对 → skip「该连线已存在」')
    const ch3 = await chainPair(NImg1, NGImg)
    check(ch3.body?.created?.[0]?.port === 'reference', 'chain：图片素材 → image = reference 边')
    const ch4 = await chainPair(NImg1, NGVid)
    const ch5 = await chainPair(NImg2, NGVid)
    check(ch4.body?.created?.[0]?.port === 'reference' && ch5.body?.created?.[0]?.port === 'reference', 'chain：图片 → video reference ×2')
    const ch6 = await chainPair(NImg3, NGVid)
    check(ch6.body?.created?.[0]?.port === 'first_frame', 'chain：reference 满额（2 张）→ first_frame 兜底')
    const ch7 = await chainPair(NImg4, NGVid)
    check(ch7.body?.created?.length === 0 && ch7.body?.skipped?.[0]?.reason === '首帧最多 1 条', 'chain：reference+first_frame 双满 → skip')
    const ch8 = await chainPair(NGAud, NGComp)
    check(ch8.body?.created?.[0]?.port === 'audio', 'chain：音频 → compose = audio 边')
    const ch8b = await chainPair(NT2, NGAud)
    check(ch8b.body?.created?.[0]?.port === 'prompt', 'chain：text → audio = prompt 边')
    const ch9 = await chainPair(NGVid, NGComp)
    check(ch9.body?.created?.[0]?.port === 'video', 'chain：视频 → compose = video 边')
    const ch10 = await chainPair(NT1, NGComp)
    check(ch10.body?.skipped?.[0]?.reason === '类型不符（text → compose）', 'chain：text → compose = 类型不符 skip')
    const ch11 = await chainPair(NGImg, NGComp)
    check(ch11.body?.skipped?.[0]?.reason === '类型不符（image → compose）', 'chain：image → compose = 类型不符 skip')
    const ch12 = await chainPair(NEntB, NGImg)
    check(ch12.body?.created?.[0]?.port === 'reference', 'chain：entity → image = reference 边')
    await jreq('POST', `/api/v1/canvases/${CB3}/edges`, { from: NGComp, to: NGComp2, port: 'video' })
    const ch13 = await chainPair(NGComp2, NGComp)
    check(ch13.body?.created?.length === 0 && String(ch13.body?.skipped?.[0]?.reason ?? '').includes('循环引用'), 'chain：环 → skip（环检测文案）')
    const ch14 = await chainPair(NRunB, NGImg)
    check(ch14.body?.skipped?.[0]?.reason === '运行节点不参与连线', 'chain：run 作源 → skip')
    const ch15 = await chainPair(NGImg, NRunB)
    check(ch15.body?.skipped?.[0]?.reason === '运行节点不参与连线', 'chain：run 作目标 → skip')
    const ch16 = await chainPair(NGImg, NT2)
    check(ch16.body?.skipped?.[0]?.reason === '仅生成节点可接收连线', 'chain：gen → text 目标 → skip')
    await db.update(canvasNodes).set({ spec: '{bad' }).where(eq(canvasNodes.id, NGImgBad))
    const ch17 = await chainPair(NImg1, NGImgBad)
    check(ch17.body?.skipped?.[0]?.reason === '目标节点 spec 损坏，无法连线', 'chain：目标 spec 损坏 → skip')
    const ch18 = await jreq('POST', `/api/v1/canvases/${CB3}/nodes/chain`, { ids: [NT1, NGImg, NGVid] })
    check(ch18.body?.created?.length === 0 && ch18.body?.skipped?.length === 2, 'chain：多对串联逐对记账（失败不中断）')

    // ---- 端点：canvases/run（批量执行：started/skipped + P2 守卫 + 收敛等待） ----
    const cB4 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '批量执行' })
    const CB4: number = cB4.body.canvas.id
    const mkNodeB4 = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${CB4}/nodes`, body)).body.node.id
    const GReady = await mkNodeB4({ kind: 'gen', spec: { genKind: 'image', prompt: 'R' }, x: 0, y: 0 })
    const GEmpty = await mkNodeB4({ kind: 'gen', spec: { genKind: 'image', prompt: '' }, x: 0, y: 100 })
    const GAudio = await mkNodeB4({ kind: 'gen', spec: { genKind: 'audio', prompt: 'A' }, x: 0, y: 200 })
    const NTextR = await mkNodeB4({ kind: 'text', spec: { text: 't' }, x: 0, y: 300 })
    const GBusy = await mkNodeB4({ kind: 'gen', spec: { genKind: 'image', prompt: 'BUSY' }, x: 0, y: 400 })
    const tBusy = await mkTask(PID, { canvasNodeId: GBusy, status: 'pending' })
    const run0 = await jreq('POST', `/api/v1/canvases/${CB4}/run`, {})
    check(
      run0.status === 200 &&
        run0.body?.started?.length === 2 &&
        run0.body.started[0].nodeId === GReady &&
        run0.body.started[0].taskId > 0 &&
        JSON.stringify(run0.body.started[0].taskIds) === JSON.stringify([run0.body.started[0].taskId]) &&
        run0.body.started[1].nodeId === GAudio,
      'canvases/run：缺省全量 gen → 就绪入队（started 2：图片 + 音频通道 P3 接入；taskIds 超集）',
    )
    const skip0 = new Map<number, string[]>(run0.body.skipped.map((s: any) => [s.nodeId, s.problems]))
    check(skip0.get(GEmpty)?.[0] === 'prompt 为空', 'canvases/run skip：未就绪 problems 拆表（prompt 为空）')
    check(skip0.get(GBusy)?.[0]?.includes('节点已有进行中的任务') === true, 'canvases/run skip：忙碌节点（已有 pending 任务）')
    check(skip0.size === 2, 'canvases/run skip：2 条（未就绪/忙碌）')
    const run1 = await jreq('POST', `/api/v1/canvases/${CB4}/run`, { nodeIds: [GReady, GEmpty, GAudio, NTextR, GBusy] })
    check(run1.status === 200 && run1.body?.started?.length === 0 && run1.body?.skipped?.length === 5, 'canvases/run：显式 ids → 全部 skip（含进行中 busy）')
    const skip1 = new Map<number, string[]>(run1.body.skipped.map((s: any) => [s.nodeId, s.problems]))
    check(skip1.get(GReady)?.[0]?.includes('节点已有进行中的任务') === true, 'canvases/run：刚入队节点 → busy skip')
    check(skip1.get(GAudio)?.[0]?.includes('节点已有进行中的任务') === true, 'canvases/run：音频入队节点 → busy skip（P3 通道放行）')
    check(skip1.get(NTextR)?.[0] === '仅生成节点可执行', 'canvases/run：text 节点 → 仅生成节点可执行')
    const run2 = await jreq('POST', `/api/v1/canvases/${CB4}/run`)
    check(run2.status === 200 && Array.isArray(run2.body?.started) && Array.isArray(run2.body?.skipped), 'canvases/run：无 body → 200（宽容读体，缺省全画布）')
    const run3 = await jreq('POST', `/api/v1/canvases/${CB4}/run`, { nodeIds: [GEmpty], variants: 2 })
    check(
      run3.status === 200 && run3.body?.started?.length === 0 && run3.body?.skipped?.[0]?.problems?.[0] === 'prompt 为空',
      'canvases/run：variants=2 → 200（P3 放行；未就绪仍 skip）',
    )
    check((await jreq('POST', `/api/v1/canvases/${CB4}/run`, { variants: 5 })).status === 400, 'canvases/run：variants=5 → 400（范围校验）')
    check((await jreq('POST', `/api/v1/canvases/${CB4}/run`, { nodeIds: [NB1] })).status === 400, 'canvases/run：跨画布 nodeId → 400')
    const settleId: number = run0.body.started[0].taskId
    const deadline = Date.now() + 25_000
    let st = ''
    for (;;) {
      const rows = await db.select({ status: genTasks.status }).from(genTasks).where(eq(genTasks.id, settleId)).limit(1)
      st = rows[0]?.status ?? 'missing'
      if (st === 'succeeded' || st === 'failed' || st === 'cancelled') break
      if (Date.now() > deadline) break
      await sleep(400)
    }
    check(st === 'succeeded' || st === 'failed', `canvases/run：入队任务收敛到终态（${st}）`)
    await db.delete(genTasks).where(eq(genTasks.id, tBusy))
  }

  /** ⑤ variant-adopt：纯函数快照（parseResolution/buildComposeArgs/extendTaskParams）+ variants 执行通道 + 变体采纳 */
  const sectionVariantAdopt = async (): Promise<void> => {
    // ---- 纯函数快照：parseResolution ----
    const rz = parseResolution('1080x1920')
    check(rz.width === 1080 && rz.height === 1920, 'parseResolution：WxH → {1080,1920}')
    let rzMsg = ''
    try {
      parseResolution('1080')
    } catch (e) {
      rzMsg = (e as Error).message
    }
    check(rzMsg.includes('需 WxH'), 'parseResolution：缺 x → 抛「需 WxH」')
    rzMsg = ''
    try {
      parseResolution('1081x1920')
    } catch (e) {
      rzMsg = (e as Error).message
    }
    check(rzMsg.includes('正偶数'), 'parseResolution：奇数宽 → 抛「正偶数」')

    // ---- 纯函数快照：buildComposeArgs ----
    const fcOf = (args: string[]): string => {
      const i = args.indexOf('-filter_complex')
      return i >= 0 ? args[i + 1]! : ''
    }
    const argsN2 = buildComposeArgs({
      videoPaths: ['v1.mp4', 'v2.mp4'],
      audioPaths: ['a1.mp3'],
      outPath: 'o.mp4',
      fps: 30,
      size: { width: 1080, height: 1920 },
    })
    check(argsN2[0] === '-y' && argsN2.filter((a) => a === '-i').length === 3, 'buildComposeArgs：-y + 3 路 -i（视频 2 先行 / 音频 1 后）')
    check(
      fcOf(argsN2).includes('scale=1080:1920') && fcOf(argsN2).includes('concat=n=2:v=1:a=0[vout]') && fcOf(argsN2).includes('amix=inputs=1:duration=longest[aout]'),
      'buildComposeArgs：N=2 逐段归一 + concat + M=1 amix',
    )
    check(
      argsN2.includes('[vout]') && argsN2.includes('[aout]') && argsN2.includes('libx264') && argsN2.includes('aac') && argsN2.includes('+faststart'),
      'buildComposeArgs：maps / 编码 libx264+aac / faststart',
    )
    const argsN1 = buildComposeArgs({ videoPaths: ['v1.mp4'], audioPaths: [], outPath: 'o.mp4', fps: 24 })
    check(
      !argsN1.includes('-filter_complex') &&
        argsN1.join(' ') === '-y -i v1.mp4 -map 0:v -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -r 24 -an -movflags +faststart o.mp4',
      'buildComposeArgs：N=1 无音频 → 无 filter + -map 0:v + -r 24 + -an（精确快照）',
    )

    // ---- 纯函数快照：extendTaskParams ----
    const eA = extendTaskParams({ a: 1 }, { genKind: 'audio', prompt: 'P', voice: 'nova', speed: 1.2 })
    check(eA['a'] === 1 && eA['voice'] === 'nova' && eA['speed'] === 1.2 && Object.keys(eA).length === 3, 'extendTaskParams：audio 附加 voice/speed')
    const eC = extendTaskParams({ a: 1 }, { genKind: 'compose', prompt: '' })
    check(eC['a'] === 1 && eC['fps'] === null && Object.keys(eC).length === 2, 'extendTaskParams：compose 附加 fps=null')
    const eI = extendTaskParams({ a: 1 }, { genKind: 'image', prompt: 'P' })
    check(eI['a'] === 1 && Object.keys(eI).length === 1, 'extendTaskParams：image 原样（probe-m16 快照保护）')

    // ---- 执行通道：variants=2 → 2 任务入队 ----
    const c1 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '变体执行' })
    const CV: number = c1.body.canvas.id
    const GV = (await jreq('POST', `/api/v1/canvases/${CV}/nodes`, { kind: 'gen', spec: { genKind: 'image', prompt: '变体' }, x: 0, y: 0 })).body.node.id
    const rv2 = await jreq('POST', `/api/v1/nodes/${GV}/run`, { variants: 2 })
    check(
      rv2.status === 200 && rv2.body?.ok === true && Array.isArray(rv2.body.taskIds) && rv2.body.taskIds.length === 2 && rv2.body.taskId === rv2.body.taskIds[0],
      'nodes/run：variants=2 → 200 {ok, taskId=首条, taskIds×2}',
    )
    const rv2Ids: number[] = rv2.body.taskIds
    const rows0 = await db.select({ id: genTasks.id }).from(genTasks).where(eq(genTasks.canvasNodeId, GV))
    check(rows0.length === 2 && rv2Ids.every((tid) => rows0.some((t) => t.id === tid)), 'nodes/run：库中恰好 2 条任务行（canvasNodeId 归属）')
    check((await jreq('POST', `/api/v1/nodes/${GV}/run`)).status === 400, 'nodes/run：无 body 再跑 → 400 busy（宽容读体 + 进行中检测）')
    check((await jreq('POST', `/api/v1/nodes/${GV}/run`, { variants: 5 })).status === 400, 'nodes/run：variants=5 → 400')
    check((await jreq('POST', `/api/v1/nodes/${GV}/run`, { variants: 0 })).status === 400, 'nodes/run：variants=0 → 400')
    check((await jreq('POST', `/api/v1/nodes/${GV}/run`, { variants: 1.5 })).status === 400, 'nodes/run：variants=1.5 → 400')

    // ---- 收敛：未配置图片端点 → 两任务自然失败（执行器真实接线） ----
    const settled0 = await settleTasks(rv2Ids)
    check([...settled0.values()].every((st) => st === 'failed'), `nodes/run：variants 任务收敛（未配置 → failed；实际 ${[...settled0.values()].join('/')}）`)
    const failedRows = await db.select({ errorMsg: genTasks.errorMsg, attempts: genTasks.attempts }).from(genTasks).where(inArray(genTasks.id, rv2Ids))
    check(failedRows.every((t) => (t.errorMsg ?? '').length > 0 && t.attempts >= 2), 'nodes/run：失败附 errorMsg + attempts=2（重试耗尽）')

    // ---- 终态后重跑（busy 解除）→ 新批次；取消清理 ----
    const rv2b = await jreq('POST', `/api/v1/nodes/${GV}/run`, { variants: 2 })
    check(rv2b.status === 200 && rv2b.body?.taskIds?.length === 2, 'nodes/run：终态后重跑 → 200 新批次 ×2')
    const batch2: number[] = rv2b.body.taskIds
    check((await jreq('POST', `/api/v1/tasks/${batch2[0]}/cancel`)).status === 200, 'tasks/:id/cancel：进行中任务 → 200')
    await jreq('POST', `/api/v1/tasks/${batch2[1]}/cancel`)
    const settled1 = await settleTasks(batch2)
    check([...settled1.values()].every((st) => st === 'cancelled' || st === 'failed'), `nodes/run：重跑批次收敛（取消清理；实际 ${[...settled1.values()].join('/')}）`)
    const rows1 = await db.select({ id: genTasks.id }).from(genTasks).where(eq(genTasks.canvasNodeId, GV))
    check(rows1.length === 4, 'nodes/run：两批共 4 条任务行（画廊历史共存）')

    // ---- 变体画廊 → 采纳闭环 ----
    const A1x = await mkAsset(PID, 'image', '变体甲')
    const A2x = await mkAsset(PID, 'image', '变体乙')
    const tv1 = await mkTask(PID, { canvasNodeId: GV, status: 'succeeded', resultAssetId: A1x })
    const tv2 = await mkTask(PID, { canvasNodeId: GV, status: 'succeeded', resultAssetId: A2x })
    let d = await jreq('GET', `/api/v1/canvases/${CV}`)
    let dn = docNode(d.body, GV)
    check(dn?.displayTaskId === tv2 && dn?.assetId === A2x, '变体画廊：未采纳 → 最新成功（tv2）')
    check(dn?.results?.length === 2 && dn?.results?.[0]?.taskId === tv2, '变体画廊：results 仅成功产物 2 条（新→旧）')
    check((await jreq('PATCH', `/api/v1/nodes/${GV}`, { adoptedTaskId: tv1 })).status === 200, '变体采纳：PATCH adoptedTaskId=tv1 → 200')
    d = await jreq('GET', `/api/v1/canvases/${CV}`)
    dn = docNode(d.body, GV)
    check(dn?.displayTaskId === tv1 && dn?.assetId === A1x && dn?.results?.length === 2, '变体采纳：displayTask→tv1（results 不变）')
  }

  /** ⑥ run-node：多 run 节点批查独立派生 + 行删除宽容降级 + title/seq/坐标 + batch 移动 + copy 深拷 */
  const sectionRunNode = async (): Promise<void> => {
    const c1 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '运行节点' })
    const C: number = c1.body.canvas.id
    const mkNode = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${C}/nodes`, body)).body.node.id
    const NR1 = await mkNode({ kind: 'run', runId: RUN1, x: 0, y: 0 })
    const NR2 = await mkNode({ kind: 'run', runId: RUN2, x: 0, y: 100 })
    let d = await jreq('GET', `/api/v1/canvases/${C}`)
    const dn1 = docNode(d.body, NR1)
    const dn2 = docNode(d.body, NR2)
    check(
      dn1?.run?.id === RUN1 && dn1?.run?.status === 'running' && dn1?.run?.steps?.total === 3 && dn1?.run?.steps?.succeeded === 2,
      '多 run 批查：NR1 独立派生（running 2/3）',
    )
    check(
      dn2?.run?.id === RUN2 && dn2?.run?.status === 'completed' && dn2?.run?.steps?.total === 2 && dn2?.run?.steps?.succeeded === 1,
      '多 run 批查：NR2 独立派生（completed 1/2，不串）',
    )
    // run 行删除 → 宽容降级（节点保留 / run null / status null / spec 仍可读）
    await db.delete(pipelineRuns).where(eq(pipelineRuns.id, RUN2))
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    const dn2b = docNode(d.body, NR2)
    check(dn2b !== undefined && dn2b?.run === null && dn2b?.status === null && dn2b?.spec?.runId === RUN2, 'run 行删除 → 宽容降级（节点/ spec 保留，run/status null）')
    check(docNode(d.body, NR1)?.run?.id === RUN1, 'run 行删除：其他 run 节点不受影响（批查隔离）')
    // title / seq / 坐标（通用 PATCH 字段对 run 生效）
    check((await jreq('PATCH', `/api/v1/nodes/${NR2}`, { title: '巡检运行', seq: 9 })).status === 200, 'PATCH run 节点 title/seq → 200')
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    check(docNode(d.body, NR2)?.title === '巡检运行' && docNode(d.body, NR2)?.seq === 9, 'run 节点 title/seq 落库')
    const rb = await jreq('POST', `/api/v1/canvases/${C}/nodes/batch`, { updates: [{ id: NR1, x: 50, y: 60 }, { id: NR2, x: 70, y: 80 }] })
    check(rb.status === 200 && rb.body?.updated === 2, 'batch：run 节点批量移动 → {updated:2}')
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    check(docNode(d.body, NR1)?.x === 50 && docNode(d.body, NR2)?.y === 80, 'batch：run 节点坐标落库')
    // copy 深拷（spec.runId 保留 → 派生同源摘要；API 返回原始 DB 行，spec 为 JSON 字符串）
    const cp = await jreq('POST', `/api/v1/canvases/${C}/nodes/copy`, { ids: [NR1] })
    const cpSpec = JSON.parse(String(cp.body?.nodes?.[0]?.spec ?? 'null')) as { runId?: number } | null
    check(cp.status === 201 && cpSpec?.runId === RUN1, 'copy：run 节点深拷（spec.runId 保留）')
    const cpId: number = cp.body.nodes[0].id
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    check(docNode(d.body, cpId)?.run?.id === RUN1 && docNode(d.body, cpId)?.run?.steps?.total === 3, 'copy：新 run 节点派生同源摘要')
  }

  /** ⑦ export：真实文件 zip（条目命名/重名递增/seq 序 + manifest + skipped + 采纳优先 + 错误族 + 下载） */
  const sectionExport = async (): Promise<void> => {
    ensureProjectDirs(PID)
    const relP1 = join(String(PID), 'source', 'export-probe-1.png')
    const relP2 = join(String(PID), 'source', 'export-probe-2.png')
    const relP3 = join(String(PID), 'source', 'export-probe-3.png')
    writeFileSync(absPathOf(relP1), Buffer.from('PNG-ONE'))
    writeFileSync(absPathOf(relP2), Buffer.from('PNG-TWO'))
    writeFileSync(absPathOf(relP3), Buffer.from('PNG-THREE'))
    const PE1 = await mkAsset(PID, 'image', '导出图甲')
    const PE2 = await mkAsset(PID, 'image', '导出图乙')
    const PE3 = await mkAsset(PID, 'image', '导出图丙')
    const PE_DEL = await mkAsset(PID, 'image', '软删图')
    const PE_NOREL = await mkAsset(PID, 'image', '无路径图')
    const PE_MISS = await mkAsset(PID, 'image', '缺文件图')
    await db.update(assets).set({ relPath: relP1, ext: 'png' }).where(eq(assets.id, PE1))
    await db.update(assets).set({ relPath: relP2, ext: 'png' }).where(eq(assets.id, PE2))
    await db.update(assets).set({ relPath: relP3, ext: 'png' }).where(eq(assets.id, PE3))
    await db.update(assets).set({ relPath: join(String(PID), 'source', 'gone.png') }).where(eq(assets.id, PE_MISS))

    const c1 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '导出画布' })
    const CE: number = c1.body.canvas.id
    const mkNode = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${CE}/nodes`, body)).body.node.id
    const ET1 = await mkNode({ kind: 'text', spec: { text: '导出文本甲' }, x: 0, y: 0 })
    const ET2 = await mkNode({ kind: 'text', spec: { text: '导出文本乙' }, x: 0, y: 100 })
    const ET3 = await mkNode({ kind: 'text', spec: { text: '重名甲' }, x: 300, y: 0 })
    const ET4 = await mkNode({ kind: 'text', spec: { text: '重名乙' }, x: 300, y: 100 })
    const EA = await mkNode({ kind: 'asset', assetId: PE3, x: 0, y: 200 })
    const EA_DEL = await mkNode({ kind: 'asset', assetId: PE_DEL, x: 0, y: 300 })
    // 软删须在节点创建之后（addAssetNode → assertProjectAssets 拒绝软删资产）；导出侧走 skip 记账
    await db.update(assets).set({ deletedAt: T0 }).where(eq(assets.id, PE_DEL))
    const EA_NOREL = await mkNode({ kind: 'asset', assetId: PE_NOREL, x: 0, y: 400 })
    const EA_MISS = await mkNode({ kind: 'asset', assetId: PE_MISS, x: 0, y: 500 })
    const EG = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: '导出生成' }, x: 600, y: 600 })
    const EG_NONE = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: '无产物' }, x: 600, y: 700 })
    const ENE = await mkNode({ kind: 'entity', entityId: ENT, x: 900, y: 900 })
    const ENR = await mkNode({ kind: 'run', runId: RUN1, x: 900, y: 1000 })
    for (const [id, title, seq] of [
      [ET1, '文案A', 1],
      [ET2, '文案A', 2],
      [ET3, '同名', null],
      [ET4, '同名', null],
      [EA, '导出图丙', null],
      [EG, '生成甲', null],
    ] as Array<[number, string, number | null]>) {
      await jreq('PATCH', `/api/v1/nodes/${id}`, { title, seq })
    }
    const tG1 = await mkTask(PID, { canvasNodeId: EG, status: 'succeeded', resultAssetId: PE1 })
    await mkTask(PID, { canvasNodeId: EG, status: 'succeeded', resultAssetId: PE2 })

    // ---- 全量导出（无 body 宽容读体） ----
    const ex1 = await jreq('POST', `/api/v1/canvases/${CE}/export`)
    check(
      ex1.status === 201 && ex1.body?.stats?.packed === 6 && ex1.body?.stats?.skipped === 6 && ex1.body?.asset?.id > 0,
      `export：全量打包 → 201（packed 6 / skipped 6；实际 ${JSON.stringify(ex1.body?.stats)}）`,
    )
    check(
      String(ex1.body?.asset?.name ?? '').startsWith('导出画布-export-') && String(ex1.body?.asset?.name ?? '').endsWith('.zip'),
      'export：zip 命名 <画布名>-export-<ts>.zip',
    )
    const zipRow = (await db.select().from(assets).where(eq(assets.id, ex1.body.asset.id)))[0]!
    check(zipRow.kind === 'archive' && zipRow.purpose === 'creation_export' && zipRow.mime === 'application/zip' && zipRow.ext === 'zip', 'export：资产登记 archive/creation_export/zip')
    const entries = unzipSync(new Uint8Array(readFileSync(absPathOf(zipRow.relPath!))))
    const names = Object.keys(entries)
    check(names.length === 7 && names.includes('manifest.json'), 'export：zip 条目 7（manifest + 6 文件）')
    const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']!))
    check(manifest.version === 1 && manifest.canvas?.id === CE && manifest.canvas?.name === '导出画布', 'export：manifest 头（version/canvas）')
    check(manifest.files?.length === 6 && manifest.skipped?.length === 6, 'export：manifest files/skipped 计数')
    const fNames: string[] = manifest.files.map((f: any) => f.fileName)
    check(fNames[0] === '1-文案A.txt' && fNames[1] === '2-文案A.txt', 'export：seq 序条目名 <seq>-<title>.txt')
    check(
      manifest.files[0].seq === 1 && manifest.files[0].kind === 'text' && manifest.files[0].assetId === null && manifest.files[0].size === new TextEncoder().encode('导出文本甲').byteLength,
      'export：manifest 条目字段（seq/kind/assetId/size）',
    )
    const dec = (n: string): string => new TextDecoder().decode(entries[n]!)
    check(dec('同名.txt') === '重名甲' && dec('同名-1.txt') === '重名乙', 'export：重名递增（-1）且顺序稳定（x→y）')
    check(fNames.includes(`导出图丙-${PE3}.png`) && dec(`导出图丙-${PE3}.png`) === 'PNG-THREE', 'export：asset 节点条目名 <title>-<assetId>.ext + 内容')
    check(manifest.files.some((f: any) => f.kind === 'gen' && f.assetId === PE2 && f.fileName === `生成甲-${PE2}.png`), 'export：gen 默认打包最新成功产物（PE2）')
    const skipReasons: string[] = manifest.skipped.map((s: any) => `${s.nodeId}:${s.reason}`)
    check(skipReasons.includes(`${EA_DEL}:资产 #${PE_DEL} 已删除`), 'export：软删资产 → skipped 已删除')
    check(skipReasons.includes(`${EA_NOREL}:资产 #${PE_NOREL} 无本地文件`), 'export：无 relPath → skipped 无本地文件')
    check(skipReasons.includes(`${EA_MISS}:资产 #${PE_MISS} 文件缺失`), 'export：文件缺失 → skipped 文件缺失')
    check(skipReasons.includes(`${EG_NONE}:暂无成功产物`), 'export：gen 无产物 → skipped 暂无成功产物')
    check(skipReasons.includes(`${ENE}:实体节点不参与打包`) && skipReasons.includes(`${ENR}:运行节点不参与打包`), 'export：entity/run → skipped 记账')
    check((await jreq('GET', `/api/v1/assets/${zipRow.id}/file?download=1`)).status === 200, 'export：下载链路 GET /assets/:id/file?download=1 → 200')

    // ---- 采纳优先：PATCH EG → tG1（PE1）→ 子集导出 ----
    check((await jreq('PATCH', `/api/v1/nodes/${EG}`, { adoptedTaskId: tG1 })).status === 200, 'export 前置：采纳 tG1（PE1）→ 200')
    const ex2 = await jreq('POST', `/api/v1/canvases/${CE}/export`, { nodeIds: [ET1, EG] })
    check(ex2.status === 201 && ex2.body?.stats?.packed === 2 && ex2.body?.stats?.skipped === 0, 'export：子集导出 → packed 2 / skipped 0')
    const zip2Row = (await db.select().from(assets).where(eq(assets.id, ex2.body.asset.id)))[0]!
    const entries2 = unzipSync(new Uint8Array(readFileSync(absPathOf(zip2Row.relPath!))))
    const manifest2 = JSON.parse(new TextDecoder().decode(entries2['manifest.json']!))
    check(
      manifest2.files.some((f: any) => f.kind === 'gen' && f.assetId === PE1 && f.fileName === `生成甲-${PE1}.png`),
      'export：采纳后打包采纳产物（PE1）+ 条目名随采纳切换',
    )
    check(manifest2.files.length === 2 && manifest2.skipped.length === 0, 'export：子集 manifest（2 files / 0 skipped）')

    // ---- 错误族 ----
    const bad1 = await jreq('POST', `/api/v1/canvases/${CE}/export`, { nodeIds: [] })
    check(bad1.status === 400 && String(bad1.body?.error?.message ?? '').includes('nodeIds 为空数组'), 'export：空数组 → 400（引导省略字段）')
    const bad2 = await jreq('POST', `/api/v1/canvases/${CE}/export`, { nodeIds: [999999] })
    check(bad2.status === 400 && String(bad2.body?.error?.message ?? '').includes('不存在或不属于该画布'), 'export：未知节点 → 400')
    const bad3 = await jreq('POST', `/api/v1/canvases/${CE}/export`, { nodeIds: 'x' })
    check(bad3.status === 400 && String(bad3.body?.error?.message ?? '').includes('nodeIds 需为正整数数组'), 'export：非数组 → 400')
  }

  /** ⑧ llm-assist：prompt-expand（未配置 400 / env 注入成功径 / instruction / 不落库 / 用量）+ extract 双径 */
  const sectionLlmAssist = async (): Promise<void> => {
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

  // ================= 分发 =================
  const runners: Record<string, () => Promise<void>> = {
    'node-kinds': sectionNodeKinds,
    'port-v2': sectionPortV2,
    'input-v2': sectionInputV2,
    'batch-ops': sectionBatchOps,
    'variant-adopt': sectionVariantAdopt,
    'run-node': sectionRunNode,
    export: sectionExport,
    'llm-assist': sectionLlmAssist,
  }
  const arg = process.argv.find((a) => a.startsWith('--section='))
  const wanted = arg ? arg.slice('--section='.length) : 'all'
  if (wanted !== 'all' && !(SECTIONS as readonly string[]).includes(wanted)) {
    log.error(`未知 section：${wanted}（已实现：${SECTIONS.join(' / ')}；all = 全部）`)
    process.exitCode = 1
    return
  }

  try {
    for (const name of (wanted === 'all' ? SECTIONS : [wanted]) as readonly string[]) {
      console.log(`\n──── section: ${name} ────`)
      await runners[name]!()
    }
  } catch (err) {
    failed += 1
    console.error(`\n探针异常终止: ${(err as Error).stack ?? err}`)
  } finally {
    console.log(`\n==== M17 探针结果: ${failed > 0 ? `${failed} 项失败` : '全部通过'} ====`)
    globalThis.fetch = origFetch // 还原网络栈
    try {
      sqlite.close() // 释放 db 连接（Windows 下句柄可能仍被 libsql 持有 → 失败不阻断）
    } catch {
      /* 已关闭或未初始化 */
    }
    try {
      rmSync(TMP, { recursive: true, force: true })
    } catch {
      console.log(`临时目录未完全清理（Windows libsql 句柄；下次运行自动清理）: ${TMP}`)
    }
    process.exitCode = failed > 0 ? 1 : 0
  }
}

void main()
