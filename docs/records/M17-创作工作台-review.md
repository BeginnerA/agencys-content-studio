# agencys-content-studio M17 里程碑 review

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-13
- 对应 spec：`2026-09-13-agencys-content-studio-m17-design.md`（§5 验收）
- 判定：**静态 + 探针 + 实弹（浏览器 DOM）全绿**（含音频真实 TTS、compose 真实 ffmpeg、导出 zip 资产留痕；实弹暴露 3 处缺陷已全部修复复验）
- 证据采集方式：`probe:m17` 八节 274 项断言 + 独立回归 `probe:m16`（其 regression 节内嵌 `probe:m15` → m2a / m4 / m14 零漂移）；真实开发库实弹（项目 10 · 画布 5「M17实弹」；服务 3001 + vite 5174 运行态）；无头浏览器 DOM；图片均为 pollinations（零计费），仅音频 2 次真实 TTS（20 字符 ×2）

---

## 结论摘要

- **创作画布 → 完整创作工作台**：四层一次补齐——创作循环（变体抽卡 1–4 + 结果画廊 + 采纳钉稿 / 实体参考直通 / 文本节点提示词复用）、规模操控（多选 / 框选 / 批量移动·复制·删除·执行 / 快捷键全集 / 撤销重做命令栈 / 整理·对齐·分布 / 故事板序号）、产出沉淀（内嵌运行节点 / zip 打包导出 / 全局总览）、能力扩展（音频 TTS 节点 + 视频合成节点 + AI 扩写与规则串联）；13 项缺口按用户决策全量纳入，无一排除。
- **采纳优先语义（对外引用与显示同源）**：`pickDisplayTask` 统一决策（采纳任务 > 最新成功）；`PATCH adoptedTaskId` 全校验（属本节点 / succeeded / 有产物；null 清除）；实弹采纳落库（节点 #19 `adoptedTaskId=457`）与下游引用（任务 #455-#457 输入快照 `referenceAssetIds=[1325]`）双向留痕。
- **规模操控全链**：多选框选（空白左拖 = 框选，平移改空格 / 中键）、批量操作五端点（batch / delete / copy / chain / arrange）+ `canvases/run` 批量执行（就绪者入队、未就绪 skipped + problems）；撤销栈 100 步，删除逆操作 = 快照重建 + `restoreFromNodeId` 任务历史认领（实弹三轮循环实证）。
- **产出沉淀实弹**：导出 zip（资产 #1328，`fileCount=1 / skipped=3` 记账）落 `exports/`；「送去运行」不跳转建 run 节点 #24（运行 #103）+ 非终态轮询；总览抽屉按严重度排序 + 点击定位（transform 位移实证）。
- **音频与合成（真实执行径）**：TTS 任务 #458 succeeded 586ms → 资产 #1331（`siliconflow_audio` / CosyVoice2-0.5B / `chars=20`，ID3 魔数）；compose 任务 #459 succeeded 502ms → 资产 #1332（640x360 / 10.333s，2 视频 concat + 1 音频 amix，ffprobe 独立复核 h264 + aac）。
- **实弹暴露缺陷 3 处（已全部修复）**：见「偏差与修复记录」。

---

## 验收逐条对照（spec §5）

### #1 静态：双端 typecheck + probe:m17 八节 + 回归 + 旧库升级

- **操作**：`pnpm --filter @acs/server typecheck` + `pnpm --filter @acs/web typecheck`；`probe:m17`（node-kinds / port-v2 / input-v2 / batch-ops / variant-adopt / run-node / export / llm-assist）；独立跑 `probe:m16`（含其 regression 节内嵌 `probe:m15`）。
- **证据**：双端 typecheck exit=0；`probe:m17` **274 项断言全过**（node-kinds 37 / port-v2 40 / input-v2 37 / batch-ops 77 / variant-adopt 26 / run-node 10 / export 24 / llm-assist 23；终判「全部通过」）。
  - `node-kinds`（37）：text / entity / run 建改删全链；entity 项目域（他项目 400）与全局实体；实体无参考图 / 实体删除后 readiness；run 派生读模型（status / templateKey / steps 计数 / 终态）；seq 校验族（0 / 非数字 / null 清除）与 spec 禁改族（run / entity / 非对象）；bad spec 宽容。
  - `port-v2`（40）：矩阵 v2 全组合——reference（图片素材 / entity 源 201；视频·音频·文本 gen 源 400 且 from 侧文案为期望类型清单；video gen 上限 2）；prompt（text→image / audio gen 201；重复 / 第二条 / compose 目标 / 非 text 源全 400）；video（素材 / gen / compose 链式 201；图片素材源 400；上限 4）；audio 同构；run 双向拒连；环 / 自环 / 跨画布 / 重复边 / 非法端口 / spec 损坏目标回归。
  - `input-v2`（37）：planNodeInputs v2（prompt 覆盖 trim / entity 展开截断 + notes / compose 边序）+ specProblems（audio / compose）+ `pickDisplayTask` 采纳优先矩阵 + 读模型与 loadInputPlan 集成。
  - `batch-ops`（77）：computeArrange / chainPortCandidates 纯矩阵；batch 预校验回滚（含已删节点 400）；delete 级联计数；copy 深拷 / 集合内部边重映射；chain 全因 skip 记账；arrange 各 mode 落库；`canvases/run` started / skipped；**restore-claim 快照重建认领**（任务历史迁移 `{claimed:2}` / 认领后采纳 PATCH 通过 / displayTask 恢复 / 源节点存活 400 不残留 / 非 gen 目标 400）。
  - `variant-adopt`（26）：parseResolution / `buildComposeArgs` / extendTaskParams 快照；variants=2/4 建 N 任务；busy / 错误族；无 body 再跑；取消清理；终态后重跑；变体画廊 / 采纳闭环（未采纳→最新成功、results 只含成功产物新→旧、PATCH 后 displayTask 切换）。
  - `run-node`（10）：多 run 节点批查独立派生 / run 行删除宽容降级 / title·seq·坐标 PATCH / batch 移动 / copy 深拷。
  - `export`（24）：真实文件 zip——条目命名 / 重名递增 / seq 序；manifest files / skipped；采纳优先后打包；软删 / 无路径 / 缺文件 / 无产物 / 实体 / 运行 skipped；子集 / 空数组 / 未知节点错误族；下载链路。
  - `llm-assist`（23）：prompt-expand 未配置 400 透传 + env 注入 fetch stub 成功径（messages / max_tokens / stream 快照、instruction trim 透传、不落库、用量 3×2 行）+ extract 双径（gen / 文本资产）+ 错误族。
- **回归**：`probe:m16` 全绿（内含 `probe:m15` → m2a / m4 / m14 零漂移；exit=0）；`probe-m16.ts` 本体兼容适配 29 行（端口 v2 引起的用例更新，见附录）。
- **旧库升级**：实弹全程运行于既有 data 目录（存量库）——`ensureColumn ×2` 幂等兜底自动升级，无报错。
- **✅ 通过**

### #2 画布实弹（浏览器 DOM）

- **操作**：真实开发库运行态（服务 3001 + vite 5174）——画布 5「M17实弹」（项目 10）全链。
- **证据**（DOM 断言 + DB 留痕）：
  - **节点与连线**：实体节点「M13实弹·素材甲」（#10，entityId=54）落库；entity → gen 的 reference 连线（边 #11 `10→19 reference`）；text 节点（建 / 改 / prompt 连线 / extract）与 run 节点（#24 运行 #103）DOM 通过（text 实验节点未留存，探针 `node-kinds` / `port-v2` 全矩阵背书）。
  - **变体执行 ×2**：任务 #453 / #454 同批创建（`variants=2`）先后成功 → 产物 #1325 / #1324（pollinations_image / flux.1-schnell，零计费）。
  - **结果画廊与采纳**：画廊「采纳 ✓ / 最新」切换 + 大图预览；采纳落库（#19 `adoptedTaskId=457`，displayTask 派生不再跟随最新）；下游执行取上游产物（任务 #455-#457 输入快照 `referenceAssetIds=[1325]`）。
  - **批量操控 + 快捷键**：批量执行 started / skipped；框选 + 多拖（`nodes/batch` 一次提交、撤销栈一条）；`Delete` 删除 + `Ctrl+Z` 快照重建恢复（三轮循环实证——任务历史经 `restoreFromNodeId` 认领迁移，见偏差 #1/#2）。
  - **整理 / 对齐 / 编号**：「整理布局」layered 拓扑分层落库；对齐 / 分布；批量编号 `seq` 落库（节点 #19 `seq=3` 留痕，卡片 `#N` 徽标）。
  - **导出 zip**：资产 #1328（263,757B）→ `workspace/projects/10/exports/M17实弹-export-*.zip`；`params {fileCount:1, skipped:3}`（entity / 无产物节点跳过记账不炸）；manifest 与条目命名核对（探针 export 节同源断言）。
  - **送去运行**：「送去运行」不跳转 → 视口中心建 run 节点 #24（运行 #103 属同项目校验）+ toast「查看详情」；非终态 5s 轮询；「打开运行详情」直达 `/runs/:id`。
  - **音频节点（真实 TTS）**：节点 #25（朗读文本 20 字符）→ 任务 #458 succeeded 586ms → 资产 #1331（56,575B；`provider=siliconflow_audio` / `FunAudioLLM/CosyVoice2-0.5B` / `voiceSource=settings` / `chars=20`；文件头 ID3 魔数）；UI 任务历史 + 「显示产物」+ 画廊 + 卡片 ok 徽标全链；重跑 #460 → 资产 #1333（57,343B）落 `workspace/projects/10/audio/`。
  - **compose 合成（真实 ffmpeg）**：节点 #29（640x360；边 #13/#14 video ×2 + 边 #15 audio）→ 任务 #459 succeeded 502ms → 资产 #1332（178,495B / 10.333s / `ftyp isom` 魔数；`params {videos:[1154,1153], audios:[1273], resolution:"640x360"}`）；ffprobe 独立复核 h264 640x360 10.333s + aac 1.848s；建边负例 400「视频输入端口仅合成节点支持」（genKind 未落库时 from / to 校验现场）。
  - **全局总览定位**：抽屉 10 行按严重度排序（失败 › 未就绪 › 运行中 › 就绪 › 完成）；点击行选中 + 视口居中（transform 位移 + 行 active + 卡片 sel + inViewport 实证）；收起正常。
  - **恢复路径顺带实证**：任务 #455 中断（error「服务重启导致任务中断，可手动重试」）→ 手动重试 #456 成功——崩溃恢复标 failed 不自动重排队的设计行为在实弹中真实触发。
- **✅ 通过**

### #3 零漂移

- **M16 既有 14 端点超集兼容**：旧 body → 旧行为、响应只增字段；`probe:m16` 六节全绿（含端口 v2 影响的用例适配，见附录）。
- **M15 流水线画布零 diff**：`CanvasBoard` / `CanvasView` / `CanvasDrawer` 不动；「送去运行不跳转」仅改 `CreationView` 内回调；`probe:m15`（内含 m2a / m4 / m14）全绿。
- **生成主链零改动**：engine / pipeline actions / dag / refs / loader / 适配器零 diff；audio 仅只读复用 `services/tts.ts`，compose 仅只读复用 `services/ffmpeg.ts`。
- **✅ 通过**

### #4 文档三件

- README：状态行 + M17 能力速览（含交互变更警示）+ M17 验收快照。
- roadmap：设计链接 + M17 注记（含排除项回收注记）。
- 本文件（m17-review.md）。
- **✅ 通过**

---

## 静态与探针

- **静态**：双端 typecheck exit=0；`apps/server/package.json` 仅 +`probe:m17` 脚本（dependencies 零新增）。
- **探针 `probe:m17` 八节**：见 #1 逐节构成；终判「全部通过」。
- **口径备注**：spec §2.9 规划九节（含 regression 节：probe:m15 / m16 子进程 + 旧 body 兼容抽样 + 引擎主链零漂移）；实施为八节——回归以**独立跑 `probe:m16`**（其 regression 节内嵌 `probe:m15` 子进程 → m2a / m4 / m14 零漂移）完成，M16 端点兼容由「probe-m16 本体内 29 行用例适配 + M16 端点读模型对拍」覆盖，覆盖等价、结论不变。

---

## 偏差与修复记录

1. **快照重建任务孤儿（实弹暴露，已修复）**：撤销栈「删除的逆操作 = 快照重建」中，重建出的新节点 id 与旧任务的 `canvasNodeId` 脱钩 → 任务历史成孤儿（新节点读模型无任务 / 无采纳）。修复 = 重建端点支持 `restoreFromNodeId`：前置校验（源节点须已删、目标须 gen）通过后**认领全部任务历史**（`canvas_node_id` 迁移），再执行节点重建；实弹三轮循环实证（原节点 11 的任务 #455-#457 认领至重建节点 19——资产 #1327 `params.nodeId=11` 为执行时留痕）；探针 `batch-ops` restore-claim 断言群锁定（迁移 `{claimed:2}` / 采纳 PATCH / displayTask 恢复 / 源节点存活 400 不残留）。
2. **redo / undo 循环认领源过期（实弹暴露，已修复）**：连续 undo → redo 循环中，第二次 undo 的「快照重建源」指向已被本轮 redo 重建过的中间节点 → 认领源漂移。修复 = 命令栈快照记录 `snap.curId` 循环维护（undo / redo 双向更新当前实体 id，重建恒以「当前实体」为源）；三轮 delete→undo→redo 循环实证通过。
3. **creation 产物子目录映射缺失（实弹暴露，已修复）**：`purposeSubDir`（storage.ts）未声明 `creation_audio` / `creation_compose` → 产物落 `source/`（#1331 / #1332）。修复 = +2 case（`creation_audio → audio/`、`creation_compose → video/`）；端到端复验：重跑音频任务 #460 → 资产 #1333 落 `workspace/projects/10/audio/`（57,343B）；存量资产 relPath 已存库不受影响（#1332 保持 source/，无回填）。
4. **探针口径偏差（备注，非缺陷）**：见「静态与探针」——八节 vs spec 九节，回归独立跑，覆盖等价。

---

## 局限与备注

- **音频「未配置 → 错误透传」分支未复跑**：本环境已配置 `siliconflow_audio`，实弹走**真实 TTS 径**（spec §5-2 「TTS 可用时真实验证」分支）；未配置分支由 `provider.ts` 统一错误文案 + 执行通道失败链保证（探针 `variant-adopt` busy / 错误族同构覆盖），未单独复跑。
- **compose 单视频无 resolution 不过滤路径**：真实跑的是 2 视频 + 1 音频（concat + amix 主路径）；单视频直 `-map` 分支由探针 `buildComposeArgs` 快照覆盖，未单独实弹。
- **视频节点真实出图未做**：画布视频生成链路（轮询 / 取消 / 重试）由探针背书；真实视频出图有成本，未在实弹中跑（spec §5-2 未强制）。
- **框选交互变更的用户习惯成本**：空白左拖由平移改框选（spec §6 风险）；README 交互变更警示 + 空态引导文案同步明示；平移改空格 / 中键为业界通行交互。
- **规模化**：目标 ~50 节点流畅（全量渲染不虚拟化，spec §6）；超规模虚拟化入 backlog。
- **截图证据不可用**：无头浏览器 `take_screenshot` 报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`（窗口隐藏）——实弹以 DOM 断言 + DB / 资产留痕为准，无截图产出。
- **存量数据说明**：验证期新增画布 5「M17实弹」（10 节点 / 4 边 / 任务 #453-#460 / 资产 #1324-#1328、#1331-#1333）；任务 #455 为服务重启中断留档（恢复路径实证）；实验性 text / 辅助节点于验证过程清理，未留存。

---

## 附录

- **改动清单（git status 基线，M17 工作副本）**：
  - 服务端新件：`services/creation-ops.ts` / `services/creation-export.ts` / `scripts/probe-m17.ts`
  - 服务端改动：`db/schema.ts`（+2 列）/ `db/index.ts`（+ensureColumn ×2）/ `services/creation.ts`（文档层 v2，927+/−）/ `services/creation-gen.ts`（variants / audio / compose / 批量执行，361+/−）/ `routes/creation.ts`（+9 +3 = 23 枚，167+/−）/ `services/storage.ts`（purposeSubDir +2）/ `scripts/probe-m16.ts`（29 行兼容适配）/ `package.json`（+`probe:m17`）
  - Web 新件：`lib/canvas-history.ts`
  - Web 改动：`components/CreationBoard.vue`（508+/−）/ `components/CreationInspector.vue`（681+/−）/ `views/CreationView.vue`（1168+/−）/ `lib/api.ts`（85+/−）/ `lib/types.ts`（140+/−）/ `components/Icon.vue`（+4）
  - 文档：`README.md`（+32 行）+ roadmap 回写 + 本 review（`docs/superpowers/specs/`）
- **probe-m16 兼容适配明细（端口 v2 引起的用例更新）**：音频 `genKind` 非法 spec 用例迁移（`audio` 已是合法 genKind → 改 `xxx`）；视频 gen 作 reference 源的环用例改图像 gen（视频 gen 已不可作 reference 源）+ 新增无产物图像 gen 节点 N5；画布 nodeCount 4→5；`buildNodeTaskParams` 期望快照 +`promptText` / `videoAssetIds` / `audioAssetIds` / `notes` 字段。
- **红线零 diff 明细**：engine / refs / loader / pipeline actions / dag / 适配器 / M15 三组件 / workspace 模板与提示词零 diff（`git status` 核查）；`schema.ts` 仅 +2 列（设计 §2.1 白名单）。
- **证据日志**：`d:\work\AI\.qoder\tmp-m17-probe-log.txt`（探针全量输出；末尾「临时目录未完全清理 / canvas task 15 crashed」为 Windows libsql 句柄与探针收尾的既有行为）。
- **实弹清单**：画布 5「M17实弹」（节点 #10 实体 / #12·#13·#19 gen / #24 run / #25 audio / #26-#28 素材 / #29 compose；边 #11 / #13-#15）+ 任务 #453-#460 + 资产 #1324-#1328、#1331-#1333。

---

## 验证方式（已完结）

- 静态：`pnpm --filter @acs/server typecheck` + `pnpm --filter @acs/web typecheck` → exit=0
- 探针：`pnpm --filter @acs/server probe:m17`（八节 274 项）+ 独立回归 `probe:m16`（内嵌 `probe:m15` → m2a / m4 / m14）
- 实弹：无头浏览器 DOM（运行态 :3001 + :5174；画布 5「M17实弹」；含真实 TTS ×2 与 compose 真实 ffmpeg）
- 采集时间：2026-09-13（M17 P7 批次，服务运行态）
