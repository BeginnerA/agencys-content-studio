/** M19[subtitle-style]：mergeBrand 三层合并 + sanitizeSubtitleStyle 清洗 clamp + buildSubtitleStyle 零漂移/颜色/字段覆盖 + _compose.brand 写入（断言体逐字搬自原 probe-m19.ts） */
import type { M19Ctx } from './ctx'

export async function run(ctx: M19Ctx): Promise<void> {
  const { check, db, pid, T0, errOf, mergeBrand, sanitizeSubtitleStyle, pipelineRuns } = ctx
  {
    // ---- mergeBrand：字段级浅合并（三层覆盖 / 空层跳过 / 无层 = {}） ----
    const p1 = { subtitle: { size_pct: 0.03, color: '#FFFFFF' } }
    const p2 = { subtitle: { color: '#FF0000' } }
    const p3 = { subtitle: { bold: true } }
    const m = mergeBrand(p1, p2, p3)
    check(m.subtitle?.size_pct === 0.03 && m.subtitle?.color === '#FF0000' && m.subtitle?.bold === true, 'mergeBrand 字段级覆盖（同键后层胜/异键保留）')
    check(Object.keys(mergeBrand(null, undefined, {})).length === 0, 'mergeBrand 空层/空对象 → {}')
    const wm1 = mergeBrand({ watermark: { file: 'a.png', opacity: 0.5 } }, { watermark: { opacity: 0.2 } })
    check(wm1.watermark?.file === 'a.png' && wm1.watermark?.opacity === 0.2, 'mergeBrand 槽内字段合并（file 保留 + opacity 覆盖）')

    // ---- sanitizeSubtitleStyle：clamp / 类型过滤 / 空 → undefined ----
    const s1 = sanitizeSubtitleStyle({ size_pct: 0.9, outline_pct: -1, shadow: 2.6, margin_v_pct: 0.5 })
    check(s1?.size_pct === 0.06 && s1?.outline_pct === 0 && s1?.shadow === 3 && s1?.margin_v_pct === 0.1, 'sanitizeSubtitleStyle clamp（size/outline/shadow/margin）+ 取整')
    const s2 = sanitizeSubtitleStyle({ size_pct: 0.001 })
    check(s2?.size_pct === 0.008, 'sanitizeSubtitleStyle 下界 clamp（0.008）')
    const s3 = sanitizeSubtitleStyle({ color: 'red', outline_color: '#00FF00', alignment: 3 as never, bold: true })
    check(s3?.color === undefined && s3?.outline_color === '#00FF00' && s3?.alignment === undefined && s3?.bold === true, 'sanitizeSubtitleStyle 非法值过滤（非 hex 色/非法对齐）+ 合法保留')
    check(sanitizeSubtitleStyle({}) === undefined, 'sanitizeSubtitleStyle 无合法字段 → undefined（不接管）')
    const s4 = sanitizeSubtitleStyle({ font: '  Source Han Sans  ', alignment: 8 })
    check(s4?.font === 'Source Han Sans' && s4?.alignment === 8, 'sanitizeSubtitleStyle font trim + alignment 枚举保留')

    // ---- [P2] buildSubtitleStyle 零漂移红线 ----
    const { buildSubtitleStyle, defaultSubtitleStyle, toAssColor } = await import('../../../src/pipeline/actions/ffmpeg-merge')
    const drift = [360, 720, 1080, 1920].filter((h) => buildSubtitleStyle(h, {}) !== defaultSubtitleStyle(h))
    check(drift.length === 0, 'buildSubtitleStyle(H,{}) === defaultSubtitleStyle(H) 逐字相等（零漂移红线 H=360/720/1080/1920）')

    // ---- [P2] ASS 颜色转换 ----
    check(
      toAssColor('#FF0000') === '&H000000FF' && toAssColor('#00FF00') === '&H0000FF00' && toAssColor('#0000FF') === '&H00FF0000',
      'toAssColor #RRGGBB → &H00BBGGRR（红/绿/蓝）',
    )
    check(toAssColor('#ffffff') === '&H00FFFFFF', 'toAssColor 小写输入规范为大写')

    // ---- [P2] 字段覆盖 ----
    const custom = buildSubtitleStyle(1000, { color: '#FF0000' })
    check(
      custom.includes('PrimaryColour=&H000000FF') && custom.includes('FontSize=18') && custom.includes('FontName=Noto Sans CJK SC'),
      'color 覆盖仅改主色（其余基线保留）',
    )
    const f2 = buildSubtitleStyle(1000, { size_pct: 0.03, margin_v_pct: 0.05, outline_pct: 0.002, shadow: 2 })
    check(f2.includes('FontSize=30') && f2.includes('MarginV=50') && f2.includes('Outline=2') && f2.includes('Shadow=2'), 'size/margin_v/outline/shadow 数值覆盖')
    const f3 = buildSubtitleStyle(1000, { alignment: 8, bold: true })
    check(f3.endsWith(',Alignment=8,Bold=1') && f3.startsWith('FontName=Noto Sans CJK SC,FontSize=18'), 'alignment/bold 末尾追加（不影响基线字段序）')
    const snap = buildSubtitleStyle(1920, { font: 'Source Han Sans', size_pct: 0.018, color: '#FFFFFF', outline_color: '#000000', outline_pct: 0.0009, shadow: 0, margin_v_pct: 0.02 })
    check(
      snap === 'FontName=Source Han Sans,FontSize=35,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,MarginV=38',
      '全字段快照（1920 重构；字段序与基线一致）',
    )

    // ---- [P2] _compose.brand 写入（白名单 + clamp + 槽级清除） ----
    const { updateComposeConfig } = await import('../../../src/services/compose-config')
    const runRow = (
      await db
        .insert(pipelineRuns)
        .values({ projectId: pid, templateKey: 'mengbao-episode', status: 'completed', input: '{}', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!
    const cfg1 = await updateComposeConfig(runRow.id, { brand: { subtitle: { size_pct: 0.9, color: '#123456' } } })
    check(cfg1.brand?.subtitle?.size_pct === 0.06 && cfg1.brand?.subtitle?.color === '#123456', 'updateComposeConfig brand.subtitle 写入（clamp 0.9→0.06）')
    const cfg2 = await updateComposeConfig(runRow.id, { brand: { watermark: { opacity: 0.2 } } })
    check(cfg2.brand?.subtitle?.size_pct === 0.06 && cfg2.brand?.watermark?.opacity === 0.2, 'brand 分槽累积写（subtitle 保留 + watermark 追加）')
    const cfg3 = await updateComposeConfig(runRow.id, { brand: { subtitle: null } })
    check(cfg3.brand?.subtitle === undefined && cfg3.brand?.watermark?.opacity === 0.2, '槽级清除（subtitle:null → 回落继承，watermark 保留）')
    const badBrand = await errOf(async () => updateComposeConfig(runRow.id, { brand: { subtitle: 'x' } }))
    check(badBrand instanceof Error && /subtitle/.test(String(badBrand)), 'brand.subtitle 非对象 → 拒绝（bad_field）')
    const badBrand2 = await errOf(async () => updateComposeConfig(runRow.id, { brand: { bogus: 1 } }))
    check(badBrand2 instanceof Error, 'brand 无已知槽键 → 拒绝')
  }
}
