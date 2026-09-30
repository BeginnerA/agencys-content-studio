# M12 设计：旧版本清理与收藏 + 图像检测

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

> 里程碑：M12（2026-09-12 立项）｜上游：M7 工作台（版本组机制）· M10 分镜编辑器（上传资产入版本组；其排除项「上传资产的独立版本管理（并入 M12）」）｜下游：M13 素材链补全
> 性质：组1「工作台运营与资产」收尾批——「旧版本清理与收藏」（M7 spec §1.3 排除表接力：「旧版本自动清理/收藏｜清理策略另立 backlog」）与「图像检测」（M7 spec §1.3 排除表：「图像检测（Toonflow 特有）｜独立能力，backlog」）。组1 剩余 2 项（引擎级单步重跑已并入 M11 完成）。
> 对标（2026-09-12 源码二次核实）：
> - **Toonflow**：「图像检测」全局 0 命中（多轮 grep：检测/validateImage/checkImage/视觉/像素/stats 均无显式实现；`utils/ai.ts` 的 AiImage 仅 run/save 无校验；README 特性表无此能力）——排期备注「Toonflow 语义待对标（全局 0 命中，需源码二次核对）」二次核实成立：非源码原生术语，按本仓语义自定（生成物有效性检测）。
> - **huobao**：「检测/收藏/版本清理」均 0 命中，无对标实现。
> - **本仓落法**：收藏 = 全链路已有（is_favorite 列 + PATCH + toAssetView + Web 类型），M12 仅补 UI 与筛选（零库改动）；版本清理 = 新服务「保留最新/收藏/被引用，其余软删」+ 回收空间（物理 GC）独立动作；图像检测 = ffmpeg signalstats 单帧统计（复用 ffmpeg-static，零新依赖）→ 写 assets.params.quality → 徽标展示 + 合成警告（不阻断）。

---

## 1. 定位与边界

### 1.1 一句话目标

素材与版本可运营：任意资产一键收藏并「仅看收藏」（工作台版本组 + 素材页）；历史版本按「保留最新 / 收藏 / 在用」规则批量清理（软删可回溯），并可将已清理资产的磁盘文件显式回收；生成与上传的图片落盘后自动做有效性检测（黑图 / 纯色空白 / 损坏 / 文件缺失），异常图在缩略图上打警告徽标、合成时记日志警示（不阻断）。

### 1.2 现状与缺口（调研结论）

| 要素 | 现状 | M12 动作 |
|---|---|---|
| assets.is_favorite 列 | ✓ 已有（default 0） | 不动 |
| PATCH /assets/:id（is_favorite / name / tags） | ✓ 已有 | 不动 |
| toAssetView.isFavorite / Web `Asset.isFavorite` | ✓ 已有 | 不动 |
| 收藏 UI（工作台版本组 / 素材页卡片） | ✗ 全缺 | 新增 |
| 收藏筛选（素材页） | ✗ 缺（仅 purpose 筛选） | 新增（前端过滤） |
| `ShotVersion.isFavorite / quality` | ✗ 缺（toVersionView 无此字段） | 扩展 |
| 版本组批量清理（服务 + 端点 + UI） | ✗ 全缺 | 新增 |
| 物理文件 GC（「物理文件留待 GC」注释） | ✗ 缺 | 新增（显式动作） |
| 图像质量检测 | ✗ 全缺（Toonflow 无对标实现） | 新增（本仓语义） |
| ffmpeg 基建 | ✓ `resolveFfmpeg` 三级兜底 | 复用 |

### 1.3 排除（本里程碑不做）

- **单卡删除 UI**：素材页/预览器不做单张删除按钮（版本清理 + 回收空间覆盖「清理」诉求；降低误删面）。
- **已清理资产的恢复（回收站）**：软删语义不变、无恢复 UI；物理回收后不可恢复（强确认）。
- **分镜/文本资产的版本清理**：清理只针对 kind ∈ {image, video}；分镜旧版本、文本资产不触碰。
- **存量资产的检测回填**：不做批量回填；仅新生成/新上传自动检测 + 单资产手动重检端点。
- **图像内容审核 / NSFW / 语义标签**：仅技术性有效性检测（黑/纯色/损坏），不做内容理解（语义理解属 M13「从参考图提取风格词」范畴）。
- **合成阻断**：异常图只警告不阻断（用户显式选中的图始终尊重）。
- **素材页多选**：不做多选批量操作（版本清理为规则化一键）。

---

## 2. 语义与契约

### 2.1 收藏语义

- 收藏 = `assets.is_favorite` ∈ {0,1}；切换经既有 `PATCH /assets/:id` `{ is_favorite: boolean }`（服务端 0/1 归一）。
- 收藏三作用：①素材页「仅收藏」筛选；②版本清理保留豁免；③工作台版本组视觉标记（♥）。

### 2.2 版本组语义（复用 M10 口径）

- **任务组**：`taskId != null` 的资产，同一 taskId = 一组（同镜历代生成产物；单镜重生成 = 同 task 重新执行 → 组内追加新版本）。
- **上传组**：`taskId == null`（M10 上传资产），按 `(runId, stepId, params.shotId)` 一组。
- 组内「最新」= max(createdAt)，tie 取 max(id)。

### 2.3 清理保留规则（统一）

对范围内每个组：

- **保留**：①组内最新版本；②`isFavorite=1` 的全部；③被任意 `pipeline_steps.output.asset_ids` 引用的（在用产物；保守全量扫描引用集）。
- **清理**：其余未软删行 → `deletedAt = now`（软删，可回溯）。
- 已软删行跳过；非 image/video 跳过；无组概念（无 taskId 且无 `params.shotId`）的跳过。

### 2.4 回收空间（GC）语义

- 范围：项目内 `deletedAt != null` 的资产 → unlink(`relPath`) + unlink(`thumbs/<id>.webp`)；**行保留**（审计）；失败跳过（文件已不在 = 成功语义）。
- 返回 `{ files, freed_bytes }`。不可逆（UI 强确认）。
- 幂等：重复调用对已回收资产零影响。

### 2.5 图像检测语义

- **检测对象**：落盘后的 image 资产（生成链 / 上传链）与手动重检端点目标。
- **判定**（ffmpeg signalstats 单帧，保守阈值）：

| 判定 | 条件 | reason |
|---|---|---|
| 损坏 | ffmpeg 解码失败 / 无统计输出 | `broken` |
| 黑图 | `ymax-ymin < 4` 且 `yavg <= 16`（含 limited-range 黑基准 Y=16 边界，实测校准） | `black` |
| 纯色空白 | `ymax-ymin < 4`（且非黑） | `flat` |
| 正常 | 其余 | `ok` |
| 文件缺失 | relPath 文件不存在 | `no_file` |
| 无法检测 | ffmpeg 不可用 | `ffmpeg_unavailable`（宽容：ok=null，不标记异常） |

- **落点**：`assets.params.quality = { ok, reason, stats: { ymin, ymax, yavg, satavg }, checkedAt }`（零新列；merge 既有 params 键）。
- **展示**：`ok === false` → 缩略图警告徽标（工作台版本卡/镜头主图 + 素材卡）；合成时 warnings 日志。`ok === null` 不显示徽标。
- **手动重检**：`POST /assets/:id/check` → 同步检测 + 写回（预览器按钮入口）。

### 2.6 端点契约

```
POST /runs/:id/shots/cleanup                  （挂 routes/shots.ts）
body: { step_key }
200: { ok, run_id, step_key, groups, cleaned, kept, note }
   // 范围 = 本 run + 该步骤；active 拒绝（assertRepairable 同工作台）

POST /projects/:id/assets/cleanup-versions    （挂 routes/assets.ts）
body: {}（可空）
200: { ok, groups, cleaned, kept, note }
   // 范围 = 项目全部

POST /projects/:id/assets/gc                  （挂 routes/assets.ts）
200: { ok, files, freed_bytes, note }

POST /assets/:id/check                        （挂 routes/assets.ts）
200: { asset }    // 检测后最新视图（含 params.quality）
   // kind 非 image → 400；文件缺失 → quality.reason='no_file'
```

---

## 3. 服务端设计

### 3.1 services/image-check.ts（新）

- `checkImageFile(absPath): Promise<ImageQuality>`
  - `resolveFfmpeg()` 为 null → `{ ok: null, reason: 'ffmpeg_unavailable' }`；文件不存在 → `{ ok: false, reason: 'no_file' }`
  - spawn ffmpeg：`-hide_banner -loglevel info -i <src> -vf signalstats,metadata=print -frames:v 1 -f null -`（15s 超时、windowsHide、stdio pipe）
  - stderr 解析 `/lavfi\.signalstats\.(YMIN|YMAX|YAVG|SATAVG)=([\d.]+)/g`（首个完整帧）；无输出/进程异常/超时 → `broken`
  - 判定表（§2.5）→ 返回 `{ ok, reason, stats? }`
- `checkAndRecordAsset(assetId): Promise<Asset | null>`：读行（未软删）→ kind=image 与 relPath 校验 → 检测 → merge `params.quality`（保留既有键）→ update（updatedAt 刷新）→ 返回新行；非 image → 调用方 400。
- `scheduleImageCheck(asset): void`：fire-and-forget（内部全 catch 落日志；kind 非 image / 无 relPath 直接返回），供写路径调用。

### 3.2 services/version-cleanup.ts（新）

- `cleanupVersions(opts: { projectId; runId?; stepId? }): Promise<{ groups; cleaned; kept; cleanedIds }>`
  - 候选 SELECT：projectId + `kind in (image,video)` + `isNull(deletedAt)` + 可选 runId/stepId 过滤
  - 分组（§2.2）→ 求引用集（范围内 `pipeline_steps.output` 的 asset_ids 并集）→ 逐组求保留集（最新/收藏/被引用）
  - 未保留者 `inArray` 一次 UPDATE `deletedAt`
- `gcProject(projectId): Promise<{ files: number; freedBytes: number }>`
  - SELECT `deletedAt != null`；unlink 前 statSync 读 size。逐行 unlink relPath + thumbs 缓存；失败跳过（计数仅成功）

### 3.3 集成点（写时检测）

| 落点 | 改动 |
|---|---|
| `pipeline/actions/ai-image.ts` | `saveGeneratedMedia` 后 `scheduleImageCheck(asset)` |
| `services/shot-workbench.ts` `uploadAndBindShotAsset` | 入库后同（内部 kind 守卫） |
| `routes/assets.ts` imports | created 逐个 schedule（内部 kind 守卫） |

### 3.4 合成守卫（ffmpeg-merge.ts）

- `computeShotSegments` 返回扩展 `warnings: string[]`：段内资产 `params.quality?.ok === false` → `镜头产物 asset#N 疑似异常（<reason>），已按选中继续合成`。
- 调用方 `ctx.log` 逐条。M7 探针兼容（仅新增字段，原断言不破）。

### 3.5 shot-workbench.ts

- `BoardVersion` 接口 +2 字段；`toVersionView` 扩展：
  - `isFavorite: a.isFavorite`
  - `quality: parseQuality(a.params)`（容错：无/解析失败 → null，仅取 `{ ok, reason }` 对前端有意义子集——stats/checkedAt 不随 board 下发）。

### 3.6 routes 挂载

- `routes/shots.ts` +`POST /runs/:id/shots/cleanup`：`assertRepairable(runId, stepKey, WORKBENCH_ACTIONS)` 同工作台 → `cleanupVersions({ projectId, runId, stepId })` → note 文案「已清理 N 个历史版本，保留 M 个（最新 / 收藏 / 在用）」。
- `routes/assets.ts` +`POST /projects/:id/assets/cleanup-versions`、+`POST /projects/:id/assets/gc`、+`POST /assets/:id/check`。

---

## 4. Web 设计

### 4.1 契约层

- `lib/types.ts`：
  - `export interface ImageQuality { ok: boolean | null; reason: string; stats?: { ymin: number; ymax: number; yavg: number; satavg: number }; checkedAt?: number }`
  - `ShotVersion` +`isFavorite: number` +`quality: Pick<ImageQuality,'ok'|'reason'> | null`
  - `Asset` 不变（params 已透传，前端 `parseAssetQuality(a)` 小工具取 `params.quality`）
- `lib/api.ts`：
  - `assetApi` +`favorite(id, fav: boolean)` → PATCH `{ is_favorite }`；+`check(id)` → POST；+`cleanupVersions(projectId)`；+`gc(projectId)`
  - `shotApi` +`cleanup(runId, stepKey)`

### 4.2 ShotBoard.vue

- **版本画廊卡**：+♥ 按钮（点击 → `assetApi.favorite` → 本地更新 `v.isFavorite`）；+quality 徽标（`v.quality?.ok===false` → alert icon + title 中文说明：黑图/纯色空白/损坏）。
- **镜头主缩略图**：当前有效选中版本 `quality.ok===false` → 角标警示（复用 wb-lines/wb-vcount 层位）。
- **工具行**：+「清理旧版本」按钮（`confirmDialog` 规则说明 → `shotApi.cleanup` → 刷新 board + notice）。

### 4.3 AssetGrid.vue + AssetPreviewer.vue

- **AssetGrid 卡片**：hover 显示 ♥ 收藏按钮（`stopPropagation`，pickable 模式保留）；卡片角 quality 徽标（`params.quality.ok===false`）。
- **AssetPreviewer 顶栏**：image 资产 +「重新检测」按钮（`assetApi.check(id)` → 局部结果文本「检测完成：正常 / 黑图 / …」+ `emit('changed')` 宿主刷新）。

### 4.4 ProjectDetailView.vue

- 资产区工具行：+「仅收藏」checkbox（前端叠加过滤）+「清理历史版本」按钮 +「回收空间」按钮（danger）。
- 清理 / 回收：`confirmDialog` → API → notice + `loadAssets({ silent: true })`。
- 收藏变更：AssetGrid `emit('favorite', asset)` → 原地更新 `assets.value` 对应项。

---

## 5. 改动清单 / 不改清单

### 5.1 改动清单

**服务端（apps/server/src）**

1. `services/image-check.ts` 新建（检测服务三函数）
2. `services/version-cleanup.ts` 新建（cleanupVersions / gcProject）
3. `services/shot-workbench.ts`：BoardVersion 接口 +2；toVersionView +2；uploadAndBindShotAsset 尾部 +scheduleImageCheck
4. `pipeline/actions/ai-image.ts`：runOneTask 落盘后 +scheduleImageCheck
5. `pipeline/actions/ffmpeg-merge.ts`：computeShotSegments +warnings；调用方逐条 log
6. `routes/shots.ts`：+POST /runs/:id/shots/cleanup
7. `routes/assets.ts`：+POST /projects/:id/assets/cleanup-versions、+/assets/gc、+/assets/:id/check；imports 后 schedule
8. `scripts/probe-m12.ts` 新建 + package.json `probe:m12`

**Web（apps/web/src）**

9. `lib/types.ts`：ImageQuality + ShotVersion 扩展
10. `lib/api.ts`：assetApi/shotApi 扩展
11. `components/ShotBoard.vue`：♥ / quality 徽标 / 清理按钮
12. `components/AssetGrid.vue`：♥ / 徽标
13. `components/AssetPreviewer.vue`：重新检测按钮
14. `views/ProjectDetailView.vue`：仅收藏筛选 / 清理 / 回收

### 5.2 不改清单（红线）

- **零新表零新列**：assets 表结构不动（is_favorite / tags / params 全复用）；git diff 无 schema.ts。
- **不改删除语义**：DELETE /assets/:id 保持软删；物理删除仅在 gc 显式触发。
- **不改引擎**：step 状态机 / 续跑 / 重置三连零改动。
- **不改「产物即选择」**：output.asset_ids 事实源不动；清理不触碰被引用资产。
- **不改模板与提示词**：零模板 / 提示词改动（本批无 AI 语义变更）。
- **不引入新依赖**：检测复用 ffmpeg-static。
- **不阻断**：合成对异常图仅警告；检测失败零影响主链。

---

## 6. 验收

### 6.1 静态

- server `npm run typecheck` 零错误；web `vue-tsc` 零错误。

### 6.2 探针（probe-m12.ts，六节；隔离环境、零网络零计费）

1. `cleanup`——保留规则矩阵（最新 / 收藏 / 被引用 / 其余软删；上传组；已软删跳过；非图视跳过；范围过滤 runId/stepId）
2. `imagecheck`——ffmpeg 构造样本（黑 / 纯色 / 正常 / 截断损坏 / 缺失）+ 判定矩阵 + stderr 解析容错
3. `gc`——文件 + thumb 回收、freed_bytes、行保留、幂等
4. `board`——toVersionView 扩展（isFavorite / quality 容错：无 params / 坏 JSON / 缺失字段）
5. `merge-guard`——computeShotSegments warnings（异常图警示；正常图零警告；M7 原字段不破）
6. `regression`——`probe:m7 / probe:m10 / probe:m11` 全绿

### 6.3 实弹（真实项目）

① 收藏——素材页 ♥ → API 回读 `is_favorite` → 「仅收藏」筛选 DOM；
② 清理——存量 run 工作台「清理旧版本」→ 保留规则与 DB 逐值核对（最新/收藏/被引用保留，其余 deletedAt）+ board 刷新；
③ 检测——`POST /assets/:id/check` 对存量图 → `params.quality` 真实统计（ffmpeg 实测值）→ 工作台/素材页徽标 DOM；
④ 回收——软删资产 → `gc` → 文件消失 + freed_bytes 实测；
⑤ 兼容——存量 run board 正常（无 quality 不误报）；素材页老资产无徽标；
⑥ DOM 四要素——徽标 / ♥ / 仅收藏筛选 / 清理确认弹窗。

### 6.4 越界核查

git diff 不含 `schema.ts`；不含模板 / 提示词文件；package.json dependencies 无新增。

### 6.5 文档

- roadmap M12 注记 + README M12 能力速览。

---

## 7. 风险

1. **signalstats 输出解析差异**（ffmpeg 版本 / loglevel）→ 宽松正则 + 无输出 = broken 保守 + 实弹校准阈值。
2. **阈值误报**（暗调 / 风格化纯色图）→ 保守阈值（动态范围优先）+ 仅徽标不阻断；`ffmpeg_unavailable` 不标记。
3. **回收不可逆** → 仅软删资产 + danger 强确认 + 失败跳过 + 幂等。
4. **清理边界**（误删在用资产）→ 三重保留（最新 / 收藏 / 被引用）+ 全项目引用扫描保守 + 软删可回溯 + 探针矩阵。
5. **性能**（项目级扫描）→ SQL 范围过滤 + 低频操作；unlink 逐文件、占用跳过。
6. **fire-and-forget 检测丢失**（进程重启）→ 检测非关键路径；手动重检端点兜底。
