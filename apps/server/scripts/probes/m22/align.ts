/** M22[P1] align：音字对齐计划 + 合成链 + SRT 纯函数（断言体逐字搬自原 probe-m22.ts） */
import type { M22Ctx } from './ctx'

export async function run(ctx: M22Ctx): Promise<void> {
  const { check, planAlignedSegments, escapeSubtitlePath, buildComposeArgs, buildSegmentSrt, parseSrtCues, retimeSrtCues } = ctx
  const p1 = planAlignedSegments([3, 5], [4, 4])
  check(p1 != null && p1.segDurs.join(',') === '4,5', '段级配对：段长 = max(视频, 音频)')
  check(planAlignedSegments([3], [4, 4]) === null, '段数不等 → null（降级）')
  check(planAlignedSegments([3, null], [4, 4]) === null, '视频时长未知 → null')
  check(planAlignedSegments([3, 5], [4, Number.NaN]) === null, '音频时长 NaN → null')
  check(planAlignedSegments([0, 2], [1, 1]) === null, '非正时长 → null')
  check(planAlignedSegments([], []) === null, '空段 → null')
  const p2 = planAlignedSegments([2.5, 1], [2.5004, 1])
  check(p2 != null && p2.segDurs[0] === 2.5, '段长保留 3 位小数（2.5004 → 2.5）')

  check(escapeSubtitlePath('C:\\tmp\\sub.srt') === 'C\\:/tmp/sub.srt', '烧录路径转义：反斜杠转正斜杠 + 盘符冒号转义')
  check(escapeSubtitlePath('/tmp/a.srt') === '/tmp/a.srt', 'POSIX 路径零改动')
  check(escapeSubtitlePath("a'b.srt") === "a'\\''b.srt", '含单引号路径：引号拆分转义（filename 值包裹后安全）')

  const fcOf = (args: string[]): string => args[args.indexOf('-filter_complex') + 1] ?? ''
  const base = { videoPaths: ['v1.mp4', 'v2.mp4'], audioPaths: ['a1.mp3', 'a2.mp3'], outPath: 'out.mp4', size: { width: 1080, height: 1920 } }
  const fcA = fcOf(buildComposeArgs({ ...base, align: { videoDurs: [3, 5], audioDurs: [4, 4] } }))
  check(fcA.includes('tpad=stop_mode=clone:stop_duration=1'), '对齐视频链：短段冻帧补足（段0：4−3=1s）')
  check(fcA.includes('apad,atrim=0:4,asetpts=PTS-STARTPTS[a0]') && fcA.includes('apad,atrim=0:5,asetpts=PTS-STARTPTS[a1]'), '对齐音频链：逐段 apad+atrim 截断到段长')
  check(fcA.includes('concat=n=2:v=0:a=1[aout]') && !fcA.includes('amix=inputs=2:duration=longest'), '音频段级 concat 顺序拼接（替代 amix）')

  const fcB = fcOf(buildComposeArgs({ ...base, align: { videoDurs: [3, 5], audioDurs: [4, 4] }, bgmPath: 'bgm.mp3' }))
  check(fcB.includes('concat=n=2:v=0:a=1[amix]') && fcB.includes('[amix][bgm]amix=inputs=2:duration=first:normalize=0[aout]'), 'BGM 兼容：段级 concat → [amix] 复用现有 mix 链')

  const fcX = fcOf(buildComposeArgs({ ...base, align: { videoDurs: [3, 5], audioDurs: [4, 4] }, durations: [3, 5], transition: 'fade', transitionDuration: 0.5 }))
  check(!fcX.includes('xfade='), '对齐与转场互斥：xfade 强制降级')

  const argsSub = buildComposeArgs({ videoPaths: ['v1.mp4', 'v2.mp4'], audioPaths: [], outPath: 'o.mp4', size: base.size, subtitlePath: 'C:\\tmp\\s.srt' })
  check(fcOf(argsSub).includes("[vout]subtitles=filename='C\\:/tmp/s.srt'[vsub]"), '烧录字幕（n≥2）：subtitles 滤镜（引号包裹值）+ [vsub] 映射')
  check(argsSub.includes('[vsub]') && argsSub[argsSub.indexOf('[vsub]') - 1] === '-map', '烧录字幕：-map [vsub]')
  const argsSub1 = buildComposeArgs({ videoPaths: ['v1.mp4'], audioPaths: [], outPath: 'o.mp4', subtitlePath: '/tmp/s.srt' })
  check(fcOf(argsSub1).includes("[0:v]subtitles=filename='/tmp/s.srt'[vsub]"), '烧录字幕（n=1）：[0:v] 直挂 subtitles（引号包裹值）')

  const fcBase = fcOf(buildComposeArgs(base))
  check(fcBase.includes('amix=inputs=2:duration=longest[aout]') && !fcBase.includes('tpad=stop_mode=clone') && !fcBase.includes('apad'), '零漂移：无 align/subtitlePath 时沿用现状链')

  const srt1 = buildSegmentSrt([
    { startSec: 0, voiceDur: 3, segDur: 4, text: '第一句' },
    { startSec: 4, voiceDur: 5, segDur: 5, text: '第二句' },
  ])
  check(srt1 != null && srt1.startsWith('1\n00:00:00,000 --> 00:00:03,000\n第一句'), '段级 SRT：start=段起点，end=start+min(voiceDur,segDur)')
  check(srt1 != null && srt1.includes('00:00:04,000 --> 00:00:09,000') && srt1.endsWith('\n'), 'SRT：第二段 4→9s + 尾随换行')
  check(buildSegmentSrt([{ startSec: 0, voiceDur: 3, segDur: 4, text: '  ' }]) === null, '全空文本段 → null')

  const cues = parseSrtCues('1\n00:00:00,000 --> 00:00:04,000\n第一句\n\n2\n00:00:04,000 --> 00:00:12,000\n第二句\n')
  check(cues.length === 2 && cues[0]!.text === '第一句' && cues[1]!.startSec === 4, 'SRT 解析：cue 数/文本/时间正确')
  const retimed = retimeSrtCues(cues, [{ startSec: 0, segDur: 4 }, { startSec: 4, segDur: 5 }])
  check(retimed != null && retimed.includes('00:00:04,000 --> 00:00:09,000'), '重钉：cue2 时长 8s clamp 段长 5s → 4-9s')
  check(retimeSrtCues(cues, [{ startSec: 0, segDur: 4 }]) === null, 'cue 数与段数不符 → null（降级）')
}
