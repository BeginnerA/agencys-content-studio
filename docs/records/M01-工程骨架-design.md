# agencys-content-studio M1 技术设计规格

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

> 个人内容创作平台（本地单机 Web）：通用领域模型 + 可编排流水线 + 供应商适配层。M1 用「萌宝短剧单集流水线」死模板跑通 导入 → 剧本 → 分镜 → 出图 → 成片 闭环，验证平台抽象方向。
> 代码矿：huobao-drama（工程部件）+ Toonflow（设计参考）。项目归属 agencys- 家族，与 agencys-deploy 并列自研。

---

## 1. 定位与 M1 边界

### 1.1 平台定位

| 项 | 定义 |
|---|---|
| 名称 | agencys-content-studio |
| 形态 | 本地单机 Web（默认绑定 127.0.0.1，浏览器操作，无登录/多用户） |
| 服务对象 | 个人创作方法论库（短剧/动漫/图文/口播多体裁，长期迭代） |
| 核心抽象 | `Project → Assets(统一资产) → PipelineRun(模板化流水线实例) → Steps → Tasks(异步生成任务)` |
| 关键差异 | 业务流程 = 外置 YAML 模板 + Action Registry，而非写死页面/代码；新增体裁 = 新增模板 |

### 1.2 M1 范围（做）

1. 工程骨架：pnpm workspace（server + web），Hono + Drizzle + better-sqlite3
2. 通用领域模型：projects / assets / pipeline_runs / pipeline_steps / gen_tasks / api_providers / api_configs / settings 八张表
3. 最小流水线引擎（状态机 ~400 行）：YAML 加载 → 引用解析 → 步骤顺序执行 → 人工闸门(waiting_input) → 失败重试 → 取消 → 崩溃恢复
4. 行动注册表 4 个 action：`manual_ingest` / `ai_text` / `ai_image` / `ffmpeg_merge`（`ai_video` 仅注册占位）
5. 搬运 huobao 供应商适配层（LLM/image/video 共 7 adapter）+ ffmpeg 合成管线
6. 死模板 `mengbao-episode`（YAML）+ 内置精简版萌宝剧本/分镜提示词
7. Web 工作台（Vue3）：项目列表/详情、流水线运行态、闸门审阅、资产浏览、任务面板、AI 配置

### 1.3 M1 不做（明确排除）

| 排除项 | 去向 |
|---|---|
| 流程可视化编排画布 / 模板在线编辑 | M2（模板先落盘编辑热加载） |
| 记忆系统 / embedding 本地向量 | M3（Toonflow 参考） |
| 角色一致性库 / 画风库 | M3 |
| ai_video 出视频、配音/字幕引擎 | M2/M3 |
| 多用户 / 权限 / 登录 | 永久不做（单机） |
| Electron / Docker / 远程部署 | 永久不做（本地优先，Docker 仅备选） |

---

## 2. 技术选型（决策完备）

| 层 | 选型 | 依据 / 备注 |
|---|---|---|
| 运行时 | Node.js 20+ / TypeScript strict | 既有偏好；huobao/Toonflow 同为 Node 生态 |
| 后端框架 | Hono | 既有偏好；轻量、TS 一等公民，RPC 可选 |
| ORM | Drizzle + `drizzle-orm/better-sqlite3` | 既有偏好；huobao schema 写法同构，可对照迁移 |
| 数据库 | SQLite 单文件 `data/studio.db` | 既有偏好：零运维；`PRAGMA journal_mode=WAL; foreign_keys=ON` |
| 迁移 | drizzle-kit push（M1 单机不做版本迁移链） | M1 表结构未冻结，push 最快 |
| 流水线 | 自研轻量状态机（`apps/server/src/pipeline/engine.ts`） | 不引重型引擎（temporal/zeebe 等） |
| 模板 | YAML 外置 `workspace/templates/*.yaml` | 既有偏好：流程配置驱动；热加载（watch 变更刷新） |
| LLM 通道 | OpenAI 兼容 chat completions，流式 | 默认读环境变量 `AGENT_LLM_BASE_URL` / `AGENT_LLM_API_KEY`（DeepSeek 网关），可被 `api_configs`（llm 类型，is_default）覆盖 |
| 任务执行 | 进程内队列 + DB 持久化 + 启动扫描恢复 | 单机无需 Redis/Celery；借鉴 huobao `sys_task` 恢复模式 |
| 实时推送 | Socket.IO（namespace `/studio`） | Toonflow socket 模式参考 |
| 前端 | Vue 3 + Vite + TS + 原生 CSS | 与 huobao/Toonflow 前端同生态，组件参考价值最大；M1 不做 SSR/UI 库 |
| 包管理 | pnpm workspace（apps/server + apps/web） | 工作区已有 pnpm 环境 |
| 密钥 | env 优先；本地 key 存 `data/secrets.json`（0600，gitignore） | DB 只存引用名，不存明文 key（huobao 明文存库为反面参照） |
| 媒体 | ffmpeg（合成/切帧/封面）+ sharp（缩略图） | 系统 ffmpeg 或配置路径，启动 health 检查 |

端口约定：server `3001`，web dev `5173`（vite proxy `/api` `/socket.io` → 3001）。M1 只绑定 localhost。

---

## 3. 目录结构

```
agencys-content-studio/
├── package.json                     # workspace root（scripts: dev/build/start）
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .env.example                     # AGENT_LLM_BASE_URL/AGENT_LLM_API_KEY/AGENT_LLM_MODEL 等
├── .gitignore                       # data/ workspace/projects workspace/logs 等
├── README.md
├── data/                            # 运行时生成（gitignore）
│   ├── studio.db                    # SQLite（WAL）
│   └── secrets.json                 # 本地 api_key（0600）
├── workspace/                       # 外置运行时目录（路径可用 CSTUDIO_WORKSPACE 覆盖）
│   ├── templates/
│   │   └── mengbao-episode.yaml     # M1 死模板
│   ├── prompts/                     # LLM 提示词模板（md，外置可编辑）
│   │   ├── script-ep.md             # 剧本生成（精简版萌宝方法论）
│   │   └── storyboard-ep.md         # 分镜提示词包
│   ├── projects/
│   │   └── {projectId}/             # 资产按 分类/序号 落盘
│   │       ├── source/  script/  storyboard/  images/  video/
│   │       └── thumbs/
│   └── logs/
│       └── runs/{runId}.log
├── apps/
│   ├── server/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── drizzle.config.ts
│   │   └── src/
│   │       ├── index.ts             # 启动：http + socket.io + 静态托管 web dist
│   │       ├── app.ts               # Hono 组装（logger/错误/路由挂载）
│   │       ├── env.ts               # 环境变量解析与校验
│   │       ├── logger.ts            # pino 或自研轻量（运行日志 + run 级审计）
│   │       ├── db/
│   │       │   ├── index.ts         # better-sqlite3 + drizzle client + WAL + migrate
│   │       │   ├── schema.ts        # 八张表（见 §4）
│   │       │   └── seed.ts          # api_providers 预置目录
│   │       ├── routes/
│   │       │   ├── projects.ts  assets.ts  templates.ts
│   │       │   ├── runs.ts  tasks.ts
│   │       │   ├── apiConfigs.ts  system.ts
│   │       ├── pipeline/
│   │       │   ├── engine.ts        # ★ 状态机：run 循环/gate/暂停恢复/取消/崩溃恢复
│   │       │   ├── loader.ts        # yaml 解析 + 引用解析（input.x / steps.x.asset）+ action 校验
│   │       │   └── context.ts       # run 上下文（step 日志、产物注册、事件发射）
│   │       ├── actions/
│   │       │   ├── registry.ts      # action key → 执行器
│   │       │   ├── manual-ingest.ts
│   │       │   ├── ai-text.ts       # LLM 流式生成 → 文本/JSON 资产
│   │       │   ├── ai-image.ts      # shots 分发 gen_tasks + 轮询回填
│   │       │   ├── ai-video.ts      # M1 占位（注册 + 校验，抛 not_implemented）
│   │       │   └── ffmpeg-merge.ts  # 图片+音频 → mp4（借鉴 huobao ffmpeg-merge）
│   │       ├── services/
│   │       │   ├── llm.ts           # OpenAI 兼容流式 chat（打点/超时/错误归一）
│   │       │   ├── storage.ts       # 资产落盘/sha256/去重/缩略图（sharp）/range 读
│   │       │   └── queue.ts         # 进程内任务队列 + 崩溃恢复扫描
│   │       └── adapters/            # ★ 自 huobao 搬运改造（见 §7 清单）
│   │           ├── types.ts  registry.ts  url.ts  provider.ts
│   │           ├── openai-image.ts  gemini-image.ts  volcengine-image.ts
│   │           └── minimax-video.ts  volcengine-video.ts  aliyun-wan-video.ts
│   └── web/
│       ├── package.json  vite.config.ts  index.html
│       └── src/
│           ├── main.ts  App.vue
│           ├── lib/
│           │   ├── api.ts           # fetch 封装
│           │   └── socket.ts        # Socket.IO 客户端（rooms: run/{id} project/{id}）
│           ├── stores/              # pinia：projects / runs / tasks / configs
│           ├── components/
│           │   ├── AssetGrid.vue  PipelineStatus.vue  StepLog.vue
│           │   ├── GateDialog.vue   # 闸门审阅（markdown 渲染 + 批准/驳回/中止）
│           │   ├── TaskPanel.vue  ApiConfigForm.vue  MarkdownPreview.vue
│           └── views/
│               ├── ProjectsView.vue  ProjectDetailView.vue
│               ├── RunDetailView.vue  TasksView.vue  SettingsView.vue
```

---

## 4. 数据表定义（SQLite / Drizzle `sqlite-core`）

设计原则（对照 huobao schema 的批判性借鉴）：

| 原则 | huobao 现状 | agencys 决策 |
|---|---|---|
| 内容体裁通用化 | `dramas/episodes/scenes/storyboards/characters/props` 八张短剧专属表 | M1 仅保留 `projects`（`genre` 字段承载体裁），体裁差异化进模板与资产 `purpose` |
| 资产统一归属 | `assets` 挂散落外键（drama/episode/storyboard 均可空） | `assets.project_id` 必填 + `step_id/task_id` 溯源（产出节点），杜绝孤儿 |
| 生成任务统一 | `sys_task`（type=image/video，无归属 run） | `gen_tasks` 增加 `run_id/step_id/attempts/result_asset_id`，任务可溯源、可幂等 |
| 时间戳 | `varchar` 时间字符串 | `integer` unix ms（SQLite 原生友好、可排序） |
| JSON 字段 | `text` 裸存无约束 | `text` + 应用层 zod 校验 + 写入前序列化 |
| API key | `ai_service_configs.api_key` 明文 | `api_configs.api_key_ref`（env 名或 `local`），密钥实体在 `data/secrets.json` |

### 4.1 projects

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | integer | PK autoincrement | |
| name | text | not null | 项目名（如「萌宝镖客」） |
| genre | text | not null default 'drama_short' | 体裁：drama_short/anime/article/note/talking_head/other |
| brief | text | | 题材简报（模板 input.brief 落库快照） |
| template_key | text | not null default 'mengbao-episode' | 默认主模板 |
| status | text | not null default 'active' | active/archived |
| cover_asset_id | integer | ref assets.id | 封面 |
| settings | text(json) | not null default '{}' | 项目级默认：出图尺寸、风格、fps 等（模板 defaults 可覆盖） |
| tags | text(json) | default '[]' | |
| created_at / updated_at / deleted_at | integer | not null / not null / null | 逻辑删除 |

### 4.2 assets（统一资产）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | integer | PK | |
| project_id | integer | not null, FK projects | 必填归属 |
| step_id | integer | FK pipeline_steps | 产出节点（可空=手工上传） |
| task_id | integer | FK gen_tasks | 生成任务溯源 |
| kind | text | not null | image/video/audio/text/archive |
| purpose | text | | source/reference_character/reference_scene/script/storyboard/shot_image/final_video/subtitle/thumbnail/export |
| name | text | not null | 资产名（含扩展） |
| mime / ext | text | | |
| file_size | integer | | 字节 |
| width / height / duration | integer | | 媒体尺寸/时长(ms) |
| sha256 | text | | 去重与缓存键 |
| rel_path | text | | 相对 `workspace/projects/{id}/` |
| prompt | text | | 生成提示词快照（便于复盘） |
| params | text(json) | | 生成参数快照 |
| tags | text(json) | default '[]' | 如 `["ep001","shot3"]` |
| is_favorite | integer | default 0 | |
| created_at / updated_at / deleted_at | integer | | |

索引：`(project_id, purpose)`、`(project_id, tags)`（tags 走 json 前缀扫描，M1 数据量无需 FTS）。

### 4.3 pipeline_runs（流水线实例）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | integer | PK | |
| project_id | integer | not null FK | |
| template_key | text | not null | |
| status | text | not null default 'queued' | queued/running/waiting_input/completed/failed/cancelled |
| current_step_key | text | | 断点续跑锚点 |
| input | text(json) | not null | 启动输入快照（brief/文件 id 列表/集号） |
| summary | text(json) | | 完成汇总（各步产物 id 清单，对应 video-orchestrator 四件套语义） |
| error | text | | |
| started_at / completed_at | integer | | |
| created_at / updated_at | integer | not null | |

### 4.4 pipeline_steps（步骤实例）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | integer | PK | |
| run_id | integer | not null FK | |
| seq | integer | not null | 模板顺序 |
| step_key / action_key | text | not null | 模板键 / 执行器键 |
| title | text | | 步骤显示名 |
| status | text | not null default 'pending' | pending/running/waiting_input/succeeded/failed/skipped/cancelled |
| input | text(json) | | 引用解析后的实际输入 |
| output | text(json) | | 产物（`{asset_ids: []}` 或 `{asset_id}`） |
| error | text | | |
| attempts | integer | not null default 0 | 重试计数 |
| started_at / completed_at / created_at / updated_at | integer | | |

### 4.5 gen_tasks（异步生成任务，对齐 huobao sys_task 统一模型）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | integer | PK | |
| project_id | integer | not null FK | |
| run_id / step_id | integer | FK | 溯源（可空=手动单发） |
| kind | text | not null | image/video |
| provider | text | | 适配器键（volcengine_image/minimax_video…） |
| model | text | | |
| prompt | text | | |
| params | text(json) | not null | image: {size,reference_images[],seed} / video: {first_frame_url,duration,aspect_ratio,…}（继承 huobao 注释口径） |
| task_id | text | | 第三方任务 id（轮询用） |
| status | text | not null default 'pending' | pending/processing/succeeded/failed/cancelled |
| error_msg | text | | |
| attempts | integer | not null default 0 | |
| result_asset_id | integer | FK assets | 成功回填 |
| created_at / updated_at / completed_at | integer | | |

索引：`(status)`（恢复扫描）、`(run_id)`。

### 4.6 api_providers（预置供应商目录，seed 写入）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | integer | PK | |
| key | text | not null unique | volcengine_image / gemini_image / openai_image / volcengine_video / minimax_video / aliyun_wan_video / deepseek_llm / openai_llm |
| name | text | not null | 展示名 |
| service_type | text | not null | llm/image/video/audio |
| default_url | text | | 默认端点（可被 config 覆盖） |
| preset_models | text(json) | | 预置模型清单 |
| description | text | | |
| is_active | integer | default 1 | |

### 4.7 api_configs（用户实例配置）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | integer | PK | |
| provider_key | text | not null FK | |
| service_type | text | not null | llm/image/video/audio |
| name | text | not null | 实例名（如「主用文生图」） |
| base_url | text | | 覆盖 default_url |
| api_key_ref | text | not null | env 变量名 或 `local`（取 secrets.json） |
| model | text | | 默认模型 |
| extra | text(json) | default '{}' | 适配器附加参数（超时、最大并发等） |
| priority / is_default / is_active | integer | default 0/0/1 | 同 service_type 内 is_default 唯一 |
| created_at / updated_at | integer | not null | 硬删除 |

### 4.8 settings（全局 KV）

`id / key(unique) / value(json) / updated_at` —— M1 存量极小（默认并发数、ffmpeg 路径、默认出图尺寸），UI 设置页读写。

---

## 5. 流水线模板与执行契约

### 5.1 M1 死模板 `workspace/templates/mengbao-episode.yaml`

```yaml
key: mengbao-episode
version: 1
name: 萌宝短剧·单集流水线
description: 素材入库 → 单集剧本 → 分镜提示词包 → 批量出图 → 合成成片
genre: drama_short
inputs:
  - key: brief            # 本集题材简报（必填文本）
    kind: text
    required: true
  - key: setting_docs     # 设定底稿/参考素材（选填多文件，入库为 source/参考资产）
    kind: files
    required: false
    accept: [.md, .txt, .png, .jpg, .jpeg]
  - key: episode_number
    kind: int
    required: true
defaults:                 # 被 project.settings 同名项覆盖
  llm: { temperature: 0.8, max_tokens: 6000 }
  image: { provider: volcengine_image, size: "832x1248", style: "3d" }
steps:
  - key: ingest_docs
    action: manual_ingest
    title: 素材入库
    inputs: { docs: input.setting_docs, brief: input.brief }
  - key: write_script
    action: ai_text
    title: 生成单集剧本
    inputs:
      setting: steps.ingest_docs.assets      # 上游产物引用 → 解析为资产 id 列表
      brief: input.brief
    params: { prompt_tpl: script-ep.md, output_purpose: script }
    gate:                                    # 闸门 1：人工审阅剧本
      mode: required
      message: 请审阅剧本（episode {input.episode_number}），可修改文本后批准；驳回可附修改意见重跑
  - key: make_storyboard
    action: ai_text
    title: 分镜与提示词包
    inputs: { script: steps.write_script.asset }
    params: { prompt_tpl: storyboard-ep.md, output_purpose: storyboard, output_format: storyboard-json }
  - key: gen_images
    action: ai_image
    title: 批量镜头出图
    inputs:
      shots: steps.make_storyboard.asset     # storyboard-json: {shots:[{id,image_prompt,duration}]}
      characters: assets purpose=reference_character   # 项目参考资产按 purpose 拉取
    batch: { field: shots, max_concurrent: 2, retry: 1 }
  - key: compose_video
    action: ffmpeg_merge
    title: 合成成片
    inputs:
      images: steps.gen_images.assets        # 按 shots 顺序聚合
    params: { fps: 25, resolution: "1080x1920", subtitle: true, cover: true }
    output_purpose: final_video
```

### 5.2 引用语法（engine 内置解析器，M1 实现，~100 行）

| 语法 | 解析目标 |
|---|---|
| `input.<key>` | run.input 对应键 |
| `steps.<key>.assets` / `steps.<key>.asset` | 上游 step output 的资产 id 数组 / 首个 id |
| `assets purpose=<purpose>` | 项目内该 purpose 的资产 id 数组（按 updated_at 排序） |
| `{input.episode_number}`（模板串内插值） | 替换为 run.input 值（gate message/文件名/prompt 模板注入用） |

解析失败（引用未知 step / 资产不存在）→ 该 step 校验失败，run failed，错误含引用路径。

### 5.3 Action Registry 契约（M1）

执行器统一签名：`async (ctx: StepContext) => StepResult`

| Action | 执行语义 | 产物登记 |
|---|---|---|
| `manual_ingest` | 把 input 文件拷贝入 project 目录、写 brief 摘要文本资产；同步完成 | source/archive 资产 |
| `ai_text` | 取 `params.prompt_tpl` → 注入 inputs（资产内容/markdown 引用路径）→ llm 流式调用 → 写资产（markdown 或 JSON 按 `output_format`）；日志流式入 step log | text 资产（purpose 指定） |
| `ai_image` | 解析 `batch.field` 数组 → 每条发一个 gen_task（params 合并 defaults/project.settings）→ 入队并发轮询 → 全部成功后回填 result_asset_id；失败按 `batch.retry` 重试 | image 资产（purpose=shot_image，tags=[ep{n}, shot{i}]） |
| `ffmpeg_merge` | 聚合 images + 可选字幕 → ffmpeg concat/drawtext/xfade → 成片 + 封面；转码日志流式 | video 资产 + thumbnail |
| `ai_video`（占位） | 注册 + schema 校验通过；执行抛 `ActionNotImplemented` | — |

### 5.4 状态机与恢复契约（engine.ts 核心语义）

```
run.status: queued → running → { waiting_input | completed | failed | cancelled }
step.status: pending → running → waiting_input | succeeded | failed(→重试→running) | cancelled
```

- **闸门**：step 声明 `gate.mode=required` 且执行成功 → step 置 `waiting_input`，run 置 `waiting_input`，持久化 + 发 `run.gate` 事件；用户批准 → 以「审阅后文本覆盖资产」为可选参数继续下一 step；驳回 → 重新执行本 step（attempts+1，输入带修改意见）。
- **取消**：`run.cancel` 幂等；running step 内的 gen_tasks 标记 cancelled 并尽力通知第三方；再次启动同模板新建 run。
- **崩溃恢复**：启动时扫描 `pending/processing` 的 gen_tasks（对齐 huobao 中断任务清理模式）→ 有 `task_id` 的先查第三方真实状态回填，查不到/超时 → 标 failed（可手动 retry）；`running` 的 run 归位为可重跑（标 failed，error=interrupted，UI 提供「从断点续跑」→ 重建 run 时跳过 succeeded step）。
- **幂等**：step 成功即写 output（资产 id）后置 succeeded；重启重放只从未 succeeded 步骤开始。

---

## 6. API 契约

### 6.1 REST（前缀 `/api/v1`，JSON，错误统一 `{error:{code,message}}`）

| Method | Path | 说明 | 请求要点 → 响应要点 |
|---|---|---|---|
| GET | /projects | 列表 | ?status=&genre= → 数组（含最近 run 状态、资产计数） |
| POST | /projects | 新建 | {name,genre,brief,template_key?} → project |
| GET | /projects/:id | 详情 | → project + settings + 最近 5 runs 摘要 |
| PATCH | /projects/:id | 更新 | 可改名/brief/settings/tags/template_key |
| DELETE | /projects/:id | 归档 | 逻辑删 |
| GET | /projects/:id/assets | 资产列表 | ?kind=&purpose=&tag= → 数组（含缩略图 url） |
| POST | /projects/:id/imports | 上传素材 | multipart 多文件 → assets[]（sha256 去重） |
| GET | /api/v1/assets/:id | 资产详情 | → asset + params/prompt |
| GET | /assets/:id/file | 文件流 | 支持 Range（视频预览）；`?download=1` |
| GET | /assets/:id/thumb | 缩略图 | 无则 lazy 生成（sharp） |
| PATCH | /assets/:id | 更新 | is_favorite/tags/name |
| DELETE | /assets/:id | 删除 | 逻辑删 + 物理文件待 GC |
| GET | /templates | 模板清单 | 扫描 workspace/templates → [{key,name,description,genre,step_count}] |
| GET | /templates/:key | 模板详情 | 完整 YAML（步骤含 gate/batch 定义，供前端渲染流程） |
| POST | /projects/:id/runs | 启动 run | {template_key,input:{brief,episode_number,setting_docs?:[assetId]}} → run（202） |
| GET | /runs | 运行列表 | ?project_id=&status= |
| GET | /runs/:id | 运行详情 | → run + steps[]（含每步 input/output/error/资产引用解析后的可读化） |
| GET | /runs/:id/log | 运行日志 | SSE 或分段文本（step 流式日志尾部） |
| POST | /runs/:id/gate | 闸门决策 | {step_key, decision: approve/reject/abort, note?, text_override?, overrides?{…}} |
| POST | /runs/:id/cancel | 取消 | → run |
| POST | /runs/:id/resume | 断点续跑 | 仅 failed(interrupted)/cancelled → 新 run 复制跳过 succeeded |
| GET | /tasks | 任务列表 | ?run_id=&status=&kind= |
| GET | /tasks/:id | 任务详情 | → 含 params/error_msg/result_asset |
| POST | /tasks/:id/retry | 重试 | 仅 failed/cancelled |
| POST | /tasks/:id/cancel | 取消 | 尽力通知第三方 |
| GET | /api-providers | 供应商目录 | 预置 + 已建 config 关联态 |
| GET | /api-configs | 配置列表 | key 脱敏（尾 4 位） |
| POST | /api-configs | 新建 | {provider_key,service_type,name,base_url?,api_key?,api_key_ref?,model,…} |
| PUT | /api-configs/:id | 更新 | |
| DELETE | /api-configs/:id | 删除 | |
| POST | /api-configs/:id/test | 连通性测试 | 发起最小调用（llm:1 token / image:1 张）返回耗时 |
| GET | /health | 健康 | {db,ffmpeg,workspace} |
| GET | /system/status | 运行态 | 队列深度/并发/磁盘余量/版本 |

### 6.2 Socket.IO（namespace `/studio`，客户端 join `run:{id}` / `project:{id}` room）

| 事件 | 方向 | payload |
|---|---|---|
| run.started | server→room | {run_id, project_id, step_count} |
| run.step | server→room | {run_id, step:{id,key,action,status}, ts} |
| step.log | server→room | {step_id, seq, chunk}（ai_text/ffmpeg 流式日志增量） |
| run.gate | server→room | {run_id, step_key, message}（前端弹闸门） |
| run.completed / run.failed | server→room | {run_id, summary} / {run_id, step_key, error} |
| task.updated | server→room | {task_id, status, progress?} |

重连语义：客户端断线重连后拉 `GET /runs/:id` 全量对账，事件仅作增量提示，UI 以 REST 为准（与既有「前端流式客户端共享规范」一致：事件驱动渲染、REST 兜底）。

---

## 7. huobao 复用/改造清单（文件级）

### 7.1 原样搬（仅 import/类型适配）

| huobao 文件 | 目标 | 备注 |
|---|---|---|
| services/adapters/types.ts | adapters/types.ts | adapter 统一入参/出参契约 |
| services/adapters/registry.ts | adapters/registry.ts | 键 → 工厂映射 |
| services/adapters/url.ts | adapters/url.ts | 上传/结果 URL 归一 |
| services/adapters/openai-image.ts | adapters/ | 文生图 |
| services/adapters/gemini-image.ts | adapters/ | 文生图 |
| services/adapters/volcengine-image.ts | adapters/ | 文生图 |
| services/adapters/volcengine-video.ts | adapters/ | 图生视频（M2 启用） |
| services/adapters/minimax-video.ts | adapters/ | 图生视频（M2 启用） |
| services/adapters/aliyun-wan-video.ts | adapters/ | 图生视频（M2 启用） |
| services/ffmpeg-merge.ts | actions/ffmpeg-merge.ts | concat + 字幕核心逻辑 |
| utils/video-poster.ts | services/（并入 storage 或独立） | 抽帧封面 |

### 7.2 改造（结构沿用、字段/归属重写）

| huobao 文件 | 改造点 |
|---|---|
| db/schema.ts | mysql-core → sqlite-core；八张短剧表 → §4 八张通用表；`sys_task` → `gen_tasks`（加 run/step/attempts/result_asset_id）；`ai_service_configs` → `api_configs`（key_ref 化）；时间戳 varchar → integer |
| services/generation.ts（22.6KB） | 拆解：轮询恢复逻辑 → services/queue.ts；参数组装 → adapters/provider.ts（从 api_configs 选实例）；prompt 组装 → 模板注入 |
| routes/tasks.ts | 保留 REST 骨架，去掉 drama 专属字段，加 run/step 过滤与 retry 幂等 |
| utils/task-logger.ts | step 级审计写入（run 日志 + DB） |
| routes/aiConfigs.ts | 双表化 + key 脱敏 + test 端点 |

### 7.3 不搬（明确丢弃）

| huobao 模块 | 丢弃原因 |
|---|---|
| agents/ 全部（21KB index + 4 工具集） | M1 无对话 agent；文本生成走模板化 ai_text，M2 视需要再评估 |
| routes/dramas|episodes|scenes|storyboards|characters|props|merge | 领域锁定，M1 不需要 |
| mastra/、extraction.ts（长视频解析提炼） | 与 M1 无交集，M3 素材导入再评估 |
| 前端全部（Vue 页面） | UI 语义不同（项目/资产/流水线），重写成本低于迁移 |
| mysql-schema.ts | SQLite 单库 |
| Toonflow memory/embedding（ONNX） | M3 再搬 |

---

## 8. 里程碑验收（M1 exit criteria，可测）

1. `pnpm dev` 一键起双端；`GET /health` 全绿（ffmpeg 存在、workspace 可写）。
2. Web 建项目「萌宝镖客」→ 上传 brief + 设定 md + 角色参考图（imports 去重生效）。
3. 启动 mengbao-episode：write_script 流式日志可见 → run 停在 `waiting_input`（gate 消息含集号插值）；Web 审阅 markdown 可批准/驳回。
4. 批准 → storyboard 产出 storyboard-json（shots ≥ 8）→ gen_images 并发 ≤2、失败自动重试 1 次 → 成功率 ≥90%（临时不可用 provider 可在 Settings 切换实例后 retry）。
5. compose_video 产出 mp4（1080x1920、带字幕/封面）→ 浏览器内可 Range 预览。
   （2026-09-09 M1 review 修订注：M1 无台词字幕来源，「字幕」判据落点 = 1080x1920 + 封面 + Range；配音/字幕独立 action 属 M2，启用后回补复验 —— 详见 m1-review 偏差 #1）
6. 鲁棒性：运行中强杀 server 重启 → gen_tasks 无悬挂 processing（归位 failed 可 retry）、waiting_input run 原样可继续。
7. 资产可溯源：任一 shot_image 资产可查到 {run, step, task, prompt 快照, params}。
8. 全链路手动回归路径写入 README（含清理 data/ 重来的指引）。

---

## 9. 遗留决策与演进注记

| 项 | 决策状态 |
|---|---|
| 前端是否引入组件库 | M1 原生 CSS；如 M2 画布/表单复杂度上升再评估（Element Plus / shadcn-vue） |
| LLM 提示词 v1 | 内置精简版萌宝方法论（script-ep.md / storyboard-ep.md）；跑通后逐步替换为用户 Skills 完整提示词体系（提示词外置目录已就位） |
| 模板热加载 | watch workspace/templates + prompts，变更即刷新（运行中 run 保持快照语义） |
| ai_text 是否进 gen_tasks | M1 同步执行 + 流式日志；如后续接入慢模型/多步骤 agent 再任务化（表已预留 kind 扩展） |
| 角色一致性 | M1 依赖参考图 + 固定 seed + 同风格 defaults；一致性库属 M3 |
| M2 主项 | 模板引擎完整化（分支/并行/条件）、模板在线管理、ai_video 启用、配音字幕独立 action、从用户 Skills 沉淀更多模板（图文/口播） |
| 命名兼容 | genre/template_key 等字段值在 M2 若需改名，走 settings KV 迁移映射，不冻结表 |

---

## 10. 参照物速查

- 本文表结构对照源：`Agent/huobao-drama/backend/src/db/schema.ts`（11 表）
- 适配器搬运源：`Agent/huobao-drama/backend/src/services/adapters/`、`services/ffmpeg-merge.ts`
- 模板语义灵感：`Skills/AI视频创作/video-orchestrator/workflow-content-pipeline.md`（闸门 1/2、aborted_by_user、setup_pack 三态 → M1 gate 契约的来源）
- 前端生态参照：`Agent/Toonflow-web/src`（Vue3 工作台布局与 socket 用法）
- 单机形态与零运维：SQLite WAL + 进程内队列（本地单机部署偏好）
