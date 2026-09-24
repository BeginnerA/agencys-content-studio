/**
 * M11 探针（引擎级单步重跑 + 镜头级音字对齐 + BGM·转场）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m11.ts [--section=rerun|align|bgm|transition|template|regression]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录
 * （独立 studio.db + workspace），不触碰开发库（同 probe-m3~m10）。零网络、零计费：
 * 直测服务层函数与纯函数，不触发引擎执行与真实生成。
 *
 * section（默认 all）：
 *   rerun      resetStepForRerun：复用模式（succeeded 不动 / tasksReset=非 succeeded 数）+
 *              reset_tasks=true（全量归零 + resultAssetId 保留）+ 无任务步骤（选项忽略）+ 校验拒绝矩阵
 *   align      planVoiceAlignedSegments（一致映射/补静音/空镜/句长兜底/四类回退 reason）+
 *              [统一时轴] planBestEffortTimeline（零回归一致/幽灵句 partial 命中镜仍同源/motion 真实 clip 长/
 *              硬失败保留孤儿配音·重复句·无 lines）+ buildClipDurByShotId +
 *              parseShotLines + planSrtShifts（含 partial 平移）+ shiftSrtText（平移/零平移/数量不符/负值收敛）
 *   bgm        compose-config：上传/复制行绑定、替换软删、隔离、移除 + 校验矩阵 +
 *              updateComposeConfig（白名单/枚举/clamp/合并写）+ readComposeConfig 容错
 *   transition buildTransitionPlan：videoLens/offsets/totalDur 数学 + clamp + 禁用矩阵 + round3
 *   template   模板 v10：make_storyboard after+inputs.lines / compose 四键默认值 / v8 快照优先兼容
 *   regression M7 零回归：computeShotSegments（均分/显式/估算）+ parseShotDurations 双口径 +
 *              对齐回退形态正交
 *
 * [红线拆分 2026-09] rerun/cascade → scripts/probes/m11/modules/cascade.ts、
 * bgm → modules/bgm.ts、regression → modules/regression.ts（断言逐字保留，行为零变更）；
 * 本入口保留隔离环境/setup/行级 helpers 与 align/transition/template 三节，经 ctx 注入共享。
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
// 清理历史残留：libsql 在 Windows 下不释放文件句柄（close 后仍 EBUSY）——本进程退出时 db 文件必留；
// 本次运行在创建自己的目录前清掉旧的（占用中则跳过，自动收敛为最多一份）。
import { sweepStaleProbeTempDirs, writeProbePidSentinel } from './probe-lib'

const TMP_PREFIX = 'acs-probe-m11-'
// 清理历史残留（跳过存活并行探针目录，避免并行 --jobs≥2 下嵌套回归子探针与顶层同名探针互删 SQLite 库）
sweepStaleProbeTempDirs(TMP_PREFIX)
const TMP = mkdtempSync(join(tmpdir(), TMP_PREFIX))
writeProbePidSentinel(TMP)
process.env.CSTUDIO_ROOT = REPO_ROOT
process.env.CSTUDIO_DATA = join(TMP, 'data')
process.env.CSTUDIO_WORKSPACE = join(TMP, 'workspace')
mkdirSync(process.env.CSTUDIO_DATA, { recursive: true })
mkdirSync(process.env.CSTUDIO_WORKSPACE, { recursive: true })

const SECTIONS = ['rerun', 'cascade', 'align', 'bgm', 'transition', 'template', 'regression'] as const

async function main(): Promise<void> {
  // src 模块全部动态加载（环境变量已隔离）
  const { db, initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')
  const { assets, genTasks, pipelineRuns, pipelineSteps, projects } = await import('../src/db/schema')
  const { eq } = await import('drizzle-orm')
  const { absPathOf, ensureProjectDirs, registerAsset, relPathOf } = await import('../src/services/storage')
  const { WorkbenchError } = await import('../src/services/shot') // [M11 split] rerun/cascade/bgm/regression live in probes/m11/modules/* (dynamic-import their own services)

  const log = createLogger('probe-m11')
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
  const pid = (
    await db
      .insert(projects)
      .values({ name: 'M11 探针项目', genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
      .returning()
  )[0]!.id
  ensureProjectDirs(pid)

  // ---- 行级 helpers ----
  const getRun = async (id: number) => (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)).limit(1))[0]!
  const getStep = async (id: number) => (await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, id)).limit(1))[0]!
  const getAsset = async (id: number) => (await db.select().from(assets).where(eq(assets.id, id)).limit(1))[0]!
  const getTask = async (id: number) => (await db.select().from(genTasks).where(eq(genTasks.id, id)).limit(1))[0]!
  const setRunStatus = (id: number, status: string) => db.update(pipelineRuns).set({ status }).where(eq(pipelineRuns.id, id))
  const setStepStatus = (id: number, status: string) => db.update(pipelineSteps).set({ status }).where(eq(pipelineSteps.id, id))

  const mkStep = async (runId: number, seq: number, stepKey: string, actionKey: string, status = 'succeeded'): Promise<number> =>
    (
      await db
        .insert(pipelineSteps)
        .values({ runId, seq, stepKey, actionKey, title: stepKey, status, createdAt: T0 + seq, updatedAt: T0 + seq })
        .returning()
    )[0]!.id

  interface Seed {
    runId: number
    sbStepId: number
    imgStepId: number
    voiceStepId: number
    skipStepId: number
    mergeStepId: number
    t1: number
    t2: number
    imgA: number
    audioSrc: number
  }

  /**
   * 种子 run（completed；5 步骤 / 4 任务 / 2 资产）：
   * make_storyboard(succeeded,1 任务) → gen_images(succeeded, t1 succeeded + t2 failed)
   * → voice(succeeded,1 任务) → subtitle(skipped) → compose_video(succeeded, 无任务)。
   * input 含 episode_number/with_voice（合并写不丢他键断言）；currentStepKey 预置（重置清字段断言）。
   */
  const seedRun = async (): Promise<Seed> => {
    const runId = (
      await db
        .insert(pipelineRuns)
        .values({
          projectId: pid,
          templateKey: 'mengbao-episode',
          status: 'completed',
          input: JSON.stringify({ episode_number: 7, with_voice: true }),
          currentStepKey: 'compose_video',
          startedAt: T0,
          completedAt: T0 + 60,
          createdAt: T0,
          updatedAt: T0 + 60,
        })
        .returning()
    )[0]!.id

    const sbStepId = await mkStep(runId, 1, 'make_storyboard', 'ai_text')
    const imgStepId = await mkStep(runId, 2, 'gen_images', 'ai_image')
    const voiceStepId = await mkStep(runId, 3, 'voice', 'tts')
    const skipStepId = await mkStep(runId, 4, 'subtitle', 'subtitle', 'skipped')
    const mergeStepId = await mkStep(runId, 5, 'compose_video', 'ffmpeg_merge')
    // 目标步骤预置旧值（重置清字段断言）
    await db.update(pipelineSteps).set({ error: '旧错误', completedAt: T0 + 40 }).where(eq(pipelineSteps.id, imgStepId))

    const mkTask = async (
      stepId: number,
      status: string,
      attempts: number,
      createdAt: number,
      params: Record<string, unknown>,
      errorMsg: string | null = null,
    ): Promise<number> =>
      (
        await db
          .insert(genTasks)
          .values({
            projectId: pid,
            runId,
            stepId,
            kind: 'image',
            provider: 'probe',
            params: JSON.stringify(params),
            status,
            attempts,
            errorMsg,
            createdAt,
            updatedAt: createdAt,
            completedAt: status === 'succeeded' ? createdAt : null,
          })
          .returning()
      )[0]!.id

    const t1 = await mkTask(imgStepId, 'succeeded', 3, T0 + 10, { shotId: 's01' })
    const t2 = await mkTask(imgStepId, 'failed', 2, T0 + 11, { shotId: 's02' }, '生成失败')
    await mkTask(sbStepId, 'succeeded', 1, T0 + 9, {})
    await mkTask(voiceStepId, 'succeeded', 1, T0 + 12, {})

    // 资产：t1 产物图（resultAssetId 保留断言）+ 项目音频（bindBgmFromAsset 源；真实小文件）
    const imgRel = relPathOf(pid, 'shot_image', `m11-${runId}-s01.png`)
    const IMG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex')
    writeFileSync(absPathOf(imgRel), IMG_BYTES)
    const imgA = (
      await registerAsset(pid, {
        name: 's01.png',
        kind: 'image',
        purpose: 'shot_image',
        relPath: imgRel,
        mime: 'image/png',
        ext: 'png',
        fileSize: IMG_BYTES.byteLength,
        params: { shotId: 's01' },
        runId,
      })
    ).id
    const AUD_BYTES = new Uint8Array(Buffer.from('probe-m11-audio-src'))
    const audRel = relPathOf(pid, 'voice', `m11-${runId}-src.mp3`)
    writeFileSync(absPathOf(audRel), AUD_BYTES)
    const audioSrc = (
      await registerAsset(pid, {
        name: 'src.mp3',
        kind: 'audio',
        purpose: 'voice',
        relPath: audRel,
        mime: 'audio/mpeg',
        ext: 'mp3',
        fileSize: AUD_BYTES.byteLength,
        runId,
      })
    ).id
    await db.update(genTasks).set({ resultAssetId: imgA }).where(eq(genTasks.id, t1))

    return { runId, sbStepId, imgStepId, voiceStepId, skipStepId, mergeStepId, t1, t2, imgA, audioSrc }
  }

  // ================= sections =================
  // rerun / cascade / bgm / regression 四节因 ≤800 行红线拆至 scripts/probes/m11/modules/*（断言逐字保留），
  // 经下方 m11Ctx 注入共享 helpers；align / transition / template 留在本文件。

  const sectionAlign = async (): Promise<void> => {
    const { parseShotLines, planVoiceAlignedSegments, planBestEffortTimeline, planAudioDrivenShotDurations, planSrtShifts, shiftSrtText, srtTsToSec, secToSrtTs, buildClipDurByShotId, buildComposeArgs } = await import(
      '../src/pipeline/actions/ffmpeg-merge'
    )

    // ---- parseShotLines：形态容错 + 双时长口径 + hasLinesField ----
    const p1 = parseShotLines(
      JSON.stringify({
        shots: [
          { id: 's01', duration: 3, lines: ['L1', ''] },
          { id: 's02', duration_sec: 2.5, lines: [] },
          { id: 's03' },
          null,
          'junk',
          { duration: 2 },
        ],
      }),
    )
    check(p1.shots.length === 3 && p1.hasLinesField, `shots=3 且 hasLinesField（实际 ${p1.shots.length}/${p1.hasLinesField}）`)
    check(
      p1.shots[0]!.id === 's01' && p1.shots[0]!.durationSec === 3 && JSON.stringify(p1.shots[0]!.lineIds) === JSON.stringify(['L1']),
      's01：duration 口径 + lines 空串过滤',
    )
    check(p1.shots[1]!.durationSec === 2.5 && p1.shots[1]!.lineIds.length === 0, 's02：duration_sec 回退 + 空数组')
    check(p1.shots[2]!.durationSec === null, 's03：无时长 → null')
    const p2 = parseShotLines(JSON.stringify([{ id: 'a', duration: 2 }]))
    check(p2.shots.length === 1 && !p2.hasLinesField, '裸数组形态 + 无 lines 字段（老分镜）→ hasLinesField=false')

    // ---- 一致映射场景 A：补镜尾静音 / 空镜 / 句长兜底 / 双轴 ----
    const shotsA = [
      { id: 's01', durationSec: 10, lineIds: ['L1', 'L2'] },
      { id: 's02', durationSec: null, lineIds: [] as string[] },
      { id: 's03', durationSec: 3, lineIds: ['L3'] },
    ]
    const voiceA = new Map([
      ['L1', 2],
      ['L2', 3],
      ['L3', 4],
    ])
    const planA = planVoiceAlignedSegments(shotsA, voiceA, 4, { hasLinesField: true })
    check(planA.aligned === true && planA.segments.length === 3, '一致映射 → aligned')
    check(planA.segments[0]!.durSec === 10 && planA.segments[0]!.silenceSec === 5, 'explicit > 句和 → explicit + 镜尾静音 5s')
    check(planA.segments[1]!.durSec === 4 && planA.segments[1]!.silenceSec === 4 && planA.segments[1]!.lineIds.length === 0, '空镜 → fallback 4s 全静音')
    check(planA.segments[2]!.durSec === 4 && planA.segments[2]!.silenceSec === 0, 'explicit < 句和 → 以句和为准（4s）')
    check(JSON.stringify(planA.warnShots) === JSON.stringify(['s03']), `warnShots=[s03]（实际 ${JSON.stringify(planA.warnShots)}）`)
    check(
      planA.lines[0]!.speechStart === 0 && planA.lines[0]!.timelineStart === 0
      && planA.lines[1]!.speechStart === 2 && planA.lines[1]!.timelineStart === 2,
      'L1/L2 双轴（0/2 连续轴一致）',
    )
    check(planA.lines[2]!.speechStart === 5 && planA.lines[2]!.timelineStart === 14, 'L3 双轴（speech=5 / timeline=14）')
    check(planA.totalDur === 18, `totalDur = Σd（实际 ${planA.totalDur}）`)

    // ---- 边界：explicit == 句和（无静音）+ safeFallback ----
    const planB = planVoiceAlignedSegments(
      [
        { id: 's01', durationSec: 5, lineIds: ['A'] },
        { id: 's02', durationSec: null, lineIds: [] as string[] },
      ],
      new Map([['A', 5]]),
      0,
      { hasLinesField: true },
    )
    check(planB.aligned && planB.segments[0]!.durSec === 5 && planB.segments[0]!.silenceSec === 0, 'explicit == 句和 → 无静音')
    check(planB.segments[1]!.durSec === 4 && planB.totalDur === 9, 'fallback≤0 → safeFallback=4')

    // ---- 四类回退 reason ----
    const f1 = planVoiceAlignedSegments([], new Map([['x', 1]]), 4, { hasLinesField: true })
    check(!f1.aligned && f1.reason === 'no_shots' && f1.segments.length === 0 && f1.lines.length === 0 && f1.totalDur === 0, 'no_shots（空形态正交）')
    const f2 = planVoiceAlignedSegments(shotsA, new Map(), 4, { hasLinesField: true })
    check(!f2.aligned && f2.reason === 'no_voices', 'no_voices')
    const f3 = planVoiceAlignedSegments(shotsA, voiceA, 4, { hasLinesField: false })
    check(!f3.aligned && f3.reason === 'no_lines_field', 'no_lines_field（老分镜）')
    const f4 = planVoiceAlignedSegments([{ id: 's01', durationSec: 2, lineIds: ['L1'] }], new Map([['L1', 1], ['L2', 1]]), 4, {
      hasLinesField: true,
    })
    check(!f4.aligned && f4.reason === 'mapping_mismatch', 'mapping_mismatch：孤儿句（语音多出）')
    const f5 = planVoiceAlignedSegments([{ id: 's01', durationSec: 2, lineIds: ['L1', 'LX'] }], new Map([['L1', 1]]), 4, {
      hasLinesField: true,
    })
    check(!f5.aligned && f5.reason === 'mapping_mismatch', 'mapping_mismatch：幽灵 id（引用不存在）')
    const f6 = planVoiceAlignedSegments(
      [
        { id: 's01', durationSec: 2, lineIds: ['L1'] },
        { id: 's02', durationSec: 2, lineIds: ['L1'] },
      ],
      new Map([['L1', 1]]),
      4,
      { hasLinesField: true },
    )
    check(!f6.aligned && f6.reason === 'mapping_mismatch', 'mapping_mismatch：重复句（跨镜复引）')

    // ---- [以音定画] planAudioDrivenShotDurations：逐镜句和（供 ai_video 生成期时长）----
    const adShots = [
      { id: 's01', durationSec: 10, lineIds: ['L1', 'L2'] },
      { id: 's02', durationSec: null, lineIds: [] as string[] },
      { id: 's03', durationSec: 3, lineIds: ['L3'] },
    ]
    const adMap = planAudioDrivenShotDurations(adShots, voiceA)
    check(adMap.get('s01') === 5, `s01：时长以音频和为准(2+3=5)、不受显式 10 抬高（实际 ${adMap.get('s01')}）`)
    check(!adMap.has('s02'), 's02：无台词镜不进表（调用方回退分镜估长/兜底）')
    check(adMap.get('s03') === 4, `s03：句和 4 > 显式 3 → 以音频 4 为准（实际 ${adMap.get('s03')}）`)
    // 部分命中宽容：幽灵 id 不抛错，仅累计存在句（与严格 plan 的 mapping_mismatch 回退不同）
    const adPartial = planAudioDrivenShotDurations([{ id: 's01', durationSec: 2, lineIds: ['L1', 'LX'] }], new Map([['L1', 1.234]]))
    check(adPartial.get('s01') === 1.234, `部分命中宽容：忽略幽灵 LX、仅 L1=1.234（实际 ${adPartial.get('s01')}）`)
    check(planAudioDrivenShotDurations(adShots, new Map()).size === 0, '无音频时长 → 空表')

    // ---- planSrtShifts：逐 cue 平移 / 数量与序校验 ----
    const shifts = planSrtShifts(planA, ['L1', 'L2', 'L3'])
    check(JSON.stringify(shifts) === JSON.stringify([0, 0, 9]), `逐 cue 平移（实际 ${JSON.stringify(shifts)}）`)
    check(planSrtShifts(planA, []) === null, '空 cue 序 → null')
    check(planSrtShifts(planA, ['L1', 'ZZ', 'L3']) === null, '缺失句 id → null')
    check(planSrtShifts(f1, ['L1']) === null, '未对齐 → null')

    // ---- shiftSrtText：平移正确 / 保格式 / 数量不符 / 负值收敛 ----
    const srt = '1\n00:00:00,000 --> 00:00:02,000\n你好\n\n2\n00:00:02,000 --> 00:00:05,000\n世界\n\n3\n00:00:05,000 --> 00:00:09,000\n再见'
    const shifted = shiftSrtText(srt, [0, 0, 9])
    check(
      shifted !== null && shifted.includes('00:00:14,000 --> 00:00:18,000') && !shifted.includes('00:00:05,000 --> 00:00:09,000'),
      '第 3 cue 平移 +9s（原 cue3 行整体消失）',
    )
    check(shifted !== null && shifted.includes('00:00:02,000 --> 00:00:05,000'), '第 2 cue 零平移（镜内无前置静音）')
    check(shiftSrtText(srt, [0, 0]) === null, 'cue 数与 shifts 不符 → null')
    const crlfOut = shiftSrtText('1\r\n00:00:00,000 --> 00:00:01,000\r\n嗨', [0])
    check(crlfOut !== null && crlfOut.includes('\r\n'), 'CRLF 格式保持')
    const negOut = shiftSrtText('1\n00:00:00,500 --> 00:00:01,500\n早', [-2])
    check(negOut !== null && negOut.includes('00:00:00,000 --> 00:00:00,000'), '负值收敛 0（secToSrtTs）')

    // ---- 时间戳互转 ----
    check(srtTsToSec('01', '02', '03', '456') === 3723.456, 'srtTsToSec（3723.456）')
    check(secToSrtTs(3723.456) === '01:02:03,456', 'secToSrtTs 往返')
    check(secToSrtTs(-5) === '00:00:00,000', 'secToSrtTs 负值收敛 0')

    // ================================================================
    // [统一时轴·中档] planBestEffortTimeline：回退路径接同源（幽灵句不整体回退）
    // ================================================================

    // ---- (c) 零回归锁定：无幽灵句时核心产出与 planVoiceAlignedSegments 完全一致 ----
    const beA = planBestEffortTimeline(shotsA, voiceA, 4, { hasLinesField: true, mode: 'images' })
    check(beA.aligned === true && beA.partial === false && JSON.stringify(beA.warnLines) === JSON.stringify([]), `无幽灵句 → aligned & partial=false（实际 ${beA.aligned}/${beA.partial}）`)
    check(JSON.stringify(beA.segments) === JSON.stringify(planA.segments), 'segments 与严格 plan 逐字节一致（零回归）')
    check(JSON.stringify(beA.lines) === JSON.stringify(planA.lines), 'lines 双轴与严格 plan 逐字节一致')
    check(beA.totalDur === planA.totalDur && beA.mode === 'images', `totalDur/mode 一致（实际 ${beA.totalDur}/${beA.mode}）`)
    check(JSON.stringify(planSrtShifts(beA, ['L1', 'L2', 'L3'])) === JSON.stringify(shifts), '无幽灵句 planSrtShifts 与严格 plan 一致')

    // ---- (a) 孤儿/幽灵句：严格 plan 整体 mapping_mismatch，best-effort 命中镜仍产 canonical 计划 + partial ----
    const shotsE = [
      { id: 's01', durationSec: 6, lineIds: ['L1'] },
      { id: 's02', durationSec: 5, lineIds: ['L2', 'LX'] }, // LX = 幽灵句（分镜引用、无实测配音）
    ]
    const voiceE = new Map([['L1', 2], ['L2', 3]]) // 无 LX
    const strictE = planVoiceAlignedSegments(shotsE, voiceE, 4, { hasLinesField: true })
    check(!strictE.aligned && strictE.reason === 'mapping_mismatch', '严格 plan：幽灵句 LX → mapping_mismatch（整体回退）')
    const beE = planBestEffortTimeline(shotsE, voiceE, 4, { hasLinesField: true, mode: 'images' })
    check(beE.aligned === true && beE.partial === true, `best-effort：命中镜仍产出计划（aligned=${beE.aligned} partial=${beE.partial}）`)
    check(JSON.stringify(beE.warnLines) === JSON.stringify(['LX']), `warnLines=[LX]（实际 ${JSON.stringify(beE.warnLines)}）`)
    check(beE.segments.length === 2 && beE.segments[0]!.durSec === 6 && beE.segments[0]!.silenceSec === 4, 's01：显式 6 > 句和 2 → 6s + 镜尾静音 4s')
    check(beE.segments[1]!.durSec === 5 && JSON.stringify(beE.segments[1]!.lineIds) === JSON.stringify(['L2']), 's02：幽灵 LX 剔除后仅 L2（显式 5 > 句和 3）')
    check(beE.lines.length === 2 && beE.lines[1]!.lineId === 'L2' && beE.lines[1]!.speechStart === 2 && beE.lines[1]!.timelineStart === 6, 'L2 双轴（speech 2 / timeline 6）')
    // partial 化 planSrtShifts：命中 cue 按同源平移，幽灵 cue（不在计划）shift 0 不整体放弃
    const shiftsE = planSrtShifts(beE, ['L1', 'L2', 'LX'])
    check(JSON.stringify(shiftsE) === JSON.stringify([0, 4, 0]), `partial 平移：L1=0 / L2=+4 / 幽灵 LX=0（实际 ${JSON.stringify(shiftsE)}）`)
    check(planSrtShifts(planA, ['L1', 'L2', 'LX']) === null, '非 partial 计划缺句 → null（旧行为不变）')

    // ---- 硬失败保留：孤儿配音（有 voice 无镜引用）/ 重复句 / 无 lines 字段 ----
    const beOrphan = planBestEffortTimeline([{ id: 's01', durationSec: 2, lineIds: ['L1'] }], new Map([['L1', 1], ['L2', 1]]), 4, { hasLinesField: true, mode: 'images' })
    check(!beOrphan.aligned && beOrphan.reason === 'mapping_mismatch', 'best-effort：孤儿配音（语音多出）→ 仍 mapping_mismatch（视频将短于音轨）')
    const beDup = planBestEffortTimeline(
      [{ id: 's01', durationSec: 2, lineIds: ['L1'] }, { id: 's02', durationSec: 2, lineIds: ['L1'] }],
      new Map([['L1', 1]]),
      4,
      { hasLinesField: true, mode: 'images' },
    )
    check(!beDup.aligned && beDup.reason === 'mapping_mismatch', 'best-effort：跨镜复引（歧义）→ mapping_mismatch')
    const beNoLines = planBestEffortTimeline(shotsA, voiceA, 4, { hasLinesField: false, mode: 'images' })
    check(!beNoLines.aligned && beNoLines.reason === 'no_lines_field', 'best-effort：无 lines 字段 → no_lines_field（多镜不可推导，留 fit_voice）')

    // ---- (b) motion：段长按真实 clip 时长（不拉伸），仅借 lineIds 把字幕平移到 clip 累计轴 ----
    const shotsM = [
      { id: 's01', durationSec: null, lineIds: ['M1'] },
      { id: 's02', durationSec: null, lineIds: ['M2'] },
    ]
    const voiceM = new Map([['M1', 2], ['M2', 3]])
    const clipDurM = new Map([['s01', 5], ['s02', 4]]) // 真实 clip 长（≠ 句和 2/3）
    const beM = planBestEffortTimeline(shotsM, voiceM, 4, { hasLinesField: true, mode: 'motion', clipDurByShotId: clipDurM })
    check(beM.aligned === true && beM.mode === 'motion' && beM.partial === false, `motion aligned & mode=motion（实际 ${beM.aligned}/${beM.mode}）`)
    check(beM.segments[0]!.durSec === 5 && beM.segments[0]!.silenceSec === 3, 'motion s01：段长=clip 5（不拉伸为句和 2）+ 静音 3')
    check(beM.segments[1]!.durSec === 4, 'motion s02：段长=clip 4')
    check(beM.totalDur === 9, `motion totalDur = Σclip（实际 ${beM.totalDur}）`)
    check(beM.lines[1]!.speechStart === 2 && beM.lines[1]!.timelineStart === 5, 'M2 双轴：speech 2（语音连续）/ timeline 5（clip 累计）')
    const shiftsM = planSrtShifts(beM, ['M1', 'M2'])
    check(JSON.stringify(shiftsM) === JSON.stringify([0, 3]), `motion 字幕平移到 clip 累计轴：M2 +3s（实际 ${JSON.stringify(shiftsM)}）`)
    // motion clip 时长缺该镜 → 回退 explicit/safeFallback（不抛错）
    const beMNoClip = planBestEffortTimeline(shotsM, voiceM, 4, { hasLinesField: true, mode: 'motion', clipDurByShotId: new Map() })
    check(beMNoClip.aligned && beMNoClip.segments[0]!.durSec === 4 && beMNoClip.segments[1]!.durSec === 4, 'motion clipDur 缺表 → 兜底 safeFallback 4s')

    // ---- buildClipDurByShotId：shotId → clip 实测时长（motion 段长来源）----
    const clipRows = [
      { id: 101, params: JSON.stringify({ shotId: 's01' }) },
      { id: 102, params: JSON.stringify({ shotId: 's02' }) },
      { id: 103, params: '{}' }, // 无 shotId → 不入表
    ] as unknown as Parameters<typeof buildClipDurByShotId>[1]
    const clipSegs = [
      { id: 101, kind: 'video', durSec: 5 },
      { id: 102, kind: 'video', durSec: 4 },
      { id: 103, kind: 'video', durSec: 9 },
    ] as unknown as Parameters<typeof buildClipDurByShotId>[0]
    const builtClipDur = buildClipDurByShotId(clipSegs, clipRows)
    check(builtClipDur.get('s01') === 5 && builtClipDur.get('s02') === 4 && !builtClipDur.has('' ) && builtClipDur.size === 2, `buildClipDurByShotId：shotId→clip dur（实际 ${builtClipDur.size} 项）`)

    // ---- [统一时轴] best-effort 计划 → buildComposeArgs：音频放置 + 字幕烧录同源于该计划（消除回退即漂移）----
    // beE：partial 计划（s01 L1 dur6/静音4、s02 L2 dur5/静音2；幽灵 LX 无配音不入 voicePaths/lineIds）
    const beArgs = buildComposeArgs({
      segments: [
        { id: 1, path: 'a.png', kind: 'image', durSec: beE.segments[0]!.durSec },
        { id: 2, path: 'b.png', kind: 'image', durSec: beE.segments[1]!.durSec },
      ],
      width: 1080,
      height: 1920,
      fps: 25,
      xfadePlan: { enabled: false, type: 'none', durSec: 0, videoLens: [6, 5], offsets: [], totalDur: 11 },
      voicePaths: ['v1.mp3', 'v2.mp3'],
      lineIds: ['L1', 'L2'],
      alignPlan: beE,
      total: beE.totalDur,
      srtAbs: 'C:/out/ep.srt',
      style: 'FontName=X,FontSize=18',
      bgmPath: null,
      bgmVolume: 0.25,
      bgmFade: 2,
      watermark: null,
      intro: null,
      outro: null,
      outAbs: 'C:/out/ep-final.mp4',
    })
    const beFc = beArgs.args[beArgs.args.indexOf('-filter_complex') + 1]!
    // 对齐 concat：2 句 + 2 镜尾静音 = 4 段；镜尾静音时长按计划 silenceSec（4s/2s）
    check(beFc.includes('concat=n=4:v=0:a=1'), `音频轨按命中句 + 镜尾静音 concat（实际含 concat=n=4）`)
    check(beFc.includes('anullsrc=r=44100:cl=stereo:d=4') && beFc.includes('anullsrc=r=44100:cl=stereo:d=2'), '镜尾静音同源：s01=4s / s02=2s（=计划 silenceSec）')
    check(beFc.includes('[a0]') && beFc.includes('[a1]'), '逐句引用命中配音资产 [a0]/[a1]（幽灵句无残留引用）')
    check(beFc.includes("subtitles='ep.srt'"), '字幕烧录消费同一（已按 partial 平移重写的）SRT')
    // 零漂移不变式：Σ(句时长 + 镜尾静音) == Σ视频段长 == plan.totalDur == 合成 totalAll
    const audioSum = 2 + 4 + 3 + 2
    check(audioSum === beE.totalDur && beE.totalDur === 11 && beArgs.totalAll === 11, `音/画/字三口径同源（Σ=${audioSum} / plan.totalDur=${beE.totalDur} / totalAll=${beArgs.totalAll}）`)
  }

  const sectionTransition = async (): Promise<void> => {
    const { buildTransitionPlan } = await import('../src/pipeline/actions/ffmpeg-merge')

    // ---- 启用：videoLens / offsets / totalDur 数学 ----
    const p1 = buildTransitionPlan([4, 5, 6], 'fade', 0.5)
    check(p1.enabled && p1.type === 'fade' && p1.durSec === 0.5, '启用（fade/0.5）')
    check(JSON.stringify(p1.videoLens) === JSON.stringify([4.5, 5.5, 6]), `videoLens 前 n−1 +T / 末镜原长（实际 ${JSON.stringify(p1.videoLens)}）`)
    check(JSON.stringify(p1.offsets) === JSON.stringify([4, 9]), `offsets=V_k（实际 ${JSON.stringify(p1.offsets)}）`)
    check(p1.totalDur === 15, `totalDur=Σd（实际 ${p1.totalDur}）`)

    // ---- T clamp：下限 / 上限（min(2, min(d))）/ 极短片收口 ----
    const p2 = buildTransitionPlan([4, 5, 6], 'fade', 0)
    check(p2.enabled && p2.durSec === 0.1, 'T 下限 clamp → 0.1')
    const p3 = buildTransitionPlan([4, 5, 6], 'fade', 9)
    check(p3.enabled && p3.durSec === 2 && p3.videoLens[0] === 6, 'T 上限 clamp → min(2, min(d))=2')
    const p4 = buildTransitionPlan([1, 3], 'dissolve', 9)
    check(p4.enabled && p4.durSec === 1 && JSON.stringify(p4.videoLens) === JSON.stringify([2, 3]), '短片上限 min(d)=1')
    const p5 = buildTransitionPlan([0.05, 1], 'fade', 0.5)
    check(p5.enabled && p5.durSec === 0.05, '极短片 durSec 收口 min(d)（0.05）')
    const p12 = buildTransitionPlan([4, 4], 'fade', -3)
    check(p12.enabled && p12.durSec === 0.1, '负 T → clamp 0.1')

    // ---- 禁用矩阵 ----
    const p6 = buildTransitionPlan([4], 'fade', 0.5)
    check(
      !p6.enabled && p6.type === 'none' && JSON.stringify(p6.videoLens) === JSON.stringify([4]) && p6.offsets.length === 0 && p6.totalDur === 4,
      '单镜禁用（videoLens 原样 / offsets 空）',
    )
    const p7 = buildTransitionPlan([], 'fade', 0.5)
    check(!p7.enabled && p7.totalDur === 0, '空序列禁用')
    const p8 = buildTransitionPlan([4, 4], 'none', 0.5)
    check(!p8.enabled, "transition='none' 禁用")
    const p9 = buildTransitionPlan([4, 4], 'wipe', 0.5)
    check(!p9.enabled && p9.type === 'none', '非法类型禁用')
    const p10 = buildTransitionPlan([0, 4], 'fade', 0.5)
    check(!p10.enabled, '零长镜禁用（minDur=0）')

    // ---- round3 精度 ----
    const p11 = buildTransitionPlan([1.234, 2.345], 'fade', 0.5)
    check(p11.videoLens[0] === 1.734 && p11.offsets[0] === 1.234 && p11.totalDur === 3.579, 'round3 精度（1.734/1.234/3.579）')
    const p13 = buildTransitionPlan([0.1, 0.2], 'slideleft', 0.1)
    check(p13.enabled && JSON.stringify(p13.videoLens) === JSON.stringify([0.2, 0.2]) && p13.totalDur === 0.3, '浮点合计 round3（0.3）')

    // ---- 全枚举可启用 ----
    const types = ['fade', 'fadeblack', 'slideleft', 'slideright', 'dissolve']
    check(types.every((t) => buildTransitionPlan([2, 2], t, 0.1).enabled), '五种转场类型全启用')
  }

  const sectionTemplate = async (): Promise<void> => {
    const { loadTemplate, templateForRun } = await import('../src/pipeline/loader')
    const { TEMPLATES_DIR } = await import('../src/env')

    // 真实模板拷入隔离 templates 目录（loadTemplate 读隔离 workspace；探针不触碰真实工作区）
    mkdirSync(TEMPLATES_DIR, { recursive: true })
    cpSync(join(REPO_ROOT, 'workspace', 'templates', 'mengbao-episode.yaml'), join(TEMPLATES_DIR, 'mengbao-episode.yaml'))

    const tpl = loadTemplate('mengbao-episode', true)
    // v10（3660aef「以音定画」）：gen_motion 新增 after=voice + inputs.voices；步骤数/其余结构不变
    check(tpl.version === 10, `version=10（实际 ${tpl.version}）`)
    const gm = tpl.steps.find((s) => s.key === 'gen_motion')
    check(!!gm && (gm.after ?? []).includes('voice') && gm.inputs['voices'] === 'steps.voice.assets', 'v10 以音定画：gen_motion 依赖 voice 并注入实测音频')
    const stepOf = (k: string) => tpl.steps.find((s) => s.key === k)
    const ms = stepOf('make_storyboard')
    check(!!ms && (ms.after ?? []).includes('cast_lines'), 'make_storyboard.after 含 cast_lines')
    check(ms?.inputs['lines'] === 'steps.cast_lines.asset', `inputs.lines 指向台词表（实际 ${String(ms?.inputs['lines'])}）`)
    check(stepOf('cast_lines')?.params?.['output_purpose'] === 'lines', 'cast_lines output_purpose=lines')
    const mp = (stepOf('compose_video')?.params ?? {}) as Record<string, unknown>
    check(
      mp['transition'] === 'none' && mp['transition_duration'] === 0.5 && mp['bgm_volume'] === 0.25 && mp['bgm_fade'] === 2,
      'compose_video.params M11 四键默认值（none/0.5/0.25/2）',
    )

    // ---- v8 快照（存量 run）：快照优先，行为不随 v10 文件漂移 ----
    const v8 = JSON.parse(JSON.stringify(tpl)) as {
      key: string
      version: number
      steps: Array<{ key: string; after?: string[]; inputs: Record<string, unknown>; params?: Record<string, unknown> }>
    }
    v8.version = 8
    const ms8 = v8.steps.find((s) => s.key === 'make_storyboard')!
    ms8.after = (ms8.after ?? []).filter((k) => k !== 'cast_lines')
    delete ms8.inputs['lines']
    const mg8 = v8.steps.find((s) => s.key === 'compose_video')!
    for (const k of ['transition', 'transition_duration', 'bgm_volume', 'bgm_fade']) delete (mg8.params ?? {})[k]

    const loadedV8 = templateForRun({ templateKey: 'mengbao-episode', templateSnapshot: JSON.stringify(v8) })
    check(loadedV8.version === 8 && loadedV8.steps.length === tpl.steps.length, `v8 快照加载（version=${loadedV8.version}，steps=${loadedV8.steps.length}）`)
    const lms = loadedV8.steps.find((s) => s.key === 'make_storyboard')!
    check(!(lms.after ?? []).includes('cast_lines') && !('lines' in lms.inputs), 'v8 快照无 M11 特征（不被新版文件注入）')
    const lmg = loadedV8.steps.find((s) => s.key === 'compose_video')!
    check(!('transition' in (lmg.params ?? {})), 'v8 快照 compose 参数无 M11 键')

    // ---- 无快照 → 文件 v10；损坏快照 → 回退文件 ----
    const noSnap = templateForRun({ templateKey: 'mengbao-episode', templateSnapshot: null })
    check(noSnap.version === 10, '无快照 → v10 文件加载')
    const badSnap = templateForRun({ templateKey: 'mengbao-episode', templateSnapshot: 'junk' })
    check(badSnap.version === 10, '损坏快照 → 回退文件加载')
  }

  // ================= 分发 =================

  // [M11 split] 行级 helpers 经 ctx 注入拆出的四节（probes/m11/modules/*，断言逐字保留）
  const m11Ctx = {
    db, pid, T0, REPO_ROOT, check, errOf,
    getRun, getStep, getAsset, getTask,
    setRunStatus, setStepStatus, mkStep, seedRun,
    absPathOf, ensureProjectDirs, registerAsset, relPathOf,
  }
  const runners: Record<string, () => Promise<void>> = {
    rerun: async () => (await import('./probes/m11/modules/cascade')).sectionRerun(m11Ctx),
    cascade: async () => (await import('./probes/m11/modules/cascade')).sectionCascade(m11Ctx),
    align: sectionAlign,
    bgm: async () => (await import('./probes/m11/modules/bgm')).sectionBgm(m11Ctx),
    transition: sectionTransition,
    template: sectionTemplate,
    regression: async () => (await import('./probes/m11/modules/regression')).sectionRegression(m11Ctx),
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
    console.log(`\n==== M11 探针结果: ${failed > 0 ? `${failed} 项失败` : '全部通过'} ====`)
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
