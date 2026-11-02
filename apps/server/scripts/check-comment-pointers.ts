/**
 * 注释门禁：禁止注释里出现无法自解释的外部编号指针。
 *
 * 背景：里程碑号、节号、阶段码、任务号这类指针只在特定文档里有意义，
 * 代码读者无法查证，时间久了就是噪声。注释应该直接说清「做什么 / 为什么」。
 *
 * 用法：tsx scripts/check-comment-pointers.ts
 * 逃生口：确有需要时在该行注释末尾写 pointer-ok，并在同行说明理由。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const SCAN = ['apps/server/src', 'apps/server/scripts', 'apps/web/src']
const EXT = new Set(['.ts', '.vue', '.js', '.mjs', '.cjs'])
const SKIP = /^(node_modules|dist|\.git|\.superpowers)$/

// 每族一类指针；命中即失败，提示里带族名，便于按类批量修
const FAMILIES: Array<[string, RegExp]> = [
  ['节号', /§/],
  ['里程碑', /(?<![A-Za-z0-9_])M\d{1,2}(?:\.\d+)?(?![A-Za-z0-9_])/],
  ['阶段码', /\[P\d|(?<![A-Za-z0-9_])P\d(?![A-Za-z0-9_])/],
  ['单元码', /(?<![A-Za-z0-9_])[EIF]\d{1,2}(?:-[A-Za-z]+)?(?![A-Za-z0-9_])/],
  ['集成单元', /intg[A-Z]?/],
  ['任务号', /Task\s?\d|brief\s?\d{1,2}|line\s?\d{2,}/],
  ['切片号', /Slice\s?[A-Z]|切片\s?\d|切片\s?[A-Z一二三四五六七八九]/],
  ['期号', /第[一二三四五六七八九十]+期/],
]

function commentStart(line: string): number {
  const t = line.trim()
  if (/^(\*|\/\*|<!--)/.test(t)) return line.indexOf(t.slice(0, 2))
  let q: string | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (q) {
      if (ch === '\\') i++
      else if (ch === q) q = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      q = ch
      continue
    }
    if (ch === '/' && line[i + 1] === '/') return i
  }
  return -1
}

const files: string[] = []
function walk(dir: string) {
  if (!fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.test(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (EXT.has(path.extname(e.name)) && !p.endsWith('.d.ts')) files.push(p)
  }
}
for (const d of SCAN) walk(path.join(ROOT, d))

const hits: Array<{ rel: string; line: number; family: string; text: string }> = []
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/')
  fs.readFileSync(f, 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      const cs = commentStart(line)
      if (cs < 0) return
      const body = line.slice(cs)
      if (body.includes('pointer-ok')) return
      for (const [family, re] of FAMILIES) {
        if (re.test(body)) hits.push({ rel, line: i + 1, family, text: body.trim() })
      }
    })
}

if (!hits.length) {
  console.log(`注释门禁通过：${files.length} 个文件无外部编号指针`)
  process.exit(0)
}

for (const h of hits.slice(0, 60)) console.log(`${h.rel}:${h.line}  [${h.family}]  ${h.text}`)
if (hits.length > 60) console.log(`… 共 ${hits.length} 处，仅显示前 60 处`)
console.error(
  `\n注释门禁未通过：${hits.length} 处不可自解释指针。改为直述「做什么 / 为什么」；确有需要时在该行加 pointer-ok 并写明原因。`,
)
process.exit(1)
