import type { Checker } from '../../probe-lib'

export async function probeAsrConfig({ check }: Checker): Promise<void> {
  const { db, initDb } = await import('../../../src/db')
  const { apiConfigs, projects, usageRecords } = await import('../../../src/db/schema')
  const { eq } = await import('drizzle-orm')
  const service = await import('../../../src/services/strict-asr')
  const { resolveUnitPrice, recordUsage } = await import('../../../src/services/usage')
  await initDb()
  await db.delete(apiConfigs)
  process.env.PROBE_M44_KEY = 'offline-m44'
  const now = Date.now()
  const [cfg] = await db.insert(apiConfigs).values({ name: '离线语音配置', providerKey: 'openai_audio', serviceType: 'audio',
    model: 'tts-1', baseUrl: 'http://localhost:0/v1', apiKeyRef: 'env:PROBE_M44_KEY', extra: '{}', pricing: '{"char":1,"second":99}',
    isDefault: 1, isActive: 1, priority: 0, createdAt: now, updatedAt: now }).returning()
  const rejected = async (fn: () => Promise<unknown>): Promise<boolean> => { try { await fn(); return false } catch { return true } }
  check(await rejected(() => service.resolveStrictAsrEndpoint()), '不能通过 /v1 或 TTS 模型推断严格 ASR')
  await db.update(apiConfigs).set({ extra: JSON.stringify({ asr_model: 'whisper-1', asr_protocol: 'openai_verbose_json' }) }).where(eq(apiConfigs.id, cfg!.id))
  const endpoint = await service.resolveStrictAsrEndpoint()
  check(endpoint.model === 'whisper-1' && endpoint.configId === cfg!.id, '显式 ASR 配置复用端点和凭证，不使用 TTS 模型')
  check(await resolveUnitPrice({ configId: cfg!.id, provider: 'openai_audio', model: 'whisper-1', kind: 'asr', unit: 'second' }) === null, '未填 ASR 单价为 unknown，不串用 TTS 价格')
  await db.update(apiConfigs).set({ pricing: JSON.stringify({ char: 1, second: 99, asr: { model: 'whisper-1', second: 0.02 } }) }).where(eq(apiConfigs.id, cfg!.id))
  const snap = await service.snapshotStrictAsr()
  check(snap.unitPrice === 0.02 && snap.model === 'whisper-1', 'ASR 单独冻结每秒单价和实际模型')
  check(await rejected(() => service.resolveStrictAsrEndpoint({ ...snap, configHash: endpoint.configHash })), 'ASR 定价变更触发批准配置漂移')
  check((await service.resolveStrictAsrEndpoint(snap)).configHash === snap.configHash, '合法 ASR pin 可恢复原实例')
  await db.update(apiConfigs).set({ extra: JSON.stringify({ asr_model: 'SenseVoice', asr_protocol: 'openai_verbose_json' }) }).where(eq(apiConfigs.id, cfg!.id))
  check(await rejected(() => service.resolveStrictAsrEndpoint(snap)), 'ASR 模型漂移阻断，不切换实例')
  check(await rejected(() => service.resolveStrictAsrEndpoint()), '未核实时间戳协议的模型被拒绝')
  const [project] = await db.insert(projects).values({ name: 'M44 计费探针', genre: 'story', templateKey: 'easy-video', createdAt: now, updatedAt: now }).returning()
  await recordUsage({ projectId: project!.id, kind: 'asr', provider: snap.provider, model: snap.model, quantity: 8.2, unit: 'second', unitPrice: snap.unitPrice })
  await recordUsage({ projectId: project!.id, kind: 'asr', provider: snap.provider, model: snap.model, quantity: 8, unit: 'second', unitPrice: null })
  const rows = await db.select().from(usageRecords).where(eq(usageRecords.projectId, project!.id))
  check(rows[0]?.cost === 0.164 && rows[0]?.quantity === 8.2 && rows[1]?.cost === null, '实际提交秒数计费，未知价保持 null')
}
