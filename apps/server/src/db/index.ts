import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { DATA_DIR, PROJECTS_DIR, PROMPTS_DIR, ROOT, RUN_LOGS_DIR, TEMPLATES_DIR } from '../env'
import { createLogger } from '../logger'
import * as schema from './schema'
import { seedProviders } from './seed'

const log = createLogger('db')

/** 启动前确保运行时目录存在 */
export function ensureDirs(): void {
  for (const dir of [DATA_DIR, TEMPLATES_DIR, PROMPTS_DIR, PROJECTS_DIR, RUN_LOGS_DIR]) {
    mkdirSync(dir, { recursive: true })
  }
}

export const sqlite = createClient({
  url: `file:${join(DATA_DIR, 'studio.db')}`,
})

export const db = drizzle(sqlite, { schema })

const MIGRATIONS_DIR = join(ROOT, 'apps', 'server', 'drizzle')

/** 初始化：PRAGMA + 迁移 + 种子（幂等，仅首次启动建库） */
export async function initDb(): Promise<void> {
  ensureDirs()
  await sqlite.execute('PRAGMA journal_mode = WAL')
  await sqlite.execute('PRAGMA foreign_keys = ON')
  await sqlite.execute('PRAGMA busy_timeout = 5000')
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
  } catch (err) {
    log.warn(`migrate skipped (${(err as Error).message}) —— 请先执行 pnpm db:generate`)
  }
  await seedProviders()
  log.info('db ready', { file: join(DATA_DIR, 'studio.db') })
}
