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
