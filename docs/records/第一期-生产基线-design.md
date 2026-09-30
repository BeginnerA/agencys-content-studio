# 第一期设计：真实生产基线 production-baseline

> **归档戳（2026-09-30）**：本稿被代码探针或验收文档引用为「实现真源存档」，请原地保留、勿删勿移。正文为落笔即冻结的历史快照，交付状态见 [索引](README.md)。

- 日期：2026-09-24。
- 状态：用户“继续”已放行规格及 B1；B1 技术结果与证据建档完成，技术门禁未通过，真实样片/质量/编辑器验收未完成。采集 ID `20260924-154007`，详见应用仓库 `docs/acceptance.md` 第一期记录。
- 来源：已批准的《百工工作室专业化生产分期路线》，第一期及“授权与停止条件”。原路线与 M50 计划均不修改。
- 模块 ID：`production-baseline`；后续依赖方为 `precision-rework`，不在本期实施其功能。
- 前置盘点代码：`agencys-content-studio` HEAD `ae9cb9d43e7e7c35fb4786214dbf1f9aa10dce44`；当时工作树干净。B1 执行快照为 `d9710d85a921327ae2ccaab658b8a3aa72a1024c`，采集区间及后续非本轮修改分开留证。

## 1. 目标、假设与非目标

建立可复用的样片、编辑任务和证据口径，使后续每期能够回答：修改是否准确、是否减少返工、质量结论是否有证据、交付是否可信。

本期采用轻量路径：既有只读 API、本地媒体检查、现有隔离探针和结构化人工记录。暂不新增采集服务、仪表盘、业务表、API 或通用评测框架；六槽规模先验证口径，避免先建设缺少真实数据的系统。

明确假设：
1. 保持本地单人、多体裁定位；科普、故事、产品各两个槽位。
2. 原始媒体和批准内容属于用户，默认只读；检查副本与证据单独保存。
3. 规格通过仅允许本期约定的本地、零模型计费工作，不包含生成、ASR、模型评分、软件安装或外部上传。
4. 现有功能不满足编辑任务时记录 `unsupported`，不临时开发第二期功能，也不为了填表大范围重生成。
5. 存量计费记录并不必然覆盖真实账单，存量时间戳也不能还原人工耗时。缺失项保持未知。

本期不修改合成、导出、批准链、任务重置、供应商适配器、生产数据库或现有项目配置，不恢复失败任务。

## 2. 只读前置盘点与限制

### 2.1 当前样片可见范围

盘点来源：运行中的 `http://127.0.0.1:3001` 只读 API，经 Browser 执行；未打开自动加载缩略图的前端页面。

| 项目/运行 | 核实结果 | 基线用途 |
|---|---|---|
| project 55，run 131、132 | 均 failed；方案 `genre=story`、`mode=dynamic`、目标 45 秒，模板 `easy-dialogue-review`、i2v；项目共 9 个资产（6 图、3 文本），未见视频 | 仅登记失败路径候选；不是成片，不得填入 60 秒对白槽 |
| project 40，run 128 | completed，模板 `topic-radar`；项目共 4 个文本资产 | 非视频成片，不能以 run completed 作为成片证据 |
| 六个正式槽位 | 当前已覆盖范围均无 `final_video` 候选 | `missing`，ID 与实测时长为 null |

覆盖：2 个活跃项目、0 个归档项目、3 次运行、1 个创作会话及上述项目的全部 13 个未删除资产。运行/会话列表各有 100 条上限，本次未触及；项目资产返回数量与 total 一致。

限制：未检查已删除资产、磁盘孤立文件及未被列表覆盖的历史记录。因此结论是“当前覆盖范围无候选”，不是“用户没有任何历史成片”。全局 `/assets` GET 不存在，资产列表使用 `/projects/:id/assets`。

### 2.2 环境与编辑器

| 项目 | 已核实 | 不得据此推断 |
|---|---|---|
| 服务端 | 回环端口 3001 在监听；健康接口报告 DB、FFmpeg 正常 | 不能证明生成质量或编辑器兼容性 |
| 运行环境 | Node v22.23.2，pnpm 12.3.4 | 不等于本轮已跑类型检查/构建 |
| FFmpeg/ffprobe | PATH 可解析，两者可执行命令存在 | 尚未检查媒体，不代表样片时长已测量 |
| 剪映专业版 | Windows 安装记录版本 11.5.0.14471；未检出运行进程 | 未启动，未验证导入入口或 FCPXML/EDL/OTIO 支持 |
| DaVinci Resolve | 常见卸载注册项未检出；未检出运行进程 | 不能排除便携版或其他安装位置；标 `not_verified`，不写“确定未安装” |

不启动生产服务以开展采集：`apps/server/src/index.ts` 启动过程包含任务恢复、队列推进和排产调度。现有服务不可用时停止只读采集，不能以重启服务替代诊断。

## 3. 六槽样片清单与入选规则

| slotId | 体裁/模式 | 实测时长范围 | 附加覆盖 | 当前绑定 |
|---|---|---|---|---|
| science-slideshow-30 | 科普、图文旁白 | 25–35 秒 | 分镜、TTS、字幕 | missing；project/run/final 均 null |
| science-dynamic-60 | 科普、动态解说 | 50–70 秒 | 视频镜头、旁白、字幕 | missing；均 null |
| story-dynamic-30 | 故事、动态叙事 | 25–35 秒 | 角色参考、跨镜素材 | missing；均 null |
| story-dialogue-60 | 故事、双人原生对白 | 50–70 秒 | 实际双人交谈；估算/严格核验来源分列 | missing；均 null |
| product-slideshow-30 | 产品、图文介绍 | 25–35 秒 | 产品参考、字幕、旁白 | missing；均 null |
| product-dynamic-60 | 产品、动态介绍 | 50–70 秒 | 品牌、多画幅、BGM 和 SFX | missing；均 null |

规则：
- 时长范围是样片分层规则，不是作品质量标准；超出范围只作为备用，不裁切用户原片以凑槽位。
- 入选须具备实际文件、可读媒体流、非夹具来源、明确体裁/模式证据。方案时长不能代替 ffprobe 实测。
- 每槽固定一个主样片，不以同一成片重复覆盖多个槽。多个合格候选时优先来源证据完整，其次取最新创建的合格成片；选定后冻结，不因结果不好换片。
- `candidate` 表示有待核实文件；`ready` 表示入选条件满足，不表示质量通过。文件缺失为 `missing`；环境或授权阻塞为 `blocked`。
- 外部提供的真实视频可作为媒体质量/导入样片；缺少平台运行链时 `runId=null`，不得用于证明平台生成成本或批准链正确性。
- 产品综合槽有缺失品牌/多画幅/音效时保留候选及缺项，不能直接标 ready。多画幅是该槽的派生版本，不重复累计“可用成片分钟”。
- 失败 run 131/132 保留为旁路失败案例，不改为成功，也不为填满槽位恢复执行。

## 4. 固定修改任务及适用范围

每个样片冻结修改目标 ID、原值、新值、原版文件校验和。前后对照必须复用同一任务，不在后续版本挑选更容易的目标。

| taskKey | 固定要求 | 适用范围与本期处理 |
|---|---|---|
| text-one-line | 修改一条批准台词中的一个短句，保留其他内容 | 有台词；替换内容在采集时人工确认并冻结；当前入口不支持则 unsupported，不执行模型解析 |
| voice-one-line | 文本不变，只更换一条配音的音色 | 受控 TTS；原生对白为 not_applicable，不以 TTS 替换伪装等价 |
| visual-one-shot | 修改一个镜头画面；动态镜头区分提示词修改与首帧级联 | 有可定位镜头；记录当前需要重做的依赖，不启动生成 |
| subtitle-time | 一条字幕整体后移 200ms，文本不变 | 有字幕且移动后不越界/重叠；不满足时 not_applicable，不强行执行 |
| trim-one-shot | 将一个允许裁切的镜头尾部缩短 500ms | 不切断实际发言；是否可裁由看片确认，未知时 not_tested |
| redeliver | 对同一个固定成片版本做三格式工程交付检查 | 每个有实际成片的槽；各格式独立记录，不用另一格式替代成功 |

定位规则：从当前选定分镜的第二镜开始，按镜序寻找首个满足条件的目标；台词选目标镜头中的首句；无合格目标则标不适用并写理由。语义类新文案和具体素材须在执行前人工确定，作为样片数据冻结，不由采集程序自由生成。

本期只记录现有路径的能力与成本范围。写操作只有在后续明确批准的隔离副本中可执行，禁止对生产 run 131/132 或其他原始项目进行修改、选片、重合成和导出 POST。付费操作另走预算授权。

## 5. 证据契约与保存位置

### 5.1 交付物

规格确认后才创建以下采集产物：
- `data/production-baseline/<captureId>/manifest.json`：六槽及候选、环境、覆盖范围、来源、非敏感配置。
- `data/production-baseline/<captureId>/observations.jsonl`：逐任务、逐检查的实际记录。
- `data/production-baseline/<captureId>/evidence/`：本地媒体检查结果、截图、已批准的素材副本、工具输出。
- `docs/acceptance.md` 追加“production-baseline 第一期”摘要及证据定位。历史 M50 行不覆写；无真实样片就如实保留未验收。

`captureId` 使用 `YYYYMMDD-HHmmss`，不得覆盖同名目录。`data/` 已在 `.gitignore`，不新增忽略规则。对外/入库的摘要不含用户正文、密钥、机器绝对媒体路径；本地证据也不保存密钥、原始配置响应或全量数据库。

### 5.2 manifest 最小结构

```json
{
  "schemaVersion": 1,
  "moduleId": "production-baseline",
  "captureId": "待采集时赋值",
  "capturedAt": null,
  "revision": { "head": "待采集时读取", "dirty": null },
  "inventoryScope": { "source": "readonly-api", "completeWithinScope": false, "limits": [] },
  "samples": [{
    "slotId": "science-slideshow-30",
    "status": "missing",
    "projectId": null,
    "sessionId": null,
    "runIds": [],
    "finalAssetId": null,
    "mediaSha256": null,
    "actualDurationSec": null,
    "durationSource": "unknown",
    "approvedRevision": null,
    "planHash": null,
    "timelineSource": "unknown",
    "evidenceIds": [],
    "missing": ["真实成片及生成来源"]
  }]
}
```

示例仅展示一槽；实际 manifest 必须含且仅含六个唯一 slotId。所有测量值附来源，不能用 null→0 或缺省假值填充。

实际输入快照优先使用既有批准 recipe、M29 执行输入记录及内容版本；成片时间轴使用 `params.timeline`，缺失时标明 legacy/recomputed/unknown。不能以当前已变化模板或参考图冒充当时执行输入；不为补证据重新合成原片。

配置白名单：模型/供应商标识、分辨率、画幅、请求时长、单价快照、模板哈希及非敏感参数。认证头、API key、token、端点 URL 查询参数和包含凭据的请求体均不保留。

### 5.3 observation 字段

每条记录包含 `id, slotId, taskKey, sourceVersion, sourceHash, observedAt, evidenceType, result, reason, measurements, evidenceIds`。

- `evidenceType`：`metadata`、`local_measurement`、`offline_probe`、`manual_review`、`editor_import`、`provider_measurement`。
- `result`：`passed`、`failed`、`not_tested`、`unsupported`、`not_applicable`、`stale`。
- `reason` 对除 passed 之外的结果必填；metadata 本身不能给出内容质量 passed。
- 相同检查键的更正写新记录并标 `supersedes`，不删旧结果。源文件 hash 变化使原检查 stale；不能挪用旧版本的通过结论。
- 金额、时长、比例缺测为 null；记录时间使用带时区 ISO 8601，源 API 毫秒时间戳保留原值及单位。

## 6. 指标定义与不可推断项

| 指标 | 计算或采集方式 | 边界 |
|---|---|---|
| 修改完成率 | 满足冻结要求的任务数 / 已实际执行的适用任务数 | 同时列 unsupported、blocked、未执行数；分母为 0 时 null，不能写 100% |
| 返修次数 | 同一目标的显式重新生成提交次数，按可核实请求证据去重 | 任务 attempts 或轮询次数不能直接当生成次数；证据不足为 unknown |
| 无关媒体重生成 | 修改影响范围外实际新提交的媒体任务数 | 单纯 assetId 不变不足以证明没有额外付费，需提交/用量证据 |
| 人工耗时 | 操作人员记录活动区间，人工计时合计 | 不从 run.createdAt/completedAt 猜测；暂停不计入活动时间 |
| 端到端等待 | 确认操作到成果可取的墙钟时间 | 与模型执行、排队、人工 gate 等待分列；资料不足不拆分猜测 |
| 已知成本 | 本次样片关联首轮、失败及返修记录中的非空 cost 去重合计 | 标注平台账本口径；不是供应商最终账单 |
| 未知成本 | 未计价记录数、记账缺口、未归属会话费用单列 | 未知金额不计为 0，不用单价乘假次数补齐 |
| 每分钟可用成片成本 | 已知关联成本 / 人工确认可用的主成片分钟 | 分母为 0 时 null；有成本缺口时只能称“已知成本下界” |
| 字幕偏差 | 同一时间坐标下，字幕起止与人工/合格 ASR 参考起止的差值 | 人工和 ASR 分列；没有参考则 not_tested，不把计划时长当真值 |
| 镜头可用率 | 人工确认可用镜头数 / 已审镜头数，同时报未审数 | 小样本不推断整体模型能力；视觉一致性为人工问题记录 |
| 交付成功率 | 成功导入的格式×编辑器组合 / 已实际尝试组合 | 同时列未尝试和不支持组合；无尝试则 null |

成本特别处理：`services/usage.ts` 的 `recordUsage` 写入异常仅记日志；LLM 缺少 usage 可不写账本；`usageSummary` 的 cost 合计对 null 按 0 汇总但另给 unpriced。因此总价必须携带完整性标记。轻松创作规划费用可能只有 sessionId、没有 runId，只查单一 run 成本不能代表全片总成本。无法归属的费用保持未归属，不按比例摊派。

## 7. 技术基线、媒体基线与编辑器验收

### 7.1 技术基线
- 原样运行现有隔离探针及构建，记录命令、代码版本、退出码、输出与运行时间。本期不为了让基线全绿修改业务代码或断言。
- M50 使用内存结构及部分占位媒体文件检查格式/打包；它不能证明这些包可被编辑器识别为真实视频。
- 后续执行时可在本期 evidence 目录生成明确标为 `synthetic` 的本地 FFmpeg 测试视频/音频，仅检验工具、解码和时码；不计入六槽质量或成本结果。
- 不添加新的持续运行服务，不导入 `src/index.ts`，不将生产数据库复制到证据包。

### 7.2 真实媒体基线
- 实际可用文件先验证 SHA-256、大小、容器、视频/音频流、分辨率、实测时长、帧率口径。
- 逐片完整播放；记录漏台词、字幕可读性、声音清晰度、视觉身份/服饰/道具问题、具体时间范围和复核者。
- 本期不新建自动 QC 算法，不调用多模态评分；已有人工意见与后续自动规则结果分列。
- 对话模式分清受控旁白、免核验原生对白和严格核验对白。当前严格执行仍冻结；不能移除守卫或伪造严格通过样片。

### 7.3 工程兼容基线
- 首选 DaVinci Resolve；未确认可用安装与用户许可前不安装、不启动。
- 剪映当前仅有安装证据；须核实实际导入入口，禁止把普通视频导入当剪辑工程导入。
- 每格式记录：编辑器名称/版本、系统、工程文件 hash、媒体 hash、导入结果、轨道、字幕、声音、转场、重链接情况及截图。
- 默认先在隔离技术夹具上准备工程；真实工程只使用已有包或经另行确认的隔离副本生成，不对原始项目调用导出 POST。
- 对无转场 CFR 夹具，时间位置与已知样本对拍，允许误差不超过一帧；有转场、VFR、估算字幕或格式不支持项分列，不用简单累加时间轴证明保真。
- `timeline-snapshot.ts` 的 segments/lines 为内容轴，SFX 为含片头的成片轴；转场段起点为近似切点。字幕文本有 200 字截断，全文须查原字幕资产，不能只比快照短文本。
- EDL 轨道表达限制、原生对白音画同体等已知差异写降级说明，不作为可以忽略的“已通过”。

## 8. 实施切片与验收门

| 切片 | 交付 | 放行条件 |
|---|---|---|
| B0 规格确认 | 本文件与六槽缺项表 | 已由用户“继续”放行本规格及 B1；不扩展后续授权 |
| B1 零计费记录 | manifest 六槽、前置范围、环境/技术检查结果 | 缺失诚实保留；不调用模型；不改生产数据 |
| B2 样片采集 | 实测媒体记录与冻结任务 | 用户提供/确认真实文件；新生成须另获预算授权 |
| B3 基线观察 | 实际可测任务、人工审片及成本完整性 | 修改仅在批准的隔离副本执行；未支持任务如实登记 |
| B4 工程实测 | 每格式独立兼容记录 | 可用编辑器和工程文件齐备，获本地操作许可 |
| B5 收口 | acceptance 增量记录及第二期输入 | 技术完成、样片覆盖、质量验收、编辑器实测分别给状态 |

总体“基线完成”要求六槽均有合格真实文件与证据，适用任务逐项有结果及来源，成本/时间缺口可见，编辑器兼容有实际记录。B1 可以独立交付，但不能据此宣布一期质量验收完成。

若样片/授权/编辑器仍缺失，停在相应切片，交付明确阻塞清单；不自动进入第二期，不以缩小六槽或删除失败案例制造完成状态。

## 9. 技术栈、目录与可执行命令

项目：TypeScript/Hono/Drizzle/libsql 服务端、Vue 3/Vite 前端、FFmpeg 媒体链。当前依赖无需新增或升级。

- 既有源码：`apps/server/src/services/creation-chat/`、`services/usage.ts`、`pipeline/actions/ffmpeg-merge/`、`services/edit-exchange/`，本期只读。
- 既有探针：`apps/server/scripts/probe-*.ts`，统一 runner 为 `scripts/run-probes.ts`。
- 规格沿用工作区 `docs/superpowers/specs/`；验收摘要沿用应用仓库 `docs/acceptance.md`。
- 证据采用 UTF-8 JSON/JSONL，camelCase 键、固定 kebab-case slotId，遵循 §5 结构；不创建后续模块的表结构/API 规格。

规格通过后，从任意 PowerShell 工作目录逐条执行：

```powershell
pnpm -C d:\work\AI\Agent\agencys-content-studio -r typecheck
pnpm -C d:\work\AI\Agent\agencys-content-studio --filter @acs/server validate:templates
pnpm -C d:\work\AI\Agent\agencys-content-studio --filter @acs/server exec tsx scripts/run-probes.ts
pnpm -C d:\work\AI\Agent\agencys-content-studio --filter @acs/web build
ffmpeg -version
ffprobe -version
```

不使用服务端缺失的 `probe:all` script，不启动 dev/server，不加载含真实密钥的环境文件执行探针。实际媒体路径只在取得文件后代入以下本地只读命令：

```powershell
ffprobe -v error -show_format -show_streams -of json "<已确认的本地样片路径>"
```

占位符不是已执行命令。文件指纹由本地 SHA-256 工具采集；不得输出或复制用户凭据。

## 10. 边界与当前待确认项

- Always：保留六槽和失败案例；缺失字段 null + 原因；文件与版本绑定；当前统计与历史记录分开；不改已批准计划。
- Ask first：确认本规格、用户素材来源、任何计费测试与金额上限、本地编辑器操作、软件安装、隔离副本上的写入/导出。
- Never：真实库破坏性测试、恢复失败生产任务、未知受理状态重复提交、伪造质量/兼容结论、自动修改业务代码、自动 commit/push。

B1 已建档：双端类型检查、19 份模板校验通过；47 探针中 M44 recovery 的 1 项断言失败（4268 通过 / 1 失败），未改断言。web build 被采集环境保护层阻断，复测因后续非本轮前端修改停止，应用构建结果待复测。六槽仍无可绑定成片，不能执行 B2–B4 的完整验收；Resolve 未确认可用，剪映导入能力未核实，且尚无计费或编辑器操作授权。

当前停止条件为技术失败待诊断、构建待稳定快照复测及真实样片缺失；不自动批准后续模块开发。样片可由用户提供或在之后明确预算的前提下补拍/生成。
