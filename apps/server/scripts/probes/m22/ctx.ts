/**
 * M22 探针共享上下文类型（M26·H5b 拆分产物）。
 *
 * 拆分纪律：原 probe-m22.ts 的 11 个 section 闭包所捕获的全部自由标识符集中于此 ctx，
 * 由各节 `run(ctx)` 首行解构后**逐字复用原断言体**（断言文案/顺序/计数零变更）。
 * 本文件仅类型（字段类型用 `typeof import('..')` 类型查询，零运行时求值，不触碰 env 加载时机）。
 */

export interface M22Ctx {
  check: (cond: boolean, msg: string) => void
  // multi-frame 节 SKIP 分支直接用 log.info（非断言路径）
  log: import('../../../src/logger').Logger
  // ---- src 值（入口动态 import 后注入）----
  db: typeof import('../../../src/db').db
  sqlite: typeof import('../../../src/db').sqlite
  eq: (...args: any[]) => any
  assets: typeof import('../../../src/db/schema').assets
  canvasEdges: typeof import('../../../src/db/schema').canvasEdges
  canvasGroups: typeof import('../../../src/db/schema').canvasGroups
  canvasNodes: typeof import('../../../src/db/schema').canvasNodes
  canvases: typeof import('../../../src/db/schema').canvases
  characters: typeof import('../../../src/db/schema').characters
  projects: typeof import('../../../src/db/schema').projects
  // ---- spec / trash / compose / subtitle ----
  COMPOSE_FITS: typeof import('../../../src/services/creation/spec').COMPOSE_FITS
  SUBTITLE_MODES: typeof import('../../../src/services/creation/spec').SUBTITLE_MODES
  parseNodeSpec: typeof import('../../../src/services/creation/spec').parseNodeSpec
  TRASH_DEFAULTS: typeof import('../../../src/services/trash-sweep').TRASH_DEFAULTS
  parseTrashPolicy: typeof import('../../../src/services/trash-sweep').parseTrashPolicy
  resolveTrashPolicy: typeof import('../../../src/services/trash-sweep').resolveTrashPolicy
  selectExpiredCanvases: typeof import('../../../src/services/trash-sweep').selectExpiredCanvases
  buildComposeArgs: typeof import('../../../src/services/creation/gen/compose-args').buildComposeArgs
  escapeSubtitlePath: typeof import('../../../src/services/creation/gen/compose-args').escapeSubtitlePath
  planAlignedSegments: typeof import('../../../src/services/creation/gen/compose-args').planAlignedSegments
  buildSegmentSrt: typeof import('../../../src/services/creation/gen/subtitle').buildSegmentSrt
  parseSrtCues: typeof import('../../../src/services/creation/gen/subtitle').parseSrtCues
  retimeSrtCues: typeof import('../../../src/services/creation/gen/subtitle').retimeSrtCues
  // ---- refs / draft ----
  normalizePositiveIds: typeof import('../../../src/pipeline/refs').normalizePositiveIds
  collectSetRefAssetIds: typeof import('../../../src/pipeline/actions/ai-video').collectSetRefAssetIds
  shotFirstFrameOf: typeof import('../../../src/pipeline/actions/ai-video').shotFirstFrameOf
  collectRefAssetIds: typeof import('../../../src/pipeline/actions/ai-image').collectRefAssetIds
  buildTemplateDraftYaml: typeof import('../../../src/services/creation/draft').buildTemplateDraftYaml
  validateTemplateText: typeof import('../../../src/pipeline/loader').validateTemplateText
  // ---- groups / snapshot / doc / copy / svg / frame / storage / ffmpeg ----
  createGroup: typeof import('../../../src/services/creation/groups').createGroup
  deleteGroup: typeof import('../../../src/services/creation/groups').deleteGroup
  GroupError: typeof import('../../../src/services/creation/groups').GroupError
  updateGroup: typeof import('../../../src/services/creation/groups').updateGroup
  clampDiffValue: typeof import('../../../src/services/creation/snapshot-diff').clampDiffValue
  diffSnapshotDocs: typeof import('../../../src/services/creation/snapshot-diff').diffSnapshotDocs
  branchSnapshot: typeof import('../../../src/services/creation/snapshots').branchSnapshot
  createSnapshot: typeof import('../../../src/services/creation/snapshots').createSnapshot
  restoreSnapshot: typeof import('../../../src/services/creation/snapshots').restoreSnapshot
  buildCanvasDoc: typeof import('../../../src/services/creation/doc').buildCanvasDoc
  copyNodesToCanvas: typeof import('../../../src/services/creation/copy-to').copyNodesToCanvas
  buildCanvasSvg: typeof import('../../../src/services/creation/export-svg').buildCanvasSvg
  computeSvgGroupBoxes: typeof import('../../../src/services/creation/export-svg').computeSvgGroupBoxes
  svgBezier: typeof import('../../../src/services/creation/export-svg').svgBezier
  svgNodeColor: typeof import('../../../src/services/creation/export-svg').svgNodeColor
  truncTitle: typeof import('../../../src/services/creation/export-svg').truncTitle
  xmlEscape: typeof import('../../../src/services/creation/export-svg').xmlEscape
  extractNodeFrame: typeof import('../../../src/services/creation/gen/frame').extractNodeFrame
  frameTimesOf: typeof import('../../../src/services/creation/gen/frame').frameTimesOf
  UNIFORM_FRAME_COUNT_RANGE: typeof import('../../../src/services/creation/gen/frame').UNIFORM_FRAME_COUNT_RANGE
  absPathOf: typeof import('../../../src/services/storage').absPathOf
  ensureProjectDirs: typeof import('../../../src/services/storage').ensureProjectDirs
  registerAsset: typeof import('../../../src/services/storage').registerAsset
  relPathOf: typeof import('../../../src/services/storage').relPathOf
  writeTextAsset: typeof import('../../../src/services/storage').writeTextAsset
  resolveFfmpeg: typeof import('../../../src/services/ffmpeg').resolveFfmpeg
  // ---- 环境/常量（setup 产物）----
  T0: number
  proj: typeof import('../../../src/db/schema').projects.$inferSelect | undefined
}
