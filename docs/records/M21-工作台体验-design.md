# M21 设计：工作台体验（检索·通知·键盘流）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-16
- 对应纲领：`2026-09-14-agencys-content-studio-m19-m27-charter.md` §一 C 组（C1–C7，7 项）与 §三 M21 立项卡
- 决策留痕（2026-09-16 用户拍板四项）：
  1. **全局并发上限**：默认 3、可配置 1–6（系统设置页）；engine 加全局闸门，超限 run 留 `queued` 等 pump 推进
  2. **参数热调留痕**：`run.input._params_log` 追加数组（与 `_params` 同源固化、随 run 快照共存、续跑可重放；不破「快照即证据」）
  3. **全局搜索**：关键词全量（所有域）+ 语义限文本域（记忆与文本资产用 bge-small 本地向量；模型不可用自动降级关键词）
  4. **命令面板**：含操作类动作（取消运行等，二次确认防误触）
- 前置：M19 ✅ / M28 ✅ / M20 ✅（2026-09-15 收官，含排产日历 / 预算 / 回采 / A-B / 成本聚合 / 复盘 CSV / 导出预设）
- 纪律：同一时间只存在一个 L1 详细 spec（校准规则 3）；本轮仅 M21。§7 实施批次内逐批 typecheck + 探针 + 实弹。

---

## §1 背景与目标

### 1.1 现状（勘察结论，2026-09-16）

| 项 | 现状 | 缺口本质 |
|---|---|---|
| C1 全局搜索 | 后端零 search 端点；前端无全局搜索 UI（仅 `SearchSelect` 局部下拉）；`embedding.ts`（bge-small-zh-v1.5 本地 ONNX）与 `memories.embedding` 列先例在位 | 全新建（读模型） |
| C2 浏览器通知 | `App.vue` 已建全局 Socket.IO 单连接；`StudioEventMap` 已有 `run.completed/failed/gate`、`batch.updated`；**零 Notification API 使用** | 纯前端新建 |
| C3 tags UI | **后端全就绪**：assets PATCH tags 数组 + `?tag=` 过滤（但为 limit/offset 后内存过滤，**分页错位 bug**）；projects PATCH/创建均支持 tags；前端零 UI | 纯 UI + 一处服务端修正 |
| C4 键盘流 | 仅组件级零散快捷键（画布 / DatePicker / SearchSelect），无全局体系 | 全新建 |
| C5 Gate diff | `GateDialog.vue` 有产物预览 + 审阅修改 + 驳回意见；**无版本对比**。版本链天然存在：每次文本产物写入生成新资产行（`writeTextAsset` 带 runId/stepId），reject 重跑 / text_override 定稿各产生一版 | 查询端点 + diff UI |
| C6 并行上限 | batch 级 `max_concurrent`（clamp 1–3）仅约束批内（`batch.ts` pump 槽位）；`engine.startRun` **无全局闸门**，跨 batch / 多手动 run 可无限并行 | engine 语义扩展 |
| C7 参数热调 | `run.input._params` 启动快照；**关键发现**——`createStepContext` 每步执行时重新 `readRunParams(run.input)`，更新 input 后未执行步骤天然读新值（生效路径已存在）；无更新端点、无留痕、无 UI | 受限端点 + 留痕 + UI |

### 1.2 目标

1. 一个入口搜遍全站：命令面板（Ctrl/Cmd+K）内嵌跨域搜索（项目 / 运行 / 资产 / 实体 / 画布 / 发布 / 剧集 / 批次 / 排产 / 记忆），文本域叠加本地向量语义命中
2. 长任务离开页面也能感知：run 终态 / 闸门到达 / 批次完成浏览器通知（后台时推送、可关、不可用静默降级）
3. 资产与项目标签真正可用：编辑 / 筛选 / 批量打标
4. 键盘提效：全局命令面板（导航 + 搜索直达 + 新建 + 上下文操作类动作）
5. 闸门审阅不盲签：GateDialog 版本对比（diff 视图）
6. 资源可控：全局并发上限（默认 3，可配 1–6）——行为变更明示（见 §6）
7. 运行中调参不必重跑：受限热调（仅未执行步骤生效）+ 追加式留痕

---

## §2 范围

### 2.1 总览与批次

| 批次 | 内容 | 性质 |
|---|---|---|
| **批 1** | C1 全局搜索（后端 + 前端）· C2 浏览器通知 · C3 tags UI | 快赢三枚（后端读模型 + 纯前端） |
| **批 2** | C4 命令面板（含操作类动作）· C5 Gate diff | 前端交互 + 1 枚查询端点 |
| **批 3** | C6 全局并发上限 · C7 参数热调 | engine 语义扩展 + 受限写端点 |

发号规则：本轮新增端点 4 枚（§2.5）；无新表；`assets` 表加 2 列；`settings` 新增 2 个 key。

### 2.2 批 1 · 快赢三枚

#### C1 全局搜索

**端点**：`GET /api/v1/search?q=<关键词>&limit=<每组条数 默认 5>`

- 校验：`q` trim 后非空且 ≤100 字符，否则 400 `bad_query`
- LIKE 转义：`%` `_` `\` 前缀反斜杠 + `ESCAPE '\'`（drizzle `sql` 模板）
- 响应：
  ```jsonc
  {
    "q": "…",
    "groups": [ { "domain": "projects", "label": "项目", "items": [ { "id": 14, "title": "…", "subtitle": "…", "url": "/projects/14" } ] } ],
    "semantic": { "available": true, "degraded": false, "indexing": false, "hits": [ { "entity": "asset", "id": 123, "title": "…", "snippet": "…", "score": 0.71, "url": "…" } ] }
  }
  ```
- **关键词域**（SQL LIKE，各 `limit` 条，并行查询）：

  | 域 | 表 | 匹配列 | 跳转 url |
  |---|---|---|---|
  | projects | projects | name / brief / tags | `/projects/:id` |
  | runs | pipeline_runs | 纯数字 q 时按 id 精确；否则 `input` LIKE | `/runs/:id` |
  | assets | assets | name / tags（deletedAt IS NULL） | `/projects/:pid?tab=assets`（asset 深链接若既有机制可用则带） |
  | entities | characters | name / aliases / summary | `/entities` |
  | canvases | canvases | name（deletedAt IS NULL） | `/creation?canvas=:id` |
  | publications | publications | title / url / note | `/projects/:pid?tab=pubs` |
  | episodes | episodes | title / 纯数字按 number | `/projects/:pid`（剧集 Tab，实施时对齐 tab key） |
  | batches | batches | name / 纯数字按 id | `/batches/:id` |
  | schedules | schedules | name | `/stats`（排产 Tab，实施时对齐） |

- **语义域（限文本）**：
  - 记忆：直接复用 `recallMemories(query, { limit: 5 })` → `semantic.hits`
  - 文本资产：`assets` 新增 `embedding` / `embedding_model` 两列（JSON number[] / tag 字符串，与 `memories` 同构）；仅 `kind='text' AND deletedAt IS NULL AND embedding_model == 当前 tag` 的行参与 cosine 命中（`minScore 0.25`，limit 5）
  - 模型不可用（`ensureEmbedder` 抛错）→ `available:false, degraded:true`（关键词照常，不抛错）
- **首搜自动索引**：search 端点检出"存在 `kind='text'` 未索引/异模型的行" → 触发后台全量增量索引（模块级单 inflight 防重，`void`）；响应照常返回并带 `indexing:true`；每条目：读文件内容（`absPathOf` + 截断 1500 字符）→ `embed` → 写回 embedding/embedding_model；失败行计数跳过
- **手动重建**：`POST /api/v1/search/reindex` → `{ total, indexed, skipped, failed }`（对齐 `memories/reindex` 语义；模型不可用 → 503 级错误响应，指引 `model:prepare`）
- **前端**：
  - `components/common/CommandPalette.vue`（批 2 建，批 1 先建最小搜索浮层由批 2 并入——为避免两次重写，批 1 直接建 CommandPalette 并以搜索为主功能，批 2 补动作区）
  - 输入防抖 250ms → `GET /search`；结果分区展示（分组标题 + 条目 title/subtitle）；`indexing:true` 时语义区显示"语义索引构建中…"
  - 侧栏顶部（logo 下 / nav 上）加"搜索"按钮（放大镜 + `Ctrl K` 提示）打开面板
  - 点击条目：`router.push(url)` 并关闭面板

#### C2 浏览器通知

- **`lib/notify.ts`**（新）：
  - `initNotify(router)`：App.vue 挂载调用；订阅 socket 事件（`run.completed` / `run.failed` / `run.gate` / `batch.updated`）
  - 推送条件（全满足）：`settings.notify.enabled` 开（默认开）且对应分类开（默认开）且 `Notification.permission === 'granted'` 且 `document.hidden`（**仅后台推送**：前台界面已有实时反馈，避免重复打扰）
  - 文案：`运行 #123 已完成` / `运行 #123 失败：{stepKey}` / `运行 #123 等待审阅：{message}` / `批次 #45 完成 8/10`；tag 用 `run-123` / `batch-45`（同实体去重）
  - 点击：`window.focus()` + `router.push('/runs/123' | '/batches/45')`
  - 静默降级：`Notification` 不存在 / 权限 denied → 全部跳过（零报错）
  - 设置读取：`settingsApi.list()` 惰性一次性缓存（失败默认全开）
- **设置页**（`views/system-settings/index.vue`）Tabs 新增「通知」：
  - 权限状态展示（granted / default / denied / unsupported）+「请求权限」按钮（default 时可点；denied 时显示引导文案）
  - 总开关 + 三类开关（运行终态 / 闸门到达 / 批次完成）→ `settingsApi.put('notify', {...})`
- 事件载体零服务端改动（payload 已足够：runId/stepKey/message/batchId/status/finished/total）

#### C3 资产 / 项目 tags UI

- **资产侧**（`AssetsPanel.vue` + `AssetGrid.vue` + 预览器）：
  - 卡片徽标：`meta` 区新增 tags chips（≤2 个 + `+N`，title 展开全文）
  - 预览器编辑：统一预览器（`components/asset/previewer/`）新增标签编辑区（输入回车添加 / chip × 删除）→ `assetApi.updateTags(id, tags)`（新方法，PATCH 已有端点）→ `@changed` 回传宿主
  - 批量打标：AssetsPanel 顶部「批量打标」按钮 → 选择模式（`AssetGrid` 加 `selectable` prop：卡片左上 checkbox，激活不改预览）→ 工具条（已选 N / 标签输入 / 应用 / 取消）；应用 = 对选中项逐个 `updateTags`（**追加去重语义**，并发 ≤6 `allSettled`），失败项计数提示
  - 标签筛选：顶部下拉（选项 = 当前加载资产 tags 聚合去重）→ 与 `purposeFilter` 一致的客户端过滤
- **项目侧**（`views/projects/index.vue`）：
  - 卡片 tags chips 展示；创建 / 编辑弹窗加 tags 输入（逗号分隔 ↔ 数组）
  - 顶部标签筛选（客户端聚合）
- **服务端修正（1 处）**：`routes/assets.ts` 的 `?tag=` 由"limit/offset 后内存过滤"改为 **SQL 层过滤**（`tags LIKE '%"tag"%'`，JSON 数组引号精确匹配）——修复分页错位，探针断言覆盖

### 2.3 批 2 · 键盘流与审阅

#### C4 命令面板（键盘流）

- **`lib/hotkeys.ts`**（新）：全局键注册单例（防重、可禁用）；v1 仅 `Ctrl/Cmd+K`（面板开关）+ `Esc`（关面板，接 `esc-layer` 仲裁）
- **`CommandPalette.vue`** 分区（输入即过滤，↑↓ 选择 / Enter 执行 / Esc 关闭）：
  1. **导航**：9 个主导航页（项目 / 画布 / 素材 / 风格 / 模板 / 记忆 / 统计 / AI 配置 / 设置）
  2. **搜索结果**：`GET /search` 分组条目直达（点击 `router.push(url)`，面板关闭后恢复页面状态）
  3. **动作**：
     - 全局：`新建项目`（`/` + `?new=1` 由项目页监听打开创建弹窗）、`新建排产计划`（`/stats?tab=sched&new=1`，实施时对齐现有 Tab 深链接 key）
     - 上下文（读当前 `route`）：run 页 → `取消运行 #id`（`running/queued/waiting_input` 时可用）；batch 页 → `取消批次 #id`（`running` 时可用）
     - 操作类动作一律 `confirmDialog`（danger）二次确认后执行（`runApi.cancel` / `batchApi.cancel` 已有）
- App.vue 挂载面板；侧栏搜索按钮共用打开入口

#### C5 Gate diff 审阅

- **端点**：`GET /api/v1/runs/:id/steps/:key/revisions`
  - 数据源：`assets WHERE runId=:id AND stepId=(该步 id) AND kind='text' AND deletedAt IS NULL ORDER BY createdAt DESC`
  - 响应：`{ items: [ { assetId, name, createdAt, current } ] }`；`current = step.output.asset_ids[0]`；无文本产物 → 空列表（非 404）
- **`GateDialog.vue`** 新增 tab「对比」（有 ≥2 版本时显示）：
  - 版本选择：默认「上一版本 vs 当前产物」；下拉可切换基准版本
  - 渲染：行级 diff（**零依赖自研 LCS**，居前后缀裁剪 + DP，行数 <5000 上限保护）；`+` 绿 / `-` 红 / 上下文灰（`--ok` / `--bad` 弱色 token）
  - 加载：打开 tab 时拉 revisions + 读取所选两版全文（`fetch(a.urls.file)`，与既有 artifactText 读取同法）
- run-detail（`use-run-detail.ts`）向 GateDialog 传入 `runId` + `stepKey`（已有 gateStep）

### 2.4 批 3 · 调度与热调

#### C6 多开任务并行上限（全局闸门）

- **配置**：`settings` key `'concurrency'` → `{ "max": 3 }`（整数 1–6 clamp；默认 3）；环境变量 `CSTUDIO_GLOBAL_MAX_CONCURRENT` 兜底（对齐 embedding 的 settings → env → 默认链）
- **engine 改造**（`pipeline/engine.ts`）：
  - `startRun(runId)`：改返回 `'started' | 'deferred' | 'running'`（`'running'` = 该 run 已在 active，幂等吸收）
    - 闸门：`active.size >= max` 且 run 不在 active → **defer**：`void` 异步将该 run 状态归一到 `queued`（仅当其当前状态为 `running/waiting_input/queued` 时写；不触碰终态），并返回 `'deferred'`
    - 说明：defer 归一 `queued` 使「DB 即队列」——`approveGate/rejectGate/skipGate/tasks retry` 等续跑路径被 defer 时 run 从 `waiting_input` 落 `queued`（待审阅角标随之正确减一），pump 统一从 `queued` 推进
  - **`pumpGlobal()`**（新增，防重入 boolean 门闩）：查 `status='queued' AND batch_id IS NULL` 按 `createdAt ASC` → 补足 `max - active.size` 槽位逐个 `startRun`（内部闸门幂等吸收超发）
    - 触发点：① runChain 结束（`active.delete` 后 `notifySettled` 同点）② `recoverInterruptedState` 完成后 ③ 30s 定时兜底（对齐 pending 轮询节奏；异常态自愈）
  - **batch 协同**：batch 的 `queued` run 不归全局 pump 挑（保持 `batchSeq` 序由 `batch.ts` pump 管）；batch pump 的 `startRun` 被 defer 时该 run 留 `queued`，下一次任一 run settle → batch pump 重试（既有链），重试仍满则再 defer（幂等）——两泵互补，无死锁（全局 settle 必然触发 batch 重试）
  - **行为变更明示**：此前全局无上限；默认 3 生效后同时最多 3 个 run 执行（单机日常 1–2 run 无感；对齐 batch 级 3 的先例语义）
- **设置页** Tabs 新增「运行」：全局并发上限（1–6 数字输入 + 说明文案）→ `settingsApi.put('concurrency', { max })`

#### C7 参数热调（受限语义）

- **端点**：`PATCH /api/v1/runs/:id/params`，body `{ "params": { image?: {...}, video?: {...}, audio?: {...}, llm?: {...} } }`
  - 状态门：run.status ∈ `queued | running | waiting_input` 才允许；否则 409 `run_settled`（完整/失败/取消的 run 拒绝）
  - 校验：复用 `validateRunParams`（白名单 + 类型 + clamp，非法 400）。**部分合并语义**：组内字段级深合并（改 `image.model` 不影响既有 `image.size`）；不可删键（不提供 null 清除，spec 排除）
  - 写回：`run.input` 解析 → `_params` 深合并更新 → **`_params_log` 追加** `{ at, changes: [{ group, key, from, to }], source: 'user' }` → 序列化写回（input 其他键逐字保留）
  - 响应：`{ run, applied: changes }`
- **生效语义**：零引擎改动——`createStepContext` 每步执行时重新 `readRunParams(run.input)`，**仅未执行（未开始）步骤读到新值**；已开始步骤与 in-flight 任务不受影响（与纲领"仅未执行任务生效"逐字一致）；快照语义不破——`_params` 只增改、`_params_log` 全量留痕
- **UI**：`views/run-detail/RunParamsPanel.vue`（新）：
  - 展示当前 `_params` 生效值（四组键值 + 来源提示"run 覆盖 > 项目 settings > 模板 defaults"）
  - 编辑：白名单字段表单（image: provider/model/size；video: provider/model/resolution/duration；audio: provider/voice；llm: temperature/max_tokens）→ 提交调新端点 → 刷新 run
  - 留痕时间线：`_params_log` 倒序（时间 + `group.key: from → to`）
  - 仅 `queued/running/waiting_input` 时可编辑；终态只读
- 面板挂载进 run-detail（`use-run-detail.ts` / `use-run-extras.ts` 装配，对齐 M28 拆分后结构）

### 2.5 端点一览（M21 新增 4 枚；既有端点全超集兼容）

| # | 方法 | 路径 | 说明 |
|---|---|---|---|
| 1 | GET | `/api/v1/search?q=&limit=` | 跨域关键词 + 语义混合搜索 |
| 2 | POST | `/api/v1/search/reindex` | 文本资产向量全量重建（模型不可用报错指引） |
| 3 | GET | `/api/v1/runs/:id/steps/:key/revisions` | Gate 文本产物版本列表（current 标记） |
| 4 | PATCH | `/api/v1/runs/:id/params` | 集级参数热调（受限 + 留痕） |

### 2.6 探针（`apps/server/scripts/probe-m21.ts`，分 6 节）

1. **`search`**：建种子数据（项目/资产/实体/发布/记忆）→ 各域 LIKE 命中与不命中矩阵；`%`/`_` 转义不误配；空 q / 101 字符 400；数字 q 的 runs id 精确命中；语义段在无模型环境 `available:false` 不抛错；`reindex` 幂等（二次调用 indexed=0）
2. **`revisions`**：同 run 同 step 写 3 版文本资产 → 列表倒序、current 指向 step.output.asset_ids[0]；无文本产物步骤 → 空列表；跨 step 不混入
3. **`concurrency`**：settings 读取与 1–6 clamp（越界回落）；构造 5 个 queued run 循环 startRun → active ≤ max、defer 的 run 状态为 `queued`；终态一个 → pumpGlobal 自动补位（等待轮询断言）；重复 startRun 幂等（`'running'`）；`waiting_input` run 被 defer 后状态归一 `queued`
4. **`hot-params`**：合并语义（改 model 保留 size）；非法键/越界 400；终态 run 409；`_params_log` 追加（含 from/to）；input 其他键逐字保留；`readRunParams` 返回合并后新值（生效路径断言）
5. **`tags-sql`**：`?tag=` SQL 过滤正确性（先构造 >limit 行验证**分页不错位**——修复断言）；无匹配 tag → 空；tag 含引号/中文正常
6. **`settings-kv`**：`notify` / `concurrency` 两 key 的读写与默认值（缺失 → notify 全开默认、concurrency.max=3）

---

## §3 红线复核

| 红线 | 复核结论 |
|---|---|
| 不改引擎调度语义 | C6 为**扩展**：startRun 闸门 + pump，单 run 执行链 / DAG / gate 语义逐字不变；`active` 判定幂等吸收保留；行为变更（上限默认 3）为用户拍板项并明示（§6） |
| 不引重型编排 / 任务引擎 | C6 为 DB `queued` 队列 + 轻量 pump（无新依赖），对齐 batch pump 先例 |
| 搜索零新依赖 | 关键词 = SQL LIKE；语义 = 复用既有 `embedding.ts`（bge-small 本地 ONNX）；diff = 自研 LCS；零新包 |
| 「快照即证据」 | C7 只增改 `_params` + 全量 `_params_log` 留痕；模板快照 / 既有 output / gate 痕迹零触碰 |
| 无体裁专属表 | 无新表；assets 加 2 列（通用）；settings 2 key（通用） |
| 读模型与 UI 为主 | 4 枚端点中 2 读 2 写（写均为受限语义 + 白名单校验） |
| M7/M11 兼容纪律 | 不触碰 ffmpeg-merge / compose 链；与 M19/M20 产物零交集 |

## §4 数据与接口变更清单

**DB**：
- `assets` + `embedding`（text, NULL）/ `embedding_model`（text, NULL）——`schema.ts` 定义 + `db/index.ts` `ensureSchemaColumns()` 列级兜底（对齐 M4 起既有惯例：迁移体系仅 0000 初始迁移，后续列变更不走新迁移）
- `settings` 新 key：`concurrency`（`{max:3}`）、`notify`（`{enabled:true, run_terminal:true, gate:true, batch:true}`）——无 schema 变更（KV 表）

**服务端**：新增 `services/search.ts`、`routes/search.ts`；修改 `pipeline/engine.ts`（闸门 + pump）、`routes/runs.ts`（+2 端点）、`routes/assets.ts`（tag SQL 过滤修正）、`index.ts`（路由挂载 + 启动 pump 兜底）、`db/schema.ts`、`db/index.ts`

**前端**：新增 `components/common/CommandPalette.vue`、`lib/hotkeys.ts`、`lib/notify.ts`、`views/run-detail/RunParamsPanel.vue`；修改 `App.vue`（面板挂载 + 通知初始化 + 侧栏搜索按钮）、`lib/api.ts`（searchApi / updateTags / revisions / updateParams）、`components/run/GateDialog.vue`（diff tab + props）、`components/asset/AssetGrid.vue`（tags 徽标 + selectable）、`components/asset/previewer/`（标签编辑区）、`views/project-detail/AssetsPanel.vue`（筛选 + 批量打标）、`views/projects/index.vue`（项目 tags）、`views/system-settings/index.vue`（通知 / 运行 Tabs）、`views/run-detail/`（面板装配）

## §5 验收标准

1. **探针**：`probe:m21` 6 节断言全绿；`probe:m1–m19` 全量回归零适配（2233+ 断言）
2. **类型检查**：`vue-tsc --noEmit` + 服务端 `tsc --noEmit` 双端零错误
3. **实弹浏览器**（127.0.0.1:5174）：
   - 搜索：Ctrl+K 打开 → 输入命中项目/资产多域 → 点击直达；断网/降级路径不报错
   - 通知：设置页请求权限（granted）→ 切后台触发 run 终态 → 通知到达（无权限环境断言静默）
   - tags：资产标签编辑 → 筛选命中 → 批量打标 2+ 资产；项目标签编辑与筛选
   - 命令面板：导航直达 / 搜索直达 / `取消运行` 二次确认后生效（取消一个真实测试 run）
   - Gate diff：构造两版文本产物 → 打开对比 tab → +/− 行正确渲染
   - 并发：配制 max=1（测试期）→ 2 个 run 并发场景第 2 个 `queued` → 第 1 个结束后自动启动
   - 热调：运行中改 `llm.temperature` → 响应 applied + 面板留痕时间线 → 后续步骤读到新值（日志/参数快照佐证）
4. **文档**：本 spec、review 落盘、roadmap 校准（M21 注记）、README 里程碑行

## §6 风险与回滚

| 风险 | 缓解 |
|---|---|
| **C6 行为变更**：全局上限默认 3（此前无限）——批量/多开场景不再无限并行 | 拍板项已明示；`max` 可配 1–6（设 6 近似放开）；单机日常无感；探针锁定闸门/补位语义 |
| engine.startRun 返回值签名扩展（void → 枚举） | 返回值为增量信息；既有调用方（8 处）不检查返回值，零破坏；探针断言三态 |
| defer 归一写 `queued` 的状态竞态（defer 与用户 cancel 并发） | cancel 幂等（置 cancelled 后 pump 不挑）；写仅覆盖 `running/waiting_input/queued` 三态 |
| 首搜自动索引耗时（文本多时数秒） | 单 inflight 防重 + 后台执行不阻塞响应；`indexing` 状态透出；失败行跳过不阻断 |
| 语义搜索结果为空/低质（minScore 0.25） | 关键词段永远在（并行返回）；语义段标注模型与降级态 |
| tag 过滤切 SQL 后语义变化（内嵌子串 → 引号精确） | 与 tags 编辑语义对齐（完整标签匹配）；探针锁定；前端筛选走客户端聚合不受影响 |
| diff 大文本渲染卡顿 | 行长上限 5000 保护 + 前后缀裁剪；超出提示"版本过大仅显示前 N 行" |

回滚：C6 可通过设置 max=6 弱化（无需回退代码）；其余各项独立提交粒度，`git revert` 单批可回。数据变更（assets 两列）幂等且向后兼容（NULL 即未索引）。

## §7 实施计划

| 批 | 内容 | 验证 |
|---|---|---|
| **P0 基建** | assets 两列（schema 定义 + ensureColumn 兜底）、settings key 约定、`probe-m21.ts` 骨架 | 双端 typecheck |
| **P1（批 1）** | C1 后端（search/reindex）+ C2 通知 + C3 tags UI（含 assets 路由 tag SQL 修正） | probe search / settings-kv / tags-sql 节 |
| **P2（批 2）** | C4 命令面板 + C5 Gate diff（revisions 端点） | probe revisions 节 + 实弹面板 DOM |
| **P3（批 3）** | C6 全局闸门 + C7 热调（端点 + UI） | probe concurrency / hot-params 节 |
| **P4 回归收口** | probe m1–m19 全量回归零适配、双端 typecheck、实弹全链路、review 落盘、roadmap 校准、README 更新 | 全绿 |

## §8 明确排除

- **跨 run 的 Gate diff**（仅同 run 同步骤版本链；跨 run 对比留后续）
- 搜索：历史记录 / 保存搜索 / FTS5 全文索引引擎 / 非文本域的语义向量（项目/实体等仅关键词）
- 通知：音效 / 页面标题闪烁 / 前台强制推送开关（仅 `document.hidden` 推送）/ Service Worker 离线通知
- 命令面板：两键序列快捷键（g→p 式）/ 自定义键位 / 动作参数表单（如"新建运行需先选项目"——跳转目标页处理）
- 热调：删除/清空参数键（仅增改）；模板快照热改（`template_snapshot` 不可变）；batch 并发参数热调；回溯已执行步骤
- tags：跨项目标签聚合视图 / 标签云 / 颜色体系 / 自动打标
- C6：批内 `max_concurrent` 上限 3 的数值调整（保持现状）；跨队列公平性调度（全局与批间先到先得）
- 不触碰：M19 品牌链 / M20 排产与预算链 / ffmpeg-merge / 模板 loader / 既有探针脚本
