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
 *              parseShotLines + planSrtShifts + shiftSrtText（平移/零平移/数量不符/负值收敛）
 *   bgm        compose-config：上传/复制行绑定、替换软删、隔离、移除 + 校验矩阵 +
 *              updateComposeConfig（白名单/枚举/clamp/合并写）+ readComposeConfig 容错
 *   transition buildTransitionPlan：videoLens/offsets/totalDur 数学 + clamp + 禁用矩阵 + round3
 *   template   模板 v9：make_storyboard after+inputs.lines / compose 四键默认值 / v8 快照优先兼容
 *   regression M7 零回归：computeShotSegments（均分/显式/估算）+ parseShotDurations 双口径 +
 *              对齐回退形态正交
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Asset } from '../src/db/schema'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
// 清理历史残留：libsql 在 Windows 下不释放文件句柄（close 后仍 EBUSY）——本进程退出时 db 文件必留；
// 本次运行在创建自己的目录前清掉旧的（占用中则跳过，自动收敛为最多一份）。
const TMP_PREFIX = 'acs-probe-m11-'
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

const SECTIONS = ['rerun', 'align', 'bgm', 'transition', 'template', 'regression'] as const

async function main(): Promise<void> {
  // src 模块全部动态加载（环境变量已隔离）
  const { db, initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')
  const { assets, genTasks, pipelineRuns, pipelineSteps, projects } = await import('../src/db/schema')
  const { eq } = await import('drizzle-orm')
  const { absPathOf, ensureProjectDirs, registerAsset, relPathOf } = await import('../src/services/storage')
  const { WorkbenchError, resetStepForRerun } = await import('../src/services/shot')

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

  const sectionRerun = async (): Promise<void> => {
    // ---- 复用模式（默认）：succeeded 任务不动、tasksReset = 非 succeeded 数 ----
    const s1 = await seedRun()
    const r1 = await resetStepForRerun(s1.runId, 'gen_images', {})
    check(
      r1.hasTasks && r1.tasksTotal === 2 && r1.tasksSucceeded === 1 && r1.tasksReset === 1,
      `复用模式计数（total=${r1.tasksTotal} succ=${r1.tasksSucceeded} reset=${r1.tasksReset}）`,
    )
    const t1r = await getTask(s1.t1)
    check(t1r.status === 'succeeded' && t1r.attempts === 3, '复用模式：succeeded 任务未动（status/attempts）')
    const t2r = await getTask(s1.t2)
    check(t2r.status === 'failed' && t2r.attempts === 2 && t2r.errorMsg === '生成失败', '复用模式：failed 任务未动（执行期幂等段归零）')
    const st1 = await getStep(s1.imgStepId)
    const ru1 = await getRun(s1.runId)
    check(st1.status === 'pending' && st1.error === null && st1.completedAt === null, 'step → pending（清 error/completedAt）')
    check(
      ru1.status === 'queued' && ru1.error === null && ru1.completedAt === null && ru1.currentStepKey === null,
      'run → queued（清 error/completedAt/currentStepKey）',
    )

    // ---- reset_tasks=true：全量归零 + resultAssetId 保留 ----
    const s2 = await seedRun()
    const r2 = await resetStepForRerun(s2.runId, 'gen_images', { resetTasks: true })
    check(r2.tasksTotal === 2 && r2.tasksSucceeded === 1 && r2.tasksReset === 2, `全量：tasksReset=total（${r2.tasksReset}）`)
    const t1r2 = await getTask(s2.t1)
    check(
      t1r2.status === 'pending' && t1r2.attempts === 0 && t1r2.completedAt === null && t1r2.errorMsg === null,
      '全量：succeeded 任务归零（pending/attempts/errorMsg/completedAt）',
    )
    check(t1r2.resultAssetId === s2.imgA, `全量：resultAssetId 保留（${t1r2.resultAssetId}）`)
    const t2r2 = await getTask(s2.t2)
    check(t2r2.status === 'pending' && t2r2.attempts === 0, '全量：failed 任务归零')

    // ---- 无任务步骤（ffmpeg_merge）：hasTasks=false 选项忽略 ----
    const s3 = await seedRun()
    const r3 = await resetStepForRerun(s3.runId, 'compose_video', {})
    check(!r3.hasTasks && r3.tasksTotal === 0 && r3.tasksReset === 0, '无任务步骤：hasTasks=false / tasksReset=0')
    const s4 = await seedRun()
    const r4 = await resetStepForRerun(s4.runId, 'compose_video', { resetTasks: true })
    check(!r4.hasTasks && r4.tasksReset === 0 && (await getRun(s4.runId)).status === 'queued', '无任务 + reset_tasks=true：不报错（选项忽略）')

    // ---- 校验拒绝矩阵 ----
    const s5 = await seedRun()
    const eNf = await errOf(() => resetStepForRerun(s5.runId, 'nope', {}))
    check(eNf instanceof WorkbenchError && eNf.code === 'not_found', '未知步骤 → not_found')
    const eSkip = await errOf(() => resetStepForRerun(s5.runId, 'subtitle', {}))
    check(eSkip instanceof WorkbenchError && eSkip.code === 'bad_step_status', 'skipped 目标 → bad_step_status')
    await setStepStatus(s5.voiceStepId, 'failed')
    const eOther = await errOf(() => resetStepForRerun(s5.runId, 'gen_images', {}))
    check(eOther instanceof WorkbenchError && eOther.code === 'other_failed', '存在其他失败步骤 → other_failed')
    await setStepStatus(s5.voiceStepId, 'succeeded')
    await setRunStatus(s5.runId, 'running')
    const eAct = await errOf(() => resetStepForRerun(s5.runId, 'gen_images', {}))
    check(eAct instanceof WorkbenchError && eAct.code === 'run_active', 'run running → run_active')
    await setRunStatus(s5.runId, 'queued')
    const eAct2 = await errOf(() => resetStepForRerun(s5.runId, 'gen_images', {}))
    check(eAct2 instanceof WorkbenchError && eAct2.code === 'run_active', 'run queued → run_active')
    await setRunStatus(s5.runId, 'cancelled')
    const eCan = await errOf(() => resetStepForRerun(s5.runId, 'gen_images', {}))
    check(eCan instanceof WorkbenchError && eCan.code === 'run_cancelled', 'run cancelled → run_cancelled')
    await setRunStatus(s5.runId, 'weird')
    const eBad = await errOf(() => resetStepForRerun(s5.runId, 'gen_images', {}))
    check(eBad instanceof WorkbenchError && eBad.code === 'bad_status', '未知 run 状态 → bad_status')
  }

  const sectionAlign = async (): Promise<void> => {
    const { parseShotLines, planVoiceAlignedSegments, planAudioDrivenShotDurations, planSrtShifts, shiftSrtText, srtTsToSec, secToSrtTs } = await import(
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
  }

  const sectionBgm = async (): Promise<void> => {
    const compose = await import('../src/services/compose-config')
    const s = await seedRun()
    const MP3 = new Uint8Array(Buffer.from('probe-m11-mp3'))

    // ---- 上传绑定：落盘 + 行属性 ----
    const r1 = await compose.bindBgmFromUpload(s.runId, { name: 'theme.mp3', data: MP3 })
    check(r1.kind === 'audio' && r1.purpose === 'bgm' && r1.runId === s.runId && r1.stepId === null, '上传绑定行属性（kind/purpose/runId/stepId=null）')
    check(!!r1.relPath && existsSync(absPathOf(r1.relPath)), '上传落盘存在')
    check((JSON.parse(r1.params ?? '{}') as Record<string, unknown>)['source'] === 'upload', 'params.source=upload')
    check((await compose.loadBgmAsset(s.runId))?.id === r1.id, 'loadBgmAsset 返回当前行')

    // ---- 复制行绑定：relPath 复用 + 源行不污染 ----
    const r2 = await compose.bindBgmFromAsset(s.runId, s.audioSrc)
    const srcRow = await getAsset(s.audioSrc)
    check(r2.relPath === srcRow.relPath && r2.name === srcRow.name, '复制行：relPath/name 复用源资产')
    const p2 = JSON.parse(r2.params ?? '{}') as Record<string, unknown>
    check(p2['source'] === 'asset' && p2['source_asset_id'] === s.audioSrc, 'params.source=asset + source_asset_id 回指')
    check((await getAsset(r1.id)).deletedAt !== null, '绑定替换：旧行软删')
    check((await getAsset(s.audioSrc)).deletedAt === null, '源资产行不被污染')
    check((await compose.loadBgmAsset(s.runId))?.id === r2.id, 'loadBgmAsset 最新有效行')

    // ---- 隔离：另一 run 不可见 ----
    const s2 = await seedRun()
    check((await compose.loadBgmAsset(s2.runId)) === null, 'run 隔离：另一 run 无 BGM')

    // ---- 移除：软删保留审计 ----
    await compose.removeBgm(s.runId)
    check((await compose.loadBgmAsset(s.runId)) === null, 'removeBgm → loadBgmAsset=null')
    check((await getAsset(r2.id)).deletedAt !== null, 'removeBgm 软删行（审计保留）')

    // ---- 校验拒绝矩阵 ----
    const eKind = await errOf(() => compose.bindBgmFromUpload(s.runId, { name: 'a.txt', data: MP3 }))
    check(eKind instanceof WorkbenchError && eKind.code === 'bad_kind', '非音频扩展名 → bad_kind')
    const eNo = await errOf(() => compose.bindBgmFromAsset(s.runId, 999999))
    check(eNo instanceof WorkbenchError && eNo.code === 'bad_asset', '不存在资产 → bad_asset')
    const eImg = await errOf(() => compose.bindBgmFromAsset(s.runId, s.imgA))
    check(eImg instanceof WorkbenchError && eImg.code === 'bad_asset', '非 audio 资产 → bad_asset')
    const pid2 = (
      await db
        .insert(projects)
        .values({ name: 'M11 探针项目2', genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!.id
    ensureProjectDirs(pid2)
    const crossRel = relPathOf(pid2, 'voice', 'm11-cross.mp3')
    writeFileSync(absPathOf(crossRel), MP3)
    const crossAudio = (await registerAsset(pid2, { name: 'cross.mp3', kind: 'audio', purpose: 'voice', relPath: crossRel, ext: 'mp3' })).id
    const eCross = await errOf(() => compose.bindBgmFromAsset(s.runId, crossAudio))
    check(eCross instanceof WorkbenchError && eCross.code === 'bad_asset', '跨项目资产 → bad_asset')
    const delRel = relPathOf(pid, 'voice', 'm11-del.mp3')
    writeFileSync(absPathOf(delRel), MP3)
    const delAudio = (await registerAsset(pid, { name: 'del.mp3', kind: 'audio', purpose: 'voice', relPath: delRel, ext: 'mp3' })).id
    await db.update(assets).set({ deletedAt: Date.now() }).where(eq(assets.id, delAudio))
    const eDel = await errOf(() => compose.bindBgmFromAsset(s.runId, delAudio))
    check(eDel instanceof WorkbenchError && eDel.code === 'bad_asset', '已删除资产 → bad_asset')
    await setRunStatus(s.runId, 'running')
    const eAct = await errOf(() => compose.bindBgmFromUpload(s.runId, { name: 'x.mp3', data: MP3 }))
    check(eAct instanceof WorkbenchError && eAct.code === 'run_active', '活跃 run → run_active')
    await setRunStatus(s.runId, 'completed')

    // ---- updateComposeConfig：合并写 / clamp / 白名单 / 枚举 ----
    const u1 = await compose.updateComposeConfig(s.runId, { transition: 'fade', transition_duration: 0.5, bgm_volume: 0.25 })
    check(u1.transition === 'fade' && u1.transition_duration === 0.5 && u1.bgm_volume === 0.25, '三键写入')
    const inputObj = JSON.parse((await getRun(s.runId)).input) as Record<string, unknown>
    check(inputObj['episode_number'] === 7 && inputObj['with_voice'] === true, '合并写：他键不丢（episode_number/with_voice）')
    check((inputObj['_compose'] as { transition?: string }).transition === 'fade', 'run.input._compose 已写入')
    const u2 = await compose.updateComposeConfig(s.runId, { transition_duration: 9, bgm_volume: 1.5, bgm_fade: 5 })
    check(u2.transition_duration === 2 && u2.bgm_volume === 1 && u2.bgm_fade === 2, 'clamp 上限（2/1/2）')
    const u3 = await compose.updateComposeConfig(s.runId, { transition_duration: 0, bgm_volume: -1, bgm_fade: -1 })
    check(u3.transition_duration === 0.1 && u3.bgm_volume === 0 && u3.bgm_fade === 0, 'clamp 下限（0.1/0/0）')
    check(u3.transition === 'fade', '部分 patch 合并保留未提及键（transition）')
    const eEnum = await errOf(() => compose.updateComposeConfig(s.runId, { transition: 'wipe' }))
    check(eEnum instanceof WorkbenchError && eEnum.code === 'bad_field', 'transition 枚举拒绝')
    const eKey = await errOf(() => compose.updateComposeConfig(s.runId, { foo: 1 }))
    check(eKey instanceof WorkbenchError && eKey.code === 'bad_field', '未知键拒绝（白名单）')
    const eType = await errOf(() => compose.updateComposeConfig(s.runId, { bgm_volume: 'x' }))
    check(eType instanceof WorkbenchError && eType.code === 'bad_field', '非数字拒绝')
    const eNaN = await errOf(() => compose.updateComposeConfig(s.runId, { bgm_volume: Number.NaN }))
    check(eNaN instanceof WorkbenchError && eNaN.code === 'bad_field', 'NaN 拒绝（非有限数）')

    // ---- readComposeConfig 容错 + 聚合读 ----
    check(JSON.stringify(compose.readComposeConfig(null)) === '{}', 'null → {}')
    check(JSON.stringify(compose.readComposeConfig('junk')) === '{}', '坏 JSON → {}')
    check(JSON.stringify(compose.readComposeConfig('{"_compose":[]}')) === '{}', '数组形态 → {}')
    check(compose.readComposeConfig('{"_compose":{"bgm_fade":1}}').bgm_fade === 1, '合法解析')
    const gc = await compose.getComposeConfig(s.runId)
    check(gc.config.transition === 'fade' && gc.bgm === null, '聚合读（config=已写 / bgm=已移除）')
    await setRunStatus(s2.runId, 'running')
    const eGc = await errOf(() => compose.getComposeConfig(s2.runId))
    check(eGc instanceof WorkbenchError && eGc.code === 'run_active', 'getComposeConfig 活跃拒绝')
    await setRunStatus(s2.runId, 'completed')

    // ---- 枚举 ----
    check(compose.TRANSITIONS.length === 6 && (compose.TRANSITIONS as readonly string[]).includes('dissolve'), 'TRANSITIONS 六枚举')
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
    check(tpl.version === 9, `version=9（实际 ${tpl.version}）`)
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

    // ---- v8 快照（存量 run）：快照优先，行为不随 v9 文件漂移 ----
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
    check(!(lms.after ?? []).includes('cast_lines') && !('lines' in lms.inputs), 'v8 快照无 M11 特征（不被 v9 注入）')
    const lmg = loadedV8.steps.find((s) => s.key === 'compose_video')!
    check(!('transition' in (lmg.params ?? {})), 'v8 快照 compose 参数无 M11 键')

    // ---- 无快照 → 文件 v9；损坏快照 → 回退文件 ----
    const noSnap = templateForRun({ templateKey: 'mengbao-episode', templateSnapshot: null })
    check(noSnap.version === 9, '无快照 → v9 文件加载')
    const badSnap = templateForRun({ templateKey: 'mengbao-episode', templateSnapshot: 'junk' })
    check(badSnap.version === 9, '损坏快照 → 回退文件加载')
  }

  const sectionRegression = async (): Promise<void> => {
    const { computeShotSegments, parseShotDurations, planVoiceAlignedSegments } = await import('../src/pipeline/actions/ffmpeg-merge')

    // 真实文件（images 不读内容；clips 空文件探测必失败 → 估算路径）
    const okRel1 = relPathOf(pid, 'shot_image', 'm11-plan-1.png')
    const okRel2 = relPathOf(pid, 'shot_image', 'm11-plan-2.png')
    const okRel3 = relPathOf(pid, 'motion_clip', 'm11-plan-3.mp4')
    const okRel4 = relPathOf(pid, 'motion_clip', 'm11-plan-4.mp4')
    const missingRel = relPathOf(pid, 'shot_image', 'm11-plan-missing.png')
    for (const rel of [okRel1, okRel2, okRel3, okRel4]) writeFileSync(absPathOf(rel), Buffer.from('m11'))

    const row = (id: number, kind: string, relPath: string | null, shotId: string | null, duration?: number): Asset =>
      ({ id, kind, relPath, duration: duration ?? null, params: shotId ? JSON.stringify({ shotId }) : null }) as unknown as Asset

    // ---- 均分场景（无 per-shot 覆盖；fit_voice 均分基线）----
    const imgA = row(201, 'image', okRel1, 's01')
    const imgB = row(202, 'image', okRel2, 's02')
    const r1 = computeShotSegments([imgA, imgB], 'images', new Map(), 4)
    check(r1.segments.length === 2 && r1.segments.every((s) => s.durSec === 4 && !s.explicit), '均分：全镜 duration_per_shot=4（非 explicit）')

    // ---- 显式场景（per-shot 覆盖 + 容错；fit_voice explicit 分区输入）----
    const noRel = row(203, 'image', null, 's03')
    const miss = row(204, 'image', missingRel, 's04')
    const wrongKind = row(205, 'video', okRel3, 's05')
    const r2 = computeShotSegments([imgA, imgB, noRel, miss, wrongKind], 'images', new Map([['s01', 6.5]]), 4)
    check(r2.segments.length === 2 && r2.skipped.length === 3, `显式：2 段 / 3 跳过（实际 ${r2.segments.length}/${r2.skipped.length}）`)
    check(
      JSON.stringify(r2.skipped) === JSON.stringify([203, 204, 205]),
      `skipped 顺序（缺 relPath → 缺文件 → kind 不符；实际 [${r2.skipped}]）`,
    )
    check(
      r2.segments[0]!.durSec === 6.5 && r2.segments[0]!.explicit === true && r2.segments[1]!.durSec === 4 && !r2.segments[1]!.explicit,
      'explicit 标记与 M7 一致（fit_voice 分区输入）',
    )

    // ---- clips：DB duration 优先 → 探测失败估算 ----
    const v1 = row(206, 'video', okRel3, 's06', 5)
    const v2 = row(207, 'video', okRel4, 's07')
    const r3 = computeShotSegments([v1, v2], 'clips', new Map(), 4)
    check(r3.segments[0]!.durSec === 5 && !r3.segments[0]!.estimated, 'DB duration 优先（非估算）')
    check(r3.segments[1]!.durSec === 4 && r3.segments[1]!.estimated === true, '探测失败 → duration_per_shot 估算（estimated）')

    // ---- 空输入 ----
    const r4 = computeShotSegments([], 'images', new Map(), 4)
    check(r4.segments.length === 0 && r4.skipped.length === 0, '空输入 → 空结果')

    // ---- parseShotDurations：双口径回退 + 形态容错 ----
    const pd = parseShotDurations(
      JSON.stringify({ shots: [{ id: 's01', duration: 3 }, { id: 's02', duration_sec: 2.5 }, { id: 5, duration: 2 }, null] }),
    )
    check(pd.size === 2 && pd.get('s01') === 3 && pd.get('s02') === 2.5, 'parseShotDurations 双口径（duration 优先 / duration_sec 回退）')
    const pdArr = parseShotDurations(JSON.stringify([{ id: 'a', duration_sec: 1.5 }]))
    check(pdArr.size === 1 && pdArr.get('a') === 1.5, '裸数组形态')
    const ePd = await errOf(async () => parseShotDurations('not-json'))
    check(ePd instanceof SyntaxError, '坏 JSON 抛错（调用侧兜底）')

    // ---- 对齐回退正交：fail 形态不产生段/句（主路径仅 aligned 才赋值 durSec）----
    const failPlan = planVoiceAlignedSegments([{ id: 's01', durationSec: null, lineIds: [] }], new Map(), 4, { hasLinesField: true })
    check(
      !failPlan.aligned && failPlan.segments.length === 0 && failPlan.lines.length === 0 && failPlan.totalDur === 0,
      '对齐回退形态（segments/lines 空、totalDur=0——computeShotSegments 输出不受影响）',
    )
  }

  // ================= 分发 =================

  const runners: Record<string, () => Promise<void>> = {
    rerun: sectionRerun,
    align: sectionAlign,
    bgm: sectionBgm,
    transition: sectionTransition,
    template: sectionTemplate,
    regression: sectionRegression,
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
