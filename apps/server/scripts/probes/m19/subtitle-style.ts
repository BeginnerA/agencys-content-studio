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

  {
    // ---- [M32] 字幕预换行 + SRT→ASS（内置 libass 不换 CJK → 防横向溢出）----
    const { estimateMaxCharsPerLine, wrapSingleLine, wrapSrtText, srtToAss } = await import('../../../src/pipeline/actions/ffmpeg-merge')

    // 预算（ASS PlayRes 语境：字号=真实像素）：竖屏 720×1280 / FontSize=23 → 单行字数预算，预算行必能装进可用宽（含 5% 边距）
    const budget720 = estimateMaxCharsPerLine(720, 23)
    check(budget720 >= 1 && budget720 * 23 <= 720, `estimateMaxCharsPerLine(720,23)=${budget720}：预算行（≥1em/字）必不溢出画面宽度`)
    // 越宽预算越大；字号越大预算越小（单调）
    check(estimateMaxCharsPerLine(1280, 23) > estimateMaxCharsPerLine(720, 23), '宽度越大单行预算越大')
    check(estimateMaxCharsPerLine(720, 40) < estimateMaxCharsPerLine(720, 23), '字号越大单行预算越小')
    check(estimateMaxCharsPerLine(0, 23) === 1 && estimateMaxCharsPerLine(720, 0) >= 1, '退化入参兜底 ≥1（不返回 0/负）')

    // 单行换行：无丢失、每物理行 ≤ 预算、优先落在标点后
    const long = '月光落下来，正好照在他张开的小手上。'
    const segs = wrapSingleLine(long, 12)
    check(segs.join('') === long, 'wrapSingleLine 切分后拼接与原文逐字相等（无丢字/重字）')
    check(segs.every((s) => Array.from(s).length <= 12), 'wrapSingleLine 每个物理行 ≤ 预算字数')
    check(segs.length > 1 && segs[0]!.endsWith('，'), 'wrapSingleLine 优先在标点处断行（首行以逗号收尾）')
    check(wrapSingleLine('短句', 12).length === 1, '未超预算 → 原样单行不切')
    check(wrapSingleLine('无标点连续中文字符串abcdefg', 5).every((s) => Array.from(s).length <= 5), '无标点可断 → 按预算硬切仍不超限')

    // 整份 SRT：序号/时间戳/空行结构保留，文本行全部 ≤ 预算
    const srt = `1\n00:00:00,000 --> 00:00:02,241\n夏天，四个月大的小小杨，\n\n2\n00:00:02,241 --> 00:00:04,296\n第一次在窗边遇见月亮。\n`
    const wrapped = wrapSrtText(srt, 10)
    const lines = wrapped.split('\n')
    check(lines.filter((l) => /^\d+$/.test(l)).length === 2, 'wrapSrtText 保留 cue 序号行')
    check((wrapped.match(/-->\s*\d{2}:\d{2}:\d{2}/g) ?? []).length === 2, 'wrapSrtText 保留时间戳行（未被换行破坏）')
    const textLines = lines.filter((l) => l.trim() !== '' && !/^\d+$/.test(l) && !l.includes('-->'))
    // 预算内硬切；行尾若为标点则吸收（避免孤立标点行）——故最多 预算+1（预算已含 40% 宽余量，+1 字仍不溢出）
    check(textLines.every((l) => Array.from(l).length <= 11), 'wrapSrtText 每条文本行 ≤ 预算+1（行尾标点吸收容差）')
    check(textLines.join('').includes('四个月大的小小杨') && textLines.join('').includes('遇见月亮'), 'wrapSrtText 文本内容完整保留')
    // 幂等：再包一次不变
    check(wrapSrtText(wrapped, 10) === wrapped, 'wrapSrtText 幂等（二次换行不变）')
    // 预算 ≤0 → 原样返回
    check(wrapSrtText(srt, 0) === srt && wrapSrtText(srt, -1) === srt, 'maxCharsPerLine ≤0 → 原样返回（不换行）')
    // CRLF 风格保持
    check(wrapSrtText(srt.replace(/\n/g, '\r\n'), 10).includes('\r\n'), 'wrapSrtText 保持原 CRLF 换行风格')

    // ---- [M32] srtToAss：显式 PlayRes + Style 边距 + \\N 预换行 + 时间戳转换 ----
    const ass = srtToAss(srt, { width: 720, height: 1280 })
    check(ass.includes('[Script Info]') && ass.includes('PlayResX: 720') && ass.includes('PlayResY: 1280'), 'srtToAss 头部声明 PlayResX/Y = 输出尺寸（修复二次放大）')
    check(ass.includes('ScaledBorderAndShadow: yes') && ass.includes('WrapStyle: 0'), 'srtToAss 关键 Script Info（缩放边框阴影 / 换行样式）')
    check(ass.includes('[V4+ Styles]') && ass.includes('Style: Default,Noto Sans CJK SC,'), 'srtToAss 输出 Default Style（字体基线与 force_style 同源）')
    // Style 行含左右边距（width×0.05=36）与底部边距（height×0.02=26）、字号（1280×0.018≈23）
    const styleLine = ass.split('\n').find((l) => l.startsWith('Style: Default,')) ?? ''
    check(styleLine.includes(',2,36,36,26,1'), `srtToAss Style 边距 Alignment=2/MarginL=R=36/MarginV=26（真实像素）`)
    // 时间戳：SRT 00:00:02,241 → ASS 0:00:02.24（厘秒）
    check(ass.includes('0:00:00.00,0:00:02.24'), 'srtToAss 时间戳 SRT hh:mm:ss,mmm → ASS h:mm:ss.cc')
    check((ass.match(/^Dialogue: 0,/gm) ?? []).length === 2, 'srtToAss 每条 cue → 一行 Dialogue')
    // 超长行以 \\N 预换行（构造一条 30 字长句 → 必含 \\N）
    const longSrt = `1\n00:00:00,000 --> 00:00:05,000\n${'一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'}\n`
    const longAss = srtToAss(longSrt, { width: 720, height: 1280 })
    check(longAss.includes('\\N'), 'srtToAss 超长行以 \\N 预换行（内置 libass 不换 CJK 兼底）')
    const dlg = longAss.split('\n').find((l) => l.startsWith('Dialogue: 0,')) ?? ''
    const marker = ',Default,,0,0,0,,'
    const textPart = dlg.slice(dlg.indexOf(marker) + marker.length)
    check(textPart.split('\\N').every((seg) => Array.from(seg).length <= budget720), 'srtToAss 每个 \\N 段 ≤ 单行预算（不溢出）')
    // {} 与反斜杠控制符转义（不破坏事件结构）
    const escAss = srtToAss(`1\n00:00:00,000 --> 00:00:01,000\n测{试}文\\本\n`, { width: 720, height: 1280 })
    check(!/测\{试\}/.test(escAss) && escAss.includes('测试文本'), 'srtToAss 转义剥离 {} 与 \\（防注入覆盖标签）')
  }
}
