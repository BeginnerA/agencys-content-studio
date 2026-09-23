import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Asset } from '../../db/schema'
import { assetToDataUri } from '../../services/asset-ref'
import { resolveFfmpeg } from '../../services/ffmpeg'
import { chatCompleteDetailed, loadPromptTemplate, resolveLlmEndpoint, type ChatContentPart, type LlmUsage } from '../../services/llm'
import { absPathOf, writeTextAsset } from '../../services/storage'
import { recordLlmUsage } from '../../services/usage'
import type { StepContext } from '../context'
import { StepError, type StepResult } from '../types'

// 图片反推 image_analyze action（video-reverse 同源链的图片形态）。
// 流程：图片资产（kind=image，可多张）→ ffmpeg 等比缩宽 ≤1280 临时 jpg（失败回退原图内联 ≤8MB，超限跳图）
//       → 多模态 LLM 逐图反推（主体/风格/构图/光线/色板 + 可投产 image_prompt/negative_prompt）
//       → parseImageReverseJson 契约 → 落 图片反推.json + 图片反推报告.md 双资产（purpose=image_analysis）。
// 原图只读不改；缩放产物为临时目录不落库（对齐 video_analyze 帧不落资产口径）。

export const IMAGE_COUNT_RANGE = { min: 1, max: 12, default: 8 } as const

/** 分析图缩宽（多模态请求体控制；比视频帧 768 更宽——单图细节即输入本体） */
export const ANALYSIS_IMAGE_WIDTH = 1280

export interface ImageReverseItem {
  index: number
  file: string
  subject: string
  scene: string
  style: string
  composition: string
  lighting: string
  palette: string[]
  mood: string
  camera: string
  text_in_image: string
  image_prompt: string
  negative_prompt: string
}

function extractJsonObject(content: string): string {
  const s = content.indexOf('{')
  const e = content.lastIndexOf('}')
  if (s < 0 || e <= s) throw new Error(`未找到 JSON 对象。开头 200 字符：${content.slice(0, 200)}`)
  return content.slice(s, e + 1)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** params.max_images 解析（纯函数探针直测）：非法 → 默认 8；越界 → clamp 1–12 */
export function clampImageCount(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : IMAGE_COUNT_RANGE.default
  return Math.min(IMAGE_COUNT_RANGE.max, Math.max(IMAGE_COUNT_RANGE.min, n))
}

/**
 * 反推 JSON 归一（纯函数，探针直测）：非法结构 → null。宽容规则：
 * - images 非数组或无有效项 → null；
 * - index 非正数 → 按位置 1 起；file 仅保留非空字符串（缺省由 action 按序回填原名）；
 * - image_prompt 空 → 该项丢弃（产物核心字段，无一则整图无价值）；
 * - palette 仅保留非空字符串项（最多 8 个）；其余字符串字段缺省归 ''。
 */
export function parseImageReverseJson(content: string): ImageReverseItem[] | null {
  let obj: unknown
  try {
    obj = JSON.parse(extractJsonObject(content))
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const rawImages = (obj as Record<string, unknown>).images
  if (!Array.isArray(rawImages)) return null
  const items: ImageReverseItem[] = []
  rawImages.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return
    const r = raw as Record<string, unknown>
    const imagePrompt = str(r.image_prompt)
    if (!imagePrompt) return
    const idx = typeof r.index === 'number' && Number.isFinite(r.index) && r.index > 0 ? Math.round(r.index) : i + 1
    const palette = Array.isArray(r.palette) ? r.palette.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()).slice(0, 8) : []
    items.push({
      index: idx,
      file: str(r.file),
      subject: str(r.subject),
      scene: str(r.scene),
      style: str(r.style),
      composition: str(r.composition),
      lighting: str(r.lighting),
      palette,
      mood: str(r.mood),
      camera: str(r.camera),
      text_in_image: str(r.text_in_image),
      image_prompt: imagePrompt,
      negative_prompt: str(r.negative_prompt),
    })
  })
  return items.length > 0 ? items : null
}

/** 人读 md 报告（纯函数探针直测；机读契约在 json 资产） */
export function renderImageReverseReportMd(items: ImageReverseItem[], meta: { included: number; width: number }): string {
  const sections = items.map((it) => {
    const lines = [
      `## 图 ${it.index}：${it.file || '（未命名）'}`,
      '',
      `- 主体：${it.subject || '—'}${it.scene ? ` ｜ 场景：${it.scene}` : ''}`,
      `- 风格：${it.style || '—'}${it.mood ? ` ｜ 情绪：${it.mood}` : ''}`,
      `- 构图：${it.composition || '—'}${it.camera ? ` ｜ 镜头：${it.camera}` : ''}`,
      `- 光线：${it.lighting || '—'}${it.palette.length ? ` ｜ 主色板：${it.palette.join(' / ')}` : ''}`,
      ...(it.text_in_image ? [`- 画面内文字：${it.text_in_image}`] : []),
      '',
      `- **生成提示词**：\`${it.image_prompt}\``,
      `- **负向提示词**：${it.negative_prompt ? `\`${it.negative_prompt}\`` : '—'}`,
    ]
    return lines.join('\n')
  })
  return [
    '# 图片反推报告',
    '',
    `- 解析图片 ${meta.included} 张（等比缩宽 ≤${meta.width}px 临时编码，原图只读不改）· 有效反推 ${items.length} 条`,
    '',
    ...sections.flatMap((s) => [s, '']),
    '> 机读反推结果见同名 json 资产（image_analysis），image_prompt 可直接投产文生图/图文链。',
  ].join('\n')
}

/** ffmpeg 一次性缩放编码（纯同步、超时强杀；失败返回 null 由调用方回退原图内联） */
function toScaledJpegDataUri(ffmpeg: string, srcAbs: string, outPath: string): string | null {
  try {
    const r = spawnSync(
      ffmpeg,
      [
        '-y', '-hide_banner', '-loglevel', 'error', '-i', srcAbs,
        '-vf', `scale=${ANALYSIS_IMAGE_WIDTH}:${ANALYSIS_IMAGE_WIDTH}:force_original_aspect_ratio=decrease`,
        '-frames:v', '1', '-q:v', '3', outPath,
      ],
      { timeout: 60_000, windowsHide: true },
    )
    if (r.error || r.status !== 0 || !existsSync(outPath)) return null
    return `data:image/jpeg;base64,${readFileSync(outPath).toString('base64')}`
  } catch {
    return null
  }
}

export async function imageAnalyze(ctx: StepContext): Promise<StepResult> {
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const maxImages = clampImageCount(params['max_images'])
  // —— 1. 图片源资产（kind=image 且本地文件存在，按上传顺序；与 video_analyze 输入契约同构） ——
  const imageIds = ctx.assetIdsOf('images')
  if (imageIds.length === 0) throw new StepError('image_analyze：inputs.images 无图片资产')
  const rows = await ctx.assetsOf(imageIds)
  const all = rows.filter((a) => a.kind === 'image' && a.relPath && existsSync(absPathOf(a.relPath)))
  if (all.length === 0) throw new StepError('image_analyze：inputs.images 无可用图片资产（非图片 / 文件缺失）')
  const selected = all.slice(0, maxImages)
  if (all.length > selected.length) ctx.log(`图片 ${all.length} 张超上限 ${maxImages}，仅解析前 ${maxImages} 张（其余跳过）`)

  // —— 2. 逐图编码（缩放 jpeg 优先，失败回退原图内联；单图失败跳过不拖垮整体） ——
  const tmp = mkdtempSync(join(tmpdir(), 'acs-img-'))
  const parts: ChatContentPart[] = [
    {
      type: 'text',
      text: `用户共提供 ${selected.length} 张参考图（按序编号，每张前标注序号与原文件名）。请对每张图反推可直接复用的生成提示词。`,
    },
  ]
  const includedAssets: Asset[] = []
  try {
    const ffmpeg = resolveFfmpeg()
    for (const a of selected) {
      let uri: string | null = null
      try {
        if (ffmpeg) uri = toScaledJpegDataUri(ffmpeg, absPathOf(a.relPath!), join(tmp, `analyze-${a.id}.jpg`))
        if (!uri) {
          if (ffmpeg && includedAssets.length === 0) ctx.log('图片缩放编码失败 → 回退原图内联（≤8MB，超限跳图）')
          uri = await assetToDataUri(a.id)
        }
      } catch (err) {
        ctx.log(`图「${a.name}」编码失败跳过：${(err as Error).message}`)
        continue
      }
      parts.push({ type: 'text', text: `图 ${includedAssets.length + 1}/${selected.length}：${a.name}` })
      parts.push({ type: 'image_url', image_url: { url: uri } })
      includedAssets.push(a)
    }
    if (includedAssets.length === 0) throw new StepError('image_analyze：全部图片编码/读取失败（无可用图）')
    parts.push({ type: 'text', text: '请按提示词契约输出反推 JSON（images 数组，每张一项，含 image_prompt / negative_prompt），只依据图中真实可见内容。' })

    // —— 3. 多模态 LLM（端点解析与用量记录口径同 video_analyze） ——
    const ep = await resolveLlmEndpoint()
    ctx.log(`调用多模态 LLM：${ep.model}（${includedAssets.length} 图）…`)
    const res = await chatCompleteDetailed(
      [
        { role: 'system', content: loadPromptTemplate('image-analyze.md') },
        { role: 'user', content: parts },
      ],
      ep,
      { temperature: 0.2, maxTokens: 16000, timeoutMs: 600_000 },
    )
    await recordLlmUsage({ projectId: ctx.run.projectId, runId: ctx.run.id, stepId: ctx.step.id, provider: res.provider, model: res.model, usage: res.usage })

    // —— 4. 契约解析 + 文件名按序回填（模型不改写原名，缺失兜底） ——
    const items = parseImageReverseJson(res.content)
    if (!items) throw new StepError(`image_analyze：反推输出不合契约。开头 200 字符：${res.content.slice(0, 200)}`)
    items.forEach((it, i) => {
      if (!it.file) it.file = includedAssets[Math.min(i, includedAssets.length - 1)]?.name ?? ''
    })

    // —— 5. 落库：json 在前（反推步骤 .asset 引用锚）+ md 人读报告 ——
    const jsonAsset = await writeTextAsset(ctx.run.projectId, {
      name: '图片反推.json',
      content: JSON.stringify({ images: items }, null, 2),
      purpose: 'image_analysis',
      stepId: ctx.step.id,
      runId: ctx.run.id,
      params: { images_included: includedAssets.length, width: ANALYSIS_IMAGE_WIDTH, report: false },
      tags: ['image_analysis'],
    })
    const mdAsset = await writeTextAsset(ctx.run.projectId, {
      name: '图片反推报告.md',
      content: renderImageReverseReportMd(items, { included: includedAssets.length, width: ANALYSIS_IMAGE_WIDTH }),
      purpose: 'image_analysis',
      stepId: ctx.step.id,
      runId: ctx.run.id,
      params: { images_included: includedAssets.length, width: ANALYSIS_IMAGE_WIDTH, report: true },
      tags: ['image_analysis'],
    })
    ctx.log(`反推完成：${includedAssets.length} 图 → ${items.length} 条提示词（json asset#${jsonAsset.id} + md #${mdAsset.id}）`)
    return { assetIds: [jsonAsset.id, mdAsset.id] }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
