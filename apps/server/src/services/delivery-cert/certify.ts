/**
 * 第五期 · 交付包认证：只读编排 / verdict / 缓存 / 新鲜度（规格 2026-09-28 §5/§6/§7）。
 *
 * **只读编排 + 零新列缓存**：定位已生成的 `edit_exchange` 交付包 → 本地解压 → 逐格式解析（analyze）→ 结构良构 /
 * 内部时长数学 / 跨格式一致 / 媒体可定位 / 时轴绑定 / 字幕交付绑定 → `editor_import` 恒人工缺项 → 保守 verdict + missing[]
 * → merge 进该 export 资产 `params.cert`（镜像第四期 `recordQuality`，保留其余键）。不 import 引擎、不写业务表、
 * 不改 `buildEditExchange`/格式化器/批准链，零付费/零模型/零新依赖/零 IO 副作用（除 params.cert 缓存）。
 * **不为认证自动生成新包**（无包 → verdict=needs_package）；门禁不足 → 诚实 not_tested，绝不伪造通过（尤其不代答编辑器）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { unzipSync } from 'fflate'
import { db } from '../../db'
import { assets, pipelineRuns, type Asset } from '../../db/schema'
import { absPathOf } from '../storage'
import { listEditExchanges } from '../edit-exchange'
import { secToFrames } from '../edit-exchange/timecode'
import { parseTimeline } from '../qc/consistency'
import { analyzeProjectFile, type AnalyzedProjectFile } from './analyze'
import {
  CERT_DURATION_TOLERANCE_FRAMES,
  type CertCheck,
  type CertFormat,
  type CertRunResult,
  type CertVerdict,
  type DeliveryCert,
} from './types'

/** 决定交付可信的客观自动项（editor_import 恒人工，不在此列，见规格 §0.4）。 */
const OBJECTIVE_AUTO: CertCheck['key'][] = [
  'project_file_wellformed',
  'duration_math_consistent',
  'cross_format_consistency',
  'media_refs_resolvable',
  'timeline_source_bound',
  'subtitle_delivery_bound',
]

function jsonParams(a: Asset): Record<string, unknown> {
  if (!a.params) return {}
  try {
    const p = JSON.parse(a.params) as unknown
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 从 export 资产 params 取导出格式（buildEditExchange 写入）。 */
function fmtOfAsset(a: Asset): CertFormat | null {
  const f = jsonParams(a).format
  return f === 'fcpxml' || f === 'edl' || f === 'otio' ? f : null
}

interface UnzippedPackage {
  manifest: Record<string, unknown>
  projectText: string | null
  analyzed: AnalyzedProjectFile | null
  entryNames: Set<string>
  sha256: string | null
}

/** 解压 + 解析一次性交付包（任何 IO/解析异常 → null，绝不抛）。 */
function openPackage(a: Asset): UnzippedPackage | null {
  if (!a.relPath) return null
  const abs = absPathOf(a.relPath)
  if (!existsSync(abs)) return null
  let bytes: Buffer
  try {
    bytes = readFileSync(abs)
  } catch {
    return null
  }
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(bytes))
  } catch {
    return null
  }
  const entryNames = new Set(Object.keys(files))
  const mf = files['manifest.json']
  if (!mf) return null
  let manifest: Record<string, unknown>
  try {
    const parsed = JSON.parse(new TextDecoder().decode(mf)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    manifest = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const fmt = manifest.format
  const projectFile = typeof manifest.projectFile === 'string' ? manifest.projectFile : null
  const projEntry = projectFile ? files[projectFile] : undefined
  const projectText = projEntry ? new TextDecoder().decode(projEntry) : null
  const video = manifest.video as Record<string, unknown> | undefined
  const fpsHint = typeof video?.fps === 'number' ? video.fps : 25
  const analyzed = projectText !== null && (fmt === 'fcpxml' || fmt === 'edl' || fmt === 'otio') ? analyzeProjectFile(projectText, fmt, fpsHint) : null
  return { manifest, projectText, analyzed, entryNames, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** 定位本 run 当前最新成片（取 params.timeline 唯一真源做时轴绑定）。 */
async function locateFinal(runId: number): Promise<Asset | null> {
  const rows = await db
    .select()
    .from(assets)
    .where(eq(assets.runId, runId))
    .limit(1)
  void rows
  const finals = await db
    .select()
    .from(assets)
    .where(eq(assets.runId, runId))
  const final = finals.filter((a) => a.purpose === 'final_video' && a.kind === 'video' && !a.deletedAt).sort((x, y) => y.id - x.id)[0]
  return final ?? null
}

/** 时轴绑定：包内段数/总帧 vs 成片当前 params.timeline Σ（暴露「导出后时轴又改了但包未重生成」漂移）。 */
function timelineBoundCheck(analyzed: AnalyzedProjectFile, final: Asset | null): CertCheck {
  if (!final) {
    return { key: 'timeline_source_bound', status: 'not_tested', evidenceType: 'metadata', source: 'params.timeline', reason: '该 run 无成片资产可比对时轴真源' }
  }
  const timeline = parseTimeline(jsonParams(final))
  if (!timeline || (timeline.totalSec === null && timeline.segments.length === 0)) {
    return { key: 'timeline_source_bound', status: 'not_tested', evidenceType: 'metadata', source: 'params.timeline', reason: '成片无 params.timeline 快照（legacy/未落），不反推重建时轴（mp4↔timeline 新鲜度归第四期）' }
  }
  const declaredSec = timeline.totalSec ?? timeline.segments.reduce((s, x) => s + x.durSec, 0)
  const fps = analyzed.fps ?? 25
  const declaredFrames = secToFrames(declaredSec, fps)
  const problems: string[] = []
  if (analyzed.segmentCount !== null && analyzed.segmentCount !== timeline.segments.length) {
    problems.push(`段数 包=${analyzed.segmentCount} vs timeline=${timeline.segments.length}`)
  }
  if (analyzed.totalFrames !== null && Math.abs(analyzed.totalFrames - declaredFrames) > CERT_DURATION_TOLERANCE_FRAMES) {
    problems.push(`总帧 包=${analyzed.totalFrames} vs timeline=${declaredFrames}`)
  }
  if (problems.length > 0) {
    return { key: 'timeline_source_bound', status: 'failed', evidenceType: 'offline_probe', source: 'params.timeline', reason: `交付包与成片当前 params.timeline 不一致（导出后时轴又改了但包未重生成？）：${problems.join('；')}` }
  }
  return { key: 'timeline_source_bound', status: 'passed', evidenceType: 'offline_probe', source: 'params.timeline', value: `${analyzed.segmentCount ?? '?'} 段 / ${analyzed.totalFrames ?? '—'} 帧 与 timeline Σ ${declaredFrames} 帧一致` }
}

/** 字幕交付绑定：复用导出既有 manifest.subtitle.deliveryConsistent + sidecar 是否在包内。 */
function subtitleBoundCheck(manifest: Record<string, unknown>, entryNames: Set<string>): CertCheck {
  const sub = manifest.subtitle as Record<string, unknown> | undefined
  const sidecarFile = typeof sub?.sidecarFile === 'string' ? sub.sidecarFile : null
  if (!sub || sidecarFile === null) {
    return { key: 'subtitle_delivery_bound', status: 'not_applicable', evidenceType: 'offline_probe', source: 'manifest', reason: '该导出无可交付字幕 sidecar（无快照 cues 且无对白）' }
  }
  const consistent = sub.deliveryConsistent === true
  const present = entryNames.has(sidecarFile)
  if (!consistent) {
    return { key: 'subtitle_delivery_bound', status: 'failed', evidenceType: 'offline_probe', source: 'manifest', reason: 'manifest.subtitle.deliveryConsistent=false（sidecar 与快照声明 hash 不符或降级重建），不声称字幕交付一致' }
  }
  if (!present) {
    return { key: 'subtitle_delivery_bound', status: 'failed', evidenceType: 'offline_probe', source: 'zip', reason: `字幕 sidecar ${sidecarFile} 声明一致但不在包内` }
  }
  return { key: 'subtitle_delivery_bound', status: 'passed', evidenceType: 'offline_probe', source: 'manifest', value: sidecarFile }
}

/** 媒体可定位：include_media 时每条工程引用 + manifest mediaFile 均落包内 entry；否则 not_applicable。 */
function mediaResolvableCheck(analyzed: AnalyzedProjectFile | null, manifest: Record<string, unknown>, entryNames: Set<string>): CertCheck {
  if (manifest.includeMedia === false) {
    return { key: 'media_refs_resolvable', status: 'not_applicable', evidenceType: 'local_measurement', source: 'media_fs', reason: 'include_media=false：仅出工程 + manifest，媒体需按 manifest relPath 自行归位' }
  }
  const manifestMedia = Array.isArray(manifest.media) ? (manifest.media as Array<Record<string, unknown>>) : []
  const danglingManifest = manifestMedia.map((m) => (typeof m.mediaFile === 'string' ? m.mediaFile : '')).filter((p) => p && !entryNames.has(p))
  const refs = analyzed?.mediaRefs ?? []
  const danglingProj = refs.filter((p) => !entryNames.has(p))
  const dangling = [...new Set([...danglingManifest, ...danglingProj])]
  if (dangling.length > 0) {
    return { key: 'media_refs_resolvable', status: 'failed', evidenceType: 'local_measurement', source: 'media_fs', reason: `媒体引用悬空（编辑器将找不到素材）：${dangling.slice(0, 5).join(', ')}${dangling.length > 5 ? ` 等 ${dangling.length} 项` : ''}` }
  }
  return { key: 'media_refs_resolvable', status: 'passed', evidenceType: 'local_measurement', source: 'media_fs', value: `${manifestMedia.length} 条 manifest 媒体 + ${refs.length} 条工程引用均可定位` }
}

/** 跨格式一致性：同 run 多格式包共享事实（段数 / 总帧，仅比双方非空者）须一致；单格式 → not_applicable。 */
function crossFormatCheck(pkgs: Map<CertFormat, UnzippedPackage | null>, targetFmt: CertFormat, target: AnalyzedProjectFile | null): CertCheck {
  if (!target) return { key: 'cross_format_consistency', status: 'not_tested', evidenceType: 'offline_probe', source: 'project_file', reason: '目标包不可解析' }
  const others = [...pkgs.entries()].filter(([f, u]) => f !== targetFmt && u?.analyzed)
  if (others.length === 0) {
    return { key: 'cross_format_consistency', status: 'not_applicable', evidenceType: 'offline_probe', source: 'project_file', reason: '该 run 仅单格式交付包，无跨格式可比' }
  }
  const diffs: string[] = []
  for (const [f, u] of others) {
    const a = u!.analyzed!
    if (target.segmentCount !== null && a.segmentCount !== null && target.segmentCount !== a.segmentCount) diffs.push(`段数 ${targetFmt}=${target.segmentCount} vs ${f}=${a.segmentCount}`)
    if (target.totalFrames !== null && a.totalFrames !== null && Math.abs(target.totalFrames - a.totalFrames) > CERT_DURATION_TOLERANCE_FRAMES) diffs.push(`总帧 ${targetFmt}=${target.totalFrames} vs ${f}=${a.totalFrames}`)
  }
  if (diffs.length > 0) {
    return { key: 'cross_format_consistency', status: 'failed', evidenceType: 'offline_probe', source: 'project_file', reason: `多格式包事实不一致：${diffs.join('；')}` }
  }
  return { key: 'cross_format_consistency', status: 'passed', evidenceType: 'offline_probe', source: 'project_file', value: `${others.length + 1} 格式一致` }
}

/** 保守 verdict + missing（editor_import 恒缺 → 正常包实际至多 needs_attention，package_sound 为保留语义位、实际不达）。 */
function decide(checks: CertCheck[], packageBroken: boolean): { verdict: CertVerdict; missing: string[] } {
  const byKey = new Map(checks.map((c) => [c.key, c]))
  const missing: string[] = []
  let anyFailedOrStale = packageBroken
  let anyUnclean = false
  for (const key of OBJECTIVE_AUTO) {
    const c = byKey.get(key)
    if (!c || c.status === 'not_applicable') continue
    if (c.status === 'failed' || c.status === 'stale') {
      anyFailedOrStale = true
      missing.push(key)
    } else if (c.status !== 'passed') {
      anyUnclean = true
      missing.push(key)
    }
  }
  missing.push('editor_import_certified')
  const verdict: CertVerdict = anyFailedOrStale ? 'package_broken' : anyUnclean ? 'needs_attention' : 'package_sound'
  return { verdict, missing }
}

/** 运行一次交付包认证（默认按需重算并刷新缓存）。 */
export async function runDeliveryCert(runId: number, opts: { format?: CertFormat; refreshCache?: boolean } = {}): Promise<CertRunResult> {
  const runRows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
  const run = runRows[0]
  if (!run) return { outcome: 'blocked', code: 'run_not_found', message: `运行 ${runId} 不存在` }

  const packages = await listEditExchanges(runId)
  const fmt = opts.format ?? null

  // 每个 format 取最近一包（packages 已按 createdAt desc）
  const byFormat = new Map<CertFormat, Asset>()
  for (const p of packages) {
    const f = fmtOfAsset(p)
    if (f && !byFormat.has(f)) byFormat.set(f, p)
  }
  const target = (fmt ? byFormat.get(fmt) : undefined) ?? packages[0] ?? null

  // 无已生成包 → needs_package（不为认证造包）
  if (!target) {
    const checks: CertCheck[] = [
      { key: 'package_present', status: 'not_tested', evidenceType: 'metadata', source: 'zip', reason: `该 run 尚无 ${fmt ?? '任何'} edit_exchange 交付包；请先在导出面板生成后再认证` },
      { key: 'editor_import_certified', status: 'not_tested', evidenceType: 'manual_review', source: 'manual', reason: '需人工在真实 NLE（剪映/DaVinci/Premiere/FCP/Avid）导入实测，产品不代答' },
    ]
    const cert: DeliveryCert = { runId, packageAssetId: null, format: fmt ?? 'otio', checkedAt: Date.now(), packageSha256: null, verdict: 'needs_package', missing: ['package_present', 'editor_import_certified'], checks }
    return { outcome: 'ok', cert }
  }

  const targetFmt = fmtOfAsset(target) ?? fmt ?? 'otio'
  const opened = openPackage(target)

  // 包行在但文件缺失/不可解压 → package_broken（诚实，不伪造）
  if (!opened || !opened.analyzed) {
    const checks: CertCheck[] = [
      { key: 'package_present', status: 'failed', evidenceType: 'metadata', source: 'zip', reason: '交付包资产记录存在但 zip 缺失/不可解压/缺 manifest' },
      { key: 'project_file_wellformed', status: 'not_tested', evidenceType: 'offline_probe', source: 'project_file', reason: '包不可解压，跳过工程文件解析' },
      { key: 'editor_import_certified', status: 'not_tested', evidenceType: 'manual_review', source: 'manual', reason: '需人工真实 NLE 导入实测，产品不代答' },
    ]
    const { verdict, missing } = decide(checks, true)
    const cert: DeliveryCert = { runId, packageAssetId: target.id, format: targetFmt, checkedAt: Date.now(), packageSha256: opened?.sha256 ?? null, verdict, missing, checks }
    if (opts.refreshCache !== false) await writeCertCache(target, cert)
    return { outcome: 'ok', cert }
  }

  const analyzed = opened.analyzed
  // 跨格式：解开其它 format 各一包做事实比对
  const crossPkgs = new Map<CertFormat, UnzippedPackage | null>()
  for (const [f, a] of byFormat) if (f !== targetFmt) crossPkgs.set(f, openPackage(a))

  const final = await locateFinal(runId)
  const checks: CertCheck[] = [
    { key: 'package_present', status: 'passed', evidenceType: 'metadata', source: 'zip', value: opened.entryNames.size },
    analyzed.wellformed
      ? { key: 'project_file_wellformed', status: 'passed', evidenceType: 'offline_probe', source: 'project_file', value: `${targetFmt} 结构良构` }
      : { key: 'project_file_wellformed', status: 'failed', evidenceType: 'offline_probe', source: 'project_file', reason: analyzed.reason ?? '工程文件结构不良' },
    analyzed.overflowCount + analyzed.orderingViolationCount + analyzed.durationMismatchCount === 0
      ? { key: 'duration_math_consistent', status: 'passed', evidenceType: 'offline_probe', source: 'project_file', value: `段=${analyzed.segmentCount ?? '?'} 总帧=${analyzed.totalFrames ?? '—'}` }
      : { key: 'duration_math_consistent', status: 'failed', evidenceType: 'offline_probe', source: 'project_file', reason: `时轴数学不自洽：越界 ${analyzed.overflowCount} / 乱序 ${analyzed.orderingViolationCount} / 时长不符 ${analyzed.durationMismatchCount}` },
    crossFormatCheck(crossPkgs, targetFmt, analyzed),
    mediaResolvableCheck(analyzed, opened.manifest, opened.entryNames),
    timelineBoundCheck(analyzed, final),
    subtitleBoundCheck(opened.manifest, opened.entryNames),
    { key: 'editor_import_certified', status: 'not_tested', evidenceType: 'manual_review', source: 'manual', reason: '真实 NLE 导入认证属外部人工步骤（本机 Windows、FCPXML 属 macOS），产品不代答、永不自动通过' },
  ]

  const { verdict, missing } = decide(checks, false)
  const cert: DeliveryCert = { runId, packageAssetId: target.id, format: targetFmt, checkedAt: Date.now(), packageSha256: opened.sha256, verdict, missing, checks }
  if (opts.refreshCache !== false) await writeCertCache(target, cert)
  return { outcome: 'ok', cert }
}

/** merge 进 export 资产 params.cert（零新列，保留其余键；镜像第四期 recordQuality）。 */
async function writeCertCache(pkg: Asset, cert: DeliveryCert): Promise<void> {
  const params = jsonParams(pkg)
  params.cert = cert
  await db.update(assets).set({ params: JSON.stringify(params), updatedAt: Date.now() }).where(eq(assets.id, pkg.id))
}

/** 读缓存报告（refresh=0 优先命中，并做新鲜度判定：zip hash 变 → 旧 offline/local 结论标 stale）。 */
export async function readCertCache(runId: number, format?: CertFormat): Promise<DeliveryCert | null> {
  const packages = await listEditExchanges(runId)
  const byFormat = new Map<CertFormat, Asset>()
  for (const p of packages) {
    const f = fmtOfAsset(p)
    if (f && !byFormat.has(f)) byFormat.set(f, p)
  }
  const target = (format ? byFormat.get(format) : undefined) ?? packages[0] ?? null
  if (!target) return null
  const cached = jsonParams(target).cert
  if (!cached || typeof cached !== 'object' || Array.isArray(cached)) return null
  const cert = cached as DeliveryCert
  const currentSha = target && existsSync(absPathOf(target.relPath ?? '')) ? createHash('sha256').update(readFileSync(absPathOf(target.relPath!))).digest('hex') : null
  if (cert.packageSha256 !== null && currentSha !== null && cert.packageSha256 !== currentSha) {
    for (const c of cert.checks) {
      if (c.status === 'passed' && (c.evidenceType === 'local_measurement' || c.evidenceType === 'offline_probe')) {
        c.status = 'stale'
        c.reason = '缓存基准与当前交付包 hash 不一致，结论待重算'
      }
    }
    if (cert.verdict === 'package_sound') cert.verdict = 'needs_attention'
  }
  return { ...cert, fromCache: true }
}
