# M72 定向返修闭环实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 R06 定向返修闭环（问题报告 → 修复建议 → 影响评估 → 用户批准 → 定向重跑 → 复检 → 采纳/保留）

**Architecture:** 新增 `repair_runs` 表跟踪修复流程，`repair-service.ts` 基于 M71 质量分生成修复建议，`repair-executor.ts` 执行定向重跑 + 重新评分 + 停止条件判断，REST 端点提供修复 API，Vue 组件展示修复面板。

**Tech Stack:** Hono + Drizzle/libsql + Vue 3 + TypeScript + tsx-run 探针

**Spec:** docs/records/M72-定向返修闭环-design.md

## Global Constraints

- 唯一验证入口：`node .superpowers/sdd/M72-计划/safe-run.mjs <kind>`（kinds: server/web/templates/probe/script/format/migration）
- 单文件 ≤800 行
- 不调用真实付费模型，不联网
- 注释与文案必须自解释（禁 M号·intg·阶段码·裸§节号·line·切片 等外部编号指针）
- 复用 M71 质量评分、M70 连续性、M29 版本链
- Git 纪律：默认不代提交；用户里程碑明确授权可提交

---

## 文件结构映射

### 数据模型

| 文件 | 职责 |
|------|------|
| `apps/server/src/db/schema.ts` | 新增 repairRuns 表定义 |
| `apps/server/drizzle/XXXX_m72_repair.sql` | 自动生成迁移 |

### 修复服务

| 文件 | 职责 |
|------|------|
| `apps/server/src/services/repair-service.ts` | 问题识别 + 建议生成 + 影响评估 |
| `apps/server/src/services/repair-executor.ts` | 定向重跑 + 重新评分 + 停止条件 |

### 修复端点

| 文件 | 职责 |
|------|------|
| `apps/server/src/routes/repairs.ts` | POST/GET /runs/:id/repair、POST /repairs/:id/* |

### 修复 UI

| 文件 | 职责 |
|------|------|
| `apps/web/src/components/run/RepairPanel.vue` | 问题列表 + 修复建议 + 影响评估 + 批准/取消 + 进度 + 采纳/保留 |
| `apps/web/src/views/run-detail/index.vue` | 集成修复标签页 |

### 修复探针

| 文件 | 职责 |
|------|------|
| `apps/server/scripts/probe-m72.ts` | 覆盖服务 + 端点 + 存储 + 状态机 + 停止条件 |

---

## 任务 1：repair_runs 表设计与迁移

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/drizzle/XXXX_m72_repair.sql`（自动生成）

**Interfaces:**
- Consumes: Drizzle schema 定义模式
- Produces: repairRuns 表 + 索引

- [ ] **Step 1: 读取现有 schema.ts**

读取 `apps/server/src/db/schema.ts`，理解表定义模式和命名规范。

- [ ] **Step 2: 新增 repairRuns 表定义**

```typescript
export const repairRuns = sqliteTable('repair_runs', {
  id: text('id').primaryKey(),
  sourceRunId: integer('source_run_id').notNull().references(() => pipelineRuns.id),
  episodeIdx: integer('episode_idx').notNull(),
  
  status: text('status').notNull(),  // 'proposed' | 'approved' | 'running' | 'completed' | 'cancelled' | 'failed'
  
  issues: text('issues').notNull(),
  impactScope: text('impact_scope').notNull(),
  
  attemptCount: integer('attempt_count').notNull().default(0),
  totalCost: real('total_cost').notNull().default(0),
  scoreBefore: real('score_before'),
  scoreAfter: real('score_after'),
  
  stopReason: text('stop_reason'),
  
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

export const idxRepairRunsSource = index('idx_repair_runs_source')
  .on(repairRuns.sourceRunId)

export const idxRepairRunsStatus = index('idx_repair_runs_status')
  .on(repairRuns.status)
```

- [ ] **Step 3: 生成迁移**

Run: `node .superpowers/sdd/M72-计划/safe-run.mjs migration`
Expected: exit 0，生成 SQL 迁移文件

- [ ] **Step 4: 运行 server tsc**

Run: `node .superpowers/sdd/M72-计划/safe-run.mjs server`
Expected: exit 0

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/db/schema.ts apps/server/drizzle/
git commit -m "feat: repair_runs 表设计与迁移（R06 修复闭环）"
```

---

## 任务 2：修复建议服务

**Files:**
- Create: `apps/server/src/services/repair-service.ts`

**Interfaces:**
- Consumes: qualityScores 表、M71 scoreQuality 服务
- Produces: proposeRepair 函数 + RepairProposal 类型

- [ ] **Step 1: 创建 repair-service.ts**

```typescript
import { db } from '../db/index.js'
import { qualityScores, pipelineRuns, execInputs, contentVersions } from '../db/schema.js'
import { eq, and } from 'drizzle-orm'
import { scoreQuality } from './eval-quality.js'

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

const QUALITY_THRESHOLD = 70

export async function proposeRepair(runId: number, episodeIdx: number): Promise<RepairProposal> {
  // 1. 获取质量评分
  const qualityResult = await scoreQuality({ runId, episodeIdx })
  
  // 2. 识别低分维度
  const issues: RepairIssue[] = []
  
  if (qualityResult.citationScore < QUALITY_THRESHOLD) {
    issues.push({
      dimension: 'citation',
      score: qualityResult.citationScore,
      threshold: QUALITY_THRESHOLD,
      suggestion: '增加引文覆盖度：检查原作提取是否完整，补充缺失的引文来源'
    })
  }
  
  if (qualityResult.consistencyScore < QUALITY_THRESHOLD) {
    issues.push({
      dimension: 'consistency',
      score: qualityResult.consistencyScore,
      threshold: QUALITY_THRESHOLD,
      suggestion: '提升角色一致性：检查参考图是否稳定，考虑使用更明确的角色描述'
    })
  }
  
  if (qualityResult.coherenceScore < QUALITY_THRESHOLD) {
    issues.push({
      dimension: 'coherence',
      score: qualityResult.coherenceScore,
      threshold: QUALITY_THRESHOLD,
      suggestion: '改善剧情连贯度：检查跨集状态是否一致，补充缺失的剧情衔接'
    })
  }
  
  if (qualityResult.costScore < QUALITY_THRESHOLD) {
    issues.push({
      dimension: 'cost',
      score: qualityResult.costScore,
      threshold: QUALITY_THRESHOLD,
      suggestion: '优化费用效率：检查是否有不必要的重跑，考虑降低生成参数'
    })
  }
  
  // 3. 计算影响范围
  const impactScope = await calculateImpact(runId, episodeIdx, issues)
  
  return {
    runId,
    episodeIdx,
    issues,
    impactScope
  }
}

async function calculateImpact(
  runId: number,
  episodeIdx: number,
  issues: RepairIssue[]
): Promise<RepairProposal['impactScope']> {
  // 基于 exec_inputs 的版本链计算依赖关系
  const inputs = await db.query.execInputs.findMany({
    where: eq(execInputs.runId, runId)
  })
  
  const affectedEpisodes = new Set<number>()
  const affectedShots = new Set<number>()
  
  // 当前集必定受影响
  affectedEpisodes.add(episodeIdx)
  
  // 检查后续集是否依赖当前集
  for (const input of inputs) {
    if (input.episodeIdx > episodeIdx && input.versionId) {
      // 如果后续集引用了当前集的资产，则受影响
      affectedEpisodes.add(input.episodeIdx)
    }
  }
  
  // 估算费用（基于影响集数和维度数）
  const estimatedCost = affectedEpisodes.size * issues.length * 0.1
  
  return {
    affectedEpisodes: Array.from(affectedEpisodes).sort((a, b) => a - b),
    affectedShots: Array.from(affectedShots).sort((a, b) => a - b),
    estimatedCost: Math.round(estimatedCost * 100) / 100
  }
}
```

- [ ] **Step 2: 运行 server tsc**

Run: `node .superpowers/sdd/M72-计划/safe-run.mjs server`
Expected: exit 0

- [ ] **Step 3: 提交**

```bash
git add apps/server/src/services/repair-service.ts
git commit -m "feat: 修复建议服务（R06 修复闭环）"
```

---

## 任务 3：修复执行服务

**Files:**
- Create: `apps/server/src/services/repair-executor.ts`

**Interfaces:**
- Consumes: repairRuns 表、repair-service、scoreQuality
- Produces: executeRepair 函数 + 状态机

- [ ] **Step 1: 创建 repair-executor.ts**

```typescript
import { db } from '../db/index.js'
import { repairRuns, qualityScores } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { scoreQuality } from './eval-quality.js'
import { proposeRepair } from './repair-service.js'

const MAX_ATTEMPTS = 3
const BUDGET_LIMIT = 10.0
const MIN_IMPROVEMENT = 5

export async function executeRepair(repairId: string): Promise<void> {
  // 1. 加载修复记录
  const repair = await db.query.repairRuns.findFirst({
    where: eq(repairRuns.id, repairId)
  })
  
  if (!repair) {
    throw new Error('修复记录不存在')
  }
  
  if (repair.status !== 'approved') {
    throw new Error('修复未批准')
  }
  
  // 2. 更新状态为 running
  await updateRepairStatus(repairId, 'running')
  
  try {
    // 3. 检查停止条件
    if (shouldStop(repair)) {
      await updateRepairStatus(repairId, 'cancelled', repair.stopReason)
      return
    }
    
    // 4. 记录修复前分数
    const scoreBefore = await getCurrentScore(repair.sourceRunId, repair.episodeIdx)
    if (!repair.scoreBefore) {
      await updateRepairScore(repairId, { scoreBefore })
    }
    
    // 5. 执行定向重跑（模拟）
    await runTargetedRepair(repair)
    
    // 6. 重新评分
    const newScoreResult = await scoreQuality({ 
      runId: repair.sourceRunId, 
      episodeIdx: repair.episodeIdx 
    })
    const scoreAfter = newScoreResult.overallScore
    
    // 7. 更新修复记录
    const attemptCount = repair.attemptCount + 1
    const totalCost = repair.totalCost + 0.5  // 模拟费用
    await updateRepairResult(repairId, { attemptCount, totalCost, scoreAfter })
    
    // 8. 判断是否需要继续修复
    const improvement = scoreAfter - (repair.scoreBefore || scoreBefore)
    if (needsMoreRepair(attemptCount, totalCost, improvement)) {
      // 递归重试
      await executeRepair(repairId)
    } else {
      await updateRepairStatus(repairId, 'completed')
    }
  } catch (error) {
    await updateRepairStatus(repairId, 'failed', error.message)
    throw error
  }
}

function shouldStop(repair: any): boolean {
  // 检查重试次数
  if (repair.attemptCount >= MAX_ATTEMPTS) {
    repair.stopReason = 'max_attempts'
    return true
  }
  
  // 检查费用
  if (repair.totalCost >= BUDGET_LIMIT) {
    repair.stopReason = 'budget_exceeded'
    return true
  }
  
  // 检查无改善（需要至少 2 次尝试）
  if (repair.attemptCount >= 2 && repair.scoreBefore && repair.scoreAfter) {
    const improvement = repair.scoreAfter - repair.scoreBefore
    if (improvement < MIN_IMPROVEMENT) {
      repair.stopReason = 'no_improvement'
      return true
    }
  }
  
  return false
}

function needsMoreRepair(attemptCount: number, totalCost: number, improvement: number): boolean {
  if (attemptCount >= MAX_ATTEMPTS) return false
  if (totalCost >= BUDGET_LIMIT) return false
  if (improvement < MIN_IMPROVEMENT && attemptCount >= 2) return false
  return true
}

async function getCurrentScore(runId: number, episodeIdx: number): Promise<number> {
  const score = await db.query.qualityScores.findFirst({
    where: and(
      eq(qualityScores.runId, runId),
      eq(qualityScores.episodeIdx, episodeIdx)
    )
  })
  return score?.overallScore || 0
}

async function runTargetedRepair(repair: any): Promise<void> {
  // 模拟定向重跑（实际实现需要调用 M30/M31 的单镜重跑逻辑）
  // 这里只更新 attempt_count
  await new Promise(resolve => setTimeout(resolve, 100))
}

async function updateRepairStatus(repairId: string, status: string, stopReason?: string): Promise<void> {
  const now = Date.now()
  await db.update(repairRuns)
    .set({ status, stopReason, updatedAt: now })
    .where(eq(repairRuns.id, repairId))
}

async function updateRepairScore(repairId: string, data: { scoreBefore?: number; scoreAfter?: number }): Promise<void> {
  const now = Date.now()
  await db.update(repairRuns)
    .set({ ...data, updatedAt: now })
    .where(eq(repairRuns.id, repairId))
}

async function updateRepairResult(repairId: string, data: { attemptCount: number; totalCost: number; scoreAfter: number }): Promise<void> {
  const now = Date.now()
  await db.update(repairRuns)
    .set({ ...data, updatedAt: now })
    .where(eq(repairRuns.id, repairId))
}
```

- [ ] **Step 2: 运行 server tsc**

Run: `node .superpowers/sdd/M72-计划/safe-run.mjs server`
Expected: exit 0

- [ ] **Step 3: 提交**

```bash
git add apps/server/src/services/repair-executor.ts
git commit -m "feat: 修复执行服务（R06 修复闭环）"
```

---

## 任务 4：修复端点实现

**Files:**
- Create: `apps/server/src/routes/repairs.ts`

**Interfaces:**
- Consumes: proposeRepair、executeRepair 服务
- Produces: POST/GET /runs/:id/repair、POST /repairs/:id/* 端点

- [ ] **Step 1: 创建 repairs.ts 路由**

```typescript
import { Hono } from 'hono'
import { db } from '../db/index.js'
import { repairRuns } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { proposeRepair } from '../services/repair-service.js'
import { executeRepair } from '../services/repair-executor.js'
import { HttpError } from '../lib/helpers.js'

export const repairsRoutes = new Hono()

// POST /runs/:id/repair — 启动修复（生成修复计划）
repairsRoutes.post('/runs/:id/repair', async (c) => {
  const runId = parseInt(c.req.param('id'))
  const body = await c.req.json()
  const { episodeIdx } = body
  
  if (typeof episodeIdx !== 'number') {
    throw new HttpError(400, 'bad_request', 'episodeIdx 必须是数字')
  }
  
  const proposal = await proposeRepair(runId, episodeIdx)
  
  if (proposal.issues.length === 0) {
    throw new HttpError(400, 'bad_request', '质量分全部达标，无需修复')
  }
  
  const id = generateId()
  const now = Date.now()
  await db.insert(repairRuns).values({
    id,
    sourceRunId: runId,
    episodeIdx,
    status: 'proposed',
    issues: JSON.stringify(proposal.issues),
    impactScope: JSON.stringify(proposal.impactScope),
    attemptCount: 0,
    totalCost: 0,
    createdAt: now,
    updatedAt: now
  })
  
  return c.json({ repairId: id, proposal }, 201)
})

// GET /repairs/:id — 查询修复状态
repairsRoutes.get('/repairs/:id', async (c) => {
  const id = c.req.param('id')
  
  const repair = await db.query.repairRuns.findFirst({
    where: eq(repairRuns.id, id)
  })
  
  if (!repair) {
    throw new HttpError(404, 'not_found', '修复记录不存在')
  }
  
  return c.json({
    repair: {
      id: repair.id,
      sourceRunId: repair.sourceRunId,
      episodeIdx: repair.episodeIdx,
      status: repair.status,
      issues: JSON.parse(repair.issues),
      impactScope: JSON.parse(repair.impactScope),
      attemptCount: repair.attemptCount,
      totalCost: repair.totalCost,
      scoreBefore: repair.scoreBefore,
      scoreAfter: repair.scoreAfter,
      stopReason: repair.stopReason,
      createdAt: new Date(repair.createdAt).toISOString(),
      updatedAt: new Date(repair.updatedAt).toISOString()
    }
  })
})

// POST /repairs/:id/approve — 批准修复
repairsRoutes.post('/repairs/:id/approve', async (c) => {
  const id = c.req.param('id')
  
  const repair = await db.query.repairRuns.findFirst({
    where: eq(repairRuns.id, id)
  })
  
  if (!repair) {
    throw new HttpError(404, 'not_found', '修复记录不存在')
  }
  
  if (repair.status !== 'proposed') {
    throw new HttpError(400, 'bad_request', '只有 proposed 状态可批准')
  }
  
  const now = Date.now()
  await db.update(repairRuns)
    .set({ status: 'approved', updatedAt: now })
    .where(eq(repairRuns.id, id))
  
  // 异步执行修复
  executeRepair(id).catch(err => {
    console.error('修复执行失败:', err)
  })
  
  return c.json({ success: true })
})

// POST /repairs/:id/cancel — 取消修复
repairsRoutes.post('/repairs/:id/cancel', async (c) => {
  const id = c.req.param('id')
  
  const repair = await db.query.repairRuns.findFirst({
    where: eq(repairRuns.id, id)
  })
  
  if (!repair) {
    throw new HttpError(404, 'not_found', '修复记录不存在')
  }
  
  if (!['proposed', 'approved', 'running'].includes(repair.status)) {
    throw new HttpError(400, 'bad_request', '当前状态不可取消')
  }
  
  const now = Date.now()
  await db.update(repairRuns)
    .set({ status: 'cancelled', stopReason: 'user_cancelled', updatedAt: now })
    .where(eq(repairRuns.id, id))
  
  return c.json({ success: true })
})

// POST /repairs/:id/accept — 采纳修复结果
repairsRoutes.post('/repairs/:id/accept', async (c) => {
  const id = c.req.param('id')
  
  const repair = await db.query.repairRuns.findFirst({
    where: eq(repairRuns.id, id)
  })
  
  if (!repair) {
    throw new HttpError(404, 'not_found', '修复记录不存在')
  }
  
  if (repair.status !== 'completed') {
    throw new HttpError(400, 'bad_request', '只有 completed 状态可采纳')
  }
  
  // 采纳逻辑：更新 pipeline_runs 的版本指针（实际实现需要更复杂的版本管理）
  const now = Date.now()
  await db.update(repairRuns)
    .set({ updatedAt: now })
    .where(eq(repairRuns.id, id))
  
  return c.json({ success: true })
})

// POST /repairs/:id/reject — 保留旧版本（回滚）
repairsRoutes.post('/repairs/:id/reject', async (c) => {
  const id = c.req.param('id')
  
  const repair = await db.query.repairRuns.findFirst({
    where: eq(repairRuns.id, id)
  })
  
  if (!repair) {
    throw new HttpError(404, 'not_found', '修复记录不存在')
  }
  
  if (repair.status !== 'completed') {
    throw new HttpError(400, 'bad_request', '只有 completed 状态可回滚')
  }
  
  // 回滚逻辑：恢复到修复前的版本（实际实现需要更复杂的版本管理）
  const now = Date.now()
  await db.update(repairRuns)
    .set({ status: 'cancelled', stopReason: 'user_rejected', updatedAt: now })
    .where(eq(repairRuns.id, id))
  
  return c.json({ success: true })
})

function generateId(): string {
  return `repair_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}
```

- [ ] **Step 2: 注册路由到 app.ts**

读取 `apps/server/src/app.ts`，添加 `repairsRoutes` 注册。

- [ ] **Step 3: 运行 server tsc**

Run: `node .superpowers/sdd/M72-计划/safe-run.mjs server`
Expected: exit 0

- [ ] **Step 4: 提交**

```bash
git add apps/server/src/routes/repairs.ts apps/server/src/app.ts
git commit -m "feat: 修复端点实现（R06 修复闭环）"
```

---

## 任务 5：修复 UI 实现

**Files:**
- Create: `apps/web/src/components/run/RepairPanel.vue`
- Modify: `apps/web/src/views/run-detail/index.vue`

**Interfaces:**
- Consumes: POST/GET /runs/:id/repair、POST /repairs/:id/* 端点
- Produces: 问题列表 + 修复建议 + 影响评估 + 批准/取消 + 进度 + 采纳/保留组件

- [ ] **Step 1: 创建 RepairPanel.vue**

参考 QualityScorePanel.vue 的结构，实现：
- 问题列表（卡片展示，每个卡片包含维度、分数、建议）
- 影响范围（数字展示，费用用货币格式）
- 修复进度（进度条 + 数字）
- 按钮状态根据修复状态动态显示

- [ ] **Step 2: 集成到 RunDetail.vue**

在运行详情页新增「修复」标签页，显示 RepairPanel 组件。

- [ ] **Step 3: 运行 web tsc**

Run: `node .superpowers/sdd/M72-计划/safe-run.mjs web`
Expected: exit 0

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/components/run/RepairPanel.vue apps/web/src/views/run-detail/index.vue
git commit -m "feat: 修复 UI 实现（R06 修复闭环）"
```

---

## 任务 6：修复探针实现

**Files:**
- Create: `apps/server/scripts/probe-m72.ts`

**Interfaces:**
- Consumes: 修复服务、修复端点、repair_runs 表
- Produces: 覆盖服务 + 端点 + 存储 + 状态机 + 停止条件的探针

- [ ] **Step 1: 创建 probe-m72.ts**

参考 probe-m71.ts 的结构，实现：
- 修复建议服务测试：问题识别 + 建议生成正确
- 影响评估服务测试：影响范围计算正确
- 修复状态机测试：状态转换正确
- 停止条件测试：重试次数/费用/无改善/输入变更/用户取消
- 修复端点测试：POST/GET 端点契约正确
- 修复存储测试：repair_runs 表读写正确

- [ ] **Step 2: 运行探针**

Run: `node .superpowers/sdd/M72-计划/safe-run.mjs script ../server/scripts/probe-m72.ts`
Expected: exit 0，所有断言通过

- [ ] **Step 3: 运行全量探针**

Run: `node .superpowers/sdd/M72-计划/safe-run.mjs probe`
Expected: exit 0，全量探针通过

- [ ] **Step 4: 提交**

```bash
git add apps/server/scripts/probe-m72.ts
git commit -m "test: 修复探针实现（R06 修复闭环）"
```

---

## 任务 7：联调与文档

**Files:**
- Modify: `docs/records/路线图-roadmap.md`
- Modify: `docs/records/备选清单-post-M27-backlog.md`

**Interfaces:**
- Consumes: M72 所有交付物
- Produces: roadmap 更新 + backlog 状态更新

- [ ] **Step 1: 运行全量验证**

```bash
# server tsc
node .superpowers/sdd/M72-计划/safe-run.mjs server

# web tsc
node .superpowers/sdd/M72-计划/safe-run.mjs web

# 全量探针
node .superpowers/sdd/M72-计划/safe-run.mjs probe

# git diff check
git diff --check
```

Expected: 全部 exit 0

- [ ] **Step 2: 更新 roadmap**

在 `docs/records/路线图-roadmap.md` 新增 M72 节：

```markdown
## M72：定向返修闭环（2026-11-02）

**目标**：实现 R06 定向返修闭环（问题报告 → 修复建议 → 影响评估 → 用户批准 → 定向重跑 → 复检 → 采纳/保留）

**交付**：
- repair_runs 表：跟踪修复流程状态
- 修复建议服务：基于质量分生成修复建议
- 修复执行服务：定向重跑 + 重新评分 + 停止条件
- 修复端点：POST/GET /runs/:id/repair、POST /repairs/:id/*
- 修复 UI：RepairPanel.vue 组件
- 修复探针：probe-m72.ts

**验收**：全量探针 exit 0，server/web tsc exit 0

**后续**：M73 多阶段质量检查（R05）
```

- [ ] **Step 3: 更新 backlog**

在 `docs/records/备选清单-post-M27-backlog.md` 更新 R06 状态：

```markdown
| R06 | P1 | 有预算上限的定向返修闭环 **（M72 已交付）** | 审核问题能转成受控修复，保留好镜头和历史选择 | M27、R02、R05；既有单镜重生成与选片 |
```

- [ ] **Step 4: 提交**

```bash
git add docs/records/路线图-roadmap.md docs/records/备选清单-post-M27-backlog.md
git commit -m "docs: M72 联调与文档更新"
```

---

## 执行顺序

1. **任务 1**（表设计与迁移）：无依赖
2. **任务 2**（修复建议服务）：依赖任务 1
3. **任务 3**（修复执行服务）：依赖任务 2
4. **任务 4**（修复端点）：依赖任务 3
5. **任务 5**（修复 UI）：依赖任务 4
6. **任务 6**（修复探针）：依赖任务 4
7. **任务 7**（联调与文档）：依赖任务 1-6 全部完成

---

## 验收清单

- [ ] 全量探针 exit 0（含新增 probe-m72）
- [ ] server tsc --noEmit exit 0
- [ ] web vue-tsc --noEmit exit 0
- [ ] git diff --check exit 0
- [ ] repair_runs 表创建成功
- [ ] 修复建议服务可生成建议
- [ ] 修复执行服务可执行定向重跑
- [ ] 修复端点契约正确
- [ ] 修复 UI 交互正常
- [ ] 停止条件触发正确
- [ ] roadmap 和 backlog 更新完成
