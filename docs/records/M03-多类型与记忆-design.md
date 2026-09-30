# agencys-content-studio M3 技术设计规格（多类型与记忆）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-10
- 上游：`2026-09-09-agencys-content-studio-roadmap.md`（M3 行：图文/口播模板各一条跑通；本地向量记忆（Toonflow 参考）；角色一致性库）
- M2 review 输入：`2026-09-09-agencys-content-studio-m2-review.md`（§M3 spec 输入：图文/口播完整方法论模板、本地向量记忆+角色一致性库、音频情绪+音画精确对齐、gate 编排范式、Backlog 继承）
- 红线（ROADMAP 引用）：不引重型编排引擎；不做体裁专属表（memories/characters 为跨体裁通用表）；模板/提示词外置不写死代码；本地单机不回退；「M1–M2 不引入记忆」时点红线已到期（M3 行授权引入）

---

## 1. 定位与 M3 边界

### 1.1 一句话目标

把平台从「视频类流程引擎」扩展为「**多体裁内容平台**」：图文/口播完整方法论模板各一条跑通（账号档案 / 选题 / 档案依赖），本地向量记忆与角色一致性库落地并**真实注入下游产出**（prompt 快照可证），音频情绪与音画精确对齐贯通 TTS→字幕→合成链路。出口回答：跨体裁 action 复用率多少？记忆是否真实提升一致性产出？

### 1.2 M3 范围（做）

| # | 主项 | 内容 |
|---|---|---|
| E1 | 记忆基础设施 | 本地 embedding（transformers.js + ONNX，模型文件本地目录，零联网运行）+ `memories` 通用表 + 记忆服务（upsert/检索/重建）+ REST + Web 记忆页 |
| E2 | 记忆 action | `memory_write`（写记忆，同 project+name upsert）/ `memory_recall`（向量召回 → text 资产，下游 ai_text 注入即生效——零引擎改动） |
| E3 | 角色一致性库 | `characters` 通用表（档案+定妆照）+ `character_sync` action + `ai_image` 注入升级（shot.characters × 角色库 → 外观锚定拼接进 prompt）+ Web 角色页 |
| E4 | 音频情绪 | 台词 JSON 契约扩展（speaker/voice_hint/emotion_hint）；tts 升级：角色声线基准（查库）+ 情绪基调词解析（透传/记录）；字幕正文纯净（剥离括注） |
| E5 | 音画精确对齐 | `subtitle` measured 模式：tts 实际音频时长（ffprobe）→ 累计时间轴 → 程序化切显示行 → SRT（LLM 估时降级为无音频兼容路径） |
| T1 | 图文模板 | 新增 `note-clip`（图文笔记·单篇）：选题+账号档案 → 主稿（gate 审阅）→ 封面 → 可选内页配图 → 发布稿；**全程复用既有 action，零新增** |
| T2 | 口播完整版 | `talking-clip` v2：账号档案注入 + 记忆闭环（recall/remember）+ 六维情绪台词 + 精确字幕 + 字幕 gate 可选 |
| T3 | 短剧角色库 | `mengbao-episode` v3：角色档案提取 → （可选定妆照生成）→ 建档 → 出图自动注入角色锚定 |
| W1 | Web 配套 | 记忆页（/memories：列表/编辑/语义检索试玩/重建索引）、角色页（/characters：列表/编辑/定妆照预览）、运行页记忆/角色步骤呈现 |
| V1 | 验证 | §10 验收 10 条 + README 更新 |

### 1.3 M3 不做（明确排除）

| 排除项 | 去向 |
|---|---|
| 三层记忆（shortTerm/summaries 摘要压缩） | Backlog——流水线记忆是显式设计产物，无对话流语义，只做向量召回一层 |
| 角色语义检索（embedding 匹配角色） | 名字/别名精确匹配足够（M3）；语义匹配入 Backlog |
| 参考图 i2i 出图（定妆照参与生成） | 适配层声明能力后启用（refAssetIds 已透传 params 预留） |
| 联网选题挖掘（media-hotspot 全量平移） | 选题以模板输入为主；联网热点检索归后续（新需求走北极星三问） |
| 图文平台适配（公众号 HTML / 跨平台改写） | media-adapter 方法论不整体平移；T1 产发布稿 md，不做平台 HTML |
| 多集批量编排 / 平台级成本统计 | M4（Backlog 继承） |
| ai_text 任务化 / 表达式语言扩展 | 维持 M2 决策不变 |

---

## 2. 技术决策总览（决策完备）

| 决策点 | 结论 | 理由 / 否决项 |
|---|---|---|
| embedding 运行时 | `@huggingface/transformers` v3 + ONNX 本地推理；进程内懒加载单例（首次调用初始化）| 复用 Toonflow 已验证方案（`Agent/Toonflow-app/src/utils/agent/embedding.ts`）；零联网、零 API 成本、本地单机形态不破 |
| embedding 模型 | **`bge-small-zh-v1.5`（中文，512 维）**（用户已确认一步到位）：模型文件放 `data/models/<模型名>/`（tokenizer.json / config.json / onnx/*.onnx，与 Toonflow 目录结构同构），目录可配 `settings.embedding.modelDir`；获取：ONNX 导出（HF/modelscope，网络受限时用镜像）；本机 all-MiniLM-L6-v2（384 维）仅作离线兜底备选（若用于验证，review 必须记录中文召回冒烟结果） | 内容全中文，英文模型召回质量存疑直接影响出口问题 2 的答案可信度；模型与代码解耦（目录约定 + 表内记录模型标识） |
| 记忆表结构 | `memories` 通用表：projectId（**NULL=全局**）/ type / name / content / embedding(JSON) / embeddingModel / meta(JSON 溯源) / 时间戳 | 通用表红线不破；`embeddingModel` 支撑模型切换时的索引重建（检索按当前模型过滤） |
| 记忆隔离 | 查询 = 项目级 + 全局（`projectId IS NULL`）合并按相似度排序；写入 scope 由 action/API 显式指定（project/global） | 支持「项目沉淀」与「账号级沉淀」两层；不猜不隐性合并 |
| 记忆读写形态 | **显式 action**（memory_write / memory_recall），不做自动/隐式记忆 | 模板作者决定写什么、何时读；召回结果本身是 text 资产（可审计、可引用、可 gate）；下游 ai_text 现有「资产注入」机制直接消化，**零引擎改动** |
| 具名记忆语义 | `memory_write` 同 project+name → **upsert 覆盖**（滚动样本不膨胀）；name 缺省 = 匿名追加 | 「每轮风格样本」「角色声线基准」类记忆需要覆盖而非堆积 |
| 角色表结构 | `characters` 通用表：projectId（NULL=全局角色库）/ name / aliases(JSON) / summary / appearance（外观锚定文本）/ negative（负向词）/ voice（声线基准短语）/ refAssetIds(JSON) / meta | 角色是跨体裁通用概念（短剧角色/口播主播/图文 IP）；外观锚定+负向词 = 用户 profile.md「形象锚定/免漂移负向词」的工程化 |
| 角色注入方式 | **提示词锚定注入为主**：`ai_image` 逐镜读 `shot.characters[]` → 按 name/别名查角色库 → appearance+negative 拼接进该镜 prompt；refAssetIds 进 params（i2i 能力预留） | 提示词注入对所有 provider 生效（pollinations 无 i2i）；参考图模式 provider 依赖，留待适配层能力声明 |
| 定妆照生成路径 | 模板可选分支：角色提示词（storyboard-json）→ `ai_image` 每角色 1 张（`shot.id=角色名`）→ `character_sync` 按 `asset.params.shotId` 关联入档 | 复用 ai_image 批处理（其产物 params.shotId 已记录）；开关默认关，控制成本 |
| 契约扩展（向后兼容） | shot 增 `characters?: string[]`；line 增 `speaker?/voice_hint?/emotion_hint?`；output_format 增 `characters-json`；缺字段一律不报错 | 旧模板/旧产物零影响；新方法论文档驱动提示词产出新字段 |
| 音频情绪应用 | 情绪**基调词**（Plutchik 口径）→ 实例 `extra.emotion_param`+`extra.emotion_map` 声明时透传（body[emotion_param]=映射值）；未声明 → 不传参但**记录** `asset.params.emotion_hint/emotion_key` | OpenAI 兼容端点普遍无 emotion 参数（透传靠实例声明，映射外置）；「记录+可审计」保证方法论不丢失，M4 视频模型直出音频时字段即用 |
| 声线优先级链 v2 | 逐句 `line.voice_hint` → 角色库 `characters.voice`（按 speaker 匹配）→ `params.voice` → defaults/settings `audio.voice` → 实例 extra.voice → `alloy` | 角色专属声线 > 全局默认；单句覆盖 > 角色基准 |
| 字幕模式 | `subtitle` 增 `params.mode`：`measured`（默认，有 voices 输入时）用 tts 实测时长；无 voices 自动回退 `estimated`（现有 LLM 路径，兼容 v1 模板） | 「音画精确对齐」= 时间轴由实测驱动；LLM 从「估时」降级为「无音频时的兼容路径」 |
| 字幕显示行切分 | measured 模式程序化切行：优先「。！？；」→ 仍超长按「，、」→ 最后硬切；`max_chars_per_line` 默认 18；行时长按字符数比例分配句时长 | 确定性输出，零 LLM 依赖、零成本；切行规则可测 |
| compose 承接 | `ffmpeg_merge` **无需改造**：其口播守卫（底图撑长取 srtEndMs / 音频实测总长）在 E5 后自动获得精确值 | 精确性由 subtitle/tts 传导，避免重复造轮子 |
| 迁移 | drizzle schema 增 2 表 → `db:push`；沿用 M2「启动时旧库兜底」路径 | 零停机单文件 SQLite 不变 |
| 模型获取脚本 | `apps/server/scripts/` 增模型就绪脚本（① 打印/执行 bge-small-zh-v1.5 ONNX 获取指引（含镜像源）② 本机复制 all-MiniLM 兜底路径） | 中文模型为目标，兜底路径保零网络可跑通 |

---

## 3. 记忆基础设施（E1）

### 3.1 数据模型（db/schema.ts 增表）

```ts
export const memories = sqliteTable('memories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id'),          // NULL = 全局（跨项目/账号级）
  type: text('type').notNull().default('note'), // note|style|fact|feedback|...（开放，应用层不强校验）
  name: text('name'),                        // 具名记忆（同 project+name upsert）；NULL = 匿名追加
  content: text('content').notNull(),
  embedding: text('embedding'),              // JSON number[]（写入时模型不可用则为 NULL）
  embeddingModel: text('embedding_model'),   // 写入时模型标识（目录名+维度）
  meta: text('meta').notNull().default('{}'),// JSON: {runId,stepId,assetId,source}
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [
  index('idx_memories_project').on(t.projectId),
  index('idx_memories_name').on(t.projectId, t.name),
])
```

- 全局角色/记忆的 name 唯一性由应用层 upsert 查询保证（SQLite 唯一索引对 NULL projectId 不生效）。
- 记忆规模预期：单机、百至千条级 → 检索全量扫描内存计算（同 Toonflow `vectorSearch`），不做 ANN 索引。

### 3.2 embedding 服务（services/embedding.ts，新）

| 项 | 设计 |
|---|---|
| 加载 | `pipeline('feature-extraction', modelDir, { dtype })`（dtype 按模型目录实际导出，如 `fp16`/`fp32`）；`env.allowRemoteModels=false; env.allowLocalModels=true`（同 Toonflow）；懒加载单例 + 并发初始化互斥 |
| 接口 | `embed(text): Promise<number[]>`（pooling mean + normalize，normalize 后余弦=点积）；`cosine(a,b)`；`modelTag()` 返回 `{dir 名, 维度}` |
| 模型目录 | `data/models/<模型名>/`（config.json / tokenizer.json / tokenizer_config.json / special_tokens_map.json / vocab.txt / onnx/*.onnx）——与 Toonflow 模型目录同构，可直接复制 |
| 缺失行为 | `embed()` 抛错，指引：「未找到 embedding 模型：请将模型置于 data/models/<模型名>/（README 有复制/下载说明）」 |
| 模型切换 | 写入时记录 `embeddingModel`；检索按当前模型过滤（异模型行跳过并计数警告）；记忆页提供「重建索引」（全量重算 embedding） |

### 3.3 记忆服务（services/memory.ts，新）

- `upsert({projectId, scope, type, name, content, meta})`：scope=project → projectId 必填；scope=global → projectId=NULL；有 name → 查同域同名行覆盖（刷新 embedding/updatedAt），无 name → 插入。
- `recall({projectId, query, limit=3, minScore=0.25})`：embed(query) → 取「projectId 匹配 + NULL」行（过滤异模型 + embedding 非空）→ 余弦排序 → 截断。
- `list({projectId, q?, type?, scope?})`：管理页用；q 非空时走向量排序，否则按 updatedAt 倒序。
- `reindex()`：全量重算 embedding + 更新 embeddingModel。

### 3.4 REST（routes/memories.ts，新）

```
GET    /memories?project_id=&scope=&type=&q=&limit=   列表/语义检索（q 给定时按相似度排序并返回 score）
POST   /memories                                      {content, project_id?, scope, type?, name?, meta?}
PUT    /memories/:id                                  编辑（内容变更 → 重算 embedding）
DELETE /memories/:id
POST   /memories/reindex                              全量重建（返回 {total, rebuilt, skipped}）
GET    /memories/status                               {modelDir, modelTag, count, missingEmbedding}
```

---

## 4. 记忆 action（E2）

### 4.1 memory_write（同步）

| 项 | 决策 |
|---|---|
| 输入 | `content: steps.x.asset`（text 资产）或字面文本；params: `{ scope: 'project'\|'global'（默认 project）, type='note', name? }` |
| 行为 | 读内容 → `memory.upsert` → 产 **text 资产**（purpose=`memory_log`，内容=记忆条目快照 JSON `{id,scope,type,name,chars}`，供运行页审计与下游引用） |
| 幂等 | 同名 upsert：resume 重跑同一步骤不会产生重复记忆 |
| 失败 | embedding 模型缺失 → StepError 含部署指引（不静默跳过） |

### 4.2 memory_recall（同步）

| 项 | 决策 |
|---|---|
| 输入 | `query: input.topic` 或上游 text 资产；params: `{ limit=3, min_score=0.25, scope: 'both'（默认）\|'project'\|'global' }` |
| 行为 | embed(query) → 召回 → 拼 text 资产（purpose=`memory`，name_tpl 默认 `recall.md`） |
| 产物格式 | markdown：`# 记忆召回（{query}）` + 每条 `## [{i}] 相似度 {score} · {type}/{name} · {date}` + 正文；空结果 → 产「（无相关记忆）」占位资产（**始终产资产**，保证 when/引用稳定） |
| 注入 | 下游 ai_text `inputs: { recalled: steps.recall.asset }` → 现有资产注入机制自动消化 |

### 4.3 模板使用范式

```yaml
  - key: recall
    action: memory_recall
    title: 记忆召回
    inputs: { query: input.topic }
    params: { limit: 3 }
  - key: draft
    action: ai_text
    after: [recall]
    inputs: { topic: input.topic, recalled: steps.recall.asset, profile: input.profile }
    ...
  - key: remember
    action: memory_write
    title: 沉淀风格样本
    after: [draft]
    inputs: { content: steps.draft.asset }
    params: { type: style, name: style-sample-latest }
```

---

## 5. 角色一致性库（E3）

### 5.1 数据模型（db/schema.ts 增表）

```ts
export const characters = sqliteTable('characters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id'),          // NULL = 全局角色库（跨项目复用同一形象）
  name: text('name').notNull(),
  aliases: text('aliases').notNull().default('[]'), // JSON string[]
  summary: text('summary'),                  // 一句话设定（文本侧一致性用）
  appearance: text('appearance'),            // 外观锚定文本（注入核心：脸型/发/体态/服装基调）
  negative: text('negative'),                // 必然剔除项（免漂移负向词）
  voice: text('voice'),                      // 声线基准短语（tts 查库用，如「成年男声、低沉沙哑」）
  refAssetIds: text('ref_asset_ids').notNull().default('[]'), // 定妆照资产 ids（JSON）
  meta: text('meta').notNull().default('{}'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [index('idx_characters_project').on(t.projectId), index('idx_characters_name').on(t.name)])
```

### 5.2 character_sync action（同步，新）

| 项 | 决策 |
|---|---|
| 输入 | `characters: steps.x.asset`（characters-json 资产：`{characters:[{name,aliases?,summary?,appearance,negative?,voice?,ref_prompt?}]}`）；可选 `ref_images: steps.y.assets`（定妆照资产序列） |
| 匹配 | 按 name（含别名）upsert 到 characters 表；ref_images 按 `asset.params.shotId`（或 name 含角色名兜底）归属对应角色 → 追加 refAssetIds（去重） |
| scope | params.project（默认 `true`=归属当前项目；`false`=写全局角色库） |
| 产物 | text 资产（purpose=`character_log`，内容=建档结果 JSON：新增/更新角色名列表与 id，供审计） |
| 幂等 | 同 name 再流水线重跑 → 更新而非重复插入 |

### 5.3 ai_image 注入升级（E3 核心）

现状（M1–M2）：`inputs.characters`（资产引用）仅「本地留档，不参与生成」。M3 升级：

1. 逐镜读 `shot.characters: string[]`（分镜 JSON 契约扩展，storyboard-ep.md v2 提示词同步产出）。
2. 按名字/别名查角色库（项目 + 全局），命中 → 拼接注入：
   ```
   最终 prompt = shot.image_prompt
     + "\n角色锚定（{角色名}）：{appearance}"
     + （negative 存在时）"\n必须剔除：{negative}"
   ```
3. 未命中角色名 → 该镜照常生成 + `ctx.log` 警告（不阻断）。
4. 命中角色的 refAssetIds 汇总进 task.params（`refAssetIds`，i2i 能力预留）。
5. task.prompt 快照含注入全文 → 一致性可审计（「记忆/角色是否真实生效」的证据链）。

### 5.4 建档流程范式（T3 步骤链）

```yaml
  - key: char_profile     # ai_text, output_format: characters-json
    # 从剧本+设定提取角色档案（appearance 外观锚定 / negative 负向词 / voice 声线基准）
  - key: ref_prompts      # ai_text, output_format: storyboard-json（每角色 1 条 shot，id=角色名）
  - key: gen_refs         # ai_image, when: input.with_character_refs == true, batch max_concurrent: 1
  - key: sync_characters  # character_sync, after: [char_profile, gen_refs]
    inputs: { characters: steps.char_profile.asset, ref_images: steps.gen_refs.assets }
```

### 5.5 REST + Web 角色页

```
GET    /characters?project_id=        列表（含 refAssets 缩略信息）
GET    /characters/:id
POST   /characters                    {name, aliases, summary, appearance, negative, voice, project_id?, ref_asset_ids?}
PUT    /characters/:id
DELETE /characters/:id
```

Web 角色页 `/characters`：卡片列表（名/别名/外观摘要/定妆照缩略图/scope 徽标项目|全局）+ 编辑表单 + 定妆照选择（从项目资产中挑图）+ 删除。

---

## 6. 音频情绪（E4）

### 6.1 台词 JSON 契约 v2（向后兼容）

```jsonc
{ "lines": [
  { "id": "1", "speaker": "疤六",                       // [新] 角色名（查声线基准/字幕说话人）
    "voice_hint": "中年男声、嗓子发干带怯",               // [新] 声线短语（首现锁定逐镜复用——方法论口径）
    "emotion_hint": "干笑——语气虚浮带躲闪，语速偏慢、句间有顿，音调压平、尾音发干，气息发虚", // [新] 情绪短语（Plutchik 口径六维）
    "text": "哟，老雷。这么多年，你还活着呢。",           // 台词正文（字幕唯一来源，括注不入正文）
    "est_ms": 3200 }                                     // 兼容字段
]}
```

- `ai_text` 的 `lines-json` 校验扩展：新字段存在时校验为字符串（缺省不报错）；`text` 必填不变。
- 提示词侧口径（lines-cast.md v2）：每句台词形态 `{角色}（{声线短语}；{情绪短语}）：「{台词}」` 的**结构化落库形态**即上述字段（提示词直接产出字段化 JSON，不做字符串内嵌）。词源 = Plutchik 24 词体系（参照物：`2026-09-05-content-suite-audio-emotion.md` 的 §1 体系表 / §2 六维映射库 / §4 场景模板，提示词内引用该口径的浓缩版）。

### 6.2 tts 升级（actions/tts.ts）

| 项 | 决策 |
|---|---|
| 声线解析 | 逐句：`line.voice_hint` → 角色库 `characters.voice`（按 speaker 匹配 name/别名）→ `params.voice` → defaults/settings `audio.voice` → 实例 `extra.voice` → `alloy` |
| 情绪解析 | `emotion_key` = `emotion_hint` 首个「——」前段（如「干笑」）；`emotion_hint` 全文随资产记录 |
| 情绪透传 | 实例 extra 声明 `emotion_param`（字段名）与可选 `emotion_map`（{基调词: provider值}）→ `body[emotion_param] = emotion_map?.[key] ?? key`；未声明 → 不传（兼容任意网关） |
| 资产记录 | `asset.params` 增 `{speaker, voice_hint, voiceSource: 'line'\|'character'\|'params'\|'settings'\|'instance'\|'default', emotion_hint, emotion_key, emotion_sent: string\|null}` |
| 字幕正文 | 合成文本一律取 `line.text`（纯净正文，括注永不进 TTS 输入与字幕） |
| provider 支持注意 | 已知硅基流动 CosyVoice2 的 voice 需「模型:音色」格式（Cherry 已修复），emotion 参数是否存在按实例实测；无支持实例时验收以「记录可证」为准（§10-4） |

### 6.3 提示词升级清单（audio-emotion 口径落地）

- `lines-cast.md` v2：台词拆分产出 speaker/voice_hint/emotion_hint/text 四字段（声线首现锁定复用、情绪六维 ≥3 维或命中场景模板——方法论浓缩进提示词，权威口径同 audio-emotion 资产）。
- 短剧侧 `storyboard-ep.md` v2：分镜 shot 增 `characters: []`（本镜出场角色名，供 ai_image 注入）；音频段台词沿用六维口径（文本形态，供视频模型直出场景）。

---

## 7. 音画精确对齐（E5）

### 7.1 subtitle measured 模式（actions/subtitle.ts 升级）

算法（全程序化，零 LLM）：

1. 输入：`lines`（cast_lines JSON，顺序=配音顺序）+ `voices`（tts 音频资产序列，同序）。
2. 逐句 `probeMediaDuration`（服务已就绪）取实际时长 `d_i`；单句探测失败 → 回退 `est_ms` 或按字符估时（`chars × 180ms`）。
3. 显示行切分：句 text 先按「。！？；」切 → 仍超 `max_chars_per_line`（默认 18）按「，、」切 → 仍超硬切；短于 `min_ms`（默认 800ms）的行与前一行合并。
4. 行时长 = `d_i × (行字符数 / 句总字符数)`；时间轴累计（起点 0，可配 `lead_in_ms` 默认 0）。
5. 产 SRT；自检：末行 end_ms 与 Σd_i 误差 >2% 警告；沿用现有 SRT 格式与单调校验（assertSrt）。
6. 边界：voices 数量 ≠ lines 数量 → StepError（含数量对比，防错位）。

### 7.2 兼容路径（estimated）

`inputs.voices` 缺失/空（如 `with_voice=false` 纯字幕版、v1 模板）→ 自动回退现有 LLM 估时路径（prompt_tpl 不变）。`params.mode` 可显式 `measured|estimated` 覆盖（排查用）。

### 7.3 compose 承接

`ffmpeg_merge` 不动：口播守卫已有「srtEndMs / 音频实测总长 → 底图撑长」逻辑，E5 后 srtEndMs 即精确值，成片时长与音画同步自动精确。

---

## 8. Web 配套（W1）

| 页面 | 内容 |
|---|---|
| 记忆页 `/memories`（新） | 列表（scope 筛选项目/全局、类型筛选、空 embedding 警示）+ 新建/编辑/删除 + **语义检索试玩框**（输入 query 即回显 topN 与相似度）+ 重建索引按钮 + 状态栏（模型目录/维度/条数） |
| 角色页 `/characters`（新） | 卡片列表（定妆照缩略/外观摘要/scope 徽标）+ 编辑表单（appearance/negative/voice 文本域）+ 定妆照选择器（从项目资产挑图）+ 删除 |
| 运行页 | 记忆/角色步骤徽标：memory_write 显示「记忆已写 {name}」、memory_recall 显示「召回 {n} 条」、character_sync 显示「建档 {n} 角色」（读 output 资产/params，轻量渲染） |
| Settings | 「记忆与模型」区（记忆页内或系统设置）：模型目录、维度展示、重建入口（M3 合并进记忆页，不新增 Settings tab） |

---

## 9. 沉淀模板（T1/T2/T3）

### 9.1 T1「图文笔记·单篇」（新 key `note-clip`，genre: note）

```yaml
key: note-clip
version: 1
name: 图文笔记·单篇（主稿审阅 → 封面 → 发布稿）
genre: note
inputs:
  - topic (text, required)                 # 选题与目标受众点
  - profile (files, 选填, .md)             # 账号档案（人设/受众称呼/口头禅/禁用词）
  - material (files, 选填, .md/.txt)       # 素材/事实线索（trace 要求写进提示词）
  - with_inline_images (bool, default false) # 内页配图开关
  - image_count (int, default 3)           # 内页配图张数（配图开启时有效）
defaults:
  llm: { temperature: 0.7, max_tokens: 6000 }
  image: { provider: pollinations_image, size: "768x1024" }   # 3:4 小红书画幅
steps:
  - recall            # memory_recall（query=input.topic, limit 3）——往期风格样本召回
  - draft             # ai_text draft-note.md（media-writer note 形态：钩子/骨架/标签；profile 人设；禁用词）
                      #   after: [recall] → gate 审阅（驳回意见回流，M2 既有）
  - cover_prompt      # ai_text cover-note.md（storyboard-json，单张封面提示词）after [draft]
  - cover             # ai_image（batch shots, max_concurrent 1）
  - inline_prompts    # ai_text inline-note.md（storyboard-json，image_count 张内页配图提示词）
                      #   when: input.with_inline_images == true, after [draft]
  - inline_images     # ai_image（batch），when 同上, after [inline_prompts]
  - publish           # ai_text publish-note.md（标题定稿+3备选/正文/话题标签/配图顺序）
                      #   after: [draft, cover, inline_images]，inputs: draft/cover/inline_prompts
                      #   → 产 publish.md（purpose=export）
  - remember          # memory_write（content=steps.draft.asset, name=style-sample-latest, type=style）
                      #   after: [draft]
```

验证点：全程复用既有 8 类 action（**零新增 action**——图文体裁的复用率 100% 证据）；gate 审阅；可选配图分支 skipped 传播正确性（inline 分支关闭时 publish 正常执行）；记忆写读闭环。
prompts 新增：`draft-note.md / cover-note.md / inline-note.md / publish-note.md`。

### 9.2 T2「对白口播·单条 v2」（talking-clip version: 1 → 2）

与 v1 差异（以工作区当前文件为基准增量编辑）：

```yaml
inputs: + profile (files, 选填, .md)          # 账号档案（人设/称呼/口头禅/禁用词注入 draft）
        + with_subtitle_review (bool, default false)  # 字幕审阅开关（gate 点）
steps:
  - recall            # [新] memory_recall（query=input.topic）——首步
  - draft             # after: [recall]；inputs + profile + recalled；prompt 升级 v2（mode-video 三件套 + 人设）
  - cast_lines        # prompt 升级 v2：产出 speaker/voice_hint/emotion_hint/text 四字段（六维口径）
  - cover_prompt / cover   # 不变
  - voice             # tts when with_voice != false（同 v1）；升级：声线基准查库 + 情绪解析/透传/记录
  - subtitle          # after: [voice, cast_lines]（v1 为 after [cast_lines]）
                      #   inputs: { lines: steps.cast_lines.asset, voices: steps.voice.assets }
                      #   mode=measured（voice 跳过时自动 estimated）——纯字幕版仍可跑
                      #   gate: when: input.with_subtitle_review == true（skip_label「免审直烧」）
  - remember          # [新] memory_write（draft 定稿 → style-sample-latest upsert）after [draft]
  - compose           # ffmpeg_merge 不变（音画精确性由 E5 传导）
```

验证点：情绪字段全链路（cast_lines JSON → tts 记录/透传 → 字幕正文纯净）；measured 字幕时间轴 = 音频实测；字幕 gate 三态；纯字幕模式（voice skipped）estimated 回退；记忆闭环（第二次 run 召回命中第一次样本，prompt 快照可证）。
prompts 升级：`draft-talking.md v2 / lines-cast.md v2`；`lines-timing.md` 标注为 estimated 兼容模式专用（不删）。

> 范式注记：如需「驳回后仍需复检」，模板层拆两步承接（初稿步 + 定稿复检步）——M2 偏差 #1 的模板层解法；`remember` 为分支叶子步骤（无下游），引擎就绪集调度天然支持，实施时以一次实跑确认。

### 9.3 T3「萌宝短剧·单集 v3」（mengbao-episode version: 2 → 3）

与 v2 差异：

```yaml
inputs: + with_character_refs (bool, default false)  # 生成定妆照并入档（成本开关）
steps:
  - ingest_docs / write_script          # 不变（write_script 保留 gate1）
  - char_profile       # [新] ai_text（characters-json）：从剧本+设定提取角色档案
  - ref_prompts        # [新] ai_text（storyboard-json）：每角色 1 条定妆图 shot（id=角色名）
  - gen_refs           # [新] ai_image, when with_character_refs == true, batch max_concurrent 1
  - sync_characters    # [新] character_sync, after: [char_profile, gen_refs]
  - make_storyboard    # 不变步骤，prompt 升级 v2（shot 增 characters: [] 出场角色名）
  - gen_images         # ai_image（注入升级自动生效：shot.characters × 角色库 → 外观锚定）
  - gen_motion         # ai_video（不变）
  - compose_video      # ffmpeg_merge（不变）
```

验证点：角色建档（Web 角色页可见，含定妆照引用）；gen_images task.prompt 快照含「角色锚定：…」注入文本（硬证据）；with_character_refs=false 时同步/注入路径仍完整（无图建档）；静态/动效分支无回归。
prompts 新增：`char-profile.md / ref-prompts.md`；升级：`storyboard-ep.md v2`（+characters 字段）。

### 9.4 prompts 总清单

- 新增 6：`draft-note.md / cover-note.md / inline-note.md / publish-note.md / char-profile.md / ref-prompts.md`
- 升级 3：`draft-talking.md / lines-cast.md / storyboard-ep.md`
- 不动：`script-ep.md / cover-talking.md / lines-timing.md`（兼容模式保留）

---

## 10. 里程碑验收（M3 exit criteria，可测）

1. **记忆基建**：模型就绪脚本执行后 `GET /memories/status` 返回 modelDir/维度；写入 3 条中文记忆 → 用**近义表达（非字面）**检索 top1 命中语义对应条（向量有效而非字面匹配）；重建索引 total/rebuilt 正确。
2. **记忆 action 链路**：T2/T1 首次 run：recall 空结果正常流转（占位资产）；remember 落库（Web 记忆页可见）；**第二次 run：recall 命中上次样本**，且本次 draft 的 `asset.prompt` 快照含召回内容（注入硬证据）。
3. **角色库**：T3 跑一次（`with_character_refs=true`，小样）→ 角色页建档可见（含定妆照关联）→ 断言 gen_images 至少 1 个 task 的 prompt 含「角色锚定」文本与 negative（快照证据）；同项目第二次 run 角色注入仍生效（跨 run 一致性）；`with_character_refs=false` 分支亦可建档。
4. **音频情绪**：构造 3 句带 speaker/voice_hint/emotion_hint 的 lines 跑 tts → `asset.params` 含 `{speaker, voice_source, emotion_key, emotion_hint, emotion_sent}`（**必须可证**）；若实例声明 emotion_param → 断言请求透传（有支持实例时为强判据，无则记「机制就绪待实例」）；字幕正文无「声线；情绪」括注残留。
5. **音画精确对齐**：T2 成片 ffprobe：① 音频总时长 ≈ Σ 单句 probed 时长（±0.5s）② SRT 末条 end_ms ≈ 音频总长（±1s）③ 抽选第 1/末句：字幕显示窗口与该句音频起止一致（±0.5s，SRT 对照或抽帧 OCR）。
6. **T1 图文跑通**：真实 run：draft gate 审阅（approve + reject 回流各 1 次）→ 封面 1 张 → publish.md（含标题/标签）；with_inline_images=false 时 inline 分支正确 skipped、publish 正常；开启时配图 batch 成功。
7. **T2 v2 跑通**：with_voice=true 全链路 completed（成片含音轨+字幕）；with_subtitle_review=true 实测字幕 gate 挂起 → skip_label 或 approve；with_voice=false 纯字幕版产出 estimated SRT（无音频依赖）。
8. **T3 无回归**：mengbao v3 静态分支（motion=false, with_character_refs=false, with_storyboard_review=false）复跑通过，执行路径与 M2 同构；motion=true 分支保持可用（不强制实跑出片，可复用 M2 证据 + 快照兼容）。
9. **跨体裁复用率（出口问题 1）**：提交三模板 action 使用矩阵与复用率数字（口径：模板步骤中非该体裁新引入 action 的占比——预期 T1 为 100%、T2/T3 仅记忆与角色步为跨模板共享的新增），写入 review。
10. **README + 无回归**：README 更新（记忆/角色页、模型部署路径、note-clip/talking v2/mengbao v3 速览、回归路径新增图文项）；三模板新增 prompt 全部外置可管（模板页/prompts 页体检通过）。

---

## 11. 出口校准与演进注记

| 项 | 状态/决策 |
|---|---|
| 出口问题 1（跨体裁 action 复用率） | 验收 9 的矩阵数字作答；核心判据：新增图文体裁 T1 **零新 action**、口播 v2 仅增记忆/字幕编排（action 复用）、短剧 v3 复用既有 ai_text/ai_image 载体 |
| 出口问题 2（记忆是否真实提升一致性产出） | 作答策略：① 机制证据（验收 2/3 的 prompt 快照注入链）+ ② 召回质量（验收 1 近义命中）+ ③ 一致性观察（同选题 T1 二次 run 对比口径/人设词与摘要样本的贴合度，人工记录）。**明确局限**：单机小样本无统计显著性，结论仅作方向性判断，写进 review |
| 音频情绪落地边界 | 情绪参透传依赖 provider 能力（实例声明制）；无支持实例时以「字段贯通 + 记录可证」交付，M4 若接「视频+音频同出」模型则情绪短语直接进提示词（方法论已备） |
| 三层记忆/摘要压缩 | Backlog（M3 只做向量召回一层，验证价值后再评估） |
| 角色语义检索 / 参考图 i2i / 联网热点 | Backlog（新需求走北极星三问） |
| 模型中文效果 | 已确定 bge-small-zh-v1.5（用户确认，2026-09-10）；实施时完成 ONNX 获取与中文召回冒烟（验收 1 的近义检索即冒烟），all-MiniLM 仅离线兜底 |
| talking-clip 文件注意 | 实施 T2 时以工作区**当前最新文件**为基准增量编辑（version 1 → 2），不得以历史版本覆盖 |

---

## 12. 参照物速查

- 记忆参照：`Agent/Toonflow-app/src/utils/agent/{embedding,memory}.ts`（本地 ONNX 加载 / vectorSearch / upsert 与召回语义）；模型目录实例 `Agent/Toonflow-app/data/models/all-MiniLM-L6-v2/`（config/tokenizer/onnx 结构）
- 角色参照：`Agent/Toonflow-app/src/routes/script/extractAssets.ts`（角色提取与去重入库的交互形态）+ `Skills/AI视频创作/video-storyboard/SKILL.md`（定妆照→参考图→压测的视觉锚定方法论）
- 图文方法论：`Skills/自媒体/media-writer/SKILL.md`（三形态/选题点单/事实溯源/禁用词）+ `mode-note.md`（小红书短图文结构）
- 口播方法论：`Skills/AI视频创作/video-script/mode-video.md`（创意概念/逐句文案/视觉基调三件套）
- 音频情绪口径：`docs/superpowers/plans/2026-09-05-content-suite-audio-emotion.md`（Plutchik 24 词体系表 / 24 词×六维映射库 / 5 套场景模板 / 台词形态 `{角色}（{声线短语}；{情绪短语}）：「{台词}」`）
- 账号档案实例：`内容创作/萌宝IP/input/profile.md`（形象锚定 + 免漂移负向词 + 人设定位——characters 表 appearance/negative/voice 的字段来源）
- 改造点代码：`apps/server/src/pipeline/actions/{tts,subtitle,ai-image}.ts`、`services/ffmpeg.ts`（probeMediaDuration 已就绪）、`services/tts.ts`、`db/schema.ts`、`pipeline/actions/index.ts` + `loader` 双处注册
- 体例参照：`2026-09-09-agencys-content-studio-m2-design.md`
