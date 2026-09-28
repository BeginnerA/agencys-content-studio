// 一次性取证脚本（M1 re-baseline 验证用，验证后删除）
// 用法: node _db_inspect.cjs <path-to-studio.db>
const { createClient } = require('@libsql/client');
const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2];
if (!target) { console.error('need db path'); process.exit(2); }

(async () => {
  const c = createClient({ url: 'file:' + path.resolve(target) });
  const tables = (await c.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  )).rows.map((r) => r.name);
  console.log('TABLE_COUNT=' + tables.length);
  console.log('TABLES=' + tables.join(','));
  for (const tb of ['projects', 'assets', 'pipeline_runs', 'pipeline_steps', 'gen_tasks', 'creation_sessions', 'characters', 'settings']) {
    if (!tables.includes(tb)) { console.log('rows.' + tb + '=ABSENT'); continue; }
    const n = (await c.execute('SELECT count(*) AS c FROM `' + tb + '`')).rows[0].c;
    console.log('rows.' + tb + '=' + n);
  }
  const hasLedger = (await c.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'"
  )).rows.length > 0;
  console.log('has_driz_ledger=' + hasLedger);
  if (hasLedger) {
    const l = (await c.execute('SELECT id, substr(hash,1,10) AS h, created_at FROM __drizzle_migrations ORDER BY id')).rows;
    console.log('ledger_rows=' + l.length + ' :: ' + l.map((x) => x.created_at + ':' + x.h).join(' / '));
  }
  // 关键表的列存在性抽查（证明 ensureSchemaColumns 已补齐）
  for (const [tb, col] of [['pipeline_runs', 'resumed_from_run_id'], ['assets', 'embedding'], ['characters', 'voice_desc']]) {
    if (!tables.includes(tb)) continue;
    const cols = (await c.execute("PRAGMA table_info('" + tb + "')")).rows.map((r) => r.name);
    console.log('col.' + tb + '.' + col + '=' + (cols.includes(col) ? 'yes' : 'NO'));
  }
  fs.existsSync(target); // noop keep fs import
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
