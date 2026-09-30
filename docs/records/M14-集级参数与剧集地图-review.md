# agencys-content-studio M14 里程碑 review

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-12
- 对应 spec：`2026-09-12-agencys-content-studio-m14-design.md`（§5 验收）
- 判定：**实弹三项全覆盖 + 冒烟全过**（证据采集方式：`probe:m14` 四节 + 回归 m7·m8·m10·m11·m12·m13；真实开发库实弹——Run 101 集级覆盖 / Run 98 零漂移对照 / 剧集 409 矩阵 / 3101 隔离实例静态托管冒烟；无头 Chrome CDP DOM 14/14；项目 10；服务运行中采集）
- 范围调整：③桌面端经用户决策取消（scaffold 全量删除、Electron 下载中止、git 零残留）；交付 = ①集级参数 ②剧集实体 + 静态托管

---

## 结论摘要

- **集级参数链路闭环（API + DOM 双证）**：`run.input._params` 白名单校验 → `createStepContext` 三层叠加 → gen_task 快照全量可溯。黄金证据 = Run 101 的 20/20 出图任务 `params.size=768x768`（覆盖命中）+ `stylePresetIds=[1,2]`（项目层叠加）；对照 = Run 98 重跑（无覆盖）20/20 `size=832x1248`（模板默认保持）。`video.duration` 不经 gen_task 物化（引擎仅对 ai_image 建任务 + ai-video 消费点以镜头时长优先），其证据层级 = 入参快照 + probe context 断言（见「局限与备注」）。
- **剧集实体双源合并闭环**：建剧 3 集 → Run 101/102 起作联动 `latest_run_id` → 派生状态三态（completed/failed/locked）→ 409 矩阵（`episode_in_use` / `series_in_use`）全过且 409 后视图未受损。零 run 生命周期改动（后置回写、失败不阻断）。
- **静态托管冒烟全过**：3101 隔离实例（隔离数据目录 + 真实 dist）——首页 200 / 真实 assets 200（javascript）/ SPA 深链回退 / `/api` JSON 404 优先。env 无值时现行为逐字不变（probe static 节覆盖）。
- **DOM 14/14**：剧集地图三集行（含 run102 失败留档行）→ 起作接力直达「短剧·单集」表单（`initialTemplateKey` = 项目默认模板命中，无选卡断点）→ 覆盖折叠区五控件 + 集号预填 3 + 滚动可见实测。
- **实弹暴露缺陷 1 处（已修复）**：`SeriesBoard` 头部 `.bh/.bt` 引用了 `ProjectDetailView` 的 scoped 样式（不穿透子组件）→ 标题粘连 + 操作按钮组换行左侧；组件内补定义 → 复跑复验（DOM 截图前后对比）。
- **运行环境事故 1 起（留档）**：首轮实弹期间 :3001 服务进程异常闪断（根因未定位）。新进程启动恢复将 run102 标记 failed（interrupted），但其 `make_storyboard` 残留 running 僵尸态、返修被 `assertRepairable` 守卫正确拒绝（400 `bad_step_status`，无操作路径）；run101 由新进程正常续跑至 completed。二轮实弹（API 29 项中 28 PASS + 1 项断言口径修正 + DOM 14/14）全绿收口。

---

## 验收逐条对照（spec §5）

### #1 静态：typecheck + probe:m14 四节 + 回归

- **操作**：`pnpm --filter @acs/server typecheck` + `pnpm --filter @acs/web typecheck`；`probe:m14`（params / series / static / regression 四节）；回归 `probe:m7 / m8 / m10 / m11 / m12 / m13`。
- **证据**：双端 typecheck 0 错；`probe:m14` 全绿（EXIT=0）；六组回归探针全绿（存量基线零漂移）。
- **✅ 通过**

### #2 集级参数实弹

- **操作**：项目 10 启动 Run 101（mengbao-episode）携带 `_params = {image.size:768x768, video.duration:10, llm.temperature:0.5}`；run 推进至 gen_images 步骤产出 20 个出图任务。
- **证据**：20/20 gen_task `params.size=768x768`（覆盖命中）；任务样例全参快照 `{"size":"768x768","shotId":"s20","duration":3,"refAssetIds":[],"refUsed":0,"output_purpose":"shot_image","stylePresetId":1,"stylePresetIds":[1,2]}`；对照 Run 98 重跑（无 `_params`）：20/20 `size=832x1248` 保持模板默认 + 既有 7 键逐值零漂移 + 任务 id 集合不变 + 产出 20/20 更新。
- **✅ 通过**

### #3 剧集实体实弹（含 409 矩阵）

- **操作**：项目 10 建剧「M14 实弹·剧集」3 集 → 起作 Run 101（集1）/ Run 102（集2）→ 缩容 / 删剧保护探测。
- **证据**：`latest_run_id` 联动回写（101→集1 / 102→集2，后置动作）；派生状态 1:completed / 2:failed / 3:locked；集1标题行内编辑 200（`第一集·雨夜灯影`）；缩容（含已关联 run 的集）→ 409 `episode_in_use`；删剧 → 409 `series_in_use`；两次 409 后剧视图 3 集未受损。
- **✅ 通过**

### #4 静态托管冒烟（原桌面端项缩围）

- **操作**：3101 隔离实例启动（隔离 `CSTUDIO_DATA` / `CSTUDIO_WORKSPACE` + 真实 `CSTUDIO_WEB_DIST` → `apps/web/dist`；`CSTUDIO_ROOT`=repo）。
- **证据**：`/` → 200 text/html（真实 index）；index 提取的真实 assets js → 200 text/javascript（96,517 B）；深链 `/projects/12/timeline` → 200 回退 index；`/api/v1/nonexistent` → 404 JSON（优先于 SPA 回退）；electron 安装包 / dev 窗口项随桌面端取消（不适用）。
- **✅ 通过**

### #5 回归

- **证据**：`probe:m7 / m8 / m10 / m11 / m12 / m13` 全绿；无 series 项目的运行端点行为不变（probe regression 节）；无 `_params` 的 run 快照逐字等价（probe params 节）。
- **✅ 通过**

### #6 越界核查

- **证据**：`git status`——engine / refs / loader / 模板 / 提示词零 diff；schema.ts 仅 +`series` / `episodes` 两表（§4 白名单内）；改动面 = 12 改 + 5 新件，与 §4 清单一致；electron / electron-builder 零依赖链记录。
- **✅ 通过**

---

## 静态与探针（spec §5.1 / §5.5）

- **静态**：双端 typecheck 0 错；`apps/server/package.json` 仅 +`probe:m14` 脚本（dependencies 零新增）。
- **探针 `probe:m14` 四节**：params（白名单矩阵 / clamp 边界 / 未知键 400 `bad_params` / context 三层叠加优先级 / 无 `_params` 逐字等价）；series（CRUD / 派生 status / 联动回写 / 扩容缩容 / 409 矩阵 / 坏 JSON 容错）；static（SPA 回退 / 穿越防护 / `/api` 优先级）；regression（无 series 项目端点行为不变）。
- **回归**：`probe:m7 / m8 / m10 / m11 / m12 / m13` 全绿（项目设置链 / 合成链 / 素材链零漂移）。

---

## 偏差与修复记录

1. **`SeriesBoard` 头部样式不穿透（实弹暴露，已修复）**：`.bh` / `.bt` 仅定义于 `ProjectDetailView.vue` 的 scoped 样式 → 子组件内不生效 → 卡片标题粘连（「剧集地图M14 实弹·剧集 · 3 集」）+ 操作按钮组换行左侧（首轮 DOM 截图目检发现）。修复 = 组件内 scoped 补同名定义（`display:flex / gap:10px / margin-bottom:8px`）→ 复跑 DOM 全绿 + 截图更新（复验：标题间距正常、按钮组同行右对齐）。
2. **T2 零漂移断言口径修正（二轮实弹发现，非产品缺陷）**：`既有键逐值零漂移` 断言将 `stylePresetIds` 视为「既有键」，而 s01 任务系 M13 实弹期重跑产物（当时项目 settings 为单值 `style_preset_id:1` → 快照 `[1]`）；本轮重跑按当前项目层（`style_preset_ids:[1,2]`）重建为 `[1,2]`——即 M13 已验收的「单值回退 → 多预设叠加」演进（预期收敛，非漂移）。已确证漂移仅此 1 键 1 任务（失败明细仅 1 条无并列），其余 7 键全量零漂移、19 任务该键为纯新增（`newKeys=[stylePresetIds]`）。
3. **DOM 断言时机修正 2 处**：①覆盖区 label 读取从 `innerText` 改 `textContent`（`details` 收起态 `innerText` 为空，标签文本含 select option 拼接需前缀匹配）；②新增 W6d 滚动可见性实测（弹窗 `.body` 为滚动容器——「DOM 存在」不等于「视觉可见」，`open h=254 inView=true`）。
4. **W5a 预期修正（勘察记忆偏差）**：起作接力实测直达表单（项目 10 `templateKey=mengbao-episode` 非空 → `initialTemplateKey` 命中）；原「落卡」预期系早期勘察记忆偏差，非实现问题——实现取「项目默认模板」为接力模板（比 spec §2.2 文案的硬编码 `mengbao-episode` 更通用），项目未配模板时落卡由用户手选（脚本双分支兼容）。

---

## 局限与备注

- **:3001 服务闪断根因未定位（留档待查）**：首轮实弹期间（22:46:4x）原进程（PID 8856）异常退出、新进程（PID 18776，22:47:04）接替；沙箱限制无法取进程级证据（`Get-CimInstance` 拒绝访问），无 supervisor 留痕。影响可控（run101 续跑完成；run102 失败可断点续跑）但根因未知。
- **run102 僵尸态（留档）**：failed（interrupted）+ `make_storyboard:running` 残留；返修被守卫正确拒绝（400 `bad_step_status`——仅 succeeded/failed 步骤可返修）→ 无原地修复路径；如需继续该集走「断点续跑」（新 run 继承快照）。
- **`video.duration` 证据层级**：引擎仅对 ai_image 步骤建 gen_task；ai-video 的 duration 消费点是镜头时长优先链（`shotDurationSec(shot) ?? vidCfg['duration']`）→ 任务级不可见。§5-2「gen_task 快照命中覆盖值」对 image.size 直接成立；video.duration 由入参快照 + probe context 三层叠加断言承载（同源同链）。
- **M13 截图 D 状态已处置**：M14 收尾期 `git status` 发现 M13 六张验收截图处于被删状态（D，非本批改动）→ `git checkout` 恢复（历史证据保全）。
- **electron 孤儿缓存**：`apps/desktop` scaffold 与 workspace 配置已恢复原样，但 pnpm store 中 electron 二进制下载残留（node_modules 级、git 无关）——可择日 `pnpm store prune` 清理，不影响任何构建。
- 桌面端取消决策的全量留痕见 spec §2.3 / §8 与 roadmap M14 注记。

---

## 附录

- **改动清单（git status 基线，代码面）**：12 M + 5 新（另：`README.md` 文档更新 + roadmap / 本 review 于 `docs/superpowers/specs/`）
  - 服务端：`services/run-params.ts`（新）/ `services/series.ts`（新）/ `routes/series.ts`（新）/ `pipeline/context.ts` / `routes/runs.ts` / `services/run-create.ts` / `app.ts` / `env.ts` / `db/schema.ts` / `db/index.ts` / `package.json`（+probe:m14）
  - Web：`components/SeriesBoard.vue`（新）/ `components/RunFormModal.vue` / `views/ProjectDetailView.vue` / `lib/api.ts` / `lib/types.ts`
  - 探针：`scripts/probe-m14.ts`（新，四节）
  - 证据：`apps/web/tmp-m14-dom-1-series.png` / `apps/web/tmp-m14-dom-2-form-adv.png`
  - 临时脚本（验收后清理）：`scripts/tmp-m14-live.mjs` / `scripts/tmp-m14-live2.mjs` / `scripts/tmp-m14-dom.mjs`
- **实弹断言清单**：live2 29 项（28 PASS + 1 项断言口径修正）；DOM 14/14（W0×2 / W1 / W2×4 / W4 / W5a / W5b / W6a / W6b / W6c / W6d）。
- **证据日志**：`$TEMP\m14-live2.log`（二轮实弹）/ `$TEMP\m14-dom4.log`（DOM 最终轮）；首轮 `$TEMP\m14-live.log`（含闪断前证据，留档）。

---

## 验证方式（已完结）

- 静态：`pnpm --filter @acs/server typecheck` + `pnpm --filter @acs/web typecheck` → 0 错
- 探针：`pnpm --filter @acs/server probe:m14` + `probe:m7 / m8 / m10 / m11 / m12 / m13`
- 实弹：`node scripts/tmp-m14-live2.mjs`（对运行中 :3001 + 真实开发库）+ `node scripts/tmp-m14-dom.mjs`（无头 Chrome CDP → vite 5174 真实模板）
- 采集时间：2026-09-12（M14 P6 批次，服务运行态）
