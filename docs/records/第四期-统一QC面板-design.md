# 第四期设计：统一 QC 面板（成片质量可验证 / 交付可信只读核验）

> **归档戳（2026-09-30）**：本稿被代码探针或验收文档引用为「实现真源存档」，请原地保留、勿删勿移。正文为落笔即冻结的历史快照，交付状态见 [索引](README.md)。

- 日期：2026-09-28
- 状态：**已批准（2026-09-28）**。§0 五项档位与 §9 三项开放问题已由用户选定推荐值并锁入本文（Q1 只读 / Q2 纳入音频客观测量不判失真 / Q3 仅成片级）；业务代码尚未修改，进入实施计划（Plan）阶段。
- 上位路线：《百工工作室专业化生产分期路线》（Executing，文件不修改）。原 M50 计划不修改。第一期 `production-baseline` 规格与切片 2b `shot-duration-rework` 规格均不重写；本期以**加法**新建只读核验面，不改合成/导出/批准链/引擎。
- 模块 ID：`qc-panel`；维度归属：「质量可验证、交付可信」（第一期已建立证据口径，本期把它**产品化为应用内按需核验**）。
- 阶段纪律：本期**不**因建设面板而把第一期真实样片验收、编辑器实测（第五期）标为完成；面板自身不等于成片质量通过，只把「可客观测得的事实 + 一致性 + 交付就绪判定」如实汇总。

## 0. 待拍板档位（推荐值；如与预期不符请在批准前纠正）

1. **核验对象 = 仅成片级（`final_video`）**（推荐）。镜头级图像质量已由既有 `image-check.ts` 覆盖（`params.quality`），本期不重做，只在报告里引用其结论。
2. **只读性 = 硬约束**（推荐）。面板**不改** `delivery_checked`、不写媒体、不裁切、不重编码、不触发生成/ASR/模型评分；结果仅缓存进 `assets.params.qc`（零新列，镜像 `params.quality` 范式）。
3. **音频客观项 = 纳入纯测量、不纳入失真判定**（推荐）。ffprobe/ffmpeg astats 可测真峰值/积分响度/静音段（第一期已用 +0.3 dBTP 口径）；是否削波/失真属**主观**，留 `manual_review_required`，面板不自动判过。
4. **交付就绪判定 = 聚合客观项 + 缺项清单，给三态 verdict**（推荐）。`ready` / `needs_review` / `not_ready`，附 `missing[]`；不引入自动放行、不改现有批准门语义。
5. **前端 = 与后端同切片交付一个只读面板**（推荐）。入口显隐由能力探测驱动（复用 rework 弹窗同级约定），不新建独立页面框架。

## 1. 目标

对任一**已存在**成片，按需产出一份**结构化、可复核、带证据来源与新鲜度**的质量核验报告，使「改得准 / 少返工」的成果能够被**独立验证**、使「交付是否可信」有明确判定与缺项清单——回答上位路线每期都要能答的四个问题：修改是否准确、是否减少返工、质量结论是否有证据、交付是否可信。

口径**不新造**：直接复用第一期 `production-baseline` 已确立的证据字段与结果词表（§5.2/§5.3/§6/§7.2），把散落在采集期一次性 `.cjs` 脚本里的核验，收敛成应用内一条只读服务。客观项全部来自**本地 ffprobe/ffmpeg 实测 + 数据库读取**；主观项显式标注需人工，绝不伪造通过。

### 已确认假设

1. 面向本地单机、多体裁；不新增多轨 NLE、不重建资产系统、不改引擎核心（DAG 调度 / action 注册）。
2. **一律零付费、零模型**：不触发 ai_image/ai_video/tts/ASR、不调用多模态评分、不新增 gen_task、不新增 usage、不上传素材、不回写/替换生产媒体。
3. 时间轴口径唯一真源 = 成片 `params.timeline`（不变量：严禁从字幕 cue / shot 表 / asset_ids 反推重建第二套时轴）。核验读取它，不重算、不改写。
4. 复用既有台账 `rework_requests`（返修回执）与 `readComposeConfig`（`_compose.shot_durations` 等）做**一致性核验**，不新增表、不加列。
5. 现有能力不满足的检查项记 `unsupported` / `not_tested`，不为凑绿而放宽阈值或伪造通过。

### 包含

- 只读核验服务 `services/qc/`：成片物理规格实测、时轴一致性、返修回执一致性、交付标记、主观项占位 → 聚合 verdict + `missing[]`。
- 结果缓存进 `assets.params.qc`（零新列），带 `mediaSha256 / checkedAt / basis 指纹` 供新鲜度判定。
- 只读端点 `GET /runs/:id/qc`（对当轮固定成片核验）+ 复用列表徽标；能力探测驱动显隐。
- 前端只读面板（报告分区呈现客观/一致性/主观缺项，逐条带来源与状态），与 rework 弹窗同级。
- 探针分节 `--section=qc-panel`（隔离库 + 本地合成假媒体 + 零模型）覆盖全部客观判定与新鲜度/缺项逻辑。

### 暂不包含（明确排除，防范围蔓延）

- **任何媒体生成 / 修片 / 裁切 / 重编码 / 回写生产**（含中档 motion 文件级时长 trim，另立项）。
- **多模态自动评分 / 视觉一致性 / 道具连续性 / 听感失真的自动判定**（第一期 §7.2 明确「不新建自动 QC 算法、不调用多模态评分」，此类保持 `manual_review_required` 分列）。
- **第五期交付打包 / 编辑器兼容认证**（OTIO/FCPXML/EDL 三格式工程导出已由 `edit-exchange` 承担，能否被真实编辑器导入属第五期实测，本期不下「编辑器通过」结论）。
- 第一期六槽样片验收本身、付费样片采集、批准链放行自动化。
- 修改 `delivery_checked` 写入逻辑、通用 `updateComposeConfig`、compose 主流程。

## 2. 统一验收标准映射（对齐上位路线四维）

| 目标 | 本期硬性验收 |
|---|---|
| 质量可验证 | 每条客观结论附**测量来源**（ffprobe 字段 / params.timeline / 台账回执 id）；缺测为 `null`/`not_tested` 并注明原因，不以 `null→0` 或假值填充；主观项一律与客观测量**分列**，绝不冒充自动通过 |
| 交付可信 | 成片与其 `params.timeline` 快照、`_compose` 配置、最近一次返修回执绑定可查；verdict 三态 + `missing[]` 明确列出未满足项；`needs_review`/`not_ready` 不把旧片或未核验片说成「可交付」 |
| 改得准 / 少返工 | 一致性核验暴露「返修已应用但成片未重生成」「成片 hash 变使旧结论 `stale`」「时长覆盖已入 `_compose` 但未反映到 timeline 段长」等漂移，减少「以为改好了」的隐性返工 |

## 3. 核验报告数据契约（新建，只读；口径复用第一期）

```ts
// assets.params.qc 缓存结构（零新列；镜像 params.quality 的「merge + checkedAt」范式）
interface QcReport {
  runId: number
  finalAssetId: number
  checkedAt: number                 // 带时区毫秒，保留原值
  mediaSha256: string | null        // 测得成片文件哈希；变化使旧报告 stale
  verdict: 'ready' | 'needs_review' | 'not_ready'
  missing: string[]                 // 未满足项的机读键（对齐 manifest.missing[]）
  checks: QcCheck[]
}
interface QcCheck {
  key: QcCheckKey                   // 见 §4 目录
  status: 'passed' | 'failed' | 'not_tested' | 'unsupported' | 'not_applicable' | 'stale'  // 复用第一期 result 词表
  evidenceType: 'metadata' | 'local_measurement' | 'offline_probe' | 'manual_review'       // 复用第一期 evidenceType
  source: 'ffprobe' | 'params.timeline' | 'rework_ledger' | '_compose' | 'manual'
  value?: number | string | boolean | null   // 实测值；缺测 null，不填充
  reason?: string                   // 除 passed 外必填
}
```

- verdict 规则：任一客观 `failed` 或 `stale` → `not_ready`；无 failed 但存在 `not_tested`/`manual_review`/缺测 → `needs_review`；全部适用客观项 `passed` 且 `delivery_checked===true` → `ready`。分母/适用性存疑时取更保守态，宁 `needs_review` 不误 `ready`。
- 相同 `key` 的更正写新报告并覆盖缓存；源 hash 变化 → 依据旧测得的检查项在下次读取前标 `stale`（不挪用旧通过结论）。

## 4. 检查项目录（客观可测 + 一致性；主观显式留人工）

| key | evidenceType / source | 判定 |
|---|---|---|
| `file_readable` | local_measurement / ffprobe | 文件存在且可解码；缺失/不可读 → `failed` |
| `stream_spec` | local_measurement / ffprobe | 容器、视频流、音频流存在；分辨率、帧率、**实测时长**记录（§7.2 字段） |
| `duration_vs_timeline` | local_measurement / params.timeline | 实测成片时长 vs `Σ(params.timeline 段长)`；差超容差（拟 ±0.5s）→ `failed`，否则 `passed` |
| `timeline_source` | metadata / params.timeline | `params.timeline` 存在 → `passed`；缺失 → `legacy`/`unknown` 记 `not_tested`（不反推重建） |
| `rework_receipt_consistency` | offline_probe / rework_ledger + _compose | 台账最近 `apply success` 的指纹是否与当前成片/配置一致；「返修已记账但成片未重生成」→ 标出 |
| `shot_duration_applied` | offline_probe / _compose + params.timeline | 若 `_compose.shot_durations` 有覆盖，验证已反映到对应 timeline 段长；未反映 → `failed` |
| `subtitle_alignment_present` | metadata / params.timeline | 字幕 cue 是否落在 timeline 覆盖范围内（只读结构核验，不做 OCR/语义）；无可判依据 → `not_tested` |
| `audio_peak` | local_measurement / ffprobe(astats) | 记录真峰值 dBTP / 积分响度**客观测量**；是否削波/失真 → 另置 `manual_review_required`，不自动判过 |
| `delivery_flag` | metadata / params | `delivery_checked` 是否存在及其 strict/dialogue 语义（如实呈现，不改写） |
| `manual_quality_review` | manual_review / manual | 视觉一致性 / 道具连续 / 听感：恒 `not_tested` + `manual_review_required`（第一期 §7.2 边界，永不自动 passed） |

## 5. 读侧实现、缓存与新鲜度（加法；零新列）

- 服务置于 `apps/server/src/services/qc/`，全部为**读 + 本地测量**，不 import 引擎、不写业务表、不改合成。
- 媒体测量复用既有 `probeMediaDuration`（`services/ffmpeg.ts` 三级兜底），扩展只读 ffprobe JSON 取流/分辨率/帧率；音频峰值走 ffmpeg astats 只读解析（镜像 `image-check.ts` 的 `signalstats` spawn 范式）。
- **零新列**：报告缓存 `merge` 进 `assets.params.qc`（保留其余键），镜像 `recordQuality`。缓存仅为列表徽标/离线可查；`GET /runs/:id/qc` 默认按需**重算刷新**，缓存态显式标 `fromCache`。
- ffprobe/ffmpeg 不可用 → 相关项 `status=not_tested`（`ok=null` 宽容，不判 failed，遵循 `image-check` 保守策略），verdict 至多 `needs_review`。
- 新鲜度：报告携带 `mediaSha256 + checkedAt + basis 指纹`；读取时若成片 hash/指纹已变而缓存未刷新，据 §3 标 `stale`。

## 6. 入口覆盖与「同类入口一次收口」

- 唯一写入 = `assets.params.qc` 缓存（只读结论），**不新增任何业务写路径**，不改 `delivery_checked` 与批准链。
- 需要「镜头级时间轴」的既有消费方（`edit-exchange`、返修 capability）继续只读 `params.timeline`；本期面板同样只读，不产出第二套时轴真源。
- 前端入口 = 运行详情成片卡新增只读「质量核验」面板（与既有「合成返修」弹窗同级、独立只读，不混入返修写事务）；入口显隐由 `GET /runs/:id/qc` 能力探测驱动。错误态区分 `no_final_video` 与 `no_timeline` 两种语义（复用 edit-exchange 前端约束）。

## 7. 能力门禁与基准

- 门禁 = 该 run 能固定出一个 `final_video` 成片资产（可 `probeMediaDuration`）；否则 `no_final_video`。不要求 run `completed`（草稿/失败成片的成片同样可核验，诚实反映缺项）。
- 不新建执行闸门；面板不触发任何步骤重置或重合成。

## 8. 测试与验证（探针加法，零模型零计费）

- 新增 `probe-precision-rework.ts` 分节 `--section=qc-panel`（隔离库 + 本地 FFmpeg `lavfi` 合成假 mp4，明确标 `synthetic`，参照 `m44/asr-tasks.ts` 的合成媒体生成法；**零模型、零计费、不碰生产样片**）。核心断言：
  1. 合成假片：`file_readable`/`stream_spec`/`duration_vs_timeline` 客观值正确；实测时长与 `params.timeline` Σ 一致时 `passed`，人为造差 → `failed`；
  2. 缺 `params.timeline` → `timeline_source=not_tested`，**不**从 cue/shot 反推；
  3. 造 `_compose.shot_durations` 覆盖但未反映到 timeline 段长 → `shot_duration_applied=failed`；一致 → `passed`；
  4. 台账有 `apply success` 但指纹与当前成片不符 → `rework_receipt_consistency` 标漂移；
  5. `audio_peak` 记录客观 dBTP 值；失真判定项恒 `manual_review_required`，面板不自动 passed；
  6. verdict 三态：全 passed+`delivery_checked` → `ready`；含 not_tested → `needs_review`；含 failed/stale → `not_ready`；
  7. ffprobe 不可用注入 → 相关项 `not_tested`（不判 failed），verdict ≤ `needs_review`；
  8. 缓存写 `params.qc` 保留其余键（零新列回归）；成片 hash 变化 → 下次读取旧结论标 `stale`；
  9. 端点/服务全程零 `gen_tasks`、零 `usage_records` 新增（读侧不变量守卫）。
- 既有回归不变：`--only=precision-rework` 字幕 / compose-input / shot-duration 分节保持全绿。
- 门禁命令：
  ```
  pnpm -C d:\work\AI\Agent\agencys-content-studio --filter @acs/server exec tsx scripts/run-probes.ts --only=precision-rework --section=qc-panel --jobs=1
  pnpm -C d:\work\AI\Agent\agencys-content-studio -r typecheck
  pnpm -C d:\work\AI\Agent\agencys-content-studio --filter @acs/web build
  ```
- m26 split-audit 不破线（单文件 ≤800）：服务按 `services/qc/` 分文件、探针分节独立文件；预期净新增违规为零。

## 9. 开放问题（已由用户 2026-09-28 拍板锁定 = 推荐值）

- **Q1 交付就绪 verdict = 只读**（已锁）：面板只判定与列缺项，**绝不**自动改 `delivery_checked` / 放行批准；不新增写路径、不触碰批准链（见 §5/§6）。
- **Q2 音频客观项 = 纳入纯测量、不判失真**（已锁）：`audio_peak` 记录 dBTP / 积分响度 / 静音客观值；削波/失真置 `manual_review_required`，面板不自动判过。
- **Q3 首切片范围 = 仅成片级**（已锁）：逐镜图像质量引用既有 `image-check`（`params.quality`）结论，不在面板内重做逐镜聚合。

无剩余开放问题，规格决策完整，进入实施计划。
