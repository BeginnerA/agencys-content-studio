# agencys-content-studio M19 里程碑 review

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-15
- 对应 spec：`2026-09-14-agencys-content-studio-m19-design.md`（§5 验收）
- 判定：**八节探针 + 全量回归零适配 + 实弹（真实合成 / 真实出图 / 真实阿里云声音复刻与 `clone:` 配音）全绿**；spec §5.2 八项实弹逐项落地，**声音克隆降级路径未启用**（凭证可得，按真实调用交付）
- 证据采集方式：`probe:m19` 八节 **378 项断言**（零网络零计费；克隆供应商径以 `globalThis.fetch` stub 断请求体，ffmpeg 侧为 args / filter 串快照）+ 全量独立回归 `probe:m2a / m3 / m4 / m6~m18` **17 个探针合计 2233 项断言、零适配**（`probe:m11` 合成快照与 `probe:m3` 声线旧断言为两条红线，均未改一行）+ 双端静态（server `tsc` / web `vue-tsc` exit=0）；真实开发库实弹（项目 10 · run 101 · :3001 + :5174 运行态）；无头浏览器 DOM + REST；P8 克隆为真实计费调用（复刻 1 次 + 合成 2 次）

---

## 结论摘要

- **成片品质与品牌化一次补齐三批 8 项**：批 1 品牌化（字幕样式结构化 / 品牌水印 / 片头片尾）+ 批 2 声画（per-shot 音效 SFX / 多画幅 A+B 双路径）+ 批 3 生成链（素材页批量生成参考图 / states 逐镜注入 / 声音克隆），M19–M27 纲领中「成片品质」集群清零。
- **零漂移红线守住并留有对拍证据**：`probe:m11`（124 断言）与 `probe:m3`（100 断言）**零适配**通过；同一 run 101 在新代码下两次合成（#1296 改造前基线 / #1351 改造后）的 `params.subtitle_style` **逐字相同** `FontName=Noto Sans CJK SC,FontSize=35,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,MarginV=38`（1920 高基线：35=round(1920×0.018)、38=round(1920×0.02)、2=max(1,round(1920×0.0009))）——「无新配置 = 现行为逐字不变」不只是探针推断，也有真实渲染数据佐证。
- **三层品牌配置成为唯一事实源**：平台 `settings.brand` / 项目 `projects.settings.brand` / run `_compose.brand` 字段级浅合并（换 run 调品牌不改项目默认），四个槽 `subtitle / watermark / intro / outro` 同构；素材来源二选一（平台品牌目录 `file` 或项目资产 `asset_id`），文件缺失一律「跳过 + log」宽容降级，绝不阻断合成。
- **多画幅双路径互补**：A 派生端点（对既有成片二次处理、同源幂等复用）三比例实测 `#1348 1:1 crop / #1349 4:5 pad / #1350 16:9 crop`；B 合成内多路原生渲染实测 `#1353 1:1 / #1354 16:9`（+ 主 `#1351`，同一 ffmpeg 进程多输出、音频 `asplit` 分流），日志明示「编码 ×3，耗时相应增加」且默认关闭需显式勾选。
- **生成链补全把「人工挂参考图」变成批量动作**：批量生成真实出图 7 张（4 实体 × 变体，`params.source='entity_ref_gen'`）+ 取消 1 任务弃存（task #468 → `cancelled`、无资产落库）+ 逐条用量对账；states 逐镜注入在 run 101 真实生效——日志「状态锚定注入 15 镜」19 条命中明细，产物 prompt 内可见「状态锚定（阿木·第5场）：手腕被攥出抓痕，拉扯中姿态失衡」，与 spec §2.2⑦ 的「第5场」示例完全对应。
- **声音克隆走的是「真出声」路线**：`voice_clones` 平台音色库（零密钥）+ 4 枚端点 + 能力位矩阵 + 声线六级链任一级 `clone:{id}` 引用（命中换端点 + 换克隆绑定模型，失效跳过该级继续降级）；真实复刻 → 真实试听 → 画布 audio 节点真实配音（asset #1363，溯源 `voiceSource:'clone'` + `clone_id` + `clone_name`）三段全链打通。

---

## 验收逐条对照（spec §5）

### #1 探针：probe-m19 八节全绿 + probe-m1~m18 回归（probe-m11 零适配优先）

- **操作**：`npx tsx scripts/probe-m19.ts`（全量与逐节）+ 逐探针独立回归 `probe-m2a / m3 / m4 / m6 / m7 / m8 / m9 / m10 / m11 / m12 / m13 / m14 / m15 / m16 / m17 / m18`。
- **证据**：`probe-m19` **378 项断言全过 / 0 失败 / exit=0**——subtitle-style 20 · brand-watermark 32 · intro-outro 16 · sfx 41 · aspect 57 · ref-gen 79 · states 39 · voice-clone 94；回归 17 个探针**全部 exit=0 且 fail=0，合计 2233 项断言**（m2a 28 / m3 100 / m4 75 / m6 28 / m7 103 / m8 116 / m9 122 / m10 104 / m11 124 / m12 76 / m13 121 / m14 130 / m15 78 / m16 129 / m17 274 / m18 247 / m19 378），**适配 0 处**（spec §5.1「probe-m11 零适配优先」达成，无需 M18 式适配留痕）。
- **voice-clone 节构成（94）**：能力位矩阵（5 家 audio 目录仅 `aliyun_qwen_tts` available）→ `parseCloneRef` / `validCloneRef` / `sanitizeClonePrefix`（协议字符集与截断）/ `normalizeSampleMime` / `validateCloneSample`（类型 · 大小 · 时长软警告）→ `buildEnrollBody` / `parseEnrollResponse`（两套协议字段差异逐字断言）→ `createVoiceClone` fetch-stub 全链（成功径 / 7 条本地拦截族 / 供应商错误族 / 公网协议族）→ `resolveVoiceChain`（**旧签名 4 条断言原样保留** + clone 命中 3 条）→ `cloneEndpoint`（4）→ `synthWithClone`（5）→ **tts 真步集成**（`createStepContext` 真执行，双 provider 派发 + `assets.params` 溯源 + 用量 + 日志）→ `deleteVoiceClone`（5）。
- **✅ 通过**

### #2 实弹八项（真实浏览器 + 真实数据留痕）

| # | 项 | 证据（可复核留痕） | 判定 |
|---|---|---|---|
| 1 | 字幕样式改色/字号/位置 + **默认白字零漂移对照** | 零漂移对照：#1296（改造前）与 #1351（改造后）`params.subtitle_style` 逐字相同（见「结论摘要」原文串）；结构化字段接管后旧串忽略并写日志；三层配置在 `ComposeSettingsModal` / 项目品牌 tab / 平台品牌 tab 三处 UI 可编辑 | ✅（改色渲染样本未保留，见「局限」） |
| 2 | 水印三层（平台文件 / 项目资产 / run 覆盖） | #1351 `params.watermark={"position":"br","opacity":0.8,"width_pct":0.15,"source":"file"}`；run 101 日志「ffmpeg 开始合成（20 段 + 音频轨 + 字幕 + 水印）」；平台品牌文件实存 `workspace/brand/watermark-1789367559729-tmp-277-test.webp`（35,376B）；UI 截图 A0/A3/A5/A8/B3（平台品牌 tab 上传前后 + 项目品牌 tab） | ✅ |
| 3 | 片头尾拼接（时长对账 / SRT 平移 / BGM 全覆盖） | 语义由 `intro-outro` 节 16 断言锁定（拼接顺序、`shiftSrtText` 片头位移与对齐位移**合并单次变换**、条目数量不符回退原样）；批次内真实合成目检通过 | ⚠ 通过但配置已清理（成片 `params.intro/outro=null`，复核路径见「局限」） |
| 4 | 每镜 SFX 绑定 + 真实混音 | run 101 `s01` 真实绑定两行 assets #1346/#1347（`purpose=sfx` + `params={shotId:"s01",source:"asset",source_asset_id:1333,original_name:…}`，随后经 `DELETE /compose/sfx/:shotId` 软删留 `deleted_at`）；镜起点混音与音量由 `planSfxStarts` + `sfx` 节 41 断言锁定；`ShotSfxModal` 浏览器接线 | ✅ |
| 5 | 多画幅 A 三比例 + B 多路渲染 | A：#1348 1080x1080 crop / #1349 1080x1350 pad / #1350 1080x608 crop（`source:'derived'`, `source_asset_id:1296`, duration 107）；B：compose step #852 `output={"asset_ids":[1351,1352,1353,1354]}`（1351 主 1080x1920 / 1353 1:1 / 1354 16:9 均 `native:true, source:'multi_render'`，1352 为封面）+ 日志「多画幅原生渲染：主 1080x1920 + 派生 1:1(1080x1080)、16:9(1080x608)（策略 crop，编码 ×3）」；UI 截图 p5 四张（派生弹窗 / 已派生列表 / 合成弹窗多画幅区 / B 路产物卡片） | ✅ |
| 6 | 批量生成真实出图 + 自动挂接 + 用量对账 | 真实出图 7 张 #1355–#1361（`purpose=reference_prop`，`params.source='entity_ref_gen'` + `entity_id` 53/69/70/72 + `variant_index` + `task_id` + `refs_used`）；取消径 task #468 → `cancelled` 且无产物落库；用量 #968–#973（`pollinations_image` flux.1-schnell 0.015/图）与产物逐条对应；截图 p6-modal / p6-done | ✅ |
| 7 | states 注入日志 + 真实出图目检（第5场示例） | run 101 日志 `[gen_images] 状态锚定注入 15 镜：…共 19 条`（含 s01 老周「第1场」/ s02 阿木「第1场末」/ s05 灯婆婆「第3场」…）；s11 单镜真实重生成 → asset #1362（768x768，检测 ok）prompt 含「状态锚定（阿木·第5场）」+「状态锚定（老周·第5场）」+ 场景 / 道具锚定 + 风格注入；前后对照图 s11-before / s11-after | ✅ |
| 8 | 声音克隆实测 + `clone:` 引用真实配音 | ① 建实例 `api_configs#32`（`aliyun_qwen_tts` / audio / 凭证 #1 / 非默认 priority 5）；② **真实复刻** `POST /voice-clones` → 201 `voice_clones#1`「实测复刻甲」`voice_id=qwen-tts-vc-voice-voice-20260915101920814-ddd1` / `model=qwen3-tts-vc-2026-01-22` / `status=ready` / `meta={protocol:dashscope-qwen-enrollment, prefix:voice, transport:data-uri, target_model:qwen3-tts-vc-2026-01-22}` / `warnings=[]`；③ **真实试听** `POST /voice-clones/1/test` → 200 audio/mpeg 180,524B（`X-Voice-Id` 回显）；④ UI 11 步（音色库 tab · 能力矩阵置灰 · `<audio>` 试听 · 复制 `clone:1` · 角色「灯婆婆」voice 写 `clone:1` → 卡片显示克隆音色 → 回显 → 还原原值）console 零 error，截图 voices-tab / preview-audio / copy / entity-clone-select / entity-clone-card；⑤ **`clone:` 真实配音**：创作画布 audio 节点（canvas 9 / node 33 / task #470 succeeded）→ asset #1363（211,244B）`params={provider:aliyun_qwen_tts, model:qwen3-tts-vc-2026-01-22, voice:qwen-tts-vc-voice-…, voiceSource:clone, clone_id:1, clone_name:实测复刻甲, chars:22}` + 用量 #975（tts / 22 char）；实弹画布自清理（软删 + purge）；样本为平台真实 TTS 语音 12 段 ffmpeg concat（19.94s / 120KB mp3） | ✅ |

### #3 兼容（无新配置时全链逐字不变 · 旧签名 · 旧端点超集）

- **旧探针背书**：`probe-m11`（合成快照 / compose 配置）与 `probe-m3`（声线六级链旧签名）**零适配**全绿；`probe-m8 / m13 / m17 / m18` 亦零适配。
- **签名兼容**：`resolveVoiceChain` 不传 `cloneIndex` 时行为逐字不变（clone 令牌不可解析 → 记入 `cloneSkipped` 继续降级）；`buildSubtitleStyle(H, {}) === defaultSubtitleStyle(H)` 探针锁定；`ai-image` 无 states 实体零 diff（`states` 缺失时注入段完全不追加）。
- **无破坏性接口变更**：全部为新增端点（品牌 3 + SFX 3 + derive-aspect 1 + ref-gen 3 + voice-clones 4 = 14 枚）与配置键白名单扩展（`brand` / `sfx_volume` / `multi_aspect`）；`BgmModal.vue` 删除系由 `ComposeSettingsModal.vue` 升级承接（BGM 区原样保留 + 五区新增），M11 合成设置语义无回归。
- **assets 零列改动**（SFX / 派生画幅 / 克隆配音全走 `purpose` + `params`）；仅 +1 表 `voice_clones`（ensureTable 幂等，旧库升级实跑无报错——本轮实弹全程运行于存量库）。
- **✅ 通过**

### #4 文档

- README：**M19 能力速览（成片品质与品牌化）**——三批 8 项 + `clone:{id}` 引用语义 + 数据与兼容 + Web 接线 + **九步操作指引**（品牌三层 → SFX → 多画幅 → 批量生成 → states → 音色库）+ 验证行（八节 378 断言 / 回归 2233 断言零适配）。
- roadmap：M19「当前状态」由「spec 已产出待实施」回写为「实施 + 探针 + 实弹全绿」。
- 本文件（m19-review.md）；对应 spec：`2026-09-14-agencys-content-studio-m19-design.md`。
- **✅ 通过**

---

## 静态与探针

- **静态**：`apps/server` `npx tsc --noEmit` exit=0；`apps/web` `npx vue-tsc --noEmit` exit=0（含用户对 `ShotSfxModal.vue` 手工微调后的复验）。
- **依赖**：`apps/server/package.json` 仅 +1 行 `probe:m19` 脚本，**dependencies 零新增**（ffmpeg / ffprobe 既有，克隆与合成走原生 `fetch`）。
- **探针口径**：不执行真实 ffmpeg、零网络零计费——`ffmpeg-merge` 侧断言 args / filter 串快照（水印 overlay 表达式、`asplit` 分流、SRT 平移、`planSfxStarts` 镜起点、字幕样式串）；供应商侧 `globalThis.fetch` stub 断请求体并 `finally` 还原；真实合成质量由各批次实弹覆盖（两条证据链互补）。

---

## 偏差与修复记录

1. **【协议偏差 · 需留痕】默认复刻协议改取 Qwen 系而非 spec §2.2 所写 CosyVoice**：spec 登记 `aliyun_qwen_tts → { protocol:'dashscope-enrollment', defaultTargetModel:'cosyvoice-v1' }`，即 `model:'voice-enrollment'` + `action:'create_voice'` + `prefix` + `output.voice_id`；实装默认改为 `dashscope-qwen-enrollment` + `model:'qwen-voice-enrollment'` + `action:'create'` + `preferred_name` + `output.voice`，默认目标模型 `qwen3-tts-vc-2026-01-22`。两个协议**共用同一注册端点**（`POST {baseUrl}/api/v1/services/audio/tts/customization`），差异全在协议表字段。理由：平台语音通道既有 aliyun 合成端点是 qwen-tts 系（`multimodal-generation`），而克隆出的音色必须与合成端点同族同模型才能真正出声（spec 自身红线即「合成时须同模型使用」）；若按 spec 字面取 `cosyvoice-v1`，会得到「音色能建、本通道配音合不出」的假成功。协议表仍完整保留 `dashscope-enrollment`（`create_voice` / `prefix` / `input.url` / `voice_id`）形态，未来登记 CosyVoice 系合成端点即改一行白名单即可，无需改服务与端点。实测证明替代成立（复刻一次通过 + 试听出声 + `clone:` 真实配音 22 字）。
2. **【传输偏差】样本默认内联、公网 URL 为可选径**：spec 对公网协议的样本写法是「`input.url` 承 data URI」——该形态实际不被 `voice-enrollment` 支持（该字段语义为可访问 URL），而 qwen 协议的 `input.audio.data` 才是内联承载字段；故实装按协议区分 `transport`：`dashscope-qwen-enrollment` = Data URL 内联（本地开发无公网地址即可用，且避免样本落盘与外链泄露）、`dashscope-enrollment` = `sample_url` 直传公网地址（未传则明确报错引导）。spec §8「样本落盘与重克隆」仍列排除。
3. **【探针口径 · 备注，非缺陷】**：`probe-m19` 实施八节与 spec §2.6 八节同名；P1 基建断言群（`BRAND_DIR` / `voice_clones` 表 / purpose 登记 / events / `brand-config` 纯函数）并入 subtitle-style 与 brand-watermark 两节承载，未单设 `p1-schema` 节（与 M18「增设独立节」做法相反，覆盖等价、节数一致）。
4. **【既往批次真实缺陷修复 · P5】多路输出音频重复 `-map` → `asplit` 分流**：B 路径首版对同一音频 pad 在两个输出重复 `-map`，ffmpeg 报 `Error opening output files: Invalid argument`（退出码 -22）；改为 `asplit=2` 分流后复验通过，并补 6 条 filter 串断言（源码注释同步留痕），随后 run 101 三路实弹均带音轨。
5. **【UI 附带修复】**：`Modal.vue` 底栏按钮 `flex:none` + `white-space:nowrap`（合成设置弹窗长中文提示把「关闭」挤成两行）；`ApiConfigForm.vue` 实例名占位「主用文生图」→「主用图像」（新建语音复刻实例场景暴露措辞过窄）。

---

## 局限与备注

- **部分目检证据不可再复核（配置已按「不永久改动用户项目」清理）**：片头尾与改色字幕的验证渲染在配置清理前完成，现库内保留成片 `params.intro/outro` 为 `null`、`subtitle_style` 为默认串，时长对账数字未留档。复核路径：设置 → 品牌配置片头尾 → 重新合成 → `ffprobe` 断言「成片时长 = intro + Σ分镜 + outro」且字幕起始整体后移。
- **克隆实测覆盖一家供应商**：能力位白名单仅 `aliyun_qwen_tts`，其余 4 家 audio 供应商 UI 置灰 + 400 `unsupported_provider`；异步协议（火山 polling）与样本落盘重克隆按 spec §8 排除。
- **链路正确性 ≠ 音色相似度**：本次样本由平台既有 TTS 输出的 12 句语音 ffmpeg concat 而成（19.94s / mp3），足以证明协议与全链可跑通，不构成对真人音色相似度的评价。
- **多画幅 B 的组合面**：派生路字幕样式按「同高假设」计算（spec §8 排除「反转画幅逐路重算」）；B 与片头尾叠加时片头尾参与多路编码（时长 ×(1+k) 成本已在日志与 UI 提示）。
- **真实开发库留痕（有意保留，不清理）**：`api_configs#32`（复刻用 aliyun 实例，非默认不影响既有派发）、`voice_clones#1`、assets `#1346/#1347`（SFX 软删行，unbind 语义留痕）、`#1348~#1350`（A 派生）、`#1351/#1353/#1354`（B 多路）、`#1355~#1361`（批量生成 7 图）、`#1362`（s11 states 重生成）、`#1363`（`clone:` 配音）、usage `#968~#975`；实体 77「灯婆婆」`voice` 已在验证后还原为原值（`老年女声、沙哑温缓`），临时画布 9 已 purge。
- **工作副本含非 M19 改动（已征得用户决策同批提交）**：`apps/web/src/App.vue` 侧栏导航顺序调整（画布 / 素材 / 风格 前置于 模板 / 记忆）不属 spec §4 枚举范围；用户 2026-09-15 决策「一并提交」，故随本次 M19 commit 入库（行为无风险：仅导航数组重排）。
- **探针脚本一次性工具未入库**：验证期的临时脚本 / 截图落在 `d:\work\AI\.qoder\`（`tmp-m19-*`），不属于代码库交付物。

---

## 附录

- **服务端新件（3,488 行）**：`services/brand-config.ts`（286，三层合并 + 来源解析 + 清洗纯函数）/ `services/brand-assets.ts`（91，品牌目录上传 · 列表 · 删除）/ `services/aspect-derive.ts`（182，A 派生 + 幂等复用）/ `services/entity-refgen.ts`（482，批量生成执行器 + 提示词组装 + 取消 + 启动恢复）/ `services/tts-clone.ts`（457，协议表 + 能力位 + 样本校验 + 复刻 + `cloneEndpoint` + 音色库 CRUD）/ `routes/voice-clones.ts`（113，4 枚端点）/ `scripts/probe-m19.ts`（1,877，八节 378 断言）。
- **服务端改动**：`pipeline/actions/ffmpeg-merge.ts`（+610/−130，字幕样式组装 / 水印 overlay / 片头尾拼接 + SRT 单次平移 / SFX 混音 / 多画幅多路输出 `asplit`，全部分支开关）/ `services/compose-config.ts`（+231/−3，`brand` · `sfx_volume` · `multi_aspect` 白名单与规范化）/ `pipeline/actions/ai-image.ts`（+129/−2，`ShotSpec.scene` + `parseStateEntry` / `matchStateEntry` / `injectStateAnchors` 注入链）/ `pipeline/actions/tts.ts`（+63/−16，`clone:` 解析 + 端点与模型切换 + `voiceSource` 溯源）/ `routes/compose.ts`（+70/−1，SFX 3 + derive-aspect）/ `routes/system.ts`（+51/−1，品牌资产 3）/ `routes/characters.ts`（+28/−1，ref-gen 3）/ `services/creation-gen.ts`（+20/−9，画布 audio 通道接 clone）/ `services/ffmpeg.ts`（+20）/ `db/index.ts`（+21/−2，`voice_clones` ensureTable）/ `db/schema.ts`（+15/−1）/ `db/seed.ts`（+9/−7，`aliyun_qwen_tts` 目录行）/ `services/storage.ts`（+3/−1，`sfx` / `final_video_derived` purpose 登记）/ `env.ts`（+3，`BRAND_DIR`）/ `index.ts`（+4，ref-gen 启动恢复）/ `app.ts`（+2，挂路由）/ `services/events.ts`（+1，`entity.ref_gen`）/ `package.json`（+1）。
- **Web 新件（2,933 行）**：`components/BrandSettings.vue`（1,001，平台 / 项目 / run 三 scope 复用同一表单）/ `components/ComposeSettingsModal.vue`（729，BGM + 字幕 + 水印 + 片头尾 + SFX + 多画幅六区）/ `components/VoiceLibrary.vue`（453）/ `components/AspectDeriveModal.vue`（367）/ `components/ShotSfxModal.vue`（308）/ `lib/aspect.ts`（75）。
- **Web 改动**：`views/EntitiesView.vue`（+491/−5，批量生成多选动作 + 弹窗 + 页内进度）/ `lib/api.ts`（+165，14 枚 API）/ `lib/types.ts`（+127，品牌 / SFX / MultiAspect / DeriveResult / VoiceClone 类型超集）/ `components/ShotBoard.vue`（+65/−9，镜头卡片音效按钮与绑定徽标）/ `views/RunDetailView.vue`（+28，成片卡片派生画幅入口）/ `views/SettingsView.vue`（+14/−2，品牌 tab + 音色库 tab）/ `views/ProjectDetailView.vue`（+17，项目品牌 tab）/ `components/Modal.vue`（+6）/ `components/Icon.vue`（+3，`crop` / `flag`）/ `lib/format.ts`（+4，purpose 文案）/ `lib/socket.ts`（+2，`entity.ref_gen`）/ `components/ApiConfigForm.vue`（1/1）/ **删除** `components/BgmModal.vue`（−338，由 ComposeSettingsModal 承接）。
- **提示词**：`workspace/prompts/char-profile.md`（+2，规则 8 定位词格式指引；schema 与示例 JSON 零改动）。
- **红线零 diff 明细**：engine / pipeline executor / dag / refs / loader / 适配器 零 diff；`assets` 零列改动；生成模板 YAML 零 diff；M15/M16/M17/M18 画布三组件与文档层零 diff。

---

## 验证方式（已完结）

- 静态：`apps/server` `npx tsc --noEmit` + `apps/web` `npx vue-tsc --noEmit` → exit=0
- 探针：`npx tsx scripts/probe-m19.ts`（八节 378 项）+ 逐节 `--section=…` 计数 → exit=0；回归 `npx tsx scripts/probe-m{2a,3,4,6..18}.ts` → 16 个探针全 exit=0、**零适配**
- 实弹：真实库 REST + 无头浏览器 DOM（:3001 + :5174）——水印合成快照对拍 / 多画幅 A·B 产物与日志 / SFX 绑定与解绑 / 批量生成 7 图 + 取消 + 用量 / states 注入日志与 s11 重生成对照 / 阿里云真实复刻 + 试听 + `clone:` 配音 + 音色库 11 步 UI
- 采集时间：2026-09-14 ~ 2026-09-15（M19 P1–P9 全程，服务运行态）
