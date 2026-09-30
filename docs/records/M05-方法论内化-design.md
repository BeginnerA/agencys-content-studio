# agencys-content-studio M5 技术设计规格（方法论内化：内容创作者套件整合）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-11
- 上游：`2026-09-09-agencys-content-studio-roadmap.md`（北极星：让「任意内容创作方法论」都能以 模板 + 行动 的形式跑成自动化流水线）；`2026-09-11-agencys-content-studio-m4-review.md`（四阶段收官）；用户立项：把外部「内容创作者套件」（Qoder 插件 v2.0.0，8 个中文技能）的创作方法论平移进 studio
- 红线复核：不新增 action / 不改引擎/DB/前端 / 不新增体裁专属表 / 不引重型编排引擎——本里程碑全部改动限于 `workspace/`（模板 + 提示词）与 `docs/`、`README.md`
- 设计原则：**方法论平移**（把技能知识重写为 studio 原生模板 + 提示词），不是搬运技能目录（套件是 Agent 多轮对话 + 文件目录 + JSON 摘要；studio 是 DAG + DB 资产 + 契约 JSON）

---

## 1. 定位与边界

### 1.1 一句话目标

把套件 8 技能（选题雷达 / 创作策划 / 文字创作 / 剧本创作 / 分镜提示词 / 平台适配 / 盘点复盘 / 内容编排）的创作方法论，内化为 studio 的模板家族与提示词体系：新增 7 个流水线模板、升级现有 3 模板，新增 12 个 + 升级 10 个提示词文件——全链路在 studio 内自动跑，引擎零代码。这是对北极星「任意内容创作方法论可模板化」的第二次大规模验证（首次为 M2 的 Skills 平移）。

### 1.2 范围（做）

| # | 主项 | 内容 |
|---|---|---|
| P1 | 补缺环节 | 新增 `topic-radar` / `video-plan` / `platform-adapt` / `review-restock` 四模板（对应套件四个缺失技能） |
| P2 | 视频线 | 新增 `series-setup`（整剧立项·设定包）；升级 `mengbao-episode` v3→v4（深度审查 / 叙事流分镜 / 剪辑把关） |
| P3 | 文字线 | 新增 `article-clip`（深度长文）；升级 `note-clip` v1→v2、`talking-clip` v2→v3（多平台适配 / 视频平台发布文案） |
| P4 | 快出片 | 新增 `quick-video`（快速单片视频，热点跟拍场景） |
| D1 | 文档 | 本 spec + roadmap 注记 + README 模板清单更新 |
| V1 | 验证 | §5 验收（静态 / 实弹 / 契约 / 零代码 / 记忆） |

### 1.3 M5 不做（明确排除）

| 排除项 | 理由 |
|---|---|
| 内容编排（orchestrator 技能） | studio 的模板选择 + 批次 + 项目页已是编排层等价物；跨工作流调度建议属人工/Agent 决策层 |
| aggregate-only / portfolio-restock | 汇总清单/作品集由项目页 + exports 导出覆盖；重建作品集是运营动作非创作流水线 |
| 分镜 reverse 反推 | 需视觉输入（看视频逐镜反推），studio 纯文本栈不具备；保留在 Qoder Agent 侧使用 |
| 联网热点采集 | 以素材导入（files 输入）替代；评分/去重/常青方法论完整保留 |
| 浏览器半自动导出 | 以平台数据文件导入替代 |
| 首帧图法 i2v 全自动链 | 提示词层保留（heavy 模式产首帧图提示词包）；生成链维持现状（ai_video v1 纯 t2v），待参考图通道扩展后接力 |
| R11 交付门禁机器评分 | 无评分引擎；以「提示词内自检重写一次 + gate 人工确认」平移 |

---

## 2. 复用面与硬约束（决策完备）

引擎能力不扩展，全部设计落在既有契约内：

| 引擎契约 | 内容 | 对设计的影响 |
|---|---|---|
| 10 类 action | manual_ingest / ai_text / ai_image / ai_video / tts / subtitle / ffmpeg_merge / memory_recall / memory_write / character_sync | 所有新流程只用既有 action 组合 |
| 输入 kind | 仅 text / files / int / bool（无 select；default 类型须与 kind 一致） | 平台选择用 text（逗号分隔支持多平台）；开关用 bool |
| JSON 契约 | 仅 storyboard-json / lines-json / characters-json 受校验，其余输出 markdown | 策划案/审查报告/叙事流等一律 markdown；只为"喂给图像/视频/角色库"的产物使用契约 JSON |
| gate 三态 | approve / reject（意见回流重跑）/ skip（须 skip_label） | 关键节点默认挂闸门；新增步骤全部 when 开关控制、默认 false 关，防闸门疲劳 |
| when 表达式 | `input.x == true` / `exists` / `empty` / `steps.x.count 比较` / true / false；数组=AND | 条件性步骤与条件性闸门（gate.when 满足→挂起，不满足→免审直过） |
| batch | `{field, max_concurrent, retry}`：对数组产物逐项执行 | 图像/视频批量生成沿用 |
| 输出与命名 | `output_purpose`（purposeSubDir 子目录映射）+ `output_format` + `name_tpl`（`{x:03d}` 内插） | 保持资产目录语义一致 |
| 记忆表 | memory_write `{type, name, scope}` / memory_recall `{limit}`（本地向量检索） | 新写入统一带 type 标签（topics / plan / series / review / style）防串味 |

**实施注记**：新模板经 `POST /api/v1/templates`（saveTemplate 自动刷缓存）或写文件后重启 dev server 生效；提示词文件运行时读取，无缓存问题。

---

## 3. 模板家族（7 新 3 升）

### 3.1 新增模板 ×7

#### 3.1.1 topic-radar.yaml（选题雷达）

- 来源：套件「选题雷达」（四路联网采集 → 常青生成 → 多维评分 → 去重 → 回灌调分）
- 平移策略：无联网采集 → 热点素材以 `materials` 导入替代；评分/去重/常青/回灌全部内化为提示词规则
- 输入：`track`(必填 text)、`platform`(text, 默认 抖音)、`count`(int, 12)、`materials`(files, 选填)、`with_recall`(bool, true)
- 步骤链：
  ```
  recall(memory_recall, when with_recall) → ingest(manual_ingest, when materials exists)
    → generate(ai_text, topic-radar.md, gate 免审标签「直接入库」) → remember(memory_write, type=topics)
  ```
- 要点：多维评分表（需求势能/竞争密度/账号适配/长尾价值）+ 历史选题去重（对比 recall 记忆）+ 常青题生成 + 效果回灌调分；产物为选题清单 markdown（含评分与选题理由），remember 沉淀选题库供后续调分闭环

#### 3.1.2 video-plan.yaml（创作策划）

- 来源：套件「创作策划」（策划案五节 + Look Dev + 弧光机械核对 + 导演三视角把关）
- 输入：`genre`(必填 text 题材)、`platform`(text, 默认 抖音)、`episodes`(int, 12)、`materials`(files, 选填)
- 步骤链：
  ```
  ingest(when materials exists) → recall → plan(ai_text, plan-video.md, gate：策划案确认) → remember(type=plan)
  ```
- 要点：策划案五节——题材定位 / 人物小传 / 爽点结构 / 视觉基调（含 Look Dev 描述）/ 单集节奏；弧光机械核对（人物弧光与爽点节奏交叉检查）与导演三视角（观众/平台/成本）把关写入提示词自检

#### 3.1.3 series-setup.yaml（整剧立项·设定包）

- 来源：套件「剧本创作」两阶段创作（整剧完整剧本先行 + 整剧确认门 → 逐集细化）+ 设定包四件
- 输入：`genre`(必填)、`episodes`(int, 12)、`plan_doc`(files, 选填策划案)、`with_character_refs`(bool, false)
- 步骤链：
  ```
  ingest(when plan_doc exists) → recall
    → write_series(ai_text, series-setup.md, gate：整剧确认门)
    → char_profile(ai_text, characters-json) → ref_prompts → gen_refs(ai_image, when) → sync_characters
    → remember(type=series)
  ```
- 要点：产「整剧设计书 + 设定包四件（series 总设定 / 角色设定卡 / 世界观 / 场景视觉卡）+ 分集地图」；**token 约束下的压缩两阶段**——单集完整剧本正文由 `mengbao-episode` 逐集展开（一次 LLM 调用生成 12 集完整剧本会超 maxTokens，故本模板产剧纲与设定包，逐集细化回单集流水线）；步骤写法对齐 mengbao-episode 的 char_profile/ref_prompts/gen_refs/sync 链

#### 3.1.4 platform-adapt.yaml（平台适配）

- 来源：套件「平台适配」（八平台规则 + 事实不变性 + 风险标注）
- 输入：`source`(必填 files 待适配原文)、`platforms`(text, 默认 "xiaohongshu"，逗号分隔多平台分节输出)、`content_type`(text, 默认 note)、`protect_facts`(bool, true)
- 步骤链：
  ```
  ingest → adapt(ai_text, adapt-text.md, gate) → 完成
  ```
- 要点：八平台（wechat/xiaohongshu/zhihu/toutiao/douyin/kuaishou/shipinhao/bilibili）标题与正文风格、话题标签、封面文案规范；事实不变性铁律（不新增/篡改事实）；风险处标注不静默删改（protect_facts=false 才允许删除说明）

#### 3.1.5 review-restock.yaml（盘点复盘 + 回灌）

- 来源：套件「盘点复盘」（三模块 + 置信门禁 + 回灌选题）
- 输入：`data`(必填 files 平台数据导出)、`period`(text)、`with_restock`(bool, true)
- 步骤链：
  ```
  ingest → recall → review(ai_text, review-data.md, gate 免审标签「认可结论」)
    → restock(ai_text, restock-topics.md, when with_restock) → remember(type=review)
  ```
- 要点：数据解读（完播/互动/涨粉结构）+ 置信门禁（样本不足降级结论并标注）+ 归因分析；回灌选题清单写入记忆，供 topic-radar 的 recall 调分闭环；浏览器半自动导出以数据文件导入替代

#### 3.1.6 quick-video.yaml（快速单片视频）

- 来源：套件「内容编排」quick-video 工作流 + 「文字创作」talking-head 轻量版
- 输入：`idea`(必填 text 灵感/选题)、`platform`(text, 默认 抖音)、`duration_hint`(int, 45)、`confirm`(bool, false 默认免审)、`with_cover`(bool, true)
- 步骤链：
  ```
  recall → draft(ai_text, quick-script.md, gate.when=confirm) → cast_lines(lines-json)
    → voice(tts) → subtitle(subtitle) → cover_prompt/cover(ai_image, when with_cover)
    → compose(ffmpeg_merge) → remember
  ```
- 与 talking-clip 差异：无账号档案/参考素材输入、极简必填项、闸门默认关闭（confirm 开才挂），定位热点跟拍快出片；收尾链（lines-cast/lines-timing/tts/ffmpeg_merge 参数）与 talking-clip 同构

#### 3.1.7 article-clip.yaml（深度长文）

- 来源：套件「文字创作」article 模式（深度长文：结构完整 / 逻辑论证 / 事实溯源）
- 输入：`topic`(必填)、`platform`(text, 默认 微信公众号)、`material`(files, 选填)、`with_inline_images`(bool, false)、`image_count`(int, 3)、`to_platforms`(text, 选填适配目标)
- 步骤链：
  ```
  recall → draft(ai_text, article-draft.md, gate)
    → inline_prompts/inline_images(ai_image, when with_inline_images)
    → adapt(ai_text, adapt-text.md, when to_platforms exists)
    → publish(publish-note.md) → cover_prompt/cover → remember
  ```
- 步骤写法对齐 note-clip；配图走 storyboard-json（inline-note.md 泛化为文章/笔记两栖）

### 3.2 升级模板 ×3

#### 3.2.1 mengbao-episode v3 → v4（version: 4）

- 新增输入（全默认 false，向后兼容）：`with_deep_review`、`with_narrative_doc`、`with_edit_review`
- 新增步骤：
  - `script_review`(ai_text, script-audit.md)：write_script 后，when with_deep_review；gate 同条件 + 免审标签「认可通过」——剧本深度审查分级（快速/深度两级检查清单）
  - `storyboard_narrative`(ai_text, storyboard-narrative.md)：make_storyboard 后，when with_narrative_doc——人类可读叙事流分镜（△景别 + 台词语气括注 + ♪音乐 + 逐镜衔接表）
  - `edit_audit`(ai_text, edit-audit.md)：make_storyboard 后，when with_edit_review——可剪辑性门禁（R16③ 文本层把关：节奏/时长/转场可行性）
- 提示词升级：script-ep.md（设定包感知 + R16①② 自检 + 钩子密度 + AI 味黑名单）、storyboard-ep.md（衔接表 / 首帧图法备注 / heavy 模式说明 / 可剪辑性自检）、char-profile.md 与 ref-prompts.md（泛化：兼容设定包与 Look Dev 视觉基调）
- 保留全部 v3 步骤与输入语义；默认参数行为与 v3 等价

#### 3.2.2 talking-clip v2 → v3（version: 3）

- 新增输入：`platform`(text, 默认 抖音)、`with_platform_copy`(bool, false)
- 新增步骤：`platform_copy`(ai_text, adapt-video.md, when with_platform_copy)——视频平台发布文案（标题/话题/简介）
- 提示词升级：draft-talking.md（R15 AI 味黑名单 + 交付门禁自评（<70 重写一次）+ 前 3 秒钩子 + platform 感知）、cover-talking.md（平台封面文案规则）

#### 3.2.3 note-clip v1 → v2（version: 2）

- 新增输入：`to_platforms`(text, 选填)
- 新增步骤：`adapt`(ai_text, adapt-text.md, when to_platforms exists)——多平台适配稿
- 提示词升级：draft-note.md（R15 + 门禁自评 + 事实溯源标注）、publish-note.md（多平台发布规范）、cover-note.md（封面文案规则）、inline-note.md（两栖泛化）

---

## 4. 提示词体系（12 新 10 升）

### 4.1 映射表

| 新增文件 | 来源技能 | 用途 |
|---|---|---|
| topic-radar.md | 选题雷达 | 多维评分/去重/常青生成/回灌调分 |
| plan-video.md | 创作策划 | 五节策划案 + Look Dev + 弧光核对 |
| series-setup.md | 剧本创作 | 整剧设计书 + 设定包四件 + 分集地图 |
| script-audit.md | 剧本创作 | 剧本深度审查分级 |
| storyboard-narrative.md | 分镜提示词 | 叙事流分镜 + 逐镜衔接表 |
| edit-audit.md | 分镜提示词 | 可剪辑性门禁（R16③） |
| article-draft.md | 文字创作 | 深度长文主稿 |
| adapt-text.md | 平台适配 | 图文/长文八平台适配 |
| adapt-video.md | 平台适配 | 视频平台发布文案 |
| review-data.md | 盘点复盘 | 数据解读 + 置信门禁 |
| restock-topics.md | 盘点复盘 | 回灌选题清单 |
| quick-script.md | 内容编排 + 文字创作 | 轻量快脚本（钩子+口播+行动号召） |

| 升级文件 | 升级点 |
|---|---|
| script-ep.md | 设定包感知 + R16①② 自检 + 钩子密度 + AI 味黑名单 |
| storyboard-ep.md | 衔接表 / 首帧图法备注 / heavy 模式 / 可剪辑性自检 |
| char-profile.md | 泛化（兼容设定包四件；萌宝铁律降为可选段） |
| ref-prompts.md | Look Dev / 视觉基调感知 |
| draft-note.md | R15 AI 味 + 交付门禁自评 + 事实溯源 |
| draft-talking.md | R15 + 门禁自评 + 前 3 秒钩子 + platform 感知 |
| publish-note.md | 多平台发布规范（泛化覆盖长文） |
| cover-note.md | 平台封面文案规则 |
| cover-talking.md | 平台封面文案规则 |
| inline-note.md | 文章/笔记两栖泛化 |

（原注：lines-cast.md、lines-timing.md 已含 Plutchik 24 词情绪体系与 measured 字幕体系，不迁移——该注解只覆盖词表层，执行级数据资产曾遗漏）

（补丁 2026-09-12 已迁移执行级数据资产：lines-cast.md 六维映射库 + 5 套场景配音模板；ref-prompts.md 10 套画风预设词块；plan-video.md 爽点类型库 / 四阶段波形 / 13 题材速查；script-ep.md 开场模板库 / 合规红线清单；series-setup.md 四阶段强化 / 反派递进体系；script-audit.md 合规核查节）

### 4.2 写作规范

- 结构对齐现有文件：角色身份句 → 硬性约束 → 输入说明 → 方法论规则 → 输出规范
- JSON 契约类维持「只输出合法 JSON、无围栏」；markdown 类产人读文档（含自查清单痕迹）
- 保留套件编号术语（R11/R15/R16/R17）作为自查清单标签；大方法论（爽点体系、AI 味黑名单等）浓缩为检查清单，单文件 ≤ 约 12KB
- 全部中文输出

---

## 5. 验收

1. **静态**：`GET /api/v1/templates` 列出全部 10 模板、promptsDirty 全 false；每个新模板 `POST /templates/validate` 通过
2. **实弹**：7 个新模板各真跑 1 次（真调 LLM/图像）；3 个升级模板用旧输入重跑验证向后兼容（默认参数行为等价旧版）
3. **gate 三态**：对新模板抽查 approve / reject（带意见重跑）/ skip 各至少 1 次
4. **契约**：storyboard-json / lines-json / characters-json 步骤跑通即校验通过；markdown 产物人工抽查 1-2 份
5. **零代码核查**：`git diff --stat` 确认仅 `workspace/`、`docs/`、`README.md` 变更
6. **记忆卫生**：memory_write 产物带 type 标签（topics/plan/series/review/style），recall 抽查无串味

## 6. 风险与对策

1. 提示词超长 → 大方法论浓缩为检查清单，单文件 ≤ 约 12KB
2. 整剧剧本 token 超限 → series-setup 压缩为设计书 + 分集地图，单集正文回 mengbao-episode
3. 闸门疲劳 → 新步骤全部 when 开关控制、默认 false 关；仅关键节点默认挂闸门
4. 向后兼容 → 模板 version+1、inputs 只增不改、新步骤默认关闭
5. 记忆串味 → memory_write 统一带 type 标签；新模板 recall 与写入均限定语义域

## 7. 交付物清单

- `workspace/templates/`：+7（topic-radar / video-plan / series-setup / platform-adapt / review-restock / quick-video / article-clip）、改 3（mengbao-episode v4 / talking-clip v3 / note-clip v2）
- `workspace/prompts/`：+12、改 10（见 §4.1）
- 文档：本 spec、ROADMAP 注记、`Agent/agencys-content-studio/README.md`
