/**
 * M16 探针共享上下文类型（M26·H5b 拆分产物）。
 *
 * 拆分纪律：原 probe-m16.ts 的 6 个 section 闭包所捕获的全部自由标识符集中于此 ctx，
 * 由各节 `run(ctx)` 首行解构后**逐字复用原断言体**（断言文案/顺序/计数零变更）。
 * 本文件仅类型（字段类型用 `import('..')` 类型查询，零运行时求值，不触碰 env 加载时机）。
 */

export interface M16Ctx {
  check: (cond: boolean, msg: string) => void
  // ---- src 值（入口动态 import 后注入）----
  db: typeof import('../../../src/db').db
  canvasEdges: typeof import('../../../src/db/schema').canvasEdges
  canvasNodes: typeof import('../../../src/db/schema').canvasNodes
  characters: typeof import('../../../src/db/schema').characters
  genTasks: typeof import('../../../src/db/schema').genTasks
  and: (...args: any[]) => any
  count: (...args: any[]) => any
  eq: (...args: any[]) => any
  isNull: (...args: any[]) => any
  // ---- 服务纯函数 ----
  appendStyleSnippet: typeof import('../../../src/services/creation/gen').appendStyleSnippet
  buildEditParams: typeof import('../../../src/services/creation/gen').buildEditParams
  buildNodeTaskParams: typeof import('../../../src/services/creation/gen').buildNodeTaskParams
  recoverCanvasTasks: typeof import('../../../src/services/creation/gen').recoverCanvasTasks
  editCapabilityOf: typeof import('../../../src/services/creation').editCapabilityOf
  parseViewport: typeof import('../../../src/services/creation').parseViewport
  planNodeInputs: typeof import('../../../src/services/creation').planNodeInputs
  safeParseSpec: typeof import('../../../src/services/creation').safeParseSpec
  specProblems: typeof import('../../../src/services/creation').specProblems
  topoSortGenNodeIds: typeof import('../../../src/services/creation').topoSortGenNodeIds
  wouldCreateCycle: typeof import('../../../src/services/creation').wouldCreateCycle
  buildTemplateDraftYaml: typeof import('../../../src/services/creation').buildTemplateDraftYaml
  validateTemplateText: typeof import('../../../src/pipeline/loader').validateTemplateText
  loadTemplate: typeof import('../../../src/pipeline/loader').loadTemplate
  // ---- 环境/常量 ----
  REPO_ROOT: string
  T0: number
  PID: number
  OTHER: number
  A1: number
  A2: number
  A_OTHER: number
  // ---- 通用 helper ----
  sleep: (ms: number) => Promise<void>
  jsonRes: (body: unknown) => Response
  stubFetch: typeof fetch
  jreq: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>
  docNode: (body: any, id: number) => any
  edgeCount: (canvasId: number) => Promise<number>
  mkAsset: (projectId: number, kind: string, name: string, purpose?: string) => Promise<number>
  mkTask: (
    projectId: number,
    opts: { canvasNodeId?: number; runId?: number; stepId?: number; status: string; resultAssetId?: number },
  ) => Promise<number>
}
