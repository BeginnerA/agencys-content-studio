/**
 * 审片问题单与返修复检探针（审片问题单与返修复检）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m69.ts [--section=scope|diff|service|route]
 *
 * 隔离策略：isolatedEnv('m69') 一次性临时目录（独立 studio.db + workspace），
 * 必须先于任何 src 动态 import。零网络零付费。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup } = isolatedEnv('m69')

// 只声明本任务已实现的分节；后续任务各自追加一节（未注册 runner 的分节会让 probe:ci 中途失败）
const SECTIONS = ['scope', 'diff', 'service', 'route'] as const

const { createLogger } = await import('../src/logger')
const log = createLogger('probe-m69')
const checker: Checker = makeChecker(log)
const check = checker.check

await runSections({
  log, title: 'M69', checker, cleanup, sections: SECTIONS,
  registry: async () => {
    const { initDb } = await import('../src/db')
    await initDb()
    check(true, '初始化隔离库完成')
  },
  runners: {
    scope: async () => {
      const { parseFinalTimeline, locateAt, shotRange, validateTimeRange, categoryAllowsScope } =
        await import('../src/services/review/scope')

      // 片头 1s + S1 2s + S2 3s = total 6s
      const tl = parseFinalTimeline(JSON.stringify({
        timeline: {
          v: 1, totalSec: 6, introSec: 1, outroSec: 0,
          segments: [
            { shotId: 'S1', assetId: 11, kind: 'video', durSec: 2, startSec: 0, lineIds: [], silenceSec: 0 },
            { shotId: 'S2', assetId: 12, kind: 'video', durSec: 3, startSec: 2, lineIds: [], silenceSec: 0 },
          ],
          subtitle: {
            coordinate: 'final',
            cues: [
              { id: 'c1', startMs: 1000, endMs: 2000, text: '第一句' },
              { id: 'c2', startMs: 3000, endMs: 4500, text: '第二句' },
            ],
          },
        },
      }))
      check(!!tl, '解析 params.timeline')
      check(tl!.totalMs === 6000 && tl!.introMs === 1000, 'totalMs/introMs 换算')
      check(tl!.segments[0]!.startMs === 1000 && tl!.segments[0]!.endMs === 3000, '内容轴 → 绝对轴（+片头）')
      check(tl!.segments[1]!.startMs === 3000 && tl!.segments[1]!.endMs === 6000, '第二段绝对区间')
      check(tl!.cues[0]!.startMs === 1000, 'cues 已为最终轴，不再位移')

      check(locateAt(tl!, 500).kind === 'intro', '0.5s 落在片头')
      check(locateAt(tl!, 1000).kind === 'shot' && locateAt(tl!, 1000).shotId === 'S1', '1.0s 为 S1 起点（含）')
      check(locateAt(tl!, 2999).shotId === 'S1', '2.999s 仍为 S1')
      check(locateAt(tl!, 3000).shotId === 'S2', '3.0s 边界取后一段 S2')
      check(locateAt(tl!, 5999).shotId === 'S2', '5.999s 仍为 S2')
      check(locateAt(tl!, 6000).kind === 'outside', '6.0s 末尾为 outside（半开区间）')
      check(locateAt(tl!, -1).kind === 'outside', '负值为 outside')

      check(shotRange(tl!, 'S2')!.startMs === 3000, 'shotRange 命中')
      check(shotRange(tl!, 'S9') === null, 'shotRange 未命中返回 null')

      check(validateTimeRange(tl!, 1000, 2000, null).ok, '合法时间窗')
      check(!validateTimeRange(tl!, 2000, 2000, null).ok, '空窗拒绝')
      check(!validateTimeRange(tl!, -1, 2000, null).ok, '负起点拒绝')
      check(!validateTimeRange(tl!, 5000, 7000, null).ok, '超出 totalMs 拒绝')

      // totalSec 缺失 → intro + Σdur + outro 推导
      const noTotal = parseFinalTimeline(JSON.stringify({
        timeline: { introSec: 1, outroSec: 2, segments: [{ shotId: 'A', assetId: 1, durSec: 4, startSec: 0 }] },
      }))
      check(noTotal?.totalMs === 7000, 'totalSec 缺失时由 intro+Σdur+outro 推导')
      // 无 totalSec 且无 segments → null
      check(parseFinalTimeline(JSON.stringify({ timeline: { introSec: 1 } })) === null, '无时间轴证据返回 null')
      check(parseFinalTimeline('not-json') === null, '损坏 JSON 返回 null')
      check(parseFinalTimeline(JSON.stringify({ timeline: { totalSec: 3, segments: [] } }))!.totalMs === 3000, '空段但 totalSec 有效')

      // 时间窗上限回退（资产 duration 秒 → 毫秒）
      check(validateTimeRange(null, 0, 3000, 3000).ok, '无 timeline 时用资产时长兜底')
      check(!validateTimeRange(null, 0, 3001, 3000).ok, '兜底上限同样生效')

      // 4.4 矩阵
      for (const c of ['visual', 'prop', 'subtitle', 'audio'] as const) {
        check(categoryAllowsScope(c, 'shot') && categoryAllowsScope(c, 'time') && categoryAllowsScope(c, 'global'), `${c} 允许三种范围`)
      }
      check(categoryAllowsScope('lip_sync', 'shot') && !categoryAllowsScope('lip_sync', 'time') && !categoryAllowsScope('lip_sync', 'global'), 'lip_sync 仅 shot')
      check(!categoryAllowsScope('pacing', 'shot') && categoryAllowsScope('pacing', 'time') && categoryAllowsScope('pacing', 'global'), 'pacing 仅 time/global')
      check(categoryAllowsScope('other', 'global'), 'other 任意范围')
    },
    diff: async () => {
      const { parseFinalTimeline } = await import('../src/services/review/scope')
      const { buildBaseSnapshot, parseBaseSnapshot, parseTimelineAudio } = await import('../src/services/review/snapshot')
      const { recheckScope } = await import('../src/services/review/recheck')

      const mkTl = (o: {
        s1Asset?: number; s2Asset?: number; s3Asset?: number; s1Sha?: string; s2Sha?: string
        extraSeg?: boolean
        totalSec?: number; cues?: Array<{ id: string; startMs: number; endMs: number; text: string }>
        bgm?: { assetId: number; volume: number; fadeSec: number } | null
        sfx?: Array<{ shotId: string; assetId: number }>
      }) => {
        const segments = [
          { shotId: 'S1', assetId: o.s1Asset ?? 11, kind: 'video', durSec: 2, startSec: 0 },
          { shotId: 'S2', assetId: o.s2Asset ?? 12, kind: 'video', durSec: 3, startSec: 2 },
        ]
        // 第三段落在 1000–4000ms 窗口内（内容轴 1s + 片头 1s = 绝对 2000–3000ms）
        if (o.extraSeg) segments.push({ shotId: 'S3', assetId: o.s3Asset ?? 13, kind: 'video', durSec: 1, startSec: 1 })
        const tl = {
          v: 1, totalSec: o.totalSec ?? 6, introSec: 1, outroSec: 0,
          segments,
          subtitle: { coordinate: 'final', cues: o.cues ?? [{ id: 'c1', startMs: 1000, endMs: 2000, text: '第一句' }, { id: 'c2', startMs: 3000, endMs: 4500, text: '第二句' }] },
          bgm: o.bgm === undefined ? { assetId: 9, relPath: 'b.mp3', volume: 0.6, fadeSec: 1.5 } : o.bgm,
          sfx: (o.sfx ?? [{ shotId: 'S1', assetId: 77 }]).map((s) => ({ ...s, startSec: 1, relPath: 's.mp3' })),
        }
        return parseFinalTimeline(JSON.stringify({ timeline: tl }))!
      }
      const shaMap = new Map<number, string | null>([[11, 'sha11'], [12, 'sha12'], [13, 'sha13'], [9, 'sha9'], [77, 'sha77'], [78, 'sha78']])
      const assetSha = (id: number | null): string | null => (id === null ? null : shaMap.get(id) ?? null)

      // —— 快照：shot 范围只存该镜 + 相交 cues + 该镜 SFX + BGM ——
      const tl = mkTl({})
      const snap = buildBaseSnapshot({
        stepKey: 'compose', finalAssetId: 100, finalSha256: 'sha100', timeline: tl,
        scope: { kind: 'shot', shotId: 'S2' }, audio: parseTimelineAudio(JSON.stringify({
          timeline: { bgm: { assetId: 9, volume: 0.6, fadeSec: 1.5 }, sfx: [{ shotId: 'S1', assetId: 77, startSec: 1, relPath: 's.mp3' }] },
        })), assetSha,
      })
      check(snap.v === 1 && snap.finalAssetId === 100, '快照头')
      check(snap.shot?.shotId === 'S2' && snap.shot!.startMs === 3000 && snap.shot!.durMs === 3000, 'shot 范围存该镜绝对区间')
      check(snap.segments.length === 1 && snap.segments[0]!.shotId === 'S2', 'shot 范围只存该镜段')
      check(snap.cues.length === 1 && snap.cues[0]!.id === 'c2', 'shot 范围只存相交 cues')
      check(snap.audio?.bgm?.assetId === 9 && snap.audio!.bgm!.sha256 === 'sha9', 'BGM 取 timeline 实际值并补 sha')
      check(snap.audio?.sfx.length === 0, 'shot 范围只存该镜 SFX（S1 的不入）')

      // —— time 范围窗口 + 截断摘要 ——
      const timeSnap = buildBaseSnapshot({
        stepKey: 'compose', finalAssetId: 100, finalSha256: 'sha100', timeline: tl,
        scope: { kind: 'time', startMs: 2500, endMs: 5000 }, audio: null, assetSha,
      })
      check(timeSnap.segments.length === 2, 'time 窗与两段都相交')
      check(timeSnap.cues.length === 1 && timeSnap.cues[0]!.id === 'c2', 'time 窗只存相交 cue')
      const manyCues = Array.from({ length: 60 }, (_, i) => ({ id: `x${i}`, startMs: 1000 + i * 10, endMs: 1005 + i * 10, text: `t${i}` }))
      const trunc = buildBaseSnapshot({
        stepKey: 'compose', finalAssetId: 100, finalSha256: null, timeline: mkTl({ cues: manyCues }),
        scope: { kind: 'global' }, audio: null, assetSha,
      })
      check(trunc.cues.length === 50 && trunc.cuesTruncated && trunc.cuesCount === 60, 'cues 上限 50 + 摘要计数')
      check(typeof trunc.cuesDigest === 'string' && trunc.cuesDigest!.length === 64, '截断仍有摘要')

      // —— 媒体复检：换片 / 同片 / 缺 sha ——
      const base = buildBaseSnapshot({
        stepKey: 'compose', finalAssetId: 100, finalSha256: 'sha100', timeline: tl,
        scope: { kind: 'shot', shotId: 'S2' }, audio: parseTimelineAudio(null), assetSha,
      })
      const rSame = recheckScope({ category: 'visual', scopeKind: 'shot', shotId: 'S2', startMs: 3000, endMs: 6000, snapshot: base, timeline: mkTl({}), audio: null, assetSha })
      check(rSame.state === 'unchanged', '镜头媒体未变 → unchanged')
      const rChanged = recheckScope({ category: 'prop', scopeKind: 'shot', shotId: 'S2', startMs: 3000, endMs: 6000, snapshot: base, timeline: mkTl({ s2Asset: 22 }), audio: null, assetSha })
      check(rChanged.state === 'changed' && rChanged.note.includes('#22'), '镜头换媒体 → changed 且带新 asset')
      const rMissing = recheckScope({ category: 'lip_sync', scopeKind: 'shot', shotId: 'S9', startMs: null, endMs: null, snapshot: base, timeline: mkTl({}), audio: null, assetSha })
      check(rMissing.state === 'unverifiable', '镜头已不在新成片 → unverifiable')
      const tlNoSha = mkTl({})
      const rNoSha = recheckScope({ category: 'visual', scopeKind: 'shot', shotId: 'S2', startMs: 3000, endMs: 6000, snapshot: base, timeline: tlNoSha, audio: null, assetSha: () => null })
      check(rNoSha.state === 'unchanged' && rNoSha.note.includes('sha'), 'sha 不可用时只比 assetId 并注明')
      // 成片变短 → 原时间窗越界 → unverifiable（不做时间重映射）
      const rOut = recheckScope({ category: 'visual', scopeKind: 'time', shotId: null, startMs: 2500, endMs: 5000, snapshot: timeSnap, timeline: mkTl({ totalSec: 3 }), audio: null, assetSha })
      check(rOut.state === 'unverifiable', '成片变短、时间窗越界 → unverifiable')

      // —— time 范围媒体逐段比较（核心循环） ——
      const winSnap = buildBaseSnapshot({
        stepKey: 'compose', finalAssetId: 100, finalSha256: 'sha100', timeline: tl,
        scope: { kind: 'time', startMs: 1000, endMs: 4000 }, audio: null, assetSha,
      })
      check(winSnap.segments.length === 2, 'time 窗 1000–4000 跨 S1/S2 两段')
      const wSame = recheckScope({ category: 'visual', scopeKind: 'time', shotId: null, startMs: 1000, endMs: 4000, snapshot: winSnap, timeline: mkTl({}), audio: null, assetSha })
      check(wSame.state === 'unchanged', '时间窗内两段媒体未变 → unchanged')
      const wChanged = recheckScope({ category: 'visual', scopeKind: 'time', shotId: null, startMs: 1000, endMs: 4000, snapshot: winSnap, timeline: mkTl({ s2Asset: 22 }), audio: null, assetSha })
      check(wChanged.state === 'changed' && wChanged.note.includes('S2') && wChanged.note.includes('22'), '时间窗内 S2 换媒体 → changed 且带段名与 #22')
      const wExtra = recheckScope({ category: 'visual', scopeKind: 'time', shotId: null, startMs: 1000, endMs: 4000, snapshot: winSnap, timeline: mkTl({ extraSeg: true }), audio: null, assetSha })
      check(wExtra.state === 'changed' && wExtra.note.includes('新增'), '时间窗内新增镜头段 → changed 且注明新增')
      const winTruncSnap = buildBaseSnapshot({
        stepKey: 'compose', finalAssetId: 100, finalSha256: 'sha100', timeline: tl,
        scope: { kind: 'time', startMs: 1000, endMs: 4000 }, audio: null, assetSha, limits: { segments: 1 },
      })
      check(winTruncSnap.segments.length === 1 && winTruncSnap.segmentsTruncated, 'segments 上限 1 → 只存首段并标记截断')
      const wTrunc = recheckScope({ category: 'visual', scopeKind: 'time', shotId: null, startMs: 1000, endMs: 4000, snapshot: winTruncSnap, timeline: mkTl({}), audio: null, assetSha })
      check(wTrunc.state === 'unchanged' && wTrunc.note.includes('仅比较已存段'), '截断快照复检 → note 注明仅比较已存段')
      const gSnap = buildBaseSnapshot({
        stepKey: 'compose', finalAssetId: 100, finalSha256: 'sha100', timeline: tl,
        scope: { kind: 'global' }, audio: null, assetSha,
      })
      check(recheckScope({ category: 'visual', scopeKind: 'global', shotId: null, startMs: null, endMs: null, snapshot: gSnap, timeline: mkTl({}), audio: null, assetSha }).state === 'unchanged', 'global 范围媒体未变 → unchanged')
      const gChanged = recheckScope({ category: 'visual', scopeKind: 'global', shotId: null, startMs: null, endMs: null, snapshot: gSnap, timeline: mkTl({ s2Asset: 22 }), audio: null, assetSha })
      check(gChanged.state === 'changed', 'global 范围媒体变化 → changed')

      // —— 字幕复检 ——
      const subBase = buildBaseSnapshot({ stepKey: 'compose', finalAssetId: 100, finalSha256: null, timeline: tl, scope: { kind: 'global' }, audio: null, assetSha })
      const subSame = recheckScope({ category: 'subtitle', scopeKind: 'global', shotId: null, startMs: null, endMs: null, snapshot: subBase, timeline: mkTl({}), audio: null, assetSha })
      check(subSame.state === 'unchanged', '字幕未改 → unchanged')
      const subChanged = recheckScope({ category: 'subtitle', scopeKind: 'global', shotId: null, startMs: null, endMs: null, snapshot: subBase, timeline: mkTl({ cues: [{ id: 'c1', startMs: 1000, endMs: 2000, text: '改过' }] }), audio: null, assetSha })
      check(subChanged.state === 'changed', '字幕文本/增删 → changed')
      const subNone = recheckScope({ category: 'subtitle', scopeKind: 'global', shotId: null, startMs: null, endMs: null, snapshot: subBase, timeline: mkTl({ cues: [] }), audio: null, assetSha })
      check(subNone.state === 'changed', '一侧无字幕 → changed')
      const subTrunc = recheckScope({ category: 'subtitle', scopeKind: 'global', shotId: null, startMs: null, endMs: null, snapshot: trunc, timeline: mkTl({ cues: manyCues }), audio: null, assetSha })
      check(subTrunc.state === 'unchanged' && subTrunc.note.includes('摘要'), '截断快照走摘要级比较')

      // —— 音频复检（读 timeline.bgm/sfx，不读 _compose） ——
      const audioBase = buildBaseSnapshot({ stepKey: 'compose', finalAssetId: 100, finalSha256: null, timeline: tl, scope: { kind: 'global' }, audio: parseTimelineAudio(JSON.stringify({ timeline: { bgm: { assetId: 9, volume: 0.6, fadeSec: 1.5 }, sfx: [{ shotId: 'S1', assetId: 77, startSec: 1, relPath: 's.mp3' }] } })), assetSha })
      const aSame = recheckScope({ category: 'audio', scopeKind: 'global', shotId: null, startMs: null, endMs: null, snapshot: audioBase, timeline: tl, audio: parseTimelineAudio(JSON.stringify({ timeline: { bgm: { assetId: 9, volume: 0.6, fadeSec: 1.5 }, sfx: [{ shotId: 'S1', assetId: 77 }] } })), assetSha })
      check(aSame.state === 'unchanged', 'BGM/SFX 未改 → unchanged')
      const aChanged = recheckScope({ category: 'audio', scopeKind: 'global', shotId: null, startMs: null, endMs: null, snapshot: audioBase, timeline: tl, audio: parseTimelineAudio(JSON.stringify({ timeline: { bgm: { assetId: 9, volume: 0.8, fadeSec: 1.5 }, sfx: [{ shotId: 'S1', assetId: 77 }] } })), assetSha })
      check(aChanged.state === 'changed', 'BGM 音量变化 → changed')
      const aShot = recheckScope({ category: 'audio', scopeKind: 'shot', shotId: 'S2', startMs: 3000, endMs: 6000, snapshot: audioBase, timeline: tl, audio: parseTimelineAudio(JSON.stringify({ timeline: { bgm: { assetId: 9, volume: 0.6, fadeSec: 1.5 }, sfx: [{ shotId: 'S1', assetId: 78 }] } })), assetSha })
      check(aShot.state === 'unchanged', 'shot 范围忽略他镜 SFX（同 BGM）')

      // —— 节奏 / 其他 / 无 timeline ——
      const paceBase = buildBaseSnapshot({ stepKey: 'compose', finalAssetId: 100, finalSha256: null, timeline: tl, scope: { kind: 'global' }, audio: null, assetSha })
      check(recheckScope({ category: 'pacing', scopeKind: 'global', shotId: null, startMs: null, endMs: null, snapshot: paceBase, timeline: mkTl({}), audio: null, assetSha }).state === 'unchanged', '总长/段长未变 → unchanged')
      check(recheckScope({ category: 'pacing', scopeKind: 'global', shotId: null, startMs: null, endMs: null, snapshot: paceBase, timeline: mkTl({ totalSec: 7 }), audio: null, assetSha }).state === 'changed', '总长变化 → changed')
      check(recheckScope({ category: 'other', scopeKind: 'global', shotId: null, startMs: null, endMs: null, snapshot: paceBase, timeline: tl, audio: null, assetSha }).state === 'unverifiable', 'other 恒 unverifiable')
      check(recheckScope({ category: 'visual', scopeKind: 'global', shotId: null, startMs: null, endMs: null, snapshot: paceBase, timeline: null, audio: null, assetSha }).state === 'unverifiable', 'timeline 缺失 → unverifiable')

      // —— 无 timeline 基准：不得拿 0 基准当 changed ——
      const noTlSnap = buildBaseSnapshot({ stepKey: 'compose', finalAssetId: 100, finalSha256: null, timeline: null, scope: { kind: 'global' }, audio: null, assetSha })
      check(noTlSnap.hasTimeline === false && noTlSnap.totalMs === 0 && noTlSnap.cues.length === 0, '无 timeline 快照标记 hasTimeline=false（0ms/0 cue 仅为占位）')
      const noTlPace = recheckScope({ category: 'pacing', scopeKind: 'global', shotId: null, startMs: null, endMs: null, snapshot: noTlSnap, timeline: mkTl({}), audio: null, assetSha })
      check(noTlPace.state === 'unverifiable', '无时间轴基准的 pacing 复检 → unverifiable')
      const noTlSub = recheckScope({ category: 'subtitle', scopeKind: 'global', shotId: null, startMs: null, endMs: null, snapshot: noTlSnap, timeline: mkTl({}), audio: null, assetSha })
      check(noTlSub.state === 'unverifiable', '无时间轴基准的 subtitle 复检 → unverifiable')

      // —— 快照读回 ——
      const back = parseBaseSnapshot(JSON.stringify(snap))
      check(
        back !== null && back.hasTimeline === true && back.finalAssetId === 100 && back.finalSha256 === 'sha100'
          && back.totalMs === 6000 && back.shot?.shotId === 'S2' && back.segments.length === 1
          && back.cues.length === 1 && back.cues[0]!.id === 'c2' && back.audio?.bgm?.assetId === 9,
        '快照读回：hasTimeline=true 且关键字段一致',
      )
      check(parseBaseSnapshot(JSON.stringify(noTlSnap))?.hasTimeline === false, '读回无时间轴快照仍为 hasTimeline=false')
      check(parseBaseSnapshot('bad-json') === null, '损坏快照 JSON → null')
    },
    service: async () => {
      const { db } = await import('../src/db')
      const { projects, pipelineRuns, pipelineSteps, reworkRequests, assets } = await import('../src/db/schema')
      const { registerAsset } = await import('../src/services/storage')
      const svc = await import('../src/services/review/service')
      const { eq } = await import('drizzle-orm')

      const now = Date.now()
      let seq = 0
      const mkTimeline = (o: { totalSec?: number; introSec?: number; s1Asset: number; s2Asset: number; cues?: any[] }) => ({
        v: 1, totalSec: o.totalSec ?? 6, introSec: o.introSec ?? 1, outroSec: 0,
        segments: [
          { shotId: 'S1', assetId: o.s1Asset, kind: 'video', durSec: 2, startSec: 0, lineIds: [], silenceSec: 0 },
          { shotId: 'S2', assetId: o.s2Asset, kind: 'video', durSec: 3, startSec: 2, lineIds: [], silenceSec: 0 },
        ],
        subtitle: { coordinate: 'final', cues: o.cues ?? [{ id: 'c1', startMs: 1000, endMs: 2000, text: '第一句' }] },
        bgm: { assetId: 9, relPath: 'b.mp3', volume: 0.6, fadeSec: 1.5 },
        sfx: [],
      })
      const seed = async (o: { status?: string; timeline?: unknown | null; durationSec?: number; stepKey?: string; withFinal?: boolean }) => {
        seq += 1
        const projectId = (await db.insert(projects).values({ name: `M69-${seq}`, createdAt: now, updatedAt: now }).returning())[0]!.id
        const runId = (await db.insert(pipelineRuns).values({
          projectId, templateKey: 'probe-m69', status: o.status ?? 'completed',
          input: '{}', createdAt: now, updatedAt: now,
        }).returning())[0]!.id
        const s1 = await registerAsset(projectId, { name: `s1-${seq}`, kind: 'video', purpose: 'shot_video', relPath: `p/s1-${seq}.mp4`, sha256: `s1sha${seq}`, runId, duration: 2 })
        const s2 = await registerAsset(projectId, { name: `s2-${seq}`, kind: 'video', purpose: 'shot_video', relPath: `p/s2-${seq}.mp4`, sha256: `s2sha${seq}`, runId, duration: 3 })
        const stepKey = o.stepKey ?? 'compose'
        const step = (await db.insert(pipelineSteps).values({
          runId, seq: 1, stepKey, actionKey: 'ffmpeg_merge', title: '合成', status: 'completed',
          input: '{}', output: '{}', createdAt: now, updatedAt: now,
        }).returning())[0]!
        let finalId = 0
        if (o.withFinal !== false) {
          const tl = o.timeline === null ? null : o.timeline ?? mkTimeline({ s1Asset: s1.id, s2Asset: s2.id })
          const final = await registerAsset(projectId, {
            name: `final-${seq}`, kind: 'video', purpose: 'final_video', relPath: `p/final-${seq}.mp4`,
            sha256: `finalsha${seq}`, runId, duration: o.durationSec ?? 6, stepId: step.id,
            params: tl ? { timeline: tl } : {},
          })
          finalId = final.id
          await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [final.id] }) }).where(eq(pipelineSteps.id, step.id))
        }
        return { projectId, runId, step, finalId, s1, s2 }
      }
      const mkFinding = async (runId: number, body: Record<string, unknown>) => (await svc.createReviewFinding(runId, body)).finding
      const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
        try { await fn(); return '' } catch (e) { return e instanceof svc.ReviewError ? e.code : `other:${(e as Error).message}` }
      }

      // —— 创建矩阵 ——
      const a = await seed({})
      const fTime = await mkFinding(a.runId, { category: 'visual', severity: 'major', note: 'S2 纸袋消失', scope: { kind: 'time', start_ms: 2500, end_ms: 5000 } })
      check(fTime.status === 'open' && fTime.scopeKind === 'time' && fTime.startMs === 2500, 'visual+time 创建成功')
      check(fTime.baseAvailable === true, '基准成片可见 → baseAvailable')
      check(fTime.can.recheck === false && fTime.can.verify === false, 'can 投影：刚创建成片未变，不可复检/终判')
      const fShot = await mkFinding(a.runId, { category: 'prop', severity: 'blocker', note: 'S2 道具穿帮', scope: { kind: 'shot', shot_id: 'S2' } })
      check(fShot.shotId === 'S2' && fShot.startMs === 3000 && fShot.endMs === 6000, 'shot 范围服务端反查绝对区间')
      check((await codeOf(() => mkFinding(a.runId, { category: 'lip_sync', severity: 'major', note: 'x', scope: { kind: 'global' } }))) === 'scope_category_mismatch', 'lip_sync+global 拒绝')
      check((await codeOf(() => mkFinding(a.runId, { category: 'visual', severity: 'major', note: 'x', scope: { kind: 'shot', shot_id: 'S9' } }))) === 'bad_scope', '未知镜头拒绝')
      check((await codeOf(() => mkFinding(a.runId, { category: 'visual', severity: 'major', note: 'x', scope: { kind: 'time', start_ms: 0, end_ms: 9000 } }))) === 'bad_scope', '越界时间窗拒绝')
      check((await codeOf(() => mkFinding(a.runId, { category: 'visual', severity: 'major', note: '   ', scope: { kind: 'global' } }))) === 'note_required', '空 note 拒绝')
      check((await codeOf(() => mkFinding(a.runId, { category: 'visual', severity: 'huge', note: 'x', scope: { kind: 'global' } }))) === 'bad_severity', '非法 severity 拒绝')
      check((await codeOf(() => mkFinding(a.runId, { step_key: 123, category: 'visual', severity: 'major', note: 'x', scope: { kind: 'global' } }))) === 'bad_scope', 'step_key 非字符串拒绝 bad_scope')
      check((await codeOf(() => mkFinding(a.runId, { step_key: '', category: 'visual', severity: 'major', note: 'x', scope: { kind: 'global' } }))) === 'bad_scope', 'step_key 空串拒绝 bad_scope')
      check((await codeOf(() => mkFinding(a.runId, { client_key: 123, category: 'visual', severity: 'major', note: 'x', scope: { kind: 'global' } }))) === 'bad_scope', 'client_key 非字符串拒绝 bad_scope')
      const fNullStep = await mkFinding(a.runId, { step_key: null, category: 'visual', severity: 'minor', note: 'null 视为未提供', scope: { kind: 'global' } })
      check(fNullStep.stepKey === 'compose', 'step_key: null 回落默认 compose')

      // capability：完成且有 timeline → ok 可写；summary 统计与 blockers_open
      const aList = await svc.listReviewFindings(a.runId, 'compose')
      check(aList.capability.code === 'ok' && aList.capability.writable === true && aList.capability.has_timeline === true, 'capability：完成且有时间轴 → ok/可写/有时间轴')
      check(aList.summary.total === aList.findings.length && aList.summary.blockers_open >= 1, 'summary：total 等于条数且 blocker 未关闭计数 ≥1')

      const noTl = await seed({ timeline: null })
      check((await codeOf(() => mkFinding(noTl.runId, { category: 'visual', severity: 'major', note: 'x', scope: { kind: 'shot', shot_id: 'S1' } }))) === 'no_timeline', '无 timeline 时 shot 拒绝 no_timeline')
      const fGlobalNoTl = await mkFinding(noTl.runId, { category: 'visual', severity: 'minor', note: '整体偏暗', scope: { kind: 'global' } })
      check(fGlobalNoTl.id > 0, '无 timeline 仍可建全片问题')
      const noTlList = await svc.listReviewFindings(noTl.runId, 'compose')
      check(noTlList.capability.code === 'degraded_no_timeline' && noTlList.capability.writable === true && noTlList.capability.has_timeline === false, 'capability：无 timeline → degraded_no_timeline 仍可写')

      const running = await seed({ status: 'running' })
      check((await codeOf(() => mkFinding(running.runId, { category: 'visual', severity: 'major', note: 'x', scope: { kind: 'global' } }))) === 'run_active', 'run 执行中拒绝创建')
      const cancelled = await seed({ status: 'cancelled' })
      check((await codeOf(() => mkFinding(cancelled.runId, { category: 'visual', severity: 'major', note: 'x', scope: { kind: 'global' } }))) === 'run_cancelled', 'cancelled 拒绝创建')
      const noFinal = await seed({ withFinal: false })
      check((await codeOf(() => mkFinding(noFinal.runId, { category: 'visual', severity: 'major', note: 'x', scope: { kind: 'global' } }))) === 'no_final', '无成片拒绝创建')
      const noFinalList = await svc.listReviewFindings(noFinal.runId, 'compose')
      check(noFinalList.capability.code === 'no_final' && noFinalList.capability.writable === false && noFinalList.final === null, 'capability：无成片 → no_final、final=null、不可写')

      // capability 优先级：cancelled / running 均先于 no_final
      const cancelledList = await svc.listReviewFindings(cancelled.runId, 'compose')
      check(cancelledList.capability.code === 'run_cancelled' && cancelledList.capability.writable === false, 'capability：cancelled（有 final）→ run_cancelled 且不可写')
      const cancelledNoFinal = await seed({ status: 'cancelled', withFinal: false })
      const cancelledNoFinalList = await svc.listReviewFindings(cancelledNoFinal.runId, 'compose')
      check(
        cancelledNoFinalList.final === null && cancelledNoFinalList.capability.code === 'run_cancelled' && cancelledNoFinalList.capability.writable === false,
        'capability：cancelled 且无 final → run_cancelled（run_cancelled > no_final）',
      )
      const runningNoFinal = await seed({ status: 'running', withFinal: false })
      const runningNoFinalList = await svc.listReviewFindings(runningNoFinal.runId, 'compose')
      check(
        runningNoFinalList.final === null && runningNoFinalList.capability.code === 'run_active' && runningNoFinalList.capability.writable === false,
        'capability：running 且无 final → run_active（run_active > no_final）',
      )

      // summary.blockers_open：只计仍未关闭的 blocker（verified / dismissed 均排除）
      const blk = await seed({})
      await mkFinding(blk.runId, { category: 'prop', severity: 'blocker', note: '仍未解决', scope: { kind: 'global' } })
      const bVerified = await mkFinding(blk.runId, { category: 'prop', severity: 'blocker', note: '已修好', scope: { kind: 'global' } })
      const bDismissed = await mkFinding(blk.runId, { category: 'prop', severity: 'blocker', note: '不修了', scope: { kind: 'global' } })
      await svc.markReworkFinding(blk.runId, bVerified.id, {})
      const blkFinal = await registerAsset(blk.projectId, {
        name: `final-blk-${seq}`, kind: 'video', purpose: 'final_video', relPath: `p/final-blk-${seq}.mp4`,
        sha256: `blksha${seq}`, runId: blk.runId, duration: 6, stepId: blk.step.id,
        params: { timeline: mkTimeline({ s1Asset: blk.s1.id, s2Asset: blk.s2.id }) },
      })
      await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [blkFinal.id] }) }).where(eq(pipelineSteps.id, blk.step.id))
      await svc.recheckFinding(blk.runId, bVerified.id)
      await svc.verifyFinding(blk.runId, bVerified.id, { result: 'verified', final_asset_id: blkFinal.id })
      await svc.dismissFinding(blk.runId, bDismissed.id, { note: '可接受' })
      const blkList = await svc.listReviewFindings(blk.runId, 'compose')
      check(
        blkList.summary.total === 3 && blkList.summary.open === 1 && blkList.summary.verified === 1
          && blkList.summary.dismissed === 1 && blkList.summary.blockers_open === 1,
        'summary：三个 blocker（1 open / 1 verified / 1 dismissed）→ blockers_open 只计 1',
      )

      // waiting_input 不在执行中集合 → 按可审处理
      const waiting = await seed({ status: 'waiting_input' })
      const waitingList = await svc.listReviewFindings(waiting.runId, 'compose')
      check(waitingList.capability.code === 'ok' && waitingList.capability.writable === true, 'capability：waiting_input → ok 可写')
      const fWaiting = await mkFinding(waiting.runId, { category: 'visual', severity: 'minor', note: '等待输入可建单', scope: { kind: 'global' } })
      check(fWaiting.status === 'open', 'waiting_input 可新建问题单')

      // —— client_key 幂等 ——
      const body = { client_key: 'k1', category: 'visual', severity: 'major', note: '同一问题', scope: { kind: 'global' } }
      const c1 = await svc.createReviewFinding(a.runId, body)
      const c2 = await svc.createReviewFinding(a.runId, body)
      check(c1.replayed === false && c2.replayed === true && c1.finding.id === c2.finding.id, '同键同载荷回放')
      check((await codeOf(() => svc.createReviewFinding(a.runId, { ...body, note: '不同载荷' }))) === 'client_key_conflict', '同键异载荷 409')

      // —— 状态机 ——
      const req = await db.insert(reworkRequests).values({
        id: `req-${seq}`, projectId: a.projectId, runId: a.runId, stepKey: 'compose', requestKey: `rk-${seq}`,
        requestHash: 'h', state: 'applied', createdAt: now, updatedAt: now,
      }).returning()
      const linked = await svc.linkFinding(a.runId, fTime.id, { request_id: req[0]!.id })
      check(linked.status === 'in_rework' && linked.reworkRequestId === req[0]!.id, 'link applied 请求 → in_rework')
      check(linked.can.recheck === false, '成片未变时 recheck 不可用')
      check((await codeOf(() => svc.linkFinding(a.runId, fShot.id, { request_id: 'nope' }))) === 'request_not_found', 'link 不存在请求')
      const otherRun = await seed({})
      const reqOther = await db.insert(reworkRequests).values({
        id: `req-o-${seq}`, projectId: otherRun.projectId, runId: otherRun.runId, stepKey: 'compose', requestKey: 'rk-o',
        requestHash: 'h', state: 'applied', createdAt: now, updatedAt: now,
      }).returning()
      check((await codeOf(() => svc.linkFinding(a.runId, fShot.id, { request_id: reqOther[0]!.id }))) === 'request_run_mismatch', '跨 run 请求拒绝')
      const pendingReq = await db.insert(reworkRequests).values({
        id: `req-p-${seq}`, projectId: a.projectId, runId: a.runId, stepKey: 'compose', requestKey: 'rk-p',
        requestHash: 'h', state: 'ready', createdAt: now, updatedAt: now,
      }).returning()
      check((await codeOf(() => svc.linkFinding(a.runId, fShot.id, { request_id: pendingReq[0]!.id }))) === 'request_not_applied', '未 applied 请求拒绝')

      // —— 执行中仍可 link（apply 后立即关联）；recheck 仍拒绝 ——
      const fActive = await mkFinding(a.runId, { category: 'visual', severity: 'minor', note: '执行中关联', scope: { kind: 'global' } })
      const reqActive = (await db.insert(reworkRequests).values({
        id: `req-a-${seq}`, projectId: a.projectId, runId: a.runId, stepKey: 'compose', requestKey: `rk-a-${seq}`,
        requestHash: 'h', state: 'applied', createdAt: now, updatedAt: now,
      }).returning())[0]!
      await db.update(pipelineRuns).set({ status: 'running' }).where(eq(pipelineRuns.id, a.runId))
      const activeList = await svc.listReviewFindings(a.runId, 'compose')
      const activeView = activeList.findings.find((x) => x.id === fActive.id)!
      check(activeView.can.link === true && activeView.can.recheck === false, '执行中 can：可关联、不可复检')
      check(activeList.capability.code === 'run_active' && activeList.capability.writable === false, 'capability：执行中 → run_active 且不可写')
      const linkedActive = await svc.linkFinding(a.runId, fActive.id, { request_id: reqActive.id }).catch((e) => e)
      check(!(linkedActive instanceof svc.ReviewError) && linkedActive.status === 'in_rework', '执行中 link 允许')
      check((await codeOf(() => svc.recheckFinding(a.runId, fActive.id))) === 'run_active', '执行中 recheck 拒绝')
      await db.update(pipelineRuns).set({ status: 'completed' }).where(eq(pipelineRuns.id, a.runId))

      // 成片未变 → recheck 拒绝
      check((await codeOf(() => svc.recheckFinding(a.runId, linked.id))) === 'final_unchanged', '同成片复检拒绝 final_unchanged')

      // 外部换片 → recheck
      const newFinal = await registerAsset(a.projectId, { name: `final2-${seq}`, kind: 'video', purpose: 'final_video', relPath: `p/final2-${seq}.mp4`, sha256: 'finalsha2', runId: a.runId, duration: 6, params: { timeline: mkTimeline({ s1Asset: a.s1.id, s2Asset: a.s2.id, cues: [{ id: 'c1', startMs: 1000, endMs: 2000, text: '第一句改' }] }) } })
      const steps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, a.runId))
      await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [newFinal.id] }) }).where(eq(pipelineSteps.id, steps[0]!.id))
      const r1 = await svc.recheckFinding(a.runId, linked.id)
      check(r1.status === 'pending_recheck' && r1.recheck?.state === 'unchanged', '新成片 recheck → pending_recheck')
      check(r1.can.verify === true && r1.can.recheck === false, '待复检投影：可终判不可重复复检')
      check(r1.needsRecheck === false && r1.staleRecheck === false, '刚复检完无陈旧标记')

      // 成片再变 → staleRecheck 投影，并允许再次复检
      const newFinal2 = await registerAsset(a.projectId, { name: `final3-${seq}`, kind: 'video', purpose: 'final_video', relPath: `p/final3-${seq}.mp4`, sha256: 'finalsha3', runId: a.runId, duration: 6, params: { timeline: mkTimeline({ s1Asset: a.s1.id, s2Asset: a.s2.id }) } })
      await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [newFinal2.id] }) }).where(eq(pipelineSteps.id, steps[0]!.id))
      const pendingView = (await svc.listReviewFindings(a.runId, 'compose')).findings.find((x) => x.id === linked.id)!
      check(pendingView.staleRecheck === true, '成片再变 → staleRecheck 投影')
      const staleRow = await svc.recheckFinding(a.runId, linked.id)
      check(staleRow.recheck?.finalAssetId === newFinal2.id && staleRow.staleRecheck === false, '再次复检记录新成片')
      // 此时 currentFinal = newFinal2，recheck_final = newFinal2，未再变 → verify 应成功
      const verified = await svc.verifyFinding(a.runId, linked.id, { result: 'verified', final_asset_id: newFinal2.id, note: '已修好' })
      check(verified.status === 'verified' && verified.resolvedAt !== null && verified.resolutionNote === '已修好', 'verify 人工终判')
      check((await codeOf(() => svc.verifyFinding(a.runId, linked.id, { result: 'verified', final_asset_id: newFinal2.id }))) === 'bad_transition', '非 pending 终判拒绝')

      // verify 三重匹配：先造 pending，再用错成片
      const f2 = await mkFinding(a.runId, { category: 'visual', severity: 'major', note: '第二个', scope: { kind: 'time', start_ms: 1000, end_ms: 2500 } })
      await svc.markReworkFinding(a.runId, f2.id, { note: '已手动换片' })
      check((await codeOf(() => svc.verifyFinding(a.runId, f2.id, { result: 'verified', final_asset_id: newFinal2.id }))) === 'bad_transition', 'in_rework 不能直接终判')
      const newFinal3 = await registerAsset(a.projectId, { name: `final4-${seq}`, kind: 'video', purpose: 'final_video', relPath: `p/final4-${seq}.mp4`, sha256: 'finalsha4', runId: a.runId, duration: 6, params: { timeline: mkTimeline({ s1Asset: a.s1.id, s2Asset: a.s2.id }) } })
      await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [newFinal3.id] }) }).where(eq(pipelineSteps.id, steps[0]!.id))
      await svc.recheckFinding(a.runId, f2.id)
      check((await codeOf(() => svc.verifyFinding(a.runId, f2.id, { result: 'verified', final_asset_id: newFinal2.id }))) === 'stale_final', '终判携带旧成片 → stale_final')
      // 成片再变 → stale_recheck
      const newFinal4 = await registerAsset(a.projectId, { name: `final5-${seq}`, kind: 'video', purpose: 'final_video', relPath: `p/final5-${seq}.mp4`, sha256: 'finalsha5', runId: a.runId, duration: 6, params: { timeline: mkTimeline({ s1Asset: a.s1.id, s2Asset: a.s2.id }) } })
      await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [newFinal4.id] }) }).where(eq(pipelineSteps.id, steps[0]!.id))
      const f2Row = await svc.listReviewFindings(a.runId, 'compose')
      check(f2Row.findings.find((x) => x.id === f2.id)!.staleRecheck === true, '成片再变 → staleRecheck 投影')
      check((await codeOf(() => svc.verifyFinding(a.runId, f2.id, { result: 'verified', final_asset_id: newFinal3.id }))) === 'stale_recheck', '成片再变 → stale_recheck')

      // reopen / dismiss
      const reopenedFromVerified = await svc.reopenFinding(a.runId, linked.id, {})
      check(reopenedFromVerified.status === 'open' && reopenedFromVerified.resolvedAt === null, 'reopen(verified) 回 open')
      check((await codeOf(() => svc.reopenFinding(a.runId, linked.id, {}))) === 'bad_transition', 'open 直接 reopen 拒绝')

      // f2：pending → 再次复检 → verify(reopened)
      await svc.recheckFinding(a.runId, f2.id)
      const reopened = await svc.verifyFinding(a.runId, f2.id, { result: 'reopened', final_asset_id: newFinal4.id, note: '仍可见' })
      check(reopened.status === 'open' && reopened.resolutionNote === '仍可见' && reopened.recheck !== null, 'verify(reopened) 回 open 并保留复检证据')
      const dismissed = await svc.dismissFinding(a.runId, f2.id, { note: '可接受' })
      check(dismissed.status === 'dismissed' && dismissed.resolutionNote === '可接受', 'dismiss')
      const reopen2 = await svc.reopenFinding(a.runId, f2.id, {})
      check(reopen2.status === 'open' && reopen2.resolvedAt === null && reopen2.recheck !== null, 'reopen 保留复检证据')

      // in_rework → reopen 保留返修备注
      const inRework = await svc.markReworkFinding(a.runId, fShot.id, { note: '手工换素材' })
      check(inRework.status === 'in_rework' && inRework.reworkNote === '手工换素材', 'mark-rework 留痕')
      const reopen3 = await svc.reopenFinding(a.runId, fShot.id, {})
      check(reopen3.status === 'open' && reopen3.reworkNote === '手工换素材', 'reopen(in_rework) 回 open 且保留返修备注')

      // patch
      const patched = await svc.patchReviewFinding(a.runId, f2.id, { note: '改写', severity: 'minor' })
      check(patched.note === '改写' && patched.severity === 'minor', 'patch note/severity')
      check((await codeOf(() => svc.patchReviewFinding(a.runId, f2.id, { note: '' }))) === 'note_required', 'patch 空 note 拒绝')

      // 基准成片被删 → baseAvailable=false（前端隐藏「看返修前」，不白屏）
      await db.update(assets).set({ deletedAt: now }).where(eq(assets.id, newFinal2.id))
      const gone = (await svc.listReviewFindings(a.runId, 'compose')).findings.find((x) => x.id === f2.id)!
      check(gone.baseAvailable === false, '基准成片删除 → baseAvailable=false')

      // —— needsRecheck：返修后成片已换 → 可复检（放在状态机断言之后，避免打乱既有成片序列） ——
      const fNeeds = await mkFinding(a.runId, { category: 'visual', severity: 'major', note: '返修待复检', scope: { kind: 'global' } })
      const needsRework = await svc.markReworkFinding(a.runId, fNeeds.id, {})
      check(needsRework.needsRecheck === false, '标记返修但成片未变：needsRecheck 仍 false')
      // 换片同时把片头改为 2s（S1 2000–4000 / S2 4000–7000），用于验证 shot 按当前 timeline 重锚定
      const newFinal5 = await registerAsset(a.projectId, { name: `final6-${seq}`, kind: 'video', purpose: 'final_video', relPath: `p/final6-${seq}.mp4`, sha256: 'finalsha6', runId: a.runId, duration: 7, params: { timeline: mkTimeline({ totalSec: 7, introSec: 2, s1Asset: a.s1.id, s2Asset: a.s2.id }) } })
      await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [newFinal5.id] }) }).where(eq(pipelineSteps.id, steps[0]!.id))
      const needsView = (await svc.listReviewFindings(a.runId, 'compose')).findings.find((x) => x.id === fNeeds.id)!
      check(needsView.needsRecheck === true && needsView.can.recheck === true, '返修后有新成片 → needsRecheck=true 且可复检')

      // —— currentLocation 三形 ——
      const locList = await svc.listReviewFindings(a.runId, 'compose')
      const shotLoc = locList.findings.find((x) => x.id === fShot.id)!
      check(shotLoc.currentLocation?.startMs === 4000 && shotLoc.currentLocation?.endMs === 7000 && shotLoc.currentLocation?.inRange === true, 'currentLocation：shot 按当前 timeline 重锚定（4000–7000）')
      const timeLoc = locList.findings.find((x) => x.id === fTime.id)!
      check(timeLoc.currentLocation?.startMs === 2500 && timeLoc.currentLocation?.endMs === 5000 && timeLoc.currentLocation.inRange === true, 'currentLocation：time 2500–5000 在 7s 成片内 inRange=true')
      const activeLoc = locList.findings.find((x) => x.id === fActive.id)!
      check(activeLoc.currentLocation === null, 'currentLocation：global 为 null')

      const fOut = await mkFinding(a.runId, { category: 'visual', severity: 'major', note: '成片变短后越界', scope: { kind: 'time', start_ms: 4000, end_ms: 6000 } })
      const shortFinal = await registerAsset(a.projectId, { name: `final7-${seq}`, kind: 'video', purpose: 'final_video', relPath: `p/final7-${seq}.mp4`, sha256: 'finalsha7', runId: a.runId, duration: 3, params: { timeline: mkTimeline({ totalSec: 3, s1Asset: a.s1.id, s2Asset: a.s2.id }) } })
      await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [shortFinal.id] }) }).where(eq(pipelineSteps.id, steps[0]!.id))
      const outLoc = (await svc.listReviewFindings(a.runId, 'compose')).findings.find((x) => x.id === fOut.id)!
      check(outLoc.currentLocation?.inRange === false, 'currentLocation：成片变短 → time 越界 inRange=false')

      // —— cancelled：逐条 can 全关，patch 仍可用 ——
      await db.update(pipelineRuns).set({ status: 'cancelled' }).where(eq(pipelineRuns.id, a.runId))
      const cancelledView = (await svc.listReviewFindings(a.runId, 'compose')).findings.find((x) => x.id === fOut.id)!
      check(
        cancelledView.can.link === false && cancelledView.can.markRework === false && cancelledView.can.recheck === false
          && cancelledView.can.verify === false && cancelledView.can.reopen === false && cancelledView.can.dismiss === false,
        'cancelled：can 六键全 false',
      )
      const patchedCancelled = await svc.patchReviewFinding(a.runId, fOut.id, { note: '取消后仍可编辑' })
      check(patchedCancelled.note === '取消后仍可编辑', 'cancelled：patch note 仍成功')
      await db.update(pipelineRuns).set({ status: 'completed' }).where(eq(pipelineRuns.id, a.runId))

      // —— cancelled 逐条 can：用「未取消时本应可 verify / reopen」的行证明 cancelled 闸生效 ——
      const cancelRun = await seed({})
      const fVerifyBeforeCancel = await mkFinding(cancelRun.runId, { category: 'visual', severity: 'blocker', note: '待终判', scope: { kind: 'global' } })
      const fPendingAtCancel = await mkFinding(cancelRun.runId, { category: 'visual', severity: 'minor', note: '取消时仍待终判', scope: { kind: 'global' } })
      await svc.markReworkFinding(cancelRun.runId, fVerifyBeforeCancel.id, {})
      await svc.markReworkFinding(cancelRun.runId, fPendingAtCancel.id, {})
      const cancelNewFinal = await registerAsset(cancelRun.projectId, {
        name: `final-cancel-${seq}`, kind: 'video', purpose: 'final_video', relPath: `p/final-cancel-${seq}.mp4`,
        sha256: `cancelsha${seq}`, runId: cancelRun.runId, duration: 6, stepId: cancelRun.step.id,
        params: { timeline: mkTimeline({ s1Asset: cancelRun.s1.id, s2Asset: cancelRun.s2.id }) },
      })
      await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [cancelNewFinal.id] }) }).where(eq(pipelineSteps.id, cancelRun.step.id))
      const pendingAtCancelView = await svc.recheckFinding(cancelRun.runId, fPendingAtCancel.id)
      check(pendingAtCancelView.can.verify === true && pendingAtCancelView.can.dismiss === true, '前置：pending_recheck 且成片一致 → 未取消时 can.verify/dismiss=true')
      await svc.recheckFinding(cancelRun.runId, fVerifyBeforeCancel.id)
      const verifiedAtCancelView = await svc.verifyFinding(cancelRun.runId, fVerifyBeforeCancel.id, { result: 'verified', final_asset_id: cancelNewFinal.id })
      check(verifiedAtCancelView.can.reopen === true, '前置：verified → 未取消时 can.reopen=true')
      await db.update(pipelineRuns).set({ status: 'cancelled' }).where(eq(pipelineRuns.id, cancelRun.runId))
      const cancelList = await svc.listReviewFindings(cancelRun.runId, 'compose')
      const pendingCancelled = cancelList.findings.find((x) => x.id === fPendingAtCancel.id)!
      check(
        pendingCancelled.can.link === false && pendingCancelled.can.markRework === false && pendingCancelled.can.recheck === false
          && pendingCancelled.can.verify === false && pendingCancelled.can.reopen === false && pendingCancelled.can.dismiss === false,
        'cancelled：pending 行 can 六键全 false（verify/dismiss 原本可用）',
      )
      const verifiedCancelled = cancelList.findings.find((x) => x.id === fVerifyBeforeCancel.id)!
      check(
        verifiedCancelled.status === 'verified' && verifiedCancelled.can.verify === false && verifiedCancelled.can.reopen === false,
        'cancelled：verified 行 can.reopen=false（原本可用）',
      )

      // —— step_key 钉住：两合成步各有成片，只对钉住那步复检 ——
      const dual = await seed({ stepKey: 'compose' })
      const stepB = (await db.insert(pipelineSteps).values({
        runId: dual.runId, seq: 2, stepKey: 'compose_b', actionKey: 'ffmpeg_merge', title: '合成B', status: 'completed',
        input: '{}', output: '{}', createdAt: now, updatedAt: now,
      }).returning())[0]!
      const bFinal = await registerAsset(dual.projectId, { name: 'final-b', kind: 'video', purpose: 'final_video', relPath: 'p/final-b.mp4', sha256: 'bsha', runId: dual.runId, duration: 6, stepId: stepB.id, params: { timeline: mkTimeline({ s1Asset: dual.s1.id, s2Asset: dual.s2.id }) } })
      await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [bFinal.id] }) }).where(eq(pipelineSteps.id, stepB.id))
      const fB = await mkFinding(dual.runId, { step_key: 'compose_b', category: 'visual', severity: 'major', note: 'B 步', scope: { kind: 'global' } })
      const listA = await svc.listReviewFindings(dual.runId, 'compose')
      const listB = await svc.listReviewFindings(dual.runId, 'compose_b')
      check(listA.findings.every((x) => x.stepKey === 'compose') && listB.findings.length === 1 && listB.findings[0]!.id === fB.id, 'findings 按 stepKey 隔离')
      check(listA.final?.assetId === dual.finalId && listB.final?.assetId === bFinal.id, '列表成片按 stepKey 解析')
      await svc.markReworkFinding(dual.runId, fB.id, {})
      const reB = await svc.recheckFinding(dual.runId, fB.id).catch((e) => e)
      check(reB instanceof svc.ReviewError && reB.code === 'final_unchanged', 'step_key 钉住：B 步成片未变不误用 A 步新片')

      // —— 删除清理 ——
      const { purgeRunRecords } = await import('../src/services/run-delete')
      const { reviewFindings } = await import('../src/db/schema')
      const before = (await db.select().from(reviewFindings).where(eq(reviewFindings.runId, a.runId))).length
      const purged = await purgeRunRecords([a.runId])
      const after = (await db.select().from(reviewFindings).where(eq(reviewFindings.runId, a.runId))).length
      check(before > 0 && after === 0, 'purgeRunRecords 删除问题单')
      check(purged.findings === before, 'purge 返回值含 findings 计数')
    },
    route: async () => {
      const { db } = await import('../src/db')
      const { projects, pipelineRuns, pipelineSteps } = await import('../src/db/schema')
      const { registerAsset } = await import('../src/services/storage')
      const { app } = await import('../src/app')
      const { eq } = await import('drizzle-orm')

      const jreq = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
        const init: RequestInit = { method }
        if (body !== undefined) {
          init.headers = { 'content-type': 'application/json' }
          init.body = JSON.stringify(body)
        }
        const res = await app.request(path, init)
        let json: any = null
        try { json = await res.json() } catch { /* 非 JSON */ }
        return { status: res.status, body: json }
      }

      const now = Date.now()
      const projectId = (await db.insert(projects).values({ name: 'M69-route', createdAt: now, updatedAt: now }).returning())[0]!.id
      const runId = (await db.insert(pipelineRuns).values({ projectId, templateKey: 'probe-m69', status: 'completed', input: '{}', createdAt: now, updatedAt: now }).returning())[0]!.id
      const s1 = await registerAsset(projectId, { name: 'r1', kind: 'video', purpose: 'shot_video', relPath: 'p/r1.mp4', sha256: 'r1', runId, duration: 2 })
      const s2 = await registerAsset(projectId, { name: 'r2', kind: 'video', purpose: 'shot_video', relPath: 'p/r2.mp4', sha256: 'r2', runId, duration: 3 })
      const step = (await db.insert(pipelineSteps).values({ runId, seq: 1, stepKey: 'compose', actionKey: 'ffmpeg_merge', title: '合成', status: 'completed', input: '{}', output: '{}', createdAt: now, updatedAt: now }).returning())[0]!
      const timeline = {
        v: 1, totalSec: 6, introSec: 1, outroSec: 0,
        segments: [
          { shotId: 'S1', assetId: s1.id, kind: 'video', durSec: 2, startSec: 0, lineIds: [], silenceSec: 0 },
          { shotId: 'S2', assetId: s2.id, kind: 'video', durSec: 3, startSec: 2, lineIds: [], silenceSec: 0 },
        ],
        subtitle: { coordinate: 'final', cues: [{ id: 'c1', startMs: 1000, endMs: 2000, text: '第一句' }] },
        bgm: null, sfx: [],
      }
      const final = await registerAsset(projectId, { name: 'rf', kind: 'video', purpose: 'final_video', relPath: 'p/rf.mp4', sha256: 'rf', runId, duration: 6, stepId: step.id, params: { timeline } })
      await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [final.id] }) }).where(eq(pipelineSteps.id, step.id))

      // 列表能力
      const l0 = await jreq('GET', `/api/v1/runs/${runId}/findings`)
      check(l0.status === 200 && l0.body.capability.code === 'ok' && l0.body.capability.writable === true, '列表 capability ok/writable')
      check(l0.body.final?.assetId === final.id && l0.body.final.durationMs === 6000, '列表成片与时长（ms）')
      check(l0.body.timeline?.segments.length === 2 && l0.body.timeline.introMs === 1000, '列表下发段摘要与片头')
      check((await jreq('GET', `/api/v1/runs/999999/findings`)).status === 404, 'run 不存在 404')
      check((await jreq('GET', `/api/v1/runs/999999/findings`)).body.error.code === 'run_not_found', 'run 不存在 error.code')

      // 创建
      const c = await jreq('POST', `/api/v1/runs/${runId}/findings`, {
        client_key: 'rk1', category: 'visual', severity: 'major', note: 'S2 穿帮', scope: { kind: 'shot', shot_id: 'S2' },
      })
      check(c.status === 200 && c.body.finding.status === 'open' && c.body.replayed === false, '创建返回 finding')
      const c2 = await jreq('POST', `/api/v1/runs/${runId}/findings`, {
        client_key: 'rk1', category: 'visual', severity: 'major', note: 'S2 穿帮', scope: { kind: 'shot', shot_id: 'S2' },
      })
      check(c2.body.replayed === true, '同键回放')
      const bad = await jreq('POST', `/api/v1/runs/${runId}/findings`, { client_key: 'rk1', category: 'visual', severity: 'major', note: '改', scope: { kind: 'shot', shot_id: 'S2' } })
      check(bad.status === 400 && bad.body.error.code === 'client_key_conflict', '同键异载荷 400')
      check((await jreq('POST', `/api/v1/runs/${runId}/findings`, { category: 'visual', severity: 'major', note: 'x', scope: { kind: 'shot', shot_id: 'S9' } })).body.error.code === 'bad_scope', '未知镜头 400')
      check((await jreq('POST', `/api/v1/runs/${runId}/findings`, { category: 'lip_sync', severity: 'major', note: 'x', scope: { kind: 'global' } })).status === 400, '类别/范围不匹配 400')

      const fid = c.body.finding.id
      // patch / link / mark-rework
      const p1 = await jreq('PATCH', `/api/v1/runs/${runId}/findings/${fid}`, { severity: 'blocker' })
      check(p1.status === 200 && p1.body.finding.severity === 'blocker', 'PATCH severity')
      const mk = await jreq('POST', `/api/v1/runs/${runId}/findings/${fid}/mark-rework`, { note: '手工换素材' })
      check(mk.body.finding.status === 'in_rework' && mk.body.finding.reworkNote === '手工换素材', 'mark-rework')
      const unchanged = await jreq('POST', `/api/v1/runs/${runId}/findings/${fid}/recheck`, {})
      check(unchanged.status === 409 && unchanged.body.error.code === 'final_unchanged', '同成片复检 409')

      // 换片 → recheck → verify
      const final2 = await registerAsset(projectId, { name: 'rf2', kind: 'video', purpose: 'final_video', relPath: 'p/rf2.mp4', sha256: 'rf2', runId, duration: 6, params: { timeline } })
      await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [final2.id] }) }).where(eq(pipelineSteps.id, step.id))
      const rc = await jreq('POST', `/api/v1/runs/${runId}/findings/${fid}/recheck`, {})
      check(rc.status === 200 && rc.body.finding.status === 'pending_recheck', '换片后复检 pending_recheck')
      check(['changed', 'unchanged', 'unverifiable'].includes(rc.body.finding.recheck.state), '复检状态在枚举内')
      check(rc.body.finding.can.verify === true, '可终判')
      const v = await jreq('POST', `/api/v1/runs/${runId}/findings/${fid}/verify`, { result: 'verified', final_asset_id: final2.id, note: '已确认' })
      check(v.status === 200 && v.body.finding.status === 'verified', 'verify 成功')
      check(v.body.finding.resolutionNote === '已确认' && v.body.finding.resolvedAt !== null, '终判备注/时间')
      const staleVerify = await jreq('POST', `/api/v1/runs/${runId}/findings/${fid}/verify`, { result: 'verified', final_asset_id: final2.id })
      check(staleVerify.status === 409 && staleVerify.body.error.code === 'bad_transition', '重复终判 bad_transition')

      // reopen / dismiss / 404
      const ro = await jreq('POST', `/api/v1/runs/${runId}/findings/${fid}/reopen`, { note: '仍有问题' })
      check(ro.status === 200 && ro.body.finding.status === 'open', 'reopen')
      const ds = await jreq('POST', `/api/v1/runs/${runId}/findings/${fid}/dismiss`, {})
      check(ds.body.finding.status === 'dismissed', 'dismiss')
      check((await jreq('POST', `/api/v1/runs/${runId}/findings/999999/reopen`, {})).status === 404, 'finding 不存在 404')
      check((await jreq('POST', `/api/v1/runs/999999/findings/${fid}/dismiss`, {})).body.error.code === 'finding_not_found', '跨 run 按不存在处理')

      // 失败零写库：非法创建后计数不变
      const before = (await jreq('GET', `/api/v1/runs/${runId}/findings`)).body.summary.total
      await jreq('POST', `/api/v1/runs/${runId}/findings`, { category: 'visual', severity: 'major', note: '', scope: { kind: 'global' } })
      const after = (await jreq('GET', `/api/v1/runs/${runId}/findings`)).body.summary.total
      check(before === after, '失败请求零写库')

      // 能力降级：running / cancelled / no_final
      await db.update(pipelineRuns).set({ status: 'running' }).where(eq(pipelineRuns.id, runId))
      const lr = await jreq('GET', `/api/v1/runs/${runId}/findings`)
      check(lr.body.capability.code === 'run_active' && lr.body.capability.writable === false, 'running 能力降级')
      check((await jreq('POST', `/api/v1/runs/${runId}/findings`, { category: 'visual', severity: 'major', note: 'x', scope: { kind: 'global' } })).body.error.code === 'run_active', 'running 创建 409')
      await db.update(pipelineRuns).set({ status: 'cancelled' }).where(eq(pipelineRuns.id, runId))
      check((await jreq('GET', `/api/v1/runs/${runId}/findings`)).body.capability.code === 'run_cancelled', 'cancelled 优先于 no_final')
      check((await jreq('PATCH', `/api/v1/runs/${runId}/findings/${fid}`, { note: '只读仍可改描述' })).status === 200, 'cancelled 仍可 patch')

      // 项目彻底删除清问题单
      const { reviewFindings } = await import('../src/db/schema')
      const pid2 = (await db.insert(projects).values({ name: 'M69-purge', createdAt: now, updatedAt: now }).returning())[0]!.id
      const rid2 = (await db.insert(pipelineRuns).values({ projectId: pid2, templateKey: 'probe-m69', status: 'completed', input: '{}', createdAt: now, updatedAt: now }).returning())[0]!.id
      await db.insert(reviewFindings).values({
        projectId: pid2, runId: rid2, stepKey: 'compose', baseFinalAssetId: 1, scopeKind: 'global',
        category: 'visual', severity: 'minor', note: '孤儿检查', status: 'open', createdAt: now, updatedAt: now,
      })
      const purgedP = await jreq('DELETE', `/api/v1/projects/${pid2}?purge=1`)
      check(purgedP.status === 200 && purgedP.body.purged.findings === 1, '项目彻底删除清理问题单')
    },
  },
})
