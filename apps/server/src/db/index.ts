import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { BRAND_DIR, DATA_DIR, PROJECTS_DIR, PROMPTS_DIR, ROOT, RUN_LOGS_DIR, TEMPLATES_DIR } from '../env'
import { createLogger } from '../logger'
import * as schema from './schema'
import { seedProviders, seedVendorCredentials, seedStylePresets, migrateCredentialsFromConfigs, migrateAliyunBailianRows, migrateGatewayRowsToOpenAI, removeGatewayPrivateProtocolRows, cleanupRetiredVendorCredentials } from './seed'

const log = createLogger('db')

/** 启动前确保运行时目录存在 */
export function ensureDirs(): void {
  for (const dir of [DATA_DIR, TEMPLATES_DIR, PROMPTS_DIR, PROJECTS_DIR, RUN_LOGS_DIR, BRAND_DIR]) {
    mkdirSync(dir, { recursive: true })
  }
}

export const sqlite = createClient({
  url: `file:${join(DATA_DIR, 'studio.db')}`,
})

export const db = drizzle(sqlite, { schema })

const MIGRATIONS_DIR = join(ROOT, 'apps', 'server', 'drizzle')

/** 初始化：PRAGMA + 迁移 + 种子（幂等，仅首次启动建库）。进程内单次执行：迁移/清理是启动期一次性动作，
 * 重复跑会误删探针在 initDb 后插入的夹具行（如网关私有协议 key），故用 promise 防重入。 */
let initDbOnce: Promise<void> | null = null
export function initDb(): Promise<void> {
  initDbOnce ??= doInitDb()
  return initDbOnce
}

async function doInitDb(): Promise<void> {
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
  // 阿里千问/万相行收敛为百炼统一行：须在 seedProviders 前执行（旧行删除 → 新行补种）
  await migrateAliyunBailianRows()
  // 网关 OpenAI 兼容行（siliconflow/pollinations 的 LLM·图像·语音）收编进 openai_* 协议行：同样须在 seedProviders 前执行
  await migrateGatewayRowsToOpenAI()
  // 网关私有协议能力（视频/音乐）不支持 OpenAI 协议：按用户决定直接移除、不再单独适配
  await removeGatewayPrivateProtocolRows()
  await seedVendorCredentials()
  // 退役网关残留凭证回收（如 openrouter：代码已回退但旧库只插不删）：在补种后执行，不会被重新插入
  await cleanupRetiredVendorCredentials()
  await seedProviders()
  await migrateCredentialsFromConfigs()
  // 内置常用风格预设（幂等补缺，不覆盖用户编辑）：表由 ensureSchemaColumns 建表兜底后写入
  await seedStylePresets()
  log.info('db ready', { file: join(DATA_DIR, 'studio.db') })
}

/**
 * schema 权威真源 = `db/schema.ts` + `drizzle/0000_*` 全量基线（`db:generate` 生成、
 * 幂等 `IF NOT EXISTS`、含全部 32 表 + 原漂移列/索引）。存量库重启时 migrate 以 no-op 应用并记账，
 * 新库则基线一次建全——二者均无需本函数再补任何列/表。
 *
 * 本函数因此降级为**冗余兜底 / 防呆**（幂等；失败仅告警）：仅覆盖 migrate 体系外手工建库 / 极旧库缺列
 * 的极端场景。**新增列的正确姿势**：改 `schema.ts` → `pnpm --filter @acs/server db:generate` 生成后继
 * 迁移（0001…）即成权威真源；无需再在此手写 ALTER/CREATE（除非确需一道启动期防呆）。
 */
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

  // 实体素材库：characters.kind 泛化列（存量行 default 'character'）
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

  // states 变体入库：characters.states 列（存量行 default '[]'）
  if (!charHas.has('states')) {
    try {
      await sqlite.execute("ALTER TABLE characters ADD COLUMN states text DEFAULT '[]' NOT NULL")
      log.info('ensureColumn: characters.states 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }

  // [B③] 声线拆分：characters.voice_desc 自然语言描述列（存量行 NULL → 展示回退 voice）
  if (!charHas.has('voice_desc')) {
    try {
      await sqlite.execute('ALTER TABLE characters ADD COLUMN voice_desc text')
      log.info('ensureColumn: characters.voice_desc 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }

  // 画布任务归属列：gen_tasks.canvas_node_id（存量行 NULL）
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

  // 创作画布建表兜底（migrate 体系外旧库；幂等）
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

  // 创作画布：节点采纳/序号列（建表后补齐：新库直接带列；存量旧表 ALTER；幂等）
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

  // 创作画布：回收站软删列（canvases.deleted_at）+ 节点成组列（canvas_nodes.group_id）
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

  // 画布分组 / 文档快照建表兜底（migrate 体系外旧库；幂等）
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
        parent_id integer,
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

  // 画布组嵌套列：canvas_groups.parent_id（存量行 NULL=顶层；新库建表已带列）
  const cgCols = await sqlite.execute("PRAGMA table_info('canvas_groups')")
  const cgHas = new Set((cgCols.rows as unknown as Array<{ name: string }>).map((r) => r.name))
  if (!cgHas.has('parent_id')) {
    try {
      await sqlite.execute('ALTER TABLE canvas_groups ADD COLUMN parent_id integer')
      log.info('ensureColumn: canvas_groups.parent_id 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }

  // 风格预设库建表兜底（migrate 体系外旧库）
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

  // 剧集实体建表兜底（migrate 体系外旧库；幂等）
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

  // 声音克隆音色库建表兜底（migrate 体系外旧库；幂等）
  try {
    await sqlite.execute(
      `CREATE TABLE IF NOT EXISTS voice_clones (
        id integer PRIMARY KEY AUTOINCREMENT,
        name text NOT NULL UNIQUE,
        provider_key text NOT NULL,
        model text NOT NULL,
        voice_id text NOT NULL,
        status text DEFAULT 'ready' NOT NULL,
        meta text DEFAULT '{}' NOT NULL,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )`,
    )
  } catch (err) {
    log.warn(`ensureTable failed: ${(err as Error).message}`)
  }

  // publications 表新增 title/ab_group 列（A/B 测试 + 标题识别）
  const pubCols = await sqlite.execute("PRAGMA table_info('publications')")
  const pubHas = new Set((pubCols.rows as unknown as Array<{ name: string }>).map((r) => r.name))
  if (!pubHas.has('title')) {
    try {
      await sqlite.execute('ALTER TABLE publications ADD COLUMN title text')
      log.info('ensureColumn: publications.title 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }
  if (!pubHas.has('ab_group')) {
    try {
      await sqlite.execute('ALTER TABLE publications ADD COLUMN ab_group text')
      log.info('ensureColumn: publications.ab_group 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }

  // 排产计划表建表兜底（migrate 体系外旧库；幂等）
  try {
    await sqlite.execute(
      `CREATE TABLE IF NOT EXISTS schedules (
        id integer PRIMARY KEY AUTOINCREMENT,
        project_id integer NOT NULL,
        name text NOT NULL,
        template_key text NOT NULL,
        cron_expr text NOT NULL,
        scheduled_at integer NOT NULL,
        status text DEFAULT 'pending' NOT NULL,
        last_triggered_at integer,
        last_batch_id integer,
        input_template text DEFAULT '{}' NOT NULL,
        note text,
        is_active integer DEFAULT 1 NOT NULL,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )`,
    )
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_schedules_project ON schedules (project_id)')
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules (status)')
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_schedules_scheduled ON schedules (scheduled_at)')
  } catch (err) {
    log.warn(`ensureTable failed: ${(err as Error).message}`)
  }

  // 预算告警记录表建表兜底（migrate 体系外旧库；幂等）
  try {
    await sqlite.execute(
      `CREATE TABLE IF NOT EXISTS budget_alerts (
        id integer PRIMARY KEY AUTOINCREMENT,
        scope text NOT NULL,
        scope_id integer,
        kind text NOT NULL,
        budget real NOT NULL,
        spent real NOT NULL,
        ratio real NOT NULL,
        created_at integer NOT NULL
      )`,
    )
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_budget_alerts_scope ON budget_alerts (scope)')
  } catch (err) {
    log.warn(`ensureTable failed: ${(err as Error).message}`)
  }

  // assets 表新增 embedding/embedding_model 列（文本资产语义索引；存量行 NULL = 未索引）
  const assetCols = await sqlite.execute("PRAGMA table_info('assets')")
  const assetHas = new Set((assetCols.rows as unknown as Array<{ name: string }>).map((r) => r.name))
  if (!assetHas.has('embedding')) {
    try {
      await sqlite.execute('ALTER TABLE assets ADD COLUMN embedding text')
      log.info('ensureColumn: assets.embedding 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }
  if (!assetHas.has('embedding_model')) {
    try {
      await sqlite.execute('ALTER TABLE assets ADD COLUMN embedding_model text')
      log.info('ensureColumn: assets.embedding_model 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }

  // 自动编排链建表兜底（migrate 体系外旧库；幂等）
  try {
    await sqlite.execute(
      `CREATE TABLE IF NOT EXISTS workflows (
        id integer PRIMARY KEY AUTOINCREMENT,
        project_id integer NOT NULL,
        name text NOT NULL,
        status text DEFAULT 'draft' NOT NULL,
        auto_advance integer DEFAULT 0 NOT NULL,
        budget_cap real,
        segments text DEFAULT '[]' NOT NULL,
        note text,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )`,
    )
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_workflows_project ON workflows (project_id)')
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows (status)')
  } catch (err) {
    log.warn(`ensureTable failed: ${(err as Error).message}`)
  }

  // pipeline_runs +2 可空列（workflow_id / workflow_seq；存量行 NULL = 非编排 run）
  if (!has.has('workflow_id')) {
    try {
      await sqlite.execute('ALTER TABLE pipeline_runs ADD COLUMN workflow_id integer')
      log.info('ensureColumn: pipeline_runs.workflow_id 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }
  if (!has.has('workflow_seq')) {
    try {
      await sqlite.execute('ALTER TABLE pipeline_runs ADD COLUMN workflow_seq integer')
      log.info('ensureColumn: pipeline_runs.workflow_seq 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }

  // [审计G2] pipeline_runs +1 可空列（resumed_from_run_id；存量行 NULL = 非续跑派生）
  if (!has.has('resumed_from_run_id')) {
    try {
      await sqlite.execute('ALTER TABLE pipeline_runs ADD COLUMN resumed_from_run_id integer')
      log.info('ensureColumn: pipeline_runs.resumed_from_run_id 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }

  // 通用追溯层三表建表兜底（migrate 体系外旧库；幂等）
  try {
    await sqlite.execute(
      `CREATE TABLE IF NOT EXISTS content_versions (
        id integer PRIMARY KEY AUTOINCREMENT,
        project_id integer NOT NULL,
        obj_kind text NOT NULL,
        obj_id integer NOT NULL,
        revision integer NOT NULL,
        payload_kind text DEFAULT 'file' NOT NULL,
        rel_path text,
        sha256 text,
        doc text,
        label text,
        source text DEFAULT 'edit' NOT NULL,
        meta text DEFAULT '{}' NOT NULL,
        created_at integer NOT NULL
      )`,
    )
    await sqlite.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_cv_obj_rev ON content_versions (obj_kind, obj_id, revision)')
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_cv_project ON content_versions (project_id)')
    await sqlite.execute(
      `CREATE TABLE IF NOT EXISTS exec_snapshots (
        id integer PRIMARY KEY AUTOINCREMENT,
        project_id integer NOT NULL,
        exec_kind text NOT NULL,
        run_id integer,
        step_id integer,
        task_id integer,
        template_key text,
        model text,
        input_hash text,
        frozen_at integer NOT NULL,
        created_at integer NOT NULL
      )`,
    )
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_es_project ON exec_snapshots (project_id)')
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_es_task ON exec_snapshots (task_id)')
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_es_step ON exec_snapshots (step_id)')
    await sqlite.execute(
      `CREATE TABLE IF NOT EXISTS exec_inputs (
        id integer PRIMARY KEY AUTOINCREMENT,
        snapshot_id integer NOT NULL,
        project_id integer NOT NULL,
        role text NOT NULL,
        src_kind text NOT NULL,
        src_id integer NOT NULL,
        version_id integer,
        used integer DEFAULT 1 NOT NULL,
        skip_reason text,
        shot_id text,
        port text,
        ordinal integer DEFAULT 0 NOT NULL,
        created_at integer NOT NULL
      )`,
    )
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_ei_snapshot ON exec_inputs (snapshot_id)')
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_ei_source ON exec_inputs (src_kind, src_id)')
  } catch (err) {
    log.warn(`ensureTable failed: ${(err as Error).message}`)
  }

  // 精确返修台账建表兜底（precision-rework 规格 §5.1；migrate 体系外旧库；幂等。缺表时 ledger 查询报错 fail closed，不静默降级）
  try {
    await sqlite.execute(
      `CREATE TABLE IF NOT EXISTS rework_requests (
        id text PRIMARY KEY,
        project_id integer NOT NULL,
        run_id integer NOT NULL,
        step_key text NOT NULL,
        session_id integer,
        request_key text NOT NULL,
        request_hash text NOT NULL,
        state text DEFAULT 'parsing' NOT NULL,
        base_fingerprint text,
        changes_json text DEFAULT '[]' NOT NULL,
        preview_json text DEFAULT '{}' NOT NULL,
        result_json text DEFAULT '{}' NOT NULL,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )`,
    )
    await sqlite.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_rework_requests_run_key ON rework_requests (run_id, request_key)')
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_rework_requests_project ON rework_requests (project_id)')
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_rework_requests_run ON rework_requests (run_id)')
  } catch (err) {
    log.warn(`ensureTable failed: ${(err as Error).message}`)
  }

  // 两张通用会话表；失败阻止启动，不能在缺少幂等约束时接受制作请求。
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS creation_sessions (
    id integer PRIMARY KEY AUTOINCREMENT, project_id integer NOT NULL,
    request_key text NOT NULL, status text DEFAULT 'draft' NOT NULL,
    plan text, approved_plan text, plan_revision integer DEFAULT 0 NOT NULL,
    plan_hash text, preflight text, start_key text, run_id integer,
    run_history text DEFAULT '[]' NOT NULL, error text,
    created_at integer NOT NULL, updated_at integer NOT NULL
  )`)
  await sqlite.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_creation_request ON creation_sessions (request_key)')
  await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_creation_project ON creation_sessions (project_id)')
  await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_creation_run ON creation_sessions (run_id)')
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS creation_messages (
    id integer PRIMARY KEY AUTOINCREMENT, session_id integer NOT NULL,
    role text NOT NULL, content text NOT NULL, payload text, request_key text,
    created_at integer NOT NULL
  )`)
  await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_creation_messages_session ON creation_messages (session_id)')
  await sqlite.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_creation_message_request ON creation_messages (session_id, request_key)')
}
