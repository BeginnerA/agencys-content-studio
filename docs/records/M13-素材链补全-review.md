# agencys-content-studio M13 里程碑 review

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 日期：2026-09-12
- 对应 spec：`2026-09-12-agencys-content-studio-m13-design.md`（§6 验收）
- 判定：**实弹七项 7/7 通过**（证据采集方式：probe:m13 七节 121 项断言；真实开发库实弹——真实视觉 LLM 提取、图片/视频重跑 gen_task 快照逐值、真实红图上传、真实批量润色、states 全链、无头 Chrome CDP DOM 22/22；项目 10 / Run 97·98；服务运行中采集）

---

## 结论摘要

M13「素材链补全」六项（视觉提取 / 多预设叠加 / 视频参考图 / 上传通道 / 批量润色 / states 入库）一次性全部落地，且以「真实开发库实弹 + gen_task 快照 + DB 逐值 + 运行日志 + 浏览器 DOM」方式逐条验证：从参考图提取画风词由 deepseek-flash **多模态实测支持**（2 图 → 格式令「（画风：…）」→ 预设 #2 落库）；多预设叠加在重跑链逐字命中「视觉风格：A；B」、旧单值绑定尾缀逐字不变（⑦ 兼容）；视频侧场景/道具参考图收集快照 `[797,798]` 入队、首帧保留、当前供应商（pollinations_video 能力 none）真实走 `no_cap` 降级日志；上传通道 sha256 复用 + 并集挂接 + purpose 锚定；批量润色 2 项真实 LLM 调用（appearance 变化 + usage 4 行）；states 列幂等迁移 + 替换语义 + 卡片 chips 全链闭环。至此 18 项 backlog 组2「素材链补全」6 项全部落地。

亮点：

- **视觉通道真实可达**：`ChatMessage.content` 放宽为 `string | ChatContentPart[]` 后，deepseek-flash 多模态实弹一次成功（非假设——请求体含 `image_url` data URI、响应经 `extractSnippetFromText` 规范为「（画风：…）」）；提取**不落库**（确认后才走既有 POST /style-presets），幻觉词零污染。
- **单值兼容逐字不变（⑦）**：老项目（settings 仅 `style_preset_id:1`）出图重跑后提示词尾缀与旧任务**逐字一致**（`params.stylePresetIds=[1]` 回退数组化）；新多预设 `[1,2]` 双写快照 + 「；」拼接；项目 settings 双键共存且运行时不取旧键。
- **首帧优先决策闭环**：`planVideoRefs` 四分支（none / no_cap / frame_first / ok）探针锁定；实弹在 pollinations_video（能力 none）下真实走 `no_cap` 降级并有日志留痕，`setRefAssetIds=[797,798]` 快照已入队固化——换 base64 供应商（volcengine / minimax / aliyun-wan）即自动激活 `ok`/`frame_first` 分支；Wan 帧/参考互斥被产品决策天然规避。
- **宽容降级全链实测**：润色失败不阻断（探针 2/1 混合场景：失败项未改 + 后续项继续）；上传校验 400/413/404 全矩阵；states 坏 JSON → [] 读侧容错。

---

## 验收逐条对照（spec §6.3）

### #1 ① 视觉提取——真实视觉 LLM → 格式令 snippet → 预填并建预设

- **操作**：项目 10 资产 #933/#935（2 张同基调参考图）→ `POST /style-presets/extract` → 响应 snippet → `POST /style-presets` 建预设 #2。
- **证据**：提取 200 `{snippet:'（画风：电影感写实3D渲染,cinematic photorealistic 3D render, moody night lighting, warm amber lamp glow against cool teal blue shadows, wet reflective surfaces, high detail textures）', provider:'deepseek_llm', model:'deepseek-flash'}`——**deepseek-flash 多模态实测支持**；预设 #2「M13 实弹·提取预设」201 落库（snippet 与提取结果逐字一致）；usage_records 记入（tokens_in/out ×2 行）。
- **✅ 通过**

### #2 ② 多预设叠加——项目绑定 2 预设 → 出图重跑 → 逐字「A；B」+ 双值快照

- **操作**：项目 10 settings 绑定 `style_preset_ids:[1,2]` → Run 98 gen_images s02 重跑 → 核对任务 params 与提示词尾缀。
- **证据**：任务 #406（s02）重跑后 `params.stylePresetIds=[1,2]` + `params.stylePresetId=1`（双写兼容）；提示词尾缀逐字 = `预设#1.snippet；预设#2.snippet`（「3D 写实厚涂质感，…；（画风：电影感写实3D渲染,…）」）；产出更新 #1151；项目 settings 双键共存（`style_preset_id:1` + `style_preset_ids:[1,2]`，运行时优先数组）。
- **✅ 通过**

### #3 ③ 视频参考图——含 location/props 分镜 → ai_video 重跑 → 快照 + 真实决策日志

- **操作**：Run 97 gen_motion s16（阁楼 + 木盒/围巾，实体参考图命中 [797,798]）→ 重跑 → 核对任务 params、运行日志与产出。
- **证据**：任务 #400（s16）重跑后 `params.setRefAssetIds=[797,798]`（保序去重快照）+ `firstFrameAssetId=1005` 保留；日志真实决策行「当前视频供应商不支持参考图注入（场景/道具参考图降级跳过）」（provider=pollinations_video 能力 none → `no_cap`）；产出更新 #1153→#1154。`frame_first` / `ok` 分支由探针四分支断言覆盖（当前环境无法实弹出现——见「局限与备注」）。
- **✅ 通过**

### #4 ④ 上传通道——素材页实传 → assets 行 + 并集挂接 + purpose

- **操作**：建素材甲 #54（初始挂 801）→ 经 `POST /entities/54/ref-images` 真实上传 320×240 PNG（ffmpeg 生成）→ 核对响应 / DB / 文件系统 / HTTP 读取。
- **证据**：上传 201 `asset#1155 {kind:'image', purpose:'reference_character', urls:{file:'/api/v1/assets/1155/file', thumb:'/api/v1/assets/1155/thumb?v=2'}}`；实体 `refAssetIds [801,1155]`（并集追加）；文件落盘 `workspace/projects/10/images/1789220857885-m13-ref-red.png`；`GET /assets/1155/file` 200。
- **✅ 通过**

### #5 ⑤ 批量润色——多选 2 项 → 真实 LLM → appearance 变化 + 用量

- **操作**：素材甲 #54 + 乙 #55 → `POST /entities/polish {ids:[54,55]}` → 核对响应 / DB / usage_records。
- **证据**：200 `{ok:true, polished:2 项, failed:0}`；甲「一个会在雨夜发光的小木偶，关节处缠着旧麻绳」→「小木偶，木质躯体，雨夜泛出微光，四肢关节处缠绕旧麻绳。」；乙「圆脸小男孩，穿旧棉袄，攥着半块麦芽糖」→「圆脸小男孩，身穿旧棉袄，手中攥着半块麦芽糖」；usage_records +4 行（deepseek_llm/deepseek-flash，2 项 × tokens_in/out）。
- **✅ 通过**（失败不阻断 / 上限 / 去重矩阵在 probe `polish` 节覆盖）

### #6 ⑥ states——PUT 变体 → 入库 → 替换语义 → 列表透出 → 卡片 chips

- **操作**：`PUT /entities/54 {states:['雨夜发光版','晴天沉睡版']}` → 读回 / DB 核对 → 替换语义（2→1）→ 定稿 2 项 → `GET /entities` 列表透出 → DOM 卡片 chips（见 #7）。
- **证据**：读回与 DB `["雨夜发光版","晴天沉睡版"]` 一致；替换语义生效（2→1 项）；列表视图 `states` 字段透出；迁移幂等（ensureColumn characters.states 双库同款）。
- **✅ 通过**

### #7 DOM 六要素——无头 Chrome CDP（chips / 批量润色 / 提取入口 / 上传入口 / 项目多选）

- **操作**：系统 Chrome headless + CDP WebSocket 直连（M12 先例）打开 `/entities`、`/style-presets`、`/projects/10` 三页，实点核对并截图。
- **证据**：脚本 **22/22 全过**：①素材甲卡片 states chips「雨夜发光版」「晴天沉睡版」+ 徽标「项目#10」+「2 张定妆照」+ 缩略图；②批量润色按钮 0→1→2（勾选甲、乙）且可用 + `.picked` ×2；③预设列表含「M13 实弹·提取预设」+ snippet 透出；④新建预设弹窗提取区（标题「从参考图提取画风词（可选）」+ 未选项目时按钮禁用 + 选项目后 98 张缩略图 + 「参考图（已选 0/4）」）；⑤素材编辑弹窗（states 预填两行 + 「上传新图」入口 + 已选 2 张）；⑥项目编辑弹窗预设多选回填 2 项勾选。截图 6 张存留：`apps/web/tmp-m13-dom-1..6-*.png`。
- **✅ 通过**

---

## 静态与探针（spec §6.1 / §6.2 / §6.4）

- **typecheck**：server `npm run typecheck` 0 错误；web `vue-tsc` 0 错误。
- **`probe:m13` 七节 121 项断言全绿**（隔离临时库，零网络零计费）：style-multi（数组键去重保序 / 单值回退 / 显式清空 / 坏 JSON / combine 拼接 / 停用跳过 / M8 等价注入）/ vision（fetch stub 断言请求体多模态 content 数组 + `image_url` data URI；解析矩阵（全角/半角/围栏/回退/cap 400）；资产校验失败路径）/ video-refs（`collectSetRefAssetIds` 矩阵 + `planVideoRefs` 四分支 + 空集优先）/ upload（201 追加 / sha256 复用 / 并集 / 全局 400 / 非图 400 / 空文件 400 / 404 / 413 / 幂等）/ polish（`parsePolishOutput` 矩阵 / 批量 2 成功 1 失败混合容错 / 全局实体跳过用量 / 上限与去重）/ states（迁移幂等 / 覆盖语义矩阵 / normalizeSpec / PUT 替换与清空 / 坏 JSON / scene 忽略 / 400）/ regression。
- **回归**：`probe:m7 / probe:m8 / probe:m10 / probe:m11 / probe:m12` 全绿（= spec §6.2-7 定义回归集；覆盖 M8 注入签名 / M10 上传通道 / M11·M12 既有调用方的零漂移）。
- **越界核查（§6.4）**：`git status` 核查——engine / refs / loader / workspace/templates 零 diff；adapters 仅 +`referenceImages` 能力位（×3 适配器 + 类型）；`schema.ts` 仅 +`states` 列（设计 §5 白名单内）+ `db/index.ts` 幂等迁移 +1 行；package.json 仅 +`probe:m13` 脚本、dependencies 零新增。改动面 = 工作区合计 21 改（976+/69−）+ 10 未跟踪（4 新件 + 6 截图）；其中代码 20 改（946+/69−）+ 4 新件（`entity-polish.ts` / `probe-m13.ts` / 提示词 `style-extract.md` · `entity-polish.md`），文档 README +30 行（能力速览 + 验收快照）。

---

## 偏差与修复记录

1. **运行服务为旧代码（交付前）**：3001 端口曾被旧 `npm run start` 进程占用（M13 路由 404）；杀进程链后以 `npm run dev`（watch）重启并验证路由装载。属验收基建，非产品缺陷。
2. **实弹脚本 s4 断言口径两次修正**：①初版预期 `frame_first`，但当前 provider（pollinations_video）能力 none → 真实结果 `no_cap` 降级 → 断言改为匹配真实决策行（「不支持参考图注入」/「首帧优先」双允许）；②产出断言时序缺陷（params 旧值导致轮询立即满足、任务仍在执行）→ 改为「succeeded 且 `result_asset_id` 变化」后通过。属验收脚本口径，非产品缺陷。
3. **实弹脚本安全口径**：`execSync` 触发安全扫描告警 → 改 `execFileSync(ffmpegPath, [argv...])`。属脚本安全。
4. **DOM 验收基建（Browser MCP → CDP）**：browser-use MCP 传输故障 → 改用系统 Chrome headless + CDP WebSocket 直连（M12 先例）；脚本因 Chrome 子进程句柄未释放导致进程超时退出（验证输出与 6 张截图已全量产出，**22/22 断言零失败**）→ 事后 `taskkill /T /F` 清理进程树与临时 profile。属验收基建，非产品缺陷。
5. **探针临时目录清理提示**：Windows libsql 句柄导致隔离临时目录偶发未完全清理（探针既有提示，下次运行自动清理），非本批引入。

本批**未发现产品级缺陷**（实弹过程全部为验收脚本口径与基建修正）。

---

## 局限与备注

- **③ `frame_first` / `ok` 分支未实弹出现**：当前项目 10 provider = pollinations_video（能力 none），真实链路命中 `no_cap` 降级（有日志与快照为证）；四分支逻辑由探针锁定，换 volcengine / minimax / aliyun-wan 实例后即可实弹激活（通道 M6 已备、适配器能力位本批已标）。
- 按设计 §1.3 明确排除（不做，非缺陷）：提取结果自动落库、预设级联删除保护、视频侧角色参考图（首帧承载）、视频侧场景/道具文本锚定注入、状态变体运行时注入（变体出图）、润色版本历史 / 撤销、素材页全量多选批量操作、多模态历史消息。
- 验收留存物：预设 #2「M13 实弹·提取预设」、素材甲 #54（states 2 项 + refAssetIds [801,1155]）/ 素材乙 #55、资产 #1155 保留于项目 10（供 Web 端验收查看）；DOM 截图 6 张保留于 `apps/web/tmp-m13-dom-1..6-*.png`；全部临时脚本 / 中间产物 / Chrome profile 已清理。

---

## 附录

### A. 实弹证据索引（项目 10）

| 检查点 | 载体 | 关键证据 |
|---|---|---|
| ① 提取 | `POST /style-presets/extract`（933/935） | snippet「（画风：电影感写实3D渲染,…）」+ deepseek_llm/deepseek-flash → 预设 #2 |
| ⑦ 单值兼容 | Run 98 s01 重跑 | `params.stylePresetIds=[1]` + 尾缀逐字不变 + #1059→#1150 |
| ② 多预设 | Run 98 s02 重跑 | `params.stylePresetIds=[1,2]` + 尾缀「A；B」+ #1151 |
| ③ 视频参考图 | Run 97 s16 重跑 | `params.setRefAssetIds=[797,798]` + ff=1005 保留 + no_cap 降级日志 + #1153→#1154 |
| ④ 上传 | `POST /entities/54/ref-images` | asset#1155 purpose=reference_character + refs [801,1155] + 文件落盘 |
| ⑤ 润色 | `POST /entities/polish {54,55}` | polished=2 / failed=0 + usage +4 行 |
| ⑥ states | `PUT /entities/54` | 读回/DB 一致 + 替换语义 + 列表透出 |
| DOM 六要素 | 无头 Chrome CDP | 22/22 + 6 张截图 |

### B. 验证命令样例

```powershell
curl.exe -X POST http://127.0.0.1:3001/api/v1/style-presets/extract -H "content-type: application/json" -d "{\"project_id\":10,\"asset_ids\":[933,935]}"
curl.exe -X POST http://127.0.0.1:3001/api/v1/entities/polish -H "content-type: application/json" -d "{\"ids\":[54,55]}"
curl.exe -X PUT http://127.0.0.1:3001/api/v1/entities/54 -H "content-type: application/json" -d "{\"states\":[\"雨夜发光版\",\"晴天沉睡版\"]}"
curl.exe -X POST http://127.0.0.1:3001/api/v1/runs/97/shots/regenerate -H "content-type: application/json" -d "{\"step_key\":\"gen_motion\",\"shot_id\":\"s16\"}"
pnpm --filter @acs/server probe:m13
```

## 验证方式（已完结）

实弹采集：项目 10（m8-实弹验收）——Run 97/98 七项全链（真实视觉提取 / 图片重跑 / 视频重跑 / 真实上传 / 真实润色 / states）+ gen_task params 快照 + DB 逐值 + 运行日志 + 无头 Chrome CDP DOM 22/22；探针为隔离临时库 121 项断言；回归 m7/m8/m10/m11/m12。全部临时脚本与中间产物（tmp-m13-*）随交付清理；预设 #2 / 素材 #54·#55 / 资产 #1155 与 6 张 DOM 截图保留供验收。文档同批交付：本 review + roadmap `M13 注记` + README `M13 能力速览 / 验收快照`。
