import { writeFileSync } from 'node:fs'
import { extname } from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { assets, genTasks, type Asset, type PipelineStep } from '../../db/schema'
import { absPathOf, ensureProjectDirs, kindByExt, mimeOfExt, registerAsset, relPathOf, sanitizeName, sha256Hex } from '../storage'
import { scheduleImageCheck } from '../image-check'
import { WORKBENCH_ACTIONS, WorkbenchError, shotIdOfAsset } from './helpers'
import { assertRepairable, resolveStoryboardSource } from './inspect'
import { rebuildShotOutput } from './reset'

// ---------- [M10] 上传替换（外来图入镜） ----------

/**
 * [M10] 上传资产入库：kind 按扩展名校验（图步收 image / 视频步收 video）→ sha256 查重：
 * - 命中 → 复制资产行（复用 relPath/mime/sha256 等文件属性，不重复落盘；用途独立不污染原资产）；
 * - 未命中 → 落盘（shot_image → images / shot_video → video）+ 建行。
 * 行属性：stepId=镜头步骤、taskId=null、runId、params={shotId, source:'upload', original_name}。
 * 不走 importFiles：其 sha256 命中即复用原行，无法承载「复制行 + params/用途」语义。
 */
export async function importShotAsset(
  run: { projectId: number; id: number },
  step: PipelineStep,
  shotId: string,
  file: { name: string; data: Uint8Array },
): Promise<Asset> {
  const kindNeed = step.actionKey === 'ai_video' ? 'video' : 'image'
  const ext = extname(file.name)
  const kind = kindByExt(ext)
  if (kind !== kindNeed) {
    throw new WorkbenchError('bad_kind', `文件类型不符（当前步骤需 ${kindNeed}，得到 ${kind}${ext ? ` ${ext}` : ''}）`)
  }
  const purpose = kindNeed === 'video' ? 'shot_video' : 'shot_image'
  const hash = sha256Hex(file.data)
  const params = { shotId, source: 'upload', original_name: file.name }
  const base = {
    name: file.name,
    kind,
    purpose,
    mime: mimeOfExt(ext),
    ext: ext.slice(1),
    sha256: hash,
    params,
    stepId: step.id,
    runId: run.id,
  }
  const existed = await db
    .select()
    .from(assets)
    .where(and(eq(assets.projectId, run.projectId), eq(assets.sha256, hash), isNull(assets.deletedAt)))
    .limit(1)
  const src = existed[0]
  if (src && src.relPath) {
    return await registerAsset(run.projectId, {
      ...base,
      relPath: src.relPath,
      fileSize: src.fileSize ?? file.data.byteLength,
      width: src.width ?? undefined,
      height: src.height ?? undefined,
      duration: src.duration ?? undefined,
    })
  }
  ensureProjectDirs(run.projectId)
  const fileName = `${Date.now()}-${sanitizeName(file.name)}`
  const relPath = relPathOf(run.projectId, purpose, fileName)
  writeFileSync(absPathOf(relPath), file.data)
  return await registerAsset(run.projectId, { ...base, relPath, fileSize: file.data.byteLength })
}

/** [M10] 上传 + 绑定组合（路由层单调用）：校验镜头 → 入库 → 绑定进 output */
export async function uploadAndBindShotAsset(
  runId: number,
  stepKey: string,
  shotId: string,
  file: { name: string; data: Uint8Array },
): Promise<{ asset: Asset; assetIds: number[] }> {
  if (typeof shotId !== 'string' || !shotId) throw new WorkbenchError('bad_shot', 'shot_id 非法')
  const { run, step } = await assertRepairable(runId, stepKey, WORKBENCH_ACTIONS)
  const src = await resolveStoryboardSource(run, step)
  if (!src.shots.some((s) => s.id === shotId)) throw new WorkbenchError('unknown_shot', `镜头 ${shotId} 不在分镜中`)
  const asset = await importShotAsset(run, step, shotId, file)
  scheduleImageCheck(asset)
  const assetIds = await rebuildShotOutput(step, src.shots, { shotId, assetId: asset.id })
  return { asset, assetIds }
}

/**
 * [M10] 绑定既有资产为该镜选中：归属校验（任务产物 ∈ 本步任务集 / 上传资产 stepId=本步骤）
 * + params.shotId 匹配 → 重建 output（该镜位替换/按分镜序插入）。选片放宽后亦可经 select 端点达成，本函数供上传组合与探针。
 */
export async function bindUploadedShotAsset(
  runId: number,
  stepKey: string,
  shotId: string,
  assetId: number,
): Promise<{ assetIds: number[] }> {
  if (typeof shotId !== 'string' || !shotId) throw new WorkbenchError('bad_shot', 'shot_id 非法')
  const { run, step } = await assertRepairable(runId, stepKey, WORKBENCH_ACTIONS)
  const src = await resolveStoryboardSource(run, step)
  if (!src.shots.some((s) => s.id === shotId)) throw new WorkbenchError('unknown_shot', `镜头 ${shotId} 不在分镜中`)
  const rows = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1)
  const a = rows[0]
  if (!a) throw new WorkbenchError('bad_asset', `资产 #${assetId} 不存在`)
  if (a.projectId !== run.projectId) throw new WorkbenchError('bad_asset', `资产 #${assetId} 不属于本项目`)
  if (a.deletedAt) throw new WorkbenchError('bad_asset', `资产 #${assetId} 已删除`)
  const kindNeed = step.actionKey === 'ai_video' ? 'video' : 'image'
  if (a.kind !== kindNeed) throw new WorkbenchError('bad_asset', `资产 #${assetId} 类型不符（需 ${kindNeed}）`)
  if (shotIdOfAsset(a) !== shotId) throw new WorkbenchError('bad_asset', `资产 #${assetId} 与镜头 ${shotId} 不匹配`)
  await assertAssetBelongsToStep(run.id, step, a)
  const assetIds = await rebuildShotOutput(step, src.shots, { shotId, assetId: a.id })
  return { assetIds }
}

/** 资产归属校验：任务产物（∈ 本步任务集）或上传资产（stepId=本步骤） */
async function assertAssetBelongsToStep(runId: number, step: PipelineStep, a: Asset): Promise<void> {
  if (a.taskId != null) {
    const rows = await db
      .select({ id: genTasks.id })
      .from(genTasks)
      .where(and(eq(genTasks.runId, runId), eq(genTasks.stepId, step.id), eq(genTasks.id, a.taskId)))
      .limit(1)
    if (!rows[0]) throw new WorkbenchError('bad_asset', `资产 #${a.id} 不属于该步骤（任务或上传）`)
  } else if (a.stepId !== step.id) {
    throw new WorkbenchError('bad_asset', `资产 #${a.id} 不属于该步骤（任务或上传）`)
  }
}
