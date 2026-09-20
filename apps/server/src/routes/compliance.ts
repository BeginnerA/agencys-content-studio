import { Hono } from 'hono'
import { rulesView } from '../services/compliance'
import { suggestRules, appendRules } from '../services/compliance-suggest'
import { HttpError, h } from './helpers'

// [M24·F5] 合规词库只读视图（spec §3 端点 3）：GET /compliance/rules → { total, byCategory, source }
// [M36·G12.2] 词库文件缺失 → source:'builtin'（内置《广告法》基准地板兜底，不 500、不返空）。
// [M36·G12.3] 新增：GET /compliance/suggest（Tier B 内容补充建议，零新计费）+ POST /compliance/rules（采纳追加进词库）。
export const complianceRoutes = new Hono()

complianceRoutes.get('/compliance/rules', h(async (c) => c.json(rulesView())))

// GET /compliance/suggest?project_id= —— 从既有复审结论聚合候选新词（缺省 project_id → 全域）
complianceRoutes.get('/compliance/suggest', h(async (c) => {
  const pid = c.req.query('project_id')
  const items = await suggestRules(pid ? Number(pid) : null)
  return c.json({ items })
}))

// POST /compliance/rules —— 采纳建议：把规则追加进 words.txt（去重、追加不覆盖、自动建文件）
complianceRoutes.post('/compliance/rules', h(async (c) => {
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  const rules = body['rules']
  if (!Array.isArray(rules) || rules.length === 0) throw new HttpError(400, 'bad_rules', 'rules 需为非空数组')
  const result = await appendRules(rules as Array<{ category: string; word: string; level: string }>)
  return c.json(result)
}))
