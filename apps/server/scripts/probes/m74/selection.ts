/**
 * 分层选择策略节（纯函数矩阵，零库表零网络）。
 *
 * 覆盖：隐式基准回落、状态命中优先级、命中但无参考的回退留痕、多条命中取时间序末条、
 * 停用行不参与、上限与裁剪去向、跨实体共享名额与总量上限，以及薄封装与主函数的逐元素一致性。
 */
import assert from 'node:assert/strict'
import type { Checker } from '../../probe-lib'
import type { CharacterRow } from '../../../src/db/schema'
import {
  MAX_CHARACTER_REFS_PER_SHOT,
  MAX_REFS_PER_SHOT,
  collectRefAssetIds,
  collectRefSelection,
  selectEntityRefs,
  type EntityRefRow,
  type RefShot,
} from '../../../src/services/ref-selection'
import { test } from './helpers'

/** 实体行最小形状（选择策略只消费 id/states/refAssetIds 三列，其余列不在射程） */
function host(over: Partial<{ id: number; states: string[]; refAssetIds: number[] }>) {
  return { id: over.id ?? 7, states: JSON.stringify(over.states ?? []), refAssetIds: JSON.stringify(over.refAssetIds ?? [101, 102]) }
}

/** 分层登记行最小形状 */
function ref(over: Partial<EntityRefRow>): EntityRefRow {
  return { entityId: over.entityId ?? 7, assetId: over.assetId ?? 201, role: over.role ?? 'base', stateKey: over.stateKey ?? null, viewKey: over.viewKey ?? null, enabled: over.enabled ?? 1 }
}

/** 索引行最小形状（只放选择策略读取的列） */
function indexRow(over: { id: number; name: string; states?: string[]; refAssetIds?: number[] }): CharacterRow {
  return host({ id: over.id, states: over.states ?? [], refAssetIds: over.refAssetIds ?? [] }) as unknown as CharacterRow
}

const STATE_INJURED = '第1场：受伤'

export async function runSelection(checker: Checker) {
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)

  await t('未登记分层行时按扁平数组序作隐式基准，且顺序原样保留', async () => {
    const r = selectEntityRefs(host({ refAssetIds: [310, 305, 320] }), [], {}, 6)
    assert.deepEqual(r.selected.map((x) => x.assetId), [310, 305, 320], `数组序不变，实得 ${JSON.stringify(r.selected.map((x) => x.assetId))}`)
    assert.ok(r.selected.every((x) => x.role === 'base'), '隐式基准全部记为基准角色')
    assert.ok(r.selected.every((x) => x.reason.includes('未分层')), `入选理由标注未分层来源，实得 ${r.selected[0]!.reason}`)
    assert.equal(r.fallbacks.length, 0, '隐式基准是常规路径而非例外，不留回退说明')
  })

  await t('隐式基准超出上限的部分进 dropped 并带上限原因', async () => {
    const r = selectEntityRefs(host({ refAssetIds: [1, 2, 3] }), [], {}, 2)
    assert.deepEqual(r.selected.map((x) => x.assetId), [1, 2], '上限内取前两张')
    assert.equal(r.dropped.length, 1, `超额一张进 dropped，实得 ${r.dropped.length}`)
    assert.equal(r.dropped[0]!.assetId, 3, '被裁的是数组末位')
    assert.ok(r.dropped[0]!.reason.includes('超出参考图上限(2)'), `裁剪原因带上限数值，实得 ${r.dropped[0]!.reason}`)
  })

  await t('状态命中优先：命中条目原文进理由，状态行排在基准与视角之前', async () => {
    const r = selectEntityRefs(
      host({ states: [STATE_INJURED, '第2场：疲惫'], refAssetIds: [900] }),
      [ref({ assetId: 401, role: 'base' }), ref({ assetId: 402, role: 'state', stateKey: STATE_INJURED }), ref({ assetId: 403, role: 'view', viewKey: '背面' })],
      { scene: 1 },
      6,
    )
    assert.equal(r.selected[0]!.role, 'state', `首元素是状态行，实得 ${r.selected[0]!.role}`)
    assert.equal(r.selected[0]!.assetId, 402, '命中的状态参考在最前')
    assert.ok(r.selected[0]!.reason.includes(STATE_INJURED), `理由含命中条目原文，实得 ${r.selected[0]!.reason}`)
    assert.deepEqual(r.selected.slice(1).map((x) => x.assetId), [401, 403], `状态之后基准、视角按层序，实得 ${JSON.stringify(r.selected.slice(1).map((x) => x.assetId))}`)
    assert.equal(r.fallbacks.length, 0, '命中且有参考时不留回退说明')
  })

  await t('命中状态但无对应状态分层行 → 回退基准并在 fallbacks 留痕', async () => {
    const r = selectEntityRefs(
      host({ states: [STATE_INJURED], refAssetIds: [900] }),
      [ref({ assetId: 401, role: 'base' }), ref({ assetId: 403, role: 'view', viewKey: '正面' })],
      { scene: 1 },
      6,
    )
    assert.equal(r.fallbacks.length, 1, `留一条回退说明，实得 ${r.fallbacks.length}`)
    assert.ok(r.fallbacks[0]!.includes('回退基准'), `说明含「回退基准」，实得 ${r.fallbacks[0]}`)
    assert.ok(r.fallbacks[0]!.includes(STATE_INJURED), '说明指名是哪个状态缺参考')
    assert.deepEqual(r.selected.map((x) => x.assetId), [401, 403], '取用集只含基准与视角')
    assert.ok(r.selected.every((x) => x.role === 'base' || x.role === 'view'), '回退后不冒充状态参考')
  })

  await t('多条状态条目同时命中 → 取数组末条（数组序即时间序，后覆盖前）', async () => {
    // 状态条目须为「节点：短语」形态才会命中（无冒号的条目短语为空，按选择不参与命中处理）
    const r = selectEntityRefs(
      host({ states: ['眼伤：流血', '脸伤：肿胀'], refAssetIds: [900] }),
      [ref({ assetId: 501, role: 'state', stateKey: '眼伤：流血' }), ref({ assetId: 502, role: 'state', stateKey: '脸伤：肿胀' }), ref({ assetId: 503, role: 'base' })],
      { text: '本镜画面：眼伤与脸伤同时出现' },
      6,
    )
    assert.equal(r.selected[0]!.assetId, 502, `末条命中的参考在前，实得 ${r.selected[0]!.assetId}`)
    assert.ok(r.selected[0]!.reason.includes('脸伤'), `理由指向末条，实得 ${r.selected[0]!.reason}`)
    assert.ok(!r.selected.some((x) => x.assetId === 501), '先出现的条目不当命中')
  })

  await t('停用行不参与选择；上限为零时候选全部进裁剪', async () => {
    const off = selectEntityRefs(
      host({ refAssetIds: [900] }),
      [ref({ assetId: 601, role: 'base' }), ref({ assetId: 602, role: 'base', enabled: 0 })],
      {},
      6,
    )
    assert.deepEqual(off.selected.map((x) => x.assetId), [601], '停用行既不入选也不留痕')
    // 零上限专项夹具不带扁平回退候选（扁平列在零上限时同样进裁剪，属另一档行为，形态七里另有断言），
    // 这里把裁剪集合精确锁在该实体的两条启用分层行上。
    const zero = selectEntityRefs(host({ refAssetIds: [] }), [ref({ assetId: 603, role: 'base' }), ref({ assetId: 604, role: 'view' })], {}, 0)
    assert.equal(zero.selected.length, 0, '零上限不入选任何参考')
    assert.equal(zero.dropped.length, 2, `候选全部转裁剪，实得 ${zero.dropped.length}`)
    assert.ok(zero.dropped.every((d) => d.reason.includes('超出参考图上限(0)')), '裁剪原因写明实际生效上限为 0')
  })

  await t('同资产重复登记只占一个名额', async () => {
    const r = selectEntityRefs(host({ refAssetIds: [900] }), [ref({ assetId: 700, role: 'base' }), ref({ assetId: 700, role: 'view' })], {}, 6)
    assert.equal(r.selected.length, 1, `重复资产去重，实得 ${r.selected.length}`)
    assert.equal(r.dropped.length, 0, '重复项不算超额裁剪')
  })

  await t('画布直通参考前插入实体锚定参考之前', async () => {
    const indexes = { characters: new Map<string, CharacterRow>([['角色甲', indexRow({ id: 1, name: '角色甲', refAssetIds: [801] })]]), scenes: new Map(), props: new Map() }
    const shot: RefShot = { id: 's1', characters: ['角色甲'], ref_asset_ids: [111, 112] }
    const sel = collectRefSelection(shot, indexes)
    assert.deepEqual(sel.ids.slice(0, 2), [111, 112], `直通参考在最前，实得 ${JSON.stringify(sel.ids)}`)
    assert.equal(sel.ids[2], 801, '实体锚定参考接在直通之后')
  })

  await t('跨角色共享四张名额：前一角色占满时后一角色整体进裁剪', async () => {
    const indexes = {
      characters: new Map<string, CharacterRow>([
        ['甲', indexRow({ id: 1, name: '甲', refAssetIds: [11, 12, 13, 14] })],
        ['乙', indexRow({ id: 2, name: '乙', refAssetIds: [21, 22] })],
      ]),
      scenes: new Map(),
      props: new Map(),
    }
    const sel = collectRefSelection({ id: 's1', characters: ['甲', '乙'] }, indexes)
    assert.equal(MAX_CHARACTER_REFS_PER_SHOT, 4, '角色参考上限为四张')
    assert.deepEqual(sel.ids, [11, 12, 13, 14], `前四张归出场靠前的角色，实得 ${JSON.stringify(sel.ids)}`)
    assert.equal(sel.dropped.length, 2, `后一角色两张候选全部裁剪，实得 ${sel.dropped.length}`)
    assert.ok(sel.dropped.every((d) => d.reason.includes('超出角色参考图上限(4)')), `裁剪原因按实际生效上限区分，实得 ${sel.dropped[0]?.reason}`)
  })

  await t('总量上限六张：角色段封顶四张后由场景与道具补满', async () => {
    const indexes = {
      characters: new Map<string, CharacterRow>([['甲', indexRow({ id: 1, name: '甲', refAssetIds: [11, 12, 13, 14, 15, 16] })]]),
      scenes: new Map<string, CharacterRow>([['客厅', indexRow({ id: 2, name: '客厅', refAssetIds: [31] })]]),
      props: new Map<string, CharacterRow>([['油灯', indexRow({ id: 3, name: '油灯', refAssetIds: [41] })]]),
    }
    const sel = collectRefSelection({ id: 's1', characters: ['甲'], location: '客厅', props: ['油灯'] }, indexes)
    assert.equal(MAX_REFS_PER_SHOT, 6, '单镜总量上限六张')
    assert.equal(MAX_CHARACTER_REFS_PER_SHOT, 4, '角色段共享上限四张')
    assert.equal(sel.ids.length, 6, `总量受六张约束，实得 ${sel.ids.length}`)
    assert.deepEqual(sel.ids, [11, 12, 13, 14, 31, 41], `前四张归角色段、第五张场景、第六张道具；角色段多出的两张被裁，实得 ${JSON.stringify(sel.ids)}`)
    assert.equal(sel.dropped.length, 2, `角色段超上限的两张进裁剪，实得 ${sel.dropped.length}`)
    assert.deepEqual(sel.dropped.map((d) => d.assetId), [15, 16], `被裁的是扁平列超上限的第 5、6 张，实得 ${JSON.stringify(sel.dropped.map((d) => d.assetId))}`)
    assert.ok(sel.dropped.every((d) => d.reason.includes('超出参考图上限(4)')), `裁剪原因带上本段实际生效的四张上限，实得 ${JSON.stringify(sel.dropped.map((d) => d.reason))}`)
  })

  await t('薄封装与主函数的参考集合逐元素相等（同一真源）', async () => {
    const indexes = {
      characters: new Map<string, CharacterRow>([
        ['甲', indexRow({ id: 1, name: '甲', states: [STATE_INJURED], refAssetIds: [11, 12] })],
        ['乙', indexRow({ id: 2, name: '乙', refAssetIds: [21] })],
      ]),
      scenes: new Map<string, CharacterRow>([['客厅', indexRow({ id: 3, name: '客厅', refAssetIds: [31] })]]),
      props: new Map<string, CharacterRow>([['油灯', indexRow({ id: 4, name: '油灯', refAssetIds: [41] })]]),
    }
    const refIndex = new Map<number, EntityRefRow[]>([
      [1, [ref({ entityId: 1, assetId: 12, role: 'state', stateKey: STATE_INJURED }), ref({ entityId: 1, assetId: 11, role: 'base' })]],
    ])
    const shot: RefShot = { id: 's1', characters: ['甲', '乙'], location: '客厅', props: ['油灯'], scene: 1 }
    const ids = collectRefAssetIds(shot, indexes, refIndex, { episode: 1 })
    const sel = collectRefSelection(shot, indexes, refIndex, { episode: 1 })
    assert.deepEqual(ids, sel.ids, `逐元素相等：${JSON.stringify(ids)} vs ${JSON.stringify(sel.ids)}`)
    assert.equal(sel.perEntity[0]!.refs[0]!.assetId, 12, '带分层索引时命中状态行优先')
  })

  // ── 回退形态矩阵（登记了分层行但本镜取不到参考的全部形态）──────────────────

  await t('形态一：仅登记状态行且本镜无状态上下文 → 回退隐式基准首图且留痕', async () => {
    const r = selectEntityRefs(host({ states: [STATE_INJURED], refAssetIds: [101, 102] }), [ref({ role: 'state', stateKey: STATE_INJURED, assetId: 301 })], {}, 1)
    assert.deepEqual(r.selected.map((x) => x.assetId), [101], `回退取扁平首图，实得 ${JSON.stringify(r.selected.map((x) => x.assetId))}`)
    assert.equal(r.fallbacks.length, 1, '留一条回退说明')
    assert.ok(r.fallbacks[0]!.includes('回退基准'), `说明含「回退基准」，实得 ${r.fallbacks[0]}`)
  })

  await t('形态二：仅登记状态行且本镜命中该状态 → 用状态图，不回退', async () => {
    const r = selectEntityRefs(host({ states: [STATE_INJURED], refAssetIds: [101, 102] }), [ref({ role: 'state', stateKey: STATE_INJURED, assetId: 301 })], { scene: 1 }, 4)
    assert.deepEqual(r.selected.map((x) => x.assetId), [301], '命中即用状态图')
    assert.equal(r.fallbacks.length, 0, '有可用参考时不产回退留痕')
  })

  await t('形态三：基准与视角同登但上限一张 → 取基准、视角进裁剪', async () => {
    const r = selectEntityRefs(host({ refAssetIds: [101, 102] }), [ref({ assetId: 401, role: 'base' }), ref({ assetId: 402, role: 'view' })], {}, 1)
    assert.deepEqual(r.selected.map((x) => x.assetId), [401], '上限一张时优先基准')
    assert.deepEqual(r.dropped.map((x) => x.assetId), [402], '超额的视角行进裁剪')
  })

  await t('形态四：分层行全部停用 → 走未分层隐式基准且不产回退留痕', async () => {
    const r = selectEntityRefs(host({ refAssetIds: [101, 102] }), [ref({ enabled: 0, assetId: 501 })], {}, 4)
    assert.deepEqual(r.selected.map((x) => x.assetId), [101, 102], '停用等同未分层')
    assert.equal(r.fallbacks.length, 0, '本就无可用分层，不记回退')
  })

  await t('形态五：状态命中但状态行停用 → 用基准行并记回退说明（不回退扁平列）', async () => {
    const r = selectEntityRefs(
      host({ states: [STATE_INJURED], refAssetIds: [101, 102] }),
      [ref({ role: 'state', stateKey: STATE_INJURED, assetId: 301, enabled: 0 }), ref({ role: 'base', assetId: 401 })],
      { scene: 1 },
      4,
    )
    assert.deepEqual(r.selected.map((x) => x.assetId), [401], '停用状态行被跳过，取启用基准行')
    assert.equal(r.fallbacks.length, 1, `命中状态但启用集里没有该状态行 → 留一条「回退基准」说明，实得 ${JSON.stringify(r.fallbacks)}`)
    assert.ok(r.fallbacks[0]!.includes('回退基准'), `说明含「回退基准」，实得 ${r.fallbacks[0]}`)
    assert.ok(!r.selected.some((x) => x.assetId === 101 || x.assetId === 102), '有启用基准时不回退扁平列')
  })

  await t('形态六：集数定位词命中 → 与场次档同套优先级（集数档独立生效）', async () => {
    const entry = '第2集：黑化'
    const r = selectEntityRefs(host({ states: [entry], refAssetIds: [101, 102] }), [ref({ role: 'state', stateKey: entry, assetId: 301 }), ref({ role: 'base', assetId: 401 })], { episode: 2 }, 4)
    assert.deepEqual(r.selected.map((x) => x.assetId), [301, 401], `集数命中排前，实得 ${JSON.stringify(r.selected.map((x) => x.assetId))}`)
    const miss = selectEntityRefs(host({ states: [entry], refAssetIds: [101, 102] }), [ref({ role: 'state', stateKey: entry, assetId: 301 }), ref({ role: 'base', assetId: 401 })], { episode: 3 }, 4)
    assert.deepEqual(miss.selected.map((x) => x.assetId), [401], '集数不匹配时状态行不入选')
  })

  await t('形态七：分层行存在但本镜零可取（既无状态命中又无基准视角行）→ 回退基准，登记过的参考绝不静默归零', async () => {
    const r = selectEntityRefs(host({ refAssetIds: [101, 102] }), [ref({ assetId: 909, role: 'state', stateKey: '不存在的状态' })], {}, 4)
    assert.ok(r.selected.length > 0, '有分层行但取不到时仍要有参考')
    assert.ok(r.fallbacks.some((x) => x.includes('回退基准参考图')), `留痕说明回退来源，实得 ${JSON.stringify(r.fallbacks)}`)
    assert.deepEqual(r.selected.map((x) => x.assetId), [101, 102], '回退集等于扁平历史参考')
  })

  // ── 模型能力收紧总量（totalLimit 进选择层）：快照口径与裁剪归因 ──────────────

  await t('模型上限收紧：被总量挤掉的候选按「超出模型参考图上限」归类，入列集合恰为实发集合', async () => {
    // 画布直通先占一张，让角色段的「总量剩余」严格小于「角色共享上限」——只有这时裁剪才是被模型总限掐掉的，
    // 原因才应换成模型上限口径（本段自身上限没到）。缺省总量（六）下同样的候选挤满的是角色段四张上限，口径不同。
    const indexes = {
      characters: new Map<string, CharacterRow>([['甲', indexRow({ id: 1, name: '甲' })]]),
      scenes: new Map<string, CharacterRow>(),
      props: new Map<string, CharacterRow>(),
    }
    const refIndex = new Map<number, EntityRefRow[]>([
      [1, [ref({ entityId: 1, assetId: 11 }), ref({ entityId: 1, assetId: 12 }), ref({ entityId: 1, assetId: 13 }), ref({ entityId: 1, assetId: 14 }), ref({ entityId: 1, assetId: 15 })]],
    ])
    const shot: RefShot = { id: 's1', characters: ['甲'], ref_asset_ids: [999] }
    const sel = collectRefSelection(shot, indexes, refIndex, {}, 4)
    assert.equal(sel.ids.length, 4, `入列集合被模型上限掐死在四张，实得 ${JSON.stringify(sel.ids)}`)
    assert.ok(sel.ids.includes(999), '画布直通那张仍在实发集合')
    assert.deepEqual(sel.dropped.map((d) => d.assetId).sort((a, b) => a - b), [14, 15], `超模型上限的两张进裁剪，实得 ${JSON.stringify(sel.dropped.map((d) => d.assetId))}`)
    assert.ok(sel.dropped.every((d) => d.reason.includes('超出模型参考图上限(4)')), `裁剪原因按模型上限归类，实得 ${JSON.stringify(sel.dropped.map((d) => d.reason))}`)
    const picked = sel.perEntity.flatMap((ent) => ent.refs.map((r) => r.assetId))
    assert.ok(picked.every((assetId) => sel.ids.includes(assetId)), `逐实体选择结果每项都在实发集合里（refSelection ⊆ 实发），实得 ${JSON.stringify(picked)} vs ${JSON.stringify(sel.ids)}`)
  })

  await t('缺省总量不冒充能力降级：同样候选在下限六张时按本段上限归类', async () => {
    const indexes = {
      characters: new Map<string, CharacterRow>([['甲', indexRow({ id: 1, name: '甲' })]]),
      scenes: new Map<string, CharacterRow>(),
      props: new Map<string, CharacterRow>(),
    }
    const refIndex = new Map<number, EntityRefRow[]>([
      [1, [ref({ entityId: 1, assetId: 11 }), ref({ entityId: 1, assetId: 12 }), ref({ entityId: 1, assetId: 13 }), ref({ entityId: 1, assetId: 14 }), ref({ entityId: 1, assetId: 15 })]],
    ])
    const shot: RefShot = { id: 's1', characters: ['甲'], ref_asset_ids: [999] }
    const sel = collectRefSelection(shot, indexes, refIndex, {})
    assert.equal(sel.ids.length, 5, `缺省总量六时角色封顶四张、加直通一张共五张，实得 ${JSON.stringify(sel.ids)}`)
    assert.ok(sel.dropped.every((d) => !d.reason.includes('超出模型参考图上限')), `未被模型收紧时不得谎称能力降级，实得 ${JSON.stringify(sel.dropped.map((d) => d.reason))}`)
    assert.ok(sel.dropped.some((d) => d.reason.includes('超出角色参考图上限(4)') || d.reason.includes('超出参考图上限(4)')), `裁剪原因归本段自身上限，实得 ${JSON.stringify(sel.dropped.map((d) => d.reason))}`)
  })

  await t('回退留痕经选择层外抛（供入参快照记「为何用基准而非状态图」）', async () => {
    const indexes = {
      characters: new Map<string, CharacterRow>([['甲', indexRow({ id: 1, name: '甲', states: [STATE_INJURED], refAssetIds: [900] })]]),
      scenes: new Map<string, CharacterRow>(),
      props: new Map<string, CharacterRow>(),
    }
    // 命中状态但实体只登记了基准行、没有该状态的分层行 → 该状态档回退基准，留一条「无分层参考，回退基准」
    const refIndex = new Map<number, EntityRefRow[]>([[1, [ref({ entityId: 1, assetId: 401, role: 'base' })]]])
    const sel = collectRefSelection({ id: 's1', characters: ['甲'], scene: 1 }, indexes, refIndex, { episode: 1 })
    assert.equal(sel.fallbacks.length, 1, `回退说明随选择结果外抛一条，实得 ${JSON.stringify(sel.fallbacks)}`)
    assert.ok(sel.fallbacks[0]!.includes(STATE_INJURED) && sel.fallbacks[0]!.includes('回退基准'), `说明指名回退来源状态，实得 ${sel.fallbacks[0]}`)
    assert.ok(sel.ids.includes(401), '基准行仍入列，回退不丢参考')
  })
}
