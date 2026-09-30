# M10 设计：分镜编辑器（M7 排除项接力：结构性编辑 + 外来图入镜）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

> 里程碑：M10（2026-09-12 立项）｜上游：M7 镜头级轻工作台（字段级编辑）｜下游：M11 合成与声音
> 性质：M7 spec §1.3 排除项「镜头拖拽重排、分镜可视化大编辑器（结构性编辑）、上传图片替换分镜」的接力落地；P2 小缺口集群「镜头重排与可视化编辑器」的对应批次。
> 对标（2026-09-12 源码核实）：
> - **Toonflow**：`production/components/editImage/index.vue` 节点画布编辑器（VueFlow）——上传节点（`uploadNode.vue`：`uploadImage` 本地上传 / `uploadStoryboardImage` 从分镜库选图）+ 生成节点 + 结果节点，`keep` 保存；`workbench/preview.vue` 用 `vue-draggable-plus` 对镜头序列做拖拽排序；素材节点（`production/node/assets.vue`）内嵌 editImage 做外来图替换。
> - **huobao**：`episode.vue` 仅字段级编辑（M7 已对标），无结构性编辑 / 拖拽 / 外来图能力。
> - **本仓落法**：拖拽重排（对标 preview 排序，原生 HTML5 DnD 零依赖）+ 大编辑器（对标 editImage 的编辑诉求，用「列表 + 表单」形态而非节点画布——本地单机线性分镜用画布过重）+ 本地上传替换（对标 uploadNode 的 uploadImage；「从分镜库选图」跨镜引用属跨步骤资产混选范畴，维持排除）。

---

## 1. 定位与边界

### 1.1 一句话目标

把 M7 的「字段级轻工作台」升级为「结构性分镜编辑器」：镜头可拖拽重排、可增删改（全字段 + characters 引用）、可上传本地图片/视频替换任意镜头产物（外来图入镜）——全部沿用「分镜 JSON 唯一事实源 + 产物即选择 + 状态重置」三条既有原则，不触发重新生成（重新合成时生效）。

### 1.2 范围（三项能力）

1. **镜头拖拽重排**：改分镜 JSON 的 shots 数组顺序（id 不变）→ 同步重建镜头步骤 `output.asset_ids` 顺序（合成序随动）；不重新生成（任务/产物复用）。
2. **分镜可视化大编辑器**：单次提交多操作（`reorder` / `add` / `remove` / `patch`）——新增镜头（服务端/前端约定 id）、删除镜头（≥1 保留）、任意字段编辑（image_prompt / motion_prompt / duration / characters 专用控件 + 其余字段键值行）。
3. **上传图片替换分镜**：本地上传图片（ai_image 步）/ 视频（ai_video 步）→ 入库为该步骤「上传资产」（`taskId=null` + `params.shotId`）→ 绑定为该镜头选中产物（进 `output.asset_ids`，参与合成与版本组展示）。

### 1.3 排除（本里程碑不做，保持 backlog）

- 「从分镜库选图」跨镜引用（外来图限定本地上传；跨步骤/跨镜资产混选维持排除）；
- 分镜节点画布（VueFlow 式可视化连线）——列表 + 表单形态覆盖编辑诉求；
- 上传资产的独立版本管理（并入 M12「旧版本清理与收藏」）；
- 引擎级单步重跑 / 音字对齐 / BGM（M11/M12 批次）；
- 模板 / 引擎 / 适配器 / schema 改动（本轮零模板零迁移）。

---

## 2. 语义与契约

### 2.1 分镜 JSON 唯一事实源（继承 M7）

- 重排 = shots 数组顺序变化，**shot.id 永不改**（资产↔镜头映射锚点）；
- 新增 = 追加 shot（id 必填且唯一，契约字段 `image_prompt` 非空）；
- 删除 = 数组移除（至少保留 1 镜；任务/产物保留为历史，不删）；
- 每次 mutate 写**分镜新版本资产**（`{base}-工作台编辑.json`，tags=['workbench']）并**保位替换**产出步骤 `output.asset_ids` 中旧分镜位（沿用 M7 `applyStoryboardEdits` 手法）。

### 2.2 ops 协议（`POST /runs/:id/shots/mutate`）

```ts
type ShotOp =
  | { op: 'reorder'; order: string[] }                                  // 全排列校验（集合相等/无重复）
  | { op: 'add'; shot: Record<string, unknown> }                        // shot.id 必填唯一 + image_prompt 非空
  | { op: 'remove'; shot_id: string }                                   // 删后 ≥1
  | { op: 'patch'; shot_id: string; fields: Record<string, unknown> }   // 浅合并 + 字段校验
```

- ops 按序应用，**每条 op 在其应用时点校验**（add 之后 reorder 可见新 id；remove 之后 patch 该 id → 404 语义）；
- 前端建议序列：`add* → patch* → remove* → reorder`（最终顺序含新镜 id）；
- 前端 diff 后 ops 为空 → 前端拦截「无变化」；服务端仅校验 ops 非空数组。
- **patch 字段校验**：`id` 拒绝修改（bad_field）；`image_prompt` 非空 string；`motion_prompt` string；`duration` 数字 (0,60] 且双写 `duration_sec`（若原键存在）；`characters` string[]（元素非空）；其余键宽松透传（JSON-safe 值）。

### 2.3 联动重写（每次 mutate 统一执行）

1. 写新分镜版本资产（producer=`resolveStoryboardSource` 找到的产出步骤）；
2. producer `output.asset_ids` 保位替换（旧分镜 id → 新分镜 id）；
3. **镜头步骤 `output.asset_ids` 重建**：按「新分镜序 × 各镜当前选中资产」生成（选中映射 = 旧 output 中 `asset.params.shotId` 解析；未生成/无选中镜头跳过；已删除镜头的资产自然移除；上传资产按映射保留）。

### 2.4 外来图入镜语义

- **入库**（`importShotAsset`）：kind 校验（ai_image 步收 image / ai_video 步收 video，按扩展名判定）→ sha256 查重：
  - 命中（同项目已有同文件）→ **复制资产行**（复用 `relPath/mime/ext/fileSize/sha256`，文件不重复落盘），用途独立不污染原资产；
  - 未命中 → 落盘（purpose 子目录：`shot_image` → images / `shot_video` → video）+ 建行。
  - 行属性：`stepId` = 镜头步骤、`taskId` = null、`runId`、`purpose` = shot_image|shot_video、`params` = `{ shotId, source: 'upload', original_name }`。
- **绑定**（`bindUploadedShotAsset`）：资产必须属于「本步骤」（`taskId ∈ 本步任务集` 或 `taskId=null 且 stepId=本步骤`）且 `params.shotId === 目标镜` → 重建 `output.asset_ids`（该镜位替换/按分镜序插入）。
- **存续语义**：镜头步骤整步重跑时 action 按任务产物重建 output（既有行为）→ 上传选中会被任务产物覆盖，需重新应用（M7 重生成提示语已含"镜头列表重建"语义，本轮补上传提示）。

### 2.5 版本组扩展（聚合读）

- `buildShotBoard` 的 versions 并入「本步骤上传资产」（`assets.stepId = 步骤 AND taskId IS NULL AND deletedAt IS NULL`），按 `params.shotId` 归镜，与任务版本按 `createdAt` 升序合并；
- `BoardVersion` 增 `source: 'task' | 'upload'`（前端角标区分）；
- `BoardShot` 增 `raw`（分镜对象全量，供大编辑器）。

### 2.6 选片校验放宽（`applyShotSelection`）

原校验 `asset.taskId ∈ 任务集` 放宽为：
- `taskId` 非空 → ∈ 本步任务集（不变）；
- `taskId` 为空 → `stepId === 本步骤 && runId === 本 run`（上传资产）；
- 跨镜防呆不变（`shotIdOfAsset(a) === 目标镜`）。

### 2.7 边界与降级总表

| 场景 | 语义 |
|---|---|
| ops 空数组 / 非数组 | 400 bad_ops |
| reorder 非全排列 / 重复 / 未知 id | 400（含缺失 id 列表说明） |
| add id 重复 / 非法 / 缺 image_prompt | 400（add 时点校验） |
| remove 最后一个镜头 | 400 keep_min（至少保留 1 镜） |
| patch id / 未知 shot | 400 bad_field / not_found |
| 上传类型不匹配步骤（图步传视频） | 400 bad_kind |
| 上传单文件 > 200MB | 413 too_large |
| 上传空文件 | 400 no_file |
| sha256 命中去重 | 复制资产行（文件复用，用途独立） |
| 绑定资产不属于本步 / shotId 不匹配 | 400 bad_asset |
| 步骤无产物的镜头首次上传 | 允许（output 重建时按分镜序插入） |
| 整步重跑 | output 被任务产物重建（上传选中需重新应用；提示语覆盖） |
| run 活跃 / 非 completed·failed | 403 级既有 repairable 语义（不变） |

---

## 3. 服务端设计

### 3.1 `services/shot-workbench.ts` 扩展

```ts
export type ShotOp = /* §2.2 联合类型 */

/** 结构性编辑（reorder/add/remove/patch）：写新分镜版本 + 保位替换 producer output + 重建镜头步骤 output；不触发执行 */
export async function applyStoryboardOps(
  runId: number, stepKey: string, ops: ShotOp[],
): Promise<{ assetId: number; assetIds: number[]; shots: number }>

/** 单操作封装（拖拽重排即单条 reorder op 的便捷入口） */
export async function reorderShots(
  runId: number, stepKey: string, order: string[],
): Promise<{ assetId: number; assetIds: number[]; shots: number }>

/** 上传资产入库（kind 校验 + sha256 复制行/新落盘 + params 写入） */
export async function importShotAsset(
  runId: number, step: PipelineStep, shotId: string,
  file: { name: string; data: Uint8Array },
): Promise<Asset>   // 内部用 storage 原语（kindByExt/sha256Hex/relPathOf/ensureProjectDirs/registerAsset）

/** 上传 + 绑定组合（路由层单调用） */
export async function uploadAndBindShotAsset(
  runId: number, stepKey: string, shotId: string,
  file: { name: string; data: Uint8Array },
): Promise<{ asset: Asset; assetIds: number[] }>

/** 绑定既有上传资产（重建 output；选片放宽后亦可经 select 端点达成，本函数供上传组合与探针） */
export async function bindUploadedShotAsset(
  runId: number, stepKey: string, shotId: string, assetId: number,
): Promise<{ assetIds: number[] }>
```

内部重构（低风险、探针可回归）：
- 抽 `replaceProducerOutputAsset(producer, oldId, newId)`（applyStoryboardEdits 与 applyStoryboardOps 共用，行为不变）；
- 抽 `rebuildShotOutput(step, shots)`（按选中映射重建 asset_ids）；
- `buildShotBoard`：+upload 版本组并入、+`BoardVersion.source`、+`BoardShot.raw`；
- `applyShotSelection`：校验放宽（§2.6）。

### 3.2 `routes/shots.ts`（+2 端点）

```ts
// POST /runs/:id/shots/mutate —— 结构性编辑（不触发执行）
body: { step_key: string; ops: ShotOp[] }
201: { ok: true, asset_id, asset_ids, shots, note }

// POST /runs/:id/shots/upload —— 上传替换镜头（multipart：file + step_key + shot_id）
201: { ok: true, asset: AssetView, asset_ids, note }
```

错误映射沿用 `wb()` 包裹（WorkbenchError → HttpError，状态码透传）。

### 3.3 存储实现要点

- 复用 `storage.ts` 原语（已全部导出）：`kindByExt` / `sha256Hex` / `relPathOf` / `ensureProjectDirs` / `absPathOf` / `registerAsset`；
- **不走 `importFiles`**（其 sha256 命中即复用原行、不支持 params/runId 复制语义）——独立实现保证「复制行」语义；
- 上传大小上限 200MB（multipart 读入后校验，对齐既有 512MB 全局限制思路收紧）。

---

## 4. Web 设计

### 4.1 `ShotBoard.vue` 扩展

- **拖拽重排**：卡片「镜号把手」（grip 元素 `draggable=true`）→ 卡片为 drop 目标（`dragover.prevent` 高亮 + 左/右半边插入提示）→ drop 计算新序（源移除后插入目标索引位）→ `shotApi.mutate([{op:'reorder', order}])` → notice + 刷新；拖拽态样式（源半透明 / 目标插入线）；`canOperate` 门槛不变。
- **「编辑分镜」按钮**：头条区（wb-head）新增 → 打开 `StoryboardEditor` Modal。
- **「上传替换」按钮**：卡片 row 新增（wb-mini）→ 隐藏 `<input type=file :accept>`（图片步 `image/*`、视频步 `video/*`）→ `shotApi.uploadShot` → notice + 刷新；确认弹窗提示「替换该镜头当前选中产物（重新合成后生效）」。
- **版本角标**：画廊/版本项对 `source==='upload'` 显示「上传」小徽标。
- 重生成提示语补充：整步重跑会重建产物（上传替换需重新应用）——复用既有 toast 文案体系。

### 4.2 `StoryboardEditor.vue`（新建，大编辑器）

- 形态：全屏 Modal（宽 ~1000px）两栏——左栏镜头列表（拖拽排序 + 选中 + 删除标记 + 「＋新增镜头」），右栏字段表单。
- 字段控件：`id`（只读）/ `image_prompt`（textarea）/ `motion_prompt`（textarea）/ `duration`（number，回显 duration↔duration_sec 双口径）/ `characters`（标签输入 + 角色名 datalist 建议，来源 `entityApi.list('character')`，失败静默）。
- 其余字段：动态键值行（string/number/boolean 原生控件；array/object JSON 文本编辑 + 保存时 parse 校验）＋「＋添加字段」/「移除字段」。
- 新增镜头：本地草稿（id 自动建议 `s{最大数字+1}`，可改；`image_prompt` 必填）。
- 保存 diff：对比原始与草稿 → 生成 ops（`add* → patch* → remove* → reorder`）→ `shotApi.mutate` → emit saved（父级刷新 + notice）；ops 为空 → 提示「无变化」。
- 交互守卫：`canOperate` 为假时只读；离开时若有未保存修改 → 确认弹窗。

### 4.3 `lib/api.ts` / `lib/types.ts`

```ts
shotApi.mutate(runId, stepKey, ops: ShotOp[])
shotApi.uploadShot(runId, stepKey, shotId, file: File)   // FormData 上传
// types：ShotOp 联合；ShotVersion.source: 'task'|'upload'；ShotBoardShot.raw: Record<string, unknown>
```

---

## 5. 改动清单（文件级）

### 5.1 服务端（apps/server）

| 文件 | 改动 |
|---|---|
| `src/services/shot-workbench.ts` | 扩展：ShotOp / applyStoryboardOps / reorderShots / importShotAsset / uploadAndBindShotAsset / bindUploadedShotAsset；重构：replaceProducerOutputAsset / rebuildShotOutput（内部）；扩展：buildShotBoard（upload 版本组 + source + raw）、applyShotSelection（校验放宽） |
| `src/routes/shots.ts` | +2 端点（mutate / upload） |
| `scripts/probe-m10.ts` | **新增**：六节探针 |
| `package.json` | +`probe:m10` 脚本 |

### 5.2 Web（apps/web）

| 文件 | 改动 |
|---|---|
| `src/components/ShotBoard.vue` | 拖拽重排 + 编辑分镜入口 + 上传替换 + 版本角标 |
| `src/components/StoryboardEditor.vue` | **新增**（大编辑器） |
| `src/lib/api.ts` | shotApi.mutate / uploadShot |
| `src/lib/types.ts` | ShotOp / source / raw |

### 5.3 不改动清单（红线）

`pipeline/engine.ts`、`pipeline/refs.ts`、`pipeline/context.ts`、`pipeline/actions/*`（ai-image/ai-video 的 output 聚合语义不动）、适配器层、`services/storage.ts`（仅只读复用其导出原语，文件零改动）、`db/schema.ts`（零新表零新列）、全部模板与提示词、`services/novel-board.ts`、`NovelBoard.vue`、`TaskPanel.vue`、M7 既有端点语义（edit/select/regenerate/recompose 行为不变）。

---

## 6. 验收

### 6.1 静态

- `apps/server`：`npx tsc --noEmit` 零错误；`apps/web`：`npx vue-tsc --noEmit` 零错误。

### 6.2 探针 `scripts/probe-m10.ts`（隔离环境，零网络零计费）

| section | 断言 |
|---|---|
| `ops` | applyStoryboardOps：reorder 合法（JSON 顺序 + 资产 id 序变化）/ 非全排列 / 重复 id / 未知 id → 抛错；add（id 重复拒绝、缺 image_prompt 拒绝、合法追加）；remove（末镜拒绝、normal 移除）；patch（duration 双写 duration_sec、image_prompt 空拒绝、id 修改拒绝、characters 类型校验、未知键透传） |
| `output` | 重建语义：重排后 output 按新序；删除镜资产移除；未生成镜头跳过；上传资产（taskId=null）按映射保留；producer 保位替换正确（旧分镜 id → 新分镜 id） |
| `upload` | importShotAsset：新文件落盘（relPath 在 shot_image 子目录 + params.shotId/source）；sha256 命中 → 复制行（relPath 复用、原行不变）；kind 校验（图步传 txt 拒绝）；uploadAndBindShotAsset 组合（output 替换 + 分镜序插入） |
| `board` | buildShotBoard：upload 资产进版本组（source='upload'）、raw 字段存在、selectedAssetId 命中上传资产 |
| `select` | 放宽校验：上传资产可被 picks 选中；非本步骤的 taskId=null 资产拒绝；跨镜 pick 仍拒绝 |
| `regression` | applyStoryboardEdits（M7）行为不变（三字段 patch + 双写 + 保位替换）；reset 恢复语义仅任务产物（不含上传） |

### 6.3 实弹（真实 run，低成本）

- 选取既有含镜头步骤的 completed run（mengbao-episode）：
  1. 拖拽重排 → 分镜 JSON 新版本 + output 序变化 + stale 徽标亮起；
  2. 大编辑器：新增 1 镜 / 删 1 镜 / 改 characters+prompt → mutate 成功、镜头数变化；
  3. 上传替换：上传本地图 → 绑定进选中 + 版本组「上传」角标；
  4. 重新合成 → 成片按新序产出（无重新生成调用）；
  5. 浏览器 DOM 验收（四要素：拖拽把手 / 编辑器打开 / 上传按钮 / 版本角标）。

### 6.4 兼容回归

`probe:m7`（六节，最关键——shot-workbench 扩展不得破坏既有语义）＋ `probe:m2a` / `probe:m3`（templates·contract）/ `probe:m6` / `probe:m8` / `probe:m9` 全绿。

### 6.5 越界核查

`git status` 对照 §5.3：红线文件零 diff；`schema.ts` 零改动（本轮无迁移）。

### 6.6 文档

roadmap M10 注记（性质/范围/红线/排除/状态）+ README M10 小节（对齐既有范式）。

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| mutate 重建 output 误伤「未在分镜中的历史资产」 | 重建式（非原位修改）——只按新分镜序收录映射命中项；旧资产仍可经「恢复全量默认」/版本组找回 |
| 上传视频时长缺失影响合成 | 合成段时长已有容错（duration 缺失 → ffprobe / 估算，M7）；用户可在大编辑器补 duration |
| 大编辑器字段值 JSON 编辑误输入 | 保存前 parse 校验 + 字段级错误提示；单字段撤销（重新打开）|
| 重排/编辑后合成 stale 判断失效 | 复用 M7 `computeStale` 的 shots_source 检测（分镜资产替换 → stale=true）；实弹偏差回注（2026-09-12）：存量模板快照（compose inputs 无 shots 引用）与续跑链跨 run 资产引用会使 shots_source 缺失/断链 → 增「分镜资产 createdAt > 成片 createdAt → stale=true」时间兜底（不参与 compared 计数，null 语义不变；probe-m10 `board` 节 3 断言 + probe:m7 四条 stale 断言零回归） |
| probe-m7 回归 | 扩展为「新增函数 + 抽共享小工具」的加性改动；applyStoryboardEdits / applyShotSelection 的行为契约由 probe-m7 全量回归守护 |
