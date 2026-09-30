# agencys-content-studio M9 技术设计规格（小说改编链）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-12
- 上游：`2026-09-09-agencys-content-studio-roadmap.md`（北极星不变）；P1⑤「小说改编链」（唯一整项未开发项，去向表原文「先决策要不要」）——2026-09-12 用户拍板立项；三项目源码级对标结论 P1 缺口集群之小说链（Toonflow：`parseNovel.ts` 本地正则切章 + `getAiRegex` LLM 生成切分正则 + `cleanNovel.ts` 逐章事件提取（并发 5 / eventState 状态机）+ `o_event`×`o_eventChapter` 跨章聚合 + `scriptAgent` 四子代理；huobao：剧集实体与分集链）
- 红线复核：**零新表、零新列**（章节/事件/图谱/规划/剧本全部承载为通用文本资产 + purpose 标签；处理状态复用 gen_tasks 状态机）；引擎零改动（engine.ts / refs.ts 零改动；loader.ts 仅 action 白名单 +1）；新增 2 个平台级能力（新 action `text_split`、ai_text batch 扩展）+ 3 个文本契约；新增 1 个模板（novel-adapt v1），既有模板与提示词零改动
- 设计原则四条：**① 通用资产承载业务**（对齐红线「不做体裁专属表」：Toonflow 的 o_novel/o_event 专表在本仓映射为 purpose=chapters/events/graph/plan 的通用文本资产，零迁移）；**② 本地优先、AI 兜底**（切分默认本地正则链，准确率不足时才由 LLM 生成正则；逐章事件提取前有闸门控成本）；**③ 快照即硬证据**（逐章/逐集任务的 prompt 与参数全量进 gen_tasks，幂等变更检测 / 断点续跑与 ai_image 同款生效）；**④ 模板线性链路**（不引入 agent 工具调用范式；分集规划内嵌「章节事件物料包」，逐集剧本直接消费，绕开跨资产动态切片）
- 备注：Toonflow 小说链为「导入即自动提取事件」；本仓将提取显式化为闸门后的流水线步骤（用户先确认切分质量再花钱）。novel-adapt 定位为 **plan 场景**（产出分集剧本），剧本产物对齐 `script-ep.md` 格式，可通过 `next: [series-setup]` / 手动挑选进入「短剧·单集」生产链

---

## 1. 定位与边界

### 1.1 一句话目标

新增「小说改编链」模板 novel-adapt：**小说导入 → 章节切分 → 逐章事件提取 → 事件图谱 → 分集规划 → 逐集改编剧本**，把长篇小说文本转化为可进入既有短剧流水线的分集剧本；四段产物全部为通用文本资产，全链可在 Web 端审阅、断点续跑。

四段对照（对标 Toonflow）：

| 段 | Toonflow 实现 | 本仓 M9 实现 |
|---|---|---|
| 小说导入 | o_novel 专表 + addNovel 接口 | 复用 run 输入 `files`（novel）+ manual_ingest 落库（零新表） |
| 章节切分 | 前端 `parseNovel` 本地正则 + `getAiRegex` LLM 生成正则 | 新 action `text_split`：默认正则链 → 用户正则 → AI 正则资产（三级优先级，产物化） |
| 事件图谱 | `cleanNovel` 逐章 LLM（并发 5，eventState 0/1/-1）+ o_event/o_eventChapter 聚合 | ai_text batch 逐章事件提取（gen_tasks 状态机等价 eventState）→ 归并步骤产 graph-json |
| 改编剧本 | scriptAgent 决策 + 四子代理（工具调用） | 分集规划 plan-json（内嵌章节事件物料包）+ batch 逐集剧本（线性模板，对齐 script-ep 格式） |

### 1.2 范围（做）

| # | 主项 | 内容 |
|---|---|---|
| P1 | 新 action `text_split` | 多源文本合并 + 三级正则切分（用户 > AI > 默认）+ 卷识别 + 章节范围过滤 + min_chapters 校验 + manifest/章节资产生成 + 纯函数导出 |
| P2 | ai_text batch 扩展 | `batch.field` 读 JSON 数组逐项生成；item 标识（`params.item_key`/探测）；逐项注入 item JSON + `item.asset_id` 资产全文；`name_tpl` 按 item 插值；gen_tasks(kind='text') 幂等/并发/重试/取消 |
| P3 | ai_text 采样截断 | `params.max_input_chars`（单调用路径）：超长资产注入前头尾双段采样，防超 context |
| P4 | 三新文本契约 | `event-json`（chapter_index + core_event）/ `graph-json`（key_events 非空）/ `plan-json`（episodes 非空） |
| P5 | 五新提示词 | `split-regex.md` / `chapter-events.md` / `event-graph.md` / `plan-episodes.md` / `adapt-script.md` |
| P6 | 新模板 novel-adapt v1 | 7 步（ingest → make_split_regex(when) → split_chapters(gate) → extract_events(batch) → merge_events → plan_episodes(gate) → adapt_script(batch,gate)）+ 8 输入；scene=plan；next=[series-setup] |
| P7 | 服务端聚合读 | 新服务 `services/novel-board.ts` + 路由 `GET /runs/:id/novel-board`（切分/事件/图谱/规划/剧本五面只读聚合） |
| P8 | Web | `NovelBoard.vue` 挂载于 text_split 步骤卡（章节表 + 事件状态 + 图谱 + 规划 + 剧本列表）；purpose 中文标签 |
| P9 | purpose 扩展 | `purposeSubDir` 增 chapters/events/graph/plan/regex → texts；`JSON_FORMATS` 增 4 成员 |
| V1 | 验证 | `probe-m9.ts`（split / batch / contracts / api / template 五节）+ 低成本实弹（3 章短篇）+ 兼容回归 |

### 1.3 M9 不做（明确排除）

| 排除项 | 理由 |
|---|---|
| docx / epub 导入 | 前端 .txt/.md 覆盖主链路；二进制文档解析（mammoth 等）需新依赖，留 backlog |
| 章节内容可视化编辑器 | 章节资产走既有资产预览/编辑能力；专用编辑器留 backlog |
| 事件图谱可视化（力导向图） | 图谱以 graph-json + 结构化表格承载；图形渲染引擎留 backlog |
| 多部小说同链合并 | 单 run 单部小说（多文件按序拼接视为同部多卷）；跨部合并留 backlog |
| 自动连载 / 增量导入新章 | 需 run 输入更新语义与增量切分，留 backlog |
| 小说源抓取（爬虫） | 以用户粘贴/上传文本为准 |
| 改编一致性回查（剧本 vs 原作审计） | 复用既有审查提示词模式另立模板，留 backlog |
| 事件级编辑（改事件后重推导） | 事件资产可经闸门驳回重跑整步；事件级精细编辑留 backlog |

---

## 2. 现状与复用面（代码证据，2026-09-12 核实）

### 2.1 已就绪（本次改造的直接地基）

| 面 | 现状 | 证据 |
|---|---|---|
| run 输入 files | RunFormModal files kind → `input[key] = 项目资产 id 数组`（上传走 POST /projects/:id/imports） | `apps/web/src/components/RunFormModal.vue` L36-68、`routes/assets.ts` |
| 素材入库 | manual_ingest：docs=资产 id 数组、brief=文本 → 产物 `[brief 资产, ...docs 资产]` | `actions/manual-ingest.ts` |
| 引用解析 | `input.x` 原样透传（缺键宽容 undefined）；`steps.x.asset`=[首个] / `.assets`=全量；**上游被跳过 → 解析为 `[]`（宽容语义）** | `pipeline/refs.ts` L50-85、L214-237 |
| batch 范式 | ai_image：field→数组→逐项 gen_task→幂等（resultAssetId 复用）→并发池+1.5s 重试→RunCancelledError→产物按序聚合→失败汇总抛错 | `actions/ai-image.ts` L50-220 / L222-328 |
| 任务状态机 | gen_tasks：status pending/processing/succeeded/failed/cancelled + attempts + params JSON 快照 + emitStudioEvent | `db/schema.ts` genTasks、ai-image.ts |
| 文本契约 | `validateTextOutput`（4 契约）+ `extractJson` 剥围栏 + `defaultName` + tag 映射 | `actions/ai-text.ts` L139-256 |
| 存储 | `writeTextAsset` / `readTextAsset` / `purposeSubDir`（未列出 → 回退 source）/ `JSON_FORMATS` | `services/storage.ts` L33-71 / L143-187 |
| 闸门 | gate：message 经 interpolate；`gate.when` 不满足免审直过；skip_label 免审放行记 user_skip | `pipeline/engine.ts` L91-168 / L497-505 |
| 步骤产物 | `StepOutputDoc = {asset_ids: number[]}` JSON 落 pipeline_steps.output；run 详情返回 steps 全字段 | `engine.ts` L45-51 / L497、`routes/runs.ts` L55-80 |
| 模板 DSL | 输入 kinds text/files/int/bool；when 表达式（`input.x == true`）；gate {mode,message,when,skip_label}；batch {field,max_concurrent,retry} | `pipeline/loader.ts` L42-232、`templates/mengbao-episode.yaml` |
| 探针范式 | probe-m8：隔离环境（CSTUDIO_ROOT/DATA/WORKSPACE 临时目录）+ 真实模板拷入隔离目录 + check/failed + app.request 内存 HTTP + 退出码 | `apps/server/scripts/probe-m8.ts` |
| Web 挂载 | ShotBoard：`WB_ACTIONS.has(s.actionKey)` → 步骤卡内嵌，`@changed="loadDetail()"` | `views/RunDetailView.vue`、`components/ShotBoard.vue` |

### 2.2 缺口（M9 要补）

1. **无章节切分能力**：Toonflow 切分在前端且不产物化；本仓需服务端 action（可探针、可闸门、可续跑）；
2. **ai_text 无 batch**：逐章事件提取需 N 次同模板调用，现只能开 N 个步骤；
3. **无 novel 系契约**：event/graph/plan 三类 JSON 无校验器；
4. **无改编写提示词与模板**；
5. **purpose 无小说系标签**：chapters/events/graph/plan/regex 无目录映射与 UI 标签；
6. **无小说链聚合视图**：章节×事件状态、图谱、规划、剧本需一屏可审。

### 2.3 对标落法（源码核实）

| 维度 | Toonflow | 本仓 M9 落法 |
|---|---|---|
| 章节切分 | `parseNovel` 本地正则（卷 `第X卷` + 章 `第X章/回/节` + 中文数字）；失败 → `getAiRegex` LLM 生成正则（两捕获组） | `text_split` action 三级正则：用户正则（input）> AI 正则（上游资产）> 默认正则链；产物 = manifest + 逐章 .md |
| 事件提取 | `cleanNovel`：逐章 LLM 事件表格（并发 5），`o_novel.eventState` 0/1/-1 标记 | ai_text batch：逐章 event-json，gen_tasks status（pending/processing/succeeded/failed）+ params.itemId 幂等 |
| 事件聚合 | `o_event` × `o_eventChapter` 多对多 + GROUP_CONCAT 跨章查询 | `merge_events` 单次 LLM 归并 → graph-json（key_events[].chapters 数字数组即跨章关系） |
| 剧本生成 | scriptAgent 决策 Agent + storySkeleton/adaptationStrategy/script/supervision 四子代理（工具调用 get_novel_text 等） | `plan_episodes` 单次 LLM 产 plan-json（分集 + **内嵌 chapter_events 物料包**）；`adapt_script` batch 逐集消费物料包出剧本（无 agent，物料包替代动态切片） |
| 状态展示 | 前端轮询 o_novel.eventState | gen_tasks × manifest join → `GET /runs/:id/novel-board` 聚合读（NovelBoard.vue） |

---

## 3. 设计（决策完备）

### 3.1 数据模型（零改动，红线论证）

**不新增任何表/列**。三类数据的承载映射：

| 数据 | 承载 | 说明 |
|---|---|---|
| 章节原文 | 通用资产 purpose=`chapters`（manifest JSON + 逐章 .md） | Toonflow o_novel 的等价物 |
| 章节事件 | 通用资产 purpose=`events`（event-json，一章一资产） | Toonflow o_event 的等价物 |
| 图谱/规划/剧本 | 通用资产 purpose=`graph`/`plan`/`script` | Toonflow 归并产物 / scriptAgent 产物的等价物 |
| 章节×事件处理状态 | `gen_tasks`（stepId=extract_events 步骤，params.itemId=章节 index） | Toonflow `eventState` 的等价物（状态机更完整：attempts/errorMsg/取消） |

`db/schema.ts` 仅一处注释更新：`genTasks.kind` 注释 `"image|video"` → `"image|video|text"`（零列变更；无 DB 级 CHECK 约束）。

### 3.2 新 action `text_split`（`pipeline/actions/text-split.ts`）

```
text_split：长文本按章节切分（spec §5.3 扩展）。
inputs.source（资产 id 数组，按序拼接，全部文本资产）→ 三级正则切分 →
章节范围过滤 → min_chapters 校验 → 产物 [manifest, ...逐章资产]。
纯函数导出（splitChapters / parseChapterRange）供探针直接断言。
```

**参数（params）**：

| 参数 | 默认 | 语义 |
|---|---|---|
| `min_chapters` | 2 | 切分后章节数下限（防「整文单章」兜底静默通过；不足抛错带指引） |
| `output_purpose` | `chapters` | 产物 purpose（manifest 与章节同 purpose，目录 texts） |
| `regex_max_chars` | 300 | 用户/AI 正则长度上限（ReDoS 缓解；超限抛错） |

**输入（inputs）**：

| 输入 | 形态 | 语义 |
|---|---|---|
| `source` | 资产 id 数组 | 多个文本资产按序拼接（多文件=多卷/多段）；非文本资产跳过并记日志；全非文本抛错 |
| `chapter_regex` | 字符串（选填） | 用户自定义正则（透传 `input.chapter_regex`；空/缺 → 跳过） |
| `ai_regex` | 资产 id 数组（选填） | 上游 AI 正则资产（`steps.make_split_regex.asset`；被跳过时解析为 `[]` → 跳过）；取资产内容首个非空行（剥 markdown 围栏） |

**正则优先级**：用户正则 > AI 正则 > 默认正则链。`manifest.regex_source` 记 `user|ai|default` 溯源。

**切分算法**（纯函数）：

```ts
export interface ChapterSlice { index: number; title: string; reel: string | null; content: string }

/** 默认章头正则（对齐 Toonflow DEFAULT_CHAPTER_REGEX；组1=章号 组2=标题；^ 行首锚定防正文引用误切） */
export const DEFAULT_CHAPTER_REGEX = /^第\s*([0-9０-９零一二三四五六七八九十百千万两]+)\s*[章回节]\s*([^\n\r]*)/gm
/** 卷头正则（行首；对齐 Toonflow REEL_REGEX） */
export const REEL_REGEX = /^(第[\d一二三四五六七八九十百千两]+卷)\s*([^\n第]*)/gm

/** 章节范围解析："1-30" / "1,3,5-9" → 顺序号数组；空/非法 → null（调用方抛错） */
export function parseChapterRange(spec: string): number[] | null
/** 切分主函数：卷标记 + 章标记合并扫描 → ChapterSlice[] */
export function splitChapters(
  text: string,
  chapterRe: RegExp | null,   // null → 用 DEFAULT_CHAPTER_REGEX
): { chapters: ChapterSlice[]; skippedHeadChars: number }
```

扫描规则（决策完备）：
1. 卷标记（`REEL_REGEX`）与章标记（章正则）分别 `matchAll`，按 `index` 升序合并；相交时章标记优先（章头行内含卷词的情形）；
2. 遇到卷标记 → 更新「当前卷」（取标记行全文 trim 为卷标题）；遇到章标记 → 切出上一章（content = 上一章头位置到本章头位置），新章 `reel` = 当前卷；
3. `title` = 章正则捕获组 2（trim；空 → `''`，落资产名时用 `第{index}章` 兜底）；**不解析章号**（原文编号仅存在于标题文本中；`index` = 切分顺序号 1-based，与 Toonflow addNovel 的 chapterIndex 自增同义）；
4. 首个章标记之前的文本丢弃（`skippedHeadChars` 记录字符数；多文件拼接的前言/简介不会成为章节）；
5. 全文无章标记 → 整文单章（title `''`）→ 由 `min_chapters`（默认 2）拦截并给出指引报错。

**范围过滤**：`parseChapterRange` 按顺序号过滤（越界号忽略；spec 非空且解析为 null → 抛错「章节范围格式非法（示例 1-30 / 1,3,5-9）」）。过滤后 `selected.length < min_chapters` → 抛错：`切分后章节数 N 少于 min_chapters=M（可调小 min_chapters / 检查章节范围 / 提供 chapter_regex / 开启 with_ai_split）`。

**正则安全**：用户/AI 正则长度 > `regex_max_chars` → 抛错；编译失败 → 抛错（含原因与示例）；统一 `gm` 标志编译（`g` 必需，`m` 使 `^` 行首锚点可用）。

**产物**（顺序固定：manifest 第一，其后按章节顺序）：

```json
// 章节索引.json（format: chapter-manifest-json → ext=json；purpose=chapters）
{
  "source": { "asset_ids": [12], "names": ["斗破苍穹.txt"], "chars": 123456 },
  "regex_source": "default",
  "regex_used": "^第\\s*([0-9０-９零一二三四五六七八九十百千万两]+)\\s*[章回节]\\s*([^\\n\\r]*)",
  "total": 30,
  "selected": 10,
  "range": "1-10",
  "skipped_head_chars": 0,
  "reels": ["第一卷 少年"],
  "chapters": [
    { "index": 1, "reel": "第一卷 少年", "title": "陨落的天才", "name": "第001章-陨落的天才.md", "asset_id": 13, "chars": 3200 }
  ]
}
```

逐章资产：`name = 第{index:03d}章-{title}.md`（title 空 → `第{index:03d}章.md`），purpose=`chapters`，format 缺省（.md），tags `['chapter']`，params `{index, reel, chars}`。manifest 与章节同 purpose → batch.field (`chapters`) 读 `assetIdsOf(field)[0]` 即 manifest（**产物顺序即契约**）。

### 3.3 ai_text batch 扩展（`actions/ai-text.ts`）

`aiText(ctx)` 入口分派：`ctx.def.batch` 存在 → `aiTextBatch(ctx, batch)`；否则走既有单调用路径（**零改动**，仅前置增加分派）。

**batch 语义**（镜像 ai_image 范式）：

| 环节 | 决策 |
|---|---|
| 数组定位 | `ctx.assetIdsOf(field)` → 读**首个**资产 JSON → `Array.isArray(obj) ? obj : obj[field] ?? []`；空数组抛错 |
| 静态注入 | `ctx.input` 各键照单调用规则注入 sections，**但跳过 field 键本身**（其资产由数组+逐项机制替代，防止全量章节注入） |
| 逐项注入 | `--- item ---\n{item JSON}`；若 `item.asset_id` 为正整数 → 读该资产全文，注入 `--- 章节原文 / {资产名} ---\n{全文}` |
| item 标识 | `params.item_key`（如 `index`/`ep`）→ `String(item[item_key])`；缺省探测 `['id','index','ep']`；再无 → `pos:{序号}`；**重复标识抛错** |
| 幂等 | `params.itemId` 定位既有 task：succeeded 跳过；failed 有变化归零重排队；未成功同步最新 prompt/name（幂等变更检测同 ai_image） |
| name 插值 | `name_tpl` 用 `{...runInput, ...item}` 插值（`{index:03d}` / `{ep:02d}` 生效；入队时定名存 `params.name`） |
| 执行 | 并发池（`batch.max_concurrent`，默认 2）；每项：取消检查 → attempts++ → processing → chatCompleteDetailed → recordLlmUsage → validateTextOutput → writeTextAsset → succeeded + resultAssetId；失败 `batch.retry`（默认 1）内 1.5s 重试 |
| 产物 | 按 items 顺序聚合 resultAssetId；失败汇总抛错（同 ai_image 口径） |
| 任务行 | gen_tasks kind=`text`，params 快照 `{itemId, itemKey, output_format, output_purpose, name, chars}` |

**新增导出（探针断言用纯函数）**：

```ts
export function extractBatchItems(obj: unknown, field: string): Record<string, unknown>[]
export function batchItemId(item: Record<string, unknown>, pos: number, itemKey?: string | null): string
export function buildItemPrompt(opts: { templateText: string; staticSections: string[]; itemJson: string; itemAssetSection?: string }): string
```

**单调用路径增补 `max_input_chars`**（P3，选填）：资产全文注入 section 时，若 `params.max_input_chars` > 0 且内容超长 → 头半 + `\n…（中间省略，全文 N 字符）\n` + 尾半 采样。用于 `split-regex` 步骤（整本小说截样 30000 字符足够识别章节格式）。

### 3.4 三新文本契约（`validateTextOutput` 扩展）

```ts
// event-json：单章事件（extract_events 逐章产物）
{ "chapter_index": 1, "title": "陨落的天才", "core_event": "……",
  "sub_events": ["…"], "characters": ["萧炎"], "main_relation": "…", "intensity": 4, "notes": "…" }
// 校验：chapter_index 为整数 + core_event 非空字符串；返回 1
```

```ts
// graph-json：事件图谱（merge_events 产物）
{ "overview": "…", "characters": [{ "name": "萧炎", "role": "主角", "arc": "…" }],
  "key_events": [{ "id": "E1", "name": "退婚", "summary": "…", "chapters": [1,2], "intensity": 5, "kind": "转折" }] }
// 校验：key_events 非空数组；每项 name 非空 + chapters 非空数字数组；characters 若存在则每项 name 非空；返回 key_events.length
```

```ts
// plan-json：分集规划（plan_episodes 产物；chapter_events 自含物料包供 adapt_script 消费）
{ "title": "…", "episode_count": 12, "episodes": [
  { "ep": 1, "title": "归乡", "chapters": [1,2], "synopsis": "…",
    "opening_hook": "…", "ending_hook": "…", "key_event_ids": ["E1"],
    "chapter_events": [{ "chapter_index": 1, "core_event": "…", "characters": ["萧炎"] }] } ] }
// 校验：episodes 非空；每项 ep 为整数 + chapters 非空数组 + synopsis 非空；chapter_events 若存在则每项 chapter_index 整数 + core_event 非空；返回 episodes.length
```

**联动**：`JSON_FORMATS` 增 `event-json` / `graph-json` / `plan-json` / `chapter-manifest-json`（storage ext/mime 判定）；`defaultName` 增 `events.json` / `event-graph.json` / `plan.json`；tag 映射增 `events` / `graph` / `plan`（`chapter-manifest-json` 不经 ai_text，不增）。`validateTextOutput('chapter-manifest-json')` 落既有 `return 0` 分支（非 LLM 产物）。

### 3.5 五新提示词（`workspace/prompts/`）

| 文件 | 输入 | 输出 | 要点 |
|---|---|---|---|
| `split-regex.md` | 小说文本采样 | 单行正则 | 只输出正则本体（无围栏/无解释）；两个捕获组（章号+标题）；覆盖 `第X章/回/节` 与中文数字；行首锚点用 `^`（运行时 `m` 标志） |
| `chapter-events.md` | 章节原文全文 + item JSON + 改编要求 | event-json | 一章一事件；core_event 一句话主线；characters 出场人物全量；intensity 1-5；严禁编造原文没有的情节 |
| `event-graph.md` | 全部 event-json 资产 + 改编要求 | graph-json | 归并跨章事件（同事件多章 → chapters 数组）；key_events 8-20 条覆盖主线；characters 记主角弧线 |
| `plan-episodes.md` | graph + 全部事件 + 改编要求 | plan-json | 按钩子/反转切集；每集 chapters 连续覆盖全部章；**chapter_events 逐章内嵌物料包**（chapter_index/core_event/characters/key_moments）；opening_hook/ending_hook 强制 |
| `adapt-script.md` | 单集 episode JSON（含 chapter_events 物料包）+ 改编要求 | markdown 剧本 | 对齐 `script-ep.md` 格式规范（集标题/梗概/人物表/场景与对白/R16 钩子/R15 AI 味自检）；只基于物料包改编，不得引入未提供设定 |

### 3.6 模板 novel-adapt v1（`workspace/templates/novel-adapt.yaml`）

```yaml
key: novel-adapt
version: 1
name: 小说改编（章节切分 → 事件图谱 → 改编剧本）
description: 适合：把小说文本（txt/md）改编为可投入短剧生产链的分集剧本。流程：小说入库 → 章节切分（可审阅）→ 逐章事件提取（批量）→ 事件图谱归并 → 分集规划（可审阅）→ 逐集改编剧本（批量，可审阅）。
genre: drama_short
scene: plan
next: [series-setup]
inputs:  # 8 项
  - { key: novel,        label: 小说原文文件（txt/md，可多份按序拼接）, kind: files, required: true, accept: [.txt, .md] }
  - { key: adapt_brief,  label: 改编要求（目标风格/集数/受众等）, kind: text, required: true }
  - { key: chapter_regex, label: 自定义章节正则（选填，两个捕获组：章号+标题；留空自动识别）, kind: text, required: false }
  - { key: chapter_range, label: 章节范围（选填，如 1-30 或 1,3,5-9；按切分顺序编号）, kind: text, required: false }
  - { key: with_ai_split,   label: AI 生成切分正则（自动识别失败时兜底）, kind: bool, required: false, default: false }
  - { key: with_split_review, label: 切分审阅（true=切分后挂闸门）, kind: bool, required: false, default: true }
  - { key: with_plan_review,  label: 分集规划审阅（true=规划后挂闸门）, kind: bool, required: false, default: true }
  - { key: with_script_review, label: 剧本审阅（true=逐集剧本完成后挂闸门）, kind: bool, required: false, default: false }
defaults:
  llm: { temperature: 0.7, max_tokens: 24000 }  # 对齐既有模板惯例（plan-json 可能较大）
steps:  # 7 步
  # 1 ingest        manual_ingest：docs=input.novel, brief=input.adapt_brief（落 brief 资产供下游注入）
  # 2 make_split_regex  ai_text（when: input.with_ai_split == true）：novel=input.novel, prompt=split-regex.md,
  #                     output_purpose=regex, name_tpl=章节切分正则.md, max_input_chars=30000
  # 3 split_chapters    text_split：source=input.novel, chapter_regex=input.chapter_regex, chapter_range=input.chapter_range,
  #                     ai_regex=steps.make_split_regex.asset，
  #                     after=[ingest, make_split_regex]（显式混合依赖：AI 正则步条件跳过时不触发「依赖全跳过」级联），
  #                     params.min_chapters=2；gate(when: with_split_review == true, skip_label: 切分无误)
  # 4 extract_events    ai_text batch：chapters=steps.split_chapters.assets, brief=steps.ingest.asset,
  #                     batch {field: chapters, max_concurrent: 3, retry: 1},
  #                     params: chapter-events.md / event-json / item_key=index / name_tpl="第{index:03d}章-事件.json"
  # 5 merge_events      ai_text：events=steps.extract_events.assets, brief=steps.ingest.asset,
  #                     params: event-graph.md / graph-json / name_tpl=事件图谱.json
  # 6 plan_episodes     ai_text：graph=steps.merge_events.asset, events=steps.extract_events.assets, brief=steps.ingest.asset,
  #                     params: plan-episodes.md / plan-json / name_tpl=分集规划.json；
  #                     gate(when: with_plan_review == true, skip_label: 规划认可)
  # 7 adapt_script      ai_text batch：episodes=steps.plan_episodes.asset, brief=steps.ingest.asset,
  #                     batch {field: episodes, max_concurrent: 2, retry: 1},
  #                     params: adapt-script.md / script / item_key=ep / name_tpl="第{ep:02d}集-改编剧本.md"；
  #                     gate(when: with_script_review == true, skip_label: 剧本认可)
```

**关键引用链复核**：
- `steps.make_split_regex.asset` 在 `with_ai_split=false`（步骤 skipped）时解析为 `[]` → text_split 无 AI 正则，走默认链 ✓（refs 宽容语义，L66-68）；**但依赖判定不吃宽容语义**：split_chapters 显式声明 `after: [ingest, make_split_regex]` 混合依赖（恒成功的 ingest 兜底），否则唯一依赖被条件跳过会触发引擎规则①级联全跳过（2026-09-12 实弹暴露并修复，详见 §3.9）；
- `steps.ingest.asset` = `[brief 资产]`（manual_ingest 产物首个即 brief）→ 各 ai_text 步骤注入改编要求全文 ✓；
- `extract_events.inputs.chapters` = `steps.split_chapters.assets` = `[manifest, ...章节]`；batch 读 `ids[0]`=manifest，逐项经 `item.asset_id` 读章节全文 ✓（**manifest 产物顺序第一即契约**）；
- `input.chapter_regex` 未提供 → resolveRefString 返回 undefined → text_split 视为无 ✓。

### 3.7 聚合读：`services/novel-board.ts` + `routes/novel.ts`

```
GET /api/v1/runs/:id/novel-board  →  NovelBoard（只读，零副作用）
```

构造逻辑（服务层，不依赖步骤 key 命名——按产物 purpose 归类）：

1. run 不存在 → 404；run 内无 text_split 步骤 → `{ run_id, found: false }`；
2. text_split 步骤 output.asset_ids[0] → manifest 资产（purpose=chapters，name=章节索引.json）→ 解析 JSON；
3. 遍历 run 的 ai_text 步骤：读各自产物资产行的 purpose，归类 events / graph / plan / script 步骤（purpose 由模板 params 指定，稳定锚点）；
4. 事件状态：events 步骤 → gen_tasks（runId+stepId）→ `params.itemId` ↔ task.status 映射 → 附着到 manifest.chapters（`event_status`）并统计 `{total, done, failed}`；
5. scripts：script 步骤产物资产 + gen_tasks params.itemId（ep）→ 排序输出；
6. 返回：

```ts
{
  run_id: number
  found: boolean
  step: { key: string; status: string } | null          // text_split 步骤
  split: {
    manifest: {……};                                       // 章节索引.json 全文
    chapters: Array<{ index, title, reel, name, asset_id, chars, event_status: string | null }>
  } | null
  graph: { asset_id: number; name: string; doc: unknown } | null
  plan:  { asset_id: number; name: string; doc: unknown } | null
  scripts: Array<{ asset_id: number; name: string; ep: number | null }>
  events: { total: number; done: number; failed: number } | null
}
```

注册：`app.ts` 增 `import { novelRoutes } from './routes/novel'` + `api.route('/', novelRoutes)`。

### 3.8 Web：`NovelBoard.vue` + 挂载 + 标签

- **挂载**（`views/RunDetailView.vue`，仿 ShotBoard）：
  ```vue
  <NovelBoard v-if="s.actionKey === 'text_split'" :run-id="runId" :step="s" />
  ```
  组件内 `watch(() => props.step.status)`（active 时）+ 挂载时拉取 `GET /runs/:id/novel-board`；`waiting_input` / `succeeded` / `failed` 均展示（含任务进行中轮询：step 非终态时 3s 定时刷新，终态即停）。
- **布局**（只读看板，单列卡片）：
  - 头部：章节统计（`选中/总数`、`regex_source` 徽标）+ 刷新按钮；
  - 段①章节表：序号 / 标题 / 卷 / 字数 / 事件状态徽标（pending/processing/succeeded/failed/—）；
  - 段②事件图谱：overview 段落 + 角色小卡（name/role/arc）+ 关键事件表（id/名称/涉及章/强度/类型）；
  - 段③分集规划：集卡片（集号+标题 / 覆盖章 / synopsis / 双钩子）；
  - 段④剧本列表：`第NN集-改编剧本.md` 资产链接（点击走既有资产预览）。
- **api.ts**：`novelApi.board(runId)`；**types.ts**：NovelBoard 系接口；**format.ts** PURPOSE_TEXT 增 `chapters→章节` / `events→事件` / `graph→事件图谱` / `plan→分集规划` / `regex→切分正则`。
- 样式沿用既有面板语言（面板边框、步骤卡内嵌、徽标色系）。

### 3.9 降级与边界语义总表

| 场景 | 语义 |
|---|---|
| source 混入非文本资产 | 跳过 + 日志；全非文本 → 抛错 |
| 用户正则空/缺 | 跳过该级；非法/超长 → 抛错（含示例指引） |
| AI 正则步骤被跳过 | `steps.x.asset` → `[]` → 跳过该级（取值宽容） |
| 后继步依赖被条件跳过的步骤 | 引擎规则①「依赖全终态且全 skipped → 自动 skipped」会级联跳过（`depsFor` 默认依赖=前一步骤，与 inputs 引用无关）；破解：后继步显式 `after: [恒成功步, 条件步]` 混合依赖（split_chapters 已按此声明，对齐 mengbao `after: [char_profile, gen_refs]` 惯例） |
| 切分无章标记 | 整文单章 → min_chapters（≥2）拦截报错 |
| chapter_range 越界/空集 | 过滤后 < min_chapters → 抛错 |
| 章节范围格式非法 | parseChapterRange → null → 抛错 |
| batch 数组为空/缺 field | 抛错（含 field 名） |
| batch item 标识重复 | 抛错（防幂等映射冲突） |
| item.asset_id 缺失 | 不注入原文 section（prompt 仍含 item JSON） |
| 事件提取单章失败 | 重试 batch.retry 次 → task failed → 全步汇总抛错（断点续跑只补失败项） |
| with_*_review=false | gate.when 不满足 → 免审直过（不挂起） |
| 剧本步骤闸门 | 批量完成后的**总闸门**（不逐集挂起）；逐集质量由驳回整步重跑修正 |

---

## 4. 改动清单（文件级）

### 4.1 服务端（apps/server）

| 文件 | 改动 |
|---|---|
| `src/pipeline/actions/text-split.ts` | **新增**：textSplit action + splitChapters / parseChapterRange / 常量导出 |
| `src/pipeline/actions/ai-text.ts` | 修改：batch 分派 + aiTextBatch + 3 契约 + max_input_chars + defaultName/tag + 3 纯函数导出 |
| `src/pipeline/actions/index.ts` | +1 行：import + registry `text_split` |
| `src/pipeline/loader.ts` | +1 行：KNOWN_ACTIONS `text_split` |
| `src/services/storage.ts` | purposeSubDir 增 5 case；JSON_FORMATS 增 4 成员 |
| `src/db/schema.ts` | 仅注释：gen_tasks.kind → `"image|video|text"` |
| `src/services/novel-board.ts` | **新增**：buildNovelBoard 聚合读 |
| `src/routes/novel.ts` | **新增**：GET /runs/:id/novel-board |
| `src/app.ts` | +2 行：import + route 注册 |
| `scripts/probe-m9.ts` | **新增**：五节探针 |
| `package.json` | probe:m9 脚本（如 probe:m8 存在同款） |

### 4.2 工作区（workspace）

| 文件 | 改动 |
|---|---|
| `prompts/split-regex.md` | **新增** |
| `prompts/chapter-events.md` | **新增** |
| `prompts/event-graph.md` | **新增** |
| `prompts/plan-episodes.md` | **新增** |
| `prompts/adapt-script.md` | **新增** |
| `templates/novel-adapt.yaml` | **新增** |

### 4.3 Web（apps/web）

| 文件 | 改动 |
|---|---|
| `src/components/NovelBoard.vue` | **新增** |
| `src/views/RunDetailView.vue` | import + 挂载块 |
| `src/lib/api.ts` | novelApi.board |
| `src/lib/types.ts` | NovelBoard 接口 |
| `src/lib/format.ts` | PURPOSE_TEXT +5 |

### 4.4 文档与收尾

| 文件 | 改动 |
|---|---|
| `docs/superpowers/specs/2026-09-12-agencys-content-studio-m9-design.md` | 本文件 |
| `docs/superpowers/specs/2026-09-09-agencys-content-studio-roadmap.md` | 增 M9 注记 |
| `Agent/agencys-content-studio/README.md` | M9 小节（按既有模式） |

### 4.5 不改动清单（红线）

`pipeline/engine.ts`、`pipeline/refs.ts`、`pipeline/context.ts`、`pipeline/actions/ai-image.ts`、`ai-video.ts`、`tts.ts`、`subtitle.ts`、`character-sync.ts`、`entity-sync.ts`、`ffmpeg-merge.ts`、`services/shot-workbench.ts`、适配器层、`ShotBoard.vue`、`TaskPanel.vue`、既有 5 模板与全部既有提示词、initDb 迁移（零新表零新列 → 无迁移）。

---

## 5. 验收

### 5.1 静态

- `apps/server`：`npx tsc --noEmit` 零错误（含新 action/服务/路由/探针）；
- `apps/web`：`npx vue-tsc --noEmit` 零错误；
- 模板校验：novel-adapt 经 `validateTemplateText` 零 error 零 warning（5 提示词文件在位）。

### 5.2 探针 `scripts/probe-m9.ts`（隔离环境，零网络零计费）

| section | 断言 |
|---|---|
| `split` | parseChapterRange："1-3"/"1,3,5-9" 解析、"5-3"/"abc"/"" → null；splitChapters：默认正则 3 章文本 → 3 章 + 标题正确；卷文本 → reel 归属；中文数字章头（"第二章"）；无匹配 → 单章 + skippedHeadChars；用户正则路径 + 相交卷章标记 |
| `batch` | extractBatchItems：`obj[field]` / 根数组 / 缺字段 → []；batchItemId：item_key 命中 / 探测 index / 探测 ep / pos 兜底；buildItemPrompt：模板+静态+item+原文四段拼装顺序与分隔符 |
| `contracts` | event-json：合法 → 1；缺 core_event / chapter_index 非整数 → 抛错；graph-json：合法 → N；key_events 空/chapters 空 → 抛错；plan-json：合法 → N；ep 非整数 / synopsis 空 → 抛错；围栏剥离；chapter-manifest-json → 0 |
| `api` | 隔离库直插：project + run + steps（text_split succeeded w/ manifest 资产、ai_text events/graph/plan/script）+ gen_tasks → `app.request('GET /runs/:id/novel-board')`：found=true / chapters 含 event_status / graph+plan 解析 / scripts 排序 / 事件统计；无 text_split 的 run → found=false；不存在 → 404 |
| `template` | novel-adapt 加载成功：version=1 / steps=7 / inputs=8 / 三步 batch-gate 契约（field=chapters|episodes、item_key、name_tpl）/ gate.when 绑 with_*_review / scene=plan / next=[series-setup]；5 提示词文件拷入后 missingPromptsOf=[]；回归：mengbao-episode v8 + series-setup v2 加载契约不变 |

### 5.3 实弹（低成本，deepseek）

3 章短篇测试小说（自拟 ~3×1.5K 字）→ run：`chapter_range="1-3"`、`with_ai_split=false`、`with_split_review=true`、`with_plan_review=true`、`with_script_review=false`：
1. 切分闸门：manifest 3 章 + 章节资产 + regex_source=default；NovelBoard 章节表 3 行；
2. 批注 approve → extract_events 批 3 项（3 次 LLM）→ 事件资产 3 份、gen_tasks 3 行 succeeded；
3. merge 1 次 + plan 1 次 → 规划闸门（plan-json 校验 + NovelBoard 规划段）；
4. approve → adapt_script 批 N 集 → 剧本资产、NovelBoard 剧本段；全 run succeeded；
5. 浏览器截图 NovelBoard 四段（验收快照）。

LLM 预计：1（正则步不开）+3（事件）+1（图谱）+1（规划）+1~2（剧本）≈ 6-7 次。

### 5.4 兼容回归

`probe-m2a / m3 / m6 / m7 / m8` 全绿（重点：ai_text 单调用路径、mengbao/series-setup 模板、ShotBoard 链路不受 batch 分派影响）。

### 5.5 越界核查

- 断言零新表/零新列（probe api 段顺带 PRAGMA 校验无新表）？——探针口径：novel-board 段跑完 `sqlite_master` 表名单与 M8 一致（characters/style_presets 等既有表，无 novel/chapter/event 表）；
- 静态 Grep：`engine.ts` / `refs.ts` 无改动（diff 核查）。

### 5.6 文档

roadmap 增 M9 注记；README「M9 验收快照」（实弹后）。

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 超长小说超 context | `chapter_range` 分段处理 + `max_input_chars` 采样截断（split-regex 步）+ 闸门确认切分范围后才烧事件提取；文档写明「建议单次 ≤30 章」 |
| 切分误切（书名含"第X章"字样等） | 闸门审阅 + manifest 全链路溯源（regex_source/regex_used）；可自定义 chapter_regex 覆盖 |
| 用户正则 ReDoS | 长度 ≤300 上限 + 编译校验 + 文档提示避免嵌套量词（默认链正则简单，风险主要在用户自填） |
| LLM JSON 畸形 | 契约校验拒绝 → batch.retry 内重试 → task failed 可断点续跑（只补失败项） |
| 大批量任务面板噪声 | extract_events 默认 max_concurrent=3、adapt_script=2；任务面板按步骤归组既有能力 |
| 中文小说编号跳号/重复 | 不依赖原文编号：index=切分顺序号（与 Toonflow chapterIndex 同义），章号仅存标题文本 |
| 事件数量爆炸（graph 过载） | 提示词约束 key_events 8-20 条 + 单次归并（章节范围可控） |
| AI 正则与默认链口径不一 | AI 正则契约与用户正则同规格（两捕获组 + gm 编译），产出即可复用 |

---

## 7. 交付物清单

1. 本设计文档；
2. 服务端：text-split.ts（新）、ai-text.ts（扩展）、actions/index.ts、loader.ts、storage.ts、schema.ts（注释）、services/novel-board.ts（新）、routes/novel.ts（新）、app.ts、probe-m9.ts（新）；
3. workspace：novel-adapt.yaml（新）+ 5 提示词（新）；
4. Web：NovelBoard.vue（新）、RunDetailView.vue、api.ts、types.ts、format.ts；
5. 验证记录：probe-m9 全绿截图 + 兼容回归 + 实弹 run 全链 + NovelBoard 截图；
6. roadmap M9 注记 + README 小节。
