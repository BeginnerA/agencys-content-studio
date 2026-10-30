import { AsyncLocalStorage } from 'node:async_hooks'
import { checkBudget } from '../budget'
import { chatCompleteDetailed, resolveLlmEndpoint } from '../llm'
import { recordLlmUsage } from '../usage'
import type { ContinuityIO } from './contract'

const scope = new AsyncLocalStorage<ContinuityIO>()
// Resolving endpoint/configuration happens at invocation, never at module initialization.
const defaultIO: ContinuityIO = {
  chat: chatCompleteDetailed, endpoint: resolveLlmEndpoint, budget: checkBudget,
  usage: recordLlmUsage, now: Date.now, fault: () => {},
}
export function continuityIO(): ContinuityIO { return scope.getStore() ?? defaultIO }
export function withContinuityIO<T>(io: ContinuityIO, fn: () => Promise<T>): Promise<T> { return scope.run(io, fn) }
