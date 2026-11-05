/**
 * 分层登记服务节（真实库、真实服务函数，不经过端点）。
 *
 * 覆盖：登记→清单→局部更新→删除的完整闭环与每步后的派生列次序；状态键校验、重复冲突、宿主缺失三类错误；
 * 历史扁平参考固化的先后次序（一次登记只允许「一次回写 + 一条实体版本」，失败路径分毫未写）；
 * 启用集索引只含启用行；逐实体预览纯读不改库。
 */
import assert from 'node:assert/strict'
import type { Checker } from '../../probe-lib'
import { initDatabase, newImageAsset, newTextAsset } from './bootstrap'
import { call, count, flatRefIds, recomputeRefIds, rowsOf, test } from './helpers'

/** 该实体由派生同步写入的实体版本条数（每写一次库记一条；中途失真会多出一条幽灵版本） */
async function recalcVersionCount(entityId: number): Promise<number> {
  const rows = await rowsOf<{ n: number }>('SELECT COUNT(*) AS n FROM content_versions WHERE obj_kind = ? AND obj_id = ? AND label = ?', ['entity', entityId, '参考分层重算'])
  return Number(rows[0]?.n ?? 0)
}

/** 指定文案的实体版本条数（挂接路径按「参考图挂接 +N」记版，与派生重算文案区分） */
async function attachVersionCount(entityId: number, label: string): Promise<number> {
  const rows = await rowsOf<{ n: number }>('SELECT COUNT(*) AS n FROM content_versions WHERE obj_kind = ? AND obj_id = ? AND label = ?', ['entity', entityId, label])
  return Number(rows[0]?.n ?? 0)
}

/** 领域错误的读法：抛出的值先经 instanceof 判定，再按状态码与文案取值比对（避免把类当类型用） */
function domainError(err: unknown): { status: number; message: string } {
  const e = err as { status?: unknown; message?: unknown }
  return { status: Number(e?.status ?? 0), message: String(e?.message ?? '') }
}

async function newProjectAndEntity(name: string, states: string[], flatRefs: number[]): Promise<number> {
  const proj = await call('POST', '/projects', { name: `分层服务-${name}` })
  assert.equal(proj.status, 201, `项目创建失败 ${proj.status} ${proj.body}`)
  const projectId = proj.data.project.id as number
  const { upsertEntity } = await import('../../../src/services/character')
  const ent = await upsertEntity({ projectId, kind: 'character', name, appearance: '圆脸大眼', states, refAssetIds: flatRefs })
  return ent.id
}

export async function runService(checker: Checker) {
  await initDatabase()
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)
  const STATE_INJURED = '第3场：淋雨'

  const {
    addEntityRef,
    backfillEntityRefs,
    hasEntityRefRows,
    listEntityRefs,
    loadRefIndex,
    patchEntityRef,
    previewEntitySelection,
    removeEntityRef,
    EntityRefError,
  } = await import('../../../src/services/entity-references')

  // 完整闭环用显式步骤展开，保证每步后都读回派生列
  await t('闭环：首次登记把历史扁平参考固化为基准行并整体回写', async () => {
    const entityId = await newProjectAndEntity('闭环主角', [STATE_INJURED], [])
    const projectId = await projectIdOfEntity(entityId)
    const h1 = await newImageAsset(projectId, '闭环历史一')
    const h2 = await newImageAsset(projectId, '闭环历史二')
    const { attachRefAssetsById } = await import('../../../src/services/character')
    await attachRefAssetsById(entityId, [h1, h2], 'edit', projectId)
    const flat0 = await flatRefIds(entityId)
    assert.deepEqual(flat0, [h1, h2], `前置扁平列 [历史一,历史二]，实得 ${JSON.stringify(flat0)}`)
    assert.equal((await listEntityRefs(entityId)).length, 0, '前置：尚无分层行')

    const state = await newImageAsset(projectId, '闭环状态')
    const row = await addEntityRef({ entityId, assetId: state, role: 'state', stateKey: STATE_INJURED })
    assert.equal(row.role, 'state', '新登记行角色为状态')
    const rows = await listEntityRefs(entityId)
    assert.equal(rows.length, 3, `历史两张被固化 + 本次一张，共三行，实得 ${rows.length}`)
    const byAsset = new Map(rows.map((r) => [r.assetId, r]))
    assert.equal(byAsset.get(h1)!.role, 'base', '历史一固化为基准')
    assert.equal(byAsset.get(h2)!.role, 'base', '历史二固化为基准')
    assert.equal(byAsset.get(state)!.role, 'state', '本次登记保留用户选的角色（不被覆盖成基准）')
    assert.deepEqual(await flatRefIds(entityId), [h1, h2, state], `派生列 = 基准层在前 + 状态层在后，实得 ${JSON.stringify(await flatRefIds(entityId))}`)
    assert.equal(await recalcVersionCount(entityId), 1, `一次登记只回写一次并记一条版本，实得 ${await recalcVersionCount(entityId)} 条`)

    // 局部更新：改角色（状态→视角）后派生列次序随层序变化；仅改角色不清旧键（清空须显式传 null）
    const view = await patchEntityRef(row.id, { role: 'view', viewKey: '背面' })
    assert.equal(view.role, 'view', '角色改为视角')
    assert.equal(view.stateKey, STATE_INJURED, '仅切换角色不清空状态键（保留原值，视角角色下该键不参与选择）')
    assert.deepEqual(await flatRefIds(entityId), [h1, h2, state], '视角层仍排在基准之后，列值集合不变')

    // 启停：停用即从派生列剔除
    const off = await patchEntityRef(row.id, { enabled: false })
    assert.equal(off.enabled, false, '停用回显布尔假')
    assert.deepEqual(await flatRefIds(entityId), [h1, h2], `停用后派生列剔除该行，实得 ${JSON.stringify(await flatRefIds(entityId))}`)
    const restored = await patchEntityRef(row.id, { enabled: true })
    assert.equal(restored.enabled, true, '恢复启用回显布尔真')
    assert.deepEqual(await flatRefIds(entityId), [h1, h2, state], '恢复后派生列回到停用前集合')

    // 删除：行消失且派生列同步
    await removeEntityRef(row.id)
    assert.equal((await listEntityRefs(entityId)).length, 2, '删除后只剩两张基准行')
    assert.deepEqual(await flatRefIds(entityId), [h1, h2], '删除后派生列同步剔除')
  })

  await t('状态键不属于该实体状态集 → 领域错误四百并带可核对候选', async () => {
    const entityId = await newProjectAndEntity('校验主角', [STATE_INJURED], [])
    const projectId = await projectIdOfEntity(entityId)
    const asset = await newImageAsset(projectId, '校验新参考')
    const err = await addEntityRef({ entityId, assetId: asset, role: 'state', stateKey: '第9场：不存在的状态' }).catch((e: unknown) => e)
    assert.ok(err instanceof EntityRefError, `抛领域错误，实得 ${String(err)}`)
    const got = domainError(err)
    assert.equal(got.status, 400, '状态语义为请求非法')
    assert.ok(got.message.includes('需精确匹配实体 states 中的某条目'), `文案直述校验规则，实得 ${got.message}`)
    assert.ok(got.message.includes(STATE_INJURED), '错误文案带可核对的候选清单')
  })

  await t('状态角色缺状态键 → 四百且文案原文固定', async () => {
    const entityId = await newProjectAndEntity('缺键主角', ['日常', STATE_INJURED], [])
    const projectId = await projectIdOfEntity(entityId)
    const asset = await newImageAsset(projectId, '缺键参考')
    const err = await addEntityRef({ entityId, assetId: asset, role: 'state' }).catch((e: unknown) => e)
    assert.ok(err instanceof EntityRefError && err.status === 400, '缺键按请求非法处理')
    assert.equal(domainError(err).message, 'role=state 必须提供非空 stateKey', `文案逐字对齐，实得 ${domainError(err).message}`)
  })

  await t('同实体同资产重复登记 → 冲突四百零九，且行数与派生列分毫未动', async () => {
    const entityId = await newProjectAndEntity('冲突主角', [STATE_INJURED], [])
    const projectId = await projectIdOfEntity(entityId)
    const a1 = await newImageAsset(projectId, '冲突参考一')
    const a2 = await newImageAsset(projectId, '冲突参考二')
    await addEntityRef({ entityId, assetId: a1, role: 'base' })
    await addEntityRef({ entityId, assetId: a2, role: 'base' })
    const rowsBefore = (await listEntityRefs(entityId)).length
    const flatBefore = await flatRefIds(entityId)
    const versionsBefore = await recalcVersionCount(entityId)
    const err = await addEntityRef({ entityId, assetId: a1, role: 'state', stateKey: STATE_INJURED }).catch((e: unknown) => e)
    assert.ok(err instanceof EntityRefError, '冲突抛领域错误')
    const got = domainError(err)
    assert.equal(got.status, 409, `状态码四百零九，实得 ${got.status}`)
    assert.ok(got.message.includes('同实体同资产唯一'), `文案直述唯一约束，实得 ${got.message}`)
    assert.equal((await listEntityRefs(entityId)).length, rowsBefore, '冲突后行数不变')
    assert.deepEqual(await flatRefIds(entityId), flatBefore, '冲突后派生列不变')
    assert.equal(await recalcVersionCount(entityId), versionsBefore, '冲突不产生额外实体版本')
  })

  await t('宿主实体不存在 → 四百零四（清单/新增/回填/预览四类入口同款）', async () => {
    const missing = 9_999_999
    for (const [label, fn] of [
      ['清单', () => listEntityRefs(missing)],
      ['新增', () => addEntityRef({ entityId: missing, assetId: 1, role: 'base' })],
      ['回填', () => backfillEntityRefs(missing)],
      ['预览', () => previewEntitySelection(missing, {})],
    ] as Array<[string, () => Promise<unknown>]>) {
      const err = await fn().catch((e: unknown) => e)
      assert.ok(err instanceof EntityRefError && err.status === 404, `${label}入口按宿主缺失处理，实得 ${String(err)}`)
    }
    const patchErr = await patchEntityRef(missing, { enabled: false }).catch((e: unknown) => e)
    assert.ok(patchErr instanceof EntityRefError && patchErr.status === 404, '局部更新的行缺失同款四百零四')
    const removeErr = await removeEntityRef(missing).catch((e: unknown) => e)
    assert.ok(removeErr instanceof EntityRefError && removeErr.status === 404, '删除的行缺失同款四百零四')
  })

  await t('非图片资产不可登记为参考图 → 四百并指名资产类型', async () => {
    const entityId = await newProjectAndEntity('类型主角', [], [])
    const projectId = await projectIdOfEntity(entityId)
    const textAsset = await newTextAsset(projectId, '文本素材')
    const err = await addEntityRef({ entityId, assetId: textAsset, role: 'base' }).catch((e: unknown) => e)
    assert.ok(err instanceof EntityRefError && err.status === 400, `文本资产按请求非法拒绝，实得 ${String(err)}`)
    assert.ok((err as Error).message.includes('非图片'), `文案直述类型不符，实得 ${(err as Error).message}`)
    assert.equal((await listEntityRefs(entityId)).length, 0, '拒绝后一行未建')
  })

  await t('跨项目资产不可登记（归属兼容校验）→ 四百', async () => {
    const entityId = await newProjectAndEntity('归属主角', [], [])
    const foreign = await newProjectAndEntity('邻项目', [], [])
    const foreignProject = await projectIdOfEntity(foreign)
    const foreignAsset = await newImageAsset(foreignProject, '邻项目参考')
    const err = await addEntityRef({ entityId, assetId: foreignAsset, role: 'base' }).catch((e: unknown) => e)
    assert.ok(err instanceof EntityRefError && err.status === 400, `跨项目资产按请求非法拒绝，实得 ${String(err)}`)
    assert.ok((err as Error).message.includes('下游出图无法解析'), '文案直述拒绝理由（下游取不到该资产）')
    assert.equal((await listEntityRefs(entityId)).length, 0, '拒绝后一行未建')
  })

  await t('历史扁平参考回填幂等：第二次零新增，回填行一律为基准角色', async () => {
    const entityId = await newProjectAndEntity('回填主角', [], [])
    const projectId = await projectIdOfEntity(entityId)
    const r1 = await newImageAsset(projectId, '回填参考一')
    const r2 = await newImageAsset(projectId, '回填参考二')
    const { attachRefAssetsById } = await import('../../../src/services/character')
    await attachRefAssetsById(entityId, [r1, r2], 'edit', projectId)
    const first = await backfillEntityRefs(entityId)
    assert.equal(first.added, 2, `首次回填补出两行，实得 ${first.added}`)
    const rows = await listEntityRefs(entityId)
    assert.ok(rows.every((r) => r.role === 'base'), '回填行一律为基准角色')
    assert.ok(rows.every((r) => (r.note ?? '').includes('历史参考图回填')), `回填行带来源注记，实得 ${rows[0]?.note}`)
    const second = await backfillEntityRefs(entityId)
    assert.equal(second.added, 0, `再次回填零新增，实得 ${second.added}`)
    assert.equal((await listEntityRefs(entityId)).length, rows.length, '零新增回填不增行')
  })

  await t('启用集索引只含启用行（停用行不出现在出图取用面）', async () => {
    const entityId = await newProjectAndEntity('索引主角', [], [])
    const projectId = await projectIdOfEntity(entityId)
    const on1 = await newImageAsset(projectId, '索引启用一')
    const on2 = await newImageAsset(projectId, '索引启用二')
    const off = await newImageAsset(projectId, '索引停用')
    await addEntityRef({ entityId, assetId: on1, role: 'base' })
    await addEntityRef({ entityId, assetId: on2, role: 'base' })
    const offRow = await addEntityRef({ entityId, assetId: off, role: 'view', viewKey: '侧面' })
    await patchEntityRef(offRow.id, { enabled: false })
    const index = await loadRefIndex([entityId])
    const listed = index.get(entityId) ?? []
    assert.equal(listed.length, 2, `只载入两行启用，实得 ${listed.length}`)
    assert.ok(listed.every((r) => r.enabled === 1), '索引行的启用位恒为一')
    assert.ok(!listed.some((r) => r.assetId === off), '停用资产不出现在索引里')
    const empty = await loadRefIndex([])
    assert.equal(empty.size, 0, '空入参不发查询，返回空索引')
  })

  await t('逐实体预览纯读：前后派生列逐字节相等、行数与版本数不变', async () => {
    const entityId = await newProjectAndEntity('预览主角', [STATE_INJURED], [])
    const projectId = await projectIdOfEntity(entityId)
    const b = await newImageAsset(projectId, '预览基准')
    const s = await newImageAsset(projectId, '预览状态')
    await addEntityRef({ entityId, assetId: b, role: 'base' })
    await addEntityRef({ entityId, assetId: s, role: 'state', stateKey: STATE_INJURED })

    const flatJson = async (): Promise<string> => String((await rowsOf<{ v: string }>('SELECT ref_asset_ids AS v FROM characters WHERE id = ?', [entityId]))[0]?.v)
    const versionsBefore = await count('SELECT COUNT(*) AS n FROM content_versions')
    const refsBefore = JSON.stringify((await listEntityRefs(entityId)).map((r) => [r.id, r.role, r.enabled]))
    const flatBefore = await flatJson()

    const hit = await previewEntitySelection(entityId, { scene: 3, text: '第3场 淋雨' })
    assert.equal(hit.selected[0]!.assetId, s, '带状态上下文时预览把状态参考排前')
    const miss = await previewEntitySelection(entityId, { scene: 8 })
    assert.equal(miss.selected[0]!.role, 'base', `本镜无状态命中时首位是基准层，实得 ${JSON.stringify(miss.selected[0])}`)
    assert.equal(miss.selected[0]!.assetId, b, `无命中时取基准资产，实得 ${miss.selected[0]!.assetId}`)
    assert.deepEqual(miss.fallbacks, [], `基准直取不构成回退，实得 ${JSON.stringify(miss.fallbacks)}`)

    assert.equal(await flatJson(), flatBefore, '预览后派生列逐字节不变')
    assert.equal(JSON.stringify((await listEntityRefs(entityId)).map((r) => [r.id, r.role, r.enabled])), refsBefore, '预览不改分层表任何行')
    assert.equal(await count('SELECT COUNT(*) AS n FROM content_versions'), versionsBefore, '预览不写实体版本链')
  })

  // ── 固化：登记与历史扁平固化的先后次序（一次登记一次回写一条版本）────────────

  await t('次序：把已在历史扁平列里的参考改角色 → 成功、全集入列、只回写一次', async () => {
    const entityId = await newProjectAndEntity('次序主角甲', [STATE_INJURED], [])
    const projectId = await projectIdOfEntity(entityId)
    const a = await newImageAsset(projectId, '次序A')
    const b = await newImageAsset(projectId, '次序B')
    const c = await newImageAsset(projectId, '次序C')
    const { attachRefAssetsById } = await import('../../../src/services/character')
    await attachRefAssetsById(entityId, [a, b, c], 'edit', projectId)
    assert.equal((await listEntityRefs(entityId)).length, 0, '前置：该实体尚无分层登记行')
    const row = await addEntityRef({ entityId, assetId: b, role: 'state', stateKey: STATE_INJURED })
    assert.equal(row.role, 'state', `历史扁平资产改角色成功（未被抢先占成基准行），实得角色 ${row.role}`)
    const rows = await listEntityRefs(entityId)
    assert.equal(rows.length, 3, `分层行共三行（历史两张固化 + 本次一张），实得 ${rows.length}`)
    const byAsset = new Map(rows.map((r) => [r.assetId, r.role]))
    assert.equal(byAsset.get(a), 'base', '历史一为基准')
    assert.equal(byAsset.get(c), 'base', '历史二为基准')
    assert.equal(byAsset.get(b), 'state', '本次登记保留状态角色')
    assert.deepEqual(await flatRefIds(entityId), [a, c, b], `派生列 = [历史一,历史二,状态]（基准层按行序在前、状态层在后），实得 ${JSON.stringify(await flatRefIds(entityId))}`)
    assert.equal(await recalcVersionCount(entityId), 1, `一次登记只记一条实体版本，实得 ${await recalcVersionCount(entityId)} 条`)
  })

  await t('次序：全新资产登记后历史项仍全部固化且只回写一次', async () => {
    const entityId = await newProjectAndEntity('次序主角乙', [STATE_INJURED], [])
    const projectId = await projectIdOfEntity(entityId)
    const a = await newImageAsset(projectId, '次序乙A')
    const b = await newImageAsset(projectId, '次序乙B')
    const c = await newImageAsset(projectId, '次序乙C')
    const d = await newImageAsset(projectId, '次序乙D')
    const { attachRefAssetsById } = await import('../../../src/services/character')
    await attachRefAssetsById(entityId, [a, b, c], 'edit', projectId)
    await addEntityRef({ entityId, assetId: d, role: 'view', viewKey: '背面' })
    assert.deepEqual(await flatRefIds(entityId), [a, b, c, d], `派生列含全部四张，实得 ${JSON.stringify(await flatRefIds(entityId))}`)
    assert.equal((await listEntityRefs(entityId)).length, 4, '共四行登记')
    assert.equal(await recalcVersionCount(entityId), 1, '仅一条实体版本（无中途失真）')
  })

  await t('次序：校验失败不建行、不改列、不记版本（回填不得先于写入发生）', async () => {
    const entityId = await newProjectAndEntity('次序主角丙', [STATE_INJURED], [])
    const projectId = await projectIdOfEntity(entityId)
    const history = await newImageAsset(projectId, '次序丙历史')
    const fresh = await newImageAsset(projectId, '次序丙新登记')
    const { attachRefAssetsById } = await import('../../../src/services/character')
    await attachRefAssetsById(entityId, [history], 'edit', projectId)
    const err = await addEntityRef({ entityId, assetId: fresh, role: 'state', stateKey: '第9场：不存在的状态' }).catch((e: unknown) => e)
    assert.ok(err instanceof EntityRefError && err.status === 400, `状态键不命中按请求非法，实得 ${String(err)}`)
    assert.equal((await listEntityRefs(entityId)).length, 0, '校验失败后一行未建')
    assert.deepEqual(await flatRefIds(entityId), [history], `校验失败后扁平列原样，实得 ${JSON.stringify(await flatRefIds(entityId))}`)
    assert.equal(await recalcVersionCount(entityId), 0, '校验失败后零实体版本')
  })

  await t('次序：无历史扁平列的实体登记 → 一行一版，派生列只含本次项', async () => {
    const entityId = await newProjectAndEntity('次序主角丁', ['第1场'], [])
    const projectId = await projectIdOfEntity(entityId)
    const only = await newImageAsset(projectId, '次序丁唯一')
    await addEntityRef({ entityId, assetId: only, role: 'base' })
    assert.deepEqual(await flatRefIds(entityId), [only], '派生列只含本次登记的资产')
    assert.equal(await recalcVersionCount(entityId), 1, '一行一版')
    const first = await backfillEntityRefs(entityId)
    const second = await backfillEntityRefs(entityId)
    assert.equal(first.added, 0, `首次回填零新增（登记时已固化），实得 ${first.added}`)
    assert.equal(second.added, 0, `再次回填零新增，实得 ${second.added}`)
    assert.equal((await listEntityRefs(entityId)).length, 1, '零新增回填不写库')
    assert.equal(await recalcVersionCount(entityId), 1, '零新增回填不记版本')
  })

  // ── 挂接入真源（分层实体追加参考必须走分层行，不得直写派生列）──────────────

  await t('已分层实体挂接新参考 → 新项作启用基准行入表并派生回写，不造第二套口径', async () => {
    const entityId = await newProjectAndEntity('挂接主角', [], [])
    const projectId = await projectIdOfEntity(entityId)
    const first = await newImageAsset(projectId, '挂接首登记')
    await addEntityRef({ entityId, assetId: first, role: 'base' })
    assert.ok(await hasEntityRefRows(entityId), '前置：该实体已分层')
    const g1 = await newImageAsset(projectId, '挂接追加一')
    const g2 = await newImageAsset(projectId, '挂接追加二')
    const { attachRefAssetsById } = await import('../../../src/services/character')
    const added = await attachRefAssetsById(entityId, [g1, g2], 'edit', projectId)
    assert.equal(added, 2, `两张未登记资产作为新增返回，实得 ${added}`)
    const rows = await listEntityRefs(entityId)
    assert.equal(rows.length, 3, `三张全部落成基准行，实得 ${rows.length}`)
    const byAsset = new Map(rows.map((r) => [r.assetId, r]))
    for (const id of [g1, g2]) {
      assert.equal(byAsset.get(id)?.role, 'base', '挂接进来的资产落成启用基准行（非状态/视角）')
      assert.equal(byAsset.get(id)?.enabled, true, '挂接行默认启用，参与出图取用')
    }
    assert.deepEqual(await flatRefIds(entityId), await recomputeRefIds(entityId), '派生列等于启用行重算结果（与登记同一真源）')
    assert.equal(await attachVersionCount(entityId, '参考图挂接 +2'), 1, `挂接记一条「+2」实体版本，实得 ${await attachVersionCount(entityId, '参考图挂接 +2')} 条`)

    // 重复挂接已登记项：分层真源本就存在 → 零新增、不增行、不记版本
    const again = await attachRefAssetsById(entityId, [g1, g2], 'edit', projectId)
    assert.equal(again, 0, `已登记资产再挂接零新增，实得 ${again}`)
    assert.equal((await listEntityRefs(entityId)).length, 3, '重复挂接不增行')
    assert.equal(await attachVersionCount(entityId, '参考图挂接 +2'), 1, '零新增不追加挂接版本')
  })

  await t('未分层实体挂接 → 逐字写扁平列且不建任何分层行（与旧行为等价）', async () => {
    const entityId = await newProjectAndEntity('未分层挂接', [], [])
    const projectId = await projectIdOfEntity(entityId)
    const a = await newImageAsset(projectId, '未分层挂接一')
    const b = await newImageAsset(projectId, '未分层挂接二')
    const { attachRefAssetsById } = await import('../../../src/services/character')
    const added = await attachRefAssetsById(entityId, [a, b], 'edit', projectId)
    assert.equal(added, 2, `未分层并集两张，实得 ${added}`)
    assert.deepEqual(await flatRefIds(entityId), [a, b], '扁平列逐字写入两张')
    assert.equal((await listEntityRefs(entityId)).length, 0, '未分层实体挂接不产生任何分层行')
    assert.ok(!(await hasEntityRefRows(entityId)), '该实体仍处未分层态')
    assert.equal(await attachVersionCount(entityId, '参考图挂接 +2'), 1, '未分层路径同样记一条挂接版本')
  })

  await t('跨项目复制分层实体：登记行随副本重映射重建并派生回写（停用意图也带过去）', async () => {
    const { db } = await import('../../../src/db')
    const { canvases, canvasNodes } = await import('../../../src/db/schema')
    const { copyNodesToCanvas } = await import('../../../src/services/creation/copy-to')
    const { upsertEntity } = await import('../../../src/services/character')
    const sp = (await call('POST', '/projects', { name: '跨项目复制-源' })).data.project.id as number
    const tp = (await call('POST', '/projects', { name: '跨项目复制-目标' })).data.project.id as number
    // 源分层实体：启用基准两张 + 停用基准一张 + 启用视角一张（停用行是「只带扁平列会丢」的典型）
    const srcEnt = await upsertEntity({ projectId: sp, kind: 'character', name: '复制主角', appearance: '圆脸', states: [], refAssetIds: [] })
    const sb1 = await newImageAsset(sp, '源基准一')
    const sb2 = await newImageAsset(sp, '源基准二')
    const sOff = await newImageAsset(sp, '源停用基准')
    const sv = await newImageAsset(sp, '源视角背面')
    await addEntityRef({ entityId: srcEnt.id, assetId: sb1, role: 'base' })
    await addEntityRef({ entityId: srcEnt.id, assetId: sb2, role: 'base' })
    const offRow = await addEntityRef({ entityId: srcEnt.id, assetId: sOff, role: 'base' })
    await patchEntityRef(offRow.id, { enabled: false })
    await addEntityRef({ entityId: srcEnt.id, assetId: sv, role: 'view', viewKey: '背面' })
    const srcRows = await listEntityRefs(srcEnt.id)
    assert.equal(srcRows.length, 4, `源四行（含一张停用），实得 ${srcRows.length}`)

    const now = Date.now()
    const [srcC] = await db.insert(canvases).values({ projectId: sp, name: '源画布', createdAt: now, updatedAt: now }).returning()
    const [tgtC] = await db.insert(canvases).values({ projectId: tp, name: '目标画布', createdAt: now, updatedAt: now }).returning()
    const [node] = await db
      .insert(canvasNodes)
      .values({ canvasId: srcC!.id, kind: 'entity', title: '角色', assetId: null, spec: JSON.stringify({ entityId: srcEnt.id }), x: 0, y: 0, createdAt: now, updatedAt: now })
      .returning()

    const res = await copyNodesToCanvas(srcC!, tgtC!, [node!.id], { x: 0, y: 0 })
    const dupSpec = JSON.parse(String(res.nodes[0]?.spec)) as { entityId?: number }
    const dupEnt = dupSpec.entityId
    assert.ok(dupEnt && dupEnt !== srcEnt.id, `跨项目复制生成副本实体（非复用源实体），实得 ${JSON.stringify(dupSpec)}`)

    const dupRows = await listEntityRefs(dupEnt!)
    assert.equal(dupRows.length, 4, `副本重建四行分层登记（停用行同样带过去），实得 ${dupRows.length}`)
    const srcAssetSet = new Set(srcRows.map((r) => r.assetId))
    assert.ok(dupRows.every((r) => !srcAssetSet.has(r.assetId)), '副本每行都指向重映射后的新资产，不复用源资产')
    const roleKey = (r: { role: string; stateKey: string | null; viewKey: string | null; enabled: boolean }): string => `${r.role}|${r.stateKey ?? ''}|${r.viewKey ?? ''}|${r.enabled}`
    assert.deepEqual(
      dupRows.map(roleKey).sort(),
      [...srcRows].map(roleKey).sort(),
      `副本分层行的角色/状态键/视角键/启用位多重集与源逐一对应，源 ${JSON.stringify([...srcRows].map(roleKey).sort())} 副本 ${JSON.stringify(dupRows.map(roleKey).sort())}`,
    )

    // 停用行不进派生列：副本扁平列必须等于其启用行重算，且比行数少一张
    const dupRecomputed = await recomputeRefIds(dupEnt!)
    assert.deepEqual(await flatRefIds(dupEnt!), dupRecomputed, '副本扁平列等于其启用分层行重算结果')
    assert.equal(dupRecomputed.length, 3, `三张启用行入派生列（停用那张除外），实得 ${dupRecomputed.length}`)
    const dupAssets = await rowsOf<{ id: number; projectId: number }>(`SELECT id, project_id AS projectId FROM assets WHERE id IN (${dupRows.map((r) => r.assetId).join(',')})`)
    assert.equal(dupAssets.length, 4, `副本四行资产都可解析，实得 ${dupAssets.length}`)
    assert.ok(dupAssets.every((a) => Number(a.projectId) === Number(tp)), '副本分层行引用的资产全部归属目标项目')
  })
}

/** 实体归属项目（跨项目校验与资产落盘都要用真实归属） */
export async function projectIdOfEntity(entityId: number): Promise<number> {
  const { rowsOf } = await import('./helpers')
  const rows = await rowsOf<{ projectId: number }>('SELECT project_id AS projectId FROM characters WHERE id = ?', [entityId])
  const row = rows[0]
  if (!row) throw new Error(`实体 ${entityId} 不存在`)
  return Number(row.projectId)
}
