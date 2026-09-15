import { round3 } from './util'

/**
 * [M19] SFX 起点规划（纯函数；探针直测）——每镜 ≤1 条、起点 = Σ_{j<i} d_j + 片头位移：
 * - 与 buildTransitionPlan offsets 同口径：转场时镜 i 起点即 offsets[i-1]（同一 Σd 公式，不随转场改变）；
 * - fileOk=false（文件缺失）或 relPath 缺失 → 计入 missing 跳过，不产出条目。
 */
export function planSfxStarts(
  segmentDurations: number[],
  segmentShotIds: Array<string | null>,
  sfxAssets: Array<{ shotId: string; assetId: number; relPath: string | null; fileOk: boolean }>,
  introSec: number,
): { entries: Array<{ assetId: number; relPath: string; startSec: number }>; missing: Array<{ shotId: string; assetId: number }> } {
  const byShot = new Map(sfxAssets.map((a) => [a.shotId, a]))
  const entries: Array<{ assetId: number; relPath: string; startSec: number }> = []
  const missing: Array<{ shotId: string; assetId: number }> = []
  let acc = 0
  for (let i = 0; i < segmentDurations.length; i++) {
    const sid = segmentShotIds[i] ?? null
    const a = sid ? byShot.get(sid) : undefined
    if (a) {
      if (a.relPath && a.fileOk) entries.push({ assetId: a.assetId, relPath: a.relPath, startSec: round3(acc + introSec) })
      else missing.push({ shotId: sid!, assetId: a.assetId })
    }
    acc = round3(acc + segmentDurations[i]!)
  }
  return { entries, missing }
}
