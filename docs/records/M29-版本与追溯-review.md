# M29 收官 review — R02 内容/参考版本与下游影响追踪

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-18
- 设计：`2026-09-18-agencys-content-studio-m29-design.md`
- 需求来源：`2026-09-17-agencys-content-studio-post-m27-backlog.md` §3 R02（P0 · 第一组）
- roadmap：`2026-09-09-agencys-content-studio-roadmap.md` §M29 注记
- 性质：本期仅实施 R02；逐条背书 spec §8 验收矩阵 + 三条不变式（执行冻结真实输入 / 编辑不静默改写下游 / 三操作分离）。

## 0. 一句话结论

M29 P0–P4 全批次收官。把「保存历史、记录真实输入、展示影响、按需锁定」做成同一条版本追踪链：**三张通用表**（`content_versions`/`exec_snapshots`/`exec_inputs`，纯加法）+ 项目 `versions/` 不可变文件；文本编辑与实体全写入口留版本链并可**按需还原**；五类执行消费点经 `safeRecordExecSnapshot` 旁路捕获实际输入版本与 used/skipped；`downstreamImpact` 只报告不生成；gen 节点 `spec.pin` 锁版与选片/还原三操作严格分离；GC/purge/缓存一致性收线。前端「历史·影响」面板（文本预览器 + 画布实体节点）与锁版控件接线。`pnpm ci:check` 端到端 exit=0，**25 探针 / 2965 断言全绿**（含 probe-m29 46 断言八节）；`pnpm -r typecheck` / `vue-tsc` / `vite build` 全绿。

## 1. 验收矩阵逐条背书（对齐 spec §8）

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 三表可建可查 + 唯一约束 | ✅ | `schema` 节：三表可查询 + `idx_cv_obj_rev`/`idx_ei_snapshot`/`idx_ei_source` 存在（`sqlite_master` 断言）+ 重复 `(objKind,objId,revision)` 插入抛错 |
| 2 | 编辑后旧版可读且当前正文正确；实体各入口留版本 | ✅ | `version-capture` 节：文本→2 版（v1 baseline 原文 / v2 edit）+ `readVersionContent(v1)`=原文 + 工作副本=新文 + v1.relPath 含 versions + embedding 置空；`upsertEntity` 新建 baseline v1 → 改 appearance → v2 快照 |
| 3 | 还原=生成新版本保留历史、指针前移、不动下游 | ✅ | `restore` 节：文本还原→工作副本=v1 文 + 版本数+1 + source=restore + currentRevision 推进；实体还原 appearance 回退 + currentRevision 前移 |
| 4 | 乐观并发 409（expectedRevision） | ✅ | `concurrency` 节：缺省 last-write-wins 成功；expectedRevision 落后→`ContentEditError code='conflict'`；命中→成功 |
| 5 | 执行快照 used/skipped 与版本指针 | ✅ | `input-snapshot` 节：4 输入（3 used/1 skipped）读回计数 + skipReason + text `versionRevision` 命中；媒体 versionId=NULL、entity srcKind='entity' |
| 6 | 局部镜头命中不误伤；旧数据标历史不可恢复 | ✅ | `impact` 节：捕获=当前→current（含 shotId 定位）；上游再编辑→upstream_changed；媒体无版本→no_history |
| 7 | 锁旧不改选片、不改内容、不触发生成 | ✅ | `lock` 节：`lockCanvasInput` 写 `spec.pin` + `safeParseSpec` 落库校验 + 多上游共存 + `unlockCanvasInput` 移除 + 非 gen 节点拒绝 + 跨项目资产拒绝 |
| 8 | GC/purge 保护历史 + 三表级联 | ✅ | `gc-purge` 节：编辑版本文件在软删+gcProject 后仍存活；被 exec_inputs（used=1）消费资产 `cleaned=0 kept=2` 且 deletedAt=null；purge 按 projectId 删后 contentVersions 查空 |
| 9 | 零回归 | ✅ | `pnpm ci:check` exit=0（双端 typecheck + 模板 14/101/0 错 0 警 + `probe:ci` 25 探针 / 2965 断言全绿）；M25「同 relPath 覆写」断言未回归（工作副本语义不变）|

## 2. 三条不变式落地核对

- **执行冻结真实输入**：所有执行入口经 `recordExecSnapshot`（`safeRecordExecSnapshot` try/catch 旁路）在读取/构造最终请求处记**实际消费集合**，ai-image 区分「计划 refAssetIds」与「实际 used/skipped」，非事后可变数据。
- **编辑不静默改写下游**：`downstreamImpact` 仅返回清单 + 状态，无任何自动重跑/生成副作用；前端影响面板明示「修改不会自动生成或返修下游」。
- **三操作分离**：还原内容（`restore*Version` 生成新版本）/ 锁定输入（`spec.pin` 加法字段，仅下次执行）/ 采用产物（`adoptedTaskId` 选片）互不合并；probe `lock` 节断言锁版不触碰选片。

## 3. 数据与红线（零 diff 核对）

- **schema 纯加法**：`git diff --stat schema.ts` = +77/-0（三新表 + 索引），`db/index.ts` +62/-0（`ensureSchemaColumns` CREATE TABLE IF NOT EXISTS 兜底）。既有表列逐字未动；无第四张表。
- **引擎零侵入**：`engine.ts`/`dag.ts`/`loader.ts`（`KNOWN_ACTIONS` 零增）/`refs.ts`/适配器/**零 diff**（`git status` 不含这些文件）；全部追溯集成为消费点旁路记录，不改调度/加载/计费。
- **零新依赖**：复用 probe-lib、既有 assets/characters/canvas/gen_tasks 逻辑 ID 与旧接口、既有 file URL 与 `{asset}` 包裹体合同。
- **计费安全**：本期零新增模型费用——probe-m29 走 `isolatedEnv('m29')` 独立临时库 + 离线模板，无付费 LLM/图/视频/TTS；未触发任何真实供应商调用。
- 新增文件：`services/provenance.ts`、`routes/versions.ts`、`scripts/probe-m29.ts`；前端 `lib/types/version.ts`、`lib/api/versions.ts`、`components/version/VersionHistoryPanel.vue`、`components/version/CanvasInputLockPanel.vue`。
- 修改文件：服务端 `app.ts`（挂 versions 路由）/`db/schema.ts`/`db/index.ts`/`routes/{assets,characters,projects}.ts`/`services/{asset-content,character,entity-refgen,storage,version-cleanup,workflow}.ts`/`pipeline/actions/{ai-text,ai-image}.ts`/`pipeline/actions/ffmpeg-merge/index.ts`/`services/creation/{inputs,spec}.ts`/`services/creation/gen/execute.ts`；前端 `lib/{api/core,api/index,types/base,types/index}.ts`、`components/asset/previewer/{index.vue,use-asset-previewer.ts}`、`components/creation/inspector/{index.vue,EntityPanel.vue}`。

## 4. 决策与排除留痕

- **仅三张表**：锁版落 gen 节点既有 `spec.pin`（`Record<上游nodeId, 资产id>`），不建第四张锁表——若未来需列级并发或跨项目锁语义再 Ask first。
- **媒体不可变即身份**：图/视频/音每次为新资产行，`exec_inputs.versionId=NULL`，下游影响标 `no_history`（不伪造版本链）；仅文本资产与实体建 content_versions。
- **工作副本语义不变**：文本仍同 relPath 覆写（保 M25 探针 + 固定 file URL），版本走独立不可变文件；缓存以 file 路由 `no-store` 收线（前端可选 `?v=revision` 未强依赖）。
- **明确排除**：自动生成/返修/重渲染、撤销外部费用、运行时可编程供应商脚本、短剧专属模型/表、并行调度引擎、把「开始开发」当付费实弹授权。R01、R03–R09 保留去向，不预写 L1。

## 5. 遗留 / 后续（Low，不阻断收口）

- **Low-1** 浏览器交互式 e2e（预览器历史抽屉还原 / 实体面板折叠 / gen 节点锁版下拉）因本环境未起真实服务 + browser-use 扩展可用性不确定，降级为 `vue-tsc` + `vite build` + probe-m29 HTTP/服务层断言覆盖；交互层由类型与组件契约背书。
- **Low-2** 前端文本 file URL 未强制加 `?v=<contentRevision>`（服务端 `no-store` 已兜底陈旧缓存）；留作后续可选增强。
- **Low-3** 锁版候选资产当前取上游 gen 节点结果画廊（≤12）/当前产物；更细的「按版本资产跨节点挑选」UI 可在 R09 工作台衔接时深化。
- 后续 R01（质量/成本基线）、R03–R09 统一按 post-m27 backlog「启动门槛」复核后再立项。
