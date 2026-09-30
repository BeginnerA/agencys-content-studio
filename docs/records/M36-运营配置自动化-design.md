# M36 运营配置自动化 · 设计规格（L1）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

**日期**：2026-09-20
**里程碑**：M36（承接 [charter §五](file:///d:/work/AI/docs/superpowers/specs/2026-09-19-agencys-content-studio-platform-intelligence-charter.md)，缺口 **G12**）
**范围**：G12.1 平台目录 + 预设 Tier A 自动补全 · G12.2 合规内置基础词（文件缺失兜底）· G12.3 合规词库补充建议采纳（Tier B，零新计费）· G12.4 排期发布节奏模板（Tier A 日期数学）
**不含**：付费执行、密钥录入、合规/法务放行判定、跨项目引用（charter §六 保留人工红线）

## 一、背景与决策模型

M32–M35 已把「真源表 + Tier A 自动预填 / Tier B 建议 / Tier C 人工」范式落地到 AI 配置、建 run 链路、项目配置、创作流程。M36 推进到**运营配置面**（痛点 6：排期 / 合规词 / 平台适配 / 发布）——这是主链路上最后一处「啥都让用户手工维护」的集群。

用户本轮开工前 AskUserQuestion 拍板（三项）：

1. **范围** = 全 4 项（G12.1 + G12.2 + G12.3 + G12.4）一次交付，与 M35 规模对齐
2. **G12.2 兜底强度** = 内置基础词**仅在 `words.txt` 文件缺失时**启用；现网有文件时扫描结果逐字不变（probe-m24 零回归）
3. **G12.3 落地方式** = 新增词库写入端点，一键把建议词追加进 `words.txt`（闭环「建议 → 采纳」）

核心纪律延续 M32–M35：
- **零新 LLM 计费**（G12.1 静态目录、G12.2 代码级基准词、G12.3 复用既有 run 已付费的 `params.compliance` 结论、G12.4 纯日期数学），不新增任何 LLM 调用
- **不猜测 / 不静默降级 / 成本可见**：G12.2 修复「文件缺失 → 静默不扫描」这一真实降级隐患；G12.3 建议仅呈现、用户点击才写入；G12.1 补全只填缺失项、用户已改的不覆盖
- **加法优先**：新表 0 / 新列 0 / 不改既有端点契约（仅新加端点；`GET /compliance/rules` 响应体向后兼容地扩展 `source` 取值域）
- **Tier A 不取消校验**：G12.4 批量建计划仍逐条走 `createSchedule` 未来时间校验；G12.3 写入仍守词库行格式

## 二、G12.1 · 平台目录 + 预设 Tier A 自动补全

### 问题
[`exports.ts:100`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/routes/exports.ts) 的 `DEFAULT_PRESETS` 仅硬编码 5 个视频向平台（douyin/wechat_channels/kuaishou/xiaohongshu/bilibili），缺公众号/知乎/头条；`watermark` 默认位普遍缺省。前端 [`PlatformPresets.vue:52`](file:///d:/work/AI/Agent/agencys-content-studio/apps/web/src/views/stats/PlatformPresets.vue) `addPreset()` 塞 `{platform:'other', label:'新平台', aspect:'9:16', ...}` 空壳，用户加一个受支持平台要逐项手填画幅/时长/命名——典型「本属 A 却放进用户手填」。

### 方案
把「各平台已知导出规格」收敛为一份单一真源目录，供前端一键带出。

新增 [`apps/server/src/services/platform-catalog.ts`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/services/platform-catalog.ts)：

```ts
export interface PlatformCatalogEntry {
  platform: string          // 机器键，与 publications.platform 枚举对齐
  label: string             // 中文名
  kind: 'video' | 'text'    // 视频平台 vs 图文平台（影响 maxDuration 语义）
  aspect: string            // 推荐画幅
  maxDuration: number       // 秒；图文平台 = 0（无时长维度）
  namingPattern: string
  includeCover: boolean
  includeSubtitle: boolean
  watermark: boolean
}
export const PLATFORM_CATALOG: PlatformCatalogEntry[]        // 8 平台单一真源
export function catalogByPlatform(platform: string): PlatformCatalogEntry | null
export function seedMissing(present: string[]): PlatformCatalogEntry[]  // 目录中不在 present 的条目
```

目录内容（8 平台，画幅/时长对齐 [`adapt-text.md`](file:///d:/work/AI/Agent/agencys-content-studio/workspace/prompts/adapt-text.md) 平台规则速查与既有 `DEFAULT_PRESETS`，不凭记忆发明）：douyin/wechat_channels/kuaishou/bilibili（沿用现值）、xiaohongshu（4:5）、wechat 公众号（text）、zhihu 知乎（text）、toutiao 头条（text）。`DEFAULT_PRESETS` 改为**从 `PLATFORM_CATALOG` 派生**（消除双份真源），保持既有 5 键的存量值逐字不变（回归零漂移）。

路由接线（[`exports.ts`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/routes/exports.ts) 新加，静态段先于 `:id`）：
- `GET /api/v1/exports/presets/catalog` → `{ items: PlatformCatalogEntry[] }`
- `POST /api/v1/exports/presets/seed` body `{ platforms?: string[] }`：给定键（缺省 = 目录全量）→ 与当前已存预设 merge，**仅补 `seedMissing` 的缺失项**（用户已配置/改过的平台不覆盖）→ 落 `settings.export_presets` → 返回 `{ items, added }`

**前端**（[`PlatformPresets.vue`](file:///d:/work/AI/Agent/agencys-content-studio/apps/web/src/views/stats/PlatformPresets.vue)）：查看模式头部加「从平台目录补全」按钮 → 调 `seed` → 刷新列表；编辑模式保留原 `addPreset`（自定义平台仍用手填）。

**回滚性**：仅新加端点 + 补全写 `export_presets`（用户可再编辑/删除），不动执行与既有导出契约。

## 三、G12.2 · 合规内置基础词（文件缺失兜底）

### 问题
[`compliance.ts:64`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/services/compliance.ts) `loadRules` 在 `words.txt` 缺失时返 `{rules: [], source: 'missing'}`，[`compliance-check.ts:30`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/pipeline/actions/compliance-check.ts) 仅日志「按空规则继续」——新用户/词库误删时，合规扫描**静默空转**，产物 `status='pass'` 具误导性（违「不静默降级」）。

### 方案
代码级内置基准词库作**文件缺失时的地板**（决策 2：仅 missing 时启用）。

[`compliance.ts`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/services/compliance.ts) 新增：

```ts
/** 内置《广告法》极限词高频基准地板（绝对化用语 block + 常见夸大 warn）；文件缺失时兜底，不覆盖用户词库 */
export const BASE_RULES: ComplianceRule[]
```

`loadRules` 改动（唯一入口，行为局部化）：
- 文件存在 → `parseRules` 结果原样返回，`source='file'`（**逐字不变**，probe-m24 全部文件在位断言零回归）
- 文件缺失 / 读取异常 → 返 `{ rules: BASE_RULES, source: 'builtin', path: file }`（原 `'missing'` 语义升级为 `'builtin'`）
- `source` 类型域：`'file' | 'builtin'`（原 `'missing'` 并入 `'builtin'`；`rulesView` 与 action 日志相应调整）

[`compliance-check.ts`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/pipeline/actions/compliance-check.ts) 日志：`source==='builtin'` → 「词库缺失 → 启用内置《广告法》基准地板（非完整法务词库，请按业务扩充 `words.txt`）」，让「用了兜底」对用户可见。

**红线**：`BASE_RULES` 是**标记/拦截语义的地板**，不构成法务意见（沿用 spec §8 免责）；有用户文件时绝不并入（避免改变现网命中集）。

## 四、G12.3 · 合规词库补充建议采纳（Tier B，零新计费）

### 问题
`compliance_check` 每次已产出 `params.compliance = { status, hits, llm: { verdict, items:[{category,quote,reason}] } }`（[`compliance.ts:94`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/services/compliance.ts)），但这些风险词从未回流为词库规则；词库纯手工维护，且**无写入端点**（只有 `rulesView` 只读）。

### 方案
从**既有已付费的复审结论**聚合候选词，一键追加进词库（不新增 LLM 调用）。

新增 [`apps/server/src/services/compliance-suggest.ts`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/services/compliance-suggest.ts)：

```ts
export interface SuggestedRule { category: string; word: string; level: 'block' | 'warn'; evidence: string; times: number }
/** 扫描项目域内资产的 params.compliance，聚合 llm.items.quote + 高频 hits 为候选新规则（去重、剔除词库已有词） */
export async function suggestRules(projectId: number | null): Promise<SuggestedRule[]>
/** 追加规则进 words.txt：自动建目录/文件；类别|词|级别 格式；(category,word) 去重（保留首见）；返回新增条数 */
export async function appendRules(rules: Array<{ category: string; word: string; level: 'block' | 'warn' }>): Promise<{ added: number; total: number }>
```

聚合逻辑（确定性、可探针）：遍历项目（或全域）资产的 `params.compliance.llm.items`，按 `quote` 归一聚合 → `word=quote`（截断 ≤20 字符、去空白）、`category=item.category`、`level='warn'`（建议起步一律 warn，是否升 block 交人工）、`evidence` 取首个 reason、`times` 计出现次数；并对当前词库 `loadRules()` 已有词去重（不重复建议）。命中 `hits` 中 `count>=2` 且类别为空的亦纳入候选（补齐分类）。

路由接线（[`routes/compliance.ts`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/routes/compliance.ts) 新加）：
- `GET /api/v1/compliance/suggest?project_id=` → `{ items: SuggestedRule[] }`（`project_id` 缺省 = 全域）
- `POST /api/v1/compliance/rules` body `{ rules: [{category, word, level}] }` → `appendRules` → `{ added, total }`；`rules` 非数组/空 → 400 `bad_rules`；单条缺 `word` → 跳过该条（坏行容错，对齐 parseRules 宽容）

**前端**（[`ReviewPanel.vue`](file:///d:/work/AI/Agent/agencys-content-studio/apps/web/src/views/stats/ReviewPanel.vue) 或合规视图区，实施期定位）：「词库补充建议」面板 → 拉 `suggest` → 每条前缀复选框 + 「采纳加入词库」按钮 → `POST /compliance/rules`（仅采纳勾选）→ 刷新。`GET /compliance/rules` 现况只读视图保留。

**红线**：建议一律 `warn` 起步（升 block 属法务判断，保留人工，charter §六）；「仅建议不执行」——用户点击才写入；`appendRules` 追加不覆盖、不改既有行。

## 五、G12.4 · 排期发布节奏模板（Tier A 日期数学）

### 问题
[`schedule.ts:143`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/services/schedule.ts) `createSchedule` 逐条接收单个 `scheduledAt`，`cronExpr` 固定 `'once'`（[`schedules.ts:78`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/routes/schedules.ts) 时间戳须逐一手填未来值）。用户要做「日更 7 天」需手动算 7 个时间戳、建 7 次——本属 A 的确定性日期推导却全压给用户。

### 方案
纯日期数学的节奏展开 + 预览闸门 + 批量建（零 LLM）。

新增 [`apps/server/src/services/cadence.ts`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/services/cadence.ts)：

```ts
export type Cadence =
  | { kind: 'daily' }
  | { kind: 'interval'; intervalDays: number }        // 2–30
  | { kind: 'weekly'; weekdays: number[] }            // 0–6（Sun–Sat），在 startAt 之后命中这些 weekday
export interface ExpandInput { startAt: number; count: number; cadence: Cadence }  // count 1–60
export function expandCadence(input: ExpandInput): { timestamps: number[]; errors: string[] }
```

- 保留 `startAt` 的「时:分」，按 cadence 递增日粒度 → `count` 个升序时间戳；`weekly` 从 startAt 起逐个向后命中 `weekdays` 集合
- 校验：`count ∈ [1,60]`、`intervalDays ∈ [2,30]`、`weekdays` 非空且 ∈ [0,6]、`startAt` 有限数 → 违规进 `errors`（不抛）；时间戳早于 `now-60_000` 的丢弃（对齐单条建的未来校验）；`errors` 非空 → `timestamps: []`
- 纯函数、确定性、可探针断言（给定 startAt/时区固定 UTC 偏移基准，产出稳定）

路由接线（[`routes/schedules.ts`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/routes/schedules.ts) 新加，静态段先于 `:id`）：
- `POST /api/v1/schedules/cadence-preview` body `{ start_at, count, cadence }` → `expandCadence` → `{ timestamps, errors }`（**预览闸门**：先看日期再确认，不直接建）
- `POST /api/v1/projects/:id/schedules/cadence` body `{ start_at, count, cadence, name_prefix?, template_key?, input_template }`：`expandCadence` → 逐条 `createSchedule({ name: \`${prefix} #${i+1}\`, ... })` → `{ created: Schedule[], skipped: number }`；`errors` 非空 → 400 `bad_cadence`；`input_template` 非空数组校验同单条

**前端**（[`ScheduleCalendar.vue`](file:///d:/work/AI/Agent/agencys-content-studio/apps/web/src/views/stats/ScheduleCalendar.vue)）：新建区加「节奏模板」下拉（日更/隔日更/每 3 天/周更指定日）+ 起始日 + 集数 → 「预览日期」调 `cadence-preview` 列出待建日期 → 「确认批量创建」调 bulk 端点 → 刷新日历。

**红线**：预览与创建分离（Tier A 自动值最终仍过人工确认闸门，charter §四.4）；不自动改 `cronExpr`（仍 `'once'` 逐条，复用既有幂等触发链，引擎零触碰）。

## 六、端点契约汇总

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/v1/exports/presets/catalog` | GET | G12.1 新增；`{items: PlatformCatalogEntry[]}` |
| `/api/v1/exports/presets/seed` | POST | G12.1 新增；仅补缺失平台预设；`{items, added}` |
| `/api/v1/compliance/rules` | GET | G12.2 响应扩展：`source` 域 `file\|builtin`（向后兼容） |
| `/api/v1/compliance/suggest?project_id=` | GET | G12.3 新增；`{items: SuggestedRule[]}` |
| `/api/v1/compliance/rules` | POST | G12.3 新增；追加规则进 words.txt；`{added, total}` |
| `/api/v1/schedules/cadence-preview` | POST | G12.4 新增；纯展开预览；`{timestamps, errors}` |
| `/api/v1/projects/:id/schedules/cadence` | POST | G12.4 新增；批量建；`{created, skipped}` |

## 七、实施顺序（每 Task typecheck + probe 全绿才 commit）

- **T1 · G12.1 服务端**：新 `services/platform-catalog.ts` + `DEFAULT_PRESETS` 派生改造 + catalog/seed 端点；server typecheck
- **T2 · G12.2 服务端**：`compliance.ts` `BASE_RULES` + `loadRules` 缺失兜底 + `source` 域 + `compliance-check.ts` 日志；server typecheck
- **T3 · G12.3 服务端**：新 `services/compliance-suggest.ts`（`suggestRules` + `appendRules`）+ `routes/compliance.ts` 两端点；server typecheck
- **T4 · G12.4 服务端**：新 `services/cadence.ts`（`expandCadence`）+ `routes/schedules.ts` 两端点；server typecheck
- **T5 · 前端接线**：`lib/types/api.ts` 追加 `PlatformCatalogEntry`/`SuggestedRule`/`Cadence` 等；`lib/api/insights.ts` 新方法（catalog/seed/suggest/appendRules/cadencePreview/cadenceCreate）；`PlatformPresets.vue` 补全按钮；合规建议面板；`ScheduleCalendar.vue` 节奏模板区；web vue-tsc + build
- **T6 · 探针 probe-m36.ts**：四节（g12-catalog / g12-baserules / g12-suggest / g12-cadence）；零回归 m24（合规）+ m30/m31/m32/m33/m34/m35
- **T7 · 文档收口**：milestones.md 加 M36 能力速览段 + 路线图收窄至 M37

## 八、验证策略

- **G12.1**：`GET catalog` 返 8 条含 kind/aspect；`DEFAULT_PRESETS` 与 catalog 派生一致（既有 5 键值不变）；`POST seed`（空预设）→ 补 8 条 `added=8`；`POST seed`（已有 douyin 自定义）→ 不覆盖 douyin、补其余；未知平台键忽略
- **G12.2**：`loadRules(临时空目录)` → `source='builtin'` + `rules=BASE_RULES`（非空）；`loadRules(含 words.txt 目录)` → `source='file'` + 仅文件规则（**不含 BASE_RULES**，回归关键）；probe-m24 合规节全绿（文件在位路径零变化）
- **G12.3**：插带 `params.compliance.llm.items` 的资产 → `suggestRules` 聚合去重、剔除词库已有词、`level='warn'`；`appendRules` 建文件 + 追加 `类别|词|warn` + `(category,word)` 去重 + `added` 计数；空/非数组 `rules` → 400；单条缺 word 跳过
- **G12.4**：`expandCadence(daily, startAt 固定, count=7)` → 7 个升序、间隔恰 86400s、时刻=起始时刻；`interval intervalDays=3 count=4` → 间隔 3 天；`weekly weekdays=[1,4] count=4` → 命中周一/周四升序；`count=0`/`intervalDays=1`/`weekdays=[]` → errors 非空 timestamps=[]；`preview` 端点透传；bulk 建 N 条 pending、名称带 `#i`、`errors`→400
- **文件行数** ≤800（`platform-catalog.ts`/`compliance-suggest.ts`/`cadence.ts` 均小体量；`ScheduleCalendar.vue` 现 927 行——**新增面板若超限须拆子组件**，实施期严守）
- `pnpm --filter @acs/server exec tsc --noEmit` + `pnpm --filter @acs/web exec vue-tsc --noEmit` + `pnpm --filter @acs/web build` + `validate:templates` 全绿

## 九、边界与不改动清单

- **不新增表 / 不新增列**：目录是代码常量；预设仍存 `settings.export_presets`；建议从既有 `assets.params.compliance` 派生；词库仍是文件；排期复用 `schedules` 表逐行
- **不改执行契约**：`createBatch`/调度器/引擎/DAG/模板本体零触碰；`cronExpr` 保持 `'once'`
- **G12.2 有用户文件时绝不并入 BASE_RULES**（现网命中集零变化，仅修「文件缺失静默空转」）
- **G12.1 `DEFAULT_PRESETS` 派生后既有 5 键值逐字不变**（回归零漂移）
- **G12.3 建议一律 warn 起步、点击才写入、追加不覆盖**；不改 `GET /compliance/rules` 只读语义
- **G12.4 预览与创建分离**；不自动触发（仍由调度器到点幂等触发）

## 十、开放项 / 实现期决策点

- G12.1 公众号/知乎/头条三图文平台的 `maxDuration`（拟 0=无时长维度）与 `namingPattern` 具体值实施期对齐 `adapt-text.md` 措辞敲定
- G12.3 建议面板挂载位置：并入 `ReviewPanel.vue` 合规区 vs 独立「词库」小节，实施期按现有布局定
- G12.4 `ScheduleCalendar.vue` 已 927 行逼近 800 上限——节奏模板区**须拆为独立子组件**（如 `ScheduleCadencePanel.vue`）以守行数红线
- 探针时区基准：`expandCadence` 断言以固定偏移/UTC 毫秒比较，避免本地时区漂移致探针不稳定
