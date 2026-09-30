# M22 设计：创作画布深化（编辑与保真）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-16
- 对应纲领：`2026-09-14-agencys-content-studio-m19-m27-charter.md` §三 M22 立项卡（9 项）与 M18 §8 排除项结转
- 决策留痕（2026-09-16 用户拍板四项）：
  1. **音字对齐 = 全链对齐**：compose 接台词/字幕输入 → 段级时长对齐 + 音轨静音填充 + SRT 生成/平移/烧录
  2. **参考保真 = 纲领两类**：图像参考连线 + 视频 first_frame 两类 draft lossy 清零（含引擎 shots 参考直通通道）
  3. **导出实现 = 双端分工**：服务端 SVG 纯函数 + 落资产库；前端 PNG 光栅化直接下载
  4. **跨项目复制 = 混合策略**：同项目跨画布直接引用；跨项目自动拷贝资产文件入目标项目（画布自包含）
- 前置：M16 ✅ / M17 ✅ / M18 ✅（画布三基建）· M19 ✅ / M28 ✅ / M20 ✅ / M21 ✅（2026-09-16 收官）
- 纪律：同一时间只存在一个 L1 详细 spec（校准规则 3）；本轮仅 M22。§6 实施批次内逐批 typecheck + 探针 + 实弹。

---

## §1 背景与目标

### 1.1 现状（勘察结论，2026-09-16）

| 项 | 现状 | 缺口本质 |
|---|---|---|
| ① 音字对齐 | M11 对齐链（`ffmpeg-merge/align.ts` 纯函数族 + `args.ts` 按镜 `[句…,镜尾静音(anullsrc)]` concat）只服务**流水线**；画布 compose 执行径（`gen/execute.ts` executeComposeOnce）音频为 **amix 混音语义**（多轨同时播放），**无段级配对/时长对齐/静音填充/字幕** | compose 语义扩展（段级对齐通道） |
| ② 参考边保真 | **画布运行侧已全保真**（`inputs.ts` planNodeInputs → `execute.ts` assetToDataUri 注入 image/video/llm）；缺口在 **draft 模板路径**：`draft.ts` L306-311 reference/first_frame/last_frame/source 四类边全 lossy；`literal.ts` 无引用注入通道；ai-image/ai-video shots JSON 无参考直通字段 | draft 映射 + literal 扩展 + 引擎 shots 直通字段 |
| ③ 组嵌套 | `canvas_groups` 无 `parent_id`；`createGroup` 拒绝已归属节点（already_grouped）、无 groupIds；`deleteGroup` 解组删行（无子组语义）；前端 `board/index.vue` 单层渲染（membersOf 直接成员/折叠隐藏/包围盒派生） | 数据模型 +1 列 + 服务嵌套语义 + 前端递归渲染 |
| ④ 快照 diff/分支 | `snapshots.ts` 快照 doc={nodes,edges,groups} 全量行；restore 保留 id 重放；**无 diff、无分支**；`duplicateCanvas`（canvas.ts）深拷新 id 先例在位 | 纯函数 diff + 查询端点 + branch 端点 + UI |
| ⑤ 智能裁剪 | `compose-args.ts` L60 归一链固定 `scale=…:force_original_aspect_ratio=decrease,pad=…`（信箱化）；无裁切选项 | spec +1 字段 + 归一链二选一 |
| ⑥ 回收站清理 | 手动 purge（`CanvasTrashModal` → purgeCanvas 级联）；**无保留期/自动清理** | settings key + 定时扫描 + 设置页 Tab |
| ⑦ 跨画布复制 | `ops.ts` copyNodes 同画布深拷（内部边重映射/groupId 不拷/偏移 +40,+40）；无跨画布/跨项目 | 端点 + 跨项目资产/实体拷贝 |
| ⑧ PNG/SVG 导出 | 顶栏有导出 zip（export.ts fflate）；**无布局图导出**；M15 手绘 SVG 边先例（零新依赖哲学） | 服务端 SVG 纯函数 + 前端 PNG 光栅化 |
| ⑨ 多帧抽帧 | `frame.ts` extractNodeFrame 单帧（first/last/custom，durations 探测/寻址降级/原子写全就绪） | mode uniform + count + 网格排布 |

### 1.2 目标

1. **音字对齐全链**：compose 开关式段级对齐——video[i]↔audio[i] 边序配对，段时长 = max(视频,音频)，视频冻帧/音频静音填充，SRT 自动生成（音轨文本）/已有字幕平移/可烧录——默认关闭零漂移
2. **参考保真 v3**：画布 → 模板草案中「图像参考连线 + 视频 first_frame 连线」两类 lossy 清零（literal 引用注入 + 引擎 shots 直通字段）
3. **组嵌套**：多层分组（parent_id），防环移组、删除提升子组、折叠递归隐藏、包围盒递归派生
4. **快照 diff/分支**：快照 ↔ live/快照 字段级差异视图；从快照分支为新画布（新 id 重放 + 映射）
5. **智能裁剪**：compose fit 模式（pad 信箱 / crop 裁切满幅）
6. **回收站自动清理**：保留期（默认 30 天）+ 自动清理开关（settings.trash）；手动 purge 逃生口保留
7. **跨画布复制**：多选节点复制到同/跨项目画布（跨项目资产/实体级联拷贝，画布自包含）
8. **PNG/SVG 导出**：服务端 SVG 布局图纯函数（落资产库）+ 前端 PNG 光栅化下载
9. **多帧抽帧**：均匀 n 帧（2–9），网格排布落节点

---

## §2 范围

### 2.1 总览与批次

| 批次 | 内容 | 性质 |
|---|---|---|
| **批 1** | ① 画布内音字对齐（全链）· ② 参考边全保真映射 v3 | compose 语义扩展 + 引擎/模板直通 |
| **批 2** | ③ 组嵌套 · ④ 快照 diff/分支 · ⑤ compose 智能裁剪 | 数据模型 + 服务/前端 + 1 枚纯函数 |
| **批 3** | ⑥ 回收站自动清理 · ⑦ 跨画布复制 · ⑧ PNG/SVG 导出 · ⑨ 多帧抽帧 | 定时器 + 跨域拷贝 + 纯函数导出 |

发号规则：本轮新增端点 **4 枚**（§2.11）；扩展端点 3 处；**无新表**；`canvas_groups` +1 列（`parent_id`）；`settings` +1 key（`trash`）；compose spec +6 字段（align/subtitle/subtitleAssetId/burnSubtitles/fit/…）；shots JSON +2 直通字段（`ref_asset_ids` / `first_frame_asset_id`）；literal +2 inputs（`refs` / `first_frame`）。

### 2.2 ① 画布内音字对齐（全链，批 1）

**ComposeSpec 扩展**（`services/creation/spec.ts` 归一化白名单 + 类型校验）：

```ts
align?: boolean                        // 音字对齐开关（默认 false —— 零漂移）
subtitle?: 'none' | 'auto' | 'asset'   // 字幕模式（默认 'none'）
subtitleAssetId?: number               // 'asset' 模式：已有 SRT 资产（校验存在性，bgmAssetId 先例）
burnSubtitles?: boolean                // 烧录字幕（默认 false —— 仅生成 SRT 资产）
```

**对齐语义**（段级配对，替代 amix 混音；仅 align=true 且条件满足时启用）：

- **配对原则**：video[i] ↔ audio[i]（边创建序，`planNodeInputs` 已按 incoming 边序 push，直接复用）；启用条件 = 视频段数 == 音频段数 = N（1≤N≤COMPOSE_CAP）且**全部视频/音频段时长可知**（资产元数据优先，ffprobe 兜底——镜像 `resolvedDurs` 先例）
- **段时长**：`D_i = max(v_i, a_i)`（round3）；总长 = ΣD（align 时恒为顺序拼接）
- **视频链**：归一链（scale+pad/setsar）后逐段 `tpad=stop_mode=clone:stop_duration=(D_i − v_i)` 冻帧补足（差 ≤0 不加）
- **音频链**：逐段 `aresample=44100,aformat=…stereo,apad=whole_dur=D_i,atrim=0:D_i` → `concat=n=N:v=0:a=1[aout]`（与 M11 对齐轨构造同构；apad+atrim 双保险抗浮点）
- **转场互斥**：align=true 时 transition 强制降级为纯拼接（宽容），日志 note「对齐模式与转场互斥已禁用转场」；BGM 兼容不变（`atrim=0:ΣD` 计划）
- **宽容降级**：段数不匹配 / 任一段时长未知 / N=0 → 不启用对齐（保持现状 concat/转场 + amix 链）+ note「音字对齐已降级（原因）」，主链不阻断
- **纯函数**：`planAlignedSegments(videoDurs, audioDurs): { segDurs: number[] } | null`（compose-args.ts 导出，null=不满足对齐条件，探针直测）
- **args 扩展**：`buildComposeArgs({ …, align?: { videoDurs; audioDurs } | null, subtitlePath?: string | null })`；align 非空时视频链/音频链走上述对齐构造；subtitlePath 非空时 `[vout]subtitles=filename=…[vsub]` → `-map [vsub]`（Windows 路径转义 `\→/`、`:`→`\:`，实弹验证）

**SRT 链**（新文件 `services/creation/gen/subtitle.ts`，纯函数探针直测）：

- `buildSegmentSrt(segs: Array<{ startSec; voiceDur; segDur; text }>): string | null`：逐段一条 cue——`start = 段起点`，`end = start + min(voiceDur, segDur)`（字幕覆盖真实语音段）；文本空段跳过；全空 → null（note 不生成）
- `parseSrtCues(srt): Array<{ startSec; endSec; text }>`：轻量解析（hh:mm:ss,mmm）
- `retimeSrtCues(cues, segs): string | null`：**已有字幕平移**（subtitle='asset'）——cue 数 == 段数时顺序重钉：cue_i 起点 = 段起点_i，时长保持原 cue 时长（clamp 段内）；数量不符 → null（宽容降级 + note）
- 时间戳格式化复用 `ffmpeg-merge/align.ts` 的 `secToSrtTs`（已导出）

**执行落点**（`gen/execute.ts` executeComposeOnce）：

- 音频段时长补探：`audioDurs = audioIns.map(a => a.duration ?? probeMediaDuration(a.path))`
- align 启用判定 → `planAlignedSegments` → args 传参
- SRT 生成（subtitle≠none 且对齐生效）：'auto' 从音频段资产 `prompt`（tts 语音文本）取文本；'asset' 读 subtitleAssetId 资产 relPath 文本 → 解析 → 重钉
- SRT 落库：`writeTextAsset(…, purpose: 'creation_subtitle', format: 'srt')`（**先落库**，烧录直接引用其文件绝对路径——不删留档）；任务产物 params 追加 `align/segDurs/subtitleAssetId/burnSubtitles` 快照
- 失败留痕：字幕链路失败（资产缺失/解析失败）一律 note 降级，不使合成失败

**前端**（`inspector/GenForm.vue` compose 表单）：音字对齐开关；字幕模式选择（无/自动生成/已有 SRT 资产选择器）；烧录开关；说明文案「对齐需视频与音频段数一致」。

### 2.3 ② 参考边全保真映射 v3（批 1）

> 缺口定位：画布**运行**侧已保真（M17），本项清零 **draft（画布→模板）** 路径的 reference/first_frame 两类 lossy（用户拍板「纲领两类」）。

**A. 引擎 shots 直通字段**（pipeline actions，新增可选字段——无字段行为不变）：

- **ai-image**（`actions/ai-image.ts`）：`collectRefAssetIds` 合并 `shot.ref_asset_ids`（number[]，**前插**、保序去重、总量 ≤MAX_REFS_PER_SHOT）；与实体锚定（characters/location/props）结果共存
- **ai-video**（`actions/ai-video.ts`）：
  - 首帧：`firstFrameAssetId = shotFirstFrameOf(shot) ?? frameIndex.get(shot.id) ?? null`（**画布直通优先于 gen_frames 索引**——画布连线更显式）
  - 参考：`setRefAssetIds = dedupe([...(shot.ref_asset_ids ?? []), ...collectSetRefAssetIds(shot, …)])`（前插，仍受视频参考能力/帧优先决策约束）
- shots JSON 字段风格对齐现有 snake_case（`image_prompt` / `first_frame_asset_id`）

**B. literal 引用注入通道**（`actions/literal.ts`）：

- `inputs.refs`：引用数组（`[input.a12, steps.n13.asset]`）→ 运行时经 refs.ts `resolveValue` 逐个解析（`input.x` 原样值 / `steps.x.asset` 数组）→ **flatten + 正整数过滤** → 注入 `shots[0].ref_asset_ids`
- `inputs.first_frame`：单引用 → 同上归一取首个 → 注入 `shots[0].first_frame_asset_id`
- 仅 `as='storyboard-single'` 生效（raw/lines-single 时忽略 + 日志）；无值不注入（字段缺省 = 引擎行为不变）

**C. draft 映射**（`services/creation/draft.ts`）：

- reference 边（源=image asset/gen）→ literal `inputs.refs` 增表达式：asset 源 `input.a{srcId}`；gen 源 `steps.{finalStepOf.get(srcId)}.asset`（gen 源同时入 after 集合——既有逻辑已覆盖非 prompt 的 gen 源）
- first_frame 边（源=image asset/gen）→ literal `inputs.first_frame` = 同构表达式
- **lossy 收缩**：L306-308 的 refEdges 筛选缩为 `last_frame` / `source`；reference/first_frame 不再入 lossy 清单
- 保持 lossy（明确排除）：last_frame / source（编辑）/ 转场 / BGM / entity / run 节点 / compose 无上游 / **llm 节点 reference 边**（ai_text action 无参考图输入通道，映射无意义）

**探针**：`collectRefAssetIds` 合并断言；ai-video 首帧优先断言；literal 注入 shots JSON 断言（含 flatten 边界：数字/数组/嵌套）；draft YAML 断言（refs 表达式在内、lossy 清单不含两类、last_frame 仍 lossy）。

### 2.4 ③ 组嵌套（多层，批 2）

**数据模型**：`canvas_groups` + `parent_id integer`（NULL=顶层；`ensureColumn` 先例 db/index.ts——PRAGMA table_info + ALTER TABLE 幂等补列，存量行 NULL）。快照 doc 的 groups 行自动含该列（$inferSelect）；`restoreSnapshot` 重放补 `parentId: g.parentId ?? null`（旧快照无字段容错）。

**服务语义**（`groups.ts`）：

- `createGroup(canvasId, { nodeIds?, groupIds?, parentId? })`：
  - `nodeIds` 与 `groupIds` **至少一非空**（否则 400 `bad_node_ids`）；两者合并后即新组直接子级
  - `nodeIds`：须属本画布且无 groupId 归属（保留 already_grouped 拒绝语义）
  - `groupIds`：须属本画布且 `parent_id IS NULL`（顶层组才可被装入；已嵌套 → 400 `group_already_nested`）
  - `parentId`（可选）：须属本画布；新组 `parentId = parentId ?? null`；锚点=全部直接成员（节点包围盒左上；纯组时取子组锚点）
- `updateGroup` **+ `parentId` 变更（移组）**：`null` = 提升顶层；数字 = 移入目标组——校验同画布、非自身、**非自身后代**（沿 parent 链自目标上溯，遇 gid → 400 `group_cycle`）
- `deleteGroup`：成员节点 `groupId=null` + **子组 `parentId=null`（提升顶层）** + 删行（保守提升：与「删节点不删组」哲学一致，不丢组）
- `GroupError` 新增码：`bad_group_ids` / `group_not_in_canvas` / `group_already_nested` / `group_cycle`

**前端递归渲染**（`board/index.vue`）：

- `childGroupsOf(gid)` 派生；`hiddenNodeIds` 递归——折叠组隐藏「自身成员 + 全部后代组成员的并集」
- `groupBox` 递归——成员节点 + 后代组全部节点并集（空组锚点 240×120 先例保留）
- 渲染顺序按嵌套深度升序（祖先背景先画、后代后画）；折叠小条（220×32）保留
- 组条菜单增「移入组 ▸」（候选 = 同画布非自身非后代组）与「移出到顶层」；**拖拽语义保持现状**（移动位置不改归属）
- 移动组（组条拖拽）：**递归平移**全部后代节点 x/y + 后代组锚点 x/y

### 2.5 ④ 快照 diff / 分支（批 2）

**纯函数**（新文件 `services/creation/snapshot-diff.ts`，探针直测）：

```ts
diffSnapshotDocs(base: CanvasSnapshotDoc, target: CanvasSnapshotDoc): SnapshotDiff
// 按 id 匹配 → nodes/edges/groups × { added[], removed[], modified[] }
// modified: { kind, id, title, changes: [{ field, before, after }] }（行对象键浅比较 JSON 值）
// 值展示截断：字符串 >200 字符截断加省略；对象 JSON.stringify 后同规则
// summary: { nodes: {added,removed,modified}, edges: {...}, groups: {...} }
```

- `snapshots.ts` 导出 `collectSnapshotDoc`（现为内部函数）供 diff 取 live 文档

**端点**：

- `GET /api/v1/canvases/:id/snapshots/:sid/diff?against=live|<sid2>`（against 缺省 `live`）：sid/sid2 须属本画布（否则 404）；响应 `{ base: {kind:'snapshot',id,label} | {kind:'live'}, target: {…}, summary, nodes, edges, groups }`
- `POST /api/v1/canvases/:id/snapshots/:sid/branch` body `{ name? }`：
  - 新建画布（同 projectId；name 缺省 `「${src.name} 分支」`）→ **事务内新 id 重放**：groups 先插（新 id 映射）→ nodes（`group_id` 映射、assetId/spec/adoptedTaskId/seq 原样）→ edges（`from/to` 映射）
  - 与 restoreSnapshot（保留 id）差异：branch 是**全新画布空间**，不产生 id 冲突（duplicateCanvas 深拷先例哲学）；返回 `{ canvas }`

**前端**（`CanvasSnapshotsModal.vue`）：「对比」（默认 vs live，可切换另一快照）→ summary 徽标（+a −r ~m）+ 三类明细折叠列表（字段 `before → after` 截断展示）；「分支为新画布」→ 命名弹窗 → 成功后跳转新画布。

### 2.6 ⑤ compose 智能裁剪（批 2）

- **ComposeSpec + `fit?: 'pad' | 'crop'`**（默认 `'pad'`——现状信箱零漂移）
- **归一链二选一**（`compose-args.ts` L60）：
  - pad（现状）：`scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`
  - crop：`scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`（铺满裁边）
- 转场 / 音字对齐模式共用同一归一链（fps 后缀不变）
- **前端**（GenForm compose 表单）：fit 选择（信箱模式 / 裁切满幅）+ 说明（裁切会裁掉画面边缘）
- **探针**：args 快照断言（crop 链完整串、缺省 pad 零漂移）

### 2.7 ⑥ 回收站保留期自动清理（批 3）

- **settings key `trash`**：`{ retentionDays: 1–365（默认 30）, autoPurge: boolean（默认 true） }`（KV 通用端点读写；缺省读内置默认值——M21 concurrency 先例）
- **服务**（新文件 `services/trash-sweep.ts`）：
  - 纯函数 `selectExpiredCanvases(rows: Array<{ id; deletedAt: number | null }>, now: number, retentionDays: number): number[]`——`deletedAt != null && deletedAt < now − retentionDays × 86400_000`（探针直测边界）
  - `purgeExpiredCanvases(): Promise<number>`——全表扫（跨项目）→ 逐个复用 `purgeCanvas`（级联删 nodes/edges/groups/snapshots；gen_tasks 留痕先例不变）→ 返回清理数 + 日志
- **定时**（`index.ts` 启动段）：启动时执行一次 + `setInterval` 6h（M21 pumpStalledBatches 30s timer 先例；unref 防挂起）；`autoPurge=false` 时跳过
- **设置页**（system-settings）：新增「数据」Tab——保留期数字输入（1–365）+ 自动清理开关 + 文案「手动彻底删除不受影响；过期画布将连同节点/连线/快照一并清理（任务留痕保留）」
- **手动 purge 逃生口保留**（CanvasTrashModal 不动）

### 2.8 ⑦ 跨画布复制节点（含跨项目，批 3）

**端点**：`POST /api/v1/canvases/:id/nodes/copy-to` body `{ targetCanvasId, nodeIds, offset? }`

- 校验：源/目标画布均活跃（findCanvas）；`nodeIds` 非空且属源画布；`targetCanvasId !== id`；offset 缺省 `+40,+40`（COPY_OFFSET_DEFAULT 先例）
- **同项目**（target.projectId === src.projectId）：copyNodes 内核复用——深拷 spec/assetId/adoptedTaskId/seq/title，内部边重映射（from/to ∈ 选中集），groupId 不拷（先例）
- **跨项目**（混合策略：画布自包含）：
  - **asset 节点**：`copyAssetToProject`——读源文件 → `copyFileSync` 至 `relPathOf(target.projectId, purpose, fileName)` → `registerAsset`（目标项目新行，params 附 `copiedFrom: { projectId, assetId }`）→ 新节点引用新 assetId
  - **compose `spec.bgmAssetId` / edit `spec.maskAssetId`**：同拷贝 + 引用重写
  - **entity 节点**：级联拷贝——characters 行新插（`projectId=目标`，name/kind/aliases/summary/appearance/negative/voice/states 原样）+ `refAssetIds` 逐张拷贝 → 新实体 id 重写 `spec.entityId`
  - **gen 节点** `adoptedTaskId → null`（跨项目旧任务无关）；**run 节点跳过**（skipped 报告：`cross_project_run_node`）
- **响应**：`{ nodes: [...新节点], skipped: [{ nodeId, reason }], assetsCopied: number }`
- **前端**：画布多选 →「复制到画布…」→ 弹窗（项目选择=当前项目缺省 + 目标画布列表）→ 执行 → 结果提示（含跳过项）；命令挂入 `use-canvas-commands.ts`

### 2.9 ⑧ PNG/SVG 画布导出（批 3）

**服务端纯函数**（新文件 `services/creation/export-svg.ts`，探针直测）：

- `buildCanvasSvg(doc: CanvasDoc): string`：
  - 视口：全节点包围盒 + 40 padding → `width/height/viewBox`；背景 `#fafafa`
  - 节点卡片：矩形 rx=8 + kind/genKind 色板常量表（结构断言优先，色值近似前端节点视觉）+ 标题（截断 16 字符）+ 端口小圆点
  - 边：三次贝塞尔 `M x1 y1 C …` + 箭头 marker；颜色按 port 常量表
  - 组框：圆角虚线框 + 标题（嵌套按 parent 递归，先画外层）
  - XML 转义（`& < > " '`）全字段

**端点**：`POST /api/v1/canvases/:id/export-image` body `{ format?: 'svg' }`（v1 仅 svg）→ `buildCanvasSvg` → `writeTextAsset(purpose='creation_svg', format='svg')` 落资产库 → 响应 `{ assetId, svg }`（svg 文本供前端光栅化）。

**前端**（双端分工）：

- 顶栏导出菜单（现有「导出 zip」按钮并入菜单）：**导出 PNG（下载）** / **导出 SVG（下载）**
- PNG：POST 拿 svg → `Blob → Image → canvas 2x 放大 → toBlob('image/png') → a[download]`（文件名 `{画布名}.png`）；SVG：text blob 直下（`{画布名}.svg`）
- 零新依赖（原生 API + M15 手绘先例哲学）

### 2.10 ⑨ 多帧批量抽帧（批 3）

- **`frame.ts` 扩展**：`FrameMode = 'first' | 'last' | 'custom' | 'uniform'`
- 纯函数 `frameTimesOf(mode, time, count, duration): number[]`：
  - uniform：count ∈ 2–9；`t_i = round3(0.1 + (dur − 0.2) × i / (count − 1))`——**count=3 恰为首/中/尾**；dur ≤ 0.3 → 全部取 `frameTimeOf('first')`（退化保护）；**dur 未知 → 报错**（uniform 需时长）
  - 其余模式返回单元素数组（复用 frameTimeOf）
- **`extractNodeFrame` 扩展**：uniform 时逐时刻抽帧 → N 个 asset（purpose='creation_frame'，params 含 `index/timeSec/duration`）→ N 个 asset 节点**网格排布**：`x = src.x + 60 + (k % 3) × 260`，`y = src.y + 140 + floor(k / 3) × 200`
- **响应兼容**：保留 `{ node, asset }`（=首帧）；uniform 追加 `{ nodes: [...], assets: [...] }`（现有单帧断言不动）
- **路由**：mode 白名单扩展 + uniform 时 count 2–9 整数校验（否则 400）
- **前端**：抽帧菜单增「均匀抽帧 ▸」（数量 2–9 选择）

### 2.11 端点与数据变更一览

| 类型 | 项 | 说明 |
|---|---|---|
| **新端点** | `GET /canvases/:id/snapshots/:sid/diff` | ④ 快照 vs live/快照 字段级差异 |
| | `POST /canvases/:id/snapshots/:sid/branch` | ④ 分支为新画布（新 id 重放） |
| | `POST /canvases/:id/nodes/copy-to` | ⑦ 跨画布/跨项目复制 |
| | `POST /canvases/:id/export-image` | ⑧ SVG 生成 + 落资产 |
| **扩展端点** | `POST /canvases/:id/groups` | ③ +nodeIds/groupIds/parentId |
| | `PATCH /canvases/:id/groups/:gid` | ③ +parentId 移组 |
| | `POST /canvases/:id/nodes/:nid/extract-frame` | ⑨ +mode uniform/count |
| **数据** | `canvas_groups` + `parent_id` | ensureColumn 幂等补列 |
| | `settings` + `trash` key | KV，读缺省内置默认 |
| **spec/数据通道** | compose spec + `align/subtitle/subtitleAssetId/burnSubtitles/fit` | 归一化白名单 + 校验 |
| | shots JSON + `ref_asset_ids/first_frame_asset_id` | 引擎直通（可选） |
| | literal inputs + `refs/first_frame` | 引用注入通道 |

### 2.12 探针计划（probe-m22.ts，九节 + 回归）

- **S1 音字对齐**：`planAlignedSegments`（配对/时长决策/降级 null 分支）；`buildComposeArgs` 对齐链快照（视频 tpad/音频 apad+atrim+concat/转场互斥/BGM 兼容）；`buildSegmentSrt` / `parseSrtCues` / `retimeSrtCues`（生成/平移/数量不符降级）；烧录路径转义串
- **S2 参考保真**：`collectRefAssetIds` 合并（前插/去重/截断）；ai-video 首帧直通优先；literal refs 注入（flatten：数字/数组/嵌套/非法过滤）；draft YAML 断言（refs/first_frame 表达式在内；lossy 不含两类；last_frame 仍 lossy）
- **S3 组嵌套**：createGroup 嵌套（groupIds/nodeIds 合并/拒绝码）；updateGroup 移组防环（自环/后代环/正常移入/提升）；deleteGroup 子组提升；快照含 parentId 重放往返
- **S4 快照 diff/branch**：`diffSnapshotDocs`（added/removed/modified 字段级/截断）；branch 重放映射（groupId/parentId/边端映射正确）
- **S5 fit**：crop 链快照；pad 缺省零漂移
- **S6 回收站**：`selectExpiredCanvases` 边界（null/未过期/恰好边界/过期/retentionDays=1 与 365）
- **S7 跨画布复制**：同项目（边重映射/偏移）；跨项目（资产拷贝新行 copiedFrom/实体级联/run 跳过/adoptedTaskId 置 null）
- **S8 SVG**：`buildCanvasSvg`（svg 头/节点 rect 数/边 path 数/组框/XML 转义样例）
- **S9 多帧**：`frameTimesOf`（2/3/9 帧/退化/未知时长报错）；网格排布坐标
- **回归**：probe-m16/m17/m18/m21 全量重跑（批 1 末期 + 每批后），重点 shot 直通字段缺省零漂移

---

## §3 红线复核

| 红线 | 复核结论 |
|---|---|
| 生成主链零改动 | ai-image/ai-video 的 shots 直通字段、literal 的 refs 输入均为**新增可选**——无字段时行为与现状逐位一致；compose 全部新字段默认关（align=false / subtitle='none' / fit='pad'）；批 1 末重跑 probe-m16/m17/m18 验证零漂移 |
| ensureColumn 先例 | `canvas_groups.parent_id` 走 db/index.ts 幂等补列（PRAGMA + ALTER + try/catch），不动 migrate 体系；无新表 |
| 手绘先例零新依赖 | SVG 为服务端字符串拼接；PNG 光栅化用浏览器原生 `Image + canvas.toBlob`；不引入任何 npm 依赖 |
| 跨画布复制需 spec 论证 | 本 spec §2.8 给出完整论证：同项目引用复用、跨项目拷贝自包含（资产/实体级联、run 跳过、adoptedTaskId 置 null），无跨域悬挂引用 |
| 宽容降级哲学 | 对齐/字幕/基线分支/回收站读取均走「失败提示 + 主链不阻断」（note 清单）；组操作走 400 明确拒绝码（结构变更需显式失败） |

## §4 验收标准

1. **音字对齐**：视频/音频段数相等时开启 align → 各段音向时长对齐（短段静音铺底/视频冻帧），SRT 自动生成落库并可烧录；段数不等/时长未知 → note 降级零阻断；默认关闭时输出与 M18 完全一致（args 快照断言）
2. **参考保真**：reference/first_frame 两类边的 draft 导出无 lossy 条目且 YAML 含 refs 表达式；模板试跑反链参考注入成功；last_frame/source 仍按预期 lossy 报告
3. **组嵌套**：可建多层组；折叠父组递归隐藏全部后代；移组防环（自环/后代环 400）；删父组子组提升；快照恢复后嵌套关系完整
4. **快照 diff/分支**：diff 正确列出增/删/改（字段级）+ 截断展示；branch 生成的新画布节点/边/组完整且引用映射正确（含 groupId/parentId）
5. **智能裁剪**：fit=crop 归一链裁切满幅（args 断言）；缺省 pad 输出不变
6. **回收站**：保留期外画布自动清理（启动 + 6h 周期）；关闭自动清理后不动作；手动 purge 不受影响
7. **跨画布复制**：同项目跨画布直接引用；跨项目资产/实体级联拷贝且目标画布自包含（源项目删除不影响）；run 节点跳过有报告
8. **PNG/SVG**：导出 SVG 落资产库可下载；PNG 由前端光栅化下载清晰可用（2x）；组框/边/标题正确
9. **多帧抽帧**：均匀 2–9 帧落节点网格排布正确；首/中/尾语义（count=3）；短视频/未知时长边界行为符合设计

## §5 风险与回滚

| 风险 | 缓解 |
|---|---|
| 对齐模式与现有 compose 行为冲突 | 全链默认关（零漂移）；降级路径尽测（段数/时长/转场互斥/字幕失败）；args 快照锁旧路径 |
| SRT 烧录 Windows 路径转义失败 | 转义函数探针断言 + 实弹最小样片验证（含空格/盘符路径）；失败时宽容降级（不烧录仍出片 + note） |
| 组嵌套前端递归性能 | 组数量级有限（先例无虚拟化问题）；递归深度按 parent 链自然限制，无额外渲染层 |
| 跨项目拷贝存储放大 | 属预期（自包含优先）；响应报 assetsCopied；后续如需轻量引用可另立里程碑 |
| 回收站自动清理误删 | 默认 30 天 + 可关；手动 purge 逃生口保留；清理仅作用于已软删行（活跃画布零触及） |
| branch 重放事务失败 | 单事务全成功/全回滚（先例）；失败不残留半画布（画布行与重放同事务或失败回收） |

回滚策略：各批功能均独立降级开关（不做数据库回退）；`parent_id` 列保留（NULL=现状行为）；新增端点删除即回退。

## §6 实施计划

| 阶段 | 内容 | 出口 |
|---|---|---|
| **P0 基建**（✅ 2026-09-16） | schema+ensureColumn（parent_id）+ settings.trash 缺省 + spec.ts 字段归一化 + probe-m22 骨架 | typecheck + 骨架可跑 |
| **P1 批 1**（✅ 2026-09-16） | ① 音字对齐全链（planAlignedSegments/subtitle.ts/args 扩展/execute 接线/GenForm）· ② 参考保真 v3（引擎直通/literal/draft） | S1+S2 探针 + 回归零漂移 + 实弹（对齐烧录样片 + 模板试跑参考） |
| **P2 批 2**（✅ 2026-09-16） | ③ 组嵌套（服务/快照兼容/前端递归）· ④ 快照 diff/分支（纯函数/端点/UI）· ⑤ fit | S3+S4+S5 探针 + 实弹（嵌套渲/移组防环/diff 视图/分支画布） |
| **P3 批 3**（✅ 2026-09-16） | ⑥ 回收站清理 · ⑦ 跨画布复制 · ⑧ PNG/SVG · ⑨ 多帧抽帧 | S6—S9 探针 + 实弹（清理周期/跨项目拷贝往返/导出下载/多帧落位） |
| **P4 收口**（✅ 2026-09-16） | 全量探针回归 + review 落盘 + roadmap 校准 + README 速览 | M22 收官报告 |

## §7 明确排除

- last_frame / source（编辑）边直通与模板映射（引擎边界，保持 lossy）
- llm 节点 reference 边的模板映射（ai_text action 无参考图输入通道；参考仍走画布运行侧）
- 对齐模式与转场叠加（align 时转场宽容禁用——段边界与音频严格对应优先）
- SRT cue ↔ 段模糊匹配（仅数量相等等精确配对，否则降级）
- 快照 diff 画布内图形高亮定位（v1 为列表级明细）
- 导出图编辑态还原（PNG/SVG 为静态布局快照，非交互）
- 跨项目复制 run 节点（跳过策略）、gen 任务/变体历史迁移
- 力导向布局 / 画布虚拟化 / 性能基准（M23 程序内）
