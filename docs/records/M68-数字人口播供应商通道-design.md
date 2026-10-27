# M68 数字人口播供应商通道 — 设计

> 状态：设计定稿（2026-10-27 brainstorming 六节确认）。执行计划另立 `docs/records/plans/M68-计划.md`。

## 一、立项与决策记录

- 来源：市面专业工具能力差距分析 → 用户确认开发（优先级第 3 项，前两项 M66/M67 已交付）。
- 2026-10-27 用户拍板六项：
  1. **首发供应商 = 火山引擎**（已有 volcengine 凭证在用，国内数字人 API 最成熟）。
  2. **产品落位 = 独立工具页**（不进流水线引擎、不加画布 action——同 M66 创作画布 compose 未接线先例，画布化登记遗留）。
  3. **音色 = 内置音色**（豆包 TTS 内置音色库，复用既有 volcengine_audio 链）。
  4. **通道形态 = OmniHuman 修正案**（研究推翻「形象库+文本单调用」前提：火山轻量开放 API 实为图+音频驱动〔即创数字人快速模式〕；「形象库+文本驱动」是阿里云形态。修正后音色链零新工作、照片驱动能力顺带获得）。
  5. **任务模型 = gen_tasks 异步队列**（口播视频生成分钟级，M16「长任务异步化」拍板沿用；关页不丢任务、任务列表可重进）。
  6. **实测策略 = 开通服务真测**（用户在火山引擎控制台单独开通数字人视频生成服务〔独立计费〕并提供 AK/SK 凭证后跑真单出片目检——M19 声音克隆同款路径）。

## 二、现状勘察

- **供应商适配层**：`api_configs`（provider_key + service_type llm|image|video|audio|music + credential + extra/pricing/priority）+ `adapters/provider.ts`（resolveEndpoint 等）。M6 起供应商切链宽容降级。
- **火山引擎两套鉴权体系并存**（仓库均有先例）：
  - Ark Bearer API Key（audio/image/video，kit `protocols/{speech,video}/volcengine*.ts`，`Authorization: Bearer`）；
  - **IAM V4 签名**（music，kit `protocols/music/volcengine.ts`：CanonicalRequest→StringToSign→四层 HMAC `{SK}/{date}/cn-beijing/imagination/request`，凭证 AK/SK，extra 优先 + `AK/SK` 拼接兼容，内部轮询保同步契约）。
- **OmniHuman 快速模式 API 勘察结论**（2026-10-27 官方文档核实）：
  - `POST https://visual.volcengineapi.com/?Action=CVSubmitTask&Version=2022-08-31`（异步提交）+ `Action=CVProcess`（任务查询），火山 IAM **V4 签名**（Service=cv、Region=cn-beijing）；
  - 输入 = **单张人物图（任意画幅、含人物）+ 音频** → 口播视频；无形象库接口、无文本直驱。
- **既有可复用件**：`services/tts.ts`（`resolveAudioEndpoint('volcengine_audio')` + `synthSpeech`，支持按任务 `voice` 覆盖 `config.extra.voice` 缺省）；`gen_tasks` 表（kind video、task_id 第三方任务 id、params JSON、exec_snapshot、status pending|processing|succeeded|failed|cancelled、result_asset_id、attempts/error_msg/completed_at）+ `services/creation/gen/execute.ts::executeOnce` 推进器与 socket 进度推送；`saveGeneratedMedia`（`services/net.ts`，M66 隐式标识 + 显式角标挂点）；`assets` kind audio|video；路由挂载 `app.ts` `api.route('/', xxxRoutes)` 纯加法。
- **仓库现状**：零数字人相关代码（全新子系统）。

## 3.1 供应商协议层（新文件 `apps/server/src/services/digital-human.ts`）

- **V4 签名纯函数**（`signVolcRequest`）：照 kit `protocols/music/volcengine.ts` 先例自实现进本仓（kit 为锁定版本外部依赖不可改，0 新依赖；文件头注明来源先例），差异仅 `Service='cv'`、Action/Version/请求形状。签名要素：CanonicalRequest（method/path/query/host/x-date/x-content-sha256/content-type）→ StringToSign → 派生密钥 `HMAC(HMAC(HMAC(HMAC(SK,ShortDate),Region),Service),'request')` → `Authorization: HMAC-SHA256 Credential=..., SignedHeaders=..., Signature=...`。
- **凭证解析**（`parseVolcCredentials`，纯函数）：`extra.access_key_id/access_key_secret` 优先，`apiKey` 支持 `AK/SK`、`AK:SK` 拼接（music 先例同款）。
- **API 配置**：`api_configs` 新增一行 `service_type='digital_human'`（text 加值零迁移，0 新表 0 新列）、`provider_key='volcengine_digital_human'`、`extra` 携带 AK/SK；`resolveDigitalHumanEndpoint()` 取 active 配置，未配置时端点报 `ProviderNotReadyError` 惯例错误。
- **厂商参数单一出口**：`req_key`、分辨率/画幅映射、音频格式等厂商字面量集中为本文件导出常量，协议细节只改这一处。
- **实测校准项（诚实登记，探针以 stub 断言我方形状）**：① `req_key` 精确值；② image/audio 入参形态（data URL / TOS 上传 / 厂商 URL 直传）；③ 音频/视频时长上限；④ 任务查询响应字段名（Status 枚举语义按 music 先例「成功值非 0」防御式处理）。M19 先例：真实凭证到位后跑通时校准，协议偏差在 review 留痕。

## 3.2 音频链（复用既有，零新工作）

任务提交时序：`resolveAudioEndpoint('volcengine_audio')` → `synthSpeech(script, ep, { voice })`（按任务覆盖音色）→ 音频字节落 `assets`（kind=audio，title=`口播音频-<任务名>`，params 留痕 voice/时长）→ 音频进 OmniHuman 入参（形态见 3.1 校准项②）。TTS 失败 → 任务直接 `failed`（不重试 TTS，attempts 只归 OmniHuman 轮询）。

## 3.3 任务模型（gen_tasks 复用）

- 入队：`gen_tasks` 行 `kind='video'`、`provider='volcengine_digital_human'`、`params` JSON 白名单键 `{ script, voice, imageAssetId, aspect, speed?, title? }`、`task_id`=CVSubmitTask 返回的任务 id。
- 推进：gen_tasks 状态机语义（pending→processing→succeeded|failed）+ socket 进度推送，轮询 CVProcess（间隔常量，attempts 上限 + 超时上限常量，超限 failed）。
- 成功收尾：产物视频 URL 下载 → `saveGeneratedMedia`（**M66 合规自动生效**：隐式六字段 + 显式角标三层默认）→ `result_asset_id` 回填 + params 留痕厂商任务 id/时长。
- 失败旁路：单任务失败不阻断其它任务；`error_msg` 落因（TTS 失败 / 提交失败 / 轮询超时 / 厂商失败码）。

## 3.4 路由（新文件 `apps/server/src/routes/digital-human.ts`，app.ts 纯加法挂载）

- `POST /digital-human/jobs`（multipart：`script` 必填非空 + `voice` 必填 + `aspect`（9:16 缺省|16:9）+ 人物图来源二选一（`image` 文件上传 | `image_asset_id` 项目素材引用）+ 可选 `title`/`speed`）→ 校验 → TTS（3.2）→ CVSubmitTask → 任务行 → `{ taskId, audioAssetId }`（202 语义沿用 house 惯例）。校验失败 `HttpError(400)` 沿用既有错误码风格（bad_input 等）；未配置供应商 400 + 明确文案。
- `GET /digital-human/jobs?project_id=`：任务列表投影（状态/进度/错误/resultAssetId，按 createdAt 倒序）。
- `GET /digital-human/jobs/:id`：单任务详情。
- 既有端点与 `publication_ingest` 零变更（纯加法；新 3 段路径不与既有路由冲突，Hono 静态优先）。

## 3.5 前端（新侧栏入口「口播」）

- 路由 + 侧栏纯加法 → `views/tools/DigitalHumanPanel.vue`：脚本 textarea（≤ 厂商上限提示）+ 豆包音色下拉（**前端清单常量**，取自厂商音色表并注明来源，免新增端点）+ 人物图（上传 | 项目素材选择，复用既有素材选择模式）+ 画幅切换 + 任务卡片列表（状态徽标/进度/错误红字/成片预览跳转 assets）。
- 提交后任务卡片轮询（既有 socket 进度通道优先，轮询兜底）。
- ≤800 行红线预拆：状态与提交逻辑入 composable（M28 `use-*` 范式），模板保持精简。

## 3.6 北极星三问

1. **口播出片从脚本到成片几步？** 答：工具页内 4 项输入（脚本/音色/图/画幅）一次提交，异步出片自动落项目 assets——无需离开面板。
2. **换/加供应商（阿里云 2D 形象库等）要动多少？** 答：协议层单文件新增（3.1 单一出口常量 + 新 service_type 配置行），路由/任务模型/前端零改动。
3. **合规风险在哪？** 答：口播视频必经 `saveGeneratedMedia`，GB 45438-2025 隐式标识与显式角标不可关、默认开——无合规旁路面。

## 四、验收（probe-m68，零网络零计费）

1. V4 签名纯函数：固定输入向量 → Authorization 串快照断言（与 music 先例同构自证）。
2. `parseVolcCredentials` 三形态（extra / AK-SK / AK:SK）。
3. 请求体构造：提交体含脚本派生字段 + 形象/音频入参按 3.1 校准项当前形态断言（协议常量单一出口）。
4. fetch stub 三态：提交成功返任务 id / 查询成功返视频 URL / 厂商失败码 → 各自状态机投影正确。
5. 路由端到端：multipart 提交（TTS stub + OmniHuman stub）→ gen_tasks 行 → 推进至 succeeded → 视频落 assets → **`params.aigc` 留痕断言** → 列表/详情投影。
6. 失败旁路：TTS 失败任务 failed 不阻断第二个任务；轮询超时 attempts 上限生效。
7. 校验面：缺脚本/缺音色/缺图来源 400；未配置供应商 400 文案明确。
8. 回归：全量探针存量校准预期为零（纯加法）；`pnpm ci:check` exit 0。
9. 实测（用户开通后）：真单出片目检（口型同步 / 画幅正确 / 音画对齐）+ AIGC 标识在成片可验。

## 五、明确排除与遗留

- **明确排除**：3D 形象 / 定制视频形象训练 / 实时互动 FlowAct / 克隆音色驱动口播 / 批量队列 / 口播进短剧合成链。
- **遗留登记**：① 画布 action 化（口播接入流水线/合成链）；② M19 克隆音色 → 音频驱动口播进阶（实测内置音色质量后定）；③ 阿里云 2D 形象库通道（OmniHuman 实测质量不达标时的备选，协议层单文件可加）；④ 协议实测校准项（3.1 四项）。
- 红线不变：0 新表 0 新列 0 新依赖 0 新付费面；模板 YAML 零改动；≤800 行红线；探针断言文案不含 PASS/FAIL。
