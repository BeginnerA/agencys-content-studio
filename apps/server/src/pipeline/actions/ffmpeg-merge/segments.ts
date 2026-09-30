import { statSync } from 'node:fs'
import { absPathOf } from '../../../services/storage'
import { probeMediaDuration } from '../../../services/ffmpeg'
import { shotDurationSec } from '../../../services/shot'
import { QUALITY_TEXT, type ImageQualityReason } from '../../../services/image-check'
import type { Asset } from '../../../db/schema'
import type { StepContext } from '../../context'

export interface Segment {
  id: number
  path: string
  kind: 'image' | 'video'
  durSec: number
  /** 静态图：时长来自分镜 per-shot 覆盖（fit_voice 显式优先依据） */
  explicit?: boolean
  /** 动效片：时长未知按 duration_per_shot 估算（日志溯源） */
  estimated?: boolean
  /** M54 collage 拼贴段成员本地路径（path 恒 = paths[0]；仅 phase-1 消费，缺省 = 单图段） */
  paths?: string[]
  /** M61 标题字卡段（片首本地渲染 PNG）：phase-1 免 Ken Burns（防文字 zoompan 裁切出框），溯源 images 计数排除 */
  card?: boolean
}

/**
 * 镜头段组装（纯函数；探针直测）——段组装 + 时长决策 + 容错判定收敛于此：
 * - 缺本地文件 / 文件缺失 / kind 不符 → skipped（不再整体失败；全 skip 由调用方拦抛）；
 * - 静态图：分镜 per-shot 覆盖优先（explicit 标记）→ duration_per_shot；
 * - 动效片：asset.duration → ffprobe → duration_per_shot 估算（estimated 标记）；
 * - mixed（M53 混剪）：按行 kind 分流——image 行走图片语义、video 行走视频语义、其余 skip。
 */
export function computeShotSegments(
  rows: Asset[],
  mode: 'images' | 'clips' | 'mixed',
  perShotDur: Map<string, number>,
  durationPerShot: number,
): { segments: Segment[]; skipped: number[]; warnings: string[] } {
  const segments: Segment[] = []
  const skipped: number[] = []
  const warnings: string[] = []
  for (const a of rows) {
    if (!a.relPath) {
      skipped.push(a.id)
      continue
    }
    const path = absPathOf(a.relPath)
    try {
      statSync(path)
    } catch {
      skipped.push(a.id)
      continue
    }
    if (mode === 'images' || (mode === 'mixed' && a.kind === 'image')) {
      if (a.kind !== 'image') {
        skipped.push(a.id)
        continue
      }
      // 图像检测异常警示（仅警告；不阻断用户已选中的图）
      const warn = qualityWarning(a)
      if (warn) warnings.push(warn)
      const shotId = shotIdOfAsset(a)
      const override = shotId !== null ? perShotDur.get(shotId) : undefined
      segments.push({ id: a.id, path, kind: 'image', durSec: override ?? durationPerShot, explicit: override !== undefined })
    } else if (mode === 'clips' || mode === 'mixed') {
      if (a.kind !== 'video') {
        skipped.push(a.id)
        continue
      }
      let dur: number | null = typeof a.duration === 'number' && a.duration > 0 ? a.duration : null
      let estimated = false
      if (dur === null) {
        dur = probeMediaDuration(path)
        if (dur === null) {
          dur = durationPerShot
          estimated = true
        }
      }
      segments.push({ id: a.id, path, kind: 'video', durSec: dur, estimated })
    } else {
      skipped.push(a.id)
    }
  }
  return { segments, skipped, warnings }
}

/**
 * M54 多图同屏拼贴分组（纯函数；探针直测）：single → 原样同引用（零 diff）；
 * 仅连续图片段成组，视频段原样透传且充当组边界；拼屏段 durSec = durationPerShot、explicit=false。
 *  - duo：相邻两图并排（奇数末段保持单图）；grid：四四合并（余 1 单、余 2/3 降级 duo/三拼）；
 *  - auto：图片总数 <4 全单图；≥4 首尾单图 hero，中间每 3 张一组（不足 3 降级）。
 */
export function planCollageSegments(
  segments: Segment[],
  layout: 'single' | 'duo' | 'grid' | 'auto',
  durationPerShot: number,
): Segment[] {
  if (layout === 'single') return segments
  const isStill = (s: Segment) => s.kind === 'image'
  const combine = (group: Segment[]): Segment =>
    group.length === 1 ? group[0]! : {
      id: group[0]!.id,
      path: group[0]!.path,
      paths: group.map((s) => s.path),
      kind: 'image',
      durSec: durationPerShot,
      explicit: false,
    }
  // 分段：连续图片段游程与视频段交替
  const out: Segment[] = []
  let i = 0
  const flushRun = (run: Segment[]): void => {
    if (layout === 'duo') {
      for (let j = 0; j < run.length; j += 2) out.push(combine(run.slice(j, j + 2)))
      return
    }
    if (layout === 'grid') {
      for (let j = 0; j < run.length; j += 4) {
        const chunk = run.slice(j, j + 4)
        // 余 1 保持单图；余 2/3 降级 duo/三拼（combine 统一成段）
        if (chunk.length === 1) out.push(chunk[0]!)
        else out.push(combine(chunk))
      }
      return
    }
    // auto：全量游程上首尾 hero + 中间三三组（调用方按总图数 <4 先短路）
    if (run.length < 4) { out.push(...run); return }
    out.push(run[0]!)
    const mid = run.slice(1, -1)
    for (let j = 0; j < mid.length; j += 3) {
      const chunk = mid.slice(j, j + 3)
      if (chunk.length === 1) out.push(chunk[0]!)
      else out.push(combine(chunk))
    }
    out.push(run[run.length - 1]!)
  }
  while (i < segments.length) {
    if (!isStill(segments[i]!)) { out.push(segments[i]!); i++; continue }
    let j = i
    while (j < segments.length && isStill(segments[j]!)) j++
    const run = segments.slice(i, j)
    if (layout === 'auto' && run.length < 4) out.push(...run)
    else flushRun(run)
    i = j
  }
  return out
}

/**
 * M54 G3 拼贴分组应用（自 index.ts 拆出：≤800 行红线，行为零变更）：混剪态 layout≠single →
 * 连续图片段就地分组（segments 原地替换），视频段透传充当边界；拼屏段吃 duration_per_shot 时长契约。
 * 音字对齐时间轴启用时保持单图；layout 默认 single / 非混剪态 → 同引用透传，段列与 M53 逐字节一致。
 */
export function applyCollageLayout(opts: {
  segments: Segment[]
  montageOn: boolean
  hasAlignPlan: boolean
  layoutRaw: string
  durationPerShot: number
  log: (msg: string) => void
}): { collageLayout: 'single' | 'duo' | 'grid' | 'auto'; collageCount: number } {
  let collageLayout: 'single' | 'duo' | 'grid' | 'auto' = ['duo', 'grid', 'auto'].includes(opts.layoutRaw)
    ? (opts.layoutRaw as 'duo' | 'grid' | 'auto')
    : 'single'
  let collageCount = 0
  if (opts.montageOn && collageLayout !== 'single') {
    if (opts.hasAlignPlan) {
      opts.log(`拼贴版式 ${collageLayout} 未启用（音字对齐时间轴生效中，保持单图）`)
      collageLayout = 'single'
    } else {
      const planned = planCollageSegments(opts.segments, collageLayout, opts.durationPerShot)
      collageCount = planned.filter((s) => s.paths && s.paths.length > 1).length
      if (collageCount > 0) {
        opts.segments.length = 0
        opts.segments.push(...planned)
        opts.log(`拼贴段启用（${collageLayout}）：分组后 ${planned.length} 段，其中多图同屏 ${collageCount} 段`)
      }
    }
  }
  return { collageLayout, collageCount }
}

/** 图像检测异常警示（params.quality.ok === false；缺失/坏数据 → null） */
function qualityWarning(a: Asset): string | null {
  if (!a.params) return null
  try {
    const q = (JSON.parse(a.params) as { quality?: { ok?: unknown; reason?: unknown } }).quality
    if (!q || q.ok !== false) return null
    const reason = typeof q.reason === 'string' ? q.reason : 'unknown'
    return `镜头产物 asset#${a.id} 疑似异常图（${QUALITY_TEXT[reason as ImageQualityReason] ?? reason}），已按选中继续合成`
  } catch {
    return null
  }
}

/** shots（分镜 JSON 原始文本）→ per-shot 时长表（裸数组 / {shots:[]}；duration 优先回退 duration_sec；非法条目跳过） */
export function parseShotDurations(raw: string): Map<string, number> {
  const map = new Map<string, number>()
  const obj = JSON.parse(raw) as unknown
  const arr = Array.isArray(obj) ? obj : (obj as { shots?: unknown }).shots
  if (!Array.isArray(arr)) return map
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue
    const o = s as Record<string, unknown>
    const id = o['id']
    if (typeof id !== 'string' || !id) continue
    const dur = shotDurationSec(o)
    if (dur != null) map.set(id, dur)
  }
  return map
}

/** shots（分镜 JSON）→ per-shot 时长覆盖表（解析失败 → 空表 + 日志；无输入 → 空表） */
export async function loadPerShotDurations(ctx: StepContext, shotsIds: number[]): Promise<Map<string, number>> {
  if (shotsIds.length === 0) return new Map()
  try {
    return parseShotDurations(await ctx.readText(shotsIds[0]!))
  } catch (err) {
    ctx.log(`分镜时长覆盖解析失败（回退全局 duration_per_shot）：${(err as Error).message}`)
    return new Map()
  }
}

/** 资产 params.shotId（分镜时长覆盖匹配键，与 ai_image/ai_video 产物口径一致） */
export function shotIdOfAsset(a: Asset): string | null {
  if (!a.params) return null
  try {
    const p = JSON.parse(a.params) as { shotId?: unknown }
    return typeof p.shotId === 'string' && p.shotId ? p.shotId : null
  } catch {
    return null
  }
}

/** 配音资产 params.lineId（tts 产物句 id） */
export function lineIdOfVoiceAsset(a: Asset): string | null {
  if (!a.params) return null
  try {
    const p = JSON.parse(a.params) as { lineId?: unknown }
    return typeof p.lineId === 'string' && p.lineId ? p.lineId : null
  } catch {
    return null
  }
}

/**
 * [统一时轴] motion：从已算 clip 段构造 shotId → clip 实测时长（供 planBestEffortTimeline mode:'motion'
 * 按真实 clip 时长作时间轴基准，不拉伸；仅借 lineIds 将字幕平移到 clip 累计轴）。无 shotId/无段 → 不入表。
 */
export function buildClipDurByShotId(segments: Segment[], rows: Asset[]): Map<string, number> {
  const segByAsset = new Map(segments.map((s) => [s.id, s]))
  const out = new Map<string, number>()
  for (const a of rows) {
    const sid = shotIdOfAsset(a)
    const seg = segByAsset.get(a.id)
    if (sid && seg) out.set(sid, seg.durSec)
  }
  return out
}
