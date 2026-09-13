import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { assets, type Asset } from '../db/schema'
import { PROJECTS_DIR } from '../env'

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
export const JSON_FORMATS = ['storyboard-json', 'lines-json', 'characters-json', 'set-json', 'event-json', 'graph-json', 'plan-json', 'chapter-manifest-json'] as const

/** 文本 JSON 格式判定 */
export function isJsonTextFormat(format?: string): boolean {
  return !!format && (JSON_FORMATS as readonly string[]).includes(format)
}

/** purpose → 子目录映射（M1/M2 产物归类 + M3 记忆/角色日志 + M9 小说链；未列出的 purpose 回退 source） */
export function purposeSubDir(purpose?: string | null): string {
  switch (purpose) {
    case 'script':
    case 'storyboard':
    case 'subtitle':
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
      return 'texts'
    case 'export':
      return 'exports'
    case 'shot_image':
    case 'first_frame':
    case 'reference_character':
    case 'reference_scene':
    case 'reference_prop':
    case 'thumbnail':
      return 'images'
    case 'final_video':
    case 'shot_video':
    case 'creation_compose':
      return 'video'
    case 'voice':
    case 'creation_audio':
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
  for (const sub of ['source', 'texts', 'images', 'video', 'audio', 'thumbs', 'exports']) {
    mkdirSync(join(projectAbsDir(projectId), sub), { recursive: true })
  }
}

export interface ImportedFile {
  name: string
  data: Uint8Array
}

/** 批量导入素材文件 → 资产行 + 落盘（sha256 重复跳过） */
export async function importFiles(
  projectId: number,
  files: ImportedFile[],
  opts: { stepId?: number; purpose?: string } = {},
): Promise<Asset[]> {
  ensureProjectDirs(projectId)
  const created: Asset[] = []
  for (const f of files) {
    const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data)
    const ext = extname(f.name)
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
    const fileName = `${Date.now()}-${sanitizeName(f.name)}`
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
        name: f.name,
        mime: mimeOfExt(ext),
        ext: ext.slice(1),
        fileSize: data.byteLength,
        sha256: hash,
        relPath,
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
): Promise<Asset> {
  ensureProjectDirs(projectId)
  const data = new TextEncoder().encode(opts.content)
  const fileName = `${Date.now()}-${sanitizeName(opts.name)}`
  const relPath = relPathOf(projectId, opts.purpose, fileName)
  writeFileSync(absPathOf(relPath), data)
  const now = Date.now()
  const row = await db
    .insert(assets)
    .values({
      projectId,
      stepId: opts.stepId,
      taskId: opts.taskId,
      runId: opts.runId ?? null,
      kind: 'text',
      purpose: opts.purpose,
      name: opts.name,
      mime: isJsonTextFormat(opts.format) ? 'application/json' : 'text/markdown',
      ext: isJsonTextFormat(opts.format) ? 'json' : 'md',
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
