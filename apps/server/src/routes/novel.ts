/**
 * [M9] 小说改编链路由（spec §3.7）
 * - GET /runs/:id/novel-board —— 聚合读（切分 manifest × 事件状态 × 图谱 × 规划 × 剧本），只读零副作用
 */
import { Hono } from 'hono'
import { buildNovelBoard } from '../services/novel-board'
import { h, idParam, notFound } from './helpers'

export const novelRoutes = new Hono()

// GET /runs/:id/novel-board —— 小说改编看板聚合读（run 无 text_split 步骤 → found=false；run 不存在 → 404）
novelRoutes.get('/runs/:id/novel-board', h(async (c) => {
  const runId = idParam(c)
  const board = await buildNovelBoard(runId)
  if (!board) return notFound(c, `run ${runId}`)
  return c.json(board)
}))
