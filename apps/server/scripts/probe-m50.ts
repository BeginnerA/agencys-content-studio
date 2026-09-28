/**
 * M50 探针（剪辑工程交换导出）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m50.ts [--section=timecode|formatters|snapshot|sources|bundle|redline|certify]
 *
 * 隔离：CSTUDIO_ROOT/DATA/WORKSPACE 指一次性临时目录（独立 studio.db + workspace，零网络零计费）。
 * 断言面（规格 §探针）：
 *   timecode      sec↔帧↔时码对拍（fps=25 整帧 / 非整帧舍入 / NDF 10800s 边界）
 *   formatters    OTIO 可 JSON.parse 且五轨命名；FCPXML 含 format/sequence/title/transition；EDL 时码升序 + Dissolve
 *   snapshot      buildEditTimeline 坐标口径（内容轴 + intro 位移 / sfx 绝对轴 / 文本截断）
 *   sources       params.timeline stored 直通 / 旧产物 recomputed 兜底 / 双失败 no_timeline / 无成片 no_final_video
 *   bundle        buildEditExchange 落 archive 资产 + zip 内 manifest↔media 引用一致 + bad_format
 *   redline       ffmpeg-merge/index.ts ≤800 / edit-exchange 各文件 <400 行数自查
 *   certify       第五期交付包认证（delivery-cert）：正常包 needs_attention / 破损 / 时长差 / 媒体悬空 / 跨格式 / editor_import 恒人工红线 / 缓存 stale / 零写守卫
 * 退出码：0 = 全通过；1 = 有 FAIL。
 */
import { writeFileSync, readFileSync, statSync } from 'node:fs'
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'
import type { EditTimeline } from '../src/pipeline/actions/ffmpeg-merge/timeline-snapshot'

const { tmp: _TMP, cleanup: envCleanup } = isolatedEnv('m50')
process.env.AGENT_LLM_BASE_URL = ''
process.env.AGENT_LLM_API_KEY = ''

const SECTIONS = ['timecode', 'formatters', 'snapshot', 'sources', 'bundle', 'redline', 'certify'] as const

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

  // ---- section: certify（第五期 交付包认证，规格 §8 九断言；本地假包零付费零模型零新依赖）----
  const certify = async (): Promise<void> => {
    const { createHash } = await import('node:crypto')
    const { zipSync } = await import('fflate')
    const { and, eq } = await import('drizzle-orm')
    const { genTasks, usageRecords } = await import('../src/db/schema')
    const { runDeliveryCert, readCertCache } = await import('../src/services/delivery-cert/certify')
    const { analyzeProjectFile } = await import('../src/services/delivery-cert/analyze')
    type CertR = Awaited<ReturnType<typeof runDeliveryCert>>
    type DCert = Extract<CertR, { outcome: 'ok' }>['cert']
    const healthy: DCert[] = []
    const findC = (c: DCert, key: string) => c.checks.find((x) => x.key === key)
    const ok = (r: CertR): DCert => { check(r.outcome === 'ok', '认证产出报告（非门禁阻断）'); return (r as { outcome: 'ok'; cert: DCert }).cert }

    // 一次性假包改写原语（读→改 entry→重 zip 回写；仅测试夹具造破损/漂移，非产品写路径）
    const unz = (a: { relPath: string | null }): Record<string, Uint8Array> => unzipSync(new Uint8Array(readFileSync(absPathOf(a.relPath!))))
    const projEntry = (files: Record<string, Uint8Array>): string => {
      const mf = JSON.parse(new TextDecoder().decode(files['manifest.json']!)) as { projectFile?: string }
      return mf.projectFile ?? Object.keys(files).find((n) => /\.(fcpxml|edl|otio)$/.test(n)) ?? ''
    }
    const rewriteProject = (a: { relPath: string | null }, mut: (t: string) => string): void => {
      const files = unz(a); const pn = projEntry(files)
      files[pn] = new TextEncoder().encode(mut(new TextDecoder().decode(files[pn] ?? new Uint8Array())))
      writeFileSync(absPathOf(a.relPath!), Buffer.from(zipSync(files)))
    }
    const rewriteManifest = (a: { relPath: string | null }, mut: (m: Record<string, unknown>) => void): void => {
      const files = unz(a); const m = JSON.parse(new TextDecoder().decode(files['manifest.json']!)) as Record<string, unknown>
      mut(m); files['manifest.json'] = new TextEncoder().encode(JSON.stringify(m))
      writeFileSync(absPathOf(a.relPath!), Buffer.from(zipSync(files)))
    }

    // 健康 run 夹具：完整 stored params.timeline + 有效字幕快照 cues（sha256 吻合 → deliveryConsistent=true，产真 needs_attention）
    const seedHealthy = async (): Promise<number> => {
      const projectId = await mkProject('cert-h')
      const runId = await mkRun(projectId)
      const s1 = relPathOf(projectId, 'shot_image', 's1.png'); mkFile(s1, 512)
      const s2 = relPathOf(projectId, 'shot_image', 's2.png'); mkFile(s2, 512)
      const v1 = relPathOf(projectId, 'voice', 'v1.mp3'); mkFile(v1, 128)
      const sa1 = await mkAsset(projectId, runId, 'image', 's1.png', { purpose: 'shot_image', relPath: s1, params: { shotId: 's1' } })
      const sa2 = await mkAsset(projectId, runId, 'image', 's2.png', { purpose: 'shot_image', relPath: s2, params: { shotId: 's2' } })
      const va1 = await mkAsset(projectId, runId, 'audio', 'v1.mp3', { purpose: 'voice', relPath: v1, params: { lineId: 'l1' }, duration: 4, prompt: '第一句' })
      const subRel = relPathOf(projectId, 'subtitle', 'sub.srt')
      const srt = '1\n00:00:00,000 --> 00:00:04,000\n第一句台词\n'
      writeFileSync(absPathOf(subRel), Buffer.from(srt, 'utf8'))
      const sha = createHash('sha256').update(srt, 'utf8').digest('hex')
      const timeline = {
        v: 1, fps: 25, width: 1080, height: 1920, totalSec: 10, introSec: 0, outroSec: 0,
        segments: [
          { shotId: 's1', assetId: sa1, relPath: s1, kind: 'image', durSec: 5, startSec: 0, lineIds: ['l1'], silenceSec: 0 },
          { shotId: 's2', assetId: sa2, relPath: s2, kind: 'image', durSec: 5, startSec: 5, lineIds: [], silenceSec: 0 },
        ],
        lines: [{ lineId: 'l1', assetId: va1, relPath: v1, timelineStart: 0, durSec: 4, text: '第一句' }],
        sfx: [], bgm: null, transition: null, watermark: false,
        subtitle: { assetId: va1, relPath: subRel, effectiveRelPath: subRel, cues: [{ id: 'cue-1', startMs: 0, endMs: 4000, text: '第一句台词' }], origin: 'source', sha256: sha, versionId: null },
      }
      const finalRel = relPathOf(projectId, 'final_video', 'final.mp4'); mkFile(finalRel, 1024)
      const finalId = await mkAsset(projectId, runId, 'video', 'final.mp4', { purpose: 'final_video', relPath: finalRel, duration: 10, params: { fps: 25, resolution: '1080x1920', duration: 10, timeline } })
      await mkStep(runId, [sa1, sa2, va1, finalId])
      return runId
    }

    // #7 无包 → needs_package（不为认证造包，零写守卫）
    const bareRun = await mkRun(await mkProject('cert-bare'))
    const c7 = ok(await runDeliveryCert(bareRun))
    check(c7.verdict === 'needs_package', '#7 无已生成包 → verdict=needs_package')
    check(findC(c7, 'package_present')?.status === 'not_tested', '#7 package_present=not_tested')
    check((await db.select().from(assets).where(and(eq(assets.runId, bareRun), eq(assets.purpose, 'edit_exchange')))).length === 0, '#7 认证不为 needs_package 自动生成 archive（零写）')

    // #1/#6/#8缓存保留/#9零写 —— 健康 otio 包（include_media）
    const ruB = await seedHealthy()
    const bPkg = (await buildEditExchange({ runId: ruB, format: 'otio', includeMedia: true })).asset
    const cArchB = (await db.select().from(assets)).filter((a) => a.purpose === 'edit_exchange').length
    const cGenB = (await db.select().from(genTasks)).length
    const cUseB = (await db.select().from(usageRecords)).length
    const c1 = ok(await runDeliveryCert(ruB, { format: 'otio' }))
    healthy.push(c1)
    check(c1.verdict === 'needs_attention', '#1 健康包 verdict=needs_attention（editor_import 恒缺，绝不 package_sound）')
    for (const k of ['project_file_wellformed', 'duration_math_consistent', 'media_refs_resolvable', 'timeline_source_bound', 'subtitle_delivery_bound']) {
      check(findC(c1, k)?.status === 'passed', `#1 客观项 ${k}=passed`)
    }
    check(findC(c1, 'cross_format_consistency')?.status === 'not_applicable', '#1 单格式 cross=not_applicable')
    const ei = findC(c1, 'editor_import_certified')
    check(ei?.status === 'not_tested' && ei?.evidenceType === 'manual_review', '#6 editor_import 恒 not_tested+manual_review（产品不代答编辑器）')
    const [bCur] = await db.select().from(assets).where(eq(assets.id, bPkg.id))
    const bParams = JSON.parse(bCur.params!) as Record<string, unknown>
    check(!!bParams.cert && bParams.format === 'otio' && 'finalAssetId' in bParams && 'includeMedia' in bParams, '#8 params.cert 写入且保留 format/finalAssetId/includeMedia 等其余键（零新列）')
    check((await db.select().from(assets)).filter((a) => a.purpose === 'edit_exchange').length === cArchB && (await db.select().from(genTasks)).length === cGenB && (await db.select().from(usageRecords)).length === cUseB, '#9 认证全程零 gen_tasks/零 usage_records/零新增 archive')

    // #4 EDL include_media=false → media_refs=not_applicable
    const ruC = await seedHealthy()
    await buildEditExchange({ runId: ruC, format: 'edl', includeMedia: false })
    check(findC(ok(await runDeliveryCert(ruC, { format: 'edl' })), 'media_refs_resolvable')?.status === 'not_applicable', '#4 include_media=false → media_refs=not_applicable')

    // #2 破损 zip（不可解压）→ package_present=failed → package_broken
    const ruD = await seedHealthy()
    const dPkg = (await buildEditExchange({ runId: ruD, format: 'otio', includeMedia: true })).asset
    writeFileSync(absPathOf(dPkg.relPath!), Buffer.from('这不是一个 zip 文件', 'utf8'))
    const c2 = ok(await runDeliveryCert(ruD, { format: 'otio' }))
    check(findC(c2, 'package_present')?.status === 'failed' && c2.verdict === 'package_broken', '#2 破损不可解压包 → package_broken')

    // #3 时长数学：首段 offset 越出 sequence duration → duration_math=failed（结构仍良构）
    const ruE = await seedHealthy()
    const ePkg = (await buildEditExchange({ runId: ruE, format: 'fcpxml', includeMedia: true })).asset
    rewriteProject(ePkg, (t) => t.replace(/offset="[^"]*"/, 'offset="99999/25s"'))
    const c3 = ok(await runDeliveryCert(ruE, { format: 'fcpxml' }))
    check(findC(c3, 'project_file_wellformed')?.status === 'passed' && findC(c3, 'duration_math_consistent')?.status === 'failed' && c3.verdict === 'package_broken', '#3 clip 越出总时长 → wellformed=passed 且 duration_math=failed → package_broken')

    // #4 媒体悬空：工程引用包内不存在的 media → media_refs=failed
    const ruF = await seedHealthy()
    const fPkg = (await buildEditExchange({ runId: ruF, format: 'fcpxml', includeMedia: true })).asset
    rewriteProject(fPkg, (t) => t.replace('</fcpxml>', '<asset id="rBogus" src="file://media/nope.mp4"/></fcpxml>'))
    check(findC(ok(await runDeliveryCert(ruF, { format: 'fcpxml' })), 'media_refs_resolvable')?.status === 'failed', '#4 悬空媒体引用 → media_refs=failed（编辑器将找不到素材）')

    // #1 字幕交付：manifest.deliveryConsistent=false → subtitle=failed → package_broken
    const ruG = await seedHealthy()
    const gPkg = (await buildEditExchange({ runId: ruG, format: 'otio', includeMedia: true })).asset
    rewriteManifest(gPkg, (m) => { (m.subtitle as Record<string, unknown>).deliveryConsistent = false })
    const c1sf = ok(await runDeliveryCert(ruG, { format: 'otio' }))
    check(findC(c1sf, 'subtitle_delivery_bound')?.status === 'failed' && c1sf.verdict === 'package_broken', '#1 deliveryConsistent=false → subtitle=failed → package_broken（不声称字幕交付一致）')

    // #5 跨格式一致：同 run 三格式段数/总帧一致 → passed；人为改其一总帧 → failed
    const ruI = await seedHealthy()
    await buildEditExchange({ runId: ruI, format: 'otio', includeMedia: true })
    const iFcpxml = (await buildEditExchange({ runId: ruI, format: 'fcpxml', includeMedia: true })).asset
    await buildEditExchange({ runId: ruI, format: 'edl', includeMedia: true })
    const c5ok = ok(await runDeliveryCert(ruI, { format: 'otio' }))
    healthy.push(c5ok)
    check(findC(c5ok, 'cross_format_consistency')?.status === 'passed', '#5 三格式事实一致 → cross_format=passed')
    rewriteProject(iFcpxml, (t) => t.replace(/<sequence\b([^>]*?)duration="[^"]*"/, '<sequence$1duration="9999/25s"'))
    check(findC(ok(await runDeliveryCert(ruI, { format: 'otio' })), 'cross_format_consistency')?.status === 'failed', '#5 人为改其一总帧 → cross_format=failed')

    // #8 zip hash 变 → 下次读取旧 passed 结论标 stale
    const ruH = await seedHealthy()
    const hPkg = (await buildEditExchange({ runId: ruH, format: 'otio', includeMedia: true })).asset
    const hShaBefore = ok(await runDeliveryCert(ruH, { format: 'otio' })).packageSha256
    rewriteProject(hPkg, (t) => `${t}\n/* touched */`)
    const c8after = await readCertCache(ruH, 'otio')
    check(!!c8after && c8after.fromCache === true, '#8 readCertCache 命中缓存标 fromCache')
    check(!!c8after && c8after.packageSha256 === hShaBefore && findC(c8after, 'project_file_wellformed')?.status === 'stale', '#8 zip hash 变 → 旧 passed 结论降级 stale')

    // #6 汇总红线：所有健康包终值均非 package_sound（结构可信天花板）
    check(healthy.every((c) => c.verdict !== 'package_sound'), '#6 无任何包达到 package_sound（editor_import 恒缺天花板）')

    // T2 纯解析器破损不抛契约（畸形 OTIO → wellformed=false）
    const broken = analyzeProjectFile('{"OTIO_SCHEMA":"', 'otio')
    check(broken.wellformed === false && broken.fps === null, '#2 纯解析器对畸形 OTIO 返回 wellformed=false 且不抛')
  }

  try {
    await runSections({ log, title: 'M50', checker, sections: SECTIONS, cleanup: envCleanup, runners: { timecode, formatters, snapshot, sources, bundle, redline, certify } })
  } finally {
    globalThis.fetch = origFetch
  }
}

void main()
