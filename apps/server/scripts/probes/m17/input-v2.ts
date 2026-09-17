/** M17[input-v2]：planNodeInputs v2 / specProblems / pickDisplayTask 纯矩阵 + 读模型与执行侧集成（断言体逐字搬自原 probe-m17.ts） */
import type { NodeSpec } from '../../../src/services/creation'
import type { M17Ctx } from './ctx'

export async function run(ctx: M17Ctx): Promise<void> {
  const {
    check, jreq, db, canvasNodes, canvasEdges, eq, PID, A1, A2, A3, docNode, mkEntity, mkTask,
    loadInputPlan, planNodeInputs, specProblems, pickDisplayTask,
  } = ctx
  {
    const img: NodeSpec = { genKind: 'image', prompt: '' }
    const vid: NodeSpec = { genKind: 'video', prompt: 'V' }
    const audio: NodeSpec = { genKind: 'audio', prompt: '' }
    const compose: NodeSpec = { genKind: 'compose', prompt: '' }
    const up = (m: Array<[number, any]>): Map<number, any> => new Map(m)

    // ---- prompt 覆盖语义 ----
    const pP = planNodeInputs(img, 100, [{ from: 9, to: 100, port: 'prompt' }], up([[9, { assetId: null, mediaKind: null, text: '  重写的词  ' }]]))
    check(pP.promptText === '重写的词' && pP.problems.length === 0, 'prompt 端口：text 覆盖 + trim + 无问题')
    check(specProblems(img, pP.promptText != null).length === 0, 'specProblems：有 prompt 输入 → 空 spec.prompt 不报')
    const pPe = planNodeInputs(img, 100, [{ from: 9, to: 100, port: 'prompt' }], up([[9, { assetId: null, mediaKind: null, text: ' ' }]]))
    check(pPe.promptText === null && pPe.problems.some((x) => x.includes('暂无文本或为空')), 'prompt 端口：空文本 → problem')
    check(specProblems(img, false).some((x) => x.includes('prompt 为空')), 'specProblems：无 prompt 输入 → 报空 prompt')

    // ---- entity 展开截断 ----
    const refs8 = [1, 2, 3, 4, 5, 6, 7, 8]
    const pE = planNodeInputs(img, 100, [{ from: 7, to: 100, port: 'reference' }], up([[7, { assetId: null, mediaKind: null, refAssetIds: refs8 }]]))
    check(pE.referenceAssetIds.length === 6 && JSON.stringify(pE.referenceAssetIds) === '[1,2,3,4,5,6]', 'entity 展开：image cap 6 截断')
    check(pE.notes.some((x) => x.includes('超上限 6 张，已截断 2 张')), 'entity 展开：notes 记截断数')
    const pEV = planNodeInputs(vid, 100, [{ from: 7, to: 100, port: 'reference' }], up([[7, { assetId: null, mediaKind: null, refAssetIds: refs8 }]]))
    check(
      pEV.referenceAssetIds.length === 2 && pEV.notes.some((x) => x.includes('超上限 2 张，已截断 6 张')),
      'entity 展开：video cap 2 截断 + notes',
    )
    const pEM = planNodeInputs(
      img,
      100,
      [
        { from: 7, to: 100, port: 'reference' },
        { from: 8, to: 100, port: 'reference' },
      ],
      up([
        [7, { assetId: null, mediaKind: null, refAssetIds: refs8 }],
        [8, { assetId: 55, mediaKind: 'image' }],
      ]),
    )
    check(
      pEM.referenceAssetIds.length === 6 && pEM.problems.some((x) => x.includes('参考图超过上限 6 张')),
      'entity 占满 cap → 普通 reference 源 problem',
    )

    // ---- compose 输入边序 / 缺失 ----
    const pC = planNodeInputs(
      compose,
      100,
      [
        { from: 1, to: 100, port: 'video' },
        { from: 2, to: 100, port: 'audio' },
        { from: 3, to: 100, port: 'video' },
      ],
      up([
        [1, { assetId: 201, mediaKind: 'video' }],
        [2, { assetId: 301, mediaKind: 'audio' }],
        [3, { assetId: 202, mediaKind: 'video' }],
      ]),
    )
    check(JSON.stringify(pC.videoAssetIds) === '[201,202]' && JSON.stringify(pC.audioAssetIds) === '[301]', 'compose：video/audio 集合（边序）')
    check(pC.problems.length === 0 && specProblems(compose).length === 0, 'compose：齐备 → 无 problems（specProblems 空）')
    const pCMiss = planNodeInputs(compose, 100, [], up([]))
    check(pCMiss.problems.some((x) => x.includes('合成节点缺少视频输入连线')), 'compose：无 video 输入 → problem')
    const pCBad = planNodeInputs(compose, 100, [{ from: 1, to: 100, port: 'video' }], up([[1, { assetId: 55, mediaKind: 'image' }]]))
    check(
      pCBad.problems.some((x) => x.includes('不能作为视频输入（仅视频）')) && !pCBad.problems.some((x) => x.includes('缺少视频输入连线')),
      'compose：非视频产物 → problem 且不重复报缺',
    )
    const pABad = planNodeInputs(compose, 100, [{ from: 2, to: 100, port: 'audio' }], up([[2, { assetId: 55, mediaKind: 'video' }]]))
    check(pABad.problems.some((x) => x.includes('不能作为音频输入（仅音频）')), 'compose：非音频产物入 audio 端口 → problem')

    // ---- specProblems：audio / 空文本 ----
    check(specProblems(audio).some((x) => x.includes('朗读文本为空')), 'specProblems：audio 空 prompt → 朗读文本为空')
    check(specProblems(audio, true).length === 0, 'specProblems：audio + prompt 输入 → 不报')

    // ---- pickDisplayTask 矩阵 ----
    const T = (id: number, status: string, asset: number | null): { id: number; status: string; resultAssetId: number | null } => ({
      id,
      status,
      resultAssetId: asset,
    })
    const desc = [T(30, 'processing', null), T(29, 'succeeded', 900), T(28, 'succeeded', 901), T(27, 'succeeded', 902), T(26, 'failed', null)]
    check(pickDisplayTask(null, desc)?.id === 29, 'pickDisplayTask：无采纳 → 最新成功')
    check(pickDisplayTask(28, desc)?.id === 28, 'pickDisplayTask：采纳有效 → 采纳优先（非最新）')
    check(pickDisplayTask(26, desc)?.id === 29, 'pickDisplayTask：采纳 failed → 回退最新成功')
    check(pickDisplayTask(999, desc)?.id === 29, 'pickDisplayTask：采纳不存在 → 回退最新成功')
    const desc2 = [T(30, 'succeeded', null), ...desc]
    check(pickDisplayTask(null, desc2)?.id === 29, 'pickDisplayTask：成功但无产物 → 跳过')
    check(pickDisplayTask(null, [T(1, 'failed', null), T(2, 'processing', null)]) === null, 'pickDisplayTask：无成功 → null')

    // ---- 集成：读模型 + 执行侧（真实库全链） ----
    const c1 = await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '输入计划 v2' })
    const C: number = c1.body.canvas.id
    const mkNode = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${C}/nodes`, body)).body.node.id
    const edge = (from: number, to: number, port: string) => jreq('POST', `/api/v1/canvases/${C}/edges`, { from, to, port })

    const NA = await mkNode({ kind: 'asset', assetId: A1, x: 0, y: 0 })
    const NT = await mkNode({ kind: 'text', spec: { text: '窗边的猫' }, x: 100, y: 0 })
    const NT2 = await mkNode({ kind: 'text', spec: { text: ' ' }, x: 100, y: 100 })
    const G = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: '' }, x: 300, y: 0 })
    const G2 = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: '' }, x: 300, y: 100 })
    const G3 = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: 'D' }, x: 300, y: 200 })
    const GV = await mkNode({ kind: 'gen', spec: { genKind: 'video', prompt: 'V' }, x: 300, y: 300 })

    // prompt 端口供词 → 空 spec.prompt 不报 + ready
    await edge(NT, G, 'prompt')
    await edge(NA, G, 'reference')
    let d = await jreq('GET', `/api/v1/canvases/${C}`)
    let dn = docNode(d.body, G)
    check(dn?.readiness?.ready === true && !dn?.readiness?.problems?.some((p: string) => p.includes('prompt 为空')), '集成：prompt 端口供词 → 空 spec.prompt 不报 + ready')

    // 空文本 → problem
    await edge(NT2, G2, 'prompt')
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    check(docNode(d.body, G2)?.readiness?.problems?.some((p: string) => p.includes('暂无文本或为空')), '集成：空文本源 → 提示词来源 problem')

    // entity 截断 notes（video cap 2：ENT3 refs 3 张 → 截断 1）
    const ENT3 = await mkEntity(PID, '角色丙', [A1, A2, A3])
    const NE3 = await mkNode({ kind: 'entity', entityId: ENT3, x: 100, y: 300 })
    await edge(NE3, GV, 'reference')
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    dn = docNode(d.body, GV)
    check(dn?.readiness?.notes?.some((n: string) => n.includes('超上限 2 张，已截断 1 张')), '集成：entity→video gen 截断 notes 透传')
    check(dn?.readiness?.ready === true, '集成：截断仅 notes 不阻断 ready')

    // 执行侧 loadInputPlan：entity 展开同源
    const nodeRowV = (await db.select().from(canvasNodes).where(eq(canvasNodes.id, GV)))[0]!
    const incomingV = await db.select({ from: canvasEdges.from, to: canvasEdges.to, port: canvasEdges.port }).from(canvasEdges).where(eq(canvasEdges.to, GV))
    const planV = await loadInputPlan(nodeRowV, incomingV, { genKind: 'video', prompt: 'V' })
    check(
      JSON.stringify(planV.referenceAssetIds) === `[${A1},${A2}]` && planV.notes.some((n) => n.includes('已截断 1 张')),
      'loadInputPlan：entity 展开截断（执行侧同源）',
    )

    // 采纳优先：t1（旧，A1） vs t2（新，A2）
    const t1 = await mkTask(PID, { canvasNodeId: G, status: 'succeeded', resultAssetId: A1 })
    const t2 = await mkTask(PID, { canvasNodeId: G, status: 'succeeded', resultAssetId: A2 })
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    dn = docNode(d.body, G)
    check(dn?.displayTaskId === t2 && dn?.assetId === A2, '采纳优先：未采纳 → 最新成功（t2/A2）')
    check(dn?.results?.length === 2 && dn?.displayTask?.asset?.id === A2, '画廊：results 2 条 + displayTask 资产冗余')
    check((await jreq('PATCH', `/api/v1/nodes/${G}`, { adoptedTaskId: t1 })).status === 200, 'PATCH adoptedTaskId=t1 → 200')
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    dn = docNode(d.body, G)
    check(dn?.displayTaskId === t1 && dn?.assetId === A1 && dn?.latestTask?.id === t2, '采纳优先：displayTask=t1（latest 仍 t2）')

    // 下游引用 = 采纳产物（执行侧）
    await edge(G, G3, 'reference')
    const nodeRow3 = (await db.select().from(canvasNodes).where(eq(canvasNodes.id, G3)))[0]!
    const incoming3 = await db.select({ from: canvasEdges.from, to: canvasEdges.to, port: canvasEdges.port }).from(canvasEdges).where(eq(canvasEdges.to, G3))
    const plan3 = await loadInputPlan(nodeRow3, incoming3, { genKind: 'image', prompt: 'D' })
    check(JSON.stringify(plan3.referenceAssetIds) === `[${A1}]`, '执行侧：下游引用 = 采纳产物（A1）')

    // 采纳失败任务 / 他节点任务 / 清除回退
    const t3 = await mkTask(PID, { canvasNodeId: G, status: 'failed' })
    check((await jreq('PATCH', `/api/v1/nodes/${G}`, { adoptedTaskId: t3 })).status === 400, '采纳 failed 任务 → 400')
    const tOther = await mkTask(PID, { canvasNodeId: G2, status: 'succeeded', resultAssetId: A3 })
    check((await jreq('PATCH', `/api/v1/nodes/${G}`, { adoptedTaskId: tOther })).status === 400, '采纳他节点任务 → 400')
    check((await jreq('PATCH', `/api/v1/nodes/${G}`, { adoptedTaskId: null })).status === 200, '清除采纳 → 200')
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    check(docNode(d.body, G)?.displayTaskId === t2, '清除采纳 → 回退最新成功（t2）')
    const plan3b = await loadInputPlan(nodeRow3, incoming3, { genKind: 'image', prompt: 'D' })
    check(JSON.stringify(plan3b.referenceAssetIds) === `[${A2}]`, '执行侧：清除采纳 → 下游回退最新成功（A2）')

    // 成功但无产物不参与显示
    const t4 = await mkTask(PID, { canvasNodeId: G, status: 'succeeded' })
    d = await jreq('GET', `/api/v1/canvases/${C}`)
    dn = docNode(d.body, G)
    check(dn?.displayTaskId === t2 && dn?.latestTask?.id === t4, '成功无产物 → 跳过（display 仍 t2 / latest t4）')
  }
}
