/**
 * 模板静态校验器（M26·H1）——手动执行：
 *   cd apps/server && npx tsx scripts/validate-templates.ts
 *
 * 以 pipeline loader 全量加载 workspace/templates/*.yaml，逐份纯文本校验（不落盘、不执行、不触网）：
 *   - errors（致命）：YAML 语法 / 结构 / key 非法 / action 未注册（KNOWN_ACTIONS）/
 *     M70 连续性声明（非法 role、多目标/batch 目标、目标输入缺声明、渲染上限只能下调）
 *   - warnings（非致命）：prompt_tpl 提示词文件缺失 / next 引用模板不存在（编辑期放行，运行时才致命）
 * 任一 errors → 退出码非零（CI 阻断）；warnings 仅打印不阻断。
 *
 * M70 Task6：本文件同时被探针以模块方式导入（continuityTemplateErrors），
 * main() 仅在直接执行本脚本时运行（import.meta.url 主模块判定）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TEMPLATES_DIR } from '../src/env'
import { KNOWN_ACTIONS, validateTemplateText } from '../src/pipeline/loader'
import type { Template } from '../src/pipeline/types'

const roleOf = (step: Template['steps'][number]): unknown =>
  (step.params as Record<string, unknown> | undefined)?.['continuity_role']

/**
 * M70 连续性声明校验（纯函数，供 CI 与探针复用）：
 *   - continuity_role 只允许 episode_script；目标步不得配置 batch；目标步全模板仅允许一个；
 *   - 目标模板必须声明 brief(text) / episode_number(int) / with_continuity(bool) / continuity_context(files)；
 *   - defaults.continuity.max_render_chars 只能下调（正整数 ≤ 24000，超出即拒绝）。
 */
export function continuityTemplateErrors(template: Template): string[] {
  const errors: string[] = []
  const roleSteps = template.steps.filter((s) => roleOf(s) !== undefined)
  for (const step of roleSteps) {
    const role = roleOf(step)
    if (role !== 'episode_script') {
      errors.push(`步骤 ${step.key} 的 continuity_role「${String(role)}」非法（仅允许 episode_script）`)
    }
    if (step.batch) errors.push(`步骤 ${step.key} 是连续性目标步，不得配置 batch（承接包不支持按列表逐项）`)
  }
  const targets = template.steps.filter((s) => roleOf(s) === 'episode_script')
  if (targets.length > 1) errors.push(`模板声明了 ${targets.length} 个连续性目标步（仅允许一个）`)
  if (targets.length >= 1) {
    const brief = template.inputs.find((i) => i.key === 'brief')
    if (!brief || brief.kind !== 'text') errors.push('连续性目标模板需声明 text 输入 brief')
    const episode = template.inputs.find((i) => i.key === 'episode_number')
    if (!episode || episode.kind !== 'int') errors.push('连续性目标模板需声明 int 输入 episode_number')
    const sw = template.inputs.find((i) => i.key === 'with_continuity')
    if (!sw || sw.kind !== 'bool') errors.push('连续性目标模板需声明 bool 输入 with_continuity')
    const slot = template.inputs.find((i) => i.key === 'continuity_context')
    if (!slot || slot.kind !== 'files') errors.push('连续性目标模板需声明 files 输入 continuity_context')
  }
  const raw = template.defaults?.['continuity']
  const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)['max_render_chars'] : undefined
  if (value !== undefined
    && !(typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 24000)) {
    errors.push('defaults.continuity.max_render_chars 只能下调且需为正整数（硬上限 24000）')
  }
  return errors
}

function main(): void {
  const files = readdirSync(TEMPLATES_DIR).filter((f) => /^[\w-]+\.ya?ml$/.test(f))
  let tplCount = 0
  let errorCount = 0
  let warnCount = 0
  let stepCount = 0

  for (const name of files) {
    const key = name.replace(/\.ya?ml$/, '')
    const text = readFileSync(join(TEMPLATES_DIR, name), 'utf8')
    const res = validateTemplateText(text, key)
    tplCount += 1
    const errs = [...res.errors]
    // 独立复核 action ∈ KNOWN_ACTIONS（validate 已内含，此处再钉一枚 CI 断言）
    if (res.template) {
      stepCount += res.template.steps.length
      for (const s of res.template.steps) {
        if (!(KNOWN_ACTIONS as readonly string[]).includes(s.action)) errs.push(`步骤 ${s.key} 的 action「${s.action}」未注册`)
      }
      errs.push(...continuityTemplateErrors(res.template))
    }
    if (errs.length) {
      errorCount += errs.length
      console.log(`❌ ${key}`)
      for (const e of errs) console.log(`     · ${e}`)
    } else if (res.warnings.length) {
      warnCount += res.warnings.length
      console.log(`⚠️  ${key}（${res.template?.steps.length ?? '?'} 步）`)
      for (const w of res.warnings) console.log(`     · ${w}`)
    } else {
      console.log(`✅ ${key}（${res.template?.steps.length ?? '?'} 步）`)
    }
  }

  console.log(`\n==== 模板校验：${tplCount} 份 / ${stepCount} 步 · ${errorCount} 错误 · ${warnCount} 警告 ====`)
  process.exitCode = errorCount > 0 ? 1 : 0
}

// 仅直接执行本脚本时跑 main（探针以 import 方式复用 continuityTemplateErrors，不触发扫描）
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) main()
