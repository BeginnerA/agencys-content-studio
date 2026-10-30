import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { contentContinuityRecords as records } from '../../db/schema'
import { UseDocSchema, type Executor, type Unit, type UseDoc } from './contract'
import { readContinuityVersion } from './sources'
import { documentTransaction, writeDocument } from './store'

/** Task5 §5.4: 启动恢复。把上次进程遗留的 extracting 条目与 dispatching 消费标记为 unknown
 * （prepared 是从未派发的意图，刻意不动、可继续），并把 dispatching 的 UseDoc 对齐为 unknown 状态。
 * 全程零模型调用；重复执行幂等；任何单行文档修复失败只保留状态级标记，绝不阻塞启动。 */
export async function recoverContinuityOperations(): Promise<{ entries: number; consumptions: number }> {
  const marked = await documentTransaction(async ex => {
    const now = Date.now()
    const entries = await ex.update(records)
      .set({ status: 'unknown', errorCode: 'continuity_outcome_unknown', updatedAt: now })
      .where(and(eq(records.rowType, 'entry'), eq(records.status, 'extracting')))
      .returning({ id: records.id })
    const consumptions = await ex.update(records)
      .set({ status: 'unknown', errorCode: 'continuity_outcome_unknown', updatedAt: now })
      .where(and(eq(records.rowType, 'consumption'), eq(records.status, 'dispatching')))
      .returning({ id: records.id })
    return { entries: entries.length, consumptions: consumptions.length }
  })
  const aligned = await alignUnknownUseDocuments(db)
  return { entries: marked.entries, consumptions: marked.consumptions + aligned }
}

/** 每个 unknown 消费行尽力把仍写着 dispatching 的文档改写为 unknown；损坏文档保持状态级标记即可。 */
async function alignUnknownUseDocuments(ex: Executor): Promise<number> {
  const rows = await ex.select().from(records)
    .where(and(eq(records.rowType, 'consumption'), eq(records.status, 'unknown')))
  let aligned = 0
  for (const row of rows) {
    try {
      await documentTransaction(async tx => {
        const [current] = await tx.select().from(records).where(eq(records.id, row.id)).limit(1)
        if (!current || current.rowType !== 'consumption' || current.status !== 'unknown') return
        if (current.documentAssetId === null || current.documentVersionId === null || current.documentHash === null) return
        const text = await readContinuityVersion(tx, current.projectId,
          { assetId: current.documentAssetId, versionId: current.documentVersionId, hash: current.documentHash })
        let doc: UseDoc
        try { doc = UseDocSchema.parse(JSON.parse(text)) } catch { return }
        if (doc.state !== 'dispatching') return
        const unit: Unit = { projectId: current.projectId, scopeKind: current.scopeKind, scopeId: current.scopeId,
          unitKind: current.unitKind, unitId: current.unitId, unitOrdinal: current.unitOrdinal }
        const unknownDoc: UseDoc = { ...doc, state: 'unknown', submitted: doc.submitted ?? null, billing: 'unknown',
          completedAt: null, output: null, usage: doc.usage, errorCode: 'continuity_outcome_unknown' }
        const ref = await writeDocument(tx, unit, 'consumption', unknownDoc, current.documentAssetId)
        // 行指针同步到新版本，读取侧才会解析到 unknown 文档而非遗留 dispatching 版本。
        await tx.update(records).set({ documentAssetId: ref.assetId, documentVersionId: ref.versionId,
          documentHash: ref.hash, updatedAt: Date.now() }).where(eq(records.id, current.id))
        aligned++
      })
    } catch { /* 单行失败不扩大：行已是 unknown，可由人工对账或后续恢复再对齐。 */ }
  }
  return aligned
}
