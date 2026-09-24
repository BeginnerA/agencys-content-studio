import { ApiError, api, type Items } from './core'
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

export const runApi = {
  /** 运行列表（?project_id=&status=；全局待审阅聚合用 status=waiting_input） */
  list: (params = '') => api.get<Items<Run>>(`/api/v1/runs${params}`),
  detail: (id: number) => api.get<RunDetail>(`/api/v1/runs/${id}`),
  log: (id: number, tail = 200) =>
    api.get<{ log: string }>(`/api/v1/runs/${id}/log?tail=${tail}`),
  start: (
    projectId: number,
    body: { template_key: string; input: Record<string, unknown> },
  ) => api.post<{ run: Run }>(`/api/v1/projects/${projectId}/runs`, body),
  gate: (id: number, body: Record<string, unknown>) =>
    api.post<RunDetail>(`/api/v1/runs/${id}/gate`, body),
  cancel: (id: number) => api.post<{ run: Run }>(`/api/v1/runs/${id}/cancel`),
  resume: (id: number, body?: Record<string, unknown>) =>
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
  /** 版本组批量清理（保留最新/收藏/在用；软删可回溯；不触发执行） */
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
