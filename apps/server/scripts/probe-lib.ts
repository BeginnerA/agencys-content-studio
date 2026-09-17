/**
 * 探针公共库（M26·H5）——被大探针拆分后的薄入口复用。
 *
 * 提供三件套：
 *   - isolatedEnv(tag, opts)：临时目录隔离（必须在任何 src 模块加载前调用）
 *   - makeChecker(log)：PASS/FAIL 断言计数闭包（与原各探针 check 语义逐字一致）
 *   - runSections(cfg)：--section 派发 + 汇总 + 退出码 + 临时目录清理
 *
 * 设计约束：本库只做「与断言内容无关」的机械部分。各探针入口先 makeChecker 得到
 * 贯穿 registry 与全部分节的唯一 checker，节模块 runner 闭包捕获同一 checker.check，
 * 因此拆分前后 PASS/FAIL 文案与总数逐字不变、退出码语义不变。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Logger } from '../src/logger'

const LIB_HERE = dirname(fileURLToPath(import.meta.url))
/** apps/server/scripts -> 仓库根 */
export const REPO_ROOT = resolve(LIB_HERE, '..', '..', '..')

export interface IsolatedEnvResult {
  /** 本次运行的一次性临时根目录 */
  tmp: string
  /** 收尾清理（Windows libsql 句柄占用时静默跳过，下次运行自动收敛） */
  cleanup: () => void
}

/**
 * 设置隔离环境：CSTUDIO_ROOT/DATA/WORKSPACE 指向一次性临时目录（独立 studio.db + workspace）。
 * ⚠ 必须在任何 src 模块动态 import 之前调用（env 单例在首次加载时固化）。
 * @param tag 临时目录前缀标签（如 'm19' → `acs-probe-m19-`），保持与各探针历史前缀一致
 * @param opts.bridge 需要只读桥接的真实 workspace 子目录（junction 零拷贝，失败回退递归拷贝）
 */
export function isolatedEnv(tag: string, opts?: { bridge?: Array<'templates' | 'prompts'> }): IsolatedEnvResult {
  const prefix = `acs-probe-${tag}-`
  // 清理历史残留：libsql 在 Windows 下不释放文件句柄（close 后仍 EBUSY）——本进程退出时 db 文件必留；
  // 本次运行在创建自己的目录前清掉旧的（占用中则跳过，自动收敛为最多一份）。
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith(prefix)) {
      try {
        rmSync(join(tmpdir(), name), { recursive: true, force: true })
      } catch {
        /* 占用中（并行探针）→ 跳过 */
      }
    }
  }
  const tmp = mkdtempSync(join(tmpdir(), prefix))
  process.env.CSTUDIO_ROOT = REPO_ROOT
  process.env.CSTUDIO_DATA = join(tmp, 'data')
  process.env.CSTUDIO_WORKSPACE = join(tmp, 'workspace')
  mkdirSync(process.env.CSTUDIO_DATA, { recursive: true })
  mkdirSync(process.env.CSTUDIO_WORKSPACE, { recursive: true })
  for (const sub of opts?.bridge ?? []) {
    const real = join(REPO_ROOT, 'workspace', sub)
    const link = join(process.env.CSTUDIO_WORKSPACE, sub)
    if (existsSync(link) || !existsSync(real)) continue
    try {
      symlinkSync(real, link, 'junction')
    } catch {
      cpSync(real, link, { recursive: true })
    }
  }
  return {
    tmp,
    cleanup: () => {
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {
        console.log(`临时目录未完全清理（Windows libsql 句柄；下次运行自动清理）: ${tmp}`)
      }
    },
  }
}

export interface Checker {
  check: (cond: boolean, msg: string) => void
  readonly failed: number
  readonly passed: number
}

/** PASS/FAIL 断言计数闭包（语义与原探针逐字一致：PASS 走 info，FAIL 走 error 并计数）。 */
export function makeChecker(log: Logger): Checker {
  let failed = 0
  let passed = 0
  return {
    check: (cond: boolean, msg: string): void => {
      if (cond) {
        passed += 1
        log.info(`  PASS  ${msg}`)
      } else {
        failed += 1
        log.error(`  FAIL  ${msg}`)
      }
    },
    get failed() {
      return failed
    },
    get passed() {
      return passed
    },
  }
}

export interface RunSectionsConfig {
  log: Logger
  /** 探针标题（汇总行前缀，如 'M19'） */
  title: string
  /** 贯穿 registry 与全部分节的唯一 checker（由入口 makeChecker 创建后传入） */
  checker: Checker
  sections: readonly string[]
  runners: Record<string, () => Promise<void>>
  /** 分节之前先跑的注册面/前置断言（可选，all 与单节都覆盖一次；须复用 checker.check） */
  registry?: () => Promise<void> | void
  /** 临时目录清理回调（isolatedEnv().cleanup） */
  cleanup?: () => void
}

/**
 * 统一分节派发：解析 `--section=` → 前置 registry → 逐节 run → 汇总 + 退出码 + 清理。
 * 异常统一计一次 FAIL（与原探针 try/catch/finally 语义一致）。
 */
export async function runSections(cfg: RunSectionsConfig): Promise<void> {
  const { log, title, checker, sections, runners, registry, cleanup } = cfg
  const arg = process.argv.find((a) => a.startsWith('--section='))
  const wanted = arg ? arg.slice('--section='.length) : 'all'
  if (wanted !== 'all' && !sections.includes(wanted)) {
    log.error(`未知 section：${wanted}（已实现：${sections.join(' / ')}；all = 全部）`)
    process.exitCode = 1
    cleanup?.()
    return
  }
  try {
    if (registry) {
      console.log(`\n──── section: registry ────`)
      await registry()
    }
    for (const name of wanted === 'all' ? sections : [wanted]) {
      console.log(`\n──── section: ${name} ────`)
      const run = runners[name]
      if (!run) throw new Error(`分节 ${name} 未注册 runner`)
      await run()
    }
  } catch (err) {
    checker.check(false, `探针异常终止: ${(err as Error).stack ?? String(err)}`)
  } finally {
    console.log(`\n==== ${title} 探针结果: ${checker.failed > 0 ? `${checker.failed} 项失败` : '全部通过'} ====`)
    cleanup?.()
    process.exitCode = checker.failed > 0 ? 1 : 0
  }
}

/* ------------------------------------------------------------------ */
/* 统一 runner（run-probes.ts）消费的纯函数：输出解析 + 汇总格式化      */
/* ------------------------------------------------------------------ */

export interface ProbeResult {
  /** 探针 id（如 m19 / m2a） */
  id: string
  pass: number
  fail: number
  /** 墙钟耗时（ms） */
  ms: number
  /** 子进程退出码（0 = 全绿） */
  code: number
}

/**
 * 从探针 stdout 统计断言数：逐行计 `PASS` / `FAIL` 词元（logger 每断言一行 JSON，
 * 唯一 ASCII 词元即 check 标记；已核验断言文案不内嵌 PASS/FAIL，故计数精确）。
 */
export function parseProbeOutput(stdout: string): { pass: number; fail: number } {
  let pass = 0
  let fail = 0
  for (const line of stdout.split(/\r?\n/)) {
    if (/\bPASS\b/.test(line)) pass += 1
    if (/\bFAIL\b/.test(line)) fail += 1
  }
  return { pass, fail }
}

/** 对齐汇总表（id / 断言数 / 耗时 / 状态 + 总计行）。 */
export function formatSummary(rows: ProbeResult[]): string {
  const idw = Math.max(4, ...rows.map((r) => r.id.length))
  const line = (r: { id: string; n: string; ms: string; st: string }): string =>
    `  ${r.id.padEnd(idw)}  ${r.n.padStart(7)}  ${r.ms.padStart(9)}  ${r.st}`
  const out: string[] = ['\n' + '═'.repeat(idw + 32), line({ id: 'probe', n: 'assert', ms: 'time', st: 'status' }), '  ' + '-'.repeat(idw + 28)]
  let tp = 0
  let tf = 0
  let tms = 0
  for (const r of rows) {
    tp += r.pass
    tf += r.fail
    tms += r.ms
    out.push(line({ id: r.id, n: String(r.pass + r.fail), ms: `${(r.ms / 1000).toFixed(1)}s`, st: r.code === 0 && r.fail === 0 ? '✅ PASS' : `❌ FAIL(${r.fail})` }))
  }
  out.push('  ' + '-'.repeat(idw + 28))
  out.push(line({ id: 'TOTAL', n: String(tp + tf), ms: `${(tms / 1000).toFixed(1)}s`, st: tf === 0 ? `✅ ${tp} 断言全绿 / ${rows.length} 探针` : `❌ ${tf} 失败 / ${tp} 通过` }))
  out.push('═'.repeat(idw + 32))
  return out.join('\n')
}
