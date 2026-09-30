# M26 收官 review — 工程基建与平台化

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-17
- 设计：`2026-09-17-agencys-content-studio-m26-design.md`
- 纲领卡：`2026-09-14-agencys-content-studio-m19-m27-charter.md` §一 H 组 / §二 M26 卡
- roadmap：`2026-09-09-agencys-content-studio-roadmap.md` §M26 注记
- 性质：**零产品行为变更**（纯基建 + 纯重构）；本 review 逐条背书 spec §4 验收矩阵。

## 0. 一句话结论

M26 P0–P4 全批次收官。此前全手动的回归面固化为**本地 CI（`ci:check` 三段门禁 + 探针统一 runner）**；M28 遗留的「单文件 ≤800 行」红线残余（5 探针 + 5 前端）**全部拆分、复扫归零**；Ollama 一等 provider seed 落位；H6 提交门禁成文；H7 判定关闭 + 运行时可编程协议永久排除。`pnpm ci:check` 端到端 exit=0，**23 探针 / 2873 断言全绿**。

## 1. 验收矩阵逐条背书（对齐 spec §4）

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | CI 首绿 | ✅ | `pnpm ci:check` exit=0：`pnpm -r typecheck`（server tsc + web vue-tsc）双 Done → `validate:templates` **14 模板 / 101 步 · 0 错误 0 警告** → `probe:ci` 全量 fail-fast 全绿 |
| 2 | 探针 runner | ✅ | `run-probes.ts` 发现 23 枚（m2a…m26）、并行 worker 池、逐枚计时 + PASS/FAIL 汇总对齐表、`--fail-fast`；`probe:ci` 汇总 TOTAL **2873 断言 / 147s** 全绿；纯函数 `parseProbeOutput`/`formatSummary` 由 probe-m26 `runner` 节背书 |
| 3 | 大探针零漂移 | ✅ | m16/m17/m18/m19/m22 拆分前后断言总数逐枚相等且全绿：m16 131 / m17 274 / m18 248 / m19 378 / m22 169；`probe:mXX` 入口名与 `--section=` 单节能力不变；产物各 ≤800（split-audit 背书） |
| 4 | 压测基准 | ✅ | `bench-stress` 缺省档（1000 项目 / 10000 资产 / 长链 20 步 = 20000 步 / 1000 节点大图）产出一次性基准报告落 `apps/server/scripts/review/bench-stress-report.md`（p50/p95/RSS 峰值 259MB，非阻断、隔离临时库自清理）；probe-m26 `stress` 节小样本 + percentile 对拍全绿 |
| 5 | Ollama | ✅（种子/能力位） | `ollama_llm` seed 行在（`api_providers` 可查，vendor=ollama / service_type=llm / defaultUrl 含 11434）；幂等重放不重复插（probe-m26 `ollama-seed` 节背书）；走通用 OpenAI 兼容 `/chat/completions` + `fetch-models` 通道，零适配器代码。运行时实测为条件式（本地无 Ollama → 登记降级，种子与能力位仍全绿） |
| 6 | 红线收口 | ✅ | 全仓 `scripts` + `web/src` 复扫 **>800 行文件 = 0**；5 前端文件拆分行为零变更（双端 typecheck + vite build + 全量探针零适配）；浏览器抽查 6 路由 **0 console error** 无回归 |
| 7 | 治理留痕 | ✅ | H7 关闭回写纲领 §五 + §四（运行时可编程协议永久排除）；H6 提交前置门禁成文 + m18 偏差 #3 关闭；review + roadmap + README + 纲领 校准 |

## 2. 红线残余拆分清单（spec §2.7，M28 式纯重构）

| 文件（原行数） | 拆分后主文件 | 抽出的 composables / 子组件 / 域文件 |
|---|---|---|
| `lib/api.ts`(975) | `lib/api/index.ts`(28) re-export | 按域 7 文件：`core` / `projects` / `assets` / `runs` / `canvas` / `config` / `insights`（导入面零改动） |
| `CanvasBoard.vue`(855) | `CanvasBoard.vue`(722) | layout + card composables |
| `BrandSettings.vue`(1051) | `brand/BrandSettings.vue`(776) | helpers + 4 composables |
| `NovelBoard.vue`(1099) | `NovelBoard.vue`(611) | `NovelGraphView.vue`(572) 段② 事件图谱子组件（props `board` + emit `reload`） |
| `views/canvas/index.vue`(1172) | `index.vue`(774) | `use-canvas-design.ts`(163) + `use-canvas-realtime.ts`(133) composables + `CanvasGuide.vue`(115) + `CanvasDesignModals.vue`(147) 子组件 |

**不变式核对**：函数体 / 模板标记 / 样式逐字保留；无符号重命名；导出签名冻结；组件 props/emits 契约不变（`defineModel` 跨边界 v-model、`emit('reload')` 替代 `await load()` 行为等价）；composable 内注册生命周期（socket 订阅 / timer 清理）功能等价。

## 3. 浏览器抽查结果（回归背书）

前端 dev `127.0.0.1:5174` + 后端 `3001`，真实数据（project 14 / template article-clip / run 105）：

| 路由 | 覆盖产物 | 结果 |
|---|---|---|
| `/canvas?template=article-clip` + 编辑态（连线/草案/保存/退出） | index.vue + CanvasBoard + use-canvas-design + CanvasDesignModals | ✅ 0 error（草案 Modal 校验通过 + YAML 预览 + 本地草稿丢弃回环正常，全程未落盘） |
| `/canvas?run=105` | CanvasBoard 运行态 + 抽屉联动 | ✅ 0 error（状态徽章 / 节点抽屉） |
| `/canvas`（空 query） | CanvasGuide | ✅ 0 error（空态引导：最近运行 + 模板快捷入口） |
| `/creation?project=14` | CanvasBoard（创作画布） | ✅ 0 error（工具栏 / tabs 解析渲染） |
| `/system` | BrandSettings scope=platform | ✅ 0 error（字幕样式 / 水印 / 片头尾 / 预览表单齐全） |
| `/projects/14` 品牌 tab | BrandPanel → BrandSettings scope=project | ✅ 0 error（作用域差异字段 / disabled / 保存项正确） |

> NovelBoard（`/runs/:id` 内 `text_split` 步骤数据门控）当前无匹配运行，跳过；其模块边界已由 vue-tsc + vite build + 全量探针覆盖。

## 4. 数据与兼容（零 diff 核对）

- **零新表零新列**：无任何 schema 变更（Ollama 仅 `api_providers` seed 行）。
- **零新增运行时依赖**：runner 用 node 内置 `child_process`/`os`；压测用既有 `@libsql/client`/`drizzle`；Ollama 不引 SDK。
- **引擎 / DAG / 模板加载签名 / 适配器协议 / package 依赖 零 diff**。
- 新增：`probe-lib.ts` / `run-probes.ts` / `validate-templates.ts` / `bench-stress.ts` / `probe-m26.ts` / `probes/m{16,17,18,19,22}/*.ts` / `lib/api/*` / canvas·novel·brand 拆分产物 / `.githooks/pre-push`。
- 修改：`db/seed.ts`（+2 seed 行）/ root+server `package.json`（+`ci:check`/`probe:all`/`probe:ci`/`validate:templates`/`bench`）/ 5 前端文件（拆分）/ README（快速开始门禁行 + M26 能力速览 + M28 红线收账）/ 纲领（M26 卡交付状态 + §四 §五 H7）/ roadmap（M26 注记已交付）。

## 5. 决策与排除留痕

- **H1 CI**：仓库在 Gitee，GitHub Actions 假设不成立 → 本地统一 runner + Git 钩子（零外部 CI、零运行时影响）。
- **H2**：巨型文件拆分已于 2026-09-15 转入 M28；M26 仅收口红线残余。
- **H4 Ollama**：仅 LLM 一等化；embedding 维持本地 ONNX（provider 化 = 架构新增，排除）；image/video/audio 排除。
- **H7**：判定关闭（既有自定义 OpenAI 兼容 `base_url` 等价覆盖）；运行时可编程协议脚本（沙箱）永久排除（任意代码执行安全 + 与「适配层 = 代码级新增」原则冲突）。
- **H6**：现工作树已干净、M23/M24/M25 均规范 `feat` 提交（纪律实际已遵循）→ spec 固化「提交前置门禁」成文规则，无代码。

## 6. 遗留 / 后续

- 全量 `probe:all` 并行模式下 m13/m14 偶发各 1 断言失败（耗时波动 45s/33s），`--only=m13`（PASS 121）/ `--only=m14`（PASS 130）单独复跑均全绿 → 判定为并发 flaky（P3 仅改 `web/src`，不触服务端），非本次回归；`probe:ci` 串行 concurrency=1 稳定全绿。并发时序加固可另议（非 M26 范围）。
- Ollama 运行时实测（拉模型 + 一轮对话）为条件式：待用户环境本地运行 Ollama 时补录。
