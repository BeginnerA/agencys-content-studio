import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { probeMediaDuration, resolveFfmpeg } from '../../services/ffmpeg'
import { absPathOf, registerAsset, relPathOf } from '../../services/storage'
import { shotDurationSec } from '../../services/shot-workbench'
import { emitStudioEvent } from '../../services/events'
import type { Asset } from '../../db/schema'
import type { StepContext } from '../context'
import type { StepResult } from '../types'

/** 字幕 ASS 风格缺省（字号/边距按输出高度自适应；模板可用 defaults.video.subtitle_style 整体覆盖） */
function defaultSubtitleStyle(height: number): string {
  const fontSize = Math.max(16, Math.round(height * 0.018))
  const marginV = Math.round(height * 0.02)
  const outline = Math.max(1, Math.round(height * 0.0009))
  return (
    `FontName=Noto Sans CJK SC,FontSize=${fontSize},PrimaryColour=&H00FFFFFF,` +
    `OutlineColour=&H00000000,BorderStyle=1,Outline=${outline},Shadow=0,MarginV=${marginV}`
  )
}

/** 数值参数：params → defaults.video（settings）→ fallback */
function numParam(v: unknown, fb: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fb
}

interface Segment {
  id: number
  path: string
  kind: 'image' | 'video'
  durSec: number
  /** [M7] 静态图：时长来自分镜 per-shot 覆盖（fit_voice 显式优先依据） */
  explicit?: boolean
  /** [M7] 动效片：时长未知按 duration_per_shot 估算（日志溯源） */
  estimated?: boolean
}

/**
 * ffmpeg_merge：镜头序列 → 成片 + 封面（spec §5.4 三流合成）。
 * 镜头输入双字段互斥：images（静态图，-loop 1 -t duration_per_shot 定长）或
 * motion_clips（ai_video 产物，按实际时长 concat，不 -t/不 -loop）。
 * 可选 voices（audio 资产序列，逐句 concat 连续轨 → apad/atrim 对齐总时长，aac）；
 * 可选 subtitle（SRT 资产，视频流经 subtitles 滤镜烧录，force_style 参数化）。
 * 时间轴：镜头实际时长优先（video 资产 duration 字段，缺失时 ffprobe 探测兜底）；
 * 静态图回退 duration_per_shot（默认 4s）。产物 tags 增 'with_audio'/'with_subtitle'。
 * fit_voice=true 且为多镜静态图 + 配音时：按配音总长分配每镜时长（成片与音轨等长）。
 * [M7] 可选 shots（分镜 JSON）输入：静态图 per-shot 时长覆盖；逐镜容错（缺文件/类型不符 skip+warn，
 * 全 skip 才失败）；产物 params 增 inputs 快照（stale 检测）与 skipped_shots；fit_voice 显式时长优先。
 */
export async function ffmpegMerge(ctx: StepContext): Promise<StepResult> {
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) {
    throw new Error(
      '未找到可用 ffmpeg：内置二进制与系统 PATH 均不可用；请先在仓库根 pnpm install（重新下载内置二进制），'
      + '或 winget install ffmpeg，或在 .env 设 CSTUDIO_FFMPEG_PATH 指向 ffmpeg.exe',
    )
  }
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const vidCfg = (ctx.settings.video ?? {}) as Record<string, unknown>
  const fps = numParam(params['fps'] ?? vidCfg['fps'], 25)
  const resolution =
    (typeof params['resolution'] === 'string' && params['resolution'])
    || (typeof vidCfg['resolution'] === 'string' && vidCfg['resolution'])
    || '1080x1920'
  const wantCover = params['cover'] === true
  const durationPerShot = numParam(params['duration_per_shot'] ?? vidCfg['duration_per_shot'], 4)

  const m = /^(\d+)x(\d+)$/.exec(resolution)
  if (!m) throw new Error(`resolution 非法: ${resolution}（需 WxH 如 1080x1920）`)
  const width = Number(m[1])
  const height = Number(m[2])

  // 镜头段：images（静态）与 motion_clips（动效）互斥，模板 when 分支保证单路
  const imageIds = ctx.assetIdsOf('images')
  const clipIds = ctx.assetIdsOf('motion_clips')
  if (imageIds.length === 0 && clipIds.length === 0) throw new Error('inputs.images / inputs.motion_clips 均无镜头资产')
  if (imageIds.length > 0 && clipIds.length > 0) {
    throw new Error('images 与 motion_clips 互斥：模板 when 应按 motion 开关只给一路输入')
  }
  const mode: 'images' | 'clips' = imageIds.length > 0 ? 'images' : 'clips'
  const rows = await ctx.assetsOf(mode === 'images' ? imageIds : clipIds)
  if (rows.length === 0) throw new Error('镜头资产均不可用（资产不存在或已删除）')
  // [M7] shots（分镜 JSON）→ per-shot 时长覆盖表（v6 存量 run 无此输入 → 空表 = 行为不变）
  const shotsIds = ctx.assetIdsOf('shots')
  const perShotDur = await loadPerShotDurations(ctx, shotsIds)
  const { segments, skipped } = computeShotSegments(rows, mode, perShotDur, durationPerShot)
  if (skipped.length > 0) {
    for (const id of skipped) {
      const a = rows.find((r) => r.id === id)
      ctx.log(`镜头资产 #${id}（${a?.name ?? '?'}）不可用，已跳过（缺文件或类型不符）`)
    }
    ctx.log(`共跳过 ${skipped.length} 个镜头资产（合成继续；溯源见产物 params.skipped_shots）`)
  }
  if (segments.length === 0) throw new Error('无可用镜头资产（全部缺文件或类型不符），请检查镜头产物后重新合成')
  if (mode === 'clips') {
    for (const seg of segments) {
      if (seg.estimated) ctx.log(`镜头视频 #${seg.id} 时长未知（无 duration 字段且 ffprobe 不可用），按 ${seg.durSec}s 估算`)
    }
  }
  // voices：tts 产物逐句 concat 为连续音轨（不做逐句字幕映射，字幕独立时间轴）
  const voiceIds = ctx.assetIdsOf('voices')
  let voicePaths: string[] = []
  if (voiceIds.length > 0) {
    const vRows = await ctx.assetsOf(voiceIds)
    for (const a of vRows) {
      if (a.kind !== 'audio' || !a.relPath) {
        throw new Error(`voices 资产 #${a.id}（${a.name}）非本地音频`)
      }
      voicePaths.push(absPathOf(a.relPath))
    }
  }

  // subtitle：SRT 文本资产 → subtitles 滤镜烧录（相对路径 + cwd 规避路径转义）
  const subtitleIds = ctx.assetIdsOf('subtitle')
  let srtRelPath: string | null = null
  let srtEndMs = 0
  if (subtitleIds.length > 0) {
    const sRows = await ctx.assetsOf(subtitleIds.slice(0, 1))
    const s = sRows[0]
    if (!s?.relPath) throw new Error(`subtitle 资产 #${subtitleIds[0]} 无本地文件`)
    srtRelPath = s.relPath
    try {
      const p = JSON.parse(s.params ?? '{}') as { durationMs?: number }
      srtEndMs = typeof p['durationMs'] === 'number' ? p['durationMs'] : 0
    } catch {
      // params 损坏不影响烧录
    }
    ctx.log(`烧录字幕 ${basename(srtRelPath)}（SRT 时间轴${srtEndMs ? `，末条结束 ${Math.round(srtEndMs / 1000)}s` : ''}）`)
  } else if (params['subtitle'] === true) {
    ctx.log('subtitle=true 但 inputs.subtitle 无 SRT 资产，已跳过烧录')
  }

  // 口播场景守卫：仅 1 张静态图且带配音/字幕时，底图时长撑到内容实际长度（防尾段冻结/丢内容）——
  // [M7] 基准取「该镜当前时长」（分镜显式覆盖 ?? 全局）；有字幕以字幕末时间（估时）为准；无字幕则实测音频总长（ffprobe）
  const needStretch = segments.length === 1 && segments[0]!.kind === 'image' && (voicePaths.length > 0 || srtEndMs > 0)
  if (needStretch && voicePaths.length > 0 && srtEndMs <= 0) {
    let voiceSec = 0
    for (const p of voicePaths) {
      const d = probeMediaDuration(p)
      if (d !== null) voiceSec += d
      else ctx.log(`配音句时长探测失败（跳过撑长）：${p}`)
    }
    if (voiceSec > 0) srtEndMs = Math.ceil(voiceSec) * 1000
  }
  if (needStretch && srtEndMs > 0) {
    const baseDur = segments[0]!.durSec
    const stretched = Math.max(baseDur, Math.ceil(srtEndMs / 1000) + 1)
    if (stretched > baseDur) {
      ctx.log(`口播底图单张，时长由 ${baseDur}s 撑至 ${stretched}s（对齐配音/字幕，防尾段冻结）`)
      segments[0]!.durSec = stretched
    }
  }

  // fit_voice：多镜静态图 + 配音 → 按配音总长分配每镜时长（成片与音轨等长，消除尾部静音/末帧定格）——
  // [M7] 显式优先：分镜 JSON 指定时长（explicit）的镜固定不参与均分，剩余配音时长均分给无显式镜；
  // 全部显式 → 跳过均分；剩余 ≤0 或探测失败 → 放弃适配回退（flex 镜保留全局时长）；
  // 仅 images 模式生效（motion_clips 为真实时长不可拉伸）；单张静态图走上方口播撑长，不重复适配。
  if (
    params['fit_voice'] === true &&
    !needStretch &&
    segments.length > 1 &&
    segments.every((s) => s.kind === 'image') &&
    voicePaths.length > 0
  ) {
    let voiceSec = 0
    let probeOk = true
    for (const p of voicePaths) {
      const d = probeMediaDuration(p)
      if (d === null) {
        probeOk = false
        break
      }
      voiceSec += d
    }
    if (!probeOk || voiceSec <= 0) {
      ctx.log('fit_voice 未生效：配音时长探测失败，回退 duration_per_shot')
    } else {
      const explicitSegs = segments.filter((s) => s.explicit)
      const flexSegs = segments.filter((s) => !s.explicit)
      if (flexSegs.length === 0) {
        ctx.log('fit_voice 跳过：全部分镜已指定时长（固定时长优先，不做均分）')
      } else {
        const explicitSec = explicitSegs.reduce((s, seg) => s + seg.durSec, 0)
        const remain = voiceSec - explicitSec
        if (remain <= 0) {
          ctx.log(`fit_voice 未生效：显式时长合计 ${explicitSec.toFixed(2)}s 已达/超过配音总长 ${voiceSec.toFixed(2)}s，回退`)
        } else {
          const per = Math.round((remain / flexSegs.length) * 1000) / 1000
          for (const seg of flexSegs) seg.durSec = per
          ctx.log(
            `fit_voice：显式 ${explicitSegs.length} 镜固定（${explicitSec.toFixed(2)}s），剩余 ${flexSegs.length} 镜按配音剩余 ${remain.toFixed(2)}s 均分（每镜 ${per}s）`,
          )
        }
      }
    }
  }

  const total = segments.reduce((s, seg) => s + seg.durSec, 0)
  const coveredCount = segments.filter((s) => s.explicit).length
  ctx.log(
    segments[0]!.kind === 'image'
      ? `合成 ${segments.length} 张镜头图 → ${width}x${height}@${fps}fps（总 ${total}s${coveredCount > 0 ? `，其中 ${coveredCount} 张按分镜指定时长` : `，每张 ${durationPerShot}s`}）`
      : `合成 ${segments.length} 段镜头视频 → ${width}x${height}@${fps}fps（按实际时长，总 ${total}s）`,
  )
  if (voicePaths.length > 0) ctx.log(`混流 ${voicePaths.length} 句配音轨（连续拼接${needStretch ? '' : `，对齐总时长 ${total}s`}）`)
  const style = ((typeof params['subtitle_style'] === 'string' && params['subtitle_style'])
    || (typeof vidCfg['subtitle_style'] === 'string' && vidCfg['subtitle_style'])
    || defaultSubtitleStyle(height)).replace(/['"]/g, '')

  const runInput = JSON.parse(ctx.run.input) as Record<string, unknown>
  const ep = String(runInput['episode_number'] ?? Date.now()).padStart(3, '0')
  const outName = `ep${ep}-final-${Date.now()}.mp4`
  const outRel = relPathOf(ctx.run.projectId, 'final_video', outName)
  const outAbs = absPathOf(outRel)

  // 组装 filter_complex：段归一 → concat → [basev]；(字幕) → subtitles → [outv]；voices → [outa]
  const inputArgs: string[] = []
  const fcParts: string[] = []
  segments.forEach((seg, i) => {
    if (seg.kind === 'image') {
      inputArgs.push('-loop', '1', '-t', String(seg.durSec), '-i', seg.path)
    } else {
      inputArgs.push('-i', seg.path)
    }
    fcParts.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p[v${i}]`,
    )
  })
  const segIn = segments.map((_, i) => `[v${i}]`).join('')
  const totalStr = String(Math.round(total * 1000) / 1000)
  const hasAudio = voicePaths.length > 0
  if (hasAudio) {
    voicePaths.forEach((p, i) => {
      inputArgs.push('-i', p)
      const srcIdx = segments.length + i
      fcParts.push(`[${srcIdx}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`)
    })
    const aIn = voicePaths.map((_, i) => `[a${i}]`).join('')
    // 连续轨：apad 补静音到视频总长；音频超长不裁剪（口播超时保内容，输出时长自然取 max）
    fcParts.push(`${aIn}concat=n=${voicePaths.length}:v=0:a=1,apad=whole_dur=${totalStr}[outa]`)
  }
  const videoOut = srtRelPath ? 'outv' : 'basev'
  fcParts.push(`${segIn}concat=n=${segments.length}:v=1:a=0[basev]`)
  if (srtRelPath) {
    fcParts.push(
      `[basev]subtitles='${basename(srtRelPath)}':force_style='${style}'[outv]`,
    )
  }

  const maps = ['-map', `[${videoOut}]`]
  const encAudio: string[] = []
  if (hasAudio) {
    maps.push('-map', '[outa]')
    encAudio.push('-c:a', 'aac', '-b:a', '192k')
  }
  const args = [
    '-y',
    ...inputArgs,
    '-filter_complex',
    fcParts.join(';'),
    ...maps,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-r', String(fps),
    ...encAudio,
    '-movflags', '+faststart',
    outAbs,
  ]
  // subtitles filter 以相对路径（文件名）引用 SRT → cwd 指向其所在目录
  const cwd = srtRelPath ? dirname(absPathOf(srtRelPath)) : undefined

  ctx.log(`ffmpeg 开始合成（${segments.length} 段${hasAudio ? ' + 音频轨' : ''}${srtRelPath ? ' + 字幕' : ''}）…`)
  await runFfmpeg(ctx, ffmpeg, args, cwd)
  const size = statSync(outAbs).size

  const tags = ['final']
  if (hasAudio) tags.push('with_audio')
  if (srtRelPath) tags.push('with_subtitle')
  const videoAsset = await registerAsset(ctx.run.projectId, {
    runId: ctx.run.id,
    name: outName,
    kind: 'video',
    purpose: 'final_video',
    relPath: outRel,
    mime: 'video/mp4',
    ext: 'mp4',
    fileSize: size,
    width,
    height,
    duration: Math.round(total),
    params: {
      fps,
      resolution,
      images: segments.filter((s) => s.kind === 'image').length,
      motion_clips: segments.filter((s) => s.kind === 'video').length,
      voices: voicePaths.length,
      subtitle: srtRelPath ? 1 : 0,
      subtitle_style: style,
      duration: Math.round(total * 1000) / 1000,
      // [M7] 输入快照（stale 检测数据源：与 output.asset_ids 同口径）+ 容错溯源（旧键全部保留不动）
      inputs: {
        images: mode === 'images' ? imageIds : null,
        motion_clips: mode === 'clips' ? clipIds : null,
        shots_source: shotsIds[0] ?? null,
      },
      skipped_shots: skipped,
    },
    tags,
    stepId: ctx.step.id,
  })
  ctx.log(`成片落盘 asset#${videoAsset.id} → ${outRel}（${Math.round(size / 1024 / 1024)} MB${hasAudio ? '，含音轨' : ''}${srtRelPath ? '，含字幕' : ''}）`)

  const assetIds = [videoAsset.id]
  if (wantCover) {
    const coverName = `ep${ep}-cover-${Date.now()}.jpg`
    const coverRel = relPathOf(ctx.run.projectId, 'thumbnail', coverName)
    const coverAbs = absPathOf(coverRel)
    await runFfmpeg(ctx, ffmpeg, ['-y', '-ss', '0.2', '-i', outAbs, '-frames:v', '1', '-q:v', '3', coverAbs])
    const coverAsset = await registerAsset(ctx.run.projectId, {
      runId: ctx.run.id,
      name: coverName,
      kind: 'image',
      purpose: 'thumbnail',
      relPath: coverRel,
      mime: 'image/jpeg',
      ext: 'jpg',
      fileSize: statSync(coverAbs).size,
      params: { sourceVideo: videoAsset.id },
      tags: ['cover'],
      stepId: ctx.step.id,
    })
    assetIds.push(coverAsset.id)
    ctx.log(`封面提取完成 asset#${coverAsset.id}`)
  }
  return { assetIds }
}

/**
 * [M7] 镜头段组装（纯函数；探针直测）——段组装 + 时长决策 + 容错判定收敛于此：
 * - 缺本地文件 / 文件缺失 / kind 不符 → skipped（不再整体失败；全 skip 由调用方拦抛）；
 * - 静态图：分镜 per-shot 覆盖优先（explicit 标记）→ duration_per_shot；
 * - 动效片：asset.duration → ffprobe → duration_per_shot 估算（estimated 标记）。
 */
export function computeShotSegments(
  rows: Asset[],
  mode: 'images' | 'clips',
  perShotDur: Map<string, number>,
  durationPerShot: number,
): { segments: Segment[]; skipped: number[] } {
  const segments: Segment[] = []
  const skipped: number[] = []
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
    if (mode === 'images') {
      if (a.kind !== 'image') {
        skipped.push(a.id)
        continue
      }
      const shotId = shotIdOfAsset(a)
      const override = shotId !== null ? perShotDur.get(shotId) : undefined
      segments.push({ id: a.id, path, kind: 'image', durSec: override ?? durationPerShot, explicit: override !== undefined })
    } else {
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
    }
  }
  return { segments, skipped }
}

/** [M7] shots（分镜 JSON 原始文本）→ per-shot 时长表（裸数组 / {shots:[]}；duration 优先回退 duration_sec；非法条目跳过） */
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

/** [M7] shots（分镜 JSON）→ per-shot 时长覆盖表（解析失败 → 空表 + 日志；无输入 → 空表） */
async function loadPerShotDurations(ctx: StepContext, shotsIds: number[]): Promise<Map<string, number>> {
  if (shotsIds.length === 0) return new Map()
  try {
    return parseShotDurations(await ctx.readText(shotsIds[0]!))
  } catch (err) {
    ctx.log(`分镜时长覆盖解析失败（回退全局 duration_per_shot）：${(err as Error).message}`)
    return new Map()
  }
}

/** 资产 params.shotId（分镜时长覆盖匹配键，与 ai_image/ai_video 产物口径一致） */
function shotIdOfAsset(a: Asset): string | null {
  if (!a.params) return null
  try {
    const p = JSON.parse(a.params) as { shotId?: unknown }
    return typeof p.shotId === 'string' && p.shotId ? p.shotId : null
  } catch {
    return null
  }
}

/** ffmpeg 执行：stderr 逐行 → step.log 事件；非零退出抛错（含尾部输出） */
function runFfmpeg(ctx: StepContext, ffmpeg: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, cwd })
    let tail = ''
    child.stderr?.on('data', (buf: Buffer) => {
      const chunk = buf.toString('utf8')
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        tail = trimmed.length > 300 ? trimmed.slice(-300) : trimmed
        emitStudioEvent({ type: 'step.log', runId: ctx.run.id, stepId: ctx.step.id, seq: Date.now(), chunk: trimmed })
      }
    })
    child.on('error', (err) => reject(new Error(`ffmpeg 启动失败: ${err.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 退出码 ${code}：${tail}`))
    })
  })
}
