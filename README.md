# agencys-content-studio · 百工工作室

> 本地优先的 AI 内容创作工作室 —— 用模板化流水线，把一句话想法变成可发布的成片。

百工工作室是一个跑在个人电脑上的内容创作平台（本地单机 Web 应用，数据与密钥不出本机）。内置 19 个创作模板，覆盖「选题 → 生产 → 平台适配 → 发布 → 复盘回灌」内容全链路；统一管理角色、场景与素材资产；对接云端与本地 AI 供应商（LLM / 图像 / 视频 / 语音）；支持一键打包绿色便携版，分发给没有任何开发环境的人使用。

## 功能特性

**三种创作方式**

- **轻松创作**：对话式出片——一句话描述想法 → 确认方案 → 自动产出 30–90 秒、最多 16 镜的多镜头成片。支持参考图 / 参考视频 / BGM 约束产出，中途暂停审阅、候选版本选片、自然语言局部返修；批准方案可一键升级到专业流水线继续精修
- **模板流水线**：按「我想做什么」选场景卡启动，DAG 并行调度、人工闸门（批准 / 驳回 / 免审放行）、断点续跑、单步重跑、批量运行，支持多模板编排串链与段间自动级联。新增体裁 = 新增一份 YAML，零代码、保存即生效
- **创作画布**：素材自由摆放 + 引用连线 + 就地生成（文生图 / 图生图 / 文生视频 / 图生视频 / TTS / LLM / 视频合成），支持局部重绘、消除、扩图与变体抽卡；成片可一键导出 FCPXML / EDL / OTIO 多轨剪辑工程

**平台能力**

- **统一资产**：角色 / 场景 / 道具实体库、参考图链、风格预设、版本与追溯、回收站、跨项目全局素材池、图像质量检测
- **输入源扩展**：小说导入（txt / md / docx / epub）自动分集改编、URL 素材抓取、长视频解析（抽帧 + ASR + 时间轴）与视频反推
- **品牌与分发**：平台 / 项目 / 运行三层品牌配置（字幕 / 水印 / 片头片尾）、多画幅、发布包导出；素材混剪成片、开场标题字卡、短剧商业化结构设计
- **成本与用量**：逐次调用的用量与单价快照、预算闸门、计费幂等；发布登记与数据复盘回灌

**AI 供应商**

- LLM / 图像 / 视频 / 语音四通道，每通道可建多个实例；OpenAI 兼容协议，在线拉取模型、一键连通测试
- 本地模型：LocalAI 零代码接入（复用 OpenAI 兼容实例）、ComfyUI 适配；本地向量记忆基于 ONNX，完全离线
- 密钥仅存本地 `data/secrets.json`（0600），不入库、不进 git

## 快速开始

环境要求：**Node 20+**、**pnpm**。

```bash
git clone https://gitee.com/agencys/agencys-content-studio.git
cd agencys-content-studio
pnpm install            # 自动下载内置 ffmpeg / ffprobe（约 150MB）
cp .env.example .env    # 填入 AGENT_LLM_API_KEY
pnpm dev
```

启动后：

- Web 工作台：<http://127.0.0.1:5273>
- 服务端 API：<http://127.0.0.1:3001>

首次启动自动建库（SQLite）并初始化供应商目录。其余供应商密钥在「设置 → AI 配置」页录入即可，无需改代码。

## 文档

| 文档 | 内容 |
|---|---|
| [上手指南](docs/getting-started.md) | 四步跑通第一条流水线 + 场景对照表 + 闭环链路 |
| [模板详表](docs/templates.md) | 19 个内置模板的场景、要点与典型工作流链 |
| [AI 配置](docs/ai-config.md) | 四通道供应商配置、记忆与本地模型 |
| [本地模型接线](docs/local-zero-code-wiring.md) | LocalAI / ComfyUI 接入说明 |
| [回归测试](docs/testing.md) | 全链路回归路径与探针说明 |
| [便携包](docs/portable-packaging.md) | 绿色便携版构建与分发指南 |
| [里程碑速览](docs/milestones.md) | 各版本能力明细与验证命令 |
| [验收快照](docs/acceptance.md) | 历史验收记录 |
| [设计留档](docs/records/README.md) | 里程碑设计文档索引 |

## 开发

```bash
pnpm build              # 双端构建
pnpm typecheck          # 双端类型检查
pnpm ci:check           # 一键门禁：typecheck + 模板校验 + 全量探针
pnpm validate:templates # 模板校验
```

- **便携包**：`pnpm package:portable` 产出 `dist-portable/百工工作室-便携版/`（自带 Node 运行时与全部依赖），对方解压双击「启动.bat」即用；内置密钥 / 数据库防泄漏与冒烟自检
- **协议适配层**：`@agencys/ai-provider-kit` 以 Git 标签依赖（当前 `#v0.4.0`）由 `pnpm install` 自动从 Gitee 拉取；升级 = 在 kit 仓库打新标签后改标签号重装，本地联调可临时改 `file:` 引用（勿提交本地路径）

## 目录结构

| 路径 | 说明 |
|---|---|
| `apps/server` | Hono API + 流水线引擎 + 供应商适配层 |
| `apps/web` | Vue3 工作台 |
| `docs/` | 活文档（见上表） |
| `docs/records/` | 里程碑设计留档（冻结快照） |
| `workspace/templates/` | 流水线模板 YAML（在线编辑，保存即生效） |
| `workspace/prompts/` | LLM 提示词模板 |
| `data/` | SQLite 数据库、密钥文件、本地模型（运行时生成） |

## License

[Apache-2.0](LICENSE)
