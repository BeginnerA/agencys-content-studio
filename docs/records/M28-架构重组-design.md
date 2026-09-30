# agencys-content-studio M28 架构重组（巨型文件拆分与目录域化）设计

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-15
- 性质：**架构级纯重构里程碑**（独立立项，见决策 3）——不新增功能、不改行为、零新依赖；纲领 H2 缺口（巨型文件）由 M26 转入本里程碑
- 决策留痕（2026-09-15 用户拍板四项）：
  1. **范围** = 全量 15 个千行文件（服务端 4 + Web 11；800~1000 行次级文件不在本批）
  2. **目标结构** = 激进全面重构——目录按域重排 + import 全量机械改写 + 命名统一
  3. **立项形态** = 独立新里程碑 M28（与 M26 解耦；M26 保留 H1/H3–H7，仅 H2 转入 M28）
  4. **规模红线** = 固化「单文件 ≤800 行」纪律（规范 + 检查手段）
- 治理依据：架构变更立项规范（单独立项 + L1 spec + roadmap 登记 + 全量回归验证）；校准规则 3 窗口校验（M19 review 已落盘，当前无进行中 L1 spec，允许开工）
- 前置：M19 收官（17 探针 m2a–m19 合计 2233 断言全绿）；git 工作区干净（基线 6366707）

---

## §1 目标与不变式

**目标**：
1. 全部 15 个目标文件拆分后，每个新文件 ≤800 行（红线，见 §7）；服务端域目录化（creation / shot / ffmpeg-merge 三域）；Web 端组件域归组 + 视图目录化 + lib 目录化
2. 为 M20–M27（workbench / 画布深化 / 运营）提供低摩擦落点：后续里程碑在细分模块上接线，而非再生千行文件

**不变式（红线，违反即返工）**：
1. **行为零变更**——函数体逐字保留（含注释、含 `[M17]` 等里程碑标注、含空白语义）；无符号重命名（仅允许文件迁移与 import 路径改写）；无逻辑/控制流/调用序改动
2. **导出面冻结**——每个目标模块对外导出名集合与拆分前完全一致；对拍方法见 §6.4
3. **回归零适配**——17 个探针（probe:m2a / m3 / m4 / m6–m19）全绿且**适配 0 处**；任何探针需要改断言或路径以外内容 = 越界信号，须返工
4. **不改清单**：engine / refs / loader / dag / 模板与提示词（workspace/）/ db schema 与迁移 / 适配器行为 / 任何 UI 交互与样式
5. **零新依赖**：package.json 依赖段零改动
6. **解析歧义禁令**：同一目录禁止 `x.ts` 与 `x/` 并存（防「文件优先于目录」的隐式解析）；本次转换全部为「文件 → 同名目录 + index.ts」或「文件 → 改名目录」，无并存场景

---

## §2 范围清单（15 文件）

| # | 文件 | 行数 | 归宿 |
|---|---|---|---|
| S1 | `apps/server/src/services/creation.ts` | 2298 | `services/creation/`（同名目录，导入零改动） |
| S2 | `apps/server/src/services/creation-gen.ts` | 1326 | `services/creation/gen/`（改名，6 处导入机械改写） |
| S3 | `apps/server/src/pipeline/actions/ffmpeg-merge.ts` | 1316 | `pipeline/actions/ffmpeg-merge/`（同名目录，导入零改动） |
| S4 | `apps/server/src/services/shot-workbench.ts` | 1136 | `services/shot/`（改名，9 处导入机械改写） |
| W1 | `apps/web/src/views/CreationView.vue` | 2633 | `views/creation/`（index.vue + composables + 子组件） |
| W2 | `apps/web/src/components/CreationInspector.vue` | 1788 | `components/creation/inspector/` |
| W3 | `apps/web/src/components/ShotBoard.vue` | 1419 | `components/shot/board/` |
| W4 | `apps/web/src/components/CreationBoard.vue` | 1385 | `components/creation/board/` |
| W5 | `apps/web/src/views/TemplatesView.vue` | 1254 | `views/templates/` |
| W6 | `apps/web/src/views/RunDetailView.vue` | 1207 | `views/run-detail/` |
| W7 | `apps/web/src/lib/types.ts` | 1167 | `lib/types/`（同名目录，导入零改动） |
| W8 | `apps/web/src/views/EntitiesView.vue` | 1144 | `views/entities/` |
| W9 | `apps/web/src/views/ProjectDetailView.vue` | 1109 | `views/project-detail/` |
| W10 | `apps/web/src/components/StoryboardEditor.vue` | 1051 | `components/shot/storyboard-editor/` |
| W11 | `apps/web/src/views/SettingsView.vue` | 1046 | `views/settings/` |

**域内自然收敛**（非千行文件，随所属域一并迁移，导入机械改写）：
- `services/creation-ops.ts` → `services/creation/ops.ts`
- `services/creation-groups.ts` → `services/creation/groups.ts`
- `services/creation-export.ts` → `services/creation/export.ts`
- `services/canvas.ts`（M15 流水线画布）→ 保留原位（与创作画布消歧，不改名）

**遗留豁免登记**（>800 行但不在本批范围，触发条件式待拆）：
- `lib/api.ts`（801）、`components/BrandSettings.vue`（962）——登记红线豁免清单；其所属域（api / brand）在后续里程碑被实质触及时拆分

---

## §3 技术前提（批 0 验证结论，2026-09-15）

- 双端 `moduleResolution: bundler` + 无扩展名相对导入 → **目录 index 解析成立**：
  - `tsc --noEmit`（server）：临时样例验证通过（已删）
  - `tsx` 运行时（探针执行环境）：验证通过（已删）
- **兼容策略**：同名目录替换（S1/S3/W7）→ 外部静态导入零改动；改名目录（S2/S4）→ 按 §5 清单机械改写（含探针 `await import()` 动态导入——scripts/ 不在 tsconfig include 内，路径失效只在运行时暴露，故每批必须跑全量相关探针）
- Web 端 vite + vue-tsc 同机制待批 2 首件落地时以临时样例复验（vite build 全量兜底）

---

## §4 目标结构

### §4.1 服务端（apps/server/src）

```
services/
  creation/                    # 创作画布域（S1 拆分 + S2 子域 + ops/groups/export 收敛）
    index.ts                   # 公共面重导出（原 creation.ts 导出面冻结）
    spec.ts                    # 节点规格解析/校验（parseNodeSpec / safeParse* / specProblems / parseViewport / isGenSpec）
    ports.ts                   # 端口矩阵（wouldCreateCycle / validateNewEdge / productKindOf / sourceKindOf / editCapabilityOf）
    inputs.ts                  # 输入规划（planNodeInputs / loadInputPlan）
    nodes.ts                   # 节点 CRUD 与派生（addXxxNode / validateNodePatch / updateNode / deleteNode / assertRestorableSource / claimNodeTasks / findNode）
    edges.ts                   # 边（addEdge / deleteEdge）
    canvas.ts                  # 画布 CRUD（list/create/find/update/softDelete/restore/purge/duplicate）
    snapshots.ts               # 文档快照（create/list/delete/restoreSnapshot / collectSnapshotDoc）
    doc.ts                     # buildCanvasDoc 读模型（含 toAssetLite / toTaskLite / pickDisplayTask / topoSortGenNodeIds）
    draft.ts                   # 模板草案（buildTemplateDraft / buildTemplateDraftYaml / tryRunTemplate / yaml 工具）
    extract.ts                 # 文本提取（extractTextNode + parseRefIds / defaultGenTitle / parsePos / safeJson）
    ops.ts                     # 原 creation-ops.ts（批量操控）
    groups.ts                  # 原 creation-groups.ts（成组）
    export.ts                  # 原 creation-export.ts（zip 导出）
    gen/                       # 生成执行子域（原 creation-gen.ts 拆分）
      index.ts                 # 公共面（含 buildComposeArgs / preflightNode / previewCanvasRun / startCanvasNodeRun / extractNodeFrame / recoverCanvasTasks / cancelCanvasTasks / 纯函数）
      params.ts                # buildNodeTaskParams / extendTaskParams / buildEditParams / appendStyleSnippet / parseResolution
      compose-args.ts          # buildComposeArgs
      frame.ts                 # frameTimeOf / buildFrameExtractArgs / extractVideoFrame / extractNodeFrame
      preflight.ts             # preflightNode / previewCanvasRun
      queue.ts                 # 信号量 + startCanvasNodeRun / runCanvasTask / recoverCanvasTasks / cancelCanvasTasks / failTask / emitCanvasChanged
      execute.ts               # executeOnce 分派 + executeAudioOnce / executeLlmOnce / executeComposeOnce
      video.ts                 # 视频轮询与任务状态（pollCanvasVideoTask / reloadTask / taskCancelled）
  shot/                        # 镜头工作台域（原 shot-workbench.ts 拆分）
    index.ts                   # 公共面（WorkbenchError 等导出面冻结）
    board.ts                   # buildShotBoard / buildComposeInfo / computeStale / toVersionView / parseQualityBrief / shotDurationSec
    edits.ts                   # applyStoryboardEdits / applyStoryboardOps / reorderShots / applyOneOp / applyShotPatch
    selection.ts               # applyShotSelection / resetShotForRegenerate
    import.ts                  # importShotAsset / uploadAndBindShotAsset / bindUploadedShotAsset / assertAssetBelongsToStep
    reset.ts                   # resetStepForRecompose / resetStepForRerun / cleanupShotVersions / replaceProducerOutputAsset / rebuildShotOutput
    inspect.ts                 # assertRepairable / checkRepairable / findProducerStep / latestStoryboardOf / resolveStoryboardSource
    helpers.ts                 # getRunOrThrow / getStepOrThrow / selectedMapOf / parseOutputJson / outputIdsOf / toIdArray / sameIds / shotIdOfAsset
pipeline/actions/
  ffmpeg-merge/                # S3（同名目录，导入零改动）
    index.ts                   # ffmpegMerge 主流程逐字保留 + runFfmpeg（函数级重组排除，见 §8）
    subtitle-style.ts          # defaultSubtitleStyle / toAssColor / buildSubtitleStyle
    watermark.ts               # watermarkOverlayXY
    aspect.ts                  # aspectRatio / resolveAspectSize / aspectGeometryFilter / isSameAspect
    segments.ts                # computeShotSegments / qualityWarning / parseShotDurations / loadPerShotDurations / shotIdOfAsset / lineIdOfVoiceAsset
    align.ts                   # parseShotLines / loadShotAlignShots / planVoiceAlignedSegments / planSrtShifts / srtTsToSec / secToSrtTs / countSrtCues / shiftSrtText
    transition.ts              # buildTransitionPlan
    sfx.ts                     # planSfxStarts
    args.ts                    # buildComposeArgs
```

### §4.2 Web（apps/web/src）

```
composables/                   # 新增：跨组件复用的组合式函数（视图私有 composable 就近放视图目录）
components/
  common/                      # Icon / Modal / ConfirmDialog / ConfirmHost / DatePicker / SearchSelect / MarkdownPreview
  creation/                    # 创作画布域
    board/                     # W4 拆分（index.vue + NodeLayer / EdgeLayer / use-board-interactions.ts）
    inspector/                 # W2 拆分（index.vue + GenForm / TextForm / EntityPanel / RunPanel / TasksPanel / EditSection + use-inspector-form.ts）
    EditBrushModal.vue / CanvasTargetModal.vue
  shot/                        # 镜头域
    board/                     # W3 拆分（index.vue + ShotCard / VersionStrip / ComposeBar + use-shot-board.ts）
    storyboard-editor/         # W10 拆分（index.vue + ShotRow / LinesEditor + use-storyboard-editor.ts）
    ShotSfxModal.vue
  run/                         # GateDialog / RerunModal / TaskPanel / RunFormModal / ComposeSettingsModal / ExportWizardModal / PublishModal / AspectDeriveModal
  project/                     # ProjectFormModal / ProjectDangerModal / SeriesBoard / BatchFormModal
  template/                    # TemplatePicker / TemplateHelpModal / TemplateInputFields
  asset/                       # AssetGrid / AssetPreviewer / AssetThumb
  brand/                       # BrandSettings / BrandPreview
  config/                      # ApiConfigForm / VendorCredentialForm / VoiceLibrary
  pipeline-canvas/             # CanvasBoard / CanvasDrawer（M15 流水线画布）
views/                         # 全部视图目录化：views/<domain>/index.vue
  creation/                    # W1（index.vue + use-canvas-*.ts + 私有子组件）
  templates/ run-detail/ entities/ project-detail/ settings/       # W5 / W6 / W8 / W9 / W11
  projects/ canvas/ memories/ stats/ style-presets/ system-settings/ batch-detail/   # 同名搬迁（非千行，随目录化统一）
lib/
  types/                       # W7 拆分（按域 14 模块 + index.ts，导入零改动）
  api.ts                       # 保留单文件（801，豁免清单）
  （format / confirm / socket / scene / aspect / board-viewport / canvas-history / esc-layer / pending / template-dict 保持原位）
```

**W1 CreationView 拆分边界（composable 建议清单，实施按模板块微调）**：
`use-canvas-target.ts`（route.query 单一真源 + 目录加载：项目/画布/素材面板）· `use-canvas-doc.ts`（doc 拉取与静默对账 + socket 房间）· `use-canvas-selection.ts` · `use-canvas-commands.ts`（写命令 + 撤销重做命令栈）· `use-canvas-groups.ts` · `use-canvas-batch.ts`（批量编排/编号/串联/批量执行/停止全部）· `use-canvas-estimate.ts` · `use-canvas-refs.ts`（实体参考挂接）· `use-canvas-export.ts`（zip / 草案）· `use-canvas-runs.ts`（run 节点轮询 + 送去运行）· `use-canvas-palette.ts`（素材面板拖放/上传）· `use-canvas-trash.ts` · `use-canvas-snapshots.ts`；模板拆为 顶栏工具栏 / 画布区（含批量浮动条）/ 素材面板 / 总览抽屉 / 快照抽屉 / 回收站抽屉 + 既有弹窗接线

**W7 lib/types 拆分边界**：`project.ts`（Project / ProjectDetail / MemoryItem / MemoryStatus）· `run.ts`（Run / RunStep / RunDetail / RecentRun / RerunResult / 状态枚举）· `asset.ts`（Asset / AssetUrls / GenTask / TaskResultAsset / ExportAssetLite / RunAssetLite / ImageQuality / CleanupResult / GcResult）· `config.ts`（ProviderConfigLite / ApiProvider / ApiConfig / VendorCredential / FetchModelsResult / ApiErrorBody / UsageItem / UsageSummary）· `template.ts` · `entity.ts` · `batch.ts` · `stats.ts`（Overview）· `publication.ts` · `shot.ts` · `novel.ts` · `brand.ts`（品牌/字幕样式/多画幅）· `series.ts` · `canvas.ts`（M15+M16 画布全家）· `voice.ts`（VoiceCloneItem / VoiceCloneProvider）+ `index.ts` 原序重导出

---

## §5 导入改写清单（改名目录，机械改写）

| 源路径 | 新路径 | 改写点 |
|---|---|---|
| `services/creation-gen` | `services/creation/gen` | `routes/creation.ts:40`；`probe-m16.ts:81`；`probe-m17.ts:80`；`probe-m18.ts:228/317/652` |
| `services/shot-workbench` | `services/shot` | `routes/helpers.ts:3`；`routes/runs.ts:12`；`routes/shots.ts:23`；`probe-m7.ts:76`；`probe-m10.ts:78`；`probe-m11.ts:61`；`probe-m12.ts:404`；`probe-m15.ts:321`；`probe-m19.ts:873` |
| `services/creation-ops` | `services/creation/ops` | 实施时全量 grep 收敛（已知 `routes/creation.ts:43`） |
| `services/creation-groups` | `services/creation/groups` | 同上级（已知 `routes/creation.ts:41`） |
| `services/creation-export` | `services/creation/export` | 同上级（已知 `routes/creation.ts:42`） |
| `services/creation`（不变） | 解析至 `creation/index.ts` | 零改写（含 probe-m16/m17 类型导入） |
| `actions/ffmpeg-merge`（不变） | 解析至 `ffmpeg-merge/index.ts` | 零改写（含 `aspect-derive.ts` / `creation-gen.ts` / 4 个探针的动态导入） |

Web 端改写：`router.ts` 视图导入（13 处目录化）+ 组件迁移的 import 全量机械改写（vite build + vue-tsc 兜底）。

---

## §6 批次与验证矩阵

| 批 | 内容 | 验收（全部通过方可进下一批） |
|---|---|---|
| **批 0**（✅ 2026-09-15） | 解析验证 / git 基线 / 导入方摸排 | tsc ✓ tsx ✓ 临时文件已删 |
| **批 1a**（✅ 2026-09-15） | S1 creation.ts → `services/creation/`（13 模块 + index） | 双端 typecheck；probe:m16/m17/m18 全绿；导出面对拍 |
| **批 1b**（✅ 2026-09-15） | S2 creation-gen.ts → `creation/gen/`（8 模块）+ ops/groups/export 收敛 + 导入改写 | 同上 + `probe:m18`（preflight/compose-args/抽帧节） |
| **批 1c**（✅ 2026-09-15） | S3 ffmpeg-merge.ts → `ffmpeg-merge/`（9 模块） | 同上 + `probe:m7/m11/m12/m19`（合成/对齐/字幕/水印/画幅节） |
| **批 1d**（✅ 2026-09-15） | S4 shot-workbench.ts → `services/shot/`（8 模块）+ 9 处导入改写 | **全量 17 探针零适配**（m2a·m3·m4·m6–m19）+ 双端 typecheck |
| **批 2**（✅ 2026-09-15） | Web 核心：W1–W4 拆分 + creation/shot/common 域归组 + router 接线 | vue-tsc + vite build 全绿；实弹浏览器抽查（画布页/镜头工作台） |
| **批 3**（✅ 2026-09-15） | Web 其余：W5–W11 + views 目录化 + lib/types 目录化 + 剩余域归组 + 追加 AssetPreviewer / CanvasDrawer（见 review 偏差 1） | 同上 + 设置页/项目页/素材页抽查 |
| **批 4**（✅ 2026-09-15） | 收尾 | 行数对照表（全部 ≤800）；git 越界核查；review 落盘 + roadmap 校准 |

### §6.4 导出面对拍方法（每批）
1. 拆分前：`Select-String "^export " <原文件>` 记录导出名集合
2. 拆分后：对 index.ts（公共面）执行同命令 + 抽查各子模块
3. 集合必须完全一致（无增、无减、无改名）

### §6.5 越界核查
每批结束时 `git status` / `git diff --stat` 核对：仅预期文件变更；engine / refs / loader / dag / workspace / schema / 适配器 / package.json 零 diff。

---

## §7 规模红线（固化）

- **单文件 ≤800 行**（含注释与空行）；本里程碑 15 个目标文件拆分后全部达标
- 存量豁免：`api.ts` / `BrandSettings.vue` 登记豁免（触发条件见 §2）；其余存量文件均已达标
- 新增或实质修改的文件必须达标；超限须拆分或在本里程碑 spec / review 单独立项豁免
- 检查手段：M28 收尾以脚本统计全仓行数（可并入 M26-H1 CI 批作为门禁）

---

## §8 明确排除

| 排除项 | 理由 |
|---|---|
| 函数级内部重构（如 ffmpegMerge 单函数 530 行的阶段化重排） | 控制流重排 ≠ 纯移动，风险升级；留后续里程碑 |
| 探针脚本拆分（probe-m19 1777 行等 15 个脚本） | 归 M26-H5 探针治理批 |
| CI 建设 | 归 M26-H1（建议提前穿插） |
| 任何行为 / UI / 交互 / 样式 / 文案调整 | 本里程碑不变式 1 |
| `api.ts` / `BrandSettings.vue` 拆分 | 审批范围外（豁免登记） |
| 服务端其余 <800 行 services 小文件的位置调整 | 无规模问题，避免为搬迁而搬迁 |
| `lib/` 非目标工具文件迁移、`composables/` 对存量小文件的追溯采用 | 保持增量节奏 |

---

## §9 风险与对策

| 风险 | 对策 |
|---|---|
| 探针动态导入路径失效（scripts/ 不在 typecheck 覆盖内） | §5 改写清单显式枚举 + 每批跑全量相关探针；失效会显式报错不会静默 |
| 拆分引入循环依赖 | 按依赖 DAG 分层（spec → ports/inputs → nodes/edges → doc/draft）；出现环时就近合并模块（不跨层引新公共层） |
| Vue scoped 样式跨组件迁移遗漏 | 样式块随所属模板整块迁移；实弹目检 |
| 目录 index 与同名文件歧义 | §1 禁令 6；同名目录转换时原文件同步删除 |
| 大幅 diff 噪音掩盖越界 | 分批 + 每批 git diff --stat 核查 + 导出面对拍 |
| 拆出的 composable 语义漂移 | composable 内逻辑逐字迁移（仅 `ref(` 声明位置与 return 装配允许新增）；行为由实弹背书 |

---

## §10 治理动作（配套）

1. **roadmap 登记**：追加「M28 注记（立项）」——性质 / 四项决策 / 批次 / 验证口径；M26 行注记「H2 已转 M28」
2. **红线固化**：≤800 行纪律写入项目记忆（development spec 层）与 §7
3. **review 落盘**：批 4 完成后对照 §6 验收矩阵逐条核对，产出 `2026-09-XX-agencys-content-studio-m28-review.md`，并回写 roadmap 校准规则 1
4. **里程碑序列影响**：M28 插于 M19 与 M20 之间执行；M20–M27 编号不变（M20 其后的开工窗口顺延，不受内容影响）
