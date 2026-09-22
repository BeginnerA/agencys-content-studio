import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { Checker } from '../../probe-lib'
import type { CreationPlan } from '../../../src/services/creation-chat/contract'

export async function probeMedia({ check }: Checker, plan: CreationPlan): Promise<void> {
  const { resolveFfmpeg } = await import('../../../src/services/ffmpeg')
  const { inspectDialogueMedia, extractDialogueAudio, validateDialogueTranscript, dialogueSrt } = await import('../../../src/services/creation-chat/dialogue-media')
  const ffmpeg = resolveFfmpeg()!
  const root = process.env.CSTUDIO_DATA!
  const generate = (name: string, audio: string, delay = 0): string => {
    const path = join(root, name)
    const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x240:r=25:d=8',
      ...(delay ? ['-itsoffset', String(delay)] : []), '-f', 'lavfi', '-i', audio, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path]
    const result = spawnSync(ffmpeg, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true })
    if (result.status !== 0) throw new Error(result.stderr)
    return path
  }
  const voiced = generate('voiced.mp4', 'sine=frequency=440:duration=7')
  const timing = inspectDialogueMedia(voiced)
  check(timing.videoDuration >= 8 && timing.audioDuration > 6.9, '从真实视频读取独立音视频流时长')
  const wav = join(root, 'voiced.wav')
  const extracted = extractDialogueAudio(voiced, wav)
  check(extracted.audioDuration > 6.9, '真实抽取原声音轨并测量提交 ASR 秒数')
  const raw = { text: plan.lines[0]!.text, segments: [{ start: 0.5, end: 3, text: plan.lines[0]!.text }] }
  const transcript = validateDialogueTranscript(plan, 's1', raw, extracted)
  check(transcript.segments[0]!.start === 0.5, '保留 ASR 实际分段时间而非按字数平分')
  const rejected = (fn: () => unknown): boolean => { try { fn(); return false } catch { return true } }
  check(rejected(() => validateDialogueTranscript(plan, 's1', { ...raw, text: '别的话', segments: [{ start: 1, end: 3, text: '别的话' }] }, extracted)), '换词或漏字不可交付')
  check(rejected(() => validateDialogueTranscript(plan, 's1', { ...raw, segments: [{ start: 1, end: 9, text: raw.text }] }, extracted)), '越界对白不可合成')
  const delayed = generate('delayed.mp4', 'sine=frequency=880:duration=6', 1)
  const delayedTiming = extractDialogueAudio(delayed, join(root, 'delayed.wav'))
  check(delayedTiming.audioStart - delayedTiming.videoStart > 0.8, '保留真实音视频起点差，不分别归零')
  const delayedTranscript = validateDialogueTranscript(plan, 's1', raw, delayedTiming)
  const srt = dialogueSrt([{ shotId: 's1', duration: 8, timing: delayedTiming, transcript: delayedTranscript }])
  check(!srt.includes('00:00:00,500') && srt.includes(raw.text), '字幕应用原声起点偏移')
  const silent = generate('silent.mp4', 'anullsrc=r=16000:cl=mono:d=8')
  check(rejected(() => extractDialogueAudio(silent, join(root, 'silent.wav'))), '静音轨不能伪装有效原声')
  const noAudio = join(root, 'no-audio.mp4')
  spawnSync(ffmpeg, ['-y', '-v', 'error', '-i', voiced, '-an', '-c:v', 'copy', noAudio], { timeout: 60_000, windowsHide: true })
  check(rejected(() => inspectDialogueMedia(noAudio)), '无音轨视频拒绝，原文件保留')
  const { buildComposeArgs } = await import('../../../src/pipeline/actions/ffmpeg-merge/args')
  const { buildTransitionPlan } = await import('../../../src/pipeline/actions/ffmpeg-merge/transition')
  const out = join(root, 'merged.mp4')
  const built = buildComposeArgs({ strictDelivery: true,
    nativeAudio: [delayedTiming, extracted],
    segments: [delayed, voiced].map((path, i) => ({ id: i + 1, path, kind: 'video' as const, durSec: 8, explicit: true })),
    width: 160, height: 240, fps: 25, xfadePlan: buildTransitionPlan([8, 8], 'none', 0), voicePaths: [], lineIds: [], alignPlan: null,
    total: 16, srtAbs: null, style: '', bgmPath: null, bgmVolume: 0.1, bgmFade: 0, watermark: null, intro: null, outro: null, outAbs: out,
  })
  const filter = built.args[built.args.indexOf('-filter_complex') + 1]!
  check(filter.includes('[0:a]') && filter.includes('[1:a]') && !filter.includes('tpad=') && !filter.includes('atempo='), '合成使用逐镜原声，不变速、不循环填画面')
  const merged = spawnSync(ffmpeg, ['-v', 'error', ...built.args], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
  if (merged.status !== 0) throw new Error(merged.stderr)
  const outputTiming = inspectDialogueMedia(out)
  check(Math.abs(outputTiming.videoDuration - 16) < 0.1 && Math.abs(outputTiming.audioDuration - 16) < 0.1, '真实 FFmpeg 双路拼接保持 16 秒音画同轴')
  const measure = (start: number): number => {
    const result = spawnSync(ffmpeg, ['-hide_banner', '-ss', String(start), '-t', '0.3', '-i', out, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
    return Number(/max_volume:\s*(-?[\d.]+) dB/.exec(result.stderr)?.[1] ?? -100)
  }
  check(measure(0.1) < -60 && measure(1.2) > -30 && measure(8.2) > -30, '延迟原声保持首秒静音，第二镜原声从对应镜头起点开始')
}
