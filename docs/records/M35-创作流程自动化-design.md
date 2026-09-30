# M35 创作流程自动化 · 设计规格（L1）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

**日期**：2026-09-20
**里程碑**：M35（承接 [charter §五](file:///d:/work/AI/docs/superpowers/specs/2026-09-19-agencys-content-studio-platform-intelligence-charter.md)）
**范围**：G9 settings.video 写时闸门 + G7 自然语言→模板推荐（embedding 零成本）+ G10 轻松创作 Tier A 自动推导 + G11 规则引擎下一步建议
**不含**：付费执行、密钥录入、合规放行、跨项目引用（charter §六 保留人工红线）

## 一、背景与决策模型

M32/M33/M34 已完成「能力真源表 + Tier A 自动预填」三层决策模型的地基与建 run 链路落地。M35 把该范式推进到**项目层配置**（G9）、**建项目入口**（G7）、**轻松创作方案**（G10）、**全站流程引导**（G11）—— 覆盖「建项目 → 起会话 → 定方案 → 完成一集」主链路上的四处「啥都让用户选/让用户配」遗留缺口。

用户三轮 AskUserQuestion 拍板（本轮开工前）：

1. **G11 路线** = 规则引擎零成本（模板 `next` 字段 + 项目状态机；现有 LLM `canvasAdvice` 保留为「深度分析」手动按钮，不改造为默认全站触发）
2. **G7 预计算** = 启动时全量 embed 模板存内存 Map（无磁盘持久化、无 embedding 表；模板增删改时增量刷新；推荐端点只做 query embed + cosine）
3. **M35 范围** = 全做 G9+G10+G11+G7，一次交付

核心纪律延续：
- **零 LLM 计费**（G7 embedding 本地 ONNX、G9 纯校验、G10 clamp 是数值钳制、G11 规则引擎），除 G10 中「向已存在的规划 LLM 请求上下文注入能力约束」外不新增任何计费
- **不猜测 / 不静默降级 / 成本可见**：G10 每次钳制在 assistant message 尾部明写；G11 建议是纯提示、绝不自动执行
- **加法优先**：新表 0 / 新列 0 / 不改既有端点契约（新加端点）
- **Tier A 不取消校验**：G9 把「用户手填核实」转移到「服务端按 run-params RULES 自动闸门」；非法值仍拒 400，只是拒绝方式从「运行时炸」变「写入前挡」

## 二、G9 · settings.video 写时闸门

### 问题
[`PATCH /projects/:id:176`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/routes/projects.ts#L153-L182) 与 `POST /projects` 对 `body.settings` 直接 `JSON.stringify` 存库，无子字段校验。用户可写 `settings.video = { resolution: '4K', duration: 120, provider: '' }`，[`ai-video.ts:85`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/pipeline/actions/ai-video.ts) 运行时读到才炸。

### 方案
新增 [`apps/server/src/services/project-settings.ts`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/services/project-settings.ts)：

```ts
export class ProjectSettingsError extends Error { code = 'bad_settings' }
export function validateProjectSettings(raw: unknown): { settings: Record<string, unknown>; errors: string[] }
```

规则（复用 [`run-params.ts:RULES.video`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/services/run-params.ts) 白名单，保持「输入域」一致）：
- `settings` 非对象 / 数组 → `errors: ['settings 需为对象']`
- `settings.video` 若存在但非对象 → 报错
- 子字段：
  - `provider` / `model`：trim 非空字符串才保留（空串 → 忽略该键，向后兼容）
  - `resolution`：命中 `/^(480|720|1080)p$/i`（同 run-params 白名单），否则报错「需为 480p/720p/1080p」
  - `duration`：数字 ∈ [1, 30] 且 clamp 到区间；非数字报错
  - **未登记键（fps / aspectRatio / 等）保留原值放行**（`ffmpeg-merge` 消费 `vidCfg['fps']`，G9 只治理「已知会 400」的项，不做无根据的字段收紧）
- `settings.image / audio / llm` 同结构（复用 `RULES` 四组）；本轮主要修 `video`，其余三组同规矩一并接入（一次性成本，未来扩展性）

路由接线（两处）：
- `POST /projects`：`body['settings']` 传入前调 `validateProjectSettings`；errors 非空 → `HttpError(400, 'bad_settings', errors.join('；'))`
- `PATCH /projects/:id`：同上；仅 `body['settings'] !== undefined` 时校验

**回滚性**：仅新加校验，不改数据；已有存坏值的项目仍可读、下次保存触发校正。

## 三、G7 · 自然语言 → 模板推荐（embedding 零成本）

### 问题
[`ProjectFormModal.vue:82`](file:///d:/work/AI/Agent/agencys-content-studio/apps/web/src/components/project/ProjectFormModal.vue) 建项目时靠 `GENRE_DEFAULT_TPL` 静态映射 + 用户手选下拉；[`easy-create/index.vue:14`](file:///d:/work/AI/Agent/agencys-content-studio/apps/web/src/views/easy-create/index.vue) 首页 example 是硬编码。15 套模板（`mengbao-episode`、`easy-video`、`quick-video`、`topic-radar`、`platform-adapt` …）都有 `name` / `description` / `genre`，但用户输入的自然语言创意无法映射到「哪套模板最合适」。

### 方案
新增 [`apps/server/src/services/template-recommend.ts`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/services/template-recommend.ts)：

```ts
const vectors = new Map<string, number[]>()   // key → normalized embedding
let init: Promise<void> | null = null
export function recommendReady(): boolean
export async function refreshTemplateVectors(): Promise<void>  // listTemplates + embed 每套
export async function recommendTemplates(text: string, top = 3): Promise<Array<{ key, name, score }>>
```

**文本模板**（embed 输入）：`${name}。${description ?? ''}。体裁：${genre}。场景：${scene ?? ''}` — 保持 15 套模板规模小，一次性 embed 全部 2-3 秒可接受。

**触发点**：
- 启动：[`index.ts`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/index.ts) `void refreshTemplateVectors()`（懒加载，不阻塞 `app.listen`）
- 模板增删改：`saveTemplate` / `deleteTemplate` 完成后 fire-and-forget `void refreshTemplateVectors()`

**fallback**（embedding 未 ready 或失败）：
- 静态 `GENRE_KEYWORDS: Record<genre, string[]>`（如 `drama_short → ['短剧','剧情','萌宝','分集']`）命中即按 genre 过滤 `listTemplates()` 返回
- 端点响应 `{ ready: boolean, items: [...], source: 'embedding' | 'keyword' | 'empty' }`

**端点**：`GET /api/v1/templates/recommend?text=xxx&top=3`
- `text` 缺失 / trim 空 → 400 `bad_text`
- embedding 未 ready → 走 keyword fallback，`ready:false`；不 500

**前端**：
- `lib/api/projects.ts` 加 `templateApi.recommend(text, top=3): Promise<RecommendResult>`
- `ProjectFormModal.vue`：`brief` textarea `@input` debounce 500ms → `recommend(brief, 3)`；命中非空则在下拉里加「✦ 推荐」徽标（前 3），点击直接 `tplKey.value = key; tplTouched.value = true`
- `easy-create/index.vue`：`idea` textarea `@input` debounce 800ms → `recommend(idea, 1)`；命中在示例 chip 下方追加「💡 此创意接近「{name}」」提示（不预选，只引导）

**约束**：遵「禁裸 fetch」红线；embed 走 api 客户端；错误不阻塞基本提交。

## 四、G10 · 轻松创作 Tier A 自动推导（能力表 + 体裁 → plan）

### 问题
[`creation-chat/planning.ts:121`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/services/creation-chat/planning.ts) `chatCompleteDetailed` 前 LLM 完全不知道当前 video 实例能力档位（`resolveVideoCaps`）；[`preflight.ts`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/services/creation-chat/preflight.ts) 事后 `throw CreationError` 让用户「重新规划」。用户「轻松一点」不指定 duration/aspectRatio 时，LLM 可能给 20s/镜（超 MiniMax 4-15）或 16:9（若模型只支持 9:16）→ 直接 422。

### 方案（双管）

#### G10.1 · 能力约束注入（提示词层）
`sendCreationMessage` 在 `chatCompleteDetailed` 前 `try { const video = await requiredEndpoint('video'); const caps = resolveVideoCaps(...) } catch { /* 无 video 实例 */ }`，命中则向 messages 追加一条 system 消息：

```
【Tier A 能力约束】当前视频模型 {providerKey}/{model} 已核实支持：
- 镜头时长档位：{durations.join(' / ')} 秒（shots[].duration 必须命中此列表）
- 支持画幅：{aspectRatios.join(' / ')}（plan.aspectRatio 必须 ∈ 此集合）
- 建议总时长 30–60 秒，镜头数 4–8 段（避免超能力）
若与用户明示诉求冲突，以本约束为准并说明理由。
```

无 video 实例 / siliconflow_video（caps=null）→ 追加：「当前无视频能力背书 → 若用户不要求动态，默认 mode=slideshow（多图配音）」。

genre → 建议 aspectRatio 默认（写入同一条 system 消息）：`talking_head/science/story → 9:16 优先`；`product → 保持不推`。

#### G10.2 · 方案后置钳制（契约层）
新增 [`services/creation-chat/clamp.ts`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/services/creation-chat/clamp.ts)：

```ts
export interface ClampReport { shotDurations: Array<{ id, from, to }>; aspectRatio?: { from, to }; mode?: { from, to; reason } }
export function clampPlanToCaps(plan: CreationPlan, caps: VideoCaps | null, hasVideo: boolean): { plan: CreationPlan; report: ClampReport }
```

- `caps.durations` 非空 → 每 shot.duration 若不在档位中 → 取最近合法值（升序找 ≥ 的最小、否则取最大）；记录到 report
- `caps.aspectRatios` 非空 → plan.aspectRatio 不在集合中 → 改为 `caps.aspectRatios[0]`；记录
- `caps=null`（未登记模型）或 `hasVideo=false`（无 video 实例）且 `plan.mode='dynamic'` → 降级 `mode='slideshow'`；记录 `reason='视频能力未背书'`
- **plan.duration**：不动（是 LLM 自己算的总时长，由 shots 之和反算）

**明告而非静默**：`clampPlanToCaps` 返 `report`；若 report 非空，`planning.ts` 在 `reply.message` 尾部追加：
「（因当前视频模型能力上限：镜头 S3 时长 20→15s；画幅 16:9→9:16；模式 dynamic→slideshow）」
（对齐「不静默降级」红线）。

**红线**：clamp 只调数值/枚举，不改 script/lines/shots 文本内容；`preflightPlan` 保持原状（clamp 后再进 preflight 应该全通过）；若 clamp 后仍有 preflight 错（如 aspectRatios=[] 之类病态），走原 throw 路径。

## 五、G11 · 规则引擎「下一步建议」

### 问题
[`canvasAdvice`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/services/creation/advice.ts) 只在画布页由用户手动点按钮触发（每次 LLM 计费）。项目主页 / run 完成后 / 模板链上游完成时，用户看不到「下一步该做什么」。但 [`Template.next?: string[]`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/pipeline/types.ts#L61-L62) 元数据字段早已存在（推荐下游模板），从未消费。

### 方案
新增 [`apps/server/src/services/next-steps.ts`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/services/next-steps.ts)：

```ts
export interface NextStep {
  key: string                 // 唯一 ID（前端 v-for :key）
  kind: 'run'|'publish'|'export'|'assets'|'next_tpl'|'progress'|'workbench'
  title: string               // 「运行『萌宝一集到底』模板」
  hint?: string               // 「集号自动沿用上次 = 5」
  cta?: string                // 「开始制作」按钮文案
  route?: string              // 前端路由（`/projects/:id/run?tpl=xxx`）
  templateKey?: string        // 若相关模板
  auto?: boolean              // 状态提示类（非可点）
}
export async function resolveNextSteps(projectId: number): Promise<NextStep[]>
```

**规则表**（按优先级，最多 3 条）：
1. 无 run 且项目有 templateKey → 「开始制作：运行『{template.name}』」+ `route=/projects/:id/run-new?tpl=`
2. 有 queued / running run → 「进度：#{id} 步 {n}/{total}」`auto:true`（不打断）
3. 最新 run succeeded 且 template.next 非空 → 「下一步：{next[0].name}」+ `route=/projects/:id/run-new?tpl={next[0]}`；`kind='next_tpl'`
4. 最新 run succeeded 且项目无 publications → 「发布本集」`kind='publish'`
5. 最新 run succeeded 且项目有 exports 记录缺 → 「导出成片」`kind='export'`
6. 有 succeeded run 且 project.brief 命中「系列」 → 「进入专业工作台精修」`kind='workbench'`

（规则集在实现期按代码可得性最终敲定；核心：读现有 `runs / publications / exports / templates` 表，不新增数据）

**端点**：`GET /api/v1/projects/:id/next-steps` → `{ items: NextStep[] }`

**前端**：
- `lib/api/projects.ts` 加 `projectApi.nextSteps(id)`
- 新增 [`components/project/NextStepsBar.vue`](file:///d:/work/AI/Agent/agencys-content-studio/apps/web/src/components/project/NextStepsBar.vue)（≤80 行）：横向 chip 条，`onMounted` + 每次 `run.completed / run.failed` socket 事件重拉；空态不渲染
- 挂在 [`views/Project*.vue`](file:///d:/work/AI/Agent/agencys-content-studio/apps/web/src/views/) 项目详情顶部（实施期定位）
- 点击 chip → `router.push(step.route)`；`auto:true` 不显按钮

**红线**：**不自动执行、不弹窗、不打断**。LLM `canvasAdvice` 保留手动「AI 建议」按钮不动（画布深度分析场景仍需要）。

## 六、端点契约汇总

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/v1/templates/recommend?text=&top=3` | GET | G7 新增；embedding 或 keyword 匹配；`{ready, items, source}` |
| `/api/v1/projects/:id/next-steps` | GET | G11 新增；`{items: NextStep[]}` |
| `/api/v1/projects/:id`（PATCH）| — | G9 加校验：`settings.video/image/audio/llm` 已登记子字段非法 → 400 `bad_settings` |
| `/api/v1/projects`（POST）| — | 同 G9 校验 |
| `/api/v1/creation-sessions/:id/messages`（POST）| — | G10 内部：注入 caps 系统消息 + clamp 后置；对外契约不变（除 assistant message 尾部可能追加钳制说明） |

## 七、实施顺序（每 Task typecheck + probe 全绿才 commit）

- **T1 · G9 服务端闸门**：新 `services/project-settings.ts` + `POST/PATCH projects` 接线 + 快速 server typecheck
- **T2 · G7 服务端**：新 `services/template-recommend.ts` + `GET /templates/recommend` 端点 + `index.ts` 启动懒加载 + `saveTemplate/deleteTemplate` 触发刷新 + server typecheck
- **T3 · G10 服务端**：`services/creation-chat/clamp.ts` + `planning.ts` 注入 caps 系统消息与 clamp；server typecheck
- **T4 · G11 服务端**：`services/next-steps.ts` + 路由；server typecheck
- **T5 · 前端接线**：`lib/types/api.ts` 追加类型；`lib/api/projects.ts` 新方法；`ProjectFormModal` 推荐徽标；`easy-create/index` 推荐提示；`RunFormModal`（若 G11 需要）；`NextStepsBar`；`Project*.vue` 挂载；web vue-tsc + build
- **T6 · 探针 probe-m35.ts**：四节（g9-settings / g7-recommend / g10-clamp / g11-next-steps）；零回归 m30/m31/m32/m33/m34
- **T7 · 文档收口**：milestones.md 加 M35 段 + 路线图收窄 M36–M37

## 八、验证策略

- **G9**：POST/PATCH 传合法 `{video: {provider, model, resolution:'720p', duration:10}}` → 200；传 `resolution:'4K'` → 400 `bad_settings`；传 `duration:120` → clamp 到 30 通过；未登记键 `fps:25` 放行；`settings` 非对象 → 400
- **G7**：mock embedding（若 CI 环境无 onnx 模型 → 走 keyword 路径）；`text='短剧 分集 萌宝'` → top-1 = `mengbao-episode`；`text='一句话选题'` → `topic-radar`；空 text → 400；embedding 未 ready → `ready:false` + keyword fallback
- **G10**：注入路径——LLM 前 messages 包含 system 消息 `【Tier A 能力约束】...`；clamp 路径——`caps.durations=[4,5,10]` + LLM 给 `duration:20` → 钳到 10 + message 追加提示；`hasVideo=false` + `mode:'dynamic'` → 强制 `'slideshow'` + `mode.reason='视频能力未背书'`；preflight 通过
- **G11**：空项目 → 「开始制作」；有 pending run → 进度不行动；最新 run succeeded + template.next=`['platform-adapt']` → 「下一步：平台适配」；已有 publications → 跳过发布建议；route 字段合法性
- **文件行数** ≤800（`project-settings.ts` / `template-recommend.ts` / `clamp.ts` / `next-steps.ts` / `NextStepsBar.vue` 均预留小体量）
- `pnpm ci:check` 端到端 + `pnpm --filter @acs/web build` + `validate:templates` 全绿

## 九、边界与不改动清单

- **不新增表 / 不新增列**：推荐向量存内存 Map；next-steps 端点纯读现有表；plan clamp 只改现有 JSON 字段
- **不改执行契约**：`_params` 三层叠加、引擎、DAG、适配器签名、模板本体零触碰
- **不改 canvasAdvice 端点**（保留 LLM 深度分析）
- **不改 preflightPlan 校验**（clamp 之后仍走原路径）
- **embedding 首次加载失败**：端点返 `ready:false` + keyword fallback；不阻塞其它任务
- **G9 未登记 settings 子键**（如 `settings.video.fps`）保留放行（只治理「已知会 400」的项）
- **G10 clamp 不动文本**：只调 duration/aspectRatio/mode 数值/枚举，不改 script/lines/shots 内容
- **G11 建议不自动执行**：纯 UI 提示，用户点击才导航；`auto:true` 类仅显示状态

## 十、开放项 / 实现期决策点

- G7 `GENRE_KEYWORDS` 具体清单在实施期根据 15 套模板 name/description 敲定（不预设完整清单）
- G10 能力约束注入的措辞具体形态（是拼进现有 system 消息还是新加一条）实施期与 `creation-plan.md` 提示词协调
- G11 项目详情页挂载点：`views/Project.vue` vs `views/ProjectDetail.vue`（若拆两个）实施期定
- 探针 mock embedding：若 CI 无 onnx 模型，g7 节走「未 ready + keyword fallback」断言路径；实弹另开
