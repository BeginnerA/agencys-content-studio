/**
 * M53 探针（photo-montage 素材混剪成片）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m53.ts [--section=pure|args|template|live]
 *
 * 隔离策略：isolatedEnv('m53', bridge templates) 一次性临时目录（独立 studio.db + workspace），
 * 必须先于任何 src 动态 import。零网络、零付费：live 节真 engine.startRun 走 photo-montage
 * 全链，素材由本地 ffmpeg 生成（color/testsrc + sine），全程 fetch 桩封死 + 用量表零行断言。
 *
 * 断言面（spec §5）：
 *  - pure：montageEnabled 真值表 / kbDirectionFor / normalizeSizes / planFixedSrt 定时与逐行收敛 /
 *    computeShotSegments mixed 按 kind 分流与 skip；
 *  - args：legacy 零 diff（无 montage 键 args 逐字节 = montage:false 基线）；montage phase-2 形态
 *    （-i 直读/tpad 兜底/无 -loop）；clipAudio 现场轨 concat/amix/映射标签；BGM 并存收口；
 *  - template：loadTemplate('photo-montage') 合法 + builtin 标记 + 关键 params（montage/fixed）；
 *  - live：混排 4 段（2 图 + 有声视频 + 无声视频）成片时长/尺寸/fps/音轨/非静音/溯源/字幕；
 *    单图态（captions skip + transition none + 审阅闸挂起→批准收敛）；probeHasAudioStream 三态。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup } = isolatedEnv('m53', { bridge: ['templates'] })

const SECTIONS = ['pure', 'args', 'template', 'live'] as const

const { createLogger } = await import('../src/logger')
const log = createLogger('probe-m53')
const checker: Checker = makeChecker(log)
const check = checker.check

await runSections({
  log,
  title: 'M53',
  checker,
  cleanup,
  sections: SECTIONS,
  registry: async () => {
    const { initDb } = await import('../src/db')
    await initDb()
    check(true, '初始化隔离库完成（零真实执行）')
  },
  runners: {
    // ================= pure：混剪触发 / KB 方向 / fixed 定时 / mixed 段分流（纯函数） =================
    pure: async () => {
      const { montageEnabled, kbDirectionFor, normalizeSizes } = await import('../src/pipeline/actions/ffmpeg-merge/montage')
      const { planFixedSrt } = await import('../src/pipeline/actions/subtitle')
      const { computeShotSegments } = await import('../src/pipeline/actions/ffmpeg-merge/segments')
      const { ensureProjectDirs, relPathOf, absPathOf } = await import('../src/services/storage')
      const { db } = await import('../src/db')
      const { projects } = await import('../src/db/schema')

      // —— montageEnabled 真值表（spec §2.1）——
      const off = { hasMixed: false, hasVideoSeg: false, strict: false }
      check(montageEnabled({}, off) === false, '无触发键 → legacy 单段链（montageEnabled=false）')
      check(montageEnabled({}, { ...off, strict: true }) === false, 'strict_delivery 恒 false（批准链逐字节红线）')
      check(montageEnabled({ montage: true }, off) === true, 'params.montage=true → 混剪态')
      check(montageEnabled({ montage: false }, { hasMixed: true, hasVideoSeg: true, strict: false }) === false, 'montage=false 强制关闭优先于混排触发')
      check(montageEnabled({}, { hasMixed: true, hasVideoSeg: true, strict: false }) === true, '图+视双输入并存 → 自动混剪态')
      check(montageEnabled({ keep_clip_audio: true }, { hasVideoSeg: true, hasMixed: false, strict: false }) === true, 'keep_clip_audio + 视频段 → 触发')
      check(montageEnabled({ keep_clip_audio: true }, off) === false, 'keep_clip_audio 但无视频段 → 不触发')
      check(montageEnabled({ ken_burns: 'alternate' }, off) === true, 'ken_burns=alternate → 触发（纯照片也走 phase-1）')
      check(montageEnabled({ ken_burns: 'none' }, off) === false && montageEnabled({ ken_burns: '' }, off) === false, 'ken_burns none/空串 → 不触发')

      // —— kbDirectionFor / normalizeSizes ——
      check(kbDirectionFor('in', 0) === 'in' && kbDirectionFor('in', 1) === 'in', 'kb=in 全镜推近')
      check(kbDirectionFor('alternate', 0) === 'in' && kbDirectionFor('alternate', 1) === 'out' && kbDirectionFor('alternate', 2) === 'in', 'alternate 偶推近奇拉远')
      check(kbDirectionFor('none', 0) === null, 'kb=none → 无方向')
      check(normalizeSizes(1920, 1080).ssW === 3840 && normalizeSizes(1920, 1080).ssH === 2160, 'zoompan 底尺寸 ×2 超采样')

      // —— planFixedSrt：定长 + 空行跳过 + total_ms 逐行回退收敛 ——
      const lines = [{ id: '1', text: '第一行' }, { id: '2', text: '  ' }, { id: '3', text: '第三行' }, { id: '4', text: '第四行' }]
      const p1 = planFixedSrt(lines, { ms_per_line: 4000, lead_in_ms: 500 })
      check(p1.length === 3 && p1[0]!.start_ms === 500 && p1[0]!.end_ms === 4500 && p1[2]!.end_ms === 12500, `定长 4000ms + 延时 500ms，空行跳过（3 行，末行 ${p1[2]!.end_ms}ms）`)
      const p2 = planFixedSrt(lines, { ms_per_line: 4000, lead_in_ms: 500, total_ms: 10000 })
      check(p2.length === 3 && p2[2]!.end_ms === 10000 && p2[2]!.start_ms === 8500, 'total_ms=10000 → 末行裁到总长仍保留')
      const p3 = planFixedSrt(lines, { ms_per_line: 4000, lead_in_ms: 500, total_ms: 5000 })
      check(p3.length === 2 && p3[1]!.start_ms === 4500 && p3[1]!.end_ms === 5000, 'total_ms=5000 → 放不下行逐行回退弃行，新末行收敛到 5000ms')
      check(planFixedSrt([], { ms_per_line: 4000 }).length === 0, '空台词 → 空结果（调用方抛错防线）')

      // —— computeShotSegments mixed：按行 kind 分流（真实临时文件过 statSync）——
      const [proj] = await db.insert(projects).values({ name: 'm53-pure', genre: 'other', templateKey: 'photo-montage', status: 'active', settings: '{}', tags: '[]', createdAt: Date.now(), updatedAt: Date.now() }).returning()
      ensureProjectDirs(proj!.id)
      const touch = (name: string): string => {
        const rel = relPathOf(proj!.id, 'source', name)
        writeFileSync(absPathOf(rel), 'probe-m53-bytes', 'utf8')
        return rel
      }
      const imgRel = touch('a.png')
      const vidRel = touch('b.mp4')
      const rows = [
        { id: 1, kind: 'image', relPath: imgRel, params: JSON.stringify({ shotId: 's1' }) },
        { id: 2, kind: 'image', relPath: imgRel, params: null },
        { id: 3, kind: 'video', relPath: vidRel, duration: 3.2, params: null },
        { id: 4, kind: 'audio', relPath: vidRel, params: null },
        { id: 5, kind: 'image', relPath: 'projects/999999/source/none.png', params: null },
      ] as never
      const { segments, skipped } = computeShotSegments(rows, 'mixed', new Map([['s1', 5]]), 2)
      check(segments.length === 3 && skipped.join(',') === '4,5', `mixed 分流：图2+视1 成段、音频与缺文件 skip（skipped=${skipped}）`)
      check(segments[0]!.kind === 'image' && segments[0]!.durSec === 5 && segments[0]!.explicit === true, '图段 per-shot 覆盖优先（s1→5s explicit）')
      check(segments[1]!.kind === 'image' && segments[1]!.durSec === 2 && segments[1]!.explicit === false, '无覆盖图段 → duration_per_shot（explicit=false 标记非 per-shot）')
      check(segments[2]!.kind === 'video' && segments[2]!.durSec === 3.2, '视频段按资产 duration 实测长')
    },

    // ================= args：legacy 零 diff + montage/clipAudio 形态（纯函数） =================
    args: async () => {
      const { buildComposeArgs } = await import('../src/pipeline/actions/ffmpeg-merge/args')
      const { buildNormalizeArgs } = await import('../src/pipeline/actions/ffmpeg-merge/montage')
      const noXf = (n: number) => ({ enabled: false, type: 'none', durSec: 0, videoLens: [], offsets: [], totalDur: n }) as never
      const imgSegs = [
        { id: 1, path: 'in/a.png', kind: 'image', durSec: 4 },
        { id: 2, path: 'in/b.png', kind: 'image', durSec: 4 },
      ] as never
      const normSegs = [
        { id: 1, path: 'tmp/s0.mp4', kind: 'video', durSec: 4 },
        { id: 2, path: 'tmp/s1.mp4', kind: 'video', durSec: 3 },
      ] as never
      const base = (over: Record<string, unknown>) => ({
        segments: imgSegs, width: 320, height: 240, fps: 12, xfadePlan: noXf(8),
        voicePaths: [], lineIds: [], alignPlan: null, total: 8, srtAbs: null, style: 'x',
        bgmPath: null, bgmVolume: 0.35, bgmFade: 0, watermark: null, intro: null, outro: null, outAbs: 'out.mp4',
        ...over,
      }) as never
      const j = (r: { args: string[] }): string => r.args.join(' ')

      // —— legacy 零 diff（spec §4）：montage 未传 = 基线逐字节 ——
      const legacyA = j(buildComposeArgs(base({})))
      const legacyB = j(buildComposeArgs(base({ montage: undefined, clipAudio: undefined })))
      const legacyC = j(buildComposeArgs(base({ montage: false, clipAudio: false })))
      check(legacyA === legacyB && legacyA === legacyC, '无 montage 键输入 → args 与 montage:false 基线逐字节一致')
      check(legacyA.includes('-loop') && !legacyA.includes('clipa') && !legacyA.includes('settb=AVTB'), 'legacy 图链形态保留（-loop 1 存在、无现场轨/无 AVTB）')

      // —— montage phase-2 形态：归一段 -i 直读、轻量时基链 ——
      const m1 = j(buildComposeArgs(base({ segments: normSegs, total: 7, montage: true })))
      check(!m1.includes('-loop') && m1.includes('[0:v]setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=4,trim=duration=4'), 'montage 段 -i 直读 + tpad 兜底/trim 定长轻量链（无 -loop）')
      check(m1.includes('fps=12,settb=AVTB[v0]') && !m1.includes('clipa') && !m1.includes('[0:a]'), '无 clipAudio → 现场轨丢弃（legacy 音频语义同今）')

      // —— clipAudio：per-seg [i:a] concat 连续现场轨占 [outa] 槽 ——
      const m2 = j(buildComposeArgs(base({ segments: normSegs, total: 7, montage: true, clipAudio: true })))
      check(m2.includes('[0:a][1:a]concat=n=2:v=0:a=1') && m2.includes('[clipa]'), '现场轨 concat → [clipa]')
      check(m2.includes('-map [clipa]') && m2.includes('-c:a aac'), '无配音无 BGM → [clipa] 直接上映射（含音轨编码）')

      // —— clipAudio + voices：amix 叠加收敛 ——
      const m3 = j(buildComposeArgs(base({ segments: normSegs, total: 7, montage: true, clipAudio: true, voicePaths: ['in/v1.mp3', 'in/v2.mp3'], lineIds: ['l1', 'l2'] })))
      check(m3.includes('[clipa][outa]amix=inputs=2:duration=longest:normalize=0') && m3.includes('-map [outa2]'), '原声 + 配音并存 → amix(normalize=0) 叠加 [outa2] 上映射')

      // —— clipAudio + BGM：既有 duration=first 收口，主槽位换现场轨 ——
      const m4 = j(buildComposeArgs(base({ segments: normSegs, total: 7, montage: true, clipAudio: true, bgmPath: 'in/bgm.mp3', bgmFade: 2 })))
      check(m4.includes('[clipa][bgm]amix=inputs=2:duration=first:normalize=0[aout]') && m4.includes('-stream_loop -1'), 'BGM 并存 → [clipa] 占主轨槽 amix duration=first + 循环铺满')

      // —— buildNormalizeArgs 形状（phase-1）——
      const nb = (over: Record<string, unknown>) => ({ width: 320, height: 240, fps: 12, kb: null, clipHasAudio: null, outAbs: 'tmp/o.mp4', ...over } as never)
      const imgSeg = { id: 1, path: 'in/a.png', kind: 'image', durSec: 4 } as never
      const vidSeg = { id: 2, path: 'in/b.mp4', kind: 'video', durSec: 3 } as never
      const kbArgs = buildNormalizeArgs(imgSeg, nb({ kb: 'in' })).join(' ')
      check(kbArgs.includes("zoompan=z='min(1+0.005*on,1.25)'") && kbArgs.includes('d=48') && kbArgs.includes('s=320x240'), '图片段 kb=in：zoompan step=0.25/48帧=0.005 d=48 输出 320x240')
      check(kbArgs.includes('scale=640:480:force_original_aspect_ratio=increase') && kbArgs.includes('anullsrc=r=44100:cl=stereo:d=4'), 'kb 底图 ×2 超采样 + 静音轨必带')
      check(!kbArgs.includes('-frames:v 1') && kbArgs.includes('-t 4'), 'kb 段连续产出（无单帧限制）+-t 精确截长')
      const stillArgs = buildNormalizeArgs(imgSeg, nb({})).join(' ')
      check(stillArgs.includes('-frames:v 1') && stillArgs.includes('anullsrc') && !stillArgs.includes('zoompan'), '图片段无 kb：定帧 + 静音轨（phase-2 tpad 撑长）')
      const vidArgs = buildNormalizeArgs(vidSeg, nb({ clipHasAudio: true })).join(' ')
      check(vidArgs.includes('[0:a]') && vidArgs.includes('apad=whole_dur=3') && !vidArgs.includes('anullsrc'), '视频段有原声：apad/atrim 保原声定长')
      const vidSilent = buildNormalizeArgs(vidSeg, nb({ clipHasAudio: false })).join(' ')
      check(vidSilent.includes('anullsrc=r=44100:cl=stereo:d=3') && !vidSilent.includes('[0:a]'), '视频段探测确认无声 → lavfi 静音轨兜底（必带 a 流）')
      check(buildNormalizeArgs(vidSeg, nb({ clipHasAudio: null })).join(' ').includes('[0:a]'), '探测失败（null）宽容按有声处理')
    },

    // ================= template：photo-montage 内置模板静态面 =================
    template: async () => {
      const { loadTemplate, templateFlags, KNOWN_ACTIONS } = await import('../src/pipeline/loader')
      const t = loadTemplate('photo-montage')
      check(templateFlags('photo-montage').builtin === true, 'photo-montage 标记 builtin=true（出厂只读）')
      const keys = t.inputs?.map((i) => i.key) ?? []
      check(['photos', 'clips', 'title', 'lines_text', 'duration_per_shot', 'fps', 'resolution', 'ken_burns', 'keep_clip_audio', 'confirm'].every((k) => keys.includes(k)), `模板输入面齐全（实际 ${keys.join('/')}）`)
      check(t.steps.some((s) => s.key === 'captions' && s.action === 'subtitle' && (s.params as Record<string, unknown>)?.mode === 'fixed'), 'captions 步 subtitle mode=fixed（零 LLM 定时）')
      const compose = t.steps.find((s) => s.key === 'compose')!
      const cp = compose.params as Record<string, unknown>
      check(compose.action === 'ffmpeg_merge' && cp.montage === true && cp.cover === true, 'compose 步 ffmpeg_merge montage/cover 开启')
      check((compose.inputs as Record<string, string>).images === 'input.photos' && (compose.inputs as Record<string, string>).motion_clips === 'input.clips', 'photos/clips 双输入直映射（混排由引擎分流）')
      const mapIn = compose.inputs as Record<string, string>
      check(['duration_per_shot', 'fps', 'resolution', 'ken_burns', 'keep_clip_audio'].every((k) => mapIn[k] === `input.${k}`), '标量调参输入桥映射齐全')
      check((KNOWN_ACTIONS as readonly string[]).includes('ffmpeg_merge') && (KNOWN_ACTIONS as readonly string[]).includes('subtitle'), 'subtitle/ffmpeg_merge 均在 KNOWN_ACTIONS')
    },

    // ================= live：真引擎混剪全链实弹（本地生成素材，零计费） =================
    live: async () => {
      const { db, initDb } = await import('../src/db')
      const { projects, pipelineRuns, pipelineSteps, assets, usageRecords } = await import('../src/db/schema')
      const { eq, and } = await import('drizzle-orm')
      const { loadTemplate } = await import('../src/pipeline/loader')
      const { engine } = await import('../src/pipeline/engine')
      const { ensureProjectDirs, relPathOf, absPathOf, registerAsset, readTextAsset } = await import('../src/services/storage')
      const { resolveFfmpeg, resolveFfprobe, probeMediaDuration } = await import('../src/services/ffmpeg')
      const { probeHasAudioStream } = await import('../src/pipeline/actions/ffmpeg-merge/montage')
      await initDb()
      const ffmpeg = resolveFfmpeg()!
      const ffprobe = resolveFfprobe()!
      const gen = (abs: string, args: string[]): void => {
        const r = spawnSync(ffmpeg, ['-y', '-v', 'error', ...args, abs], { encoding: 'utf8', timeout: 120_000, windowsHide: true })
        if (r.status !== 0) throw new Error(`探针生成素材失败 ${abs}: ${(r.stderr ?? '').slice(-200)}`)
      }
      const [proj] = await db.insert(projects).values({ name: 'm53-live', genre: 'other', templateKey: 'photo-montage', status: 'active', settings: '{}', tags: '[]', createdAt: Date.now(), updatedAt: Date.now() }).returning()
      const pid = proj!.id
      ensureProjectDirs(pid)
      const reg = async (kind: 'image' | 'video', name: string, abs: string, rel: string, duration?: number): Promise<number> =>
        (await registerAsset(pid, { name, kind, purpose: 'source', relPath: rel, ext: name.split('.').pop()!, mime: kind === 'image' ? 'image/png' : 'video/mp4', ...(duration ? { duration } : {}) })).id

      // 素材：2 张照片（320x240 纯色 png）+ 有声视频 3s（blue+sine）+ 无声视频 3s
      const mkImg = async (color: string, id: string): Promise<number> => {
        const rel = relPathOf(pid, 'source', `${id}-${Date.now()}.png`)
        gen(absPathOf(rel), ['-f', 'lavfi', '-i', `color=c=${color}:s=320x240`, '-frames:v', '1', '-update', '1'])
        return reg('image', `${id}.png`, absPathOf(rel), rel)
      }
      const mkClip = async (withAudio: boolean): Promise<number> => {
        const rel = relPathOf(pid, 'source', `clip${withAudio ? 'voiced' : 'silent'}-${Date.now()}.mp4`)
        const abs = absPathOf(rel)
        const a = withAudio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'aac'] : ['-an']
        gen(abs, ['-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=12:d=3', ...a, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'])
        return reg('video', 'clip.mp4', abs, rel, 3)
      }
      const img1 = await mkImg('red', 'red')
      const img2 = await mkImg('green', 'green')
      const clipV = await mkClip(true)
      const clipS = await mkClip(false)

      // probeHasAudioStream 三态：有声 true / 无声 false / 不存在 null
      const p = async (assetId: number): Promise<string> => (await db.select().from(assets).where(eq(assets.id, assetId)))[0]!.relPath!
      check(probeHasAudioStream(absPathOf(await p(clipV))) === true, 'probeHasAudioStream：含 sine 音轨 mp4 → true')
      check(probeHasAudioStream(absPathOf(await p(clipS))) === false, 'probeHasAudioStream：-an 无声 mp4 → false')
      check(probeHasAudioStream(absPathOf('projects/999999/source/none.mp4')) === false || probeHasAudioStream(absPathOf('projects/999999/source/none.mp4')) === null, 'probeHasAudioStream：文件缺失 → false/null（宽容不炸链）')

      const runOf = async (id: number) => (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)))[0]!
      const settle = async (id: number): Promise<Awaited<ReturnType<typeof runOf>>> => {
        for (let i = 0; i < 2400; i++) {
          if (!engine.isRunning(id)) return runOf(id)
          await new Promise((r) => setTimeout(r, 25))
        }
        throw new Error(`live run ${id} 未收敛`)
      }
      const startRun = async (input: Record<string, unknown>): Promise<number> => {
        const now = Date.now()
        const [run] = await db.insert(pipelineRuns).values({
          projectId: pid, templateKey: 'photo-montage', templateSnapshot: JSON.stringify(loadTemplate('photo-montage')),
          status: 'queued', input: JSON.stringify(input), createdAt: now, updatedAt: now,
        } as never).returning()
        engine.startRun(run!.id)
        return run!.id
      }
      const finalOf = async (runId: number) => (await db.select().from(assets).where(and(eq(assets.runId, runId), eq(assets.purpose, 'final_video'))))[0]!
      const streamInfo = (abs: string): { dur: number; w: number; h: number; fps: string; aStreams: number } => {
        const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,r_frame_rate,codec_type', '-of', 'json', abs], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
        const doc = JSON.parse(r.stdout || '{}') as { format?: { duration?: string }; streams?: Array<{ width?: number; height?: number; r_frame_rate?: string; codec_type?: string }> }
        const v = (doc.streams ?? []).find((s) => s.codec_type === 'video')!
        return { dur: Number(doc.format?.duration ?? 0), w: v.width ?? 0, h: v.height ?? 0, fps: v.r_frame_rate ?? '', aStreams: (doc.streams ?? []).filter((s) => s.codec_type === 'audio').length }
      }

      // —— run A：图2 + 有声视 + 无声视混排 + 标题字幕 + fade 转场（免审直通）——
      const fetchBak = globalThis.fetch
      globalThis.fetch = (async () => { throw new Error('M53 live 探针禁止网络（零付费红线）') }) as typeof fetch
      let runA = 0
      try {
        runA = await startRun({
          photos: [img1, img2], clips: [clipV, clipS], title: '囍 · 喜结连理\n百年好合',
          duration_per_shot: 2, fps: 12, resolution: '320x240', ken_burns: 'alternate', keep_clip_audio: true,
        })
        const rA = await settle(runA)
        check(rA.status === 'completed', `run A 混剪全链 completed（实际 ${rA.status}${rA.error ? ` / ${String(rA.error).slice(0, 120)}` : ''}）`)
        const capA = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runA))
        check(capA.find((s) => s.stepKey === 'captions')?.status === 'succeeded' && capA.find((s) => s.stepKey === 'compose')?.status === 'succeeded', 'captions(fixed) + compose 两步成功')
        check((await db.select().from(usageRecords).where(eq(usageRecords.runId, runA))).length === 0, 'run A 零 LLM 零计费（usage_records 0 行）')
        // 字幕产物：2 行定长 SRT（500ms 起、每行 4000ms）
        const srtRow = (await db.select().from(assets).where(eq(assets.purpose, 'subtitle')))[0]!
        const srtText = await readTextAsset(srtRow.id)
        check(srtText.includes('囍 · 喜结连理') && srtText.includes('百年好合') && srtText.includes('00:00:00,500 --> 00:00:04,500') && srtText.includes('00:00:04,500 --> 00:00:08,500'), 'fixed 字幕两行定长计时（500ms→4500ms→8500ms）')
        // 成片物理核验：Σd=10（fade 不改总长）、320x240@12、1 条音轨、非数字静音
        const fv = await finalOf(runA)
        const abs = fv ? absPathOf(fv.relPath!) : null
        check(!!abs && existsSync(abs), '成片资产存在且文件落盘')
        const info = streamInfo(abs!)
        check(Math.abs(info.dur - 10) <= 0.6, `成片时长 ≈ Σd=10s（fade 转场保总长，实际 ${info.dur.toFixed(2)}s）`)
        check(info.w === 320 && info.h === 240 && info.fps === '12/1', `成片 320x240@12fps（实际 ${info.w}x${info.h}@${info.fps}）`)
        check(info.aStreams === 1, '成片含 1 条音轨（照片静音段 + 原声段归一拼接）')
        const vd = spawnSync(ffmpeg, ['-v', 'info', '-i', abs!, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
        const mean = Number(/mean_volume:\s*(-[\d.]+)\s*dB/.exec(String(vd.stderr))?.[1] ?? NaN)
        check(Number.isFinite(mean) && mean > -90, `音轨非数字静音（mean_volume=${mean}dB，含 4s 正弦原声）`)
        // 溯源 params：混排段数 / montage 溯源 / 转场启用 / 字幕标记
        const pa = JSON.parse(fv.params ?? '{}') as Record<string, any>
        check(pa.montage?.mixed === true && pa.montage?.normalized_segments === 4 && pa.montage?.keep_clip_audio === true && pa.montage?.ken_burns === 'alternate', `montage 溯源（mixed/4 段/原声/alternate，实际 ${JSON.stringify(pa.montage)}）`)
        check(pa.images === 2 && pa.motion_clips === 2 && pa.subtitle === 1, 'params 图2+视2 计数与字幕烧录标记')
        check(pa.transition?.enabled === true && pa.transition?.type === 'fade', 'fade 转场启用（模板默认）')
        check((pa.tags ?? fv.tags ?? '').toString().includes('with_audio') && String(fv.tags ?? '').includes('with_subtitle'), '成片 tags with_audio/with_subtitle')
        // 混排顺序 = photos→clips 拼接序（inputs 快照真实资产列）
        check(pa.inputs?.images?.join(',') === `${img1},${img2}` && pa.inputs?.motion_clips?.join(',') === `${clipV},${clipS}`, 'inputs 快照记真实资产列（照片在前=时间轴顺序契约）')
      } finally {
        globalThis.fetch = fetchBak
      }

      // —— run B：单图 + kb=in + 无字幕输入（captions skip）+ _compose 关转场 + 审阅闸挂起→批准 ——
      const runB = await startRun({
        photos: [img1], duration_per_shot: 2, fps: 12, resolution: '320x240', ken_burns: 'in', keep_clip_audio: false,
        confirm: true, _compose: { transition: 'none' },
      })
      const rB1 = await settle(runB)
      check(rB1.status === 'waiting_input' && rB1.currentStepKey === 'compose', `run B confirm=true → 成片审阅闸挂起（实际 ${rB1.status}/${rB1.currentStepKey}）`)
      const skippedB = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runB))
      check(skippedB.find((s) => s.stepKey === 'captions')?.status === 'skipped', '无 title/lines_text → captions when_any 不满足跳过')
      await engine.approveGate(runB, 'compose', { note: 'ok' })
      const rB2 = await settle(runB)
      check(rB2.status === 'completed', `run B 批准后完成（实际 ${rB2.status}）`)
      const fvB = await finalOf(runB)
      const infoB = streamInfo(absPathOf(fvB!.relPath!))
      // 纯照片 + keep_clip_audio=false + 无 BGM/配音 → 无音轨（与 legacy 无音频输入语义逐字节一致：phase-2 丢弃现场轨）
      check(Math.abs(infoB.dur - 2) <= 0.4 && infoB.w === 320 && infoB.aStreams === 0, `单图混剪成片 ≈2s/320x240/无音轨（无音频输入不造假轨，实际 ${infoB.dur.toFixed(2)}s/${infoB.w}x${infoB.h}/${infoB.aStreams}a）`)
      const pb = JSON.parse(fvB.params ?? '{}') as Record<string, any>
      check(pb.montage?.mixed === false && pb.montage?.normalized_segments === 1 && pb.montage?.ken_burns === 'in', '纯照片单段也走混剪态（kb=in 触发归一化）')
      check(pb.transition?.enabled === false, '_compose transition=none 覆盖生效（转场两态）')
      check(existsSync(absPathOf(fvB.relPath!)), '批准后成片文件存在（审阅闸不吞产物）')
    },
  },
})
