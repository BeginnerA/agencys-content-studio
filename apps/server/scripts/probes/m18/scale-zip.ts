/** M18[P6] scale-zip：封面派生矩阵 + 流式 zip 对拍（名称/数量/内容等价 + 大文件路径）（断言体逐字搬自原 probe-m18.ts） */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { M18Ctx } from './ctx'

export async function run(ctx: M18Ctx): Promise<void> {
  const { check, db, mkProject, mkAsset, jreq, genTasks, relPathOf, absPathOf, assets, eq, T0 } = ctx
  const { unzipSync, strFromU8 } = await import('fflate')
  const { exportCanvas } = await import('../../../src/services/creation/export')
  const { listCanvases } = await import('../../../src/services/creation')

  // ===== cover 派生 =====
  const PID = await mkProject('M18 规模')
  const addN = async (cid: number, body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${cid}/nodes`, body)).body.node.id
  const C = (await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '规模画布' })).body.canvas.id
  const NG = await addN(C, { kind: 'gen', spec: { genKind: 'image', prompt: 'x' }, x: 0, y: 0 })
  const oldA = await mkAsset(PID, 'image', '旧产物', {})
  const newA = await mkAsset(PID, 'image', '新产物', {})
  const mkTask = async (assetId: number, completedAt: number): Promise<void> => {
    await db.insert(genTasks).values({
      projectId: PID, canvasNodeId: NG, kind: 'image', params: '{}', status: 'succeeded',
      resultAssetId: assetId, completedAt, createdAt: T0, updatedAt: completedAt,
    })
  }
  await mkTask(oldA, 1_000)
  await mkTask(newA, 5_000)
  const itemC = (await listCanvases(PID)).find((x) => x.id === C)
  check(itemC?.cover?.id === newA, 'cover：多 succeeded 任务取最近完成产物（max completedAt）')

  const C0 = (await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '空画布' })).body.canvas.id
  await addN(C0, { kind: 'gen', spec: { genKind: 'image', prompt: 'y' }, x: 0, y: 0 })
  check((await listCanvases(PID)).find((x) => x.id === C0)?.cover === null, 'cover：无成功产物 → null')

  await jreq('DELETE', `/api/v1/canvases/${C}`) // 软删
  check(
    (await listCanvases(PID, { trash: true })).find((x) => x.id === C)?.cover?.id === newA,
    'cover：回收站列表同样派生封面',
  )

  // ===== 流式 zip 对拍 =====
  const PZ = await mkProject('M18 zip')
  const CZ = (await jreq('POST', `/api/v1/projects/${PZ}/canvases`, { name: '打包画布' })).body.canvas.id
  const addZ = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${CZ}/nodes`, body)).body.node.id
  const TXT_CONTENT = '文本内容α\nβ'
  await addZ({ kind: 'text', spec: { text: TXT_CONTENT }, x: 0, y: 0, title: '说明' })
  const pngRel = relPathOf(PZ, 'creation_ref', 'pack.png')
  mkdirSync(dirname(absPathOf(pngRel)), { recursive: true })
  writeFileSync(
    absPathOf(pngRel),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  )
  const IMG = await mkAsset(PZ, 'image', '素材图', { relPath: pngRel })
  await addZ({ kind: 'asset', assetId: IMG, x: 100, y: 0, title: '素材图' })
  // 大文件 ~30MB 走 store 流式路径
  const bigRel = relPathOf(PZ, 'creation_ref', 'big.bin')
  writeFileSync(absPathOf(bigRel), Buffer.alloc(30 * 1024 * 1024, 7))
  const BIG = await mkAsset(PZ, 'image', '大图', { relPath: bigRel })
  await addZ({ kind: 'asset', assetId: BIG, x: 200, y: 0, title: '大图' })
  // 软删资产 → skipped 记账（先建正常节点，导出前再软删；建节点时资产尚在→不拒）
  const deadA = await mkAsset(PZ, 'image', '死链', { relPath: pngRel })
  await addZ({ kind: 'asset', assetId: deadA, x: 300, y: 0, title: '死链' })
  await db.update(assets).set({ deletedAt: T0 }).where(eq(assets.id, deadA))

  const ex = await exportCanvas(CZ)
  check(ex !== null && ex.stats.packed === 3 && ex.stats.skipped === 1, '导出：3 打包 + 1 skipped（软删资产）')
  const zipBytes = readFileSync(absPathOf(ex!.asset.relPath as string))
  const unz = unzipSync(new Uint8Array(zipBytes))
  const names = Object.keys(unz)
  check(names.includes('manifest.json'), 'zip：manifest.json 存在')
  const mf = JSON.parse(strFromU8(unz['manifest.json']))
  check(mf.files.length === 3 && mf.skipped.length === 1 && mf.canvas.id === CZ, 'manifest：files 3 / skipped 1 / canvas 一致')
  const textEntry = names.find((n) => n.endsWith('.txt'))
  check(textEntry != null && strFromU8(unz[textEntry]) === TXT_CONTENT, 'zip：文本条目内容逐字节等价')
  const imgEntry = names.find((n) => n.endsWith('.png'))
  check(
    imgEntry != null && Array.from(unz[imgEntry]).join() === Array.from(readFileSync(absPathOf(pngRel))).join(),
    'zip：媒体条目 store 内容等价',
  )
  const bigEntry = names.find((n) => n.endsWith('.bin'))
  check(
    bigEntry != null && unz[bigEntry].length === 30 * 1024 * 1024 && unz[bigEntry][0] === 7 && unz[bigEntry][unz[bigEntry].length - 1] === 7,
    'zip：30MB 流式 store 长度/字节等价',
  )
  check(ex!.asset.kind === 'archive' && ex!.asset.purpose === 'creation_export', '导出资产登记：archive / creation_export')
}
