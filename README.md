# agencys-content-studio

个人内容创作平台：模板化流水线 + 统一资产 + 供应商适配层（本地单机 Web）。

- 状态：M1 骨架闭环 ✓；M2 流程引擎化 ✓；M3 记忆与角色一致性 ✓；**M4 打磨分发完成**（E1 批量运行 / E2 成本与用量 / E3 导出分发 / E4 复盘数据 / W1 Web 配套）；**M5 方法论内化完成**（内容创作者套件 8 技能 → 10 模板家族 + 24 个提示词文件；引擎零代码）；**M6 参考图驱动**（定妆照参考链 + 首帧 i2v + 模板/提示词升级；代码与探针全绿，实弹待跑）；**M7 镜头工作台**（镜头级轻工作台 + 选镜拼接 + per-shot 时长与逐镜容错；代码/模板/探针全绿，实弹目检通过——Run 40/61 全链：编辑/重生成/选片/剔除/逐镜容错/重新合成 + 浏览器截图）；**M8 场景/道具资产库 + 风格预设**（实体单表多态 + 场景/道具参考链 + 风格预设库与运行时注入；代码/模板/探针全绿，实弹目检待跑）；**M9 小说改编链**（小说导入 → 章节切分 → 逐章事件 → 事件图谱 → 分集规划 → 逐集剧本；新 action `text_split` + ai_text batch 扩展 + 模板 `novel-adapt` v1 + NovelBoard 看板；代码/模板/探针全绿，实弹 Run #100 全链通过）；**M10 镜头分镜编辑器 + 上传替换**（镜头拖拽重排 / 分镜大编辑器 / 上传图片替换分镜 + stale 兜底强化；代码/模板/探针全绿，实弹 Run 61 全链通过）；**M11 单步重跑 + 镜头级音字对齐 + BGM·转场**（rerun 端点 + 台词归属链 + compose 配置快照；代码/模板/探针全绿，实弹六步全通过）；**M12 旧版本清理与收藏 + 图像检测**（软删/回收两段式 + 三重保留 + 宽容降级检测；探针 66 项全绿，实弹全通过）；**M13 素材链补全**（视觉提取 / 多预设叠加 / 视频参考图 / 上传通道 / 批量润色 / states 入库；探针 121 项全绿，实弹七项 7/7 + DOM 22/22）；**M14 平台层收官**（集级参数覆盖 / 剧集地图 / 静态托管；桌面端经决策取消；探针四节全绿，实弹 DOM 14/14）；**M15 流水线画布工作台**（依赖语义单一真源 + 画布读模型纯读 + 画布即工作台〔节点/边/状态/闸门/重跑/重新合成/日志抽屉〕；探针 78 项全绿，实弹 DOM 两轮全通过）；**M16 创作画布**（素材自由摆放 + 引用连线 + 就地生成与编辑〔声明制〕+ 联动三枚 + 低保真模板草案；首次引入画布文档新表〔canvases / canvas_nodes / canvas_edges〕；探针六节 126 项全绿，实弹全通过——含真实出图 ×2、模板草案与编辑通道退化验证）

## 技术栈

Node 20+ / TypeScript / Hono / Drizzle + libsql / Socket.IO / fflate（导出 zip）/ ffmpeg-static（内置 ffmpeg/ffprobe 二进制，系统安装可选）/ Vue3 + Vite（原生 CSS）/ pnpm workspace

## 快速开始

```bash
pnpm install    # 自动下载内置 ffmpeg/ffprobe 二进制（ffmpeg-static / ffprobe-static，约 150MB）
# 复制 .env.example 为 .env 并填入 AGENT_LLM_API_KEY（其余供应商密钥在 Web「AI 配置」页录入）
pnpm dev    # 并行起双端：
            #   server  http://127.0.0.1:3001（API + Socket.IO + health）
            #   web     http://127.0.0.1:5174（vite dev，/api 与 /socket.io 已代理）
```

首次启动自动建库（drizzle migrate）与 seed（供应商目录）。密钥只存 `data/secrets.json`（0600），不入库不进 git。

## 从场景入口开始：一看就懂的上手指南

> 记不住模板名？不需要。打开「启动流水线」，按“我想做什么”选一张**场景卡**即可——10 个模板按 出成品 / 做规划 / 发布与复盘 三组呈现。

**四步上手**：

1. **建项目**：项目列表「新建项目」→ 填项目名 + 体裁 + 简介 brief（作为全部创作上下文）。体裁会自动预选对应默认模板（短剧→短剧·单集 / 图文→图文笔记 …），两者可在项目页「编辑」中随时改。默认模板 = 该项目最常跑的模板——「批量运行」会替你预选好，「启动流水线」场景卡上它会挂「默认」徽章
2. **启动流水线**：项目页「启动流水线」→ 弹窗先展示场景卡片（不再默认替你选模板——先想清楚这次要产出什么）
3. **选卡 → 填输入 → 启动**：点卡片进入表单（可「← 重选模板」返回）；必填项齐全后「启动」，自动跳运行页
4. **过闸门 → 取产物**：时间线推进到「等待审阅」时，预览产物并 批准 / 驳回（附意见）/ 免审放行；完成后产物可预览、右栏「导出发布包」一键打包

**场景对照表**（我想做什么 → 选哪个）：

| 我想做什么 | 场景组 | 模板 |
|---|---|---|
| 把素材 / 想法做成图文笔记 | 出成品 | 图文笔记 `note-clip` |
| 写一篇深度长文 | 出成品 | 深度长文 `article-clip` |
| 做一条口播视频 | 出成品 | 对白口播 `talking-clip` |
| 跟热点快速出一条视频 | 出成品 | 快速视频 `quick-video` |
| 跑一集短剧 | 出成品 | 短剧·单集 `mengbao-episode` |
| 不知道做什么选题 | 做规划 | 选题雷达 `topic-radar` |
| 做整剧策划案 | 做规划 | 创作策划 `video-plan` |
| 整剧立项 / 设定包 | 做规划 | 短剧立项 `series-setup` |
| 一份内容适配多平台 | 发布与复盘 | 多平台适配 `platform-adapt` |
| 复盘数据、回灌选题 | 发布与复盘 | 复盘回灌 `review-restock` |

**闭环链路**（选题 → 生产 → 适配 → 复盘 → 回灌）：

`topic-radar` 选题 → `note-clip` / `article-clip` / `talking-clip` / `quick-video` / `mengbao-episode` 生产 → `platform-adapt` 适配（或模板内 `to_platforms` / `with_platform_copy` 步骤）→ `review-restock` 复盘回灌 → 回到 `topic-radar`

**完成态「下一步建议」**：run 完成后，运行页顶部出现推荐下游 chips（由模板 `next` 声明，如选题雷达完成 → 「去图文笔记 / 去深度长文 / 去创作策划」）；点击直达该模板的表单，启动即接力。failed / cancelled 不显示（先「断点续跑」或重跑）；模板均可独立使用，`next` 只是推荐、不是强制串链。

## M2 能力速览

- **编排语义**：步骤 `after` 显式依赖 + 就绪集并行（进程内并发 ≤2）；`when` / `when_any` 条件跳过（依赖全跳过自动传播）；`skipped` 状态全链路（落库 / 事件 / UI 灰显 + 原因 badge）
- **模板快照**：run 创建时固化模板正文（`template_snapshot`），在线改模板不影响运行中 run 的续跑语义（M1 存量 run 无快照时回退当前模板文件）
- **断点续跑（resume）**：failed / cancelled run → 新 run 继承快照；succeeded / skipped 步骤保留，未完成 gen_task 迁移重置重跑（幂等复用已产资产，不重复计费）
- **Gate 三态**：批准（可带修改稿 text_override）/ 驳回（意见回流 LLM 重跑）/ 跳过（模板声明 `skip_label` 才出现，免审放行、产物保留、记 `user_skip`）；`gate.when` 条件门（不满足免审直过）
- **action 面**：`ai_video`（轮询型视频供应商任务化）/ `tts`（OpenAI 兼容 `/audio/speech`）/ `subtitle`（LLM 对白切句估时 → SRT）/ `ffmpeg_merge` 三流合成（镜头流 + 人声轨 + 字幕烧录）
- **模板与提示词在线管理**：`/templates` 页 — 列表 / 新建 / 编辑（YAML 校验内联报错，不合法不落盘）/ 复制 / 删除（被项目引用 409）；prompts 同页管理；workspace 文件为唯一事实源

## M3 能力速览

- **记忆（E1/E2）**：本地向量记忆（`bge-small-zh-v1.5` ONNX 推理，512 维，零联网）+ `memory_recall`（向量召回 → text 资产，下游 ai_text 注入即生效）/ `memory_write`（具名滚动 upsert，同 project+name 覆盖不膨胀）两个 action + Web 记忆页（列表 / 筛选 / 语义检索 / 编辑 / 重建索引）
- **角色一致性（E3）**：`character_sync` 建档（档案 + 定妆照引用入库，跨 run 保持）；`ai_image` 逐镜读 `shot.characters[]` 自动注入「角色锚定 + 免漂移负向词」（prompt 快照可溯）+ Web 角色页（全局 / 项目域）
- **音频情绪（E4）**：声线六级解析链（含角色库声线基准）+ 情绪基调提取（Plutchik 口径）+ 实例声明制透传（`emotion_param / emotion_map`），`asset.params` 六字段全链记录；字幕正文剥离「声线；情绪」括注
- **音画精确对齐（E5）**：`subtitle` measured 模式（逐句 ffprobe 实测 → 程序化切显示行 → 累计时间轴 SRT），逐句首尾相接；voice 缺失自动回退 estimated（LLM 估时）
- **新体裁 T1 图文**：`note-clip` 零新 action（图文体裁 action 复用率 100%），记忆召回/沉淀 + gate 审阅 + 封面 + 可选内页配图 + publish 发布稿（标题/标签/配图顺序/溯源检查）

## M4 能力速览

- **批量运行（E1）**：`batches` 表 + 进程内调度服务（串行默认，可配并发 1–3）；项目页「批量运行」= 一组输入一行（支持批量粘贴 JSON）；批次页 = 进度 / 取消 / 批量导出；gate 挂起自动暂停推进（计入活跃槽）；崩溃重启后 reconcile 继续按调度推进
- **成本与用量（E2）**：`usage_records` 通用表 + LLM usage 零破坏捕获（tokens_in/out 两行）+ 图像/视频/语音 action 埋点；Settings「用量单价」表格编辑器（记录时快照，改价不改历史账）+ 未计价引导；`GET /stats/usage` 八种分组聚合
- **导出分发（E3）**：发布包 zip（manifest.json + video/cover/text/other 分目录，fflate 流式 store）；运行页导出向导（产物勾选、默认全选、包名可改）+ 导出包区块（下载/删除）；批次页批量导出（有产物 run 逐一打包，无产物 skip）
- **复盘数据（E4）**：`/stats` 运行看板（概览卡 / 近 30 天活跃趋势手绘 SVG / 成本构成按 kind、按 provider_model 切换 / 项目对比表）；`publications` 发布登记（六平台 / 链接 / 手工指标），运行页与项目页双入口
- **事件链路修复**：socket 单通道 `studio.event` 前端 byType 分发（修复断链）；`batch.updated` 事件增量刷新批次页

## M5 能力速览（方法论内化）

- **模板家族 ×10**：外部「内容创作者套件」（8 技能：选题雷达 / 创作策划 / 文字创作 / 剧本创作 / 分镜提示词 / 平台适配 / 盘点复盘 / 内容编排）方法论平移为 studio 原生模板（见下表「方法论来源」列）
- **提示词体系**：+12 新 / 10 升——套件编号术语（R15 AI 味黑名单 / R16 钩子·反转·可剪辑性 / R17 整剧演进）作为自查清单标签内化；大方法论浓缩为检查清单（单文件 ≤ 约 12KB）
- **闭环设计**：`review-restock` 回灌选题写入记忆 → `topic-radar` 召回调分（「选题 → 生产 → 复盘 → 回灌」闭环）；平台适配两种形态——独立模板 `platform-adapt` + 模板内 when 步骤（`note-clip.to_platforms` / `article-clip.to_platforms` / `talking-clip.with_platform_copy`）
- **零代码证据**：全部改动为 `workspace/templates/*.yaml` + `workspace/prompts/*.md`；10 模板仅用既有 10 类 action 组合

## M6 能力速览（参考图驱动）

打通「已生成图像资产 → 后续生成请求」的参考图通道：视觉一致性从「纯文字锚定」升级为「文字 + 视觉双锚定」，M5 遗留的「首帧图法 i2v」成为全自动链路。

- **图片侧·定妆照参考链（P1–P3）**：`gen_images` 逐镜把命中角色的定妆照（`refAssetIds` 快照）转 data URI 注入文生图请求；gemini / volcengine（Seedream）/ aliyun_qwen / aliyun_wan（同步分支）已就绪；单图 8MB 守卫 + 每镜上限 4 张 + `use_character_refs` 步骤参数（默认开）；任务 params 增 `refUsed` 溯源
- **视频侧·首帧图生视频（P4）**：`ai_video` 新增 `first_frame` 输入（按 `params.shotId` 匹配分镜图 → data URI 首帧）；minimax / siliconflow / aliyun_wan 已就绪、volcengine 首帧 role 扩展；`prompt_field` 支持逗号回退链（如 `motion_prompt,image_prompt`）；任务 params 增 `firstFrameAssetId` 溯源
- **模板接线（P5）**：`mengbao-episode` v6 新增 `i2v` 开关 + `gen_frames` 首帧图步骤（独立步骤绕开 compose 互斥硬校验）；三模式自动正确——静态图合成（motion=false）/ 轻量 t2v（motion=true, i2v=false）/ i2v 首帧接力（motion=true, i2v=true）
- **提示词（P6）**：`storyboard-ep` v5 新增 `motion_prompt` 动效提示词字段（运镜 + 动作过程；静态禁词仅约束 image_prompt）+ 三模式消费说明；存量分镜无 `motion_prompt` 时经回退链自动用 `image_prompt`
- **宽容降级（统一语义）**：供应商不支持（none 家）或图缺失 / 读失败 / 超限 → 丢弃参考物 + `ctx.log` 警告，降级纯文本照常出片；能力判定基于适配器声明（`referenceImages` / `firstFrame` 只读属性），绝不因切供应商炸链路

**参考图能力矩阵**（改造后现状）：

| 适配器 | 图片参考图（refAssetIds） | 视频首帧（first_frame） |
|---|---|---|
| `gemini_image` | ✅ base64（inline_data） | — |
| `volcengine_image` | ✅ base64（body.image 注入） | — |
| `aliyun_qwen_image` | ✅ base64（content 图片项） | — |
| `aliyun_wan_image` | ✅ base64（同步分支；异步 t2i 分支忽略） | — |
| `openai_image` / `siliconflow_image` / `pollinations_image` | ❌ none（降级纯文本 + 日志） | — |
| `volcengine_video` | — | ✅ base64（first_frame/last_frame role；实弹对表后可收敛 as-reference） |
| `minimax_video` | — | ✅ base64（first_frame/last_frame role） |
| `siliconflow_video` | — | ✅ base64（data URI + 自动切 I2V 模型） |
| `aliyun_wan_video` | — | ✅ base64（官方 base64 首帧） |
| `pollinations_video` | — | ❌ none（GET 查询串不适合 data URI） |

验证：`pnpm --filter @acs/server probe:m6`（五 section：asset-ref / capability / match / degrade / contract，零网络零计费）。

## M7 能力速览（镜头级轻工作台 + 选镜拼接）

运行页镜头步（`ai_image` / `ai_video`）内嵌「镜头工作台」：不重跑整条流水线，即可改时长 / 改词重生成 / 多版本选片 / 剔除镜头，随后手动「重新合成」出片。设计三原则：**状态重置 + 引擎复用**（返修 = 重置 task/step/run + `engine.startRun`，幂等对账只重跑目标镜）、**产物即选择**（选片/选镜/编辑 = 改写步骤 `output.asset_ids`，下游引用自动消费，零 schema 变更）、**分镜 JSON 唯一事实源**（编辑写分镜新版本资产 + 产出步骤 output 保位替换）。

- **工作台聚合读**：`GET /runs/:id/shot-board`（镜头 × 任务 × 历史版本 × 当前选中 × 合成新鲜度五合一）+ 返修门禁（run ∈ completed/failed、目标步骤 succeeded/failed、无其他 failed 步骤）
- **时长编辑**：单镜 / 批量（勾选多镜 × 一次提交）；写分镜 `duration`（读取兼容 LLM 分镜 `duration_sec` 口径、编辑时同步双写），(0, 60] 秒校验；重新合成时 per-shot 覆盖 `duration_per_shot`
- **单镜重生成**：改词（可选）→ 重置目标镜 task（`resultAssetId` 保留防孤儿）+ 步骤 pending → 续跑只重跑该镜；日志明示跳过数
- **多版本选片**：「应用选择」提交 picks（分镜序保序；未列入 = 剔除）；「恢复全量默认」= 每镜最新版本；重新合成后成片随之变化
- **重新合成**：`ffmpeg_merge` 手动触发（stale 徽标三态：待重新合成 / 合成已最新 / 不可判定）；逐镜容错——缺文件 / kind 不符 skip+warn 出片（全 skip 才失败），`params.skipped_shots` 溯源
- **模板**：`mengbao-episode` v6 → v7（`compose_video` 增 `shots` 输入；存量 run 行为等价）；motion 路径合成不变；quick-video / talking-clip 不受影响

验证：`pnpm --filter @acs/server probe:m7`（六 section：board / edit / regenerate / select / recompose / merge-plan，零网络零计费）。

## M8 能力速览（场景/道具参考资产库 + 风格预设）

把「角色定妆照」参考链泛化为「实体参考资产库」：角色 / 场景 / 道具三类实体（单表多态）统一建档，`ai_image` 出图时按分镜 `location` / `props` 命中自动注入文本锚定 + 参考图；并新增平台级「风格预设库」——项目绑定风格预设，出图时运行时注入风格片段。设计三原则：**单表多态**（`characters` + `kind` 列，对齐 Toonflow 素材四类）、**快照即硬证据**（文本锚定与参考图 id 全量进任务快照，延续 M3/M6）、**运行时注入 + 宽容降级**（未绑定 / 停用 / 未命中一律零注入 + 日志，绝不炸链路）。

- **实体表泛化**：`characters` 增 `kind` 列（character|scene|prop 单表多态）；`/entities` 统一 CRUD（kind 过滤 / 项目域覆盖全局域 / 别名索引 / 参考图挂接），`/characters` 存量路径兼容；同名跨 kind 隔离
- **场景/道具档案链**：新 action `entity_sync`（`set-json` 文本契约）+ 新提示词 `set-profile.md` / `set-ref-prompts.md` → 场景 / 道具建档（含参考图挂接）；参考图出图 purpose `reference_scene` / `reference_prop`（`output_purpose_by_category` 按类别分派）
- **ai_image 注入扩展**：分镜 `location` / `props` 命中实体库 → 场景 / 道具文本锚定 + 参考图注入（每镜上限 6 张：角色 4 → 场景 1 → 道具 1 保序去重）；未命中 / 超限 / 读失败宽容降级
- **风格预设库**：新表 `style_presets`（平台级通用：name 唯一 / snippet / is_active）+ `/style-presets` CRUD + 项目绑定 `settings.style_preset_id`
- **风格运行时注入**：`injectStyleAnchor` 在 `ai_image` 生成时拼入风格片段（`use_style_preset` 步骤开关，默认开）；任务 params 增 `stylePresetId` 溯源；未绑定 / 停用 / 畸形 JSON → 零注入 + 日志
- **提示词**：`storyboard-ep` v6（`props` 字段 + `location` 库对齐规则）
- **模板**：`mengbao-episode` v7 → v8（set 四步链：`set_profile` 档案 → `set_ref_prompts` 素材提示词 → `gen_set_refs` 参考图（`with_set_refs` 开关）→ `sync_set` 建档，出图挂 `sync_set` 之后）；`series-setup` v1 → v2（同链对齐）
- **Web**：素材页三 Tab 泛化（角色 / 场景 / 道具）+ 风格预设页 + 项目「视觉风格」绑定下拉

验证：`pnpm --filter @acs/server probe:m8`（六 section：migrate / entity / inject / style / api / template，零网络零计费）。

## M9 能力速览（小说改编链）

把长篇小说文本改编为可投入短剧生产链的分集剧本：**小说导入 → 章节切分 → 逐章事件提取 → 事件图谱 → 分集规划 → 逐集改编剧本**（对标 Toonflow 小说链，但把「导入即自动提取事件」显式化为闸门后的流水线步骤——先确认切分质量再花钱）。四段产物全部为通用文本资产（purpose = `chapters` / `events` / `graph` / `plan` / `script`），全链可在 Web 端审阅、断点续跑。设计原则：**通用资产承载业务**（零新表零新列）、**本地优先、AI 兜底**（默认正则链切分，识别失败才由 LLM 生成正则）、**快照即硬证据**（延续 M3/M6）、**模板线性链路**（分集规划内嵌章节事件物料包，逐集剧本直接消费）。

- **章节切分**（新 action `text_split`）：多文件按序拼接 → 三级正则链（用户正则 > AI 生成正则 > 默认链）+ 卷识别 + `chapter_range` 范围过滤 + `min_chapters` 校验 → 章节索引 manifest + 逐章资产（`第NNN章-标题.md`）
- **逐章事件提取**（ai_text batch 扩展）：`batch.field` 读 manifest 章节数组逐项生成（并发 3 / 重试 1）→ `第NNN章-事件.json`（`event-json` 契约）；进度复用 gen_tasks 状态机（任务面板可见）
- **事件图谱 + 分集规划**：`event-graph.md` 归并角色弧光 + key_events（`graph-json` 契约）；`plan-episodes.md` 产出分集规划（每集章范围 + 梗概 + 开尾钩子，`plan-json` 契约）
- **逐集改编剧本**（ai_text batch）：并发 2 逐集生成 `第NN集-改编剧本.md`（含本集梗概 / 人物表 / 场景与对白，对齐 `script-ep` 格式，可经 `next: [series-setup]` 进短剧链）
- **闸门**：切分审阅 / 分集规划审阅默认开（`with_split_review` / `with_plan_review`），剧本审阅默认关（`with_script_review`）；AI 正则兜底开关 `with_ai_split` 默认关
- **Web**：`NovelBoard.vue` 挂载于 text_split 步骤卡（只读四段：章节表含事件状态徽标 / 角色卡 + 关键事件表 / 分集规划卡 / 剧本列表）
- **模板**：`novel-adapt` v1（7 步 + 8 输入，scene=plan，next=[series-setup]）

验证：`pnpm --filter @acs/server probe:m9`（五 section：split / batch / contracts / api / template，零网络零计费）。

## M10 能力速览（镜头分镜编辑器 + 上传替换）

把 M7 轻工作台升级为「可结构性编辑的镜头板」：**镜头拖拽重排**（板面拖动改序）、**分镜可视化大编辑器**（全字段编辑 / 增删镜头 / 拖动排序 / JSON 校验 / 改动计数）、**上传图片替换分镜**（外来图入镜，登记为正式资产）。设计三原则延续 M7：**产物即选择**（分镜 JSON 唯一事实源，一切编辑写分镜新版本 + 产出步骤 `output.asset_ids` 重建保位）、**重建式**（非原位修改，被替换的旧资产仍可从版本组找回）、**上传走正式资产通道**（sha256 去重，复制行语义：relPath 复用 + 新参数行）。

- **镜头重排**（`applyStoryboardOps`）：板面拖拽改序 → 分镜 JSON 新版本资产 + 产出步骤 output 按新分镜序保位重建（未生成镜跳过 / 上传资产按映射保留）；`params` 记 `ops` / `source_asset_id` 溯源
- **大编辑器**（`StoryboardEditor.vue`）：全字段编辑（文本 / 数字 / JSON）+ 增删镜头 + 拖动排序 + 保存前 parse 校验与字段级错误提示 + 改动计数吸附保存；保存仅改写分镜与镜头顺序、不触发生成，重新合成后生效
- **上传替换**（`uploadAndBindShotAsset`）：multipart 上传（200MB 上限）→ sha256 命中复制行（relPath 复用 / 原行不变）→ 登记 purpose `shot_image` / `shot_video` → 绑定目标镜重建 output 并设为当前选中
- **板面扩展**：upload 版本组并入版本列表（`BoardVersion.source` 区分产出 / 上传，显示「上传」角标）+ `BoardShot.raw` 原始字段
- **选片放宽**：允许选入 taskId=null 的本步骤上传资产；跨镜 pick 与非本步骤资产仍拒绝
- **stale 兜底强化**：`computeStale` 在 shots_source 缺失/断链（存量模板快照无 shots 引用、续跑链跨 run 资产引用）时，以「分镜资产晚于成片」保守判 stale=true（不参与 compared 计数，null 语义不变）；重新合成后回归 false
- **API**：`routes/shots.ts` +2 端点（`POST /runs/:id/shots/mutate` 结构性编辑 / `POST /runs/:id/shots/upload` 上传替换；均不触发执行）
- **Web**：`ShotBoard.vue` 镜号把手拖拽重排（插入线提示）+ 「编辑分镜」/「上传替换」入口

验证：`pnpm --filter @acs/server probe:m10`（六节：ops / output / upload / board / select / regression，零网络零计费）。

## M11 能力速览（引擎级单步重跑 + 镜头级音字对齐 + BGM·转场）

把成片生产链升级为「可重跑、可对齐、可配声、可转场」的完整后期能力：**引擎级单步重跑**（对任一步骤就地重跑——成功子任务默认复用零调用，也可全量归零重新执行）、**镜头级音字对齐**（分镜镜头与台词句显式绑定，合成时按实测配音时长重排镜段与字幕时间轴，成片与音轨严格等长）、**BGM 与转场**（成片配乐 + 镜头间过渡，Web 可视化配置并快照进 params 溯源）。设计三延续：**非破坏重跑**（复用模式不动已成功子任务产物）、**配置即参数**（compose 配置在合成时快照，存量 v8 run 行为零漂移）、**宽容降级**（老分镜无 lines / 脏数据 / 空数组均按原口径合成，不阻断出片）。

- **单步重跑**（`POST /runs/:id/steps/:stepKey/rerun`）：默认复用模式（succeeded 子任务保留、仅重置失败 / 未完成，响应含 `tasks_succeeded` 与预计执行数）或 `reset_tasks=true` 全量归零（重新计费）；无子任务步骤整体重执行（提示下游产物不变）；活跃 run（running / waiting_input）拒绝 400
- **镜头级音字对齐**（`ffmpeg-merge` 对齐链）：`make_storyboard` 新增 `lines` 输入（消费 `cast_lines` 台词表）→ 分镜每镜声明 `lines` 台词句 id 数组（`storyboard-ep` v7 契约：每句恰好归属一镜）→ 合成时 `parseShotLines` / `planVoiceAlignedSegments` / `planSrtShifts` 按配音实测时长规划镜段与字幕平移（补镜尾静音 / 空镜 / 句长兜底；老分镜无 lines 自动降级）
- **BGM**（`/runs/:id/compose/config` GET/PUT + `/runs/:id/compose/bgm` GET/POST/DELETE）：上传（multipart + sha256 查重）或绑定既有音频资产；合成滤镜链 `stream_loop → atrim → volume → afade in/out → amix`（循环铺满全片 + 首尾淡入淡出 + 与配音原声混音）；音量 0–1 / 淡入淡出 0–2s clamp；`params.bgm` 溯源
- **转场**：六种过渡（`none / fade / fadeblack / slideleft / slideright / dissolve`）+ 时长 0.1–2s；`xfade` 逐镜衔接（前 n−1 镜段长 +T 补偿，总长不变）；`params.transition` 溯源
- **模板 / 提示词**：`mengbao-episode` v8 → v9（`make_storyboard.after` 增 `cast_lines` + `lines` 输入；`compose_video.params` 增 `transition` / `transition_duration` / `bgm_volume` / `bgm_fade` 默认值 none / 0.5s / 0.25 / 2s）；`storyboard-ep` v6 → v7（台词归属规则）；存量 v8 快照 run 行为不变
- **Web**：`RerunModal.vue`（复用 / 全量二选 + 子任务计数预览）、`BgmModal.vue`（上传 / 绑定 / 移除 + 音量与淡入淡出）、`ShotBoard.vue` 转场行（下拉 + 时长 + 保存设置 + 配乐入口）与台词角标（「台词 N 句」）、`StoryboardEditor.vue` 台词 lines 控件、`RunDetailView.vue` 步骤卡重跑按钮

验证：`pnpm --filter @acs/server probe:m11`（六节：rerun / align / bgm / transition / template / regression，零网络零计费）。

## M12 能力速览（旧版本清理与收藏 + 图像检测）

把素材与版本从「只增不减」升级为「可运营」：**收藏**（工作台版本卡与素材卡一键 ♥，素材页「仅收藏」筛选，收藏同时是清理保留豁免）；**版本清理**（按「保留最新 / 收藏 / 在用」三规则一键清掉历史版本，软删可回溯）；**回收空间**（将已软删资产的磁盘文件显式物理回收，不可逆强确认、行保留审计）；**图像检测**（生成与上传的图片落盘后自动检测黑图 / 纯色空白 / 损坏 / 文件缺失，异常图打警告徽标 + 合成时仅日志警示不阻断）。设计三原则：**软删与回收两段式**（清理只软删、回收才删文件，两级均显式触发）、**三重保留保守防误删**（最新 / 收藏 / 被引用，引用集全项目扫描）、**检测宽容降级**（ffmpeg 不可用不标记；异常图零阻断）。

- **收藏**（零库改动）：`PATCH /assets/:id { is_favorite }` 既有；工作台版本画廊卡 ♥ 与素材卡 ♥ 双入口；素材页「仅收藏」前端筛选；清理中收藏豁免
- **版本清理**（`cleanupVersions`）：组内最新（tie→max(id)）/ 收藏 / 被任意步骤 `output.asset_ids` 引用者保留，其余软删；组键 = 任务组 `t:<taskId>` / 上传组 `u:<run>:<step>:<shot>`；`POST /runs/:id/shots/cleanup`（工作台级）+ `POST /projects/:id/assets/cleanup-versions`（项目级）
- **回收空间**（`gcProject`）：对软删资产 unlink 原文件 + 缩略图缓存（行保留 / 失败跳过 / 幂等）；`POST /projects/:id/assets/gc` → `{ files, freed_bytes }`；UI danger 强确认
- **图像检测**（`image-check.ts`）：ffmpeg signalstats 单帧统计（动态范围极窄 + `yavg<=16` → 黑图；动态范围极窄 → 纯色空白；解码失败 → 损坏；文件缺失 → `no_file`；ffmpeg 不可用 → 不标记）；写 `assets.params.quality`（零新列）；生成 / 上传 / 导入三路径自动检测 + `POST /assets/:id/check` 手动重检
- **展示与守卫**：工作台版本卡 / 素材卡异常徽标（黑图 / 纯色空白 / 损坏）；合成时 `computeShotSegments` 异常图 warnings 仅警示继续出片
- **Web**：`ShotBoard.vue` ♥ + 徽标 + 「清理旧版本」；`AssetGrid.vue` ♥ + 徽标；`AssetPreviewer.vue` 「重新检测」；`ProjectDetailView.vue` 「仅收藏」筛选 + 「清理历史版本」 + 「回收空间」

验证：`pnpm --filter @acs/server probe:m12`（六节：cleanup / imagecheck / gc / board / merge-guard / regression，零网络零计费）。

## M13 能力速览（素材链补全：视觉提取 / 多预设叠加 / 视频参考图 / 上传通道 / 批量润色 / states 入库）

把素材链从「可用」升级到「好用」：**从参考图提取画风词**（选 1~4 张同基调参考图 → 视觉 LLM 提取 → 预填预设表单，不落库防幻觉词污染）；**风格预设多选叠加**（项目可叠挂多个预设，出图时按绑定顺序逐字拼接「视觉风格：A；B」并在任务 params 快照溯源；旧单值绑定兼容不变）；**视频侧场景/道具参考图**（无首帧图时自动注入场景/道具参考图；首帧优先策略跨厂商统一）；**素材参考图上传通道**（素材页就地传图，sha256 去重复用）；**批量润色**（素材页多选 ≤10 项 → LLM 规范化 appearance，失败项不阻断可重试）；**states 状态变体入库**（角色状态变体入库 / 编辑 / 卡片 chips 展示）。设计三原则：**提取不落库**（确认后才入库）、**首帧优先**（规避 Wan 帧与参考互斥）、**宽容降级全链**（提取 / 润色 / 上传 / 参考图注入失败均不炸主链）。

- **视觉提取**（`POST /style-presets/extract`）：`ChatMessage.content` 放宽为多模态（OpenAI 兼容 `image_url`）；`style-extract.md` 格式令输出「（画风：中文,english）」；`assetToDataUri` 8MB/张 · 1~4 张；宽容解析（围栏剥离 / 括号归一 / 全文本回退 / cap 400）
- **多预设叠加**（零新表）：settings 新键 `style_preset_ids`（有序去重）+ 旧 `style_preset_id` 兼容回退；`combineStyleSnippets` 「；」拼接；`injectStyleAnchor` 签名不破（单值行为与 M8 逐字等价）；`gen_tasks.params` 双写 `stylePresetIds` + `stylePresetId`
- **视频参考图**（`collectSetRefAssetIds` / `planVideoRefs`）：场景≤1 + 道具≤1 保序去重；决策四分支——无图 `none` / 供应商无能力 `no_cap` / 有首帧 `frame_first` / 注入 `ok`；`params.setRefAssetIds` 快照；volcengine / minimax / aliyun-wan 适配器能力位 `referenceImages='base64'`（通道 M6 已备）
- **上传通道**（`POST /entities/:id/ref-images`）：multipart → `importFiles`（sha256 命中复用原行）→ `attachRefAssets` 并集挂接；全局实体 400 / 非图 400 / >10MB 413；Web 编辑态「上传新图」
- **批量润色**（`POST /entities/polish` + `entity-polish.md`）：只更新 appearance（summary / negative / voice 不动）；逐项串行 ≤10 项 / 次；失败收集不阻断（失败项保留选中可重试）；用量记录（全局实体跳过）
- **states 入库**：`characters` + `states` 列（幂等迁移）；char_profile v2 契约 `states[]`（「{剧情节点}：{状态短语}」）全链打通（normalizeSpec 保留 → upsertEntity 覆盖 → PUT 替换语义 → 读侧容错）；仅入库 / 展示 / 编辑（变体出图留后续）
- **Web**：`EntitiesView.vue` 卡片多选 + 「批量润色（N）」+ 「上传新图」+ states 表单 / 卡片 chips（前 2 条 + 「+N」）；`StylePresetsView.vue` 「从参考图提取画风词（可选）」区（项目 → 缩略图勾选 ≤4 → 提取预填）；`ProjectFormModal.vue` 「视觉风格」checkbox 多选面板

验证：`pnpm --filter @acs/server probe:m13`（七节：style-multi / vision / video-refs / upload / polish / states / regression，零网络零计费）。

## M14 能力速览（集级参数覆盖 + 剧集地图 + 静态托管）

把「一个项目 = 一部剧」的多次启动升级为可管理的两件事：**集级参数覆盖**（每个 run 启动时可选覆盖生成参数，仅本集生效，优先级 run 覆盖 > 项目设置 > 模板默认）；**剧集地图**（剧与集落库的通用两级结构：集号 / 标题 / 状态 / 起作入口，与最新 run 状态双源合并展示；起作 = 一键开该集的 RunFormModal 并预选项目默认模板 + 预填集号）；**静态托管**（生产模式一条命令出成品工作站：`CSTUDIO_WEB_DIST` 指向构建产物即可经 server 直接访问，SPA 深链回退 + 路径穿越防护）。设计三原则：**runtime 叠加**（`createStepContext` 合并链顶层注入，action 零改动、既有 run 逐字等价）、**双源合并派生**（集状态 = 最新 run 状态优先，回落行原值；不挂事件不改生命周期）、**env 驱动**（静态托管无配置 = 现行为逐字不变）。

- **集级参数**（`run.input._params`，对齐 M11 `_compose` 内部键先例）：白名单四组——`image`（provider / model / size）/ `video`（provider / model / resolution 480p·720p·1080p / duration 1–30 clamp）/ `audio`（provider / voice）/ `llm`（temperature 0–2 clamp / max_tokens 256–65536 clamp）；未知键 / 类型不符 → 400 `bad_params` 附键名；Web「启动流水线」表单底部「本集参数覆盖（可选）」折叠区五控件（出图尺寸 / 视频清晰度 / 单镜时长 / 配音音色 / LLM 温度）；续跑随 input 复制（同集语义对齐）
- **剧集地图**（`series` / `episodes` 两级通用表，一项目一剧）：`GET/POST /projects/:id/series` + `PATCH/DELETE /series/:id`（扩容追集 / 缩容仅删尾部空集，占用行 409 `episode_in_use`）+ `PATCH/DELETE /episodes/:id`（标题 / 手工状态）；run 联动 = 启动端点后置回写 `latest_run_id`（失败不阻断）；`SeriesBoard.vue` 剧集地图卡（集行：集号 / 行内编辑标题 / 状态徽标 / Run 链接 / 手工状态下拉 / 起作 / 删）
- **静态托管**（`CSTUDIO_WEB_DIST`，app.ts）：`/api/v1` 挂载后 404 兜底前——`existsSync(index.html)` 才启用；`GET /assets/*` 静态文件 + 其余非 `/api/*` GET 回退 `index.html`（SPA 深链）；window-safe 路径归一化 + 穿越防护；`/api/*` 未命中保持 JSON 404 优先
- **桌面端〔已取消〕**（2026-09-12 用户决策）：项目定位本地单机 Web 工具，与红线「Electron / Docker / 远程部署 → 永久不做」一致；scaffold 全量删除（git 零残留）；静态托管独立保留

验证：`pnpm --filter @acs/server probe:m14`（四节：params / series / static / regression，零网络零计费）。

## M15 能力速览（流水线画布工作台）

把「编排」与「运行」从列表视图升级为一张可操作的关系图：**模板/运行的步骤为节点 + 依赖与数据引用为边**，实时状态徽标挂在节点上，点开节点抽屉即可就地操作（闸门审阅 / 单步重跑 / 重新合成 / 任务重试）。设计三原则：**依赖语义单一真源**（`stepDeps` 从引擎抽为 `pipeline/dag.ts` 纯函数，画布布局与调度同源调用非复制）、**画布读模型纯读零写**（canvas 路由两枚全 GET；所有操作复用既有端点）、**视图状态独立于数据层**（350ms 防抖全量对账但保 pan/zoom/选中）。

- **依赖语义抽取**（`pipeline/dag.ts`）：`stepDeps`（显式 `after` 多值去重 / 缺省前一步 / `when`·`when_any`·`gate.when` 隐含依赖）+ `stepDepEdges`（sched 边 origin: after / default / when）；engine 两处调用点改纯委托（−45 行，调度行为三重背书：diff 留痕 / probe `dag` 矩阵 18 项 / 回归断言）
- **运行画布读模型**（`GET /runs/:id/canvas`，`services/canvas.ts` 纯读）：节点 = 步骤行 × 模板 def 合并（status / 执行统计〔任务 x/y·异常〕/ 闸门待审 / 产物引用 / skip 原因 / 错误）；边 = **sched 边**（承载布局与执行顺序）+ **data 边**（def.inputs 中 `steps.x.asset(s)` 整串引用；模板不可得时边为空）；操作可用性真值矩阵（rerun / 重新合成 / 任务重试 / gate / 取消 / 续跑）与 `checkRepairable` 同源对拍；坏快照 / 坏 output JSON / 孤儿行全部宽容兜底
- **模板画布读模型**（`GET /templates/:key/canvas`）：设计态节点（key/seq/action/title + gate 摘要〔message 不内插 / skipLabel / when〕+ when/after 透传 + batch 摘要 + inputsRefs 设计态引用 + 产物 purpose），零运行字段
- **画布即工作台**：节点抽屉 = 状态与操作（批准/驳回/跳过/中止走 GateDialog；单步重跑走 RerunModal〔整体执行型步骤提示属预期〕；重新合成 confirm → ffmpeg_merge 重置；任务重试/取消）+ 输入引用（启动输入 / 上游产物 / 资产库）+ 产物缩略图（AssetPreviewer 复用）+ 日志区（`[stepKey]` 过滤，尾部 200 行贴底自动滚动）；模板态 = 设计态说明（闸门/依赖/条件/批量/产物）
- **实时对账**：socket 单通道 `/studio` 手动 join/leave `run:{id}` 房间（runId 可切换，不用 useStudio 单例）；`run.step / run.gate / run.completed / run.failed / task.updated` → 350ms 防抖重拉（in-flight 合并）；日志独立 1200ms 节流
- **Web**：`CanvasView.vue`（页壳：query 单一真源 / 模式切换〔运行/模板〕/ 顶栏操作〔取消运行·断点续跑·启动运行〕/ 空态引导〔最近运行 + 模板 chips〕）、`CanvasBoard.vue`（分层布局：sched 边最长路径松弛防环 / 层内按 seq 垂直堆叠居中；手绘 pan/zoom〔zoom ∈ [0.3, 2.5]〕+ 首次数据到达自动 fit；SVG 贝塞尔边：sched 灰 / data 绿 / running 流动动画；状态徽标：running/gate/failed/ok/skip/cancel/idle）、`CanvasDrawer.vue`（节点抽屉两态）
- **导航**：侧栏「画布」（`/canvas`）+ 运行页「画布视图」（`?run=`）+ 模板页「画布」（`?template=`）；画布内「运行详情 ↔ 画布」双向跳转

验证：`pnpm --filter @acs/server probe:m15`（四节：dag / canvas-run / canvas-template / regression，78 项断言，零网络零计费）。

## M16 能力速览（创作画布）

把「自由创作」引入平台：项目级**画布文档**——素材节点自由摆放、引用连线（端口语义 reference / first_frame / last_frame / source）、就地生成（文生图 / 图生图 / 文生视频 / 图生视频）与就地编辑（局部重绘 / 消除 / 扩图），产物自动入库；与 M15 流水线画布并存互不替代。设计三原则：**URL 单一真源**（项目 / 画布切换全走 query，数据层随路由同步）、**状态零存量**（节点状态与结果全部由 `gen_tasks` 派生，不落冗余列）、**能力声明制**（编辑能力由适配器声明，未声明置灰 + 错误透传不炸）。

- **数据模型**（首次引入新表）：`canvases` / `canvas_nodes` / `canvas_edges` 三表 + `gen_tasks.canvasNodeId` 列；沿用 `ensureTable` / `ensureColumn` 运行时幂等兜底（旧库升级不炸）；节点仅存 `{ kind, assetId | spec, x, y }`，状态零存量
- **文档层**（`services/creation.ts` + 14 枚端点）：`buildCanvasDoc` 全量读模型（节点状态 / 最新任务 / readiness 输入预检 / editCapability 快照 / 任务历史）；端口矩阵校验 + 建边环检测（必拒绝成环 400）；删节点级联边 / 删画布级联 / 删项目级联清画布；复制画布（节点 id 重映射 + 边重建）
- **执行通道**（`services/creation-gen.ts` 直连适配层，不复用 pipeline actions）：任务 `runId/stepId` 恒 null + `canvasNodeId` 归属；边 → 上游最新成功产物 → data URI 输入计划（`resolveNodeInputs`）；信号量 ≤2；失败自动重试 1 次（镜像 ai_image）；编辑走 `adapter.edit`；视频轮询 + 取消复用 `POST /tasks/:id/cancel`；`recordUsage` 归属项目；崩溃恢复 `recoverCanvasTasks` 标 failed（不自动重排队，重跑 = 一次点击）
- **编辑能力**（声明制）：`ImageAdapter` 可选 `editing` 声明 + `edit()`（零破坏，既有 7 个适配器不声明即无）；首家 `aliyun-wan-image`（inpaint / outpaint 对表万相编辑系，erase 归一 inpaint 系）；蒙版 = `EditBrushModal` 涂抹 → 导出 PNG（最长边 1024）→ 上传 purpose `mask` → 回填 `spec.edit.maskAssetId`；未声明 → inspector 警告「执行将失败」+ 错误原样透传为任务 `errorMsg`
- **实时对账**：socket `canvas:<id>` 房间 + `canvas.changed` 事件（入队 / processing / succeeded / failed 各状态转移 emit）；350ms 防抖全量重拉（保 pan/zoom/选中）
- **Web**：`CreationView.vue`（顶栏：项目 / 画布选择器 + 新建 / 复制 / 删除 + 适应视图 + 送去运行 + 模板草案）、`CreationBoard.vue`（世界层 translate+scale / SVG 贝塞尔边 / 端口连线 / 节点拖拽本地即时 + 抬手落库 / 双击建节点 / drop 上传 / zoom ∈ [0.2, 2.5]）、`CreationInspector.vue`（spec 表单 / readiness / 任务历史 / 结果预览 / 联动入口）、`EditBrushModal.vue`（涂抹导出）、`CanvasTargetModal.vue`（目标画布选择 / 新建）；视口防抖落库（刷新保持）
- **联动三枚**：run 产物 →「送入创作画布」（M15 抽屉 +1 按钮 → 素材节点网格落点）；画布产物 →「设为实体参考图」（`ref-assets` 并集挂接）；画布素材 →「送去运行」（`RunFormModal` prefill `setting_docs`：选中节点优先 / 全画布过滤 image·text）
- **模板化沉淀**：复制画布；`buildTemplateDraft` 低保真草案（gen 节点拓扑序 → step 骨架 + 注释保留 prompt / 参数 + TODO 标注；validation 与 `/templates/validate` 同源直调）→ 前端 YAML 展示 + 「复制 YAML」

验证：`pnpm --filter @acs/server probe:m16`（六节：canvas-doc / node-build / edit-cap / draft / linkage / regression，126 项断言，零网络零计费）。

## 内置模板

下表标注各模板的方法论来源（对应「内容创作者套件」技能）；模板可独立运行，亦可按「典型工作流链」串联。

| key | 场景 | 要点 | 方法论来源 |
|---|---|---|---|
| `topic-radar` v1 | 选题雷达（other） | 多维评分（需求势能 / 竞争密度 / 账号适配 / 长尾价值）+ 历史选题去重 + 常青生成 + 回灌调分；热点素材以导入替代联网采集 | 选题雷达 |
| `video-plan` v1 | 创作策划（drama_short） | 五节策划案（题材定位 / 人物小传 / 爽点结构 / 视觉基调 + Look Dev / 单集节奏）+ 弧光机械核对 + 导演三视角（观众 / 平台 / 成本）自检 | 创作策划 |
| `series-setup` v2 | 整剧立项·设定包（drama_short） | 整剧设计书 + 设定包四件（总设定 / 角色卡 / 世界观 / 场景视觉卡）+ 分集地图；单集正文回 `mengbao-episode` 逐集展开（token 取舍）；复用角色一致性链；v2 新增场景/道具档案链（`set_profile` 档案 → 素材提示词 → 参考图生成（`with_set_refs`）→ `entity_sync` 建档） | 剧本创作 |
| `mengbao-episode` v9 | 短剧·单集（T3） | 双闸门（剧本必审 + 分镜可选审）+ `motion` 互斥分支 + **角色一致性链**和**配音字幕链**（原有）；v4 三条审阅开关：`with_deep_review` / `with_narrative_doc` / `with_edit_review`；v5 新增 `with_voice`（默认开）：台词切句（`lines-cast-ep.md`）→ 逐句配音 → measured 精确字幕 → `fit_voice` 多镜时长按配音总长均分（成片与音轨等长）；v6 新增 `i2v`（默认关，需 `motion=true`）：`gen_frames` 首帧图步骤 + `gen_motion` 首帧驱动与 `motion_prompt,image_prompt` 回退链（出图+视频双计费）；v7 增 `compose_video.shots` 输入：镜头工作台 per-shot 时长覆盖 + 选镜拼接消费，逐镜缺文件 skip+warn，存量 v6 run 行为等价；v8 新增场景/道具参考链（`with_set_refs` 开关 + set 四步 `set_profile` → `set_ref_prompts` → `gen_set_refs` → `sync_set`），出图按 `location`/`props` 注入场景/道具锚定与参考图；v9 新增台词归属链（`make_storyboard` 消费 `cast_lines` 台词表 + 每镜 `lines` 声明）与 `compose_video` 转场 / BGM 四键默认值 | 剧本创作 + 分镜提示词 |
| `talking-clip` v3 | 对白口播·单条（T2） | 记忆闭环 + 账号档案 + 逐句情绪配音 + measured 精确字幕（原有）；v3 新增 `platform` 感知与 `with_platform_copy` 视频发布文案步骤（标题 / 话题 / 简介） | 内容编排 + 平台适配 |
| `quick-video` v1 | 快速单片视频（talking_head） | 一句话创意极简输入 + 闸门默认关闭（`confirm` 开才审）+ 封面图兼成片背景单图成片；定位热点跟拍快出片 | 内容编排 + 文字创作 |
| `note-clip` v2 | 图文笔记·单篇（T1） | 记忆召回 → 主稿（gate）→ 封面 + 可选内页配图 → 发布稿（原有）；v2 新增 `to_platforms` 多平台适配步骤（when） | 文字创作 + 平台适配 |
| `article-clip` v1 | 深度长文（article） | 长文主稿（结构完整 / 逻辑论证 / 事实溯源）+ 可选内页配图 + 多平台适配 + 发布稿（标题定稿 + 封面文案 + 溯源检查；对齐 note-clip 模式） | 文字创作 + 平台适配 |
| `platform-adapt` v1 | 平台适配（other） | 八平台（公众号 / 小红书 / 知乎 / 头条 / 抖音 / 快手 / 视频号 / B站）标题 / 正文 / 话题 / 封面文案规则 + 事实不变性铁律 + 风险处标注不静默删改 | 平台适配 |
| `review-restock` v1 | 盘点复盘（other） | 数据解读（完播 / 互动 / 涨粉结构）+ 置信门禁（样本不足降级结论并标注）+ 回灌选题入记忆（供 `topic-radar` 调分闭环） | 盘点复盘 |
| `novel-adapt` v1 | 小说改编·切分→图谱→剧本（plan） | 小说入库 → 章节切分（三级正则链 / 卷识别 / 范围过滤，可审阅）→ 逐章事件提取（批量）→ 事件图谱归并 → 分集规划（可审阅）→ 逐集改编剧本（批量）；产物对齐 `script-ep` 格式，可接力短剧链 | 内容编排 + 剧本创作 |

**典型工作流链**（`review-restock` 回灌记忆 → `topic-radar` 召回调分，构成「选题 → 生产 → 复盘 → 回灌」闭环；模板均可独立运行）：

| 内容形态 | 链路 |
|---|---|
| 短剧 | `topic-radar` → `video-plan` → `series-setup` → `mengbao-episode`（逐集）→ `platform-adapt` → `review-restock` |
| 小说改编 | `novel-adapt`（小说 → 分集剧本）→ `series-setup` → `mengbao-episode`（逐集）→ `platform-adapt` → `review-restock` |
| 口播 / 快片 | `topic-radar` → `talking-clip` / `quick-video` → `platform-adapt`（或模板内 `with_platform_copy`）→ `review-restock` |
| 图文 / 长文 | `topic-radar` → `note-clip` / `article-clip` → `platform-adapt`（或模板内 `to_platforms`）→ `review-restock` |

新增体裁 / 新流程 = `workspace/templates/` 新增或改 YAML（模板页保存即生效，无需改代码、无需重启）。

## AI 配置指引（四通道）

「AI 配置」页（`/settings`）按能力分四个 tab；每个 tab 可建多个供应商实例，同类型内 `is_default` 为默认通道（未设默认按 priority）。

| tab | service_type | 说明 |
|---|---|---|
| 文本生成 | `llm` | OpenAI 兼容 Chat Completions；未建实例时回退 `.env` 的 AGENT_LLM_* 网关 |
| 图片生成 | `image` | OpenAI 兼容图片接口（支持在线拉取模型列表） |
| 视频生成 | `video` | 轮询型视频供应商（提交任务 + 轮询回查）；duration / resolution / aspect_ratio 由项目设置与模板 `defaults.video` 级联 |
| 语音合成 | `audio` | OpenAI 兼容 `POST /audio/speech`（mp3 落盘） |

- 密钥只存 `data/secrets.json`（0600，不入库不进 git）；编辑实例时 api_key 留空 = 不改密钥
- 实例可「测试」连通（文本 1 次最小对话 / 图片 1 张真实出图）
- 对应通道未配置时 action 报错带指引（如 `gen_motion` → 视频生成 tab）
- 模板 `defaults` 指定的 `provider`（如 `openai_image`）需存在同 providerKey 实例；不符时按报错指引补建实例，或在项目设置中覆盖 provider
- 提示：视频通道改配置（型号/参数）**立即影响后续任务**（含运行中 run 的待执行任务）——改前请确认型号与项目 `settings.video` 参数兼容
- 语音通道可声明情绪透传：实例 extra 设 `emotion_param`（如 `emotion`）+ `emotion_map`（基调词 → 供应商值）后，tts 按台词 `emotion_hint` 自动透传该参数；未声明则仅记录 `asset.params.emotion_key` 不透传

## 记忆与模型

- 记忆 = 本地向量库（`memories` 通用表 + `bge-small-zh-v1.5` ONNX 推理，512 维）；`memory_recall / memory_write` 为模板可用的两个 action（查询 = 项目域 + 全局合并按相似度排序）
- 模型就绪：`pnpm --filter @acs/server model:prepare`（只检查并打印指引；`-- --download` 经 hf-mirror 优先逐文件下载；`-- --from-toonflow` 兜底复制本地 all-MiniLM，384 维）
- 模型目录：`data/models/bge-small-zh-v1.5/`（`tokenizer.json / config.json / onnx/*.onnx`）；`GET /api/v1/memories/status` 报告模型 / 维度 / 条数 / 待补向量数
- 无模型降级：`memory_*` action 报错并附 `model:prepare` 指引；其余流水线不受影响

## 目录约定

| 路径 | 说明 |
|---|---|
| `apps/server/src/` | Hono API + Pipeline 引擎（DAG 调度 / 模板快照 / 崩溃恢复）+ Action Registry + 供应商适配层 |
| `apps/web/src/` | Vue3 工作台（项目 / 运行 / 资产 / 任务 / gate 审阅 / 模板 / AI 配置 / 记忆 / 角色 / 统计 / 批次） |
| `workspace/templates/*.yaml` | 流水线模板（新增体裁 = 新增模板；模板页在线编辑，保存即生效） |
| `workspace/prompts/*.md` | LLM 提示词模板（外置可编辑；模板页同区管理） |
| `workspace/projects/{id}/` | 项目资产 + exports/ 发布包（运行时生成，API 经 /api/v1/assets/{id}/file 访问） |
| `data/studio.db` | SQLite（WAL） |
| `data/secrets.json` | 本地 API key（0600，不入库） |
| `data/models/bge-small-zh-v1.5/` | 记忆 embedding 模型（ONNX 本地推理，512 维；`model:prepare` 检查/下载） |

## M3 全链路回归路径

### A. UI 手工路径（推荐，一次约 10–15 分钟）

1. 双端启动：`pnpm dev`，浏览器打开 http://127.0.0.1:5174
2. **建项目**：项目列表「新建项目」（或选已有「萌宝冒烟」跳到 3）；模板可选 `mengbao-episode`（T3 短剧）/ `talking-clip`（T2 口播）/ `note-clip`（T1 图文）
3. **传素材**：项目详情页「上传素材」，用途可选 brief / 设定底稿 / 角色参考图 / 归档；同内容重复上传应去重（同名仅保留一份）
4. **启动流水线**：「启动流水线」→ 填 brief 与集号、勾选开关（`motion` 动效 / `with_storyboard_review` 分镜审阅 / `with_character_refs` 角色定妆照）→ 提交后自动跳运行页
5. **看流式日志**：write_script 步骤日志滚动 → 停在「等待审阅」（gate）；M3 步骤带徽标：记忆「召回 N 条 · top X」/「记忆已写 name」、角色「建档 N 新增 / M 更新」
6. **gate 审阅**：预览剧本 markdown → 可「审阅修改」（以修改版续跑）或直接**批准**；驳回需附意见（回流 LLM 重跑）；分镜闸门挂起时可点「免审直接出图」（skip）
7. **等出片**：批准后自动分镜 →（静态分支）批量出图 /（动效分支）批量视频 → 合成成片；时间线可见并行段与 skipped 灰显（原因 badge）；任务面板逐任务状态与 prompt 溯源
8. **看成片**：完成态 run 的产物资产（final_video）点开即播放（浏览器 Range 拉流）；封面 thumb 与全尺寸图可预览
9. **记忆沉淀巡检**：run 完成后打开 `/memories`：可见该 run 写入的风格样本（类型 / 域 / 溯源）；输入**近义表达**检索应语义命中（非字面匹配）；可编辑 / 删除；模型切换后用「重建索引」补向量
10. **角色库巡检**：打开 `/characters`：查看建档角色（外观锚定 / 别名 / 声线 / 定妆照缩略图，全局与项目域分组）；T3 勾选 `with_character_refs` 再跑一集 → 定妆照生成并入档；镜头出图任务 prompt 含「角色锚定（…）」「必须剔除：…」
11. **模板在线管理**：`/templates` 编辑 YAML（错误内联）→ 保存 → 新 run 用新模板；运行中 run 仍按快照执行
12. **断点续跑**：failed / cancelled run 详情页「从断点续跑」→ 新 run 仅重跑未完成步骤（已成功产物复用）
13. **AI 配置**：`/settings` 四 tab（文本 / 图片 / 视频 / 语音）查看实例，「测试」验证连通；通道未配 / 失败可切换默认实例后重试

### B. API 快捷冒烟

```bash
curl http://127.0.0.1:3001/api/v1/health               # ok/db/ffmpeg/workspace 全绿
curl "http://127.0.0.1:3001/api/v1/runs?project_id=3"  # 项目 3 运行列表（最新在前）
curl http://127.0.0.1:3001/api/v1/runs/26              # completed run 详情（steps 产物链）
curl http://127.0.0.1:3001/api/v1/templates            # 模板列表（含引用体检）
curl http://127.0.0.1:3001/api/v1/assets/166/file      # 成片 mp4（支持 Range: bytes=…）
curl -X POST http://127.0.0.1:3001/api/v1/runs/24/resume   # 断点续跑（failed/cancelled）
curl http://127.0.0.1:3001/api/v1/memories/status          # 记忆基建：模型 / 维度 / 条数 / 待补向量
curl "http://127.0.0.1:3001/api/v1/memories?q=放松"        # 语义检索（近义表达 top1 命中）
curl "http://127.0.0.1:3001/api/v1/characters?project_id=1" # 角色库（含定妆照引用）
```

### C. 清理 data/ 重来

```powershell
# 1) 停掉 pnpm dev（两个终端 Ctrl+C）
# 2) 清库与产物（密钥可保留，不清 secrets.json 则无需重配）
Remove-Item data/studio.db* -ErrorAction SilentlyContinue
Remove-Item workspace/projects/* -Recurse -Force -ErrorAction SilentlyContinue
# 3) 重新 pnpm dev —— 自动 migrate + seed，从空白开始
```

> 模板/提示词经 Web 模板页保存后即时生效；已开始的 run 保持创建时快照语义（M2），续跑不受模板改动影响。

## M4 全链路回归路径

### A. UI 手工路径（M4 增量，约 10 分钟）

1. **配定价**：`/settings` → 底部「用量单价」→ 添加 LLM 行（参数如 `deepseek-chat` / tokens_in / tokens_out）→ 保存
2. **批量运行**：项目页「批量运行」→ 选模板 → 3 行输入（或批量粘贴 JSON）→ 提交 → 自动跳批次页
3. **看批次**：进度与计数随 run 推进（串行时活跃 ≤1）；gate 挂起批次暂停 → 运行页批准 → 回来继续；完成后可「批量导出」
4. **成本核对**：运行页右栏「本 run 成本」（按 kind + 未计价徽标）；`/stats` 概览卡与成本构成核对
5. **导出**：运行页「导出发布包」→ 勾选产物（默认全选）→ 生成 → 下载 zip 解压（manifest.json + 分目录）
6. **发布登记**：运行页「标记发布」（平台/链接/指标）→ 项目页发布记录区块；`/stats` 发布数与播放量同步
7. **复盘**：`/stats` 切 7/30/90 天、项目筛选、成本构成分组切换；项目对比表逆向核对

### B. API 快捷冒烟

```bash
curl http://127.0.0.1:3001/api/v1/stats/overview
curl "http://127.0.0.1:3001/api/v1/stats/usage?group_by=kind"
curl "http://127.0.0.1:3001/api/v1/batches?project_id=1"
curl "http://127.0.0.1:3001/api/v1/publications?project_id=1"
```

## M4 验收快照（2026-09-11）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 批量串行 + gate 停滞 | ✅ | 批次 1（Run 42–44）：挂起期活跃 ≤1、60s 不推进；终态 3/3/3 completed（01-serial 9/9） |
| 2 | 批量 partial_failed + 断点续跑 | ✅ | 批次 2（Run 45–47）：partial_failed（s=2/f=3）；续跑 Run 48 独立批、已完成步复用（02b 6/6） |
| 3 | 批量取消 + 崩溃恢复收敛 | ✅ | 批次 3 取消竞态命中 7/7；批次 4 gate 跨崩溃持久 7/7；批次 5 running 中断→failed(interrupted)→续跑 Run 55 completed（03b 10/10） |
| 4 | 成本捕获（四类用量落行） | ✅ | Run 55 image=3/tokens；Run 59 char=294；Run 61 second=100；Run 58 tokens 计价（10-second 5/5） |
| 5 | 定价快照 + 聚合口径 | ✅ | Run 56 P1 验算→改价后不变；Run 57 用新价；Run 62 删价全行 unpriced、UI 133 == API（05 13/13 + 10-unpriced 9/9） |
| 6 | 单 run 导出包（manifest/分组） | ✅ | Run 55 勾选 5 资产 → zip 312KB 解包自校验 12/12（manifest / 分目录 / 魔数） |
| 7 | 批量导出（集合相等） | ✅ | 批3 混合 / 批4 全产物双场景；抽包 Run 51 files.assetId = 全产物（集对集）（07 12/12） |
| 8 | 发布登记 + 统计一致 | ✅ | 2 条登记（douyin/bilibili）→ 项目页 2300/173 = overview（08 19/19） |
| 9 | 统计页数据核对 | ✅ | 动态对齐 29/29 + CDP 交互 16/16；守恒 sum(各项目)=全局 6/6；截图查证 |
| 10 | README + 三模板无回归 | ✅ | 本文件；Run 58/59/60 三模板复跑 16/16，无 error 日志 |

## M9 验收快照（2026-09-12，实弹）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 静态 + 探针：五 section 全绿 | ✅ | 双端 typecheck 0 错；`probe:m9` 120 项全过（split / batch / contracts / api / template） |
| 2 | 兼容回归：m2a·m3·m6·m7·m8 | ✅ | 五探针全绿（存量基线零漂移） |
| 3 | 模板契约：novel-adapt v1 零 warning | ✅ | 模板列表 11 项含 novel-adapt（steps=7 / promptsDirty=false）；probe template 节全过 |
| 4 | 实弹全链（3 章短篇，Run #100） | ✅ | completed 28.4s：切分闸门 → 逐章事件 3/3 → 图谱 key_events=9 → 规划闸门（2 集）→ 剧本 2 份；LLM 7 次 ¥0.1541 |
| 5 | 闸门流：切分 / 规划 waiting_input → approve 续跑 | ✅ | 两处闸门自动放行后正常续跑；`with_script_review=false` 免审直过 |
| 6 | 产物分布（purpose 锚点） | ✅ | source=1 · brief=1 · chapters=4（manifest+3 章）· events=3 · graph=1 · plan=1 · script=2 |
| 7 | NovelBoard 聚合读 + 四段渲染 | ✅ | GET /runs/100/novel-board 契约全过；DOM `.nb` 四段（章节 3 行 / 事件 10 行 / 规划 2 卡 / 剧本 2 按钮，1122×1052 visible，零 console 错误） |
| 8 | 剧本格式对齐 `script-ep` | ✅ | `第01集-改编剧本.md`（资产 #1126）：本集梗概 + 人物表 + 场景与对白（场景头【场景 N｜地点·时间｜氛围】+ 动作 + 对白） |
| 9 | 实弹暴露缺陷修复（引擎依赖级联） | ✅ | 首跑全链 `upstream_skipped` → 根因 `depsFor` 默认依赖前一步骤 + 规则①级联 → 模板 `after: [ingest, make_split_regex]` 混合依赖修复 → 复跑全通过；spec §3.6/§3.9 回写 |
| 10 | 越界核查（红线零 diff） | ✅ | `git status`：engine / refs / context / shot-workbench / ShotBoard 零改动；`schema.ts` 纯注释；11 改 + 11 新增与 spec §4 清单一致 |

## M10 验收快照（2026-09-12，实弹）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 静态 + 探针：六节全绿（含 stale 兜底新断言） | ✅ | 双端 typecheck 0 错；`probe:m10` 全过（ops / output / upload / board / select / regression；`board` 节 3 条 stale 兜底断言：基线 false → 分镜编辑 true → 成片刷新 false 回环） |
| 2 | 兼容回归：m2a·m3·m6·m7·m8·m9 | ✅ | 六探针全绿；`probe:m7` 四条 stale 断言零回归（仅 1 处拒绝文案基线随选片放宽适配） |
| 3 | 镜头拖拽重排 + 结构性编辑（Run 61 实弹） | ✅ | 首镜移尾重排 → 分镜新版本 #1127；add→patch→remove→reorder 链 → #1128（s02 记入「M10实弹」）；产出步骤 output 按新序保位重建 |
| 4 | 上传替换 + sha256 去重 | ✅ | 回传同文件 → 资产 #1129（复制行，绑定 s03）→ 版本组并入（source=upload）→ 重新合成消费新图 |
| 5 | 大编辑器 UI 保存链路（浏览器 DOM 实测） | ✅ | s04 加标签「M10编辑器」→「20 镜 · 1 项改动」+ 保存按钮可用 → Modal 关闭 + notice → 服务端 s04 `characters=['苏小满','M10编辑器']` 落地（#1132） |
| 6 | 实弹暴露缺陷修复①：characters JSON 快照 bug | ✅ | `normalizeDraft` 对象分支读 clone 旧快照覆盖专用控件新值 → UI 保存静默丢改动；修复 = characters 直取实时值 + `cloneDraft` jsonText 跳过 RESERVED 键；复验计数与保存按钮恢复、服务端落地 |
| 7 | 实弹暴露缺陷修复②：computeStale 判定失效 | ✅ | 存量快照无 shots 引用 / 续跑链跨 run 资产引用 → shots_source 缺失/断链 → 分镜编辑后 stale 不动；修复 = 分镜资产时间兜底（不参与 compared，null 语义不变） |
| 8 | stale 完整回环（Run 61） | ✅ | UI 保存 → 服务端 `stale:true` → 浏览器三板「待重新合成」→ recompose（#1133/1134）→ `stale:false` → 三板「合成已最新」 |
| 9 | 越界核查（红线零 diff） | ✅ | `git status`：engine / refs / loader / 适配器 / ffmpeg-merge / 模板 / schema 零 diff；改动限于 shot-workbench + routes/shots + Web（ShotBoard / StoryboardEditor / api / types）+ 探针（probe-m10 新增 / probe-m7 文案适配） |

## M11 验收快照（2026-09-12，实弹）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 静态 + 探针：六节全绿 | ✅ | 双端 typecheck 0 错；`probe:m11` 全过（rerun / align / bgm / transition / template / regression） |
| 2 | 兼容回归：m2a·m3·m6·m7·m8·m9·m10 | ✅ | 七探针全绿（探针基线随 M11 同步，零漂移） |
| 3 | 单步重跑实弹（Run 98） | ✅ | 复用模式 `tasks_succeeded=20 / 预计执行 0`，重跑后 20 个子任务 attempts·completedAt 零变化（真复用不重执行）；活跃 run 重跑拒绝 400 |
| 4 | 音字对齐实弹（成片 #1139） | ✅ | 分镜 `lines` 消费台词表 → 目标 110.928s 参数 / 日志 / ffprobe 三点吻合：video 110.920 / audio 110.928 / container 110.929；对照旧成片 #1110（video 69 / audio 104.64）拖尾 35.6s 消除 |
| 5 | BGM 实弹（#1141 → #1142） | ✅ | 上传 m4a → 资产 #1141（purpose=bgm）；音量 0.8 / 淡入淡出 1s → 重合成 #1142：container 110.929 不变 + `params.bgm` 溯源；volumedetect 静音窗 -91.0 → -30.5dB、淡入区增益温和 |
| 6 | 转场实弹（#1144） | ✅ | fade × 0.5s：日志「fade × 19 处」+ `params.transition={enabled,type,dur_sec}`；container 110.960（+0.032 xfade 亚帧取整、总长语义不变）；抽帧 PSNR：交叉窗内 t=3.0s 11.2dB vs 窗外 2.9s / 4.0s 均 41.0dB |
| 7 | 回归闭环（#1146 移除 BGM + 转场 none） | ✅ | 容器 110.929 / video 110.920 / audio 110.928 与对齐基线逐值一致；静音窗回 -91.0dB；compose 参数无 BGM / 转场痕迹 |
| 8 | 存量兼容（v8 快照 run #1136） | ✅ | 与基线 #1110 输出逐值一致（快照优先，无 M11 特征注入）；probe template 节 v8 快照断言全过 |
| 9 | 浏览器 DOM 五组验证（Run 98） | ✅ | A 重跑按钮 + RerunModal 计数预览 / B 转场行 + 配乐入口 / C 镜头台词角标 / D BgmModal / E StoryboardEditor lines 控件 —— 五组全 PASS、零 console 错误 |
| 10 | 实弹暴露缺陷修复：布局 2 处 | ✅ | ① 全局 `select{width:100%}` 命中转场下拉独占整行 → `.wb-sel` 收窄（auto / max 132px）；② 任务行 nowrap 长 prompt 经 grid `1fr` auto min 撑破轨道（整页横滚 10569px）→ `.cols` 改 `minmax(0,1fr)`；复验 scrollWidth 738 / 转场行单行 / 配乐按钮可见 |
| 11 | 续跑链工作台限制（发现 · 列后续修复） | 发现 | 续跑链 run（98）工作台写侧 `no_producer` 拒绝、读侧溯源回退旧快照（804 无 lines）→ 台词角标无数据；锚点修正（input.shots → 1138）后 board 恢复。属 M10 溯源约束（step.runId===run.id）对续跑链的固有限制 |

## M12 验收快照（2026-09-12，实弹）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 静态 + 探针：六节全绿 | ✅ | 双端 typecheck 0 错；`probe:m12` 66 项断言全过（cleanup / imagecheck / gc / board / merge-guard / regression；黑·灰·正常·截断·缺失五样本判定矩阵；`yavg<=16` 边界实测） |
| 2 | 兼容回归：m7·m10·m11 | ✅ | 三探针全绿（M12 改动面 = shot-workbench / ffmpeg-merge 的既有调用方，按 spec §6.2 回归集） |
| 3 | 收藏实弹（项目 10） | ✅ | `PATCH {is_favorite:true}` → API 回读 `isFavorite=1`；素材页「仅收藏」筛选 → 仅剩 1 张（#1108）；工作台版本卡 ♥ 激活态 DOM |
| 4 | 检测实弹 | ✅ | `POST /assets/1108/check` → `quality={ok:true,reason:'ok',stats:{ymin:0,ymax:244,yavg:69.3657,satavg:16.9465}}`；黑图 #1148 上传 → 自动检测 `black`（yavg=16 边界命中 `<=` 校准） |
| 5 | 清理实弹（Run 95） | ✅ | 工作台级 `groups=19 / cleaned=1（#919）/ kept=19` → board 复查 ids=[831,920]（选中 920 不变）；项目级 `groups=106 / cleaned=2（#831·#1012，919 已软删跳过）/ kept=106`；终态逐值核对 **20/20**（run95 软删集合恰好 [831,919]，零误伤） |
| 6 | 回收实弹 | ✅ | `POST /projects/10/assets/gc` → `files=4 / freed_bytes=2,981,444`（=80418+246735+261815+2392476）；软删行保留（审计）、现存文件 0；total=338 与 DB 一致 |
| 7 | 兼容实弹 | ✅ | 存量 run board 正常（20 镜 / 22 版本 quality 全 null 不误报）；老资产无徽标；#920/#1033 保留版本文件完好 |
| 8 | DOM 四要素（无头 Chrome CDP） | ✅ | 10/10：♥ 激活态 / 「疑似黑图」徽标唯一命中 #1148 / 「仅收藏」筛选生效 / 「清理旧版本」按钮 + 确认弹窗（标题·正文·取消关闭）；板面 33 卡零误报（qwarn=0）；截图 `apps/web/tmp-m12-dom-1..5-*.png` |
| 9 | 越界核查（红线零 diff） | ✅ | `git status`：schema.ts / engine / refs / loader / 适配器 / 模板 / 提示词零 diff；package.json 仅 +`probe:m12` 脚本（dependencies 零新增）；改动面 = 14 改（610+/18−）+ 2 新服务 + 探针 + 5 截图证据 |

## M13 验收快照（2026-09-12，实弹）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 静态 + 探针：七节全绿 | ✅ | 双端 typecheck 0 错；`probe:m13` 七节 **121 项断言全过**（style-multi / vision / video-refs / upload / polish / states / regression）；vision 节 fetch stub 断言请求体含 `image_url` data URI + 解析矩阵；video-refs 节 `planVideoRefs` 四分支 |
| 2 | 兼容回归：m7·m8·m10·m11·m12 | ✅ | 五探针全绿（exit=0；M8 签名不破（`injectStyleAnchor` / `resolveProjectStyleSnippet` 薄封装）、M12 存量调用零漂移） |
| 3 | ① 视觉提取实弹 | ✅ | `POST /style-presets/extract`（资产 #933/#935）→ `{snippet:'（画风：电影感写实3D渲染,cinematic photorealistic 3D render, …）', provider:'deepseek_llm', model:'deepseek-flash'}`——deepseek-flash 多模态实测支持；预设 #2「M13 实弹·提取预设」201 落库 |
| 4 | ⑦ 单值兼容实弹 | ✅ | Run 98 s01 重跑：`params.stylePresetIds=[1]`（单值回退数组化）+ 尾缀逐字「3D 写实厚涂质感，…」不变 + 产出更新 #1059→#1150 |
| 5 | ② 多预设叠加实弹 | ✅ | 项目 10 绑定 [1,2] → s02 重跑：`params.stylePresetIds=[1,2]` + 尾缀逐字「A；B」（两词块拼接）+ 产出 #1151；项目 settings 双键共存（`style_preset_id:1` + `style_preset_ids:[1,2]`） |
| 6 | ③ 视频参考图实弹 | ✅ | Run 97 s16 重跑：`params.setRefAssetIds=[797,798]`（阁楼+木盒收集快照）+ `firstFrameAssetId=1005` 保留 + 日志真实决策「当前视频供应商不支持参考图注入（降级跳过）」（pollinations_video 能力 none → no_cap；frame_first / ok 分支探针覆盖）+ 产出 #1153→#1154 |
| 7 | ④ 上传通道实弹 | ✅ | 素材甲 #54（挂 801）→ 上传红图 201 `asset#1155 {purpose:'reference_character'}` → `refAssetIds [801,1155]` 并集 + 文件落盘 `10\images\1789220857885-m13-ref-red.png` + 资产 HTTP 可读 |
| 8 | ⑤ 批量润色实弹 | ✅ | 甲+乙批量润色 200：`polished=2 / failed=0`、两项 appearance 已变化（甲「小木偶，木质躯体，雨夜泛出微光，四肢关节处缠绕旧麻绳。」）+ usage_records +4 行（deepseek_llm/deepseek-flash ×2 项 × tokens_in/out） |
| 9 | ⑥ states 实弹 | ✅ | PUT `states:['雨夜发光版','晴天沉睡版']` → 读回 + DB 入库一致；替换语义（2→1 项再定稿 2 项）；`GET /entities` 列表视图透出 |
| 10 | DOM 六要素（无头 Chrome CDP） | ✅ | **22/22**：甲卡片 states chips「雨夜发光版/晴天沉睡版」+「2 张定妆照」+ 缩略图 / 批量润色按钮 0→1→2（勾选甲、乙）且选中态 ×2 / 预设列表含「M13 实弹·提取预设」（snippet 透出）/ 新建预设弹窗提取区（标题 + 禁用按钮 + 选项目后 98 张缩略图 + 「参考图（已选 0/4）」）/ 素材编辑弹窗（states 预填两行 + 「上传新图」+ 已选 2 张）/ 项目编辑多选回填 2 项；截图 6 张 `apps/web/tmp-m13-dom-1..6-*.png` |
| 11 | 越界核查（红线复核） | ✅ | `git status`：engine / refs / loader / workspace/templates 零 diff；schema.ts 仅 +`states` 列 + db 幂等迁移（设计 §5 白名单内）；adapters 仅能力位 ×3 + 类型；package.json 仅 +`probe:m13`（dependencies 零新增）；改动面 = 工作区合计 21 改（976+/69−）+ 10 未跟踪；其中代码 20 改（946+/69−）+ 4 新件（`entity-polish.ts` / `probe-m13.ts` / 提示词 `style-extract.md` · `entity-polish.md`），文档 README +30 行 + DOM 截图 6 张 |

## M14 验收快照（2026-09-12，实弹）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 静态 + 探针：四节全绿 | ✅ | 双端 typecheck 0 错；`probe:m14` 四节全过（params / series / static / regression）；回归 m7·m8·m10·m11·m12·m13 全绿 |
| 2 | 集级参数实弹（Run 101） | ✅ | `_params = {image.size:768x768, video.duration:10, llm.temperature:0.5}` 入参快照；20/20 gen_task `params.size=768x768`（覆盖命中）+ `stylePresetIds=[1,2]`（项目层叠加）；`video.duration` 消费点（ai-video 镜头时长优先链）经 probe context 断言 |
| 3 | 零漂移对照（Run 98 重跑·无覆盖） | ✅ | 20 任务 id 集合不变 + 既有 7 键逐值零漂移；唯一演进键 `stylePresetIds`（s01 [1]→[1,2]——M13 单值回退 → 多预设叠加的预期收敛，非漂移）；`size=832x1248` 模板默认保持；产出 20/20 更新 |
| 4 | 剧集实体实弹（项目 10） | ✅ | 建剧「M14 实弹·剧集」3 集；Run 101/102 起作联动 `latest_run_id`；派生状态 completed/failed/locked 三态；集1标题行内编辑 200 |
| 5 | 剧集 409 矩阵 | ✅ | 缩容（含已关联 run 的集）→ 409 `episode_in_use`；删剧 → 409 `series_in_use`；两次 409 后剧视图未受损 |
| 6 | 静态托管冒烟（3101 隔离实例） | ✅ | 隔离数据目录 + 真实 dist：`/` 200 text/html + 真实 assets js 200 text/javascript（96.5KB）+ 深链 `/projects/12/timeline` 回退 index + `/api` 未命中 JSON 404 优先 |
| 7 | DOM 验收（无头 Chrome CDP） | ✅ | **14/14**：剧集地图卡（3 集）/ 三集行（001 已完成 Run#101 / 002 失败 Run#102 / 003 未起作裸行）/ 起作接力直达表单（`initialTemplateKey` 命中「短剧·单集」，无选卡）/ 覆盖区 summary + 5 控件 + 集号预填 3 + 滚动可见（open h=254 inView）；截图 2 张 `apps/web/tmp-m14-dom-1..2-*.png` |
| 8 | 实弹暴露缺陷修复 | ✅ | `SeriesBoard` 头部 `.bh/.bt` 系 ProjectDetailView scoped 样式不穿透子组件 → 标题粘连 + 按钮组换行（DOM 截图目检发现 → 组件内补定义 → 复跑复验）；覆盖区滚动可见性经 W6d 实测（弹窗 body 滚动容器语义） |
| 9 | 越界核查（红线零 diff） | ✅ | `git status`：engine / refs / loader / 模板 / 提示词零 diff；schema.ts 仅 +series/episodes 两表（设计 §4 白名单内）；package.json 仅 +`probe:m14`；改动面 = 12 改 + 5 新件（probe-m14 / routes/series / services/run-params / services/series / SeriesBoard.vue） |

## M15 验收快照（2026-09-13，实弹）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 静态 + 探针：四节全绿 | ✅ | 双端 typecheck 0 错；`probe:m15` **78 项断言全过**（dag 18 / canvas-run 43 / canvas-template 14 / regression 3）；回归 probe:m2a·m4·m14 全绿 |
| 2 | 引擎等价重构（纯委托） | ✅ | `engine.ts` −45 行（`depsFor` / `whenExprs` → `pipeline/dag.ts` 同源纯函数）；probe `dag` 矩阵 18 项（显式 after 多值·去重·缺省前一步·when·when_any·gate.when 隐含·首步·坏表达式吞错）+ 引擎调度行为回归断言 |
| 3 | 运行画布实弹（DOM · Run 102） | ✅ | 21 节点 / 74 边与模板步骤数一致；状态徽标 / 断点续跑可用性正确；RunDetail「画布视图」↔ 运行详情双入口往返；平移 / 缩放 / 适应 / 点空白清除选中 / × 关抽屉保持选中；日志按 `[make_storyboard]` 过滤无串行；首轮 15 项断言 14 通过 + 1 项数据态不适用（详见 #6/#7）；截图 6 张 `tmp-canvas-S1..S6-*` |
| 4 | 画布即工作台实弹（DOM · 零真实提交） | ✅ | Run 96 failed 步 `gen_motion`：单步重跑按钮 enabled（title=「重跑该步骤（可复用成功子任务）」）→ RerunModal 打开（整体执行型步骤双单选 disabled + 说明，属预期）→ 取消无提交；Run 80 人工闸门：节点卡「闸门待审」+ 抽屉 message 文案 + 批准继续/驳回重跑/中止/直接入库四操作；全程零真实执行（零计费） |
| 5 | 模板画布实弹（DOM） | ✅ | 21 节点全 idle 无运行徽标；设计态抽屉 `script_review`（闸门 required / 依赖 write_script / 条件 `input.with_deep_review == true`）；「启动运行」→ RunFormModal（项目默认 m8-实弹验收 + `initialTemplateKey` 直达表单）；空态 8 个最近运行 + 11 个模板 chips；Templates 页「画布」入口 → `/canvas?template=mengbao-episode`；截图 7 张 `tmp-canvas2-S1..S7-*` |
| 6 | 实弹暴露缺陷修复（fit 时机） | ✅ | 首轮：挂载时数据未到按空布局 fit（100% 偏出视口，需手点「适应」）→ 修复 = `fitted` 标志 + 首次非空数据到达 `fitOnce`（watch nodes 数）；复验自动 30% 适应（transform `matrix(0.3,…,-67,153.6)`）；`resetView` 同步清数据防跨目标残留视口 |
| 7 | 实弹备注（非缺陷） | 说明 | 812px 小窗 fit 后世界层两侧溢 67px——`zoom ∈ [0.3, 2.5]` 钳制下小窗口必然（1600px 窗口完全适配），属 spec 既定行为；Run 102 无 `.failed` 节点系服务重启中断态（running 残留无返修路径，走断点续跑）→ 改 Run 96 复验真实 failed 步 |
| 8 | 越界核查（红线零 diff） | ✅ | `git status`：schema / db / refs / loader / adapters / workspace 模板提示词零 diff；canvas 路由两枚全 GET（零写端点）；`package.json` 仅 +`probe:m15`（dependencies 零新增）；改动面 = 10 改（178+/41−）+ 7 新件（`dag.ts` / `services/canvas.ts` / `routes/canvas.ts` / `probe-m15.ts` + `CanvasView` / `CanvasBoard` / `CanvasDrawer`） |

## M16 验收快照（2026-09-13，实弹）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 静态 + 探针：六节全绿 | ✅ | 双端 typecheck 0 错；`probe:m16` **126 项断言全过**（canvas-doc 56 / node-build 34 / edit-cap 11 / draft 13 / linkage 10 / regression 2）；回归 `probe:m15`（内含 m2a / m4 / m14）全绿；存量库启动幂等升级无报错（实弹全程运行于既有 data 目录） |
| 2 | 画布实弹（浏览器 DOM） | ✅ | 建画布 / 切换（画布 1 / 2 / 4）；素材拖入摆放；双击空白建生成节点；连线（素材 → 编辑节点源图入边「入 1」）；节点拖拽落库；Inspector 全表单（spec 保存 / readiness「已就绪，可执行」/ 任务历史 / 结果预览）；蒙版涂抹 → 上传 purpose `mask` 回填（蒙版资产 #1320）；pan / zoom / fit 视口防抖落库——刷新后 transform 逐值保持（`translate(52.9119px, 6.92147px) scale(0.996406)` ≡ DB viewport） |
| 3 | 真实出图（零计费） | ✅ | 节点「图片 #7」pollinations flux.1-schnell：任务 #450 succeeded 16.2s → 徽标「成功」+ 缩略图（结果资产 #1323）；socket 修复后复跑 #451 17.5s |
| 4 | 联动三枚 | ✅ | ① run 101 抽屉「送入创作画布」→ 新建画布「M15联动验证」：节点 5/6 网格落库（60,60 / 340,60）② 画布图 →「设为实体参考图」→「灯婆婆」refs=[1297] 验证 → PUT `{ref_asset_ids:[]}` 回滚 refs=[] 无损 ③「送去运行」prefill 两分支：全画布过滤 image/text（「选 1 项」=#1297）/ 选中视频节点优先（=#1296） |
| 5 | 编辑通道（声明制退化验证） | ✅ | 无 key 环境：inspector 警告「当前图像端点未声明『局部重绘』能力，执行将失败」→ 执行 → 任务 #452 尝试 2 后 failed、错误原样透传「供应商『pollinations_image』未实现图像编辑能力」（零网络零计费）；蒙版 #1320 + 源图入边就位；截图 `tmp-m16-edit-cap-hint.png` / `tmp-m16-edit-fail.png` |
| 6 | 模板草案（低保真导出） | ✅ | 弹窗渲染 YAML（`canvas-draft-4`）+ 校验自检「步骤 n7 缺 inputs」如实展示（草案待人工完善属设计定位）+「复制 YAML」→ 剪贴板回读全文 + toast；截图 `tmp-m16-draft-modal.png` |
| 7 | socket 实时对账 + 缺陷修复复验 | ✅ | 消除实弹暴露的 4 处缺陷（TDZ ×2 / uploadFiles 契约 assets→items / **漏 join canvas 房间**：URL 同步 watch 于 setup 期先设 canvasId，房间 watch 后注册且无 immediate → 首次进入 / 刷新错失 null→id 变化；加 `{immediate:true}`）——修复后二次执行 #451：徽标 pending→succeeded 全自动流转（零手动刷新） |
| 8 | 越界核查（红线复核） | ✅ | `git status`：refs / loader / workspace 模板提示词 / 既有适配器 `generate` 路径零 diff（aliyun-wan 仅 +编辑声明与 `edit()`）；schema.ts 仅 +3 表 +1 列（设计 §2.1 白名单）+ db 幂等兜底 + projects.ts +14（删项目级联清画布）；M15 `CanvasBoard.vue` 零 diff（`CanvasDrawer` 仅 +1 联动按钮；engine.ts 差异系 M15 纯委托留痕）；`package.json` 仅 +`probe:m16`（dependencies 零新增） |

## M7 验收快照（2026-09-12，实弹）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 静态 + 探针：六 section 全绿（含实弹修复断言） | ✅ | `typecheck` 0 错；`probe:m7` 86 项全过（编辑即时读取、双口径同步、`parseShotDurations` 等新增断言） |
| 2 | 兼容回归：v6 存量 run 重新合成 | ✅ | Run 40：20 段/80s/每张 4s 与 M7 前一致；新成片带 `params.inputs` 快照（`shots_source:null`）；stale null→false |
| 3 | 编辑写路径（板面即时读产出侧最新分镜） | ✅ | Run 61 编辑 s01=8 → #763；再编辑 s02=3 → #764（`source_asset_id:#763` 链式、命名不累积）；板面立即刷新（无需引擎回写）；stale=true |
| 4 | 时长双口径（`duration` ↔ `duration_sec`） | ✅ | Run 61 板面 20 镜显示 LLM 值（s02 2→3 编辑同步双写）；Run 40 板面回退值（s01=3 / s08=2）；坏 JSON/非法条目容错 |
| 5 | 选片剔除 + 恢复 + 分镜序保序 | ✅ | Run 40 剔除 s01 → 19 段/76s（#765）→ reset 恢复 → 20 段/80s（#767）；s18=301 排在 s19=300 前（按分镜序非 id 序） |
| 6 | 逐镜容错：缺文件 skip+warn 出片 | ✅ | 移除 s01 图 → `#283 不可用已跳过` + `共跳过 1 个` + 19 段继续出片（#769 dur=76）；`params.skipped_shots=[283]`、inputs 记原始 20 id；恢复后 20 段（#771） |
| 7 | motion 路径兼容重新合成 | ✅ | Run 61：20 段镜头视频按实际时长合成（总 100s，#773 67MB），与旧成片 #519 同规格 |
| 8 | 单镜重生成 → 版本 2 + stale 变橙 | ✅ | Run 40 s01 重生成（attempts 1→2）→ `versions=[283,775]` 自动切新版 → stale=true；UI 显示「2 版」角标 |
| 9 | A/B 选片入片 + stale 三态闭环 | ✅ | 选新图 775 → recompose（#776 快照 images[0]=775）→ 选回 283（stale=true）→ recompose（#778 images[0]=283）；false→true→false |
| 10 | UI 目检（浏览器截图） | ✅ | Run 40 页 3 处镜头工作台（定妆照 5 镜 / 出图 20 镜 / 动效 0 镜）；橙色「待重新合成」徽标；版本组/选片/批量时长控件可见（`.qoder/tmp-runs40-shot2-jingtou.png`） |

## M3 验收快照（2026-09-10）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 记忆基建：status / 近义检索 / 重建索引 | ✅ | probe:m3 记忆 10 项；`/memories/status` 512 维；近义表达 top1 0.672（非字面） |
| 2 | 记忆 action 链路：空召回占位 → 落库 → 二次召回注入 | ✅ | Run 33 remember 落库；Run 34 recall `{count:1, topScore:0.583}` 且 draft prompt 快照含召回段 |
| 3 | 角色库：建档 + 定妆照 + 注入 + 二次 run | ✅ | Run 40：5 定妆照 + `created 5 / refAttached 5`；镜头任务 21/25 含「角色锚定…必须剔除」；Run 41：`updated 2 / refAttached 0` 且 18/18 注入；Web 角色页 6 名 |
| 4 | 音频情绪：六字段 + 字幕纯净 | ✅ | 资产 188 `params.{speaker,voice,voiceSource,voiceHint,emotionHint,emotionKey,emotionSent}`（emotionSent=null 待支持实例）；SRT 括注 0 命中 |
| 5 | 音画精确对齐：ffprobe 对照 | ✅ | Run 33：Σ23 句 58.88s = SRT 末条；首句 2.640s / 末句 2.480s 逐句一致；尾部 1.18s 静音垫（silencedetect） |
| 6 | T1 图文：reject/approve 双态 + 配图开关 | ✅ | Run 37（reject→attempts=2、意见注入；inline skipped）；Run 38（3 张内页 768x1024 + publish 配图顺序/溯源） |
| 7 | T2 v2 三态：全链 / 免审直烧 / 纯字幕 | ✅ | Run 33 成片 60s 含音轨字幕；Run 35 字幕闸门 `user_skip` 放行；Run 36 `estimated` SRT 无音轨成片 |
| 8 | T3 无回归：静态分支复跑 | ✅ | Run 41 completed（`gen_refs`/`gen_motion` 按 when 跳过，执行路径与 M2 同构） |
| 9 | 跨体裁复用率（出口问题 1） | ✅ | 三模板 action 矩阵：均 100%（零体裁专属新 action）；memory_recall/write 跨 2 模板、character_sync 跨模板可用 |
| 10 | README + prompts 体检 | ✅ | 本文件；12/12 prompt 外置可达、三模板 `promptsDirty=false`、模板页/prompts 页无告警 |

## M2 验收快照（历史）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 编排语义实弹：gate skip / when 互斥 / 并行与 skipped 呈现 | ✅ | Run 24→26：分镜闸门「免审直接出图」记 `user_skip`（产物保留）；`gen_images` 按 `motion` 互斥跳过 |
| 2 | 快照隔离：运行中改模板不影响续跑；新 run 用新模板 | ✅ | Run 29（gate 挂起 → PUT 改模板 → 批准续跑仍按快照）；Run 30（新 run 即时含新步骤） |
| 3 | 模板在线管理：校验 / CRUD / 即时生效 / 坏 YAML 不改文件 | ✅ | 坏 YAML validate 内联报错（含行号）且 PUT 400 保持原文件；保存后新 run 即用（Run 30） |
| 4 | ai_video 启用：真实出片 + 溯源 + 中断恢复 | ✅ | Run 21（10 段）/ Run 26（20 段 = 复用 9 + 重跑 11）；溯源含 provider / model / 参数快照 |
| 5 | 配音字幕：voice 资产 + 字幕烧录（回补 M1 #5） | ✅ | Run 18：11 段 voice（ffprobe mp3）；成片含 aac 音频流 + OCR 抽帧双点字幕命中 |
| 6 | 三流合成：时长对齐、音轨可听 | ✅ | Run 18 成片 60s：h264 + aac 44.1kHz 立体声与画面等长 |
| 7 | 恢复 / 重试：强杀 recover + resume 幂等 | ✅ | Run 22 强杀 → recover（幂等 ×2）→ resume Run 23 completed（仅重跑 9 个未完成） |
| 8 | 北极星：两条模板端到端跑通（模板驱动不改码） | ✅ | T1 v2 / T2 全链路模板驱动；期间修复 2 个引擎缺陷（见 review，非流程定制） |
| 9 | README 回归路径更新（含 M1 #5 字幕回补复验） | ✅ | 本文件；M1「字幕」判据由 T2 实际烧录关闭 |
| 10 | 无回归：M1 存量 run 续跑 + 静态分支 | ✅ | Run 8（M1 无快照）resume → Run 25 completed（引擎按 v2 补充步骤行、复用 M1 产物） |

## M1 验收快照（历史）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | `pnpm dev` 双端 + `/health` 全绿 | ✅ | db/ffmpeg/workspace 均 ok |
| 2 | Web 建项目 + 上传 imports 去重 | ✅ | 项目 1；brief×2/source×1 资产 |
| 3 | 流式日志 → waiting_input → Web gate 审阅 | ✅ | Run 10（真实 UI 审阅通过） |
| 4 | storyboard ≥8 shots；并发 ≤2、重试 1 次、成功率 ≥90% | ✅ | 19 shots；19/19 成功（100%） |
| 5 | mp4 1080x1920 带封面 → 浏览器 Range 预览 | ✅ | ffprobe 实测 1080x1920/76s；206；**字幕判据由 M2（T2 烧录）回补复验** |
| 6 | 强杀恢复：无悬挂 processing、waiting_input 可续 | ✅ | Run 9 由失败恢复 completed（幂等复用） |
| 7 | shot_image 可溯源 {run,step,task,prompt,params} | ✅ | asset#32 → run9/step22/task57 |
| 8 | 本 README 回归路径 | ✅ | 上文 A/B/C（M2 版已更新） |
