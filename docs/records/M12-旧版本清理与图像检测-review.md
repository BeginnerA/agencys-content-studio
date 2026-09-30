# agencys-content-studio M12 里程碑 review

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-12
- 对应 spec：`2026-09-12-agencys-content-studio-m12-design.md`（§6 验收）
- 判定：**实弹六项 6/6 通过**（证据采集方式：probe:m12 六节 66 项断言；真实开发库实弹——HTTP 序列 T1–T7、DB 终态逐值核对 20/20、真实上传黑图实测、无头 Chrome CDP DOM 10/10；项目 10 / Run 95；服务运行中采集）

---

## 结论摘要

M12 两项主项（旧版本清理与收藏 / 图像检测）全部落地，且以「真实开发库实弹 + DB 逐值核对 + 浏览器 DOM」方式逐条验证：收藏全链（♥ → API 回读 → 「仅收藏」筛选 → 清理豁免）闭环；版本清理按「保留最新 / 收藏 / 被引用」三规则在工作台级与项目级双范围实测，终态软删集合与预测精确一致、零误伤；软删 → 显式 gc 两段式回收（freed_bytes 实测、行保留审计、幂等）；图像检测在生成 / 上传双写路径生效（含 limited-range 纯黑 Y=16 边界实测命中），异常图仅徽标与合成警告、零阻断。至此 18 项 backlog 组1「镜头链与工作台运营」8 项（M10×3 + M11×3 + M12×2）全部落地。

亮点：

- **零库零依赖**：assets 表结构不动（`is_favorite` / `params` 全复用），`schema.ts` / engine / refs / loader / 适配器 / 模板 / 提示词全局零 diff；检测复用 ffmpeg-static（零新依赖），package.json 仅 +`probe:m12` 脚本。
- **三重保留防误删实测**：工作台级 `groups=19 / cleaned=1（#919）/ kept=19`、项目级 `groups=106 / cleaned=2（#831·#1012）/ kept=106`；终态逐值核对 **20/20**——保留资产 #920（引用 + 最新）/ #1033（引用 + 最新）/ #1108 未软删且文件完好、#920 选中态与缩略图不变。
- **边界校准闭环（`<` → `<=`）**：ffmpeg limited-range 纯黑的 Y 基准 = 16，初版 `yavg < 16` 会漏判为 `flat`；校准为 `yavg <= 16` 后，探针黑样本 `{ymin:16,ymax:16,yavg:16}` 与实弹上传黑图 #1148 双双命中 `black`——设计文档 §2.5 已同步回写。
- **两段式回收可回溯**：清理只软删（board / 列表即时消失、可恢复行），物理删除仅在 `gc` 显式触发（danger 强确认、失败跳过、幂等）；实测 `files=4 / freed_bytes=2,981,444`、行保留、现存文件 0。

---

## 验收逐条对照（spec §6.3）

### #1 收藏——素材页 ♥ → API 回读 → 「仅收藏」筛选 DOM

- **操作**：项目 10 素材页对 #1108 收藏（`PATCH /assets/:id {is_favorite:true}`）→ API 回读 → 无头 Chrome 打开资产页核对 ♥ 激活态并开启「仅收藏」筛选。
- **证据**：T3 响应 `{asset.isFavorite:1}` 与回读一致；DOM：♥ 激活态（title「取消收藏 1789200423120-gen-jpg.jpg」）、「仅收藏」筛选后网格仅剩 1 张（#1108）——`tmp-m12-dom-2-projects-favfilter.png`。
- **✅ 通过**

### #2 清理——工作台级 / 项目级 → 保留规则与 DB 逐值核对 → board 刷新

- **操作**：Run 95 工作台「清理旧版本」→ board 刷新复查 → 项目级 `cleanup-versions` → DB 全量终态核对；#919 清理后单资产 404 复查。
- **证据**：工作台级 `groups=19 / cleaned=1（#919）/ kept=19` → board 复查 ids=[831,920]（#919 消失、选中仍 #920）；#919 软删后 `GET /assets/919` 404；项目级 `groups=106 / cleaned=2（#831·#1012，#919 已软删跳过）/ kept=106`；终态逐值核对 **20/20**：软删行 = [831,919,1012,1141]（本轮 #919/#831/#1012 + 历史遗留 #1141），保留资产 #920/#1033/#1108 未软删且文件完好。
- **✅ 通过**（T4 首跑 2 项断言失败为验收脚本预期口径差——`cleaned=1` 精确命中；详见「偏差与修复记录」#2）

### #3 检测——`POST /assets/:id/check` 对存量图 → params.quality 真实统计 → 徽标 DOM

- **操作**：对存量图 #1108 调手动重检；另经上传通道写入 320×240 纯黑 PNG（#1148）验证写路径自动检测；核对素材页 / 工作台徽标。
- **证据**：T2 `quality={ok:true,reason:'ok',stats:{ymin:0,ymax:244,yavg:69.3657,satavg:16.9465},checkedAt:1789217601830}` 落盘回读；#1148 上传约 2s 后回读 `quality={ok:false,reason:'black',stats:{ymin:16,ymax:16,yavg:16,satavg:0}}`；DOM「疑似黑图」徽标唯一命中 #1148——`tmp-m12-dom-1-projects-grid.png`。
- **✅ 通过**

### #4 回收——软删资产 → `gc` → 文件消失 + freed_bytes 实测

- **操作**：对项目 10 全部软删资产（本轮清理产物 #831/#919/#1012 + 历史软删 #1141）执行 `POST /projects/10/assets/gc` → 文件系统 + DB 终态核对。
- **证据**：T6 `files=4 / freed_bytes=2,981,444`（=80,418+246,735+261,815+2,392,476）；终态：#831/#919/#1012/#1141 文件均不存在、行保留（`deletedAt` 非空）；活资产 #920/#1033/#1108 文件完好；交付前实时复核：素材 total=339（338 + 黑图 #1148）且软删四行均不在列表。
- **✅ 通过**（幂等 / 失败跳过 / thumb 回收在 probe `gc` 节覆盖）

### #5 兼容——存量 run board 正常（无 quality 不误报）；素材页老资产无徽标

- **操作**：读取存量 Run 95 board 与素材全量列表；DOM 复核板面与素材页。
- **证据**：T1 board 200：20 镜 / 22 版本 `quality` 全 null、#919/#920 同组 ids=[831,919,920]、选中 #920；列表复读：老资产无 `quality` 字段（#920/#1033 实测为空）、#1108 收藏与检测结果保持；DOM：板面 33 卡零误报（qwarn=0）、素材页仅 #1148 有徽标。
- **✅ 通过**

### #6 DOM 四要素——徽标 / ♥ / 仅收藏筛选 / 清理确认弹窗

- **操作**：系统 Chrome headless + CDP 打开项目 10 资产页（`?tab=assets`）与 Run 95 运行页，实点核对四要素并截图。
- **证据**：脚本 **10/10 全过**：①「仅收藏」checkbox 存在 ②「疑似黑图」徽标唯一（tmp-m12-black.png）③♥ 激活态（#1108）④仅收藏筛选后仅剩 1 张 ⑤「清理旧版本」按钮可用 ⑥板面 33 卡零误报 ⑦确认弹窗全文（标题「清理旧版本」+ 保留规则正文 + 取消 / 开始清理按钮）⑧取消关闭且未执行清理。截图 5 张存留：`apps/web/tmp-m12-dom-1..5-*.png`。
- **✅ 通过**

---

## 静态与探针（spec §6.1 / §6.2 / §6.4）

- **typecheck**：server `npm run typecheck` 0 错误；web `vue-tsc` 0 错误（交付前复跑，退出码均 0）。
- **`probe:m12` 六节 66 项断言全绿**（隔离临时库，零网络零计费）：cleanup（保留规则矩阵 / 上传组 / 已软删跳过 / 非图视跳过 / 范围过滤）/ imagecheck（黑·灰·正常·截断·缺失五样本判定 + stderr 解析容错）/ gc（回收 + freed_bytes + 行保留 + 幂等）/ board（isFavorite / quality 容错：无 params / 坏 JSON / 缺失字段）/ merge-guard（异常图 warnings、正常图零警告、M7 原字段不破）/ regression。
- **回归**：`probe:m7 / probe:m10 / probe:m11` 全绿（= spec §6.2-6 定义回归集；覆盖 M12 改动面 shot-workbench / ffmpeg-merge 的既有调用方）。
- **越界核查（§6.4）**：`git status` 核查——`schema.ts` / engine / refs / loader / 适配器 / workspace 模板与提示词零 diff；package.json 仅 +`probe:m12` 脚本、dependencies 零新增。改动面 = 14 改（+610/−18）+ 2 新服务（image-check / version-cleanup）+ 探针 + 5 截图；另含 Web 小件 `Icon.vue` / `format.ts`（图标与质量文案映射）。

---

## 偏差与修复记录

1. **阈值边界校准（产品级，probe 定稿前）**：ffmpeg limited-range 纯黑 Y 基准 = 16，初版 `yavg < 16` 将其漏判为 `flat`；校准 `yavg <= 16`（代码注释「含 limited-range 黑基准 Y=16 的边界（实测校准）」）。证据：probe 黑样本 `{ymin:16,ymax:16,yavg:16}` → `black`；实弹 #1148 上传黑图同边界命中 `black`。设计文档 §2.5 已回写。
2. **验收脚本预期口径修正（T4）**：初版预期「run95 级 `groups=1 / kept=1`」（只算了 #919/#920 所在一组）；实测 `groups=19 / kept=19`——run95 该步骤范围实际含 19 个版本组。`cleaned=1（#919）` 精确命中；改以 DB 终态逐值核对（20/20）闭环。属验收脚本口径问题，非产品缺陷。
3. **DOM 验收基建（Browser MCP → CDP）**：Browser MCP 传输故障 → 改用系统 Chrome headless + CDP WebSocket 直连；脚本三处口径修正（素材页深链接 `?tab=assets`；「清理旧版本」按钮按多工作台计数 ≥1；弹窗按钮位于 Modal footer 而非 `.cfm` 内）。属验收基建，非产品缺陷。

---

## 局限与备注

- 按设计 §1.3 明确排除（不做，非缺陷）：存量资产检测批量回填、单卡删除 UI、已清理资产恢复（回收站）、分镜 / 文本资产版本清理、图像内容审核 / NSFW、素材页多选批量操作。
- 验收留存物：黑图资产 #1148 保留于项目 10（供 Web 端验收查看徽标）；DOM 截图 5 张保留于 `apps/web/tmp-m12-dom-1..5-*.png`；全部临时脚本 / 日志 / Chrome profile 已清理。
- 续跑链工作台限制（README M11 验收快照 #11 发现）本轮未触碰，维持「列后续批次」状态。

---

## 附录

### A. 实弹证据索引（项目 10）

| 检查点 | 载体 | 关键证据 |
|---|---|---|
| T1 兼容读 | `GET /runs/95/shot-board?step_key=…` | 20 镜 / 22 版本 quality 全 null；#919/#920 同组 |
| T2 检测 | `POST /assets/1108/check` | `{ok:true, yavg:69.3657}` 落盘回读 |
| T3 收藏 | `PATCH /assets/1108` | `isFavorite=1` 响应 + 回读 |
| T4 清理（工作台级） | `POST /runs/95/shots/cleanup` | `groups=19 / cleaned=1（#919）/ kept=19`；board ids=[831,920] |
| T5 清理（项目级） | `POST /projects/10/assets/cleanup-versions` | `groups=106 / cleaned=2（#831·#1012）/ kept=106` |
| T6 回收 | `POST /projects/10/assets/gc` | `files=4 / freed_bytes=2,981,444` |
| T7 终态复读 | 素材列表 + DB 逐值 | 20/20（软删集合 [831,919,1012,1141]，零误伤） |
| 黑图写路径 | 上传 #1148（320×240 纯黑 PNG） | `black`（yavg=16 边界命中） |
| DOM 四要素 | 无头 Chrome CDP | 10/10 + 5 张截图 |

### B. 验证命令样例

```powershell
curl.exe -X POST http://127.0.0.1:3001/api/v1/assets/1108/check
curl.exe -X POST http://127.0.0.1:3001/api/v1/projects/10/assets/cleanup-versions
curl.exe -X POST http://127.0.0.1:3001/api/v1/projects/10/assets/gc
curl.exe -X PATCH http://127.0.0.1:3001/api/v1/assets/1108 -H "content-type: application/json" -d "{\"is_favorite\":true}"
pnpm --filter @acs/server probe:m12
```

## 验证方式（已完结）

实弹采集：项目 10（m8-实弹验收）单项目全链——HTTP 序列 T1–T7 + 终态 DB 逐值核对 + 真实上传黑图 + 无头 Chrome CDP 双页 DOM；探针为隔离临时库 66 项断言；回归 m7/m10/m11。所有临时脚本与中间产物（tmp-m12-*）随交付清理；黑图资产 #1148 与 5 张 DOM 截图保留供验收。文档同批交付：本 review + roadmap `M12 注记` + README `M12 能力速览 / 验收快照`。
