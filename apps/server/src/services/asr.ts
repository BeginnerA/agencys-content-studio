/**
 * ASR 音轨转写通道（spec §2.9，用户拍板「全链含音频转写」）。
 * 复用 api_configs serviceType='audio' 实例（不新增 service_type 枚举）：
 * baseUrl 显式配置且形如 OpenAI 兼容根（/v1 结尾）的实例才参与——
 * SiliconFlow（https://api.siliconflow.cn/v1）实测形态；volcengine/aliyun TTS 端点
 * baseUrl 为空/非兼容根 → 自动跳过（宽容降级链的一部分）。
 * 端点：POST {baseUrl}/audio/transcriptions（multipart：file + model）。
 * 宽容降级（对齐 LLM 复审纪律）：任何失败→ null，调用方跳过音轨不阻断主链。
 */
import { readFileSync } from 'node:fs'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db'
import { apiConfigs, vendorCredentials } from '../db/schema'
import { createLogger } from '../logger'
import { resolveApiKey } from './secrets'

const log = createLogger('asr')

export const DEFAULT_ASR_MODEL = 'FunAudioLLM/SenseVoiceSmall'
export const ASR_TIMEOUT_MS = 120_000

export interface AsrEndpoint {
  baseUrl: string
  apiKey: string
  model: string
  providerKey: string
}

export interface AsrSegment {
  t0: number
  t1: number
  text: string
}

export interface AsrResult {
  text: string
  segments: AsrSegment[] | null
}

/** OpenAI 兼容根判定（纯函数，探针直测）：非空且路径以 /v{n} 结尾 */
export function isOpenAiCompatBase(baseUrl: string | null | undefined): boolean {
  return !!baseUrl && /\/v\d+$/.test(baseUrl.trim().replace(/\/+$/, ''))
}

/**
 * 转写响应归一（纯函数，探针直测）：OpenAI whisper 形态 {text, verbose.segments?}；
 * text 缺失/空白 → null（视为失败降级）。segments 兼容 start/end 与 start_time/end_time 字段名，
 * 输出按 t0 升序；无 segments → null（有 text 仍算成功）。
 */
export function parseAsrResponse(json: unknown): AsrResult | null {
  if (!json || typeof json !== 'object') return null
  const obj = json as Record<string, unknown>
  const text = typeof obj.text === 'string' ? obj.text.trim() : ''
  if (!text) return null
  const rawSegs = Array.isArray(obj.segments) ? obj.segments : null
  if (!rawSegs) return { text, segments: null }
  const segments: AsrSegment[] = []
  for (const s of rawSegs as Array<Record<string, unknown>>) {
    const t0 = Number(s.start ?? s.start_time)
    const t1 = Number(s.end ?? s.end_time)
    const st = typeof s.text === 'string' ? s.text.trim() : ''
    if (!Number.isFinite(t0) || !st) continue
    segments.push({ t0: Math.round(t0 * 100) / 100, t1: Number.isFinite(t1) ? Math.round(t1 * 100) / 100 : t0, text: st })
  }
  segments.sort((a, b) => a.t0 - b.t0)
  return { text, segments: segments.length > 0 ? segments : null }
}

/**
 * 解析 ASR 端点：audio 实例（active，isDefault/priority 排序）中首个 OpenAI 兼容根；
 * 无候选 → null（video_analyze 走无音轨降级）。model = extra.asr_model 覆盖缺省 SenseVoice。
 */
export async function resolveAsrEndpoint(): Promise<AsrEndpoint | null> {
  const rows = await db
    .select()
    .from(apiConfigs)
    .where(and(eq(apiConfigs.serviceType, 'audio'), eq(apiConfigs.isActive, 1)))
    .orderBy(desc(apiConfigs.isDefault), apiConfigs.priority)
  for (const cfg of rows) {
    if (!isOpenAiCompatBase(cfg.baseUrl)) continue
    let apiKey = ''
    if (cfg.credentialId != null) {
      const cred = await db
        .select()
        .from(vendorCredentials)
        .where(eq(vendorCredentials.id, cfg.credentialId))
        .limit(1)
      apiKey = cred[0] ? resolveApiKey(cred[0].apiKeyRef) : ''
    }
    if (!apiKey) apiKey = resolveApiKey(cfg.apiKeyRef)
    if (!apiKey) continue
    let model = DEFAULT_ASR_MODEL
    try {
      const extra = JSON.parse(cfg.extra ?? '{}') as Record<string, unknown>
      if (typeof extra.asr_model === 'string' && extra.asr_model.trim()) model = extra.asr_model.trim()
    } catch {
      /* extra 非 JSON → 用缺省模型 */
    }
    return { baseUrl: cfg.baseUrl!.trim().replace(/\/+$/, ''), apiKey, model, providerKey: cfg.providerKey }
  }
  return null
}

/**
 * 转写音频文件（网络；探针不触达）。任何失败 → null + 日志留痕（宽容降级契约）。
 */
export async function transcribeAudio(absFilePath: string, ep?: AsrEndpoint | null): Promise<AsrResult | null> {
  const endpoint = ep ?? (await resolveAsrEndpoint())
  if (!endpoint) {
    log.info('ASR 端点不可解析（无 OpenAI 兼容 audio 实例）→ 跳过音轨转写')
    return null
  }
  try {
    const buf = readFileSync(absFilePath)
    const form = new FormData()
    form.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'audio.mp3')
    form.append('model', endpoint.model)
    const res = await fetch(`${endpoint.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
    })
    if (!res.ok) {
      log.warn(`ASR 转写返回 ${res.status} → 降级跳过音轨`)
      return null
    }
    const parsed = parseAsrResponse(await res.json().catch(() => null))
    if (!parsed) log.warn('ASR 响应不可解析（缺 text）→ 降级跳过音轨')
    return parsed
  } catch (err) {
    log.warn(`ASR 转写异常 → 降级跳过音轨：${(err as Error).message}`)
    return null
  }
}
