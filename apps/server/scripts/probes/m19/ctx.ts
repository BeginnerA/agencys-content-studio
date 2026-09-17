/**
 * M19 探针共享上下文类型（M26·H5b 拆分产物）。
 *
 * 拆分纪律：原 probe-m19.ts 入口 main 作用域的动态导入符号（跨多节共享的 brand-config 全套 +
 * ffmpeg-merge 组装四函数 + storage/env + schema 表 + drizzle 操作符）与 setup 产物
 * （mkProject/pid/mkArgsInput/errOf/T0）集中于此 ctx，由各节 `run(ctx)` 首行解构后逐字复用原断言体。
 * 与各节内部保留的 `await import('..src..')` 服务纯函数动态导入（m18 式）互补：单节使用的服务符号
 * 仍留在各节 inline，仅路径改写 `../src` → `../../../src`。
 * 本文件仅类型（字段类型用 `typeof import('..')` 类型查询，零运行时求值，不触碰 env 加载时机）。
 */

export type ComposeArgsInput = Parameters<typeof import('../../../src/pipeline/actions/ffmpeg-merge').buildComposeArgs>[0]

export interface M19Ctx {
  check: (cond: boolean, msg: string) => void
  log: import('../../../src/logger').Logger
  // ---- setup 产物 / helper（入口 main 定义后注入）----
  db: typeof import('../../../src/db').db
  T0: number
  pid: number
  mkProject: (name: string, settingsJson?: string) => Promise<number>
  errOf: (fn: () => Promise<unknown>) => Promise<unknown>
  mkArgsInput: (over: Partial<ComposeArgsInput>) => ComposeArgsInput
  // ---- drizzle 操作符 ----
  eq: (...args: any[]) => any
  // ---- brand-config（三层合并/读取/清洗：跨节共享）----
  mergeBrand: typeof import('../../../src/services/brand-config').mergeBrand
  readComposeBrand: typeof import('../../../src/services/brand-config').readComposeBrand
  readPlatformBrand: typeof import('../../../src/services/brand-config').readPlatformBrand
  readProjectBrand: typeof import('../../../src/services/brand-config').readProjectBrand
  resolveBrandConfig: typeof import('../../../src/services/brand-config').resolveBrandConfig
  sanitizeSubtitleStyle: typeof import('../../../src/services/brand-config').sanitizeSubtitleStyle
  sanitizeWatermark: typeof import('../../../src/services/brand-config').sanitizeWatermark
  // ---- ffmpeg-merge 组装（零漂移红线核心）----
  buildComposeArgs: typeof import('../../../src/pipeline/actions/ffmpeg-merge').buildComposeArgs
  watermarkOverlayXY: typeof import('../../../src/pipeline/actions/ffmpeg-merge').watermarkOverlayXY
  countSrtCues: typeof import('../../../src/pipeline/actions/ffmpeg-merge').countSrtCues
  shiftSrtText: typeof import('../../../src/pipeline/actions/ffmpeg-merge').shiftSrtText
  // ---- storage / env ----
  purposeSubDir: typeof import('../../../src/services/storage').purposeSubDir
  BRAND_DIR: string
  // ---- schema 表 ----
  characters: typeof import('../../../src/db/schema').characters
  genTasks: typeof import('../../../src/db/schema').genTasks
  pipelineRuns: typeof import('../../../src/db/schema').pipelineRuns
  projects: typeof import('../../../src/db/schema').projects
  settings: typeof import('../../../src/db/schema').settings
  voiceClones: typeof import('../../../src/db/schema').voiceClones
}
