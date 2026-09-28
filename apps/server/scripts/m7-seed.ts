/**
 * probe-m7 探针 · 共享夹具与种子（自 probe-m7.ts 拆出：m26 split-audit 红线单文件 ≤800 行）。
 * 文件名故意不带 probe- 前缀：本模块是被主探针 import 的库，不是可独立执行的探针
 * （run-probes 按 probe-*.ts 扫描）。db / 表 / eq / storage 原语由主探针 main() 在
 * 环境隔离 + 动态 import src 之后注入（保持「env 先于 src 加载」不变量，行为零变更）。
 * 零网络、零计费：直测服务层函数，不触发引擎执行与真实生成。
 */
import { writeFileSync } from 'node:fs'

/** 分镜 JSON（2 镜；s01 无时长 → null；s02 用 LLM 口径 duration_sec=2.5 → 回退读取） */
export const SHOTS_JSON = JSON.stringify(
  {
    shots: [
      { id: 's01', image_prompt: '晨光中的小镇', motion_prompt: '缓慢推进镜头' },
      { id: 's02', image_prompt: '集市人群', duration_sec: 2.5 },
    ],
  },
  null,
  2,
)

export interface Seed {
  runId: number
  sbStepId: number
  imgStepId: number
  motionStepId: number
  mergeStepId: number
  sbId: number
  t1: number
  t2: number
  t3: number
  a1v1: number
  a1v2: number
  a2: number
  m1: number
  final: number
  sbRel: string
}

/**
 * 注入依赖（探针夹具层：db/表/eq 为运行时动态 import 的实例，此处以结构化宽松类型承接，
 * 与主探针共享同一实例——同 probe-precision-rework-sections 的 setApi 注入范式）。
 */
export interface SeedDeps {
  db: any
  assets: any
  genTasks: any
  pipelineRuns: any
  pipelineSteps: any
  eq: any
  relPathOf: (projectId: number, purpose: string, name: string) => string
  absPathOf: (rel: string) => string
  pid: number
  T0: number
}

/** 构建 m7 种子工具集：行级 helpers + seedRun（4 步骤 / 3 任务 / 6 资产的 completed run）。 */
export function createSeedKit(deps: SeedDeps) {
  const { db, assets, genTasks, pipelineRuns, pipelineSteps, eq, relPathOf, absPathOf, pid, T0 } = deps

  // ---- 行级 helpers ----
  const getRun = async (id: number) => (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)).limit(1))[0]!
  const getStep = async (id: number) => (await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, id)).limit(1))[0]!
  const getTask = async (id: number) => (await db.select().from(genTasks).where(eq(genTasks.id, id)).limit(1))[0]!
  const getAsset = async (id: number) => (await db.select().from(assets).where(eq(assets.id, id)).limit(1))[0]!
  const setRunStatus = (id: number, status: string) => db.update(pipelineRuns).set({ status }).where(eq(pipelineRuns.id, id))
  const setStepOutput = (id: number, output: unknown) => db.update(pipelineSteps).set({ output: JSON.stringify(output) }).where(eq(pipelineSteps.id, id))

  const mkStepId = async (runId: number, seq: number, stepKey: string, actionKey: string, status = 'succeeded'): Promise<number> =>
    (
      await db
        .insert(pipelineSteps)
        .values({ runId, seq, stepKey, actionKey, title: stepKey, status, createdAt: T0 + seq, updatedAt: T0 + seq })
        .returning()
    )[0]!.id

  /**
   * 种子 run（completed；4 步骤 / 3 任务 / 6 资产）：
   * make_storyboard(ai_text, output={asset_ids:[sb], gate}) → gen_images(ai_image, 2 任务×版本组)
   * → gen_motion(ai_video, 1 任务) → compose_video(ffmpeg_merge, 成片含 inputs 快照)。
   */
  const seedRun = async (): Promise<Seed> => {
    const runId = (
      await db
        .insert(pipelineRuns)
        .values({
          projectId: pid,
          templateKey: 'mengbao-episode',
          status: 'completed',
          input: '{}',
          startedAt: T0,
          completedAt: T0 + 60,
          createdAt: T0,
          updatedAt: T0 + 60,
        })
        .returning()
    )[0]!.id

    const sbStepId = await mkStepId(runId, 1, 'make_storyboard', 'ai_text')
    const imgStepId = await mkStepId(runId, 2, 'gen_images', 'ai_image')
    const motionStepId = await mkStepId(runId, 3, 'gen_motion', 'ai_video')
    const mergeStepId = await mkStepId(runId, 4, 'compose_video', 'ffmpeg_merge')

    // 分镜文本资产（真实文件：edit 节 readTextAsset 依赖）
    const sbRel = relPathOf(pid, 'storyboard', `m7-storyboard-${runId}.json`)
    writeFileSync(absPathOf(sbRel), SHOTS_JSON)
    const sbId = (
      await db
        .insert(assets)
        .values({
          projectId: pid,
          stepId: sbStepId,
          runId,
          kind: 'text',
          purpose: 'storyboard',
          name: 'storyboard.json',
          mime: 'application/json',
          ext: 'json',
          relPath: sbRel,
          fileSize: Buffer.byteLength(SHOTS_JSON),
          tags: '[]',
          createdAt: T0 + 5,
          updatedAt: T0 + 5,
        })
        .returning()
    )[0]!.id

    // 图片产物（真实小文件；版本组升序由受控 createdAt 保证）
    const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    const mkImg = async (taskId: number, shotId: string, name: string, createdAt: number): Promise<number> => {
      const rel = relPathOf(pid, 'shot_image', `m7-${runId}-${name}`)
      writeFileSync(absPathOf(rel), pngBytes)
      return (
        await db
          .insert(assets)
          .values({
            projectId: pid,
            stepId: imgStepId,
            taskId,
            runId,
            kind: 'image',
            purpose: 'shot_image',
            name,
            mime: 'image/png',
            ext: 'png',
            fileSize: pngBytes.byteLength,
            relPath: rel,
            width: 1024,
            height: 1024,
            params: JSON.stringify({ shotId }),
            tags: '[]',
            createdAt,
            updatedAt: createdAt,
          })
          .returning()
      )[0]!.id
    }

    const mkTask = async (stepId: number, shotId: string, kind: string, createdAt: number): Promise<number> =>
      (
        await db
          .insert(genTasks)
          .values({
            projectId: pid,
            runId,
            stepId,
            kind,
            provider: 'probe',
            params: JSON.stringify({ shotId }),
            status: 'succeeded',
            attempts: 3,
            createdAt,
            updatedAt: createdAt,
            completedAt: createdAt,
          })
          .returning()
      )[0]!.id

    const t1 = await mkTask(imgStepId, 's01', 'image', T0 + 10)
    const t2 = await mkTask(imgStepId, 's02', 'image', T0 + 11)
    const t3 = await mkTask(motionStepId, 's01', 'video', T0 + 12)

    const a1v1 = await mkImg(t1, 's01', 's01-v1.png', T0 + 15)
    const a1v2 = await mkImg(t1, 's01', 's01-v2.png', T0 + 16)
    const a2 = await mkImg(t2, 's02', 's02-v1.png', T0 + 17)

    // 动效片（DB duration=5 字段在；文件为占位）
    const mRel = relPathOf(pid, 'motion_clip', `m7-${runId}-s01-motion.mp4`)
    writeFileSync(absPathOf(mRel), Buffer.from('probe-m7-video-placeholder'))
    const m1 = (
      await db
        .insert(assets)
        .values({
          projectId: pid,
          stepId: motionStepId,
          taskId: t3,
          runId,
          kind: 'video',
          purpose: 'motion_clip',
          name: 's01-motion.mp4',
          mime: 'video/mp4',
          ext: 'mp4',
          relPath: mRel,
          duration: 5,
          params: JSON.stringify({ shotId: 's01' }),
          tags: '[]',
          createdAt: T0 + 18,
          updatedAt: T0 + 18,
        })
        .returning()
    )[0]!.id

    // 成片（inputs 快照 = stale 检测数据源）
    const final = (
      await db
        .insert(assets)
        .values({
          projectId: pid,
          stepId: mergeStepId,
          runId,
          kind: 'video',
          purpose: 'final_video',
          name: 'final.mp4',
          mime: 'video/mp4',
          ext: 'mp4',
          relPath: null,
          duration: 9,
          params: JSON.stringify({ inputs: { images: [a1v2, a2], motion_clips: [m1], shots_source: sbId } }),
          tags: JSON.stringify(['final']),
          createdAt: T0 + 50,
          updatedAt: T0 + 50,
        })
        .returning()
    )[0]!.id

    // resultAssetId 回填（reset 全量的数据源）+ output/input 回填
    await db.update(genTasks).set({ resultAssetId: a1v2 }).where(eq(genTasks.id, t1))
    await db.update(genTasks).set({ resultAssetId: a2 }).where(eq(genTasks.id, t2))
    await db.update(genTasks).set({ resultAssetId: m1 }).where(eq(genTasks.id, t3))
    await db.update(pipelineSteps).set({ input: JSON.stringify({ shots: [sbId] }) }).where(eq(pipelineSteps.id, imgStepId))
    await db.update(pipelineSteps).set({ input: JSON.stringify({ shots: [sbId] }) }).where(eq(pipelineSteps.id, motionStepId))
    await db
      .update(pipelineSteps)
      .set({ input: JSON.stringify({ shots: [sbId], images: [a1v2, a2], motion_clips: [m1] }) })
      .where(eq(pipelineSteps.id, mergeStepId))
    await setStepOutput(sbStepId, { asset_ids: [sbId], gate: { status: 'keep-me' } })
    await setStepOutput(imgStepId, { asset_ids: [a1v2, a2] })
    await setStepOutput(motionStepId, { asset_ids: [m1] })
    await setStepOutput(mergeStepId, { asset_ids: [final] })

    return { runId, sbStepId, imgStepId, motionStepId, mergeStepId, sbId, t1, t2, t3, a1v1, a1v2, a2, m1, final, sbRel }
  }

  return { getRun, getStep, getTask, getAsset, setRunStatus, setStepOutput, mkStepId, seedRun }
}
