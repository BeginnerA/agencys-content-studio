import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { resolveFfmpeg } from '../../services/ffmpeg'
import { absPathOf, registerAsset, relPathOf } from '../../services/storage'
import { emitStudioEvent } from '../../services/events'
import type { StepContext } from '../context'
import type { StepResult } from '../types'

/**
 * ffmpeg_merge：镜头图 → 成片 + 封面（spec §5.3）。
 * 每张图定长（默认 4s），scale+pad 到目标分辨率后 concat 为竖屏 mp4；
 * params.cover=true 时另提取首帧为封面资产（purpose=thumbnail）。
 * 字幕参数 M1 无输入源，收到 true 仅提示忽略。
 */
export async function ffmpegMerge(ctx: StepContext): Promise<StepResult> {
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) {
    throw new Error(
      '未找到 ffmpeg：请 winget install ffmpeg（装后重启服务），或在 .env 设 CSTUDIO_FFMPEG_PATH 指向 ffmpeg.exe',
    )
  }
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const fps = typeof params['fps'] === 'number' ? params['fps'] : 25
  const resolution = typeof params['resolution'] === 'string' ? params['resolution'] : '1080x1920'
  const wantCover = params['cover'] === true
  const durationPerShot = typeof params['duration_per_shot'] === 'number' ? params['duration_per_shot'] : 4
  if (params['subtitle'] === true) ctx.log('subtitle=true 但 M1 无字幕来源，已忽略（后续版本接入）')

  const m = /^(\d+)x(\d+)$/.exec(resolution)
  if (!m) throw new Error(`resolution 非法: ${resolution}（需 WxH 如 1080x1920）`)
  const width = Number(m[1])
  const height = Number(m[2])

  const imageIds = ctx.assetIdsOf('images')
  if (imageIds.length === 0) throw new Error('inputs.images 无镜头资产')
  const rows = await ctx.assetsOf(imageIds)
  const images: Array<{ id: number; path: string }> = []
  for (const a of rows) {
    if (a.kind !== 'image' || !a.relPath) {
      throw new Error(`镜头资产 #${a.id}（${a.name}）非本地图片`)
    }
    images.push({ id: a.id, path: absPathOf(a.relPath) })
  }
  ctx.log(`合成 ${images.length} 张镜头图 → ${width}x${height}@${fps}fps（每张 ${durationPerShot}s）`)

  const runInput = JSON.parse(ctx.run.input) as Record<string, unknown>
  const ep = String(runInput['episode_number'] ?? Date.now()).padStart(3, '0')
  const outName = `ep${ep}-final-${Date.now()}.mp4`
  const outRel = relPathOf(ctx.run.projectId, 'final_video', outName)
  const outAbs = absPathOf(outRel)

  const filterParts: string[] = []
  const inputArgs: string[] = []
  images.forEach((_img, i) => {
    inputArgs.push('-loop', '1', '-t', String(durationPerShot), '-i', images[i]!.path)
    filterParts.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p[v${i}]`,
    )
  })
  const concatIn = images.map((_, i) => `[v${i}]`).join('')
  const args = [
    '-y',
    ...inputArgs,
    '-filter_complex',
    `${filterParts.join(';')};${concatIn}concat=n=${images.length}:v=1:a=0[outv]`,
    '-map', '[outv]',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-r', String(fps),
    '-movflags', '+faststart',
    outAbs,
  ]

  ctx.log('ffmpeg 开始合成…')
  await runFfmpeg(ctx, ffmpeg, args)
  const size = statSync(outAbs).size
  const videoAsset = await registerAsset(ctx.run.projectId, {
    name: outName,
    kind: 'video',
    purpose: 'final_video',
    relPath: outRel,
    mime: 'video/mp4',
    ext: 'mp4',
    fileSize: size,
    width,
    height,
    duration: images.length * durationPerShot,
    params: { fps, resolution, images: images.length },
    tags: ['final'],
    stepId: ctx.step.id,
  })
  ctx.log(`成片落盘 asset#${videoAsset.id} → ${outRel}（${Math.round(size / 1024 / 1024)} MB）`)

  const assetIds = [videoAsset.id]
  if (wantCover) {
    const coverName = `ep${ep}-cover-${Date.now()}.jpg`
    const coverRel = relPathOf(ctx.run.projectId, 'thumbnail', coverName)
    const coverAbs = absPathOf(coverRel)
    await runFfmpeg(ctx, ffmpeg, ['-y', '-ss', '0.2', '-i', outAbs, '-frames:v', '1', '-q:v', '3', coverAbs])
    const coverAsset = await registerAsset(ctx.run.projectId, {
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
function runFfmpeg(ctx: StepContext, ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true })
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