import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../db'
import { assets, type Asset, type PipelineRun, type PipelineStep } from '../db/schema'
import { eq, inArray } from 'drizzle-orm'
import { RUN_LOGS_DIR } from '../env'
import { emitStudioEvent } from '../services/events'
import { absPathOf, readTextAsset } from '../services/storage'
import type { Template, TemplateStepDef } from './types'

export interface RunSettings {
  /** 模板 defaults 与 project.settings 合并后的参数（action 参数解析用） */
  llm?: Record<string, unknown>
  image?: Record<string, unknown>
  video?: Record<string, unknown>
}

export interface StepContext {
  run: PipelineRun
  step: PipelineStep
  template: Template
  def: TemplateStepDef
  /** 引用解析后的实际输入 */
  input: Record<string, unknown>
  /** 合并后参数（template.defaults + project.settings 同名覆盖） */
  settings: RunSettings
  /** 追加步骤日志（事件 + RUN_LOGS_DIR/{runId}.log 双写） */
  log(chunk: string): void
  /** ctx.input[key] 规整为资产 id 数组（引用解析后应为 number[]） */
  assetIdsOf(key: string): number[]
  /** 文本类资产全文（无本地文件或非文本 → 抛错） */
  readText(assetId: number): Promise<string>
  /** 任意资产绝对路径（文件缺失 → 抛错） */
  pathOf(assetId: number): Promise<string>
  /** 批量取资产行（按 id，保持入参顺序） */
  assetsOf(ids: number[]): Promise<Asset[]>
}

let seqCounter = 0

/** 组装步骤执行上下文（engine 每步执行时调用一次） */
export async function createStepContext(opts: {
  run: PipelineRun
  step: PipelineStep
  template: Template
  def: TemplateStepDef
  input: Record<string, unknown>
  projectSettings?: Record<string, unknown>
}): Promise<StepContext> {
  const { run, step, template, def, input } = opts
  const settings: RunSettings = {
    llm: { ...((template.defaults?.llm as Record<string, unknown>) ?? {}), ...((opts.projectSettings?.llm as Record<string, unknown>) ?? {}) },
    image: { ...((template.defaults?.image as Record<string, unknown>) ?? {}), ...((opts.projectSettings?.image as Record<string, unknown>) ?? {}) },
    video: { ...((template.defaults?.video as Record<string, unknown>) ?? {}), ...((opts.projectSettings?.video as Record<string, unknown>) ?? {}) },
  }

  const log = (chunk: string): void => {
    const seq = ++seqCounter
    emitStudioEvent({ type: 'step.log', runId: run.id, stepId: step.id, seq, chunk })
    appendFileSync(join(RUN_LOGS_DIR, `${run.id}.log`), `[${new Date().toISOString()}] [${def.key}] ${chunk}\n`)
  }
  const origin = (assetId: number): Promise<Asset> => assetById(run.projectId, assetId)

  return {
    run,
    step,
    template,
    def,
    input,
    settings,
    log,
    assetIdsOf(key: string): number[] {
      const v = input[key]
      if (v === undefined || v === null) return []
      if (Array.isArray(v)) {
        const ids = v.map(Number)
        return ids.filter((n) => Number.isInteger(n) && n > 0)
      }
      const n = Number(v)
      return Number.isInteger(n) && n > 0 ? [n] : []
    },
    async readText(assetId: number): Promise<string> {
      const a = await origin(assetId)
      return readTextAsset(a.id)
    },
    async pathOf(assetId: number): Promise<string> {
      const a = await origin(assetId)
      if (!a.relPath) throw new Error(`资产 ${assetId} 无本地文件`)
      return absPathOf(a.relPath)
    },
    async assetsOf(ids: number[]): Promise<Asset[]> {
      if (ids.length === 0) return []
      const rows = await db
        .select()
        .from(assets)
        .where(inArray(assets.id, ids))
      const byId = new Map(rows.map((r) => [r.id, r]))
      return ids.map((id) => byId.get(id)!).filter(Boolean)
    },
  }
}

async function assetById(projectId: number, id: number): Promise<Asset> {
  const rows = await db.select().from(assets).where(eq(assets.id, id)).limit(1)
  const a = rows[0]
  if (!a || a.projectId !== projectId) throw new Error(`资产 ${id} 不存在或不属于本项目`)
  return a
}
