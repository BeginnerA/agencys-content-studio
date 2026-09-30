# M33 设计（L1 spec）— AI 配置智能化（定价 Tier A 自动带出 + 选中即生成完整实例）

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 状态：**待用户评审批准；未获批不改业务代码。** 本 spec 承接 [平台智能化改造立项纲领（L0.5）](2026-09-19-agencys-content-studio-platform-intelligence-charter.md) §五 M33，落地缺口 **G4（新实例定价需手填、未命中表不带出）** 与 **G5（建实例 model 手动复制、无「选中即生成」）**。
- 前置：M32（能力/默认单一真源表 + Tier A 智能默认引擎）**已交付**（commit `feat(M32)`）。本里程碑**复用 M32 的 `resolveVideoCaps` 范式**扩展到定价（`resolveModelPricing`），并把 M32 仅覆盖「视频能力档位」的 Tier A 自动背书**推广到全部四类服务通道的「建实例」体验**。
- 目标：用户在「AI 配置」页选供应商 + 粘 Key + 选模型后，系统按平台真源**自动生成一份完整实例草稿**——能力档位（视频，M32 已有）+ **定价（本里程碑新增）** + **默认通道建议**——用户只在异常时改；定价未命中平台参考表时才回落手填并明确提示"需核实补录"。
- 非目标（归属后续里程碑）：模板/运行入参预填（→ M34）、项目 `settings.video` 级联与全站下一步建议（→ M35）、运营配置自动化（→ M36）、"自动值来源"可追溯标注 UI 全站化（→ M37，本里程碑仅在定价摘要处给最简来源提示）。

## 一、现状：定价知识齐备却逼用户手填（与 M32 能力档位同构的病）

| 事实 | 位置 | 现状问题 |
|---|---|---|
| 四级定价回退已存在 | [usage.ts `resolveUnitPrice`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/services/usage.ts#L104-L141) | 实例 pricing → 全局 `settings.pricing` → null。**仅用于事后计价，不用于建实例预填** |
| 全局定价表无种子 | [system.ts `PUT /settings/:key`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/routes/system.ts#L73-L75) | `settings.pricing` 只由用户手工维护，新库为空 → 新建实例定价框永远空白 |
| 建实例定价纯手填 | [ApiConfigForm.vue 定价区块](file:///d:/work/AI/Agent/agencys-content-studio/apps/web/src/components/config/ApiConfigForm.vue#L325-L345) | `priceInput`/`priceOutput` 初始恒空，不参考任何真源；单位靠 `pricingUnits` 硬编码提示 |
| 视频能力档位已 Tier A | [VideoCapsEditor.vue](file:///d:/work/AI/Agent/agencys-content-studio/apps/web/src/components/config/VideoCapsEditor.vue) + [video-caps 端点](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/routes/api-configs.ts#L238-L245) | M32 已解决"能力档位手填 + 勾已核实"——**定价是同一病的另一半，M33 收口** |

**根因**：与 M32 一致——系统"知道"的（可核实的参考定价）没有以 Tier A 方式在建实例时带出，而是把"填 + 核实"全推给用户。

## 二、定价单一真源表（服务端新目录，沿用 M32 caps 纪律）

新增 `apps/server/src/adapters/pricing-capabilities.ts`，导出纯数据 + 纯函数，作为建实例定价预填的唯一上游真源：

```ts
import type { UsageKind, UsageUnit } from '../services/usage'
/** 一条已核实的参考定价：单位 → 元/单位（含基数，如 llm 元/百万 token 直接存原值）。 */
export interface ModelPricing {
  /** 按 unit 索引的参考价（元/计价单位，与 settings.pricing 同基数口径） */
  prices: Partial<Record<UsageUnit, number>>
  /** 来源标注（供应商公开定价页 / 文档锚点），供前端「为何是这个值」提示（M37 前置） */
  source: string
}
/**
 * 依 serviceType + providerKey + model 解析已核实参考定价；
 * 命中返回 ModelPricing（Tier A 背书）；未命中返回 null（fail-closed，须用户手填补录）。
 */
export function resolveModelPricing(
  serviceType: 'llm' | 'image' | 'video' | 'audio',
  providerKey: string,
  model: string,
): ModelPricing | null
```

**纪律（与 M32 §七 完全对齐，不降级）**：
- 仅登记**经供应商公开定价页 / 文档核实**的参考价；不按模型名猜测、不因"看起来常见"就填。
- 未命中 → `null` → 端点返回 `supported:false` → 前端**保持现有手填定价框 + 明确提示"该模型暂无平台参考定价，请核实后手填"**（Tier C 兜底，绝不塞"通用默认价"制造虚假成本可见）。
- 初始登记范围：仅在本次已获用户提供 / 可核实的公开定价来源的条目上落表；**拿不到核实依据的 provider/model 一律不登记**（宁可多回落手填，也不猜）。首批候选（待拍板 §九确认来源后填值）：Pollinations 网关（对免费模型 `prices:{}, source:'pollinations 免费网关'`→ 视作 supported:false 手填更安全）、DeepSeek、通义/豆包等的公开牌价。**具体条目与数值属实施期逐条核实，本 spec 不预填未经核实的数字。**

**与既有成本链路的关系（关键：零漂移）**：
- `resolveModelPricing` **仅作"建实例预填来源"**，**不注入 `resolveUnitPrice` 的事后计价回退链**。计价链路仍是"实例 pricing → 全局 settings.pricing → null"（probe-m4 / usage 回归零触碰）。
- 用户保存实例时，预填值会写入实例 `apiConfigs.pricing`，此后按既有实例级定价生效——**真源表只影响"初始建议"，不改变"实际计费口径"**。

## 三、端点：泛化建议（选中即生成的后端）

保留 M32 的 `GET /api-configs/video-caps`（探针 / 已上线前端向后兼容，不删）。**新增一个跨通道的只读建议端点**：

```
GET /api-configs/model-suggest?provider_key=&model=&service_type=
→ {
    supported: boolean,          // 是否有任一可自动带出的 Tier A 信息
    serviceType, providerKey, model,
    pricing?: { prices, source },// resolveModelPricing 命中时（全通道）
    caps?: VideoModelCaps,       // 仅 video 且 resolveVideoCaps 命中（复用 M32）
    suggestDefault?: boolean     // 该 service_type 下当前无任何实例 → 建议设为默认通道
  }
```

- 内部：`resolveModelPricing(serviceType, providerKey, model)` + （video）`resolveVideoCaps` + 一次 `COUNT apiConfigs WHERE service_type=?` 判 `suggestDefault`。
- `supported = pricing命中 || caps命中 || suggestDefault`；三者皆无 → `{supported:false}`（前端全手填）。
- **只读、零网络、零计费、零写库**（与 caps 端点同级安全）。

## 四、接线改造（服务端 → 前端）

### 服务端
- 新增 `pricing-capabilities.ts`（§二）。
- `routes/api-configs.ts` 加 `GET /model-suggest`（§三），`import { resolveModelPricing }`、`import { resolveVideoCaps }`（已在）。
- **不动** `resolveUnitPrice` / `recordUsage` / 计价链路（§二零漂移约束）。

### 前端（`ApiConfigForm.vue` + 新子组件，守 ≤800 行红线）
- `lib/types/api.ts` 加 `ModelPricing`、`ModelSuggestResult` 类型；`lib/api/config.ts` 加 `configApi.modelSuggest(providerKey, serviceType, model)`（**经 api 客户端，禁裸 fetch**）。
- 新建子组件 **`PricingSuggest.vue`**（定价区抽出，避免父组件膨胀）：
  - props：`serviceType / providerKey / model / initialPricing / suggested`；watch `[providerKey, serviceType, model]` 拉 `model-suggest`（命中且有 `pricing` → 预填 `prices`，标注 `✓ 平台按〈source〉给出参考定价，可直接修改`；未命中 → 保持手填空框 + `该模型暂无平台参考定价，请核实后手填（否则用量按未计价记录）`）。
  - 编辑态：实例已有 `pricing` → 尊重存量（进"已手填"态，不覆盖），与 M32 VideoCapsEditor 的"stored 优先"对称。
  - 暴露 `buildPricing(): Record<string, number>` 供父提交（等价现 `buildPricing` 逻辑，迁移进子组件）。
- `ApiConfigForm.vue`：
  - 用 `<PricingSuggest v-if="!isVideo || true" ...>` 替换手写定价区（全通道复用），父组件删 `priceInput/priceOutput/buildPricing` 约 40 行 → 净增可控（≤800 复验）。
  - 「选中即生成」：caps（视频）+ pricing 由 model 变化**同批自动带出**，头部给一行汇总提示"已按平台真源生成：能力档位 ✓ / 参考定价 ✓/需补 / 建议设为默认通道 ✓"（最简 M37 前置，不展开可追溯 UI）。
  - `suggestDefault` 命中且为新建：自动勾上"同类型默认实例"（用户可取消）——G5"默认通道建议"。

## 五、实施顺序（服务端 → 探针 → 前端；每 Task 后 typecheck 全绿）

- **T1（服务端真源）**：新增 `pricing-capabilities.ts`（`resolveModelPricing` + 首批已核实条目）；`tsc` 全绿。
- **T2（建议端点）**：`routes/api-configs.ts` 加 `GET /model-suggest`；`tsc` 全绿。
- **T3（探针门禁）**：新增 `scripts/probe-m33.ts`（§六）；`probe:ci` 下 m33 + 回归 m30/m31/m32 + usage/m4 相关探针全绿。
- **T4（前端）**：`PricingSuggest.vue` 抽组件 + `ApiConfigForm.vue` 接线 + `model-suggest` api + 「选中即生成」汇总提示 + `suggestDefault`；`pnpm --filter @acs/web build`、`vue-tsc` 全绿；父/子组件复验 ≤800 行。
- **T5（收口）**：`pnpm ci:check`（如实记录 m26 split-audit 预存在红）；更新 [docs/ai-config.md](file:///d:/work/AI/Agent/agencys-content-studio/docs/ai-config.md) 定价段与 [docs/milestones.md](file:///d:/work/AI/Agent/agencys-content-studio/docs/milestones.md)（M33 从"立项·未实施"移入"已交付能力速览"，路线图收窄 M34–M37）；回链本 spec。

## 六、验证策略（零回归为硬门禁）

`probe-m33`（零网络零计费，`isolatedEnv('m33', {bridge:['templates','prompts']})`），分节：
- **registry**：`resolveModelPricing` 对已核实条目命中期望 `prices`+`source`；未核实 provider/model → `null`（fail-closed，不猜、不回退通用默认）。
- **endpoint**：`GET /model-suggest` 命中态返回 `supported:true` 且含 `pricing`；video 命中态同时含 `caps`；三皆无 → `supported:false`。
- **cost-zero-drift**：新建实例带出预填 pricing 后，`resolveUnitPrice` 仍"实例 > 全局 > null"——断言 `resolveModelPricing` **不参与**事后计价（同 provider/model 无实例 pricing 时仍走全局，命中表也不改变）。
- **no-silent-default**：未核实模型 → 端点 `supported:false`、`pricing` 缺席（前端须手填，不得被塞默认价）。
- **suggestDefault**：目标 service_type 无实例 → `suggestDefault:true`；已有实例 → `false`。

**零回归**：`probe-m30`/`m31`/`m32` 全绿（caps 端点保留不删）；`probe` 计量相关（usage/m4 族）全绿（§二未碰计价链路）。

## 七、边界（Never / Ask first / Always）

- **Never**：为未核实模型猜参考价或回退"通用默认价"；把参考定价注入事后计价链路改变计费口径；未经请求 commit/push；密钥进定价/日志；用裸 fetch 绕过 api 客户端。
- **Ask first**：① **首批登记的 provider/model 与具体数值**——每条须供应商公开定价页 / 文档锚点，落表前在 §九列给用户核对（成本可见，错登记=虚假背书）；② 定价真源采用**代码内静态表**（本 spec，与 M32 caps 同构）还是**DB / 后台可维护**（迁移成本更高，默认前者）；③「选中即生成」自动勾默认通道是否接受（可取消）。
- **Always**：加法改造；服务端→探针→前端顺序；每 Task typecheck 全绿；组件 ≤800 行；如实记录未过门禁（含 m26 split-audit 预存在红）；收口写验收并校准纲领 / milestones。

## 八、里程碑与 roadmap

- 立项 M33，落地纲领 §四 G4 + G5。
- 完成后 M34（模板/运行入参预填）复用本 `model-suggest` 端点形态扩展"入参建议"。
- 明确排除：把远程拉取供应商实时牌价编进真源表（纲领排除项；本地静态核实表 + 未命中手填兜底已足够）。

## 九、待用户拍板

1. **是否接受"平台按已核实参考定价自动带出建实例定价"**（把"填错价"风险从用户转移到平台参考表维护；未核实模型仍保留手填兜底、绝不塞默认价）。
2. **首批登记范围与数值**：建议先只覆盖能拿到公开牌价且已核实的条目（如 DeepSeek / 通义 / 豆包 等 LLM token 价；视频/图像若有公开价一并）。**请确认：(a) 授权我在实施期逐条查公开定价页并列出来源锚点回填、(b) 还是你直接给定首批条目。** 拿不到核实依据的一律留空回落手填。
3. 定价真源用**代码内静态表**（默认，与 M32 同构）还是 **DB 表**；§五 实施顺序与 §六 零回归门禁是否认可，认可后从 T1 起按门禁实施。
