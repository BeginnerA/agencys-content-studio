# M72 设计规格：定向返修闭环

> **状态**：待审核  
> **日期**：2026-11-02  
> **依赖**：M71 已交付（质量基线、四维评分、评分端点）  
> **范围**：实现 R06 定向返修闭环（问题报告 → 修复建议 → 影响评估 → 用户批准 → 定向重跑 → 复检 → 采纳/保留）

## 1. 目标与验收

### 1.1 目标

1. **问题报告**：基于 M71 质量评分，自动识别低分维度并生成问题报告
2. **修复建议**：针对每个问题生成可执行的修复建议（修改提示词/调整参数/重跑特定集）
3. **影响评估**：计算修复的影响范围（哪些集/镜头会受影响）和成本预估
4. **用户批准**：UI 展示修复计划，用户可选择批准/拒绝/修改
5. **定向重跑**：只重跑受影响的集/镜头，不重跑整个 run
6. **复检**：重跑后重新评分，验证修复效果
7. **采纳/保留**：用户可选择采纳新版本或保留旧版本

### 1.2 验收标准

**功能验收**

| 功能 | 验收条件 |
|------|---------|
| 问题识别 | 质量分 < 70 的维度自动生成问题报告 |
| 修复建议 | 每个问题至少生成 1 个可执行建议 |
| 影响评估 | 准确计算受影响的集/镜头数 + 预估费用 |
| 用户批准 | UI 展示修复计划，用户可批准/拒绝 |
| 定向重跑 | 只重跑受影响部分，其他部分不变 |
| 复检 | 重跑后自动重新评分，对比前后分数 |
| 采纳/保留 | 用户可选择新版本或回滚到旧版本 |

**停止条件验收**

| 条件 | 验收 |
|------|------|
| 重试次数到限 | 默认 3 次，达到后停止并提示 |
| 累计费用到限 | 超过预算上限时停止 |
| 质量无改善 | 连续 2 次重跑分数提升 < 5 分时停止 |
| 输入版本变更 | 检测到上游变更时停止并提示 |
| 人工取消 | 用户随时可取消修复流程 |

**离线验证**

- 全量探针 exit 0（含新增 M72 探针）
- server tsc --noEmit exit 0
- web vue-tsc --noEmit exit 0
- git diff --check exit 0

## 2. 范围与边界

### 2.1 纳入范围

1. **修复建议服务**：新增 `repair-service.ts`，基于质量分生成修复建议
2. **影响评估服务**：新增 `impact-service.ts`，计算修复影响范围和成本
3. **修复流程状态机**：新增 `repair_runs` 表，跟踪修复流程状态
4. **修复端点**：POST /runs/:id/repair（启动修复）、GET /repairs/:id（查询状态）、POST /repairs/:id/approve（批准）、POST /repairs/:id/cancel（取消）
5. **修复 UI**：RepairPanel.vue 组件，展示问题列表、修复建议、影响评估、批准按钮
6. **修复探针**：新增 probe-m72，覆盖修复服务 + 端点 + 状态机 + 停止条件

### 2.2 明确排除

1. **不自动执行修复**：所有修复必须用户批准后才执行
2. **不修改原作内容**：修复只调整生成参数/提示词，不改原作
3. **不跨 run 修复**：每个修复只针对单个 run
4. **不做多阶段质量检查**（M73 范围）：M72 只做单集修复
5. **不做角色一致性工程化**（M74 范围）：M72 只复用 M71 评分

### 2.3 依赖与复用

| 依赖 | 复用方式 |
|------|---------|
| M71 质量评分 | quality_scores 表 + scoreQuality 服务 |
| M70 连续性 | continuity_runs / continuity_folds / continuity_evidence |
| M29 版本链 | content_versions / exec_snapshots / exec_inputs |
| M24 评测服务 | eval-service 的图片相似度评分 |
| M30/M31 单镜重跑 | shot/selection.ts 的重跑逻辑 |

## 3. 架构设计

### 3.1 数据模型

**新增表：`repair_runs`**

```sql
CREATE TABLE repair_runs (
  id TEXT PRIMARY KEY,
  source_run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
  episode_idx INTEGER NOT NULL,
  
  -- 修复状态
  status TEXT NOT NULL,  -- 'proposed' | 'approved' | 'running' | 'completed' | 'cancelled' | 'failed'
  
  -- 问题与修复
  issues TEXT NOT NULL,          -- JSON: [{dimension, score, suggestion}]
  impact_scope TEXT NOT NULL,    -- JSON: {affected_episodes, affected_shots, estimated_cost}
  
  -- 执行结果
  attempt_count INTEGER NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  score_before REAL,
  score_after REAL,
  
  -- 停止条件
  stop_reason TEXT,  -- 'max_attempts' | 'budget_exceeded' | 'no_improvement' | 'input_changed' | 'user_cancelled'
  
  -- 元数据
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_repair_runs_source ON repair_runs(source_run_id);
CREATE INDEX idx_repair_runs_status ON repair_runs(status);
```

**设计决策**

- repair_runs 与 pipeline_runs 一对一：一次修复针对一个 run 的一个集
- status 状态机：proposed → approved → running → completed/cancelled/failed
- issues 存 JSON：记录问题维度、分数、修复建议
- impact_scope 存 JSON：记录影响范围和成本预估
- attempt_count 跟踪重试次数，用于停止条件判断
- score_before/score_after 记录修复前后分数，用于判断是否改善

### 3.2 服务层

**新增服务：`repair-service.ts`**

```typescript
export interface RepairIssue {
  dimension: 'citation' | 'consistency' | 'coherence' | 'cost'
  score: number
  threshold: number
  suggestion: string
}

export interface RepairProposal {
  runId: number
  episodeIdx: number
  issues: RepairIssue[]
  impactScope: {
    affectedEpisodes: number[]
    affectedShots: number[]
    estimatedCost: number
  }
}

export async function proposeRepair(runId: number, episodeIdx: number): Promise<RepairProposal> {
  // 1. 获取质量评分
  const qualityScore = await getQualityScore(runId, episodeIdx)
  
  // 2. 识别低分维度（< 70 分）
  const issues = identifyIssues(qualityScore)
  
  // 3. 生成修复建议
  const suggestions = generateSuggestions(issues)
  
  // 4. 计算影响范围
  const impactScope = await calculateImpact(runId, episodeIdx, suggestions)
  
  return {
    runId,
    episodeIdx,
    issues: suggestions,
    impactScope
  }
}

export async function executeRepair(repairId: string): Promise<void> {
  // 1. 加载修复计划
  const repair = await getRepair(repairId)
  
  // 2. 检查停止条件
  if (shouldStop(repair)) {
    await updateRepairStatus(repairId, 'cancelled', repair.stopReason)
    return
  }
  
  // 3. 执行定向重跑
  await runTargetedRepair(repair)
  
  // 4. 重新评分
  const newScore = await scoreQuality({ runId: repair.sourceRunId, episodeIdx: repair.episodeIdx })
  
  // 5. 更新修复记录
  await updateRepairResult(repairId, newScore)
  
  // 6. 判断是否需要继续修复
  if (needsMoreRepair(repair, newScore)) {
    await executeRepair(repairId)  // 递归重试
  } else {
    await updateRepairStatus(repairId, 'completed')
  }
}
```

**设计决策**

- proposeRepair 生成修复计划，不执行
- executeRepair 执行修复，递归重试直到满足停止条件
- 停止条件：重试次数/费用/无改善/输入变更/用户取消
- 修复建议基于质量分维度生成，每个维度有对应的修复策略

### 3.3 API 层

**新增端点**

```typescript
// 启动修复（生成修复计划）
POST /runs/:id/repair
Body: { episodeIdx: number }
Response: { repairId: string, proposal: RepairProposal }

// 查询修复状态
GET /repairs/:id
Response: { repair: RepairRun, status: string }

// 批准修复
POST /repairs/:id/approve
Response: { success: true }

// 取消修复
POST /repairs/:id/cancel
Response: { success: true }

// 采纳修复结果
POST /repairs/:id/accept
Response: { success: true }

// 保留旧版本（回滚）
POST /repairs/:id/reject
Response: { success: true }
```

**设计决策**

- POST /runs/:id/repair 生成修复计划，返回 repairId
- 用户通过 POST /repairs/:id/approve 批准后，系统自动执行修复
- 修复完成后，用户可选择采纳（accept）或保留旧版本（reject）
- 用户可随时取消（cancel）

### 3.4 UI 层

**新增组件：`RepairPanel.vue`**

位置：run 详情页新增「修复」标签页

功能：
- 显示质量分低于阈值的维度列表
- 显示每个问题的修复建议
- 显示影响范围（受影响集/镜头数 + 预估费用）
- 批准/取消按钮
- 修复进度展示（attempt_count / total_cost / score_before / score_after）
- 采纳/保留按钮

**设计决策**

- 问题列表用卡片展示，每个卡片包含维度、分数、建议
- 影响范围用数字展示，费用用货币格式
- 修复进度用进度条 + 数字展示
- 按钮状态根据修复状态动态显示（proposed → 批准/取消；completed → 采纳/保留）

### 3.5 探针层

**新增探针：`probe-m72.ts`**

覆盖：
1. 修复建议服务：问题识别 + 建议生成正确
2. 影响评估服务：影响范围计算正确
3. 修复状态机：状态转换正确
4. 停止条件：重试次数/费用/无改善/输入变更/用户取消
5. 修复端点：POST/GET 端点契约正确
6. 修复存储：repair_runs 表读写正确

**设计决策**

- 离线探针：不调用真实模型，不联网
- 契约测试：覆盖端点输入/输出/错误
- 集成测试：覆盖服务 → 存储 → 端点全链路
- 状态机测试：覆盖所有状态转换路径

## 4. 任务拆分

### 4.1 数据模型与迁移（1 项）

**任务 1：repair_runs 表设计与迁移**
- 文件：
  - `apps/server/src/db/schema.ts`（新增表定义）
  - `apps/server/drizzle/XXXX_m72_repair.sql`（自动生成迁移）
- 内容：表结构 + 索引
- 验收：迁移可执行 + 回滚
- 估时：1 小时

### 4.2 修复服务（2 项）

**任务 2：修复建议服务**
- 文件：`apps/server/src/services/repair-service.ts`
- 内容：问题识别 + 建议生成 + 影响评估
- 验收：四维问题识别正确，建议可执行
- 估时：3 小时

**任务 3：修复执行服务**
- 文件：`apps/server/src/services/repair-executor.ts`
- 内容：定向重跑 + 重新评分 + 停止条件判断
- 验收：状态机转换正确，停止条件触发正确
- 估时：4 小时

### 4.3 修复端点（1 项）

**任务 4：修复端点实现**
- 文件：`apps/server/src/routes/repairs.ts`（新建）
- 内容：POST/GET /runs/:id/repair、POST /repairs/:id/approve/cancel/accept/reject
- 验收：端点契约正确
- 估时：2 小时

### 4.4 修复 UI（1 项）

**任务 5：修复 UI 实现**
- 文件：
  - `apps/web/src/components/run/RepairPanel.vue`（新增）
  - `apps/web/src/views/run-detail/index.vue`（集成）
- 内容：问题列表 + 修复建议 + 影响评估 + 批准/取消 + 进度展示 + 采纳/保留
- 验收：UI 交互正确
- 估时：3 小时

### 4.5 修复探针（1 项）

**任务 6：修复探针实现**
- 文件：`apps/server/scripts/probe-m72.ts`
- 内容：覆盖服务 + 端点 + 存储 + 状态机 + 停止条件
- 验收：全量探针 exit 0
- 估时：2 小时

### 4.6 联调与文档（1 项）

**任务 7：联调与文档**
- 文件：
  - `docs/records/路线图-roadmap.md`
  - `docs/records/备选清单-post-M27-backlog.md`
- 内容：全量验证 + 文档更新
- 验收：全量探针 exit 0，server/web tsc exit 0
- 估时：1 小时

### 4.7 总估时

| 类别 | 任务数 | 估时 |
|------|-------|------|
| 数据模型 | 1 | 1 小时 |
| 修复服务 | 2 | 7 小时 |
| 修复端点 | 1 | 2 小时 |
| 修复 UI | 1 | 3 小时 |
| 修复探针 | 1 | 2 小时 |
| 联调文档 | 1 | 1 小时 |
| **合计** | **7** | **16 小时** |

按每天 6 小时有效开发时间，预计 2.5 天完成。

## 5. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 修复建议不可执行 | 用户无法修复 | 每个建议必须有明确的执行路径（修改提示词/调整参数/重跑特定集） |
| 影响范围计算错误 | 重跑范围过大或过小 | 基于 exec_inputs 的版本链精确计算依赖关系 |
| 停止条件不触发 | 无限循环修复 | attempt_count 硬限制（默认 3 次）+ 费用硬限制（预算上限） |
| 修复后分数下降 | 用户体验差 | 提供回滚功能（reject → 保留旧版本） |
| 并发修复冲突 | 数据不一致 | repair_runs 状态机 + 乐观锁（updated_at 比对） |

## 6. 后续工作

M72 完成后，后续里程碑：

- **M73**：多阶段质量检查（R05）
- **M74**：角色一致性工程化（R04）

M72 的修复闭环为 M73 的多阶段检查提供修复能力。

## 7. 参考

- M71 设计：`docs/records/M71-质量基线与缺口收尾-design.md`
- M70 设计：`docs/records/M70-跨集剧情连续性-design.md`
- 备选清单：`docs/records/备选清单-post-M27-backlog.md`
- M30/M31 单镜重跑：`apps/server/src/services/shot/selection.ts`
