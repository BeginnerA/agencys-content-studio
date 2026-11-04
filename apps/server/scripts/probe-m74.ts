/**
 * Character-consistency engineering probe entry point.
 *
 * Covers:
 *   1. Selection — layered reference picking (implicit baseline, state-hit priority, fallbacks, caps)
 *   2. Caps — per-provider reference-count and negative-prompt capability registry
 *   3. Service — reference layering service over the real database (add / patch / remove / backfill / preview)
 *   4. Consistency — per-character evaluation over the real chain with a stubbed scoring transport
 *   5. Endpoints — REST contract for every layered-reference and consistency route (real app mount), plus delete-cascade
 *   6. Ref-caps engine — real aiImage enqueue: model-cap tightening lands in the params snapshot (selection ⊆ sent, cap-cut reason, fallback trace)
 *
 * Constraint: no real paid-model calls, no network, fully isolated SQLite + seed data.
 */
import { blockedAttempts, cleanup } from './probes/m74/bootstrap'
import { makeChecker, runSections } from './probe-lib'

const { createLogger } = await import('../src/logger')
const log = createLogger('probe-character-consistency')
const checker = makeChecker(log)

/**
 * 每节收尾复检外发纪律：默认 fetch 守卫一旦被调用即计数，计数不为零说明某条链路绕过了替身。
 * 逐节复检（而非只在评分节末尾查一次）才能证明其余各节的读写面同样没有真实网络出口。
 */
const guardNetwork = (name: string, run: () => Promise<void>) => async () => {
  await run()
  checker.check(blockedAttempts() === 0, `分节「${name}」收尾零未拦截外发（累计 ${blockedAttempts()} 次）`)
}

await runSections({
  log,
  title: 'Character-Consistency',
  checker,
  cleanup,
  sections: ['selection', 'caps', 'ref-caps-e2e', 'service', 'consistency', 'endpoints'],
  runners: {
    selection: guardNetwork('selection', async () => (await import('./probes/m74/selection')).runSelection(checker)),
    caps: guardNetwork('caps', async () => (await import('./probes/m74/caps')).runCaps(checker)),
    'ref-caps-e2e': guardNetwork('ref-caps-e2e', async () => (await import('./probes/m74/ref-caps-e2e')).runRefCaps(checker)),
    service: guardNetwork('service', async () => (await import('./probes/m74/service')).runService(checker)),
    consistency: guardNetwork('consistency', async () => (await import('./probes/m74/consistency')).runConsistency(checker)),
    endpoints: guardNetwork('endpoints', async () => (await import('./probes/m74/endpoints')).runEndpoints(checker)),
  },
})

log.info('character-consistency assertion totals', { passed: checker.passed, failed: checker.failed })
