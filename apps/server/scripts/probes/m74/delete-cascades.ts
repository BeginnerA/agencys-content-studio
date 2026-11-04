/**
 * 删除面级联节（走真实删除端点，锁死「登记行随宿主消失、资产本体保留」）。
 *
 * 背景：两张新表的外键都无级联删除——entity_references 挂 characters 与 assets、
 * character_consistency_results 挂 pipeline_runs 与 characters。删父行前必须先把引用行清掉，
 * 否则触发外键约束失败。本文件逐一验证实体面、运行面、项目面三处删除各自把引用行带走，
 * 再验资产面（单条彻底删除与清空回收站）把指向该资产的登记行带走、并把派生列回正为
 * 剩余启用行的重算值——资产是被引用的一侧，删它同样要走级联，且不得留下指向已删资产的孤儿。
 * 最后验会话影子项目面（未立项会话连带硬删其资产）与「跳过级联的裸删父行会被外键拒」
 * ——故清理夹具一律走端点，不用裸 `DELETE FROM`。
 *
 * 评价侧需要触达评分协议层：本文件自带桩 fetch（形态与评分链节一致），结束即还原。
 */
import assert from 'node:assert/strict'
import type { Checker } from '../../probe-lib'
import { initDatabase, newAppearingSnapshot, newImageAsset, newRunFixture, newTaskFixture } from './bootstrap'
import { call, count, flatRefIds, recomputeRefIds, test } from './helpers'
import { installStubFetch, replyScore, restoreFetch } from './llm-stub'

async function newProject(name: string): Promise<number> {
  const proj = await call('POST', '/projects', { name })
  assert.equal(proj.status, 201, `项目 ${name} 创建失败：${proj.status} ${proj.body}`)
  return proj.data.project.id as number
}

async function newCharacter(projectId: number, name: string): Promise<number> {
  const ent = await call('POST', '/entities', { project_id: projectId, name, kind: 'character', appearance: '圆脸短发' })
  assert.equal(ent.status, 201, `角色 ${name} 创建失败：${ent.status} ${ent.body}`)
  return ent.data.entity.id as number
}

/** 造一个「登记过分层行、且被评过一致性」的实体 + 一条终态运行：返回各关键标识，供删除前后各读一次计数。 */
async function layeredAndEvaluated(label: string): Promise<{ projectId: number; entityId: number; runId: number; baseAsset: number; shotAsset: number }> {
  const projectId = await newProject(`级联-${label}`)
  const entityId = await newCharacter(projectId, `级联角色${label}`)
  const baseAsset = await newImageAsset(projectId, `${label}基准`)
  const reg = await call('POST', `/entities/${entityId}/references`, { assetId: baseAsset, role: 'base' })
  assert.equal(reg.status, 201, `分层登记应 201，实得 ${reg.status} ${reg.body}`)
  const runId = await newRunFixture(projectId)
  const shotAsset = await newImageAsset(projectId, `${label}出图`)
  await newTaskFixture(projectId, runId, entityId, shotAsset, `shot-${label}`, 1000)
  await newAppearingSnapshot(projectId, runId, [entityId])
  const evalRes = await call('POST', `/runs/${runId}/consistency-eval`)
  assert.equal(evalRes.status, 200, `一致性评价应 200，实得 ${evalRes.status} ${evalRes.body}`)
  return { projectId, entityId, runId, baseAsset, shotAsset }
}

/** 造一个「有两条启用基准登记行」的实体：资产删除面用它验登记行随资产消失、派生列回正。 */
async function layeredWithTwoBaseRefs(label: string): Promise<{ projectId: number; entityId: number; firstAsset: number; secondAsset: number }> {
  const projectId = await newProject(`级联-${label}`)
  const entityId = await newCharacter(projectId, `级联角色${label}`)
  const firstAsset = await newImageAsset(projectId, `${label}将被删`)
  const secondAsset = await newImageAsset(projectId, `${label}将保留`)
  for (const assetId of [firstAsset, secondAsset]) {
    const reg = await call('POST', `/entities/${entityId}/references`, { assetId, role: 'base' })
    assert.equal(reg.status, 201, `登记 ${label} 基准行应 201，实得 ${reg.status} ${reg.body}`)
  }
  return { projectId, entityId, firstAsset, secondAsset }
}

const refRows = (entityId: number): Promise<number> => count('SELECT COUNT(*) AS n FROM entity_references WHERE entity_id = ?', [entityId])
const resultRowsForEntity = (entityId: number): Promise<number> => count('SELECT COUNT(*) AS n FROM character_consistency_results WHERE entity_id = ?', [entityId])
const resultRowsForRun = (runId: number): Promise<number> => count('SELECT COUNT(*) AS n FROM character_consistency_results WHERE run_id = ?', [runId])

export async function runDeleteCascades(checker: Checker): Promise<void> {
  await initDatabase()
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)

  installStubFetch()
  try {
    replyScore(8)
    const { sqlite } = await import('../../../src/db')

    // ── 一、实体删除面：两张新表的引用行按 entity_id 归零，资产本体保留 ─────────
    const e = await layeredAndEvaluated('实体')
    await t('实体删除前置：分层行与一致性结果各一行、两张资产在库', async () => {
      assert.equal(await refRows(e.entityId), 1, `分层登记行应一行，实得 ${await refRows(e.entityId)}`)
      assert.equal(await resultRowsForEntity(e.entityId), 1, `一致性结果行应一行，实得 ${await resultRowsForEntity(e.entityId)}`)
      assert.equal(await count('SELECT COUNT(*) AS n FROM assets WHERE id IN (?, ?)', [e.baseAsset, e.shotAsset]), 2, '两张资产本体在库')
    })

    await t('实体删除 → 分层行与结果行归零、资产本体不受牵连', async () => {
      const del = await call('DELETE', `/entities/${e.entityId}`)
      assert.equal(del.status, 200, `实体删除应 200，实得 ${del.status} ${del.body}`)
      assert.equal(del.data?.ok, true, '删除回显成功标记')
      assert.equal(await refRows(e.entityId), 0, '实体删除后分层登记行归零')
      assert.equal(await resultRowsForEntity(e.entityId), 0, '实体删除后一致性结果行归零')
      assert.equal(await count('SELECT COUNT(*) AS n FROM characters WHERE id = ?', [e.entityId]), 0, '实体行已消失')
      assert.equal(await count('SELECT COUNT(*) AS n FROM assets WHERE id = ?', [e.baseAsset]), 1, '参考图资产本体保留（档案删除不牵连素材）')
      assert.equal(await count('SELECT COUNT(*) AS n FROM assets WHERE id = ?', [e.shotAsset]), 1, '出图资产本体保留')
    })

    await t('实体删除后读其分层清单 → 404 宿主缺失', async () => {
      const got = await call('GET', `/entities/${e.entityId}/references`)
      assert.equal(got.status, 404, `宿主消失后清单应 404，实得 ${got.status}`)
      assert.equal(got.code, 'not_found', '缺失码统一')
    })

    // ── 二、运行删除面：结果行按 run_id 归零，实体分层行与资产保留 ─────────────
    const r = await layeredAndEvaluated('运行')
    await t('运行删除前置：结果行挂本 run、实体分层行在位', async () => {
      assert.equal(await resultRowsForRun(r.runId), 1, `一致性结果行应一行，实得 ${await resultRowsForRun(r.runId)}`)
      assert.equal(await refRows(r.entityId), 1, '实体分层行仍在')
    })

    await t('运行删除 → 该 run 结果行归零、实体分层行与资产保留、任务行一并清', async () => {
      const del = await call('DELETE', `/runs/${r.runId}`)
      assert.equal(del.status, 200, `终态运行删除应 200，实得 ${del.status} ${del.body}`)
      assert.equal(await resultRowsForRun(r.runId), 0, '运行删除后其一致性结果行归零')
      assert.equal(await count('SELECT COUNT(*) AS n FROM pipeline_runs WHERE id = ?', [r.runId]), 0, '运行行已消失')
      assert.equal(await count("SELECT COUNT(*) AS n FROM gen_tasks WHERE run_id = ?", [r.runId]), 0, '该 run 的出图任务行一并清')
      assert.equal(await refRows(r.entityId), 1, '运行删除不牵连实体的分层登记行（宿主仍在）')
      assert.equal(await count('SELECT COUNT(*) AS n FROM characters WHERE id = ?', [r.entityId]), 1, '实体本体保留')
      assert.equal(await count('SELECT COUNT(*) AS n FROM assets WHERE id = ?', [r.shotAsset]), 1, '产物资产保留（成本/素材不随记录消失）')
    })

    // ── 三、项目彻底删除面：实体、运行、资产三层引用行全清 ────────────────────
    const p = await layeredAndEvaluated('项目')
    await t('项目删除前置：分层行 / 结果行 / 实体 / 运行 / 资产齐备', async () => {
      assert.equal(await refRows(p.entityId), 1, '分层登记行在位')
      assert.equal(await resultRowsForEntity(p.entityId), 1, '一致性结果行在位')
      assert.equal(await count('SELECT COUNT(*) AS n FROM characters WHERE project_id = ?', [p.projectId]), 1, '项目下实体在位')
      assert.equal(await count('SELECT COUNT(*) AS n FROM pipeline_runs WHERE project_id = ?', [p.projectId]), 1, '项目下运行在位')
    })

    await t('项目彻底删除 → 两张新表引用行与实体 / 运行 / 资产全部归零', async () => {
      const del = await call('DELETE', `/projects/${p.projectId}?purge=1`)
      assert.equal(del.status, 200, `项目彻底删除应 200，实得 ${del.status} ${del.body}`)
      assert.equal(await refRows(p.entityId), 0, '项目删除后实体分层登记行归零')
      assert.equal(await resultRowsForEntity(p.entityId), 0, '项目删除后一致性结果行（按实体）归零')
      assert.equal(await resultRowsForRun(p.runId), 0, '项目删除后一致性结果行（按运行）归零')
      assert.equal(await count('SELECT COUNT(*) AS n FROM characters WHERE project_id = ?', [p.projectId]), 0, '实体整批消失')
      assert.equal(await count('SELECT COUNT(*) AS n FROM pipeline_runs WHERE project_id = ?', [p.projectId]), 0, '运行整批消失')
      assert.equal(await count('SELECT COUNT(*) AS n FROM assets WHERE project_id = ?', [p.projectId]), 0, '资产整批消失')
    })

    await t('项目默认归档不删行（级联面只在彻底删除时发生）', async () => {
      const keep = await layeredAndEvaluated('归档')
      const archive = await call('DELETE', `/projects/${keep.projectId}`)
      assert.equal(archive.status, 200, `归档应 200，实得 ${archive.status} ${archive.body}`)
      assert.equal(archive.data?.mode, 'archived', '回显归档模式')
      assert.equal(await refRows(keep.entityId), 1, '归档不动分层登记行（逻辑删可恢复，非级联删除）')
      assert.equal(await count('SELECT COUNT(*) AS n FROM characters WHERE id = ?', [keep.entityId]), 1, '归档不删实体本体')
      // 收尾：真正删除该归档项目，避免其引用行残留到外键证明场景
      const purge = await call('DELETE', `/projects/${keep.projectId}?purge=1`)
      assert.equal(purge.status, 200, '归档后彻底删除收尾成功')
    })

    // ── 四、资产删除面：删掉被分层登记的资产，登记行随之消失且派生列回正 ───────
    // 资产是被引用的一侧：彻底删除时必须先把指向它的登记行清掉，否则外键约束拦下整次删除。
    // 这条同时锁死派生不变式——列值恒等于「剩余启用行」的重算结果，绝不残留指向已删资产的孤儿。
    const g = await layeredWithTwoBaseRefs('资产单删')
    await t('资产删除前置：两条分层登记行、扁平列初值等于启用行重算', async () => {
      assert.equal(await count('SELECT COUNT(*) AS n FROM entity_references WHERE entity_id = ?', [g.entityId]), 2, `两条分层登记行建立，实得 ${await count('SELECT COUNT(*) AS n FROM entity_references WHERE entity_id = ?', [g.entityId])}`)
      assert.deepEqual(await flatRefIds(g.entityId), await recomputeRefIds(g.entityId), '扁平列初值等于两条启用行重算')
      assert.deepEqual(await flatRefIds(g.entityId), [g.firstAsset, g.secondAsset], `扁平列初值为两张基准资产，实得 ${JSON.stringify(await flatRefIds(g.entityId))}`)
    })

    await t('彻底删除被引用资产 → 登记行随之消失、扁平列剔除该项并等于剩余行重算', async () => {
      const del = await call('DELETE', `/assets/${g.firstAsset}/purge`)
      assert.equal(del.status, 200, `删被引用资产应 200（非外键 400），实得 ${del.status} ${del.body}`)
      assert.equal(await count('SELECT COUNT(*) AS n FROM assets WHERE id = ?', [g.firstAsset]), 0, '被引用资产行已消失')
      assert.equal(
        await count('SELECT COUNT(*) AS n FROM entity_references WHERE asset_id = ?', [g.firstAsset]),
        0,
        '不遗留指向已删资产的分层登记行',
      )
      assert.equal(await refRows(g.entityId), 1, '仅删被点名的那张资产的登记行，另一张仍在位')
      assert.deepEqual(await flatRefIds(g.entityId), await recomputeRefIds(g.entityId), '删被引用资产后扁平列仍等于剩余启用行重算（派生不变式）')
      assert.deepEqual(await flatRefIds(g.entityId), [g.secondAsset], `扁平列已剔除被删资产、仅余另一张，实得 ${JSON.stringify(await flatRefIds(g.entityId))}`)
    })

    // ── 五、清空回收站面：批量硬删同样不留孤儿登记行，派生列保持与启用行一致 ──
    const z = await layeredWithTwoBaseRefs('回收站')
    await t('清空回收站 → 回收站内资产被硬删、其登记行随之消失且扁平列回正', async () => {
      const soft = await call('DELETE', `/assets/${z.firstAsset}`)
      assert.equal(soft.status, 200, `资产先逻辑删入回收站应 200，实得 ${soft.status} ${soft.body}`)
      assert.equal(await count('SELECT COUNT(*) AS n FROM assets WHERE id = ?', [z.firstAsset]), 1, '逻辑删后资产行仍在回收站内')
      assert.equal(await refRows(z.entityId), 2, '逻辑删不动登记行（可恢复，非级联删除）')

      const empty = await call('POST', `/projects/${z.projectId}/assets/trash/empty`)
      assert.equal(empty.status, 200, `清空回收站应 200（非外键 400），实得 ${empty.status} ${empty.body}`)
      assert.equal(await count('SELECT COUNT(*) AS n FROM assets WHERE id = ?', [z.firstAsset]), 0, '回收站清空后资产行消失')
      assert.equal(
        await count('SELECT COUNT(*) AS n FROM entity_references WHERE asset_id = ?', [z.firstAsset]),
        0,
        '清空回收站不留指向已删资产的分层登记行',
      )
      assert.deepEqual(await flatRefIds(z.entityId), await recomputeRefIds(z.entityId), '回收站清空后扁平列仍等于剩余启用行重算（派生不变式）')
      assert.deepEqual(await flatRefIds(z.entityId), [z.secondAsset], `扁平列只剩另一张启用行，实得 ${JSON.stringify(await flatRefIds(z.entityId))}`)
    })

    // ── 六、会话影子项目面：登记过分层行的影子项目仍能整批删除 ────────────────
    // 「删除智能创作会话」是独立入口：未立项的草稿会话会连带硬删其影子项目的资产，
    // 若漏清分层行，被登记过的影子项目会卡在外键上删不掉——本块锁死这条真实删除链。
    const shadow = await call('POST', '/creation-sessions', {
      content: '角色一致性回归用的影子项目',
      requestKey: 'character-consistency-shadow-project',
      deferPlanning: true,
    })
    assert.equal(shadow.status, 201, `创建创作会话应 201，实得 ${shadow.status} ${shadow.body}`)
    const shadowProjectId = shadow.data?.session?.projectId as number
    const shadowEntity = await newCharacter(shadowProjectId, '影子项目角色')
    const shadowAsset = await newImageAsset(shadowProjectId, '影子参考图')
    const shadowReg = await call('POST', `/entities/${shadowEntity}/references`, { assetId: shadowAsset, role: 'base' })
    assert.equal(shadowReg.status, 201, `影子项目内登记应 201，实得 ${shadowReg.status} ${shadowReg.body}`)

    await t('删除会话（影子项目整批清）→ 分层行随资产消失、不被外键拒', async () => {
      assert.equal(await refRows(shadowEntity), 1, '删除前分层登记行在位')
      const del = await call('DELETE', `/creation-sessions/${shadow.data?.session?.id}`)
      assert.equal(del.status, 200, `删带分层登记的影子项目会话应 200（非外键 400），实得 ${del.status} ${del.body}`)
      assert.equal(del.data?.mode, 'draft_purged', `未立项会话走影子项目整批清，实得 ${JSON.stringify(del.data?.mode)}`)
      assert.equal(await count('SELECT COUNT(*) AS n FROM assets WHERE id = ?', [shadowAsset]), 0, '影子项目资产随会话硬删')
      assert.equal(await refRows(shadowEntity), 0, '不留指向已删影子资产的登记行')
      assert.equal(
        await count('SELECT COUNT(*) AS n FROM entity_references WHERE entity_id = ?', [shadowEntity]),
        0,
        '影子项目实体的分层行同批归零',
      )
      assert.equal(await count('SELECT COUNT(*) AS n FROM projects WHERE id = ?', [shadowProjectId]), 0, '影子项目行消失')
    })

    // ── 七、外键纪律证明：跳过级联的裸删父行会被拒 ──────────────────────────
    await t('裸删带分层登记的实体父行被外键拒（清理必须走端点或服务级联函数）', async () => {
      const d = await layeredAndEvaluated('裸删')
      let rejected = false
      let failMessage = ''
      try {
        await sqlite.execute({ sql: 'DELETE FROM characters WHERE id = ?', args: [d.entityId] })
      } catch (err) {
        rejected = true
        failMessage = (err as Error).message
      }
      assert.ok(rejected, `实体被引用行挂住时裸删父行应被外键拒，实得未抛错（外键缺失则级联纪律不成立）：${failMessage}`)
      assert.ok(/foreign key/i.test(failMessage), `拒绝理由为外键约束，实得 ${failMessage}`)
      assert.equal(await count('SELECT COUNT(*) AS n FROM characters WHERE id = ?', [d.entityId]), 1, '被拒后父行仍在（未造成半删态）')
      const clean = await call('DELETE', `/entities/${d.entityId}`)
      assert.equal(clean.status, 200, '改走级联端点删除成功')
      assert.equal(await refRows(d.entityId), 0, '端点先清引用行再删父行')
    })
  } finally {
    restoreFetch()
  }
}
