# M25 review — 输入源扩展（小说链 G1–G8 + 视频 G9/G10）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-17（**已完成**：P0–P4 全节落盘）
- 对应 spec：`2026-09-17-agencys-content-studio-m25-design.md`（§4 验收 #1–#9 + §6 实施）
- 判定（P0）：**基建完成**——依赖 mammoth/fflate 引入 + 四服务骨架（doc-parse / fetch-source / asr / graph-layout）+ `PATCH /assets/:id/content` 写服务 + 两 action 骨架（adapt_audit / video_analyze）+ 4 提示词骨架 + probe-m25 八节骨架；冒烟 **63 断言全绿** + 双端 typecheck。
- 判定（P1）：**批 1（docx/epub 导入 + 章节编辑器）完成**——`importFiles` 单点转 md 文本资产 + novel-adapt v2 `accept` 扩 [.txt,.md,.docx,.epub]；探针 docparse/content-write 端到端 24 断言；实弹 epub/docx 导入 22 断言 + 章节编辑保存 + 浏览器验证（含缓存刷新修复）。
- 判定（P2）：**批 2（图谱 + 回查 + 事件编辑 + 合并 + 增量）完成**——G3 `computeGraphLayout` 服务端确定性布局 + novel-board 附 `graph.layout` + 前端 SVG 视图；G4 `adapt_audit` action + novel-audit 模板；G5 事件/图谱结构化表单编辑复用 content 写端点；G6 `text_split` per_source 逐书续编（false 逐字回归锚）；G7 `POST /novel/append` 幂等增量。探针全量 **92 绿**；实弹 **25 断言全绿**（含真实 LLM 审计双链）+ 浏览器 6 项。
- 判定（P3）：**批 3（URL 抓取 + 视频解析含 ASR + 反推链）完成**——G8 `POST /fetch-source`（SSRF 守卫 + FetchGuardError 码→502/400 映射 + 落 source 资产 `params.fetched`）+ 素材页「从 URL 抓取」modal（版权免责内置）；G9 `video_analyze` 全接线（ffprobe 时长 → 均匀抽帧 ≤24 缩宽 768 临时不落库 → ffmpeg 抽轨 → ASR 宽容降级 → 多模态时间轴 JSON → video_analysis json + md 报告）；G10 `video-reverse` 模板（analyze→storyboard[gate]→copy，产物满足 ai_video 消费契约）。探针 analyze 节 40+ 全矩阵；实弹真实公网抓取 + 真实 TTS 造口播样本 → 真实解析全链 **ASR 命中**（hasTranscript=true / asr_provider=siliconflow_audio）+ storyboard-json 直通 8 镜 + 文案 600 字，**全部通过**。
- 判定（P4）：**全量收口完成**——`probe:m25` 八节 **141 项断言全绿**（零 FAIL）+ 回归 **22 探针（m2a–m24）21 零适配 + m9 唯一同步点**（见偏差 P4-a）全绿 + 双端 typecheck exit=0 + 测试产物零残留 + 用户库仅存 id=14；review 落盘 + roadmap 校准。
- 证据采集方式：`probe:m25`（内存/临时库 `acs-probe-m25-*`，纯函数 + mock ctx + 隔离模板目录，零网络零计费）+ 真实开发库实弹（:3001，脚本自建临时项目，结束 `?purge=1`）+ 真实计费通道（TTS 合成 / ASR 转写 / 多模态 LLM 时间轴与分镜 / 文本 LLM 文案 / 审计）+ browser-use（章节编辑器、图谱 SVG、抓取 modal）。

---

## 验收矩阵对照（spec §4 #1–#9）

### #1 导入对账（G1）
`doc-parse.ts` `parseDocBuffer`：docx `mammoth.extractRawText`；epub `fflate.unzipSync` → container.xml 定位 OPF → spine 线性序 → 复用 `extractReadableText` 去标签；垃圾字节/缺 container → `DocParseError`（导入侧 400）。`importFiles` 识别扩展转 md（`params.doc_import={format,chars}`，原二进制不落盘 v1）。探针 zipSync 合成样本 + 实弹真实工具导出文件。**✅**

### #2 内容写（G2/G5）
`PATCH /assets/:id/content`：kind=text 守卫 + purpose 白名单 + JSON 契约（chapter-manifest/event/graph/plan/storyboard-json 复用 ai-text 校验纯函数）+ tmp/rename 原子写 + `params.content_edits={count,lastAt}`（零新列，对齐 params.compliance 先例）。探针篡改/超限/图片 400 矩阵；实弹编辑保存 sha256 变化 + edits 计数 + 浏览器看板即时反映。**✅**

### #3 图谱可视化（G3）
`computeGraphLayout` d3-force（forceLink/ManyBody/Center/Collide + tick 300 确定性，同 M23 手法）；novel-board 响应附 `graph.layout`（服务端算，前端零计算，加法零破坏）。探针确定性（同输入同输出）/ 孤岛 / round；实弹浏览器 SVG 节点数=事件+角色、表↔图切换、点击高亮。**✅**

### #4 改编一致性回查（G4）
`adapt_audit` action（chapters+script 输入 → LLM 审计 → `{faithful, divergences:[{kind,severity,desc,ref}]}` 契约 fail-fast → md 报告 purpose=audit_report + `params.audit`）。`novel-audit.yaml` 正式模板（**不强制注入 novel-adapt 步链**，避免改变现行为）。探针契约矩阵；实弹真实 LLM：改写剧本检出 ≥1 major/warn，忠实剧本 faithful=true 双链。**✅**

### #5 多部合并（G6）
`text_split` `per_source:true` 逐 source 独立切分、index 跨书续编、manifest `books` + 逐章 `source_book`；`per_source:false`（默认）现行为**逐字不变**回归锚。探针两书各 3 章→6 章 + book 归属 + false 回归。**✅**

### #6 自动连载·增量（G7）
`POST /projects/:id/novel/append`：新文件走 §G1 导入 → 独立切分 → 章题+归一化首行哈希幂等去重 → 续编落库 + manifest `appended_at` → `{added,skipped,total}`。**下游不自动级联重跑**（计费安全，引擎状态机零改动，续跑走既有单步重跑）。探针幂等重放 added=0 + run 状态不变断言。**✅**

### #7 URL 抓取（G8）
`fetch-source.ts`：`extractReadableText`（去标签/article 启发/实体解码/压缩）+ `assertSafeUrl`（SSRF：仅 http/https，拒回环/RFC1918/链路本地/裸 IP 内网/非 80·443）。`POST /fetch-source` 15s/≤5MB/重定向≤3 逐跳复查/文本<200 判失败；FetchGuardError code → 502（fetch_failed/bad_status）/400（其余）映射。前端 modal 版权免责内置。探针 SSRF 全拒矩阵 + 提取；实弹真实公网 httpbin → source 资产（params.fetched + 正文无 HTML 残留）。**✅**

### #8 视频链（G9/G10）
`asr.ts`：`resolveAsrEndpoint`（audio 实例 OpenAI 兼容根判定）+ `transcribeAudio`（`/audio/transcriptions` multipart，缺省 SenseVoiceSmall，`extra.asr_model` 覆盖）；**宽容降级**（端点缺失/非 2xx/超时→null 不阻断）。`video_analyze`：帧数常量 2–24（不动画布 2–9）+ `uniformVideoTimes` + 抽帧缩宽 768 临时不落库（`frames_kept=false`）+ 抽轨 16k 单声道 mp3 + 多模态时间轴契约 + video_analysis json（前）/md（后）双资产。`video-reverse` 模板 storyboard-json 复用 `validateTextOutput`。探针 analyze 全矩阵 + video-reverse 校验；实弹 **真实 ASR 命中 hasTranscript=true** + 转写关键词相符 + **storyboard-json 直通 8 镜** + 文案。**✅**

### #9 全局
`probe:m25` 八节全绿；回归 m2a–m24（21 零适配 + m9 同步）；双端 tsc/vue-tsc exit=0；**零新表零新列**（doc_import/fetched/content_edits/analysis/audit 全部 params 承载）；review + roadmap + README。**✅**

---

## 偏差与修复记录

### P3-a：ASR 首次实弹 `hasTranscript=false`（定性=服务进程不稳定，非代码 bug；并补健壮性）
- **现象**：首跑 video-reverse 全链 completed、8 帧 8 场景、storyboard 直通，但 analysis params 缺 `asr_provider/asr_model` 且 `hasTranscript=false`（asr 为 null）。
- **定位**：隔离复测两次均证代码链正确——① 原始 TTS mp3 直送 `/audio/transcriptions` → HTTP 200 中文转写；② 复刻 in-run 抽轨链（合成 mp4 → `buildAudioExtractArgs` 抽出 16k 单声道 mp3 → `transcribeAudio`）→ 转写成功。in-run 那次 asr=null 归因于**当时的服务进程（PID 3104）不稳定并随后自行崩溃**（重启守护拉起新进程 PID 33048 后复跑）——该进程抖动亦是本轮更早「脚本 line 54 fetch failed」的同源根因。
- **附带健壮性增强**：SenseVoice 仅回整段 `text`、`segments=null`，而 transcript 兜底此前依赖 `asr.segments`。改 `video-analyze.ts`：LLM 未回填 transcript 且无 segments 时，用 `asr.text` 兜底单段 `[0,duration]`，确立「**ASR 命中 ⇒ transcript 非空**」确定性。
- **复验**：服务重启后实弹全绿（`asr_provider=siliconflow_audio`、`asr_model=FunAudioLLM/SenseVoiceSmall`、转写含「大家好/欢迎收看本期节目/视频解析链路」关键词、md 报告含「## 音轨转写」节）。
- **教训**：宽容降级链会把「外部服务瞬时故障」伪装成「正常无音轨」；核心验收断言（ASR 命中）宜在 flaky 时先做隔离复测定性，再区分环境抖动与代码缺陷。

### P3-b：G8 抓取 Wikipedia 502（定性=上游反爬，非代码 bug）
- **现象**：`https://en.wikipedia.org/...` 抓取 502 fetch_failed。
- **定性**：curl 验证 httpbin.org/html 200 可达、Wikipedia 对抓取 UA 拒绝——上游反爬行为，非端点缺陷。FETCH_URL 改用 httpbin.org/html 稳定样本；SSRF/限额断言不受影响。

### P3-c：实弹脚本 e2e 层修复（非产品代码）
- gate 挂起态谓词 `gating` → 实为 `waiting_input`（engine 事实）；`synthSpeech` 未传 voice 默认 alloy → CosyVoice 报 Invalid voice，改传 `{voice: audioEp.voice}`；`req()` fetch 级异常转结构化 + 真实抓取重试，避免网络抖动崩脚本。

### P4-a：probe-m9 `version===1` 冻结断言同步（M25 P1 契约演进，P4 回归捕获）
- **现象**：全量回归 m9 1 项 FAIL「version=1（实际 2）」。
- **根因**：M25 P1-G1 为 novel-adapt 扩 `accept: [.txt,.md,.docx,.epub]` 并升 `version: 2`（input 数仍 8，纯 accept 扩展）。历史探针 m9 硬编码 `t.version === 1`（校验真实仓库模板）随契约演进而失效；其余 20+ 断言（steps=7/inputs=8/prompt 齐备/序列）不变。
- **修复**：m9 断言改 `version === 2` + 头注释与行内 `[M25·P4 同步]` 注记。**此为 M25 唯一历史探针适配点**（其余 21 探针零适配）。

---

## 静态与探针

- **探针**：`probe:m25` 八节 **141 项全绿**（零 FAIL；docparse / content-write / graph-layout / audit / merge / append / fetch / analyze；`--section=` 可分段独立运行），P4 复跑确认。
- **回归**：22 个探针（m2a / m3 / m4 / m6–m19 / m21 / m22 / m23 / m24）顺序复跑全绿——**21 零适配 + m9 一处 version 同步**（P4-a，因 novel-adapt v2 主动演进）。M25 未触碰引擎状态机/DAG/模板加载签名（KNOWN_ACTIONS 加法 +2）。
- **类型**：server `tsc --noEmit` / web `vue-tsc --noEmit` 双端 exit=0。
- **实弹汇总**：P1 导入/编辑 22 断言 + P2 图谱/审计/合并/增量 25 断言 + P3 抓取/视频全链 ~30 断言（真实 TTS + 真实 ASR + 真实多模态时间轴/分镜 + 真实文案 LLM）。
- **测试产物清理**：P1–P3 全部临时项目走 API purge（`mode:purged`）；崩溃/手动遗留项目 34/35/36/37/38 + P2 遗留 31 逐个清理；**P2 实弹软删宿主 32/33**（API purge 端点查询过滤 `isNull(deletedAt)` → 对软删项目返 404 不可达，属既有端点局限而非 bug）——以复刻 `projects.ts` purge 依赖序清库的临时脚本硬删（32：1 run/9 assets；33：3 runs〔含 2 个遗留 `waiting_input` 门控 run 先置 `cancelled`〕/25 assets/4 usage），脚本用毕即删；phantom 项目 999999 孤儿资产 #1468 硬删 + 目录移除；6 枚 tmp-recon 探测脚本 + e2e-m25-p3.ts 用毕即删；模板目录 = 原状 + novel-audit.yaml + video-reverse.yaml（G4/G10 正式产物保留）。终检：`projects` 全表（含软删）**仅存 id=14「小红书图文作品」**（用户真实项目，未触碰）；`workspace/projects` 目录仅 `14`；孤儿 run 日志（121–124）零残留；`apps/server/scripts` 零 tmp/e2e 残留。

---

## 变更文件清单

- **服务端新增（8）**：`services/doc-parse.ts`、`services/fetch-source.ts`、`services/asr.ts`、`services/graph-layout.ts`、`services/asset-content.ts`（受控写）、`services/novel-append.ts`（G7）、`pipeline/actions/adapt-audit.ts`、`pipeline/actions/video-analyze.ts`
- **服务端修改（9）**：`pipeline/actions/index.ts`（注册 +2）、`pipeline/loader.ts`（KNOWN_ACTIONS +2）、`pipeline/actions/text-split.ts`（G6 per_source）、`routes/assets.ts`（PATCH content + POST fetch-source）、`routes/novel.ts`（POST append）、`services/creation/gen/frame.ts`（scaleWidth 参数化）、`services/storage.ts`（purposeSubDir + importFiles 转 md）、`services/novel-board.ts`（G3 graph.layout）、`package.json`（deps mammoth/fflate + probe:m25）
- **Web 新增（1）**：`views/project-detail/FetchSourceModal.vue`
- **Web 修改（9）**：`components/NovelBoard.vue`（章节编辑器 + 图谱 SVG + 事件表单 + 合并摘要）、`components/asset/AssetGrid.vue`、`asset/previewer/{index.vue,use-asset-previewer.ts}`（文本编辑入口）、`lib/api.ts`（fetchSource/append/content/overview）、`lib/types/novel.ts`、`views/project-detail/{AssetsPanel.vue,index.vue,use-project-detail.ts}`（抓取按钮/modal/hook）
- **workspace（7）**：`prompts/`（新增 adapt-audit / video-analyze / video-storyboard / video-copy 四枚）、`templates/novel-adapt.yaml`（v2 accept 扩展）、`templates/novel-audit.yaml`（新 G4）、`templates/video-reverse.yaml`（新 G10）
- **探针（2）**：`scripts/probe-m25.ts`（新增，八节）、`scripts/probe-m9.ts`（P4-a version 同步）

---

## 局限与备注

- 工作树内另有 3 处**与 M25 无关的早先遗留编辑**（`prompts/style-extract.md`/`entity-polish.md` 仅去标题里程碑标记、`RunParamsPanel.vue` 一处 CSS 缩进），不属 M25 交付面，未纳入上方清单、未做处理。
- **零新表零新列**红线守住：doc_import / fetched / content_edits / analysis / audit 全部落 `assets.params`；引擎/DAG 零改动（append 只写资产不动状态机，续跑走既有单步重跑）。
- docx 表格/文本框/批注 `extractRawText` 有损、epub 内嵌图片不提取（纯文本目标）；epub DRM 不解析——均登记 spec §8 排除。
- SSRF 守卫拦 URL 层私网，不拦 DNS 解析后的内网 IP（本机 hosts 指向内网属自伤场景，登记已知局限）；G8 无站点适配/批量/定时抓取。
- ASR 仅 OpenAI 兼容 `/audio/transcriptions` 形态（SiliconFlow SenseVoice 实测）；volcengine/aliyun 非兼容根自动降级 null；无说话人分离。多模态帧 24×dataURI 请求体大 → 缩宽 768 + JPEG 质量参数控体积。
- 内容写为覆盖式（content_edits 仅计数），无版本时间轴/diff 审阅；导入原二进制不落盘（v1）。
- 视频反推止于分镜 JSON + 文案，不做 NSFW/版权鉴定、不做 TTS 朗读级反推。

## 验证方式（已完结）

- 复跑：`pnpm --filter @acs/server exec tsx scripts/probe-m25.ts`（八节 141 项）；回归 22 探针；server `tsc` + web `vue-tsc`。
- 实弹需 :3001 服务在跑（含 P3 代码）+ 真实计费通道（TTS/ASR/多模态）；实弹脚本已按惯例跑删，如需复现参照本 review P3 段描述重建。
- 相关文档：L1 spec `2026-09-17-agencys-content-studio-m25-design.md`；纲领 `2026-09-14-agencys-content-studio-m19-m27-charter.md`（§一 G 组）；roadmap M25 注记（本日校准收官）。

（全文完：P0–P4 全节落盘；spec §4 验收 #1–#9 全部通过。）
