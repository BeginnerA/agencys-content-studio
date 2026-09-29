# 内置模板详表

19 个内置模板（`workspace/templates/*.yaml`）逐一说明与典型工作流链。模板分**两类入口**：「启动流水线」（专业端场景选卡，按 出成品 / 做规划 / 发布与复盘 三组呈现）与「轻松创作」（对话式立项页）。三个 `easy-*` 模板**仅由轻松创作对话页在方案确认后内部调度**，不出现在「启动流水线」选卡（其入参为对话页生成的 `recipe` 执行快照，手动启动无 `script/lines/shots/recipe` 无法运行）。模板均可独立运行，亦可按链串联。

**内置 vs 自定义（改删权限）**：上表 19 份模板与 `workspace/prompts/` 出厂提示词均为**系统内置**，前端只读、服务端拒绝修改/删除（409）——真源是 `apps/server/src/pipeline/builtin-assets.ts` 的清单。要定制内置资产，用模板页的「**另存为副本**」（或画布编辑落盘）派生出一份**自定义模板**（新 key、不登记于清单），即可自由编辑/删除；提示词则新建自定义 `.md` 后在自定义模板中改引用。新增体裁 / 新流程 = 自定义模板 YAML（模板页保存即生效，无需改代码、无需重启）。

## 内置模板

下表标注各模板的方法论来源（对应「内容创作者套件」技能）；模板可独立运行，亦可按「典型工作流链」串联。

| key | 场景 | 要点 | 方法论来源 |
|---|---|---|---|
| `topic-radar` v1 | 选题雷达（other） | 多维评分（需求势能 / 竞争密度 / 账号适配 / 长尾价值）+ 历史选题去重 + 常青生成 + 回灌调分；热点素材以导入替代联网采集 | 选题雷达 |
| `video-plan` v1 | 创作策划（drama_short） | 五节策划案（题材定位 / 人物小传 / 爽点结构 / 视觉基调 + Look Dev / 单集节奏）+ 弧光机械核对 + 导演三视角（观众 / 平台 / 成本）自检 | 创作策划 |
| `series-setup` v3 | 整剧立项·设定包（drama_short） | 整剧设计书 + 设定包四件（总设定 / 角色卡 / 世界观 / 场景视觉卡）+ 分集地图；单集正文回 `mengbao-episode` 逐集展开（token 取舍）；复用角色一致性链；v2 新增场景/道具档案链（`set_profile` 档案 → 素材提示词 → 参考图生成（`with_set_refs`）→ `entity_sync` 建档）；v3 定妆照与场景/道具参考图两步出图后均挂人工审阅闸（required + 可跳过，废图先重出再建档，防污染后续全部出图） | 剧本创作 |
| `mengbao-episode` v12 | 短剧·单集（T3） | 双闸门（剧本必审 + 分镜可选审）+ `motion` 互斥分支 + **角色一致性链**和**配音字幕链**（原有）；v4 三条审阅开关：`with_deep_review` / `with_narrative_doc` / `with_edit_review`；v5 新增 `with_voice`（默认开）：台词切句（`lines-cast-ep.md`）→ 逐句配音 → measured 精确字幕 → `fit_voice` 多镜时长按配音总长均分（成片与音轨等长）；v6 新增 `i2v`（默认关，需 `motion=true`）：`gen_frames` 首帧图步骤 + `gen_motion` 首帧驱动与 `motion_prompt,image_prompt` 回退链（出图+视频双计费）；v7 增 `compose_video.shots` 输入：镜头工作台 per-shot 时长覆盖 + 选镜拼接消费，逐镜缺文件 skip+warn，存量 v6 run 行为等价；v8 新增场景/道具参考链（`with_set_refs` 开关 + set 四步 `set_profile` → `set_ref_prompts` → `gen_set_refs` → `sync_set`），出图按 `location`/`props` 注入场景/道具锚定与参考图；v9 新增台词归属链（`make_storyboard` 消费 `cast_lines` 台词表 + 每镜 `lines` 声明）与 `compose_video` 转场 / BGM 四键默认值；v11 全部四个出图步（定妆照 `gen_refs` / 场景道具参考图 `gen_set_refs` / 镜头图 `gen_images` / 首帧图 `gen_frames`）挂人工审阅闸（required + 可跳过），暂停期可在镜头工作台重出单镜（仅该镜计费），避免单张废图带崩后续建档/合成/图生视频等付费环节；**v12 集间承接**：新增选填输入 `prev_script`（files）直注 `write_script`——多段工作流链段 inputSpec `{ prev_script: "$prev.asset:script" }` 自动把上一集剧本灌入本集（files 类预填永不自动回填，手动启动需用户选资产，首集留空）；`script-ep.md` v5 同步新增 R18 上集剧本承接铁律（开场无缝衔接结尾悬念 + self_check 上集衔接项） | 剧本创作 + 分镜提示词 |
| `talking-clip` v4 | 对白口播·单条（T2） | 记忆闭环 + 账号档案 + 逐句情绪配音 + measured 精确字幕（原有）；v3 `platform` 感知与 `with_platform_copy` 视频发布文案步骤（标题 / 话题 / 简介）；v4 新增双合规末步（`with_compliance` 默认开：口播稿 `compliance` + 平台文案 `compliance_platform_copy`，词库 block 级拦截） | 内容编排 + 平台适配 |
| `quick-video` v2 | 快速单片视频（talking_head） | 一句话创意极简输入 + 闸门默认关闭（`confirm` 开才审）+ 封面图兼成片背景单图成片；v2 新增 `compliance`（脚本合规，默认开）——因本模板默认免审直出，合规门置于 draft 后、配音/出图等付费步之前，block 命中即止损；定位热点跟拍快出片 | 内容编排 + 文字创作 |
| `note-clip` v3 | 图文笔记·单篇（T1） | 记忆召回 → 主稿（gate）→ 封面 + 可选内页配图 → 发布稿（原有）；v2 新增 `to_platforms` 多平台适配步骤（when）；v3 新增 `compliance` 发布稿合规末步（`with_compliance` 默认开） | 文字创作 + 平台适配 |
| `article-clip` v2 | 深度长文（article） | 长文主稿（结构完整 / 逻辑论证 / 事实溯源）+ 可选内页配图 + 多平台适配 + 发布稿（标题定稿 + 封面文案 + 溯源检查；对齐 note-clip 模式）；v2 新增 `compliance` 发布稿合规末步 | 文字创作 + 平台适配 |
| `platform-adapt` v3 | 平台适配（other） | 八平台（公众号 / 小红书 / 知乎 / 头条 / 抖音 / 快手 / 视频号 / B站）标题 / 正文 / 话题 / 封面文案规则 + 事实不变性铁律 + 风险处标注不静默删改；v2 新增 `target_lang`（缺省 zh 现状不变；en/ja/ko 等适配稿以目标语言产出）；v3 新增 `compliance` 适配稿合规末步（`with_compliance` 默认开） | 平台适配 + 翻译出海 |
| `translate-export` v1 | 翻译出海（other） | 入库 → 全文翻译（`translate-text.md`，产物 `translated-{lang}.md`）→ 译文沉淀记忆（type=translation 供后续同系列复用）；M24 翻译链独立形态 | 翻译出海 |
| `review-restock` v1 | 盘点复盘（other） | 数据解读（完播 / 互动 / 涨粉结构）+ 置信门禁（样本不足降级结论并标注）+ 回灌选题入记忆（供 `topic-radar` 调分闭环） | 盘点复盘 |
| `novel-adapt` v2 | 小说改编·切分→图谱→剧本（plan） | 小说入库 → 章节切分（三级正则链 / 卷识别 / 范围过滤，可审阅）→ 逐章事件提取（批量）→ 事件图谱归并 → 分集规划（可审阅）→ 逐集改编剧本（批量）；产物对齐 `script-ep` 格式，可接力短剧链；**v2（M25·G1）**：accept 扩 [.txt,.md,.docx,.epub]（入库单点转 md，原二进制不落盘）；支持 `per_source` 多部合并与 `/novel/append` 增量连载 | 内容编排 + 剧本创作 |
| `novel-audit` v1 | 改编一致性回查（plan） | 章节 + 剧本 → `adapt_audit` 批量 LLM 审计（omission/alteration/addition/order 差异 + severity）→ 差异报告 md（purpose=audit_report）；独立形态不侵入 novel-adapt 现链 | M25·G4 |
| `video-reverse` v1 | 视频反推链（drama_short） | 视频入库 → `video_analyze`（抽帧≤24 + ASR 音轨转写含宽容降级 + 多模态时间轴 JSON）→ 分镜反推（storyboard-json，必审门控，直通 `ai_video` 消费契约）→ 文案包；M25·G9/G10 | M25·G10 |
| `image-reverse` v1 | 图片反推链（note） | 图片入库 → `image_analyze`（等比缩宽 ≤1280 临时编码含原图回退 + 多模态 LLM 逐图反推主体/风格/构图/光线/色板 → 可投产 image_prompt/negative_prompt，必审门控，产物 json+md 双资产 purpose=image_analysis）→ 文案包（标题/描述/话题/逐图配文）；原图只读不改，video-reverse 同源图片形态 | 同 video-reverse 反推方法论 |
| `photo-montage` v1 | 素材混剪成片（other，M53） | 现成照片/视频 → 一支完整成片，**全程零 LLM 零付费**（婚宴大屏 / 纪念册 / 快闪成片类场景）；photos+clips 双输入按「照片在前」混排，引擎两段式混剪（M53）：逐段归一化（Ken Burns 缓推 alternate/in/out + 定长带音轨临时 mp4）→ 轻量拼接合成（fade 等转场、视频原声保留 keep_clip_audio 与配音/BGM 并存混音）；定长字幕 mode:fixed（标题/台词行零 LLM 计时）；每镜时长/帧率/分辨率/KB 模式经标量调参桥直连 run 输入（分辨率/照片缓推动效为下拉单选，缓推项显中文含义如“缓推（由远及近）”），BGM 经合成设置上传；成片审阅闸（confirm 默认开） | M53（无外部技能，纯本地 ffmpeg） |

**轻松创作专用模板**（`CREATION_TEMPLATE_KEYS`，仅由 `easy-create` 对话页在方案确认后内部调度，**不出现在「启动流水线」选卡**；它们是「纯执行已批准方案」的批准链载体：全步 `retry:0` + `strict_delivery`、不自动付费重试，`recipe` 钉死 `templateHash`/端点/素材来源供恢复校验）：

| key | 场景 | 要点 |
|---|---|---|
| `easy-video` v1 | 轻松创作·旁白成片 | 输入=对话页已批准的脚本/旁白/分镜/recipe；tts → measured 字幕 → 图文/首帧出图 → 动态镜头（i2v）→ 严格合成（无角色一致性/风格预设注入，交付以批准方案为准） |
| `easy-video-review` v1 | 轻松创作·旁白成片（首帧审阅） | 与 `easy-video` 步骤逐字同构，仅在画面/首帧生成后挂人工审阅闸，确认后才开始动态镜头等高费用生成 |
| `easy-dialogue` v2 | 轻松创作·人物对白成片 | 原生音画人物交谈（`motion` 走 `ai_video` 原生对白）→ `dialogue_subtitle` 逐镜原声 ASR 核验与实测字幕 → 原声合成；**v2 已将原 `easy-dialogue-review` 合并入本模板**：`frames` 首帧后强制人工审阅（确认后才开始对白视频及 ASR 等付费生成），`compose` 末步再强制审阅台词/角色/口型（i2v=false 时 frames 步跳过→仅保留末审阅） |

**典型工作流链**（`review-restock` 回灌记忆 → `topic-radar` 召回调分，构成「选题 → 生产 → 复盘 → 回灌」闭环；模板均可独立运行）：

| 内容形态 | 链路 |
|---|---|
| 短剧 | `topic-radar` → `video-plan` → `series-setup` → `mengbao-episode`（逐集）→ `platform-adapt` → `review-restock` |
| 小说改编 | `novel-adapt`（小说 → 分集剧本）→ `series-setup` → `mengbao-episode`（逐集）→ `platform-adapt` → `review-restock` |
| 口播 / 快片 | `topic-radar` → `talking-clip` / `quick-video` → `platform-adapt`（或模板内 `with_platform_copy`）→ `review-restock` |
| 图文 / 长文 | `topic-radar` → `note-clip` / `article-clip` → `platform-adapt`（或模板内 `to_platforms`）→ `review-restock` |
| 参考图复用 | `image-reverse`（参考图 → 提示词包/文案）→ `image_prompt` 直通 `note-clip` 配图 / 文生图链；`video-reverse` 为同形态视频版 |
| 素材混剪 | `photo-montage`（现成照片/视频 → 成片，独立运行不经任何 LLM 链；热点图可前置 `image-reverse` 仅作文案参考） |

## 成片精剪接力（M50）

任何产出成片（`compose_video` / `ffmpeg_merge` 步有 `final_video`）的模板，运行详情页成片卡与轻松创作成片区均可一键「**导出剪辑工程**」，把成片导出为**多轨工程**（V1 镜头序 · 逐句对白/配音轨 · BGM 轨 · SFX 轨 · 字幕轨）到外部剪辑软件继续精剪。**单向导出**：不支持工程导入回读、不自建多轨时间轴 UI、不支持剪映私有 draft 格式、不做云端直传。三种标准工程按目标软件择一：

| 工程格式 | 目标软件 | 轨道 / 分层 | 降级面（须注意） |
|---|---|---|---|
| **FCPXML**（1.10） | 剪映专业版 / Final Cut Pro / DaVinci Resolve | 全：视频 + 对白 + BGM + SFX + 字幕 + 转场 | 剪映对 FCPXML 的支持随版本漂移（社区口径、非官方承诺）→ **以实际版本实测为准**；不达标回落 EDL / OTIO |
| **EDL**（CMX3600） | Premiere / Avid | 仅 V 序列 + AA 旁白混音轨 + Dissolve | **Premiere 不吃 FCPXML → 用 EDL**；无字幕 / SFX / BGM 独立分层（EDL 语义上限，包内 README 声明） |
| **OTIO**（JSON） | DaVinci Resolve / 程序化管线 | 全：Video / Dialogue Audio / Music / Effects / Markdown | 需 Resolve 或支持 OTIO 的管线 |

口径与降级：帧率取成片时间轴快照 fps、时码非丢帧（NDF）；`native_dialogue`（原生对白）成片音画同体，导出仅有视频轨 + 估算字幕、无独立配音轨（如实降级）；`include_media=false` 可出「纯工程 + manifest 清单」不复制媒体（工程按 manifest 在别处定位素材）。时间轴真源为合成期落库的 canonical 快照，存量无快照成片按同源逻辑重算，重算失败提示「重新合成后再导出」。

新增体裁 / 新流程 = 在模板页「另存为副本」派生自定义模板后编辑其 YAML（自定义模板保存即生效，无需改代码、无需重启）；系统内置模板与内置提示词只读，不可直接改删。
