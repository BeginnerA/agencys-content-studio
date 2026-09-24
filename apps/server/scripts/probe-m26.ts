/**
 * M26 探针（工程基建与平台化）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m26.ts [--section=runner|probe-lib|split-audit|ollama-seed|stress]
 *
 * 零网络零计费，隔离临时库（acs-probe-m26-*）。验证 M26 交付的机械正确性：
 *   runner       —— run-probes 的纯函数 parseProbeOutput（PASS/FAIL 逐行计数）+ formatSummary（对齐表）
 *   probe-lib     —— makeChecker 计数语义 + isolatedEnv 目录前缀隔离与清理
 *   split-audit   —— ≤800 行红线扫描器在位；M26 新基建脚本自身合规；发现待拆文件数（P1/P3 后归零）
 *   ollama-seed   —— initDb 后 api_providers 查得 ollama_llm（vendor=ollama/service_type=llm/11434）+ 幂等重放不重复插
 *   stress        —— percentile 数学对拍 + 小样本 projects/assets 落隔离库（bench-stress 种子原语背书）
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元（保 parseProbeOutput 精确）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { REPO_ROOT, formatSummary, isolatedEnv, makeChecker, parseProbeOutput, runSections, type Checker, type ProbeResult } from './probe-lib'
import { percentile, seedDataset } from './bench-stress'
import type { Logger } from '../src/logger'

// ---- 隔离环境：必须先于任何 src/env 加载（logger 首次 import 会固化 env 单例） ----
const { cleanup } = isolatedEnv('m26')

const SECTIONS = ['runner', 'probe-lib', 'split-audit', 'ollama-seed', 'stress'] as const

const SERVER_DIR = join(REPO_ROOT, 'apps', 'server')
const SCRIPTS_DIR = join(SERVER_DIR, 'scripts')
const WEB_SRC_DIR = join(REPO_ROOT, 'apps', 'web', 'src')
const LINE_LIMIT = 800

function lineCount(file: string): number {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).length
  } catch {
    return 0
  }
}

/** 递归收集 .ts/.vue 文件（跳过 node_modules 与点目录） */
function walk(dir: string, out: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      walk(p, out)
    } else if (/\.(ts|vue)$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m26')
  const checker: Checker = makeChecker(log)
  const { check } = checker

  const runners: Record<string, () => Promise<void>> = {
    // ============ runner：run-probes 纯函数矩阵 ============
    runner: async () => {
      // 真实 logger 流形：每断言一行 JSON，唯一 PASS/FAIL 词元即 check 标记
      const sample = [
        '{"level":"info","msg":"  PASS  断言一"}',
        '{"level":"error","msg":"  FAIL  断言二"}',
        '{"level":"info","msg":"  PASS  断言三"}',
        '{"level":"info","msg":"==== M99 探针结果: 全部通过 ===="}',
        '',
      ].join('\n')
      const parsed = parseProbeOutput(sample)
      check(parsed.pass === 2, `parseProbeOutput 计通过=2（实得 ${parsed.pass}）`)
      check(parsed.fail === 1, `parseProbeOutput 计失败=1（实得 ${parsed.fail}）`)
      const empty = parseProbeOutput('')
      check(empty.pass === 0 && empty.fail === 0, 'parseProbeOutput 空流零计数')
      const noise = parseProbeOutput('random text without markers\nanother plain line')
      check(noise.pass === 0 && noise.fail === 0, 'parseProbeOutput 无标记噪声零计数')

      const rows: ProbeResult[] = [
        { id: 'm26', pass: 10, fail: 0, ms: 1234, code: 0 },
        { id: 'm3', pass: 5, fail: 1, ms: 99, code: 1 },
      ]
      const summary = formatSummary(rows)
      check(summary.includes('m26') && summary.includes('m3'), 'formatSummary 含各探针行')
      check(summary.includes('TOTAL'), 'formatSummary 含总计行')
      check(summary.includes('16'), 'formatSummary 总计断言数正确（10+5+1=16）')
      check(summary.includes('FAIL'), 'formatSummary 标注失败态')
    },

    // ============ probe-lib：makeChecker + isolatedEnv ============
    'probe-lib': async () => {
      const rec: Array<{ level: string; msg: string }> = []
      const fake: Logger = {
        debug: () => {},
        info: (m) => rec.push({ level: 'info', msg: m }),
        warn: () => {},
        error: (m) => rec.push({ level: 'error', msg: m }),
        child: () => fake,
      }
      const c = makeChecker(fake)
      c.check(true, '真值断言')
      c.check(false, '假值断言')
      check(c.passed === 1 && c.failed === 1, `makeChecker 计数 passed=1/failed=1（实得 ${c.passed}/${c.failed}）`)
      check(rec.some((r) => r.level === 'info' && r.msg.includes('PASS')), 'makeChecker 通过标记走 info')
      check(rec.some((r) => r.level === 'error' && r.msg.includes('FAIL')), 'makeChecker 失败标记走 error')

      // isolatedEnv：新建隔离目录 + 设 env 三件套 + 清理；测毕还原主临时 env 不污染后续节
      const before = {
        R: process.env.CSTUDIO_ROOT,
        D: process.env.CSTUDIO_DATA,
        W: process.env.CSTUDIO_WORKSPACE,
      }
      const env2 = isolatedEnv('m26lib')
      try {
        check(env2.tmp.includes('acs-probe-m26lib-'), 'isolatedEnv 前缀标签正确')
        check(existsSync(env2.tmp), 'isolatedEnv 临时根目录已创建')
        check(process.env.CSTUDIO_DATA === join(env2.tmp, 'data'), 'isolatedEnv 指向独立 CSTUDIO_DATA')
        check(process.env.CSTUDIO_WORKSPACE === join(env2.tmp, 'workspace'), 'isolatedEnv 指向独立 CSTUDIO_WORKSPACE')
      } finally {
        process.env.CSTUDIO_ROOT = before.R
        process.env.CSTUDIO_DATA = before.D
        process.env.CSTUDIO_WORKSPACE = before.W
        env2.cleanup()
      }
      check(!existsSync(env2.tmp), 'isolatedEnv cleanup 移除临时目录')
    },

    // ============ split-audit：≤800 红线扫描 ============
    'split-audit': async () => {
      // M26 新基建脚本自身纪律：入口与库文件必须 ≤800
      for (const f of ['probe-lib.ts', 'run-probes.ts', 'validate-templates.ts', 'probe-m26.ts']) {
        const p = join(SCRIPTS_DIR, f)
        check(lineCount(p) <= LINE_LIMIT, `M26 基建脚本 ≤${LINE_LIMIT}: ${f}（${lineCount(p)} 行）`)
      }
      // 全量红线扫描（scripts + web/src）：P0 阶段待拆存量 = 5 探针 + 5 前端；P1/P3 逐一收敛，P4 收口为 0
      const over = [...walk(SCRIPTS_DIR), ...walk(WEB_SRC_DIR)]
        .map((f) => ({ f, n: lineCount(f) }))
        .filter((x) => x.n > LINE_LIMIT)
        .sort((a, b) => b.n - a.n)
      log.warn(`[split-audit] 当前 >${LINE_LIMIT} 行文件 ${over.length} 个：${over.map((o) => `${basename(o.f)}(${o.n})`).join(' ') || '（无）'}`)
      // P4 收口门禁：红线存量必须归零（P1 拆 5 探针 + P3 拆前端存量后，scripts + web/src 不得有任何 >800 文件）
      // [2026-09 已归零] 尾项 ScheduleCalendar.vue(928→813→677) 拆为 view + use-schedule-form.ts（[M26-split2]，行为零变更）；本门禁保持绿，后续任何文件撞线即红
      check(over.length === 0, `split-audit 红线存量归零（当前 ${over.length} 个 >${LINE_LIMIT}：${over.map((o) => basename(o.f)).join(' ') || '无'}）`)
    },

    // ============ ollama-seed：一等 provider 种子 ============
    'ollama-seed': async () => {
      const { initDb, db } = await import('../src/db')
      const { apiProviders } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      await initDb()
      const rows = await db.select().from(apiProviders).where(eq(apiProviders.key, 'ollama_llm'))
      check(rows.length === 1, `ollama_llm 种子行唯一（实得 ${rows.length}）`)
      const r = rows[0]
      check(r?.serviceType === 'llm', 'ollama_llm service_type=llm')
      check(r?.vendor === 'ollama', 'ollama_llm vendor=ollama')
      check((r?.defaultUrl ?? '').includes('11434'), 'ollama_llm defaultUrl 指向本地 11434')
      // 幂等重放：再跑一次 initDb（内含 seedProviders upsert），ollama_llm 仍唯一
      await initDb()
      const replay = await db.select().from(apiProviders).where(eq(apiProviders.key, 'ollama_llm'))
      check(replay.length === 1, `幂等重放不重复插（实得 ${replay.length}）`)
    },

    // ============ stress：percentile 对拍 + seedDataset 小样本（背书 bench-stress 提炼原语）============
    stress: async () => {
      check(percentile([10, 20, 30, 40, 50], 50) === 30, 'percentile p50 中位数')
      check(percentile([10, 20, 30, 40, 50], 95) === 50, 'percentile p95 就近上整')
      check(percentile([10, 20, 30, 40, 50], 0) === 10, 'percentile p0 下界钳位')
      check(percentile([10, 20, 30, 40, 50], 100) === 50, 'percentile p100 上界钳位')
      check(Number.isNaN(percentile([], 50)), 'percentile 空集 NaN')

      const { initDb, db } = await import('../src/db')
      const T = await import('../src/db/schema')
      await initDb()
      const seeded = await seedDataset(db, T, { projects: 2, assetsPerProject: 2, chainLength: 3, canvasNodes: 4 })
      const ps = await db.select().from(T.projects)
      const rs = await db.select().from(T.pipelineRuns)
      const st = await db.select().from(T.pipelineSteps)
      const nd = await db.select().from(T.canvasNodes)
      check(ps.length >= 2 && seeded.counts.assets === 4, `seedDataset 小样本项目/资产落库（${ps.length} 项目 / ${seeded.counts.assets} 资产）`)
      check(rs.length >= 2 && st.length === rs.length * 3 && nd.length >= 4, `seedDataset run 长链 + 大画布种子（${rs.length} run / ${st.length} 步 / ${nd.length} 节点）`)
    },
  }

  await runSections({ log, title: 'M26', checker, sections: SECTIONS, runners, cleanup })
}

void main()
