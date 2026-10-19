# M63 L1 Spec — 轻松创作 Agent 化（智能调度 + 多角色编队 + 动态面板）

> **状态：已批准实施（用户「按照推荐设计」，采纳「注册制角色 + 智能编队」混合模型）。**
> 前置复核：编号以最新 roadmap 为准（现有探针最高 `probe-m62` 且已交付；本项独立取 **M63**，design 目录无 M63 在途）。
> 构建在 M27（workflows orchestrator）/ M40（确认才立项）/ M57（routeHint）/ M30–M31（对话式成片与参考输入）之上，不推翻其契约。

## 一、背景与目标

现状：`creation-chat` 执行模板硬编码二选一（`easy-video`/`easy-dialogue`），方案契约 `creationPlanSchema` 仅覆盖「单条 30–90s 视频」，右侧面板为 5 个固定组件静态堆叠，助手人设只有一个「策划助手」。

目标：把轻松创作重构为项目内**独立智能 Agent**——LLM 意图路由自动调度全部专业模板（命中即编排/直调，未命中可合成临时模板执行）；多角色编队（哪个环节由谁说这句话）；右侧面板改为服务端决策驱动的动态卡片流。

## 二、执行模式（`AgentDecision.mode`）

| mode | 场景 | 执行载体 | 安全基线 |
|---|---|---|---|
| `easy` | 单条成片（现主路径） | easy-* 批准链 + recipe 冻结快照 | **逐字保留现状**（preflight/recipe/planHash/预算/幂等），decision 仅展示旁注 |
| `template` | 命中单个专业模板 | 既有 `createRunRow` 直调 | 确认卡含输入物化 + 成本预估，同专业端口径 |
| `chain` | 多步任务 | 复用 M27 workflows orchestrator | `autoAdvance=0` 段间暂停回对话流请求批准 |
| `synth` | 未命中任何既有模板 | LLM 合成临时 YAML → `validateTemplateText` 全量校验 → `saveTemplate`（仿制 key、`visibility:conversation`）→ `createRunRow` | 步数 ≤12、高危 action 黑名单、yamlHash 进 decisionHash |

## 三、多角色：注册制 + 智能编队（本轮核心拍板）

**否决纯 LLM 临场造角色**（人设无边界→风格漂移、不可探针断言、"自动角色"给用户"什么都能做"的错觉）。采用混合模型：

1. **角色注册表**（`agent/roles.ts` + `workspace/prompts/roles/*.md`，提示词文件即角色、零代码扩展）：角色 = 人设片段 + 代码侧能力声明（`modes` + 可调度 `templateKeys` 子集）。首批 4 角：`planner`（策划，全能兜底，唯一可 synth）、`screenwriter`（编剧）、`storyboard`（分镜师）、`operator`（运营）。
2. **智能在"点将"**：`decision.roleKey`（本条发言角色）+ `decision.team`（后续环节编队）。说话者恒在注册表内——未注册 roleKey 归一回落 planner（可见不静默，`capabilityNotes` 留痕）。能力越界（角色 mode/模板不在声明范围）由 planner 承接并留痕。
3. **换角可见留痕**：`creation_messages` 加可空 `agentRole` 列（NULL=历史消息按现映射显「策划助手」，零迁移）；换角插一条 `role:'system'` + `payload.kind:'handoff'` 留痕，复用现有 system 视觉区分先例。

## 四、契约与数据（纯加法）

- `agent/decision-schema.ts`：`agentDecisionSchema`（strict zod）+ route 原始回复 schema。`decisionHash=hashJson(decision)` 参与确认闸，语义同 planHash。
- `agent/reply-schema.ts`：三形判别联合 `clarify | plan | route`。**单独成文件打断 contract↔decision-schema 循环依赖**（zod 顶层求值 ESM TDZ）。老 `planningReplySchema` 逐字不动（存量探针依赖）。
- `agent/template-catalog.ts`：`listTemplates()` 摘要（含 inputs 声明面）注入决策 LLM；`easy-*`（conversationOnly）不进目录。确认前重验「目录命中 + 版本一致」，漂移作废旧确认。
- `agent/normalize.ts`：LLM 输出=建议值 → 服务端权威归一（能力拉回、幽灵 asset 剔除、synth 危险拦截），全「可见不静默」。
- DB：`creation_sessions` 加 `agentMode/decision/decisionHash/workflowId`；`creation_messages` 加 `agentRole`。`ensureColumn` 幂等兜底，0 迁移。

## 五、护栏（全模式统一）

- 计费三道闸：确认前成本预估 → `checkBudget` 硬闸 → 无价格项显式 `acceptUnpriced`。
- 确认闸保留（从「确认方案」泛化为「确认执行计划」）：M40 不变量不动；全自动不在本期。
- apiKey 复检、幂等键冲突 409、TOCTOU 状态复核在新代码路径逐字保留。
- 内置只读资产清单不动；synth 临时模板不进专业选择器（`visibility:conversation` 过滤）。

## 六、探针（新增 5 批）

`probe-agent-roles`（注册表/回落/归一/handoff 投影）、`probe-agent-route`（四模式 schema/目录注入/非法降级/低置信回落）、`probe-agent-confirm`（template 直调 + chain 建链段闸 + synth 校验/落盘/清理）、`probe-side-cards`（各态卡片投影断言）、`probe-legacy`（老会话逐字旧路径回归）。门禁：`ci:check` 全绿 + 权威探针串行 `--jobs=1`。

## 七、实施切片（单次交付内可编译提交）

1. ✅ schema 加列 + decision 契约 + roles 注册表 + template-catalog + prompts（纯加法，旧链路零影响，tsc 零错）
2. ✅ planning 路由改造（agent-run.ts 编排薄壳：route 注入 + parseAgentReply + easy 决策旁注/角色署名/handoff + persistRouteDecision + preflightDecision 结构闸）（tsc 零错；easy 逐字零回归，agentMode 特性开关 `CREATION_AGENT_MODE` 兜底）
3. ✅ execution 确认分派（confirmCreation 分发器：route 会话→confirmRoute(template/synth/chain)，easy→confirmEasy 逐字原样）+ synth 临时模板生命周期（saveTemplate 落盘/失败回滚/会话删除回收）+ cancel 链感知（tsc 零错）
4. ✅ projection/detail 泛化（projectGenericRun 通用降级投影：route 命中的 template/synth/chain 段按 `!isCreationTemplate` 分叉，逐 step 状态 + 文本/成片产物；easy 六段精细投影逐字零回归）+ sideCards 服务端权威下发（side-cards.ts 纯函数按会话态/decision.mode/run 态派生卡片流；creationDetail 下发 decision/sideCards/agentMode/workflowId）+ 角色署名投影（messages 带 agentRole+roleName，历史无角色回落「策划助手」）（tsc 零错）
5. ✅ 前端卡片流重构（detail.vue 右侧改为服务端 sideCards 驱动的注册表渲染）+ 新组件（AgentGuideCard 引导/规划中、AgentDecisionCard route 待确认（角色/rationale/模式预览/编队/确认）、ChainProgressCard 链段序列）+ 角色署名渲染（whoLabel 用 roleName+handoff 标签）+ route 确认链路（use-creation-chat confirmRoute/decisionKey/isRoute + API 体扩 decisionHash/decisionRevision）+ 文案改名「智能创作」（导航/主标/入口；路由路径与组件目录名保留）（vue-tsc 零错；easy 面板逐字复用现有组件零回归）
6. ✅ 探针五批（`probe-m63.ts` 单文件内 route/confirm/side-cards/legacy/roles 五节 **52 断言全绿**：isolatedEnv('m63', bridge templates+prompts) 零 DB/零网络/零模型；首跑即捕获并修复 normalize.ts 归一层「base 早判 length 丢弃 sanitizeInputSpec 后置留痕」真实缺陷，改持 live notes 引用落实「可见不静默」）+ 文档同步（milestones.md M63 速览 / records 索引行 / templates.md 智能创作 Agent 调度说明 / README 功能条目改名）+ 收口验证（双端 `tsc`/`vue-tsc` exit 0；creation-chat 全谱探针零回归 m40/m41/m42/m43/m44/m45/m46/m56/m57/m58/m59/m62/m63 全绿；修复本项自引入的 ConversationPanel.vue 红线回归 713→839→拆分纯函数/计时 composable 至 790≤800）。**全仓 `pnpm ci:check` 因 3 个先于 M63、与本项无关的既存 >800 文件（seed-learning-canvases.ts 1140 / CanvasBoard.vue 846 / board/index.vue 831，git diff 证实本会话未触碰）仍红（m26 常红门禁）——经用户确认另立专项处理，不在 M63 混入无关大面重构。**
