/**
 * M61 探针（混剪开场标题智能编排 + 标题字卡）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m61.ts [--section=pure|ass|template|llm|ai|live]
 *
 * 隔离策略：isolatedEnv('m61', bridge templates+prompts) 一次性临时目录（独立 studio.db + workspace），
 * 必须先于任何 src 动态 import。live 零网络零付费：真 engine.startRun 走 photo-montage v3
 * 全链（style_mode=rule + title_card=local），素材本地 ffmpeg 生成，fetch 桩封死 + 用量表零行断言。
 *
 * 断言面（spec §六）：
 *  - pure：planTitleStyle 规则真值表（短/长/多行/竖屏/混合）/ parseStylePlan 清洗与降级 /
 *    title-card 转义与 args 形状（色底默认 #101826、逐行 drawtext、字号下限；T6 AI 底图分支：
 *    图片输入 + scale/crop 满幅 + drawbox 压暗 + drawtext 叠字，空白串回落色底）/ resolveCjkFont 宽容；
 *  - ass：srtToAss 缺省零 diff（无 cutCues = cutCues:0 逐字节；T7 styles/cueStyle 缺位亦逐字节）/ cutCues 前后事件数与首行文本 /
 *    T7 多 Style：Default+Title 双行形状、cue→Style 映射、越界回落、cut 索引偏移、大字组换行预算 / buildAssBurnPaths 主+派生同裁、合并 cfg 与具名组派生字号重算；
 *  - template：photo-montage v3 版本行 + 三新入参 off 默认 + captions/compose 桥映射 +
 *    T6 card_bg/card_bg_img 子链静态面（when=ai 门控 + after 反级联 + purpose=title_card_bg）+
 *    title-style.md / title-card-bg.md 出厂登记（清单现共 50 份，随并行里程碑演进）；
 *  - llm：style_mode=llm mock 离线（成功采用+计费 1 行 / 畸形产物降级 rule 仍计费 / 无实例降级零调用）；
 *  - ai：T6 全 mock 离线实弹（LLM 桩产 shots JSON + 图像桩 b64_json 出底图 → 底图分支卡真烧 ffmpeg；
 *    溯源 mode=ai + 叠字白像素 + 计费 llm2+image1）；降级边界：未配图像实例 → 生图步失败 run 收敛 failed（引擎全局语义，非断链 silent 降级）；
 *  - live：run A rule+local 全链（卡段片首/总长含卡/首帧含白字/ASS 裁标题 cue/溯源增键/images 计数排除卡/
 *    timeline 容错/临时 png 清理）；run B 对照组 off（资产与成片 params 零增键、总长逐字节 = 现状语义）；
 *    run C T7 分层烧录实弹（rule 开卡不开：标题 cue 走 Title1 居中，墨迹位置 vs 对照底部分层）。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup } = isolatedEnv('m61', { bridge: ['templates', 'prompts'] })

const SECTIONS = ['pure', 'ass', 'template', 'llm', 'ai', 'live'] as const

const { createLogger } = await import('../src/logger')
const log = createLogger('probe-m61')
const checker: Checker = makeChecker(log)
const check = checker.check

await runSections({
  log,
  title: 'M61',
  checker,
  cleanup,
  sections: SECTIONS,
  registry: async () => {
    const { initDb } = await import('../src/db')
    await initDb()
    check(true, '初始化隔离库完成（零真实执行）')
  },
  runners: {
    // ================= pure：规则排版 / LLM 产物清洗 / 字卡纯函数 =================
    pure: async () => {
      const { planTitleStyle, parseStylePlan } = await import('../src/pipeline/actions/subtitle')
      const { escapeFilterPath, escapeDrawtext, toDrawtextColor, cardFontSize, layoutCardLines, buildTitleCardArgs, resolveCjkFont, parseM61SubtitleParams } = await import('../src/pipeline/actions/ffmpeg-merge/title-card')

      // —— planTitleStyle 真值表 ——
      // 横屏短标题纯标题：1920x1080，4 字 → 最大档 0.06（预算 26 字）；无正文 → 居中 5
      const p1 = planTitleStyle([{ text: '喜结连理', role: 'title' }], { width: 1920, height: 1080 })
      check(p1.styles.length === 1 && p1.style.size_pct === 0.06 && p1.style.alignment === 5 && p1.style.bold === true && p1.cue_style.join(',') === '0', `横屏短标题纯标题：0.06/居中/加粗（实际 ${JSON.stringify(p1.style)}）`)
      // 混合：标题 + 正文 → 标题置顶 8、styles 两组、style（全局主样式）= 正文组基线（正文零惊扰）
      const p2 = planTitleStyle([{ text: '标题', role: 'title' }, { text: '正文第一句', role: 'body' }, { text: '正文第二句', role: 'body' }], { width: 1920, height: 1080 })
      check(p2.styles.length === 2 && p2.styles[0]!.alignment === 8 && p2.styles[1]!.size_pct === 0.04 && p2.styles[1]!.alignment === 2 && p2.style.alignment === 2 && p2.cue_style.join(',') === '0,1,1', `混合角色：标题 8 / 正文 2 / 主样式=正文组（实际 ${JSON.stringify(p2.cue_style)}）`)
      // 长标题自适应降档：30 字 @1920x1080 → 0.06(26)/0.055(29) 不适、0.05(32) 命中
      const long = '一'.repeat(30)
      const p3 = planTitleStyle([{ text: long, role: 'title' }], { width: 1920, height: 1080 })
      check(p3.styles[0]!.size_pct === 0.05, `30 字长标题降档至 0.05（实际 ${p3.styles[0]!.size_pct}）`)
      // 全档不适配 → 最小档 0.04 兜底
      const p4 = planTitleStyle([{ text: '一'.repeat(60), role: 'title' }], { width: 1920, height: 1080 })
      check(p4.styles[0]!.size_pct === 0.04, '60 字超宽标题 → 最小档 0.04 换行兜底')
      // 竖屏：outline_pct 0.0018 加粗描边抗亮底；预算按 1080 宽（0.06→115px→8 字）
      const p5 = planTitleStyle([{ text: '六字标题哦哦', role: 'title' }], { width: 1080, height: 1920 })
      check(p5.styles[0]!.outline_pct === 0.0018 && p5.styles[0]!.size_pct === 0.06, `竖屏六字 → 0.06 + 粗描边（实际 ${JSON.stringify(p5.styles[0])}）`)

      // —— parseStylePlan：清洗 / 校正 / 降级 ——
      const roles = [{ text: '标题', role: 'title' as const }, { text: '正文', role: 'body' as const }]
      const ok = parseStylePlan(JSON.stringify({ styles: [{ size_pct: 0.05, color: '#FF8800', alignment: 8, bold: true }, { size_pct: 0.04 }], assign: [0, 1] }), roles, { width: 1920, height: 1080 })
      check(!!ok && ok.styles.length === 2 && ok.styles[0]!.color === '#FF8800' && ok.style.size_pct === 0.04 && ok.style.alignment === undefined && ok.cue_style.join(',') === '0,1', `合法两组合产物：逐字段保留、主样式=正文组原样（实际 ${JSON.stringify(ok?.style)}）`)
      const dirty = parseStylePlan('```json\n{"styles":[{"size_pct":0.5,"color":"red","shadow":99,"alignment":7,"bold":"yes"}]}\n```', roles, { width: 1920, height: 1080 })
      check(!!dirty && dirty.styles[0]!.size_pct === 0.06 && dirty.styles[0]!.shadow === 8 && dirty.styles[0]!.color === undefined && dirty.styles[0]!.alignment === undefined && dirty.styles[0]!.bold === undefined, '畸形字段清洗：clamp 0.06/8、非法 color/alignment/bold 全丢弃')
      const shortAssign = parseStylePlan(JSON.stringify({ styles: [{ size_pct: 0.05 }, { size_pct: 0.03 }], assign: [5] }), roles, { width: 1920, height: 1080 })
      check(!!shortAssign && shortAssign.cue_style.join(',') === '0,1', 'assign 长度不符 → 逐行按 role 推导校正（越界下标 5 亦校正）')
      check(parseStylePlan('完全不是 JSON', roles, { width: 1, height: 1 }) === null, '非 JSON → null（调用方降级规则层）')
      check(parseStylePlan('{"styles":[]}', roles, { width: 1, height: 1 }) === null, 'styles 空数组 → null')
      check(parseStylePlan('[1,2,3]', roles, { width: 1, height: 1 }) === null, '根为数组 → null')

      // —— title-card 转义与形状 ——
      check(escapeFilterPath('C:\\Windows\\Fonts\\msyh.ttc') === 'C\\:/Windows/Fonts/msyh.ttc', 'fontfile 转义：反斜杠→正斜杠、冒号→\\:')
      check(escapeDrawtext("o'clock") === "o\\'clock" && escapeDrawtext('a:b') === 'a\\:b' && escapeDrawtext('50%') === '50\\%' && escapeDrawtext('a\\b') === 'a\\\\b', 'drawtext 文本四字符保守全逃')
      check(toDrawtextColor('#101826') === '0x101826' && toDrawtextColor('red') === '0xFFFFFF', '颜色 #RRGGBB→0xRRGGBB，非法回退白')
      check(cardFontSize(1080, {}) === 59 && cardFontSize(200, { size_pct: 0.04 }) === 24, '卡内字号 = H×0.055 四舍五入（1080→59），下限 24')
      const rows = layoutCardLines(['一'.repeat(25), '  ', '短句'], 320, 24)
      check(rows.length === 4 && rows[0]!.length === 12 && rows[2] === '一' && rows[3] === '短句', `宽度预算预换行 + 空行跳过（320 宽 24 字号 → 12 字/行，25 字拆 12/12/1；实际 ${rows.map((r) => r.length)}）`)
      const args = buildTitleCardArgs({ fontFile: 'C:\\Windows\\Fonts\\msyh.ttc', lines: ['标题', '第二行祝福语'], width: 1920, height: 1080, fps: 25, outAbs: 'out/card.png', style: { size_pct: 0.05, bold: true } })
      const joined = args.join(' ')
      check(joined.includes('color=c=0x101826:s=1920x1080:r=25') && joined.includes('-frames:v 1'), '单帧 PNG：默认底色 #101826 + 尺寸帧率 + -frames:v 1')
      const drawCount = (joined.match(/drawtext=/g) ?? []).length
      check(drawCount === 2, `逐行一条 drawtext（实际 ${drawCount} 条）`)
      check(joined.includes("fontfile='C\\:/Windows/Fonts/msyh.ttc'") && joined.includes('fontsize=54') && joined.includes('borderw=2') && joined.includes('fontcolor=0xFFFFFF'), '字号 54（1080×0.05）/ 描边 2（1080×0.0018）/ 白字')
      check(joined.includes(':y=470:') && joined.includes(':y=540:'), '两行块居中：startY=(1080−2×70)/2=470，行距 70')
      const topArgs = buildTitleCardArgs({ fontFile: 'f', lines: ['一行'], width: 1920, height: 1000, fps: 25, outAbs: 'o.png', alignment: 8 }).join(' ')
      check(topArgs.includes(':y=80:'), 'alignment 8 → 顶部上边距 8%H=80')
      // T6 AI 底图分支形状：图片输入代替 lavfi 色底，满幅 scale/crop + drawbox 压暗后叠同一 drawtext 链
      const aiArgs = buildTitleCardArgs({ fontFile: 'f', lines: ['标题'], width: 1920, height: 1080, fps: 25, outAbs: 'o.png', bgImageAbs: 'C:/ws/card_bg.png' }).join(' ')
      check(aiArgs.includes("-i C:/ws/card_bg.png") && aiArgs.includes('scale=1920:1080:force_original_aspect_ratio=increase') && aiArgs.includes('crop=1920:1080,') && aiArgs.includes('drawbox=x=0:y=0:w=1920:h=1080:color=black@0.45:t=fill') && /drawtext=/.test(aiArgs) && !aiArgs.includes('lavfi'), 'T6 底图分支：图片输入 + 满幅缩放裁剪 + 半透压暗 + 叠字（不走色底）')
      const blankBg = buildTitleCardArgs({ fontFile: 'f', lines: ['标题'], width: 640, height: 480, fps: 25, outAbs: 'o.png', bgImageAbs: '   ' }).join(' ')
      check(blankBg.includes('-f lavfi') && !blankBg.includes('drawbox'), 'bgImageAbs 空白串 → 色底分支逐字节不变（降级 local）')
      let threw = false
      try { buildTitleCardArgs({ fontFile: 'f', lines: ['  ', ''], width: 1920, height: 1080, fps: 25, outAbs: 'o.png' }) } catch { threw = true }
      check(threw, '无有效文字行 → 抛错（调用方捕获降级）')
      const { fileURLToPath } = await import('node:url')
      const selfPath = fileURLToPath(import.meta.url)
      check(resolveCjkFont({ ACS_CJK_FONT_FILE: selfPath } as never) === selfPath, 'ACS_CJK_FONT_FILE 命中优先返回该文件')
      const fb = resolveCjkFont({ ACS_CJK_FONT_FILE: 'Z:/nope/nope.ttf', WINDIR: 'Z:/nope' } as never)
      check(fb === null || existsSync(fb), `候选兜底宽容：null 或真实存在文件（实际 ${fb}）`)

      // —— parseM61SubtitleParams（[M61-split] 拆出纯函数直测）——
      const mp0 = parseM61SubtitleParams('{"durationMs":12500}')
      check(mp0.endMs === 12500 && mp0.titleLines === 0 && mp0.msPerLine === 0 && mp0.leadInMs === 0 && mp0.stylePlan === null, '仅 durationMs → M61 键全零（存量语义）')
      const mp1 = parseM61SubtitleParams('{"title_lines":2.4,"ms_per_line":-100,"lead_in_ms":0,"style_plan":[1]}')
      check(mp1.titleLines === 2 && mp1.msPerLine === 0 && mp1.leadInMs === 0 && mp1.stylePlan === null, '小数行取整/负时长弃用/lead_in 0 合法/style_plan 数组非法弃用')
      check(parseM61SubtitleParams('损坏{json') .titleLines === 0 && parseM61SubtitleParams(null).endMs === 0, '损坏 JSON/null params → 零值不抛错（烧录不受影响）')
    },

    // ================= ass：缺省零 diff + cutCues + 派生路 =================
    ass: async () => {
      const { srtToAss, buildAssBurnPaths, parseSrtCues } = await import('../src/pipeline/actions/ffmpeg-merge/subtitle-ass')
      const { buildSubtitleStyle } = await import('../src/pipeline/actions/ffmpeg-merge/subtitle-style')
      const srt = [
        '1\n00:00:00,500 --> 00:00:04,500\n标题行甲\n',
        '2\n00:00:04,500 --> 00:00:08,500\n标题行乙\n',
        '3\n00:00:08,500 --> 00:00:12,500\n正文句一\n',
        '4\n00:00:12,500 --> 00:00:16,500\n正文句二\n',
      ].join('\n')
      check(parseSrtCues(srt).length === 4, '4 cue 基线')
      const a0 = srtToAss(srt, { width: 1280, height: 720 })
      const a1 = srtToAss(srt, { width: 1280, height: 720, cutCues: 0 })
      check(a0 === a1, '缺省 = cutCues:0 输出逐字节一致（零 diff 红线）')
      const eventsOf = (doc: string): number => (doc.match(/^Dialogue: /gm) ?? []).length
      check(eventsOf(a0) === 4, '无裁切 → 4 条 Dialogue')
      const a2 = srtToAss(srt, { width: 1280, height: 720, cutCues: 2 })
      check(eventsOf(a2) === 2 && !a2.includes('标题行甲') && a2.includes('正文句一'), 'cutCues=2 → 裁前两条标题 cue，正文保留')
      const a9 = srtToAss(srt, { width: 1280, height: 720, cutCues: 9 })
      check(eventsOf(a9) === 0 && a9.includes('[Events]'), 'cutCues 超总数 → 空事件（文档仍合法，烧录无字幕由卡呈现）')

      // —— T7 多 Style 分层：文档形状 / cue→Style 映射 / 越界回落 / 零 diff 扩展 ——
      const stl = [
        { name: 'Title1', cfg: { size_pct: 0.06, alignment: 8 as const, bold: true, color: '#FFCC00' } },
        { name: 'Title2', cfg: { size_pct: 0.04 } },
      ]
      const a3 = srtToAss(srt, { width: 1280, height: 720, styles: stl, cueStyle: [0, 0, 1, 1] })
      check((a3.match(/^Style: /gm) ?? []).length === 3, `Default 之外追加两组 Style 行（实际 ${((a3.match(/^Style: /gm) ?? []).length)} 行）`)
      check(a3.includes('Style: Title1,Noto Sans CJK SC,43,&H0000CCFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,1,0,8,64,64,14,1'), `Title1 行逐字段形状（720×0.06=43/#FFCC00→&H0000CCFF/Bold=1/顶部 8/边距同 Default；实际 ${/^Style: Title1.*$/m.exec(a3)?.[0]}）`)
      check(a3.includes('Style: Title2,Noto Sans CJK SC,29,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,64,64,14,1'), 'Title2 行缺省字段回落基线（白字常规底部）')
      const dls = a3.split('\n').filter((l) => l.startsWith('Dialogue: '))
      check(dls[0]!.includes(',Title1,,0,0,0,,') && dls[2]!.includes(',Title2,,0,0,0,,'), 'cue→Style 映射：前两条标题行走 Title1、后两条正文走 Title2')
      const a4 = srtToAss(srt, { width: 1280, height: 720, styles: stl, cueStyle: [5, 0, 1, 1] })
      check(a4.split('\n').filter((l) => l.startsWith('Dialogue: '))[0]!.includes(',Default,,0,0,0,,'), 'cueStyle 越界下标 → 该 cue 回落 Default（不毁文档）')
      const a5 = srtToAss(srt, { width: 1280, height: 720, styles: stl, cueStyle: [0, 0, 1, 1], cutCues: 2 })
      const dls5 = a5.split('\n').filter((l) => l.startsWith('Dialogue: '))
      check(dls5.length === 2 && dls5.every((l) => l.includes(',Title2,,0,0,0,,')), 'cutCues 与 cueStyle 索引偏移正确：裁后剩两行均走正文组')
      check(a0 === srtToAss(srt, { width: 1280, height: 720, styles: [], cueStyle: [0, 0, 1, 1] }) && a0 === srtToAss(srt, { width: 1280, height: 720, cueStyle: [0, 1] }), 'T7 零 diff 红线：styles 缺位/空（即使 cueStyle 存在）→ 逐字节 = 现状')
      const srtLong60 = `1\n00:00:00,000 --> 00:00:04,000\n${'一'.repeat(60)}\n`
      const lz1 = srtToAss(srtLong60, { width: 1280, height: 720 })
      const lz2 = srtToAss(srtLong60, { width: 1280, height: 720, styles: [{ name: 'Title1', cfg: { size_pct: 0.06 } }], cueStyle: [0] })
      check(((lz2.match(/\\N/g) ?? []).length) > ((lz1.match(/\\N/g) ?? []).length), '换行预算按各 cue 生效样式字号：60 字在大字组（0.06）拆行多于 Default（0.04）')
      check(buildSubtitleStyle(720, {}) === (await import('../src/pipeline/actions/ffmpeg-merge/subtitle-style')).defaultSubtitleStyle(720), 'buildSubtitleStyle(H,{}) = defaultSubtitleStyle(H) 恒等保持')

      // buildAssBurnPaths：主 + 派生同裁；合并 cfg 派生字号按该路高重算
      const { mkdtempSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const dir = mkdtempSync(join(tmpdir(), 'm61-ass-'))
      const srtAbs = join(dir, 'x.srt')
      writeFileSync(srtAbs, srt, 'utf8')
      const temps: string[] = []
      const paths = buildAssBurnPaths({ srtAbs, style: 'FontSize=43', width: 1920, height: 1080, runId: 1, brandSubtitle: { size_pct: 0.05 }, temps, cutCues: 2, derived: [{ w: 1080, h: 1920 }] })
      check(paths.length === 2 && existsSync(paths[0]!) && existsSync(paths[1]!), '主 + 派生两份 ASS 落盘')
      const mainAss = readFileSync(paths[0]!, 'utf8')
      check(eventsOf(mainAss) === 2 && mainAss.includes('PlayResY: 1080') && !mainAss.includes('标题行甲'), '主路同裁（FontSize=43 → 换行预算按 43）')
      const derAss = readFileSync(paths[1]!, 'utf8')
      check(derAss.includes('Style: Default,Noto Sans CJK SC,96,') && derAss.includes('PlayResY: 1920'), `派生路字号按合并 cfg 重算（1920×0.05=96；实际 ${/SC,(\d+)/.exec(derAss)?.[1]}）`)
      check(eventsOf(derAss) === 2, '派生路同裁 2 cue')
      for (const t of temps) unlinkSync(t)
      check(temps.every((t) => !existsSync(t)), 'temps 清单交回调用方清理（路径逐一登记）')

      // T7：buildAssBurnPaths 多 Style 透传，具名组字号按各路高度重算；cueStyle 越界组落 Default
      const temps2: string[] = []
      const paths2 = buildAssBurnPaths({ srtAbs, style: 'FontSize=43', width: 1920, height: 1080, runId: 2, brandSubtitle: null, temps: temps2, derived: [{ w: 1080, h: 1920 }], styles: [{ name: 'Title1', cfg: { size_pct: 0.06, alignment: 8, bold: true } }], cueStyle: [0, 0, 1, 1] })
      const main7 = readFileSync(paths2[0]!, 'utf8')
      const der7 = readFileSync(paths2[1]!, 'utf8')
      check(main7.includes('Style: Title1,Noto Sans CJK SC,65,') && der7.includes('Style: Title1,Noto Sans CJK SC,115,'), `具名组字号按各路高重算（1080×0.06=65 / 1920×0.06=115；实际 ${/Style: Title1,Noto Sans CJK SC,(\d+)/.exec(der7)?.[1]}）`)
      check(main7.split('\n').filter((l) => l.startsWith('Dialogue: '))[2]!.includes(',Default,,') && der7.split('\n').filter((l) => l.startsWith('Dialogue: '))[0]!.includes(',Title1,,') && (der7.match(/^Style: /gm) ?? []).length === 2, '主/派生同映射：越界组回落 Default，Title1 接前两条（Default+具名共两行）')
      for (const t of temps2) unlinkSync(t)

      // T7 配套①：defaultCfg → Default 行全量承接合并主样式（颜/描边/阴影/落位；字号仍用 opts.fontSize 基线链）
      const a6 = srtToAss(srt, { width: 1280, height: 720, defaultCfg: { color: '#FF0000', bold: true, outline_pct: 0.0018, shadow: 2, alignment: 8 } })
      check(a6.includes('Style: Default,Noto Sans CJK SC,29,&H000000FF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,1,2,8,64,64,14,1'), `defaultCfg 行形状（29 基线字号/#FF0000→&H000000FF/Bold=1/Outline=1/Shadow=2/顶部 8；实际 ${/^Style: Default.*$/m.exec(a6)?.[0]}）`)
      check(a0 === srtToAss(srt, { width: 1280, height: 720, defaultCfg: undefined }), 'defaultCfg 缺位 → Default 行逐字节 = 现状（零 diff）')

      // T7 配套②：args 层 assLayered → 各路省略 force_style（本机 libass 实测其覆盖全部 Style 行会毁分层）
      const { buildComposeArgs } = await import('../src/pipeline/actions/ffmpeg-merge/args')
      const mkArgs = (layered: boolean): string => buildComposeArgs({
        segments: [{ id: 1, path: 'a.png', kind: 'image', durSec: 2 }], width: 320, height: 240, fps: 25,
        xfadePlan: { enabled: false, type: 'fade', durSec: 0.5, offsets: [], videoLens: [2], totalDur: 2 },
        voicePaths: [], lineIds: [], alignPlan: null, total: 2, srtAbs: 'x.srt', style: "FontSize=16", bgmPath: null, bgmVolume: 0.3, bgmFade: 0,
        watermark: null, intro: null, outro: null, outAbs: 'o.mp4', subtitlePaths: ['x.ass'], ...(layered ? { assLayered: true } : {}),
      }).args.join(' ')
      const flatArgs = mkArgs(false)
      const layArgs = mkArgs(true)
      check(flatArgs.includes("subtitles='x.ass':force_style='FontSize=16'[outv]"), 'assLayered 缺省 → subtitles+force_style 逐字节现状')
      check(layArgs.includes("subtitles='x.ass'[outv]") && !layArgs.includes('force_style'), 'assLayered → 烧录链无 force_style（分层由 Style 行自持）')
    },

    // ================= template：photo-montage v3 静态面 + 出厂提示词 =================
    template: async () => {
      const { loadTemplate, templateFlags } = await import('../src/pipeline/loader')
      const { BUILTIN_PROMPT_NAMES, isBuiltinPrompt } = await import('../src/pipeline/builtin-assets')
      const { loadPromptTemplate } = await import('../src/services/llm')
      const t = loadTemplate('photo-montage')
      check(t.version === 3, `photo-montage version=3（实际 ${t.version}）`)
      check(templateFlags('photo-montage').builtin === true, 'builtin=true 出厂只读')
      const keys = t.inputs?.map((i) => i.key) ?? []
      check(['style_mode', 'title_card', 'title_card_bg'].every((k) => keys.includes(k)), `三新入参齐备（实际 ${keys.join('/')}）`)
      const sm = t.inputs!.find((i) => i.key === 'style_mode') as never as Record<string, unknown>
      check(JSON.stringify(sm.options) === JSON.stringify(['off', 'rule', 'llm']) && sm.default === 'off' && (sm.options as unknown[]).every((o) => typeof o === 'string'), 'style_mode 选项 [off,rule,llm] 全字符串、默认 off（off 未被 YAML 解析为布尔）')
      const tc = t.inputs!.find((i) => i.key === 'title_card') as never as Record<string, unknown>
      check(JSON.stringify(tc.options) === JSON.stringify(['off', 'local', 'ai']) && tc.default === 'off', 'title_card 选项 [off,local,ai]、默认 off')
      const cap = t.steps.find((s) => s.key === 'captions')!
      const capIn = cap.inputs as Record<string, string>
      check(['style_mode', 'title_card', 'resolution'].every((k) => capIn[k] === `input.${k}`), 'captions 步三桥输入映射（select 直通串）')
      const comp = t.steps.find((s) => s.key === 'compose')!
      const compIn = comp.inputs as Record<string, string>
      check(['style_mode', 'title_card', 'title_card_bg'].every((k) => compIn[k] === `input.${k}`), 'compose 步三桥输入映射')
      // T6 card_bg 子链静态面：两步 when=ai 门控 + after 反级联 + 消费接线
      const cb = t.steps.find((s) => s.key === 'card_bg')!
      const cbImg = t.steps.find((s) => s.key === 'card_bg_img')!
      check(!!cb && !!cbImg && cb.action === 'ai_text' && cbImg.action === 'ai_image', 'card_bg(ai_text) + card_bg_img(ai_image) 两步在位（零新 action）')
      check(cb.when === 'input.title_card == ai' && cbImg.when === 'input.title_card == ai', '两步 when=ai 门控（缺省 off 零执行零付费）')
      check(JSON.stringify(cb.after) === JSON.stringify(['captions']) && JSON.stringify(cbImg.after) === JSON.stringify(['card_bg']), `card_bg after=[captions] 反级联跳步（默认挂 analyze 会因 when 跳过传播永不可达；实际 ${JSON.stringify(cb.after)}/${JSON.stringify(cbImg.after)}）`)
      const cbParams = cb.params as Record<string, unknown>
      check(cbParams.prompt_tpl === 'title-card-bg.md' && cbParams.output_format === 'storyboard-json', 'card_bg 提示词契约 title-card-bg.md → 单镜 shots JSON')
      check((cbImg.inputs as Record<string, string>).shots === 'steps.card_bg.asset' && (cbImg.params as Record<string, unknown>).output_purpose === 'title_card_bg', 'card_bg_img 消费分镜 + 产物 purpose=title_card_bg')
      check((comp.after ?? []).includes('card_bg_img') && compIn.card_bg_image === 'steps.card_bg_img.assets' && comp.after_skipped === 'continue', 'compose 接 card_bg_image：after 同步声明 + 跳步放行')
      check(BUILTIN_PROMPT_NAMES.size === 50 && isBuiltinPrompt('title-style.md') && isBuiltinPrompt('title-card-bg.md'), 'title-style.md/title-card-bg.md 已登记出厂清单（现共 50 份）')
      const tpl = loadPromptTemplate('title-style.md')
      check(tpl.includes('"styles"') && tpl.includes('"assign"') && tpl.includes('0.008'), 'title-style.md 契约键与取值范围在文')
      const bgTpl = loadPromptTemplate('title-card-bg.md')
      check(bgTpl.includes('"shots"') && bgTpl.includes('card_bg') && bgTpl.includes('绝不能出现任何文字'), 'title-card-bg.md 单镜契约 + 禁文字铁律在文')
    },

    // ================= llm：style_mode=llm mock 离线（成功采用+计费 / 降级 rule 不断链） =================
    llm: async () => {
      const { db } = await import('../src/db')
      const { projects, pipelineRuns, assets, usageRecords, apiConfigs } = await import('../src/db/schema')
      const { eq, and } = await import('drizzle-orm')
      const { loadTemplate } = await import('../src/pipeline/loader')
      const { engine } = await import('../src/pipeline/engine')
      const { ensureProjectDirs, relPathOf, absPathOf, registerAsset } = await import('../src/services/storage')
      const { resolveFfmpeg } = await import('../src/services/ffmpeg')
      const ffmpeg = resolveFfmpeg()!
      const [proj] = await db.insert(projects).values({ name: 'm61-llm', genre: 'other', templateKey: 'photo-montage', status: 'active', settings: '{}', tags: '[]', createdAt: Date.now(), updatedAt: Date.now() }).returning()
      const pid = proj!.id
      ensureProjectDirs(pid)
      const rel = relPathOf(pid, 'source', `p-${Date.now()}.png`)
      spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x240', '-frames:v', '1', '-update', '1', absPathOf(rel)], { timeout: 120_000, windowsHide: true })
      const img = (await registerAsset(pid, { name: 'p.png', kind: 'image', purpose: 'source', relPath: rel, ext: 'png', mime: 'image/png' })).id

      const seedLlm = async (): Promise<void> => {
        process.env['PROBE_M61_KEY'] = 'probe-offline-key' // 假密钥仅过 apiKey 闸；请求真实落在 fetch 桩（localhost:0 无网络）
        await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, 'llm'))
        const t = Date.now()
        await db.insert(apiConfigs).values({ name: 'llm', providerKey: 'deepseek_llm', serviceType: 'llm', apiKeyRef: 'env:PROBE_M61_KEY', baseUrl: 'http://localhost:0/offline', model: 'probe-llm', extra: '{}', pricing: '{"tokens_in":2,"tokens_out":8}', isActive: 1, isDefault: 1, priority: 0, createdAt: t, updatedAt: t } as never)
      }
      let llmCalls = 0
      let llmReply = ''
      const fetchBak = globalThis.fetch
      globalThis.fetch = (async (input: unknown, init?: unknown) => {
        const url = String(input)
        if (!url.startsWith('http://localhost:0/offline')) throw new Error('M61 llm 节禁止外部网络')
        llmCalls += 1
        void init
        return Response.json({ choices: [{ message: { content: llmReply }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })
      }) as typeof fetch

      const settle = async (id: number) => {
        for (let i = 0; i < 2400; i++) {
          if (!engine.isRunning(id)) break
          await new Promise((r) => setTimeout(r, 25))
        }
        return (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)))[0]!
      }
      const startRun = async (over: Record<string, unknown>): Promise<number> => {
        const now = Date.now()
        const [run] = await db.insert(pipelineRuns).values({
          projectId: pid, templateKey: 'photo-montage', templateSnapshot: JSON.stringify(loadTemplate('photo-montage')),
          status: 'queued', input: JSON.stringify({ photos: [img], title: '喜结连理', duration_per_shot: 2, fps: 12, resolution: '320x240', confirm: false, ...over }), createdAt: now, updatedAt: now,
        } as never).returning()
        engine.startRun(run!.id)
        return run!.id
      }
      const srtParams = async (runId: number): Promise<Record<string, any>> => JSON.parse(((await db.select().from(assets).where(and(eq(assets.runId, runId), eq(assets.purpose, 'subtitle'))))[0] ?? { params: '{}' }).params ?? '{}')
      const usageRows = async (runId: number) => await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))
      try {
        // —— 成功路：LLM 产物采用 + 真实计费 ——
        await seedLlm()
        llmCalls = 0
        llmReply = JSON.stringify({ styles: [{ size_pct: 0.045, color: '#FFAA00', alignment: 8, bold: true }], assign: [0] })
        const runA = await startRun({ style_mode: 'llm' })
        check((await settle(runA)).status === 'completed', 'llm run A 全链 completed')
        check(llmCalls === 1, `LLM 恰好单次调用（实际 ${llmCalls} 次）`)
        const pa = await srtParams(runA)
        check(pa.style_source === 'llm' && pa.style_plan?.styles?.[0]?.color === '#FFAA00' && pa.style_plan.styles[0]?.alignment === 8, `LLM 产物落 style_plan（实际 ${JSON.stringify(pa.style_plan)}）`)
        const ua = await usageRows(runA)
        check(ua.length === 2 && ua.every((u) => u.kind === 'llm'), `计费计量 tokens_in/out 两行 kind=llm（实际 ${ua.length} 行）`)
        // —— 畸形产物 → 降级 rule（仍计费：tokens 真实消耗）——
        llmReply = '这次我无法产出 JSON'
        const runB = await startRun({ style_mode: 'llm' })
        check((await settle(runB)).status === 'completed', '畸形产物 run B 仍 completed（降级不断链）')
        const pb = await srtParams(runB)
        check(pb.style_source === 'rule' && pb.style_plan?.styles?.[0]?.color === undefined, `畸形产物降级规则层（实际 source=${pb.style_source}）`)
        check((await usageRows(runB)).length === 2, '解析失败也计费（tokens 已实际消耗，in/out 两行）')
        // —— 无 LLM 实例 → 降级 rule 零计费不断链 ——
        await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, 'llm'))
        llmCalls = 0
        const runC = await startRun({ style_mode: 'llm' })
        check((await settle(runC)).status === 'completed', '无 LLM 实例 run C 仍 completed（绝不阻断字幕产出）')
        check(llmCalls === 0 && (await usageRows(runC)).length === 0, '无实例零调用零计费')
        check((await srtParams(runC)).style_source === 'rule', 'run C style_source=rule（降级语义统一）')
      } finally {
        globalThis.fetch = fetchBak
      }
    },

    // ================= ai：T6 AI 背景字卡全 mock 离线实弹（底图分支真烧 ffmpeg + 降级边界） =================
    ai: async () => {
      const { db } = await import('../src/db')
      const { projects, pipelineRuns, pipelineSteps, assets, usageRecords, apiConfigs } = await import('../src/db/schema')
      const { eq, and } = await import('drizzle-orm')
      const { loadTemplate } = await import('../src/pipeline/loader')
      const { engine } = await import('../src/pipeline/engine')
      const { ensureProjectDirs, relPathOf, absPathOf, registerAsset } = await import('../src/services/storage')
      const { resolveFfmpeg, probeMediaDuration } = await import('../src/services/ffmpeg')
      const { resolveCjkFont } = await import('../src/pipeline/actions/ffmpeg-merge/title-card')
      const ffmpeg = resolveFfmpeg()!
      const font = resolveCjkFont()
      if (!font) {
        check(true, 'CJK 字体缺失环境：ai 节实弹软跳过（底图分支形状由 pure 节覆盖）')
        return
      }
      const [proj] = await db.insert(projects).values({ name: 'm61-ai', genre: 'other', templateKey: 'photo-montage', status: 'active', settings: '{}', tags: '[]', createdAt: Date.now(), updatedAt: Date.now() }).returning()
      const pid = proj!.id
      ensureProjectDirs(pid)
      // 确定性红色 320×240 底图（ffmpeg 实渲非 1x1 魔数 PNG：叠字白像素断言不受底色漂移影响）
      const bgTmp = absPathOf(relPathOf(pid, 'source', `.mock-bg-${Date.now()}.png`))
      const g = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x240', '-frames:v', '1', '-update', '1', bgTmp], { timeout: 120_000, windowsHide: true })
      if (g.status !== 0) throw new Error(`探针预制底图失败：${(g.stderr ?? '').slice(-200)}`)
      const BG_PNG_B64 = readFileSync(bgTmp).toString('base64')
      const mkImg = async (color: string, id: string): Promise<number> => {
        const rel = relPathOf(pid, 'source', `${id}-${Date.now()}.png`)
        spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240`, '-frames:v', '1', '-update', '1', absPathOf(rel)], { timeout: 120_000, windowsHide: true })
        return (await registerAsset(pid, { name: `${id}.png`, kind: 'image', purpose: 'source', relPath: rel, ext: 'png', mime: 'image/png' })).id
      }
      const img1 = await mkImg('blue', 'b')
      const img2 = await mkImg('yellow', 'y')

      const seedAi = async (withImage: boolean): Promise<void> => {
        process.env['PROBE_M61_KEY'] = 'probe-offline-key'
        for (const kind of ['llm', 'image'] as const) await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, kind))
        const t = Date.now()
        const ins = (v: Record<string, unknown>) => db.insert(apiConfigs).values({ name: v['name'], providerKey: v['providerKey'], serviceType: v['serviceType'], apiKeyRef: 'env:PROBE_M61_KEY', baseUrl: 'http://localhost:0/offline', model: v['model'], extra: '{}', pricing: JSON.stringify(v['pricing'] ?? {}), isActive: 1, isDefault: 1, priority: 0, createdAt: t, updatedAt: t } as never)
        await ins({ name: 'llm', providerKey: 'deepseek_llm', serviceType: 'llm', model: 'probe-llm', pricing: { tokens_in: 2, tokens_out: 8 } })
        if (withImage) await ins({ name: 'image', providerKey: 'openai_image', serviceType: 'image', model: 'probe-img', pricing: { image: 0.1 } })
      }
      let chatCalls = 0
      let imgCalls = 0
      let chatReply = ''
      const fetchBak = globalThis.fetch
      globalThis.fetch = (async (input: unknown) => {
        const url = String(input)
        if (!url.startsWith('http://localhost:0/offline')) throw new Error('M61 ai 节禁止外部网络')
        if (url.includes('/chat/completions')) {
          chatCalls += 1
          return Response.json({ choices: [{ message: { content: chatReply }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })
        }
        if (url.includes('/images/generations')) {
          imgCalls += 1
          return Response.json({ data: [{ b64_json: BG_PNG_B64 }] })
        }
        throw new Error(`ai 节桩未预期端点：${url}`)
      }) as typeof fetch
      const settle = async (id: number) => {
        for (let i = 0; i < 3600; i++) {
          if (!engine.isRunning(id)) return (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)))[0]!
          await new Promise((r) => setTimeout(r, 25))
        }
        throw new Error(`ai run ${id} 未收敛`)
      }
      const startRun = async (over: Record<string, unknown>): Promise<number> => {
        const now = Date.now()
        const [run] = await db.insert(pipelineRuns).values({
          projectId: pid, templateKey: 'photo-montage', templateSnapshot: JSON.stringify(loadTemplate('photo-montage')),
          status: 'queued', input: JSON.stringify({ photos: [img1, img2], title: '囍事当前\n百年好合', duration_per_shot: 2, fps: 12, resolution: '320x240', ken_burns: 'in', confirm: false, ...over }), createdAt: now, updatedAt: now,
        } as never).returning()
        engine.startRun(run!.id)
        return run!.id
      }
      const whitePixelsIn = async (abs: string, atSec: number): Promise<number> => {
        const r = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(atSec), '-i', abs, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true })
        const buf = r.stdout
        if (!buf || buf.length < 3 * 320 * 240) return -1
        let n = 0
        for (let i = 0; i + 2 < buf.length; i += 3) {
          if (buf[i]! > 200 && buf[i + 1]! > 200 && buf[i + 2]! > 200) n++
        }
        return n
      }
      try {
        // —— run A：title_card=ai 全链（提示词→出图→底图分支叠字卡）——
        await seedAi(true)
        chatCalls = 0; imgCalls = 0
        chatReply = JSON.stringify({ shots: [{ id: 'card_bg', image_prompt: 'romantic soft bokeh flowers, dark ambience, no text, no letters', duration_sec: 4 }] })
        const runA = await startRun({ style_mode: 'rule', title_card: 'ai' })
        const rA = await settle(runA)
        check(rA.status === 'completed', `ai run A 全链 completed（实际 ${rA.status}${rA.error ? ` / ${String(rA.error).slice(0, 160)}` : ''}）`)
        const stepsA = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runA))
        check(['card_bg', 'card_bg_img', 'compose'].every((k) => stepsA.find((s) => s.stepKey === k)?.status === 'succeeded'), 'card_bg + card_bg_img + compose 三步成功（after=[captions] 反级联生效）')
        check(chatCalls === 1 && imgCalls === 1, `子链零多余调用：LLM 1 次 + 出图 1 次（实际 ${chatCalls}/${imgCalls}）`)
        const bgAssets = await db.select().from(assets).where(and(eq(assets.runId, runA), eq(assets.purpose, 'title_card_bg')))
        check(bgAssets.length === 1 && bgAssets[0]!.kind === 'image', `底图产物注册 purpose=title_card_bg（实际 ${bgAssets.length} 张）`)
        const fv = (await db.select().from(assets).where(and(eq(assets.runId, runA), eq(assets.purpose, 'final_video'))))[0]!
        const pf = JSON.parse(fv.params ?? '{}') as Record<string, any>
        check(pf.title_card?.mode === 'ai' && pf.title_card?.title_lines === 2 && pf.title_card?.dur_sec === 8.5, `溯源增键 mode=ai（实际 ${JSON.stringify(pf.title_card)}）`)
        const dur = probeMediaDuration(absPathOf(fv.relPath!))
        check(dur !== null && Math.abs(dur - 12.5) <= 0.7, `成片 ≈12.5s（底图卡 8.5 + 2×2；实际 ${dur?.toFixed(2)}s）`)
        const w = await whitePixelsIn(absPathOf(fv.relPath!), 1)
        check(w > 30, `底图叠字：红底压暗后白字像素在场（1s 处 ${w} 个）`)
        const uA = await db.select().from(usageRecords).where(eq(usageRecords.runId, runA))
        check(uA.filter((u) => u.kind === 'llm').length === 2 && uA.filter((u) => u.kind === 'image').length === 1, `付费计量：llm in/out 两行 + image 一行（实际 ${uA.map((u) => u.kind).join('/')}）`)
        // —— run B：未配图像实例 → 生图步失败 run 收敛 failed（引擎全局失败语义，非静默断链）——
        await seedAi(false)
        chatCalls = 0
        const runB = await startRun({ style_mode: 'rule', title_card: 'ai' })
        const rB = await settle(runB)
        check(rB.status === 'failed', `未配图像实例 run B 收敛 failed（实际 ${rB.status}）`)
        check((await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runB))).find((s) => s.stepKey === 'card_bg_img')?.status === 'failed', '失败面落在 card_bg_img 步（提示清晰可改 local 重跑）')
      } finally {
        globalThis.fetch = fetchBak
      }
    },

    // ================= live：rule+local 全链实弹（零计费） =================
    live: async () => {
      const { db } = await import('../src/db')
      const { projects, pipelineRuns, pipelineSteps, assets, usageRecords } = await import('../src/db/schema')
      const { eq, and } = await import('drizzle-orm')
      const { loadTemplate } = await import('../src/pipeline/loader')
      const { engine } = await import('../src/pipeline/engine')
      const { ensureProjectDirs, relPathOf, absPathOf, registerAsset, readTextAsset } = await import('../src/services/storage')
      const { resolveFfmpeg, probeMediaDuration } = await import('../src/services/ffmpeg')
      const { resolveCjkFont } = await import('../src/pipeline/actions/ffmpeg-merge/title-card')
      const ffmpeg = resolveFfmpeg()!
      const gen = (abs: string, args: string[]): void => {
        const r = spawnSync(ffmpeg, ['-y', '-v', 'error', ...args, abs], { encoding: 'utf8', timeout: 120_000, windowsHide: true })
        if (r.status !== 0) throw new Error(`探针生成素材失败 ${abs}: ${(r.stderr ?? '').slice(-200)}`)
      }
      const [proj] = await db.insert(projects).values({ name: 'm61-live', genre: 'other', templateKey: 'photo-montage', status: 'active', settings: '{}', tags: '[]', createdAt: Date.now(), updatedAt: Date.now() }).returning()
      const pid = proj!.id
      ensureProjectDirs(pid)
      const mkImg = async (color: string, id: string): Promise<number> => {
        const rel = relPathOf(pid, 'source', `${id}-${Date.now()}.png`)
        gen(absPathOf(rel), ['-f', 'lavfi', '-i', `color=c=${color}:s=320x240`, '-frames:v', '1', '-update', '1'])
        return (await registerAsset(pid, { name: `${id}.png`, kind: 'image', purpose: 'source', relPath: rel, ext: 'png', mime: 'image/png' })).id
      }
      const img1 = await mkImg('red', 'red')
      const img2 = await mkImg('green', 'green')

      const runOf = async (id: number) => (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)))[0]!
      const settle = async (id: number) => {
        for (let i = 0; i < 2400; i++) {
          if (!engine.isRunning(id)) return runOf(id)
          await new Promise((r) => setTimeout(r, 25))
        }
        throw new Error(`live run ${id} 未收敛`)
      }
      const startRun = async (input: Record<string, unknown>): Promise<number> => {
        const now = Date.now()
        const [run] = await db.insert(pipelineRuns).values({
          projectId: pid, templateKey: 'photo-montage', templateSnapshot: JSON.stringify(loadTemplate('photo-montage')),
          status: 'queued', input: JSON.stringify(input), createdAt: now, updatedAt: now,
        } as never).returning()
        engine.startRun(run!.id)
        return run!.id
      }
      const finalOf = async (runId: number) => (await db.select().from(assets).where(and(eq(assets.runId, runId), eq(assets.purpose, 'final_video'))))[0]!
      const whitePixelsIn = async (abs: string, atSec: number): Promise<number> => {
        const r = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(atSec), '-i', abs, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true })
        const buf = r.stdout
        if (!buf || buf.length < 3 * 320 * 240) return -1
        let n = 0
        for (let i = 0; i + 2 < buf.length; i += 3) {
          if (buf[i]! > 200 && buf[i + 1]! > 200 && buf[i + 2]! > 200) n++
        }
        return n
      }
      // 白字墨迹行中心（分层观感断言：C 居中 vs B 底部）；无墨 → -1
      const inkCenterY = async (abs: string, atSec: number): Promise<number> => {
        const r = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(atSec), '-i', abs, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true })
        const buf = r.stdout
        if (!buf || buf.length < 3 * 320 * 240) return -1
        let minRow = -1
        let maxRow = -1
        for (let y = 0; y < 240; y++) {
          for (let x = 0; x < 320; x++) {
            const i = (y * 320 + x) * 3
            if (buf[i]! > 200 && buf[i + 1]! > 200 && buf[i + 2]! > 200) {
              if (minRow < 0) minRow = y
              maxRow = y
              break
            }
          }
        }
        return minRow < 0 ? -1 : Math.round((minRow + maxRow) / 2)
      }
      const font = resolveCjkFont()
      if (!font) {
        check(true, 'CJK 字体缺失环境：live 字卡断言软跳过（降级路径由 pure 节覆盖）')
        return
      }

      // —— run A：style_mode=rule + title_card=local（2 行标题 + 2 张照片）——
      const fetchBak = globalThis.fetch
      globalThis.fetch = (async () => { throw new Error('M61 live 探针禁止网络（期1 零付费红线）') }) as typeof fetch
      try {
        const runA = await startRun({
          photos: [img1, img2], title: '囍事当前\n百年好合',
          style_mode: 'rule', title_card: 'local',
          duration_per_shot: 2, fps: 12, resolution: '320x240', ken_burns: 'in', confirm: false,
        })
        const rA = await settle(runA)
        check(rA.status === 'completed', `run A 全链 completed（实际 ${rA.status}${rA.error ? ` / ${String(rA.error).slice(0, 160)}` : ''}）`)
        check((await db.select().from(usageRecords).where(eq(usageRecords.runId, runA))).length === 0, 'rule+local 零 LLM 零计费（usage_records 0 行）')
        // 字幕资产：title_lines=2 + style_plan（纯标题 → 单组，主样式=标题组）
        const srtRow = (await db.select().from(assets).where(and(eq(assets.runId, runA), eq(assets.purpose, 'subtitle'))))[0]!
        const sparams = JSON.parse(srtRow.params ?? '{}') as Record<string, any>
        check(sparams.title_lines === 2 && sparams.style_plan?.styles?.length === 1 && sparams.style_plan.styles[0]?.alignment === 5 && sparams.style_plan.styles[0]?.bold === true && sparams.style_source === 'rule', `字幕资产增键 title_lines/style_plan/style_source（实际 ${JSON.stringify(sparams.style_plan)}）`)
        const runASteps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runA))
        check(runASteps.find((s) => s.stepKey === 'captions')?.status === 'succeeded' && runASteps.find((s) => s.stepKey === 'compose')?.status === 'succeeded', 'captions + compose 两步成功')
        // 成片：总长 = 卡 8.5s + 2×2s = 12.5s；卡段 timeline 首段 assetId=-1
        const fvA = await finalOf(runA)
        const absA = absPathOf(fvA.relPath!)
        const durA = probeMediaDuration(absA)
        check(durA !== null && Math.abs(durA - 12.5) <= 0.7, `成片 ≈12.5s（卡 8.5 + 照片 2×2；实际 ${durA?.toFixed(2)}s）`)
        const pa = JSON.parse(fvA.params ?? '{}') as Record<string, any>
        check(pa.title_card?.title_lines === 2 && pa.title_card?.dur_sec === 8.5 && pa.title_style?.groups === 1, `溯源增键 title_card/title_style（实际 ${JSON.stringify(pa.title_card)}/${JSON.stringify(pa.title_style)}）`)
        check(pa.images === 2 && pa.motion_clips === 0, 'images 计数=2 排除卡段（卡不冒充照片）')
        check(pa.subtitle === 1 && String(pa.subtitle_style ?? '').includes('FontSize=16') && String(pa.subtitle_style ?? '').includes('Alignment=5') && String(pa.subtitle_style ?? '').includes('Bold=1'), `主样式接管烧录（240×0.06=14→下限 16；实际串 ${pa.subtitle_style}）`)
        check(pa.timeline?.segments?.[0]?.assetId === -1 && pa.timeline.segments[0].startSec === 0 && Math.abs(pa.timeline.segments[0].durSec - 8.5) < 0.01, 'timeline 快照容错：卡段首段 assetId=-1 dur=8.5')
        // 卡呈现：成片 1s 处（卡在 [0,8.5)）含白色文字像素；底色 #101826 非纯色（文字存在证明）
        const w1 = await whitePixelsIn(absA, 1)
        check(w1 > 30, `字卡帧含白字（1s 处白像素 ${w1} 个）`)
        const w2 = await whitePixelsIn(absA, 9.5)
        check(w2 >= 0 && w2 < 20, `正片照片帧无残留标题（9.5s 处白像素 ${w2} 个：全部标题 cue 已裁，双呈现防线）`)
        // 双呈现防线：成片内嵌 ASS 由 index 生成——断言字幕资产 SRT 本身不变（M29 只读），裁切仅在烧录 ASS
        const srtText = await readTextAsset(srtRow.id)
        check(srtText.includes('囍事当前') && srtText.includes('00:00:00,500 --> 00:00:04,500'), 'SRT 资产只读不动（标题 cue 仍在源文件，裁切仅烧录 ASS 侧）')
        // 临时卡 PNG 已清理
        const dir = dirname(absPathOf(relPathOf(pid, 'final_video', 'x.mp4')))
        check(readdirSync(dir).every((f) => !f.startsWith('.tcard-')), '片首卡临时 png 合成后清理')
      } finally {
        globalThis.fetch = fetchBak
      }

      // —— run B：对照组（新参全缺省 + kb=in 同走混剪态）→ 零增键 + 总长 = 现状语义 ——
      const runB = await startRun({
        photos: [img1, img2], title: '囍事当前\n百年好合',
        duration_per_shot: 2, fps: 12, resolution: '320x240', ken_burns: 'in', confirm: false,
      })
      const rB = await settle(runB)
      check(rB.status === 'completed', `run B 对照 completed（实际 ${rB.status}${rB.error ? ` / ${String(rB.error).slice(0, 160)}` : ''}）`)
      const srtB = (await db.select().from(assets).where(and(eq(assets.runId, runB), eq(assets.purpose, 'subtitle'))))[0]!
      const pbParams = JSON.parse(srtB.params ?? '{}') as Record<string, unknown>
      check(pbParams.title_lines === undefined && pbParams.style_plan === undefined && pbParams.style_source === undefined, '对照字幕资产 params 零增键（off 逐字节现状）')
      const fvB = await finalOf(runB)
      const pb = JSON.parse(fvB.params ?? '{}') as Record<string, any>
      check(pb.title_card === undefined && pb.title_style === undefined && pb.images === 2, '对照成片 params 零增键、images=2')
      const durB = probeMediaDuration(absPathOf(fvB.relPath!))
      check(durB !== null && Math.abs(durB - 4) <= 0.5, `对照成片 ≈4s（无卡，现状 Σd；实际 ${durB?.toFixed(2)}s）`)
      const wb = await whitePixelsIn(absPathOf(fvB.relPath!), 1)
      check(wb >= 0, `对照 1s 帧可读（白像素 ${wb} 个，标题走字幕烧录）`)

      // —— run C：T7 分层烧录实弹（rule 启用但不插卡 → 标题 cue 保留且走 Title1 样式居中）——
      const runC = await startRun({
        photos: [img1, img2], title: '囍事当前\n百年好合',
        style_mode: 'rule', duration_per_shot: 2, fps: 12, resolution: '320x240', ken_burns: 'in', confirm: false,
      })
      const rC = await settle(runC)
      check(rC.status === 'completed', `run C 分层烧录全链 completed（多 Style ASS 被 libass 实接受；实际 ${rC.status}${rC.error ? ` / ${String(rC.error).slice(0, 160)}` : ''}）`)
      const fvC = await finalOf(runC)
      const pC = JSON.parse(fvC.params ?? '{}') as Record<string, any>
      check(pC.title_style?.groups === 1 && pC.title_card === undefined, `C 仅分层无卡：title_style 增键且无 title_card（实际 ${JSON.stringify(pC.title_style)}）`)
      check((await db.select().from(usageRecords).where(eq(usageRecords.runId, runC))).length === 0, 'run C 零付费（rule 链无 LLM）')
      const inkC = await inkCenterY(absPathOf(fvC.relPath!), 1)
      check(inkC >= 60 && inkC <= 180, `C 标题 cue 走 Title1 居中：1s 处墨迹行中心 ${inkC}（H/2=120 分层带内）`)
      const inkB = await inkCenterY(absPathOf(fvB.relPath!), 1)
      check(inkB > 180, `对照 B 标题 Default 底部：墨迹行中心 ${inkB}（与 C 分层位置可辨：B 底 C 中）`)
    },
  },
})
