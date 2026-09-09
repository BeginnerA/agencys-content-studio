# agencys-content-studio

个人内容创作平台：模板化流水线 + 统一资产 + 供应商适配层（本地单机 Web）。

- 设计规格：`docs/superpowers/specs/2026-09-09-agencys-content-studio-m1-design.md`
- 方向文档（L0）：`docs/superpowers/specs/2026-09-09-agencys-content-studio-roadmap.md`
- M1 验收记录：`docs/superpowers/specs/2026-09-09-agencys-content-studio-m1-review.md`
- 状态：M1 骨架闭环完成（8 条验收全绿）；M2 流程引擎化 spec 撰写中

## 技术栈

Node 20+ / TypeScript / Hono / Drizzle + libsql / Socket.IO / Vue3 + Vite（原生 CSS）/ pnpm workspace

## 快速开始

```bash
pnpm install
# 复制 .env.example 为 .env 并填入 AGENT_LLM_API_KEY（供应商密钥录入在 Web「AI 配置」页完成）
pnpm dev    # 并行起双端：
            #   server  http://127.0.0.1:3001（API + Socket.IO + health）
            #   web     http://127.0.0.1:5174（vite dev，/api 与 /socket.io 已代理）
```

首次启动自动建库（drizzle migrate）与 seed（供应商目录）。密钥只存 `data/secrets.json`（0600），不入库不进 git。

## 目录约定

| 路径 | 说明 |
|---|---|
| `apps/server/src/` | Hono API + Pipeline 引擎 + Action Registry + 供应商适配层 |
| `apps/web/src/` | Vue3 工作台（项目/运行/资产/任务/gate 审阅/AI 配置） |
| `workspace/templates/*.yaml` | 流水线模板（新增体裁 = 新增模板，热加载） |
| `workspace/prompts/*.md` | LLM 提示词模板（外置可编辑，热加载） |
| `workspace/projects/{id}/` | 项目资产（运行时生成，API 经 /api/v1/assets/{id}/file 访问） |
| `data/studio.db` | SQLite（WAL） |
| `data/secrets.json` | 本地 API key（0600，不入库） |

## M1 全链路回归路径（exit criteria #8）

### A. UI 手工路径（推荐，一次约 3–5 分钟）

1. 双端启动：`pnpm dev`，浏览器打开 http://127.0.0.1:5174
2. **建项目**：项目列表页「新建项目」（或选已有「萌宝冒烟」跳到 3）
3. **传素材**：项目详情页「上传素材」，用途可选 brief / 设定底稿 / 角色参考图 / 归档；同内容重复上传应去重（同名仅保留一份）
4. **启动流水线**：「启动流水线」→ 选模板 mengbao-episode → 填 brief 与集号、勾选素材 → 提交后自动跳运行页
5. **看流式日志**：运行页时间线 write_script 步骤日志滚动 → 停在 `等待审阅`（gate）
6. **gate 审阅**：弹窗预览剧本 markdown → 可「审阅修改」（以修改版续跑）或直接**批准**；驳回需附意见
7. **等出片**：批准后自动走分镜 → 批量出图（并发 ≤2，失败自动重试 1 次）→ ffmpeg 合成成片；任务面板可见每张图的任务状态与 prompt 溯源
8. **看成片**：完成态 run 的产物资产（final_video）点开即播放（浏览器 Range 拉流）；封面 thumb 与全尺寸图可预览
9. **AI 配置**：设置页按 tab（文本/图片/视频）查看实例，「测试」验证连通；出图失败可切换默认实例后重试

### B. API 快捷冒烟

```bash
curl http://127.0.0.1:3001/api/v1/health            # ok/db/ffmpeg/workspace 全绿
curl "http://127.0.0.1:3001/api/v1/runs?project_id=1"   # 项目 1 运行列表（最新在前）
curl http://127.0.0.1:3001/api/v1/runs/9            # completed run 详情（steps 产物链）
curl http://127.0.0.1:3001/api/v1/assets/33/file    # 成片 mp4（支持 Range: bytes=…）
```

### C. 清理 data/ 重来

```powershell
# 1) 停掉 pnpm dev（两个终端 Ctrl+C）
# 2) 清库与产物（密钥可保留，不清 secrets.json 则无需重配）
Remove-Item data/studio.db* -ErrorAction SilentlyContinue
Remove-Item workspace/projects/* -Recurse -Force -ErrorAction SilentlyContinue
# 3) 重新 pnpm dev —— 自动 migrate + seed，从空白开始
```

> 若改动了模板/提示词文件：运行中的服务会热加载，无需重启；已开始的 run 保持启动时快照语义。

## M1 验收快照

| # | 判据 | 结果 | 证据（详见 review 文档） |
|---|---|---|---|
| 1 | `pnpm dev` 双端 + `/health` 全绿 | ✅ | db/ffmpeg/workspace 均 ok |
| 2 | Web 建项目 + 上传 imports 去重 | ✅ | 项目 1；brief×2/source×1 资产 |
| 3 | 流式日志 → waiting_input → Web gate 审阅 | ✅ | Run 10（真实 UI 审阅通过） |
| 4 | storyboard ≥8 shots；并发 ≤2、重试 1 次、成功率 ≥90% | ✅ | 19 shots；19/19 成功（100%） |
| 5 | mp4 1080x1920 带封面 → 浏览器 Range 预览 | ✅ | ffprobe 实测 1080x1920/76s；206 |
| 6 | 强杀恢复：无悬挂 processing、waiting_input 可续 | ✅ | Run 9 由失败恢复 completed（幂等复用） |
| 7 | shot_image 可溯源 {run,step,task,prompt,params} | ✅ | asset#32 → run9/step22/task57 |
| 8 | 本 README 回归路径 | ✅ | 上文 A/B/C |
