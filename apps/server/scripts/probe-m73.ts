/**
 * Multi-stage quality check probe entry point.
 *
 * Covers:
 *   1. Adapters — QC report / delivery cert / score → QualityIssueInput conversion
 *   2. Gate evaluation — exempt / unexempt / reevaluate lifecycle
 *   3. Stage check service — runStage / runAllStages orchestration
 *   4. Storage — table schemas, indexes, constraints, data integrity
 *   5. Endpoints — REST contract for all 5 quality-gates routes
 *
 * Constraint: no real model calls, no network, fully isolated SQLite + seed data.
 */
import { cleanup } from './probes/m73/bootstrap'
import { makeChecker, runSections } from './probe-lib'

const { createLogger } = await import('../src/logger')
const log = createLogger('probe-m73')
const checker = makeChecker(log)

await runSections({
  log,
  title: 'M73',
  checker,
  cleanup,
  sections: ['adapters', 'gate-eval', 'service', 'storage', 'endpoints'],
  runners: {
    adapters: async () => (await import('./probes/m73/adapters')).runAdapters(checker),
    'gate-eval': async () => (await import('./probes/m73/gate-eval')).runGateEval(checker),
    service: async () => (await import('./probes/m73/service')).runService(checker),
    storage: async () => (await import('./probes/m73/storage')).runStorage(checker),
    endpoints: async () => (await import('./probes/m73/endpoints')).runEndpoints(checker),
  },
})

log.info('M73 assertion totals', { passed: checker.passed, failed: checker.failed })
