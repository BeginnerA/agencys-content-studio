# M34 设计 spec · 模板与运行入参自动化（G6 + G8）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-20
- 文档层级：**L1 详细设计 spec**（依 charter〔L0.5〕「每里程碑开工前：需求勘察 → 用户拍板 → L1 spec」）
- 上游：[平台智能化立项纲领](file:///d:/work/AI/docs/superpowers/specs/2026-09-19-agencys-content-studio-platform-intelligence-charter.md) §五 M34；范式复用 [M32](file:///d:/work/AI/docs/superpowers/specs/2026-09-19-agencys-content-studio-m32-design.md)（能力真源表）+ [M33](file:///d:/work/AI/docs/superpowers/specs/2026-09-20-agencys-content-studio-m33-design.md)（定价真源表 + Tier A 预填）
- 决策留痕：2026-09-20 用户拍板——**分阶段先交付 G6 + G8（零成本确定性预填）；G7（自然语言→模板推荐）暂缓**，未来做时取「零成本规则/embedding 匹配」路线、不引入 LLM token 成本。

---

## 一、背景与范围

建项目 → 选模板 → 填 `inputs` → 启动 run 的链路里，大量**系统本就已知、或可从真源确定推导**的项被推给用户手填/手选，易错易漏。M34 治理三项缺口，本轮只做其中两项确定性的：

| 缺口 | 现状锚点（已代码级核实） | 本轮 |
|---|---|---|
| **G6** | `RunFormModal.vue:88-103` `selectTemplate` 仅回填 `inputs.default`（模板声明级）+ M14 `prefillInput`（集号）；**不参考项目 brief、不参考上次同模板 run 入参** | ✅ 做 |
| **G7** | `RunFormModal.vue:210-222` 第一步纯 `TemplatePicker` 场景卡手选（15+ 模板）；无自然语言→模板推荐 | ⏸ **暂缓**（归后续里程碑，取零成本路线） |
| **G8** | `RunFormModal.vue:244-294` adv 五项（尺寸/清晰度/时长/音色/温度）+ `RunParamsPanel.vue` 热调**全空白手填、无合法档位约束**（清晰度硬编码 480p/720p/1080p、时长 1–30 可填越界值） | ✅ 做 |

**目标形态**：选模板 → 系统按「上次同模板 run 真实入参 + 项目 brief」**自动预填 inputs**（Tier A，可覆盖 + 标注来源）；「本集参数覆盖」的视频清晰度/时长**按所选视频实例能力真源表给出合法档位 + 推荐默认**（Tier B，可覆盖），杜绝越界手填。

## 二、决策模型与红线（沿用 charter L0.5）

- **Tier A（自动预填、不打断）**：上次同模板 run 的**精确输入值复用**——同 key 同值，确定性回放，标注 `source=last_run`。
- **Tier B（建议 + 可覆盖 + 保留预览）**：brief 派生填充、视频档位推荐——系统给建议值/合法域，用户可改，标注来源。
- **零成本纪律（本轮核心约束）**：G6/G8 全部为 **DB 读取 + 静态真源表推导**，**不发起任何 LLM / 网络调用**（与 G7 的关键差异）。探针须断言零网络零计费。
- **不猜测 / 不误填**：brief 仅在白名单命中的**空文本输入**上放置原文（字符串定位，非生成），绝不用 LLM 改写；上次 run 只复用**同 key 精确值**，媒体/发布类（files/publications）输入**不复用**（跨集资产引用会误绑）。
- **可追溯（M37 前置）**：每个自动值携带 `source`（last_run / brief / template_default / project_settings / caps_suggest），前端以来源 chip 呈现「为何是这个值」，为 M37 统一可追溯 UI 铺路。
- **不改变执行契约**：预填仅作用于**建 run 前的表单值**；用户提交后 `run.input` 快照、引擎、`_params` 三层叠加（run>project>template）语义零改动。

## 三、G6 · 服务端输入预填（run-prefill 服务）

新增 `apps/server/src/services/run-prefill.ts`：`resolveRunPrefill(projectId, templateKey): PrefillResult`。

**输入值解析优先级（后覆盖前，逐 key 记录最终 source）**：
1. `template_default`：模板 `inputs.default`（兼容旧 `defaults[key]`），与现 `selectTemplate` 行为一致。
2. `last_run`：查 `pipeline_runs` 中该 `(project_id, template_key)`、`deletedAt` 为空、按 `updatedAt DESC` 的**最近一条 input 可解析**的 run，将其 `input` JSON 里**与模板声明同名、且为非媒体标量（text/int/bool）**的键覆盖进来；`_` 前缀内部键（`_params`/`_compose` 等）一律排除。
3. `brief`：对白名单命中的**仍为空**的 text 输入放置 `project.brief`（无 brief 则 `project.name`）。白名单（key 或 label 正则匹配）：`简介|主题|选题|方向|标题|文案|大纲|梗概|idea|topic|theme|title|brief|description|summary|outline|synopsis`。命中判定大小写不敏感、trim。

**输出契约 `PrefillResult`**：
```
{
  projectId, templateKey,
  inputs: { [key]: { value: string|number|boolean, source: 'template_default'|'last_run'|'brief' } },  // 仅给有值的键；媒体/空键省略
  lastRunId: number | null,
  overrides: { video: VideoOverride | null }   // 见 §四（G8，域对齐）
}
```
- 服务端只返回**候选值 + 来源**，不做「是否覆盖用户已编辑」判断（该判断在前端，编辑即清 auto 标记）。

## 四、G8 · 覆盖项合法档位（复用 M32 真源表 · 域对齐）

> **实现期发现的约束（故据实收窄）**：`run-params.ts` 的 `video.resolution` 白名单正则仅收 `480p/720p/1080p`（**输入域**，适配器再 `mapResolution` 归一到 768P/2K 等**输出域**），而 M32 `caps.resolutions` 是输出域（minimax=`['768P','2K']`）。把 caps 输出档位直接塞进覆盖下拉会被 `validateRunParams` 判 400。故覆盖项**可选域 = caps ∩ 输入白名单**；**时长档位（durations）才是本轮越界防护主价值**（当前 UI 允许 1–30，但 minimax/volcengine 实际仅 4–15）。

`resolveRunPrefill` 内追加视频覆盖推导（仅当模板 steps 含 `ai_video`/`ffmpeg_merge` 时）：
1. 解析「有效视频实例」provider+model：优先 `project.settings.video.{provider,model}`；缺省回落 `api_configs` 中 `serviceType='video' AND is_default=1` 实例的 `providerKey + model`。
2. 命中 → `overrides.video = { providerKey, model, durations: number[], defaultDuration, resolutions: string[], selectableResolutions: string[], defaultResolution: string | null, source: 'caps_suggest' }`：
   - `durations`/`defaultDuration`：取 M32 `caps.durations`/`caps.defaultDuration`（用于**收窄时长数字输入的 min/max + 推荐提示**，全 ⊆ 1–30 安全）；
   - `resolutions`：caps 输出档位（仅**展示性提示**「本模型输出档位：…」）；
   - `selectableResolutions` = `caps.resolutions ∩ {480p,720p,1080p}`（覆盖下拉的**实际可选项**；交集为空则回落现全量 480/720/1080，不砍到空）；
   - `defaultResolution` = `caps.defaultResolution` **仅当 ∈ selectableResolutions** 否则 `null`（推荐默认，不自动写入 _params）。
3. 未命中（未知/未登记 model，`resolveVideoCaps` 返 null）→ `overrides.video = null`，前端**回退现行为**（手填 + 通用 1–30 提示），不假装背书。

前端 `RunFormModal.vue` adv 区（**均为可留空的「覆盖」项，Tier B 只建议不强推**）：时长数字 `min/max` 由 `durations` 边界约束、占位/提示标 `推荐 {defaultDuration}s（本模型 {lo}–{hi}s）`；清晰度下拉选项 = `selectableResolutions`（替代硬编码），`defaultResolution` 非空时作为「推荐」提示。不写入即继承项目设置，`_params` 提交契约零改。
> 注：`image.size` / `audio.voice` / `llm.temperature` 本轮无对应真源表 → **保持现手填**（不猜）。RunParamsPanel（运行中热调）本轮不改（其已继承同一 clamp 白名单）。

## 五、端点契约

`GET /api/v1/templates/:key/prefill?project_id=N`（templates.ts，新增）
- 200 → `PrefillResult`
- 400 `bad_project`（project_id 非法）/ 404 `template_not_found` / 404 `project_not_found`
- 只读、零网络、零计费。经前端 api 客户端 `templateApi.prefill(projectId, key)` 调用（遵裸 fetch 红线）。
- 不新增 DB 表 / 列；不改既有端点签名（纯加法）。

## 六、前端接线

1. `lib/types/api.ts`：加 `PrefillSource`、`PrefillInputValue`、`VideoOverride`、`PrefillResult`。
2. `lib/api/template.ts`（或 config 同级）：加 `templateApi.prefill`。
3. `RunFormModal.vue`：`selectTemplate` 拉详情后并行调 `prefill` → 按 §三优先级把 `inputs` 值写入 `form`、存 `sourceMap`；把 `overrides.video` 传入 adv 区块驱动清晰度/时长候选与默认。
4. `TemplateInputFields.vue`：加可选 `sources?: Record<string, PrefillSource>` prop，命中预填的字段旁渲染来源 chip（「上次运行」「项目简介」「模板默认」），纯展示不改受控逻辑。
5. 编辑任一预填字段 → 该 key 的 chip 消失（用户已接管，不再标 auto）。

## 七、实施顺序与门禁（沿用「服务端→探针→前端」+ 每 Task typecheck 全绿再 commit）

- **T1 服务端**：`run-prefill.ts` + `templates.ts` 端点 + 类型；`tsc --noEmit` 全绿。
- **T2 探针**：`probe-m34.ts`（见 §八）；`run-probes.ts` 自动发现纳入 `probe:ci`；m30/m31/m32/m33 零回归。
- **T3 前端**：类型 + api + RunFormModal + TemplateInputFields；`vue-tsc --noEmit` + `pnpm --filter @acs/web build` 全绿。
- **T4 文档**：`docs/milestones.md` M34 能力速览 + 路线图收窄至 M35–M37（G7 明确标注「暂缓 · 零成本路线待立项」）；G6/G8 相关说明并入对应文档。

## 八、验证（probe-m34，零网络零计费）

- **last-run**：播种项目 + 两条同模板 run（较新者 completed、含 `_params` 内部键）→ 端点对文本/整型键返回较新值且 `source=last_run`；`_params` 等内部键**不出现**；files/publications 键**不复用**。
- **brief**：无 run + `project.brief='测试简介'` + 白名单命中的空文本输入 → 值=brief、`source=brief`；非白名单输入**不填**；已有 template_default 的输入**不被 brief 覆盖**（优先级）。
- **precedence**：template_default < last_run（同 key 时 run 值胜出并改 source）。
- **g8-caps**：项目默认视频实例=MiniMax → `overrides.video.durations` ⊆ [4,15]、`selectableResolutions` 与输入白名单交集为空时回落全量、`defaultResolution` 仅在 ∈ 可选域时非空（防 400）；volcengine → durations [4,15]；未知/未登记 model → `overrides.video=null`（前端回退手填）。
- **guards**：不存在模板 404；不存在项目 404；非法 project_id 400；项目软删（`deletedAt`）→ 不纳入（注：`pipeline_runs` 无 `deletedAt`，run 随项目级联删，故不按 run 软删过滤）。
- **zero-cost**：全链无 fetch/LLM（纯 DB + 静态表），断言响应确定、幂等。
- 门禁：双端 typecheck + `--filter @acs/web build` + `validate:templates` 全绿；`.vue/.ts` 行数 ≤800。

## 九、边界与后续

- **G7 不在本轮**：自然语言→模板推荐需 LLM 或 embedding，用户已定「暂缓 + 零成本路线」，独立于 G6/G8，归后续（拟 M34b / 并入 M35 评估）。本轮**不建推荐端点、不留 LLM 半成品**。
- **不做 LLM 改写预填**：brief 放置为字符串定位，不生成、不摘要。
- **RunParamsPanel 热调 / image/audio/llm 覆盖**：本轮不动（无对应真源表，不猜）。
- **保留人工红线**：付费 run 启动确认、密钥、跨项目引用不变——预填只减少空白手填，不自动启动任何 run。
