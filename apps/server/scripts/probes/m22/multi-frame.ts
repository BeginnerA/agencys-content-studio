/** M22[P3] multi-frame：均匀多帧（纯函数矩阵 + 真实 ffmpeg 全链）（断言体逐字搬自原 probe-m22.ts） */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { M22Ctx } from './ctx'

export async function run(ctx: M22Ctx): Promise<void> {
  const { check, log, db, T0, projects, canvases, canvasNodes, UNIFORM_FRAME_COUNT_RANGE, frameTimesOf, resolveFfmpeg, ensureProjectDirs, relPathOf, absPathOf, registerAsset, extractNodeFrame } = ctx
  check(UNIFORM_FRAME_COUNT_RANGE.lo === 2 && UNIFORM_FRAME_COUNT_RANGE.hi === 9, 'count 范围常量 2–9')
  check(frameTimesOf('uniform', null, 3, 10).join(',') === '0.1,5,9.9', 'uniform×3：首/中/尾（0.1 / 5 / 9.9）')
  check(frameTimesOf('uniform', null, 2, 10).join(',') === '0.1,9.9', 'uniform×2：首/尾')
  const t9 = frameTimesOf('uniform', null, 9, 10)
  check(t9.length === 9 && t9[0] === 0.1 && t9[1] === 1.325 && t9[8] === 9.9, 'uniform×9：等距 9 帧（步长 1.225）')
  check(frameTimesOf('uniform', null, null, 10).length === 3, 'count 缺省 → 3')
  const thr = (fn: () => unknown): boolean => {
    try {
      fn()
      return false
    } catch {
      return true
    }
  }
  check(thr(() => frameTimesOf('uniform', null, 1, 10)), 'count=1 → 报错（下界 2）')
  check(thr(() => frameTimesOf('uniform', null, 10, 10)), 'count=10 → 报错（上界 9）')
  check(thr(() => frameTimesOf('uniform', null, null, null)), '时长缺失 → 报错（uniform 必须有时长）')
  const degen = frameTimesOf('uniform', null, 3, 0.25)
  check(degen.length === 3 && degen.every((t) => t === 0.1), 'dur≤0.3 退化：全取首帧时刻')
  check(
    frameTimesOf('first', null, null, 10).join(',') === '0.1' && frameTimesOf('last', null, null, 10).join(',') === '9.9',
    '非 uniform 直通：first/last 单元素',
  )
  check(frameTimesOf('custom', 5, null, 10).join(',') === '5', '非 uniform 直通：custom 单元素')

  // ---- 真实 ffmpeg 全链（本地二进制；缺 → SKIP） ----
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) {
    log.info('  SKIP  multi-frame 全链（未找到 ffmpeg：仓库根 pnpm install / 配置 CSTUDIO_FFMPEG_PATH）')
    return
  }
  const [projF] = await db
    .insert(projects)
    .values({ name: 'M22 多帧项目', genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
    .returning()
  const [cvF] = await db.insert(canvases).values({ projectId: projF!.id, name: '多帧画布', createdAt: T0, updatedAt: T0 }).returning()
  ensureProjectDirs(projF!.id)
  const vRel2 = relPathOf(projF!.id, 'creation_video', 'probe-uniform-2s.mp4')
  const vAbs2 = absPathOf(vRel2)
  const gen = spawnSync(
    ffmpeg,
    ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=10', '-pix_fmt', 'yuv420p', '-t', '2', vAbs2],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true },
  )
  check(gen.status === 0, 'ffmpeg 生成测试视频（testsrc 2s）')
  if (gen.status !== 0) return
  const vAsset = await registerAsset(projF!.id, {
    name: 'uniform-src.mp4',
    kind: 'video',
    purpose: 'creation_video',
    relPath: vRel2,
    mime: 'video/mp4',
    ext: 'mp4',
    width: 160,
    height: 120,
    duration: 2,
  })
  const [nSrc] = await db
    .insert(canvasNodes)
    .values({ canvasId: cvF!.id, kind: 'asset', assetId: vAsset.id, title: '源视频', x: 400, y: 300, createdAt: T0, updatedAt: T0 })
    .returning()

  const r3 = await extractNodeFrame(nSrc!.id, { mode: 'uniform', count: 3 })
  check(r3.nodes != null && r3.nodes.length === 3 && r3.assets != null && r3.assets.length === 3, 'uniform×3 全链：3 节点 + 3 资产')
  check(r3.node.id === r3.nodes![0]!.id && r3.asset.id === r3.assets![0]!.id, '首帧兼容：node/asset = nodes[0]/assets[0]')
  check(
    r3.nodes![0]!.x === 460 && r3.nodes![1]!.x === 720 && r3.nodes![2]!.x === 980 && r3.nodes!.every((n) => n.y === 440),
    '网格 3 列：x = 源 x+60 + k×260；首行同 y（源 y+140）',
  )
  const p0 = JSON.parse(String(r3.assets![0]!.params ?? '{}')) as Record<string, unknown>
  const p2 = JSON.parse(String(r3.assets![2]!.params ?? '{}')) as Record<string, unknown>
  check(p0.mode === 'uniform' && p0.count === 3 && p0.index === 0 && p0.timeSec === 0.1, 'params：mode/count/index/timeSec（首帧 0.1）')
  check(p2.index === 2 && p2.timeSec === 1.9 && p2.duration === 2, 'params：末帧 index=2 / timeSec=1.9 / duration')
  const jpgOk = r3.assets!.every((a) => {
    const abs = absPathOf(a.relPath ?? '')
    if (!existsSync(abs)) return false
    const head = readFileSync(abs).subarray(0, 2)
    return head[0] === 0xff && head[1] === 0xd8
  })
  check(jpgOk, '3 产物文件存在且为 JPEG（FFD8 魔数）')
  check(new Set(r3.nodes!.map((n) => n.assetId)).size === 3, '3 节点指向 3 个不同资产')

  const r4 = await extractNodeFrame(nSrc!.id, { mode: 'uniform', count: 4, x: 0, y: 0 })
  check(r4.nodes != null && r4.nodes.length === 4 && r4.nodes[3]!.x === 0 && r4.nodes[3]!.y === 200, '网格换行：k=3 → 列 0 / 第二行（+200）')

  const errMsg = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      await fn()
      return 'no-error'
    } catch (err) {
      return (err as Error).message
    }
  }
  check((await errMsg(() => extractNodeFrame(nSrc!.id, { mode: 'uniform', count: 10 }))).includes('count 需为'), 'count=10 → 报错「count 需为 2–9」')
  check((await errMsg(() => extractNodeFrame(nSrc!.id, { mode: 'uniform', count: 'abc' }))).includes('count 需为数值'), 'count 非数值 → 报错')
  const gRel = relPathOf(projF!.id, 'creation_video', 'garbage.mp4')
  writeFileSync(absPathOf(gRel), Buffer.from('not-a-video'))
  const gAsset = await registerAsset(projF!.id, { name: 'garbage.mp4', kind: 'video', purpose: 'creation_video', relPath: gRel, mime: 'video/mp4', ext: 'mp4' })
  const [nG] = await db
    .insert(canvasNodes)
    .values({ canvasId: cvF!.id, kind: 'asset', assetId: gAsset.id, title: '坏视频', x: 0, y: 0, createdAt: T0, updatedAt: T0 })
    .returning()
  check((await errMsg(() => extractNodeFrame(nG!.id, { mode: 'uniform', count: 3 }))).includes('需要视频时长'), '时长探测失败 → uniform 报错「需要视频时长」')
}
