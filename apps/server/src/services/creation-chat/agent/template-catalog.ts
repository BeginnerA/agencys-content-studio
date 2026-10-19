/**
 * 模板目录（Agent 路由决策的「可调度清单」真源）。
 * 轻松创作 Agent 化后，LLM 不再受限于 easy-* 二选一，而是从专业模板全目录中智能选型；
 * 目录 = listTemplates() 摘要 + inputs 声明面（kind/required/options/default），
 * 供 LLM 产出可物化的 inputSpec；服务端以 snapshot() 快照，确认前重验「目录命中 + 版本一致」，
 * 避免确认间隙模板被修改导致执行内容与决策时所见不一致（同 planHash 作废律）。
 * easy-*（visibility: conversation）不进目录：那是 Agent 的 easy 模式专用执行载体，不是调度目标。
 */
import { listTemplates, loadTemplate, templateFlags } from '../../../pipeline/loader'
import type { TemplateInputDef, TemplateMeta } from '../../../pipeline/types'

export interface CatalogInput {
  key: string
  label?: string
  kind: TemplateInputDef['kind']
  required: boolean
  options?: string[]
  default?: string | number | boolean | string[]
}

export interface CatalogEntry {
  key: string
  name: string
  description?: string
  genre: string
  version: number
  stepCount: number
  scene?: string
  next?: string[]
  inputs: CatalogInput[]
}

/** 全量可调度目录（排除对话专用模板；坏文件由 listTemplates 自身跳过并告警） */
export function buildTemplateCatalog(): CatalogEntry[] {
  const out: CatalogEntry[] = []
  for (const meta of listTemplates()) {
    if (templateFlags(meta.key).conversationOnly) continue
    try {
      const tpl = loadTemplate(meta.key)
      out.push({
        key: meta.key,
        name: meta.name,
        description: meta.description,
        genre: meta.genre,
        version: meta.version,
        stepCount: meta.stepCount,
        scene: meta.scene,
        next: meta.next,
        inputs: tpl.inputs.map((i) => ({
          key: i.key,
          label: i.label,
          kind: i.kind,
          required: i.required,
          ...(i.options ? { options: i.options } : {}),
          ...(i.default !== undefined ? { default: i.default } : {}),
        })),
      })
    } catch {
      // 坏模板已被 listTemplates 列入 meta 但 loadTemplate 失败时跳过，不让目录整体崩
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key))
}

/** 注入规划 LLM 的紧凑目录文本（每模板一段：key/版本/用途/输入面/推荐下游） */
export function renderCatalogForPrompt(catalog: CatalogEntry[]): string {
  return catalog.map((t) => {
    const inputs = t.inputs.length
      ? t.inputs.map((i) => {
        const opts = i.options ? `，可选值=${i.options.join('|')}` : ''
        const def = i.default !== undefined ? `，默认=${JSON.stringify(i.default)}` : ''
        return `${i.key}(${i.kind}${i.required ? ',必填' : ',可选'}${opts}${def})`
      }).join('；')
      : '（无声明输入）'
    const next = t.next?.length ? `\n  推荐下游: ${t.next.join(', ')}` : ''
    return `- ${t.key} v${t.version}「${t.name}」${t.scene ? `[${t.scene}]` : ''}: ${t.description ?? '（无描述）'}\n  输入: ${inputs}${next}`
  }).join('\n')
}

/** 会话决策时的目录快照（存进 decision.templateRun/chain.segments[].catalogSnapshot，确认前重验） */
export function snapshotCatalogEntry(key: string): { key: string; version: number } | null {
  const meta: TemplateMeta | undefined = listTemplates().find((m) => m.key === key)
  return meta ? { key: meta.key, version: meta.version } : null
}

/** 快照一致性核验：模板存在且版本未漂移（漂移即失效，须重新规划，绝不静默用新版执行） */
export function matchesSnapshot(key: string, snapshot: { key: string; version: number } | null | undefined): boolean {
  if (!snapshot || snapshot.key !== key) return false
  const cur = snapshotCatalogEntry(key)
  return !!cur && cur.version === snapshot.version
}
