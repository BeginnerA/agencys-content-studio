import { Readable } from 'node:stream'
import { Hono } from 'hono'
import {
  cloneCapabilityOf,
  createVoiceClone,
  deleteVoiceClone,
  getVoiceClone,
  listCloneProviders,
  listVoiceClones,
  synthWithClone,
  CLONE_SAMPLE_MAX_BYTES,
} from '../services/tts-clone'
import { createLogger } from '../logger'
import { HttpError, h, idParam, notFound, wb } from './helpers'

/**
 * 平台音色库（spec §2.2 ⑧）：克隆音色列表 + 能力位矩阵、克隆创建（multipart 样本 / 公网样本地址）、
 * 删除、试听（不落资产）。密钥不落本表——端点与 Key 由 services/tts-clone 经 api_configs（Settings → 语音合成）解析。
 */

const log = createLogger('route:voice-clones')

export const voiceCloneRoutes = new Hono()

// GET /voice-clones —— 音色库 + 能力位矩阵（audio 供应商目录全量，available = 是否支持克隆）
voiceCloneRoutes.get(
  '/voice-clones',
  h(async (c) => {
    const [items, providers] = await Promise.all([listVoiceClones(), listCloneProviders()])
    return c.json({ items, providers })
  }),
)

// POST /voice-clones —— 克隆创建（multipart：name / provider / file [/ target_model / protocol / sample_url]）
// 本地样本走 Data URL 内联协议；传 sample_url 且协议为公网形态时直传地址。失败不落行（400 校验 / 502 供应商详情）
voiceCloneRoutes.post(
  '/voice-clones',
  h(async (c) => {
    const ct = c.req.header('content-type') ?? ''
    if (!ct.includes('multipart/form-data')) {
      throw new HttpError(400, 'bad_form', '需 multipart/form-data 提交（name / provider / file）')
    }
    const form = await c.req.formData().catch(() => {
      throw new HttpError(400, 'bad_form', '非 multipart/form-data 请求')
    })
    const field = (k: string): string => {
      const v = form.get(k)
      return typeof v === 'string' ? v.trim() : ''
    }
    const name = field('name')
    const providerKey = field('provider') || field('provider_key')
    if (!name) throw new HttpError(400, 'bad_name', '音色名（name）不能为空')
    if (!cloneCapabilityOf(providerKey)) {
      throw new HttpError(400, 'unsupported_provider', `供应商「${providerKey || '未指定'}」不支持声音克隆（能力位为灰即未登记协议）`)
    }
    const fileRaw = form.get('file')
    let sample: Uint8Array | null = null
    let mime: string | null = null
    if (fileRaw && typeof fileRaw !== 'string') {
      const file = fileRaw as File
      if (file.size > CLONE_SAMPLE_MAX_BYTES) {
        throw new HttpError(413, 'too_large', `样本超过 10MB 上限（${(file.size / 1024 / 1024).toFixed(1)}MB）`)
      }
      const buf = await file.arrayBuffer()
      sample = new Uint8Array(buf)
      mime = file.type || null
    }
    const sampleUrl = field('sample_url')
    if (!sample && !sampleUrl) throw new HttpError(400, 'no_file', '未收到样本（字段名 file，或公网音频地址 sample_url）')
    const res = await wb(() =>
      createVoiceClone(providerKey, {
        name,
        sample,
        mime,
        sampleUrl: sampleUrl || null,
        targetModel: field('target_model') || null,
        protocol: field('protocol') || null,
      }),
    )
    log.info(`克隆音色「${res.clone.name}」入库 #${res.clone.id}（${res.clone.providerKey}/${res.clone.model}）`)
    return c.json({ ok: true, clone: res.clone, warnings: res.warnings }, 201)
  }),
)

// DELETE /voice-clones/:id —— 移除本地登记（v1 不回调供应商删除接口）
voiceCloneRoutes.delete(
  '/voice-clones/:id',
  h(async (c) => {
    const id = idParam(c)
    const r = await wb(() => deleteVoiceClone(id))
    return c.json({ ok: true, name: r.name, note: '已从音色库移除（供应商侧音色未删除，可在供应商控制台清理；引用该音色的声线配置将降级）' })
  }),
)

// POST /voice-clones/:id/test —— 试听（≤200 字，返回 audio/mpeg 流；不落资产、不记账）
voiceCloneRoutes.post(
  '/voice-clones/:id/test',
  h(async (c) => {
    const id = idParam(c)
    const row = await getVoiceClone(id)
    if (!row) return notFound(c, `音色 ${id}`)
    const body = await c.req.json().catch(() => {
      throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
    })
    const text = (body as { text?: unknown })?.text
    const data = await wb(() => synthWithClone(row, typeof text === 'string' ? text : ''))
    const stream = Readable.toWeb(Readable.from(Buffer.from(data))) as ReadableStream
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-cache', 'X-Voice-Id': row.voiceId },
    })
  }),
)
