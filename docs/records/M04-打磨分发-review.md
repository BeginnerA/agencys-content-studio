# agencys-content-studio M4 里程碑 review

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-11
- 对应 spec：`2026-09-10-agencys-content-studio-m4-design.md`（§8 验收 / §9 出口校准）
- 判定：**10/10 通过**（证据采集方式：probe:m4 静态全量 75 项 + 真实服务端到端实弹——REST / 真库落账 / zip 解包自校验 / 无头 Edge DOM + CDP 实点；服务运行中采集，Run 42–62）

---

## 结论摘要

M4 五项主项（E1 批量运行 / E2 成本与用量 / E3 导出分发 / E4 复盘数据 / W1 Web 配套）全部落地，且以「真实批次实弹 + 真库落账 + 解包自校验」方式逐条验证：串行批次全程活跃 ≤1、gate 挂起跨崩溃持久、批量取消在动作执行竞态窗口命中后仍收敛、断点续跑独立成 run；四类用量单位（tokens / image / char / second）全部真实落行；定价快照语义成立（改价不篡改历史、删价后旧行保持 unpriced）；发布包 zip 一包即达（manifest.json + video/cover/text/other 分目录）；统计看板与 SQL 直查 / 探针断言三方一致。

亮点：

- **发布包一包即达**：单 run 导出与批量导出均为「manifest.json + 四类分目录」zip（fflate store 流式），勾选语义与集对集语义均可解包自校验（重名 `-1` 后缀、role 标注、图片魔数可打开、下载字节数 = fileSize）。
- **成本快照可审计**：usage_records 行级记录单价快照；改价（Run 56→57）与删价（Run 62）实验证明历史账不被回溯篡改；未计价行在 UI 与 API 两侧同口径暴露。
- **零引擎重构**：E1 仅新增自研调度服务（~120 行）+ engine 单监听口；batches / usage_records / publications 均为通用表；三模板零回归（含静态分支开关全关路径）。
- **韧性实测**：取消 / 批准与崩溃恢复经故障注入（2 种崩溃场景 × 2 批次）实测收敛；调度不足（跨 run 依赖 / DAG 编排）的信号未出现——红线维持。

---

## 验收逐条对照（spec §8）

### #1 批量串行 + gate 停滞

- **操作**：项目页建 3 行批次（note-clip @ 项目 4，`max_concurrent=1`）→ run1 挂 draft gate 保持 ≥60s → 批准 → 依次推进。
- **证据**：`01-serial.json` **9/9**。批次 1（run 42/43/44）：挂起期间活跃数 = 1、run2/3 稳定 queued（30s/60s 双采样）；批准后 run2 启动并挂 gate、run3 仍 queued；终态 `total/finished/succeeded = 3/3/3`。
- **✅ 通过**

### #2 批量失败与续跑

- **操作**：3 行批（批次 2，run 45/46/47）；run2（46）在 draft 挂起期经运行页取消 → 批次继续 run3 → 对 run46 断点续跑。
- **证据**：`02b-run46-recovery.json` **6/6**。批次收敛 `partial_failed`（s=2/f=3/fail=0）；run46 取消残留态（waiting_input 残留 + 后续步 cancelled）复现并收敛；续跑 run48 独立于批次（`batchId=null`）、已完成步骤复用、skipped 语义正确、终态 completed。
- **✅ 通过**

### #3 批量取消与崩溃恢复

- **3a 批量取消**（批次 3，run 49/50）：`03a-batch-cancel.json` **7/7**。取消时刻 run49 的 draft 动作执行中（**竞态窗口命中**）→ queued run 全 cancelled、活跃 run 终态 cancelled（draft 步 cancelled 而非盲写 waiting_input）；30s 观察窗内无 run / 步骤进入 running；批次收敛 cancelled（t=2/f=2）。
- **3b-a gate 持久性**（批次 4，run 51/52）：`03b-a-gate-persistence.json` **7/7**。run1 running 中断 → 重启后 `waiting_input` 保留（未误置 failed）、run2 仍 queued（未绕过槽位）→ 批准后 run1 completed、run2 获槽推进并 completed；批次收敛 completed（s=2/f=2）。
- **3b-b running 中断**（批次 5，run 53/54 → 续跑 run 55）：`03b-b-running-interrupted.json` **10/10** + `03b5b` 时间戳追证 **4/4**。run54 中断按 recover 语义收敛 `failed（error=interrupted）`；批次 `partial_failed`（s=1/f=2/fail=1）；续跑 run55 保留 recall/draft succeeded、悬挂 running 步重排队（startedAt 时间戳追证）、completed；批次不回写。
- **✅ 通过**

### #4 成本捕获（四类用量单位落行）

- **操作**：note-clip 单跑（含 LLM+image，run55）；talking 跑批（char，run59）；mengbao 开动效（second，run61）；三模板批次（tokens，run58/59/60）。
- **证据**：run55 unit 行 `image=3 / tokens_in=1353 / tokens_out=572`（记录时未配定价 → 全行 unpriced，属配置预期）；run59 `char=294`（24 句逐句落行）；`10-second-usage.json` **5/5**：run61 `second=100`（20 行，≈20 镜 × 5s，provider_model = `pollinations_video:minimax/minimax-h3-max-turbo`）；`10-templates.json` 内 tokens 行（run58 `6627/17137`、run59 `3035/6206`）含计价验算。
- **✅ 通过**

### #5 定价与聚合（快照语义）

- **操作**：配 P1（tokens_in 2 / tokens_out 8 / image 0.05）→ run56 → 改 P2（10 / 20）→ run57 → 清空定价 → run62 → 恢复定价。
- **证据**：`05-pricing.json` **13/13**（含 correction：image 聚合浮点尾差 → 05b 容差 1e-9 追证 **3/3**）：run56 单价验算（3777×2/1e6、2532×8/1e6、3×0.05）；**改价后 run56 全行成本不变**（快照）；run57 按新价验算（3721×10/1e6 = 0.03721）；`group_by=kind` 合计 = 明细之和。`10-unpriced.json` **9/9**：清空定价后 run62 全行 unpriced；UI「133 条用量未计价」== 同刻 API 133/133；恢复定价后 run62 历史行仍 unpriced（改价不篡改历史）。
- **✅ 通过**

### #6 单 run 导出

- **操作**：运行页导出向导（run55）勾选 5 资产 → 生成 → 下载 zip → 解包。
- **证据**：`06-single-export.json` **12/12**；`06-export.zip`（312KB）解包自校验：manifest.json（version=1，run.id=55）、`video/cover/text/other` 分目录符合 role 映射、files 数量与 assetId 集合 = 勾选（5）、每文件 size 与 manifest 一致、图片魔数可打开、文本非空、`GET /exports?run_id=55` 可见。
- **✅ 通过**

### #7 批量导出

- **操作**：批次页批量导出（批次 3 混合产物 + 批次 4 全产物）。预期「每有产物 run 各 1 包，跳过无产物 run」。
- **证据**：`07-batch-export.json` **12/12**；批3 items 数 = 有产物 run 数（skipped 记录无产物 run + reason）、包名含批次名 + 集序号；批4 items=2 各 1 包；抽包（run51）manifest.run.id=51 且 files.assetId 集合 = run51 全部产物（**集对集**）；`07-batch-export.zip`（114KB）。
- **✅ 通过**

### #8 发布登记与统计

- **操作**：运行页「标记发布」2 条（douyin@run55 / bilibili@run51，含链接与指标）→ 更新指标 → 项目页记录区块 + `/stats/overview` 三方核对。
- **证据**：`08-publications.json` **19/19**：项目页汇总 = 两条之和（views 2300 / interactions 173）；overview.publications 一致；平台筛选 / 指标更新 / 负例（非法平台与 URL 校验）全部通过。
- **✅ 通过**

### #9 统计页数据核对

- **操作**：`/stats` 试 7/30/90 天、项目筛选、成本构成切 `provider_model/kind`；对照 overview 与 SQL 直查。
- **证据**：`09-stats-page.json` **14/15**（1 项前提修正 → `09b` 守恒追证 **6/6**：sum(各项目)=全局）+ `09-stats-ui.json` **29/29**（同刻 API 采样 + 无头 Edge DOM 动态对齐，避免静态数字漂移）+ `09-stats-ui-interactive.json` **16/16**（CDP 实点：7/90 天切换、项目筛选、分组切换）+ 截图（172KB）人工查证（KPI / 柱状图 / 成本表 / 状态分布 / 项目对比渲染正确）。未计价条目数与 usage `group_by=provider_model` 的 unpriced 行数一致。
- **✅ 通过**

### #10 README + 三模板无回归

- **操作**：三模板各复跑 1 条（mengbao 静态分支全关 run58 / talking 常规 run59 / note 常规 run60）。
- **证据**：`10-templates.json` **16/16**（A 6/6 + B 5/5 + C 5/5）：run58 —— `gen_images succeeded`（20 镜）、`gen_motion/gen_refs [skipped] when_condition`、分镜免审、`compose_video succeeded`、tokens/image 计价；run59 —— `voice/subtitle` succeeded、成片、`char>0`、tokens；run60 —— `inline_images skipped`（仅封面）、`publish succeeded`、tokens/image。服务日志无 error；M4 新增能力零改变既有模板行为。README 六处更新与本记录同批交付。
- **✅ 通过**

---

## 偏差与修复记录

1. **引擎缺陷修复：cancel/gate 竞态（本阶段唯一引擎改动，另行单独提交）**。现象：#2 验收中 run46 取消后残留 `waiting_input`（completedAt 残留、后续步已 cancelled），批次已 partial_failed 但 run 卡非终态。根因：动作执行期间（如 LLM 调用）收到 cancelRun，动作不可中断，完成后 engine 盲写 succeeded/waiting_input 覆盖终态。修复：`engine.ts` 动作返回后先复查 run 状态，cancelled 则抛 `RunCancelledError`；`index.ts` 事件桥补 catch。**先存证（03b-part1）后修复**，修复后 #3a 以「取消时 draft 动作执行中」的竞态窗口复验 **7/7**。
2. **验收断言时机修正（03b5 → 03b5b）**：悬挂步「重排队」在服务重启后立即采样存在时序差；改以 `startedAt` 时间戳追证（新 run cover/inline_images startedAt ≥ resumeAt、keep 步 startedAt=null）**4/4**。
3. **浮点尾差修正（05 → 05b）**：聚合行 `0.05×3 = 0.15000000000000002` 与字面 0.15 精确比较失败；属 IEEE754 加法尾差，改容差 1e-9 追证 **3/3**（单条单价 0.05000000000000001，语义无差）。
4. **静态预期修正（09c → 09d/09b）**：①「资产 421/图片 145」为采集期用户真实上传 4 图导致漂移、「69383」页面按 fmtQty 显示「6.9 万」——改为「同刻 API 采样 + dump-dom」动态对齐 **29/29**；②「项目筛选结果=全局」前提错误（项目数=4 非单项目）——改守恒断言 sum(各项目)=全局 **6/6**。
5. **操作注记：崩溃注入的实现方式**（验收基建，非产品偏差）：环境无法交互式 Ctrl+C，验收脚本以「独立子进程延时自灭 + 就绪探测轮询」实现可控崩溃注入；瞬时步骤（LLM 调用短）曾两次错过窗口，改就绪信号触发后精确命中。

---

## 出口问题作答（spec §9：是否达到个人主力工具标准）

### 客观数据（`GET /stats/overview?days=30` + SQL 直查，2026-09-11 采集）

| 指标 | 值 | 说明 |
|---|---|---|
| activeDays | **3 / 30** | 「打开频率」代理：09-09（17 run）/ 09-10（40）/ 09-11（5） |
| run 总数 | **62** | completed 33 / failed 20 / cancelled 9 |
| 完成率（终态口径） | **53.23%** | 含验收故障注入（取消 / 崩溃 / 负例实验），非日常使用预期口径 |
| 累计成本 | **¥1.880886** | 全时间 = 近 30 天；usage 端 133 条未计价行（删价实验期产物） |
| 资产总数 | **526** | 文本 181 / 图片 175 / 视频 87 / 音频 79 / 归档 4 |
| 发布登记 | **2** | 播放 2300 / 互动 173（含一条指标更新） |

行为侧信号：验收期间用户主动上传素材 4 张（萌宝冒烟项目）——工具已进入真实使用而非纯测试。

### 用户主观确认（2026-09-11）

**「愿意日常使用，且有补强期待」**——即达到「个人常用工具」标准，同时明确期待后续补齐能力（定时调度、导出平台化定制等，见 Backlog）。

### 判定

出口问题「是否达到个人主力工具标准」→ **方向性判定：达到**（三维证据：客观活跃度与完成链路 / 四类用量与导出发布全链实测可用 / 用户主观愿意日常使用）。明确局限：单机个人小数据，20 failed / 9 cancelled 中多数为验收故意注入，完成率不代表日常预期。补强项转 Backlog，由「持续运营」态驱动（M4 为四阶段最后一阶，不再预设 M5）。

---

## 局限与 Backlog

- **继承 spec §9**：批次失败集聚合重跑、定时调度、导出包平台化定制（用户补强期待）、CSV 数据分析、三层记忆 / 摘要压缩、一致性 A/B、情绪实例接入、角色语义检索 / 参考图 i2i。
- **本轮新增观察**：
  - 视频单价未配置（Run 61 `second` 行 unpriced）——定价表已支持 `provider:model` 级扩展，属配置项而非代码缺口；
  - 完成率口径受验收故障注入污染（见上），后续如需「日常完成率」可增加测试标记过滤；
  - 并发档 `max_concurrent>1` 未实弹（调度支持 1–3），待真实批量需求出现时复验；
  - 导出包「平台化定制」（按平台要求命名 / 尺寸）为 Backlog 首选补强项。
- **引擎红线复核**：M4 未引入任何外部编排引擎；调度为 ~120 行自研服务 + engine 单监听口；本轮未暴露跨 run 依赖 / DAG 编排需求——红线结论维持。

---

## 附录

### A. 机制面回归（Step 1 门）

- 双端 typecheck 0 错误 / web build ✓
- `probe:m4` 五 section **75 项全 PASS**：migrate 4 / usage 17 / batch 26 / export 18 / stats 10（退出码 0；隔离临时库，不触碰开发库）

### B. 验证命令清单（样例）

```powershell
curl.exe http://127.0.0.1:3001/api/v1/stats/overview
curl.exe "http://127.0.0.1:3001/api/v1/stats/usage?group_by=kind"
curl.exe "http://127.0.0.1:3001/api/v1/stats/usage?run_id=55&group_by=unit"
curl.exe "http://127.0.0.1:3001/api/v1/batches?project_id=4"
curl.exe "http://127.0.0.1:3001/api/v1/publications?project_id=4"
# 导出包（zip）下载后解包自校验：manifest.json + video/cover/text/other
```

### C. 验收 Run / 证据索引

| Run | 批次 / 场景 | 用途 | 关键证据 |
|---|---|---|---|
| 42/43/44 | 批次 1 | #1 串行 + gate 停滞 | 01-serial.json 9/9 |
| 45/46/47 → 48 | 批次 2 | #2 partial_failed + 续跑 | 02b-run46-recovery.json 6/6 |
| 49/50 | 批次 3 | #3a 批量取消（竞态命中） | 03a-batch-cancel.json 7/7 |
| 51/52 | 批次 4 | #3b-a gate 跨崩溃持久 | 03b-a-gate-persistence.json 7/7 |
| 53/54 → 55 | 批次 5 | #3b-b running 中断 + 续跑 | 03b-b-running-interrupted.json 10/10 |
| 55 | — | #4 usage（1353/572 + image 3）/ #6 导出 / #8 登记 | 06-single-export.json / 08-publications.json |
| 56/57 | — | #5 定价快照（P1→P2 改价对照） | 05-pricing.json 13/13 |
| 58/59/60 | — | #10 三模板无回归 | 10-templates.json 16/16 |
| 61 | — | #4 second=100 落行 | 10-second-usage.json 5/5 |
| 62 | — | #5 删价 unpriced | 10-unpriced.json 9/9 |

### D. 证据文件清单（`scripts/.tmp-m4-evidence/`，随交付清理）

01-serial(9) / 02b(6) / 03a(7) / 03b-a(7) / 03b-b(10)+3b5b(4) / 05-pricing(13)+05b(3) / 06-single-export(12)+zip / 07-batch-export(12)+zip / 08-publications(19) / 09-stats-page(14/15+conservation 6) / 09-stats-ui(29) / 09-stats-ui-interactive(16) / 10-templates(16) / 10-second-usage(5) / 10-unpriced(9) / probe-m4-final(75)

## 验证方式（已完结）

实弹采集：Run 42–62 共 21 个 run 真实终态（含 5 个批次 + 2 次崩溃注入 + 1 次取消竞态）；导出链路以「zip 解包自校验」硬验证；统计链路为「探针 SQL 直查 + REST + 无头浏览器 DOM/CDP」三方对齐；成本链路以「行级单价验算 + 改价 / 删价对照」验证快照语义。所有临时脚本与中间产物（`scripts/.tmp-m4-*` 与 `.tmp-m4-evidence/`）随交付清理。
