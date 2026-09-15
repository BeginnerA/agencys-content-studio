import { writeFileSync } from 'node:fs'
import { loadCharacterIndex } from '../../services/character'
import { absPathOf, ensureProjectDirs, registerAsset, relPathOf } from '../../services/storage'
import { cloneEndpoint, loadCloneIndex, parseCloneRef, validCloneRef } from '../../services/tts-clone'
import type { VoiceClone } from '../../db/schema'
import type { AudioEndpoint } from '../../services/tts'
import { resolveAudioEndpoint, resolveEmotionPayload, synthSpeech } from '../../services/tts'
import { recordUsage } from '../../services/usage'
import type { StepContext } from '../context'
import type { StepResult } from '../types'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface LineItem {
  id: string
  text: string
  speaker?: string
  voiceHint?: string
  emotionHint?: string
  estMs?: number
}

/**
 * tts：对白/口播配音（spec §5.2，OpenAI 兼容 /audio/speech）。
 * 输入 lines 两种形态：
 *  - 单个 JSON 资产：{ lines: [{id?, speaker?, voice_hint?, emotion_hint?, text}], ... } 或纯数组；
 *  - 多个资产：每资产全文 = 一句台词。
 * 产物：每句 1 个 audio 资产（purpose=voice，mime audio/mpeg，可复用/可替换/可溯源），
 * 按台词顺序聚合为 asset_ids；多轨拼接对齐由下游 ffmpeg_merge 统一 concat/adelay。
 * 抗抖重试（params.retry，默认 1 → 共 2 次尝试）：短剧长链（数十句）单句瞬时网络抖动不应拖垮整步，
 * 单句失败 1.5s 退避后再试（与 ai_image 同模式）；末次仍失败即抛（measured 字幕要求句数严格一致，快速失败便于修正后 resume）。
 * 声线六级链（spec §6.2）：line.voice_hint → 角色库 voice → params.voice → settings.audio.voice → 实例 extra.voice → alloy；
 * 情绪：emotion_hint → 基调词（首个「——」前段）→ 实例声明 emotion_param 时透传（emotion_map 映射）。
 * [M19 P8] 任一级写 `clone:{id}` → 命中平台音色库：换 provider 端点 + 克隆绑定模型合成（溯源 voiceSource='clone'）。
 */
export async function tts(ctx: StepContext): Promise<StepResult> {
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const audCfg = (ctx.settings.audio ?? {}) as Record<string, unknown>
  const provider = typeof audCfg['provider'] === 'string' ? audCfg['provider'] : undefined
  const speedRaw = typeof params['speed'] === 'number' ? params['speed'] : audCfg['speed']
  const speed = typeof speedRaw === 'number' ? speedRaw : undefined
  const paramVoice = typeof params['voice'] === 'string' && params['voice'] ? params['voice'] : undefined
  const settingsVoice = typeof audCfg['voice'] === 'string' && audCfg['voice'] ? audCfg['voice'] : undefined

  const ep = await resolveAudioEndpoint(provider)
  // [M19 P8] 音色库整步载入一次（无克隆行 → 空索引，声线链行为逐字不变）；命中后按 provider 换端点（同 provider 复用缓存）
  const cloneIndex = await loadCloneIndex()
  const cloneEpCache = new Map<string, AudioEndpoint>()

  const lineIds = ctx.assetIdsOf('lines')
  if (lineIds.length === 0) throw new Error('inputs.lines 无台词资产')
  const lines = await collectLines(ctx, lineIds)
  if (lines.length === 0) throw new Error('台词内容为空（lines 数组/资产全文均无文本）')
  const charIndex = await loadCharacterIndex(ctx.run.projectId)
  ctx.log(
    `配音 ${lines.length} 句（逐句声线链 + 情绪解析${speed ? `, speed=${speed}` : ''}，模型取 audio 实例配置${
      cloneIndex.size > 0 ? `；音色库 ${cloneIndex.size} 个克隆音色可引用 clone:{id}` : ''
    }）`,
  )

  const assetIds: number[] = []
  const cloneSkipped = new Set<string>()
  let failed = 0
  const retryRaw = typeof params['retry'] === 'number' ? params['retry'] : 1
  const maxAttempts = Math.max(0, Math.floor(retryRaw)) + 1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    try {
      const charVoice = line.speaker ? charIndex.get(line.speaker)?.voice ?? undefined : undefined
      const hit = resolveVoiceChain({
        lineVoice: line.voiceHint,
        charVoice,
        paramVoice,
        settingsVoice,
        instanceVoice: ep.voice,
        cloneIndex,
      })
      for (const s of hit.cloneSkipped) {
        if (cloneSkipped.has(s)) continue
        cloneSkipped.add(s)
        ctx.log(`克隆音色引用未命中（${s}）→ 跳过该级继续降级`)
      }
      // 命中克隆：换端点（provider 可不同于默认 audio 实例）+ 模型联动（克隆与合成必须同模型）+ voice 取供应商音色标识
      const lineEp = hit.clone ? await cloneEndpoint(hit.clone, cloneEpCache) : ep
      const voice = hit.voice
      const emotionKey = parseEmotionKey(line.emotionHint ?? '')
      const emotionPayload = resolveEmotionPayload(emotionKey, lineEp.emotion)
      // 抗抖重试：瞬时网络错误（fetch failed 等）退避重试，末次失败原样抛出
      let data: Uint8Array
      for (let attempt = 1; ; attempt++) {
        try {
          data = await synthSpeech(line.text, lineEp, { voice, speed, emotion: emotionPayload ?? undefined })
          break
        } catch (err) {
          if (attempt >= maxAttempts) throw err
          ctx.log(`句 ${line.id} 第 ${attempt}/${maxAttempts} 次失败，1.5s 后重试：${(err as Error).message}`)
          await sleep(1500)
        }
      }
      const idx = String(i + 1).padStart(2, '0')
      const fileName = `${Date.now()}-voice-${idx}-${sanitizeName(line.id)}.mp3`
      const relPath = relPathOf(ctx.run.projectId, 'voice', fileName)
      ensureProjectDirs(ctx.run.projectId)
      writeFileSync(absPathOf(relPath), data)
      const asset = await registerAsset(ctx.run.projectId, {
        stepId: ctx.step.id,
        runId: ctx.run.id,
        kind: 'audio',
        purpose: 'voice',
        relPath,
        name: fileName,
        mime: 'audio/mpeg',
        ext: 'mp3',
        fileSize: data.byteLength,
        prompt: line.text.slice(0, 4000),
        params: {
          lineId: line.id,
          speaker: line.speaker ?? null,
          voice,
          voiceSource: hit.clone ? 'clone' : hit.source,
          // [M19 P8] 克隆溯源：命中时记音色库行 id/名称与实际命中级（voiceSource 统一 'clone'）
          clone_id: hit.clone?.id ?? null,
          clone_name: hit.clone?.name ?? null,
          clone_level: hit.clone ? hit.source : null,
          voiceHint: line.voiceHint ?? null,
          emotionHint: line.emotionHint ?? null,
          emotionKey: emotionKey || null,
          emotionSent: emotionPayload?.value ?? null,
          speed: speed ?? null,
          model: lineEp.model,
          provider: lineEp.providerKey,
          chars: line.text.length,
        },
        tags: ['voice'],
      })
      // [M4] 用量记录：逐句按字符数计（元/千字符）
      await recordUsage({
        projectId: ctx.run.projectId,
        runId: ctx.run.id,
        stepId: ctx.step.id,
        assetId: asset.id,
        kind: 'tts',
        unit: 'char',
        quantity: line.text.length,
        provider: lineEp.providerKey,
        model: lineEp.model,
      })
      assetIds.push(asset.id)
      ctx.log(`句 ${idx} (${line.id}) 配音完成 → asset#${asset.id}（${data.byteLength} 字节）`)
    } catch (err) {
      failed += 1
      ctx.log(`句 ${line.id} 配音失败（已尝试 ${maxAttempts} 次）：${(err as Error).message}`)
      if (failed === 1) throw err
    }
  }
  if (failed > 0) throw new Error(`配音失败 ${failed} 句（未配置 audio 实例请到 Settings → 语音合成）`)
  ctx.log(`配音完成：${assetIds.length} 句 → ${assetIds.join(', ')}`)
  return { assetIds }
}

/** 解析台词：单 JSON 资产（lines 数组形态）或逐资产一句文本 */
async function collectLines(ctx: StepContext, ids: number[]): Promise<LineItem[]> {
  if (ids.length === 1) {
    const raw = await ctx.readText(ids[0]!)
    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      obj = null
    }
    if (Array.isArray(obj)) return toLines(obj)
    const obj2 = obj as { lines?: unknown } | null
    if (obj2 && Array.isArray(obj2.lines)) return toLines(obj2.lines)
    // 单资产非法 JSON：按整段一句话处理
    return raw.trim() ? [{ id: 'full', text: raw.trim() }] : []
  }
  const items: LineItem[] = []
  const assets = await ctx.assetsOf(ids)
  for (const a of assets) {
    const text = await ctx.readText(a.id).catch(() => '')
    const trimmed = text.trim()
    if (trimmed) items.push({ id: sanitizeName(a.name.replace(/\.(md|txt|json)$/i, '')), text: trimmed })
  }
  return items
}

function toLines(list: unknown[]): LineItem[] {
  const out: LineItem[] = []
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const text = typeof rec['text'] === 'string' ? rec['text'].trim() : typeof rec['content'] === 'string' ? rec['content'].trim() : ''
    if (!text) continue
    const id = typeof rec['id'] === 'string' && rec['id'] ? rec['id'] : String(i + 1)
    // v2 可选字段（存在且类型合法时取值；缺省 undefined → 旧 lines.json 向后兼容）
    const str = (k: string): string | undefined => {
      const v = rec[k]
      return typeof v === 'string' && v.trim() ? v.trim() : undefined
    }
    const estMs = typeof rec['est_ms'] === 'number' && rec['est_ms'] > 0 ? rec['est_ms'] : undefined
    out.push({ id, text, speaker: str('speaker'), voiceHint: str('voice_hint'), emotionHint: str('emotion_hint'), estMs })
  }
  return out
}

/**
 * 声线六级链（spec §6.2）：line.voice_hint → 角色库 → params.voice → settings.audio.voice → 实例 extra.voice → 'alloy'。
 * 各级仅接受「供应商 voice 令牌」（全 ASCII，如 Cherry / FunAudioLLM/CosyVoice2-0.5B:alex）；
 * 自然语言声线基准短语（如「成年女声、清爽亲和」——voice_hint/角色库 voice 的方法论形态）跳过并继续降级：
 * 语义短语不是供应商枚举值，直接下发会 400（M3 验收实测 DashScope Invalid voice）；
 * 其原文仍逐句记录于 asset.params.voiceHint 供审计，声线链来源记实际下发级。
 * [M19 P8] cloneIndex：写 `clone:{id}` 且索引命中 → 返回供应商真实 voiceId + clone 行（调用方据此换端点/模型）；
 * 旧调用签名兼容（不传 cloneIndex 时行为逐字不变），此时 clone 令牌无法解析 → 记入 cloneSkipped 并跳过该级继续降级。
 */
export type VoiceChainSource = 'line' | 'character' | 'params' | 'settings' | 'instance' | 'default'

export function resolveVoiceChain(p: {
  lineVoice?: string
  charVoice?: string
  paramVoice?: string
  settingsVoice?: string
  instanceVoice?: string
  cloneIndex?: Map<number, VoiceClone>
}): {
  voice: string
  source: VoiceChainSource
  clone: VoiceClone | null
  cloneSkipped: string[]
} {
  const cloneSkipped: string[] = []
  const levels: Array<[VoiceChainSource, string | undefined]> = [
    ['line', p.lineVoice],
    ['character', p.charVoice],
    ['params', p.paramVoice],
    ['settings', p.settingsVoice],
    ['instance', p.instanceVoice],
  ]
  for (const [source, raw] of levels) {
    const clone = validCloneRef(raw, p.cloneIndex)
    if (clone) return { voice: clone.voiceId, source, clone, cloneSkipped }
    if (parseCloneRef(raw) !== null) {
      cloneSkipped.push(`${source}=${String(raw).trim()}`)
      continue
    }
    if (isProviderVoice(raw)) return { voice: raw!, source, clone: null, cloneSkipped }
  }
  return { voice: 'alloy', source: 'default', clone: null, cloneSkipped }
}

/** 供应商 voice 令牌判定：全 ASCII 可打印字符（voice 枚举 /「模型:音色」格式均满足；中文语义短语不满足） */
export function isProviderVoice(v?: string): boolean {
  return !!v && /^[\x20-\x7e]+$/.test(v)
}

/** 情绪基调词（spec §6.2）：emotion_hint 首个「——」前段；无分隔符取前 6 字符；空 → '' */
export function parseEmotionKey(hint: string): string {
  const idx = hint.indexOf('——')
  if (idx >= 0) return hint.slice(0, idx).trim()
  return [...hint.trim()].slice(0, 6).join('')
}

function sanitizeName(s: string): string {
  const cleaned = s.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'line'
}
