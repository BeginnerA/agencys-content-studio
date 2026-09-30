# agencys-content-studio M2 里程碑 review

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-10（定稿 2026-09-10，实弹回填）
- 对应 spec：`2026-09-09-agencys-content-studio-m2-design.md`（§10 验收）
- 判定：**10/10 通过**（证据采集方式：API / DB 查询 / ffprobe + ffmpeg volumedetect / OCR 抽帧 / 浏览器 DOM 实测；服务运行中采集）

---

## 验收逐条对照

### #1 编排语义实弹（gate skip / when 互斥 / 并行与 skipped 呈现）

- **gate skip（user_skip）**：Run 26 `make_storyboard` output 原文
  `{"asset_ids":[143],"skipped":{"reason":"user_skip","note":"免审直接出图验收测试","at":1789016356584}}`
  ——产物保留、痕迹落库；Web 运行页实测 badge「免审放行：产物已保留，下游正常执行」
- **when 互斥选路**：`motion=true` Run 26（`gen_motion` succeeded、`gen_images` `[skipped]` 条件不满足）；`motion=false` Run 25（`gen_images` succeeded、`gen_motion` `[skipped]`）——两条路各 ≥1 次 completed ✓
- **Web 时间线呈现**：Run 26 页面 DOM 实测——「分镜与提示词包」带「免审放行」徽标、「批量镜头出图」灰显「已跳过 / 条件不满足（尝试 0）」、20 个视频任务明细（prompt 全文 + 「查看」产物链）；
  Run 18 并行段实测——「逐句配音」（第 5 步 09:49:54→09:49:59）与「封面出图」（第 6 步 09:49:54→09:50:00）**同刻启动**并衔接合成，全链 17.5s
- **✅ 通过**

### #2 快照隔离

- **运行中改模板不影响续跑**：Run 29 创建（模板 v1）→ 挂起 gate → 经 API PUT 模板（新增 `note` 步骤，缓存已刷新）→ 批准续跑 → 步骤集仍为 v1 的 7 步（无 `note`）——隔离成立
- **新 run 反映新模板**：Run 30 创建后步骤集含 `note` 步骤（`note:pending`，收尾 cancel）——即时生效
- **坏 YAML 不落盘**：`POST /templates/validate` 对坏 YAML 返回 `ok:false` 含行号；`PUT` 坏 YAML → 400 且原文件未变（`talking-clip.yaml` 无 diff）
- **存量兼容**：Run 8（M1 时代创建、无快照列）→ resume Run 25：回退当前模板文件续跑，补齐缺失步骤行（`gen_motion` 自动 `[skipped]`），M1 产物全部复用
- **✅ 通过**

### #3 模板在线管理

- **CRUD 全链路实测**：POST 新建 201（warnings 0）→ 同名再建 409 `template_exists` → GET 回读一致 → DELETE 200 + 回读 404；
  被引用模板 DELETE → 409 `template_in_use` 并列出项目名（`mengbao-episode` →「萌宝冒烟」「m2b6-验证-mengbao-v2静态」；`talking-clip` →「m2b6-验证-talking纯字幕」）；目录终态无残留
- **复制**=前端「另存为副本」走 POST 同机制（新建已覆盖）
- **prompts 管理**：GET 列表 6 文件；PUT 新建 / GET 回读一致 / DELETE；越界路径（`..%2F`）→ 400 `bad_path`；
  **引用体检**：probe 模板引用存在 prompt → `promptsDirty=false`；改引用缺失 → warnings 报「params.prompt_tpl 引用的提示词文件不存在: …」且 `promptsDirty=true`
- **保存后即时生效**：Run 30（同 #2）
- **✅ 通过**

### #4 ai_video 启用

- 真实出片：Run 21（10 段 shot_video，成片 50s）；Run 26（20 段 = 跨 run 复用 9 + 重跑 11，169.6s）
- 溯源：gen_task 含 prompt 全文快照 + `provider/model/params{shotId,duration,resolution,aspectRatio,episode}`；产物 `*-gen-mp4.mp4`；Web 任务面板可展开 prompt 与产物
- **中断恢复**：Run 22 运行中强杀（run error=interrupted）→ 重启 recover 归位 → resume Run 23 completed（20/20，仅重跑 9 个未完成，11 个成功产物复用）
- 存量：project 3 `shot_video` 资产累计 50 段（id 104..165）
- **✅ 通过**

### #5 配音字幕（回补 M1 #5）

- Run 18（T2）：7 步全 succeeded（17.5s）；`voice` 产出 11 项音频资产（每句 1 资产）
- 成片 #102 ffprobe：`h264 1920x1080 25fps 60.00s` + `aac 44100 Hz stereo`（音视频等长）
- **字幕烧录 OCR 抽帧实锤**：8s 帧识别出「嗓子干痒的时候，温热的水下去，黏膜立马舒服」；18s 帧「但记住一条铁律：别喝烫的」——与 SRT 台词一致
- 浏览器 Range：`GET /assets/102/file`（Range 0-1023）→ **206**
- **✅ 通过（M1 review 偏差 #1 关闭）**

### #6 三流合成

- #102 时长 60.00s 与台词窗口对齐（模板 `duration_per_shot:60` 单图成片）
- **音轨可听硬验证**：`ffmpeg volumedetect` → `mean_volume: -33.3 dB / max_volume: -4.1 dB`（非静音轨，人声内容真实存在）
- 对照 #166（T1 无配音模板）：仅视频流（无音轨），符合模板差异
- **✅ 通过**

### #7 恢复 / 重试（出口问题 2）

- **强杀 recover + resume 幂等**：Run 22 中断（20 任务在途）→ 重启 recover 无悬挂 processing → Run 23 仅重跑 9 个未完成（attempts 归零重排队），succeeded 全部复用
- **ai_video 第三方轮询中断**：同 Run 22/23（含在途 video 任务归位与续跑）实测一次 ✓
- **失败重试**：Run 24（11 个任务失败）→ provider/locale 修正后 resume Run 26 → 20/20 成功（attempts=1）
- **存量 M1**：Run 8 → Run 25 兼容续跑
- **✅ 通过**

### #8 北极星复验（出口问题 1）+ gate 三态

- T1 v2 与 T2 从零到跑通：**业务流程零代码**——两条模板全部由 `workspace/templates/*.yaml` + `workspace/prompts/*.md` 构成；期间修复 2 类**引擎通用缺陷**（loader batch 归一化 / 未成功任务参数同步，见偏差 #2/#3，非体裁定制）
- gate 三态实测：approve（Run 24 剧本批准 / Run 10 M1 实弹）、skip（Run 26「免审直接出图」）、reject（Run 31）
- **reject 意见回流实测**（Run 31 `draft`）：驳回附意见「结尾必须加上一句：愿你今晚好梦。」→ 重跑 `attempts=2` succeeded；
  `input._review={"decision":"reject","note":"…"}`；新产物 asset#178 prompt 含意见（#177 不含）；运行日志命中「检测到驳回修改意见，已注入本次生成」
- **✅ 通过**

### #9 README 回归路径更新

- README 已重写为 M2 版：能力速览 / 内置模板表（v2 + talking-clip）/ AI 配置四通道指引 / 回归路径 A（UI 11 步）B（API）C（清理）/ M2 验收快照表；M1 #5 字幕判据由本里程碑实际烧录关闭
- **✅ 通过（本 review 一并交付）**

### #10 无回归

- **静态分支（motion=false）**：Run 25 执行路径与 M1 同构（ingest→script→storyboard→gen_images→compose；`gen_motion` 自动跳过）——新引擎复跑通过
- **存量 M1 数据 resume 冒烟**：Run 8 → Run 25（快照兼容，见 #2）
- v2 模板静态分支另有 Run 15（completed）佐证
- **✅ 通过**

---

## 偏差与修订

1. **reject 后重跑不再二次挂起**：引擎 `gateHang` 含 `!review` 守卫（M1 引入，commit 8cb5ae6），驳回重跑直通完成、不重复挂闸。**属 M1 既有设计**（避免驳回后无限复审），本里程碑记为行为注记；如需「驳回后仍需复检」可在模板层拆两步承接。
2. **引擎缺陷修复：loader batch 归一化**（`loader.ts`）：模板 YAML 惯用 `max_concurrent`，此前类型层只认 `maxConcurrent`，导致模板写的并发/重试从未生效（恒走默认 2/1）；现归一化 + 校验（`max_concurrent ≥1`、`retry ≥0` 整数）。
3. **引擎缺陷修复：未成功任务参数同步**（`ai-image.ts` / `ai-video.ts`）：任务创建后 prompt/参数固化，修正分镜或调整项目设置后 resume 仍跑旧内容；现未成功任务执行时与当前分镜/设置同步，failed 且有变化 → 归零重排队（succeeded 保持溯源不动）。Run 21→24→26 期间实证。
4. **模板缓存的在线语义**：loader 为进程内缓存（无 mtime 检测），**直接手改模板文件不会即时生效**（需重启服务或经模板页/API 保存触发 invalidate）。Run 28 实证「手改文件 → 新 run 未反映」，Run 30 实证「API PUT → 即时生效」。在线修改一律走模板页（README 已写明）。
5. **跨 run 资产 step_id 语义**：resume 迁移 gen_task 但资产 `step_id` 保留原属步骤行（Run 26 的 9 个复用视频 `step=126` 属 Run 23）——按 step 过滤资产需注意，审计走 purpose + project 全量。
6. **compose 表内 duration 为逻辑估算**：`duration_per_shot × 镜头数`（Run 26 表内 100s），实际以 ffprobe 为准（103.2s = 20 × 5.184s）；minimax 768p「5s 档」实际出片 5.184s/段（第三方档位取整），非缺陷。
7. **环境漂移注记（Run 31 cover 失败）**：模板 `defaults.image.provider=openai_image` 与当前实例（`siliconflow_image` / `pollinations_image`）不匹配 → cover 报「未配置 image 类型 api_configs（providerKey=openai_image）」。属环境数据（run 18 时代存在该实例），引擎报错已含 providerKey 指引；复跑 T2/T1 出图前需对齐实例或经 project settings 覆盖 provider。**模板与 provider 解耦设计不变。**
8. **视频型号-参数的兼容性**：Run 24 的 11 个任务失败（wan-3.0 档位与项目参数不兼容）→ 用户决策改回 `minimax/minimax-h3-max-turbo` + 768p/5s → Run 26 全成功。README 已加「配置热更立即影响后续任务」提示。
9. **收尾状态说明**：测试 run 27-30 已全部 cancel（步骤集证据留存）；Run 31 停于 `failed`（reject 验证完成，cover 因上述环境问题失败，作为证据保留）。

## 出口校准问题应答（ROADMAP M2 行）

- **用户 Skills 方法论能否整体平移到模板+提示词外置？** → **成立**。T1 v2 承载分镜/动效方法论（双闸门 + 免审放行 + 动效/静态互斥分支）；T2 承载口播方法论（文案审阅 → 切句 → 字幕 → 配音 → 合成）；语义映射：Skills「采纳/跳过/稍后」用户闸门 → gate approve/reject/skip；方法论提示词 → `workspace/prompts` 全外置。新增流程 = 新 YAML + prompts，业务步骤零代码（#8 实测）。
- **恢复/重试在多任务场景是否可靠？** → **可靠**。三组实测：Run 22→23（强杀恢复，9 重跑/11 复用）、Run 24→26（11 失败任务修正后续跑全成功）、Run 8→25（M1 存量兼容）。边界：第三方轮询在途时强杀 → recover 归位后 resume；succeeded 产物幂等复用不重复计费。

## M3 spec 输入（本次 review 沉淀）

- 图文/口播**完整方法论**模板（账号 / 选题 / 档案依赖）——M2 已用 mini 形态验证 action 面
- 本地向量记忆 + 角色一致性库（ROADMAP M3 行）
- 音频情绪方法论（TTS 情绪/情感参数）+ 音画精确对齐（按台词时间轴，替代镜头窗口估算）
- 模板层可按需挂「字幕 gate」「驳回后复检拆步」等编排范式（引擎已具备，写入模板方法论即可）
- Backlog 继承：多集批量编排、平台级成本统计

## 验证方式（已完结）

实弹采集：T1 v2 两条分支（motion on/off）+ T2 全链路各 ≥1 次真实 completed run；reject/skip/快照隔离/模板 CRUD/prompts 体检为定点 API 实测；成片用 ffprobe + ffmpeg volumedetect + OCR 抽帧硬验证；Web 时间线经浏览器 DOM 实测（并行同刻启动、skipped/免审放行徽标）。所有临时测试脚本与截图随交付清理。
