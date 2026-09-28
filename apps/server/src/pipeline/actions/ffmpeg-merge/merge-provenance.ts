// ffmpeg_merge 执行快照记录：从 index.ts 纯搬迁（行为保真拆分，不改合成语义/批准链）。
// 职责：把镜头/配音/字幕/BGM/分镜输入汇总为 exec 快照并落库；任何失败仅记日志、绝不影响合成。
import { assetInput, safeRecordExecSnapshot, type ExecInputSpec } from '../../../services/provenance'
import { shotIdOfAsset } from './segments'
import type { StepContext } from '../../context'
import type { Asset } from '../../../db/schema'

/**
 * 合成输入旁路快照（失败仅告警，不触碰 buildComposeArgs 零漂移红线与成片产物）。
 * 媒体资产不可变→ versionId=null（身份即资产 id）；分镜 JSON 为可编辑文本→携版本指针（编辑分镜→下游成片可报）。
 */
export async function recordMergeProvenance(
  ctx: StepContext,
  p: {
    rows: Asset[]
    usedSegments: Array<{ id: number }>
    skipped: number[]
    voiceIds: number[]
    subtitleIds: number[]
    bgmAssetId: number | null
    shotsAssetId: number | null
  },
): Promise<void> {
  try {
    const inputs: ExecInputSpec[] = []
    const byId = new Map(p.rows.map((a) => [a.id, a]))
    let ordinal = 0
    for (const seg of p.usedSegments) {
      const a = byId.get(seg.id)
      const shotId = a ? shotIdOfAsset(a) : null
      inputs.push(await assetInput('source', seg.id, { shotId, port: 'images', ordinal: ordinal++ }))
    }
    for (const id of p.skipped) inputs.push(await assetInput('source', id, { used: false, skipReason: '缺文件或类型不符', port: 'images' }))
    for (let i = 0; i < p.voiceIds.length; i++) inputs.push(await assetInput('voice', p.voiceIds[i]!, { ordinal: i }))
    for (const id of p.subtitleIds.slice(0, 1)) inputs.push(await assetInput('subtitle', id))
    if (p.bgmAssetId != null) inputs.push(await assetInput('bgm', p.bgmAssetId))
    if (p.shotsAssetId != null) inputs.push(await assetInput('text', p.shotsAssetId))
    await safeRecordExecSnapshot({
      projectId: ctx.run.projectId,
      execKind: 'pipeline_step',
      runId: ctx.run.id,
      stepId: ctx.step.id,
      templateKey: ctx.def.key,
      inputs,
    })
  } catch (err) {
    ctx.log(`执行快照记录失败（已忽略，不影响合成）：${(err as Error).message}`)
  }
}
