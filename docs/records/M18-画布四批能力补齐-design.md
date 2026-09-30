# M18 设计：创作画布四批能力全量补齐（快赢 / 安全 / 深度 / 规模）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

> 里程碑：M18（2026-09-14 立项）｜上游：M17 创作工作台 · M16 创作画布 · M11 转场/BGM 引擎 · M13 实体参考图 · M5+ 供应商适配层
> 性质：**创作画布从「工作台」到「生产级工作室」**——四批 14 项缺口一次开发：抽帧与转场把引擎能力接进画布、成本与停止让执行可控、回收站与快照让破坏可逆、LLM 节点与模板保真把创作闭环补全、成组与封面上规模、流式 zip 上体量。
> 用户决策（2026-09-14）：四批 14 项一并开发（「1 到 4 一起开发」）；**M17 §8 排除项 4 项全部回收**（画布→模板一键可运行 / 节点成组折叠 / 版本快照 / zip 流式打包）。
> 红线影响：canvases +1 列（deleted_at）；canvas_nodes +1 列（group_id）；+2 表（canvas_groups / canvas_snapshots）；**唯一破坏性行为变更**：DELETE /canvases/:id 由硬删改为软删（进回收站，purge 才彻底删除）；端口矩阵 v3（+text 端口；reference / prompt 端口扩 llm）；GEN_KINDS +llm；新引擎 action `literal`；ai_text 引擎 +prompt_inline；M17 全部端点超集兼容；生成主链 / M15 流水线画布零 diff；零新依赖（fflate 已在依赖）。

---

## §1 背景与目标

### 1.1 现状（勘察结论，2026-09-14）

| 批次 | 现状缺口 |
|---|---|
| 快赢 | 视频产物**抽不了帧**（i2v 迭代 / 首尾帧接力断链，内部仅 thumb.ts 有 480px 缩略先例）；compose 节点只做 concat+混音，**M11 的转场与 BGM 能力接不进画布**；执行前**看不到成本**（usage.ts 定价体系已全，但画布无接入）；批量执行后**没有一键停止**（只能逐任务取消）；画布产物挂接实体只有 Inspector 单节点入口（CreationInspector 已有 attachRefAssets 单张调用，无批量） |
| 安全 | 画布删除**完全不可逆**（硬删级联）；改坏文档**无版本可回退**（多会话版本历史为 M17 排除项） |
| 深度 | text 节点是**死文本**（只能作提示词，不能生成内容）；**图生文（反推提示词）无从下手**；画布→模板草案低保真（gen 节点 prompt 注释化，产物**不可运行**，M17 排除项） |
| 规模 | 节点多时**无可视分组**（只能靠坐标摆布）；画布列表**无封面**（分不清谁是谁）；导出 zip **全内存打包**（大画布内存峰值高） |

### 1.2 目标

1. **快赢**：视频抽帧端点（video→image 素材直落画布）；compose 转场 + BGM spec 字段（复用 buildTransitionPlan / M11 混音链）；执行成本预估（run-preview，复用 priceOf 定价链）；画布级一键停止；批量「加入实体参考」前端接线。
2. **安全**：画布软删 / 回收站（trash / restore / purge）；文档快照（创建 / 列表 / 恢复 / 删除，**保留 id 重放**防任务历史孤儿）。
3. **深度**：LLM 文本节点（genKind='llm'，文本处理 + 图生文统一，端口矩阵 v3）；画布→模板保真 v2（literal 引擎 action + draft v2 + template-try 一键试跑）。
4. **规模**：节点成组 / 折叠（canvas_groups + group_id）；画布缩略图封面（listCanvases 派生）；导出 zip 流式化（内存 O(64KB)）。

---

## §2 范围

### 2.1 数据模型（`schema.ts` + `db/index.ts` ensureX 幂等）

```ts
// canvases：+1 列
deletedAt: integer nullable        // 回收站（null = 正常；非 null = 已删时间戳）

// canvas_nodes：+1 列
groupId: integer nullable          // 成组归属（null = 未成组）

// 新表 canvas_groups
id / canvasId / title / color(nullable) / collapsed(boolean, 默认 false) / x / y / createdAt
// x/y = 组锚点（创建时写包围盒左上；正常渲染用成员实时派生包围盒，空组用存储值）

// 新表 canvas_snapshots
id / canvasId / label / doc(text, JSON) / createdAt
// doc = { nodes: [...], edges: [...], groups: [...] }（全量行快照：含 id/spec/坐标/seq/adoptedTaskId/groupId/createdAt）
```

- **软删语义**：所有画布子端点经统一装载点过滤 `deletedAt`（已删 → 404「画布不存在或已删除」）；`GET /canvases` 默认排除已删；软删时**自动取消在途任务**（pending/processing → cancelled，复刻 tasks.ts cancel 语义）。
- **快照恢复语义（保留 id 重放，核心设计）**：恢复 = ①自动创建「恢复前自动备份」快照 → ②清空现 nodes/edges/groups → ③按快照 doc 重插（**显式保留原 id**）→ ④ emitCanvasChanged。保 id 使 adoptedTaskId 指向的 gen_tasks.canvasNodeId 依然成立（任务历史不孤儿，往返可逆）。每画布快照上限 20（超出 400 提示清理）。
- **迁移**：schema.ts 定义 + drizzle 迁移 + `db/index.ts` ensureColumn ×2 / ensureTable ×2（旧库兜底，幂等）。

### 2.2 端口矩阵 v3（`creation.ts` 校验扩展；v2 全超集）

| 端口 | 目标（v3 变化标粗） | 上限 | 源（v3 变化标粗） |
|---|---|---|---|
| reference | image gen ≤6；video gen ≤2；**llm ≤4** | 6/2/4 | 素材（图片资产）· gen 产图 · entity 节点 |
| first_frame / last_frame | 仅 video gen | 各 1 | 不变 |
| source | 仅 edit 节点 | 1 | 不变 |
| prompt | image / video / audio gen；**llm** | 1 | text 节点；**llm 节点**（产物文本） |
| video / audio | 仅 compose | 4 | 不变 |
| **text（新）** | **仅 llm** | 4 | **text 节点 · llm 节点**（文本素材，非指令） |

- GEN_KINDS → `['image', 'video', 'audio', 'compose', 'llm']`；`productKindOf(llm) → 'text'`（任务 kind = 'llm' 直传 gen_tasks.kind，产物为 text 资产）。
- **loadInputPlan 预装载扩展**：prompt 端口上游为 llm 节点时，读其显示任务的 text 产物资产全文装入 `UpstreamInfo.text`（planNodeInputs 保持纯函数）；text 端口上游 = text 节点（spec.text）/ llm 节点（产物文本）→ 新 InputPlan 字段 `textInputs: string[]`。
- reference 端口 from 侧校验扩展：llm 目标接受图片资产 / gen 产图 / entity（cap 4）。

### 2.3 批 1 · 快赢（5 项）

**① 视频抽帧 `POST /nodes/:id/extract-frame { mode?, time?, x?, y? }`**
- 源：gen(video) 节点显示产物 · asset 节点视频资产；其余 400。
- 纯函数（探针直测）：`frameTimeOf(mode, time, duration)`——`first → min(0.1, dur/2)`；`last → max(0, dur-0.1)`；`custom → clamp(time, 0, dur)`（duration 未知退化 0.1）；`buildFrameExtractArgs(src, out, t)` → `-ss {t} -i {src} -frames:v 1 -q:v 2 {out}.jpg`（**全尺寸不缩放**，区别于 thumb 的 480 缩略）。
- 服务端：ffmpeg 抽帧（30s 超时，镜像 thumb.ts tmp+rename 原子写）→ `registerAsset(kind:'image', purpose:'creation_frame')` → 新建 **asset 节点**（未给坐标时源节点右下偏移放置）→ `{ node, asset }`。
- 用途闭环：视频 → 抽帧（首/尾帧）→ first_frame/last_frame 接力 i2v。

**② compose 转场 / BGM（spec 扩展 + buildComposeArgs v3）**
- NodeSpec 扩展（仅 genKind=compose）：`transition?`（TRANSITIONS 枚举）/ `transitionDuration?`（0.1-2，默认 0.5）/ `bgmAssetId?` / `bgmVolume?`（0-1，默认 0.5）/ `bgmFade?`（默认 true）。
- `buildComposeArgs` 扩可选参：`durations?`（各视频段时长，assets.duration）/ `transition?` / `transitionDuration?` / `bgmPath?` / `bgmVolume?` / `bgmFade?`。**旧调用形态输出零变化**（仅新参数才改变 args，probe-m17 快照兼容基线）。
- 转场链：`buildTransitionPlan(durations, transition, dur)`（M11 已导出）→ enabled 时每段 scale+pad+setsar+`settb=AVTB`+`tpad=stop_mode=clone` 补足 d+T（前 n-1 段）→ `xfade=transition=..:duration=..:offset=..` 链（offset 用 plan.offsets）。duration 缺失/不齐 → 转场禁用 + notes「素材时长未知，转场已跳过」（宽容降级不阻断）。
- BGM 链：`-stream_loop -1 -i bgm` + `atrim=0:{totalDur}` + `volume` + `afade` 首尾 1.5s（bgmFade）→ 与既有音频链 `amix normalize=0`（无视频音轨 → BGM 单源）。
- readiness：bgmAssetId 校验存在 / 属项目 / kind=audio。
- Inspector compose 表单：转场下拉（中文标签）+ 时长 + BGM 选择（下拉列本画布音频节点/资产产物）+ 音量。

**③ 执行成本预估 `POST /canvases/:id/run-preview { nodeIds? }`**
- 从 startCanvasNodeRun 拆出 `preflightNode(canvas, node)`（spec 解析 + planNodeInputs + readiness problems，run/preview 共用）。
- 计费：image gen → `{ unit:'image', qty:1 }`（edit 同）；video gen → `{ unit:'second', qty: spec.duration ?? 5 }`；audio gen → `{ unit:'char', qty: 指令文本长度 }`（promptText ?? spec.prompt）；compose → 0（本地零成本）；llm → **unpriced**（tokens 不可预知，前端显示「按量计费」）。
- 单价链复用：实例级 `apiConfigs.pricing`（{provider}:{model} → {provider}:* → {provider} → {model}）→ `settings.pricing`；`priceOf` 纯函数复用；单位 base 对齐 usage.ts（image=1 / second=1 / char=1e3）。pricing 缺失 → unpriced 标记。
- 响应：`{ nodes: [{ nodeId, title, ready, problems, units: [{unit, qty, unitPrice, subtotal}], total, unpriced }], total: { amount, unpriced } }`。
- Web：批量面板「预估成本」→ 结果弹窗（逐节点明细 + 合计；unpriced 提示）。

**④ 一键停止全部 `POST /canvases/:id/tasks/cancel`**
- 该画布 `pending | processing` 任务全部置 `cancelled`（复刻 tasks.ts cancel：errorMsg='user cancelled' + completedAt）+ emitCanvasChanged → `{ cancelled: n }`。
- Web：画布顶栏「停止全部」（存在在途任务时可见；执行中任务轮询/ socket 驱动）。

**⑤ 批量设实体参考（前端接线，零服务端改动）**
- 复用既有 `POST /entities/:id/ref-assets { asset_ids }`（M16 并集挂接去重）+ 既有 `attachRefAssets` API 封装。
- Web：批量面板「加入实体参考」→ 实体选择弹窗（项目实体列表）→ 收集选中节点的显示产物资产 id（无产物的节点跳过并提示）→ 一次调用 → notice「已挂接（新增 N 张）」。

### 2.4 批 2 · 安全（2 项）

**⑥ 回收站（软删 / 恢复 / 彻底删除）**
- `DELETE /canvases/:id` → 软删：deletedAt=now + **在途任务自动取消** + emitCanvasChanged。
- `GET /canvases?trash=1` → 已删列表（含 deletedAt + cover + nodeCount）。
- `POST /canvases/:id/restore` → deletedAt=null（未在回收站 → 400 bad_state）。
- `POST /canvases/:id/purge` → 彻底删除（要求先软删；级联删 nodes/edges/groups/snapshots；gen_tasks 行保留留痕）。
- Web：画布列表页「回收站」入口 → 列表（封面/标题/删除时间）+ 恢复 + 彻底删除（二次确认）。

**⑦ 文档快照**
- `POST /canvases/:id/snapshots { label? }`（默认「快照 N」）→ `{ snapshot }`；上限 20。
- `GET /canvases/:id/snapshots` → 列表（id/label/nodeCount/edgeCount/groupCount/createdAt，不含 doc）。
- `POST /canvases/:id/snapshots/:sid/restore` → 保留 id 重放（见 2.1）；响应 `{ ok, backupSnapshotId, restored: { nodes, edges, groups } }`；重放冲突（id 占用）→ 事务回滚 + 409。
- `DELETE /canvases/:id/snapshots/:sid`。
- 实现注意：恢复用 drizzle 事务（不可用则内存补偿回滚）；恢复清空客户端撤销栈（走既有对账机制）。
- Web：画布顶栏「快照」→ 抽屉：保存 / 列表 / 恢复（二次确认）/ 删除。

### 2.5 批 3 · 深度（2 大项）

**⑧ LLM 文本节点（genKind='llm'）**
- spec：`{ genKind:'llm', prompt, model?, provider?, temperature?, maxTokens? }`。
- 执行：指令 = plan.promptText ?? spec.prompt（空 → readiness problem）；素材 = `textInputs`（text 端口，≤4 段拼接）+ reference 图片（≤4，多模态 ChatContentPart，镜像 style-preset 先例）→ `chatCompleteDetailed` → 文本落 `registerAsset(kind:'text', purpose:'creation_llm')` → resultAssetId。
- readiness 扩展（preflight）：LLM 未配置（resolveLlmEndpoint 失败）→ problem 引导 Settings；指令为空 → problem。
- 用量：recordLlmUsage（镜像 prompt-expand 先例）；任务失败信息对齐「LLM 未配置」引导。
- Web：节点菜单「LLM 文本」；Inspector 表单（prompt / 模型 / 温度）；卡片显示产物文本预览（点击 fetch 资产全文）。
- 图生文闭环：图片 asset → reference → llm（指令「反推提示词…」）→ 产物文本 →（prompt 端口）→ image gen。

**⑨ 画布→模板保真 v2（literal + draft v2 + template-try）**
- **新引擎 action `literal`**（`pipeline/actions/literal.ts`）：零 LLM 纯写文本资产。`inputs: { text }`（引用 input.x / steps.k.asset）或 `params.payload`（字面）；`params: { name_tpl, as: 'raw' | 'storyboard-single' | 'lines-single', output_purpose? }`。as 转换：`storyboard-single → {"shots":[{"id":"s1","prompt":<text>}]}`（结构按 ai-image.ts 解析器最小合法）；`lines-single → {"lines":[{"text":<text>}]}`（按 tts lines 解析）。注册到 action 表。
- **ai_text 引擎扩展**：`params.prompt_inline`（字面指令，与 prompt_tpl 二选一必填）——画布 llm 节点可映射为 ai_text 步骤。
- **draft v2（buildTemplateDraftYaml 升级，响应 +`lossy: string[]`）** 映射表：

| 画布节点 | 模板产物 |
|---|---|
| text 节点 | `inputs {key:'t{id}', kind:'text', label: title, default: 文本}` |
| asset 节点 | `inputs {key:'a{id}', kind:'files', required:false}`（运行时用户选资产；试跑自动预填） |
| gen/image | `lit` 步骤（prompt 源 = input.t{id} 或字面 payload，as:'storyboard-single'）→ `ai_image`（shots: steps.lit.asset；size 等 params 映射） |
| gen/video | 同上 → `ai_video`（first_frame: 上游步骤 assets） |
| gen/audio | `lit`（as:'lines-single'）→ `tts`（lines: steps.lit.asset；voice/speed 映射） |
| gen/llm | `ai_text`（prompt_inline: spec.prompt；inputs: {content: 上游文本/资产}；output_purpose: 'creation_llm'） |
| gen/compose | `ffmpeg_merge`（motion_clips: 上游视频步骤 assets 按 seq/x 排序；fps/resolution 映射；BGM 可映射则映射，转场注释降级） |
| entity / run 节点 | 注释降级（`lossy` 列出） |
| 端口连线 | steps.after 依赖（拓扑序）；seq → 排序依据；步骤 key = `n{id}`（冲突递增后缀） |

- **template-try `POST /canvases/:id/template-try { nodeIds?, key? }`**：draft v2 → `validateTemplateText`（失败 400 + problems）→ `saveTemplate`（key 缺省 `<画布名>-try`，冲突自动后缀）→ `createRunRow`（input 取值：text 型用 default；files 型用 asset 节点资产 id 预填；required 无值 → 400）→ `{ templateKey, runId, lossy }`。
- Web：template-draft 弹窗升级（lossy 列表）+「试跑」按钮 → 成功后在视口建 run 节点（复用 M17 run 节点）+ toast。

### 2.6 批 4 · 规模（3 项）

**⑩ 节点成组 / 折叠**
- 端点：`POST /canvases/:id/groups { nodeIds, title?, color? }`（≥1 节点、须属本画布、**不允许已有组归属**（400 列出违规）→ 建组 + 赋 groupId + 锚点 x/y=包围盒左上）；`PATCH /canvases/:id/groups/:gid { title?, color?, collapsed?, x?, y? }`；`DELETE /canvases/:id/groups/:gid`（解组：成员 groupId=null）。
- 读模型：doc + `groups[]`（id/title/color/collapsed/x/y + 成员由节点 groupId 前端派生）；node + `groupId`。
- 交互：组框 = 成员实时派生包围盒（空组用存储 x/y，默认 240×120）；拖组条 = 本地移动成员 + pointerup 批量提交（复用 nodes/batch，入撤销栈一条）；点组条 = 全选成员；双击 = 重命名；三角 = 折叠（成员 v-if 隐藏 + 相关边隐藏 + 组条 32px 高，collapsed 持久化）；组菜单 = 改色 / 解组。
- 组不参与 copy（copy 出的节点 groupId=null）；删节点不删组（空组保留）。
- 快捷键：Ctrl+G 成组。

**⑪ 画布缩略图封面**
- listCanvases（含 trash 列表）响应 + `cover: AssetLite | null`：取该画布**最近完成的 succeeded 任务**（max completedAt）的 resultAssetId → 资产缩略；无 → null（前端占位图标）。两次批查（nodes → tasks 聚合 → assets）避免 N+1。

**⑫ 导出 zip 流式化**
- creation-export.ts：`zipSync` → fflate `Zip` + `ZipPassThrough`（媒体 store 流式，createReadStream 64KB 分块 push）/ `ZipDeflate`（文本/manifest）→ 直写临时文件 → registerAsset(archive) 落位。
- 端点 / 响应 / 条目命名 / manifest 结构**零变化**（探针 unzipSync 对拍：名称/数量/内容逐项等价）；错误（磁盘/读盘失败）→ abort + 清理临时文件。

### 2.7 端点一览（M18 新增 14 枚；M17 全部超集兼容）

| # | 方法 | 路径 | 批次 |
|---|---|---|---|
| 1 | POST | `/nodes/:id/extract-frame` | 快赢 |
| 2 | POST | `/canvases/:id/run-preview` | 快赢 |
| 3 | POST | `/canvases/:id/tasks/cancel` | 快赢 |
| 4 | GET | `/canvases?trash=1`（listCanvases 超集） | 安全 |
| 5 | POST | `/canvases/:id/restore` | 安全 |
| 6 | POST | `/canvases/:id/purge` | 安全 |
| 7 | POST | `/canvases/:id/snapshots` | 安全 |
| 8 | GET | `/canvases/:id/snapshots` | 安全 |
| 9 | POST | `/canvases/:id/snapshots/:sid/restore` | 安全 |
| 10 | DELETE | `/canvases/:id/snapshots/:sid` | 安全 |
| 11 | POST | `/canvases/:id/template-try` | 深度 |
| 12 | POST | `/canvases/:id/groups` | 规模 |
| 13 | PATCH | `/canvases/:id/groups/:gid` | 规模 |
| 14 | DELETE | `/canvases/:id/groups/:gid` | 规模 |

行为变更：`DELETE /canvases/:id`（软删）；`GET /canvases`（默认排除已删 + cover 字段）；listCanvases / detail 读模型 + groups / groupId / cover / lossy 等新字段均为超集扩展。

### 2.8 探针（`scripts/probe-m18.ts`，分 8 节）

| 节 | 覆盖 |
|---|---|
| frame-extract | frameTimeOf 全模式矩阵（含 duration null/边界）+ buildFrameExtractArgs 快照 + 端点全链（gen 源/asset 源/新节点落库/错误族/真实 ffmpeg 抽帧产物验证） |
| compose-v3 | buildComposeArgs v3 快照矩阵（**旧形态输出不变** / 转场启用 / BGM / 转场+BGM / durations 缺失降级）+ spec 校验 + 真实合成冒烟 |
| run-preview | preflight 重构回归 + 定价链（实例级 → settings → 缺失 unpriced）+ 各 genKind 单位矩阵 + 响应结构 |
| trash-snapshot | 软删/在途取消/列表排除/trash 列表/restore/purge 幂等/错误族 + 快照创建/上限 20/保留 id 重放（任务历史认领）/自动备份/恢复冲突 409 |
| llm-node | 端口 v3 全组合 + specProblems（未配置/空指令）+ 执行链（fetch stub 成功径/多模态素材/文本资产落库/用量落库/错误族）+ 产物文本下游装载 |
| template-v2 | literal action 全 as 矩阵 + ai_text prompt_inline + draft v2 映射全节点型 + lossy 清单 + template-try 全链（校验失败/试跑建 run/inputs 预填） |
| groups | 组 CRUD + 跨组拒绝 + 解组 + 成员派生 + 空组 + doc 读模型 |
| scale-zip | cover 派生矩阵（多任务取最近/无产物 null/trash 列表）+ 流式 zip 对拍（名称/数量/内容等价 + 大文件 ~30MB 流式路径） |

回归：probe-m1~m17 全绿（M18 采用「新参数才改变输出」最小侵入设计，旧探针快照预期零适配或极小适配）。

---

## §3 红线复核

| 红线 | 结论 |
|---|---|
| 破坏性交互变更 | 仅 1 项：DELETE /canvases/:id 硬删→软删（回收站），spec/README 双处明示；purge 提供彻底删除出口 |
| 既有端点兼容 | M17 全部端点超集（新字段全可选；DELETE 语义变更是唯一行为变更，已明示） |
| 生成主链 / M15 流水线画布 | 零 diff（compile 层不触碰；literal 为新增 action，注册表超集） |
| 旧探针兼容 | buildComposeArgs / extendTaskParams / specProblems 采「仅新字段才改变输出」；probe-m17 快照预期零适配，如遇断言破坏则按 M17 适配 probe-m16 先例做最小适配并记录 |
| 零新依赖 | fflate 已在 server 依赖（流式 zip 零新增）；无其他新包 |
| 数据安全 | 快照恢复保留 id 重放 + 恢复前自动备份 + 事务/补偿回滚；软删画布全端点 404 过滤；purge 双重前置（须先软删） |

---

## §4 数据与接口变更清单

**Server 新文件**：`pipeline/actions/literal.ts`（literal action）；`services/creation-snapshot.ts`（快照 CRUD + 恢复重放）；`services/creation-groups.ts`（成组 CRUD）；`scripts/probe-m18.ts`。

**Server 改动**：
- `db/schema.ts`（canvases +deleted_at；canvas_nodes +group_id；+canvas_groups；+canvas_snapshots）
- `db/index.ts`（ensureColumn ×2 / ensureTable ×2）+ drizzle 迁移
- `services/creation.ts`（GEN_KINDS +llm；EDGE_PORTS +text；端口矩阵 v3；NodeSpec 转场/BGM + llm 字段；InputPlan +textInputs；UpstreamInfo 装载 llm 产物文本；productKindOf +llm；buildTemplateDraftYaml v2 + lossy）
- `services/creation-gen.ts`（buildComposeArgs v3 + preflightNode 拆分 + llm 执行分派 + extract-frame 执行辅助）
- `services/creation-ops.ts`（batch cancel helper；copy 忽略 groupId）
- `services/creation-export.ts`（流式 zip）
- `pipeline/actions/ai-text.ts`（prompt_inline）；`pipeline/actions/index`（literal 注册）
- `routes/creation.ts`（+14 端点；DELETE 软删；listCanvases cover/trash 超集；统一装载点 deletedAt 过滤）
- `services/usage.ts`（若需：导出价格查找辅助供 run-preview 复用）

**Web 新文件**：`components/CanvasSnapshots.vue`（快照抽屉）；`components/CanvasTrash.vue` 或并入列表页（回收站视图）。

**Web 改动**：`lib/api.ts`（+14 API）；`lib/types.ts`（类型超集）；`views/CreationView.vue`（顶栏：停止全部/快照/试跑；回收站入口；lossy 展示）；`components/CreationBoard.vue`（组框渲染/拖动/折叠/重命名/成组快捷键）；`components/CreationInspector.vue`（抽帧按钮 / compose 转场+BGM 表单 / llm 表单与产物文本 / 实体参考批量入口配合）；批量面板（预估成本 / 加入实体参考 / 成组）；画布列表页（封面 + 回收站）。

---

## §5 验收标准

1. **探针**：probe-m18 八节全绿；probe-m1~m17 回归全绿（适配量最小化并记录）。
2. **实弹**（真实浏览器 + 真实数据留痕）：视频抽帧→首帧接力；compose 转场+BGM 出真实成片；run-preview 展示真实定价；停止全部中断在途任务；批量挂接实体参考图；软删→回收站→恢复→彻底删除；快照保存→改乱→恢复（含自动备份）；llm 文本处理与图生文；画布→试跑建 run 节点跑通；成组/折叠/拖动/解组；列表封面；大量产物的流式导出。
3. **兼容**：M17 既有交互与端点行为不变（除软删明示变更）；`GET /canvases` 旧客户端字段全在（超集）。
4. **文档**：README 更新（M18 能力 + 软删变更 + 快捷键 Ctrl+G）；review 文档；spec 本文档。

---

## §6 风险与回滚

| 风险 | 缓解 |
|---|---|
| 快照恢复（保留 id 重放）破坏数据 | 恢复前自动备份快照 + 事务/补偿回滚 + 冲突 409 不半吊子；探针覆盖任务历史认领断言 |
| 软删变更影响既有前端/测试 | 统一装载点过滤 + 超集字段；probe 回归断言旧行为（列表默认项）+ 明示文档 |
| 模板 v2 依赖引擎解析结构（shots/lines/files） | 实施首步精读 ai-image/tts/executor 解析器对齐最小合法结构；draft v2 分级保真 + lossy 显式清单；探针端到端 stub |
| 流式 zip 在 Bun 下行为差异 | 探针 unzipSync 逐项对拍 + 大文件路径验证；失败可回滚为 zipSync（单函数隔离） |
| compose xfade 链与 M11 滤镜串偏差 | 复用 buildTransitionPlan + 对齐 ffmpeg-merge 滤镜构造；真实合成冒烟（探针 + 实弹） |
| llm 未配置体验 | readiness 预检提前暴露 + 引导 Settings（镜像 prompt-expand 先例） |

回滚：各批次独立可回滚（数据列/表新增为幂等增量；软删可一键恢复为硬删语义；literal action 可摘除注册）。

---

## §7 实施计划

| 阶段 | 内容 | 产出 |
|---|---|---|
| P1 | 数据模型与迁移：schema + db/index ensureX + drizzle 迁移 + probe-m18 骨架（8 节壳） | 迁移可跑、探针可执行 |
| P2 | 批 1 快赢：extract-frame / compose v3 / run-preview / tasks:cancel / 实体参考前端；探针 frame-extract + compose-v3 + run-preview | 探针 3 节绿 |
| P3 | 批 2 安全：回收站（软删/trash/restore/purge）+ 快照（表/CRUD/保留 id 重放/自动备份）；探针 trash-snapshot | 探针绿 |
| P4 | 批 3-1 LLM 节点：端口 v3 + 执行链 + 前端；探针 llm-node | 探针绿 |
| P5 | 批 3-2 模板 v2：literal + ai_text prompt_inline + draft v2 + template-try + 前端；探针 template-v2 | 探针绿 |
| P6 | 批 4 规模：成组 / 封面 / 流式 zip + 前端；探针 groups + scale-zip | 探针绿 |
| P7 | 回归与收口：probe-m1~m17 回归（适配记录）+ 实弹验证 + README/review 文档 + 提交 | 全绿 + 文档 |

---

## §8 明确排除

| 排除项 | 去向 |
|---|---|
| 「音字对齐」（画布无字幕/分镜语义，需先建字幕节点） | 后续里程碑候选 |
| 参考边全保真映射（画布参考图边 → 模板实体锚定的完全等价） | v2 尽力（entity → 注释），后续模板引擎支持参考图直通时回收 |
| 组嵌套（组套组） | v1 单层；后续候选 |
| 快照 diff / 分支对比（只做单文件快照恢复） | 后续候选 |
| compose 转场用于「非等尺寸视频段」的智能裁剪（v1 统一 scale+pad） | 后续候选 |
| 抽帧多帧批量（v1 单帧） | 后续候选 |
| 回收站保留期自动清理（v1 手动 purge） | 后续候选 |
