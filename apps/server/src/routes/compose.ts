/**
 * [M11] 合成设置路由（run 级：_compose 配置 + BGM 绑定）。
 * - 配置/绑定不触发执行：重新合成（recompose）后生效
 * - WorkbenchError → HttpError（wb 共用）；run 状态校验在服务层（completed/failed）
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  bindBgmFromAsset,
  bindBgmFromUpload,
  getComposeConfig,
  removeBgm,
  updateComposeConfig,
} from '../services/compose-config'
import { HttpError, h, idParam, wb } from './helpers'
import { toAssetView } from './assets'

export const composeRoutes = new Hono()

// GET /runs/:id/compose/config —— 合成配置回显（config 空对象 = 未设置，前端用默认值展示）
composeRoutes.get('/runs/:id/compose/config', h(async (c) => {
  const runId = idParam(c)
  const { config } = await wb(() => getComposeConfig(runId))
  return c.json({ config })
}))

// PUT /runs/:id/compose/config —— 更新（transition/duration/bgm_volume/bgm_fade；白名单+枚举+clamp）
composeRoutes.put('/runs/:id/compose/config', h(async (c) => {
  const runId = idParam(c)
  const body = await bodyJson(c)
  const config = await wb(() => updateComposeConfig(runId, body))
  return c.json({ ok: true, config, note: '配置已保存（重新合成后生效）' })
}))

// GET /runs/:id/compose/bgm —— 当前 BGM
composeRoutes.get('/runs/:id/compose/bgm', h(async (c) => {
  const runId = idParam(c)
  const { bgm } = await wb(() => getComposeConfig(runId))
  return c.json({ bgm: bgm ? toAssetView(bgm) : null })
}))

// POST /runs/:id/compose/bgm —— 绑定（JSON {asset_id} 项目音频复制行 / multipart file 上传）
composeRoutes.post('/runs/:id/compose/bgm', h(async (c) => {
  const runId = idParam(c)
  const ct = c.req.header('content-type') ?? ''
  if (ct.includes('multipart/form-data')) {
    const form = await c.req.formData().catch(() => { throw new HttpError(400, 'bad_form', '非 multipart/form-data 请求') })
    const fileRaw = form.get('file')
    if (!fileRaw || typeof fileRaw === 'string') throw new HttpError(400, 'no_file', '未收到文件（字段名 file）')
    const file = fileRaw as File
    if (file.size > 200 * 1024 * 1024) throw new HttpError(413, 'too_large', '单文件超过 200MB 上限')
    const buf = new Uint8Array(await file.arrayBuffer())
    if (buf.byteLength === 0) throw new HttpError(400, 'no_file', '文件内容为空')
    const bgm = await wb(() => bindBgmFromUpload(runId, { name: file.name || `bgm-${Date.now()}`, data: buf }))
    return c.json({ ok: true, bgm: toAssetView(bgm), note: 'BGM 已绑定（重新合成后生效）' }, 201)
  }
  const body = await bodyJson(c)
  const assetId = body['asset_id']
  if (typeof assetId !== 'number' || !Number.isInteger(assetId) || assetId <= 0) {
    throw new HttpError(400, 'bad_asset', 'asset_id 需为正整数（或使用 multipart 上传文件）')
  }
  const bgm = await wb(() => bindBgmFromAsset(runId, assetId))
  return c.json({ ok: true, bgm: toAssetView(bgm), note: 'BGM 已绑定（重新合成后生效）' }, 201)
}))

// DELETE /runs/:id/compose/bgm —— 移除
composeRoutes.delete('/runs/:id/compose/bgm', h(async (c) => {
  const runId = idParam(c)
  await wb(() => removeBgm(runId))
  return c.json({ ok: true, note: 'BGM 已移除（重新合成后生效）' })
}))

async function bodyJson(c: Context): Promise<Record<string, unknown>> {
  return await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  }) as Record<string, unknown>
}
