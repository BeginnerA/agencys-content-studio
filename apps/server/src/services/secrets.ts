import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../env'

/**
 * 本地密钥文件 data/secrets.json（0600 由 .gitignore 保证不入库）。
 * key 规范：env:XXX → 环境变量；local:cfg:{id} → 本文件。
 */
const SECRETS_FILE = join(DATA_DIR, 'secrets.json')

let cache: Record<string, string> | null = null

function load(): Record<string, string> {
  if (cache) return cache
  if (!existsSync(SECRETS_FILE)) {
    cache = {}
    return cache
  }
  try {
    cache = JSON.parse(readFileSync(SECRETS_FILE, 'utf8')) as Record<string, string>
  } catch {
    cache = {}
  }
  return cache
}

function persist(): void {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(SECRETS_FILE, JSON.stringify(cache ?? {}, null, 2), { mode: 0o600 })
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
