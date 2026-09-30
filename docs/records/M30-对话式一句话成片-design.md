# M30 设计（L1 spec）— 对话式一句话成片

> **归档戳（2026-09-30）**：对应功能已交付并过门禁，本稿为落笔即冻结的立项/决策依据快照（非待办）。逐期覆盖与交付状态查 [索引](README.md)；现状以 docs/milestones.md 为准。

- 状态：实施中，用户已批准实施方案；不修改 IDE 保存的原计划文件。
- 来源：post-M27 backlog R07 的「新建单条视频」子集。M29 保留版本追踪语义，R07 其余及 R03–R09 保留待办。
- 目标：用户描述想法，确认一次方案后获得 30–60 秒中文旁白多镜头短视频。动态优先、图文明确标识，不静默降级。

## 模块与边界

| 模块 | 责任 | 依赖 |
|---|---|---|
| video-recipe | Zod 可执行计划、多镜模板、实例冻结、严格音画字交付 | 现有 action/资产 |
| chat-plan | 持久化会话、至多两问澄清、结构化方案修订 | video-recipe |
| safe-execution | 同源预检、事务幂等启动、取消/恢复/真实状态投影 | 前两者及 run/task |
| creator-ui | /create 对话、方案、进度、结果和专业入口 | 服务端 API |

实施顺序：契约/模板 → 会话/执行 → 隔离探针 → 前端 → 全链验证。

## video-recipe 契约

- 默认 9:16、中文、30 秒、约 6 镜，最多 12 镜；科普/故事/产品介绍。每镜稳定 ID、时长、图像提示、运动提示、台词 ID；台词全覆盖且仅映射一次。结构非法、截断或超过上限不可确认。
- `workspace/templates/easy-video.yaml` 直接消费已批准脚本/台词/分镜文本资产。流程和规划提示词外置，不允许模型输出执行代码、路径或任意工具调用。
- 动态走首帧图生视频；模型明确不支持时方案明示文生视频。未知模型时长/首帧能力标待验证并阻止付费执行，可在实例 extra 声明经核实的能力，不按模型名推断。
- TTS 先执行并核验逐镜时长，成功台词可复用；媒体自动重试为零。在途不确定请求不得自动重发。
- `ffmpeg_merge` 严格模式显式启用：完整镜头/媒体可解码，固定镜长，视频 trim/setpts，尾帧最多补 0.5 秒；台词不截断、字幕不越界、直接切镜。旧模式默认不变。
- 输出 MP4/封面/字幕/脚本；通过技术交付检查才显示完成，不保证内容质量及事实准确性。

## chat-plan / safe-execution 契约

- 仅新增 `creation_sessions`、`creation_messages` 两表，Drizzle/SQLite 加法迁移。会话保存项目、当前/批准方案、revision/hash、预检快照、启动键、runId、控制态；消息完整保存、请求键唯一去重。
- 首次发送创建普通项目草稿；对话费用记录项目及 sessionId。当前方案＋有界最近对话用于规划，非流式真实等待态；失败不自动模型修复。
- `/api/v1/creation-sessions` 提供创建/列表/详情/消息/预检/确认/取消/重试。确认携带 planRevision、planHash、idempotencyKey；旧版冲突。事务中比较版本、认领请求、创建并关联 run，提交后启动 engine。
- 制作状态从 run/step/task 派生；Socket 通知＋HTTP 重拉。重启对账，在途未明示失败的请求标需核验。重试显式操作、复用成功任务，关联新 run 并保留来源链。
- 预检与执行固定同一配置实例和有效参数；只保存无密钥的实例引用/指纹/白名单参数。禁用或配置变化暂停，不切换默认实例。项目软删禁止执行，purge 级联消息；资产核验项目归属/删除状态/类型。
- 分开显示规划已发生费用、预计制作费用、未计价项；未知价必须明确接受。按请求视频秒数而非成片秒数计费。创建/重试均检查项目及全局月度/总预算，预计越界独立于告警阈值。
- 执行中修改仅暂存建议；完成后复制需求新建会话并再次确认。取消停止后续提交，在途可能计费。

## creator-ui 契约

- 新增 `/create`、`/create/:id`；保留 `/` 和旧链接。轻松创作导航优先，专业导航收为专业工作台；设置与返回始终可达。
- `views/easy-create/` 下拆分 ConversationPanel、CreationPlanCard、CreationProgress、CreationResult；API/types 分领域。
- 对话＋计划/结果卡，窄屏上下排列；一阶段一个主操作；实际模型、费用和未知项可见，脚本分镜可展开；播放器、MP4、发布包、专业工作台入口。
- 沿用紫靛 token、原生 CSS、现有按钮/图标；键盘、焦点、读屏、reduced-motion、过期异步响应保护。

## 工程与验证

技术栈：TypeScript / Hono / Drizzle / SQLite / Zod / Vue 3 / Vite / Socket.IO / ffmpeg；不增加重型依赖。

目录：服务 `apps/server/src/services/creation-chat/`，路由 `routes/creation-chat.ts`；探针 `apps/server/scripts/probe-m30.ts` 及分节；规格/验收沿用 `docs/superpowers/specs/`。

风格：领域小文件，单文件 ≤800 行，类型显式，沿用两空格/单引号/无分号，例如：

```ts
export function planHash(plan: CreationPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex')
}
```

从项目根执行：

```sh
pnpm --filter @acs/server exec tsx scripts/probe-m30.ts
pnpm ci:check
pnpm --filter @acs/web build
```

隔离库＋模拟供应商＋本地媒体覆盖：默认/澄清/非法计划；确认前零媒体；并发幂等/旧版冲突；缺配置/实例变化/未知能力/ffmpeg/未知价/预算；动态及图文 MP4；缺镜/损坏/不足时长/错映射；刷新/重启/取消/恢复；跨项目及密钥不泄漏；旧合成回归。

浏览器验收桌面/窄屏、一次确认、专业回跳。真实动态和图文样片需要另行明确模型及预算授权，离线绿不替代真实质量验收。

## 实施纪律

- Always：保留工作区既有修改、加法迁移、服务端→探针→前端、如实记录未通过门禁、收口写验收并校准 roadmap。
- Ask first：付费实弹、新依赖/新表超出两张、范围扩展。
- Never：修改生产数据做破坏性测试、自动发布/采购/克隆声音、未经请求 commit/push、平行调度引擎、静默降级、全局免审或自动付费重试。
