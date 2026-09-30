# agencys-content-studio M6 技术设计规格（参考图驱动生成：定妆照参考链 + 首帧图生视频）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-12
- 上游：`2026-09-09-agencys-content-studio-roadmap.md`（北极星不变）；`2026-09-11-agencys-content-studio-m5-design.md` §1.3 明确遗留——「首帧图法 i2v 全自动链｜提示词层保留（heavy 模式产首帧图提示词包）；生成链维持现状（ai_video v1 纯 t2v），**待参考图通道扩展后接力**」——本里程碑即该接力的落地；2026-09-12 三项目源码级对标结论（huobao / Toonflow 均以「已生成图 → base64/URL 参考图 → 后续生成」驱动视觉一致性，本仓为该维度最硬缺口）
- 红线复核：不新增 action（在既有 ai_image / ai_video 内扩展）；不新增 DB 表与列（只在 gen_tasks.params JSON 快照上加键）；不改引擎（引用解析 / 幂等续跑 / 事件机制全部复用）；不改 Web（角色页已有定妆照管理，无新增视图）；模板 version+1 向后兼容
- 设计原则：**data URI 内联**——本地单机部署无公网图床，参考图/首帧一律「本地文件 → base64 data URI」内联进请求体（与 Toonflow / huobao 同策略，且各适配器已具备 data URI 支持面）；**能力声明 + 宽容降级**——供应商不支持参考图时降级纯文本并记日志，绝不因切供应商炸链路；**快照溯源**——参考图/首帧资产 id 全量进 gen_tasks.params，断点续跑与幂等变更检测自动生效

---

## 1. 定位与边界

### 1.1 一句话目标

打通「已生成图像资产 → 后续生成请求」的参考图通道，把视觉一致性从「纯文字锚定」升级为「文字 + 视觉双锚定」，并让 M5 遗留的「首帧图法」成为全自动链路：

1. **图片侧·定妆照参考链**：分镜出图时自动把命中角色的定妆照（characters.refAssetIds）作为参考图注入文生图请求（gemini 已具备；volcengine / qwen / wan 同步分支扩展图片项注入）；
2. **视频侧·首帧图生视频**：新增 `gen_frames` 首帧图步骤与 ai_video 首帧输入，分镜图按 shotId 匹配后以 data URI 注入 i2v 请求（minimax / wan / siliconflow 已具备 data URI 首帧面；volcengine 按官方 role 语义扩展）。

### 1.2 范围（做）

| # | 主项 | 内容 |
|---|---|---|
| P1 | 参考图取值服务 | 新 `services/asset-ref.ts`：资产 → data URI（mime 推断 + 8MB 守卫 + 缺文件语义） |
| P2 | 适配器能力声明 | `ImageAdapter.referenceImages` / `VideoAdapter.firstFrame` 只读能力属性（默认 none，显式声明 base64/as-reference） |
| P3 | 图片侧消费 | ai_image 把任务快照 refAssetIds → data URI → `buildImageRequest.referenceImages`；`use_character_refs` 步骤参数（默认 true）；volcengine / aliyun-qwen / aliyun-wan 适配器图片项注入 |
| P4 | 视频侧消费 | `buildVideoRequest` 补 firstFrameUrl/lastFrameUrl 透传；ai_video 新增 `first_frame` 输入（按 `params.shotId` 匹配 → data URI → 首帧）；`prompt_field` 支持逗号回退链；volcengine-video 首帧扩展 |
| P5 | 模板接线 | mengbao-episode v6：新增 `i2v` 开关 + `gen_frames` 步骤（首帧图）+ `gen_motion` 首帧/动效提示词接线（compose 零改动） |
| P6 | 提示词升级 | storyboard-ep v5：新增 `motion_prompt` 字段（动效指令）+ 三模式说明（静态出图 / 轻量 t2v / i2v 首帧接力） |
| V1 | 验证 | `probe-m6.ts`（静态 / 单元 / 降级矩阵 / 构造）+ i2v 实弹全链 + 兼容回归 |

### 1.3 M6 不做（明确排除）

| 排除项 | 理由 |
|---|---|
| 镜头级工作台（单镜重生成 / 多版本选片 / 分镜图编辑） | P1 级缺口，涉及 Web + API 新面，另立里程碑 |
| 尾帧接力链（上一镜尾帧 → 下一镜首帧） | 首帧通道打好底座后再做；本里程碑先把单镜 i2v 全自动跑通 |
| 公网图床 / URL 服务 | 单机部署无公网假设；data URI 已解；图床留作将来优化项 |
| 图片压缩 / 转码管线 | 生成图天然 1-3MB，8MB 守卫足够；不做额外处理 |
| 场景 / 道具参考图注入 | 本里程碑聚焦角色定妆照（下游资产链已存在，`reference_scene` 目录映射预留）；场景/道具库另立 |
| @图片N 提示词引用语法跨家统一 | wan 适配器已有 `@图片N → 图N` 转换（huobao 遗产）；M6 不依赖该语法，不做跨家统一 |
| 严格模式（不支持参考图时报错） | 统一宽容降级 + 日志；如将来需要再参数化 |

---

## 2. 现状与复用面（代码证据，2026-09-12 核实）

### 2.1 已就绪（本次改造的直接地基）

| 面 | 现状 | 证据 |
|---|---|---|
| 契约·图片参考 | `ImageGenRequest.referenceImages?: string[]` 已定义 | `adapters/types.ts` |
| 契约·视频首帧 | `VideoGenRequest.imageUrl / firstFrameUrl / lastFrameUrl` 已定义 | `adapters/types.ts` |
| 请求组装 | `buildImageRequest` 已支持 `referenceImages` 透传 | `adapters/provider.ts` |
| gemini 图片 | 已实现 `referenceImages → inline_data` 注入 | `adapters/gemini-image.ts` |
| 视频首帧·minimax | `first_frame / last_frame / reference_image` role 已实现 | `adapters/minimax-video.ts` |
| 视频首帧·siliconflow | data URI 首帧已支持 + 自动切 I2V 模型（T2V→I2V 判定 + 报错引导） | `adapters/siliconflow-video.ts` |
| 视频首帧·aliyun-wan | `validateMediaUrl` 已接受 `data:image/*;base64` 官方 base64 首帧 | `adapters/aliyun-wan-video.ts` |
| 角色定妆照链 | char_profile → ref_prompts → gen_refs(ai_image, purpose=reference_character) → character_sync 自动 `attachRefAssets` 挂接 | `pipeline/actions/character-sync.ts`、`services/character.ts` |
| 任务快照 | ai_image 已计算每镜角色 `refAssetIds` 并写入 gen_tasks.params | `pipeline/actions/ai-image.ts` |
| 幂等机制 | 未成功任务「prompt/params 变化 → 归零重排队」变更检测已就位 | ai-image.ts / ai-video.ts 幂等段 |
| Web 角色页 | refAssetIds 编辑 + 定妆照数量展示已存在 | `apps/web/src/views/CharactersView.vue` |
| 资产存储 | 本地文件 + mime 字段；`absPathOf` 可直读；`mimeOfExt` 可兜底 | `services/storage.ts` |

### 2.2 三处断链（M6 要接的线）

1. **图片侧断链**：`refAssetIds` 只进任务快照 → 执行时**未**转 data URI、**未**传 `buildImageRequest`；除 gemini 外三家图片适配器（volcengine / aliyun-qwen / aliyun-wan）**无图片项注入实现**；
2. **视频侧断链**：`buildVideoRequest` **缺** `firstFrameUrl / lastFrameUrl` 参数位；ai_video **无首帧输入**（纯 t2v，注释自认「待图床通道机制后扩展」）；volcengine-video 只保留 reference 模式、**无首帧 role 分支**；
3. **模板层断链**：mengbao-episode v5 中 `motion=true` 与 `gen_images` 互斥（when），**无「先出图再 i2v」路径**；storyboard-ep.md 无动效提示词字段（视频 prompt 只能复用静态 image_prompt）；ffmpeg-merge 对 images/motion_clips **互斥硬校验**（`actions/ffmpeg-merge.ts`），双非空会直接报错——模板接线必须绕开。

### 2.3 适配器能力矩阵（改造前 → 改造后）

| 适配器 | 图片参考图（refAssetIds） | 视频首帧（first_frame） |
|---|---|---|
| gemini_image | ✅ 已实现 → 不变 | — |
| volcengine_image（Seedream 5.0） | ❌ → **扩展 `body.image` 注入**（字段名实弹对表） | — |
| aliyun_qwen_image（Qwen-Image 3.0） | ❌ → **扩展 content 图片项**（multimodal 协议） | — |
| aliyun_wan_image（万相） | ❌ → **同步分支（wan2.7 multimodal）扩展图片项**；异步 t2i 分支不支持 → 降级+日志 | — |
| openai_image / siliconflow_image / pollinations_image | ❌ 标准文生图协议不支持 → **声明 none，降级+日志** | — |
| volcengine_video（Seedance 2.0） | — | ❌ → **扩展首帧 role**（首选 `first_frame`，实弹验证；备选按 reference_image 注入） |
| minimax_video（H3） | — | ✅ 已实现（URL/data URI）→ 不变 |
| siliconflow_video（Wan2.2） | — | ✅ 已实现（data URI + 自动 I2V 模型）→ 不变 |
| aliyun_wan_video（Wan 3.0） | — | ✅ 已实现（官方 base64 接受）→ 不变 |
| pollinations_video | — | ❌ GET 查询串不适合 data URI → **声明 none，降级+日志** |

---

## 3. 设计（决策完备）

### 3.1 参考图取值服务（新 `apps/server/src/services/asset-ref.ts`）

```ts
/** 单图大小守卫：超出跳过（不足则降级），防超大请求体 */
export const MAX_REF_IMAGE_BYTES = 8 * 1024 * 1024

/** 资产 → data URI（kind=image 且有本地文件；mime：asset.mime → mimeOfExt(ext) → image/png 兜底） */
export async function assetToDataUri(assetId: number): Promise<string>
// 缺失/非图/无 relPath → 抛错；文件读失败 → 抛错（调用方决定降级或失败）
```

- 调用方语义：**「明确提供了图但读不出/超限」→ 该图跳过 + ctx.log**（任务不失败）；缓存 Map<assetId, uri>（同图多镜复用，base64 只算一次）。

### 3.2 适配器能力声明（`adapters/types.ts` 扩展）

```ts
export interface ImageAdapter {
  readonly provider: string
  /** 参考图注入支持：none（默认，未声明）| base64（data URI 注入） */
  readonly referenceImages?: 'none' | 'base64'
  generate(req: ImageGenRequest): Promise<GeneratedImage>
}
export interface VideoAdapter {
  readonly provider: string
  /** 首帧注入支持：none（默认）| base64（data URI 首帧）| as-reference（无首帧 role，按参考图语义注入） */
  readonly firstFrame?: 'none' | 'base64' | 'as-reference'
  generate(req: VideoGenRequest): Promise<GeneratedVideo>
  query(...)
}
```

声明表（实现层同步落地）：gemini/volcengine/qwen/wan-image = `'base64'`；volcengine-video = `'base64'`（或 `'as-reference'`，实弹定）；minimax/wan/siliconflow-video = `'base64'`；openai/siliconflow/pollinations-image 与 pollinations-video = `'none'`。

### 3.3 图片侧消费（ai_image）

1. `runOneTask` 执行时：`parsed.refAssetIds`（已有快照）→ 逐 id `assetToDataUri`（缓存 + 8MB 守卫）→ **上限 4 张**（常量 `MAX_CHARACTER_REFS_PER_SHOT`，按角色出场顺序截断）；
2. `buildImageRequest({..., referenceImages: refs.length ? refs : undefined })`；步骤参数 `use_character_refs: false` 可整体关闭（默认 true）；
3. **能力判定**：`adapter.referenceImages !== 'base64'` 且有 refs → 丢弃 + `ctx.log`（一次/任务：「供应商 X 不支持参考图，已降级纯文本锚定」）；任务 params 增 `refUsed`（实际注入张数，0 = 降级）供溯源；
4. 适配器注入实现（实现时按官方格式实弹对表，以下为预期形态）：
   - **volcengine_image**：`body.image = [dataUri, ...]`（Seedream 4.0+ 图像输入字段；上限 10，我们 4 张无需额外裁剪）；
   - **aliyun_qwen_image / aliyun_wan_image 同步分支**：`content: [{ image: dataUri }, ..., { text: prompt }]`（multimodal 协议图片项）；异步 t2i 分支收到非空 referenceImages → **忽略 + 不注入**（降级语义与跨家一致，由 action 层统一记日志，适配器侧仅在 capability 声明为 base64 的分支内实现注入）；
5. gemini 无需改动（现有实现即为目标形态）。

### 3.4 视频侧消费（ai_video）

1. **新输入 `first_frame`**（可选）：上游 `steps.gen_frames.assets` → 资产 id 数组（跳过/空 → `[]` 宽容）；执行时取 `kind=image` 且 `params.shotId` 有效行 → `Map<shotId, dataUri>`；
2. 每镜头：有图 → `request.firstFrameUrl = dataUri`；无图（含 gen_frames 被跳过）→ 纯文生 + `ctx.log`（一次性汇总）；文件损坏/超限 → 该镜降级（同语义）+ 日志；
3. `buildVideoRequest` 补 `firstFrameUrl / lastFrameUrl` 参数位并透传；
4. **任务 params 溯源**：`paramsJson` 增 `firstFrameAssetId`（null 或缺省）——首帧图重出（新资产 id）→ 未成功任务变更检测自动归零重排队；
5. **prompt_field 回退链**：`prompt_field` 支持逗号分隔（如 `motion_prompt,image_prompt`），每镜取首个非空字符串字段；全空 → 报错（保留现有硬校验语义）；
6. **能力判定**：`adapter.firstFrame === 'none'` 且有首帧 → 丢弃首帧 + 日志（pollinations 路径照常出 t2v）；
7. **volcengine-video 扩展**：首帧/尾帧按官方 role 注入 content（首选 `first_frame`/`last_frame` role；若 Seedance 2.x 实弹验证无该 role 则按 `reference_image` 注入并声明 `'as-reference'`）。

### 3.5 模板接线（mengbao-episode v5 → v6）

新增输入：

```yaml
  - key: i2v
    label: 首帧图生视频（需 motion=true；先批量出首帧图再以此图动效出片，出图+视频双重计费）
    kind: bool
    required: false
    default: false
```

步骤改造（仅列出变化，其余 v5 原样）：

```yaml
  - key: gen_frames                      # 新增：i2v 首帧图（独立步骤，绕开 compose 互斥校验）
    action: ai_image
    title: 首帧图生成（i2v）
    when: [input.motion == true, input.i2v == true]   # 数组=AND
    after: [make_storyboard, sync_characters]
    inputs:
      shots: steps.make_storyboard.asset
    params:
      output_purpose: first_frame
    batch: { field: shots, max_concurrent: 2, retry: 1 }

  - key: gen_motion                      # 升级：首帧输入 + 动效提示词回退链
    action: ai_video
    when: input.motion == true
    after: [make_storyboard, gen_frames]   # gen_frames 必为终态（执行或被 when 跳过）
    inputs:
      shots: steps.make_storyboard.asset
      first_frame: steps.gen_frames.assets
    params:
      prompt_field: motion_prompt,image_prompt
    batch: { field: shots, max_concurrent: 2, retry: 1 }
```

模式矩阵（compose 与 gen_images 零改动，自动正确）：

| 模式 | motion | i2v | gen_images | gen_frames | gen_motion | compose 输入 |
|---|---|---|---|---|---|---|
| ① 静态图合成 | false | — | ✅ 出图 | skip(→[]) | skip(→[]) | images 非空 ✓ |
| ② 轻量 t2v | true | false | skip(→[]) | skip(→[]) | ✅ 纯文生 | motion_clips 非空 ✓ |
| ③ i2v 首帧接力 | true | true | skip(→[]) | ✅ 出图 | ✅ 首帧驱动 | motion_clips 非空 ✓ |

- 支撑机制（已核实）：被 when 跳过的步骤为终态、产物记 `[]`，`steps.x.assets` 引用宽容解析为空数组——互斥分支模板天然依赖此语义。
- `storage.ts` 的 `purposeSubDir` 增 `case 'first_frame': return 'images'`。

### 3.6 提示词升级（storyboard-ep.md v4 → v5）

- **输出 Schema 增字段**：`"motion_prompt": "该镜动效指令（运镜 + 主体动作的动效化描述，英文为主；无动效需求时留空字符串）"`；
- **规则新增**：motion_prompt 只写「镜头怎么动」（运镜词+动作过程），与静态 image_prompt 互补；供 i2v / t2v 动效链使用；
- **模式说明改写**：三种消费模式——轻量链仅用 image_prompt（motion_prompt 可忽略）；i2v 链用 image_prompt 出首帧图 + motion_prompt 驱动动效；老分镜无 motion_prompt 时 ai_video 回退 image_prompt（向后兼容）；
- ref-prompts.md / char-profile.md 不动。

### 3.7 降级与错误语义（全链统一）

| 场景 | 语义 |
|---|---|
| 供应商能力不支持（capability=none） | 丢弃参考图/首帧 + ctx.log 警告，任务继续（降级纯文本） |
| 镜头无对应参考图/首帧图（未提供） | 该镜降级 + 汇总日志（链路完成） |
| 图明确提供但读失败/超 8MB | 该图跳过（不足则降级）+ 日志；不使任务失败 |
| resolution=非图资产（如误配视频） | 跳过 + 日志（同上） |
| 任务重试（/tasks/:id/retry） | params 快照不动；首帧图若已重出（新 id）在步骤重跑时经变更检测归零重排队 |

---

## 4. 改动清单（文件级）

| 文件 | 改动 |
|---|---|
| `apps/server/src/services/asset-ref.ts` | **新增**：assetToDataUri + 8MB 守卫 + 常量 |
| `apps/server/src/services/storage.ts` | purposeSubDir 增 `first_frame → images` |
| `apps/server/src/adapters/types.ts` | ImageAdapter.referenceImages / VideoAdapter.firstFrame 能力属性 |
| `apps/server/src/adapters/video.ts` | buildVideoRequest 增 firstFrameUrl / lastFrameUrl 透传 |
| `apps/server/src/adapters/volcengine-image.ts` | body.image 注入（capability=base64） |
| `apps/server/src/adapters/aliyun-qwen-image.ts` | content 图片项注入 |
| `apps/server/src/adapters/aliyun-wan-image.ts` | 同步分支图片项注入；异步分支不注入（capability=base64 的模型边界在适配器内判定） |
| `apps/server/src/adapters/volcengine-video.ts` | 首帧/尾帧 role 注入（实弹定 role 名与 capability 声明） |
| `apps/server/src/pipeline/actions/ai-image.ts` | refAssetIds → data URI → referenceImages；use_character_refs；refUsed 溯源；降级日志 |
| `apps/server/src/pipeline/actions/ai-video.ts` | first_frame 输入解析（shotId 匹配）；首帧注入；prompt_field 回退链；firstFrameAssetId 溯源；降级日志 |
| `workspace/templates/mengbao-episode.yaml` | v5 → v6（i2v 输入 + gen_frames + gen_motion 接线） |
| `workspace/prompts/storyboard-ep.md` | v4 → v5（motion_prompt + 三模式说明） |
| `apps/server/scripts/probe-m6.ts` | **新增**探针（见 §5） |
| `docs/`、`README.md` | 本 spec + roadmap 注记 + 能力矩阵文档同步 |

不改动：引擎（engine.ts / refs.ts / loader.ts）、DB schema、REST 路由、Web、ffmpeg-merge、已有 gemini/minimax/siliconflow 适配器与 character 服务。

---

## 5. 验收

1. **静态**：`pnpm -C apps/server typecheck`（或等价）通过；mengbao-episode v6 经模板校验（`POST /templates/validate` 等价）；`GET /templates` 正常；
2. **探针 `probe-m6.ts`**（对齐 m4 探针风格，sections）：
   - `asset-ref`：data URI 生成（临时文件）、mime 推断、8MB 守卫、缺文件抛错；
   - `capability`：全适配器能力声明与注册表一致性断言（图 7 家 / 视频 5 家）；
   - `match`：ai_video 首帧 shotId 匹配逻辑（构造资产行 → Map → 缺失降级）；
   - `degrade`：不支持供应商（pollinations）→ 请求不带参考图/首帧 + 日志语料；
   - `contract`：buildImageRequest / buildVideoRequest 组装后字段断言（referenceImages / firstFrameUrl 就位）；
3. **实弹**：
   - 图侧：选一家支持参考图的供应商（Seedream / Qwen / 万相同步）跑 `gen_images`，任务 params `refUsed>0`，请求侧（日志/抓包）可见 image 注入；
   - 视频侧：选一家（minimax / wan / siliconflow）跑 i2v 单镜，首帧生效（视频首帧与所出图一致，目检）；
   - 全链：mengbao v6 输入 `motion=true, i2v=true, with_character_refs=true` 真跑 1 集，成片产出；
4. **兼容回归**：v5 输入集重跑 v6（默认 i2v=false）行为与 v5 等价；轻量 t2v（motion=true, i2v=false）与静态图（motion=false）两模式照常出片；存量分镜（无 motion_prompt）经回退链正常；
5. **零越界核查**：`git diff --stat` 无 DB schema / 引擎 / 路由 / Web 变更；
6. **文档**：README 增「参考图驱动能力矩阵」小节；roadmap 注记 M6。

## 6. 风险与对策

1. **各家 base64 字段格式差异**（Seedream `image` / DashScope `content.image` / Seedance role 名）→ 以实弹对表为准，spec 预期形态为锚；单家失败不影响其他家（能力声明独立）；
2. **请求体增大**（3-5MB POST × 并发 2）→ 8MB 单图守卫 + 4 张上限；无压缩管线（生成图天然 1-3MB，实测不超）；
3. **老分镜无 motion_prompt** → prompt_field 回退链（`motion_prompt,image_prompt`）；
4. **volcengine 2.x 首帧 role 不确定** → 实弹二分：有 first_frame role 用 role，无则按 reference_image 注入 + 声明 as-reference；
5. **i2v 成本上调**（出图 + 视频双计费）→ 输入默认 false、label 明示；用量记录（recordUsage）已按实际发生计，无需改；
6. **静默降级不可见** → 降级统一 ctx.log + 任务 params `refUsed/firstFrameAssetId` 溯源，任务页可查。

## 7. 交付物清单

- 代码：§4 全部文件（服务器侧）；
- 模板：mengbao-episode v6；提示词：storyboard-ep v5；
- 探针：`probe-m6.ts` + 实弹验收记录；
- 文档：本 spec、roadmap 注记、README 能力矩阵小节。
