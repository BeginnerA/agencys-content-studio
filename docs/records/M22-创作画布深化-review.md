# agencys-content-studio M22 里程碑 review

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-16
- 对应 spec：`2026-09-16-agencys-content-studio-m22-design.md`（§4 验收 + §6 实施）
- 判定：**探针十一节 169 项全绿 + 回归 m2a–m19 / m21 共 18 探针零适配全绿（164.5s）+ 双端 typecheck 绿 + 三层实弹（HTTP API 16 PASS〔真实库跨项目〕/ 浏览器 e2e 8/8 / 修复复核 PASS）**；收口期 1 处前端缺陷（f）修复并复核；临时数据全量清理（回收站终态为空）
- 证据采集方式：`probe:m22` 十一节 **169 项断言**（内存 HTTP `app.request` + 独立临时库 `acs-probe-*`，零网络零计费——唯 S9 使用本机 ffmpeg 生成 testsrc 2s 测试视频〔本地合成，无外呼〕）+ 回归 `probe:m2a / m3 / m4 / m6~m19 / m21` **18 个探针全部 exit=0「全部通过」，零适配**（2026-09-16，总耗时 164.5s）+ 双端静态（server `tsc` / web `vue-tsc` exit=0）；真实开发库实弹（:3001 + :5174）；浏览器 e2e（DOM 断言 + toast 文本驱动；NATIVE_BROWSER_VIEWPORT_UNAVAILABLE 下放弃截图改 DOM）

---

## 结论摘要

- **创作画布深化九项一次交付，纲领 §一 B 组清零**：批 1（①音字对齐全链 / ②参考边保真 v3）+ 批 2（③组嵌套 / ④快照 diff·分支 / ⑤智能裁剪）+ 批 3（⑥回收站自动清理 / ⑦跨画布复制 / ⑧PNG·SVG 导出 / ⑨多帧抽帧）。
- **缺省全关零漂移**：compose 新字段（align / subtitle / subtitleAssetId / burnSubtitles / fit）全默认关，回归 probe-m16 / m17 / m18 零适配为证；probe-m11 合成快照红线未动一行。
- **三层实弹收口全延续**：service 探针 → HTTP API 实弹 → 浏览器 UI e2e；P2 实弹抓出并修复 5 处缺陷（a–e），P3 收口期 e2e 抓出并修复 1 处（f，前端双路径共同修复）。
- **跨项目复制真实库验收**：P10 → P14 真实库往返（9 复制 / 1 run 跳过 / 6 资产级联拷贝 / 0 警告），源文件字节级拷贝 + `copiedFrom` 留痕 + 实体级联 `refAssetIds` 重写全部对账。
- **实弹留痕（真实数据）**：⑦ 同项目偏移 +7/+9 与跨项目全量；⑧ SVG 5161 字符落资产 #1375 可下载 + PNG 400 守卫；⑨ 真实视频 #26 均匀 3 帧网格落位（+0/+260/+520，首帧 0.1s）；⑥ settings 读取正常；e2e 四条 toast 原文留痕（复制「已复制 1 个节点到「未命名画布」」/ SVG「已导出 SVG（资产 #1379）：未命名画布.svg」/ PNG「已导出 PNG（2x 光栅化）：未命名画布.png」/ 抽帧「已均匀抽取 3 帧（节点 #69、#70、#71）」）。
- **清理纪律**：测试画布 C18/C19/C20 软删 + purge；抽帧节点 #69/#70/#71 与复制节点删除；回收站终态为空；P14 C11（0 节点）为更早会话历史遗留（ID 早于本轮全部产物），未清理留痕。

---

## 验收逐条对照（spec §4）

### #1 音字对齐
- **操作**：probe align 节 + P1 实弹全链。
- **证据**：25 项——`planAlignedSegments` 配对/时长决策/降级 null；对齐链快照（视频 `tpad` 冻帧 / 音频 `apad+atrim+concat` / 转场互斥 / BGM 兼容）；`buildSegmentSrt` / `parseSrtCues` / `retimeSrtCues`（生成/平移/数量不符降级）；烧录路径转义串；缺省 args 快照零漂移。
- **✅ 通过**

### #2 参考保真
- **操作**：probe refs 节 + P1 实弹（模板试跑参考注入）。
- **证据**：12 项——`collectRefAssetIds` 合并（前插/去重/截断）；ai-video 首帧「画布直通 > gen_frames 索引」优先；literal refs 注入 flatten（数字/数组/嵌套/非法过滤）；draft YAML 断言（refs 表达式在内；lossy 不含两类；last_frame 仍 lossy）。
- **✅ 通过**

### #3 组嵌套
- **操作**：probe group-nest 节 + schema 节 + P2 实弹（API 32/32 + e2e）。
- **证据**：18 项——createGroup 嵌套合并/拒绝码；updateGroup 移组防环（自环/后代环）；deleteGroup 子组提升；快照含 parentId 重放往返；`canvas_groups.parent_id` ensureColumn 幂等。
- **✅ 通过**

### #4 快照 diff/分支
- **操作**：probe snapshot-diff 节 + P2 实弹（diff 视图 / 分支画布）。
- **证据**：18 项——`diffSnapshotDocs` added/removed/modified 字段级/截断；branch 重放映射（groupId/parentId/边端映射）。
- **✅ 通过**

### #5 智能裁剪
- **操作**：probe fit 节 + P2 实弹。
- **证据**：4 项——crop 链快照完整串；pad 缺省零漂移。
- **✅ 通过**

### #6 回收站
- **操作**：probe trash 节 + 实弹 settings 读取。
- **证据**：12 项——`selectExpiredCanvases` 边界（null/未过期/恰好边界/过期/retentionDays 1 与 365）；settings.trash 缺省内置默认读取；`purgeExpiredCanvases` 复用 purgeCanvas 级联。真实库实弹：`GET /settings` trash 读取正常。
- **✅ 通过**（6h 周期真实触发见「局限与备注」）

### #7 跨画布复制
- **操作**：probe copy-to 节（23 项）+ HTTP 实弹 16 PASS + 浏览器 e2e。
- **证据**：同项目 5 断言（偏移/内部边重映射/groupId 不拷/assetId 原样/adoptedTaskId 保留）；跨项目 18 断言（真实文件字节级拷贝 + `copiedFrom` 留痕 / 6 节点输入 4 复制 2 跳过〔run 节点 `cross_project_run_node` + 缺资产 `missing_asset` 警告〕/ assetsCopied 去重 / 实体级联 `refAssetIds` 重写 / 坏 spec 保真 / src=target 抛错）；真实库 P10 → P14 全量往返。
- **✅ 通过**

### #8 PNG/SVG
- **操作**：probe export-svg 节（23 项）+ 实弹导出下载 + e2e 菜单与双 toast。
- **证据**：xmlEscape 五字符 / 标题截断 / `svgBezier` 与 48 下限 / 色板常量表 / `computeSvgGroupBoxes` 嵌套（深度排序父先）/ `buildCanvasSvg` 结构（节点/组/悬空边排除/边几何）/ 视口并集（空画布 980×720 / 远节点 1300×720）/ `writeTextAsset` svg 往返；实弹 SVG 5161 字符落资产 #1375 可下载 + PNG 400 守卫。
- **✅ 通过**

### #9 多帧抽帧
- **操作**：probe multi-frame 节（23 项）+ 实弹 + e2e。
- **证据**：`frameTimesOf` 纯函数矩阵（uniform×2/3/9 / count 缺省 / 边界 1 与 10 报错 / 时长缺失报错 / dur≤0.3 退化 / 非 uniform 直通）；真实 ffmpeg 全链（testsrc 2s → 3 帧与 4 帧抽取：网格坐标 / params index·count·timeSec / JPEG FFD8 魔数 / 换行）；实弹真实视频 #26 三帧落位。
- **✅ 通过**

### #10 工程项
- **探针**：`probe:m22` 169 项全绿；回归 18 探针零适配（见「静态与探针」）。
- **类型**：server `tsc` / web `vue-tsc` 双端 exit=0。
- **三层实弹**：HTTP API 16 PASS + 浏览器 e2e 8/8 + 修复复核 PASS。
- **文档**：本 review 落盘 ✅；roadmap M22 注记校准 ✅；README「M22 能力速览」✅；L1 spec §6 批次标 ✅；`probe:m22` 注册入 package.json ✅。
- **✅ 通过**

---

## 静态与探针

- **变更面**：47 文件（39 修改 + 8 新增）。
- **服务端**：新增 `services/creation/copy-to.ts` / `services/creation/export-svg.ts` / `services/creation/gen/subtitle.ts` / `services/creation/snapshot-diff.ts` / `services/trash-sweep.ts` / `scripts/probe-m22.ts`；修改 `routes/creation.ts`（4 新端点 + 3 扩展）、`services/creation/{doc,draft,groups,index,ops,snapshots,spec,storage}.ts`、`services/creation/gen/{compose-args,execute,frame}.ts`、`db/{schema,index}.ts`、`index.ts`、`pipeline/actions/{ai-image,ai-video,literal}.ts`、`pipeline/refs.ts`、`package.json`。
- **Web**：新增 `views/creation/CanvasCopyToModal.vue` / `views/creation/use-canvas-copyto.ts`；修改 `components/creation/inspector/{GenForm.vue,index.vue,use-inspector-form.ts}`、`components/creation/board/{index.vue,internals.ts,use-board-interactions.ts}`、`views/creation/{index.vue,CanvasBoardArea.vue,CanvasSnapshotsModal.vue,CanvasToolbar.vue,use-canvas-export,use-canvas-groups,use-canvas-snapshots,use-canvas-view}.ts`、`lib/{api.ts,types/creation-canvas.ts}`、`views/system-settings/index.vue`。
- **红线守住**：生成主链零改动（shots 直通 / literal refs 均为新增可选字段，无字段时行为逐位一致）；无新表（`canvas_groups` +1 列 / `settings` +1 key）；手绘先例零新依赖（SVG 字符串拼接 + 浏览器原生光栅化）。
- **探针明细**：spec-fields 9 / trash 12 / schema 2 / align 25 / refs 12 / group-nest 18 / snapshot-diff 18 / fit 4 / copy-to 23 / export-svg 23 / multi-frame 23 = **169**；回归日志 `.qoder/tmp-m22-probe-logs/`（19 个日志全量留档）。

## 偏差与修复记录

| # | 来源 | 问题 | 修复 | 复验 |
|---|---|---|---|---|
| a | P2 实弹 | `doc.ts` groups 投影漏 `parentId`（前端嵌套渲染静默失效） | 补投影 + 探针补盲断言 | probe + e2e |
| b | P2 e2e | `.cgroup` `z-index:0` 层叠上下文锁组菜单（点击穿透选节点） | 修复层叠（M18 结构遗留一并惠及色板/解组） | e2e |
| c | P2 验收核查 | 折叠父组未隐藏后代组框（「递归隐藏全部后代」未达标） | `hiddenGroupIds` 递归并集 | probe + e2e |
| d | P2 实弹 | 保存 spec 后「有未保存修改」提示残留 | `markFormSaved` 重置基线（saveSpec / persistFormIfNeeded / doRun） | e2e |
| e | P2 e2e | 分支命名 placeholder 与缺省「源画布名 分支」不一致 | 文案对齐 | e2e |
| f | P3 收口 e2e | 复制 / 抽帧后画布下拉计数不刷新（`doCopyTo` 只刷文档 + inspector `@refresh` 只刷文档） | copyto 注入 `loadCanvases` 并调用 + `index.vue` `onInspectorRefresh` 双刷（文档 + 目录） | vue-tsc + e2e 复核 PASS（目标画布 2→3 即时刷新） |

## 局限与备注

- **⑥ 定时触发未真实等待**：sweep 的启动执行 + 6h 周期以纯函数边界（12 断言）+ 机制审阅背书；真实周期触发将在下次服务启动自然覆盖（启动即执行一次）。
- **浏览器截图不可用**：e2e 全程 NATIVE_BROWSER_VIEWPORT_UNAVAILABLE，证据以 DOM 断言 + toast 原文为准（非实现风险）；⑧ PNG 光栅化产物（2x）以 toast 与下载触发为准，未做像素级核验。
- **历史遗留**：P14 C11（0 节点空画布，ID 早于本轮全部产物）与 P10 C2（0 节点）为更早会话遗留，未清理留痕。
- **跨项目拷贝存储放大**：属预期（自包含优先，spec §5 已登记）；响应报 `assetsCopied` 可供感知。

## 附录

- 探针日志：`.qoder/tmp-m22-probe-logs/`（m22 + 18 回归，2026-09-16，164.5s）。
- 相关文档：L1 spec `2026-09-16-agencys-content-studio-m22-design.md`；纲领 `2026-09-14-agencys-content-studio-m19-m27-charter.md`（§一 B 组）；roadmap M22 注记（本日校准）。

## 验证方式（已完结）

- 复跑：`pnpm --filter @acs/server probe:m22`（十一节 169 项）；回归 `probe:m2a / m3 / m4 / m6~m19 / m21`；`npx tsc --noEmit`（server）+ `npx vue-tsc --noEmit`（web）。
