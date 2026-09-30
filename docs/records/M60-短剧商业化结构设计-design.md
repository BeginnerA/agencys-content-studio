# M60 L1 Spec — 短剧商业化结构设计（付费卡点 / 开场钩子 / 留人节奏）

> **状态：已实施并门禁验证（server tsc / web vue-tsc / probe-m3·m8·m11·m56·m57·m60 全绿）。** 建在 `series-setup` v4 / `mengbao-episode` v15 / `creation-plan.md` 之上。
> 前置复核：编号以最新 roadmap 为准（取 M60）。
> 纪律：**0 新表 0 新列 / 0 新增 action / 0 新增付费面**（纯提示词 + 文本契约 + 规划注入层，产出为机读 json + 人读报告的通用文本资产）；不做体裁专属表。
> **定位澄清（用户给定，取代原"需产品定义闸门"）**：付费卡点是**剧情设计思路**——设计"哪一集结尾适合做强悬念收口"的结构标记；**是否真正收费、收费位置由发布平台决定**，设计了卡点不等于一定要付费。因此本项**无产品决策前置门**，不产出任何平台配置/价格/付费门禁阈值，`paywall_candidate`/`free_episode_range`/`paywall_note` 全部是供发布参考的建议标记。

## 一、背景（自我分析发现的缺口，非用户直接诉求）

复核全仓：轻松创作与专业短剧链能"产出一集/一条"，但**完全没有"把多集组织成一部能变现的短剧"的商业结构设计**——grep `卡点/paywall/付费/hook/钩子/留人` 零命中（仅无关误命中）。而付费短剧的行业命门恰是：
- **前 3 秒钩子**（留人，决定完播/转化）；
- **付费卡点**（在哪一集结尾设强悬念收口，撬动付费）；
- **留人节奏 / 情绪曲线**（每集的钩子—冲突—反转—悬念排布）；
- **黄金 N 集**（免费集数与卡点位置的经验结构）。

缺了这层，系统只是"视频生成器"，不是"短剧生产系统"。这是比"时长放宽/模板选择"更根本的专业度缺口，优先级 P1。

## 二、方案决策（自行拍板，分两层落）

| 决策点 | 选择 | 理由 / 已否决替代 |
|---|---|---|
| 承载层 | **在 `series-setup` 分集地图上新增"商业结构"设计步**，产出 `monetization-json`（每集 hook/ending_cliffhanger/paywall 标记） | 分集地图本就是 series 唯一权威（记忆确认 script-ep 以其为准），卡点必须挂在集级结构上才生效；已否决挂单集模板（无全局视角定卡点） |
| 开场钩子 | **`creation-plan.md` / `plan-episodes` 增"开场钩子"约束**：首镜/首集前 3 秒给强钩子，写进 shots 的 image/motion_prompt 与 lines[0] | 钩子要真正影响成片必须落到分镜与台词，不能只在报告里空谈 |
| 阈值来源 | **可配置建议值**：免费区间/卡点集建议/钩子范式走提示词产出或输入参数，不写死 | 商业规则随平台/题材变，写死即错；且卡点仅为设计建议（真实付费归发布平台），无需产品先定口径 |

## 三、服务端设计

### 3.1 新文本契约 `monetization-json`（实施态）
- `{ title, episode_count, free_episode_range:[从,到], positioning_rationale, episodes:[{ ep, opening_hook, ending_cliffhanger, paywall_candidate?:boolean, paywall_note?, rhythm_note }] }`，通用文本资产 + purpose 标签 `monetization`（归档至 `texts` 子目录，0 新目录，不破"不做体裁专属表"红线）。
- 新提示词 `monetize-structure.md`（输入 = `series-setup` 的《系列设定包》+ 集数）产出上述结构，挂在 **`write_series` 之后**（而非"分集地图上新增设计步"的早期表述），带可审阅 gate（`required` + `skip_label=认可通过`），gate 文案显式声明"卡点仅为剧情设计思路、真实付费由发布平台决定"；由 `with_monetization`（bool，默认 true）开关。
- 校验（`validateTextOutput` 新分支）：episodes 非空数组；episode_count 与 episodes.length 一致；集号正整数、不重复、连续覆盖 1..N；`ending_cliffhanger` 必填非空（卡点结构最小承载）；`opening_hook`/`paywall_note` 若提供需非空串；`paywall_candidate` 若提供需布尔。**无任何付费墙阈值/价格校验**（对齐定位澄清）。

### 3.2 注入到生产
- `script-ep` / `storyboard-ep` 规划提示词消费 `monetization-json`：卡点集末镜强制"悬念收口"、首集/首镜强制"开场钩子"、情绪曲线指导节奏。
- 轻松创作侧：`creation-plan.md` 注入"前 3 秒钩子 + 结尾悬念（若该条属连载）"准测，让轻内容也带钩子意识（不改执行器，仅提示层）。

### 3.3 报告透出
- 产出人读"商业结构设计.md"（免费集/卡点位置/每集钩子一览）+ 机读 json 双资产，series 看板可见、可改。

## 四、前端

- 系列看板/`series-setup` 结果区增"商业结构"折叠卡：列出免费集区间、卡点集、逐集钩子/悬念；卡点集打显著标记。
- 轻松创作方案卡：命中连载意图（M57 routeHint=series）时，附"本条将作为第 N 集，钩子/卡点遵循系列商业结构"说明（不阻断）。

## 五、探针（`scripts/probe-m60.ts`，零网络零计费，stubFetch）

- `monetization-json` 契约：合法/越界（paywall 集>总集数、缺 ending_cliffhanger）拒绝；通用文本资产登记不进专属表。
- 注入：卡点集末镜带悬念收口标记、首集首镜带钩子（断言 prompt 组装含相应分片）；阈值来自输入非写死。
- 回归：`series-setup` 未启用商业结构步时行为与 v3 等价（零漂移）；老项目无 `monetization-json` 读取不炸。

## 六、边界与遗留（Ask first）

- **卡点不绑定真实付费**（用户澄清已消解原"需产品先定口径"）：本结构只给"哪一集结尾适合强悬念收口"的剧情设计建议（行业经验档 free_episode_range 为纯建议值、可被项目输入覆盖），是否/在哪收费由发布平台决定；系统不接入任何平台付费配置面。
- 不做真实投放数据回流优化（接 M20 复盘闭环，另议）。
- 不做 A/B 多卡点对比生成（成本面，另议）。
- lip-sync（口型）不在此列：需专门付费模型面，M31 已永久排除，保持 Ask-first。
