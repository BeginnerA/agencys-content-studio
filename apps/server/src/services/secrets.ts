import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../env'

/**
 * 本地密钥文件 data/secrets.json（0600 由 .gitignore 保证不入库）。
 * key 规范：env:XXX → 环境变量；local:cfg:{id} → 本文件。
 */
const SECRETS_FILE = join(DATA_DIR, 'secrets.json')

let cache: Record<string, string> | null = null
/** 上次载入时文件的 mtime/size 指纹：用于感知外部（其它进程/手工/导入）写入后自动刷新，避免长期驻内存陈旧密钥 */
let cacheStamp = ''

function fileStamp(): string {
  try {
    const st = statSync(SECRETS_FILE)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return ''
  }
}

function readStore(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(SECRETS_FILE, 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

function load(): Record<string, string> {
  if (!existsSync(SECRETS_FILE)) {
    cache = {}
    cacheStamp = ''
    return cache
  }
  // 文件被其它进程或导入脚本改过 → 重新读取（修复：secrets.json 有值但服务进程缓存为空导致鉴权头缺失 401）
  const stamp = fileStamp()
  if (cache && stamp === cacheStamp) return cache
  cache = readStore()
  cacheStamp = stamp
  return cache
}

function persist(): void {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(SECRETS_FILE, JSON.stringify(cache ?? {}, null, 2), { mode: 0o600 })
  // 本进程刚写入 → 同步指纹，避免下次 load 对自己的写入再触发一次磁盘重读
  cacheStamp = fileStamp()
}

/** 解析 key 引用为实际密钥；未配置返回空串 */
export function resolveApiKey(ref: string | null | undefined): string {
  if (!ref) return ''
  if (ref.startsWith('env:')) return process.env[ref.slice(4)] ?? ''
  if (ref.startsWith('local:')) return load()[ref] ?? ''
  return process.env[ref] ?? load()[ref] ?? ''
}

/** 写入本地密钥（覆盖同名） */
export function writeSecret(key: string, value: string): void {
  const store = load()
  store[key] = value
  cache = store
  persist()
}

/** 删除本地密钥 */
export function deleteSecret(key: string): void {
  const store = load()
  if (key in store) {
    delete store[key]
    cache = store
    persist()
  }
}

/** key 脱敏：只保留末 4 位（无 key 时返回空） */
export function maskSecret(ref: string | null | undefined): string {
  const v = resolveApiKey(ref)
  if (!v) return ''
  return `****${v.slice(-4)}`
}
