import { attachRefAssets, upsertEntity, type EntityKind } from '../../services/character'
import { GLOBAL_POOL_ID } from '../../services/global-pool'
import { writeTextAsset } from '../../services/storage'
import type { StepContext } from '../context'
import { StepError, type StepResult } from '../types'

/**
 * entity_sync：场景/道具素材建档（素材链；对齐 character_sync 的手感与产物模式）。
 * 输入 sets：set-json 资产（多资产逐个尝试，取第一个含非空 scenes/props 的）；
 * 输入 ref_images?：参考图资产序列（按 asset.params.shotId = 场景/道具名归属，未命中按资产名包含兜底）；
 * params：{ project = true }（true → 当前项目域；false → 全局素材库 projectId=NULL，不挂项目资产）。
 * 产物：建档日志资产（purpose=set_log，JSON 快照 { scope, created, updated, refAttached }）。
 * 幂等：同 kind 同域同名 → updated 分支（不重复插入）；refAssetIds 并集去重。
 * 失败：sets 无有效档案 → StepError（含输入资产名与解析失败原因）。
 */
export async function entitySync(ctx: StepContext): Promise<StepResult> {
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const toProject = params['project'] !== false
  const projectId = toProject ? ctx.run.projectId : null

  const { scenes, props, sourceName } = await resolveSpecs(ctx)
  ctx.log(`素材建档：场景 ${scenes.length} 项 / 道具 ${props.length} 项（来源 ${sourceName}，scope=${toProject ? 'project' : 'global'}）`)

  const createdScenes: string[] = []
  const updatedScenes: string[] = []
  const createdProps: string[] = []
  const updatedProps: string[] = []
  const syncKind = async (kind: EntityKind, specs: EntitySpec[], created: string[], updated: string[]): Promise<void> => {
    const label = kind === 'scene' ? '场景' : '道具'
    for (const s of specs) {
      const r = await upsertEntity({
        projectId,
        kind,
        name: s.name,
        aliases: s.aliases,
        appearance: s.appearance,
        summary: s.summary,
        negative: s.negative,
      })
      if (r.created) created.push(s.name)
      else updated.push(s.name)
      ctx.log(`${label}「${s.name}」${r.created ? '新建' : '更新'} → #${r.id}`)
    }
  }
  await syncKind('scene', scenes, createdScenes, updatedScenes)
  await syncKind('prop', props, createdProps, updatedProps)

  const refAttached = await attachRefImages(ctx, projectId, scenes, props)
  if (refAttached > 0) ctx.log(`参考图挂接 ${refAttached} 张`)
  if (!toProject && ctx.assetIdsOf('ref_images').length > 0)
    ctx.log('全局素材仅挂全局池参考图（项目 ref_images 不越界入全局，已跳过）')

  const scope = toProject ? 'project' : 'global'
  const result = {
    scope,
    created: { scenes: createdScenes, props: createdProps },
    updated: { scenes: updatedScenes, props: updatedProps },
    refAttached,
  }
  const asset = await writeTextAsset(ctx.run.projectId, {
    name: 'set-log.md',
    content: JSON.stringify(result, null, 2),
    purpose: 'set_log',
    stepId: ctx.step.id,
    params: {
      created: createdScenes.length + createdProps.length,
      updated: updatedScenes.length + updatedProps.length,
      refAttached,
      scope,
    },
    tags: ['sets'],
  })
  ctx.log(`建档日志 → asset#${asset.id}（${asset.relPath}）`)
  return { assetIds: [asset.id] }
}

interface EntitySpec {
  name: string
  aliases?: string[]
  appearance?: string
  summary?: string
  negative?: string
}

/** set-json 资产解析：逐个尝试，取第一个含非空 scenes/props 的资产；全部失败 → StepError（含资产名与原因） */
async function resolveSpecs(ctx: StepContext): Promise<{ scenes: EntitySpec[]; props: EntitySpec[]; sourceName: string }> {
  const ids = ctx.assetIdsOf('sets')
  if (ids.length === 0) throw new StepError('场景/道具档案输入为空（inputs.sets 需为 set-json 资产）')
  const assets = await ctx.assetsOf(ids)
  const failures: string[] = []
  for (const a of assets) {
    if (a.kind !== 'text') {
      failures.push(`${a.name}（非文本资产）`)
      continue
    }
    let obj: unknown
    try {
      obj = JSON.parse(await ctx.readText(a.id))
    } catch (err) {
      failures.push(`${a.name}（JSON 解析失败：${(err as Error).message}）`)
      continue
    }
    const o = (obj ?? {}) as { scenes?: unknown; props?: unknown }
    const scenes = normalizeList(o.scenes)
    const props = normalizeList(o.props)
    if (scenes.length === 0 && props.length === 0) {
      failures.push(`${a.name}（scenes/props 双空）`)
      continue
    }
    return { scenes, props, sourceName: a.name }
  }
  throw new StepError(`场景/道具档案解析失败（${failures.join('；')}）`)
}

function normalizeList(raw: unknown): EntitySpec[] {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeSpec).filter((s): s is EntitySpec => s !== null)
}

/** 条目规整：appearance 主字段（set-profile 输出口径），宽容接受 visual 别名（均落库 appearance 列）；ref_prompt 忽略（仅出图链消费） */
function normalizeSpec(v: unknown): EntitySpec | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const name = typeof o['name'] === 'string' ? o['name'].trim() : ''
  if (!name) return null
  const aliases = Array.isArray(o['aliases'])
    ? o['aliases'].filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim())
    : []
  return {
    name,
    aliases: aliases.length > 0 ? aliases : undefined,
    appearance: strOrUndef(o['appearance']) ?? strOrUndef(o['visual']),
    summary: strOrUndef(o['summary']),
    negative: strOrUndef(o['negative']),
  }
}

/** 参考图归属：asset.params.shotId（场景/道具名/别名）优先，未命中按资产名包含兜底 → attachRefAssets 并集入档。
 * projectId=null（全局）→ 仅消费全局池资产（非池项目资产跳过），挂到全局域行。 */
async function attachRefImages(ctx: StepContext, projectId: number | null, scenes: EntitySpec[], props: EntitySpec[]): Promise<number> {
  const ids = ctx.assetIdsOf('ref_images')
  if (ids.length === 0) return 0
  let assets = await ctx.assetsOf(ids)
  if (projectId === null) {
    assets = assets.filter((a) => a.projectId === GLOBAL_POOL_ID)
    if (assets.length === 0) return 0
  }

  const ownerOf = new Map<string, { kind: EntityKind; name: string }>() // 名称/别名（含小写）→ 档案归属
  for (const [kind, specs] of [['scene', scenes], ['prop', props]] as const) {
    for (const s of specs) {
      const owner = { kind, name: s.name }
      ownerOf.set(s.name, owner)
      ownerOf.set(s.name.toLowerCase(), owner)
      for (const a of s.aliases ?? []) {
        ownerOf.set(a, owner)
        ownerOf.set(a.toLowerCase(), owner)
      }
    }
  }

  const groups = new Map<string, { kind: EntityKind; name: string; assetIds: number[] }>()
  for (const a of assets) {
    if (a.kind !== 'image') continue
    let shotId = ''
    if (a.params) {
      try {
        const p = JSON.parse(a.params) as { shotId?: unknown }
        if (typeof p.shotId === 'string') shotId = p.shotId.trim()
      } catch {
        // params 损坏 → 走资产名兜底
      }
    }
    const owner =
      (shotId ? ownerOf.get(shotId) ?? ownerOf.get(shotId.toLowerCase()) : undefined) ??
      byNameInclude(a.name, scenes, props) ??
      null
    if (!owner) continue
    const key = `${owner.kind}:${owner.name}`
    const g = groups.get(key) ?? { kind: owner.kind, name: owner.name, assetIds: [] }
    g.assetIds.push(a.id)
    groups.set(key, g)
  }

  let attached = 0
  for (const g of groups.values()) {
    attached += await attachRefAssets(projectId, g.name, g.assetIds, g.kind)
  }
  return attached
}

/** 资产名包含兜底（场景优先，其次道具） */
function byNameInclude(assetName: string, scenes: EntitySpec[], props: EntitySpec[]): { kind: EntityKind; name: string } | null {
  const scene = scenes.find((s) => assetName.includes(s.name))
  if (scene) return { kind: 'scene', name: scene.name }
  const prop = props.find((s) => assetName.includes(s.name))
  if (prop) return { kind: 'prop', name: prop.name }
  return null
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}
