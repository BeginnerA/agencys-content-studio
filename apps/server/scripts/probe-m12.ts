/**
 * M12 探针（旧版本清理与收藏 + 图像检测）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m12.ts [--section=cleanup|imagecheck|gc|board|merge-guard|regression]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录
 * （独立 studio.db + workspace），不触碰开发库（同 probe-m3~m11）。imagecheck 节用内置
 * ffmpeg（ffmpeg-static）本地构造样本，全程零网络、零计费。
 *
 * section（默认 all）：
 *   cleanup    cleanupVersions：保留规则矩阵（最新 / 收藏 / 被引用；tie→max id）+ 上传组
 *              u:runId:stepId:shotId + 无组跳过 + 非图视过滤 + 已软删跳过 + 范围过滤（runId/stepId）+ 幂等
 *   imagecheck ffmpeg lavfi 样本（黑 / 灰 / 正常 / 截断 / 缺失）→ 判定矩阵 + parseStats 容错 +
 *              checkAndRecordAsset 集成（params 他键保留）+ recordQuality 容错（null / 坏 JSON / 数组）
 *   gc         emptyTrash：批量彻底删除（文件 + 行硬删）/ freedBytes 精确 / 字幕引用跳过保留 / 活跃不碰 / 幂等
 *   trash      回收站服务层：restoreAsset（软删→还原 / bad_state / file_purged / not_found）+
 *              purgeAsset（物理删文件 + 硬删行 / freedBytes / not_found）
 *   board      toVersionView：source / isFavorite / quality 摘要（stats/checkedAt 不下发）+ 参数容错
 *   merge-guard computeShotSegments warnings：异常图警示文案矩阵 + 正常/缺失零警告 + clips 不检 + M7 不破
 *   regression M7/M11 关键纯函数交叉（三时长路径 / 双口径 / 对齐回退）
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import type { Asset } from '../src/db/schema'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
// 清理历史残留：libsql 在 Windows 下不释放文件句柄（close 后仍 EBUSY）——本进程退出时 db 文件必留；
// 本次运行在创建自己的目录前清掉旧的（占用中则跳过，自动收敛为最多一份）。
import { sweepStaleProbeTempDirs, writeProbePidSentinel } from './probe-lib'

const TMP_PREFIX = 'acs-probe-m12-'
// 清理历史残留（跳过存活并行探针目录，避免并行 --jobs≥2 下嵌套回归子探针与顶层同名探针互删 SQLite 库）
sweepStaleProbeTempDirs(TMP_PREFIX)
const TMP = mkdtempSync(join(tmpdir(), TMP_PREFIX))
writeProbePidSentinel(TMP)
process.env.CSTUDIO_ROOT = REPO_ROOT
process.env.CSTUDIO_DATA = join(TMP, 'data')
process.env.CSTUDIO_WORKSPACE = join(TMP, 'workspace')
mkdirSync(process.env.CSTUDIO_DATA, { recursive: true })
mkdirSync(process.env.CSTUDIO_WORKSPACE, { recursive: true })

const SECTIONS = ['cleanup', 'imagecheck', 'gc', 'trash', 'board', 'merge-guard', 'regression'] as const

async function main(): Promise<void> {
  // src 模块全部动态加载（环境变量已隔离）
  const { db, initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')
  const { assets, pipelineRuns, pipelineSteps, projects } = await import('../src/db/schema')
  const { eq, inArray } = await import('drizzle-orm')
  const { absPathOf, ensureProjectDirs, registerAsset, relPathOf } = await import('../src/services/storage')
  const { thumbAbsPath } = await import('../src/services/thumb')

  const log = createLogger('probe-m12')
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

  // ---- setup：隔离库 + 种子工厂 ----
  await initDb()
  const T0 = 1_700_000_000_000

  const mkProject = async (name: string): Promise<number> => {
    const id = (
      await db
        .insert(projects)
        .values({ name, genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!.id
    ensureProjectDirs(id)
    return id
  }
  const mkRun = async (projectId: number): Promise<number> =>
    (
      await db
        .insert(pipelineRuns)
        .values({
          projectId,
          templateKey: 'mengbao-episode',
          status: 'completed',
          input: JSON.stringify({}),
          startedAt: T0,
          completedAt: T0 + 60,
          createdAt: T0,
          updatedAt: T0 + 60,
        })
        .returning()
    )[0]!.id
  const mkStep = async (runId: number, seq: number): Promise<number> =>
    (
      await db
        .insert(pipelineSteps)
        .values({ runId, seq, stepKey: 'gen_images', actionKey: 'ai_image', title: 'gen_images', status: 'succeeded', createdAt: T0 + seq, updatedAt: T0 + seq })
        .returning()
    )[0]!.id
  const getAsset = async (id: number) => (await db.select().from(assets).where(eq(assets.id, id)).limit(1))[0]!

  // ================= sections =================

  const sectionCleanup = async (): Promise<void> => {
    const { cleanupVersions } = await import('../src/services/version-cleanup')
    const pid = await mkProject('M12 探针项目（清理）')

    // 直接插行（精确控制 createdAt 与 id 先后顺序）
    const mkRow = async (o: {
      createdAt: number
      taskId?: number
      runId?: number
      stepId?: number
      kind?: string
      isFavorite?: number
      shotId?: string
      deletedAt?: number
    }): Promise<number> =>
      (
        await db
          .insert(assets)
          .values({
            projectId: pid,
            taskId: o.taskId ?? null,
            runId: o.runId ?? null,
            stepId: o.stepId ?? null,
            kind: o.kind ?? 'image',
            purpose: 'shot_image',
            name: `cleanup-${o.createdAt}.png`,
            params: o.shotId ? JSON.stringify({ shotId: o.shotId }) : null,
            isFavorite: o.isFavorite ?? 0,
            tags: '[]',
            createdAt: o.createdAt,
            updatedAt: o.createdAt,
            deletedAt: o.deletedAt ?? null,
          })
          .returning()
      )[0]!.id

    // run R1 + step S1（S1.output 引用 bRef → 在用豁免）
    const r1 = await mkRun(pid)
    const s1 = await mkStep(r1, 1)

    // A 组（taskId=1001）：最新保留 + 收藏豁免 + 最旧清理
    const aOld = await mkRow({ createdAt: T0 + 10, taskId: 1001 })
    const aNew = await mkRow({ createdAt: T0 + 30, taskId: 1001 })
    const aFav = await mkRow({ createdAt: T0 + 20, taskId: 1001, isFavorite: 1 })
    // B 组（taskId=1002）：最新 + 被引用（output.asset_ids 回指）双保留
    const bNew = await mkRow({ createdAt: T0 + 50, taskId: 1002 })
    const bRef = await mkRow({ createdAt: T0 + 40, taskId: 1002 })
    await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [bRef] }) }).where(eq(pipelineSteps.id, s1))
    // C 组（taskId=1003）：createdAt tie → max(id) 保留
    const c1 = await mkRow({ createdAt: T0 + 60, taskId: 1003 })
    const c2 = await mkRow({ createdAt: T0 + 60, taskId: 1003 })
    // 上传组（taskId=null；组键 u:<runId>:<stepId>:<shotId>）
    const uOld = await mkRow({ createdAt: T0 + 70, runId: r1, stepId: s1, shotId: 'sU' })
    const uNew = await mkRow({ createdAt: T0 + 80, runId: r1, stepId: s1, shotId: 'sU' })
    // 三类跳过：无组（taskId=null 且无 shotId）/ 非图视 kind / 已软删
    const orphan = await mkRow({ createdAt: T0 + 90 })
    const audio = await mkRow({ createdAt: T0 + 11, taskId: 1004, kind: 'audio' })
    const deleted = await mkRow({ createdAt: T0 + 12, taskId: 1005, deletedAt: 999 })

    // D/E 组（范围过滤用：R2 下 S2/S3）
    const r2 = await mkRun(pid)
    const s2 = await mkStep(r2, 1)
    const s3 = await mkStep(r2, 2)
    const d1 = await mkRow({ createdAt: T0 + 100, taskId: 1006, runId: r2, stepId: s2 })
    const d2 = await mkRow({ createdAt: T0 + 110, taskId: 1006, runId: r2, stepId: s2 })
    const e1 = await mkRow({ createdAt: T0 + 120, taskId: 1007, runId: r2, stepId: s3 })
    const e2 = await mkRow({ createdAt: T0 + 130, taskId: 1007, runId: r2, stepId: s3 })

    // ---- 范围过滤：stepId 限定（仅 S2 → D 组旧版清理）----
    const rf1 = await cleanupVersions({ projectId: pid, stepId: s2 })
    check(
      rf1.groups === 1 && rf1.cleaned === 1 && rf1.kept === 1 && rf1.cleanedIds[0] === d1,
      `stepId 过滤（groups=${rf1.groups} cleaned=${rf1.cleaned} kept=${rf1.kept}）`,
    )
    check((await getAsset(d1)).deletedAt !== null && (await getAsset(d2)).deletedAt === null, 'stepId 过滤：d1 软删 / d2 最新保留')
    check((await getAsset(e1)).deletedAt === null, 'stepId 过滤：E 组未波及')

    // ---- 范围过滤：runId 限定（R2 → E 组旧版；D 组 d2 保留）----
    const rf2 = await cleanupVersions({ projectId: pid, runId: r2 })
    check(
      rf2.groups === 2 && rf2.cleaned === 1 && rf2.kept === 2 && rf2.cleanedIds[0] === e1,
      `runId 过滤（groups=${rf2.groups} cleaned=${rf2.cleaned} kept=${rf2.kept}）`,
    )

    // ---- 全项目保留规则矩阵 ----
    const rAll = await cleanupVersions({ projectId: pid })
    check(rAll.groups === 6 && rAll.cleaned === 3 && rAll.kept === 8, `全项目矩阵（groups=${rAll.groups} cleaned=${rAll.cleaned} kept=${rAll.kept}）`)
    const cleanedSet = new Set(rAll.cleanedIds)
    check(
      rAll.cleanedIds.length === 3 && cleanedSet.has(aOld) && cleanedSet.has(c1) && cleanedSet.has(uOld),
      `清理集 = {aOld, c1, uOld}（实际 ${JSON.stringify(rAll.cleanedIds)}）`,
    )
    check((await getAsset(aNew)).deletedAt === null && (await getAsset(aFav)).deletedAt === null, 'A 组：最新 + 收藏保留')
    check((await getAsset(bNew)).deletedAt === null && (await getAsset(bRef)).deletedAt === null, 'B 组：最新 + 被引用保留')
    check((await getAsset(c2)).deletedAt === null, 'C 组：createdAt tie → max(id) 保留')
    check((await getAsset(uNew)).deletedAt === null, '上传组：最新保留')
    check((await getAsset(orphan)).deletedAt === null, '无组资产：跳过不清理')
    check((await getAsset(audio)).deletedAt === null, '非图视 kind：过滤不参与')
    check((await getAsset(deleted)).deletedAt === 999, '已软删行：值不变（跳过）')

    // ---- 幂等：已软删不重复清理 ----
    const rIdem = await cleanupVersions({ projectId: pid })
    check(rIdem.groups === 6 && rIdem.cleaned === 0 && rIdem.kept === 8, `幂等（groups=${rIdem.groups} cleaned=${rIdem.cleaned} kept=${rIdem.kept}）`)

    // ---- 空项目 ----
    const pidEmpty = await mkProject('M12 探针项目（空）')
    const rEmpty = await cleanupVersions({ projectId: pidEmpty })
    check(rEmpty.groups === 0 && rEmpty.cleaned === 0 && rEmpty.kept === 0, '空项目 → 全零（groups/cleaned/kept）')
  }

  const sectionImagecheck = async (): Promise<void> => {
    const { checkImageFile, checkAndRecordAsset, recordQuality, parseStats } = await import('../src/services/image-check')
    const { resolveFfmpeg } = await import('../src/services/ffmpeg')
    const pid = await mkProject('M12 探针项目（检测）')

    // ---- parseStats 容错（纯字符串，不依赖 ffmpeg）----
    const sample = [
      '[Parsed_metadata_1 @ 0x1] frame:0    pts:0       pts_time:0',
      '[Parsed_metadata_1 @ 0x1] lavfi.signalstats.YMIN=16',
      '[Parsed_metadata_1 @ 0x1] lavfi.signalstats.YLOW=17',
      '[Parsed_metadata_1 @ 0x1] lavfi.signalstats.YAVG=100.5',
      '[Parsed_metadata_1 @ 0x1] lavfi.signalstats.YHIGH=220',
      '[Parsed_metadata_1 @ 0x1] lavfi.signalstats.YMAX=235',
      '[Parsed_metadata_1 @ 0x1] lavfi.signalstats.SATAVG=18.25',
    ].join('\n')
    const ps1 = parseStats(sample)
    check(!!ps1 && ps1.ymin === 16 && ps1.ymax === 235 && ps1.yavg === 100.5 && ps1.satavg === 18.25, 'parseStats：完整样本四值')
    const ps2 = parseStats(
      sample
        .split('\n')
        .filter((l) => !l.includes('SATAVG'))
        .join('\n'),
    )
    check(!!ps2 && ps2.satavg === 0 && ps2.yavg === 100.5, 'parseStats：SATAVG 缺失 → 0 兜底')
    check(parseStats('[x] lavfi.signalstats.YMIN=1\n[x] lavfi.signalstats.YMAX=2') === null, 'parseStats：缺 YAVG → null')
    check(parseStats('junk 无统计输出') === null, 'parseStats：无匹配 → null')
    const dup = '[x] lavfi.signalstats.YMIN=10\n[x] lavfi.signalstats.YMAX=30\n[x] lavfi.signalstats.YAVG=25\n[x] lavfi.signalstats.YMIN=20'
    check(parseStats(dup)?.ymin === 10, 'parseStats：重复键 → 首值优先（多帧场景取首帧）')

    // ---- 样本生成（内置 ffmpeg；不可用 → 降级断言宽容路径）----
    const rel = (name: string): string => relPathOf(pid, 'shot_image', name)
    const anyRel = rel('any.png')
    writeFileSync(absPathOf(anyRel), Buffer.from('89504e470d0a1a0a', 'hex'))

    const ffmpeg = resolveFfmpeg()
    if (!ffmpeg) {
      log.warn('ffmpeg 不可用 → 降级断言（ffmpeg_unavailable 宽容路径；跳过样本判定矩阵）')
      const q = await checkImageFile(absPathOf(anyRel))
      check(q.ok === null && q.reason === 'ffmpeg_unavailable', 'ffmpeg 缺失 → ok=null / ffmpeg_unavailable')
      const a = await registerAsset(pid, { name: 'any.png', kind: 'image', purpose: 'shot_image', relPath: anyRel, ext: 'png' })
      const rec = await checkAndRecordAsset(a.id)
      const qq = rec ? ((JSON.parse(rec.params ?? '{}') as { quality?: { ok?: unknown; reason?: unknown } }).quality ?? null) : null
      check(!!qq && qq.ok === null && qq.reason === 'ffmpeg_unavailable', '集成：ffmpeg 缺失 → 宽容写入（ok=null）')
      return
    }

    const blackRel = rel('black.png')
    const grayRel = rel('gray.png')
    const normalRel = rel('normal.png')
    const brokenRel = rel('broken.png')
    const missingRel = rel('missing.png')
    const gen = (outAbs: string, lavfi: string): boolean => {
      const r = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', lavfi, '-frames:v', '1', outAbs], {
        windowsHide: true,
        timeout: 60_000,
      })
      return !r.error && r.status === 0 && existsSync(outAbs)
    }
    const okBlack = gen(absPathOf(blackRel), 'color=c=black:s=64x64')
    const okGray = gen(absPathOf(grayRel), 'color=c=gray:s=64x64')
    const okNormal = gen(absPathOf(normalRel), 'testsrc=s=64x64')
    check(okBlack && okGray && okNormal, 'lavfi 样本生成（黑 / 灰 / 正常）')
    const normalBytes = readFileSync(absPathOf(normalRel))
    check(normalBytes.length > 200, `正常样本尺寸合理（${normalBytes.length}B）`)
    // 截断损坏：保留前 60B（完整 PNG 签名 + IHDR、无可用 IDAT → 解码必败）
    writeFileSync(absPathOf(brokenRel), normalBytes.subarray(0, 60))

    // ---- 判定矩阵（黑图阈值边界实弹校准点：诊断行输出真实 stats）----
    const qBlack = await checkImageFile(absPathOf(blackRel))
    log.info(`  诊断：纯黑样本 stats=${JSON.stringify(qBlack.stats ?? null)} → reason=${qBlack.reason}`)
    check(qBlack.ok === false && qBlack.reason === 'black', `纯黑图 → black（实际 ${qBlack.reason}）`)
    const qGray = await checkImageFile(absPathOf(grayRel))
    log.info(`  诊断：纯灰样本 stats=${JSON.stringify(qGray.stats ?? null)} → reason=${qGray.reason}`)
    check(qGray.ok === false && qGray.reason === 'flat', `纯灰图 → flat（实际 ${qGray.reason}）`)
    const qNormal = await checkImageFile(absPathOf(normalRel))
    check(qNormal.ok === true && qNormal.reason === 'ok', `正常图 → ok（实际 ${qNormal.reason}）`)
    const qBroken = await checkImageFile(absPathOf(brokenRel))
    check(qBroken.ok === false && qBroken.reason === 'broken', `截断损坏 → broken（实际 ${qBroken.reason}）`)
    const qMissing = await checkImageFile(absPathOf(missingRel))
    check(qMissing.ok === false && qMissing.reason === 'no_file', `文件缺失 → no_file（实际 ${qMissing.reason}）`)

    // ---- checkAndRecordAsset 集成（params 他键保留 + 重检覆盖）----
    const mkImgAsset = async (relPath: string, params: Record<string, unknown> | null, name: string) =>
      registerAsset(pid, { name, kind: 'image', purpose: 'shot_image', relPath, ext: 'png', params: params ?? undefined })
    const aNormal = await mkImgAsset(normalRel, { shotId: 'sChk', foo: 1 }, 'rec-normal.png')
    const rec1 = await checkAndRecordAsset(aNormal.id)
    const p1 = JSON.parse(rec1!.params!) as Record<string, unknown>
    const q1 = p1['quality'] as { ok?: unknown; reason?: unknown; checkedAt?: unknown }
    check(q1.ok === true && q1.reason === 'ok' && typeof q1.checkedAt === 'number', '集成：正常图写回 ok / ok / checkedAt')
    check(p1['shotId'] === 'sChk' && p1['foo'] === 1, '集成：params 他键保留（shotId / foo）')

    const aBlack = await mkImgAsset(blackRel, null, 'rec-black.png')
    const rec2 = await checkAndRecordAsset(aBlack.id)
    const q2 = (JSON.parse(rec2!.params!) as { quality?: { reason?: unknown; checkedAt?: unknown } }).quality
    check(!!q2 && q2.reason === 'black', `集成：黑图写回 black（实际 ${String(q2?.reason)}）`)
    const rec2b = await checkAndRecordAsset(aBlack.id)
    const q2b = (JSON.parse(rec2b!.params!) as { quality?: { reason?: unknown; checkedAt?: unknown } }).quality
    check(q2b?.reason === 'black' && Number(q2b?.checkedAt ?? 0) >= Number(q2?.checkedAt ?? 0), '集成：重检覆盖（checkedAt 刷新）')

    const aMissing = await mkImgAsset(missingRel, null, 'rec-missing.png')
    const rec3 = await checkAndRecordAsset(aMissing.id)
    check((JSON.parse(rec3!.params!) as { quality?: { reason?: unknown } }).quality?.reason === 'no_file', '集成：缺失 → no_file 写回')

    // 分支拒绝：非图 / 无 relPath / 不存在 / 已软删
    const aAudio = await registerAsset(pid, { name: 'rec.mp3', kind: 'audio', purpose: 'voice', relPath: relPathOf(pid, 'voice', 'rec.mp3'), ext: 'mp3' })
    check((await checkAndRecordAsset(aAudio.id)) === null, '集成：非图 kind → null')
    const aNoRel = (
      await db.insert(assets).values({ projectId: pid, kind: 'image', name: 'rec-no-rel.png', tags: '[]', createdAt: T0, updatedAt: T0 }).returning()
    )[0]!.id
    check((await checkAndRecordAsset(aNoRel)) === null, '集成：无 relPath → null')
    check((await checkAndRecordAsset(999_999)) === null, '集成：不存在 id → null')
    const aDel = await mkImgAsset(normalRel, null, 'rec-del.png')
    await db.update(assets).set({ deletedAt: T0 + 5 }).where(eq(assets.id, aDel.id))
    check((await checkAndRecordAsset(aDel.id)) === null, '集成：已软删 → null')

    // ---- recordQuality 容错 ----
    const mkRaw = async (params: string | null, name: string) =>
      (await db.insert(assets).values({ projectId: pid, kind: 'image', name, params, tags: '[]', createdAt: T0, updatedAt: T0 }).returning())[0]!
    const rNull = await mkRaw(null, 'rq-null.png')
    const o1 = JSON.parse((await recordQuality(rNull, { ok: true, reason: 'ok' })).params!) as Record<string, unknown>
    check(Object.keys(o1).length === 1 && (o1['quality'] as { reason?: string }).reason === 'ok', 'recordQuality：params=null → 仅写 quality')
    const rBad = await mkRaw('junk', 'rq-bad.png')
    const o2 = JSON.parse((await recordQuality(rBad, { ok: false, reason: 'broken' })).params!) as Record<string, unknown>
    check(Object.keys(o2).length === 1 && (o2['quality'] as { reason?: string }).reason === 'broken', 'recordQuality：坏 JSON → 覆盖为 quality')
    const rArr = await mkRaw('[1,2]', 'rq-arr.png')
    const o3 = JSON.parse((await recordQuality(rArr, { ok: false, reason: 'flat' })).params!) as Record<string, unknown>
    check(Object.keys(o3).length === 1 && (o3['quality'] as { reason?: string }).reason === 'flat', 'recordQuality：数组形态 → 覆盖为 quality')
    const rObj = await mkRaw('{"a":1}', 'rq-obj.png')
    const rObjOut = await recordQuality(rObj, { ok: false, reason: 'black' })
    const o4 = JSON.parse(rObjOut.params!) as Record<string, unknown>
    check(o4['a'] === 1 && (o4['quality'] as { reason?: string }).reason === 'black', 'recordQuality：合法对象 merge（他键保留）')
    const o5 = JSON.parse((await recordQuality(rObjOut, { ok: true, reason: 'ok' })).params!) as Record<string, unknown>
    check(o5['a'] === 1 && (o5['quality'] as { reason?: string }).reason === 'ok', 'recordQuality：二次调用覆盖（reason 更新）')
  }

  const sectionGc = async (): Promise<void> => {
    const { emptyTrash } = await import('../src/services/version-cleanup')
    const pid = await mkProject('M12 探针项目（回收）')
    const mkRow = async (
      relPath: string | null,
      deleted: boolean,
      name: string,
      extra: Partial<typeof assets.$inferInsert> = {},
    ): Promise<number> =>
      (
        await db
          .insert(assets)
          .values({ projectId: pid, kind: 'image', name, relPath, tags: '[]', createdAt: T0, updatedAt: T0, deletedAt: deleted ? T0 + 1 : null, ...extra })
          .returning()
      )[0]!.id

    // d1：已软删 + 原文件（100B）+ thumb（50B）
    const r1 = relPathOf(pid, 'shot_image', 'gc-d1.png')
    writeFileSync(absPathOf(r1), Buffer.alloc(100, 1))
    const d1 = await mkRow(r1, true, 'gc-d1.png')
    writeFileSync(thumbAbsPath(pid, d1), Buffer.alloc(50, 2))
    // d2：已软删 + 原文件（120B，无 thumb）
    const r2 = relPathOf(pid, 'shot_image', 'gc-d2.png')
    writeFileSync(absPathOf(r2), Buffer.alloc(120, 3))
    const d2 = await mkRow(r2, true, 'gc-d2.png')
    // d4：已软删 + 文件缺失（removeFile 跳过，记录仍移除）
    const d4 = await mkRow(relPathOf(pid, 'shot_image', 'gc-d4-missing.png'), true, 'gc-d4.png')
    // d3：活跃 + 原文件（80B，不碰）
    const r3 = relPathOf(pid, 'shot_image', 'gc-d3.png')
    writeFileSync(absPathOf(r3), Buffer.alloc(80, 4))
    const d3 = await mkRow(r3, false, 'gc-d3.png')
    // d5：已软删 + 被历史成片字幕快照引用（保护：文件与记录保留，仍可还原）
    const r5 = relPathOf(pid, 'shot_image', 'gc-d5.png')
    writeFileSync(absPathOf(r5), Buffer.alloc(60, 5))
    const d5 = await mkRow(r5, true, 'gc-d5.png')
    await mkRow(relPathOf(pid, 'final_video', 'gc-final.mp4'), false, 'gc-final.mp4', {
      kind: 'video',
      purpose: 'final_video',
      params: JSON.stringify({ timeline: { subtitle: { assetId: d5 } } }),
    })

    const g1 = await emptyTrash(pid)
    check(
      g1.purged === 3 && g1.files === 3 && g1.freedBytes === 270 && g1.skipped === 1,
      `清空：purged=3 / files=3 / freed=270B / skipped=1（实际 ${g1.purged} / ${g1.files} / ${g1.freedBytes} / ${g1.skipped}）`,
    )
    check(!existsSync(absPathOf(r1)) && !existsSync(thumbAbsPath(pid, d1)), '清空：d1 原文件 + thumb 均删除')
    check(!existsSync(absPathOf(r2)), '清空：d2 原文件删除')
    check(existsSync(absPathOf(r3)), '清空：活跃资产文件不碰')
    check(existsSync(absPathOf(r5)), '清空：字幕引用保护条目文件保留')
    check(
      (await db.select().from(assets).where(inArray(assets.id, [d1, d2, d4]))).length === 0,
      '清空：d1/d2/d4 记录一并移除（条目从回收站消失）',
    )
    check(
      (await db.select().from(assets).where(eq(assets.id, d3))).length === 1 &&
        (await db.select().from(assets).where(eq(assets.id, d5))).length === 1,
      '清空：活跃行 + 字幕引用保护行记录保留（保护条目仍可还原）',
    )
    const g2 = await emptyTrash(pid)
    check(g2.purged === 0 && g2.files === 0 && g2.freedBytes === 0, `清空幂等（purged=${g2.purged} files=${g2.files} freed=${g2.freedBytes}）`)
  }

  const sectionTrash = async (): Promise<void> => {
    const { restoreAsset, purgeAsset, CleanupError } = await import('../src/services/version-cleanup')
    const pid = await mkProject('M12 探针项目（回收站）')
    const mkRow = async (relPath: string | null, deleted: boolean, name: string): Promise<number> =>
      (
        await db
          .insert(assets)
          .values({ projectId: pid, kind: 'image', name, relPath, tags: '[]', createdAt: T0, updatedAt: T0, deletedAt: deleted ? T0 + 1 : null })
          .returning()
      )[0]!.id

    // r1：已软删 + 文件在 → 可还原
    const rel1 = relPathOf(pid, 'shot_image', 'tr-r1.png')
    writeFileSync(absPathOf(rel1), Buffer.alloc(90, 5))
    const r1 = await mkRow(rel1, true, 'tr-r1.png')
    const restored = await restoreAsset(r1)
    check(restored.deletedAt === null && (await getAsset(r1)).deletedAt === null, 'restore：软删行 → deletedAt=null')
    check(existsSync(absPathOf(rel1)), 'restore：物理文件不受影响')

    // 幂等拒绝：未删除行 → bad_state；不存在 → not_found；文件已被 GC → file_purged
    const eBad = await errOf(() => restoreAsset(r1))
    check(eBad instanceof CleanupError && eBad.code === 'bad_state', 'restore：未删除行 → bad_state')
    const eNF = await errOf(() => restoreAsset(999_999))
    check(eNF instanceof CleanupError && eNF.code === 'not_found', 'restore：不存在 id → not_found')
    const rel2 = relPathOf(pid, 'shot_image', 'tr-r2.png') // 不写文件（模拟已被回收空间清除）
    const r2 = await mkRow(rel2, true, 'tr-r2.png')
    const ePurged = await errOf(() => restoreAsset(r2))
    check(ePurged instanceof CleanupError && ePurged.code === 'file_purged', 'restore：文件已清除 → file_purged')
    check((await getAsset(r2)).deletedAt !== null, 'restore 被拒：行保持软删状态')

    // purge：物理删原文件 + thumb，硬删行
    const rel3 = relPathOf(pid, 'shot_image', 'tr-r3.png')
    writeFileSync(absPathOf(rel3), Buffer.alloc(70, 6))
    const r3 = await mkRow(rel3, true, 'tr-r3.png')
    writeFileSync(thumbAbsPath(pid, r3), Buffer.alloc(30, 7))
    const pr = await purgeAsset(r3)
    check(pr.files === 2 && pr.freedBytes === 100, `purge：files=2 / freed=100B（实际 ${pr.files} / ${pr.freedBytes}）`)
    check(!existsSync(absPathOf(rel3)) && !existsSync(thumbAbsPath(pid, r3)), 'purge：原文件 + thumb 均物理删除')
    check((await db.select().from(assets).where(eq(assets.id, r3)).limit(1)).length === 0, 'purge：数据行硬删（回收站条目消失）')
    const ePrNF = await errOf(() => purgeAsset(999_999))
    check(ePrNF instanceof CleanupError && ePrNF.code === 'not_found', 'purge：不存在 id → not_found')
  }

  const sectionBoard = async (): Promise<void> => {
    const { toVersionView } = await import('../src/services/shot')
    const stub = (over: Partial<Asset>): Asset =>
      ({
        id: 901,
        projectId: 1,
        stepId: null,
        taskId: 11,
        runId: null,
        kind: 'image',
        purpose: 'shot_image',
        name: 'v.png',
        mime: 'image/png',
        ext: 'png',
        fileSize: null,
        width: 64,
        height: 64,
        duration: null,
        sha256: null,
        relPath: '1/images/v.png',
        prompt: 'p',
        params: null,
        tags: '[]',
        isFavorite: 0,
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
        ...over,
      }) as Asset

    const vTask = toVersionView(stub({}))
    check(vTask.source === 'task' && vTask.isFavorite === 0, 'source：taskId 非空 → task / isFavorite 透传 0')
    const vUp = toVersionView(stub({ taskId: null, isFavorite: 1 }))
    check(vUp.source === 'upload' && vUp.isFavorite === 1, 'source：taskId=null → upload / isFavorite 透传 1')

    check(toVersionView(stub({ params: null })).quality === null, 'quality：params=null → null')
    check(toVersionView(stub({ params: 'junk' })).quality === null, 'quality：坏 JSON → null')
    check(toVersionView(stub({ params: '{"quality":"x"}' })).quality === null, 'quality：非对象 → null')
    check(toVersionView(stub({ params: '{"quality":[1]}' })).quality === null, 'quality：数组 → null（缺 reason）')
    check(toVersionView(stub({ params: '{"quality":{"ok":true}}' })).quality === null, 'quality：缺 reason → null')
    const vOk = toVersionView(stub({ params: '{"quality":{"reason":"black","ok":"yes"}}' }))
    check(!!vOk.quality && vOk.quality.ok === null && vOk.quality.reason === 'black', 'quality：ok 非 boolean → null 兜底（reason 保留）')
    const vFull = toVersionView(stub({ params: '{"quality":{"ok":false,"reason":"black","stats":{"ymin":0},"checkedAt":123}}' }))
    check(
      !!vFull.quality && vFull.quality.ok === false && vFull.quality.reason === 'black'
        && JSON.stringify(Object.keys(vFull.quality).sort()) === JSON.stringify(['ok', 'reason']),
      'quality：摘要仅 ok/reason（stats / checkedAt 不下发）',
    )

    check(vTask.urls.file === '/api/v1/assets/901/file' && vTask.urls.thumb === '/api/v1/assets/901/thumb?v=2', 'urls：file / thumb(v=2)')
    check(toVersionView(stub({ kind: 'audio' })).urls.thumb === null, 'urls：非图视 kind → thumb=null')
    check(vTask.name === 'v.png' && vTask.width === 64 && vTask.height === 64 && vTask.prompt === 'p', '基本字段透传（name / width / height / prompt）')
  }

  const sectionMergeGuard = async (): Promise<void> => {
    const { computeShotSegments } = await import('../src/pipeline/actions/ffmpeg-merge')
    const pid = await mkProject('M12 探针项目（合成警示）')

    const mk = (id: number, params: Record<string, unknown> | string | null): Asset => {
      const r = relPathOf(pid, 'shot_image', `mg-${id}.png`)
      writeFileSync(absPathOf(r), Buffer.from(`m12-${id}`))
      return {
        id,
        kind: 'image',
        relPath: r,
        duration: null,
        deletedAt: null,
        params: typeof params === 'string' ? params : params ? JSON.stringify(params) : null,
      } as unknown as Asset
    }

    const m1 = mk(301, { shotId: 's01' }) // 无检测数据 → 零警告
    const m2 = mk(302, { quality: { ok: false, reason: 'black' }, shotId: 's02' })
    const m3 = mk(303, { quality: { ok: true, reason: 'ok' } })
    const m4 = mk(304, { quality: { ok: null, reason: 'ffmpeg_unavailable' } })
    const m5 = mk(305, 'junk')
    const m6 = mk(306, { quality: { ok: false } })
    const m7 = mk(307, { quality: { ok: false, reason: 'weird' } })
    const m8 = mk(308, { quality: { ok: false, reason: 'flat' } })

    const r1 = computeShotSegments([m1, m2, m3, m4, m5, m6, m7, m8], 'images', new Map([['s01', 6]]), 4)
    check(r1.segments.length === 8 && r1.skipped.length === 0, `M7 不破：8 段全命中（实际 ${r1.segments.length} 段 / ${r1.skipped.length} 跳过）`)
    check(r1.warnings.length === 4, `warnings=4（black / unknown / weird / flat；实际 ${r1.warnings.length}）`)
    check(r1.warnings[0]!.includes('asset#302') && r1.warnings[0]!.includes('疑似黑图'), `warn[0] 黑图文案（${r1.warnings[0]}）`)
    check(r1.warnings[1]!.includes('asset#306') && r1.warnings[1]!.includes('unknown'), 'warn[1]：缺 reason → unknown 兜底')
    check(r1.warnings[2]!.includes('asset#307') && r1.warnings[2]!.includes('weird'), 'warn[2]：未知 reason 原样回退')
    check(r1.warnings[3]!.includes('asset#308') && r1.warnings[3]!.includes('疑似纯色空白图'), 'warn[3]：flat 文案')
    check(r1.segments[0]!.durSec === 6 && r1.segments[0]!.explicit === true, 'M7 不破：per-shot 覆盖（explicit 6s）')
    check(r1.segments[1]!.durSec === 4 && !r1.segments[1]!.explicit, 'M7 不破：默认 duration_per_shot（4s）')

    // clips 模式：不检 quality（仅 images 分支）
    const vRel = relPathOf(pid, 'motion_clip', 'mg-v1.mp4')
    writeFileSync(absPathOf(vRel), Buffer.from('m12v'))
    const v1 = {
      id: 401,
      kind: 'video',
      relPath: vRel,
      duration: 5,
      deletedAt: null,
      params: JSON.stringify({ quality: { ok: false, reason: 'black' } }),
    } as unknown as Asset
    const r2 = computeShotSegments([v1], 'clips', new Map(), 4)
    check(r2.warnings.length === 0 && r2.segments.length === 1 && r2.segments[0]!.durSec === 5, 'clips 模式：不检 quality（零警告）+ DB duration 优先')
  }

  const sectionRegression = async (): Promise<void> => {
    const { computeShotSegments, parseShotDurations, planVoiceAlignedSegments, parseShotLines } = await import('../src/pipeline/actions/ffmpeg-merge')
    const pid = await mkProject('M12 探针项目（回归）')

    const rel1 = relPathOf(pid, 'shot_image', 'rg-1.png')
    const rel2 = relPathOf(pid, 'shot_image', 'rg-2.png')
    const rel3 = relPathOf(pid, 'motion_clip', 'rg-3.mp4')
    for (const r of [rel1, rel2, rel3]) writeFileSync(absPathOf(r), Buffer.from('m12rg'))
    const row = (id: number, kind: string, relPath: string | null, shotId: string | null, duration?: number): Asset =>
      ({ id, kind, relPath, duration: duration ?? null, params: shotId ? JSON.stringify({ shotId }) : null }) as unknown as Asset

    // M7：均分 / explicit 覆盖 / clips duration 优先
    const r1 = computeShotSegments([row(501, 'image', rel1, 's01'), row(502, 'image', rel2, 's02')], 'images', new Map(), 4)
    check(r1.segments.length === 2 && r1.segments.every((s) => s.durSec === 4 && !s.explicit) && r1.warnings.length === 0, 'M7 均分（4s ×2 / 非 explicit / 零警告）')
    const r2 = computeShotSegments([row(503, 'image', rel1, 's01')], 'images', new Map([['s01', 6.5]]), 4)
    check(r2.segments[0]!.durSec === 6.5 && r2.segments[0]!.explicit === true, 'M7 explicit 覆盖（6.5s）')
    const r3 = computeShotSegments([row(504, 'video', rel3, 's03', 5)], 'clips', new Map(), 4)
    check(r3.segments[0]!.durSec === 5 && !r3.segments[0]!.estimated, 'M7 clips：DB duration 优先（5s / 非估算）')

    // M7：parseShotDurations 双口径 + 坏 JSON 抛错
    const pd = parseShotDurations(JSON.stringify({ shots: [{ id: 's01', duration: 3 }, { id: 's02', duration_sec: 2.5 }] }))
    check(pd.get('s01') === 3 && pd.get('s02') === 2.5, 'M7 时长双口径（duration / duration_sec 回退）')
    const ePd = await errOf(async () => parseShotDurations('not-json'))
    check(ePd instanceof SyntaxError, 'M7 坏 JSON 抛错（调用侧兜底）')

    // M11：对齐一致映射 / 回退 / parseShotLines
    const plan = planVoiceAlignedSegments(
      [
        { id: 's01', durationSec: 10, lineIds: ['L1', 'L2'] },
        { id: 's02', durationSec: null, lineIds: [] as string[] },
      ],
      new Map([
        ['L1', 2],
        ['L2', 3],
      ]),
      4,
      { hasLinesField: true },
    )
    check(plan.aligned && plan.segments.length === 2 && plan.segments[0]!.silenceSec === 5 && plan.totalDur === 14, 'M11 对齐（镜尾静音 5s / totalDur 14）')
    const f3 = planVoiceAlignedSegments([{ id: 's01', durationSec: 2, lineIds: ['L1'] }], new Map([['L1', 1]]), 4, { hasLinesField: false })
    check(!f3.aligned && f3.reason === 'no_lines_field', 'M11 回退：老分镜 no_lines_field')
    const p2 = parseShotLines(JSON.stringify([{ id: 'a', duration: 2 }]))
    check(p2.shots.length === 1 && !p2.hasLinesField, 'M11 parseShotLines：裸数组 + 无 lines → hasLinesField=false')
  }

  // ================= 分发 =================

  const runners: Record<string, () => Promise<void>> = {
    cleanup: sectionCleanup,
    imagecheck: sectionImagecheck,
    gc: sectionGc,
    trash: sectionTrash,
    board: sectionBoard,
    'merge-guard': sectionMergeGuard,
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
    console.log(`\n==== M12 探针结果: ${failed > 0 ? `${failed} 项失败` : '全部通过'} ====`)
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
