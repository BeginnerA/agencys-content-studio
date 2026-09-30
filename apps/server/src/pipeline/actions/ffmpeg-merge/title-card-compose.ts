/**
 * M61 T3 片首标题字卡 IO 编排（自 index.ts 拆出，[M61-split] 行为零变更）：
 * 纯渲染函数（字体解析/转义/参数拼装）留在 title-card.ts 保「纯函数可探针直测」设计红线，
 * 本文件负责读 SRT / 跑 ffmpeg / 段列插片首的副作用面，同时守 index.ts ≤800 行红线。
 * 失败面契约不变：title_card off/缺省、字体缺失、生成失败 → cardOk=false（调用方不裁 cue，标题回退字幕烧录）。
 */
import { basename, dirname } from 'node:path'
import { absPathOf, ensureProjectDirs, relPathOf } from '../../../services/storage'
import type { SubtitleStyleConfig } from '../../../services/brand-config'
import type { StepContext } from '../../context'
import { parseSrtCues } from './subtitle-ass'
import { buildTitleCardArgs, resolveCjkFont } from './title-card'
import { runFfmpeg } from './exec'
import type { Segment } from './segments'

/**
 * 片首标题字卡（本地 drawtext 单帧 PNG；title_card off/缺省 → 段列逐字节不变）：
 * 启用条件 = 非严格交付（红线④）∧ title_card∈{local,ai} ∧ titleLines>0 ∧ 有字幕资产 ∧ CJK 字体命中；
 * T6 AI 底图：cardReq='ai' 时读 card_bg_image（card_bg_img 步产物）绝对路径入 buildTitleCardArgs 底图分支；
 * 底图缺失/不可读（生图步未启用/失败/未配图像实例）→ 降级色底 local 链（卡照常出，绝不断链）；
 * 卡时长 = lead_in + 标题行数×每行时长 clamp [1.5,10]s，与 SRT 标题 cue 天然同轴（正文 cue 无需平移）；
 * 字体缺失/生成失败 → 不插卡也不裁 cue（cardOk=false 防线，否则标题彻底消失）。
 */
export async function maybeInsertTitleCard(o: {
  ctx: StepContext
  ffmpeg: string
  params: Record<string, unknown>
  strict: boolean
  subtitleId: number | null
  titleLines: number
  msPerLine: number
  leadInMs: number
  stylePlan: { style?: SubtitleStyleConfig; styles?: SubtitleStyleConfig[]; cue_style?: number[] } | null
  width: number
  height: number
  fps: number
  segments: Segment[]
}): Promise<{ cardOk: boolean; cardDurSec: number; cardMode: 'local' | 'ai' | null; tempAbs: string[] }> {
  const { ctx, segments } = o
  let cardOk = false
  let cardDurSec = 0
  let cardMode: 'local' | 'ai' | null = null
  const tempAbs: string[] = []
  const cardReq = !o.strict && typeof o.params['title_card'] === 'string' ? o.params['title_card'].trim() : ''
  if ((cardReq === 'local' || cardReq === 'ai') && o.titleLines > 0 && o.subtitleId !== null) {
    const fontFile = resolveCjkFont()
    if (!fontFile) {
      ctx.log('标题字卡跳过：未找到可用 CJK 字体（可用 ACS_CJK_FONT_FILE 指定字体文件），标题维持字幕烧录')
    } else {
      try {
        const srtSrcText = await ctx.readText(o.subtitleId!)
        const titleRows = parseSrtCues(srtSrcText).slice(0, o.titleLines).map((c) => c.text.replace(/\r?\n/g, ' ')).filter(Boolean)
        if (titleRows.length === 0) throw new Error('SRT 中标题行为空')
        // T6 AI 底图解析：仅 'ai' 请求时消费 card_bg_image；无产物/不可读 → null 降级色底（不报错不断链）
        let bgImageAbs: string | null = null
        if (cardReq === 'ai') {
          const bgIds = ctx.assetIdsOf('card_bg_image')
          if (bgIds.length === 0) {
            ctx.log('AI 背景字卡：无底图产物（背景步跳过/失败或未配图像实例），降级本地色底')
          } else {
            try {
              bgImageAbs = await ctx.pathOf(bgIds[0]!)
            } catch (err) {
              ctx.log(`AI 背景字卡：底图资产不可用（${(err as Error).message}），降级本地色底`)
            }
          }
        }
        const perLineMs = o.msPerLine > 0 ? o.msPerLine : 4000
        cardDurSec = Math.min(10, Math.max(1.5, Math.round((o.leadInMs + titleRows.length * perLineMs) / 100) / 10))
        ensureProjectDirs(ctx.run.projectId)
        const cardPngAbs = absPathOf(relPathOf(ctx.run.projectId, 'final_video', `.tcard-${ctx.run.id}-${Date.now()}.png`))
        // T7 卡样式与 cue_style 分组同源：首行标题 cue 指向的样式组 = 卡排版（卡与幕一台戏）
        const gi = o.stylePlan?.cue_style?.[0] ?? 0
        const cardStyle = o.stylePlan?.styles?.[gi] ?? o.stylePlan?.styles?.[0] ?? o.stylePlan?.style ?? {}
        await runFfmpeg(ctx, o.ffmpeg, buildTitleCardArgs({
          fontFile, lines: titleRows, width: o.width, height: o.height, fps: o.fps, outAbs: cardPngAbs, style: cardStyle,
          bg: typeof o.params['title_card_bg'] === 'string' ? o.params['title_card_bg'].trim() : undefined,
          bgImageAbs,
        }), dirname(cardPngAbs))
        segments.unshift({ id: -1, path: cardPngAbs, kind: 'image', durSec: cardDurSec, card: true })
        tempAbs.push(cardPngAbs)
        cardOk = true
        cardMode = bgImageAbs ? 'ai' : 'local'
        ctx.log(`标题字卡就绪（${bgImageAbs ? 'AI 底图+本地叠字' : '色底'}）：${titleRows.length} 行 / ${cardDurSec}s（字体 ${basename(fontFile)}），置于片首；ASS 将裁前 ${o.titleLines} 个 cue 防双呈现`)
      } catch (err) {
        ctx.log(`标题字卡生成失败（维持字幕烧录，不裁 cue）：${(err as Error).message}`)
      }
    }
  }
  return { cardOk, cardDurSec, cardMode, tempAbs }
}
