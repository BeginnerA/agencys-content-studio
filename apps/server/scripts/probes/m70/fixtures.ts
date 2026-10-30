import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfirmRequest, ContinuityIO, EntryDoc, EntryRef, EntryView, Item, SourcePick, TargetRequest } from '../../../src/services/continuity/contract'
import type { ChatMessage, LlmResult } from '../../../src/services/llm'
import type { StepContext } from '../../../src/pipeline/context'
import { REPO_ROOT } from '../../probe-lib'
import { temporaryRoot } from './bootstrap'

/** Only the network/config boundary is fake; usage writes the isolated real SQLite DB. */
export function fakeIO(result: LlmResult): { io: ContinuityIO; calls: () => number; messages: ChatMessage[][] } {
  // bootstrap copies tracked prompts only; Task3's explicitly authorized prompt is uncommitted.
  const prompt = join(REPO_ROOT, 'workspace/prompts/continuity-extract.md')
  if (existsSync(prompt)) copyFileSync(prompt, join(temporaryRoot, 'workspace/prompts/continuity-extract.md'))
  let count = 0
  const messages: ChatMessage[][] = []
  return { calls: () => count, messages, io: {
    endpoint: async () => ({ baseUrl: 'https://m70.invalid/v1', apiKey: 'fixture-only', providerKey: 'fixture', model: 'fixture' }),
    chat: async (input, endpoint) => {
      count++
      assert.equal(endpoint?.baseUrl, 'https://m70.invalid/v1')
      assert.equal(endpoint.apiKey, 'fixture-only')
      messages.push(structuredClone(input))
      return structuredClone(result)
    },
    budget: async () => null,
    usage: async p => (await import('../../../src/services/usage')).recordLlmUsage(p),
    now: () => Date.now(), fault: () => {},
  } }
}

export function confirmation(v: EntryView, key: string): ConfirmRequest {
  assert.ok(v.document && v.doc)
  return { expectedRevision: v.revision, document: v.document, sourceFingerprint: v.doc.source.fingerprint,
    warningsHash: v.warningsHash, expectedCurrentConfirmedId: v.currentConfirmedId,
    acceptedWarnings: [...new Set([...v.doc.warnings, ...(v.history === 'history_unavailable' ? ['history_unavailable'] : [])])].sort(),
    approvalKey: key }
}

/** Task4/5 target templates: written ONLY into the temporary WORKSPACE, never the real one.
 * The step carries inputs:{} because the loader requires the field; prompt_inline avoids prompt files. */
const FIXTURE_TEMPLATES: Record<string, string> = {
  'm70-fixture-episode': `key: m70-fixture-episode
name: M70离线目标
version: 1
genre: drama_short
inputs:
  - { key: brief, label: 简报, kind: text, required: true }
  - { key: episode_number, label: 集号, kind: int, required: true }
  - { key: with_continuity, label: 连续性, kind: bool, default: false }
  - { key: continuity_context, label: 承接包, kind: files, required: false }
steps:
  - key: write_script
    action: ai_text
    title: 生成本集剧本
    inputs: {}
    params:
      continuity_role: episode_script
      prompt_inline: 仅使用隔离测试输入生成本集剧本。
      output_purpose: script
`,
  'm70-fixture-small': `key: m70-fixture-small
name: M70离线目标·低上限
version: 1
genre: drama_short
defaults:
  continuity:
    max_render_chars: 2000
inputs:
  - { key: brief, label: 简报, kind: text, required: true }
  - { key: episode_number, label: 集号, kind: int, required: true }
  - { key: with_continuity, label: 连续性, kind: bool, default: false }
  - { key: continuity_context, label: 承接包, kind: files, required: false }
steps:
  - key: write_script
    action: ai_text
    title: 生成本集剧本
    inputs: {}
    params:
      continuity_role: episode_script
      prompt_inline: 仅使用隔离测试输入生成本集剧本。
      output_purpose: script
`,
  'm70-fixture-noin': `key: m70-fixture-noin
name: M70离线目标·缺集号声明
version: 1
genre: drama_short
inputs:
  - { key: brief, label: 简报, kind: text, required: true }
  - { key: with_continuity, label: 连续性, kind: bool, default: false }
steps:
  - key: write_script
    action: ai_text
    title: 生成本集剧本
    inputs: {}
    params:
      continuity_role: episode_script
      prompt_inline: 仅使用隔离测试输入生成本集剧本。
      output_purpose: script
`,
  'm70-fixture-dup': `key: m70-fixture-dup
name: M70离线目标·双目标步
version: 1
genre: drama_short
inputs:
  - { key: brief, label: 简报, kind: text, required: true }
  - { key: episode_number, label: 集号, kind: int, required: true }
  - { key: with_continuity, label: 连续性, kind: bool, default: false }
  - { key: continuity_context, label: 承接包, kind: files, required: false }
steps:
  - key: write_script
    action: ai_text
    title: 生成本集剧本
    inputs: {}
    params: { continuity_role: episode_script, prompt_inline: 仅使用隔离测试输入生成本集剧本。, output_purpose: script }
  - key: write_script_alt
    action: ai_text
    title: 备选剧本步
    inputs: {}
    params: { continuity_role: episode_script, prompt_inline: 备选目标步，必须被判为不支持。, output_purpose: script }
`,
}

export function installTargetFixture(): void {
  for (const [key, yaml] of Object.entries(FIXTURE_TEMPLATES)) {
    writeFileSync(join(temporaryRoot, 'workspace/templates', `${key}.yaml`), yaml, 'utf8')
  }
}

/** Composes Task3 public services only: extract → human review → confirm. */
export async function confirmEpisode(f: Awaited<ReturnType<typeof seedStory>>, index: number, io: ContinuityIO): Promise<EntryView> {
  const { confirmEntry } = await import('../../../src/services/continuity/entries')
  const { withContinuityIO } = await import('../../../src/services/continuity/runtime')
  return withContinuityIO(io, async () => {
    const draft = await extractAndReview(f, index, io)
    return confirmEntry(f.projectId, draft.id, confirmation(draft, randomUUID()))
  })
}

/** Main-flow fixture: extraction, human corrections, then caller explicitly confirms. */
export async function extractAndReview(f: Awaited<ReturnType<typeof seedStory>>, index: number, io: ContinuityIO): Promise<EntryView> {
  const { previewExtraction, extractEntry } = await import('../../../src/services/continuity/extract')
  const { patchEntry, getEntry } = await import('../../../src/services/continuity/entries')
  const { withContinuityIO } = await import('../../../src/services/continuity/runtime')
  return withContinuityIO(io, async () => {
    const source = f.sources[index]!, episode = f.episodes[index]!
    const preview = await previewExtraction(f.projectId, episode, source)
    const v = await extractEntry(f.projectId, episode, { source, previewHash: preview.previewHash,
      operationKey: randomUUID(), allowModelCall: true, acceptUnpriced: true })
    assert.ok(v.doc)
    const reviewed = await storyDocument(f, index, v.doc.basis)
    reviewed.source = v.doc.source; reviewed.history = v.doc.history; reviewed.warnings = v.doc.warnings
    // Prior topic/channel/knower identity is resolved from actual approved versions, not guessed IDs.
    for (const item of reviewed.items) {
      item.origin = 'manual'; item.editNote = '人工逐句复核合成原文'
      for (const ref of reviewed.basis) {
        const previous = (await getEntry(f.projectId, ref.entryId)).doc!.items.find(p => p.included && p.topicKey === item.topicKey
          && p.channel === item.channel && (p.channel !== 'knowledge' || (item.channel === 'knowledge' && p.knower === item.knower)))
        if (previous) item.previous = { ...ref, itemId: previous.id }
      }
    }
    return patchEntry(f.projectId, v.id, { expectedRevision: v.revision, doc: reviewed })
  })
}

/** All runtime imports follow bootstrap; every invocation owns a fresh synthetic project. */
export async function seedStory(): Promise<{
  projectId: number; seriesId: number; episodes: [number, number, number]
  sources: [SourcePick, SourcePick, SourcePick]; texts: [string, string, string]
}> {
  const { db } = await import('../../../src/db')
  const { projects, series, episodes, pipelineRuns, pipelineSteps, execSnapshots } = await import('../../../src/db/schema')
  const { loadTemplate } = await import('../../../src/pipeline/loader')
  const { writeTextAsset } = await import('../../../src/services/storage')
  const { recordAssetTextVersion } = await import('../../../src/services/provenance')
  const [p] = await db.insert(projects).values({ name: 'M70隔离三集', createdAt: 1, updatedAt: 1 }).returning()
  const [s] = await db.insert(series).values({ projectId: p!.id, name: '离线剧', totalEpisodes: 3, createdAt: 1, updatedAt: 1 }).returning()
  const es = await db.insert(episodes).values([1, 2, 3].map(number => ({ projectId: p!.id, seriesId: s!.id, number, createdAt: 1, updatedAt: 1 }))).returning()
  assert.equal(es.length, 3)
  const texts: [string, string, string] = [
    '开场【𠮷】。甲受伤。钥匙归甲。观众知道甲是卧底。乙尚不知甲是卧底。红信封未开。',
    '钥匙交乙。乙怀疑甲是卧底。红信封未开。',
    '红信封揭晓：甲是卧底。未来计划：乙明天去车站。',
  ]
  const picks: SourcePick[] = []
  const template = loadTemplate('mengbao-episode')
  for (const [index, episode] of es.entries()) {
    const [run] = await db.insert(pipelineRuns).values({ projectId: p!.id, templateKey: template.key,
      templateSnapshot: JSON.stringify(template), input: JSON.stringify({ episode_number: episode.number }),
      status: 'completed', createdAt: 1, updatedAt: 1 }).returning()
    for (const key of ['write_script', 'script_review']) {
      const spec = template.steps.find(step => step.key === key)!
      const [step] = await db.insert(pipelineSteps).values({ runId: run!.id, seq: key === 'write_script' ? 1 : 2,
        stepKey: key, actionKey: spec.action, title: spec.title, status: 'succeeded', createdAt: 1, updatedAt: 1 }).returning()
      const asset = await writeTextAsset(p!.id, { name: `${randomUUID()}.md`, content: key === 'write_script' ? texts[index]! : '审查报告，不是本集剧本。',
        purpose: 'script', runId: run!.id, stepId: step!.id })
      const version = await recordAssetTextVersion({ asset, content: key === 'write_script' ? texts[index]! : '审查报告，不是本集剧本。', source: 'generate' })
      const { eq } = await import('drizzle-orm')
      await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [asset.id], gate: { decision: 'approve', at: 1 } }) }).where(eq(pipelineSteps.id, step!.id))
      await db.insert(execSnapshots).values({ projectId: p!.id, execKind: 'pipeline_step', runId: run!.id, stepId: step!.id,
        templateKey: template.key, inputHash: 'a'.repeat(64), frozenAt: 1, createdAt: 1 })
      if (key === 'write_script') picks.push({ runId: run!.id, stepId: step!.id, assetId: asset.id, versionId: version.id })
    }
  }
  return { projectId: p!.id, seriesId: s!.id, episodes: es.map(e => e.id) as [number, number, number],
    sources: picks as [SourcePick, SourcePick, SourcePick], texts }
}

/** Extra same-project episode source with exact text, for size-boundary probes (numbers must exceed seeded episodes).
 * opts.snapshot=false skips the exec snapshot so the derived source history becomes history_unavailable. */
export async function seedSource(story: Awaited<ReturnType<typeof seedStory>>, number: number, text: string,
  opts: { snapshot?: boolean } = {}): Promise<{ pick: SourcePick; episodeId: number }> {
  const { db } = await import('../../../src/db')
  const { episodes, pipelineRuns, pipelineSteps, execSnapshots } = await import('../../../src/db/schema')
  const { loadTemplate } = await import('../../../src/pipeline/loader')
  const { writeTextAsset } = await import('../../../src/services/storage')
  const { recordAssetTextVersion } = await import('../../../src/services/provenance')
  const template = loadTemplate('mengbao-episode')
  const [episode] = await db.insert(episodes).values({ projectId: story.projectId, seriesId: story.seriesId, number, createdAt: 1, updatedAt: 1 }).returning()
  const [run] = await db.insert(pipelineRuns).values({ projectId: story.projectId, templateKey: template.key,
    templateSnapshot: JSON.stringify(template), input: JSON.stringify({ episode_number: number }),
    status: 'completed', createdAt: 1, updatedAt: 1 }).returning()
  const spec = template.steps.find(step => step.key === 'write_script')!
  const [step] = await db.insert(pipelineSteps).values({ runId: run!.id, seq: 1, stepKey: 'write_script',
    actionKey: spec.action, title: spec.title, status: 'succeeded', createdAt: 1, updatedAt: 1 }).returning()
  const asset = await writeTextAsset(story.projectId, { name: `${randomUUID()}.md`, content: text, purpose: 'script', runId: run!.id, stepId: step!.id })
  const version = await recordAssetTextVersion({ asset, content: text, source: 'generate' })
  const { eq } = await import('drizzle-orm')
  await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [asset.id], gate: { decision: 'approve', at: 1 } }) }).where(eq(pipelineSteps.id, step!.id))
  if (opts.snapshot !== false) {
    await db.insert(execSnapshots).values({ projectId: story.projectId, execKind: 'pipeline_step', runId: run!.id, stepId: step!.id,
      templateKey: template.key, inputHash: 'a'.repeat(64), frozenAt: 1, createdAt: 1 })
  }
  return { pick: { runId: run!.id, stepId: step!.id, assetId: asset.id, versionId: version.id }, episodeId: episode!.id }
}

/** A prior run whose template snapshot is the Task4 fixture template, for resume-target probes. */
export async function seedResumeRun(story: Awaited<ReturnType<typeof seedStory>>, number: number, input: Record<string, unknown>,
  opts: { snapshot?: boolean } = {}): Promise<number> {
  const { db } = await import('../../../src/db')
  const { pipelineRuns } = await import('../../../src/db/schema')
  const { loadTemplate } = await import('../../../src/pipeline/loader')
  const [run] = await db.insert(pipelineRuns).values({ projectId: story.projectId, templateKey: 'm70-fixture-episode',
    templateSnapshot: opts.snapshot === false ? null : JSON.stringify(loadTemplate('m70-fixture-episode')),
    input: JSON.stringify(input), status: 'failed', createdAt: 1, updatedAt: 1 }).returning()
  return run!.id
}

/** Test-only undecided consumption call (Task5 owns the real service): exact unknown row a resume must consent to. */
export async function seedUnknownUse(story: Awaited<ReturnType<typeof seedStory>>, runId: number, episodeId: number): Promise<number> {
  const { db } = await import('../../../src/db')
  const { contentContinuityRecords } = await import('../../../src/db/schema')
  const { writeTextAsset } = await import('../../../src/services/storage')
  const { recordAssetTextVersion } = await import('../../../src/services/provenance')
  const { resolveUnit } = await import('../../../src/services/continuity/scope')
  const unit = await resolveUnit(story.projectId, episodeId, db)
  const asset = await writeTextAsset(story.projectId, { name: `${randomUUID()}.json`, purpose: 'continuity_use', format: 'continuity-json', content: '{}' })
  const version = await recordAssetTextVersion({ asset, content: '{}', source: 'generate' })
  const [row] = await db.insert(contentContinuityRecords).values({ ...unit, rowType: 'consumption', status: 'unknown', runId,
    operationKey: randomUUID(), requestHash: 'a'.repeat(64), documentAssetId: asset.id, documentVersionId: version.id,
    documentHash: version.sha256!, createdAt: 1, updatedAt: 1 }).returning()
  return row!.id
}

/** Binds a frozen approval to a fresh pipeline run/step (server-owned ledger binding) and builds the StepContext.
 * Idempotent: a context already bound to a run reuses that run verbatim. */
export async function makeStepContext(story: Awaited<ReturnType<typeof seedStory>>,
  approval: import('../../../src/services/continuity/contract').Approval): Promise<StepContext> {
  const { db } = await import('../../../src/db')
  const { contentContinuityRecords, pipelineRuns, pipelineSteps } = await import('../../../src/db/schema')
  const { and, eq } = await import('drizzle-orm')
  const { loadTemplate } = await import('../../../src/pipeline/loader')
  const { readContext } = await import('../../../src/services/continuity/context')
  const { createStepContext } = await import('../../../src/pipeline/context')
  const template = loadTemplate('m70-fixture-episode')
  const doc = await readContext(story.projectId, approval, db)
  assert.equal(doc.target.request.kind, 'manual')
  const requestInput = doc.target.request.kind === 'manual' ? doc.target.request.input : {}
  const input = { ...requestInput, continuity_context: [approval.document.assetId] }
  const [contextRow] = await db.select().from(contentContinuityRecords).where(eq(contentContinuityRecords.id, approval.contextId))
  assert.ok(contextRow && contextRow.status === 'frozen')
  let runId = contextRow.runId, stepId = contextRow.stepId
  if (runId === null || stepId === null) {
    const [run] = await db.insert(pipelineRuns).values({ projectId: story.projectId, templateKey: 'm70-fixture-episode',
      templateSnapshot: JSON.stringify(template), input: JSON.stringify(input), status: 'running', createdAt: 1, updatedAt: 1 }).returning()
    const def = template.steps[0]!
    const [step] = await db.insert(pipelineSteps).values({ runId: run!.id, seq: 1, stepKey: def.key, actionKey: def.action,
      title: def.title, status: 'running', createdAt: 1, updatedAt: 1 }).returning()
    runId = run!.id; stepId = step!.id
    const bound = await db.update(contentContinuityRecords).set({ status: 'bound', runId, stepId, updatedAt: 1 })
      .where(and(eq(contentContinuityRecords.id, approval.contextId), eq(contentContinuityRecords.status, 'frozen'))).returning()
    assert.equal(bound.length, 1)
  }
  const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId))
  const [step] = await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, stepId))
  assert.ok(run && step)
  return createStepContext({ run, step, template, def: template.steps[0]!, input: JSON.parse(run.input) as Record<string, unknown> })
}

export async function storyDocument(story: Awaited<ReturnType<typeof seedStory>>, index = 0, basis: EntryRef[] = []): Promise<EntryDoc> {
  const { db } = await import('../../../src/db')
  const { readSource } = await import('../../../src/services/continuity/sources')
  const { source, text } = await readSource(story.projectId, story.episodes[index]!, story.sources[index]!, db)
  const subjects = [ ['a', '甲'], ['b', '乙'], ['audience', '观众'] ].map(([key, label]) => ({ key: key!, label: label!, entityId: null, aliases: [] }))
  const facts: [string, string, Item['channel'], Item['type'], string[]][] = index === 0 ? [
    ['injury', '甲受伤', 'fact', 'state', ['a']], ['key', '钥匙归甲', 'fact', 'possession', ['a']],
    ['secret', '观众知道甲是卧底', 'knowledge', 'state', ['a']], ['secret', '乙尚不知甲是卧底', 'knowledge', 'state', ['a']],
    ['envelope', '红信封未开', 'fact', 'thread', []],
  ] : index === 1 ? [ ['key', '钥匙交乙', 'fact', 'possession', ['a', 'b']],
    ['secret', '乙怀疑甲是卧底', 'knowledge', 'state', ['a']], ['envelope', '红信封未开', 'fact', 'thread', []],
  ] : [ ['envelope', '红信封揭晓：甲是卧底', 'fact', 'thread', ['a']], ['station', '未来计划：乙明天去车站', 'plan', 'event', ['b']] ]
  const items: Item[] = facts.map(([topicKey, quote, channel, type, keys], i) => {
    const start = text.indexOf(quote)
    assert.ok(start >= 0)
    const common = { id: `e${index + 1}_${i}`, topicKey, type, operation: 'set' as const, subjects: keys, value: quote,
      previous: null, evidence: [{ start, end: start + quote.length, quote }], origin: 'extracted' as const, editNote: '', included: true }
    return channel === 'knowledge' ? { ...common, channel, knower: quote.startsWith('观众') ? 'audience' : 'b',
      epistemic: quote.startsWith('观众') ? 'knows' : index === 0 ? 'unaware' : 'believes' } : { ...common, channel }
  })
  const { projectId, scopeKind, scopeId, unitKind, unitId, unitOrdinal } = source
  return { schemaVersion: 1, unit: { projectId, scopeKind, scopeId, unitKind, unitId, unitOrdinal }, source, basis,
    history: source.history, subjects, topics: [...new Set(items.map(i => i.topicKey))].map(key => ({ key, label: key })),
    items, warnings: [], noChanges: false, releasedBasis: [] }
}

/** Test-only persistence, not a substitute for the Task3 confirmation service. */
export async function persistEntry(doc: EntryDoc, status: 'draft' | 'confirmed' = 'confirmed'): Promise<EntryRef> {
  const { db } = await import('../../../src/db')
  const { contentContinuityRecords } = await import('../../../src/db/schema')
  const { writeTextAsset } = await import('../../../src/services/storage')
  const { recordAssetTextVersion } = await import('../../../src/services/provenance')
  const content = JSON.stringify(doc)
  const asset = await writeTextAsset(doc.unit.projectId, { name: `${randomUUID()}.json`, purpose: 'continuity_entry', content })
  const version = await recordAssetTextVersion({ asset, content, source: 'generate' })
  const [row] = await db.insert(contentContinuityRecords).values({ ...doc.unit, rowType: 'entry', status, operationKey: randomUUID(),
    requestHash: version.sha256!, documentAssetId: asset.id, documentVersionId: version.id, documentHash: version.sha256!,
    sourceRunId: doc.source.runId, sourceStepId: doc.source.stepId, sourceAssetId: doc.source.assetId,
    sourceVersionId: doc.source.versionId, sourceHash: doc.source.hash, createdAt: 1, updatedAt: 1 }).returning()
  return { entryId: row!.id, assetId: asset.id, versionId: version.id, hash: version.sha256!, unitOrdinal: doc.unit.unitOrdinal }
}
