/**
 * precision-rework 探针 · qc-panel 分节（第四期：统一 QC 面板·成片质量可验证/交付可信只读核验）——
 * 自 probe-precision-rework 拆出：m26 split-audit 红线单文件 ≤800 行。文件名不带 probe- 前缀：
 * 本模块是被主探针 import 的库，不是可独立执行的探针（run-probes 按 probe-*.ts 扫描）。
 * 隔离库 + 本地 FFmpeg lavfi 合成真实假 mp4（标 synthetic，不碰生产样片）：零模型、零付费、零供应商、零网络。
 * 覆盖规格 §8 九条核心断言：#1 合成假片客观值（file_readable/stream_spec/duration_vs_timeline）+ 造差 failed；
 * #2 缺 params.timeline → timeline_source not_tested 不反推；#3 时长覆盖入轴 passed / 未入轴 failed；
 * #4 台账 applied 指纹漂移 failed / 一致 passed / 门禁不足 not_tested / 无台账 not_applicable；
 * #5 audio_peak 客观测量失真留人工 / delivery_flag 只读呈现；#6 verdict 三态；#7 缺测降级 not_tested 不判 failed；
 * #8 缓存写 params.qc 保留其余键（零新列）+ 成片 hash 变 → 旧结论 stale；#9 全程零 gen_tasks、零 usage_records。
 */
import { createFixtureTools, type CheckFn } from './precision-rework-sections'
import type { ParsedTimeline } from '../src/services/qc/consistency'
import type { QcCheck } from '../src/services/qc/types'

export async function runQcPanelSection(check: CheckFn): Promise<void> {
  const projectId = 99
  const tools = await createFixtureTools(projectId)
  const { db, assets, genTasks, now, mkRun, mkFixture } = tools
  const { eq, count } = await import('drizzle-orm')
  const { spawnSync } = await import('node:child_process')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { createHash } = await import('node:crypto')
  const { absPathOf } = await import('../src/services/storage')
  const { resolveFfmpeg, resolveFfprobe, probeMediaDuration } = await import('../src/services/ffmpeg')
  const { usageRecords } = await import('../src/db/schema')
  const qc = await import('../src/services/qc/report')
  const qcCons = await import('../src/services/qc/consistency')

  const mediaAvailable = !!resolveFfmpeg() && !!resolveFfprobe()
  const findCheck = (checks: QcCheck[], key: QcCheck['key']): QcCheck | undefined => checks.find((c) => c.key === key)

  /* ── #9 零付费基线：本 project 下 gen_tasks / usage_records 起始为 0 ── */
  const gt0 = (await db.select({ n: count() }).from(genTasks).where(eq(genTasks.projectId, projectId)))[0]?.n ?? 0
  const ur0 = (await db.select({ n: count() }).from(usageRecords).where(eq(usageRecords.projectId, projectId)))[0]?.n ?? 0

  /* ════════ 纯函数层（确定性、不依赖 ffmpeg）：#2 / #3 / #4 / #7 / 结构越界 ════════ */
  const baseInput = { measuredDurationSec: 9, shotDurations: {} as Record<string, number>, lastAppliedFingerprint: null as string | null, currentFingerprint: null as string | null }
  const tl9: ParsedTimeline = { totalSec: 9, segments: [], lines: [], hasSubtitle: false }

  // #2：无 params.timeline → timeline_source/duration not_tested，绝不从 cue/shot 反推重建第二套时轴
  const noTl = qcCons.buildConsistencyChecks({ ...baseInput, timeline: null })
  const tsNoTl = findCheck(noTl, 'timeline_source')!
  check(tsNoTl.status === 'not_tested' && !!tsNoTl.reason && tsNoTl.reason.includes('不反推'), '#2 缺 params.timeline → timeline_source=not_tested（不反推重建时轴）')
  check(findCheck(noTl, 'duration_vs_timeline')?.status === 'not_tested', '#2 缺时轴 → duration_vs_timeline=not_tested（无基准不臆断）')

  // #7：ffprobe 缺测（实测 null）→ duration not_tested，绝不判 failed（遵循 image-check 保守策略）
  const noMeas = qcCons.buildConsistencyChecks({ ...baseInput, timeline: tl9, measuredDurationSec: null })
  check(findCheck(noMeas, 'duration_vs_timeline')?.status === 'not_tested', '#7 ffprobe 不可用（实测 null）→ duration_vs_timeline=not_tested，不判 failed')

  // #3：图片镜显示段长 ≥ 请求覆盖 → passed；段长 < 请求（覆盖未入轴）→ failed（返修后未重生成）
  const tlSeg: ParsedTimeline = { totalSec: 6, segments: [{ shotId: 's1', kind: 'image', durSec: 3, silenceSec: 0 }], lines: [], hasSubtitle: false }
  const appliedOk = qcCons.buildConsistencyChecks({ ...baseInput, timeline: tlSeg, measuredDurationSec: 6, shotDurations: { s1: 2 } })
  check(findCheck(appliedOk, 'shot_duration_applied')?.status === 'passed', '#3 覆盖(2)已入轴且段长(3)≥请求 → shot_duration_applied=passed')
  const appliedDrift = qcCons.buildConsistencyChecks({ ...baseInput, timeline: tlSeg, measuredDurationSec: 6, shotDurations: { s1: 6 } })
  check(findCheck(appliedDrift, 'shot_duration_applied')?.status === 'failed', '#3 覆盖(6)未反映到段长(3<6) → shot_duration_applied=failed（少返工漂移暴露）')

  // #4：台账 applied 指纹 vs 当前基准（漂移/一致/门禁不足/无台账 四态）
  const drift = qcCons.buildConsistencyChecks({ ...baseInput, timeline: tl9, lastAppliedFingerprint: 'fp-a', currentFingerprint: 'fp-b' })
  check(findCheck(drift, 'rework_receipt_consistency')?.status === 'failed', '#4 台账 applied 指纹≠当前基准 → rework_receipt_consistency=failed（漂移）')
  const fpMatch = qcCons.buildConsistencyChecks({ ...baseInput, timeline: tl9, lastAppliedFingerprint: 'fp-a', currentFingerprint: 'fp-a' })
  check(findCheck(fpMatch, 'rework_receipt_consistency')?.status === 'passed', '#4 指纹一致 → rework_receipt_consistency=passed')
  const gateNo = qcCons.buildConsistencyChecks({ ...baseInput, timeline: tl9, lastAppliedFingerprint: 'fp-a', currentFingerprint: null })
  check(findCheck(gateNo, 'rework_receipt_consistency')?.status === 'not_tested', '#4 门禁不足无当前指纹 → not_tested（不伪造比对）')
  const noLedger = qcCons.buildConsistencyChecks({ ...baseInput, timeline: tl9, lastAppliedFingerprint: null })
  check(findCheck(noLedger, 'rework_receipt_consistency')?.status === 'not_applicable', '#4 该运行无已应用返修 → not_applicable')

  // parseTimeline 只读派生（读同一真源）+ #1 实测 vs 声明造差 + 字幕结构越界
  const parsed = qcCons.parseTimeline({ timeline: { totalSec: 9, segments: [{ shotId: 'x', kind: 'video', durSec: 4 }], lines: [{ timelineStart: 8, durSec: 5 }] } })
  check(!!parsed && parsed.totalSec === 9 && parsed.segments.length === 1 && parsed.segments[0]?.kind === 'video', 'parseTimeline 只读派生段/kind（读同一真源，不重建）')
  const crossed = qcCons.buildConsistencyChecks({ ...baseInput, timeline: parsed, measuredDurationSec: 12 })
  check(findCheck(crossed, 'duration_vs_timeline')?.status === 'failed', '#1 实测(12) vs 声明(9) 差超容差 → duration_vs_timeline=failed')
  const subOver = qcCons.buildConsistencyChecks({ ...baseInput, timeline: parsed, measuredDurationSec: 9 })
  check(findCheck(subOver, 'subtitle_alignment_present')?.status === 'failed', '字幕行(8+5=13)越出声明总长(9) → subtitle_alignment_present=failed（结构越界，语义仍留人工）')

  /* ════════ 端到端：本地 lavfi 合成真实 mp4（音视频流，标 synthetic，零模型零计费） ════════ */
  if (mediaAvailable) {
    const synth = (absPath: string, durSec: number): boolean => {
      fs.mkdirSync(path.dirname(absPath), { recursive: true })
      const r = spawnSync(resolveFfmpeg()!, [
        '-n', '-v', 'error',
        '-f', 'lavfi', '-i', `color=c=blue:s=160x240:r=25:d=${durSec}`,
        '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durSec}`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', absPath,
      ], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
      return r.status === 0
    }
    const readFinal = async (finalId: number) => (await db.select().from(assets).where(eq(assets.id, finalId)).limit(1))[0]!
    const setFinal = async (finalId: number, patch: Partial<{ sha256: string; params: string; duration: number }>): Promise<void> => {
      await db.update(assets).set({ ...patch, updatedAt: now }).where(eq(assets.id, finalId))
    }

    // 健康成片：真实 mp4，totalSec=实测（差 0 → passed），delivery_checked=true → 客观项 passed/not_applicable
    const runOk = await mkRun('completed')
    const fixOk = await mkFixture(runOk)
    const rowOk = await readFinal(fixOk.finalId)
    const absOk = absPathOf(rowOk.relPath!)
    check(synth(absOk, 4), 'lavfi 合成真实成片 mp4（synthetic，非生产样片）')
    const measuredOk = probeMediaDuration(absOk) ?? 0
    const paramsOk = JSON.parse(rowOk.params ?? '{}') as Record<string, unknown>
    if (paramsOk.timeline && typeof paramsOk.timeline === 'object') (paramsOk.timeline as Record<string, unknown>).totalSec = measuredOk
    paramsOk.delivery_checked = true
    paramsOk.probe_marker = 'keep-me' // #8 缓存 merge 必须保留其余键
    const shaOk = createHash('sha256').update(fs.readFileSync(absOk)).digest('hex')
    await setFinal(fixOk.finalId, { sha256: shaOk, params: JSON.stringify(paramsOk), duration: measuredOk })

    const res = await qc.runQcCheck(runOk, { refreshCache: true })
    check(res.outcome === 'ok', '#1 端到端 runQcCheck 对成片产出结构化报告')
    if (res.outcome === 'ok') {
      const rep = res.report
      check(findCheck(rep.checks, 'file_readable')?.status === 'passed', '#1 真实成片 file_readable=passed')
      const ss = findCheck(rep.checks, 'stream_spec')!
      check(ss.status === 'passed' && typeof ss.value === 'string' && ss.value.includes('160x240'), '#1 stream_spec 记录容器/分辨率实测值（160x240）')
      check(findCheck(rep.checks, 'duration_vs_timeline')?.status === 'passed', '#1 实测时长与 params.timeline Σ 一致 → duration_vs_timeline=passed')
      const ap = findCheck(rep.checks, 'audio_peak')!
      check(ap.status !== 'failed' && (ap.status !== 'passed' || (ap.reason ?? '').includes('人工')), '#5 audio_peak 记录客观测量、失真判定留人工（面板不自动判过）')
      const df = findCheck(rep.checks, 'delivery_flag')!
      check(df.status === 'passed' && df.source === 'asset_params', '#5 delivery_flag 只读呈现 params.delivery_checked（不反写）')
      const audioPassed = ap.status === 'passed'
      check(rep.verdict === (audioPassed ? 'ready' : 'needs_review'), '#6 健康成片：音频可测→ready / 音频降级→needs_review（宁保守不误报）')
      check(rep.checks.some((c) => c.key === 'manual_quality_review' && c.status === 'not_tested') && rep.missing.includes('manual_quality_review'), '#5 主观人工复核恒 not_tested 并入 missing[]（第一期 §7.2 边界）')

      // #8 缓存 merge 保留其余键（零新列回归）
      const cachedParams = JSON.parse((await readFinal(fixOk.finalId)).params ?? '{}') as Record<string, unknown>
      check(cachedParams.probe_marker === 'keep-me' && !!cachedParams.timeline && !!cachedParams.qc, '#8 缓存写 params.qc 保留其余键（零新列，不破坏 timeline/marker）')

      // #8 成片 hash 变化 → 下次读取旧 local/offline 结论标 stale、ready 降级
      await setFinal(fixOk.finalId, { sha256: 'drifted-sha-not-real' })
      const staleRep = await qc.readQcCache(runOk)
      check(!!staleRep && staleRep.fromCache === true && staleRep.checks.some((c) => c.status === 'stale') && staleRep.verdict !== 'ready', '#8 成片 hash 变化 → 读缓存旧 local/offline 结论标 stale、ready 降级')

      // #6 needs_review：复位 sha、去 delivery_checked → delivery_flag not_tested → 无 failed → needs_review
      await setFinal(fixOk.finalId, { sha256: shaOk })
      const pNoDel = JSON.parse((await readFinal(fixOk.finalId)).params ?? '{}') as Record<string, unknown>
      delete pNoDel.delivery_checked
      delete pNoDel.qc
      await setFinal(fixOk.finalId, { params: JSON.stringify(pNoDel) })
      const resNr = await qc.runQcCheck(runOk, { refreshCache: false })
      check(resNr.outcome === 'ok' && resNr.report.verdict === 'needs_review' && findCheck(resNr.report.checks, 'delivery_flag')?.status === 'not_tested', '#6 缺 delivery_checked → verdict=needs_review（不把未核验说成可交付）')

      // #6 not_ready：声明总长造差 → duration failed → not_ready
      const pBad = JSON.parse((await readFinal(fixOk.finalId)).params ?? '{}') as Record<string, unknown>
      if (pBad.timeline && typeof pBad.timeline === 'object') (pBad.timeline as Record<string, unknown>).totalSec = measuredOk + 5
      await setFinal(fixOk.finalId, { params: JSON.stringify(pBad) })
      const resNrd = await qc.runQcCheck(runOk, { refreshCache: false })
      check(resNrd.outcome === 'ok' && resNrd.report.verdict === 'not_ready' && findCheck(resNrd.report.checks, 'duration_vs_timeline')?.status === 'failed', '#6 实测与声明严重不符 → duration failed → verdict=not_ready')

      // 门禁：无成片 → blocked no_final_video（草稿/空 run 诚实拒绝，不伪造报告）
      const runEmpty = await mkRun('completed')
      const resBlocked = await qc.runQcCheck(runEmpty, { refreshCache: false })
      check(resBlocked.outcome === 'blocked' && resBlocked.code === 'no_final_video', '#7 无可核验成片 → blocked no_final_video（门禁诚实）')
    }
  } else {
    // 无 ffmpeg/ffprobe：诚实降级——不伪造客观通过（工具缺失 → not_tested / 文件不可读 → failed，均绝不 ready）
    const runNo = await mkRun('completed')
    await mkFixture(runNo) // 有成片 DB 行但无真实文件 → 文件不可读 + 工具缺失，诚实降级
    const resNo = await qc.runQcCheck(runNo, { refreshCache: false })
    if (resNo.outcome === 'ok') {
      const ss = findCheck(resNo.report.checks, 'stream_spec')
      check(ss?.status === 'not_tested' || ss?.status === 'failed', '#7 工具缺失 → stream_spec 降级 not_tested/failed（不臆断通过）')
      check(resNo.report.verdict !== 'ready', '#7 工具缺失 → verdict≤needs_review（诚实缺项，绝不误 ready）')
    } else {
      check(resNo.outcome === 'blocked', '#7 工具缺失且文件不可读 → 门禁 blocked/no_final_video')
    }
  }

  /* ════════ #9 零付费不变量：全程本 project 零新增 gen_tasks / usage_records ════════ */
  const gt1 = (await db.select({ n: count() }).from(genTasks).where(eq(genTasks.projectId, projectId)))[0]?.n ?? 0
  const ur1 = (await db.select({ n: count() }).from(usageRecords).where(eq(usageRecords.projectId, projectId)))[0]?.n ?? 0
  check(gt0 === 0 && gt1 === 0 && ur0 === 0 && ur1 === 0, '#9 QC 全链路零 gen_tasks、零 usage_records（只读不变量守卫）')
}
