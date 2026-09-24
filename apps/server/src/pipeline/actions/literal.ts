import { writeTextAsset } from '../../services/storage'
import { interpolate, normalizePositiveIds } from '../refs'
import type { StepContext } from '../context'
import type { StepResult } from '../types'

/**
 * literal：零 LLM 纯写文本资产（画布 → 模板 v2 桥接件）。
 * inputs.text：字符串（input.x 文本或引用串）或资产 id（number / [number]，读全文）；
 * params.payload：字面文本（inputs.text 缺省/空时回落）；
 * params.as：'raw'（默认）| 'storyboard-single'（包成 ai-image 可解析的单镜 shots JSON）
 *   | 'lines-single'（包成 tts 可解析的单句 lines JSON）；
 * params.name_tpl：文件名模板（{input.x} 内插，缺省 `${stepKey}.txt` / `.json`）；
 * params.output_purpose：资产 purpose（缺省 'text'）。
 * inputs.refs（资产 id 数组）与 inputs.first_frame（首个）：仅 storyboard-single 生效，
 * 注入单镜 ref_asset_ids / first_frame_asset_id（画布参考边保真直通）。
 * 产物：1 个文本资产（stepId 归属），供下游 ai_image.inputs.shots / tts.inputs.lines / ai_text.inputs 消费。
 */
export async function literal(ctx: StepContext): Promise<StepResult> {
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const as = typeof params['as'] === 'string' ? (params['as'] as string) : 'raw'
  if (!['raw', 'storyboard-single', 'lines-single'].includes(as)) {
    throw new Error(`params.as 非法（raw|storyboard-single|lines-single）：${as}`)
  }
  const purpose = typeof params['output_purpose'] === 'string' && params['output_purpose']
    ? (params['output_purpose'] as string)
    : 'text'

  // 1) inputs.text 消费：字符串（input.x 文本 / 引用字面量）或资产 id（读全文）
  let text = await resolveTextInput(ctx, 'text')
  // 2) params.payload 兜底（字面）
  if (!text) {
    const p = params['payload']
    if (typeof p === 'string' && p.trim()) text = p
  }
  if (!text || !text.trim()) throw new Error('literal 缺文本内容（inputs.text 或 params.payload 至少其一非空）')

  // 3) as 转换
  // refs / first_frame 直通仅 storyboard-single 生效；其他形态忽略（存在输入时提示）
  if (as !== 'storyboard-single' && (ctx.input['refs'] !== undefined || ctx.input['first_frame'] !== undefined)) {
    ctx.log(`inputs.refs / inputs.first_frame 仅 as=storyboard-single 生效，当前 as=${as} 已忽略`)
  }
  let content: string
  let format: string | undefined
  let defaultExt: string
  if (as === 'storyboard-single') {
    const shot: Record<string, unknown> = { id: 's1', image_prompt: text.trim() }
    const refs = normalizePositiveIds(ctx.input['refs'])
    if (refs.length > 0) shot['ref_asset_ids'] = refs
    const ff = normalizePositiveIds(ctx.input['first_frame'])[0]
    if (ff !== undefined) shot['first_frame_asset_id'] = ff
    content = JSON.stringify({ shots: [shot] }, null, 2)
    format = 'storyboard-json'
    defaultExt = 'json'
  } else if (as === 'lines-single') {
    const payload = { lines: [{ id: 'l1', text: text.trim() }] }
    content = JSON.stringify(payload, null, 2)
    format = 'lines-json'
    defaultExt = 'json'
  } else {
    content = text
    defaultExt = 'txt'
  }

  // 4) 文件名（name_tpl 内插；缺省走 step key）
  const runInput = JSON.parse(ctx.run.input) as Record<string, unknown>
  const nameTpl = typeof params['name_tpl'] === 'string' && params['name_tpl'] ? (params['name_tpl'] as string) : null
  const name = nameTpl ? interpolate(nameTpl, runInput) : `${ctx.def.key}.${defaultExt}`

  const asset = await writeTextAsset(ctx.run.projectId, {
    name,
    content,
    purpose,
    format,
    stepId: ctx.step.id,
    runId: ctx.run.id,
    tags: ['literal', as],
  })
  ctx.log(`literal 已写资产 asset#${asset.id}（as=${as}，${content.length} 字符）`)
  return { assetIds: [asset.id] }
}

/** inputs.text 归一化：字符串直取；数字/数字数组视为资产 id → 读文本；空值返回 null */
async function resolveTextInput(ctx: StepContext, key: string): Promise<string | null> {
  const v = ctx.input[key]
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) {
    try {
      return await ctx.readText(v)
    } catch {
      return null
    }
  }
  if (Array.isArray(v)) {
    const first = v[0]
    if (typeof first === 'number' && Number.isInteger(first) && first > 0) {
      try {
        return await ctx.readText(first)
      } catch {
        return null
      }
    }
    if (typeof first === 'string') return first as string
  }
  return null
}
