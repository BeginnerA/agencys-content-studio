/**
 * M65 离线回归探针：执行链状态与计费安全。
 * 不读取正式库，不访问网络；供应商适配器由本探针注册为内存假实现。
 */
import { isolatedEnv, makeChecker, runSections } from './probe-lib'

const { cleanup } = isolatedEnv('m65')
const { createLogger } = await import('../src/logger')
const log = createLogger('probe-m65')
const checker = makeChecker(log)
const check = checker.check

/** 视频重试：取得第三方 task_id 后，下载失败重试不得再次提交生成任务。 */
async function probeVideoRetryReusesSubmission(): Promise<void> {
  const { db, initDb } = await import('../src/db')
  const { pipelineRuns, pipelineSteps, projects, genTasks, apiConfigs } = await import('../src/db/schema')
  const { writeTextAsset } = await import('../src/services/storage')
  const { registerVideoAdapter } = await import('@agencys/ai-provider-kit')
  const { aiVideo } = await import('../src/pipeline/actions/ai-video')
  const { eq } = await import('drizzle-orm')

  await initDb()
  const now = Date.now()
  const [project] = await db.insert(projects).values({ name: 'M65 视频重试', createdAt: now, updatedAt: now }).returning()
  const [run] = await db
    .insert(pipelineRuns)
    .values({
      projectId: project!.id,
      templateKey: 'm65-video-retry',
      status: 'running',
      input: '{}',
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  const [step] = await db
    .insert(pipelineSteps)
    .values({
      runId: run!.id,
      seq: 1,
      stepKey: 'motion',
      actionKey: 'ai_video',
      status: 'running',
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  await db.insert(apiConfigs).values({
    providerKey: 'localai_video',
    serviceType: 'video',
    name: 'M65 假视频实例',
    baseUrl: 'http://fake.local',
    apiKeyRef: 'local',
    model: 'fake-video',
    extra: '{}',
    isDefault: 1,
    isActive: 1,
    createdAt: now,
    updatedAt: now,
  })
  const shotsAsset = await writeTextAsset(project!.id, {
    name: 'shots.json',
    content: JSON.stringify([{ id: 's1', image_prompt: '推镜', duration: 5 }]),
    purpose: 'shots',
  })

  let generateCalls = 0
  let queryCalls = 0
  registerVideoAdapter('localai_video', {
    provider: 'localai_video',
    firstFrame: 'none',
    referenceImages: 'none',
    async generate() {
      generateCalls += 1
      return { kind: 'poll', taskId: 'M65-EXT-1' }
    },
    async query() {
      queryCalls += 1
      return { status: 'completed', url: 'http://fake.local/video.mp4' }
    },
  })

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('M65 强制下载失败')
  }) as typeof fetch

  try {
    const ctx = {
      run,
      step,
      template: { key: 'm65-video-retry', version: 1, name: 'M65', genre: 'test', inputs: [], steps: [] },
      def: { key: 'motion', action: 'ai_video', title: '视频', inputs: {}, batch: { field: 'shots', maxConcurrent: 1, retry: 1 } },
      input: {},
      settings: { video: { provider: 'localai_video', model: 'fake-video', duration: 5 } },
      log: () => undefined,
      assetIdsOf: (key: string) => (key === 'shots' ? [shotsAsset.id] : []),
      readText: async () => JSON.stringify([{ id: 's1', image_prompt: '推镜', duration: 5 }]),
      pathOf: async () => '',
      assetsOf: async () => [],
    } as unknown as Parameters<typeof aiVideo>[0]

    let failed = false
    try {
      await aiVideo(ctx)
    } catch {
      failed = true
    }
    const [task] = await db.select().from(genTasks).where(eq(genTasks.runId, run!.id))
    check(failed, '下载持续失败时动作最终报错')
    check(task?.taskId === 'M65-EXT-1', '第三方 task_id 已持久化')
    check(task?.status === 'failed', '重试耗尽后任务为 failed')
    check(generateCalls === 1, `下载失败重试只提交一次生成（实际 ${generateCalls} 次）`)
    // 首轮已取到成片地址：落盘失败重试直接复用，既不再提交也不重复查询
    check(queryCalls === 1, `下载失败重试复用已受理成片，不重复查询（实际 ${queryCalls} 次）`)
  } finally {
    globalThis.fetch = originalFetch
  }
}

/** 驳回非 stop 闸门：媒体任务必须重排队、清外部 task_id，重做后重新挂审阅。 */
async function probeGateRejectRedoesAndReReviews(): Promise<void> {
  const { db, initDb } = await import('../src/db')
  const { pipelineRuns, pipelineSteps, projects, genTasks } = await import('../src/db/schema')
  const { engine } = await import('../src/pipeline/engine')
  const { eq, and } = await import('drizzle-orm')

  await initDb()
  const now = Date.now()
  const [project] = await db.insert(projects).values({ name: 'M65 闸门驳回', createdAt: now, updatedAt: now }).returning()
  const template = {
    key: 'm65-gate-reject',
    version: 1,
    name: 'M65 闸门',
    genre: 'test',
    inputs: [],
    steps: [
      {
        key: 'frames',
        action: 'literal',
        title: '画面',
        inputs: {},
        params: { payload: 'frames' },
        gate: { mode: 'required', message: '请审阅画面' },
      },
    ],
  }
  const [run] = await db
    .insert(pipelineRuns)
    .values({
      projectId: project!.id,
      templateKey: template.key,
      templateSnapshot: JSON.stringify(template),
      status: 'waiting_input',
      currentStepKey: 'frames',
      input: '{}',
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  const [step] = await db
    .insert(pipelineSteps)
    .values({
      runId: run!.id,
      seq: 1,
      stepKey: 'frames',
      actionKey: 'literal',
      status: 'waiting_input',
      output: JSON.stringify({ asset_ids: [] }),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  const [task] = await db
    .insert(genTasks)
    .values({
      projectId: project!.id,
      runId: run!.id,
      stepId: step!.id,
      kind: 'video',
      provider: 'localai_video',
      prompt: '旧镜头',
      params: JSON.stringify({ shotId: 's1' }),
      taskId: 'M65-OLD-TASK',
      status: 'succeeded',
      attempts: 1,
      resultAssetId: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()

  await engine.rejectGate(run!.id, 'frames', { note: '重新生成' })
  for (let i = 0; i < 200; i++) {
    if (!engine.isRunning(run!.id)) break
    await new Promise((r) => setTimeout(r, 25))
  }

  const [freshTask] = await db.select().from(genTasks).where(eq(genTasks.id, task!.id))
  const [freshStep] = await db
    .select()
    .from(pipelineSteps)
    .where(and(eq(pipelineSteps.runId, run!.id), eq(pipelineSteps.stepKey, 'frames')))
  const [freshRun] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run!.id))
  check(freshTask?.status === 'pending' && freshTask.attempts === 0, '驳回后旧成功媒体任务重排队且尝试数归零')
  check(freshTask?.taskId === null, '驳回后清空第三方 task_id，重做不得续轮询旧成片')
  check(freshStep?.status === 'waiting_input', '重做完成后再次挂起审阅，不因旧 reject 免审')
  check(freshStep?.attempts === 1, '重做确实执行了一轮')
  check(freshRun?.status === 'waiting_input', 'run 回到等待审阅状态')
}

/** 并行执行中批准：另一并行步尚未收敛时，批准不能丢失续跑唤醒。 */
async function probeApproveDuringParallelKeepsWakeup(): Promise<void> {
  const { db, initDb } = await import('../src/db')
  const { pipelineRuns, pipelineSteps, projects } = await import('../src/db/schema')
  const { engine } = await import('../src/pipeline/engine')
  const { eq } = await import('drizzle-orm')

  await initDb()
  const now = Date.now()
  const [project] = await db.insert(projects).values({ name: 'M65 并行审批', createdAt: now, updatedAt: now }).returning()
  const template = {
    key: 'm65-parallel-gate',
    version: 1,
    name: 'M65 并行闸门',
    genre: 'test',
    inputs: [],
    steps: [
      {
        key: 'frames',
        action: 'literal',
        title: '画面',
        inputs: {},
        params: { payload: 'frames' },
        after: [],
        gate: { mode: 'required', message: '请审阅画面' },
      },
      { key: 'slow', action: 'literal', title: '慢步骤', inputs: {}, params: { payload: 'slow' }, after: [] },
    ],
  }
  const [run] = await db
    .insert(pipelineRuns)
    .values({
      projectId: project!.id,
      templateKey: template.key,
      templateSnapshot: JSON.stringify(template),
      status: 'queued',
      input: '{}',
      createdAt: now,
      updatedAt: now,
    })
    .returning()

  const target = engine as unknown as {
    executeStep: (...args: unknown[]) => Promise<'ok' | 'waiting' | 'failed' | 'skipped'>
  }
  const original = target.executeStep.bind(engine)
  target.executeStep = async (...args: unknown[]) => {
    const def = args[2] as { key?: string }
    if (def?.key === 'slow') await new Promise((r) => setTimeout(r, 200))
    return original(...args)
  }

  try {
    engine.startRun(run!.id)
    // 等闸门步挂起（并行慢步仍在执行）
    for (let i = 0; i < 100; i++) {
      const [current] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run!.id))
      if (current?.status === 'waiting_input') break
      await new Promise((r) => setTimeout(r, 10))
    }
    const [before] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run!.id))
    check(before?.status === 'waiting_input', '并行慢步执行期间闸门步先挂起')
    await engine.approveGate(run!.id, 'frames', { note: '通过' })
    for (let i = 0; i < 200; i++) {
      if (!engine.isRunning(run!.id)) break
      await new Promise((r) => setTimeout(r, 25))
    }
    const [after] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run!.id))
    const steps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, run!.id))
    check(after?.status === 'completed', `并行步收敛后继续执行并完成（实际 ${after?.status}）`)
    check(steps.every((s) => s.status === 'succeeded'), '批准步与并行步均成功')
  } finally {
    target.executeStep = original
  }
}

await runSections({
  log,
  title: 'M65',
  checker,
  cleanup,
  sections: ['video-retry', 'gate-reject', 'parallel-approve'],
  runners: {
    'video-retry': probeVideoRetryReusesSubmission,
    'gate-reject': probeGateRejectRedoesAndReReviews,
    'parallel-approve': probeApproveDuringParallelKeepsWakeup,
  },
})
