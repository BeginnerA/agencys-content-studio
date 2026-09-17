/**
 * 探针统一 runner（M26·H5a）——手动执行：
 *   cd apps/server && npx tsx scripts/run-probes.ts [--jobs=N] [--fail-fast] [--only=m19,m25]
 *
 * 功能：发现全部 scripts/probe-*.ts → 按里程碑自然序排列 → 并行子进程执行
 * （各探针用独立临时库 acs-probe-mXX-*，互不冲突可安全并行）→ 解析 PASS/FAIL
 * 断言数 + 计时 → 末尾打印对齐汇总表。任一探针失败则整体退出码非零。
 *
 * 供 `probe:all`（并行全量）与 `probe:ci`（fail-fast 串行）消费。
 * 说明：本 runner 只编排既有探针，不改动任何探针断言逻辑；权威门禁 = 子进程退出码，
 * PASS/FAIL 计数仅供展示汇总（parseProbeOutput 词元计数已核验精确）。
 */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import cpus from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatSummary, parseProbeOutput, type ProbeResult } from './probe-lib'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = resolve(HERE, '..') // apps/server

function milestoneSortKey(id: string): number {
  const m = id.match(/^m(\d+)/)
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
}

function discover(): Array<{ id: string; file: string }> {
  return readdirSync(HERE)
    .filter((f) => /^probe-.+\.ts$/.test(f) && f !== 'probe-lib.ts')
    .map((f) => ({ id: f.replace(/^probe-/, '').replace(/\.ts$/, ''), file: join(HERE, f) }))
    .sort((a, b) => milestoneSortKey(a.id) - milestoneSortKey(b.id) || a.id.localeCompare(b.id))
}

function argvFlag(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`))
  return a ? a.slice(name.length + 3) : undefined
}
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`)

function runOne(id: string, file: string): Promise<ProbeResult> {
  const t0 = Date.now()
  return new Promise((res) => {
    // 复用仓库既有 `node --import tsx` 启动式（见 package.json dev/start）；cwd=apps/server 使 tsx 可解析
    const child = spawn(process.execPath, ['--import', 'tsx', file], { cwd: SERVER_DIR })
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (out += d.toString()))
    child.on('close', (code) => {
      const { pass, fail } = parseProbeOutput(out)
      if (process.env.PROBE_VERBOSE === '1') process.stdout.write(out)
      else if (code !== 0) process.stdout.write(out) // 失败时回显完整输出便于定位
      res({ id, pass, fail, ms: Date.now() - t0, code: code ?? 1 })
    })
  })
}

async function main(): Promise<void> {
  const all = discover()
  const only = argvFlag('only')
  const targets = only ? all.filter((p) => only.split(',').includes(p.id)) : all
  if (targets.length === 0) {
    console.error(`无匹配探针（--only=${only}）；可用：${all.map((p) => p.id).join(', ')}`)
    process.exitCode = 1
    return
  }
  const failFast = hasFlag('fail-fast')
  const jobsArg = argvFlag('jobs')
  const jobs = failFast ? 1 : Math.max(1, jobsArg ? Number(jobsArg) : Math.min(4, cpus.cpus().length - 1))
  console.log(`▶ 运行 ${targets.length} 枚探针（并发=${jobs}${failFast ? '，fail-fast' : ''}）…`)

  const results: ProbeResult[] = []
  let idx = 0
  let aborted = false

  const worker = async (): Promise<void> => {
    while (idx < targets.length && !aborted) {
      const t = targets[idx++]!
      const r = await runOne(t.id, t.file)
      results.push(r)
      const mark = r.code === 0 && r.fail === 0 ? '✅' : '❌'
      console.log(`  ${mark} ${t.id.padEnd(6)} ${String(r.pass + r.fail).padStart(4)} 断言  ${(r.ms / 1000).toFixed(1)}s${r.fail ? `  失败 ${r.fail}` : ''}`)
      if (failFast && (r.code !== 0 || r.fail > 0)) {
        aborted = true
        break
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(jobs, targets.length) }, worker))

  results.sort((a, b) => milestoneSortKey(a.id) - milestoneSortKey(b.id) || a.id.localeCompare(b.id))
  console.log(formatSummary(results))
  const bad = results.some((r) => r.code !== 0 || r.fail > 0)
  process.exitCode = bad ? 1 : 0
}

void main()
