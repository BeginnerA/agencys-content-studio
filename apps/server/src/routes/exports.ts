/**
 * [M4] 导出 REST（E3）：生成/列表/run 产物/批量导出
 * [M20] B8：平台导出预设管理（CRUD + 默认预设）
 * - 下载复用 GET /assets/:id/file?download=1（Range 已支持，不改动）
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { pipelineRuns, projects, settings, type Asset } from '../db/schema'
import { summarizeBatch } from '../services/batch'
import { ExportError, buildRunExport, collectRunAssets, listExports } from '../services/export'
import { HttpError, h, idParam, notFound } from './helpers'

export const exportsRoutes = new Hono()

// POST /runs/:id/exports —— 生成发布包（{name?, asset_ids?}；任何状态的 run 均可导出已有产物）
exportsRoutes.post('/runs/:id/exports', h(async (c) => {
  const runId = idParam(c)
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const rawIds = body['asset_ids']
  if (rawIds !== undefined && !Array.isArray(rawIds)) throw new HttpError(400, 'bad_input', 'asset_ids 需为数组')
  try {
    const asset = await buildRunExport({
      runId,
      name: typeof body['name'] === 'string' ? body['name'] : undefined,
      assetIds: rawIds === undefined ? null : (rawIds as unknown[]).map(Number),
    })
    return c.json({ asset: toAssetLite(asset) }, 201)
  } catch (err) {
    if (err instanceof ExportError) throw new HttpError(400, err.code, err.message)
    throw err
  }
}))

// GET /exports?run_id=&project_id= —— 导出包列表
exportsRoutes.get('/exports', h(async (c) => {
  const runId = c.req.query('run_id')
  const projectId = c.req.query('project_id')
  const rows = await listExports({
    runId: runId ? Number(runId) : undefined,
    projectId: projectId ? Number(projectId) : undefined,
  })
  return c.json({ items: rows.map(toAssetLite) })
}))

// GET /runs/:id/assets —— 该 run 全部产物（导出向导数据源）
exportsRoutes.get('/runs/:id/assets', h(async (c) => {
  const runId = idParam(c)
  const exists = (await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1))[0]
  if (!exists) return notFound(c, `run ${runId}`)
  const rows = await collectRunAssets(runId)
  return c.json({ items: rows.map((a) => ({ ...toAssetLite(a), stepId: a.stepId, sha256: a.sha256 })) })
}))

// POST /batches/:id/exports —— 批量导出（对有产物的 run 逐个全量打包；无产物 run 记 skipped）
exportsRoutes.post('/batches/:id/exports', h(async (c) => {
  const batchId = idParam(c)
  const detail = await summarizeBatch(batchId)
  if (!detail) return notFound(c, `批次 ${batchId}`)
  const proj = (await db.select({ name: projects.name }).from(projects).where(eq(projects.id, detail.batch.projectId)).limit(1))[0]
  const projName = proj?.name ?? `project${detail.batch.projectId}`
  const items: Array<{ runId: number; assetId: number; name: string }> = []
  const skipped: Array<{ runId: number; reason: string }> = []
  for (const r of detail.runs) {
    try {
      const a = await buildRunExport({ runId: r.id, name: `${detail.batch.name}_集${r.batchSeq ?? r.id}_${projName}` })
      items.push({ runId: r.id, assetId: a.id, name: a.name })
    } catch (err) {
      if (err instanceof ExportError) {
        skipped.push({ runId: r.id, reason: err.message })
        continue
      }
      throw err
    }
  }
  return c.json({ items, skipped })
}))

function toAssetLite(a: Asset): Record<string, unknown> {
  return {
    id: a.id, projectId: a.projectId, runId: a.runId, kind: a.kind, purpose: a.purpose,
    name: a.name, mime: a.mime, ext: a.ext, fileSize: a.fileSize,
    width: a.width, height: a.height, duration: a.duration,
    tags: safeParse(a.tags), createdAt: a.createdAt, updatedAt: a.updatedAt,
  }
}

function safeParse(s: string | null): unknown {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

// ---------- [M20] B8 平台导出预设 ----------

/** 默认平台预设（与 publications 平台枚举对齐） */
const DEFAULT_PRESETS: Record<string, ExportPreset> = {
  douyin: { platform: 'douyin', label: '抖音', aspect: '9:16', maxDuration: 60, namingPattern: '{project}_{template}_run{run}', includeCover: true, includeSubtitle: true },
  wechat_channels: { platform: 'wechat_channels', label: '视频号', aspect: '9:16', maxDuration: 180, namingPattern: '{project}_{template}_run{run}', includeCover: true, includeSubtitle: true },
  kuaishou: { platform: 'kuaishou', label: '快手', aspect: '9:16', maxDuration: 120, namingPattern: '{project}_{template}_run{run}', includeCover: true, includeSubtitle: true },
  xiaohongshu: { platform: 'xiaohongshu', label: '小红书', aspect: '4:5', maxDuration: 60, namingPattern: '{project}_{template}_run{run}', includeCover: true, includeSubtitle: true },
  bilibili: { platform: 'bilibili', label: 'B站', aspect: '16:9', maxDuration: 600, namingPattern: '{project}_{template}_run{run}', includeCover: true, includeSubtitle: true },
}

interface ExportPreset {
  platform: string
  label: string
  aspect: string
  maxDuration: number
  namingPattern: string
  includeCover: boolean
  includeSubtitle: boolean
  watermark?: boolean
}

async function loadPresets(): Promise<Record<string, ExportPreset>> {
  const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'export_presets')).limit(1)
  if (!rows[0]?.value) return { ...DEFAULT_PRESETS }
  try {
    const parsed = JSON.parse(rows[0].value) as Record<string, ExportPreset>
    return { ...DEFAULT_PRESETS, ...parsed }
  } catch {
    return { ...DEFAULT_PRESETS }
  }
}

async function savePresets(presets: Record<string, ExportPreset>): Promise<void> {
  const json = JSON.stringify(presets)
  const existing = await db.select({ key: settings.key }).from(settings).where(eq(settings.key, 'export_presets')).limit(1)
  if (existing.length) {
    await db.update(settings).set({ value: json, updatedAt: Date.now() }).where(eq(settings.key, 'export_presets'))
  } else {
    await db.insert(settings).values({ key: 'export_presets', value: json, updatedAt: Date.now() })
  }
}

/** GET /exports/presets —— 获取平台预设列表 */
exportsRoutes.get('/exports/presets', h(async (c) => {
  const presets = await loadPresets()
  return c.json({ items: Object.values(presets), defaults: Object.keys(DEFAULT_PRESETS) })
}))

/** PUT /exports/presets —— 更新平台预设（全量覆盖） */
exportsRoutes.put('/exports/presets', h(async (c) => {
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  const items = body['items']
  if (!Array.isArray(items)) throw new HttpError(400, 'bad_input', 'items 需为数组')
  const map: Record<string, ExportPreset> = {}
  for (const raw of items) {
    const p = raw as Partial<ExportPreset>
    if (!p.platform || !p.label) continue
    map[p.platform] = {
      platform: p.platform,
      label: p.label,
      aspect: p.aspect ?? '9:16',
      maxDuration: p.maxDuration ?? 60,
      namingPattern: p.namingPattern ?? '{project}_{template}_run{run}',
      includeCover: p.includeCover !== false,
      includeSubtitle: p.includeSubtitle !== false,
      watermark: p.watermark,
    }
  }
  await savePresets(map)
  return c.json({ items: Object.values(map) })
}))
