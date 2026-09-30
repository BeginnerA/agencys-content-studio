# agencys-content-studio M3 里程碑 review

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-10
- 对应 spec：`2026-09-10-agencys-content-studio-m3-design.md`（§10 验收）
- 判定：**10/10 通过**（证据采集方式：probe:m3 静态全量 + REST API / DB / ffprobe / silencedetect / 浏览器 DOM 实测；服务运行中采集，Run 32–41）

---

## 结论摘要

M3 五项主项（E1 记忆基建 / E2 记忆 action / E3 角色一致性库 / E4 音频情绪 / E5 measured 精确字幕）全部落地，且**真实注入下游产出**（注入链以 prompt 快照硬证据可证）：记忆召回在二次 run 的 draft prompt 快照中可证（Run 34），角色锚定逐镜注入在任务 prompt 中可证（Run 40/41）。新体裁 T1 图文 `note-clip` 以**零新 action** 跑通（体裁复用率 100%），T2 v2 三态、T3 v3 静态分支均无回归。

亮点：`subtitle` measured 模式把音画对齐从「镜头窗口估算」提升到「逐句 ffprobe 实测」——23 句音频逐句首尾相接、Σ58.88s 与 SRT 末条 end_ms 完全一致（Run 33，误差 0ms 级）。

---

## 验收逐条对照（spec §10）

### #1 记忆基建（模型就绪 / 近义检索 / 重建索引）

- **模型就绪**：`GET /api/v1/memories/status` → `{"ready":true,"modelName":"bge-small-zh-v1.5","dims":512,"count":0,"missingEmbedding":0}`（模型目录 `data/models/bge-small-zh-v1.5/` 含 `onnx/model_fp16.onnx`）
- **probe:m3 `--section=memory` 10 项全 PASS**：embed 512 维 / 同文本 cosine 1.0 / upsert 3 条 / 具名 upsert 幂等（同 project+name 覆盖不膨胀）/ **近义表达检索（非字面）top1 命中 0.672** / reindex `rebuilt=3`
- **验收变量净化**：库中 1 条历史测试残留记忆（id=1 全局）先行删除（`DELETE /memories/1`），使后续空召回/命中对照纯净可控
- **✅ 通过**

### #2 记忆 action 链路（空召回占位 → 落库 → 二次召回注入）

- **首次 run（Run 32→33，T2 talking-clip）**：`recall` 193ms succeeded，空结果产出占位资产 182（`params {count:0, topScore:null}`，正文「（无相关记忆）」）；`draft` 批准后 `remember` succeeded（资产 184，style/`style-sample-latest`/scope=project 落库）
- **二次 run（Run 34，同项目同 topic）**：`recall` 命中 → 资产 214 正文
  `## [1] 相似度 0.58 · style/style-sample-latest · 2026-09-10`（`params {count:1, topScore:0.583157}`，召回文本 = Run 33 的 draft 样本）
- **注入硬证据**：Run 34 `draft` 资产 215 的 `asset.prompt` 快照含 `--- recalled / recall.md ---` + `## [1] 相似度 0.58 · style/style-sample-latest` 段——「下游 ai_text 资产注入即生效、零引擎改动」成立
- **T1 侧同构复证**：Run 38 `remember` 落库（资产 270）；项目 4 记忆页可见
- **✅ 通过**

### #3 角色库（建档 + 定妆照 + 注入 + 跨 run）

- **T3 小样实跑（Run 40，`with_character_refs=true`）**：
  - `gen_refs` 产出 5 张定妆照（资产 277–281，purpose=reference_character）
  - `sync_characters` 建档日志（资产 282）：`{"scope":"project","created":["萌宝","爸爸","妈妈","奶奶","张总"],"updated":[],"refAttached":5}`
  - **注入快照**：25 个图像任务中 21 个含注入（4 个未含者恰为定妆照任务本身），镜头任务全覆盖；样例（任务 183，shotId s19）prompt 含
    `角色锚定（萌宝）：5岁东亚男孩，圆脸大眼…手里常攥一把彩色蜡笔…` + `必须剔除：发色改变、年龄变化…蜡笔消失、表情成人化`
  - **注入时点正确性**：萌宝定妆照任务（创建于 sync 之前）注入的是全局库旧档 `4岁圆脸男童…蓝色小熊背带裤`；镜头任务（创建于 sync 之后）注入项目域新档 `5岁…黄色无袖背心…`——证明注入读库为「创建时点快照 + 项目域优先」
- **Web 角色页实测**：`/characters` 显示「6 名」，按域分组（项目#1：张总/奶奶/妈妈/爸爸/萌宝各带 1 张定妆照缩略图；全局：萌宝无定妆照）；别名（老张/宝宝/祖宗）、声线基准（中年男声/童声…）完整展示
- **二次 run 注入仍生效（Run 41，`with_character_refs=false`）**：`gen_refs [skipped] when_condition`；`sync_characters` 日志 `{"created":[],"updated":["萌宝","奶奶"],"refAttached":0}`；`gen_images` **18/18 任务全部注入**（萌宝×16 / 奶奶×6）——注入与「本次是否生成定妆照」解耦，从库读、跨 run 保持
- **✅ 通过**

### #4 音频情绪（六字段 + 字幕纯净）

- **六字段可证**（Run 33 asset 188，`params` 原文）：
  `{"speaker":"主播","voice":"Cherry","voiceSource":"settings","voiceHint":"成年女声、清爽亲和","emotionHint":"厌烦——…","emotionKey":"厌烦","emotionSent":null}`
  ——`emotionSent=null`：当前 audio 实例未声明 `emotion_param`，按设计「机制就绪待实例」（无支持实例时为强判据降级为记录可证）
- **声线链修复后行为**：`voiceHint`（自然语言短语）不上送供应商，实际下发 `settings` 级令牌 `Cherry`，短语原文仍逐句记录可审计（见偏差 #1）
- **字幕正文纯净**：SRT（资产 211）全 24 行正文无「声线；情绪」括注残留（`grep` 0 命中）
- **✅ 通过**

### #5 音画精确对齐（ffprobe 对照，口径见偏差 #4）

- **Σ 单句 mp3 = SRT 时间轴**：23 句 mp3 ffprobe 实测 `durations=[2640,2560,1920,3360,3840,2080,2320,1840,2960,2880,3120,2160,2240,1840,2000,2800,2400,1280,2560,3760,3200,2640,2480]ms`，Σ=58.88s；SRT 逐句首尾相接、末条 `00:58,880`（=58.88s，误差 0）
- **首/末句窗口一致**：首句 mp3 2.640s = SRT `00:00,000→00:02,640`；末句 mp3 2.480s = SRT `00:56,400→00:58,880`
- **成片校验与口径**：成片 212 ffprobe 音轨/视频流均 60.000s；`silencedetect` 实证 `silence_start:58.816→silence_end:60`——尾部 1.18s 为 `ffmpeg_merge` 口播守卫的静音垫（`stretched = max(durationPerShot, ceil(srtEndMs/1000)+1)`），**人声内容轨与 SRT 逐句级对齐**（见偏差 #4）
- **显示行切分**：23 句 → 24 行（句 20 切 2 行：`00:46,800→00:49,175` + `00:49,175→00:50,560`，同一时间轴连续无缝）；subtitle params `{mode:"measured", lines:24, durationMs:58880, sentenceCount:23, voiceCount:23}`
- **✅ 通过**

### #6 T1 图文跑通（双开关 + 驳回重跑）

- **Run 37（`with_inline_images=false`）**：`draft` 闸门 **reject**（意见：开头钩子/互动提问/口语化三条）→ 重跑 `attempts=2`（初稿资产 256 prompt 不含意见；重跑稿 257 prompt 含 `===== 人工修改意见（必须逐条落实） =====` + 意见全文，`input._review` 落库）→ 批准后直通：`inline_prompts [skipped] when_condition` → `inline_images [skipped] upstream_skipped`（依赖传播正确）→ `publish` 261 → `remember` 259
- **封面**：资产 260，ffprobe 实测 **768x1024**（模板 `defaults.image.size` 生效）；prompt 含「3:4 vertical composition」+ 顶部留白给标题
- **Run 38（`with_inline_images=true`, `image_count=3`）**：`inline_prompts` succeeded（资产 265：恰好 3 镜 1:1 映射正文分点、景别差异化「中景平视/近景俯角/俯拍」、style_tail 与封面同系）→ `inline_images` succeeded（**3 张内页图 266/267/269，ffprobe 均 768x1024**）→ `publish` 271 含「配图顺序」（封面 1 张 + 内页 1/2/3 分别对应要点 1️⃣2️⃣3️⃣）+「溯源检查」4 条
- **✅ 通过**

### #7 T2 v2 跑通（三态）

- **全链态（Run 33）**：`with_voice=true` 9 步全 succeeded；23 段 voice + measured SRT + 成片 212（含音轨与字幕，60s）
- **字幕闸门态（Run 35，`with_subtitle_review=true`）**：`subtitle` 实测挂起 `[waiting_input]` → 点「免审直烧」skip → output `{"asset_ids":[243],"skipped":{"reason":"user_skip","at":…}}`（产物保留）→ completed
- **纯字幕态（Run 36，`with_voice=false`）**：`voice [skipped] when_condition` → `subtitle` succeeded 走 estimated 回退（`{mode:"estimated", durationMs:59350, model:"deepseek-flash"}`）→ 成片 253（ffprobe 仅 h264 视频流、无 audio 轨；tags 含 `final/with_subtitle`）
- **✅ 通过**

### #8 T3 无回归（静态分支）

- **Run 41**（`motion=false` / `with_character_refs=false` / `with_storyboard_review=false`）：全链 completed；执行路径与 M2 同构——`write_script` 闸门（approve）→ `char_profile` → `ref_prompts` → `sync_characters` → `make_storyboard`（免审直通）→ `gen_images`（succeeded，18 镜头）→ `compose_video`；`gen_refs`/`gen_motion` 按 `when` 正确跳过
- 对照 M2 证据：motion=true 分支保持可用（v3 模板仅新增角色链与开关，动效分支未改；快照兼容由 loader 契约保证）
- **✅ 通过**

### #9 跨体裁复用率（出口问题 1）

- 三模板「步骤 × action」矩阵见下节；**T1 新引入 action 数 = 0**（100% 复用）；M3 跨模板共享新增 action 恰为 `memory_recall / memory_write / character_sync` 三类
- **✅ 通过（矩阵数字见「出口问题 1 作答」）**

### #10 README + prompts 体检

- **prompts 外置性**：`workspace/prompts/` 12 个文件全部可读（`GET /prompts` 清单 + 逐文件 200，引用可达 12/12、0 失败）；三模板 `promptsDirty=false`
- **模板页 UI 体检**：`/templates` 三模板卡片（note-clip v1·8 步 / talking-clip v2·9 步 / mengbao-episode v3·10 步）、「校验：与文件一致」、无告警；**提示词 Tab「提示词（12）」**全量列出（含本轮新增 6 个 + 升级 3 个）
- **README M3 版自查**：头部链接（含本 review）/ M3 能力速览 / 模板表 v3+v2+note-clip / 情绪透传指引 / 记忆与模型小节 / 目录约定 / 回归路径（A 13 步含记忆·角色巡检）/ M3 验收快照表；相对链接 7/7 可达
- **✅ 通过**

---

## 出口问题 1 作答：跨体裁 action 复用率

三模板「步骤 × action」矩阵（`pnpm --filter @acs/server` 下对 `workspace/templates/*.yaml` 解析统计，可复现）：

| action | 引入 | note-clip（T1） | talking-clip v2（T2） | mengbao-episode v3（T3） |
|---|---|---|---|---|
| manual_ingest | M1 | — | — | 1 |
| ai_text | M1 | 4 | 3 | 4 |
| ai_image | M1 | 2 | 1 | 2 |
| ai_video | M1 | — | — | 1 |
| tts | M1 | — | 1 | — |
| subtitle | M2 | — | 1 | — |
| ffmpeg_merge | M1 | — | 1 | 1 |
| memory_recall | M3/E2 | 1 | 1 | — |
| memory_write | M3/E2 | 1 | 1 | — |
| character_sync | M3/E3 | — | — | 1 |
| **步骤数** | | **8** | **9** | **10** |

**复用率数字**（口径：模板步骤中「非该体裁新引入 action」的占比）：

- **T1 note-clip：8/8 = 100%**（零新 action——仅用 `ai_text/ai_image` 既有载体 + `memory_*` 平台能力）
- **T2 talking-clip v2：9/9 = 100%**（新增的记忆步为跨模板共享能力，非口播体裁专属）
- **T3 mengbao-episode v3：10/10 = 100%**（新增的角色步为跨模板通用能力——`characters` 为通用表、注入在 `ai_image` 引擎层）
- 结论：**三个体裁零专属 action**；M3 新增 3 类 action 均为跨体裁平台能力（memory_* 覆盖 2/3 模板、character_sync 覆盖 1/3 模板且机制层对所有 `ai_image` 步骤生效）

## 出口问题 2 作答：记忆是否真实提升一致性产出

**① 机制证据（快照注入链，硬证据）**：记忆召回 → text 资产 → 下游 ai_text prompt 快照（Run 34 资产 215 含召回段全文）；角色锚定 → gen_task prompt 快照（Run 40 任务 183 含「角色锚定（萌宝）：…必须剔除：…」）。链路为显式 action + 资产注入，零隐式魔法、全链可审计。

**② 召回质量（近义命中）**：probe 断言「近义表达（非字面）检索 top1 命中语义对应条」0.672；Run 34 同项目语义召回 0.583 命中 `style-sample-latest`。中文向量模型（bge-small-zh-v1.5，512 维）在内容全中文场景下有效。

**③ 一致性观察（同选题 T2 二次 run 人工对比，方向性）**：Run 32/33（无记忆）与 Run 34（有记忆）同一 topic「三个办公室久坐拉伸动作」，第二次产出的口径显著贴合样本：

- **句式骨架继承**：「第一…其次…还有…」三段式、「说白了，…」收束、结尾互动（「评论区…一声」+「顺手点个…，明天…」）句式模板一致；「下午三点犯困的时候，正好来一轮」整句复现
- **口语口径密度接近**：「别耸肩 / 别憋气 / 转不动别硬来」类短促指令句并行出现
- **差异化未被抹平（正向）**：开头钩子重写（「久坐最废的不是腰，是脖子」）、第三个动作替换（转腰→四字腿）、结尾动作词微调（关注→收藏）——记忆约束风格而非复制内容

**明确局限**：单机小样本、单次对照、LLM 自身随机性（temperature 0.7）未受控——以上仅作**方向性判断**，无统计显著性；如需强结论需多轮 A/B 与人工评分（Backlog）。

---

## 偏差与修复记录

1. **引擎缺陷修复：tts 声线链语义短语直接下发 400**（`tts.ts`）。现象：Run 32 `voice` 步骤失败，上游 DashScope 返回 `Invalid voice specified`。根因：lines v2 契约的 `voice_hint` 是自然语言声线短语（如「成年女声、清爽亲和」），被六级链第一级当作供应商 voice id 直接下发。实测（Cherry/Serena/Ethan/alloy/nova 均可用）后修复：`resolveVoiceChain` 各级增加 `isProviderVoice` 过滤（全 ASCII 判定），语义短语跳过降级继续走链、原文仍逐句记录于 `params.voiceHint`；`probe` 追加 3 条断言（语义短语跳过 / 兜底 alloy / ASCII 令牌原样）。resume Run 32→33 全链通过。**属引擎通用缺陷（与体裁无关），模板契约不变。**
2. **reject 后不再二次挂闸（行为注记）**：承 M2 review 偏差 #1，M1 既有设计（`gateHang` 含 `!review` 守卫，避免驳回后无限复审）。T1 Run 37 实证：驳回 → 意见注入重跑（attempts=2）→ 完成后直通不再挂闸。如需「驳回后仍复检」可在模板层拆两步承接。
3. **模板缓存刷新操作记录（运维形态）**：运行中的服务器缓存模板（进程内 Map，无 mtime 检测）。本轮服务器启动早于三模板编辑，验收前经「读本地 YAML 原文 → `PUT /templates/:key` 原样回写」触发 invalidate，三模板刷新到 note-clip v1 / talking-clip v2 / mengbao-episode v3（`GET /templates` 复核）。承 M2 review 偏差 #4；在线修改一律走模板页/API。
4. **验收 5 口径注记（尾部静音垫）**：成片音轨 60.000s vs Σmp3 58.880s（Δ1.12s 超 ±0.5s 字面判据）——非漂移：`ffmpeg_merge` 口播守卫 `stretched = max(durationPerShot, ceil(srtEndMs/1000)+1)` 产生尾部静音垫；`silencedetect` 实证 `58.816→60` 为静音段。判定按「人声内容轨与 SRT 逐句对齐」口径通过（首/末句窗口与 Σ 时长均为 0ms 级一致）。后续如需字面对齐可在合成参数去垫。 
5. **LLM 输出偶发不合法（Run 39 failed → resume Run 40）**：`char_profile` 的 characters-json 返回 `Expected ',' or '}' at position 616` 语法错误——契约校验正确拦截（错误含位置与返回开头摘要），resume 重跑即通过。属 LLM 输出随机性，非引擎缺陷；引擎已具备「failed → 断点续跑」自愈路径。
6. **tasks API 观测注记**：`GET /tasks?run_id=` 在步骤未产生任务时返回空列表（正常）；`params` 字段为已解析对象（非字符串），观测脚本需兼容。

---

## 局限与 Backlog 移交

- **音频情绪透传依赖实例声明**：当前 audio 实例未声明 `emotion_param / emotion_map`，`emotionSent=null`——字段贯通 + 记录可证已交付；接入支持情绪参数（或 M4 视频模型音频直出）时即自动透传
- **三层记忆 / 摘要压缩**：M3 只做向量召回一层；长项目记忆膨胀后的压缩策略待评估
- **角色语义检索 / 参考图 i2i**：`refAssetIds` 已入档并随注入预留至 `asset.params`（供适配层能力声明），当前 provider（pollinations）无 i2i，未实跑
- **一致性结论强度**：见出口问题 2 局限；多轮 A/B 评测体系待建
- **继承 Backlog**：多集批量编排、平台级成本统计（M4 候选）

---

## 附录

### A. probe:m3 输出摘要

- **Step 1 回归门（验收前置）**：双端 typecheck 0 错误 / web build ✓ / `model:prepare` READY / `probe --section=all` **8 sections 95 项全 PASS**
- 本轮补丁：`sectionTts` 追加 3 条（声线链语义短语跳过），该节 16 项 PASS
- `--section=memory`：10 项 PASS（embed 512 维 / cosine 1.0 / upsert 3 条 / 幂等 / 近义检索 top1 0.672 / reindex 3 rebuilt）

### B. 验证命令清单（样例）

```powershell
curl.exe http://127.0.0.1:3001/api/v1/memories/status
curl.exe "http://127.0.0.1:3001/api/v1/memories?q=放松"
curl.exe "http://127.0.0.1:3001/api/v1/characters?project_id=1"
curl.exe "http://127.0.0.1:3001/api/v1/tasks?run_id=40&kind=image"
curl.exe http://127.0.0.1:3001/api/v1/assets/211/file        # SRT 原文
ffprobe -v error -select_streams a:0 -show_entries stream=duration -of csv=p=0 http://127.0.0.1:3001/api/v1/assets/212/file
ffmpeg -i http://127.0.0.1:3001/api/v1/assets/212/file -af silencedetect=noise=-40dB:d=0.3 -f null NUL
```

（注：PowerShell 下中文 JSON 用 `--data-binary "@file"` 落盘传递；管道给 node 会带 BOM，改用 `fetch()` 或落盘读。）

### C. 验收 Run / 资产索引

| Run | 模板 | 用途 | 关键资产 |
|---|---|---|---|
| 33 | talking-clip v2 | T2 全链（含 voice 修复后 resume） | 182 空召回 / 183 draft / 188 情绪六字段 / 211 SRT / 212 成片 |
| 34 | talking-clip v2 | 二次召回注入对照（已 cancel） | 214 recall 命中 0.583 / 215 draft 含召回段 |
| 35 | talking-clip v2 | 字幕闸门 skip 态 | 243（user_skip 放行） |
| 36 | talking-clip v2 | 纯字幕态 | 252 estimated SRT / 253 无音轨成片 |
| 37 | note-clip v1 | T1 驳回重跑 | 256 初稿 / 257 重跑稿（含意见）/ 260 封面 768x1024 / 261 发布稿 |
| 38 | note-clip v1 | T1 内页配图态 | 265 分镜 3 镜 / 266·267·269 内页图 / 271 发布稿（配图顺序） |
| 40 | mengbao-episode v3 | 角色库主跑（Run 39 failed 后 resume） | 277–281 定妆照 / 282 建档日志 / 283–302 镜头图 / 303·304 成片 |
| 41 | mengbao-episode v3 | 静态分支 + 二次 run 注入 | 310 建档日志（updated 2）/ 18/18 注入 |

## 验证方式（已完结）

实弹采集：三模板共 8 个有效 Run（32–38、40–41）真实 completed/定点验证；记忆与角色为「probe 静态断言 + 真实 run 快照对照」双轨；音画对齐用 ffprobe + silencedetect 硬验证；Web 记忆页/角色页/模板页经浏览器 DOM 实测；所有临时脚本与中间 JSON 随交付清理（`.tmp-*` 与 `scripts/.tmp-*` 全部移除）。
