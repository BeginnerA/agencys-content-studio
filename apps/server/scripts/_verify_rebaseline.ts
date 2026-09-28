// 一次性 re-baseline 验证脚本（M1，验证后删除）
// 用法: npx tsx scripts/_verify_rebaseline.ts <fresh|upgrade> [dataDir]
// 只在该 dataDir（临时副本）上跑 initDb，绝不触碰真实 data/studio.db。
import { mkdirSync, mkdtempSync, cpSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')

const mode = process.argv[2]
if (mode !== 'fresh' && mode !== 'upgrade') {
  console.error('mode must be fresh|upgrade')
  process.exit(2)
}
const srcBackup = process.argv[3] // upgrade 模式：含 studio.db(+wal/shm) 的目录

const tmp = mkdtempSync(join(tmpdir(), 'acs-rebase-verify-'))
const dataDir = join(tmp, 'data')
const wsDir = join(tmp, 'workspace')
mkdirSync(dataDir, { recursive: true })
mkdirSync(wsDir, { recursive: true })

if (mode === 'upgrade') {
  if (!srcBackup || !existsSync(join(srcBackup, 'studio.db'))) {
    console.error('upgrade 需含 studio.db 的备份目录')
    process.exit(2)
  }
  for (const f of ['studio.db', 'studio.db-wal', 'studio.db-shm']) {
    const p = join(srcBackup, f)
    if (existsSync(p)) cpSync(p, join(dataDir, f))
  }
}

// 必须在动态 import src/db 之前固化 env（client/logger 首 import 定形）
process.env.CSTUDIO_ROOT = REPO_ROOT
process.env.CSTUDIO_DATA = dataDir
process.env.CSTUDIO_WORKSPACE = wsDir

const t0 = Date.now()
try {
  const { initDb } = await import('../src/db')
  await initDb()
  console.log(`INITDB_OK mode=${mode} dataDir=${dataDir} ms=${Date.now() - t0}`)
} catch (err) {
  console.error(`INITDB_FAIL mode=${mode}: ${(err as Error).message}`)
  process.exitCode = 1
}
