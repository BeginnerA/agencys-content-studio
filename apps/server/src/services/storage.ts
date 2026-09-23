import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { assets, type Asset } from '../db/schema'
import { PROJECTS_DIR } from '../env'
import { docFormatByExt, parseDocBuffer } from './doc-parse'

/** 按扩展名推断资产 kind */
export function kindByExt(ext: string): Asset['kind'] {
  const e = ext.toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(e)) return 'image'
  if (['.mp4', '.mov', '.webm', '.mkv', '.avi'].includes(e)) return 'video'
  if (['.mp3', '.wav', '.aac', '.m4a', '.flac'].includes(e)) return 'audio'
  if (['.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.srt', '.vtt', '.log', '.ini', '.toml'].includes(e)) return 'text'
  return 'archive'
}

export function sanitizeName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|]/g, '_').trim()
  return clean || `file-${Date.now()}`
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 项目资产根目录（子目录见 purposeSubDir） */
export function projectAbsDir(projectId: number): string {
  return join(PROJECTS_DIR, String(projectId))
}

/** 文本 JSON 输出格式（mime/ext 判定与 ai_text format 透传共用） */
export const JSON_FORMATS = ['storyboard-json', 'lines-json', 'characters-json', 'set-json', 'event-json', 'graph-json', 'plan-json', 'chapter-manifest-json', 'dialogue-transcript-json'] as const

/** 文本 JSON 格式判定 */
export function isJsonTextFormat(format?: string): boolean {
  return !!format && (JSON_FORMATS as readonly string[]).includes(format)
}

/** purpose → 子目录映射（M1/M2 产物归类 + M3 记忆/角色日志 + M9 小说链 + M19 SFX/派生画幅；未列出的 purpose 回退 source） */
export function purposeSubDir(purpose?: string | null): string {
  switch (purpose) {
    case 'script':
    case 'storyboard':
    case 'subtitle':
    case 'dialogue_transcript':
    case 'memory':
    case 'memory_log':
    case 'character_log':
    case 'characters':
    case 'sets':
    case 'set_log':
    case 'chapters':
    case 'events':
    case 'graph':
    case 'plan':
    case 'regex':
    case 'video_analysis': // [M25·G9] 视频时间轴 json + 人读 md 报告
    case 'image_analysis': // 图片反推 json + 人读 md 报告（image-reverse 链，同源形态）
    case 'audit_report': // [M25·G4] 改编一致性回查报告
      return 'texts'
    case 'export':
    case 'creation_svg': // [M22] 画布布局图 SVG 导出（与 export 同类归档）
      return 'exports'
    case 'shot_image':
    case 'first_frame':
    case 'reference_character':
    case 'reference_scene':
    case 'reference_prop':
    case 'thumbnail':
      return 'images'
    case 'final_video':
    case 'final_video_derived':
    case 'shot_video':
    case 'creation_compose':
      return 'video'
    case 'voice':
    case 'dialogue_audio':
    case 'creation_audio':
    case 'sfx':
      return 'audio'
    default:
      return 'source'
  }
}

export function absPathOf(relPath: string): string {
  return join(PROJECTS_DIR, relPath)
}

export function relPathOf(projectId: number, purpose: string | null | undefined, fileName: string): string {
  return join(String(projectId), purposeSubDir(purpose), sanitizeName(fileName))
}

export function ensureProjectDirs(projectId: number): void {
  for (const sub of ['source', 'texts', 'images', 'video', 'audio', 'thumbs', 'exports', 'versions']) {
    mkdirSync(join(projectAbsDir(projectId), sub), { recursive: true })
  }
}

export interface ImportedFile {
  name: string
  data: Uint8Array
}

/** 批量导入素材文件 → 资产行 + 落盘（sha256 重复跳过）。
 *  [M25·G1] docx/epub 在入库单点转 md 文本资产（原二进制不落盘 v1）：转换后文本参与 sha256 去重，
 *  name 去扩展 + .md，params.doc_import={format,chars}（供前端导入提示与召回判定）。 */
export async function importFiles(
  projectId: number,
  files: ImportedFile[],
  opts: { stepId?: number; purpose?: string } = {},
): Promise<Asset[]> {
  ensureProjectDirs(projectId)
  const created: Asset[] = []
  for (const f of files) {
    let data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data)
    let storeName = f.name
    let docImport: { format: string; chars: number } | null = null
    // [M25·G1] docx/epub → 解析为纯文本，重封为 .md 资产（解析失败向上抛 DocParseError，导入侧 400）
    if (docFormatByExt(storeName)) {
      const { text, format } = await parseDocBuffer(storeName, data)
      docImport = { format, chars: text.length }
      storeName = storeName.replace(/\.(docx|epub)$/i, '') + '.md'
      data = new TextEncoder().encode(text)
    }
    const ext = extname(storeName)
    const hash = sha256Hex(data)
    const existed = await db
      .select()
      .from(assets)
      .where(and(eq(assets.projectId, projectId), eq(assets.sha256, hash), isNull(assets.deletedAt)))
      .limit(1)
    if (existed.length > 0) {
      created.push(existed[0]!)
      continue
    }
    const kind = kindByExt(ext)
    const purpose = opts.purpose ?? 'source'
    const fileName = `${Date.now()}-${sanitizeName(storeName)}`
    const relPath = relPathOf(projectId, purpose, fileName)
    writeFileSync(absPathOf(relPath), data)
    const now = Date.now()
    const row = await db
      .insert(assets)
      .values({
        projectId,
        stepId: opts.stepId,
        kind,
        purpose,
        name: storeName,
        mime: mimeOfExt(ext),
        ext: ext.slice(1),
        fileSize: data.byteLength,
        sha256: hash,
        relPath,
        params: docImport ? JSON.stringify({ doc_import: docImport }) : undefined,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    created.push(row[0]!)
  }
  return created
}

/** 文本类资产（LLM 产物等）落盘并登记 */
export async function writeTextAsset(
  projectId: number,
  opts: {
    name: string
    content: string
    purpose: string
    format?: string
    stepId?: number
    taskId?: number
    runId?: number | null
    prompt?: string
    params?: Record<string, unknown>
    tags?: string[]
  },
  executor: Pick<typeof db, 'insert'> = db,
): Promise<Asset> {
  ensureProjectDirs(projectId)
  const data = new TextEncoder().encode(opts.content)
  const fileName = `${Date.now()}-${sanitizeName(opts.name)}`
  const relPath = relPathOf(projectId, opts.purpose, fileName)
  writeFileSync(absPathOf(relPath), data)
  const now = Date.now()
  const row = await executor
    .insert(assets)
    .values({
      projectId,
      stepId: opts.stepId,
      taskId: opts.taskId,
      runId: opts.runId ?? null,
      kind: 'text',
      purpose: opts.purpose,
      name: opts.name,
      // [M22] srt 单独归位（烧录/下载/前端候选过滤可依赖 mime/ext；其余同现状零漂移）；[M22.P3] svg 同理
      mime: opts.format === 'srt' ? 'application/x-subrip' : opts.format === 'svg' ? 'image/svg+xml' : isJsonTextFormat(opts.format) ? 'application/json' : 'text/markdown',
      ext: opts.format === 'srt' ? 'srt' : opts.format === 'svg' ? 'svg' : isJsonTextFormat(opts.format) ? 'json' : 'md',
      fileSize: data.byteLength,
      sha256: sha256Hex(data),
      relPath,
      prompt: opts.prompt,
      params: opts.params ? JSON.stringify(opts.params) : null,
      tags: JSON.stringify(opts.tags ?? []),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  return row[0]!
}

/** 通用登记：由 action 落盘后调用 */
export async function registerAsset(
  projectId: number,
  data: {
    name: string
    kind: Asset['kind']
    purpose?: string
    relPath: string
    mime?: string
    ext?: string
    fileSize?: number
    width?: number
    height?: number
    duration?: number
    sha256?: string
    prompt?: string
    params?: Record<string, unknown>
    tags?: string[]
    stepId?: number
    taskId?: number
    runId?: number | null
  },
): Promise<Asset> {
  const now = Date.now()
  const row = await db
    .insert(assets)
    .values({
      projectId,
      stepId: data.stepId,
      taskId: data.taskId,
      runId: data.runId ?? null,
      kind: data.kind,
      purpose: data.purpose ?? null,
      name: data.name,
      mime: data.mime ?? null,
      ext: data.ext ?? null,
      fileSize: data.fileSize ?? null,
      width: data.width ?? null,
      height: data.height ?? null,
      duration: data.duration ?? null,
      sha256: data.sha256 ?? null,
      relPath: data.relPath,
      prompt: data.prompt ?? null,
      params: data.params ? JSON.stringify(data.params) : null,
      tags: JSON.stringify(data.tags ?? []),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  return row[0]!
}

/** 读取文本资产全文 */
export async function readTextAsset(assetId: number): Promise<string> {
  const row = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1)
  const a = row[0]
  if (!a) throw new Error(`asset ${assetId} 不存在`)
  if (!a.relPath) throw new Error(`asset ${assetId} 无本地文件`)
  return readFileSync(absPathOf(a.relPath), 'utf8')
}

export function mimeOfExt(ext: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.txt': 'text/plain',
    '.log': 'text/plain',
    '.ini': 'text/plain',
    '.toml': 'text/plain',
    '.srt': 'text/plain',
    '.vtt': 'text/vtt',
    '.csv': 'text/csv',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.xml': 'application/xml',
    '.json': 'application/json',
  }
  return map[ext.toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 文本类 MIME 补 `charset=utf-8`。
 * 浏览器直接新标签打开文本文件时，若响应缺 charset 会回退到 Latin-1/本地编码解析，
 * 导致 UTF-8 中文乱码（SRT/MD/JSON 等文本资产均受影响）。已带 charset 的原样返回。
 */
export function withUtf8Charset(mime: string): string {
  if (/charset=/i.test(mime)) return mime
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
    return `${mime}; charset=utf-8`
  }
  return mime
}
