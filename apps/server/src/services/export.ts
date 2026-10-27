/**
 * 导出分发服务（E3；spec §5 + §E）
 * - 发布包 zip（store 不压缩）+ manifest.json 首 entry（包内路径为准）
 * - 任何状态的 run 均可导出已有产物；串行流式写，失败清理临时文件
 * - M66 合规打标：开启态发布包内音视频/图像为打标副本（非破坏性，工作区原件不动）+ AI生成内容说明.txt
 */
import { createReadStream, createWriteStream, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { Zip, ZipPassThrough } from 'fflate'
import { db } from '../db'
import { assets, pipelineRuns, pipelineSteps, projects, type Asset } from '../db/schema'
import { createLogger } from '../logger'
import { resolveBrandConfig } from './brand-config'
import { aigcMetadata, insertJpegApp1, insertPngText, remuxMediaMetaToFile } from './compliance-label'
import { resolveFfmpeg } from './ffmpeg'
import { absPathOf, ensureProjectDirs, registerAsset, sanitizeName } from './storage'
import { complianceDrawtextFilter } from '../pipeline/actions/ffmpeg-merge/compliance'
import { resolveCjkFont } from '../pipeline/actions/ffmpeg-merge/title-card'

const log = createLogger('export')

/** M66 声明文件包内路径（开启态才入包） */
const DECLARATION_NAME = 'AI生成内容说明.txt'

export class ExportError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ExportError'
  }
}

/** role 映射（spec §5.1；按序首配）：final_video→video/main_video；thumbnail→cover/cover；
 *  kind=text→text/copy（含 subtitle）；kind=video→video/other；其余→other/other */
export function roleOfAsset(a: { kind: string; purpose: string | null }): {
  role: 'main_video' | 'cover' | 'copy' | 'other'
  dir: 'video' | 'cover' | 'text' | 'other'
} {
  if (a.purpose === 'final_video') return { role: 'main_video', dir: 'video' }
  if (a.purpose === 'thumbnail') return { role: 'cover', dir: 'cover' }
  if (a.kind === 'text') return { role: 'copy', dir: 'text' }
  if (a.kind === 'video') return { role: 'other', dir: 'video' }
  return { role: 'other', dir: 'other' }
}

/** 聚合 run 全部产物（steps.output.asset_ids 去重；排除已删除） */
export async function collectRunAssets(runId: number): Promise<Asset[]> {
  const steps = await db
    .select({ output: pipelineSteps.output })
    .from(pipelineSteps)
    .where(eq(pipelineSteps.runId, runId))
  const ids = new Set<number>()
  for (const s of steps) {
    if (!s.output) continue
    try {
      const doc = JSON.parse(s.output) as { asset_ids?: unknown }
      if (Array.isArray(doc.asset_ids)) for (const id of doc.asset_ids) if (typeof id === 'number') ids.add(id)
    } catch {
      // 损坏 output 跳过
    }
  }
  if (ids.size === 0) return []
  const rows = await db
    .select()
    .from(assets)
    .where(and(inArray(assets.id, [...ids]), isNull(assets.deletedAt)))
  return rows.sort((a, b) => a.id - b.id)
}

/** 生成发布包（zip + manifest）：assetIds 缺省=全量；显式数组=勾选（空数组→no_assets）；串行流式写 */
export async function buildRunExport(p: { runId: number; name?: string; assetIds?: number[] | null }): Promise<Asset> {
  const run = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, p.runId)).limit(1))[0]
  if (!run) throw new ExportError('no_run', `run ${p.runId} 不存在`)
  const project = (await db.select().from(projects).where(eq(projects.id, run.projectId)).limit(1))[0]
  const all = await collectRunAssets(p.runId)
  let picked = all
  if (p.assetIds) {
    if (p.assetIds.length === 0) throw new ExportError('no_assets', 'asset_ids 为空数组（如需全量请省略该字段）')
    const wanted = new Set(p.assetIds)
    const missing = p.assetIds.filter((id) => !all.some((a) => a.id === id))
    if (missing.length) throw new ExportError('asset_not_in_run', `资产不属于该 run 或无产物: ${missing.join(', ')}`)
    picked = all.filter((a) => wanted.has(a.id))
  }
  if (picked.length === 0) throw new ExportError('no_assets', '该 run 无可用产物（steps.output 为空）')
  // 文件可读性预检（缺文件 → 400 含明细，不带半成品包）
  for (const a of picked) {
    if (!a.relPath) throw new ExportError('asset_no_file', `资产 ${a.id}（${a.name}）无本地文件`)
    try {
      statSync(absPathOf(a.relPath))
    } catch {
      throw new ExportError('asset_file_missing', `资产 ${a.id}（${a.name}）文件缺失: ${a.relPath}`)
    }
  }
  // 包内路径（role 目录 + 重名 -1/-2 后缀；manifest.path 为准）；srcAbs = 打标副本来源（缺省读工作区原件）
  const used = new Set<string>()
  const entries: Array<{ a: Asset; path: string; srcAbs?: string }> = picked.map((a) => {
    const { dir } = roleOfAsset(a)
    const base = sanitizeName(a.name)
    let path = `${dir}/${base}`
    let i = 1
    while (used.has(path)) {
      const dot = base.lastIndexOf('.')
      const stem = dot > 0 ? base.slice(0, dot) : base
      const ext = dot > 0 ? base.slice(dot) : ''
      path = `${dir}/${stem}-${i}${ext}`
      i += 1
    }
    used.add(path)
    return { a, path }
  })
  const fallback = `${project?.name ?? `project${run.projectId}`}_${run.templateKey}_run${run.id}`
  const pkgName = (p.name ?? '').trim() || fallback
  const zipName = `${pkgName}.zip`
  // [F05] 交付包唯一不可变身份：存储路径带 run id + 时间戳 + 去重后缀，绝不覆盖历史包；
  // 显示名仍为 zipName（下载文件名不变），每条 archive 资产指向各自独立、字节稳定的文件
  const dirRel = join(String(run.projectId), 'exports')
  const base = sanitizeName(pkgName)
  const stamp = Date.now()
  let relPath = join(dirRel, `${base}__run${run.id}__${stamp}.zip`)
  for (let n = 1; existsSync(absPathOf(relPath)); n++) {
    relPath = join(dirRel, `${base}__run${run.id}__${stamp}-${n}.zip`)
  }
  const absFinal = absPathOf(relPath)
  const absTmp = `${absFinal}.tmp-${stamp}-${process.pid}`
  // M66 发布包合规打标：图像 drawtext 打标副本（重编码单帧）+ 音视频 -c copy 重封装（含 PropagateID）。
  // 非破坏性：打标产物写独立临时目录，绝不覆盖工作区原件；关闭/不支持/失败回落原文件 + warn
  const brand = await resolveBrandConfig(run.projectId, run.input)
  const compliance = brand.compliance ?? null
  const propagateId = compliance?.enabled ? randomUUID() : ''
  const labelTempDir = compliance?.enabled ? mkdtempSync(join(tmpdir(), 'acs-export-aigc-')) : null
  const labeledTemps: string[] = []
  const exportMeta = new Map<number, { produceId: string | null; propagateId: string; labeled: boolean }>()
  let declaration: string | null = null
  try {
    if (compliance?.enabled && labelTempDir) {
      const ffmpeg = resolveFfmpeg()
      const fontAbs = resolveCjkFont()
      const lines: string[] = [
        '本发布包含有人工智能生成合成内容（依据《人工智能生成合成内容标识办法》标识）。',
        `生成主体：${compliance.producer}`,
        `导出时间：${new Date().toISOString()}`,
        '清单：',
      ]
      for (const e of entries) {
        const { a, path } = e
        const labelable = a.kind === 'image' || a.kind === 'video' || a.kind === 'audio'
        const genProduceId = readAigcProduceId(a)
        const srcAbs = absPathOf(a.relPath!)
        let labeledAbs: string | null = null
        let labelProduceId: string | null = null
        try {
          // 图像仅 png/jpg/jpeg 重编码打标（动图等其他格式 -frames:v 1 会毁帧 → 回落原文件）
          if (ffmpeg && a.kind === 'image' && fontAbs && (a.ext === 'png' || a.ext === 'jpg' || a.ext === 'jpeg')) {
            const { json, produceId } = aigcMetadata({ producer: compliance.producer, contentPropagator: compliance.producer, propagateId, produceId: genProduceId ?? undefined })
            const out = join(labelTempDir, `labeled-${a.id}.${a.ext}`)
            const enc = a.ext === 'jpg' || a.ext === 'jpeg' ? ['-q:v', '2'] : []
            const r = spawnSync(
              ffmpeg,
              [
                '-y', '-i', srcAbs,
                '-vf', complianceDrawtextFilter({ text: compliance.text, position: compliance.position, margin_px: compliance.margin_px, fontAbs }, a.height ?? 720),
                ...enc, '-frames:v', '1', '-metadata', `AIGC=${json}`, out,
              ],
              { stdio: 'ignore', timeout: 60_000, windowsHide: true },
            )
            if (!r.error && r.status === 0 && existsSync(out)) {
              // png/jpeg muxer 丢弃 -metadata 且重编码剥离生成期 tEXt/APP1 → 编码成功后用纯 Node
              // 段插入（insertPngText/insertJpegApp1）把同一 metaJson 写回副本文件；
              // 插入失败保留角标副本（显式标识仍在）照常打标，仅 warn
              try {
                const bytes = readFileSync(out)
                const embedded = a.ext === 'png' ? insertPngText(bytes, json) : insertJpegApp1(bytes, json)
                if (embedded) writeFileSync(out, embedded)
                else log.warn(`发布包图像副本内嵌标识插入失败，保留角标副本: 资产 #${a.id}（${path}）`)
              } catch (err) {
                log.warn(`发布包图像副本内嵌标识插入异常，保留角标副本: 资产 #${a.id}（${path}）→ ${(err as Error).message}`)
              }
              e.srcAbs = out; labeledAbs = out; labelProduceId = produceId
            }
          } else if (ffmpeg && (a.kind === 'video' || a.kind === 'audio')) {
            const { json, produceId } = aigcMetadata({ producer: compliance.producer, contentPropagator: compliance.producer, propagateId, produceId: genProduceId ?? undefined })
            const out = join(labelTempDir, `labeled-${a.id}.${a.ext ?? 'mp4'}`)
            if (await remuxMediaMetaToFile(srcAbs, a.ext ?? 'mp4', json, out)) { e.srcAbs = out; labeledAbs = out; labelProduceId = produceId }
          }
        } catch { /* 打标失败 → 回落原文件 */ }
        if (labeledAbs) labeledTemps.push(labeledAbs)
        else if (labelable) log.warn(`发布包打标失败，回落原文件: 资产 #${a.id}（${path}）`)
        // ProduceID 一致性：打标成功 → 声明清单与内嵌元数据同源（生成期透传；M66 前旧资产 → 本次打标新 UUID）；
        // 打标失败/未打标（文本等）→ 保留生成期记录可读，否则「未登记」。
        // M66：非媒体条目（text/archive 等）无载体可嵌 → 不入逐文件 aigc 键与声明清单行（container 级 compliance 记录与文件头行不受影响）
        const produceId = labelProduceId ?? genProduceId
        if (labelable) {
          exportMeta.set(a.id, { produceId, propagateId, labeled: labeledAbs !== null })
          lines.push(`- ${path}（ProduceID: ${produceId ?? '未登记'}；PropagateID: ${propagateId}）`)
        }
      }
      declaration = lines.join('\n')
    }
    // M66：打标条目指纹预取（流式哈希副本最终字节，不整读入内存；读取失败回落原件指纹）
    const copyFingerprints = new Map<number, { size: number; sha256: string }>()
    for (const { a, path, srcAbs } of entries) {
      if (exportMeta.get(a.id)?.labeled === true && srcAbs) {
        try {
          copyFingerprints.set(a.id, { size: statSync(srcAbs).size, sha256: await sha256File(srcAbs) })
        } catch {
          log.warn(`发布包打标副本指纹读取失败，回落原件指纹: 资产 #${a.id}（${path}）`)
        }
      }
    }
    const manifest = {
      version: 1,
      generatedAt: Date.now(),
      project: { id: run.projectId, name: project?.name ?? '' },
      run: {
        id: run.id, templateKey: run.templateKey, batchId: run.batchId, batchSeq: run.batchSeq,
        input: safeParse(run.input) ?? {}, status: run.status,
      },
      // M66 只增键（向后兼容）：开启态记录 compliance + 逐文件 aigc；关闭态 = null / 无 aigc 键
      compliance: compliance?.enabled ? { enabled: true, producer: compliance.producer } : null,
      files: entries.map(({ a, path }) => {
        const meta = exportMeta.get(a.id)
        // M66：打标条目包内字节为打标副本 → size/sha256 取副本最终字节（流式哈希，副本不整读入内存），
        // 与 zip 实际内容一致（包完整性消费方不失配）；未打标条目仍为工作区原件指纹
        const copyFp = copyFingerprints.get(a.id)
        const size = copyFp ? copyFp.size : a.fileSize
        const sha256 = copyFp ? copyFp.sha256 : a.sha256
        return {
          path, role: roleOfAsset(a).role, assetId: a.id, purpose: a.purpose, size, sha256,
          ...(meta ? { aigc: meta } : {}),
        }
      }),
    }
    ensureProjectDirs(run.projectId)
    await writeZip(absTmp, manifest, entries, declaration)
    renameSync(absTmp, absFinal)
  } finally {
    // 打标临时副本清理（成功/失败都执行；清理失败不影响导出结果）
    for (const t of labeledTemps) {
      try { rmSync(t, { force: true }) } catch { /* 清理失败不影响导出 */ }
    }
    if (labelTempDir) {
      try { rmSync(labelTempDir, { recursive: true, force: true }) } catch { /* 清理失败不影响导出 */ }
    }
  }
  const fileSize = statSync(absFinal).size
  const sha256 = await sha256File(absFinal)
  log.info(`导出包生成: ${zipName}（${entries.length} 文件, ${fileSize} bytes）`)
  return registerAsset(run.projectId, {
    runId: run.id,
    kind: 'archive',
    purpose: 'export',
    name: zipName,
    relPath,
    mime: 'application/zip',
    ext: 'zip',
    fileSize,
    sha256,
    params: { name: pkgName, runId: run.id, fileCount: entries.length },
  })
}

/** 流式计算交付包文件 sha256（不将整个 zip 读入内存；大产物包友好） */
function sha256File(absPath: string): Promise<string> {
  return new Promise((res, rej) => {
    const hash = createHash('sha256')
    const rs = createReadStream(absPath)
    rs.on('error', rej)
    rs.on('data', (chunk) => hash.update(chunk))
    rs.on('end', () => res(hash.digest('hex')))
  })
}

/** fflate 流式 zip（store 不压缩；manifest 首 entry，M66 开启态声明文件紧随其后；64KB 分块；失败清理临时文件） */
function writeZip(
  absPath: string,
  manifest: object,
  entries: Array<{ a: Asset; path: string; srcAbs?: string }>,
  declaration: string | null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(absPath)
    out.on('error', reject)
    out.on('close', () => resolve())
    const zip = new Zip((err, chunk, final) => {
      if (err) return reject(err)
      out.write(Buffer.from(chunk))
      if (final) out.end()
    })
    const mEntry = new ZipPassThrough('manifest.json')
    zip.add(mEntry)
    mEntry.push(new TextEncoder().encode(JSON.stringify(manifest, null, 2)), true)
    if (declaration !== null) {
      const dEntry = new ZipPassThrough(DECLARATION_NAME)
      zip.add(dEntry)
      dEntry.push(new TextEncoder().encode(declaration), true)
    }
    void (async () => {
      for (const { a, path, srcAbs } of entries) {
        const entry = new ZipPassThrough(path)
        zip.add(entry)
        const rs = createReadStream(srcAbs ?? absPathOf(a.relPath!))
        try {
          await new Promise<void>((res, rej) => {
            rs.on('data', (chunk) => entry.push(chunk as Uint8Array, false))
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

/** 导出包列表（purpose='export' 资产） */
export async function listExports(q: { runId?: number; projectId?: number }): Promise<Asset[]> {
  const conds = [eq(assets.purpose, 'export'), eq(assets.kind, 'archive'), isNull(assets.deletedAt)]
  if (q.runId) conds.push(eq(assets.runId, q.runId))
  if (q.projectId) conds.push(eq(assets.projectId, q.projectId))
  return db.select().from(assets).where(and(...conds)).orderBy(desc(assets.createdAt)).limit(100)
}

function safeParse(s: string | null): unknown {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

/** 从资产 params.aigc 读生成期 ProduceID（M66 前旧资产/缺失/损坏/空白串 → null） */
function readAigcProduceId(a: Asset): string | null {
  try {
    const p = JSON.parse(a.params ?? '{}') as { aigc?: { produceId?: string } }
    const pid = p.aigc?.produceId
    return typeof pid === 'string' && pid.trim() ? pid.trim() : null
  } catch {
    return null
  }
}
