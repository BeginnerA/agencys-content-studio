// [M28·批1a] 自 services/creation.ts 拆分：输入规划（入边→端口输入）+ 显示任务决策 + 执行时输入装载。
import { readFileSync } from 'node:fs'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { assets, canvasNodes, characters, genTasks } from '../../db/schema'
import type { CanvasNode } from '../../db/schema'
import { absPathOf } from '../storage'
import {
  COMPOSE_CAP,
  LLM_TEXT_CAP,
  REF_CAP,
  parseRefIds,
  safeParseEntitySpec,
  safeParseTextSpec,
  type InputPlan,
  type NodeSpec,
  type UpstreamInfo,
} from './spec'

/**
 * 输入计划 v3（纯函数）：入边 → 各端口输入资产/文本 + 问题清单 + 宽容提示。
 * 语义 = 引用快照（采纳优先）：执行时取上游「采纳产物（有效时）或最新成功产物」；
 * [M17] 扩展：prompt 端口（text 节点内容）、video/audio 端口（compose 输入）、entity 源（refAssetIds 展开截断）；
 * [M18] 扩展：text 端口（llm 素材文本 ≤4 段）。
 */
export function planNodeInputs(
  spec: NodeSpec,
  nodeId: number,
  edges: Array<{ from: number; to: number; port: string }>,
  upstream: Map<number, UpstreamInfo>,
): InputPlan {
  const plan: InputPlan = {
    referenceAssetIds: [],
    firstFrameAssetId: null,
    lastFrameAssetId: null,
    sourceAssetId: null,
    promptText: null,
    videoAssetIds: [],
    audioAssetIds: [],
    textInputs: [],
    problems: [],
    notes: [],
  }
  const incoming = edges.filter((e) => e.to === nodeId)
  const takeUpstream = (fromId: number): number | null => {
    const up = upstream.get(fromId)
    if (!up || up.assetId == null) {
      plan.problems.push(`引用节点 #${fromId} 暂无成功产物`)
      return null
    }
    if (up.mediaKind !== 'image') {
      plan.problems.push(`引用节点 #${fromId} 的产物为 ${up.mediaKind ?? '未知'}，不能作为生成输入（仅图片）`)
      return null
    }
    return up.assetId
  }
  for (const e of incoming) {
    if (e.port === 'reference') {
      const cap = (REF_CAP as Record<string, number>)[spec.genKind] ?? 0
      const up = upstream.get(e.from)
      if (up?.refAssetIds != null) {
        // [M17] entity 节点：展开参考图集（受 cap 截断，记 notes）
        let truncated = 0
        for (const rid of up.refAssetIds) {
          if (plan.referenceAssetIds.length >= cap) {
            truncated += 1
            continue
          }
          plan.referenceAssetIds.push(rid)
        }
        if (truncated > 0) plan.notes.push(`实体参考图超上限 ${cap} 张，已截断 ${truncated} 张`)
        continue
      }
      if (plan.referenceAssetIds.length >= cap) {
        plan.problems.push(`参考图超过上限 ${cap} 张（已忽略多余连线）`)
        continue
      }
      const id = takeUpstream(e.from)
      if (id != null) plan.referenceAssetIds.push(id)
      continue
    }
    if (e.port === 'first_frame') {
      if (spec.genKind !== 'video') {
        plan.problems.push('首帧连线仅视频节点可用')
        continue
      }
      if (plan.firstFrameAssetId != null) continue
      plan.firstFrameAssetId = takeUpstream(e.from)
      continue
    }
    if (e.port === 'last_frame') {
      if (spec.genKind !== 'video') {
        plan.problems.push('尾帧连线仅视频节点可用')
        continue
      }
      if (plan.lastFrameAssetId != null) continue
      plan.lastFrameAssetId = takeUpstream(e.from)
      continue
    }
    if (e.port === 'source') {
      if (!spec.edit) {
        plan.problems.push('源图连线仅编辑节点可用')
        continue
      }
      if (plan.sourceAssetId != null) continue
      plan.sourceAssetId = takeUpstream(e.from)
      continue
    }
    if (e.port === 'prompt') {
      if (spec.genKind !== 'image' && spec.genKind !== 'video' && spec.genKind !== 'audio' && spec.genKind !== 'llm') {
        plan.problems.push('提示词连线仅图片/视频/音频/LLM 节点可用')
        continue
      }
      if (plan.promptText != null) continue
      const t = upstream.get(e.from)?.text ?? null
      if (t == null || !t.trim()) {
        plan.problems.push(`提示词来源 #${e.from} 暂无文本或为空`)
        continue
      }
      plan.promptText = t.trim()
      continue
    }
    if (e.port === 'text') {
      // [M18] text 端口：llm 素材文本（≤4 段；空文本 → problem）
      if (spec.genKind !== 'llm') {
        plan.problems.push('文本素材连线仅 LLM 节点可用')
        continue
      }
      if (plan.textInputs.length >= LLM_TEXT_CAP) {
        plan.problems.push(`文本素材超过上限 ${LLM_TEXT_CAP} 段（已忽略多余连线）`)
        continue
      }
      const t = upstream.get(e.from)?.text ?? null
      if (t == null || !t.trim()) {
        plan.problems.push(`文本素材来源 #${e.from} 暂无文本或为空`)
        continue
      }
      plan.textInputs.push(t.trim())
      continue
    }
    if (e.port === 'video') {
      if (spec.genKind !== 'compose') {
        plan.problems.push('视频连线仅合成节点可用')
        continue
      }
      if (plan.videoAssetIds.length >= COMPOSE_CAP) {
        plan.problems.push(`视频输入超过上限 ${COMPOSE_CAP} 条（已忽略多余连线）`)
        continue
      }
      const up = upstream.get(e.from)
      if (!up || up.assetId == null) {
        plan.problems.push(`引用节点 #${e.from} 暂无成功产物`)
        continue
      }
      if (up.mediaKind !== 'video') {
        plan.problems.push(`引用节点 #${e.from} 的产物为 ${up.mediaKind ?? '未知'}，不能作为视频输入（仅视频）`)
        continue
      }
      plan.videoAssetIds.push(up.assetId)
      continue
    }
    if (e.port === 'audio') {
      if (spec.genKind !== 'compose') {
        plan.problems.push('音频连线仅合成节点可用')
        continue
      }
      if (plan.audioAssetIds.length >= COMPOSE_CAP) {
        plan.problems.push(`音频输入超过上限 ${COMPOSE_CAP} 条（已忽略多余连线）`)
        continue
      }
      const up = upstream.get(e.from)
      if (!up || up.assetId == null) {
        plan.problems.push(`引用节点 #${e.from} 暂无成功产物`)
        continue
      }
      if (up.mediaKind !== 'audio') {
        plan.problems.push(`引用节点 #${e.from} 的产物为 ${up.mediaKind ?? '未知'}，不能作为音频输入（仅音频）`)
        continue
      }
      plan.audioAssetIds.push(up.assetId)
    }
  }
  if (spec.edit && plan.sourceAssetId == null && !plan.problems.some((p) => p.includes('暂无成功产物') || p.includes('不能作为生成输入'))) {
    plan.problems.push('编辑节点缺少源图连线（source）')
  }
  if (
    spec.genKind === 'compose' &&
    plan.videoAssetIds.length === 0 &&
    !plan.problems.some((p) => p.includes('暂无成功产物') || p.includes('不能作为视频输入'))
  ) {
    plan.problems.push('合成节点缺少视频输入连线（video）')
  }
  return plan
}

/**
 * [M17] 显示/引用任务决策（纯函数）：采纳有效（属本节点 + succeeded + 有产物）→ 该任务；否则最新成功；无 → null。
 * 节点对外引用（下游输入）与节点显示（画廊当前）同源。
 */
export function pickDisplayTask<T extends { id: number; status: string; resultAssetId: number | null }>(
  adoptedTaskId: number | null,
  tasksDesc: T[],
): T | null {
  if (adoptedTaskId != null) {
    const hit = tasksDesc.find((t) => t.id === adoptedTaskId && t.status === 'succeeded' && t.resultAssetId != null)
    if (hit) return hit
  }
  return tasksDesc.find((t) => t.status === 'succeeded' && t.resultAssetId != null) ?? null
}

/** 执行时输入计划 v3（实时解析：采纳优先；text/entity 上游展开；[M18] llm 产物文本装载；供 creation-gen 调用） */
export async function loadInputPlan(
  node: CanvasNode,
  incoming: Array<{ from: number; to: number; port: string }>,
  spec: NodeSpec,
): Promise<InputPlan> {
  const fromIds = [...new Set(incoming.map((e) => e.from))]
  const upstream = new Map<number, UpstreamInfo>()
  if (fromIds.length > 0) {
    const rows = await db.select().from(canvasNodes).where(inArray(canvasNodes.id, fromIds))
    const genRows = rows.filter((r) => r.kind === 'gen')
    const assetRows0 = rows.filter((r) => r.kind === 'asset' && r.assetId != null)
    const entityRows = rows.filter((r) => r.kind === 'entity')
    // gen 上游：全部成功任务（新→旧）→ pickDisplayTask 采纳优先
    const okTasks = genRows.length
      ? await db
          .select()
          .from(genTasks)
          .where(and(inArray(genTasks.canvasNodeId, genRows.map((r) => r.id)), eq(genTasks.status, 'succeeded')))
          .orderBy(desc(genTasks.id))
      : []
    const okByNode = new Map<number, Array<(typeof okTasks)[number]>>()
    for (const t of okTasks) {
      if (t.canvasNodeId == null || t.resultAssetId == null) continue
      const list = okByNode.get(t.canvasNodeId) ?? []
      list.push(t)
      okByNode.set(t.canvasNodeId, list)
    }
    // entity 上游：characters 批查（参考图集）
    const entityRefs = new Map<number, number[]>()
    if (entityRows.length) {
      const eids = entityRows.map((r) => safeParseEntitySpec(r.spec).spec?.entityId).filter((x): x is number => x != null)
      const ents = eids.length ? await db.select().from(characters).where(inArray(characters.id, eids)) : []
      const entById = new Map(ents.map((c) => [c.id, c]))
      for (const r of entityRows) {
        const eid = safeParseEntitySpec(r.spec).spec?.entityId
        const ent = eid != null ? entById.get(eid) : undefined
        entityRefs.set(r.id, ent ? parseRefIds(ent.refAssetIds) : [])
      }
    }
    // 资产：asset 上游 + gen 显示产物（采纳优先）
    const assetIds = new Set<number>(assetRows0.map((r) => r.assetId!))
    const displayAssetByNode = new Map<number, number>()
    for (const r of genRows) {
      const disp = pickDisplayTask(r.adoptedTaskId ?? null, okByNode.get(r.id) ?? [])
      if (disp?.resultAssetId != null) {
        assetIds.add(disp.resultAssetId)
        displayAssetByNode.set(r.id, disp.resultAssetId)
      }
    }
    const assetRows = assetIds.size ? await db.select().from(assets).where(inArray(assets.id, [...assetIds])) : []
    const assetById = new Map(assetRows.map((a) => [a.id, a]))
    for (const r of rows) {
      if (r.kind === 'asset') {
        const a = r.assetId != null ? assetById.get(r.assetId) : undefined
        upstream.set(r.id, { assetId: a?.id ?? null, mediaKind: a?.kind ?? null })
      } else if (r.kind === 'gen') {
        const rid = displayAssetByNode.get(r.id)
        const a = rid != null ? assetById.get(rid) : undefined
        const up: UpstreamInfo = { assetId: a?.id ?? null, mediaKind: a?.kind ?? null }
        // [M18] llm 产物文本装载：prompt/text 端口源侧取正文（文件缺失 → text 留空，planNodeInputs 报「暂无文本」）
        if (a?.kind === 'text' && a.relPath) {
          try {
            up.text = readFileSync(absPathOf(a.relPath), 'utf8')
          } catch {
            up.text = null
          }
        }
        upstream.set(r.id, up)
      } else if (r.kind === 'text') {
        const ts = safeParseTextSpec(r.spec)
        upstream.set(r.id, { assetId: null, mediaKind: null, text: ts.spec?.text ?? null })
      } else if (r.kind === 'entity') {
        upstream.set(r.id, { assetId: null, mediaKind: null, refAssetIds: entityRefs.get(r.id) ?? [] })
      } else {
        upstream.set(r.id, { assetId: null, mediaKind: null })
      }
    }
  }
  return planNodeInputs(spec, node.id, incoming, upstream)
}
