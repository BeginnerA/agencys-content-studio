/** M19[brand-watermark]：sanitizeWatermark 清洗 + 三层读取容错 + 来源解析（file/asset）+ 品牌资产服务 upload/预览/清除 + buildComposeArgs 水印链（零 diff + 九宫格 + 字幕序）（断言体逐字搬自原 probe-m19.ts） */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { M19Ctx } from './ctx'

export async function run(ctx: M19Ctx): Promise<void> {
  const { check, db, pid, T0, errOf, mkProject, eq, BRAND_DIR, settings, projects, sanitizeWatermark, readPlatformBrand, readProjectBrand, readComposeBrand, resolveBrandConfig, buildComposeArgs, watermarkOverlayXY, mkArgsInput } = ctx
  {
    // ---- 清洗默认值/上下界 ----
    const d = sanitizeWatermark(undefined)
    check(d.position === 'br' && d.opacity === 0.9 && d.width_pct === 0.15 && d.margin_px === 24, 'sanitizeWatermark 默认值（br / 0.9 / 0.15 / 24）')
    const c1 = sanitizeWatermark({ position: 'tl', opacity: 0, width_pct: 0.9, margin_px: 999 })
    check(c1.position === 'tl' && c1.opacity === 0.05 && c1.width_pct === 0.5 && c1.margin_px === 200, 'sanitizeWatermark clamp 上下界')
    const c2 = sanitizeWatermark({ position: 'xx' as never })
    check(c2.position === 'br', 'sanitizeWatermark 非法位置回退默认 br')

    // ---- 三层读取容错 ----
    check(Object.keys(await readPlatformBrand()).length === 0, 'readPlatformBrand 缺省 → {}')
    check(Object.keys(await readProjectBrand(pid)).length === 0, 'readProjectBrand 缺省 → {}')
    check(Object.keys(readComposeBrand('not-json')).length === 0 && Object.keys(readComposeBrand(null)).length === 0, 'readComposeBrand 坏输入/空输入 → {}')

    // ---- 三层皆空 → {}（零 diff 前置；须在写入平台品牌层前断言——平台层不区分项目全域生效） ----
    check(Object.keys(await resolveBrandConfig(pid, null)).length === 0, '三层皆空 → {}（调用方保持现行为）')

    // ---- 平台层 + 文件来源解析（水印文件真实落 BRAND_DIR） ----
    check(existsSync(BRAND_DIR), 'BRAND_DIR 已创建（ensureDirs）')
    writeFileSync(join(BRAND_DIR, 'wm-test.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    await db
      .insert(settings)
      .values({
        key: 'brand',
        value: JSON.stringify({
          subtitle: { size_pct: 0.03 },
          watermark: { file: 'wm-test.png', opacity: 0.5, position: 'tl' },
          intro: { enabled: false, file: 'missing.mp4' },
          outro: { file: 'missing-outro.mp4' },
        }),
        updatedAt: T0,
      })
    const r1 = await resolveBrandConfig(pid, null)
    check(r1.subtitle?.size_pct === 0.03, 'resolveBrandConfig 平台层 subtitle 生效')
    check(r1.watermark?.path === join(BRAND_DIR, 'wm-test.png') && r1.watermark?.source === 'file', 'resolveBrandConfig 水印文件来源解析（file）')
    check(r1.watermark?.opacity === 0.5 && r1.watermark?.position === 'tl' && r1.watermark?.width_pct === 0.15, 'resolveBrandConfig 水印参数清洗 + 默认补齐')
    check(r1.intro === undefined, 'resolveBrandConfig intro enabled:false → 禁用（不出现在结果）')
    check(r1.outro === undefined, 'resolveBrandConfig outro 文件缺失 → 宽容降级（不出现）')

    // ---- 项目层覆盖平台层（字段级） + run 层覆盖 ----
    const pid2 = await mkProject('M19 探针项目2', JSON.stringify({ brand: { watermark: { opacity: 0.2 } } }))
    const r2 = await resolveBrandConfig(pid2, JSON.stringify({ _compose: { brand: { subtitle: { color: '#FF0000' } } } }))
    check(r2.watermark?.opacity === 0.2 && r2.watermark?.path === join(BRAND_DIR, 'wm-test.png'), '项目层覆盖平台字段（opacity 0.2；平台 file 经合并保留）')
    check(r2.subtitle?.size_pct === 0.03 && r2.subtitle?.color === '#FF0000', 'run 层字段叠加（平台 size_pct 保留 + run color 生效）')

    // ---- 项目层 asset_id 来源：属项目校验（pid3 新项目无平台文件依赖） ----
    const pid3 = await mkProject('M19 探针项目3')
    const { registerAsset, ensureProjectDirs, relPathOf, absPathOf } = await import('../../../src/services/storage')
    ensureProjectDirs(pid3)
    const wmRel = relPathOf(pid3, 'source', 'proj-wm.png')
    writeFileSync(absPathOf(wmRel), new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    const wmAsset = await registerAsset(pid3, { name: 'proj-wm.png', kind: 'image', purpose: 'source', relPath: wmRel })
    await db
      .update(projects)
      .set({ settings: JSON.stringify({ brand: { watermark: { asset_id: wmAsset.id } } }) })
      .where(eq(projects.id, pid3))
    const r4 = await resolveBrandConfig(pid3, null)
    check(r4.watermark?.path === absPathOf(wmRel) && r4.watermark?.source === 'asset', 'resolveBrandConfig 资产来源解析（asset）')
    const r5 = await resolveBrandConfig(pid2, JSON.stringify({ _compose: { brand: { watermark: { asset_id: wmAsset.id } } } }))
    check(r5.watermark === undefined, '资产不属本项目 → 宽容降级（不出现）')

    // ---- [P3] 品牌资产服务（upload/预览/清除；真实落 BRAND_DIR） ----
    const { uploadBrandAsset, getBrandAssetInfo, clearBrandAsset, isBrandSlot } = await import('../../../src/services/brand-assets')
    check(isBrandSlot('watermark') && isBrandSlot('intro') && isBrandSlot('outro') && !isBrandSlot('bogus'), 'isBrandSlot 白名单（watermark/intro/outro；bogus 拒绝）')
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const up1 = await uploadBrandAsset('watermark', { name: 'logo.png', data: pngBytes })
    const upFile = up1.watermark?.file ?? ''
    check(upFile.startsWith('watermark-') && upFile.endsWith('.png'), 'uploadBrandAsset 落盘命名 watermark-{ts}-{sanitize}.png 并回写 file')
    check(up1.watermark?.opacity === 0.5 && up1.watermark?.position === 'tl' && up1.subtitle?.size_pct === 0.03, '上传仅改 file 键（槽内参数与其他槽保留）')
    const badKind1 = await errOf(async () => uploadBrandAsset('watermark', { name: 'clip.mp4', data: pngBytes }))
    check(badKind1 instanceof Error && /类型不符/.test(String(badKind1)), 'watermark 槽上传视频 → bad_kind 拒绝')
    const badKind2 = await errOf(async () => uploadBrandAsset('intro', { name: 'logo.png', data: pngBytes }))
    check(badKind2 instanceof Error, 'intro 槽上传图片 → bad_kind 拒绝')
    const info1 = await getBrandAssetInfo('watermark')
    check(info1 !== null && info1.fileName === upFile && existsSync(info1.path) && info1.mime.startsWith('image/'), 'getBrandAssetInfo 引用解析（文件落盘 + mime）')
    const cleared = await clearBrandAsset('watermark')
    check(cleared.watermark?.file === undefined && cleared.watermark?.opacity === 0.5, 'clearBrandAsset 仅删 file 键（槽内参数保留）')
    check((await getBrandAssetInfo('watermark')) === null, '清除引用后预览 → null（路由 404 语义）')

    // ---- [P3] buildComposeArgs：零 diff 快照 + 水印链 ----
    const segNorm = (i: number): string =>
      `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=25,format=yuv420p[v${i}]`
    const r0 = buildComposeArgs(mkArgsInput({}))
    check(
      JSON.stringify(r0.args) === JSON.stringify([
        '-y',
        '-loop', '1', '-t', '3', '-i', 'a.png',
        '-loop', '1', '-t', '3', '-i', 'b.png',
        '-filter_complex', `${segNorm(0)};${segNorm(1)};[v0][v1]concat=n=2:v=1:a=0[basev]`,
        '-map', '[basev]',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', '25',
        '-movflags', '+faststart', 'C:/out/ep-final.mp4',
      ]),
      'buildComposeArgs 无水印/片头尾 → args 与 M11 组装逐字节一致（零 diff）',
    )
    check(r0.cwd === undefined && r0.totalAll === 6, '无片头尾：totalAll = Σd = 6；cwd 未启用')

    const rw = buildComposeArgs(mkArgsInput({
      segments: [{ id: 1, path: 'a.png', kind: 'image', durSec: 6 }],
      xfadePlan: { enabled: false, type: 'none', durSec: 0, videoLens: [6], offsets: [], totalDur: 6 },
      watermark: { path: 'C:/wm.png', position: 'br', opacity: 0.8, width_pct: 0.15, margin_px: 24 },
    }))
    const rwFc = rw.args[rw.args.indexOf('-filter_complex') + 1]!
    check(rwFc.includes('[1:v]scale=162:-1,format=rgba,colorchannelmixer=aa=0.8[wm]'), '水印归一：scale=round(1080×0.15)=162 + rgba/aa（输入索引 1）')
    check(rwFc.endsWith('[basev][wm]overlay=W-w-24:H-h-24[outv]') && rw.args.includes('[outv]'), '水印 overlay 于 [basev] 顶层（br 九宫格）+ maps [outv]')

    const gridExpect: Record<string, string> = {
      tl: '24:24', tc: '(W-w)/2:24', tr: 'W-w-24:24',
      ml: '24:(H-h)/2', mc: '(W-w)/2:(H-h)/2', mr: 'W-w-24:(H-h)/2',
      bl: '24:H-h-24', bc: '(W-w)/2:H-h-24', br: 'W-w-24:H-h-24',
    }
    const gridBad = Object.entries(gridExpect).filter(([pos, xy]) => watermarkOverlayXY(pos as never, 24) !== xy)
    check(gridBad.length === 0, `watermarkOverlayXY 九宫格矩阵 9/9（24px 边距）${gridBad.length ? `：${gridBad.map(([p]) => p).join(',')}` : ''}`)

    const rsw = buildComposeArgs(mkArgsInput({
      segments: [{ id: 1, path: 'a.png', kind: 'image', durSec: 6 }],
      xfadePlan: { enabled: false, type: 'none', durSec: 0, videoLens: [6], offsets: [], totalDur: 6 },
      srtAbs: 'C:/out/ep.srt',
      watermark: { path: 'C:/wm.png', position: 'mc', opacity: 0.5, width_pct: 0.1, margin_px: 0 },
    }))
    const rswFc = rsw.args[rsw.args.indexOf('-filter_complex') + 1]!
    check(
      rswFc.includes(`[basev]subtitles='ep.srt':force_style='FontName=X,FontSize=18'[subv]`) &&
        rswFc.includes('[subv][wm]overlay=(W-w)/2:(H-h)/2[outv]'),
      '字幕先烧录 [subv] → 水印 overlay 最顶层 [outv]（序保证）',
    )
    check(rsw.cwd === 'C:/out', 'cwd = SRT 所在目录（带水印时不变）')
  }
}
