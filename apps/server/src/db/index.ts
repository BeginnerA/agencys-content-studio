import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { DATA_DIR, PROJECTS_DIR, PROMPTS_DIR, ROOT, RUN_LOGS_DIR, TEMPLATES_DIR } from '../env'
import { createLogger } from '../logger'
import * as schema from './schema'
import { seedProviders, seedVendorCredentials, migrateCredentialsFromConfigs } from './seed'

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
  await ensureSchemaColumns()
  await seedVendorCredentials()
  await seedProviders()
  await migrateCredentialsFromConfigs()
  log.info('db ready', { file: join(DATA_DIR, 'studio.db') })
}

/** 列级兜底：migrate 体系外手动建库/旧库缺列时补齐（幂等；失败仅告警） */
async function ensureSchemaColumns(): Promise<void> {
  const cols = await sqlite.execute("PRAGMA table_info('pipeline_runs')")
  const has = new Set((cols.rows as unknown as Array<{ name: string }>).map((r) => r.name))
  if (!has.has('template_snapshot')) {
    try {
      await sqlite.execute('ALTER TABLE pipeline_runs ADD COLUMN template_snapshot text')
      log.info('ensureColumn: pipeline_runs.template_snapshot 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }

  // vendor_credentials 双层架构新增列
  const provCols = await sqlite.execute("PRAGMA table_info('api_providers')")
  const provHas = new Set((provCols.rows as unknown as Array<{ name: string }>).map((r) => r.name))
  if (!provHas.has('vendor')) {
    try {
      await sqlite.execute('ALTER TABLE api_providers ADD COLUMN vendor text')
      log.info('ensureColumn: api_providers.vendor 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }

  const cfgCols = await sqlite.execute("PRAGMA table_info('api_configs')")
  const cfgHas = new Set((cfgCols.rows as unknown as Array<{ name: string }>).map((r) => r.name))
  if (!cfgHas.has('credential_id')) {
    try {
      await sqlite.execute('ALTER TABLE api_configs ADD COLUMN credential_id integer')
      log.info('ensureColumn: api_configs.credential_id 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }
  if (!cfgHas.has('pricing')) {
    try {
      await sqlite.execute("ALTER TABLE api_configs ADD COLUMN pricing text DEFAULT '{}' NOT NULL")
      log.info('ensureColumn: api_configs.pricing 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }

  // [M8] 实体素材库：characters.kind 泛化列（存量行 default 'character'）
  const charCols = await sqlite.execute("PRAGMA table_info('characters')")
  const charHas = new Set((charCols.rows as unknown as Array<{ name: string }>).map((r) => r.name))
  if (!charHas.has('kind')) {
    try {
      await sqlite.execute("ALTER TABLE characters ADD COLUMN kind text DEFAULT 'character' NOT NULL")
      log.info('ensureColumn: characters.kind 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }

  // [M8] 风格预设库建表兜底（migrate 体系外旧库）
  try {
    await sqlite.execute(
      `CREATE TABLE IF NOT EXISTS style_presets (
        id integer PRIMARY KEY AUTOINCREMENT,
        name text NOT NULL UNIQUE,
        snippet text NOT NULL,
        description text,
        sort_order integer DEFAULT 0 NOT NULL,
        is_active integer DEFAULT 1 NOT NULL,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )`,
    )
  } catch (err) {
    log.warn(`ensureTable failed: ${(err as Error).message}`)
  }
}
