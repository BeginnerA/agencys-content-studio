/**
 * M26·H3 规模化压测与性能基准（scripts/bench-stress.ts）——手动执行：
 *   cd apps/server && npx tsx scripts/bench-stress.ts [--projects=1000 --assets-per-project=10 --chain-length=20 --canvas-nodes=1000 --reps=11 --out=<path>]
 *
 * 隔离临时库（acs-probe-bench-*）批量种合成数据（无真实生成、零网络、零计费）→ 量测关键列表/聚合查询
 * （项目分页 / 资产面板聚合 / run 长链批次聚合 / canvas overview 批次聚合）+ buildCanvasDoc 大图读模型
 * 耗时 + 内存 RSS 峰值 → 结构化基准报告（各量测 p50/p95/max + 数据规模）落 review 文。
 *
 * 非 CI 阻断：仅产出一次性基准供方法库沉淀（回补纲领 §一 D10 = M23 规模化性能基准）；临时库自动清理。
 * 纯函数 seedDataset / percentile 由 probe-m26 `stress` 节小样本背书——本文件顶层仅 `typeof import` 类型
 * 查询（编译期擦除，零运行时 src 依赖），main() 仅在直接运行时经守卫执行，被 import 不触发副作用。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { REPO_ROOT, isolatedEnv } from './probe-lib'

type Db = typeof import('../src/db').db
type Schema = typeof import('../src/db/schema')

export interface SeedTables {
  projects: Schema['projects']
  assets: Schema['assets']
  pipelineRuns: Schema['pipelineRuns']
  pipelineSteps: Schema['pipelineSteps']
  canvases: Schema['canvases']
  canvasNodes: Schema['canvasNodes']
  canvasEdges: Schema['canvasEdges']
}

export interface SeedSpec {
  projects: number
  assetsPerProject: number
  /** 每个 run 的 step 链长度（长 run 链量测面） */
  chainLength: number
  /** 大图画布节点数（buildCanvasDoc 读模型组装量测面） */
  canvasNodes: number
}

export interface SeedResult {
  projectIds: number[]
  runIds: number[]
  bigCanvasId: number
  counts: { projects: number; assets: number; runs: number; steps: number; nodes: number; edges: number }
}

/** 就近排名百分位（p∈[0,100]；线性索引 round，钳位）——bench 报告量测原语（与 probe-m26 共享事实源） */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const s = [...values].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))
  return s[idx]!
}

const CHUNK = 500

/** 分块执行异步任务（避免一次性塞爆 drizzle 多行 insert 语句 / libsql 句柄） */
async function eachChunk<T>(items: T[], size: number, fn: (chunk: T[]) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await fn(items.slice(i, i + size))
}

/**
 * 批量种合成数据集（projects → assets / pipeline_runs+steps 长链 → 单个大画布 nodes+edges）；纯落库零网络。
 * 表引用由调用方注入（保持本函数顶层无运行时 src 依赖 → probe 可安全 import 背书）。
 */
export async function seedDataset(db: Db, T: SeedTables, spec: SeedSpec): Promise<SeedResult> {
  const now = Date.now()
  const projectIds: number[] = []
  await eachChunk(Array.from({ length: spec.projects }, (_, i) => i), CHUNK, async (chunk) => {
    const rows = await db
      .insert(T.projects)
      .values(chunk.map((i) => ({ name: `bench-p-${i}`, genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: now, updatedAt: now })))
      .returning({ id: T.projects.id })
    projectIds.push(...rows.map((r) => r.id))
  })

  const assetRows = projectIds.flatMap((pid, i) =>
    Array.from({ length: spec.assetsPerProject }, (_, j) => ({
      projectId: pid,
      kind: ['image', 'video', 'audio', 'text'][j % 4]!,
      purpose: ['source', 'storyboard', 'shot_image', 'final_video'][j % 4]!,
      name: `bench-a-${i}-${j}`,
      mime: 'application/octet-stream',
      fileSize: 1024 + j,
      tags: '[]',
      createdAt: now,
      updatedAt: now,
    })),
  )
  await eachChunk(assetRows, CHUNK, async (chunk) => {
    await db.insert(T.assets).values(chunk)
  })

  const runIds: number[] = []
  await eachChunk(projectIds, CHUNK, async (chunk) => {
    const rows = await db
      .insert(T.pipelineRuns)
      .values(chunk.map((pid) => ({ projectId: pid, templateKey: 'mengbao-episode', status: 'completed', input: '{}', createdAt: now, updatedAt: now })))
      .returning({ id: T.pipelineRuns.id })
    runIds.push(...rows.map((r) => r.id))
  })
  const stepRows = runIds.flatMap((rid) =>
    Array.from({ length: spec.chainLength }, (_, s) => ({
      runId: rid,
      seq: s + 1,
      stepKey: `step_${s + 1}`,
      actionKey: 'noop',
      title: `step_${s + 1}`,
      status: s % 5 === 4 ? 'failed' : 'succeeded',
      createdAt: now,
      updatedAt: now,
    })),
  )
  await eachChunk(stepRows, CHUNK, async (chunk) => {
    await db.insert(T.pipelineSteps).values(chunk)
  })

  const bigCanvasId = (await db.insert(T.canvases).values({ projectId: projectIds[0]!, name: 'bench-大画布', viewport: '{"x":0,"y":0,"zoom":1}', createdAt: now, updatedAt: now }).returning({ id: T.canvases.id }))[0]!.id
  const nodeIds: number[] = []
  await eachChunk(Array.from({ length: spec.canvasNodes }, (_, i) => i), CHUNK, async (chunk) => {
    const rows = await db
      .insert(T.canvasNodes)
      .values(chunk.map((i) => ({ canvasId: bigCanvasId, kind: ['text', 'gen', 'asset'][i % 3]!, title: `n${i}`, spec: i % 3 === 1 ? JSON.stringify({ genKind: 'image', prompt: `p${i}` }) : JSON.stringify({ text: `t${i}` }), x: i, y: i, createdAt: now, updatedAt: now })))
      .returning({ id: T.canvasNodes.id })
    nodeIds.push(...rows.map((r) => r.id))
  })
  const edgeRows = nodeIds.slice(1).map((to, i) => ({ canvasId: bigCanvasId, from: nodeIds[i]!, to, port: 'reference', createdAt: now }))
  await eachChunk(edgeRows, CHUNK, async (chunk) => {
    await db.insert(T.canvasEdges).values(chunk)
  })

  return {
    projectIds,
    runIds,
    bigCanvasId,
    counts: { projects: projectIds.length, assets: assetRows.length, runs: runIds.length, steps: stepRows.length, nodes: nodeIds.length, edges: edgeRows.length },
  }
}

interface Metric {
  label: string
  desc: string
  samples: number[]
  rows: number
}

function argvFlag(name: string, dft: number): number {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`))
  return a ? Number(a.slice(name.length + 3)) : dft
}

async function main(): Promise<void> {
  const { tmp: TMP, cleanup } = isolatedEnv('bench')
  const { db, initDb, sqlite } = await import('../src/db')
  const T = await import('../src/db/schema')
  const { asc, count, eq, inArray } = await import('drizzle-orm')
  const { buildCanvasDoc } = await import('../src/services/creation/doc')

  const projects = argvFlag('projects', 1000)
  const assetsPerProject = argvFlag('assets-per-project', 10)
  const chainLength = argvFlag('chain-length', 20)
  const canvasNodeCount = argvFlag('canvas-nodes', 1000)
  const reps = Math.max(3, argvFlag('reps', 11))

  await initDb()
  let rssPeak = process.memoryUsage().rss
  const sampleRss = (): void => {
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss)
  }

  console.log(`▶ 种子（项目=${projects} / 资产=${assetsPerProject}·每项目 / run链=${chainLength}步 / 大画布节点=${canvasNodeCount}）…`)
  const t0 = Date.now()
  const seeded = await seedDataset(db, T, { projects, assetsPerProject, chainLength, canvasNodes: canvasNodeCount })
  const seedMs = Date.now() - t0
  sampleRss()
  console.log(`  种子完成：${seeded.counts.projects} 项目 / ${seeded.counts.assets} 资产 / ${seeded.counts.runs} run / ${seeded.counts.steps} 步 / ${seeded.counts.nodes} 节点（${(seedMs / 1000).toFixed(1)}s）`)

  const pageSample = seeded.projectIds.slice(0, reps)
  const runBatch = seeded.runIds.slice(0, 50)
  const projSample = seeded.projectIds[0]!
  const surfaces: Array<{ label: string; desc: string; rows: number; run: (i: number) => Promise<unknown> }> = [
    { label: '项目分页', desc: 'ORDER BY id LIMIT 50 OFFSET k（列表页翻页）', rows: 50, run: (i) => db.select().from(T.projects).orderBy(asc(T.projects.id)).limit(50).offset((i % pageSample.length) * 20) },
    { label: '资产面板聚合', desc: '单项目 GROUP BY purpose 计数（资产面板分桶）', rows: assetsPerProject, run: () => db.select({ purpose: T.assets.purpose, n: count() }).from(T.assets).where(eq(T.assets.projectId, projSample)).groupBy(T.assets.purpose) },
    { label: '资产全局聚合', desc: '全量 GROUP BY kind 计数（跨项目资产总览）', rows: seeded.counts.assets, run: () => db.select({ kind: T.assets.kind, n: count() }).from(T.assets).groupBy(T.assets.kind) },
    { label: 'run 长链批次聚合', desc: `50 run × ${chainLength} 步 GROUP BY runId 计数（进度面板）`, rows: runBatch.length * chainLength, run: () => db.select({ runId: T.pipelineSteps.runId, n: count() }).from(T.pipelineSteps).where(inArray(T.pipelineSteps.runId, runBatch)).groupBy(T.pipelineSteps.runId) },
    { label: 'canvas overview 批次聚合', desc: `${seeded.counts.nodes} 节点 GROUP BY canvasId,kind 计数（画布总览）`, rows: seeded.counts.nodes, run: () => db.select({ canvasId: T.canvasNodes.canvasId, kind: T.canvasNodes.kind, n: count() }).from(T.canvasNodes).groupBy(T.canvasNodes.canvasId, T.canvasNodes.kind) },
    { label: 'buildCanvasDoc 大图', desc: '大画布读模型组装（节点/边/组 + 任务/实体/run 派生）', rows: seeded.counts.nodes, run: () => buildCanvasDoc(seeded.bigCanvasId) },
  ]

  const metrics: Metric[] = []
  for (const s of surfaces) {
    const samples: number[] = []
    for (let i = 0; i < reps; i++) {
      const a = process.hrtime.bigint()
      await s.run(i)
      samples.push(Number(process.hrtime.bigint() - a) / 1e6)
    }
    sampleRss()
    metrics.push({ label: s.label, desc: s.desc, samples, rows: s.rows })
    console.log(`  ✅ ${s.label.padEnd(22)} p50=${percentile(samples, 50).toFixed(2)}ms p95=${percentile(samples, 95).toFixed(2)}ms`)
  }

  const outArg = process.argv.find((x) => x.startsWith('--out='))
  const outPath = outArg ? outArg.slice('--out='.length) : join(REPO_ROOT, 'apps', 'server', 'scripts', 'review', 'bench-stress-report.md')
  const report = renderReport({ when: new Date().toISOString(), node: process.version, platform: process.platform, seedMs, counts: seeded.counts, chainLength, reps, metrics, rssPeakMB: rssPeak / 1048576 })
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, report, 'utf8')
  console.log(`\n📄 基准报告落：${outPath}`)

  try {
    sqlite.close()
  } catch {
    /* Windows libsql 句柄 */
  }
  cleanup()
}

function renderReport(x: { when: string; node: string; platform: string; seedMs: number; counts: SeedResult['counts']; chainLength: number; reps: number; metrics: Metric[]; rssPeakMB: number }): string {
  const lines: string[] = []
  lines.push('# M26·H3 规模化压测与性能基准报告')
  lines.push('')
  lines.push(`> 生成时间：${x.when} ｜ 运行时：node ${x.node} / ${x.platform} ｜ 隔离临时库（自清理，零网络零计费）`)
  lines.push('')
  lines.push('## 数据规模（合成种子）')
  lines.push('')
  lines.push('| 维度 | 行数 |')
  lines.push('| --- | ---: |')
  lines.push(`| projects | ${x.counts.projects} |`)
  lines.push(`| assets | ${x.counts.assets} |`)
  lines.push(`| pipeline_runs | ${x.counts.runs} |`)
  lines.push(`| pipeline_steps（长链 ${x.chainLength} 步/run） | ${x.counts.steps} |`)
  lines.push(`| canvas_nodes（大图画布） | ${x.counts.nodes} |`)
  lines.push(`| canvas_edges | ${x.counts.edges} |`)
  lines.push('')
  lines.push(`种子耗时：${(x.seedMs / 1000).toFixed(1)}s ｜ 每项量测采样：${x.reps} 次 ｜ RSS 峰值：${x.rssPeakMB.toFixed(1)} MB`)
  lines.push('')
  lines.push('## 量测面（本地查询 / 读模型组装，非阻断基准）')
  lines.push('')
  lines.push('| 量测项 | 说明 | 扫及行数 | p50(ms) | p95(ms) | max(ms) |')
  lines.push('| --- | --- | ---: | ---: | ---: | ---: |')
  for (const m of x.metrics) {
    lines.push(`| ${m.label} | ${m.desc} | ${m.rows} | ${percentile(m.samples, 50).toFixed(2)} | ${percentile(m.samples, 95).toFixed(2)} | ${Math.max(...m.samples).toFixed(2)} |`)
  }
  lines.push('')
  lines.push('## 结论')
  lines.push('')
  lines.push('- 本报告为**一次性基准快照**（非 CI 阻断、无趋势基线库），供规模化性能方法沉淀；对应纲领 §一 D10（M23 规模化性能基准，对齐 M26-H3 方法）。')
  lines.push('- 量测口径：同一隔离库、纯本地 drizzle 查询 / `buildCanvasDoc` 读模型组装，取就近排名百分位（p50/p95）。真实生产规模瓶颈另见服务层分页/索引优化。')
  lines.push('')
  return lines.join('\n')
}

// ---- 直接运行守卫（被 probe import 纯函数时不触发 main）----
const entry = (process.argv[1] ?? '').replace(/\\/g, '/')
if (entry.endsWith('/bench-stress.ts') || entry.endsWith('/bench-stress')) {
  void main().catch((err) => {
    console.error(`bench-stress 异常终止: ${(err as Error).stack ?? err}`)
    process.exitCode = 1
  })
}
