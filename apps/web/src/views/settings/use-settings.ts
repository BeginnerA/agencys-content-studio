import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { configApi, settingsApi, statsApi, vendorApi } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import type { ApiConfig, ApiProvider, ProviderConfigLite, UsageItem, VendorCredential } from '../../lib/types'

export function useSettingsPage() {
  // 配置按能力分类成 tab：文本 / 图片 / 视频 / 语音（serviceType → tab 映射）+ [M19] 品牌（平台品牌资产）/ 音色库（声音克隆）
  const TABS = [
    { key: 'text', label: '文本生成', icon: 'pencil', types: ['llm'], hint: '剧本 / 文案 / 结构化输出（LLM）' },
    { key: 'image', label: '图片生成', icon: 'photo', types: ['image'], hint: '分镜 / 角色 / 封面出图' },
    { key: 'video', label: '视频生成', icon: 'video', types: ['video'], hint: '镜头动效 / AI 视频生成' },
    { key: 'audio', label: '语音合成', icon: 'speaker-wave', types: ['audio'], hint: '配音 / TTS（OpenAI 兼容 /audio/speech）' },
    { key: 'voices', label: '音色库', icon: 'wand', types: [], hint: '声音克隆（角色声线以 clone:{id} 引用）' },
  ] as const
  type TabKey = (typeof TABS)[number]['key']

  const activeTab = ref<TabKey>('text')

  const providers = ref<ApiProvider[]>([])
  const credentials = ref<VendorCredential[]>([])
  const err = ref('')
  const loading = ref(true)

  // 编辑/新建弹窗状态：provider + 待编辑 config（列表精简态，含 baseUrl / apiKeyMasked / extra 回显字段）
  const editing = ref<{ provider: ApiProvider; config: ProviderConfigLite | null } | null>(null)
  // 供应商凭证编辑弹窗
  const editingCred = ref<VendorCredential | null>(null)
  const showCredForm = ref(false)
  // 测试结果
  const testBusy = ref<number | null>(null)
  const testMsg = ref<Record<number, string>>({})

  function tabOf(key: TabKey) {
    return TABS.find((t) => t.key === key)!
  }

  // 当前 tab 下的供应商列表
  const visible = computed(() => {
    const types = tabOf(activeTab.value).types as readonly string[]
    return providers.value.filter((p) => types.includes(p.serviceType))
  })

  // tab 角标：该分类下供应商数
  function cntOf(key: TabKey): number {
    const types = tabOf(key).types as readonly string[]
    return providers.value.filter((p) => types.includes(p.serviceType)).length
  }

  // ===== 主从布局：左供应商列表 / 右供应商详情 =====
  const selectedKey = ref('')
  const selectedProvider = computed(
    () => visible.value.find((p) => p.key === selectedKey.value) ?? visible.value[0] ?? null,
  )

  /** 切换 tab / 数据刷新后收敛选择：沿用有效选择，否则优先落在已配置供应商 */
  function pickSelected() {
    if (!visible.value.length) {
      selectedKey.value = ''
      return
    }
    if (visible.value.some((p) => p.key === selectedKey.value)) return
    selectedKey.value = (visible.value.find((p) => p.configs.length) ?? visible.value[0]!).key
  }
  watch(visible, pickSelected)

  /** 就绪摘要（当前 tab）：启用实例数 / 默认实例 / 未配置供应商数 */
  const readiness = computed(() => {
    const configs = visible.value.flatMap((p) => p.configs)
    const active = configs.filter((c) => c.isActive).length
    const def = configs.find((c) => c.isDefault)
    const unconf = visible.value.filter((p) => !p.configs.length).length
    if (!configs.length) return { tone: 'warn', text: '未配置实例——流水线调用该能力将失败' }
    if (!active) return { tone: 'warn', text: `${configs.length} 个实例均已停用——调用将失败` }
    const parts = [`${active} 个启用实例`]
    if (def) parts.push(`默认：${def.name}`)
    if (unconf) parts.push(`${unconf} 家供应商未配置`)
    return { tone: 'ok', text: parts.join(' · ') }
  })

  /** 供应商列表行状态（状态点 + 文案） */
  function railStatus(p: ApiProvider) {
    const active = p.configs.filter((c) => c.isActive).length
    if (!p.configs.length) return { cls: 'off', text: '未配置' }
    if (!active) return { cls: 'warn', text: `${p.configs.length} 实例均已停用` }
    return { cls: 'ok', text: `${p.configs.length} 实例 · ${active} 启用` }
  }

  async function load() {
    loading.value = true
    err.value = ''
    try {
      const [p, c, v] = await Promise.all([configApi.providers(), configApi.list(), vendorApi.list()])
      providers.value = p.items
      credentials.value = v.items
      const byKey = new Map<string, ApiConfig[]>()
      for (const cfg of c.items) {
        const arr = byKey.get(cfg.providerKey) ?? []
        arr.push(cfg)
        byKey.set(cfg.providerKey, arr)
      }
      for (const prov of providers.value) {
        prov.configs = (byKey.get(prov.key) ?? []).map((cfg) => ({
          id: cfg.id,
          name: cfg.name,
          serviceType: cfg.serviceType,
          model: cfg.model ?? '',
          credentialId: cfg.credentialId,
          // 编辑回显：端点、Key 掩码、扩展参数与定价
          baseUrl: cfg.baseUrl,
          apiKeyMasked: cfg.apiKeyMasked,
          extra: cfg.extra,
          pricing: cfg.pricing,
          isDefault: cfg.isDefault,
          isActive: cfg.isActive,
        }))
      }
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }
  onMounted(() => {
    void load()
    void loadPricing()
  })

  /** 打开新建/编辑弹窗（走函数以便类型收窄） */
  function openNew() {
    const p = selectedProvider.value
    if (p) editing.value = { provider: p, config: null }
  }
  function openEdit(cfg: ProviderConfigLite) {
    const p = selectedProvider.value
    if (p) editing.value = { provider: p, config: cfg }
  }

  async function setDefault(cfgId: number, providerKey: string) {
    try {
      await configApi.update(cfgId, { provider_key: providerKey, is_default: true })
      await load()
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e)
    }
  }

  async function toggleActive(cfgId: number, providerKey: string, current: boolean) {
    try {
      await configApi.update(cfgId, { provider_key: providerKey, is_active: !current })
      await load()
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e)
    }
  }

  async function remove(cfg: ProviderConfigLite) {
    const ok = await confirmDialog({
      title: '删除实例',
      message: `删除实例「${cfg.name}」？`,
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await configApi.remove(cfg.id)
      await load()
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e)
    }
  }

  async function test(cfg: ProviderConfigLite) {
    testBusy.value = cfg.id
    testMsg.value[cfg.id] = ''
    try {
      const res = await configApi.test(cfg.id)
      const ms = (res as { ms?: number }).ms
      testMsg.value[cfg.id] = ms ? `✓ 连通正常（${ms}ms）` : '✓ 连通正常'
    } catch (e) {
      testMsg.value[cfg.id] = `✗ ${e instanceof Error ? e.message : String(e)}`
    } finally {
      testBusy.value = null
    }
  }

  function msgOf(id: number): string {
    return testMsg.value[id] ?? ''
  }

  // ===== 实例行「…」溢出菜单（设为默认 / 停用启用 / 删除） =====
  const menuFor = ref<number | null>(null)
  const menuUp = ref(false)
  /** 触发按钮（键盘关闭菜单后回焦） */
  const menuAnchor = ref<HTMLElement | null>(null)

  function toggleMenu(cfg: ProviderConfigLite, ev: MouseEvent) {
    if (menuFor.value === cfg.id) {
      closeMenu(true)
      return
    }
    const btn = ev.currentTarget as HTMLElement
    const r = btn.getBoundingClientRect()
    menuUp.value = window.innerHeight - r.bottom < 160
    menuAnchor.value = btn
    menuFor.value = cfg.id
    // 注：v-for 内 template ref 会被收集为数组（直接 focus 会抛错），改从触发按钮父容器取菜单节点
    void nextTick(() => btn.parentElement?.querySelector<HTMLElement>('[role="menu"]')?.focus())
  }
  function closeMenu(restoreFocus = false) {
    if (menuFor.value === null) return
    menuFor.value = null
    if (restoreFocus) {
      const el = menuAnchor.value
      void nextTick(() => el?.focus())
    }
  }
  /** 菜单动作包装：先收菜单再执行（动作内部自行刷新列表） */
  function menuAct(fn: () => void | Promise<void>) {
    closeMenu(true)
    void fn()
  }
  function menuSetDefault(cfg: ProviderConfigLite) {
    const p = selectedProvider.value
    if (p) void setDefault(cfg.id, p.key)
  }
  function menuToggle(cfg: ProviderConfigLite) {
    const p = selectedProvider.value
    if (p) void toggleActive(cfg.id, p.key, cfg.isActive)
  }
  function onDocPointerDown(e: PointerEvent) {
    if (menuFor.value === null) return
    if ((e.target as Element | null)?.closest?.('[data-menu-root]')) return
    closeMenu()
  }
  onMounted(() => document.addEventListener('pointerdown', onDocPointerDown, true))
  onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown, true))

  // ===== [M4] 用量计费（settings.pricing 编辑器 + 实例 key 选择 + 未计价引导） =====
  interface PriceRow {
    kind: string
    key: string
    unit: string
    price: string
  }

  /** 类型 → 可用单位（与 usage 记录口径一致：llm 输入/输出双行，媒体单行） */
  const PRICE_KINDS = [
    { key: 'llm', label: '文本 llm', units: ['tokens_in', 'tokens_out'] },
    { key: 'image', label: '图片 image', units: ['image'] },
    { key: 'video', label: '视频 video', units: ['second'] },
    { key: 'tts', label: '语音 tts', units: ['char'] },
  ] as const
  const PRICE_UNIT_TEXT: Record<string, string> = {
    tokens_in: 'tokens_in（输入 · 元/百万）',
    tokens_out: 'tokens_out（输出 · 元/百万）',
    image: 'image（元/张）',
    second: 'second（元/秒）',
    char: 'char（元/千字符）',
  }

  function unitOptionsOf(kind: string): readonly string[] {
    return PRICE_KINDS.find((k) => k.key === kind)?.units ?? ['image']
  }

  /** 行内切换类型：单位不兼容时自动切到该类型的第一个单位 */
  function onKindChange(r: PriceRow) {
    const units = unitOptionsOf(r.kind)
    if (!units.includes(r.unit)) r.unit = units[0]!
  }

  /** key 候选：已配置实例 {provider}:{model} + 供应商通配 {provider}:*（可自定义输入） */
  const keyOptions = computed(() => {
    const out: string[] = []
    for (const p of providers.value) {
      for (const c of p.configs) if (c.model) out.push(`${p.key}:${c.model}`)
      out.push(`${p.key}:*`)
    }
    return out
  })

  const priceRows = ref<PriceRow[]>([])
  const unpricedRows = ref<UsageItem[]>([])
  const priceBusy = ref(false)
  const priceMsg = ref('')
  const priceMsgBad = ref(false)

  /** settings.pricing 嵌套 JSON → 行数组 */
  function rowsFromPricing(v: unknown): PriceRow[] {
    const out: PriceRow[] = []
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [kind, kv] of Object.entries(v as Record<string, unknown>)) {
        if (!kv || typeof kv !== 'object' || Array.isArray(kv)) continue
        for (const [key, uv] of Object.entries(kv as Record<string, unknown>)) {
          if (!uv || typeof uv !== 'object' || Array.isArray(uv)) continue
          for (const [unit, price] of Object.entries(uv as Record<string, unknown>)) {
            out.push({ kind, key, unit, price: String(price ?? '') })
          }
        }
      }
    }
    return out
  }

  /** 行数组 → settings.pricing（key 为空/单价非法/负数的行跳过） */
  function pricingFromRows(): Record<string, Record<string, Record<string, number>>> {
    const out: Record<string, Record<string, Record<string, number>>> = {}
    for (const r of priceRows.value) {
      const key = r.key.trim()
      const price = Number(r.price)
      if (!key || !Number.isFinite(price) || price < 0) continue
      const byKey = (out[r.kind] ??= {})
      const byUnit = (byKey[key] ??= {})
      byUnit[r.unit] = price
    }
    return out
  }

  async function loadPricing() {
    try {
      const [s, u] = await Promise.all([
        settingsApi.list(),
        statsApi.usage(`?group_by=provider_model&from=${Date.now() - 30 * 86_400_000}`),
      ])
      priceRows.value = rowsFromPricing(s.items.find((it) => it.key === 'pricing')?.value)
      unpricedRows.value = u.items.filter((it) => it.unpriced > 0)
    } catch {
      // 定价/用量为辅助信息，失败静默（本页主体不受影响）
    }
  }

  function addPriceRow() {
    priceRows.value.push({ kind: 'llm', key: '', unit: 'tokens_in', price: '' })
  }

  /** 未计价 key 归属的类型：按供应商目录反查，兜底按 key 后缀推断 */
  function kindOfKey(key: string): string {
    const prov = key.split(':')[0] ?? ''
    const p = providers.value.find((pp) => pp.key === prov)
    if (p) return { llm: 'llm', image: 'image', video: 'video', audio: 'tts' }[p.serviceType] ?? 'llm'
    if (prov.endsWith('_image')) return 'image'
    if (prov.endsWith('_video')) return 'video'
    if (prov.endsWith('_audio') || prov.endsWith('_tts')) return 'tts'
    return 'llm'
  }

  /** 「补价」按 key 实际类型预填：llm 输入/输出两行；图片/视频/语音一行 */
  function addFromUnpriced(key: string) {
    const kind = kindOfKey(key)
    for (const unit of unitOptionsOf(kind)) priceRows.value.push({ kind, key, unit, price: '' })
  }

  async function savePricing() {
    priceBusy.value = true
    priceMsg.value = ''
    try {
      await settingsApi.put('pricing', pricingFromRows())
      priceMsgBad.value = false
      priceMsg.value = '✓ 已保存——对之后的用量生效，历史记录保留原快照价'
      await loadPricing()
    } catch (e) {
      priceMsgBad.value = true
      priceMsg.value = `✗ ${e instanceof Error ? e.message : String(e)}`
    } finally {
      priceBusy.value = false
    }
  }

  return {
    TABS,
    activeTab,
    providers,
    credentials,
    err,
    loading,
    editing,
    editingCred,
    showCredForm,
    testBusy,
    testMsg,
    tabOf,
    visible,
    cntOf,
    selectedKey,
    selectedProvider,
    pickSelected,
    readiness,
    railStatus,
    load,
    openNew,
    openEdit,
    setDefault,
    toggleActive,
    remove,
    test,
    msgOf,
    menuFor,
    menuUp,
    menuAnchor,
    toggleMenu,
    closeMenu,
    menuAct,
    menuSetDefault,
    menuToggle,
    onDocPointerDown,
    PRICE_KINDS,
    PRICE_UNIT_TEXT,
    unitOptionsOf,
    onKindChange,
    keyOptions,
    priceRows,
    unpricedRows,
    priceBusy,
    priceMsg,
    priceMsgBad,
    rowsFromPricing,
    pricingFromRows,
    loadPricing,
    addPriceRow,
    kindOfKey,
    addFromUnpriced,
    savePricing,
  }
}

export type SettingsApi = ReturnType<typeof useSettingsPage>
