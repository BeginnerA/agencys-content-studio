import { writeTextAsset } from '../../services/storage'
import { upsertMemory } from '../../services/memory'
import type { StepContext } from '../context'
import { interpolate } from '../refs'
import { StepError, type StepResult } from '../types'

/**
 * memory_write：把上游文本沉淀为长期记忆（spec §4.2）。
 * 输入 content：text 资产（可多个 → 换行拼接）或 ctx.input.content 字面文本；
 * params：{ scope: project|global（默认 project）, type（默认 note）, name?（具名 = 同域同名 upsert 幂等） }。
 * 产物：记忆日志资产（purpose=memory_log，快照 JSON，name_tpl 默认 memory-log.md）；
 * embedding 不可用 → StepError 含 model:prepare 指引（不静默）。
 */
export async function memoryWrite(ctx: StepContext): Promise<StepResult> {
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const scope = params['scope'] === 'global' ? 'global' : 'project'
  const type = typeof params['type'] === 'string' && params['type'] ? params['type'] : 'note'
  const name = typeof params['name'] === 'string' && params['name'] ? params['name'] : null

  const content = await collectContent(ctx)
  if (!content) throw new StepError('记忆内容为空（inputs.content 需为 text 资产或非空字面文本）')

  const { id, created } = await upsertMemory({
    projectId: scope === 'global' ? null : ctx.run.projectId,
    type,
    name,
    content,
    meta: { runId: ctx.run.id, stepId: ctx.step.id, source: 'memory_write' },
  }).catch((err: Error) => {
    throw new StepError(`记忆写入失败：${err.message}（若为模型缺失，先运行 pnpm --filter @acs/server model:prepare）`)
  })
  ctx.log(`记忆#${id} ${created ? '新增' : '更新'}（scope=${scope}, type=${type}, name=${name ?? '—'}, ${content.length} 字符）`)

  const snapshot = { id, scope, type, name, chars: content.length, preview: content.slice(0, 120) }
  const runInput = JSON.parse(ctx.run.input) as Record<string, unknown>
  const nameTpl = typeof params['name_tpl'] === 'string' ? params['name_tpl'] : 'memory-log.md'
  const asset = await writeTextAsset(ctx.run.projectId, {
    name: interpolate(nameTpl, runInput),
    content: JSON.stringify(snapshot, null, 2),
    purpose: 'memory_log',
    stepId: ctx.step.id,
    params: { memoryId: id, scope, type, name, chars: content.length, preview: snapshot.preview },
    tags: ['memory'],
  })
  ctx.log(`记忆日志 → asset#${asset.id}（${asset.relPath}）`)
  return { assetIds: [asset.id] }
}

/** content 解析：text 资产全文拼接（换行）优先，其次 ctx.input.content 字面文本 */
async function collectContent(ctx: StepContext): Promise<string> {
  const ids = ctx.assetIdsOf('content')
  if (ids.length > 0) {
    const assets = await ctx.assetsOf(ids)
    const parts: string[] = []
    for (const a of assets) {
      if (a.kind !== 'text') continue
      const text = (await ctx.readText(a.id)).trim()
      if (text) parts.push(text)
    }
    return parts.join('\n\n')
  }
  const v = ctx.input['content']
  return typeof v === 'string' ? v.trim() : ''
}
