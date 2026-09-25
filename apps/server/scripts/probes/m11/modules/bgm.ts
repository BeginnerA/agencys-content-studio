/**
 * [M11·拆分] scripts/probe-m11.ts 的 bgm 节（≤800 行红线拆分，断言逐字保留）。
 */
import { existsSync, writeFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import type { M11Ctx } from '../ctx'

export async function sectionBgm(ctx: M11Ctx): Promise<void> {
  const { assets, projects } = await import('../../../../src/db/schema')
  const { WorkbenchError } = await import('../../../../src/services/shot')
  const { db, pid, T0, check, errOf, getAsset, getRun, setRunStatus, seedRun, absPathOf, ensureProjectDirs, registerAsset, relPathOf } = ctx
  const compose = await import('../../../../src/services/compose-config')
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

  // ---- subtitleBurn（成片字幕烧录开关）：通用 run 级写入（运行详情/工作台/节点抽屉经此白名单，与轻松创作确认卡同一 _compose 键）----
  const sbOff = await compose.updateComposeConfig(s.runId, { subtitleBurn: false })
  check(sbOff.subtitleBurn === false, 'subtitleBurn=false 白名单接受')
  check(
    (JSON.parse((await getRun(s.runId)).input) as { _compose?: { subtitleBurn?: boolean } })._compose?.subtitleBurn === false,
    'subtitleBurn=false 落 run.input._compose（ffmpeg-merge 合成期读取）',
  )
  const sbOn = await compose.updateComposeConfig(s.runId, { subtitleBurn: true })
  check(sbOn.subtitleBurn === true, 'subtitleBurn=true 写入')
  const sbClr = await compose.updateComposeConfig(s.runId, { subtitleBurn: null })
  check(sbClr.subtitleBurn === undefined, 'subtitleBurn: null → 清除该键（回落缺省烧录）')
  const eSb = await errOf(() => compose.updateComposeConfig(s.runId, { subtitleBurn: 'no' }))
  check(eSb instanceof WorkbenchError && eSb.code === 'bad_field', 'subtitleBurn 非布尔拒绝')

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
