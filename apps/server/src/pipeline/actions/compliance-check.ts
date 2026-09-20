import { writeTextAsset } from '../../services/storage'
import { chatCompleteDetailed, loadPromptTemplate } from '../../services/llm'
import { recordLlmUsage } from '../../services/usage'
import {
  loadRules,
  parseLlmVerdict,
  overallStatus,
  recordCompliance,
  renderComplianceReport,
  scanText,
  type ComplianceHit,
  type ComplianceMark,
} from '../../services/compliance'
import type { StepContext } from '../context'
import { interpolate } from '../refs'
import { StepError, type StepResult } from '../types'

// [M24·F5] compliance_check action（spec §2.6）：本地词库扫描 + 可选 LLM 复审 + 产物标记写回。
// 输入 inputs.content = 被检 text 资产（可多个，逐个标记）；亦支持 input.content 字面文本（仅入报告不标记）。
// params：llm_review（默认 true；LLM 失败宽容降级）、on_block（'fail'|'mark' 默认 'fail'，spec §2.6）、prompt_tpl、name_tpl。
// 产物：各资产 params.compliance 标记（零新列，对齐 params.quality 先例）+ 汇总报告资产（purpose=compliance_report）。

export async function complianceCheck(ctx: StepContext): Promise<StepResult> {
  const params = (ctx.def.params ?? {}) as Record<string, unknown>
  const llmReview = params['llm_review'] !== false && ctx.input['llm_review'] !== false
  const onBlock = params['on_block'] === 'mark' ? 'mark' : 'fail'
  const promptTpl = typeof params['prompt_tpl'] === 'string' && params['prompt_tpl'] ? params['prompt_tpl'] : 'compliance-review.md'

  const { rules, source } = loadRules()
  if (source === 'builtin') ctx.log('合规词库缺失（workspace/compliance/words.txt）→ 启用内置《广告法》基准地板（非完整法务词库，请按业务扩充 words.txt）')

  // 被检资产（text）+ 可选字面文本
  const ids = ctx.assetIdsOf('content')
  const assets = ids.length > 0 ? await ctx.assetsOf(ids) : []
  const texts = assets.filter((a) => a.kind === 'text')
  const literal = typeof ctx.input['content'] === 'string' ? (ctx.input['content'] as string).trim() : ''
  if (texts.length === 0 && !literal) throw new StepError('合规审核输入为空（inputs.content 需为 text 资产或 input.content 字面文本）')

  const marks: Array<{ assetId: number | null; name: string; chars: number; status: ComplianceMark['status']; hits: ComplianceHit[]; llm: ComplianceMark['llm'] }> = []
  let blocked = false

  const checkOne = async (assetId: number | null, name: string, text: string) => {
    const hits = scanText(text, rules)
    let verdict: ComplianceMark['llm'] = null
    if (llmReview) {
      try {
        const res = await chatCompleteDetailed([
          { role: 'system', content: loadPromptTemplate(promptTpl) },
          { role: 'user', content: `待审文本（${text.length} 字符）：\n\n${text.slice(0, 12000)}` },
        ])
        verdict = parseLlmVerdict(res.content)
        if (!verdict) ctx.log(`LLM 复审输出不可解析（${name}）→ 按未复审降级`)
        await recordLlmUsage({ projectId: ctx.run.projectId, runId: ctx.run.id, stepId: ctx.step.id, provider: res.provider, model: res.model, usage: res.usage })
      } catch (err) {
        ctx.log(`LLM 复审跳过（${name}）：${(err as Error).message}`)
      }
    }
    const status = overallStatus(hits, verdict)
    if (status === 'block') blocked = true
    if (assetId !== null) {
      const mark: ComplianceMark = { status, hits, llm: verdict, checkedAt: Date.now() }
      await recordCompliance(assetId, mark)
    }
    marks.push({ assetId, name, chars: text.length, status, hits, llm: verdict })
  }

  for (const a of texts) {
    const text = (await ctx.readText(a.id)).trim()
    if (text) await checkOne(a.id, a.name, text)
  }
  if (!texts.length && literal) await checkOne(null, 'input.content（字面文本）', literal)

  // 汇总报告资产
  const overall = blocked ? 'block' : marks.some((m) => m.status === 'warn') ? 'warn' : 'pass'
  const lines = [
    `# 合规审核汇总`,
    ``,
    `- 结论：**${overall.toUpperCase()}** · 词库 ${rules.length} 条（${source === 'file' ? '已加载' : '内置基准地板'}） · LLM 复审：${llmReview ? '启用' : '关闭'}`,
    `- on_block=${onBlock} · 共审核 ${marks.length} 个对象`,
    ``,
    `| 对象 | 状态 | 词库命中 | LLM |`,
    `|---|---|---|---|`,
  ]
  for (const m of marks) lines.push(`| ${m.assetId !== null ? `asset#${m.assetId} ` : ''}${m.name} | ${m.status} | ${m.hits.length} | ${m.llm?.verdict ?? '—'} |`)
  for (const m of marks) {
    lines.push(``, `---`, ``, renderComplianceReport(m.chars, { status: m.status, hits: m.hits, llm: m.llm, checkedAt: Date.now() }))
  }
  const nameTpl = typeof params['name_tpl'] === 'string' ? params['name_tpl'] : 'compliance-report.md'
  const report = await writeTextAsset(ctx.run.projectId, {
    name: interpolate(nameTpl, ctx.input),
    content: `${lines.join('\n')}\n`,
    purpose: 'compliance_report',
    stepId: ctx.step.id,
    params: { overall, onBlock, llmReview, objects: marks.length, wordbook: rules.length, wordbookSource: source },
    tags: ['compliance'],
  })
  ctx.log(`合规报告 → asset#${report.id}（结论 ${overall}，审核 ${marks.length} 个对象）`)

  if (blocked && onBlock === 'fail') {
    const worst = marks.find((m) => m.status === 'block')
    throw new StepError(
      `合规审核拦截（on_block=fail）：${worst?.name ?? '未知对象'} 命中 block 级规则（报告 asset#${report.id}）`,
    )
  }
  return { assetIds: [report.id] }
}
