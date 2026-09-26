/**
 * precision-rework 探针 · shot-duration 分节（切片2b：镜头时长本地返修·轻档）——自 probe-precision-rework 拆出：
 * m26 split-audit 红线单文件 ≤800 行。文件名不带 probe- 前缀：本模块是被主探针 import 的库，
 * 不是可独立执行的探针（run-probes 按 probe-*.ts 扫描）。
 * 隔离库 + 假时轴快照 + 模型桩：零网络、零付费、零供应商调用（src 模块经主探针 isolatedEnv 后动态加载）。
 * 覆盖规格 §8 八条核心断言：图镜自由拉长 / 音频镜 Σ-clamp+warn / motion 显式拒绝 / 有效段长 no_effect（含 clamp 落回原值）
 * / 空轴 fail closed / shot_durations 变更 stale + applied 后旧 gate 作废 / 幂等回放 / 冲突 + 非法 sec + 超 MAX clamp / 写侧真源 Q1 排除。
 */
import { createFixtureTools, type CheckFn } from './precision-rework-sections'

type DurDiff = { kind: string; field: string; before: unknown; after: unknown; willClampToSec?: number; warn?: boolean }
const diffOf = (pv: unknown, shotId: string): DurDiff | undefined =>
  ((pv as { preview?: { diffs?: DurDiff[] } }).preview?.diffs ?? []).find((d) => d.kind === 'shot-duration' && d.field === shotId)

export async function runShotDurationSection(check: CheckFn): Promise<void> {
  const tools = await createFixtureTools(98)
  const { db, pipelineRuns, pipelineSteps, assets, now, mkRun, mkFixture } = tools
  const { eq } = await import('drizzle-orm')
  const cap = await import('../src/services/rework/capability')
  const cip = await import('../src/services/rework/compose-input-preview')
  const ci = await import('../src/services/rework/compose-input')
  const apply = await import('../src/services/rework/compose-input-apply')
  const cc = await import('../src/services/compose-config')
  const engineMod = await import('../src/pipeline/engine')
  const started: number[] = []
  engineMod.engine.startRun = ((rid: number) => { started.push(rid); return 'started' }) as typeof engineMod.engine.startRun
  engineMod.engine.pumpGlobal = (async () => {}) as typeof engineMod.engine.pumpGlobal

  // 假时轴快照：shot-1 音频镜 Σ=5(=cur 5)、shot-1b 音频镜 Σ=5(cur 7)、shot-2 空镜 Σ=0(cur 4)、shot-3 motion 视频镜
  const AXIS: Array<Record<string, unknown>> = [
    { shotId: 'shot-1', assetId: 101, relPath: null, kind: 'image', durSec: 5, startSec: 0, lineIds: ['L1'], silenceSec: 0 },
    { shotId: 'shot-1b', assetId: 106, relPath: null, kind: 'image', durSec: 7, startSec: 5, lineIds: ['L1b'], silenceSec: 2 },
    { shotId: 'shot-2', assetId: 102, relPath: null, kind: 'image', durSec: 4, startSec: 12, lineIds: [], silenceSec: 4 },
    { shotId: 'shot-3', assetId: 103, relPath: null, kind: 'video', durSec: 9, startSec: 16, lineIds: ['L2'], silenceSec: 0 },
  ]
  const setSegs = async (finalId: number, segs: Array<Record<string, unknown>>): Promise<void> => {
    const row = (await db.select().from(assets).where(eq(assets.id, finalId)).limit(1))[0]!
    const params = JSON.parse(row.params ?? '{}') as { timeline?: Record<string, unknown> }
    if (!params.timeline) params.timeline = {}
    params.timeline.segments = segs
    await db.update(assets).set({ params: JSON.stringify(params), updatedAt: now }).where(eq(assets.id, finalId))
  }
  const setCompose = async (runId: number, cfg: Record<string, unknown>): Promise<void> => {
    const r = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1))[0]!
    const input = JSON.parse(r.input) as Record<string, unknown>
    input._compose = cfg
    await db.update(pipelineRuns).set({ input: JSON.stringify(input), updatedAt: now }).where(eq(pipelineRuns.id, runId))
  }
  const inputOf = async (runId: number): Promise<Record<string, unknown>> => JSON.parse((await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1))[0]!.input) as Record<string, unknown>

  /* 主基准 run（含 shotAxis） */
  const run = await mkRun('completed')
  const fix = await mkFixture(run)
  await setSegs(fix.finalId, AXIS)
  const ax = await cap.assessComposeInputCapability(run, 'compose')
  check(!!ax.baseline && ax.baseline.shotAxis.length === 4 && ax.baseline.shotAxis.some((s) => s.shotId === 'shot-3' && s.kind === 'video'), '基准 shotAxis 从 params.timeline.segments 只读派生（含 motion 视频镜 kind）')

  /* #1 图镜自由拉长（空镜 Σ=0 / 音频镜 >Σ）→ 就绪、无 clamp/warn */
  const p1 = await cip.buildComposeInputPreview({ runId: run, requestKey: 'sd-free', changes: [{ kind: 'shot-duration', shotId: 'shot-2', sec: 6 }] })
  check(p1.outcome === 'ready' && diffOf(p1, 'shot-2')?.after === 6 && diffOf(p1, 'shot-2')?.warn === undefined, '空镜覆盖拉长（Σ=0）→ 段长＝覆盖、无 clamp/warn')
  const p1b = await cip.buildComposeInputPreview({ runId: run, requestKey: 'sd-long', changes: [{ kind: 'shot-duration', shotId: 'shot-1b', sec: 8 }] })
  check(p1b.outcome === 'ready' && diffOf(p1b, 'shot-1b')?.warn === undefined && diffOf(p1b, 'shot-1b')?.willClampToSec === undefined, '音频镜覆盖长于 Σ → 段长＝覆盖（自由拉长），无 clamp')

  /* #2 音频镜覆盖短于 Σ → clamp 到 Σ、warn=true（shot-1b Σ=5 cur=7 → 有效落 5，真实变更故可预览） */
  const p2 = await cip.buildComposeInputPreview({ runId: run, requestKey: 'sd-clamp', changes: [{ kind: 'shot-duration', shotId: 'shot-1b', sec: 3 }] })
  check(p2.outcome === 'ready' && diffOf(p2, 'shot-1b')?.willClampToSec === 5 && diffOf(p2, 'shot-1b')?.warn === true, '音频镜覆盖短于 Σ → willClampToSec=Σ(5)、warn=true（不脱节、落回语音时长）')

  /* #3 motion 视频镜 / 不在轴 → fail-closed blocked（Q2 显式拒绝，不静默 no-op） */
  const p3 = await cip.buildComposeInputPreview({ runId: run, requestKey: 'sd-motion', changes: [{ kind: 'shot-duration', shotId: 'shot-3', sec: 3 }] })
  check(p3.outcome === 'blocked' && p3.code === 'unsupported_motion', 'motion 视频镜时长覆盖 → blocked unsupported_motion（轻档边界，显式拒绝）')
  const p3b = await cip.buildComposeInputPreview({ runId: run, requestKey: 'sd-badshot', changes: [{ kind: 'shot-duration', shotId: 'ghost', sec: 3 }] })
  check(p3b.outcome === 'blocked' && p3b.code === 'bad_shot', 'shotId 不在时轴段内 → blocked bad_shot（不猜）')

  /* #4 no_effect：含 clamp 落回原值（shot-1 Σ=5 cur=5 → 覆盖 3 有效仍 5 == cur，整体拒） */
  const p4 = await cip.buildComposeInputPreview({ runId: run, requestKey: 'sd-clampnoeff', changes: [{ kind: 'shot-duration', shotId: 'shot-1', sec: 3 }] })
  check(p4.outcome === 'blocked' && p4.code === 'no_effect', '覆盖短于 Σ 且有效段长落回当前值 → no_effect 整体拒（不产出无效重编码）')
  const runB = await mkRun('completed')
  const fixB = await mkFixture(runB)
  await setSegs(fixB.finalId, AXIS)
  await setCompose(runB, { shot_durations: { 'shot-2': 6 } })
  const p4b = await cip.buildComposeInputPreview({ runId: runB, requestKey: 'sd-same', changes: [{ kind: 'shot-duration', shotId: 'shot-2', sec: 6 }] })
  check(p4b.outcome === 'blocked' && p4b.code === 'no_effect', '覆盖值与既有 shot_durations 相同 → compile no_effect（幂等）')

  /* 空轴 fail closed：成片无时轴快照（segments 空）→ 不可判定 Σ → 拒绝 */
  const runE = await mkRun('completed')
  await mkFixture(runE)
  const pE = await cip.buildComposeInputPreview({ runId: runE, requestKey: 'sd-noaxis', changes: [{ kind: 'shot-duration', shotId: 'shot-1', sec: 3 }] })
  check(pE.outcome === 'blocked' && pE.code === 'no_timeline_axis', '成片无时轴快照 → 时长返修 fail closed no_timeline_axis')

  /* 预览零执行态写入：主 run 预览多次后仍 completed、无新资产、步不重置 */
  const runRowPv = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run)).limit(1))[0]!
  const stepPv = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, run))
  check(runRowPv.status === 'completed' && stepPv.every((s) => s.status === 'succeeded'), '时长预览纯读取：不改 run 状态、不重置步骤')

  /* #5/#6 apply：真实落 _compose.shot_durations、旧 gate 作废、幂等回放 */
  const apRun = await mkRun('completed')
  const apFix = await mkFixture(apRun)
  await setSegs(apFix.finalId, AXIS)
  await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [apFix.finalId], gate: { decision: 'approve', at: now } }) }).where(eq(pipelineSteps.id, apFix.composeId))
  const pvAp = await cip.buildComposeInputPreview({ runId: apRun, requestKey: 'ap-dur', changes: [{ kind: 'shot-duration', shotId: 'shot-2', sec: 6 }] })
  check(pvAp.outcome === 'ready', 'apply 前置：时长预览就绪')
  const apReqId = (pvAp as { requestId: string }).requestId
  const apHash = (pvAp as { preview: { previewHash: string } }).preview.previewHash
  const rAp = await apply.applyComposeInputRework({ requestId: apReqId, previewHash: apHash })
  const apRow = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, apRun)).limit(1))[0]!
  const apStep = (await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, apFix.composeId)).limit(1))[0]!
  check(rAp.outcome === 'applied' && rAp.result.enqueued === true && rAp.result.gateInvalidated === true && rAp.result.resetSteps.join() === 'compose', '时长返修确认 → applied 回执（仅重置合成步、旧 gate 作废）')
  check(rAp.outcome === 'applied' && rAp.result.durations.some((d) => d.shotId === 'shot-2' && d.fromSec === null && d.toSec === 6), 'applied 回执含 {shotId: 旧 null→新 6} 明细')
  const apDurations = ((await inputOf(apRun))['_compose'] as { shot_durations?: Record<string, number> } | undefined)?.shot_durations
  check(apRow.status === 'queued' && apDurations?.['shot-2'] === 6 && apStep.status === 'pending' && (JSON.parse(apStep.output ?? '{}') as { gate?: unknown }).gate === undefined, '确认后 run→queued、_compose.shot_durations 落真源、合成步 pending 且旧 gate 作废')
  check(started.length === 1 && started[0] === apRun, '事务提交后才启动引擎（一次）')
  const rApRe = await apply.applyComposeInputRework({ requestId: apReqId, previewHash: apHash })
  check(rApRe.outcome === 'replayed' && rAp.outcome === 'applied' && JSON.stringify(rApRe.result) === JSON.stringify(rAp.result) && started.length === 1, '#6 同 requestKey 二次确认回放首次回执、不二次入队')

  /* #5 stale：预览后旁路改配置使指纹漂移 → 确认期重验 stale_preview，run 不变 */
  const stRun = await mkRun('completed')
  const stFix = await mkFixture(stRun)
  await setSegs(stFix.finalId, AXIS)
  const pvSt = await cip.buildComposeInputPreview({ runId: stRun, requestKey: 'ap-st', changes: [{ kind: 'shot-duration', shotId: 'shot-2', sec: 7 }] })
  await setCompose(stRun, { bgm_volume: 0.5 })
  const rSt = await apply.applyComposeInputRework({ requestId: (pvSt as { requestId: string }).requestId, previewHash: (pvSt as { preview: { previewHash: string } }).preview.previewHash })
  const stRow = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, stRun)).limit(1))[0]!
  check(rSt.outcome === 'rejected' && rSt.code === 'stale_preview' && stRow.status === 'completed', '预览后旁路改配置使指纹漂移 → 确认期重验 stale_preview、run 不变')

  /* #7 纯语义（compile/parse）：冲突 / 非法 sec / 超 MAX clamp */
  const cur = { config: {}, bgmAssetId: null, sfxByShot: {}, selectedByShot: {} }
  const confDur = ci.compileComposeInputChanges({ changes: [{ kind: 'shot-duration', shotId: 's1', sec: 3 }, { kind: 'shot-duration', shotId: 's1', sec: 4 }] as never, current: cur as never })
  check(!confDur.ok && confDur.errors.some((e) => e.code === 'conflicting_changes'), '同 shotId 多条时长 → conflicting_changes 拒绝')
  const rejSec = (sec: unknown, msg: string): void => { check(!ci.parseComposeInputChanges([{ kind: 'shot-duration', shotId: 's1', sec }]).ok, msg) }
  rejSec(0, 'sec=0 拒绝'); rejSec(-3, 'sec<0 拒绝'); rejSec(Number.NaN, 'sec 非有限拒绝'); rejSec(Number.POSITIVE_INFINITY, 'sec=Infinity 拒绝')
  const clampMax = ci.compileComposeInputChanges({ changes: [{ kind: 'shot-duration', shotId: 's1', sec: 99999 }] as never, current: cur as never })
  check(clampMax.ok && clampMax.normalized.nextConfig?.shot_durations?.['s1'] === cc.SHOT_DURATION_MAX_SEC, '超 MAX 的 sec 经真源 clamp 到封顶（不重抄 magic number）')

  /* #8 写侧真源：updateComposeConfig 草稿直写排除 shot_durations（Q1）；normalize 真源与返修同源 clamp */
  const wRun = await mkRun('completed')
  let wErr = ''
  try { await cc.updateComposeConfig(wRun, { shot_durations: { s1: 5 } }) } catch (e) { wErr = (e as Error).message }
  check(wErr.includes('shot_durations') && wErr.includes('返修'), 'Q1：草稿直写 updateComposeConfig 排除 shot_durations（只经受控返修闸）')
  const norm = cc.normalizeComposeConfigPatch({}, { shot_durations: { s1: 99999, s2: 3 } })
  check(norm.shot_durations?.s1 === cc.SHOT_DURATION_MAX_SEC && norm.shot_durations?.s2 === 3, '写侧规范化与返修同源：超 MAX clamp 到封顶、合法值原样')
}
