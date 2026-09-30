# agencys-content-studio M21 里程碑 review

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-16
- 对应 spec：`2026-09-16-agencys-content-studio-m21-design.md`（§5 验收）
- 判定：**六节探针 86 项全绿 + 回归 m2a–m19 共 17 探针零适配全绿 + 双端 typecheck 绿 + 实弹（C6/C7 深实弹，C1/C4/C5 冒烟，C3 探针级）**；收口期浏览器视图被关闭（CDP 断连），palette 搜索结果渲染 / 通知权限全链 / tags 浏览器链三项待用户重开视图后补验（见「局限与备注」）
- 证据采集方式：`probe:m21` 六节 **86 项断言**（内存 HTTP `app.request` + 独立临时库 `acs-probe-*`，零网络零计费——空模板快照 run 零步骤零 LLM；语义段因临时目录无模型走降级路径并有日志佐证）+ 回归 `probe:m2a / m3 / m4 / m6~m19` **17 个探针全部 exit=0「全部通过」，零适配**（2026-09-16 12:07:27–12:09:36；`probe:m11` 合成快照 / `probe:m4` 批次语义两条红线未改一行）+ 双端静态（server `tsc` / web `vue-tsc` exit=0）；真实开发库实弹（:3001 + :5174；waiting_input run 103 项目 10 · 终态 run 105）；无头浏览器 DOM 断言（`evaluate_script` 驱动，NATIVE_BROWSER_VIEWPORT_UNAVAILABLE 下放弃截图改 DOM）

---

## 结论摘要

- **工作台体验七项一次交付**：批 1 快赢三枚（C1 全局搜索〔九域关键词 + 文本域语义 + reindex〕/ C2 浏览器通知 / C3 tags UI 含 `?tag=` 分页错位修正）+ 批 2（C4 命令面板九动作 / C5 Gate diff 自研 LCS）+ 批 3（C6 全局并发闸门 / C7 参数热调），纲领 §一 C 组七项清零。
- **两泵互补机制在收口期补全并锁定**：全局闸门（`settings.concurrency` → env → 默认 3，1–6 clamp）与批调度（`max_concurrent`）经「settle → `notifyRunSettled` → 批 pump + 全量扫停滞批」协同；review 发现「批 settle 释放槽位不扫其它批」的第二缺口，修复后探针新增**批间救援**双断言（批 C 双 run 占满 → 批 D defer → 批 C settle 救起批 D，缺口版永久滞留），30s 定时器兜底亦复用 `pumpStalledBatches`（评审建议原样落地）。
- **C7 热调零引擎改动生效**：`PATCH /runs/:id/params` 组内字段级深合并 + `_params_log` 追加留痕 + 无变化幂等 + 状态门三态；生效依赖 `createStepContext` 每步重读（未执行步骤取新值，已执行与 in-flight 不动）；收口期把 UPDATE 改为**条件写**（状态三态条件 + `rowsAffected` 检查），闭合检查与写入间的终态竞态。
- **review 五项修复全部落地并复验**：P0 批间救援缺口（`notifyRunSettled` 属批分支不再提前 return + `pumpStalledBatches` 导出复用）；P1 资产预览器标签「陈旧快照回写复活已删标签」（`tagState` 本地基准覆盖层 + `curTags` 模板接管）；P2×3（热调条件写 / `PUT /settings/concurrency` 即改即生效刷新引擎缓存 / tag 过滤 LIKE → `json_each` 精确成员匹配 + `json_valid` 守卫）。
- **实弹留痕（真实数据）**：C6 —— 设置页「运行」Tab 渲染 → 保存 `max:4` → `GET /settings` 持久化 → 恢复 3；C7 —— run 103 面板提交 `llm.temperature=1.1` + `llm.max_tokens=4096` → hint「已生效 2 项」→ 留痕时间线「llm.temperature: — → 1.1」→ API `_params` / `_params_log` 对账 → 重复提交幂等「无变化」→ run 105（completed）终态只读；C5 —— `.gate.panel` 渲染 + revisions API 200；C4 —— palette 打开；C1 —— `GET /search?q=预知` 命中 run #103。

---

## 验收逐条对照（spec §5）

### #1 探针：probe:m21 六节全绿 + probe m1–m19 全量回归零适配

- **操作**：`npx tsx scripts/probe-m21.ts`（六节全量）+ 逐探针独立回归 `probe:m2a / m3 / m4 / m6 / m7 / m8 / m9 / m10 / m11 / m12 / m13 / m14 / m15 / m16 / m17 / m18 / m19`。
- **证据**：`probe-m21` **86 项断言全过 / exit=0**——search 15 · revisions 10 · concurrency 28 · hot-params 18 · tags-sql 10 · settings-kv 5；回归 **17 探针全部 exit=0「全部通过」，FAILS 空，零适配**（m11 合成快照与 m4 批次语义红线未动）。
- **concurrency 节构成（28）**：settings KV 读写往返 → `resolveConcurrencyMax` 读取链（settings → env → 默认 3）+ 1–6 clamp 六态 → 同步块闸门（2 started / 3 deferred / active=2 不超发 / 重复 startRun 幂等 / waiting_input defer）→ defer 归一 queued（不触碰终态）→ pumpGlobal 全链补位（6 run 全 completed 无滞留）→ **批协同**（全局槽位占满 → 批 run defer → 全局 settle 救起 → 批收敛）→ **[收口补] 批间救援**（批 C 双 run 占满 → 批 D defer → 批 C settle → 扫描救起批 D → 批 D 收敛；缺口版 dRun1 永久 queued）。
- **hot-params 节构成（18）**：`_params` / `_params_log` JSON 往返 → 深合并写回（改 model 保 size）→ 端点全链（applied 仅变化键 / from-to 条目 / 留痕结构 / 未提交组保留 / readRunParams 生效路径）→ clamp / 白名单 400（键、组、非法值三态）→ 幂等（applied 空不写留痕）→ 409 终态门 + 404。
- **tags-sql 节构成（10）**：SQL 层过滤分页不错位（LIMIT 1 命中匹配行）→ JSON 成员匹配（"夜景" 2 行 / "夜" 0 行防子串）→ 端点 total 同源 + offset 恰余第 3 条 → 中文 + 单引号命中 → 空匹配 → **[收口补] json_each 三类缺陷场景**（`say"hi` 含双引号命中 / `back\slash` 反斜杠命中 / `夜景","人像` 跨元素拼接串零命中）。
- **settings-kv 节构成（5）**：notify KV 四开关往返 → GET /settings 含 notify / concurrency → **[收口补] PUT /settings/concurrency → 引擎缓存即时刷新 + 回落**（验证可配 1–6 即改即生效，无需重启）。
- **✅ 通过（零适配）**

### #2 类型检查

- **操作**：`npx tsc --noEmit`（apps/server）+ `npx vue-tsc --noEmit`（apps/web）。
- **证据**：双端 exit=0（含收口期 `curEntries` 动态索引收窄、`curTags` / `tagState`、`rowsAffected` 等新代码）。
- **✅ 通过**

### #3 实弹浏览器（127.0.0.1:5174）

| 项 | 场景 | 状态 | 证据 |
|---|---|---|---|
| C6 并发 | 设置 → 运行 Tab：数字框 1–6 / 保存 → API / hint / 回落 | ✅ | max:4 保存 → `GET /settings` 持久化 → 恢复 3；hint「已保存（对后续调度生效）」 |
| C7 热调 | run 103 面板提交 → hint → 留痕 → API → 幂等 → 终态 | ✅ | applied 2 项；「llm.temperature: — → 1.1」；`_params` / `_params_log` 对账；终态 run 105 面板只读 |
| C5 Gate diff | 闸门面板 + revisions 端点 | ✅（冒烟） | `.gate.panel` DOM 渲染；`GET /runs/:id/steps/:k/revisions` 200 |
| C4 命令面板 | Ctrl+K 打开 | ✅（冒烟） | palette DOM 打开 + 占位文案；输入后「搜索中…」出现（结果渲染未捕获——视图关闭） |
| C1 搜索 | 输入命中 → 点击直达 | ⚠ 部分 | palette 打开✅；结果渲染未捕获；HTTP 兜底 `q=预知 → runs #103` ✅ |
| C2 通知 | 权限请求 → run 终态到达 → 静默降级 | ⚠ 待补 | 探针级逻辑覆盖（settings-kv notify）；浏览器权限全链待重开视图补验 |
| C3 tags | 编辑 → 筛选 → 批量打标；项目标签 | ⚠ 待补 | 探针级覆盖（tags-sql 10 项）；前端改动 vue-tsc 绿；浏览器链待补验 |

- **⚠ 部分/待补三项均因收口期浏览器视图被关闭（CDP `Network.enable` 超时），非实现风险**；补验清单见「局限与备注」。
- **✅ 核心两项（C6/C7）深实弹全绿**

### #4 文档

- 本 review 落盘 ✅；roadmap M21 注记校准 ✅；README「M21 能力速览」✅；L1 spec 在案 ✅。
- **✅ 通过**

---

## 静态与探针

- **变更面**：38 文件（28 修改 + 10 新增）；服务端 diff ≈20KB / Web diff ≈111KB（`tmp-m21-srv.diff` / `tmp-m21-web.diff` 存档）。
- **服务端**：新增 `services/search.ts` / `routes/search.ts` / `scripts/probe-m21.ts`；修改 `pipeline/engine.ts`（全局闸门 + pumpGlobal + 缓存刷新）、`services/batch.ts`（`notifyRunSettled` 全路径扫描 + `pumpStalledBatches` 导出）、`index.ts`（定时器 / 启动泵）、`routes/runs.ts`（+2 端点 + 条件写）、`routes/assets.ts`（json_each）、`routes/system.ts`（PUT 刷新钩子）、`db/schema.ts` + `db/index.ts`（assets +2 列 ensureColumn）、`app.ts`（路由挂载）。
- **Web**：新增 `CommandPalette.vue` / `lib/hotkeys.ts` / `lib/notify.ts` / `lib/diff.ts` / `lib/nav.ts` / `lib/types/search.ts` / `RunParamsPanel.vue`；修改 `App.vue`（面板挂载 + 通知初始化 + 搜索按钮）、`GateDialog.vue`（diff tab）、`AssetGrid.vue` / `previewer/*` / `AssetsPanel.vue` / `projects/index.vue` / `ProjectFormModal.vue`（tags UI）、`system-settings/index.vue`（通知 / 运行 Tab）、`run-detail/index.vue`（面板装配）、`stats/*`（命令面板深链接）、`style.css` / `Icon.vue` 等。
- **红线守住**：引擎单 run 执行链 / DAG / gate 语义逐字不变（startRun 返回值 void → 三态为增量信息，8 处调用方零破坏）；快照即证据不破（`_params` 只增改 + `_params_log` 全量留痕，`template_snapshot` 零触碰）；搜索零新依赖（LIKE + 本地 ONNX + 自研 LCS）；无新表（assets +2 列 / settings +2 key）。

## 偏差与修复记录

| # | 来源 | 问题 | 修复 | 复验 |
|---|---|---|---|---|
| 1 | 收口期协同核查 | `notifyRunSettled` 属批分支 `return` 阻断扫描：批 A settle 释放槽位时批 B 的 deferred run 无任何触发器（30s 定时器只跑 pumpGlobal） | 属批分支去 return，settle 后统一 `pumpStalledBatches`；导出供 30s 定时器复用 | concurrency 节批间救援双断言 + 定时器接线（index.ts） |
| 2 | CodeReview | 资产预览器 `saveTags` 无本地基准：宿主 props 刷新滞后期间基于陈旧快照回写会「复活」已删标签；宿主未接 `@changed` 时 chip 不刷新 | `tagState` 本地基准覆盖层（成功保存即更新）+ `curTags` 计算接管模板与增删基准；资产切换按 id 自动失效 | vue-tsc 绿；单测级逻辑核查（宿主已接 `@changed` 的 5 处调用方对照） |
| 3 | CodeReview | 热调 UPDATE 无状态条件：状态检查与写入之间的终态竞态 | 条件写（`status in (queued, running, waiting_input)`）+ `rowsAffected === 0` → 409 | hot-params 节 18 项全绿（含 409 门） |
| 4 | CodeReview | `cachedGlobalMax` 无失效钩子：运行中改 concurrency 需重启才生效 | `PUT /settings/:key` 命中 `concurrency` 时 `refreshGlobalConcurrency()` | settings-kv 节新增 PUT 即时刷新双断言 |
| 5 | CodeReview | tag 过滤 LIKE 非 JSON 精确：含引号 / 反斜杠漏查、`","` 跨元素误配 | `json_valid(tags) AND EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)` | tags-sql 节新增三类缺陷场景 3 断言 |

## 局限与备注

- **浏览器视图关闭导致的补验清单**（用户重开预览视图后可续）：
  1. C1：palette 输入「预知」→ 结果列表渲染 → Enter/点击直达 run 103（HTTP 兜底已验证后端链路）；
  2. C2：设置页请求通知权限（granted）→ 切后台触发 run 终态 → 通知到达；无权限环境断言静默；
  3. C3：资产预览器标签编辑（含收口修复的连续增删场景：删 A → 再删 B，A 不复活）→ 筛选命中 → 批量打标。
- **C6 行为变更明示**：全局并发默认上限 3（此前无限）为拍板项；`max` 可配 1–6（设 6 近似放开）；单机日常无感；探针锁定闸门 / 补位 / 幂等 / 批协同 / 批间救援五组语义。
- **搜索语义段**：默认环境（开发库）置有模型即真实语义；探针环境无模型走降级路径（关键词段永远在，语义段标注降级态）。
- 后台并发上限为全局先到先得（跨队列公平性 / 权重调度为 spec §8 明确排除，留后续）。

## 附录

- 变更文件清单（38）：见 `git status` / `tmp-m21-srv.diff`（20KB）/ `tmp-m21-web.diff`（111KB）。
- 探针回归日志：`.qoder/tmp-m21-regression.txt`（17 探针 exit=0，FAILS 空）。
- 相关文档：L1 spec `2026-09-16-agencys-content-studio-m21-design.md`；纲领 `2026-09-14-agencys-content-studio-m19-m27-charter.md`（§一 C 组）；roadmap M21 注记（本日校准）。

## 验证方式（已完结）

- 复跑：`pnpm --filter @acs/server probe:m21`（六节 86 项）；回归 `probe:m2a / m3 / m4 / m6~m19`；`npx tsc --noEmit`（server）+ `npx vue-tsc --noEmit`（web）。
