/**
 * M29·R02 探针（内容/参考版本 + 执行真实输入快照 + 下游影响 + 锁版）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m29.ts [--section=schema|version-capture|restore|concurrency|input-snapshot|impact|lock|gc-purge]
 *
 * 零网络零计费、零付费模型调用，隔离临时库（acs-probe-m29-*）。全程走服务层纯/近纯函数 + 直连 db，
 * 不触发引擎/适配器。三条不变式落测：执行冻结真实输入（used/skipped + 版本指针）；编辑不静默改写下游
 * （影响只报告状态分类）；还原 / 锁版 / 选片三操作互不混淆。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { existsSync, readFileSync } from 'node:fs'
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

// ---- 隔离环境：必须先于任何 src/env 加载 ----
const { cleanup } = isolatedEnv('m29')

const SECTIONS = [
  'schema',
  'version-capture',
  'restore',
  'concurrency',
  'input-snapshot',
  'impact',
  'lock',
  'gc-purge',
] as const

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m29')
  const checker: Checker = makeChecker(log)
  const { check } = checker

  // 共用建项目助手（各节复用）：initDb 幂等 + 插一条 projects 行
  const mkProject = async (): Promise<number> => {
    const { initDb, db } = await import('../src/db')
    const { projects } = await import('../src/db/schema')
    await initDb()
    const t = Date.now()
    const p = (
      await db
        .insert(projects)
        .values({ name: `probe-m29-${t}`, genre: 'other', templateKey: 'mengbao-episode', status: 'active', settings: '{}', tags: '[]', createdAt: t, updatedAt: t })
        .returning()
    )[0]!
    return p.id
  }

  const runners: Record<string, () => Promise<void>> = {
    // ============ schema：三表建表兜底 + 唯一键 + 反查索引 ============
    schema: async () => {
      const { initDb, db, sqlite } = await import('../src/db')
      const { contentVersions, execSnapshots, execInputs } = await import('../src/db/schema')
      await initDb()
      let ok = true
      try {
        await db.select().from(contentVersions).limit(1)
        await db.select().from(execSnapshots).limit(1)
        await db.select().from(execInputs).limit(1)
      } catch {
        ok = false
      }
      check(ok, 'content_versions / exec_snapshots / exec_inputs 三表建表兜底在位（可查询）')

      const idxNames = async (tbl: string): Promise<Set<string>> => {
        const rs = await sqlite.execute(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${tbl}'`)
        return new Set((rs.rows as unknown as Array<Record<string, unknown>>).map((r) => String(r.name)))
      }
      const cvIdx = await idxNames('content_versions')
      check(cvIdx.has('idx_cv_obj_rev'), 'content_versions 含 (obj_kind,obj_id,revision) 唯一索引')
      const eiIdx = await idxNames('exec_inputs')
      check(eiIdx.has('idx_ei_snapshot') && eiIdx.has('idx_ei_source'), 'exec_inputs 含 snapshot 与 (src_kind,src_id) 反查索引')

      // 唯一键实际拦截重复（对象内同 revision）
      const pid = await mkProject()
      const t = Date.now()
      await db.insert(contentVersions).values({ projectId: pid, objKind: 'asset', objId: 999001, revision: 1, payloadKind: 'json', relPath: null, sha256: 'x', doc: '{}', label: null, source: 'baseline', meta: '{}', createdAt: t })
      let dupRejected = false
      try {
        await db.insert(contentVersions).values({ projectId: pid, objKind: 'asset', objId: 999001, revision: 1, payloadKind: 'json', relPath: null, sha256: 'y', doc: '{}', label: null, source: 'baseline', meta: '{}', createdAt: t })
      } catch {
        dupRejected = true
      }
      check(dupRejected, '同 (objKind,objId,revision) 重复插入被唯一键拒绝')
    },

    // ============ version-capture：文本编辑 baseline+edit / 实体全入口版本 ============
    'version-capture': async () => {
      const pid = await mkProject()
      const { writeTextAsset, absPathOf } = await import('../src/services/storage')
      const { updateAssetContent } = await import('../src/services/asset-content')
      const pv = await import('../src/services/provenance')
      const { upsertEntity } = await import('../src/services/character')

      // 文本：首次编辑懒补 baseline（v1=原文）+ 记 edit（v2=新文）
      const a = await writeTextAsset(pid, { name: '章节.md', content: '原始正文', purpose: 'text' })
      check((await pv.currentRevision('asset', a.id)) === 0, '未编辑文本资产版本链为空（baseline 尚未产生）')
      await updateAssetContent(a.id, '修订后的正文')
      const revs = await pv.listVersions('asset', a.id)
      check(revs.length === 2, '编辑一次 → baseline + edit 共 2 个版本')
      check(revs[1]?.source === 'baseline' && revs[0]?.source === 'edit', '版本按 revision 升序：v1=baseline、v2=edit')
      const v1 = revs.find((r) => r.source === 'baseline')!
      const c1 = await pv.readVersionContent(v1.id)
      check(c1.kind === 'text' && c1.text === '原始正文', '旧版本（baseline）内容可回看 = 原文')
      check(readFileSync(absPathOf(a.relPath!), 'utf8') === '修订后的正文', '工作副本内容 = 最新修订（编辑未破坏固定路径）')
      // 不可变版本文件落在 versions/ 且工作副本同路径不覆写版本文件
      check(!!v1.relPath && v1.relPath.includes('versions'), 'baseline 版本指向 versions/ 不可变文件')
      // 编辑后 embedding 失效（标记待重建）
      const { db } = await import('../src/db')
      const { assets } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const row = (await db.select().from(assets).where(eq(assets.id, a.id)))[0]!
      check(row.embedding === null, '编辑后清空 embedding（旧向量不冒充新正文）')

      // 实体：新建 → baseline；改外观 → edit 版本
      const ent = await upsertEntity({ projectId: pid, name: '林墨', appearance: '黑衣少年' })
      check(ent.created && (await pv.currentRevision('entity', ent.id)) === 1, '新建实体登记 baseline 版本')
      await upsertEntity({ projectId: pid, name: '林墨', appearance: '白衣少年（换装）' })
      check((await pv.currentRevision('entity', ent.id)) === 2, '实体外观变更记 edit 版本（全写入口统一留痕）')
      const eRevs = await pv.listVersions('entity', ent.id)
      const eSnap = await pv.readVersionContent(eRevs[1]!.id)
      check(eSnap.kind === 'json' && (eSnap.doc as Record<string, unknown>).appearance === '黑衣少年', '实体版本 doc 快照承载 appearance')
    },

    // ============ restore：还原文本/实体 = 移动当前指针 + 生成新版本 + 保留全部历史 ============
    restore: async () => {
      const pid = await mkProject()
      const { writeTextAsset, absPathOf } = await import('../src/services/storage')
      const { updateAssetContent } = await import('../src/services/asset-content')
      const pv = await import('../src/services/provenance')
      const { upsertEntity } = await import('../src/services/character')
      const { db } = await import('../src/db')
      const { characters } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')

      // 文本还原
      const a = await writeTextAsset(pid, { name: '稿.md', content: '第一版', purpose: 'text' })
      await updateAssetContent(a.id, '第二版')
      const before = await pv.listVersions('asset', a.id)
      const v1 = before.find((r) => r.revision === 1)!
      await pv.restoreAssetTextVersion(a.id, v1.id)
      check(readFileSync(absPathOf(a.relPath!), 'utf8') === '第一版', '还原后工作副本 = 目标历史版本内容')
      const after = await pv.listVersions('asset', a.id)
      check(after.length === before.length + 1, '还原生成新版本（移动指针，不删历史）')
      check((await pv.currentRevision('asset', a.id)) === before.length + 1, '当前指针推进到还原产生的新版本号')
      check(after.some((r) => r.source === 'restore'), '还原版本标 source=restore（与 edit/baseline 区分）')

      // 实体还原
      const ent = await upsertEntity({ projectId: pid, name: '苏晚', appearance: '红裙' })
      await upsertEntity({ projectId: pid, name: '苏晚', appearance: '蓝裙' })
      const eRevs = await pv.listVersions('entity', ent.id)
      const eV1 = eRevs.find((r) => r.revision === 1)!
      await pv.restoreEntityVersion(ent.id, eV1.id)
      const cur = (await db.select().from(characters).where(eq(characters.id, ent.id)))[0]!
      check(cur.appearance === '红裙', '实体还原应用历史快照字段（appearance 回到红裙）')
      check((await pv.currentRevision('entity', ent.id)) === 3, '实体还原追加新版本（保留全部历史）')
    },

    // ============ concurrency：expectedRevision 乐观并发（缺省 last-write-wins 兼容） ============
    concurrency: async () => {
      const pid = await mkProject()
      const { writeTextAsset } = await import('../src/services/storage')
      const { updateAssetContent, ContentEditError } = await import('../src/services/asset-content')
      const pv = await import('../src/services/provenance')

      const a = await writeTextAsset(pid, { name: '并发.md', content: 'v0', purpose: 'text' })
      // 缺省 expectedRevision：向后兼容 last-write-wins
      await updateAssetContent(a.id, 'v1')
      const rev = await pv.currentRevision('asset', a.id)
      check(rev === 2, '缺省 expectedRevision → 正常保存（last-write-wins 兼容）')
      // 过期基线 → conflict
      let code = ''
      try {
        await updateAssetContent(a.id, 'v2-stale', { expectedRevision: 1 })
      } catch (err) {
        code = err instanceof ContentEditError ? err.code : 'other'
      }
      check(code === 'conflict', 'expectedRevision 落后当前 → conflict（乐观并发拒绝静默覆盖）')
      // 正确基线 → 成功
      await updateAssetContent(a.id, 'v2', { expectedRevision: 2 })
      check((await pv.currentRevision('asset', a.id)) === 3, 'expectedRevision 命中当前 → 保存并推进版本')
    },

    // ============ input-snapshot：执行冻结真实输入（used/skipped + 版本指针） ============
    'input-snapshot': async () => {
      const pid = await mkProject()
      const { writeTextAsset } = await import('../src/services/storage')
      const { updateAssetContent } = await import('../src/services/asset-content')
      const pv = await import('../src/services/provenance')
      const { db } = await import('../src/db')
      const { assets } = await import('../src/db/schema')

      // 文本资产带版本指针；媒体资产 versionId=null（身份即 asset.id）
      const txt = await writeTextAsset(pid, { name: '章节2.md', content: '正文A', purpose: 'text' })
      await updateAssetContent(txt.id, '正文B') // → v1 baseline, v2 edit
      const t = Date.now()
      const media = (
        await db
          .insert(assets)
          .values({ projectId: pid, kind: 'image', purpose: 'storyboard_image', name: 'm.png', relPath: 'm.png', ext: 'png', tags: '[]', createdAt: t, updatedAt: t })
          .returning()
      )[0]!
      const ent = await (await import('../src/services/character')).upsertEntity({ projectId: pid, name: '角色X', appearance: '甲' })

      const textIn = await pv.assetInput('text', txt.id, { port: 'prompt' })
      const mediaIn = await pv.assetInput('reference', media.id, { used: true, ordinal: 0 })
      const skippedIn = await pv.assetInput('reference', media.id, { used: false, skipReason: '供应商不支持参考图', ordinal: 1 })
      const entIn = await pv.entityInput('reference', ent.id)
      check(textIn.versionId != null, '文本资产输入解析到版本指针（非空 versionId）')
      check(mediaIn.versionId === null, '媒体资产输入无版本链（versionId=null，身份即 asset.id）')
      check(entIn.versionId != null && entIn.srcKind === 'entity', '实体输入解析到实体版本指针')

      const snapId = await pv.recordExecSnapshot({
        projectId: pid,
        execKind: 'pipeline_step',
        runId: 5001,
        stepId: 6001,
        taskId: 7001,
        templateKey: 'probe-m29',
        model: 'stub-model',
        inputs: [textIn, mediaIn, skippedIn, entIn],
      })
      check(snapId > 0, 'recordExecSnapshot 返回 snapshotId')
      const got = await pv.getExecutionInputs({ snapshotId: snapId })
      check(!!got && got.inputs.length === 4, 'getExecutionInputs 读回全部 4 条输入边')
      const usedCount = got!.inputs.filter((i) => i.used === 1).length
      const skippedCount = got!.inputs.filter((i) => i.used === 0).length
      check(usedCount === 3 && skippedCount === 1, 'used/skipped 冻结区分（3 采用 / 1 计划但跳过）')
      check(got!.inputs.some((i) => i.used === 0 && i.skipReason === '供应商不支持参考图'), 'skipped 输入带 skipReason（区分计划与实际消费）')
      check(got!.inputs.some((i) => i.role === 'text' && i.versionRevision === 2), '文本输入携带捕获时的版本序号（v2 冻结，非事后当前）')
    },

    // ============ impact：下游影响只报告（upstream_changed / current / no_history） ============
    impact: async () => {
      const pid = await mkProject()
      const { writeTextAsset } = await import('../src/services/storage')
      const { updateAssetContent } = await import('../src/services/asset-content')
      const pv = await import('../src/services/provenance')
      const { db } = await import('../src/db')
      const { assets } = await import('../src/db/schema')

      // ① 消费版本 == 当前版本 → current
      const a = await writeTextAsset(pid, { name: 'imp.md', content: 'A1', purpose: 'text' })
      await updateAssetContent(a.id, 'A2')
      const snapCurrent = await pv.recordExecSnapshot({ projectId: pid, execKind: 'pipeline_step', runId: 1, inputs: [await pv.assetInput('text', a.id, { shotId: 'shot-1' })] })
      void snapCurrent
      let rows = await pv.downstreamImpact({ objKind: 'asset', objId: a.id })
      check(rows.length === 1 && rows[0]!.status === 'current', '捕获版本=当前版本 → status=current')
      check(rows[0]!.shotId === 'shot-1', '影响行保留 shotId 定位（局部镜头命中，不泛化）')

      // ② 上游再编辑 → 既有消费记录变 upstream_changed（编辑不静默改写下游，只报告）
      await updateAssetContent(a.id, 'A3')
      rows = await pv.downstreamImpact({ objKind: 'asset', objId: a.id })
      check(rows[0]!.status === 'upstream_changed' && rows[0]!.currentRevision === 3, '上游编辑后 → 下游命中 upstream_changed（报告当前 v3）')

      // ③ 媒体资产无版本链 → no_history（历史不可恢复标记，不伪造）
      const t = Date.now()
      const media = (
        await db
          .insert(assets)
          .values({ projectId: pid, kind: 'image', purpose: 'storyboard_image', name: 'mm.png', relPath: 'mm.png', ext: 'png', tags: '[]', createdAt: t, updatedAt: t })
          .returning()
      )[0]!
      await pv.recordExecSnapshot({ projectId: pid, execKind: 'pipeline_step', runId: 2, inputs: [await pv.assetInput('reference', media.id)] })
      const mrows = await pv.downstreamImpact({ objKind: 'asset', objId: media.id })
      check(mrows.length === 1 && mrows[0]!.status === 'no_history', '媒体资产输入无版本指针 → 标 no_history（不伪造）')
    },

    // ============ lock：锁定下次执行输入（spec.pin）与选片/还原严格分离 ============
    lock: async () => {
      const pid = await mkProject()
      const pv = await import('../src/services/provenance')
      const { createCanvas, addGenNode, addAssetNode } = await import('../src/services/creation')
      const { db } = await import('../src/db')
      const { canvasNodes } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const { safeParseSpec } = await import('../src/services/creation/spec')

      const canvas = await createCanvas(pid, '锁版探针画布')
      const gen = await addGenNode(canvas, { genKind: 'image', prompt: '生成图' }, 0, 0)
      const upAsset = await addAssetNode(canvas, (await (await import('../src/services/storage')).writeTextAsset(pid, { name: '参考.md', content: 'r', purpose: 'text' })).id, 100, 0)

      // 锁定 gen 节点对上游资产节点的输入到指定资产
      const locks = await pv.lockCanvasInput(gen.id, upAsset.id, upAsset.assetId!)
      check(locks.length === 1 && locks[0]!.upstreamNodeId === upAsset.id && locks[0]!.assetId === upAsset.assetId, 'lockCanvasInput 写入 spec.pin（上游节点→资产）')
      const persisted = safeParseSpec((await db.select().from(canvasNodes).where(eq(canvasNodes.id, gen.id)))[0]!.spec).spec
      check(persisted?.pin?.[String(upAsset.id)] === upAsset.assetId, 'pin 落库到 gen 节点 spec（加法字段，不动既有字段）')

      // 再锁定不覆盖其它上游（多条目共存）
      const second = await addAssetNode(canvas, (await (await import('../src/services/storage')).writeTextAsset(pid, { name: '参考2.md', content: 'r2', purpose: 'text' })).id, 200, 0)
      await pv.lockCanvasInput(gen.id, second.id, second.assetId!)
      check((await pv.listCanvasInputLocks(gen.id)).length === 2, '多上游锁定共存（互不覆盖）')

      // 解锁回落
      const afterUnlock = await pv.unlockCanvasInput(gen.id, upAsset.id)
      check(afterUnlock.length === 1 && afterUnlock[0]!.upstreamNodeId === second.id, 'unlockCanvasInput 移除指定上游（回落到最新/采纳）')

      // 校验拒绝：非 gen 节点 / 跨项目资产 / 上游不在同画布
      let bad1 = false
      try {
        await pv.lockCanvasInput(upAsset.id, gen.id, upAsset.assetId!) // 上游锁到 asset 节点（非 gen）
      } catch {
        bad1 = true
      }
      check(bad1, '非生成节点不可锁定输入（loadLockableNode 拒绝）')
      const otherPid = await mkProject()
      const foreign = await (await import('../src/services/storage')).writeTextAsset(otherPid, { name: 'f.md', content: 'f', purpose: 'text' })
      let bad2 = false
      try {
        await pv.lockCanvasInput(gen.id, upAsset.id, foreign.id) // 资产不属本项目
      } catch {
        bad2 = true
      }
      check(bad2, '锁定资产须属本项目（跨项目拒绝）')
    },

    // ============ gc-purge：物理 GC 保护版本/依赖 + 三表级联删列可过滤 ============
    'gc-purge': async () => {
      const pid = await mkProject()
      const { writeTextAsset, absPathOf } = await import('../src/services/storage')
      const { updateAssetContent } = await import('../src/services/asset-content')
      const pv = await import('../src/services/provenance')
      const { cleanupVersions, gcProject } = await import('../src/services/version-cleanup')
      const { db } = await import('../src/db')
      const { assets, execInputs, execSnapshots, contentVersions } = await import('../src/db/schema')
      const { and, eq } = await import('drizzle-orm')
      const t = Date.now()

      // ① 版本文件不可变：编辑产生的 versions/ 文件在资产被物理 GC 后仍存活（历史不被物理删）
      const txt = await writeTextAsset(pid, { name: 'gc章节.md', content: '原', purpose: 'text' })
      await updateAssetContent(txt.id, '改')
      const v1 = (await pv.listVersions('asset', txt.id)).find((r) => r.revision === 1)!
      const versionAbs = absPathOf(v1.relPath!)
      check(existsSync(versionAbs), '不可变版本文件已落 versions/ 目录')
      // 软删资产 + 物理回收：工作副本被清，版本文件保留
      await db.update(assets).set({ deletedAt: Date.now() }).where(eq(assets.id, txt.id))
      await gcProject(pid)
      check(existsSync(versionAbs), '物理 GC 后 versions/ 历史文件仍存活（不随工作副本删除）')

      // ② exec_inputs 引用的媒体资产豁免版本清理（防在用/历史依赖被软删致追溯悬空）
      const imgOld = (
        await db.insert(assets).values({ projectId: pid, kind: 'image', purpose: 'storyboard_image', name: 'old.png', relPath: 'old.png', ext: 'png', tags: '[]', taskId: 88001, createdAt: t, updatedAt: t }).returning()
      )[0]!
      const imgNew = (
        await db.insert(assets).values({ projectId: pid, kind: 'image', purpose: 'storyboard_image', name: 'new.png', relPath: 'new.png', ext: 'png', tags: '[]', taskId: 88001, createdAt: t + 1000, updatedAt: t + 1000 }).returning()
      )[0]!
      // 老图被某次执行实际消费（used）→ 应豁免清理
      const snapId = await db.insert(execSnapshots).values({ projectId: pid, execKind: 'pipeline_step', runId: 9001, inputHash: 'h', frozenAt: t, createdAt: t }).returning()
      await db.insert(execInputs).values({ snapshotId: snapId[0]!.id, projectId: pid, role: 'source', srcKind: 'asset', srcId: imgOld.id, used: 1, ordinal: 0, createdAt: t })
      const res = await cleanupVersions({ projectId: pid })
      check(res.cleaned === 0 && res.kept === 2, '被执行消费的老版本资产豁免清理（同组两条均保留，防追溯悬空）')
      const oldRow = (await db.select().from(assets).where(eq(assets.id, imgOld.id)))[0]!
      check(oldRow.deletedAt === null, '豁免资产未被软删')

      // ③ 三表按 projectId 级联可删（purge 路由列语义校验）
      await db.delete(contentVersions).where(and(eq(contentVersions.projectId, pid)))
      await db.delete(execSnapshots).where(eq(execSnapshots.projectId, pid))
      await db.delete(execInputs).where(eq(execInputs.projectId, pid))
      const cvLeft = await db.select().from(contentVersions).where(eq(contentVersions.projectId, pid))
      check(cvLeft.length === 0, '追溯三表支持按 project_id 级联过滤删除（purge 依赖列在位）')
    },
  }

  await runSections({ log, title: 'M29', checker, sections: SECTIONS, runners, cleanup })
}

void main()
