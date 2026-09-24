/**
 * [M50] 剪辑工程交换导出组装层：解析时间轴真源 → 选定格式化器渲染 → zip 打包为 archive 资产。
 * 交付物（§决策 4）：`{name}.{ext}`（工程）+ `manifest.json`（assetId↔媒体文件名↔原相对路径 + 降级声明）
 *   + `media/`（include_media 时复制引用资产，store 不压缩）。下载复用 GET /assets/:id/file?download=1。
 * 单一真源：时间轴取自 params.timeline（stored）或 planBestEffortTimeline 兜底（recomputed），零重算漂移。
 */
import { createReadStream, createWriteStream, existsSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { Zip, ZipPassThrough } from 'fflate'
import { db } from '../../db'
import { assets, pipelineRuns, projects, type Asset } from '../../db/schema'
import { createLogger } from '../../logger'
import { absPathOf, ensureProjectDirs, registerAsset, sanitizeName } from '../storage'
import { resolveEditTimeline, EditExchangeError, type ResolvedTimeline } from './timeline-source'
import { makeCtx, type FormatCtx } from './render-context'
import { toFcpxml } from './fcpxml'
import { toEdl } from './edl'
import { renderOtio } from './otio'
import type { EditTimeline } from '../../pipeline/actions/ffmpeg-merge/timeline-snapshot'

export { EditExchangeError } from './timeline-source'
export type { EditExchangeErrorCode } from './timeline-source'

const log = createLogger('edit-exchange')

export type EditExchangeFormat = 'fcpxml' | 'edl' | 'otio'
const FORMATS: EditExchangeFormat[] = ['fcpxml', 'edl', 'otio']
const EXT: Record<EditExchangeFormat, string> = { fcpxml: 'fcpxml', edl: 'edl', otio: 'otio' }

export function isEditExchangeFormat(v: unknown): v is EditExchangeFormat {
  return typeof v === 'string' && (FORMATS as string[]).includes(v)
}

interface MediaRef {
  relPath: string
  assetId: number | null
  role: 'video' | 'dialogue' | 'bgm' | 'sfx'
}

/** 时间轴引用到的全部媒体（按 relPath 去重；首现者持 assetId/role） */
function collectMedia(tl: EditTimeline): MediaRef[] {
  const seen = new Set<string>()
  const out: MediaRef[] = []
  const push = (relPath: string | null, assetId: number | null, role: MediaRef['role']): void => {
    if (!relPath || seen.has(relPath)) return
    seen.add(relPath)
    out.push({ relPath, assetId, role })
  }
  for (const s of tl.segments) push(s.relPath, s.assetId, 'video')
  for (const l of tl.lines) push(l.relPath, l.assetId, 'dialogue')
  if (tl.bgm) push(tl.bgm.relPath, tl.bgm.assetId, 'bgm')
  for (const s of tl.sfx) push(s.relPath, s.assetId, 'sfx')
  return out
}

/** 为媒体分配包内唯一文件名（media/<n>-<basename>），返回 relPath→文件名映射与清单 */
function planNaming(media: MediaRef[]): { nameOf: (relPath: string) => string; manifest: Array<{ assetId: number | null; mediaFile: string; relPath: string; role: string }> } {
  const used = new Set<string>()
  const byRel = new Map<string, string>()
  const manifest: Array<{ assetId: number | null; mediaFile: string; relPath: string; role: string }> = []
  for (const m of media) {
    const base = m.relPath.split(/[\\/]/).pop() ?? 'file'
    let name = `media/${base}`
    let i = 1
    while (used.has(name)) name = `media/${i++}-${base}`
    used.add(name)
    byRel.set(m.relPath, name)
    manifest.push({ assetId: m.assetId, mediaFile: name, relPath: m.relPath, role: m.role })
  }
  return { nameOf: (rel) => byRel.get(rel) ?? `media/${rel.split(/[\\/]/).pop()}`, manifest }
}

function renderProject(format: EditExchangeFormat, tl: EditTimeline, ctx: FormatCtx): string {
  if (format === 'fcpxml') return toFcpxml(tl, ctx)
  if (format === 'edl') return toEdl(tl, ctx)
  return renderOtio(tl, ctx)
}

/** 各格式能力/降级声明（写入 manifest + README） */
function formatNotes(format: EditExchangeFormat, tl: EditTimeline): string[] {
  const notes: string[] = []
  if (format === 'edl') {
    notes.push('EDL(CMX3600) 仅承载 V 镜头序列 + AA 旁白轨；字幕/SFX/BGM 不分层（EDL 语义上限），请改用 FCPXML/OTIO 获取全部分轨。')
    notes.push('Premiere 不解析 FCPXML，故用 EDL；转场以 Dissolve(D) 事件表达。')
  }
  if (format === 'fcpxml') {
    notes.push('FCPXML 1.10：V1 镜头 + 对白/BGM/SFX 独立 spine + 逐句 title 字幕；剪映支持随版本漂移，以实际版本实测。')
  }
  if (format === 'otio') notes.push('OTIO JSON：Video/Dialogue Audio/Music/Effects/Markdown 五轨，RationalTime 帧精度。')
  if (!tl.lines.some((l) => l.relPath)) notes.push('本成片无独立逐句配音轨（如原声对白/无 TTS），对白与字幕轨按现有数据导出。')
  if (tl.sfx.length === 0) notes.push('无逐镜 SFX（或存量成片未含 SFX 起点），Effects/SFX 轨留空。')
  return notes
}

export interface BuildResult {
  asset: Asset
  timelineSource: 'stored' | 'recomputed'
  format: EditExchangeFormat
}

/** 生成剪辑工程交换包（zip 资产） */
export async function buildEditExchange(p: { runId: number; format: unknown; includeMedia?: boolean }): Promise<BuildResult> {
  if (!isEditExchangeFormat(p.format)) {
    throw new EditExchangeError('bad_format', `format 需为 ${FORMATS.join('/')} 之一`)
  }
  const format = p.format
  const includeMedia = p.includeMedia !== false

  const run = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, p.runId)).limit(1))[0]
  if (!run) throw new EditExchangeError('no_final_video', `run ${p.runId} 不存在`)
  const project = (await db.select().from(projects).where(eq(projects.id, run.projectId)).limit(1))[0]

  const resolved: ResolvedTimeline = await resolveEditTimeline(p.runId)
  const tl = resolved.timeline
  const media = collectMedia(tl)
  const { nameOf, manifest: mediaManifest } = planNaming(media)
  const ctx = makeCtx(`${project?.name ?? `project${run.projectId}`}_${run.templateKey}_run${run.id}`, nameOf)

  const pkgName = sanitizeName(`${project?.name ?? 'project'}_${run.templateKey}_run${run.id}_${format}`)
  const projectFileName = `${pkgName}.${EXT[format]}`
  const notes = formatNotes(format, tl)
  const projectText = renderProject(format, tl, ctx)

  const manifest = {
    version: 1,
    kind: 'edit_exchange',
    generatedAt: Date.now(),
    run: { id: run.id, projectId: run.projectId, templateKey: run.templateKey },
    project: { name: project?.name ?? '' },
    format,
    timelineSource: resolved.source,
    includeMedia,
    video: { fps: tl.fps, width: tl.width, height: tl.height, totalSec: tl.totalSec, introSec: tl.introSec, outroSec: tl.outroSec },
    transition: tl.transition,
    watermark: tl.watermark,
    subtitleRef: tl.subtitle?.relPath ?? null,
    projectFile: projectFileName,
    media: mediaManifest,
    notes,
  }
  const readme = buildReadme(format, resolved.source, tl, notes)

  // 落盘 zip（store 不压缩；唯一不可变命名，绝不覆盖历史）
  ensureProjectDirs(run.projectId)
  const dirRel = join(String(run.projectId), 'exports')
  const stamp = Date.now()
  let relPath = join(dirRel, `${pkgName}__run${run.id}__${stamp}.zip`)
  for (let n = 1; existsSync(absPathOf(relPath)); n++) relPath = join(dirRel, `${pkgName}__run${run.id}__${stamp}-${n}.zip`)
  const absFinal = absPathOf(relPath)
  const absTmp = `${absFinal}.tmp-${stamp}-${process.pid}`

  const encoder = new TextEncoder()
  const textEntries: Array<{ path: string; data: Uint8Array }> = [
    { path: 'manifest.json', data: encoder.encode(JSON.stringify(manifest, null, 2)) },
    { path: projectFileName, data: encoder.encode(projectText) },
    { path: 'README.txt', data: encoder.encode(readme) },
  ]
  const fileEntries: Array<{ path: string; abs: string }> = includeMedia
    ? media.filter((m) => existsSync(absPathOf(m.relPath))).map((m) => ({ path: nameOf(m.relPath), abs: absPathOf(m.relPath) }))
    : []
  await writeZip(absTmp, textEntries, fileEntries)
  renameSync(absTmp, absFinal)
  const fileSize = statSync(absFinal).size
  log.info(`剪辑工程包生成: ${pkgName}.zip（${format}, ${resolved.source}, ${fileEntries.length} 媒体, ${fileSize} bytes）`)

  const asset = await registerAsset(run.projectId, {
    runId: run.id,
    kind: 'archive',
    purpose: 'edit_exchange',
    name: `${pkgName}.zip`,
    relPath,
    mime: 'application/zip',
    ext: 'zip',
    fileSize,
    params: { runId: run.id, format, timelineSource: resolved.source, includeMedia, mediaCount: fileEntries.length, totalSec: tl.totalSec, fps: tl.fps },
  })
  return { asset, timelineSource: resolved.source, format }
}

function buildReadme(format: EditExchangeFormat, source: string, tl: EditTimeline, notes: string[]): string {
  const lines = [
    `剪辑工程交换包（M50）`,
    `格式: ${format}   时间轴来源: ${source}`,
    `画幅: ${tl.width}x${tl.height} @ ${tl.fps}fps   总时长: ${tl.totalSec}s（片头 ${tl.introSec}s / 片尾 ${tl.outroSec}s）`,
    `轨道: V1 镜头 ${tl.segments.length} 段 / 配音 ${tl.lines.filter((l) => l.relPath).length} 句 / SFX ${tl.sfx.length} 条 / BGM ${tl.bgm ? 1 : 0}`,
    '',
    '兼容矩阵:',
    '  FCPXML  → 剪映专业版 / Final Cut Pro / DaVinci Resolve（剪映支持随版本漂移，以实际版本实测）',
    '  EDL     → Premiere / Avid（Premiere 不吃 FCPXML，故用 EDL）',
    '  OTIO    → DaVinci Resolve / 程序化管线（otio-python 等）',
    '',
    '说明:',
    ...notes.map((n) => `  - ${n}`),
    '',
    '媒体引用: 工程文件内媒体路径为包内相对路径 media/...；include_media=false 时仅出工程 + manifest，媒体需自行按 manifest 的 relPath 归位。',
  ]
  return lines.join('\n') + '\n'
}

/** fflate 流式 zip（store 不压缩；文本 entry 直写 + 文件 entry 流式拷贝；失败清理临时文件） */
function writeZip(absPath: string, textEntries: Array<{ path: string; data: Uint8Array }>, fileEntries: Array<{ path: string; abs: string }>): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(absPath)
    out.on('error', reject)
    out.on('close', () => resolve())
    const zip = new Zip((err, chunk, final) => {
      if (err) return reject(err)
      out.write(Buffer.from(chunk))
      if (final) out.end()
    })
    void (async () => {
      for (const e of textEntries) {
        const entry = new ZipPassThrough(e.path)
        zip.add(entry)
        entry.push(e.data, true)
      }
      for (const f of fileEntries) {
        const entry = new ZipPassThrough(f.path)
        zip.add(entry)
        const rs = createReadStream(f.abs)
        try {
          await new Promise<void>((res, rej) => {
            rs.on('data', (c) => entry.push(c as Uint8Array, false))
            rs.on('end', () => res())
            rs.on('error', rej)
          })
          entry.push(new Uint8Array(0), true)
        } finally {
          rs.close()
        }
      }
      zip.end()
    })().catch((err) => {
      reject(err)
      out.destroy()
    })
  })
}

/** GET /edit-exchange/formats 能力探测（不渲染；成片存在=全开，无 timeline 且不可重算=置灰带提示） */
export async function probeEditExchange(runId: number): Promise<{
  final_video: boolean
  timeline_source: 'stored' | 'recomputed' | null
  available: boolean
  formats: Array<{ format: EditExchangeFormat; enabled: boolean }>
  reason?: string
}> {
  const has = (await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.runId, runId), eq(assets.purpose, 'final_video'), isNull(assets.deletedAt)))
    .limit(1))[0]
  if (!has) {
    return { final_video: false, timeline_source: null, available: false, formats: FORMATS.map((f) => ({ format: f, enabled: false })), reason: 'no_final_video' }
  }
  try {
    const { source } = await resolveEditTimeline(runId)
    return { final_video: true, timeline_source: source, available: true, formats: FORMATS.map((f) => ({ format: f, enabled: true })) }
  } catch (err) {
    const reason = err instanceof EditExchangeError ? err.code : 'no_timeline'
    return { final_video: true, timeline_source: null, available: false, formats: FORMATS.map((f) => ({ format: f, enabled: false })), reason }
  }
}

/** 列出某 run 的剪辑工程导出包（purpose=edit_exchange） */
export async function listEditExchanges(runId: number): Promise<Asset[]> {
  return db
    .select()
    .from(assets)
    .where(and(eq(assets.runId, runId), eq(assets.purpose, 'edit_exchange'), eq(assets.kind, 'archive'), isNull(assets.deletedAt)))
    .orderBy(desc(assets.createdAt))
    .limit(50)
}
