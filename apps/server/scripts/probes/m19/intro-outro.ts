/** M19[intro-outro]：intro 槽合并/禁用语义 + 缺失文件宽容降级 + buildComposeArgs 片头尾拼接/配音位移/BGM totalAll + SRT 纯函数（countSrtCues/shiftSrtText）（断言体逐字搬自原 probe-m19.ts） */
import type { M19Ctx } from './ctx'

export async function run(ctx: M19Ctx): Promise<void> {
  const { check, db, T0, mkProject, eq, settings, resolveBrandConfig, mergeBrand, buildComposeArgs, mkArgsInput, countSrtCues, shiftSrtText } = ctx
  {
    // ---- 槽合并/禁用语义 ----
    const m = mergeBrand({ intro: { file: 'a.mp4' } }, { intro: { enabled: false } })
    check(m.intro?.file === 'a.mp4' && m.intro?.enabled === false, 'intro 槽字段合并（file 保留 + enabled:false）')

    // ---- 缺失文件 → null（宽容） ----
    const pid4 = await mkProject('M19 探针项目4')
    await db
      .insert(settings)
      .values({ key: 'brand', value: JSON.stringify({ outro: { file: 'no-such-file.mp4' } }), updatedAt: T0 })
      .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify({ outro: { file: 'no-such-file.mp4' } }), updatedAt: T0 } })
    const r = await resolveBrandConfig(pid4, null)
    check(r.outro === undefined, '片尾文件缺失 → 宽容降级（resolveBrandConfig 返回不含 outro）')
    // 还原平台品牌（供后续节依赖）
    await db
      .update(settings)
      .set({ value: JSON.stringify({ subtitle: { size_pct: 0.03 }, watermark: { file: 'wm-test.png', opacity: 0.5, position: 'tl' } }), updatedAt: T0 })
      .where(eq(settings.key, 'brand'))

    // ---- [P3] buildComposeArgs：片头/片尾拼接 + 配音位移 + BGM/totalAll ----
    const rIo = buildComposeArgs(mkArgsInput({
      intro: { path: 'C:/intro.mp4', durSec: 6 },
      outro: { path: 'C:/outro.mp4', durSec: 4 },
    }))
    const ioFc = rIo.args[rIo.args.indexOf('-filter_complex') + 1]!
    check(rIo.totalAll === 16, '片头 6s + 片尾 4s：totalAll = Σd + 10 = 16')
    check(ioFc.includes('[vintro][basev][voutro]concat=n=3:v=1:a=0[basev2]'), '片头尾拼接 concat n=3（仅存在侧参与；不参与转场）')
    check(
      ioFc.includes(`[2:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=25,format=yuv420p[vintro]`) &&
        ioFc.includes(`[3:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=25,format=yuv420p[voutro]`),
      '片头尾归一链（输入索引 2/3 紧随段输入）',
    )
    check(rIo.args.includes('[basev2]') && !rIo.args.includes('[basev]'), 'maps 指向 [basev2]（拼接后输出）')

    const rAv = buildComposeArgs(mkArgsInput({
      segments: [{ id: 1, path: 'a.png', kind: 'image', durSec: 6 }],
      xfadePlan: { enabled: false, type: 'none', durSec: 0, videoLens: [6], offsets: [], totalDur: 6 },
      voicePaths: ['C:/v1.m4a', 'C:/v2.m4a'],
      lineIds: ['l1', 'l2'],
      bgmPath: 'C:/bgm.mp3',
      intro: { path: 'C:/intro.mp4', durSec: 6 },
    }))
    const avFc = rAv.args[rAv.args.indexOf('-filter_complex') + 1]!
    check(avFc.includes('[a0][a1]concat=n=2:v=0:a=1,adelay=6000|6000,apad=whole_dur=12[outa]'), '配音轨片头位移：adelay=6000|6000 → apad whole_dur=12')
    check(avFc.includes('[3:a]atrim=0:12,asetpts=PTS-STARTPTS') && avFc.includes('afade=t=out:st=10:d=2'), 'BGM 锚定 totalAll：atrim=0:12 + 淡出 st=10')
    check(avFc.includes('[4:v]scale=1080:1920') && avFc.includes('[vintro][basev]concat=n=2:v=1:a=0[basev2]'), '片头输入索引 4（段 1 + 配音 2 + BGM 1 之后）')

    const rSi = buildComposeArgs(mkArgsInput({
      srtAbs: 'C:/out/ep.srt',
      intro: { path: 'C:/intro.mp4', durSec: 6 },
    }))
    const siFc = rSi.args[rSi.args.indexOf('-filter_complex') + 1]!
    check(siFc.includes(`[basev2]subtitles='ep.srt'`), '字幕烧录基于拼接后 [basev2]（时间轴含片头位移）')

    const rAll = buildComposeArgs(mkArgsInput({
      srtAbs: 'C:/out/ep.srt',
      watermark: { path: 'C:/wm.png', position: 'tl', opacity: 0.9, width_pct: 0.15, margin_px: 24 },
      intro: { path: 'C:/intro.mp4', durSec: 6 },
      outro: { path: 'C:/outro.mp4', durSec: 4 },
    }))
    const allFc = rAll.args[rAll.args.indexOf('-filter_complex') + 1]!
    check(
      allFc.includes('[vintro][basev][voutro]concat=n=3:v=1:a=0[basev2]') &&
        allFc.includes(`[basev2]subtitles='ep.srt':force_style='FontName=X,FontSize=18'[subv]`) &&
        allFc.includes('[subv][wm]overlay=24:24[outv]'),
      '全开链序：片头尾拼接 → 字幕 → 水印 overlay（标签无冲突）',
    )
    check(rAll.args.includes('[outv]') && rAll.totalAll === 16, '全开：maps [outv] + totalAll 16')

    // —— SRT 纯函数（片头统移复用链） ——
    const srtDemo = '1\n00:00:01,000 --> 00:00:02,000\n你好\n\n2\n00:00:03,500 --> 00:00:04,000\n再见\n'
    check(countSrtCues(srtDemo) === 2, 'countSrtCues 时间戳行计数（2 条 cue）')
    const shifted6 = shiftSrtText(srtDemo, [6, 6])
    check(
      shifted6 !== null && shifted6.includes('00:00:07,000 --> 00:00:08,000') && shifted6.includes('00:00:09,500 --> 00:00:10,000'),
      'shiftSrtText 片头统移 +6s（逐 cue 时间戳正确）',
    )
    check(shiftSrtText(srtDemo, [6]) === null, 'shiftSrtText cue 数与位移表不符 → null（调用方原样烧录）')
    check(countSrtCues('') === 0, 'countSrtCues 空文本 → 0')
  }
}
