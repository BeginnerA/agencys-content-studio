/**
 * M19 探针（成片品质与品牌化）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m19.ts [--section=subtitle-style|brand-watermark|intro-outro|sfx|aspect|ref-gen|states|voice-clone]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录
 * （独立 studio.db + workspace），不触碰开发库（同 probe-m3~m18）。零网络、零计费：
 * 直测服务层函数与纯函数，不触发引擎执行与真实生成。
 *
 * section（默认 all；P1 骨架，各节随 P2~P8 增补）：
 *   subtitle-style  [P2] buildSubtitleStyle 零漂移/字段覆盖/颜色转换 + [P1] 合并/清洗前置断言
 *   brand-watermark [P3] 水印滤镜链 + [P1] 三层合并/来源解析/清洗 clamp
 *   intro-outro     [P3] 片头尾拼接/SRT 平移 + [P1] 槽禁用/缺失宽容
 *   sfx             [P4] SFX 绑定/混音链 + [P1] purpose 登记
 *   aspect          [P5] resolveAspectSize/派生/多路 + [P1] purpose 登记
 *   ref-gen         [P6] 提示词组装/执行器 + [P1] gen_tasks 无 run 任务模型
 *   states          [P7] 三级匹配/注入格式/ai-image 集成 + [P1] states 列 JSON 往返
 *   voice-clone     [P8] 音色库服务/派发 + [P1] voice_clones 表模型
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { VoiceClone } from '../src/db/schema' // 仅类型（编译期擦除，不影响探针环境隔离）

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
// 清理历史残留：libsql 在 Windows 下不释放文件句柄（close 后仍 EBUSY）——本进程退出时 db 文件必留；
// 本次运行在创建自己的目录前清掉旧的（占用中则跳过，自动收敛为最多一份）。
const TMP_PREFIX = 'acs-probe-m19-'
for (const name of readdirSync(tmpdir())) {
  if (name.startsWith(TMP_PREFIX)) {
    try {
      rmSync(join(tmpdir(), name), { recursive: true, force: true })
    } catch {
      /* 占用中（并行探针）→ 跳过 */
    }
  }
}
const TMP = mkdtempSync(join(tmpdir(), TMP_PREFIX))
process.env.CSTUDIO_ROOT = REPO_ROOT
process.env.CSTUDIO_DATA = join(TMP, 'data')
process.env.CSTUDIO_WORKSPACE = join(TMP, 'workspace')
mkdirSync(process.env.CSTUDIO_DATA, { recursive: true })
mkdirSync(process.env.CSTUDIO_WORKSPACE, { recursive: true })

const SECTIONS = ['subtitle-style', 'brand-watermark', 'intro-outro', 'sfx', 'aspect', 'ref-gen', 'states', 'voice-clone'] as const

async function main(): Promise<void> {
  // src 模块全部动态加载（环境变量已隔离）
  const { db, initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')
  const { characters, genTasks, pipelineRuns, projects, settings, voiceClones } = await import('../src/db/schema')
  const { eq } = await import('drizzle-orm')
  const { BRAND_DIR } = await import('../src/env')
  const { purposeSubDir } = await import('../src/services/storage')
  const {
    mergeBrand,
    readComposeBrand,
    readPlatformBrand,
    readProjectBrand,
    resolveBrandConfig,
    sanitizeSubtitleStyle,
    sanitizeWatermark,
  } = await import('../src/services/brand-config')

  const log = createLogger('probe-m19')
  let failed = 0
  const check = (cond: boolean, msg: string): void => {
    if (cond) log.info(`  PASS  ${msg}`)
    else {
      failed += 1
      log.error(`  FAIL  ${msg}`)
    }
  }
  const errOf = async (fn: () => Promise<unknown>): Promise<unknown> => {
    try {
      await fn()
      return null
    } catch (err) {
      return err
    }
  }

  // ---- setup：隔离库 + 种子项目 ----
  await initDb()
  const T0 = 1_700_000_000_000
  const mkProject = async (name: string, settingsJson = '{}'): Promise<number> =>
    (
      await db
        .insert(projects)
        .values({ name, genre: 'other', templateKey: 'mengbao-episode', settings: settingsJson, tags: '[]', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!.id
  const pid = await mkProject('M19 探针项目')

  // ---- 共享：buildComposeArgs 输入样板（零配置基线；各节按需覆盖） ----
  const { buildComposeArgs, watermarkOverlayXY, countSrtCues, shiftSrtText } = await import('../src/pipeline/actions/ffmpeg-merge')
  type ComposeArgsInput = Parameters<typeof buildComposeArgs>[0]
  const mkArgsInput = (over: Partial<ComposeArgsInput>): ComposeArgsInput => ({
    segments: [
      { id: 1, path: 'a.png', kind: 'image', durSec: 3 },
      { id: 2, path: 'b.png', kind: 'image', durSec: 3 },
    ],
    width: 1080,
    height: 1920,
    fps: 25,
    xfadePlan: { enabled: false, type: 'none', durSec: 0, videoLens: [3, 3], offsets: [], totalDur: 6 },
    voicePaths: [],
    lineIds: [],
    alignPlan: null,
    total: 6,
    srtAbs: null,
    style: 'FontName=X,FontSize=18',
    bgmPath: null,
    bgmVolume: 0.25,
    bgmFade: 2,
    watermark: null,
    intro: null,
    outro: null,
    outAbs: 'C:/out/ep-final.mp4',
    ...over,
  })

  // ================= 1. subtitle-style =================

  async function sectionSubtitleStyle(): Promise<void> {
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
    const { buildSubtitleStyle, defaultSubtitleStyle, toAssColor } = await import('../src/pipeline/actions/ffmpeg-merge')
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
    const { updateComposeConfig } = await import('../src/services/compose-config')
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

  // ================= 2. brand-watermark =================

  async function sectionBrandWatermark(): Promise<void> {
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
    const { registerAsset, ensureProjectDirs, relPathOf, absPathOf } = await import('../src/services/storage')
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
    const { uploadBrandAsset, getBrandAssetInfo, clearBrandAsset, isBrandSlot } = await import('../src/services/brand-assets')
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

  // ================= 3. intro-outro =================

  async function sectionIntroOutro(): Promise<void> {
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

  // ================= 4. sfx =================

  async function sectionSfx(): Promise<void> {
    check(purposeSubDir('sfx') === 'audio', "purposeSubDir('sfx') → audio 子目录")
    check(purposeSubDir('bgm') === 'source', 'purposeSubDir 未登记 purpose 回退 source（bgm 现状）')

    // ---- [P4] 服务层 CRUD（真实落库/落盘；不触发执行） ----
    const {
      bindSfxFromUpload,
      bindSfxFromAsset,
      loadSfxAssets,
      getSfxList,
      removeSfx,
      updateComposeConfig,
    } = await import('../src/services/compose-config')
    const { registerAsset, relPathOf, absPathOf } = await import('../src/services/storage')
    const { assets } = await import('../src/db/schema')
    const runSfx = (
      await db
        .insert(pipelineRuns)
        .values({ projectId: pid, templateKey: 'mengbao-episode', status: 'completed', input: '{}', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!

    // 上传绑定：行属性 + 落 audio 子目录
    const bytesHit = new Uint8Array([1, 2, 3, 4, 5])
    const a1 = await bindSfxFromUpload(runSfx.id, 'shot-1', { name: 'hit.mp3', data: bytesHit })
    const p1 = JSON.parse(a1.params ?? '{}') as { shotId?: string; source?: string }
    check(
      a1.kind === 'audio' && a1.purpose === 'sfx' && a1.runId === runSfx.id && p1.shotId === 'shot-1' && p1.source === 'upload',
      'bindSfxFromUpload 落行（kind/purpose/runId + params.shotId=shot-1，source=upload）',
    )
    check(!!a1.relPath && a1.relPath.includes('audio') && existsSync(absPathOf(a1.relPath)), 'SFX 文件落 audio 子目录且存在')

    // 每镜 ≤1 条：同镜重绑 → 软删旧行 + Map 命中新行
    const bytesNew = new Uint8Array([9, 9, 9])
    const a1b = await bindSfxFromUpload(runSfx.id, 'shot-1', { name: 'hit2.mp3', data: bytesNew })
    const map1 = await loadSfxAssets(runSfx.id)
    check(map1.size === 1 && map1.get('shot-1')?.id === a1b.id, '同镜重绑 → 每镜 ≤1 条（Map 命中新行）')
    const old1 = (await db.select().from(assets).where(eq(assets.id, a1.id)).limit(1))[0]!
    check(old1.deletedAt !== null, '重绑软删旧行（deletedAt 非空；不物理删除）')

    // sha256 复用：同内容异镜 → 复制行复用 relPath（不重复落盘）
    const a2 = await bindSfxFromUpload(runSfx.id, 'shot-2', { name: 'hit2-copy.mp3', data: bytesNew })
    check(a2.id !== a1b.id && a2.relPath === a1b.relPath, 'sha256 命中 → 复制行复用 relPath（同内容不重复落盘）')

    // 项目音频复制行绑定（relPath 复用；不污染源资产行）
    const srcA = await registerAsset(pid, {
      name: 'library.wav',
      kind: 'audio',
      purpose: 'source',
      relPath: relPathOf(pid, 'source', 'library.wav'),
    })
    const a3 = await bindSfxFromAsset(runSfx.id, 'shot-3', srcA.id)
    const p3 = JSON.parse(a3.params ?? '{}') as { shotId?: string; source?: string; source_asset_id?: number }
    check(
      a3.id !== srcA.id && a3.relPath === srcA.relPath && p3.source === 'asset' && p3.source_asset_id === srcA.id,
      'bindSfxFromAsset 复制行（params.source_asset_id + relPath 复用）',
    )

    // 校验族：shotId/扩展名/跨项目/非 audio/不存在
    const badShot = await errOf(async () => bindSfxFromUpload(runSfx.id, '  ', { name: 'x.mp3', data: bytesHit }))
    check(badShot instanceof Error && /shot_id/.test(String(badShot)), '空 shotId → 拒绝（bad_shot）')
    const badExt = await errOf(async () => bindSfxFromUpload(runSfx.id, 'shot-x', { name: 'x.txt', data: bytesHit }))
    check(badExt instanceof Error && /类型不符/.test(String(badExt)), '非音频扩展名 → 拒绝（bad_kind）')
    const pidOther = await mkProject('M19 探针项目5')
    const foreign = await registerAsset(pidOther, { name: 'f.wav', kind: 'audio', purpose: 'source', relPath: 'other/f.wav' })
    const badForeign = await errOf(async () => bindSfxFromAsset(runSfx.id, 'shot-x', foreign.id))
    check(badForeign instanceof Error && /不属于本项目/.test(String(badForeign)), '跨项目资产 → 拒绝（bad_asset）')
    const imgAsset = await registerAsset(pid, { name: 'i.png', kind: 'image', purpose: 'source', relPath: 'x/i.png' })
    const badKindA = await errOf(async () => bindSfxFromAsset(runSfx.id, 'shot-x', imgAsset.id))
    check(badKindA instanceof Error && /类型不符/.test(String(badKindA)), '非 audio 资产 → 拒绝（bad_asset）')
    const badMiss = await errOf(async () => bindSfxFromAsset(runSfx.id, 'shot-x', 999_999))
    check(badMiss instanceof Error && /不存在/.test(String(badMiss)), '资产不存在 → 拒绝（bad_asset）')

    // run 状态门卫（活跃拒绝——与 BGM 同语义）
    const runActive = (
      await db
        .insert(pipelineRuns)
        .values({ projectId: pid, templateKey: 'mengbao-episode', status: 'running', input: '{}', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!
    const activeBind = await errOf(async () => bindSfxFromUpload(runActive.id, 'shot-1', { name: 'x.mp3', data: bytesHit }))
    check(activeBind instanceof Error && /正在执行/.test(String(activeBind)), 'running run → 绑定拒绝（run_active）')
    const activeList = await errOf(async () => getSfxList(runActive.id))
    check(activeList instanceof Error, 'running run → 列表拒绝（requireEditableRun 同语义）')

    // 列表 + 移除（幂等）
    const list1 = await getSfxList(runSfx.id)
    check(list1.length === 3, 'getSfxList 返回全部有效绑定（shot-1/2/3 共 3 条）')
    await removeSfx(runSfx.id, 'shot-1')
    const mapAfter = await loadSfxAssets(runSfx.id)
    check(mapAfter.size === 2 && !mapAfter.has('shot-1'), 'removeSfx 后该镜消失（其余保留）')
    await removeSfx(runSfx.id, 'shot-none')
    check((await loadSfxAssets(runSfx.id)).size === 2, 'removeSfx 未知镜 → 幂等（无绑定不报错）')

    // ---- [P4] planSfxStarts：起点矩阵（无转场/转场同口径/片头位移/缺失跳过） ----
    const { planSfxStarts, buildTransitionPlan } = await import('../src/pipeline/actions/ffmpeg-merge')
    const okA = (shotId: string, assetId: number): { shotId: string; assetId: number; relPath: string; fileOk: boolean } => ({
      shotId,
      assetId,
      relPath: `p/${shotId}.mp3`,
      fileOk: true,
    })
    const m1 = planSfxStarts([3, 3], ['s1', 's2'], [okA('s1', 11), okA('s2', 12)], 0)
    check(m1.entries.length === 2 && m1.entries[0]!.startSec === 0 && m1.entries[1]!.startSec === 3, '起点矩阵：无转场 [0,3]（Σ_{j<i} d_j）')
    const m2 = planSfxStarts([3, 3], ['s1', 's2'], [okA('s1', 11), okA('s2', 12)], 2.5)
    check(m2.entries[0]!.startSec === 2.5 && m2.entries[1]!.startSec === 5.5, '起点矩阵：片头位移 +2.5 → [2.5,5.5]')
    const tp = buildTransitionPlan([3.5, 2, 4], 'fade', 0.5)
    const m3 = planSfxStarts([3.5, 2, 4], ['s1', 's2', 's3'], [okA('s1', 11), okA('s2', 12), okA('s3', 13)], 0)
    check(
      tp.enabled && JSON.stringify(tp.offsets) === '[3.5,5.5]' && m3.entries[1]!.startSec === tp.offsets[0] && m3.entries[2]!.startSec === tp.offsets[1],
      '转场同口径：镜 i 起点 === xfade offsets[i-1]（转场不改变 Σd 公式）',
    )
    const m4 = planSfxStarts([3, 3], ['s1', 's2'], [okA('s1', 11), { shotId: 's2', assetId: 12, relPath: null, fileOk: true }], 0)
    check(m4.entries.length === 1 && m4.missing.length === 1 && m4.missing[0]!.shotId === 's2', 'relPath 缺失 → missing 跳过（其余照常产出）')
    const m5 = planSfxStarts([3, 3], ['s1', 's2'], [{ shotId: 's1', assetId: 11, relPath: 'p/s1.mp3', fileOk: false }], 0)
    check(m5.entries.length === 0 && m5.missing.length === 1, 'fileOk=false（文件缺失）→ missing（不产条目）')
    const m6 = planSfxStarts([3, 3], [null, 's2'], [okA('s2', 12)], 0)
    check(m6.entries.length === 1 && m6.entries[0]!.startSec === 3, 'segmentShotIds 含 null → 该镜无匹配（起点仍按 Σd 递进）')
    const m7 = planSfxStarts([0.1, 0.2, 0.3], ['s1', 's2', 's3'], [okA('s3', 13)], 0)
    check(m7.entries[0]!.startSec === 0.3, 'round3 防浮点尾数（0.1+0.2 累积 → 0.3；未收敛则为 0.30000000000000004）')

    // ---- [P4] buildComposeArgs：混音链四组合 + 索引递推 + 零 diff ----
    const sfx2 = [{ path: 'C:/s1.mp3', startSec: 0 }, { path: 'C:/s2.mp3', startSec: 3 }]
    const c1 = buildComposeArgs(
      mkArgsInput({ voicePaths: ['C:/v1.m4a'], lineIds: ['l1'], bgmPath: 'C:/bgm.mp3', sfx: sfx2, sfxVolume: 0.8 }),
    )
    const c1Fc = c1.args[c1.args.indexOf('-filter_complex') + 1]!
    check(c1Fc.includes('[outa][bgm]amix=inputs=2:duration=first:normalize=0[amain]'), '组合①：配音+BGM 主混出 [amain]（不再直出 [aout]）')
    check(c1Fc.includes('[amain][sfx0][sfx1]amix=inputs=3:duration=first:normalize=0[aout]'), '组合①：SFX 终混 inputs=3 并入 [aout]')
    check(
      c1Fc.includes('[4:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.8,adelay=0|0[sfx0]'),
      'SFX 逐条链：索引 4（2 段+1 配音+1 BGM）+ volume 0.8 + adelay 0',
    )
    check(c1Fc.includes('[5:a]') && c1Fc.includes('adelay=3000|3000[sfx1]'), 'SFX 第二条：索引 5 + adelay=3000|3000（起点 3s）')
    check(c1.args.includes('-c:a') && c1.args.includes('192k'), 'maps [aout] + aac 192k 启用')
    const c2 = buildComposeArgs(mkArgsInput({ voicePaths: ['C:/v1.m4a'], lineIds: ['l1'], sfx: [sfx2[0]!] }))
    const c2Fc = c2.args[c2.args.indexOf('-filter_complex') + 1]!
    check(
      c2Fc.includes('[outa][sfx0]amix=inputs=2:duration=first:normalize=0[aout]') && !c2Fc.includes('[amain]'),
      '组合②：有配音无 BGM → [outa] 直并 SFX（无 [amain]）',
    )
    const c3 = buildComposeArgs(mkArgsInput({ bgmPath: 'C:/bgm.mp3', sfx: [sfx2[0]!] }))
    const c3Fc = c3.args[c3.args.indexOf('-filter_complex') + 1]!
    check(
      c3Fc.includes('[bgm][sfx0]amix=inputs=2:duration=first:normalize=0[aout]') && !c3Fc.includes('anull[aout]'),
      '组合③：无配音有 BGM → [bgm] 直并 SFX（无 [bgm]anull）',
    )
    const c4 = buildComposeArgs(mkArgsInput({ sfx: sfx2 }))
    const c4Fc = c4.args[c4.args.indexOf('-filter_complex') + 1]!
    check(
      c4Fc.includes('[sfx0][sfx1]amix=inputs=2:duration=longest:normalize=0,apad=whole_dur=6[aout]'),
      '组合④：仅 SFX → longest + apad=whole_dur=6（钉住正片总长）',
    )
    check(c4Fc.includes('[2:a]') && c4Fc.includes('[3:a]'), '组合④：SFX 输入索引自 2 起（无 aux 槽）')
    const c5 = buildComposeArgs(
      mkArgsInput({
        watermark: { path: 'C:/wm.png', position: 'br', opacity: 0.9, width_pct: 0.15, margin_px: 24 },
        intro: { path: 'C:/i.mp4', durSec: 2 },
        outro: { path: 'C:/o.mp4', durSec: 4 },
        sfx: [sfx2[0]!],
      }),
    )
    const c5Fc = c5.args[c5.args.indexOf('-filter_complex') + 1]!
    check(
      c5Fc.includes('[5:a]aresample') && c5Fc.includes('apad=whole_dur=12[aout]'),
      '索引递推：水印+片头尾全开 → SFX 索引 5；仅 SFX 时 apad=totalAll(12)',
    )
    const base0 = JSON.stringify(buildComposeArgs(mkArgsInput({})).args)
    check(JSON.stringify(buildComposeArgs(mkArgsInput({ sfx: [] })).args) === base0, '零 diff：sfx:[] === 无 sfx（args 逐字节一致）')
    check(JSON.stringify(buildComposeArgs(mkArgsInput({ sfxVolume: 0.5 })).args) === base0, '零 diff：仅 sfxVolume（无 SFX）不影响 args')

    // ---- [P4] sfx_volume clamp（0–2；与 bgm_volume 0–1 独立） ----
    const cfgS1 = await updateComposeConfig(runSfx.id, { sfx_volume: 5 })
    check(cfgS1.sfx_volume === 2, 'sfx_volume 上界 clamp（5 → 2）')
    const cfgS2 = await updateComposeConfig(runSfx.id, { sfx_volume: -1 })
    check(cfgS2.sfx_volume === 0, 'sfx_volume 下界 clamp（-1 → 0）')
    const cfgS3 = await updateComposeConfig(runSfx.id, { bgm_volume: 0.5, sfx_volume: 1.5 })
    check(cfgS3.bgm_volume === 0.5 && cfgS3.sfx_volume === 1.5, 'bgm_volume 与 sfx_volume 共存独立（0–1 / 0–2）')
    const badVol = await errOf(async () => updateComposeConfig(runSfx.id, { sfx_volume: 'x' }))
    check(badVol instanceof Error && /数字/.test(String(badVol)), 'sfx_volume 非数字 → 拒绝（bad_field）')
  }

  // ================= 5. aspect =================

  async function sectionAspect(): Promise<void> {
    check(purposeSubDir('final_video_derived') === 'video', "purposeSubDir('final_video_derived') → video 子目录")

    const { resolveAspectSize, aspectGeometryFilter, isSameAspect } = await import('../src/pipeline/actions/ffmpeg-merge')
    const { normalizeMultiAspect, readMultiAspect, updateComposeConfig } = await import('../src/services/compose-config')
    const { deriveAspect } = await import('../src/services/aspect-derive')
    const { registerAsset, relPathOf, absPathOf } = await import('../src/services/storage')
    const { assets } = await import('../src/db/schema')
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

  // ================= 6. ref-gen =================

  async function sectionRefGen(): Promise<void> {
    // gen_tasks 无 run 任务模型（runId/stepId/canvasNodeId 均 null）
    const t = (
      await db
        .insert(genTasks)
        .values({
          projectId: pid,
          runId: null,
          stepId: null,
          canvasNodeId: null,
          kind: 'image',
          params: JSON.stringify({ entity_id: 1, source: 'entity_ref_gen' }),
          status: 'pending',
          createdAt: T0,
          updatedAt: T0,
        })
        .returning()
    )[0]!
    check(t.runId === null && t.stepId === null && t.canvasNodeId === null, 'gen_tasks 无 run 任务模型（三归属列均 null 可插入）')

    // ==================== [P6 增补] 批量生成参考图 ====================
    const refgen = await import('../src/services/entity-refgen')
    const {
      buildRefGenParams,
      cancelEntityRefTask,
      composeEntityRefPrompt,
      listEntityRefTasks,
      parseRefGenParams,
      pickRefAssetIds,
      recoverEntityRefTasks,
      refGenPurpose,
      startEntityRefGen,
    } = refgen
    const { inArray } = await import('drizzle-orm')
    const { onStudioEvent } = await import('../src/services/events')
    const { WorkbenchError } = await import('../src/services/shot-workbench')
    const { combineStyleSnippets, resolveProjectStyleSnippets } = await import('../src/services/style-preset')
    const { stylePresets } = await import('../src/db/schema')

    // ---- 纯函数：purpose / 提示词组装 / params 往返 / 参考图裁剪 ----
    check(
      refgen.MAX_REFGEN_ITEMS === 10 && refgen.MAX_REFGEN_VARIANTS === 4 && refgen.REFGEN_MAX_REFS === 4 && refgen.REFGEN_MAX_CONCURRENCY === 2,
      '上限常量对齐 spec（≤10 实体 × 1-4 变体 / 参考图 ≤4 / 并发 ≤2）',
    )
    check(
      refGenPurpose('character') === 'reference_character' && refGenPurpose('scene') === 'reference_scene' && refGenPurpose('prop') === 'reference_prop',
      'refGenPurpose 三 kind → reference_{kind}（出图归属目的分流）',
    )
    check(refGenPurpose('bogus') === 'reference_character' && refGenPurpose('') === 'reference_character', '未知/空 kind 回退 reference_character（不造孤儿 purpose）')
    check(
      composeEntityRefPrompt({ appearance: '少年，白衣，剑眉', negative: '现代服饰' }, ['水墨国风', '低饱和']) ===
        '少年，白衣，剑眉\n视觉风格：水墨国风；低饱和\n必须剔除：现代服饰',
      'composeEntityRefPrompt 三段拼接（段间 \\n；多风格词「；」叠加；对齐 ai-image 锚定注入格式）',
    )
    check(composeEntityRefPrompt({ appearance: '  ', negative: '红字' }, ['  ', '']) === '必须剔除：红字', '缺段跳过（空白 appearance/风格不进提示词）')
    check(composeEntityRefPrompt({}, []) === '', 'appearance/negative/风格全缺 → 空串（不注占位文本）')
    const prm = buildRefGenParams({ entityId: 7, variantIndex: 2, size: '1024x1024', refsPlanned: 3 })
    const back = parseRefGenParams(JSON.stringify(prm))
    check(back !== null && back.entity_id === 7 && back.variant_index === 2 && back.size === '1024x1024', 'params 构造/解析往返（域内字段可读回）')
    check(prm['source'] === refgen.REFGEN_SOURCE, 'params.source 域标识写入（列表/恢复认领依据）')
    check(parseRefGenParams(JSON.stringify({ entity_id: 1, source: 'canvas' })) === null, '非本域 params → null（不认领画布/run 任务）')
    check(
      parseRefGenParams('{坏 JSON') === null && parseRefGenParams(JSON.stringify({ source: 'entity_ref_gen', entity_id: 0 })) === null,
      '坏 JSON / entity_id 非正整数 → null（恢复遇脏行不炸）',
    )
    check(parseRefGenParams(JSON.stringify({ source: 'entity_ref_gen', entity_id: 3, variant_index: -1 }))?.variant_index === 0, 'variant_index 负值 → 归零（展示宽容）')
    check(parseRefGenParams(JSON.stringify({ source: 'entity_ref_gen', entity_id: 3 }))?.size === null, '缺 size → null（执行期回落项目/默认尺寸）')
    check(JSON.stringify(pickRefAssetIds([5, 5, 3, 9, 2, 8, 0, -1, 1.5])) === '[5,3,9,2]', 'pickRefAssetIds 去重 + 截 4 + 剔非正整数')

    // ---- 实体样本（项目域 / 全局域 / 缺外观 / 多参考图） ----
    const mkChar = async (
      name: string,
      opts: { projectId?: number | null; kind?: string; appearance?: string | null; negative?: string | null; refAssetIds?: number[] } = {},
    ): Promise<number> =>
      (
        await db
          .insert(characters)
          .values({
            projectId: opts.projectId === undefined ? pid : opts.projectId,
            kind: opts.kind ?? 'character',
            name,
            aliases: '[]',
            appearance: opts.appearance ?? '剑眉星目，白衣长剑',
            negative: opts.negative ?? null,
            states: '[]',
            refAssetIds: JSON.stringify(opts.refAssetIds ?? []),
            createdAt: T0,
            updatedAt: T0,
          })
          .returning()
      )[0]!.id
    const cA = await mkChar('批量角色A')
    const cB = await mkChar('批量场景B', { kind: 'scene', appearance: '山门石阶，晨雾', negative: '现代建筑', refAssetIds: [11, 12, 13, 14, 15] })
    const cNoApp = await mkChar('缺外观角色', { appearance: '   ' })
    const cGlobal = await mkChar('全局角色', { projectId: null })

    const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
      const e = await errOf(fn)
      return e instanceof WorkbenchError ? `${e.code}:${e.status}` : e === null ? '__ok__' : `__other__:${String(e)}`
    }
    const taskCountBefore = (await db.select().from(genTasks)).length

    // ---- 发起校验族（整单拒绝，零副作用） ----
    check((await codeOf(() => startEntityRefGen(0, [cA]))) === 'bad_project_id:400', 'project_id 非正整数 → bad_project_id')
    check((await codeOf(() => startEntityRefGen(999999, [cA]))) === 'not_found:404', '项目不存在 → not_found(404)')
    check((await codeOf(() => startEntityRefGen(pid, 'x'))) === 'bad_entity_ids:400', 'entity_ids 非数组 → bad_entity_ids')
    check((await codeOf(() => startEntityRefGen(pid, []))) === 'bad_entity_ids:400', 'entity_ids 空数组 → bad_entity_ids')
    check(
      (await codeOf(() => startEntityRefGen(pid, Array.from({ length: 11 }, (_, i) => i + 1)))) === 'too_many_entities:400',
      '>10 实体 → too_many_entities（对齐 M13 批量润色上限）',
    )
    check((await codeOf(() => startEntityRefGen(pid, [cA], 5))) === 'bad_variants:400', 'variants=5 → bad_variants')
    check((await codeOf(() => startEntityRefGen(pid, [cA], 0))) === 'bad_variants:400', 'variants=0 → bad_variants')
    check((await codeOf(() => startEntityRefGen(pid, [999999]))) === 'bad_entity_ids:400', '素材不存在 → bad_entity_ids')
    const scopeErr = await errOf(() => startEntityRefGen(pid, [cGlobal]))
    check(scopeErr instanceof WorkbenchError && scopeErr.code === 'bad_entity_scope', '全局库素材（跨域）→ bad_entity_scope')
    check(scopeErr instanceof WorkbenchError && scopeErr.message.includes('全局角色'), 'bad_entity_scope 文案点名素材（前端直接展示）')
    const appErr = await errOf(() => startEntityRefGen(pid, [cNoApp]))
    check(appErr instanceof WorkbenchError && appErr.code === 'no_appearance' && appErr.message.includes('缺外观角色'), '缺 appearance → no_appearance（提示先补全/润色）')
    check((await db.select().from(genTasks)).length === taskCountBefore, '校验失败零副作用（未建任何任务行）')

    // ---- 发起成功：去重 × 变体积量 + 任务行形形态 ----
    const evBuf: Array<{ projectId: number; taskId: number; entityId: number; status: string; error?: string }> = []
    const off = onStudioEvent((e) => {
      if (e.type === 'entity.ref_gen') evBuf.push({ projectId: e.projectId, taskId: e.taskId, entityId: e.entityId, status: e.status, error: e.error })
    })
    const issued = await startEntityRefGen(pid, [cB, cA, cA], 2)
    const idList = issued.tasks.map((x) => x.id)
    check(issued.count === 4 && idList.length === 4, '重复 ids 去重 → 2 实体 × 2 变体 = 4 任务')
    const rowsIssued = await db.select().from(genTasks).where(inArray(genTasks.id, idList))
    check(rowsIssued.every((r) => r.runId === null && r.stepId === null && r.canvasNodeId === null), '批量任务三归属列均 null（无 run 队列，不占引擎槽位）')
    check(rowsIssued.every((r) => r.kind === 'image' && r.projectId === pid), '任务 kind=image + 项目归属正确')
    check(new Set(rowsIssued.map((r) => parseRefGenParams(r.params)!.entity_id)).size === 2, '两实体各得自身任务（params.entity_id 区分）')
    const byEntity = new Map(rowsIssued.map((r) => [parseRefGenParams(r.params)!.entity_id, r]))
    const promptB = byEntity.get(cB)?.prompt ?? ''
    check(promptB.includes('山门石阶，晨雾') && promptB.includes('必须剔除：现代建筑'), '入队提示词 = appearance + 负向（拼接直连，无 LLM 预润色）')
    check(!promptB.includes('视觉风格'), '风格词不在入队快照（执行期现取项配置 → 改风无需重发）')
    check((JSON.parse(byEntity.get(cB)!.params) as Record<string, unknown>)['refs_planned'] === 4, 'refs_planned = 候选去重截断后数量（5 → 4）')
    check(
      rowsIssued.every((r) => (JSON.parse(r.params) as Record<string, unknown>)['size'] === '832x1248'),
      '未配 settings.image.size → 默认 832x1248（竖版人像）',
    )

    // ---- 项目风格词块接入（与 ai-image 注入同源） ----
    const sp1 = (await db.insert(stylePresets).values({ name: '探针画风一', snippet: 'ink wash painting', createdAt: T0, updatedAt: T0 }).returning())[0]!.id
    const sp2 = (await db.insert(stylePresets).values({ name: '探针画风二', snippet: 'high contrast', createdAt: T0, updatedAt: T0 }).returning())[0]!.id
    const pidStyle = await mkProject('M19 风格批量', JSON.stringify({ style_preset_ids: [sp1, sp2] }))
    const snips = (await resolveProjectStyleSnippets(pidStyle)).map((s) => s.snippet)
    check(
      composeEntityRefPrompt({ appearance: '少女，红衣', negative: null }, snips) === '少女，红衣\n视觉风格：ink wash painting；high contrast',
      '项目多风格预设按绑定顺序叠加进提示词（resolveProjectStyleSnippets 同源）',
    )
    check(combineStyleSnippets(snips) === 'ink wash painting；high contrast', 'combineStyleSnippets 多词块「；」连接（无空块污染）')

    // ---- 执行器收敛（未配置 image 端点 → 自然失败，零网络） ----
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    const settleTasks = async (ids: number[]): Promise<Map<number, string>> => {
      const deadline = Date.now() + 60_000
      for (;;) {
        const rs = await db.select({ id: genTasks.id, status: genTasks.status }).from(genTasks).where(inArray(genTasks.id, ids))
        const m = new Map(rs.map((r) => [r.id, r.status]))
        if (rs.every((r) => ['succeeded', 'failed', 'cancelled'].includes(r.status)) || Date.now() > deadline) return m
        await sleep(250)
      }
    }
    const settled = await settleTasks(idList)
    check([...settled.values()].every((s) => s === 'failed'), `未配置 image 端点 → 4 任务均收敛 failed（实际 ${[...settled.values()].join('/')}）`)
    const afterRows = await db.select().from(genTasks).where(inArray(genTasks.id, idList))
    check(afterRows.every((r) => (r.errorMsg ?? '').includes('未配置') && r.attempts >= 2), '失败附端点配置引导文案 + attempts≥2（自动重试 1 次耗尽）')
    check(afterRows.every((r) => r.resultAssetId === null), '失败不落资产（result_asset_id 恒 null）')
    check(((await db.select().from(characters).where(eq(characters.id, cA)))[0])!.refAssetIds === '[]', '失败不挂接参考图（实体 ref_asset_ids 不变）')
    check(
      new Set(evBuf.filter((e) => e.status === 'processing').map((e) => e.taskId)).size === 4,
      '每任务至少一条 processing 事件（页内进度驱动；重试可重发）',
    )
    check(
      evBuf.filter((e) => e.status === 'failed').length === 4 && evBuf.filter((e) => e.status === 'failed').every((e) => (e.error ?? '').length > 0),
      '每任务发 failed 事件并带 error 文本（行内可展开原因）',
    )
    check(evBuf.every((e) => e.projectId === pid && e.entityId > 0), '事件带 projectId/entityId（project room 投递依据，无需 run）')

    // ---- 任务列表（认领域 + 排除 + 置顶 + 截断） ----
    const mkRow = async (
      status: string,
      over: { entityId?: number; runId?: number | null; stepId?: number | null; canvasNodeId?: number | null; source?: string } = {},
    ): Promise<number> =>
      (
        await db
          .insert(genTasks)
          .values({
            projectId: pid,
            runId: over.runId ?? null,
            stepId: over.stepId ?? null,
            canvasNodeId: over.canvasNodeId ?? null,
            kind: 'image',
            params: JSON.stringify({ entity_id: over.entityId ?? cA, variant_index: 0, source: over.source ?? refgen.REFGEN_SOURCE }),
            status,
            createdAt: T0,
            updatedAt: T0,
          })
          .returning()
      )[0]!.id
    const tCanvas = await mkRow('pending', { canvasNodeId: 888888 })
    const tRun = await mkRow('pending', { runId: 777777, stepId: 1 })
    const tForeign = await mkRow('pending', { source: 'other_domain' })
    const tGhost = await mkRow('pending', { entityId: 999999 })
    const list0 = await listEntityRefTasks(pid)
    check(list0.items.filter((i) => idList.includes(i.id)).length === 4, '列表含本次 4 任务（终态可见，供行内重试入口）')
    check(!list0.items.some((i) => i.id === tCanvas), 'canvasNodeId 非 null 的任务不混入（即使 params 属本域）')
    check(!list0.items.some((i) => i.id === tRun), 'run/step 任务不混入（无 run 队列为唯一域）')
    check(!list0.items.some((i) => i.id === tForeign), '非本域 params 任务不混入')
    check(list0.items.some((i) => i.id === tGhost && i.entityName === '素材#999999'), '素材已不存在 → entityName 回退 素材#{id}（不丢行、不空标题）')
    check(list0.items.filter((i) => i.entityId === cA).every((i) => i.entityName === '批量角色A'), 'entityName 取自主数据（前端免二次查）')
    check(list0.counts.failed === 4 && list0.counts.total === list0.items.length, 'counts 按状态汇总且 total 与 items 一致')
    const idxLive = list0.items.findIndex((i) => i.status === 'pending')
    const idxSettled = list0.items.findIndex((i) => i.status === 'failed')
    check(idxLive >= 0 && idxLive < idxSettled, '在途任务置顶（刷新后进度首屏不丢）')
    check((await codeOf(() => listEntityRefTasks(-3))) === 'bad_project_id:400', '列表 project_id 非法 → bad_project_id')
    for (let i = 0; i < 25; i += 1) await mkRow('failed')
    const list1 = await listEntityRefTasks(pid)
    check(list1.items.filter((i) => ['succeeded', 'failed', 'cancelled'].includes(i.status)).length === 20, '终态仅留近 20 条（在途不受限，历史不得撞屏）')

    // ---- 取消（仅 pending/processing） ----
    const tCancel = await mkRow('pending')
    const evN = evBuf.length
    const ck = await cancelEntityRefTask(tCancel)
    const rowC = (await db.select().from(genTasks).where(eq(genTasks.id, tCancel)))[0]!
    check(ck.ok === true && rowC.status === 'cancelled' && rowC.errorMsg === 'user cancelled' && rowC.completedAt !== null, '取消 → cancelled + user cancelled + completedAt')
    check(evBuf.slice(evN).some((e) => e.taskId === tCancel && e.status === 'cancelled'), '取消发 entity.ref_gen(cancelled) 事件')
    check((await codeOf(() => cancelEntityRefTask(tCancel))) === 'bad_status:400', '终态再取消 → bad_status')
    check((await codeOf(() => cancelEntityRefTask(tForeign))) === 'not_ref_gen:400', '非本域任务 → not_ref_gen（不误取消画布/run 任务）')
    const nfCancel = await errOf(() => cancelEntityRefTask(9999999))
    check(nfCancel instanceof WorkbenchError && nfCancel.code === 'not_found' && nfCancel.status === 404, '未知任务 → not_found(404)')
    off()

    // ---- 启动恢复（本域在途 → 失败；他域不动） ----
    const tRec1 = await mkRow('pending')
    const tRec2 = await mkRow('processing')
    const rec = await recoverEntityRefTasks()
    const recRows = await db.select().from(genTasks).where(inArray(genTasks.id, [tRec1, tRec2]))
    check(rec.failed >= 2 && recRows.length === 2 && recRows.every((r) => r.status === 'failed' && r.errorMsg === '服务重启中断'), 'recover → 本域在途置 failed「服务重启中断」')
    const untouched = await db.select().from(genTasks).where(inArray(genTasks.id, [tCanvas, tRun, tForeign]))
    check(untouched.length === 3 && untouched.every((r) => r.status === 'pending'), 'recover 不误伤画布/run/非本域任务（职责边界）')
    check((await recoverEntityRefTasks()).failed === 0, '二次 recover 幂等（无残留在途本域任务）')

    // ---- [P6] 执行器成功径（fetch stub 零外发：能力位 / 落盘 / 挂接 / 用量 / 事件 / 重试 / 取消弃存） ----
    const { apiConfigs, assets: assetTbl, usageRecords } = await import('../src/db/schema')
    const { attachRefAssets } = await import('../src/services/character')
    const { absPathOf } = await import('../src/services/storage')
    const origFetch = globalThis.fetch
    await db.insert(apiConfigs).values({
      providerKey: 'openai_image',
      serviceType: 'image',
      name: '探针图像',
      baseUrl: 'http://probe-img.local/v1',
      apiKeyRef: 'env:PROBE_M19_IMG_KEY',
      model: 'endpoint-default-model',
      priority: 0,
      isDefault: 1,
      isActive: 1,
      createdAt: T0,
      updatedAt: T0,
    })
    process.env.PROBE_M19_IMG_KEY = 'probe-key-m19'
    const PNG1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const imgReqs: Array<{ url: string; body: Record<string, unknown> | null }> = []
    let throwNext = true
    let imgDelayMs = 0
    globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
      if (url.includes('/images/generations')) {
        imgReqs.push({ url, body })
        if (imgDelayMs > 0) await sleep(imgDelayMs)
        if (throwNext) {
          throwNext = false
          return new Response('upstream boom', { status: 500 })
        }
        return new Response(JSON.stringify({ data: [{ b64_json: PNG1X1 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const pidImg = await mkProject(
        'M19 批量出图',
        JSON.stringify({ image: { provider: 'openai_image', model: 'settings-model', size: '1024x1024' }, style_preset_ids: [sp1] }),
      )
      const cImg = await mkChar('出图角色', { projectId: pidImg, appearance: '圆脸大眼，虎头帽红袄', refAssetIds: [999] })
      const ev2: Array<{ projectId: number; taskId: number; entityId: number; status: string; error?: string }> = []
      const off2 = onStudioEvent((e) => {
        if (e.type === 'entity.ref_gen') ev2.push({ projectId: e.projectId, taskId: e.taskId, entityId: e.entityId, status: e.status, error: e.error })
      })
      const issued2 = await startEntityRefGen(pidImg, [cImg], 2)
      const ids2 = issued2.tasks.map((x) => x.id)
      const st2 = await settleTasks(ids2)
      check([...st2.values()].every((s) => s === 'succeeded'), `成功径：首个 5xx 自动重试 → 2 任务均 succeeded（实际 ${[...st2.values()].join('/')}）`)
      const rows2 = await db.select().from(genTasks).where(inArray(genTasks.id, ids2))
      check(rows2.some((r) => r.attempts === 2) && rows2.some((r) => r.attempts === 1), '重试留痕：一条 attempts=2（5xx 后重试成功）、一条 attempts=1')
      check(rows2.every((r) => r.resultAssetId !== null), '成功回写 result_asset_id（变体画廊/溯源头）')
      check(imgReqs.every((r) => r.url === 'http://probe-img.local/v1/images/generations') && imgReqs.length >= 3, '请求落 stub 端点（零真实外发）')
      const body0 = imgReqs[0]?.body ?? {}
      check(body0['model'] === 'settings-model' && body0['size'] === '1024x1024', 'settings.image 配置链生效（model 覆盖端点默认 + size 透传）')
      check(Object.keys(body0).sort().join(',') === 'model,n,prompt,size', '能力位 none（openai_image）→ 请求体不携参考图字段（纯文本锚定降级）')
      const prompt2 = rows2.find((r) => r.status === 'succeeded')?.prompt ?? ''
      check(prompt2.includes('圆脸大眼') && prompt2.includes('视觉风格：ink wash painting'), '成功径提示词含项目风格词块（执行期解析并回写任务）')
      const newAssets = await db.select().from(assetTbl).where(eq(assetTbl.projectId, pidImg))
      check(newAssets.length === 2 && newAssets.every((a) => a.purpose === 'reference_character' && a.kind === 'image'), '落盘 purpose=reference_character（角色 kind 映射）+ kind=image')
      check(newAssets.every((a) => !!a.relPath && existsSync(absPathOf(a.relPath))), '图片文件真实写入项目目录（base64 落盘）')
      check(
        newAssets.every((a) => {
          const p = JSON.parse(a.params ?? '{}') as Record<string, unknown>
          return p['source'] === refgen.REFGEN_SOURCE && p['entity_id'] === cImg && typeof p['task_id'] === 'number'
        }),
        'asset.params 带 source/entity_id/task_id（与 spec 溯源约定一致）',
      )
      const merged = JSON.parse(((await db.select().from(characters).where(eq(characters.id, cImg)))[0])!.refAssetIds) as number[]
      check(merged.length === 3 && merged.includes(999) && newAssets.every((a) => merged.includes(a.id)), '自动挂接：原候选保留 + 新产物并集追加')
      const us2 = await db.select().from(usageRecords).where(eq(usageRecords.projectId, pidImg))
      check(
        us2.length === 2 && us2.every((u) => u.kind === 'image' && u.unit === 'image' && u.quantity === 1 && u.runId === null && u.taskId !== null),
        '用量记账 2 行（image/image/1；无 run，taskId 可溯）',
      )
      check(ev2.filter((e) => e.status === 'succeeded').length === 2 && ev2.every((e) => e.projectId === pidImg), 'succeeded 事件 2 条（页内进度 + 列表刷新触发）')
      const addedAgain = await attachRefAssets(pidImg, '出图角色', [newAssets[0]!.id, newAssets[1]!.id], 'character')
      const merged2 = JSON.parse(((await db.select().from(characters).where(eq(characters.id, cImg)))[0])!.refAssetIds) as number[]
      check(addedAgain === 0 && merged2.length === 3, '重复挂接幂等（并集去重，二次追加 0 条）')

      // 取消竞态：出图不可中断 → 完成后弃存（不落资产、不挂接）
      imgDelayMs = 700
      const issued3 = await startEntityRefGen(pidImg, [cImg], 1)
      const tid3 = issued3.tasks[0]!.id
      for (let i = 0; i < 80; i += 1) {
        const r = (await db.select({ status: genTasks.status }).from(genTasks).where(eq(genTasks.id, tid3)))[0]!
        if (r.status === 'processing') break
        await sleep(50)
      }
      await cancelEntityRefTask(tid3)
      const st3 = await settleTasks([tid3])
      check(st3.get(tid3) === 'cancelled', '取消竞态：已发出的出图完成后弃存（status 保持 cancelled，不被 succeeded 覆盖）')
      check((await db.select().from(assetTbl).where(eq(assetTbl.projectId, pidImg))).length === 2, '弃存不落资产（取消后无新增 asset）')
      check((JSON.parse(((await db.select().from(characters).where(eq(characters.id, cImg)))[0])!.refAssetIds) as number[]).length === 3, '弃存不挂接（ref_asset_ids 不变）')
      imgDelayMs = 0
      // 排空在途执行器（stub 延迟 700ms + 重试间隔）：否则本节结束时后台任务会打到已关闭的探针库（日志噪声）
      await sleep(1500)
      off2()
    } finally {
      globalThis.fetch = origFetch
      await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, 'image'))
      delete process.env.PROBE_M19_IMG_KEY
    }
    check((await db.select().from(apiConfigs)).length === 0, 'stub 段收尾清理 image 端点与环境变量（不污染后续节）')
  }

  // ================= 7. states =================

  async function sectionStates(): Promise<void> {
    const ai = await import('../src/pipeline/actions/ai-image')
    const { injectStateAnchors, matchStateEntry, parseStateEntry } = ai
    const { loadEntityIndex, upsertEntity } = await import('../src/services/character')
    const { apiConfigs, pipelineSteps, stylePresets } = await import('../src/db/schema')
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

    // ---- [P1] characters.states 列 JSON 往返 ----
    const spS = (await db.insert(stylePresets).values({ name: '探针状态画风', snippet: 'ink wash', createdAt: T0, updatedAt: T0 }).returning())[0]!.id
    const pidS = await mkProject('M19 状态注入', JSON.stringify({ style_preset_ids: [spS] }))
    const c = (
      await db
        .insert(characters)
        .values({
          projectId: pidS,
          kind: 'character',
          name: '状态测试角色',
          aliases: '[]',
          states: JSON.stringify(['第5场受伤：额头绷带']),
          refAssetIds: '[]',
          createdAt: T0,
          updatedAt: T0,
        })
        .returning()
    )[0]!
    const parsed = JSON.parse(c.states) as string[]
    check(parsed.length === 1 && parsed[0] === '第5场受伤：额头绷带', 'characters.states JSON 往返（{剧情节点}：{状态短语} 格式）')

    // ---- [P7] parseStateEntry：分隔符矩阵 ----
    const pe1 = parseStateEntry('第5场受伤：额头绷带')
    check(pe1.node === '第5场受伤' && pe1.phrase === '额头绷带', 'parseStateEntry 全角冒号分割 node/phrase')
    const pe2 = parseStateEntry('第3集落水: 湿透校服')
    check(pe2.node === '第3集落水' && pe2.phrase === '湿透校服', 'parseStateEntry 半角冒号同权 + 两侧空白剔除')
    const pe3 = parseStateEntry('换装：红袄：白裙')
    check(pe3.node === '换装' && pe3.phrase === '红袄：白裙', 'parseStateEntry 首个冒号分割（余下冒号归短语）')
    const pe4 = parseStateEntry('雨夜街头')
    check(pe4.node === '雨夜街头' && pe4.phrase === '', 'parseStateEntry 无分隔 → node=全串、phrase 空')
    const pe5 = parseStateEntry(undefined)
    check(pe5.node === '' && pe5.phrase === '', 'parseStateEntry 非字符串 → 空条目（不抛）')

    // ---- [P7] matchStateEntry：场 / 集 / 文本三级匹配矩阵 ----
    const m1 = matchStateEntry('第5场受伤：额头绷带', { scene: 5, episode: 1, text: 's05 巷口' })
    check(m1.hit && m1.mode === 'scene', '场次定位词与 shot.scene 数值相等命中')
    const m2 = matchStateEntry('第5场受伤：额头绷带', { scene: 4, episode: 5, text: '第5场受伤 s05 巷口' })
    check(!m2.hit && m2.mode === 'scene', '场次不等 → 不命中，且不回落集数/文本（场档独占）')
    const m3 = matchStateEntry('第5场受伤：额头绷带', { text: '第5场受伤 s05' })
    check(!m3.hit && m3.mode === 'scene', 'shot 无 scene（存量分镜）→ 场档降级不命中，不做文本兜底')
    const m4 = matchStateEntry('第五场受伤：绷带', { scene: 5 })
    check(m4.hit && m4.mode === 'scene', '中文数字「第五场」→ 5（阿拉伯/中文同权）')
    check(matchStateEntry('第十二场：雪夜', { scene: 12 }).hit, '中文数字「十二」→ 12（十位起）')
    check(matchStateEntry('第二十场：雪夜', { scene: 20 }).hit, '中文数字「二十」→ 20（spec 一至二十）')
    check(!matchStateEntry('第二十一场：雪夜', { scene: 20 }).hit, '中文数字不可解析 → 不命中（不误判）')
    check(matchStateEntry('第5场次受伤：绷带', { scene: 5 }).hit, '「第N场次」写法同档命中')
    const m5 = matchStateEntry('第3集落水：湿透校服', { scene: 9, episode: 3 })
    check(m5.hit && m5.mode === 'episode', '无场次词 → 集数档与 run episode_number 对齐')
    const m6 = matchStateEntry('第3集落水：湿透校服', { scene: 9 })
    check(!m6.hit && m6.mode === 'episode', 'episode 缺失 → 集数档不命中（降级）')
    const m7 = matchStateEntry('第5场第3集：雪', { scene: 5, episode: 3 })
    check(m7.mode === 'scene' && m7.hit, '场/集同现 → 场次档优先（判定顺序即优先级）')
    const m8 = matchStateEntry('淋雨：全身湿透', { scene: 1, episode: 2, text: 's07 巷口 淋雨奔跑的小女孩' })
    check(m8.hit && m8.mode === 'text', '无定位词 → 节点串包含于 shot 文本（id+location+image_prompt）')
    check(!matchStateEntry('淋雨：全身湿透', { text: 's07 教室' }).hit, '无定位词且文本不含节点 → 不命中')
    check(!matchStateEntry('：只有短语', { text: '任意文本' }).hit, '空节点（仅短语）→ 不命中（避免空串恒包含）')

    // ---- [P7] injectStateAnchors：注入格式 / 多条取最后 / 零 diff ----
    await db.delete(characters).where(eq(characters.id, c.id)) // 避免旧样板行干扰索引断言
    await upsertEntity({ projectId: pidS, kind: 'character', name: '状态角色', appearance: '圆脸大眼，虎头帽红袄', states: ['第5场受伤：额头绷带', '第5场复发：绷带与拐杖'] })
    await upsertEntity({ projectId: pidS, kind: 'character', name: '集数角色', appearance: '少年，蓝校服', states: ['第3集落水：湿透校服'] })
    await upsertEntity({ projectId: pidS, kind: 'character', name: '无状态角色', appearance: '老者，灰长衫' })
    await upsertEntity({ projectId: pidS, kind: 'scene', name: '巷口', appearance: '青石窄巷，暖灯' })
    const idxS = await loadEntityIndex(pidS, 'character')
    const shotsIn = [
      { id: 's05', scene: 5, location: '巷口', characters: ['状态角色'], image_prompt: 'P5' },
      { id: 's06', scene: 6, location: '教室', characters: ['状态角色'], image_prompt: 'P6' },
      { id: 's03', scene: 3, location: '河边', characters: ['集数角色'], image_prompt: 'P3' },
      { id: 's07', scene: 7, characters: ['无状态角色'], image_prompt: 'P7' },
      { id: 's08', scene: 8, image_prompt: 'P8' },
      { id: 's09', scene: 9, characters: ['查无此人'], image_prompt: 'P9' },
    ]
    const inj = injectStateAnchors(shotsIn, idxS, 3)
    check(inj.shots[0]!.image_prompt === 'P5\n状态锚定（状态角色·第5场复发）：绷带与拐杖', `多条命中取 states 数组最后一条（实际 ${JSON.stringify(inj.shots[0]!.image_prompt)}）`)
    check(inj.shots[1]!.image_prompt === 'P6', 'scene=6 无命中条目 → 原文不变')
    check(inj.shots[2]!.image_prompt === 'P3\n状态锚定（集数角色·第3集落水）：湿透校服', '集数档经 episode 入参命中')
    check(inj.shots[3]!.image_prompt === 'P7' && inj.shots[4]!.image_prompt === 'P8', '无 states / 无 characters 镜原文不变')
    check(inj.shots[5]!.image_prompt === 'P9', '角色未命中索引 → 静默不注入（未命中报告归角色锚定段）')
    check(inj.injected === 2, `injected=${inj.injected}（仅实注 2 镜）`)
    check(
      inj.details.length === 2 && inj.details[0]!.includes('s05') && inj.details[0]!.includes('绷带与拐杖'),
      `details 逐条明细供日志（${inj.details.join(' | ')}）`,
    )
    check(shotsIn[0]!.image_prompt === 'P5', '入参数组不被修改（纯函数）')
    check(injectStateAnchors([{ ...shotsIn[2]! }], idxS).shots[0]!.image_prompt === 'P3', 'episode 未传（run.input 无 episode_number）→ 集数档不命中')
    const shotsNoState = [{ id: 'x1', scene: 5, characters: ['无状态角色'], image_prompt: 'X' }]
    const zero = injectStateAnchors(shotsNoState, idxS, 3)
    check(zero.shots === shotsNoState && zero.injected === 0 && zero.details.length === 0, '无 states → 零 diff（返回入参数组引用，不造新对象）')

    // ---- [P7] ai-image 集成：真实 step 执行（fetch stub 零外发）→ 任务 prompt 快照含状态锚定 + 注入顺序 + 日志 ----
    const { createStepContext } = await import('../src/pipeline/context')
    const { writeTextAsset } = await import('../src/services/storage')
    const { RUN_LOGS_DIR } = await import('../src/env')
    const origFetch = globalThis.fetch
    await db.insert(apiConfigs).values({
      providerKey: 'openai_image',
      serviceType: 'image',
      name: '探针状态图像',
      baseUrl: 'http://probe-state.local/v1',
      apiKeyRef: 'env:PROBE_M19_STATE_KEY',
      model: 'state-model',
      priority: 0,
      isDefault: 1,
      isActive: 1,
      createdAt: T0,
      updatedAt: T0,
    })
    process.env.PROBE_M19_STATE_KEY = 'probe-key-state'
    const PNG1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const stateReqs: Array<{ url: string }> = []
    globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.includes('/images/generations')) {
        stateReqs.push({ url })
        return new Response(JSON.stringify({ data: [{ b64_json: PNG1X1 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const runRow = (
        await db
          .insert(pipelineRuns)
          .values({
            projectId: pidS,
            templateKey: 'mengbao-episode',
            status: 'running',
            input: JSON.stringify({ episode_number: 3 }),
            createdAt: T0,
            updatedAt: T0,
          })
          .returning()
      )[0]!
      const stepRow = (
        await db
          .insert(pipelineSteps)
          .values({ runId: runRow.id, seq: 1, stepKey: 'gen_images', actionKey: 'ai_image', title: 'gen_images', status: 'running', createdAt: T0, updatedAt: T0 })
          .returning()
      )[0]!
      const defS = { key: 'gen_images', action: 'ai_image', title: 'gen_images', inputs: {}, params: {}, batch: { field: 'shots', maxConcurrent: 2, retry: 0 } }
      const sbAsset = await writeTextAsset(pidS, {
        name: 'storyboard-state.json',
        content: JSON.stringify({ shots: shotsIn }),
        purpose: 'storyboard',
        format: 'json',
        stepId: stepRow.id,
        runId: runRow.id,
      })
      const ctxS = await createStepContext({
        run: runRow,
        step: stepRow,
        template: { key: 'probe-m19-states', version: 1, name: '探针', genre: 'other', inputs: [], steps: [defS] },
        def: defS,
        input: { shots: [sbAsset.id] },
        projectSettings: JSON.parse(((await db.select().from(projects).where(eq(projects.id, pidS)))[0]!).settings) as Record<string, unknown>,
      })
      const res = await ai.aiImage(ctxS)
      check(res.assetIds.length === shotsIn.length, `ai_image 全链执行完成（${res.assetIds.length}/${shotsIn.length} 镜，stub 端点零外发）`)
      check(stateReqs.length === shotsIn.length && stateReqs.every((r) => r.url === 'http://probe-state.local/v1/images/generations'), '出图请求全部落 stub 端点')
      const tRows = await db.select().from(genTasks).where(eq(genTasks.runId, runRow.id))
      const promptOf = (shotId: string): string =>
        tRows.find((r) => (JSON.parse(r.params ?? '{}') as { shotId?: string }).shotId === shotId)?.prompt ?? ''
      const p5 = promptOf('s05')
      check(p5.includes('状态锚定（状态角色·第5场复发）：绷带与拐杖'), '任务 prompt 快照含状态锚定段（快照即一致性硬证据）')
      check(
        p5.includes('角色锚定（状态角色）') && p5.indexOf('角色锚定') < p5.indexOf('状态锚定') && p5.indexOf('状态锚定') < p5.indexOf('场景锚定（巷口）') && p5.indexOf('场景锚定') < p5.indexOf('视觉风格'),
        '注入链顺序 = 角色 → 状态 → 场景/道具 → 风格（逐段叠加位置可核）',
      )
      check(promptOf('s03').includes('状态锚定（集数角色·第3集落水）'), 'episode 取 run.input.episode_number（集数档真链命中）')
      check(
        ['s06', 's07', 's08', 's09'].every((id) => !promptOf(id).includes('状态锚定')),
        '无 states / 无命中镜任务 prompt 不含状态段（ai-image 零 diff 到任务快照）',
      )
      check(promptOf('s07').includes('角色锚定（无状态角色）'), '无 states 角色仍照常角色锚定（旧行为不变）')
      const logTxt = existsSync(join(RUN_LOGS_DIR, `${runRow.id}.log`)) ? readFileSync(join(RUN_LOGS_DIR, `${runRow.id}.log`), 'utf8') : ''
      check(logTxt.includes('状态锚定注入 2 镜') && logTxt.includes('s05 状态角色「第5场复发」'), 'run 日志留痕：注入镜数 + 逐条明细（spec §5 验收口径）')
      await sleep(600) // 排空 scheduleImageCheck fire-and-forget（避免打到已关闭的探针库）
    } finally {
      globalThis.fetch = origFetch
      await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, 'image'))
      delete process.env.PROBE_M19_STATE_KEY
    }
    check((await db.select().from(apiConfigs)).length === 0, '集成段收尾清理 image 端点与环境变量（不污染后续节）')
  }

  // ================= 8. voice-clone =================

  async function sectionVoiceClone(): Promise<void> {
    await db.insert(voiceClones).values({
      name: '探针音色',
      providerKey: 'aliyun_qwen_tts',
      model: 'cosyvoice-v1',
      voiceId: 'voice-probe-1',
      status: 'ready',
      meta: JSON.stringify({ protocol: 'dashscope-enrollment', prefix: 'probe' }),
      createdAt: T0,
      updatedAt: T0,
    })
    const rows = await db.select().from(voiceClones).where(eq(voiceClones.name, '探针音色')).limit(1)
    check(rows[0]?.voiceId === 'voice-probe-1' && rows[0]?.status === 'ready', 'voice_clones 插入/读取往返')
    const dupErr = await errOf(async () =>
      db.insert(voiceClones).values({ name: '探针音色', providerKey: 'x', model: 'y', voiceId: 'z', createdAt: T0, updatedAt: T0 }),
    )
    check(dupErr instanceof Error, 'voice_clones.name 唯一约束生效（重名不允许）')

    // ---- [P8] 能力位矩阵（VOICE_CLONE_PROVIDERS = 唯一事实源；未登记 = 不支持） ----
    await db.delete(voiceClones) // 清掉 P1 样板行，后续节在受控空库上跑
    const tc = await import('../src/services/tts-clone')
    const {
      CLONE_SAMPLE_MAX_BYTES,
      CLONE_TEST_MAX_CHARS,
      VOICE_CLONE_PROVIDERS,
      VOICE_CLONE_PROTOCOLS,
      buildEnrollBody,
      cloneCapabilityOf,
      cloneEndpoint,
      createVoiceClone,
      deleteVoiceClone,
      getVoiceClone,
      listCloneProviders,
      listVoiceClones,
      loadCloneIndex,
      normalizeSampleMime,
      parseCloneRef,
      parseEnrollResponse,
      sanitizeClonePrefix,
      synthWithClone,
      validCloneRef,
      validateCloneSample,
    } = tc
    const { resolveVoiceChain } = await import('../src/pipeline/actions/tts')
    const { apiConfigs, assets, pipelineSteps, usageRecords } = await import('../src/db/schema')
    const { upsertEntity } = await import('../src/services/character')
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

    check(cloneCapabilityOf('aliyun_qwen_tts') === true, '能力位：aliyun_qwen_tts 已登记克隆协议')
    check(
      cloneCapabilityOf('siliconflow_audio') === false && cloneCapabilityOf('openai_audio') === false && cloneCapabilityOf('volcengine_audio') === false,
      '能力位：未登记供应商 = 不支持（UI 下拉置灰依据；v1 不伪接未验证协议）',
    )
    check(
      Object.values(VOICE_CLONE_PROVIDERS).every((p) => p.protocol in VOICE_CLONE_PROTOCOLS && !!p.defaultTargetModel),
      '能力位表自洽：协议均在协议族登记 + 均携默认目标模型',
    )
    const provs = await listCloneProviders()
    check(provs.some((p) => p.key === 'aliyun_qwen_tts' && p.available === true), 'listCloneProviders：audio 目录内 aliyun 标记 available')
    check(
      provs.length > 0 && provs.every((p) => p.available === cloneCapabilityOf(p.key)),
      `listCloneProviders 全量矩阵与能力位一致（${provs.length} 家 audio 供应商）`,
    )

    // ---- [P8] parseCloneRef / validCloneRef：令牌解析与索引命中 ----
    check(parseCloneRef('clone:12') === 12 && parseCloneRef('  clone:3 ') === 3, 'parseCloneRef 正整数令牌→id（含两侧空白）')
    check(
      parseCloneRef('clone:0') === null && parseCloneRef('clone:-2') === null && parseCloneRef('clone:1.5') === null && parseCloneRef('clone:x') === null && parseCloneRef('clone:') === null,
      'parseCloneRef 非正整数/非数字 → null（不误伤普通令牌）',
    )
    check(
      parseCloneRef('alloy') === null && parseCloneRef('FunAudioLLM/CosyVoice2-0.5B:alex') === null && parseCloneRef('CLONE:5') === null && parseCloneRef(undefined) === null && parseCloneRef(null) === null,
      'parseCloneRef 非 clone 前缀（含「模型:音色」形态、大写变体、空值）→ null',
    )
    const mkClone = (over: Partial<VoiceClone>): VoiceClone => ({
      id: 901,
      name: '索引音色',
      providerKey: 'aliyun_qwen_tts',
      model: 'qwen3-tts-vc-2026-01-22',
      voiceId: 'vc-901',
      status: 'ready',
      meta: '{}',
      createdAt: T0,
      updatedAt: T0,
      ...over,
    })
    const fakeIdx = new Map<number, VoiceClone>([[901, mkClone({})]])
    check(validCloneRef('clone:901', fakeIdx)?.voiceId === 'vc-901', 'validCloneRef 令牌 + 索引命中 → 行')
    check(
      validCloneRef('clone:902', fakeIdx) === null && validCloneRef('Cherry', fakeIdx) === null && validCloneRef('clone:901') === null && validCloneRef('', fakeIdx) === null,
      'validCloneRef 索引未命中 / 非令牌 / 无索引 / 空值 → null（交由调用方降级）',
    )

    // ---- [P8] sanitizeClonePrefix：协议字符集/长度/空回退 ----
    check(sanitizeClonePrefix('Cosy Voice 2') === 'CosyVoice2', '前缀清洗：剔除空格等非法字符（qwen 协议 [A-Za-z0-9_]）')
    check(sanitizeClonePrefix('萌宝-童声A') === 'A', '前缀清洗：中文与连字符均不在白名单 → 仅留 ASCII 字母')
    check(sanitizeClonePrefix('abcdefghijklmnopqrstuvwxyz') === 'abcdefghijklmnop', '前缀清洗：截断至协议上限 16')
    check(sanitizeClonePrefix('全部中文名称') === 'voice', '前缀清洗：全非法字符 → 回退 voice（供应商侧不接受空前缀）')
    check(
      sanitizeClonePrefix('Cosy Voice 2', 'dashscope-enrollment') === 'CosyVoice2' &&
        sanitizeClonePrefix('ab_cd', 'dashscope-enrollment') === 'abcd',
      '前缀清洗按协议字符集：voice-enrollment 不收下划线（连同空格一并剔除）',
    )

    // ---- [P8] normalizeSampleMime / validateCloneSample ----
    check(
      normalizeSampleMime('audio/wav') === 'audio/wav' && normalizeSampleMime('audio/X-WAV') === 'audio/wav' && normalizeSampleMime('audio/wave') === 'audio/wav',
      'MIME 归一：wav 别名族 → audio/wav',
    )
    check(
      normalizeSampleMime('audio/mp3') === 'audio/mpeg' && normalizeSampleMime('AUDIO/MPEG; codecs=mp4a.40.2') === 'audio/mpeg',
      'MIME 归一：mp3 别名 + 大小写 + 参数后缀 → audio/mpeg',
    )
    check(
      normalizeSampleMime('video/mp4') === null && normalizeSampleMime('application/octet-stream') === null && normalizeSampleMime(undefined) === null && normalizeSampleMime('') === null,
      'MIME 白名单外/缺失 → null（硬拦截）',
    )
    const v0 = validateCloneSample({ sizeBytes: 0, mime: 'audio/mpeg' })
    check(!v0.ok && v0.issue?.code === 'empty_sample', '样本校验：空文件 → empty_sample')
    const v1 = validateCloneSample({ sizeBytes: 1024, mime: 'video/mp4' })
    check(!v1.ok && v1.issue?.code === 'bad_sample_mime' && v1.mime === null, '样本校验：非 wav/mp3 → bad_sample_mime')
    const v2 = validateCloneSample({ sizeBytes: CLONE_SAMPLE_MAX_BYTES + 1, mime: 'audio/wav' })
    check(!v2.ok && v2.issue?.code === 'too_large' && v2.issue.message.includes('10MB'), '样本校验：超 10MB → too_large（附实际体积）')
    const v3 = validateCloneSample({ sizeBytes: 1024, mime: 'audio/mpeg', durationSec: 15 })
    check(v3.ok && v3.mime === 'audio/mpeg' && v3.issue === null && v3.warnings.length === 0, '样本校验：10~60s 区间 → 无警告通过')
    const v4 = validateCloneSample({ sizeBytes: 1024, mime: 'audio/wav', durationSec: 5 })
    check(v4.ok && v4.warnings.length === 1 && v4.warnings[0]!.includes('低于建议值'), '时长不足→软警告不拒绝（ok 仍 true）')
    const v5 = validateCloneSample({ sizeBytes: 1024, mime: 'audio/wav', durationSec: 90 })
    check(v5.ok && v5.warnings[0]?.includes('超出建议上限'), '时长超 60s→软警告（供应商仅取前段）')
    const v6 = validateCloneSample({ sizeBytes: 1024, mime: 'audio/wav' })
    check(v6.ok && v6.warnings[0]?.includes('未能探测'), '时长不可得（ffprobe 缺失/解析失败）→ 软警告引导自查样本')

    // ---- [P8] buildEnrollBody / parseEnrollResponse：两套 DashScope 协议快照 ----
    const bA = buildEnrollBody({ protocol: 'dashscope-qwen-enrollment', targetModel: 'qwen3-tts-vc-2026-01-22', prefix: 'probe', sampleRef: 'data:audio/mpeg;base64,AAA' })
    check(
      bA.model === 'qwen-voice-enrollment' && bA.input.action === 'create' && bA.input.preferred_name === 'probe' && JSON.stringify(bA.input.audio) === '{"data":"data:audio/mpeg;base64,AAA"}',
      `qwen 内联协议 body 快照（audio.data 承 Data URL，实际 ${JSON.stringify(bA.input.audio)}）`,
    )
    const bB = buildEnrollBody({ protocol: 'dashscope-enrollment', targetModel: 'cosyvoice-v3.5-flash', prefix: 'probe', sampleRef: 'https://cdn.example.com/a.wav' })
    check(
      typeof (bB.input as Record<string, unknown>)['target_model'] === 'string',
      '公网协议 body 快照：target_model 逐字传递',
    )
    check(
      bB.model === 'voice-enrollment' && bB.input.action === 'create_voice' && bB.input.prefix === 'probe' && bB.input.url === 'https://cdn.example.com/a.wav' && bB.input.audio === undefined,
      '公网 URL 协议 body 快照（url 字段，不下发 audio）+ target_model 逐字传递',
    )
    check(bB.parameters != null && Object.keys(bB.parameters).length === 0, 'body.parameters 恒为空对象（协议要求字段存在）')
    check(
      parseEnrollResponse({ output: { voice_id: 'cosy-x-1' } }, 'dashscope-enrollment').voiceId === 'cosy-x-1',
      '响应解析：voice-enrollment → output.voice_id',
    )
    const pe = parseEnrollResponse({ output: { voice: ' qwen-vc-1 ', fallback_mode: true, fallback_reason: 'noisy' } }, 'dashscope-qwen-enrollment')
    check(pe.voiceId === 'qwen-vc-1' && pe.fallbackMode === true && pe.fallbackReason === 'noisy', '响应解析：qwen → output.voice（trim）+ fallback 留痕')
    check(parseEnrollResponse({}, 'dashscope-qwen-enrollment').voiceId === null && parseEnrollResponse(null, 'dashscope-enrollment').voiceId === null, '响应无音色字段/空体 → voiceId null（不静默落脏行）')

    // ---- [P8] createVoiceClone 全链（fetch stub 零外发：凭证/端点/body/落行） ----
    const MP3_B64 = Buffer.from('FAKE-MP3-BYTES-FOR-PROBE-0123456789').toString('base64')
    const WAV_BYTES = new Uint8Array(Buffer.from('RIFF0000WAVEfmt 0000001000000100010044ac00006400000002001000data00000000', 'base64'))
    process.env.PROBE_M19_CLONE_KEY = 'probe-key-clone'
    await db.insert(apiConfigs).values([
      {
        providerKey: 'openai_audio',
        serviceType: 'audio',
        name: '探针通用语音',
        baseUrl: 'http://probe-openai.local/v1',
        apiKeyRef: 'env:PROBE_M19_CLONE_KEY',
        model: 'tts-1',
        extra: JSON.stringify({ voice: 'InstanceVoice' }),
        priority: 0,
        isDefault: 1,
        isActive: 1,
        createdAt: T0,
        updatedAt: T0,
      },
      {
        providerKey: 'aliyun_qwen_tts',
        serviceType: 'audio',
        name: '探针克隆语音',
        baseUrl: 'http://probe-clone.local/api/v1',
        apiKeyRef: 'env:PROBE_M19_CLONE_KEY',
        model: 'qwen-tts',
        priority: 1,
        isDefault: 0,
        isActive: 1,
        createdAt: T0,
        updatedAt: T0,
      },
    ])
    const origFetch = globalThis.fetch
    const reqs: Array<{ url: string; auth: string; body: Record<string, unknown> }> = []
    interface StubResp {
      status: number
      json: Record<string, unknown>
    }
    let enrollNext = (): StubResp => ({ status: 200, json: { output: { voice: 'qwen-vc-probe-1' } } })
    globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      } catch {
        body = {}
      }
      reqs.push({ url, auth: String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ''), body })
      if (url.includes('/audio/speech')) {
        return new Response(new Uint8Array(Buffer.from(MP3_B64, 'base64')), { status: 200, headers: { 'content-type': 'audio/mpeg' } })
      }
      if (url.includes('/customization')) {
        const r = enrollNext()
        return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ output: { audio: { data: MP3_B64 } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    let cloneA!: VoiceClone
    let cloneB!: VoiceClone
    let warningsA: string[] = []
    try {
      const created = await createVoiceClone('aliyun_qwen_tts', { name: '克隆甲', sample: WAV_BYTES, mime: 'audio/wav' })
      cloneA = created.clone
      warningsA = created.warnings
      const enroll = reqs.find((r) => r.url.includes('/customization'))!
      check(enroll.url === 'http://probe-clone.local/api/v1/services/audio/tts/customization', `复刻请求落 stub customization 端点（实际 ${enroll.url}）`)
      check(enroll.auth === 'Bearer probe-key-clone', '凭证走 api_configs → env Key 解析（voice_clones 表不存密钥）')
      const inA = enroll.body.input as Record<string, unknown>
      check(
        enroll.body.model === 'qwen-voice-enrollment' && inA.action === 'create' && inA.target_model === 'qwen3-tts-vc-2026-01-22',
        `成功径 body 快照：enrollment 模型 + action + 默认目标模型（实际 ${String(enroll.body.model)}/${String(inA.action)}/${String(inA.target_model)}）`,
      )
      check(typeof inA.preferred_name === 'string' && inA.preferred_name === 'voice', '中文音色名 → 前缀清洗为协议合法值（实际 ' + String(inA.preferred_name) + '）')
      check(String((inA.audio as { data?: string }).data).startsWith('data:audio/wav;base64,'), '本地样本以 Data URL 内联下发（无需公网地址）')
      check(cloneA.id > 0 && cloneA.voiceId === 'qwen-vc-probe-1' && cloneA.status === 'ready' && cloneA.providerKey === 'aliyun_qwen_tts', '克隆成功 → 落行（供应商音色标识 + ready + 供应商归口）')
      check(cloneA.model === 'qwen3-tts-vc-2026-01-22', '落行 model = 目标克隆模型（合成时必须同模型）')
      const metaA = JSON.parse(cloneA.meta) as { protocol?: string; target_model?: string; transport?: string }
      check(metaA.protocol === 'dashscope-qwen-enrollment' && metaA.transport === 'data-uri' && metaA.target_model === 'qwen3-tts-vc-2026-01-22', 'meta 留痕协议/承载/模型（不含有敏感信息）')
      check(Array.isArray(warningsA), `warnings 数组回传（时长等软提醒 ${warningsA.length} 条）`)
      const back = await getVoiceClone(cloneA.id)
      check(back?.name === '克隆甲' && (await listVoiceClones()).length === 1, 'getVoiceClone / listVoiceClones 读回一致')

      // ---- 校验族（零副作用：不落行） ----
      const before = (await listVoiceClones()).length
      const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
        const e = await errOf(fn)
        return e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : e instanceof Error ? `nocode:${e.message.slice(0, 20)}` : 'no-error'
      }
      check((await codeOf(() => createVoiceClone('siliconflow_audio', { name: 'X', sample: WAV_BYTES, mime: 'audio/wav' }))) === 'unsupported_provider', '拦截族：未登记供应商 → unsupported_provider')
      check((await codeOf(() => createVoiceClone('aliyun_qwen_tts', { name: '  ', sample: WAV_BYTES, mime: 'audio/wav' }))) === 'bad_name', '拦截族：空音色名 → bad_name')
      check((await codeOf(() => createVoiceClone('aliyun_qwen_tts', { name: 'Y', sample: WAV_BYTES, mime: 'audio/wav', targetModel: 'bad model!' }))) === 'bad_target_model', '拦截族：target_model 非法字符 → bad_target_model')
      check((await codeOf(() => createVoiceClone('aliyun_qwen_tts', { name: 'Y', sample: new Uint8Array(), mime: 'audio/wav' }))) === 'empty_sample', '拦截族：空样本 → empty_sample')
      check((await codeOf(() => createVoiceClone('aliyun_qwen_tts', { name: 'Y', sample: WAV_BYTES, mime: 'video/mp4' }))) === 'bad_sample_mime', '拦截族：非 wav/mp3 → bad_sample_mime')
      check((await codeOf(() => createVoiceClone('aliyun_qwen_tts', { name: 'Y', sample: new Uint8Array(CLONE_SAMPLE_MAX_BYTES + 1), mime: 'audio/wav' }))) === 'too_large', '拦截族：>10MB → too_large')
      check((await codeOf(() => createVoiceClone('aliyun_qwen_tts', { name: '克隆甲', sample: WAV_BYTES, mime: 'audio/wav' }))) === 'dup_name', '拦截族：重名 → dup_name（唯一约束在落库阶段暴露）')
      check(
        reqs.filter((r) => r.url.includes('/customization')).length === 2,
        '前置拦截零外发：除重名（唯一约束需真插入才能触发）外，6 项校验均未调供应商端点',
      )
      check((await listVoiceClones()).length === before, '拦截族零副作用（失败不脏表）')

      // ---- 供应商错误族 ----
      enrollNext = () => ({ status: 500, json: { code: 'InvalidParameter', message: 'audio sample unreachable' } })
      const eHttp = (await errOf(() => createVoiceClone('aliyun_qwen_tts', { name: '丙', sample: WAV_BYTES, mime: 'audio/wav' }))) as {
        code?: string
        status?: number
        message?: string
      } | null
      check(eHttp?.code === 'clone_failed' && eHttp?.status === 502, `非 2xx → clone_failed 502（实际 ${String(eHttp?.code)}/${String(eHttp?.status)}）`)
      check(/InvalidParameter/.test(String(eHttp?.message)) && /audio sample unreachable/.test(String(eHttp?.message)), `错误体详情透传（${String(eHttp?.message)}）`)
      check((await listVoiceClones()).length === before, '供应商失败不落行（克隆与入库同生同灭）')
      enrollNext = () => ({ status: 200, json: {} })
      const eNoVoice = (await errOf(() => createVoiceClone('aliyun_qwen_tts', { name: '丙', sample: WAV_BYTES, mime: 'audio/wav' }))) as {
        code?: string
        status?: number
      } | null
      check(eNoVoice?.code === 'clone_no_voice', '2xx 但无音色标识 → clone_no_voice（不造空 voice 脏行）')
      enrollNext = () => ({ status: 200, json: { output: { voice_id: 'cosy-vc-2' } } })

      // ---- 公网 URL 协议（voice-enrollment）----
      check((await codeOf(() => createVoiceClone('aliyun_qwen_tts', { name: '乙', sample: WAV_BYTES, mime: 'audio/wav', protocol: 'dashscope-enrollment' }))) === 'bad_sample_transport', '公网协议下传本地样本 → bad_sample_transport（不误当 url）')
      check((await codeOf(() => createVoiceClone('aliyun_qwen_tts', { name: '乙', sampleUrl: 'ftp://a/b.wav', protocol: 'dashscope-enrollment' }))) === 'bad_sample_url', '公网协议下非 http(s) 地址 → bad_sample_url')
      const pub = await createVoiceClone('aliyun_qwen_tts', {
        name: 'Cosy Public',
        sampleUrl: 'https://cdn.example.com/a.wav',
        protocol: 'dashscope-enrollment',
        targetModel: 'cosyvoice-v3.5-flash',
      })
      cloneB = pub.clone
      const enroll2 = reqs.filter((r) => r.url.includes('/customization')).at(-1)!
      check(enroll2.body.model === 'voice-enrollment' && (enroll2.body.input as Record<string, unknown>).url === 'https://cdn.example.com/a.wav', '公网协议 body 快照：model=voice-enrollment + input.url 直传地址')
      check(cloneB.model === 'cosyvoice-v3.5-flash' && cloneB.voiceId === 'cosy-vc-2', `公网协议落行：model 取传入目标、voice_id 取 output.voice_id（${cloneB.model} / ${cloneB.voiceId}）`)
      check((await listVoiceClones()).length === 2 && (await loadCloneIndex()).size === 2, '音色库 2 行全部 ready → 声线链索引同步')

      // ---- [P8] resolveVoiceChain：旧调用签名逐字不变（probe-m3 断言口径）+ clone 各级命中 / 无效引用降级留痕 ----
      const rv1 = resolveVoiceChain({ lineVoice: 'L', charVoice: 'C', paramVoice: 'P', settingsVoice: 'S', instanceVoice: 'I' })
      check(rv1.voice === 'L' && rv1.source === 'line' && rv1.clone === null && rv1.cloneSkipped.length === 0, '旧签名：六级链首选 line，clone 字段全空（新增返回值不破坏既有消费方）')
      const rv2 = resolveVoiceChain({ lineVoice: '成年女声、清爽亲和', charVoice: 'C', instanceVoice: 'I' })
      check(rv2.voice === 'C' && rv2.source === 'character', '旧签名：语义短语级仍跳过 → 角色库令牌生效')
      const rv3 = resolveVoiceChain({})
      check(rv3.voice === 'alloy' && rv3.source === 'default' && rv3.cloneSkipped.length === 0, '旧签名：全空 → alloy/default 兜底不变')
      const rv4 = resolveVoiceChain({ charVoice: 'clone:901', paramVoice: 'P' })
      check(
        rv4.voice === 'P' && rv4.source === 'params' && rv4.clone === null && rv4.cloneSkipped.join() === 'character=clone:901',
        '旧签名（不传 cloneIndex）：clone 令牌不被原样下发（送供应商必 400）→ 记跳过并继续降级',
      )
      const rv5 = resolveVoiceChain({ lineVoice: 'clone:901', charVoice: 'C', cloneIndex: fakeIdx })
      check(rv5.voice === 'vc-901' && rv5.source === 'line' && rv5.clone?.id === 901, 'clone 命中（line 级）：voice 换供应商音色标识 + 随行返回供调用方换端点')
      const rv6 = resolveVoiceChain({ lineVoice: 'clone:99999', charVoice: 'clone:901', cloneIndex: fakeIdx })
      check(
        rv6.voice === 'vc-901' && rv6.source === 'character' && rv6.cloneSkipped.join() === 'line=clone:99999',
        '无效引用（音色库无此行）→ 跳过该级继续降级并留痕',
      )
      const rv7 = resolveVoiceChain({ lineVoice: 'clone:99999', cloneIndex: fakeIdx })
      check(rv7.voice === 'alloy' && rv7.source === 'default' && rv7.cloneSkipped.length === 1, '全链仅无效 clone 令牌 → alloy 兜底（不抛错，不中断整步配音）')

      // ---- [P8] cloneEndpoint：provider 换端点 + 模型联动（克隆与合成必须同模型）----
      const epCache = new Map<string, Awaited<ReturnType<typeof cloneEndpoint>>>()
      const epA = await cloneEndpoint(cloneA, epCache)
      check(epA.providerKey === 'aliyun_qwen_tts' && epA.baseUrl === 'http://probe-clone.local/api/v1', `cloneEndpoint 按克隆行换 provider 端点（${epA.baseUrl}）`)
      check(epA.model === cloneA.model && epA.model !== 'qwen-tts', `cloneEndpoint 覆盖 model 为克隆绑定模型（${epA.model}；实例原值 qwen-tts 被替换）`)
      const epA2 = await cloneEndpoint(cloneA, epCache)
      check(epCache.size === 1 && epA2.model === cloneA.model, '同 provider+模型复用缓存（一次查库，多句配音不重复解析）')
      const epB = await cloneEndpoint(cloneB, epCache)
      check(epCache.size === 2 && epB.model === 'cosyvoice-v3.5-flash', '同 provider 不同目标模型 → 各自缓存条目（模型串味即失效）')

      // ---- [P8] synthWithClone：试听文本上限 + 三元组下发 + 不落资产 ----
      const assetsBefore = (await db.select().from(assets)).length
      check((await codeOf(() => synthWithClone(cloneA, '   '))) === 'bad_text', '试听拦截：空白文本 → bad_text')
      check(
        (await codeOf(() => synthWithClone(cloneA, '啊'.repeat(CLONE_TEST_MAX_CHARS + 1)))) === 'bad_text',
        `试听拦截：超 ${CLONE_TEST_MAX_CHARS} 字 → bad_text（spec §2.2 ⑧）`,
      )
      reqs.length = 0
      const audioA = await synthWithClone(cloneA, '这是一段克隆音色试听。')
      const sreq = reqs[0]!
      check(audioA.byteLength > 0 && reqs.length === 1, `试听产出 mp3 字节（${audioA.byteLength} 字节，单次请求）`)
      check(
        sreq.url.includes('/services/aigc/multimodal-generation/generation') &&
          sreq.body.model === cloneA.model &&
          (sreq.body.input as Record<string, unknown>).voice === cloneA.voiceId,
        '试听请求三元组：克隆 provider 端点 + 克隆模型 + 供应商音色标识',
      )
      check((await db.select().from(assets)).length === assetsBefore, '试听不落资产（不污染素材库与用量）')

      // ---- [P8] tts 真步集成：角色库 clone:{id} → 换端点/模型/voice + 溯源 + 日志（fetch stub 零外发）----
      const { createStepContext } = await import('../src/pipeline/context')
      const { writeTextAsset } = await import('../src/services/storage')
      const { RUN_LOGS_DIR } = await import('../src/env')
      const { tts } = await import('../src/pipeline/actions/tts')
      const pidC = await mkProject('M19 声音克隆项目')
      await upsertEntity({ projectId: pidC, kind: 'character', name: '克隆童声', appearance: '圆脸大眼，虎头帽', voice: `clone:${cloneA.id}` })
      await upsertEntity({ projectId: pidC, kind: 'character', name: '普通女声', appearance: '长发，白衬衫', voice: 'Cherry' })
      const runC = (
        await db
          .insert(pipelineRuns)
          .values({ projectId: pidC, templateKey: 'mengbao-episode', status: 'running', input: '{}', createdAt: T0, updatedAt: T0 })
          .returning()
      )[0]!
      const stepC = (
        await db
          .insert(pipelineSteps)
          .values({ runId: runC.id, seq: 1, stepKey: 'gen_voice', actionKey: 'tts', title: 'gen_voice', status: 'running', createdAt: T0, updatedAt: T0 })
          .returning()
      )[0]!
      const defC = { key: 'gen_voice', action: 'tts', title: 'gen_voice', inputs: {}, params: {} }
      const linesAsset = await writeTextAsset(pidC, {
        name: 'lines.json',
        content: JSON.stringify({
          lines: [
            { id: 'l1', speaker: '克隆童声', text: '第一句：我回来啦' },
            { id: 'l2', speaker: '普通女声', text: '第二句：欢迎回家' },
            { id: 'l3', speaker: '路人角色', text: '第三句：今天天气不错', voice_hint: 'clone:99999' },
          ],
        }),
        purpose: 'lines',
        format: 'json',
        stepId: stepC.id,
        runId: runC.id,
      })
      const ctxC = await createStepContext({
        run: runC,
        step: stepC,
        template: { key: 'probe-m19-voice', version: 1, name: '探针', genre: 'other', inputs: [], steps: [defC] },
        def: defC,
        input: { lines: [linesAsset.id] },
        projectSettings: {},
      })
      reqs.length = 0
      const resC = await tts(ctxC)
      check(resC.assetIds.length === 3, `tts 全链执行完成（${resC.assetIds.length}/3 句，stub 端点零外发）`)
      const synthOpenai = reqs.filter((r) => r.url.includes('/audio/speech'))
      const synthAliyun = reqs.filter((r) => r.url.includes('/multimodal-generation'))
      check(
        synthOpenai.length === 2 && synthAliyun.length === 1,
        `双 provider 派发（openai ${synthOpenai.length} 句 / aliyun ${synthAliyun.length} 句）——同一步内按句换端点`,
      )
      const areq = synthAliyun[0]!
      check(areq.body.model === cloneA.model && (areq.body.input as Record<string, unknown>).voice === cloneA.voiceId, '命中克隆句：下发 model/voice 均为克隆行值（不是 clone:N 令牌）')
      check(
        synthOpenai.map((r) => String((r.body as Record<string, unknown>).voice ?? '')).join(',') === 'Cherry,InstanceVoice',
        '非克隆句照旧走默认 audio 实例（角色令牌 / 实例 extra.voice 逐级生效）',
      )
      const voiceAssets = (await db.select().from(assets)).filter((a) => a.purpose === 'voice' && a.runId === runC.id)
      const vpOf = (lineId: string): Record<string, unknown> =>
        JSON.parse(voiceAssets.find((a) => (JSON.parse(a.params ?? '{}') as { lineId?: string }).lineId === lineId)?.params ?? '{}') as Record<string, unknown>
      const vp1 = vpOf('l1')
      check(
        vp1.voiceSource === 'clone' &&
          vp1.clone_id === cloneA.id &&
          vp1.clone_name === cloneA.name &&
          vp1.clone_level === 'character' &&
          vp1.model === cloneA.model &&
          vp1.provider === 'aliyun_qwen_tts',
        '溯源入 asset.params：voiceSource=clone + clone_id/clone_name/clone_level + 实际 model/provider',
      )
      check(vp1.voice === cloneA.voiceId, 'params.voice 记真实下发音色（可复现可替换）')
      const vp3 = vpOf('l3')
      check(
        vp3.voiceSource === 'instance' && vp3.clone_id === null && vp3.clone_level === null && vp3.voiceHint === 'clone:99999',
        '无效引用句：按实际下发级记 source、clone_* 置空、voiceHint 原样留痕（可审计）',
      )
      const usC = await db.select().from(usageRecords).where(eq(usageRecords.projectId, pidC))
      check(
        usC.length === 3 && usC.filter((u) => u.provider === 'aliyun_qwen_tts' && u.model === cloneA.model).length === 1,
        `用量逐句记录且按克隆 provider/模型归口（${usC.length} 行）`,
      )
      const logTxtC = existsSync(join(RUN_LOGS_DIR, `${runC.id}.log`)) ? readFileSync(join(RUN_LOGS_DIR, `${runC.id}.log`), 'utf8') : ''
      check(logTxtC.includes('音色库 2 个克隆音色可引用 clone:{id}'), '步日志：音色库规模提示（仅 ready 行 ≥1 时输出，无克隆行时旧日志逐字不变）')
      check(logTxtC.includes('克隆音色引用未命中（line=clone:99999）'), '步日志：无效引用跳过留痕（spec §5 验收口径）')

      // ---- [P8] deleteVoiceClone + 删除后存量引用自动降级 ----
      check((await codeOf(() => deleteVoiceClone(0))) === 'bad_id', '删除拦截：非正整数 id → bad_id')
      const eDel = (await errOf(() => deleteVoiceClone(99999))) as { code?: string; status?: number } | null
      check(eDel?.code === 'not_found' && eDel?.status === 404, '删除：查无此行 → not_found 404')
      const delA = await deleteVoiceClone(cloneA.id)
      check(delA.name === cloneA.name && (await loadCloneIndex()).size === 1, '删除成功 → 音色库与声线链索引同步缩减')
      const rv8 = resolveVoiceChain({ charVoice: `clone:${cloneA.id}`, cloneIndex: await loadCloneIndex() })
      check(rv8.voice === 'alloy' && rv8.cloneSkipped.join() === `character=clone:${cloneA.id}`, '删除后存量角色引用自动降级（不会误用已失效音色）')
      await deleteVoiceClone(cloneB.id)
      check((await listVoiceClones()).length === 0, '音色库收尾清空（探针不留行）')
    } finally {
      globalThis.fetch = origFetch
      await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, 'audio'))
      delete process.env.PROBE_M19_CLONE_KEY
    }
    check((await db.select().from(apiConfigs).where(eq(apiConfigs.serviceType, 'audio'))).length === 0, '集成段收尾清理 audio 端点与密钥环境变量（不污染后续节）')
  }

  // ================= 分发 =================

  const runners: Record<string, () => Promise<void>> = {
    'subtitle-style': sectionSubtitleStyle,
    'brand-watermark': sectionBrandWatermark,
    'intro-outro': sectionIntroOutro,
    sfx: sectionSfx,
    aspect: sectionAspect,
    'ref-gen': sectionRefGen,
    states: sectionStates,
    'voice-clone': sectionVoiceClone,
  }
  const arg = process.argv.find((a) => a.startsWith('--section='))
  const wanted = arg ? arg.slice('--section='.length) : 'all'
  if (wanted !== 'all' && !(SECTIONS as readonly string[]).includes(wanted)) {
    log.error(`未知 section：${wanted}（已实现：${SECTIONS.join(' / ')}；all = 全部）`)
    process.exitCode = 1
    return
  }

  try {
    for (const name of (wanted === 'all' ? SECTIONS : [wanted]) as readonly string[]) {
      console.log(`\n──── section: ${name} ────`)
      await runners[name]!()
    }
  } catch (err) {
    failed += 1
    console.error(`\n探针异常终止: ${(err as Error).stack ?? err}`)
  } finally {
    console.log(`\n==== M19 探针结果: ${failed > 0 ? `${failed} 项失败` : '全部通过'} ====`)
    try {
      sqlite.close() // 释放 db 连接（Windows 下句柄可能仍被 libsql 持有 → 失败不阻断）
    } catch {
      /* 已关闭或未初始化 */
    }
    try {
      rmSync(TMP, { recursive: true, force: true })
    } catch {
      console.log(`临时目录未完全清理（Windows libsql 句柄；下次运行自动清理）: ${TMP}`)
    }
    process.exitCode = failed > 0 ? 1 : 0
  }
}

void main()
