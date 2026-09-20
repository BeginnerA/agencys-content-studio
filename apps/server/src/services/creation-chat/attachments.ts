import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { and, eq, inArray, isNull, like } from 'drizzle-orm'
import { db } from '../../db'
import { assets, type Asset, creationMessages } from '../../db/schema'
import { absPathOf, importFiles, kindByExt, sha256Hex } from '../storage'
import { CreationError, refSchema, type CreationRef, type CreationRefRole } from './contract'
import { sessionRow } from './store'

// [M31] 对话式参考输入：附件上传（复用 imports 落盘链，落到会话所属项目）与规划前核验。
// [M31+] 增加「从素材选取」：既有资产登记为参考（跨项目按字节复制进会话项目，sha256 去重）。
// 零新表零新列：附件引用以 payload{kind:'attachment',...} 记在 creation_messages，采纳的 refs 编译进方案。
// 红线：不计费、不触发规划；类型/大小/归属/内容核验不符一律 CreationError 拒绝，绝不静默忽略。

const IMAGE_MAX = 20 * 1024 * 1024
const VIDEO_MAX = 512 * 1024 * 1024
const AUDIO_MAX = 100 * 1024 * 1024
const MAX_REFS = 12

const ROLE_BY_KIND: Record<string, CreationRefRole> = { image: 'style', video: 'content', audio: 'bgm' }
const VALID_ROLES: Record<string, CreationRefRole[]> = {
  image: ['style', 'first_frame', 'subject'],
  video: ['content'],
  audio: ['bgm'],
}

export interface AttachmentInput {
  name: string
  data: Uint8Array
}

/** 附件登记返回体（upload 与 from-asset 两端点共用形状，前端 CreationAttachmentResult 对齐） */
export interface AttachmentResult {
  assetId: number
  kind: CreationRef['kind']
  role: CreationRefRole
  hash: string
  name: string
  thumbUrl: string | null
}

function thumbUrlFor(kind: string, assetId: number): string | null {
  return kind === 'image' || kind === 'video' ? `/api/v1/assets/${assetId}/thumb?v=2` : null
}

function sizeCap(kind: string): { max: number; label: string } {
  if (kind === 'image') return { max: IMAGE_MAX, label: '图片' }
  if (kind === 'video') return { max: VIDEO_MAX, label: '视频' }
  if (kind === 'audio') return { max: AUDIO_MAX, label: '音频' }
  return { max: 0, label: kind }
}

/** 落一个附件资产到会话项目并记 attachment 消息（不规划、不计费）。 */
export async function addAttachment(
  sessionId: number,
  file: AttachmentInput,
  requestedRole?: string,
): Promise<{ assetId: number; kind: CreationRef['kind']; role: CreationRefRole; hash: string; name: string; thumbUrl: string | null }> {
  const session = await sessionRow(sessionId)
  const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data)
  if (data.byteLength === 0) throw new CreationError('empty_file', '上传文件为空', 400)
  const kind = kindByExt(extname(file.name))
  if (kind !== 'image' && kind !== 'video' && kind !== 'audio') {
    throw new CreationError('bad_kind', '参考仅支持图片 / 视频 / 音频文件', 422)
  }
  const { max, label } = sizeCap(kind)
  if (data.byteLength > max) {
    throw new CreationError('too_large', `${label}参考超过 ${Math.floor(max / 1024 / 1024)}MB 上限`, 422)
  }
  const valid = VALID_ROLES[kind] ?? []
  const role: CreationRefRole = requestedRole && requestedRole !== '' ? (requestedRole as CreationRefRole) : ROLE_BY_KIND[kind] ?? 'style'
  if (!valid.includes(role)) throw new CreationError('bad_role', `${label}参考不支持该用途（可选：${valid.join(' / ')}）`, 422)

  const [asset] = await importFiles(session.projectId, [{ name: file.name, data: new Uint8Array(data) }], { purpose: 'source' })
  const hash = asset!.sha256 ?? sha256Hex(data)
  return registerAttachment(sessionId, asset!, kind, role, hash)
}

/** 把会话项目内的资产登记为参考：同资产已有 attachment 消息则原地更新 payload，否则插入新行（不规划、不计费）。
 *  否则对话流出现多条同图卡片，且 resolveAttachmentRefs 按 assetId 后写覆盖，旧条目沦为幽灵记录。 */
async function registerAttachment(
  sessionId: number,
  asset: Asset,
  kind: CreationRef['kind'],
  role: CreationRefRole,
  hash: string,
): Promise<AttachmentResult> {
  const ref = refSchema.parse({ assetId: asset.id, kind, role, hash })
  const now = Date.now()
  const payload = JSON.stringify({ kind: 'attachment', assetId: asset.id, ref })
  const existing = await db
    .select({ id: creationMessages.id, payload: creationMessages.payload })
    .from(creationMessages)
    .where(and(eq(creationMessages.sessionId, sessionId), like(creationMessages.content, '已上传参考素材：%')))
  const dup = existing.find((m) => {
    try {
      const p = JSON.parse(m.payload ?? '') as { kind?: string; assetId?: number }
      return p.kind === 'attachment' && p.assetId === asset.id
    } catch {
      return false
    }
  })
  if (dup) {
    await db.update(creationMessages).set({ payload }).where(eq(creationMessages.id, dup.id))
  } else {
    await db.insert(creationMessages).values({
      sessionId,
      role: 'user',
      content: `已上传参考素材：${asset.name}`,
      payload,
      requestKey: `att_${asset.id}_${now}`,
      createdAt: now,
    })
  }
  return { assetId: asset.id, kind, role, hash, name: asset.name, thumbUrl: thumbUrlFor(kind, asset.id) }
}

/** [M31+] 从素材库存量资产登记为参考：kind/大小/用途规则与上传完全一致（服务端权威拒绝）。
 *  跨项目自动按字节复制进会话项目（importFiles sha256 去重，重复选取不产生新文件）；
 *  规划前核验仍由 resolveAttachmentRefs 把守归属，故复制是必要且充分的前置步骤。 */
export async function addAttachmentFromAsset(
  sessionId: number,
  assetId: number,
  requestedRole?: string,
): Promise<AttachmentResult> {
  const session = await sessionRow(sessionId)
  if (!Number.isInteger(assetId) || assetId <= 0) throw new CreationError('bad_asset', '素材编号非法', 400)
  const found = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), isNull(assets.deletedAt)))
    .limit(1)
  const src = found[0]
  if (!src) throw new CreationError('asset_not_found', '所选素材不存在或已删除', 404)
  const kind = src.kind
  if (kind !== 'image' && kind !== 'video' && kind !== 'audio') {
    throw new CreationError('bad_kind', '参考仅支持图片 / 视频 / 音频素材', 422)
  }
  if (!src.relPath) throw new CreationError('no_file', '该素材无本地文件，无法作为参考', 422)
  const { max, label } = sizeCap(kind)
  const valid = VALID_ROLES[kind] ?? []
  const role: CreationRefRole = requestedRole && requestedRole !== '' ? (requestedRole as CreationRefRole) : ROLE_BY_KIND[kind] ?? 'style'
  if (!valid.includes(role)) throw new CreationError('bad_role', `${label}参考不支持该用途（可选：${valid.join(' / ')}）`, 422)

  const abs = absPathOf(src.relPath)
  let size: number
  try {
    size = statSync(abs).size
  } catch {
    throw new CreationError('no_file', `素材文件缺失，无法引用：${src.name}`, 422)
  }
  if (size === 0) throw new CreationError('empty_file', '素材文件为空', 400)
  if (size > max) {
    throw new CreationError('too_large', `${label}参考超过 ${Math.floor(max / 1024 / 1024)}MB 上限`, 422)
  }

  let target: Asset = src
  if (src.projectId !== session.projectId) {
    const data = readFileSync(abs)
    const copied = await importFiles(session.projectId, [{ name: src.name, data: new Uint8Array(data) }], { purpose: 'source' })
    const dest = copied[0]
    if (!dest) throw new CreationError('attach_failed', '素材复制进会话项目失败，请重试', 503)
    target = dest
  }
  const hash = target.sha256 ?? src.sha256
  if (!hash) throw new CreationError('ref_no_hash', '参考素材缺少内容摘要，无法冻结', 422)
  return registerAttachment(sessionId, target, kind, role, hash)
}

/** 规划前核验：逐个确认附件资产属于本会话项目、未软删、kind 与 role 匹配，返回可编译进方案的 refs。
 *  任一不符 CreationError 拒绝（不静默忽略）；跨项目引用与影子附件（未登记于本项目）一并拒绝。 */
export async function resolveAttachmentRefs(sessionId: number, projectId: number, assetIds: number[]): Promise<CreationRef[]> {
  const unique = [...new Set(assetIds)]
  if (unique.length > MAX_REFS) throw new CreationError('too_many_refs', `参考素材最多 ${MAX_REFS} 个`, 422)
  if (unique.length === 0) return []
  // 附件登记（role 来源）：本会话消息中 payload.kind='attachment' 的 {assetId → ref}
  const attached = await db.select().from(creationMessages).where(eq(creationMessages.sessionId, sessionId))
  const recorded = new Map<number, CreationRef>()
  for (const m of attached) {
    if (!m.payload) continue
    try {
      const p = JSON.parse(m.payload) as { kind?: string; ref?: CreationRef }
      if (p.kind === 'attachment' && p.ref) recorded.set(p.ref.assetId, p.ref)
    } catch { /* 非 JSON payload 忽略 */ }
  }
  const rows = await db.select().from(assets).where(and(inArray(assets.id, unique), eq(assets.projectId, projectId), isNull(assets.deletedAt)))
  const byId = new Map(rows.map((a) => [a.id, a]))
  const refs: CreationRef[] = []
  for (const assetId of unique) {
    const a = byId.get(assetId)
    if (!a) throw new CreationError('ref_not_found', `参考素材 #${assetId} 不存在、已删除或不属于本会话项目`, 422)
    if (a.kind !== 'image' && a.kind !== 'video' && a.kind !== 'audio') throw new CreationError('ref_bad_kind', '参考素材类型非法', 422)
    const rec = recorded.get(assetId)
    const role = rec?.role ?? ROLE_BY_KIND[a.kind] ?? 'style'
    if (!(VALID_ROLES[a.kind] ?? []).includes(role)) throw new CreationError('ref_role_mismatch', '参考素材用途与类型不匹配', 422)
    const hash = rec?.hash ?? a.sha256
    if (!hash) throw new CreationError('ref_no_hash', '参考素材缺少内容摘要，无法冻结', 422)
    refs.push(refSchema.parse({ assetId, kind: a.kind, role, hash }))
  }
  return refs
}
