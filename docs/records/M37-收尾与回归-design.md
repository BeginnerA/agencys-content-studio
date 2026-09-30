# M37 L1 Spec — 收尾与回归：自动值来源统一可追溯（G13）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-20 ｜ 里程碑：M37（charter G13，路线图收尾项）｜ 前置：M32–M36 全部已交付
- 纪律：**纯前端加法 + 新探针，0 服务端代码 / 0 新端点 / 0 新表 0 新列 / 0 LLM 计费 / 0 网络**

## 一、背景与目标

路线图（M32–M36）在 6 处落地了「自动值」（Tier A 预填 / 背书 / 兜底）与 3 处「智能建议」（Tier B）。
G13 痛点：用户在 UI 上**看不到「为何是这个值」**——各触点各自造标注（chip 文案 / 长句 note / 徽标 / 无标注），
视觉与措辞不统一，且存在一处实质缺口：M34 `caps_suggest`（覆盖项合法域来自能力表收窄）前端未统一标注来源。

M37 = 统一「来源可追溯」表达：一个通用徽标组件 + 全触点接线 + 探针断言各自动化契约的 source 字段一致性。

## 二、设计原则与不做清单

- **用户语言映射（拍板②）**：徽标文案不出现内部术语 "Tier A/B"，用「自动 / 背书 / 建议 / 内置」四类中文语义。
- **只标注不改行为**：所有触点的取值逻辑、提交逻辑、去噪策略（如 `template_default` 不加 chip，沿用 M34 决策）逐字不变。
- **建议与自动严格区分**：「建议」类徽标必须传达"仅提示、未执行"（next-steps / 合规建议 / 节奏批量建前的预览语义）。
- 不做：服务端 next-steps 不加 tier/source 字段（拍板①，纯前端方案——规则引擎是唯一来源，前端静态标注即为事实）；
  不做来源聚合端点；不改任何既有响应契约；不拆既有 >800 行历史大文件（m26 既有债，超出范畴）。

## 三、G13.1 统一组件 `ProvenanceBadge.vue`

新增 `apps/web/src/components/common/ProvenanceBadge.vue`（预计 ≤120 行）：

```ts
props: {
  kind: 'auto' | 'endorse' | 'suggest' | 'builtin'  // 必填
  text: string        // 来源短语，如 '沿用上次运行'（渲染为「自动 · 沿用上次运行」）
  title?: string      // hover 详情（如定价核实锚点、caps 供应商/模型名）
}
```

四类语义与色板（CSS 变量走全局 token，对齐既有 `.chip` 视觉语言，不自造配色体系）：

| kind | 前缀词 | 语义 | 色 |
|---|---|---|---|
| auto | 自动 | 系统直接填入的值（可改） | 蓝 |
| endorse | 背书 | 平台真源表担保、免手填核实 | 绿 |
| suggest | 建议 | 仅提示未执行，需人工采纳 | 琥珀 |
| builtin | 内置 | 代码级兜底（文件缺失时） | 灰 |

`aria-label` 全文 = 「{前缀} · {text}」，title 挂 `:title`。组件纯展示、无状态、无 emit。

## 四、G13.2 触点改造矩阵（9 处）

| # | 文件 | 现状 | 改后（徽标 kind · text） | 行为变更 |
|---|---|---|---|---|
| 1 | `components/common/ProvenanceBadge.vue` | 新建 | — | — |
| 2 | `components/template/TemplateInputFields.vue` | `srcChip()` 自造 `<em class="src-chip">` | last_run→`auto · 沿用上次运行`；brief→`auto · 来自项目简介`；template_default 维持不加噪 | 仅替换渲染节点，`sources` prop 契约不变 |
| 3 | `components/run/RunFormModal.vue` | 覆盖区有 `.cap-hint` 零散文案，**无统一来源标注（G13 缺口）** | `videoOverride` 非空 → 覆盖区 summary 挂 `auto · 能力表合法域`，title=`本模型 {model} 的时长/分辨率域由平台能力真源表收窄` | cap-hint 保留（信息互补），徽标只加一处 |
| 4 | `components/config/PricingSuggest.vue` | 「✓ 已按…参考定价预填：{锚点}」长句 | 命中行前置 `auto · 在线目录定价` / `auto · 平台核实表定价`，锚点入 title；原句精简 | 取值/emit 不变 |
| 5 | `components/config/VideoCapsEditor.vue` | 纯文本 note「系统已按…能力表自动背书」 | note 前置 `endorse · 平台能力表`，原句保留 | 无 |
| 6 | `views/stats/CompliancePanel.vue` | 自造 source 徽标（file/builtin） | builtin→`builtin · 基准词库兜底`；file→`自动 · 用户词库` 改为不挂徽标（用户自有文件非"自动值"，仅在兜底时提示）| loadView 不变 |
| 7 | `views/stats/PlatformPresets.vue` | seedMsg 纯文本 | seedMsg 行挂 `auto · 平台目录` + 原文案 | 无 |
| 8 | `views/stats/ScheduleCadence.vue` | msg 纯文本（批量建结果） | 结果行挂 `auto · 节奏模板展开` + 原文案 | 无 |
| 9 | `components/project/NextStepsBar.vue` | 无来源标注 | 头部挂 `suggest · 规则引擎（仅建议，不自动执行）`（静态，规则引擎为唯一来源） | 无 |
| 10 | `views/stats/CompliancePanel.vue` 建议区 | 建议项仅 level 徽标 | 建议区标题挂 `suggest · 复审结论聚合`（表意零新计费：来自已付费产物） | 采纳/去重逻辑不变 |

> #6/#10 同文件两处，合并为一次改动。实际改 8 个既有文件 + 1 新建。

## 五、G13.3（并入探针）自动化契约来源字段清单 = probe-m37 断言对象

服务端**已有** source 契约（本次不新增字段），探针逐端点断言其存在与枚举一致，锁定「前端统一标注」的真源不漂移：

| 端点 / 服务 | 断言 |
|---|---|
| `GET /templates/:key/prefill` | 每 `inputs[k].source ∈ {template_default,last_run,brief}`；`overrides.video` 非空时 `.source === 'caps_suggest'` 且 `defaultResolution ∈ selectableResolutions` |
| `GET /api-configs/model-suggest` | 命中定价时 `pricing.source` 非空字符串（核实锚点）；`supported:false` 时无 pricing/caps 键 |
| `GET /api-configs/video-caps` | supported 时 `caps` 非空；未登记 → `{supported:false}`（背书标注的唯一依据） |
| `GET /compliance/rules` | `source ∈ {file,builtin}`；缺失→builtin 且 total=BASE_RULES.length（M36 已测，此处只锁枚举） |
| `POST /exports/presets/seed` | `added` 为数字且 = 新增条目数（幂等重放 added=0） |
| `GET /compliance/suggest` | 每条 `level === 'warn'`（建议起步不越权）且 `evidence` 非空 |
| `GET /projects/:id/next-steps` | `items[].kind ∈ 枚举`、≤3 条（前端「建议」徽标的静态语义背书） |
| `POST /schedules/cadence-preview` | errors 非空 ⇔ timestamps 空（不静默产出）|

## 六、实施顺序（门禁：每步 typecheck；探针全绿再进前端门禁）

- T1 `ProvenanceBadge.vue` 新建 + `api.ts` 无改动（复用既有 `PrefillSource`/`VideoOverride` 类型）
- T2 触点 #2–#5（template/run/config 域 4 文件）
- T3 触点 #6–#10（stats/project 域 4 文件）
- T4 `probe-m37.ts` 五节（prefill / model-suggest / rules+catalog / suggest+next-steps / cadence），复用 probe-lib `isolatedEnv + makeChecker + runSections`，`bridge:['templates','prompts']`
- T5 门禁：`probe:ci` 差量比对（仅 m26 split-audit 既有债允许红）+ 服务端 `tsc`（应为零 diff）+ `vue-tsc --noEmit` + `vite build` + 改动文件行数 ≤800
- T6 文档：milestones.md 加「M37 能力速览」+ 路线图节改为「M32–M37 全部交付，路线图收官」

## 七、验证与回滚

- 徽标为纯展示组件：任一跳触点渲染异常可单点回退（还原该文件即恢复原标注），互不牵连。
- probe-m37 只读断言既有契约，若未来某里程碑改 source 枚举，探针先红、前端标注随后适配——即「全覆盖回归」锁。
- 无 DB / 无文件写（探针内 per-section 临时 workspace 自带清理）。

## 八、边界回顾（charter Never 清单）

付费执行、密钥录入、合规放行、跨项目引用——本里程碑不触碰任何一条；「建议」徽标反而**强化**了"仅建议不执行"的可见性。
