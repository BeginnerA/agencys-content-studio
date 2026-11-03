# M74 角色一致性工程化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把角色参考图从扁平数组升级为分层可控策略（基准/状态变体/多视角），宿主侧模型能力表消除静默降级，逐角色一致性评价复用 M24 评分并接入 M73 门禁。

**Architecture:** Hono + Drizzle(libsql) 服务端新增 entity_references 分层登记表与 character_consistency_results 结果表；参考选择策略与状态匹配抽为纯函数服务（state-match / ref-selection），ai-image 消费分层选择并快照能力与选择明细；一致性评价编排复用 eval-service 的多模态评分，final 阶段 checker 纯 DB 读消费结果表。

**Tech Stack:** TypeScript, Hono, drizzle-orm/libsql, Vue 3 `<script setup>`, tsx 隔离探针。

**Spec:** `docs/records/M74-角色一致性工程化-design.md`（计划与 spec 冲突时以 spec 为准；spec 已含计划期修正记录）

## Global Constraints

- 禁 pnpm；一切 node 直调（`node node_modules/typescript/bin/tsc --noEmit` 等）；禁安装任何依赖；探针禁真实网络与真实模型调用
- 单文件 ≤800 行（唯一例外裁决：schema.ts 为全库表登记文件，843 行已获批）
- 注释与文案自解释：禁「M号/intg/阶段码/裸§节号/line/切片」等外部编号指针；`node --import ./node_modules/tsx/dist/loader.mjs scripts/check-comment-pointers.ts` exit 0
- 验证唯一入口：`.superpowers/sdd/M74-计划/safe-run.mjs`（server/web/probe/migration/format kinds）
- 探针走真实产品路径：状态/断言逐条对应真实端点或真实服务函数，禁直插 DB 掩盖守卫
- 子代理不执行 git commit（用户纪律：默认不代提交）
- win32 + git bash；文件路径用正斜杠
- 迁移命名 `m74_character_consistency`（drizzle-kit generate 产物 0007_*.sql）

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| apps/server/src/db/schema.ts | 修改 | +entityReferences +characterConsistencyResults 表；stylePresets +negative |
| apps/server/src/db/index.ts | 修改 | 两表 CREATE TABLE IF NOT EXISTS 兜底 + style_presets.negative ALTER 兜底 |
| apps/server/src/services/state-match.ts | 新建 | states 解析与三档命中（从 ai-image 抽出共享） |
| apps/server/src/services/ref-selection.ts | 新建 | 分层选择策略 + 镜头参考收集（纯函数） |
| apps/server/src/services/entity-references.ts | 新建 | 分层登记 CRUD/派生同步/loadRefIndex/预览 |
| apps/server/src/services/image-caps.ts | 新建 | 宿主侧图像模型参考能力表 |
| apps/server/src/pipeline/actions/ai-image.ts | 修改 | 消费 state-match/ref-selection/caps；params 快照扩展；style negative |
| apps/server/src/services/style-preset.ts | 修改 | 解析结果带 negative |
| apps/server/src/routes/entity-references.ts | 新建 | 参考分层 6 端点 + GET /image-caps |
| apps/server/src/routes/quality-gates.ts | 修改 | +POST consistency-eval +GET character-consistency |
| apps/server/src/services/consistency-eval.ts | 新建 | 逐角色评价编排与结果落表 |
| apps/server/src/services/stage-check.ts | 修改 | +character.consistency checker（final 阶段） |
| apps/server/src/app.ts | 修改 | 注册 entityReferencesRoutes |
| apps/server/scripts/probe-m74.ts + probes/m74/* | 新建 | 六节探针 |
| apps/web/src/lib/api/*.ts | 修改/新建 | entityRefs/imageCaps/consistency client |
| apps/web/src/views/project-detail/AssetsPanel.vue | 修改 | 参考分层管理区 |
| apps/web/src/components/run/CharacterConsistencyPanel.vue | 新建 | 逐角色一致性卡片 |
| apps/web/src/views/run-detail/index.vue | 修改 | 挂载一致性面板 |
| apps/web/src/views/style-presets/index.vue | 修改 | negative 编辑 |
| apps/server/scripts/probe-m8.ts / probe-m22.ts / probes/m19/states.ts | 修改 | import 路径迁移（断言体逐字不变） |

---

### Task 1: 表与迁移

**Files:**
- Modify: `apps/server/src/db/schema.ts`（qualityGates 定义之后追加；stylePresets 在 schema.ts:245-254）
- Modify: `apps/server/src/db/index.ts`（CREATE TABLE IF NOT EXISTS 兜底区，参照 quality_issues/quality_gates 兜底写法）
- Create: `apps/server/drizzle/0007_m74_character_consistency.sql`（drizzle-kit 生成）

**Interfaces:**
- Consumes: 既有 `characters`、`assets`、`pipelineRuns`、`stylePresets` 表定义
- Produces: drizzle 表对象 `entityReferences`、`characterConsistencyResults`；`stylePresets.negative`（string|null）。后续任务用 `typeof entityReferences.$inferSelect` 作行类型。

- [ ] **Step 1: schema.ts 追加两表**

在 `qualityGates` 定义之后追加（确认 schema.ts 首行 drizzle-orm import 含 `real`，缺则补）：

```ts
/** 实体参考图分层登记（role：base=基准定妆 / state=状态变体 / view=多视角补充；enabled=0 暂不参与选择） */
export const entityReferences = sqliteTable(
  'entity_references',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    entityId: integer('entity_id').notNull().references(() => characters.id),
    assetId: integer('asset_id').notNull().references(() => assets.id),
    role: text('role').notNull(), // base|state|view
    stateKey: text('state_key'), // role=state 时 = 该实体 states 数组某条目原文
    viewKey: text('view_key'), // role=view 时视角说明（自由文本）
    enabled: integer('enabled').notNull().default(1),
    note: text('note'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_entity_refs_pair').on(t.entityId, t.assetId),
    index('idx_entity_refs_entity').on(t.entityId),
  ],
)

/** 逐角色一致性评价结果（一 run×一实体一行，重评覆盖；score 为 0–10 均分，NULL=无法评价且 note 记原因） */
export const characterConsistencyResults = sqliteTable(
  'character_consistency_results',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id').notNull().references(() => pipelineRuns.id),
    entityId: integer('entity_id').notNull().references(() => characters.id),
    episodeIdx: integer('episode_idx').notNull().default(0),
    score: real('score'),
    assetTotal: integer('asset_total').notNull().default(0),
    assetSampled: integer('asset_sampled').notNull().default(0),
    refCount: integer('ref_count').notNull().default(0),
    model: text('model'),
    provider: text('provider'),
    note: text('note'),
    evaluatedAt: integer('evaluated_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_char_consistency_pair').on(t.runId, t.entityId),
    index('idx_char_consistency_run').on(t.runId),
  ],
)
```

stylePresets 表（schema.ts:245-254）`snippet` 行之后加一列：

```ts
  negative: text('negative'), // 负向约束词（与风格词块一体复用；运行时以「必须剔除：」锚点注入）
```

- [ ] **Step 2: db/index.ts 兜底建表**

在既有 quality_issues/quality_gates 兜底语句之后，同风格追加两条 CREATE TABLE IF NOT EXISTS（列与迁移逐一对应）+ 两条 CREATE UNIQUE INDEX IF NOT EXISTS + 两条 CREATE INDEX IF NOT EXISTS；style_presets 列追加用可重复 ALTER（SQLite 无 IF NOT EXISTS 列语法，包裹 try/catch 忽略 duplicate column）：

```ts
try {
  sqlite.exec('ALTER TABLE style_presets ADD COLUMN negative TEXT')
} catch {
  // 列已存在（迁移 0007 已应用过）→ 幂等跳过
}
```

- [ ] **Step 3: 生成迁移并校验**

```bash
node .superpowers/sdd/M74-计划/safe-run.mjs migration
```

（先复制 `.superpowers/sdd/M73-计划/safe-run.mjs` 为 M74 版：`probe` 指向 `scripts/probe-m74.ts`、migration 名 `m74_character_consistency`、`.env` 检查保持注释态。本步若 safe-run 未就绪可先直调 `node apps/server/node_modules/drizzle-kit/bin.cjs generate --name=m74_character_consistency`（cwd=apps/server），T8 前补 safe-run 文件不阻塞。）

Expected: 生成 `apps/server/drizzle/0007_m74_character_consistency.sql`，含两表 + 4 索引 + style_presets ALTER。

- [ ] **Step 4: server typecheck**

```bash
node .superpowers/sdd/M74-计划/safe-run.mjs server
```
Expected: exit 0。

- [ ] **Step 5: 报告**（不 commit；写报告文件，状态 DONE/BLOCKED）

---

### Task 2: state-match 抽共享 + ref-selection 分层选择策略

**Files:**
- Create: `apps/server/src/services/state-match.ts`
- Create: `apps/server/src/services/ref-selection.ts`
- Modify: `apps/server/src/pipeline/actions/ai-image.ts`（删除被抽出的定义，改 import）
- Modify: `apps/server/scripts/probe-m8.ts`、`apps/server/scripts/probe-m22.ts`、`apps/server/scripts/probes/m19/states.ts`（仅 import 源，断言体逐字不变）

**Interfaces:**
- Consumes: `CharacterRow`（schema.ts，states/refAssetIds 为 JSON 字符串列）；Task 1 无直接依赖（本任务全纯函数，行结构用最小接口）
- Produces（后续任务按这些签名消费）:

```ts
// state-match.ts
export type StateMatchMode = 'scene' | 'episode' | 'text'
export function parseStateEntry(s: unknown): { node: string; phrase: string }
export function matchStateEntry(
  entry: string,
  ctx: { scene?: number; episode?: number; text?: string },
): { hit: boolean; mode: StateMatchMode; node: string; phrase: string }

// ref-selection.ts
export type RefRole = 'base' | 'state' | 'view'
export const REF_ROLES: readonly RefRole[]
export const MAX_CHARACTER_REFS_PER_SHOT = 4
export const MAX_REFS_PER_SHOT = 6
export interface EntityRefRow { entityId: number; assetId: number; role: RefRole; stateKey: string | null; viewKey: string | null; enabled: number }
export interface SelectedRef { assetId: number; role: RefRole; reason: string }
export interface RefShot { id: string; characters?: string[]; location?: string; props?: string[]; ref_asset_ids?: number[]; scene?: number; image_prompt?: string }
export function selectEntityRefs(
  row: { id: number; states: string; refAssetIds: string },
  refRows: EntityRefRow[],
  ctx: { scene?: number; episode?: number; text?: string },
  limit: number,
): { selected: SelectedRef[]; fallbacks: string[]; dropped: SelectedRef[] }
export interface ShotRefSelection {
  ids: number[]
  perEntity: { entityId: number; name: string; refs: SelectedRef[] }[]
  fallbacks: string[]
  dropped: SelectedRef[]
}
export function collectRefSelection(
  shot: RefShot,
  indexes: { characters: Map<string, CharacterRow>; scenes: Map<string, CharacterRow>; props: Map<string, CharacterRow> },
  refIndex?: Map<number, EntityRefRow[]>,
  stateCtx?: { episode?: number },
): ShotRefSelection
export function collectRefAssetIds(shot: RefShot, indexes: Parameters<typeof collectRefSelection>[1], refIndex?: Map<number, EntityRefRow[]>, stateCtx?: { episode?: number }): number[]
export function mergeRefIds(primary: number[], secondary: number[], limit?: number): number[]
```

- [ ] **Step 1: 新建 state-match.ts**

从 ai-image.ts:504-558 逐字搬移 `parseStateEntry`、`numFromToken`（私有）、`StateMatchMode`、`STATE_SCENE_RE`、`STATE_EPISODE_RE`、`matchStateEntry` 及其文档注释（注释即语义规格，原样保留）。export 与源文件一致的函数签名。

- [ ] **Step 2: 新建 ref-selection.ts**

```ts
/**
 * 实体参考图分层选择策略（纯函数）。
 * role 优先级：状态命中 → 基准 → 多视角补充；
 * 实体未登记分层行时，refAssetIds 全体按隐式基准处理（旧项目零改动语义，无隐式写库）。
 */
import type { CharacterRow } from '../db/schema'
import { matchStateEntry } from './state-match'

export type RefRole = 'base' | 'state' | 'view'
export const REF_ROLES = ['base', 'state', 'view'] as const
export const MAX_CHARACTER_REFS_PER_SHOT = 4
export const MAX_REFS_PER_SHOT = 6
```

`selectEntityRefs` 实现骨架：

```ts
export function selectEntityRefs(row, refRows, ctx, limit) {
  const enabled = refRows.filter((r) => r.enabled === 1 && r.entityId === row.id)
  const selected: SelectedRef[] = []
  const fallbacks: string[] = []
  const dropped: SelectedRef[] = []
  const seen = new Set<number>()
  const take = (r: EntityRefRow, reason: string): void => {
    if (seen.has(r.assetId)) return
    if (selected.length >= limit) { dropped.push({ assetId: r.assetId, role: r.role, reason: `超出参考图上限(${limit})` }); return }
    seen.add(r.assetId)
    selected.push({ assetId: r.assetId, role: r.role, reason })
  }
  if (enabled.length === 0) {
    // 隐式基准：未分层实体沿用扁平数组序（与旧 collectRefAssetIds 行为等价）
    for (const assetId of parseNumArr(row.refAssetIds)) {
      if (selected.length >= limit) { dropped.push({ assetId, role: 'base', reason: `超出参考图上限(${limit})` }); continue }
      seen.add(assetId); selected.push({ assetId, role: 'base', reason: '基准参考（未分层）' })
    }
    return { selected, fallbacks, dropped }
  }
  // 状态命中：与文本锚定同款语义——多条命中取数组最后一条（数组序即时间序，后覆盖前）
  let hitEntry: string | null = null
  for (const entry of parseStrArr(row.states)) {
    const m = matchStateEntry(entry, ctx)
    if (m.hit && m.phrase) hitEntry = entry
  }
  if (hitEntry) {
    const stateRefs = enabled.filter((r) => r.role === 'state' && r.stateKey === hitEntry)
    if (stateRefs.length > 0) for (const r of stateRefs) take(r, `状态命中「${hitEntry}」`)
    else fallbacks.push(`状态「${hitEntry}」无分层参考，回退基准`)
  }
  for (const r of enabled.filter((x) => x.role === 'base')) take(r, '基准参考')
  for (const r of enabled.filter((x) => x.role === 'view')) take(r, '多视角补充')
  return { selected, fallbacks, dropped }
}
```

文件内私有 JSON 解析器 `parseNumArr(s: string): number[]` / `parseStrArr(s: string): string[]`（行为对齐 ai-image.ts 同名私有函数：JSON.parse 守卫、非数组返回空、数字需正整数）。

`collectRefSelection` 实现：顺序 0) `shot.ref_asset_ids` 直通前插 → 1) 角色逐行 selectEntityRefs（**跨角色共享 4 名额，按出场顺序截断**，与旧语义一致；limit = 剩余名额；命中实体名取 row.name）→ 2) 场景 location 命中行 ≤1（enabled 分层取首个 base，无分层行时回退 refAssetIds[0]）→ 3) 道具并集 ≤1；`seen` 保序去重，总量 ≤MAX_REFS_PER_SHOT，满额后新的角色选择行进 dropped（reason=超出总量上限）。角色查找函数与 ai-image.ts `lookupCharacter` 同款（原样 → 小写兜底），文件内私有实现。场景/道具分层取用与角色不同点：不做状态命中优先（场景道具无 states 语义），直接 enabled 按 id 升序取首个可用。

`collectRefAssetIds` = `(shot, indexes, refIndex, stateCtx) => collectRefSelection(...).ids`（薄封装，保持既有探针断言可直接迁移）。

`mergeRefIds(primary, secondary, limit = MAX_REFS_PER_SHOT)`：从 ai-image.ts:52-60 搬来，仅加第三参（保序去重截断语义不变）。

- [ ] **Step 3: ai-image.ts 改 import 并删除原定义**

- 删除本地 parseStateEntry/numFromToken/StateMatchMode/STATE_SCENE_RE/STATE_EPISODE_RE/matchStateEntry（504-558 区段）与 collectRefAssetIds（651-695 区段）、mergeRefIds、两个 MAX 常量；
- 头部 import 改为：

```ts
import { matchStateEntry } from '../../services/state-match'
import { collectRefAssetIds, mergeRefIds, MAX_CHARACTER_REFS_PER_SHOT, MAX_REFS_PER_SHOT } from '../../services/ref-selection'
```

（相对路径以 ai-image.ts 实际所在目录 `src/pipeline/actions/` 为准。）
- `injectStateAnchors`、`injectCharacterAnchors`、`injectSetAnchors`、`injectStyleAnchor`、`parseStrArr`、`parseNumArr`、`lookupCharacter` 留在原文件（仅其内部对 matchStateEntry 的引用走新 import）。
- 本任务内先不加 refIndex/caps 参数（Task 3 做），collectRefAssetIds 的两处调用点（ai-image.ts:148、190）传参不变即可编译。

- [ ] **Step 4: 探针 import 更新（断言体逐字不变）**

- probe-m8.ts:190/232-264：`collectRefAssetIds` 改从 `../src/services/ref-selection` 动态 import，`injectSetAnchors/injectStyleAnchor` 仍从 ai-image；
- probe-m22.ts:70/126：同路径替换；
- probes/m19/states.ts:10：`parseStateEntry/matchStateEntry` 改从 `../../../src/services/state-match` 取，`injectStateAnchors` 仍从 ai-image 取。

- [ ] **Step 5: 回归验证**

```bash
node node_modules/tsx/dist/loader.mjs  # 前置：cwd=apps/server
node --import ./node_modules/tsx/dist/loader.mjs scripts/probe-m8.ts
node --import ./node_modules/tsx/dist/loader.mjs scripts/probe-m22.ts
node --import ./node_modules/tsx/dist/loader.mjs scripts/probe-m19.ts
node --import ./node_modules/tsx/dist/loader.mjs scripts/probe-m73.ts   # ai-image 下游链路未破坏
node .superpowers/sdd/M74-计划/safe-run.mjs server
```
Expected: 全部 exit 0（探针输出 PASS 计数无 FAIL）。

- [ ] **Step 6: 报告**（含 ai-image.ts 新行数）

---

### Task 3: entity-references 服务 + image-caps + ai-image 集成

**Files:**
- Create: `apps/server/src/services/entity-references.ts`
- Create: `apps/server/src/services/image-caps.ts`
- Modify: `apps/server/src/pipeline/actions/ai-image.ts`
- Modify: `apps/server/src/services/style-preset.ts`（解析结果带 negative）

**Interfaces:**
- Consumes: Task 1 表对象；Task 2 `EntityRefRow / RefRole / REF_ROLES / collectRefSelection / mergeRefIds / MAX_REFS_PER_SHOT`；既有 `recordEntityVersion`（services/provenance.ts:128，`VersionSource` 联合类型取值以该文件为准，用 `'edit'`）、`resolveEndpoint`/`getImageAdapter`（ai-image.ts:444-451 同款用法）
- Produces:

```ts
// entity-references.ts
export class EntityRefError extends Error { constructor(public status: number, msg: string) }  // 400/404/409 语义
export type EntityRefView = { id: number; entityId: number; assetId: number; role: RefRole; stateKey: string | null; viewKey: string | null; enabled: boolean; note: string | null; createdAt: number }
export async function listEntityRefs(entityId: number): Promise<EntityRefView[]>
export async function addEntityRef(p: { entityId: number; assetId: number; role: string; stateKey?: string | null; viewKey?: string | null; note?: string | null }): Promise<EntityRefView>
export async function patchEntityRef(refId: number, p: { enabled?: boolean; role?: string; stateKey?: string | null; viewKey?: string | null; note?: string | null }): Promise<EntityRefView>
export async function removeEntityRef(refId: number): Promise<void>
export async function backfillEntityRefs(entityId: number): Promise<{ added: number }>
export async function loadRefIndex(entityIds: number[]): Promise<Map<number, EntityRefRow[]>>
export async function previewEntitySelection(entityId: number, ctx: { scene?: number; episode?: number; text?: string }, limit?: number): Promise<{ selected: SelectedRef[]; fallbacks: string[]; dropped: SelectedRef[] }>

// image-caps.ts
export interface ImageCaps { supportsRefs: boolean; maxRefs: number; supportsNegativePrompt: boolean; notes: string[] }
export const DEFAULT_MAX_REFS = 4
export function capsForProvider(providerKey?: string, model?: string): { maxRefs: number; supportsNegativePrompt: boolean; notes: string[] }
export async function resolveImageCaps(providerKey?: string, model?: string): Promise<ImageCaps>
```

- [ ] **Step 1: entity-references.ts**

要点（全部变更走派生同步 + 实体版本记录）：

```ts
async function deriveSync(entityId: number): Promise<void> {
  // enabled 行按 base→state→view（优先级），同层按 id 升序 取 assetId 列表
  const order: Record<RefRole, number> = { base: 0, state: 1, view: 2 }
  // SELECT entity_references JOIN characters → 重算 refAssetIds；
  // 与现值 JSON 不等时才 UPDATE characters.refAssetIds + recordEntityVersion({ entityId, projectId: row.projectId, source: 'edit', label: `参考分层重算` })
}
```

- `addEntityRef` 校验链：实体存在（404）→ `role` ∈ REF_ROLES（400）→ 资产存在、`kind==='image'`、**归属兼容**（资产 projectId 为 NULL 全局，或等于实体 projectId；实体为全局行时资产必须全局——保证下游 assetToDataUri(assetId, run.projectId) 恒可解析）→ `role==='state'` 时 `stateKey` 非空且**精确等于**该实体 `states` JSON 数组某条目（400，报可核对文案）→ INSERT 唯一冲突捕获 `(UNIQUE constraint failed` → `EntityRefError(409)` → `deriveSync`。
- `patchEntityRef`：行存在（404）；改 role/stateKey 时重跑同款校验（states 取行所属实体）；`enabled` 布尔→0/1；随后 `deriveSync`。
- `removeEntityRef`：行存在（404）；DELETE 后 `deriveSync`。
- `backfillEntityRefs`：实体 refAssetIds 中未登记资产逐个 INSERT role='base'（按数组序），有插入才 `deriveSync`；返回 `{ added }`；重复调用 0 新增（幂等）。
- `loadRefIndex`：`WHERE entity_id IN (...) AND enabled=1`，映射 `EntityRefRow[]`（role 列类型断言回 RefRole）。
- `previewEntitySelection`：取实体行 + 全部 enabled 行，调 `selectEntityRefs(row, refRows, ctx, limit ?? MAX_REFS_PER_SHOT)`——纯读。

- [ ] **Step 2: image-caps.ts**

```ts
/**
 * 宿主侧图像模型参考图能力表。
 * supportsRefs 基础值来自 kit adapter.referenceImages（'none'|'base64'，kit 为外部依赖不可改）；
 * maxRefs/负向通道为宿主登记策略：登记表保守起步为空 → 全部走缺省 4，
 * 真实供应商上限按官方文档校准后逐条登记（探针只断言缺省与登记行为，不锁死供应商数值）。
 */
interface CapEntry { provider: RegExp; maxRefs: number; note: string }
const CAP_TABLE: CapEntry[] = []
// kit extra.negative_prompt 透传白名单（对齐 kit catalog/extra-params 实际行为：ComfyUI / Kling）
const NEGATIVE_PROMPT_PROVIDERS = ['comfy', 'kling']
```

`capsForProvider`：命中登记表 → 用登记值；未命中 → `{ maxRefs: DEFAULT_MAX_REFS, notes: ['未登记模型：参考图上限取保守缺省 4，实际以供应商文档为准'] }`；`supportsNegativePrompt` = providerKey 小写含白名单项。
`resolveImageCaps`：`try { const ep = await resolveEndpoint('image', providerKey); kitCap = getImageAdapter(ep.providerKey).referenceImages ?? 'none' } catch { kitCap = 'none' }`（providerKey 判定优先用入参、缺省用 ep.providerKey）→ `{ supportsRefs: kitCap === 'base64', ...capsForProvider(...) }`。

- [ ] **Step 3: style-preset.ts 透传 negative**

`resolveProjectStyleSnippets`（style-preset.ts:26-49）返回项加 `negative: string | null`；风格预设创建/更新端点与服务（搜索 `style_presets` 写入点，routes 层）接受可选 `negative` 字符串字段（trim 后存库，空串→null）。

- [ ] **Step 4: ai-image.ts 集成**

1) 三个实体索引建好后加载分层参考：

```ts
const refEntityIds = [...new Set([...charIndex.values(), ...sceneIndex.values(), ...propIndex.values()].map((r) => r.id))]
const refIndex = await loadRefIndex(refEntityIds)
```

（dialogue 分支三索引为空 → refIndex 自然为空 Map。）

2) 能力判定并入（保留既有 refCap 行与对白 throw/降级警告逻辑，ai-image.ts:138-150）：

```ts
const caps = await resolveImageCaps(provider, model)
const effectiveRefLimit = Math.min(MAX_REFS_PER_SHOT, caps.maxRefs)
if (caps.supportsRefs && caps.maxRefs < MAX_REFS_PER_SHOT) {
  ctx.log(`模型参考图上限 ${caps.maxRefs}（宿主总量 ${MAX_REFS_PER_SHOT} 内收紧），超出部分按分层优先级裁剪`)
}
```

3) 选择与快照（替换 :188-206 的收集与 paramsJson）：

```ts
const sel = collectRefSelection(shot, indexes, refIndex, { episode })
const refAssetIds = mergeRefIds(
  identityId !== undefined ? [identityId] : [],
  mergeRefIds(recipeRefImageIds(recipe, shot.id, IMAGE_REF_ROLES), sel.ids, effectiveRefLimit),
  effectiveRefLimit,
)
const refUsed = refCap === 'base64' && useRefs ? Math.min(refAssetIds.length, effectiveRefLimit) : 0
const paramsJson = JSON.stringify({
  size, shotId: shot.id, duration: shotDurationSec(shot) ?? null,
  refAssetIds, refUsed,
  caps: { supportsRefs: caps.supportsRefs, maxRefs: caps.maxRefs, supportsNegativePrompt: caps.supportsNegativePrompt, notes: caps.notes },
  refSelection: sel.perEntity,   // 逐实体 { entityId, name, refs: [{assetId, role, reason}] }——每镜参考分层语义可追溯
  ...(sel.dropped.length > 0 ? { refDropped: sel.dropped } : {}),
  output_purpose: purpose,
  stylePresetId: styleResolved[0]?.id ?? null,
  stylePresetIds: styleResolved.map((s) => s.id),
  entityIds: matchedEntityIds(shot, indexes),
})
```

:148 降级警告行的 `collectRefAssetIds(s, indexes)` 改为传 `refIndex` 与 `{ episode }`。runOneTask 的 `parsed.refAssetIds.slice(0, MAX_REFS_PER_SHOT)` 改为 `slice(0, Math.min(MAX_REFS_PER_SHOT, (parsed as { caps?: { maxRefs?: number } }).caps?.maxRefs ?? MAX_REFS_PER_SHOT))`，skipReason 保持现有两类；parsed 类型声明补 `caps?/refSelection?` 可选字段。

4) 风格负向注入（:134 `injectStyleAnchor` 之后）：

```ts
const styleNegatives = styleResolved.map((s) => s.negative).filter((x): x is string => !!x && x.trim().length > 0)
const refReadyShots = styleNegatives.length > 0
  ? finalShots.map((s) => ({ ...s, image_prompt: `${s.image_prompt.trim()}\n必须剔除：${styleNegatives.join('；')}` }))
  : finalShots
```

后续所有 `finalShots` 引用点改用 `refReadyShots`（对白一致性校验对 shots 的比较在前，不受影响；确认 :141-150 的 some() 检查同样换源）。有 negative 注入时 `ctx.log(`风格负向锚定注入 ${styleNegatives.length} 条`)`。

- [ ] **Step 5: 验证**

```bash
node .superpowers/sdd/M74-计划/safe-run.mjs server
node --import ./node_modules/tsx/dist/loader.mjs scripts/probe-m8.ts
node --import ./node_modules/tsx/dist/loader.mjs scripts/probe-m19.ts
node --import ./node_modules/tsx/dist/loader.mjs scripts/probe-m22.ts
node --import ./node_modules/tsx/dist/loader.mjs scripts/probe-m73.ts
```
Expected: 全部 exit 0；`wc -l ai-image.ts` ≤800。

- [ ] **Step 6: 报告**

---

### Task 4: 参考分层端点 + /image-caps

**Files:**
- Create: `apps/server/src/routes/entity-references.ts`
- Modify: `apps/server/src/app.ts`（qualityGatesRoutes 注册行之后 `api.route('/', entityReferencesRoutes)`）

**Interfaces:**
- Consumes: Task 3 `entity-references` 服务与 `EntityRefError`、`image-caps.resolveImageCaps`
- Produces: HTTP 契约（Task 6/7 消费）：

| 方法/路径 | 成功 | 错误 |
|---|---|---|
| GET /entities/:id/references | 200 `{ refs: EntityRefView[] , entity: { id, name, states: string[], refAssetIds: number[] } }`（entity 供前端状态下拉与旧数据判定） | 404 实体不存在 |
| POST /entities/:id/references | 201 ref 对象 | 400/404/409（EntityRefError.status 直通） |
| PATCH /entity-references/:id | 200 ref 对象 | 400/404/409 |
| DELETE /entity-references/:id | 200 `{ ok: true }` | 404 |
| POST /entities/:id/references/backfill | 200 `{ added }` | 404 |
| GET /entities/:id/selection-preview?scene=&episode=&text= | 200 `{ selected, fallbacks, dropped }` | 400（scene/episode 非整数）/404 |
| GET /image-caps?provider=&model= | 200 ImageCaps | —（无配置时 supportsRefs=false 保守返回） |

- [ ] **Step 1: 路由实现**

风格对齐 routes/quality-gates.ts（Hono `new Hono()`、`Number(param)` 校验正整数否则 400、`c.json({ error: msg }, status)`）。EntityRefError 统一 try/catch 转 status。`:id` 参数在两类前缀（/entities/:id/... 与 /entity-references/:id）分两个 `app.get/post` 组挂载（单 Hono 实例多段路径）。selection-preview 的 text 缺省空串。GET /image-caps 用 query 参数（`c.req.query('provider')`）。

- [ ] **Step 2: 验证**

```bash
node .superpowers/sdd/M74-计划/safe-run.mjs server
node --import ./node_modules/tsx/dist/loader.mjs scripts/probe-m73.ts  # app.ts 注册不破坏既有端点
```
Expected: exit 0。人工冒烟可留探针（Task 7）覆盖，不启真实服务。

- [ ] **Step 3: 报告**

---

### Task 5: consistency-eval 服务 + 端点 + final 阶段 checker

**Files:**
- Create: `apps/server/src/services/consistency-eval.ts`
- Modify: `apps/server/src/routes/quality-gates.ts`（+2 端点）
- Modify: `apps/server/src/services/stage-check.ts`（+checker）

**Interfaces:**
- Consumes: Task 1 `characterConsistencyResults`；Task 3 `listEntityRefs`；既有 `scoreConsistencyEval`（eval-service.ts:89，入参 Record、出参含 aggregate.overall.mean?——读 eval.ts `aggregateEvalMatrix` 实际返回结构确认组内 consistency 均分字段名）、`execInputs`/`genTasks`/`characters` 表、stage-check `QualityIssueInput`
- Produces:

```ts
// consistency-eval.ts
export interface EntityEvalSummary { entityId: number; name: string; score: number | null; assetTotal: number; assetSampled: number; refCount: number; note: string | null }
export async function runConsistencyEval(runId: number): Promise<{ runId: number; results: EntityEvalSummary[] }>
```

- [ ] **Step 1: runConsistencyEval**

```ts
// 1. run 存在性 → 调用方（路由）404；此处假定存在
// 2. 出镜实体：SELECT DISTINCT entity_id FROM exec_inputs WHERE run_id=? AND src_kind='entity' AND version_id IS NOT NULL
//    （列名以 schema.ts exec_inputs 实际定义为准：eval-quality.ts:197-240 已有同款查询，抄其谓词）
// 3. 每实体出图集：本 run gen_tasks（kind='image'、status='succeeded'、result_asset_id NOT NULL）
//    在 JS 侧按 params.entityIds 包含 entityId 过滤；按 completedAt 降序取 ≤24 张（ASSETS_MAX 对齐 eval-service 上限）
//    实体不在任何 task → assetTotal=0 → score=null, note='本 run 无该角色出图'
// 4. 参考图：listEntityRefs → enabled role='base' 的 assetId；无登记行 → characters.refAssetIds 前 4 张；
//    两路径均先按 assets 归属过滤（projectId ∈ {NULL, run.projectId} 且 kind='image'，剔除历史跨项目脏数据）；
//    过滤后为空 → score=null, note='无基准参考图，无法评价跨镜一致性'
// 5. 评分调用：scoreConsistencyEval({ project_id, groups: [{ label: row.name, asset_ids: sampled }], reference_asset_ids: refIds })
//    try/catch：EvalParamError / LlmNotConfiguredError / 网络异常 → score=null, note=`评分失败：${msg.slice(0,160)}`（不产假分）
//    成功但 parsed=false（LLM 输出不可解析）→ score=null, note='评分输出不可解析，见评测报告'
//    consistency 均分取该组 matrix 行的 consistency 均值（0–10，一位小数）
// 6. 每实体 upsert characterConsistencyResults（onConflictDoUpdate target [runId, entityId]），evaluatedAt=Date.now()
// 7. 返回汇总；单实体串行调用（评分自带逐次用量记录，不并发）
```

- [ ] **Step 2: 路由（quality-gates.ts 追加）**

- `POST /runs/:id/consistency-eval`：run 404 校验；调 runConsistencyEval；200 `{ runId, results }`。**注意**：真实模型调用在用户环境发生，探针以 stub fetch 走本端点（同 m40 桩形态）。
- `GET /runs/:id/character-consistency`：结果表 LEFT JOIN characters → 每实体行 + `issues` 聚合（quality_issues WHERE run_id AND checker='character.consistency' AND target_type='entity' AND target_id=String(entityId) → count + severities 数组）；200 `{ runId, entities: [...] }`。无 LLM、无副作用。

- [ ] **Step 3: stage-check.ts checker**

```ts
/**
 * Final → character.consistency
 *
 * Reads persisted per-character consistency results (written by the
 * consistency-eval service; this checker never calls a model). Absence of
 * any evaluation is reported as an info issue — a result that was never
 * measured must not read as a pass.
 */
async function checkCharacterConsistency(runId, episodeIdx): Promise<QualityIssueInput[]> {
  const rows = await db.select({ /* + entityName via join characters */ }).from(characterConsistencyResults).where(eq(...runId, runId))
  if (rows.length === 0) return [{ runId, episodeIdx, stage: 'final', checker: 'character.consistency', dimension: 'consistency', severity: 'info', checkType: 'deterministic', evidence: { reason: 'not_evaluated' }, suggestion: '角色一致性评价未运行，结果待人工确认；可在运行详情发起评价后复检。' }]
  const issues: QualityIssueInput[] = []
  for (const r of rows) {
    const base = { runId, episodeIdx, stage: 'final' as const, checker: 'character.consistency', dimension: 'consistency', checkType: 'subjective' as const, targetType: 'entity', targetId: String(r.entityId) }
    if (r.score === null) { issues.push({ ...base, severity: 'info', evidence: { entityId: r.entityId, entityName: r.entityName, note: r.note }, suggestion: `角色「${r.entityName}」无法评价（${r.note ?? '原因未记录'}），补参考图或重试评价后复检。` }); continue }
    const norm = Math.round((r.score / 10) * 100) / 100
    if (norm < 0.5) issues.push({ ...base, severity: 'blocking', evidence: { entityId, entityName, score: r.score, normalized: norm, assetTotal, assetSampled }, suggestion: `角色「${r.entityName}」跨镜一致性 ${r.score}/10（低于 5），建议核对分层参考绑定并重生成偏离镜头。` })
    else if (norm < 0.7) issues.push({ ...base, severity: 'warning', evidence: { ...同上 }, suggestion: `角色「${r.entityName}」跨镜一致性 ${r.score}/10（低于 7），建议人工抽查离群镜头。` })
  }
  return issues
}
```

CHECKERS 数组 final 段追加注册项 `{ stage: 'final', name: 'character.consistency', dimension: 'consistency', severity: 'warning', checkType: 'subjective', check: checkCharacterConsistency }`（severity 为登记描述值，实际问题严重度逐条动态）。import characterConsistencyResults、characters（若未 import）。

- [ ] **Step 4: 验证**

```bash
node .superpowers/sdd/M74-计划/safe-run.mjs server
node --import ./node_modules/tsx/dist/loader.mjs scripts/probe-m73.ts
```
Expected: exit 0；probe-m73 的 final 阶段断言不受新 checker 影响（无结果行 → info issue，不改变 pass/fail 数学）。若 m73 断言按问题总数严格计数，则更新其断言并在报告中标注原因。

- [ ] **Step 5: 报告**

---

### Task 6: 前端（参考分层管理 + 一致性卡片 + 能力提示 + 风格负向）

**Files:**
- Create: `apps/web/src/lib/api/entityRefs.ts`（或并入现有实体 api 客户端——先读 lib/api/ 目录既有组织，跟随现状）
- Modify: `apps/web/src/lib/api/runs.ts`（+consistency 两端点）
- Create: `apps/web/src/components/project/EntityRefsPanel.vue`
- Modify: `apps/web/src/views/project-detail/AssetsPanel.vue`（实体编辑区挂载 EntityRefsPanel）
- Create: `apps/web/src/components/run/CharacterConsistencyPanel.vue`
- Modify: `apps/web/src/views/run-detail/index.vue`（QualityGatePanel 之后挂载）
- Modify: `apps/web/src/views/style-presets/index.vue`（negative 输入）

**Interfaces:**
- Consumes: Task 4/5 HTTP 契约（端点表见 Task 4 Interfaces；character-consistency 返回 `{ runId, entities: [{ entityId, name, score, assetTotal, assetSampled, refCount, note, issues: { count, severities } }] }`）
- Produces: 无下游代码任务消费（探针走 HTTP 直连 server，不经 web）

- [ ] **Step 1: api 客户端**

```ts
// entityRefs.ts
export const entityRefsApi = {
  list: (id: number) => request<{ refs: EntityRefView[]; entity: { id: number; name: string; states: string[]; refAssetIds: number[] } }>(`/entities/${id}/references`),
  add: (id: number, body: { assetId: number; role: string; stateKey?: string; viewKey?: string; note?: string }) => request<EntityRefView>(`/entities/${id}/references`, { method: 'POST', body: JSON.stringify(body) }),
  patch: (refId: number, body: Record<string, unknown>) => request<EntityRefView>(`/entity-references/${refId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (refId: number) => request<{ ok: boolean }>(`/entity-references/${refId}`, { method: 'DELETE' }),
  backfill: (id: number) => request<{ added: number }>(`/entities/${id}/references/backfill`, { method: 'POST' }),
  preview: (id: number, q: { scene?: number; episode?: number; text?: string }) => request<{ selected: unknown[]; fallbacks: string[]; dropped: unknown[] }>(`/entities/${id}/selection-preview?${new URLSearchParams(...)}`),
}
export const imageCapsApi = { get: (provider?: string, model?: string) => request<ImageCaps>(`/image-caps?${...}`) }
// runs.ts 追加（qualityGatesApi 同文件）
// triggerConsistencyEval: (runId) => POST /runs/:id/consistency-eval
// getCharacterConsistency: (runId) => GET /runs/:id/character-consistency
```

request 封装、错误抛出形态跟随 lib/api 现状（读 runs.ts 现有实现照抄模式）。

- [ ] **Step 2: EntityRefsPanel.vue**

props `{ entityId: number; entityName: string; states: string[]; projectId: number }`。挂载时 `backfill` 一次（幂等）→ `list` + `imageCapsApi.get()`。结构：
- 能力提示条：`supportsRefs` 否 → 警示文案「当前图像模型不支持参考图，角色一致性仅靠文本锚定」；是 → 「参考图上限 {maxRefs}」+ notes 次行展示。
- 三组分区（基准/状态变体/多视角）列表：缩略图（沿用 AssetsPanel 现成的资产缩略展示方式）、role 徽章、stateKey/viewKey、启用开关、note、删除按钮。
- 添加行：资产选择（从该项目 reference_* 资产下拉——复用面板现有数据源；无则手输 assetId 数字输入）+ role 下拉 + stateKey 下拉（仅 role=state 显示；选项 = props.states）+ viewKey 文本 + note。
- 「选择预览」区：输入场次/集/文本 → preview 返回 selected/fallbacks/dropped 三列展示（reason 原文可见——回退与裁剪必须显式呈现）。
- 标签页用全局 `.tabs/.tab`，弹层复用 `common/Modal.vue`（既有原语纪律，禁新造浮层）。

- [ ] **Step 3: run-detail 一致性卡片**

CharacterConsistencyPanel.vue：props `{ runId: number }`；加载 `getCharacterConsistency`；每实体一行：角色名、score（NULL→「无法评价」+ note）、`assetSampled/assetTotal` 覆盖标注、refCount、问题徽章数（severities 分布）；顶部「运行评价」按钮（POST 后重载，pending 态 + 明确提示「将调用多模态评分，产生供应商费用」）；空态「尚未运行评价；门禁将显示待人工确认」。样式对齐 QualityGatePanel.vue 卡片体系（读该文件抄类名与令牌用法）。

- [ ] **Step 4: 风格预设 negative**

views/style-presets/index.vue 编辑表单在 snippet 字段后加「负向约束」textarea（placeholder：生成时以「必须剔除：」锚点注入；英文逗号分隔词块），提交字段 `negative`。

- [ ] **Step 5: 验证**

```bash
node .superpowers/sdd/M74-计划/safe-run.mjs web
node .superpowers/sdd/M74-计划/safe-run.mjs format
```
Expected: vue-tsc exit 0；prettier --check src exit 0。

- [ ] **Step 6: 报告**

---

### Task 7: probe-m74 探针（六节）

**Files:**
- Create: `apps/server/scripts/probe-m74.ts`（入口，结构逐字对照 probe-m73.ts）
- Create: `apps/server/scripts/probes/m74/bootstrap.ts`（隔离环境 + 迁移应用 + 建表断言 + seed）
- Create: `apps/server/scripts/probes/m74/selection.ts`
- Create: `apps/server/scripts/probes/m74/caps.ts`
- Create: `apps/server/scripts/probes/m74/service.ts`
- Create: `apps/server/scripts/probes/m74/consistency.ts`
- Create: `apps/server/scripts/probes/m74/endpoints.ts`

**Interfaces:**
- Consumes: probe-lib `isolatedEnv('m74')/makeChecker/runSections`；全部前序任务产物；probe-m40.ts 的 fetch stub 模式（stubReply/llmReply/origFetch 还原）
- Produces: `node --import ./node_modules/tsx/dist/loader.mjs scripts/probe-m74.ts` 全绿；run-probes.ts 若为显式清单则追加条目（先读其扫描逻辑）

- [ ] **Step 1: bootstrap**

照抄 probes/m73/bootstrap.ts 骨架：isolatedEnv('m74')、fetch 默认禁真实外发、`git ls-files` 复制 drizzle/templates/prompts + 显式补 `apps/server/drizzle/0007_m74_character_consistency.sql`、migrate → 断言 `entity_references`、`character_consistency_results` 表存在 + `PRAGMA table_info(style_presets)` 含 `negative` 列。
seed（尽量走真实服务，DB 直插仅限无服务形态的骨架行）：1 project；1 pipeline_run；角色A（states 含「第1场：受伤」）与角色B（无 states）经 `upsertEntity` 创建；每角色 2-3 张 image 资产（**真实落盘小 PNG**：先 grep 服务层资产写入通道——uploads/entity-refgen 所用的同一函数——探针内直接调用，确保 assetToDataUri 可读）；`attachRefAssetsById` 挂 refAssetIds；`entityRefs.addEntityRef` 登记角色A 的 base/state/view 行；gen_tasks 数行（succeeded、params 含 `{ shotId, entityIds, resultAssetId }`）；`recordExecSnapshot` 真实写入 srcKind='entity' 输入行。
导出 `getSeededRunId()`、`getSeededEntityIds()`、`cleanup()`。

- [ ] **Step 2: selection 节（纯函数矩阵）**

1. 隐式基准：refRows=[] → refAssetIds 全 base、数组序不变、超 limit 进 dropped；
2. 状态命中优先：分层行 state(stateKey=「第1场：受伤」)+base+view，ctx.scene=1 → selected 首元素 role='state'、reason 含命中条目原文；
3. 回退：states 命中但无匹配 stateKey 行 → fallbacks 含「回退基准」且 selected 全 base/view；
4. 多条命中取最后：states 两条均命中 ctx → 后条目为命中（时间序语义）；
5. enabled=0 行不参与；limit=0 → 全 dropped；
6. collectRefSelection：画布直通前插；跨角色共享 4 名额（角色1 满 4 → 角色2 行进 dropped）；总量 ≤6；
7. collectRefAssetIds(shot, indexes, refIndex, stateCtx) 与 collectRefSelection(...).ids 逐元素相等。

- [ ] **Step 3: caps 节**

1. capsForProvider 未登记 → maxRefs=4 且 notes 含「保守缺省」；provider 含 'comfy'/'kling' → supportsNegativePrompt true，其余 false；
2. resolveImageCaps 在探针环境（无端点配置）→ supportsRefs=false 且不抛错；
3. 供应商真实上限不锁死（注释说明边界：登记表保守起步）。

- [ ] **Step 4: service 节**

entity-references 服务真实 DB：add→list→patch(改 role/启停)→remove→每步后 characters.refAssetIds 断言 base→state→view 序；stateKey 非该实体 states 条目 → EntityRefError 400；重复 (entity,asset) → 409；实体不存在 → 404；backfill 幂等（第二次 added=0、行 role='base'）；loadRefIndex 只含 enabled；previewEntitySelection 纯读不改库（前后 refAssetIds 逐字节相等）。

- [ ] **Step 5: consistency 节（stub LLM 走真实链路）**

```ts
process.env.AGENT_LLM_BASE_URL = 'http://127.0.0.1:9/acs-m74-stub'
process.env.AGENT_LLM_API_KEY = 'stub-key'
const scoresBody = (ids: number[], val: number) => JSON.stringify({ scores: ids.map((asset_id) => ({ asset_id, consistency: val, style: val, quality: val, note: 'stub' })) })
// fetch 桩形态照抄 probe-m40（stubReply 可变 + llmReply 包壳 + try/finally 还原 origFetch）
```

断言：`runConsistencyEval(runId)` 后结果表每实体一行、score=8.0、refCount=该角色 base 数、重评覆盖不增行；角色无 base 参考（临时 disable 全部）→ score=null、note 含「无基准参考」；stub 返回不可解析文本 → score=null、note 含「不可解析」；随后 `runStage(runId, 0, 'final')`：8.0 分不落 consistency issue；重评 stub 改 4.0 → blocking issue 且 final 门禁 fail；另 seed 第二 run（不评价）→ 评价未运行 info issue、门禁不因此 fail（info 不参与 blocking 计数）。

- [ ] **Step 6: endpoints 节（真实产品路径）**

`app.request`：GET refs（entity.states 可见）→ POST refs 201 / stateKey 非法 400 / 重复 409 / 实体不存在 404 → PATCH 启停后 GET 序变化 → DELETE → backfill → preview（scene=1 → selected[0].role='state'、fallbacks 可见）→ GET image-caps → POST /runs/:id/consistency-eval（stub 同 service 节，另 run 不存在 404）→ GET character-consistency（issueCount/severities）→ POST /runs/:id/quality-gates（M73 端点触发全阶段）→ final 门禁含 4.0 分 blocking → 走 M73 exempt 端点豁免 → reevaluateGate 后状态 exempt。

- [ ] **Step 7: 入口与全绿**

probe-m74.ts 入口照抄 probe-m73.ts：sections ['selection','caps','service','consistency','endpoints']（storage 建表断言并入 bootstrap）。

```bash
node .superpowers/sdd/M74-计划/safe-run.mjs probe
node .superpowers/sdd/M74-计划/safe-run.mjs server
```
Expected: probe exit 0（FAIL=0）；tsc exit 0。

- [ ] **Step 8: 报告**（断言计数 + stub 未外发证明）

---

### Task 8: 联调与文档

**Files:**
- Modify: `docs/records/路线图-roadmap.md`（M74 节，格式随 M73 节）
- Modify: `docs/records/备选清单-post-M27-backlog.md`（R04 行标注已交付，格式随 R05 现状）
- Modify: `docs/records/M74-角色一致性工程化-design.md`（状态：已交付）
- Verify: `.superpowers/sdd/M74-计划/safe-run.mjs`

- [ ] **Step 1: 全量回归**

```bash
node .superpowers/sdd/M74-计划/safe-run.mjs server
node .superpowers/sdd/M74-计划/safe-run.mjs web
node .superpowers/sdd/M74-计划/safe-run.mjs probe
node .superpowers/sdd/M74-计划/safe-run.mjs format
```
（后两条 cwd 分别 apps/server / apps/web，safe-run 内部已处理。）

```bash
node --import ./node_modules/tsx/dist/loader.mjs scripts/check-comment-pointers.ts
node --import ./node_modules/tsx/dist/loader.mjs scripts/run-probes.ts
```
（最后两条 cwd=apps/server。）
Expected: 全部 exit 0；全量探针无 FAIL；注释门禁 0 违规。

- [ ] **Step 2: 文档回写 + 收官报告**

roadmap M74 节（交付表 + 验收结论 + 后续去向）；backlog R04 标注；design 文档状态改「已交付」；不 commit。

---

## 执行顺序与依赖

T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 严格串行。理由：T2 纯函数是 T3 集成地基；T3 服务先于 T4 路由；T5 消费 T1 表与 T3 服务；T6 消费 T4/T5 契约；T7 依赖全部端点定型；T8 收口。

## 风险登记

1. exec_inputs 列名/谓词 → T5 以 eval-quality.ts 既有查询为准，禁猜。
2. aggregateEvalMatrix 组内均分字段名 → T5 先读 eval.ts 再取值。
3. ai-image.ts 行数余量小 → 超 800 时压缩注释/抽函数到 ref-selection，不拆主流程语义。
4. 探针 seed 资产必须走真实写入服务（禁手写文件绕过产品路径）。
5. M73 final 断言若严格计数问题行 → 更新断言并在报告标注。
6. chatCompleteDetailed 多模态 messages 的 stub 需按 kit openai-compatible 请求体形态回放；probe-m40 的 llmReply 包壳可直接复用，若响应壳字段不同（usage 等）以 eval-service recordLlmUsage 容忍形态为准。

