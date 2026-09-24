/**
 * 镜头级轻工作台服务层（spec §3.1）
 * - 纯 DB 层：只做「校验 + 数据库状态变更」，不调用 engine（startRun 由路由层在服务返回后同步调用）
 * - 错误类型与 HttpError 解耦：路由层转 HTTP（对齐 run-create.ts 惯例）
 * - 三个核心语义：① 分镜 JSON 是唯一事实源 ② 产物即选择（改写 output.asset_ids）③ 状态重置 + 引擎复用
 * 结构性编辑扩展：ops 协议（reorder/add/remove/patch）+ 上传替换（外来图入镜）
 * 引擎级单步重跑（resetStepForRerun：复用/重置子任务）+ 分镜 lines 字段校验（音字对齐映射源）
 * 局部返修批量重置（resetShotsForRework：多镜一次重置，轻松创作内部允许通道，通用工作台路径仍阻断）
 */

export { WorkbenchError, WORKBENCH_ACTIONS } from './helpers'
export type { ShotSpec } from './helpers'
export { shotDurationSec, buildShotBoard, toVersionView } from './board'
export type { BoardVersion, BoardTask, BoardShot, ShotBoard } from './board'
export { applyStoryboardEdits, applyStoryboardOps, reorderShots } from './edits'
export type { ShotEditItem, ShotOp } from './edits'
export { resetShotForRegenerate, applyShotSelection } from './selection'
export type { ShotPick } from './selection'
export { importShotAsset, uploadAndBindShotAsset, bindUploadedShotAsset } from './import'
export { resetStepForRecompose, cleanupShotVersions, resetStepForRerun, describeChainRerun, resetChainForRerun, resetShotsForRework } from './reset'
export type { ChainStepInfo, ChainRerunView, ReworkShotReset, ReworkStepReset } from './reset'
export { assertRepairable, checkRepairable, assertChainRepairable, computeChainKeys, computeUpstreamKeys } from './inspect'
