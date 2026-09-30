# agencys-content-studio M16 设计文档（创作画布）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

> 里程碑：M16（2026-09-13 立项）｜上游：M15 流水线画布（同名「画布」但异质）· M5+ 供应商适配层 · M9/M12 资产中心与质检 · M13 实体参考图 · M14 平台层收官
> 性质：**第二类画布——创作画布**（内容"怎么做得出来"：自由摆放素材 + 引用连线 + 就地生成与编辑，写模型）。与 M15 流水线画布（流程"怎么跑"：纯读监控 + 操作台，零写端点）并存互不替代。
> 用户决策（2026-09-13）：① 立项开发（spec 评审后实施）；② 范围四档全收——最小创作闭环 / 就地编辑类 / 流水线联动 / 模板化沉淀。
> 红线影响：**首次引入新表**（画布文档属写模型，既有 17 表无处可复用；明示並沿运行时建表惯例）；引擎调度链 / refs / loader / 生成主链零触碰。

---

## §1 背景与目标

### 1.1 现状（勘察结论，2026-09-13）

| 方向 | 现状 |
|---|---|
| 画布 | M15 流水线画布（`/canvas`）为 run/模板可视化 + 工作台，**纯读零写**；自由创作型画布空白 |
| 生成能力 | 适配层齐备：7 图像 + 5 视频适配器（`resolveEndpoint` / `buildImageRequest` / `buildVideoRequest`）；`gen_tasks` 的 `runId`/`stepId` 均可空；**但无「单点直连生成」通道**——pipeline actions（ai_image/ai_video）全为批处理/分镜驱动（需 shots JSON 资产），画布不可复用 |
| 编辑能力 | 全库零局部重绘/扩图/蒙版能力（`types.ts` 无相关声明）；供应商侧可对表阿里万相编辑系（wanx2.1-imageedit function 分派 / wanx-x-painting / image-out-painting） |
| 数据模型 | 零画布文档表；节点/边/布局无处存放。资产中心完备（sha256 去重 / 缩略 / 质检 `scheduleImageCheck` / 软删），`assets.purpose` 为开放文本可直接扩（`creation` / `creation_video` / `mask`） |
| 任务体系 | `gen_tasks` 状态机 + `POST /tasks/:id/cancel`（仅需 pending/processing，**画布可直接复用**）；`POST /tasks/:id/retry` 要求 runId+stepId（画布不适用，重跑走节点端点）；`recoverInterruptedState` 重启恢复先例 |
| 实时 | socket `studio.event` 8 类事件仅覆盖 run/task；画布无事件；房间正则 `/^(run\|project):\d+$/` 需扩 |
| Web | pan/zoom/fit 已由 M15 `CanvasBoard.vue` 手绘验证（但组件面向只读，M16 另写 `board-viewport.ts` 组合式，**不改 M15**）；`AssetPreviewer` 可复用 |
| 模板 | YAML 单向编辑；`POST /templates/validate`（纯校验）可服务端直调同源函数；无「画布 → 模板」反向路径 |
| 数据库惯例 | M3 后新增全部走 `ensureTable` / `ensureColumn` 运行时幂等兜底（`migrate` 仅 0000 基线） |

### 1.2 目标

1. **自由创作**：项目级画布文档——素材节点自由摆放、引用连线（端口语义：reference / first_frame / last_frame / source）、就地生成（文生图 / 图生图 / 文生视频 / 图生视频）、产物自动入库资产。
2. **就地编辑**：局部重绘（inpaint）/ 消除（erase）/ 扩图（outpaint）三类编辑节点，涂抹蒙版绘制弹窗；能力**声明制**——供应商未声明则该模式置灰（错误透传不炸）。
3. **双向联动**：run 产物「送入创作画布」二创；画布成品「设为实体参考图」；画布素材「送去运行」（模板启动输入预填）。
4. **模板化沉淀**：画布复制；画布 → 流水线模板草案（低保真导出 + 既有校验函数自检 + 前端可复制）。

---

## §2 范围

### 2.1 数据模型（`schema.ts` +3 表 +1 列；`db/index.ts` 挂运行时兜底）

```ts
// canvases：画布文档（项目域）
{ id, projectId: notNull, name: text notNull default '未命名画布',
  viewport: text notNull default '{"x":0,"y":0,"zoom":1}',   // JSON：pan/zoom 持久化
  createdAt, updatedAt }

// canvas_nodes：节点（最小化——不存状态与结果，全部由 gen_tasks 派生）
{ id, canvasId: notNull, kind: text notNull,        // 'asset' | 'gen'
  assetId: integer nullable,                        // kind=asset：引用项目资产
  title: text nullable,
  spec: text nullable,                              // JSON，仅 kind=gen
  x: real notNull default 0, y: real notNull default 0,
  createdAt, updatedAt }
// 索引：idx_canvas_nodes_canvas(canvasId)

// canvas_edges：引用连线（手画，非调度语义）
{ id, canvasId: notNull,
  from: integer notNull, to: integer notNull,       // 节点 id（均属同一画布）
  port: text notNull,                               // 'reference'|'first_frame'|'last_frame'|'source'
  createdAt }
// 约束：UNIQUE(canvasId, from, to, port)；索引 idx_canvas_edges_canvas(canvasId)

// gen_tasks：+1 列
canvasNodeId: integer nullable                     // 画布任务归属（run/step 均为 null）
```

**spec JSON 结构**（gen 节点）：

```ts
{ genKind: 'image' | 'video', prompt: string,
  size?: string, duration?: number, resolution?: string, aspectRatio?: string,   // 生成参数
  provider?: string, model?: string,                    // 端点覆盖（缺省走 resolveEndpoint）
  useStylePreset?: boolean,                             // 默认 true，对齐 ai_image use_style_preset 口径
  edit?: { mode: 'inpaint' | 'erase' | 'outpaint',
           maskAssetId?: number,                        // inpaint/erase 必填
           expand?: { angle?: number; xScale?: number; yScale?: number } } }    // outpaint 用
```

**端口规则矩阵**（建边校验 + 执行时重建，同源纯函数）：

| 端口 | 目标节点 | 数量上限 | 输入类型 |
|---|---|---|---|
| reference | image gen ≤6；video gen ≤2 | 6 / 2 | 仅图片产物 |
| first_frame / last_frame | 仅 video gen | 各 ≤1 | 仅图片产物 |
| source | 仅 edit 节点（spec.edit 存在） | 1 | 仅图片产物 |

- `from` 须为：素材节点（assetId 存在）或**已有成功产物的 gen 节点**（结果即资产）。
- **环检测**：建边前沿既有边做可达性检查，`to → … → from` 已达时拒绝（400），拒绝必成环。
- 连线语义 = 引用快照：执行时取上游**当前最新成功产物**；上游软删资产 → readiness 问题列出（不炸）。

### 2.2 服务端文档层（`services/creation.ts` 新 + `routes/creation.ts` 新 + `app.ts` 挂载）

**`buildCanvasDoc(canvasId)`**（画布不存在 → 404；前端全量对账的唯一读模型）：

```
{ canvas: { id, projectId, name, viewport },
  nodes: [{ id, kind, x, y, title, assetId?,
            asset?: AssetView,                    // 素材节点（含结果）批量查 + 同构 toAssetView 子集（带缩略）
            spec?, status,                        // gen 节点：status = 最新任务状态（无任务 → 'idle'）
            latestTask?: { id, status, attempts, errorMsg, taskId, resultAssetId, resultAsset?, createdAt, completedAt },
            tasks?: 最近 5 条摘要,
            readiness: { ready: boolean, problems: string[] },   // 输入齐备性预检（prompt 非空 / 上游产物就绪 / mask 齐备）
            editCapability?: { inpaint, erase, outpaint },       // edit 节点：当前图像供应商 capability 声明快照
            canRun, canCancel }],
  edges: [{ id, from, to, port }] }
```

- gen 节点状态/结果**零存量**：单查询按 `canvasNodeId` 聚 `gen_tasks`（取每节点最新一条 + 结果资产）。
- 宽容降级：坏 spec JSON / 上游资产缺失 → readiness 问题列出；孤儿引用（节点被删）不可能（删节点级联删边）。

**routes/creation.ts（14 枚）**：

| 端点 | 说明 |
|---|---|
| `GET /projects/:id/canvases` | 画布列表（含节点数/更新时间） |
| `POST /projects/:id/canvases` | 新建 `{ name? }` |
| `GET /canvases/:id` | 画布文档（buildCanvasDoc） |
| `PATCH /canvases/:id` | 改名 / 存视口 `{ name?, viewport? }` |
| `DELETE /canvases/:id` | 删画布（级联节点 + 边） |
| `POST /canvases/:id/nodes` | 建节点：`{ kind:'asset', assetId, x, y }` 或 `{ kind:'gen', spec, x, y }`（资产项目域校验 `assertProjectAssets` 复用） |
| `PATCH /nodes/:id` | 更新 `{ x?, y?, title?, spec? }`（spec 合法校验） |
| `DELETE /nodes/:id` | 删节点（级联其边） |
| `POST /canvases/:id/edges` | 建边 `{ from, to, port }`（矩阵 + 环检测） |
| `DELETE /edges/:id` | 删边 |
| `POST /nodes/:id/run` | 执行 gen 节点（见 2.3；readiness 不过 → 400 附 problems） |
| `POST /canvases/:id/duplicate` | 复制画布 `{ name? }`（节点 id 映射后重建边） |
| `POST /canvases/:id/template-draft` | 模板草案 `{ key? }` → `{ yaml, validation }`（见 2.7） |
| `POST /entities/:id/ref-assets` | 联动：资产并集挂接实体 `{ asset_ids }`（复用 `attachRefAssets`；项目域校验） |

### 2.3 画布执行通道（`services/creation-gen.ts` 新，不复用 pipeline actions）

- **任务归属**：`gen_tasks` 行 `{ projectId, runId: null, stepId: null, canvasNodeId, kind: spec.genKind, provider, model, prompt, params: JSON }`。
- **直连适配层**（镜像 `ai_image.runOneTask` 模式，逐点对齐）：
  1. `attempts+1` → `processing` → emit `canvas.changed`
  2. `resolveNodeInputs`：边 → 上游资产 → `assetToDataUri`（缓存 Map）；编辑节点 source = baseImage、mask = dataURI
  3. 编辑模式（spec.edit）→ `adapter.edit(req)`；否则 `buildImageRequest`/`buildVideoRequest` + `adapter.generate`
  4. 图片：结果 → `saveGeneratedMedia(purpose:'creation')` → `resultAssetId` → `succeeded`；`scheduleImageCheck(asset)` 同口径
  5. 视频：第三方 taskId → `pollVideoTask` 模式（POLL_INTERVAL_MS / 10min deadline / 每轮查 cancelled）→ `saveGeneratedMedia(purpose:'creation_video')`
  6. `recordUsage`（projectId 归属）；风格注入：`useStylePreset !== false` → `resolveProjectStyleSnippets(projectId)`（对齐 ai_image）
  7. 失败：`attempts < 2` 自动重试 1 次（镜像 ai_image）；否则 `failed` + `errorMsg`；每状态转移 emit `canvas.changed`
- **并发**：进程内信号量 ≤2（常量 `CANVAS_MAX_CONCURRENCY = 2`）；排队任务保持 `pending`。
- **取消**：复用 `POST /tasks/:id/cancel`（零改动）；视频轮询中途停（同 ai-video）；图片生成不可中断——取消 = 标记弃存（返回后查 status，cancelled 则不落产物）。
- **崩溃恢复**：`recoverCanvasTasks()` 于 index.ts 启动序列（`recoverInterruptedState` 旁）——`canvasNodeId IS NOT NULL` 且 `pending|processing` → `failed('服务重启中断')`；不自动重排队（画布重跑成本 = 一次点击）。
- **纯函数拆分**（probe 零网络可测）：`resolveNodeInputs(node, doc)` 纯逻辑层（边 → 输入 assetId 映射 + problems 列表）；`buildNodeTaskParams(spec, ctx)`（spec → gen_tasks 行参数）；`editCapabilityOf(provider)`（adapter 声明快照）。

### 2.4 编辑能力扩展（`adapters/types.ts` + `aliyun-wan-image.ts`）

```ts
// ImageAdapter 可选扩展（零破坏：既有 7 个适配器不声明即无编辑能力）
readonly editing?: { inpaint?: boolean; outpaint?: boolean }   // erase 归一在 inpaint 系（mask+指令变体）
edit?(req: ImageEditRequest): Promise<GeneratedImage>

export interface ImageEditRequest {
  mode: 'inpaint' | 'erase' | 'outpaint'
  baseImage: string                     // data URI
  mask?: string                         // data URI（inpaint/erase 必填）
  prompt?: string                       // inpaint 必填；erase 可空
  expand?: { angle?: number; xScale?: number; yScale?: number }
  size?: string
  baseUrl: string; apiKey: string; model?: string
  extra?: Record<string, unknown>
}
```

- **首家扩充 `aliyun-wan-image.ts`**（同实例生成 + 编辑）：对表阿里万相编辑系——主选 `wanx2.1-imageedit` function 分派（`description_edit_with_mask`=inpaint / `expand`=outpaint），局部重绘备选 `wanx-x-painting`、扩图备选 `image-out-painting`；**映射表在 P5 实施时定稿，probe 只测「声明 + 请求构造快照」（零网络）**。
- **能力声明制**：供应商未声明 `editing` → inspector 对应模式置灰（`editCapability` 全 false）；已声明但账户未开通 → 错误原样透传为任务 `errorMsg`。
- **指令式整图编辑**（"换成夜晚"）不设独立 mode——由「以图生图」节点（reference 端口挂源图 + 指令 prompt）承担近似语义，零新协议（description_edit 独立通道入 backlog）。
- **蒙版资产**：`EditBrushModal` 涂抹 → 导出 PNG（白 = 重绘区 / 黑底 = 保留；最长边 1024）→ multipart 上传 `POST /projects/:id/imports`（purpose `'mask'`，复用 sha256 去重）→ 回填 `spec.edit.maskAssetId`。

### 2.5 Web 创作画布

- **路由与导航**：`/creation?project=<id>&canvas=<id>`；`App.vue` nav「创作」+ `Icon.vue` +`wand`；`router.ts` +1（懒加载同惯例）。
- **页面骨架 `CreationView.vue`**：顶栏（项目选择器 + 画布选择器〔切换/新建/复制/删除〕+ 适应视图 + 「送去运行」+ 「导出模板草案」）；左 = 素材面板（项目图像资产列表，HTML5 拖入画布）；中 = `CreationBoard.vue`；右 = `CreationInspector.vue`；选中状态同步 URL。
- **`CreationBoard.vue`**（手绘零新依赖）：
  - 世界层 `translate(pan) scale(zoom)`；边 = `<svg><path>` 贝塞尔；节点 = 绝对定位卡片（**宽 220**）。
  - pan/zoom 由 `lib/board-viewport.ts` 组合式函数提供（M15 CanvasBoard 模式移植：`setPointerCapture` / 滚轮光标锚定 `Math.exp(-deltaY*0.0012)` / fit / **zoom ∈ [0.2, 2.5]**）；**M15 CanvasBoard 零 diff**。
  - 节点卡：素材节点 = 缩略图 + 标题；gen 节点 = 类型图标（photo/video）+ prompt 截断 + 状态徽标 + 结果缩略；端口圆点——gen 左侧按 spec 渲染输入端口（reference / first_frame / last_frame / source），右侧输出端口 1 个；素材节点仅输出。
  - 交互：节点拖拽（pointer 事件，本地即时 + pointerup 后 `PATCH /nodes/:id`）；连线（输出口 pointerdown → 目标输入口 pointerup → `POST /edges`；空白释放取消）；删边（点选 + `×`）；空白双击/工具栏「新建节点」建生成节点（落点世界坐标）；drop 文件 → `imports` + 建素材节点（落点坐标）；素材面板拖入同径；pan/zoom 停止后 500ms 防抖 `PATCH /canvases/:id { viewport }`。
- **`CreationInspector.vue`**：素材节点 = 预览（`AssetPreviewer`）/ 标题 / 「设为实体参考图」/ 删节点；gen 节点 = spec 表单（genKind 切换、prompt、size/duration/aspectRatio/provider 覆盖、useStylePreset）/ 输入区（入边列表 + 断开）/ readiness 问题列表 / 执行（run）/ 取消（canCancel）/ 任务历史（最近 5 条）/ 结果预览 / 「设为实体参考图」；edit 节点另加「打开蒙版编辑器」+ 模式与参数（expand 三元组）。
- **`EditBrushModal.vue`**：`<canvas>` 底图 + 涂抹（白色圆笔刷 / 橡皮 / 笔刷尺寸 / 清空）→ 导出蒙版 PNG → upload purpose `mask` → 回填 spec；**手绘 canvas 原语零新依赖**。
- **`CanvasTargetModal.vue`**：目标画布选择（列表 / 新建），供 M15 抽屉与本页复用。
- **实时对账**：join `canvas:<id>` 房间；`canvas.changed` → 350ms 防抖重拉 `GET /canvases/:id`（全量替换数据层，**保 pan/zoom/选中**）。

### 2.6 联动（三枚）

1. **run 产物 → 画布**：M15 `CanvasDrawer` 产物区 + 「送入创作画布」按钮（`CanvasView`/`RunDetailView` 注入 `projectId`，run 行已有）→ `CanvasTargetModal` 选画布/新建 → `POST /canvases/:id/nodes { kind:'asset', assetId }`（落点 = 视口中心）。
2. **画布产物 → 实体**：节点操作「设为实体参考图」（素材节点或 gen 结果可取 assetId）→ `POST /entities/:id/ref-assets { asset_ids }`（并集挂接，`attachRefAssets` 复用）。
3. **画布素材 → 运行**：顶栏「送去运行」→ 收集选中/画布内素材资产 ids → 既有 `RunFormModal` `prefillInput { setting_docs: ids }`（mengbao 模板 files 接受图片；未声明键被 `normalizeInput` 静默丢弃，安全）+ 提示文案。

### 2.7 模板化沉淀

- **复制**：`POST /canvases/:id/duplicate` —— 画布行 + 节点（免拷贝 spec/assetId 引用）+ 边（旧→新 nodeId 映射重建）。
- **草案导出**：`buildTemplateDraft(doc)` 纯函数——gen 节点拓扑序 → 每节点一 step（`key: n_<nodeId>`，action `ai_image`/`ai_video`；prompt 与画布参数以注释保留 + `# TODO 待人工补全` 标注式）；边 → `after: [...]`；素材节点引用 → 注释提示；骨架含 name/description/version/inputs: []。返回 `{ yaml, validation }`——`validation` 由与 `POST /templates/validate` 同源的校验纯函数直调（不绕 HTTP）；前端展示 + 复制按钮。**低保真定位**：面向人工接手完善，非一键可运行模板。

### 2.8 实时事件

- `events.ts` +`{ type: 'canvas.changed'; canvasId: number; projectId: number; nodeId?: number }`。
- `index.ts`：房间正则扩 `/^(run|project|canvas):\d+$/`；桥接 `canvas.changed` → `canvas:<id>` + `project:<id>` 双投（canvas→projectId 缓存，同 runProjectIdOf 模式）；启动序列 + `recoverCanvasTasks()`。
- 执行通道每状态转移（pending→processing→succeeded/failed/cancelled）emit。

### 2.9 探针（`scripts/probe-m16.ts`，六节，零网络可测）

| 节 | 断言点 |
|---|---|
| `canvas-doc` | 画布 CRUD / 节点 CRUD / 边矩阵（端口 × 数量 × 类型 × 环检测）/ 删节点级联边 / 删画布级联 / 派生读模型（任务状态映射、readiness、editCapability 快照）/ 宽容（坏 spec）/ 项目域校验 |
| `node-build` | `resolveNodeInputs` 纯逻辑矩阵（各端口映射、上限、缺失上游 → problems）；`buildNodeTaskParams` 快照（覆盖参数 / 风格注入 / edit 摘要） |
| `edit-cap` | 适配器声明快照（aliyun-wan `editing` 声明 + `editCapabilityOf`）；`buildEditRequest`（baseImage/mask/expand 映射）零网络快照；未声明供应商 → 模式全 false |
| `draft` | `buildTemplateDraft` 输出快照（step/after/注释）+ validation 与 `/templates/validate` 同源一致性 |
| `linkage` | ref-assets 并集挂接 / 送入画布建素材节点 / prefill 键安全性（未声明键丢弃） |
| `regression` | 既有全部 probe 组 + 引擎调度/生成主链零漂移抽样（gen_tasks 新列不影响既有查询） |

- 执行通道失败路径全链路断言：**无端点配置环境下** run → 任务行落库 → 失败（错误透传）→ 状态复位，无需真实网络。

---

## §3 红线复核

- **首次打破「零新表」**：+3 表 +gen_tasks 1 列——画布文档为写模型，属必要引入（M15 画布为读模型故零表）；沿用 M3 后惯例：`schema.ts` 声明 + `db/index.ts` `ensureTable`/`ensureColumn` 运行时幂等兜底（旧库升级不炸；`migrate` 基线不动）。
- **零新依赖**：涂抹 = canvas 原语；连线/拖拽 = pointer events + SVG；pan/zoom = M15 已验证手绘模式。
- **生成主链零改动**：pipeline actions / engine / dag / refs / loader / net / 既有适配器零 diff（aliyun-wan 仅 +声明+edit 方法，`generate` 路径不动）。
- **M15 画布零 diff**：`CanvasBoard.vue` 不动（board-viewport 新写）；`CanvasDrawer` 仅 +1 按钮（联动）；M15 探针全量回归。
- **宽容降级**：坏 spec/缺资产/未开通编辑 → readiness 列出或错误透传，不炸不静默；写门禁全部在服务端（前端只渲染判定结果）。
- **任务语义**：画布任务不伪造 run/step（`runId/stepId` 恒 null）——任务列表/重试端点自然不误伤；取消复用既有端点。

---

## §4 数据与接口变更清单

**server（新文件）**
- `services/creation.ts`：文档层（buildCanvasDoc + CRUD + 校验矩阵 + 环检测 + duplicate + buildTemplateDraft）
- `services/creation-gen.ts`：执行通道（resolveNodeInputs / buildNodeTaskParams / runCanvasNodeTask / recoverCanvasTasks）
- `routes/creation.ts`：14 枚端点

**server（改动）**
- `db/schema.ts`：+3 表 +`genTasks.canvasNodeId`
- `db/index.ts`：ensureTable ×3 + ensureColumn ×1
- `adapters/types.ts`：+`editing` / `edit` / `ImageEditRequest`（可选，零破坏）
- `adapters/aliyun-wan-image.ts`：+编辑能力实现
- `services/events.ts`：+1 事件类型；`index.ts`：房间正则 + 桥接 + recoverCanvasTasks 调用
- `app.ts`：+1 挂载行；`package.json`：+`probe:m16` 脚本

**web（新文件）**
- `views/CreationView.vue`（页壳 + 顶栏 + 对账）
- `components/CreationBoard.vue`（世界层/节点/连线/拖拽/drop）
- `components/CreationInspector.vue`（属性与操作）
- `components/EditBrushModal.vue`（蒙版涂抹）
- `components/CanvasTargetModal.vue`（目标画布选择）
- `lib/board-viewport.ts`（pan/zoom/fit 组合式）

**web（改动）**
- `router.ts`（+1）、`App.vue`（+1 nav）、`Icon.vue`（+wand）、`lib/api.ts`（+creationApi）、`lib/types.ts`（+CanvasDoc 等）、`components/CanvasDrawer.vue`（+「送入创作画布」按钮）

**探针**
- `apps/server/scripts/probe-m16.ts`（六节）

---

## §5 验收标准（实弹）

1. **静态**：双端 typecheck 0 错误；`probe:m16` 六节全绿 + 既有 probe 全量回归；旧库（既有 data 目录）启动幂等升级无报错。
2. **画布实弹（浏览器 DOM）**：创建画布 → 素材拖入摆放 → 双击建生成节点 → 连线（各端口）→ 执行（**零计费供应商 pollinations 真实出图**）→ 结果节点回显 + 素材面板可见 → 下游节点引用上游产物再生成 → 编辑节点蒙版涂抹（视 key 可用性小额真实验证；不可用时验证声明置灰与错误透传）→ pan/zoom/fit 与刷新后视口保持 → 联动三枚入口全部可达 → 模板草案导出可复制。
3. **零漂移**：M15 画布（run/模板视图、抽屉操作）逐项回归无变化；既有页面零变化。
4. **文档**：README M16 能力速览 + 验收快照；roadmap M16 注记 + 红线表更新（创作画布已引入/新表已引入）；`m16-review.md`（代码审查）。

---

## §6 风险与回滚

- **旧库升级** → ensureTable/ensureColumn 幂等兜底 + 实弹旧库启动验证；schema.ts 与运行时兜底双写保持一致。
- **编辑供应商可达性**（key 未开通 / 模型不可达）→ 能力声明置灰 + 错误透传；不阻断生成主链；映射表 P5 定稿时以最小真实调用校准。
- **并发与限流** → 信号量 ≤2 + 失败自动重试 1 次（镜像 ai_image）；排队任务 UI 可见（pending）。
- **崩溃中断** → recoverCanvasTasks 标 failed + 节点一键重跑。
- **循环引用** → 建边环检测拒绝（400 附原因）。
- **大画布性能** → 目标 ~30 节点流畅；全量渲染（无虚拟化，超规模入 backlog）。
- **回滚**：web 摘路由/nav/按钮；server 删 3 新文件与挂载行、适配器编辑实现可留（未调用即惰性）；DB 新表/新列保留无害（旧代码零读取）；probe:m16 脚本可留。

---

## §7 实施计划（P1–P7）

- **P1**：数据模型（schema + db 兜底）+ `services/creation.ts` 文档层 + `routes/creation.ts`（除 run/draft）+ probe `canvas-doc` 节。
- **P2**：Web 画布页骨架（CreationView/Board/Inspector + board-viewport + api/types/router/nav/icon）+ 素材拖入与自由摆放（对 P1 端点）。
- **P3**：连线交互 + 文档对账实时（事件 + 房间）+ `creation-gen.ts` 执行通道 + 图片节点全链路 + probe `node-build` 节。
- **P4**：视频节点（轮询/取消/重跑）+ 实弹（零计费真生成）。
- **P5**：编辑通道（types 扩展 + aliyun-wan edit + EditBrushModal + inspector 编辑态）+ probe `edit-cap` 节。
- **P6**：联动三枚（CanvasDrawer 按钮 / ref-assets / 送去运行）+ 沉淀（duplicate / template-draft）+ probe `linkage`+`draft` 节。
- **P7**：双端 typecheck + 全量探针 + 实弹 DOM 验收 + 文档三件（README / roadmap / m16-review）。

---

## §8 明确排除（不做，非缺陷）

- **多选/框选/撤销重做/节点成组**（画布交互增强另立 backlog）。
- **跨画布复制节点**（画布间搬运走「复制画布」整体语义）。
- **画布协作/分享**（单机单用户，无账户体系）。
- **节点 resize / 自定义卡片尺寸**（固定 220 宽）。
- **tts 音频生成节点**（backlog；音频仍走流水线流内）。
- **画布导出 png/svg / 打印**。
- **力导向自动布局**（自由摆放即语义；自动布局入 backlog）。
- **指令式整图编辑独立通道**（description_edit；由图生图节点承担近似语义）。
- **画布 → 模板一键可运行**（草案为低保真，必人工完善）。
