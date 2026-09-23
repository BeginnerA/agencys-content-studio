/** M16⑥ regression：probe:m15 子进程全绿（内含 m2a/m4/m14）+ 新列兼容抽样（断言体逐字搬自原 probe-m16.ts） */
import { join } from 'node:path'
import type { M16Ctx } from './ctx'

export async function run(ctx: M16Ctx): Promise<void> {
  const { check, mkTask, db, genTasks, and, eq, isNull, PID, A1, REPO_ROOT } = ctx
  // 兼容抽样：普通任务（run/step 归属，canvasNodeId null）读写不受新列影响
  const tRun = await mkTask(PID, { runId: 778899, stepId: 3, status: 'succeeded', resultAssetId: A1 })
  const hit = await db.select().from(genTasks).where(and(eq(genTasks.runId, 778899), isNull(genTasks.canvasNodeId)))
  check(hit.length === 1 && hit[0]?.id === tRun, '兼容抽样：既有 run 任务查询（canvasNodeId is null）命中')

  const { spawnSync } = await import('node:child_process')
  const childEnv = { ...process.env }
  delete childEnv.CSTUDIO_ROOT
  delete childEnv.CSTUDIO_DATA
  delete childEnv.CSTUDIO_WORKSPACE
  // 直接以 tsx 运行前序探针脚本（M26 runner 收敛后无 probe:<id> 包脚本，经 process.execPath 与 run-probes 同款启动式）
  const script = join(REPO_ROOT, 'apps', 'server', 'scripts', 'probe-m15.ts')
  const r = spawnSync(process.execPath, ['--import', 'tsx', script], {
    cwd: join(REPO_ROOT, 'apps', 'server'),
    env: childEnv,
    encoding: 'utf8',
    timeout: 15 * 60_000,
  })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  const tail = out
    .split('\n')
    .filter((l) => l.includes('探针结果') || l.includes('FAIL'))
    .slice(-3)
    .join(' | ')
  check(r.status === 0, `probe:m15 全绿（内含 m2a/m4/m14 零漂移；exit=${String(r.status)}${r.status === 0 ? '' : `；${tail || out.slice(-300).trim()}`}）`)
}
