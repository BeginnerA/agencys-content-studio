/**
 * 精确返修 · 合成输入本地返修：能力判定与基准依赖指纹（compose-input 变体，切片2 规格 §4）。
 *
 * 与字幕返修同等级门禁，但**不要求字幕快照**（大量成片本就无字幕；配置/换绑/选片返修与字幕无关）。
 * - fail-closed 门禁与 baseline.assessSubtitleCapability 同语义（在途/取消、compose 未收敛、范围外
 *   失败、下游付费/未知、受理不确定、缺成片一律拒绝）；差异仅在省略字幕快照读取那一段。
 * - 基准指纹覆盖「改变合成输入但不重生媒体」的全部因子：成片 + timelineCore + _compose 配置 +
 *   当前 BGM 绑定 id/sha + 各镜 SFX 在用 map + 各步在用 output ids + brand + recipe。
 *   候选改选（选片）经 rebuildShotOutput 重写生成步 asset_ids → 已被 stepOutputs/assetHashes 捕获；
 *   BGM/SFX 资产行 stepId=null、不属任何步 output，故必须显式纳入 loadBgmAsset/loadSfxAssets。
 * - 本模块为「同语义独立实现」，不改 baseline.ts 行为（切片2 设计要点 1：加法优先、字幕路径逐字不变）。
 * 纯读取：不写任何 run/step/task/asset 状态。
 */
import { asc, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import {
  assets,
  genTasks,
  pipelineRuns,
  pipelineSteps,
  type Asset,
  type PipelineRun,
  type PipelineStep,
} from '../../db/schema'
import { readComposeConfig, loadBgmAsset, loadSfxAssets, type ComposeConfig } from '../compose-config'
import { resolveBrandConfig } from '../brand-config'
import { hashJson } from '../creation-chat/contract'
import { isAmbiguousSubmitted } from '../creation-chat/recipe'
import { outputIdsOf } from '../shot/helpers'

export interface ComposeInputCapability {
  supported: boolean
  /** ok | run_not_found | run_active | run_cancelled | no_compose_step | compose_not_settled |
   *  other_failed | uncertain_tasks | downstream_paid | downstream_unsupported | no_final */
  code: string
  message: string
}

export interface ComposeInputBaseline {
  projectId: number
  runId: number
  stepKey: string
  stepId: number
  finalAssetId: number
  /** 当前 run 级合成配置（readComposeConfig 原样，供预览逐处 原值→新值） */
  config: ComposeConfig
  /** 在用 BGM（无则 assetId/sha256 均 null） */
  bgm: { assetId: number | null; sha256: string | null }
  /** 各镜在用 SFX（shotId 升序；无音效镜不入表） */
  sfx: Array<{ shotId: string; assetId: number; sha256: string | null }>
  /** 完整依赖指纹（baseFingerprint）：预览/确认共用，任一变即过期 */
  fingerprint: string
}

export interface ComposeInputAssessment {
  capability: ComposeInputCapability
  baseline: ComposeInputBaseline | null
}

/** 下游本地安全 action（重合成后继续执行不产生供应商调用）；名单外一律视为未知阻断。与 baseline.ts 同集合。 */
const LOCAL_SAFE_ACTIONS = new Set(['ffmpeg_merge', 'subtitle', 'dialogue_subtitle', 'literal'])
/** 已知付费生成 action（处于待执行态即阻断本切片确认）。与 baseline.ts 同集合。 */
const PAID_ACTIONS = new Set(['ai_text', 'ai_image', 'ai_video', 'tts'])

const cap = (code: string, message: string, supported = false): ComposeInputCapability => ({ supported, code, message })

async function loadRun(runId: number): Promise<PipelineRun | null> {
  const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
  return rows[0] ?? null
}

function blockedResult(c: ComposeInputCapability): ComposeInputAssessment {
  return { capability: c, baseline: null }
}

interface Core {
  run: PipelineRun
  compose: PipelineStep
  steps: PipelineStep[]
  final: Asset
  params: Record<string, unknown>
}

/**
 * 从已固定的成片/步骤核心组装基准 + 指纹（门禁通过后调用）。timeline 缺失按全 null 计入
 * timelineCore（无字幕快照/旧成片仍可返修正由本函数不依赖字幕字段体现）。
 */
async function buildBaseline(core: Core): Promise<ComposeInputBaseline> {
  const { run, compose, steps, final, params } = core
  const bgm = await loadBgmAsset(run.id)
  const sfxMap = await loadSfxAssets(run.id)
  const sfx: ComposeInputBaseline['sfx'] = []
  for (const [shotId, a] of sfxMap) sfx.push({ shotId, assetId: a.id, sha256: a.sha256 ?? null })
  sfx.sort((x, y) => (x.shotId < y.shotId ? -1 : x.shotId > y.shotId ? 1 : 0))
  const fingerprint = await buildComposeInputFingerprint({ ...core, bgm, sfx })
  return {
    projectId: run.projectId,
    runId: run.id,
    stepKey: compose.stepKey,
    stepId: compose.id,
    finalAssetId: final.id,
    config: readComposeConfig(run.input),
    bgm: { assetId: bgm?.id ?? null, sha256: bgm?.sha256 ?? null },
    sfx,
    fingerprint,
  }
}

/**
 * 能力判定 + 基准组装（同一次读取，避免判定与指纹口径漂移）。
 * stepKey 缺省 'compose'（各模板合成步统一 stepKey；工作台按运行实际步骤键传入）。
 */
export async function assessComposeInputCapability(runId: number, stepKey = 'compose'): Promise<ComposeInputAssessment> {
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
  if (!outIds.length) return blockedResult(cap('no_final', '合成步骤没有登记成片产物，无法建立合成输入基准'))
  const outRows = await db.select().from(assets).where(inArray(assets.id, outIds))
  const final = outRows.find((a) => a.kind === 'video' && a.purpose === 'final_video' && a.deletedAt === null)
  if (!final || !final.relPath) return blockedResult(cap('no_final', '合成步骤 output 中没有有效成片资产'))

  let params: Record<string, unknown> = {}
  if (final.params) {
    try {
      params = JSON.parse(final.params) as Record<string, unknown>
    } catch {
      params = {}
    }
  }
  return { capability: cap('ok', '支持合成输入本地返修', true), baseline: await buildBaseline({ run, compose, steps, final, params }) }
}

/**
 * 消费期依赖指纹复验（切片2 规格 §4「所有本地重合成入口执行前统一复验」，入口接线在 T5）：
 * 与 assess 的差异只在可在 run 在途/步骤非 succeeded 时计算——执行态本身不是过期因子，
 * 上游重跑由 output ids/资产 hash 暴露，配置/换绑/选片由 _compose/BGM·SFX 行暴露。
 * 一切不可复验（run/步/成片缺失）返回 null → 调用方按过期 fail closed。
 */
export async function computeFingerprintForComposeInputRecheck(runId: number, stepKey: string): Promise<string | null> {
  const run = await loadRun(runId)
  if (!run) return null
  const steps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId)).orderBy(asc(pipelineSteps.seq))
  const compose = steps.find((s) => s.stepKey === stepKey && s.actionKey === 'ffmpeg_merge')
  if (!compose) return null
  const outIds = outputIdsOf(compose)
  if (!outIds.length) return null
  const outRows = await db.select().from(assets).where(inArray(assets.id, outIds))
  const final = outRows.find((a) => a.kind === 'video' && a.purpose === 'final_video' && a.deletedAt === null)
  if (!final || !final.relPath) return null
  let params: Record<string, unknown> = {}
  if (final.params) {
    try {
      params = JSON.parse(final.params) as Record<string, unknown>
    } catch {
      return null
    }
  }
  // compose 步自身 status 归一为 succeeded：执行态不是过期因子（与字幕 computeFingerprintForComposeRecheck 同规则）
  const composeNorm: PipelineStep = { ...compose, status: 'succeeded' }
  const stepsNorm = steps.map((s) => (s.id === compose.id ? composeNorm : s))
  const bgm = await loadBgmAsset(runId)
  const sfxMap = await loadSfxAssets(runId)
  const sfx: ComposeInputBaseline['sfx'] = []
  for (const [shotId, a] of sfxMap) sfx.push({ shotId, assetId: a.id, sha256: a.sha256 ?? null })
  sfx.sort((x, y) => (x.shotId < y.shotId ? -1 : x.shotId > y.shotId ? 1 : 0))
  return buildComposeInputFingerprint({ run, compose: composeNorm, steps: stepsNorm, final, params, bgm, sfx })
}

/**
 * 完整依赖指纹（compose-input 变体）：成片 + timelineCore + 合成配置 + BGM/SFX 在用 + 品牌 +
 * 各步在用 output + 相关资产 hash + recipe。刻意省略字幕源/人工修订指针（与字幕切片解耦）。
 */
async function buildComposeInputFingerprint(p: {
  run: PipelineRun
  compose: PipelineStep
  steps: PipelineStep[]
  final: Asset
  params: Record<string, unknown>
  bgm: Asset | null
  sfx: ComposeInputBaseline['sfx']
}): Promise<string> {
  const tl = (p.params.timeline && typeof p.params.timeline === 'object' && !Array.isArray(p.params.timeline))
    ? (p.params.timeline as Record<string, unknown>)
    : {}
  const stepOutputs = p.steps.map((s) => ({ key: s.stepKey, seq: s.seq, status: s.status, ids: outputIdsOf(s) }))
  const involved = new Set<number>([p.final.id])
  if (p.bgm) involved.add(p.bgm.id)
  for (const x of p.sfx) involved.add(x.assetId)
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
      fps: tl.fps ?? null,
      width: tl.width ?? null,
      height: tl.height ?? null,
      totalSec: tl.totalSec ?? null,
      introSec: tl.introSec ?? null,
      outroSec: tl.outroSec ?? null,
    },
    composeConfig: readComposeConfig(p.run.input),
    bgmBinding: { id: p.bgm?.id ?? null, sha: p.bgm?.sha256 ?? null },
    sfxBindings: p.sfx.map((x) => ({ shotId: x.shotId, id: x.assetId, sha: x.sha256 })),
    brand,
    recipe: typeof inputObj.recipe === 'string' ? inputObj.recipe : null,
    stepOutputs,
    assetHashes,
  })
}
