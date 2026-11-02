/**
 * 探针测试辅助工具（复用既有实现）
 *
 * 提供 test() 包装器：将 assert 异常转为 checker.check(false, ...)，
 * 与各分节保持同一断言风格。
 */
export { test } from '../m71/helpers'
