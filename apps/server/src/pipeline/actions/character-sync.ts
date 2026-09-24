import { attachRefAssets, upsertCharacter } from '../../services/character'
import { writeTextAsset } from '../../services/storage'
import type { StepContext } from '../context'
import { StepError, type StepResult } from '../types'

/**
 * character_sync：角色档案入库（E3 一致性链源头）。
 * 输入 characters：characters-json 资产（多资产逐个尝试，取第一个含非空 characters 数组的）；
 * [M13] states 变体随档案入库（normalizeSpec 保留，upsertEntity 非空覆盖）；
 * 输入 ref_images?：定妆照资产序列（按 asset.params.shotId = 角色名归属，未命中按资产名含角色名兜底）；
 * params：{ project = true }（true → 当前项目域；false → 全局角色库 projectId=NULL，不挂项目资产）。
 * 产物：建档日志资产（purpose=character_log，JSON 快照 { created, updated, refAttached, scope }）。
 * 幂等：同 name 再跑 → updated 分支（不重复插入）；refAssetIds 并集去重。
 * 失败：characters 无有效档案 → StepError（含输入资产名与解析失败原因）。
 */
export async function characterSync(ctx: StepContext): Promise<StepResult> {
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const toProject = params['project'] !== false
  const projectId = toProject ? ctx.run.projectId : null

  const { specs, sourceName } = await resolveSpecs(ctx)
  ctx.log(`角色建档：${specs.length} 名（来源 ${sourceName}，scope=${toProject ? 'project' : 'global'}）`)

  const created: string[] = []
  const updated: string[] = []
  for (const s of specs) {
    const r = await upsertCharacter({
      projectId,
      name: s.name,
      aliases: s.aliases,
      summary: s.summary,
      appearance: s.appearance,
      negative: s.negative,
      voice: s.voice,
      voiceDesc: s.voiceDesc,
      states: s.states,
    })
    if (r.created) created.push(s.name)
    else updated.push(s.name)
    ctx.log(`角色「${s.name}」${r.created ? '新建' : '更新'} → #${r.id}`)
  }

  const refAttached = await attachRefImages(ctx, projectId, specs)
  if (refAttached > 0) ctx.log(`定妆照挂接 ${refAttached} 张`)
  if (!toProject && ctx.assetIdsOf('ref_images').length > 0) ctx.log('全局角色库不接受项目资产引用，ref_images 已跳过')

  const scope = toProject ? 'project' : 'global'
  const result = { scope, created, updated, refAttached }
  const asset = await writeTextAsset(ctx.run.projectId, {
    name: 'character-log.md',
    content: JSON.stringify(result, null, 2),
    purpose: 'character_log',
    stepId: ctx.step.id,
    params: { created: created.length, updated: updated.length, refAttached, scope },
    tags: ['characters'],
  })
  ctx.log(`建档日志 → asset#${asset.id}（${asset.relPath}）`)
  return { assetIds: [asset.id] }
}

interface CharacterSpec {
  name: string
  aliases?: string[]
  appearance?: string
  summary?: string
  negative?: string
  voice?: string
  /** [B③] 自然语言声线描述（档案产 voice_desc；展示/审计，不进声链） */
  voiceDesc?: string
  /** [M13] 状态变体（「{剧情节点}：{状态短语}」；逐字对齐设定包） */
  states?: string[]
}

/** characters-json 资产解析：逐个尝试，取第一个可解析出非空角色数组的资产；全部失败 → StepError（含资产名与原因） */
async function resolveSpecs(ctx: StepContext): Promise<{ specs: CharacterSpec[]; sourceName: string }> {
  const ids = ctx.assetIdsOf('characters')
  if (ids.length === 0) throw new StepError('角色档案输入为空（inputs.characters 需为 characters-json 资产）')
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
    const raw = Array.isArray(obj) ? obj : (obj as { characters?: unknown }).characters
    if (!Array.isArray(raw) || raw.length === 0) {
      failures.push(`${a.name}（缺非空 characters 数组）`)
      continue
    }
    const specs = raw.map(normalizeSpec).filter((s): s is CharacterSpec => s !== null)
    if (specs.length === 0) {
      failures.push(`${a.name}（characters 各项缺有效 name）`)
      continue
    }
    return { specs, sourceName: a.name }
  }
  throw new StepError(`角色档案解析失败（${failures.join('；')}）`)
}

/** 定妆照归属：asset.params.shotId（角色名/别名）优先，未命中按资产名含角色名兜底 → attachRefAssets 并集入档 */
async function attachRefImages(ctx: StepContext, projectId: number | null, specs: CharacterSpec[]): Promise<number> {
  if (projectId === null) return 0 // 全局角色库不接受项目资产引用
  const ids = ctx.assetIdsOf('ref_images')
  if (ids.length === 0) return 0
  const assets = await ctx.assetsOf(ids)

  const ownerOf = new Map<string, string>() // 名称/别名（含小写）→ 档案角色名
  for (const s of specs) {
    ownerOf.set(s.name, s.name)
    ownerOf.set(s.name.toLowerCase(), s.name)
    for (const a of s.aliases ?? []) {
      ownerOf.set(a, s.name)
      ownerOf.set(a.toLowerCase(), s.name)
    }
  }

  const groups = new Map<string, number[]>()
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
      specs.find((s) => a.name.includes(s.name))?.name ??
      null
    if (!owner) continue
    const arr = groups.get(owner) ?? []
    arr.push(a.id)
    groups.set(owner, arr)
  }

  let attached = 0
  for (const [name, assetIds] of groups) {
    attached += await attachRefAssets(projectId, name, assetIds)
  }
  return attached
}

export function normalizeSpec(v: unknown): CharacterSpec | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const name = typeof o['name'] === 'string' ? o['name'].trim() : ''
  if (!name) return null
  const aliases = Array.isArray(o['aliases'])
    ? o['aliases'].filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim())
    : []
  // [M13] states 变体保留（去重保序；空数组省略）
  const states = Array.isArray(o['states'])
    ? [...new Set(o['states'].filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()))]
    : []
  return {
    name,
    aliases: aliases.length > 0 ? aliases : undefined,
    appearance: strOrUndef(o['appearance']),
    summary: strOrUndef(o['summary']),
    negative: strOrUndef(o['negative']),
    voice: strOrUndef(o['voice']),
    voiceDesc: strOrUndef(o['voice_desc']),
    states: states.length > 0 ? states : undefined,
  }
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}
