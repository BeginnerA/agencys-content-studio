/** M18[P2] run-preview：成本预估（定价链 + 各 genKind 单位矩阵 + 响应结构 + preflight 回归）（断言体逐字搬自原 probe-m18.ts） */
import type { M18Ctx } from './ctx'

export async function run(ctx: M18Ctx): Promise<void> {
  const { check, db, mkProject, mkAsset, jreq, apiConfigs, settings, genTasks, eq, T0 } = ctx
  const PID = await mkProject('M18 预估')
  const C = (await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '预估画布' })).body.canvas.id
  const mkNode = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${C}/nodes`, body)).body.node.id

  // ---- 定价种子：实例级（image/second/char 扁平 pricing）+ 全局兜底（video） ----
  const cfgBase = { serviceType: 'image', priority: 100, isDefault: 1, isActive: 1, createdAt: T0, updatedAt: T0 }
  await db.insert(apiConfigs).values({ ...cfgBase, providerKey: 'probe-vendor', name: 'probe 图像', model: 'pv-1', pricing: JSON.stringify({ image: 0.5, second: 0.1, char: 30 }) })
  await db.insert(apiConfigs).values({ ...cfgBase, serviceType: 'audio', providerKey: 'probe-tts', name: 'probe 配音', model: 'tts-1', pricing: JSON.stringify({ char: 30 }) })
  await db.insert(settings).values({ key: 'pricing', value: JSON.stringify({ video: { 'probe-global:*': { second: 0.2 } } }), updatedAt: T0 })

  // ---- 节点矩阵 ----
  const NI = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: '图片', provider: 'probe-vendor', model: 'pv-1' }, x: 0, y: 0 })
  const NV = await mkNode({ kind: 'gen', spec: { genKind: 'video', prompt: '视频', provider: 'probe-global', duration: 8 }, x: 0, y: 100 })
  const NV2 = await mkNode({ kind: 'gen', spec: { genKind: 'video', prompt: '视频2', provider: 'probe-global' }, x: 0, y: 200 })
  const NA = await mkNode({ kind: 'gen', spec: { genKind: 'audio', prompt: '你好世界', provider: 'probe-tts' }, x: 0, y: 300 })
  const NC = await mkNode({ kind: 'gen', spec: { genKind: 'compose', resolution: '160x120' }, x: 0, y: 400 })
  const AV = await mkAsset(PID, 'video', '预估视频素材', { duration: 2 })
  const NAV = await mkNode({ kind: 'asset', assetId: AV, x: -200, y: 400 })
  await jreq('POST', `/api/v1/canvases/${C}/edges`, { from: NAV, to: NC, port: 'video' })
  const NX = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: '未计价', provider: 'nobody' }, x: 0, y: 500 })
  const NBLOCKED = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: '' }, x: 0, y: 600 })
  const NBUSY = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: '忙', provider: 'probe-vendor', model: 'pv-1' }, x: 0, y: 700 })
  await db.insert(genTasks).values({ projectId: PID, runId: null, stepId: null, canvasNodeId: NBUSY, kind: 'image', params: '{}', status: 'processing', createdAt: T0, updatedAt: T0 })

  const ids = [NI, NV, NV2, NA, NC, NX, NBLOCKED, NBUSY]
  const r = await jreq('POST', `/api/v1/canvases/${C}/run-preview`, { nodeIds: ids })
  check(r.status === 200 && r.body?.nodes?.length === 8, 'run-preview → 200（8 节点条目）')
  const byId = new Map<number, any>((r.body?.nodes ?? []).map((n: any) => [n.nodeId, n]))

  const i = byId.get(NI)
  check(
    i?.ready === true && i?.units?.[0]?.unit === 'image' && i?.units?.[0]?.quantity === 1 && i?.units?.[0]?.unitPrice === 0.5 && i?.total === 0.5,
    'image：实例级 0.5/张 → 0.5',
  )
  const v = byId.get(NV)
  check(v?.units?.[0]?.unit === 'second' && v?.units?.[0]?.quantity === 8 && v?.units?.[0]?.unitPrice === 0.2 && Math.abs(v?.total - 1.6) < 1e-9, 'video：全局兜底 0.2/秒 × 8s = 1.6')
  const v2 = byId.get(NV2)
  check(v2?.units?.[0]?.quantity === 5 && v2?.total === 1, 'video：duration 缺省 → 5s（1.0）')
  const a = byId.get(NA)
  check(a?.units?.[0]?.unit === 'char' && a?.units?.[0]?.quantity === 4 && a?.units?.[0]?.unitPrice === 0.03 && Math.abs(a?.total - 0.12) < 1e-9, 'audio：char 30/千字 × 4 字 = 0.12')
  const cc = byId.get(NC)
  check(cc?.ready === true && cc?.units?.length === 0 && cc?.total === 0 && cc?.unpriced === false, 'compose：本地零成本（units 空 / total=0）')
  const x = byId.get(NX)
  check(x?.unpriced === true && x?.total === null && x?.units?.[0]?.unitPrice === null, '未命中定价 → unpriced / total=null')
  const bl = byId.get(NBLOCKED)
  check(bl?.ready === false && (bl?.problems?.length ?? 0) > 0 && bl?.units?.length === 0, '未就绪 → ready=false + problems + 无单位行')
  const bu = byId.get(NBUSY)
  check(bu?.busy === true && bu?.ready === false, 'busy=processing → busy=true / ready=false')

  check(Math.abs((r.body?.total?.amount ?? 0) - 3.72) < 1e-6, `total.amount = 0.5+1.6+1.0+0.12+0+0.5 = 3.72（实际 ${r.body?.total?.amount}）`)
  check(r.body?.total?.unpriced === 1 && r.body?.total?.ready === 6 && r.body?.total?.blocked === 1 && r.body?.total?.busy === 1, 'total 聚合：unpriced=1 / ready=6 / blocked=1 / busy=1')

  // ---- 实例级优先于全局（同 kind 双源） ----
  await db
    .update(settings)
    .set({ value: JSON.stringify({ image: { 'probe-vendor:pv-1': { image: 9 }, 'probe-vendor:*': { image: 8 } }, video: { 'probe-global:*': { second: 0.2 } } }) })
    .where(eq(settings.key, 'pricing'))
  const r2 = await jreq('POST', `/api/v1/canvases/${C}/run-preview`, { nodeIds: [NI] })
  check(r2.body?.nodes?.[0]?.units?.[0]?.unitPrice === 0.5, '实例级定价优先于 settings.pricing（0.5 不被 9 覆盖）')

  // ---- 缺省 nodeIds = 全部 gen 节点 / 非法 nodeIds → 400 ----
  const r3 = await jreq('POST', `/api/v1/canvases/${C}/run-preview`, {})
  check(r3.status === 200 && r3.body?.nodes?.length === 8, '缺省 nodeIds → 全部 gen 节点（8）')
  check((await jreq('POST', `/api/v1/canvases/${C}/run-preview`, { nodeIds: 'x' })).status === 400, 'nodeIds 非数组 → 400')
  check((await jreq('POST', `/api/v1/canvases/${C}/run-preview`, { nodeIds: [] })).status === 400, 'nodeIds 空数组 → 400')
  check((await jreq('POST', '/api/v1/canvases/999999/run-preview', {})).status === 404, '画布不存在 → 404')

  // ---- 他画布节点：失败条目（不炸） ----
  const C2 = (await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '别的画布' })).body.canvas.id
  const GN2 = (await jreq('POST', `/api/v1/canvases/${C2}/nodes`, { kind: 'gen', spec: { genKind: 'image', prompt: 'x' }, x: 0, y: 0 })).body.node.id
  const r4 = await jreq('POST', `/api/v1/canvases/${C}/run-preview`, { nodeIds: [GN2] })
  check(
    r4.status === 200 && r4.body?.nodes?.[0]?.ready === false && String(r4.body?.nodes?.[0]?.problems?.[0] ?? '').includes('不属于该画布'),
    '他画布节点 → 失败条目（不属于该画布）',
  )

  // ---- preflight 重构回归：run 错误路径文案不变 ----
  const rb = await jreq('POST', `/api/v1/nodes/${NBLOCKED}/run`, {})
  check(rb.status === 400 && String(rb.body?.error?.message ?? '').includes('未就绪'), 'run 回归：未就绪 → 400「节点未就绪」（preflight 同源）')
  const rbusy = await jreq('POST', `/api/v1/nodes/${NBUSY}/run`, {})
  check(rbusy.status === 400 && String(rbusy.body?.error?.message ?? '').includes('已有进行中的任务'), 'run 回归：busy → 400（文案保持）')
}
