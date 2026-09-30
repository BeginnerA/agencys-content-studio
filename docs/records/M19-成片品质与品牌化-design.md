# M19 设计：成片品质与品牌化

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

> 里程碑：M19（2026-09-14 立项）｜上游：M11 转场/BGM 引擎（_compose 先例 · buildTransitionPlan · shiftSrtText）· M13 素材链（states 入库 / 批量润色 ≤10 先例 / 参考图上传）· M16–M18 画布（gen_tasks 无 run 任务先例 runCanvasTask）· M8 风格预设 · M5+ 适配层能力声明制
> 性质：**成片品质与品牌化**——三批 8 项一次开发：批 1 品牌化（字幕样式配置化 / 品牌水印 / 片头片尾）让成片可定制；批 2 声画（per-shot 音效 SFX / 成片多画幅双路径）让成片声画完整、一稿多端；批 3 生成链（素材页批量生成 / states 逐镜注入接线 / 声音克隆）把生成与素材链补全。
> 用户决策（2026-09-14）：①**品牌配置三层全要**——settings 表全局品牌（工作室品牌贯穿所有项目）+ projects.settings 项目级默认（水印图绑项目资产）+ run.input._compose 覆盖（换 run 不改项目默认）；②**多画幅 A+B 都要**——A（成片派生端点）为默认路径，B（合成内多路渲染）为可选能力，用户勾选「多画幅原生构图」才启用多路渲染；③**批量生成走异步任务队列**（gen_tasks 无 run + socket 进度推送，失败收集不阻断）；④**声音克隆全链 + 实测供应商**（音色库/克隆流程/能力位全建，对可用克隆供应商真实实测；不可得则登记降级交付架构）。
> 其余按勘察推荐默认：SFX 每镜 ≤1 条、镜起点触发、motion 路径同支持；片头尾不参与转场、SRT/配音轴平移 + 片头时长、片头尾音轨 v1 丢弃；states 纯文本注入（不改 states 存储结构）；批量生成提示词 = appearance + 项目风格拼接直连（不做 LLM 预润色）。
> 红线影响：**无破坏性行为变更**（全部超集扩展 + 分支开关改造）；+1 表（voice_clones，平台级通用）；+1 目录（workspace/brand/）；assets 表零列改动（SFX 走 purpose+params 先例）；settings/projects.settings +brand 键；新 purpose（sfx / final_video_derived）；compose 配置键扩展（brand / sfx_volume / multi_aspect）；**ffmpeg-merge 无新配置时 filter 链逐字节不变**（M7/M11 兼容纪律）；ai-image 无 states 时零 diff；resolveVoiceChain 旧签名兼容；零新依赖。

---

## §1 背景与目标

### 1.1 现状（勘察结论，2026-09-14）

| 批次 | 现状缺口 |
|---|---|
| 品牌化 | 字幕样式**硬编码**（`defaultSubtitleStyle(height)`：Noto Sans CJK SC / 白字 / 字号=高×1.8% / 描边=高×0.09%；仅有一条整串覆盖通道 `params.subtitle_style \|\| settings.video.subtitle_style`，改样式要么改代码要么手拼 ASS 串）；**水印 / 片头片尾全缺**（适配器 `watermark` 仅供应商侧生成开关，成片零品牌承载） |
| 声画 | **per-shot 音效 SFX 缺失**（M11 §1.3 排除项：BGM 有绑定通道而逐镜音效无存储、无混音链）；成片**只有单一画幅**（compose 输出 = 模板分辨率一路，一稿多比例分发无从谈起） |
| 生成链 | 素材页**批量生成未做**（M8 §1.3：批量润色 M13 已落 ≤10 串行先例，批量出参考图缺失）；角色 **states 变体已入库未接线**（M13 §1.3 排除项原文「出图按变体命中（如『第5场受伤』自动注入绷带描述）留后续批次」）；**声音克隆缺失**（声线六级链只能吃供应商枚举值，无克隆音色通道、无音色库） |

关键现成落点（全部已验证）：三层配置合并机制（run-params/context）；`_compose` 内部键 + 白名单 + requireEditableRun（compose-config）；BGM 绑定（软删+sha256 复用+上传/资产双形态）是 SFX/品牌物料直通先例；`buildTransitionPlan`（offsets o_k = Σ_{j≤k} d_j）与 `shiftSrtText`（SRT 平移）是片头位移/SFX 起点的数学基座；`runCanvasTask`（acquireSlot/重试/failTask/事件）是批量生成执行器模板；`injectCharacterAnchors` 注入链 + shot 结构含 `scene`（场次号，storyboard-ep v7）是 states 命中接线点；`resolveVoiceChain` 六级链 + `synthSpeech` 派发是声音克隆接线点。

### 1.2 目标

1. **品牌化**：字幕样式结构化三层可配（平台品牌 / 项目默认 / run 覆盖；字段：字体/字号%/主色/描边色/描边%/阴影/边距%/对齐），旧整串通道保留且**无配置 = 现行为逐字不变**；图片水印（九宫格/透明度/尺寸%/边距，三层来源）；片头片尾拼接（时长/字幕/配音/BGM 语义显式）。
2. **声画**：per-shot 音效绑定（工作台入口 + 上传通道）+ 合成期逐镜起点混音（无绑定 = 现行为）；多画幅双路径——A 派生端点（默认，对成片二次裁剪出 9:16/1:1/4:5）、B 合成内多路原生渲染（可选勾选）。
3. **生成链**：素材页批量生成参考图（异步任务队列 + 成功后自动挂接实体 + 用量记账）；states 逐镜命中注入出图提示词（场次/集/文本三级匹配）；声音克隆全链（平台音色库 + 克隆流程 + 声线链 `clone:` 引用 + 能力位 + 供应商实测/降级）。

---

## §2 范围

### 2.1 数据模型与三层品牌配置

**新表 `voice_clones`（平台级通用；schema.ts + db/index.ts ensureTable 幂等）**：

```ts
id / name(text, unique)        // 音色名（用户可读；voice 引用为 clone:{id}）
providerKey(text)              // 克隆供应商（aliyun_qwen_tts / volcengine_audio…）
model(text)                    // 克隆目标模型（如 cosyvoice-v1；合成时须同模型使用）
voiceId(text)                  // 供应商返回的克隆 voice 标识
status(text, 默认 'ready')     // v1 同步克隆仅落成功行（ready）；status 预留异步协议
meta(text JSON)               // 协议/参数留痕（如 { protocol:'dashscope-enrollment', prefix }）
createdAt / updatedAt
```

**品牌配置三层模型（BrandConfig，字段级合并，后者覆盖前者）**：

```ts
BrandConfig {
  subtitle?: SubtitleStyleConfig   // 见下
  watermark?: { enabled?: boolean; file?: string; asset_id?: number
                position?: 'tl'|'tc'|'tr'|'ml'|'mc'|'mr'|'bl'|'bc'|'br'   // 九宫格
                opacity?: number; width_pct?: number; margin_px?: number }
  intro?:  { enabled?: boolean; file?: string; asset_id?: number }
  outro?:  { enabled?: boolean; file?: string; asset_id?: number }
}
SubtitleStyleConfig {
  font?: string          // FontName（默认 'Noto Sans CJK SC'）
  size_pct?: number      // FontSize = round(H × size_pct)（默认 0.018；clamp 0.008–0.06）
  color?: string         // '#RRGGBB' → ASS &H00BBGGRR（默认 #FFFFFF）
  outline_color?: string // 默认 #000000
  outline_pct?: number   // Outline = max(1, round(H × pct))（默认 0.0009；clamp 0–0.005）
  shadow?: number        // Shadow（默认 0；clamp 0–8）
  margin_v_pct?: number  // MarginV = round(H × pct)（默认 0.02；clamp 0–0.1）
  alignment?: 2 | 5 | 8  // ASS 对齐（2 底部 / 8 顶部 / 5 中间）
  bold?: boolean         // Bold=1/0（默认不加）
}
```

- **三层落点**：平台 = `settings` 表 key `brand`（workspace/brand/ 文件经 `file` 键引用）；项目 = `projects.settings.brand`（用 `asset_id` 绑项目资产）；run = `run.input._compose.brand`（字段级覆盖，含 enabled/参数/可选 asset_id）。
- **来源解析**：`asset_id`（校验存在/属项目）→ `file`（`BRAND_DIR` 校验存在）→ 无（视为禁用）；`enabled === false` 强制禁用；文件缺失宽容降级（跳过 + log，不阻断合成）。
- **新服务 `services/brand-config.ts`**：`readPlatformBrand()`（db settings KV）/ `mergeBrand(platform, project, compose)`（纯函数，字段级浅合并，探针直测）/ `resolveBrandConfig(projectId, runInput)`（ffmpeg-merge 消费：解析合并 + 来源路径 + intro/outro 时长探测）。镜像 compose-config 先例；**ffmpeg-merge 经由该服务读取**（不改 ctx.settings 构造，零侵入）。
- **新目录**：`env.ts` + `BRAND_DIR = join(WORKSPACE_DIR, 'brand')`（镜像 PROJECTS_DIR 定义）；`ensureBrandDir()` 幂等。
- **新 purpose 登记**（storage.ts purposeSubDir）：`'sfx' → 'audio'`、`'final_video_derived' → 'video'`；assets.purpose 注释同步更新。
- **compose 配置键扩展**（compose-config.ts）：`ComposeConfig + { brand?: BrandConfig; sfx_volume?: number; multi_aspect?: { enabled: boolean; aspects: string[]; strategy?: 'crop' | 'pad' } }`；`updateComposeConfig` 白名单分支——brand（对象深校验：subtitle 字段类型/clamp、watermark 枚举/clamp、intro/outro 布尔与 id）、sfx_volume（数字 clamp 0–2）、multi_aspect（enabled 布尔、aspects 枚举去重 1–3 且排除主画幅、strategy 枚举）。
- **事件扩展**（events.ts StudioEvent 联合）：`{ type: 'entity.ref_gen'; projectId: number; taskId: number; entityId: number; status: string; error?: string }`（批量生成本地实时推送）。

### 2.2 批 1 · 品牌化（3 项）

**① 字幕样式配置化（快赢）**

- **组装纯函数 `buildSubtitleStyle(height, cfg)`（导出探针直测）**：基线 = 现公式值（FontSize/MarginV/Outline/PrimaryColour/OutlineColour/BorderStyle/Shadow/FontName 全同）；cfg 已定义字段逐项覆盖；color 经 `toAssColor('#RRGGBB') → '&H00BBGGRR'` 转换；输出字段序与 `defaultSubtitleStyle` 完全一致 → **`buildSubtitleStyle(H, {})` 与 `defaultSubtitleStyle(H)` 逐字相等（零漂移红线断言）**。font 值过滤 `' "` 引号字符。
- **ffmpeg-merge 采用链（分支开关改造）**：
  1. `brand.subtitle`（resolveBrandConfig 三层合并结果）非空 → `style = buildSubtitleStyle(height, merged)`（**结构化接管**；若旧串同时存在 → log「结构化字幕配置已接管，subtitle_style 旧串被忽略」）；
  2. 否则**旧链逐字节不变**：`params.subtitle_style || vidCfg.subtitle_style || defaultSubtitleStyle(height)` + `.replace(/['"]/g, '')`。
- 无任何配置 → 现行为逐字不变（探针快照基线）。
- Web：合成设置弹窗「字幕样式」区（启用开关 + 8 字段表单 + 色板）；项目/平台品牌区同构（复用同一表单组件）。

**② 品牌水印（快赢）**

- **来源**：品牌三层（平台 file / 项目 asset_id / run 覆盖）。
- **平台资产端点（挂 system.ts）**：
  - `POST /settings/brand/assets/:slot`（slot ∈ `watermark|intro|outro`；multipart file）——kindByExt 校验（watermark 须 image / intro|outro 须 video）→ 落 `BRAND_DIR/{slot}-{ts}-{sanitizeName}` → 更新 `settings.brand[slot+'_file']` → 响应 `{ brand }`；≤200MB（对齐 BGM 上限）。
  - `GET /settings/brand/assets/:slot` —— 流式回传当前文件（mime by ext；无 → 404）。
  - `DELETE /settings/brand/assets/:slot` —— 清 `*_file` 键（文件保留磁盘，不物理删）。
- **项目级**：`projects.settings.brand.watermark.asset_id`（前端项目品牌区从项目图片资产选择/上传，走既有上传通道）；**run 级**：`_compose.brand.watermark`（enabled/position/opacity/width_pct/margin_px 覆盖 + 可选 asset_id）。
- **合成链（ffmpeg-merge）**：启用条件 = 来源路径可解析且 enabled !== false；输入 `-i watermark`（索引紧随 BGM 之后）；滤镜 `[wmIdx:v]scale={round(W×width_pct)}:-1,format=rgba,colorchannelmixer=aa={opacity}[wm]` → **应用在字幕之后（水印最顶层）**：`[basev]subtitles…[vsub]`（有字幕时）→ `[vsub][wm]overlay={x}:{y}[outv]`；九宫格 x/y 表达式（margin：tl=`{m}` / tc=`(W-w)/2` / tr=`W-w-{m}`，y 同理）；clamp：opacity 0.05–1（默认 0.9）、width_pct 0.03–0.5（默认 0.15）、margin_px 0–200（默认 24）。
- **无配置零 diff**：watermark 未解析 → filter 链/输入/args 与现状逐字节一致。
- Web：Settings 品牌 tab（上传/参数/预览）+ 项目品牌区 + 弹窗 run 级覆盖（显示继承值与来源）。

**③ 片头片尾**

- 来源同品牌三层（intro/outro 的 file/asset_id）；`enabled !== false` 且来源可解析才启用；时长 ffprobe（`probeMediaDuration`，失败 → 跳过 + log）。
- **视频链**：`[i:v]scale=W:H:force_original_aspect_ratio=increase,crop=W:H,setsar=1,fps={fps},format=yuv420p[vintro]/[voutro]` → 主链产出 [basev] 后：`[vintro][basev][voutro]concat=n=3:v=1:a=0[basev2]`（仅存在侧参与；**不参与转场**——转场仍只作用于正片 images 段）。
- **音频语义（v1）**：片头尾音轨**丢弃**；主配音链 concat 后 `adelay={introMs}|{introMs}`（整体后移片头时长）→ `apad=whole_dur={totalAll}`；BGM `atrim=0:{totalAll}`（覆盖全片含片头尾）；无配音有 BGM 时同现有 `[bgm]anull` 路径延展为全片；SFX 起点叠加 `+introSec` 偏移。
- **SRT 平移**：全 cue `+introSec`（与 M11 对齐平移**合并为一次** shifts 变换：`shifts.map(d => d + introSec)`，复用临时副本机制；日志含「片头位移 +Xs」）。
- **总时长** `totalAll = introDur + Σd + outroDur`；溯源 `params.intro/outro = { source, duration }`；**cover 抽取点** = `introDur + 0.2`（有片头时；避免封面落在片头帧）。
- 无配置 → 全链逐字节不变。

### 2.3 批 2 · 声画（2 项）

**④ per-shot 音效 SFX**

- **存储（镜像 BGM 先例）**：assets 行 `{ projectId, runId, kind:'audio', purpose:'sfx', params:{ shotId, source:'upload'|'asset', original_name?, source_asset_id? }, deletedAt }`；**每镜 ≤1 条有效**（绑定即软删同 run 同 shotId 旧行）；sha256 命中复用（复制行不污染源资产）；所有操作不触发执行。
- **服务（compose-config.ts 扩展）**：`loadSfxAssets(runId)`（→ Map<shotId, Asset>）/ `bindSfxFromUpload(runId, shotId, file)` / `bindSfxFromAsset(runId, shotId, assetId)` / `removeSfx(runId, shotId)`；shotId 非空字符串校验；文件须 audio。
- **端点（对齐 BGM 形态）**：`GET /runs/:id/compose/sfx`（`{ items: [{ shotId, asset }] }`）；`POST /runs/:id/compose/sfx`（multipart `file + shot_id` 字段 | JSON `{ shot_id, asset_id }`）；`DELETE /runs/:id/compose/sfx/:shotId`。
- **合成链**：`loadSfxAssets` → 每镜起点 = `Σ_{j<i} d_j`（**转场与无转场同口径**：转场时即 xfade offset 时刻，buildTransitionPlan offsets 同源）→ 逐条 `[n:a]aresample=44100,aformat=…,volume={sfx_volume},adelay={startMs}|{startMs}[sfxk]` → 并入 [aout]：
  - 有主音轨/BGM：`amix=inputs=1+k:duration=first:normalize=0`；
  - 无配音无 BGM 仅 SFX：SFX 组 `amix` + `apad=whole_dur={total}`；
  - 无配音有 BGM：`[bgm]` 与 SFX 组 amix。
  - `_compose.sfx_volume`（默认 1；clamp 0–2）；**v1 不裁剪**（SFX 超镜长自然溢出，§8 记录）。
- readiness：绑定的资产文件缺失 → 跳过该条 + log（宽容）。
- Web：工作台镜头卡片「音效」按钮（弹窗：上传/项目音频资产选择/移除，显示当前绑定）；合成设置弹窗显示 SFX 条数 + 全局音量。
- 无绑定 → 音频链逐字节不变。

**⑤ 成片多画幅（A 派生端点 + B 合成内多路，双路径）**

- **尺寸纯函数 `resolveAspectSize(srcW, srcH, aspect)`**（导出）：`w = round(srcH × aw/ah), h = srcH`；`w > srcW` 时反转 `w = srcW, h = round(srcW × ah/aw)`（保证不放大）；结果偶数化（libx264 yuv420p 要求）。
- **A · 派生端点 `POST /runs/:id/derive-aspect { aspect, strategy? }`**（默认路径）：
  - aspect ∈ `['9:16','1:1','4:5','16:9']`；strategy ∈ `crop`（默认）|`pad`。
  - 源 = 该 run 最新 `final_video`（无 → 400「尚未合成成片」）。
  - crop：`-vf crop=w:h:(iw-w)/2:(ih-h)/2`；pad：`-vf scale=w:h:force_original_aspect_ratio=decrease,pad=w:h:(ow-iw)/2:(oh-ih)/2:color=black`；`-c:a copy` + libx264 crf20 同参数。
  - 落资产 `purpose='final_video_derived'`（name `ep{N}-final-{slug}-{ts}.mp4`，slug 如 `9x16`；params `{ source_asset_id, aspect, strategy, source:'derived' }`；width/height/duration；tags `['derived', slug]`）。
  - **幂等复用**：同 run + aspect + strategy + source_asset_id 已存在 → 直接返回 `{ asset, reused: true }`（不发 ffmpeg）。
- **B · 合成内多路原生渲染（可选勾选「多画幅原生构图」）**：
  - 配置 `_compose.multi_aspect { enabled, aspects[1–3], strategy }`；**未启用 → 现行为逐字节不变**。
  - 合成链：`[basev]split={1+k}[bm][b1]…[bk]` → 主路照旧（字幕/水印 → [outv]）；派生路各自 `crop/pad（resolveAspectSize 同源）→ 字幕（结构化配置时按该路高度重算 buildSubtitleStyle；整串模式复用主串）→ 水印 overlay（同一 [wm] 分流，表达式自适应各链 W/H）→ [outv_k]`；音频 [aout] 单链多输出复用。
  - 输出段：主输出照旧 + 每派生一路独立 `-map [outv_k] -map [aout]` + 同编码参数；落资产——主 `final_video` 照旧，派生 `final_video_derived`（params `{ native: true, aspect, strategy, source:'multi_render' }`）。
  - 日志：`多画幅原生渲染：主 {主ratio} + 派生 {列表}（编码 ×{1+k}，耗时相应增加）`。
- Web：成片卡片「派生画幅」（A：画幅 + 策略选择 → 生成 → 新产物出现/复用提示）；合成设置弹窗多画幅区（勾选开关 + 画幅多选 + 策略）。

### 2.4 批 3 · 生成链（3 项）

**⑥ 素材页批量生成（参考图批量出图）**

- **端点（对齐 M13 批量润色交互模式）**：
  - `POST /entities/ref-gen { projectId, entityIds, variants? }`——≤10 实体、实体须属该项目、须有 appearance（缺 → 400 列出）；variants 1–4（默认 1）；每实体 × variants 建 gen_tasks（`runId/stepId/canvasNodeId 均 null`，kind `'image'`，params `{ entity_id, variant_index, source:'entity_ref_gen', size, refs_planned }`）→ `void runEntityRefTask(id)` fire-and-forget → `{ tasks: [{ id, entityId }], count }`。
  - `GET /entities/ref-gen/tasks?project_id=N`——最近任务列表（进行中 + 近 20 条终态；供素材页进度初始化）。
  - `POST /entities/ref-gen/tasks/:id/cancel`——pending/processing → cancelled（镜像任务取消语义）。
- **执行器 `services/entity-refgen.ts`**（镜像 runCanvasTask：acquireSlot 信号量 / MAX_ATTEMPTS 重试 / failTask / 事件）：
  - 提示词纯函数 `composeEntityRefPrompt(entity, styleSnippets)`（导出探针直测）：`[appearance, 风格词块拼接, '必须剔除：'+negative]` 逐段 join（**拼接直连，不做 LLM 预润色**）。
  - 参考图：实体现有 `refAssetIds`（≤4）转 data URI 注入（供应商能力支持时；能力位判定镜像 ai-image 的 `imageRefCapability`）。
  - 完成：`saveGeneratedMedia` → `registerAsset`（purpose 按 kind：character→`reference_character` / scene→`reference_scene` / prop→`reference_prop`；params `{ source:'entity_ref_gen', entity_id, task_id }`）→ **自动挂接**：`characters.ref_asset_ids` 并集去重追加 → 发 `entity.ref_gen` 事件。
  - 用量：`recordUsage(kind:'image', unit:'image', quantity:1)`。
  - provider/model/size：项目 settings.image 配置链解析（`resolveEndpoint('image', …)` 复用；未配置 → 任务即失败入列 + 引导 Settings）。
- Web：素材页多选 →「生成参考图」按钮 → 弹窗（variants 选择 +「将生成 N 张」预估）→ 发起 → 页内进度条（processing/succeeded/failed 计数，socket 驱动）+ 完成 notice（成功 x / 失败 y）→ 列表刷新；失败任务行可重试（清 errorMsg 重排队——镜像画布重试语义）。

**⑦ states 逐镜注入接线（纯文本注入，不改 states 存储结构）**

- **匹配纯函数（导出探针直测）**：
  - `parseStateEntry(s)` → `{ node, phrase }`（首个「：」/「:」分割；无分隔 node=全串 phrase=''）。
  - `matchStateEntry(entry, { scene?, episode?, text })`：
    1. node 含「第N场/第N场次」（阿拉伯或中文数字一至二十）→ 与 shot.scene 数值相等判命中（scene 缺失 → 不命中，不做文本兜底）；
    2. 否则 node 含「第N集」→ 与 run episode_number 相等判命中；
    3. 否则（无定位词）→ node 串包含于 text（shot.id + location + image_prompt 拼接）判命中。
  - `injectStateAnchors(shots, charIndex, episode)`：逐镜逐角色取命中条目（**多条命中取 states 数组最后一条**——数组序即时间序，后覆盖前）→ 追加 `状态锚定（{角色名}·{节点}）：{状态短语}` 到 image_prompt；返回 `{ shots, injected, details }` + 日志明细。
- **ai-image 集成**：ShotSpec + `scene?: number` 字段声明；注入链 = 角色锚定 → **状态锚定** → 场景/道具 → 风格；episode 取 `run.input.episode_number`（缺失 → undefined 降级）。
- **无 states → 零 diff**（函数原样返回）。
- `workspace/prompts/char-profile.md` 微调（规则 8 补格式指引：剧情节点优先用「第N场/第N集」定位词以便逐镜命中；不改变输出 schema 与既有示例）。

**⑧ 声音克隆（全链 + 实测供应商）**

- **表**：voice_clones（见 2.1）。
- **服务 `services/tts-clone.ts`**：
  - `VOICE_CLONE_PROVIDERS`（**能力唯一事实源**）：`aliyun_qwen_tts → { protocol:'dashscope-enrollment', defaultTargetModel:'cosyvoice-v1' }`；volcengine_audio 视实测若协议可达则登记、否则不在白名单（= 不支持）。
  - `cloneCapabilityOf(providerKey): boolean`。
  - `createVoiceClone(providerKey, { name, sample, mime, targetModel? })`：`resolveAudioEndpoint` 拿凭证 → dashscope 协议：`POST {baseUrl}/api/v1/services/audio/tts/customization`，body `{ model:'voice-enrollment', input:{ action:'create_voice', target_model, prefix:<sanitize(name)>, url:<data URI> }, parameters:{} }` → 解析 `output.voice_id`；非 2xx → 报错含详情；样本硬校验（≤10MB、wav/mp3，时长软警告）。
- **端点（新路由 `routes/voice-clones.ts`，app.ts 挂载）**：
  - `GET /voice-clones` → `{ items, providers: [{ key, name, available }] }`（能力位矩阵）。
  - `POST /voice-clones`（multipart：name/provider/file[/target_model]）→ 克隆成功落行 → 201 `{ clone }`；失败不落行（400/502 带供应商详情）。
  - `DELETE /voice-clones/:id`；`POST /voice-clones/:id/test { text }`（≤200 字）→ 合成返回 audio/mpeg 流（不落资产）。
- **声线链接线**：voice 值语法 `clone:{id}`；`resolveVoiceChain` 扩展可选参数 `cloneIndex?: Map<number, VoiceCloneRow>`——各级判定从 `isProviderVoice(v)` 扩为 `isProviderVoice(v) || validCloneRef(v, cloneIndex)`（**旧调用签名兼容**，探针旧断言不变）；命中 clone → tts action 用 `resolveAudioEndpoint(clone.providerKey)` 换端点、`voice = clone.voiceId`、`model = clone.model`；无效 clone 引用（不存在/查询失败）→ 跳过该级继续降级 + log。
- **溯源**：asset.params + `{ voiceSource:'clone', clone_id, clone_name }`（voiceSource 枚举注释扩展）。
- Web：Settings → 音色库 tab（列表：名称/供应商/voice_id/试听/删除；新建表单：名称/供应商下拉（available 才可选）/样本上传/试听）；角色编辑表单 voice 字段旁「选克隆音色」下拉（选中填 `clone:{id}`，可清除）。
- **实测**：配置 aliyun 凭证真实跑「克隆 → clone: 引用合成」；不可得（无凭证/协议不通）→ 能力位置灰 + review 登记降级交付（架构与端点全链已交付）。

### 2.5 端点一览（M19 新增 14 枚；既有端点全超集兼容）

| # | 方法 | 路径 | 批次 |
|---|---|---|---|
| 1 | POST | `/settings/brand/assets/:slot`（品牌资产上传） | 品牌化 |
| 2 | GET | `/settings/brand/assets/:slot`（品牌资产预览） | 品牌化 |
| 3 | DELETE | `/settings/brand/assets/:slot`（品牌资产清除） | 品牌化 |
| 4 | GET | `/runs/:id/compose/sfx`（SFX 列表） | 声画 |
| 5 | POST | `/runs/:id/compose/sfx`（绑定：upload/asset 双形态） | 声画 |
| 6 | DELETE | `/runs/:id/compose/sfx/:shotId`（移除） | 声画 |
| 7 | POST | `/runs/:id/derive-aspect`（A 派生） | 声画 |
| 8 | POST | `/entities/ref-gen`（批量生成发起） | 生成链 |
| 9 | GET | `/entities/ref-gen/tasks`（任务列表） | 生成链 |
| 10 | POST | `/entities/ref-gen/tasks/:id/cancel`（取消） | 生成链 |
| 11 | GET | `/voice-clones`（音色库 + 能力位） | 生成链 |
| 12 | POST | `/voice-clones`（克隆） | 生成链 |
| 13 | DELETE | `/voice-clones/:id` | 生成链 |
| 14 | POST | `/voice-clones/:id/test`（试听） | 生成链 |

超集扩展：`PUT /runs/:id/compose/config`（+brand/sfx_volume/multi_aspect 键）；`PUT /settings/:key`（brand 键，端点既有）；`PATCH /projects/:id`（brand，端点既有）。

### 2.6 探针（`scripts/probe-m19.ts`，分 8 节）

| 节 | 覆盖 |
|---|---|
| subtitle-style | buildSubtitleStyle 矩阵（空配置零漂移逐字对拍 / 各字段覆盖 / clamp / alignment / 引号过滤）+ toAssColor + mergeBrand 三层优先级 + compose 新键白名单校验（非法字段族） |
| brand-watermark | 品牌上传端点全链（slot 校验/kind 校验/落盘/settings 更新/预览/清除/404 族）+ resolveBrandConfig 三层来源（file/asset/enabled 覆盖/缺失降级）+ 水印链 args 快照（**无配置零 diff** / 启用 / 9 宫格 × clamp / 与字幕叠加顺序）+ 真实合成冒烟 |
| intro-outro | 链快照（无配置零 diff / intro / intro+outro / 叠加转场+BGM+字幕）+ SRT 平移断言（+introSec 与对齐平移合并）+ 音频 adelay/apad 快照 + cover 抽取点 + ffprobe 时长断言（intro+Σd+outro）+ 文件缺失降级 |
| sfx | 绑定 CRUD（upload/asset/替换/移除/requireEditableRun 族/每镜 1 条约束）+ 起点纯函数矩阵（无转场/有转场 offsets 同口径）+ 混音链快照（配音×BGM×SFX 全组合）+ 文件缺失跳过 + 真实合成 |
| aspect | resolveAspectSize 矩阵（横→竖/方、反转分支、偶数化）+ crop/pad args 快照 + derive 端点全链（真实 ffprobe 尺寸断言 + 幂等复用 + 错误族）+ B 多路 args 快照（**未启用零 diff**）+ 真实多输出合成 |
| ref-gen | 端点校验（实体数/项目/缺 appearance）+ 任务行形态（无 run）+ 执行器 stub（fetch mock 成功/失败/重试/取消）+ 自动挂接断言（ref_asset_ids 并集去重）+ usage 落库 + entity.ref_gen 事件 |
| states | parseStateEntry/matchStateEntry 矩阵（场/集/文本/中文数字/scene 缺失降级/无定位词）+ 多条取最后 + injectStateAnchors 快照 + **无 states 零 diff** + ai-image 集成（任务 prompt 含状态锚定） |
| voice-clone | cloneCapabilityOf 矩阵 + createVoiceClone stub（dashscope 协议 body 快照/错误族/样本校验）+ 端点 CRUD + resolveVoiceChain 扩展（旧签名断言不变 / clone 命中 / 无效降级）+ clone: 引用合成链（端点切换/模型联动） |

回归：probe-m1~m18 全绿（**probe-m11 合成链快照零适配为优先目标**——无配置路径逐字节不变设计；如遇断言破坏按先例最小适配并留痕）。实测节：aliyun 克隆真实调用（凭证可得时；不可得走降级登记）。

---

## §3 红线复核

| 红线 | 结论 |
|---|---|
| 破坏性行为变更 | **无**——全部新增端点/超集字段/新增表；compose 配置键为白名单扩展（旧键语义零变）；ffmpeg-merge 分支开关（无新配置 filter 链逐字节不变，M7/M11 先例） |
| 既有端点兼容 | run 合成链（M11）、素材链（M8/M13）、实体端点、生成主链全部超集；ai-image 无 states 零 diff；tts resolveVoiceChain 旧签名兼容 |
| 生成主链 / 画布 | 零 diff（画布不触碰；ai-image 仅追加状态注入段；gen_tasks 复用其无 run 先例，列零改动） |
| 旧探针兼容 | probe-m11 合成快照预期零适配；probe-m13/m16/m17/m18 零适配；适配必留痕（M18 先例） |
| 不新增体裁专属表 | voice_clones 为平台级通用表（音色库，对齐 style_presets / series 先例）；品牌配置走既有 settings 机制，零新配置表 |
| 零新依赖 | 无新包（ffmpeg/ffprobe 既有；克隆走 fetch） |
| 数据安全 | 克隆凭证走实例配置（voice_clones 不存密钥）；品牌文件本地目录；SFX/品牌操作不触发执行（「重新合成后生效」提示）；批量生成有上限（≤10×4）+ 取消 + 用量对账 |

---

## §4 数据与接口变更清单

**Server 新文件**：`services/brand-config.ts`（三层品牌合并 + 来源解析）；`services/entity-refgen.ts`（批量生成执行器 + 提示词组装）；`services/tts-clone.ts`（克隆能力位 + 派发）；`routes/voice-clones.ts`；`scripts/probe-m19.ts`。

**Server 改动**：
- `env.ts`（+BRAND_DIR）；`db/schema.ts`（+voice_clones）；`db/index.ts`（ensureTable ×1）
- `services/storage.ts`（purposeSubDir +sfx/+final_video_derived；品牌目录辅助）
- `services/compose-config.ts`（ComposeConfig +brand/sfx_volume/multi_aspect；白名单分支；SFX 四函数）
- `services/tts.ts`（clone 相关导出衔接）；`services/events.ts`（+entity.ref_gen）
- `pipeline/actions/ffmpeg-merge.ts`（字幕样式组装 / 水印 overlay / 片头尾拼接+SRT 平移 / SFX 混音 / 多画幅分流，全部分支开关）
- `pipeline/actions/ai-image.ts`（ShotSpec.scene + states 注入段）
- `pipeline/actions/tts.ts`（clone: 引用解析 + 溯源字段）
- `routes/compose.ts`（+3 SFX 端点 + derive-aspect）；`routes/system.ts`（+3 品牌资产端点）；`routes/characters.ts`（+3 ref-gen 端点）；`app.ts`（挂 voice-clones）
- `workspace/prompts/char-profile.md`（规则 8 格式指引微调）

**Web 新文件**：`components/ComposeSettingsModal.vue`（由 BgmModal 升级扩展：BGM 区保留 + 字幕/水印/片头尾/SFX/多画幅区）；`components/BrandSettings.vue`（平台品牌 tab / 项目品牌区 / 弹窗覆盖区复用同一表单）；`components/VoiceLibrary.vue`（音色库 tab）。

**Web 改动**：`lib/api.ts`（+14 API）；`lib/types.ts`（类型超集）；`SettingsView.vue`（+品牌 tab +音色库 tab）；工作台视图（弹窗替换 + 镜头卡片音效按钮）；素材页（批量生成：多选动作 + 弹窗 + 进度条 + notice）；角色编辑器（克隆音色下拉）；成片卡片（派生画幅入口）。

---

## §5 验收标准

1. **探针**：probe-m19 八节全绿；probe-m1~m18 回归全绿（probe-m11 零适配优先，适配必留痕）。
2. **实弹**（真实浏览器 + 真实数据留痕）：字幕样式改色/字号/位置真实合成目检 + **默认白字零漂移对照**；水印三层（平台文件/项目资产/run 覆盖）真实合成目检；片头尾拼接（ffprobe 时长 = intro+Σd+outro、SRT 平移目检、BGM 覆盖全片）；每镜 SFX 绑定与真实混音；多画幅 A 三比例 ffprobe 断言 + B 勾选多路渲染目检；批量生成真实出图 + 自动挂接 + 用量对账；states 注入日志 + 真实出图目检（第5场示例）；声音克隆实测（阿里 CosyVoice；不可得降级留痕）+ `clone:` 引用真实配音。
3. **兼容**：无任何新配置时全链现行为逐字不变（探针快照为证）；M13 角色表单/批量润色、M11 合成设置无回归。
4. **文档**：README 更新（M19 能力 + 操作指引）；review 文档；spec 本文档。

---

## §6 风险与回滚

| 风险 | 缓解 |
|---|---|
| ffmpeg-merge 五处改造回归面大（字幕/水印/片头尾/SFX/多画幅叠加） | 全部「未配置分支」逐字节不变（先写分支骨架 + probe-m11 快照基线对拍）+ 逐组合 args 快照矩阵 + 真实合成冒烟（每批） |
| 片头尾与 SRT 双平移（对齐+片头）叠加出错 | shifts 合并单次变换 + 探针断言（含对齐非零场景）+ 数量不符回退原样（M11 宽容语义） |
| 多画幅 B 编码耗时 ×N / 磁盘激增 | 默认关闭（显式勾选）+ 日志提示 + A 路径幂等复用；每画布/run 产物可经素材删除回收 |
| 品牌文件路径（Windows 转义/空格） | 水印/片头尾输入用绝对路径 `-i`（无 filter 转义问题——subtitles 相对路径先例不受影响）；文件名 sanitizeName |
| voice clone 实测不可得（凭证/协议） | 降级架构已交付（能力位 false + UI 置灰 + 协议留痕）；review 登记 + 后续实测项 |
| 批量生成成本刷量 | ≤10 实体 × ≤4 变体/次 + 用量记账 + 取消端点 + 事件进度透明 |
| states 误命中（错注入） | 保守规则（定位词优先、无兜底）+ 命中明细日志 + 多条取最后（时间序覆盖）；误注入可在分镜中修正后重跑 |
| 收集：品牌/SFX 文件缺失、克隆供应商错误 | 全部宽容降级（跳过 + log 留痕，不阻断合成/主链） |

回滚：各批次独立可回滚（表/目录为幂等增量；ffmpeg-merge 分支可摘；端点纯新增；compose 键可忽略）。

---

## §7 实施计划

| 阶段 | 内容 | 产出 |
|---|---|---|
| P1 | 基建：BRAND_DIR + voice_clones 表/迁移 + purpose 登记 + events 扩展 + brand-config 纯函数 + probe-m19 骨架（8 节壳） | 迁移可跑、探针可执行 |
| P2 | 批 1 字幕样式：buildSubtitleStyle + compose 键 + ffmpeg-merge 分支 + UI 字幕区；探针 subtitle-style | 探针 1 节绿 |
| P3 | 批 1 水印 + 片头尾：品牌资产端点 + 品牌 UI（Settings/项目/弹窗）+ 水印链 + 片头尾链 + SRT 平移 + cover 抽取点；探针 brand-watermark + intro-outro | 探针 2 节绿 |
| P4 | 批 2 SFX：compose-config 扩展 + 3 端点 + 混音链 + 工作台 UI；探针 sfx | 探针绿 |
| P5 | 批 2 多画幅：resolveAspectSize + derive 端点 + B 多路渲染 + UI；探针 aspect | 探针绿 |
| P6 | 批 3 批量生成：entity-refgen + 3 端点 + 素材页 UI；探针 ref-gen | 探针绿 |
| P7 | 批 3 states：匹配/注入函数 + ai-image 集成 + char-profile 微调；探针 states | 探针绿 |
| P8 | 批 3 声音克隆：表/服务/4 端点/声线链/UI + 实测（或降级留痕）；探针 voice-clone | 探针绿 + 实测留痕 |
| P9 | 回归与收口：probe-m1~m18（适配留痕）+ 实弹验证 + README/review + 提交 | 全绿 + 文档 |

---

## §8 明确排除

| 排除项 | 去向 |
|---|---|
| 文字水印（drawtext 字体路径跨平台风险） | v1 仅图片水印（推荐生成 PNG）；后续候选 |
| SFX 每镜多条 / 截断与淡出 / per-binding 音量 | 后续候选（v1 每镜 1 条、不裁剪、全局音量） |
| 片头尾音轨保留与音频交叉淡化（v1 丢弃片头尾音轨） | 后续候选 |
| 水印时间区间（仅片尾显示等）/ 多水印叠加 / 动图水印 | 后续候选 |
| 声音克隆异步协议（火山 polling）/ 样本落盘与重克隆 | 后续候选（v1 同步协议 + 即传即用） |
| states 变体自动出参考图（states→出图→入库闭环） | 后续候选（v1 仅文本注入） |
| 多画幅 B 反转画幅（派生高 ≠ 主高）的逐路字幕样式重算 | v1 组合罕见（同高假设）；后续候选 |
| 派生端点自定义分辨率 / 码率 / 文件名模板 | 后续候选 |
| 字幕字体文件上传 / 安装引导（v1 系统字体 + FontName 字段） | 后续候选 |
| 多画幅 HLS / 流媒体切片打包 | 排除（本地成片定位） |
| 品牌配置版本历史 / 预览缩略图 | 后续候选 |
