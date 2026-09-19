// [M29·R02] 版本与追溯 API：对象版本列表 / 版本内容 / 还原 / 下游影响 / 锁定输入。
// 只读 + 显式还原 + 显式锁版；不提供任何自动生成/返修入口（影响仅报告）。
import { api } from './core'
import type {
  ImpactResult,
  InputLockView,
  RestoreAssetResult,
  VersionListResult,
} from '../types/version'

const V = '/api/v1'

/** 文本资产版本 / 内容 / 还原 / 影响 */
export const assetVersionApi = {
  list: (assetId: number) =>
    api.get<VersionListResult>(`${V}/assets/${assetId}/versions`),
  contentText: (assetId: number, versionId: number) =>
    api.get<{ content: string }>(
      `${V}/assets/${assetId}/versions/${versionId}/content`,
    ),
  restore: (assetId: number, versionId: number) =>
    api.post<RestoreAssetResult>(
      `${V}/assets/${assetId}/versions/${versionId}/restore`,
    ),
  impact: (assetId: number) =>
    api.get<ImpactResult>(`${V}/assets/${assetId}/impact`),
}

/** 实体档案版本 / 快照 / 还原 / 影响 */
export const entityVersionApi = {
  list: (entityId: number) =>
    api.get<VersionListResult>(`${V}/entities/${entityId}/versions`),
  contentDoc: (entityId: number, versionId: number) =>
    api.get<{ doc: Record<string, unknown> }>(
      `${V}/entities/${entityId}/versions/${versionId}/content`,
    ),
  restore: (entityId: number, versionId: number) =>
    api.post<{ ok: boolean; revision: number }>(
      `${V}/entities/${entityId}/versions/${versionId}/restore`,
    ),
  impact: (entityId: number) =>
    api.get<ImpactResult>(`${V}/entities/${entityId}/impact`),
}

/** 画布生成节点：锁定 / 解锁下次执行输入（三操作分离之锁版，不影响选片与内容版本） */
export const canvasLockApi = {
  list: (nodeId: number) =>
    api.get<{ items: InputLockView[] }>(
      `${V}/canvas/nodes/${nodeId}/input-locks`,
    ),
  lock: (nodeId: number, upstreamNodeId: number, assetId: number) =>
    api.post<{ items: InputLockView[] }>(
      `${V}/canvas/nodes/${nodeId}/input-lock`,
      { upstreamNodeId, assetId },
    ),
  unlock: (nodeId: number, upstreamNodeId: number) =>
    api.del<{ items: InputLockView[] }>(
      `${V}/canvas/nodes/${nodeId}/input-lock`,
      { upstreamNodeId },
    ),
}
