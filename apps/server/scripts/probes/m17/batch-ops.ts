/** M17[batch-ops]：批量操控（batch/delete/copy/chain/arrange/canvases-run）+ computeArrange/chainPortCandidates 纯矩阵（断言体逐字搬自原 probe-m17.ts） */
import type { M17Ctx } from './ctx'

export async function run(ctx: M17Ctx): Promise<void> {
  const {
    check, jreq, db, canvasNodes, eq, genTasks, PID, A1, A2, A3, ENT, RUN1,
    docNode, mkTask, mkAsset, computeArrange, chainPortCandidates, sleep,
  } = ctx
  {
    // ---- 纯函数：computeArrange ----
    const posEq = (p: Map<number, { x: number; y: number }>, id: number, x: number, y: number): boolean => {
      const v = p.get(id)
      return !!v && v.x === x && v.y === y
    }
    const Ln = [
      { id: 1, x: 500, y: 400, seq: null }, // 根
      { id: 2, x: 100, y: 100, seq: 2 }, // 1→2
      { id: 3, x: 200, y: 300, seq: 1 }, // 1→3
      { id: 4, x: 900, y: 900, seq: null }, // 1→2→4 与 1→4（最长路径=2）
    ]
    const Le = [
      { from: 1, to: 2 },
      { from: 1, to: 3 },
      { from: 2, to: 4 },
      { from: 1, to: 4 },
    ]
    const pl = computeArrange(Ln, { edges: Le, mode: 'layered' })
    check(
      posEq(pl, 1, 100, 100) && posEq(pl, 3, 400, 100) && posEq(pl, 2, 400, 340) && posEq(pl, 4, 700, 100),
      'computeArrange layered：最长路径层深（4 走 1→2→4 而非 1→4）+ 同层 seq 优先（C 行 0 / B 行 1）',
    )
    const Gn = [
      { id: 11, x: 500, y: 0, seq: null },
      { id: 12, x: 0, y: 400, seq: 3 },
      { id: 13, x: 300, y: 200, seq: 1 },
      { id: 14, x: 100, y: 100, seq: 2 },
      { id: 15, x: 700, y: 700, seq: null },
    ]
    const pg = computeArrange(Gn, { edges: [], mode: 'grid', sortBy: 'seq' })
    check(
      posEq(pg, 13, 0, 0) && posEq(pg, 14, 300, 0) && posEq(pg, 12, 600, 0) && posEq(pg, 11, 0, 240) && posEq(pg, 15, 300, 240),
      'computeArrange grid：cols=max(2,ceil(sqrt(5)))=3 + sortBy=seq 优先（13→14→12→11→15）',
    )
    const pg2 = computeArrange(Gn, { edges: [], mode: 'grid' })
    check(posEq(pg2, 12, 0, 0) && posEq(pg2, 14, 300, 0), 'computeArrange grid：无 sortBy → 位置序（x→y→id）')
    const An = [
      { id: 21, x: 100, y: 500, seq: null },
      { id: 22, x: 400, y: 100, seq: null },
      { id: 23, x: 250, y: 300, seq: null },
    ]
    const aL = computeArrange(An, { edges: [], mode: 'align-left' })
    check(posEq(aL, 21, 100, 500) && aL.get(22)?.x === 100 && aL.get(23)?.x === 100, 'computeArrange align-left：全列 x=minX（y 不动）')
    const aR = computeArrange(An, { edges: [], mode: 'align-right' })
    check(aR.get(21)?.x === 400 && aR.get(22)?.x === 400 && aR.get(23)?.x === 400, 'computeArrange align-right：全列 x=maxX')
    const aT = computeArrange(An, { edges: [], mode: 'align-top' })
    check(aT.get(21)?.y === 100 && aT.get(22)?.y === 100 && aT.get(23)?.y === 100, 'computeArrange align-top：全行 y=minY')
    const aB = computeArrange(An, { edges: [], mode: 'align-bottom' })
    check(aB.get(21)?.y === 500 && aB.get(22)?.y === 500 && aB.get(23)?.y === 500, 'computeArrange align-bottom：全行 y=maxY')
    const Dn = [
      { id: 31, x: 0, y: 0, seq: null },
      { id: 32, x: 10, y: 400, seq: null },
      { id: 33, x: 300, y: 100, seq: null },
    ]
    const dh = computeArrange(Dn, { edges: [], mode: 'distribute-h' })
    check(posEq(dh, 31, 0, 0) && posEq(dh, 32, 150, 400) && posEq(dh, 33, 300, 100), 'computeArrange distribute-h：中间点等距（首尾不动）')
    const dv = computeArrange(Dn, { edges: [], mode: 'distribute-v' })
    check(posEq(dv, 31, 0, 0) && posEq(dv, 33, 300, 200) && posEq(dv, 32, 10, 400), 'computeArrange distribute-v：按 y 排序中间点 y=200')
    check(computeArrange([Dn[0]!, Dn[1]!], { edges: [], mode: 'distribute-h' }).size === 0, 'computeArrange distribute：n<3 → 不移动')
    let modeThrew = false
    try {
      computeArrange(Ln, { edges: Le, mode: 'foo' })
    } catch {
      modeThrew = true
    }
    check(modeThrew, 'computeArrange：非法 mode → 抛错')

    // ---- 纯函数：chainPortCandidates ----
    check(
      JSON.stringify(chainPortCandidates({ id: 1, kind: 'text' }, { kind: 'gen', spec: { genKind: 'image', prompt: '' } })) === '["prompt"]',
      'chainPortCandidates：text → image = [prompt]',
    )
    check(
      JSON.stringify(
        chainPortCandidates({ id: 1, kind: 'gen', spec: { genKind: 'image', prompt: 'P' } }, { kind: 'gen', spec: { genKind: 'video', prompt: 'V' } }),
      ) === '["reference","first_frame"]',
      'chainPortCandidates：image → video = [reference, first_frame]（满额兜底序）',
    )
    check(
      JSON.stringify(
        chainPortCandidates({ id: 1, kind: 'gen', spec: { genKind: 'video', prompt: 'V' } }, { kind: 'gen', spec: { genKind: 'compose', prompt: '' } }),
      ) === '["video"]',
      'chainPortCandidates：video → compose = [video]',
    )
    check(chainPortCandidates({ id: 1, kind: 'text' }, { kind: 'gen', spec: { genKind: 'compose', prompt: '' } }).length === 0, 'chainPortCandidates：text → compose = []')
    check(
      chainPortCandidates({ id: 1, kind: 'entity' }, { kind: 'gen', spec: { genKind: 'image', prompt: '' } })[0] === 'reference',
      'chainPortCandidates：entity → image = [reference]（实体直通）',
    )
    check(chainPortCandidates({ id: 1, kind: 'run' }, { kind: 'gen', spec: { genKind: 'image', prompt: '' } }).length === 0, 'chainPortCandidates：run 源 = []')

    // ---- 端点：batch（整组移动 + 预校验回滚） ----
    const cB1 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '批量操控' })
    const CB1: number = cB1.body.canvas.id
    const mkNodeB1 = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${CB1}/nodes`, body)).body.node.id
    const NB1 = await mkNodeB1({ kind: 'gen', spec: { genKind: 'image', prompt: 'B1' }, x: 100, y: 100 })
    const NB2 = await mkNodeB1({ kind: 'gen', spec: { genKind: 'image', prompt: 'B2' }, x: 500, y: 100 })
    const NB3 = await mkNodeB1({ kind: 'text', spec: { text: '批量' }, x: 100, y: 400 })
    const bOk = await jreq('POST', `/api/v1/canvases/${CB1}/nodes/batch`, {
      updates: [
        { id: NB1, x: 110, y: 120 },
        { id: NB2, x: 510, y: 120 },
        { id: NB3, x: 110, y: 420 },
      ],
    })
    check(bOk.status === 200 && bOk.body?.ok === true && bOk.body?.updated === 3, 'batch：3 条整组移动 → 200 {ok,updated:3}')
    let dB = await jreq('GET', `/api/v1/canvases/${CB1}`)
    check(docNode(dB.body, NB2)?.x === 510 && docNode(dB.body, NB2)?.y === 120, 'batch：坐标落库')
    const bRollback = await jreq('POST', `/api/v1/canvases/${CB1}/nodes/batch`, {
      updates: [
        { id: NB1, x: 999, y: 999 },
        { id: NB2, seq: 0 },
      ],
    })
    check(bRollback.status === 400 && String(bRollback.body?.error?.message ?? '').includes('seq 需为 null 或正整数'), 'batch：非法项 → 400（同 PATCH 文案）')
    dB = await jreq('GET', `/api/v1/canvases/${CB1}`)
    check(docNode(dB.body, NB1)?.x === 110 && docNode(dB.body, NB1)?.y === 120, 'batch：预校验失败 → 合法条目也零写入（回滚）')
    check((await jreq('POST', `/api/v1/canvases/${CB1}/nodes/batch`, { updates: [] })).status === 400, 'batch：updates 空 → 400')
    check((await jreq('POST', `/api/v1/canvases/${CB1}/nodes/batch`, { updates: [{ id: 999999, x: 0 }] })).status === 400, 'batch：节点不存在 → 400')

    // ---- 端点：arrange（grid sortBy=seq → layered → 子集 → 错误族） ----
    check(
      (
        await jreq('POST', `/api/v1/canvases/${CB1}/nodes/batch`, {
          updates: [
            { id: NB2, seq: 1 },
            { id: NB1, seq: 2 },
            { id: NB3, seq: 3 },
          ],
        })
      ).status === 200,
      'batch：编号 seq 1..3 → 200',
    )
    const arrG = await jreq('POST', `/api/v1/canvases/${CB1}/arrange`, { mode: 'grid', sortBy: 'seq' })
    check(arrG.status === 200 && arrG.body?.updated === 3, 'arrange：grid sortBy=seq → {updated:3}')
    dB = await jreq('GET', `/api/v1/canvases/${CB1}`)
    check(
      docNode(dB.body, NB2)?.x === 110 &&
        docNode(dB.body, NB2)?.y === 120 &&
        docNode(dB.body, NB1)?.x === 410 &&
        docNode(dB.body, NB1)?.y === 120 &&
        docNode(dB.body, NB3)?.x === 110 &&
        docNode(dB.body, NB3)?.y === 360,
      'arrange grid：seq 序 2 列行优先填充 + 锚定包围盒左上角',
    )
    await jreq('POST', `/api/v1/canvases/${CB1}/edges`, { from: NB1, to: NB2, port: 'reference' })
    const arrL = await jreq('POST', `/api/v1/canvases/${CB1}/arrange`, { mode: 'layered' })
    check(arrL.status === 200 && arrL.body?.updated === 3, 'arrange：layered 全画布 → {updated:3}')
    dB = await jreq('GET', `/api/v1/canvases/${CB1}`)
    check(
      docNode(dB.body, NB1)?.x === 110 &&
        docNode(dB.body, NB1)?.y === 120 &&
        docNode(dB.body, NB3)?.x === 110 &&
        docNode(dB.body, NB3)?.y === 360 &&
        docNode(dB.body, NB2)?.x === 410 &&
        docNode(dB.body, NB2)?.y === 120,
      'arrange layered：NB2 入边 → 列 1 + 同层 seq 排序落库',
    )
    const arrSub = await jreq('POST', `/api/v1/canvases/${CB1}/arrange`, { mode: 'grid', nodeIds: [NB2, NB3] })
    check(arrSub.status === 200 && arrSub.body?.updated === 2 && arrSub.body?.positions?.length === 2, 'arrange：nodeIds 子集 → updated=2 + positions 回执')
    dB = await jreq('GET', `/api/v1/canvases/${CB1}`)
    check(
      docNode(dB.body, NB3)?.x === 110 && docNode(dB.body, NB3)?.y === 120 && docNode(dB.body, NB1)?.x === 110 && docNode(dB.body, NB1)?.y === 120,
      'arrange：子集重排落库（NB3 y 360→120）+ 子集外节点不动',
    )
    check((await jreq('POST', `/api/v1/canvases/${CB1}/arrange`, { mode: 'foo' })).status === 400, 'arrange：非法 mode → 400')
    check((await jreq('POST', `/api/v1/canvases/${CB1}/arrange`, { mode: 'layered', nodeIds: [999999] })).status === 400, 'arrange：不存在 nodeId → 400')

    // ---- 端点：copy（深拷 + 内部边重映射 + 任务归属不迁移）+ delete（级联计数） ----
    const cB2 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '删除复制' })
    const CB2: number = cB2.body.canvas.id
    const mkNodeB2 = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${CB2}/nodes`, body)).body.node.id
    const NC1 = await mkNodeB2({ kind: 'gen', spec: { genKind: 'image', prompt: 'C1' }, x: 0, y: 0 })
    const NC2 = await mkNodeB2({ kind: 'gen', spec: { genKind: 'video', prompt: 'C2' }, x: 300, y: 0 })
    const NC3 = await mkNodeB2({ kind: 'asset', assetId: A1, x: 600, y: 0 })
    const tC1 = await mkTask(PID, { canvasNodeId: NC1, status: 'succeeded', resultAssetId: A1 })
    await jreq('PATCH', `/api/v1/nodes/${NC1}`, { adoptedTaskId: tC1, seq: 5 })
    await jreq('POST', `/api/v1/canvases/${CB2}/edges`, { from: NC1, to: NC2, port: 'reference' })
    await jreq('POST', `/api/v1/canvases/${CB2}/edges`, { from: NC3, to: NC1, port: 'reference' })
    const cp = await jreq('POST', `/api/v1/canvases/${CB2}/nodes/copy`, { ids: [NC1, NC2], offset: { x: 10, y: 20 } })
    check(cp.status === 201 && cp.body?.nodes?.length === 2 && cp.body?.edges?.length === 1, 'copy：2 节点 + 内部边 1 条 → 201（跨集合边不复制）')
    const CP1: number = cp.body.nodes[0].id
    const CP2: number = cp.body.nodes[1].id
    check(
      cp.body.nodes[0].x === 10 && cp.body.nodes[0].y === 20 && cp.body.nodes[0].seq === 5 && cp.body.nodes[0].adoptedTaskId === tC1,
      'copy：位置偏移 + seq/adoptedTaskId 深拷',
    )
    check(cp.body.edges[0].from === CP1 && cp.body.edges[0].to === CP2 && cp.body.edges[0].port === 'reference', 'copy：内部边重映射重建')
    dB = await jreq('GET', `/api/v1/canvases/${CB2}`)
    check(
      docNode(dB.body, CP1)?.adoptedTaskId === tC1 && docNode(dB.body, CP1)?.displayTaskId === null,
      'copy：任务归属不迁移（adoptedTaskId 深拷 / displayTaskId 派生 null）',
    )
    const cp2 = await jreq('POST', `/api/v1/canvases/${CB2}/nodes/copy`, { ids: [NC3] })
    check(cp2.status === 201 && cp2.body?.nodes?.[0]?.x === 640 && cp2.body?.nodes?.[0]?.y === 40, 'copy：offset 缺省 +40,+40')
    check((await jreq('POST', `/api/v1/canvases/${CB2}/nodes/copy`, { ids: [NC1], offset: { x: 'a' } })).status === 400, 'copy：非法 offset → 400')
    const del = await jreq('POST', `/api/v1/canvases/${CB2}/nodes/delete`, { ids: [NC1, NC2] })
    check(del.status === 200 && del.body?.deleted === 2 && del.body?.edges === 2, 'delete：级联边计数 → {deleted:2,edges:2}')
    dB = await jreq('GET', `/api/v1/canvases/${CB2}`)
    check(docNode(dB.body, NC1) === undefined, 'delete：节点已移除')
    check((await jreq('POST', `/api/v1/canvases/${CB2}/nodes/delete`, { ids: [NC1] })).status === 400, 'delete：含已删节点 → 400')

    // ---- 端点：快照重建认领（restoreFromNodeId：gen 任务历史迁移 + 前置校验不残留） ----
    const NR1 = await mkNodeB2({ kind: 'gen', spec: { genKind: 'image', prompt: 'R1' }, x: 0, y: 600 })
    const tR1 = await mkTask(PID, { canvasNodeId: NR1, status: 'succeeded', resultAssetId: A1 })
    await mkTask(PID, { canvasNodeId: NR1, status: 'failed' })
    await jreq('POST', `/api/v1/canvases/${CB2}/nodes/delete`, { ids: [NR1] })
    const rc = await jreq('POST', `/api/v1/canvases/${CB2}/nodes`, {
      kind: 'gen',
      spec: { genKind: 'image', prompt: 'R1' },
      x: 0,
      y: 600,
      restoreFromNodeId: NR1,
    })
    check(rc.status === 201 && rc.body?.claimed === 2, 'restore-claim：重建认领全部任务历史 → {claimed:2}')
    const rcId: number = rc.body.node.id
    check(
      (await jreq('PATCH', `/api/v1/nodes/${rcId}`, { adoptedTaskId: tR1 })).status === 200,
      'restore-claim：认领后采纳 PATCH 通过（任务归属已随重建迁移）',
    )
    dB = await jreq('GET', `/api/v1/canvases/${CB2}`)
    check(docNode(dB.body, rcId)?.displayTaskId === tR1, 'restore-claim：读模型 displayTaskId 恢复为采纳任务')
    const cntBefore = dB.body.nodes.length
    const rcBad = await jreq('POST', `/api/v1/canvases/${CB2}/nodes`, {
      kind: 'gen',
      spec: { genKind: 'image', prompt: 'X' },
      x: 0,
      y: 900,
      restoreFromNodeId: rcId,
    })
    dB = await jreq('GET', `/api/v1/canvases/${CB2}`)
    check(rcBad.status === 400 && dB.body.nodes.length === cntBefore, 'restore-claim：源节点存活 → 400 且不残留新节点（前置校验）')
    check(
      (await jreq('POST', `/api/v1/canvases/${CB2}/nodes`, { kind: 'text', spec: { text: 'T' }, x: 0, y: 900, restoreFromNodeId: 999999 })).status === 400,
      'restore-claim：非 gen 目标 → 400',
    )

    // ---- 端点：chain（规则矩阵 + skip 全因） ----
    const cB3 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '串联规则' })
    const CB3: number = cB3.body.canvas.id
    const mkNodeB3 = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${CB3}/nodes`, body)).body.node.id
    const chainPair = (a: number, b: number) => jreq('POST', `/api/v1/canvases/${CB3}/nodes/chain`, { ids: [a, b] })
    const A4 = await mkAsset(PID, 'image', '图丁', 'creation')
    const NT1 = await mkNodeB3({ kind: 'text', spec: { text: '串联词' }, x: 0, y: 0 })
    const NT2 = await mkNodeB3({ kind: 'text', spec: { text: '串联词2' }, x: 0, y: 100 })
    const NEntB = await mkNodeB3({ kind: 'entity', entityId: ENT, x: 100, y: 300 })
    const NGImg = await mkNodeB3({ kind: 'gen', spec: { genKind: 'image', prompt: 'G' }, x: 300, y: 0 })
    const NGImgBad = await mkNodeB3({ kind: 'gen', spec: { genKind: 'image', prompt: 'G2' }, x: 300, y: 300 })
    const NGVid = await mkNodeB3({ kind: 'gen', spec: { genKind: 'video', prompt: 'V' }, x: 600, y: 0 })
    const NGAud = await mkNodeB3({ kind: 'gen', spec: { genKind: 'audio', prompt: 'A' }, x: 300, y: 200 })
    const NGComp = await mkNodeB3({ kind: 'gen', spec: { genKind: 'compose' }, x: 900, y: 0 })
    const NGComp2 = await mkNodeB3({ kind: 'gen', spec: { genKind: 'compose' }, x: 900, y: 200 })
    const NRunB = await mkNodeB3({ kind: 'run', runId: RUN1, x: 1200, y: 0 })
    const NImg1 = await mkNodeB3({ kind: 'asset', assetId: A1, x: 0, y: 500 })
    const NImg2 = await mkNodeB3({ kind: 'asset', assetId: A2, x: 0, y: 600 })
    const NImg3 = await mkNodeB3({ kind: 'asset', assetId: A3, x: 0, y: 700 })
    const NImg4 = await mkNodeB3({ kind: 'asset', assetId: A4, x: 0, y: 800 })
    const ch1 = await chainPair(NT1, NGImg)
    check(ch1.body?.created?.length === 1 && ch1.body.created[0].port === 'prompt' && ch1.body?.skipped?.length === 0, 'chain：text → image = prompt 边')
    const ch2 = await chainPair(NT1, NGImg)
    check(ch2.body?.created?.length === 0 && ch2.body?.skipped?.[0]?.reason === '该连线已存在', 'chain：重复对 → skip「该连线已存在」')
    const ch3 = await chainPair(NImg1, NGImg)
    check(ch3.body?.created?.[0]?.port === 'reference', 'chain：图片素材 → image = reference 边')
    const ch4 = await chainPair(NImg1, NGVid)
    const ch5 = await chainPair(NImg2, NGVid)
    check(ch4.body?.created?.[0]?.port === 'reference' && ch5.body?.created?.[0]?.port === 'reference', 'chain：图片 → video reference ×2')
    const ch6 = await chainPair(NImg3, NGVid)
    check(ch6.body?.created?.[0]?.port === 'first_frame', 'chain：reference 满额（2 张）→ first_frame 兜底')
    const ch7 = await chainPair(NImg4, NGVid)
    check(ch7.body?.created?.length === 0 && ch7.body?.skipped?.[0]?.reason === '首帧最多 1 条', 'chain：reference+first_frame 双满 → skip')
    const ch8 = await chainPair(NGAud, NGComp)
    check(ch8.body?.created?.[0]?.port === 'audio', 'chain：音频 → compose = audio 边')
    const ch8b = await chainPair(NT2, NGAud)
    check(ch8b.body?.created?.[0]?.port === 'prompt', 'chain：text → audio = prompt 边')
    const ch9 = await chainPair(NGVid, NGComp)
    check(ch9.body?.created?.[0]?.port === 'video', 'chain：视频 → compose = video 边')
    const ch10 = await chainPair(NT1, NGComp)
    check(ch10.body?.skipped?.[0]?.reason === '类型不符（text → compose）', 'chain：text → compose = 类型不符 skip')
    const ch11 = await chainPair(NGImg, NGComp)
    check(ch11.body?.skipped?.[0]?.reason === '类型不符（image → compose）', 'chain：image → compose = 类型不符 skip')
    const ch12 = await chainPair(NEntB, NGImg)
    check(ch12.body?.created?.[0]?.port === 'reference', 'chain：entity → image = reference 边')
    await jreq('POST', `/api/v1/canvases/${CB3}/edges`, { from: NGComp, to: NGComp2, port: 'video' })
    const ch13 = await chainPair(NGComp2, NGComp)
    check(ch13.body?.created?.length === 0 && String(ch13.body?.skipped?.[0]?.reason ?? '').includes('循环引用'), 'chain：环 → skip（环检测文案）')
    const ch14 = await chainPair(NRunB, NGImg)
    check(ch14.body?.skipped?.[0]?.reason === '运行节点不参与连线', 'chain：run 作源 → skip')
    const ch15 = await chainPair(NGImg, NRunB)
    check(ch15.body?.skipped?.[0]?.reason === '运行节点不参与连线', 'chain：run 作目标 → skip')
    const ch16 = await chainPair(NGImg, NT2)
    check(ch16.body?.skipped?.[0]?.reason === '仅生成节点可接收连线', 'chain：gen → text 目标 → skip')
    await db.update(canvasNodes).set({ spec: '{bad' }).where(eq(canvasNodes.id, NGImgBad))
    const ch17 = await chainPair(NImg1, NGImgBad)
    check(ch17.body?.skipped?.[0]?.reason === '目标节点 spec 损坏，无法连线', 'chain：目标 spec 损坏 → skip')
    const ch18 = await jreq('POST', `/api/v1/canvases/${CB3}/nodes/chain`, { ids: [NT1, NGImg, NGVid] })
    check(ch18.body?.created?.length === 0 && ch18.body?.skipped?.length === 2, 'chain：多对串联逐对记账（失败不中断）')

    // ---- 端点：canvases/run（批量执行：started/skipped + P2 守卫 + 收敛等待） ----
    const cB4 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '批量执行' })
    const CB4: number = cB4.body.canvas.id
    const mkNodeB4 = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${CB4}/nodes`, body)).body.node.id
    const GReady = await mkNodeB4({ kind: 'gen', spec: { genKind: 'image', prompt: 'R' }, x: 0, y: 0 })
    const GEmpty = await mkNodeB4({ kind: 'gen', spec: { genKind: 'image', prompt: '' }, x: 0, y: 100 })
    const GAudio = await mkNodeB4({ kind: 'gen', spec: { genKind: 'audio', prompt: 'A' }, x: 0, y: 200 })
    const NTextR = await mkNodeB4({ kind: 'text', spec: { text: 't' }, x: 0, y: 300 })
    const GBusy = await mkNodeB4({ kind: 'gen', spec: { genKind: 'image', prompt: 'BUSY' }, x: 0, y: 400 })
    const tBusy = await mkTask(PID, { canvasNodeId: GBusy, status: 'pending' })
    const run0 = await jreq('POST', `/api/v1/canvases/${CB4}/run`, {})
    check(
      run0.status === 200 &&
        run0.body?.started?.length === 2 &&
        run0.body.started[0].nodeId === GReady &&
        run0.body.started[0].taskId > 0 &&
        JSON.stringify(run0.body.started[0].taskIds) === JSON.stringify([run0.body.started[0].taskId]) &&
        run0.body.started[1].nodeId === GAudio,
      'canvases/run：缺省全量 gen → 就绪入队（started 2：图片 + 音频通道 P3 接入；taskIds 超集）',
    )
    const skip0 = new Map<number, string[]>(run0.body.skipped.map((s: any) => [s.nodeId, s.problems]))
    check(skip0.get(GEmpty)?.[0] === 'prompt 为空', 'canvases/run skip：未就绪 problems 拆表（prompt 为空）')
    check(skip0.get(GBusy)?.[0]?.includes('节点已有进行中的任务') === true, 'canvases/run skip：忙碌节点（已有 pending 任务）')
    check(skip0.size === 2, 'canvases/run skip：2 条（未就绪/忙碌）')
    const run1 = await jreq('POST', `/api/v1/canvases/${CB4}/run`, { nodeIds: [GReady, GEmpty, GAudio, NTextR, GBusy] })
    check(run1.status === 200 && run1.body?.started?.length === 0 && run1.body?.skipped?.length === 5, 'canvases/run：显式 ids → 全部 skip（含进行中 busy）')
    const skip1 = new Map<number, string[]>(run1.body.skipped.map((s: any) => [s.nodeId, s.problems]))
    check(skip1.get(GReady)?.[0]?.includes('节点已有进行中的任务') === true, 'canvases/run：刚入队节点 → busy skip')
    check(skip1.get(GAudio)?.[0]?.includes('节点已有进行中的任务') === true, 'canvases/run：音频入队节点 → busy skip（P3 通道放行）')
    check(skip1.get(NTextR)?.[0] === '仅生成节点可执行', 'canvases/run：text 节点 → 仅生成节点可执行')
    const run2 = await jreq('POST', `/api/v1/canvases/${CB4}/run`)
    check(run2.status === 200 && Array.isArray(run2.body?.started) && Array.isArray(run2.body?.skipped), 'canvases/run：无 body → 200（宽容读体，缺省全画布）')
    const run3 = await jreq('POST', `/api/v1/canvases/${CB4}/run`, { nodeIds: [GEmpty], variants: 2 })
    check(
      run3.status === 200 && run3.body?.started?.length === 0 && run3.body?.skipped?.[0]?.problems?.[0] === 'prompt 为空',
      'canvases/run：variants=2 → 200（P3 放行；未就绪仍 skip）',
    )
    check((await jreq('POST', `/api/v1/canvases/${CB4}/run`, { variants: 5 })).status === 400, 'canvases/run：variants=5 → 400（范围校验）')
    check((await jreq('POST', `/api/v1/canvases/${CB4}/run`, { nodeIds: [NB1] })).status === 400, 'canvases/run：跨画布 nodeId → 400')
    const settleId: number = run0.body.started[0].taskId
    const deadline = Date.now() + 25_000
    let st = ''
    for (;;) {
      const rows = await db.select({ status: genTasks.status }).from(genTasks).where(eq(genTasks.id, settleId)).limit(1)
      st = rows[0]?.status ?? 'missing'
      if (st === 'succeeded' || st === 'failed' || st === 'cancelled') break
      if (Date.now() > deadline) break
      await sleep(400)
    }
    check(st === 'succeeded' || st === 'failed', `canvases/run：入队任务收敛到终态（${st}）`)
    await db.delete(genTasks).where(eq(genTasks.id, tBusy))
  }
}
