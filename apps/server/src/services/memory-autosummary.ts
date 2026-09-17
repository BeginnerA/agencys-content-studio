import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { assets, episodes, pipelineRuns, pipelineSteps, settings } from '../db/schema'
import { readTextAsset } from './storage'
import { summarizeToMemory } from './memory-summary'
import { createLogger } from '../logger'

// [M24·F1] 自动摘要钩子（双形态拍板的「可选自动」侧，spec §2.2）：
// settings key `memory.auto_summary`（JSON bool，缺省 false）→ onRunSettled listener：
//   run completed + 该 run 是某集 latestRunId + 模板未含 memory_summary 步（防双份计费）
//   → 集素材（contentAssetId 或 run 文本产物 top3）→ summarizeToMemory（与 action 共用核心）。
// fire-and-forget：任何异常 log.warn 隔离，绝不阻断 settle 链（onRunSettled listener 语义）。
// 探针面：isAutoSummaryEnabled / gatherEpisodeContext（纯 DB 门控与素材装配）+ handleRunSettled 注入假 summarizer。

const log = createLogger('memory-autosummary')

/** 开关读取（缺省/损坏 → false） */
export async function isAutoSummaryEnabled(): Promise<boolean> {
  try {
    const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'memory.auto_summary')).limit(1)
    if (!rows[0]?.value) return false
    return JSON.parse(rows[0].value) === true
  } catch {
    return false
  }
}

export interface EpisodeSummaryContext {
  projectId: number
  episodeId: number
  sourceText: string
}

/**
 * 门控 + 素材装配（零 LLM，可探针直测）：任一条件不满足 → null（跳过原因写日志）。
 * 素材 = 集 contentAssetId 文本；缺失 → 本 run 文本资产 top3（id 降序，最新产物优先）拼接。
 */
export async function gatherEpisodeContext(runId: number): Promise<EpisodeSummaryContext | null> {
  if (!(await isAutoSummaryEnabled())) return null
  const runRows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
  const run = runRows[0]
  if (!run || run.status !== 'completed') return null
  const epRows = await db.select().from(episodes).where(eq(episodes.latestRunId, runId)).limit(1)
  const ep = epRows[0]
  if (!ep) return null
  // 模板已显式编排 memory_summary → 跳过（防双份计费）
  const sumSteps = await db
    .select({ id: pipelineSteps.id })
    .from(pipelineSteps)
    .where(and(eq(pipelineSteps.runId, runId), eq(pipelineSteps.actionKey, 'memory_summary')))
    .limit(1)
  if (sumSteps.length > 0) {
    log.info(`run ${runId} 模板已含 memory_summary 步 → 自动钩子跳过`, {})
    return null
  }
  const parts: string[] = []
  if (ep.contentAssetId) {
    try {
      const text = (await readTextAsset(ep.contentAssetId)).trim()
      if (text) parts.push(text)
    } catch (err) {
      log.warn(`集 ${ep.id} contentAsset#${ep.contentAssetId} 读取失败：${(err as Error).message}`, {})
    }
  }
  if (parts.length === 0) {
    const outRows = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.runId, runId), eq(assets.kind, 'text'), isNull(assets.deletedAt)))
      .orderBy(assets.id)
      .limit(3)
    for (const r of [...outRows].reverse()) {
      try {
        const text = (await readTextAsset(r.id)).trim()
        if (text) parts.push(text)
      } catch {
        /* 单资产读取失败跳过 */
      }
    }
  }
  const sourceText = parts.join('\n\n')
  if (!sourceText) {
    log.info(`run ${runId}（集 ${ep.id}）无可摘要素材 → 跳过`, {})
    return null
  }
  return { projectId: run.projectId, episodeId: ep.id, sourceText }
}

type SummarizeFn = typeof summarizeToMemory

/** settle 处理核心（deps.summarize 注入点：探针挂假实现断言调用参数，真 LLM 走 e2e） */
export async function handleRunSettled(runId: number, deps: { summarize?: SummarizeFn } = {}): Promise<'skip' | 'done'> {
  const ctx = await gatherEpisodeContext(runId)
  if (!ctx) return 'skip'
  const summarize = deps.summarize ?? summarizeToMemory
  const res = await summarize({
    projectId: ctx.projectId,
    level: 'episode',
    episodeId: ctx.episodeId,
    sourceText: ctx.sourceText,
    runId,
    stepId: null,
  })
  log.info(`自动摘要（run ${runId} → 集 ${ctx.episodeId}）：${res.name} ${res.created ? '新建' : '更新'}（${res.chars} 字）`, {})
  return 'done'
}

/** index.ts 注册：fire-and-forget + 全异常隔离（listener 内抛错也已被 engine 捕获，这里双保险） */
export function registerAutoSummaryHook(): void {
  import('../pipeline/engine')
    .then(({ onRunSettled }) => {
      onRunSettled((runId) => {
        handleRunSettled(runId).catch((err) => log.warn(`自动摘要钩子失败（run ${runId}，不阻断）：${(err as Error).message}`, {}))
      })
    })
    .catch((err) => log.warn(`自动摘要钩子注册失败：${(err as Error).message}`, {}))
}
