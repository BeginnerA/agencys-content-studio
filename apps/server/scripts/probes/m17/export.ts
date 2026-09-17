/** M17[export]：真实文件 zip（条目命名/重名递增/seq 序 + manifest + skipped + 采纳优先 + 错误族 + 下载）（断言体逐字搬自原 probe-m17.ts） */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import type { M17Ctx } from './ctx'

export async function run(ctx: M17Ctx): Promise<void> {
  const { check, jreq, db, assets, eq, PID, ENT, RUN1, mkAsset, mkTask, docNode, T0, absPathOf, ensureProjectDirs } = ctx
  {
    ensureProjectDirs(PID)
    const relP1 = join(String(PID), 'source', 'export-probe-1.png')
    const relP2 = join(String(PID), 'source', 'export-probe-2.png')
    const relP3 = join(String(PID), 'source', 'export-probe-3.png')
    writeFileSync(absPathOf(relP1), Buffer.from('PNG-ONE'))
    writeFileSync(absPathOf(relP2), Buffer.from('PNG-TWO'))
    writeFileSync(absPathOf(relP3), Buffer.from('PNG-THREE'))
    const PE1 = await mkAsset(PID, 'image', '导出图甲')
    const PE2 = await mkAsset(PID, 'image', '导出图乙')
    const PE3 = await mkAsset(PID, 'image', '导出图丙')
    const PE_DEL = await mkAsset(PID, 'image', '软删图')
    const PE_NOREL = await mkAsset(PID, 'image', '无路径图')
    const PE_MISS = await mkAsset(PID, 'image', '缺文件图')
    await db.update(assets).set({ relPath: relP1, ext: 'png' }).where(eq(assets.id, PE1))
    await db.update(assets).set({ relPath: relP2, ext: 'png' }).where(eq(assets.id, PE2))
    await db.update(assets).set({ relPath: relP3, ext: 'png' }).where(eq(assets.id, PE3))
    await db.update(assets).set({ relPath: join(String(PID), 'source', 'gone.png') }).where(eq(assets.id, PE_MISS))

    const c1 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '导出画布' })
    const CE: number = c1.body.canvas.id
    const mkNode = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${CE}/nodes`, body)).body.node.id
    const ET1 = await mkNode({ kind: 'text', spec: { text: '导出文本甲' }, x: 0, y: 0 })
    const ET2 = await mkNode({ kind: 'text', spec: { text: '导出文本乙' }, x: 0, y: 100 })
    const ET3 = await mkNode({ kind: 'text', spec: { text: '重名甲' }, x: 300, y: 0 })
    const ET4 = await mkNode({ kind: 'text', spec: { text: '重名乙' }, x: 300, y: 100 })
    const EA = await mkNode({ kind: 'asset', assetId: PE3, x: 0, y: 200 })
    const EA_DEL = await mkNode({ kind: 'asset', assetId: PE_DEL, x: 0, y: 300 })
    // 软删须在节点创建之后（addAssetNode → assertProjectAssets 拒绝软删资产）；导出侧走 skip 记账
    await db.update(assets).set({ deletedAt: T0 }).where(eq(assets.id, PE_DEL))
    const EA_NOREL = await mkNode({ kind: 'asset', assetId: PE_NOREL, x: 0, y: 400 })
    const EA_MISS = await mkNode({ kind: 'asset', assetId: PE_MISS, x: 0, y: 500 })
    const EG = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: '导出生成' }, x: 600, y: 600 })
    const EG_NONE = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: '无产物' }, x: 600, y: 700 })
    const ENE = await mkNode({ kind: 'entity', entityId: ENT, x: 900, y: 900 })
    const ENR = await mkNode({ kind: 'run', runId: RUN1, x: 900, y: 1000 })
    for (const [id, title, seq] of [
      [ET1, '文案A', 1],
      [ET2, '文案A', 2],
      [ET3, '同名', null],
      [ET4, '同名', null],
      [EA, '导出图丙', null],
      [EG, '生成甲', null],
    ] as Array<[number, string, number | null]>) {
      await jreq('PATCH', `/api/v1/nodes/${id}`, { title, seq })
    }
    const tG1 = await mkTask(PID, { canvasNodeId: EG, status: 'succeeded', resultAssetId: PE1 })
    await mkTask(PID, { canvasNodeId: EG, status: 'succeeded', resultAssetId: PE2 })

    // ---- 全量导出（无 body 宽容读体） ----
    const ex1 = await jreq('POST', `/api/v1/canvases/${CE}/export`)
    check(
      ex1.status === 201 && ex1.body?.stats?.packed === 6 && ex1.body?.stats?.skipped === 6 && ex1.body?.asset?.id > 0,
      `export：全量打包 → 201（packed 6 / skipped 6；实际 ${JSON.stringify(ex1.body?.stats)}）`,
    )
    check(
      String(ex1.body?.asset?.name ?? '').startsWith('导出画布-export-') && String(ex1.body?.asset?.name ?? '').endsWith('.zip'),
      'export：zip 命名 <画布名>-export-<ts>.zip',
    )
    const zipRow = (await db.select().from(assets).where(eq(assets.id, ex1.body.asset.id)))[0]!
    check(zipRow.kind === 'archive' && zipRow.purpose === 'creation_export' && zipRow.mime === 'application/zip' && zipRow.ext === 'zip', 'export：资产登记 archive/creation_export/zip')
    const entries = unzipSync(new Uint8Array(readFileSync(absPathOf(zipRow.relPath!))))
    const names = Object.keys(entries)
    check(names.length === 7 && names.includes('manifest.json'), 'export：zip 条目 7（manifest + 6 文件）')
    const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']!))
    check(manifest.version === 1 && manifest.canvas?.id === CE && manifest.canvas?.name === '导出画布', 'export：manifest 头（version/canvas）')
    check(manifest.files?.length === 6 && manifest.skipped?.length === 6, 'export：manifest files/skipped 计数')
    const fNames: string[] = manifest.files.map((f: any) => f.fileName)
    check(fNames[0] === '1-文案A.txt' && fNames[1] === '2-文案A.txt', 'export：seq 序条目名 <seq>-<title>.txt')
    check(
      manifest.files[0].seq === 1 && manifest.files[0].kind === 'text' && manifest.files[0].assetId === null && manifest.files[0].size === new TextEncoder().encode('导出文本甲').byteLength,
      'export：manifest 条目字段（seq/kind/assetId/size）',
    )
    const dec = (n: string): string => new TextDecoder().decode(entries[n]!)
    check(dec('同名.txt') === '重名甲' && dec('同名-1.txt') === '重名乙', 'export：重名递增（-1）且顺序稳定（x→y）')
    check(fNames.includes(`导出图丙-${PE3}.png`) && dec(`导出图丙-${PE3}.png`) === 'PNG-THREE', 'export：asset 节点条目名 <title>-<assetId>.ext + 内容')
    check(manifest.files.some((f: any) => f.kind === 'gen' && f.assetId === PE2 && f.fileName === `生成甲-${PE2}.png`), 'export：gen 默认打包最新成功产物（PE2）')
    const skipReasons: string[] = manifest.skipped.map((s: any) => `${s.nodeId}:${s.reason}`)
    check(skipReasons.includes(`${EA_DEL}:资产 #${PE_DEL} 已删除`), 'export：软删资产 → skipped 已删除')
    check(skipReasons.includes(`${EA_NOREL}:资产 #${PE_NOREL} 无本地文件`), 'export：无 relPath → skipped 无本地文件')
    check(skipReasons.includes(`${EA_MISS}:资产 #${PE_MISS} 文件缺失`), 'export：文件缺失 → skipped 文件缺失')
    check(skipReasons.includes(`${EG_NONE}:暂无成功产物`), 'export：gen 无产物 → skipped 暂无成功产物')
    check(skipReasons.includes(`${ENE}:实体节点不参与打包`) && skipReasons.includes(`${ENR}:运行节点不参与打包`), 'export：entity/run → skipped 记账')
    check((await jreq('GET', `/api/v1/assets/${zipRow.id}/file?download=1`)).status === 200, 'export：下载链路 GET /assets/:id/file?download=1 → 200')

    // ---- 采纳优先：PATCH EG → tG1（PE1）→ 子集导出 ----
    check((await jreq('PATCH', `/api/v1/nodes/${EG}`, { adoptedTaskId: tG1 })).status === 200, 'export 前置：采纳 tG1（PE1）→ 200')
    const ex2 = await jreq('POST', `/api/v1/canvases/${CE}/export`, { nodeIds: [ET1, EG] })
    check(ex2.status === 201 && ex2.body?.stats?.packed === 2 && ex2.body?.stats?.skipped === 0, 'export：子集导出 → packed 2 / skipped 0')
    const zip2Row = (await db.select().from(assets).where(eq(assets.id, ex2.body.asset.id)))[0]!
    const entries2 = unzipSync(new Uint8Array(readFileSync(absPathOf(zip2Row.relPath!))))
    const manifest2 = JSON.parse(new TextDecoder().decode(entries2['manifest.json']!))
    check(
      manifest2.files.some((f: any) => f.kind === 'gen' && f.assetId === PE1 && f.fileName === `生成甲-${PE1}.png`),
      'export：采纳后打包采纳产物（PE1）+ 条目名随采纳切换',
    )
    check(manifest2.files.length === 2 && manifest2.skipped.length === 0, 'export：子集 manifest（2 files / 0 skipped）')

    // ---- 错误族 ----
    const bad1 = await jreq('POST', `/api/v1/canvases/${CE}/export`, { nodeIds: [] })
    check(bad1.status === 400 && String(bad1.body?.error?.message ?? '').includes('nodeIds 为空数组'), 'export：空数组 → 400（引导省略字段）')
    const bad2 = await jreq('POST', `/api/v1/canvases/${CE}/export`, { nodeIds: [999999] })
    check(bad2.status === 400 && String(bad2.body?.error?.message ?? '').includes('不存在或不属于该画布'), 'export：未知节点 → 400')
    const bad3 = await jreq('POST', `/api/v1/canvases/${CE}/export`, { nodeIds: 'x' })
    check(bad3.status === 400 && String(bad3.body?.error?.message ?? '').includes('nodeIds 需为正整数数组'), 'export：非数组 → 400')
  }
}
