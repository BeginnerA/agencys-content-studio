/** M16⑤ linkage：ref-assets / 送入画布 / prefill 键安全（断言体逐字搬自原 probe-m16.ts） */
import type { M16Ctx } from './ctx'

export async function run(ctx: M16Ctx): Promise<void> {
  const { check, jreq, db, characters, eq, mkAsset, PID, A1, A2, A_OTHER, loadTemplate, T0 } = ctx
  // ref-assets 并集挂接
  const ent = (
    await db
      .insert(characters)
      .values({ projectId: PID, kind: 'character', name: '角色甲', aliases: '[]', states: '[]', refAssetIds: '[]', meta: '{}', createdAt: T0, updatedAt: T0 })
      .returning()
  )[0]!
  const r1 = await jreq('POST', `/api/v1/entities/${ent.id}/ref-assets`, { asset_ids: [A1] })
  check(r1.status === 200 && r1.body?.added === 1, 'ref-assets：挂接 1 张 → added=1')
  const r2 = await jreq('POST', `/api/v1/entities/${ent.id}/ref-assets`, { asset_ids: [A1, A2] })
  const rowAfter = (await db.select().from(characters).where(eq(characters.id, ent.id)))[0]!
  check(r2.status === 200 && r2.body?.added === 1 && JSON.parse(rowAfter.refAssetIds).join(',') === `${A1},${A2}`, 'ref-assets：并集去重（added=1，落库 [A1,A2]）')
  check((await jreq('POST', '/api/v1/entities/999999/ref-assets', { asset_ids: [A1] })).status === 404, 'ref-assets 不存在实体 → 404')
  const entG = (
    await db
      .insert(characters)
      .values({ projectId: null, kind: 'character', name: '全局角色', aliases: '[]', states: '[]', refAssetIds: '[]', meta: '{}', createdAt: T0, updatedAt: T0 })
      .returning()
  )[0]!
  check((await jreq('POST', `/api/v1/entities/${entG.id}/ref-assets`, { asset_ids: [A1] })).status === 400, 'ref-assets 全局实体挂非池资产 → 400（[M52] 仅放行全局池）')
  // [M52] 全局实体挂池资产 → 200（项目资产不得越界入全局，池资产可）
  const A_POOL = await mkAsset(0, 'image', '池定妆照', 'reference_character')
  const rg = await jreq('POST', `/api/v1/entities/${entG.id}/ref-assets`, { asset_ids: [A_POOL] })
  const gRow = (await db.select().from(characters).where(eq(characters.id, entG.id)))[0]!
  check(rg.status === 200 && rg.body?.added === 1 && JSON.parse(gRow.refAssetIds).join(',') === String(A_POOL), 'ref-assets 全局实体挂池资产 → 200 落库')
  check((await jreq('POST', `/api/v1/entities/${ent.id}/ref-assets`, { asset_ids: [] })).status === 400, 'ref-assets 空数组 → 400')
  check((await jreq('POST', `/api/v1/entities/${ent.id}/ref-assets`, { asset_ids: [A_OTHER] })).status === 400, 'ref-assets 他项目资产 → 400（项目域）')

  // 送入画布：run 产物资产 → 素材节点（模拟 CanvasDrawer「送入创作画布」）
  const runAsset = await mkAsset(PID, 'image', 'run 产物', 'shot_image')
  const c4 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '联动画布' })
  const C4: number = c4.body.canvas.id
  const push = await jreq('POST', `/api/v1/canvases/${C4}/nodes`, { kind: 'asset', assetId: runAsset, x: 100, y: 100 })
  check(push.status === 201, '送入画布：POST 素材节点 → 201')
  const dC4 = await jreq('GET', `/api/v1/canvases/${C4}`)
  const pushed = (dC4.body?.nodes ?? []).find((n: any) => n.assetId === runAsset)
  check(pushed?.asset?.urls?.file === `/api/v1/assets/${runAsset}/file`, '送入画布：节点资产视图（file URL）')

  // prefill 键安全：未声明键静默丢弃（normalizeInput 前置）
  const { prepareRunInput } = await import('../../../src/services/run-create')
  const tplM = loadTemplate('mengbao-episode')
  const norm = prepareRunInput(tplM, { brief: 'B', episode_number: '3', setting_docs: [A1], bogus_key: 'x' })
  check(
    JSON.stringify(norm['setting_docs']) === `[${A1}]` && norm['episode_number'] === 3 && !('bogus_key' in norm),
    'prefill 键安全：setting_docs 归一 + 未声明键 bogus_key 丢弃',
  )
  let threw = false
  try {
    prepareRunInput(tplM, { brief: 'B', episode_number: 1, setting_docs: ['bad'] })
  } catch {
    threw = true
  }
  check(threw, 'prefill 键安全：非法 files 元素 → 抛（bad_input 语义）')
}
