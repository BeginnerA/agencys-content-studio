import { writeTextAsset } from '../../services/storage'
import { recallMemories } from '../../services/memory'
import type { StepContext } from '../context'
import { interpolate } from '../refs'
import { StepError, type StepResult } from '../types'

/**
 * memory_recall：按语义相似度召回记忆（spec §4.2）。
 * 输入 query：ctx.input.query 字面文本或 text 资产（可多个 → 换行拼接）；
 * params：{ limit=3, min_score=0.25, scope='both' }。
 * 产物：召回结果 markdown 资产（purpose=memory，name_tpl 默认 recall.md）；
 * 空结果 → 产出「（无相关记忆）」占位资产（始终有产物，下游引用稳定）；
 * embedding 不可用 → StepError 含 model:prepare 指引（不静默）。
 */
export async function memoryRecall(ctx: StepContext): Promise<StepResult> {
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const limit = typeof params['limit'] === 'number' && params['limit'] > 0 ? Math.floor(params['limit']) : 3
  const minScore = typeof params['min_score'] === 'number' ? params['min_score'] : 0.25
  const scope = params['scope'] === 'project' || params['scope'] === 'global' ? params['scope'] : 'both'

  const query = await collectQuery(ctx)
  if (!query) throw new StepError('记忆召回缺少 query（inputs.query 需为 text 资产或非空字面文本）')

  const hits = await recallMemories({ projectId: ctx.run.projectId, query, limit, minScore, scope }).catch((err: Error) => {
    throw new StepError(`记忆召回失败：${err.message}（若为模型缺失，先运行 pnpm --filter @acs/server model:prepare）`)
  })

  const blocks = [`# 记忆召回（${query}）`]
  hits.forEach((h, i) => {
    blocks.push(`## [${i + 1}] 相似度 ${h.score.toFixed(2)} · ${h.type}/${h.name ?? '—'} · ${fmtDate(h.updatedAt)}\n${h.content}`)
  })
  const body = hits.length === 0 ? `${blocks[0]}\n\n（无相关记忆）` : blocks.join('\n\n')

  const topScore = hits[0]?.score ?? null
  const runInput = JSON.parse(ctx.run.input) as Record<string, unknown>
  const nameTpl = typeof params['name_tpl'] === 'string' ? params['name_tpl'] : 'recall.md'
  const asset = await writeTextAsset(ctx.run.projectId, {
    name: interpolate(nameTpl, runInput),
    content: body,
    purpose: 'memory',
    stepId: ctx.step.id,
    params: { query, limit, scope, count: hits.length, topScore },
    tags: ['memory'],
  })
  ctx.log(`记忆召回 ${hits.length} 条（scope=${scope}, topScore=${topScore === null ? '—' : topScore.toFixed(3)}）→ asset#${asset.id}`)
  return { assetIds: [asset.id] }
}

/** query 解析：text 资产全文拼接（换行）优先，其次 ctx.input.query 字面文本 */
async function collectQuery(ctx: StepContext): Promise<string> {
  const ids = ctx.assetIdsOf('query')
  if (ids.length > 0) {
    const assets = await ctx.assetsOf(ids)
    const parts: string[] = []
    for (const a of assets) {
      if (a.kind !== 'text') continue
      const text = (await ctx.readText(a.id)).trim()
      if (text) parts.push(text)
    }
    return parts.join('\n\n')
  }
  const v = ctx.input['query']
  return typeof v === 'string' ? v.trim() : ''
}

function fmtDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
