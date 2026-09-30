# M40 L1 Spec — 轻松创作「确认才立项 + 立项信息智能填写」

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-20 ｜ 里程碑：M40（路线图收官后的用户流程优化项）｜ 前置：M30–M39 已交付
- 纪律：**0 新表 0 新列 / 0 数据迁移**（端点：新增 1 个 `DELETE /creation-sessions/:id`，其余零变更）；立项信息不进 planHash（改元信息不作废已确认方案）；不静默降级、回落可见

## 一、背景与目标

用户反馈：轻松创作发送第一句话时就创建项目（name=原句前 40 字、genre 固定 talking_head、tags「创作草稿」），
规划完成仅回写 name——**每次都要去项目页把名称/载体/模板/标签/简介再改一遍**。

M40 两点意图：

1. **时机**：发送只是规划；点「按此方案开始制作」（confirm）才真正立项。
2. **智能填写**：项目名称 / 载体 / 模板 / 标签 / 简介由平台按方案自动填好（Tier A），确认前预览、逐项可覆盖（Tier B）。

## 二、方案决策（用户拍板，全选推荐项）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 立项方式 | **草稿影子项目**（`projects.status='draft'`） | assets/usageRecords/budget/preflight/工作区目录全部以 projectId 为键，真·延迟建项目需 `creation_sessions.project_id` 可空 + 目录重构（核心数据模型变更）；draft 态用户可见效果等价且零迁移 |
| 元信息来源 | **LLM 产出 + 服务端真源校验兜底** | LLM 懂内容但会幻觉模板 key；服务端 `deriveProjectMeta` 规则派生保底，`sanitizeProjectMeta` 逐项校验回落 |
| 交互 | **预览 + 可覆盖** | 方案卡「将创建的项目」区块默认展示智能填写值，任何一项可改，随 confirm 提交 |

## 三、服务端设计

### 3.1 契约（`services/creation-chat/contract.ts`）

- `projectMetaSchema`（严格形，入库前必过）：name ≤60 / genre ∈ 字典 / templateKey 非空 / tags 1–6 个各 ≤20 字 / brief ≤500。
- `projectMetaInputSchema`（宽松 catchall）：LLM 建议与用户覆盖值一律先宽松收下，交给 sanitize——**一个标签超长不得把已计费的整份方案判为 invalid_plan**。
- `planningReplySchema` plan 分支与 `confirmationSchema` 各加可选 `project`，**与 plan 同级**：不进 plan → 不进 `planHash = hashJson({plan, execution})`。

### 3.2 真源模块（新建 `services/creation-chat/project-meta.ts`）

- `deriveProjectMeta(plan)`：slideshow→图文 / story→短剧 / 其余→口播；name=方案标题、brief=方案摘要、tags=[轻松创作, 载体, 形态, 画幅] 去重 ≤6、templateKey=`easy-video`（本次真实执行模板）。
- `sanitizeProjectMeta(input, plan, base?)`：缺项静默回落（不当作有效值也不产噪音）；有值但非法（空/超长/不在字典/模板不存在）→ 回落 + `notes[]`（不静默降级）。`base` 为草稿行现值（confirm 时优先于规则派生，项目归用户所有）。
- `projectMetaPrompt()`：规划 messages 注入载体字典 + `listTemplates()` 真实模板候选 +「与 plan 同级、可整个省略」指令。
- `renderMetaNotes(notes)`：非空时统一以「（立项信息已按平台真源调整：…）」追加进 assistant 回复。

### 3.3 生命周期

- `createSession`：项目行 `status='draft'`、genre 'other'、tags ['轻松创作']（占位，仅作为会话资产键）。
- 规划出 plan：sanitize 建议 → 覆写草稿行 5 项（仅当仍为 draft；active 项目绝不覆写）；clarify 不动值。
- `confirmCreation`（同事务、同幂等键）：`base=草稿行现值` → `sanitize(request.project ?? {})` → 更新 5 项 + `status='active'` → 插入「已创建项目《…》」assistant 消息（有调整时带 notes）。非法覆盖照常启动不 nit 打断。
- `GET /projects`：status 白名单（仅 archived 走 archived，其余归 active）——draft 影子项目任何入口都不外泄；会话详情 `session.project` 透出 `{id,name,genre,templateKey,tags,brief,status,isDraft}` 供预览。

### 3.4 删除会话（新建 `services/creation-chat/session-delete.ts`）

影子项目带来的唯一副作用：「聊了一半放弃」的会话会在库里永久留一条不可见的 draft 行。提供 `DELETE /creation-sessions/:id` 闭环，**删除范围按是否立项分两种，绝不静默多删**：

- **未立项**（项目 `status='draft'` 且本项目下无任何 run）→ 事务内级联清除：该影子项目名下全部 `creation_messages` + `creation_sessions`（createSession 与会话 1:1，兄弟行即自身）+ `assets`（M31 参考素材）+ `usage_records`（规划记账，与项目 purge 同口径）+ `projects` 行；提交后 `rmSync(projectAbsDir)` 回收磁盘目录（失败仅告警）。
- **已立项 / 项目已软删 / 草稿行竟挂 run** → 只删本会话行与其消息，项目、run、产物原样保留；`mode='session_only'` + `reason` 明告原因，由前端转告（项目要删请走项目页）。
- **在途保护**：`status ∈ {planning, starting}` → 409 `session_busy`；关联 run 仍在 `queued|running|waiting_input` → 409 `run_active`（不删掉正在进行制作的唯一控制记录）。全部写操作走 `creationWrite` 串行锁。

## 四、Web 设计

- `use-creation-chat.ts`：`projectDraft` 可编辑态 + `dirty` 护栏（用户改过后服务端回读不冲掉输入）；`projectOverrides()` 只提交与智能填写值不同的字段；confirm 成功后 dirty 重置交回真值。
- `CreationPlanCard.vue`：「将创建的项目」区块（仅 isDraft 且未确认时显示）：名称输入 / 载体下拉（`lib/scene PROJECT_GENRES`）/ 模板下拉（`templateApi.list()` 懒加载，当前值缺席时兼容追加）/ 标签逗号文本 / 简介 textarea + 回落规则说明。
- `detail.vue`：草稿期隐藏「项目」链接（转正后才可点进）；`index.vue` / idle 文案改为「确认前不立项；点开始制作才创建项目，5 项信息自动填好、可改」。
- [M40+] `index.vue`「我的创作」卡片右上角删除按钮：按 `status==='started' || runId` 分措辞的 `confirmDialog`（已立项明说项目会保留），结果与失败原因就地显示在网格下方（`del-notice` / `del-notice.err`），不假称已删；`use-creation-chat.removeSession()` 删成功后本地剔除列表项、若删的是当前会话则停轮询并清空详情。

## 五、探针（`scripts/probe-m40.ts`，6 节 80 断言）

meta（纯函数派生/校验/notes）· contract（向后兼容、错位拒绝、hash 不受影响）· draft（HTTP 面列表不外泄、isDraft 预览）· plan（stubFetch 回放：智能填写 / 越界回落可见 / active 不覆写 / clarify 不动值 / hash 不变）· confirm（转正 + 逐项覆盖 + 非法覆盖回落照常启动 + 幂等不重复立项 + 立项消息）· delete（未立项连项目/素材/磁盘目录一并回收、已立项只删记录且项目保留、planning/在途 run 拒绝且无副作用、异常 draft+run 降级、404/400）。

## 六、边界与遗留

- 删会话时影子项目的 `usage_records` 一并清除（与会话同生命周期、已从任何成本报表的项目维度移除）；全局成本/预算统计仍含这笔 LLM 花费（按时间聚合不依赖项目行在位）。
- 直连 `GET /projects/:id` 仍可访问草稿（只是不进列表，非权限隐藏）；轻松创作内部（附件、预检）依赖 projectId 稳定，行为不变。
- 已立项会话删除后，其 run 仍可从项目页访问（run 行不存 sessionId，仅 `creationSessionId` 作建 run 闸门参数，无级联风险）。
