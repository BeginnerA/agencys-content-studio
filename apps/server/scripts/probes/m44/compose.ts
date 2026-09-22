import { readFileSync, writeFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import type { Checker } from '../../probe-lib'
import type { StepContext } from '../../../src/pipeline/context'

export async function probeDialogueCompose({ check }: Checker, ctx: StepContext, subtitleId: number): Promise<void> {
  const { db } = await import('../../../src/db')
  const { assets, usageRecords } = await import('../../../src/db/schema')
  const { ffmpegMerge } = await import('../../../src/pipeline/actions/ffmpeg-merge')
  const { absPathOf } = await import('../../../src/services/storage')
  const { inspectDialogueMedia } = await import('../../../src/services/creation-chat/dialogue-media')
  const countsBefore = await db.select().from(usageRecords).where(eq(usageRecords.runId, ctx.run.id))
  const input: StepContext = { ...ctx, def: { key: 'compose', action: 'ffmpeg_merge', title: '对白合成', inputs: {}, params: { strict_delivery: true, fps: 25 } },
    assetIdsOf: (key) => key === 'subtitle' ? [subtitleId] : ctx.assetIdsOf(key) }
  const originalFetch = globalThis.fetch
  let networkCalls = 0
  globalThis.fetch = async () => { networkCalls++; throw new Error('本地合成禁止网络调用') }
  try {
    const result = await ffmpegMerge(input)
    const [out] = await db.select().from(assets).where(eq(assets.id, result.assetIds[0]!))
    const timing = inspectDialogueMedia(absPathOf(out!.relPath!))
    const params = JSON.parse(out!.params!)
    check(Math.abs(timing.videoDuration - 32) < 0.1 && Math.abs(timing.audioDuration - 32) < 0.1, '真实主合成 action 保留四镜原声并输出 32 秒双流')
    check(params.performance === 'dialogue' && params.delivery_checked === true && params.dialogue_review_required === true && params.voices === 0, '技术检查不冒充口型验收，原声成片仍需人工审阅')
    const countsAfter = await db.select().from(usageRecords).where(eq(usageRecords.runId, ctx.run.id))
    check(networkCalls === 0 && countsAfter.length === countsBefore.length, '本地原声合成零模型调用、零新增模型费用')
    const [subtitle] = await db.select().from(assets).where(eq(assets.id, subtitleId))
    const bytes = readFileSync(absPathOf(subtitle!.relPath!))
    writeFileSync(absPathOf(subtitle!.relPath!), bytes.toString('utf8').replace('00:00:00,500', '00:00:00,100'))
    let rejected = false
    try { await ffmpegMerge(input) } catch { rejected = true }
    writeFileSync(absPathOf(subtitle!.relPath!), bytes)
    check(rejected && networkCalls === 0, '篡改实测字幕时停止合成，不付费重建字幕')
  } finally { globalThis.fetch = originalFetch }
}
