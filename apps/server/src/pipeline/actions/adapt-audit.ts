import { chatCompleteDetailed, loadPromptTemplate, resolveLlmEndpoint } from '../../services/llm'
import { writeTextAsset } from '../../services/storage'
import { recordLlmUsage } from '../../services/usage'
import type { StepContext } from '../context'
import { StepError, type StepResult } from '../types'

// adapt_audit 一致性回查 action（spec §2.5，批 2 接线）。
// 语义：LLM 对照「章节原文 vs 事件/剧本产物」输出忠实度判定；产物 purpose=audit_report。
// 模板 novel-audit.yaml + 提示词 adapt-audit.md 同批落地。

export interface AuditDivergence {
  kind: 'omission' | 'alteration' | 'addition' | 'order'
  severity: 'info' | 'warn' | 'major'
  desc: string
  ref: string
}

export interface AuditVerdict {
  faithful: boolean
  divergences: AuditDivergence[]
}

const DIVERGENCE_KINDS = new Set(['omission', 'alteration', 'addition', 'order'])
const SEVERITIES = new Set(['info', 'warn', 'major'])

/** 从 JSON 对象提取平衡的 {...} 片段（容忍 markdown 围栏/前后闲话；沿 ai-text extractJson 思路独立实现避免循环依赖） */
function extractJsonObject(content: string): string {
  const s = content.indexOf('{')
  const e = content.lastIndexOf('}')
  if (s < 0 || e <= s) throw new Error(`未找到 JSON 对象。开头 200 字符：${content.slice(0, 200)}`)
  return content.slice(s, e + 1)
}

/**
 * 回查判定归一（纯函数，探针直测）：非法结构 → null（调用方按降级处理，不抛错——
 * LLM 输出不可控属预期内失败面）。宽容规则：
 * - faithful 缺省：divergences 无 major 项视为 true；
 * - 非法 kind/severity 条目丢弃；desc/ref 非字符串转 ''，全空条目丢弃。
 */
export function parseAuditVerdict(content: string): AuditVerdict | null {
  let obj: unknown
  try {
    obj = JSON.parse(extractJsonObject(content))
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const raw = obj as Record<string, unknown>
  const list = Array.isArray(raw.divergences) ? raw.divergences : []
  const divergences: AuditDivergence[] = []
  for (const item of list as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object') continue
    const kind = typeof item.kind === 'string' ? item.kind : ''
    const severity = typeof item.severity === 'string' ? item.severity : ''
    if (!DIVERGENCE_KINDS.has(kind) || !SEVERITIES.has(severity)) continue
    const desc = typeof item.desc === 'string' ? item.desc.trim() : ''
    const ref = typeof item.ref === 'string' ? item.ref.trim() : ''
    if (!desc && !ref) continue
    divergences.push({ kind: kind as AuditDivergence['kind'], severity: severity as AuditDivergence['severity'], desc, ref })
  }
  const faithful = typeof raw.faithful === 'boolean' ? raw.faithful : !divergences.some((d) => d.severity === 'major')
  return { faithful, divergences }
}

export async function adaptAudit(ctx: StepContext): Promise<StepResult> {
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const tplFile = typeof params['prompt_tpl'] === 'string' && params['prompt_tpl'] ? params['prompt_tpl'] : 'adapt-audit.md'
  const outputPurpose = typeof params['output_purpose'] === 'string' && params['output_purpose'] ? params['output_purpose'] : 'audit_report'
  const maxInputChars = typeof params['max_input_chars'] === 'number' && params['max_input_chars'] > 0 ? Math.floor(params['max_input_chars']) : 120_000

  // —— 1. 输入：章节原文（按 index 升序）+ 改编产物（script 资产，事件/大纲/剧本皆可） ——
  const chapterIds = ctx.assetIdsOf('chapters')
  const scriptIds = ctx.assetIdsOf('script')
  if (chapterIds.length === 0) throw new StepError('adapt_audit：inputs.chapters 无章节资产')
  if (scriptIds.length === 0) throw new StepError('adapt_audit：inputs.script 无改编产物资产')

  const clip = (s: string): string => (s.length <= maxInputChars ? s : `${s.slice(0, maxInputChars)}\n…（单份超长截断，全文 ${s.length} 字符）`)
  const sections: string[] = []
  const chapterRows = await ctx.assetsOf(chapterIds)
  // 排除 json 产物（章节资产链首含 manifest「章节索引.json」，非原文不得注入）
  const chapterRowsSorted = chapterRows
    .filter((a) => a.kind === 'text' && a.ext !== 'json')
    .sort((a, b) => {
      const ia = Number((JSON.parse(a.params ?? '{}') as { index?: unknown }).index ?? a.id)
      const ib = Number((JSON.parse(b.params ?? '{}') as { index?: unknown }).index ?? b.id)
      return ia - ib
    })
  for (const a of chapterRowsSorted) {
    sections.push(`--- 章节原文 / ${a.name} ---\n${clip(await ctx.readText(a.id))}`)
  }
  const scriptRows = await ctx.assetsOf(scriptIds)
  for (const a of scriptRows.filter((x) => x.kind === 'text' && x.ext !== 'json')) {
    sections.push(`--- 改编产物 / ${a.name} ---\n${clip(await ctx.readText(a.id))}`)
  }
  if (sections.length < 2) throw new StepError('adapt_audit：有效文本资产不足（章节与改编产物各至少一份）')

  // —— 2. LLM 审计（契约：{faithful, divergences[]}；解析失败 fail-fast） ——
  const userPrompt = `${loadPromptTemplate(tplFile)}\n\n===== 输入资料 =====\n${sections.join('\n\n')}`
  const ep = await resolveLlmEndpoint()
  ctx.log(`调用 LLM 回查：${ep.model}（章节 ${chapterRowsSorted.length} 份 × 产物 ${scriptRows.length} 份）…`)
  const res = await chatCompleteDetailed(
    [
      { role: 'system', content: '你是内容创作流水线的执行引擎，严格按用户提供的提示词模板产出。只输出任务要求的内容本体，不输出任何解释性前言或后记。' },
      { role: 'user', content: userPrompt },
    ],
    ep,
    // [推理预算修复] 推理模型 reasoning_content 独占 18-19K token，16000 会在正文产出前耗尽 → 24000
    { temperature: 0.2, maxTokens: 24_000, timeoutMs: 600_000 },
  )
  await recordLlmUsage({ projectId: ctx.run.projectId, runId: ctx.run.id, stepId: ctx.step.id, provider: res.provider, model: res.model, usage: res.usage })

  const verdict = parseAuditVerdict(res.content)
  if (!verdict) {
    throw new StepError(`adapt_audit：回查输出不合契约（无法解析 {faithful, divergences}）。开头 200 字符：${res.content.slice(0, 200)}`)
  }

  // —— 3. 落 md 报告（差异表 + 原始 JSON 附录；params.audit 机读留痕） ——
  const RANK: Record<string, number> = { info: 1, warn: 2, major: 3 }
  const KIND_LABEL: Record<string, string> = { omission: '遗漏', alteration: '改写', addition: '新增', order: '顺序' }
  const maxSeverity = verdict.divergences.reduce<string>((acc, d) => ((RANK[d.severity] ?? 0) > (RANK[acc] ?? 0) ? d.severity : acc), 'info')
  const rows = verdict.divergences
    .map((d) => `| ${KIND_LABEL[d.kind] ?? d.kind} | ${d.severity} | ${d.desc.replace(/\|/g, '＼|')} | ${d.ref.replace(/\|/g, '＼|')} |`)
    .join('\n')
  const report = [
    '# 改编一致性回查报告',
    '',
    `- 忠实度判定：**${verdict.faithful ? '忠实（faithful）' : '存在重大偏差（not faithful）'}**`,
    `- 差异条目：${verdict.divergences.length} 条（最高严重度 ${verdict.divergences.length ? maxSeverity : '—'}）`,
    `- 对照范围：章节 ${chapterRowsSorted.length} 份 × 改编产物 ${scriptRows.length} 份`,
    '',
    '| 类型 | 严重度 | 描述 | 定位 |',
    '|---|---|---|---|',
    rows || '| — | — | 未检出偏差 | — |',
    '',
    '## 原始判定 JSON',
    '',
    '```json',
    JSON.stringify(verdict, null, 2),
    '```',
    '',
  ].join('\n')
  const asset = await writeTextAsset(ctx.run.projectId, {
    name: '改编回查报告.md',
    content: report,
    purpose: outputPurpose,
    stepId: ctx.step.id,
    runId: ctx.run.id,
    prompt: userPrompt.slice(0, 4000),
    tags: ['audit'],
    params: { audit: { faithful: verdict.faithful, max_severity: verdict.divergences.length ? maxSeverity : null, divergences: verdict.divergences } },
  })
  ctx.log(`回查完成：${verdict.faithful ? '忠实' : '不忠实'}，差异 ${verdict.divergences.length} 条（报告 asset#${asset.id}）`)
  return { assetIds: [asset.id] }
}
