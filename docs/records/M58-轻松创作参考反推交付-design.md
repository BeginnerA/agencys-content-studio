# M58 L1 Spec — 轻松创作「参考反推可检视交付」

> **状态：待用户评审批准；未获批不改业务代码。** 构建在 M31/M25 之上，不推翻其契约。
> 前置复核：编号以最新 roadmap 为准（取 M58）。
> 纪律：**0 新表 0 新列 / 0 新增 action**（复用 `video_analyze` + `ai_text` + `storyboard-json` 既有件）；不静默降级、参考里没有的信息不得臆造（延续 M31）；解析费用已计入口径不变。

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
- 图片参考的风格反推（需视觉 LLM 提风格词）留 backlog（M8 已排除项，需 vision 面）。
