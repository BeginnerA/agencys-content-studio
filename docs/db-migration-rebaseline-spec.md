# DB 迁移体系 re-baseline 规格（M1 审计整改 · 待拍板）

> 状态：**提案 / 待决策**（未执行）。本文件是审计项 M1「DB 迁移体系漂移」的取证 + 路线权衡 + 推荐执行方案。
> 因涉及**不可逆** schema 变更且**存在真实数据**（`data/studio.db` 8.3MB + WAL 4MB），须由用户拍板选定路线后方可实施。实施前**强制备份**。

## 1. 问题陈述（取证）

当前存在**两套并行、彼此漂移的 schema 真源**：

| 真源 | 位置 | 现状 |
|---|---|---|
| 声明式 | `apps/server/src/db/schema.ts` | **32 张表**（`sqliteTable`），随功能演进持续更新，是代码实际读写的形状 |
| 版本化迁移 | `apps/server/drizzle/0000_typical_nova.sql` + `meta/` | **仅 1 份基线、14 张表**；M7→M51 期间**无任何后续迁移文件** |
| 命令式兜底 | `ensureSchemaColumns()`（`apps/server/src/db/index.ts` L51-581，约 530 行） | **20 条 `ALTER TABLE ADD COLUMN` + 18 张 `CREATE TABLE IF NOT EXISTS`** + 索引，每次启动全量重放（幂等，失败仅 `log.warn`） |

`initDb()` 顺序：PRAGMA → `migrate(0000)` → `ensureSchemaColumns()` → `seed*`。即：**新库先落到 14 表旧形状，再由手写兜底当场补齐到 32 表 + 附加列**。

**漂移面（0000 基线未覆盖、仅存在于 schema.ts + 兜底代码）**：
- **18 张新表**：canvases / canvas_nodes / canvas_edges / canvas_groups / canvas_snapshots / style_presets / series / episodes / voice_clones / schedules / budget_alerts / workflows / content_versions / exec_snapshots / exec_inputs / rework_requests / creation_sessions / creation_messages
- **20 个新列**：pipeline_runs{template_snapshot, workflow_id, workflow_seq, resumed_from_run_id} / api_providers{vendor} / api_configs{credential_id, pricing} / characters{kind, states, voice_desc} / gen_tasks{canvas_node_id} / canvas_nodes{adopted_task_id, seq, group_id} / canvases{deleted_at} / canvas_groups{parent_id} / publications{title, ab_group} / assets{embedding, embedding_model}

## 2. 风险（为何要整改）

1. **无单一真源保证**：`schema.ts` 与 `drizzle/` 迁移历史**不再等价**；有效库形状只由手写兜底维持，没有任何机械校验证明「schema.ts == 实际 DB」。
2. **兜底会撒谎**：`ensureSchemaColumns` 失败仅 `warn` 不阻断，缺表/缺列可能在运行期以奇怪方式暴露（如 ledger 查询 fail-closed）。
3. **`drizzle-kit generate` 现已不可安全使用**：一旦触发会生成巨大的 `0001`，其 `CREATE TABLE`/`ALTER` **不带 `IF NOT EXISTS`**，对该**已有 8MB 真实库**在启动重放时**第一张已存在表即报错**（除非操纵 `__drizzle_migrations` 账本）。
4. **认知负担**：新人无法从迁移历史读出完整 schema，只能读 530 行命令式代码。

## 3. 约束与既定口径（记忆背书）

- 部署形态：**本地单机 SQLite**（libsql file:），无多环境/远端需同步 → 版本化迁移的「跨环境有序重放」价值低。
- 既定策略（Drizzle 迁移合并记忆）：本地单机**推荐合并为单一初始 SQL**，`ensureSchemaColumns` 已幂等、宜保留为**运行期兜底**而非唯一真源。
- 所有漂移列均为**可空或带 DEFAULT** 的纯加法（无破坏性改列/删列/数据迁移）→ re-baseline 本质是「把既有事实形状固化成一份权威基线」，**不改数据**。
- 用户规范：**不自动 commit/push**；不可逆变更先拍板；动手前全量同类审计一次收口。

## 4. 候选路线

### 方案 A（推荐）· 单一合并基线 + 保留幂等兜底
- **做法**：删除 `drizzle/` 现有 `0000` + `meta`；用 `drizzle-kit generate` 从当前 `schema.ts` **一次性生成代表全部 32 表 + 全部列的单份初始迁移**（记为 `0000_rebaseline`）；`ensureSchemaColumns()` **降级为纯兜底**（保留 `IF NOT EXISTS` / `has-column` 守卫，删除与基线重复的建表/加列注释语义，仅作防呆）；对**存量库**通过重置 `__drizzle_migrations` 账本（或 `migrate` 前先探测基线表已存在则标记 applied）使其接受新基线而不重复执行。
- **存量库处置**：因新基线含 `CREATE TABLE`（无 IF NOT EXISTS），对已有表会报错 → 采用「账本认领」：清库内旧 `__drizzle_migrations` 行、插入新基线哈希为已应用；或让 `migrate()` 外层 try/catch 捕获「table exists」并按已应用处理（现基线已是此宽容模式）。**实施前整库备份**，任何偏差可回滚。
- **优点**：schema.ts = 唯一真源；一份可读权威基线；保留兜底防呆；契合单机既定策略；改动最小、风险可控。
- **缺点**：需一次性操纵迁移账本（已在备份 + 可逆前提下）。

### 方案 B · 增量补齐（append-only 历史）
- **做法**：保留 `0000`，`drizzle-kit generate` 产出 `0001_*.sql` 承载 18 表 + 20 列漂移；逐条改为幂等（`IF NOT EXISTS`）以兼容存量库；随后删除 `ensureSchemaColumns` 中与迁移重复的守卫。
- **优点**：保留完整版本化历史。
- **缺点**：生成 SQL 默认非幂等，存量库重放易炸；drizzle 的 ALTER/CREATE 顺序与既有兜底重叠需手工调和；对单机是过度工程。

### 方案 C · 声明式 `db:push` 为唯一真源
- **做法**：删除迁移文件与 `ensureSchemaColumns`，标准化 `drizzle-kit push`（diff schema.ts → DB）。
- **优点**：心智最简单，无历史包袱。
- **缺点**：放弃任何迁移留痕/受控顺序；`push` 直接改真实库、误操作不可逆且无脚本审阅点；与「保留幂等兜底」的稳健性相悖。

## 5. 推荐与理由

**推荐方案 A**。理由：与本地单机形态、既有「合并为单一初始 SQL + 保留幂等兜底」策略一致；把「事实形状」固化为一份权威 `schema.ts`→迁移，消除双真源漂移，同时用轻量幂等兜底继续防呆；改动面与风险最小，且在备份前提下可逆。

## 6. 实施步骤（拍板后，方案 A）

1. **备份**：停服 → 复制 `data/studio.db`(+wal/shm) 到 `data/backup-<ts>/`（或 `sqlite3 .backup`）。
2. **生成基线**：`pnpm --filter @acs/server db:generate`（先临时移除/中和 `ensureSchemaColumns` 的建表副作用以让 drizzle 从空 meta 全量生成），得到单份 `0000_rebaseline.sql`；人工核对其涵盖 32 表 + 全部漂移列 + 索引，且**无数据破坏语句**。
3. **存量库认领**：编写一次性脚本，重置 `__drizzle_migrations` 账本为新基线哈希标记为已应用（存量库物理形状已 = 基线，无需真正重跑 DDL）。
4. **兜底降级**：保留 `ensureSchemaColumns()` 但精简为「只防呆、注释指向基线为真源」；`initDb` 顺序不变。
5. **验证**（全部须 EXIT=0）：
   - 全新库冒烟：删隔离临时库 → `initDb` → 32 表齐全（复用探针 `isolatedEnv`）。
   - 存量真库冒烟：备份还原环境启动 → `migrate` 不报错、账本一致、无重复建表。
   - 全量 `run-probes`（现基线 4244 断言 / 46 探针）零新增失败；`probe-m26` 红线/集合相等绿。
   - `pnpm -r typecheck`（server tsc + web vue-tsc）EXIT=0。
6. **交付**：改动留工作树供用户审阅，**不自动 commit/push**。

## 7. 回滚

任一步骤异常 → 还原第 1 步备份文件即恢复原状；迁移文件与代码改动经 git 可逆（本规格不改动运行时代码直至拍板）。

## 8. 明确不做（本规格范围外）

- 不做任何**破坏性**列改造（无重命名/类型收窄/删除）——所有漂移皆纯加法。
- 不引入数据迁移脚本（无数据形态变更需求）。
- 不在拍板前执行任何一条 DDL 或账本操纵。
