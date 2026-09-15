import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { assets, pipelineRuns, pipelineSteps, type Asset, type PipelineRun, type PipelineStep } from '../../db/schema'

/** 工作台领域错误（路由层转 HTTP；status 默认 400，run/step 不存在用 404） */
export class WorkbenchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
  ) {
    super(message)
    this.name = 'WorkbenchError'
  }
}

/** 工作台类步骤（分镜编辑 / 单镜重生成 / 选片） */
export const WORKBENCH_ACTIONS = ['ai_image', 'ai_video']

/** 分镜镜头（宽松形态：兼容裸数组与 {shots:[]}，与 ai-image 解析口径一致） */
export interface ShotSpec {
  id: string
  image_prompt?: string
  motion_prompt?: string
  duration?: number
  /** LLM 分镜实际口径（storyboard-ep 提示词 schema 用 duration_sec；编辑写入 duration 时同步） */
  duration_sec?: number
  /** [M11] 该镜配的台词句 id 数组（空数组 = 无台词镜；合成期音字对齐映射源，storyboard-ep v+1 产出） */
  lines?: string[]
  [k: string]: unknown
}

// ---------- 内部工具 ----------

export async function getRunOrThrow(runId: number): Promise<PipelineRun> {
  const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
  const run = rows[0]
  if (!run) throw new WorkbenchError('not_found', `run ${runId} 不存在`, 404)
  return run
}

export async function getStepOrThrow(runId: number, stepKey: string): Promise<PipelineStep> {
  const rows = await db
    .select()
    .from(pipelineSteps)
    .where(and(eq(pipelineSteps.runId, runId), eq(pipelineSteps.stepKey, stepKey)))
    .limit(1)
  const step = rows[0]
  if (!step) throw new WorkbenchError('not_found', `步骤 ${stepKey} 不存在`, 404)
  return step
}

/** [M10] output.asset_ids → 镜头选中映射（params.shotId 解析；同镜取首个命中） */
export async function selectedMapOf(step: PipelineStep): Promise<{ outIds: number[]; selected: Map<string, number> }> {
  const outIds = outputIdsOf(step)
  const selected = new Map<string, number>()
  if (outIds.length > 0) {
    const rows = await db.select().from(assets).where(inArray(assets.id, outIds))
    const byId = new Map(rows.map((a) => [a.id, a]))
    for (const id of outIds) {
      const a = byId.get(id)
      if (!a) continue
      const sid = shotIdOfAsset(a)
      if (sid && !selected.has(sid)) selected.set(sid, id)
    }
  }
  return { outIds, selected }
}

export function parseOutputJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const p = JSON.parse(raw) as unknown
    if (p && typeof p === 'object' && !Array.isArray(p)) return p as Record<string, unknown>
  } catch {
    // 容错：按空对象处理
  }
  return {}
}

export function outputIdsOf(step: PipelineStep): number[] {
  return toIdArray(parseOutputJson(step.output)['asset_ids'])
}

export function toIdArray(v: unknown): number[] {
  if (!Array.isArray(v)) return []
  return v.map(Number).filter((n) => Number.isInteger(n) && n > 0)
}

export function shotIdOfAsset(a: Asset): string | null {
  if (!a.params) return null
  try {
    const p = JSON.parse(a.params) as { shotId?: unknown }
    return typeof p.shotId === 'string' && p.shotId ? p.shotId : null
  } catch {
    return null
  }
}

export function sameIds(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
