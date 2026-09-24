/**
 * 创作画布文档层（写模型）：
 * - buildCanvasDoc：画布全量读模型——节点状态/结果零存量，由 gen_tasks（canvasNodeId）派生； 全型节点
 *   （asset|gen|text|entity|run）与端口矩阵 v3（ +text 端口 / +llm 目标 + entity 源）、采纳优先（pickDisplayTask）、
 *   结果画廊（results）、run 节点运行摘要；
 * - CRUD + 端口规则矩阵校验（含环检测 + from 侧类型校验）；duplicate 深拷；buildTemplateDraft 低保真草案导出；
 * - extractTextNode：从 gen（spec.prompt）或文本资产提取文本节点；
 * - 回收站（软删/恢复/purge，findCanvas 为统一过滤点）+ 文档快照（保留 id 重放；恢复前自动备份）；
 * - 执行通道见 services/creation-gen.ts（本文件零网络、零适配器调用）。
 * 宽容降级：坏 spec / 上游缺产物 / 实体超限截断 → readiness problems/notes 列出（不炸）。
 */

// 公共面重导出：拆分后导出面冻结（与拆分前 services/creation.ts 完全一致）。

export {
  COMPOSE_CAP,
  EDGE_PORTS,
  EDIT_MODES,
  GEN_KINDS,
  LLM_TEXT_CAP,
  NODE_KINDS,
  REF_CAP,
  isGenSpec,
  parseEntitySpec,
  parseNodeSpec,
  parseRunSpec,
  parseTextSpec,
  parseViewport,
  safeParseEntitySpec,
  safeParseRunSpec,
  safeParseSpec,
  safeParseTextSpec,
  specProblems,
} from './spec'
export type {
  AnyNodeSpec,
  AssetLite,
  CanvasDoc,
  CanvasDocEdgeView,
  CanvasDocGroup,
  CanvasDocNode,
  CanvasEntityInfo,
  CanvasListItem,
  CanvasResultItem,
  CanvasRunInfo,
  EdgePort,
  EditCapability,
  EditMode,
  EntitySpec,
  GenKind,
  GenTaskLite,
  InputPlan,
  NodeKind,
  NodeSpec,
  NodeSpecEdit,
  RunSpec,
  TextSpec,
  UpstreamInfo,
  Viewport,
} from './spec'

export { editCapabilityOf, productKindOf, sourceKindOf, validateNewEdge, wouldCreateCycle } from './ports'
export type { FromNodeInfo } from './ports'

export { loadInputPlan, pickDisplayTask, planNodeInputs } from './inputs'

export {
  createCanvas,
  duplicateCanvas,
  findCanvas,
  listCanvases,
  purgeCanvas,
  restoreCanvas,
  softDeleteCanvas,
  updateCanvas,
} from './canvas'

export {
  SNAPSHOT_LIMIT,
  SnapshotConflictError,
  branchSnapshot,
  collectSnapshotDoc,
  createSnapshot,
  deleteSnapshot,
  diffSnapshotAgainst,
  listSnapshots,
  restoreSnapshot,
} from './snapshots'
export type { CanvasSnapshotDoc, CanvasSnapshotMeta, SnapshotDiffResult, SnapshotRestoreResult } from './snapshots'

export {
  addAssetNode,
  addEntityNode,
  addGenNode,
  addRunNode,
  addTextNode,
  assertRestorableSource,
  canvasOfNode,
  claimNodeTasks,
  deleteNode,
  findNode,
  updateNode,
  validateNodePatch,
} from './nodes'
export type { NodePatch } from './nodes'

export { addEdge, deleteEdge } from './edges'

// 跨画布复制（同项目直接引用 / 跨项目资产级联拷贝）
export { copyNodesToCanvas } from './copy-to'
export type { CopyToResult, CopyToSkip } from './copy-to'

export { buildCanvasDoc } from './doc'

export { TemplateTryError, buildTemplateDraft, buildTemplateDraftYaml, topoSortGenNodeIds, tryRunTemplate } from './draft'
export type { TemplateDraftResult, TemplateTryResult } from './draft'

export { extractTextNode } from './extract'

