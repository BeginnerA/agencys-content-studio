/**
 * [M14] 剧集实体服务（平台级通用：剧 → 集两级）。
 * - 载体：series / episodes 两表（一项目一剧；集号项目内唯一）。
 * - 状态派生：展示以「最新 run 状态」为准（Q2 决策：run 活跃/终态优先），无 run 时回落行 status（locked/planning/done）。
 * - run 联动：启动端点后置回写（mapRunToEpisode），失败不阻断 run（宽容降级）。
 */
import { and, asc, desc, eq } from 'drizzle-orm'
import { db } from '../db'
import { assets, episodes, pipelineRuns, series, type Episode, type Series } from '../db/schema'
import { WorkbenchError } from './shot-workbench'

/** 行的更新时间戳（保证已存在返回时只读） */
const now = (): number => Date.now()

/** 手工态白名单（展示态另经最新 run 状态派生合并） */
const EPISODE_STATUSES = ['locked', 'planning', 'done']

/** 剧集视图（API 出参；JSON 可序列化） */
export interface SeriesView {
  id: number
  projectId: number
  name: string
  totalEpisodes: number
  contentAssetId: number | null
  createdAt: number
  updatedAt: number
}

/** 集视图（status 为派生合并后的展示态） */
export interface EpisodeView {
  id: number
  projectId: number
  seriesId: number
  number: number
  title: string | null
  /** 展示态：最新 run 状态优先，无 run 回落行值 */
  status: string
  /** 行原值（locked|planning|done；管理端编辑回显用） */
  rowStatus: string
  contentAssetId: number | null
  latestRunId: number | null
  runStatus: string | null
  createdAt: number
  updatedAt: number
}

export function toSeriesView(s: Series): SeriesView {
  return {
    id: s.id,
    projectId: s.projectId,
    name: s.name,
    totalEpisodes: s.totalEpisodes,
    contentAssetId: s.contentAssetId,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }
}

/** 单集视图（runStatus 由调用方提供；无 run → runStatus=null，status=行值） */
export function toEpisodeView(e: Episode, runStatus: string | null = null): EpisodeView {
  return {
    id: e.id,
    projectId: e.projectId,
    seriesId: e.seriesId,
    number: e.number,
    title: e.title,
    status: runStatus ?? e.status,
    rowStatus: e.status,
    contentAssetId: e.contentAssetId,
    latestRunId: e.latestRunId,
    runStatus,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  }
}

/** 项目 → 剧（无 → null；一项目一剧） */
export async function findSeriesOfProject(projectId: number): Promise<Series | null> {
  const rows = await db.select().from(series).where(eq(series.projectId, projectId)).limit(1)
  return rows[0] ?? null
}

/**
 * 建剧：项目校验 → 一项目一剧唯一（已有 → 409）→ 建剧行 + 生成 1..N 集行；
 * content_asset_id 可选（须属本项目且未删除）。
 */
export async function createSeries(p: {
  projectId: number
  name: string
  totalEpisodes: number
  contentAssetId?: number | null
}): Promise<{ series: Series; episodes: Episode[] }> {
  const name = p.name.trim()
  if (!name) throw new WorkbenchError('bad_name', 'name 必填（非空字符串）')
  if (!Number.isInteger(p.totalEpisodes) || p.totalEpisodes < 1 || p.totalEpisodes > 999) {
    throw new WorkbenchError('bad_total', 'total_episodes 需为 1..999 的整数')
  }
  if (p.contentAssetId !== undefined && p.contentAssetId !== null) {
    const rows = await db.select().from(assets).where(eq(assets.id, p.contentAssetId)).limit(1)
    const a = rows[0]
    if (!a || a.projectId !== p.projectId || a.deletedAt) {
      throw new WorkbenchError('bad_asset', `content_asset_id #${p.contentAssetId} 不存在或不属于本项目`)
    }
  }
  const existing = await findSeriesOfProject(p.projectId)
  if (existing) throw new WorkbenchError('series_exists', `项目 ${p.projectId} 已有剧集（#${existing.id} ${existing.name}），一项目一剧`, 409)
  const t = now()
  const s = (
    await db
      .insert(series)
      .values({
        projectId: p.projectId,
        name,
        totalEpisodes: p.totalEpisodes,
        contentAssetId: p.contentAssetId ?? null,
        createdAt: t,
        updatedAt: t,
      })
      .returning()
  )[0]!
  const rows: Episode[] = []
  for (let n = 1; n <= p.totalEpisodes; n++) {
    const e = (
      await db
        .insert(episodes)
        .values({ projectId: p.projectId, seriesId: s.id, number: n, status: 'locked', createdAt: t, updatedAt: t })
        .returning()
    )[0]!
    rows.push(e)
  }
  return { series: s, episodes: rows }
}

/**
 * 集列表（status 派生）：单查询左关联 run 表 → runStatus；派生规则 run 优先。
 * 行序 number asc。
 */
export async function listEpisodes(seriesId: number): Promise<EpisodeView[]> {
  const rows = await db
    .select({ ep: episodes, runStatus: pipelineRuns.status })
    .from(episodes)
    .leftJoin(pipelineRuns, eq(episodes.latestRunId, pipelineRuns.id))
    .where(eq(episodes.seriesId, seriesId))
    .orderBy(asc(episodes.number))
  return rows.map((r) => toEpisodeView(r.ep, r.runStatus ?? null))
}

/** 集行查询（项目归属校验） */
export async function findEpisode(projectId: number, episodeId: number): Promise<Episode> {
  const rows = await db.select().from(episodes).where(eq(episodes.id, episodeId)).limit(1)
  const e = rows[0]
  if (!e || e.projectId !== projectId) throw new WorkbenchError('not_found', `集 #${episodeId} 不存在`, 404)
  return e
}

/**
 * 调整集数（扩容追集 / 缩容仅删尾部空集）：
 * 缩容边界——被删的每一个集必须无 run 且无内容资产，否则 409；缺号（已被删）不重建。
 */
export async function updateSeriesEpisodes(seriesId: number, totalEpisodes: number): Promise<{ series: Series; episodes: EpisodeView[] }> {
  if (!Number.isInteger(totalEpisodes) || totalEpisodes < 1 || totalEpisodes > 999) {
    throw new WorkbenchError('bad_total', 'total_episodes 需为 1..999 的整数')
  }
  const rows = await db.select().from(series).where(eq(series.id, seriesId)).limit(1)
  const s = rows[0]
  if (!s) throw new WorkbenchError('not_found', `剧 #${seriesId} 不存在`, 404)
  const t = now()
  const current = await db.select().from(episodes).where(eq(episodes.seriesId, seriesId))
  const byNumber = new Map(current.map((e) => [e.number, e]))
  const currentMax = current.reduce((m, e) => Math.max(m, e.number), 0)
  // 扩容：仅追加历史最大集号之后的新集（缺号保持缺号）
  for (let n = Math.max(currentMax, s.totalEpisodes) + 1; n <= totalEpisodes; n++) {
    await db
      .insert(episodes)
      .values({ projectId: s.projectId, seriesId, number: n, status: 'locked', createdAt: t, updatedAt: t })
  }
  // 缩容：拒绝删除有 run / 有内容资产的集
  for (const e of current) {
    if (e.number <= totalEpisodes) continue
    if (e.latestRunId || e.contentAssetId) {
      throw new WorkbenchError('episode_in_use', `集 ${e.number} 已关联 run / 内容资产，不可删除（先解除绑定）`, 409)
    }
  }
  // 逐条删除尾部集（全部前置校验已通过）
  for (const e of current) {
    if (e.number <= totalEpisodes) continue
    await db.delete(episodes).where(eq(episodes.id, e.id))
  }
  await db.update(series).set({ totalEpisodes, updatedAt: t }).where(eq(series.id, seriesId))
  const fresh = (await db.select().from(series).where(eq(series.id, seriesId)))[0]!
  return { series: fresh, episodes: await listEpisodes(seriesId) }
}

/** 原生集行列表（内部用） */
async function listEpisodeRows(seriesId: number): Promise<Episode[]> {
  return db.select().from(episodes).where(eq(episodes.seriesId, seriesId)).orderBy(asc(episodes.number))
}

/** 剧删除（安全边界：任集有 run / 内容资产 → 409） */
export async function deleteSeries(seriesId: number): Promise<void> {
  const rows = await db.select().from(series).where(eq(series.id, seriesId)).limit(1)
  const s = rows[0]
  if (!s) throw new WorkbenchError('not_found', `剧 #${seriesId} 不存在`, 404)
  const eps = await listEpisodeRows(seriesId)
  const busy = eps.filter((e) => e.latestRunId || e.contentAssetId)
  if (busy.length > 0) {
    throw new WorkbenchError('series_in_use', `剧已有 ${busy.length} 集关联 run / 内容资产，不可删除`, 409)
  }
  await db.delete(episodes).where(eq(episodes.seriesId, seriesId))
  await db.delete(series).where(eq(series.id, seriesId))
}

/** 单集删除（保留其 run 与资产，仅删集行） */
export async function deleteEpisode(episodeId: number): Promise<void> {
  const rows = await db.select().from(episodes).where(eq(episodes.id, episodeId)).limit(1)
  if (!rows[0]) throw new WorkbenchError('not_found', `集 #${episodeId} 不存在`, 404)
  await db.delete(episodes).where(eq(episodes.id, episodeId))
}

/** 单集行更新（title / status / content_asset_id 白名单） */
export async function updateEpisode(
  episodeId: number,
  patch: { title?: string | null; status?: string; contentAssetId?: number | null },
): Promise<Episode> {
  const rows = await db.select().from(episodes).where(eq(episodes.id, episodeId)).limit(1)
  const e = rows[0]
  if (!e) throw new WorkbenchError('not_found', `集 #${episodeId} 不存在`, 404)
  const set: Partial<Episode> = { updatedAt: now() }
  if (patch.title !== undefined) set.title = patch.title
  if (patch.status !== undefined) {
    if (!EPISODE_STATUSES.includes(patch.status)) {
      throw new WorkbenchError('bad_status', `status 需为 ${EPISODE_STATUSES.join('|')}`)
    }
    set.status = patch.status
  }
  if (patch.contentAssetId !== undefined) {
    if (patch.contentAssetId !== null) {
      const aRows = await db.select().from(assets).where(eq(assets.id, patch.contentAssetId)).limit(1)
      const a = aRows[0]
      if (!a || a.projectId !== e.projectId || a.deletedAt) {
        throw new WorkbenchError('bad_asset', `content_asset_id #${patch.contentAssetId} 不存在或不属于本项目`)
      }
    }
    set.contentAssetId = patch.contentAssetId
  }
  const fresh = (await db.update(episodes).set(set).where(eq(episodes.id, episodeId)).returning())[0]!
  return fresh
}

/** 项目 + 集号 → 集行（无剧/无集 → null） */
export async function findEpisodeByNumber(projectId: number, episodeNumber: number): Promise<Episode | null> {
  const s = await findSeriesOfProject(projectId)
  if (!s) return null
  const rows = await db
    .select()
    .from(episodes)
    .where(and(eq(episodes.seriesId, s.id), eq(episodes.number, episodeNumber)))
    .limit(1)
  return rows[0] ?? null
}

/**
 * run 启动联动（后置回写）：项目有剧 且 该集存在 → episodes.latest_run_id = runId；
 * 无剧/无集/集号缺失 → { linked: false }（宽容跳过，不影响 run）。
 */
export async function mapRunToEpisode(projectId: number, episodeNumber: unknown, runId: number): Promise<{ linked: boolean; reason?: string }> {
  const n = Number(episodeNumber)
  if (!Number.isInteger(n) || n < 1) return { linked: false, reason: 'no_episode_number' }
  const s = await findSeriesOfProject(projectId)
  if (!s) return { linked: false, reason: 'no_series' }
  const rows = await db
    .select()
    .from(episodes)
    .where(and(eq(episodes.seriesId, s.id), eq(episodes.number, n)))
    .limit(1)
  const e = rows[0]
  if (!e) return { linked: false, reason: 'no_episode_row' }
  await db.update(episodes).set({ latestRunId: runId, updatedAt: now() }).where(eq(episodes.id, e.id))
  return { linked: true }
}

/** 集的最新 run 状态（列表项逐个补全用；工作台/详情页） */
export async function latestRunStatus(runId: number | null): Promise<string | null> {
  if (!runId) return null
  const rows = await db.select({ status: pipelineRuns.status }).from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
  return rows[0]?.status ?? null
}

/** 项目最近 run（剧集卡快速回显用）：按创建倒序 limit N */
export async function recentRunsOfProject(projectId: number, limit = 5): Promise<Array<{ id: number; episodeNumber: number | null; status: string }>> {
  const rows = await db
    .select({ id: pipelineRuns.id, status: pipelineRuns.status, input: pipelineRuns.input })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.projectId, projectId))
    .orderBy(desc(pipelineRuns.id))
    .limit(limit)
  return rows.map((r) => {
    let ep: number | null = null
    try {
      const v = (JSON.parse(r.input) as { episode_number?: unknown }).episode_number
      const n = Number(v)
      ep = Number.isInteger(n) && n >= 1 ? n : null
    } catch {
      ep = null
    }
    return { id: r.id, episodeNumber: ep, status: r.status }
  })
}
