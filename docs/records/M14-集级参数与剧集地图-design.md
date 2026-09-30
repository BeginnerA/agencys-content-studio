# agencys-content-studio M14 设计文档（平台层：集级参数 / 剧集实体 / 桌面端〔已取消〕）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

> 里程碑：M14（2026-09-12 立项）｜上游：M4 run 体系 · M8 style_presets 平台表先例 · M9 项目域多集模式 · M11 run.input._compose 覆盖先例 · M12/M13（组1 组2 收尾）
> 性质：组3「平台层」批次——18 项 backlog 去重 17 项的**收官批**（第 15~17 项）：①集级参数 ②剧集实体 ③桌面端。BGM/音效项已由 M11 落地（per-shot 音效按 M11 注记排除）；本批完成后 17 项全量落地。
>
> **范围调整（2026-09-12，决策留痕）**：③桌面端经用户决策**取消**——项目定位本地单机 Web 工具（自用、无对外分发需求），与 M1 红线「Electron / Docker / 远程部署 → 永久不做」一致；桌面端系对标沉淀误入 backlog 的 P2 按需候选。已建 `apps/desktop` scaffold 全量删除、Electron 二进制下载中止、`pnpm-workspace.yaml` 恢复原样（git 零残留）。**静态托管（原 P2）保留**（生产模式一条命令，非桌面端专属）。本批交付 = ①集级参数 ②剧集实体 + 静态托管；下文涉及桌面端段落均标注〔已取消〕，保留为决策记录。

---

## §1 背景与目标

### 1.1 现状（勘察结论，2026-09-12）

| 方向 | 现状 |
|---|---|
| 参数体系 | 优先级链 = 模板 `defaults` → `projects.settings`（同名覆盖）→ `ctx.settings`（context.ts L52-57 合并）→ action 读取。**无 run/集级覆盖层**：同一项目所有集只能共享一份项目参数 |
| 集号 | `run.input.episode_number` 已全链贯通（manual-ingest 命名 / ffmpeg-merge `ep` 前缀 / ai-video 溯源 / 模板插值 `{episode_number:03d}`），但**仅作编号**，无集实体、无状态、无覆盖能力 |
| 项目域模式 | 「一项目=一部剧，一运行=一集」（M9 记忆确认）；多集制作=在同项目下多次启动 run，集间一致性靠项目角色库/记忆承载 |
| 剧集落库 | **不存在任何剧集/集数实体表**；`series-setup` 模板的「分集地图」只是文本资产（设定包产物）。roadmap backlog + 对标清单（P2）均登记「剧集实体」「集级参数锁定」未做 |
| 桌面端 | 纯 Web 形态：`pnpm dev`（vite 5174 + server 3001）；web `dist/` 已可构建但 **server 无静态托管**；根路径解析靠 `CSTUDIO_ROOT` / `pnpm-workspace.yaml` 上溯（env.ts）；无 Electron |

### 1.2 目标

1. **集级参数**：单集 run 启动时可覆盖生成参数（画风尺寸 / 视频档位 / 声线 / LLM 温度等），层级 `run 覆盖 > 项目 settings > 模板 defaults`，**runtime 叠加、不改任何 action 代码**。
2. **剧集实体**：平台级通用表承载「剧（系列）→ 集」两级结构：集号 / 标题 / 状态 / 起作资产，与 run 双源合并展示。对齐 M8 `style_presets` 先例（平台级、跨体裁，非体裁专属表）。
3. **桌面端**〔已取消，2026-09-12〕：Electron 包装 → Windows 安装包（nsis）。**业务核心零改动**：server 仅 +1 段静态托管（env 驱动），desktop 为独立包 `apps/desktop`；数据目录收敛到用户数据目录（Electron `userData`）。——**该目标不实施**；静态托管段独立保留。

---

## §2 范围

### 2.1 ① 集级参数（run 级参数覆盖）

- **机制**：`run.input._params`（对象，下划线内部键，对齐 M11 `_compose` 先例）——`{ image: {...}, video: {...}, audio: {...}, llm: {...} }`。
- **键白名单与校验**（`prepareRunInput` 前置校验，非法 → 400 `bad_params`）：
  - `image`: `provider`(string) / `model`(string) / `size`(/^\d{2,5}x\d{2,5}$/)
  - `video`: `provider` / `model` / `resolution`(480p|720p|1080p) / `duration`(number, clamp 1–30)
  - `audio`: `provider` / `voice`(string)
  - `llm`: `temperature`(number, clamp 0–2) / `max_tokens`(number, clamp 256–65536)
  - 未知键 / 类型不符 → 400 附键名；`undefined` 值剔除；空对象（全键无效）不写入。
- **生效点**：`createStepContext`（context.ts）——settings 合并链顶层叠加：`{...template.defaults[x], ...projectSettings[x], ...runParams[x]}`。action 零改动、既有 run（无 `_params`）行为逐字不变。
- **Web**：`RunFormModal` 第二步新增「本集参数覆盖（可选）」折叠区（image.size / video.resolution·duration / audio.voice / llm.temperature 四个轻量输入）；提交时并入 `input._params`。项目设置页（`ProjectFormModal`）不动。
- **续跑语义**：`resume` 复制源 run.input（含 `_params`）→ 同集语义对齐（快照一致性）；需调整时在工作台走「单步重跑（M11）」+ 或新建 run。

### 2.2 ② 剧集实体（series / episodes 两级通用表）

- **数据模型**（schema.ts；幂等迁移 `db/index.ts`）：
  - `series`：`id / project_id(唯一，一项目一剧) / name / total_episodes / content_asset_id(起作资产，如系列设定包) / created_at / updated_at`
  - `episodes`：`id / project_id / series_id / number / title / status(locked 初始) / content_asset_id / latest_run_id / created_at / updated_at`；索引 `(project_id, number)` 唯一、`series_id`
- **服务**：`services/series.ts`——`createSeries` / `listEpisodes` / `updateEpisode` / `deleteEpisode` / `remapEpisodeRun`
  - status 派生：`listEpisodes` 返回值 **`episodes.status` 与「该集最新 run 状态」双源合并**（run 存在 → 取 run.status；无 → 取行 status）；不改 run 生命周期、不挂事件
  - 创建剧集：`POST` body `{ name, total_episodes, content_asset_id? }` → 生成 `total_episodes` 条集记录（number 1..N，title 空）
  - 更新集数：扩容追集 / 缩容仅当被删集无 run 且有内容资产时拒绝（409）
  - 删除：剧（无任何关联 run 才可删，否则 409）/ 集（保留 run 与资产，仅删集记录）
- **路由**：`routes/series.ts`（挂 `/api/v1`）：
  - `GET /projects/:id/series`（剧 + 集列表 + status 派生）
  - `POST /projects/:id/series` · `PATCH /series/:id`（episodes 扩容/缩容）· `DELETE /series/:id`
  - `PATCH /episodes/:id`（title / status 手工置位）· `DELETE /episodes/:id`
- **run 联动（零生命周期改动）**：`POST /projects/:id/runs` 若 input 含 `episode_number` 且项目已有 series → 创建成功后回写 `/episodes/:id`（`latest_run_id`）。回写为**启动端点后置动作**（runs.ts 内几行），失败不阻断 run（宽容降级）。
- **Web**：`ProjectDetailView` 新增「剧集地图」卡（剧名 / 集列表：集号 + 标题 + 状态徽标 + 起作入口）；`SeriesBoard.vue` 新组件；起作 = 打开既有 `RunFormModal`（`initialTemplateKey=mengbao-episode` + 预填 `episode_number`）。

### 2.3 ③ 桌面端（Electron + Windows 安装包）〔已取消，2026-09-12〕

> **取消注记（2026-09-12，决策留痕）**：本节设计**不实施**。① 原因：项目为本地单机 Web 工具（自用、无对外分发需求），浏览器 :3001 即满足使用；M1 红线「Electron / Docker / 远程部署 → 永久不做」；桌面端系对标沉淀误入 backlog 的 P2 按需候选。② 处置：`apps/desktop` scaffold（6 文件）与依赖全量删除、Electron 二进制下载中止、`pnpm-workspace.yaml` 恢复原样（git 零残留）。③ **例外保留**：下「服务端静态托管」小段独立保留落地；其余文本保留为决策记录。

- **形态**〔已取消〕：新包 `apps/desktop`（pnpm workspace `apps/*` 自动纳入）；依赖 `electron` + `electron-builder`（根 `pnpm-workspace.yaml` `allowBuilds` 需 +`electron` 授权 postinstall）。
- **服务端静态托管（唯一 server 改动，env 驱动零副作用）**〔保留落地，独立于桌面端〕：
  - `env.ts` +`WEB_DIST`（`CSTUDIO_WEB_DIST` 或 `join(ROOT, 'apps/web/dist')`）
  - `app.ts` 在 `/api/v1` 挂载后、404 兜底前：`existsSync(index.html)` 才启用静态服务——`GET /assets/*`（静态文件）+ 其余非 `/api/*` GET 回退 `index.html`（SPA 路由）；window-safe 归一化 + 路径穿越防护。
- **主进程**〔已取消〕（`apps/desktop/scripts/main.ts`，electron 内 TS 由 electron 自身加载或先 tsc）：
  - 解析 `CSTUDIO_ROOT`：dev = 仓库根；prod = `app.getPath('userData')`（首次从打包 `resources/workspace/` 复制 `templates/` `prompts/`）
  - 启动 server：**开发=外部进程**（`npm run dev`）；**打包=同进程 import 服务端 entry**（复用 Electron 内置 Node；Native 模块 asarUnpack）
  - 就绪等待（HTTP 探活 `/api/v1/system/*`）→ `BrowserWindow` 加载 `http://127.0.0.1:{port}`；窗口态 + 菜单极简 + 外链系统浏览器
- **打包**〔已取消〕：`electron-builder.yml`——`asar: true` + `asarUnpack`（ffmpeg-static / ffprobe-static / @libsql / onnxruntime-node / @huggingface）+ `extraResources`（`workspace/templates`、`workspace/prompts`、server 运行时依赖）+ win target `nsis`（oneClick=false、allowToChangeInstallationDirectory、图标由 `apps/web/public/logo-mark-1024.png` 转 ico）。
- **链路**〔已取消〕：`pnpm --filter @acs/desktop build`（web build + electron-builder）→ `dist/内容工坊-{version}-win-x64-setup.exe`。

---

## §3 红线复核

- **不改引擎 / refs / loader / 模板 / 提示词**：engine / refs / loader / workspace/** 零 diff；集级参数在 context 合并层注入，剧集联动在路由端点内（后置回写），均不触引擎生命周期。
- **DB 变更白名单**：schema.ts 仅 +`series` / `episodes` 两表（平台级通用，论证对齐 M8 style_presets / M9 通用资产承载——两级结构服务全部体裁的剧集制作）；db/index.ts 幂等迁移同款；其余表零改动。
- **桌面端不碰业务**〔已取消〕：apps/desktop 独立包；server 仅 +静态托管一段（env 无值 = 现行为逐字不变）——桌面端取消后此红线退化为「静态托管不碰业务」，已实证。
- **不引运行时新依赖于 server**〔已核查〕：electron / electron-builder 未进入任何依赖链（lockfile 零记录；随桌面端取消自动满足）。
- **既有行为等价**：无 `_params` 的 run、无 series 的项目、Web 直连 dev 模式——三者路径零漂移。

---

## §4 数据与接口变更清单

**schema.ts**
- `+ series`：id / projectId / name / totalEpisodes / contentAssetId / createdAt / updatedAt（`idx_series_project`）
- `+ episodes`：id / projectId / seriesId / number / title / status / contentAssetId / latestRunId / createdAt / updatedAt（唯一 `(projectId, number)` + `idx_episodes_series`）

**routes**
- `routes/series.ts` 新（6 端点）；`runs.ts` +1 后置回写（约 10 行）；`app.ts` +1 挂载 + 静态托管段；`env.ts` +1 常量。

**services**
- `series.ts` 新（纯函数 + 数据访问，探针可 import）。

**Web**
- `RunFormModal.vue` +集级覆盖折叠区；`SeriesBoard.vue` 新；`ProjectDetailView.vue` +剧集地图卡；`api.ts` / `types.ts` +series / episodes 类型与调用。

**desktop（新包）〔已取消，2026-09-12：scaffold 全量删除、git 零残留〕**
- 原设计文件（`package.json` / `tsconfig.json` / `scripts/main.ts` / `electron-builder.yml` / `.gitignore`）**未保留**。

---

## §5 验收标准（实弹）

1. **静态**：双端 typecheck 0 错误；`probe:m14` 全绿（四节：params / series / static / regression——params 含白名单矩阵 / clamp / 未知键 400 / context 三层叠加优先级；series 含 CRUD / 派生 status / 联动回写 / 扩容缩容 / 409 矩阵 / 坏 JSON；static 含 SPA 回退 / 穿越防护 / api 优先级）。
2. **集级参数实弹**：项目 10 起 run（mengbao）带 `_params.image.size` 与 `video.duration` → gen_task params 快照命中覆盖值；同步骤重跑（不带覆盖的历史 run）零漂移。
3. **剧集实体实弹**：项目 10 建剧（N 集）→ 起 2 集 run（episode_number 联动 `latest_run_id`）→ 集状态派生正确；缩容 / 删除保护 409 矩阵实测。
4. **静态托管（原桌面端项缩围）**：prod 静态托管冒烟（`CSTUDIO_WEB_DIST` 指向 dist → 首页 200 + `/assets/*` 200 + 未知路径回退 index.html）；electron 安装包 / dev 窗口项随桌面端取消（`apps/desktop` 已删除）。
5. **回归**：`probe:m7 / m8 / m10 / m11 / m12 / m13` 全绿（项目设置链 / 合成链 / 素材链零漂移）；无 series 项目的运行端点在旧库上行为不变。
6. **越界核查**：engine / refs / loader / 模板 / 提示词零 diff；改动面清单与 §4 一致。

## §6 风险与回滚

- **Electron 构建链路不可用**〔随桌面端取消关闭〕：原降级预案（保留 scaffold）不适用——2026-09-12 实际处置为整体取消 + scaffold 删除；本行保留为决策记录。
- **`_params` 误伤既有 run** → 上下文处「无键零行为」+ 探针逐字等价断言（无 `_params` 时 settings 对象与现版本 deep-equal）。
- **series 派生 status 读放大** → 集数量级小（数十），listEpisodes 内单查询 join 即可；如后续放大再议缓存。
- **回滚**：desktop 包已删除（回 Web 形态，零 server 行为变化）；两表删除迁移即回旧库（数据不依赖）。

## §7 实施计划（P1–P6）

- **P1**：schema + 迁移 + `services/series.ts` + `services/run-params.ts`（校验纯函数）+ routes/series + runs 联动回写。
- **P2**：context 叠加 + app.ts 静态托管 + env.ts。
- **P3**：Web（RunFormModal 覆盖区 / SeriesBoard / ProjectDetailView 卡 / api / types）。
- **P4**：`probe-m14.ts` 四节 + package.json `probe:m14` + 回归全组。
- **P5**〔取消〕：apps/desktop 全包（main.ts / builder yml / 图标）——scaffold 曾建成后按决策整体删除（2026-09-12）。
- **P6**：实弹（参数 / 剧集 / 静态托管冒烟）+ 文档三件（roadmap M14 注记 / README 能力速览与验收快照 / m14-review）。

## §8 明确排除（不做，非缺陷）

per-shot 音效（依赖每镜音频绑定，另立）、在线可编程供应商（P2 集群剩余）、剧集级的级联批量运行计划表（排产日历）、**桌面端（Electron 形态整体——2026-09-12 决策取消，详见 §2.3；原「自动更新 / 托盘常驻 / 多窗口」「mac / linux 打包目标」等子项随之终局）**、集级参数的运行中热调（run 启动后不可改 `_params`，要改走重跑）。
