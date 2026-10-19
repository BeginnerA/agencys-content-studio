# M65 智能创作图片反推决策契约收口（design）

> 状态：✅ 已实施收口（2026-10-19）。来源：M63/M64 交付后**用户实弹目检**暴露的决策契约缺口。
> 关联：M63 轻松创作 Agent 化（决策契约真源）、M64 智能创作 Agent 收口遗留。

## 一、背景与触发

M63（决策契约）+ M64（收口遗留）探针全绿，但其验证止于「`isolatedEnv` 起真库 + 打桩 `engine.startRun` 的状态机断言」——喂进 `parseAgentReply` 的是**手工构造的合法/非法 JSON**，从未驱动**真实 LLM 对真实用户输入的产出**。M64 收口时明确标注该边界为「验证到探针层、未做实弹目检」。

用户在智能创作界面实弹操作：上传一张「风格参考」图 + 输入「反推图片提示词」→ 返回红字 **「规划结果不符合结构契约，请修改要求后重新发送；尚未启动媒体生成」**。实弹击穿探针边界。

## 二、根因（代码级坐实，非推断）

1. 智能创作 Agent（`agentMode=1`）在 [`agent/reply-schema.ts::parseAgentReply`](../../apps/server/src/services/creation-chat/agent/reply-schema.ts) 强制模型**一次回复产出三形之一**（`clarify` / `plan` / `route`）的严格 JSON。
2. 「反推图片提示词」本质是**图片多模态反推**诉求，不是「做一条短视频」。模型的自然产出是反推提示词**散文**（非 JSON）→ `JSON.parse` 抛错 → `catch {}` **吞掉真实原因**直接判 `invalid_plan`。
3. 讽刺的是真正的交付物早已算出：[`planning.ts::compileReferenceContext`](../../apps/server/src/services/creation-chat/planning.ts)（L73 起）在 `vision && reverseIntent` 下逐图反推产出 `imageAnalyses`。但它的透出（消息 `payload.imageAnalysis`）在决策解析**下游**——解析一抛异常，整轮连同已反推结果被连带丢弃。
4. 可诊断性缺口：`catch {}` 不落任何日志，LLM 层也不持久化原始响应 → 失败的真实原因无法回捞。

## 三、方案（行为等价重构 + 窄接管，纯加法）

### 3.1 可诊断性收口（reply-schema.ts）

`parseAgentReply` 的 `catch {}` 改为 `catch (err)`：把真实原因（`z.ZodError` 展平前 8 条 issue / `SyntaxError` JSON 语法错 + 有界 400 字输出前缀）经 `createLogger('creation-agent').warn` 落**服务端日志**；用户侧仍只见通用文案。「可见不静默」= 对开发者可见，不把模型原始输出 / 内部细节吐给终端用户（apiKey 泄漏已在上游 L274 拦截）。

### 3.2 纯图片反推 fallback（planning.ts）

决策解析处（L276）包 `try/catch`。解析抛 `invalid_plan` 时，**当且仅当**三条件同时成立才接管：`reverseIntent`（反推措辞）+ `refComp.imageAnalyses.length > 0`（本轮已产出反推交付物）+ 错误码 `invalid_plan`。接管动作：不判死，透出已反推交付物。判定与落库各抽为**导出可直测单元**（行为等价重构）：

- `shouldDeliverReverseFallback({ reverseIntent, imageAnalysisCount, error })`：纯谓词。
- `persistReverseFallback(id, claimed, imageAnalyses)`：乐观锁将 `planning` 态会话回 `draft`（清空 plan/decision/preflight/error，`planRevision+1`），插一条 `payload` 为 `{ kind:'clarify', questions:[2 条], imageAnalysis }` 的助手消息。

前端 [`ConversationPanel.vue`](../../apps/web/src/views/easy-create/ConversationPanel.vue)（L266-270）对**任意** assistant 消息只要 `payload.imageAnalysis?.length` 即渲染 `PlanImageAnalysis` 反推卡（与 `kind` 无关），clarify 追问 chips 亦既有——**零前端改动**。

### 3.3 红线

- 普通成片诉求解析失败（无反推产物 / 非反推措辞）→ 仍按 `invalid_plan` 可见拒绝，**easy 批准链逐字零回归**。
- `imageAnalyses` 本就只在 `vision && reverseIntent` 下产出，接管面天然窄；不新增付费面、不改提示词契约。

## 四、验证

`probe-m64` 新增 `reverse-fallback` 节 **12 断言**：判定真值表 5（全条件/非反推/无产物/非 invalid_plan/非 CreationError）+ 三形皆不合触发 3（散文非 JSON / clarify 缺 questions / route 缺 rationale）+ `persistReverseFallback` 真库落库 4（回 draft+revision+1+清 error / clarify 消息+2 追问 / payload 携反推交付物 / 乐观锁二次 conflict）。

**首跑即捕获本次真因**（日志实证）：`reason: "JSON 解析失败（Unexpected token …）：输出可能非纯 JSON"`——坐实「模型对反推诉求吐散文」的根因假设。

全仓 `pnpm ci:check`（`pnpm -r typecheck` && `validate:templates` && `probe:ci` 串行全量）端到端全绿：**65 探针 / 5668 断言**（较 M64 收口 5656 增 12，即本项新增）。

## 五、遗留与边界（诚实标注）

- 本项修复的是「反推交付物被决策解析失败连带丢弃」这一具体缺口 + 可诊断性。**未**改动 `clarify.questions.min(1)` 老约束（M63 前即存在、非本次回归）；若后续真实模型频繁返回「无 questions 的边界说明形」，可另议放宽。
- fallback 的真库落库经探针直测 `persistReverseFallback` 坐实；但「真实 LLM 端到端触发整条 `sendCreationMessage` → 命中 fallback」仍需一次实弹目检（需 vision+决策两次真实多模态调用，探针以 fetch 双桩驱动过于脆弱，故未纳入自动化）。
