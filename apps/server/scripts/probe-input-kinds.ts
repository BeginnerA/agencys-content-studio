/**
 * 模板 inputs 新增字段类型探针（float / select / multi_select / date）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-input-kinds.ts [--section=loader|runinput]
 *
 * 锁定三处契约不漂移：
 *   loader    声明期深校验——kind 合法集（9 种）、select/multi_select 必带非空不重复 options、
 *             非候选类 kind 禁带 options、default 类型与 kind 一致且 ∈ options、date 默认日历合法；
 *   runinput  启动期归一 + 校验（prepareRunInput 全链，零 db / 零 LLM）——float 字符串转数字、
 *             date 非法日历日拒绝、select/multi_select 越界候选 fail-fast（不 clamp）、
 *             multi_select 逗号串兼容、模板 default 回填语义（含数组 default）。
 *
 * 隔离策略：isolatedEnv 临时目录（独立库），模板 fixture 现场写入隔离 TEMPLATES_DIR。
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedEnv, makeChecker, runSections } from './probe-lib'

const { cleanup } = isolatedEnv('input-kinds')
const { createLogger } = await import('../src/logger')
const log = createLogger('probe-input-kinds')
const checker = makeChecker(log)
const check = checker.check

const TPL_DIR = join(process.env.CSTUDIO_WORKSPACE!, 'templates')
mkdirSync(TPL_DIR, { recursive: true })

/** 写模板 fixture（文件名 = key.yaml） */
function fixture(key: string, yaml: string): void {
  writeFileSync(join(TPL_DIR, `${key}.yaml`), yaml, 'utf8')
}

const { loadTemplate } = await import('../src/pipeline/loader')
const { prepareRunInput, InvalidRunInputError } = await import('../src/services/run-create')

fixture(
  'kinds-ok',
  `key: kinds-ok
version: 1
name: 类型自检
genre: other
inputs:
  - { key: vol, label: 音量, kind: float, required: false, default: 0.6 }
  - { key: style, label: 风格, kind: select, required: true, options: [清新, 复古, 水墨], option_labels: [小清新, 怀旧, 国画], default: 清新 }
  - { key: tags, label: 标签, kind: multi_select, required: false, options: [搞笑, 催泪, 干货], default: [干货] }
  - { key: onair, label: 上线日期, kind: date, required: false, default: 2026-10-01 }
  - { key: eps, label: 集数, kind: int, required: false, default: 3 }
  - { key: mode, label: 模式, kind: text, required: false }
steps:
  - { key: pass, action: literal, title: 直通, inputs: {} }
`,
)

/** 单输入声明的最小合法模板（bad 系列：期望 loadTemplate 抛错） */
function oneInput(key: string, inputLine: string): void {
  fixture(
    key,
    `key: ${key}\nversion: 1\nname: ${key}\ninputs:\n  - ${inputLine}\nsteps:\n  - { key: pass, action: literal, title: 直通, inputs: {} }\n`,
  )
}

const errOf = (fn: () => unknown): Error | null => {
  try {
    fn()
    return null
  } catch (err) {
    return err as Error
  }
}

await runSections({
  log,
  title: 'input-kinds',
  checker,
  cleanup,
  sections: ['loader', 'runinput'],
  runners: {
    loader: async () => {
      const t = loadTemplate('kinds-ok')
      const byKey = Object.fromEntries(t.inputs.map((i) => [i.key, i]))
      check(t.inputs.length === 6, '合法六类模板加载成功（6 个输入）')
      check(byKey['vol']?.kind === 'float' && byKey['vol']?.default === 0.6, 'float 默认值 0.6 透传')
      check(byKey['style']?.kind === 'select' && byKey['style']?.options?.join(',') === '清新,复古,水墨', 'select options 解析（3 候选）')
      check(byKey['style']?.option_labels?.join(',') === '小清新,怀旧,国画', 'select option_labels 中文显示名透传（与 options 逐位对齐）')
      check(Array.isArray(byKey['tags']?.default) && (byKey['tags']?.default as string[]).join() === '干货', 'multi_select 数组默认值透传')
      check(byKey['onair']?.kind === 'date' && byKey['onair']?.default === '2026-10-01', 'date 默认值字符串透传')

      const cases: Array<[string, string, RegExp]> = [
        ['bad-kind', '{ key: x, label: X, kind: choice, required: false }', /kind「choice」非法（支持 text\/files\/int\/float\/bool\/select\/multi_select\/date\/publications）/],
        ['bad-select-noopts', '{ key: x, label: X, kind: select, required: false }', /options 需为非空字符串数组/],
        ['bad-select-emptyopts', '{ key: x, label: X, kind: select, required: false, options: [] }', /options 需为非空字符串数组/],
        ['bad-select-dupopts', '{ key: x, label: X, kind: select, required: false, options: [a, a] }', /存在重复选项/],
        ['bad-text-withopts', '{ key: x, label: X, kind: text, required: false, options: [a] }', /声明了 options 但 kind\(text\) 不支持/],
        ['bad-select-default', '{ key: x, label: X, kind: select, required: false, options: [a, b], default: c }', /default「c」不在 options 候选项内/],
        ['bad-multi-default-type', '{ key: x, label: X, kind: multi_select, required: false, options: [a, b], default: a }', /default 类型与 kind\(multi_select\) 不一致/],
        ['bad-multi-default-outside', '{ key: x, label: X, kind: multi_select, required: false, options: [a, b], default: [a, z] }', /default 含不在 options 候选项内的选项/],
        ['bad-date-default', '{ key: x, label: X, kind: date, required: false, default: 2026-13-45 }', /default 需为合法日期（YYYY-MM-DD）/],
        ['bad-float-default', '{ key: x, label: X, kind: float, required: false, default: "0.6" }', /default 类型与 kind\(float\) 不一致/],
        ['bad-int-default', '{ key: x, label: X, kind: int, required: false, default: 3.5 }', /default 类型与 kind\(int\) 不一致/],
        ['bad-labels-mismatch', '{ key: x, label: X, kind: select, required: false, options: [a, b], option_labels: [甲] }', /option_labels 需为非空字符串数组且与 options 逐位对齐/],
        ['bad-labels-noopts', '{ key: x, label: X, kind: text, required: false, option_labels: [甲] }', /声明了 option_labels 但无 options/],
        ['bad-labels-blank', '{ key: x, label: X, kind: select, required: false, options: [a, b], option_labels: [甲, ""] }', /option_labels 需为非空字符串数组且与 options 逐位对齐/],
      ]
      for (const [key, line, re] of cases) {
        oneInput(key, line)
        const e = errOf(() => loadTemplate(key))
        check(!!e && re.test(e.message), `${key} → 声明期报错（${re.source.slice(0, 28)}…）`)
      }
      // 缓存容错：非法模板报错后仍不产出半合法 Template 对象（重复加载报错口径一致）
      const again = errOf(() => loadTemplate('bad-kind'))
      check(!!again && /kind/.test(again.message), 'bad-kind 重复加载报错稳定')
    },

    runinput: async () => {
      const t = loadTemplate('kinds-ok')

      // ① 合法输入全链通过 + 类型归一
      const ok = prepareRunInput(t, { vol: '0.8', style: '复古', tags: ['搞笑', '干货'], onair: '2026-12-31', eps: 2, mode: ' fast ' })
      check(ok['vol'] === 0.8, 'float 字符串 "0.8" → 数字 0.8')
      check(ok['style'] === '复古', 'select 候选项内取值通过')
      check(Array.isArray(ok['tags']) && (ok['tags'] as string[]).join() === '搞笑,干货', 'multi_select 数组透传')
      check(ok['onair'] === '2026-12-31', 'date 合法日期通过')

      // ② 缺省即回填模板 default（含数组 default）
      const filled = prepareRunInput(t, {})
      check(filled['vol'] === 0.6 && filled['style'] === '清新', 'float/select 未传 → default 回填')
      check((filled['tags'] as string[]).join() === '干货' && filled['onair'] === '2026-10-01', 'multi_select/date 未传 → default 回填')

      // ③ multi_select 兼容逗号分隔字符串（批量 JSON 粘贴 / 排产表单写法）
      const comma = prepareRunInput(t, { tags: '搞笑，催泪' })
      check((comma['tags'] as string[]).join() === '搞笑,催泪', 'multi_select 中文逗号串 → 字符串数组')

      // ④ 越界与非法值 fail-fast（不 clamp、不静默丢）
      const badCases: Array<[Record<string, unknown>, RegExp, string]> = [
        [{ vol: 'abc' }, /input.vol 需为数字/, 'float 非法字符串 → bad_input'],
        [{ vol: 1.5, style: 'x', onair: '2026-02-30' }, /需为日期（YYYY-MM-DD）/, 'date 非法日历日（2月30）→ 拒绝'],
        [{ style: '赛博' }, /取值需在候选项内/, 'select 越界候选 → 拒绝'],
        [{ tags: ['不存在'] }, /需为候选项数组/, 'multi_select 含越界选项 → 拒绝'],
      ]
      for (const [input, re, what] of badCases) {
        const e = errOf(() => prepareRunInput(t, input))
        check(e instanceof InvalidRunInputError && re.test(e.message), `${what}（${e?.message ?? '未报错'}）`)
      }

      // ⑤ 未知键仍不入快照（normalizeInput 仅保留声明键，与 probe-m14 既有口径一致）
      const norm2 = prepareRunInput(t, { style: '复古', hacker: 'x' })
      check(!('hacker' in norm2) && norm2['style'] === '复古', '未知输入键静默丢弃不入快照（既有口径不变）')
    },
  },
})
