# agencys-content-studio M7 技术设计规格（镜头级轻工作台 + 选镜拼接）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-12
- 上游：`2026-09-09-agencys-content-studio-roadmap.md`（北极星不变）；`2026-09-12-agencys-content-studio-m6-design.md` §1.3 排除项「镜头级工作台（单镜重生成 / 多版本选片 / 分镜图编辑）｜P1 级缺口，涉及 Web + API 新面，另立里程碑」——本里程碑即该落地；2026-09-12 三项目源码级对标结论（huobao 单集工作台：分镜编辑 / 时长单批编辑 / 失败重试；Toonflow 轨道工作台：多版本选片 / editImage——P1 缺口集群第①+②项）
- 红线复核：不新增 action（新面在 routes / services 层，复用既有 action 与引擎调度）；不新增 DB 表与列（复用 `pipeline_steps.output` / `assets.task_id` 版本组 / `gen_tasks.params` 快照）；不改引擎（engine.ts / refs.ts / loader.ts 零改动——返修走「重置状态 + engine.startRun」既有模式）；模板 version+1 向后兼容
- 设计原则三条：**① 状态重置 + startRun 复用**——返修不引入新调度，把目标步骤置 pending、run 置 queued、调用既有 `engine.startRun`，由现有 DAG 调度完成重跑（与 `tasks.ts` retry 同源手法）；**② 产物即选择**——多版本选片 / 选镜拼接 = 改写 `step.output.asset_ids`（子集 + 版本切换），下游 compose 经 `steps.x.assets` 引用自动消费，零 schema 变更；**③ 分镜 JSON 是唯一事实源**——时长 / 提示词编辑写分镜新版本资产（对齐 `approveGate` text_override 写新资产先例），重生成 / 重合成时经引用解析自然生效
- 备注：M6 实弹三项（图侧 refUsed / 视频侧首帧 / 全链）仍待用户在 Web 配好供应商后跑；M7 不依赖 M6 实弹结果，两者可并行推进

---

## 1. 定位与边界

### 1.1 一句话目标

把「成片后返修」从命令行级操作升级为镜头级工作台：

1. **镜头级轻工作台**（对标 huobao / Toonflow）：时长编辑（单镜 + 单批）、单镜重生成（幂等对账只跑目标镜）、多版本选片（同镜历史版本切换）；
2. **选镜拼接**（对标轨道工作台选择性拼接）：镜头子集剔除（不喜欢的镜直接不进片）+ 缺文件容错（skip+warn，一镜坏文件不再整体失败）+ 一键重新合成。

### 1.2 范围（做）

| # | 主项 | 内容 |
|---|---|---|
| P1 | 工作台聚合读 | 新 `GET /runs/:id/shot-board?step_key=`：分镜镜头 × 任务状态 × 历史版本 × 当前选中 × 合成新鲜度 五合一 |
| P2 | 分镜编辑 | 新 `POST /runs/:id/shots/edit`：时长/提示词字段级编辑 → 写分镜新版本资产并替换产出步骤 `output.asset_ids`（保位） |
| P3 | 单镜重生成 | 新 `POST /runs/:id/shots/regenerate`：重置该镜 task + 步骤 + run → `engine.startRun`（成功镜头经幂等对账自动跳过，只重跑目标镜） |
| P4 | 多版本选片 / 选镜 | 新 `POST /runs/:id/shots/select`：改写目标步骤 `output.asset_ids`（版本切换 + 子集剔除，按分镜序保序；`reset` 恢复全量最新） |
| P5 | 重新合成 | 新 `POST /runs/:id/recompose`：重置 ffmpeg_merge 步骤 → run 复位续跑（succeeded 镜头步骤全跳过，只重合成） |
| P6 | 合成容错与每镜时长 | ffmpeg-merge 改造：`shots` 可选输入（per-shot 时长覆盖）、缺文件/坏 kind 逐镜 skip+warn、fit_voice 显式优先、产物 `params.inputs` 快照（前端 stale 检测） |
| P7 | 模板接线 | mengbao-episode v6 → v7：compose_video 增 `shots: steps.make_storyboard.asset` 输入 |
| P8 | Web 工作台 | 新 `ShotBoard.vue`（RunDetailView 步骤卡内嵌）+ 合成步骤「重新合成」按钮 + stale 徽标 + api/types 扩展 |
| V1 | 验证 | `probe-m7.ts`（board / edit / regenerate / select / recompose / merge-plan 六节）+ 实弹目检 + 兼容回归 |

### 1.3 M7 不做（明确排除）

| 排除项 | 理由 |
|---|---|
| 镜头拖拽重排 / 顺序调整 | 顺序恒等于分镜 shots 序（`voices` 连播与 `fit_voice` 均分依赖此对齐语义）；重排属可视化编辑器范畴，另立 |
| 分镜可视化大编辑器（新增/删除镜头、改 characters 引用等） | M7 只做「时长 + 提示词」字段级编辑；结构性编辑走既有「驳回重跑 make_storyboard / 手编 JSON」路径 |
| 上传图片替换分镜（外来图入镜） | 选片闭环限定生成版本组（`asset.taskId ∈ 该步骤任务集`）；外来图上传替换属可视化编辑范畴（与拖拽重排 / 大编辑器同源），另立 backlog |
| 跨步骤资产混选 | select 校验 `asset.taskId ∈ 该步骤任务集`，防跨步乱选 |
| 旧版本自动清理 / 收藏 | 历史版本保留在资产表（软删语义不变）；清理策略另立 backlog |
| 图像检测（Toonflow 特有） | 独立能力，backlog |
| 引擎级「单步重跑」接口 | 不新增引擎方法；统一走「重置 + startRun」，引擎零改动 |
| 合成字幕/音轨的镜头级重对齐 | SRT 与配音轨成对（subtitle 步骤产出），镜头变化不改音字时间轴（见 §3.7 边界）；motion 路径音画对齐依赖生成时长，目检为准 |
| BGM / 音效、转场特效 | P2 小缺口，backlog |

---

## 2. 现状与复用面（代码证据，2026-09-12 核实）

### 2.1 已就绪（本次改造的直接地基）

| 面 | 现状 | 证据 |
|---|---|---|
| 引擎终态短路 | `runChain` 对 completed/cancelled/failed 立即 return（返修须先置 run queued） | `pipeline/engine.ts` L202 |
| 就绪集仅 pending | `row.status !== 'pending'` 不参与调度（重跑须先置步骤 pending） | engine.ts L286 |
| 失败收敛先于执行 | 任一步骤 failed → run 立即 failed 并 break（**「除目标外无 failed」校验的依据**） | engine.ts L271-281 |
| 步骤执行自增 attempts | `attempts: step.attempts + 1`（重置步骤无需动 attempts） | engine.ts L465 |
| resolved 输入写回 | `resolveInputs` 结果写回 `step.input`（工作台经 `input.shots[0]` 定位分镜源） | engine.ts L471-480 |
| 任务重置先例 | retry：task 归零 → step pending → run queued → `startRun` | `routes/tasks.ts` L54-64 |
| 引用解析 | `steps.x.assets` → 上游 succeeded/skipped 步骤的 `output.asset_ids`（改写即被下游消费） | `pipeline/refs.ts` L59-73 / L215-237 |
| 幂等对账 | 未成功任务执行时同步最新 prompt/params；failed 且有变化归零重排队；succeeded 不动 | `actions/ai-image.ts` L128-151、`actions/ai-video.ts` L141-165 |
| 每镜任务唯一 | `taskByShotId` 对账 + 产物按 shots 序聚合 `resultAssetId` | ai-image.ts L86-99 / L180-186 |
| 版本组天然键 | 每次生成新资产行、`assets.task_id = gen_tasks.id`（同镜历史 = 同任务组的资产序列） | ai-image.ts L247-259、`db/schema.ts` L111 |
| 写库带溯源 | ai_text / ai_image / ai_video 产物均带 `stepId / runId / taskId / params.shotId` | ai-text.ts L111-121、ai-image.ts L247-259 |
| 分镜编辑先例 | `approveGate` text_override：写新文本资产并替换 `output.asset_ids`（保留 gate 记录） | engine.ts L96-124 |
| ffmpeg-merge 现语义 | 全局 `duration_per_shot`（L59）；互斥硬校验（L70-72）；缺文件 throw（L77）；fit_voice 均分（L146-173）；产物 params 仅记数量（L268-277） | `actions/ffmpeg-merge.ts` |
| Web 任务面板 | TaskPanel 已按 run 列任务 + 重试/取消/预览 + socket 事件 | `apps/web/src/components/TaskPanel.vue` |

### 2.2 缺口（M7 要补）

1. **工作台读面缺失**：shots × tasks × versions × 选中 需多处拼接查询，无聚合端点（assets 列表也不支持按 run/step/taskId 过滤，`routes/assets.ts` L14-29）；
2. **返修路径缺失**：`tasks.retry` 仅 failed/cancelled 任务、拒绝 completed run（tasks.ts L43-52）——succeeded 镜头重生成与 completed run 返修无路可走；
3. **选片/拼接无 API**：`output.asset_ids` 只能被 action 重写；`PATCH /assets/:id` 仅 name/favorite/tags（assets.ts L110-126）；
4. **合成硬失败**：缺一个镜头文件整个合成 failed（ffmpeg-merge.ts L77）；
5. **时长仅全局**：`duration_per_shot` 对所有静态镜一刀切（L59 / L80）；
6. **无重新合成触发**：compose succeeded 后永不重跑（引擎 succeeded 跳过语义）。

### 2.3 关键机制推演（M7 依赖的三条结论）

1. **单镜重生成 = task 重置 + 步骤重跑**：把目标镜 task 置 pending（保留 `resultAssetId` 作历史）→ 步骤置 pending → run 置 queued → `startRun`；action 重跑时幂等段「succeeded 任务跳过」→ 只有目标镜真正重新生成，其余镜复用旧产物；
2. **选片 = 改写 `output.asset_ids`**：compose 重跑时 `steps.gen_images.assets` 经 `loadStepOutputs` 读新列表 → 无需 schema 变更、无需改 refs；
3. **返修防呆**：因失败收敛先于执行（§2.1），「除目标步骤外存在 failed 步骤」时重跑必然再次立即 failed → 端点须前置校验拒绝（先修复其他失败步骤）。

---

## 3. 设计（决策完备）

### 3.1 服务层（新 `apps/server/src/services/shot-workbench.ts`，纯 DB 层，可测）

> 分界：服务层只做「校验 + 数据库状态变更」，**不调用 engine**；`engine.startRun` 统一由路由层在服务返回后同步调用（对齐 tasks.ts retry 的手法，且让探针可无副作用断言重置语义）。

```ts
/** 聚合读：boards 五合一（shots × tasks × versions × selected × compose 新鲜度） */
export async function buildShotBoard(runId: number, stepKey: string): Promise<ShotBoard>

/** 分镜编辑：时长/提示词 → 写新分镜资产 + 替换产出步骤 output 保位；返回 { assetId, assetIds } */
export async function applyStoryboardEdits(
  runId: number, stepKey: string,
  items: Array<{ shot_id: string; image_prompt?: string; motion_prompt?: string; duration?: number }>,
): Promise<{ assetId: number; assetIds: number[]; edited: number }>

/** 单镜重生成：校验 + 重置（task / step / run）；返回 { runId, taskId }（路由层随后 startRun） */
export async function resetShotForRegenerate(runId: number, stepKey: string, shotId: string): Promise<{ runId: number; taskId: number }>

/** 选片/选镜：picks 校验 + 改写 output.asset_ids（分镜序）；reset=true 恢复全量最新 */
export async function applyShotSelection(
  runId: number, stepKey: string,
  opts: { picks?: Array<{ shot_id: string; asset_id: number }>; reset?: boolean },
): Promise<{ assetIds: number[] }>

/** 重新合成：校验 + 重置 ffmpeg_merge 步骤 / run；返回 { runId }（路由层随后 startRun） */
export async function resetStepForRecompose(runId: number, stepKey: string): Promise<{ runId: number }>

/** 返修通用校验（供路由/服务内部共用；违规抛 HttpError） */
export async function assertRepairable(runId: number, stepKey: string): Promise<{ run: PipelineRun; step: PipelineStep }>
```

**公共语义（函数内统一实现）**：

- `assertRepairable`：
  - run 存在；`run.status ∈ {completed, failed}`（running / queued / waiting_input / cancelled 一律 400：cancelled 走既有 resume，waiting_input 先处理闸门）；
  - 目标步骤存在且 `status ∈ {succeeded, failed}`（skipped / pending / running 拒绝）；
  - 该 run 全部步骤行中 `status=failed` 的集合 ⊆ {目标步骤}，否则 400「存在其他失败步骤，请先修复」；
- 目标步骤限定 `actionKey ∈ {ai_image, ai_video}`（工作台类）/ `= ffmpeg_merge`（重合成类）；
- 分镜源定位：目标步骤 `input` JSON 的 `shots[0]` → 资产行 → **产出步骤当前 `output.asset_ids` 中的 storyboard 资产优先**（工作台编辑保位替换后为最新；无溯源回退输入引用）→ 读文本 → `JSON.parse`（兼容裸数组与 `{shots:[]}` 两形态，与 ai-image 解析一致）；解析失败/无 shots → 400；
- 产出步骤定位（仅编辑用）：分镜资产 `stepId` → 该步骤行（runId 必须与目标 run 一致）→ 替换其 `output.asset_ids` 中旧分镜 id 的位置为新 id（保位；`gate` / `skipped` 字段原样保留；找不到则 400「分镜资产无产出步骤溯源，暂不支持编辑」）。

### 3.2 API 面（新 `routes/shots.ts`，app.ts 注册一行）

#### ① `GET /runs/:id/shot-board?step_key=`

响应（决策完备契约）：

```jsonc
{
  "step": { "id": 12, "key": "gen_images", "title": "批量镜头出图", "action": "ai_image", "status": "succeeded" },
  "shots": [{
    "shotId": "s1",
    "order": 0,
    "imagePrompt": "…",            // 分镜 JSON 当前值（编辑后为最新）
    "motionPrompt": "…",           // 可为空串
    "duration": 4,                 // 分镜 JSON 当前值（duration 优先回退 duration_sec）；无 → null
    "task": { "id": 5, "status": "succeeded", "attempts": 1, "errorMsg": null, "prompt": "…" },  // 无 → null
    "selectedAssetId": 88,         // 当前 output.asset_ids 中命中该镜的资产；无 → null
    "versions": [{ "id": 88, "name": "…", "createdAt": 0, "width": 832, "height": 1248, "duration": null, "prompt": "…",
                   "urls": { "file": "/api/v1/assets/88/file", "thumb": "/api/v1/assets/88/thumb" } }]
  }],
  "compose": {                     // run 无 ffmpeg_merge 步骤 → null
    "stepKey": "compose_video",
    "composedAt": 1700000000000,   // 成片资产 createdAt
    "stale": true                  // true/false/null（null=旧产物无快照，无法判定）
  },
  "repairable": { "ok": true, "reason": null }   // 前端按钮禁用依据（复用 assertRepairable 判定，不抛）
}
```

实现要点：
- shots 顺序 = 分镜 JSON 序；`versions` = `assets WHERE task_id IN (该步骤全部任务) AND deleted_at IS NULL ORDER BY created_at ASC`（版本组）；
- `selectedAssetId` 匹配：`output.asset_ids` 逐个读资产 `params.shotId` 命中该镜者（同一镜多点命中取首个）；
- `compose.stale` 判定（三源对比，任一不等 → true）：
  1. 成片资产 `params.inputs.images`（数组）vs `gen_images` 步骤当前 `output.asset_ids`（数组）；
  2. `params.inputs.motion_clips` vs `gen_motion` 当前 `output.asset_ids`；
  3. `params.inputs.shots_source`（分镜资产 id）vs 目标步骤 `input.shots[0]`；
  4. 成片无 `inputs` 字段（M7 前旧产物）→ `null`；
- `repairable`：只读判定版 assertRepairable（不抛错，返回 `{ok, reason}`）。

#### ② `POST /runs/:id/shots/edit`

```jsonc
// 请求
{ "step_key": "gen_images",
  "shots": [{ "shot_id": "s1", "duration": 6 }] }   // image_prompt / motion_prompt / duration 至少一项
// 响应
{ "ok": true, "asset_id": 123, "asset_ids": [123, ...], "edited": 1 }
```

- 校验：每项 shot_id 存在于分镜 JSON；`duration` 数字且 `0 < d ≤ 60`（保留一位小数）；prompt 非空 trim；至少一个字段实际变化（同值比较读双口径——duration 优先回退 duration_sec；无变化 → 400）；
- 写新资产：`writeTextAsset(projectId, { name: `${原名去扩展}-工作台编辑.json`, format: 'storyboard-json', purpose: 继承 origin.purpose, stepId: 产出步骤 id, runId, params: { edited_shots: [...shotId], source_asset_id: origin.id, editedAt }, tags: ['workbench'] })`；
- **不触发执行、不改 run 状态**；生效路径：重生成 / 重新合成时自然消费新分镜（见 §3.7）。

#### ③ `POST /runs/:id/shots/regenerate`

```jsonc
// 请求（可选编辑字段先走 applyStoryboardEdits，再重置——编辑失败则整体不动作）
{ "step_key": "gen_images", "shot_id": "s1",
  "image_prompt": "…", "motion_prompt": "…", "duration": 6 }
// 响应
{ "ok": true, "edited": true, "task": { … }, "step": { … }, "run": { … } }   // 快照（前端随即 loadDetail）
```

- 校验：`assertRepairable`；该步骤存在 `params.shotId === shot_id` 的 task（损坏参数行跳过）；
- 重置序列（事务式顺序执行）：
  1. task → `{ status:'pending', attempts:0, errorMsg:null, completedAt:null, updatedAt }`（**保留 resultAssetId**——失败重跑时旧版本仍在）；
  2. step → `{ status:'pending', error:null, completedAt:null, updatedAt }`（output 保留；attempts 留给引擎自增）；
  3. run → `{ status:'queued', error:null, completedAt:null, currentStepKey:null, updatedAt }`（summary 保留，重完成时覆盖）；
- 路由层随后 `engine.startRun(runId)`（与 tasks.ts retry 同款同步调用）。

#### ④ `POST /runs/:id/shots/select`

```jsonc
// 请求（二选一）
{ "step_key": "gen_images", "picks": [{ "shot_id": "s1", "asset_id": 91 }, { "shot_id": "s2", "asset_id": 88 }] }
{ "step_key": "gen_images", "reset": true }
// 响应
{ "ok": true, "asset_ids": [91, 88] }
```

- `picks` 校验矩阵：数组非空；shot_id 不重复；shot_id ∈ 分镜；asset 存在 / 属本项目 / 未删 / `kind` 匹配（ai_image→image，ai_video→video）/ `params.shotId === shot_id` / `asset.taskId ∈ 该步骤任务集`；任一不合 → 400（含具体项）；
- 排序：按分镜 shots 序（picks 提交序忽略）；**子集语义** = 未列入的镜头被剔除（不进成片）；允许 picks 与当前相同（幂等）；
- 写入：`output = { ...保留 gate/skipped, asset_ids: 序后数组 }`；
- `reset:true` → 恢复全量最新：分镜序 × 每镜 `task.resultAssetId`（无产物镜跳过）；
- **不触发执行**；run 活跃（running / queued / waiting_input）时拒绝（防与执行中 action 的 output 写入竞争）。

#### ⑤ `POST /runs/:id/recompose`

```jsonc
{ "step_key": "compose_video" }
// 响应 { "ok": true, "run": { … } }
```

- 校验：`assertRepairable` + `step.actionKey === 'ffmpeg_merge'`；
- 重置：step → `{ status:'pending', error:null, completedAt:null }`（output 保留，重合成成功后覆盖）；run → queued（同 ③）；
- 路由层 `engine.startRun(runId)`。

### 3.3 ffmpeg-merge 改造（向后兼容，`actions/ffmpeg-merge.ts`）

1. **可选输入 `shots`**（分镜 JSON 资产，v7 模板接线；v6 存量 run 无此输入 → 行为不变）：
   - 解析 `shots[]` 的 `id + 时长`（`duration` 优先回退 `duration_sec`——LLM 分镜实际口径；数字且 >0）→ `Map<shotId, duration>`；
   - 静态图段：`durSec = Map.get(asset.params.shotId) ?? durationPerShot`；有覆盖时日志「N 镜使用分镜时长」；
   - motion 段：保持不变（实际时长优先，供应商产出为准）；
2. **fit_voice 显式优先**（与 per-shot 覆盖联动）：显式时长镜固定不参与均分；剩余配音时长（`voiceSec − Σ显式`）均分给无显式镜；全部镜显式 → 跳过均分（日志「全部分镜已指定时长」）；剩余 ≤ 0 或探测失败 → 放弃适配回退（日志，现状语义）；单图口播撑长（needStretch）基准从 `durationPerShot` 改为「该镜当前 durSec（显式 ?? 全局）」；
3. **逐镜容错**（缺文件 / 坏 kind 不再整体 throw）：
   - 判定：`!a.relPath` 或文件 `statSync` 失败 → skip + `ctx.log`（含资产 id / 文件名）；`kind` 与模式不符 → 同路径 skip；
   - 全部被 skip → 保持 throw（沿用「无可用镜头资产」语义；
   - 产物 `params.skipped_shots: number[]`（被跳过资产 id）+ 日志逐条，UI 可溯源；
4. **产物 params 追加 inputs 快照**（stale 检测数据源）：
   ```jsonc
   { "inputs": { "images": [88, 89], "motion_clips": null, "shots_source": 123 } }
   ```
   （原始输入 id 数组原样记录——与被消费的 `output.asset_ids` 同口径；旧键 `images`（数量）/ `motion_clips`（数量）等全部保留不动）；
5. **导出纯函数**（可测性）：`export function computeShotSegments(rows, mode: 'images'|'clips', perShotDur: Map<string,number>, durationPerShot: number): { segments: Segment[]; skipped: number[] }`——段组装 + 时长决策 + 容错判定收敛于此，主函数调用之（探针直接断言，不发 ffmpeg）。

### 3.4 模板接线（mengbao-episode v6 → v7）

仅 `compose_video` 步骤增一行输入（其余 v6 原样）：

```yaml
  - key: compose_video
    action: ffmpeg_merge
    title: 合成成片
    inputs:
      images: steps.gen_images.assets
      motion_clips: steps.gen_motion.assets
      voices: steps.voice.assets
      subtitle: steps.subtitle.assets
      shots: steps.make_storyboard.asset    # 新增（M7）：每镜时长覆盖源
```

- `version: 6 → 7`；
- 模式矩阵不变（shots 恒非空：make_storyboard 必执行）；
- **存量 run 兼容**：v6 快照无 shots 输入 + 旧成片产物无 inputs 快照 → 合成行为与 stale 徽标一并优雅降级（见 §3.7）；
- quick-video / talking-clip 模板**不动**（单图口播场景时长意义低；无 shots 输入 = 全局时长行为不变）。

### 3.5 Web 工作台（`ShotBoard.vue` + RunDetailView 集成）

**挂载**：RunDetailView 步骤卡片内，`actionKey ∈ {ai_image, ai_video}` 的步骤渲染 `<ShotBoard :run-id :step :active @changed="loadDetail" />`；`ffmpeg_merge` 步骤卡片增「重新合成」按钮 + stale 徽标。

**组件布局**（自上而下）：

1. **头条**：`镜头工作台` + 汇总（`N 镜 · 已出 M · 失败 K`）+ stale 徽标（「镜头选择/分镜有更新，重新合成后生效」）+ 按钮组（「重新合成」「应用选择 (n)」——draft 存在时高亮）；
2. **批量工具行**：全选 checkbox + 「批量时长」输入 + 应用（生成 draft 的 duration 编辑项，统一走 edit 提交）+ 「恢复全量默认」按钮（select reset）；
3. **镜头网格**：每镜卡片——
   - 缩略图（image → `urls.thumb`；video → 首帧占位 + 播放图标，点击 AssetPreviewer 预览）；
   - `shotId` + 状态 badge（task.status；failed 显示错误摘要 tooltip）；
   - 时长输入（number，失焦/Enter 提交单条 edit → toast「重新合成后生效」）；
   - 提示词编辑（popover textarea，预填 imagePrompt）+「重生成」按钮（确认弹窗：提示重新计费 + 可选改词）→ regenerate；
   - 「版本 (n)」按钮 → 版本画廊（内联展开缩略图条，每版「选用」→ 更新 draft.selected）；
   - 启用/禁用开关（眼睛图标，切换 draft 包含状态）；
4. **交互约定（写死）**：
   - 时长编辑：change 即提交（单条 edit），刷新后输入框保留新值；
   - 版本选用 / 启用开关：**本地 draft**，点头条「应用选择」统一提交 select（提交后清 draft + 提示重新合成）；
   - 重生成：即时提交（含可选改词），执行进度由现有 TaskPanel / socket 事件呈现；
   - 重新合成：确认弹窗 → recompose → run 状态经既有事件流刷新（步骤卡回到 running → succeeded）；
   - `active`（run 运行中）时：操作按钮全部禁用（显示「执行中…」）；
   - 重生成后该步骤 `output.asset_ids` 重建为「全量最新」（选片状态重置）——toast 明示「已重建镜头列表，请重新选择/合成」；
5. **数据加载**：`onMounted` + `watch(props.step.status)` + `active` 时 3s 轮询（对齐 TaskPanel 惯例）；socket `task.updated` / 父组件 `changed` 触发重拉。

**api.ts / types.ts**：`shotApi = { board, edit, regenerate, select, recompose }`；类型 `ShotBoardData / ShotBoardShot / ShotVersion / ShotEditItem`。

### 3.6 返修语义边界（决策表，实施时零再决策）

| 场景 | 语义 |
|---|---|
| run 状态 running / queued / waiting_input | 所有返修端点 400（先处理闸门/等待收敛） |
| run 状态 cancelled | 400，提示走既有「断点续跑」（复制新 run 语义） |
| 除目标步骤外存在 failed 步骤 | 400「先修复其他失败步骤」（失败收敛先于执行，否则重跑必失败） |
| 目标步骤 skipped | 400（when 条件跳过的步骤重生成无意义；改输入重跑整链即可） |
| 分镜编辑 | 不自动重生成任何镜头：成功镜头保留原产物与原提示词快照（产物溯源不动）；仅被显式 regenerate 的镜头消费新值 |
| regenerate 后选片状态 | 该步骤 `output.asset_ids` 重建为「分镜序 × 每镜最新版本」——**选片被重置**（UI toast 明示） |
| select 后未重合成 | 成片不变；stale 徽标提示；用户显式点「重新合成」 |
| select 剔除镜头 | 镜头序列变短；静态路径 fit_voice 按有效镜数均分（成片仍与配音等长）；SRT 与配音轨时间轴不变（音字成对，不受镜头选择影响） |
| motion 路径选片/剔除 | 视频段按实际时长 concat；音画对齐依赖生成时长，请目检（现状固有语义，M7 不改） |
| 重新计费 | regenerate 会真实调用供应商（确认弹窗提示）；select / edit / recompose 零第三方成本 |
| 并发返修 | 重置与 startRun 幂等（重复重置无害）；不引入锁 |

### 3.7 兼容与降级

| 场景 | 语义 |
|---|---|
| v6 存量 run 重新合成 | 步骤快照无 shots 输入 → 全局 `duration_per_shot` 行为等价；compose 产物旧格式（无 inputs）→ stale = null（前端不显示徽标，仅提示「重新合成可确保最新」常态文案） |
| 分镜资产无 stepId（手动导入） | edit / regenerate（带编辑字段）400「暂不支持编辑」；纯 regenerate（无编辑）不受影响 |
| shot-board 遇损坏数据 | task params 损坏行跳过（与 action 一致）；分镜 JSON 解析失败 → shots=[] + repairable.reason 说明 |
| gen_refs 等非主线 ai_image 步骤 | 工作台天然可用（同结构 shots JSON）；无额外接线 |
| M6 实弹未跑 | 与 M7 无耦合；M7 实弹复用同一批供应商配置 |

---

## 4. 改动清单（文件级）

| 文件 | 改动 |
|---|---|
| `apps/server/src/services/shot-workbench.ts` | **新增**：buildShotBoard / applyStoryboardEdits / resetShotForRegenerate / applyShotSelection / resetStepForRecompose / assertRepairable |
| `apps/server/src/routes/shots.ts` | **新增**：5 端点（§3.2） |
| `apps/server/src/app.ts` | 注册 `shotsRoutes`（一行） |
| `apps/server/src/pipeline/actions/ffmpeg-merge.ts` | shots 输入 / per-shot 时长 / fit_voice 显式优先 / 逐镜容错 / inputs 快照 / 导出 computeShotSegments |
| `workspace/templates/mengbao-episode.yaml` | v6 → v7（compose_video 增 shots 输入） |
| `apps/web/src/components/ShotBoard.vue` | **新增**：镜头工作台组件 |
| `apps/web/src/views/RunDetailView.vue` | 步骤卡内嵌 ShotBoard；compose 卡「重新合成」按钮 + stale 徽标 |
| `apps/web/src/lib/api.ts` / `types.ts` | shotApi + 类型 |
| `apps/server/scripts/probe-m7.ts` | **新增**探针（§5） |
| `apps/server/package.json` | `probe:m7` script |
| `docs/`、`README.md` | 本 spec + roadmap 注记（M7 进行中 + backlog 移项） |

不改动（红线）：`pipeline/engine.ts`、`pipeline/refs.ts`、`pipeline/loader.ts`、`db/schema.ts`、`services/storage.ts`、`routes/tasks.ts`、`routes/runs.ts`、`routes/assets.ts`、适配器层、`TaskPanel.vue`（复用）。

---

## 5. 验收

1. **静态**：`pnpm -C apps/server typecheck` 与 `pnpm -C apps/web` 构建通过；mengbao-episode v7 过模板校验（`POST /templates/validate`）；
2. **探针 `probe-m7.ts`**（对齐 probe-m6 风格，构造型断言 + 临时文件，不发网络请求）：
   - `board`：构造 run / step（input.shots 快照）/ 分镜 JSON / tasks / assets（含双版本）→ 断言聚合（shotId 匹配、版本组排序、selected 标记、compose.stale 三态 true/false/null、repairable 判定）；
   - `edit`：合法编辑（新资产替换保位、gate 保留、purpose/format 继承）＋ 非法拒绝（未知 shot_id / duration 越界 / 无变化 / 无产出步骤溯源）；
   - `regenerate`：重置语义断言（task pending + resultAssetId 保留、step pending、run queued）＋ 防呆矩阵（活跃 run / cancelled / 其他 failed / skipped 步骤 / 镜头无 task 全拒）；
   - `select`：picks 校验矩阵（跨项目 / 跨步 taskId / kind 不符 / shot_id 重复 / 未知 shot 全拒）＋ 分镜序保序 ＋ 子集剔除 ＋ reset 恢复全量最新；
   - `recompose`：非 ffmpeg_merge 拒绝 ＋ 重置语义；
   - `merge-plan`：`computeShotSegments`（per-shot 覆盖、缺文件 skip、全 skip throw、kind 不符 skip、params.shotId 缺失不覆盖）；
3. **实弹目检**（用户 Web 端操作）：
   - 一集静态图出片后：改 1 镜时长 → 重新合成 → 该镜时长生效；
   - 单镜「改词重生成」→ 日志「跳过已有成功产物的 N-1 个镜头」+ 仅目标镜重跑 → 重新合成 → 新图进片；
   - 同镜生成 ≥2 版本 → 选版本 A 合成 → 切版本 B 重新合成 → 成片变化；
   - 剔除 1 镜 → 重新合成 → 成片少一段且与配音等长（fit_voice）；
   - 手动删一个镜头图文件 → 重新合成 skip+warn 正常出片（不再整体 failed）；
4. **兼容回归**：v6 存量 run 重新合成行为等价（全局时长）；motion 路径合成不变；quick-video / talking-clip 不受影响；
5. **越界核查**：`git diff --stat` 无 engine / refs / loader / schema / tasks / runs / assets 变更；
6. **文档**：README 增「镜头工作台与选镜拼接」小节；roadmap 注记 M7 + backlog 移项。

## 6. 风险与对策

1. **重生成与幂等对账的交互**（改词后 task 同步）→ 已核实：task 被置 pending 后，action 幂等段「未成功任务同步最新 prompt/params」天然消费新分镜（ai-image.ts L128-151）——无需改 action；
2. **选片被重生成重置** → 语义写明 + UI toast；后续如需「锁定选中」，另立（在 output 加 selected 快照键即可，M7 不做）；
3. **stale 对旧产物无法判定** → 返回 null，UI 降级为常态提示；
4. **选片后音画对齐**（静态路径 fit_voice 均分自动适配；motion 路径目检）→ §3.6 边界表写明；
5. **版本多时聚合响应膨胀** → versions 仅含 url 引用（缩略图懒加载）；正常使用 2-5 版；分页/清理另立；
6. **并发返修** → 幂等重置 + 引擎 active 集去重（engine.ts L75）；无锁；
7. **ffmpeg 容错后的「静默丢镜头」** → 逐条日志 + `params.skipped_shots` + UI 徽标提示（shot-board 不返回该数据时至少日志可查）——防用户无感知丢段。

## 7. 交付物清单

- 代码：§4 服务层 / 路由层 / ffmpeg-merge / Web 组件与集成；
- 模板：mengbao-episode v7；
- 探针：`probe-m7.ts`（六节）+ 实弹验收记录；
- 文档：本 spec、roadmap 注记、README 小节。
