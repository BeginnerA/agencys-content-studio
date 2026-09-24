import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { assets } from '../../db/schema'
import { writeTextAsset } from '../storage'
import { WORKBENCH_ACTIONS, WorkbenchError, type ShotSpec } from './helpers'
import { assertRepairable, findProducerStep, resolveStoryboardSource } from './inspect'
import { rebuildShotOutput, replaceProducerOutputAsset } from './reset'
import { shotDurationSec } from './board'

/**
 * [审计·跨项目隔离] 分镜镜头携带的资产 id 类字段（参考图）——写入口归属校验覆盖的键（单一真源）。
 * 读时 assetToDataUri 已按 projectId 做 chokepoint 拒绝跨项目注入；写时（工作台结构性编辑）此处
 * 落库前统一拒绝跨项目 / 不存在 / 已删除资产，给出清晰早期错误（配成双保险，对齐 selection.ts picks 归属校验范式）。
 * 目前镜头级唯一按 id 注入图片的字段是 ref_asset_ids（ai-image / ai-video 消费）；如后续新增同类字段在此登记。
 */
const SHOT_ASSET_ID_KEYS = ['ref_asset_ids'] as const

export interface ShotEditItem {
  shot_id: string
  image_prompt?: string
  motion_prompt?: string
  duration?: number
}

/**
 * 结构性编辑操作（spec §2.2）：按序应用、每条在应用时点校验；
 * 前端建议序列 add* → patch* → remove* → reorder（reorder 含最终全部 id）。
 */
export type ShotOp =
  | { op: 'reorder'; order: string[] }
  | { op: 'add'; shot: Record<string, unknown> }
  | { op: 'remove'; shot_id: string }
  | { op: 'patch'; shot_id: string; fields: Record<string, unknown> }

// ---------- 分镜编辑 ----------

/**
 * 分镜编辑：时长/提示词字段级编辑 → 写分镜新版本资产 + 替换产出步骤 output 保位。
 * 不触发执行、不改 run 状态；生效路径：重生成 / 重新合成时经引用解析自然消费新分镜。
 */
export async function applyStoryboardEdits(
  runId: number,
  stepKey: string,
  items: ShotEditItem[],
): Promise<{ assetId: number; assetIds: number[]; edited: number }> {
  if (!Array.isArray(items) || items.length === 0) throw new WorkbenchError('bad_items', 'shots 需为非空数组')
  const { run, step } = await assertRepairable(runId, stepKey, WORKBENCH_ACTIONS)
  const src = await resolveStoryboardSource(run, step)

  // 产出步骤溯源（写新资产 stepId + 替换 output 保位皆依赖）
  const producer = await findProducerStep(src.asset, run)
  if (!producer) throw new WorkbenchError('no_producer', '分镜资产无产出步骤溯源，暂不支持编辑')

  // 全量校验后统一应用（防部分写入）
  const shotById = new Map(src.shots.map((s) => [s.id, s]))
  const normalized: Array<{
    shot: ShotSpec
    patch: { image_prompt?: string; motion_prompt?: string; duration?: number }
    changed: boolean
  }> = []
  for (const item of items) {
    if (!item || typeof item.shot_id !== 'string' || !item.shot_id) {
      throw new WorkbenchError('bad_items', 'shot_id 非法')
    }
    const shot = shotById.get(item.shot_id)
    if (!shot) throw new WorkbenchError('unknown_shot', `镜头 ${item.shot_id} 不在分镜中`)
    const patch: { image_prompt?: string; motion_prompt?: string; duration?: number } = {}
    let changed = false
    for (const field of ['image_prompt', 'motion_prompt'] as const) {
      const v = item[field]
      if (v === undefined) continue
      if (typeof v !== 'string' || !v.trim()) {
        throw new WorkbenchError('bad_prompt', `镜头 ${item.shot_id} ${field} 需为非空字符串`)
      }
      const text = v.trim()
      patch[field] = text
      const current = typeof shot[field] === 'string' ? (shot[field] as string).trim() : ''
      if (text !== current) changed = true
    }
    if (item.duration !== undefined) {
      if (typeof item.duration !== 'number' || !Number.isFinite(item.duration) || item.duration <= 0 || item.duration > 60) {
        throw new WorkbenchError('bad_duration', `镜头 ${item.shot_id} duration 需在 (0, 60] 秒内`)
      }
      const v = Math.round(item.duration * 10) / 10
      patch.duration = v
      if (v !== shotDurationSec(shot)) changed = true
    }
    if (Object.keys(patch).length === 0) {
      throw new WorkbenchError('bad_items', `镜头 ${item.shot_id} 未提供任何可编辑字段`)
    }
    normalized.push({ shot, patch, changed })
  }
  const changedItems = normalized.filter((n) => n.changed)
  if (changedItems.length === 0) throw new WorkbenchError('no_change', '所有编辑项与当前分镜一致，无实际变化')

  // 写分镜新版本资产（对齐 approveGate 先例：新资产 + 替换 output 保位）
  const updated = applyPatches(src.parsed, changedItems)
  const baseName = src.asset.name.replace(/\.[^.]+$/, '').replace(/-工作台编辑$/, '')
  const editedAt = Date.now()
  const newAsset = await writeTextAsset(run.projectId, {
    name: `${baseName}-工作台编辑.json`,
    content: JSON.stringify(updated, null, 2),
    purpose: src.asset.purpose ?? 'storyboard',
    format: 'storyboard-json',
    stepId: producer.id,
    runId: run.id,
    params: { edited_shots: changedItems.map((n) => n.shot.id), source_asset_id: src.asset.id, editedAt },
    tags: ['workbench'],
  })

  // 替换产出步骤 output 中旧分镜 id 的位置（保位；gate/skipped 字段原样保留）
  const ids = await replaceProducerOutputAsset(producer, src.asset.id, newAsset.id, editedAt)

  return { assetId: newAsset.id, assetIds: ids, edited: changedItems.length }
}

// ---------- 结构性编辑（ops 协议） ----------

/**
 * 结构性编辑：ops 按序应用（每条在应用时点校验）→ 写分镜新版本资产 →
 * 保位替换 producer output → 重建镜头步骤 output.asset_ids（新分镜序 × 当前选中映射）。不触发执行。
 */
export async function applyStoryboardOps(
  runId: number,
  stepKey: string,
  ops: ShotOp[],
): Promise<{ assetId: number; assetIds: number[]; shots: number }> {
  if (!Array.isArray(ops) || ops.length === 0) throw new WorkbenchError('bad_ops', 'ops 需为非空数组')
  const { run, step } = await assertRepairable(runId, stepKey, WORKBENCH_ACTIONS)
  const src = await resolveStoryboardSource(run, step)
  const producer = await findProducerStep(src.asset, run)
  if (!producer) throw new WorkbenchError('no_producer', '分镜资产无产出步骤溯源，暂不支持编辑')

  // [审计·跨项目隔离] 写入口预算校验：add/patch 可向镜头写入 ref_asset_ids，落库前统一拒绝非本项目资产
  await assertOpsAssetIdsScoped(run.projectId, ops)

  // 工作副本：deep 拷贝保持裸数组 / {shots:[]} 形态；仅保留有 id 的有效镜头（结构性编辑统一规范化）
  const deep = JSON.parse(JSON.stringify(src.parsed)) as unknown
  const rawArr = ((Array.isArray(deep) ? deep : (deep as { shots?: unknown[] }).shots) ?? []) as unknown[]
  let work: ShotSpec[] = rawArr.filter(
    (s): s is ShotSpec => !!s && typeof s === 'object' && typeof (s as ShotSpec).id === 'string' && !!(s as ShotSpec).id,
  )
  for (const op of ops) work = applyOneOp(work, op)

  // 写回原形态
  if (Array.isArray(deep)) {
    ;(deep as unknown[]).splice(0, (deep as unknown[]).length, ...work)
  } else {
    ;(deep as { shots?: ShotSpec[] }).shots = work
  }

  const baseName = src.asset.name.replace(/\.[^.]+$/, '').replace(/-工作台编辑$/, '')
  const editedAt = Date.now()
  const newAsset = await writeTextAsset(run.projectId, {
    name: `${baseName}-工作台编辑.json`,
    content: JSON.stringify(deep, null, 2),
    purpose: src.asset.purpose ?? 'storyboard',
    format: 'storyboard-json',
    stepId: producer.id,
    runId: run.id,
    params: {
      ops: ops.map((o) => (o as { op?: unknown })?.op),
      shot_count: work.length,
      source_asset_id: src.asset.id,
      editedAt,
    },
    tags: ['workbench'],
  })
  await replaceProducerOutputAsset(producer, src.asset.id, newAsset.id, editedAt)
  const assetIds = await rebuildShotOutput(step, work)
  return { assetId: newAsset.id, assetIds, shots: work.length }
}

/** 拖拽重排（单条 reorder op 的便捷入口） */
export async function reorderShots(
  runId: number,
  stepKey: string,
  order: string[],
): Promise<{ assetId: number; assetIds: number[]; shots: number }> {
  return applyStoryboardOps(runId, stepKey, [{ op: 'reorder', order }])
}

/**
 * [审计·跨项目隔离] 结构性编辑写入口预算校验：遍历 ops 收集 add.shot / patch.fields 上的资产 id 类字段
 * （SHOT_ASSET_ID_KEYS，一次查询）→ 全部须存在、属本项目、未删除，否则抛 WorkbenchError('bad_asset')。
 * 与 assetToDataUri 读时 chokepoint 配成双保险：读时已阻止实际注入，写时提前给出清晰错误、拒绝脏 id 落库。
 */
async function assertOpsAssetIdsScoped(projectId: number, ops: ShotOp[]): Promise<void> {
  const ids = new Set<number>()
  const collect = (holder: Record<string, unknown> | undefined | null): void => {
    if (!holder) return
    for (const key of SHOT_ASSET_ID_KEYS) {
      const v = holder[key]
      if (v === undefined || v === null) continue
      if (!Array.isArray(v)) throw new WorkbenchError('bad_field', `${key} 需为资产 id 数组`)
      for (const raw of v) {
        const n = Number(raw)
        if (!Number.isInteger(n) || n <= 0) throw new WorkbenchError('bad_asset', `${key} 含非法资产 id：${String(raw)}`)
        ids.add(n)
      }
    }
  }
  for (const op of ops) {
    const raw = (op ?? {}) as Record<string, unknown>
    if (raw['op'] === 'add') collect(raw['shot'] as Record<string, unknown> | undefined)
    else if (raw['op'] === 'patch') collect(raw['fields'] as Record<string, unknown> | undefined)
  }
  if (ids.size === 0) return
  const list = [...ids]
  const rows = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(inArray(assets.id, list), eq(assets.projectId, projectId), isNull(assets.deletedAt)))
  const found = new Set(rows.map((r) => r.id))
  const bad = list.filter((id) => !found.has(id))
  if (bad.length > 0) {
    throw new WorkbenchError('bad_asset', `参考图资产不存在或不属于本项目（跨项目引用被拒）：${bad.map((b) => `#${b}`).join('、')}`)
  }
}

/** 单条 op 应用（运行时不变量校验；失败抛 WorkbenchError） */
function applyOneOp(shots: ShotSpec[], op: ShotOp): ShotSpec[] {
  const raw = (op ?? {}) as Record<string, unknown>
  switch (raw['op']) {
    case 'reorder': {
      const order = raw['order']
      if (!Array.isArray(order)) throw new WorkbenchError('bad_order', 'reorder.order 需为 id 数组')
      const byId = new Map(shots.map((s) => [s.id, s]))
      const seen = new Set<string>()
      for (const id of order) {
        if (typeof id !== 'string' || !id) throw new WorkbenchError('bad_order', 'reorder.order 含非法 id')
        if (seen.has(id)) throw new WorkbenchError('bad_order', `reorder.order 含重复 id：${id}`)
        if (!byId.has(id)) throw new WorkbenchError('bad_order', `reorder.order 含未知 id：${id}`)
        seen.add(id)
      }
      const missing = shots.map((s) => s.id).filter((id) => !seen.has(id))
      if (missing.length > 0) throw new WorkbenchError('bad_order', `reorder.order 缺少镜头：${missing.join('、')}`)
      return order.map((id) => byId.get(id as string)!)
    }
    case 'add': {
      const shotRaw = raw['shot']
      if (!shotRaw || typeof shotRaw !== 'object' || Array.isArray(shotRaw)) {
        throw new WorkbenchError('bad_add', 'add.shot 需为对象')
      }
      const shot = JSON.parse(JSON.stringify(shotRaw)) as ShotSpec
      if (typeof shot.id !== 'string' || !shot.id) throw new WorkbenchError('bad_add', 'add.shot.id 需为非空字符串')
      if (shots.some((s) => s.id === shot.id)) throw new WorkbenchError('bad_add', `镜头 id ${shot.id} 已存在`)
      if (typeof shot.image_prompt !== 'string' || !shot.image_prompt.trim()) {
        throw new WorkbenchError('bad_add', `镜头 ${shot.id} image_prompt 需为非空字符串`)
      }
      return [...shots, shot]
    }
    case 'remove': {
      const shotId = raw['shot_id']
      if (typeof shotId !== 'string' || !shotId) throw new WorkbenchError('bad_shot', 'remove.shot_id 非法')
      if (!shots.some((s) => s.id === shotId)) throw new WorkbenchError('unknown_shot', `镜头 ${shotId} 不在分镜中`)
      if (shots.length <= 1) throw new WorkbenchError('keep_min', '至少保留 1 个镜头')
      return shots.filter((s) => s.id !== shotId)
    }
    case 'patch': {
      const shotId = raw['shot_id']
      if (typeof shotId !== 'string' || !shotId) throw new WorkbenchError('bad_shot', 'patch.shot_id 非法')
      const fields = raw['fields']
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        throw new WorkbenchError('bad_patch', 'patch.fields 需为对象')
      }
      const shot = shots.find((s) => s.id === shotId)
      if (!shot) throw new WorkbenchError('unknown_shot', `镜头 ${shotId} 不在分镜中`)
      applyShotPatch(shot, fields as Record<string, unknown>)
      return shots
    }
    default:
      throw new WorkbenchError('bad_op', `未知操作：${String(raw['op'])}`)
  }
}

/** patch 字段校验 + 浅合并（原地；id 拒绝修改，duration 双写 duration_sec，其余键宽松透传） */
function applyShotPatch(shot: ShotSpec, fields: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'id') throw new WorkbenchError('bad_field', '镜头 id 不允许修改')
    if (key === 'image_prompt') {
      if (typeof value !== 'string' || !value.trim()) throw new WorkbenchError('bad_field', 'image_prompt 需为非空字符串')
      shot.image_prompt = value.trim()
      continue
    }
    if (key === 'motion_prompt') {
      if (typeof value !== 'string') throw new WorkbenchError('bad_field', 'motion_prompt 需为字符串')
      shot.motion_prompt = value.trim()
      continue
    }
    if (key === 'duration') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 60) {
        throw new WorkbenchError('bad_field', 'duration 需在 (0, 60] 秒内')
      }
      const v = Math.round(value * 10) / 10
      shot.duration = v
      // 原分镜若用 duration_sec 口径（LLM 产出）则同步，防下游读取分歧（对齐 applyPatches）
      if (Object.prototype.hasOwnProperty.call(shot, 'duration_sec')) shot.duration_sec = v
      continue
    }
    if (key === 'characters') {
      if (!Array.isArray(value) || value.some((c) => typeof c !== 'string' || !(c as string).trim())) {
        throw new WorkbenchError('bad_field', 'characters 需为非空字符串数组')
      }
      shot.characters = value.map((c) => (c as string).trim())
      continue
    }
    if (key === 'lines') {
      // 台词绑定（音字对齐映射源）：字符串数组（可为空 = 无台词镜），元素为非空台词 id
      if (!Array.isArray(value) || value.some((c) => typeof c !== 'string' || !c.trim())) {
        throw new WorkbenchError('bad_field', 'lines 需为字符串数组（元素为非空台词 id）')
      }
      shot.lines = value.map((c) => c.trim())
      continue
    }
    // 其余键宽松透传（请求体已经过 JSON.parse，值为 JSON-safe）
    shot[key] = value
  }
}

/** 应用补丁（深拷贝原始 JSON，保持裸数组 / {shots:[]} 形态） */
function applyPatches(
  parsed: unknown,
  edits: Array<{ shot: ShotSpec; patch: { image_prompt?: string; motion_prompt?: string; duration?: number } }>,
): unknown {
  const deep = JSON.parse(JSON.stringify(parsed)) as unknown
  const arr = (Array.isArray(deep) ? deep : (deep as { shots?: ShotSpec[] }).shots) ?? []
  const byId = new Map<string, ShotSpec>()
  for (const s of arr) {
    if (s && typeof s.id === 'string') byId.set(s.id, s)
  }
  for (const e of edits) {
    const s = byId.get(e.shot.id)
    if (!s) continue
    if (e.patch.image_prompt !== undefined) s.image_prompt = e.patch.image_prompt
    if (e.patch.motion_prompt !== undefined) s.motion_prompt = e.patch.motion_prompt
    if (e.patch.duration !== undefined) {
      s.duration = e.patch.duration
      // 原分镜若用 duration_sec 口径（LLM 产出）则同步，防下游读取分歧
      if (Object.prototype.hasOwnProperty.call(s, 'duration_sec')) s.duration_sec = e.patch.duration
    }
  }
  return deep
}
