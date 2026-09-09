import { loadPromptTemplate, chatComplete, resolveLlmEndpoint } from '../../services/llm'
import { readTextAsset, writeTextAsset } from '../../services/storage'
import type { StepContext } from '../context'
import { interpolate } from '../refs'
import type { StepResult } from '../types'

/**
 * ai_text：LLM 文本生成（spec §5.3）。
 * params.prompt_tpl → 提示词模板；inputs 中资产内容/文本注入；
 * output_format=storyboard-json 时强制 JSON 校验（shots 数组）。
 */
export async function aiText(ctx: StepContext): Promise<StepResult> {
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const tplFile = params['prompt_tpl']
  if (typeof tplFile !== 'string' || !tplFile) throw new Error('params.prompt_tpl 缺失')
  const outputPurpose = typeof params['output_purpose'] === 'string' ? params['output_purpose'] : 'text'
  const outputFormat = typeof params['output_format'] === 'string' ? params['output_format'] : 'markdown'
  const runInput = JSON.parse(ctx.run.input) as Record<string, unknown>

  const templateText = loadPromptTemplate(tplFile)
  const sections: string[] = []
  for (const [k, v] of Object.entries(ctx.input)) {
    if (k.startsWith('_')) continue // _review 等内部键不注入
    const ids = asAssetIds(v)
    if (ids && ids.length > 0) {
      const rows = await ctx.assetsOf(ids)
      for (const a of rows) {
        if (a.kind === 'text') {
          const content = await readTextAsset(a.id)
          sections.push(`--- ${k} / ${a.name} ---\n${content}`)
        } else {
          sections.push(`--- ${k} / ${a.name}（${a.kind} 资产：文本模型无法读取，路径 ${a.relPath ?? '?'}）---`)
        }
      }
    } else if (typeof v === 'string') {
      sections.push(`--- ${k} ---\n${v}`)
    } else if (v !== undefined && v !== null) {
      sections.push(`--- ${k} ---\n${JSON.stringify(v, null, 2)}`)
    }
  }
  let userPrompt = templateText
  if (sections.length > 0) {
    userPrompt += `\n\n===== 输入资料 =====\n${sections.join('\n\n')}`
  }
  const review = (ctx.input['_review'] as { note?: string } | undefined)?.note
  if (review) {
    userPrompt += `\n\n===== 人工修改意见（必须逐条落实） =====\n${review}`
    ctx.log('检测到驳回修改意见，已注入本次生成')
  }

  const ep = await resolveLlmEndpoint()
  ctx.log(`调用 LLM：${ep.model}（${ep.baseUrl}）…`)
  const llmCfg = (ctx.settings.llm ?? {}) as Record<string, unknown>
  const content = await chatComplete(
    [
      { role: 'system', content: '你是内容创作流水线的执行引擎，严格按用户提供的提示词模板产出。只输出任务要求的内容本体，不输出任何解释性前言或后记。' },
      { role: 'user', content: userPrompt },
    ],
    ep,
    {
      temperature: typeof llmCfg['temperature'] === 'number' ? llmCfg['temperature'] : 0.8,
      // 默认 12000（deepseek 推理模型 reasoning 占预算）；分镜 JSON 输出长，固定 24000 防推理耗尽正文为空
      maxTokens: outputFormat === 'storyboard-json' ? 24000 : (typeof llmCfg['max_tokens'] === 'number' ? llmCfg['max_tokens'] : 12000),
    },
  )
  ctx.log(`LLM 返回 ${content.length} 字符`)

  // storyboard-json：必须为合法 JSON 且含 shots 数组，否则判失败（错误含摘要供排查）
  if (outputFormat === 'storyboard-json') {
    const json = extractJson(content)
    const obj = JSON.parse(json) as { shots?: unknown }
    if (!Array.isArray(obj.shots) || obj.shots.length === 0) {
      throw new Error(`分镜 JSON 不合法（缺 shots 数组）。返回开头 200 字符：${content.slice(0, 200)}`)
    }
    for (const shot of obj.shots as Array<Record<string, unknown>>) {
      if (typeof shot['image_prompt'] !== 'string' || !shot['image_prompt']) {
        throw new Error(`分镜 JSON 不合法：shot ${String(shot['id'] ?? '?')} 缺 image_prompt`)
      }
    }
    ctx.log(`分镜解析通过：${(obj.shots as unknown[]).length} 个镜头`)
  }

  const nameTpl = typeof params['name_tpl'] === 'string' ? params['name_tpl'] : undefined
  const name = nameTpl ? interpolate(nameTpl, runInput) : defaultName(outputFormat, outputPurpose)
  const asset = await writeTextAsset(ctx.run.projectId, {
    name,
    content,
    purpose: outputPurpose,
    format: outputFormat === 'storyboard-json' ? 'storyboard-json' : undefined,
    stepId: ctx.step.id,
    prompt: userPrompt.slice(0, 4000),
    params: { model: ep.model, output_format: outputFormat, chars: content.length },
    tags: [outputFormat === 'storyboard-json' ? 'storyboard' : 'script'],
  })
  ctx.log(`已写资产 asset#${asset.id} → ${asset.relPath}`)
  return { assetIds: [asset.id] }
}

/** LLM 偶尔输出 markdown 围栏：剥除后取首个 {...} */
function extractJson(raw: string): string {
  const noFence = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim()
  const start = noFence.indexOf('{')
  if (start < 0) throw new Error('LLM 返回中无 JSON 对象')
  return noFence.slice(start)
}

function asAssetIds(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null
  const ids = v.map(Number)
  return ids.every((n) => Number.isInteger(n) && n > 0) ? ids : null
}

function defaultName(format: string, purpose: string): string {
  if (format === 'storyboard-json') return 'storyboard.json'
  return `${purpose}.md`
}