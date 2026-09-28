/**
 * M7 探针（镜头级轻工作台 + 选镜拼接）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m7.ts [--section=board|edit|regenerate|select|recompose|merge-plan]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录
 * （独立 studio.db + workspace），不触碰开发库（同 probe-m3/m4/m6）。零网络、零计费：
 * 直测服务层函数与纯函数，不触发引擎执行与真实生成。
 *
 * section（默认 all）：
 *   board      聚合读：shots×tasks×版本组×选中×compose 五合一 + stale 三态 + repairable 判定
 *   edit       分镜编辑：合法编辑（新资产 + output 保位 + 引擎回写消费）+ 非法矩阵
 *   regenerate 单镜重生成重置：task/step/run 三表语义 + resultAssetId 保留 + 防呆矩阵
 *   gate-reroll 审阅闸门暂停（waiting_input）单镜重出：allowGatePause 放行 + board.gateRegenerate 透出 + 反例仍锁定
 *   select     选片/选镜：picks 校验矩阵 + 分镜序保序 + 子集剔除 + reset 全量
 *   recompose  重新合成重置：ffmpeg_merge 限定 + 三表语义 + 重复触发防护
 *   merge-plan 段组装纯函数：时长决策（explicit/estimated）+ 逐镜容错 skip
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Asset } from '../src/db/schema'
import { createSeedKit, SHOTS_JSON } from './m7-seed'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
// 清理历史残留：libsql 在 Windows 下不释放文件句柄（close 后仍 EBUSY）——本进程退出时 db 文件必留；
// 本次运行在创建自己的目录前清掉旧的（占用中则跳过，自动收敛为最多一份）。
import { sweepStaleProbeTempDirs, writeProbePidSentinel } from './probe-lib'

const TMP_PREFIX = 'acs-probe-m7-'
// 清理历史残留（跳过存活并行探针目录，避免并行 --jobs≥2 下嵌套回归子探针与顶层同名探针互删 SQLite 库）
sweepStaleProbeTempDirs(TMP_PREFIX)
const TMP = mkdtempSync(join(tmpdir(), TMP_PREFIX))
writeProbePidSentinel(TMP)
process.env.CSTUDIO_ROOT = REPO_ROOT
process.env.CSTUDIO_DATA = join(TMP, 'data')
process.env.CSTUDIO_WORKSPACE = join(TMP, 'workspace')
mkdirSync(process.env.CSTUDIO_DATA, { recursive: true })
mkdirSync(process.env.CSTUDIO_WORKSPACE, { recursive: true })
// 桥接真实出厂模板进隔离 workspace：模板分类判定（isCreationTemplate / gateEdit）现派生自各 YAML 顶层 visibility 元数据（单一真源在文件自身），
// 需真实模板文件在场（同 probe-m44 bridge / probe-m45 cpSync 先例）；否则空 workspace 会让判定退化为 false。仍零网络、零计费。
cpSync(join(REPO_ROOT, 'workspace', 'templates'), join(process.env.CSTUDIO_WORKSPACE, 'templates'), { recursive: true })

const SECTIONS = ['board', 'edit', 'regenerate', 'gate-reroll', 'select', 'recompose', 'merge-plan'] as const

async function main(): Promise<void> {
  // src 模块全部动态加载（环境变量已隔离）
  const { db, initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')
  const { assets, genTasks, pipelineRuns, pipelineSteps, projects } = await import('../src/db/schema')
  const { eq } = await import('drizzle-orm')
  const { absPathOf, ensureProjectDirs, readTextAsset, relPathOf } = await import('../src/services/storage')
  const {
    WorkbenchError,
    applyShotSelection,
    applyStoryboardEdits,
    buildShotBoard,
    resetShotForRegenerate,
    resetStepForRecompose,
  } = await import('../src/services/shot')

  const log = createLogger('probe-m7')
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
      .values({ name: 'M7 探针项目', genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
      .returning()
  )[0]!.id
  ensureProjectDirs(pid)

  // ---- 行级 helpers 与 seedRun（种子夹具）另拆 ./m7-seed，注入动态 import 的 db/表/eq/storage 实例 ----
  const { getRun, getStep, getTask, getAsset, setRunStatus, setStepOutput, mkStepId, seedRun } =
    createSeedKit({ db, assets, genTasks, pipelineRuns, pipelineSteps, eq, relPathOf, absPathOf, pid, T0 })

  // ================= sections =================

  const sectionBoard = async (): Promise<void> => {
    const s = await seedRun()
    const board = await buildShotBoard(s.runId, 'gen_images')
    check(board.step.key === 'gen_images' && board.step.action === 'ai_image', `step 元信息（${board.step.key}/${board.step.action}）`)
    check(board.shots.length === 2 && board.shots[0]!.shotId === 's01' && board.shots[1]!.shotId === 's02', 'shots 分镜序（s01→s02）')
    const sh1 = board.shots[0]!
    const sh2 = board.shots[1]!
    check(sh1.order === 0 && sh2.order === 1, 'order 递增（0/1）')
    check(sh1.imagePrompt === '晨光中的小镇' && sh1.motionPrompt === '缓慢推进镜头', '提示词字段读取（image_prompt/motion_prompt）')
    check(sh1.duration === null && sh2.duration === 2.5, '时长双口径（s01 无 duration → null；s02 duration_sec 回退 2.5）')
    check(sh1.task?.id === s.t1 && sh1.task.status === 'succeeded' && sh1.task.attempts === 3, 's01 任务关联（t1/succeeded/attempts=3）')
    check(sh2.task?.id === s.t2, 's02 任务关联（t2）')
    check(sh1.versions.length === 2 && sh1.versions[0]!.id === s.a1v1 && sh1.versions[1]!.id === s.a1v2, '版本组升序（v1→v2）')
    check(sh2.versions.length === 1 && sh2.versions[0]!.id === s.a2, '单版本组（s02=v1）')
    check(sh1.selectedAssetId === s.a1v2 && sh2.selectedAssetId === s.a2, '当前选中来自 output（同镜首个命中）')
    check(
      sh1.versions[0]!.urls.file === `/api/v1/assets/${s.a1v1}/file` &&
        sh1.versions[0]!.urls.thumb === `/api/v1/assets/${s.a1v1}/thumb?v=2`,
      '版本 urls（file/thumb?v=2）',
    )
    check(board.compose?.stepKey === 'compose_video' && board.compose.composedAt === T0 + 50 && board.compose.stale === false, 'compose 信息（stepKey/composedAt/stale=false）')
    check(board.repairable.ok === true && board.repairable.reason === null, 'repairable ok（completed + 无其他 failed）')

    // ai_video 工作台：视频版本封面缩略图（ffmpeg 抽帧，?v=2 缓存失效）
    const vb = await buildShotBoard(s.runId, 'gen_motion')
    check(
      vb.shots[0]!.versions[0]!.urls.thumb === `/api/v1/assets/${s.m1}/thumb?v=2` && vb.shots[0]!.selectedAssetId === s.m1,
      'ai_video 板（视频封面 thumb?v=2 / 选中 m1）',
    )

    // ---- 续跑继承：任务 resultAssetId 指向他任务产物（旧 run 版本）仍并入版本组 ----
    // 复现场景：断点续跑只复制 gen_task 行（新 id）并保留 resultAssetId 指向旧 run 资产，
    // 而该资产 task_id 仍属旧任务 → 正常按 taskId 分组查不到 → 缩略图丢失。修复后应显式并入。
    const carriedRel = relPathOf(pid, 'shot_image', `m7-${s.runId}-s01-carried.png`)
    writeFileSync(absPathOf(carriedRel), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
    const carried = (
      await db
        .insert(assets)
        .values({
          projectId: pid,
          stepId: s.imgStepId,
          taskId: s.t3, // 他步骤任务 id：不在 gen_images 任务集内，按 taskId 分组不会命中
          runId: s.runId,
          kind: 'image',
          purpose: 'shot_image',
          name: 's01-carried.png',
          mime: 'image/png',
          ext: 'png',
          fileSize: 12,
          relPath: carriedRel,
          width: 1024,
          height: 1024,
          params: JSON.stringify({ shotId: 's01' }),
          tags: '[]',
          createdAt: T0 + 18,
          updatedAt: T0 + 18,
        })
        .returning()
    )[0]!.id
    await db.update(genTasks).set({ resultAssetId: carried }).where(eq(genTasks.id, s.t1))
    const bCarry = await buildShotBoard(s.runId, 'gen_images')
    const sh1Carry = bCarry.shots[0]!
    check(
      sh1Carry.versions.some((v) => v.id === carried),
      `续跑继承产物并入版本组（resultAssetId 指向他任务资产仍展示；实际 ${sh1Carry.versions.length} 版）`,
    )
    check(sh1Carry.versions.length === 3, `继承后 s01 版本组 = 2 原生 + 1 继承（实际 ${sh1Carry.versions.length}）`)
    await db.update(genTasks).set({ resultAssetId: null }).where(eq(genTasks.id, s.t1))

    // ---- stale 三态 ----
    await setStepOutput(s.imgStepId, { asset_ids: [s.a1v1, s.a2] })
    const bImg = await buildShotBoard(s.runId, 'gen_images')
    check(bImg.compose?.stale === true, 'stale：images 快照 ≠ 当前 output → true')
    await setStepOutput(s.imgStepId, { asset_ids: [s.a1v2, s.a2] })

    await setStepOutput(s.sbStepId, { asset_ids: [999999], gate: { status: 'keep-me' } })
    const bSrc = await buildShotBoard(s.runId, 'gen_images')
    check(bSrc.compose?.stale === true, 'stale：shots_source 不在产出步骤 output → true')
    await setStepOutput(s.sbStepId, { asset_ids: [s.sbId], gate: { status: 'keep-me' } })

    await db.update(assets).set({ params: '{}' }).where(eq(assets.id, s.final))
    const bNull = await buildShotBoard(s.runId, 'gen_images')
    check(bNull.compose?.stale === null, 'stale：无 inputs 快照 → null（前端降级）')
    await db
      .update(assets)
      .set({ params: JSON.stringify({ inputs: { images: [s.a1v2, s.a2], motion_clips: [s.m1], shots_source: s.sbId } }) })
      .where(eq(assets.id, s.final))

    // ---- repairable 变体 ----
    const extra = await mkStepId(s.runId, 5, 'extra_fail', 'ai_text', 'failed')
    const bOther = await buildShotBoard(s.runId, 'gen_images')
    check(bOther.repairable.ok === false && (bOther.repairable.reason ?? '').includes('extra_fail'), `repairable：其他 failed 步骤拦截（${bOther.repairable.reason}）`)
    await db.delete(pipelineSteps).where(eq(pipelineSteps.id, extra))

    const bMerge = await buildShotBoard(s.runId, 'compose_video')
    check(bMerge.repairable.ok === false, 'repairable：ffmpeg_merge 不在工作台动作集 → false')

    await setRunStatus(s.runId, 'running')
    const bRun = await buildShotBoard(s.runId, 'gen_images')
    check(bRun.repairable.ok === false && (bRun.repairable.reason ?? '').includes('run 正在执行'), 'repairable：run running → false')
    await setRunStatus(s.runId, 'completed')

    // ---- 分镜损坏 → shots=[] + reason ----
    writeFileSync(absPathOf(s.sbRel), '{broken')
    const bBad = await buildShotBoard(s.runId, 'gen_images')
    check(bBad.shots.length === 0 && bBad.repairable.ok === false && (bBad.repairable.reason ?? '').includes('分镜'), `repairable：分镜解析失败（${bBad.repairable.reason}）`)
    writeFileSync(absPathOf(s.sbRel), SHOTS_JSON)

    // ---- 404 ----
    const e404 = await errOf(() => buildShotBoard(999999, 'gen_images'))
    check(e404 instanceof WorkbenchError && e404.code === 'not_found' && e404.status === 404, 'run 不存在 → WorkbenchError(not_found, 404)')
  }

  const sectionEdit = async (): Promise<void> => {
    type EditItems = Parameters<typeof applyStoryboardEdits>[2]
    const s = await seedRun()

    // ---- 合法编辑：duration + 提示词 → 新资产 + output 保位 ----
    const r = await applyStoryboardEdits(s.runId, 'gen_images', [{ shot_id: 's01', duration: 3.5, image_prompt: '晨光中的小镇（夜景版）' }])
    check(r.edited === 1, `edited=1（实际 ${r.edited}）`)
    check(r.assetId !== s.sbId && r.assetIds.length === 1 && r.assetIds[0] === r.assetId, 'output 保位替换（长度 1 → 新资产）')

    const na = await getAsset(r.assetId)
    check(na.kind === 'text' && na.purpose === 'storyboard', '新资产 kind=text / purpose 继承 storyboard')
    check(na.stepId === s.sbStepId && na.runId === s.runId, '新资产归属（stepId=make_storyboard / runId 一致）')
    const np = JSON.parse(na.params ?? '{}') as { edited_shots?: string[]; source_asset_id?: number }
    check(np.edited_shots?.length === 1 && np.edited_shots[0] === 's01' && np.source_asset_id === s.sbId, '新资产 params（edited_shots/source_asset_id）')
    check(na.name.includes('工作台编辑'), `新资产命名（${na.name}）`)

    const edited = JSON.parse(await readTextAsset(r.assetId)) as {
      shots: Array<{ id: string; image_prompt?: string; motion_prompt?: string; duration?: number; duration_sec?: number }>
    }
    check(edited.shots.length === 2, '编辑后保持 2 镜（形态 {shots:[]} 不变）')
    check(edited.shots[0]!.duration === 3.5 && edited.shots[0]!.image_prompt === '晨光中的小镇（夜景版）', 's01 编辑生效（duration=3.5 + 新提示词）')
    check(edited.shots[0]!.motion_prompt === '缓慢推进镜头' && edited.shots[1]!.image_prompt === '集市人群', '未编辑字段原样保留')
    check(edited.shots[0]!.duration_sec === undefined && edited.shots[1]!.duration_sec === 2.5, 'duration_sec 口径保留（s01 原本无 → 不新增；s02 原样）')

    const sbOut = JSON.parse((await getStep(s.sbStepId)).output ?? '{}') as { asset_ids?: number[]; gate?: unknown }
    check(sbOut.asset_ids?.length === 1 && sbOut.asset_ids[0] === r.assetId, '产出步骤 output 保位替换')
    check(JSON.stringify(sbOut.gate) === JSON.stringify({ status: 'keep-me' }), 'output 其他字段（gate）保留')

    // F1：编辑后无需引擎回写——板面即时读产出步骤当前输出中的最新分镜（input 快照滞后不影响）
    const boardNow = await buildShotBoard(s.runId, 'gen_images')
    check(boardNow.shots[0]!.duration === 3.5 && boardNow.shots[0]!.imagePrompt === '晨光中的小镇（夜景版）', '编辑后板面即时读取新分镜（无需引擎回写）')
    check(boardNow.shots[1]!.duration === 2.5, '板面同读 duration_sec 回退（s02=2.5）')
    check(boardNow.compose?.stale === true, '编辑分镜后 stale=true（shots_source 已替换）')

    // 引擎回写（重跑时 input 快照刷新为最新分镜）：板面结果保持一致
    await db.update(pipelineSteps).set({ input: JSON.stringify({ shots: [r.assetId] }) }).where(eq(pipelineSteps.id, s.imgStepId))
    const board = await buildShotBoard(s.runId, 'gen_images')
    check(board.shots[0]!.duration === 3.5 && board.shots[0]!.imagePrompt === '晨光中的小镇（夜景版）', '引擎回写后工作台消费新分镜')

    // ---- 非法矩阵 ----
    const cases: Array<{ label: string; items: unknown; want: string }> = [
      { label: '空数组', items: [], want: 'bad_items' },
      { label: '未知镜头', items: [{ shot_id: 's99', duration: 2 }], want: 'unknown_shot' },
      { label: '时长下界', items: [{ shot_id: 's01', duration: 0 }], want: 'bad_duration' },
      { label: '时长上界', items: [{ shot_id: 's01', duration: 61 }], want: 'bad_duration' },
      { label: '提示词空白', items: [{ shot_id: 's01', image_prompt: '   ' }], want: 'bad_prompt' },
      { label: '提示词非串', items: [{ shot_id: 's01', motion_prompt: 123 }], want: 'bad_prompt' },
      { label: '无字段', items: [{ shot_id: 's01' }], want: 'bad_items' },
      { label: '同值无变化', items: [{ shot_id: 's01', duration: 3.5, image_prompt: '晨光中的小镇（夜景版）' }], want: 'no_change' },
    ]
    for (const c of cases) {
      const e = await errOf(() => applyStoryboardEdits(s.runId, 'gen_images', c.items as EditItems))
      check(
        e instanceof WorkbenchError && e.code === c.want,
        `${c.label} → ${c.want}（实际 ${e instanceof WorkbenchError ? e.code : String(e)}）`,
      )
    }

    // ---- F2：LLM 口径 duration_sec 的编辑同步 + 同值比较 ----
    const r2 = await applyStoryboardEdits(s.runId, 'gen_images', [{ shot_id: 's02', duration: 3 }])
    const ed2 = JSON.parse(await readTextAsset(r2.assetId)) as {
      shots: Array<{ id: string; duration?: number; duration_sec?: number; image_prompt?: string }>
    }
    check(ed2.shots[1]!.duration === 3 && ed2.shots[1]!.duration_sec === 3, 's02 编辑双口径同步（duration/duration_sec=3）')
    check(ed2.shots[0]!.duration === 3.5 && ed2.shots[0]!.image_prompt === '晨光中的小镇（夜景版）', '链式编辑基于最新版本（s01 编辑保留）')
    const eSame = await errOf(() => applyStoryboardEdits(s.runId, 'gen_images', [{ shot_id: 's02', duration: 3 }]))
    check(eSame instanceof WorkbenchError && eSame.code === 'no_change', 'F2 同值提交（duration 3 vs duration_sec 3）→ no_change')

    // ---- no_producer：分镜资产无产出步骤溯源 ----
    await db.update(assets).set({ stepId: null }).where(eq(assets.id, r2.assetId))
    const eNp = await errOf(() => applyStoryboardEdits(s.runId, 'gen_images', [{ shot_id: 's01', duration: 4 }]))
    check(eNp instanceof WorkbenchError && eNp.code === 'no_producer', '无产出步骤溯源 → no_producer')
  }

  const sectionRegenerate = async (): Promise<void> => {
    const s = await seedRun()

    // ---- 防呆（重置前：run 仍 completed） ----
    const eBad = await errOf(() => resetShotForRegenerate(s.runId, 'gen_images', ''))
    check(eBad instanceof WorkbenchError && eBad.code === 'bad_shot', '空 shot_id → bad_shot')
    const eNo = await errOf(() => resetShotForRegenerate(s.runId, 'gen_images', 's99'))
    check(eNo instanceof WorkbenchError && eNo.code === 'no_task', '无任务镜头 → no_task')
    const eAct = await errOf(() => resetShotForRegenerate(s.runId, 'compose_video', 's01'))
    check(eAct instanceof WorkbenchError && eAct.code === 'bad_action', 'ffmpeg_merge 步骤 → bad_action')

    // ---- 正常重置：三表语义 ----
    const r = await resetShotForRegenerate(s.runId, 'gen_images', 's01')
    check(r.runId === s.runId && r.taskId === s.t1, '返回 runId/taskId')
    const t1 = await getTask(s.t1)
    check(t1.status === 'pending' && t1.attempts === 0 && t1.errorMsg === null && t1.completedAt === null, 'task 重置（pending / attempts=0 / errorMsg=null / completedAt=null）')
    check(t1.resultAssetId === s.a1v2, 'task.resultAssetId 保留（历史产物防孤儿）')
    const imgStep = await getStep(s.imgStepId)
    check(imgStep.status === 'pending' && imgStep.completedAt === null, 'step 重置（pending）')
    const run = await getRun(s.runId)
    check(run.status === 'queued' && run.currentStepKey === null && run.completedAt === null, 'run 重置（queued / currentStepKey=null）')
    check((await getTask(s.t2)).status === 'succeeded', '同步骤其他任务不受影响（t2）')
    check((await getStep(s.motionStepId)).status === 'succeeded', '其他步骤不受影响（gen_motion）')

    // ---- [审计·重生成收口] 视频单镜重生成必清外部 task_id ----
    // ai-video 执行段以 `task.taskId ? 续轮询 : 重新提交` 决定去向；重生成若保留旧 task_id
    // 会直接轮回变更前的旧成片（假重生成）。新隔离 seed，对视频任务预置旧 task_id 后重生成。
    const sv = await seedRun()
    await db.update(genTasks).set({ taskId: 'EXT-VIDEO-OLD' }).where(eq(genTasks.id, sv.t3))
    const rv = await resetShotForRegenerate(sv.runId, 'gen_motion', 's01')
    check(rv.taskId === sv.t3, '视频单镜重生成命中目标视频任务（gen_motion/s01）')
    check((await getTask(sv.t3)).taskId === null, '视频重生成清空外部 task_id（regen 语义：强制重新提交，绝不续轮询旧成片）')

    // 重置后板面：版本保留 / 选中保留 / run 活跃 → repairable=false
    const board = await buildShotBoard(s.runId, 'gen_images')
    check(board.shots[0]!.versions.length === 2 && board.shots[0]!.task?.status === 'pending', '重置后版本组保留（2 版）+ 任务状态 pending')
    check(board.repairable.ok === false, '重置后 repairable=false（run queued 活跃）')

    // ---- run 状态防呆 ----
    await setRunStatus(s.runId, 'running')
    const eRun = await errOf(() => resetShotForRegenerate(s.runId, 'gen_images', 's01'))
    check(eRun instanceof WorkbenchError && eRun.code === 'run_active', 'run running → run_active')
    await setRunStatus(s.runId, 'cancelled')
    const eCan = await errOf(() => resetShotForRegenerate(s.runId, 'gen_images', 's01'))
    check(eCan instanceof WorkbenchError && eCan.code === 'run_cancelled', 'run cancelled → run_cancelled')

    // ---- 其他 failed 步骤拦截（独立 run 保持隔离） ----
    const s2 = await seedRun()
    await mkStepId(s2.runId, 5, 'extra_fail', 'ai_text', 'failed')
    const eOther = await errOf(() => resetShotForRegenerate(s2.runId, 'gen_images', 's01'))
    check(eOther instanceof WorkbenchError && eOther.code === 'other_failed', '其他 failed 步骤 → other_failed')
  }

  const sectionGateReroll = async (): Promise<void> => {
    // 审阅闸门暂停（run 与挂闸生成步同时 waiting_input）下的单镜重出双向断言：
    // assertRepairable(allowGatePause) 放行 → resetShotForRegenerate 成功三表重置；
    // board 透出 gateRegenerate=true 且把误导性「正在执行/排队」语换成「审阅暂停中」；
    // 反例（闸在别步 / 挂闸步非工作台步）仍逐字锁定，证明解锁面只到「单镜重出」。
    const s = await seedRun()
    await setRunStatus(s.runId, 'waiting_input')
    await db.update(pipelineSteps).set({ status: 'waiting_input' }).where(eq(pipelineSteps.id, s.imgStepId))

    const b = await buildShotBoard(s.runId, 'gen_images')
    check(b.gateRegenerate === true, '闸门暂停：board.gateRegenerate=true（仅放行单镜重出）')
    check(b.gateEdit === true, '闸门暂停（非轻松创作）：board.gateEdit=true（开放逐镜改词重生成）')
    check(b.repairable.ok === false, '闸门暂停：repairable 仍 false（选片/上传/重合成等仍锁）')
    check(typeof b.repairable.reason === 'string' && b.repairable.reason.includes('审阅暂停中'), '闸门暂停提示语友好化（含「审阅暂停中」）')

    const r = await resetShotForRegenerate(s.runId, 'gen_images', 's01')
    check(r.taskId === s.t1, '闸门重出命中目标任务（s01/t1）')
    const t1 = await getTask(s.t1)
    check(t1.status === 'pending' && t1.attempts === 0 && t1.resultAssetId === s.a1v2, '闸门重出重置 task（pending/attempts=0/保留历史产物）')
    check((await getStep(s.imgStepId)).status === 'pending', '闸门重出重置 step→pending')
    check((await getRun(s.runId)).status === 'queued', '闸门重出后 run→queued（引擎仅重跑目标镜后自动回到审阅闸）')

    // 反例 A：run waiting_input 但挂闸步在别处（gen_images 仍 succeeded）→ gatePause=false → 活跃拒绝
    const s2 = await seedRun()
    await setRunStatus(s2.runId, 'waiting_input')
    await db.update(pipelineSteps).set({ status: 'waiting_input' }).where(eq(pipelineSteps.id, s2.sbStepId))
    const b2 = await buildShotBoard(s2.runId, 'gen_images')
    check(b2.gateRegenerate === false, '闸在别步：gen_images.gateRegenerate=false（本步非挂闸步）')
    const e2 = await errOf(() => resetShotForRegenerate(s2.runId, 'gen_images', 's01'))
    check(e2 instanceof WorkbenchError && e2.code === 'run_active', '闸在别步：单镜重出仍 run_active 拒绝')

    // 反例 B：挂闸步为非工作台步（compose_video/ffmpeg_merge）→ 不放行重出（bad_action），gateRegenerate 亦 false
    const s3 = await seedRun()
    await setRunStatus(s3.runId, 'waiting_input')
    await db.update(pipelineSteps).set({ status: 'waiting_input' }).where(eq(pipelineSteps.id, s3.mergeStepId))
    const b3 = await buildShotBoard(s3.runId, 'compose_video')
    check(b3.gateRegenerate === false, '非工作台步挂闸：compose_video.gateRegenerate=false')
    const e3 = await errOf(() => resetShotForRegenerate(s3.runId, 'compose_video', 's01'))
    check(e3 instanceof WorkbenchError && e3.code === 'bad_action', '非工作台步挂闸：单镜重出仍 bad_action')

    // ==== gate-edit：审阅闸门期改词重生成双向断言 ====
    // 正例：drama 模板（mengbao-episode）闸门暂停 → 提示词编辑放行（写新分镜版本）
    const s4 = await seedRun()
    await setRunStatus(s4.runId, 'waiting_input')
    await db.update(pipelineSteps).set({ status: 'waiting_input' }).where(eq(pipelineSteps.id, s4.imgStepId))
    const ed = await applyStoryboardEdits(s4.runId, 'gen_images', [{ shot_id: 's01', image_prompt: '闸门改词：雪夜中的小镇' }], { allowGatePause: true })
    check(ed.edited === 1 && ed.assetId > 0, '闸门期改词（drama）：applyStoryboardEdits 放行并写新分镜版本')
    // 改词后单镜重生成：先写分镜再重置入队（task 同步新 prompt、三表重置）
    const r4 = await resetShotForRegenerate(s4.runId, 'gen_images', 's01', { image_prompt: '闸门改词二次：黎明海面' })
    check(r4.taskId === s4.t1, '闸门改词重生成命中目标任务（s01/t1）')
    check((await getRun(s4.runId)).status === 'queued', '闸门改词重生成后 run→queued')

    // 反例 C：闸门期改 duration → gate_edit_limited 拒（需收敛后整链返修）
    const s5 = await seedRun()
    await setRunStatus(s5.runId, 'waiting_input')
    await db.update(pipelineSteps).set({ status: 'waiting_input' }).where(eq(pipelineSteps.id, s5.imgStepId))
    const eDur = await errOf(() => applyStoryboardEdits(s5.runId, 'gen_images', [{ shot_id: 's01', duration: 5 }], { allowGatePause: true }))
    check(eDur instanceof WorkbenchError && eDur.code === 'gate_edit_limited', '闸门期改 duration → gate_edit_limited 拒绝')

    // 反例 D：轻松创作（批准链冻结 prompt）闸门期改词 → creation_prompt_locked 硬拒；同词重出仍放行
    const s6 = await seedRun()
    await db.update(pipelineRuns).set({ templateKey: 'easy-dialogue' }).where(eq(pipelineRuns.id, s6.runId))
    await setRunStatus(s6.runId, 'waiting_input')
    await db.update(pipelineSteps).set({ status: 'waiting_input' }).where(eq(pipelineSteps.id, s6.imgStepId))
    const b6 = await buildShotBoard(s6.runId, 'gen_images')
    check(b6.gateRegenerate === true && b6.gateEdit === false, '轻松创作闸门：gateRegenerate=true 但 gateEdit=false（批准链冻结 prompt）')
    const eEdit = await errOf(() => applyStoryboardEdits(s6.runId, 'gen_images', [{ shot_id: 's01', image_prompt: '越链改词' }], { allowGatePause: true }))
    check(eEdit instanceof WorkbenchError && eEdit.code === 'creation_prompt_locked', '轻松创作闸门期改词 → creation_prompt_locked 硬拒')
    const eRe = await errOf(() => resetShotForRegenerate(s6.runId, 'gen_images', 's01', { image_prompt: '越链改词重生成' }))
    check(eRe instanceof WorkbenchError && eRe.code === 'creation_prompt_locked', '轻松创作闸门期改词重生成 → creation_prompt_locked 硬拒')
    const r6 = await resetShotForRegenerate(s6.runId, 'gen_images', 's01')
    check(r6.taskId === s6.t1, '轻松创作闸门：同词重出仍放行（不越批准链）')
  }

  const sectionSelect = async (): Promise<void> => {
    type SelOpts = Parameters<typeof applyShotSelection>[2]
    const s = await seedRun()

    // ---- 保序：乱序提交 → 分镜序 ----
    const r1 = await applyShotSelection(s.runId, 'gen_images', {
      picks: [
        { shot_id: 's02', asset_id: s.a2 },
        { shot_id: 's01', asset_id: s.a1v1 },
      ],
    })
    check(JSON.stringify(r1.assetIds) === JSON.stringify([s.a1v1, s.a2]), `乱序提交 → 分镜序 [a1v1,a2]（实际 [${r1.assetIds}]）`)
    const out1 = JSON.parse((await getStep(s.imgStepId)).output ?? '{}') as { asset_ids?: number[] }
    check(JSON.stringify(out1.asset_ids) === JSON.stringify([s.a1v1, s.a2]), 'output.asset_ids 实际写库')

    // ---- 子集剔除：只留 s01 ----
    const r2 = await applyShotSelection(s.runId, 'gen_images', { picks: [{ shot_id: 's01', asset_id: s.a1v2 }] })
    check(JSON.stringify(r2.assetIds) === JSON.stringify([s.a1v2]), '子集语义（未列入镜头剔除）')

    // ---- reset：全量最新（task.resultAssetId × 分镜序） ----
    const r3 = await applyShotSelection(s.runId, 'gen_images', { reset: true })
    check(JSON.stringify(r3.assetIds) === JSON.stringify([s.a1v2, s.a2]), `reset → [a1v2,a2]（实际 [${r3.assetIds}]）`)

    // ---- ai_video 步骤选镜 ----
    const r4 = await applyShotSelection(s.runId, 'gen_motion', { picks: [{ shot_id: 's01', asset_id: s.m1 }] })
    check(JSON.stringify(r4.assetIds) === JSON.stringify([s.m1]), 'ai_video 步骤选镜（m1）')
    const eKind = await errOf(() => applyShotSelection(s.runId, 'gen_motion', { picks: [{ shot_id: 's01', asset_id: s.a1v2 }] }))
    check(eKind instanceof WorkbenchError && eKind.code === 'bad_asset' && eKind.message.includes('video'), 'ai_video 步骤拒绝 image 资产（需 video）')

    // ---- 续跑继承产物（复用资产）可改选：资产行 task_id 属旧 run 任务，但为本 run succeeded 任务的 resultAssetId ----
    const s5 = await seedRun()
    const legacyTask = (
      await db
        .insert(genTasks)
        .values({
          projectId: pid,
          runId: s5.runId - 1,
          stepId: s5.imgStepId,
          kind: 'image',
          provider: 'probe-legacy',
          params: JSON.stringify({ shotId: 's01' }),
          status: 'succeeded',
          attempts: 1,
          createdAt: T0 - 10,
          updatedAt: T0 - 10,
          completedAt: T0 - 10,
        })
        .returning()
    )[0]!.id
    const legacyImgBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    const legacyRel = relPathOf(pid, 'shot_image', `m7-legacy-${s5.runId}.png`)
    writeFileSync(absPathOf(legacyRel), legacyImgBytes)
    const legacyAsset = (
      await db
        .insert(assets)
        .values({
          projectId: pid,
          stepId: s5.imgStepId,
          taskId: legacyTask,
          runId: s5.runId - 1,
          kind: 'image',
          purpose: 'shot_image',
          name: 'legacy.png',
          relPath: legacyRel,
          params: JSON.stringify({ shotId: 's01' }),
          tags: '[]',
          createdAt: T0 - 5,
          updatedAt: T0 - 5,
        })
        .returning()
    )[0]!.id
    await db.update(genTasks).set({ resultAssetId: legacyAsset }).where(eq(genTasks.id, s5.t1))
    const r5 = await applyShotSelection(s5.runId, 'gen_images', {
      picks: [
        { shot_id: 's01', asset_id: s5.a1v1 },
        { shot_id: 's02', asset_id: s5.a2 },
      ],
    })
    check(JSON.stringify(r5.assetIds) === JSON.stringify([s5.a1v1, s5.a2]), '混合提交（含未动过的在用镜）不被继承资产拦死')
    const r6 = await applyShotSelection(s5.runId, 'gen_images', { picks: [{ shot_id: 's01', asset_id: legacyAsset }] })
    check(JSON.stringify(r6.assetIds) === JSON.stringify([legacyAsset]), '改选命中续跑继承产物（与 board 版本组同口径放行）')
    const legacyOrphan = (
      await db
        .insert(assets)
        .values({
          projectId: pid,
          stepId: s5.imgStepId,
          taskId: legacyTask,
          runId: s5.runId - 1,
          kind: 'image',
          purpose: 'shot_image',
          name: 'legacy-orphan.png',
          relPath: legacyRel,
          params: JSON.stringify({ shotId: 's01' }),
          tags: '[]',
          createdAt: T0 - 4,
          updatedAt: T0 - 4,
        })
        .returning()
    )[0]!.id
    const eCarry = await errOf(() => applyShotSelection(s5.runId, 'gen_images', { picks: [{ shot_id: 's01', asset_id: legacyOrphan }] }))
    check(
      eCarry instanceof WorkbenchError && eCarry.code === 'bad_asset' && eCarry.message.includes('不属于该步骤'),
      `旧 run 任务但非本步任务当前产物 → 仍拒（放行不扩大化；实际 ${eCarry instanceof WorkbenchError ? `${eCarry.code}：${eCarry.message}` : String(eCarry)}）`,
    )

    // ---- 边缘资产 ----
    const pid2 = (
      await db
        .insert(projects)
        .values({ name: 'M7 探针项目2', genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!.id
    ensureProjectDirs(pid2)
    const crossAsset = (
      await db
        .insert(assets)
        .values({ projectId: pid2, kind: 'image', purpose: 'shot_image', name: 'cross.png', params: JSON.stringify({ shotId: 's01' }), tags: '[]', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!.id
    const delAsset = (
      await db
        .insert(assets)
        .values({
          projectId: pid,
          stepId: s.imgStepId,
          taskId: s.t1,
          runId: s.runId,
          kind: 'image',
          purpose: 'shot_image',
          name: 'deleted.png',
          params: JSON.stringify({ shotId: 's01' }),
          tags: '[]',
          createdAt: T0,
          updatedAt: T0,
          deletedAt: T0,
        })
        .returning()
    )[0]!.id
    const orphanAsset = (
      await db
        .insert(assets)
        .values({ projectId: pid, runId: s.runId, kind: 'image', purpose: 'shot_image', name: 'orphan.png', params: JSON.stringify({ shotId: 's01' }), tags: '[]', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!.id

    // ---- 非法矩阵 ----
    const cases: Array<{ label: string; picks: unknown; want: string; msg?: string }> = [
      { label: '空 picks', picks: [], want: 'bad_picks' },
      { label: '重复镜头', picks: [{ shot_id: 's01', asset_id: s.a1v1 }, { shot_id: 's01', asset_id: s.a1v2 }], want: 'bad_picks' },
      { label: 'asset_id 非法', picks: [{ shot_id: 's01', asset_id: 0 }], want: 'bad_picks' },
      { label: '未知镜头', picks: [{ shot_id: 's99', asset_id: s.a1v1 }], want: 'unknown_shot' },
      { label: '资产不存在', picks: [{ shot_id: 's01', asset_id: 888888 }], want: 'bad_asset', msg: '不存在' },
      { label: '跨项目资产', picks: [{ shot_id: 's01', asset_id: crossAsset }], want: 'bad_asset', msg: '不属于本项目' },
      { label: '已删除资产', picks: [{ shot_id: 's01', asset_id: delAsset }], want: 'bad_asset', msg: '已删除' },
      { label: '类型不符', picks: [{ shot_id: 's01', asset_id: s.sbId }], want: 'bad_asset', msg: '类型不符' },
      { label: '镜头不匹配', picks: [{ shot_id: 's01', asset_id: s.a2 }], want: 'bad_asset', msg: '不匹配' },
      // [M10 适配] taskId=null 资产的拒绝文案随选片放宽细化为「不属于该步骤上传资产」；拒绝语义不变
      { label: '非任务集资产', picks: [{ shot_id: 's01', asset_id: orphanAsset }], want: 'bad_asset', msg: '不属于该步骤' },
    ]
    for (const c of cases) {
      const e = await errOf(() => applyShotSelection(s.runId, 'gen_images', { picks: c.picks } as SelOpts))
      check(
        e instanceof WorkbenchError && e.code === c.want && (!c.msg || e.message.includes(c.msg)),
        `${c.label} → ${c.want}${c.msg ? `（含「${c.msg}」）` : ''}（实际 ${e instanceof WorkbenchError ? `${e.code}：${e.message}` : String(e)}）`,
      )
    }
    const outAfter = JSON.parse((await getStep(s.imgStepId)).output ?? '{}') as { asset_ids?: number[] }
    check(JSON.stringify(outAfter.asset_ids) === JSON.stringify([s.a1v2, s.a2]), '非法调用不改变 output')
  }

  const sectionRecompose = async (): Promise<void> => {
    const s = await seedRun()

    const eAct = await errOf(() => resetStepForRecompose(s.runId, 'gen_images'))
    check(eAct instanceof WorkbenchError && eAct.code === 'bad_action', 'gen_images → bad_action（限 ffmpeg_merge）')

    const r = await resetStepForRecompose(s.runId, 'compose_video')
    check(r.runId === s.runId, '返回 runId')
    const st = await getStep(s.mergeStepId)
    check(st.status === 'pending' && st.completedAt === null, 'merge 步骤重置（pending）')
    const run = await getRun(s.runId)
    check(run.status === 'queued' && run.currentStepKey === null, 'run 重置（queued / currentStepKey=null）')
    check((await getStep(s.imgStepId)).status === 'succeeded', '上游步骤不受影响（gen_images）')

    // 重复触发：run 已 queued → run_active（防重复重置）
    const eDup = await errOf(() => resetStepForRecompose(s.runId, 'compose_video'))
    check(eDup instanceof WorkbenchError && eDup.code === 'run_active', '重复触发（run queued）→ run_active')

    // failed run 可重新合成
    const s2 = await seedRun()
    await setRunStatus(s2.runId, 'failed')
    const r2 = await resetStepForRecompose(s2.runId, 'compose_video')
    check(r2.runId === s2.runId && (await getRun(s2.runId)).status === 'queued', 'failed run → 重置为 queued')

    // running 拦截
    const s3 = await seedRun()
    await setRunStatus(s3.runId, 'running')
    const eRun = await errOf(() => resetStepForRecompose(s3.runId, 'compose_video'))
    check(eRun instanceof WorkbenchError && eRun.code === 'run_active', 'run running → run_active')
  }

  const sectionMergePlan = async (): Promise<void> => {
    const { computeShotSegments, parseShotDurations } = await import('../src/pipeline/actions/ffmpeg-merge')

    // 真实文件（images 不读内容；clips 空文件探测必失败 → 估算路径）
    const okRel1 = relPathOf(pid, 'shot_image', 'm7-plan-1.png')
    const okRel2 = relPathOf(pid, 'shot_image', 'm7-plan-2.png')
    const okRel3 = relPathOf(pid, 'motion_clip', 'm7-plan-3.mp4')
    const okRel4 = relPathOf(pid, 'motion_clip', 'm7-plan-4.mp4')
    const missingRel = relPathOf(pid, 'shot_image', 'm7-plan-missing.png')
    for (const rel of [okRel1, okRel2, okRel3, okRel4]) writeFileSync(absPathOf(rel), Buffer.from('m7'))

    const row = (id: number, kind: string, relPath: string | null, shotId: string | null, duration?: number): Asset =>
      ({ id, kind, relPath, duration: duration ?? null, params: shotId ? JSON.stringify({ shotId }) : null }) as unknown as Asset

    // ---- images 模式：per-shot 覆盖 + 容错 ----
    const img1 = row(101, 'image', okRel1, 's01')
    const img2 = row(102, 'image', okRel2, 's02')
    const noRel = row(103, 'image', null, 's03')
    const miss = row(104, 'image', missingRel, 's04')
    const wrongKind = row(105, 'video', okRel3, 's05')

    const r1 = computeShotSegments([img1, img2, noRel, miss, wrongKind], 'images', new Map([['s01', 6.5]]), 4)
    check(r1.segments.length === 2 && r1.skipped.length === 3, `images：2 合法段 / 3 跳过（实际 ${r1.segments.length}/${r1.skipped.length}）`)
    check(r1.skipped[0] === 103 && r1.skipped[1] === 104 && r1.skipped[2] === 105, `skipped 顺序（缺 relPath → 缺文件 → kind 不符；实际 [${r1.skipped}]）`)
    check(r1.segments[0]!.durSec === 6.5 && r1.segments[0]!.explicit === true, 'per-shot 覆盖（s01=6.5s explicit）')
    check(r1.segments[1]!.durSec === 4 && !r1.segments[1]!.explicit, '无覆盖 → duration_per_shot=4（非 explicit）')

    // ---- clips 模式：DB duration 优先 → 探测 → 估算 ----
    const v1 = row(106, 'video', okRel3, 's06', 5)
    const v2 = row(107, 'video', okRel4, 's07')
    const vWrong = row(108, 'image', okRel1, 's08')

    const r2 = computeShotSegments([v1, v2, vWrong, miss], 'clips', new Map([['s01', 6.5]]), 4)
    check(r2.segments.length === 2 && r2.skipped.length === 2, `clips：2 合法段 / 2 跳过（实际 ${r2.segments.length}/${r2.skipped.length}）`)
    check(r2.segments[0]!.durSec === 5 && !r2.segments[0]!.estimated, 'DB duration=5 优先（非估算）')
    check(r2.segments[1]!.durSec === 4 && r2.segments[1]!.estimated === true, '探测失败 → duration_per_shot 估算（estimated）')
    check(r2.skipped[0] === 108 && r2.skipped[1] === 104, `clips skipped（kind 不符 → 缺文件；实际 [${r2.skipped}]）`)

    // ---- 空输入 ----
    const r3 = computeShotSegments([], 'images', new Map(), 4)
    check(r3.segments.length === 0 && r3.skipped.length === 0, '空输入 → 空结果')

    // ---- parseShotDurations：双口径回退 + 形态容错 ----
    const pd = parseShotDurations(
      JSON.stringify({
        shots: [
          { id: 's01', duration: 3 },
          { id: 's02', duration_sec: 2.5 },
          { id: 's03', duration: 0, duration_sec: 4 },
          { id: 's04' },
          { id: 5, duration: 2 },
          null,
          'junk',
        ],
      }),
    )
    check(pd.size === 3 && pd.get('s01') === 3 && pd.get('s02') === 2.5 && pd.get('s03') === 4, 'parseShotDurations 双口径（duration 优先 / duration_sec 回退）')
    check(!pd.has('s04') && !pd.has('5'), 'parseShotDurations 非法条目跳过（无时长 / id 非串 / null / 非对象）')
    const pdArr = parseShotDurations(JSON.stringify([{ id: 'a', duration_sec: 1.5 }]))
    check(pdArr.size === 1 && pdArr.get('a') === 1.5, 'parseShotDurations 裸数组形态')
    const ePd = await errOf(async () => parseShotDurations('not-json'))
    check(ePd instanceof SyntaxError, 'parseShotDurations 坏 JSON 抛错（由调用侧兜底）')
  }

  // ================= 分发 =================

  const runners: Record<string, () => Promise<void>> = {
    board: sectionBoard,
    edit: sectionEdit,
    regenerate: sectionRegenerate,
    'gate-reroll': sectionGateReroll,
    select: sectionSelect,
    recompose: sectionRecompose,
    'merge-plan': sectionMergePlan,
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
    console.log(`\n==== M7 探针结果: ${failed > 0 ? `${failed} 项失败` : '全部通过'} ====`)
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
