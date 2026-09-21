import { rmSync } from 'node:fs'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import {
  assets,
  creationMessages,
  creationSessions,
  pipelineRuns,
  projects,
  usageRecords,
} from '../../db/schema'
import { createLogger } from '../../logger'
import { projectAbsDir } from '../storage'
import { CreationError } from './contract'
import { creationWrite, sessionRow } from './store'

const log = createLogger('creation-chat')

/**
 * [M40+] 删除轻松创作会话（清理"聊了一半放弃"的记录，顺带回收其影子项目）。
 *
 * 两种结局，绝不静默多删：
 *  - 未立项（项目仍是 draft 影子态，且无 run）→ 会话 + 影子项目一并清除。
 *    createSession 为每个会话单独建行（1:1），影子项目除本会话外无人引用，
 *    留着就是用户反馈的"库里积了一堆看不见的行"。
 *  - 已立项 / 项目已删 / 影子项目竟有 run → 只删会话记录，项目与其产物原样保留，
 *    删除范围与原因如实回传（mode + reason），由前端转告。项目要删请走项目页。
 *
 * 在途保护：planning/starting 控制态、或关联 run 仍在跑时一律拒绝，避免删掉正在进行
 * 制作的唯一控制记录（run 行本身不存 sessionId，删会话不影响制作执行，但会丢掉进度入口）。
 */
export interface DeleteCreationResult {
  ok: true
  mode: 'draft_purged' | 'session_only'
  projectId: number | null
  /** mode=session_only 时说明项目为何保留 */
  reason: string
  purged: Record<string, number>
}

export async function deleteCreationSession(id: number): Promise<DeleteCreationResult> {
  const s = await sessionRow(id)
  if (s.status === 'planning' || s.status === 'starting')
    throw new CreationError('session_busy', '会话正在规划或启动中，请等它结束（或先取消）后再删除', 409)
  if (s.runId) {
    const [active] = await db
      .select({ id: pipelineRuns.id })
      .from(pipelineRuns)
      .where(and(eq(pipelineRuns.id, s.runId), inArray(pipelineRuns.status, ['queued', 'running', 'waiting_input'])))
    if (active) throw new CreationError('run_active', '该会话的制作仍在进行，请先取消运行后再删除会话', 409)
  }

  const result = await creationWrite(() =>
    db.transaction(async (tx) => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, s.projectId))
      // 影子项目可一并清除的判据：draft 态 + 本项目下没有任何 run（有 run 说明真的立项过）
      const runs = project
        ? await tx.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.projectId, project.id))
        : []
      const purgeProject = project?.status === 'draft' && runs.length === 0
      const cnt = async (rows: Promise<{ id: number }[]>): Promise<number> => (await rows).length

      if (purgeProject) {
        const siblings = tx.select({ id: creationSessions.id }).from(creationSessions).where(eq(creationSessions.projectId, project!.id))
        const purged = {
          messages: await cnt(tx.delete(creationMessages).where(inArray(creationMessages.sessionId, siblings)).returning({ id: creationMessages.id })),
          sessions: await cnt(tx.delete(creationSessions).where(eq(creationSessions.projectId, project!.id)).returning({ id: creationSessions.id })),
          assets: await cnt(tx.delete(assets).where(eq(assets.projectId, project!.id)).returning({ id: assets.id })),
          usage: await cnt(tx.delete(usageRecords).where(eq(usageRecords.projectId, project!.id)).returning({ id: usageRecords.id })),
          projects: await cnt(tx.delete(projects).where(eq(projects.id, project!.id)).returning({ id: projects.id })),
        }
        return { mode: 'draft_purged' as const, projectId: project!.id, reason: '', purged }
      }

      const purged = {
        messages: await cnt(tx.delete(creationMessages).where(eq(creationMessages.sessionId, id)).returning({ id: creationMessages.id })),
        sessions: await cnt(tx.delete(creationSessions).where(eq(creationSessions.id, id)).returning({ id: creationSessions.id })),
      }
      const reason = !project
        ? '项目记录已不存在，仅清除会话。'
        : runs.length > 0
          ? '项目已立项并产生制作记录，会话记录已删除；项目与其产物请从项目页处理。'
          : '项目已立项（确认过方案），保留其全部信息与产物；如需删除请前往项目页。'
      return { mode: 'session_only' as const, projectId: project?.id ?? null, reason, purged }
    }),
  )

  // 磁盘清理在事务提交后执行（影子项目的参考素材目录）；失败仅告警，不影响数据一致性
  if (result.mode === 'draft_purged' && result.projectId) {
    try {
      rmSync(projectAbsDir(result.projectId), { recursive: true, force: true })
    } catch (err) {
      log.warn(`影子项目 ${result.projectId} 磁盘目录清理失败：${(err as Error).message}`)
    }
  }
  log.info('轻松创作会话已删除', { sessionId: id, mode: result.mode, projectId: result.projectId, purged: result.purged })
  return { ok: true, mode: result.mode, projectId: result.projectId, reason: result.reason, purged: result.purged }
}
