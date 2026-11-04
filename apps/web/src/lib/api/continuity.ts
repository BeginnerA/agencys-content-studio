// 连续性 API：与 routes/continuity.ts 十条端点一一对应。类型见 lib/types/continuity.ts。
// extract 是唯一付费端点（幂等键回放不再计费），走 LONG_TIMEOUT_MS；
// 其余为免费端点。错误统一抛 ApiError{code,message}。
import { api, LONG_TIMEOUT_MS } from './core'
import type {
  Acceptance,
  Approval,
  ConfirmRequest,
  ContinuityImpactView,
  ContinuitySource,
  ContinuityUnit,
  DocRef,
  EntryView,
  ExtractPreview,
  ExtractRequestBody,
  PatchRequestBody,
  Preview,
  ReviewRequestBody,
  SnapshotRequestBody,
  SourceCandidate,
  SourcePick,
  TargetRequest,
} from '../types/continuity'

const V = '/api/v1'

export interface FreezeRequestBody extends Record<string, unknown> {
  kind: TargetRequest['kind']
  includePlans: boolean
  previewHash: string
  acceptedGaps: Acceptance[]
  operationKey: string
  duplicateCostAcceptance?: { useId: number; accepted: true }
}

/** 目标字段平铺进冻结体（路由端逐 kind 白名单校验，target 键随 kind 展开）。 */
export function flattenTarget(t: TargetRequest): Record<string, unknown> {
  const { kind, ...rest } = t
  return { kind, ...rest }
}

export const continuityApi = {
  /** ① 同项目同集候选来源（可确认面 + 不可确认原因） */
  sources: (projectId: number, episodeId: number) =>
    api.get<{ items: SourceCandidate[] }>(
      `${V}/projects/${projectId}/episodes/${episodeId}/continuity/sources`,
    ),

  /** ② 免费捕获缺失 baseline（精确返回版本，不作批准） */
  snapshot: (projectId: number, episodeId: number, body: SnapshotRequestBody) =>
    api.post<{ source: ContinuitySource & SourcePick }>(
      `${V}/projects/${projectId}/episodes/${episodeId}/continuity/sources/snapshot`,
      body,
    ),

  /** ③ 无参列登记；带完整源参数返回纯读提取预检 */
  list: (projectId: number, episodeId: number) =>
    api.get<{ items: EntryView[] }>(
      `${V}/projects/${projectId}/episodes/${episodeId}/continuity`,
    ),

  extractionPreview: (
    projectId: number,
    episodeId: number,
    pick: SourcePick,
    timeoutMs?: number,
  ) =>
    api.get<{ extractionPreview: ExtractPreview }>(
      `${V}/projects/${projectId}/episodes/${episodeId}/continuity?sourceRunId=${pick.runId}&sourceStepId=${pick.stepId}&sourceAssetId=${pick.assetId}&sourceVersionId=${pick.versionId}`,
      timeoutMs,
    ),

  /** ④ 唯一付费端点：AI 整理（长请求；断连后按同 operationKey 查询，不重复发请求） */
  extract: (projectId: number, episodeId: number, body: ExtractRequestBody) =>
    api.post<{ entry: EntryView }>(
      `${V}/projects/${projectId}/episodes/${episodeId}/continuity/extract`,
      body,
      LONG_TIMEOUT_MS,
    ),

  /** ⑤ 从现存登记克隆零模型复核草稿 */
  review: (projectId: number, episodeId: number, body: ReviewRequestBody) =>
    api.post<{ entry: EntryView }>(
      `${V}/projects/${projectId}/episodes/${episodeId}/continuity/review`,
      body,
    ),

  /** ⑥ 仅草稿结构化编辑（并发 409 → 保留用户编辑并提示重载） */
  patch: (projectId: number, entryId: number, body: PatchRequestBody) =>
    api.patch<{ entry: EntryView }>(
      `${V}/projects/${projectId}/continuity/${entryId}`,
      body,
    ),

  /** ⑥-b 仅草稿可删（confirmed/superseded 受生命周期保护 → 409） */
  remove: (projectId: number, entryId: number) =>
    api.del<{ ok: true }>(`${V}/projects/${projectId}/continuity/${entryId}`),

  /** ⑦ 整集确认 CAS（绑定所见当前头 + warningsHash） */
  confirm: (projectId: number, entryId: number, body: ConfirmRequest) =>
    api.post<{ entry: EntryView }>(
      `${V}/projects/${projectId}/continuity/${entryId}/confirm`,
      body,
    ),

  /** ⑧ 只读目标集预览（POST 仅因需传完整待运行输入） */
  preview: (
    projectId: number,
    body: { target: TargetRequest; includePlans: boolean },
  ) =>
    api.post<{ preview: Preview }>(
      `${V}/projects/${projectId}/continuity/preview`,
      body,
    ),

  /** ⑨ 批准后冻结承接包（幂等，零模型调用） */
  freeze: (projectId: number, body: FreezeRequestBody) =>
    api.post<{ approval: Approval }>(
      `${V}/projects/${projectId}/continuity/contexts`,
      body,
    ),

  /** ⑩ 登记 / 调用证据的下游影响（直接 / 间接 / 缺证三区） */
  impact: (projectId: number, recordId: number) =>
    api.get<ContinuityImpactView>(
      `${V}/projects/${projectId}/continuity/${recordId}/impact`,
    ),
}

/** 冻结体组装：目标字段平铺 + 冻结字段（与 parseFreezeBody 白名单一致）。 */
export function freezeBody(input: {
  target: TargetRequest
  includePlans: boolean
  previewHash: string
  acceptedGaps: Acceptance[]
  operationKey: string
  duplicateCostAcceptance?: { useId: number; accepted: true }
}): FreezeRequestBody {
  return {
    ...flattenTarget(input.target),
    includePlans: input.includePlans,
    previewHash: input.previewHash,
    acceptedGaps: input.acceptedGaps,
    operationKey: input.operationKey,
    ...(input.duplicateCostAcceptance
      ? { duplicateCostAcceptance: input.duplicateCostAcceptance }
      : {}),
  } as FreezeRequestBody
}

export type { ContinuityUnit, DocRef }
