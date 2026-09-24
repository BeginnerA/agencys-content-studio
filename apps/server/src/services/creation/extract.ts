// 自 services/creation.ts 拆分：文本提取（gen prompt / 文本资产 → 新 text 节点）。
import { readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { assets, canvasNodes } from '../../db/schema'
import type { CanvasNode } from '../../db/schema'
import { absPathOf } from '../storage'
import { findNode, parsePos } from './nodes'
import { safeParseSpec } from './spec'

// ---------- 文本提取 ----------

/** 提取文本节点：源 = gen（spec.prompt）或文本资产节点（读资产全文）→ 新建 text 节点（默认源右侧偏移） */
export async function extractTextNode(nodeId: number, x?: unknown, y?: unknown): Promise<CanvasNode | null> {
  const src = await findNode(nodeId)
  if (!src) return null
  let text: string
  if (src.kind === 'gen') {
    const parsed = safeParseSpec(src.spec)
    if (!parsed.spec) throw new Error(`源节点 spec 损坏：${parsed.error}`)
    text = parsed.spec.prompt
  } else if (src.kind === 'asset') {
    const rows = src.assetId != null ? await db.select().from(assets).where(eq(assets.id, src.assetId)).limit(1) : []
    const a = rows[0]
    if (!a) throw new Error('源素材不存在')
    if (a.kind !== 'text') throw new Error('仅文本资产可提取（或从生成节点提取 prompt）')
    if (!a.relPath) throw new Error('文本资产缺少文件路径')
    try {
      text = readFileSync(absPathOf(a.relPath), 'utf8').slice(0, 20000)
    } catch {
      throw new Error('文本资产文件读取失败')
    }
  } else {
    throw new Error('仅生成节点或文本资产节点可提取文本')
  }
  const pos = parsePos(x === undefined ? src.x + 260 : x, y === undefined ? src.y : y)
  const now = Date.now()
  const [row] = await db
    .insert(canvasNodes)
    .values({
      canvasId: src.canvasId,
      kind: 'text',
      spec: JSON.stringify({ text: text.trim() }),
      x: pos.x,
      y: pos.y,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  return row ?? null
}
