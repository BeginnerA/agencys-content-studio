import { writeTextAsset } from '../../services/storage'
import { summarizeToMemory, SummaryParamError, SUMMARY_LEVELS, type SummaryLevel } from '../../services/memory-summary'
import type { StepContext } from '../context'
import { interpolate } from '../refs'
import { StepError, type StepResult } from '../types'

// memory_summary action（spec §2.2）：三层记忆摘要压缩的显式形态。
// 素材 = inputs.content（text 资产多个拼接）或 run input.content 字面文本；
// 参数取值链 params → run input（同名键），level 必需且 ∈ SUMMARY_LEVELS。
// 产物 = 记忆（type='summary' 具名 upsert 幂等）+ 记忆日志快照资产（purpose=memory_log）。

/** params → run input 取值链：params 优先，缺失回落 run input 同名键 */
function pickParam(params: Record<string, unknown>, input: Record<string, unknown>, key: string): unknown {
  if (params[key] !== undefined && params[key] !== null) return params[key]
  return input[key]
}

export async function memorySummary(ctx: StepContext): Promise<StepResult> {
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const levelRaw = pickParam(params, ctx.input, 'level')
  const level = typeof levelRaw === 'string' && (SUMMARY_LEVELS as readonly string[]).includes(levelRaw)
    ? (levelRaw as SummaryLevel)
    : null
  if (!level) throw new StepError(`memory_summary 需 params.level ∈ ${SUMMARY_LEVELS.join('|')}（当前：${JSON.stringify(levelRaw)}）`)

  const numOr = (v: unknown): number | null =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null
  const seriesId = numOr(pickParam(params, ctx.input, 'series_id'))
  const episodeId = numOr(pickParam(params, ctx.input, 'episode_id'))
  const customNameRaw = pickParam(params, ctx.input, 'name')
  const customName = typeof customNameRaw === 'string' && customNameRaw.trim() ? customNameRaw.trim() : null
  const maxCharsRaw = pickParam(params, ctx.input, 'max_chars')
  const maxChars = typeof maxCharsRaw === 'number' && maxCharsRaw > 0 ? maxCharsRaw : undefined
  const merge = pickParam(params, ctx.input, 'merge') !== false
  const promptTplRaw = pickParam(params, ctx.input, 'prompt_tpl')
  const promptTpl = typeof promptTplRaw === 'string' && promptTplRaw.trim() ? promptTplRaw.trim() : undefined

  const sourceText = await collectContent(ctx)
  if (!sourceText) throw new StepError('摘要素材为空（inputs.content 需为 text 资产或非空 input.content 文本）')

  let result: Awaited<ReturnType<typeof summarizeToMemory>>
  try {
    result = await summarizeToMemory({
      projectId: ctx.run.projectId,
      level,
      seriesId,
      episodeId,
      customName,
      sourceText,
      maxChars,
      merge,
      promptTpl,
      runId: ctx.run.id,
      stepId: ctx.step.id,
    })
  } catch (err) {
    if (err instanceof SummaryParamError) throw new StepError(err.message)
    throw new StepError(`摘要生成失败：${(err as Error).message}`)
  }
  ctx.log(`摘要沉淀 ${result.name}（${result.created ? '新建' : '更新'}，素材 ${result.sourceChars} → 摘要 ${result.chars} 字）`)

  const snapshot = {
    memoryId: result.memoryId,
    created: result.created,
    name: result.name,
    level,
    chars: result.chars,
    sourceChars: result.sourceChars,
    mergedFromChars: result.mergedFromChars,
    model: result.model,
  }
  const nameTpl = typeof params['name_tpl'] === 'string' ? params['name_tpl'] : 'memory-summary-log.md'
  const asset = await writeTextAsset(ctx.run.projectId, {
    name: interpolate(nameTpl, ctx.input),
    content: JSON.stringify(snapshot, null, 2),
    purpose: 'memory_log',
    stepId: ctx.step.id,
    params: { memoryId: result.memoryId, name: result.name, level, chars: result.chars, sourceChars: result.sourceChars },
    tags: ['memory', 'summary'],
  })
  ctx.log(`摘要日志 → asset#${asset.id}（${asset.relPath}）`)
  return { assetIds: [asset.id] }
}

/** content 解析（对齐 memory_write）：text 资产全文拼接（换行）优先，其次 ctx.input.content 字面文本 */
async function collectContent(ctx: StepContext): Promise<string> {
  const ids = ctx.assetIdsOf('content')
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
  const v = ctx.input['content']
  return typeof v === 'string' ? v.trim() : ''
}
