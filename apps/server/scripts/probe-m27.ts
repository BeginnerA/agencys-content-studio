/**
 * M27 探针（自动编排 / 真 orchestrator）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m27.ts [--section=schema|workflow-crud|segment-input|auto-advance|budget-gate|breakpoint-pause|recovery-guard|nesting-clone|overview-workflows]
 *
 * 零网络零计费，隔离临时库（acs-probe-m27-*）。探针模板走 manual_ingest（离线无 LLM）。
 *   P0：schema / workflow-crud
 *   P1：segment-input / auto-advance / budget-gate / breakpoint-pause / nesting-clone
 *   P2 追加：overview-workflows
 *   P3 追加：recovery-guard（CodeReview #1/#2/#3 修复回归）
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

// ---- 隔离环境：必须先于任何 src/env 加载 ----
const { cleanup } = isolatedEnv('m27')

const SECTIONS = ['schema', 'workflow-crud', 'segment-input', 'auto-advance', 'budget-gate', 'breakpoint-pause', 'recovery-guard', 'nesting-clone', 'overview-workflows'] as const

/** 探针链模板：manual_ingest（离线，brief 落文本资产 purpose=brief） */
const TPL_INGEST = `key: probe-m27-ingest
version: 1
name: M27 链探针（入库）
genre: other
inputs:
  - { key: brief, label: 简报, kind: text, required: true }
steps:
  - key: ingest
    action: manual_ingest
    title: 入库
    inputs:
      brief: input.brief
`

/** 输入映射矩阵模板：多 kind inputs（含 default / optional）；步骤复用 manual_ingest */
const TPL_MULTI = `key: probe-m27-multi
version: 1
name: M27 输入映射探针
genre: other
inputs:
  - { key: brief, label: 简报, kind: text, required: true }
  - { key: imgs, label: 图, kind: files, required: true }
  - { key: n, label: 数, kind: int, required: false, default: 3 }
  - { key: mode, label: 模式, kind: text, required: false }
steps:
  - key: ingest
    action: manual_ingest
    title: 入库
    inputs:
      brief: input.brief
`

function writeProbeTemplates(): void {
  const dir = join(process.env.CSTUDIO_WORKSPACE!, 'templates')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'probe-m27-ingest.yaml'), TPL_INGEST, 'utf8')
  writeFileSync(join(dir, 'probe-m27-multi.yaml'), TPL_MULTI, 'utf8')
}

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m27')
  const checker: Checker = makeChecker(log)
  const { check } = checker

  // 共用建项目助手（各节复用）
  const mkProject = async (): Promise<number> => {
    const { initDb, db } = await import('../src/db')
    const { projects } = await import('../src/db/schema')
    await initDb()
    const t = Date.now()
    const p = (
      await db
        .insert(projects)
        .values({ name: `probe-m27-${t}`, genre: 'other', templateKey: 'mengbao-episode', status: 'active', settings: '{}', tags: '[]', createdAt: t, updatedAt: t })
        .returning()
    )[0]!
    return p.id
  }

  const runners: Record<string, () => Promise<void>> = {
    // ============ schema：建表 + 加列兜底 ============
    schema: async () => {
      const { initDb, db } = await import('../src/db')
      const { workflows, pipelineRuns } = await import('../src/db/schema')
      await initDb()
      let tableOk = true
      try {
        await db.select().from(workflows).limit(1)
      } catch {
        tableOk = false
      }
      check(tableOk, 'workflows 表建表兜底在位（可查询）')
      const cols = await db.select().from(pipelineRuns).limit(1)
      const sample = cols[0]
      const hasCols = sample === undefined || ('workflowId' in sample && 'workflowSeq' in sample)
      check(hasCols, 'pipeline_runs 含 workflow_id / workflow_seq 列（drizzle 投影可选）')
    },

    // ============ workflow-crud：建/列/改/删/克隆 + 链校验 ============
    'workflow-crud': async () => {
      writeProbeTemplates()
      const pid = await mkProject()
      const { db } = await import('../src/db')
      const svc = await import('../src/services/workflow')

      const segments = [{ templateKey: 'probe-m27-ingest' }, { templateKey: 'probe-m27-ingest' }]
      const wf = await svc.createWorkflow({ projectId: pid, name: '链A', segments, autoAdvance: 0 })
      check(wf.status === 'draft' && wf.autoAdvance === 0, 'createWorkflow → draft + autoAdvance 默认 0')
      check(svc.parseSegments(wf.segments).length === 2, 'segments 落库为 2 段')
      check((await svc.listWorkflows({ projectId: pid })).length === 1, 'listWorkflows 按项目过滤命中')

      const patched = await svc.updateWorkflow(wf.id, { autoAdvance: 1, name: '链A2' })
      check(patched?.autoAdvance === 1 && patched?.name === '链A2', 'updateWorkflow 改 autoAdvance/name 生效')

      const cloned = await svc.cloneWorkflow(wf.id)
      check(!!cloned && cloned.id !== wf.id && cloned.status === 'draft' && cloned.autoAdvance === 0, 'cloneWorkflow → 新 draft 链 + autoAdvance 复位 0')
      check(!!cloned && svc.parseSegments(cloned.segments).length === 2, 'clone 段序列等价复制（2 段）')

      // 链校验纯函数
      const good = svc.validateWorkflowChainDoc([{ templateKey: 'probe-m27-ingest' }])
      check(good.ok, 'validateWorkflowChainDoc：合法模板 ok')
      const bad = svc.validateWorkflowChainDoc([{ templateKey: 'no-such-tpl-xyz' }])
      check(!bad.ok && bad.errors.length > 0, 'validateWorkflowChainDoc：未知模板报错')
      check(!svc.validateWorkflowChainDoc([]).ok, 'validateWorkflowChainDoc：空段报错')

      await svc.deleteWorkflow(wf.id)
      check((await svc.getWorkflow(wf.id)) === null, 'deleteWorkflow 删除生效')
      void db
    },

    // ============ segment-input：resolveSegmentInput 矩阵 ============
    'segment-input': async () => {
      writeProbeTemplates()
      const pid = await mkProject()
      const { initDb, db } = await import('../src/db')
      const { assets, pipelineRuns } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const { loadTemplate } = await import('../src/pipeline/loader')
      const { writeTextAsset } = await import('../src/services/storage')
      const svc = await import('../src/services/workflow')
      await initDb()

      const t = Date.now()
      // 模拟上游 run + 其产物（runId 链路）：文本 purpose=brief（真实落盘可读）/ 图 purpose=img
      const up = (
        await db
          .insert(pipelineRuns)
          .values({ projectId: pid, templateKey: 'probe-m27-ingest', status: 'completed', input: '{}', createdAt: t, updatedAt: t })
          .returning()
      )[0]!
      const briefText = await writeTextAsset(pid, { name: 'b.md', content: '简报正文·上游产出', purpose: 'brief' })
      await db.update(assets).set({ runId: up.id }).where(eq(assets.id, briefText.id))
      const imgAsset = (
        await db
          .insert(assets)
          .values({ projectId: pid, runId: up.id, kind: 'image', purpose: 'img', name: 'i.png', relPath: 'y', ext: 'png', tags: '[]', createdAt: t, updatedAt: t })
          .returning()
      )[0]!
      const tpl = loadTemplate('probe-m27-multi')

      // ① 全 token 命中
      const r1 = await svc.resolveSegmentInput({
        template: tpl,
        prevRunId: up.id,
        inputSpec: { brief: '$prev.text:brief', imgs: '$prev.assets:img', n: '7', mode: 'pro' },
      })
      check(typeof r1.inputs['brief'] === 'string' && (r1.inputs['brief'] as string).includes('简报正文'), `$prev.text → readTextAsset 读取上游文本资产正文（${String(r1.inputs['brief'])}）`)
      check(JSON.stringify(r1.inputs['imgs']) === `[${imgAsset.id}]`, '$prev.assets → 资产 id 数组')
      check(r1.inputs['n'] === '7' && r1.inputs['mode'] === 'pro', '字面量常量原样透传')
      check(r1.missingRequired.length === 0, `全命中 → missingRequired 空（${r1.missingRequired.join(',')}）`)

      // ② $prev.asset 单资产
      const r2 = await svc.resolveSegmentInput({ template: tpl, prevRunId: up.id, inputSpec: { imgs: '$prev.asset:img', brief: '固定简报' } })
      check(r2.inputs['imgs'] === imgAsset.id, '$prev.asset → 单资产 id')

      // ③ 缺 required 无 default → missingRequired
      const r3 = await svc.resolveSegmentInput({ template: tpl, prevRunId: null, inputSpec: {} })
      check(r3.missingRequired.includes('brief') && r3.missingRequired.includes('imgs'), `required 缺值入 missingRequired（${r3.missingRequired.join(',')}）`)
      check(!r3.missingRequired.includes('n'), '有 default 的 n 不计缺失')

      // ④ $prev.assets 无匹配 → undefined（required 计缺失）
      const r4 = await svc.resolveSegmentInput({ template: tpl, prevRunId: up.id, inputSpec: { imgs: '$prev.assets:none_purpose', brief: 'x' } })
      check(r4.inputs['imgs'] === undefined && r4.missingRequired.includes('imgs'), '$prev.assets 无匹配 → 缺失')
    },

    // ============ auto-advance：完成级联 / autoAdvance=0 不触发 / 末段 done ============
    'auto-advance': async () => {
      writeProbeTemplates()
      const pid = await mkProject()
      const { initDb, db } = await import('../src/db')
      const { pipelineRuns } = await import('../src/db/schema')
      const svc = await import('../src/services/workflow')
      const { eq } = await import('drizzle-orm')
      await initDb()

      const mkChain = async (autoAdvance: number) =>
        svc.createWorkflow({
          projectId: pid,
          name: `链-${autoAdvance}`,
          segments: [{ templateKey: 'probe-m27-ingest', inputSpec: { brief: 'seg0' } }, { templateKey: 'probe-m27-ingest', inputSpec: { brief: 'seg1' } }],
          autoAdvance,
        })

      const insertDoneRun = async (workflowId: number, seq: number) => {
        const t = Date.now()
        return (
          await db
            .insert(pipelineRuns)
            .values({ projectId: pid, templateKey: 'probe-m27-ingest', status: 'completed', input: '{}', workflowId, workflowSeq: seq, createdAt: t, updatedAt: t })
            .returning()
        )[0]!
      }

      // ① autoAdvance=1：完成段 0 → 创建段 1
      const wf1 = await mkChain(1)
      await svc.setWorkflowStatus(wf1.id, 'active')
      const up1 = await insertDoneRun(wf1.id, 0)
      await svc.advanceWorkflow(up1.id)
      const down1 = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.workflowId, wf1.id))).filter((r) => r.workflowSeq === 1)
      check(down1.length === 1 && down1[0]!.templateKey === 'probe-m27-ingest', 'autoAdvance=1：段0完成 → 创建段1 run')
      check(down1[0]?.workflowId === wf1.id, '下游 run workflowId 归属正确')

      // ② autoAdvance=0：仅 segment_done，不创建下游
      const wf0 = await mkChain(0)
      await svc.setWorkflowStatus(wf0.id, 'active')
      const up0 = await insertDoneRun(wf0.id, 0)
      await svc.advanceWorkflow(up0.id)
      const down0 = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.workflowId, wf0.id))).filter((r) => r.workflowSeq === 1)
      check(down0.length === 0, 'autoAdvance=0：不创建下游 run（计费安全默认）')
      check((await svc.getWorkflow(wf0.id))?.status === 'active', 'autoAdvance=0：链保持 active（未级联）')

      // ③ 末段完成 → 链 done
      const wfLast = await mkChain(1)
      await svc.setWorkflowStatus(wfLast.id, 'active')
      const upLast = await insertDoneRun(wfLast.id, 1) // seq=1 是末段（segments 长 2）
      await svc.advanceWorkflow(upLast.id)
      check((await svc.getWorkflow(wfLast.id))?.status === 'done', '末段完成 → 链 done')
    },

    // ============ budget-gate：链级 budgetCap 命中 → paused + 无下游 ============
    'budget-gate': async () => {
      writeProbeTemplates()
      const pid = await mkProject()
      const { initDb, db } = await import('../src/db')
      const { pipelineRuns, usageRecords } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const svc = await import('../src/services/workflow')
      await initDb()

      const wf = await svc.createWorkflow({
        projectId: pid,
        name: '预算链',
        segments: [{ templateKey: 'probe-m27-ingest', inputSpec: { brief: 's0' } }, { templateKey: 'probe-m27-ingest', inputSpec: { brief: 's1' } }],
        autoAdvance: 1,
        budgetCap: 1, // 链上限 1 元
      })
      await svc.setWorkflowStatus(wf.id, 'active')
      const t = Date.now()
      const up = (
        await db
          .insert(pipelineRuns)
          .values({ projectId: pid, templateKey: 'probe-m27-ingest', status: 'completed', input: '{}', workflowId: wf.id, workflowSeq: 0, createdAt: t, updatedAt: t })
          .returning()
      )[0]!
      // 链累计成本 5 >= budgetCap 1
      await db.insert(usageRecords).values({ projectId: pid, runId: up.id, kind: 'llm', quantity: 1, unit: 'tokens_in', cost: 5, createdAt: t })
      await svc.advanceWorkflow(up.id)
      const downstream = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.workflowId, wf.id))).filter((r) => r.workflowSeq === 1)
      check((await svc.getWorkflow(wf.id))?.status === 'paused', '链级 budgetCap 命中 → paused')
      check(downstream.length === 0, '预算拦截 → 不创建下游 run（计费安全）')
    },

    // ============ breakpoint-pause：run.failed → paused + 无下游（不重试）============
    'breakpoint-pause': async () => {
      writeProbeTemplates()
      const pid = await mkProject()
      const { initDb, db } = await import('../src/db')
      const { pipelineRuns } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const svc = await import('../src/services/workflow')
      await initDb()

      const wf = await svc.createWorkflow({
        projectId: pid,
        name: '失败链',
        segments: [{ templateKey: 'probe-m27-ingest', inputSpec: { brief: 's0' } }, { templateKey: 'probe-m27-ingest', inputSpec: { brief: 's1' } }],
        autoAdvance: 1,
      })
      await svc.setWorkflowStatus(wf.id, 'active')
      const t = Date.now()
      const failed = (
        await db
          .insert(pipelineRuns)
          .values({ projectId: pid, templateKey: 'probe-m27-ingest', status: 'failed', input: '{}', error: 'boom', workflowId: wf.id, workflowSeq: 0, createdAt: t, updatedAt: t })
          .returning()
      )[0]!
      await svc.advanceWorkflow(failed.id)
      const downstream = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.workflowId, wf.id))).filter((r) => r.workflowSeq === 1)
      check((await svc.getWorkflow(wf.id))?.status === 'paused', 'run.failed → 链 paused')
      check(downstream.length === 0, '失败不自动重试 / 不推进下游')
    },

    // ============ recovery-guard：CodeReview 修复回归（#2 幂等 / #3 双启动 / #1 resume 重驱动）============
    'recovery-guard': async () => {
      writeProbeTemplates()
      const pid = await mkProject()
      const { initDb, db } = await import('../src/db')
      const { pipelineRuns, usageRecords } = await import('../src/db/schema')
      const { and, eq } = await import('drizzle-orm')
      const svc = await import('../src/services/workflow')
      await initDb()

      const mkChain = async (autoAdvance: number, budgetCap: number | null = null) =>
        svc.createWorkflow({
          projectId: pid,
          name: `恢复链-${autoAdvance}-${budgetCap}`,
          segments: [
            { templateKey: 'probe-m27-ingest', inputSpec: { brief: 's0' } },
            { templateKey: 'probe-m27-ingest', inputSpec: { brief: 's1' } },
            { templateKey: 'probe-m27-ingest', inputSpec: { brief: 's2' } },
          ],
          autoAdvance,
          budgetCap,
        })
      const insertDoneRun = async (workflowId: number, seq: number) => {
        const t = Date.now()
        return (
          await db
            .insert(pipelineRuns)
            .values({ projectId: pid, templateKey: 'probe-m27-ingest', status: 'completed', input: '{}', workflowId, workflowSeq: seq, createdAt: t, updatedAt: t })
            .returning()
        )[0]!
      }

      // ② 幂等：同一 completed run 重复 advance 不重复建下游（修复 #2）
      const wfIdem = await mkChain(1)
      await svc.setWorkflowStatus(wfIdem.id, 'active')
      const upIdem = await insertDoneRun(wfIdem.id, 0)
      await svc.advanceWorkflow(upIdem.id)
      await svc.advanceWorkflow(upIdem.id)
      const seq1Rows = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.workflowId, wfIdem.id))).filter((r) => r.workflowSeq === 1)
      check(seq1Rows.length === 1, '#2 重复 advance 同一 run → 下游 seq1 仅一条（幂等守卫，防重复计费）')

      // ③ 双启动拒绝：链内已有 run → startWorkflow 抛 already_started（修复 #3）
      const wfStart = await mkChain(1)
      await insertDoneRun(wfStart.id, 0) // draft 状态但已有 run
      let startRejected = false
      try {
        await svc.startWorkflow(wfStart.id)
      } catch (e) {
        startRejected = e instanceof svc.WorkflowError && e.code === 'already_started'
      }
      check(startRejected, '#3 draft 链已有 run → startWorkflow 拒绝（防并发双启动重复创建首段 run）')

      // ① resume 重驱动：预算拦截 paused → 提额 budgetCap → resume 重新推进建下游（修复 #1 死锁）
      const wfResume = await mkChain(1, 1) // budgetCap 1 元
      await svc.setWorkflowStatus(wfResume.id, 'active')
      const upR = await insertDoneRun(wfResume.id, 0)
      await db.insert(usageRecords).values({ projectId: pid, runId: upR.id, kind: 'llm', quantity: 1, unit: 'tokens_in', cost: 5, createdAt: Date.now() })
      await svc.advanceWorkflow(upR.id) // 成本 5 >= cap 1 → paused
      check((await svc.getWorkflow(wfResume.id))?.status === 'paused', '#1 前置：预算拦截 → paused')
      check((await db.select().from(pipelineRuns).where(and(eq(pipelineRuns.workflowId, wfResume.id), eq(pipelineRuns.workflowSeq, 1)))).length === 0, '#1 前置：paused 无下游')
      await svc.updateWorkflow(wfResume.id, { budgetCap: 100 }) // 解除预算阻塞
      const resumed = await svc.resumeWorkflow(wfResume.id)
      check(resumed.status === 'active', '#1 resume → 链转 active')
      const seq1AfterResume = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.workflowId, wfResume.id))).filter((r) => r.workflowSeq === 1)
      check(seq1AfterResume.length === 1, '#1 resume 重驱动 → 重新推进创建下游 seq1（断点恢复不断链）')
    },

    // ============ nesting-clone：clone 等价 + 无 run_template action（零 diff 断言）============
    'nesting-clone': async () => {
      writeProbeTemplates()
      const pid = await mkProject()
      const svc = await import('../src/services/workflow')
      const { KNOWN_ACTIONS } = await import('../src/pipeline/loader')

      const wf = await svc.createWorkflow({
        projectId: pid,
        name: '嵌套源',
        segments: [{ templateKey: 'probe-m27-ingest' }, { templateKey: 'probe-m27-ingest' }, { templateKey: 'probe-m27-ingest' }],
        autoAdvance: 1,
        budgetCap: 9,
      })
      const clone = await svc.cloneWorkflow(wf.id)
      check(!!clone && clone.status === 'draft' && clone.autoAdvance === 0, 'clone → draft + autoAdvance 复位')
      check(!!clone && svc.parseSegments(clone.segments).length === 3, 'clone 段序列等价（3 段）')
      check(clone?.budgetCap === 9, 'clone 保留 budgetCap')
      check(!(KNOWN_ACTIONS as readonly string[]).includes('run_template'), 'KNOWN_ACTIONS 不含 run_template（I2 不碰引擎零 diff）')
    },

    // ============ overview-workflows：无链 → []；有链 → 段/状态/成本派生 ============
    'overview-workflows': async () => {
      writeProbeTemplates()
      const pid = await mkProject()
      const { initDb, db } = await import('../src/db')
      const { pipelineRuns, usageRecords } = await import('../src/db/schema')
      const { buildCanvasOverview } = await import('../src/services/canvas-overview')
      const svc = await import('../src/services/workflow')
      await initDb()

      // ① 无链 → workflows: []
      const ov0 = await buildCanvasOverview(pid)
      check(!!ov0 && Array.isArray(ov0!.workflows) && ov0!.workflows.length === 0, '无链 → overview.workflows 空数组（旧前端超集兼容）')

      // ② 建链 + 段 0 完成 run（带成本）+ 段 1 无 run → 派生
      const wf = await svc.createWorkflow({
        projectId: pid,
        name: '全景链',
        segments: [{ templateKey: 'probe-m27-ingest' }, { templateKey: 'probe-m27-ingest' }],
        autoAdvance: 1,
      })
      await svc.setWorkflowStatus(wf.id, 'active')
      const t = Date.now()
      const seg0 = (
        await db
          .insert(pipelineRuns)
          .values({ projectId: pid, templateKey: 'probe-m27-ingest', status: 'completed', input: '{}', workflowId: wf.id, workflowSeq: 0, createdAt: t, updatedAt: t })
          .returning()
      )[0]!
      await db.insert(usageRecords).values({ projectId: pid, runId: seg0.id, kind: 'llm', quantity: 1, unit: 'tokens_in', cost: 2.5, createdAt: t })

      const ov = await buildCanvasOverview(pid)
      const wfo = ov?.workflows.find((w) => w.id === wf.id)
      check(!!wfo && wfo.status === 'active' && wfo.autoAdvance === 1, '有链 → 链状态/autoAdvance 投影')
      check(!!wfo && wfo.segments.length === 2, '有链 → 段数 = 2')
      check(wfo?.segments[0]?.runId === seg0.id && wfo?.segments[0]?.runStatus === 'completed', '段0 → 最新 run 状态派生')
      check(Math.abs((wfo?.segments[0]?.cost ?? 0) - 2.5) < 1e-6, '段0 → 成本聚合正确')
      check(wfo?.segments[1]?.runId === null && wfo?.segments[1]?.runStatus === null, '段1 无 run → runId/status null')
      check(!!wfo && wfo.segments[0]?.templateName === 'M27 链探针（入库）', '段模板名 loadTemplate 解析')
    },
  }

  await runSections({ log, title: 'M27', checker, sections: SECTIONS, runners, cleanup })
}

void main()
