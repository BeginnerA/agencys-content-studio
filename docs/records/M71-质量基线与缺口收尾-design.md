# M71 设计规格：质量基线 + M70 缺口收尾

> **状态**：待审核  
> **日期**：2026-11-02  
> **依赖**：M70 已交付（跨集连续性、断点续跑、证据门）  
> **范围**：收尾 M70 四项登记缺口 + 建立 R01 质量基线测量基础设施

## 1. 目标与验收

### 1.1 目标

1. **收尾 M70 缺口**：消除四项已登记但未完成的遗留问题
2. **建立质量基线**：实现可复现的单集质量评分基础设施，为后续 M72-M74 的质量检查与返修闭环提供测量基础

### 1.2 验收标准

**M70 缺口收尾（4 项）**

| # | 缺口 | 验收条件 |
|---|------|---------|
| 1 | 引文漂移分支专测未补 | 新增探针覆盖「删除原引文后零模型复核」路径，断言 409 + 错误信封正确 |
| 2 | templateKey 消费面未识别 | 在 invocation.ts 调用前增加 revalidatePack + material/configHash 比对，任何付费派发前 409 |
| 3 | 草稿删入口未补 | UI 增加删除草稿按钮，后端增加 DELETE /drafts/:id 端点，权限与编辑一致 |
| 4 | personaFile 写死 | roles.ts 的 personaFile 改为从数据库读取，UI 支持编辑角色人设文件引用 |

**R01 质量基线**

| 维度 | 验收条件 |
|------|---------|
| 引文完整度 | 统计单集提取的引文数 / 原作总引文数，输出 0-100 分 |
| 角色一致性 | 复用 M24 评测服务，对比同角色跨镜图片相似度，输出 0-100 分 |
| 剧情连贯度 | 零模型检查跨集状态矛盾（人物关系、道具归属、知识状态），输出矛盾数 + 严重度 |
| 费用效率 | 统计单集实际费用 / 预算上限，输出 0-100 分（100 = 未超预算） |
| 综合质量分 | 四维加权平均（默认权重：引文 0.3 + 一致性 0.3 + 连贯度 0.2 + 费用 0.2） |
| 可复现性 | 记录样本输入、模板/提示词版本、供应商/模型、参数、参考资产版本、实际用量 |
| 实测样本 | 3-5 集连续样本，小批预算，完整结果 + 人工抽检记录 |

**离线验证**

- 全量探针 exit 0（含新增 M71 探针）
- server tsc --noEmit exit 0
- web vue-tsc --noEmit exit 0
- git diff --check exit 0

## 2. 范围与边界

### 2.1 纳入范围

1. **M70 缺口收尾**（4 项，见 §1.2）
2. **质量评分服务**：新增 `eval-quality.ts`，实现四维评分 + 综合分
3. **质量评分端点**：`POST /runs/:id/quality`，触发单集质量评分
4. **质量评分存储**：新增 `quality_scores` 表，存储评分结果 + 元数据
5. **质量评分 UI**：在 run 详情页显示质量分 + 四维雷达图
6. **质量评分探针**：新增 probe-m71，覆盖评分服务 + 端点 + 存储

### 2.2 明确排除

1. **不调用真实付费模型**：质量评分使用零模型检查 + 已有评测结果，不新增模型调用
2. **不改 M70 已交付的连续性逻辑**：只在 M70 基础上增加评分维度
3. **不做多阶段质量检查**（M73 范围）：M71 只做单集评分，不做阶段门禁
4. **不做定向返修**（M72 范围）：M71 只测量，不修复
5. **不做角色一致性工程化**（M74 范围）：M71 只复用 M24 评测，不改参考图管理

### 2.3 依赖与复用

| 依赖 | 复用方式 |
|------|---------|
| M24 评测服务 | `eval-service.ts` 的图片相似度评分 |
| M29 版本链 | `content_versions` / `exec_snapshots` / `exec_inputs` |
| M70 连续性 | `continuity_runs` / `continuity_folds` / `continuity_evidence` |
| M70 证据门 | 引文完整度检查复用 evidence 门逻辑 |
| M26 runner | 确定性回归测试 |

## 3. 架构设计

### 3.1 数据模型

**新增表：`quality_scores`**

```sql
CREATE TABLE quality_scores (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES continuity_runs(id),
  episode_idx INTEGER NOT NULL,
  
  -- 四维评分（0-100）
  citation_score REAL NOT NULL,      -- 引文完整度
  consistencyScore REAL NOT NULL,    -- 角色一致性
  coherenceScore REAL NOT NULL,      -- 剧情连贯度
  costScore REAL NOT NULL,           -- 费用效率
  
  -- 综合分（加权平均）
  overallScore REAL NOT NULL,
  
  -- 元数据
  weights TEXT NOT NULL,             -- JSON: {citation: 0.3, consistency: 0.3, coherence: 0.2, cost: 0.2}
  metadata TEXT NOT NULL,            -- JSON: {templateVersion, promptVersion, model, params, assetVersions}
  
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_quality_scores_run ON quality_scores(run_id);
CREATE UNIQUE INDEX idx_quality_scores_run_episode ON quality_scores(run_id, episode_idx);
```

**设计决策**

- 评分与 run 绑定：一次 run 可评多次（重跑评分不重新生成）
- episode_idx 维度：支持单集评分 + 跨集聚合
- weights 存 JSON：允许用户调整权重（后续 UI 扩展）
- metadata 存 JSON：记录评分时的模板/提示词/模型版本，保证可复现性

### 3.2 服务层

**新增服务：`eval-quality.ts`**

```typescript
export interface QualityScoreInput {
  runId: string;
  episodeIdx: number;
  weights?: {
    citation?: number;
    consistency?: number;
    coherence?: number;
    cost?: number;
  };
}

export interface QualityScoreResult {
  citationScore: number;      // 0-100
  consistencyScore: number;   // 0-100
  coherenceScore: number;     // 0-100
  costScore: number;          // 0-100
  overallScore: number;       // 加权平均
  metadata: {
    templateVersion: string;
    promptVersion: string;
    model: string;
    params: Record<string, any>;
    assetVersions: Record<string, string>;
  };
}

export async function scoreQuality(input: QualityScoreInput): Promise<QualityScoreResult> {
  // 1. 引文完整度：统计 evidence 表的引文数 / 原作总引文数
  // 2. 角色一致性：调用 M24 eval-service 的图片相似度评分
  // 3. 剧情连贯度：零模型检查跨集状态矛盾
  // 4. 费用效率：统计实际费用 / 预算上限
  // 5. 加权平均：按 weights 计算综合分
}
```

**设计决策**

- 四维评分独立计算：每个维度可单独查看 + 聚合
- 零模型检查：剧情连贯度不调用模型，只检查 continuity_folds 的状态矛盾
- 复用 M24：角色一致性直接调用 eval-service，不重新实现
- 可复现性：metadata 记录评分时的所有输入版本

### 3.3 API 层

**新增端点**

```typescript
// 触发单集质量评分
POST /runs/:id/quality
Body: { episodeIdx: number, weights?: {...} }
Response: { score: QualityScoreResult }

// 查询单集质量评分
GET /runs/:id/quality/:episodeIdx
Response: { score: QualityScoreResult, createdAt: string }

// 查询 run 所有集的质量评分
GET /runs/:id/quality
Response: { scores: QualityScoreResult[], episodeCount: number }
```

**设计决策**

- POST 触发评分：评分是计算密集型操作，不放在 GET 里
- GET 查询结果：评分结果缓存，重复查询不重新计算
- 支持权重调整：用户可通过 POST body 调整四维权重

### 3.4 UI 层

**新增组件：`QualityScorePanel.vue`**

位置：run 详情页新增「质量评分」标签页

功能：
- 显示单集综合分 + 四维雷达图
- 显示四维分项得分
- 支持调整权重（滑块）
- 支持重新评分（触发 POST）
- 显示评分元数据（模板/提示词/模型版本）

**设计决策**

- 雷达图：四维评分用雷达图可视化，直观展示强项/弱项
- 权重调整：默认权重 0.3/0.3/0.2/0.2，用户可调整
- 元数据展示：评分时的版本信息，保证可复现性

### 3.5 探针层

**新增探针：`probe-m71.ts`**

覆盖：
1. 评分服务：四维评分计算正确
2. 评分端点：POST/GET 端点契约正确
3. 评分存储：quality_scores 表读写正确
4. 权重调整：自定义权重计算正确
5. 可复现性：metadata 记录完整
6. M70 缺口收尾：四项缺口验收条件

**设计决策**

- 离线探针：不调用真实模型，不联网
- 契约测试：覆盖端点输入/输出/错误
- 集成测试：覆盖服务 → 存储 → 端点全链路

## 4. 任务拆分

### 4.1 M70 缺口收尾（4 项）

**任务 1：引文漂移分支专测**
- 文件：`apps/server/scripts/probes/m70/resume.ts`
- 内容：新增「删除原引文后零模型复核」分支
- 验收：断言 409 + 错误信封正确
- 估时：0.5 小时

**任务 2：templateKey 消费面识别**
- 文件：`apps/server/src/pipeline/invocation.ts`
- 内容：调用前增加 revalidatePack + material/configHash 比对
- 验收：任何付费派发前 409
- 估时：1 小时

**任务 3：草稿删入口**
- 文件：
  - `apps/server/src/routes/drafts.ts`（新增 DELETE /drafts/:id）
  - `apps/web/src/components/draft/DraftList.vue`（新增删除按钮）
- 内容：后端端点 + UI 按钮
- 验收：权限与编辑一致
- 估时：2 小时

**任务 4：personaFile 动态化**
- 文件：
  - `apps/server/src/services/roles.ts`（personaFile 改为从数据库读取）
  - `apps/web/src/components/role/RoleEditor.vue`（支持编辑 personaFile 引用）
- 内容：数据库字段 + UI 编辑
- 验收：角色人设文件可定制
- 估时：2 小时

### 4.2 R01 质量基线（5 项）

**任务 5：quality_scores 表设计与迁移**
- 文件：
  - `apps/server/src/db/schema.ts`（新增表定义）
  - `apps/server/src/db/migrations/XXX_add_quality_scores.ts`（新增迁移）
- 内容：表结构 + 索引
- 验收：迁移可执行 + 回滚
- 估时：1 小时

**任务 6：评分服务实现**
- 文件：`apps/server/src/services/eval-quality.ts`
- 内容：四维评分 + 加权平均
- 验收：评分计算正确
- 估时：3 小时

**任务 7：评分端点实现**
- 文件：`apps/server/src/routes/runs.ts`
- 内容：POST/GET /runs/:id/quality
- 验收：端点契约正确
- 估时：2 小时

**任务 8：评分 UI 实现**
- 文件：
  - `apps/web/src/components/run/QualityScorePanel.vue`（新增）
  - `apps/web/src/views/run/RunDetail.vue`（集成）
- 内容：雷达图 + 权重调整 + 元数据展示
- 验收：UI 交互正确
- 估时：3 小时

**任务 9：评分探针实现**
- 文件：`apps/server/scripts/probe-m71.ts`
- 内容：覆盖服务 + 端点 + 存储 + 权重 + 元数据
- 验收：全量探针 exit 0
- 估时：2 小时

### 4.3 总估时

| 类别 | 任务数 | 估时 |
|------|-------|------|
| M70 缺口收尾 | 4 | 5.5 小时 |
| R01 质量基线 | 5 | 11 小时 |
| 联调 + 文档 | - | 2 小时 |
| **合计** | **9** | **18.5 小时** |

按每天 6 小时有效开发时间，预计 3 天完成。

## 5. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| M24 评测服务性能不足 | 角色一致性评分慢 | 评分结果缓存，重复查询不重新计算 |
| 剧情连贯度检查误报 | 用户信任度下降 | 零模型检查只报告矛盾，不自动修复；用户可标记「已知的合理偏离」 |
| 权重调整导致评分不稳定 | 用户困惑 | 默认权重固定，调整权重只影响当前查询，不修改历史评分 |
| personaFile 动态化破坏现有角色 | 回归 | 迁移时保留旧 personaFile 值，新字段可选 |

## 6. 后续工作

M71 完成后，后续里程碑：

- **M72**：定向返修闭环（R06）
- **M73**：多阶段质量检查（R05）
- **M74**：角色一致性工程化（R04）

M71 的质量基线为 M72-M74 提供测量基础。

## 7. 参考

- M70 计划：`docs/records/plans/M70-计划.md`
- M70 设计：`docs/records/M70-跨集剧情连续性-design.md`
- 备选清单：`docs/records/备选清单-post-M27-backlog.md`
- M24 评测服务：`apps/server/src/services/eval-service.ts`
- M29 版本链：`apps/server/src/db/schema.ts` (content_versions / exec_snapshots / exec_inputs)
