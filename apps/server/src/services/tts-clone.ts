import { asc, eq } from 'drizzle-orm'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { db } from '../db'
import { apiProviders, voiceClones, type VoiceClone } from '../db/schema'
import { createLogger } from '../logger'
import { probeMediaDuration } from './ffmpeg'
import { WorkbenchError } from './shot'
import { resolveAudioEndpoint, synthSpeech, type AudioEndpoint } from './tts'

/**
 * [M19 P8] 声音克隆（spec §2.2 ⑧）：能力位唯一事实源 + DashScope 复刻协议 + 平台音色库 + 声线链引用。
 *
 * 供应商协议（阿里云百炼「声音复刻」HTTP API，同一 customization 端点下两套 enrollment 模型）：
 * - dashscope-enrollment（Qwen-Audio-TTS / CosyVoice）：input.url 只接受**公网可访问**音频地址；
 * - dashscope-qwen-enrollment（Qwen-TTS）：input.audio.data 支持 Data URL（Base64 内联），本地样本即传即用。
 * 两套协议返回的音色标识字段不同（output.voice_id / output.voice），且「克隆模型必须与合成模型一致」——
 * 故 voice_clones 同时持久化 provider_key 与 model，合成时经 cloneEndpoint() 换端点 + 覆盖 model。
 *
 * 凭证不落本表：端点与 Key 一律经 resolveAudioEndpoint(providerKey)（Settings → 语音合成实例）。
 */

const log = createLogger('tts-clone')

/** 音色引用语法前缀（角色库 voice / params.voice / voice_hint 任一级写此值即命中克隆音色） */
export const CLONE_REF_PREFIX = 'clone:'
/** 样本硬校验：≤10MB（供应商上限）；格式白名单 WAV / MP3 */
export const CLONE_SAMPLE_MAX_BYTES = 10 * 1024 * 1024
/** 供应商建议时长区间（超出仅告警，不拒绝） */
export const CLONE_SAMPLE_MIN_SEC = 10
export const CLONE_SAMPLE_MAX_SEC = 60
/** 试听文本上限（spec §2.2 ⑧） */
export const CLONE_TEST_MAX_CHARS = 200
const DEFAULT_TIMEOUT_MS = 120_000

export type VoiceCloneProtocol = 'dashscope-enrollment' | 'dashscope-qwen-enrollment'

interface ProtocolSpec {
  /** 请求体 model（enrollment 模型名） */
  enrollModel: string
  /** 请求体 input.action */
  action: string
  /** 前缀字段名（供应商侧音色名前缀约束各异） */
  prefixField: 'prefix' | 'preferred_name'
  /** 前缀允许字符 */
  prefixChars: RegExp
  /** 前缀最大长度 */
  prefixMax: number
  /** 样本提交字段：url（公网地址） / audio.data（Data URL 内联） */
  sampleField: 'url' | 'audio.data'
  /** 样本承载形态 */
  transport: 'public-url' | 'data-uri'
  /** 响应音色标识字段 */
  voiceField: 'voice_id' | 'voice'
}

export const VOICE_CLONE_PROTOCOLS: Record<VoiceCloneProtocol, ProtocolSpec> = {
  'dashscope-enrollment': {
    enrollModel: 'voice-enrollment',
    action: 'create_voice',
    prefixField: 'prefix',
    prefixChars: /[A-Za-z0-9]/g,
    prefixMax: 10,
    sampleField: 'url',
    transport: 'public-url',
    voiceField: 'voice_id',
  },
  'dashscope-qwen-enrollment': {
    enrollModel: 'qwen-voice-enrollment',
    action: 'create',
    prefixField: 'preferred_name',
    prefixChars: /[A-Za-z0-9_]/g,
    prefixMax: 16,
    sampleField: 'audio.data',
    transport: 'data-uri',
    voiceField: 'voice',
  },
}

/** 能力位唯一事实源：providerKey → 默认协议 + 默认目标模型（未登记的供应商 = 不支持克隆） */
export interface VoiceCloneProviderSpec {
  protocol: VoiceCloneProtocol
  defaultTargetModel: string
}

export const VOICE_CLONE_PROVIDERS: Record<string, VoiceCloneProviderSpec> = {
  // Qwen3-TTS-VC：声音复刻 + 非实时合成（与既有 aliyun_bailian_tts 合成端点同源，clone 全链可跑通）
  aliyun_bailian_tts: { protocol: 'dashscope-qwen-enrollment', defaultTargetModel: 'qwen3-tts-vc-2026-01-22' },
}

/** 供应商是否支持声音克隆（能力位；UI 下拉置灰依据） */
export function cloneCapabilityOf(providerKey: string): boolean {
  return providerKey in VOICE_CLONE_PROVIDERS
}

/** 能力位矩阵（audio 供应商目录全量 + available 标记） */
export async function listCloneProviders(): Promise<Array<{ key: string; name: string; available: boolean }>> {
  const rows = await db
    .select({ key: apiProviders.key, name: apiProviders.name })
    .from(apiProviders)
    .where(eq(apiProviders.serviceType, 'audio'))
    .orderBy(asc(apiProviders.key))
  return rows.map((r) => ({ key: r.key, name: r.name, available: cloneCapabilityOf(r.key) }))
}

// ---------- 纯函数（探针直测） ----------

/** 音色引用令牌解析：'clone:12' → 12；非该形态 / 非正整数 → null */
export function parseCloneRef(v?: string | null): number | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s.startsWith(CLONE_REF_PREFIX)) return null
  const n = Number(s.slice(CLONE_REF_PREFIX.length).trim())
  return Number.isInteger(n) && n > 0 ? n : null
}

/** 音色引用有效性：是 clone 令牌且索引命中（status=ready）→ 返回该行；否则 null（无效引用 → 调用方跳过该级降级） */
export function validCloneRef(v: string | undefined | null, index?: Map<number, VoiceClone>): VoiceClone | null {
  const id = parseCloneRef(v)
  if (id === null) return null
  return index?.get(id) ?? null
}

/** 前缀清洗：仅保留协议允许字符 → 截断至上限 → 空回退 'voice'（供应商侧音色名 = {model}-{prefix}-{uid}） */
export function sanitizeClonePrefix(name: string, protocol: VoiceCloneProtocol = 'dashscope-qwen-enrollment'): string {
  const spec = VOICE_CLONE_PROTOCOLS[protocol]
  const kept = (name ?? '').match(spec.prefixChars)?.join('') ?? ''
  const clipped = kept.slice(0, spec.prefixMax).replace(/[^A-Za-z0-9_]+$/g, '')
  return clipped || 'voice'
}

/** MIME 归一：收敛到 audio/wav | audio/mpeg；其它（含 x-wav / mp3 别名 / 缺失）→ null（硬校验拒绝） */
export function normalizeSampleMime(mime?: string | null): 'audio/wav' | 'audio/mpeg' | null {
  const s = (mime ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (s === 'audio/wav' || s === 'audio/x-wav' || s === 'audio/wave' || s === 'audio/mp3' || s === 'audio/mpeg') {
    return s === 'audio/mp3' || s === 'audio/mpeg' ? 'audio/mpeg' : 'audio/wav'
  }
  return null
}

export interface SampleIssue {
  code: string
  message: string
}

/**
 * 样本硬校验 + 时长软警告（纯函数，时长由调用方探测后传入）：
 * 空 / 超 10MB / 非 WAV·MP3 → issue；时长缺失或超出 10~60s → warnings（不拒绝）。
 */
export function validateCloneSample(p: {
  sizeBytes: number
  mime?: string | null
  durationSec?: number | null
}): { ok: boolean; issue: SampleIssue | null; mime: 'audio/wav' | 'audio/mpeg' | null; warnings: string[] } {
  const mime = normalizeSampleMime(p.mime)
  if (!(p.sizeBytes > 0)) return { ok: false, issue: { code: 'empty_sample', message: '样本文件为空' }, mime, warnings: [] }
  if (!mime) {
    return {
      ok: false,
      issue: { code: 'bad_sample_mime', message: `样本需为 WAV 或 MP3（当前：${(p.mime ?? '').trim() || '未知类型'}）` },
      mime,
      warnings: [],
    }
  }
  if (p.sizeBytes > CLONE_SAMPLE_MAX_BYTES) {
    return {
      ok: false,
      issue: {
        code: 'too_large',
        message: `样本超过 10MB 上限（${(p.sizeBytes / 1024 / 1024).toFixed(1)}MB）——请截取 10~20 秒人声片段`,
      },
      mime,
      warnings: [],
    }
  }
  const warnings: string[] = []
  if (p.durationSec === undefined || p.durationSec === null) {
    warnings.push('未能探测样本时长（ffprobe 不可用），请自行确认样本含 ≥5 秒连续清晰人声')
  } else if (p.durationSec < CLONE_SAMPLE_MIN_SEC) {
    warnings.push(`样本时长 ${p.durationSec.toFixed(1)}s 低于建议值（${CLONE_SAMPLE_MIN_SEC}~${CLONE_SAMPLE_MAX_SEC}s），复刻效果可能不稳定`)
  } else if (p.durationSec > CLONE_SAMPLE_MAX_SEC) {
    warnings.push(`样本时长 ${p.durationSec.toFixed(1)}s 超出建议上限 ${CLONE_SAMPLE_MAX_SEC}s，供应商仅取前段`)
  }
  return { ok: true, issue: null, mime, warnings }
}

/** 样本时长探测（临时文件中转；ffprobe 缺失/失败 → null，仅影响软警告） */
export function probeSampleDuration(sample: Uint8Array, mime: string): number | null {
  const ext = mime === 'audio/mpeg' ? 'mp3' : 'wav'
  const file = join(tmpdir(), `cstudio-clone-${randomUUID()}.${ext}`)
  try {
    writeFileSync(file, sample)
    return probeMediaDuration(file)
  } catch (err) {
    log.warn(`样本时长探测失败（${(err as Error).message}）`)
    return null
  } finally {
    try {
      unlinkSync(file)
    } catch {
      /* 临时文件清理失败无副作用 */
    }
  }
}

/** 复刻请求体（纯函数，供探针做 body 快照）：sampleRef = Data URL 或公网音频地址 */
export function buildEnrollBody(p: {
  protocol: VoiceCloneProtocol
  targetModel: string
  prefix: string
  sampleRef: string
}): { model: string; input: Record<string, unknown>; parameters: Record<string, unknown> } {
  const spec = VOICE_CLONE_PROTOCOLS[p.protocol]
  const input: Record<string, unknown> = { action: spec.action, target_model: p.targetModel }
  input[spec.prefixField] = p.prefix
  if (spec.sampleField === 'url') input.url = p.sampleRef
  else input.audio = { data: p.sampleRef }
  return { model: spec.enrollModel, input, parameters: {} }
}

/** 复刻响应 → 音色标识（协议字段差异归一；缺失 → null，附 fallback 留痕） */
export function parseEnrollResponse(
  result: unknown,
  protocol: VoiceCloneProtocol,
): { voiceId: string | null; fallbackMode: boolean; fallbackReason: string } {
  const out = (result as { output?: Record<string, unknown> })?.output ?? {}
  const field = VOICE_CLONE_PROTOCOLS[protocol].voiceField
  const raw = out[field]
  const voiceId = typeof raw === 'string' && raw.trim() ? raw.trim() : null
  const fallbackMode = out['fallback_mode'] === true
  const reason = typeof out['fallback_reason'] === 'string' ? out['fallback_reason'].trim() : ''
  return { voiceId, fallbackMode, fallbackReason: reason }
}

// ---------- 音色库 CRUD ----------

export interface CreateVoiceCloneInput {
  name: string
  /** 本地样本字节（data-uri 协议必填） */
  sample?: Uint8Array | null
  mime?: string | null
  /** 公网音频地址（public-url 协议必填） */
  sampleUrl?: string | null
  targetModel?: string | null
  protocol?: string | null
  timeoutMs?: number
}

/**
 * 创建克隆音色（同步协议：成功才落行；任何失败不落库）。
 * 校验族 → resolveAudioEndpoint 取凭证 → POST customization → output 音色标识 → insert voice_clones。
 */
export async function createVoiceClone(
  providerKey: string,
  input: CreateVoiceCloneInput,
): Promise<{ clone: VoiceClone; warnings: string[] }> {
  const provider = VOICE_CLONE_PROVIDERS[providerKey]
  if (!provider) {
    throw new WorkbenchError(
      'unsupported_provider',
      `供应商「${providerKey || '未指定'}」不支持声音克隆（v1 白名单：${Object.keys(VOICE_CLONE_PROVIDERS).join(' / ')}）`,
    )
  }
  const protocol: VoiceCloneProtocol =
    input.protocol && input.protocol in VOICE_CLONE_PROTOCOLS ? (input.protocol as VoiceCloneProtocol) : provider.protocol
  const pspec = VOICE_CLONE_PROTOCOLS[protocol]

  const name = (input.name ?? '').trim()
  if (!name) throw new WorkbenchError('bad_name', '音色名不能为空')
  if (name.length > 64) throw new WorkbenchError('bad_name', '音色名超 64 字符')
  const targetModel = (input.targetModel ?? '').trim() || provider.defaultTargetModel
  if (!/^[A-Za-z0-9._:/-]{1,64}$/.test(targetModel)) {
    throw new WorkbenchError('bad_target_model', `target_model 非法：${targetModel}（须为供应商模型标识）`)
  }

  const warnings: string[] = []
  let sampleRef = ''
  if (pspec.transport === 'data-uri') {
    const bytes = input.sample ?? null
    const checked = validateCloneSample({
      sizeBytes: bytes?.byteLength ?? 0,
      mime: input.mime,
      durationSec: bytes && normalizeSampleMime(input.mime) ? probeSampleDuration(bytes, normalizeSampleMime(input.mime)!) : null,
    })
    if (!checked.ok) throw new WorkbenchError(checked.issue!.code, checked.issue!.message)
    warnings.push(...checked.warnings)
    sampleRef = `data:${checked.mime};base64,${Buffer.from(bytes!).toString('base64')}`
  } else {
    const url = (input.sampleUrl ?? '').trim()
    const bytes = input.sample ?? null
    if (bytes && bytes.byteLength > 0) {
      throw new WorkbenchError('bad_sample_transport', `协议「${protocol}」不接受本地样本——请改用公网音频地址（sample_url）或 dashscope-qwen-enrollment 协议`)
    }
    if (!/^https?:\/\/\S+$/i.test(url)) {
      throw new WorkbenchError('bad_sample_url', `协议「${protocol}」需公网可访问的 http(s) 音频地址（sample_url）`)
    }
    sampleRef = url
  }

  const ep = await resolveAudioEndpoint(providerKey)
  const body = buildEnrollBody({ protocol, targetModel, prefix: sanitizeClonePrefix(name, protocol), sampleRef })
  const result = await postEnroll(ep.baseUrl, ep.apiKey, body, input.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  const parsed = parseEnrollResponse(result, protocol)
  if (!parsed.voiceId) {
    throw new WorkbenchError('clone_no_voice', `供应商未返回音色标识（${protocol}）：${JSON.stringify(result).slice(0, 300)}`, 502)
  }
  if (parsed.fallbackMode) {
    warnings.push(`供应商以降级模式创建音色（${parsed.fallbackReason || 'fallback_mode=true'}）——建议更换更清晰的样本`)
  }

  const now = Date.now()
  const meta = {
    protocol,
    prefix: body.input[pspec.prefixField],
    transport: pspec.transport,
    target_model: targetModel,
    ...(parsed.fallbackMode ? { fallback_mode: true, fallback_reason: parsed.fallbackReason || null } : {}),
  }
  try {
    const inserted = await db
      .insert(voiceClones)
      .values({
        name,
        providerKey,
        model: targetModel,
        voiceId: parsed.voiceId,
        status: 'ready',
        meta: JSON.stringify(meta),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    const clone = inserted[0]!
    log.info(`克隆音色「${name}」创建成功：${providerKey}/${targetModel} voice=${parsed.voiceId}`)
    return { clone, warnings }
  } catch (err) {
    if (isUniqueViolation(err)) throw new WorkbenchError('dup_name', `音色名「${name}」已存在`, 409)
    throw err
  }
}

/** 唯一约束冲突判定（drizzle 包装为 DrizzleQueryError，cause 链回溯） */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (/UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(e.message)) return true
  }
  return false
}

export async function listVoiceClones(): Promise<VoiceClone[]> {
  return db.select().from(voiceClones).orderBy(asc(voiceClones.id))
}

export async function getVoiceClone(id: number): Promise<VoiceClone | null> {
  const rows = await db.select().from(voiceClones).where(eq(voiceClones.id, id)).limit(1)
  return rows[0] ?? null
}

/** 声线链索引（仅 ready 行；无效/异步未完成引用交由 validCloneRef 跳过降级） */
export async function loadCloneIndex(): Promise<Map<number, VoiceClone>> {
  const rows = await db.select().from(voiceClones).where(eq(voiceClones.status, 'ready'))
  return new Map(rows.map((r) => [r.id, r]))
}

/** 删除音色行（v1 仅删本地登记，不回调供应商删除接口——见 spec §2.2 ⑧ 范围） */
export async function deleteVoiceClone(id: number): Promise<{ ok: true; name: string }> {
  if (!Number.isInteger(id) || id <= 0) throw new WorkbenchError('bad_id', 'id 需为正整数')
  const row = await getVoiceClone(id)
  if (!row) throw new WorkbenchError('not_found', `音色 ${id} 不存在`, 404)
  await db.delete(voiceClones).where(eq(voiceClones.id, id))
  log.info(`删除克隆音色「${row.name}」（#${id}；供应商侧 voice 保留，可经供应商控制台清理）`)
  return { ok: true, name: row.name }
}

// ---------- 合成衔接（clone: 引用 → 端点切换 + 模型联动） ----------

/**
 * 按克隆行解析合成端点：providerKey 换端点、model 覆盖为克隆绑定模型（克隆与合成必须同模型）。
 * cache 由调用方按步骤持有（同 provider 多句复用，避免逐句查库）。
 */
export async function cloneEndpoint(clone: VoiceClone, cache?: Map<string, AudioEndpoint>): Promise<AudioEndpoint> {
  const base = await resolveAudioEndpoint(clone.providerKey)
  const key = `${clone.providerKey}#${clone.model}`
  if (cache) {
    const hit = cache.get(key)
    if (hit) return { ...hit, model: clone.model }
  }
  const ep: AudioEndpoint = { ...base, model: clone.model }
  cache?.set(key, ep)
  return ep
}

/** 试听（不落资产）：按克隆端点/模型/voice 合成，返回 mp3 字节 */
export async function synthWithClone(clone: VoiceClone, text: string): Promise<Uint8Array> {
  const t = (text ?? '').trim()
  if (!t) throw new WorkbenchError('bad_text', '试听文本不能为空')
  if (t.length > CLONE_TEST_MAX_CHARS) {
    throw new WorkbenchError('bad_text', `试听文本上限 ${CLONE_TEST_MAX_CHARS} 字（当前 ${t.length} 字）`)
  }
  const ep = await cloneEndpoint(clone)
  return synthSpeech(t, ep, { voice: clone.voiceId })
}

// ---------- DashScope 定制端点调用 ----------

async function postEnroll(baseUrl: string, apiKey: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(joinApiUrl(baseUrl, '/api/v1', '/services/audio/tts/customization'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      throw new WorkbenchError('clone_failed', `声音复刻失败 HTTP ${res.status}: ${httpDetail(raw)}`, 502)
    }
    return (await res.json()) as unknown
  } catch (err) {
    if (err instanceof WorkbenchError) throw err
    throw new WorkbenchError('clone_failed', `声音复刻请求异常：${(err as Error).message}`, 502)
  } finally {
    clearTimeout(timer)
  }
}

/** HTTP 错误体细节：优先解析 DashScope {code,message}，否则原文截断 */
function httpDetail(raw: string): string {
  try {
    const obj = JSON.parse(raw) as { code?: string; message?: string }
    if (obj?.code || obj?.message) return `${obj.code ? `[${obj.code}] ` : ''}${obj.message ?? ''}`
  } catch {
    /* 非 JSON 原文截断 */
  }
  return raw.slice(0, 300)
}

/** baseUrl 兼容带/不带 /api/v1 路径段的网关（与 tts-aliyun / 万相适配器同源） */
function joinApiUrl(baseUrl: string, prefix: string, path: string): string {
  const base = (baseUrl || '').replace(/\/+$/, '')
  if (!base) return `${prefix}${path}`
  try {
    const url = new URL(base)
    const current = url.pathname.replace(/\/+$/, '')
    const merged = current.endsWith(prefix) ? current : `${current}${prefix}`
    url.pathname = `${merged}${path}`.replace(/\/{2,}/g, '/')
    return url.toString()
  } catch {
    const basePath = base.endsWith(prefix) ? base : `${base}${prefix}`
    return `${basePath}${path}`
  }
}
