/**
 * 精确返修 · 能力判定与基准依赖指纹（precision-rework 规格 §5.1/§6.1/§6.2 读取侧）。
 *
 * - 能力 fail closed：运行在途/取消、compose 步未收敛、范围外失败、受理不确定任务、
 *   下游含付费/未知 action、缺成片/缺快照/快照损坏一律拒绝，不静默回退台词生成字幕。
 * - 完整依赖指纹覆盖全部使修订过期的因子（§6.2：选片、媒体重做、源字幕重建、
 *   时长/品牌/合成配置改变）；预览与确认共用同一计算，前后不一致即 stale。
 * - cues 基准：无人工修订取成片 params.timeline.subtitle 快照（P2 落库）；
 *   已有人工修订读取其固定 content_versions 版本内容（源基准 tag 重挂标识，来源等级不升级）。
 * 纯读取：不写任何 run/step/task/asset 状态。
 */
import { createHash } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import {
  assets,
  contentVersions,
  genTasks,
  pipelineRuns,
  pipelineSteps,
  type Asset,
  type PipelineRun,
  type PipelineStep,
} from '../../db/schema'
import { readComposeConfig } from '../compose-config'
import { resolveBrandConfig } from '../brand-config'
import { readVersionContent } from '../provenance'
import { hashJson } from '../creation-chat/contract'
import { isAmbiguousSubmitted } from '../creation-chat/recipe'
import { outputIdsOf } from '../shot/helpers'
import { attachCueIds, parseSubtitleSrt, subtitleBaseTag, type SubtitleCue } from './subtitle-text'
import { parseSubtitleEdits, type SubtitleEditRef } from './ledger'

export interface SubtitleCapability {
  supported: boolean
  /** ok | run_not_found | run_active | run_cancelled | no_compose_step | compose_not_settled |
   *  other_failed | uncertain_tasks | downstream_paid | downstream_unsupported | no_final |
   *  no_subtitle | legacy_no_snapshot | corrupt_snapshot | version_missing */
  code: string
  message: string
}

export interface SubtitleBaseline {
  projectId: number
  runId: number
  stepKey: string
  stepId: number
  finalAssetId: number
  durationMs: number
  /** 当前显示 cues 基准（final 成片轴，标识锚定源内容基准 tag） */
  cues: SubtitleCue[]
  origin: 'source' | 'manual'
  /** 合成期锁定的源字幕引用（内容 hash + 来源等级，人工不可升级） */
  sourceRef: { assetId: number | null; sha256: string; timingSource: string }
  /** 已有人工修订指针（无则 null） */
  currentEdit: SubtitleEditRef | null
  /** 完整依赖指纹（baseFingerprint）：预览/确认共用，变即过期 */
  fingerprint: string
}

export interface SubtitleAssessment {
  capability: SubtitleCapability
  baseline: SubtitleBaseline | null
}

/** 下游本地安全 action（重合成后继续执行不产生供应商调用）；名单外一律视为未知阻断 */
const LOCAL_SAFE_ACTIONS = new Set(['ffmpeg_merge', 'subtitle', 'dialogue_subtitle', 'literal'])
/** 已知付费生成 action（处于待执行态即阻断本切片确认） */
const PAID_ACTIONS = new Set(['ai_text', 'ai_image', 'ai_video', 'tts'])

const cap = (code: string, message: string, supported = false): SubtitleCapability => ({ supported, code, message })

async function loadRun(runId: number): Promise<PipelineRun | null> {
  const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
  return rows[0] ?? null
}

function blockedResult(c: SubtitleCapability): SubtitleAssessment {
  return { capability: c, baseline: null }
}

/** timeline.subtitle 快照增量结构守卫（P2 落库形态；缺增量=旧产物，损坏=拒绝不回退） */
interface StoredSubtitleSnap {
  ok: boolean
  legacy?: boolean
  corrupt?: boolean
  cues?: SubtitleCue[]
  sourceRef?: SubtitleBaseline['sourceRef']
  relPath?: string
}
function readStoredSubtitleSnap(sub: unknown): StoredSubtitleSnap {
  if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return { ok: false, corrupt: true }
  const s = sub as Record<string, unknown>
  if (typeof s.relPath !== 'string') return { ok: false, corrupt: true }
  if (!s.sha256 && !s.cues) return { ok: false, legacy: true } // 旧产物仅 assetId/relPath：无有效字幕快照
  if (typeof s.sha256 !== 'string' || s.coordinate !== 'final' || s.origin !== 'source' && s.origin !== 'manual' || !Array.isArray(s.cues)) {
    return { ok: false, corrupt: true }
  }
  const cues: SubtitleCue[] = []
  for (const c of s.cues as unknown[]) {
    if (!c || typeof c !== 'object') return { ok: false, corrupt: true }
    const e = c as Record<string, unknown>
    if (typeof e.id !== 'string' || typeof e.text !== 'string' || !Number.isInteger(e.startMs) || !Number.isInteger(e.endMs)) {
      return { ok: false, corrupt: true }
    }
    cues.push({ id: e.id, startMs: e.startMs as number, endMs: e.endMs as number, text: e.text })
  }
  const ref = s.sourceRef as Record<string, unknown> | undefined
  if (!ref || typeof ref !== 'object' || typeof ref.sha256 !== 'string' || (ref.timingSource !== 'estimated' && ref.timingSource !== 'measured' && ref.timingSource !== 'unknown')) {
    return { ok: false, corrupt: true }
  }
  return {
    ok: true,
    cues,
    relPath: s.relPath,
    sourceRef: { assetId: typeof ref.assetId === 'number' ? ref.assetId : null, sha256: ref.sha256, timingSource: ref.timingSource },
  }
}

/** 人工修订版本的 cues 读取：版本内容解析 + 源基准 tag 重挂标识 + hash 一致性 */
async function loadManualCues(ref: SubtitleEditRef, sourceSha: string): Promise<{ cues: SubtitleCue[] } | { corrupt: true }> {
  let text: string
  try {
    const content = await readVersionContent(ref.versionId)
    if (content.kind !== 'text') return { corrupt: true }
    text = content.text
  } catch {
    return { corrupt: true }
  }
  if (ref.sha256 && shaOfText(text) !== ref.sha256) return { corrupt: true }
  const parsed = parseSubtitleSrt(text)
  if (!parsed.ok) return { corrupt: true }
  return { cues: attachCueIds(parsed.cues, subtitleBaseTag(sourceSha)) }
}

function shaOfText(text: string): string {
  return createHash('sha256').update(new TextEncoder().encode(text)).digest('hex')
}

/**
 * 能力判定 + 基准组装（同一次读取，避免判定与指纹口径漂移）。
 * stepKey 缺省 'compose'（各模板合成步统一 stepKey；工作台按运行实际步骤键传入）。
 */
export async function assessSubtitleCapability(runId: number, stepKey = 'compose'): Promise<SubtitleAssessment> {
  const run = await loadRun(runId)
  if (!run) return blockedResult(cap('run_not_found', `运行 ${runId} 不存在`))
  if (run.status === 'running' || run.status === 'queued' || run.status === 'waiting_input') {
    return blockedResult(cap('run_active', `运行正在执行/排队（${run.status}），请等待收敛后再返修`))
  }
  if (run.status === 'cancelled') return blockedResult(cap('run_cancelled', '运行已取消，请通过断点续跑建立新运行后再操作'))

  const steps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId)).orderBy(asc(pipelineSteps.seq))
  const compose = steps.find((s) => s.stepKey === stepKey && s.actionKey === 'ffmpeg_merge')
  if (!compose) return blockedResult(cap('no_compose_step', `运行内未找到合成步骤「${stepKey}」`))
  if (compose.status !== 'succeeded') return blockedResult(cap('compose_not_settled', `合成步骤状态为 ${compose.status}，尚无可返修的成片基准`))
  for (const s of steps) {
    if (s.id !== compose.id && s.status === 'failed') {
      return blockedResult(cap('other_failed', `存在范围外失败步骤「${s.stepKey}」，请先按既有流程收敛失败`))
    }
  }
  for (const s of steps) {
    if (s.seq <= compose.seq || s.status === 'succeeded' || s.status === 'skipped' || s.status === 'waiting_input') continue
    if (PAID_ACTIONS.has(s.actionKey)) return blockedResult(cap('downstream_paid', `下游步骤「${s.stepKey}」为待执行付费生成，本切片确认不能连带触发`))
    if (!LOCAL_SAFE_ACTIONS.has(s.actionKey)) return blockedResult(cap('downstream_unsupported', `下游步骤「${s.stepKey}」（${s.actionKey}）不在本地安全链路白名单内，本切片不接管`))
  }
  const tasks = await db.select().from(genTasks).where(eq(genTasks.runId, runId))
  if (tasks.some((t) => isAmbiguousSubmitted(t))) {
    return blockedResult(cap('uncertain_tasks', '存在受理不确定的生成任务，请先核对任务状态后再返修'))
  }

  // 成片固定于 compose 步 output（不按时间取最新资产）
  const outIds = outputIdsOf(compose)
  if (!outIds.length) return blockedResult(cap('no_final', '合成步骤没有登记成片产物，无法建立字幕基准'))
  const outRows = await db.select().from(assets).where(inArray(assets.id, outIds))
  const final = outRows.find((a) => a.kind === 'video' && a.purpose === 'final_video' && a.deletedAt === null)
  if (!final || !final.relPath) return blockedResult(cap('no_final', '合成步骤 output 中没有有效成片资产'))

  let params: Record<string, unknown> = {}
  try {
    params = JSON.parse(final.params ?? '{}') as Record<string, unknown>
  } catch {
    return blockedResult(cap('corrupt_snapshot', '成片 params 不是合法 JSON，无法读取时间轴快照'))
  }
  const tl = params.timeline as Record<string, unknown> | undefined
  if (!tl || typeof tl !== 'object' || Array.isArray(tl) || !Array.isArray(tl.segments) || typeof tl.totalSec !== 'number') {
    return blockedResult(cap('legacy_no_snapshot', '成片缺少有效字幕快照：请先显式执行一次本地重合成建立基准（本入口不会自动触发）'))
  }
  const snap = readStoredSubtitleSnap(tl.subtitle)
  if (snap.legacy) return blockedResult(cap('legacy_no_snapshot', '成片字幕快照为旧版形态（无有效 cue 记录）：请先显式本地重合成建立基准'))
  if (!snap.ok) {
    if (snap.corrupt) return blockedResult(cap('corrupt_snapshot', '成片字幕快照字段损坏，明确拒绝（不回退台词生成字幕）'))
    return blockedResult(cap('no_subtitle', '该成片没有字幕，无显示字幕可返修'))
  }
  const sourceRef = snap.sourceRef!
  // 源字幕资产当前 hash（重建/覆写会在指纹中暴露）
  let sourceAsset: Asset | null = null
  if (sourceRef.assetId !== null) {
    const sa = await db.select().from(assets).where(inArray(assets.id, [sourceRef.assetId])).limit(1)
    sourceAsset = sa[0] && sa[0].deletedAt === null ? sa[0] : null
  }

  const currentEdit = parseSubtitleEdits(run.input)[stepKey] ?? null
  // P2 快照 origin 字段已标源/人工；存在当前修订指针时基准必为人工版本内容
  let cues = snap.cues!
  let origin: SubtitleBaseline['origin'] = snap.cues === undefined ? 'manual' : 'source'
  const snapOriginField = (tl.subtitle as Record<string, unknown> | undefined)?.origin
  if (snapOriginField === 'manual') origin = 'manual'
  if (currentEdit) {
    const manual = await loadManualCues(currentEdit, sourceRef.sha256)
    if ('corrupt' in manual) return blockedResult(cap('version_missing', '当前人工修订版本内容缺失或损坏，无法在其基础上继续预览'))
    cues = manual.cues
    origin = 'manual'
  }

  const durationMs = Math.round((tl.totalSec as number) * 1000)
  const fingerprint = await buildFingerprint({ run, compose, steps, final, params, tl, sourceRef, sourceAsset, currentEdit })
  return {
    capability: cap('ok', '支持字幕精确返修', true),
    baseline: {
      projectId: run.projectId,
      runId,
      stepKey,
      stepId: compose.id,
      finalAssetId: final.id,
      durationMs,
      cues,
      origin,
      sourceRef,
      currentEdit,
      fingerprint,
    },
  }
}

/**
 * 合成消费期依赖指纹复验（规格 §6.2「后续所有重合成入口执行前再次检查」）：
 * 任何入口（会话/通用 recompose、选片、单步/级联重跑、断点续跑携带指针的旧 run）最终都
 * 经 ffmpeg-merge 消费修订，本函数即统一执行前检查；与 assess 的差异只在可在 run 在途时计算。
 * - compose 步自身 status 归一为 succeeded：执行态不是过期因子；上游重跑由 output ids/资产 hash 暴露。
 * - currentEdit 因子回拨为当前修订的前驱指针：baseFingerprint 写入（确认）时的指纹所见的是
 *   旧指针态；版本行 meta.parentVersionId 即指针链前驱（首修订=null），据此回拨才可对比。
 * - 一切不可复验（run/步/成片/快照缺失或损坏、版本行/指针链断）返回 null → 调用方按过期 fail closed。
 */
export async function computeFingerprintForComposeRecheck(runId: number, stepKey: string): Promise<string | null> {
  const run = await loadRun(runId)
  if (!run) return null
  const edit = parseSubtitleEdits(run.input)[stepKey]
  if (!edit) return null
  const steps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId)).orderBy(asc(pipelineSteps.seq))
  const compose = steps.find((s) => s.stepKey === stepKey && s.actionKey === 'ffmpeg_merge')
  if (!compose) return null
  const outIds = outputIdsOf(compose)
  if (!outIds.length) return null
  const outRows = await db.select().from(assets).where(inArray(assets.id, outIds))
  const final = outRows.find((a) => a.kind === 'video' && a.purpose === 'final_video' && a.deletedAt === null)
  if (!final || !final.relPath) return null
  let params: Record<string, unknown> = {}
  try {
    params = JSON.parse(final.params ?? '{}') as Record<string, unknown>
  } catch {
    return null
  }
  const tl = params.timeline as Record<string, unknown> | undefined
  if (!tl || typeof tl !== 'object' || Array.isArray(tl) || !Array.isArray(tl.segments) || typeof tl.totalSec !== 'number') return null
  const snap = readStoredSubtitleSnap(tl.subtitle)
  if (!snap.ok) return null
  const sourceRef = snap.sourceRef!
  let sourceAsset: Asset | null = null
  if (sourceRef.assetId !== null) {
    const sa = await db.select().from(assets).where(inArray(assets.id, [sourceRef.assetId])).limit(1)
    sourceAsset = sa[0] && sa[0].deletedAt === null ? sa[0] : null
  }
  // 前驱指针回拨：当前修订版本行 meta → parentVersionId → 前驱版本行重建 SubtitleEditRef
  const vRows = await db.select().from(contentVersions).where(and(eq(contentVersions.objKind, 'asset'), eq(contentVersions.id, edit.versionId))).limit(1)
  const vRow = vRows[0]
  if (!vRow || vRow.objId !== edit.assetId) return null
  let vMeta: Record<string, unknown> = {}
  try {
    vMeta = JSON.parse(vRow.meta ?? '{}') as Record<string, unknown>
  } catch {
    return null
  }
  let prevEdit: SubtitleEditRef | null = null
  const parentVersionId = vMeta.parentVersionId
  if (parentVersionId !== null && parentVersionId !== undefined) {
    if (typeof parentVersionId !== 'number') return null
    const pRows = await db.select().from(contentVersions).where(and(eq(contentVersions.objKind, 'asset'), eq(contentVersions.id, parentVersionId))).limit(1)
    const pRow = pRows[0]
    if (!pRow || pRow.objId !== edit.assetId) return null
    let pMeta: Record<string, unknown> = {}
    try {
      pMeta = JSON.parse(pRow.meta ?? '{}') as Record<string, unknown>
    } catch {
      return null
    }
    if (typeof pMeta.baseFingerprint !== 'string' || typeof pMeta.requestId !== 'string') return null
    prevEdit = { assetId: pRow.objId, versionId: pRow.id, sha256: pRow.sha256 ?? '', baseFingerprint: pMeta.baseFingerprint, requestId: pMeta.requestId }
  }
  const composeNorm: PipelineStep = { ...compose, status: 'succeeded' }
  const stepsNorm = steps.map((s) => (s.id === compose.id ? composeNorm : s))
  return buildFingerprint({ run, compose: composeNorm, steps: stepsNorm, final, params, tl, sourceRef, sourceAsset, currentEdit: prevEdit })
}

/** 完整依赖指纹：成片+时间轴核心+配置+品牌+选片/媒体 output+源字幕+当前修订指针 */
async function buildFingerprint(p: {
  run: PipelineRun
  compose: PipelineStep
  steps: PipelineStep[]
  final: Asset
  params: Record<string, unknown>
  tl: Record<string, unknown>
  sourceRef: SubtitleBaseline['sourceRef']
  sourceAsset: Asset | null
  currentEdit: SubtitleEditRef | null
}): Promise<string> {
  const stepOutputs = p.steps.map((s) => ({ key: s.stepKey, seq: s.seq, status: s.status, ids: outputIdsOf(s) }))
  const involved = new Set<number>([p.final.id])
  if (p.sourceRef.assetId !== null) involved.add(p.sourceRef.assetId)
  if (p.sourceAsset) involved.add(p.sourceAsset.id)
  if (p.currentEdit) involved.add(p.currentEdit.assetId)
  for (const o of stepOutputs) for (const id of o.ids) involved.add(id)
  const assetRows = await db
    .select({ id: assets.id, sha256: assets.sha256, fileSize: assets.fileSize, deletedAt: assets.deletedAt })
    .from(assets)
    .where(inArray(assets.id, [...involved]))
  const assetHashes = assetRows
    .map((a) => ({ id: a.id, sha256: a.sha256 ?? null, size: a.fileSize ?? null, del: a.deletedAt !== null }))
    .sort((x, y) => x.id - y.id)
  let inputObj: Record<string, unknown> = {}
  try {
    inputObj = JSON.parse(p.run.input) as Record<string, unknown>
  } catch {
    /* 损坏 input 由上游拒绝，这里保持指纹函数纯防守 */
  }
  const brand = await resolveBrandConfig(p.run.projectId, p.run.input)
  return hashJson({
    v: 1,
    runId: p.run.id,
    stepKey: p.compose.stepKey,
    stepId: p.compose.id,
    final: { id: p.final.id, sha: p.final.sha256 ?? null, size: p.final.fileSize ?? null },
    timelineCore: {
      fps: p.tl.fps ?? null,
      width: p.tl.width ?? null,
      height: p.tl.height ?? null,
      totalSec: p.tl.totalSec ?? null,
      introSec: p.tl.introSec ?? null,
      outroSec: p.tl.outroSec ?? null,
    },
    composeTrace: { align: p.params.align ?? null, transition: p.params.transition ?? null, bgm: p.params.bgm ?? null, watermark: p.params.watermark ?? null, intro: p.params.intro ?? null, outro: p.params.outro ?? null, sfx: p.params.sfx ?? null, subtitle_style: p.params.subtitle_style ?? null },
    subtitleSource: p.sourceRef,
    sourceAssetSha: p.sourceAsset?.sha256 ?? null,
    composeConfig: readComposeConfig(p.run.input),
    brand,
    recipe: typeof inputObj.recipe === 'string' ? inputObj.recipe : null,
    stepOutputs,
    assetHashes,
    currentEdit: p.currentEdit ?? null,
  })
}
