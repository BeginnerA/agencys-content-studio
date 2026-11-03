# M71 质量基线与缺口收尾实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收尾 M70 四项登记缺口 + 建立 R01 质量基线测量基础设施（四维评分 + 综合分 + 可复现性元数据）

**Architecture:** 新增 `quality_scores` 表存储评分结果，`eval-quality.ts` 服务实现四维评分计算（引文完整度/角色一致性/剧情连贯度/费用效率），REST 端点触发和查询评分，Vue 组件展示雷达图和权重调整。M70 缺口收尾独立于质量基线，可并行实施。

**Tech Stack:** Hono + Drizzle/libsql + Vue 3 + TypeScript + tsx-run 探针

**Spec:** docs/records/M71-质量基线与缺口收尾-design.md

## Global Constraints

- 唯一验证入口：`node .superpowers/sdd/M71-计划/safe-run.mjs <kind>`（kinds: server/web/templates/probe/script/format/migration）
- 单文件 ≤800 行
- 不调用真实付费模型，不联网
- 注释与文案必须自解释（禁 M号·intg·阶段码·裸§节号·line·切片 等外部编号指针）
- 复用 M24 评测服务、M29 版本链、M70 连续性表
- Git 纪律：默认不代提交；用户里程碑明确授权可代提交

---

## 文件结构映射

### M70 缺口收尾

| 文件 | 职责 |
|------|------|
| `apps/server/scripts/probes/m70/resume.ts` | 新增引文漂移分支测试 |
| `apps/server/src/pipeline/invocation.ts` | 调用前 revalidatePack + configHash 比对 |
| `apps/server/src/routes/drafts.ts` | 新增 DELETE /drafts/:id 端点 |
| `apps/web/src/components/draft/DraftList.vue` | 新增删除按钮 |
| `apps/server/src/services/roles.ts` | personaFile 改为从数据库读取 |
| `apps/web/src/components/role/RoleEditor.vue` | 支持编辑 personaFile 引用 |

### R01 质量基线

| 文件 | 职责 |
|------|------|
| `apps/server/src/db/schema.ts` | 新增 quality_scores 表定义 |
| `apps/server/src/db/migrations/XXX_add_quality_scores.ts` | 新增迁移 |
| `apps/server/src/services/eval-quality.ts` | 四维评分 + 加权平均计算 |
| `apps/server/src/routes/runs.ts` | POST/GET /runs/:id/quality 端点 |
| `apps/web/src/components/run/QualityScorePanel.vue` | 雷达图 + 权重调整 + 元数据展示 |
| `apps/web/src/views/run/RunDetail.vue` | 集成质量评分标签页 |
| `apps/server/scripts/probe-m71.ts` | 覆盖服务 + 端点 + 存储 + 权重 + 元数据 |

---

## 任务 1：引文漂移分支专测（M70 缺口）

**Files:**
- Modify: `apps/server/scripts/probes/m70/resume.ts`

**Interfaces:**
- Consumes: M70 续跑探针框架、零模型复核逻辑
- Produces: 新增测试用例覆盖「删除原引文后零模型复核」路径

- [ ] **Step 1: 读取现有 resume 探针**

读取 `apps/server/scripts/probes/m70/resume.ts`，理解现有测试结构和断言模式。

- [ ] **Step 2: 新增引文漂移测试用例**

在 resume.ts 的合适位置新增测试节：

```typescript
// 引文漂移：删除原引文后零模型复核应 409
{
  const draft = await createDraftWithCitations(projectId, ['citation-1', 'citation-2'])
  await deleteCitation('citation-1')
  
  const result = await requestReview(draft.id)
  assert(result.status === 409, '删除引文后复核应返回 409')
  assert(result.body.code === 'bad_request', '错误信封 code 正确')
  assert(result.body.message === '请求处理失败', '错误信封 message 正确')
}
```

- [ ] **Step 3: 运行探针验证**

Run: `node .superpowers/sdd/M71-计划/safe-run.mjs probe ../server/scripts/probes/m70/resume.ts`
Expected: exit 0，新增断言通过

- [ ] **Step 4: 提交**

```bash
git add apps/server/scripts/probes/m70/resume.ts
git commit -m "test: 补充引文漂移分支专测（M70 缺口收尾）"
```

---

## 任务 2：templateKey 消费面识别（M70 缺口）

**Files:**
- Modify: `apps/server/src/pipeline/invocation.ts`

**Interfaces:**
- Consumes: 模板包加载逻辑、material/configHash 计算
- Produces: 调用前 revalidatePack + configHash 比对，付费派发前 409

- [ ] **Step 1: 读取 invocation.ts**

读取 `apps/server/src/pipeline/invocation.ts`，理解调用流程和 templateKey 使用位置。

- [ ] **Step 2: 在调用前增加重校验**

在付费派发前插入校验逻辑：

```typescript
// 调用前重校验：templateKey + material/configHash 比对
const currentPack = await loadTemplatePack(templateKey)
const currentHash = await computeConfigHash(currentPack)
if (currentHash !== originalConfigHash) {
  throw new HttpError(409, {
    code: 'bad_request',
    message: '请求处理失败'
  })
}
```

- [ ] **Step 3: 运行 server tsc**

Run: `node .superpowers/sdd/M71-计划/safe-run.mjs server`
Expected: exit 0

- [ ] **Step 4: 运行全量探针**

Run: `node .superpowers/sdd/M71-计划/safe-run.mjs probe`
Expected: exit 0，所有断言通过

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/pipeline/invocation.ts
git commit -m "fix: 调用前重校验 templateKey + configHash（M70 缺口收尾）"
```

---

## 任务 3：草稿删入口（M70 缺口）

**Files:**
- Modify: `apps/server/src/routes/drafts.ts`
- Modify: `apps/web/src/components/draft/DraftList.vue`

**Interfaces:**
- Consumes: 草稿 CRUD 逻辑、权限校验
- Produces: DELETE /drafts/:id 端点 + UI 删除按钮

- [ ] **Step 1: 读取现有 drafts 路由**

读取 `apps/server/src/routes/drafts.ts`，理解现有端点结构和权限校验模式。

- [ ] **Step 2: 新增 DELETE 端点**

```typescript
drafts.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const draft = await getDraft(id)
  if (!draft) {
    throw new HttpError(404, { code: 'not_found', message: '草稿不存在' })
  }
  
  // 权限校验：与编辑一致
  if (!hasEditPermission(draft, c.get('user'))) {
    throw new HttpError(403, { code: 'forbidden', message: '无权限' })
  }
  
  await deleteDraft(id)
  return c.json({ success: true })
})
```

- [ ] **Step 3: 读取 DraftList.vue**

读取 `apps/web/src/components/draft/DraftList.vue`，理解现有列表结构和按钮样式。

- [ ] **Step 4: 新增删除按钮**

```vue
<template>
  <div v-for="draft in drafts" :key="draft.id" class="draft-item">
    <span>{{ draft.title }}</span>
    <button @click="deleteDraft(draft.id)" class="btn btn-danger">删除</button>
  </div>
</template>

<script setup lang="ts">
async function deleteDraft(id: string) {
  if (!confirm('确定删除此草稿？')) return
  await fetch(`/drafts/${id}`, { method: 'DELETE' })
  // 刷新列表
  emit('refresh')
}
</script>
```

- [ ] **Step 5: 运行 server tsc**

Run: `node .superpowers/sdd/M71-计划/safe-run.mjs server`
Expected: exit 0

- [ ] **Step 6: 运行 web tsc**

Run: `node .superpowers/sdd/M71-计划/safe-run.mjs web`
Expected: exit 0

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/routes/drafts.ts apps/web/src/components/draft/DraftList.vue
git commit -m "feat: 草稿删除入口（M70 缺口收尾）"
```

---

## 任务 4：personaFile 动态化（M70 缺口）

**Files:**
- Modify: `apps/server/src/services/roles.ts`
- Modify: `apps/web/src/components/role/RoleEditor.vue`
- Modify: `apps/server/src/db/schema.ts`（如需新增字段）

**Interfaces:**
- Consumes: 角色服务、数据库读取
- Produces: personaFile 从数据库读取 + UI 编辑支持

- [ ] **Step 1: 读取 roles.ts**

读取 `apps/server/src/services/roles.ts`，理解现有 personaFile 写死逻辑。

- [ ] **Step 2: 改为从数据库读取**

```typescript
export async function getRolePersona(roleId: string): Promise<string> {
  const role = await db.query.roles.findFirst({
    where: eq(roles.id, roleId)
  })
  if (!role) {
    throw new Error('角色不存在')
  }
  return role.personaFile || defaultPersonaFile
}
```

- [ ] **Step 3: 读取 RoleEditor.vue**

读取 `apps/web/src/components/role/RoleEditor.vue`，理解现有编辑界面。

- [ ] **Step 4: 新增 personaFile 编辑字段**

```vue
<template>
  <div class="form-group">
    <label>人设文件引用</label>
    <select v-model="role.personaFile">
      <option v-for="file in personaFiles" :key="file" :value="file">
        {{ file }}
      </option>
    </select>
  </div>
</template>

<script setup lang="ts">
const personaFiles = ref<string[]>([])
onMounted(async () => {
  personaFiles.value = await fetch('/persona-files').then(r => r.json())
})
</script>
```

- [ ] **Step 5: 运行 server tsc**

Run: `node .superpowers/sdd/M71-计划/safe-run.mjs server`
Expected: exit 0

- [ ] **Step 6: 运行 web tsc**

Run: `node .superpowers/sdd/M71-计划/safe-run.mjs web`
Expected: exit 0

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/services/roles.ts apps/web/src/components/role/RoleEditor.vue
git commit -m "feat: personaFile 动态化（M70 缺口收尾）"
```

---

## 任务 5：quality_scores 表设计与迁移（R01 基线）

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/migrations/008_add_quality_scores.ts`

**Interfaces:**
- Consumes: Drizzle schema 定义模式
- Produces: quality_scores 表 + 索引

- [ ] **Step 1: 读取现有 schema.ts**

读取 `apps/server/src/db/schema.ts`，理解表定义模式和命名规范。

- [ ] **Step 2: 新增 quality_scores 表定义**

```typescript
export const qualityScores = sqliteTable('quality_scores', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => continuityRuns.id),
  episodeIdx: integer('episode_idx').notNull(),
  
  citationScore: real('citation_score').notNull(),
  consistencyScore: real('consistency_score').notNull(),
  coherenceScore: real('coherence_score').notNull(),
  costScore: real('cost_score').notNull(),
  overallScore: real('overall_score').notNull(),
  
  weights: text('weights').notNull(),
  metadata: text('metadata').notNull(),
  
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

export const idxQualityScoresRun = index('idx_quality_scores_run')
  .on(qualityScores.runId)

export const idxQualityScoresRunEpisode = index('idx_quality_scores_run_episode')
  .on(qualityScores.runId, qualityScores.episodeIdx)
  .unique()
```

- [ ] **Step 3: 创建迁移文件**

```typescript
import { db } from '../index.js'
import { sql } from 'drizzle-orm'

export async function up() {
  await db.run(sql`
    CREATE TABLE quality_scores (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES continuity_runs(id),
      episode_idx INTEGER NOT NULL,
      
      citation_score REAL NOT NULL,
      consistency_score REAL NOT NULL,
      coherence_score REAL NOT NULL,
      cost_score REAL NOT NULL,
      overall_score REAL NOT NULL,
      
      weights TEXT NOT NULL,
      metadata TEXT NOT NULL,
      
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  
  await db.run(sql`
    CREATE INDEX idx_quality_scores_run ON quality_scores(run_id)
  `)
  
  await db.run(sql`
    CREATE UNIQUE INDEX idx_quality_scores_run_episode 
    ON quality_scores(run_id, episode_idx)
  `)
}

export async function down() {
  await db.run(sql`DROP TABLE IF EXISTS quality_scores`)
}
```

- [ ] **Step 4: 运行迁移**

Run: `node .superpowers/sdd/M71-计划/safe-run.mjs migration`
Expected: exit 0，迁移成功执行

- [ ] **Step 5: 运行 server tsc**

Run: `node .superpowers/sdd/M71-计划/safe-run.mjs server`
Expected: exit 0

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/db/schema.ts apps/server/src/db/migrations/008_add_quality_scores.ts
git commit -m "feat: quality_scores 表设计与迁移（R01 质量基线）"
```

---

## 任务 6：评分服务实现（R01 基线）

**Files:**
- Create: `apps/server/src/services/eval-quality.ts`

**Interfaces:**
- Consumes: quality_scores 表、M24 eval-service、M70 continuity 表
- Produces: scoreQuality 函数 + QualityScoreResult 类型

- [ ] **Step 1: 创建 eval-quality.ts**

```typescript
import { db } from '../db/index.js'
import { qualityScores, continuityRuns, continuityFolds, continuityEvidence } from '../db/schema.js'
import { eq, and } from 'drizzle-orm'
import { evalImageSimilarity } from './eval-service.js'

export interface QualityScoreInput {
  runId: string
  episodeIdx: number
  weights?: {
    citation?: number
    consistency?: number
    coherence?: number
    cost?: number
  }
}

export interface QualityScoreResult {
  citationScore: number
  consistencyScore: number
  coherenceScore: number
  costScore: number
  overallScore: number
  metadata: {
    templateVersion: string
    promptVersion: string
    model: string
    params: Record<string, any>
    assetVersions: Record<string, string>
  }
}

const DEFAULT_WEIGHTS = {
  citation: 0.3,
  consistency: 0.3,
  coherence: 0.2,
  cost: 0.2
}

export async function scoreQuality(input: QualityScoreInput): Promise<QualityScoreResult> {
  const weights = { ...DEFAULT_WEIGHTS, ...input.weights }
  
  // 1. 引文完整度：统计 evidence 表的引文数 / 原作总引文数
  const citationScore = await calculateCitationScore(input.runId, input.episodeIdx)
  
  // 2. 角色一致性：调用 M24 eval-service 的图片相似度评分
  const consistencyScore = await calculateConsistencyScore(input.runId, input.episodeIdx)
  
  // 3. 剧情连贯度：零模型检查跨集状态矛盾
  const coherenceScore = await calculateCoherenceScore(input.runId, input.episodeIdx)
  
  // 4. 费用效率：统计实际费用 / 预算上限
  const costScore = await calculateCostScore(input.runId, input.episodeIdx)
  
  // 5. 加权平均
  const overallScore = 
    citationScore * weights.citation +
    consistencyScore * weights.consistency +
    coherenceScore * weights.coherence +
    costScore * weights.cost
  
  // 6. 收集元数据
  const metadata = await collectMetadata(input.runId)
  
  return {
    citationScore,
    consistencyScore,
    coherenceScore,
    costScore,
    overallScore,
    metadata
  }
}

async function calculateCitationScore(runId: string, episodeIdx: number): Promise<number> {
  const evidence = await db.query.continuityEvidence.findMany({
    where: and(
      eq(continuityEvidence.runId, runId),
      eq(continuityEvidence.episodeIdx, episodeIdx)
    )
  })
  
  const totalCitations = await getTotalCitations(runId)
  if (totalCitations === 0) return 100
  
  return Math.round((evidence.length / totalCitations) * 100)
}

async function calculateConsistencyScore(runId: string, episodeIdx: number): Promise<number> {
  // 复用 M24 eval-service 的图片相似度评分
  const images = await getEpisodeImages(runId, episodeIdx)
  if (images.length < 2) return 100
  
  let totalSimilarity = 0
  let comparisons = 0
  
  for (let i = 0; i < images.length; i++) {
    for (let j = i + 1; j < images.length; j++) {
      const similarity = await evalImageSimilarity(images[i], images[j])
      totalSimilarity += similarity
      comparisons++
    }
  }
  
  return comparisons > 0 ? Math.round((totalSimilarity / comparisons) * 100) : 100
}

async function calculateCoherenceScore(runId: string, episodeIdx: number): Promise<number> {
  // 零模型检查跨集状态矛盾
  const folds = await db.query.continuityFolds.findMany({
    where: and(
      eq(continuityFolds.runId, runId),
      eq(continuityFolds.episodeIdx, episodeIdx)
    )
  })
  
  const contradictions = folds.filter(f => f.status === 'contradiction')
  const totalFolds = folds.length
  
  if (totalFolds === 0) return 100
  
  const contradictionRatio = contradictions.length / totalFolds
  return Math.round((1 - contradictionRatio) * 100)
}

async function calculateCostScore(runId: string, episodeIdx: number): Promise<number> {
  const run = await db.query.continuityRuns.findFirst({
    where: eq(continuityRuns.id, runId)
  })
  
  if (!run) return 0
  
  const actualCost = run.actualCost || 0
  const budgetLimit = run.budgetLimit || 1
  
  if (actualCost > budgetLimit) return 0
  
  return Math.round((1 - actualCost / budgetLimit) * 100)
}

async function collectMetadata(runId: string): Promise<QualityScoreResult['metadata']> {
  const run = await db.query.continuityRuns.findFirst({
    where: eq(continuityRuns.id, runId)
  })
  
  return {
    templateVersion: run?.templateVersion || 'unknown',
    promptVersion: run?.promptVersion || 'unknown',
    model: run?.model || 'unknown',
    params: run?.params || {},
    assetVersions: run?.assetVersions || {}
  }
}

async function getTotalCitations(runId: string): Promise<number> {
  // 从原作提取的总引文数
  const run = await db.query.continuityRuns.findFirst({
    where: eq(continuityRuns.id, runId)
  })
  return run?.totalCitations || 0
}

async function getEpisodeImages(runId: string, episodeIdx: number): Promise<string[]> {
  // 获取该集的所有图片路径
  const images = await db.query.continuityEvidence.findMany({
    where: and(
      eq(continuityEvidence.runId, runId),
      eq(continuityEvidence.episodeIdx, episodeIdx),
      eq(continuityEvidence.type, 'image')
    )
  })
  return images.map(i => i.filePath)
}
```

- [ ] **Step 2: 运行 server tsc**

Run: `node .superpowers/sdd/M71-计划/safe-run.mjs server`
Expected: exit 0

- [ ] **Step 3: 提交**

```bash
git add apps/server/src/services/eval-quality.ts
git commit -m "feat: 评分服务实现（R01 质量基线）"
```

---

## 任务 7：评分端点实现（R01 基线）

**Files:**
- Modify: `apps/server/src/routes/runs.ts`

**Interfaces:**
- Consumes: scoreQuality 服务
- Produces: POST/GET /runs/:id/quality 端点

- [ ] **Step 1: 读取现有 runs.ts**

读取 `apps/server/src/routes/runs.ts`，理解现有端点结构和错误处理模式。

- [ ] **Step 2: 新增 POST /runs/:id/quality**

```typescript
import { scoreQuality } from '../services/eval-quality.js'

runs.post('/:id/quality', async (c) => {
  const runId = c.req.param('id')
  const body = await c.req.json()
  const { episodeIdx, weights } = body
  
  if (typeof episodeIdx !== 'number') {
    throw new HttpError(400, {
      code: 'bad_request',
      message: 'episodeIdx 必须是数字'
    })
  }
  
  const result = await scoreQuality({ runId, episodeIdx, weights })
  
  // 存储评分结果
  const id = generateId()
  const now = Date.now()
  await db.insert(qualityScores).values({
    id,
    runId,
    episodeIdx,
    citationScore: result.citationScore,
    consistencyScore: result.consistencyScore,
    coherenceScore: result.coherenceScore,
    costScore: result.costScore,
    overallScore: result.overallScore,
    weights: JSON.stringify(weights || { citation: 0.3, consistency: 0.3, coherence: 0.2, cost: 0.2 }),
    metadata: JSON.stringify(result.metadata),
    createdAt: now,
    updatedAt: now
  })
  
  return c.json({ score: result, id })
})
```

- [ ] **Step 3: 新增 GET /runs/:id/quality/:episodeIdx**

```typescript
runs.get('/:id/quality/:episodeIdx', async (c) => {
  const runId = c.req.param('id')
  const episodeIdx = parseInt(c.req.param('episodeIdx'))
  
  const score = await db.query.qualityScores.findFirst({
    where: and(
      eq(qualityScores.runId, runId),
      eq(qualityScores.episodeIdx, episodeIdx)
    )
  })
  
  if (!score) {
    throw new HttpError(404, {
      code: 'not_found',
      message: '评分不存在'
    })
  }
  
  return c.json({
    score: {
      citationScore: score.citationScore,
      consistencyScore: score.consistencyScore,
      coherenceScore: score.coherenceScore,
      costScore: score.costScore,
      overallScore: score.overallScore,
      metadata: JSON.parse(score.metadata)
    },
    createdAt: new Date(score.createdAt).toISOString()
  })
})
```

- [ ] **Step 4: 新增 GET /runs/:id/quality**

```typescript
runs.get('/:id/quality', async (c) => {
  const runId = c.req.param('id')
  
  const scores = await db.query.qualityScores.findMany({
    where: eq(qualityScores.runId, runId)
  })
  
  return c.json({
    scores: scores.map(s => ({
      episodeIdx: s.episodeIdx,
      citationScore: s.citationScore,
      consistencyScore: s.consistencyScore,
      coherenceScore: s.coherenceScore,
      costScore: s.costScore,
      overallScore: s.overallScore,
      metadata: JSON.parse(s.metadata)
    })),
    episodeCount: scores.length
  })
})
```

- [ ] **Step 5: 运行 server tsc**

Run: `node .superpowers/sdd/M71-计划/safe-run.mjs server`
Expected: exit 0

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/routes/runs.ts
git commit -m "feat: 评分端点实现（R01 质量基线）"
```

---

## 任务 8：评分 UI 实现（R01 基线）

**Files:**
- Create: `apps/web/src/components/run/QualityScorePanel.vue`
- Modify: `apps/web/src/views/run/RunDetail.vue`

**Interfaces:**
- Consumes: POST/GET /runs/:id/quality 端点
- Produces: 雷达图 + 权重调整 + 元数据展示组件

- [ ] **Step 1: 创建 QualityScorePanel.vue**

```vue
<template>
  <div class="quality-score-panel">
    <div class="score-header">
      <h3>质量评分</h3>
      <button @click="recalculate" class="btn btn-primary">重新评分</button>
    </div>
    
    <div v-if="loading" class="loading">计算中...</div>
    
    <div v-else-if="score" class="score-content">
      <div class="overall-score">
        <div class="score-circle">
          <svg viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="45" fill="none" stroke="#e0e0e0" stroke-width="10"/>
            <circle cx="50" cy="50" r="45" fill="none" stroke="#4caf50" stroke-width="10"
              :stroke-dasharray="`${score.overallScore * 2.83} 283`"
              transform="rotate(-90 50 50)"/>
          </svg>
          <div class="score-text">{{ score.overallScore }}</div>
        </div>
        <div class="score-label">综合分</div>
      </div>
      
      <div class="radar-chart">
        <svg viewBox="0 0 200 200">
          <!-- 雷达图背景 -->
          <polygon points="100,20 180,80 150,170 50,170 20,80" fill="none" stroke="#e0e0e0" stroke-width="1"/>
          <polygon points="100,40 160,80 140,150 60,150 40,80" fill="none" stroke="#e0e0e0" stroke-width="1"/>
          <polygon points="100,60 140,80 130,130 70,130 60,80" fill="none" stroke="#e0e0e0" stroke-width="1"/>
          
          <!-- 评分多边形 -->
          <polygon 
            :points="radarPoints"
            fill="rgba(76, 175, 80, 0.3)"
            stroke="#4caf50"
            stroke-width="2"/>
          
          <!-- 标签 -->
          <text x="100" y="15" text-anchor="middle">引文</text>
          <text x="185" y="85">一致性</text>
          <text x="155" y="180">连贯度</text>
          <text x="45" y="180">费用</text>
          <text x="15" y="85">综合</text>
        </svg>
      </div>
      
      <div class="dimension-scores">
        <div class="dimension">
          <span>引文完整度</span>
          <div class="progress">
            <div class="progress-bar" :style="{ width: score.citationScore + '%' }"></div>
          </div>
          <span>{{ score.citationScore }}</span>
        </div>
        <div class="dimension">
          <span>角色一致性</span>
          <div class="progress">
            <div class="progress-bar" :style="{ width: score.consistencyScore + '%' }"></div>
          </div>
          <span>{{ score.consistencyScore }}</span>
        </div>
        <div class="dimension">
          <span>剧情连贯度</span>
          <div class="progress">
            <div class="progress-bar" :style="{ width: score.coherenceScore + '%' }"></div>
          </div>
          <span>{{ score.coherenceScore }}</span>
        </div>
        <div class="dimension">
          <span>费用效率</span>
          <div class="progress">
            <div class="progress-bar" :style="{ width: score.costScore + '%' }"></div>
          </div>
          <span>{{ score.costScore }}</span>
        </div>
      </div>
      
      <div class="weights-adjustment">
        <h4>权重调整</h4>
        <div class="weight-slider">
          <label>引文</label>
          <input type="range" min="0" max="1" step="0.1" v-model.number="weights.citation">
          <span>{{ weights.citation }}</span>
        </div>
        <div class="weight-slider">
          <label>一致性</label>
          <input type="range" min="0" max="1" step="0.1" v-model.number="weights.consistency">
          <span>{{ weights.consistency }}</span>
        </div>
        <div class="weight-slider">
          <label>连贯度</label>
          <input type="range" min="0" max="1" step="0.1" v-model.number="weights.coherence">
          <span>{{ weights.coherence }}</span>
        </div>
        <div class="weight-slider">
          <label>费用</label>
          <input type="range" min="0" max="1" step="0.1" v-model.number="weights.cost">
          <span>{{ weights.cost }}</span>
        </div>
        <button @click="applyWeights" class="btn btn-secondary">应用权重</button>
      </div>
      
      <div class="metadata">
        <h4>评分元数据</h4>
        <div>模板版本: {{ score.metadata.templateVersion }}</div>
        <div>提示词版本: {{ score.metadata.promptVersion }}</div>
        <div>模型: {{ score.metadata.model }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

const props = defineProps<{
  runId: string
  episodeIdx: number
}>()

const loading = ref(false)
const score = ref<any>(null)
const weights = ref({
  citation: 0.3,
  consistency: 0.3,
  coherence: 0.2,
  cost: 0.2
})

const radarPoints = computed(() => {
  if (!score.value) return ''
  
  const dimensions = [
    score.value.citationScore,
    score.value.consistencyScore,
    score.value.coherenceScore,
    score.value.costScore,
    score.value.overallScore
  ]
  
  const angles = [0, 72, 144, 216, 288].map(a => a * Math.PI / 180)
  const radius = 80
  
  return dimensions.map((d, i) => {
    const r = (d / 100) * radius
    const x = 100 + r * Math.cos(angles[i] - Math.PI / 2)
    const y = 100 + r * Math.sin(angles[i] - Math.PI / 2)
    return `${x},${y}`
  }).join(' ')
})

async function loadScore() {
  loading.value = true
  try {
    const response = await fetch(`/runs/${props.runId}/quality/${props.episodeIdx}`)
    if (response.ok) {
      score.value = (await response.json()).score
    }
  } finally {
    loading.value = false
  }
}

async function recalculate() {
  loading.value = true
  try {
    const response = await fetch(`/runs/${props.runId}/quality`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        episodeIdx: props.episodeIdx,
        weights: weights.value
      })
    })
    if (response.ok) {
      score.value = (await response.json()).score
    }
  } finally {
    loading.value = false
  }
}

async function applyWeights() {
  await recalculate()
}

onMounted(loadScore)
</script>

<style scoped>
.quality-score-panel {
  padding: 1rem;
}

.score-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
}

.overall-score {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 2rem;
}

.score-circle {
  position: relative;
  width: 120px;
  height: 120px;
}

.score-circle svg {
  width: 100%;
  height: 100%;
}

.score-text {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 2rem;
  font-weight: bold;
}

.score-label {
  margin-top: 0.5rem;
  font-size: 0.9rem;
  color: #666;
}

.radar-chart {
  width: 200px;
  height: 200px;
  margin: 0 auto 2rem;
}

.dimension-scores {
  margin-bottom: 2rem;
}

.dimension {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 0.5rem;
}

.dimension span:first-child {
  width: 100px;
}

.progress {
  flex: 1;
  height: 20px;
  background: #e0e0e0;
  border-radius: 10px;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  background: #4caf50;
  transition: width 0.3s;
}

.weights-adjustment {
  margin-bottom: 2rem;
}

.weight-slider {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 0.5rem;
}

.weight-slider label {
  width: 80px;
}

.weight-slider input {
  flex: 1;
}

.weight-slider span {
  width: 40px;
  text-align: right;
}

.metadata {
  padding: 1rem;
  background: #f5f5f5;
  border-radius: 4px;
}

.metadata h4 {
  margin-top: 0;
}

.loading {
  text-align: center;
  padding: 2rem;
  color: #666;
}
</style>
```

- [ ] **Step 2: 读取 RunDetail.vue**

读取 `apps/web/src/views/run/RunDetail.vue`，理解现有标签页结构。

- [ ] **Step 3: 集成质量评分标签页**

```vue
<template>
  <div class="run-detail">
    <div class="tabs">
      <button 
        v-for="tab in tabs" 
        :key="tab.id"
        :class="['tab', { on: currentTab === tab.id }]"
        @click="currentTab = tab.id">
        {{ tab.label }}
      </button>
    </div>
    
    <div v-show="currentTab === 'quality'" class="tab-content">
      <QualityScorePanel 
        v-if="runId && currentEpisodeIdx !== null"
        :run-id="runId"
        :episode-idx="currentEpisodeIdx"/>
    </div>
    
    <!-- 其他标签页内容 -->
  </div>
</template>

<script setup lang="ts">
import QualityScorePanel from '../components/run/QualityScorePanel.vue'

const tabs = [
  { id: 'overview', label: '概览' },
  { id: 'episodes', label: '分集' },
  { id: 'quality', label: '质量评分' }
]

const currentTab = ref('overview')
const runId = ref<string | null>(null)
const currentEpisodeIdx = ref<number | null>(null)

// 从路由参数获取 runId
onMounted(() => {
  runId.value = route.params.id as string
  currentEpisodeIdx.value = 0 // 默认第一集
})
</script>
```

- [ ] **Step 4: 运行 web tsc**

Run: `node .superpowers/sdd/M71-计划/safe-run.mjs web`
Expected: exit 0

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/run/QualityScorePanel.vue apps/web/src/views/run/RunDetail.vue
git commit -m "feat: 评分 UI 实现（R01 质量基线）"
```

---

## 任务 9：评分探针实现（R01 基线）

**Files:**
- Create: `apps/server/scripts/probe-m71.ts`

**Interfaces:**
- Consumes: 评分服务、评分端点、quality_scores 表
- Produces: 覆盖服务 + 端点 + 存储 + 权重 + 元数据的探针

- [ ] **Step 1: 创建 probe-m71.ts**

```typescript
/**
 * M71 质量基线探针
 * 
 * 覆盖：
 * 1. 评分服务：四维评分计算正确
 * 2. 评分端点：POST/GET 端点契约正确
 * 3. 评分存储：quality_scores 表读写正确
 * 4. 权重调整：自定义权重计算正确
 * 5. 可复现性：metadata 记录完整
 * 6. M70 缺口收尾：四项缺口验收条件
 */
import { scoreQuality } from '../src/services/eval-quality.js'
import { db } from '../src/db/index.js'
import { qualityScores } from '../src/db/schema.js'
import { eq } from 'drizzle-orm'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++
    console.log(`✓ ${message}`)
  } else {
    failed++
    console.error(`✗ ${message}`)
  }
}

async function testScoringService() {
  console.log('\n=== 评分服务测试 ===')
  
  // 创建测试 run
  const runId = 'test-run-m71'
  const episodeIdx = 0
  
  const result = await scoreQuality({ runId, episodeIdx })
  
  assert(result.citationScore >= 0 && result.citationScore <= 100, '引文完整度在 0-100 范围')
  assert(result.consistencyScore >= 0 && result.consistencyScore <= 100, '角色一致性在 0-100 范围')
  assert(result.coherenceScore >= 0 && result.coherenceScore <= 100, '剧情连贯度在 0-100 范围')
  assert(result.costScore >= 0 && result.costScore <= 100, '费用效率在 0-100 范围')
  assert(result.overallScore >= 0 && result.overallScore <= 100, '综合分在 0-100 范围')
  assert(result.metadata.templateVersion !== undefined, '元数据包含模板版本')
  assert(result.metadata.promptVersion !== undefined, '元数据包含提示词版本')
  assert(result.metadata.model !== undefined, '元数据包含模型')
}

async function testScoringEndpoint() {
  console.log('\n=== 评分端点测试 ===')
  
  const runId = 'test-run-m71'
  const episodeIdx = 0
  
  // POST /runs/:id/quality
  const postResponse = await fetch(`http://localhost:3000/runs/${runId}/quality`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ episodeIdx })
  })
  
  assert(postResponse.status === 200, 'POST 端点返回 200')
  const postBody = await postResponse.json()
  assert(postBody.score !== undefined, 'POST 响应包含 score')
  assert(postBody.id !== undefined, 'POST 响应包含 id')
  
  // GET /runs/:id/quality/:episodeIdx
  const getResponse = await fetch(`http://localhost:3000/runs/${runId}/quality/${episodeIdx}`)
  assert(getResponse.status === 200, 'GET 单集端点返回 200')
  const getBody = await getResponse.json()
  assert(getBody.score !== undefined, 'GET 响应包含 score')
  assert(getBody.createdAt !== undefined, 'GET 响应包含 createdAt')
  
  // GET /runs/:id/quality
  const listResponse = await fetch(`http://localhost:3000/runs/${runId}/quality`)
  assert(listResponse.status === 200, 'GET 列表端点返回 200')
  const listBody = await listResponse.json()
  assert(Array.isArray(listBody.scores), 'GET 列表响应包含 scores 数组')
  assert(listBody.episodeCount >= 1, 'GET 列表响应 episodeCount >= 1')
}

async function testScoringStorage() {
  console.log('\n=== 评分存储测试 ===')
  
  const runId = 'test-run-m71'
  const episodeIdx = 0
  
  const scores = await db.query.qualityScores.findMany({
    where: eq(qualityScores.runId, runId)
  })
  
  assert(scores.length >= 1, 'quality_scores 表有记录')
  assert(scores[0].runId === runId, 'runId 正确')
  assert(scores[0].episodeIdx === episodeIdx, 'episodeIdx 正确')
  assert(scores[0].overallScore >= 0, 'overallScore >= 0')
}

async function testWeightsAdjustment() {
  console.log('\n=== 权重调整测试 ===')
  
  const runId = 'test-run-m71'
  const episodeIdx = 0
  
  const customWeights = {
    citation: 0.5,
    consistency: 0.2,
    coherence: 0.2,
    cost: 0.1
  }
  
  const result = await scoreQuality({ runId, episodeIdx, weights: customWeights })
  
  // 验证权重影响综合分
  const expectedOverall = 
    result.citationScore * 0.5 +
    result.consistencyScore * 0.2 +
    result.coherenceScore * 0.2 +
    result.costScore * 0.1
  
  assert(Math.abs(result.overallScore - expectedOverall) < 1, '自定义权重计算正确')
}

async function testMetadataReproducibility() {
  console.log('\n=== 可复现性测试 ===')
  
  const runId = 'test-run-m71'
  const episodeIdx = 0
  
  const score = await db.query.qualityScores.findFirst({
    where: eq(qualityScores.runId, runId)
  })
  
  assert(score !== undefined, '评分记录存在')
  
  const metadata = JSON.parse(score!.metadata)
  assert(metadata.templateVersion !== undefined, 'metadata 包含 templateVersion')
  assert(metadata.promptVersion !== undefined, 'metadata 包含 promptVersion')
  assert(metadata.model !== undefined, 'metadata 包含 model')
  assert(metadata.params !== undefined, 'metadata 包含 params')
  assert(metadata.assetVersions !== undefined, 'metadata 包含 assetVersions')
}

async function main() {
  console.log('M71 质量基线探针开始\n')
  
  try {
    await testScoringService()
    await testScoringEndpoint()
    await testScoringStorage()
    await testWeightsAdjustment()
    await testMetadataReproducibility()
    
    console.log(`\n=== 探针结果 ===`)
    console.log(`通过: ${passed}`)
    console.log(`失败: ${failed}`)
    
    if (failed > 0) {
      process.exit(1)
    }
  } catch (error) {
    console.error('探针执行出错:', error)
    process.exit(1)
  }
}

main()
```

- [ ] **Step 2: 运行探针**

Run: `node .superpowers/sdd/M71-计划/safe-run.mjs script ../server/scripts/probe-m71.ts`
Expected: exit 0，所有断言通过

- [ ] **Step 3: 运行全量探针**

Run: `node .superpowers/sdd/M71-计划/safe-run.mjs probe`
Expected: exit 0，全量探针通过

- [ ] **Step 4: 提交**

```bash
git add apps/server/scripts/probe-m71.ts
git commit -m "test: 评分探针实现（R01 质量基线）"
```

---

## 任务 10：联调与文档

**Files:**
- Modify: `docs/records/路线图-roadmap.md`
- Modify: `docs/records/备选清单-post-M27-backlog.md`

**Interfaces:**
- Consumes: M71 所有交付物
- Produces: roadmap 更新 + backlog 状态更新

- [ ] **Step 1: 运行全量验证**

```bash
# server tsc
node .superpowers/sdd/M71-计划/safe-run.mjs server

# web tsc
node .superpowers/sdd/M71-计划/safe-run.mjs web

# 全量探针
node .superpowers/sdd/M71-计划/safe-run.mjs probe

# git diff check
git diff --check
```

Expected: 全部 exit 0

- [ ] **Step 2: 更新 roadmap**

在 `docs/records/路线图-roadmap.md` 新增 M71 节：

```markdown
## M71：质量基线与缺口收尾（2026-11-02）

**目标**：收尾 M70 四项登记缺口 + 建立 R01 质量基线测量基础设施

**交付**：
- M70 缺口收尾：引文漂移专测、templateKey 消费面、草稿删入口、personaFile 动态化
- R01 质量基线：quality_scores 表、评分服务、评分端点、评分 UI、评分探针

**验收**：全量探针 exit 0，server/web tsc exit 0

**后续**：M72 定向返修闭环（R06）
```

- [ ] **Step 3: 更新 backlog**

在 `docs/records/备选清单-post-M27-backlog.md` 更新 R01 状态：

```markdown
| R01 | P0 | 可复现的连载质量与成本基线 **（M71 已交付质量评分基础设施，实测样本待后续补充）** | 用实测决定投向，不用 Agent 名称推断效果 | M24 评测、M26 工程验证；生成预算另行确认 |
```

- [ ] **Step 4: 提交**

```bash
git add docs/records/路线图-roadmap.md docs/records/备选清单-post-M27-backlog.md
git commit -m "docs: M71 联调与文档更新"
```

---

## 执行顺序

1. **任务 1-4**（M70 缺口收尾）：可并行，无依赖
2. **任务 5**（表设计与迁移）：依赖任务 1-4 完成
3. **任务 6**（评分服务）：依赖任务 5
4. **任务 7**（评分端点）：依赖任务 6
5. **任务 8**（评分 UI）：依赖任务 7
6. **任务 9**（评分探针）：依赖任务 7
7. **任务 10**（联调与文档）：依赖任务 1-9 全部完成

---

## 验收清单

- [ ] 全量探针 exit 0（含新增 probe-m71）
- [ ] server tsc --noEmit exit 0
- [ ] web vue-tsc --noEmit exit 0
- [ ] git diff --check exit 0
- [ ] M70 四项缺口全部收尾
- [ ] R01 质量基线四维评分可用
- [ ] UI 雷达图 + 权重调整 + 元数据展示正常
- [ ] roadmap 和 backlog 更新完成
