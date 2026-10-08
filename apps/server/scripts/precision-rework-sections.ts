/**
 * precision-rework 探针 · 共享夹具与 compose/stale/projection/exchange 分节（自 probe-precision-rework.ts 拆出：
 * m26 split-audit 红线单文件 ≤800 行）。文件名故意不带 probe- 前缀：
 * 本模块是被主探针 import 的库，不是可独立执行的探针（run-probes 按 probe-*.ts 扫描）。
 * api 由主探针 main() 在 isolatedEnv 之后经 setApi 注入（ESM live binding：两模块见同一实例）。
 * 隔离库 + 假媒体字节：零网络、零付费、零供应商调用。
 */

export type SubtitleCueT = { id: string; startMs: number; endMs: number; text: string }

export type CheckFn = (ok: boolean, label: string) => void

/** 三句夹具：句间留 1s 间隔便于平移断言；端点相接合法性另测；成片 9000ms */
export function fixture(): { cues: SubtitleCueT[]; durationMs: number } {
  const srt = [
    '1',
    '00:00:00,000 --> 00:00:02,000',
    '第一句',
    '',
    '2',
    '00:00:03,000 --> 00:00:05,000',
    '第二句',
    '续行',
    '',
    '3',
    '00:00:06,000 --> 00:00:08,000',
    '第三句',
    '',
  ].join('\r\n')
  const parsed = api.parseSubtitleSrt(srt)
  if (!parsed.ok) throw new Error(`夹具解析失败: ${parsed.error.message}`)
  return { cues: api.attachCueIds(parsed.cues, api.subtitleBaseTag('fixture-source-hash')), durationMs: 9000 }
}

export interface EffSnap {
  versionId: number | null
  sha256: string
  coordinate: 'final'
  cues: SubtitleCueT[]
  origin: string
  sourceRef: { assetId: number | null; sha256: string; timingSource: string }
}

export interface ApiShape {
  parseSubtitleSrt: (srt: string) => { ok: true; cues: Array<{ startMs: number; endMs: number; text: string }> } | { ok: false; error: { code: string; message: string } }
  serializeSubtitleSrt: (cues: Array<{ startMs: number; endMs: number; text: string }>) => string
  subtitleBaseTag: (sha: string) => string
  makeCueId: (tag: string, ordinal: number) => string
  attachCueIds: (raw: Array<{ startMs: number; endMs: number; text: string }>, tag: string) => SubtitleCueT[]
  validateSubtitleText: (text: string, cueId?: string) => { code: string; message: string } | null
  validateCueList: (cues: SubtitleCueT[], durationMs: number) => { code: string; message: string } | null
  parseSubtitleChanges: (input: unknown) => { ok: true; changes: unknown[] } | { ok: false; errors: Array<{ code: string }> }
  normalizeSubtitleChanges: (changes: never[], cues: SubtitleCueT[]) => unknown[]
  applySubtitleChanges: (args: { cues: SubtitleCueT[]; changes: never[]; durationMs: number }) => { ok: true; finalCues: SubtitleCueT[]; diffs: Array<{ cueId: string; field: string; before: unknown; after: unknown }> } | { ok: false; errors: Array<{ code: string; message: string }> }
  SRT_MAX_CUE_TEXT_CHARS: number
  MAX_SHIFT_DELTA_MS: number
  sha256Text: (text: string) => string
  buildEffectiveSubtitleSnapshot: (args: { sourceText: string; shiftedText: string | null; sourceAssetId: number | null; timingSource: string; origin?: 'source' | 'manual'; versionId?: number | null }) => EffSnap | null
  planEffectiveSubtitle: (args: { sourceText: string; shiftedText: string | null; sourceRelPath: string; sourceAssetId: number | null; timingSource: string }) => { ext: EffSnap & { effectiveRelPath: string }; effectiveTextToWrite: string | null } | null
  planSubtitleShifts: (args: { alignPlan: unknown; voiceLineIds: string[]; voiceCount: number; introShift: number; readSource: () => Promise<string>; log: (msg: string) => void }) => Promise<{ shifts: number[] | null; alignMode: boolean; shiftedText: string | null }>
  shiftSrtText: (srt: string, shifts: number[]) => string | null
  buildEditTimeline: (p: unknown) => { v: number; subtitle: Record<string, unknown> | null }
}

export let api: ApiShape

/** 主探针完成模块加载后注入（isolatedEnv 之后；调用一次）。主文件 import { api } 为 live binding 只读 */
export function setApi(a: ApiShape): void {
  api = a
}

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** 隔离库夹具工具：mkRun/mkFixture（健康成片：captions+compose 两步 succeeded + P2 快照）供 preview/apply/compose/stale 分节共用 */
export async function createFixtureTools(projectId = 92) {
  const { initDb, db } = await import('../src/db')
  await initDb() // 幂等；单独 --section 运行时自建库
  const { pipelineRuns, pipelineSteps, assets, genTasks } = await import('../src/db/schema')
  const { cues, durationMs } = fixture()
  const sourceText = api.serializeSubtitleSrt(cues)
  const srcSha = api.sha256Text(sourceText)
  const now = Date.now()
  const mkRun = async (status: string): Promise<number> => {
    const rows = await db.insert(pipelineRuns).values({ projectId, templateKey: 'probe-rework', status, input: '{}', createdAt: now, updatedAt: now }).returning()
    return rows[0]!.id
  }
  /** 健康夹具：captions(succeeded)+compose(succeeded, output=[成片])+成片带 P2 有效字幕快照+源字幕行 */
  const mkFixture = async (runId: number, opts: { stripTimeline?: boolean; corruptSnap?: boolean; burn?: boolean } = {}): Promise<{ composeId: number; finalId: number; srcId: number }> => {
    const srcRows = await db.insert(assets).values({
      projectId, kind: 'text', purpose: 'subtitle', name: 'src.srt', relPath: `${projectId}/texts/src.srt`, mime: 'application/x-subrip', ext: 'srt', sha256: srcSha, fileSize: sourceText.length, params: '{}', tags: '[]', runId, createdAt: now, updatedAt: now,
    }).returning()
    const src = srcRows[0]!
    const snap = api.buildEffectiveSubtitleSnapshot({ sourceText, shiftedText: null, sourceAssetId: src.id, timingSource: 'measured' })!
    const tl = api.buildEditTimeline({
      fps: 25, width: 720, height: 1280, totalSec: durationMs / 1000, introSec: 0, outroSec: 0, segments: [], rows: [], alignPlan: null, voices: [], sfx: [], bgm: null, transition: null, watermark: false,
      subtitle: { assetId: src.id, relPath: src.relPath, ...snap },
    }) as Record<string, unknown>
    if (opts.stripTimeline) delete tl.subtitle
    if (opts.corruptSnap) (tl.subtitle as Record<string, unknown>).cues = [{ id: 1, startMs: 1.5 }]
    const finalRows = await db.insert(assets).values({
      projectId, kind: 'video', purpose: 'final_video', name: 'final.mp4', relPath: `${projectId}/video/final.mp4`, mime: 'video/mp4', ext: 'mp4', sha256: 'final-sha-1', fileSize: 1000, duration: 9, params: JSON.stringify(opts.stripTimeline && !opts.corruptSnap ? { noTimeline: true } : { timeline: tl }), tags: '[]', runId, createdAt: now, updatedAt: now,
    }).returning()
    const fin = finalRows[0]!
    await db.insert(pipelineSteps).values({ runId, seq: 1, stepKey: 'captions', actionKey: 'dialogue_subtitle', status: 'succeeded', output: JSON.stringify({ asset_ids: [src.id] }), attempts: 1, createdAt: now, updatedAt: now })
    const compRow = await db.insert(pipelineSteps).values({ runId, seq: 2, stepKey: 'compose', actionKey: 'ffmpeg_merge', status: 'succeeded', output: JSON.stringify({ asset_ids: [fin.id] }), attempts: 1, createdAt: now, updatedAt: now }).returning()
    return { composeId: compRow[0]!.id, finalId: fin.id, srcId: src.id }
  }
  return { db, pipelineRuns, pipelineSteps, assets, genTasks, now, sourceText, srcSha, cues, durationMs, mkRun, mkFixture }
}

export async function runComposeSection(check: CheckFn): Promise<void> {
  // §6.2 合成侧消费：人工修订显示输入接管（planDisplaySubtitle 各路零 diff）+ 无烧录快速路径
  // （假 ctx + 真隔离库 + 假媒体字节；零编码零网络零供应商，基准成片逐字节相同）
  const tools = await createFixtureTools(93)
  const { db, assets, genTasks, now, srcSha, sourceText, cues, mkRun, mkFixture } = tools
  const { eq, inArray } = await import('drizzle-orm')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const md = await import('../src/pipeline/actions/ffmpeg-merge/manual-display')
  const { PROJECTS_DIR } = await import('../src/env')
  const { absPathOf } = await import('../src/services/storage')

  const manualText = api.serializeSubtitleSrt([{ ...cues[0]!, text: '新第一句' }, cues[1]!, cues[2]!])
  const manualSha = api.sha256Text(manualText)
  const manual = { text: manualText, versionId: 5, sha256: manualSha, requestId: 'req-c1' }
  let thr = ''

  /* ── loadManualDisplay 四态 ── */
  const boom = async (): Promise<string> => { throw new Error('不应读版本') }
  check((await md.loadManualDisplay({ runInput: null, stepKey: 'compose', readVersion: boom })) === null, '无指针：null（合成语义与迁移前逐字节一致）')
  check((await md.loadManualDisplay({ runInput: '{}', stepKey: 'compose', readVersion: boom })) === null, '无 _subtitleEdits 键：null')
  const refJson = JSON.stringify({ _subtitleEdits: { compose: { assetId: 1, versionId: 5, sha256: manualSha, baseFingerprint: 'fp-c', requestId: 'req-c1' } } })
  const loaded = await md.loadManualDisplay({ runInput: refJson, stepKey: 'compose', readVersion: async () => manualText })
  check(loaded?.text === manualText && loaded?.versionId === 5 && loaded?.requestId === 'req-c1', '指针+内容校验通过：返回人工修订（成片轴文本）')
  thr = ''
  try { await md.loadManualDisplay({ runInput: refJson, stepKey: 'compose', readVersion: async () => sourceText }) } catch (e) { thr = (e as Error).message }
  check(thr.includes('hash 不符'), '与台账指针 hash 不符 fail closed（绝不静默回退过期修订）')
  thr = ''
  try {
    await md.loadManualDisplay({ runInput: JSON.stringify({ _subtitleEdits: { compose: { assetId: 1, versionId: 6, sha256: api.sha256Text('不是字幕'), baseFingerprint: 'fp', requestId: 'r' } } }), stepKey: 'compose', readVersion: async () => '不是字幕' })
  } catch (e) { thr = (e as Error).message }
  check(thr.includes('严格可解析'), '版本内容不可解析拒绝（fail closed）')

  /* ── planDisplaySubtitle：人工接管 + 旧路径零 diff ── */
  const outDir = path.join(PROJECTS_DIR, 'tmp-c')
  fs.mkdirSync(outDir, { recursive: true })
  const lgA: string[] = []
  const pN = await md.planDisplaySubtitle({ strict: false, srtRelPath: '93/texts/src.srt', subtitleBurn: false, alignPlan: null, voiceLineIds: [], voiceCount: 3, introShift: 1.5, readSource: async () => sourceText, outDir, runId: 1, manual, log: (m) => lgA.push(m) })
  check(pN.srtAbs === null && pN.tempSrtAbs === null && pN.shiftedText === manualText, '人工+关烧录：无滤镜输入，有效文本即人工修订（不进入平移计算）')
  check(lgA.some((m) => m.includes('人工字幕修订生效')), '人工消费日志可审计（带版本标识）')
  const lgB: string[] = []
  const pB = await md.planDisplaySubtitle({ strict: false, srtRelPath: '93/texts/src.srt', subtitleBurn: true, alignPlan: null, voiceLineIds: [], voiceCount: 3, introShift: 1.5, readSource: async () => sourceText, outDir, runId: 1, manual, log: (m) => lgB.push(m) })
  check(pB.srtAbs !== null && pB.srtAbs === pB.tempSrtAbs && fs.readFileSync(pB.srtAbs, 'utf8') === manualText, '人工+开烧录：成片轴副本直接烧录（内容即人工文本，未重复平移）')
  check(lgB.some((m) => m.includes('跳过旧逐句/片头平移')) && pB.shiftedText === manualText, '人工烧录日志声明跳过平移（成片轴预览期已固定）')
  thr = ''
  try { await md.planDisplaySubtitle({ strict: false, srtRelPath: null, subtitleBurn: true, alignPlan: null, voiceLineIds: [], voiceCount: 0, introShift: 0, readSource: async () => '', outDir, runId: 1, manual, log: () => {} }) } catch (e) { thr = (e as Error).message }
  check(thr.includes('没有源字幕输入'), '人工修订但无源字幕 → fail closed（源验证与显示修订分列共存）')
  const lgC: string[] = []
  const pLegacy = await md.planDisplaySubtitle({ strict: false, srtRelPath: '93/texts/src.srt', subtitleBurn: true, alignPlan: null, voiceLineIds: [], voiceCount: 3, introShift: 1.5, readSource: async () => sourceText, outDir, runId: 2, manual: null, log: (m) => lgC.push(m) })
  check(pLegacy.shiftedText === api.shiftSrtText(sourceText, [1.5, 1.5, 1.5]) && pLegacy.tempSrtAbs !== null && fs.readFileSync(pLegacy.tempSrtAbs, 'utf8') === pLegacy.shiftedText, '无人工+片头平移：旧语义逐字节保持（临时副本内容同 planSubtitleShifts）')
  check(pLegacy.srtAbs === pLegacy.tempSrtAbs && lgC.some((m) => m.includes('片头位移')), '无人工路径仍生成烧录副本与平移日志')
  const pPlain = await md.planDisplaySubtitle({ strict: false, srtRelPath: '93/texts/src.srt', subtitleBurn: true, alignPlan: null, voiceLineIds: [], voiceCount: 0, introShift: 0, readSource: async () => sourceText, outDir, runId: 3, manual: null, log: () => {} })
  check(pPlain.srtAbs === absPathOf('93/texts/src.srt') && pPlain.tempSrtAbs === null && pPlain.shiftedText === null, '无人工且无平移：零 diff（源文件原样烧录）')

  /* ── tryNoBurnManualRecompose：基准依赖比对 + 逐字节复制（假 ctx，真隔离库） ── */
  const traceFields = { fps: 25, resolution: '720x1280', images: 2, motion_clips: 0, voices: 3, subtitle: 1, subtitle_style: 'default', duration: 9, inputs: { images: null, motion_clips: null, shots_source: null }, skipped_shots: [] as number[], align: { aligned: false, reason: 'no_voices', lines: 0, shots: 0, total_dur: null, mode: null, partial: false, warn_lines: 0 }, transition: { enabled: false, type: null, dur_sec: null }, bgm: null, watermark: null, intro: null, outro: null, sfx: null }
  const xfadeOff = { enabled: false, type: 'fade', durSec: 0, videoLens: [] as number[], offsets: [] as number[], totalDur: 0 }
  let provHits = 0
  let ffHits = 0
  let seq = 0
  const mkCtx = (o: { runId: number; composeId: number; output: string | null }, logs: string[]) => ({
    run: { id: o.runId, projectId: 93 },
    step: { id: o.composeId, output: o.output },
    log: (m: string) => logs.push(m),
    async assetsOf(ids: number[]) { const rows = await db.select().from(assets).where(inArray(assets.id, ids)); const by = new Map(rows.map((r) => [r.id, r])); return ids.map((i) => by.get(i)!).filter(Boolean) },
    async readText(): Promise<string> { return sourceText },
  })
  const fpArgs = (o: { runId: number; composeId: number; output: string | null; srcId: number }, over: Record<string, unknown> = {}, logs: string[] = []) => {
    seq += 1
    const cur = { fps: 25, resolution: '720x1280', width: 720, height: 1280, totalAll: 9, imageCount: 2, motionCount: 0, voiceCount: 3, style: 'default', srtRelPath: '93/texts/src.srt', subtitleAssetId: o.srcId, inputs: { images: null, motion_clips: null, shots_source: null }, skipped: [], alignPlan: null, alignReason: 'no_voices', xfade: xfadeOff, bgm: null, watermark: null, intro: null, outro: null, sfxCount: 0, sfxVolume: 1 }
    return {
      ctx: mkCtx(o, logs), manual, eligible: true,
      outName: `ep93-fast-${seq}.mp4`, outRel: `93/video/ep93-fast-${seq}.mp4`, outAbs: absPathOf(`93/video/ep93-fast-${seq}.mp4`),
      coverAt: 0.2, wantCover: false, ffmpeg: 'fake-ffmpeg',
      runFfmpeg: async (_c: unknown, _f: unknown, a: string[]): Promise<void> => { ffHits += 1; fs.mkdirSync(path.dirname(a[a.length - 1]!), { recursive: true }); fs.writeFileSync(a[a.length - 1]!, 'FAKE-JPG') },
      recordProvenance: async (): Promise<void> => { provHits += 1 },
      derived: [],
      cur,
      ...over,
    }
  }

  const runG = await mkRun('completed')
  const fixG = await mkFixture(runG)
  const gRef = { runId: runG, composeId: fixG.composeId, output: JSON.stringify({ asset_ids: [fixG.finalId] }), srcId: fixG.srcId }
  const lg0: string[] = []
  check((await md.tryNoBurnManualRecompose(fpArgs(gRef, { eligible: false }, lg0) as never)) === null && lg0.length === 0, '准入不满足（烧录开/首次等）：直接 null 零日志（正常重合成）')
  const lg1: string[] = []
  check((await md.tryNoBurnManualRecompose(fpArgs(gRef, { manual: null }, lg1) as never)) === null && lg1.length === 0, '无人工修订：null 零日志（旧行为完全不变）')
  const lg2: string[] = []
  check((await md.tryNoBurnManualRecompose(fpArgs({ ...gRef, output: null }, {}, lg2) as never)) === null && lg2.some((m) => m.includes('无既有成片基准')), '首次合成（步骤无旧 output）：不快速，走正常编码')
  const lg3: string[] = []
  check((await md.tryNoBurnManualRecompose(fpArgs(gRef, {}, lg3) as never)) === null && lg3.some((m) => m.includes('基准成片资产或文件缺失')), '基准文件缺失：拒快速路径走正常重合成（同时验证 traceFields 前 hash 校验已过）')
  // 正式基准就绪：补 trace 字段 + 落假媒体字节 + 预置已终生成任务（验证不动）
  const finG = (await db.select().from(assets).where(eq(assets.id, fixG.finalId)).limit(1))[0]!
  await db.update(assets).set({ params: JSON.stringify({ ...JSON.parse(finG.params ?? '{}'), ...traceFields }) }).where(eq(assets.id, fixG.finalId))
  const baseAbsG = absPathOf(finG.relPath!)
  fs.mkdirSync(path.dirname(baseAbsG), { recursive: true })
  const baseBytes = Buffer.from('FAKE-MP4-\u03c0\u0000\u0001\u0002')
  fs.writeFileSync(baseAbsG, baseBytes)
  // 源字幕文件同样存在（生产目录必在；人工有效文件与源同目录）
  const srcAbsG = absPathOf('93/texts/src.srt')
  fs.mkdirSync(path.dirname(srcAbsG), { recursive: true })
  fs.writeFileSync(srcAbsG, sourceText)
  await db.insert(genTasks).values({ projectId: 93, runId: runG, stepId: fixG.composeId, kind: 'video', params: '{}', status: 'succeeded', attempts: 1, createdAt: now, updatedAt: now })
  const lg4: string[] = []
  const base4 = fpArgs(gRef, {}, lg4)
  const rMis = await md.tryNoBurnManualRecompose({ ...base4, cur: { ...base4.cur, fps: 24 } } as never)
  check(rMis === null && lg4.some((m) => m.includes('不适用')) && !fs.existsSync(base4.outAbs), '任一依赖变化（fps）：拒快速路径且零落盘零登记')
  const lg5: string[] = []
  check((await md.tryNoBurnManualRecompose(fpArgs(gRef, { derived: [{ aspect: '1:1', width: 720, height: 720, outAbs: absPathOf('93/video/d11.mp4') }] }, lg5) as never)) === null && lg5.some((m) => m.includes('多画幅')), '派生画幅配置与基准不符：拒快速路径')
  const lg6: string[] = []
  const args6 = fpArgs(gRef, { wantCover: true }, lg6)
  const ids6 = await md.tryNoBurnManualRecompose(args6 as never)
  check(Array.isArray(ids6) && ids6.length === 2, '快速路径命中：新成片+封面两件资产（封面走一次抽帧编码，主流程零 ffmpeg）')
  const n6 = (await db.select().from(assets).where(eq(assets.id, ids6![0])).limit(1))[0]!
  check(n6.purpose === 'final_video' && n6.runId === runG && n6.stepId === fixG.composeId, '新成片登记到原 run/步骤（新版本不可变资产）')
  check(Buffer.compare(fs.readFileSync(absPathOf(n6.relPath!)), baseBytes) === 0, '基准成片逐字节复制（视频/音频未动 → 台词/音频位置不变）')
  const p6 = JSON.parse(n6.params ?? '{}') as Record<string, unknown>
  check(p6.manual_subtitle_version === 5 && p6.no_burn_fastpath === true, 'params 携人工修订版本指针 + 快速路径标记')
  const sub6 = p6.timeline as { subtitle: Record<string, unknown> & { cues: Array<{ text: string; startMs: number }>; sourceRef: Record<string, string> } }
  check(sub6.subtitle.origin === 'manual' && sub6.subtitle.versionId === 5 && sub6.subtitle.sha256 === manualSha && sub6.subtitle.sourceRef.sha256 === srcSha && sub6.subtitle.sourceRef.timingSource === 'measured', '快照 origin=manual 携版本（源 hash/来源等级不升级，人工修订不得洗白计时）')
  check(sub6.subtitle.cues[0]?.text === '新第一句' && sub6.subtitle.cues[2]?.startMs === 6000 && String(sub6.subtitle.effectiveRelPath).includes('display-'), '有效 cues 取人工内容、其余 cue 不动，有效文件内容寻址')
  const dispAbs = absPathOf(String(sub6.subtitle.effectiveRelPath))
  check(fs.existsSync(dispAbs) && fs.readFileSync(dispAbs, 'utf8') === manualText, '源旁落不可变明文 SRT（可下载/可审计）')
  check(Buffer.compare(fs.readFileSync(baseAbsG), baseBytes) === 0, '基准文件未被覆写（源不改）')
  const finOld2 = (await db.select().from(assets).where(eq(assets.id, fixG.finalId)).limit(1))[0]!
  check(finOld2.sha256 === 'final-sha-1' && JSON.parse(finOld2.params ?? '{}').manual_subtitle_version === undefined, '基准资产行零改写')
  const gTasks = await db.select().from(genTasks).where(eq(genTasks.runId, runG))
  check(gTasks.length === 1 && gTasks[0]!.status === 'succeeded', '生成任务不动（不重置不新增，本地路径供应商调用=0）')
  check(provHits === 1 && ffHits === 1 && ids6!.length === 2, '溯源快照回调恰执行一次；ffmpeg 仅封面抽帧一次')
  const cover6 = (await db.select().from(assets).where(eq(assets.id, ids6![1])).limit(1))[0]!
  check(cover6.purpose === 'thumbnail' && JSON.parse(cover6.params ?? '{}').sourceVideo === n6.id, '封面从复制件重抽帧并指向新成片')
  // 派生画幅一致时同样逐字节复制
  const dBytes = Buffer.from('DERIVED-9x16-\u00ff')
  const dRel = '93/video/d9x16-base.mp4'
  fs.writeFileSync(absPathOf(dRel), dBytes)
  const dRow = (await db.insert(assets).values({ projectId: 93, kind: 'video', purpose: 'final_video_derived', name: 'd9x16.mp4', relPath: dRel, mime: 'video/mp4', ext: 'mp4', params: JSON.stringify({ native: true, aspect: '9:16', strategy: 'native', source: 'multi_render', fps: 25, resolution: '720x1280', duration: 9 }), tags: '[]', runId: runG, createdAt: now, updatedAt: now }).returning())[0]!
  const outD = JSON.stringify({ asset_ids: [fixG.finalId, dRow.id] })
  const dNewAbs = absPathOf('93/video/d9x16-new.mp4')
  const idsD = await md.tryNoBurnManualRecompose(fpArgs({ ...gRef, output: outD }, { derived: [{ aspect: '9:16', width: 720, height: 1280, outAbs: dNewAbs }] }, []) as never)
  check(Array.isArray(idsD) && idsD.length === 2 && Buffer.compare(fs.readFileSync(dNewAbs), dBytes) === 0, '派生画幅逐项一致：同样逐字节复制新不可变文件')
  // 对白/严格基准保守拒走
  await db.update(assets).set({ params: JSON.stringify({ ...traceFields, dialogue_clips: [{ shotId: 's1' }] }) }).where(eq(assets.id, fixG.finalId))
  const lg7: string[] = []
  check((await md.tryNoBurnManualRecompose(fpArgs(gRef, {}, lg7) as never)) === null && lg7.some((m) => m.includes('对白/严格')), '对白/严格路线基准：拒快速路径（保守重编码）')
}

export async function runStaleSection(check: CheckFn): Promise<void> {
  // P7（规格 §6.2/§5.2-104/§7）：重合成消费期依赖指纹复验（所有入口统一终检）、
  // 内部键白名单防绕过、断点续跑防盲拷指针、仍被引用字幕的清理保护
  const tools = await createFixtureTools(94)
  const { db, pipelineRuns, pipelineSteps, assets, now, sourceText, cues, mkRun, mkFixture } = tools
  const { contentVersions } = await import('../src/db/schema')
  const { eq } = await import('drizzle-orm')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const md = await import('../src/pipeline/actions/ffmpeg-merge/manual-display')
  const base = await import('../src/services/rework/baseline')
  const rc = await import('../src/services/run-create')
  const cc = await import('../src/services/compose-config')
  const vc = await import('../src/services/version-cleanup')
  const { absPathOf } = await import('../src/services/storage')

  const runId = await mkRun('completed')
  const fix = await mkFixture(runId)
  const manualText = api.serializeSubtitleSrt([{ ...cues[0]!, text: '返修第一句' }, cues[1]!, cues[2]!])
  const manualSha = api.sha256Text(manualText)
  const disp = (await db.insert(assets).values({ projectId: 94, kind: 'text', purpose: 'subtitle_display', name: 'subtitle-display-stale', relPath: '94/texts/display.srt', mime: 'application/x-subrip', ext: 'srt', sha256: manualSha, fileSize: manualText.length, params: '{}', tags: '["subtitle_display"]', runId, createdAt: now, updatedAt: now }).returning())[0]!
  const mkVer = async (revision: number, meta: Record<string, unknown>) => {
    // 不可变版本文件真实落盘（assess/loadManualDisplay 的 readVersionContent 走生产同一路径）
    const absV = absPathOf(`94/versions/v${revision}.srt`)
    fs.mkdirSync(path.dirname(absV), { recursive: true })
    fs.writeFileSync(absV, manualText)
    return (await db.insert(contentVersions).values({ projectId: 94, objKind: 'asset', objId: disp.id, revision, payloadKind: 'file', relPath: `94/versions/v${revision}.srt`, sha256: manualSha, doc: null, label: null, source: 'edit', meta: JSON.stringify(meta), createdAt: now }).returning())[0]!
  }
  const v1 = await mkVer(1, { parentVersionId: null, baseFingerprint: '', requestId: 'req-s1' })
  const setPointer = async (versionId: number, baseFingerprint: string) => {
    await db.update(pipelineRuns).set({ input: JSON.stringify({ _subtitleEdits: { compose: { assetId: disp.id, versionId, sha256: manualSha, baseFingerprint, requestId: versionId === v1.id ? 'req-s1' : 'req-s2' } } }) }).where(eq(pipelineRuns.id, runId))
  }
  const readInput = async (): Promise<Record<string, unknown>> => JSON.parse((await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1))[0]!.input) as Record<string, unknown>
  const logs: string[] = []
  const loadViaProduction = async (): Promise<unknown> => {
    const input = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1))[0]!.input
    return md.loadManualDisplay({ runInput: input, stepKey: 'compose', readVersion: async () => manualText, recheckFingerprint: () => base.computeFingerprintForComposeRecheck(runId, 'compose'), log: (m) => logs.push(m) })
  }

  check((await base.computeFingerprintForComposeRecheck(runId, 'compose')) === null, '无指针 run：复验返回 null（无修订则零开销）')
  await setPointer(v1.id, 'pending')
  const fp1 = await base.computeFingerprintForComposeRecheck(runId, 'compose')
  check(typeof fp1 === 'string' && fp1.length > 0, '健康基准：合成期可重算依赖指纹')
  check((await base.computeFingerprintForComposeRecheck(runId, 'compose')) === fp1, '同一状态重复复验逐字节一致（无随机项）')
  await setPointer(v1.id, fp1!)
  await db.update(contentVersions).set({ meta: JSON.stringify({ parentVersionId: null, baseFingerprint: fp1, requestId: 'req-s1' }) }).where(eq(contentVersions.id, v1.id))
  const mPass = await loadViaProduction()
  check(mPass !== null && (mPass as { versionId: number }).versionId === v1.id, '确认后的本地续跑：复验通过，修订正常套用（不误拒合法路径）')
  await db.update(pipelineSteps).set({ status: 'running' }).where(eq(pipelineSteps.id, fix.composeId))
  check((await base.computeFingerprintForComposeRecheck(runId, 'compose')) === fp1, 'compose 步自身 running：执行态归一不参与过期判定')
  await db.update(pipelineSteps).set({ status: 'succeeded' }).where(eq(pipelineSteps.id, fix.composeId))
  // 漂移：合成配置改变（与 updateComposeConfig 同 _compose 键落库）→ 过期
  const inpClean = await readInput()
  await db.update(pipelineRuns).set({ input: JSON.stringify({ ...inpClean, _compose: { subtitleBurn: false } }) }).where(eq(pipelineRuns.id, runId))
  const fpDrift = await base.computeFingerprintForComposeRecheck(runId, 'compose')
  check(typeof fpDrift === 'string' && fpDrift !== fp1, '合成配置改变：依赖指纹漂移（过期因子可复验暴露）')
  logs.length = 0
  check((await loadViaProduction()) === null && logs.some((m) => m.includes('已过期')), '配置变更后重合成：过期修订不套用（所有入口共用合成期终检）')
  check(!!((await readInput())['_subtitleEdits'] as Record<string, unknown> | undefined)?.compose, '过期修订不静默删除：指针保留（可预览恢复/重新编辑）')
  await db.update(pipelineRuns).set({ input: JSON.stringify(inpClean) }).where(eq(pipelineRuns.id, runId))
  check((await base.computeFingerprintForComposeRecheck(runId, 'compose')) === fp1, '漂移排除（恢复原基准）：复验回到通过')
  // 指针链断（版本行缺失）fail closed
  await setPointer(999999, 'z')
  logs.length = 0
  check((await base.computeFingerprintForComposeRecheck(runId, 'compose')) === null && (await loadViaProduction()) === null && logs.some((m) => m.includes('不可复验')), '版本行缺失：不可复验按过期 fail closed，不套用')
  await setPointer(v1.id, fp1!)
  // 串行修订：前驱指针回拨使二次编辑不被误拒
  const v2 = await mkVer(2, { parentVersionId: v1.id, baseFingerprint: '', requestId: 'req-s2' })
  const assessed = await base.assessSubtitleCapability(runId, 'compose')
  check(assessed.capability.supported && assessed.baseline !== null, '串行前置：v1 指针态基准可 assess（健康夹具）')
  const fpConfirm = assessed.baseline!.fingerprint
  await setPointer(v2.id, 'pending')
  check((await base.computeFingerprintForComposeRecheck(runId, 'compose')) === fpConfirm, 'v2 指针态复验=确认时基准（前驱指针回拨生效）')
  await setPointer(v2.id, fpConfirm)
  const m2 = await loadViaProduction()
  check((m2 as { versionId: number } | null)?.versionId === v2.id, '第二次修订合成套用链路闭合（指针/版本链/复验一致）')

  /* ── 内部键不绕过输入白名单（验收②） ── */
  const tpl = { inputs: [{ key: 'topic', kind: 'text', required: true }] } as never
  const norm = rc.prepareRunInput(tpl, { topic: '测试', _subtitleEdits: { compose: { assetId: 1, versionId: 2, sha256: 'x', baseFingerprint: 'y', requestId: 'z' } }, _compose: { subtitleBurn: false } })
  check(norm['_subtitleEdits'] === undefined && norm['_compose'] === undefined && norm['topic'] === '测试', '新建 run 通道：内部键被过滤（仅模板声明键入快照）')
  let whiteErr = ''
  try { await cc.updateComposeConfig(runId, { _subtitleEdits: { compose: { assetId: 1 } } }) } catch (e) { whiteErr = (e as Error).message }
  check(whiteErr.includes('未知配置键'), '合成配置写通道：白名单拒内部键（受控指针不可伪造写入）')
  const afterWhite = await readInput()
  check(((afterWhite['_subtitleEdits'] as Record<string, { versionId: number }> | undefined)?.compose)?.versionId === v2.id, '拒绝不留痕：指针内容未被改写')
  /* ── 断点续跑不盲拷指针（规格 §6.2） ── */
  const stripped = JSON.parse(rc.stripResumeSubtitleEdits(JSON.stringify({ topic: 'x', _subtitleEdits: { compose: { versionId: 5 } }, _compose: { transition: 'fade' } }))) as Record<string, unknown>
  check(stripped['_subtitleEdits'] === undefined && stripped['topic'] === 'x' && !!stripped['_compose'], 'generic resume 派生：剥字幕指针、其余键保留（新 run 需重新基准确认）')
  check(rc.stripResumeSubtitleEdits('{"topic":"x"}') === '{"topic":"x"}' && rc.stripResumeSubtitleEdits('坏JSON') === '坏JSON', '无指针/坏 JSON：原样返回（既有续跑语义不变）')

  /* ── 仍被引用字幕不可清理（验收③，规格 §5.2-104） ── */
  const refs = await vc.subtitleReferenceIds(94)
  check(refs.has(disp.id) && refs.has(fix.srcId), '引用保护集：当前指针 + 历史成片快照源/显示字幕均命中')
  const oldImg = (await db.insert(assets).values({ projectId: 94, kind: 'image', purpose: 'shot', name: 'old.png', relPath: '94/image/old.png', mime: 'image/png', ext: 'png', sha256: 'o', fileSize: 1, taskId: 501, params: '{}', tags: '[]', runId, createdAt: now - 10, updatedAt: now - 10 }).returning())[0]!
  await db.insert(assets).values({ projectId: 94, kind: 'image', purpose: 'shot', name: 'new.png', relPath: '94/image/new.png', mime: 'image/png', ext: 'png', sha256: 'n', fileSize: 1, taskId: 501, params: '{}', tags: '[]', runId, createdAt: now, updatedAt: now })
  const cleaned = await vc.cleanupVersions({ projectId: 94 })
  check(cleaned.cleanedIds.includes(oldImg.id) && !cleaned.cleanedIds.includes(disp.id) && !cleaned.cleanedIds.includes(fix.srcId), '版本清理：同组旧图可清，文本字幕不在清理射程')
  fs.mkdirSync(path.dirname(absPathOf('94/texts/src.srt')), { recursive: true })
  fs.writeFileSync(absPathOf('94/texts/src.srt'), sourceText)
  fs.mkdirSync(path.dirname(absPathOf('94/image/ghost.png')), { recursive: true })
  fs.writeFileSync(absPathOf('94/image/ghost.png'), 'GHOST')
  const ghost = (await db.insert(assets).values({ projectId: 94, kind: 'image', purpose: 'shot', name: 'ghost.png', relPath: '94/image/ghost.png', mime: 'image/png', ext: 'png', sha256: 'g', fileSize: 5, params: '{}', tags: '[]', runId, deletedAt: now, createdAt: now, updatedAt: now }).returning())[0]!
  await db.update(assets).set({ deletedAt: now }).where(eq(assets.id, fix.srcId)) // 源字幕被「删除」进回收站
  await vc.emptyTrash(94)
  check(fs.existsSync(absPathOf('94/texts/src.srt')) && !fs.existsSync(absPathOf('94/image/ghost.png')), '清空回收站：被引用字幕文件保留，无引用文件删除')
  check(
    (await db.select().from(assets).where(eq(assets.id, fix.srcId)).limit(1)).length === 1 &&
      (await db.select().from(assets).where(eq(assets.id, ghost.id)).limit(1)).length === 0,
    '清空回收站：被引用条目记录保留（可还原），无引用条目连记录一并移除',
  )
  let purgeErr = ''
  try { await vc.purgeAsset(fix.srcId) } catch (e) { purgeErr = (e as Error).message }
  check(purgeErr.includes('拒绝彻底删除'), '历史成片/指针仍引用的字幕：彻底删除拒绝')
  const extra = (await db.insert(assets).values({ projectId: 94, kind: 'image', purpose: 'shot', name: 'extra.png', relPath: null, mime: 'image/png', ext: 'png', sha256: 'e', fileSize: 0, params: '{}', tags: '[]', runId, deletedAt: now, createdAt: now, updatedAt: now }).returning())[0]!
  await vc.purgeAsset(extra.id)
  check((await db.select().from(assets).where(eq(assets.id, extra.id)).limit(1)).length === 0, '无引用资产彻底删除放行（保护仅针对字幕引用链，不过度拦截）')
}

/** P8 成果版本投影：运行级 API（§7）+ 读模型四态 + 下载固定不可变版本（验收：旧 gate 不认可新字幕；无新产物不把旧片伪装已更新） */
export async function runProjectionSection(check: CheckFn): Promise<void> {
  const tools = await createFixtureTools(95)
  const { db, assets, pipelineRuns, pipelineSteps, mkRun, mkFixture } = tools
  const { contentVersions } = await import('../src/db/schema')
  const { eq } = await import('drizzle-orm')
  const engineMod = await import('../src/pipeline/engine')
  const started: number[] = []
  engineMod.engine.startRun = ((runId: number) => { started.push(runId); return 'started' }) as typeof engineMod.engine.startRun
  const { app } = await import('../src/app')
  const http = (path: string, init?: RequestInit) => app.request(`/api/v1${path}`, init)
  const postJson = (path: string, body: unknown) => http(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  interface RM {
    capability: { supported: boolean; code: string }
    baseline: { cues: Array<{ id: string }> } | null
    current_edit: { versionId: number; stale: boolean; stale_reason: string } | null
    versions: Array<{ version_id: number; revision: number; is_current: boolean; download_url: string; source: string; change_summary: string }>
    review: { gate_required: boolean; state: string; note: string }
    output: { compose_status: string | null; current_version_in_final: boolean; pending_recompose: boolean }
  }
  const rm = async (rid: number): Promise<{ status: number; body: RM }> => {
    const res = await http(`/runs/${rid}/subtitles`)
    return { status: res.status, body: await res.json() as RM }
  }

  const runId = await mkRun('completed')
  const fix = await mkFixture(runId)

  /* ── 投影端点基本而正确 ── */
  check((await http('/runs/999999/subtitles')).status === 404, '投影：未知 run → 404')
  const p0 = await rm(runId)
  check(p0.status === 200 && p0.body.capability.supported && !!p0.body.baseline && p0.body.current_edit === null && p0.body.versions.length === 0,
    '健康 run 无修订：能力+基准 cues 投影，无指针无版本（旧成果不误标修订态）')
  check(p0.body.output.pending_recompose === false && p0.body.output.current_version_in_final === true, '无修订时不伪造待重合成状态')

  /* ── preview 幂等面（HTTP 层） ── */
  const cueId = p0.body.baseline!.cues[0]!.id
  const changes1 = [{ kind: 'subtitle-text', cueId, text: '投影新第一句' }]
  const pv = await (await postJson(`/runs/${runId}/rework/preview`, { request_key: 'pj-1', changes: changes1 })).json() as { outcome: string; request_id: string; preview: { previewHash: string } }
  check(pv.outcome === 'ready' && !!pv.request_id && !!pv.preview.previewHash, 'POST preview：就绪回 request_id+previewHash（前端不自算依赖）')
  const pvRe = await (await postJson(`/runs/${runId}/rework/preview`, { request_key: 'pj-1', changes: changes1 })).json() as { outcome: string; preview: { previewHash: string } }
  check(pvRe.outcome === 'replayed' && pvRe.preview.previewHash === pv.preview.previewHash, '同键同载荷回放同一固定预览')
  check((await postJson(`/runs/${runId}/rework/preview`, { request_key: 'pj-1', changes: [{ kind: 'subtitle-text', cueId, text: '另一内容' }] })).status === 409, '同键异载荷 → 409（预览不可静默覆盖）')
  check((await postJson(`/runs/${runId}/rework/preview`, { changes: changes1 })).status === 400, '缺幂等键 request_key → 400')
  const st = await (await http(`/runs/${runId}/rework/${pv.request_id}`)).json() as { state: string; preview: { previewHash: string } }
  check(st.state === 'ready' && st.preview.previewHash === pv.preview.previewHash, 'GET 请求回放：纯读取固定预览（零副作用）')
  const run2 = await mkRun('completed')
  check((await http(`/runs/${run2}/rework/${pv.request_id}`)).status === 404, '跨 run 携带 requestId → 404（不泄漏归属）')

  /* ── apply：校验链 + 成功入队 ── */
  check((await postJson(`/runs/${runId}/rework/${pv.request_id}/apply`, {})).status === 400, 'apply 缺 preview_hash → 400（绝不接受任意确认）')
  check((await postJson(`/runs/${runId}/rework/${pv.request_id}/apply`, { preview_hash: 'wrong' })).status === 409, 'previewHash 不符 → 409 stale（不信前端数字）')
  const ap = await (await postJson(`/runs/${runId}/rework/${pv.request_id}/apply`, { preview_hash: pv.preview.previewHash })).json() as { outcome: string; result: { versionId: number; enqueued: boolean } }
  check(ap.outcome === 'applied' && ap.result.enqueued === true && started.length === 1, 'apply 成功：固定版本回执 + 事务后才启动引擎（一次）')

  /* ── 应用后投影（run queued 在途）：指针/待审/待重合成四态齐全 ── */
  const p1 = await rm(runId)
  const e1 = p1.body.current_edit
  check(p1.body.capability.code === 'run_active' && !!e1 && e1.versionId === ap.result.versionId && e1.stale === false,
    '在途投影：能力标 run_active 但指针/版本仍如实可读（GET 零副作用不误拒不执行）')
  check(e1!.stale_reason === 'ok' && p1.body.versions.length === 1 && p1.body.versions[0]!.is_current && p1.body.versions[0]!.source === 'edit',
    '当前修订投影：版本链固定 versionId，指针与版本列表一致')
  check(p1.body.review.state === 'manual_unreviewed' && p1.body.review.note.includes('尚未'),
    '无 gate 模板+人工修订 → manual_unreviewed（技术成功不叫内容通过；旧批准不沿用）')
  check(p1.body.output.pending_recompose === true && p1.body.output.current_version_in_final === false,
    '没有新产物时：旧成片不伪装已更新（pending_recompose，成片快照版本≠指针版本）')

  /* ── 下载指向具体不可变版本 ── */
  const dl1 = await http(p1.body.versions[0]!.download_url.replace('/api/v1', ''))
  const dlText = await dl1.text()
  check(dl1.status === 200 && (dl1.headers.get('content-disposition') ?? '').includes('attachment'), '版本下载：附件语义固定具体 versionId')
  check(dlText.includes('投影新第一句') && dlText.includes(api.serializeSubtitleSrt([{ startMs: 0, endMs: 2000, text: '投影新第一句' }])), '下载内容即该版次完整 SRT（与预览结果一致）')

  /* ── 模拟重合成完成 → 投影回到已交付；再二编验证历史不可变 ── */
  await db.update(pipelineRuns).set({ status: 'completed' }).where(eq(pipelineRuns.id, runId))
  await db.update(pipelineSteps).set({ status: 'succeeded' }).where(eq(pipelineSteps.id, fix.composeId))
  const finRow = (await db.select().from(assets).where(eq(assets.id, fix.finalId)).limit(1))[0]!
  const finParams = JSON.parse(finRow.params ?? '{}') as Record<string, unknown>
  ;(finParams.timeline as { subtitle: Record<string, unknown> }).subtitle.versionId = ap.result.versionId
  await db.update(assets).set({ params: JSON.stringify(finParams) }).where(eq(assets.id, fix.finalId))
  const p2 = await rm(runId)
  check(p2.body.output.pending_recompose === false && p2.body.output.current_version_in_final === true && p2.body.current_edit?.stale === false,
    '重合成已落地：投影确认成片绑定当前版本（不再待重合成）')

  const cue2 = p2.body.baseline!.cues[p2.body.baseline!.cues.length - 1]!.id
  const pvB = await (await postJson(`/runs/${runId}/rework/preview`, { request_key: 'pj-2', changes: [{ kind: 'subtitle-text', cueId: cue2, text: '第二版尾句' }] })).json() as { outcome: string; request_id: string; preview: { previewHash: string } }
  check(pvB.outcome === 'ready', '串行第二预览就绪（基于人工修订基准继续编辑）')
  const apB = await (await postJson(`/runs/${runId}/rework/${pvB.request_id}/apply`, { preview_hash: pvB.preview.previewHash })).json() as { outcome: string; result: { versionId: number } }
  check(apB.outcome === 'applied' && apB.result.versionId !== ap.result.versionId, '第二修订应用：新不可变版本（不倒写历史）')
  const dlOld = await (await http(p1.body.versions[0]!.download_url.replace('/api/v1', ''))).text()
  check(dlOld === dlText, '历史版本文件永不变：v1 下载内容与首次一致（指针前进不影响旧版）')
  const p3 = await rm(runId)
  check(p3.body.versions.length === 2 && p3.body.versions[0]!.version_id === apB.result.versionId && p3.body.versions[1]!.version_id === ap.result.versionId,
    '版本历史倒序投影，当前指针指向 v2（is_current 见首条）')
  check(p3.body.output.pending_recompose === true, '二编后旧成片再标待重合成（不把 v1 成片冒充 v2 产物）')

  /* ── 漂移与错误面 ── */
  await db.update(pipelineRuns).set({ status: 'completed' }).where(eq(pipelineRuns.id, runId))
  const inpRow = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1))[0]!
  await db.update(pipelineRuns).set({ input: JSON.stringify({ ...JSON.parse(inpRow.input) as Record<string, unknown>, _compose: { subtitleBurn: false } }) }).where(eq(pipelineRuns.id, runId))
  const p4 = await rm(runId)
  check(p4.body.current_edit?.stale === true && p4.body.current_edit?.stale_reason === 'fingerprint_drift', '配置漂移：读模型标过期原因（与合成期复验同一口径）')
  const fakeVer = (await db.insert(contentVersions).values({ projectId: 95, objKind: 'asset', objId: p3.body.versions[0]!.version_id, revision: 99, payloadKind: 'file', relPath: '95/versions/not-exist.srt', sha256: 'x', source: 'edit', meta: '{}', createdAt: Date.now() }).returning())[0]!
  check((await http(`/assets/${p3.body.versions[0]!.version_id}/versions/${fakeVer.id}/download`)).status === 404, '版本文件缺失：下载 404 不伪造内容')
  const cross = await http(`/assets/${fix.srcId}/versions/${fakeVer.id}/download`)
  check(cross.status === 403 || cross.status === 404, '跨资产携带 versionId 被拒（归属校验）')
}

/** P9：工程字幕与 sidecar——共享 cue 读取 + FCPXML/OTIO 接线（纯函数分节，零库零网络） */
export async function runExchangeSection(check: CheckFn): Promise<void> {
  const { readSubtitleCues } = await import('../src/services/edit-exchange/subtitle-cues')
  const { toFcpxml } = await import('../src/services/edit-exchange/fcpxml')
  const { toEdl } = await import('../src/services/edit-exchange/edl')
  const { toOtio } = await import('../src/services/edit-exchange/otio')
  const { makeCtx } = await import('../src/services/edit-exchange/render-context')

  const src = fixture()
  const lines = src.cues.map((c, i) => ({
    lineId: `L${i + 1}`,
    assetId: 500 + i,
    relPath: `9/voice-${i + 1}.mp3`,
    timelineStart: c.startMs / 1000,
    durSec: (c.endMs - c.startMs) / 1000,
    text: c.text,
  }))
  const mkTl = (subtitle: Record<string, unknown> | null): Record<string, unknown> => ({
    v: 1, fps: 25, width: 1080, height: 1920, totalSec: 11, introSec: 2, outroSec: 0,
    segments: [{ shotId: 's1', assetId: 600, relPath: '9/seg1.mp4', kind: 'video', durSec: 9, startSec: 0, lineIds: ['L1'], silenceSec: 0 }],
    lines, sfx: [], bgm: null, transition: null, watermark: false, subtitle,
  })
  /* 人工修订快照：首句改文本+平移到 5-7s（final 绝对轴），尾两句锚定源基准不变 */
  const manualSub = {
    assetId: 700, relPath: '9/source.srt', versionId: 42, sha256: 'ab12', coordinate: 'final', origin: 'manual',
    cues: [{ id: src.cues[0]!.id, startMs: 5000, endMs: 7000, text: '魔改首句' }, ...src.cues.slice(1)],
  }
  const ctx = makeCtx('exchange-probe')

  /* ── 共享 cue 读取 ── */
  const read = readSubtitleCues(mkTl(manualSub) as never)
  check(read.source === 'subtitle' && read.origin === 'manual', '字幕读取：有有效快照 cues 时取快照（origin 透传）')
  check(read.cues[0]!.startSec === 5 && read.cues[0]!.durSec === 2 && read.cues[0]!.text === '魔改首句', 'cue 毫秒→秒换算正确（final 绝对轴不叠加 intro）')
  const badRead = readSubtitleCues(mkTl({ assetId: 700, relPath: '9/source.srt', cues: [{ nope: 1 }] }) as never)
  check(badRead.source === 'lines-fallback', '快照 cues 均畸形：降级 lines 兜底并如实标注来源')
  const emptyRead = readSubtitleCues({ ...mkTl(null), lines: [] } as never)
  check(emptyRead.source === 'none' && emptyRead.cues.length === 0, '无字幕无对白：source=none 不造假条目')

  /* ── FCPXML：字幕 title 轨取 cues，对白 spine 仍取 lines ── */
  const xml = toFcpxml(mkTl(manualSub) as never, ctx)
  check(xml.includes('<text-style ref="ts1">魔改首句</text-style>'), 'FCPXML 字幕轨呈现人工修订文本（不被 lines 覆盖）')
  check(xml.includes('offset="125/25s"') && !xml.includes('第一句'), 'FCPXML 修订 cue 落在绝对轴 5s（无双重叠 intro）；旧对白文本不再泄漏进字幕轨')
  check((xml.match(/<title /g) ?? []).length === 3, 'FCPXML 字幕条数与有效 cues 对齐')
  check(xml.includes('name="L1"') && xml.includes('offset="50/25s"'), 'FCPXML 对白 spine 仍只读 lines（intro 2s 位移保持，未被字幕轨改动）')
  const xmlFb = toFcpxml(mkTl({ assetId: 700, relPath: '9/source.srt' }) as never, ctx)
  check(xmlFb.includes('<text-style ref="ts1">第一句</text-style>') && (xmlFb.match(/<title /g) ?? []).length === 3, '旧快照无 cues：FCPXML 按兜底旧规则构造（行为向后兼容）')

  /* ── OTIO：Markdown 轨取 cues，Dialogue Audio 轨不变 ── */
  const doc = toOtio(mkTl(manualSub) as never, ctx) as never as { metadata: Record<string, unknown>; tracks: { children: Array<{ name: string; children: Array<Record<string, unknown>> }> } }
  const clipsOf = (trackName: string): Array<Record<string, unknown>> =>
    (doc.tracks.children.find((t) => t.name === trackName)?.children ?? []).filter((x) => String(x['OTIO_SCHEMA']).includes('Clip'))
  const mdClips = clipsOf('Markdown')
  check(mdClips.length === 3 && doc.metadata['subtitle_source'] === 'subtitle' && doc.metadata['subtitle_origin'] === 'manual', 'OTIO Markdown 轨取有效快照 cues（来源/origin 入 metadata）')
  const mdEdited = mdClips.find((cl) => (cl['metadata'] as Record<string, unknown>)?.['text'] === '魔改首句')
  const editedStart = ((mdEdited?.['source_range'] as Record<string, Record<string, number>>)['start_time'])['value']
  check(editedStart === 125, 'OTIO 修订 cue 起点 125 帧=5s@25fps（绝对轴不叠加 intro）')
  check(clipsOf('Dialogue Audio').length === 3, 'OTIO Dialogue Audio 轨仍只读 lines（字幕接线不影响对白音轨）')

  /* ── EDL：明确不承载字幕轨（降级面由包内 notes/README 声明） ── */
  const edl = toEdl(mkTl(manualSub) as never, ctx)
  check(!edl.includes('魔改首句') && !edl.includes('第一句'), 'EDL 不伪装支持字幕：工程文件无任何字幕文本')

  /* ── 构建级：sidecar 打包 + 清单版本绑定（隔离库 + 真 zip，零网络零供应商） ── */
  const PID = 96
  const tools = await createFixtureTools(PID)
  const { db, assets, now, sourceText, mkRun, mkFixture } = tools
  const fs = await import('node:fs')
  const pathMod = await import('node:path')
  const { absPathOf } = await import('../src/services/storage')
  const ex = await import('../src/services/edit-exchange')
  const { unzipSync, strFromU8 } = await import('fflate')
  const mkFinal = async (runId: number, name: string, timeline: Record<string, unknown>): Promise<number> => {
    const rows = await db.insert(assets).values({ projectId: PID, kind: 'video', purpose: 'final_video', name, relPath: `${PID}/video/${name}`, mime: 'video/mp4', ext: 'mp4', sha256: 'x', fileSize: 10, params: JSON.stringify({ timeline }), tags: '[]', runId, createdAt: now, updatedAt: now }).returning()
    // 产物收集按步骤 output 归集：手工 final 也补 compose 成功步引用
    await db.insert(tools.pipelineSteps).values({ runId, seq: 9, stepKey: 'compose', actionKey: 'ffmpeg_merge', status: 'succeeded', output: JSON.stringify({ asset_ids: [rows[0]!.id] }), attempts: 1, createdAt: now, updatedAt: now })
    return rows[0]!.id
  }
  const buildUnzipped = async (p: { runId: number; format: 'fcpxml' | 'edl' | 'otio'; finalAssetId?: number }) => {
    const built = await ex.buildEditExchange({ includeMedia: false, ...p })
    const entries = unzipSync(new Uint8Array(fs.readFileSync(absPathOf(built.asset.relPath!))))
    return { built, entries, mf: JSON.parse(strFromU8(entries['manifest.json']!)) as Record<string, any> }
  }

  // 健康案：有效文件存在且 hash 吻合 → 交付一致
  const runOk = await mkRun('completed')
  const fixOk = await mkFixture(runOk)
  const srcAbs = absPathOf(`${PID}/texts/src.srt`)
  fs.mkdirSync(pathMod.dirname(srcAbs), { recursive: true })
  fs.writeFileSync(srcAbs, sourceText)
  const ok1 = await buildUnzipped({ runId: runOk, format: 'edl' })
  check(ok1.built.finalAssetId === fixOk.finalId, '旧调用（不传 final_asset_id）解析定版本并回传绑定 id')
  check(!!ok1.entries['subtitles.srt'] && !!ok1.entries['README.txt'], 'EDL + includeMedia=false 仍包含文本 sidecar 与 README')
  check(strFromU8(ok1.entries['subtitles.srt']!) === sourceText, 'sidecar 即版本固定有效字幕文件（逐字节）')
  check(ok1.mf.subtitle.finalAssetId === fixOk.finalId && ok1.mf.subtitle.cueSource === 'subtitle' && ok1.mf.subtitle.deliveryConsistent === true && ok1.mf.subtitle.manualEdited === false, 'manifest 记录版本绑定与交付一致（无人工修订如实 false）')
  check(Array.isArray(ok1.mf.notes) && ok1.mf.notes.some((n: string) => n.includes('subtitles.srt')), 'EDL 降级说明包内附 sidecar（明确不内嵌字幕轨）')
  const builtNoFile = await ex.buildEditExchange({ runId: runOk, format: 'otio', includeMedia: true })
  check(builtNoFile.asset.params != null, '同版多格式重复构建不抛错（不覆盖历史包）')

  // 篡改案：文件与快照声明 hash 不符 → 不声称一致但仍出可读 sidecar
  fs.writeFileSync(srcAbs, 'TAMPERED\r\n')
  const bad2 = await buildUnzipped({ runId: runOk, format: 'fcpxml' })
  check(bad2.mf.subtitle.deliveryConsistent === false && bad2.mf.notes.some((n: string) => n.includes('缺失或与快照声明 hash 不符')), 'hash 不符：阻止声称字幕交付一致（降级 note 可审计）')
  check(strFromU8(bad2.entries['subtitles.srt']!).includes('第一句'), '不符时 sidecar 由快照 cues 重建（仍可读，不空交）')
  fs.writeFileSync(srcAbs, sourceText)

  // 版本固定拒绝：不存在/跨 run 的 final_asset_id 均拦
  let code1 = ''
  try { await ex.buildEditExchange({ runId: runOk, format: 'fcpxml', finalAssetId: 999999 }) } catch (e) { code1 = (e as { code?: string }).code ?? '' }
  check(code1 === 'no_final_video', '不存在的 final_asset_id 拒绝（不假装解析其他版本）')
  const runOther = await mkRun('completed')
  const fixOther = await mkFixture(runOther)
  let code2 = ''
  try { await ex.buildEditExchange({ runId: runOther, format: 'edl', finalAssetId: fixOk.finalId }) } catch (e) { code2 = (e as { code?: string }).code ?? '' }
  check(code2 === 'no_final_video', '跨 run 携带 final_asset_id 被拒（归属校验）')

  // 存量兜底案：旧快照无 cues → lines-fallback，不声称一致
  const runL = await mkRun('completed')
  const finalL = await mkFinal(runL, 'legacy.mp4', mkTl({ assetId: 700, relPath: `${PID}/texts/src.srt` }) as Record<string, unknown>)
  const leg = await buildUnzipped({ runId: runL, format: 'otio', finalAssetId: finalL })
  check(leg.mf.subtitle.cueSource === 'lines-fallback' && leg.mf.subtitle.deliveryConsistent === false, '旧快照：兼容标注兜底来源且不声称一致（不阻断工程导出）')
  check(strFromU8(leg.entries['subtitles.srt']!).includes('第一句'), '兜底 sidecar 携带对白文本（旧行为可用）')

  // 人工修订 + 有效文件缺失：manualEdited=true 但不声称一致
  const runM = await mkRun('completed')
  const finalM = await mkFinal(runM, 'manual.mp4', mkTl({ ...manualSub, relPath: `${PID}/texts/ghost.srt`, effectiveRelPath: `${PID}/texts/ghost.srt` }) as Record<string, unknown>)
  const man = await buildUnzipped({ runId: runM, format: 'fcpxml', finalAssetId: finalM })
  check(man.mf.subtitle.manualEdited === true && man.mf.subtitle.versionId === 42 && man.mf.subtitle.sha256 === 'ab12', '清单携人工修订态（版本 id/hash/origin 可审计）')
  check(man.mf.subtitle.deliveryConsistent === false && strFromU8(man.entries['subtitles.srt']!).includes('魔改首句'), '有效文件缺失：不声称一致，但 cues 重建 sidecar 仍呈人工修订文本')
}

/** P12：显式字幕自然语言解析——模型桩（fetch 只放行 localhost:0/offline chat/completions，其它媒体域名直接抛） */
export async function runParseSection(check: CheckFn): Promise<void> {
  const tools = await createFixtureTools(97)
  const { db, mkRun, mkFixture } = tools
  const { apiConfigs, usageRecords } = await import('../src/db/schema')
  const { eq } = await import('drizzle-orm')
  const parseMod = await import('../src/services/rework/parse')
  const previewMod = await import('../src/services/rework/preview')
  const applyMod = await import('../src/services/rework/apply')
  const baselineMod = await import('../src/services/rework/baseline')
  const engineMod = await import('../src/pipeline/engine')
  const started: number[] = []
  engineMod.engine.startRun = ((runId: number) => { started.push(runId); return 'started' }) as typeof engineMod.engine.startRun
  engineMod.engine.pumpGlobal = (async () => {}) as typeof engineMod.engine.pumpGlobal

  process.env.PROBE_PRECISION_PARSE_KEY = 'offline-precision-parse'
  const blocker = globalThis.fetch
  let llmMode: 'ok' | 'boom' = 'ok'
  let llmReply = '{}'
  let llmCalls = 0
  const seedLlm = async (pricing: string): Promise<void> => {
    await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, 'llm'))
    await db.insert(apiConfigs).values({ name: 'llm', providerKey: 'deepseek_llm', serviceType: 'llm', model: 'probe-llm', apiKeyRef: 'env:PROBE_PRECISION_PARSE_KEY', baseUrl: 'http://localhost:0/offline', extra: '{}', pricing, isActive: 1, isDefault: 1, priority: 0, createdAt: Date.now(), updatedAt: Date.now() } as never)
  }
  const parse = (runId: number, req: { requestKey: string; instruction: string; acceptUnpriced?: boolean }) => parseMod.parseSubtitleInstruction({ runId, ...req })

  try {
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      if (!url.startsWith('http://localhost:0/offline')) throw new Error('parse 探针禁止外部网络')
      if (!url.includes('/chat/completions')) throw new Error('字幕解析不得触碰媒体端点')
      llmCalls += 1
      if (llmMode === 'boom') throw new Error('模拟解析超时')
      return Response.json({ choices: [{ message: { content: llmReply }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } })
    }

    /* ── 能力拦断：运行在途不解析（零模型调用） ── */
    const busyRun = await mkRun('running')
    await mkFixture(busyRun)
    await seedLlm('{"tokens_in":2,"tokens_out":8}')
    llmMode = 'ok'; llmCalls = 0
    const rb = await parse(busyRun, { requestKey: 'p-busy', instruction: '把第一句改成测试' })
    check(rb.outcome === 'blocked' && rb.code === 'run_active' && llmCalls === 0, '在途运行：解析前能力拦断，零模型调用')

    /* ── 正常解析→同预览编译器→确认本地续跑 + parse-once（同键仅一次模型） ── */
    const okRun = await mkRun('completed')
    await mkFixture(okRun)
    const cueId = (await baselineMod.assessSubtitleCapability(okRun, 'compose')).baseline!.cues[0]!.id
    llmMode = 'ok'; llmReply = JSON.stringify({ changes: [{ cue_index: 1, text: '解析改首句' }], unclear: null }); llmCalls = 0
    const r1 = await parse(okRun, { requestKey: 'p-ok', instruction: '把第一句字幕改成解析改首句' })
    check(r1.outcome === 'ready' && r1.changes.length === 1 && r1.changes[0]!.kind === 'subtitle-text' && (r1.changes[0] as { cueId: string }).cueId === cueId, '自然语言→同构 subtitle-text，cue_index 映射回真实 cueId')
    check(r1.outcome === 'ready' && r1.preview.finalCues[0]!.text === '解析改首句' && r1.preview.impact.modelCalls === 0 && r1.preview.impact.localOnly === true, '解析产物进唯一预览编译器：预览仍零模型调用纯本地')
    check(r1.outcome === 'ready' && r1.estimate.modelCalls === 1 && r1.estimate.priced && r1.estimate.knownCost > 0 && llmCalls === 1, '已计价解析：恰一次模型调用、按实际 token 折算解析费据实回执')
    const r1b = await parse(okRun, { requestKey: 'p-ok', instruction: '把第一句字幕改成解析改首句' })
    check(r1b.outcome === 'replayed' && llmCalls === 1 && r1b.outcome === 'replayed' && r1b.requestId === (r1 as { requestId: string }).requestId, '同键同指令回放既有解析：不再调模型（最多一次）')
    check(r1.outcome === 'ready' && (await parse(okRun, { requestKey: 'p-ok', instruction: '换一条完全不同的指令内容' })).outcome === 'conflict', '同键异指令 → 幂等冲突（解析键不可挪用）')
    // 解析产出的预览走既有 apply 确认（旧流程继续可用，同编译器同回执）
    if (r1.outcome === 'ready') {
      const ap = await applyMod.applySubtitleRework({ requestId: r1.requestId, previewHash: r1.preview.previewHash })
      check(ap.outcome === 'applied' && started.length === 1 && started[0] === okRun, '解析预览可原样确认应用（与直接预览入口同一编译器/同一确认闸）')
    }

    /* ── 未知费用须先确认：未配单价时不静默调模型、不计为 0 ── */
    const unpRun = await mkRun('completed')
    await mkFixture(unpRun)
    await seedLlm('{}')
    llmMode = 'ok'; llmReply = JSON.stringify({ changes: [{ cue_index: 2, start_ms: 3000, end_ms: 4500 }], unclear: null }); llmCalls = 0
    const ru = await parse(unpRun, { requestKey: 'p-unp', instruction: '第二句时间改到 3 到 4.5 秒' })
    check(ru.outcome === 'unpriced' && ru.estimate.priced === false && ru.estimate.unpriced.length === 2 && llmCalls === 0, '未配置解析单价：先返回待确认、零模型调用、按未知列出不冒充 0 元')
    const ru2 = await parse(unpRun, { requestKey: 'p-unp', instruction: '第二句时间改到 3 到 4.5 秒', acceptUnpriced: true })
    check(ru2.outcome === 'ready' && llmCalls === 1 && ru2.outcome === 'ready' && ru2.estimate.priced === false && ru2.changes[0]!.kind === 'subtitle-time', '显式接受未知费后才解析：一次调用产出 subtitle-time')

    /* ── 歧义/混合整单阻断 + 越界不猜 ── */
    const ambRun = await mkRun('completed')
    await mkFixture(ambRun)
    await seedLlm('{"tokens_in":2,"tokens_out":8}')
    llmMode = 'ok'; llmCalls = 0
    llmReply = JSON.stringify({ changes: [], unclear: '你想调整配音语气，本入口只改字幕文字与时间，做不到' })
    const ra = await parse(ambRun, { requestKey: 'p-amb', instruction: '让旁白更有感情' })
    check(ra.outcome === 'uncertain' && ra.unclear !== null && llmCalls === 1, '歧义（改配音）：一次解析后返回待澄清、无预览、整单不执行')
    llmReply = JSON.stringify({ changes: [{ cue_index: 1, text: '能改的这句先改' }], unclear: '还提到要换背景音乐，本入口做不到' })
    const rm = await parse(ambRun, { requestKey: 'p-mix', instruction: '第一句改文案，另外换掉背景音乐' })
    check(rm.outcome === 'uncertain' && rm.unclear !== null && llmCalls === 2, '混合诉求（字幕+音乐）：即便含可执行项也整单不执行（不部分生效）')
    llmReply = JSON.stringify({ changes: [{ cue_index: 99, text: '不存在' }], unclear: null })
    const ro = await parse(ambRun, { requestKey: 'p-oob', instruction: '改第 99 句' })
    check(ro.outcome === 'uncertain' && llmCalls === 3, 'cue 越界：绝不猜、返回待澄清')

    /* ── 超时/结果未知不自动重发（同键重放仍标 uncertain、不再调模型） ── */
    const toRun = await mkRun('completed')
    await mkFixture(toRun)
    llmMode = 'boom'; llmCalls = 0
    const rt1 = await parse(toRun, { requestKey: 'p-timeout', instruction: '把第一句改成会超时的场景' })
    check(rt1.outcome === 'uncertain' && llmCalls === 1, '模型超时：登记 uncertain、据实不重发')
    llmMode = 'ok'
    const rt2 = await parse(toRun, { requestKey: 'p-timeout', instruction: '把第一句改成会超时的场景' })
    check(rt2.outcome === 'uncertain' && llmCalls === 1, '同键再发：领用状态回放，绝不自动重发（模型仍只 1 次）')

    /* ── 用量据实记账（每次成功解析两条 tokens_in/out） ── */
    const used = await db.select().from(usageRecords).where(eq(usageRecords.projectId, 97))
    check(used.filter((u) => JSON.parse(String(u.meta ?? '{}')).purpose === 'subtitle_parse').length >= 4, '解析用量入 usage_records（多轮成功解析逐次记账，不隐匿）')

    /* ── HTTP 端点接线（routes 转发服务层唯一实现） ── */
    const { app } = await import('../src/app')
    const httpRun = await mkRun('completed')
    await mkFixture(httpRun)
    llmMode = 'ok'; llmReply = JSON.stringify({ changes: [{ cue_indexes: [3], shift_ms: 200 }], unclear: null })
    const res = await app.request(`/api/v1/runs/${httpRun}/rework/parse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request_key: 'p-http', instruction: '第三句整体延后 200 毫秒' }) })
    const body = await res.json() as { outcome: string; request_id: string; preview: { finalCues: Array<{ startMs: number; endMs: number }> } }
    check(res.status === 200 && body.outcome === 'ready' && body.preview.finalCues[2]!.startMs === 6200 && body.preview.finalCues[2]!.endMs === 8200, 'POST /rework/parse：平移指令经 HTTP 入口产出正确预览（只动目标 cue）')
    check((await app.request(`/api/v1/runs/${httpRun}/rework/parse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction: '缺幂等键' }) })).status === 400, '缺 request_key → 400')
    check((await app.request('/api/v1/runs/999999/rework/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request_key: 'x', instruction: '不存在' }) })).status === 404, '未知 run → 404')
  } finally {
    globalThis.fetch = blocker
    delete process.env.PROBE_PRECISION_PARSE_KEY
    await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, 'llm')).catch(() => {})
  }
}
