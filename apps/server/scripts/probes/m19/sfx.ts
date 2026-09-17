/** M19[sfx]：purposeSubDir 登记 + 服务层 CRUD（bindSfxFromUpload/Asset/去重/sha256 复用/校验族/状态门卫/列表移除）+ planSfxStarts 起点矩阵 + buildComposeArgs 混音链四组合/索引递推/零 diff + sfx_volume clamp（断言体逐字搬自原 probe-m19.ts） */
import { existsSync } from 'node:fs'
import type { M19Ctx } from './ctx'

export async function run(ctx: M19Ctx): Promise<void> {
  const { check, db, pid, T0, errOf, mkProject, eq, purposeSubDir, pipelineRuns, buildComposeArgs, mkArgsInput } = ctx
  {
    check(purposeSubDir('sfx') === 'audio', "purposeSubDir('sfx') → audio 子目录")
    check(purposeSubDir('bgm') === 'source', 'purposeSubDir 未登记 purpose 回退 source（bgm 现状）')

    // ---- [P4] 服务层 CRUD（真实落库/落盘；不触发执行） ----
    const {
      bindSfxFromUpload,
      bindSfxFromAsset,
      loadSfxAssets,
      getSfxList,
      removeSfx,
      updateComposeConfig,
    } = await import('../../../src/services/compose-config')
    const { registerAsset, relPathOf, absPathOf } = await import('../../../src/services/storage')
    const { assets } = await import('../../../src/db/schema')
    const runSfx = (
      await db
        .insert(pipelineRuns)
        .values({ projectId: pid, templateKey: 'mengbao-episode', status: 'completed', input: '{}', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!

    // 上传绑定：行属性 + 落 audio 子目录
    const bytesHit = new Uint8Array([1, 2, 3, 4, 5])
    const a1 = await bindSfxFromUpload(runSfx.id, 'shot-1', { name: 'hit.mp3', data: bytesHit })
    const p1 = JSON.parse(a1.params ?? '{}') as { shotId?: string; source?: string }
    check(
      a1.kind === 'audio' && a1.purpose === 'sfx' && a1.runId === runSfx.id && p1.shotId === 'shot-1' && p1.source === 'upload',
      'bindSfxFromUpload 落行（kind/purpose/runId + params.shotId=shot-1，source=upload）',
    )
    check(!!a1.relPath && a1.relPath.includes('audio') && existsSync(absPathOf(a1.relPath)), 'SFX 文件落 audio 子目录且存在')

    // 每镜 ≤1 条：同镜重绑 → 软删旧行 + Map 命中新行
    const bytesNew = new Uint8Array([9, 9, 9])
    const a1b = await bindSfxFromUpload(runSfx.id, 'shot-1', { name: 'hit2.mp3', data: bytesNew })
    const map1 = await loadSfxAssets(runSfx.id)
    check(map1.size === 1 && map1.get('shot-1')?.id === a1b.id, '同镜重绑 → 每镜 ≤1 条（Map 命中新行）')
    const old1 = (await db.select().from(assets).where(eq(assets.id, a1.id)).limit(1))[0]!
    check(old1.deletedAt !== null, '重绑软删旧行（deletedAt 非空；不物理删除）')

    // sha256 复用：同内容异镜 → 复制行复用 relPath（不重复落盘）
    const a2 = await bindSfxFromUpload(runSfx.id, 'shot-2', { name: 'hit2-copy.mp3', data: bytesNew })
    check(a2.id !== a1b.id && a2.relPath === a1b.relPath, 'sha256 命中 → 复制行复用 relPath（同内容不重复落盘）')

    // 项目音频复制行绑定（relPath 复用；不污染源资产行）
    const srcA = await registerAsset(pid, {
      name: 'library.wav',
      kind: 'audio',
      purpose: 'source',
      relPath: relPathOf(pid, 'source', 'library.wav'),
    })
    const a3 = await bindSfxFromAsset(runSfx.id, 'shot-3', srcA.id)
    const p3 = JSON.parse(a3.params ?? '{}') as { shotId?: string; source?: string; source_asset_id?: number }
    check(
      a3.id !== srcA.id && a3.relPath === srcA.relPath && p3.source === 'asset' && p3.source_asset_id === srcA.id,
      'bindSfxFromAsset 复制行（params.source_asset_id + relPath 复用）',
    )

    // 校验族：shotId/扩展名/跨项目/非 audio/不存在
    const badShot = await errOf(async () => bindSfxFromUpload(runSfx.id, '  ', { name: 'x.mp3', data: bytesHit }))
    check(badShot instanceof Error && /shot_id/.test(String(badShot)), '空 shotId → 拒绝（bad_shot）')
    const badExt = await errOf(async () => bindSfxFromUpload(runSfx.id, 'shot-x', { name: 'x.txt', data: bytesHit }))
    check(badExt instanceof Error && /类型不符/.test(String(badExt)), '非音频扩展名 → 拒绝（bad_kind）')
    const pidOther = await mkProject('M19 探针项目5')
    const foreign = await registerAsset(pidOther, { name: 'f.wav', kind: 'audio', purpose: 'source', relPath: 'other/f.wav' })
    const badForeign = await errOf(async () => bindSfxFromAsset(runSfx.id, 'shot-x', foreign.id))
    check(badForeign instanceof Error && /不属于本项目/.test(String(badForeign)), '跨项目资产 → 拒绝（bad_asset）')
    const imgAsset = await registerAsset(pid, { name: 'i.png', kind: 'image', purpose: 'source', relPath: 'x/i.png' })
    const badKindA = await errOf(async () => bindSfxFromAsset(runSfx.id, 'shot-x', imgAsset.id))
    check(badKindA instanceof Error && /类型不符/.test(String(badKindA)), '非 audio 资产 → 拒绝（bad_asset）')
    const badMiss = await errOf(async () => bindSfxFromAsset(runSfx.id, 'shot-x', 999_999))
    check(badMiss instanceof Error && /不存在/.test(String(badMiss)), '资产不存在 → 拒绝（bad_asset）')

    // run 状态门卫（活跃拒绝——与 BGM 同语义）
    const runActive = (
      await db
        .insert(pipelineRuns)
        .values({ projectId: pid, templateKey: 'mengbao-episode', status: 'running', input: '{}', createdAt: T0, updatedAt: T0 })
        .returning()
    )[0]!
    const activeBind = await errOf(async () => bindSfxFromUpload(runActive.id, 'shot-1', { name: 'x.mp3', data: bytesHit }))
    check(activeBind instanceof Error && /正在执行/.test(String(activeBind)), 'running run → 绑定拒绝（run_active）')
    const activeList = await errOf(async () => getSfxList(runActive.id))
    check(activeList instanceof Error, 'running run → 列表拒绝（requireEditableRun 同语义）')

    // 列表 + 移除（幂等）
    const list1 = await getSfxList(runSfx.id)
    check(list1.length === 3, 'getSfxList 返回全部有效绑定（shot-1/2/3 共 3 条）')
    await removeSfx(runSfx.id, 'shot-1')
    const mapAfter = await loadSfxAssets(runSfx.id)
    check(mapAfter.size === 2 && !mapAfter.has('shot-1'), 'removeSfx 后该镜消失（其余保留）')
    await removeSfx(runSfx.id, 'shot-none')
    check((await loadSfxAssets(runSfx.id)).size === 2, 'removeSfx 未知镜 → 幂等（无绑定不报错）')

    // ---- [P4] planSfxStarts：起点矩阵（无转场/转场同口径/片头位移/缺失跳过） ----
    const { planSfxStarts, buildTransitionPlan } = await import('../../../src/pipeline/actions/ffmpeg-merge')
    const okA = (shotId: string, assetId: number): { shotId: string; assetId: number; relPath: string; fileOk: boolean } => ({
      shotId,
      assetId,
      relPath: `p/${shotId}.mp3`,
      fileOk: true,
    })
    const m1 = planSfxStarts([3, 3], ['s1', 's2'], [okA('s1', 11), okA('s2', 12)], 0)
    check(m1.entries.length === 2 && m1.entries[0]!.startSec === 0 && m1.entries[1]!.startSec === 3, '起点矩阵：无转场 [0,3]（Σ_{j<i} d_j）')
    const m2 = planSfxStarts([3, 3], ['s1', 's2'], [okA('s1', 11), okA('s2', 12)], 2.5)
    check(m2.entries[0]!.startSec === 2.5 && m2.entries[1]!.startSec === 5.5, '起点矩阵：片头位移 +2.5 → [2.5,5.5]')
    const tp = buildTransitionPlan([3.5, 2, 4], 'fade', 0.5)
    const m3 = planSfxStarts([3.5, 2, 4], ['s1', 's2', 's3'], [okA('s1', 11), okA('s2', 12), okA('s3', 13)], 0)
    check(
      tp.enabled && JSON.stringify(tp.offsets) === '[3.5,5.5]' && m3.entries[1]!.startSec === tp.offsets[0] && m3.entries[2]!.startSec === tp.offsets[1],
      '转场同口径：镜 i 起点 === xfade offsets[i-1]（转场不改变 Σd 公式）',
    )
    const m4 = planSfxStarts([3, 3], ['s1', 's2'], [okA('s1', 11), { shotId: 's2', assetId: 12, relPath: null, fileOk: true }], 0)
    check(m4.entries.length === 1 && m4.missing.length === 1 && m4.missing[0]!.shotId === 's2', 'relPath 缺失 → missing 跳过（其余照常产出）')
    const m5 = planSfxStarts([3, 3], ['s1', 's2'], [{ shotId: 's1', assetId: 11, relPath: 'p/s1.mp3', fileOk: false }], 0)
    check(m5.entries.length === 0 && m5.missing.length === 1, 'fileOk=false（文件缺失）→ missing（不产条目）')
    const m6 = planSfxStarts([3, 3], [null, 's2'], [okA('s2', 12)], 0)
    check(m6.entries.length === 1 && m6.entries[0]!.startSec === 3, 'segmentShotIds 含 null → 该镜无匹配（起点仍按 Σd 递进）')
    const m7 = planSfxStarts([0.1, 0.2, 0.3], ['s1', 's2', 's3'], [okA('s3', 13)], 0)
    check(m7.entries[0]!.startSec === 0.3, 'round3 防浮点尾数（0.1+0.2 累积 → 0.3；未收敛则为 0.30000000000000004）')

    // ---- [P4] buildComposeArgs：混音链四组合 + 索引递推 + 零 diff ----
    const sfx2 = [{ path: 'C:/s1.mp3', startSec: 0 }, { path: 'C:/s2.mp3', startSec: 3 }]
    const c1 = buildComposeArgs(
      mkArgsInput({ voicePaths: ['C:/v1.m4a'], lineIds: ['l1'], bgmPath: 'C:/bgm.mp3', sfx: sfx2, sfxVolume: 0.8 }),
    )
    const c1Fc = c1.args[c1.args.indexOf('-filter_complex') + 1]!
    check(c1Fc.includes('[outa][bgm]amix=inputs=2:duration=first:normalize=0[amain]'), '组合①：配音+BGM 主混出 [amain]（不再直出 [aout]）')
    check(c1Fc.includes('[amain][sfx0][sfx1]amix=inputs=3:duration=first:normalize=0[aout]'), '组合①：SFX 终混 inputs=3 并入 [aout]')
    check(
      c1Fc.includes('[4:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.8,adelay=0|0[sfx0]'),
      'SFX 逐条链：索引 4（2 段+1 配音+1 BGM）+ volume 0.8 + adelay 0',
    )
    check(c1Fc.includes('[5:a]') && c1Fc.includes('adelay=3000|3000[sfx1]'), 'SFX 第二条：索引 5 + adelay=3000|3000（起点 3s）')
    check(c1.args.includes('-c:a') && c1.args.includes('192k'), 'maps [aout] + aac 192k 启用')
    const c2 = buildComposeArgs(mkArgsInput({ voicePaths: ['C:/v1.m4a'], lineIds: ['l1'], sfx: [sfx2[0]!] }))
    const c2Fc = c2.args[c2.args.indexOf('-filter_complex') + 1]!
    check(
      c2Fc.includes('[outa][sfx0]amix=inputs=2:duration=first:normalize=0[aout]') && !c2Fc.includes('[amain]'),
      '组合②：有配音无 BGM → [outa] 直并 SFX（无 [amain]）',
    )
    const c3 = buildComposeArgs(mkArgsInput({ bgmPath: 'C:/bgm.mp3', sfx: [sfx2[0]!] }))
    const c3Fc = c3.args[c3.args.indexOf('-filter_complex') + 1]!
    check(
      c3Fc.includes('[bgm][sfx0]amix=inputs=2:duration=first:normalize=0[aout]') && !c3Fc.includes('anull[aout]'),
      '组合③：无配音有 BGM → [bgm] 直并 SFX（无 [bgm]anull）',
    )
    const c4 = buildComposeArgs(mkArgsInput({ sfx: sfx2 }))
    const c4Fc = c4.args[c4.args.indexOf('-filter_complex') + 1]!
    check(
      c4Fc.includes('[sfx0][sfx1]amix=inputs=2:duration=longest:normalize=0,apad=whole_dur=6[aout]'),
      '组合④：仅 SFX → longest + apad=whole_dur=6（钉住正片总长）',
    )
    check(c4Fc.includes('[2:a]') && c4Fc.includes('[3:a]'), '组合④：SFX 输入索引自 2 起（无 aux 槽）')
    const c5 = buildComposeArgs(
      mkArgsInput({
        watermark: { path: 'C:/wm.png', position: 'br', opacity: 0.9, width_pct: 0.15, margin_px: 24 },
        intro: { path: 'C:/i.mp4', durSec: 2 },
        outro: { path: 'C:/o.mp4', durSec: 4 },
        sfx: [sfx2[0]!],
      }),
    )
    const c5Fc = c5.args[c5.args.indexOf('-filter_complex') + 1]!
    check(
      c5Fc.includes('[5:a]aresample') && c5Fc.includes('apad=whole_dur=12[aout]'),
      '索引递推：水印+片头尾全开 → SFX 索引 5；仅 SFX 时 apad=totalAll(12)',
    )
    const base0 = JSON.stringify(buildComposeArgs(mkArgsInput({})).args)
    check(JSON.stringify(buildComposeArgs(mkArgsInput({ sfx: [] })).args) === base0, '零 diff：sfx:[] === 无 sfx（args 逐字节一致）')
    check(JSON.stringify(buildComposeArgs(mkArgsInput({ sfxVolume: 0.5 })).args) === base0, '零 diff：仅 sfxVolume（无 SFX）不影响 args')

    // ---- [P4] sfx_volume clamp（0–2；与 bgm_volume 0–1 独立） ----
    const cfgS1 = await updateComposeConfig(runSfx.id, { sfx_volume: 5 })
    check(cfgS1.sfx_volume === 2, 'sfx_volume 上界 clamp（5 → 2）')
    const cfgS2 = await updateComposeConfig(runSfx.id, { sfx_volume: -1 })
    check(cfgS2.sfx_volume === 0, 'sfx_volume 下界 clamp（-1 → 0）')
    const cfgS3 = await updateComposeConfig(runSfx.id, { bgm_volume: 0.5, sfx_volume: 1.5 })
    check(cfgS3.bgm_volume === 0.5 && cfgS3.sfx_volume === 1.5, 'bgm_volume 与 sfx_volume 共存独立（0–1 / 0–2）')
    const badVol = await errOf(async () => updateComposeConfig(runSfx.id, { sfx_volume: 'x' }))
    check(badVol instanceof Error && /数字/.test(String(badVol)), 'sfx_volume 非数字 → 拒绝（bad_field）')
  }
}
