# agencys-content-studio M23 设计文档（画布规模化与智能编排）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-16
- 对应纲领：`2026-09-14-agencys-content-studio-m19-m27-charter.md` §三 M23 立项卡（7 项）与 §一 D9–D11 + E1–E4 缺口项
- 决策留痕（2026-09-16 用户拍板四项）：
  1. **规模化性能 = 虚拟化 + 自动化基准**：视口裁剪渲染 + 脚本生成 300/600/1000 节点画布量测（渲染耗时/内存/DOM 规模），基准报告落 review
  2. **力导向 = 引入 d3-force 轻量库**：破「零新依赖」惯例，本 spec §5 专项论证（成熟纯算法库例外原则）
  3. **全景图/批次聚合 = 画布页新增「全景」tab**：运行画布 / 模板画布 / 全景三态；批次作为分组维度，点击钻取单 run 画布
  4. **画布写面 = 允许落盘新模板文件**：设计态编辑 → 保存为新模板 key（不覆盖原文件；冲突自动避让）
- 前置：M15 ✅ / M16–M18 ✅（画布基建）· M19 ✅ / M28 ✅ / M20 ✅ / M21 ✅ / M22 ✅（2026-09-16 收官）
- 纪律：同一时间只存在一个 L1 详细 spec（校准规则 3）；本轮仅 M23。§6 实施批次内逐批 typecheck + 探针 + 实弹。

---

## §1 背景与目标

### 1.1 现状（勘察结论，2026-09-16）

| 项 | 现状 | 缺口本质 |
|---|---|---|
| ① 规模化性能（D10） | 创作画布 board 全量渲染（`board/index.vue` `renderNodes`/`renderGroups` computed 全量；nodeHeights ResizeObserver 式实测；边全量 SVG）；无任何基准 | 视口裁剪渲染 + 定量基准报告 |
| ② 力导向（D9） | `computeArrange` 纯函数（`ops.ts`：layered/grid/align/distribute，探针直测先例）+ `use-canvas-batch.arrangeAll` + 工具栏双按钮；**无 force 模式** | 布局第三模式（d3-force）+ 前端入口 |
| ③ 全景图（E1） | M15 画布 = 单 run（`buildRunCanvas`）/ 单模板（`buildTemplateCanvas`）；画布页顶栏下拉切换单个目标 | 项目级多 run 聚合读模型 + 视图 |
| ④ 批次聚合（E2） | `batches` 单表（total/finished/succeeded/failed 计数在位）+ `GET /batches/:id`（runs 摘要含成本，`summarizeBatch` usage 聚合）；无画布侧聚合视图 | 批次分组聚合视图 |
| ⑤ 画布内编辑（E3） | M15 画布纯读（原设计原则「纯读」红线）；抽屉只读展示（inputsRefs / inputJson） | 受限写（编辑提示词/文本字段，经草案通道落盘新模板） |
| ⑥ 设计态编排（E4） | M18 template-draft 先例（`draft.ts`：画布→YAML 草案 + validation + lossy，不落盘；template-try 自动保存 `<画布名>-try` + key 后缀避让）；M15 模板画布纯渲染无编辑 | 模板画布上编辑依赖（拖拽连线）→ YAML 草案 / 落盘新模板 |
| ⑦ LLM 建议式编排（D11） | 确定性规则已落（readiness 预检 problems/notes、draft validation、批量执行就绪过滤）；LLM 通道在位（`chatCompleteDetailed` / `loadPromptTemplate` / 用量留痕先例） | 画布建议式（规则摘要 + LLM 建议，不自动执行） |

### 1.2 目标

1. **规模化性能**：创作画布视口裁剪渲染（视口外节点/边不渲染）；300/600/1000 节点画布自动化基准（服务端构建耗时 + 浏览器渲染量测），报告落 review
2. **力导向布局**：`computeArrange` 新增 `force` 模式（d3-force 确定性迭代：固定初始位置 + 固定 tick 数），工具栏第三布局入口
3. **跨 run/跨模板全景图**：画布页「全景」tab——项目内全部 run 的聚合卡片矩阵（状态/模板/耗时/成本），批次为分组维度，钻取单 run 画布
4. **批次聚合视图**：全景内批次头卡（进度 total/finished/succeeded/failed + 状态）+ 组内 runs，等价 `GET /batches/:id` 语义的只读聚合
5. **画布内编辑（受限写）**：模板画布编辑模式——节点 title + inputs 字符串字段可编辑；运行画布保持纯读
6. **设计态编排**：模板画布拖拽连线编辑调度依赖（after 物化语义、前→后约束）→ 导出 YAML 草案（不落盘）呼「保存为新模板」（落盘 workspace/templates，新 key 不覆盖）
7. **LLM 建议式编排**：创作画布「AI 建议」——服务端确定性摘要 + LLM 输出结构化建议（仅展示 + 定位，不自动执行；显式单次触发 + 用量留痕）

---

## §2 范围

### 2.1 总览与批次

| 批次 | 内容 | 性质 |
|---|---|---|
| **批 1** | ① 规模化性能（虚拟化 + 基准）· ② 力导向（d3-force） | 前端渲染优化 + 1 枚布局模式 |
| **批 2** | ③ 全景图 · ④ 批次聚合（画布页全景 tab）· ⑤ 画布内编辑 | 聚合读模型 + 受限写 |
| **批 3** | ⑥ 设计态编排（拖拽连线 → 草案/落盘）· ⑦ LLM 建议式编排 | 受控写 + LLM 建议式 |

发号规则：本轮新增端点 **4 枚**（§3）；新增依赖 **2 个**（server `d3-force` + dev `@types/d3-force`）；**无新表 / 无新列**；PROMPTS_DIR 新增 **1 个提示词文件**（`canvas-advice.md`）；前端新增组件 2 个（全景面板 / 模板编辑层）。

### 2.2 ① 规模化性能（D10，批 1）

**A. 视口裁剪渲染**（`board/index.vue`，纯前端）：

- 可见世界矩形：视口 `(clientW, clientH) + pan/zoom` → 世界坐标矩形 + 外扩 `VIEW_MARGIN = 0.5`（半屏，防拖动闪烁）
- `renderNodes`：`props.nodes` → 排除折叠隐藏（既有 `hiddenNodeIds`）→ 与可见矩形相交（节点矩形 = `nodeXY + NODE_W × nodeH`）
- `renderGroups`：组框不裁剪（数量级小，保留既有渲染序）——渲染集仅节点/边裁剪
- `EdgeLayer` 边集：两端任一可见即渲染（边几何依赖两端锚点；单端裁剪会造成边截断闪烁，故「任一端可见」全渲染）
- **保真约束**：
  - 框选 / Ctrl+A / 方向键 / 键盘删除：仍基于 `props.nodes` 全量几何判定（纯计算，不变）；框选矩形在视口内，视口外节点自然不命中
  - 不可见节点无 ResizeObserver 实测高度 → `nodeH` 兜底 `DEFAULT_H`（既有机制）；滚入视口后实测回填
  - 连线目标必须在可见区（`document.elementFromPoint` 天然约束，不可见节点无法作为落点——符合直觉，登记备注意）
- 渲染集计算为组件内 computed（依赖 `pan/zoom/nodes/groups`）；不引入虚拟列表库（零依赖）

**B. 自动化基准**（对齐纲领验收方向「节点数 × 帧率 / 内存」）：

- **服务端节**（probe-m23 bench 节）：脚本建 300/600/1000 节点画布（内存库）→ 量测 `buildCanvasDoc` 构建耗时（ms），记录报告（限定性断言：三次均成功 + 耗时有限；数值仅报告不设硬阈值——机器环境差异）
- **浏览器节**（e2e 实弹 + 基准脚本）：
  - seed：`.qoder/tmp-m23-bench-seed.mjs` 经真实库 API 建 300/600/1000 节点基准画布（临时项目，报告后 purge 清理）
  - 量测（`evaluate_script` + `performance.now`）：首渲染耗时（导航 → 画布可见）、渲染 DOM 节点数（`querySelectorAll` 计数）、平移 10 帧耗时、`performance.memory`（如可用）
  - 对照：虚拟化前（对同一基准画布临时关裁剪不可行——改为记录「DOM 节点数 ≪ 总量」作为裁剪生效证据）
- 报告落 review（表格：N × 服务端构建 ms / 首渲染 ms / DOM 数 / 内存）

### 2.3 ② 力导向布局（D9，批 1）

**引入 d3-force**（server `dependencies` + `@types/d3-force` devDeps；论证见 §5）：

- `computeArrange` 新增 `mode: 'force'`（`ARRANGE_MODES` 扩展；`arrangeNodes` / 端点 / `arrangeAll` 前端链路复用现成）：
  - 输入：目标节点集（`id/x/y` + 边集）；节点尺寸用常量 `NODE_W=220 × DEFAULT_H`（服务端不持有实测高度——对齐 layered 常量间距先例）
  - 确定性迭代：`forceSimulation(nodes)` 注入现有坐标 → `forceLink(edges).distance(320)` + `forceManyBody().strength(-900)` + `forceCollide(140)` + `forceCenter(0,0)` → `simulation.stop()` 后手动 `tick(FORCE_TICKS=300)` → 输出坐标 round；**无随机源，同输入同输出**（探针直测）
  - 锚定：结果整体平移，使包围盒左上角 ≈ 原目标集包围盒左上角（对齐 layered/grid「锚 = 包围盒左上」）
  - 边界：`nodes.length === 0` → 空 Map；单节点 → 原坐标不动；两点无边 → 按 collide 分离
- 前端：`CanvasToolbar` 整理菜单加「力导向排列」（`cv.arrangeAll('force')`）；`use-canvas-batch.ts` mode 文案（『力导向排列』）与类型扩展
- 交互说明：一次点击全量重排（与 layered/grid 同语义，可撤销）

### 2.4 ③ 跨 run/跨模板全景图 + ④ 批次聚合（E1/E2，批 2）

**形态**：画布页第三 tab「全景」（`views/canvas/index.vue`：run / template / overview 三态；`?overview=1` 路由标记；项目选择器本地状态，默认第一项目）。

**读模型**（新端点 `GET /canvas/overview?project_id=`，1 枚——服务端一次聚合，避免前端 N+1）：

- `batches`：`toBatchView` 同构（id/name/status/templateKey/进度计数 schedule/时间内）——批次头卡数据
- `batches[].runs`：该批 runs（batchSeq 序；含 `cost`（usage 聚合，复用 `summarizeBatch` 同口径）、status/error/耗时/input 摘要）
- `standaloneRuns`：无批次归属 runs（同字段）
- `stats`：项目级 run 计数（按状态）+ 总成本（页头汇总）

**视图**：

- 批次分组：批次头卡（名称/状态徽章/进度条 finished/total/成功失败计数/模板）+ 组内 run 卡片行；批次头点击 → 既有批次详情页深链
- 独立 runs 组：无批次 run 卡片（含从画布 template-try 建的 run）
- run 卡片：状态徽章 / `#id` / 模板 key+version / 耗时（completedAt-startedAt 或至今）/ 成本（¥ 格式化）/ 创建时间；**点击钻取** `goRun(id)`（既有单 run 画布）
- 空态：无 run → 复用既有引导卡（「从项目页启动一条」）
- 刷新：socket 事件（run.* / task.updated）→ 与单 run 画布同一 `scheduleRefresh` 防抖（overview 态静默重拉）

### 2.5 ⑤ 画布内编辑（E3，批 2）

**范围**：仅**模板画布**（M15 template 态）新增「编辑模式」开关；运行画布保持纯读（写面边界登记 §8）。

- 编辑模式 UI：模板画布顶栏「编辑」开关（仅 template 态显示）→ 选中节点抽屉出现「编辑」区：
  - `title`：文本框（非空校验）
  - `inputs` 字符串叶子字段：逐字段文本框（仅原值为 string 的顶层字段；数组/对象/数字字段只读展示）
- 本地文档状态：编辑层维护前端 doc 副本（`TemplateCanvas` + 覆盖项），脏标记（有改动才允许导出/保存）
- 落盘路径：**不直写原模板文件**——一切编辑经 §2.6 的「草案导出 / 保存为新模板」通道（受控：新 key；原文件零触碰）
- 运行画布抽屉、创作画布均不改（超出写面 → §8）

### 2.6 ⑥ 设计态编排（E4，批 3）

**交互**（模板画布编辑模式下）：

- **拖拽连线**：从节点输出口拖至另一节点输入区 = 新增调度依赖（B.after += A）
  - **缺省依赖物化**：B.after undefined（「前一步」语义）→ 操作时先物化为 `[前一步]` 再追加 A；B 为 seq 首节点 → 物化为 `[]` 再追加
  - **前→后约束**：新边仅允许「上游→下游」（按 steps 数组序；对齐 loader 校验语义：`after` 仅可引用前置步骤）→ 引用非前置即拒绝 + toast；数组序天然防环（无需额外 DAG 排查）
  - 去重：A 已在 B.after → 忽略
- **边删除**：点选 sched 边 → Del → 从 after 移除（显式 `[]` = 无依赖，保持显式）
- **不做的编辑**（§8）：data 边（inputs 引用）、节点增删、action/key 修改、when/gate/batch 编辑
- 视图与既有渲染兼容：编辑后 sched 边集 = 修改后 after 派生（复用 `stepDepEdges` 逻辑）→ 画布即时重绘（本地状态）

**导出 / 落盘**（对齐 template-draft 先例「先草案审阅」+ 本拍板「允许落盘」）：

- **导出草案**：`POST /templates/:key/edit-draft`（body = edits）→ `{ yaml, validation: { ok, errors }, editsApplied }`（**不落盘**）→ Modal 展示 YAML（复用 draft modal 交互：复制按钮 + validation 结果）；前端不构造 YAML（服务端序列化，受控）
- **保存为新模板**：`POST /templates/:key/edit-save`（body = edits + `newKey?`）→ key 缺省 `<原key>-edit`；冲突自动后缀 `-2/-3/…`（抽取 template-try 避让逻辑为公共函数复用）；`validateTemplateText` 失败 → 400 + errors；成功 → `saveTemplate(finalKey, yaml)` → `{ templateKey, validation }`；**原模板文件零触碰**
- 序列化器：Template 对象 → snake_case YAML 文本（`yaml.stringify` + 键名映射，对齐 loader 解析规则逆向）；探针做 `parse ∘ stringify` 往返等值断言
- 保存成功后：toast + 模板目录刷新（新模板出现在画布页模板下拉 / 模板页）

**edits 结构**（白名单，服务端逐项校验）：

```ts
{
  steps: Array<{
    key: string                    // 必须存在于模板
    after?: string[] | null        // 调度依赖（null = 回落缺省语义；数组 = 显式）
    title?: string                 // 非空
    texts?: Record<string, string> // inputs 顶层字符串字段覆盖（仅原值为 string 的键）
  }>
}
```

- 服务端 `applyTemplateEdits(template, edits)` 纯函数（探针直测）：key 不存在 / after 引用不存在 / 引用非前置 / texts 键非字符串原值 / title 空 → 分别报错（400 `bad_edits` + 原因）；不改动入参对象（返回新对象）
- 编辑语义抽为同模块纯函数（探针直测、前端编辑层镜像同规则）：`materializeAfter`（缺省物化：undefined → [前一步] / 首步 → []）/ `addDep`（物化 + 前→后校验 + 去重追加）/ `removeDep`（物化 + 移除，空列表保持显式）

### 2.7 ⑦ LLM 建议式编排（D11，批 3）

**落点**：创作画布（`views/creation`）工具栏「AI 建议」按钮。

- **端点**：`POST /canvases/:id/advice` →
  - 服务端构建**确定性摘要**（`buildCanvasSummary`，纯函数探针直测）：节点（kind/title/groupId/readiness problems/生成参数关键字段）+ 边（引用/参考类）+ 组树 + gen 任务状态计数
  - `loadPromptTemplate('canvas-advice.md')`（新增提示词）：system = 「你是创作画布编排顾问，基于摘要输出 JSON 数组建议（kind/targetNodeId/title/detail），不执行任何操作」；user = 摘要 JSON
  - `chatCompleteDetailed`（既有端点解析 + `recordLlmUsage` 用量留痕——对齐 M18 llm 节点先例）
  - 输出解析 `parseAdviceOutput`（纯函数）：JSON 数组（剥 ```json 围栏）→ 逐项归一（kind 白名单 `structure|connect|config|generate|cleanup`、targetNodeId 校验存在、title/detail 非空）；解析失败 → 原文降级为单条 `raw` 建议（宽容不炸）
  - 响应：`{ advice: [...], usage: { tokensIn, tokensOut } | null }`
  - LLM 不可用 / 未配置 → 400 + 明确原因（前端提示；不生成假建议）
- **前端**：按钮 → Modal：加载态 → 建议列表（kind 图标 + title + detail + 「定位」按钮（`centerOn` 节点，目标节点存在时））；页脚显示用量（计费感知）；**仅展示 + 定位，不提供一键执行**（建议式红线）
- **计费安全**（纲领 §五 待决策项「LLM 编排分层」M23 侧论证）：显式单次触发（非自动/非轮询）；不自动执行任何建议动作；用量留痕可审计；M27 执行式编排独立立项时不继承本通道的自动能力

---

## §3 接口契约（新增端点 4 枚）

| # | 端点 | 说明 |
|---|---|---|
| 1 | `GET /canvas/overview?project_id=` | 全景聚合：`{ project: {id,name}, batches: [...含 runs+cost], standaloneRuns: [...含 cost], stats: { runCount, byStatus, totalCost } }`；project 缺失 → 404 |
| 2 | `POST /templates/:key/edit-draft` | body `{ edits }` → `{ yaml, validation, editsApplied }`（不落盘）；模板缺失 404；edits 非法 400 `bad_edits` |
| 3 | `POST /templates/:key/edit-save` | body `{ edits, newKey? }` → `{ templateKey, validation }`；validate 失败 400；key 冲突自动后缀 |
| 4 | `POST /canvases/:id/advice` | → `{ advice: [{kind, targetNodeId?, title, detail}], usage }`；LLM 不可用 400 `llm_unavailable`；画布缺失 404 |

扩展：`ARRANGE_MODES` + `'force'`（`POST /canvases/:id/nodes/arrange` 既有端点复用，body 不变）。

---

## §4 验收标准

| # | 项 | 验收 |
|---|---|---|
| 1 | 虚拟化 | 渲染集 = 可见集断言（e2e：缩小视口后 DOM 节点数 < 总量；平移后进出视口正确挂载/卸载）；基准报告（300/600/1000 三档）落 review |
| 2 | 力导向 | 探针：确定性（×2 等值）/无 NaN/分离度/锚定/边界；e2e：按钮触发重排 + 目检；regression：layered/grid 快照零漂移 |
| 3 | 全景图 | overview 断言（批次分组/独立 run/成本映射/空项目）+ e2e：tab 切换、卡片渲染、钻取 `?run=` 跳转 |
| 4 | 批次聚合 | 批次头计数与 `GET /batches` 一致断言；e2e 批次组渲染 |
| 5 | 画布内编辑 | e2e：编辑 title/文本字段 → 导出草案 YAML 含修改；运行画布无编辑入口（回归） |
| 6 | 设计态编排 | 探针：edits 应用矩阵（物化/加边/删边/防环/白名单/引用校验）；`parse ∘ stringify` 往返；e2e：拖拽连线 → 保存新模板 → 模板下拉出现新 key；**原文件字节零变化**断言（save 前后读取对照） |
| 7 | LLM 建议 | 探针：摘要构建 + 输出解析矩阵（围栏/坏 JSON/白名单归一/超量截断）；e2e 实弹：真实触发（LLM 可用时）或降级路径（`llm_unavailable` 提示） |
| 8 | 工程项 | `probe:m23` 全绿 + 回归（m2a/m3/m4/m6–m22 等）零适配 + 双端 typecheck + 三层实弹 + review 落盘 + roadmap 校准 |

---

## §5 风险与权衡

- **d3-force 引入论证**（破零依赖惯例的例外边界）：
  - 引入物 = 纯数值计算库（无 DOM/无网络/无全局副作用；ESM 与 server `type: module` 兼容；体积 ~30KB；d3 官方模块、维护活跃）
  - 替代方案（自研力导向）代价：迭代收敛质量/参数调优（Barnes-Hut 近似等）自研成本高、视觉质量难保证；用户拍板引入
  - **例外原则登记**：「成熟纯算法库（无 IO/无框架语义）」可经拍板论证引入；UI 框架/网络/重型引擎仍零容忍（纲领 §四红线不变）
  - 确定性保障：固定初始坐标 + 固定 tick 数 + 无随机源 → 探针可直测；若未来升级 d3-force 版本导致快照漂移 → 探针以「确定性 + 分离度」而非逐坐标快照断言
- **落盘安全**（E4「允许落盘」的受控边界）：新 key 永不覆盖（后缀避让）；validate 先于写入；原模板文件零触碰（实弹字节级对照断言）；edits 白名单服务端校验（不信任前端）
- **虚拟化风险**：裁剪边界闪烁（VIEW_MARGIN 半屏外扩缓解）；高度未实测兜底（既有 DEFAULT_H）；连线落点受限可见区（登记备注意）
- **LLM 计费安全**：显式单次 + 非自动 + 不执行 + 用量留痕（对齐纲领 §五 分层：M23 建议式 ≠ M27 执行式）
- **物化语义风险**：after 物化会改变「缺省依赖」为显式——导出 YAML 中呈现显式列表（用户可改回）；探针断言物化规则

---

## §6 实施批次

| 批次 | 内容 | 验证 |
|---|---|---|
| **P0 基建** | 依赖安装（d3-force/@types）+ `ARRANGE_MODES` force 骨架 + 序列化器/`applyTemplateEdits` 骨架 + probe-m23 骨架 | typecheck + 空探针 |
| **P1 批 1** | 虚拟化裁剪 + 基准脚本 + force 模式 + 前端按钮 | 探针 force 节 + e2e + 基准报告 |
| **P2 批 2** | overview 端点 + 全景 tab + 编辑模式 + E3 字段编辑 | 探针 overview 节 + e2e |
| **P3 批 3** | 连线编辑 + edit-draft/edit-save + canvas-advice.md + advice 端点与面板 | 探针 edit/advice 节 + e2e 落盘对照 |
| **P4 收口** | 探针全量 + 回归 + 实弹 + review + roadmap/README/spec 标记 | 全绿 + 文档落盘 |

---

## §7 探针设计（`probe-m23`）

| 节 | 断言数（约） | 内容 |
|---|---|---|
| `force` | 15 | 确定性 ×2 / 无 NaN / 分离度阈值 / 锚定平移 / 空·单点·无边边界 / layered·grid 快照零漂移 |
| `serialize` | 12 | 模板→YAML→parse 往返等值（含 after/when/gate/batch/inputs 用例）/ snake_case 键 / 转义 |
| `edit` | 18 | `applyTemplateEdits` + 边操作纯函数矩阵：物化（undefined/首节点）/加边/去重/删边/空 after/非前置拒绝/未知 step/未知 after 引用/texts 键非字符串/title 空 |
| `overview` | 12 | 聚合：批次分组/进度计数/独立 run/cost 映射/空项目/status 过滤 |
| `advice` | 12 | `buildCanvasSummary` 确定性；`parseAdviceOutput`：正常/围栏/裸文本降级/kind 白名单/无效 targetNodeId/超量截断 |
| `bench` | 6 + 报告 | 300/600/1000 节点 `buildCanvasDoc` 耗时记录（成功/有限断言）+ 报告输出 |

- 纪律：内存临时库（`acs-probe-*`）零网络零计费；**LLM 调用不探针**（纯函数拆测 + e2e 实弹）；探针日志 JSON 行格式对齐既有

---

## §8 明确排除

- **data 边编辑**（inputs 引用重写）——风险高，本轮不做（设计态编排 = 调度依赖 + 文本字段）
- **节点增删 / action·key 修改 / when·gate·batch 编辑**（模板画布编辑模式不做）
- **运行画布写面一切形态**（含产物资产重命名/打标——画布内不落；资产编辑归资产库既有能力）
- **模板多版本管理 / 覆盖保存**（落盘仅新 key；版本演进归模板文件手工管理）
- **LLM 自动执行 / 一键应用建议 / 自动轮询**（建议式红线；执行式为 M27 范畴）
- **力导向实时预览动画**（一次点击全量重排，与既有布局同语义）
- **组框/边包围盒级虚拟化**（本轮仅节点裁剪 + 边「任一端可见」规则）
- **虚拟列表库 / 任何 UI 依赖**（除 d3-force 纯算法库外零新依赖不变）
