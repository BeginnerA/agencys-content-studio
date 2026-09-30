# M11 设计：合成与声音（引擎级单步重跑 + 镜头级音字对齐 + BGM·转场）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

> 里程碑：M11（2026-09-12 立项）｜上游：M7 合成（ffmpeg_merge 静态图路径）· M10 分镜编辑器 ｜下游：M12 组1 收尾（旧版本清理与收藏 / 图像检测）
> 性质：M7 spec §1.3 排除项三连的接力落地——「引擎级单步重跑接口（不新增引擎方法；统一走重置+startRun，引擎零改动）」「合成字幕/音轨的镜头级重对齐（SRT 与配音轨成对产出）」；P2 小缺口「BGM/音效、转场特效」的对应批次。组1 第 4~5、8 项合并为一个「合成与声音」批。
> 对标（2026-09-12 源码核实）：
> - **huobao**：`ffmpeg-merge.ts` 为纯 concat 列表拼接（`-f concat -safe 0` + libx264/aac，无 BGM 混音、无转场）；`bgm_prompt` / `sound_effect` 仅为 storyboard 表文本字段，不落实现。
> - **Toonflow**：`transition` 命中均为叙事技法文档/前端技能 JS，无代码级转场/BGM 实现。
> - **本仓落法**：三能力均为自有增量——单步重跑沿用「重置 + startRun」模式（引擎零改动，与 regenerate/recompose 同构）；音字对齐以「分镜 JSON `shots[].lines` 唯一事实源 + 合成期静音注入 + SRT 平移」实现（subtitle 资产零改动）；BGM 走 run 级直查（任意快照版本 run 可用）、转场走 xfade 链 + 时长补偿数学。

---

## 1. 定位与边界

### 1.1 一句话目标

补齐「重跑—对齐—成片」链路：任意步骤可单步重跑（batch 步骤可选「复用成功子任务 / 全部重跑」）；静态图合成时画面切换与台词时间轴严格对齐（分镜声明每镜配哪些台词）；成片可混 BGM 与镜头间转场（run 级配置，重新合成生效，存量 run 亦可用）。

### 1.2 范围（三项能力）

1. **引擎级单步重跑**：run ∈ {completed, failed} 时任意 succeeded/failed 步骤可重置重跑；batch 型步骤可选「复用成功子任务」（默认，零额外调用）或「全部重跑」（reset_tasks=true）；无任务型步骤（ai_text 单跑 / tts / ffmpeg_merge）整体重新执行；下游步骤不重置。
2. **镜头级音字对齐**：分镜 JSON `shots[].lines`（台词 id 数组）声明每镜配哪些台词；静态图合成按「带台词镜 = 句时长和（显式时长 > 句和时补镜尾静音）／无台词镜 = explicit ?? duration_per_shot（全镜静音）」计算每镜时长并注入静音段；SRT 烧录前按镜平移（音字轴保持一致）；映射一致性校验失败回退 M7 行为。
3. **BGM / 转场**：BGM = run 级绑定音频资产（上传 / 项目音频复用），合成时循环铺满 + 音量 + 淡入出 + amix；转场 = xfade 链（fade/fadeblack/slideleft/slideright/dissolve），时长补偿数学保证音画总长不变；参数经 `run.input._compose` 覆盖（存量 run 直接可用）。

### 1.3 排除（本里程碑不做，保持 backlog）

- **音效（per-shot）**：依赖「每镜音频资产绑定/上传通道」（素材上传通道批次）；BGM 独立闭环先行，音效留后续。
- **单句配音重配**：tts 无 gen_tasks（重跑 = 全量重新配音计费）；增量重配留 backlog。
- **motion 路径的对齐与转场**：motion 片段实际时长拼接、转场会吞片段内容——维持 M7「motion 路径音画对齐目检」决策；BGM 不受此限（音频层混音与视频模式无关）。
- **时间轴级波形编辑 / 多轨混音台**（audacity 类）；BGM 单轨单文件。
- **BGM 变化联动 stale**：换绑 BGM 后由 UI 提示「需重新合成」，不纳入 computeStale 比对（stale 语义维持「上游资产变化」）。
- **「重跑此步及全部下游」链式编排**：可用多次单步重跑或断点续跑（resume）达成。

---

## 2. 语义与契约

### 2.1 单步重跑语义（复用 M7 决策表的服务化）

- **可重跑判定**（沿用 `assertRepairable`，不限制 action）：run ∈ {completed, failed}（活跃 400 / cancelled 400）；step ∈ {succeeded, failed}（skipped/pending/running 400）；除目标外无 failed。
- **重置三连**（对齐 resetShotForRegenerate / resetStepForRecompose 手法）：目标 step → pending（error/completedAt 清空，output 保留至执行时重写）→ run → queued（error/completedAt/currentStepKey 清空）→ 路由层 `engine.startRun`（succeeded 步骤全跳过，仅执行 pending 的目标步）。
- **reset_tasks 二选一**：
  - `false`（默认，复用模式）：不动 gen_tasks——action 既有幂等段「succeeded 任务跳过、failed 归零重跑」自动生效；适用于「单镜失败修复后补跑」「确认无需重生成」场景（零额外调用）。
  - `true`（全量模式）：该步全部 gen_tasks → pending（attempts=0 / errorMsg / completedAt 清空；resultAssetId 保留作历史版本）→ 全部重新执行（图像/视频/文本批 = 计费，UI 需明确计数与确认）。
  - 无任务型步骤：选项忽略（`has_tasks=false`），note 说明「该步骤无子任务，将整体重新执行」。
- **下游不重置**（单步语义）：目标步重跑后下游保持 succeeded 产物不变；note 提示「如需下游生效：重跑对应下游步骤或重新合成」。
- **防重**：重置后 run=queued → 再次调用即被 run_active 拦截（天然幂等保护）。

### 2.2 rerun 端点契约

```
POST /runs/:id/steps/:stepKey/rerun        （挂 routes/runs.ts）
body: { reset_tasks?: boolean }            // 默认 false
200: {
  ok, run_id, step_key,
  has_tasks, tasks_total, tasks_succeeded,
  note   // 复用模式："已重置「X」并重新入队；成功子任务将复用（N 个），预计执行 M 个"（has_tasks=false → "该步骤无子任务，将整体重新执行"）
}
```

错误映射沿用 `wb()` 包裹（WorkbenchError → HttpError）；`wb()` 从 routes/shots.ts 提取至 routes/helpers.ts 共用（shots.ts 改 import，行为零变化）。

### 2.3 音字对齐语义

**映射来源**：分镜 JSON `shots[].lines: string[]`（台词 id 数组，storyboard-ep 提示词 v+1 产出；空数组 = 无台词镜；字段缺失 = 老分镜）。

**启用条件**（全部满足才对齐，否则回退 M7 行为并在日志写明原因）：

| # | 条件 | 失败 reason |
|---|---|---|
| a | 静态图模式（images 非空，motion_clips 空） | `motion_mode` |
| b | voices 非空且每句资产可解析 `params.lineId` | `no_voices` / `no_lineid` |
| c | 至少一镜含 lines 字段（`Array.isArray`） | `no_lines_field` |
| d | 每句台词恰好归属一镜（并集 == voices 集合，无孤儿、无幽灵、无重复） | `mapping_mismatch` |

**时长决策表**（对齐模式；explicit = 分镜 duration 双口径读取，缺省 null）：

| 镜型 | 视频时长 d | 静音段 |
|---|---|---|
| 带台词镜 | `Σ voiceDur(lineIds)`；若 explicit > Σ → `d = explicit`；若 explicit ≤ Σ（或 null）→ `d = Σ`（explicit < Σ 时 warn） | `explicit > Σ` → 差额（置镜尾）；否则 0 |
| 无台词镜 | `explicit ?? duration_per_shot`（≤0/非法按 duration_per_shot） | 全额 d |

- **音频轨**（对齐模式）：按镜序逐项 [该镜句语音（镜内 lines 序）… + 静音段（若有）] → concat → 总长严格 = Σd（视频总长），保留末段短 apad 兜底浮点；静音段用 `anullsrc=r=44100:cl=stereo:d={sec}`。
- **SRT 平移**：subtitle 资产（measured）时间轴为「语音连续轴」不变；合成期按句平移副本——句 l 属镜 k 时 `Δ_l = V_k − S_k`（`V_k = Σ_{j<k} d_j` 镜 k 视觉起点；`S_k = Σ_{j<k} ΣvoiceDur(镜 j)` 镜 k 语音起点）；静音全在镜尾/空镜，故镜内偏移不变。
  - 平移前置：cue 数 == voices 数（measured 防错位已保证）；不满足 → 不平移 + warn（SRT 原样烧录）。
  - cue ↔ 句序 = voices 数组序（subtitle measured 以 voices 序产出）；`Δ` 按 lineId 映射取。
  - 平移后写临时 SRT（与输出视频同目录 `.aligned-{runId}-{ts}.srt`，subtitles 滤镜 cwd 相对路径口径）→ 执行完 try/finally 删除。
  - 无静音场景（全镜 Δ=0）→ 不写临时文件，直接用原 SRT。
- **总时长与音频**：Σd 为全片时长（音频轨同长）；`fit_voice` 参数在对齐模式下忽略（对齐算法替代均分），非对齐模式保持 M7 行为（守护回归）。
- **存量兼容**：v8 分镜无 lines → 回退；用户经工作台 mutate 打上 lines 后重合成即生效（与模板快照无关）。

### 2.4 BGM 语义（run 级直查，不经 refs）

- **事实源**：assets 表 `{projectId, runId, kind='audio', purpose='bgm', deletedAt=null}`（复制行/上传入库，至多 1 条有效行——绑定即软删旧行）。
- **合成读取**：ffmpeg-merge 内 `loadBgmAsset(runId)` 直查（`updatedAt desc` 取最新），任意快照版本的 run 可用；产物 params.bgm 记录 `{asset_id, volume}` 供审计。
- **混音链**（仅 plan.bgm.enabled 时注入）：
  - 输入：`-stream_loop -1 -i {bgm}`（无限循环）；
  - filter：`[N:a]atrim=0:{total},asetpts=PTS-STARTPTS,volume={v},afade=t=in:st=0:d={f},afade=t=out:st={total−f}:d={f}[bgm]`；
  - 合流：voices 存在 → `[outa][bgm]amix=inputs=2:duration=first:normalize=0[aout]`（以主音轨定长）；voices 不存在 → bgm 直接为 [aout]。
  - 参数：`bgm_volume` 默认 0.25（clamp [0,1]）；`bgm_fade` 默认 2（clamp [0, min(2, total/2)]）；覆盖优先级 `_compose.bgm_volume/bgm_fade` ?? 模板 params ?? 默认。
- **降级**：文件缺失（relPath 空/不存在）→ 跳过 + warn；无 BGM 绑定 → 行为与 M7 完全一致（分支不注入）。

### 2.5 转场语义

- **参数**：`transition` ∈ {none, fade, fadeblack, slideleft, slideright, dissolve}（默认 none；非法值 → none + warn）；`transition_duration` 默认 0.5（clamp [0.1, min(2, min(d_j))]）。
- **来源优先级**：`run.input._compose.transition` ?? 模板 params.transition ?? 'none'（duration 同）。
- **生效条件**：静态图模式 + 镜头数 ≥ 2；否则忽略（日志）。
- **时长补偿数学**（保证音画总长不变，与对齐/字幕轴严格兼容）：
  - 基础时长 d_j 为对齐/均分/显式计算后的结果；
  - 视频段长度：前 n−1 镜 `d_j + T`，末镜 `d_n`（末镜不补偿）；
  - xfade 链 offset：`o_k = V_k = Σ_{j≤k} d_j`（k=1..n−1）；
  - 总长 = `o_{n−1} + len_n = Σd`（= 音频总长 = 字幕轴总长）✓；
  - 每镜「纯视觉窗口」[V_{k−1}, V_k] 恰为其 d_k 秒，转场窗口 [V_k, V_k+T] 位于边界后侧。
- **filter 形态**（启用时替换 concat 位置；未启用时 filter 与 M7 逐字节一致）：
  - 归一化链末尾追加 `settb=AVTB`（仅转场启用时，保证 xfade 时间基一致）；
  - `[v1][v2]xfade=transition=X:duration=T:offset=o1[x1]; [x1][v3]xfade=...:offset=o2[x2]; …; [x_{n−1}]` → 输出改名 `[basev]` → 后续 subtitles 链不变。
- **组合性**：对齐启用时先算 d_j（含镜尾静音），再套补偿；SRT 平移基于 V_k（不受补偿影响）✓。

### 2.6 合成配置覆盖（`run.input._compose`）

- **存储**：run.input JSON 内下划线内部键（与 `_review` 同类先例，模板不可能引用）：
  ```ts
  interface ComposeConfig {
    transition?: 'none'|'fade'|'fadeblack'|'slideleft'|'slideright'|'dissolve'
    transition_duration?: number   // clamp [0.1, 2]
    bgm_volume?: number            // clamp [0, 1]
    bgm_fade?: number              // clamp [0, 2]
  }
  ```
- **端点**：`GET /runs/:id/compose/config`（回显，含 run.input 现状）｜`PUT /runs/:id/compose/config`（白名单字段校验：未知键 400；transition 非法值 400；数值 clamp 后写入）。run 状态校验：completed/failed（活跃 400 / cancelled 400）；不要求步骤状态。
- **影响面核查**：`_compose` 不被模板引用（`input.<key>` 引用需显式声明，`interpolate` 不涉及）、不影响 when 求值；写回仅合并该键。

### 2.7 降级总表

| 场景 | 语义 |
|---|---|
| rerun：活跃 run / cancelled | 400 run_active / run_cancelled（assertRepairable 既有语义） |
| rerun：目标为 skipped/pending/running | 400 bad_step_status |
| rerun：存在其他 failed 步骤 | 400 other_failed（失败收敛先于执行） |
| rerun：reset_tasks=true 且无任务 | 忽略选项 + note「无子任务，整体重跑」 |
| 对齐：四条件任一不满足 | 回退 M7（warn 日志记录 reason） |
| 对齐：explicit < Σvoice | 以 Σvoice 为准 + warn |
| 对齐：cue 数 ≠ voices 数 | SRT 不平移 + warn（原样烧录） |
| 对齐 × motion 模式 | 不启用 |
| BGM：未绑定 | 分支不注入（与 M7 行为一致） |
| BGM：资产文件缺失 | 跳过 + warn |
| BGM：volume/fade 越界 | clamp |
| 转场：none / 非法值 / 单镜 / motion 模式 | 不启用（非法值 warn） |
| 转场：T > min(d_j) | clamp T |
| 存量 v8 run | 无 lines / 无 _compose → 全部回退 M7 行为（续跑/重合成语义不变） |

---

## 3. 服务端设计

### 3.1 `services/shot-workbench.ts`：+单步重跑

```ts
/** 单步重跑：assertRepairable（不限 action）→ 可选任务归零 → step pending / run queued；路由层随后 engine.startRun */
export async function resetStepForRerun(
  runId: number, stepKey: string, opts: { resetTasks?: boolean },
): Promise<{ runId: number; stepKey: string; hasTasks: boolean;
             tasksTotal: number; tasksSucceeded: number; tasksReset: number }>
```

- `resetTasks=true` → 该步全部 gen_tasks 置 `{status:'pending', attempts:0, errorMsg:null, completedAt:null}`（resultAssetId 保留）；`tasksReset = tasksTotal`。
- `resetTasks=false` → 不动任务；`tasksReset = tasksTotal − tasksSucceeded`（预计执行数）。

### 3.2 `services/compose-config.ts`（新）：run 级合成设置

```ts
export interface ComposeConfig { /* §2.6 四键 */ }
export async function getComposeConfig(runId): Promise<{ config: ComposeConfig; bgm: Asset | null }>
export async function updateComposeConfig(runId, patch: ComposeConfig): Promise<ComposeConfig>  // 白名单 + 校验 + 合并写 run.input._compose
export async function loadBgmAsset(runId): Promise<Asset | null>          // updatedAt desc 取最新有效行（ffmpeg-merge 消费）
export async function bindBgmFromUpload(runId, file): Promise<Asset>      // 落盘 purpose=bgm + 行 {runId, stepId:null, params:{source:'upload', original_name}}；先软删旧行
export async function bindBgmFromAsset(runId, assetId): Promise<Asset>    // 项目内 audio 复制行（relPath 复用；M10 importShotAsset 手法）
export async function removeBgm(runId): Promise<void>                     // 软删该 run bgm 行
```

- run 状态校验：completed/failed（活跃 400 / cancelled 400 / 其余 400）；复制行来源需 kind=audio + 同项目 + 未删。
- 上传大小上限 200MB（路由层校验，沿用 shots/upload 口径）；kindByExt 支持 mp3/wav/aac/m4a/flac。

### 3.3 `routes/compose.ts`（新，5 端点）+ `routes/runs.ts`（+1）

```
GET    /runs/:id/compose/config   → { config }                        // config 为空对象时前端用模板/默认值回显
PUT    /runs/:id/compose/config   → { ok, config }
GET    /runs/:id/compose/bgm      → { bgm: AssetView | null }
POST   /runs/:id/compose/bgm      → JSON { asset_id } 或 multipart file → { ok, bgm: AssetView }
DELETE /runs/:id/compose/bgm      → { ok }
POST   /runs/:id/steps/:stepKey/rerun → §2.2（挂 routes/runs.ts，import resetStepForRerun）
```

- `wb()` 提取至 `routes/helpers.ts`；shots.ts / compose.ts / runs.ts 共用（shots.ts 行为零变化）。

### 3.4 `pipeline/actions/ffmpeg-merge.ts`：对齐 / BGM / 转场

**新增纯函数（导出，probe 直测）**：

```ts
export interface AlignShotInput { id: string; durationSec: number | null; lineIds: string[] }
export interface AlignLine { lineId: string; speechStart: number; timelineStart: number }
export interface AlignPlan {
  aligned: boolean; reason?: string
  segments: Array<{ shotId: string; durSec: number; lineIds: string[]; silenceSec: number }>
  lines: AlignLine[]          // 按「镜序 × 镜内序」
  totalDur: number
}
export function planVoiceAlignedSegments(
  shots: AlignShotInput[], voiceDur: Map<string, number>, fallbackDur: number,
): AlignPlan                                     // §2.3 条件与决策表

export function planSrtShifts(align: AlignPlan, lineIdsInCueOrder: string[]): number[] | null
                                                 // 每 cue 平移秒数；映射缺失/数量不符 → null
export function shiftSrtText(srt: string, shifts: number[]): string   // 逐 cue 平移（不解析语义、保格式）

export interface TransitionPlan {
  enabled: boolean; type: string; durSec: number
  videoLens: number[]        // n 项（前 n−1 镜 +T，末镜 d）
  offsets: number[]          // n−1 项（= V_k）
  totalDur: number           // Σd
}
export function buildTransitionPlan(
  durations: number[], transition: string, durationSec: number,
): TransitionPlan                                // §2.5 数学与校验
```

**执行流改造（主路径，探针不可达部分由实弹覆盖）**：
1. 读取：+`loadBgmAsset(run.id)`、`runInput._compose`；params 兜底（transition none / duration 0.5 / volume 0.25 / fade 2）。
2. 时长计划：M7 `computeShotSegments` 不变（回归守护）；对齐条件满足时用 `AlignPlan.segments` 覆盖每镜时长与静音（`computeShotSegments` 输出仍参与 explicit/均分语义，对齐层仅在有 mapping 时接管）。
3. 视频 filter：转场启用 → 归一化链 +`settb=AVTB` → xfade 链（替换 concat）；否则原 concat（零变化）。
4. 音频 filter：对齐模式 → 按镜序 voice/静音段 concat（末段短 apad）；否则原 voices concat + apad（零变化）。
5. SRT：对齐时 `planSrtShifts` + `shiftSrtText` → 写临时文件（有平移时）→ subtitles 滤镜引用 → finally 清理。
6. BGM：enabled 时追加输入 + 混音链（§2.4）。
7. 产物 params 增记：`align: {aligned, reason?}`、`transition: {enabled,type,durSec}`、`bgm: {asset_id,volume}|null`（inputs 快照维持 M7 三键，不动 computeStale 语义）。

### 3.5 模板与提示词（v8 → v9）

- `workspace/templates/mengbao-episode.yaml` → v9：
  - `make_storyboard`：`after: [write_script, char_profile, set_profile]` → `+ cast_lines`；`inputs + lines: steps.cast_lines.asset`（cast_lines `when: input.with_voice != false` 跳过时 `loadStepOutputs` 给 []，ai-text 空输入容忍——已核实安全；级联跳过仅「全部依赖 skipped」触发，本步三必跑依赖在场）。
  - `compose_video`：`params + transition: none / transition_duration: 0.5 / bgm_volume: 0.25 / bgm_fade: 2`（代码层同值兜底，存量快照零影响）。
- `workspace/prompts/storyboard-ep.md` v+1：shots[] 增加 `lines` 字段规范——「该镜画面配的台词句 id 数组（取自输入台词表）；无台词镜为空数组；每句恰好归属一镜；不得引用不存在的 id」。
- 存量探针基线同步：probe-m3 的模板断言（步骤数/结构）随 v9 更新。

---

## 4. Web 设计

### 4.1 `RunDetailView.vue` + `RerunModal.vue`（新）

- 步骤卡「重跑」按钮：显示条件 = run.status ∈ {completed, failed} 且 step.status ∈ {succeeded, failed} 且除目标外无 failed（前端从已加载的 run `steps` 计算）；进行中（queued/running）隐藏。
- RerunModal：目标步骤摘要 → 二选一 radio「复用成功子任务（默认）」/「全部重跑」→（batch 步骤）显示计数「N 个成功将复用 / M 个将执行」，全量模式红字警示成本 → 确认 → `stepApi.rerun` → 关闭 + 刷新 + notice；无任务型步骤仅显示警示（单选禁用）。

### 4.2 `ShotBoard.vue` 扩展

- compose 区域：+「转场」select（无/淡入淡出/黑场渐变/左滑/右滑/溶解）+ 时长 number（0.1–2，step 0.1）→ `composeApi.updateConfig`；打开时 `getConfig` 回显（空 config 用默认值）。
- +「配乐」按钮 → BgmModal。
- 镜头卡：台词角标（`raw.lines` 数组长度 > 0 → 「台词 n 句」小徽标）。

### 4.3 `BgmModal.vue`（新）

- 当前 BGM：名称 + 试听（asset file URL）+ 「移除」。
- 候选列表：`GET /projects/:id/assets?kind=audio`（缩略行 + 点击绑定）。
- 上传：multipart 上传新文件 → 绑定。
- 音量滑条（0–100%，写 `_compose.bgm_volume`）。
- 保存后提示「重新合成后生效」（不自动触发）。

### 4.4 `StoryboardEditor.vue` 扩展

- lines 专用控件：标签输入（逗号/回车添加、点击删除）+ datalist 建议（解析 cast_lines 资产 JSON 的 id 列表；获取失败静默降级为纯标签输入）；保存进 `patch.fields.lines`。
- 服务端 `patch` 字段校验扩展：`lines` 需为 string[]（元素非空）；`validateShotFields` 加分支。

### 4.5 `lib/api.ts` / `lib/types.ts`

```ts
stepApi.rerun(runId, stepKey, opts: { reset_tasks?: boolean })
composeApi.getConfig(runId) / updateConfig(runId, patch) / getBgm(runId) / bindBgm(runId, assetId)
composeApi.uploadBgm(runId, file) / removeBgm(runId)
// types：ComposeConfig / RerunResult / BgmAssetView
```

---

## 5. 改动清单（文件级）

### 5.1 服务端（apps/server）

| 文件 | 改动 |
|---|---|
| `src/services/shot-workbench.ts` | +`resetStepForRerun`；`validateShotFields` +lines 分支 |
| `src/services/compose-config.ts` | **新增**（§3.2 六函数） |
| `src/routes/compose.ts` | **新增**（§3.3 五端点） |
| `src/routes/runs.ts` | +rerun 端点（import resetStepForRerun） |
| `src/routes/helpers.ts` | +`wb()`（shots.ts 改 import 共用） |
| `src/routes/shots.ts` | wb 改 import（行为零变化） |
| `src/pipeline/actions/ffmpeg-merge.ts` | 对齐/BGM/转场 + 四纯函数（§3.4） |
| `scripts/probe-m11.ts` | **新增**：六节探针 |
| `package.json` | +`probe:m11` |

### 5.2 共享（workspace）

| 文件 | 改动 |
|---|---|
| `templates/mengbao-episode.yaml` | v9（make_storyboard lines 输入 + compose 四个 params） |
| `prompts/storyboard-ep.md` | v+1（shots[].lines 规范） |

### 5.3 Web（apps/web）

| 文件 | 改动 |
|---|---|
| `src/views/RunDetailView.vue` | 步骤卡「重跑」按钮 + 弹窗接线 |
| `src/components/RerunModal.vue` | **新增** |
| `src/components/ShotBoard.vue` | 转场控件 + 配乐入口 + 台词角标 |
| `src/components/BgmModal.vue` | **新增** |
| `src/components/StoryboardEditor.vue` | lines 标签控件 |
| `src/lib/api.ts` / `src/lib/types.ts` | §4.5 |

### 5.4 不改动清单（红线）

`pipeline/engine.ts`（调度/断点续跑/失败收敛零改动）、`pipeline/refs.ts`（零改动——BGM 不走 refs 通道）、`pipeline/actions/tts.ts`、`pipeline/actions/subtitle.ts`（SRT 平移在合成期做，资产时间轴不变）、`pipeline/actions/ai-text.ts`、`computeShotSegments` / `parseShotDurations`（行为零改动，probe-m7 守护）、`db/schema.ts`（零迁移：BGM 复用 assets 行、_compose 复用 run.input 列）、M7/M10 既有端点语义（edit/mutate/select/regenerate/upload/recompose 不变）、`services/storage.ts`、其余模板与提示词。

---

## 6. 验收

### 6.1 静态

- `apps/server`：`npx tsc --noEmit` 零错误；`apps/web`：`npx vue-tsc --noEmit` 零错误。

### 6.2 探针 `scripts/probe-m11.ts`（隔离环境，零网络零计费）

| section | 断言 |
|---|---|
| `rerun` | resetStepForRerun：复用模式（succeeded 任务不动、tasksReset = 非 succeeded 数）/ reset_tasks=true（全部归零 + resultAssetId 保留）/ 无任务步骤（hasTasks=false 选项忽略）/ 校验拒绝（skipped 目标、活跃 run、other_failed） |
| `align` | planVoiceAlignedSegments：一致映射启用（带台词镜 = 句和、explicit > 句和补镜尾静音、空镜 = explicit ?? fallback 全静音）/ explicit < 句和以句和为准 + warn / 四类回退 reason（motion/no_voices/no_lines_field/mapping_mismatch：孤儿句、幽灵 id、重复句）/ 总长 = Σd；planSrtShifts + shiftSrtText：逐 cue 平移正确、无静音零平移、数量不符 null |
| `bgm` | compose-config：bindBgmFromUpload 落盘 + 行属性 / bindBgmFromAsset 复制行（relPath 复用、原行不变）/ 绑定替换（旧行软删）/ removeBgm / loadBgmAsset 最新优先 + 软删排除 / 隔离（另一 run 的 bgm 不可见）/ 校验（非 audio 拒绝、活跃 run 拒绝）；updateComposeConfig：白名单（未知键 400）+ transition 枚举 + 数值 clamp + 合并写 run.input._compose（他键不丢） |
| `transition` | buildTransitionPlan：n 镜 videoLens（前 n−1 = d+T、末镜 = d）/ offsets = V_k / totalDur = Σd / 单镜禁用 / 非法类型 → none / T clamp [0.1, min(2, min(d))] |
| `template` | v9 解析：make_storyboard after 含 cast_lines + inputs.lines = steps.cast_lines.asset；compose params 四键默认值；旧 v8 快照加载行为不变 |
| `regression` | 对齐回退路径不改变 computeShotSegments 输出（均分/显式/fit_voice 三种场景与 M7 结果一致）；refs/engine 零 diff（越界核查）；probe:m7 全绿 |

### 6.3 实弹（存量 completed run，零生成成本）

1. **单步重跑（复用模式）**：选 batch 步骤（任务全 succeeded）→ rerun → 任务零变化、步骤快速重新执行收敛（0 调用）；再对 rerun 端点做一次状态拒绝校验（活跃时 400）。
2. **对齐合成**：经工作台 mutate 为存量分镜 shots 打上 lines（匹配既有 voices 的 lineId）→ 重新合成 → ffprobe 校验：视频/音频总长相等且 = Σd；SRT 平移后 cue 时间与语音起点对齐（抽查 1–2 条）；成片目检 2 个镜边界（台词起点落在对应镜内）。
3. **BGM**：上传测试音频绑定 → 重合成 → ffprobe 音频轨存在、时长 = 原时长；移除 → 重合成回归无 BGM。
4. **转场**：`_compose.transition = fade / 0.5` → 重合成 → 总长仍 = Σd（补偿数学成立）；none → 重合成回归 M7 行为。
5. **存量兼容**：未打 lines 的 run 重新合成 → 行为与 M7 一致（均分/显式路径）。
6. **浏览器 DOM 验收**（四要素）：RunDetailView 重跑按钮 + RerunModal / ShotBoard 转场控件 / BgmModal 打开与绑定 / 镜头卡台词角标。

### 6.4 兼容回归

`probe:m7`（重点——computeShotSegments / stale 四条断言零回归）＋ `probe:m10` / `probe:m9` / `probe:m8` / `probe:m6` / `probe:m4` / `probe:m3`（模板基线同步 v9）/ `probe:m2a` 全绿。

### 6.5 越界核查

`git status` 对照 §5.4：engine/refs/tts/subtitle/schema 等红线文件零 diff。

### 6.6 文档

roadmap M11 注记（性质/范围/红线/排除/状态）+ README M11 小节（对齐既有范式）。

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| rerun 触发非预期步骤执行 | assertRepairable 保证除目标外无 failed；startRun 只执行 pending（仅目标被重置）；实弹 6.3-1 验证收敛 |
| reset_tasks=true 计费意外（图像/视频全量） | 默认复用模式；UI 弹窗计数 + 红字警示；API 显式传参才全量 |
| 对齐 SRT 平移与 measured 轴错位 | 平移量同源于 voiceDur 数值；cue↔句序 = voices 序（measured 防错位已保证）；数量不符即放弃 + warn；实弹抽查 |
| xfade 帧精度/时间基问题 | 转场启用时统一 `settb=AVTB`；T clamp；总长以 Σd 为准（实弹 ffprobe 验证）；亚帧误差容忍（对白间隙 ≥0.3s 量级） |
| amix 削波（语音 + BGM） | volume 默认 0.25 + normalize=0；UI 可调音量；实弹听检 |
| `_compose` 写入 run.input 的意外影响 | 白名单四键 + 数值 clamp；下划线内部键不被模板引用/不参与 when；合并写不丢他键（probe 断言） |
| 存量 run 快照（v8）行为漂移 | 无 lines / 无 _compose / 无 bgm 时三分支均不注入（filter 与 M7 逐字节一致）；probe:m7 + 实弹 6.3-5 |
| ffmpeg-merge 主路径改动引入回归 | 分支严格以 plan 开关控制（aligned/enabled）；纯函数由 probe 全测；实弹覆盖无特性路径 |
| probe-m3 基线（v8 断言）失败 | 随模板 v9 同步更新断言（步骤结构 + 输入引用） |
