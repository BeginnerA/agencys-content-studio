# agencys-content-studio M18 里程碑 review

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-14
- 对应 spec：`2026-09-14-agencys-content-studio-m18-design.md`（§5 验收）
- 判定：**静态 + 探针 + 实弹（真实库 REST + 浏览器 DOM）全绿**（成组 / 回收站 / 快照 / 流式导出 / 封面真实数据留痕；探针含真实 ffmpeg 抽帧与合成、fetch-stub LLM 执行、定价链）
- 证据采集方式：`probe:m18` 九节 **247 项断言**（零网络零计费，含 30MB 大文件流式 store 逐字节对拍）+ 独立回归 `probe:m16`（其 regression 节内嵌 `probe:m15` → m2a / m4 / m14 零漂移）+ `probe:m17`（M17 主链超集兼容基线）+ m3 / m6–m13 回归；真实开发库实弹（项目 10 · 画布 5「M17实弹」；服务 3001 + vite 5174 运行态）；无头浏览器 DOM + REST；实弹全程自清理（组、临时画布 8、导出资产留档）

---

## 结论摘要

- **创作画布从「工作台」到「生产级工作室」**：四批 14 项缺口一次开发全部落地——快赢（视频抽帧 / compose 转场 + BGM / 成本预估 run-preview / 一键停止全部 / 批量实体参考）、安全（回收站软删 + 文档快照保留 id 重放）、深度（LLM 文本节点 + 画布→模板保真 v2 一键试跑）、规模（节点成组折叠 / 画布封面 / 流式导出 zip）；M17 §8 排除项 4 项（成组折叠 / 版本快照 / zip 流式 / 模板一键可运行）全部回收，无一遗留。
- **软删优先语义（唯一破坏性行为变更，双处明示）**：`DELETE /canvases/:id` 由物理级联删除改软删进回收站——节点 / 边物理保留、自动中断在途任务、响应 `{ ok, mode:'trashed', deletedAt, cancelled }`；`GET /canvases` 默认只返回活跃画布，软删项 `?trash=1` 单列；`restore` 回正常态、`purge` 才物理删（nodes/edges/groups/snapshots，gen_tasks 留痕）。实弹 REST 全程走通并自清理（见 #2）。
- **快照「保留 id 重放」（防任务历史孤儿，核心安全设计）**：恢复 = ①自动创建「恢复前自动备份」快照 → ②清空现 nodes/edges/groups → ③按快照 doc 重插**显式保留原节点 id** → ④ emitCanvasChanged；保 id 使 `adoptedTaskId` 指向的 `gen_tasks.canvasNodeId` 依然成立。实弹恢复后 `nodeIdKept=True`（恢复的节点 id 仍为原 id，任务历史不断链），id 占用冲突 → 事务回滚 + 409。
- **成组折叠全链 DOM 实证**：`canvas_groups` 表 + `canvas_nodes.group_id`；doc `groups[]`（title/color/collapsed/x/y，成员由前端派生包围盒）；`POST/PATCH/DELETE /canvases/:id/groups[/:gid]` 三端点 + `Ctrl+G`；组条折叠隐藏成员与相关边、重命名（双击）、改色（10 色白名单）、解组、拖拽移组；copy 出节点 groupId 归零、删成员不级联删组（空组保留）。
- **规模与体量**：`listCanvases`（含回收站）+ `cover`（取最近完成 succeeded 任务产物缩略，两次批查避 N+1）；导出 `zipSync` 全内存改 fflate `Zip` 流式直写临时文件（媒体 `ZipPassThrough` store、文本/manifest `ZipDeflate` level 6），端点 / 命名 / manifest 结构零变化（探针 unzipSync 逐项对拍 + 30MB 大文件字节等价）。
- **深度闭环**：LLM 文本节点（genKind='llm'，端口 v3：reference / text / prompt 入、产文本）+ `executeLlmOnce` 复用 LLM 通道 + `recordUsage`，未配置 → readiness 预检引导 Settings，图生文闭环；画布→模板保真 v2（`literal` action 零 LLM 写产物 + `ai_text` `prompt_inline` + draft v2 分级保真 + lossy 显式清单 + `template-try` 一键试跑建 run）。

---

## 验收逐条对照（spec §5）

### #1 静态：双端 typecheck + probe:m18 九节 + 回归 + 旧库升级

- **操作**：`pnpm --filter @acs/server typecheck` + `pnpm --filter @acs/web typecheck`；`probe:m18`（p1-schema / frame-extract / compose-v3 / run-preview / trash-snapshot / llm-node / template-v2 / groups / scale-zip）；独立回归 `probe:m16`（含其 regression 节内嵌 `probe:m15` → m2a / m4 / m14）+ `probe:m17` + m3 / m6–m13。
- **证据**：双端 typecheck exit=0；`probe:m18` **247 项断言全过**（p1-schema 10 / frame-extract 29 / compose-v3 24 / run-preview 19 / trash-snapshot 50 / llm-node 47 / template-v2 42 / groups 16 / scale-zip 10；终判「全部通过」，exit=0）。
  - `p1-schema`（10）：`canvases.deleted_at` / `canvas_nodes.group_id` 列存在（ensureColumn）；`canvas_groups` / `canvas_snapshots` 表 + 索引存在（ensureTable）；schema 读写冒烟 + initDb 幂等；canvas_groups 默认值（collapsed=0 / x=0 / color=null）与 PATCH 持久化；canvas_snapshots doc JSON 往返。
  - `frame-extract`（29）：`frameTimeOf` 全模式矩阵（first/last/custom，含 duration null/边界）+ `buildFrameExtractArgs` 快照（`-ss` 前置、全尺寸不缩放）+ 端点全链——asset 源 / gen 显示产物源抽帧 201、`purpose=creation_frame` / `mime=image/jpeg`、缺省落位=源节点右下偏移（+60/+140）、真实 ffmpeg 抽帧产物 JPEG（FFD8 魔数）验证、错误族。
  - `compose-v3`（24）：`buildComposeArgs` v3 快照矩阵——**旧形态输出不变**（probe-m17 兼容基线）/ 转场启用 / BGM（`atrim=0:totalDur` / `volume=0.5` 默认）/ 转场+BGM / durations 缺失降级 notes + spec 校验 + 真实合成冒烟。
  - `run-preview`（19）：`preflightNode` 拆分回归 + 定价链（实例级 apiConfigs.pricing → settings.pricing → 缺失 unpriced）+ 各 genKind 单位矩阵（image/edit=1、video=时长、audio=字符数、compose=0、llm=unpriced）+ 响应结构（零副作用）。
  - `trash-snapshot`（50）：软删 + 在途取消 + 列表排除 + trash 列表 + restore（未在回收站 400 bad_state）+ purge 幂等 + 错误族 + 统一装载点 `deletedAt` 过滤（已删 → 404）+ 快照创建 / 上限 20 / **保留 id 重放（任务历史认领）** / 恢复前自动备份 / 冲突 409。
  - `llm-node`（47）：端口 v3 全组合（reference→llm、text→llm、llm→prompt、跨类型拒连、上限）+ `specProblems`（未配置 / 空指令）+ 执行链（fetch stub 成功径 / 多模态图片素材 / 文本资产 `creation_llm` 落库 / 用量落库 / 错误族）+ 产物文本下游装载（prompt 端口上游 llm 产物全文入 `UpstreamInfo.text`）。
  - `template-v2`（42）：`literal` action 全 as 矩阵（raw 内容不变 / storyboard-single → `shots[0].image_prompt` / lines-single → `lines[0].text` / inputs.text 优先 params.payload / 无源抛错 / as 非法抛错 / inputs.text=资产 id 读全文）+ `KNOWN_ACTIONS`·`ACTIONS` registry 已含 literal + `ai_text` `prompt_inline` + draft v2 映射全节点型 + lossy 清单（image 参考连线 / video first_frame 连线降级）+ draft v2 通过 `validateTemplateText` + `template-try` 全链（201 `{templateKey,runId,lossy,input}` / files←asset 预填 / 建 queued run / key 冲突自动后缀 `-2` / nodeIds 子图闭包 / 无 gen 400 / 非法 key 400 / 不存在画布 404）。
  - `groups`（16）：建组 201（锚点=成员包围盒左上）+ title/color 落库 + doc.groups 读模型（collapsed 布尔）+ 成员 groupId 归属 + 跨组拒绝 400 列违规 + PATCH collapsed/空 title 400/非白名单色回退 null/不存在 404 + 解组成员归属清空 + 删成员空组保留（不级联删组）+ 空组锚点 x/y 可 PATCH。
  - `scale-zip`（10）：cover 派生矩阵（多 succeeded 取最近完成 max completedAt / 无产物 null / 回收站列表同样派生）+ 流式 zip 对拍（manifest 存在 / files·skipped 记账 / 文本条目逐字节等价 / 媒体条目 store 内容等价 / **30MB 流式 store 长度·字节等价** / 导出资产登记 archive·creation_export）。
- **回归**：`probe:m16` 全绿（含 §regression 内嵌 `probe:m15` → m2a / m4 / m14 零漂移；exit=0，仅 **1 处适配**，见「偏差与修复记录 #1」）；`probe:m17` 全绿（exit=0；M17 主链对 M18 超集兼容基线，零适配）；m3 / m6–m13 全绿。
- **旧库升级**：实弹全程运行于既有 data 目录（存量库）——`ensureColumn ×2` / `ensureTable ×2` 幂等兜底自动升级，无报错。
- **✅ 通过**

### #2 画布实弹（真实库 REST + 浏览器 DOM）

- **操作**：真实开发库运行态（服务 3001 + vite 5174）——项目 10、画布 5「M17实弹」（10 节点）为观察对象；组 / 回收站 / 快照 REST 走真实库并自清理。
- **证据**（HTTP 留痕 + DOM 断言 + DB 核对）：
  - **成组渲染全链（DOM 实证）**：API 建组 id=1（title「实弹分组」/ blue / 锚点 20,1443）→ 断言 `.cgroup cg-blue`（边框 alpha .55 / 组条 .92、框 left8 top1409 244×368、count2、10 节点）→ 折叠（组条 32px 220w、背景透明、10→8 节点渲染）→ 展开（→10）→ 组菜单（10 色点 + `cg-none`、当前 `cg-blue.on`、解组项）→ 重命名（dblclick→input→Enter→「实弹改名」落库）→ 解组（`.cgroup` 消失、10 节点、canvas5 groups=0、全节点 groupId=null，自清理）。
  - **回收站 + 快照（真实库 REST 自清理）**：create canvas8 → node31 → snapshot sid=1 → 加噪节点（→2）→ restore（**`nodeIdKept=True`**，回到 1 节点且保留原 id=31 → 任务历史不断链）→ DELETE（`mode=trashed` / `cancelled=0` / `hasDeletedAt`）→ trash 列表命中 → restore 回正常列表 → purge → project10 回到原始 `5,1,4,2` 无残留。
  - **流式导出（真实产物 + 解压验证）**：`POST /canvases/5/export` → asset #1338（size 3,878,371 / purpose `creation_export`）；下载 magic `504B0304`（PK）；.NET `ZipFile` entries=7（6 媒体 + manifest）——媒体条目 `comp=raw`（**STORE = ZipPassThrough**，如 `…gen-mp4.mp4-1154.mp4 comp=1673058 raw=1673058`、`合成 #29-1332.mp4 comp=178495 raw=178495`），manifest `comp=946 raw=2668`（DEFLATE = ZipDeflate）；manifest.json 内容合法（canvas id5 / projectId10、files6 带 nodeId/seq/prompt、skipped4 逐因〔暂无成功产物 / 运行节点不参与打包 / 实体节点不参与打包〕）。
  - **封面（真实数据派生）**：`GET /projects/10/canvases` → canvas5 cover=video #1332（compose 最近成功产物，max completedAt）、canvas4=image #1323、canvas1/2=null、deletedAt 全空——cover 字段派生正确（画布选择卡片 DOM 露出因 `/creation?project=10` 自动选中 canvas5 跳过空态引导，改以 HTTP 数据留证，见「局限与备注」）。
- **✅ 通过**

### #3 兼容（M17 端点行为不变除软删 · GET /canvases 超集）

- **`GET /canvases` 严格超集**：`CanvasListItem` = M17 原 6 字段（id / title / nodeCount / edgeCount / updatedAt / …）**只增** `deletedAt` + `cover`，旧客户端读取零破坏；默认列表排除软删项，软删项经 `?trash=1` 单列。
- **M17 全部端点超集**：doc / detail 读模型 +`groups[]` / `groupId` / `cover` / `lossy` 等新字段全可选；`DELETE /canvases/:id` 语义变更为软删（spec §3 + README ⚠ 双处明示，唯一行为变更）；`probe:m17` 全绿背书 M17 主链对 M18 代码零破坏。
- **生成主链 / M15 流水线画布零 diff**：engine / pipeline executor / dag / refs / loader 主链不触碰（`literal` 为新增 action、注册表超集，`loader.ts` 仅 +1 import 注册）；M15 `CanvasBoard` / `CanvasView` / `CanvasDrawer` 未改。
- **零新依赖**：fflate 已在 server 依赖（流式 zip 零新增）；无其他新包。
- **✅ 通过**

### #4 文档三件

- README：M18 能力速览节（设计三原则 + ⚠ 软删语义变更 + `Ctrl+G` + 精确端点/响应 shape + 验证行「九节 247 断言 + 回归适配 1 处」）。
- roadmap：M18 注记（性质 / 红线复核 / 明确排除 / 当前状态）+ M17 §8 排除项标注（成组 / 模板一键可运行〔M18 收〕）。
- 本文件（m18-review.md）。
- 对应 spec：`2026-09-14-agencys-content-studio-m18-design.md`（本文档依据）。
- **✅ 通过**

---

## 静态与探针

- **静态**：双端 typecheck exit=0；`apps/server/package.json` 仅 +`probe:m18` 脚本（dependencies 零新增）。
- **探针 `probe:m18` 九节**：见 #1 逐节构成；终判「全部通过」，247 项断言，exit=0。
- **口径备注**：spec §2.8 规划八节；实施为九节——**额外增设 `p1-schema` 节显式背书 P1 数据模型**（列 / 表 / 索引 / ensureColumn·ensureTable 幂等），其余八节与 spec 一致（frame-extract / compose-v3 / run-preview / trash-snapshot / llm-node / template-v2 / groups / scale-zip）；覆盖为 spec 超集，结论不变。回归采**独立跑 `probe:m16`**（其 regression 节内嵌 `probe:m15` 子进程 → m2a / m4 / m14 零漂移）+ `probe:m17`（M17 主链超集兼容基线）+ m3 / m6–m13。

---

## 偏差与修复记录

1. **probe-m16 级联删除断言随软删语义适配（回归期暴露，最小适配）**：M18 唯一破坏性行为变更（`DELETE /canvases/:id` 硬删→软删）使 `probe:m16` §canvas-doc 原断言「删画布 → 级联清空节点与边」FAIL。按 spec §5.1「适配量最小化并记录」+ M17 适配 probe-m16 先例，将该断言改为软删语义三断言群——`DELETE 画布 → 200（软删进回收站）` / `软删后 GET → 404（正常读取过滤回收站项）` / `软删 → 节点/边物理保留（可恢复，替代原「级联清空」）`；重跑 `probe:m16` 全绿（exit=0）。适配仅改断言期望、未动 M16 端点被测行为，**这是 M18 回归唯一 1 处探针适配**。
2. **探针口径增量（备注，非缺陷）**：`probe:m18` 九节 vs spec §2.8 八节——增设 `p1-schema` 节独立背书迁移，覆盖超集。
3. **工作副本混入非 M18 特性（提交范围警示，见「局限与备注」）**：当前未提交工作副本除 M18 创作画布改动外，另含一组**独立于 M18 spec 的并发特性**——`workspace/templates/{article-clip,note-clip,platform-adapt}.yaml`（平台名本地化 wechat/xiaohongshu → 公众号/小红书…）、`lib/format.ts`（记忆系统 purpose 文案 `memory` / `memory_log`）、`components/{Modal,AssetPreviewer,TemplateInputFields}.vue` + 新件 `lib/esc-layer.ts`（嵌套覆盖层 Esc 仲裁 + 启动流水线弹窗资产预览入口）。这些**不属于** M18 §2 / §4 枚举范围（M17 review 曾把「workspace 模板零 diff」列为红线，本批模板 diff 来自该并发特性而非 M18）。

---

## 局限与备注

- **快赢四枚浏览器 DOM 逐条 live 未做**：抽帧 / compose 转场·BGM / run-preview 定价 / 一键停止的端到端执行（真实 ffmpeg 抽帧与合成、fetch-stub LLM、`resolveUnitPrice` 定价）由 `probe:m18`（frame-extract / compose-v3 / run-preview + trash-snapshot 在途取消）在真实 ffmpeg / stub 网络下背书；Web 接线经 vue-tsc 0 + P2/P4/P6 阶段验证；本 P7 实弹聚焦新增且最易回归的「难面」（成组折叠 DOM、回收站与快照真实库 REST、流式导出真实产物、封面真实数据），未逐一重跑快赢浏览器 DOM。批量「加入实体参考」为前端接线（复用 M16 `POST /entities/:id/ref-assets` + 既有 `attachRefAssets`，零服务端改动），以 vue-tsc + P2h 背书。
- **封面 chips DOM 未直接露出**：`/creation?project=10` 自动选中最近画布（canvas5）跳过空态引导页，画布选择封面卡片 DOM 未直接观测；改以 `GET /canvases` 真实响应数据（canvas5=video #1332 / canvas4=image #1323）留证，cover 派生逻辑另由 `probe:m18` §scale-zip 断言群锁定。
- **LLM 真实计费执行未做**：`llm-node` 节以 fetch stub 走成功径（messages/max_tokens/stream 快照、多模态素材、文本资产落库、用量），避免真实计费与不确定性；真实供应商径由 M5+ 适配层既有能力保证。
- **截图证据不可用**：无头浏览器 `take_screenshot` 报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`（窗口隐藏）——实弹以 DOM 断言 + HTTP / DB / 资产留痕为准，无截图产出。
- **存量数据说明**：验证期新增导出资产 #1338（流式 zip 留档，对齐 M17 #1328 惯例保留）；实验性组（canvas5 组 id=1）与回收站/快照画布（临时 canvas8 + node31）于验证过程 REST 自清理，project10 回到原始画布集 `5,1,4,2` 无残留。
- **工作副本混入非 M18 特性（待用户裁决提交范围）**：见「偏差与修复记录 #3」——提交前须决定是「仅 M18 相关文件一次提交」还是「全工作副本一并提交」，或为并发特性单独成 commit。

---

## 附录

- **改动清单（git status 基线：M17 已 commit `edb5ade`；M18 工作副本）**：
  - **服务端新件**：`scripts/probe-m18.ts`（九节 247 断言）/ `pipeline/actions/literal.ts`（literal action）/ `services/creation-groups.ts`（成组 CRUD）。
  - **服务端改动**：`db/schema.ts`（+33，canvases `deleted_at` · canvas_nodes `group_id` · +`canvas_groups` · +`canvas_snapshots`）/ `db/index.ts`（+49，ensureColumn ×2 / ensureTable ×2）/ `services/creation.ts`（+886/−，端口 v3 · GEN_KINDS +llm · NodeSpec 转场/BGM/llm · InputPlan +textInputs · productKindOf +llm · `buildTemplateDraftYaml` v2 + lossy · listCanvases cover/trash 超集 · findCanvas 软删过滤 · 快照 CRUD + 保留 id 重放）/ `services/creation-gen.ts`（+677/−，buildComposeArgs v3 · preflightNode 拆分 · `executeLlmOnce` · extract-frame 执行辅助 · run-preview · cancelCanvasTasks）/ `services/creation-export.ts`（+113/−，fflate 流式 zip）/ `services/creation-ops.ts`（batch cancel / copy 忽略 groupId）/ `pipeline/actions/ai-text.ts`（+16/−，prompt_inline）/ `pipeline/actions/index.ts`（+2，literal 注册）/ `pipeline/loader.ts`（+1，literal import）/ `routes/creation.ts`（+192/−，+14 端点 · DELETE 软删 · 统一装载点过滤）/ `services/usage.ts`（+77/−，`resolveUnitPrice` 抽公共供 run-preview 与 recordUsage 同源）/ `scripts/probe-m16.ts`（软删语义适配）/ `package.json`（+`probe:m18`）。
  - **Web 改动（M18）**：`lib/types.ts`（+87/−，groups/groupId/cover/llm/lossy 超集）/ `lib/api.ts`（+58/−，+14 API）/ `components/CreationBoard.vue`（+324/−，组框渲染/折叠隐藏/组条拖拽·重命名·改色·解组/Ctrl+G/选择封面卡片 + `.cgroup*` CSS）/ `views/CreationView.vue`（+726/−，顶栏停止全部·快照抽屉·试跑·回收站入口·lossy；批量面板预估成本·加实体参考·成组；画布选择封面 chips + `groups` computed + 三 handler）/ `components/CreationInspector.vue`（+189/−，抽帧按钮 · compose 转场/BGM · llm 表单与产物文本 · 实体参考）。
  - **非 M18 特性（并发工作副本，见偏差 #3）**：`apps/web/src/lib/esc-layer.ts`（新件，Esc 层栈）/ `components/{Modal,AssetPreviewer,TemplateInputFields}.vue`（嵌套 Esc 仲裁 + 资产预览入口）/ `lib/format.ts`（记忆 purpose）/ `workspace/templates/{article-clip,note-clip,platform-adapt}.yaml`（平台名本地化）。
- **红线零 diff 明细**：engine / pipeline executor / dag / refs / loader 主链 / M15 三组件（CanvasBoard / CanvasView / CanvasDrawer）/ 适配器 零 diff（`git status` 核查）；`schema.ts` 仅 +2 列 +2 表（设计 §2.1 白名单）；`loader.ts` 仅 +1 import；**workspace 模板的 diff 属并发特性非 M18**（M18 本体不动模板）。
- **实弹清单**：项目 10 · 画布 5「M17实弹」（成组 id=1 全链 DOM、导出资产 #1338、cover 派生）+ 回收站/快照自清理画布 canvas8（node31，snapshot sid=1，restore `nodeIdKept=True`）；全程自清理，project10 回到 `5,1,4,2`。

---

## 验证方式（已完结）

- 静态：`pnpm --filter @acs/server typecheck` + `pnpm --filter @acs/web typecheck` → exit=0
- 探针：`pnpm --filter @acs/server probe:m18`（九节 247 项）+ 独立回归 `probe:m16`（内嵌 `probe:m15` → m2a / m4 / m14）+ `probe:m17` + m3 / m6–m13 → 全 exit=0（唯一适配：probe-m16 软删语义 1 处）
- 实弹：真实库 REST + 无头浏览器 DOM（运行态 :3001 + :5174；成组折叠全链 / 回收站与快照自清理 / 流式导出真实产物解压 / 封面数据留证）
- 采集时间：2026-09-14（M18 P7 批次，服务运行态）
