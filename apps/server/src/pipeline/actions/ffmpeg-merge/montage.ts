/**
 * 混剪态（photo-montage + 智能增强）：两段式合成的 phase-1 与触发判定。
 * - 触发（montageEnabled 纯函数）：params.montage=true / 镜头序列混排（图+视并存）/
 *   keep_clip_audio=true / ken_burns≠none（含 auto 档）；strict_delivery 下恒 false（批准链逐字节红线）。
 * - phase-1（normalizeSegmentsToClips）：逐段归一化为「定长 + 同尺寸/fps + 必带音轨」的临时 mp4——
 *   图片段 zoompan（Ken Burns，单帧产出 d=fps×dur）或定长静帧 + anullsrc 静音轨；
 *   视频段 trim/tpad 精确截长 + 原声（缺 a 流探测后 anullsrc 兜底）。
 * - 智能增强：kb:auto 按照片横竖比定缓推/缓拉方向；构图锚点（LLM composition 分类）偏置 zoompan x/y；
 *   collage 拼贴段（seg.paths 多成员）先 xstack 成整屏再走同一归一链；BGM 库内选曲 pickBgm 纯函数。
 * - phase-2 由 buildComposeArgs({ montage: true }) 消费：段全部按 -i 直读 + 轻滤镜，
 *   per-seg [i:a] 拼为连续现场轨参与既有 BGM/SFX 混音收口。
 * 零 diff 红线：未触发混剪 → index 不进本模块，legacy 单段链逐字节不变；
 *   智能增强新键缺省（kb 非 auto / 无 paths / 无 anchor）→ 表达式与 args 逐字节 = 混剪基线。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { resolveFfprobe } from '../../../services/ffmpeg'
import { round3 } from './util'
import type { Segment } from './segments'
import type { StepContext } from '../../context'
import type { Asset } from '../../../db/schema'

export type KenBurns = 'none' | 'in' | 'out' | 'alternate' | 'auto'

/** 混剪触发判定（纯函数；探针直测真值表） */
export function montageEnabled(params: Record<string, unknown>, opts: { hasMixed: boolean; hasVideoSeg: boolean; strict: boolean }): boolean {
  if (opts.strict) return false
  if (params['montage'] === false) return false
  if (params['montage'] === true) return true
  if (opts.hasMixed) return true
  if (params['keep_clip_audio'] === true && opts.hasVideoSeg) return true
  const kb = typeof params['ken_burns'] === 'string' && params['ken_burns'] ? params['ken_burns'] : 'none'
  return kb !== 'none'
}

/** 输入文件是否含音频流；ffprobe 不可用/探测失败 → null（调用方按有 a 流宽容，trim/apad 兜底） */
export function probeHasAudioStream(file: string): boolean | null {
  const ffprobe = resolveFfprobe()
  if (!ffprobe) return null
  try {
    const r = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    if (r.error || r.status !== 0) return null
    return String(r.stdout ?? '').trim().length > 0
  } catch {
    return null
  }
}

/** kb:auto 方向提示：图片实测宽高（缺一维 → null 宽容推近） */
export interface KbHint { w: number | null; h: number | null }
/** zoompan 锚点权重（1 = 现行居中形态；x 0.7 偏左/1.3 偏右，y 同理） */
export interface KbAnchor { xw: number; yw: number }

/** Ken Burns 方向（alternate：偶数镜推近、奇数镜拉远，下标从 0 计；auto：横图/方形推近、竖图拉远） */
export function kbDirectionFor(mode: KenBurns, index: number, hint?: KbHint): 'in' | 'out' | null {
  if (mode === 'in' || mode === 'out') return mode
  if (mode === 'alternate') return index % 2 === 0 ? 'in' : 'out'
  if (mode === 'auto') {
    if (!hint || hint.w === null || hint.h === null || hint.h <= 0) return 'in'
    const ratio = hint.w / hint.h
    // 阈值对称带：横图（≥1.05）缓推沉浸、竖图（≤1/1.05）缓拉舒展、方形/近方推近
    return ratio >= 1.05 || ratio <= 1 / 1.05 ? (ratio >= 1.05 ? 'in' : 'out') : 'in'
  }
  return null
}

/** LLM composition 文本 → 主体方位三分（纯函数；关键词中英文容错，无法判定 → center） */
export function classifyAnchor(text: string | null | undefined): 'left' | 'right' | 'center' {
  const t = (text ?? '').toLowerCase()
  if (!t) return 'center'
  const left = /左|偏左|left/.test(t)
  const right = /右|偏右|right/.test(t)
  if (left && !right) return 'left'
  if (right && !left) return 'right'
  return 'center'
}

/** 方向 + 主体方位 → zoompan 锚点权重（纯函数）：center/无信息 → null（现行居中公式逐字节）；
 *  in 推向主体侧（权重向主体收敛 0.7/1.3）、out 由主体拉远（反向 1.3/0.7） */
export function kbAnchorFor(dir: 'in' | 'out', subject: 'left' | 'right' | 'center'): KbAnchor | null {
  if (subject === 'center') return null
  const toward = dir === 'in' ? 0.7 : 1.3
  const away = dir === 'in' ? 1.3 : 0.7
  return subject === 'left' ? { xw: toward, yw: 1 } : { xw: away, yw: 1 }
}

/** 多成员 composition → 主体方位多数决（纯函数）：左/右严格多数才偏移，平票/无信息 → center */
export function voteSubject(texts: Array<string | null | undefined>): 'left' | 'right' | 'center' {
  let left = 0
  let right = 0
  for (const t of texts) {
    const c = classifyAnchor(t)
    if (c === 'left') left++
    else if (c === 'right') right++
  }
  if (left > right) return 'left'
  if (right > left) return 'right'
  return 'center'
}

/** 图片实测宽高（ffprobe 唯一事实源：source 图片资产 width/height 不保证填充）；失败 → null 宽容 */
export function probeImageSize(file: string): { w: number; h: number } | null {
  const ffprobe = resolveFfprobe()
  if (!ffprobe) return null
  try {
    const r = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    if (r.error || r.status !== 0) return null
    const m = /^(\d+)x(\d+)\s*$/.exec(String(r.stdout ?? '').trim())
    if (!m) return null
    const w = Number(m[1]); const h = Number(m[2])
    return w > 0 && h > 0 ? { w, h } : null
  } catch {
    return null
  }
}

/** BGM 候选（库内自动选曲输入；durationSec null = 探测失败，排最后；moodVec = 情绪向量，缺则纯时长候选） */
export interface BgmCandidate { id: number; path: string; durationSec: number | null; updatedAt: number; moodVec?: number[] | null }

/** 余弦（向量已 normalize → 点积）；任一侧缺失 → null（本地实现，避免 montage 依赖重 embedding 模块） */
function cosSim(a: number[] | null | undefined, b: number[] | null | undefined): number | null {
  if (!a || !b || a.length === 0 || b.length === 0) return null
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!
  return s
}

/** 情绪排序比较（升序 comparator）：两侧都有分数→高者前（b-a）；一侧 null→有者前；都 null→0（回落原序，零 diff） */
function moodRankCmp(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return b - a
}

/** 选曲规则（纯函数）：时长 ≥ 片长优先分档（硬约束）→ 档内情绪 cosine 降序 → 片长差 → updated_at desc；0 候选 → null。
 *  零 diff 红线：opts.moodVec 为空 或 全体候选 moodVec=null → 情绪比较恒为 0，排序逐字节 = 旧版（时长+时效）。 */
export function pickBgm(candidates: BgmCandidate[], totalSec: number, opts?: { moodVec?: number[] | null }): BgmCandidate | null {
  if (candidates.length === 0) return null
  const moodVec = opts?.moodVec ?? null
  const scored = candidates.map((c, i) => ({ c, i, mood: moodVec ? cosSim(moodVec, c.moodVec) : null }))
  scored.sort((a, b) => {
    const sa = a.c.durationSec; const sb = b.c.durationSec
    const fa = sa !== null && sa >= totalSec ? 0 : 1
    const fb = sb !== null && sb >= totalSec ? 0 : 1
    if (fa !== fb) return fa - fb
    const cmpMood = moodRankCmp(a.mood, b.mood)
    if (cmpMood !== 0) return cmpMood
    if (fa === 0) return (sa! - totalSec) - (sb! - totalSec) || b.c.updatedAt - a.c.updatedAt
    const da = sa === null ? Infinity : Math.abs(sa - totalSec)
    const db = sb === null ? Infinity : Math.abs(sb - totalSec)
    if (da !== db) return da - db
    return b.c.updatedAt - a.c.updatedAt
  })
  return scored[0]!.c
}

/** MONTAGE_BGM_DIR 曲库目录扫描（mp3/m4a/wav/flac 普通文件）；env 未设/目录不存在 → []（不抛错） */
export function scanBgmLibrary(dir: unknown): Array<{ name: string; abs: string }> {
  if (typeof dir !== 'string' || !dir.trim()) return []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: Array<{ name: string; abs: string }> = []
  for (const name of entries.sort()) {
    if (!/\.(mp3|m4a|wav|flac)$/i.test(name)) continue
    const abs = join(dir, name)
    try {
      if (!statSync(abs).isFile()) continue
    } catch {
      continue
    }
    out.push({ name, abs })
  }
  return out
}

/** 归一化目标尺寸与图段超采样底尺寸（×2 冗余抑制 zoompan 亚像素抖动） */
export function normalizeSizes(width: number, height: number): { ssW: number; ssH: number } {
  return { ssW: width * 2, ssH: height * 2 }
}

/** phase-1 单段归一 args（纯函数；探针直测 filter 形状）：产物定长 dur + 同尺寸/fps + 必带音轨；
 *  seg.paths 多成员（collage 拼贴）→ 先各路等分裁切 xstack 成整屏再走同一归一链；
 *  anchor 缺省/null → zoompan x/y 现行居中公式逐字节 */
export function buildNormalizeArgs(seg: Segment, opts: {
  width: number
  height: number
  fps: number
  kb: 'in' | 'out' | null
  anchor?: KbAnchor | null
  clipHasAudio: boolean | null
  outAbs: string
}): string[] {
  const { width, height, fps, kb } = opts
  const dur = round3(seg.durSec)
  const frames = Math.max(1, Math.round(fps * dur))
  // 几何：居中裁切满幅（与 phase-2 legacy 图链同口径 force_original_aspect_ratio=increase + crop）
  const geometry = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
  const aTail = 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo'
  const encTail = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '160k',
    '-t', String(dur), '-movflags', '+faststart', opts.outAbs]

  if (seg.kind === 'image') {
    // zoompan 锚点：权重 1 时表达式逐字节 = 现行居中形态；非 1 插乘数（0.7 偏左/1.3 偏右）
    const xw = opts.anchor?.xw ?? 1
    const yw = opts.anchor?.yw ?? 1
    const xExpr = xw === 1 ? `x='iw-iw/zoom'` : `x='(iw-iw/zoom)*${round3(xw)}'`
    const yExpr = yw === 1 ? `y='ih-ih/zoom'` : `y='(ih-ih/zoom)*${round3(yw)}'`
    // 单帧产出：不 -loop；kb 分支 zoompan d=帧数一次出满段；定帧分支 -frames:v 1 出单帧
    //（两相均物化为视频段入 phase-2；phase-2 montage 对超短段用 tpad clone 撑回 dur，见 args.ts）
    const vChain = kb
      ? (() => {
          const { ssW, ssH } = normalizeSizes(width, height)
          const step = round3(0.25 / frames)
          const z = kb === 'in' ? `min(1+${step}*on,1.25)` : `max(1.25-${step}*on,1)`
          return `scale=${ssW}:${ssH}:force_original_aspect_ratio=increase,crop=${ssW}:${ssH},`
            + `zoompan=z='${z}':d=${frames}:${xExpr}:${yExpr}:s=${width}x${height},`
            + `crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p`
        })()
      : `${geometry},setsar=1,format=yuv420p` // 定帧单输出不带 fps 滤镜：单帧输入经 fps 会被吐成 0 帧（实测 ffmpeg 6.1.1/9.0.1 一致），帧率由 phase-2 tpad+fps 归一
    const members = seg.paths && seg.paths.length > 1 ? seg.paths : null
    if (members) {
      // collage 拼贴段：N 路 -i → 各路等分 cell 裁切 → xstack 整屏 → 接既有 zoompan/定帧链
      const n = members.length
      const cols = n >= 4 ? 2 : 1
      const rowsN = Math.ceil(n / cols)
      const cellW = Math.floor(width / cols / 2) * 2
      const cellH = Math.floor(height / rowsN / 2) * 2
      const cellGeo = `scale=${cellW}:${cellH}:force_original_aspect_ratio=increase,crop=${cellW}:${cellH}`
      // xstack 布局表：duo 横排、四宫格 2x2、3 张上排两张 + 下排居左（不足区域黑底，整屏后再裁）
      const layoutStr = n === 2 ? '0_0|w0_0' : n === 3 ? '0_0|w0_0|0_h0' : '0_0|w0_0|0_h0|w0_h0'
      const stacked = cols === 1
        ? Array.from({ length: n }, (_, i) => `[${i}:v]${cellGeo}[c${i}]`).join(';')
          + `;${Array.from({ length: n }, (_, i) => `[c${i}]`).join('')}vstack=inputs=${n}[tile]`
        : Array.from({ length: n }, (_, i) => `[${i}:v]${cellGeo}[c${i}]`).join(';')
          + `;${Array.from({ length: n }, (_, i) => `[c${i}]`).join('')}xstack=inputs=${n}:layout=${layoutStr}[tile]`
      const fullChain = `[tile]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1${kb ? '' : `,format=yuv420p`}` // 同单图定帧分支：无 kb 时不带 fps（fps 吐单帧）
      const kbFromTile = kb
        ? (() => {
            const step = round3(0.25 / frames)
            const z = kb === 'in' ? `min(1+${step}*on,1.25)` : `max(1.25-${step}*on,1)`
            return `[tile]scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase,crop=${width * 2}:${height * 2},zoompan=z='${z}':d=${frames}:${xExpr}:${yExpr}:s=${width}x${height},crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p`
          })()
        : fullChain
      const audioIdx = n
      return [
        '-y',
        ...members.flatMap((p) => ['-i', p]),
        '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo:d=${dur}`,
        '-filter_complex',
        `${stacked};${kbFromTile}[v];[${audioIdx}:a]${aTail},atrim=duration=${dur}[a]`,
        '-map', '[v]', '-map', '[a]',
        ...(kb ? [] : ['-frames:v', '1']),
        ...encTail,
      ]
    }
    return [
      '-y', '-i', seg.path,
      '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo:d=${dur}`,
      '-filter_complex',
      `[0:v]${vChain}[v];[1:a]${aTail},atrim=duration=${dur}[a]`,
      '-map', '[v]', '-map', '[a]',
      ...(kb ? [] : ['-frames:v', '1']),
      ...encTail,
    ]
  }

  // 视频段：短于目标长 → tpad 末帧克隆/apad 补静音后定长截断；长于目标长 → trim 裁短
  const vChain = `setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${dur},`
    + `trim=duration=${dur},setpts=PTS-STARTPTS,${geometry},setsar=1,fps=${fps},format=yuv420p`
  if (opts.clipHasAudio === false) {
    // 探测确认无音频流 → lavfi 静音轨兜底（保证每段必有 a 流，phase-2 concat 才能 v=1:a=1）
    return [
      '-y', '-i', seg.path,
      '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo:d=${dur}`,
      '-filter_complex',
      `[0:v]${vChain}[v];[1:a]${aTail},atrim=duration=${dur}[a]`,
      '-map', '[v]', '-map', '[a]',
      ...encTail,
    ]
  }
  // 有原声（含探测失败宽容）：apad 补短/裁长保原声
  return [
    '-y', '-i', seg.path,
    '-filter_complex',
    `[0:v]${vChain}[v];[0:a]${aTail},apad=whole_dur=${dur},atrim=duration=${dur}[a]`,
    '-map', '[v]', '-map', '[a]',
    ...encTail,
  ]
}

/** phase-1 执行：逐段归一化 → 新 segments（kind 统一 'video'、path=临时 mp4、collage 段成员计数随 origPaths 留存；临时件返回 cleanup）。
 *  kb=auto 逐段 resolveHint 实测宽高定方向；anchors 供构图锚点偏置（缺省 null → 居中公式逐字节） */
export async function normalizeSegmentsToClips(
  ctx: StepContext,
  ffmpeg: string,
  segments: Segment[],
  opts: {
    width: number
    height: number
    fps: number
    kb: KenBurns
    outDir: string
    resolveHint?: (seg: Segment) => KbHint | null
    anchors?: Array<KbAnchor | null | undefined>
  },
): Promise<{ segments: Segment[]; temps: string[]; collageSegments: number; kbApplied: number }> {
  const stamp = Date.now()
  const out: Segment[] = []
  const temps: string[] = []
  let collageSegments = 0
  let kbApplied = 0
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    const tmp = join(opts.outDir, `.mseg-${ctx.run.id}-${ctx.step.id}-${i}-${stamp}.mp4`)
    // kb:auto 档：逐段按实测宽高定方向（resolveHint 缺失/探测失败 → null 宽容推近）
    const hint = seg.kind === 'image' && opts.kb === 'auto' ? opts.resolveHint?.(seg) ?? null : null
    // 字卡段免 Ken Burns（静态卡面 zoompan 会把标题文字裁出框）
    const kb = seg.kind === 'image' && !seg.card ? kbDirectionFor(opts.kb, i, hint ?? undefined) : null
    const anchor = kb ? opts.anchors?.[i] ?? null : null
    const clipHasAudio = seg.kind === 'video' ? probeHasAudioStream(seg.path) : null
    if (kb) kbApplied++
    if (seg.paths && seg.paths.length > 1) collageSegments++
    const args = buildNormalizeArgs(seg, { width: opts.width, height: opts.height, fps: opts.fps, kb, anchor, clipHasAudio, outAbs: tmp })
    ctx.log(`混剪归一化 ${i + 1}/${segments.length}（${seg.kind === 'image' ? `${seg.card ? '标题字卡段' : seg.paths && seg.paths.length > 1 ? `拼贴段 x${seg.paths.length}` : '图片段'}${kb ? ` + Ken Burns ${opts.kb === 'auto' ? `auto→${kb}` : kb}` : ''}` : `视频段${clipHasAudio === false ? '（无原声，补静音）' : ''}`}）：${seg.durSec}s`)
    try {
      const r = spawnSync(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 600_000, windowsHide: true })
      if (r.status !== 0) {
        const err = (r.stderr?.toString('utf8') ?? '').split('\n').filter(Boolean).slice(-3).join(' | ')
        throw new Error(`混剪归一化第 ${i + 1} 段失败：${err || `ffmpeg exit=${r.status}`}`)
      }
    } catch (e) {
      for (const t of temps) { try { unlinkSync(t) } catch { /* 清理失败忽略 */ } }
      throw e instanceof Error && e.message.startsWith('混剪归一化') ? e : new Error(`混剪归一化第 ${i + 1} 段失败：${(e as Error).message}`)
    }
    temps.push(tmp)
    out.push({ id: seg.id, path: tmp, kind: 'video', durSec: seg.durSec, explicit: seg.explicit })
  }
  return { segments: out, temps, collageSegments, kbApplied }
}

/**
 * 混剪态 phase-1 驱动（自 index.ts 拆出：≤800 行红线，行为零变更）：kb 参数解析 +
 * kb:auto 实测宽高提示缓存（按段 id，锚点推导复用同一探测）+ 构图锚点（仅
 * analyze_composition=true 且 composition 产物存在；关闭/缺产物/解析失败 → anchors 不设，
 * zoompan x/y 表达式逐字节 = 居中公式）+ 逐段归一化执行。调用方仅在 montageOn 时进入。
 */
export async function runMontagePhase1(opts: {
  ctx: StepContext
  ffmpeg: string
  params: Record<string, unknown>
  segments: Segment[]
  rows: Asset[]
  width: number
  height: number
  fps: number
  outDir: string
}): Promise<{ segments: Segment[]; temps: string[]; kb: KenBurns; kbApplied: number }> {
  const { ctx, params, segments, rows } = opts
  const kbRaw = typeof params['ken_burns'] === 'string' && params['ken_burns'] ? params['ken_burns'] : 'none'
  const kb = (['in', 'out', 'alternate', 'auto'].includes(kbRaw) ? kbRaw : 'none') as KenBurns
  // kb:auto：ffprobe 实测宽高为方向唯一事实源（按段 id 缓存，锚点推导复用同一探测）
  const hintById = new Map<number, KbHint | null>()
  const resolveHint = (seg: Segment): KbHint | null => {
    if (!hintById.has(seg.id)) hintById.set(seg.id, seg.kind === 'image' ? probeImageSize(seg.path) : null)
    return hintById.get(seg.id) ?? null
  }
  let anchors: Array<KbAnchor | null | undefined> | undefined
  if (params['analyze_composition'] === true && kb !== 'none') {
    const compIds = ctx.assetIdsOf('composition')
    if (compIds.length > 0) {
      try {
        const parsed = JSON.parse(await ctx.readText(compIds[0]!)) as { images?: Array<{ file?: string; subject?: string; composition?: string }> }
        const subjectByName = new Map<string, 'left' | 'right' | 'center'>()
        for (const it of parsed.images ?? []) {
          if (it.file) subjectByName.set(it.file.toLowerCase(), voteSubject([it.composition, it.subject]))
        }
        anchors = segments.map((seg, i) => {
          if (seg.kind !== 'image') return null
          const name = rows.find((r) => r.id === seg.id)?.name?.toLowerCase()
          const subject = name ? subjectByName.get(name) : undefined
          if (!subject) return null
          const dir = kbDirectionFor(kb, i, resolveHint(seg) ?? undefined) ?? 'in'
          return kbAnchorFor(dir, subject)
        })
        ctx.log(`构图锚点启用：${anchors.filter((a) => a).length}/${segments.length} 段主体偏置（analyze_composition）`)
      } catch (err) {
        ctx.log(`构图锚点解析失败（保持居中，不影响合成）：${(err as Error).message}`)
      }
    } else {
      ctx.log('analyze_composition=true 但 composition 输入无产物（analyze 步未跑或被跳过），保持居中锚点')
    }
  }
  ctx.log(`混剪态启用：${segments.length} 段归一化（照片 ${segments.filter((s) => s.kind === 'image').length} + 视频 ${segments.filter((s) => s.kind === 'video').length}，Ken Burns ${kb}${params['keep_clip_audio'] === true ? '，原声保留' : ''}）`)
  const norm = await normalizeSegmentsToClips(ctx, opts.ffmpeg, segments, {
    width: opts.width, height: opts.height, fps: opts.fps, kb, outDir: opts.outDir, resolveHint, anchors,
  })
  return { segments: norm.segments, temps: norm.temps, kb, kbApplied: norm.kbApplied }
}
