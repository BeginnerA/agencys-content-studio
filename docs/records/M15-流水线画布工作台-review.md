# agencys-content-studio M15 里程碑 review

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-13
- 对应 spec：`2026-09-13-agencys-content-studio-m15-design.md`（§5 验收）
- 判定：**静态 + 探针 + 实弹（浏览器 DOM 两轮）全绿**（首轮 15 项 14 通过 + 1 项数据态不适用，暴露 1 处缺陷已修复；复验 12/12 全通过）
- 证据采集方式：`probe:m15` 四节 78 项断言 + 回归 m2a·m4·m14；真实开发库实弹（Run 102/96/101/80 · 服务 3001 + vite 5174 运行态）；无头浏览器 DOM 两轮；**全程零真实提交（零计费）**

---

## 结论摘要

- **依赖语义单一真源落地**：`stepDeps` / `stepDepEdges` 从引擎抽为 `pipeline/dag.ts` 纯函数，engine 两处调用点改纯委托（删 2 个私有方法，净 −45 行）。画布布局与调度**同源调用（非复制）**——probe `dag` 矩阵 18 项锁语义（显式 after 多值·去重·排除自身 / 缺省前一步 / 首步 / when·when_any·gate.when 隐含 / 空 after 显式无依赖 / 坏表达式吞错 / 混合来源顺序与去重）+ 引擎调度行为回归（m2a 全绿）。
- **画布读模型纯读零写**：`GET /runs/:id/canvas`（节点=步骤行×模板 def 合并 / sched 边 + data 边 / 操作可用性真值矩阵与 `checkRepairable` 双源对拍 / 404 与坏快照宽容兜底）与 `GET /templates/:key/canvas`（设计态零运行字段）全过；canvas 路由两枚全 GET，所有操作复用既有端点（gate / cancel / resume / rerun / task retry / recompose / start）。
- **画布即工作台（DOM 双入口验证）**：运行页「画布视图」→ `/canvas?run=`、模板页「画布」→ `?template=` 入口正确；节点抽屉操作矩阵可用性正确；run96 failed 步重跑链路（RerunModal 打开 → 取消零提交）、run80 人工闸门 drawer（message + 批准/驳回/中止/直接入库）实测通过。
- **实弹暴露缺陷 1 处（已修复）**：画布挂载时数据未到 → 按空布局 fit（100% 偏出视口，需手点「适应」）。修复 = `fitted` 标志 + 首次非空数据到达 `fitOnce()`（watch nodes 数）+ `resetView` 同步清数据防跨目标残留视口；复验自动 30% 适应（transform `matrix(0.3,0,0,0.3,-67,153.6)`）。
- **零真实提交策略**：所有会触发真实执行的按钮（批准/驳回/确认重跑/断点续跑/取消运行/启动运行）仅验证 wiring（按钮可用性 + 弹窗打开 + 取消），未真实提交——write 路径由既有 M2/M4/M7/M11 探针与验收背书。

---

## 验收逐条对照（spec §5）

### #1 静态：双端 typecheck + probe:m15 四节 + 回归

- **操作**：`pnpm --filter @acs/server typecheck` + `pnpm --filter @acs/web typecheck`；`probe:m15`（dag / canvas-run / canvas-template / regression）。
- **证据**：双端 typecheck exit=0；`probe:m15` **78 项断言全过**（dag 18 / canvas-run 43 / canvas-template 14 / regression 3；终判「全部通过」）。
  - `dag`：真模板不变式（依赖均在模板内且不含自身）+ 真模板抽样（write_script 缺省前一步 / sync_characters 显式多值顺序 / compose_video 5 值顺序 / 首步无依赖 / default·after 边 origin）+ 矩阵 12 项（缺省前一步 / 显式多值 / 排除自身+去重 / 空 after 无依赖 / when·when_any·gate.when 隐含 / 坏表达式吞错 / 混合顺序与来源 / 数组去重）。
  - `canvas-run`：节点字段映射逐项（含 stepId / input 透传）+ 两类边集合对拍 + 操作可用性真值矩阵（rerun / recompose / taskRetry / gate / cancel / resume）+ 与 `checkRepairable` 双源对拍 + 404 与坏快照宽容。
  - `canvas-template`：def 节点静态字段逐点对拍 + 两类边 + gate 摘要（message 不内插 / skipLabel / when）+ when/after 透传 + batch 摘要 + inputsRefs + 零运行字段。
  - `regression`：probe:m2a / m4 / m14 全绿（exit=0）。
- **✅ 通过**

### #2 画布实弹（浏览器 DOM）

- **操作**：真实开发库运行态（服务 3001 + vite 5174）——运行画布（Run 102 / 96 / 101）、人工闸门（Run 80）、模板画布（mengbao-episode）、空态与入口跳转。
- **证据（复验 B 轮 12/12 全通过）**：
  - B1 自动 fit 30%（`matrix(0.3,0,0,0.3,-67,153.6)`）；
  - B2 侧栏「画布」选中态；B3 Run 96 failed 步（批量镜头动效 #20 / ai_video / 50.1s）：节点卡失败徽标 + 单步重跑按钮 enabled（title=「重跑该步骤（可复用成功子任务）」）→ RerunModal 打开（整体执行型步骤双单选 disabled + 说明，属预期）→ 取消无提交；
  - B4 Run 80 人工闸门：节点卡「闸门待审」+ 抽屉 message「请审阅选题清单（目标 12 条）…」+ 批准继续/驳回重跑/中止/直接入库四操作；
  - B5 模板画布 21 节点全 idle 无运行徽标 + 启动运行按钮 enabled + 项目下拉默认「m8-实弹验收」；B6 设计态抽屉 script_review（闸门 required / 依赖 write_script / 条件 `input.with_deep_review == true`）；
  - B7 空态 8 个最近运行 chips + 11 个模板 chips；B8 chip 跳转 article-clip 9 节点；B9 Templates 页「画布」按钮 → `/canvas?template=mengbao-episode` 21 节点；B10 运行详情 ↔ 画布往返；B11 平移/缩放/点空白清除选中/× 关抽屉保持选中；B12 无控制台错误。
  - 首轮 A 轮 15 项：14 通过（21 节点 / 74 边精确计数、图例、缩放栏、双入口往返、日志按 `[make_storyboard]` 过滤无串行、6 张截图）；A9 数据态不适用（Run 102 无 `.failed` 节点，见偏差 #2）。
- **✅ 通过**（备注：闸门「提交后 350ms 内画布变化」子项未做真实提交验证，机制同源背书——见「局限与备注」）

### #3 零漂移

- **engine 调度行为逐字等价**：diff 留痕（仅 import + 2 调用点 + 删 2 私有方法）+ probe `dag` 矩阵 18 项 + probe regression（m2a 引擎语义探针全绿）+ 全量回归 m2a·m4·m14 exit=0。
- **既有页面零变化**：`RunDetailView` +3 行（画布视图按钮）/ `TemplatesView` +6 行（画布按钮 + useRouter），均为纯新增，无既有逻辑改动。
- **✅ 通过**

### #4 文档三件

- README：状态行 + M15 能力速览（+14 行）+ M15 验收快照（8 行表）。
- roadmap：设计链接 + 红线表更新（「画布已于 M15 引入；Electron 永久不做」）+ M15 注记。
- 本文件（m15-review.md）。
- **✅ 通过**

---

## 静态与探针

- **静态**：双端 typecheck exit=0；`apps/server/package.json` 仅 +`probe:m15` 脚本（dependencies 零新增）。
- **探针 `probe:m15` 四节**：dag（真模板不变式 + 边 origin 抽样 + 12 项矩阵）；canvas-run（字段映射 / 两类边 / 操作真值矩阵 / 与 checkRepairable 双源对拍 / 宽容分支）；canvas-template（静态字段对拍 / gate 与 when 摘要 / inputsRefs / 零运行字段）；regression（m2a / m4 / m14 全绿）。
- **回归**：`probe:m2a`（引擎语义）/ `probe:m4`（批量与成本）/ `probe:m14`（平台层）全绿（exit=0）；探针既有临时目录清理提示（Windows libsql 句柄，下次运行自动清理）为既有行为。

---

## 偏差与修复记录

1. **fit 时机缺陷（实弹暴露，已修复）**：首轮 A 轮实测「初次加载为 100%，需手动点『适应』到 30%」——根因 = `CanvasBoard` 挂载时 `props.nodes` 尚空，`onMounted → fit()` 按空布局计算（zoom=1 / 100%），数据到达后无重算。修复 = `fitted` 标志 + `fitOnce()`（`watch(() => props.nodes.length)` 首次非空时补 fit）；`CanvasView.resetView()` 同步清空 `runCanvas/tplCanvas`（Board 以空数据 + key 重建，防残留上一目标图与视口）。复验（B1）自动 30% 适应。
2. **A9 断言数据态不适用（非缺陷）**：Run 102 为「服务重启中断」态——step 行卡在 running（渲染为「执行中」），无 `.failed` 节点、无重跑按钮（服务端对 `step ∉ {succeeded, failed}` 正确判定 rerun=null；中断路径应走断点续跑）。处置 = 改 Run 96（真实 failed 步 `gen_motion`，rerunAllowed=1）复验，B3 通过。
3. **B4 预期确认（非缺陷）**：RerunModal 对整体执行型步骤（无 gen_tasks 子任务）双单选 disabled + rr-note 说明——M11 既有语义，非缺陷。
4. **B1 小窗裁切（非缺陷，留档）**：812px 视口下 fit 后世界层两侧溢出约 67px（右端 #21 超窗缘 22px）。根因 = `zoom ∈ [0.3, 2.5]` 钳制：21 节点约 10 层宽 ≈3060px，0.3 缩放下 918px > 小窗视口 ~780px 必然小幅溢出；1600px 窗口（视口 ~1340px）完全适配。属 spec 既定 zoom 区间行为，不修。

---

## 局限与备注

- **socket 实时变化未做真实提交验证**：spec §5-2「gate 提交后画布 350ms 内变化」子项以机制同源背书——socket 单通道 + 350ms 防抖全量对账与 `RunDetailView` 同架构（M2/M4 已验证）；gate 端点由 M2 探针与验收背书；画布数据层刷新路径由多 run 切换（102→101→96）与入口往返实弹证明。如需完全闭环，可另起零成本模板 run（manual_ingest 单步）触发事件后立即取消——留作可选补验。
- **全部操作按钮「观察不点击」策略**：批准/驳回/确认重跑/断点续跑/取消运行/启动运行均仅验证 wiring（可用性 + 弹窗打开 + 取消），未真实提交；write 路径由既有 M2/M4/M7/M11 探针与验收背书。
- **截图证据 13 张**：首轮 6 张（`.qoder/tmp-canvas-S1-run102.png` / `S2-zoom-fit` / `S3-pan` / `S4-drawer` / `S5-back-from-detail` / `S6-run101-completed`）+ 复验 7 张（`.qoder/tmp-canvas2-S1-run102.png` / `S2-rerun-modal` / `S3-run96-failed` / `S4-run80-gate` / `S5-template-design` / `S6-empty` / `S7-from-templates`）。
- **布局规模实测**：mengbao-episode v9 共 21 步 / 74 边（sched + data），最长路径约 10 层——布局算法（最长路径松弛 + 层内 seq 堆叠居中）在大模板下无重叠、无环。

---

## 附录

- **改动清单（git status 基线，代码面）**：10 改（178+/41−）+ 7 新件
  - 服务端：`pipeline/dag.ts`（新）/ `services/canvas.ts`（新）/ `routes/canvas.ts`（新）/ `pipeline/engine.ts`（纯委托重构 −45 行）/ `app.ts`（+1 挂载）/ `package.json`（+probe:m15）
  - Web：`components/CanvasBoard.vue`（新）/ `components/CanvasDrawer.vue`（新）/ `views/CanvasView.vue`（新）/ `router.ts` / `App.vue` / `components/Icon.vue` / `lib/api.ts` / `lib/types.ts` / `views/RunDetailView.vue` / `views/TemplatesView.vue`
  - 探针：`scripts/probe-m15.ts`（新，四节 78 项）
  - 文档：`README.md`（+28 行）+ roadmap 回写 + 本 review（另行落盘于 `docs/superpowers/specs/`）
- **红线零 diff**：schema.ts / db / refs / loader / adapters / workspace 模板与提示词全部零 diff（`git status` 核查）；canvas 路由两枚全 GET（零写端点）。
- **实弹断言清单**：A 轮 15 项（14 PASS + 1 数据态不适用）；B 轮 12/12；零真实提交。
- **证据日志**：`$TEMP\m15-probe-final.log`（探针最终轮）。

---

## 验证方式（已完结）

- 静态：`pnpm --filter @acs/server typecheck` + `pnpm --filter @acs/web typecheck` → exit=0
- 探针：`pnpm --filter @acs/server probe:m15`（四节 78 项）+ 内嵌回归（m2a / m4 / m14）
- 实弹：无头浏览器 DOM 两轮（运行态 :3001 + :5174；Run 102 / 96 / 101 / 80；模板 mengbao-episode）
- 采集时间：2026-09-13（M15 P5 批次，服务运行态）
