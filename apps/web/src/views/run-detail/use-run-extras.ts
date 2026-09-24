/** [M28] 运行详情附加数据：接力推荐 / 记忆徽标 / 导出包 / 成本 / 发布记录；核心状态由 deps 注入。 */
import { computed, ref } from 'vue'
import {
  assetApi,
  exportApi,
  publicationApi,
  statsApi,
  templateApi,
} from '../../lib/api'
import type { EditExchangeFormat, EditExchangeFormatsResult } from '../../lib/api'
import { createEditExchangeDownload, probeEditExchangeFormats } from '../../lib/edit-exchange'
import { confirmDialog } from '../../lib/confirm'
import { PLATFORM_TEXT } from '../../lib/format'
import { assetIds } from './internals'
import type { ComputedRef, Ref } from 'vue'
import type {
  ExportAssetLite,
  Publication,
  Run,
  RunAssetLite,
  RunDetail,
  RunStep,
  TemplateMeta,
  UsageSummary,
} from '../../lib/types'

export function useRunExtras(deps: {
  runId: number
  detail: Ref<RunDetail | null>
  run: ComputedRef<Run | null>
  steps: ComputedRef<RunStep[]>
  err: Ref<string>
}) {
  const { runId, detail, run, steps, err } = deps

  // ===== 完成态「下一步建议」接力（模板元数据 next 声明） =====
  const tplMetas = ref<TemplateMeta[]>([])
  const showRelay = ref(false)
  const relayTplKey = ref('')

  /** 挂载时拉一次模板元数据（读取 next 推荐与短名；失败静默，接力条自然隐藏） */
  async function loadTplMetas() {
    try {
      const res = await templateApi.list()
      tplMetas.value = res.items
    } catch {
      // 元数据不可达不阻断主视图
    }
  }

  /** 模板 key → 短名（未载/未知 key 回退原 key） */
  function tplName(key: string): string {
    return tplMetas.value.find((t) => t.key === key)?.name ?? key
  }

  /** 完成态：当前模板声明的推荐下游（引用不存在/未加载的 key 静默过滤） */
  const nextOptions = computed(() => {
    const r = run.value
    if (!r || r.status !== 'completed') return []
    const cur = tplMetas.value.find((t) => t.key === r.templateKey)
    return (cur?.next ?? [])
      .map((k) => tplMetas.value.find((t) => t.key === k))
      .filter((t): t is TemplateMeta => !!t)
  })

  /** 点击接力 chip：以目标模板打开启动表单（initialTemplateKey 直达表单段） */
  function openRelay(key: string) {
    relayTplKey.value = key
    showRelay.value = true
  }

  /**
   * 接力创建成功 → 跳到新 run。
   * RouterView 无 key：同路由仅参数变化会复用本组件（runId 为静态快照），
   * 故用整页跳转保证新 run 从零初始化（socket/日志/模板详情全部重载）。
   */
  function onRelayDone(id: number) {
    showRelay.value = false
    window.location.href = `/runs/${id}`
  }

  // [M3] 记忆/角色步骤徽标：读产物资产 params 组装（轻量、失败静默、按 step:asset 缓存）
  const BADGE_ACTIONS = new Set([
    'memory_write',
    'memory_recall',
    'character_sync',
  ])
  const badges = ref<Record<number, string>>({})
  const badgeCache = new Set<string>()

  async function loadBadges() {
    // 先收集待拉取项（缓存命中/无产物同步跳过），再并发拉取（替代串行 for-await）
    const todo: Array<{
      sid: number
      aid: number
      key: string
      action: string
    }> = []
    for (const s of steps.value) {
      if (!BADGE_ACTIONS.has(s.actionKey)) continue
      const aid = assetIds(s)[0]
      if (!aid) continue
      const key = `${s.id}:${aid}`
      if (badgeCache.has(key)) continue
      todo.push({ sid: s.id, aid, key, action: s.actionKey })
    }
    if (!todo.length) return
    const next: Record<number, string> = { ...badges.value }
    await Promise.all(
      todo.map(async ({ sid, aid, key, action }) => {
        try {
          const { asset: a } = await assetApi.detail(aid)
          const p = (a.params ?? {}) as Record<string, unknown>
          if (action === 'memory_recall') {
            const top =
              typeof p['topScore'] === 'number'
                ? (p['topScore'] as number).toFixed(2)
                : null
            next[sid] =
              `召回 ${p['count'] ?? 0} 条${top ? ` · top ${top}` : ''}`
          } else if (action === 'memory_write') {
            const nm =
              typeof p['name'] === 'string' && p['name']
                ? (p['name'] as string)
                : '（匿名）'
            next[sid] = `记忆已写 ${nm}`
          } else {
            next[sid] =
              `建档 ${p['created'] ?? 0} 新增 / ${p['updated'] ?? 0} 更新`
          }
          badgeCache.add(key)
        } catch {
          // 产物不可读 → 不显示徽标
        }
      }),
    )
    badges.value = next
  }

  // ===== [M4] 导出包 / 本 run 成本 / 发布记录 =====
  const showExport = ref(false)
  const showPublish = ref(false)
  const exportsList = ref<ExportAssetLite[]>([])
  const costUsage = ref<UsageSummary | null>(null)
  const publications = ref<Publication[]>([])
  const runAssets = ref<RunAssetLite[]>([])

  /** 本 run 附加数据（四路并行：导出包 / 用量聚合 / run 发布记录（服务端 run_id 过滤）/ run 产物） */
  async function loadExtras(projectId: number) {
    void loadEditExchangeFormats() // [M50] 能力探测独立异步，不阻断主附加数据加载
    try {
      const [ex, us, pub, ra] = await Promise.all([
        exportApi.list(`?run_id=${runId}`),
        statsApi.usage(`?run_id=${runId}&group_by=kind`),
        publicationApi.list(`?project_id=${projectId}&run_id=${runId}`),
        exportApi.runAssets(runId),
      ])
      exportsList.value = ex.items
      costUsage.value = us
      publications.value = pub.items
      runAssets.value = ra.items
    } catch (e) {
      // 附加数据失败不阻断主视图（成本/导出/发布为辅助信息）
      console.warn('loadExtras 失败', e)
    }
  }

  /** 显式刷新（导出完成 / 发布登记 / run 终态） */
  function refreshExtras() {
    const pid = detail.value?.run.projectId
    if (pid !== undefined) void loadExtras(pid)
  }

  /** 发布记录资产名（run 产物内查找；软删/跨 run 资产回退 #id） */
  function assetNameOf(id: number | null): string {
    if (id === null) return '—'
    return runAssets.value.find((a) => a.id === id)?.name ?? `#${id}`
  }

  /** 「标记发布」预选：run 内最新视频（通常是成片） */
  const publishCandidate = computed<number | null>(() => {
    const vids = runAssets.value.filter((a) => a.kind === 'video')
    const last = vids[vids.length - 1]
    return last ? last.id : null
  })

  /**
   * [整改] 发布记录面板可见性：只有产出可发布成品的模板才显示入口。
   * plan（选题雷达/创作策划/立项/改编等）与 operate（复盘回灌/多平台适配/翻译等）
   * 场景不产出发布物，隐藏「标记发布 / 发布记录」面板；produce 与场景未知（元数据未载/自定义模板）保留。
   */
  const showPubsPanel = computed(() => {
    const key = run.value?.templateKey
    if (!key) return true
    const scene = tplMetas.value.find((t) => t.key === key)?.scene
    return scene !== 'plan' && scene !== 'operate'
  })

  // ===== [M19] 成片多画幅派生（A 路径：对最新 final_video 二次编码） =====
  const deriveOpen = ref(false)
  /** 有 final_video 产物才可派生 */
  const hasFinalVideo = computed(() =>
    runAssets.value.some((a) => a.purpose === 'final_video'),
  )
  /** 派生完成 → 刷新 run 产物（项目资产已新行，导出/发布候选跟着更新） */
  function onDerived() {
    refreshExtras()
  }

  // ===== [M50] 剪辑工程交换导出（FCPXML / EDL / OTIO 多轨工程）=====
  /** 能力探测结果（成片存在=全开；无 timeline 且不可重算=置灰带提示；null=未载/不可达） */
  const editExFormats = ref<EditExchangeFormatsResult | null>(null)
  const editExBusy = ref(false)

  /** 拉取剪辑工程交换能力（不阻断主视图：失败静默置 null，按钮组自然隐藏/置灰） */
  async function loadEditExchangeFormats() {
    editExFormats.value = await probeEditExchangeFormats(runId)
  }

  /**
   * 生成并下载剪辑工程交换包：POST → archive 资产 → 直连下载端点 → 刷新产物列表。
   * 错误（no_final_video / no_timeline / bad_format）写 err 顶栏提示。
   */
  async function exportEditExchange(format: EditExchangeFormat) {
    if (editExBusy.value) return
    editExBusy.value = true
    try {
      await createEditExchangeDownload(runId, format)
      refreshExtras()
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e)
    } finally {
      editExBusy.value = false
    }
  }

  function onExportDone() {
    showExport.value = false
    refreshExtras()
  }

  async function removeExport(ex: ExportAssetLite) {
    const ok = await confirmDialog({
      title: '删除导出包',
      message: `删除导出包「${ex.name}」？`,
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await assetApi.remove(ex.id)
      refreshExtras()
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e)
    }
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
      refreshExtras()
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e)
    }
  }

  function onPubSaved() {
    showPublish.value = false
    refreshExtras()
  }

  return {
    tplMetas,
    showRelay,
    relayTplKey,
    loadTplMetas,
    tplName,
    nextOptions,
    openRelay,
    onRelayDone,
    BADGE_ACTIONS,
    badges,
    badgeCache,
    loadBadges,
    showExport,
    showPublish,
    exportsList,
    costUsage,
    publications,
    runAssets,
    loadExtras,
    refreshExtras,
    assetNameOf,
    publishCandidate,
    showPubsPanel,
    deriveOpen,
    hasFinalVideo,
    onDerived,
    editExFormats,
    editExBusy,
    loadEditExchangeFormats,
    exportEditExchange,
    onExportDone,
    removeExport,
    removePub,
    onPubSaved,
  }
}
export type ExtrasApi = ReturnType<typeof useRunExtras>
