# M64 L1 Spec — 智能创作（原轻松创作）Agent 化收口遗留专项

> **状态：立项待实施（M63 交付后代码实态审计发现的收口遗留，独立成项处理，不回改 M63 冻结正文）。**
> 前置：M63「轻松创作 Agent 化」已交付（`docs/records/M63-轻松创作Agent化-design.md`，提交 `de3e718`），双端 `tsc`/`vue-tsc` + creation-chat 全谱探针零回归。本项**只补 M63 未闭环 / 未验证 / 未收口的部分**，不推翻 M63 契约（easy 批准链逐字不动）。
> 构建在 M27（workflow orchestrator：`startWorkflow`/`advanceWorkflow`/`resumeWorkflow` + `POST /workflows/:id/resume`）之上，**复用编排器续跑能力，只补对话侧接线**。

## 一、背景：M63 遗留审计结论

M63 交付质量门禁本身全绿，但对照其 L1 Spec 的承诺逐条核代码实态，发现四类「写了分派 / 起了头，但闭环或验证缺失」的收口遗留。均为**代码实态证据**（非文档臆测），列为本项范围。

## 二、遗留清单与范围（按优先级）

### G1 · chain 段间「对话内批准续跑」闭环缺失（`P1`，功能）

- **实态证据**：`route-execution.ts::startChain` 以 `autoAdvance=0` 建链并落 `chain-start` 助手消息，明示「段间将暂停回对话请求你的批准再继续」；`AgentDecisionCard.vue` / `ChainProgressCard.vue` 亦重复该承诺。但 `services/workflow.ts` 全仓**无任何 `creationSession` / `creationMessages` 引用**——段落 run 落定进入 `paused` 时，编排器不会向所属创作会话回写「第 n 段已完成，待批准」的消息；`detail.vue` / `use-creation-chat.ts` / `side-cards.ts` 对 chain 续跑态**零接线**（`side-cards` 仅出 `chainProgress` 只读卡，无「待续跑 + 批准」动作）。用户当前**只能跳出到通用页 `/workflows/:id` 手动 resume**，与设计承诺的「回对话流请求批准」体验断裂。
- **范围**：落实对话内闭环——① 段落定（`autoAdvance=0` → workflow `paused`）时，向关联 creation session 追加一条「待续跑批准」留痕（system 或 assistant 署名，带 workflowId + 段序）；② `computeSideCards` 新增 `chainAwaiting` 卡（当 run 落定且 workflow=paused 且仍有后续段）；③ 前端一键「继续下一段」调用既有 `POST /workflows/:id/resume`（或新增薄封装 `POST /creation-chat/:id/advance-chain` 转发），**同样过确认闸/预算闸/幂等**，不新造编排逻辑。
- **验收**：probe 断言「首段落定→workflow=paused→会话出现待续跑留痕 + awaitCard 投影」；批准动作触发后起下一段（复用运行探针 e2e）。

### G2 · `confirmRoute` 三形态执行链零运行探针（`P1`，测试）

- **实态证据**：`probe-m63.ts` confirm 节仅覆盖**纯函数**（`routeDecisionOf` 分派 / `preflightDecision` 结构闸 / `materializeInputSpec`）。而 M63 核心价值——`confirmRoute` 的三种真实执行分派——**零运行时验证**：`startTemplate`（`createRunRow` + `engine.startRun`）、`startSynth`（`saveTemplate` 落盘 + 事务失败 `deleteTemplate` 回滚）、`startChain`（`createWorkflow` + `startWorkflow` 首段 + 失败 `setWorkflowStatus(cancelled)` + 回 `ready`）。
- **范围**：补 `isolatedEnv('m64')` 真库运行探针（**无需 mock LLM**——手工落 `session + decision` 后直接调 `confirmRoute`）；断言：① template→项目转 `active` + 新 run 行 + 会话 `status=started` + `runId` 回写 + **幂等**（二次确认命中 `if (s0.runId) return` no-op）+ 乐观锁失效（改 `decisionHash`/`revision` → `stale_plan`）；② synth→临时 yaml 落盘（`visibility:conversation`）+ 起 run；**事务失败→临时件被回滚删除**；③ chain→`workflow` 行 + 首段 run + `workflowId` 回写；`startWorkflow` 抛错→`cancelled` + 会话回 `ready`。`engine.startRun` 以桩拦截（避免真实外部计费），只断状态机与副作用写入。
- **验收**：`probe-m64` confirm 节若干断言全绿。

### G3 · synth 临时模板 GC 零运行探针（`P2`，测试）

- **实态证据**：`session-delete.ts` 对 `mode==='synth'` 决策调 `deleteTemplate(synth.templateKey)`（仿制 key `agent-s{sid}-*` 会话隔离），但**无探针验证文件真被删**；`startSynth` 起 run 失败的孤儿件仅靠 `catch` 里 best-effort 删（异常吞掉即残留）。
- **范围**：断言 ① 会话删除后 `workspace/templates` 下 `agent-s{sid}-*` 消失；② 伪造孤儿 `agent-s*` 件在回收路径被清；③ `visibility:conversation` 件**不出现在专业 `listTemplates()` 选择器**（回归 M63「不进专业选择器」不变式）。
- **验收**：`probe-m64` synth-gc 节断言全绿。

### G4 · 既存 >800 行文件红线拆分（`P2`，工程债，M63 明确「另立专项」）

- **实态证据**：`seed-learning-canvases.ts` 1140 / `CanvasBoard.vue` 846 / `components/creation/board/index.vue` 831——先于 M63、`git diff` 证实 M63 会话未触碰，但撑红 m26 `split-audit` 常红门禁，使**全仓 `pnpm ci:check` 无法端到端全绿**（M63 交付时经用户确认「仅收口 M63、不动无关文件」，本项承接该遗留）。
- **范围**：循 [M26-split]/[M62-split] **行为零变更**先例，各拆至 ≤800 行（Vue SFC 抽子组件/composable、脚本按数据与逻辑分片）；不改任何对外契约。
- **验收**：`probe-m26` `split-audit` 全绿 + **全仓 `pnpm ci:check` 首次端到端全绿**。

## 三、红线与不变式（本项自身护栏）

- **不触碰 easy 批准链**：M63 的 recipe 冻结 / planHash / 逐镜续跑 / `confirmEasy` 逐字不动（G1/G2 只作用于 route 会话）。
- **复用不重写**：G1 续跑复用 M27 `resumeWorkflow` + `/workflows/:id/resume`，批准动作同样守确认闸（`decisionHash`/乐观锁）、`checkBudget`、幂等键；不新增编排算法、不新增付费面。
- **纯加法**：`side-cards` 新增卡键、会话新增一条待续跑留痕消息类型，历史会话零回归。
- 内置只读资产清单不动；synth 临时模板仍 `visibility:conversation` 不进专业选择器。

## 四、实施切片（单次交付内可编译提交）

1. ✅ G2 + G3 运行探针先行（`probe-m64.ts` 五节 **24 断言全绿**、首跑即过——**证实 `confirmRoute` 三形态真实执行链端到端可用、无缺陷需修**，并坐实 synth 失败路径无孤儿件 + GC 回收有效：isolatedEnv('m64') 起真库、直插 ready 态 agent 会话、打桩 `engine.startRun` 零计费，断言 template 直调起 run+项目转正+幂等 / synth saveTemplate 落盘+visibility:conversation 不进专业目录 / chain createWorkflow(autoAdvance=0)+首段 run+workflowId 回写未级联 / guards not_ready·stale_plan·template_drift·synth 失败无残留 / synth-gc 会话删除回收仿制件。关键：模板目录用**拷贝**非 junction（避免 synth 写污染真仓）。零 src 改动）
2. G1 chain 对话内批准闭环：编排器回写待续跑留痕 + `side-cards` `chainAwaiting` 卡 + 前端批准接线（调 `/workflows/:id/resume` 或薄封装）+ 探针。
3. G4 三个 >800 文件行为零变更拆分（风险最高，独立切片，可并行评审）。
4. 文档同步（milestones M64 / records 索引 / roadmap 收口）+ 全仓 `pnpm ci:check` 端到端收口。

## 五、门禁

`probe-m64`（confirm/synth-gc/chain-await 节）全绿 + creation-chat 全谱回归（m40–m46/m56–m59/m62/m63）零回归 + 双端 `tsc`/`vue-tsc` exit 0 + **G4 完成后全仓 `pnpm ci:check` 首次端到端全绿**（权威门禁用串行 `run-probes --jobs=1` / `--fail-fast`）。
