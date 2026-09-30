# agencys-content-studio M23 评审记录（画布规模化与智能编排）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-16（**已完成**：P1–P4 全节落盘）
- 对应 spec：`2026-09-16-agencys-content-studio-m23-design.md`（§4 验收 + §6 实施）
- 判定（P1）：**批 1（虚拟化 + 基准 + 力导向）完成**——探针 `probe:m23` 36 项全绿（force 13 / serialize 6 / edit 11 / bench 6；overview·advice 节为 P2/P3 占位）；双端 typecheck 绿；浏览器 e2e 虚拟化三重断言 + 力导向落库；基准报告落本 review
- 判定（P2）：**批 2（跨 run/跨模板全景图 + 批次聚合 + 画布内编辑）完成**——探针 `probe:m23` 51 项全绿（+overview 15：批次分组排序 / 组内 seq 升序 / cost 映射 / stats 聚合 / 空项目 / inputFields 保序与只读语义）；web typecheck 绿；浏览器 e2e 场景 A（全景）7 断言 + 场景 B（编辑）11 断言全过
- 判定（P3）：**批 3（设计态编排 E4 + LLM 建议 D11）完成**——探针 `probe:m23` 92 项全绿（serialize 6→13 / edit 11→27 / +advice 18）；浏览器 E2E-1（拖拽连线·删边·草案·落盘 fs 对照）与 E2E-2（AI 建议实弹 + 定位）全过
- 判定（P4）：**全量收口完成**——92 项探针 + 双端 typecheck + 全量回归 19 探针全绿（收口期 m18 修复见「偏差与修复记录（P4-a）」）+ 测试产物零残留；review 全节落盘 + roadmap 校准
- 证据采集方式：`probe:m23`（内存临时库 `acs-probe-*`，零网络零计费）+ 真实开发库实弹（:3001 + :5174，临时项目「M23 虚拟化实弹」/「M23 基准实弹」）+ browser-use MCP（页面内 fetch 打点 + 2×rAF 可见时刻 + DOM 计数 + `performance.memory`）

---

## 结论摘要（P1）

- **虚拟化三重断言全过**（300 节点画布）：初始 DOM `.cnode`=42（≪300，裁剪生效）→「适应视图」后 =300（全量可见时无过度裁剪）→ 力导向重排后 =157（渲染集随坐标变化即时收敛）。
- **力导向交付**：`computeArrange` 第三模式（d3-force 确定性迭代：固定初始坐标 + 固定 tick 300 + 无随机源）；工具栏「力导向」按钮实弹——300 节点全量重排 + 坐标落库 + toast 原文 + 零控制台错误。
- **基准（服务端）**：`buildCanvasDoc` 二次调用 300/600/1000 → **8.2 / 17.4 / 25.1 ms**（同日首测 6.3 / 14.1 / 21.4 ms，机器波动参考）。
- **基准（浏览器）**：切换画布 fetch 17.2 / 32.2 / 35.4 ms；可见耗时（2×rAF）176.4 / 218.6 / 272.5 ms；DOM 恒 42（≪ 总量，裁剪生效）；平移 10 帧稳态 ~17.5 ms/帧（对齐 60Hz 节拍）；heap 20.6 MB（1000 画布）；冷导航 1000 画布 DCL 84.5 / loadEnd 87 / 文档 fetch 280.8 ms。
- **清理纪律**：临时项目（虚拟化实弹 / 基准实弹）报告后 purge；种子脚本留档供 P4 复跑。

## 结论摘要（P2）

- **全景图（E1）+ 批次聚合（E2）交付**：`GET /canvas/overview` 单次聚合「批次头（toBatchView 同构）+ 组内 runs（batchSeq 升序）+ 独立 runs + stats（runCount/byStatus/totalCost）」；画布页新增「全景」tab（`?overview=1`）：批次组卡（进度条 + RunCard 网格）+ 独立组 + 空态。
- **e2e 实弹双场景全过**：场景 A（项目 4 = m3-验收-图文笔记：20 runs / 5 批次 / 独立 8 / ¥0.4601；6 组渲染顺序与计数、批内 # 序号升序、失败 run error 行、run 卡与批次头双钻取）；场景 B（编辑全链：进/退编辑、抽屉编辑区、画布即时刷新、覆盖最小化、空标题红框、脏确认三路径）。
- **画布内编辑（E3）交付**：`use-canvas-edit` 组合式（覆盖最小化）+ drawer 编辑区（标题 + inputFields 可编辑/只读）；脏确认仅作用于「退出编辑 / 重置修改」，切换画布目标静默重置草稿（防跨目标脏串扰）。
- **inputFields 读模型**：`buildTemplateCanvas` 每节点透出顶层字段（string 可编辑原值 / 非 string 只读 JSON 截断预览），与 P3 的 `edits.steps[]` 提交结构对齐（本地草稿 → P3 才落传输）。

## 结论摘要（P3）

- **设计态编排（E4）交付**：`POST /templates/:key/edit-draft`（edits 白名单 → `applyTemplateEdits` → `serializeTemplate` → YAML 草案 + validation；不落盘）+ `POST /templates/:key/edit-save`（校验先于写入、key 缺省 `<原key>-edit`、冲突自动后缀避让、原文件零触碰）；编辑面 = 调度依赖（拖拽连线 / 删边）+ 标题/字符串输入字段；`data` 边与节点增删排除（spec §8）。
- **E2E-1 落盘对照实弹全过**：真实库 series-setup 模板——拖拽 recall→remember（新边 `M 300 248 C 630 248, 630 388, 960 388`）/ 点选删边（ingest→write_series，15→14）/ 反向拖拽拒绝（toast「仅支持前→后依赖：「remember」不是「recall」的前置步骤」）/ 草案 YAML 精确（`write_series.after=[recall]`、`remember.after=[write_series, recall]`）/ 保存新模板后 **原文件 SHA256 4A18DD21… 零变化**、新文件 4949B 经 API/下拉/画布全链加载（12 节点 14 边逐条对应）。
- **LLM 建议（D11）交付**：`POST /canvases/:id/advice`（确定性摘要 `buildCanvasSummary` + `canvas-advice.md` 提示词 + `chatCompleteDetailed` 用量留痕 + `parseAdviceOutput` 归一/降级 raw）；前端 `CanvasAdviceModal`（列表 + 定位 + 用量栏；仅展示不执行）。
- **E2E-2 建议实弹全过**：真实 LLM 通道 7 条结构化建议（kind：配置/连线/生成/清理/结构，引用真实节点 #10/#12/#13/#19/#29）+ usage「deepseek_llm/deepseek-flash · 1477↑ 2599↓ · 结构化」+ 定位（关面板 → 选中「图片 #12」→ 视口重居中）。
- **清理纪律**：e2e 测试模板 `series-setup-e2e.yaml` 报告后删除（模板目录 11 个恢复原状）；探针临时库 `acs-probe-*` 机制自清理。

---

## 验收逐条对照（spec §4；全量 #1–#8）

### #1 虚拟化 ✅

- **操作**：真实库实弹（300 节点 / 120 边画布）+ 浏览器 DOM 断言；基准 300/600/1000 三档。
- **证据**：
  - 三态 DOM 断言：42（初始）→ 300（适应视图）→ 157（力导向后）——`document.querySelectorAll('.cnode').length`
  - 平移 10 帧 `[8.8, 3.8, 9.3, 17.4, 17.2, 17.9, 17.6, 17.8, 17.3, 17.5]`（前两帧含合成开销；稳态 ~17.5 ms）
  - 对照口径（spec §2.2-B：临时关裁剪不可行）→ 以「DOM 数 ≪ 总量」为裁剪生效证据（1000 画布 DOM=42）
  - 基准报告见下节
- **✅ 通过**

### #2 力导向 ✅

- **操作**：probe force 节 13 项 + e2e 按钮实弹。
- **证据**：
  - 探针 13 项：三节点全量出坐标 / 无 NaN / round 取整 / 确定性（×2 等值）/ 锚定 (0,0) / 分离度 327>100 / 单节点不动 / 空集空 Map / 两点无边分离 725 / 偏移锚定 (1000,2000) / 幽灵边过滤（等价 clean12）/ layered 零漂移 / grid 零漂移
  - e2e：点击「力导向」→ 节点 #81 坐标落库 (0,0)→(660,683) + toast「力导向排列：更新 300 个节点」+ 零控制台错误
  - 截图：`.qoder/tmp-m23-e2e-fit300.png` / `.qoder/tmp-m23-e2e-force300.png`
- **✅ 通过**

### #3 全景图 ✅

- **操作**：真实库实弹——画布页「全景」tab 对项目 4（m3-验收-图文笔记）全量渲染；探针 overview 节聚合断言。
- **证据**：
  - 切 tab → `?overview=1`；项目 14 小样本（2 runs / 0 批次 / ¥0.10134）与项目 4 大样本（20 runs / 5 批次 / 独立 8 / ¥0.4601）均正确
  - 渲染顺序：批次组 createdAt desc（5 组）→ 独立组；组头「批次ID · N 条 · 状态」+ 进度条；独立组不计序号
  - 切项目选择器即时重拉（14 → 4 切换后 6 组全量刷新）
- **✅ 通过**

### #4 批次聚合 ✅

- **操作**：探针 overview 节 15 项 + e2e 卡细节断言。
- **证据**：
  - 探针：批次分组/排序/组内 batchSeq 升序/toBatchView 同构/cost 映射（0.75+1.25）/无 usage → null/templateVersion 快照解析/stats 四键/空项目全空/项目不存在 404
  - e2e：#53 批内 #1（升序成立）、#54 失败 + error 行展示、chips「已完成 16 / 失败 1 / 已取消 3」+「总成本 ¥0.4601」与探针口径一致
  - 双钻取：run 卡 → `?run=53`（切运行画布 + 画布渲染）；批次头 → `/batches/5`
- **✅ 通过**

### #5 画布内编辑 ✅

- **操作**：真实库实弹（note-clip 模板全链）+ 编辑模式 11 段断言。
- **证据**：
  - 进编辑 →「编辑中」徽标 + 重置/退出控件；节点「多平台适配」→ drawer 编辑区（草稿徽标 + 标题 + 3 可编辑字段 + protect_facts 只读 JSON）
  - 改标题 → 画布节点即时更新 +「有未保存修改（1 步）」+ 节点 dot；改字段 → dot；**改回原值 → dot 消失（覆盖最小化）**
  - 清空标题 → 红框 +「标题不能为空」+ 脏保留（不入非法态）
  - 退出编辑（脏）→ 确认弹窗（「退出并丢弃」danger）→ 取消仍在编辑 / 确认后退出且标题恢复「多平台适配」；无脏退出不弹窗
  - 重置修改 → 确认弹窗（「将丢弃 1 个步骤的编辑草稿」）→ 确认后脏清空、仍保持编辑模式、输入与画布双恢复
  - 切「全景」tab → 无弹窗静默清草稿；切回「模板画布」（article-clip）编辑模式已退出、零脏
- **✅ 通过**

### #6 设计态编排 ✅

- **操作**：探针 serialize 13 + edit 27 项 + E2E-1 实弹（真实库 :3001 + :5174 + browser-use MCP）。
- **证据**：
  - 编辑模式：点「编辑」→ 12 个输出端口渲染 + 编辑提示条；拖拽 recall→remember 新边 `M 300 248 C 630 248, 630 388, 960 388`（临时线中间态 + 落点高亮均现）；点选 sched 边（`.sel`）+ Del 删除 15→14；反向拖拽（remember→recall）拒绝 toast 原文
  - 草案：badge「校验通过」+ YAML 逐点核对（`write_series.after=[recall]`、`remember.after=[write_series, recall]`，其余步骤等价）
  - 落盘：`series-setup.yaml` SHA256 `4A18DD21…` **零变化**；新文件 `series-setup-e2e.yaml` 4949B；`GET /templates` + 画布页下拉（13 项）可见；新模板画布渲染 12 节点 14 边逐条对应新文件依赖
- **✅ 通过**

### #7 LLM 建议 ✅

- **操作**：探针 advice 节 18 项 + E2E-2 实弹（真实 LLM 通道）。
- **证据**：7 条结构化建议（kind：配置/连线/生成/清理/结构，引用真实节点 #10/#12/#13/#19/#29）+ usage「deepseek_llm/deepseek-flash · 用量 1477↑ 2599↓ · 结构化」；「定位」→ 关面板 + 选中「图片 #12」（`.cnode.sel`=1）+ 视口重居中（`.cb-world` transform 刷新）。
- 降级路径（`llm_unavailable` → 400）未实弹（实弹期 LLM 可用），服务端语义由探针覆盖。
- **✅ 通过**

### #8 工程项（全量）✅

- **探针**：`probe:m23` **92 项全绿**（force 13 / serialize 13 / edit 27 / overview 15 / advice 18 / bench 6；2026-09-16 复跑）。
- **类型**：server `tsc` / web `vue-tsc` 双端 exit=0。
- **回归**：全量 19 探针（m2a–m22）全绿——收口期 m18 1 FAIL 的定性与修复见「偏差与修复记录（P4-a）」（修复后 m18 248 / m22 169 复跑全绿，**探针零适配**）。
- **三层实弹**：service 探针 → 真实库 API → 浏览器 e2e（P1–P3 均完成；E2E-1 含 fs SHA256 对照）。
- **文档**：本 review 全节落盘；roadmap M23 注记校准完成。
- **✅ 通过（全量）**

---

## 基准报告（spec §2.2-B 要求落 review）

### 服务端构建（`probe:m23` bench 节，隔离临时库）

| N | 种子构成 | buildCanvasDoc 二次调用（ms） |
|---|---|---|
| 300 | 60% gen / 30% text / 10% asset + 链式边（240 边） | 8.2（同日首测 6.3） |
| 600 | 同上（480 边） | 17.4（同日首测 14.1） |
| 1000 | 同上（800 边） | 25.1（同日首测 21.4） |

口径：脚本种子 → 预热一次 → 二次调用计时（含 spec 解析 / 任务查询 / 输入规划全链）。数值仅报告不设硬阈值（spec §2.2-B：机器环境差异）。

### 浏览器（真实库实弹，临时项目「M23 基准实弹」）

| N | 边 | 切换 fetch responseEnd（ms） | 可见耗时 2×rAF（ms） | DOM `.cnode` |
|---|---|---|---|---|
| 300 | 120 | 17.2 | 176.4 | 42 |
| 600 | 240 | 32.2 | 218.6 | 42 |
| 1000 | 400 | 35.4 | 272.5 | 42 |

- 平移 10 帧（1000 画布）：`[8.8, 3.8, 9.3, 17.4, 17.2, 17.9, 17.6, 17.8, 17.3, 17.5]`（稳态 ~17.5 ms/帧）
- 内存：`performance.memory.usedJSHeapSize` = 20.6 MB（1000 画布）；平移后 DOM=36
- 冷导航（1000 画布）：DCL 84.5 ms / loadEnd 87 ms / 画布文档 fetch responseEnd 280.8 ms
- 量测口径：页面内 fetch 打点（匹配画布文档请求 responseEnd）+ 2×rAF 可见时刻 + `querySelectorAll` 计数

---

## 静态与探针（P1）

- **变更面（P0+P1）**：
  - server：`package.json`（+d3-force / +@types/d3-force / probe:m23 注册）；`src/services/creation/ops.ts`（force 分支 + `FORCE_TICKS=300`）；`src/pipeline/template-edit.ts`（新增：`serializeTemplate` + `applyTemplateEdits` + 物化/加边/删边纯函数）；`scripts/probe-m23.ts`（新增）
  - web（5 文件）：`lib/board-viewport.ts`（viewW/viewH + ResizeObserver 跟踪）；`components/creation/board/index.vue`（`VIEW_MARGIN=0.5` + `visibleWorld` + `renderNodes`/`edgePaths` 裁剪）；`views/creation/use-canvas-batch.ts`（force 文案）；`lib/types/creation-canvas.ts`（`CanvasArrangeMode` + `'force'`）；`views/creation/CanvasToolbar.vue`（「力导向」按钮）
- **探针明细**：force 13 / serialize 6 / edit 11 / bench 6 = **36 项全绿**（2026-09-16 复跑，overview / advice 节为 P2/P3 占位）
- **红线守住**：layered/grid 快照零漂移（既有布局行为逐位一致——「确定性 + 分离度」断言口径，spec §5）；虚拟化纯前端（服务端零改动）；force 为新增模式（既有模式分支未动）
- **全量回归**（m2a–m22 零适配）与 P2–P4 一并执行

## 静态与探针（P2）

- **变更面（P2）**：
  - server：`services/canvas-overview.ts`（新增：buildCanvasOverview 聚合）；`routes/canvas.ts`（+GET /canvas/overview，?project_id 必填、项目缺失 404）；`services/batch.ts`（toBatchView 抽取导出，routes/batches 复用零行为变化）；`services/creation/canvas.ts`（buildTemplateCanvas 每节点 + inputFields）；`scripts/probe-m23.ts`（+overview 节 15 项）
  - web（7 文件）：`lib/types/pipeline-canvas.ts`（+InputFieldView/inputFields + 全景读模型 + 编辑视图模型）；`lib/api.ts`（+canvasApi.overview）；`views/canvas/use-canvas-edit.ts`（新增：覆盖最小化草稿）；`components/pipeline-canvas/overview/index.vue`（新增：stats + 批次组 + 独立组 + 空态）；`components/pipeline-canvas/overview/run-card.vue`（新增：RunCard）；`components/pipeline-canvas/drawer/index.vue`（+编辑区 section + edit 事件）；`views/canvas/index.vue`（三态 tab 集成 + 编辑控件 + 脏确认 + 静默重置）
- **探针明细**：overview 15 项（批次分组 / 排序 / 组内 seq / 同构回读 / 独立 runs / cost 映射×2 / templateVersion / stats×3 / 空项目 / 404 / inputFields×2）——全量 51 项绿（2026-09-16 复跑）
- **边界交互**：脏确认仅顶栏出口（退出编辑 / 重置修改）；切换画布目标（tab / 模板 / 项目）静默重置草稿
- **架构决策**：编辑视图模型（StepOverride/EditFieldState/EditNodeState）落 `lib/types` 共享层——drawer 组件不反向引用 views 目录

## 偏差与修复记录（P1）

| # | 来源 | 问题 | 修复 | 复验 |
|---|---|---|---|---|
| a | P1 typecheck | web 报 `TS2688 vite/client`：pnpm 虚拟店 peer-hash 变化后 `apps/web/node_modules/vite` 符号链接残留旧路径 | `pnpm install` 重链 | 双端 typecheck 绿 |
| b | P1 探针 | 「幽灵边过滤」断言对比基准取错（对比对象含两条合法边） | 改为与「仅合法边 {1→2}」运行（clean12）对比 | 36 项全绿 |
| c | P1 e2e 脚本 | 种子脚本 `POST /projects` 返回包裹体 `{project}` 未解构 | 解构 `.project` | 种子成功、e2e 通过 |

## 偏差与修复记录（P2）

| # | 来源 | 问题 | 修复 | 复验 |
|---|---|---|---|---|
| a | P2 e2e 采集 | 浏览器窗口不可见 → `take_screenshot` 报 NATIVE_BROWSER_VIEWPORT_UNAVAILABLE | 改用 `take_snapshot`（a11y 树）+ `evaluate_script`（DOM 结构断言）替代视觉截图 | 场景 A/B 全部断言通过 |
| b | P2 e2e 采集 | `fill` 对 `<select>`（项目选择器）超时 5s | 改用 `evaluate_script` 原生 value setter + `change` 事件 | 项目 14 → 4 切换成功 |

## 局限与备注（P1）

- 服务端 bench 仅报告不设硬阈值（spec §2.2-B）；浏览器数值为单机开发环境采录（非硬阈值断言）。
- 力导向无实时预览动画（spec §8 明确排除；一次点击全量重排，可撤销）。
- 虚拟化下连线落点天然限于可见区（spec §2.2 保真约束，登记备注意）。
- 探针临时目录句柄在 Windows 下可能延迟清理（既有机制：下次运行自动清理）。

## 局限与备注（P2）

- 编辑为**本地内存草稿**：不落盘、不提交、不触发运行；退出编辑 / 重置修改 / 切换画布目标即丢弃（提交链路属 P3 E4）。
- 编辑粒度：标题 + 顶层 string 输入字段；非 string 字段只读 JSON 预览（截断 400 字符）。
- 全景页状态 chips 固定顺序（running → completed → failed → cancelled，spec 约定），不随实际状态子集变化。
- 空标题（红框态）计入脏计数，「退出并丢弃」亦会丢弃该非法态（仅内存，无持久化风险）。

## 验证方式（P1，已完结）

- 复跑：`pnpm --filter @acs/server probe:m23`（36 项，2026-09-16 全绿）
- 静态：server `npx tsc --noEmit` / web `npx vue-tsc --noEmit`（双端 exit=0）
- 实弹留档：`.qoder/tmp-m23-e2e-seed.mjs`（虚拟化 e2e 种子）/ `.qoder/tmp-m23-bench-seed.mjs`（浏览器基准种子）
- 临时项目 purge：已清理——15（300 节点 / 120 边 / 1 画布）、16（1900 节点 / 760 边 / 3 画布），`DELETE /projects/:id?purge=1` 响应 `mode:"purged"` 留痕

## 验证方式（P2，已完结）

- 复跑：`pnpm --filter @acs/server probe:m23`（51 项，2026-09-16 全绿）
- 静态：web `npx vue-tsc --noEmit` exit=0（服务端本批变更随后续全量回归复核）
- 实弹：真实开发库（:3001 + :5174）+ browser-use MCP——场景 A 全景 7 断言 / 场景 B 编辑 11 断言（全程 `evaluate_script` DOM 断言；截图采集限制见偏差 a）
- 数据口径：项目 4 全量 20 runs 与探针 stats 口径一致（byStatus 16/1/3 + totalCost ¥0.4601）

---

## 静态与探针（P3）

- **变更面（P3）**：
  - server：`src/pipeline/template-edit.ts`（P0 骨架实装：`serializeTemplate` 序列化往返 / `applyTemplateEdits` 白名单应用 / 物化·加边·删边纯函数）；`services/creation/advice.ts`（新增：`buildCanvasSummary` / `canvasAdvice` / `parseAdviceOutput`）；`routes/templates.ts`（+edit-draft / +edit-save）；`routes/creation.ts`（+`POST /canvases/:id/advice`）；`workspace/prompts/canvas-advice.md`（新增提示词）；`scripts/probe-m23.ts`（serialize 6→13 / edit 11→27 / +advice 18）
  - web：`components/pipeline-canvas/CanvasBoard.vue`（编辑模式：输出口拖拽连线·落点高亮·sched 边点选/Del 删除）；`views/canvas/use-canvas-edit.ts`（连线/删边/草案态扩展）；`views/canvas/index.vue`（草案/保存 modal + toast 接线）；新件 `views/creation/use-canvas-advice.ts` + `views/creation/CanvasAdviceModal.vue`（建议面板）；`lib/api.ts`（+editDraft/editSave/advice）；`lib/types/pipeline-canvas.ts`（建议读模型）
- **探针明细**：92 项全绿（force 13 / serialize 13 / edit 27 / overview 15 / advice 18 / bench 6）——P3 增量 41 项（serialize +7 / edit +16 / advice 18）
- **边界语义**：edits 白名单服务端校验（不信任前端）；key 冲突后缀避让（-2/-3…）；物化把「缺省依赖」转显式 after（导出可见可改）；建议解析宽容降级（围栏剥离失败 → raw 单条，不炸）

## 偏差与修复记录（P3）

| # | 来源 | 问题 | 修复 | 复验 |
|---|---|---|---|---|
| a | P3 e2e 采集 | 跨调用视口漂移：外部输入（滚轮/触控板）使画布 zoom 1→0.767（= `exp(-222×0.0012)` 精确吻合 applyZoom 公式），拖拽 up 落点错位命中邻卡（**伪缺陷**；MutationObserver 静置 14s transform 零变化，排除 fit 干扰） | 测试方法修正：pointerdown/move/up 同调用一次性派发 + 调用内实时读 getBoundingClientRect 动态坐标 | 重跑全过（新边正确指向 remember） |
| b | P3 e2e 采集 | 保存成功 toast 未捕获（2.8s 窗口过期） | 保存结果改由 fs SHA256 对照 + API/下拉加载双重验证；toast 通道由拒绝路径（反向拖拽）证明正常 | 落盘对照全过 |

## 局限与备注（P3）

- 草案/保存仅落**新 key**（原模板零触碰）；不含节点增删 / action·key 修改 / when·gate·batch 编辑（spec §8）。
- `data` 边编辑排除；物化后的显式 after 在导出 YAML 中可见（用户可手工改回）。
- LLM 建议**仅展示 + 定位，不执行**（建议式红线）；`llm_unavailable` 降级路径未实弹（实弹期 LLM 可用），服务端语义由探针覆盖。
- 虚拟化下连线落点天然限于可见区（P1 已登记）。

## 验证方式（P3，已完结）

- E2E-1（2026-09-16，真实库 :3001 + :5174 + browser-use）：编辑模式 12 端口 / 拖拽连线 / 删边 15→14 / 草案校验 badge + YAML 核对 / 保存 series-setup-e2e / **原文件 SHA256 零变化** / 新模板 API+下拉+画布全链可见 / 拒绝路径 toast 原文
- E2E-2（同日，真实 LLM 通道）：7 条结构化建议 + usage 栏 + 定位（关面板/选中 #12/视口重居中）
- 清理：`series-setup-e2e.yaml` 已删除（模板目录 11 个恢复原状）

## 偏差与修复记录（P4）

| # | 来源 | 问题 | 修复 | 复验 |
|---|---|---|---|---|
| a | 全量回归 m18 | **1 FAIL**：`custom：time=99 → clamp 1.95 + 显式坐标生效`——`POST /nodes/1/extract-frame` 400（`ENOENT … .tmp.jpg -> …jpg`）。定性：**环境侧 ffmpeg 解析翻转**（M23 P0/P1 期 `pnpm install`〔d3-force 安装 + peer-hash 重链〕后，`resolveFfmpeg()` 由系统回退态翻转回内置 `ffmpeg-static@5.3.0` 6.1.1）暴露 **M18 潜伏分类缺陷**——6.1.1 在 seek 超出可用帧时 exit=0 且静默无产物（对照系统 WinGet ffmpeg 9.0.1-full：exit=-22 +「Nothing was written」），该分支被归类 `retryable=false` → `FRAME_SEEK_BACKOFFS`（1.95→1.85）降级失效。历史 m28（09-15）与 m22（09-16 14:12）探针日志均走「寻址降级 1.95→1.85」路径（彼时解析回退到系统 9.0.1）为直接对照 | `frame.ts` 最小修复：`runFrameExtractOnce` close(code=0) 分支显式判别 `!existsSync(tmp)` → 可重试的「无帧可取」语义（真实 tmp 上的 rename fs 错误保持不可重试）；同步修正 `extractVideoFrame` 注释 | m18 **248 全绿**（降级日志「请求 1.95s 无帧可取 → 实际取 1.85s」留存）+ m22 169 全绿 + server `tsc` exit=0；**探针零适配** |

## 局限与备注（P4）

- m18 修复属**跨里程碑最小修复**（M18 抽帧回退分类；触发面 = M23 P0/P1 依赖安装引起的 ffmpeg 解析翻转），已在上表逐字留痕；不同 ffmpeg 版本对该场景的退出码差异（6.x exit=0 / 9.x 非零）表明修复对两代二进制均正确（统一走降级）。
- 回归口径：m2a–m22 共 19 探针；m18/m22 在修复后复跑（248 / 169 全绿），其余 17 项与首轮全绿一致（零改动）。

## 验证方式（P4，已完结）

- 探针：`probe:m23` 92 项全绿（2026-09-16 复跑，bench 300/600/1000 = 8.6 / 16.0 / 27.4 ms）；`probe:m18` 248 全绿 / `probe:m22` 169 全绿（日志留档 `.qoder/tmp-m23-p4-m18.log`、`.qoder/tmp-m23-p4-m22.log`）
- 静态：server `npx tsc --noEmit` exit=0 / web `npx vue-tsc --noEmit` exit=0
- 产物清理：e2e 模板文件删除、探针临时库自清理、开发库零残留
- 文档：本 review 全节落盘 + roadmap M23 注记校准

---

（全文完：P1–P4 全节落盘；spec §4 验收 #1–#8 全部通过。）
