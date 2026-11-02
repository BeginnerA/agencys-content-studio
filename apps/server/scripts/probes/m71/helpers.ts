/**
 * 探针测试辅助工具
 *
 * 提供 test() 包装器：将 assert 异常转为 checker.check(false, ...)，
 * 与各 m70 分节保持同一断言风格。
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
