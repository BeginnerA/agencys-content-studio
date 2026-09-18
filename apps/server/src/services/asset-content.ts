/**
 * [M25·G2] 文本资产内容覆写服务（spec §2.3）：章节/事件/图谱等中间产物可编辑的底层通道。
 * 安全纪律：kind=text + purpose 白名单 + 尺寸上限；JSON 格式资产（ext=json）保存前
 * 走 validateTextOutput 既有契约校验（防手改炸下游 batch 解析）；同 relPath
 * tmp+rename 原子覆盖（断电不出现半截文件）；sha256/fileSize 同步更新；
 * params.content_edits={count,lastAt} 人工修订留痕（零新列红线）。
 */
import { randomBytes } from 'node:crypto'
import { renameSync, writeFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { assets, type Asset } from '../db/schema'
import { validateTextOutput } from '../pipeline/actions/ai-text'
import { absPathOf, sha256Hex } from './storage'
import { ensureAssetTextBaseline, recordAssetTextVersion } from './provenance'

/** 内容可覆写的 purpose 白名单（spec §2.3；source/compliance_report 等不在列 → 拒） */
export const EDITABLE_PURPOSES = ['source', 'chapters', 'events', 'graph', 'plan', 'script', 'text', 'export', 'video_analysis'] as const

/** 单资产内容上限（2M 字符；长章 3 万字余量充足，同时兜住误粘超大文本） */
export const MAX_CONTENT_CHARS = 2_000_000

export class ContentEditError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ContentEditError'
  }
}

/** JSON 资产格式名推断：validateTextOutput 按七种契约格式校验，未知格式返 0 即放行 */
function jsonFormatOf(asset: Pick<Asset, 'params'>): string {
  try {
    const p = JSON.parse(asset.params ?? '{}') as Record<string, unknown>
    return typeof p.output_format === 'string' ? p.output_format : ''
  } catch {
    return ''
  }
}

/**
 * 覆写文本资产内容（返回更新后的行）。守卫顺序：存在 → kind=text → relPath →
 * purpose 白名单 → 非空尺寸 → JSON 契约 → 原子落盘 → 行更新。
 * [M29·R02] 版本链：编辑前懒补 baseline（保护原文可回看），落盘后记新不可变版本；
 * opts.expectedRevision 提供乐观并发（缺省保留 last-write-wins 向后兼容；不匹配抛 conflict）；
 * 编辑成功后清空 embedding（标记待重建，避免旧向量与正文不一致）。任何守卫不通过抛 ContentEditError。
 */
export async function updateAssetContent(
  assetId: number,
  content: string,
  opts: { expectedRevision?: number } = {},
): Promise<Asset> {
  const rows = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1)
  const a = rows[0]
  if (!a) throw new ContentEditError('not_found', `资产 ${assetId} 不存在`)
  if (a.kind !== 'text') throw new ContentEditError('bad_kind', `仅文本资产可编辑内容（当前 kind=${a.kind}）`)
  if (!a.relPath) throw new ContentEditError('no_file', `资产 ${a.id} 无本地文件`)
  if (!(a.purpose && (EDITABLE_PURPOSES as readonly string[]).includes(a.purpose))) {
    throw new ContentEditError('bad_purpose', `purpose=${a.purpose ?? '(空)'} 不在可编辑白名单内`)
  }
  if (!content.trim()) throw new ContentEditError('empty_content', '内容不能为空')
  if (content.length > MAX_CONTENT_CHARS) {
    throw new ContentEditError('too_large', `内容 ${content.length} 字符超过上限 ${MAX_CONTENT_CHARS}`)
  }
  if (a.ext === 'json') {
    const format = jsonFormatOf(a)
    try {
      validateTextOutput(content, format)
    } catch (err) {
      throw new ContentEditError('bad_json', `JSON 契约校验不通过（format=${format || '未知'}）：${(err as Error).message}`)
    }
  }
  // [M29] 编辑前确保原文已入版本链（baseline 懒补）；随后当前版本 = 工作副本内容的版本
  const currentRev = await ensureAssetTextBaseline(assetId)
  if (opts.expectedRevision !== undefined && opts.expectedRevision !== currentRev) {
    throw new ContentEditError('conflict', `内容已被他人更新至 v${currentRev}（你基于 v${opts.expectedRevision}），请刷新后重试`)
  }
  const data = new TextEncoder().encode(content)
  const abs = absPathOf(a.relPath)
  const tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, abs)
  // 编辑留痕并入原 params（params 非 JSON 对象时重建，原件不留痕优先保住保存）
  let params: Record<string, unknown> = {}
  try {
    const p = JSON.parse(a.params ?? '{}') as unknown
    if (p && typeof p === 'object' && !Array.isArray(p)) params = p as Record<string, unknown>
  } catch {
    /* 容忍脏 params */
  }
  const prev = params.content_edits
  const count = typeof (prev as Record<string, unknown> | undefined)?.count === 'number' ? ((prev as { count: number }).count ?? 0) : 0
  params.content_edits = { count: count + 1, lastAt: Date.now() }
  const now = Date.now()
  const updated = await db
    .update(assets)
    .set({
      fileSize: data.byteLength,
      sha256: sha256Hex(data),
      params: JSON.stringify(params),
      embedding: null,
      embeddingModel: null,
      updatedAt: now,
    })
    .where(eq(assets.id, assetId))
    .returning()
  const asset = updated[0]!
  // [M29] 落新不可变版本（工作副本内容快照；source=edit）
  await recordAssetTextVersion({ asset, content, source: 'edit' })
  return asset
}
