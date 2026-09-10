import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { probeMediaDuration, resolveFfmpeg } from '../../services/ffmpeg'
import { absPathOf, registerAsset, relPathOf } from '../../services/storage'
import { emitStudioEvent } from '../../services/events'
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
}

/**
 * ffmpeg_merge：镜头序列 → 成片 + 封面（spec §5.4 三流合成）。
 * 镜头输入双字段互斥：images（静态图，-loop 1 -t duration_per_shot 定长）或
 * motion_clips（ai_video 产物，按实际时长 concat，不 -t/不 -loop）。
 * 可选 voices（audio 资产序列，逐句 concat 连续轨 → apad/atrim 对齐总时长，aac）；
 * 可选 subtitle（SRT 资产，视频流经 subtitles 滤镜烧录，force_style 参数化）。
 * 时间轴：镜头实际时长优先（video 资产 duration 字段，缺失时 ffprobe 探测兜底）；
 * 静态图回退 duration_per_shot（默认 4s）。产物 tags 增 'with_audio'/'with_subtitle'。
 */
export async function ffmpegMerge(ctx: StepContext): Promise<StepResult> {
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) {
    throw new Error(
      '未找到 ffmpeg：请 winget install ffmpeg（装后重启服务），或在 .env 设 CSTUDIO_FFMPEG_PATH 指向 ffmpeg.exe',
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
  const rows = await ctx.assetsOf(imageIds.length > 0 ? imageIds : clipIds)
  if (rows.length === 0) throw new Error('镜头资产均不可用（资产不存在或已删除）')
  const segments: Segment[] = []
  for (const a of rows) {
    if (!a.relPath) throw new Error(`镜头资产 #${a.id}（${a.name}）无本地文件`)
    if (imageIds.length > 0) {
      if (a.kind !== 'image') throw new Error(`镜头资产 #${a.id}（${a.name}）非图片`)
      segments.push({ id: a.id, path: absPathOf(a.relPath), kind: 'image', durSec: durationPerShot })
    } else {
      if (a.kind !== 'video') throw new Error(`镜头资产 #${a.id}（${a.name}）非视频`)
      // 实际时长优先：asset.duration（ai_video 注册值）→ ffprobe 探测 → duration_per_shot 兜底
      let dur = typeof a.duration === 'number' && a.duration > 0 ? a.duration : null
      if (dur === null) dur = probeMediaDuration(absPathOf(a.relPath))
      if (dur === null) {
        ctx.log(`镜头视频 #${a.id} 时长未知（无 duration 字段且 ffprobe 不可用），按 ${durationPerShot}s 估算总时长`)
        dur = durationPerShot
      }
      segments.push({ id: a.id, path: absPathOf(a.relPath), kind: 'video', durSec: dur })
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
  // 基准 duration_per_shot；有字幕以字幕末时间（估时）为准；无字幕则实测音频总长（ffprobe）
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
    const stretched = Math.max(durationPerShot, Math.ceil(srtEndMs / 1000) + 1)
    if (stretched > durationPerShot) {
      ctx.log(`口播底图单张，时长由 ${durationPerShot}s 撑至 ${stretched}s（对齐配音/字幕，防尾段冻结）`)
      segments[0]!.durSec = stretched
    }
  }

  const total = segments.reduce((s, seg) => s + seg.durSec, 0)
  ctx.log(
    segments[0]!.kind === 'image'
      ? `合成 ${segments.length} 张镜头图 → ${width}x${height}@${fps}fps（每张 ${durationPerShot}s，总 ${total}s）`
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
