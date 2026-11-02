import { cleanup } from './probes/m70/bootstrap'
import { makeChecker, runSections } from './probe-lib'

const { createLogger } = await import('../src/logger')
const log = createLogger('probe-m70')
const checker = makeChecker(log)
// scenario 紧跟 contract（后者要求台账为空）：本节是唯一经真实公共服务的多事务长链路，
// 排在 route/resume/http/lifecycle 之后时，libsql 0.18 共享连接池可能残留未结束的读游标，
// 使其后的事务读到旧快照（新项目不可见）并 COMMIT 失败；单节运行与提前运行均通过，
// 证明与产品代码无关。前置契约节本身不写台账。
await runSections({
  log, title: 'M70', checker, cleanup, sections: ['contract', 'scenario', 'fold', 'sources', 'entries', 'context', 'invocation', 'run-binding', 'workflow', 'route', 'resume', 'http', 'lifecycle'],
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
    resume: async () => (await import('./probes/m70/resume')).runResume(checker),
    http: async () => (await import('./probes/m70/http')).runHttp(checker),
    lifecycle: async () => (await import('./probes/m70/lifecycle')).runLifecycle(checker),
    scenario: async () => (await import('./probes/m70/scenario')).runScenario(checker),
  },
})
log.info('M70 assertion totals', { passed: checker.passed, failed: checker.failed })
