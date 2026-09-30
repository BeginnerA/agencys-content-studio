# M26 L1 spec — 工程基建与平台化（CI · 探针治理 · 压测基准 · Ollama · 红线收口）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-17
- 纲领：`2026-09-14-agencys-content-studio-m19-m27-charter.md` §一 H 组 / §二 M26 卡 / §五 待决策项
- 范围校准：**H2 巨型文件拆分已于 2026-09-15 转入 M28 独立收官**；M26 = H1（CI）+ H3（压测基准）+ H4（Ollama）+ H5（探针治理）+ H6（提交治理）+ H7（在线可编程供应商·待决策）+ **≤800 行红线残余收口**（M28 遗留新破线）。

## 0. 用户拍板（2026-09-17 四项）

1. **H1 CI = 本地统一 runner + Git 钩子**：零外部 CI 平台（仓库在 Gitee，GitHub Actions 假设不成立）。交付 `ci:check` 聚合脚本（双端 typecheck + 模板校验 + 全量探针经统一 runner）+ `pre-push` Git 钩子（`core.hooksPath` 指向仓库内 `.githooks/`，可选启用）。CI 对运行时零影响。
2. **H5 探针治理 + H3 压测 = runner + 拆分 5 个大探针 + 压测基准脚本**：统一 runner（发现/并行/计时/PASS·FAIL 汇总/fail-fast）；拆分现存 >800 行的 5 枚探针（m16/m17/m18/m19/m22）至各文件 ≤800 行、`probe:mXX` 入口与断言面逐字不变；新增数据量级压测脚本产出基准报告（非阻断、零网络、临时库自清理）。
3. **H4 Ollama = 一等 provider seed + H7 关闭登记**：Ollama LLM 作为预置供应商（既有 OpenAI 兼容通道，**零新适配器代码**）；H7「在线可编程供应商」判定为**已被既有「自定义 OpenAI 兼容网关 base_url」等价覆盖**，关闭纲领 §五 待决策状态；运行时可编程协议（用户脚本沙箱）永久排除。
4. **红线残余 = 全量拆分 5 个 >800 前端文件**（M28 式纯重构，行为零变更 + 探针/typecheck/build 背书）；**H6 提交治理** = 现工作树已干净、M23/M24/M25 均为规范 `feat` 提交（纪律实际已在遵循）→ spec 固化「提交前置门禁：双端 typecheck + 对应 probe 全绿方可 commit」为成文规则，m18 偏差 #3 就此关闭，无代码。

## 1. 设计三原则（红线）

- **零产品行为变更**：M26 全为工程基建与纯重构——探针拆分/文件拆分前后**断言面与运行时行为逐字不变**（全量探针 + 双端 typecheck + vite build 三重背书）；引擎/DAG/模板加载签名/schema/适配器协议实现零触碰。
- **零外部依赖、零运行时影响**：CI 为本地脚本 + Git 钩子（不进任何生产构建路径）；探针 runner/压测脚本仅存在于 `apps/server/scripts/`，`src/` 运行时代码零新增依赖（Ollama 走既有 provider 数据种子，不引 SDK）；压测零网络零计费（隔离临时库）。
- **不新增架构**：Ollama 复用既有 `service_type=llm` OpenAI 兼容链（`llm.ts` `/chat/completions` + `api-configs.ts` `fetch-models` `/models`），仅 +2 seed 行；embedding 维持本地 ONNX（bge-small，M21/M3 既有）——provider 层 embedding = 架构新增，**排除**。

## 2. 逐项设计契约

### 2.1 H5a · 探针统一 runner（`scripts/run-probes.ts`）

- 发现：扫描 `scripts/probe-*.ts`，按里程碑号自然序排列（m2a, m3–m25, m26…）。
- 执行：子进程 `tsx scripts/probe-<id>.ts`（`--section` 透传可选）；**并行 worker 池**（缺省并发 = min(4, CPU-1)，`--jobs=` 覆盖）——探针各用独立临时库（`acs-probe-mXX-*`）互不冲突，可安全并行。
- 计时与汇总：记录每枚探针墙钟耗时 + 解析 stdout 统计 `PASS`/`FAIL` 行数；末尾打印对齐表（id / 断言数 / 耗时 / 状态）+ 总计；**fail-fast**（`--fail-fast` 首个非零退出即中止，CI 默认开）。
- 退出码：任一探针非零 → runner 非零。脚本：`probe:all`（全量并行）/ `probe:ci`（fail-fast 串行，供 CI）。
- 纯函数：`parseProbeOutput(stdout): {pass,fail}` 与 `formatSummary(rows): string` 提炼可测（probe-m26 `runner` 节背书）。

### 2.2 H5b · 大探针拆分（m16/m17/m18/m19/m22）

- 抽公共 `scripts/probe-lib.ts`：`isolatedEnv(tag)`（临时目录 + 历史残留清理 + env 三件套设置，**必须在任何 src import 前调用**）、`makeChecker(log)`（PASS/FAIL 计数 + check 闭包）、`runSections(entry, sections, ctxArg)`（`--section` 派发 + summary + exit code）。
- 拆分布局：`scripts/probe-mXX.ts` 保留为**薄入口**（调 `isolatedEnv` → 动态 import src 组装 `ctx` → 按 SECTIONS 调 `probes/mXX/<section>.ts` 的 `runSection(ctx, check)`），每节断言体逐字搬入对应 `probes/mXX/*.ts`。
- 不变式：`probe:mXX` npm 脚本名不变、SECTIONS 集合不变、每条 `check` 断言文案逐字不变、断言总数不变（拆分前后计数对拍）；`--section=` 单节独立运行能力保持。
- 目标：拆分后 `probe-mXX.ts` 入口 + 各 `probes/mXX/*.ts` 均 ≤800 行（背书：probe-m26 `split-audit` 节行扫描）。

### 2.3 H1 · CI 建设（`ci:check` + 模板校验 + Git 钩子）

- `scripts/validate-templates.ts`：以 pipeline `loader` 全量加载 `workspace/templates/*.yaml`，断言零抛错 + 每模板 `key/version/steps/inputs` 结构合规 + action ∈ `KNOWN_ACTIONS`；输出计数表；异常即非零退出。**纯静态**（不执行 run、不触网）。
- `ci:check`（root `package.json`）= `pnpm -r typecheck` → `node validate-templates`（server 侧）→ `probe:ci`（探针全量 fail-fast）。三段任一失败即整体非零。
- `.githooks/pre-push`：跑 `pnpm typecheck` + 模板校验（轻量档，全量探针交手动/夜间）；启用 = `git config core.hooksPath .githooks`（文档化，不自动改写用户 git 配置）。README 增「CI/门禁」小节。

### 2.4 H3 · 规模化压测与性能基准（`scripts/bench-stress.ts`）

- 隔离临时库种子：`--projects=N --assets-per-project=M --chain-length=K`，批量插入 projects/assets/pipeline_runs+steps（合成数据，无真实生成）。缺省档 `1000 项目 / 10000 资产 / 长 run 链`。
- 量测面（纯本地、零网络）：① 关键列表/聚合查询耗时（项目分页、资产面板聚合、novel-board 聚合、canvas overview 批次聚合）② `buildCanvasDoc` 大图 ③ 内存 RSS 峰值画像（`process.memoryUsage`）。
- 产出：结构化基准报告（各量测 p50/p95/峰值内存 + 数据规模）落 `review` 文（**非 CI 阻断**，供方法库沉淀，回补 M23-D10）；runner/脚本本身不落库常驻。
- 纯函数：`seedDataset(db, spec)` / `percentile(samples, p)` 提炼背书（probe-m26 `stress` 节小样本矩阵）。

### 2.5 H4 · Ollama 本地模型接入（`db/seed.ts` +2 行）

- `VENDOR_SEEDS` + `{ vendor: 'ollama', name: 'Ollama（本地）' }`。
- `PROVIDER_SEEDS` + `{ key: 'ollama_llm', name: 'Ollama（LLM）', serviceType: 'llm', vendor: 'ollama', description: '本地 Ollama OpenAI 兼容端点（/v1，模型在线拉取；无需 API Key，key 填任意占位）', defaultUrl: 'http://localhost:11434/v1', presetModels: JSON.stringify(['qwen2.5', 'llama3.1']) }`。
- 零适配器代码：走 `llm.ts` 通用 `/chat/completions`；模型列表走既有 `POST /api-configs/fetch-models`（Ollama `/v1/models` OpenAI 兼容）。
- 凭证：Ollama 无鉴权——沿用既有「apiKey 占位即通过」路径（`apiKeyRef='local'` fallback 已支持，无 Key 实例在 UI 可留空占位）。
- 实测：条件式——本地若运行 Ollama 则真实拉模型 + 一轮对话（`fetch-models` 200 + chat 非空）；不可得则登记降级（架构种子 + 能力在位，实测待用户环境）。**探针零网络**（Ollama 实测走实弹/手动，不入 probe）。

### 2.6 H7 · 在线可编程供应商（判定关闭 + 排除留痕）

- **结论**：纲领 §五「在线可编程供应商」诉求 = 用户在 UI 配置任意自定义端点 → **既有 `openai_llm`/`openai_image` provider + 实例级 `base_url` 覆盖已完整覆盖**（`api-configs.ts` 允许任意 OpenAI 兼容网关）。判定为**待决策状态解除（已有等价形态）**，回写纲领 §五。
- **永久排除**：运行时「可编程协议脚本」（用户上传 JS/表达式定制非兼容协议供应商）——安全（任意代码执行）/ 复杂度与「适配层 = 代码级新增」原则冲突 → 登记纲领 §四不立项表。私有协议供应商新增仍走代码级适配器（既有纪律）。

### 2.7 红线残余 · ≤800 前端文件全量拆分（M28 式纯重构）

- 目标 5 件（现状行数）：`views/canvas/index.vue` 1172 / `components/NovelBoard.vue` 1099（**M25 新破线，纲领未登记，本次纳入**）/ `components/brand/BrandSettings.vue` 1051 / `lib/api.ts` 975 / `components/pipeline-canvas/CanvasBoard.vue` 855。
- 范式（对齐 M28）：Vue 组件 → 薄 `index.vue`（编排 + 插槽）+ `use-*.ts` composables（状态/副作用）+ 子组件分块；`lib/api.ts` → `lib/api/` 按域拆（projects/assets/runs/canvas/…）+ `index.ts` re-export 保持**导入面零改动**（`@/../lib/api` 路径不变）。
- 不变式：函数体/模板标记/样式逐字保留，无符号重命名，导出签名冻结；组件 props/emits 契约不变；拆分后 `vue-tsc` + `vite build` 绿 + 全量探针**零适配**背书；各产物文件 ≤800 行。

## 3. 数据与兼容

- **零新表零新列**：M26 无任何 schema 变更（Ollama 仅 seed 行，落既有 `api_providers` 表数据）。
- 新增文件：`run-probes.ts` / `validate-templates.ts` / `bench-stress.ts` / `probe-lib.ts` / `probes/m{16,17,18,19,22}/*.ts`（拆分产物）/ `probe-m26.ts` / `.githooks/pre-push`；`lib/api/` 目录化产物。
- 修改文件：`db/seed.ts`（+2 seed 行）/ root+server `package.json`（+`ci:check`/`probe:all`/`probe:ci`/`validate:templates`/`bench` 脚本）/ 5 个前端 >800 文件（拆分）/ README（CI·门禁小节 + M26 速览）/ 纲领（§五 H7 关闭 + §四 + 运行时可编程排除）/ roadmap（M26 注记）。
- `KNOWN_ACTIONS` / DAG / 引擎 / 模板加载签名 / 适配器协议实现 **零 diff**。

## 4. 验收矩阵（exit criteria）

1. **CI 首绿**：`pnpm ci:check` 端到端 exit=0（双端 typecheck + 模板校验 N 模板零抛错 + `probe:ci` 全量探针全绿）；`.githooks/pre-push` 在文档化启用后本地可触发。
2. **探针 runner**：`probe:all` 并行执行全 23 枚（含 m26），汇总正确统计 PASS/FAIL 与耗时；`--fail-fast` 注入一个坏探针能中止并非零退出。
3. **大探针零漂移**：m16/m17/m18/m19/m22 拆分前后**断言总数逐枚相等**且全绿；`probe:mXX` 入口名与 `--section=` 单节运行不变；拆分产物各 ≤800 行。
4. **压测基准**：`bench-stress` 在缺省档（1000 项目/10000 资产/长链）产出不阻断的基准报告（p50/p95/内存画像）落 review；临时库自动清理；小样本矩阵 probe-m26 `stress` 节全绿。
5. **Ollama**：`ollama_llm` seed 行在（`api_providers` 可查，vendor=ollama，service_type=llm）；`fetch-models` 与 chat 走通用兼容路径（本地有 Ollama 则实测拉模型+对话，不可得登记降级——种子与能力位仍全绿）。
6. **红线收口**：全仓应用代码复扫 **>800 行文件 = 0**（探针产物同步 ≤800）；5 个前端文件拆分后行为零变更背书（双端 typecheck + vite build + 全量探针零适配）；抽查浏览器关键视图（画布页 / 小说看板 / 品牌设置 / 合成画布）无回归。
7. **治理留痕**：H7 关闭回写纲领 §五；运行时可编程协议入 §四不立项；H6 提交前置门禁成文 + m18 偏差 #3 关闭；review + roadmap + README 校准。

## 5. 依赖与例外

- 无新 npm 运行时依赖；无新 devDependency（runner 用 node 内置 `child_process`/`os`；压测用既有 `@libsql/client`/`drizzle`）。
- 探针拆分不改任何 `src/`，纯 `scripts/` 面——不触发 M23「例外原则」（无新库）。
- Ollama 不引 `ollama` SDK（走 HTTP 兼容端点，与所有 provider 同构）。

## 6. 实施批次

- **P0 基建**：`probe-lib.ts` + `run-probes.ts` 骨架 + `validate-templates.ts` 骨架 + `ci:check` 脚本挂接 + `ollama_llm` seed + `probe-m26.ts` 骨架（节：runner/probe-lib/ollama-seed/stress/split-audit）+ `.githooks/pre-push` 骨架；门禁 = 双端 typecheck + 冒烟 probe-m26。
- **P1 CI + 探针治理**：`run-probes` 并行/计时/汇总/fail-fast 实装 + 5 枚大探针拆分（`probes/mXX/*.ts`）+ `validate-templates` 实装 + `ci:check` 三段全绿。
- **P2 压测基准**：`bench-stress.ts` 种子 + 量测 + 报告实装 + 小样本探针。
- **P3 红线全量拆分**：5 个前端 >800 文件 M28 式纯重构（含 `lib/api/` 域目录化）+ 浏览器抽查。
- **P4 回归收口**：`probe:all`（经新 runner）全量 + 双端 typecheck + vite build + `ci:check` 首绿 + Ollama 实测（条件式）+ review/roadmap/README/纲领 校准 + ≤800 复扫归零。

## 7. 探针设计（`probe-m26.ts`，零网络零计费，隔离临时库）

- `runner` 节：`parseProbeOutput`（喂构造 stdout → PASS/FAIL 计数正确、含彩色/前缀噪声）+ `formatSummary`（对齐表结构）纯函数矩阵。
- `probe-lib` 节：`makeChecker` 计数与退出语义 + `isolatedEnv` 目录前缀隔离（不触真实库）。
- `split-audit` 节：扫描 `scripts/probe-m{16,17,18,19,22}.ts` + `probes/**` 与 `apps/web/src` 全量文件行数，断言 **无 >800 应用/探针文件**（红线背书的自动化钉子）。
- `ollama-seed` 节：seed 后 `api_providers` 查得 `ollama_llm`（vendor=ollama/service_type=llm/defaultUrl 含 11434）；幂等重放不重复插。
- `stress` 节：`seedDataset` 小样本（个位数项目/资产）落隔离库 + `percentile` 对拍（p50/p95 数学正确）+ 临时库清理。

## 8. 明确排除

- CI 外部平台（Gitee Go / GitHub Actions / 镜像双推）——本里程碑定本地 runner+钩子。
- Ollama **embedding**（provider 层语义向量）——embedding 走本地 ONNX 既有链，provider 化 = 架构新增。
- Ollama **image/video/audio**（本地多模态/生成）——仅 LLM 一等化，其余按既有自定义网关手配。
- 运行时可编程供应商协议脚本（沙箱）——安全/复杂度，永久排除（§四）。
- 探针脚本函数级内部重构（仅按节拆文件，不改断言逻辑）；历史探针统一改用 `probe-lib`（仅新拆的 5 枚接入，其余 17 枚不强制迁移以免动面过大）。
- 压测报告版本化/趋势基线库（本轮仅一次性基准报告落 review）。
- 全仓 ESLint/Prettier 规则重构、构建产物体积预算（另议）。
