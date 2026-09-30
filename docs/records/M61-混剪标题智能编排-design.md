# M61 L1 Spec — 混剪开场标题「智能编排 + 标题字卡」三期一体

> **状态：~~待用户评审批准；未获批不改业务代码~~ → 已批准已交付（用户「三期一起立项」+「开工」，2026-09-30 三期全量门禁全绿，验收快照见 docs/acceptance.md）。** 构建在 M53（photo-montage）/ M54（智能混剪增强）能力之上，不推翻其契约。
> 前置复核：编号以最新 roadmap 为准（M57–M60 已被轻松创作队列占用且待评审未实施，本项独立混剪线，取 **M61**）。
> 归档戳（2026-09-30）：本稿获批实施后正文冻结（除实测推翻假设的划线修正与实施补注：期3 force_style 覆盖面、期2 失败收敛语义），交付状态已回写 [索引](README.md) 与 docs/milestones.md。
> 用户授权：「三期一起立项」——本文一次覆盖 期1（规则智能排版 + 本地字卡，零计费）/ 期2（LLM 智能排版 + AI 背景字卡，可选付费）/ 期3（per-line 多 ASS Style 分层排版），实施按期递进、逐期门禁。

## 一、背景与现状（已核实到行，2026-09-30 源码实态）

- `workspace/templates/photo-montage.yaml`（builtin, v2）：`captions` 步 = `subtitle` `params.mode=fixed`（`ms_per_line:4000 / lead_in_ms:500`，零 LLM 逐行定长出 SRT）→ `compose` 步 `ffmpeg_merge` 烧录。
- 样式解析链（`ffmpeg-merge/index.ts` L385–393）：`brand.subtitle` 结构化（平台/项目/run 三层手工，`resolveBrandConfig`）> `subtitle_style` 旧串（params 或 `defaults.video`）> `defaultSubtitleStyle(height)`（固定 字号=H×0.04 / 白字黑边 / 底部 MarginV=H×0.02）。
- **关键事实**：`SubtitleStyleConfig`（`services/brand-config.ts` L41–51）已完整建模 `font / size_pct / color / outline_color / outline_pct / shadow / margin_v_pct / alignment(2底/5中/8顶) / bold` 九字段，`buildSubtitleStyle` 已消费，`sanitizeSubtitleStyle` 已有 clamp 防线——**缺的不是样式能力，是"自动决策者"**。
- ASS 烧录（`subtitle-ass.ts`）：单 `Default` Style，全部 cue 共用；`srtToAss(srt, {width,height,fontSize})` 纯函数。
- 混剪归一化（`montage.ts`）：`normalizeSegmentsToClips` 逐段出定长带音轨 mp4，图片段可 zoompan；`Segment{id:number(资产id),path,kind,durSec,explicit?,estimated?,paths?}`。
- M54 先例（本盘范式来源）：`ken_burns:auto` = 纯规则实测零计费；`analyze_composition` = LLM 可选付费 bool 开关；`bgm_mode:music_gen` = 付费失败自动降级库内。M61 全部沿用该「规则默认 + LLM 开关 + 宽容降级」三件套。
- `kind:text` 输入直通（`refs.resolveInputs` 通用机制；`subtitle.ts` L289 / `compliance-check.ts` L36 同法读取）→ compose/captions 步可直接取 `ctx.input['title']` 字符串。
- 样式消费点全量审计（一次收口）：① `index.ts` L388 主链；② `subtitle-ass.buildAssBurnPaths`（主路 + 派生各路）；③ 成片 params `subtitle_style` 快照（index L644）；④ `manual-display.ts` L220/L240（免烧快速路径 style 比对，不一致自动走重合成——既有机制承接，零改动）；⑤ `rework/baseline.ts` L350 composeTrace。

## 二、目标与非目标

**目标**
1. 期1：`photo-montage` 开场标题**规则智能排版**（按标题长度/行数/画幅自适应字号、位置、描边、粗细）+ **本地渲染标题字卡**（色底 + drawtext 排版，零 LLM 零付费）插入片首。
2. 期2：`style_mode:'llm'` LLM 智能排版（风格调性感知，失败降级规则层）+ `title_card:'ai'` AI 生成背景字卡（复用 ai_text+ai_image 既有 action，未配置/失败降级 local）。
3. 期3：**per-line 多 Style 分层排版**——标题行大字居中粗体、祝福语行小字底部（ASS 多 Style + cue→style 映射），与字卡观感统一。

**非目标（登记不混入）**
- 字体艺术设计（花字/外部字库管理/多字体族）；HTML 渲染 fancy 字卡（成本高、依赖渲染链，不入本期）；
- Web 品牌设置页改造（smart 产物只进资产/成片 params，UI 面留后）；
- 新 action / 新表 / 新列 / 新付费面（全部复用 subtitle / ffmpeg_merge / ai_text / ai_image 既有件，`KNOWN_ACTIONS` 零增）；
- 严格交付（批准链）路径——`strict` 下 smart/字卡恒关（同 M53 montage 红线）。

## 三、方案决策（自行拍板，附理由）

| 决策点 | 选择 | 理由 / 已否决替代 |
|---|---|---|
| 智能样式优先级 | `brand.subtitle 手工 ⊕ style_plan 智能` **字段级浅合并，手工字段恒胜**；其后 legacy 旧串 > default | 用户显式配置不得被自动决策覆盖；字段级合并与品牌三层解析同构（`mergeBrandLayers` 先例）。已否决"智能整体接管"——会废掉品牌配置面 |
| 默认行为 | 新入参 `style_mode: select [off, rule, llm]` 默认 **off**；`title_card: select [off, local, ai]` 默认 **off** | off = 现行链逐字节不变（零 diff 红线）；模板 v2→v3 向后兼容 |
| 启用态如何传进 subtitle 步 | captions/compose 两 YAML 步各加 `inputs: {style_mode: input.style_mode, title_card: input.title_card}`（select 值经 `resolveInputs` 字符串直通） | 步 params 是静态值表达不了 input 引用；已否决"subtitle 猜 title 行数"——title/body 分界只有 collectSource 内部知道 |
| title/body 分界真源 | `collectSource` 返回 `titleLines`（`text` 字面输入=标题、`script` 资产=正文的行数分界，现状语义）；启用态时写入字幕资产 `params.title_lines` | 不新增输入项；与现行"标题在前、正文在后"的 cue 顺序一致（fixed 模式行↔cue 1:1） |
| 字卡实现 | 引擎内 `buildTitleCardArgs` 纯函数：`lavfi color` 底色（`title_card_bg` 默认 `#101826`）→ 逐行 `drawtext`（字号/颜色/粗细/垂直位置 = 期1 样式决策产物）→ 单帧 PNG → 作为**片首 image 段**入既有 `normalizeSegmentsToClips` 归一链 | 零依赖零计费、字体排版精确可控、探针可断言 args 形状；已否决 ①AI 直出"带标题图"（文生图画汉字必乱码——公认失效面）②走 `brand.intro`（该槽面向视频素材，probeMediaDuration 对图片失败→跳过，语义错配）③模板层拼 photos（photos 顺序=用户勾选顺序即时间轴契约，插卡破坏该契约） |
| 字卡与 SRT 标题行去重 | `title_card≠off` 时 ASS 生成裁掉前 `title_lines` 个 cue（标题由字卡呈现），正文 cue 保留；`srtToAss` 加 `opts.cutCues?: number`（缺省→输出逐字节不变） | 同一文本双呈现是明显观感缺陷；裁 cue 在生成侧做，SRT 资产只读不动（M29 不可变契约） |
| 字卡免 Ken Burns | `Segment` 加可选 `card?: true`；归一化对该段强制 kb=null（定帧分支） | 文字随 zoompan 推拉可能裁切出框；静置字卡是行业标准观感 |
| 字卡时长 | 卡段 `durSec` = 资产 `params.title_lines × ms_per_line + lead_in_ms`（clamp [1.5s, 10s]）；无 captions 产物（未填标题）→ 不产卡 + log | 与字幕节奏同源；已否决固定 duration_per_shot——标题行多时卡先切走标题没读完 |
| drawtext 字体 | `resolveCjkFont()`：env `ACS_CJK_FONT_FILE` > Windows `C:\Windows\Fonts\msyh.ttc` > `simhei.ttf` > Linux Noto 路径；全部落空 → **跳过字卡 + log**（正文照常烧录） | 宽容降级先例：片头时长探测失败跳过不抛错；libass 走 fontconfig 与 drawtext fontfile 不同源，故独立解析 |
| 期2 LLM 排版 | `style_mode:'llm'`：subtitle fixed 内调用 `chatCompleteDetailed`（新提示词 `workspace/prompts/title-style.md`，输入标题文本/行数/画幅/场景 label）→ JSON → 逐组 `sanitizeSubtitleStyle` 清洗 → `params.style_plan`；任何失败（无实例/超时/JSON 坏/字段全非法）→ **降级 rule 层 + log**；计费 `recordLlmUsage` 记入 | estimated 分支已有同构 LLM 调用与失败回退先例；清洗防线现成 |
| 期2 AI 背景 | 模板加 `card_bg` 子链：`ai_text`（prompt_tpl=`title-card-bg.md`，产单镜 shots JSON）→ `ai_image`（inputs.shots=steps.card_bg.assets，batch 单镜）→ compose `inputs.card_bg_image`；卡底图=该图 scale/crop 满幅 + `drawbox` 半透明压暗 + drawtext 标题；未配置付费面/步失败 → 降级色底 local（`after_skipped: continue` 既有机制）。**实施补注（2026-09-30 T6）**：引擎失败收敛语义为「同步任一失败步即 run failed」，`after_skipped` 只放行跳步——降级边界校准为：compose 侧对「缺底图产物」恒降级色底（防线，卡照常出）；子链显式失败（未配 LLM/图像实例、断网）时 run 报错可改 local 重跑，与 M54 analyze_composition 等全部付费开关同构；另 `card_bg` 需显式 `after: [captions]`——缺省依赖前一步 analyze（when 门控默认跳过）会级联 skip 使子链永不可达；成片溯源增键 `title_card.mode=ai|local` | 全部复用既有 action；文字绝交给药模型、底色可 AI 的分工是乱码坑的正解 |
| 期3 多 Style | `srtToAss` 加 `opts.styles?: Array<{name, cfg}>`（Default 之外生成 `Title1` 等 Style 行），`opts.cueStyle?: number[]`（cue→样式组下标，源=资产 `params.style_plan.cue_style`）；Dialogue 行 Style 字段选择；~~force_style 仍只作用 Default（现状语义不变）~~ | 分层排版是"标题大字/祝福语小字"唯一正解；缺省参数零 diff。**实施补注（实测推翻原假设）**：本机 libass 的 force_style 逐字段覆盖**所有** Style 行（非仅 Default），会把具名组字号/落位打平毁掉分层；正解 = 多 Style 启用时各路烧录省略 force_style（args.ts `assLayered`），Default 行由 `defaultCfg`（合并主样式）经 `assStyleRow` 全量承接（字号仍走基线链）；无 style_plan 存量链逐字节不变 |
| 溯源记录 | 成片 `params.montage` 启用时追加 `title_card: 'local'|'ai'`、`title_style: 'rule'|'llm'`（仅实际启用追加，M54 `layout`/`kb_applied` 先例）；`subtitle_style` 快照键记录生效串现状机制自动承接 | stale 检测与返修基线（rework/baseline）无需改动即拿到真实溯源 |

## 四、三期任务分解（按期递进，逐期门禁）

### 期1（Task 1–4，零计费）

- **T1 规则排版纯函数**：新文件 `pipeline/actions/subtitle.ts` 内导出 `planTitleStyle(lines: Array<{text, role: 'title'|'body'}>, opts: {height, width}) : {style: SubtitleStyleConfig, cue_style: number[]}`——规则：单行短标题（≤8 字）→ `size_pct .06 / bold / alignment 5`；长标题→ 按 `estimateMaxCharsPerLine` 反推不溢出的最大字号（0.04–0.06 带内）；正文行 → `.04 / alignment 2`；竖屏（H>W）描边加粗一档。subtitle fixed 步 `style_mode ∈ {rule, llm}` 时产 `params.style_plan`（含 style/cue_style/title_lines）；**off/缺省 → asset params 键零增**。
- **T2 样式链接入**：`index.ts` L385 段改链：`subtitle` 资产 `params.style_plan.style` 与 `brand.subtitle` 字段级合并（手工胜）→ `buildSubtitleStyle`；无 style_plan → 现链逐字节。`buildAssBurnPaths` 透传合并后 cfg。
- **T3 字卡**：`ffmpeg-merge` 新文件 `title-card.ts`：`buildTitleCardArgs(opts): string[]` 纯函数 + `resolveCjkFont()`；`montage.ts` 归一化支持 `seg.card`；`subtitle-ass` 支持 `cutCues`；`index.ts`：`params.title_card ∈ {local, ai}` 且启用且有标题文本 → 生成 PNG → unshift 段 → 后续链照常（xfade/BGM/封面自动包含）。派生画幅路：卡段在归一化前插入 → 各路尺寸归一自动覆盖（零特判）。
- **T4 模板与文档**：`photo-montage.yaml` v3：新增 inputs `style_mode`/`title_card`/`title_card_bg`（text，选填）+ captions/compose 两步入参接线；`docs/templates.md` 活文档同步版本行与入参表。

### 期2（Task 5–6，付费开关）

- **T5 LLM 排版**：`subtitle.ts` fixed 分支 `style_mode:'llm'` → 加载 `title-style.md` 调 LLM → 清洗 → 并入 `style_plan`（记 `style_source:'llm'|'rule-fallback'`）；新提示词文件 `workspace/prompts/title-style.md`（输出严格 JSON、示例两则）。
- **T6 AI 背景卡**：新提示词 `workspace/prompts/title-card-bg.md`（标题→无文字纯氛围背景 t2i 描述，显式禁止画面出现文字）；模板加 `card_bg` 两步（`when: input.title_card == ai`、`after_skipped: continue`）；compose 消费 `card_bg_image`（有底图分支：`-i img` + scale/crop + drawbox 压暗 + drawtext）；`ai_image` 产物 purpose=`title_card_bg` 走既有注册链。

### 期3（Task 7）

- **T7 分层排版**：`srtToAss` 多 Style 文档生成 + `cueStyle` 映射；`index.ts` 把 `style_plan.cue_style` 传入；字卡 drawtext 行样式与 cue_style 同源（标题/正文分组的字号颜色一致，卡与幕一台戏）。零 diff 红线：`styles/cueStyle` 缺省 → 文档输出逐字节=现状。

## 五、零 diff 红线清单（全部可选项默认 off）

1. 现行 `photo-montage` v2 run（不传新参）→ captions/compose 资产 params、ASS 文档、ffmpeg args、成片 params 逐字节不变。
2. 其余含 subtitle/ffmpeg_merge 的 18 模板零触碰（新键只由新 input 值驱动）。
3. `buildSubtitleStyle(H, {}) === defaultSubtitleStyle(H)` 恒等保持；`srtToAss` 无新 opts 输出不变；`buildNormalizeArgs` 无 `card` 标记输出不变。
4. strict/批准链恒不进 smart 与字卡（`strict → montageEnabled false` 同位防线，compose 入口显式 `strict && title_card off 强制`）。
5. `engine.ts/refs.ts/loader.ts/KNOWN_ACTIONS` 零改动（0 新 action）；`schema.ts` 零改动（0 新表新列，扩展全部落 JSON params）。
6. Web 零改动：模板 input 表单按 YAML 通用渲染 select/text（既有能力）。

## 六、探针与验收门禁（probe-m61，分节对应任务）

- **纯函数节**：`planTitleStyle` 规则真值表（短/长/多行/竖屏/混合角色）；`buildTitleCardArgs` args 形状（色底/drawtext 逐行/字体缺失分支）；`srtToAss` cutCues 前后事件数、多 Style 文档结构、**缺省零 diff 用例**（旧输入新代码 = 旧输出逐字节）；`sanitizeSubtitleStyle` 对 LLM 畸形 JSON 的清洗全丢弃回落。
- **实弹节（零计费）**：tsx 生成 2 测试图 → 直调引擎 `title_card:'local' + style_mode:'rule'` 全链 → ffprobe 断言：总时长 = 卡段 + Σd、首段为卡（时长=title_lines×4s+0.5s）、画面含文字（抽帧比对非纯色）、ASS 事件数 = 原 − title_lines；`title_card:'off'` 对照组逐字节 = M53 基线。
- **LLM/AI 节**：离线 mock `chatCompleteDetailed`（isolatedEnv 模板）断言清洗与降级；`ai_image` 实弹仅在配置了图像实例时跑（守卫 skip 沿用既有探针范式）。
- **模板静态节**：photo-montage v3 合法 + `validate:templates` 0 错 0 警 + 版本行。
- **门禁序列**（每 Task 完成即跑，全绿再下一 Task）：`pnpm -r typecheck` → `probe-m61` → 交付前全量 `run-probes --jobs=1` 串行零红灯（权威口径）→ `docs/acceptance.md` 增验收条目。

## 七、留档与文档动作

- 本稿获批后：`docs/records/README.md` 覆盖总表加 M61 行；`路线图-roadmap.md` 追加混剪线条目（获批/实施状态随门禁回写）。
- 交付时：`docs/milestones.md` M61 能力速览；`docs/templates.md` photo-montage 版本行 v3；实施计划落 `docs/records/plans/M61-计划.md`（获批开工时起草）。
