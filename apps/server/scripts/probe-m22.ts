/**
 * M22 探针（创作画布深化——编辑与保真）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m22.ts [--section=spec-fields|trash|schema|...]
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
 *
 * [M26·H5b] 拆分：入口薄化（probe-lib isolatedEnv/makeChecker/runSections + 组装 ctx），
 * 十一节断言体逐字搬入 probes/m22/*.ts（断言文案/顺序/计数零变更）。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'
import { run as runSpecFields } from './probes/m22/spec-fields'
import { run as runTrash } from './probes/m22/trash'
import { run as runSchema } from './probes/m22/schema'
import { run as runAlign } from './probes/m22/align'
import { run as runRefs } from './probes/m22/refs'
import { run as runGroupNest } from './probes/m22/group-nest'
import { run as runSnapshotDiff } from './probes/m22/snapshot-diff'
import { run as runFit } from './probes/m22/fit'
import { run as runCopyTo } from './probes/m22/copy-to'
import { run as runExportSvg } from './probes/m22/export-svg'
import { run as runMultiFrame } from './probes/m22/multi-frame'

// ---- 隔离环境：必须先于任何 src 模块加载（probe-lib isolatedEnv 复刻 acs-probe-m22- 前缀语义）----
const { tmp: TMP, cleanup: envCleanup } = isolatedEnv('m22')

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
  const checker: Checker = makeChecker(log)
  const check = checker.check

  // ---- setup：隔离库 + 种子项目 ----
  await initDb()
  const T0 = 1_700_000_000_000
  const [proj] = await db
    .insert(projects)
    .values({ name: 'M22 探针项目', genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
    .returning()

  const ctx = {
    check,
    log,
    db,
    sqlite,
    eq,
    assets,
    canvasEdges,
    canvasGroups,
    canvasNodes,
    canvases,
    characters,
    projects,
    COMPOSE_FITS,
    SUBTITLE_MODES,
    parseNodeSpec,
    TRASH_DEFAULTS,
    parseTrashPolicy,
    resolveTrashPolicy,
    selectExpiredCanvases,
    buildComposeArgs,
    escapeSubtitlePath,
    planAlignedSegments,
    buildSegmentSrt,
    parseSrtCues,
    retimeSrtCues,
    normalizePositiveIds,
    collectSetRefAssetIds,
    shotFirstFrameOf,
    collectRefAssetIds,
    buildTemplateDraftYaml,
    validateTemplateText,
    createGroup,
    deleteGroup,
    GroupError,
    updateGroup,
    clampDiffValue,
    diffSnapshotDocs,
    branchSnapshot,
    createSnapshot,
    restoreSnapshot,
    buildCanvasDoc,
    copyNodesToCanvas,
    buildCanvasSvg,
    computeSvgGroupBoxes,
    svgBezier,
    svgNodeColor,
    truncTitle,
    xmlEscape,
    extractNodeFrame,
    frameTimesOf,
    UNIFORM_FRAME_COUNT_RANGE,
    absPathOf,
    ensureProjectDirs,
    registerAsset,
    relPathOf,
    writeTextAsset,
    resolveFfmpeg,
    T0,
    proj,
  }

  // ================= 分发 =================
  const runners: Record<string, () => Promise<void>> = {
    'spec-fields': () => runSpecFields(ctx),
    trash: () => runTrash(ctx),
    schema: () => runSchema(ctx),
    align: () => runAlign(ctx),
    refs: () => runRefs(ctx),
    'group-nest': () => runGroupNest(ctx),
    'snapshot-diff': () => runSnapshotDiff(ctx),
    fit: () => runFit(ctx),
    'copy-to': () => runCopyTo(ctx),
    'export-svg': () => runExportSvg(ctx),
    'multi-frame': () => runMultiFrame(ctx),
  }

  await runSections({
    log,
    title: 'M22',
    checker,
    sections: SECTIONS,
    runners,
    cleanup: () => {
      try {
        sqlite.close() // 释放 db 连接（Windows 下句柄可能仍被 libsql 持有 → 失败不阻断）
      } catch {
        /* 已关闭或未初始化 */
      }
      try {
        envCleanup()
      } catch {
        console.log(`临时目录未完全清理（Windows libsql 句柄；下次运行自动清理）: ${TMP}`)
      }
    },
  })
}

void main()
