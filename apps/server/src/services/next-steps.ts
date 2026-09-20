/**
 * [M35 · G11] 规则引擎「下一步建议」（零 LLM、零计费）。
 *
 * 背景：[`canvasAdvice`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/services/creation/advice.ts)
 * 只在画布页由用户手动点按钮触发（每次 LLM 计费）。项目主页 / run 完成后 / 模板链上游完成时，
 * 用户看不到「下一步该做什么」。但 [`Template.next?: string[]`](file:///d:/work/AI/Agent/agencys-content-studio/apps/server/src/pipeline/types.ts)
 * 元数据早已存在（推荐下游模板），从未消费。
 *
 * 方案：按项目当前状态（runs / publications / 模板 next 字段）产 ≤3 条纯提示 chip；
 * 用户点击才导航，**不自动执行、不弹窗、不打断**。LLM `canvasAdvice` 保留手动「AI 建议」不动。
 *
 * 规则集（优先级降序，命中即入选）：
 * 1. 无 run → 「开始制作：运行『{template.name}』」route=`/projects/:id?run=1&tpl={key}`
 * 2. 有 pending/running run → 「进行中：#{id} · {template.name} · 步 {cur}」auto:true 不行动
 * 3. 最新 run succeeded/completed + template.next 非空 → 「下一步：{next[0].name}」
 * 4. 最新 run completed + 项目无 publication → 「发布本集」route=`/projects/:id/publish`
 * 5. 最新 run completed + 有 publication + template.next 空 → 「进入专业工作台精修」route=`/projects/:id/canvas`
 *
 * 边界：纯读现有表，不新增数据；建议 kind 是 UI 分类，不注入执行链。
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { pipelineRuns, projects, publications } from '../db/schema'
import { loadTemplate, listTemplates } from '../pipeline/loader'
import type { TemplateMeta } from '../pipeline/types'

export type NextStepKind = 'run' | 'publish' | 'next_tpl' | 'progress' | 'workbench'
export interface NextStep {
  key: string
  kind: NextStepKind
  title: string
  hint?: string
  cta?: string
  route?: string
  templateKey?: string
  /** true = 纯状态提示，不显按钮（不可行动） */
  auto?: boolean
}

function safeTemplateName(key: string, metas: Map<string, TemplateMeta>): string {
  const m = metas.get(key)
  if (m) return m.name
  try {
    return loadTemplate(key).name
  } catch {
    return key
  }
}

/** 依项目当前状态解析下一步建议（≤3 条；空数组 = 无建议） */
export async function resolveNextSteps(projectId: number): Promise<NextStep[]> {
  const [proj] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1)
  if (!proj) return []

  const runs = await db
    .select({ id: pipelineRuns.id, status: pipelineRuns.status, templateKey: pipelineRuns.templateKey, currentStepKey: pipelineRuns.currentStepKey, updatedAt: pipelineRuns.updatedAt })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.projectId, projectId))
    .orderBy(desc(pipelineRuns.updatedAt))
    .limit(20)

  const pubs = await db
    .select({ id: publications.id })
    .from(publications)
    .where(eq(publications.projectId, projectId))
    .limit(1)

  const metas = new Map(listTemplates().map((m) => [m.key, m]))
  const hasPublication = pubs.length > 0
  const inFlight = runs.find((r) => ['queued', 'running', 'waiting_input'].includes(r.status))
  const latestDone = runs.find((r) => r.status === 'completed' || r.status === 'succeeded')
  const steps: NextStep[] = []

  // 规则 2：进行中（优先展示状态，即使有历史 completed run 也不覆盖）
  if (inFlight) {
    const name = safeTemplateName(inFlight.templateKey, metas)
    steps.push({
      key: `progress-${inFlight.id}`,
      kind: 'progress',
      title: `进行中：#${inFlight.id} · ${name}`,
      hint: inFlight.currentStepKey ? `当前步「${inFlight.currentStepKey}」` : '排队中',
      auto: true,
    })
  }

  // 规则 1：无 run → 开始制作
  if (runs.length === 0) {
    const tplName = safeTemplateName(proj.templateKey, metas)
    steps.push({
      key: 'start-run',
      kind: 'run',
      title: `开始制作：运行「${tplName}」`,
      hint: proj.brief?.trim() ? '沿用项目简介作为初始上下文' : undefined,
      cta: '新建运行',
      route: `/projects/${projectId}/run-new?tpl=${encodeURIComponent(proj.templateKey)}`,
      templateKey: proj.templateKey,
    })
  }

  // 规则 3：completed run + template.next 非空 → 下一步模板
  if (latestDone && !inFlight) {
    let nextKeys: string[] = []
    try {
      const tpl = loadTemplate(latestDone.templateKey)
      nextKeys = tpl.next ?? []
    } catch {
      nextKeys = []
    }
    if (nextKeys.length > 0) {
      const nextKey = nextKeys[0]!
      const name = safeTemplateName(nextKey, metas)
      steps.push({
        key: `next-tpl-${nextKey}`,
        kind: 'next_tpl',
        title: `下一步：${name}`,
        hint: nextKeys.length > 1 ? `候选 ${nextKeys.length} 套下游模板` : undefined,
        cta: '开始运行',
        route: `/projects/${projectId}/run-new?tpl=${encodeURIComponent(nextKey)}`,
        templateKey: nextKey,
      })
    }
  }

  // 规则 4：completed run + 无 publication → 发布本集
  if (latestDone && !hasPublication && !inFlight) {
    steps.push({
      key: 'publish',
      kind: 'publish',
      title: '发布本集',
      hint: '将最新成片登记到发布渠道',
      cta: '打开发布',
      route: `/projects/${projectId}/publish`,
    })
  }

  // 规则 5：已发布 + 已完成 + 无下游模板 → 进入专业工作台精修
  if (latestDone && hasPublication) {
    let hasNext = false
    try {
      const tpl = loadTemplate(latestDone.templateKey)
      hasNext = (tpl.next ?? []).length > 0
    } catch {
      hasNext = false
    }
    if (!hasNext) {
      steps.push({
        key: 'workbench',
        kind: 'workbench',
        title: '进入专业工作台精修',
        hint: '画布节点级微调 / 参考素材重生成',
        cta: '打开画布',
        route: `/projects/${projectId}/canvas`,
      })
    }
  }

  return steps.slice(0, 3)
}
