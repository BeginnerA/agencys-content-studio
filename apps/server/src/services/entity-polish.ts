import type { CharacterRow } from '../db/schema'
import { chatCompleteDetailed, loadPromptTemplate, type LlmUsage } from './llm'

/**
 * 素材档案批量润色服务（对齐 Toonflow polishAssetsPrompt 语义）：
 * 单实体 appearance 润色规范化（补视觉指纹 / 短语化 / 统一语感），只更新 appearance；
 * 输出解析宽容（剥围栏 / 去包裹引号 / 取最长非空段）；
 * 调用失败/输出为空 → 不写库（由路由层逐项收集 failed，不阻断其余项）。
 */

/** 润色输出清洗（供探针直接 import 断言）：剥 markdown 围栏与包裹引号 → 取最长非空段 → trim */
export function parsePolishOutput(raw: string): string {
  let text = raw.replace(/```[a-z]*\r?\n?/gi, '').replace(/```/g, '').trim()
  // 模型偶发用引号包裹整段 → 剥离成对的中英文引号
  if (text.length >= 2 && /^["'“”‘’]/.test(text) && /["'“”‘’]$/.test(text)) text = text.slice(1, -1).trim()
  // 取最长非空段（正文通常最长；防模型附带「以下是润色结果：」类引导语）
  const paras = text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (paras.length <= 1) return paras[0] ?? ''
  return paras.reduce((a, b) => (b.length > a.length ? b : a))
}

/** 单实体 appearance 润色（LLM 调用 + 用量返回）；调用方判空后落库 */
export async function polishAppearance(
  row: CharacterRow,
): Promise<{ appearance: string; provider: string; model: string; usage: LlmUsage | null }> {
  const system = loadPromptTemplate('entity-polish.md')
  const user = JSON.stringify({
    kind: row.kind,
    name: row.name,
    aliases: safeStrArr(row.aliases),
    appearance: row.appearance,
    summary: row.summary,
    negative: row.negative,
  })
  const result = await chatCompleteDetailed(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    undefined,
    { temperature: 0.5, maxTokens: 800, timeoutMs: 60_000 },
  )
  return { appearance: parsePolishOutput(result.content), provider: result.provider, model: result.model, usage: result.usage }
}

function safeStrArr(s: string): string[] {
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
