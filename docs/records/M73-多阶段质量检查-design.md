# M73 设计规格：多阶段质量检查

> **状态**：待审核  
> **日期**：2026-11-02  
> **依赖**：M71 已交付（四维评分）、M72 已交付（定向返修）、QC/delivery-cert 已交付  
> **范围**：实现 R05 统一多阶段质量检查（五阶段门 + 统一问题记录 + 门禁评估 + 人工豁免）

## 1. 目标与验收

### 1.1 目标

1. **五阶段质量门**：把散落在 QC、delivery-cert、M71 评分中的检查结果编排为五个阶段（大纲→分集→分场→台词→成片），每个阶段有明确的检查项和门禁规则
2. **统一问题记录**：所有阶段的检查结果归入统一的问题模型（quality_issues），每条问题有维度、严重度、证据、目标位置和检查类型
3. **门禁评估**：每个阶段根据阻断级问题数量计算门禁状态（通过//待人工验收/未通过）
4. **人工豁免**：阻断级问题可经人工确认后豁免，门禁状态从"未通过"变为"待人工验收"
5. **问题定位**：从问题记录可直接定位到对应的集/镜头/台词/资产，不再只是一段审核文字

### 1.2 验收标准

**功能验收**

| 功能 | 验收条件 |
|------|---------|
| 阶段触发 | 可对任意 run 触发五阶段检查，每阶段独立运行 |
| 问题记录 | 所有检查发现的问题统一写入 quality_issues 表 |
| 门禁评估 | 每阶段根据阻断问题数计算 pass/fail/exempt 状态 |
| 人工豁免 | 可对阻断问题逐个豁免，豁免后门禁状态更新 |
| 问题定位 | 每条问题包含 target_type + target_id，可定位到具体对象 |
| 现有集成 | QC 检查结果和 delivery-cert 结果适配为统一问题格式 |
| 评分联动 | M71 四维评分低于阈值时自动生成分数维度的问题记录 |

**离线验证**

- 全量探针 exit 0（含新增 M73 探针）
- server tsc --noEmit exit 0
- web vue-tsc --noEmit exit 0
- git diff --check exit 0

## 2. 范围与边界

### 2.1 纳入范围

1. **质量阶段枚举**：定义 outline / episode / scene / dialogue / final 五阶段
2. **统一问题模型**：quality_issues 表 + QualityIssue 类型
3. **门禁状态模型**：quality_gates 表 + GateStatus 类型
4. **检查编排服务**：stage-check.ts，按阶段运行检查器并归集问题
5. **现有检查适配器**：把 QC 报告、delivery-cert 报告、M71 评分适配为统一问题
6. **门禁评估服务**：gate-eval.ts，根据问题和豁免计算门禁状态
7. **REST 端点**：触发检查、查询阶段状态、人工豁免
8. **前端面板**：QualityGatePanel.vue，展示五阶段门禁 + 问题列表 + 豁免操作
9. **探针**：probe-m73.ts，覆盖服务 + 端点 + 存储 + 门禁逻辑

### 2.2 明确排除

1. **不调用真实付费模型**：所有检查使用零模型确定性逻辑 + 已有检查结果
2. **不改既有 QC/delivery-cert 内部逻辑**：只在它们之上加适配层
3. **不做流水线自动阻断**：阶段门禁只报告状态，不自动暂停流水线执行
4. **不做定向返修**（M72 范围）：M73 只检查和报告，不修复
5. **不做角色一致性工程化**（M74 范围）：M73 只复用 M71 评分中的角色一致性维度

### 2.3 依赖与复用

| 依赖 | 复用方式 |
|------|---------|
| M71 质量评分 | quality_scores 表 + scoreQuality 服务 → final 阶段评分检查 |
| M72 修复建议 | repair-service 的 DIMENSION_SUGGESTIONS → 问题建议文案复用 |
| QC 核验 | services/qc/report.ts 的 runQcCheck → dialogue/final 阶段技术检查 |
| delivery-cert | services/delivery-cert/certify.ts → final 阶段交付检查 |
| M70 连续性 | continuity 台账状态 → episode/scene 阶段一致性检查 |
| M69 审片 | review_findings 表 → dialogue 阶段审片问题导入 |
| M29 版本链 | exec_inputs / content_versions → 各阶段引文检查 |

## 3. 架构设计

### 3.1 五阶段定义

| 阶段 | 枚举值 | 检查内容 | 数据来源 |
|------|--------|---------|---------|
| 大纲 | `outline` | 剧本结构完整性、章节覆盖、事件提取完整性 | review 服务 + 内容版本状态 |
| 分集 | `episode` | 跨集状态一致性、连续性台账确认率 | M70 continuity 状态 |
| 分场 | `scene` | 分镜可剪辑性、镜头时长合理性、角色位置一致 | exec_snapshots + 连续性 |
| 台词 | `dialogue` | 字幕时序对齐、台词覆盖率、审片问题 | QC consistency + review_findings |
| 成片 | `final` | 技术质量（QC）、交付认证、四维评分达标 | QC report + delivery-cert + M71 |

### 3.2 数据模型

**新增表：`quality_issues`**

```sql
CREATE TABLE quality_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
  episode_idx INTEGER NOT NULL,
  stage TEXT NOT NULL,          -- outline|episode|scene|dialogue|final
  checker TEXT NOT NULL,        -- 检查器标识（如 'qc.duration_vs_timeline'）
  dimension TEXT NOT NULL,      -- citation|consistency|coherence|cost|technical|delivery
  severity TEXT NOT NULL,       -- blocking|warning|info
  check_type TEXT NOT NULL,     -- deterministic|subjective
  target_type TEXT,             -- episode|shot|dialogue|asset|timeline（可空）
  target_id TEXT,               -- 具体对象 ID（可空）
  evidence TEXT NOT NULL,       -- JSON：实测值、期望值、差异描述
  suggestion TEXT,              -- 修复建议文案
  exempted INTEGER NOT NULL DEFAULT 0,  -- 0=未豁免, 1=已豁免
  exempted_by TEXT,             -- 豁免操作人
  exempted_at INTEGER,          -- 豁免时间戳
  exempt_reason TEXT,           -- 豁免理由
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_quality_issues_run ON quality_issues(run_id);
CREATE INDEX idx_quality_issues_stage ON quality_issues(run_id, stage);
CREATE INDEX idx_quality_issues_severity ON quality_issues(run_id, severity);
```

**新增表：`quality_gates`**

```sql
CREATE TABLE quality_gates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
  episode_idx INTEGER NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|pass|fail|exempt
  blocking_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  exempt_count INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER,
  UNIQUE(run_id, episode_idx, stage)
);

CREATE INDEX idx_quality_gates_run ON quality_gates(run_id);
```

**设计决策**

- quality_issues 记录每条具体问题，可直接定位到对象（target_type + target_id）
- quality_gates 记录每阶段的门禁汇总状态，与 quality_issues 通过 (run_id, episode_idx, stage) 关联
- exempted 字段在问题级别：可逐个豁免阻断问题，豁免后重新评估门禁
- severity 分三级：blocking（阻断门禁）、warning（不阻断但需注意）、info（仅记录）
- check_type 区分确定性检查和主观评价，前端可按类型过滤

### 3.3 服务层

**新增服务：`stage-check.ts`**

```typescript
export type Stage = 'outline' | 'episode' | 'scene' | 'dialogue' | 'final'
export type Severity = 'blocking' | 'warning' | 'info'
export type CheckType = 'deterministic' | 'subjective'

export interface QualityIssue {
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

/** 运行指定 run/集的全部阶段检查 */
export async function runAllStages(runId: number, episodeIdx: number): Promise<GateStatus[]>

/** 运行单个阶段检查 */
export async function runStage(runId: number, episodeIdx: number, stage: Stage): Promise<GateStatus>

/** 豁免一条阻断问题 */
export async function exemptIssue(issueId: number, operator: string, reason: string): Promise<void>

/** 重新评估阶段门禁（豁免变更后调用） */
export async function reevaluateGate(runId: number, episodeIdx: number, stage: Stage): Promise<GateStatus>
```

**检查器注册表**

```typescript
interface StageChecker {
  stage: Stage
  name: string              // 如 'qc.duration_vs_timeline'
  dimension: string
  severity: Severity
  checkType: CheckType
  check: (runId: number, episodeIdx: number) => Promise<QualityIssue[]>
}

const CHECKERS: StageChecker[] = [
  // outline 阶段
  { stage: 'outline', name: 'content.completeness', dimension: 'coherence', severity: 'blocking', checkType: 'deterministic', check: checkContentCompleteness },
  // episode 阶段
  { stage: 'episode', name: 'continuity.confirmed', dimension: 'consistency', severity: 'blocking', checkType: 'deterministic', check: checkContinuityConfirmed },
  // scene 阶段
  { stage: 'scene', name: 'snapshot.coverage', dimension: 'citation', severity: 'warning', checkType: 'deterministic', check: checkSnapshotCoverage },
  // dialogue 阶段
  { stage: 'dialogue', name: 'qc.subtitle_alignment', dimension: 'technical', severity: 'blocking', checkType: 'deterministic', check: checkSubtitleAlignment },
  { stage: 'dialogue', name: 'review.findings', dimension: 'coherence', severity: 'warning', checkType: 'subjective', check: checkReviewFindings },
  // final 阶段
  { stage: 'final', name: 'qc.verdict', dimension: 'technical', severity: 'blocking', checkType: 'deterministic', check: checkQcVerdict },
  { stage: 'final', name: 'delivery.cert', dimension: 'delivery', severity: 'blocking', checkType: 'deterministic', check: checkDeliveryCert },
  { stage: 'final', name: 'quality.score', dimension: 'coherence', severity: 'warning', checkType: 'subjective', check: checkQualityScore },
]
```

**门禁评估逻辑**

```typescript
function evaluateGate(issues: QualityIssue[], exemptions: Map<number, boolean>): GateStatus {
  const blocking = issues.filter(i => i.severity === 'blocking')
  const unexemptedBlocking = blocking.filter(i => !exemptions.get(i.id))
  const warnings = issues.filter(i => i.severity === 'warning')
  const exempted = blocking.filter(i => exemptions.get(i.id))
  
  let status: GateStatus['status']
  if (unexemptedBlocking.length > 0) {
    status = 'fail'
  } else if (exempted.length > 0) {
    status = 'exempt'
  } else {
    status = 'pass'
  }
  
  return {
    status,
    blockingCount: unexemptedBlocking.length,
    warningCount: warnings.length,
    exemptCount: exempted.length,
  }
}
```

### 3.4 现有检查适配器

**QC 报告适配**

```typescript
function adaptQcToIssues(runId: number, episodeIdx: number, report: QcReport): QualityIssue[] {
  return report.checks
    .filter(c => c.status === 'failed' || c.status === 'stale' || c.status === 'not_tested')
    .map(c => ({
      runId,
      episodeIdx,
      stage: inferStageFromQcKey(c.key),  // duration_vs_timeline→dialogue, file_readable→final, etc.
      checker: `qc.${c.key}`,
      dimension: 'technical',
      severity: c.status === 'failed' ? 'blocking' : 'warning',
      checkType: c.evidenceType === 'manual_review' ? 'subjective' : 'deterministic',
      targetType: 'asset',
      targetId: String(report.finalAssetId),
      evidence: { key: c.key, status: c.status, value: c.value, reason: c.reason },
      suggestion: c.reason,
    }))
}
```

**delivery-cert 适配**

```typescript
function adaptCertToIssues(runId: number, episodeIdx: number, cert: DeliveryCert): QualityIssue[] {
  return cert.checks
    .filter(c => c.status === 'failed' || c.status === 'stale')
    .map(c => ({
      runId,
      episodeIdx,
      stage: 'final',
      checker: `delivery.${c.key}`,
      dimension: 'delivery',
      severity: 'blocking',
      checkType: c.evidenceType === 'manual_review' ? 'subjective' : 'deterministic',
      targetType: 'asset',
      targetId: cert.packageAssetId ? String(cert.packageAssetId) : undefined,
      evidence: { key: c.key, status: c.status, value: c.value, reason: c.reason },
      suggestion: c.reason,
    }))
}
```

**M71 评分适配**

```typescript
function adaptScoreToIssues(runId: number, episodeIdx: number, score: QualityScoreResult): QualityIssue[] {
  const THRESHOLD = 0.7  // 低于 70 分视为问题
  const issues: QualityIssue[] = []
  
  if (score.citationScore < THRESHOLD) {
    issues.push({ runId, episodeIdx, stage: 'final', checker: 'quality.citation', dimension: 'citation', severity: 'warning', checkType: 'subjective', evidence: { score: score.citationScore, threshold: THRESHOLD }, suggestion: '引文完整度不足，部分执行输入缺少版本指针' })
  }
  if (score.consistencyScore < THRESHOLD) {
    issues.push({ runId, episodeIdx, stage: 'final', checker: 'quality.consistency', dimension: 'consistency', severity: 'warning', checkType: 'subjective', evidence: { score: score.consistencyScore, threshold: THRESHOLD }, suggestion: '角色一致性不足，引用的实体版本存在不稳定状态' })
  }
  if (score.coherenceScore < THRESHOLD) {
    issues.push({ runId, episodeIdx, stage: 'final', checker: 'quality.coherence', dimension: 'coherence', severity: 'warning', checkType: 'subjective', evidence: { score: score.coherenceScore, threshold: THRESHOLD }, suggestion: '剧情连贯度不足，连续性台账中上下文记录未充分确认' })
  }
  if (score.costScore < THRESHOLD) {
    issues.push({ runId, episodeIdx, stage: 'final', checker: 'quality.cost', dimension: 'cost', severity: 'info', checkType: 'deterministic', evidence: { score: score.costScore, threshold: THRESHOLD }, suggestion: '费用效率不足，部分用量记录缺少计价信息' })
  }
  
  return issues
}
```

### 3.5 API 层

**新增端点**

```typescript
// 触发全阶段检查
POST /runs/:id/quality-gates
Body: { episodeIdx: number }
Response: { gates: GateStatus[] }

// 查询单阶段门禁状态
GET /runs/:id/quality-gates/:stage?episodeIdx=0
Response: { gate: GateStatus, issues: QualityIssue[] }

// 查询全部阶段门禁状态
GET /runs/:id/quality-gates?episodeIdx=0
Response: { gates: GateStatus[] }

// 豁免阻断问题
POST /quality-gates/issues/:id/exempt
Body: { reason: string }
Response: { gate: GateStatus }  // 返回更新后的门禁状态

// 取消豁免
POST /quality-gates/issues/:id/unexempt
Response: { gate: GateStatus }
```

**设计决策**

- POST /runs/:id/quality-gates 触发检查，检查完成后写入 quality_issues 和 quality_gates
- GET 端点只读查询，不触发重新计算
- 豁免操作在问题级别，每次豁免后自动重新评估所属阶段的门禁
- 错误信封：run 不存在返回 404，阶段名非法返回 400

### 3.6 UI 层

**新增组件：`QualityGatePanel.vue`**

位置：run 详情页新增「质量门禁」标签页（在已有的「质量评分」「修复」标签页之后）

功能：
- 五阶段门禁状态总览（横向时间线：outline → episode → scene → dialogue → final）
- 每阶段显示 pass/fail/exempt/pending 状态图标
- 点击阶段展开该阶段的问题列表
- 每条问题展示：检查器名、维度、严重度、证据摘要、目标位置、修复建议
- blocking 问题右侧显示「豁免」按钮（需输入理由）
- 已豁免问题显示豁免标记和理由
- 顶部「运行全部检查」按钮触发 POST

**设计决策**

- 阶段时间线用横向步骤条，每阶段一个节点，颜色区分状态（绿=pass、红=fail、黄=exempt、灰=pending）
- 问题列表用卡片，按严重度排序（blocking 在前）
- 豁免按钮只在 blocking 问题上显示，warning/info 不需要豁免
- 与 M71 QualityScorePanel 和 M72 RepairPanel 并列，三个面板各自独立

### 3.7 探针层

**新增探针：`probe-m73.ts`**

覆盖：

| 节 | 断言 |
|---|------|
| 服务 | runAllStages 返回 5 个阶段状态 |
| 服务 | 各阶段检查器正确产出问题 |
| 服务 | 门禁评估逻辑：blocking>0→fail，全豁免→exempt，无 blocking→pass |
| 存储 | quality_issues 表读写正确 |
| 存储 | quality_gates 表读写正确 |
| 端点 | POST/GET 端点契约正确 |
| 端点 | 豁免/取消豁免端点正确更新门禁 |
| 集成 | QC 报告适配为统一问题格式 |
| 集成 | delivery-cert 适配为统一问题格式 |
| 集成 | M71 评分适配为统一问题格式 |

**设计决策**

- 离线探针：不调用真实模型，不联网
- 适配器测试：构造模拟 QC/cert/score 数据，验证产出的问题格式正确
- 门禁测试：构造不同严重度组合，验证 pass/fail/exempt 判定正确

## 4. 任务拆分

### 4.1 数据模型与迁移（1 项）

**任务 1：quality_issues + quality_gates 表设计与迁移**
- 文件：
  - `apps/server/src/db/schema.ts`（新增表定义）
  - `apps/server/drizzle/0006_m73_multi_stage_qc.sql`（自动生成迁移）
- 内容：两张表结构 + 索引
- 验收：迁移可执行

### 4.2 检查编排服务（1 项）

**任务 2：stage-check.ts 实现**
- 文件：`apps/server/src/services/stage-check.ts`
- 内容：检查器注册表 + runAllStages + runStage + 各阶段检查器实现
- 验收：五阶段检查器正确产出问题

### 4.3 现有检查适配器（1 项）

**任务 3：QC/cert/score 适配器**
- 文件：`apps/server/src/services/stage-check-adapters.ts`
- 内容：adaptQcToIssues + adaptCertToIssues + adaptScoreToIssues
- 验收：三种现有检查结果正确转换为统一问题

### 4.4 门禁评估服务（1 项）

**任务 4：gate-eval.ts 实现**
- 文件：`apps/server/src/services/gate-eval.ts`
- 内容：evaluateGate + exemptIssue + unexemptIssue + reevaluateGate
- 验收：门禁逻辑正确（blocking→fail、全豁免→exempt、无 blocking→pass）

### 4.5 REST 端点（1 项）

**任务 5：质量门禁端点**
- 文件：`apps/server/src/routes/quality-gates.ts`（新建）
- 内容：POST/GET 门禁端点 + 豁免端点
- 验收：端点契约正确

### 4.6 前端面板（1 项）

**任务 6：QualityGatePanel.vue 实现**
- 文件：
  - `apps/web/src/components/run/QualityGatePanel.vue`（新增）
  - `apps/web/src/views/run-detail/index.vue`（集成）
  - `apps/web/src/lib/api/runs.ts`（新增门禁 API 调用）
- 内容：阶段时间线 + 问题列表 + 豁免操作
- 验收：UI 交互正确

### 4.7 探针（1 项）

**任务 7：probe-m73.ts 实现**
- 文件：`apps/server/scripts/probe-m73.ts` + 辅助文件
- 内容：覆盖服务 + 适配器 + 门禁 + 端点 + 存储
- 验收：全量探针 exit 0

### 4.8 联调与文档（1 项）

**任务 8：联调与文档**
- 文件：
  - `docs/records/路线图-roadmap.md`
  - `docs/records/备选清单-post-M27-backlog.md`
- 内容：全量验证 + 文档更新
- 验收：server/web tsc exit 0，全量探针 exit 0

### 4.9 总估时

| 类别 | 任务数 | 估时 |
|------|-------|------|
| 数据模型 | 1 | 1 小时 |
| 检查编排 | 1 | 3 小时 |
| 适配器 | 1 | 2 小时 |
| 门禁评估 | 1 | 2 小时 |
| REST 端点 | 1 | 2 小时 |
| 前端面板 | 1 | 3 小时 |
| 探针 | 1 | 2 小时 |
| 联调文档 | 1 | 1 小时 |
| **合计** | **8** | **16 小时** |

## 5. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| QC 报告与阶段映射不准确 | 问题归类错误 | inferStageFromQcKey 显式映射表，每个 QC key 对应唯一阶段 |
| 适配器遗漏检查项 | 问题漏报 | 适配器测试覆盖 QC 全部 QcCheckKey 和 CertCheckKey |
| 门禁评估逻辑边界 | 误判 pass/fail | 探针覆盖空问题列表、全 blocking、全豁免等边界场景 |
| 豁免后未重新评估 | 门禁状态过期 | exemptIssue/unexemptIssue 内部自动调用 reevaluateGate |
| 五阶段检查耗时过长 | 用户体验差 | 各阶段检查器并行执行（Promise.all），不串行等待 |

## 6. 后续工作

M73 完成后，后续里程碑：

- **M74**：角色一致性工程化（R04）

M73 的多阶段检查为 M74 的角色一致性追踪提供阶段框架和问题定位能力。

## 7. 参考

- M71 设计：`docs/records/M71-质量基线与缺口收尾-design.md`
- M72 设计：`docs/records/M72-定向返修闭环-design.md`
- QC 类型：`apps/server/src/services/qc/types.ts`
- delivery-cert 类型：`apps/server/src/services/delivery-cert/types.ts`
- 备选清单 R05：`docs/records/备选清单-post-M27-backlog.md`
