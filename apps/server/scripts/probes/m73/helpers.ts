/**
 * Test helper for multi-stage quality check probe.
 *
 * Wraps assert-throwing test bodies into checker.check(true/false, ...)
 * so that each test counts as one PASS or FAIL assertion without aborting
 * the remaining sections.
 */
import type { Checker } from '../../probe-lib'

export async function test(checker: Checker, name: string, body: () => void | Promise<void>) {
  try {
    await body()
    checker.check(true, name)
  } catch (e) {
    checker.check(false, `${name}: ${(e as Error).message}`)
  }
}
