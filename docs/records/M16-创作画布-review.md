# agencys-content-studio M16 里程碑 review

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-13
- 对应 spec：`2026-09-13-agencys-content-studio-m16-design.md`（§5 验收）
- 判定：**静态 + 探针 + 实弹（浏览器 DOM）全绿**（含真实出图 ×2；实弹暴露 4 处缺陷已全部修复复验）
- 证据采集方式：`probe:m16` 六节 126 项断言 + 回归 m15（内含 m2a·m4·m14）；真实开发库实弹（项目 10 · 画布 1/2/4 · Run 101；服务 3001 + vite 5174 运行态）；无头浏览器 DOM；**除两次真实出图（pollinations 零计费）外全程零真实提交零计费**

---

## 结论摘要

- **第二类画布落地（写模型）**：创作画布 `/creation?project=&canvas=` 全链打通——画布文档三表（`canvases` / `canvas_nodes` / `canvas_edges`）+ `gen_tasks.canvasNodeId` 列；`buildCanvasDoc` 全量读模型（节点状态零存量，全部由 gen_tasks 派生 + readiness 预检 + editCapability 快照）；14 枚端点（CRUD / 端口矩阵 + 环检测 / duplicate / template-draft / 联动）。
- **执行通道直连适配层**：`creation-gen.ts` 不复用 pipeline actions——任务 `runId/stepId` 恒 null、`canvasNodeId` 归属、信号量 ≤2、失败自动重试 1 次、视频轮询、`recordUsage`、崩溃恢复标 failed；失败链全链路由 probe 断言（无端点配置 → 任务落库 → 重试后 failed → errorMsg 透传 → 复位可重跑 → retry 端点 `no_step` 不误伤 → recover 仅命中画布任务）。
- **编辑能力声明制**：适配器可选扩展零破坏（既有 7 适配器不声明即无）；首家 aliyun-wan（inpaint/outpaint + erase 归一）；实弹在无 key 环境按 spec 退化路径验证——inspector 置灰警告 + 执行失败错误原样透传（任务 #452）。
- **联动三枚 + 模板化沉淀实弹通过**：run 产物→画布（网格落点）/ 画布产物→实体参考图（无损回滚）/ 画布素材→送去运行（prefill 两分支）；复制画布与低保真模板草案（校验自检 + 复制 YAML 剪贴板回读）。
- **socket 实时对账（含关键缺陷修复）**：修复「首次进入/刷新漏 join canvas 房间」后，执行节点任务 #451 徽标 pending→succeeded 全自动流转（零手动刷新）。
- **实弹暴露缺陷 4 处（已全部修复）**：见「偏差与修复记录」。

---

## 验收逐条对照（spec §5）

### #1 静态：双端 typecheck + probe:m16 六节 + 回归 + 旧库升级

- **操作**：`pnpm --filter @acs/server typecheck` + `pnpm --filter @acs/web typecheck`；`probe:m16`（canvas-doc / node-build / edit-cap / draft / linkage / regression）。
- **证据**：双端 typecheck exit=0；`probe:m16` **126 项断言全过**（canvas-doc 56 / node-build 34 / edit-cap 11 / draft 13 / linkage 10 / regression 2；终判「全部通过」）。
  - `canvas-doc`（56）：画布 CRUD（404 / 默认名 / 空文档 / 改名 / viewport 默认与 clamp / 非法 400）+ 节点 CRUD（素材 / 图像 / 视频 / 编辑节点 201、非法 spec·kind 400、素材节点禁改 spec）+ 边矩阵（端口 × 目标节点 × 数量上限 × 类型限制；重复边 / 自环 / 跨画布 / 非法端口 / 非整数 from 全 400；环检测三案）+ 派生读模型（最新任务状态映射、结果资产冗余含缩略、任务历史 5 条、readiness 各分支、busy 态、editCapability、坏 spec 宽容）+ duplicate（节点数 / 边数 / id 重映射 / 边指向新集）+ 级联（删节点清边 / 删画布清节点边）+ 执行通道失败链（入队 200 / 归属与恒 null / params 输入快照 / busy 400 / 无端点重试后 failed 透传 / 复位可重跑 / retry 400 no_step / cancel 终态 400 / recover 标 failed 不误伤 run 任务）。
  - `node-build`（34）：`resolveNodeInputs` 纯矩阵（reference 上限 6 / 2、首帧仅视频、多端口映射、源图仅编辑、缺源 / 无产物 / 非图片 problems）+ topoSort / parseViewport / safeParseSpec / specProblems + `buildNodeTaskParams` 全字段快照 + `appendStyleSnippet` + `buildEditParams` 五案 + `wouldCreateCycle` 三案。
  - `edit-cap`（11）：aliyun-wan 声明 {inpaint, outpaint} + edit 方法存在；未声明适配器 → undefined；`editCapabilityOf` 无端点 → 全 false；wan.edit 请求构造快照（提交端点、inpaint 请求体、轮询端点、erase 默认提示词、outpaint expand 三元组、缺 mask 本地抛错零请求）。
  - `draft`（13）：草案骨架（key / inputs / 拓扑序 / 素材不产 step / 视频 action / 边→after / 编辑 TODO / 素材与蒙版注释）；`POST template-draft` 200；validation 与 `validateTemplateText` 同源一致；404 / 非法 key 400 / 不存在 null。
  - `linkage`（10）：ref-assets 挂接与并集去重 + 404 / 全局 / 空数组 / 他项目 400；送入画布建素材节点（201 + 资产视图 file URL）；prefill 键安全（未声明键丢弃 / 非法 files 元素抛）。
  - `regression`（2）：既有 run 任务查询（`canvasNodeId is null`）命中；`probe:m15` 全绿（内含 m2a / m4 / m14 零漂移）。
- **旧库升级**：实弹全程运行于既有 data 目录（存量库）——`ensureTable` / `ensureColumn` 幂等兜底自动升级，无报错。
- **✅ 通过**

### #2 画布实弹（浏览器 DOM）

- **操作**：真实开发库运行态（服务 3001 + vite 5174）——画布 1（编辑节点 + 素材节点）、画布 4（「M15联动验证」）、Run 101 抽屉联动。
- **证据**：
  - 建画布 / 切换（画布 1 / 2 / 4）；素材拖入摆放；双击空白建生成节点（「图片 #7」）；连线（素材 → 编辑节点，源图入边「入 1」）；节点拖拽落库；
  - Inspector 全表单：spec 编辑与保存（就绪度「已就绪，可执行」）、任务历史（#450 / #451）、结果预览（#1323）；
  - 蒙版涂抹：EditBrushModal 导出 PNG → 上传 purpose `mask` → 回填 `spec.edit.maskAssetId`（蒙版资产 #1320；素材面板可见 mask 缩略）；
  - pan / zoom / fit 与视口持久化：滚轮缩放后防抖 PATCH 落库（DB viewport 与 DOM transform 逐值一致）→ 刷新页面后 transform 逐值保持（`translate(52.9119px, 6.92147px) scale(0.996406)`）。
- **✅ 通过**

### #3 零漂移

- **M15 画布零 diff**：`CanvasBoard.vue` 不动；唯一触碰 = `CanvasDrawer.vue` +1「送入创作画布」按钮（联动）；M15 探针全量回归绿。
- **既有页面**：`RunDetailView` / `TemplatesView` 等接线均为纯新增；`engine.ts` 差异系 M15 纯委托重构留痕（非 M16）。
- **生成主链零改动**：pipeline actions / engine / dag / refs / loader 零 diff；`aliyun-wan-image.ts` 仅 +编辑声明与 `edit()` 实现（`generate` 路径不动）。
- **✅ 通过**

### #4 文档三件

- README：状态行 + M16 能力速览 + M16 验收快照。
- roadmap：设计链接 + 红线表更新（「创作画布已于 M16 引入，首次引入新表」）+ M16 注记。
- 本文件（m16-review.md）。
- **✅ 通过**

---

## 静态与探针

- **静态**：双端 typecheck exit=0；`apps/server/package.json` 仅 +`probe:m16` 脚本（dependencies 零新增）。
- **探针 `probe:m16` 六节**：见 #1 逐节构成；终判「全部通过」。
- **回归**：`probe:m15` 全绿（内含 m2a / m4 / m14 零漂移；exit=0）；探针既有临时目录清理提示（Windows libsql 句柄，下次运行自动清理）为既有行为。

---

## 偏差与修复记录

1. **CreationInspector TDZ（实施期发现，已修复）**：`entOpen`（实体挂接面板开合）声明晚于「节点变更 watch」——watch 回调同步引用该 ref 时触发暂时性死区；修复 = 声明前置（附注释「node 变更 watch 会重置它，故必须先于该 watch 声明」）。
2. **CreationView docSeq TDZ（实施期发现，已修复）**：文档拉取序列守卫 `docSeq` 声明晚于 URL 同步 watch——其 `{ immediate: true }` 回调在 setup 期同步触发 `loadDoc()` 并引用 `docSeq`，注册即抛；修复 = 声明前置（附注释）。
3. **uploadFiles 契约不符（实施期发现，已修复）**：web `uploadFiles` 原按 `{ assets }` 解析响应，服务端 `imports` 实际返回 `{ items }` → 上传后回填为空；修复 = 解析改 `items ?? []`（蒙版上传与素材导入全链复验）。
4. **漏 join canvas 房间（实弹暴露，已修复）**：真实出图任务 #450 succeeded 后页面 32s 仍显示「生成中」（「生成中」实为 doRun 的本端 refresh）。根因 = `CreationView` 的 URL 同步 watch（`route.query`，immediate）在 setup 期已把 `canvasId` 置为 4；房间 watch（`watch(canvasId, …)`）注册在后且无 immediate → 错失 null→4 变化 → 首次进入 / 刷新页面从未 join `canvas:<id>` 房间。修复 = 房间 watch 加 `{ immediate: true }`（附时序注释）。复验：修复后二次执行节点 #451，徽标 pending→succeeded 全自动流转（零手动刷新）。
5. **备注（非缺陷）**：实弹中曾以脚本直接 `PATCH /nodes/:id` 改坐标后观察画布未刷新——经查该路由按设计**不 emit** `canvas.changed`（仅执行通道各状态转移 emit），实验口径修正后改用真实执行任务做对账验证。

---

## 局限与备注

- **编辑通道真实出图未做**：本环境无支持编辑的供应商 key（aliyun-wan 未配置）——按 spec §5-2 既定分支以「声明置灰 + 错误透传」退化验证（任务 #452 全链路）；真实 inpaint / outpaint 出图待配置 key 后补验（请求映射已在 probe `edit-cap` 快照锁定）。
- **视频节点真实出图未做**：画布视频生成链路（轮询 / 取消）由 probe 断言背书（`buildNodeTaskParams` 视频字段 + 执行通道失败链 + recover）；真实视频出图有成本，未在实弹中跑（spec §5-2 允许）。
- **多选 / 框选 / 撤销重做等交互增强**：spec §8 明确排除，未实现。
- **截图证据 3 张**：`apps/web/tmp-m16-draft-modal.png`（模板草案弹窗 + 校验自检 + 复制按钮）/ `tmp-m16-edit-cap-hint.png`（编辑节点置灰警告 + 就绪度）/ `tmp-m16-edit-fail.png`（任务 #452 失败与错误透传）。
- **存量数据说明**：验证期新增画布 4「M15联动验证」（3 节点，含真实生成结果资产 #1323）与画布 1 的任务 #452（预期失败留档）；「灯婆婆」实体参考图已回滚为 []（无损）；用户自建空画布 2 未触碰。

---

## 附录

- **改动清单（git status 基线）**：
  - 服务端新件：`services/creation.ts` / `services/creation-gen.ts` / `routes/creation.ts` / `scripts/probe-m16.ts`
  - 服务端改动：`db/schema.ts`（+3 表 +1 列）/ `db/index.ts`（+ensureTable×3 +ensureColumn×1）/ `adapters/types.ts`（+`editing` / `edit` / `ImageEditRequest`）/ `adapters/aliyun-wan-image.ts`（+编辑实现）/ `services/events.ts`（+1 事件）/ `index.ts`（房间正则 + 桥接 + `recoverCanvasTasks`）/ `app.ts`（+1 挂载）/ `routes/projects.ts`（+14：删项目级联清画布）/ `package.json`（+`probe:m16`）
  - Web 新件：`views/CreationView.vue` / `components/CreationBoard.vue` / `components/CreationInspector.vue` / `components/EditBrushModal.vue` / `components/CanvasTargetModal.vue` / `lib/board-viewport.ts`
  - Web 改动：`router.ts` / `App.vue` / `components/Icon.vue` / `lib/api.ts` / `lib/types.ts` / `lib/socket.ts` / `components/CanvasDrawer.vue`（+1 按钮）等
  - 文档：`README.md`（+29 行）+ roadmap 回写 + 本 review（`docs/superpowers/specs/`）
- **红线零 diff 明细**：refs / loader / workspace 模板与提示词 / engine / dag / 既有适配器 `generate` 路径零 diff（`git status` 核查；engine.ts 差异为 M15 留痕）。
- **证据日志**：`d:\work\AI\.qoder\tmp-m16-probe-log.txt`（探针最终轮全量输出）。
- **实弹清单**：画布 1 / 4 + Run 101 联动 + 任务 #450 / #451 / #452 + 模板草案 + 视口持久化。

---

## 验证方式（已完结）

- 静态：`pnpm --filter @acs/server typecheck` + `pnpm --filter @acs/web typecheck` → exit=0
- 探针：`pnpm --filter @acs/server probe:m16`（六节 126 项）+ 内嵌回归（probe:m15 含 m2a / m4 / m14）
- 实弹：无头浏览器 DOM（运行态 :3001 + :5174；画布 1/2/4、Run 101；含真实出图 ×2 与编辑失败链）
- 采集时间：2026-09-13（M16 P7 批次，服务运行态）
