import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { assets, creationMessages, creationSessions } from '../../db/schema'
import { CreationError, creationPlanSchema, hashJson, refBindSchema, refSchema, type CreationPlan, type CreationRef, type RefBind } from './contract'
import { VALID_ROLES } from './attachments'
import { preflightPlan } from './preflight'
import { activeProject, creationDetail, creationWrite, sessionRow } from './store'

/**
 * [M43] 参考绑定写入口（用途 role + 逐镜 shotId 共用一个 PATCH）：
 * 双写 attachment payload（再规划编译的权威源）与 plan.refs（当前方案），零 LLM、零计费。
 * ready 态下 plan.refs 变化 → 重跑预检 + 重算 planHash，hash 变则 planRevision+1（复用
 * refreshPreflight 的 bump 语义）——旧确认键自然 stale_plan，用户须重新确认后才开始制作。
 * 状态门与前端 attachmentsLocked 同源：规划中 / 已启动 run（参考随 recipe 冻结）一律 409。
 */
export async function bindCreationRef(id: number, assetId: number, raw: unknown) {
  const bind: RefBind = refBindSchema.parse(raw)
  return creationWrite(async () => {
    const s = await sessionRow(id)
    await activeProject(s.projectId)
    if (s.status === 'planning' || s.status === 'starting') throw new CreationError('busy', '上一条请求正在处理，请稍候', 409)
    if (s.runId) throw new CreationError('ref_locked', '已开始制作，参考与绑定已随方案冻结；如需调整请重新创作', 409)
    if (!Number.isInteger(assetId) || assetId <= 0) throw new CreationError('bad_asset', '素材编号非法', 400)

    // 定位本会话的 attachment 登记消息（与 resolveAttachmentRefs 同一解析口径，后写覆盖）
    const msgs = await db.select().from(creationMessages).where(eq(creationMessages.sessionId, id))
    let target: typeof msgs[number] | null = null
    let recorded: CreationRef | null = null
    for (const m of msgs) {
      if (!m.payload) continue
      try {
        const p = JSON.parse(m.payload) as { kind?: string; assetId?: number; ref?: CreationRef }
        if (p.kind === 'attachment' && p.assetId === assetId && p.ref) { target = m; recorded = p.ref }
      } catch { /* 非 JSON payload 忽略 */ }
    }
    if (!target || !recorded) throw new CreationError('attachment_not_found', '该参考素材未在本会话登记，无法修改绑定', 404)

    // 资产行权威核验：属于本会话项目、未软删（与上传/规划前核验同源）
    const [asset] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.projectId, s.projectId), isNull(assets.deletedAt)))
      .limit(1)
    if (!asset) throw new CreationError('ref_not_found', '参考素材不存在、已删除或不属于本会话项目', 422)
    if (bind.role !== undefined && !(VALID_ROLES[asset.kind] ?? []).includes(bind.role)) {
      throw new CreationError('bad_role', '参考素材用途与类型不匹配（图片可选 style / first_frame / subject；视频仅 content；音频仅 bgm）', 422)
    }
    const shotId = bind.shotId === undefined ? recorded.shotId ?? null : bind.shotId
    if (shotId) {
      // 读链语义：recipeRefImageIds 只消费 image 类 ref，video/audio 带 shotId 无意义 → 权威拒绝
      if (asset.kind !== 'image') throw new CreationError('shot_bind_unsupported', '仅图片参考可绑定到具体镜头', 422)
      if (!s.plan) throw new CreationError('no_plan_to_bind', '方案生成后才能绑定到具体镜头，请先完成对话规划', 409)
      const planShots = creationPlanSchema.parse(JSON.parse(s.plan)).shots
      if (!planShots.some((shot) => shot.id === shotId)) throw new CreationError('shot_not_found', '所绑镜头不在当前方案中，请刷新后重选', 422)
    }
    // refSchema .strict() 拒 null 值：回整片级 = 删键
    const nextRef = refSchema.parse({
      assetId, kind: asset.kind, role: bind.role ?? recorded.role, hash: recorded.hash,
      ...(shotId ? { shotId } : {}),
    })
    const payload = JSON.stringify({ kind: 'attachment', assetId, ref: nextRef })

    // payload 之外同步 patch plan.refs（ asset 已被方案采纳时）；未采纳 → 只改 payload，下轮编译自然生效
    const plan: CreationPlan | null = s.plan ? creationPlanSchema.parse(JSON.parse(s.plan)) : null
    let newPlan: CreationPlan | null = null
    if (plan) {
      const idx = plan.refs.findIndex((r) => r.assetId === assetId)
      const prev = idx >= 0 ? plan.refs[idx] : undefined
      if (prev && (prev.role !== nextRef.role || (prev.shotId ?? null) !== (nextRef.shotId ?? null))) {
        const refs = [...plan.refs]
        refs[idx] = nextRef
        newPlan = { ...plan, refs }
      }
    }
    const pf = newPlan ? await preflightPlan(s.projectId, newPlan) : null
    const newHash = newPlan && pf ? hashJson({ plan: newPlan, execution: pf.execution }) : null
    await db.transaction(async (tx) => {
      await tx.update(creationMessages).set({ payload }).where(eq(creationMessages.id, target!.id))
      if (newPlan && pf && newHash) {
        await tx.update(creationSessions).set({
          plan: JSON.stringify(newPlan), preflight: JSON.stringify(pf), planHash: newHash,
          planRevision: s.planRevision + (newHash !== s.planHash ? 1 : 0), updatedAt: Date.now(),
        }).where(eq(creationSessions.id, id))
      }
    })
    return creationDetail(id)
  })
}
