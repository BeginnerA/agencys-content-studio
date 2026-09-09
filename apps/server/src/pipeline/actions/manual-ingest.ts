import { writeTextAsset } from '../../services/storage'
import type { StepContext } from '../context'
import type { StepResult } from '../types'

/**
 * manual_ingest：素材入库（spec §5.3）。
 * docs 引用项目内已有资产（imports 上传登记）；brief 落盘为文本摘要资产。
 * 同步完成，产物 = [brief 资产, ...docs 资产]。
 */
export async function manualIngest(ctx: StepContext): Promise<StepResult> {
  const runInput = JSON.parse(ctx.run.input) as Record<string, unknown>
  const docIds = ctx.assetIdsOf('docs')
  const brief = ctx.input['brief']
  if (typeof brief !== 'string' || !brief.trim()) {
    throw new Error('缺少本集题材简报（input.brief 非空文本）')
  }

  const docAssets = docIds.length > 0 ? await ctx.assetsOf(docIds) : []
  const ep = runInput['episode_number'] ?? ''
  const briefAsset = await writeTextAsset(ctx.run.projectId, {
    name: `brief-ep${String(ep).padStart(3, '0')}.md`,
    content: brief.trim(),
    purpose: 'brief',
    stepId: ctx.step.id,
    tags: ['brief'],
  })
  ctx.log(`简报已入库 asset#${briefAsset.id}（${briefAsset.fileSize} 字节）`)
  if (docAssets.length > 0) {
    ctx.log(`关联设定素材 ${docAssets.length} 份：${docAssets.map((a) => a.name).join(', ')}`)
  } else {
    ctx.log('未提供设定素材（仅简报，进入剧本生成）')
  }
  return { assetIds: [briefAsset.id, ...docIds] }
}
