import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeMediaDuration, resolveFfmpeg } from '../../services/ffmpeg'
import { resolveAsrEndpoint, transcribeAudio, type AsrResult } from '../../services/asr'
import { extractVideoFrame } from '../../services/creation/gen/frame'
import { chatCompleteDetailed, loadPromptTemplate, resolveLlmEndpoint, type ChatContentPart, type LlmUsage } from '../../services/llm'
import { absPathOf, writeTextAsset } from '../../services/storage'
import { recordLlmUsage } from '../../services/usage'
import type { StepContext } from '../context'
import { StepError, type StepResult } from '../types'

// video_analyze 视频解析 action（spec §2.9，批 3 全接线；用户拍板「全链含音频转写」）。
// 流程：ffprobe 时长 → 均匀抽帧（临时目录，帧不落资产）→ ffmpeg 抽音轨 → ASR（宽容降级 null）
//       → 多模态 LLM 时间轴 → parseTimelineJson 契约 → 落 video_analysis json + md 报告。
// 独立帧数常量：不动画布 UNIFORM_FRAME_COUNT_RANGE（2–9），视频解析上限更宽（2–24）。

export const VIDEO_FRAME_COUNT_RANGE = { min: 2, max: 24, default: 8 } as const

/** 分析帧缩宽（spec §5：768 缩宽再编码，控多模态请求体；对齐抽帧 scale 参数化） */
export const ANALYSIS_FRAME_WIDTH = 768

export interface TimelineScene {
  t0: number
  t1: number
  visual: string
  shot_type?: string
  speech?: string
}

export interface TimelineTranscriptSeg {
  t0: number
  t1: number
  text: string
}

export interface VideoTimeline {
  duration: number
  scenes: TimelineScene[]
  transcript?: TimelineTranscriptSeg[] | null
}

function extractJsonObject(content: string): string {
  const s = content.indexOf('{')
  const e = content.lastIndexOf('}')
  if (s < 0 || e <= s) throw new Error(`未找到 JSON 对象。开头 200 字符：${content.slice(0, 200)}`)
  return content.slice(s, e + 1)
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * 时间轴归一（纯函数，探针直测）：非法结构 → null。宽容规则：
 * - duration 非数 → 0；
 * - scenes 逐项：t0/t1 缺省 0，visual 非字符串转 ''，visual 空且 t 区间退化（t1<=t0）→ 丢弃；
 * - shot_type/speech 仅保留非空字符串；
 * - transcript 非数组 → null；逐项 text 空丢弃，t 缺省沿用 0，按 t0 升序。
 */
export function parseTimelineJson(content: string): VideoTimeline | null {
  let obj: unknown
  try {
    obj = JSON.parse(extractJsonObject(content))
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const raw = obj as Record<string, unknown>
  const duration = Math.max(0, numOr(raw.duration, 0))
  const rawScenes = Array.isArray(raw.scenes) ? raw.scenes : null
  if (!rawScenes) return null
  const scenes: TimelineScene[] = []
  for (const item of rawScenes as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object') continue
    const t0 = numOr(item.t0, 0)
    const t1 = numOr(item.t1, 0)
    const visual = typeof item.visual === 'string' ? item.visual.trim() : ''
    if (!visual && t1 <= t0) continue
    const scene: TimelineScene = { t0, t1, visual }
    if (typeof item.shot_type === 'string' && item.shot_type.trim()) scene.shot_type = item.shot_type.trim()
    if (typeof item.speech === 'string' && item.speech.trim()) scene.speech = item.speech.trim()
    scenes.push(scene)
  }
  scenes.sort((a, b) => a.t0 - b.t0)
  const out: VideoTimeline = { duration, scenes }
  const rawTr = Array.isArray(raw.transcript) ? raw.transcript : null
  if (rawTr) {
    const transcript: TimelineTranscriptSeg[] = []
    for (const item of rawTr as Array<Record<string, unknown>>) {
      if (!item || typeof item !== 'object') continue
      const text = typeof item.text === 'string' ? item.text.trim() : ''
      if (!text) continue
      transcript.push({ t0: numOr(item.t0, 0), t1: numOr(item.t1, 0), text })
    }
    transcript.sort((a, b) => a.t0 - b.t0)
    out.transcript = transcript.length > 0 ? transcript : null
  } else {
    out.transcript = null
  }
  return out
}

/** params.frames 解析（纯函数探针直测）：非法 → 默认 8；越界 → clamp 2–24（边界放宽断言锚） */
export function clampFrameCount(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : VIDEO_FRAME_COUNT_RANGE.default
  return Math.min(VIDEO_FRAME_COUNT_RANGE.max, Math.max(VIDEO_FRAME_COUNT_RANGE.min, n))
}

/**
 * 均匀抽帧时刻（纯函数探针直测）：公式与画布 frameTimesOf('uniform') 同构
 * （t_i = round3(0.1 + (dur − 0.2) × i/(n−1))）；dur ≤ 0.3s 全取首帧时刻；dur 非法抛错。
 */
export function uniformVideoTimes(count: number, duration: number): number[] {
  const n = clampFrameCount(count)
  if (!(duration > 0)) throw new Error(`uniformVideoTimes 需要正时长（秒）：${String(duration)}`)
  const round = (v: number): number => Math.round(v * 1000) / 1000
  if (duration <= 0.3) {
    const t = round(Math.min(0.1, duration / 2))
    return Array.from({ length: n }, () => t)
  }
  return Array.from({ length: n }, (_, i) => round(0.1 + (duration - 0.2) * (i / (n - 1))))
}

/** 抽音轨 argv（16k 单声道 mp3，ASR 通用入参形态；纯函数探针直测） */
export function buildAudioExtractArgs(src: string, out: string): string[] {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', out]
}

/** 人读 md 摘要（纯函数探针直测；机读契约在 json 资产） */
export function renderAnalysisReportMd(tl: VideoTimeline, meta: { sourceName: string; frames: number; transcribed: boolean }): string {
  const rows = tl.scenes
    .map((s) => `| ${s.t0.toFixed(1)} | ${s.t1.toFixed(1)} | ${s.shot_type ?? '—'} | ${s.visual.replace(/\|/g, '＼|') || '—'} | ${(s.speech ?? '—').replace(/\|/g, '＼|')} |`)
    .join('\n')
  const tr = (tl.transcript ?? []).map((x) => `- [${x.t0.toFixed(1)}–${x.t1.toFixed(1)}] ${x.text}`).join('\n')
  return [
    `# 视频解析报告：${meta.sourceName}`,
    '',
    `- 时长 ${tl.duration.toFixed(1)}s · 场景 ${tl.scenes.length} 段 · 抽帧 ${meta.frames} 帧（临时不落库）· 音轨转写：${meta.transcribed ? '有' : '无（降级或无人声）'}`,
    '',
    '## 时间轴',
    '',
    '| 起(s) | 止(s) | 景别 | 画面 | 声音 |',
    '|---|---|---|---|---|',
    rows || '| — | — | — | 未产出场景 | — |',
    '',
    ...(tr ? ['## 音轨转写', '', tr, ''].filter((x) => x !== undefined) : []),
    '> 机读时间轴见同名 json 资产（video_analysis）。',
  ].join('\n')
}

/** 简易 ffmpeg 一次性执行（音轨抽取等；超时强杀） */
async function runFfmpeg(args: string[], timeoutMs = 120_000): Promise<void> {
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) throw new Error('未找到可用 ffmpeg（内置二进制与系统 PATH 均不可用）')
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let tail = ''
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error('ffmpeg 执行超时'))
    }, timeoutMs)
    const child = spawn(ffmpeg, args, { windowsHide: true })
    child.stderr?.on('data', (buf: Buffer) => {
      tail = (tail + buf.toString('utf8')).slice(-500)
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exit=${code}：${tail.split(/\r?\n/).filter(Boolean).slice(-2).join(' | ') || '(无输出)'}`))
    })
  })
}

export interface VideoAnalysisOutcome {
  tl: VideoTimeline
  frames: number
  transcribed: boolean
  asrProvider?: string
  asrModel?: string
}

/**
 * 可复用视频分析核心（探帧 + ASR + 多模态时间轴）：video_analyze 步骤与对话规划前参考视频摘要共用，
 * 不另建引擎。帧临时目录不落库；时长以探测为准；ASR 命中⇒兼容内嵌兼底 transcript（与步骤历史行为一致）。
 * 纯分析不写资产；资产落库由调用方（步骤 action）负责。
 */
export async function analyzeVideoSource(args: {
  srcAbs: string
  name: string
  durationHint?: number | null
  frames?: unknown
  transcribe?: unknown
  log: (message: string) => void
  onUsage?: (u: { provider: string; model: string; usage: LlmUsage | null }) => Promise<void>
}): Promise<VideoAnalysisOutcome> {
  const frames = clampFrameCount(args.frames)
  const transcribe = args.transcribe !== false
  const duration = (typeof args.durationHint === 'number' && args.durationHint > 0 ? args.durationHint : null) ?? probeMediaDuration(args.srcAbs)
  if (!duration || !(duration > 0)) throw new Error(`无法取得视频时长（${args.name}）`)
  args.log(`视频源「${args.name}」时长 ${duration.toFixed(1)}s → 抽帧 ${frames}（宽 ≤${ANALYSIS_FRAME_WIDTH}，临时目录不落库）`)
  const tmp = mkdtempSync(join(tmpdir(), 'acs-m25-'))
  try {
    const times = uniformVideoTimes(frames, duration)
    const frameFiles: Array<{ t: number; path: string }> = []
    for (let i = 0; i < times.length; i++) {
      const p = join(tmp, `frame-${String(i).padStart(2, '0')}.jpg`)
      try {
        await extractVideoFrame(args.srcAbs, p, times[i]!, ANALYSIS_FRAME_WIDTH)
        frameFiles.push({ t: times[i]!, path: p })
      } catch (err) {
        args.log(`帧 @${times[i]}s 抽取失败跳过：${(err as Error).message}`)
      }
    }
    if (frameFiles.length === 0) throw new Error('全部抽帧失败（ffmpeg 可用？源文件损坏？）')

    let asr: AsrResult | null = null
    const asrEp = transcribe ? await resolveAsrEndpoint() : null
    if (transcribe) {
      if (!asrEp) args.log('ASR 端点不可解析（无 OpenAI 兼容 audio 实例）→ 跳过音轨转写')
      else {
        const mp3 = join(tmp, 'audio.mp3')
        try {
          await runFfmpeg(buildAudioExtractArgs(args.srcAbs, mp3))
          asr = await transcribeAudio(mp3, asrEp)
          if (asr) args.log(`音轨转写成功：${asr.text.length} 字${asr.segments ? `（${asr.segments.length} 段）` : ''}`)
          else args.log('音轨转写失败 → 降级为无音轨（server 日志留痕）')
        } catch (err) {
          args.log(`音轨抽取失败 → 降级为无音轨：${(err as Error).message}`)
        }
      }
    }

    const parts: ChatContentPart[] = [
      {
        type: 'text',
        text: `视频总时长 ${duration.toFixed(1)} 秒，共 ${frameFiles.length} 个关键帧（按时间升序，每帧前标注时刻）。${
          asr
            ? `\n\n===== 音轨转写全文 =====\n${asr.text.slice(0, 8000)}${
                asr.segments ? `\n\n===== 转写分段（JSON） =====\n${JSON.stringify(asr.segments).slice(0, 6000)}` : ''
              }`
            : '\n\n（无可用音轨转写：transcript 输出空数组或省略。）'
        }`,
      },
    ]
    frameFiles.forEach((f, i) => {
      parts.push({ type: 'text', text: `帧 ${i + 1}/${frameFiles.length} @ ${f.t}s` })
      parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${readFileSync(f.path).toString('base64')}` } })
    })
    parts.push({ type: 'text', text: '请按提示词契约输出时间轴 JSON（duration / scenes / transcript），时间单位秒。' })

    const ep = await resolveLlmEndpoint()
    args.log(`调用多模态 LLM：${ep.model}（${frameFiles.length} 帧 + ${asr ? '有' : '无'}转写）…`)
    const res = await chatCompleteDetailed(
      [
        { role: 'system', content: loadPromptTemplate('video-analyze.md') },
        { role: 'user', content: parts },
      ],
      ep,
      { temperature: 0.2, maxTokens: 16000, timeoutMs: 600_000 },
    )
    await args.onUsage?.({ provider: res.provider, model: res.model, usage: res.usage })

    const tl = parseTimelineJson(res.content)
    if (!tl) throw new Error(`时间轴输出不合契约。开头 200 字符：${res.content.slice(0, 200)}`)
    tl.duration = Math.round(duration * 10) / 10
    if (!tl.transcript || tl.transcript.length === 0) {
      if (asr?.segments?.length) tl.transcript = asr.segments.map((s) => ({ t0: s.t0, t1: s.t1, text: s.text }))
      else if (asr?.text?.trim()) tl.transcript = [{ t0: 0, t1: tl.duration, text: asr.text.trim() }]
    }
    return { tl, frames: frameFiles.length, transcribed: !!asr, ...(asr && asrEp ? { asrProvider: asrEp.providerKey, asrModel: asrEp.model } : {}) }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** 参考视频→人读摘要（仅取视频内实际可见/可听内容，缺失不编造），供规划上下文注入。 */
export function renderVideoReferenceSummary(out: VideoAnalysisOutcome, sourceName: string): string {
  const tl = out.tl
  const scenes = tl.scenes.slice(0, 12).map((s) => `- [${s.t0.toFixed(1)}–${s.t1.toFixed(1)}s] ${s.visual || s.speech || '（无描述）'}${s.shot_type ? `（${s.shot_type}）` : ''}`)
  const speech = (tl.transcript ?? []).slice(0, 12).map((x) => `- ${x.text}`)
  return [
    `【参考视频解析】${sourceName}（时长 ${tl.duration.toFixed(1)}s，场景 ${tl.scenes.length} 段${out.transcribed ? '，含人声转写' : '，未识别人声'}）`,
    scenes.length ? `画面时间轴：\n${scenes.join('\n')}` : '画面时间轴：（未产出可见场景）',
    speech.length ? `可听内容（转写）：\n${speech.join('\n')}` : '可听内容：（无转写内容）',
  ].join('\n')
}

export async function videoAnalyze(ctx: StepContext): Promise<StepResult> {
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  // —— 1. 视频源资产（首个存在本地文件的视频；spec §2.9 输入契约） ——
  const videoIds = ctx.assetIdsOf('video')
  if (videoIds.length === 0) throw new StepError('video_analyze：inputs.video 无视频资产')
  const rows = await ctx.assetsOf(videoIds)
  const v = rows.find((a) => a.kind === 'video' && a.relPath && existsSync(absPathOf(a.relPath)))
  if (!v || !v.relPath) throw new StepError('video_analyze：inputs.video 无可用视频资产（非视频 / 文件缺失）')
  const out = await analyzeVideoSource({
    srcAbs: absPathOf(v.relPath),
    name: v.name,
    durationHint: typeof v.duration === 'number' && v.duration > 0 ? v.duration : null,
    frames: params['frames'],
    transcribe: params['transcribe'],
    log: (m) => ctx.log(m),
    onUsage: async (u) => { await recordLlmUsage({ projectId: ctx.run.projectId, runId: ctx.run.id, stepId: ctx.step.id, provider: u.provider, model: u.model, usage: u.usage }) },
  })
  const tl = out.tl
  const hasTranscript = !!tl.transcript?.length
  // —— 5. 落库：json 在前（G10 反推步骤 .asset 引用锚）+ md 人读报告 ——
  const analysis = {
    scenes: tl.scenes.length,
    hasTranscript,
    frames: out.frames,
    duration: tl.duration,
    ...(out.asrProvider ? { asr_provider: out.asrProvider, asr_model: out.asrModel } : {}),
  }
  const jsonAsset = await writeTextAsset(ctx.run.projectId, {
    name: `视频时间轴-${v.name}.json`,
    content: JSON.stringify(tl, null, 2),
    purpose: 'video_analysis',
    stepId: ctx.step.id,
    runId: ctx.run.id,
    params: { analysis, frames_kept: false },
    tags: ['video_analysis'],
  })
  const mdAsset = await writeTextAsset(ctx.run.projectId, {
    name: `视频解析报告-${v.name}.md`,
    content: renderAnalysisReportMd(tl, { sourceName: v.name, frames: out.frames, transcribed: out.transcribed }),
    purpose: 'video_analysis',
    stepId: ctx.step.id,
    runId: ctx.run.id,
    params: { analysis, report: true },
    tags: ['video_analysis'],
  })
  ctx.log(`解析完成：${tl.scenes.length} 段场景${hasTranscript ? `、${tl.transcript!.length} 段转写` : '（无音轨）'}（json asset#${jsonAsset.id} + md #${mdAsset.id}）`)
  return { assetIds: [jsonAsset.id, mdAsset.id] }
}
