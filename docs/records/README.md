# 里程碑设计留档索引（records）

本目录是 **agencys-content-studio 全部设计/规划文档的唯一落点**（活文档在 `docs/` 上层，随功能演进更新；本目录落笔即冻结、不回改）。

## 一句话用法

想知道「某期到底做了什么、有没有设计依据、代码交付了没」→ 直接查下面的**覆盖总表**：
- **设计稿/评审** 列 = 本目录有没有对应详细文档；
- **探针** 列 = 该期是否在代码里交付并有自动化验证（`probe-mNN`）；
- 标 ❌ 的行 = **没有独立设计稿**（多为"补录"项或走了并行编号专题），以 [milestones.md](../milestones.md) 能力速览 + 探针为准。

## 覆盖总表（M01–M56）

| 里程碑 | 主题 | 设计稿 | 评审 | 探针 | 备注 |
|---|---|---|---|---|---|
| M01 | 工程骨架 | [design](M01-工程骨架-design.md) | [review](M01-工程骨架-review.md) | — | |
| M02 | 流程引擎化 | [design](M02-流程引擎化-design.md) | [review](M02-流程引擎化-review.md) | — | |
| M03 | 多类型与记忆 | [design](M03-多类型与记忆-design.md) | [review](M03-多类型与记忆-review.md) | ✅ m3 | 计划 [M03-计划](plans/M03-计划.md) |
| M04 | 打磨分发 | [design](M04-打磨分发-design.md) | [review](M04-打磨分发-review.md) | ✅ m4 | 计划 [M04-计划](plans/M04-计划.md) |
| M05 | 方法论内化 | [design](M05-方法论内化-design.md) | — | — | 纯模板/提示词，零新 action |
| M06 | 参考图驱动生成 | [design](M06-参考图驱动生成-design.md) | — | ✅ m6 | 计划 [M06-计划](plans/M06-计划.md) |
| M07 | 镜头轻工作台 | [design](M07-镜头轻工作台-design.md) | — | ✅ m7 | |
| M08 | 场景道具资产库与风格预设 | [design](M08-场景道具资产库与风格预设-design.md) | — | ✅ m8 | |
| M09 | 小说改编链 | [design](M09-小说改编链-design.md) | — | ✅ m9 | |
| M10 | 分镜编辑器 | [design](M10-分镜编辑器-design.md) | — | ✅ m10 | |
| M11 | 合成与声音增强 | [design](M11-合成与声音增强-design.md) | — | ✅ m11 | |
| M12 | 旧版本清理与图像检测 | [design](M12-旧版本清理与图像检测-design.md) | [review](M12-旧版本清理与图像检测-review.md) | ✅ m12 | |
| M13 | 素材链补全 | [design](M13-素材链补全-design.md) | [review](M13-素材链补全-review.md) | ✅ m13 | |
| M14 | 集级参数与剧集地图 | [design](M14-集级参数与剧集地图-design.md) | [review](M14-集级参数与剧集地图-review.md) | ✅ m14 | |
| M15 | 流水线画布工作台 | [design](M15-流水线画布工作台-design.md) | [review](M15-流水线画布工作台-review.md) | ✅ m15 | |
| M16 | 创作画布 | [design](M16-创作画布-design.md) | [review](M16-创作画布-review.md) | ✅ m16 | |
| M17 | 创作工作台 | [design](M17-创作工作台-design.md) | [review](M17-创作工作台-review.md) | ✅ m17 | |
| M18 | 画布四批能力补齐 | [design](M18-画布四批能力补齐-design.md) | [review](M18-画布四批能力补齐-review.md) | ✅ m18 | |
| M19 | 成片品质与品牌化 | [design](M19-成片品质与品牌化-design.md) | [review](M19-成片品质与品牌化-review.md) | ✅ m19 | M19–M27 见 [纲领](纲领-M19-M27-charter.md) |
| M20 | 运营自动化与复盘闭环 | [design](M20-运营自动化与复盘闭环-design.md) | — | — | ⚠️ milestones.md 无此速览条目（疑并入/调整） |
| M21 | 工作台体验 | [design](M21-工作台体验-design.md) | [review](M21-工作台体验-review.md) | ✅ m21 | |
| M22 | 创作画布深化 | [design](M22-创作画布深化-design.md) | [review](M22-创作画布深化-review.md) | ✅ m22 | |
| M23 | 画布规模化与智能编排 | [design](M23-画布规模化与智能编排-design.md) | [review](M23-画布规模化与智能编排-review.md) | ✅ m23 | |
| M24 | 内容质量与国际化 | [design](M24-内容质量与国际化-design.md) | [review](M24-内容质量与国际化-review.md) | ✅ m24 | |
| M25 | 输入源扩展 | [design](M25-输入源扩展-design.md) | [review](M25-输入源扩展-review.md) | ✅ m25 | |
| M26 | 工程基建与平台化 | [design](M26-工程基建与平台化-design.md) | [review](M26-工程基建与平台化-review.md) | ✅ m26 | |
| M27 | 自动编排 orchestrator | [design](M27-自动编排orchestrator-design.md) | [review](M27-自动编排orchestrator-review.md) | ✅ m27 | M27 后备选 [清单](备选清单-post-M27-backlog.md) |
| M28 | 架构重组 | [design](M28-架构重组-design.md) | [review](M28-架构重组-review.md) | — | 巨型文件拆分（split-audit 门禁） |
| M29 | 版本与追溯 | [design](M29-版本与追溯-design.md) | [review](M29-版本与追溯-review.md) | ✅ m29 | |
| M30 | 对话式一句话成片 | [design](M30-对话式一句话成片-design.md) | — | ✅ m30 | |
| M31 | 对话式参考输入 | [design](M31-对话式参考输入-design.md) | — | ✅ m31 | |
| M32 | 智能默认引擎基建 | [design](M32-智能默认引擎基建-design.md) | — | ✅ m32 | M32–M39 见 [纲领](纲领-M32-M39平台智能化-charter.md) |
| M33 | AI 配置智能化 | [design](M33-AI配置智能化-design.md) | — | ✅ m33 | 含 M33.1 极简零重构（速览内） |
| M34 | 模板与运行入参自动化 | [design](M34-模板与运行入参自动化-design.md) | — | ✅ m34 | |
| M35 | 创作流程自动化 | [design](M35-创作流程自动化-design.md) | — | ✅ m35 | |
| M36 | 运营配置自动化 | [design](M36-运营配置自动化-design.md) | — | ✅ m36 | |
| M37 | 收尾与回归 | [design](M37-收尾与回归-design.md) | — | ✅ m37 | 路线图收官 |
| M38 | 扩展参数结构化与默认自动化 | ❌ 无独立稿 | — | ✅ m38 | 承接 M32–M37 裸 JSON 债，见纲领 |
| M39 | 扩展参数逐模型能力下沉 | ❌ 无独立稿 | — | ✅ m39 | 承接 M38，见速览 |
| M40 | 轻松创作确认才立项 | [design](M40-轻松创作确认才立项-design.md) | — | ✅ m40 | |
| M41 | 轻松创作第一批（进度投影/预览/带素材） | ❌ 无独立稿 | — | ✅ m41 | 补录项，见速览 |
| M42 | 轻松创作第二批（审阅暂停/候选/局部返修） | ❌ 无独立稿 | — | ✅ m42 | 补录项 |
| M43 | 轻松创作第三批（画质/逐镜参考/跨轮合并） | ❌ 无独立稿 | — | ✅ m43 | 补录项 |
| M44 | 对白模式（多角色/原生引擎/严格 ASR） | ❌ 无独立稿 | — | ✅ m44 | 补录项；恢复层见 probes/m44 |
| M45 | 轻松创作第四批（品牌贯通/水印片头尾） | ❌ 无独立稿 | — | ✅ m45 | 补录项 |
| M46 | 轻松创作第五批（角色/风格软提示注入） | ❌ 无独立稿 | — | ✅ m46 | 补录项 |
| M47 | 免 ASR 核验对白执行链（路 B） | 🔶 见专题 [精确返修-字幕](精确返修-字幕-design.md) | — | ✅ m47 | 精确返修首切片 |
| M48 | 统一取消/续跑/预算执行保障 | ❌ 无独立稿 | — | ✅ m48 | 审计 F02/F03/F06 |
| M49 | 计费与幂等深化 | ❌ 无独立稿 | — | ✅ m49 | 审计修复 G1–G4 |
| M50 | 剪辑工程交换导出（FCPXML/EDL/OTIO） | 🔶 见专题 [交付包认证](第五期-交付包认证-design.md) | — | ✅ m50 | 认证/返修专题 |
| M51 | 批次与运行删除（记录级清理） | 🔶 见专题 [统一QC面板](第四期-统一QC面板-design.md) | — | ✅ m51 | |
| M52 | 全局素材池 | ❌ 无独立稿 | — | ✅ m52 | |
| M53 | 素材混剪成片 | [photo-montage-spec.md](photo-montage-spec.md) | — | ✅ m53 | |
| M54 | 智能混剪增强 | [montage-ai-spec.md](montage-ai-spec.md) | — | ✅ m54 | |
| M55 | 本地全类型模型接入 | [local-model-integration-spec.md](local-model-integration-spec.md) | — | ✅ m55 | 用户向指南 [../local-zero-code-wiring.md](../local-zero-code-wiring.md) |
| M56 | 轻松创作「毕业通道」（升级专业成片/连载立项） | [M56-轻松创作毕业通道-design.md](M56-轻松创作毕业通道-design.md) | — | ✅ m56 | 立项误编 M48 已修正（与已交付冲突）；另有 M57–M60 立项队列（待评审未实施） |

> 图例：✅ 有 / ❌ 无独立文档 / 🔶 走并行编号专题（见下）/ — 无此项。探针列 `mNN` 指 `apps/server/scripts/probe-mNN.ts`。

## 并行编号：分期返修与质量审计专题

这几份**不是 M 号**，而是一套「第一期~第五期 + 精确返修切片」的审计/返修专题（曾与 M 主线并行推进，是"对不上"感的来源之一）。当前对应关系以各文档抬头为准：

| 文档 | 主题 | 配套计划 | 关联里程碑（速览） |
|---|---|---|---|
| [第一期-生产基线-design.md](第一期-生产基线-design.md) | 真实生产基线与证据口径 | — | 质量审计基线 |
| [精确返修-字幕-design.md](精确返修-字幕-design.md) | 字幕修订闭环 | — | M47 |
| [精确返修-合成输入-design.md](精确返修-合成输入-design.md) | 合成配置本地返修 | [计划](plans/精确返修-合成输入-计划.md) | M48 |
| [精确返修-镜头时长-design.md](精确返修-镜头时长-design.md) | 镜头时长本地返修（轻档） | [计划](plans/精确返修-镜头时长-计划.md) | M48 |
| [第四期-统一QC面板-design.md](第四期-统一QC面板-design.md) | 成片质量只读核验面板 | [计划](plans/第四期-统一QC面板-计划.md) | M50 邻近 |
| [第五期-交付包认证-design.md](第五期-交付包认证-design.md) | 交付包结构/兼容认证 | [计划](plans/第五期-交付包认证-计划.md) | M50 |

## 纲领 / 路线图 / 备选清单（跨期战略文档）

| 文档 | 覆盖 | 内容 |
|---|---|---|
| [路线图-roadmap.md](路线图-roadmap.md) | L0 北极星 | 产品路线图（收入排序） |
| [纲领-M19-M27-charter.md](纲领-M19-M27-charter.md) | M19–M27 | 全量立项纲领（M18 后缺口清零） |
| [纲领-M32-M39平台智能化-charter.md](纲领-M32-M39平台智能化-charter.md) | M32–M39 | 平台智能化改造（决策权移交）立项纲领 |
| [备选清单-post-M27-backlog.md](备选清单-post-M27-backlog.md) | M27 后 | Toonflow 对比沉淀的提升清单 |

## 其他设计留档

| 文档 | 主题 |
|---|---|
| [db-migration-rebaseline-spec.md](db-migration-rebaseline-spec.md) | M1 审计整改：DB 迁移体系 re-baseline 取证与裁定（已执行） |
| [bgm-library-spec.md](bgm-library-spec.md) | 正版曲库入库标签规范 |

## 目录约定

- **归档戳**：2026-09-30 起，本目录每份稿标题下方有一行「归档戳」标注身份（实现真源存档 / 战略活条目 / 已交付决策留痕），用于区分历史快照与待办；戳是元数据标记，正文仍落笔冻结不回改。**被探针/验收文档引用的稿（戳为「实现真源存档」者）勿删勿移**，删除会断 `probe-mNN` 与 `acceptance.md` 的回链。
- **新增入口**：新里程碑设计/评审稿直接写本目录，命名 `M{编号}-{中文主题}-{design|review}.md`；实施计划入 `plans/`（`M{编号}-计划.md`）。**禁止**放 `docs/` 上层或到仓库外起草。
- **落笔即冻结**：本目录是历史决策快照，不回改正文；现状以活文档 + [milestones.md](../milestones.md) 为准。
- **历史路径读法**：早期迁入稿正文里残留的 `docs/superpowers/specs/…`、`file:///d:/work/AI/…` 是**起草当时的原文**，属快照不回改；文件实际都已在本目录（仓库外那份 `d:\work\AI\docs` 已由用户删除，仓库为唯一家）。
- **活文档禁止外指**：`milestones.md`/`acceptance.md`/代码注释一律指向 `docs/records/…` 仓库内可达路径，不得出现仓库外/superpowers 路径（对 Gitee 读者不可达）。
