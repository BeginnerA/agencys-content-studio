# 里程碑能力速览（M2–M28）

按里程碑（升序）记录各版本的设计原则、action / 端点面变更、模板与提示词升级与验证命令。本文档自包含；M2–M19 速览中的文件名为当时历史记述，现行目录结构以 M28 节为准。

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

- **模板家族 ×10**：外部「内容创作者套件」（8 技能：选题雷达 / 创作策划 / 文字创作 / 剧本创作 / 分镜提示词 / 平台适配 / 盘点复盘 / 内容编排）方法论平移为 studio 原生模板（见[内置模板详表](./templates.md)「方法论来源」列）
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
- **导航**：运行页「画布视图」（`?run=`）+ 模板页「画布」（`?template=`）+ `/canvas` 直链（空态含最近运行与模板引导）；画布内「运行详情 ↔ 画布」双向跳转。侧栏「画布」入口已收敛为创作画布（M16，见下节）——两者并存互不替代，仅入口层消歧

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
- **导航**（入口收敛）：侧栏单入口「画布」= 创作画布（`/creation`，无参数进入自动选首个项目）；流水线画布退为上下文视图（运行页「画布视图」/ 模板页「画布」进入，`/canvas` 直链保留）

验证：`pnpm --filter @acs/server probe:m16`（六节：canvas-doc / node-build / edit-cap / draft / linkage / regression，126 项断言，零网络零计费）。

## M17 能力速览（创作工作台）

把创作画布从「带连线的执行器」升级为**完整创作工作台**：创作循环（怎么出好图）、规模操控（怎么管一堆节点）、产出沉淀（做完怎么出去）、能力扩展（音频与合成 / AI 辅助）四层一次补齐。设计三原则：**采纳优先**（节点对外引用与显示同源走 `pickDisplayTask`——采纳任务 > 最新成功）、**命令栈撤销**（客户端 `canvas-history`，删除逆操作 = 快照重建 + `restoreFromNodeId` 任务历史认领）、**确定性规则**（串联 / 整理 / 编号均为纯函数；LLM 决策式编排不在本版）。

> ⚠ **交互变更（唯一破坏性）**：空白左键拖拽由「平移」改为**框选**（半透明选框，释放按全包含判定）；平移改为 **空格按住 + 左键拖** 或 **中键拖**。快捷键（输入框聚焦时除 Esc 全部让行）：`Delete/Backspace` 删除选中、`Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y` 撤销/重做、`Ctrl+D` 复制（偏移 +40,+40）、`Ctrl+A` 全选、`方向键 / Shift+方向键` 微移 10px / 1px、`F` 适应视图、`Esc` 清空选中 / 取消连线。

- **创作循环**：变体执行（`POST /nodes/:id/run` 超集 `variants: 1–4`，按钮「执行 ×N」）→ 结果画廊（最近成功 ≤12 + 「采纳 ✓ / 最新」徽标 + 大图预览）→ `PATCH adoptedTaskId` 钉稿（下游引用即取采纳产物）；新 kind `entity`（实体参考图集直通 reference 端口，执行时展开 `refAssetIds`，超限截断记 notes）与 `text`（prompt 端口覆盖 spec.prompt，空文本 → 未就绪；`extract` 从 gen 节点 / 文本资产一键提取文本节点）
- **工作台操控**：多选（Shift 加/减选）/ 框选 / 批量移动（多拖一次提交）·复制·删除·执行（`canvases/run`：就绪者入队、未就绪 skipped + problems 提示）；撤销/重做命令栈（≤100 步：移动 / 新建 / 删除 / 连线 / 复制 / 整理 / 编号 / 采纳 / 字段编辑入栈，pan·zoom·执行·导出不入栈）；一键整理（拓扑分层）/ 对齐 / 分布 / 批量编号（`seq` 落库，卡片 `#N` 徽标）
- **产出沉淀**：内嵌 **run 节点**（「送去运行」不再跳转——视口中心新建 + toast「查看详情」入口；非终态 5s 轮询 + 「取消」）；**zip 打包导出**（`creation-export` 归档资产，条目 `<seq>-<title>-<assetId>.<ext>`（重名递增）+ `manifest.json`，下载复用既有资产通道）；**全局总览抽屉**（按严重度排序 失败 › 未就绪 › 运行中 › 就绪 › 完成，点击行选中并视口居中）
- **音频与合成**：**audio 节点**（复用 `services/tts.ts` 六级声线链 + `recordUsage(tts)`，结果 `<audio>` 试听）；**compose 节点**（video 端口 ≤4 按边序 concat + audio 端口 ≤4 amix 混音，`buildComposeArgs` 纯函数 + 本地 ffmpeg 三级兜底）；产物落 `video/` 与 `audio/` 子目录
- **AI 辅助**：提示词扩写（`POST /nodes/:id/prompt-expand` → 对照弹窗原/新可编辑 → 应用入撤销栈；未配置 LLM → 400 引导 Settings）；规则式串联（`nodes/chain`：text→prompt / 视频→video / 音频→audio / 图像→reference，skip 逐因记账）
- **数据与兼容**：`canvas_nodes` +2 列（`adoptedTaskId` / `seq`，ensureColumn 幂等；旧库升级不炸）；端口矩阵 v2（+prompt / video / audio 端口；reference 扩实体源；from 侧类型校验补齐；run 节点不参与连线）；M16 既有 14 端点全部超集兼容（旧 body → 旧行为，响应只增字段）；生成主链 / M15 流水线画布零 diff；零新依赖（fflate 既在依赖）

验证：`pnpm --filter @acs/server probe:m17`（八节：node-kinds / port-v2 / input-v2 / batch-ops / variant-adopt / run-node / export / llm-assist，274 项断言，零网络零计费）。

## M18 能力速览（创作画布规模化与安全）

在 M17 工作台之上补齐**安全（可逆删除）· 规模（成组 / 封面）· 能力（LLM 文本节点 / 模板 v2 试跑）· 快赢（抽帧 / 合成转场 BGM / 预估定价 / 停止全部）**四批共 14 项能力。设计三原则：**回收站优先**（画布删除由物理级联改软删，快照「保留 id 重放」保证恢复后任务历史不断链）、**读模型超集增量**（`GET /canvases` 与画布 doc 只增字段〔cover / groups / groupId〕，M16/M17 旧客户端与既有端点行为零破坏，除下方明示软删变更）、**流式与端口收敛**（导出 `zipSync` 全内存改 fflate 流式直写临时文件；LLM 文本节点并入端口矩阵 v3）。

> ⚠ **语义变更**：`DELETE /canvases/:id` 由**物理级联删除**改为**软删进回收站**——节点 / 边物理保留，同时中断在途任务，响应 `{ mode:'trashed', deletedAt, cancelled }`；`GET /projects/:id/canvases`（默认）只返回活跃画布，软删项经 `?trash=1` 单列，可 `POST /canvases/:id/restore` 恢复或 `POST /canvases/:id/purge` 彻底删除（purge 才物理删 nodes/edges/groups/snapshots，gen_tasks 留痕）。新增快捷键 `Ctrl+G` 成组（≥2 选中；解组走组条菜单）。

- **回收站与快照（安全）**：`canvases.deleted_at` 软删列 + `listCanvases({ trash })` / 软删 / `restore` / `purge` 四态；`canvas_snapshots` 表 + 文档快照 CRUD（`POST/GET /canvases/:id/snapshots`、`POST /canvases/:id/snapshots/:sid/restore`、`DELETE /canvases/:id/snapshots/:sid`，上限 20）——**恢复前自动备份当前态**、按保留 id 重放（节点 id 原样保留 → 生成任务历史认领不断链）、id 占用冲突 409 不半吊子
- **LLM 文本节点（能力）**：gen 节点新 `genKind: 'llm'`（端口 v3：reference / text / prompt 入，产文本）；`executeLlmOnce` 复用 LLM 通道 + `recordUsage`；未配置 → readiness 预检提前引导 Settings；产物文本卡片就地预览
- **模板 v2 与试跑（沉淀）**：draft v2 分级保真（shots / lines / files 结构映射 + entity→注释）+ **lossy 显式降级清单**；新 `literal` action（固定产物入库，零 LLM）+ `ai_text` `prompt_inline`；`POST /canvases/:id/template-try`（`{ nodeIds?, key? }` → `{ templateKey, runId, lossy, input }`）一键试跑（子图闭包 → 建 run → 视口中心自动新建 run 节点）
- **成组与折叠（规模）**：`canvas_groups` 表 + `canvas_nodes.group_id`；doc `groups[]`（title/color/collapsed/x/y，成员前端派生包围盒）+ node `groupId`；端点 `POST /canvases/:id/groups`（≥1 节点、须属本画布、拒跨组、锚点=包围盒左上）/ `PATCH /canvases/:id/groups/:gid`（title/color/collapsed/x/y）/ `DELETE`（解组：成员归属清空、组行删）；copy 出节点 groupId 归零、删成员不级联删组（空组保留）；Ctrl+G 成组 / 组条折叠·重命名·改色·解组·拖拽移组
- **封面与流式导出（规模）**：`listCanvases`（含回收站）+ `cover`——取画布最近完成 succeeded 任务产物缩略（两次批查避 N+1），画布选择卡片渲染缩略图；导出 zip `zipSync`→fflate `Zip`（文本 / manifest `ZipDeflate` level 6、媒体 `ZipPassThrough` store、`createReadStream` 分块）直写临时文件 → rename → 登记，端点 / 命名 / manifest 结构零变化
- **快赢四枚（批 1）**：视频抽帧 `POST /nodes/:id/extract-frame`（`{ mode?, time?, x?, y? }`；first/last/custom + `-ss` 前置全尺寸 jpg → 建 asset 节点首帧接力）；compose v3 转场 + BGM（复用 `buildTransitionPlan` + ffmpeg-merge 滤镜串）；`POST /canvases/:id/run-preview` 真实定价预估（`{ nodeIds? }` → `{ nodes, total }` 零副作用，`resolveUnitPrice` 与 `recordUsage` 同源）；`POST /canvases/:id/tasks/cancel` 一键停止全部（pending/processing → cancelled）
- **数据与兼容**：`canvases.deleted_at` / `canvas_nodes.group_id` 两列 + 两表（`canvas_groups` / `canvas_snapshots`，ensureColumn / ensureTable 幂等，旧库升级不炸）；端口矩阵 v3；M16/M17 既有端点全超集（旧 body → 旧行为，响应只增字段）；零新依赖
- **Web**：`CreationView.vue`（顶栏停止全部 / 快照抽屉 / 试跑 / 回收站入口 / lossy 展示；批量面板预估成本 / 加实体参考 / 成组）、`CreationBoard.vue`（组框渲染 / 折叠隐藏成员与相关边 / 组条拖拽·重命名·改色·解组 / Ctrl+G / 画布选择封面卡片）、`CreationInspector.vue`（抽帧 / compose 转场·BGM / llm 表单与产物文本 / 实体参考）

验证：`pnpm --filter @acs/server probe:m18`（九节：p1-schema + frame-extract / compose-v3 / run-preview / trash-snapshot / llm-node / template-v2 / groups / scale-zip，247 项断言，零网络零计费；含 30MB 大文件流式 store 逐字节对拍）；`probe:m1~m17` 回归全绿（适配 1 处：probe-m16「删画布 → 级联清空节点与边」断言随软删语义改为「软删 → 节点/边物理保留可恢复」）。

## M19 能力速览（成片品质与品牌化）

M18 后全景评审的最大缺口集群一次性收口：**批 1 品牌化**（字幕样式配置化 / 品牌水印 / 片头片尾）+ **批 2 声画**（per-shot 音效 SFX / 多画幅双路径）+ **批 3 生成链**（素材页批量生成参考图 / states 逐镜注入 / 声音克隆）共 8 项。设计三原则：**三层品牌配置**（平台 `settings.brand` / 项目 `projects.settings.brand` / run `_compose.brand`，字段级浅合并——换 run 调品牌不改项目默认）、**分支开关零漂移**（无新配置时 ffmpeg filter 链逐字节不变，M7/M11 先例，probe-m11 合成快照零适配为证）、**宽容降级**（素材缺失 / 引用失效 → 跳过 + log，绝不阻断合成与生成主链）。

- **字幕样式（批 1）**：`brand.subtitle` 结构化字段 `font` / `size_pct` / `color` / `outline_color` / `outline_pct` / `shadow` / `margin_v_pct` / `alignment`（2 底部 · 5 中间 · 8 顶部）/ `bold`；`buildSubtitleStyle(H, cfg)` 基线即原 `defaultSubtitleStyle(H)` 现公式（字段序一致），**零漂移红线 `buildSubtitleStyle(H, {}) === defaultSubtitleStyle(H)` 逐字相等**；模板自由串 `subtitle_style` 旧通道继续生效，结构化配置接管时旧串被忽略并写日志
- **品牌水印（批 1）**：`brand.watermark`（`position` 九宫格 tl/tc/tr/ml/mc/mr/bl/bc/br · `opacity` 0.05–1 · `width_pct` 0.03–0.5 · `margin_px` 0–200）；素材来源二选一——`file`（平台品牌目录文件名）或 `asset_id`（项目资产，须存在 · 属本项目 · 未删）；端点 `POST/GET/DELETE /settings/brand/assets/:slot`（slot = `watermark`/`intro`/`outro`，multipart 上传 + sanitizeName 落 `BRAND_DIR`）；overlay 走绝对路径 `-i`（规避 Windows 转义）；文件缺失 → 跳过水印 + log
- **片头片尾（批 1）**：`brand.intro` / `brand.outro` 复用同一素材槽结构；成片时长 = 片头 + Σ分镜 + 片尾，**字幕 SRT 时间轴单次平移**（片头位移与镜头对齐位移合并为一次变换；条目数量不符 → 回退原样）；配音起点随片头位移；BGM 覆盖全片（含片头尾）；v1 丢弃片头尾自带音轨（交叉淡化列后续候选）
- **镜头音效 SFX（批 2）**：`GET /runs/:id/compose/sfx`（绑定清单）/ `POST /runs/:id/compose/sfx`（multipart `shot_id` + `file`，或 `asset_id` 复用既有资产）/ `DELETE /runs/:id/compose/sfx/:shotId`；**每镜 ≤1 条**（重复绑定即覆盖）；绑定行落 assets `purpose=sfx` + `params.shotId/source`（零新表零新列）；合成时在镜头起点 `amix` 混入、全局 `_compose.sfx_volume` 控音量；无绑定的镜头滤镜链零 diff
- **多画幅双路径（批 2）**：**A 派生**（默认推荐）`POST /runs/:id/derive-aspect` body `{ aspects[], strategy: 'crop'|'pad' }` → 对既有成片二次处理，产物 `purpose=final_video_derived` + `params.source='derived'`，同源重复请求幂等复用；**B 合成内多路**（可选勾选）`_compose.multi_aspect { enabled, aspects（去重后 1–3 项）, strategy }` → 同一次渲染输出多画幅（原生构图而非缩放，编码耗时 ×(1+k)），产物 `params.native=true` / `source='multi_render'`，音频以 `asplit` 分流供多路 mux；画幅白名单 `9:16 / 1:1 / 4:5 / 16:9`（`resolveAspectSize` 以高度基准取偶数像素）
- **素材批量生成参考图（批 3）**：`POST /entities/ref-gen`（`{ entity_ids ≤10, variants ≤4 }` → 异步任务队列，gen_tasks 复用「无 run」先例 + socket 事件 `entity.ref_gen` 进度）、`GET /entities/ref-gen/tasks`（批次与逐任务状态）、`POST /entities/ref-gen/tasks/:id/cancel`（在途取消 → 产物弃存不落库）；成功即自动挂接为实体参考图（`reference_character` / `reference_scene` / `reference_prop`）；提示词 = 实体外观（或 states 变体）+ 项目风格预设；逐条用量记账可与账单对账；服务启动恢复将在途任务标 failed
- **states 逐镜注入（批 3）**：实体 `states` 数组承载定位词格式条目「第5场受伤：额头绷带」（`char-profile.md` 规则 8 给出书写指引，schema 不变）；纯函数 `parseStateEntry` / `matchStateEntry` / `injectStateAnchors` 做**三级匹配（场 > 集 > 全文）**，命中即把锚点短语追加进该镜角色外观，`ShotSpec.scene` 同步支持场景 / 道具注入；保守规则无兜底（无命中 = 逐字零 diff），命中明细写 run 日志可审计
- **声音克隆（批 3）**：平台级表 `voice_clones`（name / provider_key / model / voice_id / status / meta，**不存任何密钥**——端点与 Key 一律经语音合成实例配置解析）；端点 `GET /voice-clones`（`{ items, providers }`，providers = audio 供应商目录全量 + `available` 能力位）/ `POST /voice-clones`（multipart `name` / `provider` / `file`〔/ `target_model` / `sample_url`〕）/ `DELETE /voice-clones/:id` / `POST /voice-clones/:id/test`（真实合成试听，返回音频流 + `X-Voice-Id`）；含样本类型与大小校验、协议字符集前缀清洗、供应商错误族映射（重名 / 参数非法 → 400，上游失败 → 502 带详情）；v1 白名单 `aliyun_qwen_tts`（`qwen-voice-enrollment` + 默认目标模型 `qwen3-tts-vc-2026-01-22`，本地样本 Data URL 内联传输），协议表另备公网 URL 形态；未登记供应商 = 能力位灰 → UI 置灰 + 400 `unsupported_provider`
  - **`clone:{id}` 音色引用**：声线六级链 `line.voice_hint → 角色库 voice → params.voice → settings.audio.voice → 实例 extra.voice → alloy` 中**任一级**写 `clone:{id}` 且音色库命中 → 换该 provider 端点 + 克隆绑定模型合成（克隆与合成必须同模型），产物溯源 `params.voiceSource='clone'` + `clone_id` / `clone_name`，用量按真实下发模型记账；引用失效 → 跳过该级继续降级（warn 留痕）；**`resolveVoiceChain` 旧调用签名逐字兼容**（不传 `cloneIndex` 时行为不变，probe-m3 旧断言零适配）
- **数据与兼容**：+1 表（`voice_clones`，ensureTable 幂等）+1 目录（`workspace/brand/`）+1 env 常量（`BRAND_DIR`）；assets **零列改动**（SFX / 派生画幅走 `purpose` + `params` 先例）；compose 配置键白名单扩展（`brand` / `sfx_volume` / `multi_aspect`）；**无破坏性行为变更**，未配置新键时全链行为逐字节不变；`ai-image` 无 states 零 diff；零新依赖
- **Web**：`ComposeSettingsModal.vue`（由 BgmModal 升级为六区合成设置：BGM + 字幕样式 + 水印 + 片头尾 + SFX + 多画幅，run 级覆盖）、`BrandSettings.vue`（平台品牌 tab / 项目品牌 tab / 弹窗覆盖区复用同一表单）、`VoiceLibrary.vue`（设置 → 音色库：能力位矩阵 + 新建克隆 + 试听 + 复制 `clone:{id}` + 删除）、`ShotSfxModal.vue`（镜头卡片音效绑定）、`AspectDeriveModal.vue`（成片卡片派生画幅）、素材页批量生成（多选动作 + 弹窗 + 页内进度）、角色编辑器克隆音色下拉

- **操作指引（一次性配好 → 每次只微调）**：① 设置 → 品牌：上传平台水印 / 片头 / 片尾并定字幕样式（全局默认）→ ② 项目详情 → 品牌 tab：只对例外项目覆盖（资产选择器可直接选项目图片）→ ③ 运行页 → 合成设置：单次 run 覆盖（只影响本次合成）→ ④ 工作台镜头卡片「音效」按钮绑定 per-shot SFX → ⑤ 重新合成后生效（以上改动均不触发执行）→ ⑥ 成片卡片「派生画幅」按需补比例，或在合成设置里勾选多画幅原生渲染一次出多路 → ⑦ 素材页多选实体 → 批量生成参考图（页内看进度 / 可取消）→ ⑧ 角色档案 `states` 写「第N场……：锚点短语」后重跑分镜即自动逐镜注入 → ⑨ 设置 → 音色库：上传样本克隆 → 复制 `clone:{id}` → 贴到角色 voice（或项目音频设置 voice）即可全链引用

验证：`pnpm --filter @acs/server probe:m19`（八节 **378 项断言**，零网络零计费：subtitle-style 20 / brand-watermark 32 / intro-outro 16 / sfx 41 / aspect 57 / ref-gen 79 / states 39 / voice-clone 94）；`probe:m2a ~ m18` 全量回归 **零适配全绿**（17 个探针合计 2233 项断言）；实弹（真实合成 ffprobe 对账 + 真实出图 + 真实阿里云声音复刻与 `clone:` 配音）全部通过。

## M21 能力速览（工作台体验：检索·通知·键盘流）

M18 后缺口集群「工作台体验」+ Backlog 存量项（键盘流 / 并行上限）合一收口：**批 1 快赢三枚**（全局搜索 / 浏览器通知 / 资产与项目标签 UI）+ **批 2**（命令面板 / Gate diff 审阅）+ **批 3**（全局并发上限 / 集级参数热调）共 7 项。设计三原则：**读模型与 UI 为主**（搜索零新依赖：SQL LIKE + 本地向量语义 + 自研 LCS diff）、**快照即证据不破**（热调只增改 `run.input._params` + `_params_log` 全量留痕，`template_snapshot` 零触碰）、**两泵互补无滞留**（全局并发闸门与批调度经 settle 链协同：任一 run settle 均推进本批并扫描全部停滞批，30s 定时器兜底）。

- **全局搜索（批 1）**：`GET /search?q=` 九域关键词命中（项目 / 运行 / 资产 / 实体 / 画布 / 文本 / 发布 / 批次 / 排产；`% _ \` 转义、纯数字按 run id 精确）+ 文本域语义混合（bge-small 本地向量 `minScore 0.25`，模型不可用自动降级关键词并标注降级态）+ `POST /search/reindex`（单 inflight 防重 + 首搜自动索引 + `indexing` 状态透出）；前端 Ctrl/Cmd+K 面板；assets +2 列（`embedding` / `embedding_model`，ensureColumn 幂等）
- **浏览器通知（批 1）**：Notification API + 权限引导 + run 终态 / 闸门到达 / 批次完成三类推送（Socket.IO 事件链复用）；仅 `document.hidden` 时推送、无权限静默降级；settings `notify` 四开关
- **资产 / 项目标签 UI（批 1）**：资产预览器内联增删标签（成功保存即更新本地基准，防宿主刷新滞后期间的陈旧回写）、资产网格标签徽标 + 筛选、多选批量打标；项目表单标签字段 + 列表筛选；`?tag=` 过滤下推 SQL（`json_each` 精确成员匹配 + `json_valid` 守卫——修复 limit/offset 后内存过滤的分页错位，含引号 / 反斜杠 / 跨元素拼接串零误配）
- **命令面板（批 2）**：Ctrl/Cmd+K 面板 = 导航 9 页 + 全局动作（新建项目 / 新建排产计划，`?new=1` 深链接）+ 上下文动作（run 页取消运行 / 批次页取消批次，确认弹窗防误触）+ 搜索直达
- **Gate diff 审阅（批 2）**：`GET /runs/:id/steps/:k/revisions` 版本链端点 + 闸门弹窗 diff tab——自研 LCS 行级对比（+/- 渲染、行长 5000 上限 + 前后缀裁剪）
- **全局并发上限（批 3）**：settings `concurrency.max` 1–6（默认 3，env `CSTUDIO_GLOBAL_MAX_CONCURRENT` 兜底）；engine 全局闸门（startRun 三态：started / running / deferred，deferred 归一 queued 等泵补位）+ 批协同（settle → 本批 pump + 全量停滞批扫描）+ 30s 定时兜底；`PUT /settings/concurrency` 即改即生效；设置页「运行」Tab
- **集级参数热调（批 3）**：`PATCH /runs/:id/params`——状态门（queued / running / waiting_input）+ 组内字段级深合并 + 字段白名单 + 无变化幂等 + 条件写防终态竞态；`_params_log` 追加留痕（at / changes / source）；未执行步骤每步重读生效（已执行与 in-flight 不动）；运行页参数面板（当前值对照 / 留痕时间线 / 终态只读）
- **数据与兼容**：无新表（assets +2 列 / settings +2 key）；引擎单 run 执行链 / DAG / gate 语义逐字不变（startRun 返回值为增量信息，既有调用方零破坏）；搜索零新依赖；`?tag=` 语义对齐完整标签匹配
- **Web**：`CommandPalette.vue` / `RunParamsPanel.vue` / `lib/notify.ts` / `lib/hotkeys.ts` / `lib/diff.ts` / `lib/nav.ts`；`GateDialog.vue` diff tab；`AssetGrid.vue` / `previewer/` / `AssetsPanel.vue` / `ProjectFormModal.vue` 标签链；`system-settings/index.vue` 通知与运行 Tab；`App.vue` 面板挂载 + 通知初始化

验证：`pnpm --filter @acs/server probe:m21`（六节 **86 项断言**，零网络零计费：search 15 / revisions 10 / concurrency 28 / hot-params 18 / tags-sql 10 / settings-kv 5）；`probe:m2a ~ m19` 全量回归 **零适配全绿**（17 个探针）；`tsc` + `vue-tsc` 双端全绿；实弹（C6 并发设置保存与回落 / C7 热调 run 103 全链留痕与幂等 / C5 闸门面板 + revisions / C4 面板打开 / C1 HTTP 兜底命中）。

## M22 能力速览（创作画布深化：编辑与保真）

M18 后缺口集群「创作画布深化」九项一次交付：**批 1** 画布内音字对齐全链 + 参考边保真 v3；**批 2** 组嵌套 + 快照 diff / 分支 + compose 智能裁剪；**批 3** 回收站保留期自动清理 + 跨画布复制 + PNG/SVG 导出 + 多帧抽帧。设计三原则：**缺省全关零漂移**（新字段缺省时 compose args 逐字节不变，快照断言锁定）、**宽容降级**（对齐 / 字幕 / 清理 / 抽帧失败一律 note 不阻断主链）、**混合策略自包含**（同项目跨画布直接引用；跨项目拷贝资产文件与实体级联，画布自包含）。

- **音字对齐全链（批 1）**：compose spec +`align` / `subtitle`（none·auto·asset）/ `subtitleAssetId` / `burnSubtitles`；段级配对 video[i]↔audio[i]（边序）——段时长 `max(视频, 音频)`：视频 `tpad` 冻帧补足 + 音频 `apad+atrim` 静音填充 + `concat` 顺序拼接；SRT 自动生成（音轨文本）/ 已有字幕平移重钉（数量不符降级）；`subtitles` 滤镜烧录（Windows 路径转义）；转场与对齐互斥宽容禁用；SRT 落资产 `creation_subtitle`；前端 GenForm 四控件
- **参考保真 v3（批 1）**：draft 路径 reference / first_frame 两类 lossy 清零——literal +`inputs.refs` / `inputs.first_frame`（flatten + 正整数过滤）；引擎 shots +`ref_asset_ids` / `first_frame_asset_id`（ai-image 前插合并去重；ai-video 首帧「画布直通 > gen_frames 索引」优先）；last_frame / source 仍按预期 lossy
- **组嵌套（批 2）**：`canvas_groups` +`parent_id`（ensureColumn 幂等）；多层组（`groupIds` / `parentId` 入组、移组防环 400 `group_cycle`、删父组子组提升、折叠递归隐藏后代、包围盒递归并集、拖动组递归平移）；前端按深度升序渲染 + 「移入组 ▸ / 移出到顶层」菜单
- **快照 diff / 分支（批 2）**：`GET …/snapshots/:sid/diff?against=live|<sid2>` 字段级差异（added / removed / modified + 200 字符截断）；`POST …/snapshots/:sid/branch` 从快照分支为新画布（事务内新 id 重放：组 → 节点 → 边全映射）；快照 Modal「对比」视图 + 「分支为新画布」
- **compose 智能裁剪（批 2）**：+`fit`（pad 信箱缺省 / crop 裁切满幅——`scale:increase,crop` 链）；缺省零漂移
- **回收站自动清理（批 3）**：settings `trash { retentionDays 1–365（默认 30）, autoPurge（默认 true）}`；纯函数 `selectExpiredCanvases` + `purgeExpiredCanvases` 全表扫（复用 purgeCanvas 级联；gen_tasks 留痕）；启动 + 6h 定时（unref）；设置页「数据」Tab；手动 purge 逃生口保留
- **跨画布复制（批 3）**：`POST /canvases/:id/nodes/copy-to`——同项目深拷（内部边重映射、`+40,+40` 偏移）；跨项目级联拷贝（资产文件 `copyFileSync` + `copiedFrom` 留痕、compose BGM / edit mask 引用重写、实体级联 + `refAssetIds` 逐张拷贝、run 节点跳过报告、`adoptedTaskId` 置 null）；前端多选 →「复制到画布…」弹窗 → 摘要 toast + 目标画布计数即时刷新
- **PNG / SVG 导出（批 3）**：服务端 `buildCanvasSvg` 纯函数（视口包围盒 +40 padding / 节点卡色板 / 贝塞尔边 + 箭头 marker / 组框嵌套递归 / XML 五字符转义）→ `POST …/export-image` 落资产 `creation_svg`；前端导出菜单三合一（zip 打包 / PNG 2x 光栅化下载 / SVG 下载）
- **多帧抽帧（批 3）**：`uniform` 模式 count 2–9——`t_i = 0.1 + (dur − 0.2) × i / (count − 1)`（count=3 恰为首 / 中 / 尾；dur ≤ 0.3 退化首帧；时长未知报错）；N 帧网格排布（缺省 +60/+140 起、3 列 ×260 / 行高 ×200）；响应兼容单帧 `{node, asset}` + uniform 追加 `{nodes, assets}`
- **数据与兼容**：无新表；`canvas_groups` +1 列 / `settings` +1 key / compose spec +5 字段（align / subtitle / subtitleAssetId / burnSubtitles / fit）；新端点 4 枚 + 扩展 3 处；缺省全关零漂移（probe-m16/m17/m18 回归为证）

验证：`pnpm --filter @acs/server probe:m22`（十一节 **169 项断言**，零网络零计费：spec-fields 9 / trash 12 / schema 2 / align 25 / refs 12 / group-nest 18 / snapshot-diff 18 / fit 4 / copy-to 23 / export-svg 23 / multi-frame 23）；`probe:m2a ~ m19 + m21` 全量回归 **零适配全绿**（18 探针）；`tsc` + `vue-tsc` 双端全绿；三层实弹（HTTP API 16 PASS〔真实库跨项目 P10→P14：9 复制 / 1 run 跳过 / 6 资产级联 / 0 警告〕/ 浏览器 e2e 8/8〔复制弹窗、SVG / PNG 双 toast、均匀抽帧 3 帧落板〕/ 修复复核 PASS）。

## M24 能力速览（内容质量与国际化）

纲领 F 组五项一次交付：**批 1** 三层记忆摘要（双形态）+ 图像角色一致性 A/B 评测；**批 2** 翻译链双形态 + 双语字幕/多语言配音；**批 3** 内容合规审核（词库 + LLM 双轨）。设计三原则：**零新表零新列**（摘要走 memories 开放 type；合规标记落 `assets.params.compliance` 对齐 params.quality 先例）、**宽容降级全链**（LLM 复审不可用 → `llm:null` 不阻断；评分坏行跳过；翻译缺失句回退原文）、**缺省零漂移**（自动钩子默认关；`target_lang` 缺省 zh 产物逐字不变；voice_map 不传旧行为不变）。

- **三层记忆摘要（批 1）**：`memory_summary` action——scope 四级命名（project / series:{id} / episode:{id} / custom:{name}）+ 参数校验（SummaryParamError）+ merge 语义（既有+新料合并重摘要，具名 upsert 保 id）+ 900 字 guard；settings `memory.auto_summary` 自动钩子（默认关；run completed + 集关联触发，listener 隔离失败不阻断，模板已含显式步防双份计费）；`memory_recall` +`types` 过滤（`[summary]` 只召回摘要）
- **一致性 A/B 评测（批 1）**：`POST /evals/run`（模板多组对照出图）+ `POST /evals/score`（2–6 组 × ≤24 图多模态评分矩阵：一致性/还原度/画质三维 0–10）；`parseEvalScores`（围栏/坏行/全坏降级 raw）+ `aggregate`（均值/排名/并列字典序稳定）+ md 表 + CSV 段报告落库（purpose=eval_report）；评分为参考信号非硬判定（spec §5）
- **翻译链双形态（批 2）**：platform-adapt v2 +`target_lang`（缺省 zh 逐字回归；en 等适配稿以目标语言产出，风险清单「原文」列保留供对照）+ 独立 `translate-export` 模板链（入库 → ai_text 翻译 → memory 沉淀 type=translation；产物命名 `translated-{lang}.md`）
- **双语字幕/配音（批 2）**：`buildBilingualSrt` 纯函数族（both 双语 cue = 原文\n译文 / merged 仅译文 / 缺失句回退原文 / ms→SRT 换算 / end<start 收敛）；subtitle 步 +`target_lang` + `bilingual` 参数（双产物 zh-en.srt + en.srt，`params.lang` 标注）；TTS `voice_map`（resolveVoiceChain 七级：line > voice_map > params > instance…；不传旧行为逐字不变；生效落 `params.voiceSource`）
- **合规审核（批 3）**：`compliance_check` action——本地词库 `workspace/compliance/words.txt`（`类别|词|级别`，现读即用零缓存，全角归一）+ LLM 可选复审（`llm_review` 默认开，坏 JSON/非法 verdict → null 降级）双轨合成（block ∪ → block；warn 并集）；标记写回被检资产 `params.compliance {status,hits,llm,checkedAt}`（拦截仍写回）；`on_block` fail（默认，StepError 拦导出）/ mark 双语义；汇总报告 purpose=compliance_report；`GET /compliance/rules`（total/byCategory/source，词库缺失 missing 不 500）；前端资产预览顶栏徽章三态（合规通过/合规风险/合规拦截 + title 详情）；产物仅「标记/拦截」语义不构成法务意见
- **数据与兼容**：零新表零新列；白名单 +2 action（memory_summary / compliance_check）/ 端点 +3（evals ×2 + compliance/rules）/ 提示词 +5 / 模板 +1（translate-export）改 1（platform-adapt v2）/ settings +1 key；引擎 / DAG / 模板加载签名零触碰

验证：`pnpm --filter @acs/server exec tsx scripts/probe-m24.ts`（五节 **116 项断言**，零网络零计费：summary 32 / eval 27 / translate 9 / bilingual 14 / compliance 34）；`probe:m2a ~ m23` 全量回归 **零适配全绿**（21 探针）；`tsc` + `vue-tsc` 双端全绿；三层实弹 HTTP 63 断言（真实 LLM 摘要/翻译/复审 + 真实出图对照评分 + 真实 TTS voice_map 命中 + 真实词库拦截/放行）+ 浏览器徽章双态 DOM 验证。

## M25 能力速览（输入源扩展：小说链深化 + 视频反推）

纲领 G 组十项一次交付（三批）：**批 1** docx/epub 导入 + 章节可视化编辑器；**批 2** 事件图谱可视化 + 改编一致性回查 + 事件级编辑 + 多部合并 + 增量连载；**批 3** URL 抓取 + 视频长素材解析（含 ASR）+ 视频反推链。设计三原则：**零新表零新列**（doc_import / fetched / content_edits / analysis / audit 全落 `assets.params`）、**引擎/DAG 零改动**（append 只写资产不动状态机，事件链续跑走 M11 既有单步重跑）、**宽容降级**（ASR 端点缺失/非 2xx/超时 → null 不阻断主链；epub 不规范样本提取到字即成功）。

- **docx/epub 导入（批 1）**：`doc-parse.ts`（mammoth docx 纯文本 + fflate epub 自解析 container.xml→OPF→spine 线性序→XHTML 去标签）；`importFiles` 入库单点转 md 文本资产（purpose=source，`params.doc_import={format,chars}`，原二进制不落盘 v1）；novel-adapt v2 `accept` 扩 [.txt,.md,.docx,.epub]（向后兼容纯扩展）
- **章节/事件受控写（批 1/2）**：`PATCH /assets/:id/content`——kind=text + purpose 白名单 + JSON 契约校验（chapter-manifest/event/graph/plan/storyboard-json 复用 ai-text 校验）+ tmp/rename 原子写 + `params.content_edits` 计数；NovelBoard 章节编辑器 + 事件/图谱结构化表单（前端脏确认）
- **事件图谱可视化（批 2）**：`computeGraphLayout` d3-force 确定性布局（forceLink/ManyBody/Center/Collide + tick 300，同 M23 手法）；`GET /runs/:id/novel-board` 响应附 `graph.layout`（服务端算、前端零计算，加法零破坏）；NovelBoard 表↔SVG 视图切换 + 节点点击高亮
- **改编一致性回查（批 2）**：`adapt_audit` action（chapters+script → LLM 审计 `{faithful, divergences:[{kind,severity,desc,ref}]}` 契约 fail-fast → md 报告 purpose=audit_report）；`novel-audit` 正式模板（**不强制注入 novel-adapt 步链**，避免改变现行为）
- **多部合并 + 增量连载（批 2）**：`text_split` `per_source:true` 逐 source 独立切分·index 跨书续编·manifest `books`（默认 false 现行为逐字不变回归锚）；`POST /projects/:id/novel/append`（新文件导入 → 章题+首行哈希幂等去重 → 续编落库 + manifest `appended_at`；不自动级联重跑）
- **URL 抓取（批 3）**：`POST /projects/:id/fetch-source`——`assertSafeUrl` SSRF 守卫（仅 http/https，拒回环/RFC1918/链路本地/非 80·443）+ `extractReadableText` 确定性正文提取（零依赖）+ 15s/≤5MB/重定向≤3 逐跳复查 + 文本 <200 字符判反爬失败；FetchGuardError code → 502/400 映射；落 source 资产 `params.fetched`；素材页「从 URL 抓取」modal（版权免责内置：仅供个人素材整理）
- **视频长素材解析（批 3）**：`video_analyze` action——ffprobe 时长 → 均匀抽帧（2–24 独立常量，不动画布 2–9）缩宽 768 临时不落库 → ffmpeg 抽轨 16k 单声道 → `asr.ts` 转写（audio 实例 OpenAI 兼容 `/audio/transcriptions`，缺省 SiliconFlow SenseVoice，`extra.asr_model` 覆盖；不可用降级 null）→ 多模态 LLM 时间轴 JSON（`{duration,scenes,transcript}` 契约）→ `video_analysis` json（前）+ 人读 md 报告（后）双资产（`params.analysis={scenes,hasTranscript,frames,duration,asr_provider?,asr_model?}`）
- **视频反推链（批 3）**：`video-reverse` 正式模板（analyze → storyboard（ai_text `video-storyboard.md` → `storyboard-json` 复用既有校验 + required 审阅门控）→ copy（`video-copy.md` → 文案 md））；分镜产物直接满足 `ai_video`/`compose` 消费契约（`validateTextOutput` 直通）
- **数据与兼容**：零新表零新列；白名单 +2 action（adapt_audit / video_analyze）/ 端点 +3（PATCH content / novel append / fetch-source）/ 提示词 +4 / 模板 +2（novel-audit / video-reverse）改 1（novel-adapt v2）/ 新依赖 +2（mammoth / fflate，沿 M23 d3-force 纯解析库例外原则）；引擎 / DAG / 模板加载签名零触碰；novel-board 响应扩展加法零破坏

验证：`pnpm --filter @acs/server exec tsx scripts/probe-m25.ts`（八节 **141 项断言**，零网络零计费）；全量回归 22 探针 **21 零适配 + m9 一处 version 同步**（novel-adapt v2 主动升版）全绿；`tsc` + `vue-tsc` 双端全绿；三层实弹（P1 导入/编辑 22 + P2 图谱/审计/合并/增量 25（含真实 LLM 审计双链）+ P3 抓取/视频全链 ~30：真实公网 URL 抓取入库 + 真实 TTS 造口播样本 → 真实 ASR 命中（hasTranscript=true）+ 多模态时间轴 + storyboard-json 直通 8 镜）+ 浏览器章节编辑器/图谱 SVG/抓取 modal。

## M26 能力速览（工程基建与平台化）

零产品行为变更的工程里程碑（纯基建 + 纯重构，零新运行时依赖，不进任何生产构建路径）：把此前全手动的回归面固化为本地 CI，并收口 M28 遗留的「单文件 ≤800 行」红线残余。

- **本地 CI（H1）**：`pnpm ci:check` 一键聚合三段门禁——① `pnpm -r typecheck`（双端 tsc + vue-tsc）② `pnpm --filter @acs/server validate:templates`（14 模板 / 101 步全量加载零抛错零警告）③ `probe:ci`（全量探针 fail-fast 串行）。仓库在 Gitee，**不引外部 CI 平台**；`.githooks/pre-push`（`git config core.hooksPath .githooks` 可选启用）跑 typecheck + 模板校验轻量档。开发：`pnpm dev`（server + web 并行）/ `pnpm dev:server` / `pnpm dev:web`。
- **探针统一 runner（H5）**：`scripts/run-probes.ts` 自动发现 `probe-*.ts`、并行 worker 池（缺省并发 min(4, CPU-1)，`--jobs=` 覆盖）、逐枚计时 + PASS/FAIL 汇总对齐表 + `--fail-fast`。`probe:all`（并行全量）/ `probe:ci`（fail-fast 串行）。5 枚 >800 探针（m16/m17/m18/m19/m22）经 `probe-lib.ts`（isolatedEnv / makeChecker / runSections）零漂移拆分——**断言总数逐枚相等、`probe:mXX` 入口与 `--section=` 单节能力不变**。
- **规模化压测基准（H3）**：`pnpm --filter @acs/server bench`（`bench-stress.ts`）在隔离临时库种子（缺省 1000 项目 / 10000 资产 / 长 run 链），量测关键列表/聚合查询、`buildCanvasDoc` 大图、内存 RSS 峰值，产出 p50/p95 基准报告（**非阻断**，供方法库沉淀）；零网络零计费、临时库自清理。
- **Ollama 本地模型（H4）**：`ollama_llm` 作为一等预置 provider（`api_providers` seed，vendor=ollama / service_type=llm / `http://localhost:11434/v1`），走既有 OpenAI 兼容 `/chat/completions` 与 `fetch-models` 通道——**零新适配器代码**；无鉴权沿用占位 apiKey 路径。仅 LLM（embedding 维持本地 ONNX，多模态不立项）。
- **红线收口（≤800 残余）**：5 个 M28 遗留 >800 前端文件 M28 式纯重构——`lib/api.ts`(975)→`lib/api/` 按域 7 文件 + `index.ts` re-export（导入面零改动）；`CanvasBoard.vue`(855)→722；`BrandSettings.vue`(1051)→776；`NovelBoard.vue`(1099)→611 + `NovelGraphView.vue`；`views/canvas/index.vue`(1172)→774 + `use-canvas-design`/`use-canvas-realtime` composables + `CanvasGuide`/`CanvasDesignModals` 子组件。**函数体/模板/样式逐字保留、props/emits 冻结、无重命名**；全仓 `scripts` + `web/src` 复扫 **>800 = 0**。
- **H6 提交治理 / H7 在线可编程供应商**：spec 固化「提交前置门禁：双端 typecheck + 对应 probe 全绿方可 commit」成文规则（m18 偏差 #3 关闭，无代码）；H7 判定关闭（既有自定义 OpenAI 兼容 `base_url` 配置已等价覆盖「UI 配置任意端点」诉求），运行时可编程协议脚本（沙箱）永久排除。

验证：`pnpm ci:check` 端到端 exit=0（双端 typecheck + 模板校验 14/101/0 错 + `probe:ci` **23 探针 / 2873 断言全绿**）；`vite build` 绿；`probe-m26`（五节 runner / probe-lib / split-audit / ollama-seed / stress）全绿，`split-audit` 门禁收口为「红线存量 `=== 0`」；浏览器抽查（画布三态 + 设计态连线/草案/保存 + 创作画布 + 品牌设置平台/项目两态）console 零 error 无回归。

## M27 能力速览（自动编排 · 真 orchestrator）

把 M5 以来「以场景入口 + 完成态接力缓解」的跨模板流转升级为**用户显式编排、系统自动级联**的编排链 orchestrator（纲领 §一 I 组战略收官）。设计三原则：**不碰引擎**（段序列引用既有模板，无 `run_template` 递归 action，`KNOWN_ACTIONS` 零增）、**复用既有基建**（M4 `onRunSettled` 钩子 + `createRunRow`/`engine.startRun` + M20 `checkBudget` + M5 `template.next`）、**计费安全默认关**（`autoAdvance` 缺省 0 + 每跳前预算闸门 + 失败暂停不重试）。

- **I1 跨模板自动串链**：`workflows` 表存有序段序列（`segments` JSON `[{templateKey, inputSpec?}]`）+ 逐链 `autoAdvance` 开关 + 链级 `budgetCap`；`advanceWorkflow`（九步：落定守卫→失败/取消暂停→仅完成推进→autoAdvance 判定→末段 done→预算闸门→输入解析→段间产物映射→创建并启动下一段）经 `onRunSettled` 并列钩子驱动。`pipelineRuns` +2 可空列 `workflow_id`/`workflow_seq`（`ensureColumn` 幂等），链进度由关联 run 派生（无独立进度表）。
- **段间输入映射**：`resolveSegmentInput` 纯函数按 `inputSpec` 逐字段取值——`$prev.assets:<purpose>`（上游产物 id 数组）/ `$prev.asset:<purpose>`（单 id）/ `$prev.text:<purpose>`（读取上游文本资产正文）/ 字面量常量；required 未满足且无 default → `blocked{reason:'input'}` 暂停不触发。双链路口径（`step.output.asset_ids` ∪ `assets.runId`）兼容 `manual_ingest` 与 `writeTextAsset` 两类产物登记。
- **I2 模板嵌套（收窄为编排层引用）**：`clone` 复制段序列为新 draft 链（`autoAdvance` 复位 0 计费安全），复用既有模板不触引擎、无递归执行；运行时深度嵌套（step 内跑子模板 DAG）明确排除另议。
- **I3 编排可视化**：扩展 `buildCanvasOverview`（`CanvasOverview.workflows`：链状态/autoAdvance + 段序列模板名/run 状态/成本派生，无链 → `[]` 旧前端超集兼容）；全景 tab 新增「编排链」区（横向节点序列 + 段状态/成本徽章 + autoAdvance 滑动开关 + 启动/暂停/续跑/克隆/删除）+ 链构建器 Modal（选模板成序、`template.next` 建议、段间输入映射）。
- **状态机与断点恢复**：`draft|active|paused|done|cancelled`；`startWorkflow` 显式启动首段（仅 draft|paused 且链内无既有 run）、`pause`、`resumeWorkflow`（paused→active 后取链内最大 seq 已落定 run 重新驱动 advance，修复阻塞解除/事后开关联动后的续跑不断链）；events 新增 `workflow.advanced`/`segment_done`/`blocked`/`completed` 四变体。
- **并发与幂等安全**：模块级 `advancing: Set<workflowId>` 互斥锁贯通 start/advance（防并发双启动重复计费 + 防 settle 重入）；`advanceWorkflowCore` 落库前状态复核（防 pause TOCTOU）+ 下游 `workflowSeq` 存在性守卫（防重放/并发双建下游）。

端点：`GET /workflows`（?project_id=&status=）、`GET /workflows/:id`、`POST /projects/:id/workflows`（建 + 链校验 warnings）、`PATCH /workflows/:id`（active 改 segments 需先 pause）、`DELETE /workflows/:id`（仅 draft|done|cancelled）、`POST /workflows/:id/clone|start|pause|resume`。

验证：`pnpm ci:check` 端到端 exit=0（双端 typecheck + 模板校验 14/101/0 错 0 警 + `probe:ci` **24 探针 / 2919 断言全绿**含 `probe-m27` 46 断言九节〔schema / workflow-crud / segment-input / auto-advance / budget-gate / breakpoint-pause / recovery-guard / nesting-clone / overview-workflows〕）；`vite build` 绿；HTTP 契约冒烟（建链 note-clip→platform-adapt / PATCH autoAdvance / 克隆 / overview 派生 / 删除清理）通过；`git diff` 确认 engine/dag/loader/refs 零 diff、schema 纯加法。CodeReview 复核「可收口」：resume 死锁 / pause TOCTOU / 双启动计费三项修复闭环。

## M28 能力速览（架构重组：巨型文件拆分与目录域化）

纯重构里程碑（行为零变更 / 零新依赖）：15 个千行文件 + 2 个 800 行级追加文件全部拆分，固化「单文件 ≤800 行」全仓红线。服务端按域目录化（`services/creation/`〔含 `gen/` 子域〕/ `services/shot/` / `pipeline/actions/ffmpeg-merge/`）；Web 视图全目录化（`views/<domain>/index.vue`）+ 组件域归组（`components/common|creation|shot|run|project|template|asset|brand|config|pipeline-canvas`）+ `lib/types/` 按域拆分；**函数体逐字保留、导出面冻结**，全部 import 路径机械改写（46 行）。

- **服务端四件**：`creation.ts`(2,442) → 22 文件含 `gen/` 8；`creation-gen.ts`(1,398) → `creation/gen/` 8 文件；`ffmpeg-merge.ts`(1,375) → 10 文件；`shot-workbench.ts`(1,217) → `services/shot/` 8 文件；`creation-ops/groups/export` 收敛入 `creation/`
- **Web 十三件**：CreationView(2,819)→27 / CreationInspector(1,920)→10 / ShotBoard(1,588)→6 / CreationBoard(1,482)→5 / TemplatesView(1,385)→11 / RunDetailView(1,345)→10 / types.ts(1,300)→11 / EntitiesView(1,254)→6 / ProjectDetailView(1,238)→7 / StoryboardEditor(1,183)→4 / SettingsView(1,171)→6 / AssetPreviewer(821)→2 / CanvasDrawer(869)→2；router 与全部引用机械改写
- **红线终态**：全仓扫描 >800 行仅存豁免 2（`lib/api.ts` / `components/brand/BrandSettings.vue`）+ 排除 4（探针脚本，归 M26-H5）；不改清单（引擎 / 适配器 / schema / 模板提示词 / package.json）零 diff
- **红线增量登记（2026-09-16 复扫，M23 收官后）**：新增破线 2——`views/canvas/index.vue`（1172；`68d46c1` 单提交自 722 增量）与 `components/pipeline-canvas/CanvasBoard.vue`（855；P3 编辑模式）→ 登记**「触发条件式待拆」**（拆分时机 = M26 工程批〔H2 残余〕或 canvas 域被实质触碰时〔可插 M28 式纯重构微批次〕；范式对齐 M28——thin `index.vue` + `use-*.ts` + 面板组件），本次仅登记不做即时重构；`lib/api.ts` 已增至 969（存量豁免内，随 api 域拆分）；探针脚本超限现为 5（m16–m19 / m22，归 M26-H5）；复扫口径同 M28（含注释与空行），脚本留档 `.qoder/tmp-m28-scan800.mjs`。**【后续收账（M26，2026-09-17）】**上述待拆已全部完成：5 前端 >800（含 2 豁免 + 2 新破线）与 5 探针均已拆分，全仓 `scripts` + `web/src` 复扫 **>800 = 0**（见 M26 能力速览一节）
- **验证**：`tsc` + `vue-tsc` + `vite build` 全绿；17 探针（m2a–m19）「全部通过」零适配；实弹（设置 / 项目 / 镜头工作台 / 画布抽屉 / 素材预览）console 零 error
- **备注**：M2–M19 速览中的文件名为当时历史记述，现行目录结构以本节为准

## M29 能力速览（版本与追溯：内容/参考版本 · 执行真实输入快照 · 下游影响 · 锁版）

把「编辑即静默改写下游、历史不可回看、执行输入不可追溯」的隐性黑洞收口为**可回看、可还原、可追溯、可锁版**的内容治理层（R02）。设计三原则：**零行为变更红线**（执行快照一律经 `safeRecordExecSnapshot` 接入——任何异常仅告警绝不影响实际生成；所有消费点不裸调底层）；**影响只报告不生成**（`downstreamImpact` 仅返回状态分类 `current / upstream_changed / no_history`，无任何自动返修/级联重跑入口，编辑不静默改写下游）；**三操作分离 + 历史不可变**（还原 / 锁版 / 选片互不混淆；版本文件写后永不覆写，落 `versions/` 独立目录、物理 GC 豁免）。

- **追溯三表（schema）**：`content_versions`（对象版本：asset 不可变文件版本 / entity 字段 JSON 快照，`(obj_kind,obj_id,revision)` 唯一）+ `exec_snapshots`（一条 = 一次执行冻结）+ `exec_inputs`（执行实际输入依赖边：`used/skipped` + `version_id` 版本指针 + `shot_id`/`port` 镜头端口语义定位，含 snapshot 与 `(src_kind,src_id)` 反查索引）；`version_id` 为 NULL 标「历史不可恢复」不伪造。
- **版本捕获（R02）**：文本资产首次编辑懒补 baseline（v1=原文）+ 记 edit（v2=新文），旧版本内容可回看、工作副本固定路径不覆写版本文件、编辑后清空 embedding（旧向量不冒充新正文）；实体全写入口（`upsertEntity` 等）统一留痕（新建 baseline / 改外观 edit）。
- **还原 + 乐观并发**：`restoreAssetTextVersion` / `restoreEntityVersion` = 移动当前指针 + 生成新版本（`source=restore`，保留全部历史、不动下游）；`PATCH /assets/:id/content` +`expectedRevision`（缺省 last-write-wins 向后兼容；基线落后 → `conflict` 拒绝静默覆盖；详情响应附 `contentRevision` 供前端乐观锁）。
- **执行真实输入快照**：`assetInput`（文本可编辑资产带 `versionId`，媒体资产 `versionId=null` 身份即 asset.id）/ `entityInput` 构造输入边；`ai_text` / `ai_image`（参考图 used/skipped + skipReason）/ `ffmpeg_merge`（compose 源/BGM/字幕/配音）/ `workflow`（段间 prev_text）四类消费点经 `safeRecordExecSnapshot` 冻结捕获时版本序号（非事后当前）。
- **下游影响（只报告）**：`downstreamImpact({objKind,objId})` 反查消费它的执行清单——捕获版本=当前 → `current`（保留 shotId 局部命中不泛化）/ 上游再编辑 → `upstream_changed`（报告当前版本号）/ 媒体无版本指针 → `no_history`。
- **锁版（spec.pin）**：`lockCanvasInput` / `unlockCanvasInput` / `listCanvasInputLocks`——gen 节点上游资产输入锁定到指定资产（落 `spec.pin`，加法字段不动既有；多上游共存互不覆盖；解锁回落最新/采纳）；校验拒绝非生成节点 / 跨项目资产。
- **物理 GC 保护**：`version-cleanup.ts`——`versions/` 不可变历史文件不随工作副本物理删除；被执行实际消费（`used`）的老版本资产豁免清理（防在用/历史依赖被软删致追溯悬空）；三表支持按 `project_id` 级联过滤删除。
- **前后端接线**：`VersionHistoryPanel.vue`（挂进实体面板 + 素材预览器「历史·影响」区）、`CanvasInputLockPanel.vue`（挂进 gen 节点 inspector）；`lib/api/versions.ts`（`assetVersionApi`/`entityVersionApi`/`canvasLockApi`）+ `lib/types/version.ts` 领域类型与响应对齐。
- **数据与兼容**：新表 3（均 `ensureColumn`/建表兜底幂等）/ 新列 gen 节点 `spec.pin`（加法）/ `PATCH content` +`expectedRevision` + 详情 `contentRevision`（缺省兼容）/ 端点 +9（asset/entity versions·content·restore·impact + canvas input-lock 三式）；引擎 / DAG / 模板 / 适配器签名零触碰，快照接入零行为变更。

端点：`GET /assets/:id/versions`、`GET /assets/:id/versions/:versionId/content`、`POST /assets/:id/versions/:versionId/restore`、`GET /assets/:id/impact`；entity 同构四枚；`GET /canvas/nodes/:id/input-locks`、`POST /canvas/nodes/:id/input-lock`、`DELETE /canvas/nodes/:id/input-lock`。

验证：`pnpm --filter @acs/server exec tsx scripts/probe-m29.ts`（八节 **46 项断言**，零网络零计费：schema 4 / version-capture 10 / restore 6 / concurrency 3 / input-snapshot 8 / impact 4 / lock 6 / gc-purge 5）；`probe-m29` 经 `run-probes.ts` 自动发现纳入 `probe:ci` 全量（25 探针）；双端 `tsc` + `vue-tsc` 全绿。不变式落测：执行冻结真实输入（used/skipped + 版本指针）、编辑不静默改写下游（影响只报告状态分类）、还原 / 锁版 / 选片三操作互不混淆。

## M30 能力速览（对话式「一句话成片」轻松创作入口 · R07 新建单条视频子集）

把「建项目 → 选模板 → 填输入 → 懂运行 → 会审阅」的专业门槛收敛为**一句话 → 方案 → 确认一次 → 自动成片**的傻瓜入口（`/create` 与 `/create/:id`），首版交付单条 30–60 秒中文旁白多镜头短视频（科普 / 故事 / 产品介绍）。设计四原则：**复用不新建**（沿用 project/asset/run/step/task 体系与 `tts`/`subtitle`/`ai_image`/`ai_video`/`ffmpeg_merge`，不建平行引擎、不建生产状态机——制作态从真实 run/step/task 投影）；**确认内容即执行内容**（Zod 校验脚本/台词/分镜结构契约，批准后冻结为通用文本资产直供模板，不再随机二次生成；非法/超长/截断计划不得进入可确认态）；**动态/图文明确标注**（动态=真实 AI 视频镜头不静默降级、图文=静态画面+字幕非动态，首版不混用）；**费用预检 + 固定工作量 + 有限调用**（规划费/预计制作费/未计价项分列，价格缺失不按零元处理、需同卡显式接受，不宣称外部账单硬封顶）。

- **多镜头模板与严格合成（video-recipe）**：新增通用 `workspace/templates/easy-video.yaml`（6 步，不改 `mengbao-episode` 旧闸门）；`ffmpeg_merge` 增**显式启用的严格交付模式**（旧 run 默认原行为零变更）——配音后先逐镜核验时长、以批准分镜时长为基准裁切归零、允许 ≤0.5s 尾帧补齐超限即停（不无限定格掩盖缺镜）、复用台词—镜头映射组装音轨字幕（旁白不截断）、严格检查计划镜头全部存在可解码音视频字幕完整，缺镜/损坏/时长不足/错映射不得沿旧宽容路径跳过后仍报成功。
- **会话与方案（chat-plan）**：新表 2 `creation_sessions` / `creation_messages`（Drizzle/SQLite 加法迁移 + 索引）；首次发送自动建普通项目 + 会话（标创作草稿，用量记入该项目携带 sessionId）；`services/creation-chat/`（`contract` 受约束 JSON + 服务端白名单编译、`planning` 有界上下文、`preflight`）；提示词外置 `workspace/prompts/creation-plan.md`（LLM 不生成可执行代码/任意 YAML/路径/工具调用）。
- **确认与幂等（safe-execution）**：预检与执行同一套能力/参数解析；保存**不含密钥**的配置实例快照 + 有效参数快照（密钥仅 secrets 服务解析，不入对话/计划/日志；实例禁用或关键变更暂停不切默认实例）；确认携带 `planRevision + planHash + idempotencyKey`，DB 事务内比较版本 / 认领启动请求 / 建并关联 run（`run-create.ts` 最小扩展复用事务执行器，旧调用兼容），提交后才 `engine.startRun`——重复确认/双击/网络重发只得同一次 run；仅新模板已批准生产链自动执行，不批量批准旧 gate。
- **状态与恢复**：控制态 `draft|planning|ready|starting|started`；复用 Socket.IO + `onRunSettled` + HTTP 重拉兜底（刷新/离开不中止后端制作）；重启对账已关联 run，受理状态不明的任务标「需核验」不自动重发付费请求；取消复用引擎语义（在途可能已计费明确告知）；重试显式操作、复用成功产物、返回新 runId 保留来源链。
- **前端（creator-ui）**：`views/easy-create/`（`index.vue` 一句话首页 + `detail.vue` 工作区〔左对话右方案/进度/成片，窄屏堆叠〕+ `ConversationPanel`/`CreationPlanCard`/`CreationProgress`/`CreationResult` + `use-creation-chat.ts` 模块级单例状态机〔异步响应按会话 id 防旧覆盖新、确认幂等键按 planHash+revision 复用〕）；`lib/api/creation-chat.ts` + `lib/types/creation-chat.ts`；接线 `router.ts`（`/create`、`/create/:id`）、`lib/nav.ts` 首位「轻松创作」、`Icon` +chat/send、项目首页醒目 CTA 横幅；保留 `/` 与全部旧链接，专业入口（`/runs/:id` 精修、`/projects/:id`、`/settings` AI 配置）始终可达；沿用紫靛 token、原生 CSS，键盘可达/焦点可见/状态区可读屏/reduced-motion 适配。

端点：`/api/v1/creation-sessions`——`GET /`（列表）、`POST /`（建 201 `{content,requestKey}`）、`GET /:id`、`POST /:id/messages`、`POST /:id/preflight`、`POST /:id/confirm`（202 Confirmation→`{runId}`）、`POST /:id/cancel`、`POST /:id/retry`（202 RetryBody→`{runId}`）；create/send/preflight/cancel 统一返回 `CreationDetail`。

验证：`pnpm --filter @acs/server exec tsx scripts/probe-m30.ts`（五节 **48 项断言**，零网络零计费：contract〔默认项补齐/追问/非法·超长·截断计划拒启动〕/ preflight〔缺模型·实例变更·无 ffmpeg·未知价·超预算态标准确〕/ confirm〔确认前不建媒体任务·修订后旧确认冲突·并发确认单 run〕/ media〔本地 ffmpeg 真实跑 subtitle→ffmpeg_merge 严格链，动态 + 图文两路产出可解码含音轨 MP4；缺镜/损坏/时长不足/错映射拦截；strict 关闭旧行为不变〕/ recovery〔刷新·断线·重启·取消·重试不重复启动·成功镜头不重提·跨项目引用拒绝·密钥脱敏〕）；`pnpm ci:check` 端到端 exit=0（双端 typecheck + 模板校验 **15 份 / 107 步 0 错 0 警** + `probe:ci` **26 探针 / 3013 断言全绿**含 `probe-m30`）；`pnpm --filter @acs/web build` 绿；浏览器验收：`/create` 首页（hero + 示例 + 我的创作空态）、`/` 项目首页「轻松创作 · 一句话成片」CTA、`/create/:id` 工作区壳（头部返回/项目/AI 配置 + 对话面板 + 方案/进度/成片占位 + 404 优雅降级），console 零 error。**真实动态/图文样片待另行取得明确模型/预算授权后验证**（离线全绿只证功能与契约，不代供应商可用性与成片质量验收）。

> 【M31 增量】`probe-m30` media 节追加 ref-first-frame 零回归断言 2 项（无 `refs` 字段的旧方案 → `recipeSchema` 解析出空 `refs`、`recipeFirstFrameId` 无参考恒 `null`），故 probe-m30 现为 **50 断言**；旧无参考合成路径逐字节不变。

## M31 能力速览（对话式参考输入：图 / 视频 / 角色 / BGM · R07 参考输入子集）

在 M30「一句话成片」之上交付 R07 的**参考输入子集**：用户在 `/create/:id` 对话里上传素材（C1 参考图→风格/首帧、C2 参考视频→内容解析、C3 主体/角色一致性、C4 BGM/品牌音频），方案与成片受其约束。四项核心不变式贯穿全链：**参考素材进 planHash（确认即执行）**、**能力不支持不静默降级**（视觉不可用不假称理解、无 i2v 首帧不改文生、无解析实例不跳过）、**参考里没有的信息不编造**、**零新表零新列**（复用 `importFiles` 上传链与资产体系、复用 `video_analyze`〔M25〕与 `easy-video` 模板，不新建引擎/平行状态机）。

- **附件与上传（attachments）**：新增 `POST /api/v1/creation-sessions/:id/attachments`（multipart `file`+`role`）——复用 `POST /projects/:id/imports` 的 sha256 去重与资产登记，文件落到**会话所属项目**；核验类型（image/video/audio）与大小上限；返回 `{assetId, kind, role, hash, thumbUrl}`；记一条带 attachment 的 user 消息；**不触发规划、不计费**。`messageSchema` / `create` 增可选 `attachments?: number[]`；规划前逐个核验归属本会话项目、未软删、kind 与 role 匹配，不符以 `CreationError` 拒绝（不静默忽略）。首条想法带图：前端 `create(idea)` → `POST /:id/attachments` → 带 `attachments` 的 `send` 触发规划（`create` 语义不变，避免首轮双计费）。
- **refs 进 planHash（recipe/contract）**：`recipeSchema` 新增 `refs: z.array(refSchema).max(12).default([])`（`refSchema={assetId,kind,role,hash,shotId?}`，role ∈ style/first_frame/subject/content/bgm）；`PreparedRecipe` 随之携带 refs → `hashJson({plan,execution})` 天然含参考指纹；refs 缺省空数组**向后兼容**旧无参考方案。`assertRecipeSources` 扩展到 refs：项目归属 / `deletedAt` / kind / 内容 hash（媒体走二进制摘要 `refContentHash`），任一不符停机报「参考已变化，请重新确认」。
- **规划注入（有界、可核实、不编造）**：`compileReferenceContext` 编译参考上下文——图片 `style` 仅当实例 `extra.vision===true`（不按名推断）时以 `image_url` 分片注入，否则不假称理解、降级为「仅可作首帧」并告知；`first_frame`/`subject` 编译进 shot refs 走 i2v 首帧或 ai_image 参考；视频 `content` 执行 `video_analyze` 产出 `{duration,scenes,transcript}` 摘要注入，只取视频内实际可见/可听内容，缺失不编造、无实例/失败 → 明确 blocker；音频 `bgm` 登记 BGM 候选，不进 LLM 上下文。
- **预检 / 计费 / 合成**：`estimate` 增 `refCount` 与 `videoAnalysisCount`；视频内容解析 = 多模态 token + ASR，离线不可定价 → 显式列入 `unpriced`（不按零元，须同卡接受）；无图像端点消费图片参考 → `ref_image_unsupported` 拒绝；能力不支持图生视频首帧而方案含 `first_frame` → `first_frame_unsupported` 拒绝（不改文生）。`ffmpeg_merge` 严格模式**窄口径 BGM opt-in**：仅方案批准 `role:'bgm'` 时混入该用户上传/已存在音轨（默认仍无 BGM，不违反 M30「不生成 BGM」——此处为使用用户素材），无 ref 时 `params.bgm=null` 逐字节不变。
- **生成消费 refs**：`recipeRefImageIds`（kind image、role ∈ style/subject/first_frame、shotId 全局或本镜命中、去重上限）合并进 `refAssetIds` → base64 `referenceImages`；`recipeFirstFrameId`（shot 级优先 → 全局）→ `firstFrameAssetId` → i2v 首帧；`ffmpeg-merge` 严格模式下 `refs.find(role==='bgm')` → `loadAssetById` 混入音轨。全部走既有 base64 通道、确定性入 params，不触发幂等守卫、不改适配器签名。
- **前端（creator-ui）**：`ConversationPanel` composer 增文件选择（前端类型/大小预校验）+ 附件托盘（缩略图/文件名/上传状态 + 每条 role 选择〔按 kind 推断可改〕+ 重试/移除）+ 上传/解析费用明确提示；`CreationPlanCard` 增「参考素材」区（已采纳 refs 缩略图 + 用途 + 消费说明 + shot 标注 + 视频解析来源 + BGM 来源），meta 增「N 项参考」chip；`use-creation-chat.ts` 增 `uploadItem/addAttachment/changeAttachmentRole/removeAttachment/retryAttachment` 与附件状态（异步按会话 id 防旧覆盖新、已上传项 `send` 后过滤、改 role 走重传〔sha256 去重〕）；`lib/api/creation-chat.ts` 增 `uploadAttachment`（原生 `fetch` + `FormData` multipart，复用既有 ApiError 解析）与 `send` 携带 `attachments`；`lib/types/creation-chat.ts` 增 `CreationRef` 系列类型与 `REF_*` 常量（role 标签/合法 role 表/默认 role/大小上限/数量上限 12/`refKindByExt`）。**上传仅发生在 `detail` 页 composer**（`currentId` 恒存在），规避首轮带图 create+send 的双计费 / 无会话可传问题；`refs` 经 `send` 携带、后端 carry-forward 保留 priorRefs。

端点：`POST /api/v1/creation-sessions/:id/attachments`（multipart `file`+`role`，201 返回 `CreationAttachmentResult`）；`POST /:id`（create）、`POST /:id/messages`（send）body 增可选 `attachments: number[]`；`GET /api/v1/assets/:id/thumb`（既有，供附件缩略图）。

数据与兼容：新表 0 / 新列 0（refs 存于既有方案 JSON 与消息 payload，媒体复用 imports 资产体系）；`recipeSchema.refs` 缺省空数组向后兼容；`estimate` +`refCount`/`videoAnalysisCount`、`Confirmation`/`create`/`send` +`attachments`（缺省兼容）；引擎 / DAG / 适配器签名 / 模板零触碰。

验证：`pnpm --filter @acs/server exec tsx scripts/probe-m31.ts`（五节 **33 项断言**，零网络零计费：attachment〔10：上传类型/大小/归属/去重、附件资产编译为 refs、跨项目引用拒绝、不计费不触发规划〕/ hashguard〔8：refs 进 planHash、编辑/删除/换项目参考触发「参考已变化」停机〕/ capability〔6：视觉不可用不假称理解降级、无 i2v 首帧拒绝、无解析实例 blocker、成本可见未计价〕/ bgm〔2：严格合成默认无 BGM 逐字节不变、方案批准 role:bgm 放行用户上传音轨〕/ firstframe〔7：shot 级优先/全局回退/非首帧不误用/本镜命中不越界、i2v 首帧进严格合成链产出可解码含音轨 MP4〕）；扩 `probe-m30` media 节 ref-first-frame（旧无参考路径零回归）；`pnpm ci:check` 端到端 exit=0（双端 typecheck + 模板校验 **15 份 / 107 步 0 错 0 警** + `probe:ci` **27 探针 / 3048 断言全绿**含 `probe-m31` 与扩展后的 `probe-m30`）；`pnpm --filter @acs/web build` 绿。**真实参考消费样片（视觉风格贴合、跨镜一致性、视频解析效果、BGM 混音）待另行取得明确模型/预算授权后验证**——离线全绿只证功能与契约、能力闸门与零回归，不代供应商可用性与成片质量验收。

---

## M32 能力速览（视频能力/默认单一真源表 + Tier A 智能默认引擎 · 平台智能化基建，全站前置）

把「啥都让用户选、啥都让用户配」决策模型收敛为「**默认自动推导 + 用户可覆盖 + 执行前预览**」三层的首个落地里程碑（Tier A：系统真源已知 → 自动预填、免用户核实）。核心治理：**模型档位此前散落在三处各自维护、易自相矛盾**——① 各适配器 `generate` 内的 normalize（minimax / volcengine / pollinations）、② 预检 `assertAdapterDurations` 硬编码分支、③ 前端 `applyCapsPreset` + `capsHint` 硬编码预填与提示——并逼用户逐项勾选「已核实」。M32 将其收敛为服务端**唯一真源表**，前端据此自动背书、去「已核实」勾选。纪律不变：**仅登记经供应商文档 / 适配器实现核实的事实、不按模型名猜测、未命中 fail-closed**（Tier A 不取消校验，而是把「核实」主体从用户转移到系统真源表 + 预览闸门）。

- **单一真源表（registry）**：新增 `apps/server/src/adapters/video-capabilities.ts`——`resolveVideoCaps(providerKey, model)` 逐字段背书 MiniMax H3（i2v+t2v / 4–15 秒 / 768P·2K）、火山 Seedance（4–15 秒 / 480p·720p）、万相 3.0（2–30 秒 / 含 1080p）、Pollinations 网关（t2v-only、minimax 系 5·10·15 秒 480p、其余 5·10 秒 720p）；`siliconflow_video`（适配器不下发 duration、真实产出时长未文档化）与未知供应商 → 返回 `null`（须显式声明，不自动背书）。纯工具 `clampDuration` / `mapResolution` / `snapPollinationsDuration` 供适配器委托，消除三处平行魔法数。
- **适配器委托（equivalence）**：minimax / volcengine / pollinations 视频适配器的 normalize 逻辑改为委托真源表，逐值与迁移前一致；预检 `preflight.ts` 接线 `resolveVideoCaps`——stored `creationCapabilities` 优先、无则按表派生、均未命中 → `capabilities_unverified`。**修复零回归**：移除预检中过严的 modes 子集校验（会抢占更可行动的 `first_frame_unsupported`），modes 真源回归 `adapter.firstFrame`（t2v-only 含首帧仍停机，红线不降）。
- **只读背书端点（caps-api）**：`GET /api/v1/api-configs/video-caps?provider_key=&model=`——命中返 `{supported:true, caps}`（前端自动预填），未命中返 `{supported:false}`（回退手填）。
- **前端 Tier A（creator-ui）**：`ApiConfigForm.vue` 移除「已核实」勾选与全部硬编码档位，抽出视频专属子组件 `VideoCapsEditor.vue`——命中背书默认「自动背书」（不写 `creationCapabilities`，交服务端按表推导），可「改为手动声明」覆盖；未背书回退手填表单。经 api 客户端 `configApi.videoCaps` 拉取（遵裸 fetch 红线）。自动背书 / 空声明均不写 `creationCapabilities`（保留「先建实例、稍后声明」路径）。

数据与兼容：新表 0 / 新列 0（仍存 `extra.creationCapabilities`，命中背书时不写）；存储声明与原行为逐字段兼容（equivalence 节断言）；引擎 / DAG / 模板零触碰。文件行数：抽出 `VideoCapsEditor.vue`（509 行）使 `ApiConfigForm.vue` 由 875→915→**515 行**，令 >800 行超标文件从 12→11（净减负债，未新增超标文件）。

验证：`pnpm --filter @acs/server exec tsx scripts/probe-m32.ts`（五节 **21 项断言**，零网络零付费零计费：registry〔4 家背书逐字段命中 + siliconflow/未知 fail-closed〕/ preflight〔无声明仅 provider+model → Tier A 就绪、未知 → capabilities_unverified〕/ equivalence〔显式存储 vs 按表背书 execution 逐字段一致〕/ degrade〔t2v-only 含首帧仍 first_frame_unsupported〕/ normalize〔clampDuration/mapResolution/snapPollinationsDuration 逐值等价迁移前〕）；`probe-m32` 经 `run-probes.ts` 自动发现纳入 `probe:ci`；**M30（50 断言）/ M31（33 断言）零回归全绿**；双端 `tsc --noEmit` + `vue-tsc --noEmit` 全绿。

---

## M33 能力速览（AI 配置智能化：定价 Tier A 自动带出 + 选中即生成完整实例）

把 M32 的「能力真源表 + Tier A 自动背书」范式从视频档位扩展到**定价**，并新增跨通道的**「选中即生成」**：建实例时选供应商 + 模型 → 系统按真源自动带出「参考定价 + 视频能力 + 默认通道建议」，一次生成完整实例草稿，收敛 G4（定价手填、未命中不带出）与 G5（model 手动复制、无选中即生成）。核心纪律延续 M32：**仅登记经供应商公开定价页核实的参考价、逐条附来源锚点、不按模型名猜测、未命中 fail-closed 回落手填**；且定价真源表**仅用于建实例预填，绝不注入 `resolveUnitPrice` 事后计价链**（零漂移，成本可见不低估）。

- **定价单一真源表（pricing-registry）**：新增 `apps/server/src/adapters/pricing-capabilities.ts`——`resolveModelPricing(serviceType, providerKey, model)` 逐条背书首批 7 条官方核实价：DeepSeek flash 2/8、v4-pro 9/27（元/百万 token，高峰·缓存未命中全价，谷时/命中更低已在 source 注明）；阿里云通义 qwen3.8-max 12/36、qwen3.7-plus 2/8、qwen3.8-flash 0.8/2.7（基础档标准价，Batch/缓存折扣另计）；万相文生图 wan2.7-image 0.2、wan2.7-image-pro 0.5（元/张）。`UNITS_BY_SERVICE` 单位守卫：行内计价单位与能力类型不符 → 视为未核实不背书；未知 provider / 无依据 model / 空 model / 大小写·空格归一后仍未登记 → `null`（回落手填）。MiniMax / 火山 / Pollinations / SiliconFlow / OpenAI / Google 及视频秒价、音频因非 CNY 公开牌价或分辨率分档未取净 → 一律留空不猜。
- **跨通道只读建议端点（model-suggest）**：`GET /api/v1/api-configs/model-suggest?provider_key=&service_type=&model=`——泛化 M32 `video-caps`，一次返回 `{supported, pricing?, caps?, suggestDefault?}`：`pricing` 命中定价真源表、`caps`（仅 video）复用 M32 `resolveVideoCaps`、`suggestDefault`（该 serviceType 当前无实例 → 建议设为默认通道）。非法 service_type → 400。M32 `video-caps` 端点保留（向后兼容）。
- **前端抽组件 + 选中即生成（creator-ui）**：抽出 `PricingSuggest.vue`（全通道定价区，三态 auto✓来源 / stored 回显 / manual 手填），`ApiConfigForm.vue` 移除内联定价逻辑改由子组件托管；经 api 客户端 `configApi.modelSuggest` 拉取（遵裸 fetch 红线）；命中即 Tier A 自动预填定价、展示「选中即生成」汇总、`suggestDefault` 时新建态自动勾「默认通道」（用户可取消，`defaultTouched` 防覆盖）；编辑态 stored 优先不覆盖存量；未命中回落手填不塞默认价。
- **M32 遗留 build 修复**：`VideoCapsEditor.vue` 多语句内联 `@click` 致 `vite:vue` 编译失败（vue-tsc 不查、M32 遗漏 build 门禁），抽为命名方法 `switchToManual()`，`pnpm --filter @acs/web build` 转绿。

数据与兼容：新表 0 / 新列 0（定价仍存 `apiConfigs.pricing` JSON，与真源表同基数口径）；`resolveUnitPrice` 事后计价链零触碰（真源表不进回退链，probe cost-drift 断言）；M32 `video-caps` 端点保留。文件行数：`ApiConfigForm.vue` 441、`PricingSuggest.vue` 207、`pricing-capabilities.ts` 73、`probe-m33.ts` 123，均 ≤800。

端点：`GET /api/v1/api-configs/model-suggest`（新增）；`GET /api/v1/api-configs/video-caps`（M32 保留）。

验证：`pnpm --filter @acs/server exec tsx scripts/probe-m33.ts`（三节全绿，零网络零计费：registry〔7 条逐值命中 + 大小写/空格归一 + openai/未知 provider/单位守卫/空 model/视频未登记 → `null` fail-closed〕/ endpoint〔pricing 命中 + suggestDefault、播实例后 suggestDefault 消失、video 命中 caps 无 pricing、未背书+有实例 → `supported:false`、非法 service_type → 400〕/ cost-drift〔表命中但无实例/全局定价 → `resolveUnitPrice:null`、实例定价生效零漂移，证真源表不注入事后计价〕）；`probe-m33` 经 `run-probes.ts` 自动发现纳入 `probe:ci`；**M30（50）/ M31（33）/ M32（21）零回归全绿**；双端 `tsc --noEmit` / `vue-tsc --noEmit` + `pnpm --filter @acs/web build` 全绿。

---

## M33.1 能力速览（AI 配置极简零重构：只配 Key + 选模型，定价「谁给价谁带」）

把 M33 仍偏「要用户配」的手填真源表兜价，升级为**在线目录优先自动带价**：现场用真实 Key 核对供应商列模型接口后，建实例主表单**只必填「供应商凭证 / Key + 选模型」**，其余（实例名、定价、端点、能力）一律自动带出、可入「高级」覆盖。核心纪律不降级：**仅接供应商接口明确返回且可归一为非折扣全价 CNY 的价格、单位/币种无法归一 → 视为未命中按未计价（绝不猜价）；在线元数据仅用于建实例预填，绝不注入 `resolveUnitPrice` 事后计价链（零漂移）**。

- **现实核对（Step 0 真实 Key 现场拉取）**：DashScope 原生 `GET /api/v1/models?providers=qwen` 对 `aliyun_*` 行返回 `output.models[]` 携 `prices`（input/output + 币种 + 单位「每百万tokens」，与平台口径**完全一致零换算**）+ context；实测 78 模型，`qwen3.8-max` 12/36、`qwen3.7-plus` 2/8、`qwen3.8-flash` 0.8/2.7 **精确复现 M33 真源表**。而 OpenAI 兼容 `/v1/models`、DeepSeek `/v1/models` **不含价格**（坐实「谁给价谁带」前提）。
- **模型元数据适配层（model-metadata）**：新增 `apps/server/src/adapters/model-metadata.ts` 纯函数（仅 import type，零运行时依赖）——`normalizeModelList(serviceType, providerKey, json)` 分供应商归一：`dashscopePricing` 取 `range_name==='Default'`（缺则首组）全价档、`type` 精确匹配 `input_token/output_token`、单位必须「每百万tokens」否则省略，非 CNY/缺档/单位守卫 → `pricing` 省略；**仅 LLM 走 live 带价，图/视频/语音按档不猜**（回落 M33 核实表 / 手填 / 未计价）。OpenAI 兼容口仅取 id。`sortEntriesWithPreset` 预置置顶 + 其余字母序。M33 `pricing-capabilities.ts` 保留为兜底（未命中再用），零死代码。
- **fetch-models 契约升级**：返回 `models: string[]` → `models: ModelEntry[]`（新增 `pricing?/context?/source`）。`aliyun_qwen_llm` 不再短路 preset，改走原生带价分页口（`page_size=100` 上限保护、`Bearer` 带 `resolveConfigApiKey/credential key`）；失败/超时回退 preset（附 note）。其余供应商维持兼容口仅取 id。保留 `source:'live'|'preset'` / `note` 语义。
- **前端主表单极简（creator-ui）**：`ApiConfigForm.vue` 主区收敛为「供应商凭证 / Key + 选模型」+ 一行只读「自动带出」摘要；**实例名自动生成** `${供应商}·${模型}`（`watch` 模型变化更新，用户改过则不覆盖，仅「高级」可改，提交非空校验对自动值恒成立）；**选凭证即自动在线拉取**（含新建态，免点「获取模型」）；定价主区不再放输入框——命中 live > 核实表 > 未计价，只读展示来源，手填入口移入「高级」折叠；`PricingSuggest.vue` 改为高级模式，新增 `live` 优先入参与 `mode='live'`（优先级 stored > live > 表 > manual）。`isDefault` 沿用「首个实例自动建议 + `defaultTouched` 防覆盖」，视频 caps 维持 M32 背书。

数据与兼容：**0 新表 / 0 新列**（定价仍存 `apiConfigs.pricing` JSON、caps 仍存 `extra.creationCapabilities`，元数据解析策略写在代码按 providerKey 分流，不加 DB 列）；`resolveUnitPrice` 事后计价链零触碰（probe cost-drift 断言 live 命中也不改变）；`ModelEntry` 契约变更仅 `ApiConfigForm` 消费（grep 复核无其它调用方）。文件行数：`model-metadata.ts` 162、`api-configs.ts` 471、`ApiConfigForm.vue` 556、`PricingSuggest.vue` 228、`probe-m33.ts` 198，均 ≤800。

端点：`POST /api/v1/api-configs/fetch-models`（契约升级 `ModelEntry[]` + 阿里千问 LLM 走原生带价口）；`GET /api/v1/api-configs/model-suggest`（M33 保留，作表兜底，无需联网行为不变）。

验证：`pnpm --filter @acs/server exec tsx scripts/probe-m33.ts`（**五节全绿**：registry〔M33 表兜底不破〕/ metadata〔DashScope 样例 fixture → 单位换算正确 12/36·2/8·0.8/2.7 + context + image 排除 + 非 llm 空 + 非 CNY/缺档/单位守卫 → `pricing` 省略 + compat 仅 id 去重〕/ endpoint〔M33 原节〕/ fetch-endpoint〔mock fetch：aliyun 原生带价 `ModelEntry[]` + 失败回退 preset + compat 仅 id〕/ cost-drift〔live 命中亦 `resolveUnitPrice:null` 零漂移〕）；真实 Key 现场拉取 78 模型逐值对齐真源表；浏览器实测「新建实例只选凭证 + 选模型即保存跑通、live 价 `{12,36}` 落库、实例名自动生成」；`probe:all` 全量：**M30（50）/ M31（34）/ M32（21）/ M33（33）零回归全绿**（m26 split-audit / m13-m14 并行嵌套 spawn 竞态为预先存在项，非本次引入）；双端 `tsc --noEmit` / `vue-tsc --noEmit` + `pnpm --filter @acs/web build` 全绿。

---

## M34 能力速览（模板与运行入参自动化 · G6 输入预填 + G8 视频合法档位 · 零成本）

把 M32/M33 的「真源表 + Tier A 自动预填」范式从 AI 配置扩展到**建 run 链路**：选模板后系统按「上次同模板 run 真实入参 + 项目 brief」自动预填 inputs、按视频能力真源表给出覆盖项合法档位，收敛 G6（输入不参考历史/brief 手填）与 G8（RunParams 覆盖项空白手填可越界）。**G7（自然语言→模板推荐）本轮暂缓**（用户拍板取零成本路线，归后续 M35 评估）。核心纪律：**全程零 LLM / 零网络 / 零计费**（纯 DB 读 + 静态真源表），每个自动值携 `source` 供前端标注「为何是这个值」（M37 前置），不改 `_params` 三层叠加与执行契约。

- **G6 输入预填（run-prefill 服务）**：新增 `apps/server/src/services/run-prefill.ts`——`resolveRunPrefill(projectId, templateKey)` 逐 key 按优先级 `template_default` → `last_run`（最近一条 input 可解析的同模板 run 精确标量值复用）→ `brief`（白名单关键词命中的空文本输入放置项目简介原文，不改写），损坏 run 跳过取次新；媒体类（files/publications）与内部键（`_params`/`_compose`）一律排除（防跨集资产误绑）。
- **G8 视频合法档位（域对齐）**：复用 M32 `resolveVideoCaps` 给「本集参数覆盖」的时长数字输入收窄 min/max（如 MiniMax/火山 4–15 秒，替代通用 1–30）+ 推荐默认；分辨率覆盖下拉可选域 = `caps.resolutions ∩ run-params 输入白名单 {480p,720p,1080p}`（交集空回落全量、`defaultResolution` 仅在可选域内给出），**规避把 768P/2K 输出档位塞进覆盖导致 `validateRunParams` 400**；未登记模型 / 非视频模板 → `overrides.video=null` 回退手填。
- **只读端点（prefill-api）**：`GET /api/v1/templates/:key/prefill?project_id=N` → `PrefillResult`（`inputs` 候选值+来源、`lastRunId`、`overrides.video`）；纯加法，不新增表/列、不改既有端点；`project_id` 非法 400、模板/项目缺失 404。
- **前端接线（creator-ui）**：`RunFormModal.vue` `selectTemplate` 拉详情后调 `templateApi.prefill` 应用候选值 + 存 `sourceMap` + 驱动视频覆盖档位（失败非致命回落模板默认，M14 集号 `prefillInput` 仍末位覆盖）；`TemplateInputFields.vue` 加 `sources` prop，命中 `last_run`/`brief` 的字段旁渲染来源 chip（「↺ 沿用上次运行」「✦ 来自项目简介」），用户编辑即 `onFieldChange` 剔除 chip。

数据与兼容：新表 0 / 新列 0（读 `projects.brief/settings`、`pipeline_runs.input` 快照、`api_configs` 默认视频实例，`pipeline_runs` 无软删列、随项目级联）；预填仅作用于建 run 前表单值，`run.input` 快照 / 引擎 / `_params` 叠加零改。文件行数：`run-prefill.ts` 195、`RunFormModal.vue` 414、`TemplateInputFields.vue` 334、`probe-m34.ts` 185，均 ≤800。

端点：`GET /api/v1/templates/:key/prefill`（新增）。

验证：`pnpm --filter @acs/server exec tsx scripts/probe-m34.ts`（三节全绿，零网络零计费：g6-inputs〔无 run brief 承接 + template_default + 媒体/int 不猜 + last_run 精确复用覆盖来源 + 内部键/媒体排除 + 损坏 run 跳过取次新 + brief 不越权覆盖已有默认〕/ g8-caps〔minimax 时长 4–15 + 域对齐防 400 + volcengine 可选域收敛 + 未登记/非视频 → null + 回落默认实例〕/ guards〔200 + 缺/非法 project_id 400 + 项目/模板 404〕）；`probe-m34` 经 `run-probes.ts` 自动发现纳入 `probe:ci`；**M30（50）/ M31（33）/ M32（21）/ M33 零回归全绿**；双端 `tsc --noEmit` / `vue-tsc --noEmit` + `pnpm --filter @acs/web build` + `validate:templates` 全绿。

---

## M35 能力速览（创作流程自动化 · G9 settings 闸门 + G10 clamp + G11 下一步建议 + G7 模板推荐 · 零成本）

把 M32/M33/M34 的「真源表 + Tier A 自动推导」范式从**单点预填**扩展到**写时与方案后处理的全链路径**：收敛 G9（项目 `settings.video` 可填越界值，运行时才炸）、G10（轻松创作 `plan.mode/aspectRatio/duration` 不感知当前视频实例能力→ `preflightPlan` 抛错被迫重规划）、G11（`Template.next` 元数据存在但从未消费，项目主页看不到「下一步」）、**G7**（M34 遗留 · 自然语言→模板推荐，embedding 零成本路线）。核心纪律：**全程零 LLM 计费 / 零新表新列 / 不改既有契约**——G9 写时闸门与 run-params RULES 同白名单（**未登记字段一律放行**避免破坏既有项目）；G10 clamp 只调数值/枚举、不动文本，**每次钳制记入 notes 明写到 assistant message**（不静默降级）；G11 规则引擎≤ 3 条提示、**不自动执行**（用户点击才路由）；G7 embedding 本地预计算失败回落关键词，不猜不静默。

- **G9 写时闸门（project-settings service）**：新增 `apps/server/src/services/project-settings.ts`——`validateProjectSettings(raw)` 对齐 run-params 已登记 4 组白名单（video/image/audio/llm）逐一校验，**未登记字段一律放行**（fps/duration_per_shot/subtitle_style/aspect_ratio 等）；兼容 `video.resolution` 双格式（`480p/720p/1080p` **或** `1080x1920` 类 WxH）——ai-video（输入域枚举）与 ffmpeg-merge（输出域像素）历史命名冲突、不同语义同字段 → 两格式都合法，避免破坏现网。接线：`POST /projects` / `PATCH /projects/:id` 入口处 `settings` 非空时先 validate，errs>0 → 400 `bad_settings`（Tier A 不取消校验，把「核实」主体从用户转移到服务端闸门）。
- **G7 自然语言→模板推荐（template-recommend service）**：新增 `apps/server/src/services/template-recommend.ts`——**启动时预计算 + 内存 Map**（用户拍板零磁盘持久化、重启重算 2–3 秒可接受）：`refreshTemplateVectors()` 对 15 套模板 embed(`name。description。体裁：genre。场景：scene`) 得 normalize 向量存 `Map<key, TemplateVector>`（inflight 互斥）；`recommendTemplates(text, top=3)` embedding 优先 cosine 排序，失败/未 ready → 回落 15 套 KEYWORDS 手工表（密度分 hits/words.length）；返回 `{items, source: 'embedding'|'keyword'|'empty', ready, error?}`。接线：`GET /api/v1/templates/recommend?text=&top=`（**预于 `/templates/:key` 注册避免路由歧义**）；`index.ts` 启动 `void refreshTemplateVectors()` fire-and-forget；`saveTemplate`/``deleteTemplate``` 后按需刷新（同样不阻塞响应）。**前端接线**：`ProjectFormModal.vue` brief 输入 debounce 500ms → `templateApi.recommend(brief, 3)` → 命中展示「✦ 根据简介推荐」前 3 chip（点击预设 tplKey + tplTouched；不自动改选避免静默覆盖）；`easy-create/index.vue` idea debounce 800ms → `recommend(idea, 1)` → 命中下方「💡 此创意接近『{name}』」提示（不预选不路由）。
- **G10 方案后置钳制（clamp）**：新增 `apps/server/src/services/creation-chat/clamp.ts`——`clampPlanToCaps(plan, caps, hasVideo)` 三规则：① `hasVideo=false + mode=dynamic` → 强制 slideshow（无视频实例不背动态）；② `caps` 命中时 shots[].duration 不在 durations → `snapToCapsDuration` 就近上取（同默认：都小于目标取最大）；③ 钳后重算 `plan.duration = shots 和`（保持 `contract.ts` superRefine 不变式，钳到 30–60）；④ `aspectRatio` 不在 caps 集 → 回落 `caps.aspectRatios[0]`。`ClampReport { shotDurations[], aspectRatio?, mode?, notes[], changed }`；notes 追写到 assistant message 尾部「因当前视频能力自动钳制：…」。**不静默降级**：只调数值/枚举不动文本，钳后仍走原 `preflightPlan`（有病态依旧抛）。接线：`sendCreationMessage` 中探测 `requiredEndpoint('video')` + `resolveVideoCaps` → `buildCapsConstraintMessage` 追写为 system 消息（不新增计费，同一次 LLM 调用内）；LLM 后 `clampPlanToCaps` 钳制 + 追写 notes。
- **G11 规则引擎下一步建议（next-steps service）**：新增 `apps/server/src/services/next-steps.ts`——`resolveNextSteps(projectId)` 读 projects/pipelineRuns/publications + listTemplates/loadTemplate，5 条规则优先级：**无 run** → 「开始制作」（route `run-new?tpl=`）；**in-flight**（queued/running/waiting_input）→ 「进行中 · #id · 模板名」`auto:true`（不行动）；**latestDone + tpl.next 非空** → 「下一步：{next[0].name}」；**latestDone + 无 pub** → 「发布本集」；**latestDone + hasPub + 无 next** → 「进入专业工作台精修」route `canvas`；**≤ 3 条**（slice(0,3)）。`GET /api/v1/projects/:id/next-steps` → `{items: NextStep[]}`。前端：`NextStepsBar.vue` 自拉 + socket `run.completed/failed` 重拉，接 `use-project-detail.ts` 同一机制；项目详情页 `stat-strip` 下方挂载；**不自动执行**（点击才 router.push）。

数据与兼容：新表 0 / 新列 0 / 新价 0；`settings` JSON 列内容不变（仅写入前闸门）；`creationPlan` 契约（`contract.ts` superRefine）不变（仅预钳制令其少失败）；`canvasAdvice`（LLM）保留手动入口不拆。**不猜测**：G10 caps=null（未登记模型）不钳制，交 preflight fail-closed；G9 未登记字段一律放行；G11 项目不存在 → `[]` 不抛；G7 无关文本 → `source=empty`。端点：**3 新**（GET /templates/recommend + GET /projects/:id/next-steps + [既有端点不变]）；**既有端点零改**（POST/PATCH /projects 仅入口新加闸门，合法请求行为完全一致）。文件行数：`project-settings.ts` 135 / `template-recommend.ts` 171 / `clamp.ts` 106 / `next-steps.ts` 162 / `NextStepsBar.vue` 154 / `probe-m35.ts` 424，均 ≤800。

端点：`GET /api/v1/templates/recommend`（新增）；`GET /api/v1/projects/:id/next-steps`（新增）；`POST /projects` / `PATCH /projects/:id`（**入口新加 settings 闸门**，既有行为兼容）。

验证：`pnpm --filter @acs/server exec tsx scripts/probe-m35.ts`（五节 **44 项断言**全绿，零网络零计费：g9-settings〔11：resolution 双格式 + 未登记字段放行 + provider/image.size 类型守 + 非对象拦截 + POST/PATCH 400 同口径〕/ g7-recommend〔10：关键词命中 embedding-或-keyword 均可 + 无关→empty + 空白→400 + top 越界回落 + 路由歧义：:key 不被 recommend 抢占〕/ g10-clamp〔15：dynamic→slideshow + duration 就近上取 + 总时长重算不变式 + aspectRatio 回落 + caps=null 不钳制 + 二次幂等 + 原对象就地不变〕/ g11-next-steps〔13：5 条规则 × 3 态× ≤ 3 约束 + in-flight 优先 + route 契约 + 项目不存在 fail-open + GET 200〕/ guards〔3：200 + 项目不存在 → 200 items=[] + 非法 id 400/404〕）；**M30（50）/ M31（33）/ M32（21）/ M33 / M34 零回归全绿**；双端 `tsc --noEmit` / `vue-tsc --noEmit` + `pnpm --filter @acs/web build` 全绿。

---

## M36 能力速览（运营配置自动化 · G12.1 平台目录 + G12.2 合规兜底 + G12.3 词库建议 + G12.4 排期节奏 · 零成本）

把 M32–M35 的「真源表 + Tier A 自动推导 / Tier B 建议」范式从**创作链**扩展到**运营配置面**：收敛痛点 6「平台预设 / 合规词库 / 排期节奏全靠手工维护」。核心纪律：**全程零 LLM 计费 / 零网络 / 新表 0 新列 0**——G12.1 静态目录真源、G12.2 代码级基准地板、G12.3 复用**已付费的**合规复审产物聚合、G12.4 纯日期数学。加法优先：仅新端点 + 复用 `settings` 键 + 词库文件追加，不改既有契约。

- **G12.1 平台目录 + 预设 Tier A 补全（catalog）**：新增 `apps/server/src/services/platform-catalog.ts`——`PLATFORM_CATALOG` 把 8 个已知平台（5 视频：抖音/视频号/快手/小红书/B 站 + 3 图文：公众号/知乎/头条）推荐导出规格收敛为**单一真源常量**（机器键与 `publications`/`export_presets` 域对齐：视频号 = `wechat_channels`）；`seedMissing(present, only?)` 返回目录中「尚未配置」条目。`exports.ts`：`DEFAULT_PRESETS` 改由目录 `kind==='video'` 子集**派生**（恰好 5 键，`presetFromCatalog` 刻意不带 `watermark` 键 → 现网默认逐字**零漂移**）；新端点 `GET /exports/presets/catalog`（只读目录）、`POST /exports/presets/seed`（仅补缺失、**不覆盖用户已配/改过** → `{items,added}`）。前端 `PlatformPresets.vue` 加「从平台目录补全」按钮（替代逐项手填），`exportApi.catalog/seed`。
- **G12.2 合规内置基础词兜底（baserules）**：`compliance.ts` 新增 `BASE_RULES`（27 条《广告法》极限词 + 医疗高频词，block/warn 分级）；`loadRules` **仅在 words.txt 文件缺失 / 读取异常时**启用兜底（`source:'builtin'`），修复「词库缺失 → 合规扫描静默空转、产物误导为 pass」这一真实降级隐患（违「不静默降级」）；**文件在位时绝不并入**（`source:'file'`、命中集逐字零变化）。`rulesView` / `compliance-check` 的 `source` 域由 `file|missing` 收敛为 `file|builtin`。**m24 适配**：`probe-m24` 词库缺失断言随之由「missing/0」更新为「builtin 兜底 N 条（仍不 500）」——此为 G12.2 有意的行为变更（缺失不再返空），文件在位路径断言保持不变。
- **G12.3 词库补充建议采纳（suggest，Tier B）**：新增 `apps/server/src/services/compliance-suggest.ts`——`suggestRules(projectId|null)` 从**既有已付费的** `assets.params.compliance.llm.items` 聚合候选新词（`(category,归一词)` 去重计数、**剔除词库已有词**、level 一律 `warn` 起步〔升 block 属法务判断保留人工〕、按 `times` 降序 cap 50）；`appendRules(rules)` 建/续写 words.txt（`(category,normalize(word))` 去重、**追加不覆盖**、自动建目录、清洗破坏 `类别|词|级别` 格式的字符）。新端点 `GET /compliance/suggest?project_id=`、`POST /compliance/rules`。**零新 LLM 调用**（只读既有复审结论）。前端新增 `CompliancePanel.vue`（词库视图 + source 徽标 + 建议勾选采纳），经 `complianceApi.rules/suggest/appendRules`。
- **G12.4 排期发布节奏模板（cadence，Tier A）**：新增 `apps/server/src/services/cadence.ts`——`expandCadence({startAt,count,cadence})` 纯日期数学展开 `daily`/`interval(N 日)`/`weekly(星期集合)` 三模式为未来时间戳（校验 count 1–60 / intervalDays 2–30 / weekdays 非空、`errors` 非空则 `timestamps=[]`；末尾 `>= now-60s` 未来过滤）。新端点 `POST /schedules/cadence-preview`（不建库先看日期，`errors` 也回 200 供前端提示）、`POST /projects/:id/schedules/cadence`（逐条 `createSchedule` 复用既有未来时间校验、名称带 `#序` → `{created,skipped}`；`errors` → 400 `bad_cadence`）。前端新增 `ScheduleCadence.vue`——**以某条既有计划为模板源克隆其 `input_template`/`template_key`**（复用而不重复造输入表单），配节奏 + 预览 + 批量建，挂在排产 Tab（`ScheduleCalendar` 兄弟，未触碰其 890 行历史文件）。

数据与兼容：**新表 0 / 新列 0 / 新价 0**；预设仍存 `settings.export_presets`（`seed` 仅合并缺失键）；`BASE_RULES` 不落盘（仅缺失时内存兜底）；建议只读既有 `assets.params.compliance`、采纳才写词库文件；节奏复用 `schedules` 表与 `createSchedule`（`cronExpr='once'`、`status='pending'` 语义不变）。**不猜测 / 保留人工**：未登记平台 `catalogByPlatform → null`、建议一律 warn 起步、节奏越界 fail-closed 回 `errors`。文件行数：`platform-catalog.ts` 41 / `compliance-suggest.ts` 122 / `cadence.ts` 62 / `routes/compliance.ts` 25 / `routes/exports.ts` 176 / `routes/schedules.ts` 247 / `probe-m36.ts` 285 / `ScheduleCadence.vue` 315 / `CompliancePanel.vue` 268 / `PlatformPresets.vue` 281，均 ≤800（新组件独立成文件，未增 `ScheduleCalendar.vue` 负债）。

端点：`GET /exports/presets/catalog`、`POST /exports/presets/seed`、`GET /compliance/suggest`、`POST /compliance/rules`、`POST /schedules/cadence-preview`、`POST /projects/:id/schedules/cadence`（均新增）；`GET /compliance/rules`（`source` 域 `missing→builtin`）、`GET/PUT /exports/presets`（默认派生零漂移）行为向后兼容。

验证：`pnpm --filter @acs/server exec tsx scripts/probe-m36.ts`（四节 **59 项断言**全绿，零网络零计费：g12-catalog〔目录 8 平台、默认预设 5 视频无 watermark 键、seed 补图文幂等不覆盖已配〕/ g12-baserules〔缺失 → builtin 兜底、**文件在位绝不并入 BASE_RULES**〕/ g12-suggest〔从复审结论聚合、剔除词库已有词、level 恒 warn、appendRules 去重容错追加不覆盖〕/ g12-cadence〔三模式展开 + 6 校验错误 + 未来过滤、preview 200、bulk 建 N 条 pending 名称带 #序、bad_cadence/bad_input_template 400〕）；`probe-m36` 经 `run-probes.ts` 自动发现纳入 `probe:ci`；**M24（含更新后的词库缺失断言）/ M30 / M31 / M32 / M33 / M34 / M35 零回归全绿**；双端 `tsc --noEmit` / `vue-tsc --noEmit` + `pnpm --filter @acs/web build` 全绿。

---

## M37 能力速览（收尾与回归 · G13 自动值来源统一可追溯 · 纯前端 + 探针锁，零服务端变更）

路线图收官项：M32–M36 落地的各处「自动值 / 智能建议」在 UI 上各自造标注（chip 文案 / 长句 note / 徽标 / 无标注），用户看不到统一的「为何是这个值」；且存在一处实质缺口——M34 的 `caps_suggest`（覆盖项合法域由能力表收窄）服务端已下发 `source` 但前端从未消费。M37 = 一个统一徽标组件 + 9 触点接线 + `probe-m37` 锁定各自动化契约的 source 语义。核心纪律：**0 服务端代码 / 0 新端点 / 0 LLM 计费**（`tsc` 零 diff 可证），只标注不改行为（取值/提交/去噪策略逐字不变）。

- **G13.1 统一组件 `ProvenanceBadge.vue`**（纯展示 80 行，无状态无 emit）：`kind ∈ {auto 自动, endorse 背书, suggest 建议, builtin 内置}` 四类用户语言映射（**不向用户暴露内部术语 Tier A/B**，拍板），`text` 来源短语 + `title` 长依据收进 hover；色板与全局 token 同源（accent/ok/warn/中性灰），不引入新色值。「建议」类徽标必须传达「仅提示未执行」（Tier B/C 边界可见性）。
- **G13.2 自动值触点接线（6 处）**：`TemplateInputFields` 预填 chip（last_run→「自动 · 沿用上次运行」、brief→「自动 · 来自项目简介」，template_default 维持 M34 去噪不标注）；**`RunFormModal` 覆盖区补 `caps_suggest` 标注（G13 缺口）**——命中能力表时 summary 挂「自动 · 能力表合法域」，title 注明按本模型收窄且越界会被服务端 clamp；`PricingSuggest` 命中行改「自动 · 供应商在线目录/平台核实表定价」徽标（核实锚点入 hover，原长句精简）；`VideoCapsEditor` 自动背书 note 前置「背书 · 平台能力表」；`CompliancePanel` 词库仅兜底时挂「内置 · 基准词库兜底」（用户自有文件非自动值不加噪）；`PlatformPresets` seed 结果行挂「自动 · 平台目录」（added>0 才显示）。
- **G13.3 建议类触点（3 处）**：`NextStepsBar` 头部挂「建议 · 规则引擎」（前端静态标注即事实：规则引擎为唯一来源；强化「仅提示、点击才路由」）；`CompliancePanel` 建议区挂「建议 · 复审结论聚合」（表意来自已付费产物、零新计费）；`ScheduleCadence` 批量建结果挂「自动 · 节奏模板展开」。
- **G13.4 `probe-m37` 契约一致性锁（五节 34 断言）**：锁定前端标注的真源不漂移——prefill 各 key `source ∈ {template_default,last_run,brief}`、last_run 覆盖 template_default、`overrides.video.source='caps_suggest'` 且 `defaultResolution ∈ selectableResolutions`、未登记→null（不猜）；model-suggest 命中定价必带非空核实锚点、未登记双缺席；rules `source ∈ {file,builtin}`（缺失=builtin 全量、在位=file 仅文件）+ catalog 字段非空 + seed `added=3` 幂等重放 0；suggest 恒 warn 起步 + evidence 非空（「建议」不越权）+ 采纳落盘后 source 回 file；next-steps `kind` ∈ 枚举、≤3；cadence `errors` 非空 ⇔ timestamps 空（不静默产出）。未来若里程碑改 source 枚举，探针先红、前端标注随后适配。

数据与兼容：**服务端零变更**（新表 0 / 新列 0 / 新端点 0，`GET /compliance/rules` 等契约不变）；徽标纯展示组件，任一触点可单点回退互不牵连；清理两处自造样式残留（`TemplateInputFields` 的 `.src-chip`、`CompliancePanel` 的 `.badge*`）收敛入统一组件。文件行数：`ProvenanceBadge.vue` 80 / `TemplateInputFields.vue` 325 / `RunFormModal.vue` 422 / `PricingSuggest.vue` 249 / `VideoCapsEditor.vue` 470 / `CompliancePanel.vue` 262 / `PlatformPresets.vue` 293 / `ScheduleCadence.vue` 323 / `NextStepsBar.vue` 145 / `probe-m37.ts` 271，均 ≤800。

验证：`pnpm --filter @acs/server exec tsx scripts/probe-m37.ts`（**34 项断言全绿**，零网络零计费）；**M24 / M30–M36 零回归全绿**；`vue-tsc --noEmit` + `vite build` 全绿；`probe:ci` fail-fast 下仍仅 `m26 split-audit` 存量债红（11 个历史 >800 文件，M36 已 HEAD 复验与近期交付无关，可作后续专项清理）。

---

## M38 能力速览（扩展参数结构化与默认自动化 · 承接 M32–M37 收官后残留的裸 JSON 配置债）

M32–M37 把「啥都让用户配」收敛为「默认自动推导 + 用户可覆盖 + 执行前预览」，但 AI 配置实例的「扩展参数」仍是**对所有供应商一视同仁的裸 JSON textarea**——用户无从得知能填哪些 key、什么类型、合法值、是否必填、默认是什么。而服务端真正读取的 extra key 其实是有限且已知的一小撮（音色 / 尺寸 / 参考素材 URL / 生成音频 / 水印 / 种子 / 视觉声明 / 火山 appid 等），绝大多数有安全默认值——本质属 Tier A（系统真源已知）却被错放进「用户手填 JSON」。M38 沿用 `video-capabilities → /video-caps → VideoCapsEditor` 已验证的三段式范式补齐：

- **G14.1 服务端单一真源注册表 `adapters/extra-params.ts`**：`resolveExtraSchema(providerKey, serviceType)` 逐条登记可结构化字段（`{ key, label, type, options?, default?, required?, placeholder?, help? }`，type ∈ text/select/boolean/number/url-list/json），`defaultVoice(providerKey)` 收敛散在 tts-aliyun(`Cherry`)/tts(`alloy`)/tts-volcengine(`BV700_streaming`) 的音色兜底为唯一真源。纪律：仅登记经供应商文档/适配器实现核实的事实，不按模型名猜测；无安全通用默认者（如 SiliconFlow「模型:音色」）返回空串，绝不注入占位音色。
- **G14.2 只读路由 `GET /api-configs/extra-schema`**：镜像 `/video-caps`，零网络、零计费、零写库；前端据此按供应商动态渲染。
- **G14.3 前端结构化编辑器 `ExtraParamsEditor.vue`**：按 fields 渲染下拉/开关/数字/文本/URL 列表/JSON，带中文标签、默认预填、必填标记、用途说明；`buildExtra` 产出托管 key（空值省略、类型归一、必填/JSON 就地校验）。`ApiConfigForm.vue` 接线：拉 schema → `applyEcho` 把 `creationCapabilities` 剥离给 VideoCapsEditor、已知 key 剥离给结构化编辑器、其余透传留「高级」JSON 框（三者 key 互不重叠，提交时合并）。
- **G14.4 拆音色假门禁（Tier A 收敛）**：`preflight.ts` 中 `extra.voice` 为空时改为按 `defaultVoice(providerKey)` 兜底（不再强制手填），显式配置覆盖默认；`clone:` 仍拒（轻松创作不用克隆声音，红线不降）；无安全默认供应商（SiliconFlow）仍 `missing_voice` 但换成可行动提示（不猜、不注入占位）。实际生效音色随 `execution.voice` 进预检快照/确认卡（参数可见）。

数据与兼容：**0 改数据库 schema / 0 改 extra 存储格式**（仅影响表单渲染与预检兜底），既有实例数据零迁移、零破坏；不动密钥录入、付费执行确认、合规放行等人工红线。文件行数：`extra-params.ts` 208 / `ExtraParamsEditor.vue` 262 / `probe-m38.ts` 133，均 ≤800。

验证：`pnpm --filter @acs/server exec tsx scripts/probe-m38.ts`（**24 项断言全绿**：registry 18 + preflight 6，零网络零计费）；**M24 / M30–M37 零回归全绿**（m32/m33/m37 复跑 112 断言全绿）；`vue-tsc --noEmit` + `vite build` 全绿。

---

## M39 能力速览（扩展参数逐模型能力下沉 · 承接 M38 收尾项）

M38 的 voice/size 注册表粒度是 **provider 级**，但「哪些音色可用 / 默认是哪个 / 尺寸支持什么形态」实为**模型级事实**（qwen-tts 4 音色 vs qwen3-tts-flash 36 音色；CosyVoice2 官方 8 预置音色；qwen-image-max/plus 仅官方 5 档固定尺寸，1024x1024 对其非法）——对齐 Toonflow `voices[]` / `durationResolutionMap` 逐模型声明范式，把真正按模型区分的字段下沉为 profile 层。范围收敛：仅 audio.voice 与 image.size；video 时长/分辨率已由 M32 逐模型背书，vision / appid / 参考素材 / seed 等为账号级或无核实事实，不下沉。音色清单无法在线拉取（OpenAI 兼容 /models 仅返回 id；DashScope 原生语音行 fetch-models 短路回退 preset），单一真源仍是服务端注册表。

- **G15.1 逐模型 profile 表（`adapters/extra-params.ts`）**：`AUDIO_VOICE_PROFILES`（aliyun_qwen_tts 2 / openai_audio 2 / siliconflow_audio 1 / pollinations_audio 3）与 `IMAGE_SIZE_PROFILES`（万相 4 / 千问图像 2），按序首个正则命中生效；SiliconFlow「模型:音色」以 `{model}` 占位合成为候选完整串（编辑器零新语义）。事实来源逐条行内标注（Step 0 官方文档 WebFetch 核实 + 本仓实测约束）；枚举未核实者（elevenlabs voice id / MOSS-TTSD）标 text 不猜不预置默认；未注册 profile 的模型（qwen-tts 老一代）回落 provider 级，行为不劣于 M38。
- **G15.2 解析链与 model 参数贯穿**：`resolveExtraSchema(providerKey, serviceType, model?)` / `defaultVoice(providerKey, model?)` 签名向后兼容；profile 命中即**以模型级事实为准**（text 无默认→空，不继续回落 provider 级，防 elevenlabs 实例被注 pollinations 的 alloy 假默认）；新增 `defaultImageSize(providerKey, model?)`。`GET /api-configs/extra-schema` 加可选 query `model`（不传 = M38 现行为，旧调用兼容）。preflight：音色兜底传实例 model（空则 preset 首项）；尺寸合法性识别官方档位 `[1-4]K`（修复 M38 不认 wan2.7 的 `2K` 致静默回落），未配置兜底改逐模型默认（qwen-image-max/plus → 官方 1664x928，不再注入非法 1024x1024）。
- **G15.3 前端联动与脏值保护**：`config.ts extraSchema` 透传 model；`ApiConfigForm.vue` watch 源扩为 `[provider, serviceType, model]`，切模型即重拉 schema（序号护栏防晚到响应覆盖）；`ExtraParamsEditor.vue` 逐控件 dirty 记录——重建时用户手改过的 key 保留现值（切模型不冲掉手选音色），select 现值不在新候选集时动态追加「当前值」项（编辑既有实例不丢值、不误导）。

行为变化：SiliconFlow 实例选中 CosyVoice2 且未配 voice → 预检就绪并取模型级官方默认 `FunAudioLLM/CosyVoice2-0.5B:alex`（M38 时报 missing_voice）；无核实默认者（elevenlabs 实例等）仍显式要求配置（红线不降）。

验证：`pnpm --filter @acs/server exec tsx scripts/probe-m39.ts`（**37 项断言全绿**：registry 26 + route 3 + preflight 8，零网络零计费）；**M30 / M32 / M33 / M37 / M38 回归全绿**（m30 一处 voice 空断言按 M38 已交付语义基线修正）；server `tsc`、`vue-tsc --noEmit`、`vite build` 全绿。全探针遗留失败 m3/m8/m11（mengbao-episode 模板本地升 v10 的历史基线漂移）、m13–m16（级联）、m26（split-audit 存量债）经 git stash 复验均与本交付无关。

---

## M40 能力速览（轻松创作「确认才立项 + 立项信息智能填写」· 路线图收官后的用户流程优化）

用户痛点：轻松创作发送第一句话时就建项目（名称取原句前 40 字、载体固定口播、标签「创作草稿」），规划仅回写名称——**每次都要去项目页把名称/载体/模板/标签/简介再改一遍**。M40 把立项推迟到点「按此方案开始制作」，并让这 5 项信息由平台智能填好、确认前预览可覆盖（Tier A 预填 + Tier B 覆盖）。拍板：草稿影子项目（`status='draft'` 对用户隐身，避开 `creation_sessions.project_id` 可空 + 工作区目录重构的核心数据模型变更，用户可见效果等价且零迁移）。

- **G16.1 立项真源模块 `creation-chat/project-meta.ts`**：`deriveProjectMeta(plan)` 规则派生（slideshow→图文/story→短剧/其余→口播，名称取方案标题、简介取摘要、标签去重 ≤6；项目默认模板按载体从专业可启动模板派生（GENRE_DEFAULT_TPL，easy-* 批准链模板不入该字段））；`sanitizeProjectMeta` 逐项校验——缺项静默回落、非法值（模板不存在/easy-*/载体不在字典/超长）回落 + notes 随回复可见（不静默降级）；`projectMetaPrompt()` 把载体字典 + `listTemplates()` 专业模板候选注入规划消息（不靠提示词幻觉模板 key）。
- **G16.2 契约与哈希隔离**：`project` 与 plan **同级**（plan 分支 + 确认请求各加可选 project）→ 不入 planHash，改立项信息永不作废已确认方案；输入侧宽松 catchall + 服务端 sanitize（一个标签超长不得把已计费的整份方案判 invalid_plan）；误写进 plan 内部仍按结构契约拒绝。
- **G16.3 生命周期改造**：`createSession` 建 draft 影子项目（列表/统计/搜索任何入口不外泄，`GET /projects` status 白名单守死）；规划即智能填写草稿行（active 项目绝不覆写、clarify 不动值）；`confirmCreation` 同事务内覆盖值入库 + 转正 active + 插「已创建项目《…》」对话消息（幂等重发不重复立项）；会话详情透出 `session.project` 立项预览。
- **G16.4 Web 预览可覆盖**：方案卡新增「将创建的项目」区块（名称/载体下拉/标签/简介，默认即智能填写值）；不提供「默认模板」设置项（出片模板由 recipe 固定、项目默认模板服务端按载体自动派生，需调整去项目编辑页）；`projectDraft` dirty 护栏防服务端回读冲掉正在输入；确认只提交改过的字段；草稿期隐藏顶栏「项目」入口；首页/空态文案改为「确认前不立项，点开始制作才创建项目」。
- **G16.5 删除会话闭环 `DELETE /creation-sessions/:id`**（新建 `creation-chat/session-delete.ts`）：影子项目唯一副作用（聊一半放弃 → 库里永久留不可见的 draft 行）就此回收。删除范围按是否立项分两种且不静默多删——未立项（项目仍 draft 且名下无 run）事务内级联清掉消息/会话/参考素材/规划记账/项目行，提交后回收磁盘目录；已立项只删对话记录，项目与产物原样保留并回传 `reason` 明告（要删项目请去项目页）。在途保护：planning/starting → 409 `session_busy`，关联 run 仍 queued/running/waiting_input → 409 `run_active`。列表卡片右上角删除按钮按「是否已立项」分措辞二次确认，结果与失败原因就地显示。

验证：`probe-m40`（**6 节 80 断言全绿**，零网络零计费：stubFetch 回放规划 + stub startRun + app.request 内存 HTTP 删会话）；**M30 / M31 / M32 / M35 / M38 / M39 回归全绿**（合计 313 断言）；server `tsc`、`vue-tsc --noEmit`、`vite build` 全绿。详规：`docs/superpowers/specs/2026-09-20-agencys-content-studio-m40-design.md`。遗留：无（草稿行累积已由 G16.5 闭环）。

---

## M41 能力速览（轻松创作第一批：进度真实投影 · 成果预览 · 首轮带素材 · 补录）

> 补录：第一批交付时未入本表，据源码与 `probe-m41` 回查。痛点：轻松创作立项后只显示「进行中」，看不到真实进度与已生成素材，且第一句话就触发规划扣费、想先传参考素材再规划做不到。

- **M41.1 进度真实投影（`creation-chat/projection.ts` `projectCreation`）**：三阶段完成计数由 run/steps/tasks/assets 真实派生，**无子任务时显示步骤真实失败、不编造比例**；`progress.issue` 对相同原始错误去重并保留作用阶段（`details[].scopes`）；阶段适用性（images/frames/motion）取自 run 冻结输入而非可变会话方案（损坏冻结元数据不借用旁证编造）；严格交付状态——最新合格成片丢失时不回退旧版、完成 run 无合格成片不得误报成功、列表沿用同一投影；展示 DTO 硬红线：不暴露 `relPath` / 完整任务参数 / 外部编号。
- **M41.2 成果预览（`CreationArtifacts.vue`）**：逐镜 `image/voices` 可用性投影（新 run 显式复用旧素材仍可预览、跨项目引用以「素材不可用」占位不泄露资产元信息、已删除/文件丢失以不可用占位不使详情崩溃、任务结果与资产镜头冲突时不可预览、候选只来自本镜头不扫描无关项目历史）。
- **M41.3 首轮带素材（`deferPlanning` 草稿模式 + 固定创建键）**：首句只建草稿、**零模型调用**，元数据不显示为已发送消息、可从服务端安全快照恢复；同创建键同输入返回原会话（幂等）、不同文字 / 不同模式一律 **409** 冲突；附件登记零调用、部分上传失败不触发无参考规划、全部参考就绪后一次规划；消息去重靠稳定附件指纹（传输重试不重复规划），同消息键不同附件 / 不同文字 **409**；规划解析失败以详情 `error` 回传不误报成功、失败同键重试不自动再调模型；前端 `use-first-input.ts` 只用草稿模式与固定创建键，创建结果不明不上传、不收费规划。

验证：`probe-m41`（**3 节 57 断言全绿**：projection / first-input / first-input-client；isolatedEnv 独立库 + 素材目录，`globalThis.fetch` 全阻断，零网络零计费）。

---

## M42 能力速览（轻松创作第二批：中途审阅暂停 · 候选版本选择 · 自然语言局部返修 · 补录）

> 补录：第二批交付时未入本表，据源码与 `probe-m42` 回查。共同红线：**现存会话恢复路径零破坏、审阅勾选不入 planHash、局部重合成零模型调用、创作模板键集合精确不误伤专业 run**。

- **M42.1 中途审阅暂停（`gate.ts` + 变体模板 `easy-video-review.yaml`）**：以「变体模板键 + 快照固化 gate」实现，**审阅闸只挂图文画面（images）与动态首帧（frames）两步**，变体除 gate 外步骤定义与原 `easy-video` 逐字同构（inputs/params/batch/when/after 零漂移），首帧闸文案明告「继续后才开始高费用生成」，变体不声明 `skip_label`（免审＝不勾选、不给跳过入口）；勾选 → run 以变体键启动、`recipe.templateHash` 按所选变体重算、快照固化 gate（执行期不读在线模板）、执行期 `assertRecipeSources` 三重自校验通过；未勾选 → 原模板原哈希零回归；`CREATION_TEMPLATE_KEYS` 精确集合（含旁白/对白原模板与审阅变体 = 4），非创作模板不解析 recipe（不越界接管专业 run）；项目 `templateKey` 仍 `easy-video`（专业工作台可跑），与 run 模板键解耦。前端 `CreationReview.vue`。
- **M42.2 候选版本选择（`candidates.ts` + `CreationCandidates.vue`）**：多版本候选投影——同镜多版本全部可见、在用者为 run output 指向那一版，缺文件候选以不可用占位保留（不静默消失），无多版本镜头只有一个候选（不虚构选择），候选视图只含安全元信息不外泄本地路径；选定补全走本地重合成提交（零模型调用），重合成后详情指向最新合格成片不回退旧版。
- **M42.3 自然语言局部返修（`rework.ts` `planRework` + `use-rework.ts` + `CreationRework.vue`）**：一句话定位镜头 → LLM 解析预览逐镜给出「原提示词 → 新提示词 + 单价」（**确认前可审、成本可见**）→ 显式确认 → 批准链同事务改写方案、只重置目标镜；决策 / 返修 / 重合成消息以 `system` 角色落库被历史查询排除，不污染后续规划（规划请求仍带用户真实对话上下文）。

验证：`probe-m42`（**6 节 128 断言全绿**：review-template / review-chain / review-api / candidates / rework / messages；模板目录只读拷入隔离区、LLM/媒体 fetch 全阻断，引擎执行链只在离线 literal 模板上真跑）。

---

## M43 能力速览（轻松创作第三批：画质选择、逐镜参考绑定、跨轮参考合并）

差距评估（相对即梦 / Coze）八项剩余候选经源码核实落三件，共同红线：**预算门禁 / planHash / 配置冻结 / 归属校验全部保持，0 新表新列、0 新依赖、不改 `easy-video.yaml`、不动引擎调度、画质与绑定全程零计费**。

- **G17.1 画质档位入口贯通（模块一）**：`preflight.ts` 顶层新增 `resolutionOptions`（dynamic 取 `resolveVideoCaps` 真源档位，实例显式声明取交集；**planHash = `hashJson({plan, execution})` 仅含 execution，顶层加法不改任何现存哈希**）。`contract.ts` `confirmationSchema` 加可选 `resolution`（成立前提：视频按秒计价、价格注册表无 resolution 维度 → 预估金额不变；登记 edge：若未来分档定价则必须入 hash）。`execution.ts` `confirmCreation` 保持既有 hash 防篡改校验先执行，通过后按 `resolutionOptions.choices` 校验越界（422 `resolution_unsupported`）再覆写 `pf.execution.resolution = mapResolution(...)`；缺省 = 现行为逐字不变，retry/rework/recompose 天然沿用 run 冻结 recipe。前端 `CreationPlanCard.vue` 抽出 `CreationResolution.vue`（82 行）子组件、未选择不传键。**文案红线：确认卡与对话流不承诺「更高画质不加价」，只展示所选档位 + 诚实标注实际计费以供应商对所选档位定价为准**。
- **G17.2 逐镜参考绑定（模块二）**：读侧 `recipeRefImageIds`/`recipeFirstFrameId` 早已完整消费 `ref.shotId`（shot 级优先→全局回退），唯写侧全断。新端点 `PATCH /creation-sessions/:id/attachments/:assetId/ref`（新建 `ref-bind.ts`，84 行）：归属校验 + `attachmentsLocked` 同源状态门（run active → 409）、仅 image 类可带 shotId（video/audio → 422）、ready 态真源校验 shotId ∈ `plan.shots`；**payload 与 plan.refs 双写**（payload 是再规划编译权威源），patch 进 plan 后重跑 `preflightPlan`，hash 变则 `planRevision+1` 令旧确认键自然 `stale_plan`（用户须重新确认，零 LLM、零计费）。`attachments.ts` `resolveAttachmentRefs` 编译时保留 `shotId` 修复写链断点。前端 `AttachmentTray.vue` 图片行「用于」下拉（整片 + 当前方案逐镜，规划前仅整片），`use-creation-chat.ts` 抽出 `use-creation-attachments.ts`（249 行）附件 composable（PATCH epoch 晚到保护 + 失败回滚 prevRole/prevShot + 不计费提示），`MessageRefBubble.vue`/`ref-utils.ts` 补「第 N 镜」徽标。
- **G17.3 跨轮参考合并（模块三）**：`planning.ts` `effectiveRefs = mergeRefs(priorRefs, thisTurnRefs)` 修复「带新附件再规划即整体替换、旧参考丢失」——同 assetId 以本轮覆盖（role/hash 取新值、本轮未重传则保留已绑 shotId）、prior 其余保序保留、新资产追加；合并后 >12 → `too_many_refs` 服务端权威拒绝，**不静默截断**。

验证：`probe-m43`（**52 断言全绿**，isolatedEnv + stubFetch + stub startRun，quality / binding / carry / 零副作用四节，全程零媒体零 LLM 调用）；**M30 / M31 / M35 / M40 / M41 / M42 定向回归 468 断言全绿**；server `tsc`、web `vue-tsc --noEmit`、`vite build`、`validate:templates`（16 份 / 113 步 / 0 错，模板零改动）全绿；全量 `run-probes --jobs=2` 与 M42 收尾基线逐项比对**零新增失败**。`m26 split-audit`：本批把 `use-creation-chat.ts`（曾 835 行）按 createRework 依赖注入先例拆分回落到 ≤800。浏览器验收（隔离 stub 单端口环境，不点真实付费生成）：清晰度下拉展示与选择、逐镜绑定下拉 ready 态逐镜候选、绑定后 revision 抬升 + 不计费提示 + 镜号徽标、44px 触控目标实测达标。

---

## M44 能力速览（对白模式：多角色人物对白 · 原生对白引擎背书 · 严格 ASR 逐字核验 · 补录）

> 补录：对白模式为差距评估批次序列外的插入批（M43 第三批与 M45 第四批之间），交付时未入本表，据源码与 `probe-m44` 回查。痛点：轻松创作此前只有旁白（一人配音读全程），做不出「两个及以上角色你一句我一句」的人物对白短视频。

- **M44.1 对白契约（`creation-chat/contract.ts`）**：`creationPlanSchema` 加 `performance: 'dialogue'` + `cast[]`（id/name/appearance/voice）+ `lines[].speaker` + `shots[].characters`；权威校验——至少两名角色、拒重复角色 ID、拒幽灵说话人、单人朗读不能冒充对白、说话角色必须出场、旁白不得携带未消费对白字段、对白不得缺失说话人、对白拒绝图文（slideshow）模式；**历史旁白方案序列化逐字不变**（不插入 performance 默认值）。
- **M44.2 原生对白能力背书（`@agencys/ai-provider-kit` `resolveNativeDialogueCaps`）**：volcengine seedance 逐型号 `generateAudio=true`、aliyun wan3.0 `promptExtend=false`（关闭台词扩写）；**未来型号 / 同供应商第三方型号 / 未知对白协议一律不自动背书返回 null** → 回落「逐镜配音 + ASR 逐字核验」路线；`dialogue.ts` `dialogueAudioOptions` 保证实例 extra 不可覆盖强制原声与禁扩写参数，完整音频选项进任务快照。
- **M44.3 严格 ASR 与逐字核验（`services/strict-asr.ts` `resolveStrictAsrEndpoint`）**：独立于参考分析的宽容 ASR，**仅接受显式启用的 `whisper-1` + `openai_verbose_json` 分段时间戳协议**，缺配置抛 `CreationError('missing_asr', 422)`（人物对白不能无 ASR 执行）；配套 `dialogue-asr-policy.ts`（verbatim-segments 策略）、`creation-chat/dialogue-media.ts`（抽音轨 + SRT + 逐字核验）、`dialogue-cache.ts`（响应缓存复用）、`pipeline/actions/dialogue-subtitle.ts`（字幕 action）。
- **M44.4 模板与前端**：`easy-dialogue.yaml` + 审阅变体 `easy-dialogue-review.yaml`；`CreationDialogueCast.vue` 角色 / 说话人编排。

验证：`probe-m44`（**14 节 232 断言全绿**：contract / providers / asr / recipe / asr-config / planning / media / asr-tasks / preflight / engine / review / recovery / rework / recompose；已按 `scripts/probes/m44/*` 模块化拆分，isolatedEnv + fetch 阻断零联网，重合成决策阶段零联网）。

---

## M45 能力速览（轻松创作第四批：成品品牌贯通 · G18 水印/片头尾/字幕样式 · 混合方案）

差距评估落地的第 18 项：轻松创作成片此前在严格引擎门（`ffmpeg-merge` `strict ? {}`）被整体跳过品牌叠加，用户在平台/项目配好的水印、片头尾、字幕样式对轻松创作成片**完全不生效**。拍板（混合）：`isCreationTemplate` 的严格 run **默认继承**平台/项目已配 `settings.brand`（`resolveBrandConfig` 三层合并原样复用），确认卡提供逐次「应用品牌风格」开关可关；未配品牌 → `resolveBrandConfig` 返回 `{}` → 输出**逐字节不变**。BGM 澄清：经源码核实 BGM 早已端到端贯通（`attachments.ts` 音频默认 `role:'bgm'` → refs → `ffmpeg-merge` 严格分支消费，M31 交付），本批不改 BGM 机制，仅在品牌卡补一行可发现性提示。

- **G18.1 契约与启动开关**：`contract.ts` `confirmationSchema` 加 `brandApply: z.boolean().default(true)`——与 reviewGate / M43 resolution 同类「启动方式」，**不入 planHash**（缺省 true 时请求体与旧版逐字一致）。`compose-config.ts` `ComposeConfig` 加 `brandApply?: boolean`（与 `_compose.brand` 对象同级不同键，`readComposeBrand` 无碰撞）。
- **G18.2 落库链修正（计划前提的必要偏离）**：实施发现 `createRunRow → prepareRunInput → normalizeInput` **只保留模板声明 inputs 与 `_params`**（`easy-video.yaml` 无 `_compose`），计划原案「把 `_compose` 塞进 createRunRow input」会被静默丢弃、retry 克隆同样丢失。修正：`execution.ts` `confirmCreation` 仅当 `brandApply === false` 时在**同事务内 createRunRow 之后直写** `run.input._compose`（镜像工作台 `updateComposeConfig` 先例，默认 true 不写任何键 → run.input 与旧版逐字一致）；`retryCreation` 显式克隆 `src.input._compose` 回新 run（开关随续跑保留）。否决「让 prepareRunInput 携带 `_compose`」方案：专业 run 创建 API 将可注入 compose 配置、绕过工作台 `requireEditableRun` 状态门（特权升级）。
- **G18.3 引擎门翻转（爆炸半径限定）**：`ffmpeg-merge/index.ts` 品牌闸改为 `(!strict || (isCreationTemplate(templateKey) && composeCfg.brandApply !== false)) ? resolveBrandConfig(...) : {}`——非严格（专业）不变；严格 + 创建模板 + 未关 → 继承（新默认）；关 → `{}`；严格 + **非**创建模板 → `{}`（其它严格 run 维持现状）。零新表零新列（开关存 `run.input._compose` JSON）、零付费媒体（纯 ffmpeg 合成期叠加）、不动引擎调度、不改 `easy-video.yaml`。
- **G18.4 预检透出**：`preflight.ts` `CreationPreflight` **顶层**新增 `brandSummary: { available, watermark, intro, outro, subtitle } | null`（run 层传 null 取平台+项目合并真值；仅顶层不进 `execution` → 不改 planHash，镜像 resolutionOptions 口径）。
- **G18.5 Web**：新组件 `CreationBrand.vue`（100 行，比照 CreationResolution：默认 on 开关、`min-height:44px`、SVG palette 图标、`aria-label`；`brandSummary.available` 为假整块不渲染；副文案按槽位如实列出将应用项，关闭切「本次成片不含品牌水印/片头尾与自定义字幕」；附 BGM 段数提示）；新 wrapper `CreationStartupOptions.vue`（42 行）收编 reviewGate/resolution/brand 三启动选项，`CreationPlanCard.vue` 经净减回落 **787 行 ≤800**；`use-creation-chat.ts` `confirm` 第 4 参 `brandApply` 仅 false 传键（请求体默认与旧版逐字一致）。

验证：`probe-m45`（**3 节 30 断言全绿**，isolatedEnv + 品牌夹具（字幕样式纯配置，零文件系统）+ stub startRun + fetch 阻断计 mediaCalls=0：门真值表四组合 / brandSummary 与 planHash 逐字节相等 / 默认确认 run.input 无 `_compose`、false 直写落库且 recipe·planHash·refs 零污染、真跑 retryCreation 开关保留、schema 缺省 true + `.strict` 拒未知键、HTTP 202 受理）；定向 9 探针（m11/m19/m30/m31/m40/m41/m42/m43/m45）934 断言 / 3 失败——3 项均为 `probe-m19` voice-clone 存量（git 溯源 9df03c6 aliyun 合并重构、M43 提交祖先，非本批引入）；全量 `run-probes` **3867 断言 / 43 失败 / 3824 通过**，与 M43 收尾基线（3604/49 存量失败）逐项比对**零新增失败**（43 项失败全部存量归因，含 m26 唯一失败 = 历史红线债 probe-m11.ts 851 行）；server `tsc`、web `vue-tsc --noEmit`、`vite build` 全 EXIT=0；`m26 split-audit` 无新增 >800 文件。浏览器验收（`accept-m45.ts` 一次性脚手架，隔离库 + 假 LLM + fetch 阻断 + 单端口 :4145 静态托管，验收后已删除）：品牌会话开关联动（默认 on、副文案「成片将叠加…」切换、aria-label）、`.ec-brand-row` 实测 44px、无横向溢出、提交后 scaffold 日志实锤 `run.input._compose={"brandApply":false}` 落库、未配品牌会话不渲染开关、console 仅 socket.io 存量噪音；390px 设备仿真在验收环境不可用（无 resize 能力），按计划以 DOM 取证代偿并如实标注（组件 flex column 无固定 min-width）。

---

## M47 能力速览（免 ASR 核验对白执行链 · 路 B：模型原生出声 + 估算字幕）

M44 严格对白执行链落地后一直冻结在「未接真实 whisper-1 即 `dialogue_unavailable`」，关掉 ASR 逃生阀又被强制降级旁白（路 A）。本里程碑接通**免核验对白执行链**（huobao / 即梦式：由视频模型原生发声、字幕按批准台词估算），触发条件 = `resolveDialogueAsrPolicy(projectId).strict === false` **且**当前视频实例命中 `resolveNativeDialogueCaps`（volcengine Seedance 2.0 系 / 阿里万相 3.0 系，单一真源不动）；能力不达标时保留路 A 降级旁白。**保留红线（不放宽）**：原生对白逐型号背书、视频必带非静音原声轨（ffprobe 实测 + volumedetect）、台词容量预检、对白禁用 TTS、人工审阅闸强制；**降级的红线（改诚实标注）**：逐字 ASR 核验 → 估算字幕 + 必审提示。

- **方案与准入（`recipe.ts` / `preflight.ts` / `execution.ts`）**：`recipeSchema` 加可选键 `estimatedDialogue: z.literal(true).optional()`（**无默认值 → 存量 run 序列化不增键、planHash 逐字不变**）；dialogue 分支 superRefine 改二选一互斥（带 `asr` 严格快照 XOR 带 `estimatedDialogue`，二者皆无或同时有即拒），免核验仍强制 video 端点 + `videoMode !== 'none'` + 禁 audio/voice + 逐镜镜长约束。`frozenSettings` 的 `dialogue_subtitle` 分支仅在**非 estimated** 时才要求并解析 `recipe.asr`。`preflight.ts` 注入 `resolveDialogueAsrPolicy` 三层解析（项目 `settings.dialogue_asr.strict` → 全局 `settings` key → 硬默认 true）：strict=true 逐字维持现状（`snapshotStrictAsr` / `missing_asr` 语义不变）；strict=false 不取 ASR 快照、`dialogueAudioOptions()` 硬校验命中原生对白背书（未命中 → `native_dialogue_unsupported` 422 可行动提示换模型）、execution 打 `estimatedDialogue: true`、estimate 不产 `asrSeconds`；**顶层新增 `dialogueMode: 'strict'|'estimated'|null`（仿 `resolutionOptions`/`brandSummary` 顶层加法先例，不进 execution → 不改 planHash）**。`execution.ts` 冻结闸由无条件拒绝改为 `dialogue && !pf.execution.estimatedDialogue` 才抛 `dialogue_unavailable`（strict 执行依旧冻结，等真实接 ASR 另立项解冻），免核验放行启动、retry 路径 `if (recipe.asr)` 复解析与 `remainingCost` 天然兼容零改动。
- **字幕步骤分流（`dialogue-media.ts` / `pipeline/actions/dialogue-subtitle.ts`）**：新增纯函数 `estimatedDialogueSrt(plan, clips)`（逐镜在 `[ESTIMATED_HEAD_LEAD=0.3, min(批准镜长, 实测 videoDuration))` 窗口内按 `normalizeDialogueText` 归一字数占比分配区间、句间连续单调；幽灵镜头 / 窗口不足 / 空台词 / 归一空台词 / 时间戳越界全部拒绝），配套 `ESTIMATED_DIALOGUE_POLICY='estimated-lines-v1'` / `estimatedValidationHash(clips)`（只冻结 `{shotId,duration,videoDuration}` 三要素）/ `assertEstimatedClipSource` / `estimateDialogueClip`。`dialogueSubtitle` action 按 `recipe.estimatedDialogue` 分流：**estimated 零付费分支**逐镜 `extractDialogueAudio`（抽音轨 + 非静音 volumedetect 守卫，wav 登记为 `dialogue_audio` 资产供溯源，**不提交任何网络请求、不建 genTasks/usageRecords**），SRT 资产 params 打 `{ estimated:true, policy, validationHash }` 并 `ctx.log` 明告「字幕为估算非实测」；strict 分支现有 ASR 逻辑逐字不动（`dialogue-cache.ts` 只服务 strict）。
- **合成（`pipeline/actions/ffmpeg-merge/index.ts`）**：dialogue 分支按 `recipe.estimatedDialogue` 分流——estimated 时 clips 来源改为本步实测 `inspectDialogueMedia`（原声 / 时长 / 音画基准守卫与成片出口强检逐字保留）+ 同源 `estimatedDialogueSrt` 重算比对字幕资产（`validationHash` 不符 → 拒绝陈旧字幕），成片 params 诚实标注 `dialogue_subtitles_estimated:true` + `dialogue_review_required:true`（`voices:0`、`dialogue_clips` 携实测 `videoDuration`）；BGM 音量上限与原生音频混流两路共用不改；strict 路径零改动。
- **规划与文案（`planning.ts` / 模板 / Web）**：`planning.ts` 能力注入改三段式（每条以 `【人物对白能力】` 前缀、每轮仅一条）——`asrStrictOff && hasNativeDialogue` 允许产出 `performance=dialogue` 并声明「免逐字核验 / 字幕估算 / 须人工审阅」；`asrStrictOff && !hasNativeDialogue` 维持路 A 降级 narration；ON 分支逐字保留现状。`easy-dialogue.yaml` / `easy-dialogue-review.yaml` captions 步 title 与 compose gate message 改模式中性且诚实（「估算或实测」「免核验路线字幕未逐字核对，请收听原声比对台词」；改动仅影响新会话哈希，无存量 dialogue run）。`system-settings/index.vue` 与 `project-detail/CreationPanel.vue` 逃生阀文案：关闭后语义由「降级旁白」改为「免核验对白（需视频模型原生对白背书，否则仍降级旁白）」；前端确认卡读 `preflight.dialogueMode`，estimated 显示「免 ASR：模型原生出声，字幕按台词估算（非实测）」提示条，成果视图字幕资产带 `params.estimated` 显示「估算」badge。

验证：`probe-m47`（**7 节 55 断言全绿**：recipe / preflight / execution / srt / action / merge / plan；isolatedEnv + 除 plan 节 stub 回放 LLM 外 `globalThis.fetch` 全阻断零联网零付费 + 真实 FFmpeg lavfi 合成带音轨样片；覆盖 estimatedDialogue 三分支互斥与存量 narration/strict recipe 哈希逐字不变回归、策略三层分流与 `native_dialogue_unsupported`/`missing_asr` 零回归、`dialogueMode` 顶层不进 execution、冻结闸条件放行、估算 SRT 分配 / 单调 / 越界 / 空台词拒绝、estimated 字幕步零 genTasks/usageRecords 与静音守卫、合成同源重算 / 陈旧字幕拒绝 / 缺原声轨拒绝、规划注入三段式）；server `tsc --noEmit`、web `vue-tsc --noEmit`、`validate:templates`（19 份 / 123 步 / 0 错 0 警）全 EXIT=0。实弹（需 Seedance 2.0 / 万相 3.0 实例）：一条多角色对白需求 → 确认卡显示免核验路线 → 出片含原声与估算字幕 → 审阅闸通过交付。

---

## M50 能力速览（剪辑工程交换导出：成片一键导出 FCPXML / EDL / OTIO 多轨工程）

> 痛点：平台产出的成片是一个「焊死」的 MP4，专业精剪（改字幕时间、重排镜头、单独调旁白/BGM/SFX）只能在外部剪辑软件里从零重搭。本里程碑对任意产出成片（compose 步有 `final_video` 产物）的 run 提供**单向**一键导出标准剪辑工程（FCPXML→剪映专业版 / Final Cut / DaVinci Resolve，EDL→Premiere / Avid，OTIO→Resolve / 程序化管线），落成**多轨工程**（V1 镜头序 · 逐句对白/配音轨 · BGM 轨 · SFX 轨 · 字幕轨）继续精剪。**非目标（登记不混入）**：不做导入回读、不自建多轨时间轴 UI / 波形 / 混音台（维持 Backlog 重型排除项）、不支持剪映私有 draft 格式、不做云端直传第三方。

- **M50.1 时间轴真源 = 合成期 canonical 快照落库（纯增量，B② 同源红线）**：新建 `pipeline/actions/ffmpeg-merge/timeline-snapshot.ts` `buildEditTimeline`，compose 成片 params **加法落** `timeline`（`{v:1,fps,width,height,totalSec,introSec,outroSec,segments[],lines[],sfx[],bgm|null,transition|null,subtitle|null,watermark}`），数据全部取自动作内存中已算好的既有变量（AlignPlan / voiceDur / sfxList / introArg / bgm），**不改任何 ffmpeg 参数与音频结果**；文本字段截断（≤200 字）防 JSON 膨胀；`strict`/`native_dialogue` 无逐镜 voiceDur 时 `voices` 置空仅留视频段。坐标单一口径：`segments.startSec`/`lines.timelineStart` 为**内容轴**（片头后 0 起算，导出方各自 +introSec 落绝对轴），`sfx.startSec` 已是绝对轴。
- **M50.2 导出双路解析、不造第三条时间轴逻辑（`services/edit-exchange/timeline-source.ts`）**：`resolveEditTimeline` 优先消费 `params.timeline`（`v===1 && segments && lines` 结构校验）命中即 `source:'stored'` 直通；无 timeline 的存量成片走**同源兜底** `recomputeTimeline`——复用 `align.ts` `planBestEffortTimeline`（与合成期同一纯函数）按分镜 + 配音资产就地重算（images/motion 两模式），`source:'recomputed'`；重算也失败 → `EditExchangeError('no_timeline')`，文案指引「重新合成后再导出」。端点错误码收敛为 `no_final_video` / `no_timeline` / `bad_format`。
- **M50.3 三格式化器 + 时码单一真源（`timecode.ts` sec↔帧↔时码 NDF 唯一换算；`render-context.ts` `FormatCtx` 三器共用）**：帧率取 `timeline.fps`，全非丢帧（NDF）。**FCPXML 1.10**（`fcpxml.ts`）：`resources`（format + asset + title/dissolve effect + style）→ `sequence`（spine V1 镜头序、转场启用时段间插 `transitionlist` fade；role dialogue / music / sfx 独立 `audiostream`；字幕逐句 `<title>` 挂 generator 走纯净文本轴）；**EDL CMX3600**（`edl.ts`）：仅 V 序列 + AA 混音旁白轨、转场 → `Dissolve` 行、`HH:MM:SS:FF`@fps；无字幕/SFX/BGM 分层（EDL 语义上限，包内 README 明列降级面）；**OTIO JSON**（`otio.ts`）：`Timeline` 多 `track`（Video / Dialogue Audio / Music / Effects / Markdown），按 start 插 Gap 对齐。
- **M50.4 交付 = zip 资产，复用 `services/export.ts` fflate store 基建（`services/edit-exchange/index.ts`，274 行）**：`collectMedia`（段/句/bgm/sfx 按 relPath 去重）+ `planNaming`（`media/<basename>` 唯一 + manifest 映射 assetId↔媒体文件↔原相对路径）→ 包内 `{name}.{ext}` + `manifest.json` + `README.txt`（兼容矩阵/降级声明）+（`include_media` 时）`media/`（流式 store 不压缩）；字节稳定命名 `{pkg}__run{id}__{stamp}.zip`；`registerAsset` kind=`archive` purpose=`edit_exchange` params 记 `{runId,format,timelineSource,includeMedia,mediaCount,totalSec,fps}`（`storage.ts` `purposeSubDir` 补 `edit_exchange→exports`）。路由 `GET /runs/:id/edit-exchange/formats`（能力探测）+ `POST /runs/:id/edit-exchange {format,include_media?=true}`，下载复用 `GET /assets/:id/file?download=1`。
- **M50.5 Web 入口单一真源（`lib/edit-exchange.ts`）**：`lib/api/insights.ts` 加 `editExchangeApi`（formats/create/fileUrl）+ `EditExchangeFormat`/`EditExchangeFormatsResult` 类型（`api/index.ts` 再导出）；新 `lib/edit-exchange.ts`（格式能力表 + `editExEnabled`/`editExTitle` 纯函数 + `probeEditExchangeFormats`/`createEditExchangeDownload` 序列）供两处入口复用，避免逻辑漂移；新 `lib/download.ts` `triggerDownload`。运行详情成片卡（`RunStepCard.vue`：run 级探测经 `use-run-extras`，`ffmpeg_merge` 步 `editExFormats.final_video` 时呈现 FCPXML/EDL/OTIO 三按钮，不可用置灰回服务端 `reason`，recomputed 时提示「时间轴按分镜重算」）+ 轻松创作成片区（`CreationResult.vue`：`watch` 成片就绪后探测，同组件复用）。

验证：`probe-m50`（**6 节 64 断言全绿**：timecode / formatters / snapshot / sources / bundle / redline；isolatedEnv 隔离临时库 + `globalThis.fetch` 阻断零网络零计费）——覆盖时码换算对拍（fps=25 整帧 / 非整帧舍入 / NDF 10800s 边界 / 负秒 / fps=0 兜底）、三格式化器结构断言（OTIO 可 `JSON.parse` 且五轨命名固定 + clipCount、FCPXML 含 format/sequence/title/transition、EDL record 时码升序 + Dissolve 行）、`buildEditTimeline` 坐标口径（segments 累计 / relPath 反查 / 计划句 vs concat 句 timelineStart / text≤200 截断 / sfx 绝对轴）、`timeline-source` stored 直通 / recomputed 兜底 / 双失败 `no_timeline` / 无成片 `no_final_video`、zip manifest 与 media 引用一致性 + `bad_format` + `probeEditExchange` 能力探测、≤800 红线自查。**合成链路零回归背书**：timeline 落库为纯加法字段，全量 `run-probes` **4244 断言 / 46 探针全绿**（零红灯，含 m26 红线），其中合成链路 m7/m11/m18/m19/m42/m44 全绿即证明「不改变任何 ffmpeg 参数与音频结果」（B② 同源红线）；`pnpm -r typecheck`（server tsc + web vue-tsc）、web `vite build` 全 EXIT=0。新文件均 <400 行（最大 `timeline-source.ts` 189 行），`ffmpeg-merge/index.ts` 维持 785 行 ≤800 红线。遗留（残差登记，不扩范围）：工程导入回读、剪映 draft 私有格式、多画幅多版本一并打包、云端直传——均不做；剪映对 FCPXML 支持随版本漂移（社区口径）以 acceptance 实测版本登记，不达标时 EDL/OTIO 双路保底。

---

## 路线图（M32–M39 · **全部交付 · 收官**）

> 平台智能化改造（决策权移交）路线图已收官：M32（能力/默认单一真源表 + Tier A 智能默认引擎）、M33（AI 配置智能化）、M34（模板与运行入参自动化）、M35（创作流程自动化）、M36（运营配置自动化）、M37（自动值来源统一可追溯 + 探针全覆盖）、M38（扩展参数结构化与默认自动化，补齐收官后残留的裸 JSON 债）、M39（扩展参数逐模型能力下沉，voice/size 由 provider 级进化为模型级）**全部交付**，见上方各「能力速览」。详规（L0.5 立项纲领）：`docs/superpowers/specs/2026-09-19-agencys-content-studio-platform-intelligence-charter.md`（仓库内相对路径）。

**主题**：平台智能化改造（决策权移交）——把「啥都让用户选、啥都让用户配」收敛为「**默认自动推导 + 用户可覆盖 + 执行前预览**」三层决策模型（Tier A 自动 / Tier B 建议 / Tier C 必须人工）。根因：平台把「决策」与「核实」混在一起全推给用户；大量本属 Tier A（系统真源已知）的项被错放进「用户手填」。关键约束：Tier A 不取消校验，而是把「核实」主体从用户转移到**系统真源表 + 预览闸门**，「不猜测 / 不静默降级 / 成本可见」安全线不降。

| 里程碑 | 主题 | 核心缺口 | 状态 |
|---|---|---|---|
| **M35** | 创作流程自动化 | 项目 `settings.video` 可填越界值、轻松创作模式/画幅/时长需手选、`canvasAdvice` 未全站默认下一步建议；**含 M34 遗留 G7 自然语言→模板推荐（零成本路线）** | **已交付**（见上方 M35 能力速览）|
| **M36** | 运营配置自动化 | 平台预设/合规词/排期手工维护 | **已交付**（见上方 M36 能力速览）|
| **M37** | 收尾与回归 | 自动值来源不可追溯（用户看不到「为何是这个值」） | **已交付**（见上方 M37 能力速览）|
| **M38** | 扩展参数结构化与默认自动化 | AI 配置「扩展参数」仍是裸 JSON 天书框（用户不知能填啥/要填啥）；轻松创作音色假门禁逼手填 Tier A 已知项 | **已交付**（见上方 M38 能力速览）|
| **M39** | 扩展参数逐模型能力下沉 | M38 注册表粒度停在 provider 级，音色/尺寸实为模型级事实（36 音色 vs 4、max/plus 仅固定 5 档）；切模型表单不联动 | **已交付**（见上方 M39 能力速览）|

**保留人工红线（不自动化）**：付费执行确认、`secrets.json` 密钥录入、合规/法务放行、跨项目引用。**M32–M39 已全部交付，G1–G14 + G15（逐模型下沉）+ 收尾锁闭环**；遗留技术债候选：`probe-m26 split-audit` 要求的 11 个历史 >800 文件拆分（与本路线图表目无关，待另立专项）。
