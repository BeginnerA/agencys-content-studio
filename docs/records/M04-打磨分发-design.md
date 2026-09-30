# agencys-content-studio M4 技术设计规格（打磨分发）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-10
- 上游：`2026-09-09-agencys-content-studio-roadmap.md`（M4 行：批量生成、成本控制、导出分发、复盘数据；出口问题：是否达到个人主力工具标准）
- M3 review 输入：`2026-09-10-agencys-content-studio-m3-review.md`（§M4 spec 输入：音频情绪实例接入、三层记忆/摘要压缩、角色语义检索/参考图 i2i、一致性 A/B 评测；继承：多集批量编排、平台级成本统计）
- 红线（ROADMAP 引用）：不引重型编排/任务引擎（自研状态机，直到 M4 review 证明不够用）；不做体裁专属表（batches/usage_records/publications 均为通用表）；本地单机与 SQLite 零运维不回退；Electron/画布仍未引入；批量/成本/导出/复盘均为平台级工具能力，不引入体裁逻辑

---

## 1. 定位与 M4 边界

### 1.1 一句话目标

把平台从「单次流程引擎」打磨为「**可规模量产 + 可核算成本 + 可对外交付 + 可复盘数据**」的个人主力工作台：多集/多篇内容一次提交批量跑（含失败容错与恢复）、每笔 API 消耗有账可查（token/张/秒/字符）、成片一键打包成发布包（zip + manifest）、运行数据与发布表现汇入统计看板。出口回答：是否达到个人主力工具标准（打开频率/单项目完成率）？

### 1.2 M4 范围（做）

| # | 主项 | 内容 |
|---|---|---|
| E1 | 批量运行 | `batches` 表 + `pipeline_runs.batch_id/batch_seq` + 调度服务（串行默认，可配并发 1–3）+ 批量创建（输入组数组）+ 批次详情页 + 取消 + 崩溃恢复对齐 |
| E2 | 成本与用量 | `usage_records` 通用表 + `llm.ts` usage 解析（零破坏）+ 4 处 action 埋点（llm/image/video/tts）+ `settings.pricing` 单价配置 + 聚合 API + 未计价提示 |
| E3 | 导出分发 | 发布包 zip（manifest.json + 分目录文件，`purpose='export'` 资产 + `assets.run_id`）+ 单 run 导出向导（资产勾选）+ 批量导出（按 run 全量）+ 下载复用现有文件端点 |
| E4 | 复盘数据 | `/stats` 运行统计看板（概览/30 天趋势/成本构成/项目表）+ `publications` 发布登记（平台/链接/手工指标）+ 项目页发布记录 |
| W1 | Web 配套 | 统计页、批次详情页、导出向导弹窗、发布登记弹窗、Settings 单价编辑器、导航/路由扩展 |
| V1 | 验证 | §8 验收 10 条 + README 更新 |

### 1.3 M4 不做（明确排除）

| 排除项 | 去向 |
|---|---|
| 三层记忆/摘要压缩、一致性 A/B 评测、音频情绪实例接入、角色语义检索/参考图 i2i | M3 review 沉淀 backlog（本 M4 聚焦「分发与复盘」主线，新需求走北极星三问） |
| 平台数据 CSV 批量导入与分析（media-review 平移：字段映射/互动率口径/review_summary） | 留在 Skills 层——用户实际闭环已成立（`内容创作/萌宝IP/input/review/数据回灌说明.md`：导出 CSV → 「盘点」→「复盘出题」）；studio 只做最小发布登记，不重复造分析器 |
| 批次级重跑（失败集一键重跑、批次重试聚合） | Backlog——单 run「断点续跑」已覆盖；批次视图展示失败数与跳转 |
| 定时/触发式调度（cron 自动起批次） | Backlog（无需求证据；手动批量已是 10x 提升） |
| 导出包平台专属格式/压缩比优化/分包 | Backlog（先做通用 zip store 包） |
| 多用户/登录/权限/云同步 | 红线（永久排除） |
| 批次编辑/删除、run 批量删除（历史只读） | 不做 |

---

## 2. 技术决策总览（决策完备）

| 决策点 | 结论 | 理由 / 否决项 |
|---|---|---|
| 批量模型 | `batches` 通用表 + `pipeline_runs.batch_id/batch_seq`；批次是 run 之上的「编排层」，引擎保持 run 级不变 | 否决「剧集表/剧集批量字段」（红色：体裁专属表）；否决把批次塞进引擎（引擎只认 run，职责不混） |
| 批次调度 | **串行默认**（`max_concurrent` 默认 1，可配 1–3）；事件钩子推进 + 启动时 reconcile | 否决并行默认（N 个 run × 引擎内 ≤2 并发 → API 压力与成本失控）；上限 3 = 最坏 6 并发任务，可控 |
| engine 改动 | **唯一改动**：新增 `onRunSettled(cb)` 注册口，在 run 四个终态出口（completed / 失败收敛 / 链级兜底 / cancelRun）通知监听者（try/catch 包裹，异常不影响主流程） | 调度逻辑零改动；依赖方向 batch → engine 单向，无循环导入 |
| 调度幂等 | `notifyRunSettled` 每次**从 DB 重算**批次计数与活跃数（重算式天然幂等）+ 批内模块级互斥（`pumps: Set<batchId>`）防并发重入 | 事件可能重复/并发；重算避免计数漂移 |
| 成本模型 | `usage_records` 通用表：kind / provider / model / quantity / unit / unitPrice / cost / currency / meta + 归属（project/run/step/task/asset） | 否决把成本塞 `gen_tasks`（LLM/TTS 无 task 行）；单价**记录时快照**，改价不篡改历史账 |
| LLM 用量 | `llm.ts` 增 `chatCompleteDetailed()`（返回 `{content, usage, provider, model}`）；`chatComplete` 变薄封装（**零破坏**）；用量写入由 action 层完成 | 否决在 llm.ts 内部记录（无 run/step 上下文）；`resolveLlmEndpoint` 增返 `providerKey`（记录 provider 标识） |
| Token 计价 | 每次 LLM 调用写 **2 行**（`unit=tokens_in` / `tokens_out`）；媒体按 `image`（张）/ `second`（秒）/ `char`（千字符）计 | 输入/输出单价差异大（如 1 元 vs 2 元/M），一行混合价算不准 |
| 单价配置 | `settings` KV（key=`pricing`），Settings 页表格编辑器；查找顺序 `{provider}:{model}` → `{provider}` → 无（cost=NULL 显示「未计价」徽标） | 否决 `api_configs.extra`（定价是账号级而非实例级）；否决独立配置文件（复用 settings 读写链路） |
| 导出包 | zip（**fflate** 流式，store 优先）+ `manifest.json` + 分目录（video/cover/text/other）+ `purpose='export'` 资产（`kind='archive'`） | 一包即发，用户直接上传平台/解压；否决 archiver（依赖树大）/ 手写 zip（维护贵）/ 外部 tar（跨平台差）/ 纯文件夹（桌面端多文件操作烦） |
| 导出包归属 | `assets` 增 `run_id` 列（NULL=非 run 产物）；批量导出按 **run 全部产物**（不做逐 run 勾选） | 单 run 用向导精挑；批量追求「一次拿全」且语义明确（=steps.output 聚合），无需猜测 |
| 复盘范围 | ① **运行统计看板**（工序视角：运行/成本/资产/活跃度）② **发布登记**（内容视角：平台/链接/手工指标） | 出口问题需要「打开频率/完成率」自证数据；内容大数据分析留在 Skills 层（不重复） |
| 发布登记模型 | `publications` 通用表（platform / url / published_at / metrics JSON / note） | metrics 仅存不算（M4 不建指标体系，UI 展示原始值+求和） |
| 前端依赖 | **零新增**（趋势图手绘 SVG 柱状，设置表编辑器复用现有表单形态） | 维持轻前端 |
| 迁移 | drizzle 增 3 表（batches/usage_records/publications）+ 3 列（pipeline_runs.batch_id/batch_seq、assets.run_id）→ `db:push`；沿用 M2「启动时旧库兜底」 | 零停机单文件 SQLite 不变 |
| 新增运行时依赖 | 仅 `fflate`（导出打包） | 纯 JS、~30KB、无原生依赖；其余全部自研 |
| 事件扩展 | `StudioEvent` 增 `{type:'batch.updated'; runId; batchId; projectId; status; finished; total}`（带 runId 以复用现有 room 投递链路） | index.ts 桥接要求事件带 runId；前端批次页收 project room 事件过滤刷新 |

---

## 3. 批量运行（E1）

### 3.1 数据模型（db/schema.ts）

```ts
export const batches = sqliteTable('batches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  templateKey: text('template_key').notNull(),
  name: text('name').notNull(),
  // running|completed|partial_failed|failed|cancelled
  status: text('status').notNull().default('running'),
  schedule: text('schedule').notNull().default('{"max_concurrent":1}'), // JSON
  total: integer('total').notNull().default(0),
  finished: integer('finished').notNull().default(0),   // 终态 run 数（completed+failed+cancelled）
  succeeded: integer('succeeded').notNull().default(0), // completed 数
  failed: integer('failed').notNull().default(0),       // failed 数
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [index('idx_batches_project').on(t.projectId), index('idx_batches_status').on(t.status)])
```

`pipeline_runs` 增：`batchId: integer('batch_id')`（NULL=独立 run）、`batchSeq: integer('batch_seq')`（批内序号，从 1 起）+ `index('idx_runs_batch').on(t.batchId)`。

- 计数列是**冗余缓存**（列表页排序/过滤快），权威值以 notify 重算为准，每次重算后回写。
- 批次名默认 `{模板 name} × {N}`，可改。

### 3.2 调度服务（services/batch.ts，新）

**职责**：创建批次、推进调度、重算统计、取消、启动恢复对齐。

| 函数 | 行为 |
|---|---|
| `createBatch({projectId, templateKey, name?, schedule?, inputs})` | ①逐组输入走 `createRunRow`（§3.4 抽出的共享函数，含归一化/校验/模板快照），status='queued'、挂 batchId/batchSeq ②落 batches 行（total=N）③异步 `pump(batchId)` 启动前 max_concurrent 个 run ④返回 batch + runs 摘要 |
| `notifyRunSettled(runId)` | run 终态通知入口（engine 钩子调用）：读 run.batchId；无 → return；有 → `pump(batchId)` |
| `pump(batchId)` | 模块级互斥（`pumps: Set<number>`，已在跑则跳过）→ 重算 → 推进 → 回写 → `emitStudioEvent({type:'batch.updated',...})` |
| `cancelBatch(batchId)` | 批内 queued run 直接置 cancelled；running/waiting_input 的 run 走 `engine.cancelRun`；批次置 cancelled + 计数回写 |
| `reconcileBatches()` | 启动时对全部 running 批次各 pump 一遍（崩溃恢复后推进） |
| `summarizeBatch(batchId)` | batch + runs 摘要数组（详情页数据源） |

**`pump` 内部判定（每轮重算 → 幂等）**：

1. 读 batch；`status !== 'running'` → return。
2. 聚合批内 runs：`total/finished(completed|failed|cancelled)/succeeded(completed)/failed(failed)`；`active = count(running|waiting_input)`。
3. 若 `finished === total`：终态判定——`succeeded === total → 'completed'`；`succeeded > 0 → 'partial_failed'`；否则 `'failed'`；回写计数与状态，emit 后 return。
4. 空槽 `= max_concurrent - active`；`> 0` 时取 `batchSeq` 最小的 queued run，逐个 `engine.startRun(runId)`（每次启动后 active+1 直至满槽）。
5. 回写计数，emit `batch.updated`。

**边界语义**：
- **gate 挂起 = 批次暂停**：waiting_input 计入 active，槽位不释放，后续 run 不启动（人工闸门优先级最高——与引擎「gate 挂起=run 级暂停」语义一致）。批次页明示「等待人工审阅」。
- run 的「失败」不重试、不中断批次：失败 run 计入 failed，继续推进（`partial_failed` 终态如实呈现）。

### 3.3 engine 挂钩（唯一引擎改动）

```ts
// engine.ts 增
private settledListeners: Array<(runId: number) => void> = []
onRunSettled(cb: (runId: number) => void): void { this.settledListeners.push(cb) }
private notifySettled(runId: number): void {
  for (const cb of this.settledListeners) {
    try { cb(runId) } catch (err) { log.error(`settled listener error: ${(err as Error).message}`) }
  }
}
```

调用点（4 处，均在 run 进入终态之后）：
1. runChain `allDone → completed`（L294 分支末）
2. runChain `失败收敛 → failed`（L250 分支末）
3. runChain 链级兜底 catch → failed（L335-344 末）
4. `cancelRun` 末尾（幂等路径也触发——pump 重算式无副作用）

**接线位置**：`index.ts` 启动时 `engine.onRunSettled((id) => void notifyRunSettled(id))`；随后 `recoverInterruptedState()` → requeue → `reconcileBatches()`。
（注意调用顺序：先注册监听，再 recover/requeue，避免恢复期的 settled 通知落空。）

### 3.4 REST 与批量输入组

```
POST /projects/:id/batches     {template_key, name?, schedule?: {max_concurrent?}, inputs: [ {...}, ... ]}
GET  /batches?project_id=&status=           批次列表（含计数缓存）
GET  /batches/:id                            详情（batch + runs 摘要：id/seq/status/input 摘要/耗时）
POST /batches/:id/cancel                     取消（幂等）
POST /batches/:id/exports                    批量导出（§5.4）
```

**创建请求示例**（短剧 3 集批量）：

```jsonc
{
  "template_key": "mengbao-episode",
  "name": "萌宝镖客·5-7集",
  "schedule": { "max_concurrent": 1 },
  "inputs": [
    { "setting_docs": [12], "episode_number": 5, "with_motion": false },
    { "setting_docs": [13], "episode_number": 6, "with_motion": false },
    { "setting_docs": [14], "episode_number": 7, "with_motion": false }
  ]
}
```

- 校验：`inputs` 非空数组；逐组 `normalizeInput` + `validateRunInput`（复用 `runs.ts` 逻辑，抽为共享函数 `createRunRow({projectId, templateKey, input, batchId?, batchSeq?})` → 建议落位 `apps/server/src/services/run-create.ts`，`runs.ts` 与 `batches.ts` 双用）；报错信息带组号（「第 2 组输入：episode_number 需为整数」）。
- `schedule.max_concurrent` 仅接受 1–3（超限 400）。

**Web 批量表单**：项目页「批量运行」按钮 → 弹窗：模板选择 + 调度（串行/2/3）+ **输入组表格**（行=一组输入；每行按模板 inputs 动态渲染紧凑控件：text/int 输入框、bool 复选框、files 选择器按钮+计数；行操作：复制/删除；底部：添加行/批量粘贴 JSON 入口）。RunFormModal 的字段渲染抽为 `TemplateInputFields.vue`（受控 value/onChange）复用。

**批次详情页** `/batches/:id`：头部（名称/状态徽标/进度条 `finished/total`/调度/取消/「批量导出」）+ runs 表（seq/状态/输入摘要/成本/耗时/跳 run 详情）。

### 3.5 幂等 / 恢复 / 边界

| 场景 | 行为 |
|---|---|
| 服务重启 | recover 把 running run 置 failed(interrupted) → reconcile 时该 run 计入 failed → 批次继续推进剩余 queued（+ 用户可对失败 run 单跑续跑） |
| 批次创建后进程崩溃 | queued run 在 recover 中 requeue（现有逻辑）→ reconcile 按槽位重新约束启动 |
| 重复 settled 通知 | pump 重算式幂等；pumps 互斥防并发重入 |
| 单 run 断点续跑（resume） | 新 run **不挂批次**（独立）——批次统计只反映原始提交；失败 run 的续跑在运行列表可见，批次页提供失败跳转 |
| run 取消（单 run） | 若属批次 → settled 通知 → 批次计入 failed？ **不**：取消计 `finished` 但不计 failed（succeeded/failed 都不 +1），终态判定按 succeeded 占比（全取消 → failed） |
| 空输入组 | 不允许（inputs 至少 1 组） |

---

## 4. 成本与用量（E2）

### 4.1 数据模型（db/schema.ts 增表）

```ts
export const usageRecords = sqliteTable('usage_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  runId: integer('run_id'),        // NULL = 非 run 来源（如连通性测试）
  stepId: integer('step_id'),
  taskId: integer('task_id'),      // gen_tasks.id（图片/视频）
  assetId: integer('asset_id'),    // 产出资产（可溯源）
  kind: text('kind').notNull(),    // llm|image|video|tts
  provider: text('provider'),
  model: text('model'),
  quantity: real('quantity').notNull(),
  unit: text('unit').notNull(),    // tokens_in|tokens_out|image|second|char
  unitPrice: real('unit_price'),   // 记录时快照（元/单位；未配置 NULL）
  cost: real('cost'),              // quantity × unitPrice（未配置 NULL）
  currency: text('currency').notNull().default('CNY'),
  meta: text('meta').notNull().default('{}'), // JSON：原始 usage / 辅助信息
  createdAt: integer('created_at').notNull(),
}, (t) => [
  index('idx_usage_project').on(t.projectId),
  index('idx_usage_run').on(t.runId),
  index('idx_usage_kind').on(t.kind),
])
```

### 4.2 捕获点（llm.ts 改造 + 4 处 action 埋点）

**llm.ts 改造（零破坏）**：

```ts
export interface LlmUsage { promptTokens: number; completionTokens: number; totalTokens: number }
export interface LlmResult { content: string; usage: LlmUsage | null; provider: string; model: string }
export async function chatCompleteDetailed(messages, endpoint?, opts?): Promise<LlmResult>
// 解析 data.usage（OpenAI 兼容：prompt_tokens/completion_tokens/total_tokens；缺失 → usage=null 不报错）
export async function chatComplete(...): Promise<string>  // 变薄封装：return (await chatCompleteDetailed(...)).content
```

`resolveLlmEndpoint()` 增返 `providerKey`（api_configs 分支=cfg.providerKey；env 兜底='env'），供记录 provider 标识。

**action 埋点（services/usage.ts 的 `recordUsage()`，内部完成定价快照）**：

| 埋点位置 | kind | unit | quantity | 备注 |
|---|---|---|---|---|
| `ai-text.ts`（改调 chatCompleteDetailed） | llm | tokens_in / tokens_out | 各 token 数 | **2 行**，meta 含 total 与原始 usage |
| `subtitle.ts` estimated 路径（LLM 估时） | llm | tokens_in / tokens_out | 同上 | 仅走 LLM 路径时记录 |
| `ai-image.ts` `runOneTask` 成功处 | image | image | 1 | 每成功图 1 行；provider/model/taskId/assetId |
| `ai-video.ts` 任务成功处 | video | second | 秒（资产 duration） | aliyun-wan 已从响应 usage 解析时长，资产已落 duration |
| `tts.ts` 合成完成处 | tts | char | 合成文本字符总数 | provider/model 从实例配置 |

- embedding 为本地 ONNX 零成本 → **不记录**（排除项注明）。
- 连通性测试等无 run 上下文的调用：M4 不记录（recordUsage 要求 projectId；非 run 来源预留 NULL runId）。

### 4.3 单价配置（settings.pricing）

`settings` KV：key=`pricing`，value JSON：

```jsonc
{
  "llm":   { "deepseek-chat":        { "tokens_in": 1, "tokens_out": 2 } },   // 元/百万 token
  "image": { "pollinations_image":   { "image": 0 },                          // 元/张
             "volcengine_image:doubao-seedream": { "image": 0.2 } },
  "video": { "aliyun_wan:*":         { "second": 0.6 } },                     // 元/秒
  "tts":   { "siliconflow_audio:*":  { "char": 0.05 } }                       // 元/千字符
}
```

- **key 匹配**：`{provider}:{model}` 精确 → `{provider}:*` → `{provider}` → 未命中（cost=NULL）。
- **基数换算**（配置填「元/基数」，记录时归一为元/单位）：tokens 类基数 1,000,000；char 基数 1,000；image/second 基数 1。
- Settings 页「用量单价」区：表格编辑器（provider[:model] / 单位下拉 / 单价数字 / 删除；添加行；保存写回 settings.pricing）。辅助信息显示「近 30 天出现的 provider/model 及未计价记录数」（引导补价）。
- **快照语义**：`recordUsage` 写入时定价 → `unitPrice/cost` 落行；后续改价只影响新记录。

### 4.4 聚合 API（routes/stats.ts，新）

```
GET /stats/usage?project_id=&run_id=&batch_id=&from=&to=&group_by=kind|provider|model|unit|day|project|run
  → { items: [{key, quantity, cost, unpriced, count}], totals: {quantity, cost, unpriced} }
GET /stats/overview?project_id=&days=30
  → { projects, runs: {total, byStatus, successRate}, cost: {total, last30d},
      assets: {total, byKind}, activity: [{day, runs, cost}], activeDays,
      publications: {total, views, interactions} }
```

- `group_by=day`：`from/to` 缺省近 30 天；按本地日聚合（createdAt → yyyy-mm-dd）。
- `batch_id` 过滤：先取批内 runId 集合再查 usage（SQL `inArray`）。
- `activeDays` = 近 30 天中有 run 创建的**不同日数**（出口问题「打开频率」的代理指标）。

---

## 5. 导出分发（E3）

### 5.1 发布包结构与 manifest

```
{包名}/
  manifest.json
  video/  {成片与视频产物}
  cover/  {封面/缩略图}
  text/   {文案/剧本/字幕等文本产物}
  other/  {其余产物}
```

```jsonc
// manifest.json
{
  "version": 1,
  "generatedAt": 1757500000000,
  "project": { "id": 3, "name": "萌宝镖客" },
  "run": { "id": 42, "templateKey": "mengbao-episode", "batchId": 7, "batchSeq": 5,
           "input": { "episode_number": 5 }, "status": "completed" },
  "files": [
    { "path": "video/成片.mp4", "role": "main_video", "assetId": 301, "purpose": "final_video",
      "size": 52428800, "sha256": "…" },
    { "path": "cover/cover.png", "role": "cover", "assetId": 280, "purpose": "thumbnail", "size": 1048576, "sha256": "…" },
    { "path": "text/publish.md", "role": "copy", "assetId": 250, "purpose": "export", "size": 2048, "sha256": "…" }
  ]
}
```

- **role 映射**（purpose → role/目录）：`final_video→main_video/video`；`thumbnail→cover/cover`；`subtitle→copy/text`；kind=text→`copy/text`；kind=video→`video/other`；其余→`other/other`。
- 包内重名：追加 `-1/-2` 后缀；manifest.path 为准。
- 文件名默认 `{项目名}_{模板key}_run{id}.zip`（可自定义，重名自动后缀）。

### 5.2 打包实现（services/export.ts，新）

| 项 | 设计 |
|---|---|
| 库 | `fflate`（新依赖）：`Zip` + `ZipPassThrough` **流式**写入（store 模式不压缩媒体，CPU 近零；避免整包进内存） |
| 流程 | ① 读 run + 资产行（校验存在且有文件）② 计算包内路径与 manifest ③ 流式写临时文件 `workspace/projects/{pid}/exports/.tmp-{ts}.zip` ④ 完成后 rename 正式名 ⑤ `registerAsset({kind:'archive', purpose:'export', runId, name:'{包名}.zip', mime:'application/zip'})` ⑥ 返回资产行 |
| 落盘 | `storage.ts` `purposeSubDir` 修正：`case 'export': return 'exports'`（M1 预留占位为 'texts'，M4 正式启用独立目录；存量 export 资产为 0，无迁移影响） |
| 大文件 | 逐文件流式读入（64KB chunk），单文件不整读内存；zip 目录项由 fflate 流式生成 |
| 校验 | 无产物/资产文件缺失 → 400 含明细；导出进行中不阻塞 REST（同步完成，10 集×100MB 预计 <10s SSD） |

### 5.3 REST 与导出向导

```
POST /runs/:id/exports        {name?, asset_ids: []}    → 201 {asset}（生成发布包）
GET  /exports?run_id=&project_id=                        导出包列表（purpose='export' 资产 + manifest 摘要）
GET  /runs/:id/assets                                    该 run 全部资产（向导数据源：聚合 steps.output；排除 deleted）
（下载复用 GET /assets/:id/file?download=1，Range 已支持）
```

- 任何状态的 run 均可导出已有产物（failed/cancelled 的部分产物也有交付价值）；无产物 → 400。
- **导出向导**（RunDetailView → 「导出发布包」Modal）：按步骤分组列出该 run 全部产物（缩略图/名称/kind/purpose/大小），**默认全选**，可取消；包名输入；确认 → 生成 → 显示下载按钮 + 列表刷新。

### 5.4 批量导出

```
POST /batches/:id/exports   {}   →  { items: [{runId, assetId, name}] }
```

- 对批内所有**有产物的 run**（completed 为主，failed/cancelled 若有产物亦可）逐个生成**全量包**（该 run 全部产物，不做勾选）；串行执行，逐包登记资产。
- 包名默认 `{批次名}_集{seq}_{项目名}.zip`；批次详情页「批量导出」按钮 + 生成后列表逐条下载。

---

## 6. 复盘数据（E4）

### 6.1 运行统计看板（/stats）

**页面结构**（数据源 `/stats/overview` + `/stats/usage`）：

| 区块 | 内容 |
|---|---|
| 概览卡 | 项目数 / 运行总数与完成率 / 近 30 天运行数 / 总成本（近 30 天） / 资产总数 / 已发布与播放量 |
| 活跃趋势 | 近 30 天按日柱状（run 数 + 成本双序列，手绘 SVG，零图表库）；标注 activeDays |
| 成本构成 | 按 kind 横向条形（llm/image/video/tts）+ 「未计价 N 条」警示（跳 Settings） |
| 项目表 | 每项目：genre / 运行数 / 完成率 / 成本 / 资产数 / 发布数 / 最近活动 |

- **出口问题自证**：activeDays 与完成率直接回答「打开频率/单项目完成率」；M4 review 以该页截图数据作答。

### 6.2 发布登记（publications，内容复盘最小闭环）

```ts
export const publications = sqliteTable('publications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  runId: integer('run_id'),        // 可空：允许登记非流水线内容
  assetId: integer('asset_id'),    // 可空：首选关联成片资产
  platform: text('platform').notNull(), // douyin|wechat_channels|kuaishou|xiaohongshu|bilibili|other
  url: text('url'),
  publishedAt: integer('published_at'),
  metrics: text('metrics').notNull().default('{}'), // JSON: {views,likes,comments,favorites,shares}（仅存不算）
  note: text('note'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [index('idx_publications_project').on(t.projectId), index('idx_publications_asset').on(t.assetId)])
```

```
POST   /publications        {project_id, run_id?, asset_id?, platform, url?, published_at?, metrics?, note?}
PUT    /publications/:id    （含指标回填更新）
DELETE /publications/:id
GET    /publications?project_id=&asset_id=&platform=
```

**Web**：
- 登记入口：运行详情页产物区「标记发布」按钮（预填 run/成片资产）+ 发布记录可编辑（回填指标）。
- 项目页「发布记录」区块：列表（平台徽标/日期/资产名/5 指标/链接）+ 汇总行（已发布 N 条 / 总播放 / 总互动）。
- /stats 项目表与概览卡引用同一 API 聚合。

### 6.3 边界说明（vs Skills 层）

- studio 的「复盘」= **工序数据**（运行/成本/资产/活跃）+ **发布登记**（人工回填表现）；
- **大数据分析不在 studio**：平台导出的 CSV 映射、互动率口径、评论洞察、review_summary 由 Skills 层承接（用户既有闭环：`内容创作/萌宝IP/input/review/`放 `{平台}_{日期}.csv` →「盘点」→「复盘出题」）；
- 二者衔接点：studio 的发布登记与导出包提供「发布了什么/发到哪」的事实基础；如需把 studio 数据交给 Skills 分析，通过发布记录导出（M4 不新建导出通道，Backlog 视需求）。

---

## 7. Web 配套（W1）

| 页面 | 内容 |
|---|---|
| 统计页 `/stats`（新） | §6.1 四区块；导航新增「统计」项（位置：角色之后、AI 配置之前） |
| 批次详情页 `/batches/:id`（新） | 头部（状态/进度/调度/取消/批量导出）+ runs 表（seq/状态/输入摘要/成本/耗时/跳转） |
| 项目详情页（改） | 「批量运行」按钮（批量表单弹窗）+「批次」区块（进度列表）+「发布记录」区块（列表+汇总） |
| 运行详情页（改） | 「导出发布包」向导 + 导出包区块（下载/删除）+ 产物「标记发布」+ 本 run 成本卡（sum by run） |
| Settings（改） | 「用量单价」区（§4.3 表格编辑器）+ 未计价引导 |
| 共用组件 | `TemplateInputFields.vue`（从 RunFormModal 抽出，批量表单复用）；`ExportWizardModal.vue`；`PublishModal.vue` |
| 路由/导航 | router 增 `/stats`、`/batches/:id`；App.vue 导航增「统计」 |
| 实时 | 批次页订阅 project room 的 `batch.updated` 事件增量刷新（REST 对账兜底） |

---

## 8. 里程碑验收（M4 exit criteria，可测）

1. **批量创建与串行调度**：3 组输入批次（max_concurrent=1）→ 任一时刻活跃 run（running/waiting_input）≤1 → 顺序执行完成；batches `total/finished/succeeded` 计数正确；批内某 run 于 gate 挂起时批次不推进（等待人工），approve 后继续。
2. **批量失败与续跑**：批内 1 run 人为失败 → 后续继续执行 → 终态 `partial_failed`；失败 run 经单 run「断点续跑」可完成（新 run 独立于批次）。
3. **批量取消与崩溃恢复**：运行中批次取消 → 未启动 run 全 cancelled、活跃 run cancelled → 批次终态 cancelled；另：批次执行中重启服务 → recover + reconcile 后 queued 继续按调度推进，最终状态收敛。
4. **成本捕获**：ai_text run → usage_records 出现 tokens_in/tokens_out 2 行（quantity>0、meta 含原始 usage）；出图 N 张 → N 行 image；视频 run → second 记录（≈资产时长）；tts → char 记录（=合成字符数）。
5. **定价与聚合**：配置 pricing 后新 run 记录 `cost = quantity × unitPrice`（基数换算正确）；改价不影响历史行；未配置 → cost NULL 且 UI 显示「未计价」；`/stats/usage group_by=kind` 合计 = 明细求和。
6. **单 run 导出**：向导勾选 5 个资产 → 生成 1 个 export 资产（zip）→ 下载解压：manifest 结构正确（files 与勾选一致、分目录、role 正确）、文件可打开。
7. **批量导出**：批次完成 → 对有产物的 run 各生成 1 包；包内资产 = 该 run 全部步骤产物（对照 steps.output.asset_ids 集合相等）。
8. **发布登记与统计**：登记 2 条（含平台/链接/指标）→ 项目页发布记录与汇总正确；`/stats/overview` 的 publications/activity/完成率与库内数据核对一致。
9. **统计页数据核对**：概览卡数字（运行数/完成率/成本/资产/activeDays）与 SQL 直查一致；成本构成与未计价条目数正确。
10. **README + 无回归**：README 更新（批量/统计/导出/发布登记、新增 REST 摘要、fflate 与 pricing 配置说明）；三模板（mengbao/talking/note）至少各 1 条复跑无回归（可复用 M3 证据 + 差异快照）。

---

## 9. 出口校准与演进注记

| 项 | 状态/决策 |
|---|---|
| 出口问题（是否达到个人主力工具标准） | 作答策略：① 客观数据——/stats 的 activeDays、run 总数、完成率、成本（验收 8/9）② 用户主观确认（是否愿意日常打开使用）。**明确局限**：单机个人数据，结论作方向性判断写进 review |
| 规则 3 与路线图终局 | M4 为四阶段最后一阶；M4 review 后 ROADMAP 视结果进入「持续运营」态（Backlog 池 + 北极星三问驱动），不再预设 M5 |
| Backlog 继承 | 批次失败集聚合重跑、定时调度、导出包平台化定制、CSV 数据分析（若 Skills 层需求变化）、三层记忆/摘要压缩、一致性 A/B、情绪实例接入、角色语义检索/i2i |
| 「复盘数据」含义边界 | 本 spec 决策：工序统计（运行/成本）+ 发布登记（含手工指标）；内容大数据分析明确留 Skills 层（§6.3）——如用户要求变更，M4 实施前调整本节即可（不影响 E1–E3） |
| 引擎红线校验 | M4 未引任何外部编排引擎；批次调度为 ~120 行自研服务 + engine 单个监听口；若 M4 review 显示调度不足以支撑批次（如需要跨 run 依赖/DAG 编排）再评估 |
| 新依赖 | 仅 fflate（导出打包）；如实施中 fflate 流式 API 遇阻，降级方案=手写 store zip（无压缩，~150 行）或 yazl，实施时以冒烟验证为准 |

---

## 10. 参照物速查

- 批量形态参考：`Agent/huobao-drama`（集内批量出图/提示词的进度状态形态：completed/total）；引擎多 run 并行能力已就绪（`engine.active: Set<number>`，无全局并发限制）
- 成本参照：`apps/server/src/adapters/aliyun-wan-video.ts`（上游响应 `usage.output_video_duration` 已解析为资产 duration——视频按秒计价的先例）；`services/llm.ts`（`data.usage` 当前被丢弃，M4 恢复解析）
- 导出参照：无直接参考实现（自研）；zip 库 fflate（流式 `Zip` + `ZipPassThrough`）
- 复盘参照（方法论背景，**不实现**）：`Skills/自媒体/media-review/SKILL.md`（字段映射/互动率口径/review_summary）+ `内容创作/萌宝IP/input/review/数据回灌说明.md`（用户实际闭环证据——studio 边界依据）；账号节奏 `内容创作/萌宝IP/input/profile.md`（短剧周更两集 → 批量 2 集/次是真实节奏）
- 改造点代码：`db/schema.ts`（+3 表 3 列）、`services/llm.ts`（detailed 版）、`pipeline/actions/{ai-text,ai-image,ai-video,tts,subtitle}.ts`（埋点）、`pipeline/engine.ts`（onRunSettled）、`db/seed.ts`（provider 目录无改动，pricing 走 settings 不 seed）、`services/storage.ts`（export 目录 + runId 透传）、`index.ts`（接线顺序）、`routes/{batches,stats,exports,publications}.ts`（新）+ `runs.ts`（抽 createRunRow）
- 体例参照：`2026-09-10-agencys-content-studio-m3-design.md`
