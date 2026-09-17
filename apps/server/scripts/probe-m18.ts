/**
 * M18 探针（创作画布四批能力全量补齐：快赢 / 安全 / 深度 / 规模）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m18.ts [--section=p1-schema|frame-extract|compose-v3|run-preview|trash-snapshot|llm-node|template-v2|groups|scale-zip]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录（独立 studio.db + workspace），
 * 不触碰开发库（同 probe-m2a~m17）。globalThis.fetch stub 兜底（零网络、零计费）。画布 HTTP 全链经 app.request 内存执行。
 *
 * section（默认 all）：
 *   p1-schema      [P1] 迁移与兜底：deleted_at / group_id 列 + canvas_groups / canvas_snapshots 表与索引 +
 *                  schema 读写冒烟 + initDb 幂等
 *   frame-extract  [P2] 抽帧：frameTimeOf 全模式矩阵 + buildFrameExtractArgs 快照 + 端点全链（真实 ffmpeg）
 *   compose-v3     [P2] 合成 v3：buildComposeArgs 快照（旧形态不变 / 转场 / BGM / 降级）+ 真实合成冒烟
 *   run-preview    [P2] 成本预估：preflight + 定价链 + 各 genKind 单位矩阵 + 响应结构
 *   trash-snapshot [P3] 回收站与快照：软删/在途取消/trash 列表/restore/purge + 保留 id 重放（任务历史认领）
 *   llm-node       [P4] LLM 节点：端口 v3 全组合 + specProblems + 执行链 + 产物文本下游装载
 *   template-v2    [P5] 模板 v2：literal action + ai_text prompt_inline + draft v2 映射 + template-try 全链
 *   groups         [P6] 画布分组：CRUD + 跨组拒绝 + 解组 + 读模型
 *   scale-zip      [P6] 封面派生矩阵 + 流式 zip 对拍（名称/数量/内容等价 + 大文件路径）
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 *
 * [M26·H5b] 拆分：入口薄化（probe-lib isolatedEnv/makeChecker/runSections + 组装 ctx），
 * 九节断言体逐字搬入 probes/m18/*.ts（断言文案/顺序/计数零变更）；各节保留自持的服务纯函数动态导入。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'
import { run as runP1Schema } from './probes/m18/p1-schema'
import { run as runFrameExtract } from './probes/m18/frame-extract'
import { run as runComposeV3 } from './probes/m18/compose-v3'
import { run as runRunPreview } from './probes/m18/run-preview'
import { run as runTrashSnapshot } from './probes/m18/trash-snapshot'
import { run as runLlmNode } from './probes/m18/llm-node'
import { run as runTemplateV2 } from './probes/m18/template-v2'
import { run as runGroups } from './probes/m18/groups'
import { run as runScaleZip } from './probes/m18/scale-zip'

// ---- 隔离环境：必须先于任何 src 模块加载（probe-lib isolatedEnv 复刻 acs-probe-m18- 前缀语义）----
const { tmp: TMP, cleanup: envCleanup } = isolatedEnv('m18')
// LLM 兜底屏蔽（隔离）：dotenv 不覆盖已存在 key → .env 的 AGENT_LLM_* 不参与；本探针只走 api_configs 种子
process.env.AGENT_LLM_BASE_URL = ''
process.env.AGENT_LLM_API_KEY = ''

const SECTIONS = [
  'p1-schema',
  'frame-extract',
  'compose-v3',
  'run-preview',
  'trash-snapshot',
  'llm-node',
  'template-v2',
  'groups',
  'scale-zip',
] as const

// ---- fetch stub：兜底安全网（本探针零真实外发请求）----
const stubFetch = (async (): Promise<Response> => {
  return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

/** 任务收敛轮询间隔（对齐 probe-m16/m17 执行通道模式） */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function main(): Promise<void> {
  const origFetch = globalThis.fetch
  globalThis.fetch = stubFetch

  // src 模块全部动态加载（环境变量已隔离）
  const { db, initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')
  const { apiConfigs, assets, canvasEdges, canvasGroups, canvasNodes, canvasSnapshots, canvases, genTasks, pipelineRuns, projects, settings, usageRecords } = await import('../src/db/schema')
  const { and, eq, inArray } = await import('drizzle-orm')
  const { app } = await import('../src/app')
  const { spawnSync } = await import('node:child_process')
  const { probeMediaDuration, resolveFfmpeg } = await import('../src/services/ffmpeg')
  const { absPathOf, ensureProjectDirs, relPathOf } = await import('../src/services/storage')

  const log = createLogger('probe-m18')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  // ---- setup：隔离库 + 种子工厂 ----
  await initDb()
  const T0 = 1_700_000_000_000

  const mkProject = async (name: string): Promise<number> => {
    const id = (
      await db
        .insert(projects)
        .values({ name, genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!.id
    ensureProjectDirs(id) // 媒体落盘目录（genMedia 输出依赖；真实链由服务端各自 ensure）
    return id
  }

  /** 资产工厂（relPath/duration/软删等可选；对齐 probe-m17 超集） */
  const mkAsset = async (
    projectId: number,
    kind: string,
    name: string,
    opts: { purpose?: string; relPath?: string; duration?: number; deletedAt?: number; width?: number; height?: number } = {},
  ): Promise<number> =>
    (
      await db
        .insert(assets)
        .values({
          projectId,
          kind,
          name,
          purpose: opts.purpose ?? null,
          mime: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/wav' : 'text/plain',
          relPath: opts.relPath ?? null,
          duration: opts.duration ?? null,
          deletedAt: opts.deletedAt ?? null,
          width: opts.width ?? null,
          height: opts.height ?? null,
          createdAt: T0,
          updatedAt: T0,
        })
        .returning()
    )[0]!.id

  /** 真实媒体生成（ffmpeg lavfi；ffmpeg 不可用 → false 走 SKIP 分支；失败打印 stderr 尾部便于诊断） */
  const ffmpegBin = resolveFfmpeg()
  const genMedia = (outAbs: string, args: string[]): boolean => {
    if (!ffmpegBin) return false
    const r = spawnSync(ffmpegBin, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true })
    if (!r.error && r.status === 0) return true
    log.warn(`genMedia 失败（${outAbs}）：${r.error?.message ?? `exit=${r.status}`} ${String(r.stderr ?? '').trim().split(/\r?\n/).slice(-2).join(' | ')}`)
    return false
  }

  /** 任务收敛轮询（对齐 probe-m17）：全终态或超时（25s）返回 id→status */
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

  const ctx = {
    check,
    log,
    mkProject,
    mkAsset,
    genMedia,
    settleTasks,
    jreq,
    stubFetch,
    ffmpegBin,
    probeMediaDuration,
    db,
    sqlite,
    initDb,
    and,
    eq,
    inArray,
    apiConfigs,
    assets,
    canvasEdges,
    canvasGroups,
    canvasNodes,
    canvasSnapshots,
    canvases,
    genTasks,
    pipelineRuns,
    projects,
    settings,
    usageRecords,
    absPathOf,
    ensureProjectDirs,
    relPathOf,
    T0,
  }

  // ================= 分发 =================
  const runners: Record<string, () => Promise<void>> = {
    'p1-schema': () => runP1Schema(ctx),
    'frame-extract': () => runFrameExtract(ctx),
    'compose-v3': () => runComposeV3(ctx),
    'run-preview': () => runRunPreview(ctx),
    'trash-snapshot': () => runTrashSnapshot(ctx),
    'llm-node': () => runLlmNode(ctx),
    'template-v2': () => runTemplateV2(ctx),
    groups: () => runGroups(ctx),
    'scale-zip': () => runScaleZip(ctx),
  }

  await runSections({
    log,
    title: 'M18',
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
