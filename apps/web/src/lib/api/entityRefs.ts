/**
 * 实体参考图分层登记 + 图像模型参考图能力的前端 API 客户端。
 *
 * 契约严格对齐服务端 entity-references 路由实际返回（不按猜测形态适配）：
 *  - GET 快照 = { refs, entity: { id, name, states, refAssetIds } }，refs 行的 enabled 是布尔；
 *  - 逐镜取用预览 = { selected: [{assetId, role, reason}], fallbacks: [string], dropped: [{assetId, role, reason}] }；
 *  - 能力 = { supportsRefs, maxRefs, supportsNegativePrompt, notes[] }，provider/model 缺省 = 解析当前默认出图配置。
 * 错误体统一 { error: { code, message } }，core 的 request 封装会抛 ApiError 且 message 为服务端原文——
 * 面板直接呈现该原文（含 bad_role / bad_asset_id / conflict 等错误码对应的说明），不做通用化替换。
 */
import { api } from './core'

/** 分层角色：base=基准定妆 / state=状态变体 / view=多视角补充（与服务端 REF_ROLES 同词表） */
export type EntityRefRole = 'base' | 'state' | 'view'

/** 分层登记行视图（enabled 已归一为布尔） */
export interface EntityRefView {
  id: number
  entityId: number
  assetId: number
  role: EntityRefRole
  stateKey: string | null
  viewKey: string | null
  enabled: boolean
  note: string | null
  createdAt: number
}

/** 实体宿主快照：states 供状态下拉，refAssetIds 供「是否存在未分层历史扁平参考」判定 */
export interface EntityRefHostView {
  id: number
  name: string
  states: string[]
  refAssetIds: number[]
}

/** GET /entities/:id/references 响应体 */
export interface EntityRefsSnapshot {
  refs: EntityRefView[]
  entity: EntityRefHostView
}

/** 预览入选/裁剪条目（reason 为服务端逐字留痕，UI 原文展示） */
export interface SelectedRefView {
  assetId: number
  role: EntityRefRole
  reason: string
}

/** GET /entities/:id/selection-preview 响应体 */
export interface SelectionPreview {
  selected: SelectedRefView[]
  fallbacks: string[]
  dropped: SelectedRefView[]
}

/** 图像模型参考图能力（GET /image-caps）；notes 含能力解析失败留痕原文 */
export interface ImageCaps {
  supportsRefs: boolean
  maxRefs: number
  supportsNegativePrompt: boolean
  notes: string[]
}

export interface AddEntityRefBody {
  assetId: number
  role: EntityRefRole
  stateKey?: string | null
  viewKey?: string | null
  note?: string | null
}

/** 局部更新补丁：未出现的键保持原值；显式 null 表示清空该列 */
export interface PatchEntityRefBody {
  enabled?: boolean
  role?: EntityRefRole
  stateKey?: string | null
  viewKey?: string | null
  note?: string | null
}

export const entityRefsApi = {
  /** 分层清单（含停用行）+ 实体快照 */
  list: (entityId: number) =>
    api.get<EntityRefsSnapshot>(`/api/v1/entities/${entityId}/references`),
  /** 新增登记（201 返回该行；同实体同资产重复 409；服务端会顺带回填该实体未登记的历史扁平参考） */
  add: (entityId: number, body: AddEntityRefBody) =>
    api.post<EntityRefView>(`/api/v1/entities/${entityId}/references`, body),
  patch: (refId: number, body: PatchEntityRefBody) =>
    api.patch<EntityRefView>(`/api/v1/entity-references/${refId}`, body),
  remove: (refId: number) =>
    api.del<{ ok: boolean }>(`/api/v1/entity-references/${refId}`),
  /** 历史扁平参考固化为基准分层行（幂等，重复调用无新增） */
  backfill: (entityId: number) =>
    api.post<{ added: number }>(
      `/api/v1/entities/${entityId}/references/backfill`,
    ),
  /** 逐镜取用预览（纯读；scene/episode 非整数时服务端 400 bad_scene / bad_episode） */
  preview: (
    entityId: number,
    q: { scene?: number; episode?: number; text?: string },
  ) => {
    const params = new URLSearchParams()
    if (q.scene !== undefined) params.set('scene', String(q.scene))
    if (q.episode !== undefined) params.set('episode', String(q.episode))
    if (q.text) params.set('text', q.text)
    const qs = params.toString()
    return api.get<SelectionPreview>(
      `/api/v1/entities/${entityId}/selection-preview${qs ? `?${qs}` : ''}`,
    )
  },
}

export const imageCapsApi = {
  /** provider/model 缺省 → 服务端按当前默认图像配置解析；无可用配置时保守返回 supportsRefs=false 且 notes 记失败原因 */
  get: (provider?: string, model?: string) => {
    const params = new URLSearchParams()
    if (provider) params.set('provider', provider)
    if (model) params.set('model', model)
    const qs = params.toString()
    return api.get<ImageCaps>(`/api/v1/image-caps${qs ? `?${qs}` : ''}`)
  },
}
