import { Hono } from 'hono'
import { rulesView } from '../services/compliance'
import { h } from './helpers'

// [M24·F5] 合规词库只读视图（spec §3 端点 3）：GET /compliance/rules → { total, byCategory, source }
// 词库文件缺失 → total:0 + source:'missing'（不 500）；供诊断页/前端展示，编辑仍走数据文件手工维护（spec §8）
export const complianceRoutes = new Hono()

complianceRoutes.get('/compliance/rules', h(async (c) => c.json(rulesView())))
