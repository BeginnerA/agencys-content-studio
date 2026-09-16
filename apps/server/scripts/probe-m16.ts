/**
 * M16 探针（创作画布：文档层 / 执行通道 / 编辑能力 / 模板草案 / 联动 / 回归）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m16.ts [--section=canvas-doc|node-build|edit-cap|draft|linkage|regression]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录（独立 studio.db +
 * workspace），不触碰开发库（同 probe-m2a~m15）。globalThis.fetch stub 兜底（零网络、零计费）。
 * 画布 HTTP 全链经 app.request 内存执行；执行通道失败链在「无端点配置」环境断言（任务落库 →
 * 失败透传 → 复位），不发真实请求。模板文件从仓库 workspace/templates 复制进隔离目录。
 *
 * section（默认 all）：
 *   canvas-doc   画布/节点/边 CRUD 全链：项目域校验 / 端口矩阵（重复·首帧·源图·自环·跨画布）/
 *                环检测 / 派生读模型（任务状态映射·readiness·坏 spec 宽容）/ duplicate 映射 /
 *                级联删除 / 404 全家桶
 *   node-build   planNodeInputs 纯矩阵（各端口映射·上限·缺失上游 problems）+ buildNodeTaskParams
 *                快照 + appendStyleSnippet + buildEditParams + topoSort + 执行通道失败链全链路
 *   edit-cap     AliyunWan edit 声明与请求构造快照（fetch 记录器拦截：function/mask/prompt/expand
 *                映射与 erase 默认词）+ editCapabilityOf 无端点 → 全 false + 未声明适配器 → undefined
 *   draft        buildTemplateDraftYaml 纯夹具快照（拓扑序·after·注释）+ buildTemplateDraft 与
 *                validateTemplateText 同源一致性
 *   linkage      ref-assets 并集挂接（去重·全局拒绝·项目域）/ 送入画布建素材节点 /
 *                prepareRunInput prefill 键安全性（未声明键静默丢弃）
 *   regression   probe:m15 子进程全绿（内含 m2a/m4/m14：引擎调度语义零漂移 + 新列兼容抽样）
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CanvasDoc, InputPlan, NodeSpec } from '../src/services/creation'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
const TMP_PREFIX = 'acs-probe-m16-'
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

const SECTIONS = ['canvas-doc', 'node-build', 'edit-cap', 'draft', 'linkage', 'regression'] as const

// ---- fetch stub：兜底安全网（本探针无真实外发请求；edit-cap 节临时换成记录器）----
const stubFetch = (async (): Promise<Response> => {
  return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const jsonRes = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

async function main(): Promise<void> {
  const origFetch = globalThis.fetch
  globalThis.fetch = stubFetch

  // src 模块全部动态加载（环境变量已隔离）
  const { db, initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')
  const { assets, canvasEdges, canvasNodes, characters, genTasks, projects } = await import('../src/db/schema')
  const { and, count, eq, isNull } = await import('drizzle-orm')
  const { loadTemplate, validateTemplateText } = await import('../src/pipeline/loader')
  const { app } = await import('../src/app')
  const {
    appendStyleSnippet,
    buildEditParams,
    buildNodeTaskParams,
    recoverCanvasTasks,
    startCanvasNodeRun,
  } = await import('../src/services/creation/gen')
  const {
    buildTemplateDraft,
    buildTemplateDraftYaml,
    editCapabilityOf,
    parseViewport,
    planNodeInputs,
    safeParseSpec,
    specProblems,
    topoSortGenNodeIds,
    wouldCreateCycle,
  } = await import('../src/services/creation')

  // 模板文件就位（隔离 workspace；loadTemplate 读隔离 TEMPLATES_DIR）
  const TPL_SRC = join(REPO_ROOT, 'workspace', 'templates')
  const TPL_DST = join(process.env.CSTUDIO_WORKSPACE!, 'templates')
  mkdirSync(TPL_DST, { recursive: true })
  for (const f of readdirSync(TPL_SRC)) {
    if (/\.ya?ml$/.test(f)) cpSync(join(TPL_SRC, f), join(TPL_DST, f))
  }

  const log = createLogger('probe-m16')
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

  const mkAsset = async (projectId: number, kind: string, name: string, purpose?: string): Promise<number> =>
    (
      await db
        .insert(assets)
        .values({
          projectId,
          kind,
          name,
          purpose: purpose ?? null,
          mime: kind === 'image' ? 'image/png' : 'video/mp4',
          width: 512,
          height: 512,
          createdAt: T0,
          updatedAt: T0,
        })
        .returning()
    )[0]!.id

  const mkTask = async (
    projectId: number,
    opts: { canvasNodeId?: number; runId?: number; stepId?: number; status: string; resultAssetId?: number },
  ): Promise<number> =>
    (
      await db
        .insert(genTasks)
        .values({
          projectId,
          runId: opts.runId ?? null,
          stepId: opts.stepId ?? null,
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
  const edgeCount = async (canvasId: number): Promise<number> =>
    Number((await db.select({ n: count() }).from(canvasEdges).where(eq(canvasEdges.canvasId, canvasId)))[0]?.n ?? 0)

  const PID = await mkProject('M16 探针')
  const OTHER = await mkProject('M16 探针-他项目')
  const A1 = await mkAsset(PID, 'image', '素材甲', 'creation')
  const A2 = await mkAsset(PID, 'image', '素材乙', 'creation')
  const A_OTHER = await mkAsset(OTHER, 'image', '他项目素材')

  // ================= sections =================

  /** ① canvas-doc：画布/节点/边 CRUD 全链 + 派生读模型 + 宽容 + 级联 */
  const sectionCanvasDoc = async (): Promise<void> => {
    // 项目不存在 → 404
    const miss = await jreq('POST', '/api/v1/projects/999999/canvases', { name: 'x' })
    check(miss.status === 404 && miss.body?.error?.code === 'not_found', 'POST 不存在项目建画布 → 404 not_found')

    // 建画布（含默认名）
    const c1 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '主画布' })
    check(c1.status === 201 && c1.body?.canvas?.id > 0, 'POST 建画布 → 201')
    const C1: number = c1.body.canvas.id
    const c2 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '   ' })
    check(c2.status === 201 && c2.body?.canvas?.name === '未命名画布', 'POST 建画布空名 → 默认「未命名画布」')
    const C2: number = c2.body.canvas.id

    // 空文档
    const d0 = await jreq('GET', `/api/v1/canvases/${C1}`)
    check(d0.status === 200 && d0.body?.nodes?.length === 0 && d0.body?.edges?.length === 0, 'GET 空画布 → 200 空文档')
    check(
      JSON.stringify(d0.body?.canvas?.viewport) === JSON.stringify({ x: 0, y: 0, zoom: 1 }),
      'viewport 默认 {0,0,1}',
    )

    // PATCH：改名 + viewport clamp
    const p1 = await jreq('PATCH', `/api/v1/canvases/${C1}`, { name: '改名', viewport: { x: 10, y: 20, zoom: 99 } })
    check(p1.status === 200 && p1.body?.canvas?.name === '改名', 'PATCH 画布改名 → 200')
    const d1 = await jreq('GET', `/api/v1/canvases/${C1}`)
    check(d1.body?.canvas?.viewport?.zoom === 10 && d1.body?.canvas?.viewport?.x === 10, 'viewport zoom clamp 到 10')
    const pBad = await jreq('PATCH', `/api/v1/canvases/${C1}`, { viewport: { x: 'a', y: 0, zoom: 1 } })
    check(pBad.status === 400, 'PATCH 非法 viewport → 400')

    // 建节点
    const n1r = await jreq('POST', `/api/v1/canvases/${C1}/nodes`, { kind: 'asset', assetId: A1, x: 10, y: 20 })
    check(n1r.status === 201 && n1r.body?.node?.kind === 'asset', 'POST 素材节点 → 201')
    const N1: number = n1r.body.node.id
    const nOther = await jreq('POST', `/api/v1/canvases/${C1}/nodes`, { kind: 'asset', assetId: A_OTHER, x: 0, y: 0 })
    check(nOther.status === 400, 'POST 素材节点他项目资产 → 400（项目域校验）')
    const n2r = await jreq('POST', `/api/v1/canvases/${C1}/nodes`, {
      kind: 'gen',
      spec: { genKind: 'image', prompt: '一只猫' },
      x: 300,
      y: 0,
    })
    check(n2r.status === 201, 'POST 图像生成节点 → 201')
    const N2: number = n2r.body.node.id
    const n3r = await jreq('POST', `/api/v1/canvases/${C1}/nodes`, {
      kind: 'gen',
      spec: { genKind: 'video', prompt: '运镜', duration: 5 },
      x: 600,
      y: 0,
    })
    check(n3r.status === 201, 'POST 视频生成节点 → 201')
    const N3: number = n3r.body.node.id
    const n4r = await jreq('POST', `/api/v1/canvases/${C1}/nodes`, {
      kind: 'gen',
      spec: { genKind: 'image', prompt: '', edit: { mode: 'inpaint' } },
      x: 300,
      y: 300,
    })
    check(n4r.status === 201, 'POST 编辑节点（inpaint）→ 201')
    const N4: number = n4r.body.node.id
    // [M17] 无产物图像 gen 节点：作为「上游无产物」用例源（视频 gen 已不可作 reference 源）
    const n5r = await jreq('POST', `/api/v1/canvases/${C1}/nodes`, {
      kind: 'gen',
      spec: { genKind: 'image', prompt: '无产物源' },
      x: 900,
      y: 0,
    })
    check(n5r.status === 201, 'POST 图像生成节点（无任务）→ 201')
    const N5: number = n5r.body.node.id
    const nBad = await jreq('POST', `/api/v1/canvases/${C1}/nodes`, { kind: 'gen', spec: { genKind: 'xxx' }, x: 0, y: 0 })
    check(nBad.status === 400, 'POST 非法 spec → 400')
    const kBad = await jreq('POST', `/api/v1/canvases/${C1}/nodes`, { kind: 'xxx', x: 0, y: 0 })
    check(kBad.status === 400 && kBad.body?.error?.code === 'bad_kind', 'POST 非法 kind → 400 bad_kind')

    // PATCH 节点
    const u1 = await jreq('PATCH', `/api/v1/nodes/${N1}`, { x: 1, y: 2, title: '素材甲节点' })
    check(u1.status === 200 && u1.body?.node?.x === 1 && u1.body?.node?.title === '素材甲节点', 'PATCH 节点坐标+标题 → 200')
    const uSpec = await jreq('PATCH', `/api/v1/nodes/${N1}`, { spec: { genKind: 'image', prompt: 'x' } })
    check(uSpec.status === 400, 'PATCH 素材节点改 spec → 400')

    // 边矩阵
    const e1 = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N1, to: N2, port: 'reference' })
    check(e1.status === 201, 'POST reference 边（素材→图像）→ 201')
    const eDup = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N1, to: N2, port: 'reference' })
    check(eDup.status === 400, '重复边 → 400')
    const eFFBad = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N1, to: N2, port: 'first_frame' })
    check(eFFBad.status === 400, '首帧到图像节点 → 400（仅视频）')
    const eFF = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N1, to: N3, port: 'first_frame' })
    check(eFF.status === 201, '首帧到视频节点 → 201')
    const eFF2 = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N2, to: N3, port: 'first_frame' })
    check(eFF2.status === 400, '首帧第二条 → 400（≤1）')
    const eSrcBad = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N1, to: N2, port: 'source' })
    check(eSrcBad.status === 400, '源图到非编辑节点 → 400')
    const eSrc = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N1, to: N4, port: 'source' })
    check(eSrc.status === 201, '源图到编辑节点 → 201')
    const eSelf = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N2, to: N2, port: 'reference' })
    check(eSelf.status === 400, '自环 → 400')
    const eC1 = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N2, to: N3, port: 'reference' })
    check(eC1.status === 201, '图像→视频 reference 边 → 201')
    const eC2 = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N2, to: N5, port: 'reference' })
    check(eC2.status === 201, '图像→图像 reference 边 → 201')
    const eCycle = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N5, to: N2, port: 'reference' })
    check(eCycle.status === 400, '环（N2→N5→N2）→ 400 拒绝')
    const ePort = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N1, to: N2, port: 'foo' })
    check(ePort.status === 400, '非法端口 → 400')
    const eFmt = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: 'x', to: N2, port: 'reference' })
    check(eFmt.status === 400, 'from 非整数 → 400')
    // 跨画布
    const nc2 = await jreq('POST', `/api/v1/canvases/${C2}/nodes`, { kind: 'gen', spec: { genKind: 'image', prompt: 'B' }, x: 0, y: 0 })
    const NX: number = nc2.body.node.id
    const eCross = await jreq('POST', `/api/v1/canvases/${C2}/edges`, { from: N1, to: NX, port: 'reference' })
    check(eCross.status === 400, '跨画布节点连线 → 400')

    // 派生读模型：任务状态映射
    await mkTask(PID, { canvasNodeId: N2, status: 'pending' })
    await mkTask(PID, { canvasNodeId: N2, status: 'succeeded', resultAssetId: A2 })
    const d2 = await jreq('GET', `/api/v1/canvases/${C1}`)
    const dn2 = docNode(d2.body, N2)
    check(dn2?.status === 'succeeded' && dn2?.latestTask?.resultAssetId === A2, '派生状态：最新任务 succeeded 映射')
    check(dn2?.asset?.id === A2 && dn2?.asset?.urls?.thumb !== null, 'gen 节点结果资产冗余（含缩略 URL）')
    check(dn2?.tasks?.length === 2, '任务历史最近 5 条透传')
    check(dn2?.readiness?.ready === true && dn2?.canRun === true, 'readiness：prompt 非空 + 上游素材就绪 → 可运行')
    await mkTask(PID, { canvasNodeId: N2, status: 'processing' })
    const d3 = await jreq('GET', `/api/v1/canvases/${C1}`)
    const dn2b = docNode(d3.body, N2)
    check(dn2b?.status === 'processing' && dn2b?.canCancel === true && dn2b?.canRun === false, 'busy：processing → canCancel / 禁 run')

    // readiness：编辑节点问题清单（无 prompt / 无 mask / source 已连但上游就绪）
    const dn4 = docNode(d3.body, N4)
    check(
      dn4?.readiness?.problems?.some((p: string) => p.includes('局部重绘需填写提示词')) &&
        dn4?.readiness?.problems?.some((p: string) => p.includes('缺少蒙版')),
      '编辑节点 readiness：inpaint 缺 prompt/蒙版 → problems 列出',
    )
    check(dn4?.editCapability !== null && dn4?.editCapability?.inpaint === false, '编辑节点 editCapability 快照（无端点 → false）')
    // 上游无产物：加一条来自 gen（无产物）节点的 reference 边（N5 无任务 → 无产物）
    const eUp = await jreq('POST', `/api/v1/canvases/${C1}/edges`, { from: N5, to: N4, port: 'reference' })
    check(eUp.status === 201, '编辑节点可再挂 reference 上游')
    // N5 无任务 → N4 的 reference 来自 N5（无产物）→ 问题
    const d4 = await jreq('GET', `/api/v1/canvases/${C1}`)
    const dn4b = docNode(d4.body, N4)
    check(
      dn4b?.readiness?.problems?.some((p: string) => p.includes('暂无成功产物')),
      '上游 gen 无产物 → readiness 列出「暂无成功产物」',
    )

    // 宽容：坏 spec
    await db.update(canvasNodes).set({ spec: '{bad json' }).where(eq(canvasNodes.id, N2))
    const d5 = await jreq('GET', `/api/v1/canvases/${C1}`)
    const dn2c = docNode(d5.body, N2)
    check(dn2c?.spec === null && typeof dn2c?.specError === 'string' && dn2c?.canRun === false, '坏 spec → specError + 禁 run（不炸）')
    await db.update(canvasNodes).set({ spec: JSON.stringify({ genKind: 'image', prompt: '一只猫' }) }).where(eq(canvasNodes.id, N2))

    // 列表 nodeCount
    const list = await jreq('GET', `/api/v1/projects/${PID}/canvases`)
    const item1 = (list.body?.items ?? []).find((x: any) => x.id === C1)
    check(item1?.nodeCount === 5, '画布列表 nodeCount=5')

    // 级联：删节点清边
    const nDel = await jreq('DELETE', `/api/v1/nodes/${N1}`)
    check(nDel.status === 200, 'DELETE 节点 → 200')
    const d6 = await jreq('GET', `/api/v1/canvases/${C1}`)
    check(
      (d6.body?.edges ?? []).every((e: any) => e.from !== N1 && e.to !== N1),
      '删节点 → 级联清理其全部连线',
    )

    // duplicate：id 全映射
    const dup = await jreq('POST', `/api/v1/canvases/${C1}/duplicate`, { name: '副本' })
    check(dup.status === 201 && dup.body?.canvas?.name === '副本', 'POST duplicate → 201')
    const CD: number = dup.body.canvas.id
    const dOrig = await jreq('GET', `/api/v1/canvases/${C1}`)
    const dCopy = await jreq('GET', `/api/v1/canvases/${CD}`)
    check(
      dCopy.body?.nodes?.length === dOrig.body?.nodes?.length && dCopy.body?.edges?.length === dOrig.body?.edges?.length,
      'duplicate：节点数/边数一致',
    )
    const origIds = new Set((dOrig.body?.nodes ?? []).map((n: any) => n.id))
    const copyIds = new Set((dCopy.body?.nodes ?? []).map((n: any) => n.id))
    check([...copyIds].every((id) => !origIds.has(id as number)), 'duplicate：节点 id 全部重映射')
    check((dCopy.body?.edges ?? []).every((e: any) => copyIds.has(e.from) && copyIds.has(e.to)), 'duplicate：边指向新节点集')

    // 404 全家桶
    check((await jreq('GET', '/api/v1/canvases/999999')).status === 404, 'GET 不存在画布 → 404')
    check((await jreq('PATCH', '/api/v1/canvases/999999', { name: 'x' })).status === 404, 'PATCH 不存在画布 → 404')
    check((await jreq('DELETE', '/api/v1/canvases/999999')).status === 404, 'DELETE 不存在画布 → 404')
    check((await jreq('PATCH', '/api/v1/nodes/999999', { x: 1 })).status === 404, 'PATCH 不存在节点 → 404')
    check((await jreq('DELETE', '/api/v1/nodes/999999')).status === 404, 'DELETE 不存在节点 → 404')
    check((await jreq('DELETE', '/api/v1/edges/999999')).status === 404, 'DELETE 不存在边 → 404')

    // [M18] 变更：DELETE 画布 → 软删（进回收站）；节点/边物理保留以支持恢复（原「物理级联清空」语义废弃）
    const nodeBefore = Number((await db.select({ n: count() }).from(canvasNodes).where(eq(canvasNodes.canvasId, C1)))[0]?.n ?? -1)
    const edgeBefore = await edgeCount(C1)
    const c1Del = await jreq('DELETE', `/api/v1/canvases/${C1}`)
    check(c1Del.status === 200, 'DELETE 画布 → 200（M18：软删进回收站）')
    check((await jreq('GET', `/api/v1/canvases/${C1}`)).status === 404, '软删后 GET → 404（正常读取过滤回收站项）')
    const nodeLeft = Number((await db.select({ n: count() }).from(canvasNodes).where(eq(canvasNodes.canvasId, C1)))[0]?.n ?? -1)
    check(
      nodeBefore > 0 && nodeLeft === nodeBefore && edgeBefore > 0 && (await edgeCount(C1)) === edgeBefore,
      '软删 → 节点/边物理保留（可恢复；M18 适配替代原「级联清空」断言）',
    )
  }

  /** ② node-build：输入映射纯矩阵 + 参数快照 + 执行通道失败链 */
  const sectionNodeBuild = async (): Promise<void> => {
    const imgSpec: NodeSpec = { genKind: 'image', prompt: 'P' }
    const videoSpec: NodeSpec = { genKind: 'video', prompt: 'V' }
    const editSpec: NodeSpec = { genKind: 'image', prompt: '', edit: { mode: 'inpaint' } }
    const up = (m: Array<[number, any]>): Map<number, any> => new Map(m)
    const upImg = (id: number): [number, any] => [id, { assetId: id + 100, mediaKind: 'image' }]

    // reference 上限：image ≤6
    const edges7 = Array.from({ length: 7 }, (_, i) => ({ from: i + 1, to: 100, port: 'reference' }))
    const p7 = planNodeInputs(imgSpec, 100, edges7, up(edges7.map((e) => upImg(e.from))))
    check(
      p7.referenceAssetIds.length === 6 && p7.problems.some((x) => x.includes('参考图超过上限 6 张')),
      '纯矩阵：image reference 上限 6（第 7 条忽略 + problems）',
    )
    // reference 上限：video ≤2
    const edges3 = Array.from({ length: 3 }, (_, i) => ({ from: i + 1, to: 100, port: 'reference' }))
    const p3 = planNodeInputs(videoSpec, 100, edges3, up(edges3.map((e) => upImg(e.from))))
    check(
      p3.referenceAssetIds.length === 2 && p3.problems.some((x) => x.includes('参考图超过上限 2 张')),
      '纯矩阵：video reference 上限 2',
    )
    // first_frame：图像节点拒绝；视频节点取值
    const pFFimg = planNodeInputs(imgSpec, 100, [{ from: 1, to: 100, port: 'first_frame' }], up([upImg(1)]))
    check(pFFimg.firstFrameAssetId === null && pFFimg.problems.some((x) => x.includes('首帧连线仅视频节点可用')), '纯矩阵：首帧仅视频')
    const pFFvideo = planNodeInputs(
      videoSpec,
      100,
      [
        { from: 1, to: 100, port: 'first_frame' },
        { from: 2, to: 100, port: 'last_frame' },
        { from: 3, to: 100, port: 'reference' },
      ],
      up([upImg(1), upImg(2), upImg(3)]),
    )
    check(
      pFFvideo.firstFrameAssetId === 101 && pFFvideo.lastFrameAssetId === 102 && pFFvideo.referenceAssetIds.length === 1,
      '纯矩阵：视频首帧/尾帧/参考多端口映射',
    )
    // source：非编辑拒绝；编辑缺连线；编辑上游无产物不重复报缺
    const pSrcBad = planNodeInputs(imgSpec, 100, [{ from: 1, to: 100, port: 'source' }], up([upImg(1)]))
    check(pSrcBad.sourceAssetId === null && pSrcBad.problems.some((x) => x.includes('源图连线仅编辑节点可用')), '纯矩阵：源图仅编辑节点')
    const pSrcMiss = planNodeInputs(editSpec, 100, [], up([]))
    check(pSrcMiss.problems.some((x) => x.includes('编辑节点缺少源图连线')), '纯矩阵：编辑节点缺 source 连线 → problems')
    const pSrcNoOut = planNodeInputs(
      editSpec,
      100,
      [{ from: 1, to: 100, port: 'source' }],
      up([[1, { assetId: null, mediaKind: null }]]),
    )
    check(
      pSrcNoOut.problems.some((x) => x.includes('暂无成功产物')) &&
        !pSrcNoOut.problems.some((x) => x.includes('编辑节点缺少源图连线')),
      '纯矩阵：编辑上游无产物只报「暂无成功产物」（不重复报缺源）',
    )
    // 上游非图片
    const pVideoUp = planNodeInputs(imgSpec, 100, [{ from: 1, to: 100, port: 'reference' }], up([[1, { assetId: 5, mediaKind: 'video' }]]))
    check(pVideoUp.problems.some((x) => x.includes('不能作为生成输入')), '纯矩阵：非图片产物 → problems（仅图片可入）')

    // topoSort
    const order = topoSortGenNodeIds([1, 2, 3, 4], [
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 1, to: 4 },
    ])
    check(JSON.stringify(order) === '[1,2,4,3]', 'topoSort：Kahn 稳定顺序 [1,2,4,3]')

    // 解析宽容（纯）
    check(
      parseViewport({ x: 0, y: 0, zoom: 0.01 })?.zoom === 0.1 && parseViewport({ x: 0, y: 0, zoom: 99 })?.zoom === 10,
      'parseViewport：zoom clamp [0.1, 10]',
    )
    check(parseViewport({ x: 0, y: 0, zoom: 'a' }) === null && parseViewport(null) === null, 'parseViewport：非法 → null')
    check(safeParseSpec('{bad').spec === null && safeParseSpec(null).error === 'spec 缺失', 'safeParseSpec：坏 JSON/缺失 → 宽容')
    check(specProblems({ genKind: 'image', prompt: '  ' }).some((x) => x.includes('prompt 为空')), 'specProblems：空 prompt → 问题清单')

    // buildNodeTaskParams 快照
    const specFull: NodeSpec = {
      genKind: 'image',
      prompt: 'P',
      size: '1024x1024',
      duration: 5,
      resolution: '720p',
      aspectRatio: '16:9',
      provider: 'prov',
      model: 'mod',
      useStylePreset: true,
      edit: { mode: 'inpaint', maskAssetId: 42 },
    }
    const planFull: InputPlan = {
      referenceAssetIds: [1, 2],
      firstFrameAssetId: null,
      lastFrameAssetId: null,
      sourceAssetId: 3,
      promptText: null,
      videoAssetIds: [],
      audioAssetIds: [],
      textInputs: [],
      problems: [],
      notes: [],
    }
    const paramsFull = buildNodeTaskParams(specFull, { stylePresetIds: [9], plan: planFull })
    const expectedParams =
      '{"size":"1024x1024","duration":5,"resolution":"720p","aspectRatio":"16:9","useStylePreset":true,"stylePresetIds":[9],' +
      '"edit":{"mode":"inpaint","maskAssetId":42,"expand":null},"input":{"referenceAssetIds":[1,2],"firstFrameAssetId":null,"lastFrameAssetId":null,"sourceAssetId":3}}'
    check(JSON.stringify(paramsFull) === expectedParams, 'buildNodeTaskParams 全字段快照')

    // appendStyleSnippet
    check(appendStyleSnippet('P', 'S') === 'P\n视觉风格：S', 'appendStyleSnippet：拼接')
    check(appendStyleSnippet('', 'S') === '视觉风格：S' && appendStyleSnippet('P', null) === 'P', 'appendStyleSnippet：空基名/空片段')

    // buildEditParams
    let threw = false
    try {
      buildEditParams({ genKind: 'image', prompt: 'p' }, { baseImage: 'b' })
    } catch {
      threw = true
    }
    check(threw, 'buildEditParams：非编辑 spec → 抛')
    threw = false
    try {
      buildEditParams({ genKind: 'image', prompt: 'p', edit: { mode: 'inpaint' } }, { baseImage: 'b' })
    } catch {
      threw = true
    }
    check(threw, 'buildEditParams：inpaint 缺 mask → 抛')
    const ep1 = buildEditParams({ genKind: 'image', prompt: ' 换色 ', edit: { mode: 'inpaint' } }, { baseImage: 'B', mask: 'M' })
    check(
      JSON.stringify(ep1) === '{"mode":"inpaint","baseImage":"B","mask":"M","prompt":"换色"}',
      'buildEditParams：inpaint 映射（prompt trim）',
    )
    const ep2 = buildEditParams({ genKind: 'image', prompt: '', edit: { mode: 'erase' } }, { baseImage: 'B', mask: 'M' })
    check(ep2.mask === 'M' && !('prompt' in ep2), 'buildEditParams：erase 无 prompt 省略')
    const ep3 = buildEditParams(
      { genKind: 'image', prompt: '', size: '1024x1024', edit: { mode: 'outpaint', expand: { angle: 30, xScale: 1.5 } } },
      { baseImage: 'B' },
    )
    check(
      JSON.stringify(ep3.expand) === '{"angle":30,"xScale":1.5}' && ep3.mask === undefined && ep3.size === '1024x1024',
      'buildEditParams：outpaint expand 透传（无 mask）',
    )

    // 环检测纯函数
    check(!wouldCreateCycle([{ from: 1, to: 2 }], 2, 3), 'wouldCreateCycle：延伸链 → false')
    check(wouldCreateCycle([{ from: 1, to: 2 }], 2, 1), 'wouldCreateCycle：直连回边 → true')
    check(wouldCreateCycle([{ from: 1, to: 2 }, { from: 2, to: 3 }], 3, 1), 'wouldCreateCycle：长链回边 → true')

    // ---- 执行通道失败链（无端点配置：任务落库 → 失败透传 → 复位）----
    const cExec = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '执行画布' })
    const CX: number = cExec.body.canvas.id
    const nr = await jreq('POST', `/api/v1/canvases/${CX}/nodes`, { kind: 'gen', spec: { genKind: 'image', prompt: '失败链' }, x: 5, y: 5 })
    const NX: number = nr.body.node.id
    const run1 = await jreq('POST', `/api/v1/nodes/${NX}/run`)
    check(run1.status === 200 && run1.body?.taskId > 0, '执行通道：run → 200 任务入队')
    const tid: number = run1.body.taskId
    const trow = (await db.select().from(genTasks).where(eq(genTasks.id, tid)))[0]!
    check(
      trow.canvasNodeId === NX && trow.runId === null && trow.stepId === null && ['pending', 'processing'].includes(trow.status),
      '任务行：canvasNodeId 归属 + run/step 恒 null',
    )
    check(String(trow.params).includes('referenceAssetIds'), '任务行 params 含输入快照')
    const busy = await jreq('POST', `/api/v1/nodes/${NX}/run`)
    check(busy.status === 400, '执行通道：busy 期间重复 run → 400')
    let st = ''
    let errMsg: string | null = null
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      const rows = await db.select().from(genTasks).where(eq(genTasks.id, tid))
      st = rows[0]?.status ?? ''
      errMsg = rows[0]?.errorMsg ?? null
      if (st === 'failed' || st === 'cancelled' || st === 'succeeded') break
      await sleep(400)
    }
    check(st === 'failed' && !!errMsg, `执行通道：无端点配置 → 自动重试后 failed（errorMsg 透传：${String(errMsg).slice(0, 60)}）`)
    const docAfter = await jreq('GET', `/api/v1/canvases/${CX}`)
    const dn = docNode(docAfter.body, NX)
    check(dn?.status === 'failed' && dn?.canRun === true && dn?.canCancel === false, '失败后复位：failed → 可重跑')
    // 复用端点自然不误伤
    const retry = await jreq('POST', `/api/v1/tasks/${tid}/retry`)
    check(retry.status === 400 && retry.body?.error?.code === 'no_step', 'POST /tasks/:id/retry 对画布任务 → 400 no_step（不误伤）')
    const cancel = await jreq('POST', `/api/v1/tasks/${tid}/cancel`)
    check(cancel.status === 400, 'POST /tasks/:id/cancel 对终态画布任务 → 400（复用既有端点）')

    // recoverCanvasTasks：pending 画布任务 → failed「服务重启中断」
    const tRec = await mkTask(PID, { canvasNodeId: NX, status: 'pending' })
    const rec = await recoverCanvasTasks()
    const tRecAfter = (await db.select().from(genTasks).where(eq(genTasks.id, tRec)))[0]!
    check(rec.failed >= 1 && tRecAfter.status === 'failed' && tRecAfter.errorMsg === '服务重启中断', 'recoverCanvasTasks → failed「服务重启中断」')
    // 既有 run 任务不受 recover 影响
    const tRun = await mkTask(PID, { runId: 424242, stepId: 1, status: 'pending' })
    await recoverCanvasTasks()
    const tRunAfter = (await db.select().from(genTasks).where(eq(genTasks.id, tRun)))[0]!
    check(tRunAfter.status === 'pending', 'recover 仅命中画布任务（run 任务不动）')
  }

  /** ③ edit-cap：适配器编辑声明与请求构造快照（fetch 记录器拦截，零网络） */
  const sectionEditCap = async (): Promise<void> => {
    const { AliyunWanImageAdapter } = await import('../src/adapters/aliyun-wan-image')
    const { AliyunQwenImageAdapter } = await import('../src/adapters/aliyun-qwen-image')
    const wan = new AliyunWanImageAdapter()
    check(wan.editing?.inpaint === true && wan.editing?.outpaint === true, 'aliyun-wan editing 声明 {inpaint, outpaint}')
    check(typeof wan.edit === 'function', 'aliyun-wan edit 方法存在')
    const qwen = new AliyunQwenImageAdapter()
    check((qwen as any).editing === undefined, '未声明适配器（aliyun-qwen）→ editing undefined')

    const capNone = await editCapabilityOf()
    check(capNone.inpaint === false && capNone.erase === false && capNone.outpaint === false, 'editCapabilityOf 无端点配置 → 全 false')

    // fetch 记录器：奇数次调用 = 提交（返回 task_id），偶数次 = 轮询（返回结果）
    const calls: Array<{ url: string; body: any }> = []
    globalThis.fetch = (async (url: any, init: any) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ url: String(url), body })
      if (calls.length % 2 === 1) return jsonRes({ output: { task_id: `probe-edit-${calls.length}` } })
      return jsonRes({ output: { task_status: 'SUCCEEDED', results: [{ url: 'https://probe.local/out.png' }] } })
    }) as typeof fetch
    try {
      // inpaint
      const r1 = await wan.edit({
        mode: 'inpaint',
        baseImage: 'data:image/png;base64,AA',
        mask: 'data:image/png;base64,BB',
        prompt: '换成红色',
        baseUrl: 'http://probe.local',
        apiKey: 'k',
      })
      check(r1.kind === 'url' && r1.url === 'https://probe.local/out.png', 'wan.edit inpaint → 出图 URL')
      const submit1 = calls[0]!
      check(submit1.url.includes('/services/aigc/image2image/image-synthesis'), 'wan.edit 提交端点 image2image/image-synthesis')
      check(
        submit1.body?.model === 'wanx2.1-imageedit' &&
          submit1.body?.input?.function === 'description_edit_with_mask' &&
          submit1.body?.input?.mask_image_url === 'data:image/png;base64,BB' &&
          submit1.body?.input?.prompt === '换成红色' &&
          submit1.body?.input?.base_image_url === 'data:image/png;base64,AA',
        'wan.edit inpaint 请求体快照（function/mask/prompt/base）',
      )
      check(calls[1]?.url.includes('/tasks/probe-edit-1'), 'wan.edit 轮询任务端点')
      // erase 无 prompt → 默认词
      await wan.edit({ mode: 'erase', baseImage: 'data:image/png;base64,AA', mask: 'data:image/png;base64,CC', baseUrl: 'http://probe.local', apiKey: 'k' })
      check(
        calls[2]?.body?.input?.prompt === '去除涂抹区域的物体，并用周围背景自然填补',
        'wan.edit erase 无指令 → 默认提示词',
      )
      // outpaint expand
      await wan.edit({
        mode: 'outpaint',
        baseImage: 'data:image/png;base64,AA',
        expand: { angle: 30, xScale: 1.5, yScale: 2 },
        baseUrl: 'http://probe.local',
        apiKey: 'k',
      })
      const submit3 = calls[4]!
      check(
        submit3.body?.input?.function === 'expand' &&
          submit3.body?.parameters?.angle === 30 &&
          submit3.body?.parameters?.x_scale === 1.5 &&
          submit3.body?.parameters?.y_scale === 2 &&
          submit3.body?.input?.mask_image_url === undefined,
        'wan.edit outpaint 请求体快照（function=expand + parameters 三元组）',
      )
      // 本地校验：inpaint 缺 mask → 抛且不发请求
      const before = calls.length
      let threw = false
      try {
        await wan.edit({ mode: 'inpaint', baseImage: 'data:image/png;base64,AA', prompt: 'x', baseUrl: 'http://probe.local', apiKey: 'k' })
      } catch {
        threw = true
      }
      check(threw && calls.length === before, 'wan.edit inpaint 缺 mask → 本地抛错（零请求）')
    } finally {
      globalThis.fetch = stubFetch
    }
  }

  /** ④ draft：模板草案纯夹具快照 + 与 validateTemplateText 同源一致性 */
  const sectionDraft = async (): Promise<void> => {
    const emptyNode = {
      id: 0,
      kind: 'gen' as const,
      x: 0,
      y: 0,
      title: '',
      assetId: null,
      asset: null,
      spec: null,
      specError: null,
      status: null,
      latestTask: null,
      tasks: [],
      readiness: null,
      editCapability: null,
      canRun: null,
      canCancel: null,
    }
    const doc: CanvasDoc = {
      canvas: { id: 77, projectId: PID, name: '夹具画布', viewport: { x: 0, y: 0, zoom: 1 } },
      nodes: [
        {
          ...emptyNode,
          id: 1,
          kind: 'asset',
          title: '素材甲',
          assetId: 5,
          // [M22] 补全 asset（kind=image）——供参考边映射判定（真画布由 buildCanvasDoc 填充）
          asset: { id: 5, kind: 'image', purpose: null, name: '素材甲', mime: 'image/png', width: null, height: null, duration: null, prompt: null, urls: { file: 'f', thumb: null } },
        },
        { ...emptyNode, id: 2, title: '图片 #2', spec: { genKind: 'image', prompt: '镜头一' } },
        { ...emptyNode, id: 3, title: '视频 #3', spec: { genKind: 'video', prompt: '运镜', duration: 5 } },
        { ...emptyNode, id: 4, title: '编辑 #4', spec: { genKind: 'image', prompt: '', edit: { mode: 'inpaint', maskAssetId: 8 } } },
      ],
      edges: [
        { id: 1, from: 1, to: 2, port: 'reference' },
        { id: 2, from: 2, to: 3, port: 'first_frame' },
        { id: 3, from: 1, to: 4, port: 'source' },
      ],
    }
    // [M18] draft v2：buildTemplateDraftYaml 返回 {yaml, lossy[]}；asset 节点 → inputs（非 `inputs: []`）；
    // 编辑/参考/蒙版注释 → lossy 清单（不再写入 YAML 注释）
    const { yaml, lossy } = buildTemplateDraftYaml(doc, 'canvas-draft-77')
    check(
      yaml.includes('key: canvas-draft-77') &&
        yaml.includes('inputs:') &&
        yaml.includes('key: a1') &&
        yaml.includes('kind: files'),
      '草案 v2：key + asset 节点 → inputs.a1 files 输入',
    )
    const iN2 = yaml.indexOf('key: n2')
    const iN4 = yaml.indexOf('key: n4')
    const iN3 = yaml.indexOf('key: n3')
    check(iN2 > 0 && iN4 > iN2 && iN3 > iN4, '草案 v2：gen 节点拓扑序 n2 → n4 → n3')
    check(!yaml.includes('key: n1'), '草案 v2：素材节点不产生 step')
    check(yaml.includes('action: literal'), '草案 v2：image/video 节点前置 literal 包装步骤')
    check(yaml.includes('action: ai_video'), '草案 v2：视频节点 action=ai_video')
    check(yaml.includes('as: storyboard-single'), '草案 v2：literal as=storyboard-single 包装 prompt')
    check(yaml.includes('after: [n2]'), '草案 v2：边 → after 引用（n3 lit after n2）')
    check(
      lossy.some((s) => s.includes('#4') && s.includes('编辑模式')),
      '草案 v2 lossy：编辑模式节点写入 lossy 清单',
    )
    check(
      yaml.includes('refs:') && yaml.includes('- input.a1'),
      '草案 v2：reference 边（图片 asset 源）→ lit inputs.refs（M22 保真直通）',
    )
    check(
      yaml.includes('first_frame: steps.n2.asset'),
      '草案 v2：first_frame 边（image gen 源）→ lit inputs.first_frame（M22 保真直通）',
    )
    check(
      lossy.some((s) => s.includes('#4') && s.includes('未映射')),
      '草案 v2 lossy：编辑源连线未映射（M22 收缩文案）',
    )

    // DB 层 + 同源一致性
    const cn = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '草案画布' })
    const C3: number = cn.body.canvas.id
    await jreq('POST', `/api/v1/canvases/${C3}/nodes`, { kind: 'gen', spec: { genKind: 'image', prompt: '草案镜' }, x: 0, y: 0 })
    const dr = await jreq('POST', `/api/v1/canvases/${C3}/template-draft`, { key: `probe-draft-${C3}` })
    check(
      dr.status === 200 && typeof dr.body?.yaml === 'string' && Array.isArray(dr.body?.lossy),
      'POST template-draft → 200 {yaml, validation, lossy[]}',
    )
    const direct = validateTemplateText(dr.body.yaml, `probe-draft-${C3}`)
    check(
      dr.body?.validation?.ok === direct.ok &&
        JSON.stringify(dr.body?.validation?.errors) === JSON.stringify(direct.errors),
      '草案 validation 与 validateTemplateText 同源一致',
    )
    check((await jreq('POST', '/api/v1/canvases/999999/template-draft', {})).status === 404, 'template-draft 不存在画布 → 404')
    const badKey = await jreq('POST', `/api/v1/canvases/${C3}/template-draft`, { key: 'bad key!' })
    check(badKey.status === 400, 'template-draft 非法 key → 400')
    const { buildTemplateDraft } = await import('../src/services/creation')
    check((await buildTemplateDraft(999999)) === null, 'buildTemplateDraft 不存在 → null')
  }

  /** ⑤ linkage：ref-assets / 送入画布 / prefill 键安全 */
  const sectionLinkage = async (): Promise<void> => {
    // ref-assets 并集挂接
    const ent = (
      await db
        .insert(characters)
        .values({ projectId: PID, kind: 'character', name: '角色甲', aliases: '[]', states: '[]', refAssetIds: '[]', meta: '{}', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!
    const r1 = await jreq('POST', `/api/v1/entities/${ent.id}/ref-assets`, { asset_ids: [A1] })
    check(r1.status === 200 && r1.body?.added === 1, 'ref-assets：挂接 1 张 → added=1')
    const r2 = await jreq('POST', `/api/v1/entities/${ent.id}/ref-assets`, { asset_ids: [A1, A2] })
    const rowAfter = (await db.select().from(characters).where(eq(characters.id, ent.id)))[0]!
    check(r2.status === 200 && r2.body?.added === 1 && JSON.parse(rowAfter.refAssetIds).join(',') === `${A1},${A2}`, 'ref-assets：并集去重（added=1，落库 [A1,A2]）')
    check((await jreq('POST', '/api/v1/entities/999999/ref-assets', { asset_ids: [A1] })).status === 404, 'ref-assets 不存在实体 → 404')
    const entG = (
      await db
        .insert(characters)
        .values({ projectId: null, kind: 'character', name: '全局角色', aliases: '[]', states: '[]', refAssetIds: '[]', meta: '{}', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!
    check((await jreq('POST', `/api/v1/entities/${entG.id}/ref-assets`, { asset_ids: [A1] })).status === 400, 'ref-assets 全局实体拒绝 → 400')
    check((await jreq('POST', `/api/v1/entities/${ent.id}/ref-assets`, { asset_ids: [] })).status === 400, 'ref-assets 空数组 → 400')
    check((await jreq('POST', `/api/v1/entities/${ent.id}/ref-assets`, { asset_ids: [A_OTHER] })).status === 400, 'ref-assets 他项目资产 → 400（项目域）')

    // 送入画布：run 产物资产 → 素材节点（模拟 CanvasDrawer「送入创作画布」）
    const runAsset = await mkAsset(PID, 'image', 'run 产物', 'shot_image')
    const c4 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '联动画布' })
    const C4: number = c4.body.canvas.id
    const push = await jreq('POST', `/api/v1/canvases/${C4}/nodes`, { kind: 'asset', assetId: runAsset, x: 100, y: 100 })
    check(push.status === 201, '送入画布：POST 素材节点 → 201')
    const dC4 = await jreq('GET', `/api/v1/canvases/${C4}`)
    const pushed = (dC4.body?.nodes ?? []).find((n: any) => n.assetId === runAsset)
    check(pushed?.asset?.urls?.file === `/api/v1/assets/${runAsset}/file`, '送入画布：节点资产视图（file URL）')

    // prefill 键安全：未声明键静默丢弃（normalizeInput 前置）
    const { prepareRunInput } = await import('../src/services/run-create')
    const tplM = loadTemplate('mengbao-episode')
    const norm = prepareRunInput(tplM, { brief: 'B', episode_number: '3', setting_docs: [A1], bogus_key: 'x' })
    check(
      JSON.stringify(norm['setting_docs']) === `[${A1}]` && norm['episode_number'] === 3 && !('bogus_key' in norm),
      'prefill 键安全：setting_docs 归一 + 未声明键 bogus_key 丢弃',
    )
    let threw = false
    try {
      prepareRunInput(tplM, { brief: 'B', episode_number: 1, setting_docs: ['bad'] })
    } catch {
      threw = true
    }
    check(threw, 'prefill 键安全：非法 files 元素 → 抛（bad_input 语义）')
  }

  /** ⑥ regression：probe:m15 子进程全绿（内含 m2a/m4/m14）+ 新列兼容抽样 */
  const sectionRegression = async (): Promise<void> => {
    // 兼容抽样：普通任务（run/step 归属，canvasNodeId null）读写不受新列影响
    const tRun = await mkTask(PID, { runId: 778899, stepId: 3, status: 'succeeded', resultAssetId: A1 })
    const hit = await db.select().from(genTasks).where(and(eq(genTasks.runId, 778899), isNull(genTasks.canvasNodeId)))
    check(hit.length === 1 && hit[0]?.id === tRun, '兼容抽样：既有 run 任务查询（canvasNodeId is null）命中')

    const { spawnSync } = await import('node:child_process')
    const childEnv = { ...process.env }
    delete childEnv.CSTUDIO_ROOT
    delete childEnv.CSTUDIO_DATA
    delete childEnv.CSTUDIO_WORKSPACE
    const r = spawnSync('npm', ['run', 'probe:m15'], {
      cwd: join(REPO_ROOT, 'apps', 'server'),
      env: childEnv,
      shell: true,
      encoding: 'utf8',
      timeout: 15 * 60_000,
    })
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
    const tail = out
      .split('\n')
      .filter((l) => l.includes('探针结果') || l.includes('FAIL'))
      .slice(-3)
      .join(' | ')
    check(r.status === 0, `probe:m15 全绿（内含 m2a/m4/m14 零漂移；exit=${String(r.status)}${r.status === 0 ? '' : `；${tail || out.slice(-300).trim()}`}）`)
  }

  // ================= 分发 =================
  const runners: Record<string, () => Promise<void>> = {
    'canvas-doc': sectionCanvasDoc,
    'node-build': sectionNodeBuild,
    'edit-cap': sectionEditCap,
    draft: sectionDraft,
    linkage: sectionLinkage,
    regression: sectionRegression,
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
    console.log(`\n==== M16 探针结果: ${failed > 0 ? `${failed} 项失败` : '全部通过'} ====`)
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
