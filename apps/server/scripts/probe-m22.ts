/**
 * M22 探针（创作画布深化——编辑与保真）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m22.ts [--section=spec-fields|trash|schema]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录
 * （独立 studio.db + workspace），不触碰开发库（同 probe-m3~m21）。零网络、零计费：
 * 直测服务层函数与纯函数，不触发引擎执行与真实生成（multi-frame 全链用本地 ffmpeg
 * 生成 2s testsrc 测试视频——零网络零计费；缺 ffmpeg 自动 SKIP 全链仅留纯函数断言）。
 *
 * section（默认 all；P0 三节 + P1 两节 + P2 三节 + P3 三节）：
 *   spec-fields   [P0] compose 新字段归一化（align/subtitle/subtitleAssetId/burnSubtitles/fit）
 *   trash         [P0] settings.trash 策略解析 + selectExpiredCanvases 过期边界
 *   schema        [P0] canvas_groups.parent_id 列就绪 + 读写往返
 *   align         [P1] 音字对齐段计划 + compose 对齐链/烧录字幕快照 + SRT 纯函数
 *   refs          [P1] 参考保真：normalizePositiveIds/直通字段 + draft 参考边映射 + YAML 校验
 *   group-nest    [P2] 组嵌套：创建/装入/移组防环/子组提升/快照 parentId 往返
 *   snapshot-diff [P2] diff 纯函数（字段级/截断）+ branch 新画布重放映射
 *   fit           [P2] compose 归一链 pad/crop 二选一 + 零漂移
 *   copy-to       [P3] 跨画布复制：同项目直引 / 跨项目资产级联（copiedFrom 留痕/实体级联/run 跳过）+ 内边重映射
 *   export-svg    [P3] 布局图 SVG：xmlEscape/截断/色板/贝塞尔/组框嵌套 + 视口并集 + writeTextAsset(svg) 归位
 *   multi-frame   [P3] 均匀多帧：frameTimesOf 2–9 矩阵 + 真实 ffmpeg 全链（3 列网格 / 首帧兼容字段 / 换行）
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// 纯类型导入（编译期擦除，零运行时加载——不违背下方「src 模块动态加载」隔离纪律）
import type { CanvasDoc, CanvasDocGroup, CanvasDocNode } from '../src/services/creation/spec'
import type { CanvasSnapshotDoc } from '../src/services/creation/snapshots'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
// 清理历史残留：libsql 在 Windows 下不释放文件句柄（close 后仍 EBUSY）——本进程退出时 db 文件必留；
// 本次运行在创建自己的目录前清掉旧的（占用中则跳过，自动收敛为最多一份）。
const TMP_PREFIX = 'acs-probe-m22-'
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

const SECTIONS = [
  'spec-fields',
  'trash',
  'schema',
  'align',
  'refs',
  'group-nest',
  'snapshot-diff',
  'fit',
  'copy-to',
  'export-svg',
  'multi-frame',
] as const

async function main(): Promise<void> {
  // src 模块全部动态加载（环境变量已隔离）
  const { eq } = await import('drizzle-orm')
  const { db, initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')
  const { assets, canvasEdges, canvasGroups, canvasNodes, canvases, characters, projects } = await import('../src/db/schema')
  const { COMPOSE_FITS, SUBTITLE_MODES, parseNodeSpec } = await import('../src/services/creation/spec')
  const { TRASH_DEFAULTS, parseTrashPolicy, resolveTrashPolicy, selectExpiredCanvases } = await import('../src/services/trash-sweep')
  const { buildComposeArgs, escapeSubtitlePath, planAlignedSegments } = await import('../src/services/creation/gen/compose-args')
  const { buildSegmentSrt, parseSrtCues, retimeSrtCues } = await import('../src/services/creation/gen/subtitle')
  const { normalizePositiveIds } = await import('../src/pipeline/refs')
  const { collectSetRefAssetIds, shotFirstFrameOf } = await import('../src/pipeline/actions/ai-video')
  const { collectRefAssetIds } = await import('../src/pipeline/actions/ai-image')
  const { buildTemplateDraftYaml } = await import('../src/services/creation/draft')
  const { validateTemplateText } = await import('../src/pipeline/loader')
  const { createGroup, deleteGroup, GroupError, updateGroup } = await import('../src/services/creation/groups')
  const { clampDiffValue, diffSnapshotDocs } = await import('../src/services/creation/snapshot-diff')
  const { branchSnapshot, createSnapshot, restoreSnapshot } = await import('../src/services/creation/snapshots')
  const { buildCanvasDoc } = await import('../src/services/creation/doc')
  const { copyNodesToCanvas } = await import('../src/services/creation/copy-to')
  const { buildCanvasSvg, computeSvgGroupBoxes, svgBezier, svgNodeColor, truncTitle, xmlEscape } = await import(
    '../src/services/creation/export-svg'
  )
  const { extractNodeFrame, frameTimesOf, UNIFORM_FRAME_COUNT_RANGE } = await import('../src/services/creation/gen/frame')
  const { absPathOf, ensureProjectDirs, registerAsset, relPathOf, writeTextAsset } = await import('../src/services/storage')
  const { resolveFfmpeg } = await import('../src/services/ffmpeg')

  const log = createLogger('probe-m22')
  let failed = 0
  const check = (cond: boolean, msg: string): void => {
    if (cond) log.info(`  PASS  ${msg}`)
    else {
      failed += 1
      log.error(`  FAIL  ${msg}`)
    }
  }

  // ---- setup：隔离库 + 种子项目 ----
  await initDb()
  const T0 = 1_700_000_000_000
  const [proj] = await db
    .insert(projects)
    .values({ name: 'M22 探针项目', genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
    .returning()

  // ================= [P0] spec-fields：compose 新字段归一化 =================
  const sectionSpecFields = async (): Promise<void> => {
    const ok = parseNodeSpec({ genKind: 'compose', prompt: 'p', align: true, subtitle: 'asset', subtitleAssetId: 7, burnSubtitles: true, fit: 'crop' })
    check(
      ok.align === true && ok.subtitle === 'asset' && ok.subtitleAssetId === 7 && ok.burnSubtitles === true && ok.fit === 'crop',
      '五个新字段合法值全量通过',
    )

    const bare = parseNodeSpec({ genKind: 'compose' })
    check(
      bare.align === undefined && bare.subtitle === undefined && bare.subtitleAssetId === undefined && bare.burnSubtitles === undefined && bare.fit === undefined,
      '缺省不注入新字段（零漂移）',
    )

    const bad = (raw: unknown): boolean => {
      try {
        parseNodeSpec(raw)
        return false
      } catch {
        return true
      }
    }
    check(bad({ genKind: 'compose', subtitle: 'kling' }), 'subtitle 非法枚举被拒')
    check(bad({ genKind: 'compose', fit: 'stretch' }), 'fit 非法枚举被拒')
    check(bad({ genKind: 'compose', align: 'yes' }), 'align 非布尔被拒')
    check(bad({ genKind: 'compose', burnSubtitles: 1 }), 'burnSubtitles 非布尔被拒')
    check(bad({ genKind: 'compose', subtitleAssetId: 0 }), 'subtitleAssetId 非正整数被拒')
    check(bad({ genKind: 'compose', subtitleAssetId: 1.5 }), 'subtitleAssetId 小数被拒')
    check(SUBTITLE_MODES.join('|') === 'none|auto|asset' && COMPOSE_FITS.join('|') === 'pad|crop', '枚举常量序列符合 spec')
  }

  // ================= [P0] trash：策略解析 + 过期边界 =================
  const sectionTrash = async (): Promise<void> => {
    check(TRASH_DEFAULTS.retentionDays === 30 && TRASH_DEFAULTS.autoPurge === true, '内置缺省 = 30 天 + 自动开启')
    check(parseTrashPolicy(undefined).retentionDays === 30, '非对象输入 → 默认 30')
    check(parseTrashPolicy('broken').autoPurge === true, '坏 JSON 形态 → autoPurge 默认 true')
    check(parseTrashPolicy({ retentionDays: 0 }).retentionDays === 1, 'retentionDays=0 → clamp 到 1')
    check(parseTrashPolicy({ retentionDays: 999 }).retentionDays === 365, 'retentionDays=999 → clamp 到 365')
    check(parseTrashPolicy({ retentionDays: Number.NaN }).retentionDays === 30, 'NaN → 默认 30')
    check(parseTrashPolicy({ retentionDays: 'x' }).retentionDays === 30, '非法类型 → 默认 30')
    check(parseTrashPolicy({ autoPurge: false }).autoPurge === false, 'autoPurge=false 尊重')
    check((await resolveTrashPolicy()).retentionDays === 30, 'resolveTrashPolicy 空表缺省 = 30（settings 表就绪）')

    const DAY = 86_400_000
    const now = 1_800_000_000_000
    const rows = [
      { id: 1, deletedAt: null }, // 正常画布
      { id: 2, deletedAt: now - 31 * DAY }, // 过期（30 天）
      { id: 3, deletedAt: now - 30 * DAY }, // 恰 30 天 → 未过期（严格小于）
      { id: 4, deletedAt: now - 1000 }, // 刚删
    ]
    const ids30 = selectExpiredCanvases(rows, now, 30)
    check(ids30.length === 1 && ids30[0] === 2, '30 天：仅 31 天前软删者过期（null/恰边界/新删不选）')
    const ids1 = selectExpiredCanvases(rows, now, 1)
    check(ids1.length === 2 && ids1[0] === 2 && ids1[1] === 3, '1 天：31/30 天前过期；刚删（1000ms）不过期')
    const ids365 = selectExpiredCanvases([{ id: 5, deletedAt: now - 366 * DAY }], now, 365)
    check(ids365.length === 1 && ids365[0] === 5, '365 天：366 天前过期')
  }

  // ================= [P0] schema：parent_id 列就绪 + 读写往返 =================
  const sectionSchema = async (): Promise<void> => {
    const cols = await sqlite.execute("PRAGMA table_info('canvas_groups')")
    const names = new Set((cols.rows as unknown as Array<{ name: string }>).map((r) => r.name))
    check(names.has('parent_id'), 'canvas_groups.parent_id 列就绪（建表带列 / ensureColumn 双路径）')

    const [cv] = await db.insert(canvases).values({ projectId: proj!.id, name: 'M22 画布', createdAt: T0, updatedAt: T0 }).returning()
    const [g1] = await db.insert(canvasGroups).values({ canvasId: cv!.id, title: '父组', createdAt: T0 }).returning()
    const [g2] = await db.insert(canvasGroups).values({ canvasId: cv!.id, title: '子组', parentId: g1!.id, createdAt: T0 }).returning()
    check(g1!.parentId === null && g2!.parentId === g1!.id, '组嵌套读写往返（顶层 NULL / 子组指向父 id）')
  }

  // ================= [P1] align：音字对齐计划 + 合成链 + SRT 纯函数 =================
  const sectionAlign = async (): Promise<void> => {
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

  // ================= [P1] refs：参考保真（直通字段 + draft 映射） =================
  const sectionRefs = async (): Promise<void> => {
    check(normalizePositiveIds([3, [4, 'x', 6], 3, 0, -1, 2.5, [7]]).join(',') === '3,4,6,7', 'normalizePositiveIds：flatten + 正整数过滤 + 保序去重')
    check(normalizePositiveIds('5').length === 0 && normalizePositiveIds(undefined).length === 0, '非数组/缺失 → 空集')

    check(shotFirstFrameOf({ id: 's1', image_prompt: 'x', first_frame_asset_id: 5 }) === 5, 'shotFirstFrameOf：正整数有效')
    check(
      shotFirstFrameOf({ id: 's1', image_prompt: 'x', first_frame_asset_id: 0 }) === null &&
        shotFirstFrameOf({ id: 's1', image_prompt: 'x' }) === null &&
        shotFirstFrameOf({ id: 's1', image_prompt: 'x', first_frame_asset_id: 1.5 }) === null,
      'shotFirstFrameOf：0/缺失/小数 → null（回退 gen_frames）',
    )

    const emptyIdx = { characters: new Map(), scenes: new Map(), props: new Map() }
    check(collectRefAssetIds({ id: 's1', image_prompt: 'x', ref_asset_ids: [9, 3, 9] }, emptyIdx).join(',') === '9,3', 'ai_image：直通 ref_asset_ids 前插 + 去重')
    const setOut = collectSetRefAssetIds({ id: 's1', image_prompt: 'x', ref_asset_ids: [9, 3] }, new Map(), new Map())
    check(setOut.length === 0, 'ai_video：collectSetRefAssetIds 只含场景/道具（直通在调用点合并）')
    check(normalizePositiveIds([9, 3, 9, ...setOut]).join(',') === '9,3', 'ai_video：直通 + 场景/道具 合并保序去重')

    // draft：参考/首帧边映射（mkNode 补齐 CanvasDocNode 必填字段）
    const mkNode = (id: number, kind: CanvasDocNode['kind'], extra: Partial<CanvasDocNode>): CanvasDocNode => ({
      id,
      kind,
      x: 0,
      y: 0,
      title: `N${id}`,
      assetId: null,
      asset: null,
      spec: null,
      specError: null,
      status: null,
      latestTask: null,
      tasks: [],
      readiness: null,
      editCapability: null,
      canRun: null,
      canCancel: null,
      ...extra,
    })
    const imgNode = (id: number, assetId: number): CanvasDocNode =>
      mkNode(id, 'asset', {
        assetId,
        asset: { id: assetId, kind: 'image', purpose: null, name: '图', mime: 'image/png', width: null, height: null, duration: null, prompt: null, urls: { file: 'f', thumb: null } },
      })
    const doc: CanvasDoc = {
      canvas: { id: 9, projectId: 1, name: 'T', viewport: { x: 0, y: 0, zoom: 1 } },
      nodes: [
        imgNode(10, 100),
        mkNode(12, 'text', { spec: { text: '提示词' } }),
        mkNode(13, 'gen', { spec: { genKind: 'image', prompt: '首帧' } }),
        mkNode(11, 'gen', { spec: { genKind: 'video', prompt: '镜头' } }),
      ],
      edges: [
        { id: 1, from: 12, to: 11, port: 'prompt' },
        { id: 2, from: 10, to: 11, port: 'reference' },
        { id: 3, from: 13, to: 11, port: 'first_frame' },
      ],
      groups: [],
    }
    const r1 = buildTemplateDraftYaml(doc, 'probe-m22-draft')
    check(r1.yaml.includes('      refs:\n        - input.a10\n'), 'draft：reference 边（图片 asset 源）→ lit inputs.refs')
    check(r1.yaml.includes('      first_frame: steps.n13.asset\n'), 'draft：first_frame 边（image gen 源）→ lit inputs.first_frame')
    check(!r1.lossy.some((l) => l.includes('未映射')), 'draft：参考/首帧已映射 → 无 unmapped lossy 条目')
    const v = validateTemplateText(r1.yaml, 'probe-m22-draft')
    check(v.ok, `draft YAML 通过 loader 校验${v.ok ? '' : `：${v.errors.join('；')}`}`)

    const doc2: CanvasDoc = { ...doc, edges: [...doc.edges, { id: 4, from: 13, to: 11, port: 'last_frame' }] }
    const r2 = buildTemplateDraftYaml(doc2, 'probe-m22-draft2')
    check(r2.lossy.some((l) => l.includes('未映射')), 'draft：末帧边 → unmapped（lossy 汇总）')
  }

  // ================= [P2] group-nest：组嵌套（服务语义 + 快照兼容） =================
  const sectionGroupNest = async (): Promise<void> => {
    const [cv] = await db.insert(canvases).values({ projectId: proj!.id, name: 'M22 嵌套画布', createdAt: T0, updatedAt: T0 }).returning()
    const mkNode = async (title: string, x: number, y: number): Promise<{ id: number }> => {
      const [row] = await db
        .insert(canvasNodes)
        .values({ canvasId: cv!.id, kind: 'text', title, spec: '{"text":"t"}', x, y, createdAt: T0, updatedAt: T0 })
        .returning()
      return row!
    }
    const n1 = await mkNode('N1', 100, 200)
    const n2 = await mkNode('N2', 400, 200)
    const n3 = await mkNode('N3', 100, 600)
    const n4 = await mkNode('N4', 800, 200)
    const catchCode = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn()
        return 'no-error'
      } catch (err) {
        return err instanceof GroupError ? err.code : `other:${(err as Error).message}`
      }
    }

    const gA = await createGroup(cv!.id, { nodeIds: [n1.id, n2.id], title: 'A' })
    check(gA.parentId === null && gA.x === 100 && gA.y === 200, '顶层组：parentId=null + 锚点=节点包围盒左上')
    // 纯组装入（groupIds）：新组为父，已建组提升为子
    const gB = await createGroup(cv!.id, { groupIds: [gA.id], title: 'B' })
    const [gA2] = await db.select().from(canvasGroups).where(eq(canvasGroups.id, gA.id))
    check(gB.parentId === null && gA2!.parentId === gB.id, 'groupIds 装入：子组 parentId 指向新父组')
    check(gB.x === gA2!.x && gB.y === gA2!.y, '纯组锚点=子组锚点（无节点成员）')
    check((await catchCode(() => createGroup(cv!.id, { groupIds: [gA.id] }))) === 'group_already_nested', '已嵌套组再装入 → group_already_nested')
    check((await catchCode(() => createGroup(cv!.id, { groupIds: [999999] }))) === 'group_not_in_canvas', '子组不属画布 → group_not_in_canvas')
    check((await catchCode(() => createGroup(cv!.id, {}))) === 'bad_node_ids', 'nodeIds/groupIds 全空 → bad_node_ids')
    check((await catchCode(() => createGroup(cv!.id, { nodeIds: [n3.id], parentId: 999999 }))) === 'group_not_in_canvas', 'parentId 不存在 → group_not_in_canvas')
    const gC = await createGroup(cv!.id, { nodeIds: [n3.id], parentId: gB.id, title: 'C' })
    check(gC.parentId === gB.id, 'parentId 建组：直接嵌套其下')
    // 移组防环（自环 / 直接父子环 / 隔代后代环）与拓扑合法移入
    check((await catchCode(() => updateGroup(cv!.id, gB.id, { parentId: gB.id }))) === 'group_cycle', '自环：组移入自身 → group_cycle')
    check((await catchCode(() => updateGroup(cv!.id, gB.id, { parentId: gC.id }))) === 'group_cycle', '环：父组移入其直接子组 → group_cycle')
    check((await catchCode(() => updateGroup(cv!.id, gB.id, { parentId: gA.id }))) === 'group_cycle', '环：父组移入其后代组 → group_cycle')
    const movedC = await updateGroup(cv!.id, gC.id, { parentId: gA.id })
    check(movedC != null && movedC.parentId === gA.id, '正常移入：C → A（拓扑合法）')
    const liftedC = await updateGroup(cv!.id, gC.id, { parentId: null })
    check(liftedC != null && liftedC.parentId === null, '移出到顶层：parentId=null')
    check((await catchCode(() => updateGroup(cv!.id, gC.id, { parentId: 999999 }))) === 'group_not_in_canvas', '移入目标不存在 → group_not_in_canvas')
    // deleteGroup：子组提升（保守不丢组）
    await deleteGroup(cv!.id, gB.id)
    const [gA3] = await db.select().from(canvasGroups).where(eq(canvasGroups.id, gA.id))
    const gone = await db.select().from(canvasGroups).where(eq(canvasGroups.id, gB.id))
    check(gone.length === 0 && gA3!.parentId === null, 'deleteGroup：子组提升顶层（不丢组）')
    // 快照含 parentId 重放往返
    const gD = await createGroup(cv!.id, { nodeIds: [n4.id], parentId: gA.id, title: 'D' })
    const snap = await createSnapshot(cv!.id, '嵌套快照')
    await deleteGroup(cv!.id, gA.id)
    await restoreSnapshot(cv!.id, snap.id)
    const [gD2] = await db.select().from(canvasGroups).where(eq(canvasGroups.id, gD.id))
    const [gA4] = await db.select().from(canvasGroups).where(eq(canvasGroups.id, gA.id))
    const [n4After] = await db.select().from(canvasNodes).where(eq(canvasNodes.id, n4.id))
    check(gD2 != null && gD2.parentId === gA.id && gA4 != null && gA4.parentId === null, '快照恢复往返：嵌套关系（parentId）完整')
    check(n4After!.groupId === gD.id, '快照恢复：节点 groupId 归属恢复')
    // [M22 实弹补盲] buildCanvasDoc 输出 parentId（前端嵌套渲染读模型，doc.ts 投影曾漏列）
    const nestDoc = await buildCanvasDoc(cv!.id)
    const docGA = nestDoc?.groups.find((g) => g.id === gA.id)
    const docGD = nestDoc?.groups.find((g) => g.id === gD.id)
    check(docGA != null && docGA.parentId === null && docGD != null && docGD.parentId === gA.id, 'buildCanvasDoc：groups 输出含 parentId（嵌套读模型）')
  }

  // ================= [P2] snapshot-diff：diff 纯函数 + branch 重放映射 =================
  const sectionSnapshotDiff = async (): Promise<void> => {
    // ---- 纯函数 diff ----
    const row = (o: Record<string, unknown>): Record<string, unknown> => o
    const baseDoc = {
      nodes: [row({ id: 1, title: 'A', x: 0, spec: null }), row({ id: 2, title: 'B', x: 0, spec: null })],
      edges: [row({ id: 10, from: 1, to: 2, port: 'prompt' })],
      groups: [row({ id: 20, title: 'G', parentId: null })],
    } as unknown as CanvasSnapshotDoc
    const targetDoc = {
      nodes: [row({ id: 1, title: 'A2', x: 5, spec: null }), row({ id: 3, title: 'C', x: 0, spec: null })],
      edges: [row({ id: 10, from: 1, to: 3, port: 'prompt' })],
      groups: [],
    } as unknown as CanvasSnapshotDoc
    const diff = diffSnapshotDocs(baseDoc, targetDoc)
    check(
      diff.summary.nodes.added === 1 && diff.summary.nodes.removed === 1 && diff.summary.nodes.modified === 1 &&
        diff.summary.edges.modified === 1 && diff.summary.groups.removed === 1,
      'diff summary：nodes +1/−1/~1、edges ~1、groups −1',
    )
    check(diff.nodes.added[0]!.id === 3 && diff.nodes.added[0]!.title === 'C' && diff.nodes.removed[0]!.id === 2, 'added/removed 按 id 匹配（标题携带）')
    const modN = diff.nodes.modified[0]!
    check(
      modN.id === 1 && modN.changes.length === 2 &&
        modN.changes[0]!.field === 'title' && modN.changes[0]!.before === 'A' && modN.changes[0]!.after === 'A2' &&
        modN.changes[1]!.field === 'x' && modN.changes[1]!.before === 0 && modN.changes[1]!.after === 5,
      'modified：字段级 changes（title/x，按字段名排序）',
    )
    const modE = diff.edges.modified[0]!
    check(modE.changes.some((c) => c.field === 'to' && c.before === 2 && c.after === 3), 'edge modified：to 端点字段级')
    check(diff.groups.removed[0]!.title === 'G', 'group removed 标题取 title')
    const clipped = clampDiffValue('x'.repeat(250)) as string
    check(clipped.length === 201 && clipped.endsWith('…'), '截断：250 字符 → 200 + 省略号')
    check(typeof clampDiffValue({ a: 'y'.repeat(250) }) === 'string', '对象超长 → stringify 截断为字符串')
    check(JSON.stringify(clampDiffValue({ a: 1 })) === '{"a":1}', '对象未超长 → 保留结构')
    const d2 = diffSnapshotDocs(
      { nodes: [{ id: 9, title: 'x' }], edges: [], groups: [] } as unknown as CanvasSnapshotDoc,
      { nodes: [{ id: 9, title: 'x', spec: null }], edges: [], groups: [] } as unknown as CanvasSnapshotDoc,
    )
    check(d2.nodes.modified.length === 0, 'undefined vs null 视同（旧快照缺列不误报）')

    // ---- branch 重放（db 直测）----
    const [cv] = await db.insert(canvases).values({ projectId: proj!.id, name: 'M22 分支源', createdAt: T0, updatedAt: T0 }).returning()
    const [nb1] = await db
      .insert(canvasNodes)
      .values({ canvasId: cv!.id, kind: 'text', title: 'B1', spec: '{"text":"a"}', x: 0, y: 0, createdAt: T0, updatedAt: T0 })
      .returning()
    const [nb2] = await db
      .insert(canvasNodes)
      .values({ canvasId: cv!.id, kind: 'text', title: 'B2', spec: '{"text":"b"}', x: 0, y: 0, createdAt: T0, updatedAt: T0 })
      .returning()
    const gP = await createGroup(cv!.id, { nodeIds: [nb1!.id], title: 'P' })
    const gQ = await createGroup(cv!.id, { groupIds: [gP.id], title: 'Q' })
    await db.insert(canvasEdges).values({ canvasId: cv!.id, from: nb1!.id, to: nb2!.id, port: 'prompt', createdAt: T0 })
    const snap = await createSnapshot(cv!.id, '分支点')
    const branch = await branchSnapshot(cv!.id, snap.id, '分支画布')
    check(branch != null && branch.name === '分支画布' && branch.projectId === cv!.projectId, 'branch：新画布（同项目 + 指定名）')
    const nList = await db.select().from(canvasNodes).where(eq(canvasNodes.canvasId, branch!.id))
    const gList = await db.select().from(canvasGroups).where(eq(canvasGroups.canvasId, branch!.id))
    const eList = await db.select().from(canvasEdges).where(eq(canvasEdges.canvasId, branch!.id))
    check(nList.length === 2 && gList.length === 2 && eList.length === 1, 'branch：节点/组/边行数齐全')
    const b1 = nList.find((n) => n.title === 'B1')!
    const b2 = nList.find((n) => n.title === 'B2')!
    const pG = gList.find((g) => g.title === 'P')!
    const qG = gList.find((g) => g.title === 'Q')!
    check(pG.id !== gP.id && qG.id !== gQ.id && b1.id !== nb1!.id, 'branch：全新 id 空间（无源 id 复用）')
    check(pG.parentId === qG.id && qG.parentId === null, 'branch：parentId 映射（P → 新 Q）')
    check(b1.groupId === pG.id, 'branch：节点 groupId 映射')
    check(eList[0]!.from === b1.id && eList[0]!.to === b2.id && eList[0]!.port === 'prompt', 'branch：边端点映射')
    check(b1.spec === '{"text":"a"}', 'branch：spec 原样')
    const branch2 = await branchSnapshot(cv!.id, snap.id)
    check(branch2 != null && branch2.name === 'M22 分支源 分支', 'branch：缺省名「{源名} 分支」')
    check((await branchSnapshot(cv!.id, 999999)) === null, 'branch：快照不存在 → null')
  }

  // ================= [P2] fit：归一链二选一 =================
  const sectionFit = async (): Promise<void> => {
    const fcOf = (args: string[]): string => args[args.indexOf('-filter_complex') + 1] ?? ''
    const base = { videoPaths: ['v1.mp4', 'v2.mp4'], audioPaths: [], outPath: 'o.mp4', size: { width: 1080, height: 1920 } }
    const fcCrop = fcOf(buildComposeArgs({ ...base, fit: 'crop' }))
    check(
      fcCrop.includes('scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1') && !fcCrop.includes('pad='),
      'crop：scale increase + crop + setsar（无 pad）',
    )
    const fcPad = fcOf(buildComposeArgs(base))
    check(
      fcPad.includes('scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1') && !fcPad.includes('crop='),
      'pad 缺省：信箱链逐字不变（零漂移）',
    )
    check(fcOf(buildComposeArgs({ ...base, fit: 'pad' })) === fcPad, "显式 fit='pad' 与缺省一致")
    check(fcOf(buildComposeArgs({ ...base, fit: 'crop', fps: 30 })).includes('crop=1080:1920,setsar=1,fps=30'), 'crop 链 + fps 后缀')
  }

  // ================= [P3] copy-to：跨画布复制（同项目直引 / 跨项目级联拷贝） =================
  const sectionCopyTo = async (): Promise<void> => {
    const [projS] = await db
      .insert(projects)
      .values({ name: 'M22 复制源项目', genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
      .returning()
    const [projD] = await db
      .insert(projects)
      .values({ name: 'M22 复制目标项目', genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
      .returning()
    const mkCanvas = async (pid: number, name: string): Promise<typeof canvases.$inferSelect> =>
      (await db.insert(canvases).values({ projectId: pid, name, createdAt: T0, updatedAt: T0 }).returning())[0]!
    const mkNode = async (canvasId: number, extra: Partial<typeof canvasNodes.$inferInsert>): Promise<typeof canvasNodes.$inferSelect> =>
      (await db
        .insert(canvasNodes)
        .values({ canvasId, kind: 'text', title: 'N', spec: '{"text":"t"}', x: 0, y: 0, createdAt: T0, updatedAt: T0, ...extra })
        .returning())[0]!

    // ---- 同项目：直接引用（零拷贝） ----
    const s1 = await mkCanvas(projS!.id, '同项目源')
    const s2 = await mkCanvas(projS!.id, '同项目目标')
    const tG = await mkNode(s1.id, { kind: 'text', title: '文本', spec: '{"text":"hello"}', x: 100, y: 200 })
    const aG = await mkNode(s1.id, { kind: 'asset', title: '素材', assetId: 555, x: 400, y: 200 })
    const gG = await mkNode(s1.id, {
      kind: 'gen',
      title: '生成',
      spec: JSON.stringify({ genKind: 'video', prompt: 'p', bgmAssetId: 555 }),
      x: 700,
      y: 200,
      adoptedTaskId: 42,
    })
    const [grpS] = await db.insert(canvasGroups).values({ canvasId: s1.id, title: 'G', createdAt: T0 }).returning()
    await db.update(canvasNodes).set({ groupId: grpS!.id }).where(eq(canvasNodes.id, tG.id))
    await db.insert(canvasEdges).values({ canvasId: s1.id, from: tG.id, to: gG.id, port: 'prompt', createdAt: T0 })

    const r1 = await copyNodesToCanvas(s1, s2, [tG.id, aG.id, gG.id], { x: 10, y: 20 })
    check(
      r1.nodes.length === 3 && r1.edges.length === 1 && r1.assetsCopied === 0 && r1.skipped.length === 0 && r1.warnings.length === 0,
      '同项目：3 节点 + 1 内边 / 零资产拷贝 / 零跳过零警告',
    )
    const cTxt = r1.nodes[0]!
    const cAs1 = r1.nodes[1]!
    const cGen1 = r1.nodes[2]!
    check(cTxt.x === 110 && cTxt.y === 220 && cTxt.groupId === null, '同项目：偏移生效 + groupId 不拷贝')
    check(cTxt.spec === '{"text":"hello"}' && cAs1.assetId === 555 && cGen1.adoptedTaskId === 42, '同项目：spec/资产引用/adoptedTaskId 原样（直接引用）')
    check((JSON.parse(cGen1.spec!) as { bgmAssetId?: number }).bgmAssetId === 555, '同项目：gen 内联资产引用原样')
    check(r1.edges[0]!.from === cTxt.id && r1.edges[0]!.to === cGen1.id && r1.edges[0]!.canvasId === s2.id, '同项目：内边重映射到新 id（目标画布域）')

    // ---- 跨项目：级联拷贝（真实文件字节级；本地写盘零网络） ----
    ensureProjectDirs(projS!.id)
    const vRel = relPathOf(projS!.id, 'creation_video', 'copy-src.mp4')
    writeFileSync(absPathOf(vRel), Buffer.from('M22-COPY-BYTES-0123456789'))
    const x1 = await registerAsset(projS!.id, {
      name: '视频X1.mp4',
      kind: 'video',
      purpose: 'creation_video',
      relPath: vRel,
      mime: 'video/mp4',
      ext: 'mp4',
      fileSize: 25,
      duration: 2,
      params: { foo: 'bar' },
      tags: ['t1'],
    })
    const iRel = relPathOf(projS!.id, 'creation_image', 'copy-ref.png')
    writeFileSync(absPathOf(iRel), Buffer.from('M22-REF-IMG-BYTES'))
    const x2 = await registerAsset(projS!.id, {
      name: '参考X2.png',
      kind: 'image',
      purpose: 'creation_image',
      relPath: iRel,
      mime: 'image/png',
      ext: 'png',
      fileSize: 16,
    })
    const [entS] = await db
      .insert(characters)
      .values({ projectId: projS!.id, kind: 'character', name: '实体E1', refAssetIds: JSON.stringify([x1.id, x2.id]), createdAt: T0, updatedAt: T0 })
      .returning()

    const s3 = await mkCanvas(projS!.id, '跨项目源')
    const d1 = await mkCanvas(projD!.id, '跨项目目标')
    const nAs = await mkNode(s3.id, { kind: 'asset', title: '素材X', assetId: x1.id, x: 100, y: 100 })
    const nGen = await mkNode(s3.id, {
      kind: 'gen',
      title: '合成X',
      x: 400,
      y: 100,
      adoptedTaskId: 77,
      spec: JSON.stringify({ genKind: 'compose', prompt: 'p', bgmAssetId: x1.id, subtitleAssetId: x2.id, align: true }),
    })
    const nEnt = await mkNode(s3.id, { kind: 'entity', title: '实体X', spec: JSON.stringify({ entityId: entS!.id }), x: 700, y: 100 })
    const nBad = await mkNode(s3.id, { kind: 'gen', title: '坏spec', spec: 'not-json', x: 1000, y: 100 })
    const nRun = await mkNode(s3.id, { kind: 'run', title: '运行X', spec: '{"runId":9}', x: 1300, y: 100 })
    const nMis = await mkNode(s3.id, { kind: 'asset', title: '缺资产', assetId: 999999, x: 1600, y: 100 })
    await db.insert(canvasEdges).values({ canvasId: s3.id, from: nAs.id, to: nGen.id, port: 'reference', createdAt: T0 })

    const r2 = await copyNodesToCanvas(s3, d1, [nAs.id, nGen.id, nEnt.id, nBad.id, nRun.id, nMis.id], null)
    check(
      r2.nodes.length === 4 && r2.skipped.length === 2 && r2.warnings.length === 1 && r2.warnings[0]!.includes('#999999'),
      '跨项目：复制 4（asset/gen/entity/坏spec）/ 跳过 2（run/缺资产）/ 警告 1（缺失留痕）',
    )
    check(
      r2.skipped.some((s) => s.nodeId === nRun.id && s.reason === 'cross_project_run_node') &&
        r2.skipped.some((s) => s.nodeId === nMis.id && s.reason === 'missing_asset'),
      '跳过原因：cross_project_run_node / missing_asset',
    )
    check(r2.assetsCopied === 2, '资产去重拷贝：X1 双引用仅一行（asset 节点 + bgm 共享）+ X2 一行 = 2')
    const cAs2 = r2.nodes.find((n) => n.title === '素材X')!
    const cGen2 = r2.nodes.find((n) => n.title === '合成X')!
    const cEnt2 = r2.nodes.find((n) => n.title === '实体X')!
    const cBad2 = r2.nodes.find((n) => n.title === '坏spec')!
    check(cAs2.assetId != null && cAs2.assetId !== x1.id && cAs2.x === 140 && cAs2.y === 140, '跨项目：asset 节点指向新资产 + 缺省偏移 +40,+40')
    check(cGen2.adoptedTaskId === null, '跨项目：adoptedTaskId 置空（任务归属不迁移）')
    const gSpec = JSON.parse(cGen2.spec!) as { bgmAssetId?: number; subtitleAssetId?: number; prompt?: string; align?: boolean }
    check(gSpec.bgmAssetId === cAs2.assetId, '跨项目：gen bgm 引用重写（与 asset 节点共享同一拷贝）')
    check(gSpec.subtitleAssetId != null && gSpec.subtitleAssetId !== x2.id, '跨项目：gen subtitle 引用重写为 X2 拷贝')
    check(gSpec.prompt === 'p' && gSpec.align === true, '跨项目：gen 其余字段保真')
    check(cBad2.spec === 'not-json', '跨项目：坏 spec 原样保真')
    check(r2.edges.length === 1 && r2.edges[0]!.from === cAs2.id && r2.edges[0]!.to === cGen2.id, '跨项目：内边端点重映射')

    const newAssets = await db.select().from(assets).where(eq(assets.projectId, projD!.id))
    check(newAssets.length === 2, '目标项目落库 2 行新资产')
    const cpX1 = newAssets.find((a) => a.name === '视频X1.mp4')!
    const paramsX1 = JSON.parse(cpX1.params ?? '{}') as { foo?: string; copiedFrom?: { projectId?: number; assetId?: number } }
    check(
      paramsX1.copiedFrom?.projectId === projS!.id && paramsX1.copiedFrom?.assetId === x1.id && paramsX1.foo === 'bar',
      'copiedFrom 留痕 + 原 params 保留',
    )
    check(cpX1.mime === 'video/mp4' && cpX1.ext === 'mp4' && cpX1.duration === 2 && JSON.parse(cpX1.tags ?? '[]').join(',') === 't1', '资产元数据保真（mime/ext/duration/tags）')
    check(cpX1.relPath != null && readFileSync(absPathOf(cpX1.relPath), 'utf8') === 'M22-COPY-BYTES-0123456789', '资产文件字节级拷贝（新落盘路径可读）')

    const newChars = await db.select().from(characters).where(eq(characters.projectId, projD!.id))
    check(newChars.length === 1 && newChars[0]!.id !== entS!.id && newChars[0]!.name === '实体E1', '实体级联：characters 新行（目标项目，新 id）')
    const newRefIds = JSON.parse(newChars[0]!.refAssetIds) as number[]
    check(newRefIds.length === 2 && !newRefIds.includes(x1.id) && !newRefIds.includes(x2.id), '实体 refAssetIds 逐张重写为拷贝 id')
    check((JSON.parse(cEnt2.spec!) as { entityId?: number }).entityId === newChars[0]!.id, 'entity 节点 spec.entityId 重写指向新实体')

    // ---- 自复制防护 ----
    let selfErr = ''
    try {
      await copyNodesToCanvas(d1, d1, [nAs.id], null)
    } catch (err) {
      selfErr = (err as Error).message
    }
    check(selfErr.includes('目标画布不能与源画布相同'), 'src=target → 抛错（同画布复制请用 /nodes/copy）')
  }

  // ================= [P3] export-svg：布局图 SVG（纯函数矩阵 + 组框嵌套 + 存储归位） =================
  const sectionExportSvg = async (): Promise<void> => {
    // ---- 纯函数矩阵 ----
    check(xmlEscape(`<a & b> "c" 'd'`) === '&lt;a &amp; b&gt; &quot;c&quot; &apos;d&apos;', 'xmlEscape：五类字符全转义')
    check(truncTitle('x'.repeat(16)) === 'x'.repeat(16) && truncTitle('x'.repeat(17)) === `${'x'.repeat(16)}…`, '标题截断：16 内原样 / 17 截 16 + …')
    check(svgBezier(0, 0, 100, 50) === 'M 0 0 C 50 0, 50 50, 100 50', '贝塞尔：dx=|Δx|/2（远距）')
    check(svgBezier(0, 0, 10, 10) === 'M 0 0 C 48 0, -38 10, 10 10', '贝塞尔：dx=48 下限（近距/回连）')
    check(svgNodeColor({ kind: 'gen', spec: { genKind: 'video', prompt: 'p' } }) === '#3b82f6', '色板：gen video → 蓝')
    check(
      svgNodeColor({ kind: 'gen', spec: { genKind: 'zzz', prompt: 'p' } as unknown as CanvasDocNode['spec'] }) === '#8b5cf6' &&
        svgNodeColor({ kind: 'gen', spec: null }) === '#8b5cf6',
      '色板：未知/缺 genKind → 默认（image 紫）',
    )
    check(svgNodeColor({ kind: 'asset', spec: null }) === '#64748b' && svgNodeColor({ kind: 'run', spec: null }) === '#ef4444', '色板：asset 灰 / run 红')

    // ---- 组框：嵌套包围盒 + depth 排序 + 空组退化 ----
    const mkDocNode = (id: number, kind: CanvasDocNode['kind'], x: number, y: number, extra: Partial<CanvasDocNode> = {}): CanvasDocNode => ({
      id,
      kind,
      x,
      y,
      title: `N${id}`,
      groupId: null,
      assetId: null,
      asset: null,
      spec: null,
      specError: null,
      status: null,
      latestTask: null,
      tasks: [],
      readiness: null,
      editCapability: null,
      canRun: null,
      canCancel: null,
      ...extra,
    })
    const gp: CanvasDocGroup = { id: 101, title: '父组P', color: 'blue', collapsed: false, x: 0, y: 0, parentId: null }
    const ga: CanvasDocGroup = { id: 102, title: '组A', color: null, collapsed: false, x: 0, y: 0, parentId: 101 }
    const gb: CanvasDocGroup = { id: 103, title: '组B', color: 'green', collapsed: false, x: 0, y: 0, parentId: 101 }
    const ge: CanvasDocGroup = { id: 104, title: '空组', color: null, collapsed: false, x: 2000, y: 300, parentId: 101 }
    const dN1 = mkDocNode(1, 'asset', 100, 200, { groupId: ga.id, title: '<A&B "q">' })
    const dN2 = mkDocNode(2, 'gen', 400, 200, { groupId: ga.id, spec: { genKind: 'video', prompt: 'p' }, title: 'x'.repeat(20) })
    const dN3 = mkDocNode(3, 'text', 100, 600, { groupId: gb.id, spec: { text: 't' } })
    const boxes = computeSvgGroupBoxes([dN1, dN2, dN3], [gp, ga, gb, ge])
    check(
      boxes.length === 4 && boxes[0]!.id === gp.id && boxes[1]!.id === ga.id && boxes[2]!.id === gb.id && boxes[3]!.id === ge.id,
      '组框：depth 升序（父先）+ 同层按 id',
    )
    check(boxes[0]!.depth === 0 && boxes[1]!.depth === 1, '组框：深度标注（0 父 / 1 子）')
    const boxA = boxes[1]!
    check(boxA.x === 88 && boxA.y === 166 && boxA.w === 544 && boxA.h === 186, '组框：包围盒公式（x−12 / y−34 / w+24 / h+46）')
    check(boxes[3]!.x === 2000 && boxes[3]!.y === 300 && boxes[3]!.w === 220 && boxes[3]!.h === 120, '空组退化：存储坐标 + 220×120')

    // ---- 主函数：视口并集 + 渲染结构 ----
    const docS: CanvasDoc = {
      canvas: { id: 1, projectId: 1, name: '导出', viewport: { x: 0, y: 0, zoom: 1 } },
      nodes: [dN1, dN2, dN3],
      edges: [
        { id: 1, from: dN1.id, to: dN2.id, port: 'reference' },
        { id: 2, from: dN2.id, to: 999, port: 'prompt' },
      ],
      groups: [gp, ga, gb, ge],
    }
    const svg = buildCanvasSvg(docS)
    check(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && svg.endsWith('</svg>'), 'SVG 根元素开闭')
    check((svg.match(/rx="8"/g) ?? []).length === 3, '节点卡 rect 数 = 节点数（rx=8 唯一标识）')
    check((svg.match(/rx="12"/g) ?? []).length === 4, '组框 rect 数 = 组数（rx=12）')
    check((svg.match(/marker-end="url\(#m22-arrow\)"/g) ?? []).length === 1, '边 path 数 = 端点齐全边数（悬空边跳过）')
    check(svg.includes('&lt;A&amp;B &quot;q&quot;&gt;') && !svg.includes('<A&B'), '节点标题 XML 转义')
    check(svg.includes(`${'x'.repeat(16)}…`), '长标题截断入图')
    check(svg.includes('M 320 270 C 368 270, 352 270, 400 270'), '边几何：源右中 → 目标左中（dx=48 下限）')
    const svgEmpty = buildCanvasSvg({ canvas: { id: 2, projectId: 1, name: '空', viewport: { x: 0, y: 0, zoom: 1 } }, nodes: [], edges: [], groups: [] })
    check(svgEmpty.includes('width="980" height="720" viewBox="-40 -40 980 720"'), '空画布：兜底视口 900×640 + 40 padding')
    const svgFar = buildCanvasSvg({
      canvas: { id: 3, projectId: 1, name: '远', viewport: { x: 0, y: 0, zoom: 1 } },
      nodes: [mkDocNode(9, 'text', 1000, 100, { spec: { text: 't' } })],
      edges: [],
      groups: [],
    })
    check(svgFar.includes('width="1300" height="720" viewBox="-40 -40 1300 720"'), '视口并集：右超出节点（1000+220 → 1220 + 40×2）')

    // ---- 存储归位：writeTextAsset(svg) ----
    const [projE] = await db
      .insert(projects)
      .values({ name: 'M22 导出项目', genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
      .returning()
    const w = await writeTextAsset(projE!.id, { name: '布局图.svg', content: svg, purpose: 'creation_svg', format: 'svg', params: { canvasId: 1 } })
    check(w.kind === 'text' && w.mime === 'image/svg+xml' && w.ext === 'svg', 'writeTextAsset(svg)：mime/ext 就位')
    check((w.relPath ?? '').includes('exports'), 'svg 归位 exports 子目录')
    check(w.relPath != null && readFileSync(absPathOf(w.relPath), 'utf8') === svg, 'svg 全文落盘往返一致')
  }

  // ================= [P3] multi-frame：均匀多帧（纯函数矩阵 + 真实 ffmpeg 全链） =================
  const sectionMultiFrame = async (): Promise<void> => {
    check(UNIFORM_FRAME_COUNT_RANGE.lo === 2 && UNIFORM_FRAME_COUNT_RANGE.hi === 9, 'count 范围常量 2–9')
    check(frameTimesOf('uniform', null, 3, 10).join(',') === '0.1,5,9.9', 'uniform×3：首/中/尾（0.1 / 5 / 9.9）')
    check(frameTimesOf('uniform', null, 2, 10).join(',') === '0.1,9.9', 'uniform×2：首/尾')
    const t9 = frameTimesOf('uniform', null, 9, 10)
    check(t9.length === 9 && t9[0] === 0.1 && t9[1] === 1.325 && t9[8] === 9.9, 'uniform×9：等距 9 帧（步长 1.225）')
    check(frameTimesOf('uniform', null, null, 10).length === 3, 'count 缺省 → 3')
    const thr = (fn: () => unknown): boolean => {
      try {
        fn()
        return false
      } catch {
        return true
      }
    }
    check(thr(() => frameTimesOf('uniform', null, 1, 10)), 'count=1 → 报错（下界 2）')
    check(thr(() => frameTimesOf('uniform', null, 10, 10)), 'count=10 → 报错（上界 9）')
    check(thr(() => frameTimesOf('uniform', null, null, null)), '时长缺失 → 报错（uniform 必须有时长）')
    const degen = frameTimesOf('uniform', null, 3, 0.25)
    check(degen.length === 3 && degen.every((t) => t === 0.1), 'dur≤0.3 退化：全取首帧时刻')
    check(
      frameTimesOf('first', null, null, 10).join(',') === '0.1' && frameTimesOf('last', null, null, 10).join(',') === '9.9',
      '非 uniform 直通：first/last 单元素',
    )
    check(frameTimesOf('custom', 5, null, 10).join(',') === '5', '非 uniform 直通：custom 单元素')

    // ---- 真实 ffmpeg 全链（本地二进制；缺 → SKIP） ----
    const ffmpeg = resolveFfmpeg()
    if (!ffmpeg) {
      log.info('  SKIP  multi-frame 全链（未找到 ffmpeg：仓库根 pnpm install / 配置 CSTUDIO_FFMPEG_PATH）')
      return
    }
    const [projF] = await db
      .insert(projects)
      .values({ name: 'M22 多帧项目', genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
      .returning()
    const [cvF] = await db.insert(canvases).values({ projectId: projF!.id, name: '多帧画布', createdAt: T0, updatedAt: T0 }).returning()
    ensureProjectDirs(projF!.id)
    const vRel2 = relPathOf(projF!.id, 'creation_video', 'probe-uniform-2s.mp4')
    const vAbs2 = absPathOf(vRel2)
    const gen = spawnSync(
      ffmpeg,
      ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=10', '-pix_fmt', 'yuv420p', '-t', '2', vAbs2],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true },
    )
    check(gen.status === 0, 'ffmpeg 生成测试视频（testsrc 2s）')
    if (gen.status !== 0) return
    const vAsset = await registerAsset(projF!.id, {
      name: 'uniform-src.mp4',
      kind: 'video',
      purpose: 'creation_video',
      relPath: vRel2,
      mime: 'video/mp4',
      ext: 'mp4',
      width: 160,
      height: 120,
      duration: 2,
    })
    const [nSrc] = await db
      .insert(canvasNodes)
      .values({ canvasId: cvF!.id, kind: 'asset', assetId: vAsset.id, title: '源视频', x: 400, y: 300, createdAt: T0, updatedAt: T0 })
      .returning()

    const r3 = await extractNodeFrame(nSrc!.id, { mode: 'uniform', count: 3 })
    check(r3.nodes != null && r3.nodes.length === 3 && r3.assets != null && r3.assets.length === 3, 'uniform×3 全链：3 节点 + 3 资产')
    check(r3.node.id === r3.nodes![0]!.id && r3.asset.id === r3.assets![0]!.id, '首帧兼容：node/asset = nodes[0]/assets[0]')
    check(
      r3.nodes![0]!.x === 460 && r3.nodes![1]!.x === 720 && r3.nodes![2]!.x === 980 && r3.nodes!.every((n) => n.y === 440),
      '网格 3 列：x = 源 x+60 + k×260；首行同 y（源 y+140）',
    )
    const p0 = JSON.parse(String(r3.assets![0]!.params ?? '{}')) as Record<string, unknown>
    const p2 = JSON.parse(String(r3.assets![2]!.params ?? '{}')) as Record<string, unknown>
    check(p0.mode === 'uniform' && p0.count === 3 && p0.index === 0 && p0.timeSec === 0.1, 'params：mode/count/index/timeSec（首帧 0.1）')
    check(p2.index === 2 && p2.timeSec === 1.9 && p2.duration === 2, 'params：末帧 index=2 / timeSec=1.9 / duration')
    const jpgOk = r3.assets!.every((a) => {
      const abs = absPathOf(a.relPath ?? '')
      if (!existsSync(abs)) return false
      const head = readFileSync(abs).subarray(0, 2)
      return head[0] === 0xff && head[1] === 0xd8
    })
    check(jpgOk, '3 产物文件存在且为 JPEG（FFD8 魔数）')
    check(new Set(r3.nodes!.map((n) => n.assetId)).size === 3, '3 节点指向 3 个不同资产')

    const r4 = await extractNodeFrame(nSrc!.id, { mode: 'uniform', count: 4, x: 0, y: 0 })
    check(r4.nodes != null && r4.nodes.length === 4 && r4.nodes[3]!.x === 0 && r4.nodes[3]!.y === 200, '网格换行：k=3 → 列 0 / 第二行（+200）')

    const errMsg = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn()
        return 'no-error'
      } catch (err) {
        return (err as Error).message
      }
    }
    check((await errMsg(() => extractNodeFrame(nSrc!.id, { mode: 'uniform', count: 10 }))).includes('count 需为'), 'count=10 → 报错「count 需为 2–9」')
    check((await errMsg(() => extractNodeFrame(nSrc!.id, { mode: 'uniform', count: 'abc' }))).includes('count 需为数值'), 'count 非数值 → 报错')
    const gRel = relPathOf(projF!.id, 'creation_video', 'garbage.mp4')
    writeFileSync(absPathOf(gRel), Buffer.from('not-a-video'))
    const gAsset = await registerAsset(projF!.id, { name: 'garbage.mp4', kind: 'video', purpose: 'creation_video', relPath: gRel, mime: 'video/mp4', ext: 'mp4' })
    const [nG] = await db
      .insert(canvasNodes)
      .values({ canvasId: cvF!.id, kind: 'asset', assetId: gAsset.id, title: '坏视频', x: 0, y: 0, createdAt: T0, updatedAt: T0 })
      .returning()
    check((await errMsg(() => extractNodeFrame(nG!.id, { mode: 'uniform', count: 3 }))).includes('需要视频时长'), '时长探测失败 → uniform 报错「需要视频时长」')
  }

  // ================= 分发 =================

  const runners: Record<string, () => Promise<void>> = {
    'spec-fields': sectionSpecFields,
    trash: sectionTrash,
    schema: sectionSchema,
    align: sectionAlign,
    refs: sectionRefs,
    'group-nest': sectionGroupNest,
    'snapshot-diff': sectionSnapshotDiff,
    fit: sectionFit,
    'copy-to': sectionCopyTo,
    'export-svg': sectionExportSvg,
    'multi-frame': sectionMultiFrame,
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
    console.log(`\n==== M22 探针结果: ${failed > 0 ? `${failed} 项失败` : '全部通过'} ====`)
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
