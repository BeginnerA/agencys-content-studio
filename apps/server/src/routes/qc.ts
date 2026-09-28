import { Hono } from 'hono'
import { h, idParam } from './helpers'
import { readQcCache, runQcCheck } from '../services/qc/report'

/**
 * 第四期 · 统一 QC 面板 · 只读核验 API（规格 2026-09-28 §5/§6/§7）。
 * 仅读取成片 + 本地 ffprobe/ffmpeg 测量 + 台账一致性 → 汇总报告；零付费、零模型、不写业务表
 * （除缓存进 assets.params.qc），不改 delivery_checked / 批准链。
 */
export const qcRoutes = new Hono()

// GET /runs/:id/qc?refresh=0 —— 成片质量核验报告。
// 缺省按需重算并刷新缓存；`refresh=0` 优先命中缓存（做新鲜度判定，hash 变则相关结论标 stale）并标 fromCache。
qcRoutes.get(
  '/runs/:id/qc',
  h(async (c) => {
    const runId = idParam(c)
    const wantRefresh = c.req.query('refresh') !== '0'
    if (!wantRefresh) {
      const cached = await readQcCache(runId)
      if (cached) return c.json(cached)
    }
    const res = await runQcCheck(runId)
    if (res.outcome === 'blocked') {
      // 门禁不足（run 不存在 / 无成片）按 404 语义，no_final_video 与 not_found 分列，供前端区分文案
      const code = res.code === 'run_not_found' ? 'not_found' : res.code
      return c.json({ error: { code, message: res.message } }, 404)
    }
    return c.json(res.report)
  }),
)
