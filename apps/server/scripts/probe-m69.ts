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
const SECTIONS = ['scope'] as const

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
  },
})
