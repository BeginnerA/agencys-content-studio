# 第五期设计：交付包认证 / 编辑器兼容认证（交付可信只读核验）

> **归档戳（2026-09-30）**：本稿被代码探针或验收文档引用为「实现真源存档」，请原地保留、勿删勿移。正文为落笔即冻结的历史快照，交付状态见 [索引](README.md)。

- 日期：2026-09-28
- 状态：**已批准（2026-09-28）**。用户选定「完整只读产品化（推荐档）」；§0 五项档位与 §9 开放问题按红线取推荐值并锁入本文（Q1 认证对象=已生成 zip 包 / Q2 verdict 天花板=至多 needs_attention（editor_import 恒缺）/ Q3 跨格式一致性纳入首切片 / Q4 缓存=merge 进 params.cert / Q5 分工：本期只证 timeline↔包、mp4↔timeline 归第四期）。**业务代码尚未修改**，进入实施计划（Plan）阶段。
- 上位路线：《百工工作室专业化生产分期路线》（Executing，文件不修改）。原 M50 计划不修改。第一期 `production-baseline`、切片 2b `shot-duration-rework`、第四期 `qc-panel` 规格均不重写；本期以**加法**新建只读认证面，不改 `edit-exchange` 导出主流程、不写业务表、不触批准链/引擎。
- 模块 ID：`delivery-certification`；维度归属：「交付可信」（第四期把「成片质量」产品化为可核验；本期把「交付工程包」产品化为可认证——二者对象不同、不重叠）。
- 阶段纪律：本期**不**因建设认证面而把第一期六槽样片验收、真实编辑器实测标为完成；结构认证不等于「编辑器已验证通过」，只如实汇总「工程包内部是否结构良构、事实自洽、媒体可定位」，把「真实 NLE 能否导入」诚实留作外部人工门。

## 0. 待拍板档位（推荐值；如与预期不符请在批准前纠正）

1. **认证对象 = 已生成的 `edit_exchange` 导出包（zip）**（推荐）。对某 run 最近一次（或指定）导出的工程包做只读认证，认证的就是用户真正会交付的那份产物；无已生成包时 verdict=`needs_package`（`not_tested`，提示先导出），**不**为认证而自动生成新 archive（保持零写）。备选：不落包、用纯格式化器在内存渲染三格式做「渲染层认证」——覆盖面窄于「实际交付物」，不作首选。
2. **只读性 = 硬约束**（推荐）。认证服务**不**新建/覆盖 archive 资产、不改 `buildEditExchange`、不复制/回写媒体、不触发生成/ASR/模型评分；结果可选缓存进该 export 资产 `params.cert`（零新列，镜像第四期 `params.qc` 范式），默认按需重算、缓存态标 `fromCache`。
3. **离线自动项 = 结构良构 + 内部时长数学 + 媒体可定位 + 字幕交付绑定**（推荐）。四项全部由**解析已生成文件**得到（JSON.parse / 轻量标签配平扫描 / 时码与有理秒算术 / 包内路径存在性），零新依赖、零网络、零模型。
4. **`editor_import` = 恒 `manual_review_required` / `not_tested`**（推荐，硬红线）。真实编辑器（剪映专业版 / Final Cut / DaVinci / Premiere / Avid）导入认证是**外部人工步骤**（本机为 Windows，FCPXML 属 macOS 生态；且不调用任何编辑器 CLI）。产品**永不**据此项自动判 `certified`；认证 verdict 天花板为「结构可信」，绝不表述为「编辑器就绪 / 已验证通过」。
5. **首切片范围 = 后端认证服务 + 探针 + 只读端点；前端为运行详情导出面板同级的一枚只读认证视图**（推荐）。不新建独立页面框架；入口显隐由能力探测驱动（复用第四期面板同级约定）。

## 1. 目标

对任一**已存在**的剪辑工程交换导出包，按需产出一份**结构化、可复核、带证据来源与新鲜度**的交付认证报告，回答上位路线四维中「交付是否可信」：交给剪辑师/平台的工程文件，**在未打开真实编辑器之前**，能否被证明「不是一堆会被解析器直接拒绝的垃圾、内部时轴事实自洽、引用的素材在包内可定位、字幕交付与版本绑定一致」——同时**诚实标注**「真实编辑器导入仍需人工实测、本产品不代答」。

口径**不新造**：直接复用第一期 `production-baseline` 与第四期 `qc-panel` 已确立的证据字段与结果词表（`result` / `evidenceType` 逐字对齐），把「导出即可信」的隐含假设，收敛成应用内一条只读认证服务。客观项全部来自**本地解压 + 文件解析 + 数据库读取**；外部/主观项显式标注需人工，绝不伪造通过。

### 已确认假设

1. 面向本地单机；不新增多轨 NLE、不重建资产系统、不改引擎核心（DAG 调度 / action 注册）。
2. **一律零付费、零模型、零新依赖**：不触发 ai_image/ai_video/tts/ASR、不调用多模态评分、不新增 gen_task/usage、不上传素材、不回写/替换生产媒体、不启动外部编辑器进程；解 zip 复用既有 `fflate`、解析仅用 `JSON.parse` + 轻量扫描（不引 XML/DTD/schema 库）。
3. 时间轴口径唯一真源 = 成片 `params.timeline`（不变量：严禁从 cue / shot 表 / asset_ids 反推重建第二套时轴）。认证读取导出包内事实并与 `params.timeline` 交叉核对，不重算、不改写。
4. 复用既有 `listEditExchanges`（定位待认证包）、`probeEditExchange`（能力探测）、导出资产 `params`（format / finalAssetId / subtitleDeliveryConsistent 摘要）。
5. 现有能力不满足的认证项记 `unsupported` / `not_tested`，不为凑绿而放宽阈值或伪造通过。

### 包含

- 只读认证服务 `services/delivery-cert/`：解压最近导出的 `edit_exchange` 包 → 逐格式结构良构核验、内部时长/时码数学自洽核验、跨格式一致性核验、媒体引用可定位核验、字幕交付绑定核验、`editor_import` 人工门占位 → 聚合 verdict + `missing[]`。
- 只读端点 `GET /runs/:id/delivery-cert?format=`（对该 run 指定/最近交付包认证）+ 复用导出列表徽标；能力探测驱动显隐。
- 前端只读认证视图（逐条带来源与状态；`editor_import` 恒列「待人工实测」），与导出面板同级。
- 探针分节（隔离库 + 本地合成假时轴 → 经既有 `buildEditExchange` 造一次性假包 → 认证；**零模型、零计费、不碰生产样片**）。

### 暂不包含（明确排除，防范围蔓延）

- **真实编辑器导入的自动化 / 半自动化认证**（启动任何 NLE CLI、引 `otio-python`、FCPXML DTD/XSD 校验库等——均属新依赖或外部执行，另立项并先批准）。
- **成片质量认证**（属第四期 `qc-panel`：`file_readable`/`stream_spec`/`audio_peak` 等测 mp4 物理规格；本期测**导出工程包**，不重做、不越界下质量结论）。
- 修改 `buildEditExchange` / 三格式化器 / 导出主流程 / 批准链 / `delivery_checked` 写入逻辑。
- 付费样片采集、第一期六槽验收本身、任何写业务表或回写媒体的路径。

## 2. 统一验收标准映射（对齐上位路线四维）

| 目标 | 本期硬性验收 |
|---|---|
| 交付可信 | 交付包结构良构可被解析器接受、内部时轴事实自洽、引用素材在包内可定位、字幕交付与版本绑定一致，均附**解析来源 + 实测值**；任一不满足 → verdict 保守降级，绝不把破损包说成「可交付」 |
| 质量可验证 | 复用第四期/第一期证据词表；缺测为 `null`/`not_tested` 并注明原因，不以假值填充；`editor_import` 与客观结构项**分列**，绝不冒充自动通过 |
| 改得准 / 少返工 | 跨格式一致性与「导出包内工程文件 vs 当前 `params.timeline`」交叉核对，暴露「导出后时轴又改了但包未重生成」「media 引用悬空」等漂移，减少交付后才发现的隐性返工 |

## 3. 认证报告数据契约（新建，只读；口径复用第一/四期）

```ts
// export 资产 params.cert 缓存结构（零新列；镜像 params.qc 的「merge + checkedAt」范式；可选）
interface DeliveryCert {
  runId: number
  packageAssetId: number | null     // 被认证的 edit_exchange archive 资产 id；无包 → null 且 verdict=needs_package
  format: 'fcpxml' | 'edl' | 'otio'
  checkedAt: number                 // 带时区毫秒，保留原值
  packageSha256: string | null      // 交付包 zip 哈希；变化使旧报告 stale
  verdict: 'package_sound' | 'needs_attention' | 'package_broken' | 'needs_package'
  missing: string[]                 // 未满足/待人工项的机读键
  checks: CertCheck[]
}
interface CertCheck {
  key: CertCheckKey                 // 见 §4 目录
  status: 'passed' | 'failed' | 'not_tested' | 'unsupported' | 'not_applicable' | 'stale'  // 复用第一/四期 result 词表
  evidenceType: 'metadata' | 'local_measurement' | 'offline_probe' | 'manual_review'       // 复用第一/四期 evidenceType
  source: 'zip' | 'project_file' | 'manifest' | 'params.timeline' | 'media_fs' | 'manual'
  value?: number | string | boolean | null   // 实测值；缺测 null，不填充
  reason?: string                   // 除 passed 外必填
}
```

- verdict 规则（保守）：无已生成包 → `needs_package`；任一客观自动项 `failed` 或 `stale` → `package_broken`；无 failed 但存在 `not_tested`/`manual_review`（含 `editor_import` 恒此类）→ `needs_attention`；全部适用自动项 `passed` → `package_sound`（**注意：`package_sound` 仍不等于「编辑器就绪」，`editor_import` 永远使报告带 `needs_attention` 级缺项，故终值实际不会到「无条件可信交付」**——见 §4 尾注）。分母/适用性存疑取更保守态。
- 相同 `packageAssetId` 重新认证写新报告并覆盖缓存；zip hash 变化 → 依据旧测得的检查项在下次读取前标 `stale`。

## 4. 认证项目录（客观自动可测 + 外部/人工显式留人工）

| key | evidenceType / source | 判定（逐格式化器实际 emit 事实为准） |
|---|---|---|
| `package_present` | metadata / zip | 该 run 存在可认证 `edit_exchange` 包且 zip 可解压；无 → `not_tested`（verdict=`needs_package`），破损不可解压 → `failed` |
| `project_file_wellformed` | offline_probe / project_file | FCPXML：XML 声明 + 单根 `<fcpxml>` + 开闭标签配平 + 无未转义裸 `&<>`；OTIO：`JSON.parse` 成功且含 `OTIO_SCHEMA=...Timeline` 与五轨；EDL：含 `TITLE:`/`FCM:` + ≥1 事件行且列文法可解析；不满足 → `failed` |
| `duration_math_consistent` | offline_probe / project_file | 解析文件内部时间值并核自洽：FCPXML 末段 `offset+duration ≤ sequence duration` 且段 `duration` 求和 ≈ `sequence duration`（±1 帧容差）；EDL 每事件 `ro-ri == 源时长帧`、同轨 record 时码升序；OTIO Video 轨 `clip+gap` 帧和 == `source_range.duration.value`（±1 帧）；超差 → `failed` |
| `cross_format_consistency` | offline_probe / project_file | 若同 run 存在多格式包：三格式解析出的镜头段数、总时长（帧）、fps 是否一致；不一致 → `failed`；仅单格式 → `not_applicable` |
| `media_refs_resolvable` | local_measurement / project_file + media_fs | 工程文件内每条媒体引用（FCPXML `file://.../media/..`、OTIO `target_url`、EDL reel↔manifest）在**包含媒体时**能定位到包内 entry 或磁盘 `absPathOf` 存在；`include_media=false` → `not_applicable`（仅工程，媒体需按 manifest 归位）；悬空引用 → `failed` |
| `timeline_source_bound` | metadata / manifest + params.timeline | manifest `timelineSource`（stored/recomputed）与成片 `params.timeline` 可交叉；工程段数/时长与 `Σ(params.timeline)` 一致 → `passed`；缺 `params.timeline` 且 recomputed → `not_tested`（不反推重建） |
| `subtitle_delivery_bound` | offline_probe / manifest + sidecar | 复用导出既有 `subtitle.deliveryConsistent`：sidecar `subtitles.srt` 在包内且 manifest 摘要 hash 吻合 → `passed`；`deliveryConsistent=false` → `failed`（不声称字幕交付一致）；无可导字幕 → `not_applicable` |
| `editor_import_certified` | manual_review / manual | **恒 `not_tested` + `manual_review_required`**（外部人工：真实 NLE 导入，见 §0.4 红线）；永不自动 `passed` |

- 尾注（诚实天花板）：由于 `editor_import_certified` 恒为缺项，任何交付包的最终 verdict 实际至多为 `needs_attention`（结构可信但待人工导入实测）。这是**刻意设计**——本期交付的是「结构可信 + 明确的人工待办清单」，不是「免检放行」。仅当用户完成人工导入并记录后，「交付可信」闭环才真正达成（人工记录属第四期 `manual_quality_review` 同类人工门，本期不代答）。

- **源时轴新鲜度风险（M50 既有未核点，本期显式承认边界）**：`params.timeline` 仅在 compose 成功落库时刷新；M50 收口记录已标注走 retry / resume / 崩溃恢复路径的成片其 `params.timeline` 是否为最新值**尚未实测确认**，「不可默认快照必然新鲜」。本期认证只证「导出包内工程文件 ↔ 其构建时所依据的 `params.timeline`」一致（`timeline_source_bound`），**不**独立证明「`params.timeline` ↔ 实际 mp4」新鲜——后者是第四期 `qc-panel` 的 `duration_vs_timeline`（测 mp4 实测时长 vs `params.timeline` Σ）的职责。二者串联才闭合「mp4 ↔ timeline ↔ 工程包」完整可信链；单看本期不得声称源时轴对 mp4 新鲜。实施计划须含一步：验证 retry/resume 路径下 `params.timeline` 新鲜度，若确有陈旧风险则在认证报告中把 `timeline_source_bound` 降级为 `not_tested`（附「源时轴新鲜度未证」原因），绝不伪造 `passed`。

## 5. 读侧实现、缓存与新鲜度（加法；零新列）

- 服务置于 `apps/server/src/services/delivery-cert/`，全部为**读 + 本地解压解析**，不 import 引擎、不写业务表、不改导出主流程。
- 定位待认证包：复用 `listEditExchanges(runId)` 取指定/最近 `edit_exchange` archive → `absPathOf(relPath)` → `unzipSync`（既有 `fflate`）取 `manifest.json` / 工程文件 / `media/*` entry 名集合。
- 解析纯函数分格式：`certifyFcpxml` / `certifyOtio` / `certifyEdl`（各自只做 `JSON.parse` / 标签扫描 / 时码算术，**不引 schema 库**）；时码↔帧换算复用既有 `services/edit-exchange/timecode`。
- **零新列**：结果 `merge` 进该 export 资产 `params.cert`（保留其余键），镜像第四期 `recordQuality`/`params.qc`；缓存仅供列表徽标/离线可查，`GET` 默认按需重算并标 `fromCache`。
- 解压/解析工具异常 → 相关项 `status=not_tested`（宽容，不武断 `failed`），verdict 至多 `needs_attention`。
- 新鲜度：报告携带 `packageSha256 + checkedAt`；zip hash 变而缓存未刷新 → 据 §3 标 `stale`（不挪用旧通过结论）。

## 6. 入口覆盖与「同类入口一次收口」

- 唯一写入 = 该 export 资产 `params.cert` 缓存（只读结论），**不新增任何业务写路径**，不改批准链 / `delivery_checked`。
- **交付/导出同类入口审计（全量枚举，本期一次收口口径核对）**：
  1. 后端生成：`POST /runs/:id/edit-exchange`（`buildEditExchange`，三格式）；`POST /runs/:id/exports` + `POST /batches/:id/exports`（`buildRunExport`，发布包 asset zip——**非工程包**，不在本期认证对象内，明确划界）。
  2. 后端探测/列表：`GET /runs/:id/edit-exchange/formats`（`probeEditExchange`）、`listEditExchanges`。
  3. 前端触发：`views/easy-create/CreationResult.vue`（`exportEditEx` / `createEditExchangeDownload`）、`views/run-detail/RunStepCard.vue`（`exportEditExchange`）——两处「导出工程包」入口产出的即本期认证对象；本期认证视图与二者同级、独立只读。
  4. 下载：复用 `GET /assets/:id/file?download=1`（不改）。
  - 收口声明：本期认证**只读地覆盖**上面 1–3 产出的 `edit_exchange` 包；对 1 里的 `buildRunExport` 发布包**不认证**（对象不同，避免越界与重复建设）。

## 7. 能力门禁与基准

- 门禁 = 该 run 至少存在一个 `purpose=edit_exchange` 且可解压的 export 资产；否则 `needs_package`。不要求 run `completed`。
- 不新建执行闸门；认证不触发任何导出、重合成或步骤重置。

## 8. 测试与验证（探针加法，零模型零计费）

- 在 `edit-exchange` 域探针家族新增认证分节（建议 `probe-m50.ts` 新增 `--section=certify`；若触发单文件 ≤800 红线则按第四期惯例抽 `probe-m50-delivery-cert.ts` 分节库被主探针 import）。流程：隔离库 + 本地合成假时轴 → 经既有 `buildEditExchange`（`include_media` true/false 各一）落一次性假包（标 synthetic）→ 认证。核心断言：
  1. 正常合成包：`project_file_wellformed`/`duration_math_consistent`/`media_refs_resolvable`/`subtitle_delivery_bound`/`timeline_source_bound` 客观 `passed`；
  2. 造破损：篡改工程文件（OTIO 去闭合轨 / FCPXML 去一个闭合标签 / EDL 破坏事件列）→ `project_file_wellformed=failed`，verdict=`package_broken`；
  3. 造时长数学差：改某 clip `duration` 使其偏移越出 `sequence duration` → `duration_math_consistent=failed`；
  4. 造 media 悬空：manifest 声明但工程引用一个包内不存在的 `media/...` → `media_refs_resolvable=failed`；`include_media=false` → 该项 `not_applicable`；
  5. 跨格式一致：同 run 生成 fcpxml+otio（+edl）→ `cross_format_consistency=passed`；人为让其一 fps/段数不一致 → `failed`；
  6. `editor_import_certified` 恒 `not_tested` + `manual_review_required`，且**任何**正常包终 verdict ≠「无条件可信」——至少 `needs_attention`（红线守卫：断言不存在让 `editor_import=passed` 的代码路径）；
  7. 无已生成包 → `package_present=not_tested`、verdict=`needs_package`（不为认证自动造包，零写守卫）；
  8. 缓存写 `params.cert` 保留其余键（零新列回归）；zip hash 变 → 下次读取旧结论标 `stale`；
  9. 全程零 `gen_tasks`、零 `usage_records`、零新增 archive（读侧不变量守卫）。
- 既有回归不变：`edit-exchange` 域探针（`probe-m50` 其余分节）与 `--only=precision-rework`（字幕 / compose-input / shot-duration / qc-panel）保持全绿（加法优先）。
- 门禁命令：
  ```
  pnpm -C d:\work\AI\Agent\agencys-content-studio --filter @acs/server exec tsx scripts/run-probes.ts --only=m50 --section=certify --jobs=1
  pnpm -C d:\work\AI\Agent\agencys-content-studio -r typecheck
  pnpm -C d:\work\AI\Agent\agencys-content-studio --filter @acs/web build
  ```
- m26 split-audit 不破线（单文件 ≤800）：服务按 `services/delivery-cert/` 分文件、探针分节独立文件；预期净新增违规为零。

## 9. 边界（Always / Ask first / Never）与开放问题

**Always**
- result / evidenceType 词表与第一期 §5.3、第四期 §3 逐字对齐（避免口径漂移）。
- 只读 / 零付费 / 零模型 / 零新依赖 / 零新列；`params.timeline` 唯一真源只读交叉核对、不反推重建。
- 单文件 ≤800；探针与 typecheck / web build 于每个增量后全绿；加法优先不动既有分节。

**Ask first（须用户批准才可做）**
- 引入任何 schema/DTD/XML 校验库或 `otio-python` 等外部校验器（会把「结构良构」升级为「规范符合」，但破零新依赖红线）。
- 启动真实编辑器 CLI 做半自动导入认证（破「不执行外部程序 / 跨平台不可靠」红线）。
- 新增写路径、改 `buildEditExchange` / 格式化器 / 批准链语义。

**Never**
- 伪造「编辑器已验证通过 / 免检可交付」；`editor_import` 恒 `manual_review_required`。
- 写业务表、生成/回写媒体、调用模型或 ASR、上传素材。
- 反推重建第二套时轴；把本期结构认证说成第四期成片质量认证。

### 开放问题（需用户拍板 → 对应 §0）

- **Q1 认证对象**：仅「已生成 zip 包」(推荐) 还是也含「内存渲染层认证」？
- **Q2 verdict 天花板**：确认「正常包终值至多 `needs_attention`（editor_import 恒缺）」为期望语义（推荐=是，红线守「不代答编辑器」）。
- **Q3 跨格式一致性**：纳入首切片(推荐，暴露导出后时轴漂移) 还是留后续？
- **Q4 缓存**：结果缓存进 `params.cert`(推荐，镜像 params.qc) 还是纯按需不缓存？
- **Q5 源时轴新鲜度**：`params.timeline` 对 mp4 的新鲜度（retry/resume 路径未证）——认可「本期只证 timeline↔包、mp4↔timeline 归第四期，二者串联闭合」的划界(推荐)，还是要求本期认证额外独立重测 mp4 时长（会与第四期 `duration_vs_timeline` 重复）？

无上述五项锁定不改业务代码；确认后进入 Phase 2 实施计划。
