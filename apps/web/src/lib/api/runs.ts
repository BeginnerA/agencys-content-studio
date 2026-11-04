import { ApiError, api, LONG_TIMEOUT_MS, type Items } from './core'
import type {
  ApiErrorBody,
  AspectStrategy,
  AspectValue,
  Asset,
  ChainRerunPreview,
  ChainRerunResult,
  CleanupResult,
  ComposeConfig,
  ComposeSfxItem,
  DeriveAspectResult,
  GenTask,
  NovelBoardData,
  ParamChange,
  RerunResult,
  RevisionItem,
  Run,
  RunDetail,
  ShotBoardData,
  ShotEditItem,
  ShotOp,
  ShotPick,
} from '../types'
import type { Approval } from '../types/continuity'

/** 启动 run 请求体（可选承接批准句柄；启用 with_continuity 时必传） */
export interface RunStartBody {
  template_key: string
  input: Record<string, unknown>
  continuity_approval?: Approval
}

/** 断点续跑请求体：批准句柄 + 未知费用精确同意三要素 */
export interface RunResumeBody extends Record<string, unknown> {
  continuity_approval?: Approval
  unknown_use_id?: number
  accept_possible_duplicate_cost?: true
}

export const runApi = {
  /** 运行列表（?project_id=&status=；全局待审阅聚合用 status=waiting_input） */
  list: (params = '') => api.get<Items<Run>>(`/api/v1/runs${params}`),
  detail: (id: number) => api.get<RunDetail>(`/api/v1/runs/${id}`),
  log: (id: number, tail = 200) =>
    api.get<{ log: string }>(`/api/v1/runs/${id}/log?tail=${tail}`),
  start: (projectId: number, body: RunStartBody) =>
    api.post<{ run: Run }>(`/api/v1/projects/${projectId}/runs`, body),
  /**
   * 闸门决策（approve|reject|skip）。服务端与 cancel/resume 同构，只回 `{run}`（无 steps）——
   * 决策后步骤/会话反查等完整视图由调用方 `runApi.detail()` 重载，勿把返回值当 RunDetail 用。
   */
  gate: (id: number, body: Record<string, unknown>) =>
    api.post<{ run: Run }>(`/api/v1/runs/${id}/gate`, body),
  cancel: (id: number) => api.post<{ run: Run }>(`/api/v1/runs/${id}/cancel`),
  /** 删除运行记录（仅终态；产物资产与成本记录保留，级联删步骤/子任务） */
  remove: (id: number) =>
    api.del<{ ok: boolean; runs: number; steps: number; tasks: number }>(
      `/api/v1/runs/${id}`,
    ),
  resume: (id: number, body?: RunResumeBody) =>
    api.post<{ run: Run }>(`/api/v1/runs/${id}/resume`, body ?? {}),
  /** 步骤文本产物版本链（倒序；current = step.output.asset_ids[0]） */
  revisions: (id: number, stepKey: string) =>
    api.get<{ items: RevisionItem[] }>(
      `/api/v1/runs/${id}/steps/${encodeURIComponent(stepKey)}/revisions`,
    ),
  /** 集级参数热调（受限：queued/running/waiting_input；组内深合并 + 留痕） */
  updateParams: (id: number, params: Record<string, Record<string, unknown>>) =>
    api.patch<{ run: Run; applied: ParamChange[] }>(
      `/api/v1/runs/${id}/params`,
      { params },
    ),
}

export const taskApi = {
  list: (params = '') => api.get<Items<GenTask>>(`/api/v1/tasks${params}`),
  retry: (id: number, body?: Record<string, unknown>) =>
    api.post<{ task: GenTask }>(`/api/v1/tasks/${id}/retry`, body ?? {}),
  cancel: (id: number) =>
    api.post<{ task: GenTask }>(`/api/v1/tasks/${id}/cancel`),
}

// ===== 单步重跑 / 合成设置（BGM·转场） =====

export const stepApi = {
  /** 引擎级单步重跑（复用成功子任务；reset_tasks=true 全量重跑；succeeded 下游步骤照常跳过） */
  rerun: (
    runId: number,
    stepKey: string,
    opts: { reset_tasks?: boolean } = {},
  ) =>
    api.post<RerunResult>(
      `/api/v1/runs/${runId}/steps/${encodeURIComponent(stepKey)}/rerun`,
      opts,
    ),
  /** 级联重跑预览（只读：从该步到末尾的级联步骤清单 + 预估计费子任务数；?reset_tasks=1 影响目标步口径） */
  describeCascade: (
    runId: number,
    stepKey: string,
    opts: { reset_tasks?: boolean } = {},
  ) =>
    api.get<ChainRerunPreview>(
      `/api/v1/runs/${runId}/steps/${encodeURIComponent(stepKey)}/rerun-cascade${opts.reset_tasks ? '?reset_tasks=1' : ''}`,
    ),
  /** 级联重跑执行（从该步起重跑到末尾：目标步尊重 reset_tasks，下游一律全量重置） */
  rerunCascade: (
    runId: number,
    stepKey: string,
    opts: { reset_tasks?: boolean } = {},
  ) =>
    api.post<ChainRerunResult>(
      `/api/v1/runs/${runId}/steps/${encodeURIComponent(stepKey)}/rerun-cascade`,
      opts,
    ),
}

export const composeApi = {
  /** 合成配置回显（config 空对象 = 未设置，前端用默认值展示） */
  getConfig: (runId: number) =>
    api.get<{ config: ComposeConfig }>(`/api/v1/runs/${runId}/compose/config`),
  /** 更新（transition/duration/bgm_volume/bgm_fade；白名单+枚举+clamp） */
  updateConfig: (runId: number, patch: ComposeConfig) =>
    api.put<{ ok: boolean; config: ComposeConfig; note: string }>(
      `/api/v1/runs/${runId}/compose/config`,
      patch,
    ),
  /** 当前 BGM（null = 未绑定） */
  getBgm: (runId: number) =>
    api.get<{ bgm: Asset | null }>(`/api/v1/runs/${runId}/compose/bgm`),
  /** 绑定项目音频资产（复制行；不污染源资产） */
  bindBgm: (runId: number, assetId: number) =>
    api.post<{ ok: boolean; bgm: Asset; note: string }>(
      `/api/v1/runs/${runId}/compose/bgm`,
      { asset_id: assetId },
    ),
  /** 上传音频绑定（multipart：file） */
  uploadBgm: async (runId: number, file: File) => {
    const form = new FormData()
    form.append('file', file, file.name)
    let res: Response
    try {
      res = await fetch(`/api/v1/runs/${runId}/compose/bgm`, {
        method: 'POST',
        body: form,
      })
    } catch {
      throw new ApiError(0, 'network', '无法连接服务（127.0.0.1:3001）')
    }
    if (!res.ok) {
      let code = 'http_' + res.status
      let message = `HTTP ${res.status}`
      try {
        const data = (await res.json()) as ApiErrorBody
        if (data?.error?.message) {
          code = data.error.code
          message = data.error.message
        }
      } catch {
        // 非 JSON 错误体，保留默认
      }
      throw new ApiError(res.status, code, message)
    }
    return (await res.json()) as { ok: boolean; bgm: Asset; note: string }
  },
  /** 移除 BGM（软删本 run 有效行） */
  removeBgm: (runId: number) =>
    api.del<{ ok: boolean; note: string }>(`/api/v1/runs/${runId}/compose/bgm`),
  /** SFX 列表（shotId → 资产；每镜 ≤1 条有效） */
  listSfx: (runId: number) =>
    api.get<{ items: ComposeSfxItem[] }>(`/api/v1/runs/${runId}/compose/sfx`),
  /** 绑定项目音频资产到指定镜头（复制行；不污染源资产） */
  bindSfx: (runId: number, shotId: string, assetId: number) =>
    api.post<{ ok: boolean; item: ComposeSfxItem; note: string }>(
      `/api/v1/runs/${runId}/compose/sfx`,
      {
        shot_id: shotId,
        asset_id: assetId,
      },
    ),
  /** 上传音频绑定到指定镜头（multipart：shot_id + file） */
  uploadSfx: async (runId: number, shotId: string, file: File) => {
    const form = new FormData()
    form.append('shot_id', shotId)
    form.append('file', file, file.name)
    let res: Response
    try {
      res = await fetch(`/api/v1/runs/${runId}/compose/sfx`, {
        method: 'POST',
        body: form,
      })
    } catch {
      throw new ApiError(0, 'network', '无法连接服务（127.0.0.1:3001）')
    }
    if (!res.ok) {
      let code = 'http_' + res.status
      let message = `HTTP ${res.status}`
      try {
        const data = (await res.json()) as ApiErrorBody
        if (data?.error?.message) {
          code = data.error.code
          message = data.error.message
        }
      } catch {
        // 非 JSON 错误体，保留默认
      }
      throw new ApiError(res.status, code, message)
    }
    return (await res.json()) as {
      ok: boolean
      item: ComposeSfxItem
      note: string
    }
  },
  /** 移除某镜音效（软删该镜全部有效行） */
  removeSfx: (runId: number, shotId: string) =>
    api.del<{ ok: boolean; note: string }>(
      `/api/v1/runs/${runId}/compose/sfx/${encodeURIComponent(shotId)}`,
    ),
  /**
   * 成片多画幅派生（A 路径；源 = 该 run 最新 final_video）。
   * 单路重编码同步完成（本地单机工具，长成片耗时相应增长）；同参已派生 → reused。
   */
  deriveAspect: (
    runId: number,
    aspect: AspectValue,
    strategy?: AspectStrategy,
  ) =>
    api.post<DeriveAspectResult>(`/api/v1/runs/${runId}/derive-aspect`, {
      aspect,
      ...(strategy ? { strategy } : {}),
    }),
}

// ===== 镜头工作台 =====

export const shotApi = {
  /** 工作台聚合读（镜头 × 任务 × 版本 × 选中 × 合成新鲜度） */
  board: (runId: number, stepKey: string) =>
    api.get<ShotBoardData>(
      `/api/v1/runs/${runId}/shot-board?step_key=${encodeURIComponent(stepKey)}`,
    ),
  /** 分镜字段级编辑（时长/提示词；写新分镜版本，重新合成后生效） */
  edit: (runId: number, stepKey: string, shots: ShotEditItem[]) =>
    api.post<{
      ok: boolean
      asset_id: number
      asset_ids: number[]
      edited: number
    }>(`/api/v1/runs/${runId}/shots/edit`, { step_key: stepKey, shots }),
  /** 单镜重生成（可选携带编辑字段：先写分镜再重置入队，仅目标镜重跑） */
  regenerate: (runId: number, stepKey: string, item: ShotEditItem) =>
    api.post<{
      ok: boolean
      edited: boolean
      run_id: number
      task_id: number
      note: string
    }>(`/api/v1/runs/${runId}/shots/regenerate`, {
      step_key: stepKey,
      ...item,
    }),
  /** 多版本选片 / 选镜（picks 为子集；reset=true 恢复全量最新；不触发执行） */
  select: (
    runId: number,
    stepKey: string,
    opts: { picks?: ShotPick[]; reset?: boolean },
  ) =>
    api.post<{ ok: boolean; asset_ids: number[] }>(
      `/api/v1/runs/${runId}/shots/select`,
      { step_key: stepKey, ...opts },
    ),
  /** 结构性编辑（reorder/add/remove/patch；写新分镜版本，不触发执行） */
  mutate: (runId: number, stepKey: string, ops: ShotOp[]) =>
    api.post<{
      ok: boolean
      asset_id: number
      asset_ids: number[]
      shots: number
      note: string
    }>(`/api/v1/runs/${runId}/shots/mutate`, { step_key: stepKey, ops }),
  /** 上传替换镜头（multipart：file + step_key + shot_id；入库 + 绑定选中） */
  uploadShot: async (
    runId: number,
    stepKey: string,
    shotId: string,
    file: File,
  ) => {
    const form = new FormData()
    form.append('step_key', stepKey)
    form.append('shot_id', shotId)
    form.append('file', file, file.name)
    let res: Response
    try {
      res = await fetch(`/api/v1/runs/${runId}/shots/upload`, {
        method: 'POST',
        body: form,
      })
    } catch {
      throw new ApiError(0, 'network', '无法连接服务（127.0.0.1:3001）')
    }
    if (!res.ok) {
      let code = 'http_' + res.status
      let message = `HTTP ${res.status}`
      try {
        const data = (await res.json()) as ApiErrorBody
        if (data?.error?.message) {
          code = data.error.code
          message = data.error.message
        }
      } catch {
        // 非 JSON 错误体，保留默认
      }
      throw new ApiError(res.status, code, message)
    }
    return (await res.json()) as {
      ok: boolean
      asset: Asset
      asset_ids: number[]
      note: string
    }
  },
  /** 重新合成（重置 ffmpeg_merge；succeeded 镜头步骤全跳过） */
  recompose: (runId: number, stepKey: string) =>
    api.post<{ ok: boolean; run_id: number; note: string }>(
      `/api/v1/runs/${runId}/recompose`,
      { step_key: stepKey },
    ),
  /** 版本组批量清理（保留最新/收藏/在用；其余移入回收站可还原；不触发执行） */
  cleanup: (runId: number, stepKey: string) =>
    api.post<CleanupResult & { run_id: number; step_key: string }>(
      `/api/v1/runs/${runId}/shots/cleanup`,
      { step_key: stepKey },
    ),
}

// ===== 小说改编链 =====

export const novelApi = {
  /** 小说改编看板聚合读（章节切分 × 事件图谱 × 分集规划 × 改编剧本） */
  board: (runId: number) =>
    api.get<NovelBoardData>(`/api/v1/runs/${runId}/novel-board`),
}

// ===== 质量评分（R01 基线：四维评分） =====

/** 单集评分结果（与 POST/GET /runs/:id/quality 响应契约对齐） */
export interface QualityScoreView {
  citationScore: number
  consistencyScore: number
  coherenceScore: number
  costScore: number
  overallScore: number
  metadata: {
    templateVersion: string
    promptVersion: string
    model: string
    params: Record<string, unknown>
    assetVersions: Record<string, string>
  }
}

/** 触发评分的请求体 */
export interface QualityScoreBody {
  episodeIdx: number
  weights?: {
    citation?: number
    consistency?: number
    coherence?: number
    cost?: number
  }
}

export const qualityApi = {
  /** 触发四维评分（POST /runs/:id/quality） */
  score: (runId: number, body: QualityScoreBody) =>
    api.post<{ score: QualityScoreView }>(
      `/api/v1/runs/${runId}/quality`,
      body,
    ),
  /** 查询单集评分（GET /runs/:id/quality/:episodeIdx） */
  getEpisode: (runId: number, episodeIdx: number) =>
    api.get<{ score: QualityScoreView; createdAt: string }>(
      `/api/v1/runs/${runId}/quality/${episodeIdx}`,
    ),
  /** 查询本 run 全部集评分（GET /runs/:id/quality） */
  getAll: (runId: number) =>
    api.get<{
      scores: Array<QualityScoreView & { episodeIdx: number }>
      episodeCount: number
    }>(`/api/v1/runs/${runId}/quality`),
}

// ===== 修复闭环（R06：质量修复提案 → 批准 → 执行 → 采纳/拒绝） =====

/** 修复问题条目：单个维度的质量缺陷与修复建议 */
export interface RepairIssue {
  /** 质量维度标识（citation / consistency / coherence / cost） */
  dimension: string
  /** 当前得分（百分制 0-100） */
  score: number
  /** 及格阈值（百分制，当前固定 70） */
  threshold: number
  /** 针对该维度的修复建议（自解释文本） */
  suggestion: string
}

/** 修复影响范围：共享数据源波及的其他运行与集号 */
export interface RepairImpactScope {
  /** 共享相同数据源的其他 run id */
  affectedRunIds: number[]
  /** 受影响 run 涉及的集号集合 */
  affectedEpisodes: number[]
  /** 作为关联桥梁的数据源标识（srcKind:srcId） */
  sharedSources: string[]
  /** 当前 run 自身关联的快照数量 */
  snapshotCount: number
}

/** 修复提案（POST /runs/:id/repair 响应中的 proposal 字段） */
export interface RepairProposal {
  runId: number
  episodeIdx: number
  issues: RepairIssue[]
  impactScope: RepairImpactScope
  estimatedCost: number
  scoreSnapshot: Record<string, unknown>
}

/** 修复运行状态（与 repair_runs.status 枚举对齐） */
export type RepairStatus =
  'proposed' | 'approved' | 'running' | 'completed' | 'cancelled' | 'failed'

/** 修复运行视图（GET /repairs/:id 响应中的 repair 字段） */
export interface RepairView {
  id: string
  sourceRunId: number
  episodeIdx: number
  status: RepairStatus
  issues: RepairIssue[]
  impactScope: RepairImpactScope
  attemptCount: number
  totalCost: number
  scoreBefore: number | null
  scoreAfter: number | null
  stopReason: string | null
  createdAt: number
  updatedAt: number
}

export const qualityGatesApi = {
  /**
   * 触发全部门禁检查（POST /runs/:id/quality-gates）
   * 走统一请求封装：服务端把拒因写在 `{error:{code,message}}`（如场次无出图资产、阶段未启用），
   * 自造泛化文案会把「为什么被拒」吞成一句「触发检查失败」，面板就只剩用户猜。
   */
  triggerAll: (runId: number, episodeIdx: number) =>
    api.post<{ gates: any[] }>(`/api/v1/runs/${runId}/quality-gates`, {
      episodeIdx,
    }),

  /** 查询全部门禁状态（GET /runs/:id/quality-gates?episodeIdx=N） */
  getAll: (runId: number, episodeIdx: number) =>
    api.get<{ gates: any[] }>(
      `/api/v1/runs/${runId}/quality-gates?episodeIdx=${episodeIdx}`,
    ),

  /** 查询单阶段门禁详情（GET /runs/:id/quality-gates/:stage?episodeIdx=N） */
  getStage: (runId: number, stage: string, episodeIdx: number) =>
    api.get<{ gate: any; issues: any[] }>(
      `/api/v1/runs/${runId}/quality-gates/${stage}?episodeIdx=${episodeIdx}`,
    ),

  /** 豁免指定问题（POST /quality-gates/issues/:id/exempt） */
  exemptIssue: (issueId: number, reason: string) =>
    api.post<{ gate: any }>(`/api/v1/quality-gates/issues/${issueId}/exempt`, {
      reason,
    }),

  /** 取消豁免（POST /quality-gates/issues/:id/unexempt；无请求体） */
  unexemptIssue: (issueId: number) =>
    api.post<{ gate: any }>(`/api/v1/quality-gates/issues/${issueId}/unexempt`),
}

// ===== 逐出镜实体一致性评价（分层参考链路） =====

/**
 * 结果表单行（run × entity 粒度；episodeIdx 恒为 0，issues 聚合同样跨集共计）。
 * 逐角色分是 0–10 的多模态评分，与运行级 0–1 自报一致性分（quality_scores 的四维之一）同名不同源，面板需标注口径。
 */
export interface CharacterConsistencyEntity {
  entityId: number
  episodeIdx: number
  /**
   * null = 级联清理落地前留下的历史行（实体已被删除，名字取不到）。
   * 现在删实体会连带清掉它的结果行，所以「已删实体仍成行回显」不是常规形态；界面按「实体 #id」兜底。
   */
  name: string | null
  /** null = 本次未能给出分数（无图 / 无基准 / 评分失败等，note 记原因原文） */
  score: number | null
  assetTotal: number
  assetSampled: number
  refCount: number
  model: string | null
  provider: string | null
  note: string | null
  evaluatedAt: number
  issues: { count: number; severities: string[] }
}

/** POST 响应的逐实体评价汇总（与服务端 EntityEvalSummary 契约一致） */
export interface EntityEvalResult {
  entityId: number
  name: string
  score: number | null
  assetTotal: number
  assetSampled: number
  refCount: number
  note: string | null
}

export const consistencyApi = {
  /** 读取已落库结果 + 一致性检查器问题聚合（纯读，不调模型） */
  getCharacter: (runId: number) =>
    api.get<{ runId: number; entities: CharacterConsistencyEntity[] }>(
      `/api/v1/runs/${runId}/character-consistency`,
    ),
  /**
   * 触发逐实体评价：每个出镜实体串行同步调用多模态评分（产生供应商费用）——
   * 串行 N 次真实调用远超默认 2 分钟请求上限 → 走 LONG（与批量润色同款口径）。
   */
  triggerEval: (runId: number) =>
    api.post<{ runId: number; results: EntityEvalResult[] }>(
      `/api/v1/runs/${runId}/consistency-eval`,
      undefined,
      LONG_TIMEOUT_MS,
    ),
}

export const repairsApi = {
  /** 启动修复提案（POST /runs/:id/repair） */
  propose: (runId: number, episodeIdx: number) =>
    api.post<{ repairId: string; proposal: RepairProposal }>(
      `/api/v1/runs/${runId}/repair`,
      { episodeIdx },
    ),
  /** 查询修复状态（GET /repairs/:id） */
  get: (repairId: string) =>
    api.get<{ repair: RepairView }>(`/api/v1/repairs/${repairId}`),
  /** 批准修复（POST /repairs/:id/approve） */
  approve: (repairId: string) =>
    api.post<{ success: boolean }>(`/api/v1/repairs/${repairId}/approve`),
  /** 取消修复（POST /repairs/:id/cancel） */
  cancel: (repairId: string) =>
    api.post<{ success: boolean }>(`/api/v1/repairs/${repairId}/cancel`),
  /** 采纳修复结果（POST /repairs/:id/accept） */
  accept: (repairId: string) =>
    api.post<{ success: boolean }>(`/api/v1/repairs/${repairId}/accept`),
  /** 拒绝修复 / 保留旧版本（POST /repairs/:id/reject） */
  reject: (repairId: string) =>
    api.post<{ success: boolean }>(`/api/v1/repairs/${repairId}/reject`),
}
