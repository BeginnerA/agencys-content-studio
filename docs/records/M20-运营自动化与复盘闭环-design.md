# M20 设计：运营自动化与复盘闭环

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

> 里程碑：M20（2026-09-15 实施完成）｜上游：M4 publications/usage/batches · M14 series/episodes · M8 style_presets · M18 run-preview 定价链
> 性质：**运营自动化与复盘闭环**——三批 8 项一次开发：批 1 排产日历 + 预算熔断 + 定时调度（B1/B4/B5）；批 2 发布回采 + A/B 测试 + 成本聚合（B2/B3/B6）；批 3 复盘 CSV + 导出包平台化（B7/B8）。
> 用户决策：①**排产走轻量自研调度器**（60s 轮询 + 幂等触发，红线内不引重型引擎）；②**预算仅做读取+比对+告警**（不改执行语义，前端预检 + 异步告警双通道）；③**A/B 测试用 ab_group 文本字段标记**（非独立实验表，复用 publications 表）；④**平台预设存 settings KV**（与 brand/compose-config 同模式）。
> 红线影响：+2 表（schedules / budget_alerts，均平台级通用）；publications +2 列（title / ab_group）；settings +2 key（budgets / export_presets）；零新依赖；不改引擎执行语义；不引重型编排/任务引擎。
> **注意**：本文档为事后归档（as-built），基于代码逆向整理，非开工前 L1 spec。

---

## §1 背景与目标

### 1.1 现状（勘察结论）

| 批次 | 现状缺口 |
|---|---|
| 排产/调度 | **排产日历缺失**（M14 §8 排除项）：无项目/剧集级计划表，批量运行全靠手工触发；**定时调度未做**（M4 Backlog）：无时点触发能力 |
| 预算/成本 | **预算熔断缺失**（M18 评审）：run-preview 仅做预估，无预算设置与拦截；**跨项目成本聚合缺失**（Backlog）：usage 仅有单项目/单 run 维度，无 provider × 项目 × kind 多维分解 |
| 发布/复盘 | **发布数据全手工**（M4 评审）：publications API 存在但回填全靠手工逐条；**A/B 测试缺失**（M18 评审）：无分组标记与对比视图；**复盘 CSV 缺失**（M4 Backlog）：无导出分析能力；**导出包平台化缺失**（M4 Backlog）：导出无平台规格预设 |

### 1.2 目标

1. **排产日历**：项目级计划表（月历视图 + CRUD + 状态管理 pending/triggered/completed/cancelled/failed），到期自动创建 batch。
2. **预算熔断**：全局 + 项目级预算配置（月度/总计），run 创建前预检 + 超阈告警（24h 去抖），告警留痕可查。
3. **发布回采**：批量导入（JSON/CSV，≤200 条/次）+ 按日聚合趋势视图。
4. **A/B 测试**：publications 增加 ab_group 字段 + 分组聚合对比视图。
5. **成本聚合**：三维度并行分解（provider_model / project / kind），时间窗口可选。
6. **复盘 CSV**：运行记录 / 发布数据 / 用量成本三类 CSV 导出 + 趋势对比基线（当前周期 vs 上一周期）。
7. **导出包平台化**：平台预设 CRUD（画幅/时长/命名/封面/字幕/水印），内置 5 大平台默认预设。

---

## §2 范围

### 2.1 数据模型变更

#### 2.1.1 新表 `schedules`（排产计划主表）

```ts
// schema.ts — schedules
id: integer PK autoIncrement
projectId: integer NOT NULL          // 关联 projects
name: text NOT NULL                  // 计划名（用户可读）
templateKey: text NOT NULL           // 触发时使用的模板 key
cronExpr: text NOT NULL              // 预留；v1 固定为 'once'（一次性定时）
scheduledAt: integer NOT NULL        // 计划触发时间（unix ms）
status: text NOT NULL DEFAULT 'pending'  // pending|triggered|completed|cancelled|failed
lastTriggeredAt: integer             // 最后触发时间
lastBatchId: integer                 // 触发后创建的 batch id
inputTemplate: text NOT NULL DEFAULT '{}'  // JSON：批量输入模板（触发时展开为多组输入）
note: text
isActive: integer NOT NULL DEFAULT 1
createdAt / updatedAt

索引：idx_schedules_project(projectId) / idx_schedules_status(status) / idx_schedules_scheduled(scheduledAt)
```

#### 2.1.2 新表 `budget_alerts`（预算告警记录）

```ts
// schema.ts — budget_alerts
id: integer PK autoIncrement
scope: text NOT NULL                 // project|global
scopeId: integer                     // projectId（global 为 null）
kind: text NOT NULL                  // monthly|total
budget: real NOT NULL
spent: real NOT NULL
ratio: real NOT NULL
createdAt: integer NOT NULL

索引：idx_budget_alerts_scope(scope)
```

#### 2.1.3 `publications` 表扩展（+2 列）

```ts
title: text                          // [M20] 发布标题（A/B 测试识别用）
abGroup: text                        // [M20] A/B 测试分组标记（自由文本）
```

#### 2.1.4 `settings` 表新增 key

| key | value 格式 | 用途 |
|---|---|---|
| `budgets` | JSON `BudgetConfig` | 预算配置（全局 + 项目级 + 告警比例） |
| `export_presets` | JSON `Record<string, ExportPreset>` | 平台导出预设 |

### 2.2 后端 API 设计

#### 2.2.1 排产计划（routes/schedules.ts）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/schedules?project_id=&status=` | 列表（≤200） |
| GET | `/schedules/calendar?project_id=&from=&to=` | 日历视图（含关联 batch 状态） |
| GET | `/schedules/:id` | 详情 |
| POST | `/projects/:id/schedules` | 创建计划（body: name/template_key/scheduled_at/input_template/note） |
| POST | `/schedules/:id/cancel` | 取消（仅 pending） |
| POST | `/schedules/:id/reset` | 重置为 pending（triggered/failed/cancelled 可重置） |
| DELETE | `/schedules/:id` | 删除（pending 需先取消） |

#### 2.2.2 预算（routes/schedules.ts 同文件）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/budget` | 预算概览（配置 + 各项目/全局使用率） |
| PUT | `/budget` | 保存预算配置 |
| GET | `/budget/alerts?project_id=` | 告警历史（≤50） |
| POST | `/budget/check` | 手动预检（body: project_id/estimated_cost；返回 allowed/reason） |
| POST | `/budget/check-alerts` | 手动触发告警检查（body: project_id） |

#### 2.2.3 发布增强（routes/publications.ts）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/publications/batch` | 批量导入（body: items 数组 ≤200 条；跳过非法行，不整体回滚） |
| GET | `/publications/trend?project_id=&days=` | 按日聚合趋势（days: 7–365，默认 30） |
| GET | `/publications/ab-groups?project_id=` | A/B 分组聚合对比 |
| GET | `/publications?ab_group=` | 列表增加 ab_group 筛选 |

#### 2.2.4 统计增强（routes/stats.ts）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/stats/cost-breakdown?from=&to=` | 三维度成本分解（并行查 provider_model/project/kind） |
| GET | `/stats/csv/runs?project_id=&from=&to=` | 运行复盘 CSV（≤5000 行） |
| GET | `/stats/csv/publications?project_id=` | 发布复盘 CSV（≤5000 行） |
| GET | `/stats/csv/usage?project_id=&from=&to=&group_by=` | 用量 CSV |
| GET | `/stats/compare?days=&project_id=` | 趋势对比（当前周期 vs 上一周期） |

#### 2.2.5 导出预设（routes/exports.ts）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/exports/presets` | 获取预设列表（含 defaults 标记） |
| PUT | `/exports/presets` | 全量覆盖预设（body: items 数组） |

### 2.3 后端服务层

#### 2.3.1 `services/schedule.ts`（排产调度服务）

- **调度器生命周期**：`startScheduler()` / `stopScheduler()`
  - 60s `setInterval` 轮询（`TICK_INTERVAL = 60_000`）
  - 启动后立即 `tick()` 一次（崩溃恢复：覆盖停机窗口内到期计划）
  - 幂等启动（重复调用只启动一次）
- **tick()**：查找到期 pending 计划（`scheduledAt ≤ now && isActive=1`），按 scheduledAt 升序，单轮最多 20 条（防风暴），逐条调用 `triggerSchedule()`
- **triggerSchedule(id)**：
  1. 幂等锁：查 status='pending' && isActive=1，不满足则跳过
  2. 解析 `inputTemplate` JSON → 输入数组
  3. 校验项目存在且未删除
  4. 调用 `createBatch()` 创建批次（name 前缀 `[排产]`）
  5. 更新 status='triggered' + lastTriggeredAt + lastBatchId
  6. emit `schedule.triggered` 事件
  7. 失败则 status='failed'
- **CRUD 辅助**：`listSchedules` / `getSchedule` / `createSchedule` / `cancelSchedule`（仅 pending）/ `resetSchedule`（triggered/failed/cancelled → pending，清空 lastTriggeredAt/lastBatchId）/ `deleteSchedule`（pending 需先取消）
- **日历视图**：`scheduleCalendar({ projectId, from, to })` — 查窗口内计划 + 关联 batch 状态

#### 2.3.2 `services/budget.ts`（预算熔断服务）

- **存储**：`settings` 表 key=`budgets`，JSON 格式 `BudgetConfig`
- **`loadBudget()`**：读取配置（缺失/损坏 → 空配置 = 不限制）
- **`saveBudget(cfg)`**：upsert 配置
- **`getSpent({ projectId?, monthly })`**：从 `usageRecords` 聚合已花费成本（monthly=true 时取当月 1 日起）
- **`checkBudget({ projectId, estimatedCost })`**：预检（返回 null=通过 / {code, message}=拦截）
  - 检查顺序：项目月度 → 项目总计 → 全局月度
  - 逻辑：spent ≥ limit × alertRatio 时进入告警区，再判断 spent + estimated > limit 则拦截
- **`checkAlerts({ projectId })`**：异步告警（不阻断流水线）
  - 收集需检查的 scope+kind 组合
  - 超阈写入 `budget_alerts` 表
  - **24h 去抖**：同 scope+kind+scopeId 24h 内不重复告警
  - emit `budget.alert` 事件
- **`listAlerts({ projectId? })`**：告警历史（≤50）
- **`budgetOverview()`**：前端预算面板消费（配置 + 各项目/全局使用率计算）

### 2.4 前端组件

#### 2.4.1 统计主页面增强（views/stats/index.vue）

- 新增 Tab：排产 / 预算 / 发布 / 成本 / 复盘（原有概览 Tab 保留）
- 按 activeTab 懒加载对应子组件

#### 2.4.2 `ScheduleCalendar.vue`（排产日历，B1）

- **月历视图**：7×6 网格（日一二三四五六），前/后月补齐
- **导航**：上/下月 + 今天 + 项目筛选
- **日历单元格**：显示当日计划项（名称 + 项目名 + 状态色），点击已触发计划跳转 batch
- **状态色**：pending=蓝 / triggered=紫 / completed=绿 / cancelled=灰 / failed=红
- **操作**：pending→取消 / triggered/failed/cancelled→重置或删除
- **新建计划弹窗**：
  - 选项目 + 选模板 + DatePicker（含时间选择）+ 备注
  - 模板切换时动态加载 inputs 定义 + 预填默认值
  - **多组输入支持**：添加/删除输入组，每组对应触发后的一次 run
  - 序列化为 `inputTemplate` 数组提交

#### 2.4.3 `BudgetPanel.vue`（预算面板，B4）

- **概览模式**：进度条展示全局月度 + 各项目月度/总计使用率（颜色编码：绿<50% / 蓝<80% / 橙<100% / 红≥100%）
- **告警历史**：最近 5 条告警（范围 + 类型 + 比例 + 时间）
- **编辑模式**：全局月度/总上限 + 告警阈值比例 + 项目级预算逐项设置

#### 2.4.4 `PublicationPanel.vue`（发布面板，B2/B3）

- **三个子视图**：列表 / 趋势 / A/B 对比
- **列表视图**：表格（标题/平台/A-B 组/播放/互动/发布时间/项目）+ 批量导入弹窗
- **批量导入**：支持 JSON 数组 / CSV（首行 header），解析后调 `publicationApi.batch()`
- **趋势视图**：SVG 柱状图（播放量趋势）+ 表格（日期/发布数/播放/互动），7/30/90 天可选
- **A/B 对比视图**：表格（分组/发布数/总播放/总互动/均播放/均互动/平台分布）

#### 2.4.5 `CostPanel.vue`（成本聚合面板，B6）

- **三维度展示**：按模型（provider:model 表格）/ 按项目 / 按类型（chips）
- **时间窗口**：7/30/90 天切换
- **合计行**：总成本 + 未计价条数标记
- **占比条**：mini-bar 可视化

#### 2.4.6 `ReviewPanel.vue`（复盘面板，B7）

- **CSV 导出按钮组**：运行记录 / 发布数据 / 用量成本（直链后端 CSV 端点）
- **趋势对比基线**：6 张卡片（运行总数/成功率/总成本/发布数/播放量/互动量），每张展示当前值/上期值/差值（颜色编码：正向绿/负向红）
- **时间窗口**：7/30/90 天 + 项目筛选

#### 2.4.7 `PlatformPresets.vue`（平台预设管理，B8）

- **查看模式**：表格（平台/画幅/最长时长/命名规则/封面/字幕/水印）
- **编辑模式**：逐平台编辑（标识/名称/画幅选择/时长/命名规则/复选项）+ 添加/删除平台
- **内置默认预设**：抖音(9:16/60s) / 视频号(9:16/180s) / 快手(9:16/120s) / 小红书(4:5/60s) / B站(16:9/600s)

### 2.5 前端类型定义

#### `lib/types/schedule.ts`

```ts
ScheduleStatus = 'pending' | 'triggered' | 'completed' | 'cancelled' | 'failed'
Schedule { id, projectId, name, templateKey, cronExpr, scheduledAt, status, lastTriggeredAt, lastBatchId, inputTemplate, note, isActive, createdAt, updatedAt }
ScheduleCalendarItem { id, projectId, name, templateKey, scheduledAt, status, lastBatchId, batchStatus, note }
BudgetConfig { projects?: Record<string, { monthly?, total? }>, global?: { monthly?, total? }, alertRatio? }
BudgetUsage { budget, spent, ratio }
BudgetProjectOverview { projectId, monthly: BudgetUsage, total: BudgetUsage }
BudgetOverviewResult { config: BudgetConfig, projects: BudgetProjectOverview[], global: { monthly: BudgetUsage | null } }
BudgetAlert { id, scope, scopeId, kind, budget, spent, ratio, createdAt }
```

#### `lib/types/publications.ts`

```ts
PublicationTrendItem { day, count, views, interactions }
AbGroupItem { group, count, views, interactions, platforms, avgViews, avgInteractions }
CostBreakdown { byProviderModel, byProject, byKind, totals }
CostItem { key, quantity, cost, unpriced, count }
CostTotals { quantity, cost, unpriced }
CompareResult { days, current, previous, delta }
ExportPreset { platform, label, aspect, maxDuration, namingPattern, includeCover, includeSubtitle, watermark? }
```

### 2.6 事件扩展

| 事件类型 | 载荷 | 触发时机 |
|---|---|---|
| `schedule.triggered` | `{ scheduleId, projectId, batchId }` | 排产计划触发创建 batch 后 |
| `budget.alert` | `{ alertId, projectId, scope, kind, ratio }` | 预算超阈告警写入后 |

---

## §3 明确排除

| 排除项 | 原因 |
|---|---|
| 通用 cron 引擎 | 红线「不引重型编排/任务引擎」；v1 用 60s 轮询 + 一次性定时替代 |
| 独立实验表（A/B 测试） | 纲领范围用 ab_group 文本标记即可，无需独立实验管理表 |
| 预算自动拦截执行 | 预算仅做预检+告警，不改 run 创建执行语义（前端拿到 allowed=false 自行决策） |
| 发布数据自动回采（API 对接平台） | 本地单机定位，不做外部平台 API 对接；批量导入为手工粘贴 JSON/CSV |
| 排产周期性重复（cron 表达式） | v1 仅一次性定时（cronExpr 预留字段固定为 'once'），后续里程碑可扩展 |
| 导出预设实际驱动合成链 | v1 预设为配置管理 UI，不与 M19 多画幅/水印合成链自动联动 |
| CSV 服务端分页 | 硬限 5000 行，满足单机规模；不做流式/游标分页 |

---

## §4 与纲领偏差对照

| 纲领项 | 纲领描述 | 实际实施 | 偏差说明 |
|---|---|---|---|
| B1 排产日历 | 项目/剧集级计划表 + 轻量自研调度器 | ✅ 完全对齐 | 月历视图 + 60s 轮询调度器 + 幂等触发 |
| B2 发布回采 | 批量导入/表格/剪贴板 + 趋势视图 + 回填提醒 | ✅ 基本对齐 | JSON/CSV 批量导入 + 按日聚合趋势；**回填提醒未做**（UI 提示由用户自行查看） |
| B3 A/B 测试 | 多变体/多标题分组标记 + 效果对比视图 | ✅ 完全对齐 | ab_group 字段 + 分组聚合对比（count/views/interactions/avgViews/avgInteractions/platforms） |
| B4 预算熔断 | 项目/月度预算 + run 预检拦截 + 超阈告警 | ✅ 完全对齐 | 预检返回 allowed/reason 供前端决策；告警 24h 去抖 + 事件推送 |
| B5 定时调度 | 定时调度能力 | ✅ 完全对齐 | 60s 轮询 + 启动即 tick（崩溃恢复） |
| B6 成本聚合 | 跨项目聚合面板 + 维度拆解 | ✅ 完全对齐 | 三维度并行（provider_model/project/kind），时间窗口 7/30/90 天 |
| B7 复盘 CSV | 复盘视图增强 + CSV 导出 | ✅ 完全对齐 | 三类 CSV（runs/publications/usage）+ 趋势对比基线（当前 vs 上期） |
| B8 导出包平台化 | 按平台导出规格预设 | ✅ 完全对齐 | 5 大平台默认预设 + CRUD + settings KV 存储 |

---

## §5 文件清单

### 5.1 新增文件（10 个）

| 文件 | 行数 | 功能 |
|---|---|---|
| `apps/server/src/services/schedule.ts` | 254 | 排产调度服务 |
| `apps/server/src/services/budget.ts` | 266 | 预算熔断服务 |
| `apps/server/src/routes/schedules.ts` | 204 | 排产 + 预算 REST 端点 |
| `apps/web/src/views/stats/ScheduleCalendar.vue` | 471 | 排产日历视图 |
| `apps/web/src/views/stats/BudgetPanel.vue` | 239 | 预算面板 |
| `apps/web/src/views/stats/PublicationPanel.vue` | 283 | 发布数据面板 |
| `apps/web/src/views/stats/CostPanel.vue` | 141 | 成本聚合面板 |
| `apps/web/src/views/stats/ReviewPanel.vue` | 170 | 复盘面板 |
| `apps/web/src/views/stats/PlatformPresets.vue` | 150 | 平台预设管理 |
| `apps/web/src/lib/types/schedule.ts` | 68 | 排产 + 预算类型 |

### 5.2 修改文件

| 文件 | 变更 |
|---|---|
| `apps/server/src/db/schema.ts` | +schedules 表 / +budget_alerts 表 / publications +title +abGroup |
| `apps/server/src/routes/publications.ts` | +batch / trend / ab-groups 端点 / publications +title +abGroup 字段 |
| `apps/server/src/routes/stats.ts` | +cost-breakdown / csv/runs / csv/publications / csv/usage / compare 端点 |
| `apps/server/src/routes/exports.ts` | +presets GET/PUT 端点 + DEFAULT_PRESETS |
| `apps/web/src/views/stats/index.vue` | +排产/预算/发布/成本/复盘 Tab |
| `apps/web/src/lib/types/publications.ts` | +PublicationTrendItem / AbGroupItem / CostBreakdown / CompareResult / ExportPreset |
| `apps/web/src/lib/api.ts` | +scheduleApi / budgetApi / publicationApi 增强 / statsApi 增强 / exportApi |
| `apps/web/src/components/common/DatePicker.vue` | +withTime 时间选择支持 |

---

## §6 建议验收方向

| 功能项 | 验收方向 |
|---|---|
| B1 排产日历 | ①月历视图 DOM 渲染（前/后月补齐、状态色矩阵）②创建计划 → pending → 60s 内自动触发 → batch 创建留痕 ③取消/重置/删除状态机矩阵 ④崩溃恢复：重启后立即 tick 到期计划 |
| B2 发布回采 | ①JSON 批量导入 200 条 → count 对账 ②CSV 导入（header 映射 + 非法行跳过）③趋势视图按日聚合正确性 |
| B3 A/B 测试 | ①ab_group 字段写入/查询 ②分组聚合对比数据（avgViews/avgInteractions 计算正确性）③平台分布去重 |
| B4 预算熔断 | ①预算配置 CRUD + settings KV 持久化 ②预检拦截矩阵（spent + estimated > limit → allowed=false）③告警 24h 去抖（同 scope+kind 不重复写入）④告警事件 emit 留痕 |
| B5 定时调度 | ①startScheduler 幂等启动 ②stopScheduler 优雅关闭 ③单轮 20 条上限（防风暴） |
| B6 成本聚合 | ①三维度并行查询结果正确性 ②时间窗口边界（7/30/90 天）③totals 与 byProviderModel.totals 同源 |
| B7 复盘 CSV | ①三类 CSV 内容-数据库行对账 ②CSV 转义（逗号/引号/换行）③趋势对比 delta 计算正确性 |
| B8 导出包平台化 | ①默认预设 5 项完整性 ②CRUD → settings KV 持久化 ③自定义平台添加/删除 |
