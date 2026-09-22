import { readFileSync } from 'node:fs'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import { assets, type Asset } from '../../db/schema'
import { absPathOf, sha256Hex } from '../storage'
import { hashJson } from './contract'
import { compileDialogueShot } from './dialogue'
import { validateDialogueTranscript } from './dialogue-media'
import type { CreationRecipe } from './recipe'

const cachedResponseSchema = z.object({
  cacheKey: z.string().length(64), sourceHash: z.string().length(64),
  timing: z.object({ videoStart: z.number().finite(), audioStart: z.number().finite(), videoDuration: z.number().positive(), audioDuration: z.number().positive() }).strict(),
  raw: z.unknown(),
}).strict()
export type DialogueResponse = z.infer<typeof cachedResponseSchema>
export interface DialogueSource { sourceAssetId: number; sourceHash: string; cacheKey: string; dialogueHash: string; shotId: string }

/** 源文件内容而非资产 ID 定义缓存；批准角色/台词另行绑定，避免复用错对白。 */
export function dialogueSource(recipe: CreationRecipe, shotId: string, asset: Asset, projectId: number): DialogueSource {
  if (recipe.plan.performance !== 'dialogue' || !recipe.asr) throw new Error('缺少批准的严格 ASR 快照')
  if (asset.projectId !== projectId || asset.deletedAt !== null || asset.kind !== 'video' || !asset.relPath) throw new Error(`镜头 ${shotId} 原声视频不可用`)
  const compiled = compileDialogueShot(recipe.plan, shotId)
  const params = JSON.parse(asset.params ?? '{}')
  if (params.shotId !== shotId || params.dialogueHash !== compiled.dialogueHash) throw new Error(`镜头 ${shotId} 视频不属于当前批准角色和台词`)
  const sourceHash = sha256Hex(readFileSync(absPathOf(asset.relPath)))
  if (asset.sha256 && asset.sha256 !== sourceHash) throw new Error(`镜头 ${shotId} 视频内容已变化`)
  const { configId, configHash, model, protocol } = recipe.asr
  return { sourceAssetId: asset.id, sourceHash, cacheKey: hashJson({ sourceHash, configId, configHash, model, protocol }), dialogueHash: compiled.dialogueHash, shotId }
}

/** 缓存本身也核验内容摘要；损坏不能解释为缓存未命中而暗中重新付费。 */
export async function findDialogueResponse(projectId: number, source: DialogueSource): Promise<{ asset: Asset; data: DialogueResponse } | null> {
  const rows = await db.select().from(assets).where(and(eq(assets.projectId, projectId), eq(assets.purpose, 'dialogue_transcript'), isNull(assets.deletedAt)))
  for (const asset of rows) {
    const params = JSON.parse(asset.params ?? '{}')
    if (params.cacheKey !== source.cacheKey) continue
    if (!asset.relPath || asset.kind !== 'text') throw new Error('对白转写缓存文件不可用')
    const bytes = readFileSync(absPathOf(asset.relPath))
    if (!asset.sha256 || sha256Hex(bytes) !== asset.sha256) throw new Error('对白转写缓存内容已变化')
    const data = cachedResponseSchema.parse(JSON.parse(bytes.toString('utf8')))
    if (data.cacheKey !== source.cacheKey || data.sourceHash !== source.sourceHash) throw new Error('对白转写缓存来源不一致')
    return { asset, data }
  }
  return null
}

/** 只读入口供合成、候选和零付费重合成复用；绝不提交 ASR 请求。 */
export async function validatedDialogueClip(recipe: CreationRecipe, shotId: string, asset: Asset, projectId: number) {
  const source = dialogueSource(recipe, shotId, asset, projectId)
  const cached = await findDialogueResponse(projectId, source)
  if (!cached) throw new Error(`镜头 ${shotId} 缺少匹配原声核验，请显式确认校验费用；本地重合成不会调用 ASR`)
  const transcript = validateDialogueTranscript(recipe.plan, shotId, cached.data.raw, cached.data.timing)
  return { ...source, cacheAssetId: cached.asset.id, timing: cached.data.timing, transcript, duration: recipe.plan.shots.find((s) => s.id === shotId)!.duration }
}
