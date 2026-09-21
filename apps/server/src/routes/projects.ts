import { Hono } from 'hono'
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../db'
import {
  assets,
  batches,
  canvasEdges,
  canvasNodes,
  canvases,
  characters,
  contentVersions,
  creationMessages,
  creationSessions,
  execInputs,
  execSnapshots,
  genTasks,
  memories,
  pipelineRuns,
  pipelineSteps,
  projects,
  publications,
  usageRecords,
} from '../db/schema'
import { RUN_LOGS_DIR } from '../env'
import { createLogger } from '../logger'
import { loadTemplate } from '../pipeline/loader'
import { validateProjectSettings } from '../services/project-settings'
import { resolveNextSteps } from '../services/next-steps'
import { projectAbsDir } from '../services/storage'
import { HttpError, h, idParam, notFound } from './helpers'

const log = createLogger('projects')

export const projectsRoutes = new Hono()

// GET /projects —— 项目列表（?status= 过滤；含最近 run 与资产计数）
projectsRoutes.get('/projects', h(async (c) => {
  // [M40] 只开放 active|archived：轻松创作未立项的 draft 影子项目一律不出列表（其余值归 active）
  const status = c.req.query('status') === 'archived' ? 'archived' : 'active'
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.status, status), isNull(projects.deletedAt)))
    .orderBy(desc(projects.updatedAt))
  const ids = rows.map((r) => r.id)
  if (ids.length === 0) return c.json({ items: [] })

  const runs = await db
    .select({ id: pipelineRuns.id, projectId: pipelineRuns.projectId, status: pipelineRuns.status, templateKey: pipelineRuns.templateKey, createdAt: pipelineRuns.createdAt, updatedAt: pipelineRuns.updatedAt })
    .from(pipelineRuns)
    .where(inArray(pipelineRuns.projectId, ids))
    .orderBy(desc(pipelineRuns.updatedAt))
  const runsByProject = new Map<number, typeof runs[number][]>()
  for (const r of runs) {
    const list = runsByProject.get(r.projectId) ?? []
    if (list.length < 5) list.push(r)
    runsByProject.set(r.projectId, list)
  }
  const counts = await db
    .select({ projectId: assets.projectId, cnt: count() })
    .from(assets)
    .where(and(inArray(assets.projectId, ids), isNull(assets.deletedAt)))
    .groupBy(assets.projectId)
  const countByProject = new Map(counts.map((r) => [r.projectId, r.cnt]))
  return c.json({
    items: rows.map((p) => ({
      id: p.id,
      name: p.name,
      genre: p.genre,
      brief: p.brief,
      templateKey: p.templateKey,
      status: p.status,
      coverAssetId: p.coverAssetId,
      tags: safeJson(p.tags, []),
      assetCount: countByProject.get(p.id) ?? 0,
      recentRuns: (runsByProject.get(p.id) ?? []).map((r) => ({
        id: r.id,
        status: r.status,
        templateKey: r.templateKey,
        updatedAt: r.updatedAt,
      })),
      updatedAt: p.updatedAt,
    })),
  })
}))

// POST /projects —— 新建项目
projectsRoutes.post('/projects', h(async (c) => {
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const name = body['name']
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'bad_name', 'name 必填')
  const templateKey = typeof body['template_key'] === 'string' ? body['template_key'] : 'mengbao-episode'
  try {
    loadTemplate(templateKey)
  } catch (err) {
    throw new HttpError(400, 'bad_template', `模板不可用：${(err as Error).message}`)
  }
  const genre = typeof body['genre'] === 'string' ? body['genre'] : 'drama_short'
  // [M35 G9] settings 写时闸门（已登记字段白名单校验，未登记字段放行）
  if (body['settings'] !== undefined && body['settings'] !== null) {
    const errs = validateProjectSettings(body['settings'])
    if (errs.length > 0) throw new HttpError(400, 'bad_settings', errs.join('；'))
  }
  const settings = body['settings'] && typeof body['settings'] === 'object' ? JSON.stringify(body['settings']) : '{}'
  const tags = Array.isArray(body['tags']) ? JSON.stringify(body['tags'].filter((t: unknown) => typeof t === 'string')) : '[]'
  const t = Date.now()
  const row = await db
    .insert(projects)
    .values({
      name: name.trim(),
      genre,
      brief: typeof body['brief'] === 'string' ? body['brief'] : null,
      templateKey,
      settings,
      tags,
      createdAt: t,
      updatedAt: t,
    })
    .returning()
  const p = row[0]!
  return c.json({ project: { id: p.id, name: p.name, genre: p.genre, templateKey: p.templateKey, brief: p.brief } }, 201)
}))

// GET /projects/:id —— 详情（含 settings 解析 + 资产计数 + 最近 5 runs）
projectsRoutes.get('/projects/:id', h(async (c) => {
  const id = idParam(c)
  const rows = await db.select().from(projects).where(and(eq(projects.id, id), isNull(projects.deletedAt))).limit(1)
  const p = rows[0]
  if (!p) return notFound(c, `项目 ${id}`)
  const runs = await db
    .select()
    .from(pipelineRuns)
    .where(eq(pipelineRuns.projectId, id))
    .orderBy(desc(pipelineRuns.createdAt))
    .limit(5)
  // 资产计数（前端资产区懒加载时 Tab 角标/KPI 仍能显示真实总数）
  const assetCount = Number(
    (await db.select({ n: count() }).from(assets).where(and(eq(assets.projectId, id), isNull(assets.deletedAt))))[0]?.n ?? 0,
  )
  return c.json({
    project: {
      ...p,
      assetCount,
      settings: safeJson(p.settings, {}),
      tags: safeJson(p.tags, []),
      recentRuns: runs.map((r) => ({
        id: r.id,
        status: r.status,
        templateKey: r.templateKey,
        currentStepKey: r.currentStepKey,
        error: r.error,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    },
  })
}))

// PATCH /projects/:id —— 局部更新（name/brief/settings/tags/status/template_key/cover_asset_id）
projectsRoutes.patch('/projects/:id', h(async (c) => {
  const id = idParam(c)
  const body = await c.req.json().catch(() => { throw new HttpError(400, 'bad_json', '请求体非合法 JSON') })
  const patch: Record<string, unknown> = { updatedAt: Date.now() }
  if (body['name'] !== undefined) {
    if (typeof body['name'] !== 'string' || !body['name'].trim()) throw new HttpError(400, 'bad_name', 'name 非法')
    patch['name'] = body['name'].trim()
  }
  if (body['brief'] !== undefined) patch['brief'] = typeof body['brief'] === 'string' ? body['brief'] : null
  if (body['genre'] !== undefined) {
    if (typeof body['genre'] !== 'string' || !body['genre'].trim()) throw new HttpError(400, 'bad_genre', 'genre 需为非空字符串')
    patch['genre'] = body['genre'].trim()
  }
  if (body['status'] !== undefined) {
    if (!['active', 'archived'].includes(body['status'] as string)) throw new HttpError(400, 'bad_status', 'status 需为 active|archived')
    patch['status'] = body['status']
  }
  if (body['template_key'] !== undefined) {
    if (typeof body['template_key'] !== 'string') throw new HttpError(400, 'bad_template', 'template_key 非法')
    try { loadTemplate(body['template_key']) } catch (err) { throw new HttpError(400, 'bad_template', `模板不可用：${(err as Error).message}`) }
    patch['templateKey'] = body['template_key']
  }
  if (body['settings'] !== undefined && typeof body['settings'] === 'object') {
    // [M35 G9] settings 写时闸门（与 POST 同口径，已登记字段白名单 + 未登记字段放行）
    const errs = validateProjectSettings(body['settings'])
    if (errs.length > 0) throw new HttpError(400, 'bad_settings', errs.join('；'))
    patch['settings'] = JSON.stringify(body['settings'])
  }
  if (body['tags'] !== undefined && Array.isArray(body['tags'])) patch['tags'] = JSON.stringify(body['tags'])
  if (body['cover_asset_id'] !== undefined) patch['coverAssetId'] = body['cover_asset_id'] === null ? null : Number(body['cover_asset_id'])
  const rows = await db.update(projects).set(patch).where(and(eq(projects.id, id), isNull(projects.deletedAt))).returning()
  if (!rows[0]) return notFound(c, `项目 ${id}`)
  return c.json({ project: rows[0] })
}))

// [M35 G11] GET /projects/:id/next-steps —— 规则引擎下一步建议（零 LLM、零计费，纯提示不自动执行）
projectsRoutes.get('/projects/:id/next-steps', h(async (c) => {
  const id = idParam(c)
  const items = await resolveNextSteps(id)
  return c.json({ items })
}))

// DELETE /projects/:id —— 默认归档（逻辑删 status=archived，可恢复）；?purge=1 彻底删除（事务清库 + 删除磁盘文件，不可恢复）
projectsRoutes.delete('/projects/:id', h(async (c) => {
  const id = idParam(c)
  const exists = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .limit(1)
  if (!exists[0]) return notFound(c, `项目 ${id}`)

  if (c.req.query('purge') !== '1') {
    await db.update(projects).set({ status: 'archived', updatedAt: Date.now() }).where(eq(projects.id, id))
    return c.json({ ok: true, mode: 'archived' })
  }

  // 活跃 run 拦截：运行中的引擎仍会向该项目写数据，先取消再删
  const activeRuns = await db
    .select({ id: pipelineRuns.id })
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.projectId, id), inArray(pipelineRuns.status, ['queued', 'running', 'waiting_input'])))
  if (activeRuns.length > 0) {
    throw new HttpError(409, 'has_active_runs', `项目还有 ${activeRuns.length} 个未完成运行，请先取消全部运行后再删除`)
  }

  const runIds = (
    await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.projectId, id))
  ).map((r) => r.id)
  // [M16] 创作画布归属画布 id（先清边/节点再清画布）
  const canvasIds = (
    await db.select({ id: canvases.id }).from(canvases).where(eq(canvases.projectId, id))
  ).map((r) => r.id)
  // 无外键约束：事务内按依赖顺序清理（steps → runs → 其余按 project_id → projects 最后）
  const purged = await db.transaction(async (tx) => {
    const cnt = async (rows: Promise<{ id: number }[]>) => (await rows).length
    const active = await tx.select({ id: pipelineRuns.id }).from(pipelineRuns).where(and(eq(pipelineRuns.projectId, id), inArray(pipelineRuns.status, ['queued', 'running', 'waiting_input'])))
    if (active.length) throw new HttpError(409, 'has_active_runs', '项目刚启动了制作，请先取消后再删除')
    const sessions = tx.select({ id: creationSessions.id }).from(creationSessions).where(eq(creationSessions.projectId, id))
    return {
      creationMessages: await cnt(tx.delete(creationMessages).where(inArray(creationMessages.sessionId, sessions)).returning({ id: creationMessages.id })),
      creationSessions: await cnt(tx.delete(creationSessions).where(eq(creationSessions.projectId, id)).returning({ id: creationSessions.id })),
      steps: runIds.length
        ? await cnt(tx.delete(pipelineSteps).where(inArray(pipelineSteps.runId, runIds)).returning({ id: pipelineSteps.id }))
        : 0,
      runs: await cnt(tx.delete(pipelineRuns).where(eq(pipelineRuns.projectId, id)).returning({ id: pipelineRuns.id })),
      tasks: await cnt(tx.delete(genTasks).where(eq(genTasks.projectId, id)).returning({ id: genTasks.id })),
      assets: await cnt(tx.delete(assets).where(eq(assets.projectId, id)).returning({ id: assets.id })),
      batches: await cnt(tx.delete(batches).where(eq(batches.projectId, id)).returning({ id: batches.id })),
      usage: await cnt(tx.delete(usageRecords).where(eq(usageRecords.projectId, id)).returning({ id: usageRecords.id })),
      publications: await cnt(tx.delete(publications).where(eq(publications.projectId, id)).returning({ id: publications.id })),
      memories: await cnt(tx.delete(memories).where(eq(memories.projectId, id)).returning({ id: memories.id })),
      characters: await cnt(tx.delete(characters).where(eq(characters.projectId, id)).returning({ id: characters.id })),
      canvasEdges: canvasIds.length
        ? await cnt(tx.delete(canvasEdges).where(inArray(canvasEdges.canvasId, canvasIds)).returning({ id: canvasEdges.id }))
        : 0,
      canvasNodes: canvasIds.length
        ? await cnt(tx.delete(canvasNodes).where(inArray(canvasNodes.canvasId, canvasIds)).returning({ id: canvasNodes.id }))
        : 0,
      canvases: await cnt(tx.delete(canvases).where(eq(canvases.projectId, id)).returning({ id: canvases.id })),
      // [M29·R02] 追溯三表级联删（无外键，按依赖序：exec_inputs → exec_snapshots → content_versions）
      execInputs: await cnt(tx.delete(execInputs).where(eq(execInputs.projectId, id)).returning({ id: execInputs.id })),
      execSnapshots: await cnt(tx.delete(execSnapshots).where(eq(execSnapshots.projectId, id)).returning({ id: execSnapshots.id })),
      contentVersions: await cnt(tx.delete(contentVersions).where(eq(contentVersions.projectId, id)).returning({ id: contentVersions.id })),
      projects: await cnt(tx.delete(projects).where(eq(projects.id, id)).returning({ id: projects.id })),
    }
  })

  // 磁盘清理在事务提交后执行（素材/产物/导出目录 + run 日志）；残留为孤儿文件，失败仅告警不影响数据一致性
  try {
    rmSync(projectAbsDir(id), { recursive: true, force: true })
    for (const rid of runIds) rmSync(join(RUN_LOGS_DIR, `${rid}.log`), { force: true })
  } catch (err) {
    log.warn(`项目 ${id} 磁盘文件清理失败：${(err as Error).message}`)
  }
  log.info('项目已彻底删除', { id, purged })
  return c.json({ ok: true, mode: 'purged', purged })
}))

function safeJson(s: string | null, fallback: unknown): unknown {
  if (!s) return fallback
  try { return JSON.parse(s) } catch { return fallback }
}