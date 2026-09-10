import { loadPromptTemplate, chatCompleteDetailed, resolveLlmEndpoint } from '../../services/llm'
import { isJsonTextFormat, readTextAsset, writeTextAsset } from '../../services/storage'
import { recordLlmUsage } from '../../services/usage'
import type { StepContext } from '../context'
import { interpolate } from '../refs'
import type { StepResult } from '../types'

/**
 * ai_text：LLM 文本生成（spec §5.3）。
 * params.prompt_tpl → 提示词模板；inputs 中资产内容/文本注入；
 * output_format=storyboard-json/lines-json/characters-json 时走 validateTextOutput 契约校验
 * （shots / lines（v2 含 speaker/voice_hint/emotion_hint）/ characters 数组）。
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
  const res = await chatCompleteDetailed(
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
  // [M4] 用量记录（LLM 单次调用 → tokens_in/out 两行；失败不影响流水线）
  await recordLlmUsage({ projectId: ctx.run.projectId, runId: ctx.run.id, stepId: ctx.step.id,
    provider: res.provider, model: res.model, usage: res.usage })
  const content = res.content
  ctx.log(`LLM 返回 ${content.length} 字符`)

  // 输出契约校验（storyboard-json / lines-json / characters-json；返回条目数供日志）
  const items = validateTextOutput(content, outputFormat)
  if (outputFormat === 'storyboard-json') ctx.log(`分镜解析通过：${items} 个镜头`)
  if (outputFormat === 'lines-json') ctx.log(`台词解析通过：${items} 句`)
  if (outputFormat === 'characters-json') ctx.log(`角色档案解析通过：${items} 名`)

  const nameTpl = typeof params['name_tpl'] === 'string' ? params['name_tpl'] : undefined
  const name = nameTpl ? interpolate(nameTpl, runInput) : defaultName(outputFormat, outputPurpose)
  const tag = outputFormat === 'storyboard-json' ? 'storyboard' : outputFormat === 'lines-json' ? 'lines' : outputFormat === 'characters-json' ? 'characters' : 'script'
  const asset = await writeTextAsset(ctx.run.projectId, {
    name,
    content,
    purpose: outputPurpose,
    format: isJsonTextFormat(outputFormat) ? outputFormat : undefined,
    stepId: ctx.step.id,
    runId: ctx.run.id,
    prompt: userPrompt.slice(0, 4000),
    params: { model: ep.model, output_format: outputFormat, chars: content.length },
    tags: [tag],
  })
  ctx.log(`已写资产 asset#${asset.id} → ${asset.relPath}`)
  return { assetIds: [asset.id] }
}

/**
 * 输出契约校验（导出供探针直接断言，无需 LLM）：
 * storyboard-json（shots 数组 + image_prompt）/ lines-json（lines 数组 + text/est_ms + v2 speaker/voice_hint/emotion_hint）
 * / characters-json（characters 数组 + name/appearance + 可选 aliases/summary/negative/voice/ref_prompt）；
 * 返回条目数（非校验格式 → 0）；错误消息口径与 M1/M2 一致。
 */
export function validateTextOutput(content: string, format: string): number {
  if (format === 'storyboard-json') {
    const obj = JSON.parse(extractJson(content)) as { shots?: unknown }
    if (!Array.isArray(obj.shots) || obj.shots.length === 0) {
      throw new Error(`分镜 JSON 不合法（缺 shots 数组）。返回开头 200 字符：${content.slice(0, 200)}`)
    }
    for (const shot of obj.shots as Array<Record<string, unknown>>) {
      if (typeof shot['image_prompt'] !== 'string' || !shot['image_prompt']) {
        throw new Error(`分镜 JSON 不合法：shot ${String(shot['id'] ?? '?')} 缺 image_prompt`)
      }
    }
    return obj.shots.length
  }
  if (format === 'lines-json') {
    const obj = JSON.parse(extractJson(content)) as { lines?: unknown }
    if (!Array.isArray(obj.lines) || obj.lines.length === 0) {
      throw new Error(`台词 JSON 不合法（缺 lines 数组）。返回开头 200 字符：${content.slice(0, 200)}`)
    }
    for (const rec of obj.lines as Array<Record<string, unknown>>) {
      if (typeof rec['text'] !== 'string' || !String(rec['text']).trim()) {
        throw new Error(`台词 JSON 不合法：句 ${String(rec['id'] ?? '?')} 缺 text`)
      }
      if (rec['est_ms'] !== undefined && (typeof rec['est_ms'] !== 'number' || rec['est_ms'] <= 0)) {
        throw new Error(`台词 JSON 不合法：句 ${String(rec['id'] ?? '?')} 的 est_ms 需为正数`)
      }
      // v2 可选台词字段（tts 声线/情绪链；存在时必须为非空字符串）
      for (const key of ['speaker', 'voice_hint', 'emotion_hint']) {
        const v = rec[key]
        if (v !== undefined && (typeof v !== 'string' || !v.trim())) {
          throw new Error(`台词 JSON 不合法：句 ${String(rec['id'] ?? '?')} 的 ${key} 需为非空字符串`)
        }
      }
    }
    return obj.lines.length
  }
  if (format === 'characters-json') {
    const obj = JSON.parse(extractJson(content)) as { characters?: unknown }
    if (!Array.isArray(obj.characters) || obj.characters.length === 0) {
      throw new Error(`角色档案 JSON 不合法（缺 characters 数组）。返回开头 200 字符：${content.slice(0, 200)}`)
    }
    for (const rec of obj.characters as Array<Record<string, unknown>>) {
      if (typeof rec['name'] !== 'string' || !rec['name'].trim()) {
        throw new Error('角色档案 JSON 不合法：存在缺 name 的角色项')
      }
      const who = rec['name']
      if (typeof rec['appearance'] !== 'string' || !rec['appearance'].trim()) {
        throw new Error(`角色档案 JSON 不合法：角色 ${who} 缺 appearance`)
      }
      const aliases = rec['aliases']
      if (aliases !== undefined && (!Array.isArray(aliases) || aliases.some((x: unknown) => typeof x !== 'string' || !x.trim()))) {
        throw new Error(`角色档案 JSON 不合法：角色 ${who} 的 aliases 需为非空字符串数组`)
      }
      for (const key of ['summary', 'negative', 'voice']) {
        if (rec[key] !== undefined && typeof rec[key] !== 'string') {
          throw new Error(`角色档案 JSON 不合法：角色 ${who} 的 ${key} 需为字符串`)
        }
      }
      if (
        rec['ref_prompt'] !== undefined &&
        !(typeof rec['ref_prompt'] === 'string' || (Array.isArray(rec['ref_prompt']) && rec['ref_prompt'].every((x: unknown) => typeof x === 'string')))
      ) {
        throw new Error(`角色档案 JSON 不合法：角色 ${who} 的 ref_prompt 需为字符串或字符串数组`)
      }
    }
    return obj.characters.length
  }
  return 0
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
  if (format === 'lines-json') return 'lines.json'
  if (format === 'characters-json') return 'characters.json'
  return `${purpose}.md`
}