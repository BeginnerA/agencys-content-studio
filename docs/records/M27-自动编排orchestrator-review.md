# M27 收官 review — 自动编排（真 orchestrator）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-17
- 设计：`2026-09-17-agencys-content-studio-m27-design.md`
- 纲领卡：`2026-09-14-agencys-content-studio-m19-m27-charter.md` §一 I 组 / §二 M27 卡 / §五 LLM 编排分层
- roadmap：`2026-09-09-agencys-content-studio-roadmap.md` §M27 注记
- 性质：**M19–M27 全量立项纲领战略收官**；本 review 逐条背书 spec §4 验收矩阵 + 收口期 CodeReview 三项修复闭环。

## 0. 一句话结论

M27 P0–P3 全批次收官。把 M5 以来「场景入口 + 完成态接力缓解」的跨模板流转升级为**用户显式编排、系统自动级联**的编排链 orchestrator：`workflows` 表 + `pipelineRuns` 2 可空列 / `advanceWorkflow` 九步执行引擎（级联 + 预算闸门 + 失败暂停 + 幂等互斥）/ I2 编排层克隆引用 / I3 全景「编排链」区 + 链构建器。`pnpm ci:check` 端到端 exit=0，**24 探针 / 2919 断言全绿**（含 probe-m27 46 断言九节）；`vite build` 绿。收口期 CodeReview 发现 1 High + 2 Medium 已全部修复并新增 `recovery-guard` 回归，复审确认**可收口**。

## 1. 验收矩阵逐条背书（对齐 spec §4）

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 数据层 | ✅ | `workflows` 表建表兜底在位（可查询）+ `pipeline_runs.workflow_id`/`workflow_seq` 两列 `ensureColumn` 幂等补齐（启动日志确认）；CRUD 建/校验/改/删/克隆全绿（probe-m27 `schema` / `workflow-crud` 节） |
| 2 | 自动级联正确 | ✅ | `autoAdvance=1` 段 0 完成 → 创建段 1 run（seq 递增、workflowId 归属）；`autoAdvance=0` 仅 `segment_done` 不建下游（计费安全默认）；末段完成 → 链 done（probe-m27 `auto-advance` 节） |
| 3 | 计费安全 | ✅ | 链级 `budgetCap` 命中 → `paused` + `blocked{reason:'budget'}` 且**不创建下游 run**；`run.failed` → `paused` 不自动重试；链首段仅 `start` 端点显式触发（probe-m27 `budget-gate` / `breakpoint-pause` 节） |
| 4 | 输入映射 | ✅ | `resolveSegmentInput` 矩阵：`$prev.assets`（id 数组）/ `$prev.asset`（单 id）/ `$prev.text`（readTextAsset 读正文）/ 字面量常量 / default 缺省 / required 缺失 → missingRequired（probe-m27 `segment-input` 节） |
| 5 | 嵌套 I2 | ✅ | `clone` 复制段序列为新 draft 链 + `autoAdvance` 复位 0 + 保留 budgetCap；`KNOWN_ACTIONS` 不含 `run_template`（零 diff 断言，probe-m27 `nesting-clone` 节） |
| 6 | 可视化 I3 | ✅ | `buildCanvasOverview` 无链 → `workflows:[]`（旧前端超集兼容）+ 有链时段/状态/成本/模板名派生（probe-m27 `overview-workflows` 节）；前端全景「编排链」区 + 链构建器 `vite build` 绿；HTTP 契约冒烟（建链 note-clip→platform-adapt / PATCH autoAdvance / 克隆 / overview 派生 / 删除清理）通过 |
| 7 | 零回归 | ✅ | `pnpm ci:check` exit=0（双端 typecheck + 模板校验 14/101/0 错 0 警 + `probe:ci` 24 探针 / 2919 断言全绿）；engine/dag/loader/refs/schema 既有列零 diff（`git diff` 核对，见 §3） |

## 2. 收口期 CodeReview 三项修复（本里程碑关键加固）

首轮 CodeReview 结论「不建议直接收口」，收口条件「至少修复 #1 与 #3」。三项均为服务层内部修复，不触引擎主链：

| # | 严重度 | 问题 | 修复 | 回归 |
|---|---|---|---|---|
| 1 | High | resume 死锁：resume 仅置 active，不重发 settle 事件、不重驱动 → 预算/输入阻塞解除或事后开关联动后链永久卡住 | 新增 `resumeWorkflow(id)`：paused→active 后取链内最大 `workflowSeq` 的已落定 run 调 `advanceWorkflow` 重新驱动；route resume 端点改接 + `WorkflowError→HttpError(404/409)` | `recovery-guard`：预算 paused → 提额 budgetCap → resume → 链转 active + 重新创建下游 seq1 |
| 2 | Medium | pause-在途推进 TOCTOU：`advanceWorkflowCore` 预算/输入解析为异步，回来后不复核状态即建下游 | 步骤⑨ `createRunRow` 前加：(a) `getWorkflow` 状态复核非 active 即 return；(b) 下游 `workflowSeq=seq+1` 存在性幂等守卫（防重放/并发双建） | `recovery-guard`：同一 completed run 重复 `advanceWorkflow` → 下游 seq1 仅一条 |
| 3 | Medium | startWorkflow 并发双启动重复计费 | `startWorkflow` 关键段包进 `advancing: Set<workflowId>`（与 `advanceWorkflow` 共享）互斥锁 try/finally；锁内「链已有 run → `already_started`」检查 | `recovery-guard`：draft 链已有 run → startWorkflow 抛 `already_started` |

复审（第二轮 CodeReview）结论：**可收口 ✅**。`has_check-and_set` 相邻无 await 构成原子互斥、`finally` 无漏解锁、锁间无嵌套获取无死锁；failed 尾段重驱动命中步骤③立即重新 paused（净效果仍是暂停，符合「不自动重试」）。

## 3. 数据与红线（零 diff 核对）

- **schema 纯加法**：新增 `workflows` 表（`idx_workflows_project`/`idx_workflows_status`）+ `pipelineRuns` 两可空列 `workflow_id`/`workflow_seq`（`idx_runs_workflow`）+ `Workflow` 类型导出。既有列逐字未动（`git diff schema.ts` = +23/-0）。
- **引擎零侵入**：`engine.ts` / `dag.ts` / `loader.ts`（`KNOWN_ACTIONS` 零增，无 `run_template`）/ `refs.ts` **零 diff**（`git status` 无这些文件）。以 `index.ts` 并列 `onRunSettled(advanceWorkflow)` 钩子接入，异常隔离不波及主流程。
- **零新依赖**：复用 `onRunSettled` + `createRunRow`/`engine.startRun` + `checkBudget` + `loadTemplate` + `template.next`。
- 新增文件：`services/workflow.ts`、`routes/workflows.ts`、`scripts/probe-m27.ts`；前端 `lib/api/workflows.ts`、`lib/types/workflow.ts`、`components/pipeline-canvas/overview/workflows-section.vue`、`chain-builder.vue`。
- 修改文件：`db/schema.ts`、`db/index.ts`、`app.ts`、`index.ts`、`services/run-create.ts`、`services/events.ts`、`services/canvas-overview.ts`；前端 `lib/types/{index,pipeline-canvas}.ts`、`lib/api/index.ts`、`lib/format.ts`、`components/pipeline-canvas/overview/index.vue`、`views/canvas/index.vue`；README / 纲领 / roadmap。

## 4. 决策与排除留痕

- **LLM 编排分层（§五）**：正式落定两级——M23 = 画布建议式（LLM 仅生成草案，不执行）；M27 = 链执行式（静态段序列 + `autoAdvance` + 预算闸门推进，**不经 LLM 决策、无运行时自动判定下一步**）。
- **autoAdvance 默认关**：schema `default 0` + `createWorkflow` 强制 0/1 + `cloneWorkflow` 复位 0。链首段启动为显式用户动作；每跳前预算闸门拦截即 `paused` 不触发。
- **明确排除**（spec §8）：运行时深度嵌套（step 内跑子模板 DAG）/ 重型编排引擎（Temporal/BullMQ）/ LLM 决策式链推进 / 剧集专属编排表与跨项目链 / recurring cron / 链并行 fan-out / 自动失败重试或跳过阻塞段。

## 5. 遗留 / 后续（Low，不阻断收口）

- **Low-1** 9a 状态复核与 `createRunRow` 之间单 `await` 极窄窗口的 pause TOCTOU 残余：无事务行锁难以完全消除，且下游 run 尚未执行代价可控，评审 #2 大窗口已闭合，接受。
- **Low-2** 「active 链事后 PATCH 打开 autoAdvance」需经 pause→resume 两步重驱动：UI 已提供可达路径（非永久卡住）；可选优化 = PATCH `autoAdvance` 0→1 时对链尾已落定 run 触发一次 `advanceWorkflow`，登记为后续 UX 增强、非缺陷。
- 浏览器交互式 e2e（全景 tab 编排链渲染 / autoAdvance 开关 / 启动点击）因本环境 browser-use 扩展不可用，降级为 HTTP 契约冒烟 + `vite build` 覆盖；交互层由 vue-tsc 类型 + 组件契约背书。
- 后续提升需求统一归档 `2026-09-17-agencys-content-studio-post-m27-backlog.md`（R01–R09，待新 L1 立项）。
