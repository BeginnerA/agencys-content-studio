import { computed } from 'vue'
import { creationChatApi } from '../../lib/api'
import {
  REF_DEFAULT_ROLE,
  REF_MAX_COUNT,
  REF_MAX_PER_KIND,
  refKindByExt,
} from '../../lib/types'
import type {
  Asset,
  CreationDetail,
  CreationRefBindBody,
  CreationRefKind,
  CreationRefRole,
} from '../../lib/types'

/** composer 待采纳参考附件（本地项；上传后回填 assetId/hash/thumbUrl）。
 * 两类来源：上传项持有 file；「从素材选取」项无 file，凭 sourceAssetId 走 from-asset 登记（改用途/重试同源）。 */
export interface AttachmentItem {
  clientId: string
  file?: File
  name: string
  kind: CreationRefKind
  role: CreationRefRole
  assetId?: number
  hash?: string
  thumbUrl?: string | null
  uploading: boolean
  error?: string
  /** 素材库源资产 id（仅从素材选取项；服务端去重后可能对应不同会话资产） */
  sourceAssetId?: number
  /** 逐镜绑定（undefined/null = 整片级）；ready 项 PATCH 成功后回填，重传登记会覆写 payload → 同步清空 */
  shotId?: string | null
}

/** 附件域独立成 composable（不继续膨胀 use-creation-chat）：与主状态机共享同一 reactive state 引用，切会话/离开时主文件直接覆写 state.attachments 即生效。 */
interface AttachmentHost {
  currentId: number
  detail: CreationDetail | null
  error: string
  notice: string
  busyAction: boolean
  busySend: boolean
  attachments: AttachmentItem[]
}

export function createAttachments(
  state: AttachmentHost,
  deps: {
    /** viewEpoch 是主文件的模块级自增值，晚到响应保护须每次读最新值 → 传 getter 而非快照 */
    viewEpoch: () => number
    commit: (id: number, detail: CreationDetail) => void
    first: { active: { value: boolean }; locked: { value: boolean } }
    errText: (e: unknown) => string
  },
) {
  const { commit, first, errText } = deps

  // ===== 参考附件登记（composer：上传或从素材选取 → 落当前会话项目；不计费、不触发规划） =====
  let attSeq = 0
  async function uploadItem(item: AttachmentItem): Promise<void> {
    const id = state.currentId
    const token = deps.viewEpoch()
    if (!id) {
      item.error = '请点击生成方案后登记参考'
      item.uploading = false
      return
    }
    if (!item.file && !item.sourceAssetId) {
      item.error = '参考项缺少文件或素材来源，无法登记'
      item.uploading = false
      return
    }
    item.uploading = true
    item.error = undefined
    try {
      const res = item.file
        ? await creationChatApi.uploadAttachment(id, item.file, item.role)
        : await creationChatApi.attachAsset(id, item.sourceAssetId!, item.role)
      // 异步竞态：仅当该项仍在当前托盘且未切会话时回填
      if (token === deps.viewEpoch() && state.currentId === id && state.attachments.includes(item)) {
        item.assetId = res.assetId
        item.hash = res.hash
        item.thumbUrl = res.thumbUrl
        item.name = res.name
        item.kind = res.kind
        item.role = res.role
        // 重新登记会覆写服务端 payload（registerAttachment 不带 shotId）→ 本地绑定同步清空，不假称还在
        item.shotId = undefined
      }
    } catch (e) {
      if (state.attachments.includes(item)) item.error = errText(e)
    } finally {
      if (state.attachments.includes(item)) item.uploading = false
    }
  }

  /** 选择文件：预校验类型/大小/数量 → 按 kind 默认用途上传 */
  async function addAttachment(file: File): Promise<void> {
    if (attachmentsLocked.value) return
    const kind = refKindByExt(file.name)
    if (!kind) {
      state.error = `参考仅支持图片 / 视频 / 音频：${file.name}`
      return
    }
    if (file.size === 0) {
      state.error = `参考文件为空：${file.name}`
      return
    }
    if (file.size > REF_MAX_PER_KIND[kind]) {
      const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'
      state.error = `${label}参考超过 ${Math.floor(REF_MAX_PER_KIND[kind] / 1024 / 1024)}MB 上限：${file.name}`
      return
    }
    if (state.attachments.length >= REF_MAX_COUNT) {
      state.error = `参考素材最多 ${REF_MAX_COUNT} 个`
      return
    }
    const item: AttachmentItem = {
      clientId: `att${++attSeq}_${Date.now()}`,
      file,
      name: file.name,
      kind,
      role: REF_DEFAULT_ROLE[kind],
      uploading: false,
    }
    state.attachments.push(item)
    // 必须通过响应式代理回填上传态（push 后读回数组元素为 reactive 代理；直接改 push 前的 raw 引用不触发 set 陷阱，UI 会永久停在「上传中」）
    if (state.currentId && !first.active.value) await uploadItem(state.attachments[state.attachments.length - 1]!)
  }

  /** 从素材选取：存量资产登记为参考（服务端同规则校验 kind/大小/用途；跨项目自动复制，sha256 去重） */
  async function addAssetReference(asset: Asset): Promise<void> {
    if (attachmentsLocked.value) return
    const kind = asset.kind as CreationRefKind
    if (kind !== 'image' && kind !== 'video' && kind !== 'audio') {
      state.error = `参考仅支持图片 / 视频 / 音频素材：${asset.name}`
      return
    }
    if (state.attachments.some((a) => a.sourceAssetId === asset.id)) {
      state.notice = `该素材已在参考托盘：${asset.name}`
      return
    }
    if (state.attachments.length >= REF_MAX_COUNT) {
      state.error = `参考素材最多 ${REF_MAX_COUNT} 个`
      return
    }
    const item: AttachmentItem = {
      clientId: `att${++attSeq}_${Date.now()}`,
      name: asset.name,
      kind,
      role: REF_DEFAULT_ROLE[kind],
      uploading: false,
      sourceAssetId: asset.id,
    }
    state.attachments.push(item)
    if (state.currentId && !first.active.value) await uploadItem(state.attachments[state.attachments.length - 1]!)
  }

  /** 更改用途：已有方案时走 PATCH（ 与逐镜绑定同一语义：双写 payload + plan.refs，不重传文件）；
   *  无方案（规划前）保持既有重登记路径（此时 PATCH 无 plan 可同步，重登记即唯一写链）。 */
  async function changeAttachmentRole(
    clientId: string,
    role: CreationRefRole,
  ): Promise<void> {
    if (attachmentsLocked.value) return
    const item = state.attachments.find((a) => a.clientId === clientId)
    if (!item || item.role === role) return
    if (item.assetId && state.detail?.session.plan) {
      await bindAttachment(clientId, { role })
      return
    }
    item.role = role
    if (item.assetId) {
      item.sourceAssetId ??= item.assetId
      item.assetId = undefined
      item.hash = undefined
      item.thumbUrl = null
      if (state.currentId && !first.active.value) await uploadItem(item)
    }
  }

  /** 参考绑定写入口（用途 + 逐镜共用）：PATCH 双写 payload + plan.refs，零 LLM、零计费；
   *  hash 变则服务端 planRevision+1，旧确认失效。失败不写回本地（服务端为权威）；成功才同步 item + 提示重新确认。 */
  async function bindAttachment(clientId: string, patch: CreationRefBindBody): Promise<void> {
    const id = state.currentId
    const item = state.attachments.find((a) => a.clientId === clientId)
    if (!id || !item?.assetId || state.busyAction || attachmentsLocked.value || first.active.value) return
    const token = deps.viewEpoch()
    const prevRole = item.role
    const prevShot = item.shotId ?? null
    state.busyAction = true
    state.error = ''
    try {
      const detail = await creationChatApi.bindRef(id, item.assetId, patch)
      if (token !== deps.viewEpoch() || id !== state.currentId) return
      commit(id, detail)
      if (patch.role !== undefined) item.role = patch.role
      if (patch.shotId !== undefined) item.shotId = patch.shotId
      state.notice = '参考绑定已更新，方案需重新确认后才开始制作（此操作不计费）。'
    } catch (e) {
      if (id === state.currentId) {
        state.error = errText(e)
        item.role = prevRole
        item.shotId = prevShot
      }
    } finally {
      if (token === deps.viewEpoch()) state.busyAction = false
    }
  }

  /** 逐镜绑定切换：'' = 整片级（shotId null，服务端删键） */
  async function setAttachmentShot(clientId: string, shotId: string): Promise<void> {
    await bindAttachment(clientId, { shotId: shotId || null })
  }

  function removeAttachment(clientId: string): void {
    if (attachmentsLocked.value) return
    const i = state.attachments.findIndex((a) => a.clientId === clientId)
    if (i >= 0) state.attachments.splice(i, 1)
  }

  function retryAttachment(clientId: string): void {
    if (attachmentsLocked.value || !state.currentId) return
    const item = state.attachments.find((a) => a.clientId === clientId)
    if (item) void uploadItem(item)
  }

  function replaceAttachmentFile(clientId: string, file: File): void {
    if (attachmentsLocked.value) return
    const item = state.attachments.find((a) => a.clientId === clientId)
    if (!item) return
    if (refKindByExt(file.name) !== item.kind || !file.size || file.size > REF_MAX_PER_KIND[item.kind]) {
      item.error = '请选择同类型且大小符合限制的文件'
      return
    }
    item.file = file; item.name = file.name; item.sourceAssetId = undefined
    item.assetId = undefined; item.hash = undefined; item.error = undefined
  }

  const attachmentsLocked = computed(() => first.locked.value || state.busySend || state.attachments.some((a) => a.uploading) || !!state.detail?.session.runId || state.detail?.session.status === 'planning')
  const uploadingAttachments = computed(() =>
    state.attachments.some((a) => a.uploading),
  )
  const readyAttachmentCount = computed(
    () => state.attachments.filter((a) => a.assetId && !a.error).length,
  )

  return {
    uploadItem,
    addAttachment,
    addAssetReference,
    changeAttachmentRole,
    bindAttachment,
    setAttachmentShot,
    removeAttachment,
    retryAttachment,
    replaceAttachmentFile,
    attachmentsLocked,
    uploadingAttachments,
    readyAttachmentCount,
  }
}
