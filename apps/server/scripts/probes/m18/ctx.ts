/**
 * M18 探针共享上下文类型（M26·H5b 拆分产物）。
 *
 * 拆分纪律：原 probe-m18.ts 的 9 个 section 闭包所捕获的全部自由标识符集中于此 ctx，
 * 由各节 `run(ctx)` 首行解构后**逐字复用原断言体**（断言文案/顺序/计数零变更）。
 * 与各节内部保留的 `await import('..src..')` 服务符号不同，本 ctx 只承载 setup 产物 +
 * schema 表/操作符 + 通用 helper（服务纯函数仍由各节自持动态导入，逐字不变）。
 * 本文件仅类型（字段类型用 `typeof import('..')` 类型查询，零运行时求值，不触碰 env 加载时机）。
 */

export interface M18Ctx {
  check: (cond: boolean, msg: string) => void
  log: import('../../../src/logger').Logger
  // ---- setup 工厂 / helper（入口 main 定义后注入）----
  mkProject: (name: string) => Promise<number>
  mkAsset: (
    projectId: number,
    kind: string,
    name: string,
    opts?: { purpose?: string; relPath?: string; duration?: number; deletedAt?: number; width?: number; height?: number },
  ) => Promise<number>
  genMedia: (outAbs: string, args: string[]) => boolean
  settleTasks: (ids: number[]) => Promise<Map<number, string>>
  jreq: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>
  stubFetch: typeof fetch
  ffmpegBin: ReturnType<typeof import('../../../src/services/ffmpeg').resolveFfmpeg>
  probeMediaDuration: typeof import('../../../src/services/ffmpeg').probeMediaDuration
  // ---- db / 迁移（入口动态 import 后注入）----
  db: typeof import('../../../src/db').db
  sqlite: typeof import('../../../src/db').sqlite
  initDb: typeof import('../../../src/db').initDb
  // ---- drizzle 操作符 ----
  and: (...args: any[]) => any
  eq: (...args: any[]) => any
  inArray: (...args: any[]) => any
  // ---- schema 表 ----
  apiConfigs: typeof import('../../../src/db/schema').apiConfigs
  assets: typeof import('../../../src/db/schema').assets
  canvasEdges: typeof import('../../../src/db/schema').canvasEdges
  canvasGroups: typeof import('../../../src/db/schema').canvasGroups
  canvasNodes: typeof import('../../../src/db/schema').canvasNodes
  canvasSnapshots: typeof import('../../../src/db/schema').canvasSnapshots
  canvases: typeof import('../../../src/db/schema').canvases
  genTasks: typeof import('../../../src/db/schema').genTasks
  pipelineRuns: typeof import('../../../src/db/schema').pipelineRuns
  projects: typeof import('../../../src/db/schema').projects
  settings: typeof import('../../../src/db/schema').settings
  usageRecords: typeof import('../../../src/db/schema').usageRecords
  // ---- storage ----
  absPathOf: typeof import('../../../src/services/storage').absPathOf
  ensureProjectDirs: typeof import('../../../src/services/storage').ensureProjectDirs
  relPathOf: typeof import('../../../src/services/storage').relPathOf
  // ---- 常量 ----
  T0: number
}
