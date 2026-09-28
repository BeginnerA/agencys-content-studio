import { and, eq } from 'drizzle-orm'
import type { Checker } from '../../probe-lib'

/** 使用真实对白 DAG 和闸门，仅把媒体动作替换成离线 literal；不作为音画质量验收。 */
export async function probeDialogueEngine({ check }: Checker): Promise<void> {
  const { db, initDb } = await import('../../../src/db')
  const { projects, pipelineRuns, pipelineSteps } = await import('../../../src/db/schema')
  const { loadTemplate } = await import('../../../src/pipeline/loader')
  const { engine } = await import('../../../src/pipeline/engine')
  const { ensureProjectDirs } = await import('../../../src/services/storage')
  await initDb()
  const now = Date.now()
  const [project] = await db.insert(projects).values({ name: 'M44 引擎审阅', createdAt: now, updatedAt: now }).returning()
  ensureProjectDirs(project!.id)
  const runOf = async (id: number) => (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)))[0]!
  const stepOf = async (id: number, key: string) => (await db.select().from(pipelineSteps).where(and(eq(pipelineSteps.runId, id), eq(pipelineSteps.stepKey, key))))[0]!
  const settle = async (id: number) => {
    for (let i = 0; i < 200; i++) {
      if (!engine.isRunning(id)) return runOf(id)
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error('离线引擎未收敛')
  }
  const fetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('引擎探针禁止联网') }
  try {
    for (const key of ['easy-dialogue']) {
      for (const i2v of [false, true]) {
        const template = structuredClone(loadTemplate(key))
        template.key = 'm44-offline-engine'
        template.steps = template.steps.map((s) => ({ ...s, action: 'literal', batch: undefined, inputs: {}, params: { payload: s.key } }))
        const [run] = await db.insert(pipelineRuns).values({ projectId: project!.id, templateKey: template.key,
          templateSnapshot: JSON.stringify(template), input: JSON.stringify({ i2v, motion: true }), status: 'queued', createdAt: now, updatedAt: now }).returning()
        const id = run!.id
        engine.startRun(id)
        let current = await settle(id)
        if (i2v) {
          check(current.status === 'waiting_input' && current.currentStepKey === 'frames', '对白模板（已内置首帧审阅闸）先等待画面批准')
          await engine.approveGate(id, 'frames')
          current = await settle(id)
        }
        check(current.status === 'waiting_input' && current.currentStepKey === 'compose', `${key}/${i2v ? 'i2v' : 't2v'} 必须到达最终审阅，不因首帧跳过而空交付`)
        const compose = await stepOf(id, 'compose')
        const motion = await stepOf(id, 'motion')
        check(motion.status === 'succeeded' && compose.status === 'waiting_input' && !!compose.output?.includes('asset_ids'), '视频和字幕之后保留本轮待审产物')
        if (compose.status !== 'waiting_input') continue
        let blocked = false
        try { await engine.skipGate(id, 'compose') } catch { blocked = true }
        check(blocked, '最终人物对白审阅不能免审跳过')
        if (!blocked) {
          await settle(id)
          await db.update(pipelineSteps).set({ status: 'waiting_input', output: compose.output }).where(eq(pipelineSteps.id, compose.id))
          await db.update(pipelineRuns).set({ status: 'waiting_input' }).where(eq(pipelineRuns.id, id))
        }
        await engine.rejectGate(id, 'compose', { note: '角色口型不接受' })
        current = await settle(id)
        const rejected = await stepOf(id, 'compose')
        check(current.status === 'failed' && rejected.status === 'failed' && rejected.attempts === compose.attempts, '拒绝只进入可返修状态，不自动重做或产生请求')
        check(JSON.parse(rejected.output!).asset_ids.join() === JSON.parse(compose.output!).asset_ids.join(), '拒绝保留本轮成片和审阅意见')
        // 模拟显式返修重置，刻意保留旧 reject，证明新合成仍须重新审阅。
        await db.update(pipelineSteps).set({ status: 'pending', error: null }).where(eq(pipelineSteps.id, compose.id))
        await db.update(pipelineRuns).set({ status: 'queued', error: null }).where(eq(pipelineRuns.id, id))
        engine.startRun(id)
        current = await settle(id)
        check(current.status === 'waiting_input' && (await stepOf(id, 'compose')).attempts === compose.attempts + 1, '重新合成后的旧拒绝不能豁免本轮审阅')
        if (current.status === 'waiting_input') {
          await engine.approveGate(id, 'compose', { note: '内容、角色和口型可接受' })
          check((await settle(id)).status === 'completed', '最终人工接受后才交付完成')
        }
      }
    }
  } finally { globalThis.fetch = fetch }
}
