# M58 L1 Spec — 轻松创作「参考反推可检视交付」

> **状态：已实施（2026-09-30，probe-m58 六节全绿；机制修正见 §零；图片反推补口见 §零.5）。** 构建在 M31/M25 之上，不推翻其契约。
> 前置复核：编号以最新 roadmap 为准（取 M58）。
> 纪律：**0 新表 0 新列 0 新增 action**（复用 `video_analyze` + `ai_text` + `storyboard-json` 既有件）；不静默降级、参考里没有的信息不得臆造（延续 M31）；解析费用已计入口径不变。

## 零、实施态机制修正（对下文 §三/§四/§六 的原意偏差点，以实测契约为准）

1. **2a 不直接回填 `plan.shots`（修正 §3.2）**：初稿不逐镜替换 LLM 方案，而是服务端 `parseStoryboardDraft` 宽松收口后经 `renderStoryboardDraft` 渲染为蓝本，注入规划 system 消息（draftNote）——规划 LLM 以蓝本为据适配轻松创作契约产出完整方案。反推初稿 → 方案是**参考性转化**而非机械搬运，保住叙事完整与契约合法。完成后服务端**先剥 LLM 自报 `source` 键、再按事实统一写/清** `shot.source:'reverse'`（draftUsed 则整片标反推；逐镜归属不可靠故不逐镜猜）。非契约输出/异常 → 可见 system 说明不静默，方案照产但不标 reverse。
2. **字段形收敛（修正 §3.1）**：条目实名 `assetId`（非 sourceAssetId），由 `refsAnalysisEntrySchema` strict 收口（越界键拒收），并增 `name/transcribed/truncated` 可检视字段；条目上限 `MAX_REFS_ANALYSIS=12`。无参考时 `refsAnalysis=undefined`，`hashJson` 落库时键自动脱落 → 老路径 JSON 逐字零漂移（机制保证而非约定）。
3. **计费口径（修正 §四）**：2a 初稿调用复用规划同 llm 端点（`chatCompleteDetailed`），`recordUsage(purpose:'storyboard_draft')` **先入账后进预算闸**（沿用 M31 分析期事实计费口径）；不进 estimate 新付费面。措辞真源 `REVERSE_INTENT_WORDS`/`wantsReverseIntent` 导出自 M57 route-hint 同源（探针直验两处同措辞一致命中，防漂移）。
4. **探针边界（修正 §六）**：probe-m58 为纯函数+契约级（schema/normalize/draft/gating/drift/images），零网络零 stubFetch（2a 接线部分验其纯函数前置与契约承载，不真调模型）；M31 回归凭 probe-m31 全绿（含 compileReferenceContext 新返回形 `{messages,analyses,imageAnalyses}` 调用形同步）。
5. **图片反推补口（后补，用户指出原指令为「图片视频反推都要做」）**：原 §七把图片风格反推留 backlog 是实施时的窄化，已补真功能——对话内上传参考图 + 反推措辞 + vision 实例 → 复用 `image_analyze` 多模态核心（抽出可复用函数 `analyzeImageSources`，与 `analyzeVideoSource` 同构）逐图反推可投产 `image_prompt`，产物编进 `plan.imageAnalysis`（strict 收口、≤8 图、字段有界截断，进 planHash 与 refsAnalysis 同律）；反推文本简报注入规划上下文作 shots 画面/风格基准（不再重复注入原图 image_url，省一次多模态往返）；失败/无可用图 → blocker 不静默不编造；route-hint 新增信号 3b（hasImageRef+vision+措辞→`image-reverse` 完整文案包路线建议）；0 新表 0 新 action 0 新付费面（计价口径同 image_analyze）。
6. **产物落点二次修正（用户实测反馈「反推不对」）**：初版仅在 `reply.kind==='plan'` 时把产物写进方案卡，而反推实际在规划模型调用前（`compileReferenceContext`）就已算出——当规划模型本轮返回 `clarify`（追问）而非 `plan` 时，产物被算出却无处展示，用户看不到「反推图片提示词」的直接交付物。修正为：产物随 assistant 消息 `payload.imageAnalysis` 透出（**plan/clarify 皆带**），由 `ConversationPanel.vue` 在对话流内直接渲染 `PlanImageAnalysis.vue`（贴近用户提问处，可复制正/负向提示词 + 主色板）；方案卡不再重复渲染该区块（`plan.imageAnalysis` 仍保留以维持 planHash 作废语义）。纯函数契约（normalize/schema/hash）不变，probe-m58 images 节继续覆盖。

以下原设计正文保留供对照。

## 一、背景与目标

现状（已核实）：轻松创作**能消费**视频参考——`video_analyze`（M25）产出 `{duration, scenes, transcript}` 摘要喂进 LLM 规划上下文（`planning.ts`）。但：
1. 这份反推依据**只进上下文、用户看不见**——无法检视"系统到底从我的参考视频读到了什么"；
2. 摘要**不作为可编辑的分镜初稿**——"参考视频 → 类似风格成片"这条最自然的诉求只能靠 LLM 黑箱转化，不可控。

完整反推在专业端 `video-reverse.yaml`（analyze → storyboard-json → 文案，带审阅闸）已有，但轻松创作没用起来。M58 把它**分两档**接进来。

## 二、方案决策（自行拍板，两档都做，2b 先行）

| 档 | 交付 | 成本 | 说明 |
|---|---|---|---|
| **2b 反推透出**（先做，近乎零逻辑） | 把已有 `video_analyze` 时间轴摘要在方案卡显式渲染为一份「参考解析」产物（scenes/transcript/时长/节奏） | 极小，纯 UI 透出 | 立刻解决"看不见反推依据"，零风险 |
| **2a 反推成分镜初稿** | 上传视频参考 + 意图"按此视频反推/类似风格" → 复用 `video-storyboard.md` 提示词 + `storyboard-json` 产出 shots，作为方案 `shots` **初稿**（可检视、可改） | 中，复用现成件 | 实现真正"参考视频→类似成片"，带轻审阅 |

## 三、服务端设计

### 3.1 2b 透出（持久化反推摘要）
- `video_analyze` 摘要现仅注入上下文；M58 将其**编进 `plan.refsAnalysis`**（可选字段，随 plan JSON 持久化并进 planHash——解析产物变了方案就该重确认，符合 M31"参考变化→冲突"）。
- 结构：`refsAnalysis?: { sourceAssetId, duration, scenes:[{t,desc}], transcript? }`，宽松收下、bounded（scenes≤24、transcript≤2000 字，超限截断可见标记）。
- 失败/无实例：沿用 blocker，不产空壳伪装已解析。

### 3.2 2a 反推成分镜初稿
- 规划阶段命中"反推意图 + 有视频参考"时，走 `ai_text`（`prompt_tpl=video-storyboard.md`, `output_format=storyboard-json`）把 `refsAnalysis` 转 shots 初稿，回填进 `plan.shots`（仍是轻松创作契约内 shots，受 M59 上限约束，超出则截断并提示"完整分镜请走专业端/M56"）。
- **不新建反推子流程**：轻松创作内只产"初稿 + 可改"，深度逐镜审阅仍归专业 `video-reverse`/镜头工作台。
- shots 初稿来源标 `source:'reverse'`，供前端区分展示与二次编辑提示。

## 四、契约与计费

- `contract.ts`：`planSchema` 加可选 `refsAnalysis` + shot 加可选 `source` 标记；均**加法兼容**，老 plan（无这些字段）校验照常通过。
- 费用：`video_analyze` 规划期执行已计费（M31 `analysisCost`）；`ai_text` 反推分镜复用现成多模态/token 计价，进 `estimate`，不新增付费面。
- planHash：`refsAnalysis`/`shots.source` 进 plan → 进 planHash；编辑参考或改反推 → 旧确认冲突（正确）。

## 五、前端

- `CreationPlanCard.vue`：新增「参考解析」折叠区（2b，列出 scenes/transcript/时长 + 来源视频缩略）；反推初稿 shots 带"来自参考视频·可编辑"徽标（2a）。
- 无视频参考 / 无解析实例：相关区块完全不渲染（不打扰、不假称）。
- 长文本折叠 + 复制；沿用紫靛 token、原生 CSS、a11y。

## 六、探针（`scripts/probe-m58.ts`，零网络零计费，隔离库 + stubFetch + 本地素材）

- 2b：`video_analyze` 摘要编进 `refsAnalysis` 并持久化、进 planHash；改/删参考 → planHash 变 → 旧确认冲突；无实例不产空壳（blocker）。
- 2a：反推意图 + 视频参考 → shots 初稿回填、`source:'reverse'`；超上限截断且可见标记；非反推意图不触发（零漂移）。
- 回归：M31 旧路径（仅上下文注入、无 refsAnalysis）校验/执行零回归；老 plan（无新字段）向后兼容。
- 不臆造：stub 断言 transcript/scenes 仅取解析实际内容，缺失字段留空不编。

## 七、边界与遗留

- 不做逐镜反推大编辑器（归专业镜头工作台）；不做音频克隆（延续 clone 拒绝）。
- 图片参考的风格反推：**已补口实施（见 §零.5–零.6）**——对话内多模态反推产可投产 image_prompt，随消息 payload 在对话流直接渲染可检视（plan/clarify 皆可见）；逐图完整文案包（发布文案/系列策划）仍归专业端 `image-reverse` 模板（route-hint 3b 信号给路线建议）。
