# 实施计划 · 第四期：统一 QC 面板（成片质量可验证 / 交付可信只读核验）

> **归档戳（2026-09-30）**：本计划配套规格被验收文档引用为「实现真源存档」，请原地保留。正文为落笔即冻结的历史快照，交付状态见 [索引](../README.md)。

- 规格（唯一实现真源，已批准 2026-09-28）：`docs/superpowers/specs/2026-09-28-agencys-content-studio-qc-panel-design.md`。
- 模块：`qc-panel`；维度：「质量可验证 / 交付可信」。上位路线与原 M50 计划不修改；第一期 `production-baseline` 与切片 2b 规格不重写。
- 已锁决策：Q1 verdict 只读（不改 `delivery_checked`、不触批准链）；Q2 音频纳入客观测量不判失真；Q3 仅成片级。
- 红线：**只读 / 零付费 / 零模型 / 零新列**；不 import 引擎、不写业务表、不改合成/导出/批准链；`params.timeline` 唯一真源（只读、不反推重建第二套时轴）；复用第一期证据口径（result / evidenceType 词表）；单文件 ≤800；字幕/compose-input/shot-duration 三既有分节保持绿（加法优先）。

## 依赖与实现顺序（加法优先，风险前置）

类型契约（T1）→ 本地测量层（T2，纯 ffprobe/ffmpeg，不触 DB）→ 一致性核验（T3，复用 `assessComposeInputCapability` + `reworkRequests` 台账）→ 聚合/verdict/缓存/新鲜度（T4，复用 `recordQuality` 零新列范式）→ 只读端点（T5）→ 探针分节（T6，本地合成假片，最高验证价值）→ 前端只读面板（T7）。T1–T4 后端串行；T5 依赖 T4；T6 依赖 T2–T5；T7 依赖 T5 契约稳定。T2 与 T3 无相互依赖，可并行。

## 任务

- [x] T1 类型契约：新建 `services/qc/types.ts`——`QcCheckKey` 联合、`QcCheck`、`QcReport`、verdict 三态、`fromCache` 标志；result/evidenceType 词表与第一期 §5.3 逐字对齐。不触 DB/执行。
  - 验收：契约覆盖 §4 全部 key；缺测字段类型为可空、禁 `null→0` 填充由消费侧保证。
  - 验证：typecheck。文件：`services/qc/types.ts`。
- [x] T2 本地测量层：新建 `services/qc/measure.ts`——复用 `probeMediaDuration`；新增只读 ffprobe `-print_format json` 取 容器/视频流/音频流/分辨率/帧率；ffmpeg astats 只读解析真峰值 dBTP/积分响度/静音（镜像 `image-check.ts` 的 spawn + 超时 + 保守 `null` 策略，工具不可用→`null` 宽容）。
  - 验收：对合成假 mp4 返回实测时长/流存在位/分辨率；工具缺失返回 `null` 不抛。
  - 验证：typecheck + 探针 #1/#5/#7。文件：`services/qc/measure.ts`。
- [x] T3 一致性核验：新建 `services/qc/consistency.ts`——读成片 `params.timeline.segments` 派生 Σ（本地只读解析，读同一真源，不反推）；`duration_vs_timeline`（实测 vs Σ，容差 ±0.5s）、`timeline_source`、`shot_duration_applied`（`readComposeConfig(...).shot_durations` 覆盖是否反映到段长）、`rework_receipt_consistency`（`reworkRequests` 最近 `state='applied'` 的 `baseFingerprint` vs `assessComposeInputCapability` 当前指纹）。门禁不满足→相应项 `not_tested`，不伪造。
  - 验收：造覆盖未入轴→`failed`；指纹漂移→标出；无门禁→`not_tested`。
  - 验证：探针 #2/#3/#4。文件：`services/qc/consistency.ts`。
- [x] T4 聚合/verdict/缓存/新鲜度：新建 `services/qc/report.ts`——编排 `runQcCheck(runId)`：定位 `final_video`（无→`no_final_video`）→ 调 T2/T3 产 `QcCheck[]` → 保守 verdict（failed/stale→not_ready；含 not_tested/manual→needs_review；全 passed+delivery_checked→ready）+ `missing[]` → `merge` 进 `assets.params.qc`（零新列，镜像 `recordQuality` 保留其余键 + `checkedAt` + `mediaSha256`）；读时 hash/指纹变→旧缓存项标 `stale`。
  - 验收：三态判定正确；缓存写入不破坏 `params` 其余键；hash 变→stale。
  - 验证：探针 #6/#8/#9。文件：`services/qc/report.ts`。
- [x] T5 只读端点：新建 `routes/qc.ts`——`GET /runs/:id/qc?refresh=`（默认按需重算，`refresh=0` 可回缓存并标 `fromCache`）；在 app 路由挂载处注册。纯转发 `runQcCheck`，不新增写路径（除 params.qc 缓存）。
  - 验收：无成片→`no_final_video`；正常→QcReport JSON；全程零 gen_task/usage。
  - 验证：typecheck + 探针端点级 #9。文件：`routes/qc.ts`、路由注册处（`src/index.ts` 或 routes 装配点）。
- [x] T6 探针分节：新建 `scripts/precision-rework-qc-panel.ts`（隔离库 + 本地 FFmpeg `lavfi` 合成假 mp4 含音视频流，标 `synthetic`，参照 `m44/asr-tasks.ts`；**零模型零计费**）；接线 `probe-precision-rework.ts` SECTIONS/runners 加 `qc-panel`。落规格 §8 九条断言。
  - 验收：新分节全绿 + 字幕/compose-input/shot-duration 三既有分节不回归。
  - 验证：`run-probes --only=precision-rework --section=qc-panel --jobs=1` + 全 `--only=precision-rework`。文件：`precision-rework-qc-panel.ts`、`probe-precision-rework.ts`。
- [x] T7 前端只读面板：web 类型 + api（`GET /runs/:id/qc`）+ 只读面板组件（报告分区：客观测量 / 一致性 / 交付标记 / 主观缺项，逐条带 status/source/value；verdict 徽标 + `missing[]`）；入口挂运行详情成片卡，显隐由能力探测驱动；错误态区分 `no_final_video`/`no_timeline`。**只读，不含任何写/重合成按钮**。
  - 验收：面板渲染后端报告，不本地推算 Σ/clamp（一律取后端返回值）；无写操作。
  - 验证：typecheck（vue-tsc）+ web build。文件：`apps/web/src/lib/types/qc.ts`、`apps/web/src/api/*`、`apps/web/src/components/run/qc/*`。

## 验证检查点（每片增量后）

`pnpm -C apps/server -r typecheck`（T1–T5）→ `run-probes --only=precision-rework --jobs=1`（T6，全绿；唯一既有失败仍为 m26 存量 3 文件、不新增）→ T7 后 `pnpm --filter @acs/web build` → `--only=m26` split-audit 破线文件仍恰为既有 3 个（净新增违规为零）。零付费守卫：探针断言全程 `gen_tasks`/`usage_records` 零新增。

## 验收记录

`docs/acceptance.md` 追加「第四期 QC 面板 验收快照」节：区分历史 vs 本轮、自动门禁 vs 待人工门（面板不等于质量通过，主观项仍待人工，编辑器实测属第五期）；勾选计划 T1–T7。
