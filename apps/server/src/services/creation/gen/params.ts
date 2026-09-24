import type { ImageEditRequest } from '../../../adapters/types'
import type { InputPlan, NodeSpec } from '../spec'

// ---------- 纯函数（供探针直接断言） ----------

/** 任务 params 快照（gen_tasks.params JSON） */
export function buildNodeTaskParams(
  spec: NodeSpec,
  opts: { stylePresetIds: number[]; plan: InputPlan },
): Record<string, unknown> {
  return {
    size: spec.size ?? null,
    duration: spec.duration ?? null,
    resolution: spec.resolution ?? null,
    aspectRatio: spec.aspectRatio ?? null,
    useStylePreset: spec.useStylePreset !== false,
    stylePresetIds: opts.stylePresetIds,
    edit: spec.edit
      ? { mode: spec.edit.mode, maskAssetId: spec.edit.maskAssetId ?? null, expand: spec.edit.expand ?? null }
      : null,
    input: {
      referenceAssetIds: opts.plan.referenceAssetIds,
      firstFrameAssetId: opts.plan.firstFrameAssetId,
      lastFrameAssetId: opts.plan.lastFrameAssetId,
      sourceAssetId: opts.plan.sourceAssetId,
    },
  }
}

/** 任务 params 扩展（buildNodeTaskParams 字段快照保持不变——probe-m16 精确断言）：audio 附加 voice/speed；compose 附加 fps（ 仅显式含转场/BGM 字段时附加新键——旧形态输出不变，probe-m17 快照兼容） */
export function extendTaskParams(params: Record<string, unknown>, spec: NodeSpec): Record<string, unknown> {
  if (spec.genKind === 'audio') return { ...params, voice: spec.voice ?? null, speed: spec.speed ?? null }
  if (spec.genKind === 'compose') {
    const out: Record<string, unknown> = { ...params, fps: spec.fps ?? null }
    if (
      spec.transition !== undefined ||
      spec.transitionDuration !== undefined ||
      spec.bgmAssetId !== undefined ||
      spec.bgmVolume !== undefined ||
      spec.bgmFade !== undefined
    ) {
      out['transition'] = spec.transition ?? 'none'
      out['transitionDuration'] = spec.transitionDuration ?? null
      out['bgmAssetId'] = spec.bgmAssetId ?? null
      out['bgmVolume'] = spec.bgmVolume ?? null
      out['bgmFade'] = spec.bgmFade ?? null
    }
    return out
  }
  return params
}

/** 编辑请求构造（纯部分：spec + 媒体 URI → 请求字段；baseUrl/apiKey 由调用方注入） */
export function buildEditParams(
  spec: NodeSpec,
  media: { baseImage: string; mask?: string },
): Pick<ImageEditRequest, 'mode' | 'baseImage' | 'mask' | 'prompt' | 'expand' | 'size'> {
  const edit = spec.edit
  if (!edit) throw new Error('spec.edit 缺失（非编辑节点）')
  const out: Pick<ImageEditRequest, 'mode' | 'baseImage' | 'mask' | 'prompt' | 'expand' | 'size'> = {
    mode: edit.mode,
    baseImage: media.baseImage,
  }
  if (edit.mode === 'inpaint' || edit.mode === 'erase') {
    if (!media.mask) throw new Error('编辑模式缺少蒙版（inpaint/erase 需 mask）')
    out.mask = media.mask
  }
  if (spec.prompt.trim()) out.prompt = spec.prompt.trim()
  if (edit.expand) out.expand = edit.expand
  if (spec.size) out.size = spec.size
  return out
}

/** 风格尾追（单值版，对齐 ai_image injectStyleAnchor 的「视觉风格：…」格式） */
export function appendStyleSnippet(prompt: string, snippet: string | null): string {
  const s = typeof snippet === 'string' ? snippet.trim() : ''
  const base = prompt.trim()
  if (!s) return base
  return base ? `${base}\n视觉风格：${s}` : `视觉风格：${s}`
}

/** 合成输出尺寸（WxH，偶数） */
export interface ComposeSize {
  width: number
  height: number
}

/** resolution 解析（格式 WxH，对齐 ffmpeg-merge 约定；libx264 yuv420p 要求宽高为正偶数） */
export function parseResolution(res: string): ComposeSize {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(res.trim())
  if (!m) throw new Error(`resolution 非法: ${res}（需 WxH 如 1080x1920）`)
  const width = Number(m[1])
  const height = Number(m[2])
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error(`resolution 非法: ${res}（宽高需为正偶数）`)
  return { width, height }
}
