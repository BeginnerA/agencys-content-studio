/**
 * 参考反推可检视交付（轻松创作「参考解析产物 + 反推分镜初稿」）——确定性纯函数集。
 *
 * 参考解析：video_analyze 摘要此前只进 LLM 上下文即弃；本模块把它**编进 plan.refsAnalysis**（服务端写入，
 *   有界可核实：scenes≤24、transcript≤2000，超限截断并给可见标记，缺失字段留占位不编造）→ 进 planHash
 *   （参考/解析变了旧确认作废，与「参考变化→冲突」既定同律）。
 * 反推初稿：反推意图（措辞真源与 route-hint 同源）+ 已有解析产物时，用现成 `video-storyboard.md` 提示词
 *   把时间轴转成分镜初稿喂进规划上下文；规划产出后服务端给全部 shots 权威标 `source:'reverse'`
 *   （整条成片基于反推初稿，逐镜归属不可靠故不逐镜猜）。
 * 本模块零网络零计费（模型调用与记账在 planning.ts 接线处）；新信号/新界须同步 probe-m58 断言。
 */
import type { VideoAnalysisOutcome } from '../../pipeline/actions/video-analyze'
import type { ImageReverseItem } from '../../pipeline/actions/image-analyze'
import { imageAnalysisEntrySchema, refsAnalysisEntrySchema, type ImageAnalysisEntry, type RefsAnalysisEntry } from './contract'

const SCENES_MAX = 24
const TRANSCRIPT_MAX = 2000
const DRAFT_SHOTS_MAX = 12

const clip = (s: string, max: number): string => s.trim().slice(0, max)

/**
 * 解析产物归一（2b）：VideoAnalysisOutcome → plan.refsAnalysis 单条目。
 * desc 取解析原文 visual（无则 speech，双缺给「（无描述）」占位——不编造），景别作注记追加；
 * scenes 超限截断置 truncated.scenes；transcript 逐字拼接超限截断置 truncated.transcript，空则不挂键。
 * 产物形状必过 refsAnalysisEntrySchema（schema 是契约真源， normalize 在其内做保守投影）。
 */
export function normalizeRefsAnalysis(args: { assetId: number; name: string; outcome: VideoAnalysisOutcome }): RefsAnalysisEntry {
  const tl = args.outcome.tl
  const allScenes = tl.scenes.map((s) => {
    const base = (s.visual || s.speech || '（无描述）').trim()
    const desc = s.shot_type ? `${base}（${s.shot_type}）` : base
    return { t: Math.max(0, Number(s.t0.toFixed(1))), desc: clip(desc, 400) || '（无描述）' }
  })
  const scenesTruncated = allScenes.length > SCENES_MAX
  const scenes = allScenes.slice(0, SCENES_MAX)
  const joined = (tl.transcript ?? []).map((x) => x.text.trim()).filter(Boolean).join(' ')
  const transcriptTruncated = joined.length > TRANSCRIPT_MAX
  const entry: RefsAnalysisEntry = {
    assetId: args.assetId,
    name: clip(args.name, 200) || `#${args.assetId}`,
    duration: Math.max(0, Number((tl.duration ?? 0).toFixed(1))),
    scenes,
    transcribed: args.outcome.transcribed === true && joined.length > 0,
    ...(joined ? { transcript: clip(joined, TRANSCRIPT_MAX) } : {}),
    ...(scenesTruncated || transcriptTruncated
      ? { truncated: { ...(scenesTruncated ? { scenes: true } : {}), ...(transcriptTruncated ? { transcript: true } : {}) } }
      : {}),
  }
  return refsAnalysisEntrySchema.parse(entry)
}

/** 反推分镜初稿单项（video-storyboard.md 契约的服务端宽松收口形；界限与轻松创作 shots 同量级） */
export interface StoryboardDraftShot {
  t0: number
  t1: number
  visual: string
  shotType?: string
  camera?: string
  dialogue?: string
  imagePrompt?: string
}

function asFiniteNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * storyboard-json 宽松解析（2a）：剥围栏取首个 JSON 对象 → shots 数组逐项核验；
 * 非契约输出 / 无有效镜 → null（调用方给可见失败说明，不静默、不臆造）。
 * 只收实际存在的字段（缺失留空不编），单项文本截断护栏，总量 ≤12 镜（轻松创作 shots 上限）。
 */
export function parseStoryboardDraft(content: string): StoryboardDraftShot[] | null {
  const s = content.indexOf('{')
  const e = content.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  let raw: unknown
  try { raw = JSON.parse(content.slice(s, e + 1)) } catch { return null }
  const shots = (raw as { shots?: unknown })?.shots
  if (!Array.isArray(shots)) return null
  const out: StoryboardDraftShot[] = []
  for (const item of shots) {
    if (out.length >= DRAFT_SHOTS_MAX) break
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const visual = typeof o.visual === 'string' ? clip(o.visual, 400) : ''
    if (!visual) continue // 无画面描述的镜没有价值，丢弃而非编造
    const t0 = asFiniteNum(o.t0)
    const t1 = asFiniteNum(o.t1)
    out.push({
      t0: t0 !== null && t0 >= 0 ? t0 : 0,
      t1: t1 !== null && t1 >= 0 ? t1 : 0,
      visual,
      ...(typeof o.shot_type === 'string' && o.shot_type.trim() ? { shotType: clip(o.shot_type, 40) } : {}),
      ...(typeof o.camera === 'string' && o.camera.trim() ? { camera: clip(o.camera, 40) } : {}),
      ...(typeof o.dialogue === 'string' && o.dialogue.trim() ? { dialogue: clip(o.dialogue, 300) } : {}),
      ...(typeof o.image_prompt === 'string' && o.image_prompt.trim() ? { imagePrompt: clip(o.image_prompt, 1600) } : {}),
    })
  }
  return out.length ? out : null
}

/** 初稿渲染为规划上下文（时间升序一行一镜；字段只列实际存在者，供 LLM 以其为蓝本适配契约） */
export function renderStoryboardDraft(shots: StoryboardDraftShot[]): string {
  const lines = shots.map((d, i) => {
    const meta = [d.shotType, d.camera].filter(Boolean).join(' / ')
    const parts = [`- ${i + 1}. [${d.t0.toFixed(1)}–${d.t1.toFixed(1)}s] ${d.visual}${meta ? `（${meta}）` : ''}`]
    if (d.dialogue) parts.push(`台词：「${d.dialogue}」`)
    if (d.imagePrompt) parts.push(`画面提示词：${d.imagePrompt}`)
    return parts.join(' ｜ ')
  })
  return lines.join('\n')
}

/**
 * 图片反推产物归一（纯函数，探针直测）：ImageReverseItem → plan.imageAnalysis 单条目。
 * 仅取反推实际所得（subject/style/negative 空则不挂键），imagePrompt 为产物核心必非空；
 * 各字段保守截断（subject/style 400、imagePrompt 1600、negative 1200、palette≤8），超限截断不编造。
 * 产物必过 imageAnalysisEntrySchema（schema 是契约真源，normalize 在其内做保守投影）。
 */
export function normalizeImageAnalysis(args: { assetId: number; name: string; item: ImageReverseItem }): ImageAnalysisEntry {
  const it = args.item
  const entry: ImageAnalysisEntry = {
    assetId: args.assetId,
    name: clip(args.name, 200) || `#${args.assetId}`,
    ...(clip(it.subject, 400) ? { subject: clip(it.subject, 400) } : {}),
    ...(clip(it.style, 400) ? { style: clip(it.style, 400) } : {}),
    imagePrompt: clip(it.image_prompt, 1600),
    ...(clip(it.negative_prompt, 1200) ? { negativePrompt: clip(it.negative_prompt, 1200) } : {}),
    palette: it.palette.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim().slice(0, 16)).slice(0, 8),
  }
  return imageAnalysisEntrySchema.parse(entry)
}

/** 图片反推简报渲染为规划上下文（逐图一行：可投产 image_prompt + 风格/负向注记；供 LLM 以反推词为 shots 风格/提示词基准） */
export function renderImageReverseBrief(entries: ImageAnalysisEntry[]): string {
  const lines = entries.map((e, i) => {
    const meta = [e.style, e.subject].filter(Boolean).join(' / ')
    const parts = [`- ${i + 1}. ${e.name}${meta ? `（${meta}）` : ''}`]
    parts.push(`正向提示词：${e.imagePrompt}`)
    if (e.negativePrompt) parts.push(`负向提示词：${e.negativePrompt}`)
    return parts.join(' ｜ ')
  })
  return lines.join('\n')
}
