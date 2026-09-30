# M32 设计（L1 spec）— 能力/默认单一真源表 + 智能默认引擎（Tier A 基建）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 状态：**待用户评审批准；未获批不改业务代码。** 本 spec 是 [平台智能化改造立项纲领（L0.5）](2026-09-19-agencys-content-studio-platform-intelligence-charter.md) 首个里程碑，为 M33–M37 的基建前置。
- 来源：creationCapabilities 设计答疑暴露的根因——**视频模型档位（时长/分辨率/画幅/模式）系统已知三遍，却逼用户逐项勾选核实**。全平台 6 类配置面核查确认此为 Tier A（系统有可信真源）被错放进「用户手填」的典型。
- 目标：把散落在 **适配器实现 / 服务端预检 / 前端表单** 三处的模型档位收敛为**一份单一真源注册表**，并让「轻松创作能力声明」从"用户手填 + 勾已核实"转为"**系统按表自动背书（Tier A）+ 用户预览确认**"。安全线不降：**由系统负责核实、用户负责预览确认**，取代"由用户负责核实"。
- 非目标（明确归属后续里程碑）：实例定价自动带出（→ M33）、模板/运行入参预填（→ M34）、创作流程参数级联与全站下一步建议（→ M35）、运营配置自动化（→ M36）。本里程碑**只做视频能力档位这一条链的真源收敛**，作为其余 Tier A 改造的范式与地基。

## 一、现状：同一份档位知识写三遍（三处漂移源）

| 位置 | 文件 | 承载内容 | 角色 |
|---|---|---|---|
| ① 适配器实现（真源） | [minimax-video.ts normalizeDuration/Resolution](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/adapters/minimax-video.ts#L150-L162)、[volcengine-video.ts](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/adapters/volcengine-video.ts#L107-L149) | 实际下发/归一的时长与分辨率 | **真正约束请求体的地方** |
| ② 服务端预检 | [preflight.ts assertAdapterDurations](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/services/creation-chat/preflight.ts#L44-L53) | _again_ 硬编码 4–15 / 5,10,15 / ≥2 / 单时长 | 校验用户声明合法性 |
| ③ 前端表单 | [ApiConfigForm.vue applyCapsPreset](file:///d:/work/AI/Agent/agencys-content-studio/apps/web/src/components/config/ApiConfigForm.vue#L163-L193) + [capsHint](file:///d:/work/AI/Agent/agencys-content-studio/apps/web/src/components/config/ApiConfigForm.vue#L57-L75) |  Again 硬编码每供应商预填值与提示文案 | 生成用户要手填的初始值 |

三处各自维护、易自相矛盾；且适配器层**已有** `readonly firstFrame` / `readonly referenceImages` 作为"能力的唯一事实源"范式（[types.ts](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/adapters/types.ts#L75-L89)）—— M32 即把该范式**扩展到数值档位**，并新增前端可消费的真源，消除 ②③ 的重复。

## 二、单一真源注册表（服务端新目录）

新增 `apps/server/src/adapters/video-capabilities.ts`，导出一个纯数据 + 纯函数的档位表，作为 ①②③ 唯一上游真源：

```ts
export interface VideoModelCaps {
  modes: Array<'i2v' | 't2v'>
  durations: number[]            // 合法档位，升序去重（预检按此就近取档）
  aspectRatios: Array<'9:16' | '16:9' | '1:1'>
  resolutions: Array<'480p' | '720p' | '1080p' | '768P' | '2K'>
  defaultDuration: number        // Tier A 预填：推荐起点秒数
  defaultResolution: '480p' | '720p' | '1080p' | '768P' | '2K'
  modelScoped?: boolean          // true = 同供应商不同模型档位不同（pollinations/siliconflow）
}
/** 依 providerKey + model 解析档位；命中已知返回背书 Caps，未命中返回 null（不猜、不回退默认）。 */
export function resolveVideoCaps(providerKey: string, model: string): VideoModelCaps | null
/** 归一函数（供适配器与预检共用，消除 ①②重复）：越界时长就近取档、分辨率归一。 */
export function normalizeCaps(caps: VideoModelCaps, in_: { duration?: number; resolution?: string }): { duration: number; resolution: string }
```

初始档位（逐条来自现有 ①②③ 实测约束，**不新增猜测**；`modelScoped` 项按 model 正则分流）：

| providerKey | modes | durations | resolutions | 默认 | 备注 |
|---|---|---|---|---|---|
| `minimax_video` | i2v,t2v | 4–15 逐秒 | 768P,2K | 5s / 768P | 480p/720p→768P，1080p/2K→2K |
| `volcengine_video` | i2v,t2v | 4–15 逐秒 | 480p,720p | 5s / 720p | 1080p 收敛 720p |
| `aliyun_wan_video` | i2v,t2v | ≥2（2–30） | 480p,720p,1080p | 5s / 720p | |
| `siliconflow_video` | 依模型 | 单一固定产出时长 | 480p,720p,1080p | 4s / 720p | modelScoped：不下发 duration，仅声明一个核实值；i2v 需模型名含 I2V |
| `pollinations_video` | t2v | minimax 系：5,10,15；其余：5,10 | minimax 系：480p；其余：720p | 5s | modelScoped：网关同步长请求，不支持首帧注入（无 i2v） |

> 未列供应商 / 未命中：`resolveVideoCaps` 返回 `null`，走"未核实须显式声明"原路径（fail-closed，不猜）。

## 三、三处接线改造（消除重复）

### ① 适配器（真源落地）
- `VideoAdapter` 接口增可选 `readonly capabilities?: VideoModelCaps`（声明式），或在 `generate` 内改为调用 `resolveVideoCaps(this.provider, model)` + `normalizeCaps(...)`。
- minimax / volcengine 现有 `normalizeDuration` / `normalizeResolution` 分支改为**委托 `normalizeCaps`**，删除本地魔法数（4/15/768P/2K），使 ① 成为注册表的**消费者**而非平行真源。
- 保持既有 `firstFrame` / `referenceImages` 声明不变（i2v 能力仍由 `capabilities.modes` 与 `firstFrame` 联合决定，见 §四预检）。

### ② 服务端预检（真源背书）
- [preflightPlan](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/services/creation-chat/preflight.ts#L55-L96) 内 `dynamic` 分支改为：
  1. 若实例存 `extra.creationCapabilities` 且 `model === video.model` → **沿用现校验**（后向兼容既有 run 与探针）；
  2. 否则调用 `resolveVideoCaps(providerKey, model)`：命中 → 以此 Caps 为**已背书能力**继续（不再报 `capabilities_unverified`）；未命中 → 保持原 `capabilities_unverified` 错误（提示改为"该模型暂无平台背书档位，请在扩展参数手动声明或更换模型"）。
- `assertAdapterDurations` 的三条硬编码分支删除，改由 §四"档位合法性 = `resolveVideoCaps` 命中即合法"统一判定（就近取档用 `normalizeCaps`）。
- **不静默降级红线不变**：能力不支持 i2v 且方案含 first_frame → 仍 `first_frame_unsupported` 停机；分辨率越界仍按现有归一。

### ③ 前端（Tier A 自动，去「已核实」勾选）
- 新端点 `GET /api/v1/api-configs/video-caps?provider_key=&model=`（[routes/api-configs.ts](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/routes/api-configs.ts) 加只读路由）：内部 `resolveVideoCaps` 返回 Caps 或 `{supported:false}`。
- [ApiConfigForm.vue](file:///d:/work/AI/Agent/agencys-content-studio/apps/web/src/components/config/ApiConfigForm.vue) 视频区块改造：
  - 选择 provider + model 后**自动拉 caps**；命中 → 能力声明区**只读展示**"✓ 由平台适配器背书"的档位（时长/画幅/分辨率/模式），**移除 `已核实` 勾选框**（`capsVerified` 及其 watch），保存时若用户未改动则不写 `creationCapabilities`（由后端 §四自动按表背书）。
  - 未命中（`supported:false`）→ 回退为**现有可编辑手填表单 + 已核实勾选**（保留 Tier C 兜底，不逼用户对未知模型假称核实）。
  - `applyCapsPreset` / `capsHint` 的**硬编码内容删除**，改为渲染 caps 端点返回值（前端不再自带档位知识）。
  - "同步上方模型 / 复制到能力声明"等消除手误的按钮：命中态无需（后端按 `video.model` 背书）；仅未命中手填态保留。

## 四、i2v / 首帧联合判定（沿用现语义，仅真源换表）

预检 `videoMode` 决策保持不变：`caps.modes 含 i2v` **且** `adapter.firstFrame === 'base64'` 才 `i2v`，否则 `t2v`，都无则 `none` 报错。`caps` 现来自 §三.②（存储或 `resolveVideoCaps`）。siliconflow 的 "i2v 需模型名含 I2V" 由 `resolveVideoCaps` 的 modelScoped 分支编码（未命中 I2V 则 caps.modes 不含 i2v），前端与预检同源。

## 五、实施顺序（服务端 → 探针 → 前端；每 Task 后 typecheck 全绿）

- **T1（服务端真源）**：新增 `video-capabilities.ts`（Caps 表 + `resolveVideoCaps` + `normalizeCaps`）；minimax/volcengine 适配器改为委托；`tsc` 全绿。
- **T2（预检接线）**：preflight `dynamic` 分支按 §三.② 改造，删 `assertAdapterDurations` 硬编码；`tsc` 全绿。
- **T3（caps 端点）**：`routes/api-configs.ts` 加 `GET /video-caps`；`tsc` 全绿。
- **T4（探针门禁）**：新增 `scripts/probe-m32.ts` + 扩写 `probe-m30` 相关断言（见 §六）；`pnpm --filter @acs/server exec tsx scripts/probe-m32.ts` 与 `probe-m30`/`probe-m31` 全绿。
- **T5（前端）**：ApiConfigForm 去勾选 + 自动拉 caps + 渲染；`pnpm --filter @acs/web build`、`vue-tsc` 全绿。
- **T6（收口）**：`pnpm ci:check` 全绿；更新 [docs/ai-config.md](file:///d:/work/AI/Agent/agencys-content-studio/docs/ai-config.md) 与 [docs/milestones.md](file:///d:/work/AI/Agent/agencys-content-studio/docs/milestones.md) 将 M32 从"立项·未实施"移入"已交付能力速览"；回链本 spec。

## 六、验证策略（零回归为硬门禁）

`probe-m32`（零网络零计费，`isolatedEnv('m32', {bridge:['templates','prompts']})` + 模拟供应商），分节：
- **registry**：`resolveVideoCaps` 对 5 供应商命中档位与旧三处**逐字段等价**（断言 durations/resolutions/modes 与迁移前 `applyCapsPreset`/`assertAdapterDurations` 一致）；未知 provider → null（fail-closed）。
- **preflight**：不写 `creationCapabilities`、仅设 provider+model=minimax → `dynamic` 方案预检 `ready`（Tier A 背书生效）；`caps.model === video.model` 自洽；未命中模型 → 仍 `capabilities_unverified`。
- **equivalence**：对同一 provider+model，"手填 caps"与"按表背书"两条路径的 `execution.videoMode / resolution / requestDurations / estimate.videoSeconds` **完全一致**。
- **no-silent-degrade**：minimax t2v-only 方案含 first_frame → 仍 `first_frame_unsupported`（红线不降）。
- **adapter-normalize**：`normalizeCaps` 对越界时长就近取档、分辨率归一，与旧 `normalizeDuration/Resolution` 逐值一致。

**零回归**：`probe-m30` / `probe-m31` 现有断言（直接 seed `creationCapabilities`）必须全绿——§三.② 保留"显式存储优先"路径正是为此。

## 七、边界（Never / Ask first / Always）

- **Never**：为未命中模型猜档位或回退"通用默认"；取消 i2v/首帧不静默降级停机；改付费执行确认逻辑；密钥进 caps/日志；未经请求 commit/push。
- **Ask first**：新增真实模型档位前需供应商文档或实测背书（不得凭模型名推断）；caps 表若需引入 DB 存储（本 spec 为代码内静态表，如需转 DB 再议）；超出本里程碑范围（定价/模板）的顺手改造。
- **Always**：加法改造；服务端→探针→前端顺序；每 Task typecheck 全绿后推进；如实记录未过门禁；收口写验收并校准纲领/milestones。

## 八、里程碑与 roadmap

- 立项 M32，落地纲领（L0.5）§四路线图的基建项（G1：能力/默认单一真源表 + Tier A 智能默认引擎）。
- 完成后 M33（AI 配置智能化，含定价 Tier A 带出）复用本 `resolveVideoCaps` 范式扩展 `resolveModelPricing`。
- 明确排除：把 caps 迁出到 DB / 远程拉取供应商能力目录（本地静态表 + 未命中手填兜底已足够；远程可编程供应商为纲领排除项）。

## 九、待用户拍板

1. **是否接受 §三.③ 移除「已核实」勾选、改由适配器档位表背书**（把"填错"风险从用户转移到档位表维护；未命中模型仍保留手填 + 勾选兜底）。
2. caps 真源采用**代码内静态表**（本 spec）还是 **DB 表**（可后台维护、迁移成本更高）——默认前者。
3. §五 实施顺序与 §六 零回归门禁是否认可，认可后从 T1 起按门禁实施。
