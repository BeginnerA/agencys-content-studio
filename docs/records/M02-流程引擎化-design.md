# agencys-content-studio M2 技术设计规格（流程引擎化）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-09
- 上游：`2026-09-09-agencys-content-studio-roadmap.md`（M2 行：任意新流程 = 写模板即可；ai_video/配音/字幕 action 启用；模板在线管理）
- M1 review 输入：`2026-09-09-agencys-content-studio-m1-review.md`（§M2 spec 输入 + 偏差 #1 字幕判据回补 + 出口问题「gate 语义够不够」应答落点）
- 红线（ROADMAP 引用）：不引重型编排引擎；不做体裁专属表；模板/提示词外置不写死代码；本地单机不回退

---

## 1. 定位与 M2 边界

### 1.1 一句话目标

把 M1「单条死模板线性链」升级为「**任意视频类流程 = 一份 YAML 模板**」：模板引擎支持条件/并行/多闸门编排语义，ai_video/配音/字幕三条 action 面启用，模板与提示词可在 Web 在线管理与即时生效，并用 ≥2 条从用户 Skills 方法论沉淀的新模板做端到端验证。

### 1.2 M2 范围（做）

| # | 主项 | 内容 |
|---|---|---|
| E1 | 编排语义引擎化 | 步骤依赖声明（默认串行 / `after` 显式依赖）、就绪集并行执行、`when` 条件跳过（含依赖跳过传播）、`skipped` 状态全链路（落库/事件/UI） |
| E2 | Run 模板快照 | run 创建时固化模板正文（`template_snapshot`），模板在线修改/删除不影响运行中 run 的续跑语义（步骤集与参数一致） |
| E3 | Gate 三态决策 | 现有 approve（含文本覆盖）/reject（带意见重跑）之上，增加**可选** `skip` 决策（模板声明才出现按钮）——对齐用户 Skills「采纳/跳过/稍后」用户闸门三态 |
| A1 | ai_video 启用 | 轮询型视频适配器按 M1 spec §7 清单模式从 huobao-drama 搬运（volcengine/minimax/aliyun_wan），action 任务化对齐 ai_image 的 gen_task 队列/重试/恢复 |
| A2 | 配音 action（`tts`） | 文本 → 语音资产；首个适配器走 OpenAI 兼容 `/audio/speech`（任意兼容网关可配，AI 配置页新增 audio 分组） |
| A3 | 字幕 action（`subtitle`） | 台词+时长 → SRT 资产；`ffmpeg_merge` 升级为三流合成（视频 + 可选人声轨 + 可选字幕烧录 + 封面） |
| T1 | 模板在线管理 | workspace/templates 仍为唯一事实源（git 可管）；Web 模板页：列表/新建/编辑/校验/删除/引用体检；写文件 + 缓存失效即时生效（运行中 run 靠快照隔离） |
| P1 | 提示词管理 | workspace/prompts 的只读浏览/新建/编辑（模板引用体检依赖它）；与模板页同区域 |
| V1 | 沉淀模板验证 | 2 条模板（见 §9）端到端跑通，验证北极星「新增流程 = 新模板/改模板，不改代码」 |
| W1 | Web 配套 | 运行详情并行段可视化（同段时间线同层展开）、模板管理页、GateDialog 三态按钮、Settings 配置页 audio 分组（video tab 拆出） |

### 1.3 M2 不做（明确排除）

| 排除项 | 去向 |
|---|---|
| 图文/口播**完整方法论**模板（账号/选题/档案依赖） | M3（「图文/口播模板各一条跑通」属 M3 行）；M2 仅用 mini 形态做 action 面验证 |
| 本地向量记忆 / 角色一致性库 | M3（ROADMAP 红线「M1–M2 不引入记忆」） |
| 多集批量编排 / 批量生成 | M4（Backlog 与 roadmap M4 行） |
| 模板版本库（多版本切换/回滚 UI） | 单机 + git 承担版本职责；模板文件内 `version` 字段保持自述 |
| 表达式语言（jq/JS sandbox） | 只做 §3.3 最小条件集，防编排复杂度失控 |
| ai_text 任务化（进 gen_task 队列） | 仍同步执行+流式日志（M1 决策保持）；M2 review 再评估 |
| 音频情绪/情感 TTS 参数体系 | 用户「音频情绪」方法论入 backlog，M2 只做基础 tts（voice/语速/音量） |
| Electron/画布/移动端 | 永久排除或按路线图评估 |

---

## 2. 技术决策总览（决策完备）

| 决策点 | 结论 | 理由 / 否决项 |
|---|---|---|
| 编排模型 | **步骤数组 + 依赖声明（DAG 调度器）**：步骤默认依赖前一步；`after: [keys]` 可改依赖；调度器每步完成后重算就绪集并发推进 | 否决「显式 parallel 容器」（模板作者心智负担重、嵌套难）；否决全 DAG 图文件（迁移成本高，M1 线性模板零改动兼容）。类 GitHub Actions `jobs.needs` 模型 |
| 并行上限 | 进程内就绪集并发；**同一步骤内 batch 仍 ≤2**（ai_image 语义不变）；**跨步骤并行硬上限 2**（沿用 runPool 双 worker 精神），M2 不做用户级并发配置 | 本地单机 + SQLite WAL；防 LLM/图像通道瞬时打爆 |
| 条件语法 | `when: <expr>` / `when: [<expr>...]`（数组=AND），expr 最小集见 §3.3；**依赖跳过规则（确定性）**：某步依赖全部终态且其中**无任何 succeeded**（即全部 skipped）→ 该步自动 skipped（无料可跑）；依赖中**存在至少一个 succeeded** → 正常执行（被跳过依赖的产物引用解析为空数组，模板作者用字段容错——见 T1 compose 双字段模式） | 当 when 互斥分支（motion on/off）与合成汇合步共存时，汇合步必须能正常执行——单纯「有 skipped 就传播」会把汇合步误杀 |
| Run 模板快照 | `pipeline_runs.template_snapshot`（TEXT JSON，run 创建时写入展开后模板）；engine/续跑/审阅一律读快照 | 现状 engine 每次续跑重载最新模板文件，运行中 run 会被模板修改改变步骤集/行为（M1 spec「快照语义」声明与实现不符，本决策是修复） |
| 模板管理存储 | **文件为唯一事实源**（TEMPLATES_DIR/*.yaml + PROMPTS_DIR/*），Web CRUD = 原子写文件 + `invalidateTemplate()`；不做模板表 | 单机 + git 版本 + loader 热加载已就位；入库会引入同步/双写复杂度（否决 DB 存储） |
| Gate skip | gate 增可选 `skip_label`；skip 决策 = 免审放行（产物保留，无文本覆盖，output 记 user_skip），下游照常执行；无此字段则 UI 无跳过钮 | 对齐用户 Skills 用户闸门「采纳后免审」操作习惯；真正弃用产物/中止由 reject 重跑与 abort 承担（M1 既有） |
| 视频适配器 | 搬运 huobao 三厂商轮询适配器，对齐本仓 `VideoAdapter`（generate → poll 回查）契约 | `adapters/types.ts` 已定义 VideoAdapter/GeneratedVideo(poll)（M1 预留） |
| 配音通道 | `tts` action 默认 OpenAI 兼容 `/audio/speech`（baseUrl/apiKey 取 audio 类型 api_configs）；Settings seed 增 audio 供应商目录 | 用户已具备 OpenAI 兼容网关（SF）可直用；不绑架具体厂商；MiniMax/火山 TTS 待有实例后按同接口接入 |
| 字幕实现 | `subtitle` action 产 SRT 资产（LLM 对白切句估时）；ffmpeg 用 `subtitles` filter 烧录（ass 风格化渲染入参） | 台词时间轴独立可审阅可替换；烧录进成片保证全端可播 |
| 迁移 | drizzle-kit generate + push（加 1 列）；db/index 启动时对旧库 `ALTER TABLE … ADD COLUMN` 兜底（WAL 单文件零停机） | M1 未用 drizzle 迁移文件体系（push 直写），延续轻量路径 |

---

## 3. 模板引擎编排语义（E1/E2/E3，engine.ts 核心改造）

### 3.1 模板 schema 扩展（loader/types.ts）

```yaml
steps:
  - key: write_script
    action: ai_text
    title: 生成单集剧本
    # …M1 字段不变（inputs/params/gate/batch/output）
    when: input.with_script == true      # [新] 条件：不满足 → skipped
    after: [ingest_docs]                 # [新] 显式依赖（默认=前一步；写了则仅依赖列出步骤）
  - key: gen_images
    action: ai_image
    batch: { field: shots, max_concurrent: 2, retry: 1 }
    after: [write_script]                # 可与 make_storyboard 并行（若 make_storyboard 不依赖 gen_images）
```

类型变更：

```ts
interface TemplateInputDef {
  key: string
  label?: string
  kind: 'text' | 'files' | 'int' | 'bool'   // +bool
  required: boolean
  accept?: string[]
  default?: string | number | boolean       // +default：启动时回填入 run.input（UI 预填同源）
}

interface TemplateGate {
  mode: 'required'
  message: string             // {input.x} / {x:03d} 内插
  skip_label?: string         // [新] 挂起时显示「跳过」按钮文案
  when?: string | string[]    // [新] 条件：不满足 → 步骤自动 succeeded（免审直过），不挂起
}

interface TemplateStepDef {
  key: string
  action: string
  title: string
  inputs: Record<string, unknown>
  params?: Record<string, unknown>
  gate?: TemplateGate          // mode: 'required'; message: string; skip_label?: string
  batch?: TemplateBatch
  output?: { purpose: string }
  when?: string | string[]     // [新] 条件表达式（数组 = AND）
  when_any?: string[]          // [新] OR 组（与 when 同时存在时：when 全满足 且 when_any 任一满足）
  after?: string[]             // [新] 显式前置依赖 keys；缺省 = [前一步骤 key]；首个步骤缺省 = []
}
```

loader 前向校验增强：
- `when`/`when_any`/`gate.when` 表达式引用的 `input.x` 键必须在模板 `inputs` 声明中（否则 fail）
- `after` 引用的 key 必须存在且位于本步骤之前（沿用现有 steps 前向引用检查）
- `after` 为空数组 = 无依赖（可与任何无依赖步骤并行，仅非首步允许且需显式）
- gate 带 `skip_label` 时校验该步骤后续有 `when`/自动跳过可兜底的语义不做静态强制（运行时传播处理，见 3.2）

启动归一化（refs.validateRunInput 扩展）：模板 inputs 带 `default` 的键在 run 启动时回填（用户未传才回填），落库前完成——`when`/`gate.when` 求值始终拿到确定值；UI 表单预填与校验同源。

### 3.2 调度器（engine.runChain 重写）

状态机（run/step）在 M1 基础上增 `skipped`：

```
run.status:  queued → running → { waiting_input | completed | failed | cancelled }   （不变）
step.status: pending → running → waiting_input | succeeded | skipped | failed | cancelled
```

推进算法（替换现行 `for (const def of template.steps)` 线性循环）：

1. 每次迭代：取全部 `pending` 步骤 → 过滤出**就绪集**：
   - `after` 依赖全部处于终态（succeeded/skipped/failed/cancelled）；
   - 依赖中存在 `failed` → run failed（fail-fast 沿用 M1：报错含步骤 key）——**例外**：该依赖是被 `reject` 后置回 pending 重跑语义不变；
   - **依赖跳过规则**：依赖全终态且**无任何 succeeded**（全部 skipped）→ 本步骤自动 skipped（reason=upstream_skipped，output 标记），不进就绪集也不报错；依赖中**至少一个 succeeded** → 正常就绪（被跳过依赖的产物引用解析为空数组）；
   - 存在 `waiting_input` 前置 → run 保持 waiting_input（人工闸），等待 approve/reject/skip 后重新调度。
2. 就绪集为空且无任何 running/pending/waiting 活动步骤 → run completed（校验：所有步骤处于终态）。
3. 就绪集并发执行：每个步骤仍走 executeStep（M1 语义：gate 挂起/重试/恢复不变）；并发上限 2（进程内 simple semaphore，ai_image batch 内并发不受此限）。
4. 步骤完成（succeeded/skipped/failed）→ 回到 1 重算就绪集。**并行步骤的失败语义**：任一 running 步骤失败 → 置 run failed，其余并行步骤继续执行至步骤边界后检查 cancelled（与 M1 取消收敛一致：步骤间隙检查 run.status）；已 succeed 的并行产物保留（resume 时跳过）。
5. `resume`（从断点续跑）语义不变：succeeded/skipped 步骤跳过，pending/failed 重算就绪集推进。

执行上下文（ctx）不感知并行（action 无共享状态，产物按资产表隔离）——并行唯一共享点是 DB/SQLite WAL（写并发由 drizzle 串行化 + 进程内调度器顺序写步骤行，步骤落库发生在 action 完成后，无事务竞争窗口）。

**gate 与并行的收敛语义**：`waiting_input` 是 run 级暂停信号——调度器遇到就绪步触发的 gate 挂起后，不再启动新的就绪步（run 置 waiting_input 并 return），但此前已启动的并行步自然收敛（完成步若又触发 gate → 追加置 waiting_input，currentStepKey 更新为最新；正常完成 → succeeded 落库，run 仍保持 waiting_input）。同一 run 可累积多个 waiting_input 步（跨链多 gate），gate 决策按 step_key 寻址逐个放行（M1 API 已如此），每次放行后重新调度。

### 3.3 条件表达式（最小集，refs.ts 新增解析器，~60 行）

`when` 单表达式语法与求值（全部基于 run.input 与上游步骤产物，静态可校验）：

| 表达式 | 语义 |
|---|---|
| `input.<key> exists` | run.input 含该键且非空（'' / [] / null 视为空） |
| `input.<key> empty` | 与 exists 相反 |
| `input.<key> == <literal>` | 等值比较；literal 支持数字/true/false/裸词字符串 |
| `input.<key> != <literal>` | 不等 |
| `steps.<key>.count <op> <int>` | 上游步骤产物资产数比较（op: `==`/`!=`/`>=`/`<=`/`>`/`<`；依赖自动附加到 after） |
| `true` / `false` | 恒真/恒假（调试用） |

- 引用了 `input.x` 但 x 未声明的模板 → loader 期 fail（防笔误）。
- `steps.<key>.count` 会把该 key **隐式加入 after 依赖**（求值需其终态）。
- 求值异常（上游 failed 等）→ 抛 StepError 含表达式原文。

### 3.4 Gate 三态（E3）

- 条件门：`gate.when` 表达式求值（语法同 §3.3）在步骤成功后执行——不满足 → 直接 succeeded（不挂起、不产生 gate 事件）；满足 → 挂起 waiting_input 等审阅。模板作者用它表达「默认免审、开关打开才审」。
- 决策扩展：`POST /runs/{id}/gate` body 增加 `decision: 'skip'`（仅当模板该步骤 gate 声明了 `skip_label` 时允许，否则 400）。
- skip 语义：步骤置 `succeeded`，output 保留原 `asset_ids` 并记 `{skipped: {reason: 'user_skip', at, note?}}`；下游正常执行（免审放行）。产物弃用/中止由 reject 重跑与 abort 承担。
- GateDialog 渲染三态按钮的条件：`skip_label` 存在 → 第三按钮文案 = skip_label（如「免审直接出图」），点击后与 approve 同效果但无 text_override、记录 user_skip 痕迹。

### 3.5 Run 模板快照（E2）

- `pipeline_runs` 加列 `template_snapshot TEXT`（run 创建事务内写入：`JSON.stringify(loadTemplate(key))`）。
- engine 各入口（startRun/approveGate/rejectGate/skip/runChain/resume）改读 `run.template_snapshot`（解析失败/缺失 → 回退 loadTemplate(key) 并告警——旧行兼容）。
- template 在线变更后：新 run 用新模板；旧 run 续跑步骤集/参数/引用全部取自快照 → 行为确定。
- 模板「删除」不阻止旧 run 续跑（快照独立）——删除仅禁止新建 run（启动校验报 template_not_found）。

---

## 4. 数据变更（drizzle）

```ts
// pipeline_runs 增列（仅此一处 schema 变更）
template_snapshot: text('template_snapshot'),   // JSON 模板快照（run 创建时固化）
```

- 迁移：drizzle-kit generate + push；`db/index.ts` 启动 ensureColumn（`PRAGMA table_info(pipeline_runs)` 无该列则 `ALTER TABLE ADD COLUMN`）兜底旧库。
- 无新表。资产 kind/purpose/状态枚举沿用 M1 预留（audio/subtitle/skipped 已存在）。

---

## 5. Action 面（A1/A2/A3）

### 5.1 ai_video（启用，替换占位）

执行语义（对齐 ai_image 任务化，复用 gen_tasks 队列/轮询/重试/恢复）：

| 项 | 决策 |
|---|---|
| 模板形态 | `action: ai_video`，inputs: `frames: steps.x.assets`（首帧图资产，顺序即镜头序）、可选 `audio: steps.x.asset`；params: `{duration, resolution, prompt_field?, provider?, model?}` |
| 适配器 | 搬运 huobao `services/adapters/{minimax-video,volcengine-video,aliyun-wan-video}.ts`，对齐本仓 `VideoAdapter`（generate → GeneratedVideo{url|poll} + query 回查）；注册进 `adapters/video.ts` 新 registry（`getVideoAdapter`/`resolveVideoEndpoint` 复用 resolveEndpoint('video')） |
| 任务化 | 每个镜头 1 个 gen_task（kind=video）→ 提交第三方得 task_id → 轮询 query（间隔 5s，超时 10min）→ 成功下载落盘为 video 资产（purpose=shot_video，tags=[ep{n},shot{i}]）→ result_asset_id 回填；失败按 batch.retry 重试（M1 ai_image 同款） |
| 批量 | batch 语义与 ai_image 同（field/max_concurrent:2/retry:1） |
| 成本护栏 | 模板默认 `params.prompt_field` 缺省取 shot 的 image_prompt；模型/供应商由 defaults.image? 否——defaults.video（新）或 project.settings.video 同名覆盖（RunSettings.video 已存在） |
| 溯源 | 资产 prompt/params 快照照抄 ai_image 标准（含 third-party task_id） |

### 5.2 tts（配音，新 action，同步执行）

| 项 | 决策 |
|---|---|
| 输入 | `lines: steps.x.asset`（台词 JSON：`{lines:[{id?, speaker?, text}]}` 或每句独立 text 资产）；params: `{voice?, speed?, output_purpose?}` |
| 输出 | audio 资产（purpose=voice，mime audio/mpeg，每句 1 资产 or 整轨 1 资产按 `lines` 输入形态）——决策：**每句独立资产**（可复用/可替换/可溯源），合成由 ffmpeg 段统一 concat |
| 适配器 | `audio` serviceType 的 api_configs → OpenAI 兼容 `POST {baseUrl}/audio/speech`（body: model/input/voice/response_format mp3）→ 落盘；模型默认 `CosyVoice2-0.5B`（可被 config.model 覆盖） |
| seed | api_providers 增 audio 目录：`openai_audio`（OpenAI 兼容 TTS，description 注明「任意 OpenAI 兼容网关可指」）——**不预设** MiniMax/火山 audio 实例（用户未提供密钥；目录与 configs 机制支持随时新增） |
| 失败 | 非 2xx → StepError 含 HTTP 细节；无 audio config → 报错指引 Settings audio 分组 |

### 5.3 subtitle（字幕，新 action，同步执行）

| 项 | 决策 |
|---|---|
| 输入 | `script: steps.x.asset`（对白文本/剧本 md）或 `lines: steps.x.asset`（台词 JSON）+ 每镜时长信息来自上游（steps.storyboard 产物含 shot 时长 或 params.shot_duration） |
| 执行 | LLM（chatComplete，同 ai_text 通道）把对白切句并按镜头窗口估时 → 产 SRT 文本资产（purpose=subtitle，format=srt） |
| 校验 | SRT 解析自检（段数>0、时间单调），失败 → StepError |
| 可审阅 | 模板作者可在此步挂 gate（人工核对字幕） |

### 5.4 ffmpeg_merge 升级（三流合成）

- inputs 增可选：`voices`（音频资产 id 序列，按镜头序）与 `subtitle`（SRT 资产 id）。
- 合成管线（单次 ffmpeg 调用）：
  1. 镜头视频/图序列 concat（M1 语义不变；ai_video 产物 duration 各异时按实际时长 concat，不再强制等长——`-t` 仅对静态图生效）；
  2. 有 voices → 生成音频轨：逐句 concat + `adelay`/`apad` 对齐镜头时间轴 → `-c:a aac` 混入（a=1）；
  3. 有 subtitle → 视频流过 `subtitles=xxx.srt:force_style=…`（ass 风格参数化：字体默认 Noto Sans CJK，字号/边距/描边模板 defaults.video.subtitle_style 可调）；
  4. 封面逻辑不变。
- 产物：video 资产（tags 增 'with_audio'/'with_subtitle' 当命中）+ 既有 thumbnail。
- 时间轴对齐规则（M1 每镜 4s 定长的扩展）：镜头实际时长优先（video 资产 duration 字段）；静态图回退 duration_per_shot（默认 4s）。

### 5.5 action registry 汇总（M2 后全量）

| action | 形态 | 备注 |
|---|---|---|
| manual_ingest | 同步 | 不变 |
| ai_text | 同步+流式 | 不变 |
| ai_image | gen_task 批量 | 不变 |
| ai_video | gen_task 批量（轮询） | **启用**（替换占位） |
| tts | 同步 | 新 |
| subtitle | 同步 | 新 |
| ffmpeg_merge | 同步 | 升级三流 |

（loader.KNOWN_ACTIONS 与 registry 双处同步新增：ai_video 状态不变、+tts、+subtitle。）

---

## 6. 模板与提示词在线管理（T1/P1）

### 6.1 设计原则

- **文件是唯一事实源**；Web 是编辑器不是数据库。git status/diff 直接可见模板演进。
- 写操作原子化：写临时文件 → 校验通过（loadTemplate 试解析）→ rename 覆盖；失败保留原文件并回 400（错误含行号/字段提示）。
- 生效即时：写后 `invalidateTemplate(key)`，下一 run 即用新模板（运行中 run 走快照不受影响）。

### 6.2 REST 契约（routes/templates.ts 扩展 + routes/prompts.ts 新建）

```
GET    /templates                      现有（meta 列表；增 prompts_dirty: bool 标记引用缺失）
GET    /templates/:key                 现有
POST   /templates/validate             [新] body={yaml} → {ok, errors[]}（不落盘；字段/引用/action/when 校验）
POST   /templates                       [新] body={key, yaml} → 校验+落盘+invalidate
PUT    /templates/:key                  [新] body={yaml} → 同上（key 不可改）
DELETE /templates/:key                  [新] 删除文件+invalidate；若被项目引用（projects.template_key）→ 409 列出项目名
GET    /prompts                         [新] {items:[{name, size, updatedAt}]}
GET    /prompts/*                       [新] 文本内容（路径安全：限定 PROMPTS_DIR 内，防 ../）
PUT    /prompts/*                       [新] 新建/覆盖写
DELETE /prompts/*                       [新]
```

引用体检（validate 附带输出）：
- action ∈ KNOWN_ACTIONS；inputs 引用形态语法；steps 前向引用；when 的 input 键在 inputs 声明内；
- `params.prompt_tpl` 引用的 prompts 文件存在（缺失 → errors[] 警告级）；
- steps 间 `after` 存在性。

### 6.3 Web 模板页（新路由 /templates）

- 列表：key/name/genre/version/stepCount/updatedAt/引用体检状态徽标 + 「复制」「删除」
- 编辑器：YAML 文本域（monospace、tab=2 空格）+ 分栏错误面板（validate 实时，防抖 800ms）+ 「保存」「另存为副本」
- 只读信息：inputs 声明表、steps 流程图（svg 竖排：依赖线 + gate/batch/when 徽标——不引入图库，纯 CSS/SVG）
- prompts 区：列表 + 文本编辑器（同页签切换）
- 运行中 run 的模板显示 badge「快照 v{n}」提示与当前文件差异（stepKey 集比对）

### 6.4 Settings 页

- video tab 拆出 audio：`audio` serviceType 供应商/实例进新 tab「语音合成」（TABS: 文本/图片/视频/语音）——分组逻辑 serviceType 驱动，纯前端小改。

---

## 7. Web 运行页配套（W1）

- 时间线并行可视化：同一时刻并发的步骤（同父时间窗）横排渲染（现 rail 为单列纵排；并行段改为每步一行 + 时间窗重叠提示/分组框），事件驱动不变（socket run.step 推送逐步渲染）。
- skipped 步骤：灰显 + 原因 badge（user_skip / upstream_skipped / when_false）。
- 状态徽标增 skipped（灰色虚线）与任务面板 kind=video 显示 provider 轮询状态（processing 转圈文案「生成中 (第 N 次尝试)」）。
- GateDialog：skip_label 存在时第三按钮。

---

## 8. 供应商与配置（A1/A2 落地清单）

| 项 | 决策 |
|---|---|
| video adapter 搬运源 | `Agent/huobao-drama/backend/src/services/adapters/{minimax-video,volcengine-video,aliyun-wan-video}.ts`（按 M1 spec §7 搬运模式：仅 import/类型适配，不搬其专属逻辑） |
| 视频默认通道 | 模板 defaults.video.provider 指向实例可配；无实例时 ai_video 报错指引（同 M1 image 未配置文案） |
| audio seed | api_providers 增 `openai_audio`（OpenAI 兼容 TTS）目录项；seed 幂等追加逻辑改为「缺失补种」而非「空库全种」（现有实现是空库才种——升级为按 key 缺失补插，保证老库拿到新目录行） |
| 语音默认 voice | `alloy`（可被模板 defaults.audio / project.settings 覆盖；RunSettings 增 audio 段） |

---

## 9. 沉淀模板（V1，验证北极星）

> 设计目标：每条模板至少踩中一条 M1 没有的新能力；全部不改代码跑通。

### 9.1 T1「萌宝短剧·单集 v2」（mengbao-episode.yaml 升级 version: 2）

与 M1 版差异（体现：多 gate 点位 / gate skip / when 互斥分支 / 快照隔离 / ai_video 动效）：

```yaml
key: mengbao-episode
version: 2
name: 萌宝短剧·单集流水线（v2：双闸门 / 动效可选 / 封面可选）
inputs:
  - brief / setting_docs / episode_number     # M1 同
  - key: motion, kind: bool                   # 镜头 AI 动效开关（false=静态图合成，M1 路径）
  - key: with_storyboard_review, kind: bool   # 分镜闸门开关（false=免审直接出图）
steps:
  - key: ingest_docs        # manual_ingest
  - key: write_script       # ai_text；gate 1 required（剧本审阅，M1 同）
  - key: make_storyboard    # ai_text；gate 2：when: input.with_storyboard_review == true（false=免审直过）
      # + skip_label「免审直接出图」：审阅挂起时人可反悔免审放行
  - key: gen_images         # ai_image（静态分支），when: input.motion != true，after: [make_storyboard]
  - key: gen_motion         # ai_video（动效分支），when: input.motion == true，after: [make_storyboard]
  - key: compose_video      # ffmpeg_merge，after: [gen_images, gen_motion]
      # compose 输入双字段：images（静态）与 motion_clips（动效），action 取非空分支合成
```

验证点：双 gate 审批链路（gate2 受 with_storyboard_review 开关控制：false 自动免审直过、true 挂起后可批准/驳回/skip 免审）；when 互斥分支按 motion 开关选路（on/off 各跑一遍）；旧 v1 run 续跑仍按 v1 快照（E2）；motion=true 时 ai_video 真实出片（验收用短 brief 小项目控制成本）。

> 说明：分镜数由 LLM 按 brief 决定，动效验收建议用独立 mini 项目（≤5 镜）避免成本失控。

### 9.2 T2「对白口播·单条」（从 video-script(mode-video)+media 方法论沉淀，新 key `talking-clip`）

新体裁 talking_head 的**最小闭环模板**（完整方法论模板归 M3）：

```yaml
key: talking-clip
name: 口播单条（文案审阅 → 配音 → 字幕 → 合成）
genre: talking_head
inputs:
  - topic            # 口播主题/选题（text, required）
  - ref_docs         # 参考素材（files, 选填）
  - duration_hint    # 目标秒数（int, 选填 default 60）
  - with_voice       # bool 选填 default true（false=纯字幕版）
steps:
  - draft            # ai_text 口播文案（prompt 按 video-script mode-video 方法论外置）+
                     #   gate required（文案审阅，reject 意见回流 LLM 已有）
  - cast_lines       # ai_text 台词切句 JSON（{lines:[{id,text,est_ms}]}）output_format=lines-json
  - subtitle         # subtitle action（draft+cast_lines → SRT）
  - voice            # tts action, when: input.with_voice != false, after: [cast_lines]
  - cover            # ai_image 封面（1 张 16:9 缩略主题图）— 并行点示例：与 voice 并行（after: [draft]）
  - compose          # ffmpeg_merge（voices/subtitle 可选输入 → 口播成片 mp4），after: [subtitle, voice, cover]
```

验证点：tts 配音轨、字幕烧录、音频混流（ffprobe streams 断言）、ai_image/tts 并行段真实并发、字幕 gate 可选挂载（模板作者自由）。

> 两个模板文件与引用的 prompts（T1 沿用 M1 的 script-ep/storyboard-ep + v2 增分镜审阅提示词；T2 增 draft-talking.md / lines-cast.md）全部外置在 workspace/templates 与 workspace/prompts。

---

## 10. 里程碑验收（M2 exit criteria，可测）

1. **编排语义实弹**：T1 v2 一次 run 中：with_storyboard_review=true 时 gate2 挂起 → 审阅者点 skip_label「免审直接出图」放行（产物保留、记录 user_skip）；`when` 互斥分支按 motion 开关正确选路（motion=false 与 motion=true 各至少 1 次 completed）；Web 时间线正确呈现并行/skipped 状态。
2. **快照隔离**：运行中 run（waiting_input 挂起态）在线修改模板文件（如改 v2 某步 title/加一步）→ 批准续跑，该 run 步骤集与修改前一致；新 run 反映新模板。旧 v1 快照 run 续跑亦一致。
3. **模板在线管理**：Web 模板页完成 新建（含 YAML 错误内联报错不改文件）/编辑保存（git diff 可见）/复制/删除（被项目引用 409）；保存后无需重启新 run 即用新模板；prompts 页浏览/编辑被模板引用体检识别。
4. **ai_video 启用**：T1 motion=true（或独立 mini 项目）真实 run 产出 ≥1 段 shot_video 资产（kind=video），溯源含 {taskId, prompt 快照, provider}；期间 kill 服务 → 重启 recover：processing 的 video task 正确归位（failed 可 retry / 第三方回查成功则续）。
5. **配音字幕**：T2 真实 run 产出 voice 音频资产 + 成片；ffprobe 断言成片含音频流 + 字幕已烧录（视觉帧抽查可选）；浏览器 Range 播放正常。
6. **三流合成**：T2 成片 duration 与台词窗口对齐（±2s），音频轨可听（主观抽查）。
7. **恢复/重试（出口问题 2）**：并行段（T2 compose 前段）运行中强杀 → 重启 recover 无悬挂 processing；resume 只重跑未完成步骤（succeeded/skipped 不重跑）；ai_video 第三方轮询中断恢复路径实测一次。
8. **北极星复验（出口问题 1）**：T1 v2 与 T2 从零到跑通**未改任何代码**（git diff 仅 workspace 模板/prompts 文件时成立）；gate 三态与「驳回意见回流 LLM」在真实驳回流程中各实测 1 次。
9. **README**：回归路径更新（v2/T2 新模板、tts/subtitle/ai_video 通道配置指引、audio 配置页说明）；M1 验收 #5「字幕」判据由本里程碑实际烧录回补复验（review 偏差 #1 关闭）。
10. **无回归**：T1 静态分支（motion=false + with_storyboard_review=false）执行路径与 M1 完全同构（ingest→script→storyboard→gen_images→compose，仅 gate1 挂起），复跑通过即视为 M1 冒烟路径在新引擎无回归；另对存量 M1 数据（Run 10 类）执行一次 resume 冒烟确认快照兼容。

---

## 11. 出口校准与演进注记

| 项 | 状态/决策 |
|---|---|
| 出口问题 1（Skills 方法论能否平移到模板+提示词外置） | 由 V1 两条模板 + 三态闸门作答；gate「驳回意见回流 LLM」等 Skills 语义在 T1/T2 实测 |
| 出口问题 2（恢复/重试多任务可靠性） | 验收 7 实测作答 |
| 记忆/角色一致性/批量 | M3/M4（本节不扩展） |
| ai_text 长输出分镜特判（storyboard-json 24000 token） | M2 将 `output_format` 扩展为通用 `json-schema` 校验（lines-json 同理）——引擎 action 层泛化小改，模板外置提示词驱动 schema（提示词内嵌 JSON 结构约定，代码只校验必含字段数组） |
| 音画对齐升级（按台词时间轴精确对齐 vs 镜头定长） | 归 M3 音频情绪方法论时一并评估；M2 用镜头窗口估算 |
| 命名兼容 | new provider keys（openai_audio）不影响既有 configs；projects.genre 已含 talking_head |

---

## 12. 参照物速查

- 编排语义灵感：GitHub Actions `needs`/`if`（步骤级）、用户 `Skills/AI视频创作/video-orchestrator/workflow-content-pipeline.md`（闸门三态与跳过降级语义 → gate skip 与跳过传播）
- 视频适配器搬运源：`Agent/huobao-drama/backend/src/services/adapters/{minimax-video,volcengine-video,aliyun-wan-video}.ts`
- 口播文案方法论：`Skills/AI视频创作/video-script/framework.md`（mode-video）/ `Skills/自媒体/media-writer/`
- 字幕/音频工程：ffmpeg `subtitles`/`adelay`/`apad` 滤镜；SRT 为最小互通格式
- M1 依赖：`apps/server/src/pipeline/{engine,loader,refs,context,types}.ts`、`routes/{templates,runs}.ts`、`db/schema.ts`
