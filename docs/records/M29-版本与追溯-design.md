# M29 设计（L1 spec）— R02 内容/参考版本与下游影响追踪

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-18
- 编号：M29（post-M27 backlog 分配；M28 已用于巨型文件重构并收官，不复用；本号为开工前按最新 roadmap 复核后的首个可用号）
- 需求来源：[ACS 在 M27 完成后的提升清单](2026-09-17-agencys-content-studio-post-m27-backlog.md) §3 R02（P0 · 第一组「测量与可追溯基础」）
- roadmap：`2026-09-09-agencys-content-studio-roadmap.md` §M29 注记
- 性质：把「保存历史、记录真实输入、展示影响、按需锁定」做成同一条版本追踪链。本期仅实施 R02；R01、R03–R09 保留去向，不预写 L1。

## 0. 三条不变式（贯穿全设计，验收红线）

1. **执行冻结真实输入**：每次生成/合成记录其**实际消费**的资产/实体版本与 used/skipped，不以事后可变数据冒充旧快照。
2. **编辑不静默改写下游**：修改章节/事件/实体/参考，只**报告**受影响集/镜头/成片并引导用户操作，绝不自动生成或返修。
3. **三个操作严格分离**：还原内容版本 / 锁定下次执行输入 / 采用历史产物，语义与接口互不混淆。

## 1. 目标与用户流程

- 目标：文本资产（章节/事件/剧本等）与实体（角色/场景/道具）可回看历史版本并**按需还原**；任一次执行可追溯当时真实输入的版本指针与 used/skipped；改动上游对象时能列出**受影响的下游执行清单**（定位到具体镜头/成片，而非整表泛化）。
- 用户流程：预览器/实体面板查看「历史 · 影响」→ 需要时还原到某历史版本（生成新版本、保留全部历史、不动下游）→ 画布 gen 节点可显式**锁定下次执行输入**为某历史资产 → 影响面板只读展示「上游已变更 / 与当前一致 / 历史不可恢复」，用户据此自行决定重跑范围。
- 成功判据：见 §5 验收矩阵（对应 backlog R02 验收方向）。

## 2. 数据层（三张通用表 + 不可变文件，纯加法）

新增到 `db/schema.ts`，`db/index.ts` 的 `ensureSchemaColumns` 用 `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` 做旧库兜底（与 M18/M20/M27 同风格）。**仅三张，不建第四张**——锁版信息落既有 spec/params 的加法 JSON。

| 表 | 职责 | 关键列 | 索引 |
|---|---|---|---|
| `content_versions` | 对象版本链 | `id, projectId, objKind('asset'\|'entity'), objId, revision, payloadKind('file'\|'json'), relPath(不可变版本文件), sha256, doc(entity 字段快照 JSON), label, source('baseline'\|'edit'\|'import'\|'generate'\|'ref-upload'\|'ref-gen'\|'polish'\|'restore'), meta, createdAt` | 唯一 `(objKind,objId,revision)` |
| `exec_snapshots` | 执行快照（每次执行一条） | `id, projectId, execKind('pipeline_step'\|'canvas_task'\|'shot_task'), runId, stepId, taskId, templateKey/model, inputHash, frozenAt, createdAt` | `(projectId)` `(taskId)` `(stepId)` |
| `exec_inputs` | 实际输入依赖边 | `id, snapshotId, role('text'\|'reference'\|'first_frame'\|'last_frame'\|'source'\|'mask'\|'subtitle'\|'bgm'\|'sfx'\|'prev_text'\|'voice'), srcKind, srcId, versionId(→content_versions，可空=旧数据), used, skipReason, shotId/port, ordinal, createdAt` | `(snapshotId)` `(srcKind,srcId)`（下游影响反查） |

- **不可变文件**：项目下 `versions/` 目录，文件名 `v-<objKind>-<objId>-<rev>-<sha8>.<ext>`，写入后永不覆写。文本资产工作副本仍同 relPath 覆写（不破坏 M25 探针与固定 file URL）；每次成功编辑额外落一份新版本文件。实体（无文件）以 `doc` JSON 承载 appearance/summary/states/refAssetIds 快照。
- 既有 `assets`/`characters`/`canvas`/`gen_tasks` 逻辑 ID 与旧接口全部保留；媒体资产（图/视频/音）本身即不可变新行，`exec_inputs.versionId=NULL`，身份即 `asset.id`。

## 3. 版本捕获与还原（服务单一入口 `services/provenance.ts`）

- **文本编辑**（`services/asset-content.ts` `updateAssetContent`）：先保证 baseline 版本存在（懒捕获原文），再写新不可变版本 + 更新工作副本；可选 `expectedRevision` 乐观并发（缺省保留 last-write-wins 向后兼容；不匹配抛 `ContentEditError code='conflict'`→路由 409）。编辑成功后把该 asset 的 `embedding` 置空（标记待重建，避免旧向量与正文不一致）。
- **实体全写入口**（`services/character.ts` / `routes/characters.ts` / `services/entity-refgen.ts`）：`upsertEntity`、`PUT /entities/:id`、`polish`、`ref-images`、`ref-gen` 统一经 `recordEntityVersion` 记录版本，不只改 PUT。
- **还原** = 把指定历史版本内容复制回工作副本并生成新版本（移动当前指针、保留全部历史），不删不改下游产物（`restoreAssetTextVersion` / `restoreEntityVersion`）。
- **路由**（`routes/versions.ts`）：`GET /assets/:id/versions`、`GET /assets/:id/versions/:versionId/content`、`POST /assets/:id/versions/:versionId/restore`、`GET /assets/:id/impact`；实体同构；`GET/POST/DELETE /canvas/nodes/:id/input-lock(s)`。错误经 `mapProvenance`：not_found→404 / forbidden→403 / 其余→400。

## 4. 执行真实输入快照（接入既有消费点，不碰引擎调度）

在读取/构造最终请求处经 `safeRecordExecSnapshot`（try/catch 旁路，仅告警，**零行为变更**）捕获 used/skipped 与版本指针：

- **Pipeline 文本**（`pipeline/actions/ai-text.ts`）：`readTextAsset` 直读处记实际消费版本。
- **出图/出视频**（`pipeline/actions/ai-image.ts`）：以 `assetToDataUri` 构建后**最终集合**记录，区分「计划 refAssetIds」与「实际 used/skipped」。
- **合成**（`pipeline/actions/ffmpeg-merge/index.ts`）：镜头媒体、voices、subtitle、BGM/SFX 旁路资产全部纳入 `exec_inputs`（role 区分）。
- **画布**（`services/creation/gen/execute.ts` + `inputs.ts` + `spec.ts`）：`loadInputPlan` 各分支记实际输入；`textInputs` 补来源身份（srcId/versionId）。
- **M27 $prev.text**（`services/workflow.ts`）：`resolveSegmentInput` 把映射来源 asset 版本随字符串带出记 `exec_inputs`；不改 autoAdvance/预算/失败暂停/幂等语义。
- **单镜返修**（`services/shot/selection.ts` / `edits.ts`）：重跑经已覆盖的执行快照；`applyShotSelection`（选片=采用历史产物）与锁版严格分离，无需额外接线。

## 5. 影响分析 + 锁版三操作分离 + 清理一致性

- **影响分析（只报告）**：`downstreamImpact({objKind,objId})` 反查 `exec_inputs` → 命中的 run/step/task/镜头/成片；按 shotId/port 定位到具体镜头，**不把整份 storyboard 变化泛化到全部镜头**；返回清单+状态（`upstream_changed`/`current`/`no_history`），旧数据无 versionId → 标「历史不可恢复」，不伪造。
- **锁版**：锁定下次执行输入 = 写入目标 gen 节点既有 `spec.pin:{上游nodeId→资产id}`（`lockCanvasInput`/`unlockCanvasInput`；`loadInputPlan` 已实现：pin 资产须存在且 `deletedAt==null` 才生效，否则回落）。与 `adoptedTaskId`（采用产物）、还原内容三接口互不合并。默认仍走最新。
- **清理与缓存**：`version-cleanup.ts` 的 `referencedAssetIds` 并入 `exec_inputs`（srcKind='asset'）消费资产豁免，防物理 GC 造成追溯悬空；`routes/projects.ts` purge 事务级联删本项目三表行（依赖序 exec_inputs→exec_snapshots→content_versions），`versions/` 文件随项目目录递归删；可编辑文本资产 file 路由 `Cache-Control: private, no-store` 解决 `max-age=3600` 陈旧缓存（`{asset}` 包裹体合同不变）。

## 6. 前端（`apps/web`，scoped CSS + CSS 变量，无 Tailwind）

- 类型 `lib/types/version.ts`（`ContentVersionView`/`ImpactRow`/`InputLockView`/... 与服务端响应对齐）；API `lib/api/versions.ts`（`assetVersionApi`/`entityVersionApi`/`canvasLockApi`）；`api/core.ts` `del` 加可选 body；`Asset` 加 `contentRevision?`。
- 可复用面板：`components/version/VersionHistoryPanel.vue`（历史 + 影响两 tab；历史列表 + 版本内容预览 + 还原按钮带脏确认；影响只读着色）；`components/version/CanvasInputLockPanel.vue`（gen 节点上游资产锁定/解锁）。
- 接线：文本预览器顶栏「历史·影响」入口 + 右侧抽屉（`asset/previewer`）；画布实体节点「历史·影响」折叠区（`creation/inspector/EntityPanel.vue`）；gen 节点检查器锁版控件（`creation/inspector/index.vue`）。

## 7. 分期（单 L1，按依赖顺序）

- **P0 数据层**：三表 schema + ensureSchemaColumns + provenance 骨架 + 前端类型 + probe-m29 schema 节。
- **P1 版本捕获/还原**：文本 + 实体全入口 + 不可变文件 + 乐观并发 + restore + routes/versions.ts + M25 探针校准。
- **P2 输入快照/影响**：五类消费点接入 + 下游影响查询 + 锁版字段与路由 + shot 评估。
- **P3 前端**：历史·影响面板 + 锁版控件 + 接线 + GC/purge/ETag 收线。
- **P4 收口**：全量回归 + vite build + review + roadmap 校准。

## 8. 验收矩阵（对齐 backlog R02 验收方向；零新增模型费用）

| # | 验收项 | 判定 | 探针/证据 |
|---|---|---|---|
| 1 | 三表可建可查 + 唯一约束 | schema 节 | probe-m29 `schema`（三表查询 + idx_cv_obj_rev/idx_ei_snapshot/idx_ei_source + 重复 (objKind,objId,revision) 抛错） |
| 2 | 编辑后旧版可读且当前正文正确；实体各入口留版本 | version-capture 节 | 文本 2 版（baseline 原文/edit）+ readVersionContent(v1)=原文 + 工作副本=新文 + v1.relPath 含 versions + embedding 置空；upsertEntity baseline v1→改→v2 快照 appearance |
| 3 | 还原=生成新版本保留历史、指针前移、不动下游 | restore 节 | 文本还原→工作副本=v1 文 + 版本数+1 + source=restore + currentRevision 推进；实体还原 appearance 回退 |
| 4 | 并发 409（expectedRevision）| concurrency 节 | 缺省 last-write-wins 成功；落后→conflict；命中→成功 |
| 5 | 执行快照 used/skipped 与版本指针 | input-snapshot 节 | 4 输入（3 used/1 skipped）读回计数 + skipReason + text versionRevision |
| 6 | 局部镜头命中不误伤；旧数据标历史不可恢复 | impact 节 | current/upstream_changed/no_history + shotId 定位 |
| 7 | 锁旧不改选片、不改内容、不触发生成 | lock 节 | lockCanvasInput 写 spec.pin + 多上游共存 + unlock 移除 + 非 gen/跨项目拒绝 |
| 8 | GC/purge 保护历史 + 三表级联 | gc-purge 节 | 编辑版本文件软删后 gcProject 仍存活；被 exec_inputs 消费资产 cleaned=0；purge 三表删空 |
| 9 | 零回归 | `pnpm ci:check` exit=0 | 双端 typecheck + 模板 14/101/0 + probe:ci 25 探针全绿（含 M25 同 relPath 覆写断言未回归）|

## 9. 边界与红线

- **Always**：≤800 行/文件；加法迁移；保留旧接口与 ID；服务端→探针→前端接线；每里程碑写 review 回写 roadmap；追溯集成一律经 `safeRecordExecSnapshot` 旁路（零行为变更）。
- **Ask first**：如需新增第四张表或改动既有表列语义。
- **Never**：自动生成/返修/重渲染；撤销外部费用；运行时可编程供应商脚本；短剧专属模型/表；并行调度引擎；把「开始开发」当作付费实弹授权；未要求即 commit/push/建远程任务；引擎/DAG/loader（`KNOWN_ACTIONS`）/refs/适配器/package 依赖零触碰。
- 测试零新增模型费用：`probe-m29.ts` 走 `isolatedEnv('m29')` 独立临时库，复用 probe-lib 与离线模板，不调付费 LLM/图/视频/TTS，不用真实生产库做破坏性测试。
