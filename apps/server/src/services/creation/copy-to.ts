/**
 * 跨画布复制（写模型）：把源画布节点子集复制到目标画布（同项目直接引用 / 跨项目资产级联拷贝混合策略）。
 * - 公共语义（对齐 ops.copyNodes）：深拷 spec/assetId/adoptedTaskId/seq/title；groupId 不拷；集合内部边重映射重建；
 *   位置 = 原位置 + offset（缺省 +40,+40）；
 * - 同项目路径：资产/实体引用原样（同一项目域内直接引用，零拷贝）；
 * - 跨项目路径（混合策略）：asset 节点资产读源 relPath → 写目标项目目录 → registerAsset（params.copiedFrom 留痕）；
 *   gen spec.bgmAssetId / subtitleAssetId / edit.maskAssetId 引用重写（经同一资产映射缓存，去重）；entity 节点级联
 *   （characters 行新插 + refAssetIds 逐张拷贝 + spec.entityId 重写）；adoptedTaskId → null（任务归属不迁移）；
 *   run 节点跳过（cross_project_run_node——runId 无法跨项目重建）；
 * - 宽容降级：资产行缺失 → asset 节点跳过（missing_asset）；被引用资产缺失/拷贝失败 → 字段置空 + warnings；坏 spec 原样保真。
 * 依赖方向：copy-to → storage / spec / ops（单向）；零网络、零适配器调用。
 */
import { and, asc, eq, inArray } from 'drizzle-orm'
import { readFileSync, writeFileSync } from 'node:fs'
import { db } from '../../db'
import { assets, canvasEdges, canvasNodes, characters, entityReferences } from '../../db/schema'
import type { Canvas, CanvasEdge, CanvasNode } from '../../db/schema'
import { deriveSync } from '../entity-references'
import { absPathOf, ensureProjectDirs, registerAsset, relPathOf, sanitizeName } from '../storage'
import { parseRefIds, safeParseEntitySpec, safeParseSpec } from './spec'
import { loadCanvasNodes, parseNodeIds, parseOffset } from './ops'

// ---------- 类型 ----------

/** 跳过记账（节点未复制：跨项目 run / 实体或资产缺失） */
export interface CopyToSkip {
  nodeId: number
  reason: string
}

export interface CopyToResult {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  skipped: CopyToSkip[]
  /** 跨项目实际拷贝的资产数（同项目恒 0——直接引用） */
  assetsCopied: number
  /** 宽容降级留痕（引用置空等；不阻断复制） */
  warnings: string[]
}

// ---------- 内部工具 ----------

/** JSON 对象宽容解析：非法 → {}（params 合并用） */
function parseJsonObj(raw: string | null): Record<string, unknown> {
  try {
    const o: unknown = JSON.parse(raw ?? '{}')
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** JSON 字符串数组宽容解析：非法 → []（tags 重登记用） */
function parseJsonArr(raw: string | null): string[] {
  try {
    const a: unknown = JSON.parse(raw ?? '[]')
    return Array.isArray(a) ? a.map(String) : []
  } catch {
    return []
  }
}

// ---------- 主流程 ----------

/**
 * 跨画布复制：src/target 须为活跃画布行（路由层 findCanvas 过滤）；src ≠ target。
 * 返回 { nodes, edges, skipped, assetsCopied, warnings }——nodes/edges 为新建行（目标画布域）。
 */
export async function copyNodesToCanvas(
  src: Canvas,
  target: Canvas,
  rawIds: unknown,
  rawOffset: unknown,
): Promise<CopyToResult> {
  if (src.id === target.id) throw new Error('目标画布不能与源画布相同（同画布复制请用 /nodes/copy）')
  const ids = parseNodeIds(rawIds)
  const srcNodes = await loadCanvasNodes(src, ids)
  const offset = parseOffset(rawOffset)
  const sameProject = src.projectId === target.projectId
  const now = Date.now()

  const idMap = new Map<number, number>()
  const nodes: CanvasNode[] = []
  const skipped: CopyToSkip[] = []
  const warnings: string[] = []
  /** 跨项目资产映射缓存：源资产 id → 目标资产 id（null = 缺失/拷贝失败；去重防多节点重复拷贝） */
  const assetMap = new Map<number, number | null>()
  /** 跨项目实体映射缓存：源实体 id → 目标实体 id（null = 缺失） */
  const entityMap = new Map<number, number | null>()

  /** 深拷单个资产到目标项目（文件 + 资产行；params.copiedFrom 留痕） */
  const copyAsset = async (srcAssetId: number): Promise<number | null> => {
    const cached = assetMap.get(srcAssetId)
    if (cached !== undefined) return cached
    const rows = await db.select().from(assets).where(eq(assets.id, srcAssetId)).limit(1)
    const a = rows[0]
    if (!a) {
      warnings.push(`资产 #${srcAssetId} 行缺失，引用已置空`)
      assetMap.set(srcAssetId, null)
      return null
    }
    if (!a.relPath) {
      warnings.push(`资产 #${srcAssetId} 无落盘路径（relPath 缺失），引用已置空`)
      assetMap.set(srcAssetId, null)
      return null
    }
    let copiedId: number | null = null
    try {
      ensureProjectDirs(target.projectId)
      const data = readFileSync(absPathOf(a.relPath))
      const ext = a.ext ?? ''
      const base = sanitizeName(a.name)
      const hasExt = !!ext && base.toLowerCase().endsWith(`.${ext.toLowerCase()}`)
      const fileName = `${Date.now()}-${base}${ext && !hasExt ? `.${ext}` : ''}`
      const relPath = relPathOf(target.projectId, a.purpose, fileName)
      writeFileSync(absPathOf(relPath), data)
      const row = await registerAsset(target.projectId, {
        name: a.name,
        kind: a.kind,
        purpose: a.purpose ?? undefined,
        relPath,
        mime: a.mime ?? undefined,
        ext: a.ext ?? undefined,
        fileSize: a.fileSize ?? undefined,
        width: a.width ?? undefined,
        height: a.height ?? undefined,
        duration: a.duration ?? undefined,
        sha256: a.sha256 ?? undefined,
        prompt: a.prompt ?? undefined,
        params: { ...parseJsonObj(a.params), copiedFrom: { projectId: a.projectId, assetId: a.id } },
        tags: parseJsonArr(a.tags),
      })
      copiedId = row.id
    } catch (err) {
      warnings.push(`资产 #${srcAssetId} 拷贝失败：${(err as Error).message}`)
    }
    assetMap.set(srcAssetId, copiedId)
    return copiedId
  }

  /** 实体级联：characters 行新插到目标项目（refAssetIds 逐张拷贝；元数据原样） */
  const copyEntity = async (srcEntityId: number): Promise<number | null> => {
    const cached = entityMap.get(srcEntityId)
    if (cached !== undefined) return cached
    const rows = await db.select().from(characters).where(eq(characters.id, srcEntityId)).limit(1)
    const e = rows[0]
    if (!e) {
      warnings.push(`实体 #${srcEntityId} 行缺失，节点已跳过`)
      entityMap.set(srcEntityId, null)
      return null
    }
    const newRefIds: number[] = []
    const srcRefRows = await db.select().from(entityReferences).where(eq(entityReferences.entityId, srcEntityId))
    const flatIds = parseRefIds(e.refAssetIds)
    for (const rid of flatIds) {
      const nid = await copyAsset(rid)
      if (nid != null) newRefIds.push(nid)
    }
    // 停用分层行的资产不在扁平列里，也得拷过来：否则副本上这些行找不到映射、只能整行丢弃，
    // 用户「停用但保留」的分层意图就丢在跨项目复制这一步
    for (const r of srcRefRows) if (!flatIds.includes(r.assetId)) await copyAsset(r.assetId)
    const [row] = await db
      .insert(characters)
      .values({
        projectId: target.projectId,
        kind: e.kind,
        name: e.name,
        aliases: e.aliases,
        summary: e.summary,
        appearance: e.appearance,
        negative: e.negative,
        voice: e.voice,
        states: e.states,
        refAssetIds: JSON.stringify(newRefIds),
        meta: e.meta,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    entityMap.set(srcEntityId, row!.id)
    // 分层登记行随实体一起重建：entity_references 才是参考集真源，只带扁平列过去的话
    // 副本实体没有分层行 → 状态/视角变体被当隐式基准取用（语义丢失），且全程无提示。
    // stateKey 原样带上（副本的 states 列同源复制，条目原文仍精确匹配）。
    if (srcRefRows.length > 0) {
      for (const r of srcRefRows) {
        const copiedAssetId = assetMap.get(r.assetId)
        if (copiedAssetId == null) {
          // 资产没拷过来（行缺失/拷贝失败）就没有可登记的资产：留一行警告，不静默丢一半
          warnings.push(`实体 #${srcEntityId} 的分层参考资产 #${r.assetId} 未能拷贝，该登记行在副本上跳过`)
          continue
        }
        await db
          .insert(entityReferences)
          .values({ entityId: row!.id, assetId: copiedAssetId, role: r.role, stateKey: r.stateKey, viewKey: r.viewKey, enabled: r.enabled, note: r.note, createdAt: now })
      }
      // 副本的扁平列按它自己的分层真源重算（派生列必须等于 enabled 行重算结果，否则一登记就整体覆盖时会出现两份口径）
      await deriveSync(row!.id)
    }
    return row!.id
  }

  for (const n of srcNodes) {
    // 1) 跨项目：run 节点跳过（runId 无法跨项目重建）
    if (!sameProject && n.kind === 'run') {
      skipped.push({ nodeId: n.id, reason: 'cross_project_run_node' })
      continue
    }
    // 2) asset 引用（跨项目拷贝；行缺失 → 节点跳过）
    let newAssetId = n.assetId
    if (!sameProject && n.assetId != null) {
      const copiedId = await copyAsset(n.assetId)
      if (copiedId == null) {
        skipped.push({ nodeId: n.id, reason: 'missing_asset' })
        continue
      }
      newAssetId = copiedId
    }
    // 3) spec 引用重写（跨项目：gen 内联资产引用 / entity 级联）
    let newSpec = n.spec
    if (!sameProject && n.spec) {
      if (n.kind === 'gen') {
        const parsed = safeParseSpec(n.spec)
        if (parsed.spec) {
          const spec = parsed.spec
          let changed = false
          if (spec.bgmAssetId != null) {
            spec.bgmAssetId = (await copyAsset(spec.bgmAssetId)) ?? undefined
            changed = true
          }
          if (spec.subtitleAssetId != null) {
            spec.subtitleAssetId = (await copyAsset(spec.subtitleAssetId)) ?? undefined
            changed = true
          }
          if (spec.edit?.maskAssetId != null) {
            spec.edit.maskAssetId = (await copyAsset(spec.edit.maskAssetId)) ?? undefined
            changed = true
          }
          if (changed) newSpec = JSON.stringify(spec)
        }
        // 坏 spec 原样保真（对齐读模型宽容哲学）
      } else if (n.kind === 'entity') {
        const parsed = safeParseEntitySpec(n.spec)
        if (parsed.spec) {
          const newEntityId = await copyEntity(parsed.spec.entityId)
          if (newEntityId == null) {
            skipped.push({ nodeId: n.id, reason: 'missing_entity' })
            continue
          }
          newSpec = JSON.stringify({ entityId: newEntityId })
        }
      }
    }
    // 4) 落库（groupId 不拷；跨项目 adoptedTaskId → null）
    const [row] = await db
      .insert(canvasNodes)
      .values({
        canvasId: target.id,
        kind: n.kind,
        assetId: newAssetId,
        title: n.title,
        spec: newSpec,
        x: n.x + offset.x,
        y: n.y + offset.y,
        adoptedTaskId: sameProject ? n.adoptedTaskId : null,
        seq: n.seq,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    idMap.set(n.id, row!.id)
    nodes.push(row!)
  }

  // 5) 集合内部边重映射重建（跨集合边不复制；跳过的节点不参与）
  const copiedSrcIds = [...idMap.keys()]
  const edges: CanvasEdge[] = []
  if (copiedSrcIds.length > 0) {
    const inner = await db
      .select()
      .from(canvasEdges)
      .where(and(eq(canvasEdges.canvasId, src.id), inArray(canvasEdges.from, copiedSrcIds), inArray(canvasEdges.to, copiedSrcIds)))
      .orderBy(asc(canvasEdges.id))
    for (const e of inner) {
      const [row] = await db
        .insert(canvasEdges)
        .values({ canvasId: target.id, from: idMap.get(e.from)!, to: idMap.get(e.to)!, port: e.port, createdAt: now })
        .returning()
      edges.push(row!)
    }
  }

  return {
    nodes,
    edges,
    skipped,
    assetsCopied: [...assetMap.values()].filter((v) => v != null).length,
    warnings,
  }
}
