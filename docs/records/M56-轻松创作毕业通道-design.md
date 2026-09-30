# M56 L1 Spec — 轻松创作「毕业通道」：批准方案一键升级专业成片 + 连载立项

> **状态：已实施并门禁全绿（2026-09-30）。** 构建在 M30/M31/M40/M45/M46 之上，不推翻其契约。
> 前置复核：编号以最新 roadmap 为准。**立项时曾误编 M48**，与已交付里程碑（M48 统一取消/续跑/预算、M50 剪辑工程交换包、M52 全局素材池……直至 M55）冲突；开工前按 roadmap 复核后改用 **M56**（现有探针最高 m55，本号为下一个空位）。
> 纪律：**0 新表 0 新列 / 0 数据迁移 / 0 新增 action / 0 新增付费面 / 0 模板步骤改造**；`easy-*` 纯执行器本质不改；升级是**独立 opt-in 动作**，绝不在 confirm 时自动改跑出片模板。

## 零、实施状态与原 spec 修正（诚实留档，2026-09-30）

本稿 §二/§三/§四/§六 初版描述的核心机制——「批准剧本作为 `approved_script` 输入喂 `mengbao-episode`，命中则 `write_script` 步 `skipped`、下游透传，模板 v12→v13」——**在真实引擎下不成立，实施时已废弃并改为下述机制**。留档不删，以明偏差：

1. **版本前提已滞后**：`mengbao-episode` 现网实为 **v14**（非初稿假设的 v12）。
2. **skip 方案三处硬伤**（读 `refs.ts`/`engine.ts` 实证）：
   - 被 skip 的步产物 `asset_ids=[]`（`markStepSkipped`），下游 `$write_script.asset` **拿不到任何东西**；
   - 下游依赖全 skip 会触发**级联跳过**（`engine.ts` L384），整链崩；
   - `prev_script` 语义是「**上一集**承接」（R18 铁律"无缝衔接上集结尾"），塞本集批准剧本会诱导 LLM 写成**第 2 集**。
3. **改为的安全机制**：毕业 = 在同一项目**只建一个 `queued` 专业 run（不自动 start、零计费）**；批准剧本经**既有** `setting_docs`（单集）/ `plan_doc`（连载）files 输入作**强锚定参考**喂入；专业链**自带的 `write_script` 必审闸**负责剧本复核，用户到专业工作台核对预算/参数后自行启动。**`mengbao-episode` v14 / `series-setup` v3 一字未改**（不碰版本探针 m3/m8/m11）。

## 一、背景与目标（问题根因，非表层诉求）

用户痛点：在轻松创作里聊出的是**连载短剧**意图，但执行链永远只跑 `easy-dialogue`（单条、≤60s、无角色锚定/逐句配音/BGM 全套），撞到"轻短剧"天花板后**没有出路**——只能重开专业端从零再来。

根因不是"轻松创作不能做短剧"（`easy-dialogue` 已能做单条人物对白剧情），而是**轻松创作与专业链之间是两座孤岛、缺一条毕业通道**。专业链（`mengbao-episode` v14、`series-setup` v3）早已具备多集连载、`prev_script` 集间承接、角色/场景/道具锚定、逐句配音、BGM、品牌——**能力都在，只是接不过来**。

M56 意图：在"确认方案并已开始制作"之后，给用户提供一条**从批准物直接毕业到专业成片**的显式通道，复用现成专业机器，不重造轮子、不改 `easy-*` 本质、不动专业模板。

## 二、方案决策（实施版，附理由）

| 决策点 | 选择 | 理由 / 已否决替代 |
|---|---|---|
| 触发方式 | **结果卡独立「升级专业成片 / 立项为连载系列」按钮**（opt-in） | 自动切模板会破坏 M40"确认什么就做什么"不变量；已否决"confirm 时按 genre 自动路由" |
| 是否自动启动 | **只建 `queued` run，绝不自动 start** | 专业链含定妆照/逐句配音/BGM 等付费能力，预算与参数必须由用户到工作台核对后自行启动；零计费面 |
| 剧本注入方式 | **批准剧本经既有 `setting_docs`（单集）/`plan_doc`（连载）作强锚定**，专业链 `write_script` 必审闸复核 | 复用既有 files 输入零模板改动；已否决初稿"skip write_script + approved_script"（见 §零：skip 产物为空且级联崩、prev_script 语义错导致写第 2 集） |
| 连载归属 | **复用「一项目=一部剧、一运行=一集」项目域模式**，轻松创作只做立项不做多集编排 | 会话模型是"一 session=一 project=一 run"，硬塞"一次产 N 集"要破坏单一 run 不变量或重造编排；专业端已有承接，已否决在 easy 内做连载 |

## 三、两条毕业路径（实施版）

### 3.1 1a 单集升级（`mode:'episode'` → `mengbao-episode`）
- 结果卡（`CreationResult.vue`）增「本集升级为专业成片」→ `POST /creation-sessions/:id/graduate {mode:'episode', episodeNumber?}`。
- 服务端取本次轻松创作 run 的批准剧本资产（`purpose='script'` 且 `runId=session.runId`，confirm 时落库），作 `setting_docs` 锚定；`brief` 取项目真源、`episode_number` 按请求、`plan.mode=dynamic` 时透传 `motion:true`。
- 建 `mengbao-episode` **queued** run；用户在专业工作台核对预算后启动，专业链 `write_script` 必审闸供复核（批准剧本已作强参考入上下文）。

### 3.2 1b 连载立项（`mode:'series'` → `series-setup`）
- 结果卡增「立项为连载系列」→ 同一端点 `{mode:'series'}`，批准剧本经既有 `plan_doc` 喂 `series-setup`（整剧设定包 + 分集地图 + 角色/场景建档），`genre` 取项目真源。
- 立项后逐集走 `mengbao-episode` + `prev_script` 链段映射承接（专业端已有，M56 不重造、不在轻松创作会话内编排多集）。

## 四、契约与副作用收口（实施版）

- 新增端点 `POST /creation-sessions/:id/graduate`（`routes/creation-chat.ts`，202 返回 `{runId, templateKey, reused}`）；service `services/creation-chat/graduate.ts`：`graduateSchema`（`{mode:enum[episode,series], episodeNumber:int[1,9999]?}`，strict）。
- **不改 planHash**（毕业动作不是执行数据，同 M40 立项覆盖先例）。
- **不新建模板、不加输入键、不动 run-prefill**：`setting_docs`/`plan_doc` 本就是模板既有 files 输入，files 类输入天然不进 run-prefill 自动回填。
- 幂等：同项目同专业模板下，若已存在把「本批准剧本资产」作为锚定输入且仍 `queued` 的 run → 直接复用（`reused:true`），不重复建。
- 前置门：会话无 `runId`（未确认/未开始制作）→ `CreationError('not_confirmed', …, 409)`；专业模板不受 `isCreationTemplate` 门禁（`createRunRow` 只对 `easy-*` 要求 `creationSessionId`）。
- 预算/预检：毕业 run 的费用走专业链既有 `estimate`/budget 检查，启动时才发生，升级前在工作台显式可见，不在轻松创作口径里隐瞒。

## 五、前端（实施版）

- `types/creation-chat.ts`：`CreationGraduateBody`/`CreationGraduateResult`；`api/creation-chat.ts`：`graduate(id, body)`。
- `CreationResult.vue`：成片下方「毕业通道」面板，仅剧情/对白（短剧）方案且已启动制作时可见，含「本集升级为专业成片」(film) / 「立项为连载系列」(layers) 两枚动作。
- `use-creation-chat.ts`：`graduate(mode)` 遵循 busyAction/error 范式，成功后 `fetchDetail(id)` 刷新并 `router.push('/runs/{runId}')` 跳专业工作台。

## 六、探针（`scripts/probe-m56.ts`，零网络零计费，隔离库 + stubFetch）

`isolatedEnv('m56', bridge templates/prompts)` + stub `globalThis.fetch`（计数）+ stub `engine.startRun`（计数），五节 33 断言：
- **schema**：`graduateSchema` 枚举/strict/集号边界收口。
- **episode**：建 `mengbao-episode` queued run、`setting_docs` 含批准剧本、`brief` 真源、`episode_number`、dynamic→`motion:true`、**`prev_script` 缺席**、`startRun`/`fetch` 全程 0 调用（零执行零计费）、毕业留痕消息、**幂等复用**。
- **series**：建 `series-setup` queued run、`plan_doc` 含批准剧本、`genre` 真源、不误带单集键、幂等。
- **guards**：未确认会话 → `not_confirmed 409`；无批准剧本资产 → 仍建 queued 但不硬造锚定；不存在会话 → 拒绝。
- **drift**：`mengbao-episode` **仍 v14** 且 `write_script` 步在位、`setting_docs` 仍既有 files 输入；`series-setup` 仍 v3 且 `plan_doc` 在位（证模板零改动）。

## 七、边界与遗留

- 不在轻松创作会话内做多集批量/排期（接 M27 orchestrator，见 backlog）。
- 不做口型同步（lip-sync）：M31 已明确列为永久排除，需专门付费模型面，另行 Ask。
- 升级后原 `easy-*` 成片与 run 保留，不删；专业 run 独立且未启动。
- 兄弟立项队列（载体路由 / 参考反推 / 时长放宽 / 商业化结构）见 `M57–M60`，均**待用户评审批准、未实施**。
