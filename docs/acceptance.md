# 里程碑验收快照

各里程碑的静态验证 + 探针 + 实弹验收记录（M1–M17 按时间序；后续里程碑的验收结论见 [milestones.md](./milestones.md) 各节「验证」段）。表中的 Run 号 / 资产 id / 截图路径为当时运行证据；自跑回归见 [testing.md](./testing.md)。

## M1 验收快照（历史）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | `pnpm dev` 双端 + `/health` 全绿 | ✅ | db/ffmpeg/workspace 均 ok |
| 2 | Web 建项目 + 上传 imports 去重 | ✅ | 项目 1；brief×2/source×1 资产 |
| 3 | 流式日志 → waiting_input → Web gate 审阅 | ✅ | Run 10（真实 UI 审阅通过） |
| 4 | storyboard ≥8 shots；并发 ≤2、重试 1 次、成功率 ≥90% | ✅ | 19 shots；19/19 成功（100%） |
| 5 | mp4 1080x1920 带封面 → 浏览器 Range 预览 | ✅ | ffprobe 实测 1080x1920/76s；206；**字幕判据由 M2（T2 烧录）回补复验** |
| 6 | 强杀恢复：无悬挂 processing、waiting_input 可续 | ✅ | Run 9 由失败恢复 completed（幂等复用） |
| 7 | shot_image 可溯源 {run,step,task,prompt,params} | ✅ | asset#32 → run9/step22/task57 |
| 8 | README 回归路径 | ✅ | 见 [testing](./testing.md) A/B/C（M2 版已更新） |

## M2 验收快照（历史）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 编排语义实弹：gate skip / when 互斥 / 并行与 skipped 呈现 | ✅ | Run 24→26：分镜闸门「免审直接出图」记 `user_skip`（产物保留）；`gen_images` 按 `motion` 互斥跳过 |
| 2 | 快照隔离：运行中改模板不影响续跑；新 run 用新模板 | ✅ | Run 29（gate 挂起 → PUT 改模板 → 批准续跑仍按快照）；Run 30（新 run 即时含新步骤） |
| 3 | 模板在线管理：校验 / CRUD / 即时生效 / 坏 YAML 不改文件 | ✅ | 坏 YAML validate 内联报错（含行号）且 PUT 400 保持原文件；保存后新 run 即用（Run 30） |
| 4 | ai_video 启用：真实出片 + 溯源 + 中断恢复 | ✅ | Run 21（10 段）/ Run 26（20 段 = 复用 9 + 重跑 11）；溯源含 provider / model / 参数快照 |
| 5 | 配音字幕：voice 资产 + 字幕烧录（回补 M1 #5） | ✅ | Run 18：11 段 voice（ffprobe mp3）；成片含 aac 音频流 + OCR 抽帧双点字幕命中 |
| 6 | 三流合成：时长对齐、音轨可听 | ✅ | Run 18 成片 60s：h264 + aac 44.1kHz 立体声与画面等长 |
| 7 | 恢复 / 重试：强杀 recover + resume 幂等 | ✅ | Run 22 强杀 → recover（幂等 ×2）→ resume Run 23 completed（仅重跑 9 个未完成） |
| 8 | 北极星：两条模板端到端跑通（模板驱动不改码） | ✅ | T1 v2 / T2 全链路模板驱动；期间修复 2 个引擎缺陷（见 review，非流程定制） |
| 9 | README 回归路径更新（含 M1 #5 字幕回补复验） | ✅ | 本文件；M1「字幕」判据由 T2 实际烧录关闭 |
| 10 | 无回归：M1 存量 run 续跑 + 静态分支 | ✅ | Run 8（M1 无快照）resume → Run 25 completed（引擎按 v2 补充步骤行、复用 M1 产物） |

## M3 验收快照（2026-09-10）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 记忆基建：status / 近义检索 / 重建索引 | ✅ | probe:m3 记忆 10 项；`/memories/status` 512 维；近义表达 top1 0.672（非字面） |
| 2 | 记忆 action 链路：空召回占位 → 落库 → 二次召回注入 | ✅ | Run 33 remember 落库；Run 34 recall `{count:1, topScore:0.583}` 且 draft prompt 快照含召回段 |
| 3 | 角色库：建档 + 定妆照 + 注入 + 二次 run | ✅ | Run 40：5 定妆照 + `created 5 / refAttached 5`；镜头任务 21/25 含「角色锚定…必须剔除」；Run 41：`updated 2 / refAttached 0` 且 18/18 注入；Web 角色页 6 名 |
| 4 | 音频情绪：六字段 + 字幕纯净 | ✅ | 资产 188 `params.{speaker,voice,voiceSource,voiceHint,emotionHint,emotionKey,emotionSent}`（emotionSent=null 待支持实例）；SRT 括注 0 命中 |
| 5 | 音画精确对齐：ffprobe 对照 | ✅ | Run 33：Σ23 句 58.88s = SRT 末条；首句 2.640s / 末句 2.480s 逐句一致；尾部 1.18s 静音垫（silencedetect） |
| 6 | T1 图文：reject/approve 双态 + 配图开关 | ✅ | Run 37（reject→attempts=2、意见注入；inline skipped）；Run 38（3 张内页 768x1024 + publish 配图顺序/溯源） |
| 7 | T2 v2 三态：全链 / 免审直烧 / 纯字幕 | ✅ | Run 33 成片 60s 含音轨字幕；Run 35 字幕闸门 `user_skip` 放行；Run 36 `estimated` SRT 无音轨成片 |
| 8 | T3 无回归：静态分支复跑 | ✅ | Run 41 completed（`gen_refs`/`gen_motion` 按 when 跳过，执行路径与 M2 同构） |
| 9 | 跨体裁复用率（出口问题 1） | ✅ | 三模板 action 矩阵：均 100%（零体裁专属新 action）；memory_recall/write 跨 2 模板、character_sync 跨模板可用 |
| 10 | README + prompts 体检 | ✅ | 本文件；12/12 prompt 外置可达、三模板 `promptsDirty=false`、模板页/prompts 页无告警 |

## M4 验收快照（2026-09-11）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 批量串行 + gate 停滞 | ✅ | 批次 1（Run 42–44）：挂起期活跃 ≤1、60s 不推进；终态 3/3/3 completed（01-serial 9/9） |
| 2 | 批量 partial_failed + 断点续跑 | ✅ | 批次 2（Run 45–47）：partial_failed（s=2/f=3）；续跑 Run 48 独立批、已完成步复用（02b 6/6） |
| 3 | 批量取消 + 崩溃恢复收敛 | ✅ | 批次 3 取消竞态命中 7/7；批次 4 gate 跨崩溃持久 7/7；批次 5 running 中断→failed(interrupted)→续跑 Run 55 completed（03b 10/10） |
| 4 | 成本捕获（四类用量落行） | ✅ | Run 55 image=3/tokens；Run 59 char=294；Run 61 second=100；Run 58 tokens 计价（10-second 5/5） |
| 5 | 定价快照 + 聚合口径 | ✅ | Run 56 P1 验算→改价后不变；Run 57 用新价；Run 62 删价全行 unpriced、UI 133 == API（05 13/13 + 10-unpriced 9/9） |
| 6 | 单 run 导出包（manifest/分组） | ✅ | Run 55 勾选 5 资产 → zip 312KB 解包自校验 12/12（manifest / 分目录 / 魔数） |
| 7 | 批量导出（集合相等） | ✅ | 批3 混合 / 批4 全产物双场景；抽包 Run 51 files.assetId = 全产物（集对集）（07 12/12） |
| 8 | 发布登记 + 统计一致 | ✅ | 2 条登记（douyin/bilibili）→ 项目页 2300/173 = overview（08 19/19） |
| 9 | 统计页数据核对 | ✅ | 动态对齐 29/29 + CDP 交互 16/16；守恒 sum(各项目)=全局 6/6；截图查证 |
| 10 | README + 三模板无回归 | ✅ | 本文件；Run 58/59/60 三模板复跑 16/16，无 error 日志 |

## M7 验收快照（2026-09-12，实弹）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 静态 + 探针：六 section 全绿（含实弹修复断言） | ✅ | `typecheck` 0 错；`probe:m7` 86 项全过（编辑即时读取、双口径同步、`parseShotDurations` 等新增断言） |
| 2 | 兼容回归：v6 存量 run 重新合成 | ✅ | Run 40：20 段/80s/每张 4s 与 M7 前一致；新成片带 `params.inputs` 快照（`shots_source:null`）；stale null→false |
| 3 | 编辑写路径（板面即时读产出侧最新分镜） | ✅ | Run 61 编辑 s01=8 → #763；再编辑 s02=3 → #764（`source_asset_id:#763` 链式、命名不累积）；板面立即刷新（无需引擎回写）；stale=true |
| 4 | 时长双口径（`duration` ↔ `duration_sec`） | ✅ | Run 61 板面 20 镜显示 LLM 值（s02 2→3 编辑同步双写）；Run 40 板面回退值（s01=3 / s08=2）；坏 JSON/非法条目容错 |
| 5 | 选片剔除 + 恢复 + 分镜序保序 | ✅ | Run 40 剔除 s01 → 19 段/76s（#765）→ reset 恢复 → 20 段/80s（#767）；s18=301 排在 s19=300 前（按分镜序非 id 序） |
| 6 | 逐镜容错：缺文件 skip+warn 出片 | ✅ | 移除 s01 图 → `#283 不可用已跳过` + `共跳过 1 个` + 19 段继续出片（#769 dur=76）；`params.skipped_shots=[283]`、inputs 记原始 20 id；恢复后 20 段（#771） |
| 7 | motion 路径兼容重新合成 | ✅ | Run 61：20 段镜头视频按实际时长合成（总 100s，#773 67MB），与旧成片 #519 同规格 |
| 8 | 单镜重生成 → 版本 2 + stale 变橙 | ✅ | Run 40 s01 重生成（attempts 1→2）→ `versions=[283,775]` 自动切新版 → stale=true；UI 显示「2 版」角标 |
| 9 | A/B 选片入片 + stale 三态闭环 | ✅ | 选新图 775 → recompose（#776 快照 images[0]=775）→ 选回 283（stale=true）→ recompose（#778 images[0]=283）；false→true→false |
| 10 | UI 目检（浏览器截图） | ✅ | Run 40 页 3 处镜头工作台（定妆照 5 镜 / 出图 20 镜 / 动效 0 镜）；橙色「待重新合成」徽标；版本组/选片/批量时长控件可见（`.qoder/tmp-runs40-shot2-jingtou.png`） |

## M9 验收快照（2026-09-12，实弹）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 静态 + 探针：五 section 全绿 | ✅ | 双端 typecheck 0 错；`probe:m9` 120 项全过（split / batch / contracts / api / template） |
| 2 | 兼容回归：m2a·m3·m6·m7·m8 | ✅ | 五探针全绿（存量基线零漂移） |
| 3 | 模板契约：novel-adapt v1 零 warning | ✅ | 模板列表 11 项含 novel-adapt（steps=7 / promptsDirty=false）；probe template 节全过 |
| 4 | 实弹全链（3 章短篇，Run #100） | ✅ | completed 28.4s：切分闸门 → 逐章事件 3/3 → 图谱 key_events=9 → 规划闸门（2 集）→ 剧本 2 份；LLM 7 次 ¥0.1541 |
| 5 | 闸门流：切分 / 规划 waiting_input → approve 续跑 | ✅ | 两处闸门自动放行后正常续跑；`with_script_review=false` 免审直过 |
| 6 | 产物分布（purpose 锚点） | ✅ | source=1 · brief=1 · chapters=4（manifest+3 章）· events=3 · graph=1 · plan=1 · script=2 |
| 7 | NovelBoard 聚合读 + 四段渲染 | ✅ | GET /runs/100/novel-board 契约全过；DOM `.nb` 四段（章节 3 行 / 事件 10 行 / 规划 2 卡 / 剧本 2 按钮，1122×1052 visible，零 console 错误） |
| 8 | 剧本格式对齐 `script-ep` | ✅ | `第01集-改编剧本.md`（资产 #1126）：本集梗概 + 人物表 + 场景与对白（场景头【场景 N｜地点·时间｜氛围】+ 动作 + 对白） |
| 9 | 实弹暴露缺陷修复（引擎依赖级联） | ✅ | 首跑全链 `upstream_skipped` → 根因 `depsFor` 默认依赖前一步骤 + 规则①级联 → 模板 `after: [ingest, make_split_regex]` 混合依赖修复 → 复跑全通过；spec §3.6/§3.9 回写 |
| 10 | 越界核查（红线零 diff） | ✅ | `git status`：engine / refs / context / shot-workbench / ShotBoard 零改动；`schema.ts` 纯注释；11 改 + 11 新增与 spec §4 清单一致 |

## M10 验收快照（2026-09-12，实弹）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 静态 + 探针：六节全绿（含 stale 兜底新断言） | ✅ | 双端 typecheck 0 错；`probe:m10` 全过（ops / output / upload / board / select / regression；`board` 节 3 条 stale 兜底断言：基线 false → 分镜编辑 true → 成片刷新 false 回环） |
| 2 | 兼容回归：m2a·m3·m6·m7·m8·m9 | ✅ | 六探针全绿；`probe:m7` 四条 stale 断言零回归（仅 1 处拒绝文案基线随选片放宽适配） |
| 3 | 镜头拖拽重排 + 结构性编辑（Run 61 实弹） | ✅ | 首镜移尾重排 → 分镜新版本 #1127；add→patch→remove→reorder 链 → #1128（s02 记入「M10实弹」）；产出步骤 output 按新序保位重建 |
| 4 | 上传替换 + sha256 去重 | ✅ | 回传同文件 → 资产 #1129（复制行，绑定 s03）→ 版本组并入（source=upload）→ 重新合成消费新图 |
| 5 | 大编辑器 UI 保存链路（浏览器 DOM 实测） | ✅ | s04 加标签「M10编辑器」→「20 镜 · 1 项改动」+ 保存按钮可用 → Modal 关闭 + notice → 服务端 s04 `characters=['苏小满','M10编辑器']` 落地（#1132） |
| 6 | 实弹暴露缺陷修复①：characters JSON 快照 bug | ✅ | `normalizeDraft` 对象分支读 clone 旧快照覆盖专用控件新值 → UI 保存静默丢改动；修复 = characters 直取实时值 + `cloneDraft` jsonText 跳过 RESERVED 键；复验计数与保存按钮恢复、服务端落地 |
| 7 | 实弹暴露缺陷修复②：computeStale 判定失效 | ✅ | 存量快照无 shots 引用 / 续跑链跨 run 资产引用 → shots_source 缺失/断链 → 分镜编辑后 stale 不动；修复 = 分镜资产时间兜底（不参与 compared，null 语义不变） |
| 8 | stale 完整回环（Run 61） | ✅ | UI 保存 → 服务端 `stale:true` → 浏览器三板「待重新合成」→ recompose（#1133/1134）→ `stale:false` → 三板「合成已最新」 |
| 9 | 越界核查（红线零 diff） | ✅ | `git status`：engine / refs / loader / 适配器 / ffmpeg-merge / 模板 / schema 零 diff；改动限于 shot-workbench + routes/shots + Web（ShotBoard / StoryboardEditor / api / types）+ 探针（probe-m10 新增 / probe-m7 文案适配） |

## M11 验收快照（2026-09-12，实弹）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 静态 + 探针：六节全绿 | ✅ | 双端 typecheck 0 错；`probe:m11` 全过（rerun / align / bgm / transition / template / regression） |
| 2 | 兼容回归：m2a·m3·m6·m7·m8·m9·m10 | ✅ | 七探针全绿（探针基线随 M11 同步，零漂移） |
| 3 | 单步重跑实弹（Run 98） | ✅ | 复用模式 `tasks_succeeded=20 / 预计执行 0`，重跑后 20 个子任务 attempts·completedAt 零变化（真复用不重执行）；活跃 run 重跑拒绝 400 |
| 4 | 音字对齐实弹（成片 #1139） | ✅ | 分镜 `lines` 消费台词表 → 目标 110.928s 参数 / 日志 / ffprobe 三点吻合：video 110.920 / audio 110.928 / container 110.929；对照旧成片 #1110（video 69 / audio 104.64）拖尾 35.6s 消除 |
| 5 | BGM 实弹（#1141 → #1142） | ✅ | 上传 m4a → 资产 #1141（purpose=bgm）；音量 0.8 / 淡入淡出 1s → 重合成 #1142：container 110.929 不变 + `params.bgm` 溯源；volumedetect 静音窗 -91.0 → -30.5dB、淡入区增益温和 |
| 6 | 转场实弹（#1144） | ✅ | fade × 0.5s：日志「fade × 19 处」+ `params.transition={enabled,type,dur_sec}`；container 110.960（+0.032 xfade 亚帧取整、总长语义不变）；抽帧 PSNR：交叉窗内 t=3.0s 11.2dB vs 窗外 2.9s / 4.0s 均 41.0dB |
| 7 | 回归闭环（#1146 移除 BGM + 转场 none） | ✅ | 容器 110.929 / video 110.920 / audio 110.928 与对齐基线逐值一致；静音窗回 -91.0dB；compose 参数无 BGM / 转场痕迹 |
| 8 | 存量兼容（v8 快照 run #1136） | ✅ | 与基线 #1110 输出逐值一致（快照优先，无 M11 特征注入）；probe template 节 v8 快照断言全过 |
| 9 | 浏览器 DOM 五组验证（Run 98） | ✅ | A 重跑按钮 + RerunModal 计数预览 / B 转场行 + 配乐入口 / C 镜头台词角标 / D BgmModal / E StoryboardEditor lines 控件 —— 五组全 PASS、零 console 错误 |
| 10 | 实弹暴露缺陷修复：布局 2 处 | ✅ | ① 全局 `select{width:100%}` 命中转场下拉独占整行 → `.wb-sel` 收窄（auto / max 132px）；② 任务行 nowrap 长 prompt 经 grid `1fr` auto min 撑破轨道（整页横滚 10569px）→ `.cols` 改 `minmax(0,1fr)`；复验 scrollWidth 738 / 转场行单行 / 配乐按钮可见 |
| 11 | 续跑链工作台限制（发现 · 列后续修复） | 发现 | 续跑链 run（98）工作台写侧 `no_producer` 拒绝、读侧溯源回退旧快照（804 无 lines）→ 台词角标无数据；锚点修正（input.shots → 1138）后 board 恢复。属 M10 溯源约束（step.runId===run.id）对续跑链的固有限制 |

## M12 验收快照（2026-09-12，实弹）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 静态 + 探针：六节全绿 | ✅ | 双端 typecheck 0 错；`probe:m12` 66 项断言全过（cleanup / imagecheck / gc / board / merge-guard / regression；黑·灰·正常·截断·缺失五样本判定矩阵；`yavg<=16` 边界实测） |
| 2 | 兼容回归：m7·m10·m11 | ✅ | 三探针全绿（M12 改动面 = shot-workbench / ffmpeg-merge 的既有调用方，按 spec §6.2 回归集） |
| 3 | 收藏实弹（项目 10） | ✅ | `PATCH {is_favorite:true}` → API 回读 `isFavorite=1`；素材页「仅收藏」筛选 → 仅剩 1 张（#1108）；工作台版本卡 ♥ 激活态 DOM |
| 4 | 检测实弹 | ✅ | `POST /assets/1108/check` → `quality={ok:true,reason:'ok',stats:{ymin:0,ymax:244,yavg:69.3657,satavg:16.9465}}`；黑图 #1148 上传 → 自动检测 `black`（yavg=16 边界命中 `<=` 校准） |
| 5 | 清理实弹（Run 95） | ✅ | 工作台级 `groups=19 / cleaned=1（#919）/ kept=19` → board 复查 ids=[831,920]（选中 920 不变）；项目级 `groups=106 / cleaned=2（#831·#1012，919 已软删跳过）/ kept=106`；终态逐值核对 **20/20**（run95 软删集合恰好 [831,919]，零误伤） |
| 6 | 回收实弹 | ✅ | `POST /projects/10/assets/gc` → `files=4 / freed_bytes=2,981,444`（=80418+246735+261815+2392476）；软删行保留（审计）、现存文件 0；total=338 与 DB 一致 |
| 7 | 兼容实弹 | ✅ | 存量 run board 正常（20 镜 / 22 版本 quality 全 null 不误报）；老资产无徽标；#920/#1033 保留版本文件完好 |
| 8 | DOM 四要素（无头 Chrome CDP） | ✅ | 10/10：♥ 激活态 / 「疑似黑图」徽标唯一命中 #1148 / 「仅收藏」筛选生效 / 「清理旧版本」按钮 + 确认弹窗（标题·正文·取消关闭）；板面 33 卡零误报（qwarn=0）；截图 `apps/web/tmp-m12-dom-1..5-*.png` |
| 9 | 越界核查（红线零 diff） | ✅ | `git status`：schema.ts / engine / refs / loader / 适配器 / 模板 / 提示词零 diff；package.json 仅 +`probe:m12` 脚本（dependencies 零新增）；改动面 = 14 改（610+/18−）+ 2 新服务 + 探针 + 5 截图证据 |

## M13 验收快照（2026-09-12，实弹）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 静态 + 探针：七节全绿 | ✅ | 双端 typecheck 0 错；`probe:m13` 七节 **121 项断言全过**（style-multi / vision / video-refs / upload / polish / states / regression）；vision 节 fetch stub 断言请求体含 `image_url` data URI + 解析矩阵；video-refs 节 `planVideoRefs` 四分支 |
| 2 | 兼容回归：m7·m8·m10·m11·m12 | ✅ | 五探针全绿（exit=0；M8 签名不破（`injectStyleAnchor` / `resolveProjectStyleSnippet` 薄封装）、M12 存量调用零漂移） |
| 3 | ① 视觉提取实弹 | ✅ | `POST /style-presets/extract`（资产 #933/#935）→ `{snippet:'（画风：电影感写实3D渲染,cinematic photorealistic 3D render, …）', provider:'deepseek_llm', model:'deepseek-flash'}`——deepseek-flash 多模态实测支持；预设 #2「M13 实弹·提取预设」201 落库 |
| 4 | ⑦ 单值兼容实弹 | ✅ | Run 98 s01 重跑：`params.stylePresetIds=[1]`（单值回退数组化）+ 尾缀逐字「3D 写实厚涂质感，…」不变 + 产出更新 #1059→#1150 |
| 5 | ② 多预设叠加实弹 | ✅ | 项目 10 绑定 [1,2] → s02 重跑：`params.stylePresetIds=[1,2]` + 尾缀逐字「A；B」（两词块拼接）+ 产出 #1151；项目 settings 双键共存（`style_preset_id:1` + `style_preset_ids:[1,2]`） |
| 6 | ③ 视频参考图实弹 | ✅ | Run 97 s16 重跑：`params.setRefAssetIds=[797,798]`（阁楼+木盒收集快照）+ `firstFrameAssetId=1005` 保留 + 日志真实决策「当前视频供应商不支持参考图注入（降级跳过）」（pollinations_video 能力 none → no_cap；frame_first / ok 分支探针覆盖）+ 产出 #1153→#1154 |
| 7 | ④ 上传通道实弹 | ✅ | 素材甲 #54（挂 801）→ 上传红图 201 `asset#1155 {purpose:'reference_character'}` → `refAssetIds [801,1155]` 并集 + 文件落盘 `10\images\1789220857885-m13-ref-red.png` + 资产 HTTP 可读 |
| 8 | ⑤ 批量润色实弹 | ✅ | 甲+乙批量润色 200：`polished=2 / failed=0`、两项 appearance 已变化（甲「小木偶，木质躯体，雨夜泛出微光，四肢关节处缠绕旧麻绳。」）+ usage_records +4 行（deepseek_llm/deepseek-flash ×2 项 × tokens_in/out） |
| 9 | ⑥ states 实弹 | ✅ | PUT `states:['雨夜发光版','晴天沉睡版']` → 读回 + DB 入库一致；替换语义（2→1 项再定稿 2 项）；`GET /entities` 列表视图透出 |
| 10 | DOM 六要素（无头 Chrome CDP） | ✅ | **22/22**：甲卡片 states chips「雨夜发光版/晴天沉睡版」+「2 张定妆照」+ 缩略图 / 批量润色按钮 0→1→2（勾选甲、乙）且选中态 ×2 / 预设列表含「M13 实弹·提取预设」（snippet 透出）/ 新建预设弹窗提取区（标题 + 禁用按钮 + 选项目后 98 张缩略图 + 「参考图（已选 0/4）」）/ 素材编辑弹窗（states 预填两行 + 「上传新图」+ 已选 2 张）/ 项目编辑多选回填 2 项；截图 6 张 `apps/web/tmp-m13-dom-1..6-*.png` |
| 11 | 越界核查（红线复核） | ✅ | `git status`：engine / refs / loader / workspace/templates 零 diff；schema.ts 仅 +`states` 列 + db 幂等迁移（设计 §5 白名单内）；adapters 仅能力位 ×3 + 类型；package.json 仅 +`probe:m13`（dependencies 零新增）；改动面 = 工作区合计 21 改（976+/69−）+ 10 未跟踪；其中代码 20 改（946+/69−）+ 4 新件（`entity-polish.ts` / `probe-m13.ts` / 提示词 `style-extract.md` · `entity-polish.md`），文档 README +30 行 + DOM 截图 6 张 |

## M14 验收快照（2026-09-12，实弹）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 静态 + 探针：四节全绿 | ✅ | 双端 typecheck 0 错；`probe:m14` 四节全过（params / series / static / regression）；回归 m7·m8·m10·m11·m12·m13 全绿 |
| 2 | 集级参数实弹（Run 101） | ✅ | `_params = {image.size:768x768, video.duration:10, llm.temperature:0.5}` 入参快照；20/20 gen_task `params.size=768x768`（覆盖命中）+ `stylePresetIds=[1,2]`（项目层叠加）；`video.duration` 消费点（ai-video 镜头时长优先链）经 probe context 断言 |
| 3 | 零漂移对照（Run 98 重跑·无覆盖） | ✅ | 20 任务 id 集合不变 + 既有 7 键逐值零漂移；唯一演进键 `stylePresetIds`（s01 [1]→[1,2]——M13 单值回退 → 多预设叠加的预期收敛，非漂移）；`size=832x1248` 模板默认保持；产出 20/20 更新 |
| 4 | 剧集实体实弹（项目 10） | ✅ | 建剧「M14 实弹·剧集」3 集；Run 101/102 起作联动 `latest_run_id`；派生状态 completed/failed/locked 三态；集1标题行内编辑 200 |
| 5 | 剧集 409 矩阵 | ✅ | 缩容（含已关联 run 的集）→ 409 `episode_in_use`；删剧 → 409 `series_in_use`；两次 409 后剧视图未受损 |
| 6 | 静态托管冒烟（3101 隔离实例） | ✅ | 隔离数据目录 + 真实 dist：`/` 200 text/html + 真实 assets js 200 text/javascript（96.5KB）+ 深链 `/projects/12/timeline` 回退 index + `/api` 未命中 JSON 404 优先 |
| 7 | DOM 验收（无头 Chrome CDP） | ✅ | **14/14**：剧集地图卡（3 集）/ 三集行（001 已完成 Run#101 / 002 失败 Run#102 / 003 未起作裸行）/ 起作接力直达表单（`initialTemplateKey` 命中「短剧·单集」，无选卡）/ 覆盖区 summary + 5 控件 + 集号预填 3 + 滚动可见（open h=254 inView）；截图 2 张 `apps/web/tmp-m14-dom-1..2-*.png` |
| 8 | 实弹暴露缺陷修复 | ✅ | `SeriesBoard` 头部 `.bh/.bt` 系 ProjectDetailView scoped 样式不穿透子组件 → 标题粘连 + 按钮组换行（DOM 截图目检发现 → 组件内补定义 → 复跑复验）；覆盖区滚动可见性经 W6d 实测（弹窗 body 滚动容器语义） |
| 9 | 越界核查（红线零 diff） | ✅ | `git status`：engine / refs / loader / 模板 / 提示词零 diff；schema.ts 仅 +series/episodes 两表（设计 §4 白名单内）；package.json 仅 +`probe:m14`；改动面 = 12 改 + 5 新件（probe-m14 / routes/series / services/run-params / services/series / SeriesBoard.vue） |

## M15 验收快照（2026-09-13，实弹）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 静态 + 探针：四节全绿 | ✅ | 双端 typecheck 0 错；`probe:m15` **78 项断言全过**（dag 18 / canvas-run 43 / canvas-template 14 / regression 3）；回归 probe:m2a·m4·m14 全绿 |
| 2 | 引擎等价重构（纯委托） | ✅ | `engine.ts` −45 行（`depsFor` / `whenExprs` → `pipeline/dag.ts` 同源纯函数）；probe `dag` 矩阵 18 项（显式 after 多值·去重·缺省前一步·when·when_any·gate.when 隐含·首步·坏表达式吞错）+ 引擎调度行为回归断言 |
| 3 | 运行画布实弹（DOM · Run 102） | ✅ | 21 节点 / 74 边与模板步骤数一致；状态徽标 / 断点续跑可用性正确；RunDetail「画布视图」↔ 运行详情双入口往返；平移 / 缩放 / 适应 / 点空白清除选中 / × 关抽屉保持选中；日志按 `[make_storyboard]` 过滤无串行；首轮 15 项断言 14 通过 + 1 项数据态不适用（详见 #6/#7）；截图 6 张 `tmp-canvas-S1..S6-*` |
| 4 | 画布即工作台实弹（DOM · 零真实提交） | ✅ | Run 96 failed 步 `gen_motion`：单步重跑按钮 enabled（title=「重跑该步骤（可复用成功子任务）」）→ RerunModal 打开（整体执行型步骤双单选 disabled + 说明，属预期）→ 取消无提交；Run 80 人工闸门：节点卡「闸门待审」+ 抽屉 message 文案 + 批准继续/驳回重跑/中止/直接入库四操作；全程零真实执行（零计费） |
| 5 | 模板画布实弹（DOM） | ✅ | 21 节点全 idle 无运行徽标；设计态抽屉 `script_review`（闸门 required / 依赖 write_script / 条件 `input.with_deep_review == true`）；「启动运行」→ RunFormModal（项目默认 m8-实弹验收 + `initialTemplateKey` 直达表单）；空态 8 个最近运行 + 11 个模板 chips；Templates 页「画布」入口 → `/canvas?template=mengbao-episode`；截图 7 张 `tmp-canvas2-S1..S7-*` |
| 6 | 实弹暴露缺陷修复（fit 时机） | ✅ | 首轮：挂载时数据未到按空布局 fit（100% 偏出视口，需手点「适应」）→ 修复 = `fitted` 标志 + 首次非空数据到达 `fitOnce`（watch nodes 数）；复验自动 30% 适应（transform `matrix(0.3,…,-67,153.6)`）；`resetView` 同步清数据防跨目标残留视口 |
| 7 | 实弹备注（非缺陷） | 说明 | 812px 小窗 fit 后世界层两侧溢 67px——`zoom ∈ [0.3, 2.5]` 钳制下小窗口必然（1600px 窗口完全适配），属 spec 既定行为；Run 102 无 `.failed` 节点系服务重启中断态（running 残留无返修路径，走断点续跑）→ 改 Run 96 复验真实 failed 步 |
| 8 | 越界核查（红线零 diff） | ✅ | `git status`：schema / db / refs / loader / adapters / workspace 模板提示词零 diff；canvas 路由两枚全 GET（零写端点）；`package.json` 仅 +`probe:m15`（dependencies 零新增）；改动面 = 10 改（178+/41−）+ 7 新件（`dag.ts` / `services/canvas.ts` / `routes/canvas.ts` / `probe-m15.ts` + `CanvasView` / `CanvasBoard` / `CanvasDrawer`） |

## M16 验收快照（2026-09-13，实弹）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 静态 + 探针：六节全绿 | ✅ | 双端 typecheck 0 错；`probe:m16` **126 项断言全过**（canvas-doc 56 / node-build 34 / edit-cap 11 / draft 13 / linkage 10 / regression 2）；回归 `probe:m15`（内含 m2a / m4 / m14）全绿；存量库启动幂等升级无报错（实弹全程运行于既有 data 目录） |
| 2 | 画布实弹（浏览器 DOM） | ✅ | 建画布 / 切换（画布 1 / 2 / 4）；素材拖入摆放；双击空白建生成节点；连线（素材 → 编辑节点源图入边「入 1」）；节点拖拽落库；Inspector 全表单（spec 保存 / readiness「已就绪，可执行」/ 任务历史 / 结果预览）；蒙版涂抹 → 上传 purpose `mask` 回填（蒙版资产 #1320）；pan / zoom / fit 视口防抖落库——刷新后 transform 逐值保持（`translate(52.9119px, 6.92147px) scale(0.996406)` ≡ DB viewport） |
| 3 | 真实出图（零计费） | ✅ | 节点「图片 #7」pollinations flux.1-schnell：任务 #450 succeeded 16.2s → 徽标「成功」+ 缩略图（结果资产 #1323）；socket 修复后复跑 #451 17.5s |
| 4 | 联动三枚 | ✅ | ① run 101 抽屉「送入创作画布」→ 新建画布「M15联动验证」：节点 5/6 网格落库（60,60 / 340,60）② 画布图 →「设为实体参考图」→「灯婆婆」refs=[1297] 验证 → PUT `{ref_asset_ids:[]}` 回滚 refs=[] 无损 ③「送去运行」prefill 两分支：全画布过滤 image/text（「选 1 项」=#1297）/ 选中视频节点优先（=#1296） |
| 5 | 编辑通道（声明制退化验证） | ✅ | 无 key 环境：inspector 警告「当前图像端点未声明『局部重绘』能力，执行将失败」→ 执行 → 任务 #452 尝试 2 后 failed、错误原样透传「供应商『pollinations_image』未实现图像编辑能力」（零网络零计费）；蒙版 #1320 + 源图入边就位；截图 `tmp-m16-edit-cap-hint.png` / `tmp-m16-edit-fail.png` |
| 6 | 模板草案（低保真导出） | ✅ | 弹窗渲染 YAML（`canvas-draft-4`）+ 校验自检「步骤 n7 缺 inputs」如实展示（草案待人工完善属设计定位）+「复制 YAML」→ 剪贴板回读全文 + toast；截图 `tmp-m16-draft-modal.png` |
| 7 | socket 实时对账 + 缺陷修复复验 | ✅ | 消除实弹暴露的 4 处缺陷（TDZ ×2 / uploadFiles 契约 assets→items / **漏 join canvas 房间**：URL 同步 watch 于 setup 期先设 canvasId，房间 watch 后注册且无 immediate → 首次进入 / 刷新错失 null→id 变化；加 `{immediate:true}`）——修复后二次执行 #451：徽标 pending→succeeded 全自动流转（零手动刷新） |
| 8 | 越界核查（红线复核） | ✅ | `git status`：refs / loader / workspace 模板提示词 / 既有适配器 `generate` 路径零 diff（aliyun-wan 仅 +编辑声明与 `edit()`）；schema.ts 仅 +3 表 +1 列（设计 §2.1 白名单）+ db 幂等兜底 + projects.ts +14（删项目级联清画布）；M15 `CanvasBoard.vue` 零 diff（`CanvasDrawer` 仅 +1 联动按钮；engine.ts 差异系 M15 纯委托留痕）；`package.json` 仅 +`probe:m16`（dependencies 零新增） |

## M17 验收快照（2026-09-13，实弹）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 静态 + 探针：八节全绿 | ✅ | 双端 typecheck 0 错；`probe:m17` **274 项断言全过**（node-kinds 37 / port-v2 40 / input-v2 37 / batch-ops 77 / variant-adopt 26 / run-node 10 / export 24 / llm-assist 23）；回归 `probe:m16`（内含 `probe:m15` → m2a / m4 / m14 零漂移）全绿；存量库启动幂等升级无报错 |
| 2 | 创作循环实弹（画布 5「M17实弹」） | ✅ | 实体节点（素材甲）→ gen 节点 reference 连线（边落库）；变体执行 ×2（任务 #453/#454 同批成功 → 产物 #1325/#1324）；结果画廊「采纳 ✓ / 最新」切换与大图预览；采纳落库（节点 #19 `adoptedTaskId=457`，displayTask 派生）；下游执行引用上游产物（任务 #455-#457 输入快照 `referenceAssetIds=[1325]`） |
| 3 | 批量操控 + 快捷键 | ✅ | 批量执行 started / skipped（未就绪附 problems）；框选 + 多拖（`nodes/batch` 一次提交一条入栈）；快捷键全集；Delete + Ctrl+Z 快照重建恢复（三轮循环实证）；删边 / 删节点均入撤销栈 |
| 4 | 整理 / 对齐 / 编号 | ✅ | 「整理布局」layered 拓扑分层落库；对齐 / 分布；批量编号（`seq` 落库，卡片 `#N` 徽标） |
| 5 | 导出 zip | ✅ | 资产 #1328（263,757B）→ `workspace/projects/10/exports/M17实弹-export-*.zip`；条目 `<seq>-<title>-<assetId>` + `manifest.json`（节点清单 / 采纳优先后打包）；下载复用资产通道 |
| 6 | 送去运行（run 节点） | ✅ | 「送去运行」不跳转 → 视口中心建 run 节点 #24（运行 #103）+ 非终态 5s 轮询 + 「打开运行详情」直达（`/runs/:id`） |
| 7 | 音频真实 TTS | ✅ | 节点 #25 → 任务 #458 succeeded 586ms → 资产 #1331（ID3 魔数，`siliconflow_audio` / CosyVoice2-0.5B / `voiceSource=settings` / `chars=20`）；UI 任务历史 + 「显示产物」+ 画廊「采纳」+ 卡片 ok 徽标；重跑 #460 → #1333 落 `workspace/projects/10/audio/`（57,343B） |
| 8 | compose 真实 ffmpeg | ✅ | 节点 #29（640x360；2 视频 + 1 音频入边）→ 任务 #459 succeeded 502ms → 资产 #1332（178,495B / 10.333s / `ftyp isom` 魔数）；ffprobe 独立复核 h264 640x360 10.333s + aac 1.848s；`params` 快照 videos[1154,1153] audios[1273]；建边负例 400「视频输入端口仅合成节点支持」（表单未落库时 from / to 校验现场） |
| 9 | 全局总览定位 | ✅ | 抽屉 10 行按严重度排序（失败 › 未就绪 › 运行中 › 就绪 › 完成）；点击行选中 + 视口居中（transform 位移 + 行 active + 卡片 sel + inViewport 实证）；收起正常 |
| 10 | 实弹暴露缺陷修复 3 处 | ✅ | ①快照重建任务孤儿 → `restoreFromNodeId` 认领（探针 restore-claim 断言群）②redo/undo 循环认领源过期 → `snap.curId` 循环修复（三轮实证）③产物子目录映射缺失 → `purposeSubDir` +2（`creation_audio` → audio/、`creation_compose` → video/；重跑 #460 复验入 audio/） |
| 11 | 越界核查（红线零 diff） | ✅ | `git status`：engine / refs / loader / 适配器 / 模板 / 提示词零 diff；`schema.ts` 仅 +2 列（设计 §2.1 白名单）；M15 三组件零 diff；`package.json` 仅 +`probe:m17`（dependencies 零新增）；改动面 = 14 改 + 4 新件（`creation-ops.ts` / `creation-export.ts` / `probe-m17.ts` / `canvas-history.ts`） |

## M50 验收快照（剪辑工程交换导出 · 静态 + 探针门禁）

> 里程碑主体见 [milestones.md](./milestones.md) 「M50 能力速览」；本表仅列验收矩阵。门禁口径：双端 typecheck + 全量 `run-probes` 零红灯（含 m26 红线）+ web build 绿；真机接力目检为手动项（下方 #9）。

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 双端静态 typecheck | ✅ | `pnpm -r typecheck`：server `tsc --noEmit` + web `vue-tsc --noEmit` 全 EXIT=0 |
| 2 | 探针 `probe-m50` | ✅ | **6 节 64 断言全绿**（timecode / formatters / snapshot / sources / bundle / redline）；isolatedEnv 隔离临时库 + `globalThis.fetch` 阻断零网络零计费 |
| 3 | 全量回归零红灯 | ✅ | `run-probes` 全量 **4244 断言 / 46 探针全绿**（含 m26 红线探针）；合成链路 m7/m11/m18/m19/m42/m44 全绿 = 「timeline 落库不改任何 ffmpeg 参数与音频结果」背书（B② 同源红线） |
| 4 | web build | ✅ | `pnpm build` EXIT=0；`run-detail` / `easy-create` 分包含新入口 |
| 5 | 三格式结构正确性 | ✅ | OTIO 可 `JSON.parse` 且五轨命名固定 + clipCount；FCPXML 含 format/sequence/title/transitionlist；EDL record 时码升序 + Dissolve 行（formatters 断言） |
| 6 | 时间轴双路解析 | ✅ | `params.timeline` stored 直通 / 无快照同源 recomputed 兜底 / 双失败 400 `no_timeline` / 无成片 `no_final_video`（sources 断言，夹具 mkStep 链 asset_ids） |
| 7 | zip 交付与下载一致性 | ✅ | `buildEditExchange` → unzipSync 校 manifest.media[].mediaFile 均在包 + README + `bad_format` 负例 + `probeEditExchange` 能力探测（bundle 断言）；下载复用 `GET /assets/:id/file?download=1` |
| 8 | 行数红线 | ✅ | 新文件均 <400（最大 `timeline-source.ts` 189）；`ffmpeg-merge/index.ts` 维持 785 ≤800（redline 断言 + m26 split-audit 背书） |
| 9 | 真实成片剪映 / DaVinci 打开目检（**手动项，本次未执行**） | ⏳ 待实机 | 需真实成片 + 剪映专业版 / DaVinci Resolve 实机打开确认多轨结构（V1/对白/BGM/SFX/字幕）。本轮为离线探针 + 构建门禁，未跑真机目检——按 plan「手动项失败不阻塞门禁但如实登记」登记为待人工实测；剪映对 FCPXML 支持随版本漂移，实测后回填版本号（不达标以 EDL / OTIO 双路保底） |
