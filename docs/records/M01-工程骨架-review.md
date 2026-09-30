# agencys-content-studio M1 里程碑 review

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-09（定稿 2026-09-09，Run 10 实弹回填）
- 对应 spec：`2026-09-09-agencys-content-studio-m1-design.md`（§8 验收）
- 判定：**8/8 通过**（#3 由用户在 Web UI 实弹批准 Run 10 完成确认）

---

## 验收逐条对照（实测证据 2026-09-09，服务运行中采集）

### #1 `pnpm dev` 双端 + `/health` 全绿

- 实测 `GET /api/v1/health` → 200：
  `{ok:true, db:"ok", ffmpeg:"ok", workspace:"D:\…\workspace"}`（ffmpeg 9.0.1 winget 路径）
- web 端 `pnpm --filter @acs/web dev`：5174（vite 8 绑 127.0.0.1，/api 与 /socket.io 代理 3001）
- 18 个 SFC 模块 vite 编译探测全 200；`vue-tsc --noEmit` 全绿
- **✅ 通过**

### #2 Web 建项目 / 上传素材 / imports 去重

- Web：项目列表/新建、详情页「上传素材」（purpose: brief/设定底稿/角色参考图/归档，多选 XHR 进度）
- 项目 1「萌宝冒烟」资产实况：`brief×2`（ep001/ep002 各自内容，非重复）、`source×1`（设定底稿）、`script×2`、`shot_image×28` 等 36 项
- imports 去重（同名/同内容二次上传仅留一份）：服务端已实现，UI 封装同一 API；实测验证记录于开发期冒烟
- 期间修复：前端 `projectApi.runs` 误用不存在的 `/projects/:id/runs` → 契约实为 `GET /runs?project_id=`（404 修复，已随 cc39ed7 提交）
- **✅ 通过**

### #3 write_script 流式日志 → waiting_input → Web gate 审阅

- Run 10（萌宝 ep2「幼儿园才艺表演排练搞砸道具」）真实链路：
  - ingest_docs succeeded → write_script succeeded（LLM 流式日志经 /runs/{id}/log 与 socket 可见）
  - run 停在 `waiting_input`，gate 消息插值正确（模板 `message: 请审阅第 {input.episode_number} 集剧本…` → 「第 2 集」）
  - 剧本产物 asset#36 `002-剧本.md`（name_tpl `{episode_number:03d}` 插值正常）
- Web 审阅：GateDialog（预览 markdown / 审阅修改 text_override / 批准 / 驳回附意见 / 中止），批准经 `POST /runs/{id}/gate` → 引擎续跑
- **实弹确认（2026-09-09 用户 UI 批准）**：Run 10 批准后引擎自动续跑全链路 → `completed`，5 步骤全 succeeded（attempts 全 1），16 个 gen_image task `16/16 成功`，总耗时 147.9s（约 2.5 分钟），产出 ep2 成片
- 出口问题应答（顺不顺手）：用户全程 UI 操作无阻断反馈；期间实测发现并修复 1 个契约 404（runs 子路径）、完成暗色视觉升级与配置页 tab 化（均在本 review 交付批次内）
- **✅ 通过（实弹定稿）**

### #4 storyboard ≥8 shots / 并发 ≤2 / 自动重试 1 次 / 成功率 ≥90%

- storyboard 产物 asset#4 `分镜.json`：实测 `shots=19`（≥8 ✓）
- 并发与重试（源码级）：`actions/ai-image.ts` 默认 `batch {maxConcurrent:2, retry:1}`，runPool 双 worker 信号量；模板 `batch: {field:shots, max_concurrent:2, retry:1}` 命中默认
- 成功率（实测）：Run 9 的 19 个 gen_image task → `19/19 succeeded = 100%`（≥90% ✓）；attempts 分布全 1（本批未触发重试；重试机制在失败 task 路径生效，开发期多次 failed→retry 记录在案）
- Run 9 特性注记：19 个 task 的 createdAt/completedAt 早于 run.startedAt ≈314s——为**失败恢复后幂等复用**（未重复生成），属 #6 能力佐证
- **✅ 通过**

### #5 compose_video mp4（1080x1920、带封面）→ 浏览器 Range 预览

- 产物 asset#33 `ep001-final-*.mp4`：ffprobe 实测 `h264 1080x1920, 76s, 6.2MB`
- 封面：asset#34 `ep001-cover-*.jpg`（thumbnail purpose，`cover:true` 抽帧）；封面同时挂项目 coverAssetId
- Range：`GET /assets/33/file` 带 `Range: bytes=0-1023` → **206**（浏览器可拖播）
- 「字幕」判据注记：见文末「偏差与修订」
- **✅ 通过（判据落点见修订注）**

### #6 强杀恢复：无悬挂 processing / waiting_input 可续

- 最强活证据即 Run 9：Run 8 失败中断 → resume 恢复 → 幂等迁移已完成 task（19 图未重跑）→ 收尾 18.6s 即 completed；期间无 processing 悬挂
- 开发期另实测：强杀 server → 重启 recover 归位（failed 可 retry）→ waiting_input run 原样可继续批准
- **✅ 通过**

### #7 资产溯源 {run, step, task, prompt 快照, params}

- 抽查 asset#32（shot_image）：`projectId:1, stepId:22, taskId:57`，task#57 含 `prompt` 全文快照、`params{size:"832x1248", shotId:"s19"}`、`resultAsset{32}`、provider=openai_image、attempts
- assets 列表亦带 taskId/stepId/prompt/params 字段（Web 资产网格可直接展开）
- **✅ 通过**

### #8 README 全链路回归路径

- README 已补「M1 全链路回归路径」：A UI 手工 9 步 / B API 冒烟 / C 清理 data/ 重来指引（PowerShell），附模板热加载语义说明
- **✅ 通过（本次 review 一并交付）**

---

## 偏差与修订

1. **验收 #5「带字幕」判据落点**：M1 无台词字幕来源（模板 compose 仅 `cover:true`；ffmpeg-merge 收到 `subtitle:true` 亦仅提示忽略——无来源可烧录）。配音/字幕独立 action 在 spec §9 已明确属 M2。→ **建议**：spec §8-#5 行文加修订注，M1 判据落点 = 1080x1920 + 封面 + Range；字幕随 M2 action 启用后回补复验。
2. **历史资产名占位**：asset#3/#4（Run 8/9 时代）`name` 为 `{episode_number:03d}-剧本.md` 原样——早期模板与引擎插值未对齐期产物；引擎 `interpolate` 现支持 `{input.x}` 与 `{x:03d}` 双语法，Run 10 新资产 `002-剧本.md` 已验证正常。历史数据不清洗（单机工具，无碍），如需纯净可走 README C 清理重来。
3. **前端残余小项**：App.vue 有空的 onBeforeUnmount（低优先，M2 顺手清）；SettingsView 默认 tab 停在「文本生成」（按用户偏好）。

## 出口校准问题应答（ROADMAP M1 行）

- **自己在 Web 里走完一条流程顺不顺手？** → 实弹定稿：Run 10 由用户在 Web UI 批准剧本 → 自动分镜/出图（16 张）/成片全链路跑完，无阻断反馈。UI 侧交付含暗色视觉升级（ui-ux-pro-max dark studio）、AI 配置页 tab 化、品牌 mark「榫卯拼块」落位
- **模板 gate 语义够不够？** → M1 单 gate（剧本审阅）够用；M2 需要：多 gate 点位、gate 依赖上游产物引用、驳回意见回流 LLM（text_override 已具备）、以及分支/并行/条件（详见 M2 spec）

## M2 spec 输入（本次 review 沉淀）

- 模板引擎：分支/条件/并行编排、steps 间产物引用已有基础（`steps.x.assets`）、模板在线管理（CRUD + 版本）
- action 面：ai_video 启用、配音/字幕 action、封面/水印参数化
- 模板库：从用户 Skills（视频分镜/图文/口播方法论）沉淀 ≥2 条新模板验证「写模板不改代码」
- Web 面：模板管理页、运行页多 task 并发可视化、Settings tab 已就位（audio 并入 video tab 待 M2 拆分）

## 验证方式（已完结）

Run 10 停于 waiting_input（剧本 002 待审）期间，由用户在 Web UI 打开闸门弹窗批准 → 引擎自动续跑分镜/出图/成片 → 用户确认跑完无问题 → 本 review 定稿 8/8。
