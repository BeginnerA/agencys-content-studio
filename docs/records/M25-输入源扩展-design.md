# agencys-content-studio M25 设计文档（输入源扩展——小说链 + 视频）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-17 · 状态：已拍板（用户四项决策，见 §1.3）
- 纲领：`2026-09-14-agencys-content-studio-m19-m27-charter.md` §一 G 组（G1–G10）
- roadmap 立项注记：`2026-09-09-agencys-content-studio-roadmap.md`「M25 注记」

## §1 背景与目标

### 1.1 现状（勘察结论，2026-09-17 七项）

1. **M9 小说链在位**：`novel-adapt` 全链（manual_ingest → text_split 三级正则切分 → 逐章事件提取（batch）→ 图谱归并 → 分集规划 → 逐集剧本，三门控）；`chapters/events/graph/plan` 四 purpose；`NovelBoard.vue` 只读看板 + `GET /runs/:id/novel-board` 聚合读。**导入 accept 仅 [.txt, .md]**。
2. **文档解析依赖零**：无 mammoth/jszip/adm-zip——G1 全新面（M9 时期因依赖未做）。
3. **内容写面缺口**：`PATCH /assets/:id` 仅 name/is_favorite/tags，**无资产内容写端点**——G2/G5 共同前置；M23 受控写回 + 脏确认先例可依。
4. **力导向基建**：d3-force 已在 apps/server（M23 `computeArrange` 确定性 tick 300）——G3 同构复用（服务端布局 + 前端 SVG）。
5. **视频解析基建**：抽帧 `services/creation/gen/frame.ts`（M18 单帧 + M22 uniform 2–9 帧 + seek 降级梯度）；多模态通道（`llm.ts` ChatContentPart image_url + `assetToDataUri`；M13 风格词 / M24 eval 评分先例）；**ASR/转写通道零**。
6. **视频上传**已可走 `POST /projects/:id/imports`（任意 multipart + sha256 去重）；audio 默认实例 = SiliconFlow（`https://api.siliconflow.cn/v1`，OpenAI 兼容根，SenseVoice 转写可用）。
7. **G8 小说源抓取** = 纲领 §五待决策项（M5 曾排除）。

### 1.2 目标

把「输入源」从手工 txt/md 扩到 **docx/epub/URL 抓取/视频长素材** 四形态，并补齐小说链的**编辑·图谱·回查·合并·增量**五个深化面，使改编前置链完整可用：

- 小说链（批 1+2）：G1 docx/epub 导入 / G2 章节可视化编辑器 / G3 事件图谱可视化 / G4 改编一致性回查 / G5 事件级编辑 / G6 多部小说同链合并 / G7 自动连载·增量导入
- 视频链（批 3）：G8 轻量通用抓取（URL→正文资产）/ G9 视频长素材解析（抽帧+多模态+音轨转写）/ G10 视频反推链（分镜/文案，产物直接入生产链）

### 1.3 用户拍板（2026-09-17 四项）

1. **G1 文档解析 = 引入轻量解析库**：`mammoth`（docx→文本）+ `fflate`（epub zip 解包，自解析 XHTML）。沿用 M23 d3-force 例外原则：纯解析库（无 IO 副作用语义 / 无框架依赖）经拍板引入。
2. **G8 小说源抓取 = 轻量通用抓取**（⚠ 解除纲领 §五待决策状态）：单端点给定 URL 抓正文文本存 source 资产；无站点适配、无批量爬取、手动触发；SSRF 防护 + 版权免责提示内置。
3. **G9/G10 视频 = 全链含音频转写**：video_analyze action + video-reverse 模板双形态，**含 ASR 音轨转写通道**（复用 audio 实例 OpenAI 兼容 `/audio/transcriptions`，SiliconFlow SenseVoice 实测；不可用供应商宽容降级）。
4. **批次 = 纲领三批全十项**：P0 基建 / P1 批1（G1+G2）/ P2 批2（G3–G7）/ P3 批3（G8+G9+G10）/ P4 收口。

## §2 范围

### 2.1 总览与批次

| 批 | 项 | 交付形态 |
|---|---|---|
| P0 基建 | 依赖安装 + `doc-parse.ts`/`asr.ts` 服务骨架 + 内容写端点 + 两新 action 骨架 + 3 提示词 + probe-m25 骨架 | typecheck + 冒烟探针 |
| P1 批1 | ①docx/epub 导入 ②章节可视化编辑器 | 服务 + 端点 + 前端 + 探针 + 实弹 |
| P2 批2 | ③图谱可视化 ④一致性回查 ⑤事件级编辑 ⑥多部合并 ⑦增量连载 | 同上 |
| P3 批3 | ⑧URL 抓取 ⑨视频解析（含 ASR）⑩反推链 | 同上 |
| P4 收口 | 全量探针 + 回归 + review + roadmap 校准 | — |

### 2.2 ① docx/epub 导入（G1，批 1）

- **新服务 `services/doc-parse.ts`**：`parseDocBuffer(name, buf): { text: string; format: 'docx'|'epub' }`。
  - docx：`mammoth.extractRawText({ buffer })` → 纯文本（段落间空行；标题段落保留 `#` 语义不强求）。
  - epub：`fflate.unzipSync` → `META-INF/container.xml` 定位 OPF → 按 `<spine>` 线性顺序取 XHTML → 去标签提正文（复用 §2.8 的 HTML 提取纯函数）→ 章间以 `\n\n` 拼接并保留 toc 标题行为章头候选（`第X节/章` 或原 h1/h2 文本 → 归一化为 `## 标题` 行，便于 text_split 正则识别）。
  - 非 zip / 缺 container.xml / 垃圾字节 → 抛 `DocParseError`（导入侧 400 明示）。
- **入库单点**：`importFiles`（services/storage）识别 `.docx/.epub` 扩展 → 转换落 **md 文本资产**（purpose=source，name 原文件名去扩展 + `.md`，`params.doc_import={format,chars}`）；原二进制不落盘（v1）。
- **模板接线**：`manual_ingest` 读文本路径不变（拿到已是 text 资产）；`novel-adapt` v2 `accept: [.txt, .md, .docx, .epub]`（向后兼容，纯扩展）。

### 2.3 ② 章节可视化编辑器（G2，批 1）

- **新端点 `PATCH /assets/:id/content`** `{content}`（**受控写**）：
  - 守卫：kind=text（否则 400）；`purpose` ∈ 白名单 `[source, chapters, events, graph, plan, script, text, export, video_analysis]`；content 非空、≤ 2M 字符。
  - JSON 契约：`format` ∈ `{event-json, graph-json, plan-json, chapter-manifest-json, storyboard-json}` 的资产先 `JSON.parse` + 对应结构校验（复用 ai-text 校验纯函数，导出共享）方可写。
  - 写回：覆盖物理文件（tmp+rename 原子写）+ sha256/size 更新 + `params.content_edits={count,lastAt}`（零新列，对齐 params.compliance 先例）；响应 toAssetView。
- **前端**：NovelBoard 章节行 + 资产预览器文本类资产 →「编辑」→ modal（textarea 编辑 + MarkdownPreview 分栏预览，对齐 GateDialog 编辑器先例）→ 保存（脏确认）。
- **排除**：协同编辑、行内富文本、版本时间轴 UI（原始版本链见 §8）。

### 2.4 ③ 事件图谱可视化（G3，批 2）

- **布局纯函数 `services/graph-layout.ts`**：`computeGraphLayout(nodes, links, opts)` —— d3-force（forceLink/forceManyBody/forceCenter/forceCollide + tick 300 确定性，同 M23 ops.ts 手法）→ 输出坐标（round 取整）；输入 = novel-board 既有 graph 文档（key_events + characters，边 = 事件↔章节出现 / 事件间 causal 序 / 角色参与）。
- **读模型**：`GET /runs/:id/novel-board` 响应的 `graph` 字段附 `layout` 子对象（服务端布局，前端零计算）。
- **前端**：NovelBoard 图谱区新增「图形」视图切换（表 ↔ SVG）；SVG 自绘（节点圆/标签、边线、缩放平移复用画布页手法的最简版：fit + 拖拽 pan）；节点点击 → 高亮对应表行。

### 2.5 ④ 改编一致性回查（G4，批 2）

- **新 action `adapt_audit`**（白名单 +1）：`inputs.script`（剧本资产，批量语义由 batch 字段驱动）+ `inputs.chapters`（对应原作章节资产数组）；params `{prompt_tpl: 'adapt-audit.md', output_purpose: 'audit_report'}`。
- 流程：读章节全文 + 剧本 → LLM 审计（prompt 输出 JSON：`{faithful: bool, divergences: [{kind: 'omission|alteration|addition'|'order', severity: 'info|warn|major', desc, ref}]}`，契约校验 fail-fast 对齐 M9 事件 JSON 先例）→ 落 md 报告（含差异表；`params.audit={divergences, maxSeverity}`）。
- **提示词**：`workspace/prompts/adapt-audit.md`（剧本 vs 原作一致性审计）。
- 接线：`novel-adapt` v2 步骤链**不强制插入**（避免改变现行为）；提供模板 `novel-audit.yaml`（正式模板入库：chapters+script 输入 → adapt_audit 批量）。

### 2.6 ⑤ 事件级编辑（G5，批 2）

- 复用 §2.3 内容写端点（purpose=events/graph 已入白名单，JSON 契约校验守卫）。
- 前端：NovelBoard 事件/图谱行「编辑」modal —— 结构化表单（name / chapters 整数数组 / summary / characters 列表）→ 序列化回 JSON 资产（非裸文本编辑；表单编辑后仍走 `PATCH content`）。

### 2.7 ⑥ 多部小说同链合并 + ⑦ 自动连载·增量导入（G6/G7，批 2）

- **G6 多书合并**：`text_split` params `per_source: true`（默认 false=现行为逐字不变）→ 逐 source 资产独立切分、index 跨书续编，manifest 附 `books: [{name, count}]`、逐章 `source_book` 字段；下游 batch 天然逐章继承（事件 brief 全局 → 图谱归并即"合并改编"）。前端 NovelBoard manifest 摘要行透出「N 部 · M 章」。
- **G7 增量连载**：**新端点 `POST /projects/:id/novel/append`** `{run_id, files[]}`（multipart）：
  1. 新文件走 §2.2 导入（docx/epub/txt/md）→ 新 source 资产；
  2. 对每个新 source 独立切分 → **章题 + 归一化首行哈希** 与既有 chapters 资产比对幂等去重；
  3. 新章续编 index 落库（挂 run/step 对齐既有章节）+ manifest 重写（`appended_at` 追加记录）；
  4. 响应 `{added, skipped, total}`。
  - 下游（事件提取/图谱）**不自动重跑**（计费安全，对齐 M23-D11 建议式约束）；UI 提示「可用单步重跑继续事件链」（M11 reset+startRun 既有机制，引擎零改动）。

### 2.8 ⑧ 轻量通用抓取（G8，批 3）

- **提取纯函数 `services/fetch-source.ts`**：`extractReadableText(html)`（确定性自研，零依赖：去 script/style/nav/footer/header/aside/注释 → `<article>`/`<main>` 优先启发 → p/br/hN/li 转换行 → 实体解码 → 压缩空行）；`assertSafeUrl(url)`（**SSRF 守卫**：仅 http/https；拒 localhost/回环/RFC1918/链路本地/`169.254*` 等私有地址与裸 IP 内网段；拒非 80/443 端口）。
- **新端点 `POST /projects/:id/fetch-source`** `{url}`：守卫 → 服务端原生 fetch（timeout 15s / ≤5MB / content-type 限 html|text / 重定向 ≤3 跳且逐跳复查守卫）→ 提取 → 文本 <200 字符视为失败（反爬页识别提示）→ 落 source 资产（`params.fetched={url,chars,at}`）。
- 前端：项目素材页「从 URL 抓取」按钮 + 输入框（版权/免责文案内置：仅供个人素材整理，责任自负）。

### 2.9 ⑨ 视频长素材解析 + ⑩ 反推链（G9/G10，批 3）

- **新服务 `services/asr.ts`**：`resolveAsrEndpoint()`（api_configs `serviceType='audio'` isDefault 优先，baseUrl 需 OpenAI 兼容根——探测 `/audio/transcriptions` 405/401 判兼容）；`transcribeAudio(absPath, model)` → multipart POST（file + model，默认 `FunAudioLLM/SenseVoiceSmall`，实例 `extra.asr_model` 可覆盖）→ `{text, segments?}`；**宽容降级**：端点不可解析 / 非 2xx / 超时 → null（调用方跳过音轨，日志留痕，不阻断主链）。
- **新 action `video_analyze`**（白名单 +1）：`inputs.video`（首个工作视频资产）；params `{frames: 8〔2–24〕, transcribe: true, duration_sec?}`：
  1. ffprobe 时长（复用 ffmpeg 服务探测手法）→ `uniformTimes` 扩展上限 24（既有 2–9 常量放宽，探针断言边界）；
  2. 逐帧抽取（复用 frame.ts `extractFrame` argv + seek 降级）→ **帧不长期落资产**：写临时目录供多模态请求（dataURI），报告仅内嵌时间轴 JSON（v1 不存帧图，防爆库；`params.frames_kept=false`）；
  3. `transcribe=true` → ffmpeg 抽音轨（`-vn -ac 1 -ar 16000` mp3）→ asr.ts 转写 → 失败降级 null；
  4. 多模态 LLM（带时间戳标注的帧图序列 + 转写文本 + 时长）→ 输出 **时间轴 JSON**：`{duration, scenes: [{t0, t1, visual, shot_type?, speech?}], transcript?: [{t0, t1, text}]}`（契约校验）；
  5. 落 `purpose='video_analysis'` json 资产 + 人读 md 摘要（`params.analysis={scenes, hasTranscript}`）。
- **G10 反推模板 `video-reverse.yaml`**（正式模板入库）：ingest（视频 files）→ analyze（video_analyze）→ storyboard（ai_text `video-storyboard.md` → `output_format: storyboard-json` 复用既有校验）+ copy（ai_text `video-copy.md` → 文案 md）→ gate 审阅 storyboard。产物直接满足 `ai_video`/`compose` 消费契约（分镜可进 series-setup/mengbao 链）。
- **提示词 +3**：`video-analyze.md`（视觉解析系统提示）、`video-storyboard.md`（解析→分镜 JSON）、`video-copy.md`（解析→口播/推文文案）。

## §3 接口契约（新增端点 3 枚 + action 白名单 +2 + purpose 枚举 +4）

| 接口 | 语义 | 错误面 |
|---|---|---|
| `PATCH /assets/:id/content` | 文本资产受控写（白名单 purpose + JSON 契约 + 原子写 + content_edits 标记） | 400 kind/purpose/契约；404 |
| `POST /projects/:id/novel/append` | 增量章节追加（multipart 新文件；幂等去重；不级联重跑） | 400 无文件/解析失败；404 run |
| `POST /projects/:id/fetch-source` | URL 抓正文 → source 资产（SSRF 守卫 + 限额） | 400 守卫/内容过短；502 抓取失败 |
| action `adapt_audit` | 剧本 vs 原作 LLM 审计 → audit_report | LLM/契约 fail-fast（StepError） |
| action `video_analyze` | 抽帧 + ASR（降级）+ 多模态时间轴解析 → video_analysis | 视频缺失/无时长 → StepError |
| purpose 扩展 | `audit_report` / `video_analysis` / `frames`（不入库仅临时，注释枚举 +2 即足） / 既有 `source` 新增 params 记 `fetched`/`doc_import` | — |

- **GET /runs/:id/novel-board** 响应扩展：`graph.layout`（G3）；manifest `books`（G6）——**加法零破坏**。
- **imports 单点**：`.docx/.epub` → 转 md source 资产（§2.2）。

## §4 验收标准

1. **导入对账**：真实 docx/epub 样本 → 解析 → text_split 章节数/标题与源文档对照表一致（探针合成样本 zipSync 构造 + 实弹真实工具导出文件）。
2. **内容写**：chapters JSON 篡改写 → 400；编辑保存 → 文件 sha256 变化 + content_edits.count+1 + 重读一致；图片资产 → 400。浏览器：章节编辑器改章 → 看板即时反映。
3. **图谱**：layout 纯函数确定性（同输入同输出 / 孤岛安置）；`GET novel-board` 带 layout；浏览器 SVG 节点数 = 事件数 + 角色数、切换/点击高亮 DOM 断言。
4. **回查**：audit 契约矩阵（omission/alteration 注入检出）；真实 LLM 实弹：对故意改写的剧本审计出 ≥1 条 major/warn 差异，忠实剧本 faithful=true。
5. **合并**：per_source=true 两书各 3 章 → 6 章 index 续编 + book 归属断言；per_source=false 现行为逐字不变（回归锚）。
6. **增量**：append 同文件二次 → added=0/skipped=n 幂等；新章续编 + manifest.appended_at；引擎步骤零触碰（探针断言 run 状态不变）。
7. **抓取**：extractReadableText/assertSafeUrl 纯函数矩阵（SSRF 私网全拒 / 反爬短页拒 / 实体解码）；实弹真实公网 URL → source 资产入库。
8. **视频链**：真实视频实弹——uniform 24 帧边界、**真实 ASR 转写命中**（含清晰口播样本，params.analysis.hasTranscript=true）、时间轴 JSON 契约、反推 storyboard-json 可被 `ai_video` 输入校验接受（validate 直通断言）；ASR 不可用供应商 → 降级 null 主链照常。
9. **全局**：probe:m25 全节绿；回归 m2a–m24 零适配全绿；双端 tsc/vue-tsc 零错；零新表零新列（params 承载全部标记）。

## §5 风险与权衡

- **解析库例外原则**（M23 d3-force 同构）：mammoth / fflate 均为纯解析（无网络 / 无框架语义）；前端零新依赖。docx 复杂排版（表格/文本框）extractRawText 有损——对账验收以正文段落为主，表格登记局限。
- **epub 自研 XHTML 提取**：与 G8 HTML 提取共用纯函数，边缘站点不规范样本宽容（提取到字即成功）。
- **G8 SSRF**：本地单机部署下私网抓取无意义且有风险 → 守卫为硬红线（探针矩阵断言）；不实现代理/自定义 DNS resolver（fetch 对 DNS 解析后的内网 IP 无法拦截——登记已知局限：本机 hosts 指向内网属自伤场景）。
- **ASR 供应商耦合**：首版仅 OpenAI 兼容 `/audio/transcriptions` 形态（SiliconFlow 实测）；volcengine/aliyun TTS 端点非兼容根 → 自动降级，不算失败。计费留痕走 recordLlmUsage 同源通道（transcription 按次记账 params 留痕）。
- **多模态帧量**：24 帧 × dataURI 请求体大（约 2–4MB base64）→ 探针/实弹断言帧数上限与 JPEG 质量参数（复用抽帧 `-q:v 2` 全尺寸 → 反推场景改缩宽 768 再编码，`ffmpeg argv scale` 参数化）。
- **视频解析成本**：单 run 一次多模态调用 + 一次 ASR；不做自动级联（模板显式步骤）。
- **G7 与引擎边界**：append 只写资产不改 run 状态机——事件链续跑走既有单步重跑，避免"引擎外编排"红线。

## §6 实施批次

| 批 | 内容 | 门禁 |
|---|---|---|
| **P0 基建**（✅ 2026-09-17） | `pnpm add mammoth fflate` + doc-parse/fetch-source/asr/graph-layout 四服务骨架 + `PATCH content` 端点 + 两 action 注册骨架 + 4 提示词骨架 + probe-m25 骨架 | typecheck + 冒烟探针 |
| **P1 批1**（✅ 2026-09-17） | G1 导入单点 + novel-adapt v2 accept + G2 编辑器前端（章节 modal + previewer 入口） | 探针 docparse/content-write + 实弹（真实 docx/epub + 浏览器编辑） |
| **P2 批2**（✅ 2026-09-17） | G3 图谱（layout + SVG 视图）+ G4 adapt_audit + G5 事件表单 + G6 per_source + G7 append 端点 | 探针 graph/audit/merge/append + 实弹（真实 LLM 审计 + 浏览器图谱） |
| **P3 批3**（✅ 2026-09-17） | G8 fetch 端点 + 素材页按钮 + G9 video_analyze/asr + G10 video-reverse 模板 | 探针 fetch/asr/analyze + 实弹（公网 URL + 真实视频 ASR/多模态全链） |
| **P4 收口**（✅ 2026-09-17） | 探针全量 + 回归 + 双端 tc + review + roadmap/README 校准 | 全绿 + 文档落盘 |

## §7 探针设计（`pnpm --filter @acs/server probe:m25`，零网络零计费）

| 节 | 覆盖 | 关键断言方向 |
|---|---|---|
| `docparse` | §2.2 | zipSync 合成最小 docx/epub → 文本提取；spine 乱序样本按 spine；垃圾字节 → DocParseError |
| `content-write` | §2.3/2.6 | 白名单/守卫矩阵（kind/purpose/JSON 契约/空/超限）；原子写后重读 + sha256 变化 + edits 计数 |
| `graph-layout` | §2.4 | 确定性（两次同输出）；孤岛/自环/空图；坐标 round |
| `audit` | §2.5 | 契约校验矩阵（合法/缺字段/severity 枚举外 fail）；报告 md 结构 |
| `merge` | §2.7 G6 | per_source 两书续编 + books 摘要；per_source=false 逐字回归锚 |
| `append` | §2.7 G7 | 幂等重放 added=0；续编 index；manifest appended_at |
| `fetch` | §2.8 | SSRF 守卫矩阵（localhost/回环/私网段/端口）；提取纯函数（去标签/启发/实体/过短拒） |
| `analyze` | §2.9 | uniform 24 边界；时间轴契约；ASR 降级路径（端点缺失/非2xx → null）；storyboard 直通校验 |

## §8 明确排除

- 章节/事件**版本时间轴 UI 与 diff 审阅**（content_edits 仅计数标记；文件级历史不做）
- docx 表格/文本框/批注保真、epub 内嵌图片提取（纯文本目标）
- 站点适配爬虫、批量抓取、定时抓取（G8 为单 URL 手动端点）
- ASR 非 OpenAI 兼容供应商适配器（volcengine/aliyun 语音识别 API——降级替代）；说话人分离（diarization）
- 帧图长期落资产与视频工作台联动（v1 临时帧 + 时间轴 JSON）
- append 后自动级联重跑事件链（计费安全；手动单步重跑替代）
- 视频内容审核（NSFW）/ 版权鉴定
- 多角色剧本朗读级 TTS 反推（G10 止于分镜/文案）
- epub 加密（DRM）解析
