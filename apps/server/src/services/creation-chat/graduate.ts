/**
 * 轻松创作「毕业通道」：把已确认（批准并已开始制作）的方案，在**同一项目**上起一个专业链 run。
 * 设计（以当前引擎实态为准，非冻结 spec 的 skip 假设）：
 * - **只建 queued run，不自动 start、零计费**：专业链含定妆照/逐句配音/BGM 等付费能力，预算与输入必须由用户
 *   到专业工作台核对后自行启动；专业链自带的 write_script 必审闸负责剧本复核。
 * - **批准剧本经既有 `setting_docs`（单集）/ `plan_doc`（连载）输入喂入作强锚定**：不改 `mengbao-episode` v14
 *   的步骤结构（原 spec「skip write_script + prev_script 注入」在真实引擎下不成立——skip 步产物为空且会级联
 *   跳过下游；prev_script 语义是「上一集承接」会误导致写成第 2 集）。files 类输入本就不进 run-prefill 自动回填。
 * - **幂等**：项目上若已有把「本会话批准剧本资产」作为锚定输入的未启动专业 run，直接复用，不重复建。
 *
 * 纪律：0 新表 0 新列 / 0 数据迁移 / 0 新增 action / 0 新增付费面 / 0 模板步骤改造；不改 planHash（毕业不是执行数据，
 * 与立项覆盖、审阅闸切换同一先例）；`easy-*` 纯执行器本质不动；升级是独立 opt-in 动作，绝不在 confirm 时自动改跑出片模板。
 */
import { z } from 'zod'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { assets, creationMessages, pipelineRuns, projects } from '../../db/schema'
import { createRunRow, InvalidRunInputError } from '../run-create'
import { CreationError, creationPlanSchema } from './contract'
import { activeProject, parseJson, sessionRow } from './store'

/** 单集升级模板（短剧·单集，专业链）；连载立项模板（短剧立项） */
const EPISODE_TEMPLATE = 'mengbao-episode'
const SERIES_TEMPLATE = 'series-setup'

export const graduateSchema = z
  .object({
    mode: z.enum(['episode', 'series']),
    /** 集号（仅单集升级）：缺省 1；连载立项忽略 */
    episodeNumber: z.number().int().min(1).max(9999).optional(),
  })
  .strict()

export interface GraduateResult {
  runId: number
  templateKey: string
  /** true = 命中既有未启动的专业 run，未重复创建 */
  reused: boolean
}

/** 把该 files 输入解析为正整数资产 id 数组（run.input 里 files 值已由 normalizeInput 收敛为 id 数组） */
function fileIds(v: unknown): number[] {
  return Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
}

export async function graduateCreation(id: number, raw: unknown): Promise<GraduateResult> {
  const request = graduateSchema.parse(raw)
  const s = await sessionRow(id)
  // 毕业前提是「已确认并已开始制作」（批准物已落库为资产）；未确认无可升级内容
  if (!s.runId) throw new CreationError('not_confirmed', '请先确认并开始制作，再升级到专业成片', 409)
  await activeProject(s.projectId)
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, s.projectId), isNull(projects.deletedAt)))
  if (!project) throw new CreationError('project_deleted', '项目已删除，无法升级', 409)
  const plan = s.plan ? creationPlanSchema.parse(JSON.parse(s.plan)) : null
  const templateKey = request.mode === 'series' ? SERIES_TEMPLATE : EPISODE_TEMPLATE

  // 批准剧本资产：confirm 时落库（purpose=script 且 runId=本次轻松创作 run），取最新一条
  const [scriptAsset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.projectId, s.projectId), eq(assets.purpose, 'script'), eq(assets.runId, s.runId), isNull(assets.deletedAt)))
    .orderBy(desc(assets.id))
    .limit(1)

  // 幂等：同项目同专业模板下，若已存在把「本批准剧本资产」作为锚定输入、且仍 queued 的 run → 复用
  const filesKey = request.mode === 'series' ? 'plan_doc' : 'setting_docs'
  const candidates = await db
    .select()
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.projectId, s.projectId), eq(pipelineRuns.templateKey, templateKey)))
    .orderBy(desc(pipelineRuns.id))
  if (scriptAsset) {
    for (const r of candidates) {
      if (r.status !== 'queued') continue
      const input = parseJson<Record<string, unknown>>(r.input, {})
      if (fileIds(input[filesKey]).includes(scriptAsset.id)) return { runId: r.id, templateKey, reused: true }
    }
  }

  // 组装修业 run 入参：brief/genre 用项目真源，批准剧本作锚定，motion 尊重方案形态（dynamic=动效）
  const briefText = (project.brief?.trim() || project.name.trim() || plan?.summary?.trim() || '').slice(0, 4000)
  const input: Record<string, unknown> =
    request.mode === 'series'
      ? { genre: briefText, ...(scriptAsset ? { plan_doc: [scriptAsset.id] } : {}) }
      : {
          brief: briefText,
          episode_number: request.episodeNumber ?? 1,
          ...(scriptAsset ? { setting_docs: [scriptAsset.id] } : {}),
          ...(plan?.mode === 'dynamic' ? { motion: true } : {}),
        }

  let runId: number
  try {
    const run = await createRunRow({ projectId: s.projectId, templateKey, input })
    runId = run.id
  } catch (err) {
    if (err instanceof InvalidRunInputError) throw new CreationError('graduate_failed', `无法创建专业成片任务：${err.message}`, 422)
    throw err
  }

  const label = request.mode === 'series' ? '连载立项（系列设定包）' : '专业单集成片'
  await db.insert(creationMessages).values({
    sessionId: id,
    role: 'assistant',
    content: `已为你在《${project.name}》下创建${label}任务（专业链，尚未开始制作）。请到任务详情核对预算与参数后启动：专业流程会重新生成剧本并在剧本闸口请你复核，随后点亮角色定妆照、逐句配音、背景音乐与品牌等能力。`,
    payload: JSON.stringify({ kind: 'graduate', runId, templateKey }),
    createdAt: Date.now(),
  })

  return { runId, templateKey, reused: false }
}
