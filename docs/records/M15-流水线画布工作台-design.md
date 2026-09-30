# agencys-content-studio M15 设计文档（流水线画布工作台）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

> 里程碑：M15（2026-09-13 立项）｜上游：M2 DAG 调度语义 · M4 run 体系 · M7/M10/M11 工作台与单步重跑先例 · M14 收官（组3 平台层完结）
> 性质：roadmap 红线预留项「画布」的正式引入——**流水线画布工作台**（编排可视化 + 画布即工作台操作）。红线表原文「Electron/画布仍未引入」自此更新为「画布已于 M15 引入；Electron 永久不做」。
> 用户决策（2026-09-13）：定位 = 流水线编排画布（步骤为节点 + 依赖连线、实时状态）；能力 = 画布即工作台（画布上直接触发执行）。

---

## §1 背景与目标

### 1.1 现状（勘察结论，2026-09-13）

| 方向 | 现状 |
|---|---|
| 画布 | 项目自 M1 起将「画布」列入红线（不引入），roadmap 待评估项；代码库零画布实现 |
| 运行可视化 | `RunDetailView` 纵向列表 + 步骤卡（线性排布）；**依赖关系不可见**——after / 默认前一步 / when 隐含依赖只存在于引擎代码 |
| 依赖语义 | 单一真源 = `engine.depsFor`（**私有方法**，engine.ts L378-413）：①显式 `after`（多值、去重、排除自身）②无 after → 前一步骤 key ③平铺 when/when_any/gate.when 全部表达式的 `steps.x.count` 隐含引用 |
| 数据引用 | 步骤 `inputs` 支持四形态引用（refs.ts）：`input.x` / `steps.x.asset(s)` / `assets purpose=p` / 串内插（内插仅 input.\*）；**无「反向列出步骤间引用」的工具**——数据流边需新解析 |
| 操作端点 | 齐备（M2–M11 沉淀）：gate 三决策 / cancel / resume / 单步 rerun（reuse·reset 两模式）/ task retry·cancel / recompose / 启动 run——**画布零写端点需求** |
| 实时通道 | socket `studio.event` 8 类事件；惯例「事件仅作增量提示，客户端以 REST 全量对账」（350ms 防抖 + in-flight 合并） |
| 模板侧 | 仅 YAML 编辑器（TemplatesView）；编排结构（gate 位 / 分支 / 数据流）无图形预览 |

### 1.2 目标

1. **运行画布**：以 run 为单位渲染 DAG——节点 = 步骤（状态/耗时/尝试/闸门/任务计数/产物），边 = 调度依赖边（与引擎逐字同源）+ 数据引用边；socket 实时刷新。
2. **模板画布**：以模板为单位预览**编排设计态**（依赖边/数据流/gate 标记/when 条件摘要），不含运行状态——校对 YAML 的图形视图。
3. **画布即工作台**：画布上直接操作——节点抽屉内完成闸门决策 / 单步重跑 / 任务重试 / 重新合成；顶栏完成 run 取消 / 续跑；模板画布可一键启动新 run。**全部复用既有端点**。

---

## §2 范围

### 2.1 依赖语义共享化（`pipeline/dag.ts` 新 + engine 纯委托）

画布的调度边必须与引擎调度**逐字一致**（单一真源）。处理：

- 新建 `pipeline/dag.ts`：将 engine 私有 `depsFor`（L378-401）与私有 `whenExprs`（L404-413）逐行移入，导出：
  - `stepDeps(def, template, orderByKey): string[]` —— 引擎消费（原样语义）
  - `stepDepEdges(def, template, orderByKey): Array<{ from: string; origin: 'after' | 'default' | 'when' }>` —— 画布消费（同内部实现产出，带来源标注，**不是第二套逻辑**）
- `engine.ts` 改动（≤8 行，M15 唯一引擎触碰）：L261 / L287 两处调用改为 `stepDeps(...)`；删除私有 `depsFor` / `whenExprs`。**调度行为零变化**（三重背书：diff 留痕 / probe `dag` 节矩阵断言 / 全量回归）。
- 语义边界照抄原文：`after !== undefined` 即取代默认前一步（空数组 = 显式无依赖）；`push` 排除自身 + 去重；when 表达式 parse 失败吞错（loader 已静态校验，执行期兜底）。

### 2.2 画布读模型（`services/canvas.ts` 新，纯读零写）

**`buildRunCanvas(runId)`**（run 不存在 → 404）：

- 数据源：run 行 + `templateForRun(run)`（**快照优先，快照即硬证据**）+ steps 行（按 seq）+ gen_tasks 按 stepId 聚合计数（单查询 group by）。
- 节点（每步；模板 def 缺失行 → 宽容以行数据渲染；行缺失 def → 宽容以 pending 渲染）：
  ```
  { key, stepId(行 id；孤儿行 null), seq, action, title, status, attempts, error,
    startedAt, completedAt, durationMs(派生：completedAt-startedAt),
    gate: { mode, message, skipLabel?, when? } | null,
    skippedReason: string | null,          // output.skipped.reason（user_skip/upstream_skipped/when_condition）
    tasks: { total, succeeded, failed, running, pending, cancelled },
    assetIds: number[],                    // output.asset_ids（解析失败 → []，宽容）
    input: unknown,                        // step.input 快照（解析失败原样；行缺失 null；抽屉输入区）
    actions: {                             // 服务端算好的操作可用性（前端只渲染，不重复判定）
      gate: { approve, reject, skip } | null,     // waiting_input + def.gate；skip 额外需 skip_label
      rerun: { allowed, reason } | null,          // 复刻 assertRepairable 三条件（本地判定，见下）
      recompose: { allowed, reason } | null,      // action=ffmpeg_merge 且 rerun 同门禁（allowActions=['ffmpeg_merge']）
      taskRetry: { count } | null,                // 该步 failed/cancelled 任务数（>0 且 run 允许时非 null）
    } }
  ```
- 操作可用性判定细节：
  - **rerun 本地判定**（不等价于整读：避免 N 步 × 3 查询放大）：`run ∈ {completed, failed}`；`step ∈ {succeeded, failed}`；run 内除本步外无 failed——三条件全中 → `{allowed: true, reason: null}`；否则 `reason` 为人类可读原文（对齐 assertRepairable 报错文案）。**probe 加一致性抽查节：同一 fixture 下画布判定与 `checkRepairable` 逐点一致**。
  - **taskRetry**：条件 = 该步存在 failed/cancelled 任务 且 run ∉ {completed, waiting_input, running}（对齐 tasks.ts retry 约束）。节点级仅给计数徽记；具体重试在抽屉任务列表行内（单任务粒度）。
  - gate skip：无 `skip_label` → `skip: false`（前端置灰不渲染按钮）。
- 边（两类，去重后混合列表）：
  - `sched`：`stepDepEdges(def, ...)` 逐条 → `{ from, to, type: 'sched', origin }`；**一个 def 可能同时产出默认边与 when 隐含边**（如首步带 when_count → 仅有 when 边）。
  - `data`：扫描 def.inputs 字符串值（数组/对象递归）命中 `^steps\.([\w-]+)\.(asset|assets)$` 整串引用 → `{ from, to, type: 'data' }`（去重）。注：串内插 `{}` 只支持 input.\*，无需扫描。
  - 同 from→to 同时占两类型 → 保留两条（前端合并渲染：实线为底 + 数据徽记）。
- `runActions`：`{ canCancel: run ∈ {queued, running, waiting_input}, canResume: run ∈ {failed, cancelled} }`。

**`buildTemplateCanvas(key)`**（模板不存在 → 404）：

- `loadTemplate(key)`；节点 = def 静态信息：`{ key, seq, action, title, gate: {mode, message, skipLabel?, when?} | null, when?, whenAny?, after?, batch?: {size_field?, count?} 摘要, inputsRefs: [{ field, kind: 'input' | 'step' | 'assets-purpose', ref }] }`（inputsRefs 复用 refs.ts 的 FULL_REF 匹配；内插 input 引用一并列出）
- 边：同二类（无运行字段）；无 runActions。

### 2.3 画布路由（`routes/canvas.ts` 新 + app.ts 挂载）

- `GET /runs/:id/canvas` → `{ run, template: { key, name, version }, nodes, edges, runActions }`
- `GET /templates/:key/canvas` → `{ template: { key, name, version, description?, genre }, nodes, edges }`
- **零写端点**：操作全部走既有端点（`POST /runs/:id/gate|cancel|resume|steps/:k/rerun|recompose`、`POST /tasks/:id/retry|cancel`、`POST /projects/:id/runs`）。
- app.ts：`api.route('/', canvasRoutes)` +1 行。

### 2.4 Web 画布页（`CanvasView.vue` + 子组件，手绘零新依赖）

- **路由**：`/canvas?run=<id>`（运行画布）/ `/canvas?template=<key>`（模板画布）；两 query 互斥，均有 → run 优先；均无 → 空态引导（选择模板或从运行详情进入）。
- **布局算法（前端）**：层号 = 以 sched 边做拓扑最长路径（`level[to] = max(level[to], level[from]+1)`）；层内按 seq 排序垂直堆叠居中。节点卡 ~240×96；层间距 300px、行间距 140px；world 尺寸按内容计算。
- **渲染（手绘）**：
  - 世界层单容器 `transform: translate(panX, panY) scale(zoom)`；边 = `<svg>`（`<path>` 三次贝塞尔，锚点右中→左中）在世界层内；节点 = 绝对定位 HTML 卡。
  - pan：背景 pointerdown/move/up + `setPointerCapture`（节点上不触发）；缩放：滚轮以光标为锚 `zoom ∈ [0.3, 2.5]`；「适应视图」按钮 = fit 全图居中；可选键盘 `+/-/0`。
  - 节点卡：状态类映射对齐 RunDetailView `nodeClass`（running/gate/failed/ok/skip/cancel/idle）；内容 = 标题 + action 徽标 + 状态徽标（复用 `.badge` 与 format.ts 文案）+ 耗时 + 任务计数 + gate 图标 + 含错误时红点。
  - 边样式：sched 实线，data 虚线绿色；running 节点的入边加流动动画（`stroke-dashoffset` 动画）。图例（左下角）：调度依赖 / 数据引用。
- **节点抽屉（`CanvasDrawer.vue`）**：点击节点打开（右侧滑出，关闭保持选中态）；分区：
  1. 头部：title / stepKey / action / 状态徽标 / 耗时 / 尝试次数
  2. 操作区（按服务端 `actions` 渲染；禁用态附 reason）：闸门三决策（approve 支持 note + text_override 输入；reject/skip 支持 note——**提交后 REST 重拉**）、「重跑…」（打开既有 `RerunModal`，done 后重拉）、「重新合成」（confirmDialog → shotApi.recompose）、任务列表（`GET /tasks?run_id=` 前端按 stepId 过滤；failed/cancelled 行内 retry/cancel）
  3. 输入区：模板 def.inputs 原始引用（可视化「此步吃了谁的产物」）+ step.input 快照（折叠）
  4. 产物区：assetIds → 逐个 `assetApi.detail`（≤ 若干）展示缩略 + 点击 `AssetPreviewer` 预览
  5. 日志区：`GET /runs/:id/log?tail=800` 前端按 `[stepKey]` 过滤（行格式 `[ISO] [stepKey] chunk`）；与 RunDetailView 同节流惯例
- **实时对账**：`useStudio(runId)` join/leave；`run.step / run.gate / run.completed / run.failed / step.log / task.updated` 事件 → 350ms 防抖重拉 `GET /runs/:id/canvas`（全量替换数据层，**保 pan/zoom/选中节点**）；日志区独立节流。
- **顶栏**：模式切换（运行/模板）+ 选择器（run 下拉 / 模板下拉）+ run 状态徽标 + 「取消运行」「断点续跑」按钮（按 runActions）+ 「适应视图」。

### 2.5 导航与入口接线

- `App.vue` navs + `{ to: '/canvas', icon: 'flow', label: '画布' }`；`Icon.vue` + `flow`（节点连接图 SVG）。
- `router.ts` + `/canvas` 路由（懒加载同惯例）。
- `RunDetailView` 头部 + 「画布视图」按钮（→ `/canvas?run=<id>`）。
- `TemplatesView` 行内 + 「画布」按钮（→ `/canvas?template=<key>`）。
- 模板画布顶栏 + 「启动运行」（打开既有 `RunFormModal`，`initialTemplateKey` 预填；需先选项目——与既有启动流一致）。

---

## §3 红线复核

- **零新表零新列**：schema.ts / db 零 diff。
- **零新依赖**：server 无新包；web 无新包（pan/zoom/SVG 手绘）。
- **引擎**：唯一触碰 = `depsFor/whenExprs` 移入 `pipeline/dag.ts` 的纯委托（≤8 行）；调度行为三重背书（diff 留痕 / probe `dag` 矩阵 / 全量回归）。refs / loader / 模板 / 提示词零 diff。
- **零写端点**：canvas 路由两枚全为 GET；所有操作复用既有端点（M2–M11 约束原样保留在各端点内）。
- **宽容降级**：画布读模型对损坏快照 / 坏 output JSON / def 与行不匹配——全部兜底不炸；操作可用性只做「判定 + reason」，不做二次门禁（写门禁仍在服务层，画布判定仅作 UI 提示）。
- **行为等价**：不访问画布的既有路径（列表 / 详情 / YAML 编辑器）零漂移。

---

## §4 数据与接口变更清单

**server（新文件）**
- `pipeline/dag.ts`：`stepDeps` / `stepDepEdges`（内部 whenExprs 平铺）
- `services/canvas.ts`：`buildRunCanvas` / `buildTemplateCanvas`（纯读）
- `routes/canvas.ts`：2 个 GET

**server（改动）**
- `pipeline/engine.ts`：2 处调用点改 `stepDeps`，删 2 个私有方法（≤8 行）
- `app.ts`：+1 挂载行；`package.json`：+`probe:m15` 脚本

**web（新文件）**
- `views/CanvasView.vue`（页壳：模式切换/顶栏/数据拉取/实时对账）
- `components/CanvasBoard.vue`（世界层渲染 + pan/zoom + 布局）
- `components/CanvasDrawer.vue`（节点抽屉：操作/输入/产物/日志）
- （节点卡/边为 CanvasBoard 内模板片段，不单独成件）

**web（改动）**
- `router.ts`（+1 路由）、`App.vue`（+1 nav）、`Icon.vue`（+flow）、`lib/api.ts`（+canvasApi）、`lib/types.ts`（+CanvasNode / CanvasEdge / RunCanvas / TemplateCanvas）

**探针**
- `apps/server/scripts/probe-m15.ts`（节：`dag` / `canvas-run` / `canvas-template` / `regression`）

---

## §5 验收标准（实弹）

1. **静态**：双端 typecheck 0 错误；`probe:m15` 全绿：`dag`（依赖矩阵：显式 after 多值·去重·排除自身 / 缺省前一步 / 首步 / when·when_any·gate.when 隐含 / 空 after 显式无依赖 / 坏表达式吞错）；`canvas-run`（节点字段映射逐项 / 边集合（sched origin 与 data 混合）/ 操作可用性真值矩阵 / 与 checkRepairable 一致性抽查 / 404 与坏快照宽容）；`canvas-template`（def 节点与两类边 / gate 与 when 摘要 / 无运行字段）；`regression`（既有关键 probe 组 + 引擎调度行为回归〔after/when 组合微型 run 顺序断言〕）。
2. **画布实弹（浏览器 DOM）**：`/canvas?run=` 真 run——节点数=模板步数、边集合与引擎一致、状态徽标随 socket 更新（gate 提交后画布 350ms 内变化）；节点抽屉操作矩阵可用性正确；「重跑」走 RerunModal 成功后节点回 pending→running；「重新合成」confirm 后 ffmpeg_merge 重置；日志按 stepKey 过滤无串行；pan/zoom/fit 交互与刷新保持；`/canvas?template=` 模板画布渲染且启停入口正确；导航/两处入口按钮跳转正确。
3. **零漂移**：engine 调度行为逐字等价（回归证明）；既有页面（RunDetail / Templates / Workbench）零变化。
4. **文档**：README M15 能力速览 + 验收快照；roadmap M15 注记 + 红线表更新（画布已引入）；`m15-review.md`（代码审查）。

---

## §6 风险与回滚

- **依赖边语义漂移** → dag.ts 单一真源 + probe 矩阵 + 与引擎同源调用（非复制）。
- **大模板布局重叠/视效** → 分层布局 + pan/zoom + fit；力导向不引入（backlog 保留）。
- **实时刷新打断交互** → 数据层全量替换但视图状态（pan/zoom/选中）独立保留。
- **rerun 本地判定与 assertRepairable 偏差** → probe 一致性抽查节（同 fixture 双源对拍）；若后续 assertRepairable 修改，probe 即红。
- **回滚**：web 侧摘路由与入口、server 侧删 3 新文件与挂载行即回旧行为；engine 委托为等价重构，不构成回滚点。

---

## §7 实施计划（P1–P5）

- **P1**：`dag.ts` 抽取 + engine 委托 + probe `dag` 节 + 引擎回归（先锁语义，再动画布）。
- **P2**：`services/canvas.ts` + `routes/canvas.ts` + app.ts 挂载 + probe `canvas-run` / `canvas-template` 节。
- **P3**：Web 画布页（CanvasView / CanvasBoard / CanvasDrawer + api + types + router）。
- **P4**：导航与入口（App.vue / Icon / RunDetailView / TemplatesView）。
- **P5**：双端 typecheck + 全量探针 + 实弹 DOM 验收 + 文档三件（README / roadmap / m15-review）。

---

## §8 明确排除（不做，非缺陷）

- **画布上改编排**（拖拽连线 / 增删步骤写回 YAML）——设计态画布只读预览；编排仍走模板编辑器；可视化编排（拖拽编辑）另立 backlog。
- **力导向布局**（backlog「事件图谱力导向图」保留；画布采用确定性分层布局）。
- **跨 run / 跨模板全景图**（多 run 叠加、依赖血缘跨 run 追溯）。
- **批次画布聚合视图**（M4 批次 Board 已有；画布聚焦单 run / 单模板）。
- **画布内编辑提示词/资产**（工作台职责已在 M7/M10/M11 沉淀，画布只做状态展示与操作入口）。
- **画布导图导出**（png/svg 导出另立）。
