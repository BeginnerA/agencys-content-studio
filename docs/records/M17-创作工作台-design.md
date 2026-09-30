# agencys-content-studio M17 设计文档（创作工作台）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

> 里程碑：M17（2026-09-13 立项）｜上游：M16 创作画布 · M15 流水线画布 · M13 实体参考图 · M5+ 供应商适配层 · TTS/LLM/FFmpeg 既有服务
> 性质：**创作画布从「带连线的执行器」到「完整创作工作台」**——创作循环（怎么出好图）、规模操控（怎么管一堆节点）、产出沉淀（做完怎么出去）、能力扩展（音频与合成 / AI 辅助）四层一次补齐。
> 用户决策（2026-09-13）：① 立项开发（spec 评审后实施）；② **范围全量纳入**——原「可缓/推后」项（文本节点 / 产物导出 / 内嵌运行节点 / 音频 / 故事板 / AI 辅助）一并纳入，13 项缺口无一排除。
> 红线影响：canvas_nodes +2 列（adopted_task_id / seq，ensureColumn 幂等）；端口矩阵 v2（+prompt/video/audio；reference 扩实体源；补 from 侧类型校验）；**唯一破坏性交互变更**：空白左键拖拽由「平移」改为「框选」（平移改空格/中键，spec/README 双处明示）。M16 既有 14 端点全部超集兼容；生成主链 / M15 流水线画布零 diff；零新依赖（fflate 已在依赖）。

---

## §1 背景与目标

### 1.1 现状（勘察结论，2026-09-13）

| 方向 | 现状 |
|---|---|
| 创作循环 | 一次执行只出 1 个结果、重跑后旧结果只能看不能选；节点对外引用恒为「最新成功产物」——**挑不了、钉不住**；reference 端口只收图片素材节点，**实体参考图集（M13）无法作为画布输入**；prompt 写死在每个 gen 节点，改一处风格要逐节点重填 |
| 规模操控 | 零键盘交互（无任何 keydown）；无多选/框选；误删边**完全不可逆**；画布内节点无法复制；一组节点只能逐个挪；无批量执行与一键整理 |
| 产出沉淀 | 「送去运行」强跳 `/runs/:id`，画布留不住「运行」这一等公民；产物逐个预览、无打包出口；节点一多缺全局问题总览；节点无叙事序号维度 |
| 声音与合成 | tts 只在流水线流内（`pipeline/actions/tts.ts` + `services/tts.ts` 六级声线链齐备），画布无音频节点；无「图→视频→配音」合成出口（`services/ffmpeg.ts` 三级兜底可复用） |
| AI 辅助 | `services/llm.ts`（resolveLlmEndpoint / chatComplete / LlmNotConfiguredError）齐备，但画布零接入 |
| 关键复用 | `fflate@^0.8.3` 已在 server 依赖（zip 零新增）；`resolveVoiceChain` / `synthSpeech` / `recordUsage(kind:'tts')` 可直接复用；`pipeline_runs` / `pipeline_steps`（run 节点数据源）；`assets`（kind: image\|video\|audio\|text\|archive，purpose 开放文本）；`runApi.detail/cancel`（run 节点轮询/取消）；浏览器零依赖交互（pointer events / SVG / canvas / `<audio>`） |

### 1.2 目标

1. **创作循环收敛**：变体抽卡（一次 1–4 张）+ 结果画廊 + 采纳钉稿（下游引用「采纳产物」）；实体节点参考直通（refAssetIds 展开截断）；文本节点提示词复用（一稿多图、改一处全生效）。
2. **工作台操控**：多选/框选、批量移动·复制·删除、快捷键全集、撤销/重做（命令栈）、一键整理（拓扑分层）与对齐/分布、故事板序号。
3. **产出沉淀**：内嵌运行节点（run 上画布、实时状态、不跳转）；产物打包导出（zip → archive 资产 → 既有下载通道）；全局状态总览（点击定位）。
4. **能力扩展**：音频 TTS 生成节点（图→视频→配音闭环）与视频合成节点（concat + 混音）；AI 辅助（提示词扩写 + 规则式一键串联成草稿）。

---

## §2 范围

### 2.1 数据模型（`schema.ts` canvas_nodes +2 列；`db/index.ts` ensureColumn ×2）

```ts
// canvas_nodes：+2 列（kind 注释更新为 asset|gen|text|entity|run）
adoptedTaskId: integer nullable   // 结果采纳：指向本节点的一次 gen_tasks.id（null = 未采纳）
seq: integer nullable             // 故事板序号（1 起；排序/整理/导出命名依据）

// spec JSON 扩展（kind=gen 的 genKind 扩 'audio' | 'compose'；新 kind 各自 spec）：
// gen/image|video：既有结构不变（prompt/size/duration/.../edit?）
// gen/audio  ：{ genKind:'audio', prompt, voice?, speed?, provider?, model? }
// gen/compose：{ genKind:'compose', resolution?, fps? }          // 输入全部来自连线
// text       ：{ text }                                          // 提示词/文案
// entity     ：{ entityId }                                      // characters 行（项目实体或全局实体）
// run        ：{ runId }                                         // pipeline_runs 行（须属同项目）
```

- **采纳语义**：`pickDisplayTask(node, tasks)` 统一决策——`adoptedTaskId` 有效（属本节点 + succeeded + 有产物）→ 该任务；否则最新成功任务。**节点对外引用（下游输入）与节点显示（画廊当前）同源走此函数**（M16「最新成功产物」语义的自然超集）。
- **seq 语义**：仅排序/呈现（卡片 `#N` 徽标、整理排序、导出命名），不参与执行。

### 2.2 节点类型与端口矩阵 v2（`creation.ts` 校验扩展）

**端口规则矩阵 v2**（建边校验 + 执行时重建，同源纯函数）：

| 端口 | 目标 | 上限 | 源（from） |
|---|---|---|---|
| reference | image gen ≤6；video gen ≤2 | 6 / 2 | 素材节点（图片资产）· gen 产图 · **entity 节点**（执行时展开 refAssetIds，超限截断记 notes） |
| first_frame / last_frame | 仅 video gen | 各 ≤1 | 素材节点 · gen 产图（不变） |
| source | 仅 edit 节点 | 1 | 不变 |
| **prompt（新）** | image / video / audio gen | 各 ≤1 | **仅 text 节点** |
| **video（新）** | 仅 compose | 4 | 素材节点（视频资产）· gen 产视频 |
| **audio（新）** | 仅 compose | 4 | 素材节点（音频资产）· gen 产音频 |

- **from 侧类型校验补齐**（M16 仅校验 to）：建边时同时校验源节点类型与产物类型（按资产 kind / 任务产物类型；错误信息列出期望类型）；执行时仍以 readiness 兜底。
- **run 节点不参与任何连线**（双向拒绝 400）。
- prompt 端口语义：执行 prompt = 文本节点内容（trim；**覆盖 spec.prompt**，spec.prompt 保留为无连线时的兜底）；空文本 → readiness problem。
- 环检测 / 自环 / 重复边（UNIQUE）/ 跨画布拒绝——延续不变。
- 无输入端口者：asset / text / entity（纯源）+ run（游离节点）。

### 2.3 创作循环（变体采纳 / 实体直通 / 文本复用）

**变体与采纳**
- `POST /nodes/:id/run` 超集：`{ variants?: 1–4 }`（默认 1）——服务端循环建 N 条任务（同 `canvasNodeId`，随信号量排队）；响应 `{ ok, taskId, taskIds }`（`taskId = taskIds[0]` 保留兼容）。
- `PATCH /nodes/:id` 超集：`{ adoptedTaskId?: number | null }`——校验（属本节点 + succeeded + 有 resultAssetId），null 清除采纳。
- 读模型：节点 + `adoptedTaskId` + `displayTaskId`（派生）+ `results`（最近成功 ≤12：`{ taskId, assetId, asset, createdAt }`）。
- Web：Inspector 结果画廊（缩略横排 + 「采纳 ✓ / 最新」徽标 + 点击大图预览 + 采纳/取消采纳）；执行区「变体数」选择（1–4，按钮文案「执行 ×N」）。

**实体参考直通**
- 新 kind `entity`：`POST /canvases/:id/nodes { kind:'entity', entityId, x, y }`——校验实体存在且（项目实体属同项目 | 全局实体）。
- 卡片：实体名 + 类型徽标（character\|scene\|prop）+ 参考图数 + 首张缩略；entity → reference 边：执行展开（REF_CAP 截断 + notes）。
- readiness：refAssetIds 空 → problem「实体无参考图」。

**文本节点与提示词复用**
- 新 kind `text`：`{ kind:'text', spec:{ text }, x, y }`；PATCH 可改 spec（沿用 spec 校验通道）。
- prompt 端口连接（见 2.2）；Inspector：textarea 直编（blur 提交 PATCH，入撤销栈）+「AI 扩写」（2.7）。
- `POST /nodes/:id/extract { x?, y? }`：源 = gen 节点（spec.prompt）或文本资产节点（读资产全文）→ 新建 text 节点（未给坐标时源节点右侧偏移放置）→ `{ node }`。

### 2.4 工作台操控

**选择模型（唯一破坏性交互变更，README 明示）**
- `selectedIds: number[]`（替换单 `selectedId`）；Inspector：单选详情 / 多选浮出批量面板。
- **空白左键拖 = 框选**（半透明选框，释放按全包含判定选中）；**平移改为空格按住 + 左键拖 / 中键拖**（光标 grab/grabbing）。
- Shift+点击 = 加/减选；空白左键单击 = 清空；Esc = 清空 / 取消进行中的连线。
- 多拖：拖动任一选中节点 = 整组移动（本地即时预览，pointerup 后 `nodes/batch` 一次提交，入撤销栈一条）。

**快捷键（Board 级；输入框聚焦时除 Esc 全部让行）**

| 键 | 行为 |
|---|---|
| Delete / Backspace | 删除选中（批量删除） |
| Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y | 撤销 / 重做 |
| Ctrl+D | 复制选中（偏移 +40,+40） |
| Ctrl+A | 全选 |
| 方向键 / Shift+方向键 | 微移 10px / 1px（批量提交） |
| 空格（按住） | 平移模式 |
| F / Esc | 适应视图 / 取消 |

**撤销/重做（`lib/canvas-history.ts` 新，客户端命令栈）**
- `{ label, undo(), redo() }` 上限 100；入栈：移动、新建（双击/drop/菜单）、删除（节点/边）、连线、复制、整理/对齐/分布、编号、串联、采纳、字段 PATCH；不入栈：pan/zoom/选中/执行/导出。
- 删除的逆操作 = 快照重建：删除前记录节点全量数据 + 关联边 → undo：`POST nodes`（id 重映射）→ `POST edges` 重建 → `PATCH` 恢复 adoptedTaskId/seq；任一步失败 → toast + 清栈（不做半吊子回滚）。
- 对账（socket 重拉）不主动清栈；栈执行失败 → toast 跳过。

**批量面板（多选 ≥2 浮出，Board 底部浮动条）**
- 对齐（左/右/上/下）· 分布（水平/垂直）→ `arrange` 端点（服务端包围盒计算，与单节点整理同源纯函数）；复制 → `nodes/copy`；删除 → `nodes/delete`；执行 → `canvases/run { nodeIds }`（就绪者入队、未就绪 skipped + problems 提示）；串联 → `nodes/chain`；编号 → `nodes/batch`（按 x 坐标序编 seq 1..N）；整理 → `arrange { nodeIds }`。

**一键整理（整画布）**：顶栏「整理布局」→ `arrange mode:'layered'`——层深 = 最长上游路径，同层按 (seq, x, y) 纵向排列；列宽 300 / 行高 240；锚定现有包围盒左上角。纯函数 `computeArrange()`（探针断言）+ 端点落库。

### 2.5 产出沉淀

**内嵌运行节点（kind='run'）**
- 创建：画布「送去运行」→ RunFormModal 启动后 `onRunStarted` 改造——**不跳转**，在视口中心建 run 节点（校验 runId 存在且属同项目）+ toast（附「查看详情」入口）；另支持 `POST nodes { kind:'run', runId }` 直接建。
- 读模型：批查 `pipeline_runs` + `pipeline_steps` 计数 → `{ id, templateKey, status, startedAt, completedAt, steps: { succeeded, total } }`。
- 实时：存在非终态 run 节点时客户端 5s 轮询 `runApi.detail`（终态后停止；不扩 socket）。
- 卡片：run 名/模板 + 状态徽标 + 步骤进度；Inspector：概要 +「打开运行详情」（/runs/:id）+「取消」（非终态，复用 runApi.cancel）。
- run 节点不可执行、不参与连线、无 spec 编辑（title 可改）。

**产物打包导出**
- `POST /canvases/:id/export { nodeIds? }` → fflate `zipSync` 打包 → `registerAsset(kind:'archive', purpose:'creation_export')` → `{ asset:{id,name,size}, stats:{ packed, skipped } }`；下载复用既有 `GET /assets/:id/file?download=1`（零新下载管道，对齐 exportApi.fileUrl 先例）。
- 打包对象：asset 节点（其资产）/ gen 节点（`pickDisplayTask` 产物）/ text 节点（导出 `.txt`）；entity / run 节点不打包（manifest 记录）。
- 条目命名：`<seq?>-<title|node-<id>>-<assetId>.<ext>`（重名递增）；`manifest.json`（画布 id/name/项目、导出时间、节点清单：id/kind/title/seq/assetId/fileName/prompt 摘要）；软删产物 → skipped 记账不炸。

**故事板组织**
- seq 字段（1 起）+ 卡片 `#N` 徽标；批量「编号」按选中 x 序编 1..N。
- 「按序号排列」：`arrange mode:'grid' sortBy:'seq'`（有 seq 优先，无 seq 按位置序；行优先、列数 = max(2, ceil(√n))）。
- 导出（zip 命名 + manifest）按 seq 排序呈现。
- 不做独立时间轴视图（§8）。

**全局状态总览**
- 顶栏「总览」→ 右侧抽屉：由 doc 派生（零端点），按严重度排序（failed > 未就绪 › 运行中/排队 > 就绪 > 完成/空闲）；行 = 状态点 + 标题 + 摘要；点击 → 选中 + 视口居中。

### 2.6 音频与合成

**audio 生成节点（复用 services/tts.ts，零新适配器）**
- spec：`{ genKind:'audio', prompt（朗读文本）, voice?, speed?, provider?, model? }`；prompt 来源：prompt 端口（text 节点）> spec.prompt。
- 执行（`creation-gen.ts` 第四执行径）：`resolveAudioEndpoint(spec.provider)` → `resolveVoiceChain({ paramVoice: spec.voice, settingsVoice, instanceVoice })` → `synthSpeech(text, ep, { voice, speed })` → 写盘 → `registerAsset(kind:'audio', purpose:'creation_audio', mime 'audio/mpeg')` → `recordUsage(kind:'tts', unit:'char')`；失败重试/自动重试对齐既有（attempts ≤2）。
- Inspector：文本区 + voice/speed + 结果 `<audio controls>` 试听。

**compose 合成节点（复用 services/ffmpeg.ts，零新依赖）**
- spec：`{ genKind:'compose', resolution?, fps? }`（v1 可空跟随源）；输入：video 端口（≥1，按边创建序拼接）+ audio 端口（可选，amix 混音；有音轨时丢弃视频原声，无音轨输出 an）。
- 执行：`planNodeInputs`（video/audio 集合）→ 本地文件路径 → `buildComposeArgs()` 纯函数（探针断言 argv 快照）→ `resolveFfmpeg` spawn → `registerAsset(kind:'video', purpose:'creation_compose')`；纳入 `CANVAS_MAX_CONCURRENCY` 信号量。
- readiness：video 输入 0 → problem；音频文件缺失 → problem。
- Inspector：输入序列（视频序）+ 参数 + 结果视频预览。

**素材面板扩展**：Tab（图片/视频/音频）沿用资产列表查询；音频/视频资产拖入建 asset 节点（既有逻辑兼容任意 kind）。

### 2.7 AI 辅助

- **提示词扩写**：`POST /nodes/:id/prompt-expand { instruction? }`——取内容（text 节点 spec.text / gen 节点 spec.prompt）→ `chatComplete`（内联系统提示：创作提示词扩写，不改原意、丰富镜头/光影/风格细节、单段中文）→ `{ prompt, provider, model }`（不落库）；未配置 LLM → `LlmNotConfiguredError` 400 透传（前端引导 Settings）。Web：Inspector「AI 扩写」→ 对照弹窗（原/新，可编辑）→「应用」PATCH（入栈）。
- **规则式串联**：`POST /canvases/:id/nodes/chain { ids }`——按给定顺序对相邻对自动建边（确定规则）：text → prompt；视频源 → video（compose）；音频源 → audio（compose）；图像源 → reference（image/video gen，reference 满额则 video 的 first_frame）；已存在边 / 上限满 / 类型不符 / 环 → skip 记账 `{ from, to, reason }`；返回 `{ created, skipped }`。
- 用量口径：扩写调用对齐既有 LLM 调用用量记法（M4 usage 体系若覆盖 llm 类型则同径记录，实施时对齐）。

### 2.8 端点一览（14 既有超集兼容 + 9 新增 = 23 枚）

**新增 9**

| 端点 | 说明 |
|---|---|
| `POST /canvases/:id/nodes/batch` | 批量部分更新 `{ updates:[{id,x?,y?,title?,spec?,seq?,adoptedTaskId?}] }`（预校验全量合法才写；spec 校验同 PATCH） |
| `POST /canvases/:id/nodes/delete` | 批量删除 `{ ids }`（级联边；返回 `{ deleted, edges }`） |
| `POST /canvases/:id/nodes/copy` | 批量复制 `{ ids, offset? }`（spec/assetId/adoptedTaskId/seq 深拷；集合内部边重映射重建；返回 `{ nodes, edges }`） |
| `POST /canvases/:id/nodes/chain` | 规则式串联（见 2.7） |
| `POST /canvases/:id/arrange` | 整理/对齐/分布 `{ mode:'layered' \| 'grid' \| 'align-*' \| 'distribute-*', nodeIds?, sortBy? }` → `{ updated, positions }` |
| `POST /canvases/:id/run` | 批量执行 `{ nodeIds?, variants? }` → `{ started:[{nodeId,taskId}], skipped:[{nodeId,problems}] }`（只入队就绪节点；不级联等待） |
| `POST /canvases/:id/export` | 打包导出（见 2.5） |
| `POST /nodes/:id/extract` | 提取文本节点（见 2.3） |
| `POST /nodes/:id/prompt-expand` | AI 扩写（见 2.7） |

**既有扩展 3**

| 端点 | 扩展 |
|---|---|
| `POST /canvases/:id/nodes` | kind 扩 `text \| entity \| run`（相应字段 spec / entityId / runId；asset/gen 旧形态零变化） |
| `POST /nodes/:id/run` | `+variants`；响应 `+taskIds`（保留 `taskId`） |
| `PATCH /nodes/:id` | `+adoptedTaskId +seq`（spec 放宽至 text 节点） |

**buildCanvasDoc v2**（对旧字段只增不改）：节点通用 `{ id, kind, x, y, title, seq?, readiness{ready,problems,notes}, canRun, canCancel }`；asset `{assetId, asset?}`；gen `{spec, status, adoptedTaskId?, displayTaskId?, latestTask?, displayTask?, results[], tasks(5), editCapability?}`；text `{spec}`；entity `{spec, entity{id,name,kind,refCount,asset?}}`；run `{spec, run{...,steps}}`。

### 2.9 探针（`scripts/probe-m17.ts`，九节，零网络可测；对齐 M16 隔离策略：临时目录 + fetch stub + `app.request` 内存全链）

| 节 | 断言点 |
|---|---|
| `node-kinds` | text/entity/run 创建/更新/删除；entity 项目域与全局实体；run 派生（status/steps 计数）；新读模型派生；错误族 |
| `port-v2` | 矩阵 v2 全组合（prompt/video/audio 端口 × from 类型；entity→reference；run 拒连；上限；回归环检测/自环/跨画布/重复边） |
| `input-v2` | planNodeInputs v2（prompt 覆盖语义、entity 展开截断 + notes、compose 输入边序）+ `pickDisplayTask` 采纳优先纯函数矩阵 |
| `variant-adopt` | variants 建 N 任务；PATCH adoptedTaskId 全校验（属本节点/成功/有产物/清除）；doc displayTask 派生；run 响应超集兼容 |
| `batch-ops` | batch 预校验回滚；delete 级联计数；copy 内部边重映射；chain 规则矩阵（含 skipped 全因）；arrange 各 mode 纯函数 + 落库；canvases/run started/skipped |
| `run-node` | run 节点 CRUD + 拒连；doc 批查 pipeline_runs/steps；终态/非终态派生 |
| `export` | zip 解包（fflate unzipSync）：条目名 / manifest / seq 命名 / text txt / 缺失产物 skipped |
| `llm-assist` | prompt-expand 未配置 → 400 透传（fetch stub 注响应断言成功径）；extract 双径（gen / 文本资产） |
| `regression` | probe:m15 / probe:m16 子进程全绿 + M16 端点旧 body 兼容抽样 + 引擎主链零漂移 |

---

## §3 红线复核

- **数据模型**：canvas_nodes +2 列走 `ensureColumn`（同 M16 ensureTable 惯例；`migrate` 基线不动）；旧库升级幂等。
- **端点兼容**：M16 14 端点全部超集（旧 body → 旧行为；响应只增字段）。
- **生成主链零改动**：引擎 / pipeline actions / dag / refs / loader / 适配器零 diff；audio 仅只读复用 `services/tts.ts`，compose 仅只读复用 `services/ffmpeg.ts`。
- **M15 流水线画布零 diff**：CanvasBoard / CanvasView / CanvasDrawer 不动；「送去运行不跳转」仅改 CreationView 内回调。
- **零新依赖**：zip（fflate 既有）、撤销栈/框选/快捷键（原生 pointer/keyboard）、音频播放（原生 `<audio>`）。
- **破坏性交互明示**：左拖=框选 / 空格·中键=平移——spec 与 README 双处书写；页面空态引导文案同步。
- **宽容降级**：实体截断 notes / 导出缺失 skipped / 坏 spec problems / LLM·TTS 未配置错误透传——延续 M16 口径。

---

## §4 数据与接口变更清单

**server（新文件）**
- `services/creation-ops.ts`：批量（batch/delete/copy）+ chain 规则 + arrange 纯函数 + extract + prompt-expand
- `services/creation-export.ts`：zip 打包（fflate）+ manifest + 资产注册
- `scripts/probe-m17.ts`：九节探针

**server（改动）**
- `db/schema.ts`：canvas_nodes +2 列 + kind/spec 注释；`db/index.ts`：ensureColumn ×2
- `services/creation.ts`：kind 扩充（text/entity/run）、端口矩阵 v2、from 侧校验、读模型 v2、pickDisplayTask、readiness notes、extract 支撑
- `services/creation-gen.ts`：variants、audio 执行径、compose 执行径、批量执行入口（buildComposeArgs 纯函数）
- `routes/creation.ts`：+9 端点 +3 扩展（14 → 23）
- `package.json`：`+probe:m17`

**web（新文件）**
- `lib/canvas-history.ts`（命令栈：入栈 / 撤销 / 重做 / 清栈）

**web（改动）**
- `components/CreationBoard.vue`（大改：selectedIds / 框选 / 快捷键 / 多拖 / 新卡型卡片 / seq 徽标 / 批量浮动条）
- `views/CreationView.vue`（顶栏 +整理/+导出/+总览；onRunStarted 改造；run 轮询；总览抽屉）
- `components/CreationInspector.vue`（画廊采纳 / text / entity / run / audio / compose 表单 + AI 扩写 + 提取）
- `lib/api.ts`（+creationApi 新方法）、`lib/types.ts`（CanvasDoc v2）、`components/Icon.vue`（+图标：text/entity/run/audio/compose/undo/redo/arrange 等）

---

## §5 验收标准（实弹）

1. **静态**：双端 typecheck 0 错误；`probe:m17` 九节全绿；`probe:m15` / `probe:m16` 全量回归绿；旧库（既有 data 目录）启动幂等升级无报错。
2. **画布实弹（浏览器 DOM）**：文本节点 → 实体节点 → 连线（prompt / entity→reference）→ 变体执行（2 张）→ 画廊切换与采纳 → 下游取采纳产物生成 → 批量执行（started/skipped）→ 框选多拖 → 快捷键（Delete + Ctrl+Z 快照重建恢复）→ 一键整理/对齐 → 序号编号 → 导出 zip 下载并解包核对 manifest → 送去运行（建 run 节点、状态轮询、不跳转）→ 音频节点（TTS 可用时真实验证；不可用验证错误透传）→ compose 合成（本地 ffmpeg 真实验证）→ 总览定位。
3. **零漂移**：M15 流水线画布逐项回归无变化；M16 既有交互（连线/拖拽/drop/蒙版/模板草案/联动三枚）回归通过。
4. **文档**：README M17 能力速览 + 交互变更说明 + 验收快照；roadmap M17 注记 + 排除项回收注记；`m17-review.md`（代码审查）。

---

## §6 风险与回滚

- **框选破坏性变更**（用户习惯成本）→ README + 空态引导 + toast 提示三处明示；平移改空格/中键为业界通行交互。
- **撤销栈与服务端漂移**（对账/并发操作）→ 栈执行失败 toast + 清栈；删除重建两步失败 → 明确提示手动重跑。
- **音频/compose 供应商与本地依赖** → 错误透传为任务 failed（对齐 M16 编辑宽容）；ffmpeg 三级兜底。
- **大画布规模化**（批量/框选/画廊）→ 目标 ~50 节点流畅；全量渲染不虚拟化（超规模入 backlog）。
- **zip 内存**（zipSync 全内存）→ 画布级产物量可控；超大提示 + 流式打包入 backlog。
- **LLM 未配置** → 400 引导 Settings，不影响画布主流程。
- **回滚**：web 摘 UI（Board/View/Inspector 改动为叠加式）；server 删 2 新服务文件 + 新端点不挂即 404；+2 列保留无害（旧代码零读取）；probe:m17 可留。

---

## §7 实施计划（P1–P7）

- **P1**：数据模型（+2 列）+ `creation.ts` 文档层 v2（kind / 端口 v2 / 读模型 / 采纳优先 / extract）+ probe `node-kinds` / `port-v2` / `input-v2`。
- **P2**：`creation-ops.ts`（batch/delete/copy/chain/arrange）+ 路由挂载 + `canvases/run` 批量执行 + probe `batch-ops`。
- **P3**：`creation-gen.ts`（variants / audio / compose / buildComposeArgs）+ `creation-export.ts` + prompt-expand + probe `variant-adopt` / `run-node` / `export` / `llm-assist`。
- **P4**：Web 底座（types/api + `canvas-history.ts` + Board 重构：selectedIds / 框选 / 快捷键 / 多拖 / 新卡型 / 徽标）。
- **P5**：Web 面板（Inspector 全型 + 画廊采纳 + AI 扩写；View 顶栏整理/导出/总览 + onRunStarted 改造 + run 轮询；批量浮动条）。
- **P6**：实弹全链路（DOM）+ `probe:m17` 全节 + `probe:m15` / `probe:m16` 回归。
- **P7**：文档三件（README / roadmap / m17-review）。

---

## §8 明确排除（不做，非缺陷）

- **自动级联执行**（任务完成自动触发下游——防爆量计费；批量执行只入队就绪节点，未就绪附 problems）。
- **跨画布复制节点**（走「复制画布」整体语义）。
- **画布 → 模板一键可运行**（草案仍为低保真，必人工完善）。
- **独立故事板时间轴视图**（seq 徽标 + 排序 + 导出命名替代）。
- **LLM 决策式自动编排**（chain 为确定性规则；LLM 编排入 backlog）。
- **图像拼图/网格合成**（compose 仅视频合成；拼图入 backlog）。
- **画布导出 png/svg 快照 / 打印**。
- **力导向布局**（规则式整理替代）。
- **节点成组 / 折叠 / resize / 迷你地图**。
- **多会话版本历史**（撤销栈 100 步覆盖会话内，不持久化）。
- **协作 / 分享**（单机单用户）。
- **run 节点产物批量拉入画布**（走 M16 既有「送入创作画布」）。
- **zip 流式打包 / 断点续传**（全内存 zipSync）。
- **M16 §8 回收说明**：多选/框选/撤销重做 ✅ 本版已收；tts 音频节点 ✅ 本版已收（扩为音频+合成闭环）；其余排除项延续（跨画布复制 / 协作 / 成组 / resize / png·svg 导出 / 力导向 / 指令式整图编辑 / 模板一键可运行）。
