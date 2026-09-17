/** M18[P2] frame-extract：抽帧矩阵 + 端点全链（真实 ffmpeg）（断言体逐字搬自原 probe-m18.ts） */
import { existsSync, readFileSync } from 'node:fs'
import type { M18Ctx } from './ctx'

export async function run(ctx: M18Ctx): Promise<void> {
  const { check, log, db, T0, genTasks, mkProject, mkAsset, jreq, ffmpegBin, relPathOf, absPathOf, genMedia, assets, eq } = ctx
  const { buildFrameExtractArgs, frameTimeOf } = await import('../../../src/services/creation/gen')

  // ---- frameTimeOf 全模式矩阵 ----
  check(frameTimeOf('first', null, 10) === 0.1, 'first：常规 10s → 0.1（避开淡入）')
  check(frameTimeOf('first', null, 0.1) === 0.05, 'first：超短视频 → 中点（min(0.1, dur/2)）')
  check(frameTimeOf('first', null, null) === 0.1, 'first：时长未知 → 0.1')
  check(frameTimeOf('last', null, 10) === 9.9, 'last：常规 10s → 9.9（dur−0.1）')
  check(frameTimeOf('last', null, 0.05) === 0, 'last：极短 → 0（下界收口）')
  check(frameTimeOf('last', null, null) === 0.1, 'last：时长未知 → 0.1')
  check(frameTimeOf('custom', 5.5, 10) === 5.5, 'custom：正常取值')
  check(frameTimeOf('custom', 20, 10) === 9.95, 'custom：上界 clamp 到 dur−0.05')
  check(frameTimeOf('custom', -3, 10) === 0, 'custom：负值 clamp 到 0')
  check(frameTimeOf('custom', 5, null) === 5, 'custom：时长未知仅下界')

  // ---- buildFrameExtractArgs 快照 ----
  check(
    JSON.stringify(buildFrameExtractArgs('in.mp4', 'o.jpg', 0.1)) ===
      JSON.stringify(['-y', '-hide_banner', '-loglevel', 'error', '-ss', '0.1', '-i', 'in.mp4', '-frames:v', '1', '-q:v', '2', 'o.jpg']),
    'buildFrameExtractArgs 快照（-ss 前置 / 全尺寸 jpg / -q:v 2）',
  )

  // ---- 端点全链（真实 ffmpeg） ----
  const PID = await mkProject('M18 抽帧')
  const C = (await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '抽帧画布' })).body.canvas.id
  const mkNode = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${C}/nodes`, body)).body.node.id

  if (!ffmpegBin) {
    log.info('  SKIP  抽帧端点全链（未找到 ffmpeg：仓库根 pnpm install / 配置 CSTUDIO_FFMPEG_PATH）')
    return
  }
  const vRel = relPathOf(PID, 'creation_video', 'probe-src-2s.mp4')
  const vAbs = absPathOf(vRel)
  const okGen = genMedia(vAbs, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=10', '-pix_fmt', 'yuv420p', '-t', '2', vAbs])
  check(okGen, 'ffmpeg 生成测试视频（testsrc 2s）')
  if (!okGen) return
  const VID = await mkAsset(PID, 'video', '源视频', { relPath: vRel, duration: 2, width: 160, height: 120 })
  const IMA = await mkAsset(PID, 'image', '图片素材')
  const VDEL = await mkAsset(PID, 'video', '软删视频', { relPath: vRel, duration: 2 })
  const VNOREL = await mkAsset(PID, 'video', '无文件视频')

  const NAV = await mkNode({ kind: 'asset', assetId: VID, x: 400, y: 300 })
  const NAI = await mkNode({ kind: 'asset', assetId: IMA, x: 400, y: 500 })
  const NAVD = await mkNode({ kind: 'asset', assetId: VDEL, x: 400, y: 700 })
  const NAVN = await mkNode({ kind: 'asset', assetId: VNOREL, x: 400, y: 800 })
  await db.update(assets).set({ deletedAt: T0 }).where(eq(assets.id, VDEL)) // 建节点后软删（复刻回收站时序）

  // asset 源 · first
  const r1 = await jreq('POST', `/api/v1/nodes/${NAV}/extract-frame`, { mode: 'first' })
  const p1 = JSON.parse(String(r1.body?.asset?.params ?? '{}'))
  check(r1.status === 201 && r1.body?.node?.kind === 'asset' && r1.body?.asset?.kind === 'image', 'asset 源抽帧 → 201（asset 节点 + image 资产）')
  check(r1.body?.asset?.purpose === 'creation_frame' && r1.body?.asset?.mime === 'image/jpeg', 'purpose=creation_frame / mime=image/jpeg')
  check(p1.timeSec === 0.1 && p1.sourceAssetId === VID && p1.mode === 'first', 'params：timeSec=0.1 / sourceAssetId / mode')
  check(r1.body?.node?.x === 460 && r1.body?.node?.y === 440, '缺省位置 = 源节点右下偏移（+60/+140）')
  check(String(r1.body?.node?.title ?? '') === '抽帧 0.1s', '节点 title=抽帧 0.1s')
  const outAbs1 = absPathOf(String(r1.body?.asset?.relPath ?? ''))
  const head1 = existsSync(outAbs1) ? readFileSync(outAbs1).subarray(0, 2) : Buffer.alloc(0)
  check(head1.length === 2 && head1[0] === 0xff && head1[1] === 0xd8, '产物文件存在且为 JPEG（FFD8 魔数）')

  // gen(video) 显示产物（造 succeeded 任务）
  const NG = await mkNode({ kind: 'gen', spec: { genKind: 'video', prompt: '测试视频' }, x: 700, y: 300 })
  await db.insert(genTasks).values({ projectId: PID, runId: null, stepId: null, canvasNodeId: NG, kind: 'video', params: '{}', status: 'succeeded', resultAssetId: VID, createdAt: T0, updatedAt: T0 })
  const r2 = await jreq('POST', `/api/v1/nodes/${NG}/extract-frame`, { mode: 'last' })
  check(r2.status === 201 && JSON.parse(String(r2.body?.asset?.params ?? '{}')).timeSec === 1.9, 'gen 源（显示产物）· last → 1.9')

  // custom clamp + 显式坐标
  const r3 = await jreq('POST', `/api/v1/nodes/${NAV}/extract-frame`, { mode: 'custom', time: 99, x: 555, y: 666 })
  check(
    r3.status === 201 && JSON.parse(String(r3.body?.asset?.params ?? '{}')).timeSec === 1.95 && r3.body?.node?.x === 555 && r3.body?.node?.y === 666,
    'custom：time=99 → clamp 1.95 + 显式坐标生效',
  )

  // ---- 错误族 ----
  check((await jreq('POST', `/api/v1/nodes/${NAI}/extract-frame`, {})).status === 400, '非视频素材 → 400')
  check((await jreq('POST', `/api/v1/nodes/${NAVD}/extract-frame`, {})).status === 400, '软删视频 → 400')
  check((await jreq('POST', `/api/v1/nodes/${NAVN}/extract-frame`, {})).status === 400, '无文件视频 → 400')
  check((await jreq('POST', `/api/v1/nodes/${NAV}/extract-frame`, { mode: 'nope' })).status === 400, 'mode 非法 → 400')
  check((await jreq('POST', `/api/v1/nodes/${NAV}/extract-frame`, { mode: 'custom', time: 'abc' })).status === 400, 'time 非数值 → 400')
  check((await jreq('POST', '/api/v1/nodes/999999/extract-frame', {})).status === 400, '节点不存在 → 400')
  const NGI = await mkNode({ kind: 'gen', spec: { genKind: 'image', prompt: 'x' }, x: 700, y: 500 })
  check((await jreq('POST', `/api/v1/nodes/${NGI}/extract-frame`, {})).status === 400, '非视频 gen → 400')
  const NGV2 = await mkNode({ kind: 'gen', spec: { genKind: 'video', prompt: 'v' }, x: 700, y: 600 })
  const rNone = await jreq('POST', `/api/v1/nodes/${NGV2}/extract-frame`, {})
  check(rNone.status === 400 && String(rNone.body?.error?.message ?? '').includes('暂无可用产物'), 'gen(video) 无产物 → 400「暂无可用产物」')
  const NTX = await mkNode({ kind: 'text', spec: { text: 'x' }, x: 700, y: 700 })
  check((await jreq('POST', `/api/v1/nodes/${NTX}/extract-frame`, {})).status === 400, 'text 节点 → 400')
}
