/**
 * 项目详情页「资产操作」composable（自 use-project-detail.ts 原样搬出，行为零变更）：
 * 收藏/版本清理/清空回收站文件/回收站还原与彻底删除 + 标签聚合/批量打标 + 上传素材 + URL 抓取正文入库。
 * 状态真源仍归本组合（视图经 useProjectDetailPage 装配后同名解构使用）。
 */
import { ref, computed, type Ref } from 'vue'
import { assetApi, projectApi, uploadFiles } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import { fmtSize } from '../../lib/format'
import type { Asset } from '../../lib/types'

export function useProjectAssetOps(ctx: {
  projectId: number
  assets: Ref<Asset[]>
  assetTotal: Ref<number>
  assetErr: Ref<string>
  loadAssets: (opts?: { silent?: boolean }) => Promise<void>
  loadCore: (opts?: { silent?: boolean }) => Promise<void>
}) {
  const { projectId, assets, assetTotal, assetErr, loadAssets, loadCore } = ctx

  // ===== 收藏 / 版本清理 / 回收站 =====
  const favOnly = ref(false)
  const assetNotice = ref('')
  const assetBusy = ref(false)

  /** 收藏切换（AssetGrid emit → API → 原地替换，保持列表对象新鲜） */
  async function onFavorite(a: Asset) {
    assetErr.value = ''
    assetNotice.value = ''
    const next = a.isFavorite !== 1
    try {
      const r = await assetApi.favorite(a.id, next)
      const i = assets.value.findIndex((x) => x.id === a.id)
      if (i >= 0) assets.value[i] = r.asset
      assetNotice.value = next
        ? `「${a.name}」已收藏（版本清理保留豁免）`
        : `「${a.name}」已取消收藏`
    } catch (e) {
      assetErr.value = e instanceof Error ? e.message : String(e)
    }
  }

  /** 预览器重检结果同步（替换列表对象；网格徽标即时刷新） */
  function onAssetChanged(u: Asset) {
    const i = assets.value.findIndex((x) => x.id === u.id)
    if (i >= 0) assets.value[i] = u
  }

  /** 资产删除（预览器 removed → 列表原地移除 + 通知；后端软删进回收站可还原） */
  function onAssetRemoved(a: Asset) {
    const i = assets.value.findIndex((x) => x.id === a.id)
    if (i >= 0) assets.value.splice(i, 1)
    assetTotal.value = Math.max(0, assetTotal.value - 1)
    assetNotice.value = `已删除资产「${a.name}」，可在「回收站」还原或彻底删除`
  }

  /** 项目级版本组批量清理（保留最新 / 收藏 / 在用；其余移入回收站） */
  async function doCleanupVersions() {
    const ok = await confirmDialog({
      title: '清理历史版本',
      message:
        '将清理本项目图片 / 视频的历史版本：每组保留最新 1 个、已收藏的、以及正在被流水线引用的；其余移入回收站（可在回收站还原）。',
      confirmText: '开始清理',
    })
    if (!ok) return
    assetBusy.value = true
    assetErr.value = ''
    assetNotice.value = ''
    try {
      const r = await assetApi.cleanupVersions(projectId)
      assetNotice.value = r.note
      await loadAssets({ silent: true })
    } catch (e) {
      assetErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      assetBusy.value = false
    }
  }

  /** 清空回收站（入口在回收站弹窗内；批量彻底删除：物理删文件 + 移除记录，条目从回收站消失；字幕引用条目跳过保留） */
  async function doEmptyTrash() {
    const ok = await confirmDialog({
      title: '清空回收站',
      message:
        '将彻底删除回收站内所有资产：物理删除磁盘文件并移除记录，不可恢复、无法再还原。被字幕修订/历史成片引用的条目会跳过保留。',
      confirmText: '确认清空',
      danger: true,
    })
    if (!ok) return
    assetBusy.value = true
    assetErr.value = ''
    assetNotice.value = ''
    try {
      const r = await assetApi.emptyTrash(projectId)
      assetNotice.value =
        `已清空回收站：移除 ${r.purged} 条，释放 ${fmtSize(r.freed_bytes)}` +
        (r.skipped > 0 ? `；${r.skipped} 条被字幕修订引用，已跳过保留` : '')
      await loadAssets({ silent: true })
      // 弹窗内操作：同步刷新回收站列表（已移除条目消失；被跳过的保护条目保留）
      if (showTrash.value) await loadTrash()
    } catch (e) {
      assetErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      assetBusy.value = false
    }
  }

  // ===== 回收站（软删资产浏览 / 还原 / 彻底删除） =====
  const showTrash = ref(false)
  const trashLoading = ref(false)
  const trashItems = ref<Asset[]>([])
  /** 正在操作的回收站条目 id（还原/彻底删除互斥，null = 空闲） */
  const trashActing = ref<number | null>(null)

  async function loadTrash() {
    trashLoading.value = true
    try {
      const r = await projectApi.assets(projectId, '?trash=1&limit=500')
      trashItems.value = r.items
    } catch (e) {
      assetErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      trashLoading.value = false
    }
  }

  function openTrash() {
    showTrash.value = true
    void loadTrash()
  }

  /** 还原：清软删标记回活跃列表（文件已被「清空回收站文件」删除 → 后端 409 拒绝） */
  async function restoreTrashed(a: Asset) {
    if (trashActing.value != null) return
    trashActing.value = a.id
    assetErr.value = ''
    try {
      await assetApi.restore(a.id)
      trashItems.value = trashItems.value.filter((x) => x.id !== a.id)
      assetNotice.value = `已还原资产「${a.name}」`
      await loadAssets({ silent: true })
      // 项目详情 assetCount 随软删状态变化 → 静默刷核心区
      void loadCore({ silent: true })
    } catch (e) {
      assetErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      trashActing.value = null
    }
  }

  /** 彻底删除：物理删文件 + 硬删记录（不可逆，二次确认） */
  async function purgeTrashed(a: Asset) {
    if (trashActing.value != null) return
    const ok = await confirmDialog({
      title: '彻底删除资产',
      message: `将物理删除「${a.name}」的磁盘文件并移除记录，不可恢复。`,
      confirmText: '彻底删除',
      danger: true,
    })
    if (!ok) return
    trashActing.value = a.id
    assetErr.value = ''
    try {
      const r = await assetApi.purge(a.id)
      trashItems.value = trashItems.value.filter((x) => x.id !== a.id)
      assetNotice.value = `已彻底删除「${a.name}」，释放 ${fmtSize(r.freed_bytes)}`
    } catch (e) {
      assetErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      trashActing.value = null
    }
  }

  // ===== 标签：聚合 / 批量打标（追加去重；并发 ≤6） =====
  /** 当前加载资产的标签聚合（去重排序） */
  const allTags = computed(() => {
    const set = new Set<string>()
    for (const a of assets.value) for (const t of a.tags ?? []) set.add(t)
    return [...set].sort((x, y) => x.localeCompare(y, 'zh'))
  })

  const tagSelectMode = ref(false)
  const checkedIds = ref<number[]>([])
  const bulkTagInput = ref('')
  const bulkBusy = ref(false)

  function onToggleCheck(a: Asset) {
    const i = checkedIds.value.indexOf(a.id)
    if (i >= 0) checkedIds.value.splice(i, 1)
    else checkedIds.value.push(a.id)
  }

  function toggleTagSelect() {
    tagSelectMode.value = !tagSelectMode.value
    if (!tagSelectMode.value) checkedIds.value = []
  }

  /** 应用：选中项逐个追加标签（去重）；并发 6 workers + allSettled，失败计数提示 */
  async function applyBulkTag() {
    const tag = bulkTagInput.value.trim()
    if (!tag || !checkedIds.value.length || bulkBusy.value) return
    bulkBusy.value = true
    assetErr.value = ''
    assetNotice.value = ''
    const ids = new Set(checkedIds.value)
    const queue = assets.value.filter((a) => ids.has(a.id))
    let ok = 0
    let fail = 0
    const workers = Array.from(
      { length: Math.min(6, queue.length) },
      async () => {
        while (queue.length) {
          const a = queue.shift()!
          try {
            const r = await assetApi.updateTags(a.id, [
              ...new Set([...(a.tags ?? []), tag]),
            ])
            onAssetChanged(r.asset)
            ok += 1
          } catch {
            fail += 1
          }
        }
      },
    )
    await Promise.allSettled(workers)
    bulkBusy.value = false
    if (fail)
      assetErr.value = `批量打标：${ok} 成功 / ${fail} 失败（可刷新后重试）`
    else assetNotice.value = `已为 ${ok} 个资产追加标签「${tag}」`
    bulkTagInput.value = ''
    checkedIds.value = []
    tagSelectMode.value = false
  }

  // ===== 上传素材 =====
  const showUpload = ref(false)
  const uploadPurpose = ref('source')
  const uploadFilesSel = ref<File[]>([])
  const uploading = ref(false)
  const uploadErr = ref('')

  function onUploadChange(e: Event) {
    const input = e.target as HTMLInputElement
    uploadFilesSel.value = input.files ? Array.from(input.files) : []
  }

  async function doUpload() {
    if (!uploadFilesSel.value.length) return
    uploading.value = true
    uploadErr.value = ''
    try {
      await uploadFiles(projectId, uploadPurpose.value, uploadFilesSel.value)
      uploadFilesSel.value = []
      showUpload.value = false
      await loadAssets({ silent: true })
      await loadCore({ silent: true })
    } catch (e) {
      uploadErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      uploading.value = false
    }
  }

  // ===== G8 从 URL 抓取正文入库（source 资产；SSRF 守卫在后端） =====
  const showFetch = ref(false)
  const fetchUrl = ref('')
  const fetching = ref(false)
  const fetchErr = ref('')

  async function doFetchSource() {
    const u = fetchUrl.value.trim()
    if (!u || fetching.value) return
    fetching.value = true
    fetchErr.value = ''
    try {
      await assetApi.fetchSource(projectId, u)
      fetchUrl.value = ''
      showFetch.value = false
      assetNotice.value = '已从 URL 抓取正文并入库为素材资产'
      await loadAssets({ silent: true })
      await loadCore({ silent: true })
    } catch (e) {
      fetchErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      fetching.value = false
    }
  }

  return {
    favOnly,
    assetNotice,
    assetBusy,
    onFavorite,
    onAssetChanged,
    onAssetRemoved,
    doCleanupVersions,
    doEmptyTrash,
    showTrash,
    trashLoading,
    trashItems,
    trashActing,
    openTrash,
    loadTrash,
    restoreTrashed,
    purgeTrashed,
    allTags,
    tagSelectMode,
    checkedIds,
    bulkTagInput,
    bulkBusy,
    onToggleCheck,
    toggleTagSelect,
    applyBulkTag,
    showUpload,
    uploadPurpose,
    uploadFilesSel,
    uploading,
    uploadErr,
    onUploadChange,
    doUpload,
    showFetch,
    fetchUrl,
    fetching,
    fetchErr,
    doFetchSource,
  }
}
