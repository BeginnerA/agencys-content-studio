/** M17[port-v2]：端口矩阵 v2 全组合 + run 拒连 + 环/自环/跨画布/重复边回归（断言体逐字搬自原 probe-m17.ts） */
import type { M17Ctx } from './ctx'

export async function run(ctx: M17Ctx): Promise<void> {
  const { check, jreq, db, canvasNodes, eq, PID, A1, AV, AA, AT, ENT, RUN1 } = ctx
  {
    const c1 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '端口矩阵 v2' })
    const C: number = c1.body.canvas.id
    const mkNode = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${C}/nodes`, body)).body.node.id
    const edge = (from: number, to: number, port: string) => jreq('POST', `/api/v1/canvases/${C}/edges`, { from, to, port })

    const NAI = await mkNode({ kind: 'asset', assetId: A1, x: 0, y: 0 }) // 图片素材
    const NAV = await mkNode({ kind: 'asset', assetId: AV, x: 0, y: 100 }) // 视频素材
    const NAA = await mkNode({ kind: 'asset', assetId: AA, x: 0, y: 200 }) // 音频素材
    const NAT = await mkNode({ kind: 'asset', assetId: AT, x: 0, y: 300 }) // 文本资产节点
    const NT = await mkNode({ kind: 'text', spec: { text: '提示词甲' }, x: 100, y: 0 })
    const NT2 = await mkNode({ kind: 'text', spec: { text: '提示词乙' }, x: 100, y: 100 })
    const NE = await mkNode({ kind: 'entity', entityId: ENT, x: 100, y: 200 })
    const NGI = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: 'P' }, x: 300, y: 0 })
    const NGV = await mkNode({ kind: 'gen', spec: { genKind: 'video', prompt: 'V' }, x: 300, y: 100 })
    const NGA = await mkNode({ kind: 'gen', spec: { genKind: 'audio', prompt: '朗读' }, x: 300, y: 200 })
    const NGC = await mkNode({ kind: 'gen', spec: { genKind: 'compose' }, x: 300, y: 300 })
    const NGC2 = await mkNode({ kind: 'gen', spec: { genKind: 'compose' }, x: 300, y: 400 })
    const NRun = await mkNode({ kind: 'run', runId: RUN1, x: 600, y: 0 })

    // ---- reference：图片素材 / entity 源 + from 侧类型 ----
    check((await edge(NAI, NGI, 'reference')).status === 201, 'reference：图片素材 → image gen → 201')
    check((await edge(NE, NGI, 'reference')).status === 201, 'reference：entity → image gen → 201')
    check((await edge(NE, NGV, 'reference')).status === 201, 'reference：entity → video gen → 201')
    const eRefBad = await edge(NGV, NGI, 'reference')
    check(
      eRefBad.status === 400 && String(eRefBad.body?.error?.message ?? '').includes('参考图来源需为图片素材/生成图/实体节点'),
      'reference：视频 gen 源 → 400（from 侧文案=期望类型清单）',
    )
    check((await edge(NGA, NGI, 'reference')).status === 400, 'reference：音频 gen 源 → 400')
    check((await edge(NT, NGI, 'reference')).status === 400, 'reference：文本节点源 → 400')
    check((await edge(NGI, NGV, 'reference')).status === 201, 'reference：图片 gen → video gen（第 2 条）→ 201')
    const NGI2 = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: 'P2' }, x: 300, y: 500 })
    check((await edge(NGI2, NGV, 'reference')).status === 400, 'reference：video gen 第 3 条 → 400（上限 2）')

    // ---- prompt：仅 text 节点源 × image/video/audio 目标 ----
    check((await edge(NT, NGI, 'prompt')).status === 201, 'prompt：text → image gen → 201')
    check((await edge(NT, NGI, 'prompt')).status === 400, 'prompt：重复边 → 400')
    check((await edge(NT2, NGI, 'prompt')).status === 400, 'prompt：同目标第二条 → 400（≤1）')
    check((await edge(NT, NGA, 'prompt')).status === 201, 'prompt：text → audio gen → 201')
    check((await edge(NT, NGC, 'prompt')).status === 400, 'prompt：compose 目标 → 400（仅 image/video/audio）')
    check((await edge(NAI, NGV, 'prompt')).status === 400, 'prompt：图片素材源 → 400（仅文本节点）')
    check((await edge(NAT, NGA, 'prompt')).status === 400, 'prompt：文本资产节点源 → 400（仅文本节点）')
    check((await edge(NE, NGA, 'prompt')).status === 400, 'prompt：实体源 → 400')

    // ---- video：仅 compose 目标 × 视频素材/视频 gen/compose 源 ----
    check((await edge(NAV, NGC, 'video')).status === 201, 'video：视频素材 → compose → 201')
    check((await edge(NGV, NGC, 'video')).status === 201, 'video：视频 gen → compose → 201')
    check((await edge(NGC2, NGC, 'video')).status === 201, 'video：compose 产视频 → compose → 201（链式）')
    check((await edge(NAI, NGC, 'video')).status === 400, 'video：图片素材源 → 400（from 侧类型）')
    check((await edge(NAI, NGI, 'video')).status === 400, 'video：非 compose 目标 → 400')
    const NGV2 = await mkNode({ kind: 'gen', spec: { genKind: 'video', prompt: 'V2' }, x: 300, y: 600 })
    check((await edge(NGV2, NGC, 'video')).status === 201, 'video：第 4 条 → 201')
    const NGV3 = await mkNode({ kind: 'gen', spec: { genKind: 'video', prompt: 'V3' }, x: 300, y: 700 })
    check((await edge(NGV3, NGC, 'video')).status === 400, 'video：第 5 条 → 400（上限 4）')

    // ---- audio：仅 compose 目标 × 音频素材/音频 gen 源 ----
    check((await edge(NAA, NGC, 'audio')).status === 201, 'audio：音频素材 → compose → 201')
    check((await edge(NGA, NGC, 'audio')).status === 201, 'audio：音频 gen → compose → 201')
    check((await edge(NAV, NGC, 'audio')).status === 400, 'audio：视频素材源 → 400（from 侧类型）')
    check((await edge(NAA, NGI, 'audio')).status === 400, 'audio：非 compose 目标 → 400')
    const NGA3 = await mkNode({ kind: 'gen', spec: { genKind: 'audio', prompt: 'A3' }, x: 300, y: 800 })
    const NGA4 = await mkNode({ kind: 'gen', spec: { genKind: 'audio', prompt: 'A4' }, x: 300, y: 900 })
    check(
      (await edge(NGA3, NGC, 'audio')).status === 201 && (await edge(NGA4, NGC, 'audio')).status === 201,
      'audio：第 3/4 条 → 201',
    )
    const NGA5 = await mkNode({ kind: 'gen', spec: { genKind: 'audio', prompt: 'A5' }, x: 300, y: 1000 })
    check((await edge(NGA5, NGC, 'audio')).status === 400, 'audio：第 5 条 → 400（上限 4）')

    // ---- run 双向拒连 ----
    check((await edge(NRun, NGI, 'reference')).status === 400, 'run 作源拒连 → 400')
    check((await edge(NGI, NRun, 'reference')).status === 400, 'run 作目标拒连 → 400')
    check((await edge(NRun, NGC, 'video')).status === 400, 'run → compose 任意端口拒连 → 400')

    // ---- 自环 / 重复边 / 环 / 跨画布（回归） ----
    check((await edge(NGI, NGI, 'reference')).status === 400, '自环 → 400')
    const NCa = await mkNode({ kind: 'gen', spec: { genKind: 'compose' }, x: 300, y: 1100 })
    const NCb = await mkNode({ kind: 'gen', spec: { genKind: 'compose' }, x: 300, y: 1200 })
    check((await edge(NCa, NCb, 'video')).status === 201, '环构造：NCa → NCb → 201')
    const eCycle = await edge(NCb, NCa, 'video')
    check(eCycle.status === 400 && String(eCycle.body?.error?.message ?? '').includes('循环引用'), '环（NCa↔NCb）→ 400（环检测文案）')
    check((await edge(NCb, NGV, 'video')).status === 400, 'video：视频 gen 目标 → 400（仅 compose）')
    const c2 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '端口矩阵 v2-乙' })
    const C2: number = c2.body.canvas.id
    const NX = (await jreq('POST', `/api/v1/canvases/${C2}/nodes`, { kind: 'gen', spec: { genKind: 'image', prompt: 'X' }, x: 0, y: 0 })).body.node.id
    check((await edge(NX, NGI, 'reference')).status === 400, '跨画布 from → 400')
    check((await jreq('POST', `/api/v1/canvases/${C2}/edges`, { from: NGI, to: NX, port: 'reference' })).status === 400, '跨画布 to → 400')

    // ---- spec 损坏目标 / 非法端口 ----
    await db.update(canvasNodes).set({ spec: '{bad' }).where(eq(canvasNodes.id, NGI2))
    check((await edge(NAI, NGI2, 'reference')).status === 400, '目标 spec 损坏 → 400（无法连线）')
    await db.update(canvasNodes).set({ spec: JSON.stringify({ genKind: 'image', prompt: 'P2' }) }).where(eq(canvasNodes.id, NGI2))
    check((await edge(NAI, NGI, 'foo')).status === 400, '非法端口 → 400')
  }
}
