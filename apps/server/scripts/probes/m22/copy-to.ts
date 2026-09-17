/** M22[P3] copy-to：跨画布复制（同项目直引 / 跨项目级联拷贝）（断言体逐字搬自原 probe-m22.ts） */
import { readFileSync, writeFileSync } from 'node:fs'
import type { M22Ctx } from './ctx'

export async function run(ctx: M22Ctx): Promise<void> {
  const { check, db, T0, projects, canvases, canvasNodes, canvasGroups, canvasEdges, characters, assets, eq, copyNodesToCanvas, ensureProjectDirs, relPathOf, absPathOf, registerAsset } = ctx
  const [projS] = await db
    .insert(projects)
    .values({ name: 'M22 复制源项目', genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
    .returning()
  const [projD] = await db
    .insert(projects)
    .values({ name: 'M22 复制目标项目', genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
    .returning()
  const mkCanvas = async (pid: number, name: string): Promise<typeof canvases.$inferSelect> =>
    (await db.insert(canvases).values({ projectId: pid, name, createdAt: T0, updatedAt: T0 }).returning())[0]!
  const mkNode = async (canvasId: number, extra: Partial<typeof canvasNodes.$inferInsert>): Promise<typeof canvasNodes.$inferSelect> =>
    (await db
      .insert(canvasNodes)
      .values({ canvasId, kind: 'text', title: 'N', spec: '{"text":"t"}', x: 0, y: 0, createdAt: T0, updatedAt: T0, ...extra })
      .returning())[0]!

  // ---- 同项目：直接引用（零拷贝） ----
  const s1 = await mkCanvas(projS!.id, '同项目源')
  const s2 = await mkCanvas(projS!.id, '同项目目标')
  const tG = await mkNode(s1.id, { kind: 'text', title: '文本', spec: '{"text":"hello"}', x: 100, y: 200 })
  const aG = await mkNode(s1.id, { kind: 'asset', title: '素材', assetId: 555, x: 400, y: 200 })
  const gG = await mkNode(s1.id, {
    kind: 'gen',
    title: '生成',
    spec: JSON.stringify({ genKind: 'video', prompt: 'p', bgmAssetId: 555 }),
    x: 700,
    y: 200,
    adoptedTaskId: 42,
  })
  const [grpS] = await db.insert(canvasGroups).values({ canvasId: s1.id, title: 'G', createdAt: T0 }).returning()
  await db.update(canvasNodes).set({ groupId: grpS!.id }).where(eq(canvasNodes.id, tG.id))
  await db.insert(canvasEdges).values({ canvasId: s1.id, from: tG.id, to: gG.id, port: 'prompt', createdAt: T0 })

  const r1 = await copyNodesToCanvas(s1, s2, [tG.id, aG.id, gG.id], { x: 10, y: 20 })
  check(
    r1.nodes.length === 3 && r1.edges.length === 1 && r1.assetsCopied === 0 && r1.skipped.length === 0 && r1.warnings.length === 0,
    '同项目：3 节点 + 1 内边 / 零资产拷贝 / 零跳过零警告',
  )
  const cTxt = r1.nodes[0]!
  const cAs1 = r1.nodes[1]!
  const cGen1 = r1.nodes[2]!
  check(cTxt.x === 110 && cTxt.y === 220 && cTxt.groupId === null, '同项目：偏移生效 + groupId 不拷贝')
  check(cTxt.spec === '{"text":"hello"}' && cAs1.assetId === 555 && cGen1.adoptedTaskId === 42, '同项目：spec/资产引用/adoptedTaskId 原样（直接引用）')
  check((JSON.parse(cGen1.spec!) as { bgmAssetId?: number }).bgmAssetId === 555, '同项目：gen 内联资产引用原样')
  check(r1.edges[0]!.from === cTxt.id && r1.edges[0]!.to === cGen1.id && r1.edges[0]!.canvasId === s2.id, '同项目：内边重映射到新 id（目标画布域）')

  // ---- 跨项目：级联拷贝（真实文件字节级；本地写盘零网络） ----
  ensureProjectDirs(projS!.id)
  const vRel = relPathOf(projS!.id, 'creation_video', 'copy-src.mp4')
  writeFileSync(absPathOf(vRel), Buffer.from('M22-COPY-BYTES-0123456789'))
  const x1 = await registerAsset(projS!.id, {
    name: '视频X1.mp4',
    kind: 'video',
    purpose: 'creation_video',
    relPath: vRel,
    mime: 'video/mp4',
    ext: 'mp4',
    fileSize: 25,
    duration: 2,
    params: { foo: 'bar' },
    tags: ['t1'],
  })
  const iRel = relPathOf(projS!.id, 'creation_image', 'copy-ref.png')
  writeFileSync(absPathOf(iRel), Buffer.from('M22-REF-IMG-BYTES'))
  const x2 = await registerAsset(projS!.id, {
    name: '参考X2.png',
    kind: 'image',
    purpose: 'creation_image',
    relPath: iRel,
    mime: 'image/png',
    ext: 'png',
    fileSize: 16,
  })
  const [entS] = await db
    .insert(characters)
    .values({ projectId: projS!.id, kind: 'character', name: '实体E1', refAssetIds: JSON.stringify([x1.id, x2.id]), createdAt: T0, updatedAt: T0 })
    .returning()

  const s3 = await mkCanvas(projS!.id, '跨项目源')
  const d1 = await mkCanvas(projD!.id, '跨项目目标')
  const nAs = await mkNode(s3.id, { kind: 'asset', title: '素材X', assetId: x1.id, x: 100, y: 100 })
  const nGen = await mkNode(s3.id, {
    kind: 'gen',
    title: '合成X',
    x: 400,
    y: 100,
    adoptedTaskId: 77,
    spec: JSON.stringify({ genKind: 'compose', prompt: 'p', bgmAssetId: x1.id, subtitleAssetId: x2.id, align: true }),
  })
  const nEnt = await mkNode(s3.id, { kind: 'entity', title: '实体X', spec: JSON.stringify({ entityId: entS!.id }), x: 700, y: 100 })
  const nBad = await mkNode(s3.id, { kind: 'gen', title: '坏spec', spec: 'not-json', x: 1000, y: 100 })
  const nRun = await mkNode(s3.id, { kind: 'run', title: '运行X', spec: '{"runId":9}', x: 1300, y: 100 })
  const nMis = await mkNode(s3.id, { kind: 'asset', title: '缺资产', assetId: 999999, x: 1600, y: 100 })
  await db.insert(canvasEdges).values({ canvasId: s3.id, from: nAs.id, to: nGen.id, port: 'reference', createdAt: T0 })

  const r2 = await copyNodesToCanvas(s3, d1, [nAs.id, nGen.id, nEnt.id, nBad.id, nRun.id, nMis.id], null)
  check(
    r2.nodes.length === 4 && r2.skipped.length === 2 && r2.warnings.length === 1 && r2.warnings[0]!.includes('#999999'),
    '跨项目：复制 4（asset/gen/entity/坏spec）/ 跳过 2（run/缺资产）/ 警告 1（缺失留痕）',
  )
  check(
    r2.skipped.some((s) => s.nodeId === nRun.id && s.reason === 'cross_project_run_node') &&
      r2.skipped.some((s) => s.nodeId === nMis.id && s.reason === 'missing_asset'),
    '跳过原因：cross_project_run_node / missing_asset',
  )
  check(r2.assetsCopied === 2, '资产去重拷贝：X1 双引用仅一行（asset 节点 + bgm 共享）+ X2 一行 = 2')
  const cAs2 = r2.nodes.find((n) => n.title === '素材X')!
  const cGen2 = r2.nodes.find((n) => n.title === '合成X')!
  const cEnt2 = r2.nodes.find((n) => n.title === '实体X')!
  const cBad2 = r2.nodes.find((n) => n.title === '坏spec')!
  check(cAs2.assetId != null && cAs2.assetId !== x1.id && cAs2.x === 140 && cAs2.y === 140, '跨项目：asset 节点指向新资产 + 缺省偏移 +40,+40')
  check(cGen2.adoptedTaskId === null, '跨项目：adoptedTaskId 置空（任务归属不迁移）')
  const gSpec = JSON.parse(cGen2.spec!) as { bgmAssetId?: number; subtitleAssetId?: number; prompt?: string; align?: boolean }
  check(gSpec.bgmAssetId === cAs2.assetId, '跨项目：gen bgm 引用重写（与 asset 节点共享同一拷贝）')
  check(gSpec.subtitleAssetId != null && gSpec.subtitleAssetId !== x2.id, '跨项目：gen subtitle 引用重写为 X2 拷贝')
  check(gSpec.prompt === 'p' && gSpec.align === true, '跨项目：gen 其余字段保真')
  check(cBad2.spec === 'not-json', '跨项目：坏 spec 原样保真')
  check(r2.edges.length === 1 && r2.edges[0]!.from === cAs2.id && r2.edges[0]!.to === cGen2.id, '跨项目：内边端点重映射')

  const newAssets = await db.select().from(assets).where(eq(assets.projectId, projD!.id))
  check(newAssets.length === 2, '目标项目落库 2 行新资产')
  const cpX1 = newAssets.find((a) => a.name === '视频X1.mp4')!
  const paramsX1 = JSON.parse(cpX1.params ?? '{}') as { foo?: string; copiedFrom?: { projectId?: number; assetId?: number } }
  check(
    paramsX1.copiedFrom?.projectId === projS!.id && paramsX1.copiedFrom?.assetId === x1.id && paramsX1.foo === 'bar',
    'copiedFrom 留痕 + 原 params 保留',
  )
  check(cpX1.mime === 'video/mp4' && cpX1.ext === 'mp4' && cpX1.duration === 2 && JSON.parse(cpX1.tags ?? '[]').join(',') === 't1', '资产元数据保真（mime/ext/duration/tags）')
  check(cpX1.relPath != null && readFileSync(absPathOf(cpX1.relPath), 'utf8') === 'M22-COPY-BYTES-0123456789', '资产文件字节级拷贝（新落盘路径可读）')

  const newChars = await db.select().from(characters).where(eq(characters.projectId, projD!.id))
  check(newChars.length === 1 && newChars[0]!.id !== entS!.id && newChars[0]!.name === '实体E1', '实体级联：characters 新行（目标项目，新 id）')
  const newRefIds = JSON.parse(newChars[0]!.refAssetIds) as number[]
  check(newRefIds.length === 2 && !newRefIds.includes(x1.id) && !newRefIds.includes(x2.id), '实体 refAssetIds 逐张重写为拷贝 id')
  check((JSON.parse(cEnt2.spec!) as { entityId?: number }).entityId === newChars[0]!.id, 'entity 节点 spec.entityId 重写指向新实体')

  // ---- 自复制防护 ----
  let selfErr = ''
  try {
    await copyNodesToCanvas(d1, d1, [nAs.id], null)
  } catch (err) {
    selfErr = (err as Error).message
  }
  check(selfErr.includes('目标画布不能与源画布相同'), 'src=target → 抛错（同画布复制请用 /nodes/copy）')
}
