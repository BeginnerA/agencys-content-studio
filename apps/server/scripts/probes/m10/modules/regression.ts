/**
 * [M10·拆分] scripts/probe-m10.ts 的 regression 节（≤800 行红线拆分，断言逐字保留）。
 * M7 语义回归：applyStoryboardEdits 不变 + edit→mutate 链 + reset 不含上传 + board 聚合读兼容。
 * 运行期服务在本模块内动态 import（入口已建立隔离环境），与拆分前 main() 内 import 时序等价。
 */
import type { M10Ctx } from '../ctx'

export async function sectionRegression(ctx: M10Ctx): Promise<void> {
  const { check, errOf, seedRun, getStep, getAsset, PNG_A } = ctx
  const {
    WorkbenchError,
    applyShotSelection,
    applyStoryboardEdits,
    buildShotBoard,
    reorderShots,
    uploadAndBindShotAsset,
  } = await import('../../../../src/services/shot')
  const { readTextAsset } = await import('../../../../src/services/storage')

  const s = await seedRun()

  // ---- applyStoryboardEdits（M7）行为不变 ----
  const r1 = await applyStoryboardEdits(s.runId, 'gen_images', [{ shot_id: 's01', duration: 3.5, image_prompt: '夜景版' }])
  check(r1.edited === 1 && r1.assetIds[0] === r1.assetId, '编辑：新资产 + 保位替换')
  const na = await getAsset(r1.assetId)
  check(na.name.includes('工作台编辑') && na.stepId === s.sbStepId && na.runId === s.runId, '编辑资产命名/归属（M7 不变）')
  const ed1 = JSON.parse(await readTextAsset(r1.assetId)) as { shots: Array<{ id: string; duration?: number; image_prompt?: string }> }
  check(ed1.shots[0]!.duration === 3.5 && ed1.shots[0]!.image_prompt === '夜景版', '三字段 patch 生效（duration/提示词）')

  // ---- edit → mutate 链（基于最新分镜）----
  const r2 = await reorderShots(s.runId, 'gen_images', ['s02', 's01'])
  const ed2 = JSON.parse(await readTextAsset(r2.assetId)) as { shots: Array<{ id: string; image_prompt?: string; duration?: number }> }
  check(ed2.shots[0]!.id === 's02' && ed2.shots[1]!.image_prompt === '夜景版', 'mutate 基于编辑后分镜（编辑保留）')
  const sbOut = JSON.parse((await getStep(s.sbStepId)).output ?? '{}') as { asset_ids?: number[] }
  check(sbOut.asset_ids?.[0] === r2.assetId, '保位替换链（编辑资产 → 结构性编辑资产）')

  // ---- M7 错误码不回归 ----
  const eSame = await errOf(() => applyStoryboardEdits(s.runId, 'gen_images', [{ shot_id: 's01', duration: 3.5, image_prompt: '夜景版' }]))
  check(eSame instanceof WorkbenchError && eSame.code === 'no_change', 'no_change 语义（同值提交）')
  const eBad = await errOf(() => applyStoryboardEdits(s.runId, 'gen_images', []))
  check(eBad instanceof WorkbenchError && eBad.code === 'bad_items', 'bad_items（空数组）')

  // ---- reset 恢复仅任务产物（不含上传）----
  const up = await uploadAndBindShotAsset(s.runId, 'gen_images', 's01', { name: 'reset.png', data: PNG_A })
  check(JSON.stringify(up.assetIds) === JSON.stringify([s.a2, up.asset.id]), `重置前置：output 含上传（[a2,up]）（实际 [${up.assetIds}]）`)
  const r3 = await applyShotSelection(s.runId, 'gen_images', { reset: true })
  check(JSON.stringify(r3.assetIds) === JSON.stringify([s.a2, s.a1v2]), `reset → 任务产物全量（上传被排除）（实际 [${r3.assetIds}]）`)

  // ---- board 聚合读兼容（M7 字段仍在）----
  const board = await buildShotBoard(s.runId, 'gen_images')
  const sh1 = board.shots.find((x) => x.shotId === 's01')!
  check(sh1.duration === 3.5 && sh1.imagePrompt === '夜景版', '板面消费编辑后分镜（时长/提示词）')
  check(sh1.versions.every((v) => typeof v.id === 'number' && typeof v.urls.file === 'string'), 'M7 版本字段结构不变（id/urls）')
}
