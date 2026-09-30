# M24 review — 内容质量与国际化（F1–F5）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-16（**已完成**：P0–P4 全节落盘）
- 对应 spec：`2026-09-16-agencys-content-studio-m24-design.md`（§4 验收 + §6 实施）
- 判定（P0）：**基建完成**——KNOWN_ACTIONS +2（memory_summary / compliance_check）+ 两服务骨架（memory-summary / compliance）+ 两 action 骨架 + eval 纯函数骨架 + 示例词库（74 行）+ 4 提示词骨架 + probe-m24 骨架；`probe:m24` 冒烟 59 项全绿 + 双端 typecheck。
- 判定（P1）：**批 1（三层记忆摘要 + 一致性评测）完成**——探针 summary 32 / eval 27 全绿；实弹摘要链 14 断言（具名 upsert 合并保 id 20→20、types 召回往返）+ 评测链 15 断言（真实出图 2 组对照 + 真实多模态评分 + 报告资产落库）。
- 判定（P2）：**批 2（翻译双形态 + 双语字幕/配音）完成**——探针 translate 9 / bilingual 14 全绿；实弹 22 断言（PA-zh 回归逐字不变 4 + PA-en 目标语言产出 5 + translate-export 链 5 + 双语字幕/voice_map 8）；期间发现并修复 tts lang 真 bug（见「偏差与修复记录」）。
- 判定（P3）：**批 3（合规审核）完成**——compliance 节扩至 34 项全绿（词库解析/scanText/parseLlmVerdict/合成矩阵/写回/rulesView/on_block 双语义）；`GET /compliance/rules` 端点挂载；前端资产预览徽章三态；实弹 12 断言（真实词库拦截链 6 + 放行 + 真实 LLM 复审链 5 + rules 视图 1）+ 浏览器徽章双态 DOM 验证。
- 判定（P4）：**全量收口完成**——`probe:m24` 五节 **116 项全绿** + 回归 **21 探针（m2a–m23）零适配全绿** + 双端 typecheck exit=0 + 测试产物零残留；review 落盘 + roadmap 校准 + README 速览。
- 证据采集方式：`probe:m24`（内存/临时库 `acs-probe-m24-*`，纯函数 + mock ctx，零网络零计费）+ 真实开发库实弹（:3001，临时项目软删归档）+ 真实 LLM/出图/TTS 通道（评测、翻译、复审、配音各环节实际计费调用）+ browser-use（徽章 DOM class/色值/title 校验，:5174）。

---

## 验收矩阵对照（spec §4 #1–#7）

### #1 三层记忆/摘要双形态
- 显式 `memory_summary` action（scope=project/series/episode/custom 四级命名 + merge 语义 + 900 字 guard）+ settings `memory.auto_summary` 自动钩子（默认关；run completed + 集关联 + 模板无显式步防双份计费）。
- 探针 32 项 + 实弹 S 链 14 断言（upsert 二次写保 id、`recall types=[summary]` 只返回摘要）。**✅**

### #2 一致性 A/B 评测
- `POST /evals/run`（模板多组出图）+ `POST /evals/score`（多模态评分矩阵 2–6 组 × ≤24 图）+ aggregate/renderEvalReport（均值/排名/并列字典序稳定 + md 表 + CSV 段）；报告 purpose=eval_report 落库。
- 探针 27 项 + 实弹 15 断言（真实出图对照 + 真实多模态评分 + 报告落库）。评分主观性按 spec §5 定性为参考信号。**✅**

### #3 翻译链双形态
- platform-adapt v2 `target_lang`（缺省 zh 产物名/purpose 逐字不变回归 + en 实弹正文分节英文化）+ 独立 translate-export 模板链（`translated-{lang}.md` 命名 + memory type=translation 沉淀）。
- 探针 T1–T8b 9 项 + 实弹 9 断言（含 zh 回归 905 汉字逐字不变）。**✅**

### #4 双语字幕/多语言配音
- buildBilingualSrt（both/merged 双形态 + 缺失句回退原文 + ms→SRT 换算 + end<start 收敛）+ subtitle action 接线（estimated + target_lang）+ TTS voice_map（resolveVoiceChain 七级，line > voice_map > params 旧行为逐字不变）。
- 探针 BS1–BS7 / PC1–PC3 / VM1–VM4 共 14 项 + 实弹 BL 8 断言（真实 TTS：`params.voiceSource=voice_map` 命中 SiliconFlow CosyVoice2 音色 + 双产物 zh-en.srt/en.srt + params.lang 标注）。**✅**

### #5 合规审核
- 本地词库（`workspace/compliance/words.txt` 现读即用，注释/坏行/全角归一）+ LLM 可选复审双轨（parseLlmVerdict 坏 JSON/非法 verdict → null 宽容降级）+ 合成矩阵（词库 block ∪ LLM block → block；warn 并集）+ 标记落 `assets.params.compliance`（零新列，对齐 params.quality 先例）+ on_block fail/mark 双语义 + 报告 purpose=compliance_report + `GET /compliance/rules` + 前端预览徽章三态（comp-pass/warn/block）。
- 探针 34 项 + 实弹 12 断言（block 命中 → run failed + 标记仍写回 + 报告落库 llm:null；干净文本 + LLM 复审 → completed + verdict=pass）+ 浏览器徽章双态（block rose-400 / pass green-500，title 含 status·hits·时间）。**✅**

### #6 明确排除守住（spec §8）
- 法务意见承诺、多语言 UI 界面、TTS 语言自动检测、翻译质量自动评分、合规自动改写修复——均未实施；词库免责声明行在位。**✅**

### #7 工程项
- `probe:m24` 116 全绿；回归 21 探针零适配；双端 typecheck exit=0；三层实弹；本 review + roadmap + README。**✅**

---

## 偏差与修复记录

### P2-a：tts `lang` 读取错置（真 bug，实弹发现）
- **现象**：BL3 实弹 FAIL——`params.voiceSource=instance`（期望 voice_map 命中）；探针 VM1–VM4 直测纯函数无法暴露。
- **根因**：`ctx.input` 语义 = **步骤 inputs 映射解析后的结果**（context.ts），不是 run input 全量；模板 tts 步未显式接线 `lang: input.lang` 时 `ctx.input['lang']` 为空 → voice_map 级被跳过。spec §2.5 契约「lang=run input.lang」与实现取值路径不一致。
- **修复**：tts.ts lang 解析在 ctx.input 未命中时回落 `JSON.parse(ctx.run.input)`（非法 JSON 静默视为无 lang，不影响主链）。
- **教训**：步骤级 ctx.input 键需模板接线；跨步骤上下文值应读 run.input——纯函数探针不能替代端到端实弹。

### P2-b：PA-en4 断言过严（定性为断言缺陷，非实现 bug）
- **现象**：首跑 FAIL「汉字 738 > 英文词 195」。
- **定性**：取产物细看——正文/标题/标签确为英文；中文来自风险清单「原文」列（spec §2.4 明示保留原句供对照）+ 结构行。实现符合契约。
- **修复**：断言改为按「小红书版」分节提取判定（英文词 ≥60 且汉字 ≤100），并增 PA-en5「风险清单节保留」正向断言。

### P4-a：回归批跑脚本误报（工具噪音）
- PowerShell `-match` 默认大小写不敏感，探针输出中运行噪音行「Failed query…」（libsql 临时库并发下既有噪音，m10/m17 均有且不影响判定）被 `FAIL` 模式误计致 m10 显示 BAD；以区分大小写口径单跑复核 `probe-m10` →「全部通过」零 FAIL 断言行。回归真实结论：**21 探针全绿零适配**。

---

## 静态与探针

- **探针**：`probe:m24` 五节 **116 项全绿**（summary 32 / eval 27 / translate 9 / bilingual 14 / compliance 34；2026-09-16 复跑）；`probe:m24 --section=compliance` 分段可独立运行。
- **回归**：21 个探针（m2a / m3 / m4 / m6–m19 / m21 / m22 / m23）全量顺序复跑全绿，**零适配**（M24 未触碰引擎/DAG/模板加载签名）。
- **类型**：server `tsc --noEmit` / web `vue-tsc --noEmit` 双端 exit=0。
- **实弹汇总**：HTTP 层 63 断言（P1 29 + P2 22 + P3 12）+ 浏览器徽章双态 DOM 验证；真实计费通道触达：LLM 文本（摘要/翻译/复审）、图像生成（评测对照）、多模态评分、TTS 配音。
- **测试产物清理**：P1–P3 全部临时项目（12 个）软删归档（`mode:archived`）；3 个 e2e 临时模板（m24-e2e-summary / m24-e2e-bilingual / m24-e2e-compliance）用毕即删，模板目录恢复原状；探针临时库自清理。

---

## 变更文件清单

- **服务端新增（9）**：`pipeline/actions/memory-summary.ts`、`pipeline/actions/compliance-check.ts`、`services/memory-summary.ts`、`services/memory-autosummary.ts`、`services/compliance.ts`、`services/eval.ts`、`services/eval-service.ts`、`routes/eval.ts`、`routes/compliance.ts`
- **服务端修改（9）**：`pipeline/actions/index.ts`（注册 +2）、`pipeline/loader.ts`（KNOWN_ACTIONS）、`pipeline/actions/memory-recall.ts`（types 过滤）、`pipeline/actions/subtitle.ts`（双语/翻译链）、`pipeline/actions/tts.ts`（voice_map + lang 回落修复）、`services/memory.ts`（具名 upsert/getSummaryContent）、`services/creation/gen/subtitle.ts`（buildBilingualSrt 纯函数族）、`app.ts`（两路由挂载）、`env.ts`/`index.ts`/`package.json`（COMPLIANCE_DIR、钩子接线、probe:m24 注册）
- **Web 修改（3）**：`lib/format.ts`（parseAssetCompliance）、`components/asset/previewer/use-asset-previewer.ts`（徽章 computed 三件）、`previewer/index.vue`（顶栏徽章 + 三态样式）
- **workspace（7）**：`compliance/words.txt`（74 行基准词库）、`prompts/`（memory-summary / eval-consistency / translate-text / translate-lines / compliance-review 五枚 + adapt-text.md 目标语言段升级）、`templates/platform-adapt.yaml`（v2）、`templates/translate-export.yaml`（新）
- **探针（1）**：`scripts/probe-m24.ts`

---

## 局限与备注

- 词库为小型基准表（55 词实用度最高的广告极限词为主），误放/误杀均可能；产物仅「标记/拦截」语义，文件头免责声明在位，业务扩充按平台规则库自建。
- LLM 复审与评分为概率性输出：断言按 spec §5 容忍 warn/pass 双态与 null 降级；并列名次以字典序保证确定性。
- 评测对照为小样本（2 组 × 1 图）冒烟；统计显著性非本轮目标（报告供人工复核定位）。
- 自动摘要钩子的防双份计费判据 = 「模板含 memory_summary 步」显式判断；跨模板同项目混用时以显式步为准。

## 验证方式（已完结）

- 复跑：`pnpm --filter @acs/server exec tsx scripts/probe-m24.ts`（五节 116 项）；回归 21 探针；server `tsc` + web `vue-tsc`。
- 徽章证据截图：`.qoder/tmp-m24-badge-block.png` / `tmp-m24-badge-pass.png`。
- 相关文档：L1 spec `2026-09-16-agencys-content-studio-m24-design.md`；纲领 `2026-09-14-agencys-content-studio-m19-m27-charter.md`（§一 F 组）；roadmap M24 注记（本日校准收官）。

（全文完：P0–P4 全节落盘；spec §4 验收 #1–#7 全部通过。）
