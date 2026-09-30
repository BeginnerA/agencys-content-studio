# M31 设计（L1 spec）— 对话式参考输入（图 / 视频 / 角色 / BGM）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 状态：待用户评审批准；未获批不改业务代码。构建在 M30 之上，不推翻 M30 契约。
- 来源：post-M27 backlog R07「对话式专业协作层」的**参考输入子集**增量；C3 触达 R04（角色视觉一致性）但不宣告 R04 完成。
- 目标：在 `/create` 对话里上传参考素材，让方案与成片受其约束——参考图定风格/首帧、参考视频供内容与文案、角色/产品图保一致性、上传 BGM 混音。**确认内容即执行内容、不静默降级、不编造**三条红线与 M30 同源，逐条延伸到参考素材。

## 范围（用户已确认全要）

| 能力 | 交付 | 依赖地基 |
|---|---|---|
| C1 参考图→风格/首帧 | 图作整体风格锚，或直接作某镜 i2v 首帧 | 多模态 `ChatMessage.image_url`（M13）+ i2v（M30） |
| C2 参考视频→内容/文案 | 视频解析出场景/文案/节奏，作规划的文字化参考 | `video_analyze` + ASR（M25） |
| C3 角色/产品一致性 | 人物/产品图跨镜头保持同一形象 | `attachRefAssets`（M13）+ ai_image 参考 / i2v 首帧 |
| C4 音频/BGM/品牌素材 | 上传 BGM 明确引用进合成 | `loadBgmAsset`（M11，现 strict 关闭） |

实施顺序：附件契约与上传 → 规划注入与 refs 编译 → 预检/计费/幂等 → 前端 composer → 探针 → 全链验证。

## 数据与附件契约（零新表零新列）

- 复用 `creation_messages.payload`（JSON）承载 `attachments:[{assetId, kind, role}]`；`creation_sessions` 不新增列——已采纳的参考编译进 `plan`/`preflight.execution`，随现有 JSON 持久化并进 `planHash`。
- 新端点 `POST /api/v1/creation-sessions/:id/attachments`（multipart，字段 `file` + `role`）：把文件上传进**会话所属项目**（复用 `POST /projects/:id/imports` 的 sha256 去重与资产登记），核验类型/大小上限，返回 `{assetId, kind, thumbUrl}`，并记一条带 attachment 的 user 消息；**不触发规划、不产生 LLM 费用**。
- `messageSchema` 与 `create` 增可选 `attachments?: number[]`（本项目内已上传资产 id）。规划前逐个核验：属本会话项目、未软删、`kind` 与 `role` 匹配（image/video/audio），否则 `CreationError` 拒绝，不静默忽略。
- 首条想法带图：UI 先 `create(idea)` 得会话 → `POST /:id/attachments` 上传 → 带 `attachments:[id]` 的 `send` 触发规划。`create` 语义不变，避免首轮双计费。

## recipe / execution 契约（refs 进哈希）

- `recipeSchema` 在既有 `sources`（固定 3 条文本）之外新增 `refs: z.array(refSchema).max(12).default([])`；`refSchema = { assetId, kind:'image'|'video'|'audio', role:'style'|'first_frame'|'subject'|'content'|'bgm', hash, shotId? }`。`PreparedRecipe` 随之携带 refs，故 `hashJson({plan, execution})` 天然包含参考指纹——**参考被编辑或删除 → planHash 变 → 旧确认冲突**。
- `assertRecipeSources` 扩展到 refs：核验项目归属、`deletedAt`、`kind`、内容 hash（image/video/audio 走二进制摘要，text 走现有 `readTextAsset`）；任一不符停机报「参考素材已变化，请重新确认」，绝不消费新版本。
- `frozenSettings` 把 `first_frame`/`subject` 参考图解析为 ai_image/ai_video 的参考输入（base64，走既有适配器首帧通道）；`bgm` 参考解析为合成期 BGM 资产。

## 规划注入契约（有界、可核实、不编造）

- image `role:'style'`：仅当配置的 LLM 声明支持视觉（实例 `extra.vision:true`，不按模型名推断）时，以 `image_url` 分片注入规划上下文；否则**不假装理解风格**，降级为「仅可作首帧」并明确告知。
- image `role:'first_frame'|'subject'`：编译进对应 shot 的 refs，走 i2v 首帧或 ai_image 参考；能力不支持首帧则 `first_frame_unsupported` 拒绝（沿用 M30），不悄悄改文生视频。
- video `role:'content'`：执行 `video_analyze`（M25）产出 `{duration, scenes, transcript}` 摘要文本注入规划；**产品参数/价格/功效只取视频内实际可见/可听内容，缺失仍不得编造**；解析失败或无 audio/多模态实例 → 明确 blocker，不跳过。
- audio `role:'bgm'`：登记为方案 BGM 候选，不进 LLM 上下文；仅影响合成。
- 上下文仍「当前方案 + 有界最近对话 + 有界参考摘要」；原始消息与附件完整保存。

## 预检 / 计费 / 幂等

- `estimate` 增 `refs` 计数与 `analysisCost`（视频解析 = ASR + 多模态 token，按 `usage` 计价）；多模态规划 token、视频解析、参考图数量分别入 `knownCost` 或 `unpriced`——**价格缺失不按零元**，未计价项同卡显式接受（沿用 M30）。
- 附件上传本身不计费；`video_analyze` 在**规划阶段**执行即产生费用，须在触发前提示，费用记入项目并携带 sessionId。
- 确认/重试/幂等语义不变：refs 已进 planHash，重复确认/双击/网络重发只得同一 run；预算检查覆盖含参考的预计费用。

## 合成（ffmpeg_merge）

- 现状 `bgmAsset = strict ? null : loadBgmAsset`（M30 严格模式关闭 BGM）。M31 **窄口径 opt-in**：仅当方案批准了 `role:'bgm'` 参考时，严格模式放行该**用户明确上传/已存在**的 BGM（volume/fade 走现有参数），默认仍无 BGM——不违反 M30「不额外生成 BGM」（此处为使用用户素材，非生成）。
- 首帧/参考图不改变严格交付链：仍逐镜核验时长、缺镜/损坏/时长不足/错映射不报成功。

## creator-ui

- `ConversationPanel` composer 增文件选择（图/视频/音频，前端类型与大小预校验）+ 缩略图/文件名预览 + 每条附件 role 选择（风格/首帧/内容/BGM，默认按 kind 推断可改）。
- 方案卡 `CreationPlanCard` 增「参考素材」区：列出已采纳 refs（缩略图 + 用途 + 供应商是否真能消费）、视频解析摘要来源、BGM 来源；未计价/待核实项沿用红/黄条。
- 上传/解析产生费用的明确提示；专业入口与返回不变。沿用紫靛 token、原生 CSS、键盘/焦点/读屏/reduced-motion。

## 边界（Ask first / Never，与 M30 同源并延伸）

- Never：静默降级（视觉不可用不假称理解、无首帧不改文生、无解析实例不跳过）、编造参考里没有的参数/价格/功效、克隆声音（沿用 `clone:` 拒绝）、自动发布/采购、跨项目引用、密钥进入对话/计划/日志、未经请求 commit/push。
- Ask first：付费实弹（含视频解析/多模态真实调用）、新增依赖、超出「零新表零新列」的 schema 变更、范围扩展。
- Always：加法迁移、服务端→探针→前端、如实记录未通过门禁、收口写验收并校准 roadmap。

## 工程与验证

技术栈不变，不增重型依赖。目录：服务 `services/creation-chat/`（新增 `attachments.ts`）、路由 `routes/creation-chat.ts` 增 attachments 端点、探针 `scripts/probe-m31.ts`。

从项目根执行：

```sh
pnpm --filter @acs/server exec tsx scripts/probe-m31.ts
pnpm ci:check
pnpm --filter @acs/web build
```

`probe-m31`（零网络零计费，隔离库 + 模拟供应商 + 本地素材）分节覆盖：附件上传类型/大小/归属/去重；refs 进 planHash 且编辑/删除停机；视觉不可用不降级；无解析实例明确 blocker；BGM strict opt-in 且默认无 BGM 逐字节不变；跨项目引用拒绝；成本可见（多模态/解析入 estimate 或 unpriced）；首帧参考进 i2v 产出可解码 MP4；旧 M30 无参考路径零回归（扩 `probe-m30` media 节加一条 ref-first-frame）。

浏览器验收桌面/窄屏：上传图→方案受其约束→确认→成片；上传视频→解析摘要进方案；上传 BGM→成片含音轨。真实参考样片（尤其视频解析与一致性效果）需另行明确模型及预算授权，离线绿不替代真实质量验收。

## 里程碑与 roadmap

- 立项 M31；开工前按最新 roadmap 复核编号。roadmap R07 增补「参考输入子集已立项 M31」，R04 标注「M31 触达跨镜一致性参考，未宣告完成」；R03/R05/R06/R08/R09 保留。
- 明确排除：运行时可编程供应商、多用户/远程部署、自动质量返修循环、口型同步、完整 NLE、成片后自然语言局部返修（延续 M30 排除项）。
