# 精确返修首个切片：字幕修订闭环

> **归档戳（2026-09-30）**：本稿被代码探针或验收文档引用为「实现真源存档」，请原地保留、勿删勿移。正文为落笔即冻结的历史快照，交付状态见 [索引](README.md)。

- 日期：2026-09-25。
- 模块：`precision-rework`；切片：`subtitle-revision`。
- 状态：用户已选择“确认此范围”；本规格和独立实施计划待确认，尚未修改业务代码。
- 上位路线：《百工工作室专业化生产分期路线》。原路线及 M50 计划保持不变。
- 阶段例外：允许先推进这一功能切片；`production-baseline` 真实验收仍未完成，不以本切片代替六槽、36 项任务或编辑器实测。

## 1. 目标与边界

在现有生产链中完成“改字幕 → 看差异及影响 → 确认 → 仅更新必要产物 → 按版本检查和下载”的闭环。

已确认的假设：
1. 面向本地单人、多体裁生产；不新增完整多轨编辑器。
2. 字幕显示文字不等于批准台词或实际发声；本切片绝不修改脚本、配音、视频源或 ASR 结果。
3. 允许增加一张返修请求表，用于持久化预览、并发控制及幂等；不重建资产系统，不修改引擎核心。
4. 测试使用隔离数据库、合成本地媒体和模型桩；本次不调用付费模型、不上传素材、不操作生产样片。
5. 第一切片建立统一变更/影响契约并接通字幕操作；不宣称现有全部媒体返修已完成迁移。

包含：逐条改显示文字、改起止时间、所选字幕批量平移、修订历史、恢复旧修订的预览确认、对应 SRT/成片/工程字幕一致性。

暂不包含：增删/拆并字幕、富文本字幕样式、自动校时、语音纠错、句级 TTS、素材替换、裁切、BGM/SFX 修改、首帧级联、视频对象编辑、统一 QC 面板和编辑器兼容认证。

## 2. 已核实的接入约束

- `services/creation-chat/rework.ts` 当前仅支持 image/motion 提示词返修；预览与确认已有版本、费用和批准链机制，不能直接将字幕当作第三种媒体生成字段。
- `services/asset-content.ts` 的通用正文编辑白名单不包含 subtitle；保留此限制，不开放直接覆写原始字幕。
- `ffmpeg-merge/index.ts` 对严格旁白校验源 SRT，对原生对白校验源 SRT 与原声缓存；必须先保留源校验，再应用人工显示修订。
- 普通合成还会做逐句及片头平移；人工修订必须使用已经明确的时间坐标，不能被平移两次。
- `timeline-snapshot.ts` 的 lines 是配音/台词位置，不是可编辑字幕真源；字幕修改不得移动配音轨。
- 工程格式化器当前从 lines 构造字幕；本次须为人工显示字幕增加独立字段并让三格式共用同一取值规则。
- 重新合成有会话路由与通用运行路由，前端有四处调用点；不能只接轻松创作。

## 3. 用户操作与适用性

### 3.1 编辑方式

- 默认使用结构化字幕列表：原文字/新文字、起点/终点、勾选项和毫秒平移量。
- 播放定位使用最终成片时间；字幕字段使用整数毫秒。UI 显示 `HH:MM:SS.mmm`，不得用浮点字符串反复舍入。
- 仅允许修改既有 cue，不改变 cue 数量和顺序。标识由字幕基准及 ordinal 生成，修订中保持稳定；源字幕重建后旧标识不得跨源沿用。
- 提供“字幕指令”入口，将自然语言转换为相同的结构化操作，再走同一预览/确认服务；不自动执行。
- 自然语言解析只处理显式字幕模式。现有画面返修入口保持原语义，不自动猜测“改一句话”是改声音还是字幕。
- 混合或歧义请求返回待澄清项；未支持部分必须展示，整单不执行，用户删改为完整可支持请求后重新预览。

### 3.2 能力门禁

仅支持具有 `ffmpeg_merge` 步骤、可读源 SRT、可固定成片资产和可信字幕快照的运行。多个合成步骤须明确 stepKey。

旧成片没有有效字幕快照时只读，提示“先显式本地重新合成建立编辑基准”；GET/预览不得自动重合成。没有字幕、源文件缺失、时间轴无法可靠确定或独立 `creation/gen` 画布合成链路，返回明确 unsupported 原因，不伪造字幕时间。

运行必须 completed 或仅本次合成链失败，且引擎不在途、无范围外失败/待执行步骤、无受理状态不明任务。归属、当前选片和所有输入必须一致。需要任何付费步骤才能收敛的运行不允许从此零模型返修入口执行。

## 4. 单一变更与预览契约

服务放在 `apps/server/src/services/rework/`；字幕解析和变更计算为纯函数，数据库/文件/模型调用与之分离。

```ts
interface SubtitleCue {
  id: string
  startMs: number
  endMs: number
  text: string
}

type SubtitleChange =
  | { kind: 'subtitle-text'; cueId: string; text: string }
  | { kind: 'subtitle-time'; cueId: string; startMs: number; endMs: number }
  | { kind: 'subtitle-shift'; cueIds: string[]; deltaMs: number }
```

预览返回：requestId、previewHash、baseFingerprint、基准成片/源字幕/修订版本、规范化变更列表、原值/新值、直接影响、需重做步骤、保留资产、费用分类、警告和不可执行原因。

- 结构化修改与本地执行的模型费用明确为 0；本地编码会消耗时间与算力，不承诺即时完成。
- 自然语言解析成本单列，沿用已配置 LLM、预算和用量记账；未知价格须先确认，不计为 0。
- 每个 requestKey 的解析最多提交一次；超时或结果未知不自动重发。用户另发新请求时明确可能重复产生解析费。
- 前端不能提交可信费用、原值、目标资产路径或执行范围；服务端计算后固定，确认时再次校验。
- 预览基准包含：run/step、批准快照（如适用）、原始源字幕 hash、当前人工版本、选中媒体及其 hash、成片/时间轴、有效合成设置与品牌素材、模板/渲染规则版本。
- 预览不重置任何任务，不修改当前版本；只允许写请求记录，显式自然语言解析可以记其实际用量。

输入限制：最多 5000 个 cue、SRT 总 UTF-8 大小不超过 2 MiB、单 cue 不超过 2000 字符；必须非空纯文本。保留正常换行，拒绝控制字符、ASS 覆盖标签和任意 HTML；不将输入作为路径、命令或滤镜表达式。

验证全部最终 cue：`0 <= startMs < endMs <= 成片实测时长`，顺序单调且不重叠。相邻 end=start 合法；重复/冲突操作、空变更、无效 cue、溢出、NaN、小数毫秒和越界整体拒绝，不静默裁切或自动挤动其他字幕。

## 5. 持久化、历史与幂等

### 5.1 返修请求表

新增 `rework_requests`，只承担操作记录，不保存媒体副本或另一套时间轴：
- id（UUID 主键）、projectId、runId、stepKey、可空 sessionId。
- requestKey、requestHash；唯一索引 `(runId, requestKey)`。
- state：`parsing | uncertain | ready | blocked | applied`。
- baseFingerprint、changesJson、previewJson、resultJson、createdAt、updatedAt。
- resultJson 固定该次字幕版本、合成步骤及后续产物关联；不得仅凭时间取“最新资产”。

同键同载荷回放已有状态和结果；同键不同载荷返回 `idempotency_conflict/409`。重复确认先查已应用回执，再判断运行是否 busy，因此不会因第一次已入队而丢失可回放结果。

### 5.2 字幕版本

- 原 `purpose=subtitle` 资产及其原声/估算校验元数据不改。
- 每个 run/composeStep 使用独立 `purpose=subtitle_display` 逻辑文本资产；版本复用 `content_versions`，每版落唯一不可变 SRT 文件，逻辑资产指向当前版本，不覆盖历史文件。
- 版本 meta 记录 sourceSubtitleId/hash、baseFinalId、baseFingerprint、parentVersionId、requestId、cue 标识及变更摘要；新增版本无原始 ASR validationHash，不冒充机器验证。
- run.input 新增受控内部键 `_subtitleEdits`，按 composeStepKey 保存 assetId/versionId/hash 和基准依赖摘要；只能由本服务写入，通用 compose/config 白名单不可写此键。
- 成片、下载和工程包固定 versionId 与不可变文件，不只固定逻辑 assetId。历史恢复是以旧内容生成新修订，再次预览确认，不倒写历史。
- 版本清理和资产引用检查纳入当前指针、历史成片与执行快照；不得清掉仍被引用的字幕文件。

### 5.3 提交事务

1. 校验请求已 ready、previewHash、归属、运行状态及完整依赖指纹；不匹配返回 `stale_preview/409`。
2. 先准备唯一不可变字幕文件并校验 hash；失败无当前指针变化。文件与数据库不能假装同一个事务：事务失败时未引用文件不能发布为有效资产，也不删除用户原文件。
3. 同事务写字幕版本、条件更新 run.input、清理本轮合成 output 中的旧 gate 有效性、仅重置批准的本地合成步骤、将 run 入队并写 applied 回执。条件领用旧 input/status/请求状态，竞争者仅一方成功。
4. 事务提交后才调用现有 startRun；不改引擎。进程在提交后中断时，沿用既有 queued 恢复路径，不二次生成字幕版本。
5. 本地合成失败保留已提交修订和旧成片，提供继续该次本地合成；不重新解析、不再推进修订号。新的主动修改必须新预览。

## 6. 源校验、显示字幕与合成

### 6.1 有效字幕快照

复用合成期已经计算好的时间轴及平移结果，增加可复用的有效字幕解析/序列化函数；不从 cue 反推镜头长度或另造镜头时间轴。

每次具备可解析 SRT 的合成，将实际有效字幕的不可变文件及完整 cue 写入 `params.timeline.subtitle` 的可选增量字段：versionId、sha256、coordinate=`final`、cues、origin、sourceRef。保留 assetId/relPath；lines 仍代表原台词与配音位置。versionId 在无人工修订时可为空；cues 使用 §4 的结构；origin 为 source 或 manual；sourceRef 固定原字幕 assetId、sha256 及其来源标记（estimated/measured/unknown），不得由人工修改升级来源等级。

无人工修订时保留既有渲染语义，快照记录实际有效文本/时间；不借此次改造静默修正历史片头或严格分支时码。关闭烧录时同样准备可下载有效 SRT，烧录开关只控制视频字幕滤镜。

旧版 timeline.v=1 可缺少新增字段，继续按旧规则读取；有新增字段但损坏时明确报错，不能悄悄回退台词生成字幕。

### 6.2 人工修订应用顺序

1. 先按原路径校验批准源、原 SRT、原声/受控配音及原始字幕契约。
2. 解析有效合成输入，校验修订基准依赖仍匹配。
3. 使用最终成片轴的人工 SRT 替代显示输入；跳过旧逐句平移、片头平移的重复处理。源字幕不改，源验证结论与人工显示修订状态分列。
4. 硬字幕打开：本地重合成，图像/视频/配音/ASR 源资产及生成任务复用。现有合成可能重新编码音视频，不承诺输出比特或所有像素不变。
5. 硬字幕关闭且本次仅改显示字幕：在合成 action 的受控分支逐字节复制固定基准成片到新不可变文件，登记新版本及字幕快照；已有对应派生画幅同样复制并关联。禁止视频编码及音轨处理。任一其他依赖改变即拒绝旧预览，不走此快速路径。
6. 保留原 gate 机制，新版本需新审阅；旧批准不能自动用于新字幕。无独立 gate 的模板显示人工字幕尚未复核，不把技术成功称作内容通过。

字幕显示修改只重做本地合成及已有的本地交付下游；下游若含未知 action、生成或自动发布副作用，能力门阻止本切片，不默默启动它们。已下载旧包永不覆盖，历史交付保持历史标签。

选片、媒体重做、源字幕重建、时长/品牌/合成配置改变会使修订过期；读模型标记原因，后续所有重合成入口执行前再次检查。过期修订不静默删除、重定位或套到新镜头；用户可预览恢复当前源字幕或重新编辑。

断点续跑不能盲目跨 run 复制 `_subtitleEdits`：仅在所有固定源及时间轴一致时显式携带并绑定新运行；否则保留历史、显示需重新基准确认。不放宽通用 prepareRunInput 对内部键的过滤。

## 7. API 与入口覆盖

统一运行级 API（前缀 `/api/v1`）：
- `GET /runs/:id/subtitles?stepKey=...`：能力、基准、cue、当前及历史版本、安全下载引用。
- `POST /runs/:id/rework/preview`：结构化 changes 或恢复版本请求；返回固定预览。
- `POST /runs/:id/rework/parse`：显式字幕自然语言模式，独立解析费用确认，转同一 preview 编译器。
- `GET /runs/:id/rework/:requestId`：回放状态、预览和执行结果，不触发副作用。
- `POST /runs/:id/rework/:requestId/apply`：只接 previewHash 及必要确认，不接任意新 changes。

旧 image/motion 返修 API 不改语义；会话中的新字幕功能通过服务端核实 session→run 归属后复用上述服务，不另写执行器。

| 同类入口/消费方 | 本次处理 |
|---|---|
| 轻松创作成果区、字幕指令入口 | 共享字幕编辑器、影响预览、版本及待审状态 |
| 运行详情合成步骤卡 | 相同能力探测和编辑器；不按模板名硬编码 |
| 镜头工作台 ComposeBar | 相同入口、预览、过期原因和本地执行状态 |
| 流程画布合成节点抽屉 | 相同入口；独立 creation/gen 节点明确不支持 |
| 会话 recompose、通用 runs/recompose | 共用修订依赖校验、当前版本读取和本地影响计划 |
| 单步/级联重跑、恢复、候选改选 | 保留原权限和计费语义；使受影响字幕过期，不能绕过合成校验 |
| 通用资产正文编辑/恢复 | 原字幕仍不可直接改；人工修订只能经新预览确认服务 |
| 当前成果、历史下载、工程导出 | 全部固定成片及字幕版本，不用最新 subtitle 或 lines 冒充当前修订 |

UI 沿用现有组件和设计 token：每项输入有 label、错误就近显示、键盘可操作、未保存关闭提示、异步按钮禁用；移动端逐条卡片退化，不做横向大时间轴。预览只有一个主按钮“确认修改”，明确本地操作及可能的解析费。

## 8. SRT 与工程一致性

- 源 SRT、当前人工 SRT、某一历史成片使用的有效 SRT 分开命名展示。
- 工程解析结果携带具体 finalAssetId 和字幕版本；新增可选 finalAssetId 请求参数以固定用户选中版本，旧调用仍解析一个确定版本并在结果中回传。
- FCPXML/OTIO 的字幕由 timeline.subtitle.cues 构造，不再拿 timeline.lines 的文本/时码覆盖人工修订；对白音轨仍只读 lines。
- EDL 不伪装支持字幕轨；三格式都携带版本固定的 sidecar SRT 和明确降级说明。includeMedia=false 仍包含文本 sidecar；字幕缺失或 hash 不符阻止声称本次字幕交付一致。
- 新包摘要记录 finalAssetId、subtitleVersionId、字幕 hash、来源及人工修订状态，不写秘密或机器敏感绝对路径。
- 不借此次切片宣称 Resolve/剪映已兼容；导入验收继续单独登记。

## 9. 技术栈、目录与代码约定

沿用 TypeScript、Hono、Zod、Drizzle/libsql、Vue 3、Vite、FFmpeg/ffprobe；不新增依赖。

- `apps/server/src/services/rework/`：契约、纯变更编译、基准/能力、预览/确认及版本持久化。
- `apps/server/src/db/schema.ts`、`db/index.ts`：仅加法建表和唯一索引，沿用仓库初始化约定；新表不可用则功能 fail closed。
- `pipeline/actions/ffmpeg-merge/`：源验证后应用修订、有效 SRT 快照及无烧录快速路径。
- `services/edit-exchange/`：固定版本、字幕序列及 sidecar，复用既有打包器。
- `apps/web/src/components/`、`lib/`：共享编辑/预览组件、类型、API 与状态组合函数，四入口只接线。
- `apps/server/scripts/probe-precision-rework.ts` 及 `scripts/probes/precision-rework/`：新增隔离探针，runner 自动发现。
- 规格保存在工作区既有 `docs/superpowers/specs/`；实施步骤使用本次独立 IDE 计划及任务清单，不覆写原路线；验收追加应用 `docs/acceptance.md`。

风格采用现有 TS 命名、单引号、无分号、显式接口、Zod 严格校验和中文领域错误。预览、确认与合成共用同一计算函数；前端不重新实现费用或影响判断。

## 10. 迁移与回退

- 不搬迁或批量改写既有 run、assets、content_versions；旧数据按缺少能力/快照读取。
- 新接口及 UI 在后端、探针、合成/导出闭环齐备后才接入，不暴露半成品。
- 开发验证只在隔离环境执行；若生产服务正在监听源码热更新，实施前必须确定不会触发生产迁移/恢复，不能直接边改边重启生产服务。
- 回退为关闭新写入入口、保留新表及全部历史文件；不提供会令旧代码忽略已应用修订的直接降级。需要换回旧二进制时先导出记录，并对含修订的运行阻止重合成；具体生产回退另获授权。
- 已有工程包及发布下载不回写。新修订的包若尚未重新生成，状态为待重新导出；下载历史包可以继续，但必须显示其原成片/字幕版本。

## 11. 验收与验证命令

硬性验收：
1. 修改一条文字，只改变该 cue；单 cue 后移 200ms 和多 cue 同移准确，其他 cue 不动。
2. 不修改源字幕、批准台词、原视频/图像/声音、ASR 缓存；本切片的本地执行路径供应商调用为 0、genTasks 不重置、usage 不新增。
3. 关闭硬字幕时新视频文件 hash 与固定基准相同；开启硬字幕时字幕可见且时长/音画时间位置不被修改，不能仅靠滤镜参数断言效果。
4. 字幕文件、成片快照、FCPXML/OTIO cue 和 EDL sidecar 同源；测试一条长台词拆多 cue、中文换行、带片头和多画幅，配音轨坐标不变。
5. 同请求并发/重复确认仅一次应用；同键异载荷 409；源、选片、版本、配置或基准改变后旧预览 409。
6. 缺文件、跨项目、非法时间、活跃/不确定任务、预算/解析失败、文件写失败、事务竞争、提交后进程中断均有明确结果；拒绝不重置任务、不切换当前版本。
7. 历史下载仍对应原版本；旧 gate 不认可新版本；手改字幕不得获得 ASR 或口型已通过结论。
8. 四个 UI 入口都走同一契约；字幕开关双通道、普通/严格旁白、免核验对白和已有严格对白校验逻辑均有回归。严格对白不因此解除执行冻结。

从任意 PowerShell 工作目录逐条执行：

```powershell
pnpm -C d:\work\AI\Agent\agencys-content-studio --filter @acs/server exec tsx scripts/run-probes.ts --only=precision-rework --jobs=1
pnpm -C d:\work\AI\Agent\agencys-content-studio -r typecheck
pnpm -C d:\work\AI\Agent\agencys-content-studio --filter @acs/server validate:templates
pnpm -C d:\work\AI\Agent\agencys-content-studio --filter @acs/server exec tsx scripts/run-probes.ts
pnpm -C d:\work\AI\Agent\agencys-content-studio --filter @acs/web build
```

首条命令在新探针创建后执行；测试引导器须在导入 db/env 前设置隔离目录，禁用外网及真实密钥加载。不导入生产 index.ts，不使用 db:push 操作真实库。

自动测试、隔离浏览器验收、真实样片质量和编辑器导入四类结果分列。本轮技术验收不依赖新增付费授权；真实质量及编辑器验收缺项照实保留。

## 12. 授权纪律

- Always：先规格确认，再按可测试小切片实现；覆盖全部同类入口；保留历史；结果绑定版本；失败与未知如实记录。
- Ask first：超出这一切片的表结构/引擎改造、生产服务切换、真实项目写入、外部调用、软件安装、额外预算及后续模块。
- Never：取消批准/原声校验以便编辑、自动重发不确定付费请求、改原路线或旧 M50 计划、覆盖原素材、自动 commit/push。
