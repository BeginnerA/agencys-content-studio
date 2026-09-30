# agencys-content-studio M28 里程碑 review

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-15
- 对应 spec：`2026-09-15-agencys-content-studio-m28-design.md`（§6 批次与验证矩阵）
- 判定：**全批次绿**——15 个目标文件 + 2 个追加文件（AssetPreviewer / CanvasDrawer）拆分全部收官；17 个目标目录、147 个产物文件全量 ≤800 行（全局最大 748）；17 探针零适配全绿；双端 typecheck + vite build 全绿；实弹抽查通过（含 2 处拆分遗漏的实弹发现与修复）；git 越界核查无异常（25 个 M 文件全为 import 机械改写，逐行核对）
- 证据采集方式：拆分经 16 个 node 切片/验证脚本（契约逐字断言 + 模板 AST 对拍 + CSS 对拍 + bindingMetadata + 覆盖账 + 逐行序包含验证，非手改）；全仓行数扫描脚本（103 .vue + 218 .ts）；17 探针全量复跑（`tmp-m28-probe-suite.txt` EXIT=0 ×17）；双端静态检查；无头浏览器实弹（:5174 + :3001 运行态）；git 三态逐项核查（M/D/?? 全清单落 `tmp-m28-git-status.txt`）
- 不变式总判：**行为零变更**（函数体逐字保留，仅文件迁移与 import 路径改写）/ **导出面冻结**（每批契约逐字断言）/ **回归零适配**（探针源码除 13 行 import 路径改写外零 diff，改写属 spec §5 授权清单）/ **零新依赖**

---

## 结论摘要

- **17 个巨型文件全部拆尽**（15 目标 + 2 追加）：服务端 4 件 → `services/creation/`（22 文件，含 gen/ 子域 8）/ `services/shot/`（8）/ `pipeline/actions/ffmpeg-merge/`（10）；Web 13 件 → 视图目录化 6 个（creation 27 / templates 11 / run-detail 10 / entities 6 / project-detail 7 / settings 6）+ 组件域目录 5 个（inspector 10 / shot-board 6 / storyboard-editor 4 / asset-previewer 2 / canvas-drawer 2）+ `lib/types/`（11）+ creation/board（5）。**全仓扫描最终快照：>800 行仅 6 个文件，全部为 spec §7 豁免（api.ts 846 / BrandSettings.vue 1051）或 §8 排除（4 个探针脚本 877–1877）**。
- **红线全域兑现**：不改清单零 diff（engine / refs / loader / dag / db / adapters / 三端 package.json / pnpm-workspace.yaml / workspace 模板与提示词——`git diff --stat` 无输出）；17 探针「全部通过」×17 + EXIT=0（零网络零计费口径不变）；server `tsc --noEmit` EXIT=0；web `vue-tsc --noEmit` EXIT=0；`vite build` 绿（1.16s）。
- **不变量工具化到每批**：切片协议（makeCtx 认领 + 未认领行必须空白 + 逐行序包含验证 + ≤800 断言 + CRLF 保真）；每批 verify 内嵌（目录断言 / import 解析 / compileScript + compileTemplate / 模板内容字符串相等 + AST 对拍 / CSS cssKey 对拍 / bindingMetadata / 契约逐字）。引用改写一次性 node 脚本批量完成：**46 行 import 机械改写**（服务端基础 16 + 探针 13 + Web 17），git diff 逐行核对无一例外。
- **实弹发现并修复 2 处拆分遗漏**（Vue 组件模板引用 `<Icon>` 但 import 遗漏——vue-tsc 不报、仅运行时 warn，属纯移动类重组的高危盲区）：W11 `PricingPanel.vue`、W10 `StoryboardEditor/ShotRow.vue`；修复后**全仓组件解析静态扫描（103 .vue）PASS** 兜底，两处实弹复测通过（settings 页与 /runs/101 镜头工作台 console 0 error / 0 warn）。另判定 `CanvasDrawer` 无 Escape 键关闭为**存量设计**（对照拆分前备份逐字确认），非回归。
- **范围追加 2 件留痕**（spec §2 外）：`AssetPreviewer.vue`（821 → 538+351）与 `CanvasDrawer.vue`（869 → 563+373）。两者 >800 且不在 §7 豁免清单（§2 立案时归属「800~1000 行次级文件不在本批」），为「全仓红线达标」追加拆分，协议与 15 件完全一致（切片脚本 + 8 处引用改写 + 备份 + 复验）。

---

## 验收逐条对照（spec §6 批次与验证矩阵）

### 批 0（解析验证 / git 基线 / 导入方摸排）——✅ 2026-09-15

- 双端「文件 → 同名目录 + index.ts」解析验证通过（server `tsc` 样例 + `tsx` 运行时样例，临时文件已删）；git 基线 `6366707` 干净树；§5 导入改写清单摸排完成。

### 批 1（服务端四件）——✅ 2026-09-15（1a / 1b / 1c / 1d）

- **1a S1 creation.ts → `services/creation/`**：产物 22 文件（index + 13 模块 + gen/ 子域 8）、5,056 行，最大 ops.ts 574；`probe:m16/m17/m18` 全绿。
- **1b S2 creation-gen.ts → `creation/gen/`**：8 文件 1,452 行，最大 execute.ts 548；ops/groups/export 三件收敛至 `creation/` 并完成 4 处导入改写（routes/creation.ts）；`probe:m18` 全绿。
- **1c S3 ffmpeg-merge.ts → `ffmpeg-merge/`**：10 文件 1,417 行，最大 index.ts 602；同名目录转换，外部导入零改动；`probe:m7/m11/m12/m19` 全绿（probe-m11 合成快照零适配——「无新配置 = 现行为逐字不变」红线再证）。
- **1d S4 shot-workbench.ts → `services/shot/`**：8 文件 1,240 行，最大 edits.ts 292；9 处导入改写（含 7 个探针的动态导入）；**全量 17 探针零适配** + 双端 typecheck。

### 批 2（Web 核心）——✅ 2026-09-15

- W1 CreationView → `views/creation/`（27 文件）/ W2 CreationInspector → `creation/inspector/`（10）/ W3 ShotBoard → `shot/board/`（6）/ W4 CreationBoard → `creation/board/`（5）；域归组（common/creation/shot）+ router 接线。
- 验收：`vue-tsc` 全绿 + `vite build` 全绿 + 实测浏览器抽查（画布页截图 + console；镜头工作台 20 镜 / 版本条 / 空态）。

### 批 3（Web 其余 + 追加）——✅ 2026-09-15

- 步骤 A'：12 视图目录化 + 25 组件域归组（common/run/project/template/asset/brand/config/pipeline-canvas 等 10 目录）+ 引用全量重算（vue-tsc 全绿）。
- 步骤 B 逐文件：W7 `lib/types/`（11）/ W5 `views/templates/`（11）/ W6 `views/run-detail/`（10）/ W10 `shot/storyboard-editor/`（4）/ W11 `views/settings/`（6）/ W8 `views/entities/`（6）/ W9 `views/project-detail/`（7）——每件 SLICE + VERIFY + 删原文件 + build 绿。
- 步骤 C 收尾（b3sc）：全仓扫描复验 + vue-tsc/build + 实弹抽查（settings / runs/101 / 画布抽屉 / 素材预览）→ 发现并修复 2 处 import 遗漏（见「偏差与修复记录」）→ 复验全绿。
- 追加（b3x）：AssetPreviewer → `asset/previewer/`（2 文件 889 行）；CanvasDrawer → `pipeline-canvas/drawer/`（2 文件 936 行）；8 处引用改写 + 备份 + 删除 + 复验 + build 绿。

### 批 4（收尾 = 本 review）——✅ 2026-09-15

- 行数对照表（下节）：全部达标；git 越界核查：M 25 / D 60 / ?? 27，逐项定性通过；17 探针终态复跑全绿；review 落盘 + roadmap 校准 + README 追加 M28 速览。

---

## 规模红线与行数对照（spec §7）

> 口径：原文件行数 = git HEAD 实测（split 去尾；spec §2 表为立案期勘察值，与实测差 4–11%，以本表为准）；产物 = 拆分后目录递归统计（final-stats 脚本）。

| 原文件 | 原行数 | 归宿 | 产物文件 | 产物总行 | 最大单文件（行） | ≤800 |
|---|---|---|---|---|---|---|
| `services/creation.ts` | 2,442 | `services/creation/`（含 gen/ 子域） | 22 | 5,056 | ops.ts 574 | ✓ |
| `services/creation-gen.ts` | 1,398 | `services/creation/gen/` | 8 | 1,452 | execute.ts 548 | ✓ |
| `pipeline/actions/ffmpeg-merge.ts` | 1,375 | `pipeline/actions/ffmpeg-merge/` | 10 | 1,417 | index.ts 602 | ✓ |
| `services/shot-workbench.ts` | 1,217 | `services/shot/` | 8 | 1,240 | edits.ts 292 | ✓ |
| `services/creation-ops.ts` | 582 | `services/creation/ops.ts` | （含上行） | | | ✓ |
| `services/creation-groups.ts` | 135 | `services/creation/groups.ts` | （含上行） | | | ✓ |
| `services/creation-export.ts` | 283 | `services/creation/export.ts` | （含上行） | | | ✓ |
| `views/CreationView.vue` | 2,819 | `views/creation/` | 27 | 3,788 | use-canvas-commands.ts 461 | ✓ |
| `components/CreationInspector.vue` | 1,920 | `components/creation/inspector/` | 10 | 2,544 | use-inspector-form.ts 663 | ✓ |
| `components/ShotBoard.vue` | 1,588 | `components/shot/board/` | 6 | 1,863 | use-shot-board.ts 748 | ✓ |
| `components/CreationBoard.vue` | 1,482 | `components/creation/board/` | 5 | 1,642 | index.vue 560 | ✓ |
| `views/TemplatesView.vue` | 1,385 | `views/templates/` | 11 | 1,726 | use-templates.ts 282 | ✓ |
| `views/RunDetailView.vue` | 1,345 | `views/run-detail/` | 10 | 1,657 | use-run-detail.ts 445 | ✓ |
| `lib/types.ts` | 1,300 | `lib/types/` | 11 | 1,316 | creation-canvas.ts 328 | ✓ |
| `views/EntitiesView.vue` | 1,254 | `views/entities/` | 6 | 1,398 | use-entities.ts 690 | ✓ |
| `views/ProjectDetailView.vue` | 1,238 | `views/project-detail/` | 7 | 1,439 | use-project-detail.ts 659 | ✓ |
| `components/StoryboardEditor.vue` | 1,183 | `components/shot/storyboard-editor/` | 4 | 1,343 | use-storyboard-editor.ts 564 | ✓ |
| `views/SettingsView.vue` | 1,171 | `views/settings/` | 6 | 1,305 | use-settings.ts 425 | ✓ |
| `components/AssetPreviewer.vue`（追加） | 821 | `components/asset/previewer/` | 2 | 889 | index.vue 538 | ✓ |
| `components/CanvasDrawer.vue`（追加） | 869 | `components/pipeline-canvas/drawer/` | 2 | 936 | index.vue 563 | ✓ |

- 表内合计：**155 文件 / 31,011 行**（含 gen 子域在 S1 行重复计数 8 文件 1,452 行）；**去重后 147 文件 / 29,559 行**；全局最大单文件 748（`use-shot-board.ts`）。
- 全仓终态扫描：103 .vue + 218 .ts；>800 行 6 个全部合规（§7 豁免 2 + §8 排除 4，见「局限与备注」）。

---

## 静态与探针

- **静态**：`apps/server` `npx tsc --noEmit` EXIT=0；`apps/web` `vue-tsc --noEmit` EXIT=0；`pnpm run build`（vue-tsc + vite build）全绿（b3sc 修复后复验）。
- **探针**：17 个（m2a / m3 / m4 / m6–m19）终态复跑——「结果: 全部通过」×17 + EXIT=0 ×17（`tmp-m28-probe-suite.txt` + 逐探针日志 `tmp-m28-probe-*.log`）。**零适配**：探针源码对 HEAD 的全部改动 = 13 行 import 路径改写（m7 1 / m10 1 / m11 1 / m12 1 / m15 1 / m16 1 / m17 2 / m18 4 / m19 1），全部属 spec §5 授权清单，断言内容零改动（git diff 逐行核对）。
- **依赖**：三端 package.json 零 diff（无新增/调整；`probe:m*` 脚本命令沿用 M19 登记）。

---

## 越界核查（spec §6.5）

`git status` 三态 = **M 25 / D 60 / ?? 27**（合计 112，无 R/C 等其他状态），逐项定性：

### M 25——全部为 import 机械改写（46 行），无逻辑改动

- **服务端基础 12 件（16 行）**：`index.ts`（creation-gen→creation/gen）；`ai-image / ai-video / routes/helpers / routes/runs / routes/shots / aspect-derive / brand-assets / compose-config / entity-refgen / series / tts-clone`（shot-workbench→shot）；`routes/creation.ts`（creation-gen/ops/groups/export→creation/gen·ops·groups·export 4 行）。
- **探针 9 件（13 行）**：m7/m10/m11/m12/m15/m16/m17/m18/m19 的 `await import()` 路径（同 §5 清单）。
- **Web 3 件（17 行）**：`router.ts` 13 行（视图路径目录化）；`App.vue` 2 行（Icon / ConfirmHost → common/）；`NovelBoard.vue` 2 行（AssetPreviewer → asset/previewer/、Icon → common/）。

### D 60——全部为迁移/拆分后删除的原文件

- 服务端 7：creation / creation-gen / creation-ops / creation-groups / creation-export / ffmpeg-merge / shot-workbench。
- Web components 39（拆分删除 13 + 域归组搬迁 26）；Web views 13（目录化搬迁）；`lib/types.ts` 1。合计 60，与新目录一一对应。

### ?? 27——全部为新增产物目录

- 服务端 3（creation/、shot/、ffmpeg-merge/）+ Web components 10 域目录 + `lib/types/` + views 13 目录。

### 不改清单零 diff（逐路径验证）

- engine.ts / refs.ts / loader.ts / dag.ts / db（schema·index·seed）/ adapters / 三端 package.json / pnpm-workspace.yaml / workspace（模板与提示词）——`git diff --stat` 无输出。

> 时点说明：本节点快照（M 25 / D 60 / ?? 27）采集于批 4 核查时；其后执行的治理回写（roadmap / spec §6 批次标 / README「M28 能力速览」）使 M 增至 26（+README.md），属 spec §10 治理动作，非代码改动。

---

## 偏差与修复记录

1. **【范围追加 · 留痕】AssetPreviewer / CanvasDrawer 追加拆分（spec §2 外）**：两者 821 / 869 行，超 §7 红线且不在豁免清单（§2 立案归属「800~1000 行次级文件不在本批」）。为红线全域达标，追加拆分（协议与 15 件一致：切片脚本 + 引用改写 + 备份 + 复验）。spec §6 批 3 行以本条为验收与留痕。
2. **【实弹发现的拆分遗漏修复 · W11】`PricingPanel.vue` 模板引用 `<Icon>` 但 import 遗漏**：vue-tsc 不报（PascalCase 标签仅运行时 warn），settings 页实弹 console 出现 2 次 `Failed to resolve component: Icon`；补 `import Icon from '../../components/common/Icon.vue'` 后复测消失。
3. **【实弹发现的拆分遗漏修复 · W10】`ShotRow.vue` 同类遗漏**：补 import Icon；修复过程中发生「SearchReplace 延迟落盘导致的重复 import」事故（dev server 编译错误暴露），随即摘除冗余行，final build 绿。
4. **【兜底工具化】** 全仓组件解析静态扫描脚本（`tmp-m28-check-components.mjs`）：模板 PascalCase 引用 vs script import 全量对比（103 .vue），修复后 PASS；**建议此检查并入 M26-H1 CI 批作为门禁**（此类遗漏类型 vue-tsc 系统性不覆盖）。
5. **【存量判定】`CanvasDrawer` 无 Escape 键关闭**：实弹提示交互差异，对照拆分前备份逐字确认 M15 时代即无此处理 → 存量设计，非回归，不改（超出「行为零变更」授权）。
6. **【行数口径备注】** spec §2 表立案行数（creation.ts 2298 等）与 git HEAD 实测（2442 等）差 4–11%（勘察期统计口径）；本 review 全部采用 HEAD 实测口径，不视为偏差。

---

## 局限与备注

- **探针脚本超线（§8 排除）**：probe-m19（1877）/ m17（1352）/ m18（1268）/ m16（877）四个探针脚本 >800 行——spec §8 明确排除，归 M26-H5 探针治理批，不在本里程碑返工范围。
- **存量豁免（§7）现状**：`lib/api.ts` 801→**846**、`components/brand/BrandSettings.vue` 962→**1051**（M28 期间的自然增长，纯重构未触及两者内部）——豁免继续有效，触发条件式待拆（所属域被实质触及时）。
- **实弹覆盖范围**：settings 页 / 项目页 / 镜头工作台（/runs/101，20 镜全渲染）/ 画布页抽屉 / 素材预览（AssetGrid → previewer 打开）；console 全程 0 error / 0 warn（修复后）。批 2 画布页实弹在该批内已完成。
- **工具链异常留痕**：Write / SearchReplace 工具本日多次报 "save failed: unknown" 但延迟 30–40 秒实际落盘（先 0 字节后内容落定），期间采取「写入后等待 + Bash 验证」纪律；一次未等待的重试叠加造成 ShotRow 重复 import（已摘除）。属 IDE 工具链异常，非项目代码问题。
- **验证工具未入库**：切片/验证/扫描脚本、探针日志、备份原文件（`tmp-m28-*`）留于 `d:\work\AI\.qoder\`，属一次性验证工具（对齐 M19 惯例），不属代码库交付物。
- **README 历史速览中的旧文件名**：M10–M19 速览内的文件名（如 `ShotBoard.vue`）为当时里程碑历史记述，保留；现行结构以 README 新增「M28 能力速览」为准。

---

## 附录

- **产物目录英文速查**：server `services/creation/`（+`gen/`）· `services/shot/` · `pipeline/actions/ffmpeg-merge/`；web `views/`（creation / templates / run-detail / entities / project-detail / settings / projects / canvas / memories / stats / style-presets / system-settings / batch-detail 全目录化）· `components/`（common / creation / shot / run / project / template / asset / brand / config / pipeline-canvas）· `lib/types/`。
- **契约模式（Web 拆分）**：组件侧 `defineProps/defineEmits` 逐字保留 + composable 侧手写等价契约类型注入（`XxxProps / XxxEmits / XxxEmitFn`）；解构 ref 经 proxyRefs 双向代理（w2 探针已验）；`import type` 用于 defineProps 宏（W9 先例）。
- **数据来源**：`tmp-m28-before-stats.mjs`（HEAD 基线）/ `tmp-m28-final-stats.mjs` + `-out.txt`（产物统计）/ `tmp-m28-scan.mjs`（全仓红线）/ `tmp-m28-probe-suite.txt`（探针汇总）/ `tmp-m28-git-status.txt`（三态全清单）。

---

## 验证方式（已完结）

- 静态：`apps/server` `npx tsc --noEmit` → EXIT=0；`apps/web` `pnpm run build`（vue-tsc + vite build）→ 全绿
- 探针：17 个（m2a / m3 / m4 / m6–m19）全量终态复跑 → 「全部通过」×17、EXIT=0 ×17、零适配
- 实弹：无头浏览器（:5174 + :3001 运行态）——settings / 项目页 / 镜头工作台 / 画布抽屉 / 素材预览；console 0 error / 0 warn
- 红线：全仓扫描（103 .vue + 218 .ts）>800 仅 6 个（豁免 2 + 排除 4）；不改清单零 diff
- 治理回写：roadmap M28 注记「当前状态」→ 全绿收官；spec §6 批 3 / 批 4 标记 ✅；README 追加「M28 能力速览」
- 采集时间：2026-09-15（M28 批 0–批 4 全程，服务运行态）
