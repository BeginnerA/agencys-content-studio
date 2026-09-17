/**
 * M17 探针共享上下文类型（M26·H5b 拆分产物）。
 *
 * 拆分纪律：原 probe-m17.ts 的 8 个 section 闭包所捕获的全部自由标识符集中于此 ctx，
 * 由各节 `run(ctx)` 首行解构后**逐字复用原断言体**（断言文案/顺序/计数零变更）。
 * m17 各节大量依赖 main 作用域符号（种子数据 / 服务纯函数 / setup 工厂），故采用
 * 「全部提升到 ctx」策略（同 m22）：入口 main() 动态 import src + 组装 ctx，
 * section 文件仅 `import type { M17Ctx }`（NodeSpec 类型 / fflate / node builtin 自导入）。
 * 本文件仅类型（字段类型用 `typeof import('..')` 类型查询，零运行时求值，不触碰 env 加载时机）。
 */

export interface M17Ctx {
  check: (cond: boolean, msg: string) => void
  log: import('../../../src/logger').Logger
  // ---- db / 常量 ----
  db: typeof import('../../../src/db').db
  T0: number
  // ---- setup 工厂 / helper（入口 main 定义后注入）----
  mkProject: (name: string) => Promise<number>
  mkAsset: (projectId: number, kind: string, name: string, purpose?: string) => Promise<number>
  mkTask: (projectId: number, opts: { canvasNodeId?: number; status: string; resultAssetId?: number }) => Promise<number>
  mkEntity: (projectId: number | null, name: string, refAssetIds: number[]) => Promise<number>
  mkRun: (projectId: number, templateKey: string, status: string, steps: string[]) => Promise<number>
  docNode: (body: any, id: number) => any
  settleTasks: (ids: number[]) => Promise<Map<number, string>>
  jreq: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>
  sleep: (ms: number) => Promise<void>
  stubFetch: typeof fetch
  // ---- 环境 / 服务纯函数 ----
  env: typeof import('../../../src/env').env
  loadInputPlan: typeof import('../../../src/services/creation').loadInputPlan
  pickDisplayTask: typeof import('../../../src/services/creation').pickDisplayTask
  planNodeInputs: typeof import('../../../src/services/creation').planNodeInputs
  specProblems: typeof import('../../../src/services/creation').specProblems
  chainPortCandidates: typeof import('../../../src/services/creation/ops').chainPortCandidates
  computeArrange: typeof import('../../../src/services/creation/ops').computeArrange
  buildComposeArgs: typeof import('../../../src/services/creation/gen').buildComposeArgs
  extendTaskParams: typeof import('../../../src/services/creation/gen').extendTaskParams
  parseResolution: typeof import('../../../src/services/creation/gen').parseResolution
  absPathOf: typeof import('../../../src/services/storage').absPathOf
  ensureProjectDirs: typeof import('../../../src/services/storage').ensureProjectDirs
  // ---- drizzle 操作符 ----
  eq: (...args: any[]) => any
  inArray: (...args: any[]) => any
  // ---- schema 表 ----
  assets: typeof import('../../../src/db/schema').assets
  canvasEdges: typeof import('../../../src/db/schema').canvasEdges
  canvasNodes: typeof import('../../../src/db/schema').canvasNodes
  characters: typeof import('../../../src/db/schema').characters
  genTasks: typeof import('../../../src/db/schema').genTasks
  pipelineRuns: typeof import('../../../src/db/schema').pipelineRuns
  pipelineSteps: typeof import('../../../src/db/schema').pipelineSteps
  projects: typeof import('../../../src/db/schema').projects
  usageRecords: typeof import('../../../src/db/schema').usageRecords
  // ---- 种子数据（入口 setup 生成后注入）----
  PID: number
  OTHER: number
  A1: number
  A2: number
  A3: number
  AV: number
  AA: number
  AT: number
  A_OTHER: number
  ENT: number
  ENT_EMPTY: number
  ENT_G: number
  ENT_OTHER: number
  RUN1: number
  RUN2: number
  RUN_OTHER: number
}
