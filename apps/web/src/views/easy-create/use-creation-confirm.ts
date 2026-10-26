/**
 * 确认闸旁注状态：easy 确认键、route 决策键、立项信息可编辑态。
 *
 * 从 use-creation-chat.ts 外抽（该文件有 ≤800 行工程红线），行为逐字不变：
 * - 幂等键以 hash+revision 为闸：同输入复用、内容变化即换代（重试点击不重复起 run）
 * - 立项编辑态默认用平台智能填写值；用户改过的字段（dirty）确认时随 confirm 作为覆盖提交
 *
 * `detailOf` 由调用方注入当前会话快照 —— 本模块不持有状态机，只读派生。
 */
import { computed, reactive } from 'vue'
import { newRequestKey } from '../../lib/api'
import type { CreationDetail, CreationProjectMeta } from '../../lib/types'

/** 标签文本 → 数组（支持中英文逗号/顿号分隔；去空去重） */
export function parseTagsText(text: string): string[] {
  const out: string[] = []
  for (const t of text.split(/[,，、]/)) {
    const v = t.trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

export function createCreationConfirm(detailOf: () => CreationDetail | null) {
  // 确认幂等键：同一 planHash+revision 复用，重试点击不新起 run；方案变化后重置
  const confirmKey = reactive<{ hash: string; revision: number; key: string }>({
    hash: '',
    revision: 0,
    key: '',
  })
  function syncConfirmKey(): void {
    const s = detailOf()?.session
    const hash = s?.planHash ?? ''
    if (
      confirmKey.hash === hash &&
      confirmKey.revision === (s?.planRevision ?? 0)
    )
      return
    confirmKey.hash = hash
    confirmKey.revision = s?.planRevision ?? 0
    confirmKey.key = hash ? newRequestKey('cfm') : ''
  }

  // route 确认幂等键（M63）：以 decisionHash+planRevision 为闸，语义同 confirmKey（改动即作废旧确认，重试点击不新起 run）
  const decisionKey = reactive<{
    hash: string
    revision: number
    key: string
  }>({ hash: '', revision: 0, key: '' })
  function syncDecisionKey(): void {
    const s = detailOf()?.session
    const hash = s?.decisionHash ?? ''
    if (
      decisionKey.hash === hash &&
      decisionKey.revision === (s?.planRevision ?? 0)
    )
      return
    decisionKey.hash = hash
    decisionKey.revision = s?.planRevision ?? 0
    decisionKey.key = hash ? newRequestKey('rfm') : ''
  }

  // ===== 立项信息可编辑态：默认用平台智能填写值（Tier A），用户改过的字段确认后随 confirm 提交（Tier B 可覆盖） =====
  const projectDraft = reactive({
    name: '',
    genre: '',
    tagsText: '',
    brief: '',
    /** 用户改过任一项 → true：服务端回读不再覆盖本地编辑；确认成功后重置 */
    dirty: false,
  })

  /** 服务端智能填写值回同步到编辑态（用户未改动时才覆盖，避免冲掉正在输入的内容） */
  function syncProjectDraft(): void {
    const p = detailOf()?.session.project
    if (!p) {
      projectDraft.dirty = false
      return
    }
    if (projectDraft.dirty) return
    projectDraft.name = p.name
    projectDraft.genre = p.genre
    projectDraft.tagsText = p.tags.join('，')
    projectDraft.brief = p.brief
  }

  /** 可编辑窗口：仅未立项（draft 影子态）且方案就绪时展示编辑区 */
  const projectEditable = computed(
    () => detailOf()?.session.project?.isDraft === true,
  )

  /** 确认时携带的覆盖值：只提交与平台智能填写值不同的字段；全无改动 → undefined（沿用服务端值） */
  function projectOverrides(): Partial<CreationProjectMeta> | undefined {
    const p = detailOf()?.session.project
    if (!p || !p.isDraft || !projectDraft.dirty) return undefined
    const o: Partial<CreationProjectMeta> = {}
    if (projectDraft.name.trim() && projectDraft.name.trim() !== p.name)
      o.name = projectDraft.name.trim()
    if (projectDraft.genre && projectDraft.genre !== p.genre)
      o.genre = projectDraft.genre
    const tags = parseTagsText(projectDraft.tagsText)
    if (tags.length && tags.join(',') !== p.tags.join(',')) o.tags = tags
    if (projectDraft.brief.trim() && projectDraft.brief.trim() !== p.brief)
      o.brief = projectDraft.brief.trim()
    return Object.keys(o).length ? o : undefined
  }

  return {
    confirmKey,
    syncConfirmKey,
    decisionKey,
    syncDecisionKey,
    projectDraft,
    syncProjectDraft,
    projectEditable,
    projectOverrides,
  }
}
