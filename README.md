# agencys-content-studio（百工工作室）

本地单机内容创作工作室：模板化流水线 + 统一资产体系 + 供应商适配层。

`agencys-content-studio` 是工程仓库名；Web 工作台显示品牌为「**百工工作室**」（副标题「模板化流水线工作台」）。

**状态**：M1 → M62 全部交付。一键质量门禁 `pnpm ci:check`（双端 typecheck + 模板校验 + 全量探针，最新基线 **63 探针 / 5569 断言**全绿，2026-10-08）。各里程碑能力明细 → [docs/milestones.md](docs/milestones.md)（M2–M62），历史验收记录 → [docs/acceptance.md](docs/acceptance.md)。

## 三条创作入口

### 轻松创作（`/create` · 对话式出片）

一句话描述想法 → 看方案卡 → 确认一次 → 自动产出 30–90 秒、最多 16 镜的多镜头成片（动态 / 图文明确标注）。无需先建项目、选模板或操作闸门；**确认方案前不生成任何媒体、零计费**。

- **参考输入**：对话里上传参考图（风格 / 首帧 / 主体一致性）、参考视频（内容解析）或 BGM（背景乐），方案与成片受其约束——参考进 planHash（确认即执行）、能力不支持不静默降级、参考里没有的信息不编造
- **过程可控**：制作进度真实投影、成果预览、中途审阅暂停、候选版本选片、自然语言局部返修、逐镜参考绑定、跨轮参考合并、画质选择
- **对白模式**：多角色人物对白——严格 ASR 逐字核验，或免 ASR 路线（模型原生出声 + 估算字幕）
- **出口**：「毕业通道」批准方案一键升级专业成片 + 连载立项；智能载体路由——超上限长内容、整本小说改编（→ `novel-adapt`）、现成素材拼片 / 相册（→ `photo-montage`）给出非阻断的专业链方向建议

### 专业流水线（模板化）

- **19 个内置模板**：16 张场景卡（按「我想做什么」分 **出成品 / 做规划 / 发布与复盘** 三组呈现，不用记模板名）+ 3 个 `easy-*` 模板由轻松创作内部调度。新增体裁 = 新增 YAML（模板页在线编辑，保存即生效）；内置模板与出厂提示词只读，可「另存为副本」派生自定义。详表 → [docs/templates.md](docs/templates.md)
- **流程引擎**：DAG 并行调度、条件跳过、三态闸门（批准 / 驳回 / 免审放行）、模板快照、断点续跑、单步重跑、全局并发闸门、批量运行；orchestrator 多模板显式串链 + 段间自动级联（产物映射 / 预算闸门 / 暂停续跑）；统一取消 / 续跑 / 预算执行保障
- **平台智能化**（M32–M39 收官）：「默认自动推导 + 用户可覆盖 + 执行前预览」三层决策模型——AI 配置只配 Key + 选模型（定价自动带出）、运行入参智能预填、视频合法档位钳制、模板推荐与下一步建议、自动值来源统一可追溯；**不猜测 / 不静默降级 / 成本可见**安全线不降
- **镜头工作台**：分镜级改时长 / 改词重生成 / 多版本选片 / 拖拽重排 / 大编辑器 / 上传替换 + 镜头级音字对齐、BGM、转场、per-shot 音效、手动重新合成；统一 QC 面板与交付包认证（成片质量可验证 / 交付可信只读核验）

### 创作画布（`/canvas`）与流水线画布（`/creation`）

- **创作画布**：素材自由摆放 + 引用连线 + 就地生成（文生图 / 图生图 / 文生视频 / 图生视频 / TTS / LLM 文本 / 视频合成）+ 局部重绘 · 消除 · 扩图 + 变体抽卡与采纳 + 成组 / 快照 / 回收站 + zip · PNG · SVG 导出 + 模板草案沉淀与一键试跑
- **成片深加工**：剪辑工程交换导出——成片一键导出 FCPXML / EDL / OTIO 多轨工程，接入专业剪辑软件

## 统一底座

- **实体与素材**：角色 / 场景 / 道具单表多态实体库 + 参考图链（定妆照 / 首帧 i2v / 场景道具注入）+ 全局素材池（全局角色跨项目挂定妆照）+ 风格预设（多选叠加）+ 收藏 / 版本清理 / 回收站 + 图像质量检测（黑图 / 空白 / 损坏）+ 内容与参考版本、执行真实输入快照、下游影响分析、锁版
- **输入源扩展**：小说（txt / md / docx / epub）导入 → 章节切分 → 事件图谱 → 分集规划 → 逐集剧本；URL 素材抓取；长视频解析（抽帧 + ASR + 多模态时间轴）与视频反推链——反推产物可检视、分镜初稿喂进规划
- **成片与品牌**：三层品牌配置（平台 / 项目 / run）字幕样式 · 水印 · 片头片尾，多画幅（派生 / 原生渲染），发布包 zip 导出；素材混剪（照片 + 视频任意组合零 LLM 出片，AI 缓推 / 锚点 / 拼贴 / 配乐增强）+ 开场标题智能编排与标题字卡；短剧商业化结构设计（开场钩子 / 付费卡点 / 留人节奏——剧情设计思路，不产出平台付费配置）
- **供应商适配层**：LLM / 图片 / 视频 / 语音四通道多实例（OpenAI 兼容）+ 声音克隆 + 本地模型双轨（LocalAI 走 `openai_*` 既有实例零代码接线 / ComfyUI 私有协议适配）+ 本地向量记忆（ONNX 零联网）
- **统计与成本**：用量记录与单价快照、八组聚合、运行看板、发布登记与复盘回灌；计费与幂等深化、预算闸门

## 技术栈

Node 20+ / TypeScript / Hono / Drizzle + libsql / Socket.IO / fflate（导出 zip）/ ffmpeg-static（内置 ffmpeg/ffprobe 二进制，系统安装可选）/ Vue3 + Vite（原生 CSS）/ pnpm workspace

## 快速开始

```bash
pnpm install    # 自动下载内置 ffmpeg/ffprobe 二进制（ffmpeg-static / ffprobe-static，约 150MB）
# 复制 .env.example 为 .env 并填入 AGENT_LLM_API_KEY（其余供应商密钥在「设置 → AI 配置」页录入）
pnpm dev        # 并行起双端：
                #   server  http://127.0.0.1:3001（API + Socket.IO + health）
                #   web     http://127.0.0.1:5273（vite dev，/api 与 /socket.io 已代理）
```

首次启动自动建库（drizzle migrate）与 seed（供应商目录）。密钥只存 `data/secrets.json`（0600），不入库不进 git。

**AI 适配器依赖**：`@agencys/ai-provider-kit`（图像/视频/语音/LLM 协议适配层）按 **Git 版本标签依赖** 声明在 `apps/server/package.json`（当前钉 `#v0.4.0`），`pnpm install` 会自动从 `https://gitee.com/agencys/ai-provider-kit.git` 拉取，**无需把它克隆到本工程旁边的固定路径**（锁文件已记录标签指向的具体 commit，构建可复现；Git 依赖不支持 `^x.y.z` 这类 semver 范围，只能钉标签/分支/commit）。两个动作：升级适配器→ 先在 kit 仓库提版本号并打标签推送（如 `v0.5.0`），再把本仓库依赖行的标签号改掉后 `pnpm install`；本地改适配器源码联调→ 把 `apps/server/package.json` 那一行临时改成 `"file:../../../ai-provider-kit"`（要求 kit 与本仓库同级目录），联调完毕改回 Git 依赖并还原锁文件后再提交——请勿把本地路径提交进 `package.json` / `pnpm-lock.yaml`。

## 质量门禁

```bash
pnpm ci:check               # 一键：双端 typecheck + 模板校验 + 全量探针（串行 fail-fast）
pnpm probe:all              # 全量探针（并行）
pnpm probe:ci               # 全量探针（串行快失败，权威口径）
pnpm validate:templates     # 模板校验（19 份 / 131 步）
pnpm --filter @acs/server bench   # 规模化压测基准（非阻断）
```

可选启用推送前钩子：`git config core.hooksPath .githooks`。

## 分发给他人（便携包）

给不会装 Node/pnpm 的人用：`pnpm package:portable` 一键产出 `dist-portable/百工工作室-便携版/`（含自带 Node 运行时、全部依赖、出厂模板与本地模型）+ 同名 zip。对方解压后双击「启动.bat」即用，首次启动自动建库，API Key 在网页「设置 → AI 配置」页自行填入。

脚本内置三重防泄漏（密钥/数据库/个人项目绝不入包）与真实拉起式冒烟自检（建库 / ffmpeg / 模板清单 / embedding 实跑），任一断言失败则包不可分发。细节与安全红线 → [docs/portable-packaging.md](docs/portable-packaging.md)。

线上分发渠道：zip 约 180MB 超 Gitee 附件 100MB 上限，推荐 GitHub Release（单文件 2GB）或网盘直链，平台限制与操作步骤 → [docs/portable-packaging.md](docs/portable-packaging.md)「发布到 Git 托管平台」。

## 上手路径

**最轻路径**：侧栏首位「轻松创作」（`/create`），见上方[三条创作入口](#三条创作入口)。

**专业路径 · 四步上手**：

1. **建项目**：项目列表「新建项目」→ 填项目名 + 体裁 + 简介 brief（作为全部创作上下文）；体裁自动预选默认模板，可在项目页「编辑」中改
2. **启动流水线**：项目页「启动流水线」→ 弹窗按"我想做什么"选一张**场景卡**（16 张卡按 出成品 / 做规划 / 发布与复盘 三组呈现，不需要记模板名）
3. **填输入 → 启动**：必填项齐全后「启动」，自动跳运行页
4. **过闸门 → 取产物**：时间线推进到「等待审阅」时预览产物并 批准 / 驳回（附意见）/ 免审放行；完成后产物可预览、一键「导出发布包」

场景对照表、闭环链路与「下一步建议」→ [docs/getting-started.md](docs/getting-started.md)。

## AI 配置

「设置」页（`/system`）→「**AI 配置**」Tab，按能力分四个 tab：文本生成 `llm` / 图片生成 `image` / 视频生成 `video` / 语音合成 `audio`——每个 tab 可建多个供应商实例、支持在线拉取模型与连通测试；只配 Key + 选模型即可用（定价与能力由模型档案自动带出）。旧深链 `/settings` 自动重定向到该 Tab。密钥只存 `data/secrets.json`（0600，不入库不进 git）。四通道细节、本地向量记忆与 embedding 模型 → [docs/ai-config.md](docs/ai-config.md)；本地模型（LocalAI / ComfyUI）接入 → [docs/local-zero-code-wiring.md](docs/local-zero-code-wiring.md)。

## 目录约定

| 路径 | 说明 |
|---|---|
| `apps/server/src/` | Hono API + Pipeline 引擎（DAG 调度 / 模板快照 / 崩溃恢复）+ Action Registry + 供应商适配层 |
| `apps/web/src/` | Vue3 工作台（轻松创作 / 项目 / 运行与批次 / 统计 / 模板 / 创作画布 / 流水线画布 / 记忆 / 实体与全局素材池 / 风格预设 / 设置） |
| `docs/` | 活文档（上手指南 / 模板详表 / AI 配置 / 本地模型接线 / 回归路径 / 验收快照 / 里程碑速览 / 便携包） |
| `docs/records/` | 里程碑设计留档（只读快照：各里程碑 spec / 审计取证 / 立项裁定，索引见 [docs/records/README.md](docs/records/README.md)；实施计划入 `docs/records/plans/`） |
| `workspace/templates/*.yaml` | 流水线模板（新增体裁 = 新增模板；模板页在线编辑，保存即生效） |
| `workspace/prompts/*.md` | LLM 提示词模板（外置可编辑；模板页同区管理） |
| `workspace/projects/{id}/` | 项目资产 + exports/ 发布包（运行时生成，API 经 /api/v1/assets/{id}/file 访问） |
| `data/studio.db` | SQLite（WAL） |
| `data/secrets.json` | 本地 API key（0600，不入库） |
| `data/models/bge-small-zh-v1.5/` | 记忆 embedding 模型（ONNX 本地推理，512 维；`model:prepare` 检查/下载） |

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | 场景入口上手指南：四步流程 + 场景对照表 + 闭环链路与下一步建议 |
| [docs/templates.md](docs/templates.md) | 内置模板详表（19 模板 × 场景 × 要点 × 方法论来源）与典型工作流链 |
| [docs/ai-config.md](docs/ai-config.md) | AI 四通道配置指引 + 记忆与本地模型 |
| [docs/local-zero-code-wiring.md](docs/local-zero-code-wiring.md) | 本地模型「零代码通道」接线说明（LocalAI via `openai_*`；ComfyUI 私有协议另见其 §4） |
| [docs/testing.md](docs/testing.md) | 全链路回归路径（UI 手工路径 / API 快捷冒烟 / data/ 重置） |
| [docs/portable-packaging.md](docs/portable-packaging.md) | 便携包构建与分发指南（布局 / 安全红线 / 自检断言 / 常见问题） |
| [docs/acceptance.md](docs/acceptance.md) | 验收快照（M1–M17 全量 + production-baseline / 切片返修 / 近期里程碑增量，落笔即冻结） |
| [docs/milestones.md](docs/milestones.md) | M2–M62 各里程碑能力速览（设计原则 / 变更明细 / 验证命令） |
| [docs/records/README.md](docs/records/README.md) | 里程碑设计留档索引（各里程碑详规、DB re-baseline 取证等，落笔即冻结） |

## License

见 [LICENSE](LICENSE)。
