import { writeFileSync } from 'node:fs'
import { probeMediaDuration } from '../../services/ffmpeg'
import { loadPromptTemplate, chatCompleteDetailed, resolveLlmEndpoint } from '../../services/llm'
import { absPathOf, ensureProjectDirs, registerAsset, relPathOf } from '../../services/storage'
import { recordLlmUsage } from '../../services/usage'
import { buildBilingualSrt } from '../../services/creation/gen/subtitle'
import { estimateMaxCharsPerLine } from './ffmpeg-merge/subtitle-wrap'
import { numParam, clamp } from './ffmpeg-merge/util'
import { sanitizeSubtitleStyle } from '../../services/brand-config'
import type { SubtitleStyleConfig } from '../../services/brand-config'
import type { StepContext } from '../context'
import type { StepResult } from '../types'
import { recipeOf } from '../../services/creation-chat/recipe'
import { strictVoicePlan } from './ffmpeg-merge/strict'

export interface TimingLine {
  id: string
  text: string
  start_ms: number
  end_ms: number
}

/**
 * subtitle：对白/口播切句定时 → SRT 字幕资产（spec §5.3/§7.1）。
 * 三模式：
 *  - measured：提供 voices 输入（tts 配音资产序列，句序与台词一致）→ ffprobe 逐句实测时长，
 *    splitDisplayLines 切显示行 + planMeasuredSrt 比例分配 → 字幕与音频帧级对齐；
 *  - estimated：无 voices（或 params.mode=estimated）→ LLM 按 params.prompt_tpl 切句估时；
 *  - fixed：params.mode=fixed → 零 LLM，输入台词逐行定长计时（planFixedSrt，
 *    ms_per_line 每行时长 / lead_in_ms 起始延时 / total_ms 可选末行收敛），供标题/祝福语烧录。
 * 标题智能编排（仅 fixed 分支）：inputs 桥 style_mode/title_card/resolution（select/text 直通串）；
 *  style_mode=rule|llm → 资产 params 增 style_plan（planTitleStyle 规则层；llm 见期2）与 title_lines；
 *  仅 title_card=local|ai（style off）→ 只记 title_lines（字卡取行/裁 cue 依据）；
 *  两开关 off/缺省（存量模板无这些 inputs 键）→ 资产 params 零增键、行为逐字节不变。
 * 双语扩展：params.target_lang（ISO 639-1，非空启用）定时完成后台词逐句翻译（translate-lines.md），
 *  params.bilingual='both'（缺省：双语 + 纯目标语两条）| 'merged'（仅双语）；缺失句回退原文 + log；
 *  产物命名 subtitle.zh-{lang}.srt / subtitle.{lang}.srt，params.lang 标注；不传 target_lang 现行为逐字不变。
 * 输入（二选一，同时提供以 script 优先）：
 *  - script: 对白全文资产（口播文案 md/剧本）
 *  - lines:  台词 JSON 资产（{lines:[{id,text,est_ms?}]}，est_ms 作 LLM/回退参考时长）
 * 产物：text 资产（purpose=subtitle，mime text/plain，ext srt），params.mode 记录对齐路径。
 * 模板作者可在此步挂 gate 人工核对字幕。
 */
export async function subtitle(ctx: StepContext): Promise<StepResult> {
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const tplFile = typeof params['prompt_tpl'] === 'string' && params['prompt_tpl'] ? params['prompt_tpl'] : 'lines-timing.md'
  const source = await collectSource(ctx)
  const strict = params['strict_delivery'] === true
  const recipe = strict ? recipeOf(ctx.run) : null
  if (strict && !recipe) throw new Error('严格字幕缺少批准方案')
  ctx.log(`字幕切句输入：${source.lines.length} 句台词（${source.text.length} 字符）`)

  // mode 判定（spec §7.1）：params.mode=fixed → 定长零 LLM；提供 voices → measured 实测对齐；params.mode 可强制 estimated
  const voiceIds = ctx.assetIdsOf('voices')
  const modeParam = typeof params['mode'] === 'string' ? params['mode'] : undefined
  let mode: 'measured' | 'estimated' | 'fixed' = voiceIds.length > 0 ? 'measured' : 'estimated'
  if (modeParam === 'estimated') mode = 'estimated'
  if (modeParam === 'fixed') mode = 'fixed'
  if (strict && voiceIds.length === 0) throw new Error('严格字幕需要完整配音，不允许 LLM 估时')
  if (modeParam === 'measured' && voiceIds.length === 0) {
    mode = 'estimated'
    ctx.log('mode=measured 但未提供 voices 输入，已回退 estimated（LLM 估时）')
  }

  let timed: TimingLine[]
  let assetParams: Record<string, unknown>
  let promptSnapshot: string
  if (mode === 'fixed') {
    const msPerLine = clamp(Math.round(numParam(params['ms_per_line'], 4000)), 500, 120_000)
    const leadInMs = clamp(Math.round(numParam(params['lead_in_ms'], 300)), 0, 600_000)
    const totalMs = typeof params['total_ms'] === 'number' && Number.isFinite(params['total_ms']) && params['total_ms'] > 0
      ? Math.round(params['total_ms']) : undefined
    timed = planFixedSrt(source.lines, { ms_per_line: msPerLine, lead_in_ms: leadInMs, total_ms: totalMs })
    if (timed.length === 0) throw new Error('fixed 字幕无有效行（台词为空或 total_ms 过短）')
    ctx.log(`字幕 fixed：${timed.length} 行定长 ${msPerLine}ms（起始延时 ${leadInMs}ms${totalMs ? `，总长收敛 ${totalMs}ms` : ''}，零 LLM）`)
    const lastEnd = timed[timed.length - 1]!.end_ms
    assetParams = { mode, lines: timed.length, durationMs: lastEnd, ms_per_line: msPerLine, lead_in_ms: leadInMs, ...(totalMs ? { total_ms: totalMs } : {}) }
    promptSnapshot = `fixed 定长计时：lines=${source.lines.length} ms_per_line=${msPerLine} lead_in_ms=${leadInMs}${totalMs ? ` total_ms=${totalMs}` : ''}`
    // 标题智能编排启用态（select 值经 resolveInputs 字符串直通；off/缺省 → 零增键逐字节不变）
    const designMode = typeof ctx.input['style_mode'] === 'string' ? ctx.input['style_mode'].trim() : ''
    const cardRaw = typeof ctx.input['title_card'] === 'string' ? ctx.input['title_card'].trim() : ''
    const cardOn = cardRaw === 'local' || cardRaw === 'ai'
    const smartOn = designMode === 'rule' || designMode === 'llm'
    if ((smartOn || cardOn) && source.titleLines > 0) {
      assetParams.title_lines = source.titleLines
      if (smartOn) {
        const rm = /^(\d+)x(\d+)$/.exec(typeof ctx.input['resolution'] === 'string' ? ctx.input['resolution'] : '')
        const cw = rm ? Number(rm[1]) : 1920
        const chh = rm ? Number(rm[2]) : 1080
        const roles = timed.map((t, i) => ({ text: t.text, role: (i < source.titleLines ? 'title' : 'body') as 'title' | 'body' }))
        let rulePlan = planTitleStyle(roles, { width: cw, height: chh })
        let styleSource: 'rule' | 'llm' = 'rule'
        if (designMode === 'llm') {
          // 期2 T5：LLM 智能排版（失败降级规则层）；计费单次调用与 estimated 分支同法 recordLlmUsage
          const llmPlan = await designStyleWithLlm(ctx, roles, { width: cw, height: chh }, promptSnapshot)
          if (llmPlan) {
            rulePlan = llmPlan
            styleSource = 'llm'
          } else {
            ctx.log('LLM 智能排版未产出有效方案（无实例/解析失败/字段全非法），已降级规则排版')
          }
        }
        assetParams.style_plan = { style: rulePlan.style, styles: rulePlan.styles, cue_style: rulePlan.cue_style }
        assetParams.style_source = styleSource
        ctx.log(`标题智能排版（${styleSource}）：${rulePlan.styles.length} 组样式 / ${timed.length} 行映射（标题 ${source.titleLines} 行）`)
      }
    }
  } else if (mode === 'measured') {
    if (voiceIds.length !== source.lines.length) {
      throw new Error(`measured 字幕：voices 数量(${voiceIds.length}) 与台词句数(${source.lines.length}) 不一致（防错位）`)
    }
    const voices = await ctx.assetsOf(voiceIds)
    const aligned = recipe ? strictVoicePlan(recipe.plan, voices, ctx.run.projectId) : null
    const durationsMs: number[] = []
    let fallbackCount = 0
    for (let i = 0; i < voices.length; i++) {
      const a = voices[i]!
      const line = source.lines[i]!
      const sec = a.relPath ? probeMediaDuration(absPathOf(a.relPath)) : null
      const dMs = sec !== null ? Math.round(sec * 1000) : (line.estMs ?? line.text.length * 180)
      if (strict && sec === null) throw new Error('严格字幕无法核验配音时长')
      if (sec === null) {
        fallbackCount += 1
        ctx.log(`句 ${line.id} 音频实测失败，回退估时 ${dMs}ms`)
      }
      durationsMs.push(dMs)
    }
    timed = planMeasuredSrt(source.lines, durationsMs)
    if (aligned) {
      timed = timed.map((cue) => {
        const lineId = cue.id.slice(0, cue.id.lastIndexOf('.'))
        const line = aligned.lines.find((l) => l.lineId === lineId)
        if (!line) throw new Error('字幕台词 ID 不在批准方案中')
        const shift = Math.round((line.timelineStart - line.speechStart) * 1000)
        return { ...cue, start_ms: cue.start_ms + shift, end_ms: cue.end_ms + shift }
      })
    }
    const sumD = durationsMs.reduce((s, x) => s + x, 0)
    const lastEnd = timed[timed.length - 1]!.end_ms
    if (sumD > 0 && Math.abs(lastEnd - sumD) / sumD > 0.02) {
      ctx.log(`警告：字幕末行结束 ${lastEnd}ms 与实测累加 ${sumD}ms 偏差超 2%（防错位防线）`)
    }
    ctx.log(`字幕 measured：${voiceIds.length} 句实测累加 ${sumD}ms${fallbackCount ? `（${fallbackCount} 句回退估时）` : ''}`)
    assetParams = { mode, lines: timed.length, durationMs: lastEnd, sentenceCount: source.lines.length, voiceCount: voiceIds.length, ...(strict ? { timelineAligned: true } : {}) }
    promptSnapshot = `measured 实测对齐：voices=[${voiceIds.join(',')}] durations=[${durationsMs.join(',')}]ms`
  } else {
    ctx.log(`字幕 estimated：LLM 切句估时（提示词 ${tplFile}）`)
    const templateText = loadPromptTemplate(tplFile)
    const userPrompt = `${templateText}\n\n===== 待定时台词 =====\n${source.text}`
    const ep = await resolveLlmEndpoint()
    ctx.log(`调用 LLM 切句定时：${ep.model}…`)
    const llmCfg = (ctx.settings.llm ?? {}) as Record<string, unknown>
    const res = await chatCompleteDetailed(
      [
        { role: 'system', content: '你是字幕时间轴标注引擎，只输出任务要求的最小 JSON 本体，不输出任何解释性文字或 markdown 围栏。' },
        { role: 'user', content: userPrompt },
      ],
      ep,
      {
        temperature: 0.2,
        maxTokens: typeof llmCfg['max_tokens'] === 'number' ? llmCfg['max_tokens'] : 12000,
      },
    )
    // 用量记录（estimated 分支单次 LLM 调用；measured 分支零调用不记录）
    await recordLlmUsage({ projectId: ctx.run.projectId, runId: ctx.run.id, stepId: ctx.step.id,
      provider: res.provider, model: res.model, usage: res.usage })
    const content = res.content
    timed = parseTimedLines(content)
    if (timed.length !== source.lines.length) {
      ctx.log(`字幕句数与输入台词不一致（${timed.length}/${source.lines.length}），以 LLM 切句结果为准`)
    }
    assetParams = { model: ep.model, lines: timed.length, durationMs: timed.length ? timed[timed.length - 1]!.end_ms : 0, mode: 'estimated' }
    promptSnapshot = userPrompt
  }

  const srt = toSrt(timed)
  assertSrt(srt, timed)

  // 双语分支：target_lang 非空 → 台词逐句翻译 → 双语（+纯目标语）SRT 产物；否则走下方原文单产物现状
  const targetLang = typeof params['target_lang'] === 'string' && params['target_lang'].trim() ? params['target_lang'].trim().toLowerCase() : ''
  if (targetLang) {
    const bilingualMode: 'both' | 'merged' = params['bilingual'] === 'merged' ? 'merged' : 'both'
    const dstMap = await translateTimedLines(ctx, timed, targetLang)
    const { bilingual, target } = buildBilingualSrt(
      timed.map((l) => ({ id: l.id, startMs: l.start_ms, endMs: l.end_ms, text: l.text })),
      dstMap,
      bilingualMode,
    )
    if (!bilingual) throw new Error(`双语字幕无有效段（target_lang=${targetLang}）`)
    const ts = Date.now()
    const outIds: number[] = []
    outIds.push(
      (await registerSrtAsset(ctx, `${ts}-subtitle.zh-${targetLang}.srt`, bilingual, promptSnapshot, {
        ...assetParams,
        lang: `zh-${targetLang}`,
        targetLang,
        bilingual: bilingualMode,
        translated: dstMap.size,
      })).id,
    )
    if (target) {
      outIds.push(
        (await registerSrtAsset(ctx, `${ts}-subtitle.${targetLang}.srt`, target, promptSnapshot, {
          ...assetParams,
          lang: targetLang,
          targetLang,
          translated: dstMap.size,
        })).id,
      )
    }
    ctx.log(`双语字幕已生成（zh→${targetLang}，${dstMap.size}/${timed.length} 句译文，模式 ${bilingualMode}）→ asset#${outIds.join(', #')}`)
    return { assetIds: outIds }
  }

  const fileName = `${Date.now()}-subtitle.srt`
  const relPath = relPathOf(ctx.run.projectId, 'subtitle', fileName)
  ensureProjectDirs(ctx.run.projectId)
  writeFileSync(absPathOf(relPath), srt, 'utf8')
  const asset = await registerAsset(ctx.run.projectId, {
    stepId: ctx.step.id,
    runId: ctx.run.id,
    kind: 'text',
    purpose: 'subtitle',
    relPath,
    name: fileName,
    mime: 'text/plain',
    ext: 'srt',
    fileSize: Buffer.byteLength(srt, 'utf8'),
    prompt: promptSnapshot.slice(0, 4000),
    params: assetParams,
    tags: ['subtitle'],
  })
  ctx.log(`字幕已生成 asset#${asset.id}（${timed.length} 条，末条结束 ${msToClock(timed[timed.length - 1]!.end_ms)}）`)
  return { assetIds: [asset.id] }
}

/** SRT 产物登记（双语分支专用，与原文路径同口径：purpose=subtitle，ext srt） */
async function registerSrtAsset(
  ctx: StepContext,
  fileName: string,
  content: string,
  promptSnapshot: string,
  assetParams: Record<string, unknown>,
) {
  const relPath = relPathOf(ctx.run.projectId, 'subtitle', fileName)
  ensureProjectDirs(ctx.run.projectId)
  writeFileSync(absPathOf(relPath), content, 'utf8')
  return registerAsset(ctx.run.projectId, {
    stepId: ctx.step.id,
    runId: ctx.run.id,
    kind: 'text',
    purpose: 'subtitle',
    relPath,
    name: fileName,
    mime: 'text/plain',
    ext: 'srt',
    fileSize: Buffer.byteLength(content, 'utf8'),
    prompt: promptSnapshot.slice(0, 4000),
    params: assetParams,
    tags: ['subtitle'],
  })
}

/** 定时结果逐句翻译（translate-lines.md 契约）→ id→dst 映射；缺失/同原文不进 map（调用方回退原文已 log） */
async function translateTimedLines(ctx: StepContext, timed: TimingLine[], targetLang: string): Promise<Map<string, string>> {
  const templateText = loadPromptTemplate('translate-lines.md')
  const linesPayload = timed.map((l) => ({ id: l.id, text: l.text }))
  const userPrompt = `${templateText}\n\n===== lines =====\n${JSON.stringify(linesPayload, null, 2)}\n\n目标语言：${targetLang}`
  const ep = await resolveLlmEndpoint()
  ctx.log(`字幕翻译：调用 ${ep.model}（zh→${targetLang}，${timed.length} 句）`)
  const llmCfg = (ctx.settings.llm ?? {}) as Record<string, unknown>
  const res = await chatCompleteDetailed(
    [
      { role: 'system', content: '你是字幕翻译引擎，只输出任务要求的合法 JSON 数组，不输出任何解释或 markdown 围栏。' },
      { role: 'user', content: userPrompt },
    ],
    ep,
    { temperature: 0.3, maxTokens: typeof llmCfg['max_tokens'] === 'number' ? llmCfg['max_tokens'] : 12000 },
  )
  await recordLlmUsage({ projectId: ctx.run.projectId, runId: ctx.run.id, stepId: ctx.step.id, provider: res.provider, model: res.model, usage: res.usage })
  const parsed = parseLineTranslations(res.content)
  const out = new Map<string, string>()
  for (const l of timed) {
    const dst = (parsed.get(l.id) ?? '').trim()
    if (dst && dst !== l.text.trim()) out.set(l.id, dst)
    else ctx.log(`句 ${l.id} 无有效译文 → 双语回退原文`)
  }
  return out
}

/**
 * 解析翻译契约 [{id,text,dst}]（纯函数，供探针直测）：
 * 剥围栏；根数组或 {lines:[...]} 宽容；id 字符串化对齐；dst 非字符串/空 → 该条丢弃。
 */
export function parseLineTranslations(raw: string): Map<string, string> {
  const noFence = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim()
  const start = noFence.indexOf('[') >= 0 && (noFence.indexOf('{') < 0 || noFence.indexOf('[') < noFence.indexOf('{'))
    ? noFence.slice(noFence.indexOf('['))
    : noFence.slice(noFence.indexOf('{'))
  let obj: unknown
  try {
    obj = JSON.parse(start)
  } catch {
    return new Map()
  }
  const list = Array.isArray(obj)
    ? obj
    : ((obj as { lines?: unknown }).lines ?? [])
  const out = new Map<string, string>()
  if (!Array.isArray(list)) return out
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const rec = item as Record<string, unknown>
    if (rec['id'] === undefined || rec['id'] === null) continue
    const dst = typeof rec['dst'] === 'string' ? rec['dst'].trim() : ''
    if (!dst) continue
    out.set(String(rec['id']), dst)
  }
  return out
}

/** 汇集台词来源：text 纯文本（标题类输入，非资产）与 script 全文合并优先；否则 lines JSON（est_ms 注入提示词作参考）。
 * titleLines（标题行数，仅 fixed 分支消费）：literal 单独路径 = 全部行；script+literal 合并路径 = literal 非空行数（标题在前）；lines JSON 路径 = 0 */
async function collectSource(ctx: StepContext): Promise<{ text: string; lines: Array<{ id: string; text: string; estMs?: number }>; titleLines: number }> {
  // text 输入为解析后原样透传的字符串（input.x 引用 kind:text 输入）；存量模板无此键 → '' = 行为不变
  const literal = typeof ctx.input['text'] === 'string' && ctx.input['text'].trim() ? ctx.input['text'].trim() : ''
  const literalTitleLines = literal ? literal.split(/\r?\n/).map((t) => t.trim()).filter(Boolean).length : 0
  const scriptIds = ctx.assetIdsOf('script')
  if (scriptIds.length > 0) {
    const text = await ctx.readText(scriptIds[0]!).catch(() => '')
    const trimmed = [literal, text.trim()].filter(Boolean).join('\n')
    if (trimmed) {
      return {
        text: trimmed,
        lines: trimmed
          .split(/\r?\n/)
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t, i) => ({ id: String(i + 1), text: t })),
        titleLines: literalTitleLines,
      }
    }
  }
  if (literal) {
    const lines = literal
      .split(/\r?\n/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t, i) => ({ id: String(i + 1), text: t }))
    return { text: literal, lines, titleLines: lines.length }
  }
  const lineIds = ctx.assetIdsOf('lines')
  if (lineIds.length === 0) throw new Error('subtitle 需要 inputs.script（对白全文）或 inputs.lines（台词 JSON）或 text（纯文本行）')
  const raw = await ctx.readText(lineIds[0]!)
  const obj = JSON.parse(raw) as { lines?: unknown[] } | unknown[]
  const list = Array.isArray(obj) ? obj : ((obj as { lines?: unknown[] }).lines ?? [])
  const items: Array<{ id: string; text: string; estMs?: number }> = []
  for (let i = 0; i < list.length; i++) {
    const rec = list[i] as Record<string, unknown>
    const text = typeof rec['text'] === 'string' ? rec['text'].trim() : ''
    if (!text) continue
    const estMs = typeof rec['est_ms'] === 'number' && Number.isFinite(rec['est_ms']) ? rec['est_ms'] : undefined
    const id = typeof rec['id'] === 'string' ? rec['id'] : String(i + 1)
    items.push({ id, text, estMs })
  }
  const text = items
    .map((it) => `${it.id}${typeof it.estMs === 'number' ? `（参考 ${it.estMs}ms）` : ''}: ${it.text}`)
    .join('\n')
  return { text, lines: items, titleLines: 0 }
}

/** 解析 LLM 产物：剥 markdown 围栏 → JSON lines → 字段校验（id/text/start_ms/end_ms） */
function parseTimedLines(raw: string): TimingLine[] {
  const noFence = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim()
  const start = noFence.indexOf('{')
  if (start < 0) throw new Error(`字幕定时 LLM 返回无 JSON：${raw.slice(0, 120)}`)
  let obj: unknown
  try {
    obj = JSON.parse(noFence.slice(start))
  } catch (err) {
    throw new Error(`字幕定时 JSON 解析失败：${(err as Error).message}（返回开头：${raw.slice(0, 120)}）`)
  }
  const list = Array.isArray(obj) ? (obj as unknown[]) : ((obj as { lines?: unknown[] }).lines ?? [])
  if (!Array.isArray(list) || list.length === 0) throw new Error('字幕定时结果缺 lines 数组')
  const out: TimingLine[] = []
  for (const item of list) {
    const rec = item as Record<string, unknown>
    const text = typeof rec['text'] === 'string' ? rec['text'].trim() : ''
    if (!text) continue
    const startMs = Number(rec['start_ms'])
    const endMs = Number(rec['end_ms'])
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      throw new Error(`字幕行「${text.slice(0, 30)}」缺合法 start_ms/end_ms`)
    }
    if (endMs <= startMs) throw new Error(`字幕行「${text.slice(0, 30)}」时间非法（end<=start）`)
    out.push({ id: String(rec['id'] ?? out.length + 1), text, start_ms: Math.round(startMs), end_ms: Math.round(endMs) })
  }
  // 时间单调自检（允许 LLM 将句末与下句首轻微重叠，超过 500ms 视为乱序）
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.start_ms < out[i - 1]!.end_ms - 500) {
      throw new Error(`字幕时间轴乱序：句 ${out[i]!.id} 起始早于上句结束（SRT 单调性校验失败）`)
    }
  }
  return out
}

/** TimingLine[] → SRT 文本（HH:MM:SS,mmm 格式由本函数保证合法） */
function toSrt(lines: TimingLine[]): string {
  return lines
    .map((l, i) => `${i + 1}\n${msToClock(l.start_ms)} --> ${msToClock(l.end_ms)}\n${l.text}\n`)
    .join('\n')
}

/** SRT 时间戳：h:mm:ss 或 hh:mm:ss,mmm（小时可超 2 位） */
function msToClock(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const milli = ms % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`
}

/** 解析自检：段数 > 0 且时间戳单调不减（spec §5.3 校验） */
function assertSrt(srt: string, timed: TimingLine[]): void {
  if (timed.length === 0) throw new Error('SRT 为空（无字幕段）')
  const blocks = srt.trim().split(/\r?\n\r?\n/)
  if (blocks.length !== timed.length) throw new Error(`SRT 段数异常（${blocks.length}/${timed.length}）`)
  const re = /(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/
  let prevEnd = -1
  for (const b of blocks) {
    const mt = b.match(re)
    if (!mt) throw new Error('SRT 时间戳行格式非法')
    const toMs = (p: string[]): number =>
      Number(p[0]) * 3_600_000 + Number(p[1]) * 60_000 + Number(p[2]) * 1000 + Number(p[3])
    const start = toMs([mt[1]!, mt[2]!, mt[3]!, mt[4]!])
    const end = toMs([mt[5]!, mt[6]!, mt[7]!, mt[8]!])
    if (start < prevEnd) throw new Error('SRT 时间轴非单调')
    if (end <= start) throw new Error('SRT 段时间非法')
    prevEnd = end
  }
}

/** 显示行切分（spec §7.1-3）：先按「。！？；!?;」→ 仍超 maxChars 按「，、,」→ 仍超按 code point 硬切；trim + 去空段 */
export function splitDisplayLines(text: string, maxChars: number): string[] {
  const max = Math.max(1, Math.floor(maxChars))
  const out: string[] = []
  for (const primary of splitKeeping(text, '。！？；!?;')) {
    const seg = primary.trim()
    if (!seg) continue
    if (cpLen(seg) <= max) {
      out.push(seg)
      continue
    }
    for (const secondary of splitKeeping(seg, '，、,')) {
      const sub = secondary.trim()
      if (!sub) continue
      if (cpLen(sub) <= max) {
        out.push(sub)
        continue
      }
      const chars = Array.from(sub)
      for (let i = 0; i < chars.length; i += max) {
        const piece = chars.slice(i, i + max).join('').trim()
        if (piece) out.push(piece)
      }
    }
  }
  return out
}

/**
 * fixed 定长计时（纯函数；探针直测）：逐行 [cursor, cursor+d)，lead_in 先行；
 * total_ms 提供时末行向总长收敛（放不下则弃行，防 SRT 非单调）。空行/纯空白行跳过。
 */
export function planFixedSrt(
  lines: Array<{ id: string; text: string }>,
  opts: { ms_per_line: number; lead_in_ms?: number; total_ms?: number },
): TimingLine[] {
  const d = Math.max(1, Math.round(opts.ms_per_line))
  let cursor = Math.max(0, Math.round(opts.lead_in_ms ?? 0))
  const out: TimingLine[] = []
  for (const line of lines) {
    const text = line.text.trim()
    if (!text) continue
    out.push({ id: line.id, text, start_ms: cursor, end_ms: cursor + d })
    cursor += d
  }
  if (typeof opts.total_ms === 'number' && opts.total_ms > 0 && out.length > 0) {
    const total = Math.round(opts.total_ms)
    // 逐行回退收敛：末行超总长 → 裁到总长；放不下（start>=end）弃行后对新末行重复，直到单调合法
    while (out.length > 0 && out[out.length - 1]!.end_ms > total) {
      const last = out[out.length - 1]!
      last.end_ms = total
      if (last.end_ms <= last.start_ms) out.pop()
      else break
    }
  }
  return out
}

/**
 * 标题智能排版方案（subtitle 资产 params.style_plan 结构；期1 消费 style，分层排版消费 styles/cue_style）：
 *  - style：全局主样式（单 ASS Style 消费口径；混合取正文组，纯标题取标题组——正文位移防护）
 *  - styles：分组样式（styles[0] 恒为标题组；混合时 styles[1] 为正文组）
 *  - cue_style：逐 cue 下标 → styles 下标映射（长度 = 行数）
 */
export interface TitleStylePlan {
  style: SubtitleStyleConfig
  styles: SubtitleStyleConfig[]
  cue_style: number[]
}

/**
 * 规则排版（纯函数；探针直测）：标题组字号按「最长标题行单行可容纳」从
 * [0.06, 0.055, 0.05, 0.045, 0.04] 降序阶梯选取（宽度预算 = estimateMaxCharsPerLine，全部不适则取最小档）；
 * bold=true；有正文行时标题置顶（alignment 8）否则居中（5）；竖屏（高>宽）加粗描边 outline_pct 0.0018 抗亮底。
 * 正文组保持基线观感（0.04/底部/常规）——智能决策只作用于标题，正文零惊扰。
 */
export function planTitleStyle(
  lines: Array<{ text: string; role: 'title' | 'body' }>,
  o: { width: number; height: number },
): TitleStylePlan {
  const width = Math.max(1, Math.round(o.width))
  const height = Math.max(1, Math.round(o.height))
  const titleTexts = lines.filter((l) => l.role === 'title').map((l) => l.text.trim()).filter(Boolean)
  const hasBody = lines.some((l) => l.role === 'body' && l.text.trim())
  const longest = titleTexts.reduce((m, t) => Math.max(m, Array.from(t).length), 1)
  let sizePct = 0.04
  for (const pct of [0.06, 0.055, 0.05, 0.045, 0.04]) {
    if (estimateMaxCharsPerLine(width, Math.max(1, Math.round(height * pct))) >= longest) { sizePct = pct; break }
  }
  const titleStyle: SubtitleStyleConfig = {
    size_pct: sizePct,
    bold: true,
    alignment: hasBody ? 8 : 5,
    ...(height > width ? { outline_pct: 0.0018 } : {}),
  }
  const bodyStyle: SubtitleStyleConfig = { size_pct: 0.04, alignment: 2, bold: false }
  const styles = hasBody ? [titleStyle, bodyStyle] : [titleStyle]
  const cue_style = lines.map((l) => (l.role === 'title' ? 0 : 1))
  const style = { ...(hasBody ? bodyStyle : titleStyle) }
  return { style, styles, cue_style }
}

/**
 * LLM 排版产物解析（纯函数；探针直测）：契约 `{"styles":[SubtitleStyleConfig…],"assign":[cue→style 下标…]}`。
 * 逐组 sanitizeSubtitleStyle 清洗（非法组 → 空对象回退基线公式）；assign 缺失/长度不符 → 按 role 推导默认映射；
 * 越界下标逐行校正。无 JSON/根非对象/styles 空 → null（调用方降级规则层）。全局主样式与规则层同语义（混合取正文组）。
 */
export function parseStylePlan(
  raw: string,
  roles: Array<{ text: string; role: 'title' | 'body' }>,
  _o: { width: number; height: number },
): TitleStylePlan | null {
  const noFence = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim()
  const start = noFence.indexOf('{')
  if (start < 0) return null
  let obj: unknown
  try {
    obj = JSON.parse(noFence.slice(start))
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const rec = obj as Record<string, unknown>
  if (!Array.isArray(rec['styles']) || rec['styles'].length === 0) return null
  const styles: SubtitleStyleConfig[] = (rec['styles'] as unknown[]).slice(0, 8).map((g) => sanitizeSubtitleStyle(g as SubtitleStyleConfig) ?? {})
  const fallbackIdx = (i: number) => (roles[i]!.role === 'title' ? 0 : Math.min(1, styles.length - 1))
  const assignRaw = Array.isArray(rec['assign']) ? (rec['assign'] as unknown[]) : null
  const cue_style = roles.map((_, i) => {
    const x = assignRaw && i < assignRaw.length ? assignRaw[i] : undefined
    return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < styles.length ? x : fallbackIdx(i)
  })
  const bodyIdx = roles.findIndex((r) => r.role === 'body')
  const primaryIdx = bodyIdx >= 0 ? cue_style[bodyIdx]! : cue_style[0]!
  return { style: { ...styles[primaryIdx]! }, styles, cue_style }
}

/**
 * LLM 智能排版（style_mode=llm）：title-style.md 契约单次调用（与 estimated 分支同法 recordLlmUsage 计费）；
 * 无实例/请求异常/产物无效 → null（调用方降级规则层并 log），绝不让排版设计失败阻断字幕产出。
 */
async function designStyleWithLlm(
  ctx: StepContext,
  roles: Array<{ text: string; role: 'title' | 'body' }>,
  o: { width: number; height: number },
  timingSnapshot: string,
): Promise<TitleStylePlan | null> {
  try {
    const templateText = loadPromptTemplate('title-style.md')
    const linesPayload = roles.map((r, i) => ({ index: i, role: r.role, text: r.text }))
    const userPrompt = `${templateText}\n\n===== 字幕行（role: title=标题行 / body=正文行） =====\n${JSON.stringify(linesPayload, null, 2)}\n\n输出画布：${o.width}×${o.height}\n计时参考：${timingSnapshot}`
    const ep = await resolveLlmEndpoint()
    ctx.log(`标题智能排版：调用 ${ep.model}（LLM 设计，${roles.length} 行）`)
    const llmCfg = (ctx.settings.llm ?? {}) as Record<string, unknown>
    const res = await chatCompleteDetailed(
      [
        { role: 'system', content: '你是字幕排版设计引擎，只输出任务要求的最小 JSON 本体，不输出任何解释性文字或 markdown 围栏。' },
        { role: 'user', content: userPrompt },
      ],
      ep,
      { temperature: 0.4, maxTokens: typeof llmCfg['max_tokens'] === 'number' ? llmCfg['max_tokens'] : 8000 },
    )
    await recordLlmUsage({ projectId: ctx.run.projectId, runId: ctx.run.id, stepId: ctx.step.id, provider: res.provider, model: res.model, usage: res.usage })
    return parseStylePlan(res.content, roles, o)
  } catch (err) {
    ctx.log(`LLM 智能排版调用异常（提示词缺失/请求失败）：${(err as Error).message}`)
    return null
  }
}

/** measured 时间轴（spec §7.1-4/5）：行时长按 code point 比例分配句时长（末行=余量）、句内短行合并、句间首尾相接 */
export function planMeasuredSrt(
  lines: Array<{ id: string; text: string }>,
  durationsMs: number[],
  opts?: { maxCharsPerLine?: number; minMs?: number; leadInMs?: number },
): TimingLine[] {
  if (lines.length !== durationsMs.length) {
    throw new Error(`measured 字幕：句数 ${lines.length} 与时长数 ${durationsMs.length} 不一致（防错位）`)
  }
  const maxChars = opts?.maxCharsPerLine ?? 18
  const minMs = opts?.minMs ?? 800
  let cursor = Math.max(0, Math.round(opts?.leadInMs ?? 0))
  const out: TimingLine[] = []
  for (let i = 0; i < lines.length; i++) {
    const d = Math.max(0, Math.round(durationsMs[i]!))
    const segs = splitDisplayLines(lines[i]!.text, maxChars)
    if (segs.length === 0) continue
    const counts = segs.map(cpLen)
    const total = Math.max(1, counts.reduce((s, x) => s + x, 0))
    let rows = segs.map((text, j) => ({
      text,
      dur: j === segs.length - 1 ? 0 : Math.round((d * counts[j]!) / total),
    }))
    rows[rows.length - 1]!.dur = Math.max(0, d - rows.reduce((s, r) => s + r.dur, 0))
    // 短行句内合并：首行并入其后一行，否则并入前一行（文本直接拼接、时长相加）；单行句保持原样
    while (rows.length > 1) {
      const idx = rows.findIndex((r) => r.dur < minMs)
      if (idx < 0) break
      if (idx === 0) {
        rows = [{ text: rows[0]!.text + rows[1]!.text, dur: rows[0]!.dur + rows[1]!.dur }, ...rows.slice(2)]
      } else {
        const merged = { text: rows[idx - 1]!.text + rows[idx]!.text, dur: rows[idx - 1]!.dur + rows[idx]!.dur }
        rows = [...rows.slice(0, idx - 1), merged, ...rows.slice(idx + 1)]
      }
    }
    for (let j = 0; j < rows.length; j++) {
      out.push({ id: `${lines[i]!.id}.${j + 1}`, text: rows[j]!.text, start_ms: cursor, end_ms: cursor + rows[j]!.dur })
      cursor += rows[j]!.dur
    }
  }
  return out
}

/** 逐字符扫描切分：分隔符保留在段尾 */
function splitKeeping(text: string, delimiters: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of text) {
    cur += ch
    if (delimiters.includes(ch)) {
      out.push(cur)
      cur = ''
    }
  }
  if (cur) out.push(cur)
  return out
}

/** code point 计数（代理对算 1） */
function cpLen(s: string): number {
  return Array.from(s).length
}
