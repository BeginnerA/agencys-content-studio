import { api, type Items } from './core'
import type {
  AnyNodeSpec,
  Asset,
  CanvasAdviceResult,
  CanvasArrangeMode,
  CanvasDoc,
  CanvasDocNode,
  CanvasEdgeRow,
  CanvasExportResult,
  CanvasGroup,
  CanvasListItem,
  CanvasNodeRow,
  CanvasOverview,
  CanvasRunBatchResult,
  CanvasSnapshotMeta,
  CanvasViewport,
  CreationNodeSpec,
  PreviewCanvasResult,
  RunCanvas,
  SnapshotDiffResult,
  SnapshotRestoreResult,
  TemplateCanvas,
  TemplateValidation,
} from '../types'

// ===== [M15] 流水线画布（纯读读模型；操作全部复用既有端点） =====

export const canvasApi = {
  /** 运行画布：节点（状态/闸门/任务计数/产物/操作可用性）+ 边（调度依赖 + 数据引用） */
  run: (id: number) => api.get<RunCanvas>(`/api/v1/runs/${id}/canvas`),
  /** 模板画布：设计态编排预览（gate/when 摘要 + 两类边；无运行字段） */
  template: (key: string) => api.get<TemplateCanvas>(`/api/v1/templates/${encodeURIComponent(key)}/canvas`),
  /** [M23] 全景聚合：项目内跨批次（组内 batchSeq 升序）+ 独立 runs + stats */
  overview: (projectId: number) => api.get<CanvasOverview>(`/api/v1/canvas/overview?project_id=${projectId}`),
}

// ===== [M16/M17] 创作画布（写模型：自由摆放 / 引用连线 / 就地生成与编辑 / 批量运维 / 导出） =====

/** 建节点请求（[M17] 5 型；restoreFromNodeId：快照重建时认领已删节点的任务历史——仅 gen 节点由撤销流程传入） */
type RestoreClaim = { restoreFromNodeId?: number }
export type AddNodeBody = RestoreClaim &
  (
    | { kind: 'asset'; assetId: number; x: number; y: number; title?: string }
    | { kind: 'gen'; spec: CreationNodeSpec; x: number; y: number; title?: string }
    | { kind: 'text'; spec: { text: string }; x: number; y: number; title?: string }
    | { kind: 'entity'; entityId: number; x: number; y: number; title?: string }
    | { kind: 'run'; runId: number; x: number; y: number; title?: string }
  )

/** 节点部分更新（单节点 PATCH 与 batch updates[] 同构；spec 按 kind 解析） */
export interface CanvasNodePatch {
  x?: number
  y?: number
  title?: string | null
  spec?: AnyNodeSpec
  seq?: number | null
  adoptedTaskId?: number | null
}

export const creationApi = {
  /** 项目画布列表（含节点数/更新时间；[M18] trash=true 回收站视图） */
  list: (projectId: number, opts?: { trash?: boolean }) =>
    api.get<Items<CanvasListItem>>(`/api/v1/projects/${projectId}/canvases${opts?.trash ? '?trash=1' : ''}`),
  /** 新建画布（空名 → 默认「未命名画布」） */
  create: (projectId: number, name?: string) =>
    api.post<{ canvas: { id: number; name: string; viewport: CanvasViewport } }>(`/api/v1/projects/${projectId}/canvases`, { name }),
  /** 画布全量读模型（节点状态/readiness/editCapability 派生） */
  doc: (id: number) => api.get<CanvasDoc>(`/api/v1/canvases/${id}`),
  /** 改名 / 存视口 */
  update: (id: number, body: { name?: string; viewport?: CanvasViewport }) =>
    api.patch<{ canvas: { id: number; name: string } }>(`/api/v1/canvases/${id}`, body),
  /** [M18] 删除画布 → 移入回收站（在途任务自动取消；可恢复或彻底删除） */
  remove: (id: number) =>
    api.del<{ ok: boolean; mode: 'trashed'; deletedAt: number; cancelled: number }>(`/api/v1/canvases/${id}`),
  /** [M18] 回收站恢复（未在回收站 → 400 bad_state） */
  restore: (id: number) => api.post<{ canvas: { id: number; name: string } }>(`/api/v1/canvases/${id}/restore`),
  /** [M18] 彻底删除（要求先软删；级联清子行；gen_tasks 留痕） */
  purge: (id: number) => api.post<{ ok: boolean }>(`/api/v1/canvases/${id}/purge`),
  /** [M18] 快照列表（元信息新→旧；不含文档全文） */
  snapshots: (id: number) => api.get<Items<CanvasSnapshotMeta>>(`/api/v1/canvases/${id}/snapshots`),
  /** [M18] 创建快照（缺省 label「快照 N」；上限 20 满额 → 400） */
  createSnapshot: (id: number, label?: string) =>
    api.post<{ snapshot: { id: number; label: string; createdAt: number } }>(`/api/v1/canvases/${id}/snapshots`, { label }),
  /** [M18] 保留 id 重放恢复（先自动备份；行 id 被他画布占用 → 409 conflict） */
  restoreSnapshot: (id: number, sid: number) =>
    api.post<SnapshotRestoreResult>(`/api/v1/canvases/${id}/snapshots/${sid}/restore`),
  /** [M18] 删除快照（画布域限定；不存在/不属本画布 → 404） */
  deleteSnapshot: (id: number, sid: number) => api.del<{ ok: boolean }>(`/api/v1/canvases/${id}/snapshots/${sid}`),
  /** [M22] 快照对比：快照 ↔ live/另一快照 字段级差异（against 缺省 live；快照缺失 → 404） */
  snapshotDiff: (id: number, sid: number, against?: string) =>
    api.get<SnapshotDiffResult>(`/api/v1/canvases/${id}/snapshots/${sid}/diff?against=${encodeURIComponent(against ?? 'live')}`),
  /** [M22] 从快照分支为新画布（新 id 重放；name 缺省「{源名} 分支」）→ 新画布 */
  branchSnapshot: (id: number, sid: number, name?: string) =>
    api.post<{ canvas: { id: number; name: string } }>(`/api/v1/canvases/${id}/snapshots/${sid}/branch`, { name }),
  /** 建节点（asset：项目域资产校验；gen/text：spec 合法校验；entity/run：归属校验）→ DB 行
   *  （restoreFromNodeId：撤销重建认领已删节点任务历史时响应附 claimed 计数） */
  addNode: (canvasId: number, body: AddNodeBody) =>
    api.post<{ node: CanvasNodeRow; claimed?: number }>(`/api/v1/canvases/${canvasId}/nodes`, body),
  /** 更新节点（拖拽落点 / 标题 / spec / 序号 / 采纳）→ DB 行 */
  updateNode: (id: number, patch: CanvasNodePatch) =>
    api.patch<{ node: CanvasNodeRow }>(`/api/v1/nodes/${id}`, patch),
  removeNode: (id: number) => api.del<{ ok: boolean }>(`/api/v1/nodes/${id}`),
  /** [M17] 批量部分更新（预校验全量合法才写；spec 校验失败零写入） */
  batchNodes: (canvasId: number, updates: Array<CanvasNodePatch & { id: number }>) =>
    api.post<{ ok: boolean; updated: number }>(`/api/v1/canvases/${canvasId}/nodes/batch`, { updates }),
  /** [M17] 批量删除（级联其全部连线）→ 删除计数 */
  deleteNodes: (canvasId: number, ids: number[]) =>
    api.post<{ deleted: number; edges: number }>(`/api/v1/canvases/${canvasId}/nodes/delete`, { ids }),
  /** [M17] 批量复制（深拷；集合内部边重映射）→ 新 DB 行 */
  copyNodes: (canvasId: number, ids: number[], offset?: { x?: number; y?: number }) =>
    api.post<{ nodes: CanvasNodeRow[]; edges: CanvasEdgeRow[] }>(`/api/v1/canvases/${canvasId}/nodes/copy`, { ids, offset }),
  /** [M22] 跨画布复制（同项目直接引用 / 跨项目资产级联拷贝）→ 新建行 + 跳过/警告报告 */
  copyTo: (canvasId: number, body: { targetCanvasId: number; ids: number[]; offset?: { x?: number; y?: number } }) =>
    api.post<{
      nodes: CanvasNodeRow[]
      edges: CanvasEdgeRow[]
      skipped: Array<{ nodeId: number; reason: string }>
      assetsCopied: number
      warnings: string[]
    }>(`/api/v1/canvases/${canvasId}/nodes/copy-to`, body),
  /** [M17] 规则式串联（按给定顺序相邻连接；端口按产物类型决策，失败项入 skipped） */
  chainNodes: (canvasId: number, ids: number[]) =>
    api.post<{ created: CanvasEdgeRow[]; skipped: Array<{ from: number; to: number; reason: string }> }>(
      `/api/v1/canvases/${canvasId}/nodes/chain`,
      { ids },
    ),
  /** [M17] 整理/对齐/分布（sortBy:'seq' 时 seq 优先；落库并返回新落点） */
  arrange: (canvasId: number, body: { mode: CanvasArrangeMode; nodeIds?: number[]; sortBy?: 'seq' }) =>
    api.post<{ updated: number; positions: Array<{ id: number; x: number; y: number }> }>(
      `/api/v1/canvases/${canvasId}/arrange`,
      body,
    ),
  /** 建边（端口矩阵 + 环检测；非法 → 400 附原因） */
  addEdge: (canvasId: number, body: { from: number; to: number; port: string }) =>
    api.post<{ edge: { id: number } }>(`/api/v1/canvases/${canvasId}/edges`, body),
  removeEdge: (id: number) => api.del<{ ok: boolean }>(`/api/v1/edges/${id}`),
  /** 执行 gen 节点（readiness 不过 → 400 附 problems；[M17] variants 1-4，缺省 ×1） */
  run: (nodeId: number, variants?: number) =>
    api.post<{ ok: boolean; taskId: number; taskIds: number[] }>(
      `/api/v1/nodes/${nodeId}/run`,
      variants === undefined ? undefined : { variants },
    ),
  /** [M17] 批量执行（缺省全画布；只入队就绪节点，不级联等待） */
  runBatch: (canvasId: number, body?: { nodeIds?: number[]; variants?: number }) =>
    api.post<CanvasRunBatchResult>(`/api/v1/canvases/${canvasId}/run`, body),
  /** [M18] 执行成本预估（零副作用；nodeIds 缺省 = 全部 gen 节点） */
  runPreview: (canvasId: number, nodeIds?: number[]) =>
    api.post<PreviewCanvasResult>(`/api/v1/canvases/${canvasId}/run-preview`, { nodeIds }),
  /** [M18] 一键停止全部（画的 pending/processing 任务 → cancelled） */
  cancelTasks: (canvasId: number) =>
    api.post<{ cancelled: number }>(`/api/v1/canvases/${canvasId}/tasks/cancel`),
  /** [M17] 提取文本节点（gen: spec.prompt；asset: 文本资产全文；缺省位置 = 源节点右侧偏移） */
  extractText: (nodeId: number, body?: { x?: number; y?: number }) =>
    api.post<{ node: CanvasNodeRow }>(`/api/v1/nodes/${nodeId}/extract`, body),
  /** [M18/M22·⑨] 视频抽帧（gen(video) 显示产物 / asset 视频资产 → 新建 asset 节点；缺省位置 = 源节点右下偏移）
   *  [M22] mode='uniform' + count 2–9：均匀多帧 → 响应追加 nodes/assets（node/asset = 首帧兼容） */
  extractFrame: (
    nodeId: number,
    body?: { mode?: 'first' | 'last' | 'custom' | 'uniform'; time?: number; count?: number; x?: number; y?: number },
  ) =>
    api.post<{ node: CanvasNodeRow; asset: Asset; nodes?: CanvasNodeRow[]; assets?: Asset[] }>(
      `/api/v1/nodes/${nodeId}/extract-frame`,
      body,
    ),
  /** [M17] AI 扩写（内容源 = text.text / gen.prompt；不落库；未配置 LLM → 400 引导 Settings） */
  promptExpand: (nodeId: number, instruction?: string) =>
    api.post<{ prompt: string; provider: string; model: string }>(`/api/v1/nodes/${nodeId}/prompt-expand`, { instruction }),
  /** [M17] 打包导出 zip（→ archive 资产；下载复用 GET /assets/:id/file?download=1） */
  exportZip: (canvasId: number, nodeIds?: number[]) =>
    api.post<CanvasExportResult>(`/api/v1/canvases/${canvasId}/export`, { nodeIds }),
  /** [M22] 布局图导出（SVG 落资产库；svg 文本供前端光栅化 PNG） */
  exportImage: (canvasId: number, format: 'svg' = 'svg') =>
    api.post<{ assetId: number; svg: string }>(`/api/v1/canvases/${canvasId}/export-image`, { format }),
  /** 复制画布（节点 id 映射重建边） */
  duplicate: (id: number, name?: string) =>
    api.post<{ canvas: { id: number; name: string } }>(`/api/v1/canvases/${id}/duplicate`, { name }),
  /** [M18] 模板草案 v2：yaml + validation + lossy 清单 */
  templateDraft: (id: number, key?: string) =>
    api.post<{ yaml: string; validation: TemplateValidation; lossy: string[] }>(`/api/v1/canvases/${id}/template-draft`, { key }),
  /** [M18] 模板一键试跑：建 queued run（子图闭包 + inputs 预填 + key 冲突自动后缀） */
  templateTry: (id: number, body?: { nodeIds?: number[]; key?: string }) =>
    api.post<{ templateKey: string; runId: number; lossy: string[]; input: Record<string, unknown> }>(
      `/api/v1/canvases/${id}/template-try`,
      body ?? {},
    ),
  /** [M23] LLM 建议式编排（显式单次触发；未配置 → 400 llm_unavailable；仅建议不执行） */
  advice: (id: number) => api.post<CanvasAdviceResult>(`/api/v1/canvases/${id}/advice`),
  /** 联动：画布产物并集挂接实体参考图 */
  attachRefAssets: (entityId: number, assetIds: number[]) =>
    api.post<{ ok: boolean; added: number }>(`/api/v1/entities/${entityId}/ref-assets`, { asset_ids: assetIds }),
  /** [M18/M22] 成组（nodeIds/groupIds 至少一非空；groupIds 须顶层组；parentId 装入新组；违规 400）*/
  createGroup: (
    canvasId: number,
    body: { nodeIds?: number[]; groupIds?: number[]; parentId?: number | null; title?: string; color?: string | null },
  ) =>
    api.post<{ group: CanvasGroup }>(`/api/v1/canvases/${canvasId}/groups`, body),
  /** [M18/M22] 改组（title/color/collapsed/x/y/parentId 局部；parentId=null 提升顶层）*/
  updateGroup: (
    canvasId: number,
    gid: number,
    patch: { title?: string; color?: string | null; collapsed?: boolean; x?: number; y?: number; parentId?: number | null },
  ) => api.patch<{ group: CanvasGroup }>(`/api/v1/canvases/${canvasId}/groups/${gid}`, patch),
  /** [M18] 解组（成员归属清空 + 组行删除）*/
  deleteGroup: (canvasId: number, gid: number) =>
    api.del<{ ok: boolean }>(`/api/v1/canvases/${canvasId}/groups/${gid}`),
}

/** [M16] 蒙版资产视图（EditBrushModal 上传回填） */
export type { CanvasDocNode }
