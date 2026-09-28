/**
 * lib/api 统一出口（拆分：api.ts → api/ 按域拆分，导入面零改动）。
 * 各域实现见同级 core/projects/runs/assets/config/canvas/insights.ts；本文件仅 re-export，
 * 冻结拆分前 api.ts 的公开签名（值经 `export {}`、纯类型经 `export type {}`）。
 */
export { ApiError, api } from './core'

export {
  projectApi,
  templateApi,
  promptApi,
  batchApi,
  seriesApi,
} from './projects'

export { runApi, taskApi, stepApi, composeApi, shotApi, novelApi } from './runs'

export {
  assetApi,
  searchApi,
  memoryApi,
  entityApi,
  uploadEntityRefImage,
  globalAssetApi,
  stylePresetApi,
  uploadFiles,
} from './assets'

export { configApi, vendorApi, brandAssetApi, voiceCloneApi } from './config'

export { canvasApi, creationApi } from './canvas'
export type { AddNodeBody, CanvasNodePatch } from './canvas'
export type { CanvasDocNode } from '../types'

// 对话式「一句话成片」
export { creationChatApi, newRequestKey } from './creation-chat'

export {
  statsApi,
  exportApi,
  editExchangeApi,
  publicationApi,
  settingsApi,
  scheduleApi,
  complianceApi,
  budgetApi,
} from './insights'
export type { EditExchangeFormat, EditExchangeFormatsResult } from './insights'

export { workflowApi } from './workflows'
export type { WorkflowCreateBody, WorkflowPatchBody } from './workflows'

export { assetVersionApi, entityVersionApi, canvasLockApi } from './versions'

export { subtitleReworkApi, ReworkApiError } from './rework'
export { qcApi } from './qc'
