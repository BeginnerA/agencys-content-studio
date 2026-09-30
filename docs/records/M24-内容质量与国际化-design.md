# agencys-content-studio M24 设计文档（内容质量与国际化）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-16
- 对应纲领：`2026-09-14-agencys-content-studio-m19-m27-charter.md` §三 M24 立项卡（5 项）与 §一 F1–F5 缺口项
- 决策留痕（2026-09-16 用户拍板四项）：
  1. **摘要层触发 = 双形态**：显式 `memory_summary` action（模板作者编排）+ settings 级可选自动钩子（默认关，run 终态触发）
  2. **一致性评测 = 图像角色一致性为主**：对照运行（参考图/记忆注入 vs 裸生成）+ 多模态 LLM 自动评分矩阵 + 报告导出供人工复核
  3. **翻译链 = 双形态并存**：platform-adapt 扩 `target_lang` + 独立翻译出海模板链
  4. **合规审核 = 独立 action + 产物标记**：本地词库 + LLM 可选复审双轨，模板作者置于导出/发布步前；标记落 assets params（零新列）；宽容降级
- 前置：M3 记忆 ✅ / M9–M11 小说与字幕链 ✅ / M13 多模态通道 ✅ / M14 series 实体 ✅ / M19–M23 ✅（2026-09-16 M23 收官）
- 纪律：同一时间只存在一个 L1 详细 spec（校准规则 3）；本轮仅 M24。§6 实施批次内逐批 typecheck + 探针 + 实弹。

---

## §1 背景与目标

### 1.1 现状（勘察结论，2026-09-16 七项）

| 项 | 现状 | 缺口本质 |
|---|---|---|
| ① 三层记忆（F1） | memories 表两层 scope（project/global）+ 开放 type + 具名 upsert（同域同名幂等保 id）+ 向量召回；memory_write/recall 在 8/11 模板成「recall→生成→remember」闭环 | **摘要层级缺失**：长链上下文全文注入，无项目/剧/章压缩层 |
| ② 章级载体（F1） | series/episodes（M14）剧→集两级实体在位，episodes.latestRunId 联动在位 | 章级摘要载体待论证（无实体行 → level 参数化承载） |
| ③ 评测基建（F2） | image-check 仅有效性（黑图/纯色/损坏，写 assets.params.quality 先例）；batches 多输入组对照运行在位 | **评分矩阵全缺**（无 A/B 统计工具） |
| ④ 翻译链（F3） | 全库 translat/i18n 零命中；ai_text prompt_tpl + inputs 全量注入机制成熟（run input 键自动进 prompt） | **全新面**（提示词/契约/命名规范） |
| ⑤ 字幕链（F4） | subtitle 双模式（measured 实测 / estimated LLM 估时）单语 SRT；M22 纯函数族（buildSegmentSrt/parseSrtCues/retimeSrtCues） | **双语形态缺失** |
| ⑥ TTS（F4） | 声线六级链：line.voice_hint → 角色库 → params.voice → settings → 实例 extra → alloy；克隆音色 `clone:{id}` 在位 | **语言→音色映射缺失** |
| ⑦ 合规（F5） | 零命中；gate 机制成熟（required 审阅 + 驳回重跑）；platform-adapt 风险标注先例（adapt-text.md L1–L3） | **词库/审核 action/产物标记全缺** |

### 1.2 目标

1. **三层记忆 / 摘要压缩**：项目/剧/集（+自定义）级摘要，LLM 增量合并压缩沉淀（具名幂等）；recall 可按类型过滤注入（长链上下文以摘要替代全文）；可选自动钩子（默认关）
2. **一致性 A/B 评测**：对照批次提交工具 + 多模态 LLM 图像评分矩阵 + 聚合报告（markdown/CSV 资产），供人工复核选型
3. **翻译链**：platform-adapt 目标语言参数化 + 独立翻译出海模板（文本翻译契约 + 多语言资产命名规范）
4. **多语言字幕 / 配音**：SRT 逐句翻译 → 双语/目标语字幕产物；TTS 语言→音色映射（六级链插入 lang 级）
5. **内容合规审核**：本地敏感词库（数据文件）+ LLM 可选复审双轨 action；产物 params 标记 + 风险报告资产；宽容降级（通道不可用不阻断）

---

## §2 范围

### 2.1 总览与批次

| 批次 | 内容 | 性质 |
|---|---|---|
| **批 1** | ① 三层记忆/摘要压缩（F1）· ② 一致性 A/B 评测（F2） | 记忆服务扩展 + 评测工具 |
| **批 2** | ③ 翻译链双形态（F3）· ④ 多语言字幕/配音（F4） | 提示词/模板/纯函数扩展 |
| **批 3** | ⑤ 内容合规审核（F5） | 新 action + 本地数据文件 |

发号规则：本轮新增端点 **3 枚**（§3）；新增 action **2 枚**（`memory_summary` / `compliance_check`，loader 白名单 +2）；新增提示词 **4 个**（memory-summary / translate-text / translate-lines / compliance-review）；新增模板 **1 个**（translate-export）+ platform-adapt v1→v2；settings 新 key 1（`memory.auto_summary`）；**无新表 / 无新列**；新增数据目录 1（`workspace/compliance/`）。

### 2.2 ① 三层记忆 / 摘要压缩（F1，批 1）

**承载（零新表零新列）**：memories 表 `type='summary'` + 具名 upsert 天然幂等（同 project+name 保 id 覆盖）：

| 级 | name 约定 | 说明 |
|---|---|---|
| project | `summary:project` | 项目级累计设定/风格摘要 |
| series | `summary:series:{seriesId}` | 剧级（一项目一剧，M14） |
| episode | `summary:episode:{episodeId}` | 集级（纲领「章」= 剧的章节单元 = episode；小说章节在改编链中落为集） |
| custom | `summary:custom:{name}` | 任意粒度（如小说卷/章），params.name 必填 |

**新 action `memory_summary`**（`pipeline/actions/memory-summary.ts`）：

- 输入：`content`（text 资产可多个 → 换行拼接；复用 memory_write 的 collectContent 模式）
- params：`{ level='project', series_id?, episode_id?, name?（level=custom）, max_chars=600, prompt_tpl='memory-summary.md', merge=true }`；series_id/episode_id 取值链：params → run input → 缺省（level 对应 id 缺失 → StepError 明确原因）
- 流程：读现有同名摘要（merge=true）→ 注入源 = 「既有摘要 + 新素材」（增量合并压缩，摘要压缩的核心语义）→ `chatCompleteDetailed`（+`recordLlmUsage`）→ 输出截断护栏（超 max_chars×1.5 → StepError 提示模型不遵守）→ `upsertMemory({type:'summary', name, content})` → 记忆日志资产（purpose=memory_log，对齐 memory_write 快照结构，附 level/mergedChars 参数）
- 失败语义：显式链 LLM 不可用 → StepError（不静默，对齐 memory_write embedding 缺失先例）
- **自动钩子（双形态拍板）**：settings key `memory.auto_summary`（JSON bool，缺省 false）；`onRunSettled` listener（新文件 `services/memory-autosummary.ts`，index.ts 注册）：run completed + 开关开 + run 关联集（episodes.latestRunId 命中）→ 该集产物文本（episodes.contentAssetId 或 run 产物 md 资产 top3）→ 走同一摘要核心函数（`summarizeToMemory`，与 action 共用）更新集级摘要；fire-and-forget，失败 log.warn 不阻断（宽容降级）。模板已含 memory_summary 步的 run 跳过（防双份计费）。计费留痕：走统一 usage 通道。

**消费侧扩展**：`memory_recall` 新增 params.`types`（字符串数组，如 `['summary']`）——`recallMemories` 服务层 +可选 `types?: string[]` 过滤（行内 r.type 判定，零 SQL 变更）；召回块渲染不变。长链模板可编排「recall(types=['summary']) → 注入生成」= 上下文压缩闭环。

### 2.3 ② 一致性 A/B 评测（F2，批 1）

**定位**：评测工具 = 生成侧全复用 batch（零新调度），新核心 = 评分矩阵与报告。

- `POST /eval/consistency/run`：body `{ project_id, template_key, base_input, variants: [{ label, input_patch }] }`（2–6 组）→ 展开 `createBatch({ templateKey, name: 'eval:{模板}', inputs: base_input+patch×组 })` → `{ batch_id, run_ids, labels }`。变体示例：A=参考图+记忆注入、B=裸生成（input_patch 携带 gen_set_refs 资产 id / 开关字段——模板侧支持即可，不改模板）。
- `POST /eval/consistency/score`：body `{ project_id, groups: [{ label, asset_ids }], reference_asset_ids? }`（groups ≤6、asset 总数 ≤24）→ 多模态 LLM（`assetToDataUri` 参考图在前 + 被评图，同 style-preset/execute.ts 先例）逐图评分 → 契约 `scores: [{ asset_id, consistency, style, quality, note }]`（0–10 一位小数）→ 响应 `{ matrix, aggregate, report_asset_id }`；`recordLlmUsage` 留痕。
- **纯函数三件套**（`services/eval.ts`，探针直测）：`parseEvalScores(text)`（剥围栏/JSON 解析/asset_id 对齐校验/坏行跳过计数/全坏 → 降级 raw 报告）；`aggregateEvalMatrix(scores, groups)`（per-variant n/mean/min/max + 排名；确定性排序 label 字典序）；`renderEvalReport(aggregate, scores)`（markdown 表 + CSV 文本段；落 text 资产 purpose=`eval_report`，name `eval-report-{ts}.md`）。
- 计费安全：显式两次提交（run/score 分离）+ 组/张数上限 + 用量留痕；LLM 不可用 → 400 `llm_unavailable`（不出假分）。

### 2.4 ③ 翻译链（F3，批 2，双形态拍板）

**形态 A：platform-adapt 扩 target_lang**：模板 inputs +`{ key: target_lang, kind: text, default: 'zh' }`（version 1→2）；adapt-text.md 补「目标语言」段语义（ai_text 全量 inputs 注入机制在位，target_lang 自动进 prompt）。行为回归：default zh = 现行为逐字不变（探针断言）。

**形态 B：新模板 `translate-export.yaml`**（出海翻译链）：

1. `ingest`（manual_ingest 源稿入库）→ 2. `translate`（ai_text + `translate-text.md`，params.target_lang / output_purpose=export / name_tpl `translated-{input.target_lang}.md`）→ 3. `gate`（required 人工审阅）→ 4. `remember`（memory_write type='translation' 沉淀术语/风格经验）。
- **多语言资产命名规范（登记）**：文本产物 `translated-{lang}.{ext}`；字幕 `{name}.{lang}.srt`（双语 = `{name}.zh-en.srt` 型）；产物 params.lang（ISO 639-1）——探针/实弹按此断言。

### 2.5 ④ 多语言字幕 / 配音（F4，批 2）

**双语 SRT（subtitle action 扩展）**：params.`target_lang` + params.`bilingual`（'both' 缺省产双语+纯目标语两条 / 'merged' 仅双语）：

- 定时完成后（measured/estimated 均支持）：台词逐句翻译 → `translate-lines.md` 契约 `[{id, text, dst}]`（与 TimingLine 对齐；缺失句回退原文 + log）
- 新纯函数 `buildBilingualSrt(segs, dstMap, mode)`（`gen/subtitle.ts` +1，复用 renderSrt cue 结构）：双语 cue text = `原文\n译文`；产物 = 双语 SRT + 纯目标语 SRT（purpose=subtitle，params.lang 标注）
**TTS 语言→音色映射**：tts action 新 params.`voice_map`（`{ "en": "voice-x", "ja": "voice-y" }`）；当前语言 = run input `lang`（翻译链第 5 步可 `input.lang` 传递）；声线六级链扩为七级：`line.voice_hint → 角色库 voice → voice_map[lang] → params.voice → settings.audio.voice → 实例 extra.voice → alloy`（`resolveVoiceChain` 纯函数扩展，探针直测；voice_map 缺失/lang 未配置 → 原行为逐字不变）。

### 2.6 ⑤ 内容合规审核（F5，批 3）

**词库（本地数据文件，零外部服务）**：`workspace/compliance/words.txt`（env 新增 `COMPLIANCE_DIR`，对齐 TEMPLATES_DIR 模式）；行格式 `类别|词|级别`（级别 block|warn；`#` 注释行；类别：政治/色情/暴恐/广告/辱骂…内置小型基准词库，**明示非法务意见**）。

**新 action `compliance_check`**（`pipeline/actions/compliance-check.ts`）：

- 输入：`content`（text 资产可多个）；params：`{ llm_review=true, on_block='fail' }`（'mark' = block 也只标记不失败）
- 双轨：① 词库扫描 `scanText(text, rules)` 纯函数（小写 + 全角转半角归一化 → includes 命中，hits:[{word,category,level,count}]）；② LLM 复审（`compliance-review.md` → 契约 `{verdict:'pass|risk|block', items:[{category,quote,reason}]}`；不可用/解析失败 → `llm:null` 降级不阻断——宽容红线）
- 标记：被检资产 `params.compliance = { status: pass|warn|block, hits, llm, checkedAt }`（写回复用 image-check params.quality 同源机制）；报告资产（purpose=`compliance_report`，markdown：结论 + 命中表 + LLM 意见）；block 命中 + on_block='fail' → StepError（步骤失败拦截导出；通道降级永不失败只标记）
- `GET /compliance/rules`（词库只读视图：`{ total, byCategory: {cat: count}, source }`；供诊断/前端）
- 前端最小面：资产详情 params 含 compliance → 状态徽章（pass/warn/block + 时间；沿用既有 params 展示区，零新组件层级）
- 模板接线：translate-export / platform-adapt 不动（示例链留给模板作者）；实弹用临时项目 + 显式步骤 run 验证。

---

## §3 接口契约（新增端点 3 枚 + action 白名单 +2）

| # | 端点 | 说明 |
|---|---|---|
| 1 | `POST /eval/consistency/run` | 对照批次提交 → `{ batch_id, run_ids, labels }`；variants 2–6 组；模板不存在 400 |
| 2 | `POST /eval/consistency/score` | 评分矩阵 → `{ matrix, aggregate, report_asset_id, usage }`；LLM 不可用 400 `llm_unavailable`；asset 越组/缺失 400 |
| 3 | `GET /compliance/rules` | 词库视图 `{ total, byCategory, source }`；词库文件缺失 → total:0 + source:'missing'（不 500） |

白名单扩展：`memory_summary` / `compliance_check`（loader.ts + actions/index.ts 注册）。既有端点扩展：memory_recall params.types（模板层，无 API 变更）、tts params.voice_map、subtitle params.target_lang/bilingual（同 step params 通道）。

---

## §4 验收标准

| # | 项 | 验收 |
|---|---|---|
| 1 | 三层记忆 | 探针：name 约定四型 / 具名 upsert 幂等（同 name 二次写保 id）/ 合并输入构造 / types 过滤 / level 缺 id 报错 / 截断护栏；e2e 实弹：真实 LLM 摘要两步（写入→增量合并）+ recall types=['summary'] 注入往返 |
| 2 | 自动钩子 | 探针：开关关 → 零行为；开关开 + latestRunId 命中 → 摘要 upsert（mock LLM 注入假摘要，纯函数化核心可测面）；失败不阻断（listener 隔离） |
| 3 | 一致性评测 | 探针：parseEvalScores（正常/围栏/坏行/全坏降级）+ aggregate（均值/排名/并列稳定性）+ renderEvalReport（表格/CSV 结构）；e2e：真实小对照（2 组×1 图）提交 batch + 真实多模态评分 + 报告资产落库 |
| 4 | 翻译链 | platform-adapt v2：target_lang 默认 zh 回归逐字不变 + en 实弹；translate-export 链 e2e 实弹（真实 LLM，命名规范断言 params.lang + 文件名） |
| 5 | 双语字幕/配音 | 探针：buildBilingualSrt 矩阵（对齐/缺失回退/merged 模式）+ resolveVoiceChain 七级（voice_map 命中/缺失原样）；e2e：真实翻译 + 真实 TTS（voice_map 生效断言落 params.voiceSource 链） |
| 6 | 合规审核 | 探针：词库解析（注释/坏行/全角归一）+ scanText 命中矩阵（block/warn/case/多资产）+ parseLlmVerdict 降级 + params 写回结构；e2e：真实词库命中拦截（on_block=fail）+ 放行路径 + 徽章展示 |
| 7 | 工程项 | `probe:m24` 全绿 + 回归（m2a–m23）零适配 + 双端 typecheck + 三层实弹 + review 落盘 + roadmap 校准 |

---

## §5 风险与权衡

- **摘要质量依赖 LLM**：截断护栏（超预算 1.5× 判失败）+ 合并链保持「新素材优先」提示词语义；不做自动回滚（摘要坏 → 具名 upsert 重写即修复）。
- **自动钩子计费**：默认关 + 仅 completed 终态 + 每集产物只算一次（同名幂等覆盖 + 已有 memory_summary 步跳过）；钩子内异常全隔离（onRunSettled listener 既有机制）。
- **评分主观性**：LLM 评分 = 参考信号非结论（报告供人工复核拍板，拍板②语义）；维度固定三项（一致性/风格/质量），不扩多维。
- **双语 SRT 时序**：翻译不改时间戳（译文随 cue）；译文长度不控（烧录换行交 ffmpeg 既有机制，登记备注）。
- **词库覆盖有限**：内置小型基准词库 + 文件可编辑（追加即用，热读不缓存进程外状态——loadRules 每次 action 现读，词库小代价可忽略）；语义级违规靠 LLM 轨兜底；**误放/误杀均可能，产物只加标记与拦截语义，不做法务承诺**。
- **模板 version bump**：platform-adapt v1→v2 走快照即证据机制（旧 run 持旧快照），零迁移成本。

---

## §6 实施批次

| 批次 | 内容 | 验证 |
|---|---|---|
| **P0 基建**（✅ 2026-09-16） | 白名单 +2 + 两 action 骨架 + COMPLIANCE_DIR/示例词库 + 4 提示词骨架 + eval.ts 纯函数骨架 + probe-m24 骨架 | typecheck + 空探针（冒烟 59 项全绿） |
| **P1 批 1**（✅ 2026-09-16） | memory_summary + autosummary 钩子 + recall types + eval run/score 端点与报告 | 探针 summary 32 / eval 27 + 实弹 29 断言（真实出图+多模态评分） |
| **P2 批 2**（✅ 2026-09-16） | platform-adapt v2 + translate-export + buildBilingualSrt + subtitle 翻译链 + voice_map | 探针 translate 9 / bilingual 14 + 实弹 22 断言（含 tts lang 修复，见 review P2-a） |
| **P3 批 3**（✅ 2026-09-16） | compliance action 双轨 + 报告 + rules 端点 + 前端徽章 | 探针 compliance 34 + 实弹 12 断言 + 浏览器徽章双态 |
| **P4 收口**（✅ 2026-09-16） | 探针全量 + 回归 + 实弹 + review + roadmap 校准 | 116 项全绿 + 21 探针零适配 + 双端 tc=0 + 文档落盘 |

---

## §7 探针设计（`probe-m24`）

| 节 | 断言数（约） | 内容 |
|---|---|---|
| `summary` | 14 | name 四型约定 / upsert 幂等保 id / 合并输入构造（旧摘要+新料）/ level 缺 id 报错 / 截断护栏 / recall types 过滤 / 自动钩子开关与关联（mock 注入） |
| `eval` | 12 | parseEvalScores 正常/围栏/坏行/全坏降级；aggregate 均值·min/max·排名·并列；renderEvalReport md+CSV 结构；变体展开（base+patch 合成断言） |
| `translate` | 8 | target_lang 默认 zh 注入回归（prompt sections 组装）/ 命名规范纯函数（translated-{lang}.{ext} / .{lang}.srt）/ params.lang |
| `bilingual` | 12 | buildBilingualSrt（对齐/缺句回退/merged/时间戳保持）+ 翻译契约解析 + resolveVoiceChain 七级（voice_map 命中/无 lang/缺失原行为） |
| `compliance` | 16 | loadRules（注释/坏行/归一化）/ scanText 命中矩阵（block/warn/大小写/全角/多词计数/空文本）/ parseLlmVerdict（正常/坏 JSON 降级）/ params 写回结构 / on_block 双语义 / rules 视图聚合 |

- 纪律：内存临时库（`acs-probe-*`）零网络零计费；**LLM/真实供应商调用不探针**（纯函数拆测 + e2e 实弹）；探针日志 JSON 行格式对齐既有

---

## §8 明确排除

- **图像/视频多模态合规审核**（本轮文本为主；视觉合规待词库+通道成熟后另议）
- **法务级合规承诺**（内置词库为小型基准 + 文件可自行扩充；产物 = 标记与拦截语义，非审查意见）
- **翻译自动化重写/回灌原链**（翻译产物为独立资产 + gate 人工审阅）
- **配音音色克隆的多语言化**（克隆声线仍按源语言实践；voice_map 只做名字映射）
- **评测统计显著性检验**（样本量小 = 描述统计矩阵；A/B 平台化流量分割非本里程碑范畴——M20 A-B 为运营投放侧，此为创作质量侧）
- **摘要层新表/新列 / 摘要自动过期 TTL**（memories 开放字段承载；过期 = 重写覆盖）
- **词库在线编辑 UI / 多词库文件管理**（数据文件手工维护）
- **海外发布平台直连 API**（导出即产物；平台化归 M20 已交付形态）
- **合规拦截全局引擎钩子**（独立 action 编排形态，拍板④；不侵入 engine 主链）
