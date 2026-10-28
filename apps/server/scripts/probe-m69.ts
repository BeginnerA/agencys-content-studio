/**
 * M69 探针（审片问题单与返修复检）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m69.ts [--section=scope|diff|service|route]
 *
 * 隔离策略：isolatedEnv('m69') 一次性临时目录（独立 studio.db + workspace），
 * 必须先于任何 src 动态 import。零网络零付费。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup } = isolatedEnv('m69')

// 只声明本任务已实现的分节；后续任务各自追加一节（未注册 runner 的分节会让 probe:ci 中途失败）
const SECTIONS = ['scope', 'diff'] as const

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
      const { buildBaseSnapshot, parseTimelineAudio } = await import('../src/services/review/snapshot')
      const { recheckScope } = await import('../src/services/review/recheck')

      const mkTl = (o: {
        s1Asset?: number; s2Asset?: number; s1Sha?: string; s2Sha?: string
        totalSec?: number; cues?: Array<{ id: string; startMs: number; endMs: number; text: string }>
        bgm?: { assetId: number; volume: number; fadeSec: number } | null
        sfx?: Array<{ shotId: string; assetId: number }>
      }) => {
        const tl = {
          v: 1, totalSec: o.totalSec ?? 6, introSec: 1, outroSec: 0,
          segments: [
            { shotId: 'S1', assetId: o.s1Asset ?? 11, kind: 'video', durSec: 2, startSec: 0 },
            { shotId: 'S2', assetId: o.s2Asset ?? 12, kind: 'video', durSec: 3, startSec: 2 },
          ],
          subtitle: { coordinate: 'final', cues: o.cues ?? [{ id: 'c1', startMs: 1000, endMs: 2000, text: '第一句' }, { id: 'c2', startMs: 3000, endMs: 4500, text: '第二句' }] },
          bgm: o.bgm === undefined ? { assetId: 9, relPath: 'b.mp3', volume: 0.6, fadeSec: 1.5 } : o.bgm,
          sfx: (o.sfx ?? [{ shotId: 'S1', assetId: 77 }]).map((s) => ({ ...s, startSec: 1, relPath: 's.mp3' })),
        }
        return parseFinalTimeline(JSON.stringify({ timeline: tl }))!
      }
      const shaMap = new Map<number, string | null>([[11, 'sha11'], [12, 'sha12'], [9, 'sha9'], [77, 'sha77'], [78, 'sha78']])
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
    },
  },
})
