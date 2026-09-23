/**
 * [M11·拆分] scripts/probe-m11.ts 的 regression 节（≤800 行红线拆分，断言逐字保留）。
 */
import { writeFileSync } from 'node:fs'
import type { Asset } from '../../../../src/db/schema'
import type { M11Ctx } from '../ctx'

export async function sectionRegression(ctx: M11Ctx): Promise<void> {
  const { computeShotSegments, parseShotDurations, planVoiceAlignedSegments } = await import('../../../../src/pipeline/actions/ffmpeg-merge')
  const { pid, check, errOf, absPathOf, relPathOf } = ctx

  // 真实文件（images 不读内容；clips 空文件探测必失败 → 估算路径）
  const okRel1 = relPathOf(pid, 'shot_image', 'm11-plan-1.png')
  const okRel2 = relPathOf(pid, 'shot_image', 'm11-plan-2.png')
  const okRel3 = relPathOf(pid, 'motion_clip', 'm11-plan-3.mp4')
  const okRel4 = relPathOf(pid, 'motion_clip', 'm11-plan-4.mp4')
  const missingRel = relPathOf(pid, 'shot_image', 'm11-plan-missing.png')
  for (const rel of [okRel1, okRel2, okRel3, okRel4]) writeFileSync(absPathOf(rel), Buffer.from('m11'))

  const row = (id: number, kind: string, relPath: string | null, shotId: string | null, duration?: number): Asset =>
    ({ id, kind, relPath, duration: duration ?? null, params: shotId ? JSON.stringify({ shotId }) : null }) as unknown as Asset

  // ---- 均分场景（无 per-shot 覆盖；fit_voice 均分基线）----
  const imgA = row(201, 'image', okRel1, 's01')
  const imgB = row(202, 'image', okRel2, 's02')
  const r1 = computeShotSegments([imgA, imgB], 'images', new Map(), 4)
  check(r1.segments.length === 2 && r1.segments.every((s) => s.durSec === 4 && !s.explicit), '均分：全镜 duration_per_shot=4（非 explicit）')

  // ---- 显式场景（per-shot 覆盖 + 容错；fit_voice explicit 分区输入）----
  const noRel = row(203, 'image', null, 's03')
  const miss = row(204, 'image', missingRel, 's04')
  const wrongKind = row(205, 'video', okRel3, 's05')
  const r2 = computeShotSegments([imgA, imgB, noRel, miss, wrongKind], 'images', new Map([['s01', 6.5]]), 4)
  check(r2.segments.length === 2 && r2.skipped.length === 3, `显式：2 段 / 3 跳过（实际 ${r2.segments.length}/${r2.skipped.length}）`)
  check(
    JSON.stringify(r2.skipped) === JSON.stringify([203, 204, 205]),
    `skipped 顺序（缺 relPath → 缺文件 → kind 不符；实际 [${r2.skipped}]）`,
  )
  check(
    r2.segments[0]!.durSec === 6.5 && r2.segments[0]!.explicit === true && r2.segments[1]!.durSec === 4 && !r2.segments[1]!.explicit,
    'explicit 标记与 M7 一致（fit_voice 分区输入）',
  )

  // ---- clips：DB duration 优先 → 探测失败估算 ----
  const v1 = row(206, 'video', okRel3, 's06', 5)
  const v2 = row(207, 'video', okRel4, 's07')
  const r3 = computeShotSegments([v1, v2], 'clips', new Map(), 4)
  check(r3.segments[0]!.durSec === 5 && !r3.segments[0]!.estimated, 'DB duration 优先（非估算）')
  check(r3.segments[1]!.durSec === 4 && r3.segments[1]!.estimated === true, '探测失败 → duration_per_shot 估算（estimated）')

  // ---- 空输入 ----
  const r4 = computeShotSegments([], 'images', new Map(), 4)
  check(r4.segments.length === 0 && r4.skipped.length === 0, '空输入 → 空结果')

  // ---- parseShotDurations：双口径回退 + 形态容错 ----
  const pd = parseShotDurations(
    JSON.stringify({ shots: [{ id: 's01', duration: 3 }, { id: 's02', duration_sec: 2.5 }, { id: 5, duration: 2 }, null] }),
  )
  check(pd.size === 2 && pd.get('s01') === 3 && pd.get('s02') === 2.5, 'parseShotDurations 双口径（duration 优先 / duration_sec 回退）')
  const pdArr = parseShotDurations(JSON.stringify([{ id: 'a', duration_sec: 1.5 }]))
  check(pdArr.size === 1 && pdArr.get('a') === 1.5, '裸数组形态')
  const ePd = await errOf(async () => parseShotDurations('not-json'))
  check(ePd instanceof SyntaxError, '坏 JSON 抛错（调用侧兜底）')

  // ---- 对齐回退正交：fail 形态不产生段/句（主路径仅 aligned 才赋值 durSec）----
  const failPlan = planVoiceAlignedSegments([{ id: 's01', durationSec: null, lineIds: [] }], new Map(), 4, { hasLinesField: true })
  check(
    !failPlan.aligned && failPlan.segments.length === 0 && failPlan.lines.length === 0 && failPlan.totalDur === 0,
    '对齐回退形态（segments/lines 空、totalDur=0——computeShotSegments 输出不受影响）',
  )
}
