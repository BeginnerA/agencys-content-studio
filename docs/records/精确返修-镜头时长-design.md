# 精确返修第二切片 2b：镜头时长本地返修（图镜 / 音频对齐镜时长覆盖）

> **归档戳（2026-09-30）**：本稿被代码探针或验收文档引用为「实现真源存档」，请原地保留、勿删勿移。正文为落笔即冻结的历史快照，交付状态见 [索引](README.md)。

- 日期：2026-09-26
- 状态：**已批准（2026-09-26）**。§9 两项开放问题已由用户拍板并锁入本文（Q1 不放开直写 / Q2 motion 镜显式拒绝）；业务代码尚未修改，进入实施计划（Plan）阶段。
- 模块：`precision-rework`；切片：`shot-duration-rework`（第二期「不需媒体生成的修改」的镜头时长部分，从切片 2 `compose-input-rework` 规格 §3「移入切片 2b」处派生）。
- 上位路线与原 M50 计划不修改；父切片 `compose-input-rework` 规格与验收不重写，本切片以**加法**扩展其返修契约。
- 阶段纪律：`production-baseline` 真实验收、编辑器实测、第四/五期均不因本切片被标为完成。

## 0. 已拍板前提（用户 2026-09-26 选定）

1. **时长真源落点 = run 级独立覆盖**：新增 `_compose.shot_durations: {shotId: sec}`，**不改写分镜 shots 资产 JSON、不触碰批准链**，维持「零付费、不改分镜」不变量。
2. **范围档位 = 轻**：覆盖**静态图镜**与**音频对齐模式镜**的显示时长，直接复用既有对齐规划路径（`planVoiceAlignedSegments` / `planBestEffortTimeline`）；**motion 视频镜的文件级裁短（超源裁剪 clip）排除**，属中档，另立项。

## 1. 目标

把「改某镜在成片时间轴上的显示时长、但不重新生成任何媒体」纳入与字幕返修、合成输入返修**同一等级的受控闭环**：结构化预览（逐处 旧有效时长→新时长）→ 依赖指纹过期即拒 → 幂等原子确认 → 仅作废合成步并本地重编码 → 回执可核验 → 全同类入口统一收口。

时长边界**不新造算法**：现有 `planVoiceAlignedSegments` 已实现「有效源时长 + 音画不脱节」规则（对齐规划 `align.ts`），本切片仅把 run 级覆盖喂进其输入，不改动该纯函数语义。

### 已确认假设（如与预期不符请在批准前纠正）

1. 面向本地单机、多体裁；不新增多轨 NLE、不重建资产系统、**不改引擎核心（DAG 调度 / action 注册）**。
2. 一律**零付费生成**：不改分镜文本/台词/脚本、不触发 ai_image/ai_video/tts/ASR、不新增 gen_task、不新增 usage。时长变化只导致**本地 FFmpeg 重编码**（消耗时间算力，不承诺即时、不承诺比特一致）。
3. 复用既有 `rework_requests` 台账承载新 kind，**不新增表、不加列**。
4. 测试用隔离库 + 假媒体字节 + 模型桩（本切片零模型）；不操作生产样片、不上传素材、不调用付费端点。
5. 切片 2 `compose-input-rework` 四类既有路径保持绿：本切片以**加法**扩展契约与预览/apply，重构既有仅在可证明不改其行为且全量回归不变差时进行。

### 包含

- 新 kind `shot-duration`（逐镜 `sec` 覆盖）的 schema / 纯语义校验 / 冲突检测 / 逐处 diff / no_effect 拒绝。
- 写侧规范化新增 `_compose.shot_durations` 白名单键（值校验 + clamp + null 清除）。
- 合成期 ffmpeg-merge 消费：把 `shot_durations` 覆盖 onto 对齐输入 `durationSec`（图镜 / 音频驱动镜）。
- 预览/确认/幂等/过期/证据/入口收口：全部沿用父切片 compose-input 通道（同一 capability、同一 apply 事务、同一 gate 作废）。

### 暂不包含（明确排除，防范围蔓延）

- **motion 视频镜文件级裁短 / 超源裁剪 clip**（→ 中档，另立项；本切片对 motion 镜时长覆盖**不改视频段长**，见 §4）。
- 变速 / freeze 拉长 / 超源慢放（改变观感、非「时长覆盖」本意）。
- 改写分镜源时长字段（本切片一律 run 级覆盖，分镜 shots JSON 保持不动）。
- 转场时长 `transition_duration`、BGM/SFX 音量淡入淡出（属切片 2 `compose-config`，已交付）。
- 句级 TTS 与台词重生成（切片 3）、首帧与视频级联（切片 4）、原生对白改句（切片 5）、任何触发付费生成的「重做媒体」、统一 QC 面板（第四期）、交付打包 / 编辑器兼容认证（第五期）。

## 2. 统一验收标准映射（对齐上位路线）

| 目标 | 本切片硬性验收 |
|---|---|
| 改得准 | 预览逐处列 旧**有效**时长→新时长（有效＝当前实际入轴段长，非分镜源字段）、受影响镜集合、下游段/句位置将本地重算清单；执行结果与确认范围逐字一致；过期预览被拒 |
| 少返工 | 仅重置 `ffmpeg_merge`；未列入覆盖的镜段长不变；同 requestKey 重复确认只应用一次；分镜源资产、配音、BGM/SFX 源、gen_task 一律不重做 |
| 质量可验证 | 每次确认写 applied 回执（固定基准指纹、变更集 `{shotId:旧→新}`、被重置步骤、旧 gate 是否作废）；旧成片批准自动作废并标待审；本地重编码不冒充「内容已核验」 |
| 交付可信 | 成片版本与其 `shot_durations` 绑定可查；`pending_recompose` 不把旧片说成已按新时长产出；下载/导出固定到明确成片版本 |

## 3. 单一变更与预览契约（新增第 5 类 kind，复用台账）

服务仍置于 `apps/server/src/services/rework/`，与父切片 `compose-input.ts` 同模块，扩展判别联合（纯函数段，不触 DB、不触执行）：

```ts
type ComposeInputChange =
  // ... 既有四类（compose-config / bgm / sfx / shot-select）逐字不变 ...
  // 镜头时长覆盖：把某镜(shotId)在成片时间轴上的显示时长设为 sec 秒。
  // 落点 _compose.shot_durations[shotId]；sec ∈ (0, MAX]；有效段长仍受音频对齐下限约束（见 §4）。
  | { kind: 'shot-duration'; shotId: string; sec: number }
```

- `MAX` 取防御性上限（拟定 `SHOOT_DURATION_MAX_SEC = 600`，与 `normalizeComposeConfigPatch` 同处真源声明，避免 magic number 漂移）；`sec` 必为有限正数，否则 `bad_field`。
- 单请求变更数上限沿用 `MAX_COMPOSE_INPUT_CHANGES = 500`；一次请求可与其余四类混合（皆收敛到本地重合成），**不得含任何生成型目标**。
- 冲突检测：同一 `shotId` 出现多条 `shot-duration` → 拒绝（`conflict`），要求最后值唯一。
- no_effect：若覆盖后的**有效段长**与当前入轴段长逐字相同（含因 clamp 落回原值）→ 整体 `no_effect` 拒绝，与父切片同规则。
- 预览返回沿用父切片结构，新增字段：`shotDurations`（基准当前值，来自 `_compose.shot_durations`）与每处 diff `{shotId, oldEffectiveSec, requestedSec, willClampToSec?, warn:boolean}`；`willClampToSec`/`warn` 如实反映「请求短于该镜对齐语音 Σ → 实际落到 Σ 并告警」（§4）。

## 4. 有效时长边界与消费（复用既有对齐规划，不造第二条时轴逻辑）

现有真源：
- `shotDurationSec(shot)`（`services/shot/board.ts`）读分镜 `shot.duration` / `shot.duration_sec`，经 `parseShotLines`（`align.ts`）→ `AlignShotInput.durationSec`，并驱动 `planVoiceAlignedSegments` / `planBestEffortTimeline`。
- `readComposeConfig`（`compose-config.ts`）**整包透传 `_compose`**，故 `shot_durations` 读写回环天然成立，无需改 reader。

消费注入点（`ffmpeg-merge/index.ts`，`loadShotAlignShots` 之后、`planBestEffortTimeline` 之前）：把 `composeCfg.shot_durations` 覆盖 onto 对应 `alignShots[].durationSec`（不改分镜源、不改分镜文本）。语义完全交回既有纯函数：

- **音频对齐镜（有 `lines` 命中实测配音）**：
  - 覆盖 > Σ句 → 段长＝覆盖，尾部补静音（自由拉长，不脱节）；
  - 覆盖 < Σ句 → 段长**强制回落到 Σ**，该镜记入 `warnShots`（拒绝裁到语音以下 → 音画不脱节），预览如实标 `willClampToSec=Σ`、`warn=true`。
- **空镜 / 无对齐语音的静态图镜**：段长＝覆盖（无源约束，任意正秒；`fallbackDur` 仅作未覆盖时兜底）。
- **motion 视频镜**（Q2 已定：显式拒绝）：段长基准＝clip 实测时长（`buildClipDurByShotId`，「不拉伸」），本切片**不支持**对视频镜做时长覆盖（文件级裁短属中档，明确排除）。预览阶段命中 motion 视频镜的 `shot-duration` → **fail-closed `blocked`**，附「视频镜时长返修属中档（文件级裁切），本切片未含」；不静默 no-op、不纳入可执行变更集，避免用户误以为已生效。capability/preview 需据在用资产 kind / 段模式判定目标镜属 images/audio-align 还是 motion。
- 下游影响：段/句位置、`params.timeline` 快照、字幕平移由既有 `planBestEffortTimeline` / `buildEditTimeline` 同源重算；无手写偏移重算的第二套逻辑。

## 5. 写侧规范化、持久化、幂等与提交事务

- **写侧白名单**：`normalizeComposeConfigPatch` 增一支 `key === 'shot_durations'`：入参须为对象、键为非空 `shotId`、值逐项校验有限正数并 clamp 到 `(0, MAX]`；`value === null`（整键清除）→ 删该键回落「无覆盖」缺省（沿用统一 null 语义）。非法 → `WorkbenchError('bad_field')`，与既有键逐字一致的 code/message。此规范化为 `updateComposeConfig` 直写与 `compose-input` 返修**共用真源**，杜绝两套 clamp 漂移。**（Q1 已定：不放开直写）**`shot_durations` 仅由 compose-input apply 路径写入；通用 `updateComposeConfig` 草稿直写路由的**可写键集合排除 `shot_durations`**（收到即 `bad_field`），保持「时长只经受控返修闸」。
- **落库位置**：确认事务把 `shot-duration` 变更合并进 `run.input._compose.shot_durations`（字段级、按 shotId 增量合并，保留其余镜既有覆盖），经上述共享规范化，不绕过白名单。
- **指纹自动覆盖**：基准含 `readComposeConfig(run.input)`（父切片 §4 已确立），`shot_durations` 任一变化 → 指纹变 → 旧预览 `stale_preview/409`，与字幕 §6.2、父切片同规则；**无需新增指纹因子**。消费期所有本地重合成入口执行前调既有 `computeFingerprintForCompose*Recheck` 同族复验（父切片 T5 已铺，本切片不改）。
- **确认事务**：沿用父切片原子领用 helper——重验 request=ready / previewHash / 归属 / 指纹一致 → 落 `_compose.shot_durations` → 条件领用 run（completed/failed→queued）与 compose step（succeeded→pending）→ **作废旧 gate（删 `output.gate`，新片必复审）** → 提交后 `engine.startRun`。幂等：同 requestKey 二次确认回放首次 applied 回执，不再重置、不再入队。
- applied 回执固定：runId、stepKey、baseFingerprint、previewHash、被重置步骤、旧 gate 是否作废、appliedAt、`{shotId: 旧有效→新有效}` 清单（含 clamp/warn 标注）。

## 6. 入口覆盖与「同类入口一次收口」

时长覆盖写入路径**唯一**：compose-input 返修 apply（专属端点）。既有本地重合成入口（通用 `resetStepForRecompose`、轻松创作 `recomposeCreation`、单步重跑 `resetStepForRerun`）无需新增调用点——它们对 `ffmpeg_merge` 步的 gate 作废与消费期指纹复验（父切片 T5）已覆盖本 kind（`shot_durations` 变了就走同一 stale 复验）。禁止任一路径「直写 `shot_durations` 后绕过预览直接重合成」。**（Q1 已定）**通用 `updateComposeConfig` 草稿直写不放开 `shot_durations`——写入唯一入口为 compose-input 返修 apply。

前端入口：并入父切片已交付的「合成返修」弹窗（`ComposeInputReworkModal`）——逐镜一行「时长」输入（保持 / 覆盖为 X 秒），与 config / BGM / SFX 同页收口，复用其 capability 双模探测 / preview / apply / guardClose，不新建弹窗、不重做表单。

## 7. 能力门禁与基准

复用父切片 `assessComposeInputCapability(runId, stepKey)`，**门禁语义逐字相同**（非在途/未取消、存在 `succeeded` 的 `ffmpeg_merge`、无范围外 failed、下游仅 LOCAL_SAFE、成片可固定）。基准在父切片 compose-input 变体之上，`shot_durations` 因走 `readComposeConfig` 自动纳入，无额外采集。

## 8. 测试与验证（探针加法，零模型）

- 扩展 `probe-precision-rework.ts` 新增 `--section=shot-duration`（隔离库 + 假媒体 + 模型桩，零计费）。核心断言：
  1. 图镜覆盖拉长（无语音）→ 段长＝覆盖、`warn=false`；
  2. 音频对齐镜覆盖短于 Σ → 有效段长 clamp 到 Σ、`warn=true`、`willClampToSec=Σ`（不脱节）；
  3. motion 视频镜覆盖 → 视频段长不随覆盖改变（轻档边界，如实不改写）；
  4. `no_effect`（覆盖后有效段长与当前一致）整体拒绝；
  5. `shot_durations` 变更使旧预览 `stale_preview/409`；applied 后旧 gate 作废、`pending_recompose` 不冒充新片；
  6. 同 requestKey 二次确认只应用一次、回放首次回执；
  7. 冲突（同 shotId 多条）/ 非法 sec（≤0 / 非有限 / 超 MAX）→ `bad_field`/`conflict`；
  8. 写侧规范化与 `updateComposeConfig` 真源一致（若 Q1 放开）。
- 父切片回归不变：`--only=precision-rework` 既有 `compose-input` / 字幕分节全绿；字幕首切片路径保持绿。
- 门禁命令：
  ```
  pnpm -C d:\work\AI\Agent\agencys-content-studio --filter @acs/server exec tsx scripts/run-probes.ts --only=precision-rework --section=shot-duration --jobs=1
  pnpm -C d:\work\AI\Agent\agencys-content-studio -r typecheck
  ```
- m26 split-audit 不破线（单文件 ≤800）；本切片前端仅并入既有弹窗、后端加法为主，预期净新增违规为零。

## 9. 开放问题（已由用户 2026-09-26 拍板锁定）

- **Q1 直写口 = 不放开**：`shot_durations` 只经 compose-input 返修闸写入；通用 `updateComposeConfig` 草稿直写排除该键（见 §5/§6）。草稿期时长仍由分镜源决定。
- **Q2 motion 视频镜 = 显式拒绝**：命中 motion 镜的 `shot-duration` 预览 fail-closed `blocked`（见 §4），不静默 no-op；视频镜文件级裁短属中档，另立项。

无剩余开放问题，规格决策完整，进入实施计划。
