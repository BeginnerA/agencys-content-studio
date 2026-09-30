# agencys-content-studio M8 技术设计规格（场景/道具参考资产库 + 风格预设库）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-12
- 上游：`2026-09-09-agencys-content-studio-roadmap.md`（北极星不变）；`2026-09-12-agencys-content-studio-m6-design.md` §1.3 排除项「场景 / 道具参考图注入｜本里程碑聚焦角色定妆照（下游资产链已存在，`reference_scene` 目录映射预留）；场景/道具库另立」——本里程碑即该落地；2026-09-12 三项目源码级对标结论 P1 缺口集群第③+④项（huobao：角色/场景/道具三库 + LLM 提取去重 + 各自图像提示词生成；stylePresets CRUD + 剧级绑定 + 生成时注入；Toonflow：素材四类单表 role/scene/tool + 项目级 artStyle + getArtPrompt 风格×用途矩阵）
- 红线复核：不新增体裁专属表（characters 表 +1 `kind` 列泛化为「实体素材库」；`style_presets` 为平台级通用表一张，均须论证，见 §3.1）；不改引擎调度（engine.ts / refs.ts 零改动；loader.ts 仅 action 白名单 +1）；不改 ffmpeg-merge / shot-workbench / tts / subtitle / 适配器层；ai_image 扩展为注入链叠加（未启用时行为与 M6 等价）；模板 version+1 向后兼容
- 设计原则三条：**① 单表多态**（对齐 Toonflow 素材四类）——场景/道具与角色字段同构（name/aliases/summary/appearance/negative/refAssetIds），复用 characters 表 + kind 列，服务/路由/注入/挂接一套机制三种实体，零新表；**② 快照即硬证据**（延续 M3/M6）——文本锚定与参考图 id 全量进 gen_tasks.prompt / params 快照，断点续跑与幂等变更检测自动生效；**③ 运行时注入 + 宽容降级**（对齐 huobao getDramaStylePrompt「查不到/已停用返回空串」）——风格预设按「项目绑定 → action 运行时解析 → 入队时拼入快照」，不依赖 LLM 遵守；未绑定/停用/未命中一律零注入 + 日志，绝不炸链路
- 备注：M6 实弹三项（图侧 refUsed / 视频侧首帧 / 全链）仍待用户在 Web 配好供应商后跑；M7 实弹目检已通过（2026-09-12，Run 40/61 全链 + 浏览器截图，快照见 README「M7 验收快照」）；M8 不依赖两者结果（但 M8 实弹复用同一批供应商配置）

---

## 1. 定位与边界

### 1.1 一句话目标

把「视觉一致性」从角色单点升级为「角色 + 场景 + 道具」三类素材的参考资产链，并建立可管理的风格预设库：

1. **场景/道具参考资产库**（对标 huobao 三库 / Toonflow 素材四类）：场景/道具档案提取 → 参考图提示词 → 出图 → 建库挂接；分镜按 `location` / `props` 命中自动注入文本锚定与参考图（跨镜空间/道具一致性）；
2. **风格预设库**（对标 huobao stylePresets / Toonflow artStyle）：预设 CRUD（名称/词块/排序/启用）+ 项目级绑定 → ai_image 运行时统一注入风格词块（分镜图 / 首帧图 / 参考图全通道）。

### 1.2 范围（做）

| # | 主项 | 内容 |
|---|---|---|
| P1 | 实体表泛化 | characters 表 + `kind` 列（character\|scene\|prop，默认 character）；实体服务泛化（loadEntityIndex / upsertEntity / attachRefAssets 加 kind 参数，旧签名保留委托） |
| P2 | 场景/道具档案链 | 新提示词 `set-profile.md` + `set-ref-prompts.md`；新 action `entity_sync`（`set-json` 档案解析 + 参考图挂接）；`set-json` 文本契约 |
| P3 | 参考图出图链 | ai_image 步骤参数 `output_purpose_by_category`（按 shot.category 分派 purpose）；purpose 新增 `reference_prop`（`reference_scene` 已预留） |
| P4 | ai_image 注入扩展 | `location` / `props` 命中 → 场景/道具文本锚定（`injectSetAnchors`）+ 参考图（`collectRefAssetIds`，角色 ≤4 → 场景 ≤1 → 道具 ≤1，总量 ≤6） |
| P5 | 风格预设库 | 新表 `style_presets`（name 唯一/snippet/sort_order/is_active）+ 服务 + `/style-presets` CRUD 路由 |
| P6 | 风格注入 | 项目绑定（projects.settings.style_preset_id 单值）→ ai_image 运行时 `injectStyleAnchor`（步骤开关 `use_style_preset`，默认 true）；任务快照增 `stylePresetId` 溯源 |
| P7 | 提示词升级 | `storyboard-ep.md` v5 → v6：schema 增 `props` 字段 + `location` 场景库对齐规则 + 模式说明补场景/道具自动锚定句 |
| P8 | 模板接线 | mengbao-episode v7 → v8、series-setup v1 → v2（场景道具链四步 + `with_set_refs` 开关） |
| P9 | Web | 素材页三 Tab 泛化（角色/场景/道具）+ 风格预设页 + 项目「视觉风格」绑定下拉 |
| V1 | 验证 | `probe-m8.ts`（migrate / entity / inject / style / api / template 六节）+ 实弹目检 + 兼容回归 |

### 1.3 M8 不做（明确排除）

| 排除项 | 理由 |
|---|---|
| 从参考图提取风格词（Toonflow extractStylePrompt） | 需视觉理解 LLM 通道，当前文本通道不支持；待视觉通道扩展后另立（backlog） |
| 风格预设多选组合叠加 | 单项目单选（对齐 huobao 剧级 style 单值 / Toonflow 项目级 artStyle 单值）；多预设拼接留 backlog |
| 视频侧场景/道具参考图注入 | 首帧图已承载视觉一致性（首帧图来自分镜出图，分镜出图注入了三类参考图）；M6 视频侧仅 `first_frame` 语义不动 |
| 素材参考图上传通道 | 沿用既有「从项目资产挑图」入口（与角色页一致），不做新上传 |
| 素材页批量生成 / 提示词润色交互（Toonflow polishAssetsPrompt） | 档案提示词链已覆盖自动生成；交互式润色留 backlog |
| states 变体入库 | char-profile 的 states 现状即未闭环（normalizeSpec 不落库），M8 不追平，保持一致 |
| @图片N 提示词引用语法跨家统一 | M6 已排除，维持 |

---

## 2. 现状与复用面（代码证据，2026-09-12 核实）

### 2.1 已就绪（本次改造的直接地基）

| 面 | 现状 | 证据 |
|---|---|---|
| 实体表 | characters 通用表（name/aliases/summary/appearance/negative/voice/refAssetIds/meta；projectId NULL=全局） | `db/schema.ts` L216-233 |
| 实体服务 | loadCharacterIndex（name/aliases 索引，项目行覆盖全局行）/ upsertCharacter（具名 upsert 保位）/ attachRefAssets（并集去重） | `services/character.ts` L12-99 |
| 角色文本锚定 | `injectCharacterAnchors`：逐镜 `角色锚定（名）：appearance` + `必须剔除：negative` 追加 image_prompt（纯函数已导出） | `actions/ai-image.ts` L342-368 |
| 参考图链 | `refAssetIdsOf`（shot.characters 命中并集）→ 任务快照 `params.refAssetIds` → 执行时 data URI（8MB 守卫 / step 级缓存 / 上限 4） | ai-image.ts L104-107 / L226-246 |
| 能力降级 | `imageRefCapability` + 降级日志（一次/step）+ `params.refUsed` 溯源 | ai-image.ts L79-85 / L310-317 |
| 参考图服务 | `assetToDataUri`（mime 推断 + 8MB 守卫 + 缓存参数） | `services/asset-ref.ts`（M6） |
| 目录映射 | purposeSubDir 已预留 `reference_scene → images`；未列出 purpose 回退 source | `services/storage.ts` L42-68 |
| 挂接先例 | character-sync：characters-json 多资产逐个尝试 + ref_images 按 `params.shotId` 归属（资产名包含兜底）→ attachRefAssets | `actions/character-sync.ts` L100-144 |
| action 注册 | registry + loader.KNOWN_ACTIONS 双处注册（新增 action 两处都加） | `actions/index.ts` L19-30、`pipeline/loader.ts` |
| 文本契约 | `validateTextOutput`（storyboard-json / lines-json / characters-json）+ `isJsonTextFormat` + defaultName | `actions/ai-text.ts` L129-217 |
| 项目 settings | `PATCH /projects/:id` 支持 settings 全量 JSON 更新；`GET` 返回解析后对象 | `routes/projects.ts` L163 / L125 |
| 迁移兜底 | `initDb` → `ensureSchemaColumns`（PRAGMA 列检查 + ALTER TABLE 幂等补齐先例：api_configs.pricing 等） | `db/index.ts` L47-89 |
| Web 角色页 | CharactersView：CRUD + 挑图（项目资产选择器）+ 全局/项目域 + 空态/Modal | `apps/web/src/views/CharactersView.vue` |
| 风格现状 | 画风词块库 10 套静态内嵌于 ref-prompts.md；series-setup 产「视觉基调」；分镜 style_tail 靠 LLM 遵守 | `prompts/ref-prompts.md` L32-60、`prompts/series-setup.md` L22 |

### 2.2 缺口（M8 要补）

1. **场景/道具无实体**：仅 series-setup 文字「场景视觉卡」与分镜自由文本（location）——无库、无参考图、无注入；`reference_scene` 目录映射为预留空转；
2. **分镜 schema 缺道具引用**：storyboard shots 无 `props` 字段；`location` 无「与场景库对齐」规则；
3. **风格无管理**：无预设 CRUD、无项目绑定、无运行时注入——画风一致性完全依赖 LLM 产出 style_tail（漂移无兜底）；
4. **注入链角色专用**：`refAssetIdsOf` / `injectCharacterAnchors` 只认 shot.characters；
5. **purpose 缺道具**：`reference_prop` 无目录映射与 UI 标签。

### 2.3 对标落法（2026-09-12 源码核实）

| 维度 | huobao | Toonflow | 本仓 M8 落法 |
|---|---|---|---|
| 场景/道具库 | 角色/场景/道具三库（独立表）+ 集关联 + 分镜级绑定 + 各自提示词生成 | 素材四类单表 o_assets（role/scene/tool/storyboard）+ assets2Storyboard 绑定 + 批量生成 | characters 单表 + kind 三态（字段同构，复用全链含挂接/注入/挑图） |
| 风格预设 | style_presets 表（value/prompt/is_active）+ dramas.style 单值绑定 + `getDramaStylePrompt` 生成时注入（查不到/停用 → 空串兜底） | o_project.artStyle 单值 + `getArtPrompt(artStyle, 用途)` 矩阵 | style_presets 表 + projects.settings.style_preset_id 单值绑定 + 运行时注入（同款空串兜底哲学） |
| 注入时点 | 生成请求组装时拼接 | 生成请求组装时拼接 | gen_task 入队时拼入 prompt 快照（溯源 + 幂等变更检测自动生效） |

---

## 3. 设计（决策完备）

### 3.1 数据模型（`db/schema.ts`）

```ts
// characters 表泛化：+ kind 列（实体素材库：character|scene|prop）
kind: text('kind').notNull().default('character'),

// 新表：风格预设库（平台级通用：跨体裁画风词块）
export const stylePresets = sqliteTable('style_presets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),       // 预设名（唯一）
  snippet: text('snippet').notNull(),           // 英文风格词块（拼接进出图提示词）
  description: text('description'),             // 展示用说明
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: integer('is_active').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
```

**红线论证**（为何 +1 列 +1 表）：
- `characters.kind`：场景/道具与角色字段 90% 同构（Toonflow 即以单表四类承载）；单表多态使挂接（attachRefAssets）、注入（索引/锚定/参考图）、挑图 UI 全链零复制；红线「不做体裁专属表」的本义是禁 dramas/episodes 式业务表，kind 为**实体类型维度**而非体裁，不违背；
- `style_presets`：平台级通用能力（跨体裁跨项目画风锚定），对标两家均为独立实体；放 settings JSON 无法支撑 CRUD 列表与排序，表化合理。

**迁移**：`initDb.ensureSchemaColumns` 增 `characters.kind` 兜底（PRAGMA 检查 + `ALTER TABLE characters ADD COLUMN kind text NOT NULL DEFAULT 'character'`，对齐 api_configs.pricing 先例）；`pnpm db:generate` 生成增量迁移（如流程产出）；`style_presets` 建表随迁移/兜底 `CREATE TABLE IF NOT EXISTS`。存量行 kind 自动为 `character`，行为零变化。

**表语义注记**：characters 表名保留（避免大迁移），schema 注释升级为「实体素材库（kind 多态：character|scene|prop）」。

### 3.2 实体服务泛化（`services/character.ts`）

```ts
export type EntityKind = 'character' | 'scene' | 'prop'

/** 实体索引：kind 限定（projectId 项目域 + 全局行；同名项目覆盖全局） */
export async function loadEntityIndex(projectId: number, kind: EntityKind = 'character'): Promise<Map<string, CharacterRow>>

/** 单实体查询（含别名命中；kind 限定） */
export async function findEntity(projectId: number, name: string, kind: EntityKind = 'character'): Promise<CharacterRow | null>

/** 具名 upsert（kind 分派；新建写 kind；同 kind 同域同名命中 → 更新） */
export async function upsertEntity(p: { projectId: number | null; kind?: EntityKind; name: string; aliases?: string[]; summary?: string | null; appearance?: string | null; negative?: string | null; voice?: string | null; refAssetIds?: number[]; meta?: Record<string, unknown> }): Promise<{ id: number; created: boolean }>

/** 参考图挂接（kind 限定命中行；并集去重） */
export async function attachRefAssets(projectId: number, name: string, assetIds: number[], kind: EntityKind = 'character'): Promise<number>
```

- **兼容**：`loadCharacterIndex` / `findCharacter` / `upsertCharacter` 旧签名保留，内部委托 `kind='character'`——probe-m3 character 段（直接 import 这些函数）零改动回归；
- **关键修正**：三个查询的 where 必须含 `kind`（否则场景行混入角色索引，shot.characters 误命中）；upsert 的同名命中同样 kind 限定（角色「小院」与场景「小院」互不干扰）。

### 3.3 路由面

**① `routes/characters.ts` 泛化 + 兼容（不新建文件）**：

- 新增同 handler 挂载路径 `/entities`（GET ?project_id=&kind= / POST / PUT / DELETE）；`/characters` 路径原样保留（隐式 `kind='character'`）——存量 Web/脚本/探针零改动；
- kind 校验：`character|scene|prop`（非法 → 400）；缺省 `character`；
- 字段约束：`voice` 仅 character 有意义——scene/prop 传入时忽略（不报错）；
- 全局域约束保持（projectId NULL 不接受项目资产引用）；
- 列表响应视图（toEntityView）：同 toCharacterView + `kind` 字段。

**② 新 `routes/style-presets.ts`**：

```jsonc
GET /style-presets?active=1        // 列表（active=1 仅启用，排序 sort_order asc, id asc）
POST /style-presets                // { name, snippet, description?, sort_order? }（name 唯一校验）
PUT /style-presets/:id             // 局部更新（name/snippet/description/sort_order/is_active）
DELETE /style-presets/:id          // 删除（项目绑定残留 → 运行时宽容降级）
```

- 校验：name 非空且唯一（撞名 400）；snippet 非空；sort_order 整数；
- 项目绑定：复用 `PATCH /projects/:id` 的 settings 全量更新（Web 端读-合并-写 `style_preset_id`），服务端零新增绑定端点。

### 3.4 ai_image 注入扩展（`actions/ai-image.ts`）

**① 索引与锚定**：

- 加载三个索引：`loadEntityIndex(projectId, 'character'|'scene'|'prop')`（单机百条级，成本可忽略）；
- 角色锚定保持 `injectCharacterAnchors` 不动；
- 新增导出纯函数 `injectSetAnchors(shots, sceneIndex, propIndex)`：
  - `shot.location`（trim 后）命中场景索引（等值 + 别名 + 小写兜底，同角色口径）→ 追加 `场景锚定（{name}）：{appearance}`（+ `必须剔除：{negative}`）；
  - `shot.props[]`（数组，逐项）命中道具索引 → 追加 `道具锚定（{name}）：{appearance}`（+ negative）；
  - 未命中名进 `missing`；返回新数组不改入参；
- 执行顺序：角色锚定 → 场景/道具锚定 → 风格锚定；日志汇总「场景锚定 N 镜 / 道具锚定 M 镜（未命中：…）」。

**② 参考图收集**（导出纯函数 `collectRefAssetIds(shot, indexes)`，替代现行 refAssetIdsOf）：

- 收集序与上限：角色（shot.characters，`MAX_CHARACTER_REFS_PER_SHOT=4` 截断，M6 语义保持）→ 场景（shot.location 命中行 refAssetIds，≤1）→ 道具（shot.props 命中行并集，≤1）；总量上限 `MAX_REFS_PER_SHOT=6`；
- 任务快照 `params.refAssetIds`（数组，结构不变）；`refUsed` 口径保持「计划注入数」（`refCap==='base64' && useCharacterRefs` 时才非 0）；
- 降级日志条件扩展：「有参考图可用」的判定改用 `collectRefAssetIds` 结果（场景/道具候选同样触发一次/step 降级提示）；
- `use_character_refs` 步骤参数语义升级为「参考图注入总开关」（名称保持不变，存量模板零感知）。

**③ 风格注入**：

- 解析（新 `services/style-preset.ts`）：

```ts
/** 解析项目绑定的风格预设词块：settings.style_preset_id → style_presets(is_active=1)；未绑定/停用/不存在 → null */
export async function resolveProjectStyleSnippet(projectId: number): Promise<{ id: number; name: string; snippet: string } | null>
```

- 纯函数 `injectStyleAnchor(shots, snippet)`：snippet 非空 → image_prompt 尾追 `视觉风格：{snippet}`；空/未绑定 → 原样返回；
- 触发：`ctx.def.params.use_style_preset !== false`（默认 true）且解析非 null；降级日志「项目未绑定风格预设 / 预设已停用，跳过风格注入」（一次/step）；
- 任务快照：`gen_tasks.params` 增 `stylePresetId`（null 或缺省）——项目换绑后未成功任务经既有变更检测自动 requeue，已成功任务不动；
- 注入后 `task.prompt` 即完整快照（角色 + 场景/道具 + 风格三段齐全）——溯源与一致性硬证据。

**④ purpose 分派**：

- 步骤参数 `output_purpose_by_category`（JSON 对象，如 `{ "prop": "reference_prop" }`）；
- 出图时：`purpose = params.output_purpose_by_category?.[shot.category] ?? parsed.output_purpose ?? 'shot_image'`；
- 兼容：无 `category` 字段或未配置映射 → 行为同现状（M6 零变化）。

### 3.5 entity_sync action（新 `actions/entity-sync.ts`）

> 语义：场景/道具素材建档（对齐 character_sync 的手感与产物模式；character_sync 保持角色专属不动）。

- 输入：`sets`（set-json 资产，多资产逐个尝试，取第一个含非空 scenes/props 的）+ `ref_images?`（参考图资产序列，按 `asset.params.shotId = 场景/道具名` 归属，资产名包含兜底）；
- params：`{ project = true }`（true → 项目域；false → 全局库，不挂项目资产）；
- 解析：`{ scenes?: EntitySpec[]; props?: EntitySpec[] }`（至少一数组非空）；条目 `{ name, aliases?, summary?, visual?, negative? }`（visual 落库 appearance 列；ref_prompt 忽略——仅出图链消费）；
- 建档：逐条 `upsertEntity(kind 分派)`；挂接：`attachRefAssets(kind 分派)`；
- 产物：`set-log.md`（purpose `set_log`，JSON 快照 `{ scope, created, updated, refAttached }`）；
- 幂等：同 kind 同域同名 → updated 分支；挂接并集去重；
- 失败：无有效档案 → StepError（含输入资产名与原因；对齐 character_sync）；
- 注册：`actions/index.ts` registry + `pipeline/loader.ts` KNOWN_ACTIONS 双处 + `entity_sync`。

### 3.6 文本契约扩展（`actions/ai-text.ts`）

- `validateTextOutput` 新增 `set-json`：`{ scenes?: [], props?: [] }` 至少一数组含有效条目（`name` 非空；`appearance` 非空字符串）；返回条目总数（scenes + props，供日志「场景道具档案解析通过：N 项」）；
- `isJsonTextFormat` / `defaultName('set-json') → 'sets.json'` / tag 分派（'sets'）同步。

### 3.7 提示词（新增 2 + 升级 1；char-profile.md v2 / ref-prompts.md v2 不动）

**① 新增 `set-profile.md`**（对齐 char-profile 结构）：

- 输入：script（本集剧本 / series-setup 中为设定包）+ setting（可能含系列设定包）；
- 输出 Schema：`{ "scenes": [{ name, aliases?, summary, appearance, negative, ref_prompt }], "props": [{ name, aliases?, summary, appearance, negative, ref_prompt }] }`
  - scenes.appearance = 场景视觉短语（地点类型 / 空间布局 / 关键陈设 / 材质色调 / 光线特征，逗号分隔可直拼生图）；
  - props.appearance = 道具外观短语（外形 / 材质 / 颜色 / 标志细节）；
  - ref_prompt = 英文一行（场景=空镜构图；道具=单品图）；
- 规则：只提取本集有戏份场景与**剧情关键道具**；设定包含场景视觉卡 / 标志性道具时逐字对齐（设定包优先）；结构化短语禁叙述长句；negative 写最易漂移维度；上限场景 ≤8 / 道具 ≤6；合规红线；同一场景/道具不重复建档。

**② 新增 `set-ref-prompts.md`**（对齐 ref-prompts）：

- 输入：场景/道具档案 JSON + setting；
- 输出 storyboard-json：`{ shots: [{ id: 名称逐字, category: "scene"|"prop", image_prompt, style_tail }] }`；
- 规则：id 逐字（下游按 id 归属参考图）；场景=空镜无人物、道具=单品纯背景；style_tail 全体统一（Look Dev 对齐；未提供时按题材自画风词块库就近取，与角色定妆照同一套）；画面无文字元素。

**③ 升级 `storyboard-ep.md` v5 → v6**：

- Schema 增字段：`"props": ["本镜关键道具（道具档案名逐字；无则空数组）"]`；
- 规则 3（人物一致性）扩展为「角色/场景/道具一致性」：`location` 优先取设定包场景视觉卡的场景名**逐字一致**（无对应场景卡时自由描述）；`props` 与道具档案 name 逐字一致、仅列本镜画面实际出现的剧情关键道具；
- 模式说明末句补：「跨镜空间/道具一致性由 location/props 字段 + 素材库锚定注入承载」（对齐角色句）。

### 3.8 模板接线

**① mengbao-episode v7 → v8**（新增四步链 + 一个开关；角色链原样）：

```yaml
inputs:
  - key: with_set_refs
    label: 生成场景/道具参考图并入档（true=素材参考图；false=仅建档）
    kind: bool
    required: false
    default: false
steps:
  - key: set_profile                      # 新增：场景/道具档案（对齐 char_profile 模式）
    action: ai_text
    title: 场景道具档案
    after: [write_script]
    inputs:
      script: steps.write_script.asset
      setting: steps.ingest_docs.assets
    params:
      prompt_tpl: set-profile.md
      output_purpose: sets
      output_format: set-json
      name_tpl: "{episode_number:03d}-场景道具档案.json"

  - key: set_ref_prompts                  # 新增：场景/道具参考图提示词（对齐 ref_prompts 模式）
    action: ai_text
    title: 场景道具参考图提示词
    after: [set_profile]
    inputs:
      sets: steps.set_profile.asset
      setting: steps.ingest_docs.assets
    params:
      prompt_tpl: set-ref-prompts.md
      output_purpose: storyboard
      output_format: storyboard-json
      name_tpl: "{episode_number:03d}-场景道具提示词.json"

  - key: gen_set_refs                     # 新增：参考图出图（when 开关）
    action: ai_image
    title: 场景道具参考图生成
    when: input.with_set_refs == true
    after: [set_ref_prompts]
    inputs:
      shots: steps.set_ref_prompts.asset
    params:
      output_purpose: reference_scene
      output_purpose_by_category: { prop: reference_prop }
    batch: { field: shots, max_concurrent: 1, retry: 1 }

  - key: sync_set                         # 新增：素材建档 + 参考图挂接
    action: entity_sync
    title: 场景道具建档
    after: [set_profile, gen_set_refs]
    inputs:
      sets: steps.set_profile.asset
      ref_images: steps.gen_set_refs.assets

  # 既有步骤微调（仅 after 链，确保注入时点前素材库已挂接参考图）：
  # gen_images.after: [make_storyboard, sync_characters] → + sync_set
  # gen_frames.after: [make_storyboard, sync_characters] → + sync_set
```

- `version: 7 → 8`；模式矩阵不变（compose 零改动）；
- 存量 run 兼容：v7 快照模板无新步骤 → 重合成 / 重生成行为等价（引擎按快照执行）；
- `when` 跳过的步骤为终态（M6 已验证语义），`steps.gen_set_refs.assets` 宽容解析为空数组。

**② series-setup v1 → v2**：同构加链（对齐既有 char 链输入口径）：

```yaml
inputs: + with_set_refs
steps:
  + set_profile      (after: [write_series]，inputs: { script: steps.write_series.asset, setting: steps.ingest.assets })
  + set_ref_prompts  (after: [set_profile]，inputs: { sets: steps.set_profile.asset, setting: steps.write_series.asset })
  + gen_set_refs     (when: input.with_set_refs == true)
  + sync_set         (after: [set_profile, gen_set_refs])
```

### 3.9 Web

**① 素材页**（CharactersView.vue 泛化 → 新 `EntitiesView.vue`，旧文件删除）：

- 三 Tab：角色 / 场景 / 道具（kind 本地状态，切换即重拉 `/entities?kind=`）；导航文案「角色」→「素材」；
- 字段标签按 kind 适配：appearance（角色=外观锚定 / 场景=视觉短语 / 道具=外观描述）；voice 仅角色 Tab 显示与编辑；
- 复用既有挑图选择器（项目资产选择）+ 全局/项目域约束 + 空态文案（分 kind 说明来源：运行角色建档 / 素材建档模板或手动新建）；
- 前端路由 `/characters` → `/entities`（App.vue RouterLink 同步）。

**② 风格页**（新 `StylePresetsView.vue`）：列表（名称 / snippet 摘要 / 描述 / 启用开关 / 排序）+ 新建/编辑 Modal + 删除确认；导航新区「风格」（icon: sparkles/brush 类）。

**③ 项目绑定**：ProjectDetailView 项目编辑入口增「视觉风格」下拉（选项 = 启用中预设 + 「不使用」；当前值读 `project.settings.style_preset_id`）；提交时读-合并写 settings（PATCH /projects/:id）。

**④ lib 扩展**：`api.ts` 增 `entityApi`（list/create/update/remove，带 kind 参数）与 `stylePresetApi`（list/create/update/remove）；`types.ts` 增 `EntityKind` / `EntityItem` / `StylePresetItem`；`format.ts` purpose 标签补 `reference_scene`「场景参考」/ `reference_prop`「道具参考」/ `sets`「场景道具」/ `set_log`「素材建档」。

### 3.10 降级与错误语义（全链统一）

| 场景 | 语义 |
|---|---|
| 项目未绑定风格预设 / 预设已停用 / 被删 | 零注入 + 日志（一次/step）；任务不失败（对齐 huobao 空串兜底） |
| shot.location 未命中场景库 / props 未命中道具库 | 该镜零锚定跳过；missing 汇总日志（对齐角色 missing 现状） |
| 参考图读失败 / 超 8MB / 非图资产 | 跳过该图 + 日志（M6 语义）；不足则降级 |
| scene/prop 传 voice | 忽略（不入库，不报错） |
| 全局库（projectId NULL） | 不接受项目资产引用（对齐角色路由现状） |
| entity_sync 输入无有效档案 | StepError（含来源名与原因；对齐 character_sync） |
| set-json 畸形 / scenes+props 双空 | validateTextOutput 拒绝 → ai_text 步骤失败（可修正后重跑） |
| 同名跨 kind（角色「小院」vs 场景「小院」） | 完全隔离（索引/查询/upsert 均 kind 限定） |

---

## 4. 改动清单（文件级）

| 文件 | 改动 |
|---|---|
| `apps/server/src/db/schema.ts` | characters + `kind` 列；新增 `stylePresets` 表 + 类型导出 |
| `apps/server/src/db/index.ts` | `ensureSchemaColumns` 增 characters.kind 兜底 |
| `apps/server/src/services/character.ts` | 泛化 loadEntityIndex / findEntity / upsertEntity / attachRefAssets（kind 参数）；旧签名保留委托 |
| `apps/server/src/services/style-preset.ts` | **新增**：resolveProjectStyleSnippet（+ CRUD 辅助函数） |
| `apps/server/src/routes/characters.ts` | 同 handler 挂 `/entities`（kind 参数）；`/characters` 兼容保留 |
| `apps/server/src/routes/style-presets.ts` | **新增** CRUD（§3.3） |
| `apps/server/src/app.ts` | 注册 `stylePresetsRoutes`（一行） |
| `apps/server/src/pipeline/actions/entity-sync.ts` | **新增** action（§3.5） |
| `apps/server/src/pipeline/actions/index.ts` | registry + `entity_sync` |
| `apps/server/src/pipeline/loader.ts` | KNOWN_ACTIONS + `entity_sync`（仅白名单 +1） |
| `apps/server/src/pipeline/actions/ai-image.ts` | injectSetAnchors / collectRefAssetIds / injectStyleAnchor / 三索引加载 / output_purpose_by_category / stylePresetId 溯源 |
| `apps/server/src/pipeline/actions/ai-text.ts` | validateTextOutput + `set-json`；isJsonTextFormat / defaultName 同步 |
| `apps/server/src/services/storage.ts` | purposeSubDir：`sets`/`set_log` → texts；`reference_prop` → images |
| `workspace/prompts/set-profile.md` | **新增** 提示词 |
| `workspace/prompts/set-ref-prompts.md` | **新增** 提示词 |
| `workspace/prompts/storyboard-ep.md` | v5 → v6（props + location 规则 + 模式说明） |
| `workspace/templates/mengbao-episode.yaml` | v7 → v8（四步链 + with_set_refs + after 微调） |
| `workspace/templates/series-setup.yaml` | v1 → v2（四步链 + with_set_refs） |
| `apps/web/src/views/EntitiesView.vue` | **新增**（CharactersView 泛化三 Tab） |
| `apps/web/src/views/CharactersView.vue` | 删除（由 EntitiesView 替代） |
| `apps/web/src/views/StylePresetsView.vue` | **新增** 风格预设页 |
| `apps/web/src/views/ProjectDetailView.vue` | 「视觉风格」绑定下拉 |
| `apps/web/src/lib/api.ts` / `types.ts` / `format.ts` | entityApi / stylePresetApi / 类型 / 标签 |
| `apps/web/src/App.vue` | 导航「素材」+「风格」；路由 /entities |
| `apps/server/scripts/probe-m8.ts` | **新增**探针（§5） |
| `apps/server/package.json` | `probe:m8` script |
| `docs/`、`README.md` | 本 spec + roadmap 注记 + README 小节（实施后） |

不改动（红线）：`pipeline/engine.ts`、`pipeline/refs.ts`、`services/shot-workbench.ts`、`actions/ffmpeg-merge.ts`、`actions/character-sync.ts`、`actions/ai-video.ts`、`services/asset-ref.ts`、适配器层、`TaskPanel.vue` / `ShotBoard.vue`（复用）。

---

## 5. 验收

1. **静态**：`npx tsc --noEmit`（server）与 web 构建通过；mengbao-episode v8 / series-setup v2 过模板校验（`POST /templates/validate`）；
2. **探针 `probe-m8.ts`**（对齐 probe-m6/m7 风格，构造型断言，不发网络请求）：
   - `migrate`：characters.kind 列存在（PRAGMA）且旧行默认 `character`；style_presets 表存在；重复 initDb 幂等；
   - `entity`：loadEntityIndex kind 隔离（场景行不进角色索引）/ 别名命中 / 项目行覆盖全局行 / upsertEntity kind 分派与同名跨 kind 隔离 / attachRefAssets kind 限定 / 旧签名（loadCharacterIndex 等）回归等价；
   - `inject`：injectSetAnchors（场景命中 / 道具多命中 / 别名 / 未命中 missing / 原文不变 / 角色函数不受影响）+ collectRefAssetIds（顺序 角色→场景→道具 / 4+1+1 截断 / 总量 6 / 去重 / 空镜零值）；
   - `style`：resolveProjectStyleSnippet（绑定命中 / 未绑定 / 停用 / 被删 / 项目 settings 缺键）+ injectStyleAnchor（有 snippet 追加 / 空 snippet 原样）；
   - `api`：/entities CRUD + kind 过滤 + /characters 兼容路径 + 全局域资产约束 + /style-presets CRUD + name 唯一 + snippet 必填；
   - `template`：mengbao v8 契约（步骤集 / with_set_refs / after 链）+ series-setup v2 + set-json validateTextOutput（合法 / 双空拒绝 / 缺 name 拒绝）；
3. **实弹目检**（用户 Web 端操作）：
   - 一集开 `with_set_refs=true` → 场景道具档案 + 参考图 + 建档挂接三资产齐；任务 params.refUsed 记录素材参考图计划数；
   - 分镜 location/props 与库命中 → gen_images 日志「场景锚定 N 镜 / 道具锚定 M 镜」+ 参考图注入日志；
   - 风格页建预设（如「3D 写实厚涂·冷蓝」）→ 项目绑定 → 出图任务 prompt 快照含「视觉风格：…」段；解绑重建 run 验证零注入；
   - 断点续跑：换绑风格后未成功任务 requeue 重出，已成功不动（幂等语义）；
4. **兼容回归**：`probe-m2a` / `probe-m3`（characters 服务签名兼容）/ `probe-m6` / `probe-m7` 全绿；存量 v7 run 重新合成 / 单镜重生成行为等价；角色出图注入链（M6）行为不变（未建场景/道具/风格时逐字节等价）；
5. **越界核查**：`git diff --stat` 无 engine / refs / ffmpeg-merge / shot-workbench / character-sync / ai-video / asset-ref / 适配器变更；
6. **文档**：README 增「场景/道具参考资产与风格预设」小节；roadmap 注记 M8。

## 6. 风险与对策

1. **characters 加列对存量库** → ensureSchemaColumns 兜底 + default 'character'（旧行为逐字节不变）；探针 migrate 节断言；
2. **单表多态的同名跨 kind 污染** → 索引/查询/upsert 全链 kind 限定 + 探针隔离断言；
3. **注入增量与请求体**（6 张 ≈ 6-18MB POST）→ 4+1+1 上限 + 8MB/张守卫 + 并发 2 不变；如需再收可调 `MAX_REFS_PER_SHOT`；
4. **风格注入改变 prompt 快照** → 未成功任务 requeue 是期望语义（换风格应重出）；已成功任务产物溯源不动（与 M6 refUsed 变更同模式）；
5. **LLM 产 location/props 与库名单不同字** → 宽容零注入 + missing 日志（同角色现状）；提示词 v6 规则升级提升对齐率；别名（aliases）兜底；
6. **set-json 畸形** → 契约校验拒绝（步骤失败可修正重跑），不污染下游；
7. **素材页泛化回归** → 同 handler 同服务（`/characters` 兼容路径保留），probe-m3 + 手工核对；
8. **风格停用后绑定残留** → 运行时返回 null + 日志（不炸）；UI 绑定下拉只列启用预设（弱化残留）。

## 7. 交付物清单

- 代码：§4 全部（server 泛化 + 新 action + 注入扩展；web 素材页 / 风格页 / 项目绑定）；
- 模板：mengbao-episode v8、series-setup v2；提示词：set-profile.md、set-ref-prompts.md 新增，storyboard-ep.md v6；
- 探针：`probe-m8.ts`（六节）+ 实弹验收记录；
- 文档：本 spec、roadmap 注记 M8、README 小节（实施后回填）。
