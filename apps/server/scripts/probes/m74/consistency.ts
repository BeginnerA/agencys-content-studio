/**
 * 逐角色一致性评价节（真实服务 + 真实库 + 桩评分链，零外发）。
 *
 * 覆盖：出镜集合的口径、两条参考路径（分层基准行 / 扁平列回落）与各自的脏数据剔除、抽样上限、
 * 重评幂等覆盖、三态分级与「未评价」info 在末段门禁上的数学、失败说明脱敏（落库/回显/证据三处）、
 * 两条解析降级说明、只读端点零外发与问题计数、评价错误面。
 *
 * 夹具口径：项目/角色/分层行/素材一律经真实端点或真实服务产生；
 * 运行记录与出图任务行是评价的历史输入（无服务形态）由引导文件直建；
 * 「资产被删/漂到邻项目」这类历史脏数据只由一条更新语句造出——真实删除会走级联，造不出这个状态。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Checker } from '../../probe-lib'
import {
  blockedAttempts,
  initDatabase,
  newAppearingSnapshot,
  newImageAsset,
  newRunFixture,
  newTaskFixture,
  newTextAsset,
} from './bootstrap'
import { call, count, rowsOf, test } from './helpers'
import {
  LEAK_KEY,
  LEAK_TOKEN,
  LEAK_URL,
  installStubFetch,
  outboundViolations,
  restoreFetch,
  replyAs,
  replyScore,
  stubCallCount,
} from './llm-stub'

const RESULT_COLS =
  'entity_id AS entityId, episode_idx AS episodeIdx, score, asset_total AS assetTotal, asset_sampled AS assetSampled, ref_count AS refCount, model, provider, note, evaluated_at AS evaluatedAt'

/** 结果表按实体序读回（只读断言，不经被测查询构造器） */
async function results(runId: number): Promise<Array<Record<string, any>>> {
  return await rowsOf<Record<string, any>>(`SELECT ${RESULT_COLS} FROM character_consistency_results WHERE run_id = ? ORDER BY entity_id`, [runId])
}

/** 末段一致性检查项产出的问题（按检查器过滤，其它检查器的干扰不计入） */
async function consistencyIssues(runId: number): Promise<Array<{ severity: string; targetType: string | null; targetId: string | null; evidence: string; suggestion: string | null }>> {
  return await rowsOf(
    "SELECT severity, target_type AS targetType, target_id AS targetId, evidence, suggestion FROM quality_issues WHERE run_id = ? AND checker = 'character.consistency' ORDER BY id",
    [runId],
  )
}

async function finalGate(runId: number): Promise<{ status: string; blockingCount: number; warningCount: number }> {
  const rows = await rowsOf<{ status: string; blockingCount: number; warningCount: number }>(
    "SELECT status, blocking_count AS blockingCount, warning_count AS warningCount FROM quality_gates WHERE run_id = ? AND stage = 'final'",
    [runId],
  )
  const row = rows[0]
  if (!row) throw new Error(`run ${runId} 无末段门禁行`)
  return row
}

/** 末段全部检查器落库问题按严重度计数（门禁的阻断/警告两档应与之一致） */
async function severityCount(runId: number, severity: string): Promise<number> {
  return await count("SELECT COUNT(*) AS n FROM quality_issues WHERE run_id = ? AND stage = 'final' AND severity = ?", [runId, severity])
}

/** 一致性检查项自身贡献的阻断项数（隔离其它末段检查器的干扰：夹具运行通常另有非一致性阻断，门禁总状态不单独归因于本检查项） */
async function consistencyBlockingCount(runId: number): Promise<number> {
  return await count("SELECT COUNT(*) AS n FROM quality_issues WHERE run_id = ? AND stage = 'final' AND checker = 'character.consistency' AND severity = 'blocking'", [runId])
}

async function newProject(name: string): Promise<number> {
  const proj = await call('POST', '/projects', { name })
  assert.equal(proj.status, 201, `项目 ${name} 创建失败：${proj.status} ${proj.body}`)
  return proj.data.project.id as number
}

async function newCharacter(projectId: number, name: string, flatRefs: number[] = []): Promise<number> {
  const ent = await call('POST', '/entities', { project_id: projectId, name, kind: 'character', appearance: '圆脸短发', ref_asset_ids: flatRefs })
  assert.equal(ent.status, 201, `角色 ${name} 创建失败：${ent.status} ${ent.body}`)
  return ent.data.entity.id as number
}

/**
 * 造一条脏数据：软删资产本体。走真实逻辑删端点（进回收站、登记行不动），才是要复现的历史态——
 * 「分层行还在、图却已不可用」；彻底删除会级联带走登记行，那种状态本来就没有缺口可评。
 */
async function softDeleteAsset(assetId: number): Promise<void> {
  const del = await call('DELETE', `/assets/${assetId}`)
  assert.equal(del.status, 200, `软删资产应 200，实得 ${del.status} ${del.body}`)
  assert.equal(await count('SELECT COUNT(*) AS n FROM assets WHERE id = ?', [assetId]), 1, '逻辑删只打删除标记，资产行仍留在回收站内')
}

/** 造一条脏数据：把资产漂到邻项目（同上，正常服务面禁止跨项目引用） */
async function driftAssetToProject(assetId: number, projectId: number): Promise<void> {
  const { sqlite } = await import('../../../src/db')
  await sqlite.execute({ sql: 'UPDATE assets SET project_id = ? WHERE id = ?', args: [projectId, assetId] })
}

/**
 * 造一条脏数据：把历史遗留值写进扁平参考列。写入面对跨项目与已软删资产会当场拒收（按归属域和删除态校验），
 * 但也不校验资产种类——文本资产混进扁平列是能真实写出的形态。这里要一次造出「跨项目 + 非图片 + 已删」
 * 三值并存的存量列，逐项经端点拼不出来，故整列直写：被测的是评价侧的剔除，不是写入侧。
 */
async function setFlatRefIds(entityId: number, assetIds: number[]): Promise<void> {
  const { sqlite } = await import('../../../src/db')
  await sqlite.execute({ sql: 'UPDATE characters SET ref_asset_ids = ? WHERE id = ?', args: [JSON.stringify(assetIds), entityId] })
}

export async function runConsistency(checker: Checker): Promise<void> {
  await initDatabase()
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)
  installStubFetch()
  try {
    const { runConsistencyEval } = await import('../../../src/services/consistency-eval')
    const { addEntityRef, listEntityRefs, patchEntityRef } = await import('../../../src/services/entity-references')
    const { registerAsset } = await import('../../../src/services/storage')
    const { sanitizeErrorNote } = await import('../../../src/services/error-note')
    const { runStage } = await import('../../../src/services/stage-check')

    // ── 场景一：出镜集合 / 两条参考路径 / 脏数据过滤 / 抽样上限 ──────────────
    const p1 = await newProject('一致性主项目')
    const p2 = await newProject('一致性邻项目')

    // 分层主角：一张干净基准 + 已删基准 + 漂到邻项目的基准 + 停用基准 + 一张视角行
    const b1 = await newImageAsset(p1, '分层基准')
    const b2 = await newImageAsset(p1, '分层基准将删')
    const b3 = await newImageAsset(p1, '分层基准漂走')
    const b4 = await newImageAsset(p1, '分层基准停用')
    const v1 = await newImageAsset(p1, '分层视角')
    const eLayered = await newCharacter(p1, '分层主角')
    for (const [assetId, role] of [
      [b1, 'base'],
      [b2, 'base'],
      [b3, 'base'],
      [b4, 'base'],
      [v1, 'view'],
    ] as Array<[number, string]>) {
      await addEntityRef({ entityId: eLayered, assetId, role, viewKey: role === 'view' ? '正面' : null })
    }
    await softDeleteAsset(b2)
    assert.equal(
      await count('SELECT COUNT(*) AS n FROM entity_references WHERE asset_id = ?', [b2]),
      1,
      '逻辑删不动登记行：脏态正是「分层行还在、图已不可用」',
    )
    await driftAssetToProject(b3, p2)
    const disabledRow = await rowsOf<{ id: number }>('SELECT id FROM entity_references WHERE entity_id = ? AND asset_id = ?', [eLayered, b4])
    await patchEntityRef(Number(disabledRow[0]!.id), { enabled: false })
    const shot1 = await newImageAsset(p1, '分层出图甲')
    const shot2 = await newImageAsset(p1, '分层出图乙')

    // 扁平主角：历史扁平列带跨项目 / 非图片 / 已删三张脏值 + 6 张有效（先看脏再截 4）
    const d1 = await newImageAsset(p2, '扁平跨项目')
    const d2 = await newTextAsset(p1, '扁平文本')
    const d3 = await newImageAsset(p1, '扁平已删')
    await softDeleteAsset(d3)
    const flatValid: number[] = []
    for (let k = 0; k < 6; k += 1) flatValid.push(await newImageAsset(p1, `扁平有效${k + 1}`))
    const eFlat = await newCharacter(p1, '扁平主角', flatValid)
    // 跨项目 / 已删的参考在写入面就被拒（端点当场报错），造不出这个状态；
    // 存量项目的扁平列正是历史遗留，这里按「存量脏数据」形态直写扁平列——被测的是评价侧的剔除，不是写入侧。
    await setFlatRefIds(eFlat, [d1, d2, d3, ...flatValid])
    const shot3 = await newImageAsset(p1, '扁平出图')

    // 仅视角主角：有分层行但无基准
    const v2 = await newImageAsset(p1, '仅视角图')
    const eViewOnly = await newCharacter(p1, '仅视角主角')
    await addEntityRef({ entityId: eViewOnly, assetId: v2, role: 'view', viewKey: '侧面' })
    const shot4 = await newImageAsset(p1, '仅视角出图')

    // 未出图主角：有基准、本 run 无出图
    const b5 = await newImageAsset(p1, '未出图基准')
    const eNoShot = await newCharacter(p1, '未出图主角')
    await addEntityRef({ entityId: eNoShot, assetId: b5, role: 'base' })

    // 池参考主角：基准指向全局素材池（登记面接受，评分面的项目域强校验不接受）
    const poolAsset = await registerAsset(0, {
      name: `池基准-${Date.now()}.png`,
      kind: 'image',
      purpose: 'reference',
      relPath: `0/pool-${Date.now()}.png`,
      ext: 'png',
      mime: 'image/png',
    })
    const ePool = await newCharacter(p1, '池参考主角')
    await addEntityRef({ entityId: ePool, assetId: poolAsset.id, role: 'base' })
    const shot5 = await newImageAsset(p1, '池参考出图')

    // 脏出图主角：出图资产属于邻项目
    const b6 = await newImageAsset(p1, '脏出图基准')
    const eDirtyShot = await newCharacter(p1, '脏出图主角')
    await addEntityRef({ entityId: eDirtyShot, assetId: b6, role: 'base' })
    const shot6foreign = await newImageAsset(p2, '邻项目出图')

    // 多镜头主角：出图 26 张 → 只抽最新 24
    const b7 = await newImageAsset(p1, '多镜头基准')
    const eMany = await newCharacter(p1, '多镜头主角')
    await addEntityRef({ entityId: eMany, assetId: b7, role: 'base' })
    const manyShots: number[] = []
    for (let k = 0; k < 26; k += 1) manyShots.push(await newImageAsset(p1, `多镜头出图${k + 1}`))

    // 未出镜角色：有基准有出图，但只出现在另一条 run 的快照里
    const b8 = await newImageAsset(p1, '未出镜基准')
    const eOffscreen = await newCharacter(p1, '未出镜角色')
    await addEntityRef({ entityId: eOffscreen, assetId: b8, role: 'base' })
    const shot7 = await newImageAsset(p1, '未出镜出图')
    const otherRun = await newRunFixture(p1)
    await newTaskFixture(p1, otherRun, eOffscreen, shot7, 'shot-off', 1000)
    await newAppearingSnapshot(p1, otherRun, [eOffscreen])

    const run1 = await newRunFixture(p1)
    const appearing = [eLayered, eFlat, eViewOnly, eNoShot, ePool, eDirtyShot, eMany]
    await newAppearingSnapshot(p1, run1, appearing)
    await newTaskFixture(p1, run1, eLayered, shot1, 'shot-l1', 1000)
    await newTaskFixture(p1, run1, eLayered, shot2, 'shot-l2', 2000)
    await newTaskFixture(p1, run1, eFlat, shot3, 'shot-f1', 1000)
    await newTaskFixture(p1, run1, eViewOnly, shot4, 'shot-v1', 1000)
    await newTaskFixture(p1, run1, ePool, shot5, 'shot-p1', 1000)
    await newTaskFixture(p1, run1, eDirtyShot, shot6foreign, 'shot-d1', 1000)
    for (const [k, id] of manyShots.entries()) await newTaskFixture(p1, run1, eMany, id, `shot-m${k + 1}`, 1000 + k)

    replyScore(8)
    const callsBeforeFirst = stubCallCount()
    const first = await runConsistencyEval(run1)
    const byId = new Map(first.results.map((x) => [x.entityId, x]))

    await t('出镜集合逐实体一行（未出镜角色被排除）', () => {
      assert.equal(first.results.length, 7, `出镜七实体各一行，实得 ${first.results.length} 行`)
      assert.ok(!byId.has(eOffscreen), '未出镜角色（有基准有出图，但不在本 run 快照）不进评价集合')
      const scored = first.results.filter((x) => x.score !== null).length
      assert.equal(scored, 3, `仅三个实体走到评分链拿到分数（其余四个不进网：两无出图、一无基准、一基准在全局池被项目域强校验在请求前拦下），实得 ${scored}`)
      assert.equal(stubCallCount(), callsBeforeFirst + scored, `触网评分的实体各触达一次桩、未触网实体零触达，实得 ${stubCallCount() - callsBeforeFirst} 次`)
    })

    await t('已分层实体只认真源基准行（脏基准逐一剔除后剩一张）', () => {
      const row = byId.get(eLayered)!
      assert.equal(row.refCount, 1, `已删/漂走/停用三张基准被剔除，实得 refCount=${row.refCount}`)
      assert.equal(row.score, 8, `评分成功，实得 ${row.score}`)
      assert.equal(row.note, null, '评分成功不附说明')
    })

    await t('已分层实体出图全纳入抽样', () => {
      const row = byId.get(eLayered)!
      assert.equal(row.assetTotal, 2, `两张出图，实得 ${row.assetTotal}`)
      assert.equal(row.assetSampled, 2, `未触上限两张全评，实得 ${row.assetSampled}`)
    })

    await t('未分层实体扁平列先剔脏再截到上限四条', () => {
      const row = byId.get(eFlat)!
      assert.equal(row.refCount, 4, `跨项目/非图片/已删三张脏值先剔除，六张有效截到 4，实得 ${row.refCount}`)
      assert.equal(row.score, 8, '扁平回落路径评分成功')
      assert.equal(row.note, null, '回落路径不附降级说明（旧项目零改动语义）')
    })

    await t('有分层行但无基准 → 无基准说明且不产假分', async () => {
      const row = byId.get(eViewOnly)!
      assert.equal(row.note, '无基准参考图，无法评价跨镜一致性', `说明原文对齐，实得 ${JSON.stringify(row.note)}`)
      assert.equal(row.score, null, '无基准时分数为空')
      assert.equal(row.refCount, 0, `视角行不当基准用，实得 ${row.refCount}`)
      assert.equal((await listEntityRefs(eViewOnly)).length, 1, '该实体确有分层行（走的是分层路径而非回落）')
    })

    await t('有基准无出图 → 无出图说明', () => {
      const row = byId.get(eNoShot)!
      assert.equal(row.note, '本 run 无该角色出图', `说明原文对齐，实得 ${JSON.stringify(row.note)}`)
      assert.equal(row.assetTotal, 0, `本 run 出图数应零，实得 ${row.assetTotal}`)
      assert.equal(row.score, null, '无出图不产假分')
    })

    await t('出图路径脏数据过滤：越项目资产剔除后按无出图处理', () => {
      const row = byId.get(eDirtyShot)!
      assert.equal(row.note, '本 run 无该角色出图', `脏出图剔除后同款说明，实得 ${JSON.stringify(row.note)}`)
      assert.equal(row.assetTotal, 0, '越项目出图不进总数')
    })

    await t('基准指向全局素材池：归属过滤放行、评分面降级为失败说明', () => {
      const row = byId.get(ePool)!
      assert.equal(row.refCount, 1, `池资产通过「本 run 项目或全局池」过滤，实得 ${row.refCount}`)
      assert.ok(String(row.note).startsWith('评分失败：'), `评分链项目域强校验异常降级为说明，实得 ${JSON.stringify(row.note)}`)
      assert.equal(row.score, null, '评分异常不产假分')
    })

    await t('抽样上限：二十六张出图取最新二十四张', () => {
      const row = byId.get(eMany)!
      assert.equal(row.assetTotal, 26, `总数记全量，实得 ${row.assetTotal}`)
      assert.equal(row.assetSampled, 24, `被评集截到上限，实得 ${row.assetSampled}`)
    })

    await t('评分来源（模型 / 供应商）随结果落库', async () => {
      const rows = await results(run1)
      const row = rows.find((x) => x.entityId === eLayered)!
      assert.equal(row.model, 'stub-scorer-model', `模型取环境变量兜底值，实得 ${JSON.stringify(row.model)}`)
      assert.equal(row.provider, 'env', '来源标识为环境兜底配置（无供应商配置行）')
    })

    // 二次评价：同 run × 同实体仍是一行
    const beforeRows = await results(run1)
    const callsBeforeSecond = stubCallCount()
    replyScore(4)
    const second = await runConsistencyEval(run1)
    const afterRows = await results(run1)

    await t('重评覆盖不增行（同键幂等）', () => {
      assert.equal(afterRows.length, beforeRows.length, `首轮 ${beforeRows.length} 行 → 次轮 ${afterRows.length} 行`)
      assert.equal(afterRows.length, 7, '仍为出镜集合那么大')
    })

    await t('重评重新触达评分链（非读缓存）', () => {
      assert.ok(stubCallCount() > callsBeforeSecond, `桩计数应增长，实得 ${stubCallCount()}（前值 ${callsBeforeSecond}）`)
    })

    await t('重评覆盖分数与评价时刻', () => {
      const before = beforeRows.find((x) => x.entityId === eLayered)!
      const after = afterRows.find((x) => x.entityId === eLayered)!
      assert.equal(after.score, 4, `分数被覆盖为四分，实得 ${after.score}`)
      assert.ok(Number(after.evaluatedAt) >= Number(before.evaluatedAt), '评价时刻不早于首轮')
      assert.equal(second.results.length, first.results.length, '重评返回体行数与首轮一致')
    })

    // ── 场景二：三态分级 + 未评价 info（走真实末段检查项编排）────────────────
    replyScore(8)
    async function gradeFixture(label: string, opts: { withShot?: boolean } = {}): Promise<{ projectId: number; entityId: number; runId: number }> {
      const withShot = opts.withShot !== false
      const projectId = await newProject(`分级项目${label}`)
      const base = await newImageAsset(projectId, `分级基准${label}`)
      const entityId = await newCharacter(projectId, `分级角色${label}`)
      await addEntityRef({ entityId, assetId: base, role: 'base' })
      const runId = await newRunFixture(projectId)
      await newAppearingSnapshot(projectId, runId, [entityId])
      if (withShot) {
        const shot = await newImageAsset(projectId, `分级出图${label}`)
        await newTaskFixture(projectId, runId, entityId, shot, 'shot-g1', 1000)
      }
      return { projectId, entityId, runId }
    }

    const grades: Array<[string, number, 'blocking' | 'warning' | 'none']> = [
      ['四分', 4, 'blocking'],
      ['五分', 5, 'warning'],
      ['六分', 6, 'warning'],
      ['七分', 7, 'none'],
      ['八分', 8, 'none'],
    ]
    for (const [label, score, expect] of grades) {
      const g = await gradeFixture(label)
      replyScore(score)
      await runConsistencyEval(g.runId)
      const gate = await runStage(g.runId, 0, 'final')
      const issues = await consistencyIssues(g.runId)
      const gateRow = await finalGate(g.runId)

      if (expect === 'blocking') {
        await t(`${label}：归一低于五成出阻断`, () => {
          assert.equal(issues.length, 1, `一致性检查项一条阻断，实得 ${issues.map((i) => i.severity).join('/')}`)
          assert.equal(issues[0]!.severity, 'blocking', '严重度为阻断')
          assert.ok(String(issues[0]!.evidence).includes('"normalized":0.4'), `证据带归一分，实得 ${issues[0]!.evidence}`)
          assert.ok(String(issues[0]!.suggestion).includes('低于 5'), '建议按低于 5 口径')
        })
        await t(`${label}：阻断问题带实体定位并翻转门禁`, async () => {
          assert.ok(issues[0]!.targetType === 'entity' && String(issues[0]!.targetId) === String(g.entityId), '阻断项定位到该实体')
          assert.equal(gate.status, 'fail', `末段门禁失败，实得 ${gate.status}`)
          assert.equal(gate.blockingCount, await severityCount(g.runId, 'blocking'), '阻断计数与落库一致')
          assert.ok(gate.blockingCount >= 1, '阻断计数至少一条')
        })
      } else if (expect === 'warning') {
        await t(`${label}：归一介于五成与七成之间出警告`, () => {
          assert.equal(issues.length, 1, `一致性检查项一条警告，实得 ${issues.map((i) => i.severity).join('/')}`)
          assert.equal(issues[0]!.severity, 'warning', '严重度为警告')
          assert.ok(String(issues[0]!.suggestion).includes('低于 7'), '建议按低于 7 口径')
          assert.ok(issues[0]!.targetType === 'entity' && String(issues[0]!.targetId) === String(g.entityId), '警告项定位到该实体')
        })
        await t(`${label}：警告计数与落库逐档一致且本检查项不贡献阻断项`, async () => {
          assert.equal(gateRow.warningCount, await severityCount(g.runId, 'warning'), '警告计数与落库一致')
          assert.equal(gateRow.blockingCount, await severityCount(g.runId, 'blocking'), '阻断计数与落库一致')
          assert.equal(await consistencyBlockingCount(g.runId), 0, '一致性检查项仅出警告不贡献阻断项（末段其它检查器各自阻断不并入归因）')
        })
      } else {
        await t(`${label}：归一不低于七成不出一致性问题`, async () => {
          assert.equal(issues.length, 0, `达标分数不应产出问题，实得 ${issues.map((i) => i.severity).join('/')}`)
          assert.equal(await consistencyBlockingCount(g.runId), 0, '达标分数下本检查项零贡献（其它检查器各自阻断与本断言无关）')
        })
      }
    }

    // ── 场景三：未评价与达标的门禁数学同构（info 不参与阻断/警告计数）─────────
    const unevaluated = await gradeFixture('未跑评价')
    const passing = await gradeFixture('达标七分')
    const failing = await gradeFixture('偏离四分')
    replyScore(7)
    await runConsistencyEval(passing.runId)
    replyScore(4)
    await runConsistencyEval(failing.runId)
    const gateUnevaluated = await runStage(unevaluated.runId, 0, 'final')
    const gatePassing = await runStage(passing.runId, 0, 'final')
    const gateFailing = await runStage(failing.runId, 0, 'final')
    replyScore(8)

    await t('未评价与达标：阻断/警告计数逐位相同', () => {
      assert.equal(gateUnevaluated.blockingCount, gatePassing.blockingCount, `阻断计数 ${gateUnevaluated.blockingCount} 应等于 ${gatePassing.blockingCount}`)
      assert.equal(gateUnevaluated.warningCount, gatePassing.warningCount, `警告计数 ${gateUnevaluated.warningCount} 应等于 ${gatePassing.warningCount}`)
      assert.equal(gateUnevaluated.status, gatePassing.status, '门禁状态同款')
    })

    await t('未评价产出一条待确认 info，不参与阻断/警告计数', async () => {
      const issues = await consistencyIssues(unevaluated.runId)
      assert.equal(issues.length, 1, `未评价一条 info，实得 ${issues.map((i) => i.severity).join('/')}`)
      assert.equal(issues[0]!.severity, 'info', '严重度为待确认信息')
      assert.ok(String(issues[0]!.evidence).includes('not_evaluated'), `证据标注未评价来源，实得 ${issues[0]!.evidence}`)
      assert.ok(String(issues[0]!.suggestion).includes('评价未运行'), `建议提示先评价，实得 ${issues[0]!.suggestion}`)
      assert.equal(await severityCount(unevaluated.runId, 'blocking'), gateUnevaluated.blockingCount, '阻断计数与落库逐档一致')
    })

    await t('偏离四分时阻断计数恰好加一且门禁翻为失败', () => {
      assert.equal(gateFailing.blockingCount, gatePassing.blockingCount + 1, `阻断 ${gatePassing.blockingCount} → ${gateFailing.blockingCount}`)
      assert.equal(gateFailing.status, 'fail', '门禁失败')
    })

    // ── 场景四：分层行全部停用（结果行仍产生，与「评价未运行」分开各断一次）──
    const disabledCase = await gradeFixture('全停用基准')
    const allRows = await listEntityRefs(disabledCase.entityId)
    for (const r of allRows) await patchEntityRef(r.id, { enabled: false })
    replyScore(8)
    await runConsistencyEval(disabledCase.runId)
    await runStage(disabledCase.runId, 0, 'final')
    const disabledRows = await results(disabledCase.runId)

    await t('分层行全部停用：仍落一行结果，分数为空、说明为无基准参考', () => {
      assert.equal(disabledRows.length, 1, `结果行按出镜实体产生，实得 ${disabledRows.length}`)
      assert.equal(disabledRows[0]!.score, null, '无启用基准不产假分')
      assert.equal(disabledRows[0]!.note, '无基准参考图，无法评价跨镜一致性', `说明取无基准口径，实得 ${JSON.stringify(disabledRows[0]!.note)}`)
      assert.equal(disabledRows[0]!.refCount, 0, '启用基准计数为零')
    })

    await t('停用无基准与评价未运行是两条不同来源的 info', async () => {
      const issues = await consistencyIssues(disabledCase.runId)
      assert.equal(issues.length, 1, `一条 info，实得 ${issues.map((i) => i.severity).join('/')}`)
      assert.equal(issues[0]!.severity, 'info', '严重度为待确认信息')
      assert.ok(!String(issues[0]!.evidence).includes('not_evaluated'), '本次已评价，证据不标未评价')
      assert.ok(String(issues[0]!.suggestion).includes('无基准参考图'), '建议把落库说明原文带进可读文案')
      assert.equal(await consistencyBlockingCount(disabledCase.runId), 0, '不可评价由本检查项记为 info，不贡献阻断项')
    })

    // ── 场景五：分数为空（无出图）也走同一条 info 路径 ───────────────────────
    const nullScore = await gradeFixture('空分无出图', { withShot: false })
    const nullTaskRows = await count("SELECT COUNT(*) AS n FROM gen_tasks WHERE run_id = ? AND status = 'succeeded'", [nullScore.runId])
    await t('空分夹具前置成立（有基准、本 run 无出图任务）', async () => {
      assert.equal(nullTaskRows, 0, `该 run 无出图任务行，实得 ${nullTaskRows}`)
      assert.equal((await listEntityRefs(nullScore.entityId)).length, 1, '基准行存在')
    })
    replyScore(8)
    await runConsistencyEval(nullScore.runId)
    await runStage(nullScore.runId, 0, 'final')
    const nullIssues = await consistencyIssues(nullScore.runId)

    await t('分数为空 → 一条 info 且带实体定位', () => {
      assert.equal(nullIssues.length, 1, `实得 ${nullIssues.map((i) => i.severity).join('/')}`)
      assert.equal(nullIssues[0]!.severity, 'info', '严重度为待确认信息')
      assert.ok(String(nullIssues[0]!.suggestion).includes('本 run 无该角色出图'), `建议携带落库说明，实得 ${nullIssues[0]!.suggestion}`)
      assert.ok(nullIssues[0]!.targetType === 'entity' && String(nullIssues[0]!.targetId) === String(nullScore.entityId), 'info 同样带实体定位')
    })

    // ── 场景六：供应商失败的说明脱敏（落库 / 回显 / 证据三处）────────────────
    const leakCase = await gradeFixture('脱敏')
    replyAs('provider500')
    await runConsistencyEval(leakCase.runId)
    const leakRows = await results(leakCase.runId)
    const persistedNote = String(leakRows[0]!.note ?? '')
    const readBack = await call('GET', `/runs/${leakCase.runId}/character-consistency`)
    const echoedNote = String(readBack.data?.entities?.[0]?.note ?? '')

    await t('供应商异常降级为评分失败说明并抹掉凭据形态', () => {
      assert.ok(persistedNote.startsWith('评分失败：'), `说明前缀对齐，实得 ${JSON.stringify(persistedNote)}`)
      assert.ok(persistedNote.includes('[已隐去地址]') && persistedNote.includes('[已隐去密钥]'), '端点与两类密钥形态换成占位文字')
      assert.ok(!persistedNote.includes(LEAK_URL) && !persistedNote.includes(LEAK_KEY) && !persistedNote.includes(LEAK_TOKEN), '说明不含任何凭据片段')
      assert.ok(persistedNote.length <= 160 + '评分失败：'.length, `说明受截断预算约束，实得长度 ${persistedNote.length}`)
    })

    await t('只读端点回显同一份清洗后说明', () => {
      assert.equal(readBack.status, 200, `只读端点应成功，实得 ${readBack.status}`)
      assert.equal(echoedNote, persistedNote, '回显与落库逐字一致')
      assert.equal(leakRows[0]!.score, null, '供应商异常不产假分')
    })

    await runStage(leakCase.runId, 0, 'final')
    const leakIssues = await consistencyIssues(leakCase.runId)

    await t('评分失败进问题证据时仍无凭据泄漏', () => {
      assert.equal(leakIssues.length, 1, `一条 info，实得 ${leakIssues.map((i) => i.severity).join('/')}`)
      assert.equal(leakIssues[0]!.severity, 'info', '评分失败在门禁侧记为不可评价')
      assert.ok(!String(leakIssues[0]!.evidence).includes(LEAK_KEY) && !String(leakIssues[0]!.evidence).includes(LEAK_URL), '证据不含密钥与端点')
    })

    // ── 场景七：两条解析降级说明 ────────────────────────────────────────────
    const badCase = await gradeFixture('坏输出')
    const emptyCase = await gradeFixture('空分数')
    replyAs('garbage')
    await runConsistencyEval(badCase.runId)
    replyAs('empty')
    await runConsistencyEval(emptyCase.runId)
    replyScore(8)
    const badRow = (await results(badCase.runId))[0]!
    const emptyRow = (await results(emptyCase.runId))[0]!
    const reportCountIn = (projectId: number): Promise<number> =>
      count("SELECT COUNT(*) AS n FROM assets WHERE project_id = ? AND purpose = 'eval_report'", [projectId])

    await t('非法输出 → 不可解析说明 + 报告资产落库', () => {
      assert.equal(badRow.note, '评分输出不可解析，见评测报告', `说明原文对齐，实得 ${JSON.stringify(badRow.note)}`)
      assert.equal(badRow.score, null, '不可解析不产假分')
    })

    await t('合法 JSON 但零有效分 → 不采纳聚合零均分', () => {
      assert.equal(emptyRow.note, '评分输出无有效逐图分数，见评测报告', `说明原文对齐，实得 ${JSON.stringify(emptyRow.note)}`)
      assert.equal(emptyRow.score, null, '零有效分不产假分')
    })

    await t('两次降级各落一份评测报告资产供人工判读', async () => {
      assert.equal(await reportCountIn(badCase.projectId), 1, `不可解析的项目恰落一份报告，实得 ${await reportCountIn(badCase.projectId)} 份`)
      assert.equal(await reportCountIn(emptyCase.projectId), 1, `零有效分的项目恰落一份报告，实得 ${await reportCountIn(emptyCase.projectId)} 份`)
    })

    // ── 场景八：只读端点零外发 + 问题计数粒度 ───────────────────────────────
    const readOnly = await gradeFixture('只读端点')
    replyScore(6)
    await runConsistencyEval(readOnly.runId)
    const callsBeforeRead = stubCallCount()
    const g1 = await call('GET', `/runs/${readOnly.runId}/character-consistency`)

    await t('只读端点零次评分调用（绝不当发评价）', () => {
      assert.equal(stubCallCount(), callsBeforeRead, `桩计数不变，实得 ${stubCallCount()}（前值 ${callsBeforeRead}）`)
      assert.equal(g1.status, 200, '只读端点返回成功')
      assert.equal(g1.data?.runId, readOnly.runId, '回显 run 标识')
    })

    await t('结果行随只读端点回显实体名 / 默认集序 / 抽样与基准计数', () => {
      const ent = g1.data?.entities?.[0]
      assert.equal(ent?.name, '分级角色只读端点', `实体名随行回显，实得 ${JSON.stringify(ent?.name)}`)
      assert.equal(ent?.episodeIdx, 0, '集序默认零')
      assert.equal(ent?.score, 6, '分数回显')
      assert.equal(ent?.assetSampled, 1, `抽样一条，实得 ${ent?.assetSampled}`)
      assert.equal(ent?.refCount, 1, `基准一条，实得 ${ent?.refCount}`)
      assert.equal(ent?.issues?.count, 0, '门禁未跑时问题计数为零')
    })

    await runStage(readOnly.runId, 0, 'final')
    const g2 = await call('GET', `/runs/${readOnly.runId}/character-consistency`)

    await t('门禁重跑后问题计数与分级随结果回显', () => {
      assert.equal(g2.data?.entities?.[0]?.issues?.count, 1, `实得 ${JSON.stringify(g2.data?.entities?.[0]?.issues)}`)
      assert.deepEqual(g2.data?.entities?.[0]?.issues?.severities, ['warning'], '分级为警告')
    })

    await t('问题粒度为「一条运行 × 一个实体」且集序恒零', async () => {
      const issueRows = await rowsOf<{ episodeIdx: number; targetId: string; stage: string }>(
        "SELECT episode_idx AS episodeIdx, target_id AS targetId, stage FROM quality_issues WHERE run_id = ? AND checker = 'character.consistency'",
        [readOnly.runId],
      )
      assert.equal(issueRows.length, 1, `一条运行一个实体一条问题，实得 ${issueRows.length}`)
      assert.equal(issueRows[0]!.episodeIdx, 0, '检查项按整轮评分，集序恒零')
      assert.equal(issueRows[0]!.targetId, String(readOnly.entityId), '问题定位到实体')
      const listed = await results(readOnly.runId)
      assert.equal(listed.length, 1, `结果表同键单行，实得 ${listed.length}`)
      assert.equal(Number(listed[0]!.episodeIdx), 0, '结果行集序恒零')
    })

    // ── 场景九：评价错误面与空出镜集合 ─────────────────────────────────────
    await t('不存在运行 → 四百零四；非法标识 → 四百标识错', async () => {
      const nf = await call('POST', '/runs/99999999/consistency-eval')
      assert.equal(nf.status, 404, `实得 ${nf.status}`)
      assert.equal(nf.code, 'not_found', '错误码为缺失')
      assert.ok(nf.message.includes('不存在'), `文案沿用缺失口径，实得 ${nf.message}`)
      const bad = await call('POST', '/runs/abc/consistency-eval')
      assert.equal(bad.status, 400, '非法标识按请求非法')
      assert.equal(bad.code, 'bad_id', '错误码为标识非法')
    })

    await t('只读端点同款标识校验，未知运行返回空集', async () => {
      const badGet = await call('GET', '/runs/0/character-consistency')
      assert.equal(badGet.status, 400, '零标识被拒')
      assert.equal(badGet.code, 'bad_id', '错误码为标识非法')
      const emptyGet = await call('GET', '/runs/99999999/character-consistency')
      assert.equal(emptyGet.status, 200, `未知运行返回成功空集，实得 ${emptyGet.status}`)
      assert.ok(Array.isArray(emptyGet.data?.entities) && emptyGet.data.entities.length === 0, '未知运行回空集')
    })

    await t('出镜集合为空 → 空结果且零次评分调用', async () => {
      const pid = await newProject('无出镜项目')
      const runId = await newRunFixture(pid)
      const before = stubCallCount()
      const res = await runConsistencyEval(runId)
      assert.equal(res.results.length, 0, '无出镜实体不产结果')
      assert.equal(stubCallCount(), before, '零次评分调用')
      assert.equal(await count('SELECT COUNT(*) AS n FROM character_consistency_results WHERE run_id = ?', [runId]), 0, '结果表无残留行')
    })

    // ── 场景十：共享清洗本体 + 单一实现核查 ─────────────────────────────────
    await t('共享清洗抹掉三类凭据形态并压平空白', () => {
      const dirty = `调用失败\n  密钥 ${LEAK_KEY} 端点 ${LEAK_URL} 签名 ${LEAK_TOKEN} 详见内部文档`
      const clean = sanitizeErrorNote(dirty)
      assert.ok(!clean.includes(LEAK_KEY) && !clean.includes(LEAK_URL) && !clean.includes(LEAK_TOKEN), '三类凭据形态全被抹掉')
      assert.ok(clean.includes('[已隐去地址]') && clean.includes('[已隐去密钥]'), '凭据换成占位文字，诊断线索保留')
      assert.ok(!clean.includes('\n') && !clean.includes('  '), '换行与连续空白压平（不伪造日志行）')
    })

    await t('共享清洗受截断预算约束并对空值兜底', () => {
      const long = sanitizeErrorNote('长'.repeat(500))
      assert.equal(long.length, 161, `超长文案截到预算内并加省略号，实得长度 ${long.length}`)
      assert.ok(long.endsWith('…'), '截断处带省略号')
      assert.equal(sanitizeErrorNote(undefined), '', '空抛出值兜成空串')
      assert.equal(sanitizeErrorNote(null), '', '空值抛出兜成空串')
      assert.equal(typeof sanitizeErrorNote({}), 'string', '非错误抛出值不二次抛错')
    })

    await t('能力说明与评分说明共用同一清洗实现', () => {
      const caps = readFileSync(new URL('../../../src/services/image-caps.ts', import.meta.url), 'utf8')
      assert.ok(caps.includes("from './error-note'"), '能力侧从共享模块导入清洗')
      assert.ok(!/https\?:\\/.test(caps) && !/\bsk-/.test(caps), '能力侧不再自带第二份掩码正则')
    })

    // ── 外发证明：全程只命中桩地址 ──────────────────────────────────────────
    await t('评分链零真实外发（桩命中且出站白名单为空）', () => {
      assert.ok(stubCallCount() > 0, `桩确有被调用，实得 ${stubCallCount()} 次`)
      assert.deepEqual(outboundViolations(), [], '无任何请求落到桩地址之外')
      assert.equal(blockedAttempts(), 0, '未出现绕过桩替的真实外发尝试')
    })
  } finally {
    restoreFetch()
  }
}
