# M62 L1 Spec — 轻松创作路由信号扩展（混剪 → photo-montage；小说改编 → novel-adapt）

> **状态：~~待用户评审批准；未获批不改业务代码~~ → 已批准已交付（用户「开始执行」，2026-10-08 当日全量门禁全绿，验收快照见 docs/acceptance.md）。** 构建在 M57（智能载体路由）/ M53–M54（混剪线）/ M09（小说改编链）之上，不推翻其契约。
> 前置复核：编号以最新 roadmap 为准（现有探针最高 `probe-m61` 且已交付；本项独立取 **M62**）。
> 归档戳（2026-10-08）：本稿获批实施后正文冻结（除实测推翻假设的划线修正与实施补注：[M62-split] 既存红线恢复），交付状态已回写 [索引](README.md)、docs/milestones.md 与 docs/acceptance.md。
> 红线：**0 新表 0 新列 / 0 新增 action / 0 新付费面 / ~~0 Web 改动~~ 机制面 0 Web 改动（[M62-split] 授权红线恢复拆分 1 处，见 §七）/ 0 模板改动**；建议仍为非阻断（Tier B），绝不自动改出片模板、不自动建专业项目/起 run；不破坏 M57「确定性纯函数派生、不进 planHash」机制。

## 一、背景（用户实测缺口：两条专业能力在对话内没有方向出口）

M57 建立 routeHint 确定性路由器后，白名单为五目标：`series-setup / mengbao-episode / video-reverse / image-reverse / video-plan`。经本轮全量审计（route-hint.ts 全文 / 前端渲染分支 / probe-m57 反例逐条），确认两条真实缺口：

- **整本小说改编**：用户说「把《X》小说改编成短剧」时，若不含「连载/多集/第N集」字样则命中不了任何信号 → 无建议；即使含「连载」字样也只建议 `series-setup`（系列立项），而整本小说的正确入口是先走 `novel-adapt`（切章→事件图谱→分集规划→逐集剧本，其 `next:[series-setup]` 天然接力）。
- **现成素材拼片**：用户「选 N 张参考图 + 说把这些图片合成一个视频」时，反推措辞真源（`REVERSE_INTENT_WORDS`）不含「合成/拼成/做成」→ 无建议；且对话内参考图只作生成约束/首帧（不是拼片原料），真正「以图为素材直接拼成片」是 `photo-montage`（M53/M54），无任何出口。

即：能力在（两模板真源在位），对话内无桥。本项只补**信号**（方向建议），不搬能力。

## 二、方案决策（自行拍板，附理由）

| 决策点 | 选择 | 理由 / 已否决替代 |
|---|---|---|
| 路由形态 | 沿用 M57 确定性纯函数：白名单 +2 目标（`novel-adapt`、`photo-montage`） | 已否决复用 `template-recommend` embedding——M57 §零已定双向隔离红线；信号是有限枚举词表，纯函数可穷举断言 |
| 能力归属 | 仍归专业链（`novel-adapt` scene=plan 需小说文件 / `photo-montage` scene=produce 需素材文件）；轻松创作不新增改编/拼片能力 | 已否决把整本改编或拼片做进 easy-*（违背轻量执行器本质与成本不变量） |
| 承接形态 | 仅建议条（非阻断）：「这更像〈模板名〉」+ 理由 + 展开指专业端建项目；本次执行载体不变 | 沿用 M57/M56 先例；已否决自动跳转建项目 / 自动起专业 run |
| 前端 | ~~**0 改动**~~ **机制面 0 改动**（[M62-split] 授权拆分 1 处，见 §七）：`CreationRouteHint.vue` 已按 `graduable`（仅 series/mengbao）分流，其余目标走通用分支「到专业端用〈模板〉建项目」 | 两新目标天然落入通用分支；label 由 sanitize 按模板真源回填，无需前端枚举 |

## 三、信号设计（有界、可解释、防误报）

判定表（`detect` 自上而下取首个命中；「序」即最终优先级）：

| 序 | 信号 | 条件 | 目标 | 理由文案（≤80 字，探针断言） |
|---|---|---|---|---|
| 1 | 整本小说改编（**新增**） | `wantsNovelAdapt(text)`（复合判定见下） | `novel-adapt` | 你做的是小说改编：专业链按章节切分→事件图谱→分集规划→逐集剧本，再接力连载立项；轻成片只产单条短片。 |
| 2 | 连载意图（原 1，不动） | 连载/多集/续集/分集/第 N 集 | `series-setup` | 原文案不动 |
| 3 | 多角色短剧质感（原 2，不动） | 对手戏/定妆/形象一致/… | `mengbao-episode` | 原文案不动 |
| 4 | 视频反推（原 3，不动） | hasVideoContentRef + vision + 反推词 | `video-reverse` | 原文案不动 |
| 5 | 图片反推（原 3b，不动） | hasImageRef + vision + 反推词 | `image-reverse` | 原文案不动 |
| 6 | 素材拼片/相册（**新增**） | `wantsPhotoMontage(text, hasImageRef)`（复合判定见下） | `photo-montage` | 你要把现成照片/片段直接拼成成片：专业混剪链以原素材为画面（缓推/拼贴/BGM/字卡），不重新生成画面。 |
| 7 | 超总时长上限（原 4，不动） | >90s（阈值随 `PLAN_DURATION_MAX` 同步，M59 机制） | `video-plan` | 原文案不动 |

**优先级三处关键定序（附反例）**：

1. **novel-adapt 置顶于连载**：「把这部小说改编成连载短剧」同时命中 1/2 → 取 novel-adapt（整本改编的正确入口；其 next 即 series-setup 已覆盖连载接力）；「改编成连载短剧」无小说字样 → 仍走 series-setup（零回归）。
2. **混剪置于 image-reverse 之后**：「把这些图反推提示词」带反推词 → 仍 image-reverse 优先（反推是参考图的第一用途）；无反推词才轮到混剪。
3. **混剪置于超时长之前**：「做个 3 分钟的相册视频」不得误路由 `video-plan`（策划链面向叙事片，混剪无 90s 上限语义）；纯叙事超时长（「3 分钟的故事短片」）仍走 video-plan（零回归）。

**复合判定（新纯函数，随文件内注释留档）**：

```ts
/** 「整本小说改编」：小说/原著/网文 + 改编动作 复合判定；片段/梗概类排除（有节选走轻成片即可） */
function wantsNovelAdapt(text: string): boolean {
  if (includes(text, '片段', '梗概', '选段', '简介')) return false
  const isNovel = includes(text, '小说', '原著', '网文')
  const isAdapt = includes(text, '改编', '改写成', '改成短剧', '改成剧本', '改剧本', '转剧本', '转成剧本', '剧本化', '拆章', '切章', '章节切分', '分集剧本', '改成连载')
  return isNovel && isAdapt
}

/** 「混剪/相册片」强词（无需其他前置） */
const MONTAGE_INTENT_WORDS = ['混剪', '电子相册', '纪念相册', '音乐相册', '相册视频', '相册短片', '照片拼', '拼照片', '照片配乐', '照片配音乐'] as const
/** 弱词（须已采纳图片参考 + 文本含图/照片/素材：防「把这段文案做成视频」误报） */
const MONTAGE_WEAK_RE = /(合成|拼成|做成|变成|合到|拼到).{0,4}(视频|短片|成片)/
function wantsPhotoMontage(text: string, hasImageRef: boolean): boolean {
  if (includes(text, ...MONTAGE_INTENT_WORDS)) return true
  return hasImageRef && includes(text, '图', '照片', '素材') && MONTAGE_WEAK_RE.test(text)
}
```

**词表取舍留档**：`婚宴/年会/大屏` 等场景词不入表（「写个婚宴致辞」会误报）；`拼贴` 不入强词（「拼贴艺术风」会误报）；裸 `相册` 不入表（「做成相册」语义歧义，保守不猜）。

**契约承接**：`ROUTE_TARGETS` 增两键后，`routableLabel`（∈白名单 + 模板存在 + 非批准链）与 `sanitizeRouteHint` 现有校验直接放行，label 自动取真名（`小说改编·切分→图谱→剧本` / `素材混剪成片`）；routeHint 仍只存 assistant 方案消息 payload → 结构上不可能进 plan → 不进 planHash（M57 不变式原样保持）。

## 四、同类入口收口清单（全量审计，一次收口）

| 入口 / 消费点 | 动作 |
|---|---|
| `route-hint.ts` | **本次唯一服务端改动**：白名单 +2 / `detect` +2 信号 / 文件头注释同步（「新增信号必须同步 probe-m57/m62 断言」） |
| `planning.ts`（deriveRouteHint 接线） | 零改动（`userText` / `hasImageRef` / `hasVision` 参数已在位） |
| `CreationRouteHint.vue` / `CreationPlanCard.vue` | 零改动（通用分支已覆盖非毕业目标；`target: string` 无枚举型） |
| `web/src/lib/types/creation-chat.ts` | 零改动（`target: string`） |
| `probe-m57.ts` | 回归零改动（反例逐条核对：`把这张图配段旁白做成 30 秒短片` 无 hasImageRef 且缺「图/照片/素材」前置 → 仍 null；其余信号零冲突） |
| `run-probes.ts`（CI 发现） | 零改动（`readdirSync` 自动发现 `probe-*.ts`，新探针命名即注册） |
| docs（README 索引 / milestones / acceptance / roadmap） | roadmap 队列即时登记（见 §七）；索引行获批后回写；速览与验收交付时回写 |

## 五、探针（`scripts/probe-m62.ts`，新建；零网络零计费）

`isolatedEnv('m62', { bridge: ['templates'] })` 同 M57，五节：

- **signals**：小说改编三措辞（「小说改编」「原著改编」「网文改成短剧」）→ `novel-adapt`；强混剪词（混剪 / 电子相册 / 相册视频）→ `photo-montage`；弱词正例（`hasImageRef` + 「把这些图片合成一个视频」/「照片拼成视频」）→ `photo-montage`；反例锁：含「片段/梗概」排除 → null、「讲个小说风格的故事」→ null、「把这段文案做成视频」→ null。
- **priority**：小说+连载 → `novel-adapt`；反推词+拼片词 → `image-reverse`；「3 分钟相册」→ `photo-montage`（先于超时长）；「3 分钟故事片」→ `video-plan`（零回归）。
- **gating**：弱词无 `hasImageRef` → null；有 `hasImageRef` 但无「图/照片/素材」字样 → null（双前置防线）。
- **sanitize**：两新目标 label 按真源回填；`easy-*` 目标仍被拒（回归锁）。
- **drift**：**全部 7 目标**在真源在位且非批准链（M57 漂移循环只覆盖 4 个，本项起一次性全量）；`creationPlanSchema` strict 拒 `routeHint` 键（不进 planHash 不变式回归）。

门禁：`probe-m62` 全绿 + `probe-m57/m58/m59/m56` 回归绿 + 双端 `tsc`/`vue-tsc` exit 0 + `pnpm probe:ci` 串行全量。

## 六、边界与遗留

- **不做**：自动跳转建项目 / 自动起专业 run（仅建议条）；不搬整本改编或拼片能力进 easy-*；不改 `template-recommend` 双向隔离；不在白名单外加任何新目标。
- **已接受边角**：单图 + 「做成视频」且文本含「图」字样会出混剪建议（单图 Ken Burns 亦是 photo-montage 正当用途；建议非阻断，可接受）；「点评这部小说的改编」类既述表述会误触发（确定性词表的已知代价，探针锁住排除词以外的行为）。
- **误报收口预案**：弱词双前置（图类词 + `hasImageRef`）是核心防线；若上线仍见误报，收口手段=收窄 `MONTAGE_WEAK_RE` 或强词表，**不引入模型判定**（维持零计费纯函数）。

## 七、留档与文档动作

- 已做（本次立项）：roadmap「轻松创作路由信号扩展立项」队列条目登记（状态：待评审）。
- 获批后：`docs/records/README.md` 覆盖总表加 M62 行（设计稿链接 + 待实施状态）。
- 开工时：`plans/M62-计划.md`（T1 route-hint 扩展 + probe-m62 → T2 全量回归 + 双端 typecheck → T3 文档回写）。
- 交付时：`docs/milestones.md` 能力速览 + `docs/acceptance.md` 验收快照 + README/milestones 状态回写。
- **实施补注（2026-10-08，交付）**：机制零偏离——白名单 +2、信号①置顶于连载 / ⑥置于 image-reverse 之后与超时长之前、sanitize/label 真源回填/不进 planHash 全部按 §三/§五 实态交付；`probe-m62` 33 断言全绿、回归 m57/m58/m59/m56 绿、双端 typecheck 绿、终门禁 `pnpm probe:ci` **63 探针 / 5569 断言全绿**。计划外 1 项（[M62-split]，已获用户授权）：门禁首跑发现 m26 split-audit 既存红线（`CanvasBoard.vue` 802>800，HEAD 态非本项引入，git log 定位 `03f64de`），拆出纯静态图例为 `CanvasLegend.vue`（802→764 行，行为零变更）；§二「前端 0 改动」与头部红线表述按实态校准为「机制面 0 改动 + [M62-split] 独立拆分」。
