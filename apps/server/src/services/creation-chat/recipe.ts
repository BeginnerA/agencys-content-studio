import { z } from 'zod'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { assets, projects, creationSessions, type PipelineRun } from '../../db/schema'
import { loadTemplate } from '../../pipeline/loader'
import { resolveEndpoint, type EndpointPin } from '../../adapters/provider'
import { readTextAsset } from '../storage'
import { creationPlanSchema, hashJson } from './contract'
import type { RunSettings } from '../../pipeline/context'

export const endpointSnapshotSchema = z.object({
  configId: z.number().int().positive(), configHash: z.string().length(64),
  provider: z.string(), model: z.string().min(1),
  unitPrice: z.number().nonnegative().nullable(),
}).strict()
export type EndpointSnapshot = z.infer<typeof endpointSnapshotSchema>
export const recipeSchema = z.object({
  sessionId: z.number().int().positive(),
  plan: creationPlanSchema,
  endpoints: z.object({ image: endpointSnapshotSchema.optional(), video: endpointSnapshotSchema.optional(), audio: endpointSnapshotSchema }),
  videoMode: z.enum(['i2v', 't2v', 'none']),
  requestDurations: z.record(z.string(), z.number().positive()),
  voice: z.string().min(1), imageSize: z.string(), resolution: z.string(),
  templateHash: z.string().length(64),
  sources: z.array(z.object({ id: z.number().int().positive(), hash: z.string().length(64) })).min(3).max(3),
}).strict()
export type CreationRecipe = z.infer<typeof recipeSchema>

export function recipeOf(run: Pick<PipelineRun, 'templateKey' | 'input'>): CreationRecipe | null {
  if (run.templateKey !== 'easy-video') return null
  const input = JSON.parse(run.input)
  return recipeSchema.parse(JSON.parse(input.recipe))
}

export function pinOf(settings?: Record<string, unknown>): EndpointPin | undefined {
  if (typeof settings?.configId !== 'number') return undefined
  return { configId: settings.configId, configHash: String(settings.configHash ?? '') }
}

/** 只读核验批准素材；被编辑或删除则停机，不静默消费新版本。 */
export async function assertRecipeSources(run: PipelineRun, recipe: CreationRecipe): Promise<void> {
  const [project] = await db.select().from(projects).where(and(eq(projects.id, run.projectId), isNull(projects.deletedAt)))
  if (!project) throw new Error('项目不存在或已删除，禁止继续制作')
  const [session] = await db.select().from(creationSessions).where(eq(creationSessions.id, recipe.sessionId))
  if (!session || session.projectId !== run.projectId || session.runId !== run.id || !session.approvedPlan || hashJson(JSON.parse(session.approvedPlan)) !== hashJson(recipe)) throw new Error('运行未关联当前已批准方案，禁止执行')
  if (!run.templateSnapshot || hashJson(JSON.parse(run.templateSnapshot)) !== recipe.templateHash || hashJson(loadTemplate('easy-video')) !== recipe.templateHash) throw new Error('已批准模板版本发生变化，请重新规划')
  const input = JSON.parse(run.input)
  if (input.motion !== (recipe.plan.mode === 'dynamic') || input.i2v !== (recipe.videoMode === 'i2v') || input._params) throw new Error('执行模式与批准方案不符')
  for (const [i, field] of ['script', 'lines', 'shots'].entries()) if (JSON.stringify(input[field]) !== JSON.stringify([recipe.sources[i]!.id])) throw new Error('执行素材与批准方案不符')
  const expected = [recipe.plan.script, JSON.stringify(recipe.plan.lines), JSON.stringify(recipe.plan.shots)]
  if (recipe.sources.some((s, i) => s.hash !== hashJson(expected[i]))) throw new Error('批准素材摘要与计划不符')
  const rows = await db.select().from(assets).where(inArray(assets.id, recipe.sources.map((s) => s.id)))
  for (const src of recipe.sources) {
    const a = rows.find((row) => row.id === src.id)
    if (!a || a.projectId !== run.projectId || a.deletedAt !== null || a.kind !== 'text') throw new Error('批准素材不存在、已删除或不属于本项目')
    if (hashJson(await readTextAsset(a.id)) !== src.hash) throw new Error('已批准脚本或分镜被修改，请重新规划并确认')
  }
}

export async function frozenSettings(run: PipelineRun, action: string): Promise<RunSettings | null> {
  const recipe = recipeOf(run)
  if (!recipe) return null
  await assertRecipeSources(run, recipe)
  const service = action === 'ai_image' ? 'image' : action === 'ai_video' ? 'video' : action === 'tts' ? 'audio' : null
  if (service) {
    const pin = recipe.endpoints[service]
    if (!pin) throw new Error('批准方案缺少供应商实例')
    await resolveEndpoint(service, pin.provider, pin)
  }
  return {
    image: { ...recipe.endpoints.image, size: recipe.imageSize },
    video: { ...recipe.endpoints.video, aspect_ratio: recipe.plan.aspectRatio, resolution: recipe.resolution },
    audio: { ...recipe.endpoints.audio, voice: recipe.voice },
    llm: {},
  }
}

/** 固定错误文本不回显供应商响应体，避免网关回显凭证进入日志/对话。 */
export function mediaFailure(error: unknown, pinned: boolean): string {
  if (!pinned) return error instanceof Error ? error.message : String(error)
  const status = /HTTP\s+(\d{3})/.exec(error instanceof Error ? error.message : '')?.[1]
  return `媒体请求未完成${status ? `（HTTP ${status}）` : ''}，请核验供应商任务状态后显式恢复；可能已计费`
}
