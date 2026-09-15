/**
 * [M17] 创作画布打包导出（[M18] zip 流式化：内存 O(64KB)；零新依赖，fflate，spec §2.6⑫）：
 * - 打包对象：asset 节点（其资产）/ gen 节点（displayTask 产物——采纳优先）/ text 节点（.txt）；
 * - entity / run 不参与打包（manifest.skipped 记账）；软删/缺文件/无产物 → skipped 不炸；
 * - 条目命名 <seq?>-<title|node-<id>>[-<assetId>].<ext>（重名 -1/-2 递增）；manifest.json 为首条目；
 * - nodeIds 缺省 = 全画布；显式数组 = 子集（空数组 → 抛错引导省略）；排序按 seq 优先（无 seq 按 x→y→id）；
 * - [M18] 流式：manifest/文本 → ZipDeflate（压缩）；媒体 → ZipPassThrough（store，createReadStream 64KB 分块），
 *   直写临时文件 → rename 落位（zipSync 全内存 → 大画布内存峰值高已消除）；条目命名 / manifest 结构零变化（探针 unzipSync 对拍等价）；
 * - 产物落手工 exports 目录（对齐 export.ts 先例）+ registerAsset(kind:'archive', purpose:'creation_export')；
 *   下载复用既有 GET /assets/:id/file?download=1。
 */
import { createReadStream, createWriteStream, existsSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { extname, join } from 'node:path'
import { inArray } from 'drizzle-orm'
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import { db } from '../../db'
import { assets, type Asset } from '../../db/schema'
import { createLogger } from '../../logger'
import { buildCanvasDoc } from './doc'
import type { CanvasDocNode, TextSpec } from './spec'
import { absPathOf, ensureProjectDirs, registerAsset, sanitizeName } from '../storage'

const log = createLogger('creation-export')

export interface ExportStats {
  packed: number
  skipped: number
}

export interface ExportResult {
  asset: Asset
  stats: ExportStats
}

/** 画布打包导出：doc（采纳优先派生）→ 排序 → 逐节点收集（skipped 记账）→ zipSync → 落盘 + 资产登记 */
export async function exportCanvas(canvasId: number, rawNodeIds?: unknown): Promise<ExportResult | null> {
  const doc = await buildCanvasDoc(canvasId)
  if (!doc) return null
  const targets = pickTargets(doc.nodes, rawNodeIds)
  const sorted = [...targets].sort(seqThenPos)

  // 资产行批查（asset 节点自身资产 + gen 节点显示产物）
  const assetIdSet = new Set<number>()
  for (const n of sorted) {
    if ((n.kind === 'asset' || n.kind === 'gen') && n.assetId != null) assetIdSet.add(n.assetId)
  }
  const rows = assetIdSet.size > 0 ? await db.select().from(assets).where(inArray(assets.id, [...assetIdSet])) : []
  const assetById = new Map(rows.map((a) => [a.id, a]))

  const used = new Set<string>()
  // [M18] 打包条目：文本/manifest 走内存 ZipDeflate；媒体走 absPath 流式 ZipPassThrough（不整文入内存）
  type ZipItem = { name: string; data: Uint8Array } | { name: string; absPath: string }
  const items: ZipItem[] = []
  const manifestFiles: Array<Record<string, unknown>> = []
  const manifestSkipped: Array<Record<string, unknown>> = []
  const skip = (n: CanvasDocNode, reason: string): void => {
    manifestSkipped.push({ nodeId: n.id, kind: n.kind, title: n.title, seq: n.seq ?? null, reason })
  }

  for (const n of sorted) {
    if (n.kind === 'entity' || n.kind === 'run') {
      skip(n, n.kind === 'entity' ? '实体节点不参与打包' : '运行节点不参与打包')
      continue
    }
    if (n.kind === 'text') {
      const spec = n.spec as TextSpec | null
      if (!spec || typeof spec.text !== 'string') {
        skip(n, '文本节点 spec 损坏')
        continue
      }
      const name = uniqueEntryName(used, entryName(n, null, 'txt'))
      const data = new TextEncoder().encode(spec.text)
      items.push({ name, data })
      manifestFiles.push({
        nodeId: n.id,
        kind: n.kind,
        title: n.title,
        seq: n.seq ?? null,
        assetId: null,
        fileName: name,
        size: data.byteLength,
        prompt: digest(spec.text),
      })
      continue
    }
    // asset / gen：取展示资产（gen 为采纳优先产物）
    if (n.assetId == null) {
      skip(n, n.kind === 'gen' ? '暂无成功产物' : '节点未引用资产')
      continue
    }
    const a = assetById.get(n.assetId)
    if (!a || a.deletedAt != null) {
      skip(n, `资产 #${n.assetId} 已删除`)
      continue
    }
    if (!a.relPath) {
      skip(n, `资产 #${n.assetId} 无本地文件`)
      continue
    }
    const abs = absPathOf(a.relPath)
    if (!existsSync(abs)) {
      skip(n, `资产 #${n.assetId} 文件缺失`)
      continue
    }
    let size = 0
    try {
      size = statSync(abs).size
    } catch {
      skip(n, `资产 #${n.assetId} 文件读取失败`)
      continue
    }
    const ext = (a.ext ?? extname(a.relPath).slice(1)) || 'bin'
    const name = uniqueEntryName(used, entryName(n, n.assetId, ext))
    items.push({ name, absPath: abs })
    manifestFiles.push({
      nodeId: n.id,
      kind: n.kind,
      title: n.title,
      seq: n.seq ?? null,
      assetId: n.assetId,
      fileName: name,
      size,
      prompt: digest(a.prompt),
    })
  }

  const manifest = {
    version: 1,
    canvas: { id: doc.canvas.id, name: doc.canvas.name, projectId: doc.canvas.projectId },
    generatedAt: Date.now(),
    files: manifestFiles,
    skipped: manifestSkipped,
  }
  const manifestData = new TextEncoder().encode(JSON.stringify(manifest, null, 2))

  ensureProjectDirs(doc.canvas.projectId)
  const zipName = `${sanitizeName(doc.canvas.name)}-export-${Date.now()}.zip`
  const relPath = join(String(doc.canvas.projectId), 'exports', sanitizeName(zipName))
  const absFinal = absPathOf(relPath)
  const absTmp = `${absFinal}.tmp-${Date.now()}`
  try {
    await writeZipStream(absTmp, manifestData, items)
    renameSync(absTmp, absFinal)
  } catch (err) {
    try {
      if (existsSync(absTmp)) unlinkSync(absTmp)
    } catch {
      /* 清理失败不覆盖原始错误 */
    }
    throw err
  }
  const fileSize = statSync(absFinal).size
  const asset = await registerAsset(doc.canvas.projectId, {
    kind: 'archive',
    purpose: 'creation_export',
    name: zipName,
    relPath,
    mime: 'application/zip',
    ext: 'zip',
    fileSize,
    params: {
      canvasId: doc.canvas.id,
      fileCount: items.length,
      skipped: manifestSkipped.length,
    },
  })
  log.info(`画布导出包生成: ${zipName}（${items.length} 文件 / ${manifestSkipped.length} skipped, ${fileSize} bytes）`)
  return { asset, stats: { packed: items.length, skipped: manifestSkipped.length } }
}

/**
 * [M18] fflate 流式 zip 直写文件：manifest/文本条目 → ZipDeflate（压缩）；媒体条目 → ZipPassThrough（store，不压缩）。
 * 逐条目 add + push（媒体 createReadStream 分块），末尾 zip.end()；resolve = 写出总字节数；任一错误 reject（调用方清理临时文件）。
 */
function writeZipStream(absPath: string, manifestData: Uint8Array, items: Array<{ name: string; data?: Uint8Array; absPath?: string }>): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false
    const failOnce = (err: unknown): void => {
      if (settled) return
      settled = true
      reject(err instanceof Error ? err : new Error(String(err)))
    }
    const out = createWriteStream(absPath)
    out.on('error', failOnce)
    let total = 0
    const zip = new Zip((err, chunk, final) => {
      if (err) {
        failOnce(err)
        return
      }
      total += chunk.length
      out.write(Buffer.from(chunk))
      if (final) out.end(() => {
        if (settled) return
        settled = true
        resolve(total)
      })
    })
    const mEntry = new ZipDeflate('manifest.json', { level: 6 })
    zip.add(mEntry)
    mEntry.push(manifestData, true)
    void (async () => {
      for (const it of items) {
        if (it.data !== undefined) {
          const e = new ZipDeflate(it.name, { level: 6 })
          zip.add(e)
          e.push(it.data, true)
        } else {
          const e = new ZipPassThrough(it.name)
          zip.add(e)
          const rs = createReadStream(it.absPath as string)
          try {
            await new Promise<void>((res, rej) => {
              rs.on('data', (chunk) => e.push(chunk as Uint8Array, false))
              rs.on('end', () => res())
              rs.on('error', rej)
            })
            e.push(new Uint8Array(0), true)
          } finally {
            rs.close()
          }
        }
      }
      zip.end()
    })().catch(failOnce)
  })
}

/** nodeIds 选择：缺省/省略 = 全画布；显式数组 = 子集（空数组抛错；未知节点抛错；去重保序） */
function pickTargets(nodes: CanvasDocNode[], rawNodeIds: unknown): CanvasDocNode[] {
  if (rawNodeIds === undefined || rawNodeIds === null) return nodes
  if (!Array.isArray(rawNodeIds)) throw new Error('nodeIds 需为正整数数组')
  if (rawNodeIds.length === 0) throw new Error('nodeIds 为空数组（如需全量请省略该字段）')
  const ids = [...new Set(rawNodeIds.map(Number))]
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error('nodeIds 需为正整数数组')
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const id of ids) {
    if (!byId.has(id)) throw new Error(`节点 #${id} 不存在或不属于该画布`)
  }
  return ids.map((id) => byId.get(id)!)
}

/** 导出排序：seq 优先（升序），无 seq 按 x → y → id（与 arrange/chain 同口径） */
function seqThenPos(a: CanvasDocNode, b: CanvasDocNode): number {
  if (a.seq != null && b.seq != null && a.seq !== b.seq) return a.seq - b.seq
  if (a.seq != null && b.seq == null) return -1
  if (a.seq == null && b.seq != null) return 1
  return a.x - b.x || a.y - b.y || a.id - b.id
}

/** 条目名：<seq?>-<title|node-<id>>[-<assetId>].<ext>（title 走 sanitizeName） */
function entryName(n: CanvasDocNode, assetId: number | null, ext: string): string {
  const parts: string[] = []
  if (n.seq != null) parts.push(String(n.seq))
  parts.push(sanitizeName(n.title?.trim() ? n.title : `node-${n.id}`))
  if (assetId != null) parts.push(String(assetId))
  return `${parts.join('-')}.${ext}`
}

/** 重名递增：-1 / -2 …（对齐 export.ts 先例） */
function uniqueEntryName(used: Set<string>, name: string): string {
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let i = 1
  let candidate = `${stem}-${i}${ext}`
  while (used.has(candidate)) {
    i += 1
    candidate = `${stem}-${i}${ext}`
  }
  used.add(candidate)
  return candidate
}

/** 摘要（manifest 用）：trim 后截断 100 字符；空 → null */
function digest(s: string | null | undefined, max = 100): string | null {
  const t = (s ?? '').trim()
  if (!t) return null
  return t.length > max ? t.slice(0, max) : t
}
