# 精确返修第二切片：合成输入本地返修（BGM/SFX 配置 · 候选改选 · 镜头时长）

> **归档戳（2026-09-30）**：本稿被代码探针或验收文档引用为「实现真源存档」，请原地保留、勿删勿移。正文为落笔即冻结的历史快照，交付状态见 [索引](README.md)。

- 日期：2026-09-26。
- 模块：`precision-rework`；切片：`compose-input-rework`（第二期切片 2「不需媒体生成的修改」的非字幕部分）。
- 状态：**已批准（2026-09-26）**。§9 四项开放问题已由用户拍板并锁入本规格；业务代码尚未修改，进入实施计划阶段。
- 上位路线：《百工工作室专业化生产分期路线》（Executing，文件不修改）。首切片 `subtitle-revision` 已合并（HEAD `c028a88`）。
- 阶段纪律：`production-baseline` 真实验收、编辑器实测、第四/五期均不因本切片被标为完成。

## 0. 为什么是这一切片（现状核实摘要）

调研确认：切片 2 点名的三类编辑**底层写操作其实已存在**，缺的不是"能不能改"，而是"改得准 / 少返工 / 质量可验证 / 交付可信"所需的受控闭环：

| 能力 | 现状 | 证据 | 缺口 |
|---|---|---|---|
| BGM/SFX/转场/多画幅/音量配置 | 已可写 `run.input._compose` | `services/compose-config.ts` L167-244、`routes/compose.ts` L34-40 | 直写即生效于"下一次重新合成"，**无影响预览、无依赖过期校验、无幂等确认、无版本证据、旧 gate 不自动作废** |
| BGM/SFX 资产绑定/移除 | 已可绑上传/项目音频复制行 | `compose-config.ts` L259-467 | 同上；换一首 BGM 与改音量被同一泛化"重新合成后生效"文案对待 |
| 候选改选（已有资产替换） | 已可合并选中并落库 | `creation-chat/candidates.ts` `selectCreationShots` L82「不触发执行、零计费；改完要生效到成片需再走 recompose」 | 无"改哪几个镜 → 影响哪些步骤 → 保留哪些媒体 → 是否本地重编码"预览与确认闸 |
| 本地重新合成原语 | 已存在且零付费 | `shot/reset.ts` `resetStepForRecompose` L15、`recomposeCreation` L109（idempotencyKey 去重） | 字幕返修之外的入口不经过统一"消费期依赖复验"，过期基准可被绕过 |
| 镜头时长（裁切近似） | 分镜 per-shot 时长覆盖驱动段时长 | `ffmpeg-merge/segments.ts` L26-117 | 语义与 BGM/选片不同轴、源上限因 kind 而异——**已决定移出，单列切片 2b** |

字幕首切片已沉淀可复用的返修骨架：台账 `rework_requests`（**与 kind 无关**，存 changesJson/previewJson/resultJson/state）、`upsertReworkRequest`/`advanceReworkRequestState` 五态机、`baseFingerprint`（已含 bgm/sfx/composeConfig/assetHashes/stepOutputs/brand）、`computeFingerprintForComposeRecheck` 消费期复验、apply 原子领用事务、readmodel 四态投影（含 `pending_recompose`）。

## 1. 目标与边界

把"改变合成输入但不重新生成任何媒体"的两类编辑（合成配置 / BGM·SFX 资产换绑 / 候选改选），纳入与字幕返修**同一等级的受控闭环**：结构化预览 → 依赖指纹过期即拒 → 幂等原子确认 → 仅作废必要步骤并本地重合成 → 版本/回执可核验 → 全同类入口统一收口。（镜头时长裁切已移出至切片 2b。）

已确认假设（如与你的预期不符，请在批准前纠正）：
1. 面向本地单机、多体裁；不新增完整多轨 NLE、不重建资产系统、不改引擎核心。
2. 本切片一律**零付费生成**：不改分镜/台词/脚本、不触发 ai_image/ai_video/tts/ASR、不新增 gen_task、不新增 usage。配置/选片/时长变化只导致**本地 FFmpeg 重编码**（消耗时间与算力，不承诺即时完成，也不承诺比特一致——与字幕"无烧录逐字节复制快速路径"本质不同，必须如实区分）。
3. 允许复用既有 `rework_requests` 台账承载新 kind，**不新增表**；若必须加列，先在此规格登记并单独获批。
4. 测试用隔离库 + 假媒体字节 + 模型桩（本切片默认零模型）；不操作生产样片、不上传素材、不调用付费端点。
5. 首切片字幕路径保持绿：本切片以**加法**扩展返修骨架，重构既有字幕 apply/baseline 仅在可证明不改变其行为、且全量回归不变差时进行。

包含：合成配置（转场类型/时长、bgm_volume、bgm_fade、sfx_volume、multi_aspect、subtitleBurn/brandApply 开关、brand run 级覆盖）、BGM/SFX 已存在资产换绑与移除（assetId 通道）、候选改选（在**同一生成步骤 output 内的同类历史候选/在用资产**间改选在用版本）的预览/确认/幂等/过期/证据/入口收口。

暂不包含（明确排除，防止范围蔓延）：**镜头时长/有效源时长内裁切（移入切片 2b，需另核静态图无源上限、裁切后后续位置重算红线）**、BGM/SFX **multipart 上传新素材**（引入新资产，仍走原 compose 路由，有成片时用本闸预览已存在资产换绑重合成）、句级 TTS 与台词重生成（切片 3）、首帧与视频级联（切片 4）、原生对白改句（切片 5）、任何触发付费生成的"重做媒体"、统一 QC 面板（第四期）、交付打包/编辑器兼容认证（第五期）、富文本字幕样式、自动校时、增删/拆并字幕。

## 2. 统一验收标准映射（对齐上位路线）

| 目标 | 本切片硬性验收 |
|---|---|
| 改得准 | 预览列出每一处 原值→新值（配置项旧/新、候选旧 assetId→新 assetId、时长旧→新）、受影响步骤集合、将重做的合成范围；执行结果与确认范围逐字一致；过期预览被拒 |
| 少返工 | 仅重置 ffmpeg_merge（及其白名单本地下游）；未受影响的镜头/配音/BGM 源资产与 gen_task 不重做；同 requestKey 重复确认只应用一次；"续跑保留已受理任务"与"主动重生成"语义不被混淆 |
| 质量可验证 | 每次确认写 applied 回执（固定基准指纹、变更集、被重置步骤、新版本/成片关联）；旧 gate 批准自动作废并标待审；本地重编码不冒充"内容已核验" |
| 交付可信 | 成片版本与其合成输入配置绑定可查；`pending_recompose` 状态不把旧片说成已按新配置产出；下载/导出固定到明确成片版本 |

## 3. 单一变更与预览契约（新增 kind，复用台账）

服务仍置于 `apps/server/src/services/rework/`，纯变更编译与 DB/文件/执行分离。新增判别联合（与 `SubtitleChange` 并列，不合并进字幕 schema）：

```ts
type ComposeInputChange =
  // 合成配置：字段级补丁，值为该键新值；null=清除回落缺省（沿用 updateComposeConfig 语义）
  | { kind: 'compose-config'; patch: Partial<Pick<ComposeConfig,
        'transition'|'transition_duration'|'bgm_volume'|'bgm_fade'|'sfx_volume'|'subtitleBurn'|'brandApply'|'multi_aspect'|'brand'>> }
  // BGM 换绑/移除：复用 bindBgmFromAsset/removeBgm 语义，assetId=null 表移除（不接受上传字节走本闸，见 §6）
  | { kind: 'bgm'; assetId: number | null }
  // 某镜 SFX 换绑/移除
  | { kind: 'sfx'; shotId: string; assetId: number | null }
  // 候选改选：把某镜(shotId)在用资产换成同类已存在的另一 assetId（该资产须属同一生成步骤 output、同 kind、未删）
  | { kind: 'shot-select'; shotId: string; assetId: number }
```

- 单请求变更数上限 500；一次请求可混合上述任意 kind（因都收敛到"本地重合成"），但**不得含任何生成型目标**。
- 预览返回：`requestId、previewHash、baseFingerprint、基准（run/step/成片/当前 _compose/BGM·SFX 在用资产/各镜在用 assetId）、规范化变更列表、逐处 原值→新值、将重置步骤、保留媒体清单、成本分类、警告与不可执行原因`。
- 成本口径诚实声明：`modelCalls:0`、`charged:false`，但 `localReencode:true`——配置/BGM/选片/时长改变**必然需要真实重编码**，不提供字幕那种"关烧录逐字节复制"快速路径（因为音频混合/时间轴已变）。UI 须显示"将本地重新合成（不产生模型费用，但需编码时间）"。
- 校验全部在预览阶段完成（fail closed，不产出部分预览）：transition ∈ 枚举、数值 clamp 与 `updateComposeConfig` 同真源（复用其规范化函数，不重抄）、bgm/sfx `assetId` 存在且 kind=audio 且属本 run 项目、shot-select 目标资产与在用资产**同 kind 且属于同一生成步骤 output 集合（同镜历史候选可跨版本组，但不越步骤）**、变更非零效果（与当前基准一致 → `no_effect` 整体拒绝）。

## 4. 能力门禁与基准（compose-input 变体）

复用 `baseline.ts` 的 fail-closed 骨架，但**不要求字幕快照**（大量成片本就无字幕；配置/选片返修与字幕无关）。新增 `assessComposeInputCapability(runId, stepKey)`：

- 运行非在途/未取消；存在 `ffmpeg_merge` 步且 `succeeded`；无范围外 failed；下游仅 LOCAL_SAFE_ACTIONS、无待执行付费步、无受理不确定任务；成片可固定于 compose output。（与字幕同一门禁语义，直接抽公共判定复用。）
- 基准 = 成片 hash + timelineCore + `readComposeConfig(run.input)` + 当前 BGM 资产 id/sha + 各镜 SFX map + 各镜在用 assetId（`selectedMapOf`）+ brand + `stepOutputs`/`assetHashes`。**这正是既有 `buildFingerprint` 的字段集去掉 subtitle sourceRef/currentEdit**——抽出共享指纹核，避免两套漂移。
- 指纹任一因子变（含经旁路直接改了 `_compose`/换绑/改选）→ 旧预览 `stale_preview/409`，与字幕 §6.2 同规则；消费期所有本地重合成入口执行前调 `computeFingerprintForComposeRecheck` 的同族复验。

## 5. 持久化、幂等与提交事务

- 复用 `rework_requests`：`state` 沿用 `parsing|uncertain|ready|blocked|uncertain|applied`（本切片无模型，`parsing` 不用）；`changesJson` 存 `ComposeInputChange[]`；`baseFingerprint`、`previewJson`、`resultJson` 同字幕用法。`requestHash` 由规范化 changes + 指纹派生，保证同键同内容回放、异内容 conflict。
- applied 回执固定：runId、stepKey、baseFingerprint、previewHash、被重置步骤、旧 gate 是否作废、appliedAt、（候选改选时）新旧 assetId 清单。
- 确认事务（与 `apply.ts` 同构，抽公共"原子领用 + 条件更新 run/step + 作废旧 gate + 入队"低层 helper）：
  1. 重验 request=ready、previewHash、归属、依赖指纹一致。
  2. 事务内把变更落到**既有真源位置**：配置→`run.input._compose`（经共享 `updateComposeConfig` 的纯规范化，不绕过其白名单）；BGM/SFX→ 复用 `bindBgmFromAsset/removeBgm/bindSfxFromAsset/removeSfx`（本切片只走 assetId 通道，multipart 上传仍走原路由，见 §6）；shot-select→ 复用 `rebuildShotOutput`/`selectedMapOf` 的在用映射更新，不覆写源资产、不删历史候选。
  3. 条件领用 run（completed/failed→queued）与 compose step（succeeded→pending）；作废旧 gate（删 output.gate，新版本必复审）。并发竞争只一方落锤，失败方复查终态回放赢家用回执。
  4. 事务提交后才 `engine.startRun`（不改引擎）；提交后中断沿用既有 queued 恢复，不二次推进。
- 幂等：同 requestKey 二次确认 → 回放首次 applied 回执，不再重置、不再入队。

## 6. 入口覆盖与"同类入口一次收口"（对齐用户强约束）

必须枚举**所有能触发本地重合成/生效成片**的入口，统一经 §4/§5 的指纹复验与确认闸，禁止任一路径"直写配置后绕过预览直接重合成"：

| 入口 | 现状 | 本切片处理 |
|---|---|---|
| `routes/compose.ts` PUT config、POST/DELETE bgm·sfx | 直写 `_compose`/资产行，靠"另点重新合成" | 保留**草稿写**（无成片时的初始配置仍可直接写）；**已有成片**时的返修改走本 preview/apply 闸（capability 探测：有可返修成片→建议走返修；无成片→沿用直写）。避免把首次配置也强行预览化 |
| `recomposeCreation`（轻松创作） | 重置 compose 步 + idempotency 去重 | 其消费前追加 `computeFingerprintForComposeRecheck` 同族复验：若存在待生效的已确认返修，用其固定输入重合成；不接受过期基准 |
| 通用 `runs/:id` recompose / 单步重跑 `resetStepForRerun` / 级联 `resetChainForRerun` | 直接重置步骤 | 与字幕 §6.2 同规则：这些入口执行前统一复验合成输入依赖；不因绕过本闸而静默用过期配置 |
| 断点续跑 `runs/:id/resume` | `stripResumeSubtitleEdits` 剥字幕指针 | 续跑派生新 run 的 `_compose` 克隆语义**保持现状**（配置本就随 run.input 复制）；不新增跨 run 的选片指针盲复制风险（选片在用映射属 step output，续跑按既有 output 复制规则） |
| 单步/级联重跑、候选改选、资产版本恢复 | 各自权限/计费语义 | 保留原语义；使受影响"合成输入返修"过期，不能绕过 compose 校验 |

- UI 沿用既有组件与 token：配置/选片编辑器复用 `ComposeSettingsModal.vue`/`ShotSfxModal.vue`/候选选择面的既有控件，**新增的是"预览影响 → 确认 → 本地重合成状态"这一闸**，不重做表单。四入口（运行详情步卡 / 画布节点抽屉 / 镜头工作台 / 轻松创作成果区）与字幕返修共享同一 `SubtitleReworkEntry` 式自治探测组件的扩展，避免"指哪打哪"。

## 7. 技术栈、目录与代码约定

- 沿用 TypeScript、Hono、Zod、Drizzle/libsql、Vue3、Vite、FFmpeg/ffprobe；**不新增依赖**。
- 新增：`services/rework/compose-input.ts`（变更契约 + 预览编译 + apply 确认，镜像 `contract/preview/apply` 的 kind 专门化），`services/rework/capability.ts`（抽字幕/合成输入共用门禁与指纹核）。
- 复用（不复制粘贴第二套）：`ledger.ts` 通用 upsert/advance、`compose-config.ts` 配置真源与规范化、`shot/reset.ts` 原子重置与 `rebuildShotOutput`/`selectedMapOf`、`createFingerprintForComposeRecheck` 消费复验、`readmodel.ts` 四态投影扩展。
- 若为复用而重构 `baseline.ts`/`apply.ts` 抽取 helper：以"字幕探针全绿 + 全量断言失败集不变"为准入门槛，重构与功能加法定位为**独立提交单元**。
- 探针：扩展 `probe-precision-rework.ts` 新增分节（如 `compose-input`），沿用隔离库 + `--section` 单跑 + 模型桩（本切片零模型）。

## 8. 迁移与回退

- 不搬迁既有 run/assets/versions；旧数据按"无待生效返修"读取，行为与切片前逐字一致。
- 新闸门在后端契约 + 探针 + 本地重合成闭环齐备后再接前端，不暴露半成品。
- 回退：关闭新 preview/apply 写入入口即回到"直写配置 + 手动重新合成"现状；台账新 kind 行为惰性历史，不破坏字幕路径。保留 `rework_requests`（字幕仍用）。

## 9. 开放问题（已拍板锁定 2026-09-26）

1. **镜头时长（“有效源时长内裁切”）**：→ **移出本切片，单列切片 2b**。本切片只做合成配置 + BGM/SFX 已存在资产换绑 + 候选改选。2b 需另核静态图无源上限、视频 `probeMediaDuration` 实测上限与“裁切后后续时间位置/字幕重算但不重生媒体”红线。
2. **BGM/SFX multipart 上传新素材**：→ **不纳入本返修闸**。上传仍走原 compose 路由（写草稿/绑定新资产行）；有成片后若要把新绑定反映到成片，用本闸以 assetId 通道预览“换绑到该已存在资产 + 本地重合成”。本切片严格只处理“已存在资产”，守住零新素材零生成。
3. **配置写入模式**：→ **草稿/返修双模**。无成片（尚未合成/首次配置）时初始 `_compose` 写仍走既有 `updateComposeConfig` 直写；**已有可返修成片**时的配置返修改走本 preview/apply 闸（capability 探测决定）。对既有 compose 路由语义改动最小。
4. **候选改选可选集**：→ **同一生成步骤 output 内的同类历史候选**（不越步骤、不跨 kind），比“仅该镜版本组”更贴近“已有资产替换”初衷。

## 10. 验收与验证命令（实施后须全绿）

硬性验收（探针 + 隔离本地重合成断言）：
1. 改 `bgm_volume`：预览显示旧值→新值、仅重置 compose 步、`modelCalls:0`、`localReencode:true`；确认后 applied 回执、旧 gate 作废、run 入队；未确认不改变任何状态。
2. BGM 换绑到项目另一音频资产 / 移除：在用 BGM 指针切换正确、源资产不删、历史可回溯；对无字幕成片同样可用（证明不依赖字幕快照）。
3. 候选改选某镜到同类另一 assetId：仅该镜在用版本变、其余镜头 output 不变、不触发生成、本地重合成消费新选。
4. 过期即拒：预览后用旁路直改 `_compose` 或重跑上游使指纹变 → 旧 preview apply 返回 `stale_preview/409`。
5. 幂等：同 requestKey 重复 apply 回放首次回执、不二次入队；同键异载荷 409。
6. 全同类入口（recomposeCreation / 通用 recompose / 单步·级联重跑 / resume）执行前统一复验合成输入依赖，无一绕过。
7. 零付费红线：全程供应商调用=0、gen_task 不新增/不重置为待生成、usage 不新增；本地重编码如实标注耗时。
8. 字幕首切片回归不变：`--only=precision-rework` 全绿；全量断言唯一失败仍为 m26 既有存量 3 文件、不新增。

```powershell
pnpm -C d:\work\AI\Agent\agencys-content-studio --filter @acs/server exec tsx scripts/run-probes.ts --only=precision-rework --jobs=1
pnpm -C d:\work\AI\Agent\agencys-content-studio -r typecheck
pnpm -C d:\work\AI\Agent\agencys-content-studio --filter @acs/server validate:templates
pnpm -C d:\work\AI\Agent\agencys-content-studio --filter @acs/server exec tsx scripts/run-probes.ts
pnpm -C d:\work\AI\Agent\agencys-content-studio --filter @acs/web build
```

四类证据分列：自动门禁 / 隔离浏览器验收 / 真实样片质量 / 编辑器实测。本轮技术验收不依赖新增付费授权；真实质量与浏览器实测按纪律列为待你在本地环境执行的人工门，未实测不写通过。

## 11. 授权纪律

- **Always**：先规格确认再按可测试小增量实现；覆盖全部同类入口一次收口；保留历史；结果绑定版本；失败/未知如实记录；重构与功能分开提交。
- **Ask first**：任何新增表/列、对字幕既有 apply/baseline 的行为性重构、超出"零付费本地重合成"范围的生成型改动、生产服务切换、真实项目写入、外部调用、额外预算、以及 §9 任一开放问题的扩大。
- **Never**：为"可编辑"取消批准/原声/严格校验守卫；把配置/选片改动的本地重编码谎称"内容已核验"或"比特不变"；自动重发不确定请求；修改原路线或旧 M50 计划；覆盖原素材/源资产；自动 commit/push。
