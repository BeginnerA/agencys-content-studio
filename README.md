# agencys-content-studio

个人内容创作平台：模板化流水线 + 统一资产 + 供应商适配层（本地单机 Web）。

- 设计规格：`docs/superpowers/specs/2026-09-09-agencys-content-studio-m1-design.md`、`docs/superpowers/specs/2026-09-09-agencys-content-studio-m2-design.md`
- 方向文档（L0）：`docs/superpowers/specs/2026-09-09-agencys-content-studio-roadmap.md`
- 验收记录：`docs/superpowers/specs/2026-09-09-agencys-content-studio-m1-review.md`、`docs/superpowers/specs/2026-09-09-agencys-content-studio-m2-review.md`
- 状态：M1 骨架闭环 ✓；**M2 流程引擎化完成**（编排语义 / 模板快照 / Gate 三态 / ai_video + tts + subtitle / 模板与提示词在线管理）

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

## 内置模板

| key | 场景 | 要点 |
|---|---|---|
| `mengbao-episode` v2 | 萌宝短剧·单集（T1） | 双闸门：剧本必审 + 分镜可选审（`with_storyboard_review`；挂起后可「免审直接出图」）；`motion` 开关互斥分支：静态出图（`gen_images`）/ AI 动效视频（`gen_motion`） |
| `talking-clip` | 对白口播·单条（T2） | 文案审阅（gate）→ 切句 / 封面提示词并行 → 字幕 + 配音（`with_voice` 可关）→ 合成（字幕烧录 + 人声轨） |

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

## 目录约定

| 路径 | 说明 |
|---|---|
| `apps/server/src/` | Hono API + Pipeline 引擎（DAG 调度 / 模板快照 / 崩溃恢复）+ Action Registry + 供应商适配层 |
| `apps/web/src/` | Vue3 工作台（项目 / 运行 / 资产 / 任务 / gate 审阅 / 模板 / AI 配置） |
| `workspace/templates/*.yaml` | 流水线模板（新增体裁 = 新增模板；模板页在线编辑，保存即生效） |
| `workspace/prompts/*.md` | LLM 提示词模板（外置可编辑；模板页同区管理） |
| `workspace/projects/{id}/` | 项目资产（运行时生成，API 经 /api/v1/assets/{id}/file 访问） |
| `data/studio.db` | SQLite（WAL） |
| `data/secrets.json` | 本地 API key（0600，不入库） |

## M2 全链路回归路径

### A. UI 手工路径（推荐，一次约 5–10 分钟）

1. 双端启动：`pnpm dev`，浏览器打开 http://127.0.0.1:5174
2. **建项目**：项目列表「新建项目」（或选已有「萌宝冒烟」跳到 3）；模板可选 `mengbao-episode`（T1）或 `talking-clip`（T2）
3. **传素材**：项目详情页「上传素材」，用途可选 brief / 设定底稿 / 角色参考图 / 归档；同内容重复上传应去重（同名仅保留一份）
4. **启动流水线**：「启动流水线」→ 填 brief 与集号、勾选开关（`motion` 动效 / `with_storyboard_review` 分镜审阅）→ 提交后自动跳运行页
5. **看流式日志**：write_script 步骤日志滚动 → 停在「等待审阅」（gate）
6. **gate 审阅**：预览剧本 markdown → 可「审阅修改」（以修改版续跑）或直接**批准**；驳回需附意见（回流 LLM 重跑）；分镜闸门挂起时可点「免审直接出图」（skip）
7. **等出片**：批准后自动分镜 →（静态分支）批量出图 /（动效分支）批量视频 → 合成成片；时间线可见并行段与 skipped 灰显（原因 badge）；任务面板逐任务状态与 prompt 溯源
8. **看成片**：完成态 run 的产物资产（final_video）点开即播放（浏览器 Range 拉流）；封面 thumb 与全尺寸图可预览
9. **模板在线管理**：`/templates` 编辑 YAML（错误内联）→ 保存 → 新 run 用新模板；运行中 run 仍按快照执行
10. **断点续跑**：failed / cancelled run 详情页「从断点续跑」→ 新 run 仅重跑未完成步骤（已成功产物复用）
11. **AI 配置**：`/settings` 四 tab（文本 / 图片 / 视频 / 语音）查看实例，「测试」验证连通；通道未配 / 失败可切换默认实例后重试

### B. API 快捷冒烟

```bash
curl http://127.0.0.1:3001/api/v1/health               # ok/db/ffmpeg/workspace 全绿
curl "http://127.0.0.1:3001/api/v1/runs?project_id=3"  # 项目 3 运行列表（最新在前）
curl http://127.0.0.1:3001/api/v1/runs/26              # completed run 详情（steps 产物链）
curl http://127.0.0.1:3001/api/v1/templates            # 模板列表（含引用体检）
curl http://127.0.0.1:3001/api/v1/assets/166/file      # 成片 mp4（支持 Range: bytes=…）
curl -X POST http://127.0.0.1:3001/api/v1/runs/24/resume   # 断点续跑（failed/cancelled）
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

## M2 验收快照（2026-09-10）

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
