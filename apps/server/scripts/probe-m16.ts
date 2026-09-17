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
 *
 * [M26·H5b] 拆分：入口薄化（probe-lib isolatedEnv/makeChecker/runSections + 组装 ctx），
 * 六节断言体逐字搬入 probes/m16/*.ts（断言文案/顺序/计数零变更）。
 */
import { cpSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'
import { run as runCanvasDoc } from './probes/m16/canvas-doc'
import { run as runNodeBuild } from './probes/m16/node-build'
import { run as runEditCap } from './probes/m16/edit-cap'
import { run as runDraft } from './probes/m16/draft'
import { run as runLinkage } from './probes/m16/linkage'
import { run as runRegression } from './probes/m16/regression'

// ---- 隔离环境：必须先于任何 src 模块加载（probe-lib isolatedEnv 复刻 acs-probe-m16- 前缀语义）----
const { tmp: TMP, cleanup: envCleanup } = isolatedEnv('m16')

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
  void startCanvasNodeRun
  void buildTemplateDraft // 部分符号供节内动态 import 复用语义对齐；入口保留原导入面

  // 模板文件就位（隔离 workspace；loadTemplate 读隔离 TEMPLATES_DIR）
  const TPL_SRC = join(REPO_ROOT, 'workspace', 'templates')
  const TPL_DST = join(process.env.CSTUDIO_WORKSPACE!, 'templates')
  mkdirSync(TPL_DST, { recursive: true })
  for (const f of readdirSync(TPL_SRC)) {
    if (/\.ya?ml$/.test(f)) cpSync(join(TPL_SRC, f), join(TPL_DST, f))
  }

  const log = createLogger('probe-m16')
  const checker: Checker = makeChecker(log)
  const check = checker.check

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

  const ctx = {
    check,
    db,
    canvasEdges,
    canvasNodes,
    characters,
    genTasks,
    and,
    count,
    eq,
    isNull,
    appendStyleSnippet,
    buildEditParams,
    buildNodeTaskParams,
    recoverCanvasTasks,
    editCapabilityOf,
    parseViewport,
    planNodeInputs,
    safeParseSpec,
    specProblems,
    topoSortGenNodeIds,
    wouldCreateCycle,
    buildTemplateDraftYaml,
    validateTemplateText,
    loadTemplate,
    REPO_ROOT,
    T0,
    PID,
    OTHER,
    A1,
    A2,
    A_OTHER,
    sleep,
    jsonRes,
    stubFetch,
    jreq,
    docNode,
    edgeCount,
    mkAsset,
    mkTask,
  }

  // ================= 分发 =================
  const runners: Record<string, () => Promise<void>> = {
    'canvas-doc': () => runCanvasDoc(ctx),
    'node-build': () => runNodeBuild(ctx),
    'edit-cap': () => runEditCap(ctx),
    draft: () => runDraft(ctx),
    linkage: () => runLinkage(ctx),
    regression: () => runRegression(ctx),
  }

  await runSections({
    log,
    title: 'M16',
    checker,
    sections: SECTIONS,
    runners,
    cleanup: () => {
      globalThis.fetch = origFetch // 还原网络栈
      try {
        sqlite.close() // 释放 db 连接（Windows 下句柄可能仍被 libsql 持有 → 失败不阻断）
      } catch {
        /* 已关闭或未初始化 */
      }
      try {
        envCleanup()
      } catch {
        console.log(`临时目录未完全清理（Windows libsql 句柄；下次运行自动清理）: ${TMP}`)
      }
    },
  })
}

void main()
