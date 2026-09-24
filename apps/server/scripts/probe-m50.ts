/**
 * M50 探针（剪辑工程交换导出）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m50.ts [--section=timecode|formatters|snapshot|sources|bundle|redline]
 *
 * 隔离：CSTUDIO_ROOT/DATA/WORKSPACE 指一次性临时目录（独立 studio.db + workspace，零网络零计费）。
 * 断言面（规格 §探针）：
 *   timecode      sec↔帧↔时码对拍（fps=25 整帧 / 非整帧舍入 / NDF 10800s 边界）
 *   formatters    OTIO 可 JSON.parse 且五轨命名；FCPXML 含 format/sequence/title/transition；EDL 时码升序 + Dissolve
 *   snapshot      buildEditTimeline 坐标口径（内容轴 + intro 位移 / sfx 绝对轴 / 文本截断）
 *   sources       params.timeline stored 直通 / 旧产物 recomputed 兜底 / 双失败 no_timeline / 无成片 no_final_video
 *   bundle        buildEditExchange 落 archive 资产 + zip 内 manifest↔media 引用一致 + bad_format
 *   redline       ffmpeg-merge/index.ts ≤800 / edit-exchange 各文件 <400 行数自查
 * 退出码：0 = 全通过；1 = 有 FAIL。
 */
import { writeFileSync, readFileSync, statSync } from 'node:fs'
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'
import type { EditTimeline } from '../src/pipeline/actions/ffmpeg-merge/timeline-snapshot'

const { tmp: _TMP, cleanup: envCleanup } = isolatedEnv('m50')
process.env.AGENT_LLM_BASE_URL = ''
process.env.AGENT_LLM_API_KEY = ''

const SECTIONS = ['timecode', 'formatters', 'snapshot', 'sources', 'bundle', 'redline'] as const

const stubFetch = (async (): Promise<Response> => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch

async function main(): Promise<void> {
  const origFetch = globalThis.fetch
  globalThis.fetch = stubFetch

  // 纯函数（无 env 依赖）
  const { secToFrames, framesToTimecode, secToTimecode } = await import('../src/services/edit-exchange/timecode')
  const { toFcpxml } = await import('../src/services/edit-exchange/fcpxml')
  const { toEdl } = await import('../src/services/edit-exchange/edl')
  const { renderOtio } = await import('../src/services/edit-exchange/otio')
  const { makeCtx } = await import('../src/services/edit-exchange/render-context')
  const { buildEditTimeline } = await import('../src/pipeline/actions/ffmpeg-merge/timeline-snapshot')

  // DB / 服务层
  const { db, initDb } = await import('../src/db')
  const { createLogger } = await import('../src/logger')
  const { assets, pipelineRuns, pipelineSteps, projects } = await import('../src/db/schema')
  const { absPathOf, ensureProjectDirs, relPathOf } = await import('../src/services/storage')
  const { resolveEditTimeline, EditExchangeError } = await import('../src/services/edit-exchange/timeline-source')
  const { buildEditExchange, probeEditExchange } = await import('../src/services/edit-exchange')
  const { unzipSync } = await import('fflate')

  const log = createLogger('probe-m50')
  const checker: Checker = makeChecker(log)
  const check = checker.check
  await initDb()
  const T0 = 1_700_000_000_000

  // ---- 夹具工厂 ----
  const mkProject = async (name: string): Promise<number> => {
    const id = (await db.insert(projects).values({ name, genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 }).returning())[0]!.id
    ensureProjectDirs(id)
    return id
  }
  const mkRun = async (projectId: number): Promise<number> =>
    (await db.insert(pipelineRuns).values({ projectId, templateKey: 'mengbao-episode', status: 'completed', input: '{}', createdAt: T0, updatedAt: T0 }).returning())[0]!.id
  const mkStep = async (runId: number, assetIds: number[]): Promise<void> => {
    await db.insert(pipelineSteps).values({ runId, seq: 1, stepKey: 'compose', actionKey: 'ffmpeg_merge', status: 'succeeded', output: JSON.stringify({ asset_ids: assetIds }), createdAt: T0, updatedAt: T0 })
  }
  const mkAsset = async (
    projectId: number, runId: number, kind: string, name: string,
    o: { purpose?: string; relPath?: string; params?: unknown; duration?: number; prompt?: string } = {},
  ): Promise<number> =>
    (await db.insert(assets).values({
      projectId, runId, kind, name, purpose: o.purpose ?? null, relPath: o.relPath ?? null,
      mime: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mpeg' : 'application/json',
      ext: kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'json',
      duration: o.duration ?? null, prompt: o.prompt ?? null, params: o.params === undefined ? null : JSON.stringify(o.params),
      tags: '[]', createdAt: T0, updatedAt: T0,
    }).returning())[0]!.id
  const mkFile = (relPath: string, bytes: number): void => { writeFileSync(absPathOf(relPath), Buffer.alloc(bytes, 0x41)) }

  // 一份规范 EditTimeline（供格式化器纯结构断言复用）
  const fixtureTl = (withTr = false): EditTimeline => ({
    v: 1, fps: 25, width: 1080, height: 1920, totalSec: 12, introSec: 1, outroSec: 0,
    segments: [
      { shotId: 's1', assetId: 11, relPath: 'p/images/s1.png', kind: 'image', durSec: 5, startSec: 0, lineIds: ['l1'], silenceSec: 0 },
      { shotId: 's2', assetId: 12, relPath: 'p/images/s2.png', kind: 'image', durSec: 7, startSec: 5, lineIds: ['l2'], silenceSec: 0 },
    ],
    lines: [
      { lineId: 'l1', assetId: 21, relPath: 'p/audio/v1.mp3', timelineStart: 0, durSec: 4, text: '第一句台词' },
      { lineId: 'l2', assetId: 22, relPath: 'p/audio/v2.mp3', timelineStart: 5, durSec: 6, text: '第二句' },
    ],
    sfx: [{ shotId: 's2', assetId: 31, startSec: 6.5, relPath: 'p/audio/sfx1.wav' }],
    bgm: { assetId: 41, relPath: 'p/audio/bgm.mp3', volume: 0.3, fadeSec: 1 },
    transition: withTr ? { type: 'fade', durSec: 0.5 } : null,
    subtitle: { assetId: 51, relPath: 'p/texts/sub.srt' },
    watermark: false,
  })

  // ---- section: timecode ----
  const timecode = async (): Promise<void> => {
    check(secToFrames(4, 25) === 100, 'fps=25 整秒 4s → 100 帧')
    check(secToFrames(1.5, 25) === 38, '非整帧 1.5s@25 → 就近 38 帧')
    check(framesToTimecode(100, 25) === '00:00:04:00', '100 帧 → 00:00:04:00')
    check(framesToTimecode(38, 25) === '00:00:01:13', '38 帧 → 00:00:01:13')
    check(secToTimecode(10800, 25) === '03:00:00:00', 'NDF 10800s（3 小时整）→ 03:00:00:00')
    check(secToTimecode(3661.5, 25) === '01:01:01:13', '3661.5s@25 → 01:01:01:13')
    check(framesToTimecode(0, 25) === '00:00:00:00', '0 帧 → 零时码')
    check(secToFrames(-5, 25) === 0, '负秒收敛 0 帧')
    check(secToFrames(2, 0) === 50, '非法 fps=0 兜底 25')
  }

  // ---- section: formatters ----
  const formatters = async (): Promise<void> => {
    const ctx = makeCtx('proj_ep_run1')
    // OTIO
    const otio = JSON.parse(renderOtio(fixtureTl(), ctx)) as { tracks: { children: Array<{ name: string; kind: string; children: Array<Record<string, unknown>> }> }; metadata: Record<string, unknown> }
    const clipCount = (arr: Array<Record<string, unknown>>): number => arr.filter((c) => String(c.OTIO_SCHEMA ?? '').includes('Clip')).length
    const names = otio.tracks.children.map((t) => t.name)
    check(otio.tracks.children.length === 5, 'OTIO 五轨')
    check(JSON.stringify(names) === JSON.stringify(['Video', 'Dialogue Audio', 'Music', 'Effects', 'Markdown']), 'OTIO 轨名固定')
    check(clipCount(otio.tracks.children[0]!.children) === 2, 'OTIO Video 轨 2 段')
    check(clipCount(otio.tracks.children[1]!.children) === 2, 'OTIO Dialogue 轨 2 句')
    check(clipCount(otio.tracks.children[2]!.children) === 1, 'OTIO Music 轨 1 段 BGM')
    check(otio.metadata.fps === 25, 'OTIO metadata.fps=25')
    // FCPXML
    const xml = toFcpxml(fixtureTl(true), ctx)
    check(xml.startsWith('<?xml'), 'FCPXML XML 声明头')
    check(xml.includes('fcpxml version="1.10"'), 'FCPXML 1.10 版本')
    check(/<format /.test(xml), 'FCPXML 含 format')
    check(/<sequence /.test(xml), 'FCPXML 含 sequence')
    check(/<title /.test(xml), 'FCPXML 含 title（字幕）')
    check(/<transition /.test(xml), 'FCPXML 转场启用含 transition')
    check((xml.match(/<asset /g) ?? []).length >= 4, 'FCPXML resources 登记多资产')
    check(!toFcpxml(fixtureTl(false), ctx).includes('<transition '), 'FCPXML 无转场不含 transition')
    // EDL
    const edl = toEdl(fixtureTl(true), ctx)
    check(edl.includes('TITLE:'), 'EDL 含 TITLE')
    check(edl.includes('FCM: NON-DROP FRAME'), 'EDL NDF 声明')
    const vLines = edl.split(/\r?\n/).filter((l) => /^\d{4}\s+\S+\s+V\s/.test(l))
    check(vLines.length === 2, 'EDL V 轨 2 事件')
    // record-in = 该行第 3 个时码 token（si so [ri] ro）
    const recInOf = (l: string): string => (l.match(/\d{2}:\d{2}:\d{2}:\d{2}/g) ?? [])[2] ?? ''
    check(recInOf(vLines[0]!) !== '' && recInOf(vLines[0]!) <= recInOf(vLines[1]!), `EDL record 时码升序（${recInOf(vLines[0]!)} ≤ ${recInOf(vLines[1]!)}）`)
    check(vLines.some((l) => /\sD(\s|$)/.test(l)), 'EDL 转场启用含 Dissolve(D) 行')
    check(!toEdl(fixtureTl(false), ctx).split(/\r?\n/).some((l) => /^\d{4}\s+\S+\s+V\s+D/.test(l)), 'EDL 无转场不含 D 事件')
  }

  // ---- section: snapshot ----
  const snapshot = async (): Promise<void> => {
    const align = { aligned: true as const, segments: [{ shotId: 's1', durSec: 5, lineIds: ['l1'], silenceSec: 1 }], lines: [{ lineId: 'l1', speechStart: 0, timelineStart: 0 }], totalDur: 5 }
    const tl = buildEditTimeline({
      fps: 25, width: 720, height: 1280, totalSec: 11, introSec: 1, outroSec: 0,
      segments: [
        { id: 11, path: '/abs/s1.png', kind: 'image', durSec: 5 },
        { id: 12, path: '/abs/s2.png', kind: 'image', durSec: 5 },
      ],
      rows: [
        { id: 11, relPath: 'p/images/s1.png', params: JSON.stringify({ shotId: 's1' }) } as unknown as typeof assets.$inferSelect,
        { id: 12, relPath: 'p/images/s2.png', params: JSON.stringify({ shotId: 's2' }) } as unknown as typeof assets.$inferSelect,
      ],
      alignPlan: align as never,
      voices: [
        { assetId: 21, lineId: 'l1', durSec: 4, relPath: 'p/audio/v1.mp3', text: '很长的台词'.repeat(40) },
        { assetId: 22, lineId: 'l2', durSec: 1, relPath: 'p/audio/v2.mp3', text: 'x' },
      ],
      sfx: [{ shotId: 's2', assetId: 31, startSec: 6, relPath: 'p/audio/sfx.wav' }],
      bgm: null, transition: null, subtitle: null, watermark: false,
    })
    check(tl.segments[0]!.startSec === 0 && tl.segments[1]!.startSec === 5, 'segments.startSec = 内容轴累计')
    check(tl.segments[0]!.relPath === 'p/images/s1.png' && tl.segments[0]!.shotId === 's1', 'segments 反查 relPath/shotId')
    check(tl.segments[0]!.lineIds.join('') === 'l1', 'segments.lineIds 取自对齐计划')
    check(tl.lines[0]!.timelineStart === 0 && tl.lines[1]!.timelineStart === 4, '有 alignPlan 时 lines.timelineStart 取计划；无则 concat 累计')
    check(tl.lines[0]!.text.length <= 200, '台词文本截断 ≤200（体积护栏）')
    check(tl.sfx[0]!.startSec === 6, 'sfx.startSec 原样（绝对轴口径）')
  }

  // ---- 组装 stored run（params.timeline 直通）----
  const seedStoredRun = async (): Promise<{ projectId: number; runId: number }> => {
    const projectId = await mkProject('stored')
    const runId = await mkRun(projectId)
    const s1 = relPathOf(projectId, 'shot_image', 's1.png'); mkFile(s1, 512)
    const s2 = relPathOf(projectId, 'shot_image', 's2.png'); mkFile(s2, 512)
    const v1 = relPathOf(projectId, 'voice', 'v1.mp3'); mkFile(v1, 128)
    const sa1 = await mkAsset(projectId, runId, 'image', 's1.png', { purpose: 'shot_image', relPath: s1, params: { shotId: 's1' } })
    const sa2 = await mkAsset(projectId, runId, 'image', 's2.png', { purpose: 'shot_image', relPath: s2, params: { shotId: 's2' } })
    const va1 = await mkAsset(projectId, runId, 'audio', 'v1.mp3', { purpose: 'voice', relPath: v1, params: { lineId: 'l1' }, duration: 4, prompt: '第一句' })
    const timeline: EditTimeline = {
      v: 1, fps: 25, width: 1080, height: 1920, totalSec: 10, introSec: 0, outroSec: 0,
      segments: [
        { shotId: 's1', assetId: sa1, relPath: s1, kind: 'image', durSec: 5, startSec: 0, lineIds: ['l1'], silenceSec: 0 },
        { shotId: 's2', assetId: sa2, relPath: s2, kind: 'image', durSec: 5, startSec: 5, lineIds: [], silenceSec: 0 },
      ],
      lines: [{ lineId: 'l1', assetId: va1, relPath: v1, timelineStart: 0, durSec: 4, text: '第一句' }],
      sfx: [], bgm: null, transition: null, subtitle: null, watermark: false,
    }
    const finalRel = relPathOf(projectId, 'final_video', 'final.mp4'); mkFile(finalRel, 1024)
    const finalId = await mkAsset(projectId, runId, 'video', 'final.mp4', { purpose: 'final_video', relPath: finalRel, params: { fps: 25, resolution: '1080x1920', duration: 10, timeline }, duration: 10 })
    await mkStep(runId, [sa1, sa2, va1, finalId])
    return { projectId, runId }
  }

  // ---- section: sources ----
  const sources = async (): Promise<void> => {
    // stored 直通
    const { runId } = await seedStoredRun()
    const r1 = await resolveEditTimeline(runId)
    check(r1.source === 'stored', 'stored：params.timeline 直通')
    check(r1.timeline.segments.length === 2, 'stored：段数一致')

    // recomputed 兜底（无 timeline，有 inputs.images + shots.lines + voices.duration）
    const p2 = await mkProject('recomp')
    const ru2 = await mkRun(p2)
    const rs1 = relPathOf(p2, 'shot_image', 'a.png'); mkFile(rs1, 256)
    const rs2 = relPathOf(p2, 'shot_image', 'b.png'); mkFile(rs2, 256)
    const as1 = await mkAsset(p2, ru2, 'image', 'a.png', { purpose: 'shot_image', relPath: rs1, params: { shotId: 's1' } })
    const as2 = await mkAsset(p2, ru2, 'image', 'b.png', { purpose: 'shot_image', relPath: rs2, params: { shotId: 's2' } })
    const av1 = await mkAsset(p2, ru2, 'audio', 'a.mp3', { purpose: 'voice', relPath: relPathOf(p2, 'voice', 'a.mp3'), params: { lineId: 'l1' }, duration: 3, prompt: '一' })
    const av2 = await mkAsset(p2, ru2, 'audio', 'b.mp3', { purpose: 'voice', relPath: relPathOf(p2, 'voice', 'b.mp3'), params: { lineId: 'l2' }, duration: 4, prompt: '二' })
    const shotsRel = relPathOf(p2, 'storyboard', 'shots.json')
    writeFileSync(absPathOf(shotsRel), Buffer.from(JSON.stringify({ shots: [{ id: 's1', duration: 5, lines: ['l1'] }, { id: 's2', duration: 5, lines: ['l2'] }] })), 'utf8')
    const shotsId = await mkAsset(p2, ru2, 'text', 'shots.json', { purpose: 'storyboard', relPath: shotsRel, params: {} })
    const final2 = await mkAsset(p2, ru2, 'video', 'f.mp4', { purpose: 'final_video', relPath: relPathOf(p2, 'final_video', 'f.mp4'), duration: 9, params: { fps: 25, resolution: '1080x1920', duration: 9, inputs: { images: [as1, as2], motion_clips: null, shots_source: shotsId } } })
    await mkStep(ru2, [as1, as2, av1, av2, shotsId, final2])
    const r2 = await resolveEditTimeline(ru2)
    check(r2.source === 'recomputed', 'recomputed：无 timeline 存量走同源重算')
    check(r2.timeline.segments.length === 2 && r2.timeline.lines.length === 2, 'recomputed：段/句重算成功')

    // no_timeline（分镜无 lines 字段 → 重算失败）
    const p3 = await mkProject('notl')
    const ru3 = await mkRun(p3)
    const bs1 = await mkAsset(p3, ru3, 'image', 'c.png', { purpose: 'shot_image', relPath: relPathOf(p3, 'shot_image', 'c.png'), params: { shotId: 's1' } })
    const noLinesRel = relPathOf(p3, 'storyboard', 'shots.json')
    writeFileSync(absPathOf(noLinesRel), Buffer.from(JSON.stringify({ shots: [{ id: 's1', duration: 5 }] })), 'utf8')
    const noLinesShots = await mkAsset(p3, ru3, 'text', 'shots.json', { purpose: 'storyboard', relPath: noLinesRel, params: {} })
    const a3 = await mkAsset(p3, ru3, 'audio', 'c.mp3', { purpose: 'voice', relPath: relPathOf(p3, 'voice', 'c.mp3'), params: { lineId: 'l1' }, duration: 3 })
    const final3 = await mkAsset(p3, ru3, 'video', 'f.mp4', { purpose: 'final_video', relPath: relPathOf(p3, 'final_video', 'f.mp4'), params: { inputs: { images: [bs1], motion_clips: null, shots_source: noLinesShots } } })
    await mkStep(ru3, [bs1, noLinesShots, a3, final3])
    let code = ''
    try { await resolveEditTimeline(ru3) } catch (e) { code = e instanceof EditExchangeError ? e.code : 'other' }
    check(code === 'no_timeline', 'no_timeline：重算失败正确抛码')

    // no_final_video
    const p4 = await mkProject('nofinal')
    const ru4 = await mkRun(p4)
    const orphan = await mkAsset(p4, ru4, 'image', 'x.png', { purpose: 'shot_image', relPath: relPathOf(p4, 'shot_image', 'x.png'), params: {} })
    await mkStep(ru4, [orphan])
    let code2 = ''
    try { await resolveEditTimeline(ru4) } catch (e) { code2 = e instanceof EditExchangeError ? e.code : 'other' }
    check(code2 === 'no_final_video', 'no_final_video：无成片正确抛码')
  }

  // ---- section: bundle ----
  const bundle = async (): Promise<void> => {
    const { runId } = await seedStoredRun()
    const res = await buildEditExchange({ runId, format: 'otio', includeMedia: true })
    check(res.asset.kind === 'archive' && res.asset.purpose === 'edit_exchange', 'bundle：archive/edit_exchange 资产')
    check(res.timelineSource === 'stored', 'bundle：溯源标记 stored')
    check((res.asset.params ?? '').includes('"format":"otio"'), 'bundle：params 记 format')
    const abs = absPathOf(res.asset.relPath!)
    check(statSync(abs).size > 0, 'bundle：zip 落盘非空')
    const files = unzipSync(new Uint8Array(readFileSync(abs)))
    const names = Object.keys(files)
    check(names.includes('manifest.json') && names.includes('README.txt'), 'bundle：含 manifest.json + README')
    check(names.some((n) => n.endsWith('.otio')), 'bundle：含工程文件 .otio')
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']!)) as { media: Array<{ mediaFile: string; assetId: number | null }>; kind: string }
    check(manifest.kind === 'edit_exchange', 'bundle：manifest.kind')
    check(manifest.media.length > 0 && manifest.media.every((m) => names.includes(m.mediaFile)), 'bundle：manifest 每个 mediaFile 均在包内（引用一致）')
    check(manifest.media.some((m) => typeof m.assetId === 'number'), 'bundle：media 记 assetId')
    // include_media=false → 无 media/ 但仍含工程 + manifest
    const res2 = await buildEditExchange({ runId, format: 'edl', includeMedia: false })
    const names2 = Object.keys(unzipSync(new Uint8Array(readFileSync(absPathOf(res2.asset.relPath!)))))
    check(names2.some((n) => n.endsWith('.edl')), 'bundle：EDL 工程文件在包内')
    check(!names2.some((n) => n.startsWith('media/')), 'bundle：include_media=false 不打包媒体')
    // bad_format
    let code = ''
    try { await buildEditExchange({ runId, format: 'xml' }) } catch (e) { code = e instanceof EditExchangeError ? e.code : 'other' }
    check(code === 'bad_format', 'bundle：非法 format → bad_format')
    // 能力探测
    const cap = await probeEditExchange(runId)
    check(cap.available && cap.timeline_source === 'stored' && cap.formats.every((f) => f.enabled), 'bundle：stored run 能力探测全开')
    const cap0 = await probeEditExchange((await mkRun(await mkProject('empty'))))
    check(!cap0.available && cap0.reason === 'no_final_video', 'bundle：空 run 能力探测 no_final_video')
  }

  // ---- section: redline ----
  const redline = async (): Promise<void> => {
    const lc = (rel: string): number => readFileSync(new URL(rel, import.meta.url), 'utf8').split(/\r?\n/).length
    check(lc('../src/pipeline/actions/ffmpeg-merge/index.ts') <= 800, '红线：ffmpeg-merge/index.ts ≤800')
    check(lc('../src/pipeline/actions/ffmpeg-merge/timeline-snapshot.ts') < 400, '红线：timeline-snapshot.ts <400')
    for (const f of ['index.ts', 'timeline-source.ts', 'otio.ts', 'fcpxml.ts', 'edl.ts', 'timecode.ts', 'render-context.ts']) {
      check(lc(`../src/services/edit-exchange/${f}`) < 400, `红线：edit-exchange/${f} <400`)
    }
  }

  try {
    await runSections({ log, title: 'M50', checker, sections: SECTIONS, cleanup: envCleanup, runners: { timecode, formatters, snapshot, sources, bundle, redline } })
  } finally {
    globalThis.fetch = origFetch
  }
}

void main()
