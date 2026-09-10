import { writeFileSync } from 'node:fs'
import { absPathOf, ensureProjectDirs, registerAsset, relPathOf } from '../../services/storage'
import { resolveAudioEndpoint, synthSpeech } from '../../services/tts'
import type { StepContext } from '../context'
import type { StepResult } from '../types'

interface LineItem {
  id: string
  text: string
}

/**
 * tts：对白/口播配音（spec §5.2，OpenAI 兼容 /audio/speech）。
 * 输入 lines 两种形态：
 *  - 单个 JSON 资产：{ lines: [{id?, speaker?, text}], ... } 或纯数组；
 *  - 多个资产：每资产全文 = 一句台词。
 * 产物：每句 1 个 audio 资产（purpose=voice，mime audio/mpeg，可复用/可替换/可溯源），
 * 按台词顺序聚合为 asset_ids；多轨拼接对齐由下游 ffmpeg_merge 统一 concat/adelay。
 * voice/speed 取 params → defaults.audio / project.settings.audio 兜底（voice 默认 alloy）。
 */
export async function tts(ctx: StepContext): Promise<StepResult> {
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const audCfg = (ctx.settings.audio ?? {}) as Record<string, unknown>
  const provider = typeof audCfg['provider'] === 'string' ? audCfg['provider'] : undefined
  const voice = (typeof params['voice'] === 'string' && params['voice'])
    || (typeof audCfg['voice'] === 'string' && audCfg['voice'])
    || 'alloy'
  const speedRaw = typeof params['speed'] === 'number' ? params['speed'] : audCfg['speed']
  const speed = typeof speedRaw === 'number' ? speedRaw : undefined

  const lineIds = ctx.assetIdsOf('lines')
  if (lineIds.length === 0) throw new Error('inputs.lines 无台词资产')
  const lines = await collectLines(ctx, lineIds)
  if (lines.length === 0) throw new Error('台词内容为空（lines 数组/资产全文均无文本）')
  ctx.log(`配音 ${lines.length} 句（voice=${voice}${speed ? `, speed=${speed}` : ''}，模型取 audio 实例配置）`)

  const ep = await resolveAudioEndpoint(provider)
  const assetIds: number[] = []
  let failed = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    try {
      const data = await synthSpeech(line.text, ep, { voice, speed })
      const idx = String(i + 1).padStart(2, '0')
      const fileName = `${Date.now()}-voice-${idx}-${sanitizeName(line.id)}.mp3`
      const relPath = relPathOf(ctx.run.projectId, 'voice', fileName)
      ensureProjectDirs(ctx.run.projectId)
      writeFileSync(absPathOf(relPath), data)
      const asset = await registerAsset(ctx.run.projectId, {
        stepId: ctx.step.id,
        kind: 'audio',
        purpose: 'voice',
        relPath,
        name: fileName,
        mime: 'audio/mpeg',
        ext: 'mp3',
        fileSize: data.byteLength,
        prompt: line.text.slice(0, 4000),
        params: { lineId: line.id, voice, speed: speed ?? null, model: ep.model, provider: ep.providerKey, chars: line.text.length },
        tags: ['voice'],
      })
      assetIds.push(asset.id)
      ctx.log(`句 ${idx} (${line.id}) 配音完成 → asset#${asset.id}（${data.byteLength} 字节）`)
    } catch (err) {
      failed += 1
      ctx.log(`句 ${line.id} 配音失败：${(err as Error).message}`)
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
    out.push({ id, text })
  }
  return out
}

function sanitizeName(s: string): string {
  const cleaned = s.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'line'
}
