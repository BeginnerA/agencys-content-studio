import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { assets, genTasks, pipelineRuns, pipelineSteps, type Asset, type PipelineStep } from '../db/schema'
import { readTextAsset } from './storage'

/**
 * [M9] 小说改编链聚合读（只读零副作用）：
 * 按产物 purpose 归类（不依赖步骤 key 命名）——text_split 步骤 → manifest + 逐章；
 * ai_text 步骤产物 purpose=events/graph/plan/script 分别归位；
 * 章节 × 事件状态由 extract_events 步骤的 gen_tasks.params.itemId ↔ task.status 映射。
 */

export interface NovelBoardChapter {
  index: number
  title: string
  reel: string | null
  name: string
  asset_id: number
  chars: number
  /** 事件提取任务状态（pending/processing/succeeded/failed/cancelled；无任务 → null） */
  event_status: string | null
}

export interface NovelBoard {
  run_id: number
  /** run 内存在 text_split 步骤 */
  found: boolean
  step: { key: string; status: string } | null
  split: { manifest: unknown; chapters: NovelBoardChapter[] } | null
  graph: { asset_id: number; name: string; doc: unknown } | null
  plan: { asset_id: number; name: string; doc: unknown } | null
  scripts: Array<{ asset_id: number; name: string; ep: number | null }>
  events: { total: number; done: number; failed: number } | null
}

interface ManifestChapterDoc {
  index?: unknown
  reel?: unknown
  title?: unknown
  name?: unknown
  asset_id?: unknown
  chars?: unknown
}

export async function buildNovelBoard(runId: number): Promise<NovelBoard | null> {
  const runRows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
  if (!runRows[0]) return null
  const steps = await db
    .select()
    .from(pipelineSteps)
    .where(eq(pipelineSteps.runId, runId))
    .orderBy(asc(pipelineSteps.seq))

  const board: NovelBoard = {
    run_id: runId,
    found: false,
    step: null,
    split: null,
    graph: null,
    plan: null,
    scripts: [],
    events: null,
  }
  const splitStep = steps.find((s) => s.actionKey === 'text_split')
  if (!splitStep) return board
  board.found = true
  board.step = { key: splitStep.stepKey, status: splitStep.status }

  // —— 章节切分产物（manifest 第一 + 逐章） ——
  let manifestDoc: { chapters?: ManifestChapterDoc[] } | null = null
  const splitAssetIds = parseAssetIds(splitStep.output)
  if (splitAssetIds.length > 0) {
    try {
      manifestDoc = JSON.parse(await readTextAsset(splitAssetIds[0]!)) as { chapters?: ManifestChapterDoc[] }
    } catch {
      manifestDoc = null // 产物缺失/损坏 → split 保持 null（UI 显示切分进行中/异常）
    }
  }

  // —— ai_text 步骤按产物 purpose 归类 ——
  let eventsStep: PipelineStep | null = null
  let adaptStep: PipelineStep | null = null
  for (const s of steps.filter((x) => x.actionKey === 'ai_text')) {
    const rows = await orderedAssetRows(s)
    const purpose = rows[0]?.purpose ?? null
    if (purpose === 'events' && !eventsStep) eventsStep = s
    if (purpose === 'graph' && !board.graph) board.graph = await docOf(rows[0]!)
    if (purpose === 'plan' && !board.plan) board.plan = await docOf(rows[0]!)
    if (purpose === 'script') {
      adaptStep = s
      for (const r of rows.filter((x) => x.purpose === 'script')) {
        board.scripts.push({ asset_id: r.id, name: r.name, ep: null })
      }
    }
  }

  // —— 章节 × 事件状态 ——
  const eventStatusByItem = new Map<string, string>()
  if (eventsStep) {
    const tasks = await db
      .select()
      .from(genTasks)
      .where(and(eq(genTasks.runId, runId), eq(genTasks.stepId, eventsStep.id)))
    for (const t of tasks) {
      const itemId = itemIdOfTask(t.params)
      if (itemId !== null) eventStatusByItem.set(itemId, t.status)
    }
    board.events = {
      total: tasks.length,
      done: tasks.filter((t) => t.status === 'succeeded').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
    }
  }
  if (manifestDoc && Array.isArray(manifestDoc.chapters)) {
    const chapters: NovelBoardChapter[] = manifestDoc.chapters.map((ch) => {
      const index = typeof ch.index === 'number' ? ch.index : 0
      return {
        index,
        title: typeof ch.title === 'string' ? ch.title : '',
        reel: typeof ch.reel === 'string' ? ch.reel : null,
        name: typeof ch.name === 'string' ? ch.name : '',
        asset_id: typeof ch.asset_id === 'number' ? ch.asset_id : 0,
        chars: typeof ch.chars === 'number' ? ch.chars : 0,
        event_status: eventStatusByItem.get(String(index)) ?? null,
      }
    })
    board.split = { manifest: manifestDoc, chapters }
  }

  // —— 剧本集号（gen_tasks.params.itemId → ep） ——
  if (adaptStep) {
    const tasks = await db
      .select()
      .from(genTasks)
      .where(and(eq(genTasks.runId, runId), eq(genTasks.stepId, adaptStep.id)))
    const epByAsset = new Map<number, number>()
    for (const t of tasks) {
      if (typeof t.resultAssetId !== 'number') continue
      const ep = Number(itemIdOfTask(t.params))
      if (Number.isInteger(ep)) epByAsset.set(t.resultAssetId, ep)
    }
    for (const sc of board.scripts) sc.ep = epByAsset.get(sc.asset_id) ?? null
    board.scripts.sort((a, b) => (a.ep ?? 9999) - (b.ep ?? 9999))
  }

  return board
}

/** 步骤产物资产行（按 output.asset_ids 顺序） */
async function orderedAssetRows(step: PipelineStep): Promise<Asset[]> {
  const ids = parseAssetIds(step.output)
  if (ids.length === 0) return []
  const rows = await db.select().from(assets).where(inArray(assets.id, ids))
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids.map((id) => byId.get(id)!).filter(Boolean)
}

/** 单资产 → { asset_id, name, doc }（JSON 解析失败 → doc=null，不使整体失败） */
async function docOf(a: Asset): Promise<{ asset_id: number; name: string; doc: unknown }> {
  try {
    return { asset_id: a.id, name: a.name, doc: JSON.parse(await readTextAsset(a.id)) as unknown }
  } catch {
    return { asset_id: a.id, name: a.name, doc: null }
  }
}

/** pipeline_steps.output（StepOutputDoc）→ asset_ids */
function parseAssetIds(output: string | null): number[] {
  if (!output) return []
  try {
    const doc = JSON.parse(output) as { asset_ids?: unknown }
    if (!Array.isArray(doc.asset_ids)) return []
    return doc.asset_ids.filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
  } catch {
    return []
  }
}

/** gen_tasks.params → itemId（M9 batch 任务；无 → null） */
function itemIdOfTask(params: string): string | null {
  try {
    const p = JSON.parse(params) as { itemId?: unknown }
    return p.itemId !== undefined && p.itemId !== null ? String(p.itemId) : null
  } catch {
    return null
  }
}
