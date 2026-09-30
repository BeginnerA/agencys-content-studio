# M27 L1 spec — 自动编排（真 orchestrator）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-17
- 纲领：`2026-09-14-agencys-content-studio-m19-m27-charter.md` §一 I 组 / §二 M27 卡 / §五「LLM 编排分层」
- 设计原则继承：即时设计（仅本里程碑详设）；「需求勘察 → 用户拍板 → 单个 L1 spec → 实施/验证 → 复盘 → roadmap 校准」

## 0. 用户拍板（2026-09-17 四项，全选推荐）

1. **串链自动化 = 自动级联 + 逐链开关 + 预算闸门**：run 完成经 `onRunSettled` 钩子自动触发下一模板段（真 orchestrator）；但每条链 `autoAdvance` **默认关闭**，需用户逐链显式启用；每跳触发前过 `checkBudget` + 链级预算上限，超阈即暂停并告警、**不触发**（计费安全）。链首段启动永远为用户显式动作。
2. **模板嵌套 I2 = 收窄为编排层引用、不碰引擎**：workflow 的段（segment）按序引用既有模板；「组合单元」= 一条链（有序模板序列），可克隆复用。**不新增任何引擎级递归 action（无 `run_template`）、不改 loader/引擎**；运行时深度嵌套（一个 step 内跑子模板 DAG）登记为后续/排除。
3. **可视化 I3 = 扩展画布全景 tab**：在 `buildCanvasOverview` 读模型 + `OverviewPanel` 新增「编排链」区，渲染链 = 模板节点序列（边取段序 / `template.next`）+ 每段最新 run 状态/成本徽章 + 链级 autoAdvance 开关与暂停/续跑；链构建器（选项目 → 依 `next` 建议排序列 → 设 autoAdvance → 启动首段）。
4. **持久化 = 新增 1 张 `workflows` 表 + 链进度由关联 run 派生**：`workflows` 存链定义与推进控制；`pipelineRuns` +2 可空列 `workflow_id` / `workflow_seq`（走 `ensureColumn` 幂等）标记 run 归属段；链实时进度/成本从关联 run 聚合派生，无独立进度表。

## 1. 设计三原则（红线）

- **不碰引擎/生成主链**：`engine.ts` 执行循环 / `dag.ts` / `loader.ts`（`KNOWN_ACTIONS` 不增）/ `refs.ts` / 适配器 / schema 既有列 **零 diff**。编排复用既有 `onRunSettled` 钩子（M4 batch 同款机制）+ `createRunRow` + `engine.startRun`，纯服务层新增。
- **计费安全（纲领红线核心）**：`autoAdvance` 默认关 + 逐链显式启用；链首段启动为显式用户动作；每跳前 `checkBudget({projectId})` 且链级 `budgetCap` 对累计成本核算，任一拦截 → 链 `paused` + `workflow.blocked` 事件，**不自动触发**；`run.failed` → 链 `paused`（失败**不自动重试**，用户经既有 `/runs/:id/resume` 恢复后再续）。
- **零新外部依赖、零运行时侵入**：无新 npm 依赖；新表/新列走 `ensureTable`/`ensureColumn` 幂等（旧库升级不炸，对齐 M14/M18 先例）；orchestrator 监听器异常隔离（沿用 `notifySettled` try/catch 语义，不波及引擎主流程）。

## 2. 逐项设计契约

### 2.1 I1 · workflows 表与链语义

```ts
// db/schema.ts（新表，全走 ensureTable 幂等）
export const workflows = sqliteTable('workflows', {
  id: integer PK autoIncrement,
  projectId: integer NOT NULL,          // 链挂项目级（剧集可后续按 series 过滤，M27 不做剧集专属表）
  name: text NOT NULL,
  status: text NOT NULL default 'draft', // draft|active|paused|done|cancelled
  autoAdvance: integer NOT NULL default 0, // 0=安全默认关；1=完成自动级联
  budgetCap: real,                       // 链级累计成本上限（元；NULL=不设链上限，仍受 project 预算约束）
  segments: text NOT NULL default '[]',  // JSON：[{ templateKey, inputSpec? }] 有序
  note: text,
  createdAt: integer NOT NULL, updatedAt: integer NOT NULL,
}, [ index idx_workflows_project(projectId), index idx_workflows_status(status) ])

// pipelineRuns +2 可空列（ensureColumn 幂等）
workflowId: integer('workflow_id'),  // 归属链（NULL=非编排 run）
workflowSeq: integer('workflow_seq'),// 段序（从 0 起）
```

- **段输入映射 `inputSpec`**（`resolveSegmentInput` 纯函数，无副作用可测）：`{ [field]: string }`，取值语法：
  - `"$prev.assets:<purpose>"` → 上一段 run 该 purpose 产物资产 id 数组（`files` 输入）
  - `"$prev.asset:<purpose>"` → 首个匹配资产 id（单 `files`/`text`）
  - `"$prev.text:<purpose>"` → 首个文本产物正文（`text` 输入）
  - 其它字符串/数字/布尔 → 字面量常量
  - 缺省（段无 inputSpec）：仅带模板 `inputs` 声明的 `default`；未满足的 `required` → 判定 `input` 阻塞（不触发，见 §2.2）
- 链有效性：`validateWorkflowChainDoc(segments)` 纯函数——每段 templateKey ∈ 已注册模板、segments 非空、JSON 结构合规；`next` 一致性仅**软校验**（段序列不强制等于 template.next，给出 warning）。

### 2.2 I1 · 自动级联推进（`services/workflow.ts`）

- index.ts 注册 `onRunSettled(advanceWorkflow)`（与 batch `notifyRunSettled` 并列、互不影响）。
- `advanceWorkflow(runId)`：
  1. 载入 run；`run.workflowId == null` → return（非编排 run）。
  2. 载入 workflow；`status != 'active'` → return。
  3. `run.status == 'failed' | 'cancelled'` → workflow `paused` + 发 `workflow.blocked{reason:'failed'}`；return（不重试）。
  4. `run.status != 'completed'`（queued/running/waiting_input）→ return（仅完成推进）。
  5. `autoAdvance != 1` → 仅发 `workflow.segment_done` 事件（提示可手动推进），不自动触发；return。
  6. `next = segments[run.workflowSeq + 1]`；无 → workflow `done` + `workflow.completed` 事件；return。
  7. **预算闸门**：`checkBudget({projectId})` 非 null → `paused` + `blocked{reason:'budget'}`；return。链级 `budgetCap` 且 链累计成本（关联 runs 的 usage 聚合）`>= budgetCap` → 同上 `blocked`；return。
  8. **输入解析**：`inputs = resolveSegmentInput(prevRunAssets, next.inputSpec)`；`required` 未满足 → `paused` + `blocked{reason:'input'}`；return。
  9. `createRunRow({projectId, templateKey: next.templateKey, input: inputs, workflowId, workflowSeq: run.workflowSeq+1})` → `engine.startRun(newRun.id)` → 发 `workflow.advanced{fromRunId, toRunId, seq}`。
- 幂等/风暴防护：段推进以「run 完成 → 唯一 seq+1 后继」天然幂等；同链推进用内存 `Set<workflowId>` 互斥（对齐 batch `pumps` 批内互斥），防并发 settle 重入。

### 2.3 I1 · 端点（`routes/workflows.ts`，挂 `/api/v1`）

- `GET /workflows?project_id=&status=` 列表；`GET /workflows/:id` 详情（含解析后段序列 + 每段最新 run 摘要，派生口径同 overview）。
- `POST /projects/:id/workflows` 建链（校验 `validateWorkflowChainDoc`）；`PATCH /workflows/:id` 改名/segments/autoAdvance/budgetCap/note（`active` 链改 segments 需 `draft|paused`）；`DELETE /workflows/:id`（仅 `draft|done|cancelled`）。
- `POST /workflows/:id/start` —— **显式**创建并启动首段 run（status draft/paused→active；首段 autoAdvance 决定后续是否级联）；`POST /workflows/:id/pause`；`POST /workflows/:id/resume`（paused→active，若末段已完成则 done）。
- 事件扩展（`services/events.ts` `StudioEvent` union 加法）：`workflow.segment_done` / `workflow.advanced` / `workflow.blocked{reason}` / `workflow.completed`（各带 workflowId, projectId）。

### 2.4 I2 · 嵌套（编排层引用）

- 「复用单元」= workflow 本身：`POST /workflows/:id/clone`（复制 name/segments/budgetCap，status→draft，供项目内复用模板化链）。
- 段仍引用**扁平模板** key；运行时深度嵌套（段内再展开子链 DAG）与 `run_template` 递归 action **明确排除**（§8）。I2 交付 = 序列组合 + 克隆复用，零引擎触碰。

### 2.5 I3 · 全景可视化（扩展 `buildCanvasOverview` + OverviewPanel）

- 读模型 `CanvasOverview` + 字段 `workflows: Array<WorkflowOverviewLite>`：`{ id, name, status, autoAdvance, segments: Array<{ templateKey, templateName, seq, runId|null, runStatus|null, cost|null }> }`（每段取 `workflowId+seq` 最新 run）。纯读零写，无链则空数组（旧行为超集兼容）。
- 前端 `views/canvas` 全景 tab 的 `OverviewPanel` 新增「编排链」区：横向节点序列（模板名 + 段间箭头）+ 段状态徽章（复用 run 状态色）+ 链级 `autoAdvance` 开关（调 `PATCH`）+ 启动/暂停/续跑按钮（调对应端点）+ 状态计数；链构建器 Modal（选项目 → 依当前末段 `template.next` 建议下一模板 → 排序 → 设 autoAdvance/budgetCap → 保存/启动）。
- 遵守既有全景样式与无障碍（节点非仅色编码，带文字徽章）。

## 3. 数据与兼容

- 新表 1（`workflows`）+ `pipelineRuns` +2 可空列，全走 `ensureTable`/`ensureColumn` 幂等；旧库升级不炸、`db:generate` 基线不手改。
- `CanvasOverview` / `run 列表` 响应**只增字段**（超集兼容，旧前端不破）。
- 零新依赖；引擎/DAG/loader/refs/适配器/既有 schema 列/package **零 diff**。
- 新增文件：`services/workflow.ts` / `routes/workflows.ts` / `apps/web/src/views/canvas/*`（链构建/编排链子组件，遵守 ≤800 红线）/ `apps/server/scripts/probe-m27.ts` + `probes/m27/*.ts`。
- 修改：`db/schema.ts`（+workflows 表 +run 2 列 +ensureColumn/ensureTable 调用）/ `services/events.ts`（+4 事件变体）/ `index.ts`（注册 `onRunSettled(advanceWorkflow)`）/ `app.ts`（挂 workflowsRoutes）/ `services/canvas-overview.ts`（+workflows 聚合）/ `lib/api/*`（+workflowApi）/ `lib/types`（+Workflow 类型）/ `OverviewPanel` / README / 纲领 §五 LLM 编排分层落定 / roadmap。

## 4. 验收矩阵（exit criteria）

1. **链 CRUD + 校验**：建链/校验/启停/克隆端点；`validateWorkflowChainDoc` 对非法 templateKey/空序列报错；`next` 不一致仅 warning。
2. **自动级联正确**：探针 mock `run.completed` → `advanceWorkflow` 触发下一段 run（seq+1、input 正确解析、workflowId 归属）；**默认 `autoAdvance=0` 不触发**（仅发 segment_done）；末段完成 → 链 done。
3. **计费安全**：预算拦截（project 预算 / 链 budgetCap）→ `paused` + `blocked{reason:'budget'}` 且**不创建下游 run**；`run.failed` → `paused` 不自动重试；链首段仅 `start` 端点触发。
4. **输入映射**：`resolveSegmentInput` 纯函数对 `$prev.assets/purpose`、`$prev.text`、常量、缺省 default、required 缺失 → blocked 全覆盖断言。
5. **嵌套 I2**：`clone` 复制段序列为新 draft 链；无 `run_template` action（KNOWN_ACTIONS 零 diff 断言）。
6. **可视化 I3**：`buildCanvasOverview` 无链时 `workflows:[]`（旧前端不破）+ 有链时段/状态/成本派生正确；浏览器全景 tab 编排链渲染 + autoAdvance 开关 + 启动 e2e 无 console error。
7. **零回归**：`pnpm ci:check` 端到端 exit=0（双端 typecheck + 模板校验 + `probe:ci` **既有 23 探针全绿零适配** + probe-m27 新探针全绿）；引擎/DAG/loader/schema 既有列 零 diff（review 核对）。

## 5. 依赖与例外

- 复用：M4 `onRunSettled` 钩子 + `createRunRow`/`engine.startRun`；M20 `checkBudget`；M23 全景 `buildCanvasOverview`/OverviewPanel；M5 `template.next` 元数据。
- 无新库、无新 action、无引擎递归——不破 M23「例外原则」（不引新依赖）。

## 6. 实施批次

- **P0 数据层 + 骨架**：`workflows` 表 + `pipelineRuns` +2 列（ensureColumn/Table）+ `lib/types` Workflow 类型 + `routes/workflows.ts` CRUD 骨架 + `services/workflow.ts` 骨架（`advanceWorkflow` 空实现 + `onRunSettled` 注册）+ `probe-m27.ts` 骨架；门禁 = 双端 typecheck + 冒烟。
- **P1 串链执行引擎**：`resolveSegmentInput` + `validateWorkflowChainDoc` 纯函数 + `advanceWorkflow` 实装（级联 + 预算闸门 + 失败暂停 + 幂等互斥）+ `start/pause/resume` 端点 + events 扩展 + clone（I2）+ probe-m27（workflow-crud / segment-input / auto-advance / budget-gate / breakpoint-pause / billing-safety / nesting-clone）全绿。
- **P2 全景可视化**：`buildCanvasOverview` +workflows + 前端 `workflowApi` + OverviewPanel 编排链区 + 链构建器 Modal + 浏览器 e2e。
- **P3 实弹 + 收口**：真实项目多段串链实弹（含预算拦截与断点恢复）+ `ci:check` + review/roadmap/README/纲领 校准。

## 7. 探针设计（`probe-m27.ts`，零网络零计费，隔离临时库）

- `workflow-crud`：建/校验/改/删/克隆；非法 templateKey、空段报错；active 改 segments 守卫。
- `segment-input`：`resolveSegmentInput` 矩阵（assets 数组/单资产/文本/常量/default/required 缺失）。
- `auto-advance`：mock 上游 run completed + 隔离库直调 `advanceWorkflow` → 断言下游 run 创建、seq 递增、workflowId 归属、末段 done；`autoAdvance=0` → 不创建下游。
- `budget-gate`：设 project 预算耗尽 / 链 budgetCap 命中 → `paused` + blocked，无下游 run。
- `breakpoint-pause`：run.failed → 链 paused，无自动重试。
- `nesting-clone`：clone 段序列等价复制为 draft；`KNOWN_ACTIONS` 不含 run_template（零 diff 断言）。
- `overview-workflows`：无链 → `workflows:[]`；有链 → 段/状态/成本派生。

## 8. 明确排除

- 运行时深度嵌套（step 内跑子模板 DAG / `run_template` 递归 action）——触引擎红线，另议。
- 重型编排/任务引擎（Temporal/BullMQ 等）——roadmap 永久红线。
- LLM 决策式链推进（自动判定"下一步该跑哪个模板"）——M27 = **静态段序列 + 预算闸门执行式**，链内容由用户在 I3 可视化里显式编排；LLM 建议式仅存于 M23 画布（不执行）。§五「LLM 编排分层」就此落定。
- 剧集/series 专属编排表与跨项目链编排——M27 链挂项目级；`episodes.latestRunId` 联动不扩。
- recurring cron 定时触发链（`schedules.cronExpr` 仍 `'once'`）——排产 recurring 边界另议（§五 M20-B1/B5）。
- 链并行分叉（一 run 完成触发多下游 fan-out）——M27 段为线性序列；`template.next` 多候选仅作构建建议，不自动并行。
- 自动失败重试 / 自动跳过阻塞段——一律暂停待人工。
