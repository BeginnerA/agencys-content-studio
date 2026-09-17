/** M19[aspect]：purposeSubDir 登记 + resolveAspectSize 尺寸派生/红线不放大 + 几何滤镜/同比例判定 + normalizeMultiAspect/readMultiAspect 校验清洗 + buildComposeArgs 多路渲染/asplit 分流/零 diff + A 路径服务校验族/幂等复用（断言体逐字搬自原 probe-m19.ts） */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { M19Ctx } from './ctx'

export async function run(ctx: M19Ctx): Promise<void> {
  const { check, db, pid, T0, errOf, eq, purposeSubDir, pipelineRuns, buildComposeArgs, mkArgsInput } = ctx
  {
    check(purposeSubDir('final_video_derived') === 'video', "purposeSubDir('final_video_derived') → video 子目录")

    const { resolveAspectSize, aspectGeometryFilter, isSameAspect } = await import('../../../src/pipeline/actions/ffmpeg-merge')
    const { normalizeMultiAspect, readMultiAspect, updateComposeConfig } = await import('../../../src/services/compose-config')
    const { deriveAspect } = await import('../../../src/services/aspect-derive')
    const { registerAsset, relPathOf, absPathOf } = await import('../../../src/services/storage')
    const { assets } = await import('../../../src/db/schema')
    const runA = (
      await db
        .insert(pipelineRuns)
        .values({
          projectId: pid,
          templateKey: 'mengbao-episode',
          status: 'completed',
          input: JSON.stringify({ episode_number: 7 }),
          createdAt: T0,
          updatedAt: T0,
        })
        .returning()
    )[0]!

    // ---- [P5] resolveAspectSize（竖屏主画幅 1080x1920）----
    const a916 = resolveAspectSize(1080, 1920, '9:16')
    check(a916.w === 1080 && a916.h === 1920, '同比例 9:16 → 原尺寸 {1080,1920}（不缩放）')
    const a11 = resolveAspectSize(1080, 1920, '1:1')
    check(a11.w === 1080 && a11.h === 1080, '1:1：w=1920 超宽 → 反转以宽为基准 {1080,1080}')
    const a45 = resolveAspectSize(1080, 1920, '4:5')
    check(a45.w === 1080 && a45.h === 1350, '4:5：w=1536 超宽 → {1080,1350}')
    const a169 = resolveAspectSize(1080, 1920, '16:9')
    check(a169.w === 1080 && a169.h === 608, '16:9：h = round(1080×9/16)=607.5 → 608（取偶不变）')
    const land = resolveAspectSize(1920, 1080, '9:16')
    check(land.w === 608 && land.h === 1080, '横屏源 1920x1080 派 9:16 → 以高为基准 {608,1080}')
    const odd = resolveAspectSize(1079, 1921, '9:16')
    check(odd.w === 1078 && odd.h === 1918, '奇数输入 → 向下取偶 {1078,1918}（yuv420p）')
    const noUpscale = (['9:16', '1:1', '4:5', '16:9'] as const).every((a) => {
      const r = resolveAspectSize(1080, 1920, a)
      return r.w <= 1080 && r.h <= 1920 && r.w % 2 === 0 && r.h % 2 === 0
    })
    check(noUpscale, '红线：四个画幅均不放大且均为偶数')
    const badAspect = await errOf(async () => resolveAspectSize(1080, 1920, 'abc'))
    check(badAspect instanceof Error && /非法画幅/.test(String(badAspect)), '非法画幅串 → 抛错（服务层入口已先校验）')

    // ---- [P5] 几何滤镜串与同比例判定 ----
    check(
      aspectGeometryFilter('crop', 1080, 1080) === 'crop=1080:1080:(iw-1080)/2:(ih-1080)/2,setsar=1',
      'crop：居中裁切表达式 + setsar=1',
    )
    check(
      aspectGeometryFilter('pad', 1080, 608)
        === 'scale=1080:608:force_original_aspect_ratio=decrease,pad=1080:608:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1',
      'pad：等比缩小 + 黑边居中',
    )
    check(aspectGeometryFilter('weird', 640, 640).startsWith('crop='), '未知策略 → 回退 crop（readMultiAspect 已夹住，此处钉行为）')
    check(isSameAspect(1080, 1920, '9:16') && !isSameAspect(1080, 1920, '1:1'), 'isSameAspect：主画幅同比例判定（用于剔除重复编码）')

    // ---- [P5] normalizeMultiAspect / readMultiAspect ----
    check(normalizeMultiAspect({ enabled: true, aspects: ['1:1'] }).strategy === 'crop', 'strategy 缺省 → crop')
    check(
      JSON.stringify(normalizeMultiAspect({ enabled: true, aspects: ['1:1', '1:1', '16:9'] }).aspects) === JSON.stringify(['1:1', '16:9']),
      'aspects 去重保持入参序',
    )
    for (const [raw, tip] of [
      [{ enabled: true, aspects: [] }, '启用但 aspects 空 → 拒绝'],
      [{ enabled: true, aspects: ['1:1', '4:5', '9:16', '16:9'] }, 'aspects > 3 → 拒绝'],
      [{ enabled: true, aspects: ['21:9'] }, '非法画幅 → 拒绝'],
      [{ enabled: 'yes', aspects: ['1:1'] }, 'enabled 非布尔 → 拒绝'],
      [{ enabled: true, aspects: ['1:1'], strategy: 'blur' }, '非法 strategy → 拒绝'],
      [[], '非对象（数组）→ 拒绝'],
    ] as const) {
      const e = await errOf(async () => updateComposeConfig(runA.id, { multi_aspect: raw }))
      check(e instanceof Error && /multi_aspect|aspects|多画幅/.test(String(e)), tip)
    }
    const maCfg = await updateComposeConfig(runA.id, { multi_aspect: { enabled: true, aspects: ['1:1', '16:9'], strategy: 'pad' } })
    check(
      maCfg.multi_aspect?.enabled === true && maCfg.multi_aspect.strategy === 'pad' && maCfg.multi_aspect.aspects.length === 2,
      'multi_aspect 写入往返（落 _compose 并读回）',
    )
    const maOff = await updateComposeConfig(runA.id, { multi_aspect: null })
    check(maOff.multi_aspect === undefined, 'multi_aspect: null → 清除该键')
    check(readMultiAspect({}) === null, 'readMultiAspect：缺省 → null（不启用）')
    check(readMultiAspect({ multi_aspect: { enabled: false, aspects: ['1:1'], strategy: 'crop' } }) === null, 'readMultiAspect：enabled=false → null')
    check(
      JSON.stringify(readMultiAspect({ multi_aspect: { enabled: true, aspects: ['1:1', '21:9', '4:5', '16:9', '9:16'], strategy: 'x' as 'crop' } }))
        === JSON.stringify({ enabled: true, aspects: ['1:1', '4:5', '16:9'], strategy: 'crop' }),
      'readMultiAspect 脏数据兜底：非法项剔除 / >3 截断 / 非法策略回 crop',
    )
    check(readMultiAspect({ multi_aspect: { enabled: true, aspects: ['21:9'], strategy: 'crop' } }) === null, 'readMultiAspect：全非法 aspects → null')

    // ---- [P5] buildComposeArgs 多路渲染 ----
    const baseArgs = JSON.stringify(buildComposeArgs(mkArgsInput({})).args)
    check(JSON.stringify(buildComposeArgs(mkArgsInput({ multiAspect: { strategy: 'crop', targets: [] } })).args) === baseArgs, '零 diff：targets 空 → args 逐字节一致')
    check(
      JSON.stringify(buildComposeArgs(mkArgsInput({ multiAspect: { strategy: 'pad', targets: [], subtitleCfg: { size_pct: 0.03 } } })).args) === baseArgs,
      '零 diff：multiAspect 存在但无 targets（含 subtitleCfg）→ 不受影响',
    )
    const d1 = buildComposeArgs(mkArgsInput({ multiAspect: { strategy: 'crop', targets: [{ aspect: '1:1', outAbs: 'C:/out/ep-final-1x1.mp4' }] } }))
    const f1 = d1.args[d1.args.indexOf('-filter_complex') + 1]!
    check(f1.includes('[basev]split=2[bm][b1]'), '单路：拼接后 split=2 → 主路 [bm] + 派生 [b1]')
    check(f1.includes('[b1]crop=1080:1080:(iw-1080)/2:(ih-1080)/2,setsar=1[dv0]'), '派生路几何（与 A 端点同源串）')
    check(d1.args[d1.args.indexOf('-map') + 1] === '[bm]' && d1.args[d1.args.length - 1] === 'C:/out/ep-final-1x1.mp4', '主输出改 map [bm]；末位为派生输出路径')
    check(d1.args.filter((t) => t === '-map').length === 2 && d1.args.filter((t) => t.startsWith('C:/out/')).length === 2, '无音轨时两路各 1 个 -map / 2 个输出')
    check(d1.derived.length === 1 && d1.derived[0]!.width === 1080 && d1.derived[0]!.height === 1080, 'derived 回传尺寸（调用方据此落资产）')
    const d2 = buildComposeArgs(mkArgsInput({
      voicePaths: ['v1.mp3'],
      lineIds: ['l1'],
      multiAspect: { strategy: 'pad', targets: [{ aspect: '1:1', outAbs: 'C:/out/e-1x1.mp4' }] },
    }))
    const f2 = d2.args[d2.args.indexOf('-filter_complex') + 1]!
    check(
      f2.includes('[b1]scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[dv0]'),
      'pad 策略入派生路（策略开关生效）',
    )
    // [M19 实测修正] 多路输出时同一音频 pad 不能被两个输出重复 -map（ffmpeg：Error opening output files: Invalid argument）
    check(
      f2.includes('[outa]asplit=2[amapMain][amapD0]'),
      '有音轨 + 单派生 → [outa]asplit=2 分流（修复：重复 -map 同一 pad 会导致 ffmpeg 退出码 -22）',
    )
    const maps2 = d2.args.filter((t) => t === '-map').length
    const aLabels2 = d2.args.slice(d2.args.indexOf('-map')).filter((t) => /^\[amap/.test(t))
    check(maps2 === 4 && JSON.stringify(aLabels2) === JSON.stringify(['[amapMain]', '[amapD0]']), '两路各映射唯一音频标签（4 个 -map，无重复 pad）')
    check(d2.args.filter((t) => t === '[outa]').length === 0, '分流后 [outa] 不再作为 -map 目标出现（仅存在于 filter 链内）')
    const dA = buildComposeArgs(mkArgsInput({ voicePaths: ['v1.mp3'], lineIds: ['l1'] }))
    check(
      dA.args.filter((t) => t === '-map').length === 2 && dA.args.includes('[outa]') && !dA.args.some((t) => t.includes('asplit')),
      '零 diff：有音轨但未启用多画幅 → 单路 map [outa]（无 asplit）',
    )
    const d5 = buildComposeArgs(mkArgsInput({
      voicePaths: ['v1.mp3'],
      lineIds: ['l1'],
      bgmPath: 'C:/bgm.mp3',
      multiAspect: {
        strategy: 'crop',
        targets: [
          { aspect: '1:1', outAbs: 'C:/out/e-1x1.mp4' },
          { aspect: '16:9', outAbs: 'C:/out/e-16x9.mp4' },
        ],
      },
    }))
    const f5 = d5.args[d5.args.indexOf('-filter_complex') + 1]!
    check(f5.includes('[aout]asplit=3[amapMain][amapD0][amapD1]'), 'BGM 终混标签 [aout] 作为分流源（三路 asplit=3）')
    const aLabels5 = d5.args.filter((t) => /^\[amap/.test(t))
    const allMaps5 = d5.args.filter((t) => t === '-map').length
    check(allMaps5 === 6 && new Set(aLabels5).size === aLabels5.length && aLabels5.length === 3, '三路输出 → 6 个 -map；三个音频标签两两不同')
    const dN = buildComposeArgs(mkArgsInput({
      multiAspect: {
        strategy: 'crop',
        targets: [
          { aspect: '1:1', outAbs: 'C:/out/e-1x1.mp4' },
          { aspect: '16:9', outAbs: 'C:/out/e-16x9.mp4' },
        ],
      },
    }))
    check(!dN.args.some((t) => t.includes('asplit')) && dN.args.filter((t) => t === '-map').length === 3, '无音轨 + 三路 → 不注入 asplit；仅 3 个视频 -map')
    const d3 = buildComposeArgs(mkArgsInput({
      srtAbs: 'C:/out/ep.srt',
      style: 'FontName=Legacy,FontSize=18',
      watermark: { path: 'wm.png', position: 'br', opacity: 0.5, width_pct: 0.15, margin_px: 24 },
      intro: { path: 'intro.mp4', durSec: 2 },
      multiAspect: {
        strategy: 'crop',
        targets: [
          { aspect: '1:1', outAbs: 'C:/out/e-1x1.mp4' },
          { aspect: '16:9', outAbs: 'C:/out/e-16x9.mp4' },
        ],
        subtitleCfg: { size_pct: 0.018 },
      },
    }))
    const f3 = d3.args[d3.args.indexOf('-filter_complex') + 1]!
    check(f3.includes('[basev2]split=3[bm][b1][b2]'), '片头存在时 split 于 [basev2]（派生件含片头尾）')
    check(/\[bm\]subtitles='ep\.srt':force_style='FontName=Legacy,FontSize=18'/.test(f3), '主路沿用上游定型的 style（仅派生路重算）')
    check(f3.includes('[dv0]subtitles=') && f3.includes('FontSize=19'), '派生路 1（1:1，h=1080）结构化重算字号 19')
    check(f3.includes('[dv1]subtitles=') && f3.includes('FontSize=16'), '派生路 2（16:9，h=608 → 10.9）最小字号兜底 16')
    check(f3.includes('[dsub0][wm]overlay=') && f3.includes('[dsub1][wm]overlay='), '同一 [wm] 分流至两派生路（字幕之后；表达式自适应各链 W/H）')
    check(d3.args.filter((t) => t === '-map').length === 3 && d3.args[d3.args.indexOf('-map') + 1] === '[outv]', '三路输出×无音轨 → 3 个 -map；主路仍为 [outv]')
    check(d3.derived[1]!.height === 608 && d3.derived[1]!.width === 1080, 'derived 第 2 路尺寸 1080x608')
    const d4 = buildComposeArgs(mkArgsInput({
      srtAbs: 'C:/out/ep.srt',
      style: 'FontName=Legacy,FontSize=18',
      multiAspect: { strategy: 'crop', targets: [{ aspect: '1:1', outAbs: 'C:/out/e-1x1.mp4' }] },
    }))
    const f4 = d4.args[d4.args.indexOf('-filter_complex') + 1]!
    check(f4.includes('[dv0]subtitles=') && /\[dv0\]subtitles='ep\.srt':force_style='FontName=Legacy,FontSize=18'/.test(f4), '整串模式（无 subtitleCfg）→ 派生路复用主串')

    // ---- [P5] A 路径服务（零 ffmpeg：只测校验族与幂等命中）----
    const noRun = await errOf(async () => deriveAspect(999_999, '1:1'))
    check(noRun instanceof Error && /不存在/.test(String(noRun)), 'run 不存在 → not_found')
    const badA = await errOf(async () => deriveAspect(runA.id, '21:9'))
    check(badA instanceof Error && /aspect/.test(String(badA)), 'aspect 非枚举 → bad_aspect')
    const badS = await errOf(async () => deriveAspect(runA.id, '1:1', 'blur'))
    check(badS instanceof Error && /strategy/.test(String(badS)), 'strategy 非枚举 → bad_strategy')
    const noFinal = await errOf(async () => deriveAspect(runA.id, '1:1'))
    check(noFinal instanceof Error && /尚未合成成片/.test(String(noFinal)), '无 final_video → no_final（先于 ffmpeg 判定）')

    const fRel = relPathOf(pid, 'final_video', 'probe-final.mp4')
    mkdirSync(dirname(absPathOf(fRel)), { recursive: true })
    writeFileSync(absPathOf(fRel), 'probe-not-a-video')
    const finalA = await registerAsset(pid, {
      runId: runA.id,
      name: 'probe-final.mp4',
      kind: 'video',
      purpose: 'final_video',
      relPath: fRel,
      mime: 'video/mp4',
      ext: 'mp4',
      width: 1080,
      height: 1920,
      duration: 6,
    })
    const dRel = relPathOf(pid, 'final_video_derived', 'probe-derived.mp4')
    mkdirSync(dirname(absPathOf(dRel)), { recursive: true })
    writeFileSync(absPathOf(dRel), 'x')
    await registerAsset(pid, {
      runId: runA.id,
      name: 'probe-derived.mp4',
      kind: 'video',
      purpose: 'final_video_derived',
      relPath: dRel,
      mime: 'video/mp4',
      ext: 'mp4',
      width: 1080,
      height: 1080,
      params: { source: 'derived', aspect: '1:1', strategy: 'crop', source_asset_id: finalA.id },
    })
    const hit = await deriveAspect(runA.id, '1:1')
    check(hit.reused === true && hit.asset.id !== finalA.id && hit.asset.relPath === dRel, '幂等复用：同参派生行命中 → reused=true（不发 ffmpeg）')
    const hitPad = await errOf(async () => deriveAspect(runA.id, '1:1', 'pad'))
    check(hitPad !== null, '策略不同 → 不复用（转入真实派生；探针无有效媒体入参，必报错）')
    const staleErr = await errOf(async () => {
      await db.update(assets).set({ deletedAt: T0 + 1 }).where(eq(assets.purpose, 'final_video'))
      return deriveAspect(runA.id, '1:1')
    })
    check(staleErr instanceof Error && /尚未合成成片/.test(String(staleErr)), '源成片被软删 → no_final（复用不得于失效源）')
    await db.update(assets).set({ deletedAt: null }).where(eq(assets.purpose, 'final_video'))
  }
}
