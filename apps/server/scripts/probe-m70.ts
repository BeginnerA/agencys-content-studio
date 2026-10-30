import { cleanup } from './probes/m70/bootstrap'
import { makeChecker, runSections } from './probe-lib'

const { createLogger } = await import('../src/logger')
const log = createLogger('probe-m70')
const checker = makeChecker(log)
await runSections({
  log, title: 'M70', checker, cleanup, sections: ['contract', 'fold', 'sources', 'entries', 'context', 'invocation', 'run-binding', 'workflow', 'route'],
  runners: {
    contract: async () => (await import('./probes/m70/contract')).runContract(checker),
    fold: async () => (await import('./probes/m70/fold')).runFold(checker),
    sources: async () => (await import('./probes/m70/sources')).runSources(checker),
    entries: async () => (await import('./probes/m70/entries')).runEntries(checker),
    context: async () => (await import('./probes/m70/context')).runContext(checker),
    invocation: async () => (await import('./probes/m70/invocation')).runInvocation(checker),
    'run-binding': async () => (await import('./probes/m70/run-binding')).runRunBinding(checker),
    workflow: async () => (await import('./probes/m70/workflow')).runWorkflow(checker),
    route: async () => (await import('./probes/m70/route')).runRoute(checker),
  },
})
log.info('M70 assertion totals', { passed: checker.passed, failed: checker.failed })
