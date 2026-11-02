/**
 * 全站 CSS 自定义属性可解析守卫（真实令牌契约面）。
 *
 * 动机：界面审查发现 `color: var(--text-1)`、`background: var(--bg-1, #fff)` 这类引用——
 * 变量名在本应用里从未声明。无回退时整条声明在计算值阶段失效（元素静默继承父色），有回退时
 * 渲染出体系外的写死色（白底弹层就是这么来的）。vue-tsc 与 vite 都不校验 CSS 变量名，
 * 所以这类缺陷能一路通过类型检查和构建。本探针把「变量名必须有声明」前移到离线门禁。
 *
 * 判定契约（保守，只抓「名字从未声明」这一类）：
 *   - 声明 = 任一被扫文件里出现 `--x:`（CSS 声明）、`'--x':` / `"--x":`（内联 :style 键）、
 *     `setProperty('--x'`（JS 写入）。
 *   - 引用 = `var(--x`。回退值不构成声明（`var(--cg, 148 163 184)` 里 `--cg` 后是逗号）。
 *   - 跨文件解析按全局名集合判定，不建模作用域/继承——够用且不误报，代价是「只在本组件声明的
 *     变量被别的组件引用」抓不到，这类问题由渲染面负责。
 *
 * 离线：只读源码，不起服务、不联网、不写盘、不碰真实配置与数据。
 * 用法：node .superpowers/sdd/M70-计划/safe-run.mjs script ../web/scripts/probe-css-tokens.ts
 * 上面目录名保留原样 pointer-ok：它是磁盘上真实存在的路径，去掉编号后这条命令无法运行。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = resolve(here, '../src')
const SCANNED_EXT = /\.(vue|css|ts)$/

/** 被扫文件数下限：低于此值说明遍历坏掉了，守卫会静默空跑。 */
const MIN_FILES = 300

let passed = 0
const results: string[] = []

function check(ok: boolean, message: string): void {
  if (ok) {
    passed++
    results.push(`PASS  ${message}`)
    return
  }
  results.push(`FAIL  ${message}`)
  console.error(`  FAIL  ${message}`)
  process.exitCode = 1
}

/** 收集一个文件里所有「声明」的自定义属性名。 */
function declaredNames(source: string): Set<string> {
  const names = new Set<string>()
  for (const m of source.matchAll(/(?:^|[\s;{}])(--[A-Za-z0-9_-]+)\s*:/g))
    names.add(m[1]!)
  for (const m of source.matchAll(/(['"])(--[A-Za-z0-9_-]+)\1\s*:/g))
    names.add(m[2]!)
  for (const m of source.matchAll(
    /setProperty\(\s*(['"])(--[A-Za-z0-9_-]+)\1/g,
  ))
    names.add(m[2]!)
  return names
}

type Site = { file: string; line: number; name: string; fallback: string }

/** 收集一个文件里所有 `var(--x ...)` 引用（含所在行与回退片段）。 */
function referencedSites(file: string, source: string): Site[] {
  const sites: Site[] = []
  for (const m of source.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)([^)]*)\)?/g)) {
    const line = source.slice(0, m.index).split('\n').length
    sites.push({
      file,
      line,
      name: m[1]!,
      fallback: (m[2] ?? '').replace(/^,/, '').trim(),
    })
  }
  return sites
}

/** 核心判定：引用名 ∉ 全局声明名集合的，即不可解析引用。 */
function unresolved(files: Map<string, string>): {
  names: Map<string, Site[]>
  refs: number
} {
  const declared = new Set<string>()
  for (const source of files.values())
    for (const name of declaredNames(source)) declared.add(name)
  const byName = new Map<string, Site[]>()
  let refs = 0
  for (const [file, source] of files)
    for (const site of referencedSites(file, source)) {
      refs++
      if (declared.has(site.name)) continue
      ;(
        byName.get(site.name) ?? byName.set(site.name, []).get(site.name)!
      ).push(site)
    }
  return { names: byName, refs }
}

function main(): void {
  // 1. 自检：证明判定不是空跑，四种形态必须分别命中/放过。
  const tautology = new Map([
    ['bad.vue', '<style>x { color: var(--nope-token); }</style>'],
  ])
  const r1 = unresolved(tautology)
  check(
    r1.names.size === 1 && r1.names.has('--nope-token'),
    '守卫自检：未声明变量名被判定为不可解析（本探针要抓的形态）',
  )

  const scoped = new Map([
    [
      'ok.vue',
      '<style>:root { --real-token: 1px; } x { border: var(--real-token) }</style>',
    ],
  ])
  check(
    unresolved(scoped).names.size === 0,
    '守卫自检：同集合内已声明的变量引用放过（不是见 var 就报）',
  )

  const inlineStyle = new Map([
    [
      'grid.vue',
      `<template><i :style="{ '--veil': 1 }" /></template><style>x { opacity: var(--veil, 0) }</style>`,
    ],
    ['js.ts', `el.style.setProperty('--thumb-zoom', '1.045')`],
  ])
  check(
    unresolved(inlineStyle).names.size === 0,
    '守卫自检：内联 :style 键与 JS setProperty 计入声明（避免把运行时变量误报）',
  )

  const fallbackOnly = new Map([
    ['fb.css', 'x { color: rgb(var(--cg, 148 163 184) / 55%) }'],
  ])
  check(
    unresolved(fallbackOnly).names.size === 1,
    '守卫自检：回退值不被当作声明（白底弹层正是靠回退静默渲染体系外色）',
  )

  // 2. 真实面：遍历 apps/web/src。
  const files = new Map<string, string>()
  ;(function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      if (statSync(abs).isDirectory()) walk(abs)
      else if (SCANNED_EXT.test(name))
        files.set(relative(srcRoot, abs), readFileSync(abs, 'utf8'))
    }
  })(srcRoot)

  check(
    files.size >= MIN_FILES,
    `遍历到 ${files.size} 个 .vue/.css/.ts 源文件（下限 ${MIN_FILES}，防止守卫空跑）`,
  )

  const { names, refs } = unresolved(files)
  for (const [name, sites] of names) {
    const where = sites
      .slice(0, 6)
      .map((s) => `${s.file}:${s.line}`)
      .join(', ')
    const more = sites.length > 6 ? ` …+${sites.length - 6}` : ''
    const fallbacks = [
      ...new Set(sites.map((s) => s.fallback || '无→整条声明失效')),
    ].join(' | ')
    check(
      false,
      `${name}：${sites.length} 处引用无声明（回退=${fallbacks}）→ ${where}${more}`,
    )
  }
  check(
    names.size === 0,
    `全站 ${refs} 处 var() 引用的变量名均在本应用有声明（不可解析 ${names.size} 个）`,
  )

  console.log(`\n==== CSS 令牌可解析守卫：${passed} 项通过 ====`)
  if (process.exitCode === 1) {
    for (const line of results)
      if (line.startsWith('FAIL')) console.log('  ' + line)
    process.exit(1)
  }
}

main()
