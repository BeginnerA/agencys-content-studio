# M73 多阶段质量检查实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 R05 统一多阶段质量检查（五阶段门 + 统一问题记录 + 门禁评估 + 人工豁免）

**Architecture:** 新增 `quality_issues` 表存储统一问题记录，`quality_gates` 表存储阶段门禁状态。`stage-check.ts` 编排五阶段检查器，`stage-check-adapters.ts` 适配现有 QC/delivery-cert/M71 评分结果为统一问题格式，`gate-eval.ts` 评估门禁并管理豁免。REST 端点触发检查和豁免操作，Vue 组件展示阶段门禁面板。

**Tech Stack:** Hono + Drizzle/libsql + Vue 3 + TypeScript + tsx-run 探针

**Spec:** docs/records/M73-多阶段质量检查-design.md

## Global Constraints

- 唯一验证入口：`node .superpowers/sdd/M73-计划/safe-run.mjs <kind>`（kinds: server/web/templates/probe/script/format/migration）
- 单文件 ≤800 行
- 不调用真实付费模型，不联网
- 注释与文案必须自解释（禁 M号·intg·阶段码·裸§节号·line·切片 等外部编号指针）
- 复用现有 QC 核验、delivery-cert 认证、质量评分服务
- Git 纪律：默认不代提交；用户里程碑明确授权可提交

---

## 文件结构映射

### 数据模型

| 文件 | 职责 |
|------|------|
| `apps/server/src/db/schema.ts` | 新增 qualityIssues + qualityGates 表定义 |
| `apps/server/drizzle/0006_m73_multi_stage_qc.sql` | 自动生成迁移 |

### 检查编排服务

| 文件 | 职责 |
|------|------|
| `apps/server/src/services/stage-check.ts` | 五阶段检查器注册表 + runAllStages + runStage |
| `apps/server/src/services/stage-check-adapters.ts` | QC/cert/score 结果适配为统一问题格式 |

### 门禁评估服务

| 文件 | 职责 |
|------|------|
| `apps/server/src/services/gate-eval.ts` | 门禁评估逻辑 + 豁免管理 + 重新评估 |

### 门禁端点

| 文件 | 职责 |
|------|------|
| `apps/server/src/routes/quality-gates.ts` | POST/GET 门禁端点 + 豁免端点 |
| `apps/server/src/app.ts` | 注册 qualityGatesRoutes |

### 门禁 UI

| 文件 | 职责 |
|------|------|
| `apps/web/src/components/run/QualityGatePanel.vue` | 阶段时间线 + 问题列表 + 豁免操作 |
| `apps/web/src/views/run-detail/index.vue` | 集成质量门禁标签页 |
| `apps/web/src/lib/api/runs.ts` | 新增 qualityGatesApi |

### 门禁探针

| 文件 | 职责 |
|------|------|
| `apps/server/scripts/probe-m73.ts` | 覆盖服务 + 适配器 + 门禁 + 端点 + 存储 |

---

## 任务 1：quality_issues + quality_gates 表设计与迁移

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/drizzle/0006_m73_multi_stage_qc.sql`（自动生成）

**Interfaces:**
- Consumes: Drizzle schema 定义模式
- Produces: qualityIssues + qualityGates 表 + 索引

- [ ] **Step 1: 读取现有 schema.ts**

读取 `apps/server/src/db/schema.ts`，理解表定义模式和命名规范。注意 repairRuns 表是最后一张表（约 line 817 附近）。

- [ ] **Step 2: 新增 qualityIssues 表定义**

在 schema.ts 末尾（repairRuns 之后）新增：

```typescript
// ---------- R05 多阶段质量检查（统一问题记录 + 阶段门禁） ----------

/** 质量检查阶段：大纲→分集→分场→台词→成片。 */
export type QualityStage = 'outline' | 'episode' | 'scene' | 'dialogue' | 'final'

/** 问题严重度：blocking 阻断门禁 / warning 不阻断但需注意 / info 仅记录。 */
export type QualitySeverity = 'blocking' | 'warning' | 'info'

/** 检查类型：deterministic 确定性检查 / subjective 主观评价。 */
export type QualityCheckType = 'deterministic' | 'subjective'

/** 质量检查问题记录：每条问题关联到具体的 run、集、阶段、检查器、目标对象。
 *  exempted 标记是否已人工豁免，豁免后门禁状态从 fail 变为 exempt。 */
export const qualityIssues = sqliteTable(
  'quality_issues',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id').notNull().references(() => pipelineRuns.id),
    episodeIdx: integer('episode_idx').notNull(),
    stage: text('stage').notNull(),        // outline|episode|scene|dialogue|final
    checker: text('checker').notNull(),     // 检查器标识（如 'qc.duration_vs_timeline'）
    dimension: text('dimension').notNull(), // citation|consistency|coherence|cost|technical|delivery
    severity: text('severity').notNull(),   // blocking|warning|info
    checkType: text('check_type').notNull(), // deterministic|subjective
    targetType: text('target_type'),        // episode|shot|dialogue|asset|timeline
    targetId: text('target_id'),            // 具体对象 ID
    evidence: text('evidence').notNull(),   // JSON：实测值、期望值、差异描述
    suggestion: text('suggestion'),         // 修复建议文案
    exempted: integer('exempted').notNull().default(0),
    exemptedBy: text('exempted_by'),
    exemptedAt: integer('exempted_at'),
    exemptReason: text('exempt_reason'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_quality_issues_run').on(t.runId),
    index('idx_quality_issues_stage').on(t.runId, t.stage),
    index('idx_quality_issues_severity').on(t.runId, t.severity),
  ],
)

export type QualityIssue = typeof qualityIssues.$inferSelect
```

- [ ] **Step 3: 新增 qualityGates 表定义**

紧接 qualityIssues 之后：

```typescript
/** 阶段门禁状态：汇总每个 (run, episode, stage) 的阻断/警告/豁免问题数。
 *  status 由评估逻辑维护：pending=未检查 / pass=通过 / fail=有未豁免阻断问题 / exempt=阻断问题已全部豁免。 */
export const qualityGates = sqliteTable(
  'quality_gates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id').notNull().references(() => pipelineRuns.id),
    episodeIdx: integer('episode_idx').notNull(),
    stage: text('stage').notNull(),
    status: text('status').notNull().default('pending'), // pending|pass|fail|exempt
    blockingCount: integer('blocking_count').notNull().default(0),
    warningCount: integer('warning_count').notNull().default(0),
    exemptCount: integer('exempt_count').notNull().default(0),
    checkedAt: integer('checked_at'),
  },
  (t) => [
    index('idx_quality_gates_run').on(t.runId),
    uniqueIndex('idx_quality_gates_unique').on(t.runId, t.episodeIdx, t.stage),
  ],
)

export type QualityGate = typeof qualityGates.$inferSelect
```

- [ ] **Step 4: 生成迁移**

Run: `node .superpowers/sdd/M73-计划/safe-run.mjs migration`
Expected: exit 0，生成 SQL 迁移文件

- [ ] **Step 5: 运行 server tsc**

Run: `node .superpowers/sdd/M73-计划/safe-run.mjs server`
Expected: exit 0

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/db/schema.ts apps/server/drizzle/
git commit -m "feat: quality_issues + quality_gates 表设计与迁移（R05 多阶段质量检查）"
```

---

## 任务 2：stage-check.ts 检查编排服务

**Files:**
- Create: `apps/server/src/services/stage-check.ts`

**Interfaces:**
- Consumes: qualityIssues + qualityGates 表、QC 报告、delivery-cert 报告、质量评分
- Produces: runAllStages + runStage 函数 + StageChecker 注册表

- [ ] **Step 1: 创建 stage-check.ts 骨架**

```typescript
import { db } from '../db/index.js'
import { qualityIssues, qualityGates } from '../db/schema.js'
import { eq, and } from 'drizzle-orm'
import { adaptQcToIssues, adaptCertToIssues, adaptScoreToIssues } from './stage-check-adapters.js'

export type Stage = 'outline' | 'episode' | 'scene' | 'dialogue' | 'final'
export type Severity = 'blocking' | 'warning' | 'info'
export type CheckType = 'deterministic' | 'subjective'

export interface QualityIssueInput {
  runId: number
  episodeIdx: number
  stage: Stage
  checker: string
  dimension: string
  severity: Severity
  checkType: CheckType
  targetType?: string
  targetId?: string
  evidence: Record<string, unknown>
  suggestion?: string
}

export interface GateStatus {
  runId: number
  episodeIdx: number
  stage: Stage
  status: 'pending' | 'pass' | 'fail' | 'exempt'
  blockingCount: number
  warningCount: number
  exemptCount: number
  checkedAt?: number
}

interface StageChecker {
  stage: Stage
  name: string
  dimension: string
  severity: Severity
  checkType: CheckType
  check: (runId: number, episodeIdx: number) => Promise<QualityIssueInput[]>
}
```

- [ ] **Step 2: 实现各阶段检查器**

```typescript
// 大纲阶段：检查内容版本完整性
const checkContentCompleteness: StageChecker['check'] = async (runId, episodeIdx) => {
  // 查询 content_versions 中本集是否有 completed 状态的版本
  // 如果没有 → 产出 blocking 问题
  // 实现细节由子代理根据实际 schema 填充
  return []
}

// 分集阶段：检查连续性台账确认率
const checkContinuityConfirmed: StageChecker['check'] = async (runId, episodeIdx) => {
  // 查询 continuity 台账中本集相关的  // 如果确认率 < 80% → 产出 blocking 问题
  // 实现细节由子代理根据实际 schema 填充
  return []
}

// 分场阶段：检查执行快照覆盖率
const checkSnapshotCoverage: StageChecker['check'] = async (runId, episodeIdx) => {
  // 查询 exec_snapshots 中本集的快照数
  // 如果覆盖率 < 100% → 产出 warning 问题
  // 实现细节由子代理根据实际 schema 填充
  return []
}

// 台词阶段：检查 QC 字幕对齐
const checkSubtitleAlignment: StageChecker['check'] = async (runId, episodeIdx) => {
  // 调用 runQcCheck 并适配结果
  // 实现细节由子代理根据实际 QC 服务填充
  return []
}

// 台词阶段：检查审片问题
const checkReviewFindings: StageChecker['check'] = async (runId, episodeIdx) => {
  // 查询 review_findings 中本集的未解决问题
  // 如果有未解决问题 → 产出 warning 问题
  // 实现细节由子代理根据实际 schema 填充
  return []
}

// 成片阶段：检查 QC 核验
const checkQcVerdict: StageChecker['check'] = async (runId, episodeIdx) => {
  // 调用 runQcCheck 并适配结果
  // 如果 verdict !== 'ready' → 产出 blocking 问题
  // 实现细节由子代理根据实际 QC 服务填充
  return []
}

// 成片阶段：检查交付认证
const checkDeliveryCert: StageChecker['check'] = async (runId, episodeIdx) => {
  // 调用 certifyDelivery 并适配结果
  // 如果 verdict !== 'package_sound' → 产出 blocking 问题
  // 实现细节由子代理根据实际 cert 服务填充
  return []
}

// 成片阶段：检查质量评分
const checkQualityScore: StageChecker['check'] = async (runId, episodeIdx) => {
  // 调用 scoreQuality 并适配结果
  // 如果 overallScore < 0.7 → 产出 warning 问题
  return adaptScoreToIssues(runId, episodeIdx)
}
```

- [ ] **Step 3: 注册检查器并实现 runAllStages**

```typescript
const CHECKERS: StageChecker[] = [
  { stage: 'outline', name: 'content.completeness', dimension: 'coherence', severity: 'blocking', checkType: 'deterministic', check: checkContentCompleteness },
  { stage: 'episode', name: 'continuity.confirmed', dimension: 'consistency', severity: 'blocking', checkType: 'deterministic', check: checkContinuityConfirmed },
  { stage: 'scene', name: 'snapshot.coverage', dimension: 'citation', severity: 'warning', checkType: 'deterministic', check: checkSnapshotCoverage },
  { stage: 'dialogue', name: 'qc.subtitle_alignment', dimension: 'technical', severity: 'blocking', checkType: 'deterministic', check: checkSubtitleAlignment },
  { stage: 'dialogue', name: 'review.findings', dimension: 'coherence', severity: 'warning', checkType: 'subjective', check: checkReviewFindings },
  { stage: 'final', name: 'qc.verdict', dimension: 'technical', severity: 'blocking', checkType: 'deterministic', check: checkQcVerdict },
  { stage: 'final', name: 'delivery.cert', dimension: 'delivery', severity: 'blocking', checkType: 'deterministic', check: checkDeliveryCert },
  { stage: 'final', name: 'quality.score', dimension: 'coherence', severity: 'warning', checkType: 'subjective', check: checkQualityScore },
]

export async function runAllStages(runId: number, episodeIdx: number): Promise<GateStatus[]> {
  const stages: Stage[] = ['outline', 'episode', 'scene', 'dialogue', 'final']
  const results: GateStatus[] = []
  for (const stage of stages) {
    const status = await runStage(runId, episodeIdx, stage)
    results.push(status)
  }
  return results
}

export async function runStage(runId: number, episodeIdx: number, stage: Stage): Promise<GateStatus> {
  const checkers = CHECKERS.filter(c => c.stage === stage)
  const allIssues: QualityIssueInput[] = []
  
  // 并行执行本阶段的所有检查器
  const results = await Promise.all(checkers.map(c => c.check(runId, episodeIdx)))
  for (const issues of results) {
    allIssues.push(...issues)
  }
  
  // 写入 quality_issues 表
  const now = Date.now()
  for (const issue of allIssues) {
    await db.insert(qualityIssues).values({
      ...issue,
      evidence: JSON.stringify(issue.evidence),
      exempted: 0,
      createdAt: now,
    })
  }
  
  // 评估门禁状态
  const blockingCount = allIssues.filter(i => i.severity === 'blocking').length
  const warningCount = allIssues.filter(i => i.severity === 'warning').length
  const status = blockingCount > 0 ? 'fail' : 'pass'
  
  // 写入 quality_gates 表（upsert）
  await db.insert(qualityGates).values({
    runId,
    episodeIdx,
    stage,
    status,
    blockingCount,
    warningCount,
    exemptCount: 0,
    checkedAt: now,
  }).onConflictDoUpdate({
    target: [qualityGates.runId, qualityGates.episodeIdx, qualityGates.stage],
    set: { status, blockingCount, warningCount, checkedAt: now },
  })
  
  return { runId, episodeIdx, stage, status, blockingCount, warningCount, exemptCount: 0, checkedAt: now }
}
```

- [ ] **Step 4: 运行 server tsc**

Run: `node .superpowers/sdd/M73-计划/safe-run.mjs server`
Expected: exit 0

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/services/stage-check.ts
git commit -m "feat: 检查编排服务（R05 多阶段质量检查）"
```

---

## 任务 3：QC/cert/score 适配器

**Files:**
- Create: `apps/server/src/services/stage-check-adapters.ts`

**Interfaces:**
- Consumes: QcReport、DeliveryCert、QualityScoreResult 类型
- Produces: adaptQcToIssues + adaptCertToIssues + adaptScoreToIssues 函数

- [ ] **Step 1: 创建 stage-check-adapters.ts**

参考设计稿 §3.4 的适配器代码，实现三个适配函数。注意：
- QC 报告适配需要 inferStageFromQcKey 映射函数
- delivery-cert 报告全部归入 final 阶段
- M71 评分适配的阈值 = 0.7（低于 70 分视为问题）

```typescript
import type { QcReport, QcCheck } from './qc/types.js'
import type { DeliveryCert, CertCheck } from './delivery-cert/types.js'
import type { QualityIssueInput, Stage } from './stage-check.js'

/** QC 检查项到质量阶段的映射。 */
function inferStageFromQcKey(key: QcCheck['key']): Stage {
  switch (key) {
    case 'file_readable':
    case 'stream_spec':
    case 'audio_peak':
    case 'delivery_flag':
    case 'manual_quality_review':
      return 'final'
    case 'duration_vs_timeline':
    case 'timeline_source':
    case 'shot_duration_applied':
    case 'subtitle_alignment_present':
    case 'rework_receipt_consistency':
      return 'dialogue'
    default:
      return 'final'
  }
}

export function adaptQcToIssues(runId: number, episodeIdx: number, report: QcReport): QualityIssueInput[] {
  return report.checks
    .filter(c => c.status === 'failed' || c.status === 'stale' || c.status === 'not_tested')
    .map(c => ({
      runId,
      episodeIdx,
      stage: inferStageFromQcKey(c.key),
      checker: `qc.${c.key}`,
      dimension: 'technical',
      severity: (c.status === 'failed' ? 'blocking' : 'warning') as 'blocking' | 'warning',
      checkType: (c.evidenceType === 'manual_review' ? 'subjective' : 'deterministic') as 'subjective' | 'deterministic',
      targetType: 'asset',
      targetId: String(report.finalAssetId),
      evidence: { key: c.key, status: c.status, value: c.value, reason: c.reason },
      suggestion: c.reason,
    }))
}

export function adaptCertToIssues(runId: number, episodeIdx: number, cert: DeliveryCert): QualityIssueInput[] {
  return cert.checks
    .filter(c => c.status === 'failed' || c.status === 'stale')
    .map(c => ({
      runId,
      episodeIdx,
      stage: 'final' as Stage,
      checker: `delivery.${c.key}`,
      dimension: 'delivery',
      severity: 'blocking' as const,
      checkType: (c.evidenceType === 'manual_review' ? 'subjective' : 'deterministic') as 'subjective' | 'deterministic',
      targetType: 'asset',
      targetId: cert.packageAssetId ? String(cert.packageAssetId) : undefined,
      evidence: { key: c.key, status: c.status, value: c.value, reason: c.reason },
      suggestion: c.reason,
    }))
}

export async function adaptScoreToIssues(runId: number, episodeIdx: number): Promise<QualityIssueInput[]> {
  // 调用 scoreQuality 获取评分结果
  const { scoreQuality } = await import('./eval-quality.js')
  const score = await scoreQuality({ runId, episodeIdx })
  
  const THRESHOLD = 0.7
  const issues: QualityIssueInput[] = []
  
  if (score.citationScore < THRESHOLD) {
    issues.push({
      runId, episodeIdx, stage: 'final', checker: 'quality.citation',
      dimension: 'citation', severity: 'warning', checkType: 'subjective',
      evidence: { score: score.citationScore, threshold: THRESHOLD },
      suggestion: '引文完整度不足：部分执行输入缺少版本指针',
    })
  }
  if (score.consistencyScore < THRESHOLD) {
    issues.push({
      runId, episodeIdx, stage: 'final', checker: 'quality.consistency',
      dimension: 'consistency', severity: 'warning', checkType: 'subjective',
      evidence: { score: score.consistencyScore, threshold: THRESHOLD },
      suggestion: '角色一致性不足：引用的实体版本存在不稳定状态',
    })
  }
  if (score.coherenceScore < THRESHOLD) {
    issues.push({
      runId, episodeIdx, stage: 'final', checker: 'quality.coherence',
      dimension: 'coherence', severity: 'warning', checkType: 'subjective',
      evidence: { score: score.coherenceScore, threshold: THRESHOLD },
      suggestion: '剧情连贯度不足：连续性台账中上下文记录未充分确认',
    })
  }
  if (score.costScore < THRESHOLD) {
    issues.push({
      runId, episodeIdx, stage: 'final', checker: 'quality.cost',
      dimension: 'cost', severity: 'info', checkType: 'deterministic',
      evidence: { score: score.costScore, threshold: THRESHOLD },
      suggestion: '费用效率不足：部分用量记录缺少计价信息',
    })
  }
  
  return issues
}
```

- [ ] **Step 2: 运行 server tsc**

Run: `node .superpowers/sdd/M73-计划/safe-run.mjs server`
Expected: exit 0

- [ ] **Step 3: 提交**

```bash
git add apps/server/src/services/stage-check-adapters.ts
git commit -m "feat: QC/cert/score 适配器（R05 多阶段质量检查）"
```

---

## 任务 4：gate-eval.ts 门禁评估服务

**Files:**
- Create: `apps/server/src/services/gate-eval.ts`

**Interfaces:**
- Consumes: qualityIssues + qualityGates 表
- Produces: exemptIssue + unexemptIssue + reevaluateGate 函数

- [ ] **Step 1: 创建 gate-eval.ts**

```typescript
import { db } from '../db/index.js'
import { qualityIssues, qualityGates } from '../db/schema.js'
import { eq, and } from 'drizzle-orm'
import type { GateStatus, Stage } from './stage-check.js'

/** 豁免一条阻断问题：标记 exempted=1，记录操作人和理由，然后重新评估门禁。 */
export async function exemptIssue(
  issueId: number,
  operator: string,
  reason: string
): Promise<GateStatus> {
  const issue = await db.query.qualityIssues.findFirst({
    where: eq(qualityIssues.id, issueId),
  })
  if (!issue) throw new Error('问题记录不存在')
  if (issue.severity !== 'blocking') throw new Error('只有阻断级问题可豁免')
  if (issue.exempted === 1) throw new Error('该问题已豁免')
  
  const now = Date.now()
  await db.update(qualityIssues)
    .set({ exempted: 1, exemptedBy: operator, exemptedAt: now, exemptReason: reason })
    .where(eq(qualityIssues.id, issueId))
  
  return reevaluateGate(issue.runId, issue.episodeIdx, issue.stage as Stage)
}

/** 取消豁免：标记 exempted=0，清除豁免信息，然后重新评估门禁。 */
export async function unexemptIssue(issueId: number): Promise<GateStatus> {
  const issue = await db.query.qualityIssues.findFirst({
    where: eq(qualityIssues.id, issueId),
  })
  if (!issue) throw new Error('问题记录不存在')
  if (issue.exempted !== 1) throw new Error('该问题未豁免')
  
  await db.update(qualityIssues)
    .set({ exempted: 0, exemptedBy: null, exemptedAt: null, exemptReason: null })
    .where(eq(qualityIssues.id, issueId))
  
  return reevaluateGate(issue.runId, issue.episodeIdx, issue.stage as Stage)
}

/** 重新评估阶段门禁：统计未豁免阻断问题数，更新门禁状态。 */
export async function reevaluateGate(
  runId: number,
  episodeIdx: number,
  stage: Stage
): Promise<GateStatus> {
  // 查询本阶段所有问题
  const issues = await db.select.query.qualityIssues
    .where(and(
      eq(qualityIssues.runId, runId),
      eq(qualityIssues.episodeIdx, episodeIdx),
      eq(qualityIssues.stage, stage),
 | undefined;
  const blockingIssues = allIssues.filter(i => i.severity === 'blocking')
  const unexemptedBlocking = blockingIssues.filter(i => i.exempted !== 1)
  const exemptedBlocking = blockingIssues.filter(i => i.exempted === 1)
  const warnings = allIssues.filter(i => i.severity === 'warning')
  
  let status: GateStatus['status']
  if (unexemptedBlocking.length > 0) {
    status = 'fail'
  } else if (exemptedBlocking.length > 0) {
    status = 'exempt'
  } else {
    status = 'pass'
  }
  
  const now = Date.now()
  await db.insert(qualityGates).values({
    runId,
    episodeIdx,
    stage,
    status,
    blockingCount: unexemptedBlocking.length,
    warningCount: warnings.length,
    exemptCount: exemptedBlocking.length,
    checkedAt: now,
  }).onConflictDoUpdate({
    target: [qualityGates.runId, qualityGates.episodeIdx, qualityGates.stage],
    set: { status, blockingCount: unexemptedBlocking.length, warningCount: warnings.length, exemptCount: exemptedBlocking.length, checkedAt: now },
  })
  
  return {
    runId,
    episodeIdx,
    stage,
    status,
    blockingCount: unexemptedBlocking.length,
    warningCount: warnings.length,
    exemptCount: exemptedBlocking.length,
    checkedAt: now,
  }
}
```

- [ ] **Step 2: 运行 server tsc**

Run: `node .superpowers/sdd/M73-计划/safe-run.mjs server`
Expected: exit 0

- [ ] **Step 3: 提交**

```bash
git add apps/server/src/services/gate-eval.ts
git commit -m "feat: 门禁评估服务（R05 多阶段质量检查）"
```

---

## 任务 5：质量门禁端点

**Files:**
- Create: `apps/server/src/routes/quality-gates.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: runAllStages、runStage、exemptIssue、unexemptIssue 服务
- Produces: POST/GET 门禁端点 + 豁免端点

- [ ] **Step 1: 创建 quality-gates.ts 路由**

```typescript
import { Hono } from 'hono'
import { runAllStages, runStage } from '../services/stage-check.js'
import { exemptIssue, unexemptIssue, reevaluateGate } from '../services/gate-eval.js'
import { db } from '../db/index.js'
import { qualityGates, qualityIssues } from '../db/schema.js'
import { eq, and } from 'drizzle-orm'
import type { Stage } from '../services/stage-check.js'

export const qualityGatesRoutes = new Hono()

// POST /runs/:id/quality-gates — 触发全阶段检查
qualityGatesRoutes.post('/runs/:id/quality-gates', async (c) => {
  const runId = parseInt(c.req.param('id'))
  const body = await c.req.json()
  const { episodeIdx } = body
  
  if (typeof episodeIdx !== 'number') {
    return c.json({ code: 'bad_request', message: 'episodeIdx 必须是数字' }, 400)
  }
  
  const gates = await runAllStages(runId, episodeIdx)
  return c.json({ gates }, 201)
})

// GET /runs/:id/quality-gates — 查询全部阶段门禁状态
qualityGatesRoutes.get('/runs/:id/quality-gates', async (c) => {
  const runId = parseInt(c.req.param('id'))
  const episodeIdx = parseInt(c.req.query('episodeIdx') || '0')
  
  const gates = await db.query.qualityGates.findMany({
    where: and(
      eq(qualityGates.runId, runId),
      eq(qualityGates.episodeIdx, episodeIdx),
    ),
  })
  
  return c.json({ gates })
})

// GET /runs/:id/quality-gates/:stage — 查询单阶段门禁状态 + 问题列表
qualityGatesRoutes.get('/runs/:id/quality-gates/:stage', async (c) => {
  const runId = parseInt(c.req.param('id'))
  const stage = c.req.param('stage') as Stage
  const episodeIdx = parseInt(c.req.query('episodeIdx') || '0')
  
  const validStages: Stage[] = ['outline', 'episode', 'scene', 'dialogue', 'final']
  if (!validStages.includes(stage)) {
    return c.json({ code: 'bad_request', message: `无效阶段：${stage}` }, 400)
  }
  
  const gate = await db.query.qualityGates.findFirst({
    where: and(
      eq(qualityGates.runId, runId),
      eq(qualityGates.episodeIdx, episodeIdx),
      eq(qualityGates.stage, stage),
    ),
  })
  
  const issues = await db.query.qualityIssues.findMany({
    where: and(
      eq(qualityIssues.runId, runId),
      eq(qualityIssues.episodeIdx, episodeIdx),
      eq(qualityIssues.stage, stage),
    ),
  })
  
  if (!gate) {
    return c.json({ code: 'not_found', message: '门禁记录不存在' }, 404)
  }
  
  return c.json({
    gate: {
      ...gate,
      checkedAt: gate.checkedAt ? new Date(gate.checkedAt).toISOString() : undefined,
    },
    issues: issues.map(i => ({
      ...i,
      evidence: JSON.parse(i.evidence),
      createdAt: new Date(i.createdAt).toISOString(),
      exemptedAt: i.exemptedAt ? new Date(i.exemptedAt).toISOString() : undefined,
    })),
  })
})

// POST /quality-gates/issues/:id/exempt — 豁免阻断问题
qualityGatesRoutes.post('/quality-gates/issues/:id/exempt', async (c) => {
  const issueId = parseInt(c.req.param('id'))
  const body = await c.req.json()
  const { reason } = body
  
  if (typeof reason !== 'string' || !reason.trim()) {
    return c.json({ code: 'bad_request', message: 'reason 必填' }, 400)
  }
  
  try {
    const gate = await exemptIssue(issueId, 'user', reason.trim())
    return c.json({ gate })
  } catch (err) {
    const message = err instanceof Error ? err.message : '豁免失败'
    return c.json({ code: 'bad_request', message }, 400)
  }
})

// POST /quality-gates/issues/:id/unexempt — 取消豁免
qualityGatesRoutes.post('/quality-gates/issues/:id/unexempt', async (c) => {
  const issueId = parseInt(c.req.param('id'))
  
  try {
    const gate = await unexemptIssue(issueId)
    return c.json({ gate })
  } catch (err) {
    const message = err instanceof Error ? err.message : '取消豁免失败'
    return c.json({ code: 'bad_request', message }, 400)
  }
})
```

- [ ] **Step 2: 注册路由到 app.ts**

读取 `apps/server/src/app.ts`，在 imports 区域添加：

```typescript
import { qualityGatesRoutes } from './routes/quality-gates'
```

在路由注册区域添加：

```typescript
app.route('/api', qualityGatesRoutes)
```

- [ ] **Step 3: 运行 server tsc**

Run: `node .superpowers/sdd/M73-计划/safe-run.mjs server`
Expected: exit 0

- [ ] **Step 4: 提交**

```bash
git add apps/server/src/routes/quality-gates.ts apps/server/src/app.ts
git commit -m "feat: 质量门禁端点（R05 多阶段质量检查）"
```

---

## 任务 6：QualityGatePanel.vue 前端面板

**Files:**
- Create: `apps/web/src/components/run/QualityGatePanel.vue`
- Modify: `apps/web/src/views/run-detail/index.vue`
- Modify: `apps/web/src/lib/api/runs.ts`

**Interfaces:**
- Consumes: POST/GET /runs/:id/quality-gates、POST /quality-gates/issues/:id/exempt|unexempt
- Produces: 阶段时间线 + 问题列表 + 豁免操作组件

- [ ] **Step 1: 在 runs.ts 新增 qualityGatesApi**

参考现有 qualityApi 和 repairsApi 的模式，新增：

```typescript
export const qualityGatesApi = {
  async triggerAll(runId: number, episodeIdx: number) {
    const res = await fetch(`/api/runs/${runId}/quality-gates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeIdx }),
    })
    if (!res.ok) throw new Error('触发检查失败')
    return res.json()
  },
  
  async getAll(runId: number, episodeIdx: number) {
    const res = await fetch(`/api/runs/${runId}/quality-gates?episodeIdx=${episodeIdx}`)
    if (!res.ok) throw new Error('查询门禁失败')
    return res.json()
  },
  
  async getStage(runId: number, stage: string, episodeIdx: number) {
    const res = await fetch(`/api/runs/${runId}/quality-gates/${stage}?episodeIdx=${episodeIdx}`)
    if (!res.ok) throw new Error('查询阶段失败')
    return res.json()
  },
  
  async exemptIssue(issueId: number, reason: string) {
    const res = await fetch(`/api/quality-gates/issues/${issueId}/exempt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    })
    if (!res.ok) throw new Error('豁免失败')
    return res.json()
  },
  
  async unexemptIssue(issueId: number) {
    const res = await fetch(`/api/quality-gates/issues/${issueId}/unexempt`, {
      method: 'POST',
    })
    if (!res.ok) throw new Error('取消豁免失败')
    return res.json()
  },
}
```

- [ ] **Step 2: 创建 QualityGatePanel.vue**

参考 QualityScorePanel.vue 和 RepairPanel.vue 的结构，实现：
- 阶段时间线（横向步骤条：outline → episode → scene → dialogue → final）
- 每阶段显示 pass/fail/exempt/pending 状态图标
- 点击阶段展开该阶段的问题列表
- 每条问题展示：检查器名、维度、严重度、证据摘要、目标位置、修复建议
- blocking 问题右侧显示「豁免」按钮（需输入理由）
- 已豁免问题显示豁免标记和理由
- 顶部「运行全部检查」按钮触发 POST

- [ ] **Step 3: 集成到 run-detail/index.vue**

在运行详情页新增「质量门禁」标签页（在「质量评分」「修复」标签页之后），显示 QualityGatePanel 组件。

- [ ] **Step 4: 运行 web tsc**

Run: `node .superpowers/sdd/M73-计划/safe-run.mjs web`
Expected: exit 0

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/run/QualityGatePanel.vue apps/web/src/views/run-detail/index.vue apps/web/src/lib/api/runs.ts
git commit -m "feat: 质量门禁 UI（R05 多阶段质量检查）"
```

---

## 任务 7：probe-m73.ts 探针

**Files:**
- Create: `apps/server/scripts/probe-m73.ts`
- Create: `apps/server/scripts/probes/m73/` 辅助文件

**Interfaces:**
- Consumes: 检查编排服务、适配器、门禁评估服务、REST 端点、数据库表
- Produces: 覆盖服务 + 适配器 + 门禁 + 端点 + 存储的探针

- [ ] **Step 1: 创建 probe-m73.ts 骨架**

参考 probe-m72.ts 的结构，实现以下测试节：

1. **服务节**：runAllStages 返回 5 个阶段状态
2. **适配器节**：QC/cert/score 适配为统一问题格式
3. **门禁节**：evaluateGate 逻辑（blocking>0→fail，全豁免→exempt，无 blocking→pass）
4. **存储节**：quality_issues + quality_gates 表读写正确
5. **端点节**：POST/GET 端点契约正确
6. **豁免节**：豁免/取消豁免端点正确更新门禁

- [ ] **Step 2: 运行探针**

Run: `node .superpowers/sdd/M73-计划/safe-run.mjs script ../server/scripts/probe-m73.ts`
Expected: exit 0，所有断言通过

- [ ] **Step 3: 运行全量探针**

Run: `node .superpowers/sdd/M73-计划/safe-run.mjs probe`
Expected: exit 0，全量探针通过

- [ ] **Step 4: 提交**

```bash
git add apps/server/scripts/probe-m73.ts apps/server/scripts/probes/m73/
git commit -m "test: 质量门禁探针（R05 多阶段质量检查）"
```

---

## 任务 8：联调与文档

**Files:**
- Modify: `docs/records/路线图-roadmap.md`
- Modify: `docs/records/备选清单-post-M27-backlog.md`

**Interfaces:**
- Consumes: M73 所有交付物
- Produces: roadmap 更新 + backlog 状态更新

- [ ] **Step 1: 运行全量验证**

```bash
# server tsc
node .superpowers/sdd/M73-计划/safe-run.mjs server

# web tsc
node .superpowers/sdd/M73-计划/safe-run.mjs web

# 全量探针
node .superpowers/sdd/M73-计划/safe-run.mjs probe

# git diff check
git diff --check
```

Expected: 全部 exit 0

- [ ] **Step 2: 更新 roadmap**

在 `docs/records/路线图-roadmap.md` 新增 M73 节：

```markdown
## M73：多阶段质量检查（2026-11-02）

**目标**：实现 R05 统一多阶段质量检查（五阶段门 + 统一问题记录 + 门禁评估 + 人工豁免）

**交付**：
- quality_issues 表：统一问题记录（含维度、严重度、证据、目标位置）
- quality_gates 表：阶段门禁状态汇总
- 检查编排服务：五阶段检查器注册表 + runAllStages
- 适配器服务：QC/cert/score 结果转换为统一问题格式
- 门禁评估服务：evaluateGate + exemptIssue + unexemptIssue
- 门禁端点：POST/GET /runs/:id/quality-gates + 豁免端点
- 门禁 UI：QualityGatePanel.vue 组件
- 门禁探针：probe-m73.ts

**验收**：全量探针 exit 0，server/web tsc exit 0

**后续**：M74 角色一致性工程化（R04）
```

- [ ] **Step 3: 更新 backlog**

在 `docs/records/备选清单-post-M27-backlog.md` 更新 R05 状态：

```markdown
| R05 | P1 | 统一的多阶段质量检查 **（M73 已交付）** | 问题能定位到章节/台词/镜头/资产，不只是一段审核文字 | M24/M25；R01 指标及 R02 版本 |
```

- [ ] **Step 4: 提交**

```bash
git add docs/records/路线图-roadmap.md docs/records/备选清单-post-M27-backlog.md
git commit -m "docs: M73 联调与文档更新"
```

---

## 执行顺序

1. **任务 1**（表设计与迁移）：无依赖
2. **任务 2**（检查编排服务 + 类型定义）：依赖任务 1。注意：共享类型（Stage/Severity/CheckType/QualityIssueInput/GateStatus）定义在此任务的 stage-check.ts 中，Task 3/4 从此文件导入
3. **任务 3**（适配器）：依赖任务 2（导入类型）
4. **任务 4**（门禁评估服务）：依赖任务 2（导入类型）
5. **任务 5**（门禁端点）：依赖任务 2、3、4
6. **任务 6**（门禁 UI）：依赖任务 5
7. **任务 7**（门禁探针）：依赖任务 5
8. **任务 8**（联调与文档）：依赖任务 1-7 全部完成

---

## 验收清单

- [ ] 全量探针 exit 0（含新增 probe-m73）
- [ ] server tsc --noEmit exit 0
- [ ] web vue-tsc --noEmit exit 0
- [ ] git diff --check exit 0
- [ ] quality_issues + quality_gates 表创建成功
- [ ] 五阶段检查器正确产出问题
- [ ] QC/cert/score 适配器正确转换
- [ ] 门禁评估逻辑正确（pass/fail/exempt）
- [ ] 豁免/取消豁免功能正确
- [ ] 门禁端点契约正确
- [ ] 门禁 UI 交互正常
- [ ] roadmap 和 backlog 更新完成
