// 自 services/creation.ts 拆分：buildCanvasDoc 读模型组装（全型节点/端口/采纳优先/结果画廊）。
import { asc, count, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { assets, canvasEdges, canvasGroups, canvasNodes, characters, genTasks, pipelineRuns, pipelineSteps } from '../../db/schema'
import { findCanvas, toAssetLite } from './canvas'
import { pickDisplayTask, planNodeInputs } from './inputs'
import { editCapabilityOf } from './ports'
import {
  parseRefIds,
  parseViewport,
  safeParseEntitySpec,
  safeParseRunSpec,
  safeParseSpec,
  safeParseTextSpec,
  specProblems,
  type CanvasDoc,
  type CanvasDocNode,
  type CanvasEntityInfo,
  type CanvasRunInfo,
  type CanvasResultItem,
  type EditCapability,
  type GenTaskLite,
  type NodeKind,
  type NodeSpec,
  type UpstreamInfo,
} from './spec'

function toTaskLite(t: typeof genTasks.$inferSelect): GenTaskLite {
  return {
    id: t.id,
    status: t.status,
    attempts: t.attempts,
    errorMsg: t.errorMsg,
    taskId: t.taskId,
    resultAssetId: t.resultAssetId,
    createdAt: t.createdAt,
    completedAt: t.completedAt,
  }
}

// ---------- 读模型组装 ----------

export async function buildCanvasDoc(canvasId: number): Promise<CanvasDoc | null> {
  const canvas = await findCanvas(canvasId)
  if (!canvas) return null
  const nodeRows = await db.select().from(canvasNodes).where(eq(canvasNodes.canvasId, canvasId)).orderBy(asc(canvasNodes.id))
  const edgeRows = await db.select().from(canvasEdges).where(eq(canvasEdges.canvasId, canvasId)).orderBy(asc(canvasEdges.id))
  const groupRows = await db.select().from(canvasGroups).where(eq(canvasGroups.canvasId, canvasId)).orderBy(asc(canvasGroups.id))
  const nodeIds = nodeRows.map((n) => n.id)

  // 任务：全量按节点分组（新→旧）；最新一条 = tasks[0]
  const taskRows = nodeIds.length
    ? await db.select().from(genTasks).where(inArray(genTasks.canvasNodeId, nodeIds)).orderBy(desc(genTasks.id))
    : []
  const tasksByNode = new Map<number, Array<typeof genTasks.$inferSelect>>()
  for (const t of taskRows) {
    if (t.canvasNodeId == null) continue
    const list = tasksByNode.get(t.canvasNodeId) ?? []
    list.push(t)
    tasksByNode.set(t.canvasNodeId, list)
  }

  // entity 节点：批查实体（参考图集 + 首图缩略）
  const entityRefsByNodeId = new Map<number, number[]>()
  const entityByNodeId = new Map<number, CanvasEntityInfo>()
  const entityNodeRows = nodeRows.filter((n) => n.kind === 'entity')
  if (entityNodeRows.length) {
    const eids = entityNodeRows.map((n) => safeParseEntitySpec(n.spec).spec?.entityId).filter((x): x is number => x != null)
    const entRows = eids.length ? await db.select().from(characters).where(inArray(characters.id, eids)) : []
    const entById = new Map(entRows.map((c) => [c.id, c]))
    for (const n of entityNodeRows) {
      const eid = safeParseEntitySpec(n.spec).spec?.entityId
      const ent = eid != null ? entById.get(eid) : undefined
      if (!ent) continue
      const refIds = parseRefIds(ent.refAssetIds)
      entityRefsByNodeId.set(n.id, refIds)
      entityByNodeId.set(n.id, { id: ent.id, name: ent.name, kind: ent.kind, refCount: refIds.length, asset: null })
    }
  }

  // run 节点：批查 pipeline_runs + steps 状态计数
  const runByNodeId = new Map<number, CanvasRunInfo>()
  const runNodeRows = nodeRows.filter((n) => n.kind === 'run')
  if (runNodeRows.length) {
    const rids = runNodeRows.map((n) => safeParseRunSpec(n.spec).spec?.runId).filter((x): x is number => x != null)
    const runRows = rids.length ? await db.select().from(pipelineRuns).where(inArray(pipelineRuns.id, rids)) : []
    const runById = new Map(runRows.map((r) => [r.id, r]))
    const stepRows = rids.length
      ? await db
          .select({ runId: pipelineSteps.runId, status: pipelineSteps.status, n: count() })
          .from(pipelineSteps)
          .where(inArray(pipelineSteps.runId, rids))
          .groupBy(pipelineSteps.runId, pipelineSteps.status)
      : []
    for (const n of runNodeRows) {
      const rid = safeParseRunSpec(n.spec).spec?.runId
      const run = rid != null ? runById.get(rid) : undefined
      if (!run) continue
      let total = 0
      let succeeded = 0
      for (const s of stepRows) {
        if (s.runId !== run.id) continue
        total += Number(s.n)
        if (s.status === 'succeeded') succeeded += Number(s.n)
      }
      runByNodeId.set(n.id, {
        id: run.id,
        templateKey: run.templateKey,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        steps: { succeeded, total },
      })
    }
  }

  // 资产：素材节点 assetId + 全部任务 resultAssetId（含历史）+ 实体首张参考图
  const assetIdSet = new Set<number>()
  for (const n of nodeRows) if (n.assetId != null) assetIdSet.add(n.assetId)
  for (const t of taskRows) if (t.resultAssetId != null) assetIdSet.add(t.resultAssetId)
  for (const [, refIds] of entityRefsByNodeId) if (refIds[0] != null) assetIdSet.add(refIds[0])
  const assetRows = assetIdSet.size
    ? await db.select().from(assets).where(inArray(assets.id, [...assetIdSet]))
    : []
  const assetById = new Map(assetRows.map((a) => [a.id, a]))
  for (const [nodeId, refIds] of entityRefsByNodeId) {
    const info = entityByNodeId.get(nodeId)
    if (!info) continue
    const first = refIds[0] != null ? assetById.get(refIds[0]) : undefined
    info.asset = first ? toAssetLite(first) : null
  }

  // 上游产物索引 v2：asset→引用资产；gen→采纳优先产物；text→内容；entity→参考图集；run→空
  const upstream = new Map<number, UpstreamInfo>()
  for (const n of nodeRows) {
    if (n.kind === 'asset') {
      const a = n.assetId != null ? assetById.get(n.assetId) : undefined
      upstream.set(n.id, { assetId: a?.id ?? null, mediaKind: a?.kind ?? null })
    } else if (n.kind === 'gen') {
      const display = pickDisplayTask(n.adoptedTaskId ?? null, tasksByNode.get(n.id) ?? [])
      const a = display?.resultAssetId != null ? assetById.get(display.resultAssetId) : undefined
      upstream.set(n.id, { assetId: a?.id ?? null, mediaKind: a?.kind ?? null })
    } else if (n.kind === 'text') {
      const ts = safeParseTextSpec(n.spec)
      upstream.set(n.id, { assetId: null, mediaKind: null, text: ts.spec?.text ?? null })
    } else if (n.kind === 'entity') {
      upstream.set(n.id, { assetId: null, mediaKind: null, refAssetIds: entityRefsByNodeId.get(n.id) ?? [] })
    } else {
      upstream.set(n.id, { assetId: null, mediaKind: null })
    }
  }

  const capCache = new Map<string, Promise<EditCapability>>()
  const capOf = (provider?: string): Promise<EditCapability> => {
    const key = provider ?? ''
    const hit = capCache.get(key)
    if (hit) return hit
    const p = editCapabilityOf(provider)
    capCache.set(key, p)
    return p
  }

  const nodes: CanvasDocNode[] = []
  for (const n of nodeRows) {
    const base = {
      id: n.id,
      kind: n.kind as NodeKind,
      x: n.x,
      y: n.y,
      seq: n.seq ?? null,
      groupId: n.groupId ?? null,
    }
    if (n.kind === 'asset') {
      const a = n.assetId != null ? assetById.get(n.assetId) : undefined
      nodes.push({
        ...base,
        title: n.title ?? a?.name ?? `素材 #${n.assetId ?? '?'}`,
        assetId: n.assetId ?? null,
        asset: a ? toAssetLite(a) : null,
        spec: null,
        specError: null,
        status: null,
        latestTask: null,
        tasks: [],
        adoptedTaskId: null,
        displayTaskId: null,
        displayTask: null,
        results: [],
        readiness: null,
        editCapability: null,
        canRun: null,
        canCancel: null,
        entity: null,
        run: null,
      })
      continue
    }
    if (n.kind === 'text') {
      const ts = safeParseTextSpec(n.spec)
      const problems: string[] = []
      if (ts.error) problems.push(ts.error)
      if (ts.spec && !ts.spec.text.trim()) problems.push('文本为空')
      nodes.push({
        ...base,
        title: n.title ?? `文本 #${n.id}`,
        assetId: null,
        asset: null,
        spec: ts.spec,
        specError: ts.error,
        status: null,
        latestTask: null,
        tasks: [],
        adoptedTaskId: null,
        displayTaskId: null,
        displayTask: null,
        results: [],
        readiness: { ready: problems.length === 0, problems, notes: [] },
        editCapability: null,
        canRun: null,
        canCancel: null,
        entity: null,
        run: null,
      })
      continue
    }
    if (n.kind === 'entity') {
      const es = safeParseEntitySpec(n.spec)
      const info = entityByNodeId.get(n.id) ?? null
      const problems: string[] = []
      if (es.error) problems.push(es.error)
      if (es.spec && !info) problems.push('实体不存在或已删除')
      if (info && info.refCount === 0) problems.push('实体无参考图（请在实体库上传定妆照）')
      nodes.push({
        ...base,
        title: n.title ?? info?.name ?? `实体 #${n.id}`,
        assetId: null,
        asset: null,
        spec: es.spec,
        specError: es.error,
        status: null,
        latestTask: null,
        tasks: [],
        adoptedTaskId: null,
        displayTaskId: null,
        displayTask: null,
        results: [],
        readiness: { ready: problems.length === 0, problems, notes: [] },
        editCapability: null,
        canRun: null,
        canCancel: null,
        entity: info,
        run: null,
      })
      continue
    }
    if (n.kind === 'run') {
      const rs = safeParseRunSpec(n.spec)
      const run = runByNodeId.get(n.id) ?? null
      nodes.push({
        ...base,
        title: n.title ?? `运行 #${rs.spec?.runId ?? '?'}`,
        assetId: null,
        asset: null,
        spec: rs.spec,
        specError: rs.error,
        status: run?.status ?? null,
        latestTask: null,
        tasks: [],
        adoptedTaskId: null,
        displayTaskId: null,
        displayTask: null,
        results: [],
        readiness: null,
        editCapability: null,
        canRun: null,
        canCancel: null,
        entity: null,
        run,
      })
      continue
    }
    // gen：任务派生 + 采纳优先显示
    const parsed = safeParseSpec(n.spec)
    const allTasks = tasksByNode.get(n.id) ?? []
    const tasks = allTasks.slice(0, 5).map(toTaskLite)
    const latest = allTasks[0] ?? null
    const status = latest?.status ?? 'idle'
    const busy = status === 'pending' || status === 'processing'
    const adoptedTaskId = n.adoptedTaskId ?? null
    const display = pickDisplayTask(adoptedTaskId, allTasks)
    const displayTaskId = display?.id ?? null
    const results: CanvasResultItem[] = allTasks
      .filter((t) => t.status === 'succeeded' && t.resultAssetId != null)
      .slice(0, 12)
      .map((t) => {
        const a = t.resultAssetId != null ? assetById.get(t.resultAssetId) : undefined
        return { taskId: t.id, assetId: t.resultAssetId!, asset: a ? toAssetLite(a) : null, createdAt: t.createdAt }
      })
    const displayAsset = display?.resultAssetId != null ? assetById.get(display.resultAssetId) : undefined
    const displayTask = display ? { ...toTaskLite(display), asset: displayAsset ? toAssetLite(displayAsset) : null } : null
    const problems: string[] = []
    let notes: string[] = []
    if (parsed.error) problems.push(parsed.error)
    if (parsed.spec) {
      const plan = planNodeInputs(parsed.spec, n.id, edgeRows, upstream)
      problems.push(...specProblems(parsed.spec, plan.promptText != null), ...plan.problems)
      notes = plan.notes
    }
    const isEdit = Boolean(parsed.spec?.edit)
    nodes.push({
      ...base,
      title: n.title ?? defaultGenTitle(parsed.spec, n.id),
      assetId: display?.resultAssetId ?? null,
      asset: displayAsset ? toAssetLite(displayAsset) : null,
      spec: parsed.spec,
      specError: parsed.error,
      status,
      latestTask: latest ? toTaskLite(latest) : null,
      tasks,
      adoptedTaskId,
      displayTaskId,
      displayTask,
      results,
      readiness: { ready: problems.length === 0, problems, notes },
      editCapability: isEdit && parsed.spec ? await capOf(parsed.spec.provider) : null,
      canRun: Boolean(parsed.spec) && problems.length === 0 && !busy,
      canCancel: busy,
      entity: null,
      run: null,
    })
  }

  const viewport = parseViewport(safeJson(canvas.viewport)) ?? { x: 0, y: 0, zoom: 1 }
  return {
    canvas: { id: canvas.id, projectId: canvas.projectId, name: canvas.name, viewport },
    nodes,
    edges: edgeRows.map((e) => ({ id: e.id, from: e.from, to: e.to, port: e.port })),
    groups: groupRows.map((g) => ({ id: g.id, title: g.title, color: g.color, collapsed: g.collapsed === 1, x: g.x, y: g.y, parentId: g.parentId ?? null })),
  }
}

/** gen 节点默认标题（按 genKind / edit 分派） */
function defaultGenTitle(spec: NodeSpec | null, id: number): string {
  if (!spec) return `节点 #${id}`
  if (spec.edit) return `编辑 #${id}`
  if (spec.genKind === 'video') return `视频 #${id}`
  if (spec.genKind === 'audio') return `音频 #${id}`
  if (spec.genKind === 'compose') return `合成 #${id}`
  if (spec.genKind === 'llm') return `LLM #${id}`
  return `图片 #${id}`
}


function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
