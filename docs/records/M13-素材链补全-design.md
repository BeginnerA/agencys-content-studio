# M13 设计：素材链补全（视觉提取 / 多预设叠加 / 视频参考图 / 上传通道 / 批量润色 / states 入库）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

> 里程碑：M13（2026-09-12 立项）｜上游：M8 素材库（§1.3 排除表六项 → roadmap L157「素材链扩展候选」）· M10 上传通道先例 · M12（组1 收尾）｜下游：组3（BGM 音效 / 集级参数 / 桌面端 / 剧集实体等）
> 性质：组2「素材链补全」批次——六项一次交付：①从参考图提取风格词（需视觉 LLM）②风格预设多选组合叠加 ③视频侧场景/道具参考图注入 ④素材参考图上传通道 ⑤素材页批量润色交互 ⑥states 变体入库。
> 对标（2026-09-12 源码核实）：
> - **Toonflow**：`extractStylePrompt.ts`（`messages[].content` 为 `{type:'image'}` 数组 + system 格式令「(画风：中文,english)」多图综合）→ ① 的对标来源；`polishAssetsPrompt.ts` / `batchPolishAssetsPrompt.ts`（视觉手册 system + 素材名/描述 user → 回写 prompt；批量 = 并发 + 后台异步）→ ⑤ 语义来源；项目级 artStyle 绑定单值 → ② 在本仓扩为多选叠加（超集）。
> - **huobao**：三人视/场景/道具库 + 图像提示词生成链（M8 已对齐）；「提取/多预设/润色」0 命中，无直接对标。
> - **本仓落法**：①LLM 通道 `content` 类型放宽为多模态（OpenAI 兼容 `image_url`）→ 提取端点预填创建表单（**不落库**，用户确认后保存）；②settings 新键 `style_preset_ids`（旧 `style_preset_id` 兼容回退）→ 运行时拼接注入；③三家视频适配器**已原生支持** `reference_image`（M6 搬运即可）→ 只补收集/注入/能力位，**首帧优先**决策规避 Wan 帧/参考互斥硬校验；④镜像 M10 上传模式（multipart → `importFiles` → `attachRefAssets`）；⑤逐项串行 LLM 润色 appearance（上限 10 项，失败不阻断）；⑥`characters` + `states` 列（幂等迁移，M8 `kind` 加列先例）打通 char_profile → normalizeSpec → 入库 → Web 展示全链。

---

## 1. 定位与边界

### 1.1 一句话目标

素材链从「可用」到「好用」：参考图可反向提取画风词一键成预设；一个项目可叠挂多个风格预设（出图逐字拼接、快照溯源）；视频首帧缺位时场景/道具参考图可注入（首帧优先、多厂商通道就绪）；素材页可就地传参考图、可多选批量润色档案、可查看与编辑角色状态变体（states）。

### 1.2 现状与缺口（代码证据，2026-09-12 核实）

| 要素 | 现状 | M13 动作 |
|---|---|---|
| `services/llm.ts` ChatMessage.content | ✗ 硬类型 `string`（多模态不可达） | 放宽为 `string \| ChatContentPart[]` |
| `assetToDataUri`（services/asset-ref.ts） | ✓ 8MB 上限 + 缓存 | 复用（提取 / 视频参考图） |
| 视觉提取端点 / 提示词 | ✗ 全缺（Toonflow 有对标） | 新增 `POST /style-presets/extract` + `style-extract.md` |
| settings 风格绑定 | ✓ 单值 `style_preset_id`（resolveProjectStyleSnippet） | 扩数组 `style_preset_ids` + 旧键回退 |
| `injectStyleAnchor` | ✓ 单 snippet 生效（M8 探针锁定签名） | 保留签名；前置 `combineStyleSnippets` 拼接 |
| 视频适配器 reference_image 通道 | ✓ 三家已支持（volcengine ≤9 / minimax ≤9 / aliyun-wan ≤10，经 `extra.referenceImageUrls`） | 仅补能力位 + 收集 + 注入 |
| ai_video 参考图收集 | ✗ 无（仅 first_frame） | ShotSpec +location/props；collectSetRefAssetIds；首帧优先 |
| Wan 帧/参考互斥 | ✓ `validateMedia` 硬校验（抛错） | 首帧优先决策天然规避 |
| 素材参考图上传 | ✗ 仅「从项目资产挑图」 | `POST /entities/:id/ref-images`（multipart） |
| 批量润色 | ✗ 全缺（Toonflow 有对标） | `POST /entities/polish` + `entity-polish.md` |
| characters.states 列 | ✗ 无列；normalizeSpec 丢弃 states | 加列（迁移）+ 全链打通 |
| `db/index.ts` 幂等迁移 | ✓ ALTER TABLE 模式（L52-95，L95 kind 先例） | 追加一行 |
| `importFiles`（services/storage.ts） | ✓ sha256 去重 + purpose 落盘 | 复用（上传参考图） |

### 1.3 排除（本里程碑不做）

- **提取结果自动落库**：提取端点只返回 snippet 预填表单（用户确认后走既有 POST /style-presets）；不自动建预设（避免 LLM 幻觉词污染预设库）。
- **预设级联删除保护**：删除/停用预设的绑定残留仍走「运行时宽容降级」（M8 语义），不加引用计数。
- **视频侧角色参考图**：角色一致性由首帧承载（M6 语义）；本批只做场景/道具（批次定义即此）。
- **视频侧场景/道具文本锚定注入**：只注入参考图（图在 prompt 不动），motion_prompt 由分镜/剧本承担。
- **状态变体的运行时注入（变体出图）**：states 本批只做入库 + 展示 + 编辑；出图按变体命中（如「第5场受伤」自动注入绷带描述）留后续批次。
- **润色的版本历史 / 撤销**：只更新 appearance 字段（旧值不存档）；失败项不动。
- **素材页全量多选批量操作**：多选仅服务批量润色（不做批量删除/批量改归属）。
- **多模态历史消息**：ChatMessage 放宽仅支持单轮 user 携带图片；assistant 历史仍为纯文本。

---

## 2. 语义与契约

### 2.1 ① 视觉提取（从参考图提取风格词）

- **输入**：项目资产中的图片（1..4 张，同一视觉基调）；`assetToDataUri` 转 data URI（8MB/张上限沿用）。
- **提示词**（`workspace/prompts/style-extract.md`，system）：对齐 Toonflow 语义——要求输出**单行**「(画风：中文描述,english prompt)」格式；多图输出综合共同风格；风格无法描述时输出「无法描述」；除画风词外不输出任何内容。
- **调用**：`chatCompleteDetailed([{role:'system',...},{role:'user',content:[{type:'text',...},...images]}], undefined, { temperature: 0.3, maxTokens: 400 })`。
- **解析**（`extractSnippetFromText`，导出供探针）：
  1. 剥 markdown 围栏与首尾空白；
  2. 命中正则 `/[（(]\s*画风[：:]\s*([^）)\n]+)[）)]/` → 取括号内文本，规范化回「（画风：{内容}）」；
  3. 未命中 → 全文 trim（宽容回退）；
  4. 长度 cap 400 字符（超出截断）。
- **用量**：`recordLlmUsage({ projectId, runId: null, provider, model, usage })`（非 run 来源，runId 可空为既有语义）。
- **不落库**：响应返回 snippet，由前端预填「新建预设」表单。

### 2.2 ② 风格预设多选组合叠加

- **settings 契约**：新键 `style_preset_ids: number[]`（有序去重，叠加顺序 = 数组顺序）；旧键 `style_preset_id: number` 保留兼容（读取回退：无新键时视为 `[旧值]`）。
- **解析**（`services/style-preset.ts`）：
  - `stylePresetIdsOf(settingsJson): number[]`——优先数组键；回退单值键；整数 >0 过滤 + 去重保序；坏 JSON → 空。
  - `resolveProjectStyleSnippets(projectId): Promise<Array<{id,name,snippet}>>`——按 ids 顺序解析，跳过已删除行；跳过 `isActive=0`（宽容降级不变）。
  - `combineStyleSnippets(snippets: string[]): string | null`——trim 过滤空 → `join('；')` → 全空返回 null。
  - 旧单数 `resolveProjectStyleSnippet` 保留：返回复数结果第一个（M8 探针与存量调用零改动）。
- **注入**（ai_image，签名不破）：`injectStyleAnchor(shots, combineStyleSnippets(snippets))`——单条行为与 M8 逐字等价（「视觉风格：{snippet}」），多条为「视觉风格：A；B」。
- **快照**：`gen_tasks.params` 双写 `stylePresetIds: number[]`（全量）+ `stylePresetId: number|null`（第一个，兼容旧读取）。
- **Web 绑定**：项目编辑弹窗改为 checkbox 多选（按预设库 sortOrder 展示启用项）；保存写 `style_preset_ids`（无勾选 → null）并显式 `style_preset_id: null` 清理旧键。

### 2.3 ③ 视频侧场景/道具参考图注入

- **能力位**：`VideoAdapter.referenceImages?: 'none' | 'base64'`（缺省 'none'）；volcengine / minimax / aliyun-wan 标 `'base64'`（三家 generate 已读 `extra.referenceImageUrls` 并按 `role:'reference_image'` 下发，M6 搬运即用）。
- **收集**（`collectSetRefAssetIds(shot, sceneIndex, propIndex): number[]`，导出）：
  - 场景：`shot.location` 命中场景库行 → 取 `refAssetIds[0]`（≤1）；
  - 道具：`shot.props[]` 按序首个命中道具库行 → 取 `refAssetIds[0]`（≤1）；
  - 保序去重，总量 ≤2（镜像 ai_image 的场景/道具段；角色参考图不参与）。
- **首帧优先决策**（`planVideoRefs({ hasFirstFrame, setRefIds, refCap })`，导出纯函数）：
  | 条件 | 决策 | reason |
  |---|---|---|
  | `refCap === 'none'` 或 setRefIds 空 | 不注入 | `no_cap` / `none` |
  | 有首帧图且 setRefIds 非空 | 不注入（首帧已承载一致性） | `frame_first` |
  | 无首帧图且 setRefIds 非空 | 注入全部 | `ok` |
  - 首帧优先为**产品决策**：规避 aliyun-wan「帧与 reference 互斥」硬校验，且行为跨厂商可预期。
- **注入**：`runOneTask` 内逐个 `assetToDataUri`（step 级 uriCache 复用）→ `buildVideoRequest({ ..., extra: { referenceImageUrls } })`；单图失败跳过 + 日志（与首帧同容错口径）。
- **快照**：`gen_tasks.params` + `setRefAssetIds: number[]`（收集结果，入队时固化）。
- **日志**：`场景/道具参考图注入 N 镜`；降级各分支一次/step 说明。

### 2.4 ④ 素材参考图上传通道

- **端点**：`POST /entities/:id/ref-images`（multipart：`file`）——镜像 M10 shots upload 解析模式（`c.req.formData()`）。
- **校验**：实体存在；`projectId === null`（全局库）→ 400（全局实体不接受项目资产引用，与 PUT 语义一致）；扩展名推断 kind 非 image → 400；文件 >10MB → 413；空文件 → 400。
- **流程**：`importFiles(projectId, [file], { purpose: \`reference_${kind}\` })`（sha256 命中复用原行，不重复落盘）→ `attachRefAssets(projectId, name, [assetId], kind)`（并集去重）→ 返回 `{ entity, asset }`（entity 为挂接后最新视图，前端据此刷新挑图器）。
- **Web**：素材页表单挑图区 +「上传新图」按钮（编辑态可用；新建态先保存再上传）；上传成功 → `form.refIds` 同步最新 `refAssetIds` + 资产候选刷新。

### 2.5 ⑤ 素材页批量润色

- **语义**：对所选实体的 `appearance` 做 LLM 润色规范化（补视觉指纹、短语化、统一语感），**只更新 appearance**；summary/negative/voice 不动。
- **提示词**（`workspace/prompts/entity-polish.md`，system）：素材档案润色师；输入 JSON（kind/name/aliases/appearance/summary/negative）；输出仅润色后的 appearance **单段纯文本**（无前缀、无 markdown、无引号）；保持事实不变、禁止虚构（不得新增未描述的服装/道具/剧情）。
- **调用**：逐项串行（`temperature 0.5 / maxTokens 800 / timeoutMs 60s`）；上限 10 项/次。
- **更新**：解析输出非空 → `UPDATE characters SET appearance`；解析为空/调用失败 → 该项进 failed（不改字段，其余项继续）。
- **用量**：`recordLlmUsage`（projectId = 行所属项目；全局实体 projectId 为空 → 跳过记录）。
- **响应**：`{ ok: true, polished: [{id, name, appearance}], failed: [{id, error}] }`。

### 2.6 ⑥ states 变体入库

- **形态**（char-profile.md v2 既有定义，L22）：`string[]`，每条「{剧情节点}：{状态短语}」（如「第5场受伤：额头绷带」）。
- **存储**：`characters` + `states` 列（text，JSON 数组，`NOT NULL DEFAULT '[]'`）；幂等迁移一行。
- **写链**：
  - `character-sync`（pipeline）：`normalizeSpec` 保留 `states`（字符串数组过滤 trim 非空）→ `upsertEntity({... states })`；
  - `upsertEntity`：更新分支非空数组**覆盖**（内容字段语义，与 appearance 同口径，纠错需覆盖）；创建时写入（缺省 `[]`）。
  - `PUT /entities/:id`：`states` 数组（含空数组，空 = 清空）→ 替换。
- **读链**：`toEntityView` + `states: string[]`（坏 JSON → []，与 aliases 同容错）。
- **Web**：角色 Tab 表单 +「状态变体 states」textarea（每行一条）；卡片 chips 展示（前 2 条 + 「+N」）；scene/prop 不涉及。
- **边界**：仅入库/展示/编辑；出图注入留后续。

### 2.7 端点契约

```
POST /style-presets/extract        （挂 routes/style-presets.ts）
body: { project_id: number, asset_ids: number[] }   // 1..4 张图片，须属该项目
200: { snippet, provider, model }
   // LLM 未配置/未配视觉模型 → 400（message 含配置指引）

POST /entities/polish              （挂 routes/characters.ts；注册于 :id 参数路由之前）
body: { ids: number[] }            // 1..10，去重
200: { ok: true, polished: [{id, name, appearance}], failed: [{id, error}] }

POST /entities/:id/ref-images      （挂 routes/characters.ts；multipart: file）
201: { entity, asset }
   // 全局实体 → 400；非图片 → 400；>10MB → 413
```

---

## 3. 服务端设计

### 3.1 services/llm.ts（类型放宽）

- `export type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }`；
- `ChatMessage.content: string | ChatContentPart[]`（请求体 messages 直通，其余零改动；`chatComplete`/`chatCompleteDetailed` 签名不变）。

### 3.2 services/style-preset.ts（② + ① 扩展）

- `stylePresetIdsOf(settingsJson: string | null): number[]`（§2.2）；
- `resolveProjectStyleSnippets(projectId): Promise<Array<{id;name;snippet}>>`；旧单数函数改为薄封装（取首个）；
- `combineStyleSnippets(snippets: string[]): string | null`；
- `extractSnippetFromText(raw: string): string`（剥离围栏 + 画风格式提取 + cap 400）；
- `extractStyleSnippetFromAssets(projectId, assetIds): Promise<{ snippet; provider; model }>`：
  校验资产（`assertProjectAssets` + 逐行 kind=image/relPath）→ data URI（≤4 张）→ system=loadPromptTemplate('style-extract.md') + user 多模态 → `chatCompleteDetailed` → 解析 → `recordLlmUsage`。

### 3.3 pipeline/actions/ai-image.ts（② 注入点）

- `resolveProjectStyleSnippet` 调用 → `resolveProjectStyleSnippets`；`injectStyleAnchor(setShots, combineStyleSnippets(...))`；日志列全名（`A + B（预设 #1,#3）`）；
- params 快照 + `stylePresetIds`（兼容保留 `stylePresetId`=首个）。

### 3.4 adapters/types.ts + 三家视频适配器（③ 能力位）

- `VideoAdapter` + `referenceImages?: 'none' | 'base64'`；
- VolcEngineVideoAdapter / MiniMaxVideoAdapter / AliyunWanVideoAdapter 加类字段 `referenceImages = 'base64'`。

### 3.5 pipeline/actions/ai-video.ts（③）

- `ShotSpec` + `location?: string` + `props?: string[]`；
- `import { loadEntityIndex } from '../../services/character'`；入队前加载 scene/prop 索引；
- `collectSetRefAssetIds` / `planVideoRefs`（导出纯函数，§2.3）；
- `videoReferenceCapability(provider)`（镜像 `videoFirstFrameCapability`，失败 → 'none'）；
- 入队 paramsJson + `setRefAssetIds`；`runOneTask` cfg 传入 `refCap`，执行时按 plan 注入 `extra.referenceImageUrls`（首帧已用 → 跳过 + 日志）。

### 3.6 services/character.ts + character-sync.ts（⑥）

- `upsertEntity` 参数 + `states?: string[]`（更新非空覆盖 / 创建写入）；`upsertCharacter` 旧签名 + 可选 states；
- `character-sync.ts`：`CharacterSpec` + `states?: string[]`；`normalizeSpec` 保留 states（**改 export** 供探针）；`upsertCharacter` 调用透传。

### 3.7 db 层（⑥）

- `schema.ts`：characters + `states: text('states').notNull().default('[]')`；
- `db/index.ts`：迁移追加 `ALTER TABLE characters ADD COLUMN states text NOT NULL DEFAULT '[]'`（位于 kind 先例之后，同款 try/catch 幂等）。

### 3.8 services/entity-polish.ts（新，⑤）

- `parsePolishOutput(raw: string): string`（剥围栏/去引号/取首段/trim，导出）；
- `polishAppearance(row: CharacterRow): Promise<{ appearance; provider; model; usage }>`（system + user JSON，契约 §2.5）。

### 3.9 routes 层

- `routes/style-presets.ts` + `POST /style-presets/extract`（§2.7）；
- `routes/characters.ts`：
  - +`POST /entities/polish`（逐项串行 + 失败收集 + 用量）；
  - +`POST /entities/:id/ref-images`（multipart，§2.4）；
  - POST/PUT 支持 `states`（数组校验/替换）；`toEntityView` + `states`。
- 错误口径：LLM 未配置等 `LlmNotConfiguredError` 经 `h()` 兜底 → 400 + message（既有 `fail()` 语义，无需特判）。

### 3.10 提示词（workspace/prompts）

- `style-extract.md`（新，①）；
- `entity-polish.md`（新，⑤）。

---

## 4. Web 设计

### 4.1 契约层

- `lib/types.ts`：`EntityItem` + `states: string[]`；
- `lib/api.ts`：
  - `stylePresetApi.extract(projectId, assetIds)` → POST `/style-presets/extract`；
  - `entityApi.polish(ids)` → POST `/entities/polish`；
  - `uploadEntityRefImage(entityId, file)` → fetch FormData POST `/entities/:id/ref-images`（独立函数，XHR 进度不必要）。

### 4.2 views/StylePresetsView.vue（①）

- 新建/编辑弹窗内 +「从参考图提取」区：项目选择 → 图片多选（勾选缩略，≤4）→「提取风格词」按钮（busy）→ 成功预填 `form.snippet`（并提示来源模型）；失败显示错误（含「请配置视觉模型」指引）。

### 4.3 components/ProjectFormModal.vue（②）

- 「视觉风格」单选 select → checkbox 多选面板（启用预设按 sortOrder；勾选集合去重）；
- 读取：`style_preset_ids` 数组优先回退单值；已停用/已删除绑定值显示「#id（已停用/已删除）」条目（可取消勾选）；
- 保存：`settings.style_preset_ids = 勾选数组（空→null）` + `style_preset_id: null`（旧键清理）。

### 4.4 views/EntitiesView.vue（④⑤⑥）

- **多选**：卡片 + checkbox（选中集合；切换 Tab / 筛选清空）；工具行「批量润色（N）」按钮（N=0 禁用；>10 提示）；
- **批量润色**：confirmDialog（说明将覆盖 appearance）→ busy「润色中…」→ 结果 notice（N 成功 / M 失败）+ 刷新；失败项可重选再试；
- **上传新图**：表单挑图区 +「上传新图」（仅编辑态）；上传成功 → `form.refIds` 同步 + 候选刷新 + notice；
- **states**：角色表单 + textarea（每行一条）；卡片 chips（前 2 条 + 「+N」）；保存仅 character 传 `states`。

---

## 5. 改动清单 / 不改清单

### 5.1 改动清单

**服务端（apps/server/src）**

1. `services/llm.ts`：ChatContentPart 类型 + ChatMessage.content 放宽
2. `services/style-preset.ts`：stylePresetIdsOf / resolveProjectStyleSnippets（旧单数薄封装）/ combineStyleSnippets / extractSnippetFromText / extractStyleSnippetFromAssets
3. `services/entity-polish.ts` 新建（parsePolishOutput / polishAppearance）
4. `services/character.ts`：upsertEntity +states；upsertCharacter 透传
5. `pipeline/actions/ai-image.ts`：复数解析 + combine + params.stylePresetIds
6. `pipeline/actions/ai-video.ts`：ShotSpec +location/props；collectSetRefAssetIds / planVideoRefs / videoReferenceCapability；params.setRefAssetIds；注入
7. `pipeline/actions/character-sync.ts`：CharacterSpec +states；normalizeSpec 保留并 export
8. `adapters/types.ts`：VideoAdapter +referenceImages
9. `adapters/volcengine-video.ts` / `minimax-video.ts` / `aliyun-wan-video.ts`：+referenceImages 能力位
10. `db/schema.ts`：characters +states 列
11. `db/index.ts`：幂等迁移 +1 行
12. `routes/style-presets.ts`：+POST /style-presets/extract
13. `routes/characters.ts`：+POST /entities/polish、+POST /entities/:id/ref-images、POST/PUT states、toEntityView +states
14. `workspace/prompts/style-extract.md` / `entity-polish.md` 新建
15. `scripts/probe-m13.ts` 新建 + package.json `probe:m13`

**Web（apps/web/src）**

16. `lib/types.ts`：EntityItem +states
17. `lib/api.ts`：stylePresetApi.extract / entityApi.polish / uploadEntityRefImage
18. `views/StylePresetsView.vue`：从参考图提取区
19. `components/ProjectFormModal.vue`：风格多选面板
20. `views/EntitiesView.vue`：多选 + 批量润色 + 上传新图 + states 编辑/展示

### 5.2 不改清单（红线）

- **不改引擎/模板**：engine / refs / loader / 模板文件零改动（无新 action、无版式变化）。
- **不破 M8 探针**：`injectStyleAnchor` / `resolveProjectStyleSnippet` / `upsertEntity` 旧签名保持（新增为可选参数/薄封装）。
- **不改 first_frame 语义**：首帧通道不动；参考图仅在无首帧时生效。
- **不改 shot-workbench / tts / 字幕 / 合成**：M10 上传通道零触碰。
- **不引入新依赖**：多模态为 OpenAI 兼容协议扩展；上传复用 importFiles。
- **不阻断**：提取/润色/上传/参考图注入全部失败不炸主链（降级 + 日志）。

---

## 6. 验收

### 6.1 静态

- server `npm run typecheck` 零错误；web `vue-tsc` 零错误。

### 6.2 探针（probe-m13.ts，七节；隔离环境、零网络零计费）

1. `style-multi`——stylePresetIdsOf 矩阵（数组/单值回退/去重/坏 JSON/负值过滤）；combineStyleSnippets（多/单/空/空白）；resolveProjectStyleSnippets 顺序与停用跳过（DB 造数）；injectStyleAnchor 单值行为回归（M8 等价）
2. `vision`——fetch stub：请求体 messages 的 content 为数组且含 image_url 项（data URI）；extractSnippetFromText 矩阵（标准/半角括号/无格式回退/围栏剥离/超长截断）；资产校验失败路径（非图/跨项目 → 抛错）
3. `video-refs`——collectSetRefAssetIds 矩阵（场景命中/道具命中/双命中≤2/未命中空/去重）；planVideoRefs 四分支断言
4. `upload`——importFiles + attachRefAssets 链路（临时项目造行）；sha256 复用语义；entity 视图 refAssetIds 更新
5. `polish`——parsePolishOutput 矩阵；polishAppearance fetch stub（伪响应 → 更新 appearance）；批量失败容错（一项抛错 → failed 收集，其余继续）
6. `states`——迁移后列存在；upsertEntity 覆盖语义（非空覆盖/空数组不覆盖）；normalizeSpec 保留 states；toEntityView 返回 states（含坏 JSON → []）
7. `regression`——`probe:m7 / probe:m8 / probe:m10 / probe:m11 / probe:m12` 全绿

### 6.3 实弹（真实项目）

① 提取——配好视觉模型 → 素材页选 2 张参考图提取 → snippet 格式「(画风：…)」→ 预填表单 → 建预设成功；
② 多预设——项目绑定 2 个预设 → ai_image 重跑 → 提示词逐字含两词块 + `gen_tasks.params.stylePresetIds` 双值 + DB 核对；
③ 视频参考图——含 location/props 分镜 → ai_video → `params.setRefAssetIds` 快照 + 日志（有首帧 → frame_first 跳过；无首帧 → 注入）；
④ 上传——素材页上传一张图 → assets 行（purpose=reference_character）+ refAssetIds 追加 + 卡片计数更新；
⑤ 润色——勾选 2 个实体 → 润色 → appearance 变化 + usage_records（runId NULL）两行/项；
⑥ states——character_sync 重跑（或 PUT）→ states 入库 → 卡片 chips DOM；
⑦ 兼容——老项目单值绑定出图风格注入逐字不变；老接口响应新增字段不破前端。

### 6.4 越界核查

git diff 白名单核查；package.json dependencies 无新增；模板目录零改动。

### 6.5 文档

- roadmap M13 注记 + README M13 能力速览。

---

## 7. 风险

1. **视觉模型不支持图片输入**（配了纯文本模型）→ 供应商 400/空响应 → 错误 message 透传 + 前端指引「请在 Settings 配视觉模型」；提取不落库、无副作用。
2. **多图 data URI 体积**（4×8MB 上限）→ 张数上限 4 + 单张 8MB（assetToDataUri 既有）；超限报错指引。
3. **多预设词块语义冲突**（两预设互斥）→ 用户自选组合 + 拼接顺序按绑定数组（可预期）+ 双写快照溯源（可核对）。
4. **Wan 帧/参考互斥** → 首帧优先决策（frame_first 分支）跨厂商统一；探针锁定四分支。
5. **润色覆盖用户手写字段** → 只更新 appearance + confirmDialog 明示 + 失败项不动 + 逐项可见结果（polished 列表）；无版本存档为明确排除项。
6. **LLM 输出格式违例** → 解析宽容（剥围栏/取首段/空则不动）+ 长度 cap。
7. **迁移**（states 列）→ 幂等 ALTER TABLE（M8 kind 先例同款）；旧行 DEFAULT '[]' 兜底，读侧坏 JSON → []。
