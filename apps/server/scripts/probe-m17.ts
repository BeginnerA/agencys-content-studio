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
 *
 * [M26·H5b] 拆分：入口薄化（probe-lib isolatedEnv/makeChecker/runSections + 组装 ctx），
 * 八节断言体逐字搬入 probes/m17/*.ts（断言文案/顺序/计数零变更）。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'
import { run as runNodeKinds } from './probes/m17/node-kinds'
import { run as runPortV2 } from './probes/m17/port-v2'
import { run as runInputV2 } from './probes/m17/input-v2'
import { run as runBatchOps } from './probes/m17/batch-ops'
import { run as runVariantAdopt } from './probes/m17/variant-adopt'
import { run as runRunNode } from './probes/m17/run-node'
import { run as runExport } from './probes/m17/export'
import { run as runLlmAssist } from './probes/m17/llm-assist'

// ---- 隔离环境：必须先于任何 src 模块加载（probe-lib isolatedEnv 复刻 acs-probe-m17- 前缀语义）----
const { tmp: TMP, cleanup: envCleanup } = isolatedEnv('m17')

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
  const { chainPortCandidates, computeArrange } = await import('../src/services/creation/ops')
  const { buildComposeArgs, extendTaskParams, parseResolution } = await import('../src/services/creation/gen')
  const { absPathOf, ensureProjectDirs } = await import('../src/services/storage')

  const log = createLogger('probe-m17')
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

  const ctx = {
    check,
    log,
    db,
    T0,
    mkProject,
    mkAsset,
    mkTask,
    mkEntity,
    mkRun,
    docNode,
    settleTasks,
    jreq,
    sleep,
    stubFetch,
    env,
    loadInputPlan,
    pickDisplayTask,
    planNodeInputs,
    specProblems,
    chainPortCandidates,
    computeArrange,
    buildComposeArgs,
    extendTaskParams,
    parseResolution,
    absPathOf,
    ensureProjectDirs,
    eq,
    inArray,
    assets,
    canvasEdges,
    canvasNodes,
    characters,
    genTasks,
    pipelineRuns,
    pipelineSteps,
    projects,
    usageRecords,
    PID,
    OTHER,
    A1,
    A2,
    A3,
    AV,
    AA,
    AT,
    A_OTHER,
    ENT,
    ENT_EMPTY,
    ENT_G,
    ENT_OTHER,
    RUN1,
    RUN2,
    RUN_OTHER,
  }

  // ================= 分发 =================
  const runners: Record<string, () => Promise<void>> = {
    'node-kinds': () => runNodeKinds(ctx),
    'port-v2': () => runPortV2(ctx),
    'input-v2': () => runInputV2(ctx),
    'batch-ops': () => runBatchOps(ctx),
    'variant-adopt': () => runVariantAdopt(ctx),
    'run-node': () => runRunNode(ctx),
    export: () => runExport(ctx),
    'llm-assist': () => runLlmAssist(ctx),
  }

  await runSections({
    log,
    title: 'M17',
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
