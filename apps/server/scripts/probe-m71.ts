/**
 * 质量基线探针入口
 *
 * 覆盖：
 *   1. 评分服务 —— 四维评分计算正确性 + 持久化 + 幂等性
 *   2. 评分存储 —— quality_scores 表结构 / 索引 / 外键 / JSON 字段
 *   3. 权重调整 —— 自定义权重影响综合分 + 极端权重退化 + 部分覆盖
 *   4. 可复现性 —— metadata 记录完整（templateVersion / promptVersion / model / params / assetVersions）
 *
 * 红线：不调用真实付费模型，不联网，全部基于隔离 SQLite + 种子数据。
 */
import { cleanup } from './probes/m71/bootstrap'
import { makeChecker, runSections } from './probe-lib'

const { createLogger } = await import('../src/logger')
const log = createLogger('probe-m71')
const checker = makeChecker(log)

await runSections({
  log,
  title: 'M71',
  checker,
  cleanup,
  sections: ['service', 'storage', 'weights', 'metadata'],
  runners: {
    service: async () => (await import('./probes/m71/service')).runService(checker),
    storage: async () => (await import('./probes/m71/storage')).runStorage(checker),
    weights: async () => (await import('./probes/m71/weights')).runWeights(checker),
    metadata: async () => (await import('./probes/m71/metadata')).runMetadata(checker),
  },
})

log.info('M71 assertion totals', { passed: checker.passed, failed: checker.failed })
