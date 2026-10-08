/**
 * AI 生成 BGM：kit music 协议族（百炼 Fun-Music/火山 GenBGM/MiniMax）的宿主 glue。
 * 端点：api_configs service_type='music'（目录行 aliyun_bailian_music/volcengine_music；minimax_music
 * 已退役不再预种——接口不再面向新用户，仅存量实例仍经 kit 适配器派发，
 * service_type 自由 text 零迁移）；供应商派发走 kit getMusicAdapter 注册表（能力真源在 kit）。
 * 降级红线：未配置/失败/超时 → 返回 null 由 smart-bgm 降级库内 auto，绝不断链；
 * 成功产物落 purpose='source' 音频资产（绑定动作在 smart-bgm.bindAsRunBgm 统一口径），
 * 用量走既有 usage_records（kind='music'，second 口径，付费可见）。
 * 协议形态与契约纯函数（build/parse 系列）在 kit，探针 live 节经 globalThis.fetch 桩做契约测试（不真付费），本文件不直接触碰 HTTP。
 */
import { writeFileSync, statSync } from 'node:fs'
import { resolveEndpoint } from '../adapters/provider'
import { getMusicAdapter } from '@agencys/ai-provider-kit'
import { absPathOf, registerAsset, relPathOf } from './storage'
import { probeMediaDuration } from './ffmpeg'
import { recordUsage } from './usage'
import type { Asset } from '../db/schema'
import type { StepContext } from '../pipeline/context'

/** 生乐请求超时（同步长请求；超时按失败降级库内，绝不重试二次付费） */
export const MUSIC_GEN_TIMEOUT_MS = 300_000

/**
 * 生成一首纯音乐 BGM 并登记为项目音频资产（未绑定态 purpose='source'）。
 * 任何异常（未配置/HTTP 失败/契约不符/写盘失败）→ log + null（调用方降级库内）。
 */
export async function generateMusicAsset(ctx: StepContext, prompt: string): Promise<Asset | null> {
  let ep: Awaited<ReturnType<typeof resolveEndpoint>>
  try {
    ep = await resolveEndpoint('music')
  } catch (err) {
    ctx.log(`AI 生乐端点不可用：${(err as Error).message}`)
    return null
  }
  // 模型缺省传空：各适配器自带官方默认（minimax music-3.0 / 百炼 fun-music-v1 / 火山 v5.0）
  const model = ep.model || (typeof ep.extra['model'] === 'string' ? ep.extra['model'] : '')
  ctx.log(`AI 生成 BGM：${ep.providerKey}/${model || '默认'}（prompt ${prompt.length} 字，纯音乐）…`)
  try {
    const adapter = getMusicAdapter(ep.providerKey)
    const music = await adapter.generate(
      { providerKey: ep.providerKey, baseUrl: ep.baseUrl, apiKey: ep.apiKey, model, extra: ep.extra },
      { prompt, instrumental: true, timeoutMs: MUSIC_GEN_TIMEOUT_MS },
    )
    const name = `bgm-ai-${Date.now()}.mp3`
    const rel = relPathOf(ctx.run.projectId, 'audio', name)
    const abs = absPathOf(rel)
    writeFileSync(abs, Buffer.from(music.audio))
    const duration = music.durationMs !== null ? Math.round(music.durationMs / 100) / 10 : probeMediaDuration(abs) ?? undefined
    const asset = await registerAsset(ctx.run.projectId, {
      name,
      kind: 'audio',
      purpose: 'source',
      relPath: rel,
      ext: 'mp3',
      mime: 'audio/mpeg',
      fileSize: statSync(abs).size,
      duration,
      prompt,
      params: { generator: ep.providerKey, model, music_duration_ms: music.durationMs },
      tags: ['bgm_ai'],
    })
    await recordUsage({
      projectId: ctx.run.projectId,
      runId: ctx.run.id,
      stepId: ctx.step.id,
      assetId: asset.id,
      kind: 'music',
      provider: ep.providerKey,
      model,
      quantity: duration ?? 0,
      unit: 'second',
      meta: { source: 'music_gen', bgm_asset: asset.id },
    })
    return asset
  } catch (err) {
    ctx.log(`AI 生乐失败（降级库内）：${(err as Error).message}`)
    return null
  }
}
