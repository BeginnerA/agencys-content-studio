import { onMounted, ref, computed, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SeriesBoard from '../../components/project/SeriesBoard.vue'
import {
  batchApi,
  projectApi,
  publicationApi,
  runApi,
  templateApi,
} from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import { schedulePendingRefresh } from '../../lib/pending'
import { useProjectAssetOps } from './use-project-assets'
import type {
  Asset,
  Batch,
  BrandConfig,
  ProjectDetail,
  Publication,
  Run,
  TemplateMeta,
} from '../../lib/types'
import { PLATFORM_TEXT, runStatus } from '../../lib/format'
import { getSocket, studioOff, studioOn } from '../../lib/socket'

export function useProjectDetailPage() {
  const route = useRoute()
  const router = useRouter()
  const projectId = Number(route.params.id)

  // ===== 页内 Tab（?tab= 深链接，默认「运行」） =====
  const TABS = [
    { key: 'runs', label: '运行', icon: 'bolt' },
    { key: 'assets', label: '资产', icon: 'photo' },
    { key: 'pubs', label: '发布', icon: 'external' },
    { key: 'brand', label: '品牌', icon: 'brush' },
    { key: 'creation', label: '创作', icon: 'sliders' },
  ] as const
  type TabKey = (typeof TABS)[number]['key']

  function initTab(): TabKey {
    const q = route.query.tab
    return typeof q === 'string' && TABS.some((t) => t.key === q)
      ? (q as TabKey)
      : 'runs'
  }

  const activeTab = ref<TabKey>(initTab())

  function switchTab(t: TabKey) {
    activeTab.value = t
    void router.replace({ query: t === 'runs' ? {} : { tab: t } })
  }

  // 浏览器前进/后退同步 Tab
  watch(
    () => route.query.tab,
    () => {
      const t = initTab()
      if (t !== activeTab.value) activeTab.value = t
    },
  )

  // ===== 数据：核心（项目/运行/批次）、资产、发布 分组加载，错误互不拖累 =====
  const project = ref<ProjectDetail | null>(null)
  const runs = ref<Run[]>([])
  const batches = ref<Batch[]>([])
  const assets = ref<Asset[]>([])
  const pubs = ref<Publication[]>([])
  const pubSummary = ref({ views: 0, interactions: 0 })

  const coreLoading = ref(true)
  // 资产列表延迟到「资产」Tab 首次激活时加载（初始不进入加载态）
  const assetLoading = ref(false)
  const assetTotal = ref(0)
  const pubLoading = ref(true)
  const coreErr = ref('')
  const assetErr = ref('')
  const pubErr = ref('')

  // 项目品牌预览快照（BrandSettings 表单变化时实时更新）
  const projBrandSnap = ref<BrandConfig>({})
  const projWmFileSnap = ref('')
  const projIntroFileSnap = ref('')
  const projOutroFileSnap = ref('')
  const projWmPreviewTs = ref(0)
  function onProjectPreview(data: { brand: BrandConfig; wmFile: string }) {
    projBrandSnap.value = data.brand
    projWmFileSnap.value = data.wmFile
    projIntroFileSnap.value = (data.brand.intro?.file as string) || ''
    projOutroFileSnap.value = (data.brand.outro?.file as string) || ''
    projWmPreviewTs.value = Date.now()
  }

  async function loadCore(opts: { silent?: boolean } = {}) {
    if (!opts.silent) coreLoading.value = true
    coreErr.value = ''
    try {
      const [p, r, b] = await Promise.all([
        projectApi.detail(projectId),
        projectApi.runs(projectId),
        batchApi.list(`?project_id=${projectId}`),
      ])
      // 接口返回 { project } 包装（与 runApi.detail 同构）
      project.value = p.project
      runs.value = r.items
      batches.value = b.items
    } catch (e) {
      coreErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      coreLoading.value = false
    }
  }

  let assetsLoaded = false

  async function loadAssets(opts: { silent?: boolean } = {}) {
    if (!opts.silent) assetLoading.value = true
    assetErr.value = ''
    try {
      const a = await projectApi.assets(projectId, `?limit=${ASSET_LIMIT}`)
      assets.value = a.items
      assetTotal.value = a.total
      assetsLoaded = true
    } catch (e) {
      assetErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      assetLoading.value = false
    }
  }

  async function loadPubs(opts: { silent?: boolean } = {}) {
    if (!opts.silent) pubLoading.value = true
    pubErr.value = ''
    try {
      const pub = await publicationApi.list(`?project_id=${projectId}`)
      pubs.value = pub.items
      pubSummary.value = pub.summary
    } catch (e) {
      pubErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      pubLoading.value = false
    }
  }

  onMounted(() => {
    void loadCore()
    // 资产列表延迟加载：默认「运行」Tab 用不到；深链接 ?tab=assets 时立即拉取
    if (activeTab.value === 'assets') void loadAssets()
    void loadPubs()
    void loadTplMetas()
    const s = getSocket()
    s.emit('join', `project:${projectId}`)
    // 事件定向刷新：step 事件只刷运行区（高频）；run 终态追加刷资产区（可能新增产物）；
    // run.gate（进入闸门）立即刷新——页内 banner 与侧栏待审阅角标同步
    const onStep = () => {
      void loadCore({ silent: true })
      schedulePendingRefresh()
    }
    const onSettled = () => {
      void loadCore({ silent: true })
      // 资产区仅在已加载过后才跟随刷新（未打开过则不触发无谓请求）
      if (assetsLoaded) void loadAssets({ silent: true })
      // 集状态派生自最新 run → 终态后静默重载剧集地图
      seriesRef.value?.reload(true)
      schedulePendingRefresh()
    }
    const onGate = () => {
      void loadCore({ silent: true })
      // 进入闸门 → 集徽标切「待审阅」
      seriesRef.value?.reload(true)
      schedulePendingRefresh()
    }
    studioOn('run.step', onStep)
    studioOn('run.completed', onSettled)
    studioOn('run.failed', onSettled)
    studioOn('run.gate', onGate)
    onBeforeUnmount(() => {
      studioOff('run.step', onStep)
      studioOff('run.completed', onSettled)
      studioOff('run.failed', onSettled)
      studioOff('run.gate', onGate)
      s.emit('leave', `project:${projectId}`)
    })
  })

  // 「资产」Tab 首次激活时懒加载（此后常驻；刷新按钮与 run 终态事件兜底更新）
  watch(activeTab, (t) => {
    if (t === 'assets' && !assetsLoaded) void loadAssets()
  })

  // ===== 运行筛选 / 分页（前端分页；接口上限 100 在页脚明示） =====
  const RUN_FILTERS = [
    { v: 'all', t: '全部' },
    { v: 'waiting', t: '待审阅' },
    { v: 'active', t: '进行中' },
    { v: 'completed', t: '已完成' },
    { v: 'failed', t: '失败' },
    { v: 'cancelled', t: '已取消' },
  ] as const
  type RunFilter = (typeof RUN_FILTERS)[number]['v']

  const RUN_LIMIT = 100
  const BATCH_LIMIT = 100
  const PAGE_SIZE = 20
  // ?filter= 深链接（项目卡片待审阅角标直达；页内切换筛选不回写 URL）
  function initFilter(): RunFilter {
    const q = route.query.filter
    return typeof q === 'string' && RUN_FILTERS.some((f) => f.v === q)
      ? (q as RunFilter)
      : 'all'
  }
  const runFilter = ref<RunFilter>(initFilter())
  const rowPage = ref(1)

  /** 状态匹配（筛选作用于运行记录；批次行在其批内有匹配记录时入列） */
  function runMatch(r: Run, f: RunFilter): boolean {
    if (f === 'all') return true
    if (f === 'waiting') return r.status === 'waiting_input'
    if (f === 'active') return r.status === 'queued' || r.status === 'running'
    return r.status === f
  }

  // ===== KPI 指标条 =====
  const runningCount = computed(
    () => runs.value.filter((r) => r.status === 'running').length,
  )
  const waitingRuns = computed(() =>
    runs.value.filter((r) => r.status === 'waiting_input'),
  )
  const assetCount = computed(
    () => project.value?.assetCount ?? assets.value.length,
  )

  /** 指标卡入口：切到「运行」并套用筛选 */
  function gotoRuns(f: RunFilter) {
    runFilter.value = f
    switchTab('runs')
  }

  /** 项目品牌已配置槽数（品牌 tab 角标） */
  const brandSlotCount = computed(() => {
    const s = project.value?.settings
    const b =
      s && typeof s === 'object'
        ? (s as Record<string, unknown>)['brand']
        : undefined
    if (!b || typeof b !== 'object' || Array.isArray(b)) return 0
    const o = b as Record<string, unknown>
    return (['subtitle', 'watermark', 'intro', 'outro'] as const).filter(
      (k) => o[k] !== undefined && o[k] !== null,
    ).length
  })

  /** 「创作」tab 角标：项目是否设了对白严格 ASR 覆盖（dialogue_asr.strict 为布尔） */
  const creationAsrOverride = computed(() => {
    const s = project.value?.settings
    const d =
      s && typeof s === 'object'
        ? (s as Record<string, unknown>)['dialogue_asr']
        : undefined
    return (
      !!d &&
      typeof d === 'object' &&
      typeof (d as { strict?: unknown }).strict === 'boolean'
    )
  })

  function cntOf(key: TabKey): number {
    if (key === 'runs') return runs.value.length
    if (key === 'assets') return assetCount.value
    if (key === 'brand') return brandSlotCount.value
    if (key === 'creation') return creationAsrOverride.value ? 1 : 0
    return pubs.value.length
  }

  // ===== 批次与运行：合并为单一列表（批内运行并入批次行，按需展开） =====
  /** 批内子运行按批次分组（升序：批内序号）；仅含加载窗口内记录 */
  const childrenByBatch = computed(() => {
    const m = new Map<number, Run[]>()
    for (const r of runs.value) {
      if (r.batchId === null) continue
      const list = m.get(r.batchId)
      if (list) list.push(r)
      else m.set(r.batchId, [r])
    }
    for (const list of m.values())
      list.sort((a, b) => (a.batchSeq ?? a.id) - (b.batchSeq ?? b.id))
    return m
  })

  const batchIdSet = computed(() => new Set(batches.value.map((b) => b.id)))

  /** 独立运行（不属于已加载批次；批次在窗口外的孤儿运行也保留展示，避免记录消失） */
  const standaloneRuns = computed(() =>
    runs.value.filter(
      (r) => r.batchId === null || !batchIdSet.value.has(r.batchId),
    ),
  )

  interface TopRow {
    kind: 'batch' | 'run'
    ts: number
    batch: Batch | null
    run: Run | null
  }

  /** 顶层级行：批次 + 独立运行，按创建时间倒序混排 */
  const topRows = computed<TopRow[]>(() => {
    const f = runFilter.value
    const rows: TopRow[] = []
    for (const b of batches.value) {
      if (
        f === 'all' ||
        (childrenByBatch.value.get(b.id) ?? []).some((r) => runMatch(r, f))
      ) {
        rows.push({ kind: 'batch', ts: b.createdAt, batch: b, run: null })
      }
    }
    for (const r of standaloneRuns.value) {
      if (runMatch(r, f))
        rows.push({ kind: 'run', ts: r.createdAt, batch: null, run: r })
    }
    return rows.sort((a, b) => b.ts - a.ts)
  })

  const rowPageCount = computed(() =>
    Math.max(1, Math.ceil(topRows.value.length / PAGE_SIZE)),
  )

  /** 展开态批次的子运行（筛选生效时仅展示匹配项） */
  function visibleChildren(b: Batch): Run[] {
    const list = childrenByBatch.value.get(b.id) ?? []
    const f = runFilter.value
    return f === 'all' ? list : list.filter((r) => runMatch(r, f))
  }

  const expanded = ref<Set<number>>(new Set())

  function toggleBatch(id: number) {
    if (expanded.value.has(id)) expanded.value.delete(id)
    else expanded.value.add(id)
  }

  type DisplayRow =
    | { key: string; kind: 'batch'; batch: Batch }
    | { key: string; kind: 'child'; run: Run }
    | { key: string; kind: 'run'; run: Run }
    | { key: string; kind: 'note'; text: string; batchId: number }

  /** 当前页显示行（展开的批内子运行与加载窗口提示行紧随批次行） */
  const pagedRows = computed<DisplayRow[]>(() => {
    const out: DisplayRow[] = []
    for (const t of topRows.value.slice(
      (rowPage.value - 1) * PAGE_SIZE,
      rowPage.value * PAGE_SIZE,
    )) {
      if (t.kind === 'batch' && t.batch) {
        const b = t.batch
        out.push({ key: `b-${b.id}`, kind: 'batch', batch: b })
        if (!expanded.value.has(b.id)) continue
        const kids = visibleChildren(b)
        for (const r of kids)
          out.push({ key: `c-${r.id}`, kind: 'child', run: r })
        if (!kids.length) {
          out.push({
            key: `n-${b.id}`,
            kind: 'note',
            text: '批内运行不在加载窗口内（仅加载最近 100 次运行）',
            batchId: b.id,
          })
        } else if (runFilter.value === 'all' && kids.length < b.total) {
          out.push({
            key: `n-${b.id}`,
            kind: 'note',
            text: `仅载入 ${kids.length}/${b.total} 项，更早记录见批次详情`,
            batchId: b.id,
          })
        }
      } else if (t.run) {
        out.push({ key: `r-${t.run.id}`, kind: 'run', run: t.run })
      }
    }
    return out
  })

  watch(runFilter, () => {
    rowPage.value = 1
  })

  watch(topRows, () => {
    if (rowPage.value > rowPageCount.value) rowPage.value = rowPageCount.value
  })

  // ===== 资产操作（收藏/清理/打标/上传/抓取）另拆 use-project-assets，同名解构保持装配面不变 =====
  const {
    favOnly,
    assetNotice,
    assetBusy,
    onFavorite,
    onAssetChanged,
    onAssetRemoved,
    doCleanupVersions,
    doGc,
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
  } = useProjectAssetOps({ projectId, assets, assetTotal, assetErr, loadAssets, loadCore })

  // ===== 资产筛选（接口上限 200 在网格下方明示） =====
  const ASSET_LIMIT = 200
  const purposeFilter = ref('all')
  /** 标签筛选（客户端聚合去重，'all' = 不过滤） */
  const tagFilter = ref('all')

  const purposes = computed(() => {
    const set = new Set(assets.value.map((a) => a.purpose))
    return ['all', ...set]
  })

  const filteredAssets = computed(() => {
    let list = assets.value
    if (purposeFilter.value !== 'all')
      list = list.filter((a) => a.purpose === purposeFilter.value)
    if (favOnly.value) list = list.filter((a) => a.isFavorite === 1)
    if (tagFilter.value !== 'all')
      list = list.filter((a) => (a.tags ?? []).includes(tagFilter.value))
    return list
  })

  // ===== 启动流水线 / 批量运行 =====
  const showRunForm = ref(false)
  const showBatch = ref(false)

  // 剧集地图「起作」：记录集号 → 弹窗预选项目模板 + 预填 episode_number
  const seriesRef = ref<InstanceType<typeof SeriesBoard> | null>(null)
  const startEpisodeNumber = ref<number | null>(null)
  const runFormTplKey = computed(() =>
    startEpisodeNumber.value !== null ? defaultTplKey.value : undefined,
  )
  const runFormPrefill = computed(() =>
    startEpisodeNumber.value !== null
      ? { episode_number: startEpisodeNumber.value }
      : undefined,
  )

  function onStartEpisode(n: number) {
    startEpisodeNumber.value = n
    showRunForm.value = true
  }

  function closeRunForm() {
    showRunForm.value = false
    startEpisodeNumber.value = null
  }

  function onRunCreated(runId: number) {
    showRunForm.value = false
    startEpisodeNumber.value = null
    seriesRef.value?.reload(true)
    void loadCore({ silent: true })
    router.push(`/runs/${runId}`)
  }

  function onBatchCreated(batchId: number) {
    showBatch.value = false
    router.push(`/batches/${batchId}`)
  }

  // ===== 发布记录 =====
  const showPublish = ref(false)
  const editingPub = ref<Publication | null>(null)

  /** 发布记录的资产名（复用已加载 assets；找不到回退 #id） */
  function assetNameOf(id: number | null): string {
    if (id === null) return '—'
    return assets.value.find((a) => a.id === id)?.name ?? `#${id}`
  }

  function openPublish(pub: Publication | null) {
    editingPub.value = pub
    showPublish.value = true
  }

  async function removePub(pub: Publication) {
    const ok = await confirmDialog({
      title: '删除发布记录',
      message: `删除这条发布记录（${PLATFORM_TEXT[pub.platform] ?? pub.platform}）？`,
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await publicationApi.remove(pub.id)
      await loadPubs({ silent: true })
    } catch (e) {
      pubErr.value = e instanceof Error ? e.message : String(e)
    }
  }

  function onPubSaved() {
    showPublish.value = false
    void loadPubs({ silent: true })
  }

  // ===== [优化] 编辑项目 / 模板短名 =====
  const showEdit = ref(false)
  const tplMetas = ref<TemplateMeta[]>([])

  // ===== 危险操作（归档 / 彻底删除） =====
  const showDanger = ref(false)

  /** 模板元数据静默加载（短名展示；失败回退裸 key） */
  async function loadTplMetas() {
    try {
      const t = await templateApi.list()
      tplMetas.value = t.items
    } catch {
      // 静默
    }
  }

  /** 模板 key → 短名（未载/未知 key 回退原 key） */
  function tplName(key: string): string {
    return tplMetas.value.find((t) => t.key === key)?.name ?? key
  }

  /** 默认模板透传给运行入口（启动/批量弹窗预选与徽章） */
  const defaultTplKey = computed(() => project.value?.templateKey ?? undefined)

  function onEdited() {
    showEdit.value = false
    void loadCore({ silent: true })
  }

  /** 归档 / 彻底删除完成：返回项目列表 */
  function onDeleted() {
    showDanger.value = false
    void router.push('/')
  }

  /** runs 行内错误摘要 */
  function errOf(r: Run): string {
    if (r.status !== 'failed') return ''
    const s = r.error ?? ''
    return s.length > 90 ? s.slice(0, 90) + '…' : s
  }

  // ===== 删除运行 / 批次（仅终态；不可恢复，产物资产与成本记录保留） =====
  const RUN_TERMINAL = ['completed', 'failed', 'cancelled']
  /** 行级删除可用性（与服务端守卫同口径；waiting_input 不算终态） */
  function runDeletable(r: Run): boolean {
    return RUN_TERMINAL.includes(r.status)
  }

  async function deleteRunRow(r: Run) {
    const ok = await confirmDialog({
      title: '删除运行',
      message: `删除 Run #${r.id}（${runStatus(r.status).text}）的运行记录？步骤与子任务一并删除，不可恢复；产物素材与成本记录保留。`,
      confirmText: '删除运行',
      danger: true,
    })
    if (!ok) return
    try {
      await runApi.remove(r.id)
      seriesRef.value?.reload(true)
      await loadCore({ silent: true })
    } catch (e) {
      coreErr.value = e instanceof Error ? e.message : String(e)
    }
  }

  async function deleteBatchRow(b: Batch) {
    const ok = await confirmDialog({
      title: '删除批次',
      message: `删除批次「${b.name}」及其批内全部 ${b.total} 个运行记录？不可恢复；产物素材与成本记录保留。`,
      confirmText: '删除批次',
      danger: true,
    })
    if (!ok) return
    try {
      await batchApi.remove(b.id)
      seriesRef.value?.reload(true)
      await loadCore({ silent: true })
    } catch (e) {
      coreErr.value = e instanceof Error ? e.message : String(e)
    }
  }

  return {
    route,
    router,
    projectId,
    TABS,
    initTab,
    activeTab,
    switchTab,
    project,
    runs,
    batches,
    assets,
    pubs,
    pubSummary,
    coreLoading,
    assetLoading,
    assetTotal,
    pubLoading,
    coreErr,
    assetErr,
    pubErr,
    projBrandSnap,
    projWmFileSnap,
    projIntroFileSnap,
    projOutroFileSnap,
    projWmPreviewTs,
    onProjectPreview,
    loadCore,
    loadAssets,
    loadPubs,
    RUN_FILTERS,
    RUN_LIMIT,
    BATCH_LIMIT,
    PAGE_SIZE,
    initFilter,
    runFilter,
    rowPage,
    runMatch,
    runningCount,
    waitingRuns,
    assetCount,
    gotoRuns,
    brandSlotCount,
    cntOf,
    childrenByBatch,
    batchIdSet,
    standaloneRuns,
    topRows,
    rowPageCount,
    visibleChildren,
    expanded,
    toggleBatch,
    pagedRows,
    ASSET_LIMIT,
    purposeFilter,
    purposes,
    tagFilter,
    allTags,
    tagSelectMode,
    checkedIds,
    bulkTagInput,
    bulkBusy,
    onToggleCheck,
    toggleTagSelect,
    applyBulkTag,
    filteredAssets,
    favOnly,
    assetNotice,
    assetBusy,
    onFavorite,
    onAssetChanged,
    onAssetRemoved,
    doCleanupVersions,
    doGc,
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
    showRunForm,
    showBatch,
    seriesRef,
    startEpisodeNumber,
    runFormTplKey,
    runFormPrefill,
    onStartEpisode,
    closeRunForm,
    onRunCreated,
    onBatchCreated,
    showPublish,
    editingPub,
    assetNameOf,
    openPublish,
    removePub,
    onPubSaved,
    showEdit,
    tplMetas,
    showDanger,
    loadTplMetas,
    tplName,
    defaultTplKey,
    onEdited,
    onDeleted,
    errOf,
    runDeletable,
    deleteRunRow,
    deleteBatchRow,
  }
}

export type ProjectDetailApi = ReturnType<typeof useProjectDetailPage>
