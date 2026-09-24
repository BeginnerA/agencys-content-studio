import { Hono } from 'hono'
import { LlmNotConfiguredError } from '../services/llm'
import { runConsistencyEval, scoreConsistencyEval } from '../services/eval-service'
import { HttpError, h } from './helpers'

// 一致性 A/B 评测端点（spec §3）：
// - POST /eval/consistency/run  → { batch_id, run_ids, labels }（variants 2–6；模板不存在 400）
// - POST /eval/consistency/score → { matrix, aggregate, report_asset_id, ... }（LLM 未配置 400 llm_unavailable；
//   资产越项目/非图 400；LLM 输出全坏 → parse_failed 降级 raw 报告，不出假分）
export const evalRoutes = new Hono()

evalRoutes.post('/eval/consistency/run', h(async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  return c.json(await runConsistencyEval(body))
}))

evalRoutes.post('/eval/consistency/score', h(async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  try {
    return c.json(await scoreConsistencyEval(body))
  } catch (err) {
    if (err instanceof LlmNotConfiguredError) throw new HttpError(400, 'llm_unavailable', err.message)
    throw err
  }
}))
