import type { Client } from '@libsql/client'
import { createLogger } from '../logger.js'

const log = createLogger('db:character-consistency')

/**
 * 角色一致性建表与加列兜底（migrate 体系外的存量库；全部语句幂等，重复启动安全）。
 * 覆盖：实体参考图分层登记表、逐角色一致性评价结果表、风格预设负向约束词列。
 */
export async function ensureCharacterConsistencySchema(sqlite: Client): Promise<void> {
  // 实体参考图分层登记：一条记录 = 一个实体的一张参考图及其角色（基准/状态变体/多视角）
  try {
    await sqlite.execute(
      `CREATE TABLE IF NOT EXISTS entity_references (
        id integer PRIMARY KEY AUTOINCREMENT,
        entity_id integer NOT NULL REFERENCES characters(id),
        asset_id integer NOT NULL REFERENCES assets(id),
        role text NOT NULL,
        state_key text,
        view_key text,
        enabled integer DEFAULT 1 NOT NULL,
        note text,
        created_at integer NOT NULL
      )`,
    )
    await sqlite.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_refs_pair ON entity_references (entity_id, asset_id)')
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_entity_refs_entity ON entity_references (entity_id)')
  } catch (err) {
    log.warn(`ensureTable failed: ${(err as Error).message}`)
  }

  // 逐角色一致性评价结果：一 run×一实体一行，重评覆盖既有分
  try {
    await sqlite.execute(
      `CREATE TABLE IF NOT EXISTS character_consistency_results (
        id integer PRIMARY KEY AUTOINCREMENT,
        run_id integer NOT NULL REFERENCES pipeline_runs(id),
        entity_id integer NOT NULL REFERENCES characters(id),
        episode_idx integer DEFAULT 0 NOT NULL,
        score real,
        asset_total integer DEFAULT 0 NOT NULL,
        asset_sampled integer DEFAULT 0 NOT NULL,
        ref_count integer DEFAULT 0 NOT NULL,
        model text,
        provider text,
        note text,
        evaluated_at integer NOT NULL
      )`,
    )
    await sqlite.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_char_consistency_pair ON character_consistency_results (run_id, entity_id)')
    await sqlite.execute('CREATE INDEX IF NOT EXISTS idx_char_consistency_run ON character_consistency_results (run_id)')
  } catch (err) {
    log.warn(`ensureTable failed: ${(err as Error).message}`)
  }

  // 风格预设负向约束词：style_presets.negative（存量行 NULL = 未配置负向词）
  // SQLite 的 ADD COLUMN 无 IF NOT EXISTS 语法，先查列存在性再补，列已存在（迁移已应用）即跳过
  const spCols = await sqlite.execute("PRAGMA table_info('style_presets')")
  const spHas = new Set((spCols.rows as unknown as Array<{ name: string }>).map((r) => r.name))
  if (!spHas.has('negative')) {
    try {
      await sqlite.execute('ALTER TABLE style_presets ADD COLUMN negative text')
      log.info('ensureColumn: style_presets.negative 已补齐')
    } catch (err) {
      log.warn(`ensureColumn failed: ${(err as Error).message}`)
    }
  }
}
