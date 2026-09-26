/**
 * precision-rework 探针 · compose-input 分节（切片2：合成输入本地返修）——自 probe-precision-rework.ts 拆出：
 * m26 split-audit 红线单文件 ≤800 行。文件名不带 probe- 前缀：本模块是被主探针 import 的库，
 * 不是可独立执行的探针（run-probes 按 probe-*.ts 扫描）。断言文案逐字保留，与拆出前完全一致。
 * 隔离库 + 假媒体字节：零网络、零付费、零供应商调用（src 模块经主探针 isolatedEnv 后动态加载）。
 */
import { createFixtureTools, type CheckFn } from './precision-rework-sections'

// 预览回执回放（GET 视图，纯读取）——局部 helper 仅在本分节使用
async function preview_getView(requestId: string): Promise<{ state: string }> {
  const pv = await import('../src/services/rework/preview')
  return pv.getReworkRequestView(requestId)
}

export async function runComposeInputSection(check: CheckFn): Promise<void> {
  // 切片2 T1：合成输入本地返修能力门禁 + 基准指纹核（capability.ts 纯新增）
  const tools = await createFixtureTools(94)
  const { db, pipelineRuns, pipelineSteps, assets, genTasks, now, mkRun, mkFixture } = tools
  const { eq, and, isNull } = await import('drizzle-orm')
  const cap = await import('../src/services/rework/capability')
  const baselineMod = await import('../src/services/rework/baseline')
  let tick = 0
  const ts = (): number => now + ++tick
  const mkBgm = async (runId: number, sha: string): Promise<number> => {
    const r = await db.insert(assets).values({ projectId: 94, kind: 'audio', purpose: 'bgm', name: 'b.mp3', relPath: `94/bgm/${sha}.mp3`, mime: 'audio/mpeg', ext: 'mp3', sha256: sha, fileSize: 10, params: '{}', tags: '[]', runId, createdAt: ts(), updatedAt: ts() }).returning()
    return r[0]!.id
  }
  const mkSfx = async (runId: number, shotId: string, sha: string): Promise<number> => {
    const r = await db.insert(assets).values({ projectId: 94, kind: 'audio', purpose: 'sfx', name: 's.mp3', relPath: `94/sfx/${sha}.mp3`, mime: 'audio/mpeg', ext: 'mp3', sha256: sha, fileSize: 10, params: JSON.stringify({ shotId }), tags: '[]', runId, createdAt: ts(), updatedAt: ts() }).returning()
    return r[0]!.id
  }
  const softDel = async (id: number): Promise<void> => { await db.update(assets).set({ deletedAt: ts(), updatedAt: ts() }).where(eq(assets.id, id)) }
  const setCompose = async (runId: number, cfg: Record<string, unknown>): Promise<void> => {
    const r = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1))[0]!
    const input = JSON.parse(r.input) as Record<string, unknown>
    input._compose = cfg
    await db.update(pipelineRuns).set({ input: JSON.stringify(input), updatedAt: ts() }).where(eq(pipelineRuns.id, runId))
  }

  /* ── 能力支持：无字幕快照成片仍可返修（证明不依赖字幕快照） ── */
  const runId = await mkRun('completed')
  await mkFixture(runId, { stripTimeline: true })
  const a1 = await cap.assessComposeInputCapability(runId, 'compose')
  check(a1.capability.supported && a1.baseline !== null, '无字幕快照成片：合成输入返修能力仍支持（不要求字幕快照）')
  const sub = await baselineMod.assessSubtitleCapability(runId, 'compose')
  check(!sub.capability.supported && sub.capability.code === 'legacy_no_snapshot', '同一成片字幕返修被拦（对照：本闸确不依赖字幕）')
  const a2 = await cap.assessComposeInputCapability(runId, 'compose')
  check(!!a1.baseline && !!a2.baseline && a1.baseline.fingerprint === a2.baseline.fingerprint, '同一依赖两次合成输入指纹一致（可重复比较）')
  check(!!a1.baseline && a1.baseline.bgm.assetId === null && a1.baseline.sfx.length === 0, '初始基准：无在用 BGM/SFX（assetId null / sfx 空表）')

  /* ── 配置漂移 → 指纹变 ── */
  const fpInit = a1.baseline!.fingerprint
  await setCompose(runId, { bgm_volume: 0.5 })
  const a3 = await cap.assessComposeInputCapability(runId, 'compose')
  check(!!a3.baseline && a3.baseline.fingerprint !== fpInit, 'bgm_volume 配置变更 → 依赖指纹漂移')
  const fpCfg = a3.baseline!.fingerprint

  /* ── BGM 换绑/移除即刻入指纹（不等重合成，源资产不删） ── */
  const bgm1 = await mkBgm(runId, 'bgm-sha-1')
  const a4 = await cap.assessComposeInputCapability(runId, 'compose')
  check(!!a4.baseline && a4.baseline.fingerprint !== fpCfg && a4.baseline.bgm.assetId === bgm1 && a4.baseline.bgm.sha256 === 'bgm-sha-1', 'BGM 绑定 → 指纹漂移且基准反映在用 BGM id/sha')
  await softDel(bgm1)
  const bgm2 = await mkBgm(runId, 'bgm-sha-2')
  const a5 = await cap.assessComposeInputCapability(runId, 'compose')
  check(!!a5.baseline && a5.baseline.fingerprint !== a4.baseline!.fingerprint && a5.baseline.bgm.assetId === bgm2, 'BGM 换绑第二首 → 指纹再漂移且指向新在用资产（旧行软删可回溯）')
  await softDel(bgm2)
  const a6 = await cap.assessComposeInputCapability(runId, 'compose')
  check(!!a6.baseline && a6.baseline.fingerprint !== a5.baseline!.fingerprint && a6.baseline.bgm.assetId === null, 'BGM 移除 → 指纹回漂移且基准无在用 BGM')

  /* ── SFX 逐镜绑定入指纹 ── */
  const fpNoSfx = a6.baseline!.fingerprint
  const sfx1 = await mkSfx(runId, 'shot-1', 'sfx-sha-1')
  const a7 = await cap.assessComposeInputCapability(runId, 'compose')
  check(!!a7.baseline && a7.baseline.fingerprint !== fpNoSfx && a7.baseline.sfx.some((x: { shotId: string; assetId: number }) => x.shotId === 'shot-1' && x.assetId === sfx1), '某镜 SFX 绑定 → 指纹漂移且基准含该镜在用 SFX')

  /* ── 候选改选（生成步 asset_ids 重写）经 stepOutputs 入指纹 ── */
  const imgA = await db.insert(assets).values({ projectId: 94, kind: 'image', purpose: 'shot', name: 'a.png', relPath: '94/image/a.png', mime: 'image/png', ext: 'png', sha256: 'img-a', fileSize: 5, params: JSON.stringify({ shotId: 'shot-1' }), tags: '[]', runId, createdAt: ts(), updatedAt: ts() }).returning()
  const imgB = await db.insert(assets).values({ projectId: 94, kind: 'image', purpose: 'shot', name: 'b.png', relPath: '94/image/b.png', mime: 'image/png', ext: 'png', sha256: 'img-b', fileSize: 5, params: JSON.stringify({ shotId: 'shot-1' }), tags: '[]', runId, createdAt: ts(), updatedAt: ts() }).returning()
  const genStep = await db.insert(pipelineSteps).values({ runId, seq: 1, stepKey: 'shots_gen', actionKey: 'ai_image', status: 'succeeded', output: JSON.stringify({ asset_ids: [imgA[0]!.id] }), attempts: 1, createdAt: ts(), updatedAt: ts() }).returning()
  const genStepId = genStep[0]!.id
  const aBeforeSelect = await cap.assessComposeInputCapability(runId, 'compose')
  await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [imgB[0]!.id] }), updatedAt: ts() }).where(eq(pipelineSteps.id, genStepId))
  const aAfterSelect = await cap.assessComposeInputCapability(runId, 'compose')
  check(!!aBeforeSelect.baseline && !!aAfterSelect.baseline && aBeforeSelect.baseline.fingerprint !== aAfterSelect.baseline.fingerprint, '候选改选（在用 assetId 切换）→ 依赖指纹漂移')

  /* ── 消费期复验：稳定态等于基准指纹；缺成片返回 null ── */
  const rc1 = await cap.computeFingerprintForComposeInputRecheck(runId, 'compose')
  check(rc1 === aAfterSelect.baseline!.fingerprint, '消费期复验与 assess 基准指纹同源一致')
  const noFinalRun = await mkRun('completed')
  await db.insert(pipelineSteps).values({ runId: noFinalRun, seq: 2, stepKey: 'compose', actionKey: 'ffmpeg_merge', status: 'succeeded', output: '{}', attempts: 1, createdAt: ts(), updatedAt: ts() })
  const rcNull = await cap.computeFingerprintForComposeInputRecheck(noFinalRun, 'compose')
  check(rcNull === null, '缺成片消费期复验返回 null（调用方 fail closed）')

  /* ── 门禁失败态逐一 ── */
  check((await cap.assessComposeInputCapability(999999, 'compose')).capability.code === 'run_not_found', '不存在 run → run_not_found')
  const activeRun = await mkRun('running')
  await mkFixture(activeRun)
  check((await cap.assessComposeInputCapability(activeRun, 'compose')).capability.code === 'run_active', '运行在途 → run_active')
  const cancelledRun = await mkRun('cancelled')
  await mkFixture(cancelledRun)
  check((await cap.assessComposeInputCapability(cancelledRun, 'compose')).capability.code === 'run_cancelled', '运行已取消 → run_cancelled')
  const noStepRun = await mkRun('completed')
  check((await cap.assessComposeInputCapability(noStepRun, 'compose')).capability.code === 'no_compose_step', '无合成步 → no_compose_step')
  check((await cap.assessComposeInputCapability(noFinalRun, 'compose')).capability.code === 'no_final', '合成步无有效成片 → no_final')
  const notSettledRun = await mkRun('completed')
  await mkFixture(notSettledRun)
  await db.update(pipelineSteps).set({ status: 'pending' }).where(eq(pipelineSteps.stepKey, 'compose'))
  check((await cap.assessComposeInputCapability(notSettledRun, 'compose')).capability.code === 'compose_not_settled', '合成步未 succeeded → compose_not_settled')
  const failRun = await mkRun('completed')
  await mkFixture(failRun)
  await db.insert(pipelineSteps).values({ runId: failRun, seq: 3, stepKey: 'pub', actionKey: 'publication_ingest', status: 'failed', output: '{}', attempts: 1, createdAt: ts(), updatedAt: ts() })
  check((await cap.assessComposeInputCapability(failRun, 'compose')).capability.code === 'other_failed', '范围外失败步 → other_failed')
  const paidRun = await mkRun('completed')
  await mkFixture(paidRun)
  await db.insert(pipelineSteps).values({ runId: paidRun, seq: 3, stepKey: 'more', actionKey: 'ai_video', status: 'pending', output: null, attempts: 0, createdAt: ts(), updatedAt: ts() })
  check((await cap.assessComposeInputCapability(paidRun, 'compose')).capability.code === 'downstream_paid', '下游待执行付费步 → downstream_paid')

  /* ── T2 契约层（纯函数）：parse / 冲突 / clamp（委托真源）/ no_effect / canonical 稳定 ── */
  const ci = await import('../src/services/rework/compose-input')
  const cur = { config: { bgm_volume: 0.5, transition: 'fade' }, bgmAssetId: 10, sfxByShot: { 's1': 20 }, selectedByShot: { 's1': 30 } }

  const okParse = ci.parseComposeInputChanges([
    { kind: 'compose-config', patch: { bgm_volume: 0.8 } },
    { kind: 'bgm', assetId: null },
    { kind: 'sfx', shotId: 's1', assetId: 21 },
    { kind: 'shot-select', shotId: 's2', assetId: 31 },
  ])
  check(okParse.ok && okParse.changes.length === 4, '混合四类合法变更通过 schema')
  const parseRej = (input: unknown, msg: string): void => { check(!ci.parseComposeInputChanges(input).ok, msg) }
  parseRej([], '空变更列表拒绝')
  parseRej([{ kind: 'unknown-op' }], '未知 kind 拒绝')
  parseRej([{ kind: 'bgm', assetId: 1, extra: 2 }], '额外字段（strict）拒绝')
  parseRej([{ kind: 'bgm', assetId: 0 }], 'bgm assetId ≤0 拒绝')
  parseRej([{ kind: 'shot-select', shotId: 's1', assetId: null }], 'shot-select 不接受 null assetId 拒绝')
  parseRej([{ kind: 'sfx', shotId: '', assetId: 5 }], '空 shotId 拒绝')
  parseRej([{ kind: 'compose-config', patch: {} }], '空 config patch 拒绝')
  parseRej(Array.from({ length: 501 }, (_, i) => ({ kind: 'sfx', shotId: `s${i}`, assetId: 5 })), '超 500 变更上限拒绝')

  // 冲突：单 run 多 BGM / 同镜重复 / 同键异值
  const confBg = ci.compileComposeInputChanges({ changes: [{ kind: 'bgm', assetId: 11 }, { kind: 'bgm', assetId: 12 }] as never, current: cur as never })
  check(!confBg.ok && confBg.errors.some((e: { code: string }) => e.code === 'conflicting_changes'), '多次 BGM 变更冲突拒绝')
  const confShot = ci.compileComposeInputChanges({ changes: [{ kind: 'sfx', shotId: 's1', assetId: 21 }, { kind: 'sfx', shotId: 's1', assetId: 22 }] as never, current: cur as never })
  check(!confShot.ok && confShot.errors.some((e: { code: string }) => e.code === 'conflicting_changes'), '同镜重复 SFX 指定冲突拒绝')
  const confKey = ci.compileComposeInputChanges({ changes: [{ kind: 'compose-config', patch: { bgm_volume: 0.8 } }, { kind: 'compose-config', patch: { bgm_volume: 0.9 } }] as never, current: cur as never })
  check(!confKey.ok && confKey.errors.some((e: { code: string }) => e.code === 'conflicting_changes'), '同配置键异值多次指定冲突拒绝')

  // 委托真源：clamp + 枚举 + brandApply + 未知键 bad_field
  const clamped = ci.compileComposeInputChanges({ changes: [{ kind: 'compose-config', patch: { bgm_volume: 1.5 } }] as never, current: cur as never })
  check(clamped.ok && clamped.normalized.nextConfig?.bgm_volume === 1, 'bgm_volume 1.5 经真源 clamp 到 1（不重抄）')
  check(clamped.ok && clamped.normalized.diffs.some((d: { field: string; after: unknown }) => d.field === 'bgm_volume' && d.after === 1), 'clamp 后 diff 展示旧 0.5→新 1')
  const badEnum = ci.compileComposeInputChanges({ changes: [{ kind: 'compose-config', patch: { transition: 'wipe' } }] as never, current: cur as never })
  check(!badEnum.ok && badEnum.errors.some((e: { code: string }) => e.code === 'bad_field'), 'transition 越枚举经真源拒绝')
  const badKey = ci.compileComposeInputChanges({ changes: [{ kind: 'compose-config', patch: { foo: 1 } }] as never, current: cur as never })
  check(!badKey.ok && badKey.errors.some((e: { code: string; message: string }) => e.code === 'bad_field' && e.message.includes('未知配置键')), '未知配置键经真源白名单拒绝')
  const applyBool = ci.compileComposeInputChanges({ changes: [{ kind: 'compose-config', patch: { brandApply: false } }] as never, current: cur as never })
  check(applyBool.ok && applyBool.normalized.nextConfig?.brandApply === false, 'brandApply=false 纳入可写配置（与确认卡同键）')
  const clearNull = ci.compileComposeInputChanges({ changes: [{ kind: 'compose-config', patch: { bgm_volume: null } }] as never, current: cur as never })
  check(clearNull.ok && clearNull.normalized.diffs.some((d: { field: string; after: unknown }) => d.field === 'bgm_volume' && d.after === null), '配置值 null = 统一清除回落缺省')

  // no_effect：与当前基准一致整体拒
  const noEff = ci.compileComposeInputChanges({ changes: [{ kind: 'bgm', assetId: 10 }] as never, current: cur as never })
  check(!noEff.ok && noEff.errors.some((e: { code: string }) => e.code === 'no_effect'), 'BGM 换绑到当前在用同资产 → no_effect 整体拒')
  const noEffCfg = ci.compileComposeInputChanges({ changes: [{ kind: 'compose-config', patch: { bgm_volume: 0.5 } }] as never, current: cur as never })
  check(!noEffCfg.ok && noEffCfg.errors.some((e: { code: string }) => e.code === 'no_effect'), '配置旧值相同 → no_effect 整体拒')

  // canonical 稳定：乱序输入规范化后字节一致（previewHash 稳定）
  const canonA = ci.compileComposeInputChanges({ changes: [{ kind: 'shot-select', shotId: 's2', assetId: 31 }, { kind: 'sfx', shotId: 'b', assetId: 21 }, { kind: 'sfx', shotId: 'a', assetId: 22 }] as never, current: cur as never })
  const canonB = ci.compileComposeInputChanges({ changes: [{ kind: 'sfx', shotId: 'a', assetId: 22 }, { kind: 'sfx', shotId: 'b', assetId: 21 }, { kind: 'shot-select', shotId: 's2', assetId: 31 }] as never, current: cur as never })
  check(canonA.ok && canonB.ok && JSON.stringify(canonA.normalized.changes) === JSON.stringify(canonB.normalized.changes), '乱序变更规范化后 canonical 字节一致')
  check(canonA.ok && JSON.stringify(canonA.normalized.changes.map((c: { kind: string }) => c.kind)) === JSON.stringify(['sfx', 'sfx', 'shot-select']), 'canonical 序：config→bgm→sfx→shot-select，sfx 按 shotId 升序')

  /* ── T3 预览编译器（零执行）：ready/幂等/blocked/资产校验/shot-select 同步骤同类/零状态写入 ── */
  const cip = await import('../src/services/rework/compose-input-preview')
  const pvRun = await mkRun('completed')
  await mkFixture(pvRun, { stripTimeline: true })
  // 项目音频池（kind=audio 未绑定的换绑/换绑目标，purpose=music 不污染 loadBgm/loadSfx）
  const mkPoolAudio = async (sha: string): Promise<number> => {
    const r = await db.insert(assets).values({ projectId: 94, kind: 'audio', purpose: 'music', name: 'p.mp3', relPath: `94/music/${sha}.mp3`, mime: 'audio/mpeg', ext: 'mp3', sha256: sha, fileSize: 10, params: '{}', tags: '[]', runId: pvRun, createdAt: ts(), updatedAt: ts() }).returning()
    return r[0]!.id
  }
  const poolBgm = await mkPoolAudio('pool-bgm')
  const poolSfx = await mkPoolAudio('pool-sfx')
  // 生成步两候选（同镜 shot-1，imgA 在用/imgB 同类候选）
  const pvImgA = (await db.insert(assets).values({ projectId: 94, kind: 'image', purpose: 'shot', name: 'a.png', relPath: '94/image/pva.png', mime: 'image/png', ext: 'png', sha256: 'pva', fileSize: 5, params: JSON.stringify({ shotId: 'shot-1' }), tags: '[]', runId: pvRun, createdAt: ts(), updatedAt: ts() }).returning())[0]!.id
  const pvImgB = (await db.insert(assets).values({ projectId: 94, kind: 'image', purpose: 'shot', name: 'b.png', relPath: '94/image/pvb.png', mime: 'image/png', ext: 'png', sha256: 'pvb', fileSize: 5, params: JSON.stringify({ shotId: 'shot-1' }), tags: '[]', runId: pvRun, createdAt: ts(), updatedAt: ts() }).returning())[0]!.id
  await db.insert(pipelineSteps).values({ runId: pvRun, seq: 1, stepKey: 'shots_gen', actionKey: 'ai_image', status: 'succeeded', output: JSON.stringify({ asset_ids: [pvImgA, pvImgB] }), attempts: 1, createdAt: ts(), updatedAt: ts() })
  const assetCountBefore = (await db.select().from(assets)).length

  // 1) 配置预览就绪：成本诚实 localReencode/modelCalls0/charged false，仅重置合成步
  const pvCfg = await cip.buildComposeInputPreview({ runId: pvRun, requestKey: 'cip-cfg', changes: [{ kind: 'compose-config', patch: { bgm_volume: 0.3 } }] })
  check(pvCfg.outcome === 'ready' && 'preview' in pvCfg && pvCfg.preview.impact.localReencode === true && pvCfg.preview.impact.modelCalls === 0 && pvCfg.preview.impact.charged === false, '配置预览：零付费但如实标本地重编码（不冒充逐字节/已核验）')
  check('preview' in pvCfg && /^([0-9a-f]{64})$/.test(pvCfg.preview.previewHash) && pvCfg.preview.impact.resetSteps.join() === 'compose' && pvCfg.preview.diffs.some((d: { field: string; after: unknown }) => d.field === 'bgm_volume' && d.after === 0.3), '预览固定 previewHash + 仅重置 compose 步 + 逐处 原值→新值')

  // 2) 零执行态写入：run/step/task/asset 全不动
  const pvRunRow = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, pvRun)).limit(1))[0]!
  check(pvRunRow.status === 'completed' && (await db.select().from(assets)).length === assetCountBefore, '预览不改 run 状态、不新建任何资产（零执行纯推导）')
  const pvSteps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, pvRun))
  check(pvSteps.every((s: { status: string }) => s.status === 'succeeded'), '预览不重置任何步骤')

  // 3) 幂等回放 + 同键异载荷冲突
  const pvCfgRe = await cip.buildComposeInputPreview({ runId: pvRun, requestKey: 'cip-cfg', changes: [{ kind: 'compose-config', patch: { bgm_volume: 0.3 } }] })
  check(pvCfgRe.outcome === 'replayed' && 'requestId' in pvCfgRe && pvCfgRe.requestId === (pvCfg as { requestId: string }).requestId, '同键同载荷回放既有预览')
  const pvCfgCon = await cip.buildComposeInputPreview({ runId: pvRun, requestKey: 'cip-cfg', changes: [{ kind: 'compose-config', patch: { bgm_volume: 0.9 } }] })
  check(pvCfgCon.outcome === 'conflict' && pvCfgCon.code === 'idempotency_conflict', '同键异载荷冲突（routes 层 409）')

  // 4) BGM/SFX 换绑到已存在项目音频：就绪
  const pvBgm = await cip.buildComposeInputPreview({ runId: pvRun, requestKey: 'cip-bgm', changes: [{ kind: 'bgm', assetId: poolBgm }] })
  check(pvBgm.outcome === 'ready' && 'preview' in pvBgm && pvBgm.preview.diffs.some((d: { kind: string; after: unknown }) => d.kind === 'bgm' && d.after === poolBgm), 'BGM 换绑到已存在项目音频 → 预览就绪 diff null→新 id')
  const pvSfx = await cip.buildComposeInputPreview({ runId: pvRun, requestKey: 'cip-sfx', changes: [{ kind: 'sfx', shotId: 'shot-2', assetId: poolSfx }] })
  check(pvSfx.outcome === 'ready', '某镜 SFX 换绑到已存在项目音频 → 预览就绪')

  // 5) 资产校验 fail-closed：不存在/非音频/越项目均 blocked 可回放
  const pvBad = await cip.buildComposeInputPreview({ runId: pvRun, requestKey: 'cip-bad', changes: [{ kind: 'bgm', assetId: 999999 }] })
  check(pvBad.outcome === 'blocked' && pvBad.code === 'bad_asset' && !!pvBad.requestId, 'BGM 目标资产不存在 → blocked（fail closed）')
  const pvBadImg = await cip.buildComposeInputPreview({ runId: pvRun, requestKey: 'cip-bad2', changes: [{ kind: 'bgm', assetId: pvImgA }] })
  check(pvBadImg.outcome === 'blocked' && pvBadImg.code === 'bad_asset', 'BGM 目标非音频资产 → blocked')
  const pvView = await preview_getView(pvBad.requestId!)
  check(pvView.state === 'blocked', 'blocked 回执可经 requestId 回放失败原因')

  // 6) shot-select：同步骤同类候选通过；非候选/异 kind 拒绝
  const pvSel = await cip.buildComposeInputPreview({ runId: pvRun, requestKey: 'cip-sel', changes: [{ kind: 'shot-select', shotId: 'shot-1', assetId: pvImgB }] })
  check(pvSel.outcome === 'ready' && 'preview' in pvSel && pvSel.preview.diffs.some((d: { kind: string; before: unknown; after: unknown }) => d.kind === 'shot-select' && d.before === pvImgA && d.after === pvImgB), '候选改选到同步骤同类另一资产 → 就绪 diff 旧在用→新候选')
  const pvSelBad = await cip.buildComposeInputPreview({ runId: pvRun, requestKey: 'cip-selbad', changes: [{ kind: 'shot-select', shotId: 'shot-1', assetId: poolBgm }] })
  check(pvSelBad.outcome === 'blocked', '改选到非该步骤 output 的资产 → blocked（不越步骤/kind）')

  // 7) no_effect：与当前基准一致整体拒（blocked）
  await setCompose(pvRun, { transition: 'fade' })
  const pvNo = await cip.buildComposeInputPreview({ runId: pvRun, requestKey: 'cip-no', changes: [{ kind: 'compose-config', patch: { transition: 'fade' } }] })
  check(pvNo.outcome === 'blocked' && pvNo.code === 'no_effect', '配置旧值相同 → no_effect 整体拒登记 blocked')

  /* ── T4 原子确认 + 本地续跑 + apply：真实配置/换绑/选片落真源、末事务翻状态、幂等回放、过期即拒、零付费 ── */
  const engineMod = await import('../src/pipeline/engine')
  const started: number[] = []
  engineMod.engine.startRun = ((runId: number) => { started.push(runId); return 'started' }) as typeof engineMod.engine.startRun
  engineMod.engine.pumpGlobal = (async () => {}) as typeof engineMod.engine.pumpGlobal
  const apply = await import('../src/services/rework/compose-input-apply')
  const composeStepRow = async (runId: number) => (await db.select().from(pipelineSteps).where(and(eq(pipelineSteps.runId, runId), eq(pipelineSteps.stepKey, 'compose'))).limit(1))[0]!

  // A. 配置返修确认：预览→确认 applied、run→queued、仅合成步 pending + 旧 gate 作废、_compose 落真源、引擎启动一次
  const apRun = await mkRun('completed')
  const apFix = await mkFixture(apRun, { stripTimeline: true })
  await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [apFix.finalId], gate: { decision: 'approve', at: now } }) }).where(eq(pipelineSteps.id, apFix.composeId))
  const apImgA = (await db.insert(assets).values({ projectId: 94, kind: 'image', purpose: 'shot', name: 'a.png', relPath: '94/image/apa.png', mime: 'image/png', ext: 'png', sha256: 'apa', fileSize: 5, params: JSON.stringify({ shotId: 'shot-1' }), tags: '[]', runId: apRun, createdAt: ts(), updatedAt: ts() }).returning())[0]!.id
  const apImgB = (await db.insert(assets).values({ projectId: 94, kind: 'image', purpose: 'shot', name: 'b.png', relPath: '94/image/apb.png', mime: 'image/png', ext: 'png', sha256: 'apb', fileSize: 5, params: JSON.stringify({ shotId: 'shot-1' }), tags: '[]', runId: apRun, createdAt: ts(), updatedAt: ts() }).returning())[0]!.id
  await db.insert(pipelineSteps).values({ runId: apRun, seq: 1, stepKey: 'shots_gen', actionKey: 'ai_image', status: 'succeeded', output: JSON.stringify({ asset_ids: [apImgA, apImgB] }), attempts: 1, createdAt: ts(), updatedAt: ts() })
  const apCfgPv = await cip.buildComposeInputPreview({ runId: apRun, requestKey: 'ap-cfg', changes: [{ kind: 'compose-config', patch: { bgm_volume: 0.3 } }] })
  check(apCfgPv.outcome === 'ready', 'apply 前置：配置预览就绪')
  const apCfgHash = (apCfgPv as { preview: { previewHash: string } }).preview.previewHash
  const rWrongHash = await apply.applyComposeInputRework({ requestId: (apCfgPv as { requestId: string }).requestId, previewHash: '0'.repeat(64) })
  const runAfterWrong = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, apRun)).limit(1))[0]!
  check(rWrongHash.outcome === 'rejected' && rWrongHash.code === 'stale_preview' && runAfterWrong.status === 'completed', 'previewHash 不符拒绝：零状态变化')
  const rCfg = await apply.applyComposeInputRework({ requestId: (apCfgPv as { requestId: string }).requestId, previewHash: apCfgHash })
  check(rCfg.outcome === 'applied' && rCfg.result.enqueued === true && rCfg.result.resetSteps.join() === 'compose' && rCfg.result.gateInvalidated === true, '配置返修确认 → applied 回执（仅重置合成步、旧 gate 作废）')
  const runCfgRow = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, apRun)).limit(1))[0]!
  check(runCfgRow.status === 'queued' && (JSON.parse(runCfgRow.input) as { _compose?: { bgm_volume?: number } })._compose?.bgm_volume === 0.3, '确认后 run→queued 且 _compose.bgm_volume 落真源 0.3')
  const apCfgStep = await composeStepRow(apRun)
  check(apCfgStep.status === 'pending' && (JSON.parse(apCfgStep.output ?? '{}') as { gate?: unknown }).gate === undefined, '确认后合成步 pending 且旧终审 gate 作废（必复审）')
  check(started.length === 1 && started[0] === apRun, '事务提交后才启动引擎（本 run 一次）')
  const rCfgRe = await apply.applyComposeInputRework({ requestId: (apCfgPv as { requestId: string }).requestId, previewHash: apCfgHash })
  check(rCfgRe.outcome === 'replayed' && JSON.stringify(rCfgRe.result) === JSON.stringify(rCfg.result) && started.length === 1, 'applied 回放：回执幂等可回放、不二次入队/不重复启动')

  // B. BGM 换绑到项目另一音频：确认在用指针切换、源资产不删、历史可回溯
  const bgmRun = await mkRun('completed')
  await mkFixture(bgmRun, { stripTimeline: true })
  const apPoolBgm = await mkPoolAudio('ap-bgm')
  const pvBgmAp = await cip.buildComposeInputPreview({ runId: bgmRun, requestKey: 'ap-bgm', changes: [{ kind: 'bgm', assetId: apPoolBgm }] })
  const rBgm = await apply.applyComposeInputRework({ requestId: (pvBgmAp as { requestId: string }).requestId, previewHash: (pvBgmAp as { preview: { previewHash: string } }).preview.previewHash })
  check(rBgm.outcome === 'applied' && rBgm.result.bgmTo === apPoolBgm, 'BGM 换绑确认 → applied 回执记录新在用 id')
  const activeBgm = (await db.select().from(assets).where(and(eq(assets.runId, bgmRun), eq(assets.purpose, 'bgm'), isNull(assets.deletedAt)))).length
  const poolRow = (await db.select().from(assets).where(eq(assets.id, apPoolBgm)).limit(1))[0]!
  check(activeBgm === 1 && poolRow.deletedAt === null && poolRow.purpose === 'music', '在用 BGM 行唯一、源项目音频未删未被改写（仅新增指向同文件的绑定行）')

  // C. BGM 移除：先绑一首 → 预览移除 → 确认软删在用行（源文件保留）
  const rmRun = await mkRun('completed')
  await mkFixture(rmRun, { stripTimeline: true })
  const seededBgm = await mkBgm(rmRun, 'rm-bgm')
  const pvRm = await cip.buildComposeInputPreview({ runId: rmRun, requestKey: 'ap-rm', changes: [{ kind: 'bgm', assetId: null }] })
  const rRm = await apply.applyComposeInputRework({ requestId: (pvRm as { requestId: string }).requestId, previewHash: (pvRm as { preview: { previewHash: string } }).preview.previewHash })
  const liveBgmAfterRm = (await db.select().from(assets).where(and(eq(assets.runId, rmRun), eq(assets.purpose, 'bgm'), isNull(assets.deletedAt)))).length
  const seededRow = (await db.select().from(assets).where(eq(assets.id, seededBgm)).limit(1))[0]!
  check(rRm.outcome === 'applied' && rRm.result.bgmTo === null && liveBgmAfterRm === 0 && seededRow.deletedAt !== null, 'BGM 移除确认 → 无在用行、旧绑定行软删可回溯')

  // D. 候选改选：仅该镜在用版本变、其余输出不变、不触发生成任务
  const selRun = await mkRun('completed')
  await mkFixture(selRun, { stripTimeline: true })
  const selImgA = (await db.insert(assets).values({ projectId: 94, kind: 'image', purpose: 'shot', name: 'a.png', relPath: '94/image/sela.png', mime: 'image/png', ext: 'png', sha256: 'sela', fileSize: 5, params: JSON.stringify({ shotId: 'shot-1' }), tags: '[]', runId: selRun, createdAt: ts(), updatedAt: ts() }).returning())[0]!.id
  const selImgB = (await db.insert(assets).values({ projectId: 94, kind: 'image', purpose: 'shot', name: 'b.png', relPath: '94/image/selb.png', mime: 'image/png', ext: 'png', sha256: 'selb', fileSize: 5, params: JSON.stringify({ shotId: 'shot-1' }), tags: '[]', runId: selRun, createdAt: ts(), updatedAt: ts() }).returning())[0]!.id
  await db.insert(pipelineSteps).values({ runId: selRun, seq: 1, stepKey: 'shots_gen', actionKey: 'ai_image', status: 'succeeded', output: JSON.stringify({ asset_ids: [selImgA, selImgB] }), attempts: 1, createdAt: ts(), updatedAt: ts() })
  const pvSelAp = await cip.buildComposeInputPreview({ runId: selRun, requestKey: 'ap-sel', changes: [{ kind: 'shot-select', shotId: 'shot-1', assetId: selImgB }] })
  const rSel = await apply.applyComposeInputRework({ requestId: (pvSelAp as { requestId: string }).requestId, previewHash: (pvSelAp as { preview: { previewHash: string } }).preview.previewHash })
  const genAfterSel = (await db.select().from(pipelineSteps).where(and(eq(pipelineSteps.runId, selRun), eq(pipelineSteps.stepKey, 'shots_gen'))).limit(1))[0]!
  const genIdsAfter = (JSON.parse(genAfterSel.output ?? '{}') as { asset_ids?: number[] }).asset_ids ?? []
  const tasksAfterSel = (await db.select().from(genTasks).where(eq(genTasks.runId, selRun))).length
  check(rSel.outcome === 'applied' && rSel.result.selections.length === 1 && rSel.result.selections[0]!.toAssetId === selImgB && genIdsAfter.includes(selImgB) && !genIdsAfter.includes(selImgA) && genAfterSel.status === 'succeeded' && tasksAfterSel === 0, '候选改选确认 → 生成步在用切到新候选、生成步仍 succeeded、零新增生成任务（不重生媒体）')

  // E. 过期即拒：预览后旁路直改 _compose（指纹漂移）→ apply 重验拦断、不套用到新基准
  const staleRun = await mkRun('completed')
  await mkFixture(staleRun, { stripTimeline: true })
  const pvStale = await cip.buildComposeInputPreview({ runId: staleRun, requestKey: 'ap-stale', changes: [{ kind: 'compose-config', patch: { bgm_volume: 0.4 } }] })
  await setCompose(staleRun, { bgm_volume: 0.99 })
  const rStale = await apply.applyComposeInputRework({ requestId: (pvStale as { requestId: string }).requestId, previewHash: (pvStale as { preview: { previewHash: string } }).preview.previewHash })
  const runStaleRow = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, staleRun)).limit(1))[0]!
  check(rStale.outcome === 'rejected' && rStale.code === 'stale_preview' && runStaleRow.status === 'completed', '预览后旁路改配置使指纹漂移 → 确认期重验拒 stale_preview，run 不变')

  // F. 非 ready 拒绝：blocked 回执不可确认
  const nrRun = await mkRun('completed')
  await mkFixture(nrRun, { stripTimeline: true })
  const pvNr = await cip.buildComposeInputPreview({ runId: nrRun, requestKey: 'ap-nr', changes: [{ kind: 'bgm', assetId: 999999 }] })
  const rNr = await apply.applyComposeInputRework({ requestId: (pvNr as { requestId: string }).requestId, previewHash: 'f'.repeat(64) })
  check(pvNr.outcome === 'blocked' && rNr.outcome === 'rejected' && rNr.code === 'not_ready', 'blocked 请求不可确认（必须先有效预览）')

  /* ── T5 全同类入口收口：任何入口把 compose 步重置为 pending 时，旧终审批 gate 一并作废（旧批准不自动沿用） ──
     方案A：在共享原语 resetStepForRecompose（通用 recompose + 轻松创作 recomposeCreation 皆经此）
     与 resetStepForRerun（单步重跑）内统一作废，一处收口覆盖全部本地重合成入口。 ── */
  const { resetStepForRecompose, resetStepForRerun } = await import('../src/services/shot/reset')

  // G1. 通用重新合成入口（POST /runs/:id/recompose → resetStepForRecompose）：旧 gate 作废、产物保留
  const g1Run = await mkRun('completed')
  const g1Fix = await mkFixture(g1Run, { stripTimeline: true })
  await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [g1Fix.finalId], gate: { decision: 'approve', at: now } }) }).where(eq(pipelineSteps.id, g1Fix.composeId))
  await resetStepForRecompose(g1Run, 'compose')
  const g1Step = (await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, g1Fix.composeId)).limit(1))[0]!
  const g1Out = JSON.parse(g1Step.output ?? '{}') as { gate?: unknown; asset_ids?: number[] }
  check(g1Step.status === 'pending' && g1Out.gate === undefined && Array.isArray(g1Out.asset_ids), '通用 recompose 重置 compose 步 → 旧终审 gate 作废（新成片必复审）、历史产物保留')

  // G2. 单步重跑入口（resetStepForRerun 目标=compose 步）：旧 gate 同样作废
  const g2Run = await mkRun('completed')
  const g2Fix = await mkFixture(g2Run, { stripTimeline: true })
  await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [g2Fix.finalId], gate: { decision: 'approve', at: now } }) }).where(eq(pipelineSteps.id, g2Fix.composeId))
  await resetStepForRerun(g2Run, 'compose', {})
  const g2Step = (await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, g2Fix.composeId)).limit(1))[0]!
  const g2Out = JSON.parse(g2Step.output ?? '{}') as { gate?: unknown }
  check(g2Step.status === 'pending' && g2Out.gate === undefined, '单步重跑重置 compose 步 → 旧终审 gate 作废')

  // G3. 收口范围守边界：非 compose 步（生成/转写步）重跑不误伤其 gate（仅合成步 gate 与「成片必复审」不变量绑定）
  const g3Run = await mkRun('completed')
  const g3Fix = await mkFixture(g3Run, { stripTimeline: true })
  const g3Captions = (await db.select().from(pipelineSteps).where(and(eq(pipelineSteps.runId, g3Run), eq(pipelineSteps.stepKey, 'captions'))).limit(1))[0]!
  await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [g3Fix.srcId], gate: { decision: 'approve', at: now } }) }).where(eq(pipelineSteps.id, g3Captions.id))
  await resetStepForRerun(g3Run, 'captions', {})
  const g3CapStep = (await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, g3Captions.id)).limit(1))[0]!
  const g3CapOut = JSON.parse(g3CapStep.output ?? '{}') as { gate?: unknown }
  check(g3CapStep.status === 'pending' && g3CapOut.gate !== undefined, '非 compose 步重跑保留其 gate（本不变量仅约束合成步终审批）')
}
