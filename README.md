# agencys-content-studio

个人内容创作平台：模板化流水线 + 统一资产 + 供应商适配层（本地单机 Web）。

- 设计规格：`docs/superpowers/specs/2026-09-09-agencys-content-studio-m1-design.md`
- 方向文档（L0）：`docs/superpowers/specs/2026-09-09-agencys-content-studio-roadmap.md`
- 状态：M1 骨架开发中

## 技术栈

Node 20+ / TypeScript / Hono / Drizzle + better-sqlite3 / Socket.IO / Vue3 + Vite / pnpm workspace

## 快速开始

```bash
pnpm install
# 复制 .env.example 为 .env 并填入 AGENT_LLM_API_KEY
pnpm dev          # server: http://127.0.0.1:3001（web 端在 M1 后段接入）
```

首次启动自动建库（drizzle migrate）与 seed（供应商目录）。

## 目录约定

| 路径 | 说明 |
|---|---|
| `workspace/templates/*.yaml` | 流水线模板（新增体裁 = 新增模板） |
| `workspace/prompts/*.md` | LLM 提示词模板（外置可编辑，热加载） |
| `workspace/projects/{id}/` | 项目资产（运行时生成） |
| `data/studio.db` | SQLite（WAL） |
| `data/secrets.json` | 本地 API key（0600，不入库） |

## M1 验收（8 条 exit criteria）

见设计规格 §8；当前进度以逐条勾选维护。
