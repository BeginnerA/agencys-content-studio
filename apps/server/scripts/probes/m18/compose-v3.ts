/** M18[P2] compose-v3：buildComposeArgs 快照（旧形态零变化/转场/BGM/降级）+ 真实合成全链（断言体逐字搬自原 probe-m18.ts） */
import { existsSync, statSync } from 'node:fs'
import type { M18Ctx } from './ctx'

export async function run(ctx: M18Ctx): Promise<void> {
  const { check, log, db, mkProject, mkAsset, jreq, ffmpegBin, relPathOf, absPathOf, genMedia, settleTasks, probeMediaDuration, assets, and, eq } = ctx
  const { buildComposeArgs } = await import('../../../src/services/creation/gen')
  const SZ = { width: 100, height: 100 }

  // ---- 旧形态零变化（probe-m17 快照基线） ----
  const a1 = buildComposeArgs({ videoPaths: ['a.mp4'], audioPaths: [], outPath: 'o.mp4' })
  check(
    a1.join(' ') === '-y -i a.mp4 -map 0:v -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -an -movflags +faststart o.mp4',
    'N=1 无新参数 → 旧形态零变化（回归基线）',
  )

  // ---- 转场启用（n=2） ----
  const x1 = buildComposeArgs({ videoPaths: ['a.mp4', 'b.mp4'], audioPaths: [], outPath: 'o.mp4', fps: 24, size: SZ, durations: [4, 5], transition: 'fade', transitionDuration: 0.5 }).join(' ')
  check(
    x1.includes('[0:v]scale=100:100:force_original_aspect_ratio=decrease,pad=100:100:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=0.5,settb=AVTB[v0]'),
    '转场：段0 tpad 冻帧补足 T + settb=AVTB',
  )
  check(
    x1.includes('[1:v]scale=100:100:force_original_aspect_ratio=decrease,pad=100:100:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,settb=AVTB[v1]'),
    '转场：段1（末镜）无 tpad',
  )
  check(x1.includes('[v0][v1]xfade=transition=fade:duration=0.5:offset=4[vout]'), 'xfade 链：offset=4（=Σd 首段）')
  check(!x1.includes('concat'), '转场启用：不出现 concat')
  check(x1.includes('-map [vout]'), '转场：maps [vout]')

  // ---- none / durations 不齐 / 缺失 → 宽容降级 concat ----
  const x2 = buildComposeArgs({ videoPaths: ['a.mp4', 'b.mp4'], audioPaths: [], outPath: 'o.mp4', fps: 24, size: SZ, durations: [4, 5], transition: 'none' }).join(' ')
  check(x2.includes('concat=n=2:v=1:a=0[vout]') && !x2.includes('xfade'), 'transition=none → concat（durations 齐备也不启用）')
  const x3 = buildComposeArgs({ videoPaths: ['a.mp4', 'b.mp4'], audioPaths: [], outPath: 'o.mp4', fps: 24, size: SZ, durations: [4], transition: 'fade' }).join(' ')
  check(x3.includes('concat=n=2') && !x3.includes('xfade'), 'durations 长度不齐 → 降级 concat')
  const x4 = buildComposeArgs({ videoPaths: ['a.mp4', 'b.mp4'], audioPaths: [], outPath: 'o.mp4', fps: 24, size: SZ, transition: 'fade' }).join(' ')
  check(x4.includes('concat=n=2') && !x4.includes('xfade'), 'durations 缺失 → 降级 concat')

  // ---- M17 音频基线（-map [aout] 回归守卫） ----
  const x0 = buildComposeArgs({ videoPaths: ['a.mp4', 'b.mp4'], audioPaths: ['v.mp3'], outPath: 'o.mp4', fps: 24, size: SZ }).join(' ')
  check(
    x0.includes('[2:a]amix=inputs=1:duration=longest[aout]') && x0.includes('-map [aout]') && x0.includes('-c:a aac'),
    'M17 音频基线：amix[aout] → -map [aout] + -c:a aac（回归守卫）',
  )

  // ---- BGM（无原音轨 → anull） ----
  const x5 = buildComposeArgs({ videoPaths: ['a.mp4', 'b.mp4'], audioPaths: [], outPath: 'o.mp4', fps: 24, size: SZ, durations: [4, 5], bgmPath: 'b.mp3' }).join(' ')
  check(x5.includes('-stream_loop -1 -i b.mp3'), 'BGM：-stream_loop -1 输入')
  check(x5.includes('atrim=0:9') && x5.includes('volume=0.5'), 'BGM：atrim=0:totalDur(9) / 默认 volume 0.5')
  check(x5.includes('afade=t=in:st=0:d=1.5') && x5.includes('afade=t=out:st=7.5:d=1.5'), 'BGM：默认首尾 afade 1.5s')
  check(x5.includes('[bgm]anull[aout]') && x5.includes('-map [aout]') && x5.includes('-c:a aac'), 'BGM 无原音轨 → anull[aout] + -map [aout] + -c:a aac')

  // ---- BGM + 原音轨（amix normalize=0；m=1 索引推导） ----
  const x6 = buildComposeArgs({ videoPaths: ['a.mp4', 'b.mp4'], audioPaths: ['v.mp3'], outPath: 'o.mp4', fps: 24, size: SZ, durations: [4, 5], bgmPath: 'b.mp3', bgmVolume: 0.3, bgmFade: false }).join(' ')
  check(x6.includes('[2:a]amix=inputs=1:duration=longest[amix]'), '原音轨 amix 中转 [amix]（n=2 → 输入索引 2）')
  check(x6.includes('[3:a]atrim=0:9') && x6.includes('volume=0.3') && !x6.includes('afade'), 'bgmVolume=0.3 / bgmFade=false → 无 afade')
  check(x6.includes('[amix][bgm]amix=inputs=2:duration=first:normalize=0[aout]') && x6.includes('-map [aout]'), 'BGM 混音：amix duration=first:normalize=0 + -map [aout]')

  // ---- 真实合成全链（转场 + BGM；真实 ffmpeg） ----
  const PID = await mkProject('M18 合成')
  const C = (await jreq('POST', `/api/v1/projects/${PID}/canvases`, { name: '合成画布' })).body.canvas.id
  const mkNode = async (body: unknown): Promise<number> => (await jreq('POST', `/api/v1/canvases/${C}/nodes`, body)).body.node.id
  if (!ffmpegBin) {
    log.info('  SKIP  真实合成全链（未找到 ffmpeg）')
    return
  }
  const v1Rel = relPathOf(PID, 'creation_video', 'seg1.mp4')
  const v2Rel = relPathOf(PID, 'creation_video', 'seg2.mp4')
  const bRel = relPathOf(PID, 'creation_audio', 'bgm.wav')
  const mkArgs = (src: string, out: string): string[] => ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', src, '-pix_fmt', 'yuv420p', '-t', '1', out]
  const ok1 = genMedia(absPathOf(v1Rel), mkArgs('testsrc=duration=1:size=160x120:rate=10', absPathOf(v1Rel)))
  const ok2 = genMedia(absPathOf(v2Rel), mkArgs('testsrc=duration=1:size=160x120:rate=10', absPathOf(v2Rel)))
  const ok3 = genMedia(absPathOf(bRel), ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-t', '3', absPathOf(bRel)])
  check(ok1 && ok2 && ok3, 'ffmpeg 生成 2 段测试视频 + 1 段 BGM（wav）')
  if (!(ok1 && ok2 && ok3)) return
  const A1 = await mkAsset(PID, 'video', '段1', { relPath: v1Rel, duration: 1, width: 160, height: 120 })
  const A2 = await mkAsset(PID, 'video', '段2', { relPath: v2Rel, duration: 1, width: 160, height: 120 })
  const AB = await mkAsset(PID, 'audio', 'BGM', { relPath: bRel, duration: 3 })
  const N1 = await mkNode({ kind: 'asset', assetId: A1, x: 0, y: 0 })
  const N2 = await mkNode({ kind: 'asset', assetId: A2, x: 0, y: 100 })
  const NC = await mkNode({ kind: 'gen', spec: { genKind: 'compose', fps: 10, resolution: '160x120', transition: 'fade', transitionDuration: 0.5, bgmAssetId: AB, bgmFade: false }, x: 300, y: 0 })
  await jreq('POST', `/api/v1/canvases/${C}/edges`, { from: N1, to: NC, port: 'video' })
  await jreq('POST', `/api/v1/canvases/${C}/edges`, { from: N2, to: NC, port: 'video' })
  const run1 = await jreq('POST', `/api/v1/nodes/${NC}/run`, {})
  check(run1.status === 200 && run1.body?.taskIds?.length === 1, 'compose 全链：run → 任务入队')
  const st = await settleTasks([run1.body.taskIds[0]])
  check(st.get(run1.body.taskIds[0]) === 'succeeded', 'compose 全链：succeeded（真实 ffmpeg + xfade + BGM）')
  const outs = await db.select().from(assets).where(and(eq(assets.projectId, PID), eq(assets.purpose, 'creation_compose')))
  const outA = outs[0]
  check(!!outA && outA.kind === 'video', 'compose 产物：video 资产落库')
  if (outA?.relPath) {
    const oAbs = absPathOf(outA.relPath)
    check(existsSync(oAbs) && statSync(oAbs).size > 1000, 'compose 产物文件存在（>1KB）')
    const dur = probeMediaDuration(oAbs)
    check(dur != null && Math.abs(dur - 2) < 0.35, `成片时长 ≈ 2s（实际 ${dur == null ? 'null' : Math.round(dur * 100) / 100}）`)
  }
  if (outA?.params) {
    const pOut = JSON.parse(outA.params) as Record<string, unknown>
    check(pOut.transition === 'fade' && pOut.bgmAssetId === AB, '产物 params：transition/bgmAssetId 留痕')
  }
}
