# 便携包构建与分发指南

把本项目打成「解压即用」的 Windows 便携版，发给不会装 Node/pnpm 的人。实现：`apps/server/scripts/package-portable.ts`（`pnpm package:portable`）。

## 一键构建

```bash
pnpm package:portable                     # 全量：web 构建 + deploy + 组装 + 自检 + zip
pnpm package:portable -- --no-zip        # 只出文件夹
pnpm package:portable -- --no-model      # 不带 embedding 模型（记忆/模板推荐届时降级，包小 ~46MB）
pnpm package:portable -- --skip-web-build  # 复用现有 apps/web/dist（快速迭代）
```

产物：`dist-portable/百工工作室-便携版/` + `百工工作室-便携版-v{版本}.zip`（约 400~500MB / zip 约 200MB）。前置：本机已 `pnpm install`（deploy 从 store 复用，不联网）、`data/models/bge-small-zh-v1.5` 已就绪（`pnpm --filter @acs/server model:prepare -- --download`）。

## 包布局（与 env.ts 的路径契约对齐）

```
百工工作室-便携版/
├── 启动.bat / launcher.mjs / 使用说明.txt / NOTICE-第三方组件.txt / NOTICES.txt
├── runtime/node.exe                  # 自带 Node（宿主 process.execPath 拷贝；目标机器零安装）
├── apps/server/                      # pnpm deploy --prod 产物：src + drizzle 迁移 + node_modules + package.json
├── apps/web/dist/                    # 前端构建产物（server 单端口托管，见 app.ts）
├── data/models/bge-small-zh-v1.5/    # 本地 embedding 模型（可选）
└── workspace/{templates,prompts,compliance}/   # 出厂资产；projects/logs/brand 由首次启动 ensureDirs 自建
```

`launcher.mjs` 以 `CSTUDIO_ROOT` 显式指定包根（env.ts `resolveRoot` 的最高优先级分支），从 3001 起自动探测端口（已在跑则直接开浏览器）。

## 安全红线（脚本强制，不可绕过）

| # | 防线 | 机制 |
|---|---|---|
| 1 | 个人数据不入包 | 组装是白名单式（只拷 models / 出厂 workspace）；另有断言：`data/secrets.json`、`.env`、`data/studio.db*`、`workspace/{projects,logs,brand}` 出现在包内即 fail |
| 2 | 密钥探针扫描 | 读源 `data/secrets.json` 与 `.env` 的真实密钥值（≥12 字符），全包文本文件（≤2MB、跳过二进制扩展名）检索，命中即 fail |
| 3 | 链接审计 | 包内出现任何 symlink/junction 即 fail——pnpm 默认 isolated 布局的 junction 指向绝对路径，换机器必断；故 deploy 强制 `--config.node-linker=hoisted` |

**永远不要直接压缩仓库目录分发**——`data/secrets.json` 里有你的全部供应商真实密钥。

## 自检断言（真实拉起，非静态检查）

冒烟用包内 `runtime/node.exe` 起服务（随机 39000+ 端口，`CSTUDIO_ROOT` 指向包根），全部通过才允许 zip：

1. `GET /api/v1/health` → `db:ok`（首次自动建库 + drizzle migrate + seed 全链路）
2. `health.ffmpeg === 'ok'`（包内 ffmpeg-static 实测 spawn 成功）
3. `GET /api/v1/templates` ≥ 15 项（出厂模板 + loader 扫描全链路）
4. `GET /` 返回 SPA index.html（单端口静态托管）
5. 带模型时：`GET /api/v1/memories/status ready:true` + `POST /api/v1/memories` 真实计算 embedding 且 `missingEmbedding===0`（onnxruntime-node 原生链路；也是「删除 onnxruntime-web 安全性」的回归门）

冒烟结束后自动清理运行期产物（studio.db / workspace/logs / workspace/projects），zip 里保持干净出厂态。

## 瘦身决策记录（为什么删这些）

| 删除项 | 依据 |
|---|---|
| `ffprobe-static/bin/{darwin,linux,win32/ia32,win32/arm64}` | 全平台二进制 335MB → 只留 win32/x64（60MB）；index.js 按 `platform/arch` 选路径，删非目标平台不影响 |
| `onnxruntime-node/bin/napi-v3/{darwin,linux,win32/arm64}` | 同上，只留 win32/x64 |
| `better-sqlite3` | drizzle-orm 的 optional 依赖；本项目 libsql 方言永不加载（`pnpm-workspace.yaml` 亦禁其构建） |
| `onnxruntime-web`（89MB） | transformers.js 的浏览器 wasm 后端；Node 下走 onnxruntime-node。**删安全性由自检断言 5 回归** |

## 发布到 Git 托管平台（在线下载渠道）

zip 约 180MB，**不要 commit 进仓库**——Gitee/GitHub 的 push 单文件上限均为 100MB，且每次发版都会往仓库历史塞进一个不可回收的大 blob。正确姿势是走 **Release 附件**（不占 git 历史，用户免 git 直接下载）。

### 平台限制（2026-10 查证）

| 渠道 | 单文件上限 | 本包 zip ~180MB | 说明 |
|---|---|---|---|
| Gitee Release 附件 | 100MB（GVP 200M），仓库总量 1GB | ✗ 传不上 | [官方文档](https://help.gitee.com/repository/release/create) |
| Gitee push / LFS | 100MB | ✗ | LFS 免费配额另计 |
| GitHub Release asset | **2GB** | ✓ 推荐 | 浏览器免登录直下 |
| GitHub push | 100MB（>50MB 警告） | ✗ | 同样别 commit |

### 推荐路径：GitHub 镜像 + Release

1. GitHub 建公开镜像仓库（本项目 Apache-2.0 开源，公开代码无新增许可义务）
2. 推送：`git remote add github https://github.com/BeginnerA/agencys-content-studio.git`，然后 `git push github master --tags`；镜像默认分支若为建仓自动生成的 `main`，需切成 `master`（`gh api repos/BeginnerA/agencys-content-studio -X PATCH -f default_branch=master`）
3. 建 Release：`gh release create v0.1.0 <zip路径> --title "百工工作室 便携版 v0.1.0" --notes-file <说明文件>`。⚠️ **asset 文件名必须 ASCII**——GitHub 会把中文文件名吞成 `-.-v0.1.0.zip`（实测），上传前先复制一份英文名：`Baigong-Studio-portable-v{版本}-win-x64.zip`（zip 内部目录仍为中文，解压后体验不变）。正文粘贴下方「对外发布文案」的 GitHub Release 版
4. Gitee 仓库的 Release 页粘贴「Gitee Release 引流说明」文案（内含指向 GitHub 的下载链接；附件传不下大包，说明页只做引流）
5. 以后每次发版：改 `package.json` version → 重跑 `pnpm package:portable` → 打新 tag、传新 asset

### 对外发布文案（复制即用）

以下三份文案直接复制粘贴，发新版时替换版本号与链接。当前 v0.1.0 zip 校验值：`SHA256 0AB7921EEC184BF9012AD4D95BB81803F411E8288428866D8B5B3DDECFCAAA07`（asset 名 `Baigong-Studio-portable-v0.1.0-win-x64.zip`，186201317 字节）。v0.1.0 已发布：<https://github.com/BeginnerA/agencys-content-studio/releases/tag/v0.1.0>。

**① GitHub Release 说明**（贴到 Release 正文）

```text
百工工作室 便携版 v0.1.0（Windows）

「解压即用」的 AI 内容创作工作室：模板化流水线 + 统一资产库 + 多家 AI 供应商适配，全程本地运行，无需安装 Node、pnpm 或任何开发环境。

【三步上手】
1. 下载下方 zip（约 178MB），解压到任意目录
2. 双击「启动.bat」，等待浏览器自动打开（首次启动自动建库，约十几秒）
3. 在网页左侧「AI 配置」填入你自己的 API Key，即可开始创作

【包含能力】
- 内置 19 个创作模板：选题 → 生产 → 平台适配 → 发布登记 → 复盘回灌全闭环
- 角色 / 场景 / 道具资产库 + 分镜编辑器 + 自由创作画布
- 本地向量记忆（ONNX 模型已打包，零联网）
- 自带 ffmpeg：视频合成 / 抽帧开箱即用

【系统要求】
- Windows 10 / 11 x64（暂不支持 mac / Linux）
- 解压后约 430MB 磁盘空间
- 自备 AI 供应商 API Key（DeepSeek / 火山 / OpenAI 兼容端点均可）；也可接本地 Ollama 完全离线运行
- 纯本地运行：项目数据与密钥仅存本机（包内 data/ 目录），不上传任何服务器

【常见问题】
- 浏览器没有自动打开：看命令行窗口提示的地址，手动访问即可
- 详细引导见包内「使用说明.txt」

Apache-2.0 开源；第三方组件许可声明见包内 NOTICE。
```

**② Gitee Release 引流说明**（贴到 Gitee 发行版正文）

```text
百工工作室 便携版 v0.1.0（Windows x64）

本人开源项目「百工工作室」的「解压即用」便携包——无需安装任何开发环境，下载解压双击即用。

⚠️ 包大小约 178MB，超出 Gitee 发行版附件 100MB 上限，请前往 GitHub 下载：
👉 https://github.com/BeginnerA/agencys-content-studio/releases/tag/v0.1.0

三步上手：解压 → 双击「启动.bat」→ 网页「AI 配置」填自己的 API Key。系统要求与常见问题见下载页说明。
```

**③ 转发给朋友的聊天消息**（微信 / QQ 直接发）

```text
给你发个我做的小工具「百工工作室」——AI 内容创作工作室，写文案、生图生视频、剪成片一条龙。

下载：<下载页链接>
（Windows 电脑；下载后解压到任意文件夹，双击里面的「启动.bat」，浏览器会自动打开）

提醒两件事：
1. 它是纯本地运行的，数据都在你自己电脑上
2. 我没放 AI 接口的钥匙进去，你需要自己去 DeepSeek 官网注册个账号、充点钱，把 Key 填到网页里才能生成内容——操作很简单，包里的《使用说明.txt》里有一步步引导
```

### Gitee-only 兜底：网盘直链

没有 GitHub 账号时：zip 传网盘（123 盘 / 夸克等下载不限速的盘），Gitee Release 说明页与 README 放直链 + 提取码。**不建议 zip 分卷**——Windows 资源管理器原生打不开 `.z01` 分卷，解压要装 7-Zip/WinRAR，对目标用户（非技术人员）直接劝退。

### 公开前提自查

- **仓库可见性**：Release 附件跟随仓库可见性，私有仓库别人看不到——发布前确认仓库已开源
- **泄漏风险**：包内容已过脚本三重防泄漏（密钥 / 数据库 / 个人项目 0 入包，冒烟全过），公开发布无泄漏风险
- **许可义务**：包内 `NOTICE-第三方组件.txt` 已随包声明（Node / ffmpeg GPL / onnxruntime / 模型许可）
- **源码构建者**：`pnpm-lock.yaml` 钉的 `@agencys/ai-provider-kit` 是 gitee git 依赖，他人从镜像仓库源码构建时需该 gitee 依赖仓库可访问（便携包用户不受影响，不 clone 源码）

## 已知边界

- **仅 Windows x64**：node.exe、平台二进制瘦身均按 win32/x64 假设（脚本在非 Windows 直接退出）。出 mac/Linux 包需另做平台矩阵。
- **升级 = 重打包**：包是快照，不自动更新；发新版就是重跑一次脚本。
- **ffmpeg 为 GPL 构建**：以独立进程调用（未链接），随包分发的许可义务见包内 `NOTICE-第三方组件.txt`。
- **包内无 .env**：全部走默认值（3001 起自动避让、127.0.0.1、data/workspace 随包根）；懂技术的用户可自建 `.env`（env.ts 的 dotenv 会自动读）。
- 对方仍需**自备 API Key**（或 LocalAI/Ollama 本地端点）——「一键运行」解决安装门槛，不解决密钥门槛；给对方转发 `使用说明.txt` 里的三步引导即可。
