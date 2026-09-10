# agencys-content-studio

个人内容创作平台：模板化流水线 + 统一资产 + 供应商适配层（本地单机 Web）。

- 设计规格：`docs/superpowers/specs/2026-09-09-agencys-content-studio-m1-design.md`、`docs/superpowers/specs/2026-09-09-agencys-content-studio-m2-design.md`、`docs/superpowers/specs/2026-09-10-agencys-content-studio-m3-design.md`
- 方向文档（L0）：`docs/superpowers/specs/2026-09-09-agencys-content-studio-roadmap.md`
- 验收记录：`docs/superpowers/specs/2026-09-09-agencys-content-studio-m1-review.md`、`docs/superpowers/specs/2026-09-09-agencys-content-studio-m2-review.md`、`docs/superpowers/specs/2026-09-10-agencys-content-studio-m3-review.md`
- 状态：M1 骨架闭环 ✓；M2 流程引擎化 ✓；**M3 记忆与角色一致性完成**（E1 记忆 / E2 记忆 action / E3 角色库 / E4 音频情绪 / E5 measured 字幕 / T1 图文）

## 技术栈

Node 20+ / TypeScript / Hono / Drizzle + libsql / Socket.IO / Vue3 + Vite（原生 CSS）/ pnpm workspace

## 快速开始

```bash
pnpm install
# 复制 .env.example 为 .env 并填入 AGENT_LLM_API_KEY（其余供应商密钥在 Web「AI 配置」页录入）
pnpm dev    # 并行起双端：
            #   server  http://127.0.0.1:3001（API + Socket.IO + health）
            #   web     http://127.0.0.1:5174（vite dev，/api 与 /socket.io 已代理）
```

首次启动自动建库（drizzle migrate）与 seed（供应商目录）。密钥只存 `data/secrets.json`（0600），不入库不进 git。

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

## 内置模板

| key | 场景 | 要点 |
|---|---|---|
| `mengbao-episode` v3 | 萌宝短剧·单集（T3） | 双闸门：剧本必审 + 分镜可选审（`with_storyboard_review`；挂起后可「免审直接出图」）；`motion` 开关互斥分支：静态出图（`gen_images`）/ AI 动效视频（`gen_motion`）；**角色一致性链** `char_profile → ref_prompts → gen_refs（可选）→ sync_characters` 建档，`gen_images` 逐镜注入「角色锚定 + 免漂移负向词」（`with_character_refs`：开=出定妆照入档 / 关=仅建档） |
| `talking-clip` v2 | 对白口播·单条（T2） | **记忆闭环** `recall → draft → remember`（风格样本滚动 upsert）+ 账号档案注入 + `with_subtitle_review` 可选闸门 + 逐句情绪配音 + measured 精确字幕 → 合成（字幕烧录 + 人声轨，`with_voice` 可关） |
| `note-clip` v1 | 图文笔记·单篇（T1） | 记忆召回 → 主稿（gate）→ 封面 + 可选内页配图（`with_inline_images` / `image_count`）→ 发布稿（标题定稿 + 备选 + 话题标签 + 配图顺序 + 溯源检查）→ 记忆沉淀；全程复用既有 action（零新 action 证据） |

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
| `apps/web/src/` | Vue3 工作台（项目 / 运行 / 资产 / 任务 / gate 审阅 / 模板 / AI 配置 / 记忆 / 角色） |
| `workspace/templates/*.yaml` | 流水线模板（新增体裁 = 新增模板；模板页在线编辑，保存即生效） |
| `workspace/prompts/*.md` | LLM 提示词模板（外置可编辑；模板页同区管理） |
| `workspace/projects/{id}/` | 项目资产（运行时生成，API 经 /api/v1/assets/{id}/file 访问） |
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

## M3 验收快照（2026-09-10）

| # | 判据（spec §10） | 结果 | 证据（详见 m3-review） |
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

| # | 判据（spec §10） | 结果 | 证据（详见 m2-review） |
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

| # | 判据 | 结果 | 证据（详见 m1-review） |
|---|---|---|---|
| 1 | `pnpm dev` 双端 + `/health` 全绿 | ✅ | db/ffmpeg/workspace 均 ok |
| 2 | Web 建项目 + 上传 imports 去重 | ✅ | 项目 1；brief×2/source×1 资产 |
| 3 | 流式日志 → waiting_input → Web gate 审阅 | ✅ | Run 10（真实 UI 审阅通过） |
| 4 | storyboard ≥8 shots；并发 ≤2、重试 1 次、成功率 ≥90% | ✅ | 19 shots；19/19 成功（100%） |
| 5 | mp4 1080x1920 带封面 → 浏览器 Range 预览 | ✅ | ffprobe 实测 1080x1920/76s；206；**字幕判据由 M2（T2 烧录）回补复验** |
| 6 | 强杀恢复：无悬挂 processing、waiting_input 可续 | ✅ | Run 9 由失败恢复 completed（幂等复用） |
| 7 | shot_image 可溯源 {run,step,task,prompt,params} | ✅ | asset#32 → run9/step22/task57 |
| 8 | 本 README 回归路径 | ✅ | 上文 A/B/C（M2 版已更新） |
