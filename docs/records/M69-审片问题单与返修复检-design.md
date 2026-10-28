# M69 审片问题单与返修复检（design）

> 状态：已实现（2026-10-28）。实现计划：`docs/records/plans/M69-计划.md`；探针：`apps/server/scripts/probe-m69.ts`。来源：短视频/短剧核心缺口分析 → 用户确认按优先级开发。
> 关联：第四期统一 QC 面板（只读核验）、精确返修（字幕 / 合成输入）、运行详情右栏、`params.timeline` 唯一真源。
> 定位：把「看片发现的问题」变成可定位、可派给既有返修、可在新成片上复检的结构化问题单；不新建生成能力、不改批准链。

## 一、背景与触发

现有质量链路是三段分离的：

1. **QC 面板能测，但不能定位**：`QcCheck` 只有 10 个机读键，没有镜号、时间段、问题 ID，主观项恒 `not_tested`；面板只读，不能把「第 12 秒纸袋消失」变成可操作条目（[qc/types.ts](../../apps/server/src/services/qc/types.ts) L35–44、[qc/report.ts](../../apps/server/src/services/qc/report.ts) L165、[RunQcPanel.vue](../../apps/web/src/components/run/qc/RunQcPanel.vue) L124–167）。
2. **返修能改，但不知道改的是哪个问题**：字幕返修与合成输入返修已有预览→确认→本地重合成与 `rework_requests` 台账（applied 终态、requestId 回执），但没有「问题」实体，返修请求与审片意见不关联（[rework/contract.ts](../../apps/server/src/services/rework/contract.ts)、[routes/rework.ts](../../apps/server/src/routes/rework.ts)、`rework_requests` 表）。
3. **改完无法同项复检**：新成片产生后，QC 只能整体重跑；没有「同一个问题在新成片里是否仍存在」的证据，也没有返修前/后对照。

短剧与单条短视频都需要这条闭环：前者问题是连续的（道具/人物/口型/字幕），后者问题是集中的（节奏/字幕/音画不同步）。本项是两条优先级路线唯一交集，且全程本地、零模型、零付费，可用隔离探针完整验证。

## 二、现状（代码级真源）

- **时间轴可定位**：成片 `params.timeline.segments[]` 已含 `shotId / kind / durSec / startSec / lineIds / silenceSec`；`timeline.subtitle.cues[]` 含最终轴 cue（`timeline-snapshot.ts` L19–81）。`introSec` / `outroSec` / `totalSec` 同快照。唯一真源只读，不重建第二套时轴。
- **视频可拖动**：`GET /assets/:id/file` 支持 `Range` 与 `206`（[assets.ts](../../apps/server/src/routes/assets.ts) L116–152），可直接做审片播放器。
- **返修可复用**：字幕 `SubtitleReworkModal`、合成输入 `ComposeInputReworkModal` 均自治探测、自包含，`applied` 事件带 `requestId`；确认后本地重合成、零付费。
- **运行详情落点**：右栏已有 `RunQcPanel` / `RunDeliveryCertPanel`，新面板同级追加（[run-detail/index.vue](../../apps/web/src/views/run-detail/index.vue) L235–239）。
- **删除面**：run 删除走 `purgeRunRecords`（[run-delete.ts](../../apps/server/src/services/run-delete.ts) L28–38）；项目彻底删除在 `routes/projects.ts` L236–268 逐表清理。新表必须接入这两处，避免孤儿行。
- **零成本**：全部读写为本库 SQLite + 本地 ffprobe/文件流；不调用 LLM/TTS/图像/视频供应商。

## 三、决策留痕（用户确认，2026-10-28）

- **第一刀 = 共同优先级第 3 项**：问题单 → 定向返修 → 同项复检；主场景按「连载短剧 + 单条短视频并重」处理。
- **问题单不阻断导出/批准**：只做审片台账与返修入口，不改 `delivery_checked`、不放行/驳回 gate。
- **复检只报证据变化，不自动判过**：视觉一致性、口型、听感仍由人工确认。
- **持久化 = 1 张新表**：问题有独立生命周期、需按 run/status 查询、并发写不与 `run.input._compose` 互相覆盖；不用 `run.input._reviewFindings` 的 JSON 方案。
- **M68 数字人口播暂缓**：设计保留、不占活动 L1 spec，本轮不实现。

## 四、方案

### 4.1 概念与非目标

**问题单**是一行 `review_findings`：`run + 基准成片 + 范围（镜头/时间/全片）+ 类别 + 严重度 + 备注 + 状态`。

非目标：

- 不做自动视觉/口型/听感判定，不接多模态评分；
- 不新增付费生成；视觉问题仍需用户在工作台确认重出（重新计费）；
- 不把 blocker 变成导出硬门禁；
- 不做跨 run/跨集问题汇总、不做项目级看板；
- 不改模板 YAML、不改批准链、不改 QC 既有 10 键语义。

### 4.2 数据模型（唯一新增持久化）

`db/schema.ts` 新增 `review_findings`（1 新表；既有表 0 新列）：

| 列 | 类型 | 语义 |
|---|---|---|
| `id` | integer PK autoincrement | 问题 ID |
| `project_id` | integer not null | 项目 |
| `run_id` | integer not null | 运行 |
| `step_key` | text not null default `compose` | 合成步骤键；创建时钉住，复检按同一步骤定位成片 |
| `base_final_asset_id` | integer not null | 创建时的基准成片 |
| `client_key` | text null | 前端幂等键（同 run 唯一，NULL 可重复） |
| `scope_kind` | text not null | `shot` / `time` / `global` |
| `shot_id` | text null | shot 范围的镜头 ID（服务端从 timeline 反查） |
| `start_ms` / `end_ms` | integer null | 最终成片绝对轴毫秒；shot 范围由服务端派生 |
| `category` | text not null | `visual` / `prop` / `lip_sync` / `subtitle` / `audio` / `pacing` / `other` |
| `severity` | text not null | `blocker` / `major` / `minor` |
| `note` | text not null | 用户描述（≤2000 字符） |
| `status` | text not null default `open` | `open` / `in_rework` / `pending_recheck` / `verified` / `dismissed` |
| `rework_request_id` | text null | 关联的 applied 返修请求；手工修复时为空 |
| `rework_note` | text null | 手工返修留痕（mark-rework 写入，不随复检覆盖） |
| `base_snapshot` | text not null default `'{}'` | 创建时的证据快照（JSON，有上限） |
| `recheck_state` | text null | `changed` / `unchanged` / `unverifiable` |
| `recheck_final_asset_id` | integer null | 复检针对的成片 |
| `recheck_note` | text null | 复检证据摘要（人读） |
| `recheck_at` | integer null | 复检毫秒时间戳 |
| `resolution_note` | text null | 人工终判/忽略/重开备注（verify/dismiss/reopen 写入，无 note 则 null） |
| `created_at` / `updated_at` | integer not null | 毫秒时间戳 |
| `resolved_at` | integer null | verified / dismissed 时写入 |

索引：`unique(run_id, client_key)`、`index(run_id, status)`、`index(project_id)`。迁移由 `pnpm --filter @acs/server db:generate` 生成 `apps/server/drizzle/0002_*.sql`，不手写/手改迁移文件。

`base_snapshot` 结构（`v=1`，只存“创建时看到的证据”，不当时轴用）：

```json
{
  "v": 1,
  "stepKey": "compose",
  "finalAssetId": 123,
  "finalSha256": "…",
  "hasTimeline": true,
  "totalMs": 45000,
  "introMs": 1000,
  "shot": { "shotId": "S3", "assetId": 456, "sha256": "…", "startMs": 12000, "endMs": 19000, "durMs": 7000 },
  "segments": [{ "shotId": "S3", "assetId": 456, "sha256": "…", "startMs": 12000, "endMs": 19000, "durMs": 7000 }],
  "segmentsTruncated": false,
  "cues": [{ "id": "c1", "startMs": 12500, "endMs": 13200, "text": "…" }],
  "cuesDigest": "…",
  "cuesCount": 3,
  "cuesTruncated": false,
  "audio": {
    "bgm": { "assetId": 9, "sha256": "…", "volume": 0.6, "fadeSec": 1.5 },
    "sfx": [{ "shotId": "S3", "assetId": 77, "sha256": "…" }]
  }
}
```

快照只存与问题范围相交的证据：`shot` 存该镜段 + 与该镜区间相交的 cues；`time` 存与窗口相交的段 + 窗口内 cues；`global` 存全片段与 cues。`audio` 取 `params.timeline.bgm/sfx`（实际生效值，含默认配置），不读 `run.input._compose` 的覆盖意图；BGM/SFX 的 `sha256` 在读写时 join `assets` 取得。`hasTimeline=false` 表示基准成片没有时间轴证据（`totalMs`/`cues` 仅为占位），此时 subtitle/pacing 复检必须给 `unverifiable`，不得按 0 基准报 `changed`。
上限：`cues` 最多 50 条（窗口内仍超限 → 只存窗口 `cuesDigest`+`cuesCount` 并置 `cuesTruncated=true`）；`segments` 最多 200 段（同理 `segmentsTruncated=true`）。摘要为规范化排序后的 sha256，摘要比较仍可给 changed/unchanged，但不展开逐条证据；快照体积护栏不改变判定语义。

### 4.3 成片解析与时间定位（纯函数）

新文件 `apps/server/src/services/review/scope.ts`：

- `resolveReviewFinal(steps, assets, stepKey?)`：`stepKey` 缺省 `compose`，找 `stepKey` 相同且 `actionKey='ffmpeg_merge'` 的步骤；取该步 `output.asset_ids`（复用 `outputIdsOf`）中最新未删除、`kind='video'`、`purpose='final_video'` 且 `relPath` 非空者。无匹配步骤/产物被删 → 回退该 run 最新未删除且 `relPath` 非空的 `final_video`（降级，仍可审）。与 QC 的“最新成片”和返修的“合成步固定产物”各自独立，不改变两者行为。资产 `sha256` 由服务层 join `assets` 取得，不在纯函数里查库。
- `parseFinalTimeline(params)`：只读 `params.timeline`，输出 `{ totalMs, introMs, outroMs, segments: [{shotId, assetId, kind, startMs, endMs, durMs}], cues: [{id,startMs,endMs,text}] } | null`。`segments.startSec` 是内容轴（片头后 0 起算），绝对轴 = `introMs + startSec*1000`；`cues` 的 `coordinate='final'` 已是最终轴，不再位移。`totalMs = totalSec*1000 ?? introMs + ΣdurMs + outroMs`；`introMs/outroMs` 缺省 0。无 `totalSec` 且 `segments` 非数组或为空 → `null`（降级，不反推）。
- `locateAt(timeline, atMs)`：返回 `{ kind: 'intro'|'shot'|'outro'|'outside', shotId?, startMs?, endMs? }`。区间半开：`atMs < introMs` → `intro`；`introMs ≤ atMs < introMs+Σdur` 落在 `[startMs,endMs)` 的段（边界取后一段）；片头后到 `totalMs` 之间的空隙 → `outro`；`atMs ≥ totalMs` 或负值 → `outside`。
- `shotRange(timeline, shotId)`：返回该镜当前绝对区间；不存在 → `null`。
- `validateTimeRange(timeline, startMs, endMs)`：整数、`0 ≤ start < end`、`end ≤ totalMs`。timeline 缺失时以 `final.duration * 1000`（资产 `duration` 为**秒**，见合成落库）为上限；仍无则拒绝时间范围，只允许全片问题。

所有函数不查库、不读文件、不触执行；探针可直接用合成 JSON 直测。

### 4.4 范围与类别校验矩阵

创建时由服务端校验，前端只提交用户意图：

| 类别 | 允许范围 | 复检可比证据 |
|---|---|---|
| `visual` 画面 | `shot` / `time` / `global` | 范围内各段媒体 `assetId + sha256` 是否更换 |
| `prop` 道具连续 | `shot` / `time` / `global` | 范围内各段媒体身份是否更换 |
| `lip_sync` 口型 | `shot` | 该镜媒体身份是否更换（口型是否真修好仍需人看） |
| `subtitle` 字幕 | `shot` / `time` / `global` | 范围内 cue 文本/起止是否变化 |
| `audio` 音频 | `shot` / `time` / `global` | BGM/SFX 绑定、音量/淡入是否变化 |
| `pacing` 节奏 | `time` / `global` | 总长与范围内段长是否变化 |
| `other` 其他 | 任意 | 无自动证据 → `unverifiable` |

- `shot` 范围：客户端只交 `shot_id`；服务端从基准 timeline 反查 `start_ms/end_ms`，不信任客户端时间。
- `time` 范围：客户端交 `start_ms/end_ms`，服务端校验。
- `global`：`shot_id/start_ms/end_ms` 均为 null；复检覆盖该 stepKey 的整条成片。
- 无 timeline（旧成片）：`shot` 范围拒绝（`no_timeline` 409）；`time/global` 可创建，但复检多数 `unverifiable`。
- 类别/范围不匹配、note 为空或超 2000 字符、severity 枚举外 → 400。

### 4.5 状态机与动作

```
open ──link / mark-rework──▶ in_rework ──recheck──▶ pending_recheck ──verify(verified)──▶ verified
  │                              │                         │
  │                              ├──reopen────────────────▶ open
  │                              └────────dismiss──────────┴──▶ dismissed
  └──────────────recheck（外部已换片）──▶ pending_recheck
pending_recheck ──recheck（成片又变）──▶ pending_recheck
verified / dismissed / in_rework ──reopen──▶ open
pending_recheck ──verify(reopened)──▶ open
```

- **create**：要求 run 非 `queued/running/cancelled`（`waiting_input` 可审），且该 `step_key` 有当前成片；写 `open` + 快照。`step_key` 缺省 `compose`，创建时钉住。
- **link**：只接受同 run、同 `step_key`、`state='applied'` 的 `rework_request_id`；写 `in_rework`。允许 run 正在执行（返修刚触发重合成），否则 apply 后立即 link 会被误拒。类别与返修类型的语义匹配不做服务端强校验（台账无 kind 列，解析 `changes_json` 过于脆弱）；由前端只提供兼容入口。
- **mark-rework**：无 requestId 的手工修复留痕；写 `in_rework`，note 落 `rework_note`。
- **recheck**：要求 run 非 `queued/running/cancelled`；允许从 `open` / `in_rework` / `pending_recheck` 发起。当前成片按 finding 钉住的 `step_key` 解析：`open/in_rework` 须 `currentFinalId !== base_final_asset_id`；`pending_recheck` 须 `currentFinalId !== recheck_final_asset_id`；否则 409 `final_unchanged`。写 `pending_recheck` + 复检证据。
- **verify**：要求 `status='pending_recheck'`，且 `final_asset_id`、当前成片、`recheck_final_asset_id` 三者一致；当前成片已再变 → 409 `stale_recheck`（须重新复检），`final_asset_id` 不匹配 → 409 `stale_final`。`verified` 写 `resolved_at` + `resolution_note`；`reopened` 回 `open`，`resolution_note = note ?? null`，并保留复检证据。
- **dismiss**：`open/in_rework/pending_recheck` → `dismissed`，写 `resolved_at` + `resolution_note`。
- **reopen**：`verified/dismissed/in_rework` → `open`，清 `resolved_at`，`resolution_note = note ?? null`，保留 `recheck_*` 作为历史。
- **patch**：只允许改 `note/severity`，不改范围/类别/状态；任何状态可用。`cancelled` run 仅允许只读与 patch（不能推进审片流程）。

`needs_recheck`（服务端派生，不落库）：`status='in_rework'` 且 `currentFinalId !== base_final_asset_id`。
`stale_recheck`：`status='pending_recheck'` 且 `currentFinalId !== recheck_final_asset_id`。

### 4.6 复检算法（证据变化检测，永不自动判过）

新文件 `apps/server/src/services/review/recheck.ts`，纯函数 + 服务层装配。当前成片与 timeline 一律按 finding 钉住的 `step_key` 解析，不取“全 run 最新”：

- **shot 范围**：当前 timeline 按 `shot_id` 找段。找不到 → `unverifiable`（镜头已不在新成片）。比较 `assetId + sha256`（sha 缺一侧时只比 `assetId`，证据注明“sha 不可用”）：
  - 不同 → `changed`，证据“该镜媒体已更换：asset#456 → asset#789”；
  - 相同 → `unchanged`，证据“该镜媒体未更换”；
  - 基准快照无该镜 → `unverifiable`。
- **time 范围**：当前 timeline 取与 `[start_ms, end_ms]` 相交的段；逐段比较媒体身份；任一段变化 → `changed`；全部相同 → `unchanged`；当前总长不足或原窗口越界 → `unverifiable`（附“原时间窗超出当前成片”）。
- **subtitle**：shot 范围用当前该镜区间，time 范围用原窗口，global 用整条成片；取 `timeline.subtitle.cues` 与快照对应窗口 cues（或摘要）比较。文本/起止任一不同 → `changed`；完全一致 → `unchanged`；一侧有字幕、另一侧无 → `changed`（字幕增删）；两侧都无 → `unchanged`（无字幕可比）；快照截断 → 摘要级比较（不同 changed / 相同 unchanged）；当前 timeline 缺失或结构损坏 → `unverifiable`。
- **audio**：读当前 `params.timeline.bgm`（assetId/volume/fadeSec）与 `sfx[]`，BGM/SFX 的 sha 由服务层 join `assets`；不读 `run.input._compose` 覆盖意图。shot 范围只比该镜 SFX + BGM；time/global 比全部。任一项不同 → `changed`；全部相同 → `unchanged`；基准快照无 audio → `unverifiable`。
- **pacing**：比较当前 `totalMs` 与范围内各段 `durMs`；不同 → `changed`；相同 → `unchanged`；timeline 缺失 → `unverifiable`。
- **other**：恒 `unverifiable`。

**所有结果 `manual_required: true`**。`changed` 只说明“证据变了”，不等于“修好了”；`unchanged` 也不等于“没修好”（可能是主观改善或检测粒度不足）。面板文案必须照此显示，`verified` 只能由人点。

### 4.7 API 契约（新文件 `routes/review.ts`，注册到 `app.ts`）

所有端点 `h(...)` 包装、`idParam` 校验；领域错误用 `HttpError`（404/400/409），不静默。

`GET /runs/:id/findings?stepKey=compose`

```json
{
  "stepKey": "compose",
  "capability": {
    "readable": true,
    "writable": true,
    "has_timeline": true,
    "code": "ok|run_active|run_cancelled|no_final|degraded_no_timeline",
    "message": "…"
  },
  "final": { "assetId": 123, "durationMs": 45000, "createdAt": 1730000000000 },
  "timeline": {
    "totalMs": 45000, "introMs": 1000, "outroMs": 0,
    "segments": [{ "shotId": "S1", "assetId": 11, "kind": "video", "startMs": 1000, "endMs": 5000, "durMs": 4000 }]
  },
  "findings": [FindingView],
  "summary": { "total": 3, "open": 1, "in_rework": 1, "pending_recheck": 1, "verified": 0, "dismissed": 0, "blockers_open": 1 }
}
```

- `run` 不存在 → 404；其余一律 200（无成片时 `capability.code='no_final'`、`final=null`、`timeline=null`，仍返回历史问题单，避免“成片没了问题也看不见”）。
- `findings` 只返回 `step_key` 与查询参数一致的条目（缺省 `compose`），保证面板播放器、基准成片与问题单同源；多合成步的 run 需分步查看。
- `capability.writable` = 当前可创建新问题单（run 非 `queued/running/cancelled` 且有该步成片）；行级动作以 `FindingView.can` 为准。
- `capability.code` 优先级：`run_cancelled` > `run_active` > `no_final` > `degraded_no_timeline` > `ok`；`message` 按最高优先级给一条人话原因。
- `final.durationMs` 优先取 `timeline.totalSec*1000`，无 timeline 时取 `assets.duration*1000`（资产 `duration` 单位为秒），两者皆无 → null。
- `timeline` 只下发段摘要（不下发全部 cues，避免大响应）；段含 `assetId` 供前端缩略图/跳转。
- `summary.blockers_open` = `severity='blocker'` 且 `status` 不在 `verified/dismissed` 的条数。

`FindingView`：

```json
{
  "id": 1, "stepKey": "compose", "baseFinalAssetId": 123,
  "baseAvailable": true,
  "scopeKind": "shot", "shotId": "S3", "startMs": 12000, "endMs": 19000,
  "category": "prop", "severity": "major", "note": "…", "status": "in_rework",
  "reworkRequestId": "uuid|null", "reworkNote": "…|null",
  "createdAt": 0, "updatedAt": 0, "resolvedAt": null,
  "recheck": { "state": "changed", "finalAssetId": 124, "note": "…", "at": 0 } | null,
  "resolutionNote": "…|null",
  "needsRecheck": true, "staleRecheck": false,
  "currentLocation": { "startMs": 12500, "endMs": 19500, "inRange": true } | null,
  "can": { "link": false, "markRework": false, "recheck": true, "verify": false, "reopen": false, "dismiss": true }
}
```

`can` 由服务端按状态、run 状态与当前成片计算，前端不自行推断。`currentLocation`：shot 范围按当前同 `step_key` 时间轴重锚定；time 范围回显原绝对窗口并标 `inRange`；global 为 null。

写端点：

| 方法/路径 | Body | 语义 |
|---|---|---|
| `POST /runs/:id/findings` | `{ client_key?, step_key?, category, severity, note, scope }` | 创建；同 run 同 `client_key` 且 `step_key/category/severity/note/scope` 逐字一致 → 回放既有行（`replayed:true`），不一致 → 400 `client_key_conflict` |
| `PATCH /runs/:id/findings/:fid` | `{ note?, severity? }` | 只改描述/严重度 |
| `POST /runs/:id/findings/:fid/link` | `{ request_id }` | 关联 applied 返修，→ `in_rework` |
| `POST /runs/:id/findings/:fid/mark-rework` | `{ note? }` | 手工修复留痕，→ `in_rework` |
| `POST /runs/:id/findings/:fid/recheck` | `{}` | 对新成片做证据复检，→ `pending_recheck` |
| `POST /runs/:id/findings/:fid/verify` | `{ result: "verified"\|"reopened", final_asset_id, note? }` | 人工终判；校验成片未再变 |
| `POST /runs/:id/findings/:fid/dismiss` | `{ note? }` | 忽略/不修 |
| `POST /runs/:id/findings/:fid/reopen` | `{ note? }` | 重新打开 |

`scope` 三形：`{ kind:"shot", shot_id }` / `{ kind:"time", start_ms, end_ms }` / `{ kind:"global" }`。创建返回 `{ finding: FindingView, replayed: boolean }`；其余动作返回 `{ finding: FindingView }`。

错误面（`error.code` 机读）：`run_not_found` / `finding_not_found` 404；`bad_scope` / `scope_category_mismatch` / `note_required` / `bad_severity` / `bad_result` / `client_key_conflict` 400；`run_active` / `run_cancelled` / `no_final` / `no_timeline` / `request_not_found` / `request_not_applied` / `request_run_mismatch` / `final_unchanged` / `stale_final` / `stale_recheck` / `bad_transition` 409。失败请求零写库。`bad_result` 为 verify 的 `result` 非 `verified`/`reopened` 时的 400（实现期新增的唯一机读码）。

### 4.8 前端

新增：

- `apps/web/src/lib/types/findings.ts`：与后端逐字段对齐的视图类型。
- `apps/web/src/lib/api/findings.ts`：`list/create/patch/link/markRework/recheck/verify/dismiss/reopen`。
- `apps/web/src/components/run/findings/RunFindingsPanel.vue`：右栏面板（标题、计数、播放器、镜头条、表单、问题列表）；挂在 `RunQcPanel` 之后（`run-detail/index.vue` L235–239）。
- `apps/web/src/components/run/findings/use-run-findings.ts`：加载/刷新/当前时间/当前镜头/动作状态。
- 必要时拆 `FindingForm.vue` / `FindingRow.vue`，保证单文件 ≤800 行。

交互：

1. **播放器**：`<video controls preload="metadata">` 指向当前成片 `/api/v1/assets/:id/file`（Range 已支持）。`timeupdate` 更新当前毫秒；显示 `mm:ss.S` 与当前镜头。
2. **镜头条**：`timeline.segments` 横向 chip（缩略图 `/assets/:assetId/thumb`、镜号、起止）；点击 seek 并把创建范围预选为该镜。片头/片尾也可点击但不预选镜头。
3. **记录问题**：类别、严重度、范围（当前镜头 / 自定义时间窗 / 全片）、备注。时间窗默认「当前时间起 2 秒」，起止可改；范围选项按 4.4 矩阵动态禁用；提交后服务端返回权威位置。
4. **问题列表**：按“待处理（open/in_rework）→ 待复检 → 已解决/忽略”排序，同级按严重度、创建时间；显示类别/严重度/时间/镜号/备注/状态。每行按 `can` 显示动作：
   - `subtitle`：`字幕返修` → 内嵌 `SubtitleReworkModal`；`applied(requestId)` → `link` → 刷新。
   - `audio/pacing`：`合成返修` → 内嵌 `ComposeInputReworkModal`；同样 link。
   - `visual/prop/lip_sync`：`shot` 范围显示`定位镜头` → 滚动到镜头工作台对应卡；`time/global` 范围显示`跳转时间` → seek 播放器。重出仍走既有付费确认。
   - 所有类别：`标记已返修`（手工留痕）、`忽略`。
5. **待复检**：`needsRecheck` 时显示“新成片已生成，待复检”；点“复检”显示证据（该镜是否换、字幕是否变、音频绑定是否变、总长是否变）+ **“确认已修复 / 仍未修复”** 两个人工按钮；`staleRecheck` 时提示“成片又变了，请重新复检”。
6. **返修前/后对照**：每条问题保留 `baseFinalAssetId`；播放器提供“返修前 / 当前”切换，切到基准成片并 seek 到问题时间。基准资产行不存在时隐藏切换。
7. **能力态**：`capability.writable=false` 时禁用创建/复检/verify，显示后端 `message`；`no_final` 且无历史问题单时面板整体隐藏（与 QC 一致），有历史时播放器区显示“当前无成片”并保持只读。
8. **联动落点**：`ShotCard` 根节点加 `:data-shot-id` / `:data-step-key` 与 `id="shot-<shotId>"`；面板 `scrollIntoView` 定位并短暂高亮。锚点不存在（镜头已删/该步不在当前 run）时提示“请在镜头工作台手动定位”，不静默失败。该改动纯属性，不改镜头工作台行为。
9. **刷新**：创建/关联/复检/终判/重开后刷新列表与播放器；父级 `run-detail` 重新加载（重新合成完成）时同步刷新。不做轮询定时器。

复用：`SubtitleReworkModal`、`ComposeInputReworkModal`、既有 `Icon`、`.panel`、`.btn`、badge 样式；不新造设计系统。

### 4.9 删除与清理

- `services/run-delete.ts`：`purgeRunRecords` 事务内先删 `review_findings`（按 run_id），返回值增加 `findings` 计数；调用方 `runs.ts/batches.ts` 已透传对象，无需改响应结构。
- `routes/projects.ts` 彻底删除：事务内按依赖序增加 `reviewFindings`（project_id）删除，返回计数。
- 归档（非 purge）不删问题单；项目恢复后仍可读。
- 断点续跑/派生新 run 不复制问题单（问题单绑定原 run 的基准成片）；旧 run 保留问题单，新 run 重新审片。

### 4.10 红线与北极星三问

- **1 新表，0 新列 on 既有表，0 新依赖，0 新付费面，0 模型调用**；模板 YAML 零改动；不触 QC 10 键与批准链。
- 复检纯函数可独立探测；API 零写失败（校验失败不落库）。
- 单文件 ≤800 行；新前端面板拆 composable/子组件。
- 服务创作闭环？是——补“审片→返修→复检”的质量闭环。可模板化？问题单为运行级横切能力，模板零感知。通用资产能承载？问题单落独立表，不造新内容载体。

## 五、验证（probe-m69，isolatedEnv，零付费零模型）

新文件 `apps/server/scripts/probe-m69.ts`，三节：

1. **`scope`（纯函数）**：
   - timeline 含 `introSec=1`、S1 2s、S2 3s → `locateAt` 在 0.5s=intro、1.0s=S1、3.0s=S2、5.999s=S2、6.0s=outside、负值=outside；
   - `shotRange` 与 `validateTimeRange` 边界（含 `totalSec` 缺失时按 `intro+Σdur+outro` 推导）；
   - 快照：scope 窗口内 cues/段、媒体 id/sha、BGM/SFX（来自 timeline）、总长/段长；超限走窗口摘要；
   - diff：镜头换/未换、sha 缺一侧、cue 改/未改、BGM/SFX 改/未改、总长改/未改、缺 timeline → unverifiable。
2. **`service`（隔离 DB）**：
   - 创建校验矩阵：visual+time 合法、lip_sync+global 拒绝、未知 shot、越界时间、空 note、非法 severity；
   - `step_key` 钉住：两个合成步各有成片时，复检只对 finding 钉住的那一步；
   - 状态迁移：open→link(applied)→in_rework；link 到 ready 拒绝；跨 run/跨 stepKey request 拒绝；同成片 recheck 拒绝；新成片 recheck→pending；verify 错成片拒绝；verify 时成片再变 → `stale_recheck`；verify verified；reopen（含 in_rework/verified/dismissed）；dismiss；非法迁移拒绝；
   - `needsRecheck` / `staleRecheck` / `can` 投影（含 cancelled/run_active）；
   - `client_key` 幂等回放 + 同 key 异载荷 409；
   - `rework_note` / `resolution_note` 写入与覆盖语义；
   - `purgeRunRecords` 删除问题单。
3. **`route`（`app.request` 端到端）**：
   - 合成夹具：项目 + run + 合成步 + 成片资产（timeline 参数）→ 创建/列表/链接/复检/终判全链；
   - 404/400/409 错误面；失败请求零写库；
   - 列表计数与 `capability` 降级（无成片/无 timeline/running）。

无需真实媒体文件：服务只读资产行与 `params.timeline`；播放器文件流由既有端点覆盖，探针不伪装成片质量结论。

回归：`pnpm ci:check` 全量 + 双端 `tsc`/`vue-tsc` + 文件行数审计；既有 QC/返修/运行删除探针零回归。

## 六、退出标准

1. 能在成片任意时间创建问题，服务端按 `step_key` 钉住合成步并正确落到镜头/时间；越界、类别范围错误、`client_key` 异载荷被拒。
2. 列表可点选跳转播放器、显示镜头条、区分状态与严重度；无成片/无 timeline/运行中/已取消均有诚实降级。
3. 字幕/合成返修 apply 后可关联 requestId（同 run 同 stepKey）；视觉问题可定位到镜头工作台；终判/忽略落 `resolution_note`。
4. 新成片生成后出现待复检；复检给出 changed/unchanged/unverifiable 证据，verify 必须匹配当前成片与复检成片，**不自动判过**。
5. 返修前/后可在同一时间点对照；基准资产不存在时诚实隐藏。
6. probe-m69 全绿、全量 `ci:check` 零回归、0 新付费/0 模型、模板零改动、单文件 ≤800。

## 七、遗留与边界（诚实标注）

- **不做自动视觉/口型/听感判定**：`visual/prop/lip_sync/audio` 的“已修复”必须人工确认；复检只证明证据变化。
- **问题单不阻断导出/批准**：与 QC 面板同为只读辅助；交付门禁仍走既有批准链。
- **时间范围问题可能位移**：`shot` 范围随新时间轴重锚定，推荐默认；`time` 范围是绝对毫秒，前后镜头时长变化会漂移，复检会标 `unverifiable` 而不是猜。
- **无 timeline 的旧成片降级**：只能建全片/时间问题，镜头定位与多数复检不可用。
- **快照上限**：窗口内 cue >50 或段 >200 时只存摘要，复检可给摘要级 changed/unchanged，但不展开逐条证据。
- **多合成步**：问题单按 `step_key` 隔离；首版前端默认 `compose`，一个面板只显示一个合成步。其他步骤键需手工传参，暂不做同页多面板。
- **单资产删除**：只删成片资产（非 run/项目彻底删除）时问题单保留，播放器与基准对照诚实降级；彻底删除 run/项目才清问题单。
- **sha 不可用**：旧资产无 `sha256` 时媒体身份只比 `assetId`，证据注明“sha 不可用”，不据此伪造 changed。
- **不跨 run 继承**：续跑/派生新 run 不复制问题单；问题单绑定原 run 的基准成片与 stepKey。
- **不做问题聚合/看板/导出**：项目级统计、CSV 导出、与发布 A/B 关联留后续。
- **删除即清**：run 删除/项目彻底删除会清问题单；归档不删。
- **前端文件流依赖成片文件存在**：资产行在但文件缺失时播放器报错，问题单仍可读；不复制成片副本。
- **M68 不在本项范围**：数字人口播仍挂起。
