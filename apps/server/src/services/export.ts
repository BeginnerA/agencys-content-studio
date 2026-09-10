/**
 * [M4] 导出分发服务（E3；spec §5 + §E）
 * - 发布包 zip（store 不压缩）+ manifest.json 首 entry（包内路径为准）
 * - 任何状态的 run 均可导出已有产物；串行流式写，失败清理临时文件
 */
import { createReadStream, createWriteStream, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { Zip, ZipPassThrough } from 'fflate'
import { db } from '../db'
import { assets, pipelineRuns, pipelineSteps, projects, type Asset } from '../db/schema'
import { createLogger } from '../logger'
import { absPathOf, ensureProjectDirs, registerAsset, sanitizeName } from './storage'

const log = createLogger('export')

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
  // 包内路径（role 目录 + 重名 -1/-2 后缀；manifest.path 为准）
  const used = new Set<string>()
  const entries = picked.map((a) => {
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
  const manifest = {
    version: 1,
    generatedAt: Date.now(),
    project: { id: run.projectId, name: project?.name ?? '' },
    run: {
      id: run.id, templateKey: run.templateKey, batchId: run.batchId, batchSeq: run.batchSeq,
      input: safeParse(run.input) ?? {}, status: run.status,
    },
    files: entries.map(({ a, path }) => ({
      path, role: roleOfAsset(a).role, assetId: a.id, purpose: a.purpose, size: a.fileSize, sha256: a.sha256,
    })),
  }
  ensureProjectDirs(run.projectId)
  const zipName = `${pkgName}.zip`
  const relPath = join(String(run.projectId), 'exports', sanitizeName(zipName))
  const absFinal = absPathOf(relPath)
  const absTmp = `${absFinal}.tmp-${Date.now()}`
  await writeZip(absTmp, manifest, entries)
  renameSync(absTmp, absFinal)
  const fileSize = statSync(absFinal).size
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
    params: { name: pkgName, runId: run.id, fileCount: entries.length },
  })
}

/** fflate 流式 zip（store 不压缩；manifest 首 entry；64KB 分块；失败清理临时文件） */
function writeZip(absPath: string, manifest: object, entries: Array<{ a: Asset; path: string }>): Promise<void> {
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
    void (async () => {
      for (const { a, path } of entries) {
        const entry = new ZipPassThrough(path)
        zip.add(entry)
        const rs = createReadStream(absPathOf(a.relPath!))
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
