/**
 * 修复闭环探针入口
 *
 * 覆盖：
 *   1. 修复建议服务 —— proposeRepair 问题识别 / 建议生成 / 影响范围 / 费用估算
 *   2. 修复执行服务 —— executeRepair 状态机 / 停止条件 / 异常处理
 *   3. 修复端点契约 —— POST/GET 各端点输入/输出/错误
 *   4. 修复存储结构 —— repair_runs 表 / 索引 / 外键 / JSON 字段
 *
 * 红线：不调用真实付费模型，不联网，全部基于隔离 SQLite + 种子数据。
 */
import { cleanup } from './probes/m72/bootstrap'
import { makeChecker, runSections } from './probe-lib'

const { createLogger } = await import('../src/logger')
const log = createLogger('probe-m72')
const checker = makeChecker(log)

await runSections({
  log,
  title: 'M72',
  checker,
  cleanup,
  sections: ['service', 'executor', 'endpoints', 'storage'],
  runners: {
    service: async () => (await import('./probes/m72/service')).runService(checker),
    executor: async () => (await import('./probes/m72/executor')).runExecutor(checker),
    endpoints: async () => (await import('./probes/m72/endpoints')).runEndpoints(checker),
    storage: async () => (await import('./probes/m72/storage')).runStorage(checker),
  },
})

log.info('M72 assertion totals', { passed: checker.passed, failed: checker.failed })
