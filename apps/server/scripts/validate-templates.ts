/**
 * 模板静态校验器（M26·H1）——手动执行：
 *   cd apps/server && npx tsx scripts/validate-templates.ts
 *
 * 以 pipeline loader 全量加载 workspace/templates/*.yaml，逐份纯文本校验（不落盘、不执行、不触网）：
 *   - errors（致命）：YAML 语法 / 结构 / key 非法 / action 未注册（KNOWN_ACTIONS）
 *   - warnings（非致命）：prompt_tpl 提示词文件缺失 / next 引用模板不存在（编辑期放行，运行时才致命）
 * 任一 errors → 退出码非零（CI 阻断）；warnings 仅打印不阻断。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TEMPLATES_DIR } from '../src/env'
import { KNOWN_ACTIONS, validateTemplateText } from '../src/pipeline/loader'

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

main()
