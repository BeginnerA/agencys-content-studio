# agencys-content-studio ROADMAP（L0 北极星）

> **归档戳（2026-09-30）**：L0 战略活文档——产品北极星路线图，规划口径仍以本文为准；逐期执行情况以 docs/milestones.md 为准。

> 本文档是唯一**常青方向文档**。每里程碑结束必须校准一次；与任一里程碑详细 spec（L1）冲突时，以本文红线为准并回写修正。详细设计见：`2026-09-09-agencys-content-studio-m1-design.md`（M1）、`2026-09-09-agencys-content-studio-m2-design.md`（M2）、`2026-09-10-agencys-content-studio-m3-design.md`（M3）、`2026-09-10-agencys-content-studio-m4-design.md`（M4）、`2026-09-11-agencys-content-studio-m5-design.md`（M5）、`2026-09-12-agencys-content-studio-m6-design.md`（M6）、`2026-09-12-agencys-content-studio-m7-design.md`（M7）、`2026-09-12-agencys-content-studio-m8-design.md`（M8）、`2026-09-12-agencys-content-studio-m9-design.md`（M9）、`2026-09-12-agencys-content-studio-m10-design.md`（M10）、`2026-09-12-agencys-content-studio-m11-design.md`（M11）、`2026-09-12-agencys-content-studio-m12-design.md`（M12）、`2026-09-12-agencys-content-studio-m13-design.md`（M13）、`2026-09-12-agencys-content-studio-m14-design.md`（M14）、`2026-09-13-agencys-content-studio-m15-design.md`（M15）、`2026-09-13-agencys-content-studio-m16-design.md`（M16）、`2026-09-13-agencys-content-studio-m17-design.md`（M17）、`2026-09-14-agencys-content-studio-m18-design.md`（M18）、`2026-09-14-agencys-content-studio-m19-design.md`（M19）；M19+ 全量立项纲领见 `2026-09-14-agencys-content-studio-m19-m27-charter.md`。

---

## 北极星

> 让"任意内容创作方法论"都能以 **模板 + 行动** 的形式在本地 Web 平台里跑成自动化流水线：资产统一沉淀、过程可追溯、断点可恢复。

**判定标准（长期）**：新增一种内容体裁 = 新增一份 YAML 模板 + 复用既有 action，不改代码；任何一次生成结果都能回溯到 {项目 → 流水线 → 步骤 → 任务 → 提示词/参数快照}。

## 架构总纲（变更必须登记于此）

```
Web 工作台 → REST + Socket.IO → API(Hono)
  → Pipeline 引擎（YAML 模板驱动状态机：gate/重试/恢复）
  → Action Registry（10 类：manual_ingest / ai_text / ai_image / ai_video / tts / subtitle / ffmpeg_merge / memory_recall / memory_write / character_sync）
  → 供应商适配层（api_providers 目录 + api_configs 实例）
  → 本地记忆与角色（ONNX embedding bge-small-zh-v1.5·512 维，离线；memories/characters 通用表）
存储：SQLite(projects/assets/runs/steps/tasks/memories/characters) + 本地文件(workspace/) + 模型文件(data/models/) + 外置模板与提示词
```

**不变式**：
1. 业务流程外置为 YAML/提示词文件，代码不写死业务步骤
2. 领域模型只含通用表（project/asset/run/step/task/config），不含体裁专属表
3. 本地单机形态与 SQLite 零运维不回退（Docker 仅备选）

## 红线（明确不做）

| 红线 | 说明 |
|---|---|
| 不做多用户/登录/权限 | 单机工具，永久排除 |
| 不做体裁专属表与写死页面 | dramas/episodes/… 永不复辟（huobao 教训） |
| 不引重型编排/任务引擎 | 自研状态机，直到 M4 review 证明不够用 |
| 不在 M1–M2 引入 Electron/画布/记忆 | 按路线图到点再评估；记忆已于 M3 按计划引入（本地离线，见架构总纲）；画布已于 M15 引入（流水线画布工作台，见 M15 注记）；创作画布已于 M16 引入（画布文档写模型，**首次引入新表**〔canvases / canvas_nodes / canvas_edges〕，见 M16 注记）；Electron 永久不做（M14 决策：本地单机 Web 定位） |
| 不因开源代码"顺手"而搬入其专属逻辑 | 搬运必须走 M1 spec §7 清单 |

## 四阶段路线（一句话目标）

| 阶段 | 目标 | 依赖 | 出口校准问题（做完 review 必答） |
|---|---|---|---|
| **M1 骨架闭环** | 萌宝单集死模板跑通 导入→剧本→分镜→出图→成片，8 条验收全绿 | 无 | 自己在 Web 里走完一条流程顺不顺手？模板 gate 语义够不够？ |
| **M2 流程引擎化** | 任意新流程 = 写模板即可；ai_video/配音/字幕 action 启用；模板在线管理 | M1 实测 | 用户 Skills 方法论能否整体平移到模板+提示词外置？恢复/重试在多任务场景是否可靠？ |
| **M3 多类型与记忆** | 图文/口播模板各一条跑通；本地向量记忆（Toonflow 参考）；角色一致性库 | M2 | 跨体裁 action 复用率多少？记忆是否真实提升一致性产出？ |
| **M4 打磨分发** | 批量生成、成本控制、导出分发、复盘数据 | M3 | 是否达到个人主力工具标准（打开频率/单项目完成率）？ |

## M1 完成注记（2026-09-09 review）

- 8 条验收通过（对照 `2026-09-09-agencys-content-studio-m1-review.md`）；验收 #5 字幕判据落点经 spec 修订注收敛（M2 配音字幕 action 启用后回补复验）
- 出口校准应答（初）：模板 gate 语义 M1 够用；多 gate/条件/并行需求 → M2 spec 范围；Web 全链路顺滑度待用户 Run 10 实弹后补答
- 规则 3 解除：M1 review 已落盘，M2 spec 允许开工撰写
- 北极星校验：M1 新增体裁仍=新增 YAML+复用 action（未验证模板面可扩展性，列为 M2 首要验证目标）

## M2 完成注记（2026-09-10 review）

- 10 条验收通过（对照 `2026-09-09-agencys-content-studio-m2-review.md`）；M1 review 偏差 #1（字幕判据）由 T2 实际烧录关闭
- 出口校准应答：① 用户 Skills 方法论整体平移**成立**（T1 v2 / T2 全链路由 YAML + prompts 驱动，业务步骤零代码）② 恢复/重试多任务**可靠**（强杀恢复 / 失败续跑 / M1 存量三组实测）
- 北极星校验：新增体裁 = 新 YAML + prompts（模板面可扩展性验证通过）；期间修复 2 类引擎通用缺陷（loader batch 归一化、未成功任务参数同步），均非体裁定制
- 规则 3 滚动：M2 review 已落盘，M3 spec 允许开工撰写
- M3 spec 输入见 review 沉淀（图文/口播完整模板、本地记忆与角色一致性、音频情绪 + 音画精确对齐）

## M3 完成注记（2026-09-10 review）

- 10 条验收通过（对照 `2026-09-10-agencys-content-studio-m3-review.md`）；M2 review 沉淀的 M3 输入全部落地（图文/口播完整模板、本地向量记忆 + 角色一致性库、音频情绪 + 音画精确对齐）
- 出口校准应答：① 跨体裁 action 复用率**三模板均 100%**（T1 note-clip 零新 action；M3 新增 3 类 action 均为跨体裁平台能力）② 记忆提升一致性**机制层成立**（prompt 快照注入链硬证据），产出层为方向性证据（单机小样本无统计显著性，A/B 评测入 backlog）
- 北极星校验：**新增体裁 = 新 YAML + prompts + 零新 action** 首次完整验证（T1 图文 8 步全复用）；memories/characters 为通用表 + 引擎层注入，无体裁专属逻辑；期间修复 1 类引擎通用缺陷（tts 声线链语义短语过滤），非体裁定制
- 规则 3 滚动：M3 review 已落盘，M4 spec 允许开工撰写
- M4 spec 输入见 review 沉淀（音频情绪实例接入、三层记忆/摘要压缩、角色语义检索/参考图 i2i、一致性 A/B 评测；继承：多集批量编排、平台级成本统计）

## M4 完成注记（2026-09-11 review）

- 10/10 验收通过（对照 `2026-09-11-agencys-content-studio-m4-review.md`）；五项主项（批量运行 / 成本与用量 / 导出分发 / 复盘数据 / Web 配套）全部落地
- 出口校准应答：达到「个人主力工具」标准（三维证据：活跃度与完成链路 / 四类用量与导出发布全链实测 / 用户主观愿意日常使用）——**四阶段路线收官**
- 北极星校验：批量/成本/导出/复盘均为平台级通用能力，零体裁逻辑；本轮唯一引擎改动为取消/闸门竞态修复（通用缺陷，非体裁定制）
- 局限转 Backlog：定时调度、导出包平台化定制、CSV 数据分析、三层记忆/摘要压缩等（见 m4-review §局限与 Backlog）

## M5 注记（2026-09-11 立项：方法论内化）

- 性质：四阶段收官后由用户立项的**延续里程碑**——把外部「内容创作者套件」（8 技能）方法论平移为 studio 模板家族；设计见 `2026-09-11-agencys-content-studio-m5-design.md`
- 范围：+7 模板（topic-radar / video-plan / series-setup / platform-adapt / review-restock / quick-video / article-clip）、升 3 模板（mengbao-episode v4 / talking-clip v3 / note-clip v2）、+12 升 10 提示词
- 红线复核：不新增 action / 不改引擎 / 不新增体裁专属表——全部改动限于 workspace/（模板+提示词）与 docs/，是北极星「任意方法论可模板化」的第二次大规模验证（首次为 M2 Skills 平移）
- 明确不映射：内容编排（模板选择+批次+项目页已等价）、aggregate-only/portfolio-restock（项目页+导出覆盖）、reverse 反推（需视觉输入，留 Skills 层）、联网采集/浏览器导出（以素材/数据导入替代）、i2v 首帧接力（待引擎扩展）
- 验收规则：五条（静态 promptsDirty / 实弹真跑 / gate 三态 / 契约校验 / 零代码 git diff）见 spec §5

## M6 注记（2026-09-12 立项：参考图驱动生成）

- 性质：M5 遗留「首帧图法 i2v 全自动链｜生成链维持现状（纯 t2v），待参考图通道扩展后接力」的接力落地；2026-09-12 三项目（huobao / Toonflow）源码级对标结论——「已生成图 → base64 参考图 → 后续生成」为视觉一致性最硬缺口；设计见 `2026-09-12-agencys-content-studio-m6-design.md`
- 范围：①图片侧定妆照参考链（`refAssetIds` → data URI → `referenceImages`；gemini 既有 + volcengine / qwen / wan 图片扩展）②视频侧首帧 i2v（`buildVideoRequest` 首尾帧参数位 + `ai_video` `first_frame` 输入 + `prompt_field` 逗号回退链 + volcengine-video 首帧 role）③新服务 `services/asset-ref.ts`（8MB 守卫 + mime 推断）④模板 `mengbao-episode` v6（`i2v` 开关 + `gen_frames` 步骤）⑤提示词 `storyboard-ep` v5（`motion_prompt` + 三模式说明）⑥探针 `probe-m6.ts` 五 section
- 红线复核：不新增 action（ai_image / ai_video 内扩展）/ 不新增 DB 表列（仅 gen_tasks.params JSON 加键）/ 不改引擎（engine / refs / loader 零变更）/ 不改 Web / 不改 ffmpeg-merge；设计原则 = data URI 内联（本地单机无图床假设）+ 能力声明（`referenceImages` / `firstFrame` 只读属性）+ 宽容降级（绝不因切供应商炸链路）
- 明确排除：镜头级工作台、尾帧接力链、公网图床、图片压缩管线、场景/道具参考图、严格模式（见 spec §1.3）
- 当前状态（2026-09-12）：代码 + 模板/提示词 + 探针全部落地，静态 typecheck / 模板校验 / probe-m6 五 section 全绿；实弹三项（图侧 refUsed / 视频侧首帧目检含 volcengine role 二分 / 全链 i2v 出片）与兼容回归待用户配置供应商后跑

## M7 注记（2026-09-12 立项：镜头级轻工作台 + 选镜拼接）

- 性质：M6 spec §1.3 排除项「镜头级工作台（单镜重生成 / 多版本选片 / 分镜图编辑）｜P1 级缺口，涉及 Web + API 新面，另立里程碑」的接力落地；2026-09-12 三项目源码级对标结论 P1 缺口集群第①+②项（huobao 单集工作台：分镜编辑 / 时长单批编辑 / 失败重试；Toonflow 轨道工作台：多版本选片 / editImage）；设计见 `2026-09-12-agencys-content-studio-m7-design.md`
- 范围：①工作台聚合读（`GET /runs/:id/shot-board` 五合一：镜头 × 任务 × 历史版本 × 当前选中 × 合成新鲜度）②分镜编辑（时长 / 提示词 → 写分镜新版本资产 + 替换产出步骤 `output.asset_ids` 保位）③单镜重生成（task / step / run 重置 + `engine.startRun`，幂等对账只跑目标镜）④多版本选片 / 选镜剔除（改写 `output.asset_ids` 保序；`reset` 恢复全量最新）⑤重新合成（重置 ffmpeg_merge 步骤续跑，手动触发）⑥ffmpeg-merge 改造（`shots` 可选输入 per-shot 时长 / 逐镜 skip+warn 容错 / fit_voice 显式优先 / 产物 `params.inputs` 快照供 stale 检测）⑦模板 mengbao-episode v6 → v7（compose_video 增 `shots` 输入，存量 v6 run 行为等价）⑧Web `ShotBoard.vue` +「重新合成」按钮 + stale 徽标 ⑨探针 `probe-m7.ts` 六节
- 红线复核：不新增 action（新面在 routes / services 层，复用既有 action 与引擎调度）/ 不新增 DB 表列（复用 `pipeline_steps.output` / `assets.task_id` 版本组 / `gen_tasks.params` 快照）/ 不改引擎（engine / refs / loader 零改动，返修走「重置状态 + `engine.startRun`」既有模式）/ 仅 mengbao 模板 version+1；设计原则 = ①状态重置 + startRun 复用 ②产物即选择 ③分镜 JSON 唯一事实源
- 明确排除：镜头拖拽重排、分镜可视化大编辑器（结构性编辑）、上传图片替换分镜、跨步骤资产混选、引擎级单步重跑接口、合成音字镜头级重对齐、BGM / 音效与转场、旧版本清理与收藏（见 spec §1.3）
- 当前状态（2026-09-12）：实施完成（T1–T8）——服务层（`shot-workbench.ts` 6 函数）/ 路由层（`routes/shots.ts` 5 端点）/ ffmpeg-merge 改造（per-shot 时长 / 逐镜容错 / `params.inputs` 快照 / 纯函数 `computeShotSegments`）/ 模板 v7 / Web 工作台（`ShotBoard.vue` + 重新合成 + stale 徽标）/ 探针 `probe-m7.ts` 六节全部落地；静态全绿（双端 typecheck / 模板校验零警告 / probe-m7 全绿 / 回归 probe-m2a 全绿 + probe-m3 templates·contract 全绿，修正 5 项存量基线漂移）；越界核查禁改文件零 diff；实弹目检已通过——Run 40/61 全链（编辑 / 重生成 / 选片 / 剔除 / 逐镜容错 / 重新合成 + 浏览器截图），快照见 README「M7 验收快照」（2026-09-12）

## M8 注记（2026-09-12 立项：场景/道具参考资产库 + 风格预设库）

- 性质：M6 spec §1.3 排除项「场景/道具参考图注入｜本里程碑聚焦角色定妆照（`reference_scene` 目录映射预留）；场景/道具库另立」的接力落地；2026-09-12 三项目源码级对标结论 P1 缺口集群第③+④项（huobao：角色/场景/道具三库 + 各自图像提示词生成；stylePresets CRUD + 剧级绑定 + 生成时注入——Toonflow：素材四类单表 + 项目级 artStyle + getArtPrompt 风格×用途矩阵）；设计见 `2026-09-12-agencys-content-studio-m8-design.md`
- 范围：①实体表泛化（characters + `kind` 列：character|scene|prop，单表多态）②场景/道具档案链（`set-profile.md` / `set-ref-prompts.md` 提示词 + 新 action `entity_sync` + `set-json` 文本契约）③参考图出图（purpose `reference_scene` / `reference_prop` + `output_purpose_by_category`）④ai_image 注入扩展（location/props 命中 → 场景/道具文本锚定 + 参考图 4+1+1 上限）⑤风格预设库（新表 `style_presets` + `/style-presets` CRUD + 项目绑定 settings.style_preset_id）⑥风格运行时注入（`injectStyleAnchor` + `use_style_preset` 开关 + stylePresetId 溯源）⑦storyboard-ep v6（props 字段 + location 库对齐规则）⑧模板 mengbao-episode v8 / series-setup v2（四步链 + `with_set_refs` 开关）⑨Web 素材页三 Tab + 风格页 + 项目视觉风格绑定 ⑩探针 `probe-m8.ts` 六节
- 红线复核：不新增体裁专属表（characters +1 `kind` 列泛化；`style_presets` 为平台级通用表，论证见 spec §3.1）；不改引擎调度（engine / refs 零改动；loader 仅 action 白名单 +1）；不改 ffmpeg-merge / shot-workbench / tts / subtitle / 适配器层；ai_image 扩展为注入链叠加（未启用时行为与 M6 等价）；模板 version+1 向后兼容；设计原则 = ①单表多态（对齐 Toonflow）②快照即硬证据（延续 M3/M6）③运行时注入 + 宽容降级（对齐 huobao 空串兜底）
- 明确排除：从参考图提取风格词（需视觉 LLM，backlog）、风格多预设组合叠加、视频侧场景/道具参考图注入、素材参考图上传通道、素材页批量生成/润色交互、states 变体入库（见 spec §1.3）
- 当前状态（2026-09-12）：实施完成（P1–P9 + V1）——数据层（`schema.ts`：characters 表 + `kind` 列 / `style_presets` 表；`db/index.ts` 兜底迁移对全新库与存量库均幂等）/ 服务层（`character.ts` 泛化 + `style-preset.ts` 新增）/ 路由层（`/entities` + `/style-presets` + `/characters` 兼容）/ 新 action（`entity_sync` + `set-json` 文本契约 + storage purpose 子目录）/ ai_image 注入（`injectSetAnchors` / `collectRefAssetIds`（角色 ≤4 → 场景 ≤1 → 道具 ≤1，总量 ≤6）/ `injectStyleAnchor` + `output_purpose_by_category` 分派）/ 提示词（`set-profile.md` / `set-ref-prompts.md` 新增 + `storyboard-ep` v6）/ 模板（mengbao-episode v8 + series-setup v2，校验通过）/ Web（素材页三 Tab + 风格预设页 + 项目「视觉风格」绑定；vue-tsc + vite build 通过）/ 探针 `probe-m8.ts` 六节全部落地；静态全绿（双端 typecheck / 模板校验 / probe-m8 六节 + 回归 probe-m2a·m3·m6·m7 全绿；同步 2 处存量基线——probe-m3 模板断言升至 v8/21 步、probe-m7 缩略图 `?v=2` 与视频封面契约；探针抓到并修复 `duplicate_name` 判定 bug——drizzle 0.45 将唯一约束错误包装为 DrizzleQueryError，改沿 cause 链检测）；工作副本另含既有「工作台视频版本封面缩略图」升级（`shot-workbench.ts` / `thumb.ts` / `assets.ts` / Web 组件，独立于本里程碑，probe-m7 契约已同步）；实弹目检（spec §5：场景道具链三资产齐 + 分镜 `location` / `props` 锚定与参考图注入日志）待用户 Web 端操作回填

## M9 注记（2026-09-12 立项：小说改编链）

- 性质：P1⑤「小说改编链」的接力落地（缺口表唯一整项未开发项，去向表原文「先决策要不要」；2026-09-12 用户拍板立项）；三项目源码级对标结论小说链缺口（Toonflow：`parseNovel` 本地正则切章 + `getAiRegex` LLM 生成正则 + `cleanNovel` 逐章事件提取 + `o_event`/`o_eventChapter` 跨章聚合 + `scriptAgent` 四子代理）；设计见 `2026-09-12-agencys-content-studio-m9-design.md`
- 范围：①新 action `text_split`（多源合并 + 三级正则链 用户>AI>默认 + 卷识别 + `chapter_range` 过滤 + `min_chapters` 校验 + manifest/章节资产生成）②ai_text batch 扩展（`batch.field` 逐项任务 + item_key 标识 + `name_tpl` 插值 + gen_tasks(kind='text') 幂等/并发/重试/取消）+ `max_input_chars` 头尾采样 ③三新文本契约（event-json / graph-json / plan-json）④五新提示词（split-regex / chapter-events / event-graph / plan-episodes / adapt-script）⑤模板 novel-adapt v1（7 步 + 8 输入 + 三闸门；scene=plan / next=[series-setup]）⑥聚合读 `services/novel-board.ts` + `GET /runs/:id/novel-board` ⑦Web `NovelBoard.vue`（text_split 步骤卡内嵌只读看板四段）⑧探针 `probe-m9.ts` 五节
- 红线复核：**零新表、零新列**（章节/事件/图谱/规划/剧本 = 通用文本资产 + purpose 标签；处理状态复用 gen_tasks 状态机）；引擎零改动（engine / refs 零改动；loader 仅 action 白名单 +1）；不改 shot-workbench / ShotBoard / 适配器层；既有 5 模板与提示词零改动；设计原则 = ①通用资产承载业务（对齐「不做体裁专属表」）②本地优先、AI 兜底（切分默认本地正则链，识别失败才 LLM 生成正则）③快照即硬证据 ④模板线性链路（分集规划内嵌章节事件物料包，逐集剧本直接消费，绕开跨资产动态切片）
- 明确排除：docx/epub 导入、章节内容可视化编辑器、事件图谱力导向图、多部小说同链合并、自动连载/增量导入、小说源抓取、改编一致性回查（剧本 vs 原作审计）、事件级编辑（见 spec §1.3）
- 当前状态（2026-09-12）：实施完成（P1–P9 + V1）——服务端（`text-split.ts` 新 action / ai-text batch 扩展 / 3 契约 / storage purpose 扩展 / `novel-board.ts` 聚合读 / `routes/novel.ts`）/ 提示词 5 新 / 模板 novel-adapt v1 / Web（`NovelBoard.vue` + types/api/format 扩展）/ 探针 `probe-m9.ts` 五节；静态全绿（双端 typecheck / 模板校验零 warning / probe-m9 全绿 / 兼容回归 probe-m2a·m3·m6·m7·m8 全绿）；实弹通过（Run #100：3 章短篇全链——切分闸门 → 逐章事件 3/3 → 图谱 key_events=9 → 规划闸门 → 2 集剧本，断言全 PASS，LLM 7 次 ¥0.15）；实弹暴露并修复一处模板缺陷：`split_chapters` 唯一依赖（前一步骤 `make_split_regex`）条件跳过 → 触发引擎「依赖全 skipped」级联全链跳过；修复 = 显式 `after: [ingest, make_split_regex]` 混合依赖（对齐 mengbao `after: [char_profile, gen_refs]` 惯例），spec §3.6/§3.9 已回写；NovelBoard 四段经无障碍树 + DOM 实测验证（Browser 视图不可见，截图未取）

## M10 注记（2026-09-12 立项：镜头分镜编辑器 + 上传替换）

- 性质：M7 spec §1.3 排除项「镜头拖拽重排、分镜可视化大编辑器（结构性编辑）、上传图片替换分镜」的接力落地（backlog 镜头链扩展候选 + P2 集群对应项；2026-09-12 用户拍板 18 项 backlog 分三组全量启动，本批为组1 前 3 项，M10 先行）；设计见 `2026-09-12-agencys-content-studio-m10-design.md`
- 范围：①镜头重排（`applyStoryboardOps`：分镜 JSON 新版本 + 产出步骤 `output.asset_ids` 按新分镜序重建保位；未生成镜跳过 / 上传资产按映射保留）②大编辑器（新组件 `StoryboardEditor.vue`：全字段编辑 + 增删镜头 + 拖动排序 + JSON parse 校验 + 改动计数吸附保存；保存仅改写分镜与镜头顺序、不触发生成）③上传替换（`importShotAsset` / `uploadAndBindShotAsset` / `bindUploadedShotAsset`：sha256 命中复制行 + purpose 锚定 + 200MB 上限 + 绑定重建 output）④板面扩展（`buildShotBoard`：upload 版本组并入 + `BoardVersion.source` + `BoardShot.raw`）⑤选片放宽（可选中 taskId=null 的本步骤上传资产；跨镜 / 非本步骤仍拒绝）⑥路由 +2 端点（`POST /runs/:id/shots/mutate` / `POST /runs/:id/shots/upload`，均不触发执行）⑦Web（`ShotBoard.vue`：镜号把手拖拽重排 + 插入线提示 + 「编辑分镜」/「上传替换」入口 + 版本组「上传」角标）⑧探针 `probe-m10.ts` 六节（ops / output / upload / board / select / regression）⑨`computeStale` 时间兜底（实弹暴露缺陷的修复，见下）
- 红线复核：**零新表、零新列**（复用资产版本组 + `output.asset_ids` 重建；`schema.ts` 零改动、本轮无迁移）；不改引擎（engine / refs / loader 零改动；返修仍走「重置状态 + startRun」与工作台直写两层既有模式）；不改适配器 / ffmpeg-merge / 模板（compose 的 shots 输入 M7 已备）；设计原则 = ①产物即选择（分镜 JSON 唯一事实源）②重建式（非原位修改，被替换旧资产仍可从版本组找回）③上传走正式资产通道（sha256 去重，复制行语义）
- 明确排除：「从分镜库选图」跨镜引用、分镜节点画布；上传资产的独立版本管理（并入 M12 旧版本清理与收藏）；引擎级单步重跑 / 镜头级音字对齐 / BGM · 音效与转场（M11/M12 批次）；图像检测与组2 / 组3 全部项（留待后续批次；见 spec §1.3）
- 当前状态（2026-09-12）：实施 + 实弹全绿 + 两处缺陷修复——服务层（`shot-workbench.ts`：`applyStoryboardOps` / `importShotAsset` / `uploadAndBindShotAsset` / `bindUploadedShotAsset` + 抽共享 `replaceProducerOutputAsset` / `rebuildShotOutput` + `buildShotBoard` 扩展 + `applyShotSelection` 放宽 + `computeStale` 兜底）/ 路由（`routes/shots.ts` +2 端点）/ Web（`StoryboardEditor.vue` 新组件 + `ShotBoard.vue` 拖拽与上传 + `api.ts` / `types.ts`）/ 探针（`probe-m10.ts` 六节新增 + `probe-m7.ts` 1 处拒绝文案基线适配 + package.json 增 `probe:m10`）；静态全绿（双端 typecheck 0 错 / probe-m10 全绿含 3 条 stale 兜底断言 / 兼容回归 probe-m2a·m3·m6·m7·m8·m9 全绿，probe:m7 四条 stale 断言零回归）；实弹 Run 61 全链（重排首镜移尾 #1127 → 结构性编辑链 add→patch→remove→reorder #1128（s02 记入「M10实弹」）→ 上传替换 #1129（sha256 命中复制行）→ 首次重新合成 #1130/1131 → 大编辑器 UI 保存 #1132 → stale=true 三板「待重新合成」→ 重新合成 #1133/1134 → stale=false 三板「合成已最新」；浏览器 DOM + 服务端双重验证）；实弹暴露并修复两处缺陷：①大编辑器 characters JSON 快照 bug（`normalizeDraft` 对象分支读 clone 旧快照 → 覆盖专用控件新值 → UI 保存静默丢改动；修复 = characters 直取实时值 + `cloneDraft` jsonText 跳过 RESERVED 键）②`computeStale` 判定失效（存量模板快照无 shots 引用 / 续跑链跨 run 资产引用 → shots_source 缺失/断链 → 编辑分镜后 stale 不动；修复 = 「分镜资产晚于成片 → stale=true」时间兜底，不参与 compared 计数、null 语义不变）；越界核查：engine / refs / loader / 适配器 / ffmpeg-merge / 模板 / schema 零 diff

## M11 注记（2026-09-12 立项：合成与声音）

- 性质：M7 spec §1.3 排除项「引擎级单步重跑接口」「镜头级音字重对齐」的接力落地 + P2 小缺口「BGM / 音效、转场特效」对应批次（18 项 backlog 组1 第 4~5、8 项合并为「合成与声音」批，音效 per-shot 明确排除）；2026-09-12 源码对标核实——huobao `ffmpeg-merge.ts` 为纯 concat（无 BGM 混音 / 无转场，`bgm_prompt` / `sound_effect` 仅文本字段）、Toonflow 无代码级转场 / BGM 实现，三能力均为本仓自有增量；设计见 `2026-09-12-agencys-content-studio-m11-design.md`
- 范围：①引擎级单步重跑（`resetStepForRerun` + `POST /runs/:id/steps/:stepKey/rerun`：复用成功子任务（默认零调用）/ 全量归零二模式，活跃 run 拒绝 400，下游不重置）②镜头级音字对齐（分镜 `shots[].lines` 台词归属链 + 合成期静音注入 + SRT 按镜平移；成片与音轨严格等长，`fit_voice` 均分被显式映射替代）③BGM（run 级绑定 / 上传 + `-stream_loop -1` 循环铺满 + 音量 / 淡入出 + amix 混音链）④转场（xfade 链 fade / fadeblack / slideleft / slideright / dissolve + 时长补偿数学保总长不变）⑤`services/compose-config.ts` 新增 + `routes/compose.ts` 5 端点 + `run.input._compose` 白名单覆盖（存量 run 直接可用）⑥模板 `mengbao-episode` v9 + `storyboard-ep` v7（lines 规范）⑦Web（`RerunModal` / `BgmModal` 新组件 + ShotBoard 转场行与台词角标 + StoryboardEditor lines 控件 + RunDetailView 重跑按钮）⑧探针 `probe-m11.ts` 六节（rerun / align / bgm / transition / template / regression）+ 存量探针基线同步（probe-m3 / m8 模板版本断言）
- 红线复核：**零新表、零新列**（BGM 复用 assets 行、`_compose` 复用 run.input 列；`schema.ts` 零改动无迁移）；不改引擎（engine / refs / loader 零改动；重跑走「重置 + startRun」既有模式）；不改 tts / subtitle / ai-text / storage；`ffmpeg-merge` 按设计改造（分支以 plan 开关控制，无特性路径 filter 与 M7 逐字节一致）；设计原则 = ①非破坏重跑（复用模式不动已成功子任务产物）②配置即参数（合成时快照，存量 v8 run 行为零漂移）③宽容降级（对齐四条件失败回退 + 非法值 clamp / warn）
- 明确排除：音效（per-shot，依赖每镜音频资产绑定 / 上传通道）、单句配音重配（tts 无 gen_tasks，重跑即全量）、motion 路径的对齐与转场、时间轴级波形编辑 / 多轨混音台、BGM 变化联动 stale、「重跑此步及全部下游」链式编排（见 spec §1.3）
- 当前状态（2026-09-12）：实施 + 实弹六步全绿 + 两处布局缺陷修复（提交 5a87210，24 文件 2742+ 插入）——服务端（`shot-workbench.ts` +resetStepForRerun +lines 校验 / `compose-config.ts` 新增 / `routes/compose.ts` 新增 / `routes/runs.ts` +rerun / `routes/helpers.ts` +wb / `ffmpeg-merge.ts` 三链 + 四纯函数）/ 模板 v9 + 提示词 v7 / Web（RerunModal、BgmModal、ShotBoard、StoryboardEditor、RunDetailView、api / types、App / style 配套）/ probe-m11 六节 + 存量基线同步；静态全绿（双端 typecheck / probe:m11 / 兼容回归 probe:m2a·m3·m6·m7·m8·m9·m10）；实弹 Run 98 六步全过（rerun 复用 `tasks_succeeded=20 / 预计执行 0` 零变化 + 活跃拒绝 400；对齐成片 #1139 video 110.920 / audio 110.928 / container 110.929 参数·日志·ffprobe 三点吻合、拖尾 35.6s 消除；BGM #1142 volumedetect 静音窗 −91.0→−30.5dB、淡入区增益温和、params 溯源；转场 #1144 帧级 PSNR 交叉窗 3.0s=11.2dB vs 窗外 2.9s / 4.0s 均 41.0dB；存量兼容 #1136 与基线 #1110 逐值一致；浏览器 DOM 五组全 PASS）；实弹暴露并修复两处布局缺陷：①全局 `select{width:100%}` 命中转场下拉独占整行挤出配乐按钮（`.wb-sel` 收窄 width:auto + max-width）②存量缺陷——任务行 nowrap 长 prompt 经 grid `1fr` auto-min 撑破轨道致整页横滚 10569px（`.cols` 改 `minmax(0,1fr)`，修复后 scrollWidth 738）；重大发现：续跑链 run 工作台溯源双向受限（写侧 no_producer 拒绝 / 读侧 latestStoryboardOf 回退旧快照致台词缺失），实弹以锚点修正临时恢复、列后续批次修复（见 README M11 验收快照第 11 行）

## M12 注记（2026-09-12 立项：旧版本清理与收藏 + 图像检测）

- 性质：M7 spec §1.3 排除项「旧版本自动清理 / 收藏｜清理策略另立 backlog」与「图像检测（Toonflow 特有）｜独立能力，backlog」的接力落地 + M10 注记「上传资产的独立版本管理（并入 M12 旧版本清理与收藏）」兜底——18 项 backlog 组1「工作台运营与资产」收尾批（第 6~7 项）；2026-09-12 源码二次核实——Toonflow「图像检测」全局 0 命中（多轮 grep 无显式实现，非源码原生术语）、huobao「检测 / 收藏 / 版本清理」均 0 命中，两能力按本仓语义自定（生成物有效性检测 / 平台级资产运营）；设计见 `2026-09-12-agencys-content-studio-m12-design.md`
- 范围：①收藏全链 UI 化（工作台版本卡 ♥ / 素材卡 ♥ / 素材页「仅收藏」前端筛选；`is_favorite` 列与 `PATCH /assets/:id` 均既有，零库改动）②版本清理（新服务 `services/version-cleanup.ts`：`cleanupVersions` 保留三规则——组内最新（max(createdAt)，tie→max(id)）/ `isFavorite=1` 全部 / 被任意 `pipeline_steps.output.asset_ids` 引用；组键任务组 `t:<taskId>` / 上传组 `u:<runId>:<stepId>:<shotId>`；其余软删（`deletedAt`）可回溯；范围支持工作台级与项目级）+ 回收空间（`gcProject`：软删资产 unlink 文件 + `thumbs/<id>.webp`，行保留审计 / 失败跳过 / 幂等）③图像检测（新服务 `services/image-check.ts`：ffmpeg signalstats 单帧统计 → 判定表 broken / black / flat / ok / no_file / ffmpeg_unavailable 宽容；落点 `assets.params.quality` 零新列；`yavg<16`→`<=16` 边界校准，limited-range 纯黑 Y=16 实测命中）④写路径集成（`ai-image` 落盘 / `uploadAndBindShotAsset` / `routes/assets.ts` imports 三处 fire-and-forget + `POST /assets/:id/check` 手动重检兜底）⑤合成守卫（`computeShotSegments` 扩展 `warnings`，异常图仅警示不阻断）⑥路由 +4 端点（`runs/:id/shots/cleanup` / `projects/:id/assets/cleanup-versions` / `projects/:id/assets/gc` / `assets/:id/check`）⑦Web（ShotBoard ♥ + quality 徽标 + 「清理旧版本」；AssetGrid ♥ + 徽标；AssetPreviewer 「重新检测」；ProjectDetailView 「仅收藏」筛选 + 「清理历史版本」 + 「回收空间」强确认）⑧探针 `probe-m12.ts` 六节（cleanup / imagecheck / gc / board / merge-guard / regression）
- 红线复核：**零新表、零新列、零模板提示词**——`schema.ts` / engine / refs / loader / 适配器 / workspace 模板与提示词全局零 diff（`git status` 核查）；软删语义不变（物理删除仅 gc 显式触发，danger 强确认 + 失败跳过 + 幂等）；不改「产物即选择」（`output.asset_ids` 事实源不动，清理全项目引用集保守扫描）；不引入新依赖（检测复用 ffmpeg-static；package.json 仅 +`probe:m12` 脚本）；设计原则 = ①软删 / 回收两段式（清理可回溯，回收不可逆强确认）②三重保留保守防误删 ③检测宽容降级（ffmpeg 不可用不标记、异常图仅徽标与日志）
- 明确排除：单卡删除 UI、已清理资产恢复（回收站）、分镜 / 文本资产版本清理、存量资产批量检测回填、图像内容审核 / NSFW / 语义标签、合成阻断、素材页多选批量操作（见 spec §1.3）
- 当前状态（2026-09-12）：实施 + 探针 + 实弹全绿——服务端（`image-check.ts` / `version-cleanup.ts` 新建；`shot-workbench.ts` BoardVersion +2 字段（isFavorite / quality 容错）；`ffmpeg-merge.ts` warnings；`routes/assets.ts` +3 端点 / `routes/shots.ts` +1 端点；`ai-image.ts` 集成）/ Web（`ShotBoard` / `AssetGrid` / `AssetPreviewer` / `ProjectDetailView` / `Icon` / `format` / `api` / `types`）/ 探针（`probe-m12` 六节 66 项断言全绿 + 回归 `probe:m7 / m10 / m11` 全绿）；实弹项目 10 全链（收藏 PATCH → 回读 `isFavorite=1` → 「仅收藏」筛选 DOM 唯一命中；检测 #1108 `quality={ok:true, stats.yavg=69.3657}`、黑图 #1148 上传实测 `black`（`yavg=16` 边界）；工作台级清理 `groups=19 / cleaned=1（#919）/ kept=19`、项目级 `groups=106 / cleaned=2（#831·#1012）/ kept=106`、终态逐值核对 **20/20**（软删集合恰好 `[831,919]`，零误伤）；回收 `files=4 / freed_bytes=2,981,444`；存量兼容 board 22 版本 quality 全 null 不误报；浏览器 DOM 四要素 **10/10**（♥ / 疑似黑图徽标 / 仅收藏筛选 / 清理确认弹窗））；review 见 `2026-09-12-agencys-content-studio-m12-review.md`

## M13 注记（2026-09-12 立项：素材链补全——视觉提取 / 多预设叠加 / 视频参考图 / 上传通道 / 批量润色 / states 入库）

- 性质：M8 spec §1.3 排除表六项（roadmap「素材链扩展候选」）的接力落地——18 项 backlog 组2「素材链补全」批次（六项一次交付）；2026-09-12 源码核实——Toonflow `extractStylePrompt.ts`（多图 `content` 数组 + system 格式令「(画风：中文,english)」）与 `polishAssetsPrompt.ts` / `batchPolishAssetsPrompt.ts`（视觉手册 system + 素材 user → 回写）为 ①⑤ 对标来源；huobao「提取 / 多预设 / 润色」0 命中；设计见 `2026-09-12-agencys-content-studio-m13-design.md`
- 范围：①视觉提取（`services/llm.ts` content 放宽 `string | ChatContentPart[]` 多模态 + `POST /style-presets/extract` + `style-extract.md`（「（画风：中文,english）」格式令）+ `extractSnippetFromText` 宽容解析 cap 400；**不落库**，前端预填表单）②多预设叠加（settings 新键 `style_preset_ids`（有序去重）+ 旧单值键回退；`combineStyleSnippets` 「；」拼接；`injectStyleAnchor` 签名不破（单值逐字等价）；`gen_tasks.params` 双写 `stylePresetIds` + `stylePresetId`）③视频侧场景/道具参考图（`VideoAdapter.referenceImages` 能力位（volcengine / minimax / aliyun-wan = base64）+ `collectSetRefAssetIds`（场景≤1 + 道具≤1 保序去重）+ `planVideoRefs` 四分支（none / no_cap / frame_first / ok；首帧优先规避 Wan 帧参考互斥）+ `params.setRefAssetIds` 快照）④上传通道（`POST /entities/:id/ref-images` multipart → `importFiles`（sha256 复用）→ `attachRefAssets` 并集；全局实体 400 / >10MB 413 / 非图 400）⑤批量润色（`POST /entities/polish` + `entity-polish.md`：逐项串行 ≤10、失败收集不阻断、只更新 appearance、`recordLlmUsage`（全局实体跳过））⑥states 入库（`characters` + `states` 列幂等迁移（kind 先例同款）+ char_profile v2 契约 `states[]` 全链（normalizeSpec → upsertEntity 非空覆盖 → PUT 替换语义 → toEntityView 坏 JSON 容错）+ Web 表单 / 卡片 chips（前 2 条 + 「+N」））⑦Web（素材页多选 + 「批量润色（N）」+ 「上传新图」+ states 编辑；风格页「从参考图提取画风词」区；项目编辑预设 checkbox 多选面板）⑧探针 `probe-m13.ts` 七节（style-multi / vision / video-refs / upload / polish / states / regression）
- 红线复核：**不改引擎、模板与存量提示词**——engine / refs / loader / workspace/templates 零 diff；不破 M8 探针签名（`injectStyleAnchor` / `resolveProjectStyleSnippet` / `upsertEntity` 旧签名保持，新增为可选参数 / 薄封装）；不改 first_frame 语义（参考图仅在无首帧时生效）；不改 shot-workbench / tts / 字幕 / 合成；不引入新依赖（多模态为 OpenAI 兼容协议扩展；上传复用 importFiles）；schema 仅 +`states` 列（设计 §5 白名单内）+ db 幂等迁移 +1 行；设计原则 = ①提取不落库（防 LLM 幻觉词污染预设库）②首帧优先（跨厂商统一决策）③宽容降级全链（提取 / 润色 / 上传 / 参考图注入失败均不炸主链）
- 明确排除：提取结果自动落库、预设级联删除保护、视频侧角色参考图（一致性由首帧承载）、视频侧场景/道具文本锚定注入、状态变体运行时注入（变体出图）、润色版本历史 / 撤销、素材页全量多选批量操作、多模态历史消息（见 spec §1.3）
- 当前状态（2026-09-12）：实施 + 探针 + 实弹全绿——服务端（`llm.ts` 多模态放宽 / `style-preset.ts` 复数化 + extract / `entity-polish.ts` 新建 / `character.ts` +states / `ai-image.ts` 复数注入 + 快照 / `ai-video.ts` 参考图收集注入 + `setRefAssetIds` 快照 / `character-sync.ts` states 透传 / 适配器 ×4 能力位 / `schema.ts` + `db/index.ts` states 列迁移 / `routes/style-presets.ts` +extract / `routes/characters.ts` +polish +ref-images +states）/ 提示词 ×2 新（style-extract / entity-polish）/ Web（`EntitiesView` / `StylePresetsView` / `ProjectFormModal` / `api` / `types`）/ 探针（`probe-m13.ts` 七节 **121 项断言全绿** + 回归 `probe:m7 / m8 / m10 / m11 / m12` 全绿）；静态全绿（双端 typecheck 0 错）；实弹项目 10（Run 97/98）七项全过——① 视觉提取（deepseek-flash 多模态实测支持：2 图 → snippet「（画风：电影感写实3D渲染,…）」→ 预设 #2 落库）② 多预设（重跑 s02 `stylePresetIds=[1,2]` + 尾缀逐字「A；B」）⑦ 单值兼容（重跑 s01 `stylePresetIds=[1]` 回退数组化 + 尾缀逐字不变 #1059→#1150）③ 视频参考图（重跑 s16 `setRefAssetIds=[797,798]` 快照 + 首帧保留（1005）；当前 provider（pollinations_video 能力 none）真实降级日志 no_cap；frame_first / ok 分支探针覆盖 #1153→#1154）④ 上传（#1155 `purpose=reference_character` 挂素材甲 `refAssetIds [801,1155]` 并集）⑤ 润色（2 项 appearance 变化 + usage 4 行）⑥ states（PUT 替换语义 + DB 入库 + 列表透出）；浏览器 DOM **22/22**（无头 Chrome CDP：states chips / 批量润色计数 0→1→2 / 上传入口 / 提取区与缩略图 / 项目多选回填 2 项；截图 6 张 `apps/web/tmp-m13-dom-1..6-*.png`）；review 见 `2026-09-12-agencys-content-studio-m13-review.md`

## M14 注记（2026-09-12 立项：平台层收官——集级参数 / 剧集实体〔桌面端取消〕+ 静态托管）

- 性质：组3「平台层」批次——18 项 backlog 去重 17 项的**收官批**（第 15~17 项）：①集级参数 ②剧集实体 ③桌面端；**范围调整（2026-09-12，决策留痕）**：③桌面端经用户决策取消——项目定位本地单机 Web 工具（自用、无对外分发需求），与 M1 红线「Electron / Docker / 远程部署 → 永久不做」一致；`apps/desktop` scaffold 全量删除 + Electron 二进制下载中止 + `pnpm-workspace.yaml` 恢复原样（git 零残留）；静态托管（原 P2 按需项）保留落地（非桌面端专属）；设计见 `2026-09-12-agencys-content-studio-m14-design.md`
- 范围：①集级参数（`services/run-params.ts` 白名单校验纯函数——image provider/model/size · video provider/model/resolution 480p·720p·1080p/duration 1–30 clamp · audio provider/voice · llm temperature 0–2 clamp/max_tokens 256–65536 clamp，未知键 / 类型不符 400 `bad_params`；`context.ts` 三层叠加 `{...template.defaults, ...projectSettings, ...runParams}`（action 零改动）；`run.input._params` 对齐 M11 `_compose` 内部键先例，续跑随 input 复制；`RunFormModal`「本集参数覆盖（可选）」折叠区五控件（出图尺寸 / 视频清晰度 / 单镜时长 / 配音音色 / LLM 温度））②剧集实体（`schema.ts` +`series`（一项目一剧）/ `episodes`（唯一 `(projectId, number)`）两表 + db 幂等迁移；`services/series.ts`（CRUD + 集状态 = 最新 run 状态优先双源合并；缩容仅删尾部空集、占用行 409 `episode_in_use`；删剧含关联 run 集 409 `series_in_use`）；`routes/series.ts` 6 端点；`runs.ts` 联动回写 `latest_run_id`（后置动作、失败不阻断）；`SeriesBoard.vue` 剧集地图卡 + 起作接力（`initialTemplateKey` = 项目默认模板 + 预填 `episode_number`））+ 静态托管（`env.ts` +`WEB_DIST`（`CSTUDIO_WEB_DIST`）；`app.ts` 于 `/api/v1` 挂载后 404 兜底前 `existsSync(index.html)` 才启用——`/assets/*` 静态 + 其余非 `/api/*` GET 回退 index（SPA 深链）、window-safe 归一化 + 穿越防护、`/api` 未命中保持 JSON 404 优先）+ ③桌面端〔已取消〕（scaffold 全量删除（6 文件），原设计保留于 spec §2.3 决策记录）+ 探针 `probe-m14.ts` 四节（params / series / static / regression）
- 红线复核：**不改引擎 / refs / loader / 模板 / 提示词**——engine / refs / loader / workspace/** 零 diff；集级参数在 context 合并链顶层注入（无 `_params` 逐字等价，probe 断言）；剧集联动为路由端点后置回写（不触 run 生命周期、不挂事件）；schema 仅 +`series` / `episodes` 两表（平台级通用，对齐 M8 `style_presets` / M9 通用资产承载先例）+ db 幂等迁移；不引入运行时新依赖（electron / electron-builder 未进任何依赖链，lockfile 零记录）；设计原则 = ①runtime 叠加（run 覆盖 > 项目 settings > 模板 defaults）②双源合并派生（集状态 = 该集最新 run 状态优先、回落行原值）③env 驱动静态托管（无值 = 现行为逐字不变）
- 明确排除：per-shot 音效、在线可编程供应商、剧集级级联批量运行计划表（排产日历）、桌面端（Electron 形态整体——自动更新 / 托盘常驻 / 多窗口 / mac·linux 打包目标随之终局）、集级参数运行中热调（要改走重跑）（见 spec §8）
- 当前状态（2026-09-12）：实施 + 探针 + 实弹全绿——服务端（`run-params.ts` / `series.ts` 新建；`context.ts` 三层叠加；`routes/series.ts` 新建 + `runs.ts` 联动回写；`app.ts` 静态托管段 + `env.ts` +WEB_DIST；`schema.ts` +2 表 + `db/index.ts` 迁移；`run-create.ts` 校验接入）/ Web（`RunFormModal` 覆盖折叠区 / `SeriesBoard.vue` 新建 / `ProjectDetailView` 剧集地图卡 / `api` / `types`）/ 探针（`probe-m14.ts` 四节全绿 + 回归 `probe:m7 / m8 / m10 / m11 / m12 / m13` 全绿）；静态全绿（双端 typecheck 0 错）；实弹项目 10 三项全过——①集级参数（Run 101 `_params = {image.size:768x768, video.duration:10, llm.temperature:0.5}` 入参快照；gen_images 20/20 任务 `params.size=768x768` 命中 + `stylePresetIds=[1,2]` 项目层叠加；对照 Run 98 重跑（无覆盖）：任务 id 集合不变 + 既有 7 键逐值零漂移 + `size=832x1248` 模板默认保持 + 产出 20/20 更新；唯一演进键 `stylePresetIds`（s01 [1]→[1,2]）系 M13 单值回退 → 多预设叠加的预期收敛，非漂移）②剧集实体（建剧「M14 实弹·剧集」3 集；Run 101/102 起作联动 `latest_run_id`；派生状态 completed/failed/locked；集1标题行内编辑 200；409 矩阵 `episode_in_use` / `series_in_use` + 409 后视图未受损）③静态托管（3101 隔离实例 + 真实 dist：首页 200 text/html + 真实 assets js 200 text/javascript（96.5KB）+ 深链 `/projects/12/timeline` 回退 index + `/api` 未命中 JSON 404 优先）；浏览器 DOM **14/14**（剧集地图 3 集行 / 起作接力直达表单 / 覆盖区 5 控件 + 集号预填 3 + 滚动可见实测；截图 2 张 `apps/web/tmp-m14-dom-1..2-*.png`）——实弹过程修复 1 处（`SeriesBoard` 头部 `.bh/.bt` 系 ProjectDetailView scoped 样式不穿透子组件 → 组件内补定义复验）与运行环境事故 1 起（:3001 服务进程闪断，根因未定位；run102 失败留档 + run101 续跑至 completed；详见 review）；review 见 `2026-09-12-agencys-content-studio-m14-review.md`

## M15 注记（2026-09-13 立项：流水线画布工作台）

- 性质：红线「Electron/画布仍未引入」中「画布」项的正式引入——项目自 M1 起将画布列入红线（不引入）、roadmap 待评估项；代码库零画布实现；设计见 `2026-09-13-agencys-content-studio-m15-design.md`
- 范围：①依赖语义抽取（`pipeline/dag.ts`：`stepDeps` / `stepDepEdges`；engine 两处调用点改纯委托，删 2 个私有方法 −45 行）②画布读模型（`services/canvas.ts`：`buildRunCanvas`〔节点=行×def 合并 / sched 边 + data 边 / 操作可用性真值矩阵 / 与 checkRepairable 同源对拍 / 宽容兜底〕+ `buildTemplateCanvas`〔设计态零运行字段〕）③路由（`routes/canvas.ts` 两枚全 GET）④Web 三组件（`CanvasView` 页壳〔query 单一真源 / 模式切换 / 实时对账〕+ `CanvasBoard`〔分层布局最长路径松弛 + 手绘 pan/zoom ∈ [0.3, 2.5] + 首次自动 fit + SVG 贝塞尔边 + 状态徽标〕+ `CanvasDrawer`〔操作/输入引用/产物/任务/日志/闸门两态〕）⑤导航接线（App 侧栏 + RunDetail「画布视图」+ Templates「画布」）⑥探针 `probe-m15.ts` 四节（dag / canvas-run / canvas-template / regression）
- 红线复核：**零新表零新列**（schema.ts / db 零 diff）；**零新依赖**（pan/zoom/SVG 手绘）；**零写端点**（canvas 路由全 GET；所有操作复用既有端点——gate/cancel/resume/rerun/task retry/recompose/start）；引擎唯一触碰 = `depsFor/whenExprs` 移入 `dag.ts` 的纯委托（调度行为三重背书：diff 留痕 / probe dag 矩阵 18 项 / 全量回归）；refs / loader / 模板 / 提示词零 diff；设计原则 = ①依赖语义单一真源（画布与调度同源调用非复制）②画布读模型纯读零写 ③视图状态独立于数据层（防抖对账保 pan/zoom/选中）
- 明确排除：画布上改编排（拖拽连线写回 YAML）、力导向布局、跨 run/跨模板全景图、批次画布聚合视图、画布内编辑提示词/资产（见 spec §8）
- 当前状态（2026-09-13）：实施 + 探针 + 实弹全绿——服务端（`dag.ts` / `services/canvas.ts` / `routes/canvas.ts` 新建；`engine.ts` 纯委托重构；`app.ts` +1 挂载；`package.json` +`probe:m15`）/ Web（`CanvasView` / `CanvasBoard` / `CanvasDrawer` 新建 + `router` / `App` / `Icon` / `api` / `types` / `RunDetailView` / `TemplatesView`）/ 探针 `probe-m15.ts` 四节 **78 项断言全绿**（dag 18 / canvas-run 43 / canvas-template 14 / regression 3）+ 回归 probe:m2a·m4·m14 全绿；静态全绿（双端 typecheck 0 错）；实弹浏览器 DOM 两轮——首轮（A1~A15：14 通过 + 1 项数据态不适用〔run102 无 failed 节点系服务重启中断态〕）暴露并修复 1 处缺陷（fit 时机：挂载时数据未到按空布局 fit → `fitted` 标志 + 首次非空数据 `fitOnce`；`resetView` 同步清数据）；复验（B1~B12 全通过：自动 30% fit / run96 failed 步单步重跑（RerunModal 打开取消无提交）/ run80 人工闸门 drawer / 模板画布 21 节点设计态 / 空态引导 / Templates「画布」入口；全程零真实提交零计费）；实弹备注：812px 小窗 fit 后两侧溢 67px 系 `zoom ∈ [0.3, 2.5]` 钳制既定行为（1600px 窗口完全适配），非缺陷；截图 13 张（`tmp-canvas-S1..S6` / `tmp-canvas2-S1..S7`）；review 见 `2026-09-13-agencys-content-studio-m15-review.md`

## M16 注记（2026-09-13 立项：创作画布）

- 性质：M15 收官后由用户立项的**第二类画布**——创作画布（内容「怎么做得出来」：自由摆放素材 + 引用连线 + 就地生成与编辑，写模型），与 M15 流水线画布（流程「怎么跑」：纯读监控 + 操作台）并存互不替代；设计见 `2026-09-13-agencys-content-studio-m16-design.md`
- 范围：①数据模型（**首次引入新表**：`canvases` / `canvas_nodes` / `canvas_edges` + `gen_tasks.canvasNodeId` 列；节点状态零存量，全部由 gen_tasks 派生）②文档层（`services/creation.ts` + `routes/creation.ts` 14 枚：buildCanvasDoc 全量读模型 / CRUD / 端口矩阵 + 环检测 / duplicate / template-draft）③执行通道（`services/creation-gen.ts` 直连适配层：信号量 ≤2 / 失败自动重试 1 次 / 视频轮询 / 崩溃恢复标 failed；任务 runId·stepId 恒 null）④编辑能力声明制（`adapters/types.ts` +`editing`/`edit`/`ImageEditRequest` 零破坏可选扩展；首家 `aliyun-wan-image` 对表万相编辑系）⑤Web 五组件 + 组合式（CreationView / CreationBoard / CreationInspector / EditBrushModal / CanvasTargetModal + `lib/board-viewport.ts`）⑥联动三枚（run 产物→画布 / 画布产物→实体参考图 / 画布素材→送去运行）⑦模板化沉淀（复制画布 + 低保真模板草案）⑧探针 `probe-m16.ts` 六节（canvas-doc / node-build / edit-cap / draft / linkage / regression）
- 红线复核：**首次打破「零新表」**（画布文档为写模型，必要引入，明示；沿用 M3 后 `ensureTable`/`ensureColumn` 运行时幂等兜底，旧库升级不炸）；refs / loader / 模板 / 提示词零 diff；生成主链零改动（pipeline actions / engine / dag 零 diff）；M15 `CanvasBoard` 零 diff（唯一触碰 = `CanvasDrawer` +1 联动按钮）；零新依赖（涂抹 = canvas 原语 / 连线拖拽 = pointer + SVG / pan·zoom = M15 已验证手绘模式）；设计原则 = ①URL 单一真源（项目·画布切换全走 query）②状态零存量（节点状态与结果全部由 gen_tasks 派生）③能力声明制（编辑未声明 → 置灰 + 错误透传不炸）
- 明确排除：多选 / 框选 / 撤销重做 / 成组、跨画布复制节点、协作分享、节点 resize、tts 音频节点、画布导出 png·svg、力导向布局、指令式整图编辑独立通道、画布 → 模板一键可运行（草案为低保真）（见 spec §8）
- 入口收敛（2026-09-13 追加决策）：导航单入口「画布」= 创作画布（`/creation`）；流水线画布退为上下文视图（运行页「画布视图」/ 模板页「画布」进入，`/canvas` 直链保留）——两画布仍**并存互不替代**，不做功能融合（异质：视图 vs 文档 / 读模型 vs 写模型；布局·生命周期·操作集三重结构性冲突），仅入口层消歧；未来若再贴近，方向 = 创作画布内嵌「运行节点」（M17 候选）
- 当前状态（2026-09-13）：实施 + 探针 + 实弹全绿——服务端（`services/creation.ts` / `creation-gen.ts` / `routes/creation.ts` 新建；`schema.ts` +3 表 +1 列 + `db/index.ts` 幂等兜底；adapters 类型扩展 + aliyun-wan 编辑实现；`events.ts` +1 + `index.ts` 房间正则 / 桥接 / 崩溃恢复；`projects.ts` 删项目级联清画布）/ Web（五组件 + `board-viewport.ts` + router / nav / icon / api / types / socket + 联动接线）/ 探针六节 **126 项断言全绿**（canvas-doc 56 / node-build 34 / edit-cap 11 / draft 13 / linkage 10 / regression 2）+ 回归 `probe:m15`（内含 m2a/m4/m14）全绿；静态全绿（双端 typecheck 0 错）；实弹浏览器 DOM——建画布·切换 / 素材拖入摆放 / 双击建生成节点 / 连线（源图入边）/ 节点拖拽 / Inspector / 蒙版涂抹导出上传回填 / pan·zoom·fit 视口刷新保持；真实出图 ×2（pollinations 零计费：任务 #450 16.2s、#451 17.5s）；联动三枚（run 101 抽屉「送入创作画布」→ 新建画布「M15联动验证」网格落点；画布图挂接「灯婆婆」参考图并 PUT 无损回滚；「送去运行」prefill 两分支〔全画布过滤 image/text / 选中节点优先〕）；编辑通道无 key 退化验证（置灰警告 + 任务 #452 错误透传「未实现图像编辑能力」，零网络零计费）；模板草案低保真导出（YAML + 校验自检 + 复制 YAML 剪贴板回读）；实弹暴露并修复 4 处缺陷（CreationInspector TDZ / CreationView docSeq TDZ / uploadFiles 契约 assets→items / **漏 join canvas 房间**——URL 同步 watch 先于房间 watch 注册且无 immediate，首次进入/刷新错失 null→id 变化；加 immediate 修复后 socket 全自动流转复验）；截图 3 张（`apps/web/tmp-m16-draft-modal.png` / `tmp-m16-edit-cap-hint.png` / `tmp-m16-edit-fail.png`）；review 见 `2026-09-13-agencys-content-studio-m16-review.md`

## M17 注记（2026-09-13 立项：创作工作台）

- 性质：M16 §8 排除项回收（「多选 / 框选 / 撤销重做」✅、「tts 音频节点」✅ 扩为音频+合成闭环）+ M16 注记「未来若再贴近，方向 = 创作画布内嵌『运行节点』（M17 候选）」的落地 + 2026-09-13 用户决策「**13 项缺口全量纳入、无一排除**」——创作画布从「带连线的执行器」升级为完整创作工作台（spec §1.1 四方向勘察：创作循环〔挑不了·钉不住·实体接不进·prompt 写死〕/ 规模操控〔零键盘·无多选·误删不可逆〕/ 产出沉淀〔运行留不住·无打包出口·无总览〕/ 声音与合成 + AI 辅助〔零接入〕）；设计见 `2026-09-13-agencys-content-studio-m17-design.md`
- 范围：①数据模型（canvas_nodes +2 列 `adoptedTaskId` / `seq`）+ 文档层 v2（kind 扩充 text|entity|run / 端口矩阵 v2 / 读模型 v2 / `pickDisplayTask` 采纳优先 / extract 支撑）②端口矩阵 v2（+prompt / video / audio 端口；reference 扩实体源；from 侧类型校验补齐；run 节点不参与任何连线双向拒绝）③创作循环（变体执行 1–4 + 结果画廊 + 采纳钉稿 / entity 节点参考直通〔refAssetIds 展开超限截断记 notes〕/ text 节点 prompt 复用）④工作台操控（多选 / 框选 / 批量移动·复制·删除 / 快捷键全集 / 撤销重做命令栈 / 一键整理·对齐·分布 / seq 故事板编号）⑤产出沉淀（内嵌 run 节点〔送去运行不跳转 + 非终态 5s 轮询〕/ zip 打包导出 + manifest / 全局总览抽屉）⑥音频与合成（audio 执行径只读复用 tts 服务 / compose 执行径只读复用 ffmpeg 服务 + `buildComposeArgs` 纯函数）⑦AI 辅助（prompt-expand + chain 规则式串联）⑧端点 14 → 23（9 新 + 3 超集扩展）⑨探针 `probe-m17.ts` 八节 274 项断言
- 红线复核：canvas_nodes +2 列走 `ensureColumn`（migrate 基线不动；旧库升级幂等）；**M16 既有 14 端点全部超集兼容**（旧 body → 旧行为，响应只增字段）；生成主链零改动（引擎 / pipeline actions / dag / refs / loader / 适配器零 diff）；M15 流水线画布零 diff（「送去运行不跳转」仅改 CreationView 内回调）；零新依赖（fflate 既在依赖；撤销栈 / 框选 / 快捷键为原生 pointer/keyboard；音频播放为原生 `<audio>`）；**唯一破坏性交互变更**（空白左拖 平移 → 框选；平移改空格 / 中键）——spec 与 README 双处明示 + 空态引导同步；设计原则 = ①采纳优先（节点对外引用与显示同源走 `pickDisplayTask`）②命令栈撤销（删除逆操作 = 快照重建 + `restoreFromNodeId` 任务历史认领）③确定性规则（串联 / 整理 / 编号均为纯函数；LLM 决策式编排入 backlog）
- 明确排除：自动级联执行（防爆量计费）、跨画布复制节点、画布 → 模板一键可运行、独立故事板时间轴视图、LLM 决策式自动编排、图像拼图 / 网格合成、画布导出 png / svg、力导向布局、节点成组 / 折叠 / resize / 迷你地图、多会话版本历史、协作 / 分享、run 节点产物批量拉入画布、zip 流式打包 / 断点续传（见 spec §8）
- 排除项回收：M16 §8「多选 / 框选 / 撤销重做 ✅ 本版已收；tts 音频节点 ✅ 本版已收（扩为音频+合成闭环）」；M16 注记「内嵌运行节点（M17 候选）」✅ 落地（run 节点一等公民）；其余排除项延续（跨画布复制 / 协作 / 成组〔M18 已收〕/ resize / png·svg 导出 / 力导向 / 指令式整图编辑 / 模板一键可运行〔M18 template-try 收〕）
- 当前状态（2026-09-13）：实施 + 探针 + 实弹全绿——服务端（`creation-ops.ts` / `creation-export.ts` 新建；`creation.ts` 文档层 v2；`creation-gen.ts` variants / audio / compose / 批量执行；`routes/creation.ts` +9 +3 = 23 枚；`db/schema.ts` +2 列 + `db/index.ts` ensureColumn ×2；`storage.ts` purposeSubDir +2〔creation_audio → audio/、creation_compose → video/〕）/ Web（`canvas-history.ts` 新建 + `CreationBoard` 重构〔selectedIds / 框选 / 快捷键 / 多拖 / 新卡型 / 徽标 / 批量浮动条〕+ `CreationView`〔顶栏整理·导出·总览 / onRunStarted 不跳转 / run 轮询〕+ `CreationInspector`〔全型面板 + 画廊采纳 + AI 扩写 + 提取〕+ api / types / Icon）/ 探针 `probe-m17.ts` 八节 **274 项断言全绿**（node-kinds 37 / port-v2 40 / input-v2 37 / batch-ops 77 / variant-adopt 26 / run-node 10 / export 24 / llm-assist 23；spec §2.9 计划九节含 regression，实施为八节——回归以独立跑 `probe:m16`〔其 regression 节内嵌 `probe:m15` → m2a/m4/m14 零漂移〕完成 + `probe-m16.ts` 本体兼容适配〔端口 v2 引起的用例更新：音频 genKind 非法用例迁移 / 视频 gen 参考源用例改图像 gen / nodeCount 4→5 / params 快照 +新字段〕）；静态全绿（双端 typecheck 0 错）；实弹浏览器 DOM（画布 5「M17实弹」：变体执行 ×2 与画廊采纳〔节点 #19 adoptedTaskId=457〕/ 下游引用上游产物 / 批量执行 / 框选多拖 / 快捷键 + Delete·Ctrl+Z 快照重建（三轮循环实证）/ 整理对齐编号 / 导出 zip（资产 #1328 263,757B）/ 送去运行 run 节点 #24（运行 #103）/ 音频真实 TTS（任务 #458 → 资产 #1331；重跑 #460 → #1333 落 audio/）/ compose 真实 ffmpeg（任务 #459 → 资产 #1332 640x360 10.333s，ffprobe 独立复核 h264+aac）/ 全局总览定位）；实弹暴露并修复 3 处缺陷（快照重建任务孤儿 → `restoreFromNodeId` 认领 / redo·undo 循环认领源过期 → `snap.curId` 循环修复 / 产物子目录映射缺失 → `purposeSubDir` +2 重跑复验）；review 见 `2026-09-13-agencys-content-studio-m17-review.md`

## M18 注记（2026-09-14 立项：创作画布规模化与安全）

- 性质：M17 §8 排除项回收（「节点成组 / 折叠」✅、「zip 流式打包」✅、「多会话版本历史」→ 文档快照（单画布快照，非分支对比）✅）+ 用户 2026-09-14「**1 到 4 一起开发**」决策——四优先批共 14 项：批 1 快赢（抽帧 / compose 转场 BGM / run-preview 预估 / 停止全部 / 实体参考前端）、批 2 安全（回收站软删 + 文档快照）、批 3-1 LLM 文本节点、批 3-2 模板 v2（literal + draft v2 + template-try）、批 4 规模（成组折叠 / 封面 / 流式 zip）；设计见 `2026-09-14-agencys-content-studio-m18-design.md`
- 红线复核：`canvases` +1 列（deleted_at）/ `canvas_nodes` +1 列（group_id）+ 两表（`canvas_groups` / `canvas_snapshots`）全走 ensureColumn / ensureTable 幂等（旧库升级不炸）；**M16/M17 既有端点全超集兼容**（旧 body → 旧行为，响应只增字段：listCanvases +cover/deletedAt、doc +groups/groupId）；**唯一语义变更 = 画布删除物理级联 → 软删进回收站**（README + spec 双处明示 + probe-m16 断言适配）；生成主链零改动（引擎 / pipeline actions / dag / refs / loader / 适配器零 diff）；M15 流水线画布零 diff；端口矩阵 v3（+llm 文本入边）；零新依赖（fflate 流式 Zip 既在依赖）；设计原则 = ①回收站优先（可逆删除 + 快照保留 id 重放）②读模型超集增量③流式与端口收敛
- 明确排除（见 spec §8）：音字对齐、参考边全保真映射、组嵌套（v1 单层）、快照 diff / 分支对比、compose 非等尺寸智能裁剪、抽帧多帧批量（v1 单帧）、回收站保留期自动清理（v1 手动 purge）
- 当前状态（2026-09-14）：实施 + 探针 + 回归全绿（实弹浏览器见 review）——服务端（`creation-groups.ts` 新建；`creation.ts` doc +groups/groupId + listCanvases cover 派生（两次批查）+ 软删四态 + 快照 CRUD 保留 id 重放；`creation-export.ts` zipSync→fflate 流式直写临时文件；`creation-gen.ts` extractNodeFrame / previewCanvasRun / cancelCanvasTasks / executeLlmOnce；`routes/creation.ts` +抽帧 / run-preview / tasks:cancel / template-try / groups×3 / restore·purge / snapshots×4；`schema.ts` +2 列 +2 表；llm 端口 v3；`usage.ts` 抽 resolveUnitPrice）/ Web（`types.ts` CanvasGroup / groups / groupId / cover + `api.ts` 组/抽帧/预览/停止 API + `CreationBoard.vue`〔组框 / 折叠 / 组条拖拽·重命名·改色·解组 / Ctrl+G / 封面卡片〕+ `CreationView.vue`〔停止全部 / 快照抽屉 / 试跑 / 回收站 / 成组 / lossy〕+ `CreationInspector.vue`〔抽帧 / compose 转场·BGM / llm / 实体参考〕）/ 探针 `probe-m18.ts` 九节 **247 项断言全绿**（p1-schema + frame-extract / compose-v3 / run-preview / trash-snapshot / llm-node / template-v2 / groups / scale-zip；含 30MB 流式 store 逐字节对拍）；回归 `probe:m16`（内嵌 m15→m2a/m4/m14）/ `probe:m17` / m3,m6–m13 全绿，适配 1 处（m16 删画布级联 → 软删保留）；静态双端 typecheck 0 错；review 见 `2026-09-14-agencys-content-studio-m18-review.md`

## M19+ 全量立项（2026-09-14：缺口清零纲领）

- 性质：M18 收官后全景评审（README / roadmap / m18-review / 代码级核查）产出的全部缺口 + 本档 Backlog 存量项 + 各里程碑 §8 未回收排除项，经用户 2026-09-14 决策「**不是挑几项而是全部立项**」——去重 **62 项**无一裁剪，登记为 M19–M27 九个后续里程碑；纲领见 `2026-09-14-agencys-content-studio-m19-m27-charter.md`（含缺口全景对照表 / 各里程碑立项卡 / 不可立项登记 / 待决策风险项）
- 序列速览（编号即建议执行序；M26 的 CI 子批建议提前穿插）：
  - **M19 成片品质与品牌化**（字幕样式 / 水印·片头尾 / per-shot 音效 / 多画幅 / 素材批量生成 / states 变体出图 / 声音克隆）
  - **M20 运营自动化与复盘闭环**（排产日历 / 发布回采 / A-B 测试 / 预算熔断 / 成本聚合 / 复盘 CSV / 导出包平台化）
  - **M21 工作台体验**（全局搜索 / 浏览器通知 / tags UI / 键盘流·命令面板 / Gate diff / 并行上限 / 参数热调）
  - **M22 创作画布深化**（音字对齐 / 参考边保真 v3 / 组嵌套 / 快照 diff·分支 / 智能裁剪 / 跨画布复制 / PNG·SVG / 回收站清理 / 多帧抽帧）
  - **M23 画布规模化与智能编排**（性能虚拟化 / 力导向 / LLM 建议式编排 / 全景图 / 批次聚合 / 画布内编辑 / 设计态编排）
  - **M24 内容质量与国际化**（三层记忆 / 一致性评测 / 翻译链 / 多语言字幕配音 / 合规审核）
  - **M25 输入源扩展**（小说链八项 / 视频长素材解析与反推）
  - **M26 工程基建与平台化**（CI / 压测基准 / Ollama / 探针治理 / 提交治理 / 在线可编程供应商〔待决策〕；巨型文件拆分已于 2026-09-15 转入 M28 独立执行；**M28 后「≤800 行」红线残余随本里程碑收口**——新破线 2〔`views/canvas/index.vue` 1172 / `components/pipeline-canvas/CanvasBoard.vue` 855〕+ 存量豁免 2〔`lib/api.ts` 969 / `components/brand/BrandSettings.vue` 1051〕，均触发条件式待拆，见 M23 注记「红线记账」）
  - **M27 自动编排**（跨模板串链 orchestrator / 模板嵌套 / 编排可视化）
- 红线不变：不可立项项（桌面端 / 多用户 / 体裁专属表 / 重型引擎）登记于纲领 §四；待决策风险项（在线可编程供应商 / 小说源抓取 / 排产调度边界 / LLM 编排分层）登记于纲领 §五
- 规则不变：校准规则 1–3 全部照旧——每里程碑开工前仍执行「需求勘察 → L1 spec → 实施 → 探针 → 实弹 → review → 校准」；同一时间仍只存在一个 L1 详细 spec

## M19 注记（2026-09-14 立项：成片品质与品牌化）

- 性质：M18 后全景评审最大缺口集群「后期成片品质品牌化」+ P0 快赢前二项（字幕样式 / 品牌水印）+ 素材链与生成链补全（批量生成 / states 注入 / 声音克隆）；纲领 §一 A 组项归宿；设计见 `2026-09-14-agencys-content-studio-m19-design.md`
- 范围（三批 8 项）：批 1 品牌化（①字幕样式配置化〔结构化字段三层可配，无配置=现行为逐字不变〕②品牌水印〔九宫格/透明度/尺寸/边距，三层来源〕③片头片尾〔时长/SRT 平移/配音位移/BGM 全覆盖语义显式〕）；批 2 声画（④per-shot 音效 SFX〔每镜 ≤1 条、镜起点混音〕⑤多画幅双路径〔A 派生端点默认 + B 合成内多路「原生构图」可选勾选〕）；批 3 生成链（⑥素材页批量生成参考图〔异步任务队列 + 成功后自动挂接实体〕⑦states 逐镜注入接线〔场/集/文本三级匹配，纯文本注入〕⑧声音克隆〔平台音色库 + clone: 引用 + 能力位 + 实测/降级〕）
- 用户决策（2026-09-14 拍板）：①品牌配置**三层全要**（settings 表全局品牌 / projects.settings 项目级默认 / run._compose 覆盖，换 run 不改项目默认）；②多画幅 **A+B 都要**——B 为可选能力（勾选「多画幅原生构图」才启用多路渲染）；③批量生成走**异步任务队列**（gen_tasks 无 run + socket 进度推送，失败收集不阻断）；④声音克隆**全链 + 实测供应商**（不可得则登记降级交付架构）；其余按勘察推荐默认（SFX 每镜 1 条镜起点 / 片头尾不参与转场+SRT 平移 / states 纯文本 / 批量生成提示词 appearance+风格直连）
- 红线复核（预核）：**无破坏性行为变更**；+1 表（voice_clones 平台级）+1 目录（workspace/brand/）+1 env 常量（BRAND_DIR）；assets 零列改动（SFX 走 purpose+params 先例）；ffmpeg-merge 无新配置 filter 链逐字节不变（M7/M11 分支开关先例）；ai-image 无 states 零 diff；resolveVoiceChain 旧签名兼容；零新依赖
- 明确排除（见 spec §8）：文字水印（drawtext）/ SFX 每镜多条与截断淡出 / 片头尾音轨保留与交叉淡化 / 水印时间区间与多水印 / 克隆异步协议与样本落盘 / states 自动出变体参考图 / 多画幅 B 反转画幅逐路重算 / 派生自定义分辨率码率 / 字幕字体上传 / HLS 打包 / 品牌配置版本历史
- 当前状态（2026-09-15）：**实施 + 探针 + 实弹全绿（P1–P9 收官）**——服务端（新件 `brand-config.ts`（三层合并 + 来源解析）/ `brand-assets.ts` / `aspect-derive.ts` / `entity-refgen.ts` / `tts-clone.ts` / `routes/voice-clones.ts` 四枚端点；改动 `ffmpeg-merge.ts` +610/−130（字幕样式组装 / 水印 overlay / 片头尾拼接 + SRT 单次平移 / SFX 镜起点混音 / 多画幅多路输出 asplit 分流，全部分支开关）/ `compose-config.ts` +231（`brand` · `sfx_volume` · `multi_aspect` 白名单）/ `ai-image.ts` +129（`ShotSpec.scene` + states 三级匹配注入）/ `tts.ts` +63（`clone:` 六级链引用 + 溯源）/ 路由新增 14 枚（品牌 3 + SFX 3 + derive-aspect + ref-gen 3 + voice-clones 4）/ `schema.ts` +1 表 + `env.ts` +`BRAND_DIR` + `storage.ts` +2 purpose）/ Web（新件 `BrandSettings.vue` 1,001 / `ComposeSettingsModal.vue` 729（由 BgmModal 338 行升级为六区）/ `VoiceLibrary.vue` / `AspectDeriveModal.vue` / `ShotSfxModal.vue` / `lib/aspect.ts`；改 `EntitiesView.vue` +491（批量生成多选 + 弹窗 + 页内进度）/ api +165（14 枚 API）/ types +127 / `SettingsView` 品牌 + 音色库两 tab / 项目品牌 tab / 成片卡片派生画幅入口 / 角色克隆音色下拉）/ 探针 `probe-m19.ts` 八节 **378 项断言全绿**（subtitle-style 20 / brand-watermark 32 / intro-outro 16 / sfx 41 / aspect 57 / ref-gen 79 / states 39 / voice-clone 94；零网络零计费，ffmpeg 侧 args 快照 + 供应商侧 fetch stub）；回归 **17 个探针（m2a~m19）合计 2233 项断言、适配 0 处**（红线守住：`probe-m11` 合成快照零适配 / `probe-m3` 声线链旧签名零适配）；静态双端 typecheck 0 错；实弹（项目 10 · run 101 · 真实库）——水印合成快照对拍（#1351 `watermark{br,.8,.15,file}`）+ **默认白字零漂移对照**（#1296 与 #1351 `subtitle_style` 逐字相同）/ SFX 绑定与解绑（#1346/#1347 软删留痕）/ 多画幅 A 三比例（#1348 crop / #1349 pad / #1350 crop）+ B 三路原生渲染（#1351+1353+1354，日志「编码 ×3」）/ 批量生成真实出图 7 张（#1355–#1361）+ 取消弃存（task #468）+ 用量逐条对账 / states 注入日志 15 镜 19 条命中 + s11 真实重生成（#1362 prompt 内「状态锚定（阿木·第5场）」）/ **阿里云真实声音复刻**（`api_configs#32` → `voice_clones#1` → 试听 180,524B → `clone:1` 画布配音 task #470 → asset #1363 `voiceSource:'clone'`），音色库 UI 11 步 DOM 全过 console 零错；**未启用降级交付**（凭证可得，真实跑通）；两项协议偏差已在 review 留痕（默认复刻协议取 `qwen-voice-enrollment` + `qwen3-tts-vc-2026-01-22`、样本默认 Data URL 内联）；review 见 `2026-09-15-agencys-content-studio-m19-review.md`

## M28 注记（2026-09-15 立项：架构重组——巨型文件拆分与目录域化）

- 性质：**架构级纯重构**（不新增功能 / 不改行为 / 零新依赖）；纲领 H2 缺口由 M26 转入本里程碑独立执行（M26 保留 H1/H3–H7）；设计见 `2026-09-15-agencys-content-studio-m28-design.md`
- 决策留痕（2026-09-15 用户拍板四项）：① 范围 = 全量 15 个千行文件（服务端 4 + Web 11）② 目标结构 = 激进全面重构（目录按域重排 + import 全量机械改写 + 命名统一）③ 立项形态 = 独立新里程碑 M28 ④ 固化「单文件 ≤800 行」红线
- 范围：服务端四件（`services/creation.ts` 2298 → `services/creation/` 13 模块；`services/creation-gen.ts` 1326 → `creation/gen/`；`pipeline/actions/ffmpeg-merge.ts` 1316 → 同名目录 9 模块；`services/shot-workbench.ts` 1136 → `services/shot/`）+ 域内收敛（creation-ops/groups/export）；Web 十一件（CreationView / CreationInspector / ShotBoard / CreationBoard / TemplatesView / RunDetailView / types.ts / EntitiesView / ProjectDetailView / StoryboardEditor / SettingsView）→ 视图目录化 + 组件域归组 + composables 抽取 + lib/types 目录化
- 技术前提（批 0 已验证 2026-09-15）：bundler 解析下「文件 → 同名目录 + index.ts」导入零改动（tsc ✓ tsx ✓）；改名目录（creation-gen→creation/gen、shot-workbench→shot）按 spec §5 清单机械改写（含 9 处探针动态导入）
- 红线复核：行为零变更（函数体逐字保留 / 无符号重命名 / 导出面冻结）；17 探针（m2a–m19）全绿**零适配**；engine/refs/loader/dag/模板提示词/schema/适配器/package.json 零 diff；函数级内部重构与探针脚本拆分明确排除（分归后续 / M26-H5）
- 验收方向：拆分后全仓文件 ≤800 行（豁免：api.ts 801 / BrandSettings 962 触发条件式待拆）；双端 typecheck + vite build；全量探针零适配；实弹浏览器抽查（画布页 / 镜头工作台 / 设置页 / 项目页）
- 里程碑序列：M28 插于 M19 与 M20 之间执行；M20–M27 编号与范围不变
- 当前状态（2026-09-15）：**已收官**——批 0–批 4 全绿：17 个巨型文件全部拆分（15 目标 + 2 追加），17 个目标目录 147 个产物文件全量 ≤800 行；17 探针零适配全绿 + 双端 typecheck + vite build 绿 + 实弹通过（含 2 处拆分遗漏修复）；review 落盘 `2026-09-15-agencys-content-studio-m28-review.md`

## M21 注记（2026-09-16 立项：工作台体验——检索·通知·键盘流）

- 性质：M18 后全景评审缺口集群「工作台体验」+ Backlog 存量项（键盘流 / 并行上限）合一；纲领 §一 C 组七项归宿；快赢四枚（搜索 / 通知 / tags UI / Gate diff）；设计见 `2026-09-16-agencys-content-studio-m21-design.md`
- 决策留痕（2026-09-16 用户拍板四项）：① 全局并发上限**默认 3、可配 1–6**（engine 全局闸门，超限 run 留 `queued` 等 pump 推进）② 参数热调留痕 **`run.input._params_log` 追加数组**（与 `_params` 同源固化，续跑可重放）③ 全局搜索**关键词全量 + 语义限文本域**（记忆与文本资产用 bge-small 本地向量，模型不可用自动降级）④ 命令面板**含操作类动作**（取消运行等，二次确认防误触）
- 范围（三批 7 项）：批 1 快赢三枚（①全局搜索〔9 关键词域 LIKE + 文本域语义命中 + reindex〕②浏览器通知〔run 终态 / 闸门 / 批次完成，仅后台推送静默降级〕③tags UI〔资产编辑·筛选·批量打标 + 项目 tags，含 `?tag=` 分页错位修正〕）；批 2（④键盘流·命令面板〔Ctrl/Cmd+K，导航 + 搜索直达 + 动作〕⑤Gate diff 审阅〔revisions 端点 + 自研 LCS 行级对比〕）；批 3（⑥多开任务并行上限〔settings 可配 1–6〕⑦集级参数运行中热调〔受限端点 + 留痕 + UI〕）
- 红线复核（预核）：引擎调度语义为**扩展**（单 run 执行链 / DAG / gate 语义逐字不变，行为变更上限默认 3 为拍板项并明示）；搜索零新依赖（LIKE + 本地 ONNX + 自研 LCS）；「快照即证据」不破（`_params` 只增改 + `_params_log` 全量留痕，模板快照零触碰）；无新表（assets +2 列通用 / settings +2 key）
- 明确排除（见 spec §8）：跨 run Gate diff / FTS5 / 非文本域语义向量 / 通知音效与前台推送 / 序列快捷键 / 参数删除键（仅增改）/ 模板快照热改 / 跨队列公平性等
- 当前状态（2026-09-16）：**已收官**——P0–P4 全绿：三批 7 项一次交付（六节探针 86 项〔search 15 / revisions 10 / concurrency 28 / hot-params 18 / tags-sql 10 / settings-kv 5〕+ 回归 m2a–m19 共 17 探针零适配 + 双端 tsc/vue-tsc 绿 + 实弹〔C6/C7 深实弹，C1/C4/C5 冒烟，C3 探针级〕）；收口期五项修复全落地（批间救援缺口 / 预览器标签本地基准 / 热调条件写 / PUT concurrency 即时刷新 / tag 过滤 json_each 精确匹配）；review 落盘 `2026-09-16-agencys-content-studio-m21-review.md`；3 项浏览器全链（palette 结果渲染 / 通知权限 / tags 链）因收口期视图关闭待重开后补验（非实现风险，HTTP 兜底与探针级已验）

## M22 注记（2026-09-16 立项：创作画布深化——编辑与保真）

- 性质：M18 后全景评审缺口集群「创作画布深化」九项 + M18 §8 排除项结转；纲领 §一 B 组归宿；设计见 `2026-09-16-agencys-content-studio-m22-design.md`
- 决策留痕（2026-09-16 用户拍板四项）：①音字对齐 = **全链对齐**（compose 接台词/字幕输入 → 段级时长对齐 + 音轨静音填充 + SRT 生成/平移/烧录）②参考保真 = **纲领两类**（图像参考连线 + 视频 first_frame 两类 draft lossy 清零，含引擎 shots 参考直通通道）③导出实现 = **双端分工**（服务端 SVG 纯函数 + 落资产库；前端 PNG 光栅化直接下载）④跨项目复制 = **混合策略**（同项目跨画布直接引用；跨项目自动拷贝资产文件入目标项目，画布自包含）
- 范围（三批 9 项）：批 1 ①音字对齐全链 ②参考边保真 v3；批 2 ③组嵌套 ④快照 diff/分支 ⑤智能裁剪；批 3 ⑥回收站自动清理 ⑦跨画布复制 ⑧PNG/SVG 导出 ⑨多帧抽帧
- 当前状态（2026-09-16）：**已收官**——P0–P4 全绿：三批 9 项一次交付（探针十一节 **169 项断言**〔spec-fields 9 / trash 12 / schema 2 / align 25 / refs 12 / group-nest 18 / snapshot-diff 18 / fit 4 / copy-to 23 / export-svg 23 / multi-frame 23〕 + 回归 m2a–m19 / m21 **18 探针零适配全绿**（164.5s）+ 双端 tsc / vue-tsc 绿 + 三层实弹〔HTTP API 16 PASS + 浏览器 e2e 8/8 + 修复复核 PASS〕）；review 落盘 `2026-09-16-agencys-content-studio-m22-review.md`
  - 批 1（①音字对齐 + ②参考保真 v3）：服务端 + 探针（60 断言）+ 前端 + 实弹全链验证 ✅
  - 批 2（③组嵌套 + ④快照 diff/分支 + ⑤智能裁剪）：服务端 + 前端 + 探针全绿，**三层实弹验证**（service 探针 → HTTP API 实弹 32/32 → 浏览器 UI e2e）收口；实弹抓出并修复 5 处缺陷：a) `doc.ts` groups 投影漏 `parentId`（前端嵌套渲染静默失效；已修 + 探针补盲断言）b) `.cgroup` `z-index:0` 层叠上下文锁组菜单（点击穿透选节点；已修，M18 结构遗留问题一并惠及色板/解组）c) 折叠父组未隐藏后代组框（验收标准「递归隐藏全部后代」未达标；已修 `hiddenGroupIds`）d) 保存 spec 后「有未保存修改」提示残留（`saveSpec`/`persistFormIfNeeded`/`doRun` 未重置基线；已修 `markFormSaved`）e) 分支命名 placeholder 文案与缺省「源画布名 分支」不一致（已修）
  - 批 3（⑥回收站自动清理 + ⑦跨画布复制 + ⑧PNG/SVG 导出 + ⑨多帧抽帧）：服务端 + 前端 + 探针（S6–S9 全绿：S6 12 / S7 23 / S8 23 / S9 23——含真实 ffmpeg 抽帧全链与真实文件字节级跨项目拷贝）+ HTTP 实弹 16 PASS（真实库跨项目 P10→P14：9 复制 / 1 run 跳过 / 6 资产级联拷贝 / 0 警告；⑧ SVG 落资产可下载 + PNG 400 守卫；⑨ 真实视频 3 帧网格落位）+ 浏览器 e2e 8/8（复制弹窗全链 / 导出菜单三合一双 toast / 均匀抽帧 3 节点落板）；e2e 抓出并修复 1 处缺陷：f) 复制 / 抽帧后画布下拉计数不刷新（`doCopyTo` 未刷列表 + inspector `@refresh` 只刷文档；已修——copyto 注入 `loadCanvases` + `onInspectorRefresh` 双刷），复核 PASS（目标画布 2→3 即时刷新）
  - 记账：`duplicateCanvas` 不拷贝组/归属 = M18 既有行为（非本批回归），勘察留痕；批 2 临时实弹数据（UI 实弹画布 16 + 分支画布 17）已软删 + purge 清理；批 3 实弹 / e2e 临时数据（测试画布 C18/C19/C20 软删 + purge，抽帧节点与复制节点已删，回收站终态为空）

## M23 注记（2026-09-16 立项：画布规模化与智能编排）

- 性质：M18 §8 剩余 3 项（力导向 / LLM 建议式编排 / 规模化性能）+ M15 §8 四项（全景图 / 批次聚合 / 画布内编辑 / 设计态编排）合一；纲领 §一 D9–D11 + E 组归宿；设计见 `2026-09-16-agencys-content-studio-m23-design.md`
- 决策留痕（2026-09-16 用户拍板四项）：①规模化性能 = **虚拟化 + 自动化基准**（视口裁剪渲染 + 300/600/1000 节点量测报告落 review）②力导向 = **引入 d3-force 轻量库**（破零依赖惯例；spec §5 登记例外原则：成熟纯算法库（无 IO / 无框架语义）经拍板论证可引，UI 框架 / 网络 / 重型引擎仍零容忍）③全景图/批次聚合 = **画布页新增「全景」tab**（运行画布 / 模板画布 / 全景三态；批次分组 + 卡片钻取）④画布写面 = **允许落盘新模板文件**（设计态编辑 → 新 key 落盘；不覆盖原文件 + 冲突后缀避让 + validate 先行）
- 范围（三批 7 项）：批 1 ①规模化性能（虚拟化 + 基准）②力导向（computeArrange +force）；批 2 ③跨 run/跨模板全景图 ④批次聚合（含端点 `GET /canvas/overview`）⑤画布内编辑（模板态限 title + inputs 文本字段）；批 3 ⑥设计态编排（拖拽连线 → YAML 草案 / 落盘新模板）⑦LLM 建议式编排（创作画布 AI 建议，仅展示 + 定位）
- 红线复核（预核）：**无新表 / 无新列**；生成主链零改动；LLM 不自动执行（计费安全；纲领 §五「LLM 编排分层」M23 建议式 ≠ M27 执行式）；落盘安全（新 key 永不覆盖 + 原文件字节级零变化断言）；虚拟化保真（框选/全选/键盘仍全量几何）；新增依赖仅 `d3-force` + `@types/d3-force`（例外原则登记）；端点 +4 枚 / 提示词 +1（`canvas-advice.md`）
- 明确排除（见 spec §8）：data 边编辑 / 节点增删 / 运行画布写面（含产物资产编辑）/ 模板覆盖保存 / LLM 自动执行与一键应用 / 力导向实时预览动画 / 组框级虚拟化 / 虚拟列表库
- 当前状态（2026-09-16）：**已收官**——P0–P4 全绿：三批 7 项一次交付（探针六节 **92 项断言**〔force 13 / serialize 13 / edit 27 / overview 15 / advice 18 / bench 6〕 + 回归 m2a–m22 **19 探针零适配全绿**〔收口期 m18 修复后复跑 248 / m22 复跑 169〕 + 双端 tsc / vue-tsc 绿 + 实弹全链〔虚拟化三重 DOM 断言 + 力导向落库 + 全景/编辑 e2e 双场景 + E2E-1 落盘 fs 对照 + E2E-2 真实 LLM 建议〕）；收口期跨里程碑最小修复 1 项（m18 抽帧回退分类：ffmpeg 解析翻转暴露，见 review P4-a）；review 落盘 `2026-09-16-agencys-content-studio-m23-review.md`
  - 批 1（①规模化性能 + ②力导向）：前端视口裁剪虚拟化 + 服务端/浏览器双基准（300/600/1000 = 8.2/17.4/25.1 ms；DOM 恒 42；平移稳态 ~17.5 ms/帧；heap 20.6 MB）+ `computeArrange` 第三模式（d3-force 确定性迭代）；实弹三重断言 42→300→157 + 按钮重排落库
  - 批 2（③全景图 + ④批次聚合 + ⑤画布内编辑）：`GET /canvas/overview`（toBatchView 同构复用）+ 画布页三态 tab + `use-canvas-edit` 覆盖最小化 + drawer 编辑区；e2e 场景 A（全景 7 断言）/ 场景 B（编辑 11 断言）全过
  - 批 3（⑥设计态编排 + ⑦LLM 建议式编排）：edit-draft / edit-save（白名单 + 新 key + 后缀避让 + 原文件零触碰）+ 拖拽连线·删边 + `POST /canvases/:id/advice`（提示词 + 用量留痕）；E2E-1 原文件 SHA256 零变化 / E2E-2 7 条建议 + 定位全过
  - 记账：e2e 模板 `series-setup-e2e.yaml` 报告后删除（模板目录 11 个恢复原状）；P1 实弹临时项目 15/16 purge；探针临时库自清理
  - 红线记账（2026-09-16 复扫；用户决策：**登记待拆、不做即时重构**）：M28「单文件 ≤800 行」红线本轮新增破线 2——`views/canvas/index.vue`（`68d46c1` 单提交 722 → 1172；P2 三态 tab/编辑控件 + P3 草案/保存 modal/toast 接线）与 `components/pipeline-canvas/CanvasBoard.vue`（同提交 656 → 855；P3 编辑模式）；登记**「触发条件式待拆」**（拆分时机 = M26 工程批〔H2 残余〕或 canvas 域下一次实质触碰；范式对齐 M28——thin `index.vue` + `use-*.ts` + 面板组件）；`lib/api.ts` 增至 969（存量豁免内，随 api 域拆分）；全仓复扫 >800 共 9（应用代码 4 + 探针 5〔m16–m19 / m22，归 M26-H5〕）；复扫脚本留档 `.qoder/tmp-m28-scan800.mjs`

## M24 注记（2026-09-16 立项：内容质量与国际化）

- 性质：F 组五项合一——M18 后评审（多语言出海 / 合规缺失）+ M3 review Backlog（一致性 A/B 评测）+ M4 review 局限转 Backlog（三层记忆 / 摘要压缩）；纲领 §一 F1–F5 归宿；设计见 `2026-09-16-agencys-content-studio-m24-design.md`
- 范围（三批 5 项，纲领拟定）：批 1 ①三层记忆 / 摘要压缩（项目/剧/章三级摘要层，长链上下文压缩）②一致性 A/B 评测（记忆/参考图对产出提升的统计评测）；批 2 ③翻译链（ai_text 提示词/契约复用 + platform-adapt 国际化扩展 + 多语言资产命名规范）④多语言字幕/配音链（双语 SRT + 多语言 TTS 音色映射）；批 3 ⑤内容合规审核（本地敏感词库 + LLM 可选通道双轨 + 闸门集成 + 产物审核标记，宽容降级）
- 依赖现状勘察（2026-09-16 七项）：①记忆服务 = memories 表两层 scope（project/global）+ 开放 type + 向量召回；memory_write/recall 在 8/11 模板成「recall→生成→remember」闭环，**摘要层级缺失**；②series/episodes（M14）= 剧→集两级实体在位，**章级摘要载体待论证**；③评测基建 = image-check 仅有效性（黑图/纯色/损坏），batches 支持多输入组对照运行，**评分矩阵全缺**；④翻译链 = 全库 translat 零命中，ai_text prompt_tpl + 契约校验机制成熟（**全新面**）；⑤字幕链 = measured/estimated 双模式单语 SRT（M22 纯函数族在位），**双语形态缺失**；⑥TTS = 实例级默认音色 + 情绪透传（E4），**语言→音色映射缺失**；⑦合规 = 零命中；gate 机制成熟（platform-adapt 风险标注 + required 审阅先例可依）
- 红线初核：优先无新表 / 无新列（摘要层以 memories 开放 type 承载；合规标记落 assets params）；新增 action 走 loader 白名单 + 白名单纪律；摘要层为通用表扩展（无体裁专属表）；合规词库为本地数据文件（不引入外部服务依赖）；LLM 审核可选通道 + 宽容降级（不可用不阻断）
- 决策留痕（2026-09-16 用户拍板四项）：①摘要层触发 = **双形态**（显式 memory_summary action + settings 级可选自动钩子，默认关；onRunSettled 隔离挂点）②一致性评测 = **图像角色一致性为主**（对照 batch 提交 + 多模态 LLM 评分矩阵 + 报告供人工复核）③翻译链 = **双形态并存**（platform-adapt 扩 target_lang v2 + 独立 translate-export 模板链 + 多语言命名规范）④合规 = **独立 action + 产物标记**（本地词库 + LLM 可选复审双轨；标记落 assets params；宽容降级）；设计见 `2026-09-16-agencys-content-studio-m24-design.md`
- 当前状态（2026-09-16）：**已收官**——P0–P4 全绿：三批 5 项一次交付（探针五节 **116 项断言**〔summary 32 / eval 27 / translate 9 / bilingual 14 / compliance 34〕 + 回归 m2a–m23 **21 探针零适配全绿** + 双端 tsc / vue-tsc 绿 + 三层实弹〔HTTP 63 断言（P1 29 + P2 22 + P3 12，真实 LLM/出图/多模态评分/TTS 通道全触达）+ 浏览器徽章双态 DOM 验证〕）；实弹抓出并修复 1 处真 bug（tts lang 读 ctx.input 错置→run.input 回落，见 review P2-a）；review 落盘 `2026-09-16-agencys-content-studio-m24-review.md`
  - 批 1（①三层记忆/摘要双形态 + ②一致性评测）：memory_summary action（四级 scope 命名 + merge + 900 字 guard）+ settings 自动钩子（默认关，防双份计费）+ recall types 过滤 + `POST /evals/run|score`（2–6 组 × ≤24 图多模态评分矩阵 + md/CSV 报告落库）；实弹 29 断言（合并保 id 20→20 + 真实出图对照评分）
  - 批 2（③翻译双形态 + ④双语字幕/配音）：platform-adapt v2 target_lang（zh 回归逐字不变 + en 实弹）+ translate-export 模板链（`translated-{lang}.md` 命名 + type=translation 沉淀）+ buildBilingualSrt（both/merged + 缺失回退）+ TTS voice_map 七级；实弹 22 断言含真实 TTS voice_map 命中
  - 批 3（⑤合规审核）：compliance_check action（本地词库 + LLM 可选复审双轨 + on_block fail/mark 双语义 + 标记落 params.compliance 零新列 + 报告 compliance_report）+ `GET /compliance/rules` + 前端预览徽章三态（comp-pass/warn/block）；实弹 12 断言（真实词库拦截 run failed + 干净文本 LLM 复审放行）+ 浏览器双态截图
  - 记账：P1–P3 临时项目 12 个软删归档 + 3 个 e2e 临时模板用毕即删（模板目录恢复原状）；词库为小型基准表（55 词，免责声明在位，业务扩充按平台自建）；红线守住——零新表零新列、引擎/DAG/模板加载签名零触碰

## M25 注记（2026-09-17 立项：输入源扩展——小说链 + 视频）

- 性质：M9 §1.3 排除项 8 项（G1–G8）+ roadmap Backlog「视频长素材导入与内容解析（huobao extraction 再评估）」（G9）+ M18 后评审「视频反推链」（G10）；纲领 §一 G 组十项归宿；设计见 `2026-09-17-agencys-content-studio-m25-design.md`
- 范围（三批 10 项，纲领拟定）：批 1 ①docx/epub 导入（解析依赖引入需论证）②章节可视化编辑器（对齐 M10 大编辑器先例）；批 2 ③事件图谱可视化（G3，复用 M23 d3-force 成果）④改编一致性回查（剧本 vs 原作 LLM 审计 + 差异报告）⑤事件级编辑 ⑥多部小说同链合并 ⑦自动连载/增量导入；批 3 ⑧小说源抓取（⚠ 纲领 §五待决策项）⑨视频长素材导入与内容解析（抽帧 + 视觉理解 + 时间轴标注）⑩视频反推链（文案/分镜反推，产出直接入管线）
- 依赖现状勘察（2026-09-17 七项）：①M9 小说链在位——novel-adapt 全链（ingest→text_split 三级正则→逐章事件→图谱归并→分集规划→逐集剧本，三门控）+ chapters/events/graph/plan 四 purpose + NovelBoard.vue 只读看板 + `GET /runs/:id/novel-board` 聚合读；**导入 accept 仅 [.txt,.md]**；②文档解析依赖零（无 mammoth/jszip/adm-zip）——G1 全新面，M9 时期因依赖未做；③内容写面缺口——`PATCH /assets/:id` 仅 name/is_favorite/tags，**无资产内容写端点**（G2/G5 共同前置；M23 受控写回 + 脏确认先例可依）；④力导向基建——d3-force 已在 apps/server（M23 `computeArrange` 确定性 tick），G3 可同构复用（服务端布局 + 前端 SVG）；⑤视频解析基建——抽帧 `frame.ts`（M18 单帧 + M22 uniform 2–9 帧 + seek 降级梯度）+ 多模态通道（M13 风格词 / M24 eval 评分，image_url dataURI）在位；**ASR/转写通道零**（whisper/OCR 零命中，音轨反推受限）；⑥视频上传已可走 `POST /projects/:id/imports`（任意 multipart + sha256 去重）；⑦G8 小说源抓取 = 纲领 §五待决策项（M5 曾以「联网采集以素材导入替代」排除，版权/反爬/本地单机定位风险需重新论证）
- 红线初核：产物以通用资产承载（无体裁专属表）；章节/事件编辑走受控写回（对齐 M23 写面纪律）；解析依赖引入需拍板论证（M23 d3-force 例外原则：纯算法/解析库经论证可引，UI 框架/重型引擎零容忍）；反推产出不自动级联执行（计费安全）
- 决策留痕（2026-09-17 用户拍板四项）：①G1 文档解析 = **引入轻量解析库**（mammoth docx + fflate epub；沿 M23 例外原则）②G8 小说源抓取 = **轻量通用抓取**（单端点 URL→正文资产，无站点适配/无批量/手动触发，SSRF 守卫；纲领 §五待决策状态解除）③G9/G10 视频 = **全链含音频转写**（video_analyze action + video-reverse 模板 + ASR 通道走 audio 实例 OpenAI 兼容 /audio/transcriptions，SiliconFlow SenseVoice 实测，不可用降级）④批次 = **纲领三批全十项**（P1 导入+编辑器 / P2 图谱+回查+事件编辑+合并+连载 / P3 抓取+视频解析+反推）
- 建议验收方向：导入链对账（docx/epub→章节切分对照）；编辑器 DOM；图谱渲染 DOM；回查矩阵；增量导入幂等；合并链断言；反推产出目检 + 入管线可用性（真实视频实弹）
- 当前状态（2026-09-17）：**已收官**——P0–P4 全绿：三批 10 项一次交付（探针八节 **141 项断言全绿**〔docparse / content-write / graph-layout / audit / merge / append / fetch / analyze〕 + 回归 m2a–m24 **22 探针**（**21 零适配 + m9 一处 version 同步**，因 novel-adapt v2 主动升版 P4-a）+ 双端 tsc / vue-tsc exit=0 + 三层实弹〔P1 22 + P2 25（含真实 LLM 审计双链）+ P3 ~30（真实公网抓取 + 真实 TTS 造口播样本→真实 ASR 命中 hasTranscript=true + 多模态时间轴 + storyboard-json 直通 8 镜）〕+ 浏览器图谱/编辑器/抓取 modal）；review 落盘 `2026-09-17-agencys-content-studio-m25-review.md`
  - 批 1（①docx/epub 导入 + ②章节编辑器）：doc-parse 服务（mammoth docx + fflate epub 自解析 spine）+ importFiles 单点转 md（params.doc_import，原二进制不落盘 v1）+ novel-adapt v2 accept 扩四扩展名（向后兼容）+ `PATCH /assets/:id/content` 受控写（purpose 白名单 + JSON 契约 + 原子写 + content_edits 计数零新列）+ NovelBoard/预览器章节编辑器
  - 批 2（③图谱 + ④回查 + ⑤事件编辑 + ⑥合并 + ⑦增量）：computeGraphLayout d3-force 确定性布局（服务端算前端零计算）+ novel-board 附 graph.layout + 前端 SVG 视图；adapt_audit action + novel-audit 模板（不强制注入现链）；事件/图谱结构化表单复用 content 写端点；text_split per_source 逐书续编（false 逐字回归锚）；POST /novel/append 幂等增量（不自动级联重跑，引擎状态机零触碰）
  - 批 3（⑧URL 抓取 + ⑨视频解析含 ASR + ⑩反推链）：fetch-source 端点（SSRF 守卫 + FetchGuardError 码→502/400）+ 素材页抓取 modal（版权免责内置）；asr 服务（audio 实例 OpenAI 兼容 /audio/transcriptions，SenseVoice 实测，不可用宽容降级）+ video_analyze action（抽帧≤24 缩宽 768 临时不落库 + 抽轨 ASR + 多模态时间轴 JSON 契约 + video_analysis json/md 双资产）+ video-reverse 模板（analyze→storyboard[gate]→copy）
  - 记账：P1–P3 临时项目 + 崩溃/手动遗留逐个 purge；phantom 项目孤儿资产硬删；临时探测/e2e 脚本用毕即删；用户库仅存 id=14（未触碰）；红线守住——零新表零新列（doc_import/fetched/content_edits/analysis/audit 全 params 承载）、引擎/DAG/模板加载签名零触碰（KNOWN_ACTIONS 加法 +2）；novel-adapt v2 为唯一历史探针触发面

## M26 注记（2026-09-17 立项：工程基建与平台化）

- 性质：M18 后评审工程侧集群（纲领 §一 H 组）+ roadmap Backlog（Ollama）+ m18-review 偏差 #3（提交治理）+ M14 §8（在线可编程供应商）+ **M28 遗留 ≤800 红线残余收口**；设计见 `2026-09-17-agencys-content-studio-m26-design.md`
- 范围校准：**H2 巨型文件拆分已 2026-09-15 转入 M28 独立收官**；本里程碑 = H1 CI + H3 压测基准 + H4 Ollama + H5 探针治理 + H6 提交治理 + H7 在线可编程供应商（待决策）+ ≤800 残余全量拆分
- 决策留痕（2026-09-17 用户拍板四项）：① CI = **本地统一 runner + Git 钩子**（仓库在 Gitee，GitHub Actions 假设不成立；`ci:check` 聚合 + `.githooks/pre-push`，零外部 CI、零运行时影响）② 探针治理 + 压测 = **统一 runner（并行/计时/汇总/fail-fast）+ 拆分 5 枚 >800 探针（m16/17/18/19/22）+ 数据量级压测基准脚本**③ 供应商 = **Ollama 一等 provider seed（仅 LLM，零适配器代码）+ H7 关闭登记**（既有自定义 OpenAI 兼容网关已等价覆盖；运行时可编程协议脚本沙箱永久排除）④ 红线 = **全量拆分 5 个 >800 前端文件**（canvas/index.vue 1172 / NovelBoard.vue 1099〔M25 新破线首次登记〕/ BrandSettings 1051 / api.ts 975 / CanvasBoard 855，M28 式纯重构 + 探针/typecheck/build 背书）；H6 仅 spec 固化「提交前置门禁」成文规则、m18 偏差 #3 关闭，无代码
- 红线初核：零产品行为变更（探针/文件拆分前后断言面与行为逐字不变，全量探针 + 双端 typecheck + vite build 三重背书）；零外部依赖 / 零运行时影响（CI 为本地脚本+钩子，runner/压测仅在 scripts/，src 零新增依赖）；不新增架构（Ollama 复用既有 llm OpenAI 兼容链仅 +2 seed 行；embedding 维持本地 ONNX，provider 化 = 架构新增排除）；零新表零新列
- 明确排除（见 spec §8）：CI 外部平台（Gitee Go/GitHub Actions/镜像双推）/ Ollama embedding 与 image/video/audio（仅 LLM）/ 运行时可编程协议脚本（永久排除）/ 历史探针统一迁移 probe-lib（仅新拆 5 枚接入）/ 压测报告版本化趋势基线库
- 当前状态（2026-09-17）：**已交付（P0–P4 全批次收官）**
  - **P0 基建** ✓：`probe-lib.ts`（isolatedEnv/makeChecker/runSections）+ `run-probes.ts` 骨架 + `validate-templates.ts` 骨架 + `ci:check` 挂接 + `ollama_llm` seed（+2 行，零适配器）+ `probe-m26.ts` 骨架 + `.githooks/pre-push`
  - **P1 CI + 探针治理** ✓：runner 实装（并行池/计时/PASS·FAIL 汇总/fail-fast）+ 5 枚大探针零漂移拆分（m16 131 / m17 274 / m18 248 / m19 378 / m22 169 断言前后逐枚相等）+ `validate-templates` 实装（14 模板 / 101 步 / 0 错）
  - **P2 压测基准** ✓：`bench-stress.ts`（`seedDataset`/`percentile` 纯函数 + 5 量测面 + 基准报告落 review，非阻断、隔离临时库自清理）+ probe-m26 `stress` 节小样本背书
  - **P3 ≤800 红线全量拆分** ✓：5 个前端 >800 文件 M28 式纯重构（`lib/api.ts`→`lib/api/` 7 域 + index re-export / `CanvasBoard.vue` 855→722 / `BrandSettings.vue` 1051→776 / `NovelBoard.vue` 1099→611 + `NovelGraphView.vue` 572 / `views/canvas/index.vue` 1172→774 + design/realtime composables + Guide/Modals 子组件），浏览器抽查 6 路由 0 console error 无回归
  - **P4 回归收口** ✓：全仓 `scripts` + `web/src` 复扫 **>800 = 0**（probe-m26 `split-audit` 门禁由 interim `<=10` 收紧为 `=== 0`）；`pnpm ci:check` 端到端 exit=0（双端 typecheck + 模板校验 + `probe:ci` **23 探针 / 2873 断言全绿**）；vite build 绿；roadmap/README/纲领 校准
- 交付物：新增 `probe-lib.ts`/`run-probes.ts`/`validate-templates.ts`/`bench-stress.ts`/`probe-m26.ts`/`probes/m{16,17,18,19,22}/*.ts`/`lib/api/*`/canvas·novel·brand 拆分产物/`.githooks/pre-push`；改 `db/seed.ts`（+2）/root+server `package.json`（ci:check/probe:all/probe:ci/validate:templates/bench）/5 前端文件/README/纲领（H7 关闭 + 运行时可编程排除）/本 roadmap。引擎/DAG/模板加载/schema/适配器/package 依赖 **零 diff**

## M27 注记（2026-09-17 立项：自动编排——真 orchestrator）

- 性质：纲领 §一 I 组（I1 跨模板自动串链 / I2 模板嵌套 / I3 编排可视化）；M5 注记「自动编排待单独立项」的正主；设计见 `2026-09-17-agencys-content-studio-m27-design.md`
- 决策留痕（2026-09-17 用户拍板四项，全选推荐）：① 串链自动化 = **自动级联 + 逐链开关 + 预算闸门**（`autoAdvance` 默认关；run 完成经 `onRunSettled` 钩子触发下一段，每跳前 `checkBudget` + 链 `budgetCap`）② I2 模板嵌套 = **收窄为编排层引用（克隆复用），不碰引擎**（无 `run_template` 递归 action；loader/引擎零改）③ I3 可视化 = **扩展 `buildCanvasOverview` 全景 tab「编排链」区** ④ 持久化 = **新增 1 张 `workflows` 表 + `pipelineRuns` +2 可空列**（`workflow_id`/`workflow_seq`，`ensureColumn` 幂等），链进度由关联 run 派生
- 范围（三批）：P0 数据层 + 骨架（`workflows` 表 + 2 列 + `lib/types` Workflow + `routes/workflows.ts` CRUD + `services/workflow.ts` 骨架 + `probe-m27.ts` 骨架）；P1 串链执行引擎（`resolveSegmentInput`/`validateWorkflowChainDoc` 纯函数 + `advanceWorkflow` 实装〔级联 + 预算闸门 + 失败暂停 + 幂等互斥〕+ start/pause/resume + events +4 变体 + clone）；P2 全景可视化（overview +workflows + `workflowApi` + OverviewPanel 编排链区 + 链构建器 Modal）；P3 实弹 + 收口
- 红线复核（预核）：不碰引擎/DAG/loader（`KNOWN_ACTIONS` 零增）/refs/适配器/schema 既有列（仅 +2 可空列）；复用 M4 `onRunSettled` 钩子 + `createRunRow`/`engine.startRun` + M20 `checkBudget` + M5 `template.next`；计费安全（`autoAdvance` 默认关 + 预算闸门 + 失败不自动重试）；零新依赖；无重型编排引擎。§五「LLM 编排分层」就此落定（M23 建议式不执行 / M27 执行式静态段序列）
- 明确排除（见 spec §8）：运行时深度嵌套（step 内跑子模板 DAG）/ 重型引擎 / LLM 决策式链推进 / 剧集专属编排表 / recurring cron / 链并行 fan-out / 自动重试
- 交付物：新增 `services/workflow.ts`/`routes/workflows.ts`/`scripts/probe-m27.ts`；前端 `lib/api/workflows.ts`/`lib/types/workflow.ts`/全景 `workflows-section.vue`+`chain-builder.vue`；改 `db/schema.ts`（+workflows 表 +pipelineRuns 2 可空列）/`db/index.ts`（ensureTable/Column）/`app.ts`·`index.ts`（路由挂载 + `onRunSettled(advanceWorkflow)` 并列钩子）/`run-create.ts`（workflowId/Seq）/`events.ts`（+4 变体）/`services/canvas-overview.ts`（+workflows 聚合）/`lib/types/pipeline-canvas.ts`·`format.ts`·`api/index.ts`·`types/index.ts`·`overview/index.vue`·`views/canvas/index.vue`/README/纲领/本 roadmap。引擎/DAG/loader/refs/schema 既有列 **零 diff**（仅 +2 可空列）
- 当前状态（2026-09-17）：**已收官**——P0–P3 全绿：数据层（workflows 表 + 2 可空列 + CRUD）/ 串链执行引擎（resolveSegmentInput/validateWorkflowChainDoc 纯函数 + advanceWorkflow 九步实装〔级联 + 预算闸门 + 失败暂停 + 幂等互斥〕+ start/pause/resume + clone）/ 全景可视化（overview +workflows 聚合 + workflowApi + 编排链区 + 链构建器）/ 实弹收口。`pnpm ci:check` 端到端 exit=0（双端 typecheck + 模板校验 14/101/0 错 0 警 + `probe:ci` **24 探针 / 2919 断言全绿**含 probe-m27 **46 断言九节**）；`vite build` 绿；HTTP 契约冒烟（建链/PATCH/克隆/overview 派生/删除）通过。CodeReview 收口期发现 1 High（resume 死锁）+ 2 Medium（startWorkflow 并发双启动计费 / pause TOCTOU），**已全部修复**（advancing 互斥锁贯通 start/advance + 落库前状态复核 + 下游 seq 幂等守卫 + resumeWorkflow 重驱动）并新增 `recovery-guard` 探针回归；复审确认**可收口**。review 落盘 `2026-09-17-agencys-content-studio-m27-review.md`；M19–M27 全量立项纲领就此**战略收官**（后续提升需求见下节 post-M27 backlog）

## M27 收官后的提升需求（2026-09-17 对比沉淀，待后续立项）

- 用户要求：根据本轮 ACS / Toonflow 源码对比整理提升方向，**待 M27 计划开发完成后再继续开发**；本轮仅归档，不改应用代码、不启动新 L1、不改变 M19–M27 排期。
- 清单入口：[ACS 在 M27 完成后的提升清单](2026-09-17-agencys-content-studio-post-m27-backlog.md)（L0.5，R01–R09 含现状、增量目标、依赖、验收方向与排除项）。
- 建议优先级：P0 = R01 连载质量/成本基线、R02 内容与参考版本/影响追踪、R03 长篇叙事连续性、R04 视觉一致性控制；P1 = R05 多阶段质量检查、R06 有限定向返修、R07 对话式专业协作、R08 视频音画字精细联动；P2 = R09 画布/流水线/镜头工作台衔接。
- 建议顺序：测量与版本基础 → 连载与成片品质 → 质量/受控返修 → 统一协作体验；优先级为建议、全部需求保留去向，不代表已拍板实现方案或工期。
- 去重约束：跨模板串链/子模板/编排可视化仍归 M27；先按 M27 实际交付销账再立项。已实现的参考图、向量记忆、分镜、配音字幕、画布、事件图谱等不重建；不恢复运行时可编程供应商脚本等永久排除项。
- 编号约束：**M28 已用于巨型文件重构并收官，不复用**；新编号在后续开工前按最新 roadmap 分配。继续执行「需求勘察 → 用户拍板 → 单个 L1 spec → 实施/验证 → 验收复盘 → roadmap 校准」。

## M29 注记（2026-09-18 立项并收官：R02 内容/参考版本与下游影响追踪）

- 性质：post-M27 backlog **首个立项交付**——第一组「测量与可追溯基础」的 R02（P0）；把「保存历史、记录真实输入、展示影响、按需锁定」做成同一条版本追踪链。需求来源 `2026-09-17-agencys-content-studio-post-m27-backlog.md` §3 R02；设计见 `2026-09-18-agencys-content-studio-m29-design.md`
- 三条不变式（验收红线）：① **执行冻结真实输入**（每次生成/合成记实际消费的资产/实体版本与 used/skipped，不以事后可变数据冒充旧快照）② **编辑不静默改写下游**（影响只报告清单/原因，绝不自动生成/返修/重渲染）③ **还原版本 / 锁定输入 / 采用历史产物三操作严格分离**
- 范围（P0–P4 单 L1）：P0 数据层三张通用表（`content_versions`/`exec_snapshots`/`exec_inputs`，纯加法）+ 项目 `versions/` 不可变文件 + `services/provenance.ts` 骨架 + 前端类型 + `probe-m29.ts`；P1 文本编辑与实体全写入口版本捕获 + 乐观并发（`expectedRevision`→409）+ embedding 失效 + `restore*Version` + `routes/versions.ts`；P2 五类执行消费点（pipeline 文本/出图/合成 + 画布 gen + M27 `$prev.text`）经 `safeRecordExecSnapshot` 旁路记实际输入版本与 used/skipped + `downstreamImpact` 只报告 + gen 节点 `spec.pin` 锁版；P3 前端「历史·影响」面板（文本预览器抽屉 + 画布实体折叠区）与 gen 锁版控件 + GC/purge/缓存一致性收线；P4 全量回归 + vite build + review + roadmap 校准
- 决策留痕：仅三张表、锁版落 gen 节点既有 `spec.pin`（`Record<上游nodeId,资产id>`）不建第四张锁表；媒体不可变即身份（`exec_inputs.versionId=NULL`，下游标 `no_history` 不伪造版本链），仅文本资产与实体建 `content_versions`；工作副本仍同 relPath 覆写（保 M25 探针 + 固定 file URL），版本走独立不可变文件；可编辑文本 file 路由 `no-store` 收线（`{asset}` 包裹体合同不变）
- 红线复核：`schema.ts` +77/-0、`db/index.ts` +62/-0 **纯加法**（CREATE TABLE IF NOT EXISTS 旧库兜底，既有表列逐字未动、无第四张表）；`engine.ts`/`dag.ts`/`loader.ts`（`KNOWN_ACTIONS` 零增）/`refs.ts`/适配器/**零 diff**——全部追溯集成为消费点旁路记录，不改调度/加载/计费；`safeRecordExecSnapshot` 一律 try/catch 仅告警（**零行为变更**）；复用既有 assets/characters/canvas/gen_tasks 逻辑 ID 与旧接口；**零新依赖**；本期**零新增模型费用**（probe-m29 走 `isolatedEnv('m29')` 独立临时库 + 离线模板，无付费 LLM/图/视频/TTS）
- 明确排除（见 spec §9）：自动生成/返修/重渲染、撤销外部费用、运行时可编程供应商脚本、短剧专属模型/表、并行调度引擎、把「开始开发」当付费实弹授权；R01、R03–R09 保留去向不预写 L1
- 当前状态（2026-09-18）：**已收官**——P0–P4 全绿：三表 + 不可变文件 + 文本/实体版本捕获还原 + 五类执行快照 + 影响分析 + 锁版三操作分离 + 前端面板/控件接线 + GC/purge/缓存收线。门禁全绿：`pnpm -r typecheck` / `vue-tsc` / `vite build` exit 0；`validate:templates` 14 模板 / 101 步 / 0 错 0 警；`probe:ci` **25 探针 / 2965 断言全绿**（含 probe-m29 **46 断言八节**：schema/capture/restore/concurrency/input-snapshot/impact/lock/gc-purge）；M25「同 relPath 覆写」断言未回归（工作副本语义不变）。review 落盘 `2026-09-18-agencys-content-studio-m29-review.md`；backlog R02 就此销账（已立项为 M29 并交付），R01、R03–R09 保留待后续按「启动门槛」复核再立项

## 轻松创作优化立项队列（2026-09-30 立项；M56 已实施，其余待评审）

> 来源：用户反馈「轻松创作太不智能、使用过于局限，连载短剧撞天花板无出路」。经源码全量复核（M45/M46 已把品牌贯通、字幕开关、角色/风格预设入口、BGM 端到端做进轻松创作；`prev_script` 跨集承接已在专业链），下列为**真实剩余缺口**。
> **编号修正**：本批立项时曾误编 `M48..M52`，与**已交付里程碑**（M48 统一取消/续跑/预算、M50 剪辑工程交换包、M52 全局素材池……直至 M55）冲突；开工前按最新 roadmap 复核（现有探针最高 `probe-m55`），整体改用 **`M56..M60`**（`docs/records/M56..M60-*.md`）。
> 用户授权「全部立项 + 要 AI 自我分析方向对不对/有无更好的/专业度还缺什么」，故本批不仅照搬用户四方向，含 AI 复盘重构与新增专业缺口（见各 spec 背景节）。

- **M56 轻松创作「毕业通道」**（吸收用户方向①桥接+④连载）：`P0`。**已实施并门禁全绿（2026-09-30）**。现状根因=轻松创作与专业链两座孤岛无桥；story 项目 templateKey 已派生 `mengbao-episode` 但执行永远只跑 `easy-dialogue`。**实施机制（原 spec「skip write_script + approved_script + v12→v13」经实证不成立，已废弃）**=结果卡独立 opt-in「本集升级为专业成片」（1a：`POST /creation-sessions/:id/graduate {mode:episode}` 建 `mengbao-episode` **queued** run、批准剧本经既有 `setting_docs` 强锚定）/「立项为连载系列」（1b：`{mode:series}` 建 `series-setup` queued run、经既有 `plan_doc` 喂入）；**不自动 start、零计费、`mengbao-episode` v14 / `series-setup` v3 一字未改**。红线：不在 confirm 自动切模板、0 新表 0 新列 0 新 action 0 新付费面 0 模板改造。门禁：`tsc`/`vue-tsc` exit 0；`probe-m56` 33 断言五节全绿；全量 `probe:ci` 无回归。
- **M57 意图驱动智能载体路由**（AI 复盘新增，呼应用户最初「应智能选模板」心智）：`P1`。现状=`template-recommend` 语义匹配与轻松创作双向隔离。方案=意图分类→**建议**载体（越界才荐专业链/M56），Tier B 建议+预览，默认仍落 easy-*，绝不自动改模板；0 新表 0 新 action。**待评审、未实施**。
- **M58 参考反推可检视交付**（用户方向②）：`P1`。现状=视频参考已消费（video_analyze）但只进上下文不可见、不产出可编辑分镜。方案=2b 透出「参考解析」产物（近零逻辑）+ 2a 反推 storyboard 作 shots 初稿；0 新表 0 新 action；不臆造参考里没有的信息。**待评审、未实施**。
- **M59 单条时长/镜头上限有节制放宽**（用户方向③）：`P2`（收益有限、有截断/收口风险）。方案=60→90s、12→16 镜、lines 36→48，单镜 caps 上限不动；**必须一次收口 contract/clamp/buildCapsConstraintMessage/creation-plan.md 四处**（已核到行），plan 截断上限连带评估。真正长内容归 M56。**待评审、未实施**。
- **M60 短剧商业化结构设计**（AI 复盘新增——专业级短剧与「能出片」的分水岭，全仓零命中）：`P1`。缺口=无付费卡点/前3秒钩子/留人节奏/黄金N集结构。方案=series-setup 分集地图上新增 `monetization-json` 设计步 + 注入 script-ep/storyboard-ep 与 creation-plan.md；0 新表 0 新 action 0 新付费面；**需产品先定口径**（阈值可配置不写死）。**待评审、未实施**。
- 未立项保留（Ask-first）：**口型同步 lip-sync**——需专门付费模型面，M31 已列为永久排除，保持 Ask 不自动纳入；**多集批量排期编排**——接 M27 orchestrator，非新增能力。

## 校准规则

1. 每里程碑结束写 review 记录：与 L1 spec 的 exit criteria 逐条对照 → 回写本文档（阶段描述 / 红线 / 不变式）
2. 新需求先对北极星三问：服务创作闭环？可模板化？通用资产能承载？任一为否 → 拒绝或入 backlog，不进任何 spec
3. 同一时间只存在一个 L1 里程碑详细 spec（M2 的 spec 在 M1 review 之后才允许开工撰写）

## Backlog（未定稿需求登记处）

> 2026-09-14：本清单存量项已**全部立项**（用户决策「不是挑几项而是全部立项」），去向见上文「M19+ 全量立项」节与纲领「缺口全景对照表」；本清单保留为历史决策留痕。

- 视频长素材导入与内容解析（huobao extraction 再评估）
- 平台内批量成本统计与 provider 用量
- 工作台键盘流 / 多开任务并行上限
- 本地模型（Ollama）接入（适配层 service_type 已预留，不新增架构）
- 跨模板自动串链编排（真 orchestrator）：M5 注记「内容编排（模板选择+批次+项目页已等价）」被实际使用体感修正；本轮以场景入口 + 完成态接力（模板 `scene`/`next` 元数据）缓解，自动编排待单独立项
- P2 小缺口集群（2026-09-12 对标沉淀，按需启动）：BGM / 音效、转场特效、图像检测（Toonflow）、旧版本清理与收藏、集级参数（已由 M14 落地）、桌面端应用（M14 决策取消——本地单机 Web 定位，见 M14 注记）、剧集实体（剧集/集数落库；已由 M14 落地）；镜头重排与可视化编辑器已由 M10 落地（见 M10 注记）；BGM 与转场已由 M11 落地（音效 per-shot 留后续，见 M11 注记）
- 镜头链扩展候选（2026-09-12 M7 排除项移入）：上传图片替换分镜（外来图入镜；已由 M10 落地）、引擎级单步重跑接口（现统一走「重置 + startRun」，引擎零改动；已由 M11 落地）、镜头级音字重对齐（SRT 与配音轨成对产出；静态路径 fit_voice 均分自动适配；已由 M11 落地）；旧版本清理与收藏 / 图像检测 见上方 P2 集群（M12 批）
- 素材链扩展候选（2026-09-12 M8 排除项移入）：从参考图提取风格词（已由 M13 落地）、风格预设多选组合叠加（已由 M13 落地）、视频侧场景/道具参考图注入（已由 M13 落地）、素材参考图上传通道（已由 M13 落地）、素材页批量生成/润色交互（批量润色已由 M13 落地；批量生成未做）、states 变体入库（已由 M13 落地；变体出图注入留后续）
- 小说链扩展候选（2026-09-12 M9 排除项移入）：docx/epub 导入（需文档解析依赖）、章节可视化编辑器、事件图谱力导向图、多部小说同链合并、自动连载/增量导入、小说源抓取、改编一致性回查（剧本 vs 原作审计）、事件级编辑
