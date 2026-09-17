/**
 * M19 探针（成片品质与品牌化）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m19.ts [--section=subtitle-style|brand-watermark|intro-outro|sfx|aspect|ref-gen|states|voice-clone]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录
 * （独立 studio.db + workspace），不触碰开发库（同 probe-m3~m18）。零网络、零计费：
 * 直测服务层函数与纯函数，不触发引擎执行与真实生成。ref-gen/states/voice-clone 三节各自
 * 持局部 fetch stub（try/finally 还原），故入口不设全局 fetch 屏蔽、不屏蔽 LLM 环境变量。
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
 *
 * [M26·H5b] 拆分：入口薄化（probe-lib isolatedEnv/makeChecker/runSections + 组装 ctx），
 * 八节断言体逐字搬入 probes/m19/*.ts（断言文案/顺序/计数零变更）；各节保留自持的服务纯函数动态导入。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'
import { run as runSubtitleStyle } from './probes/m19/subtitle-style'
import { run as runBrandWatermark } from './probes/m19/brand-watermark'
import { run as runIntroOutro } from './probes/m19/intro-outro'
import { run as runSfx } from './probes/m19/sfx'
import { run as runAspect } from './probes/m19/aspect'
import { run as runRefGen } from './probes/m19/ref-gen'
import { run as runStates } from './probes/m19/states'
import { run as runVoiceClone } from './probes/m19/voice-clone'

// ---- 隔离环境：必须先于任何 src 模块加载（probe-lib isolatedEnv 复刻 acs-probe-m19- 前缀语义）----
const { tmp: TMP, cleanup: envCleanup } = isolatedEnv('m19')

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
  const checker: Checker = makeChecker(log)
  const check = checker.check

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

  const ctx = {
    check,
    log,
    db,
    T0,
    pid,
    mkProject,
    errOf,
    mkArgsInput,
    eq,
    mergeBrand,
    readComposeBrand,
    readPlatformBrand,
    readProjectBrand,
    resolveBrandConfig,
    sanitizeSubtitleStyle,
    sanitizeWatermark,
    buildComposeArgs,
    watermarkOverlayXY,
    countSrtCues,
    shiftSrtText,
    purposeSubDir,
    BRAND_DIR,
    characters,
    genTasks,
    pipelineRuns,
    projects,
    settings,
    voiceClones,
  }

  // ================= 分发 =================
  const runners: Record<string, () => Promise<void>> = {
    'subtitle-style': () => runSubtitleStyle(ctx),
    'brand-watermark': () => runBrandWatermark(ctx),
    'intro-outro': () => runIntroOutro(ctx),
    sfx: () => runSfx(ctx),
    aspect: () => runAspect(ctx),
    'ref-gen': () => runRefGen(ctx),
    states: () => runStates(ctx),
    'voice-clone': () => runVoiceClone(ctx),
  }

  await runSections({
    log,
    title: 'M19',
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
