import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { Hono } from 'hono'
import { PROMPTS_DIR } from '../env'
import { HttpError, h } from './helpers'

export const promptsRoutes = new Hono()

const PREFIX = '/prompts/'
/** 单文件内容上限（提示词文本，512KB 足够） */
const MAX_BYTES = 512 * 1024

/** 请求路径 → PROMPTS_DIR 内安全绝对路径（防目录穿越；支持子目录与中文名） */
function resolvePromptPath(reqPath: string): { abs: string; rel: string } {
  const idx = reqPath.indexOf(PREFIX)
  const raw = idx >= 0 ? reqPath.slice(idx + PREFIX.length) : ''
  let rel = ''
  try {
    rel = decodeURIComponent(raw)
  } catch {
    throw new HttpError(400, 'bad_path', '路径编码非法')
  }
  if (!rel.trim()) throw new HttpError(400, 'bad_path', '缺少文件路径')
  if (rel.includes('\0')) throw new HttpError(400, 'bad_path', '路径非法')
  const root = resolve(PROMPTS_DIR)
  const abs = resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new HttpError(400, 'bad_path', '路径越界（限定在 prompts 目录内）')
  }
  return { abs, rel: rel.replace(/\\/g, '/') }
}

interface PromptItem {
  name: string
  size: number
  updatedAt: number
}

/** 递归收集目录内文件（相对路径统一 POSIX 斜杠） */
function walk(dir: string, base = ''): PromptItem[] {
  const out: PromptItem[] = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name
    const abs = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walk(abs, rel))
    else if (ent.isFile()) {
      const st = statSync(abs)
      out.push({ name: rel, size: st.size, updatedAt: st.mtimeMs })
    }
  }
  return out
}

// GET /prompts —— 提示词文件清单（相对路径）
promptsRoutes.get('/prompts', h((c) => {
  if (!existsSync(PROMPTS_DIR)) return c.json({ items: [] })
  const items = walk(PROMPTS_DIR).sort((a, b) => a.name.localeCompare(b.name))
  return c.json({ items })
}))

// GET /prompts/* —— 读取文本内容
promptsRoutes.get('/prompts/*', h((c) => {
  const { abs, rel } = resolvePromptPath(c.req.path)
  let isFile = false
  try {
    isFile = statSync(abs).isFile()
  } catch {
    // 不存在按 404 处理
  }
  if (!isFile) throw new HttpError(404, 'prompt_not_found', `提示词「${rel}」不存在`)
  const content = readFileSync(abs, 'utf8')
  return c.json({ name: rel, content })
}))

// PUT /prompts/* —— 新建/覆盖写 {content}（父目录自动创建）
promptsRoutes.put('/prompts/*', h(async (c) => {
  const { abs, rel } = resolvePromptPath(c.req.path)
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'bad_json', '请求体非合法 JSON')
  })
  const content = body['content']
  if (typeof content !== 'string') throw new HttpError(400, 'bad_content', 'content 需为字符串')
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
    throw new HttpError(400, 'too_large', 'content 超过 512KB 上限')
  }
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
  return c.json({ ok: true, name: rel, size: Buffer.byteLength(content, 'utf8') })
}))

// DELETE /prompts/* —— 删除文件
promptsRoutes.delete('/prompts/*', h((c) => {
  const { abs, rel } = resolvePromptPath(c.req.path)
  let isFile = false
  try {
    isFile = statSync(abs).isFile()
  } catch {
    // 不存在按 404 处理
  }
  if (!isFile) throw new HttpError(404, 'prompt_not_found', `提示词「${rel}」不存在`)
  unlinkSync(abs)
  return c.json({ ok: true })
}))
