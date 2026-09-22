import { statSync } from 'node:fs'
import { and, eq, inArray, or } from 'drizzle-orm'
import { db } from '../../db'
import { assets, type CreationSession, type PipelineRun, type pipelineSteps, type genTasks } from '../../db/schema'
import { absPathOf } from '../storage'
import { creationPlanSchema } from './contract'

type Asset = typeof assets.$inferSelect
type Step = typeof pipelineSteps.$inferSelect
type Task = typeof genTasks.$inferSelect

/** 展示层宽容读取历史元数据；不用于执行校验，也不把损坏值当作有效方案。 */
export function jsonRecord(raw: string | null | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw ?? '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return {} }
}
const positiveId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0
export function outputAssetIds(raw: string | null): number[] {
  const data = jsonRecord(raw)
  return [...new Set([...(Array.isArray(data.asset_ids) ? data.asset_ids : []), data.asset_id].filter(positiveId))]
}

export interface CreationArtifact {
  assetId: number
  kind: string
  name: string
  available: boolean
  sourceRunId: number | null
  reused: boolean
}

/**
 * [M42] 每镜每模态的多版本视图：selected = 正在用的那一个（与旧单值口径完全一致），
 * candidates = 同镜头全部候选（含缺文件/已删除的不可选占位）。候选序确定性：
 * 在用优先 → 本步任务产物优先 → id 倒序（同优先级下最新版在前）。
 */
export interface CreationArtifactChoice {
  selected: CreationArtifact | null
  candidates: CreationArtifact[]
}

function readable(a: Asset): boolean {
  try { return !!a.relPath && statSync(absPathOf(a.relPath)).isFile() } catch { return false }
}

/** 只加载当前运行及其显式引用的素材，恢复时无需改写旧素材所属 run。 */
export async function loadCreationProjection(session: CreationSession, run: PipelineRun, steps: Step[], tasks: Task[]) {
  const recipe = jsonRecord(String(jsonRecord(run.input).recipe ?? ''))
  const sourceIds = Array.isArray(recipe.sources)
    ? recipe.sources.flatMap((s) => s && typeof s === 'object' && positiveId((s as { id?: unknown }).id) ? [(s as { id: number }).id] : []) : []
  const ids = [...new Set([...steps.flatMap((s) => outputAssetIds(s.output)), ...tasks.filter((t) => t.status === 'succeeded').map((t) => t.resultAssetId).filter(positiveId), ...sourceIds])]
  const media = await db.select().from(assets).where(and(eq(assets.projectId, session.projectId), ids.length ? or(eq(assets.runId, run.id), inArray(assets.id, ids)) : eq(assets.runId, run.id)))
  return projectCreation(session, run, steps, tasks, media, readable)
}

/** 纯投影：阶段状态与素材可用性分开，读取详情永不触发供应商或媒体处理。 */
export function projectCreation(session: CreationSession, run: PipelineRun, steps: Step[], tasks: Task[], media: Asset[], isReadable: (asset: Asset) => boolean = readable) {
  const recipe = jsonRecord(String(jsonRecord(run.input).recipe ?? ''))
  steps = steps.filter((s) => s.runId === run.id)
  tasks = tasks.filter((t) => t.projectId === session.projectId && t.runId === run.id)
  const parsed = creationPlanSchema.safeParse(recipe.plan ?? jsonRecord(session.approvedPlan))
  const plan = parsed.success ? parsed.data : null
  const videoMode = ['i2v', 't2v', 'none'].includes(String(recipe.videoMode)) ? recipe.videoMode : null
  const stepByKey = new Map(steps.map((s) => [s.stepKey, s]))
  const outputByKey = new Map(steps.map((s) => [s.stepKey, new Set(outputAssetIds(s.output))]))
  const sourceIds = Array.isArray(recipe.sources) ? recipe.sources.map((s) => s && typeof s === 'object' ? (s as { id?: unknown }).id : null).filter(positiveId) : []
  const linked = new Set([...steps.flatMap((s) => outputAssetIds(s.output)), ...tasks.filter((t) => t.status === 'succeeded').map((t) => t.resultAssetId).filter(positiveId), ...sourceIds])
  const byId = new Map(media.filter((a) => a.projectId === session.projectId && (a.runId === run.id || linked.has(a.id))).map((a) => [a.id, a]))
  const availability = new Map<number, boolean>()
  const available = (a: Asset) => {
    if (!availability.has(a.id)) availability.set(a.id, a.deletedAt === null && isReadable(a))
    return availability.get(a.id)!
  }
  const view = (id: number, kind: string, label: string): CreationArtifact => {
    const a = byId.get(id)
    const valid = !!a && a.deletedAt === null && a.kind === kind
    return { assetId: id, kind, name: valid ? a.name : label, available: valid && available(a), sourceRunId: valid ? a.runId : null, reused: valid && a.runId !== null && a.runId !== run.id }
  }
  const eligibleTasks = tasks.filter((t) => t.projectId === session.projectId && t.runId === run.id)
  /** [M42] 候选集投影：候选来源与原 pick 同口径（同 shotId 的 succeeded 任务 resultAssetId ∪ output/本步资产） */
  const pickSet = (stageKey: string, kind: string, field: 'shotId' | 'lineId', key: string): CreationArtifactChoice => {
    const output = outputByKey.get(stageKey) ?? new Set<number>()
    const step = stepByKey.get(stageKey)
    const related = eligibleTasks.filter((t) => t.stepId === step?.id && t.kind === kind && t.status === 'succeeded' && jsonRecord(t.params)[field] === key)
    const taskIds = new Set(related.map((t) => t.resultAssetId).filter(positiveId))
    const candidates = [...byId.values()].filter((a) => {
      if (a.kind !== kind) return false
      const association = jsonRecord(a.params)[field]
      if (typeof association === 'string' && association !== key) return false
      return (association === key && (output.has(a.id) || a.runId === run.id && a.stepId === step?.id)) || taskIds.has(a.id)
    }).map((a) => a.id)
    // 任务已成功但文件/资产行丢失时仍给出不可用占位，不回退到无关历史版本。
    const ordered = [...new Set([...candidates, ...taskIds])].sort((a, b) => Number(output.has(b)) - Number(output.has(a)) || Number(taskIds.has(b)) - Number(taskIds.has(a)) || b - a)
    const of = (id: number): CreationArtifact => {
      const a = byId.get(id)
      const association = a ? jsonRecord(a.params)[field] : undefined
      const artifact = view(id, kind, '素材不可用')
      if (association !== undefined && association !== key) return { ...artifact, name: '素材关联不一致', available: false }
      return artifact
    }
    const list = ordered.map(of)
    return { selected: list[0] ?? null, candidates: list }
  }
  const pick = (stageKey: string, kind: string, field: 'shotId' | 'lineId', key: string): CreationArtifact | null => pickSet(stageKey, kind, field, key).selected
  const newest = (purpose: string, kind: string, strict = false) => [...byId.values()]
    .filter((a) => a.deletedAt === null && a.purpose === purpose && a.kind === kind && (!strict || jsonRecord(a.params).delivery_checked === true))
    .sort((a, b) => b.id - a.id)[0]
  const finalCandidate = newest('final_video', 'video', true)
  const final = finalCandidate && available(finalCandidate) ? finalCandidate : undefined
  const coverCandidate = newest('thumbnail', 'image')
  const cover = coverCandidate && available(coverCandidate) ? coverCandidate : undefined
  const status = run.status === 'completed' && !final ? 'failed' : run.status
  const error = run.status === 'completed' && !final ? '缺少通过基础交付检查且可读取的成片' : run.error
  const definitions: Array<{ key: string; title: string; applicable: boolean | null; kind?: string; field?: 'shotId' | 'lineId' }> = [
    { key: 'voice', title: '配音', applicable: true, kind: 'audio', field: 'lineId' },
    { key: 'captions', title: '字幕', applicable: true },
    { key: 'images', title: '图文画面', applicable: plan ? plan.mode === 'slideshow' : null, kind: 'image', field: 'shotId' },
    { key: 'frames', title: '动态首帧', applicable: plan?.mode === 'slideshow' ? false : videoMode ? videoMode === 'i2v' : null, kind: 'image', field: 'shotId' },
    { key: 'motion', title: '动态镜头', applicable: plan ? plan.mode === 'dynamic' : null, kind: 'video', field: 'shotId' },
    { key: 'compose', title: '合成与交付检查', applicable: true },
  ]
  const snapshot = jsonRecord(run.templateSnapshot)
  const templateKeys = Array.isArray(snapshot.steps) ? new Set(snapshot.steps.flatMap((s) => s && typeof s === 'object' && typeof s.key === 'string' ? [s.key] : [])) : null
  const stages = definitions.map((d) => {
    const step = stepByKey.get(d.key)
    const applicable = templateKeys && !templateKeys.has(d.key) ? false : !step && !templateKeys ? null : d.applicable
    const knownIds = d.field === 'lineId' ? plan?.lines.map((l) => l.id) : plan?.shots.map((s) => s.id)
    const children = step ? eligibleTasks.filter((t) => t.stepId === step.id && t.kind === d.kind) : []
    const done = new Set(children.filter((t) => t.status === 'succeeded')
      .map((t) => d.field ? jsonRecord(t.params)[d.field] : null).filter((id): id is string => typeof id === 'string' && !!knownIds?.includes(id)))
    const counted = applicable === true && children.length > 0 && !!knownIds
    const stageStatus = applicable === false ? 'not_applicable' : applicable === null ? 'unknown' : d.key === 'compose' && (run.status === 'completed' || step?.status === 'succeeded') && !final ? 'failed' : step?.status ?? 'pending'
    return { key: d.key, title: d.title, applicable, status: stageStatus, completed: counted ? done.size : null, total: counted ? knownIds.length : null }
  })
  const uncertainTasks = eligibleTasks.filter((t) => t.attempts > 0 && t.status !== 'succeeded').map((t) => {
    const params = jsonRecord(t.params)
    const shotIndex = plan?.shots.findIndex((s) => s.id === params.shotId) ?? -1
    const lineIndex = plan?.lines.findIndex((l) => l.id === params.lineId) ?? -1
    return { id: t.id, kind: t.kind, provider: t.provider, hasExternalId: !!t.taskId, label: shotIndex >= 0 ? `第 ${shotIndex + 1} 镜` : lineIndex >= 0 ? `第 ${lineIndex + 1} 句配音` : `任务 #${t.id}` }
  })
  const technical = new Map<string, string[]>()
  for (const [scope, message] of [['制作', error], ...steps.map((s) => [s.title ?? s.stepKey, s.error])] as Array<[string, string | null]>) {
    if (!message?.trim()) continue
    const text = message.trim()
    technical.set(text, [...new Set([...(technical.get(text) ?? []), scope])])
  }
  const documents: Array<CreationArtifact & { label: string }> = sourceIds.slice(0, 3).map((id, i) => ({ ...view(id, 'text', '批准文本不可用'), label: ['批准脚本', '批准台词', '批准分镜'][i]! }))
  const subtitleIds = [...(outputByKey.get('captions') ?? [])]
  const subtitle = subtitleIds[0] ?? newest('subtitle', 'text')?.id
  if (subtitle) documents.push({ ...view(subtitle, 'text', '字幕不可用'), label: '字幕' })
  const artifacts = {
    shots: (plan?.shots ?? []).map((s, i) => ({ shotId: s.id, index: i + 1, duration: s.duration, text: s.lines.map((id) => plan?.lines.find((l) => l.id === id)?.text ?? '').join(' '),
      image: pickSet(plan?.mode === 'slideshow' ? 'images' : 'frames', 'image', 'shotId', s.id), video: pickSet('motion', 'video', 'shotId', s.id),
      voices: s.lines.map((id) => pick('voice', 'audio', 'lineId', id)).filter((v): v is CreationArtifact => v !== null),
    })), documents,
  }
  const savedCount = [...new Set([...artifacts.shots.flatMap((s) => [s.image.selected, s.video.selected, ...s.voices]), ...documents].filter((a): a is CreationArtifact => !!a?.available).map((a) => a.assetId))].length
  const settledBad = ['failed', 'cancelled'].includes(status)
  const failedStage = stages.find((s) => s.status === 'failed')
  const preflight = jsonRecord(session.preflight)
  const estimate = preflight.estimate as { unpriced?: unknown } | undefined
  const unpriced = Array.isArray(estimate?.unpriced) ? estimate.unpriced.filter((x): x is string => typeof x === 'string') : []
  // [M42] 中途审阅：等待闸门时把挂起步与模板 gate 文案透出，前端据此渲染审阅面板（不改引擎语义，仅投影）
  const waitingStep = run.status === 'waiting_input' ? steps.find((s) => s.status === 'waiting_input') : undefined
  const gateMessage = (() => {
    if (!waitingStep || !Array.isArray(snapshot.steps)) return null
    const def = snapshot.steps.find((s) => s && typeof s === 'object' && (s as { key?: unknown }).key === waitingStep.stepKey) as { gate?: { message?: unknown } } | undefined
    const text = typeof def?.gate?.message === 'string' ? def.gate.message.trim() : ''
    return text || null
  })()
  const review = waitingStep ? { stepKey: waitingStep.stepKey, title: waitingStep.title ?? waitingStep.stepKey, message: gateMessage ?? '本阶段产物已生成，请审阅后继续。' } : null
  return {
    progress: { runId: run.id, status, currentStep: run.currentStepKey, error, review,
      needsVerification: settledBad && uncertainTasks.length > 0, uncertainTasks,
      completedShots: stages.find((s) => s.key === (plan?.mode === 'dynamic' ? 'motion' : 'images'))?.completed ?? 0,
      steps: steps.map((s) => ({ key: s.stepKey, title: s.title, status: s.status, error: s.error })), stages,
      recovery: { resumable: settledBad && ['failed', 'cancelled'].includes(run.status), requiredTaskIds: uncertainTasks.filter((t) => !t.hasExternalId).map((t) => t.id), queryTaskCount: uncertainTasks.filter((t) => t.hasExternalId).length, unpriced },
      issue: settledBad ? { summary: `${failedStage ? `${failedStage.title}未完成` : status === 'cancelled' ? '制作已取消' : '制作未完成'}；已有 ${savedCount} 项成果可查看。${uncertainTasks.length ? `有 ${uncertainTasks.length} 个请求的受理或完成状态需核实，是否已计费尚不确定。` : '请查看阶段状态后决定是否恢复。'}`, details: [...technical].map(([message, scopes]) => ({ message, scopes })) } : null,
    }, artifacts,
    result: run.status === 'completed' && final ? { videoId: final.id, coverId: cover?.id ?? null, duration: final.duration } : null,
  }
}
