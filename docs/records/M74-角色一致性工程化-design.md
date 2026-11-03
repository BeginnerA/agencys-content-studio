# M74 设计：角色一致性工程化（R04）

日期：2026-11-03
状态：待用户确认
需求卡：备选清单 R04「视觉一致性从'能传参考图'提升为'可控参考策略'」

## 1. 背景与现状

摸底结论（文件:行号以当前代码为准）：

| 现状 | 位置 | 缺口 |
|---|---|---|
| 实体参考图是扁平数组 `characters.refAssetIds`（JSON number[]），无分层 | schema.ts:222-242 | 无「基准 vs 状态变体 vs 多视角」维度，无法分层选择 |
| states 机制只注入 prompt 文本锚定 | ai-image.ts:508-599（parseStateEntry/matchStateEntry/injectStateAnchors） | 状态不挂参考图：镜头命中「第3场：受伤」却仍用基准定妆照 |
| 参考收集按固定顺序：画布直通→角色≤4→场景1→道具1，总量≤6 | ai-image.ts:43-60, 656-695（collectRefAssetIds） | 角色段只按 refAssetIds 数组序取，无状态优先、无回退记录 |
| 模型能力只有 `'none'|'base64'` 两态 | kit core/types.ts:47（外部 git 依赖，不可改）；ai-image.ts:444 imageRefCapability | 无「支持参考图数量」声明；6 张上限是宿主硬编码；不支持时仅 run log 一行，UI 不提示 |
| 每镜实际参考有冻结记录 | exec_inputs（used/skipReason，ai-image.ts:338-424） | 已够用，缺「该参考是哪一层（base/state/view）」语义 |
| 负向约束三处零散 | 实体级 characters.negative（prompt 锚点）；kit extra.negative_prompt 仅 ComfyUI/Kling 透传 | 风格预设无 negative 字段，无统一负向通道记录 |
| 一致性评价 | M24 scoreConsistencyEval（eval-service.ts:89-173，0–10 分，多模态 LLM，按组评） | 结果只落 markdown 报告资产，不入库、无逐角色问题记录、不接门禁 |
| M71 consistencyScore | eval-quality.ts:197-240 | 是版本稳定度代理，非视觉一致性 |

kit 是外部 git 依赖（node_modules/.pnpm/@agencys+ai-provider-kit@gi_*），不可修改——模型能力表必须做在宿主侧。

## 2. 目标（对齐 R04 提升点）

1. **分层选择**：角色基准参考与状态变体分层登记；镜头命中状态 → 优先用该状态参考，无则显式回退基准（记录回退原因）；多视角参考作为基准补充。
2. **成组复用**：风格预设带负向约束，与风格片段一体复用；实体负向约束维持现有锚点通道。
3. **可追踪**：每镜记录实际使用的参考（含分层角色与选择原因）与模型能力快照。
4. **兼容语义**：模型不支持参考图 / 超出数量上限时，UI 与任务记录明确提示与跳过原因，不静默降级。
5. **质量反馈**：逐角色一致性评价复用 M24 评分 + M73 问题/门禁存储，跨镜差异落库可定位；未运行评价不当作通过。

## 3. 核心设计

### 3.1 entity_references 表（分层参考登记）

```sql
CREATE TABLE entity_references (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id INTEGER NOT NULL REFERENCES characters(id),
  asset_id  INTEGER NOT NULL REFERENCES assets(id),
  role      TEXT NOT NULL,            -- 'base' | 'state' | 'view'
  state_key TEXT,                     -- role='state' 时必填：characters.states 中某条目的原文
  view_key  TEXT,                     -- role='view' 时的视角说明（自由文本，如「正面全身」）
  enabled   INTEGER NOT NULL DEFAULT 1,
  note      TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_entity_refs_pair ON entity_references(entity_id, asset_id);
CREATE INDEX idx_entity_refs_entity ON entity_references(entity_id);
```

- 一个资产在一个实体下只有一行（唯一约束）；同一资产可作为不同实体的参考（各一行）。
- `characters.refAssetIds` 保留为**派生列表**：entity_references 写路径（增/删/改 enabled）后重算 = 全部 enabled 参考按 base→state→view 分层排序的 assetId 列表。下游（entity-refgen、provenance/M29 溯源、旧读路径）零改动。
- **隐式基准兼容**：实体从未登记过 entity_references 行时，选择策略把 refAssetIds 视作隐式 base（纯函数层判定，无隐式写库）；回填端点把其显式化。
- style_presets 加 `negative TEXT`（nullable）：风格预设负向约束，与 snippet 一体复用。

### 3.2 参考选择策略 services/ref-selection.ts（纯函数）

```
selectEntityRefs(row, refRows, ctx: { scene?, episode?, text? }, limit)
  → { selected: { assetId, role, reason }[], fallbacks: string[], dropped: string[] }
```

- 状态命中复用 matchStateEntry 同款语义（多条命中取数组最后一条——数组序即时间序）。
- 优先级：`state`（state_key = 命中条目）→ `base` → `view`；逐级填充至 limit。
- 无状态命中、或命中状态无 enabled 参考 → 回退 base，fallbacks 记「状态「第3场：受伤」无参考图，回退基准参考」。
- refRows 为空 → 隐式基准模式：refAssetIds 全部按 base 计（reason: legacy-base）。
- 超限裁剪进 dropped（带原因）。
- `collectRefAssetIds` 从 ai-image.ts **迁入本文件**并改造：角色段消费 selectEntityRefs（其余段与签名不变）；ai-image.ts 改 import（776 行 → 迁出后约 740 行，给能力集成留空间）；probe-m8 / probe-m22 的 import 路径同步更新（断言体不变）。

### 3.3 图像能力表 services/image-caps.ts（宿主侧）

```
resolveImageCaps(providerKey: string, model?: string)
  → { supportsRefs: boolean, maxRefs: number, supportsNegativePrompt: boolean, notes: string[] }
```

- supportsRefs 基础值来自 kit `adapter.referenceImages`（'none' → false）。
- maxRefs：宿主登记表按 provider/model 登记；**未登记模型缺省 4 并注明保守缺省**。首版登记表只登记现有 adapter 清单的保守值，探针断言缺省行为，不锁死具体供应商数值（真实值随供应商文档另行校准）。
- supportsNegativePrompt：kit extra 透传仅 ComfyUI/Kling（catalog/extra-params.ts:399）；不支持的通道走 prompt 内「必须剔除：」锚点（现有模式），caps.notes 标注生效通道——**记录而非静默**。
- ai-image 集成：入队前 resolve 一次（同 imageRefCapability 模式）；能力快照写入 `gen_tasks.params.caps`；不支持 → 全部 skipped（已有语义）+ 日志；超 maxRefs → selectEntityRefs 以 maxRefs 为 limit 裁剪 + skipped「超出模型参考图上限(N)」。
- `gen_tasks.params.refSelection` 新增：本次逐参考的 { assetId, role, reason } 快照——每镜参考分层语义可追溯。
- 风格预设 negative 注入：injectStyleAnchor 追加「必须剔除：{negative}」（与实体锚点同格式）。

### 3.4 参考管理端点（routes/entity-references.ts）

| 端点 | 语义 |
|---|---|
| GET /entities/:id/references | 列表（联 assets 返回文件/缩略信息） |
| POST /entities/:id/references | { assetId, role, stateKey?, viewKey?, note? }；校验：实体存在、资产存在且属于同项目或全局、role 合法、role='state' 时 stateKey 必须精确等于 characters.states 某条目、唯一约束冲突 409 |
| PATCH /entity-references/:id | { enabled?, role?, stateKey?, viewKey?, note? }（同校验） |
| DELETE /entity-references/:id | 删除 + 派生重算 |
| POST /entities/:id/references/backfill | refAssetIds 中未登记资产 → role='base'（幂等） |
| GET /entities/:id/selection-preview?scene=&episode=&text= | 选择策略预览（返回 selected/fallbacks/dropped，UI 调试用，无副作用） |

### 3.5 逐角色一致性评价 services/consistency-eval.ts

> 计划期修正：初稿设想评价直接写 quality_issues——但 M73 的 runStage 每次重跑会清空并重建该阶段全部问题（stage-check.ts:464-472），评价写入会被门禁重跑吞掉。改为**结果表与问题分离**：评价落专用结果表（幂等可覆盖），final 阶段 checker 消费结果表重建问题。

```
新表 character_consistency_results（run×entity 一行，重评覆盖）：
  id, run_id→pipeline_runs, entity_id→characters, episode_idx(默认0),
  score REAL NULL（0–10 一致性均分；NULL=无法评价）,
  asset_total, asset_sampled（≤24 抽样）, ref_count, model, provider, note, evaluated_at
  UNIQUE(run_id, entity_id)

POST /runs/:id/consistency-eval
  1. exec_inputs（srcKind='entity'）汇总本 run 出镜实体集合
  2. 每实体：出图资产 = gen_tasks.resultAssetId（params.entityIds 含该实体且 succeeded），
     超 24 张取最新 24 张（evidence 记录总数/取样数）
  3. 参考图 = 该实体 enabled base 参考（未登记分层 → 隐式 refAssetIds；仍为空 → score=null、note 记原因）
  4. 逐实体调 scoreConsistencyEval（label=角色名，复用 M24 契约与提示词）；
     LLM/参数异常 → 该实体 score=null、note=错误摘要（评价失败不产假分）
  5. 结果 upsert character_consistency_results
  6. 报告资产照旧落 eval_report（scoreConsistencyEval 内部行为，params 含组名与模型）

GET /runs/:id/character-consistency（只读汇总，无 LLM）
  → 每实体 { entityId, name, score, assetTotal, assetSampled, refCount, note,
             issueCount, issueSeverities }（结果表 join characters + quality_issues 聚合）
```

**M73 门禁集成**：stage-check.ts 注册 checker `character.consistency`（final 阶段，纯 DB 读，无 LLM）：
- 结果表无该 run 行 → info issue「角色一致性评价未运行，结果待人工确认」（对齐 R05「未知状态不当通过」语义）。
- score=NULL → info issue（targetType='entity'，note 进 evidence，建议补参考后重评）。
- score/10 < 0.5 → blocking issue；< 0.7 → warning issue；≥ 0.7 → 不落问题。
- 问题统一 checker='character.consistency'、dimension='consistency'、checkType='subjective'、targetId=String(entityId)，中文建议语；豁免/门禁数学复用既有 reevaluateGate。

**LLM 边界**：真实多模态调用复用 M24 已验收链路（chatCompleteDetailed + eval-consistency 提示词），M74 新增的是分组编排、落库与门禁；探针用既有 stub 模式（本地 stub 端点返回契约 JSON，探针不联网），与 m13/m40 同款。

### 3.6 UI

1. **参考分层管理**（AssetsPanel 实体编辑弹层扩展）：现有参考挂接区升级为分组列表（基准/状态变体/多视角），支持设层、绑定状态（下拉 = characters.states 条目）、启停、备注；面板打开时自动调 backfill（幂等）；选择预览按钮调 selection-preview 显示命中/回退/裁剪。
2. **角色一致性卡片**（run-detail，QualityGatePanel 之后）：每角色分数、问题列表（复用 M73 issue 卡样式）、参考使用统计（出镜数/回退次数/跳过计数）；「运行评价」按钮调 POST consistency-eval。
3. **能力警示**：RunFormModal 选择图像模型时，若 caps.supportsRefs=false 且模板含参考注入 → 显式提示条「当前模型不支持参考图，角色锚定仅靠文本」；查询 GET /image-caps。
4. 风格预设编辑处加 negative 输入。

## 4. 端点汇总

新增 9 个：references CRUD 4 + backfill + selection-preview + GET /image-caps + POST /runs/:id/consistency-eval + GET /runs/:id/character-consistency。

## 5. 任务拆分（8 任务，SDD 执行）

| # | 任务 | 交付 |
|---|---|---|
| T1 | 表与迁移 | entity_references + character_consistency_results 表、style_presets.negative 列、drizzle 0007 迁移、db/index.ts fallbacks |
| T2 | 选择策略 | services/state-match.ts（state 匹配从 ai-image 抽出共享）+ services/ref-selection.ts（selectEntityRefs / collectRefSelection / collectRefAssetIds 迁入）+ probe-m8/m19/m22 import 更新 |
| T3 | 服务与集成 | services/entity-references.ts（分层登记 CRUD/派生同步/loadRefIndex）+ services/image-caps.ts + ai-image 集成（refIndex/caps 快照/refSelection 快照/裁剪/style negative 注入） |
| T4 | 参考端点 | routes/entity-references.ts（CRUD4 + backfill + selection-preview + GET /image-caps）+ app.ts 注册 |
| T5 | 一致性评价 | services/consistency-eval.ts + 2 端点（挂 quality-gates 路由）+ stage-check checker 注册 |
| T6 | 前端 | 参考分层管理 + 一致性卡片 + 能力提示 + style negative 编辑 + api client |
| T7 | 探针 | probe-m74（storage/selection/caps/service/consistency/endpoints 六节，m73 目录模式，LLM 走 stub fetch） |
| T8 | 联调与文档 | roadmap/backlog 回写 + 全量回归 + safe-run.mjs |

依赖：T2←T1；T3←T1,T2；T4←T3；T5←T1,T3；T6←T4,T5；T7←全部；顺序执行 T1→T8。

## 6. 边界与风险

1. FaceID/IP-Adapter/LoRA 不做；文本向量库不称人脸身份库；不承诺不变脸。
2. 一致性评分为 LLM 主观评价（checkType='subjective'），不是视觉真值；门禁语义是「有记录、可豁免、可定位」，不是自动否决。
3. 不改 kit 包；能力表在宿主侧，未登记模型保守缺省。
4. refAssetIds 双写保留，M29 溯源链与 exec_inputs 结构不动（M74 只加 params 快照字段）。
5. quality_issues.targetType='entity' 为本里程碑引入的新消费面，targetId 统一字符串数字。
6. ai-image.ts 已 776 行：collectRefAssetIds/mergeRefIds 迁出后净减，控制在 800 行内。
7. schema.ts 843 行（超 800）：延续 M73 裁决——单表登记文件不拆分。
8. 探针不联网：一致性评价走 stub 端点；真实供应商数值不在探针锁死。
