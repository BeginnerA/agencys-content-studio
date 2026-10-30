import { unlinkSync } from 'node:fs'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import { assets, contentContinuityRecords as records, contentVersions, pipelineSteps,
  type ContentContinuityRecord } from '../../db/schema'
import { BudgetBlockedError } from '../budget'
import type { StepContext } from '../../pipeline/context'
import type { StepResult } from '../../pipeline/types'
import type { ChatMessage } from '../llm'
import { validateTextOutput } from '../../pipeline/actions/text-output'
import { isJsonTextFormat, writeTextAsset, absPathOf } from '../storage'
import { recordAssetTextVersion, safeRecordExecSnapshot } from '../provenance'
import { resolveUnitPrice } from '../usage'
import { ChatMessageSchema, ContinuityError, UseDocSchema, type ContinuityIO, type ContextDoc,
  type DocRef, type Executor, type Unit, type UseDoc } from './contract'
import { currentConfirmed, documentRef } from './entries'
import { canonicalHash } from './fold'
import { continuityIO, withContinuityIO } from './runtime'
import { readContinuityVersion } from './sources'
import { documentTransaction, writeDocument } from './store'
import { llmOptions, materializeTarget } from './targets'
import { evaluateEntry } from './validity'

/** Task5 §5.1–5.4: 调用证据状态机。一次逻辑调用一次 chat；prepared→dispatching→completed 同事务发布，
 * 任一步失败不得再次 chat。重入只认持久证据（登记行 + UseDoc），绝不仅凭步骤状态决定重发。 */

const USE_LIMITS = { messages: 160_000 } as const
type ConsumptionRow = ContentContinuityRecord

const loadRound = (ex: Executor, projectId: number, operationKey: string) =>
  ex.select().from(records).where(and(eq(records.projectId, projectId), eq(records.rowType, 'consumption'),
    eq(records.operationKey, operationKey))).limit(1).then(rows => rows[0] ?? null)

const latestUse = (ex: Executor, projectId: number, runId: number, stepId: number) =>
  ex.select().from(records).where(and(eq(records.projectId, projectId), eq(records.rowType, 'consumption'),
    eq(records.runId, runId), eq(records.stepId, stepId))).orderBy(desc(records.id)).limit(1).then(rows => rows[0] ?? null)

async function useDocument(row: ConsumptionRow, ex: Executor): Promise<UseDoc | null> {
  if (row.documentAssetId === null || row.documentVersionId === null || row.documentHash === null) return null
  try {
    const text = await readContinuityVersion(ex, row.projectId,
      { assetId: row.documentAssetId, versionId: row.documentVersionId, hash: row.documentHash })
    return UseDocSchema.parse(JSON.parse(text))
  } catch { return null }
}

/** 调用前与派发前的双重复核：每个打包条目仍须是其前集的当前 confirmed 有效头（归属/状态/哈希/来源）。 */
async function revalidatePack(projectId: number, doc: ContextDoc, ex: Executor): Promise<void> {
  for (const ref of doc.entries) {
    const [row] = await ex.select().from(records).where(and(eq(records.id, ref.entryId),
      eq(records.projectId, projectId), eq(records.rowType, 'entry'))).limit(1)
    if (!row || row.status !== 'confirmed' || row.unitOrdinal !== ref.unitOrdinal
      || canonicalHash(documentRef(row)) !== canonicalHash({ assetId: ref.assetId, versionId: ref.versionId, hash: ref.hash })
      || (await currentConfirmed(row as Unit, ex)) !== row.id
      || (await evaluateEntry(row.id, ex)).validity !== 'valid') {
      throw new ContinuityError('continuity_source_changed', 409)
    }
  }
}

/** 只有明确人工 gate reject 的持久决策指纹才授权同 run/step 开新轮；engine 自动 attempts 一律不作数。 */
function rejectFingerprint(stepOutput: string | null): string | null {
  let parsed: unknown
  try { parsed = JSON.parse(stepOutput ?? 'null') } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const gate = (parsed as Record<string, unknown>)['gate']
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) return null
  if ((gate as Record<string, unknown>)['decision'] !== 'reject') return null
  return canonicalHash(gate)
}

const normalizeUsage = (usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null) =>
  usage ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens } : null

async function completedAssetIds(row: ConsumptionRow): Promise<StepResult> {
  const doc = await useDocument(row, db)
  if (doc?.state !== 'completed' || !doc.output) throw new ContinuityError('continuity_conflict', 409, row.id)
  return { assetIds: [doc.output.assetId] }
}

export async function executeContinuityText(ctx: StepContext, messages: ChatMessage[],
    output: { name: string; purpose: string; format: string }, io?: ContinuityIO): Promise<StepResult> {
  if (io) return withContinuityIO(io, () => executeContinuityText(ctx, messages, output))
  const active = continuityIO()
  const projectId = ctx.run.projectId, runId = ctx.run.id, stepId = ctx.step.id

  // (1) 完整消息即真实界：160000 按 JSON.stringify(messages).length 精确执行（Task4 遗留 1 的收口）。
  const parsed = z.array(ChatMessageSchema).safeParse(messages)
  if (!parsed.success) throw new ContinuityError('continuity_evidence_invalid', 400)
  const preparedMessages = parsed.data as ChatMessage[]
  const messagesJson = JSON.stringify(preparedMessages)
  if (messagesJson.length > USE_LIMITS.messages) throw new ContinuityError('continuity_context_too_large', 413)
  const messagesHash = canonicalHash(preparedMessages)

  // (2) 归属/状态/哈希三重校验的冻结承接包：只认 bound 且属于本 run/step 的 context 行。
  const [contextRow] = await db.select().from(records).where(and(eq(records.projectId, projectId),
    eq(records.rowType, 'context'), eq(records.runId, runId), eq(records.stepId, stepId),
    eq(records.status, 'bound'))).orderBy(desc(records.id)).limit(1)
  if (!contextRow) throw new ContinuityError('continuity_source_invalid', 404)
  const contextRef = documentRef(contextRow)
  const doc = await readContextDoc(projectId, contextRow)
  const configHash = doc.target.configHash

  // (3) 调用前重校验包：任一来源漂移即 409，不派发。
  await revalidatePack(projectId, doc, db)

  // (4) 端点与目标材质：configHash 指纹（sanitizeBaseUrl + 同一已解析 options）必须与冻结时一致。
  const endpoint = await active.endpoint()
  if (!endpoint.baseUrl || !endpoint.apiKey || !endpoint.model) throw new ContinuityError('continuity_unsupported', 400)
  const material = await materializeTarget(projectId, doc.target.request, db, endpoint)
  if (canonicalHash(material.target) !== canonicalHash(doc.target)) {
    throw new ContinuityError('continuity_context_changed', 409)
  }
  const options = llmOptions(material.template)

  // (5) 预算预检（只是预检；真实结算在响应后）。双价不可解析时按 0 估且不阻断（结算侧自然留痕）。
  const prices = await Promise.all((['tokens_in', 'tokens_out'] as const).map(unit =>
    resolveUnitPrice({ kind: 'llm', provider: endpoint.providerKey, model: endpoint.model, unit })))
  const estimatedCost = prices.some(p => p === null)
    ? null : Math.ceil(messagesJson.length / 4) * prices[0]! + options.maxTokens * prices[1]!
  const blocked = await active.budget({ projectId, ...(estimatedCost === null ? {} : { estimatedCost }) })
  if (blocked) throw new BudgetBlockedError(blocked.code, blocked.message)

  // (6) 轮次裁决（唯一数据库仲裁；进程内不再加锁）。gate 决策以持久化的 pipeline_steps.output 为准，
  // 不读 ctx.step 内存快照（引擎重跑时快照必然滞后于人工 reject）。
  const keyFor = (round: string) => `u${runId}x${stepId}-${round}`
  const requestHashFor = (round: string) =>
    canonicalHash({ kind: 'continuity_use', projectId, runId, stepId, round, messagesHash, context: contextRef, configHash })

  const handle = async (row: ConsumptionRow, ex: Executor): Promise<{ row: ConsumptionRow; action: 'dispatch' | 'done'; doc: UseDoc }> => {
    if (row.status === 'completed') return { row, action: 'done', doc: null as never }
    if (row.status === 'unknown' || row.status === 'dispatching') {
      throw new ContinuityError('continuity_outcome_unknown', 409, row.id)
    }
    if (row.status === 'failed') throw new ContinuityError('continuity_conflict', 409, row.id)
    const prior = await useDocument(row, ex)
    if (row.status !== 'prepared' || !prior || prior.state !== 'prepared' || canonicalHash(prior.messages) !== messagesHash) {
      throw new ContinuityError('continuity_context_changed', 409, row.id)
    }
    return { row, action: 'dispatch', doc: prior }
  }

  const open = async (ex: Executor, round: string): Promise<{ row: ConsumptionRow; action: 'dispatch' | 'done'; doc: UseDoc }> => {
    const useDoc: UseDoc = { schemaVersion: 1, state: 'prepared', context: contextRef, entries: doc.entries,
      runId, stepId, round, messages: preparedMessages, messagesHash, provider: endpoint.providerKey, model: endpoint.model,
      configHash, submitted: false, billing: 'not_submitted', startedAt: null, completedAt: null, output: null,
      usage: null, errorCode: null, sourceChangedAfterDispatch: false }
    const ref = await writeDocument(ex, doc.target.unit, 'consumption', useDoc)
    const [inserted] = await ex.insert(records).values({ ...doc.target.unit, rowType: 'consumption', status: 'prepared',
      runId, stepId, operationKey: keyFor(round), requestHash: requestHashFor(round), documentAssetId: ref.assetId,
      documentVersionId: ref.versionId, documentHash: ref.hash, createdAt: active.now(), updatedAt: active.now() })
      .onConflictDoNothing({ target: [records.projectId, records.rowType, records.operationKey] }).returning()
    if (!inserted) {
      const winner = await loadRound(ex, projectId, keyFor(round))
      if (!winner) throw new ContinuityError('continuity_conflict', 409)
      return handle(winner, ex)
    }
    return { row: inserted, action: 'dispatch', doc: useDoc }
  }

  const claim = await documentTransaction(async ex => {
    const [stepRow] = await ex.select({ output: pipelineSteps.output }).from(pipelineSteps)
      .where(eq(pipelineSteps.id, stepId)).limit(1)
    const fp = rejectFingerprint(stepRow?.output ?? null)
    const fpRound = fp === null ? null : `rj-${fp.slice(0, 32)}`
    if (fp !== null) {
      const existing = await loadRound(ex, projectId, keyFor(fpRound!))
      if (existing) return handle(existing, ex)
      const latest = await latestUse(ex, projectId, runId, stepId)
      if (latest) {
        if (latest.status === 'unknown' || latest.status === 'dispatching') {
          throw new ContinuityError('continuity_outcome_unknown', 409, latest.id)
        }
        if (latest.status === 'prepared') {
          // 持久 reject 决策已取代这段从未派发的尝试（零已承诺费用）：如实记 failed 后开新轮。
          await ex.update(records).set({ status: 'failed', errorCode: 'continuity_conflict', updatedAt: active.now() })
            .where(and(eq(records.id, latest.id), eq(records.status, 'prepared')))
        }
      }
      return open(ex, fpRound!)
    }
    const latest = await latestUse(ex, projectId, runId, stepId)
    if (latest) {
      if (latest.status === 'failed') throw new ContinuityError('continuity_conflict', 409, latest.id)
      return handle(latest, ex)
    }
    return open(ex, 'initial')
  })

  if (claim.action === 'done') return completedAssetIds(claim.row)
  const row = claim.row, preparedDoc = claim.doc

  let dispatched = false, usageRecorded = false, result: Awaited<ReturnType<typeof active.chat>> | null = null
  const startedAt = active.now()
  try {
    active.fault('before_dispatch')
    // prepared → dispatching：最终复核（在途漂移在此之后不重发），CAS 持久化完整 messages 版本。
    const cas = await documentTransaction(async ex => {
      const [current] = await ex.select().from(records).where(and(eq(records.id, row.id),
        eq(records.projectId, projectId), eq(records.rowType, 'consumption'))).limit(1)
      if (!current) throw new ContinuityError('continuity_conflict', 409, row.id)
      if (current.status === 'completed') return { completed: true as const }
      if (current.status !== 'prepared') throw new ContinuityError('continuity_conflict', 409, current.id)
      await revalidatePack(projectId, doc, ex)
      const dispatching: UseDoc = { ...preparedDoc, state: 'dispatching', submitted: null, billing: 'unknown',
        startedAt, completedAt: null, output: null, usage: null, errorCode: null, sourceChangedAfterDispatch: false as const }
      const ref = await writeDocument(ex, doc.target.unit, 'consumption', dispatching, current.documentAssetId!)
      const updated = await ex.update(records).set({ status: 'dispatching', documentAssetId: ref.assetId,
        documentVersionId: ref.versionId, documentHash: ref.hash, updatedAt: active.now() })
        .where(and(eq(records.id, current.id), eq(records.status, 'prepared'),
          eq(records.documentVersionId, current.documentVersionId!))).returning()
      if (updated.length !== 1) throw new ContinuityError('continuity_conflict', 409, current.id)
      return { completed: false as const }
    })
    if (cas.completed) return completedAssetIds(row)
    dispatched = true

    // 一次逻辑调用恰好一次 chat；此后任何失败都不得再次 chat。
    result = await active.chat(preparedMessages, endpoint, options)
    active.fault('after_response')
    try {
      await active.usage({ projectId, runId, stepId, provider: result.provider, model: result.model, usage: result.usage })
      usageRecorded = true
    } catch { /* 用量旁路失败 → billing=unknown，绝不宣称已结算。 */ }

    validateTextOutput(result.content, output.format)

    // 发布：输出资产 + 版本 + completed UseDoc + completed 指针同一 documentTransaction。
    const journal = new Set<string>()
    try {
      const outputRef = await documentTransaction(async ex => {
        const [current] = await ex.select().from(records).where(and(eq(records.id, row.id),
          eq(records.projectId, projectId), eq(records.rowType, 'consumption'))).limit(1)
        if (!current || current.status !== 'dispatching') throw new ContinuityError('continuity_conflict', 409, row.id)
        // 最终复核只报告不重发：源已在途变化 → completed 文档标记 sourceChangedAfterDispatch。
        let drift = false
        try { await revalidatePack(projectId, doc, ex) } catch (e) {
          if (e instanceof ContinuityError) drift = true
          else throw e
        }
        // drizzle 的 insert/select 都是读取 this.session 的原型方法：必须以 ex.insert(...) 方法调用形式包装，
        // 不得裸传方法引用（否则 this 丢失 → "Cannot read properties of undefined (reading 'session')"）。
        const insert = ((table: Parameters<typeof ex.insert>[0]) => {
          const builder = ex.insert(table)
          return new Proxy(builder, { get(t, prop, receiver) {
            if (prop !== 'values') return Reflect.get(t, prop, receiver)
            return (value: typeof assets.$inferInsert | typeof contentVersions.$inferInsert) => {
              const relPath = (value as { relPath?: string | null }).relPath
              if (typeof relPath === 'string') journal.add(relPath)
              return builder.values(value as never)
            }
          } })
        }) as typeof ex.insert
        const select = ((...args: Parameters<typeof ex.select>) => ex.select(...args)) as typeof ex.select
        const asset = await writeTextAsset(projectId, { name: output.name, content: result!.content, purpose: output.purpose,
          format: isJsonTextFormat(output.format) ? output.format : undefined, runId, stepId }, { insert })
        const version = await recordAssetTextVersion({ asset, content: result!.content, source: 'generate',
          executor: { select, insert } })
        const outputRef: DocRef = { assetId: asset.id, versionId: version.id, hash: version.sha256! }
        const completed: UseDoc = { ...preparedDoc, state: 'completed', submitted: true,
          billing: usageRecorded ? 'recorded' : 'unknown', startedAt, completedAt: active.now(), output: outputRef,
          usage: normalizeUsage(result!.usage), errorCode: null, sourceChangedAfterDispatch: drift }
        const docRef = await writeDocument(ex, doc.target.unit, 'consumption', completed, current.documentAssetId!)
        active.fault('before_publish')
        const updated = await ex.update(records).set({ status: 'completed', errorCode: null,
          documentAssetId: docRef.assetId, documentVersionId: docRef.versionId, documentHash: docRef.hash,
          updatedAt: active.now() })
          .where(and(eq(records.id, current.id), eq(records.status, 'dispatching'),
            eq(records.documentVersionId, current.documentVersionId!))).returning()
        if (updated.length !== 1) throw new ContinuityError('continuity_conflict', 409, current.id)
        return outputRef
      })
      // 执行快照旁路：冻结真实消费的 context 版本指针，失败绝不影响结果。
      await safeRecordExecSnapshot({ projectId, execKind: 'pipeline_step', runId, stepId, templateKey: ctx.def.key,
        model: result!.model, inputs: [{ role: 'continuity_context', srcKind: 'asset', srcId: contextRow.documentAssetId!,
          versionId: contextRow.documentVersionId!, used: true }] })
      return { assetIds: [outputRef.assetId] }
    } catch (e) {
      for (const file of journal) { try { unlinkSync(absPathOf(file)) } catch { /* 未发布文件不覆盖旧文件 */ } }
      throw e
    }
  } catch (e) {
    const status = dispatched ? 'unknown' : 'failed'
    const code = status === 'unknown' ? 'continuity_outcome_unknown' : (e instanceof ContinuityError ? e.code : 'continuity_conflict')
    // 终态簿记尽力而为：从当前可见状态 CAS，绝不写假 completed。
    try {
      await documentTransaction(async ex => {
        const [current] = await ex.select().from(records).where(and(eq(records.id, row.id),
          eq(records.projectId, projectId), eq(records.rowType, 'consumption'))).limit(1)
        if (!current || current.status === 'completed' || current.status === 'failed' || current.status === 'unknown') return
        if (status === 'failed') {
          await ex.update(records).set({ status: 'failed', errorCode: code, updatedAt: active.now() })
            .where(and(eq(records.id, current.id), eq(records.status, 'prepared')))
          return
        }
        const prior = await useDocument(current, ex)
        const base: Extract<UseDoc, { state: 'dispatching' }> = prior?.state === 'dispatching' ? prior
          : { ...preparedDoc, state: 'dispatching', submitted: null, billing: 'unknown', startedAt, completedAt: null,
            output: null, usage: null, errorCode: null, sourceChangedAfterDispatch: false as const }
        const unknownDoc: UseDoc = { ...base, state: 'unknown', submitted: true, billing: usageRecorded ? 'recorded' : 'unknown',
          completedAt: null, output: null, usage: normalizeUsage(result?.usage ?? null), errorCode: 'continuity_outcome_unknown' }
        const docRef = current.documentAssetId === null ? null
          : await writeDocument(ex, doc.target.unit, 'consumption', unknownDoc, current.documentAssetId)
        // 行指针必须同步指向新版本，否则重入/读取仍解析到 dispatching 版本文档。
        await ex.update(records).set({ status: 'unknown', errorCode: 'continuity_outcome_unknown',
          ...(docRef ? { documentAssetId: docRef.assetId, documentVersionId: docRef.versionId, documentHash: docRef.hash } : {}),
          updatedAt: active.now() })
          .where(and(eq(records.id, current.id), eq(records.status, 'dispatching')))
      })
    } catch { /* 簿记失败保持 dispatching，交由启动恢复标记 unknown。 */ }
    throw new ContinuityError(code, status === 'unknown' ? 409 : (e instanceof ContinuityError ? e.status : 409), row.id)
  }
}

async function readContextDoc(projectId: number, contextRow: ConsumptionRow): Promise<ContextDoc> {
  const { readContext } = await import('./context')
  return readContext(projectId, { contextId: contextRow.id, document: documentRef(contextRow), approvalHash: contextRow.approvalHash! }, db)
}
