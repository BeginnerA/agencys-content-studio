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

## production-baseline 第一期：B1 技术结果与证据建档（2026-09-24）

B1 建档已完成，技术门禁未通过，第一期整体未验收；不启动第二期。用户“继续”仅放行本期零模型费用工作。下面是本轮新采集，不替代上方 M50 历史记录。

- 代码快照：`d9710d85a921327ae2ccaab658b8a3aa72a1024c`；技术命令执行区间开始/结束工作树均干净。
- 本地档案：[manifest](../data/production-baseline/20260924-154007/manifest.json)、[observations](../data/production-baseline/20260924-154007/observations.jsonl)、[校验结果](../data/production-baseline/20260924-154007/evidence/verification.json)。`data/` 已忽略，不包含在 Git 提交中。
- 6 个固定槽、94 条记录、50 份索引证据的 SHA-256/引用/结构回读校验通过。命令、退出码、起止时间、耗时和原始输出见 [technical-results](../data/production-baseline/20260924-154007/evidence/technical-results.json)。这只证明档案完整性，不证明作品质量。

| 判据 | 本轮结果 | 证据与边界 |
|---|---|---|
| 双端类型检查 | passed | `pnpm -r typecheck`，EXIT=0；server 与 web 均通过 |
| 模板校验 | passed | 19 份 / 123 步，0 错误、0 警告，EXIT=0 |
| 全量隔离探针 | failed | 47 探针，46 通过、1 失败；4269 断言中 4268 通过、1 失败，EXIT=1；m50 的 64 断言通过 |
| M44 recovery | failed，原因待诊断 | `probes/m44/recovery.ts:52` 期望 `asr_configuration_changed` 的断言失败；日志未输出实际错误码，不能据此断言发生隐式换实例或付费。未修改断言或业务代码 |
| web build | not_tested（应用结果待复测） | 首轮 EXIT=1：Vite 检查 `.env` 存在后读取被本次凭据保护层阻断，属于采集环境问题；原失败输出保留。复测启动器在版本预检阶段停止，未执行第二次构建 |
| 工具版本 | passed | Node v22.23.2；pnpm 12.3.4；FFmpeg/ffprobe 9.0.1；仅版本检查，不是实片检测 |
| 当前样片盘点 | missing：0/6 槽可绑定 | 固定回环 GET 覆盖 2 活跃项目、0 归档、2 运行、1 会话、13 未删除资产（6 图/7 文本）；分页数量吻合，无 video/final_video；未检查 draft、已删除资产和磁盘孤立文件 |
| 修改/质量/成本基线 | not_tested | 36 个固定修改任务尚无真实样片及冻结目标；人工耗时、真实成本、字幕偏差、镜头可用率均为 null，不是 0 或 100% |
| 编辑器工程实测 | not_tested | 6 槽 × 3 格式 × 2 编辑器均未尝试；未启动剪映/Resolve，未安装软件，未将视频导入冒充工程导入 |

采集安全边界：进程环境仅继承操作系统/工具路径白名单，屏蔽生产 `.env`/密钥读取，默认 fetch/http(s) 请求受阻；14 项保护自检通过。原探针只使用独立临时库与自身模拟响应，临时数据位于本 capture 的 `runtime/`。这是采集进程保护，不是操作系统网络沙箱。样片盘点单独使用固定回环白名单 GET；未启动生产服务或发送生产写请求。

复测前出现非本轮修改：`apps/web/src/components/pipeline-canvas/drawer/index.vue`、`apps/web/src/components/pipeline-canvas/drawer/use-canvas-drawer.ts`、`apps/web/src/views/canvas/index.vue`。未触碰；本批技术结论不覆盖这些后续修改。详情见 [阻塞记录](../data/production-baseline/20260924-154007/evidence/followup-blockers.json)。交付前再核实，仓库已由其他工作推进至 `2acbf4e3e9eb5bf3b05c8fce805807dcb824dc4d`，仅本轮验收文档尚未提交；不得把 `d9710d8` 的这批测试结果当作新提交已验证。

失败旁例保留 run 131；run 132 在本轮列表未返回，仅保留规格中历史 failed 记录，不推断消失原因、不恢复任务。资产列表不返回 runId，因此本地盘点中的资产 runId=null 仅表示接口未提供关联。

后续放行条件：先明确稳定代码快照并复测构建，单独诊断 M44 失败；B2 需用户确认真实样片来源，新增生成另行授权预算；B3/B4 的隔离副本写入与编辑器操作另行确认。原路线、原 M50 计划和生产代码均未由本轮修改，无付费生成、无提交。

## production-baseline：授权修复及技术复测（2026-09-24）

用户在诊断后以“按照建议继续”批准限定修复。上节 B1 历史失败原样保留；本节不代表第一期或整个专业化路线验收。

- 修复 M44 恢复层断言为 `configuration_changed/409`，保留严格 ASR 底层专用错误；拒绝时数据库、批准快照及消息不变，引擎不启动、供应商请求为零。
- 运行详情与会话详情共用常规端点/独立 ASR 漂移读模型；覆盖仅改价、停用及协议失配。运行详情、画布顶栏共用确认器；轻松创作显示同一清单，默认不接受，切换会话/run/方案/漂移时清除旧确认，无可用配置则阻止恢复。任务级核验规则未改。
- 新证据：[repair-summary](../data/production-baseline/20260924-164741/evidence/repair-summary.json)，包含 55 份采集文件与 65 份构建产物哈希；旧 B1 manifest/observations 哈希复核未变。`data/` 仍为本地忽略目录。

| 检查 | 记录中的验证结果 |
|---|---|
| 全量隔离探针 | 47/47 通过，4347 断言；M44 共 301 断言，包含 35 项服务端恢复与 38 项前端确认行为 |
| 双端类型检查 | server `tsc --noEmit` 与 web `vue-tsc --noEmit` 均通过 |
| 模板校验 | 19 份 / 123 步，0 错误、0 警告 |
| web 生产构建 | 通过，输出至本批隔离 runtime；未部署 |
| 保护自检 | v2 的 20 项自检通过，包括 Vite 环境加载兼容性 |

版本绑定与并行边界：全量复测源码内容 SHA-256 为 `b94d9266b8227d63ceeee343b824c4e38b8ee22542399c1fa5adaba29afe4603`。首轮回归期间镜头看板/M7 被其他工作修改，因此保留首轮记录并补跑。补跑期间其他工作将 HEAD 从 `2acbf4e` 推进至 `ca293af`，但全部受检文件内容哈希前后相同；原采集器的 `sourceStable=false` 保留，汇总明确区分 `sourceContentStable=true`。本会话没有执行提交或推送。

复测结束后，其他工作继续修改运行来源字段、前端基础类型及项目详情；差异逐项记录在 `changesSinceCheck`，`currentWorkspaceFullyVerified=false`。上述通过结论仅覆盖各检查记录中的源码快照，不追认后来变更。模板首测因采集器漏建临时 data 目录而失败，修正采集器后复测通过，原输出保留；没有修改业务逻辑来绕过检查。

本次仅使用已安装 CLI、独立临时库及模拟响应；未安装依赖、启动生产服务或生成付费样片。前端测试执行真实状态机、SFC setup 和页面恢复回调，API/导航/挂载副作用打桩；不冒充浏览器视觉或真实供应商验收。六样片槽仍沿用 B1 的 missing 0/6（本轮未重新盘点），36 项修改任务、质量/真实成本及编辑器工程实测仍未执行。下一步需确认样片来源；新增生成另行授权预算，原总路线与 M50 计划未改，不自动开始后续阶段。

## production-baseline：B2 存量成片盘点与本地实测（2026-09-25）

用户选择“复用平台已有成片”，本轮只读采集已完成；六槽覆盖仍为 0/6，B2 完整验收受阻，第一期未验收。新档案：[manifest](../data/production-baseline/20260925-125135/manifest.json)、[observations](../data/production-baseline/20260925-125135/observations.jsonl)、[完整性验证](../data/production-baseline/20260925-125135/evidence/verification.json)。旧 B1 及修复记录不覆写。

- 固定回环白名单 GET 覆盖 2 个活跃项目、0 个归档项目、4 次运行、1 个会话、47 个未删除资产：13 图、11 视频、14 音频、1 归档、8 文本。列表未达上限，项目资产计数一致；不覆盖 draft、已删除资产及磁盘孤立文件，也不是数据库事务快照。
- 项目 55 的成片资产 `1573/1581/1585/1594` 经 `stepId=979` 与运行步骤关联，均来自 run `134`；会话 `16` 和当前步骤输出均指向 `1594`。这是同一运行的四个版本，不能算四个独立样片；run `131/133` 的失败旁例及历史 run `132` 的列表缺失状态另行保留，本轮未恢复任何任务。
- 四片各保存独立检查副本及 SHA-256。`ffprobe` 实测均为 **45 秒、720×1280、H.264 视频与 AAC 音频**，报告帧率为 `25/1`；FFmpeg 全片音视频解码均 EXIT=0。仅证明文件可读和解码通过，不证明恒定帧率、对白准确度、声音清晰度或作品质量。
- 批准 recipe 的元数据为故事/动态/对白，目标 45 秒、7 镜、7 句、3 个角色，`estimatedDialogue=true`、无 ASR pin；不得称作严格 ASR 核验通过。保存的时间轴为 v1、7 段、字幕资产 `1572`；时间轴 lines 为空不能推断影片没有台词。
- 四版本均不在六槽要求的 25–35 秒或 50–70 秒范围，保留为备用；首选备用资产 `1594`，不绑定正式槽、不裁片凑数、不放宽原验收标准。科普和产品槽未找到合格候选。
- 48 条观察、20 份索引文件及 4 份媒体副本的结构、引用、哈希回读通过；旧 B1 manifest/observations 的原哈希一致。首轮 inventory 的目标时长字段误取 `plan.durationSec` 导致 null，后续按契约 `plan.duration` 核实为 45 秒，更正单列于 media/observations，保留原记录。
- 采集时 HEAD 为 `71eacd4e3f9055539a8125743f39420d851a0b9f`，采集前及归档时工作树干净；不据此推断服务加载版本，也不把上轮 47/4347 技术结论追认到该提交。本轮只新增本地证据并追加本文，未改业务源码、总路线或 M50 计划，未提交。

36 项固定修改任务、人工审片、真实成本/人工耗时及编辑器导入仍未执行，缺测指标保留 null。本轮无生产写请求、付费调用、服务启动、原片修改或软件安装。下一步需补充符合六槽要求的真实样片；45 秒备用片可另行确认用于补充质量观察，但不能替代正式覆盖。隔离副本修改/导出及编辑器操作仍需授权。

## production-baseline：备用片 1594 补充质量观察（2026-09-25）

用户“继续”确认观察备用片。本轮完成固定副本的逐秒静帧检查与 FFmpeg 信号测量，**不等于完整听看片或质量验收**。记录：[manifest](../data/production-baseline/20260925-125926/manifest.json)、[14 条观察](../data/production-baseline/20260925-125926/observations.jsonl)、[完整性验证](../data/production-baseline/20260925-125926/evidence/verification.json)。

| 检查 | 实际结果与边界 |
|---|---|
| 固定来源 | project 55 / run 134 / asset 1594；45 秒副本 SHA-256 `c99f27cc9a5fe17a56febbbc5964d7b523c9c39ca967db334fd98b488dd9345e` 与 B2 相同，不因后续平台版本变化换片。 |
| 帧时间与信号 | 1125 帧，解码呈现时间戳 0–44.96 秒、相邻间隔均 40ms。指定阈值下未检出黑屏（≥0.1 秒、暗像素比例≥98%）或冻结（≥1 秒、噪声阈值 −60dB）；不能据此排除短暂瑕疵。 |
| 音频风险，P1 | 全片 −8.9 LUFS、LRA 14.1 LU、真峰值 **+0.3 dBTP**；最大峰值位于 S7（39–45 秒），存在播放/转码过载风险，但未听审，不断言已产生可闻失真。7 镜混合音轨响度为 −11.1 至 −7.2 LUFS，不是对白分离测量。先确认听感及交付目标，再考虑授权副本上的增益/峰值限制，不先重生成镜头。 |
| 道具连续性候选，P1 | [19.96 秒](../data/production-baseline/20260925-125926/evidence/before-cut.png)女主双手抱纸袋，[20.04 秒](../data/production-baseline/20260925-125926/evidence/after-cut.png)切到双手抬起、纸袋不见。定位 S3→S4（源资产 1560→1561）；需完整看片确认是否可接受省略，再冻结局部返修范围。 |
| 光色连续性候选，P2 | 39 秒后的室内段比开头及 33–38 秒室内段更亮、更偏冷；镜位可解释部分差异，需结合时空/调色意图确认，未判为换场错误。 |
| 字幕表现 | 45 个逐秒样本未见对白硬字幕；成片标签无 `with_subtitle`，当前 `_compose.subtitleBurn=false`，与表现一致，不误报为漏烧。`params.subtitle=1` / timeline 的字幕引用仅表示有字幕源。当前 SRT 1572 的 7 条时间范围合法且无重叠，但为估算字幕；不能证明发言对齐，也不能由当前可变设置反推合成时意图。 |

共查看 3 张逐秒接触表并重点检查全尺寸帧，保存 48 张静帧及 3 张接触表；18 个媒体命令成功，78 份索引文件哈希及引用回读通过。旧 B1、B2 索引文件和固定媒体副本保持原哈希。采集所见 HEAD `509f1381ca3e90855febc373697a671b5567ff51`，不据此推断运行服务加载版本或追认技术门禁。

完整对白听审、漏字/说话人核验、口型、动态瑕疵及字幕偏差仍 `not_tested`；镜头可用率、真实成本、人工耗时和编辑器成功率仍 null。正式六槽沿用 B2 的 **0/6**（本轮未重新全量盘点），36 项固定修改任务未执行，第一期与总路线未完成。未改业务源码、原片、生产数据或已批准计划，未生成、调用模型、重合成、导出、操作编辑器、安装软件或提交。上述建议是复核清单，不自动授权修复或启动后续模块。

## production-baseline：备用片用户复核与处理边界（2026-09-25）

用户针对固定样片 `1594`（原 SHA-256 不变）明确答复：**对白听审未发现明显问题、纸袋需要保持连续、室内光色需要统一**。新增[用户答复](../data/production-baseline/20260925-131252/evidence/user-review.json)、[观察增量](../data/production-baseline/20260925-131252/observations.jsonl)、[局部处理边界](../data/production-baseline/20260925-131252/evidence/rework-scope.json)及[完整性验证](../data/production-baseline/20260925-131252/evidence/verification.json)，引用并更新前轮对应观察的当前状态，历史原文不覆写。

- 声音：仅用户主观听审通过，暂不返修音轨；不是逐字 ASR、口型或字幕时间验收。先前 +0.3 dBTP 的客观峰值与交付余量风险继续保留，不以主观正常抹去。
- 纸袋：从疑点转为确认的作品问题。主要定位 S4（20–27 秒，资产 1561），S3 作入镜衔接参考、S5 检查后续连续性；检查邻镜不等于授权重做邻镜。先核查可复用素材，若没有可用版本，再另行确定局部重做方式、动作和预算，不能靠调色修复缺失道具。
- 光色：从疑点转为确认的作品问题。拟只处理 S7（39–45 秒，资产 1564），参照 S6 与开头室内段，优先局部亮度/白平衡调整；滤镜参数须经对照确认，不预写成已验证方案。
- 共同保护：保留原对白/音轨、45 秒总长、25fps、镜序与切点、无硬字幕状态及未确认修改的其他镜头。两项属于备用片补充问题，不代替正式六槽的 36 项固定修改任务，也不启动第二期。

4 条新观察与 4 份索引文件校验通过；固定片与上一批索引证据未改变。两项视觉问题**已确认但未修复**，局部处理执行仍需隔离副本授权；本轮未调用模型、改片或回写生产项目。下一步建议：授权后先做 S7 的零模型费用隔离调色对照，同时只读核查道具替代素材。正式覆盖仍沿用 0/6（未重新盘点），第一期未验收。

## production-baseline：S7 隔离调色预览与纸袋素材核查（2026-09-25）

用户批准上述建议后，本轮仅制作独立预览并只读检查存量素材，未替换生产成片。固定输入仍为 `1594` 原 SHA-256。新增[清单](../data/production-baseline/20260925-131802/manifest.json)、[6 条观察](../data/production-baseline/20260925-131802/observations.jsonl)与[完整性验证](../data/production-baseline/20260925-131802/evidence/verification.json)。

- 调色对照：[6 秒静音视频](../data/production-baseline/20260925-131802/evidence/S7-original-A-B-muted.mp4)，从左到右为原图、A 轻度、B 较明显；另有 [39 秒静帧](../data/production-baseline/20260925-131802/evidence/color-39.png)。查看 39/42/44.96 秒对照及 S1/S6 参考后，建议先审 A；B 肤色更黄、更暗。此为静帧建议，**尚未获得用户视觉验收**，不声称光色已统一通过。
- [A 完整候选](../data/production-baseline/20260925-131802/evidence/preview-A-lossless.mp4)为 45 秒、720×1280、25fps，仅第 975–1124 帧（39–45 秒）使用轻度亮度/色偏 LUT。采用 H.264 无损编码，约 228MB、High 4:4:4 Predictive；不是最终交付编码，播放器兼容性未人工验证，优先查看上面的普通 H.264 三栏对照。
- [独立解码验证](../data/production-baseline/20260925-131802/evidence/preview-verification.json)：前 975 帧像素完全一致，仅 S7 的 150 帧改变；输出逐帧等于指定 LUT 结果，全片 1125 个呈现时间戳一致。1939 个音频包的载荷哈希、时间戳及 priming 信息一致，音轨未重编码；原 +0.3 dBTP 风险保留。
- [纸袋存量核查](../data/production-baseline/20260925-131802/evidence/prop-versions.json)：项目 55 的 43 个当前未删除资产中有 7 个单镜视频、4 个成片。S3/S4/S5 各仅一个版本，四个成片均复用 1560/1561/1563；源视频时长为 6/7/6 秒，没有额外画面长度可直接换段。约 35–37ms 的容器余量不是额外画面。已查看三个源镜接触表，**纸袋问题仍未修复**；结论不覆盖回收站、其他项目或外部素材。
- 后续门禁：先由用户确认 A 调色；纸袋需提供合适素材，或另行明确 S4 动作、制作方式与预算后授权。不自动重做 S5、不剪掉对白、不回写选片或触发生产重合成。

47 项新索引、22 个成功媒体命令、8 次白名单 GET 验证完成；161 项旧索引/关键证据及固定原片哈希不变。首次预检因旧 B1 使用 `evidence.path` 而非 `id` 作为文件路径退出，修正采集器后通过，失败发生在 GET/媒体处理之前。未修改业务源码、原片、数据库、总计划，未调用模型、安装软件、操作编辑器或提交。正式六槽仍沿用 **0/6**，36 项固定任务未执行，第一期仍未验收，总路线保持 Executing。

## production-baseline：A 版调色获用户认可（2026-09-25）

用户对“A 的调色效果是否可接受”答复“可以接受”，已[绑定至固定 A 版](../data/production-baseline/20260925-133437/evidence/user-approval.json)（预览 SHA-256 `8a7d645918b15a87576da934ec1f5b677c3a9f5b6ab6a851677ce83335c3eb88`）。[观察增量](../data/production-baseline/20260925-133437/observations.jsonl)将上轮 A 版“待用户确认”更新为“用户认可”，不覆写历史记录；通过范围仅 S7 调色的主观效果，不推断完整播放时长或全片质量验收。

[归档验证](../data/production-baseline/20260925-133437/evidence/verification.json)通过：原片、A 版及上轮 47 项索引文件哈希不变。本轮未重新渲染、调用 API/模型或替换生产成片。纸袋问题仍未修复，S4 制作方式、动作及预算仍需另定；音频峰值风险保留。六槽仍 0/6、36 项固定任务未执行，第一期未验收，总路线保持 Executing。

## production-baseline：S4 修正能力与费用预检（2026-09-25）

用户继续后，仅核实执行条件，未生成或上传媒体。新增[预检输入](../data/production-baseline/20260925-134026/evidence/preflight-input.json)、[方案与费用边界](../data/production-baseline/20260925-134026/evidence/decision.json)、[公开文档和源码指纹](../data/production-baseline/20260925-134026/evidence/sources.json)、[完整性验证](../data/production-baseline/20260925-134026/evidence/verification.json)。

- 原 S4 为 `wan3.0-video`、7 秒、720p、i2v 原生对白；既有 recipe 秒价为 0.9 元，当前详情未报配置漂移。未验证供应商账户可用性、地域或余额。
- 原图像与动态提示词均要求“双手推辞/摆动”，没有持续持袋约束。动态返修只支持改 motion，不同时修首帧；对白执行清空参考视频/音频。此前“只重做 S4 并保留原音轨”仅是目标，不是现有入口已能保证的结果；普通重生成会重新出声，贴回旧音轨仍须验口型。
- 官方文档明确支持 `reference_video` 加编辑意图，现有百炼适配器可以构造该请求。建议独立副本试做参考视频编辑：只传 S4 的 7 秒片段及纸袋参考帧，保持 720P、7 秒，不混入首帧模式，不修改生产批准链；这条路径尚未在本片实测。
- 官方计费按**输入视频秒数＋输出视频秒数**：7＋7＝14 秒。北京标准价 0.6 元/秒，视频预计 **8.40 元**；新加坡标准价 0.74942 元/秒，约 **10.49 元**。历史 0.9 元/秒换算为 12.60 元，仅作比较，不自动改实例价格，不假设折扣或免费额度；普通重生成的 6.30 元不是该编辑完整报价。
- 建议单次总上限 **15 元**、最多提交一次、不自动重试。预算和片段上传尚未授权；实际地域/价格及传输费用、安全传输路径须提交前落实，不能保证在上限内完成就停止。参考视频需要 HTTP(S)/OSS，不能直接传本地盘符，不开放本地服务或隧道。
- 候选后续以已认可 A 版为装配基底，仅改 20–27 秒画面、保留全片原音轨；验证 30fps→25fps 时间轴、口型及 S3/S5 衔接。若需修改 S5，另报范围与费用，不自动扩镜。

5 次本地白名单 GET、5 条观察、9 项新索引校验通过；54 项历史文件、原片与 A 版哈希未变。公开网页读取不涉及模型调用。本轮未改业务源码/总计划、未付费、未回写生产；纸袋仍未修复，六槽沿用 0/6、36 项固定任务未执行，第一期仍未验收。

## production-baseline：S4 单次授权试验被供应商拒绝（2026-09-25）

用户随后明确授权单次试修，总费用上限 15 元，允许必要凭证及仅 S4 的 7 秒片段、一张 S3 纸袋参考帧传至现有百炼供应商。授权新增至[独立批次](../data/production-baseline/20260925-135900/manifest.json)，不覆写上一批“尚未授权”的历史记录。

- 凭证、只读配置与运行实例匹配；北京端点与私有临时存储门禁通过。上传策略禁止覆盖，文件与账号、模型绑定，48 小时自动清理。未开放本地服务或隧道，秘密和临时上传凭证不入档。
- 输入实测为 7 秒、720×1280、30fps；请求固定 `wan3.0-video`、720P、7 秒，关闭提示词扩写及输出声音。按 14 秒、0.6 元/秒估算 8.40 元，临时存储免费；未设置供应商侧硬预算，不把估算视为账单。
- 两份最小素材上传成功；**仅一次生成 POST 返回 HTTP 403，未返回任务 ID**。请求 ID 为 `6af5f25b-c466-9ac2-bff2-f96a20edc5d0`，见[提交回执](../data/production-baseline/20260925-135900/evidence/submission-receipt.json)。已持久化独占提交锁，没有自动重试、换模型或换端点重提。
- 原始错误响应未留存，安全字段收集未保留可用错误码；不能认定是余额、特定权限或地域错误。官方规则称失败不计费，但本次未查询账单，实际费用仍为未知。限制和后续门禁见[结果记录](../data/production-baseline/20260925-135900/evidence/outcome.json)。
- 没有视频候选，音轨、口型、S3→S4→S5 衔接均未验收，纸袋问题仍未修复。重新生成须另获单次授权；当前只能先按请求 ID 核查拒绝原因。

[归档验证](../data/production-baseline/20260925-135900/evidence/verification.json)通过：26 项索引、5 条观察、前批 9 项索引、56 项受保护文件和 8 项源码指纹一致；原片与已认可 A 版未变。未回写生产、扩修 S5、改业务代码/总计划、安装软件或提交代码。六槽仍为 0/6、36 项固定任务未执行，总路线仍为 Executing。

## production-baseline：换用 prime 后 S4 单次试修生成成功（2026-09-25）

用户表示“我更换了模型 现在可以重试了”，形成新的单次授权；沿用 15 元上限、必要素材传输、不自动重试及不回写生产边界。新增[独立批次](../data/production-baseline/20260925-140900/manifest.json)，未覆盖前次 403 证据。

- 当前默认视频实例为 31、`wan3.0-video-prime`，北京地域、原百炼凭证。官方契约支持参考视频编辑，720P 输入和输出单价均为 0.9 元/秒；新模型重新私有上传同样的 S4 7 秒片段及一张 S3 纸袋参考帧，48 小时自动清理。
- 仅提交一次，HTTP 200，任务 `82784112-b09e-421f-92db-fcf812cdfb34` 最终 `SUCCEEDED`。[用量回执](../data/production-baseline/20260925-140900/evidence/generation-result.json)为输入 7 秒＋输出 7 秒，按公开价计算 **12.60 元**；实际账单未核验，不宣称设置供应商硬预算。
- [完整隔离候选](../data/production-baseline/20260925-140900/evidence/preview-S4-lossless.mp4)以已认可 A 版为基底。[独立验证](../data/production-baseline/20260925-140900/evidence/candidate-verification.json)通过：45 秒、1125 帧、25fps，仅 20–27 秒的 175 帧改变，其他 950 帧解码像素和所有画面时间戳一致；1939 个原音频包、时间戳及流参数一致，无重编码，原音频峰值风险保留。
- [S4 左原右新对照](../data/production-baseline/20260925-140900/evidence/S4-before-after.mp4)与[邻镜看片片段](../data/production-baseline/20260925-140900/evidence/S3-S4-S5-review.mp4)已生成。S4 的 8 张抽样画面均见纸袋，但手部自然度、口型及重绘后的亮度仍待用户看片；音轨未变不等于口型验收通过。S5 抽样仍未见纸袋，整段道具连续性未通过，未自动扩修 S5。
- 初次静帧采集在全部子命令成功、产物写完后因同步入口误调用 `.catch` 退出 1；已修正隔离采集器为 async，并独立核验全部子命令退出码和候选。没有覆盖采集证据或再次生成。

[归档验证](../data/production-baseline/20260925-140900/evidence/verification.json)通过：62 项索引、6 条观察、92 项受保护文件哈希未变。原片、A 版、业务源码及总计划未改，未回写生产或提交代码。纸袋整体问题尚未关闭，六槽仍为 0/6、36 项固定任务未执行，总路线保持 Executing。

## 切片2 验收快照：compose-input 合成输入本地返修（2026-09-26，探针门禁）

第二期 precision-rework 切片2「不需媒体生成的修改」之合成输入部分（T1–T7）交付。实现真源存档（已入本仓库）：规格 `docs/records/精确返修-合成输入-design.md` + 计划 `docs/records/plans/精确返修-合成输入-计划.md`。能力范围：对已产出成片，在受控返修闸内改合成配置（转场/时长/BGM·SFX 音量/BGM 淡入/字幕烧录）、对已存在项目音频换绑/移除 BGM、候选改选；本地重新合成，零模型调用、零计费，旧成片终审批准一律作废必复审。

- 后端：`services/rework/capability.ts`、`compose-input.ts`（契约+预览编译+apply 确认）、`compose-input-preview.ts`、`compose-input-apply.ts`（新）；`routes/rework.ts` 加 `GET .../compose-input/capability` + `POST .../preview` + `POST .../:requestId/apply`（专属端点，字幕 preview/apply 端点与语义逐字不变）。
- 入口收口（方案 A·共享原语一处收口）：`services/shot/reset.ts` 的 `resetStepForRecompose`（通用 recompose + 轻松创作 recomposeCreation 皆经此）与 `resetStepForRerun`（单步重跑）在 compose 步（`ffmpeg_merge`）重置为 pending 时一并剥离 `output.gate`——覆盖全部本地重合成入口，无需改各调用点；仅约束合成步，非 compose 步 gate 不动。
- 前端（方案 A·新增独立自治探测弹窗，不动 `ComposeSettingsModal` 直写草稿语义）：`components/run/compose-input-rework/` 下 `use-compose-input-rework.ts` + `ComposeInputReworkEntry.vue` + `ComposeInputReworkModal.vue`；`types/rework.ts` + `api/rework.ts` 加 compose-input 视图与 API。双模判据=后端 `capability.supported`：有可返修成片时「合成设置」顶部出现「合成返修」入口（本地收集变更不预先直写→预览→确认→本地重合成），无成片时入口自动隐藏、沿用原草稿直写。预览/影响/费用/过期一律展示后端返回值，前端零推算、不伪造可编辑态。
- 前端补全（本切片四类变更 UI 全部收口）：① **逐镜音效 SFX 换绑/移除**并入专属返修弹窗（`ComposeInputReworkModal`/`use-compose-input-rework` 复用既有只读 `GET /runs/:id/compose/sfx` 取每镜在用音效基线 + 项目音频候选，仅覆盖当前已绑音效的镜，`buildComposeInputChanges` 产出 `sfx` 变更；新增音效仍走原绑定路径）。② **候选改选 shot-select 接入镜头工作台选片闸**（`components/shot/board/use-shot-board.ts` 的 `applySelection`）：`board.compose.stepKey` 探测 `capability.supported`，成片已产出且本次为「纯换版本」（无启用/剔除等结构性改动）时，改走 `compose-input` preview→确认（携服务端 `previewHash`）→本地重合成，**不再直写 `shotApi.select`**；无成片或含结构性改动时保持原草稿直写逐字不变（T5 在重合成时仍复验指纹/作废旧 gate，无回退）。依据 M7 语义边界，启用/剔除镜不属 compose-input 四类，故不经此闸。`use-shot-board.ts` 增至 733 行（≤800）。

本轮补全验证（本机实测）：`pnpm -r typecheck` 双端绿（含 `vue-tsc`）；`pnpm --filter @acs/web build` 绿；`--only=precision-rework --section=compose-input` 349 断言仍全绿（后端四类契约本就已实现并测过，本轮纯前端接线，未改后端）；m26 `split-audit` 破线文件仍恰为既有 3 个（本轮改动的 3 个前端文件均 ≤800，净新增违规为零）。

自动门禁（本机实测，全绿）：`--only=precision-rework` 349 断言全绿（含切片2 compose-input 分节，字幕首切片断言不变）；`--only=m7` 110 全绿；`--only=m11` 184 全绿；`pnpm -r typecheck` 双端绿（含 `vue-tsc`）；`pnpm --filter @acs/web build` 绿（663 模块）。零新增依赖、零付费、未自动提交。

红线存量（m26 `split-audit` 单文件 ≤800 行归零门禁）：本切片曾把自有探针 `probe-precision-rework.ts` 撑到 882 行，已按其既有拆分惯例把 compose-input 分节抽到 `precision-rework-compose-input.ts`（主探针 545 + 新库 344，均 ≤800，断言文案逐字未改），**本切片净新增违规为零**。该门禁现仍红，唯一原因是 3 个早于切片2、本切片一行未改的既有存量文件：`CreationArtifacts.vue`(998)、`probe-m7.ts`(865)、`use-project-detail.ts`(803)。经用户拍板：此 3 项记为独立技术债、不在本切片内处理（重构与功能加分分离），另立后续单独拆分项，故 m26 的 `split-audit` 分节在本切片收口时**保持已知红**、非本切片回归。

待人工门（未声称）：浏览器端「合成返修」入口的挂载位置/文案/逐镜音效换绑与候选改选确认弹窗（成片已产出时工作台「应用选择」触发：逐镜旧→新 + 本地重合成入队 + 旧批准作废）的端到端观感，需人工在真实运行上核验；探针为隔离库 + 引擎桩，不等同于产品内真实 FFmpeg 重编码路径的可视验收。

## 切片2b 验收快照：镜头时长本地返修（轻档）（2026-09-26，探针门禁）

第二期 precision-rework 切片2 的子切片 2b「改某镜显示时长但不重生任何媒体」交付（T1–T8）。纳入与字幕/合成输入返修同一受控闭环（结构化预览→指纹过期即拒→幂等原子确认→仅作废合成步本地重编码→回执可核验）。实现真源存档（已入本仓库）：规格 `docs/records/精确返修-镜头时长-design.md`（§8 八断言为验收依据）+ 计划 `docs/records/plans/精确返修-镜头时长-计划.md`。已锁决策：run 级独立覆盖 `_compose.shot_durations`（不碰分镜源/批准链）；轻档仅图片镜 + 音频对齐镜覆盖，motion 视频镜文件级裁切排除（属中档另立项）；Q1 `shot_durations` 只经返修闸（`updateComposeConfig` 草稿直写排除该键）；Q2 motion 镜预览 fail-closed `blocked`（不静默 no-op）。

- 写侧真源（T1）：`services/compose-config.ts` `normalizeComposeConfigPatch` 加 `shot_durations` 分支（对象/非空 shotId/值有限正数 clamp `(0, SHOT_DURATION_MAX_SEC=600]`/整键 null 清除），与返修共用单一规范化真源；`updateComposeConfig` 在 `requireEditableRun` 后拒绝该键草稿直写（Q1）。
- 契约（T2）：`services/rework/compose-input.ts` `ComposeInputChange` 加第 5 支 `{kind:'shot-duration'; shotId; sec}` + zod 严格校验 + 同镜唯一冲突检测；compile 折进 `shot_durations` 配置键并逐镜单列 diff。**关键修正**：canonical `normalized.changes` 显式保留独立 `shot-duration` 条目（不折进 compose-config 后丢语义），否则 apply 期从 `changesJson` 重编译时 `durationChanges` 空、config 键又跳过 `shot_durations` → diffs 空 → 误判 `no_effect`（探针暴露的真实缺陷，非夹具产物）。
- 基准/预览/确认（T3–T5）：`capability.ts` 从 `params.timeline.segments` 只读派生 `shotAxis`（遵「params.timeline 唯一真源」，不造第二时轴算法）；`compose-input-preview.ts` 加轴校验（无快照→`no_timeline_axis`、shotId 不在轴→`bad_shot`、视频镜→`unsupported_motion`）+ Σ-clamp（请求短于对齐语音时长 Σ=durSec−silenceSec → `willClampToSec`/`warn`）+ 有效段长无变化（含 clamp 落回原值）→ `no_effect`；`compose-input-apply.ts` 复用既有 `inputObj._compose = nextConfig` 事务/gate 作废/幂等，回执加 `durations:{shotId,fromSec,toSec}` 明细（容错校验保父切片既有回执回放不判 corrupt）。
- 合成期消费（T6，最高风险）：`pipeline/actions/ffmpeg-merge/index.ts` 两条互斥时长生效路径（`perShotDur` images base/无对白回退 + `alignShots[].durationSec` 音频对齐 plan）都注入 `_compose.shot_durations` 覆盖，均按 `images` 模式防御性跳过 motion；**不改 `planVoiceAlignedSegments`/`planBestEffortTimeline` 纯函数语义**，段/句/字幕位置由既有算法同源重算。
- 前端（T8，四类→五类 UI 收口）：`ComposeInputReworkModal.vue` 新增「镜头时长」段（仅图片镜渲染「保持/覆盖为 X 秒」输入，motion 视频镜只读标「不适用」）；`use-compose-input-rework.ts` 采集 `shot-duration` 变更 + `buildComposeInputChanges` 产出第 5 类；预览展示后端返回的旧→新（含 clamp/warn 文案），复用 capability 双模探测 / guardClose / 幂等 ticket。`routes/rework.ts` capability 端点加 `shot_axis`（透传 `baseline.shotAxis` 单一真源），`types/rework.ts` 契约对齐加 `shot-duration`/`willClampToSec`/`warn`。

自动门禁（本机实测，全绿）：`--only=precision-rework` **374 断言全绿**（新增 `--section=shot-duration` 分节 25 断言覆盖规格 §8 八条 + 空轴 fail-closed + 预览零执行 + 冲突/非法 sec/超 MAX clamp + Q1 写侧排除；字幕首切片与父切片 compose-input 四类断言逐字不变不回归）；`pnpm -C apps/server typecheck`（`tsc --noEmit`）绿；`pnpm --filter @acs/web build`（`vue-tsc` + vite 663 模块）绿。零新增依赖、零付费、未自动提交、加法优先（四类既有路径逐字不变）。

红线存量（m26 `split-audit` 单文件 ≤800 行归零门禁）：本切片按既有拆分惯例把 shot-duration 探针分节抽到 `precision-rework-shot-duration.ts`（141 行，被主探针 import 而非独立扫描；主探针 548 行），本轮改动的 5 个文件（后端 4 + 探针库 1）与前端 3 文件均 ≤800，**净新增违规为零**。m26 `split-audit` 仍恰为既有 3 个早于本切片的存量文件（`CreationArtifacts.vue`(998)、`probe-m7.ts`(865)、`use-project-detail.ts`(803)）保持已知红、非本切片回归（用户已拍板记为独立技术债另立拆分项）。

待人工门（未声称）：浏览器端「镜头时长」输入行→预览（旧有效→新含 clamp 落回文案）→确认→本地重合成入队→新成片逐镜时长实际变化的端到端观感，需人工在真实运行上核验；探针为隔离库 + 引擎桩 + 假时轴快照，不等同于产品内真实 FFmpeg 重编码路径的可视验收。

## 第四期验收快照：统一 QC 面板（成片质量可验证 / 交付可信只读核验）（2026-09-28，探针门禁）

第四期 `qc-panel`「把第一期已确立的证据口径产品化为应用内一条只读按需核验服务」交付（T1–T7）。上位路线与原 M50 计划不修改；第一期 `production-baseline` 与切片2b 规格不重写，本期纯**加法**新建只读核验面。唯一实现真源存档（已入本仓库）：规格 `docs/records/第四期-统一QC面板-design.md`（已批准，§8 九断言为验收依据）+ 计划 `docs/records/plans/第四期-统一QC面板-计划.md`。已锁决策：Q1 verdict **只读**（绝不改 `delivery_checked`、不触批准链、不新增写路径）；Q2 音频**纳入客观测量不判失真**（dBTP/LUFS 记录，削波/失真置 `manual_review_required`）；Q3 **仅成片级**（逐镜图像质量引用既有 `image-check`，面板不重做）。结果/evidenceType 词表与第一期 §5.3 逐字对齐，避免两套口径漂移。

- 后端只读服务（T1–T4，`services/qc/`）：`types.ts`（契约+常量，纯类型不触 DB/执行）；`measure.ts`（本地 ffprobe JSON 取容器/流/分辨率/帧率/实测时长 + ffmpeg ebur128 取真峰值/积分响度，工具缺失/超时→`null` 宽容，镜像 `image-check` 保守策略，不判失真）；`consistency.ts`（纯函数：五项一致性核验 `timeline_source`/`duration_vs_timeline`/`shot_duration_applied`/`rework_receipt_consistency`/`subtitle_alignment_present`，只读解析 `params.timeline` 唯一真源不反推、覆盖未入轴→failed、台账 applied 指纹漂移→failed、门禁不足→not_tested 不伪造）；`report.ts`（编排 `runQcCheck`：定位成片→测量→一致性→聚合三态 verdict+`missing[]`→`merge` 进 `assets.params.qc` **零新列**镜像 `recordQuality`；`readQcCache` 成片 hash 变→旧 local/offline 结论标 `stale`、ready 降级）。
- 只读端点（T5）：`routes/qc.ts` 加 `GET /api/v1/runs/:id/qc?refresh=0`（缺省按需重算并刷新缓存，`refresh=0` 优先命中缓存并标 `fromCache`）；`app.ts` 挂载 `qcRoutes`。门禁不足按 404 语义，`no_final_video`/`not_found` 分列供前端区分文案。全程不 import 引擎、不写业务表（除 `params.qc` 缓存）。
- 前端只读面板（T7）：`components/run/qc/RunQcPanel.vue`（运行详情右栏辅助面板，与「合成返修/导出包」同级、独立只读）——挂载读缓存→无成片自动隐藏（能力探测驱动显隐，不打扰）、逐条渲染客观测量/一致性/交付标记/主观缺项（带 status/source/value/reason）、verdict 徽标 + `missing[]`、`重新核验`按钮（refresh=1 按需重算）。**前端零推算**：Σ/clamp/verdict 一律取后端返回值，无任何写/重合成按钮；状态徽标复用全局 `.badge` 语义修饰（主题 token 同源，不新造配色）。`types/qc.ts` + `api/qc.ts`（camelCase 与后端逐字段对齐）。

自动门禁（本机实测，全绿）：`--only=precision-rework --section=qc-panel` **26 断言全绿**（覆盖规格 §8 九条：合成真实 mp4 客观值/造差 failed、缺时轴不反推、时长入轴 passed/未入轴 failed、台账指纹漂移四态、audio_peak 客观测量失真留人工、verdict 三态 ready/needs_review/not_ready、缺测降级 not_tested、缓存 merge 保留其余键+hash 变 stale、零 gen_tasks/零 usage_records 不变量；本地 lavfi 合成假片标 synthetic，零模型零付费）；`--only=precision-rework` 全量 **401 断言全绿 / 0 失败**（字幕/compose-input/shot-duration 三既有分节逐字不回归）；`pnpm -r typecheck` 双端绿（含 `vue-tsc`）；`pnpm --filter @acs/web build` 绿（668 模块，1.97s）。零新增依赖、零付费、未自动提交、加法优先。

红线存量（m26 `split-audit` 单文件 ≤800 行归零门禁）：本期按既有拆分惯例把 qc-panel 探针分节抽到 `precision-rework-qc-panel.ts`（173 行，被主探针 import 而非独立扫描；主探针 548 行）；后端 4 文件（types 71 / measure 119 / consistency 153 / report 211）与前端 3 文件（types 49 / api 16 / RunQcPanel 224）均 ≤800，**净新增违规为零**。m26 `split-audit` 仍恰为既有 3 个早于本期的存量文件（`CreationArtifacts.vue`(998)、`probe-m7.ts`(907)、`use-project-detail.ts`(803)）保持已知红、非本期回归（用户已拍板记为独立技术债另立拆分项）。

待人工门（未声称）：**面板不等于成片质量通过**——只把「可客观测得的事实 + 一致性 + 交付就绪判定」如实汇总。① 主观项（视觉一致性/道具连续/听感失真）恒 `not_tested` 列缺项，须人工看片听审，浏览器端「质量核验」面板在真实成片上的观感待人工核验；② 探针为隔离库 + 本地合成假片，不等同于产品内真实成片的 ffprobe/ebur128 可视验收；③ 第一期六槽样片验收本身（0/6、36 项固定任务未执行）不因本期面板而标为完成；④ 编辑器能否真实导入工程文件属**第五期**实测，本期不下「编辑器通过」结论。总路线保持 Executing。

## 第五期验收快照：交付包认证 / 编辑器兼容认证（交付可信只读核验）（2026-09-28，探针门禁）

第五期 `delivery-certification`「把已生成的编辑交换交付包（FCPXML/EDL/OTIO zip）做一条只读结构认证服务，诚实区分『包结构可信』与『编辑器已实测导入』」交付（T1–T7）。上位路线与原 M50 计划不修改；第一期 `production-baseline`、切片2/2b、第四期 `qc-panel` 规格不重写，本期纯**加法**新建只读认证面。唯一实现真源存档（已入本仓库）：规格 `docs/records/第五期-交付包认证-design.md`（已批准，§8 九断言为验收依据）+ 计划 `docs/records/plans/第五期-交付包认证-计划.md`。已锁决策：Q1 认证对象=**已生成 zip 包**（无包 `needs_package`，绝不为认证造包）；Q2 verdict **天花板=至多 `needs_attention`**（`editor_import` 恒 `manual_review`，正常包永不达 `package_sound`）；Q3 跨格式一致性纳入首切片；Q4 结果 merge 进该 export 资产 `params.cert`（**零新列**）；Q5 分工=本期只证 `params.timeline`↔包内事实，mp4↔`params.timeline` 新鲜度归第四期。结果/evidenceType 词表与第一期 §5.3、第四期 `qc/types.ts` 逐字对齐；`params.timeline` 唯一真源，只读交叉核对、绝不反推重建第二套时轴。

- 后端只读服务（T1–T3，`services/delivery-cert/`）：`types.ts`（77 行，契约+常量，纯类型不触 DB/执行/IO，含八认证项 `CertCheckKey`、`CertStatus`/`CertEvidenceType` 复用一/四期词表、verdict 四态、门禁 block 码）；`analyze.ts`（207 行，逐格式纯解析器：FCPXML XML 声明+单根+标签配平+有理秒 `N/Ds`→帧、OTIO `JSON.parse`+`OTIO_SCHEMA.*.Timeline`+`source_range`帧、EDL `TITLE:`/`FCM:`+事件行+`HH:MM:SS:FF`→帧；不引 schema 库；**解析异常返 `wellformed=false` 绝不抛**）；`certify.ts`（319 行，编排 `runDeliveryCert`：`listEditExchanges` 定位包（无→`needs_package` 不造包）→ `absPathOf`+`unzipSync`（既有 `fflate`）取 `manifest.json`/工程文件/`media/*` → 逐项产 `project_file_wellformed`/`duration_math_consistent`/`cross_format_consistency`（单格式→`not_applicable`）/`media_refs_resolvable`（`include_media=false`→`not_applicable`，悬空→`failed`）/`timeline_source_bound`（读 `params.timeline` Σ 比对，不可新鲜→`not_tested` 绝不 `passed`）/`subtitle_delivery_bound`（复用 `manifest.subtitle.deliveryConsistent`）/`editor_import_certified` **恒 `not_tested`+`manual_review`（常量，无任何路径置 passed）** → 保守 verdict+`missing[]` merge 进 `params.cert`（零新列，保留其余键+`checkedAt`+`packageSha256`）；读时 zip hash 变→旧结论标 `stale`）。
- 只读端点（T4）：`routes/exports.ts` 新增 `GET /api/v1/runs/:id/delivery-cert?format=&refresh=`（缺省按需重算并刷新缓存，`refresh=0` 优先命中缓存标 `fromCache`、miss 回退重算；`format` 白名单校验 `fcpxml/edl/otio`，`run` 不存在→404 `run_not_found`）。`exportsRoutes` 既有挂载即生效，除 `params.cert` 缓存外不新增写路径。
- 探针分节（T5，风险前置）：`probe-m50.ts`（448 行 ≤800）SECTIONS/runners 加 `certify` 分节——隔离库 + `buildEditExchange`（`include_media` true/false）落一次性假包（标 synthetic，**零模型零计费**），本地 `zipSync` 改写工程/manifest 造破损·时长差·media 悬空·跨格式漂移·hash 变。落规格 §8 九断言。
- **探针捕获并修复的真实红线 bug**：编排初版 `decide()` 把 `editor_import`（不在客观自动项循环内）仅 push 到 `missing[]` 而不置 `anyUnclean`，导致全客观项 passed 时误判 `package_sound`——违反 §0.4/§3「编辑器实测恒缺天花板」红线。修 `decide()`：`editor_import` 非 passed 即置 `anyUnclean=true`，`verdict` 天花板回落 `needs_attention`（`package_sound` 语义位保留但本期永不发生）。**断言正确、未弱化，修的是被测代码**——风险前置切片在编排对外接线前兑现核心价值。
- 前端只读认证视图（T6）：`apps/web/src/lib/types/delivery-cert.ts`（56 行，与后端逐字段 camelCase 对齐）+ `lib/api/delivery-cert.ts`（21 行，`GET /runs/:id/delivery-cert`）+ `components/run/cert/RunDeliveryCertPanel.vue`（234 行，挂运行详情 `RunQcPanel` 之后、`RunExportsPanel` 同级、独立只读）——挂载读缓存→无交付包（`needs_package`）/run 不存在自动隐藏（能力探测驱动显隐，不打扰）、逐条渲染八项 status/source/value/reason + verdict 徽标 + `missing[]`、`重新认证`按钮（refresh=1 按需重算）。**前端零推算**：帧/时长/verdict 一律取后端返回值，无任何写/造包/重合成按钮；状态徽标复用全局 `.badge` 语义修饰（主题 token 同源，不新造配色）。

自动门禁（本机实测，全绿）：`probe-m50 --section=certify` **34 断言全绿 / 0 失败**（覆盖规格 §8 九条：健康包 verdict=`needs_attention` 且五客观项 passed+单格式 cross `not_applicable`+editor_import `manual`、破损不可解压→`package_broken`、clip 越界→wellformed=passed 且 duration_math=failed、media 悬空→`failed` 与 `include_media=false`→`not_applicable`、三格式一致→`cross=passed` 与人为改总帧→`cross=failed`、deliveryConsistent=false→subtitle=failed、**无包达 `needs_package`+零写 / editor_import 恒缺致任何包都不达 `package_sound`（红线守卫）**、`params.cert` 缓存保留其余键（零新列）+ hash 变→`stale`+`readCertCache` 命中 `fromCache`、纯解析器对畸形 OTIO 返 `wellformed=false` 不抛、认证全程零 `gen_tasks`/零 `usage_records`/零新增 archive）；`pnpm -C apps/server exec tsc -p tsconfig.json --noEmit` 绿；`pnpm -C apps/web run typecheck`（`vue-tsc`）绿；`pnpm --filter @acs/web build` 绿（672 模块，2.25s）；`--only=precision-rework` 全量 **401 断言全绿 / 0 失败**（字幕/compose-input/shot-duration/qc-panel 既有分节逐字不回归）。零新增依赖、零付费、零模型、零新列、未自动提交、加法优先。

红线存量（m26 `split-audit` 单文件 ≤800 行归零门禁）：本期净新增违规为零——后端 3 文件（types 77 / analyze 207 / certify 319）、前端 3 文件（types 56 / api 21 / RunDeliveryCertPanel 234）与 `probe-m50.ts`（448）均 ≤800。`--only=m50` 现 98 断言 97 通过 / **1 失败=「红线：`ffmpeg-merge/index.ts` ≤800」（实测 812 行）**——经 git 核实该文件最后由 commit `32cd7f7`（切片2b 镜头时长本地返修）修改、本期一行未改且不在本期工作树变更集内，判定为**早于本期的既有基线漂移**、非本期回归；越界修复须动引擎/merge、不合本期只读边界，故记为独立技术债（NOTICED BUT NOT TOUCHING），另立后续拆分项。此外本机工作树尚有若干与本任务无关的未提交改动（`pipeline/{types,loader,builtin-assets}.ts`、`services/creation-chat/{execution,recipe}.ts`、`probe-m42.ts`/`probe-m7.ts`、`workspace/templates/*.yaml`），本期一律不触碰、不纳入本期验收。

待人工门（未声称）：**结构认证 ≠ 编辑器已验证通过**——① `editor_import_certified` 恒 `not_tested`/`manual_review`，产品永不代答「编辑器导入通过」，真实把 FCPXML/EDL/OTIO 导入 DaVinci/Premiere/FCP 后核对须人工实测；② 源时轴 `params.timeline` 对成片 mp4 的新鲜度（retry/resume/崩溃恢复路径是否最新值）本期未实测，无法确认新鲜时 `timeline_source_bound` 降为 `not_tested`、绝不 `passed`（归第四期/待人工）；③ 探针为隔离库 + 本地假包，不等同于产品内真实交付包在浏览器面板上的可视验收；④ 第一期六槽样片验收本身（0/6、36 项固定任务未执行）不因本期认证面板而标为完成。总路线保持 Executing。

## m26 红线拆分快照：ffmpeg_merge 单文件 ≤800 归零（质量可验证 / 少返工卫生项）（2026-09-28，探针门禁）

承接第五期收口时记录的既有基线漂移——`--only=m50` 唯一 FAIL「红线：`pipeline/actions/ffmpeg-merge/index.ts` ≤800」（实测 812 行，由 commit `32cd7f7` 切片2b 引入、第五期一行未改）。本快照记录该红线项的闭合（用户批准档位 **A1·最小安全**）。**纯行为保真拆分**：不动合成语义 / 滤镜图 / 时长 / 字幕 / 批准链，只把两个「已是独立顶层函数、参数全显式、零闭包捕获局部变量」的辅助从 `index.ts` 原样搬迁到同目录聚焦模块，对齐仓内 align/args/segments/sfx 既有粒度惯例——

- `exec.ts`（27 行）：`runFfmpeg`（spawn ffmpeg 子进程、stderr 逐行转 step.log 事件、非零退出抛错）。
- `merge-provenance.ts`（49 行）：`recordMergeProvenance`（镜头/配音/字幕/BGM/分镜输入汇成 exec 快照落库，失败仅告警）。
- `index.ts`：改为 import 调用（813 → **750 行**）；仅剪随函数迁出而变死的 import（`spawn`/`emitStudioEvent`/`assetInput`/`safeRecordExecSnapshot`/`ExecInputSpec`），保留主函数仍用的 `readVersionContent`/`Asset`/`shotIdOfAsset`（逐一实测调用点计数确认）；**re-export 公共 API 桶逐字不动**。

自动门禁（本机实测，全绿）：`pnpm -C apps/server exec tsc -p tsconfig.json --noEmit` 绿（EXIT=0）；`--only=m50` **98/98 全绿**（红线项由 97/98 转绿，含第五期 certify 分节在内全分节不回归）；`--only=precision-rework` **401/401** 逐字不回归；`--only=m50` 的 `redline` 分节持「ffmpeg-merge/index.ts ≤800」断言（本项红线由 m50 把守、非 m26），随拆分由 97/98 转 98/98；`--only=m26` split-audit 仅扫 `server/scripts` 与 `web/src`（**不含 `server/src`**），故本项拆分不触其计数、净新增违规 = 0。零新增依赖、零付费、零模型、未自动提交、加法优先。

红线存量（不变，非本项回归）：`--only=m26` split-audit 仍报「存量归零」红，系其扫面内 **3 个早于本项的既有 >800 文件**（`CreationArtifacts.vue`(998)、`probe-m7.ts`、`use-project-detail.ts`(803)）所致——均在 `web/src`/`server/scripts`，与本项 `server/src` 拆分无涉；系用户先前已拍板记为独立技术债另立拆分项，不在本次 ffmpeg_merge 闭合范围。上位路线与原 M50 计划不修改；本项为质量可验证 / 少返工维度的卫生闭合，不新增产品能力面。

## B 源时轴新鲜度：探针锁定不变量（交付可信实证补强）（2026-09-28，探针门禁）

承接第五期 `delivery-certification` 待人工门②「源时轴 `params.timeline` 对成片 mp4 的新鲜度本期未实测」。本轮先做只读调研，再按用户选择以**加性探针**把结论钉成实证门禁，**不改业务代码**（`certify.ts` 的 `timelineBoundCheck` 逻辑逐字不动）。

只读调研结论（`params.timeline` 新鲜度=按设计已满足）：`params.timeline` 唯一写入者为 `ffmpegMerge` 的 `registerAsset`（`index.ts`，经 `buildEditTimeline`），每次合成以 `Date.now()` 新文件名产出**新资产行**、mp4 与 `params.timeline` 同源原子写；`locateFinal`（`qc/report.ts` 与 `delivery-cert/certify.ts`）恒按 `and(runId, purpose=final_video, kind=video, isNull(deletedAt)) orderBy(desc(id)).limit(1)` **取最新行**；retry/resume/recover 复用 succeeded 步的 output 不原地改旧行，rework 作废 compose 步→重跑→新行；无任何代码事后单独改 `params.timeline`（仅 `writeQcCache` 加 `.qc` / `writeCertCache` 加 `.cert` 键 merge 保留其余键）。故 `timeline_source_bound=passed` 诚实可信——第五期计划里「新鲜度未证则降 `not_tested`」的对冲既不需要、当前实现也未采用（mp4↔timeline 内容级新鲜度仍归第四期 Q5，本轮不越界）。

`#F` 加性探针锁定（`probe-m50.ts` certify 分节）：`seedHealthy()` 产 10s timeline（→250 帧）→ `buildEditExchange` → `timeline_source_bound=passed`；随后**插入一条更新的 `final_video` 行**（`timeline2` totalSec:12→300 帧、段数仍 2 与包一致，模拟返修后重合成产出新行）→ 重跑 `runDeliveryCert` → `locateFinal` 命中 `desc(id)` 最新行 → 旧包(250 帧)≠最新成片(300 帧)→ 认证翻 `failed` + `package_broken`，`reason` 含「包=250 vs timeline=300」。实证「认证对着最新 located final 比对、绝不对陈旧快照放行」——若取错陈旧行则帧数一致不会翻红，故该断言精确锁住新鲜度不变量。

自动门禁（本机实测，全绿）：`probe-m50 --section=certify` 含 `#F` 三条断言全绿；`--only=m50` **103/103 全绿**（较拆分闭合的 98 净增 5=`#F` 三条 check + 两次 `ok()` 编排断言）；`--only=precision-rework` **401/401** 逐字不回归；`pnpm -C apps/server exec tsc -p tsconfig.json --noEmit` 绿（EXIT=0，探针 `scripts/` 不被 tsc 覆盖、由 tsx 运行验证）；`probe-m50.ts` **471 行 ≤800**。零新增依赖、零付费、零模型、零新列、未自动提交、加法优先。本项把交付可信维度「源时轴新鲜度」由「未实测留人工」升级为「不变量已被实证门禁锁死」，不新增产品能力面。

## M61 验收快照：混剪开场标题智能编排 + 标题字卡（三期全量）（2026-09-30，探针门禁）

M61「素材混剪模板开场标题智能编排（字号/样式/位置）+ 按标题智能设计生成图插入」三期一体交付（T1–T7，用户「三期一起立项」+「开工」指令）。唯一实现真源存档：规格 `docs/records/M61-混剪标题智能编排-design.md`（已批准 2026-09-30）+ 计划 `docs/records/plans/M61-计划.md`（逐 Task 勾选含途中发现）。按期递进逐期门禁：期1 规则排版 `style_mode:rule` + 本地字卡 `title_card:local`（零计费）；期2 LLM 排版 `style_mode:llm` + AI 背景卡 `title_card:ai`（付费开关，复用既有 LLM/图像实例，失败降级）；期3 per-line 多 ASS Style 分层排版。全部新开关默认 `off` = 逐字节零 diff；**红线**：0 新表 0 新列 / 0 新 action / 0 新付费面 / 0 Web 改动。

- 期1（T1–T4）：`subtitle.ts` `planTitleStyle` 纯函数 + fixed 分支产 `style_plan/title_lines`（off 零增键）；`ffmpeg-merge/index.ts` 样式链 `smart ⊕ brand 字段级合并（手工恒胜）> legacy > default`；`title-card.ts`/`title-card-compose.ts`（CJK 字体解析 + drawtext 排版纯函数 + IO 编排，index.ts 守 ≤800）；`Segment.card`/卡段免 Ken Burns/`cutCues` 字卡窗口字幕裁剪；`photo-montage.yaml` v3 入参。期1门禁：rule+local 实弹成片（卡 8.5s/总 12.5s/零计费/对照零增键）；相邻回归 probe-m53 全绿；当期全量串行 60 探针 5410 断言绿。
- 期2（T5–T6）：`title-style.md` 提示词 + LLM 调用 + `parseStylePlan` 白名单清洗 + 失败降级 rule；`title-card-bg.md`（无文字铁律）+ `card_bg` 子链两步（`after=[captions]` 反级联防不可达）+ compose 底图分支（缺底图恒降级色底防线）。机制修正诚实留档：spec「未配置→降级色底」前提校准——引擎失败收敛为全局语义（任一步 failed 即 run failed），实际契约 = compose 对缺产物降级（防线）+ 子链显式失败 run 报错可改 local（与 M54 analyze 同构），UI 文案与 spec 已同步。期2门禁：validate:templates 19 份 0 错 0 警 + llm 三 run 计费/降级矩阵 + ai 全 mock 实弹（成功三步/叠字白像素/计费 llm2+image1；降级边界 run B）。
- 期3（T7）：`assStyleRow` 23 字段具名 Style 行 + `srtToAss` 多 Style/cueStyle 映射（按原始 cue 序，越界回落 Default，预算按各 cue 生效字号）；**实测推翻 spec 假设**（风险前置兑现价值）：本机 libass `force_style` 逐字段覆盖**所有** Style 行非仅 Default，会把具名组打平毁掉分层——最小对照实验（9 alignment × force_style 开关矩阵 + rawvideo 抽帧扫墨）锤定后，正解 = `assLayered` 省略 force_style + `defaultCfg` Default 行全量承接，缺省链逐字节零 diff 不变；spec 决策表已划线修正 + 实施补注。字卡与 `cue_style` 分组同源。

自动门禁（本机实测，全绿）：`pnpm -r typecheck`（server tsc + web vue-tsc）绿；`probe-m61` 六节 pure/ass/template/llm/ai/live **114 断言全绿**（live run C 分层实弹：Title1 居中墨迹行中心 120 vs off 对照 Default 底部 227，零付费可辨）；`probe-m26 split-audit` 红线存量 0（index.ts 798 行）；`validate:templates` 19 份 131 步 0 错 0 警（photo-montage 5 步）；终门禁 `pnpm probe:ci`（run-probes 串行 --fail-fast）**61 探针 / 5488 断言全绿**（299.4s，exit 0；字幕溢出主探针 m19 408 断言零回归）。首跑 m3 瞬红灯经 git 现场核实为并发会话跑批中途同步 version 断言的竞态，重跑即绿，非本任务回归。零新增依赖、未自动提交、加法优先。

待人工门（未声称）：① 浏览器端跑 `photo-montage` 真实项目开 `style_mode/title_card` 开关后的成片观感（字体兜底链路在用户真实字体环境下的效果、AI 底图与标题叠字的可读性）需人工看片；② llm/ai 两付费开关在真实实例上的计费面只在探针中以桩验证，真实 provider 计费未实测；③ 探针 live 节为合成假素材 + 本地 ffmpeg 实弹，不等同于产品内真实素材库成片的可视验收。

## M62 验收快照：轻松创作路由信号扩展（小说改编 / 素材拼片出口）（2026-10-08，探针门禁）

M62「把『混剪/拼照片/纪念相册』和『小说/改编』纳入 route-hint 信号表并指向对应模板」交付（用户「开始立项」→「开始执行」指令）。唯一实现真源存档：规格 `docs/records/M62-轻松创作路由信号扩展-design.md`（已批准 2026-10-08）+ 计划 `docs/records/plans/M62-计划.md`。服务端唯一改动点 `route-hint.ts`：`ROUTE_TARGETS` +2（`novel-adapt`/`photo-montage`）+ `detect` +2 信号（小说改编置顶于连载；混剪置于 image-reverse 之后、超时长之前），弱词双前置防误报；前端本项机制面 0 改动（建议条通用分支天然覆盖）；**红线**：0 新表 0 新列 / 0 新增 action / 0 新付费面 / 0 模板改动；routeHint 不进 planHash 不变式原样保持；建议仍非阻断（Tier B），不自动建专业项目/起 run。

- T1 实现：`wantsNovelAdapt`（小说/原著/网文 × 改编动作，片段/梗概/选段/简介排除）；`MONTAGE_INTENT_WORDS` 强词表（无须前置）+ `MONTAGE_WEAK_RE` 弱词句式 + `wantsPhotoMontage(text, hasImageRef)` 双前置（图片参考 × 图/照片/素材）；detect 注释编号顺延 1–7；文件头注释同步「新增信号必须同步 probe-m57/probe-m62 断言」。新建 `probe-m62.ts`（五节 33 断言）；`run-probes.ts` readdirSync 自动发现零接线。
- 实施补注（计划外 1 项，已获用户授权）：[M62-split] 既存红线恢复——全量门禁首轮到 m26 红（CanvasBoard.vue 802 行 >800 常红约束），经 git 现场核实非本项引入（`03f64de` 2026-09-30 16:48 由 730 行推入），拆出纯静态图例为 `CanvasLegend.vue`（净 −38 行 → 764 行，行为逐像素零变更），m26 复跑全绿。
- 无其他机制偏离（design spec §二–§六 全量落地，probe-m62 一次全绿）。

自动门禁（本机实测，全绿）：`pnpm -r typecheck`（server tsc + web vue-tsc）exit 0；`probe-m62` **33 断言五节全绿**；回归 `probe-m57` 26 / `m58` 44 / `m59` 24 / `m56` 33 断言全绿；`probe-m26 split-audit` 红线存量 0；终门禁 `pnpm probe:ci`（run-probes 串行 --fail-fast）**63 探针 / 5569 断言全绿**（287.9s，exit 0；m19 408 断言零回归）。首跑 m15 子进程 `probe:m2a` 退出码 3221225477（Windows 进程退出清理偶发假失败，其断言全部通过）复跑即绿，非本任务回归。零新增依赖、未自动提交、加法优先。

待人工门（未声称）：① 对话内真实会话触发两新信号的端到端观感（建议条文案与「展开指专业端」交互）未做浏览器实弹；② `photo-montage`/`novel-adapt` 专业链自身的成片/改编效果不在本项验收面（本项只交付方向建议，执行载体不变）；③ 弱词双前置防线对真实用户措辞分布的误报率未做线上统计（误报收口预案见 spec §六：收窄词表，不引入模型判定）。
