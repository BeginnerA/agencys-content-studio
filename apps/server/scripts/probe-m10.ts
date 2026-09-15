/**
 * M10 探针（分镜编辑器：结构性编辑 ops + 上传替换）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m10.ts [--section=ops|output|upload|board|select|regression]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录
 * （独立 studio.db + workspace），不触碰开发库（同 probe-m3~m9）。零网络、零计费：
 * 直测服务层函数与纯函数，不触发引擎执行与真实生成。
 *
 * section（默认 all）：
 *   ops        applyStoryboardOps：reorder/add/remove/patch 合法 + 非法矩阵 + 多 op 序列
 *   output     联动重写：output 重建（新序/删除/未生成跳过/上传保留）+ producer 保位替换链
 *   upload     importShotAsset：落盘/复制行/kind 校验 + uploadAndBindShotAsset 组合 + 绑定矩阵
 *   board      buildShotBoard：upload 版本组（source）/ raw 字段 / selectedAssetId
 *   select     applyShotSelection 放宽：上传资产可选 + 非本步骤/跨镜拒绝
 *   regression M7 语义回归：applyStoryboardEdits 不变 + edit→mutate 链 + reset 不含上传
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
// 清理历史残留：libsql 在 Windows 下不释放文件句柄（close 后仍 EBUSY）——本进程退出时 db 文件必留；
// 本次运行在创建自己的目录前清掉旧的（占用中则跳过，自动收敛为最多一份）。
const TMP_PREFIX = 'acs-probe-m10-'
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

const SECTIONS = ['ops', 'output', 'upload', 'board', 'select', 'regression'] as const

/** 分镜 JSON（2 镜；s01 无时长；s02 用 LLM 口径 duration_sec=2.5） */
const SHOTS_JSON = JSON.stringify(
  {
    shots: [
      { id: 's01', image_prompt: '晨光中的小镇', motion_prompt: '缓慢推进镜头' },
      { id: 's02', image_prompt: '集市人群', duration_sec: 2.5 },
    ],
  },
  null,
  2,
)

async function main(): Promise<void> {
  // src 模块全部动态加载（环境变量已隔离）
  const { db, initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')
  const { assets, genTasks, pipelineRuns, pipelineSteps, projects } = await import('../src/db/schema')
  const { eq } = await import('drizzle-orm')
  const { absPathOf, ensureProjectDirs, readTextAsset, relPathOf, sha256Hex } = await import('../src/services/storage')
  const {
    WorkbenchError,
    applyShotSelection,
    applyStoryboardEdits,
    applyStoryboardOps,
    bindUploadedShotAsset,
    buildShotBoard,
    importShotAsset,
    reorderShots,
    uploadAndBindShotAsset,
  } = await import('../src/services/shot')

  const log = createLogger('probe-m10')
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
      .values({ name: 'M10 探针项目', genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
      .returning()
  )[0]!.id
  ensureProjectDirs(pid)

  // ---- 上传用字节（kind 由扩展名判定；bytes 决定 sha256） ----
  const PNG_A = new Uint8Array(Buffer.from('probe-m10-png-a'))
  const PNG_B = new Uint8Array(Buffer.from('probe-m10-png-b'))
  const PNG_C = new Uint8Array(Buffer.from('probe-m10-png-c'))
  const TXT = new Uint8Array(Buffer.from('probe-m10-txt'))
  const MP4 = new Uint8Array(Buffer.from('probe-m10-mp4'))

  // ---- 行级 helpers ----
  const getRun = async (id: number) => (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)).limit(1))[0]!
  const getStep = async (id: number) => (await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, id)).limit(1))[0]!
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

  interface Seed {
    runId: number
    sbStepId: number
    imgStepId: number
    motionStepId: number
    mergeStepId: number
    sbId: number
    final: number
    t1: number
    t2: number
    t3: number
    a1v1: number
    a1v2: number
    a2: number
    m1: number
    sbRel: string
  }

  /**
   * 种子 run（completed；3 步骤 / 3 任务 / 5 资产）：
   * make_storyboard(ai_text, output={asset_ids:[sb], gate}) → gen_images(ai_image, 2 任务×版本组)
   * → gen_motion(ai_video, 1 任务)。output 基线：[a1v2, a2] / [m1]。
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

    // 分镜文本资产（真实文件：edit/mutate 节 readTextAsset 依赖）
    const sbRel = relPathOf(pid, 'storyboard', `m10-storyboard-${runId}.json`)
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
      const rel = relPathOf(pid, 'shot_image', `m10-${runId}-${name}`)
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
    const mRel = relPathOf(pid, 'shot_video', `m10-${runId}-s01-motion.mp4`)
    writeFileSync(absPathOf(mRel), Buffer.from('probe-m10-video-placeholder'))
    const m1 = (
      await db
        .insert(assets)
        .values({
          projectId: pid,
          stepId: motionStepId,
          taskId: t3,
          runId,
          kind: 'video',
          purpose: 'shot_video',
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

    // resultAssetId 回填（reset 全量的数据源）+ output/input 回填
    await db.update(genTasks).set({ resultAssetId: a1v2 }).where(eq(genTasks.id, t1))
    await db.update(genTasks).set({ resultAssetId: a2 }).where(eq(genTasks.id, t2))
    await db.update(genTasks).set({ resultAssetId: m1 }).where(eq(genTasks.id, t3))
    await db.update(pipelineSteps).set({ input: JSON.stringify({ shots: [sbId] }) }).where(eq(pipelineSteps.id, imgStepId))
    await db.update(pipelineSteps).set({ input: JSON.stringify({ shots: [sbId] }) }).where(eq(pipelineSteps.id, motionStepId))
    await setStepOutput(sbStepId, { asset_ids: [sbId], gate: { status: 'keep-me' } })
    await setStepOutput(imgStepId, { asset_ids: [a1v2, a2] })
    await setStepOutput(motionStepId, { asset_ids: [m1] })

    // 成片（inputs 快照刻意 shots_source=null：覆盖存量快照缺链的 stale 兜底路径）
    const fBytes = Buffer.from('probe-m10-final-placeholder')
    const fRel = relPathOf(pid, 'final_video', `m10-${runId}-final.mp4`)
    writeFileSync(absPathOf(fRel), fBytes)
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
          relPath: fRel,
          fileSize: fBytes.byteLength,
          params: JSON.stringify({ inputs: { images: [a1v2, a2], motion_clips: null, shots_source: null } }),
          tags: '[]',
          createdAt: T0 + 50,
          updatedAt: T0 + 50,
        })
        .returning()
    )[0]!.id
    await setStepOutput(mergeStepId, { asset_ids: [final] })

    return { runId, sbStepId, imgStepId, motionStepId, mergeStepId, sbId, final, t1, t2, t3, a1v1, a1v2, a2, m1, sbRel }
  }

  // ================= sections =================

  const sectionOps = async (): Promise<void> => {
    const s = await seedRun()

    // ---- reorder 合法 ----
    const r1 = await applyStoryboardOps(s.runId, 'gen_images', [{ op: 'reorder', order: ['s02', 's01'] }])
    check(r1.shots === 2, `reorder 镜头数不变（${r1.shots}）`)
    const j1 = JSON.parse(await readTextAsset(r1.assetId)) as { shots: Array<{ id: string }> }
    check(j1.shots[0]!.id === 's02' && j1.shots[1]!.id === 's01', 'JSON 顺序变化（s02 → s01）')
    check(JSON.stringify(r1.assetIds) === JSON.stringify([s.a2, s.a1v2]), `output 序随动 [a2,a1v2]（实际 [${r1.assetIds}]）`)
    const na1 = await getAsset(r1.assetId)
    check(na1.stepId === s.sbStepId && na1.name.includes('工作台编辑'), `新分镜资产归属/命名（${na1.name}）`)
    const p1 = JSON.parse(na1.params ?? '{}') as { ops?: string[]; source_asset_id?: number }
    check(JSON.stringify(p1.ops) === JSON.stringify(['reorder']) && p1.source_asset_id === s.sbId, 'params 记录（ops/source_asset_id）')

    // ---- reorder 非法矩阵 ----
    const reorderBad: Array<{ label: string; ops: unknown; want: string; msg?: string }> = [
      { label: '缺镜头', ops: [{ op: 'reorder', order: ['s01'] }], want: 'bad_order', msg: '缺少' },
      { label: '重复 id', ops: [{ op: 'reorder', order: ['s01', 's01'] }], want: 'bad_order', msg: '重复' },
      { label: '未知 id', ops: [{ op: 'reorder', order: ['s01', 's99'] }], want: 'bad_order', msg: '未知' },
      { label: 'order 非数组', ops: [{ op: 'reorder', order: 's01' }], want: 'bad_order' },
      { label: '空 ops 数组', ops: [], want: 'bad_ops' },
      { label: '未知操作', ops: [{ op: 'explode' }], want: 'bad_op' },
    ]
    for (const c of reorderBad) {
      const e = await errOf(() => applyStoryboardOps(s.runId, 'gen_images', c.ops as never))
      check(
        e instanceof WorkbenchError && e.code === c.want && (!c.msg || e.message.includes(c.msg)),
        `${c.label} → ${c.want}（实际 ${e instanceof WorkbenchError ? `${e.code}：${e.message}` : String(e)}）`,
      )
    }
    // 非法调用不产生新分镜资产（仍指向 r1）
    const sbOut1 = JSON.parse((await getStep(s.sbStepId)).output ?? '{}') as { asset_ids?: number[]; gate?: unknown }
    check(sbOut1.asset_ids?.[0] === r1.assetId, '非法调用不写新分镜（保位仍在 r1）')

    // ---- add ----
    const r2 = await applyStoryboardOps(s.runId, 'gen_images', [{ op: 'add', shot: { id: 's03', image_prompt: '林间追逐', duration: 4, characters: ['小美'] } }])
    const j2 = JSON.parse(await readTextAsset(r2.assetId)) as { shots: Array<{ id: string; image_prompt?: string }> }
    check(j2.shots.length === 3 && j2.shots[2]!.id === 's03' && j2.shots[2]!.image_prompt === '林间追逐', 'add 追加到尾部（s03）')
    check(JSON.stringify(r2.assetIds) === JSON.stringify([s.a2, s.a1v2]), '新镜无产物 → 跳过（output 不变）')

    const addBad: Array<{ label: string; op: unknown; want: string; msg?: string }> = [
      { label: 'id 重复', op: { op: 'add', shot: { id: 's01', image_prompt: 'x' } }, want: 'bad_add', msg: '已存在' },
      { label: 'id 非串', op: { op: 'add', shot: { id: 7, image_prompt: 'x' } }, want: 'bad_add' },
      { label: '缺 image_prompt', op: { op: 'add', shot: { id: 's04' } }, want: 'bad_add', msg: 'image_prompt' },
      { label: 'image_prompt 空白', op: { op: 'add', shot: { id: 's04', image_prompt: '  ' } }, want: 'bad_add' },
      { label: 'shot 非对象', op: { op: 'add', shot: 'x' }, want: 'bad_add' },
    ]
    for (const c of addBad) {
      const e = await errOf(() => applyStoryboardOps(s.runId, 'gen_images', [c.op] as never))
      check(
        e instanceof WorkbenchError && e.code === c.want && (!c.msg || e.message.includes(c.msg)),
        `add ${c.label} → ${c.want}（实际 ${e instanceof WorkbenchError ? e.code : String(e)}）`,
      )
    }
    const sbOut2 = JSON.parse((await getStep(s.sbStepId)).output ?? '{}') as { asset_ids?: number[] }
    check(sbOut2.asset_ids?.[0] === r2.assetId, '非法 add 不改变最新分镜（r2）')

    // ---- remove ----
    const r3 = await applyStoryboardOps(s.runId, 'gen_images', [{ op: 'remove', shot_id: 's03' }])
    const j3 = JSON.parse(await readTextAsset(r3.assetId)) as { shots: Array<{ id: string }> }
    check(j3.shots.length === 2 && !j3.shots.some((x) => x.id === 's03'), 'remove 正常（删 s03 → 2 镜）')
    const r4 = await applyStoryboardOps(s.runId, 'gen_images', [{ op: 'remove', shot_id: 's01' }])
    check(JSON.stringify(r4.assetIds) === JSON.stringify([s.a2]), `删除镜资产移除（[a2] 实际 [${r4.assetIds}]）`)
    const eMin = await errOf(() => applyStoryboardOps(s.runId, 'gen_images', [{ op: 'remove', shot_id: 's02' }]))
    check(eMin instanceof WorkbenchError && eMin.code === 'keep_min', '末镜拒绝（keep_min）')
    const eUn = await errOf(() => applyStoryboardOps(s.runId, 'gen_images', [{ op: 'remove', shot_id: 's99' }]))
    check(eUn instanceof WorkbenchError && eUn.code === 'unknown_shot', '未知镜头 remove → unknown_shot')

    // ---- patch ----
    const s2 = await seedRun()
    const r5 = await applyStoryboardOps(s2.runId, 'gen_images', [
      { op: 'patch', shot_id: 's02', fields: { duration: 3 } },
      { op: 'patch', shot_id: 's01', fields: { motion_prompt: '快速拉近', characters: ['小美', '阿宝'], weather: '晴' } },
    ])
    const j5 = JSON.parse(await readTextAsset(r5.assetId)) as {
      shots: Array<{ id: string; motion_prompt?: string; duration?: number; duration_sec?: number; characters?: string[]; weather?: string }>
    }
    check(j5.shots[1]!.duration === 3 && j5.shots[1]!.duration_sec === 3, 'duration 双写（duration=duration_sec=3）')
    check(j5.shots[0]!.motion_prompt === '快速拉近' && JSON.stringify(j5.shots[0]!.characters) === JSON.stringify(['小美', '阿宝']), 'patch 专用字段（motion_prompt/characters）')
    check(j5.shots[0]!.weather === '晴', '未知键透传（weather）')
    const p5 = JSON.parse((await getAsset(r5.assetId)).params ?? '{}') as { ops?: string[] }
    check(JSON.stringify(p5.ops) === JSON.stringify(['patch', 'patch']), 'params.ops 记录（patch×2）')

    const patchBad: Array<{ label: string; ops: unknown; want: string }> = [
      { label: 'id 修改', ops: [{ op: 'patch', shot_id: 's01', fields: { id: 'x' } }], want: 'bad_field' },
      { label: 'image_prompt 空白', ops: [{ op: 'patch', shot_id: 's01', fields: { image_prompt: ' ' } }], want: 'bad_field' },
      { label: 'duration 0', ops: [{ op: 'patch', shot_id: 's01', fields: { duration: 0 } }], want: 'bad_field' },
      { label: 'duration 61', ops: [{ op: 'patch', shot_id: 's01', fields: { duration: 61 } }], want: 'bad_field' },
      { label: 'characters 非数组', ops: [{ op: 'patch', shot_id: 's01', fields: { characters: '小美' } }], want: 'bad_field' },
      { label: 'characters 含空串', ops: [{ op: 'patch', shot_id: 's01', fields: { characters: [' '] } }], want: 'bad_field' },
      { label: '未知镜头', ops: [{ op: 'patch', shot_id: 's99', fields: { duration: 2 } }], want: 'unknown_shot' },
      { label: 'fields 非对象', ops: [{ op: 'patch', shot_id: 's01', fields: 5 }], want: 'bad_patch' },
    ]
    for (const c of patchBad) {
      const e = await errOf(() => applyStoryboardOps(s2.runId, 'gen_images', c.ops as never))
      check(e instanceof WorkbenchError && e.code === c.want, `patch ${c.label} → ${c.want}（实际 ${e instanceof WorkbenchError ? e.code : String(e)}）`)
    }

    // ---- 多 op 序列（端到端；每条在应用时点校验）----
    const s3 = await seedRun()
    const r6 = await applyStoryboardOps(s3.runId, 'gen_images', [
      { op: 'add', shot: { id: 's03', image_prompt: '新镜', duration: 2 } },
      { op: 'patch', shot_id: 's03', fields: { motion_prompt: '推进' } },
      { op: 'remove', shot_id: 's01' },
      { op: 'reorder', order: ['s03', 's02'] },
    ])
    const j6 = JSON.parse(await readTextAsset(r6.assetId)) as { shots: Array<{ id: string; motion_prompt?: string }> }
    check(j6.shots.length === 2 && j6.shots[0]!.id === 's03' && j6.shots[1]!.id === 's02', '多 op 序列（add→patch→remove→reorder）')
    check(j6.shots[0]!.motion_prompt === '推进', '序列 patch 命中 add 的新镜（应用时点校验）')
    check(JSON.stringify(r6.assetIds) === JSON.stringify([s3.a2]), `序列后 output 重建（s03 无产物跳过 / s01 删除移除）（实际 [${r6.assetIds}]）`)

    // ---- run 状态防呆 ----
    await setRunStatus(s3.runId, 'running')
    const eRun = await errOf(() => reorderShots(s3.runId, 'gen_images', ['s02', 's03']))
    check(eRun instanceof WorkbenchError && eRun.code === 'run_active', 'run running → run_active')
  }

  const sectionOutput = async (): Promise<void> => {
    const s = await seedRun()

    // ---- 重排 → output 按新序 + producer 保位替换 ----
    const r1 = await reorderShots(s.runId, 'gen_images', ['s02', 's01'])
    check(JSON.stringify(r1.assetIds) === JSON.stringify([s.a2, s.a1v2]), `重排后按新序 [a2,a1v2]（实际 [${r1.assetIds}]）`)
    const sbOut1 = JSON.parse((await getStep(s.sbStepId)).output ?? '{}') as { asset_ids?: number[] }
    check(sbOut1.asset_ids?.length === 1 && sbOut1.asset_ids[0] === r1.assetId, 'producer 保位替换（旧分镜 → 新分镜，位置不变）')

    // ---- 上传资产按映射保留 ----
    const up = await importShotAsset({ projectId: pid, id: s.runId }, await getStep(s.imgStepId), 's01', {
      name: 'output-保留.png',
      data: PNG_A,
    })
    const rb = await bindUploadedShotAsset(s.runId, 'gen_images', 's01', up.id)
    check(JSON.stringify(rb.assetIds) === JSON.stringify([s.a2, up.id]), `绑定上传（s01 位替换 → [a2,up]）（实际 [${rb.assetIds}]）`)
    const r2 = await reorderShots(s.runId, 'gen_images', ['s01', 's02'])
    check(JSON.stringify(r2.assetIds) === JSON.stringify([up.id, s.a2]), `重排后上传资产按映射保留（[up,a2]）（实际 [${r2.assetIds}]）`)

    // ---- 删除镜资产移除 ----
    const r3 = await applyStoryboardOps(s.runId, 'gen_images', [{ op: 'remove', shot_id: 's02' }])
    check(JSON.stringify(r3.assetIds) === JSON.stringify([up.id]), '删除 s02 → 资产移除 / 上传保留')

    // ---- 未生成镜头跳过（不产生 null 位）----
    const r4 = await applyStoryboardOps(s.runId, 'gen_images', [{ op: 'add', shot: { id: 's03', image_prompt: '空产物' } }])
    check(JSON.stringify(r4.assetIds) === JSON.stringify([up.id]), '新增无产物镜 → 跳过（output 不变）')

    // ---- 保位替换链（每次 mutate 均指向最新分镜；gate 全程保留）----
    const sbOut2 = JSON.parse((await getStep(s.sbStepId)).output ?? '{}') as { asset_ids?: number[]; gate?: unknown }
    check(sbOut2.asset_ids?.length === 1 && sbOut2.asset_ids[0] === r4.assetId, '替换链：始终单分镜位指向最新')
    check(JSON.stringify(sbOut2.gate) === JSON.stringify({ status: 'keep-me' }), 'gate 字段全程保留（链式替换不丢字段）')

    // ---- ai_video 板重建（视频侧）----
    const upM = await uploadAndBindShotAsset(s.runId, 'gen_motion', 's01', { name: 'motion-up.mp4', data: MP4 })
    check(JSON.stringify(upM.assetIds) === JSON.stringify([upM.asset.id]), `ai_video 上传绑定（[up]）（实际 [${upM.assetIds}]）`)
  }

  const sectionUpload = async (): Promise<void> => {
    const s = await seedRun()
    const imgStep = await getStep(s.imgStepId)
    const motionStep = await getStep(s.motionStepId)
    const runRef = { projectId: pid, id: s.runId }

    // ---- 新文件落盘 ----
    const r1 = await importShotAsset(runRef, imgStep, 's01', { name: '我的上传.png', data: PNG_A })
    check(r1.kind === 'image' && r1.purpose === 'shot_image' && r1.taskId === null, '行属性（image/shot_image/taskId=null）')
    check(r1.stepId === s.imgStepId && r1.runId === s.runId, '归属（stepId=gen_images / runId）')
    check(!!r1.relPath && r1.relPath.includes('images') && !r1.relPath.includes('video'), `relPath 在 images 子目录（${r1.relPath}）`)
    check(r1.relPath !== null && existsSync(absPathOf(r1.relPath)), '文件实际落盘')
    const p1 = JSON.parse(r1.params ?? '{}') as { shotId?: string; source?: string; original_name?: string }
    check(p1.shotId === 's01' && p1.source === 'upload' && p1.original_name === '我的上传.png', 'params（shotId/source/original_name）')
    check(r1.sha256 === sha256Hex(PNG_A) && r1.ext === 'png' && r1.mime === 'image/png', 'sha256/ext/mime 记录')

    // ---- sha256 命中 → 复制行（用途独立，文件复用）----
    const r2 = await importShotAsset(runRef, imgStep, 's02', { name: '二次上传.png', data: PNG_A })
    check(r2.id !== r1.id, '命中 → 复制为独立新行')
    check(r2.relPath === r1.relPath && r2.sha256 === r1.sha256, 'relPath/sha256 复用（文件不重复落盘）')
    check(r2.name === '二次上传.png', '新行独立命名')
    check((JSON.parse(r2.params ?? '{}') as { shotId?: string }).shotId === 's02', '新行用途独立（shotId=s02）')
    const r1After = await getAsset(r1.id)
    check(r1After.name === '我的上传.png' && (JSON.parse(r1After.params ?? '{}') as { shotId?: string }).shotId === 's01', '原行不被污染')

    // ---- kind 校验 ----
    const eTxt = await errOf(() => importShotAsset(runRef, imgStep, 's01', { name: 'note.txt', data: TXT }))
    check(eTxt instanceof WorkbenchError && eTxt.code === 'bad_kind', '图步传 txt → bad_kind')
    const eImg2Video = await errOf(() => importShotAsset(runRef, motionStep, 's01', { name: 'pic.png', data: PNG_A }))
    check(eImg2Video instanceof WorkbenchError && eImg2Video.code === 'bad_kind', '视频步传图 → bad_kind')
    const r3 = await importShotAsset(runRef, motionStep, 's01', { name: 'clip.mp4', data: MP4 })
    check(r3.kind === 'video' && r3.purpose === 'shot_video' && !!r3.relPath && r3.relPath.includes('video'), '视频步收 video（shot_video / video 子目录）')

    // ---- uploadAndBindShotAsset 组合 ----
    const r4 = await uploadAndBindShotAsset(s.runId, 'gen_images', 's02', { name: 's02替换.png', data: PNG_B })
    check(JSON.stringify(r4.assetIds) === JSON.stringify([s.a1v2, r4.asset.id]), `组合：该镜位替换（[a1v2,up]）（实际 [${r4.assetIds}]）`)
    check((JSON.parse(r4.asset.params ?? '{}') as { shotId?: string }).shotId === 's02', '组合资产 params 归镜')

    // ---- 无产物镜首次上传（按分镜序插入）----
    await setStepOutput(s.imgStepId, { asset_ids: [s.a2] }) // s01 无产物
    const r5 = await uploadAndBindShotAsset(s.runId, 'gen_images', 's01', { name: 's01首发.png', data: PNG_C })
    check(JSON.stringify(r5.assetIds) === JSON.stringify([r5.asset.id, s.a2]), `无产物镜首次上传 → 分镜序插入（[up,a2]）（实际 [${r5.assetIds}]）`)

    // ---- 绑定既有（重绑上传资产 / 任务产物）----
    const r6 = await bindUploadedShotAsset(s.runId, 'gen_images', 's01', r1.id)
    check(JSON.stringify(r6.assetIds) === JSON.stringify([r1.id, s.a2]), '重绑上传资产（s01 → r1 行）')
    const r7 = await bindUploadedShotAsset(s.runId, 'gen_images', 's01', s.a1v1)
    check(JSON.stringify(r7.assetIds) === JSON.stringify([s.a1v1, s.a2]), '绑定任务产物（a1v1）')

    // ---- 绑定非法矩阵 ----
    const foreignUp = (
      await db
        .insert(assets)
        .values({
          projectId: pid,
          stepId: s.sbStepId,
          taskId: null,
          runId: s.runId,
          kind: 'image',
          purpose: 'shot_image',
          name: 'foreign.png',
          params: JSON.stringify({ shotId: 's01' }),
          tags: '[]',
          createdAt: T0,
          updatedAt: T0,
        })
        .returning()
    )[0]!.id
    const orphanTask = (
      await db
        .insert(assets)
        .values({
          projectId: pid,
          stepId: s.imgStepId,
          taskId: 999999,
          runId: s.runId,
          kind: 'image',
          purpose: 'shot_image',
          name: 'orphan-task.png',
          params: JSON.stringify({ shotId: 's01' }),
          tags: '[]',
          createdAt: T0,
          updatedAt: T0,
        })
        .returning()
    )[0]!.id
    const bindBad: Array<{ label: string; shot: string; asset: number; want: string; msg?: string }> = [
      { label: '镜头不匹配（s01 绑 a2）', shot: 's01', asset: s.a2, want: 'bad_asset', msg: '不匹配' },
      { label: '跨步骤上传（stepId=make_storyboard）', shot: 's01', asset: foreignUp, want: 'bad_asset', msg: '不属于该步骤' },
      { label: '跨步任务资产（taskId 不属于本步）', shot: 's01', asset: orphanTask, want: 'bad_asset', msg: '不属于该步骤' },
      { label: '类型不符（图步绑视频）', shot: 's01', asset: r3.id, want: 'bad_asset', msg: '类型不符' },
      { label: '未知镜头', shot: 's99', asset: r1.id, want: 'unknown_shot' },
      { label: '资产不存在', shot: 's01', asset: 888888, want: 'bad_asset', msg: '不存在' },
    ]
    for (const c of bindBad) {
      const e = await errOf(() => bindUploadedShotAsset(s.runId, 'gen_images', c.shot, c.asset))
      check(
        e instanceof WorkbenchError && e.code === c.want && (!c.msg || e.message.includes(c.msg)),
        `${c.label} → ${c.want}（实际 ${e instanceof WorkbenchError ? `${e.code}：${e.message}` : String(e)}）`,
      )
    }
  }

  const sectionBoard = async (): Promise<void> => {
    const s = await seedRun()
    const b0 = await buildShotBoard(s.runId, 'gen_images')
    check(b0.shots.length === 2, '基线 2 镜')
    const sh1 = b0.shots[0]!
    check(sh1.raw['id'] === 's01' && sh1.raw['image_prompt'] === '晨光中的小镇', 'raw 字段（分镜对象全量）')
    check(sh1.versions.length === 2 && sh1.versions.every((v) => v.source === 'task'), '任务版本 source=task')

    // ---- 上传并入版本组 ----
    const r1 = await uploadAndBindShotAsset(s.runId, 'gen_images', 's01', { name: '板面.png', data: PNG_A })
    const b1 = await buildShotBoard(s.runId, 'gen_images')
    const sh1b = b1.shots[0]!
    check(sh1b.versions.length === 3, `版本组合并（2 任务 + 1 上传 = 3）（实际 ${sh1b.versions.length}）`)
    const last = sh1b.versions[2]!
    check(last.id === r1.asset.id && last.source === 'upload', '上传版本尾部 + source=upload（createdAt 升序）')
    check(sh1b.selectedAssetId === r1.asset.id, 'selectedAssetId 命中上传资产')

    // ---- 入库未绑定也进版本组 ----
    const up2 = await importShotAsset({ projectId: pid, id: s.runId }, await getStep(s.imgStepId), 's02', { name: '库存.png', data: PNG_B })
    const b2 = await buildShotBoard(s.runId, 'gen_images')
    const sh2 = b2.shots[1]!
    check(sh2.versions.some((v) => v.id === up2.id && v.source === 'upload'), '入库即入版本组（未绑定）')
    check(sh2.selectedAssetId === s.a2, '未绑定不改变选中')
    check(sh2.versions[0]!.source === 'task' && sh2.versions[1]!.source === 'upload', '合并序（任务版在前 / 上传在后）')

    // ---- [M10] stale 兜底：shots_source=null 存量快照下分镜编辑仍可感知 ----
    const s2 = await seedRun()
    const c0 = (await buildShotBoard(s2.runId, 'gen_images')).compose
    check(c0?.stale === false, `基线 stale=false（成片晚于分镜；实际 ${JSON.stringify(c0)}）`)
    await applyStoryboardEdits(s2.runId, 'gen_images', [{ shot_id: 's01', image_prompt: '晨光中的小镇（兜底版）' }])
    const c1 = (await buildShotBoard(s2.runId, 'gen_images')).compose
    check(c1?.stale === true, `分镜编辑 → stale=true（shots_source=null 时间兜底；实际 ${JSON.stringify(c1)}）`)
    await db.update(assets).set({ createdAt: Date.now() + 1000, updatedAt: Date.now() + 1000 }).where(eq(assets.id, s2.final))
    const c2 = (await buildShotBoard(s2.runId, 'gen_images')).compose
    check(c2?.stale === false, `成片刷新（重合成语义）→ stale=false 回环（实际 ${JSON.stringify(c2)}）`)
  }

  const sectionSelect = async (): Promise<void> => {
    type SelOpts = Parameters<typeof applyShotSelection>[2]
    const s = await seedRun()

    // ---- 上传资产可被 picks 选中 ----
    const up = await importShotAsset({ projectId: pid, id: s.runId }, await getStep(s.imgStepId), 's01', { name: 'sel.png', data: PNG_A })
    const r1 = await applyShotSelection(s.runId, 'gen_images', {
      picks: [
        { shot_id: 's01', asset_id: up.id },
        { shot_id: 's02', asset_id: s.a2 },
      ],
    })
    check(JSON.stringify(r1.assetIds) === JSON.stringify([up.id, s.a2]), `上传资产可被 picks 选中（[up,a2]）（实际 [${r1.assetIds}]）`)
    const r2 = await applyShotSelection(s.runId, 'gen_images', { picks: [{ shot_id: 's01', asset_id: s.a1v2 }] })
    check(JSON.stringify(r2.assetIds) === JSON.stringify([s.a1v2]), '上传 ↔ 任务产物可来回切换（子集语义）')

    // ---- 非本步骤的 taskId=null 资产拒绝 ----
    const foreignUp = (
      await db
        .insert(assets)
        .values({
          projectId: pid,
          stepId: s.sbStepId,
          taskId: null,
          runId: s.runId,
          kind: 'image',
          purpose: 'shot_image',
          name: 'foreign.png',
          params: JSON.stringify({ shotId: 's01' }),
          tags: '[]',
          createdAt: T0,
          updatedAt: T0,
        })
        .returning()
    )[0]!.id
    const eForeign = await errOf(() => applyShotSelection(s.runId, 'gen_images', { picks: [{ shot_id: 's01', asset_id: foreignUp }] }))
    check(eForeign instanceof WorkbenchError && eForeign.code === 'bad_asset' && eForeign.message.includes('上传'), '跨步骤上传资产拒绝（不属于该步骤上传资产）')

    // ---- runId 不匹配的上传资产拒绝 ----
    const noRunUp = (
      await db
        .insert(assets)
        .values({
          projectId: pid,
          stepId: s.imgStepId,
          taskId: null,
          runId: null,
          kind: 'image',
          purpose: 'shot_image',
          name: 'no-run.png',
          params: JSON.stringify({ shotId: 's01' }),
          tags: '[]',
          createdAt: T0,
          updatedAt: T0,
        })
        .returning()
    )[0]!.id
    const eNoRun = await errOf(() => applyShotSelection(s.runId, 'gen_images', { picks: [{ shot_id: 's01', asset_id: noRunUp }] }))
    check(eNoRun instanceof WorkbenchError && eNoRun.code === 'bad_asset', 'runId 不匹配的上传资产拒绝')

    // ---- 跨镜 pick 仍拒绝（M7 防呆）----
    const eCross = await errOf(() => applyShotSelection(s.runId, 'gen_images', { picks: [{ shot_id: 's02', asset_id: up.id }] }))
    check(eCross instanceof WorkbenchError && eCross.code === 'bad_asset' && eCross.message.includes('不匹配'), '上传资产跨镜 pick 仍拒绝')
    const eTaskCross = await errOf(() => applyShotSelection(s.runId, 'gen_images', { picks: [{ shot_id: 's01', asset_id: s.a2 }] }))
    check(eTaskCross instanceof WorkbenchError && eTaskCross.code === 'bad_asset', '任务资产跨镜 pick 仍拒绝（M7 防呆）')

    // ---- 非法调用不改变 output ----
    const outAfter = JSON.parse((await getStep(s.imgStepId)).output ?? '{}') as { asset_ids?: number[] }
    check(JSON.stringify(outAfter.asset_ids) === JSON.stringify([s.a1v2]), `非法调用不改变 output（实际 [${outAfter.asset_ids}]）`)
  }

  const sectionRegression = async (): Promise<void> => {
    const s = await seedRun()

    // ---- applyStoryboardEdits（M7）行为不变 ----
    const r1 = await applyStoryboardEdits(s.runId, 'gen_images', [{ shot_id: 's01', duration: 3.5, image_prompt: '夜景版' }])
    check(r1.edited === 1 && r1.assetIds[0] === r1.assetId, '编辑：新资产 + 保位替换')
    const na = await getAsset(r1.assetId)
    check(na.name.includes('工作台编辑') && na.stepId === s.sbStepId && na.runId === s.runId, '编辑资产命名/归属（M7 不变）')
    const ed1 = JSON.parse(await readTextAsset(r1.assetId)) as { shots: Array<{ id: string; duration?: number; image_prompt?: string }> }
    check(ed1.shots[0]!.duration === 3.5 && ed1.shots[0]!.image_prompt === '夜景版', '三字段 patch 生效（duration/提示词）')

    // ---- edit → mutate 链（基于最新分镜）----
    const r2 = await reorderShots(s.runId, 'gen_images', ['s02', 's01'])
    const ed2 = JSON.parse(await readTextAsset(r2.assetId)) as { shots: Array<{ id: string; image_prompt?: string; duration?: number }> }
    check(ed2.shots[0]!.id === 's02' && ed2.shots[1]!.image_prompt === '夜景版', 'mutate 基于编辑后分镜（编辑保留）')
    const sbOut = JSON.parse((await getStep(s.sbStepId)).output ?? '{}') as { asset_ids?: number[] }
    check(sbOut.asset_ids?.[0] === r2.assetId, '保位替换链（编辑资产 → 结构性编辑资产）')

    // ---- M7 错误码不回归 ----
    const eSame = await errOf(() => applyStoryboardEdits(s.runId, 'gen_images', [{ shot_id: 's01', duration: 3.5, image_prompt: '夜景版' }]))
    check(eSame instanceof WorkbenchError && eSame.code === 'no_change', 'no_change 语义（同值提交）')
    const eBad = await errOf(() => applyStoryboardEdits(s.runId, 'gen_images', []))
    check(eBad instanceof WorkbenchError && eBad.code === 'bad_items', 'bad_items（空数组）')

    // ---- reset 恢复仅任务产物（不含上传）----
    const up = await uploadAndBindShotAsset(s.runId, 'gen_images', 's01', { name: 'reset.png', data: PNG_A })
    check(JSON.stringify(up.assetIds) === JSON.stringify([s.a2, up.asset.id]), `重置前置：output 含上传（[a2,up]）（实际 [${up.assetIds}]）`)
    const r3 = await applyShotSelection(s.runId, 'gen_images', { reset: true })
    check(JSON.stringify(r3.assetIds) === JSON.stringify([s.a2, s.a1v2]), `reset → 任务产物全量（上传被排除）（实际 [${r3.assetIds}]）`)

    // ---- board 聚合读兼容（M7 字段仍在）----
    const board = await buildShotBoard(s.runId, 'gen_images')
    const sh1 = board.shots.find((x) => x.shotId === 's01')!
    check(sh1.duration === 3.5 && sh1.imagePrompt === '夜景版', '板面消费编辑后分镜（时长/提示词）')
    check(sh1.versions.every((v) => typeof v.id === 'number' && typeof v.urls.file === 'string'), 'M7 版本字段结构不变（id/urls）')
  }

  // ================= 分发 =================

  const runners: Record<string, () => Promise<void>> = {
    ops: sectionOps,
    output: sectionOutput,
    upload: sectionUpload,
    board: sectionBoard,
    select: sectionSelect,
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
    console.log(`\n==== M10 探针结果: ${failed > 0 ? `${failed} 项失败` : '全部通过'} ====`)
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
