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

  // [M13] states 变体入库：characters.states 列（存量行 default '[]'）
  if (!charHas.has('states')) {
    try {
      await sqlite.execute("ALTER TABLE characters ADD COLUMN states text DEFAULT '[]' NOT NULL")
      log.info('ensureColumn: characters.states 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }

  // [M16] 画布任务归属列：gen_tasks.canvas_node_id（存量行 NULL）
  const taskCols = await sqlite.execute("PRAGMA table_info('gen_tasks')")
  const taskHas = new Set((taskCols.rows as unknown as Array<{ name: string }>).map((r) => r.name))
  if (!taskHas.has('canvas_node_id')) {
    try {
      await sqlite.execute('ALTER TABLE gen_tasks ADD COLUMN canvas_node_id integer')
      log.info('ensureColumn: gen_tasks.canvas_node_id 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }

  // [M16] 创作画布建表兜底（migrate 体系外旧库；幂等）
  try {
    await sqlite.execute(
      `CREATE TABLE IF NOT EXISTS canvases (
        id integer PRIMARY KEY AUTOINCREMENT,
        project_id integer NOT NULL,
        name text DEFAULT '未命名画布' NOT NULL,
        viewport text DEFAULT '{"x":0,"y":0,"zoom":1}' NOT NULL,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )`,
    )
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_canvases_project ON canvases (project_id)')
    await sqlite.execute(
      `CREATE TABLE IF NOT EXISTS canvas_nodes (
        id integer PRIMARY KEY AUTOINCREMENT,
        canvas_id integer NOT NULL,
        kind text NOT NULL,
        asset_id integer,
        title text,
        spec text,
        x real DEFAULT 0 NOT NULL,
        y real DEFAULT 0 NOT NULL,
        adopted_task_id integer,
        seq integer,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )`,
    )
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_canvas_nodes_canvas ON canvas_nodes (canvas_id)')
    await sqlite.execute(
      `CREATE TABLE IF NOT EXISTS canvas_edges (
        id integer PRIMARY KEY AUTOINCREMENT,
        canvas_id integer NOT NULL,
        "from" integer NOT NULL,
        "to" integer NOT NULL,
        port text NOT NULL,
        created_at integer NOT NULL
      )`,
    )
    await sqlite.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_edges_unique ON canvas_edges (canvas_id, "from", "to", port)')
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_canvas_edges_canvas ON canvas_edges (canvas_id)')
  } catch (err) {
    log.warn(`ensureTable failed: ${(err as Error).message}`)
  }

  // [M17] 创作画布：节点采纳/序号列（建表后补齐：新库直接带列；存量旧表 ALTER；幂等）
  const cnCols = await sqlite.execute("PRAGMA table_info('canvas_nodes')")
  const cnHas = new Set((cnCols.rows as unknown as Array<{ name: string }>).map((r) => r.name))
  if (!cnHas.has('adopted_task_id')) {
    try {
      await sqlite.execute('ALTER TABLE canvas_nodes ADD COLUMN adopted_task_id integer')
      log.info('ensureColumn: canvas_nodes.adopted_task_id 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }
  if (!cnHas.has('seq')) {
    try {
      await sqlite.execute('ALTER TABLE canvas_nodes ADD COLUMN seq integer')
      log.info('ensureColumn: canvas_nodes.seq 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }

  // [M18] 创作画布：回收站软删列（canvases.deleted_at）+ 节点成组列（canvas_nodes.group_id）
  const cvCols = await sqlite.execute("PRAGMA table_info('canvases')")
  const cvHas = new Set((cvCols.rows as unknown as Array<{ name: string }>).map((r) => r.name))
  if (!cvHas.has('deleted_at')) {
    try {
      await sqlite.execute('ALTER TABLE canvases ADD COLUMN deleted_at integer')
      log.info('ensureColumn: canvases.deleted_at 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }
  if (!cnHas.has('group_id')) {
    try {
      await sqlite.execute('ALTER TABLE canvas_nodes ADD COLUMN group_id integer')
      log.info('ensureColumn: canvas_nodes.group_id 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }

  // [M18] 画布分组 / 文档快照建表兜底（migrate 体系外旧库；幂等）
  try {
    await sqlite.execute(
      `CREATE TABLE IF NOT EXISTS canvas_groups (
        id integer PRIMARY KEY AUTOINCREMENT,
        canvas_id integer NOT NULL,
        title text DEFAULT '未命名分组' NOT NULL,
        color text,
        collapsed integer DEFAULT 0 NOT NULL,
        x real DEFAULT 0 NOT NULL,
        y real DEFAULT 0 NOT NULL,
        created_at integer NOT NULL
      )`,
    )
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_canvas_groups_canvas ON canvas_groups (canvas_id)')
    await sqlite.execute(
      `CREATE TABLE IF NOT EXISTS canvas_snapshots (
        id integer PRIMARY KEY AUTOINCREMENT,
        canvas_id integer NOT NULL,
        label text NOT NULL,
        doc text NOT NULL,
        created_at integer NOT NULL
      )`,
    )
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_canvas_snapshots_canvas ON canvas_snapshots (canvas_id)')
  } catch (err) {
    log.warn(`ensureTable failed: ${(err as Error).message}`)
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

  // [M14] 剧集实体建表兜底（migrate 体系外旧库；幂等）
  try {
    await sqlite.execute(
      `CREATE TABLE IF NOT EXISTS series (
        id integer PRIMARY KEY AUTOINCREMENT,
        project_id integer NOT NULL,
        name text NOT NULL,
        total_episodes integer DEFAULT 0 NOT NULL,
        content_asset_id integer,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )`,
    )
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_series_project ON series (project_id)')
    await sqlite.execute(
      `CREATE TABLE IF NOT EXISTS episodes (
        id integer PRIMARY KEY AUTOINCREMENT,
        project_id integer NOT NULL,
        series_id integer NOT NULL,
        number integer NOT NULL,
        title text,
        status text DEFAULT 'locked' NOT NULL,
        content_asset_id integer,
        latest_run_id integer,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )`,
    )
    await sqlite.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_project_number ON episodes (project_id, number)')
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_episodes_series ON episodes (series_id)')
  } catch (err) {
    log.warn(`ensureTable failed: ${(err as Error).message}`)
  }
}
