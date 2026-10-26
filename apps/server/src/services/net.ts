import { readFileSync, writeFileSync } from 'node:fs'
import { absPathOf, ensureProjectDirs, registerAsset, relPathOf, sha256Hex } from './storage'
import { labelGeneratedFile } from './compliance-label'
import type { Asset } from '../db/schema'

/** base64 产物 mime → 落盘扩展名（未收录回退：video/* → mp4，其余 png） */
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

/** 下载远程文件（图片/视频产物）为 Buffer；超时兜底 */
export async function fetchBuffer(url: string, timeoutMs = 120_000): Promise<Uint8Array> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url.slice(0, 200)}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength === 0) throw new Error(`下载内容为空: ${url.slice(0, 200)}`)
    return buf
  } finally {
    clearTimeout(timer)
  }
}

/** 从 url/base64 落盘为图片/视频资产并登记（生成任务与 action 共用） */
export async function saveGeneratedMedia(opts: {
  projectId: number
  stepId?: number
  taskId?: number
  runId?: number | null
  kind: 'image' | 'video'
  purpose: string
  prompt: string
  params: Record<string, unknown>
  source: { kind: 'url'; url: string } | { kind: 'base64'; data: string; mime: string }
  width?: number
  height?: number
  duration?: number
}): Promise<Asset> {
  ensureProjectDirs(opts.projectId)
  let data: Uint8Array
  let ext: string
  let mime: string
  if (opts.source.kind === 'url') {
    data = await fetchBuffer(opts.source.url)
    mime = opts.source.url.split('?')[0]!.match(/\.(png|jpe?g|webp|gif|mp4|webm)$/i)?.[0] ?? ''
    ext = (mime.toLowerCase() || 'png').replace('.', '')
  } else {
    data = Buffer.from(opts.source.data, 'base64')
    mime = opts.source.mime
    ext = MIME_TO_EXT[opts.source.mime] ?? (opts.source.mime.startsWith('video/') ? 'mp4' : 'png')
  }
  if (ext === '') ext = opts.kind === 'video' ? 'mp4' : 'png'
  const fileName = `${Date.now()}-gen-${ext}.${ext}`
  const relPath = relPathOf(opts.projectId, opts.purpose, fileName)
  writeFileSync(absPathOf(relPath), data)
  // M66 隐式标识：AI 生成媒体恒打标（不可关）；失败旁路 warn + tags 标记（不阻断登记）
  const abs = absPathOf(relPath)
  const label = await labelGeneratedFile(abs, ext)
  const labeledBuf = readFileSync(abs)
  // ok 且拿到 produceId 才写 aigc 留痕；其余（打标失败/载体不支持）→ tags 标记 compliance_failed
  const aigc = label.ok && label.produceId ? { produceId: label.produceId, produceAt: Date.now() } : null
  return registerAsset(opts.projectId, {
    stepId: opts.stepId,
    taskId: opts.taskId,
    runId: opts.runId,
    kind: opts.kind,
    purpose: opts.purpose,
    relPath,
    name: fileName,
    mime,
    ext,
    fileSize: labeledBuf.byteLength,
    width: opts.width,
    height: opts.height,
    duration: opts.duration,
    sha256: sha256Hex(labeledBuf),
    prompt: opts.prompt,
    params: aigc ? { ...opts.params, aigc } : opts.params,
    tags: aigc ? ['aigc'] : ['aigc', 'compliance_failed'],
  })
}
