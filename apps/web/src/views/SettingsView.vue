<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ApiConfigForm from '../components/ApiConfigForm.vue'
import VendorCredentialForm from '../components/VendorCredentialForm.vue'
import Icon from '../components/Icon.vue'
import SearchSelect from '../components/SearchSelect.vue'
import { configApi, settingsApi, statsApi, vendorApi } from '../lib/api'
import { confirmDialog } from '../lib/confirm'
import type { ApiConfig, ApiProvider, ProviderConfigLite, UsageItem, VendorCredential } from '../lib/types'
import { fmtQty } from '../lib/format'

// 配置按能力分类成 tab：文本 / 图片 / 视频 / 语音（serviceType → tab 映射）
const TABS = [
  { key: 'text', label: '文本生成', icon: 'pencil', types: ['llm'], hint: '剧本 / 文案 / 结构化输出（LLM）' },
  { key: 'image', label: '图片生成', icon: 'photo', types: ['image'], hint: '分镜 / 角色 / 封面出图' },
  { key: 'video', label: '视频生成', icon: 'video', types: ['video'], hint: '镜头动效 / AI 视频生成' },
  { key: 'audio', label: '语音合成', icon: 'speaker-wave', types: ['audio'], hint: '配音 / TTS（OpenAI 兼容 /audio/speech）' },
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
</script>

<template>
  <div>
    <div class="page-h">
      <h1>AI 配置</h1>
      <span class="sub">密钥仅存本地 data/secrets.json（不入库）</span>
      <div class="tabs" role="tablist" aria-label="按能力分类">
        <button
          v-for="t in TABS"
          :key="t.key"
          class="tab"
          role="tab"
          :aria-selected="activeTab === t.key"
          :class="{ on: activeTab === t.key }"
          @click="activeTab = t.key"
        >
          <Icon :name="t.icon" :size="13" :stroke-width="1.8" />
          {{ t.label }}
          <span class="cnt">{{ cntOf(t.key) }}</span>
        </button>
      </div>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="loading" class="empty">加载中…</div>

    <template v-else>
      <!-- 就绪摘要（当前能力） -->
      <div class="ready" :class="readiness.tone">
        <span class="r-dot" />
        <span>{{ readiness.text }}</span>
        <span class="r-hint">{{ tabOf(activeTab).hint }}</span>
      </div>

      <!-- 供应商凭证管理（卡片式列表，API Key 只配一次） -->
      <details class="panel creds" open>
        <summary class="psum">
          <Icon name="key" :size="14" />
          <span class="pt">供应商凭证</span>
          <span class="muted">每个厂商只需配置一次 API Key，所有模型实例共享</span>
          <span class="chev"><Icon name="chevron-down" :size="14" /></span>
        </summary>
        <div class="pbody">
          <div class="cred-grid">
            <div v-for="cr in credentials" :key="cr.id" class="cred-card" :class="{ 'no-key': !cr.hasKey }">
              <div class="cc-head">
                <span class="cc-name">{{ cr.name }}</span>
                <span v-if="cr.hasKey" class="cc-key mono">{{ cr.apiKeyMasked }}</span>
                <span v-else class="cc-key warn">未配置 Key</span>
              </div>
              <div class="cc-meta">
                <span class="muted">{{ cr.configCount }} 个实例</span>
                <span v-if="cr.vendor" class="muted mono">{{ cr.vendor }}</span>
              </div>
              <button class="btn sm" @click="editingCred = cr; showCredForm = true">
                {{ cr.hasKey ? '修改' : '配置 Key' }}
              </button>
            </div>
          </div>
        </div>
      </details>

      <!-- 主从布局：左供应商列表 / 右供应商详情 -->
      <div :key="activeTab" class="split">
        <aside class="panel rail" aria-label="供应商列表">
          <div class="rhead">供应商（{{ visible.length }}）</div>
          <button
            v-for="p in visible"
            :key="p.key"
            class="item"
            :class="{ active: selectedProvider?.key === p.key }"
            :aria-current="selectedProvider?.key === p.key ? 'true' : undefined"
            @click="selectedKey = p.key"
          >
            <div class="i1">
              <span class="ik">{{ p.name }}</span>
              <span v-if="p.configs.length" class="icount">{{ p.configs.length }}</span>
            </div>
            <div class="ist">
              <span class="dot" :class="railStatus(p).cls" />{{ railStatus(p).text }}
            </div>
          </button>
        </aside>

        <section v-if="selectedProvider" class="panel detail">
          <div class="dhead">
            <div class="dtl">
              <span class="pname">{{ selectedProvider.name }}</span>
              <span class="pk mono" :title="`供应商 key：${selectedProvider.key}`">{{ selectedProvider.key }}</span>
            </div>
            <button class="btn sm primary" @click="openNew">
              <Icon name="plus" :size="13" :stroke-width="2.2" /> 新建实例
            </button>
          </div>
          <div class="pdesc muted">{{ selectedProvider.description }}</div>

          <div v-if="!selectedProvider.configs.length" class="dempty">
            <span class="muted">未配置实例——流水线调用该能力将失败</span>
            <button class="btn sm" @click="openNew">立即配置</button>
          </div>

          <table v-else class="tbl">
            <thead>
              <tr>
                <th>实例</th>
                <th>模型</th>
                <th style="width: 90px">状态</th>
                <th style="width: 176px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="cfg in selectedProvider.configs" :key="cfg.id">
                <td>
                  <div class="inst">
                    <span class="iname">
                      {{ cfg.name }}
                      <span v-if="cfg.isDefault" class="tag-default">默认</span>
                    </span>
                    <span v-if="msgOf(cfg.id)" class="tmsg" :class="{ bad: msgOf(cfg.id).startsWith('✗') }">
                      {{ msgOf(cfg.id) }}
                    </span>
                  </div>
                </td>
                <td class="mono" style="font-size: 12px">{{ cfg.model || '—' }}</td>
                <td>
                  <span class="badge" :class="cfg.isActive ? 'succeeded' : 'cancelled'">
                    {{ cfg.isActive ? '启用' : '停用' }}
                  </span>
                </td>
                <td>
                  <div class="ops">
                    <button class="btn sm" :disabled="testBusy === cfg.id" @click="test(cfg)">
                      {{ testBusy === cfg.id ? '测试中…' : '测试' }}
                    </button>
                    <button class="btn sm" @click="openEdit(cfg)">编辑</button>
                    <div class="mwrap" data-menu-root>
                      <button
                        class="btn sm mbtn"
                        aria-haspopup="menu"
                        aria-label="更多操作"
                        :aria-expanded="menuFor === cfg.id"
                        title="更多操作"
                        @click="toggleMenu(cfg, $event)"
                      >
                        <Icon name="more" :size="14" />
                      </button>
                      <div
                        v-if="menuFor === cfg.id"
                        class="menu"
                        :class="{ up: menuUp }"
                        role="menu"
                        aria-label="实例操作"
                        tabindex="-1"
                        @keydown.esc.stop="closeMenu(true)"
                      >
                        <button v-if="!cfg.isDefault" class="mi" role="menuitem" @click="menuAct(() => menuSetDefault(cfg))">
                          设为默认
                        </button>
                        <button class="mi" role="menuitem" @click="menuAct(() => menuToggle(cfg))">
                          {{ cfg.isActive ? '停用' : '启用' }}
                        </button>
                        <div class="msep" />
                        <button class="mi bad" role="menuitem" @click="menuAct(() => remove(cfg))">删除</button>
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      <!-- [M4] 用量计费（折叠；实例级定价优先，此处为全局兜底） -->
      <details class="panel pricing">
        <summary class="psum">
          <Icon name="chart" :size="14" />
          <span class="pt">全局兜底定价</span>
          <span class="muted">实例未配置定价时回退到此处；记录时快照计价——改价只影响之后用量</span>
          <span v-if="unpricedRows.length" class="badge skip">近 30 天未计价 {{ unpricedRows.length }} 项</span>
          <span class="chev"><Icon name="chevron-down" :size="14" /></span>
        </summary>
        <div class="pbody">
          <div class="pbar">
            <span class="muted">key 形如 {供应商}:{模型}，可选已配置实例；{供应商}:* 通配该供应商全部模型</span>
            <div class="pops">
              <button class="btn sm" @click="addPriceRow">
                <Icon name="plus" :size="12" :stroke-width="2.2" /> 添加行
              </button>
              <button class="btn sm primary" :disabled="priceBusy" @click="savePricing">
                {{ priceBusy ? '保存中…' : '保存' }}
              </button>
            </div>
          </div>
          <div v-if="priceMsg" class="pmsg" :class="{ bad: priceMsgBad }">{{ priceMsg }}</div>

          <table v-if="priceRows.length" class="tbl">
            <thead>
              <tr>
                <th style="width: 128px">类型</th>
                <th>供应商 / 模型（key）</th>
                <th style="width: 220px">单位</th>
                <th style="width: 120px">单价</th>
                <th style="width: 64px"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in priceRows" :key="i">
                <td>
                  <select v-model="r.kind" @change="onKindChange(r)">
                    <option v-for="k in PRICE_KINDS" :key="k.key" :value="k.key">{{ k.label }}</option>
                  </select>
                </td>
                <td>
                  <SearchSelect
                    v-model="r.key"
                    :options="keyOptions"
                    :max-render="200"
                    placeholder="搜索实例或输入 key"
                    aria-label="供应商 / 模型 key"
                  />
                </td>
                <td>
                  <select v-model="r.unit">
                    <option v-for="u in unitOptionsOf(r.kind)" :key="u" :value="u">{{ PRICE_UNIT_TEXT[u] }}</option>
                  </select>
                </td>
                <td><input v-model="r.price" type="number" min="0" step="0.0001" placeholder="0" /></td>
                <td><button class="btn sm danger" @click="priceRows.splice(i, 1)">删除</button></td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty" style="padding: 14px 0">
            暂无定价——未命中定价的用量记为「未计价」（cost 空缺，不计入成本统计）
          </div>

          <div v-if="unpricedRows.length" class="unpriced">
            <div class="uphead">
              <span class="badge skip">近 30 天未计价 {{ unpricedRows.length }} 项</span>
              <span class="muted">「补价」按记录类型自动预填：文本输入/输出两行，图片/视频/语音一行</span>
            </div>
            <div v-for="u in unpricedRows" :key="u.key" class="uprow">
              <span class="mono uk" :title="u.key">{{ u.key }}</span>
              <span class="muted">{{ u.unpriced }} 次 · {{ fmtQty(u.quantity) }}</span>
              <button class="btn sm" style="margin-left: auto" @click="addFromUnpriced(u.key)">补价</button>
            </div>
          </div>
        </div>
      </details>
    </template>

    <ApiConfigForm
      v-if="editing"
      :provider="editing.provider"
      :config="editing.config"
      :credentials="credentials"
      @saved="load()"
      @close="editing = null"
    />

    <VendorCredentialForm
      v-if="showCredForm && editingCred"
      :credential="editingCred"
      @saved="load(); showCredForm = false"
      @close="showCredForm = false"
    />
  </div>
</template>

<style scoped>
/* ---------- 页头内嵌 tabs（与模板页同源：品牌渐变激活态） ---------- */
.tabs {
  margin-left: auto;
  display: inline-flex;
  gap: 3px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 3px;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 500;
  padding: 5px 13px;
  border-radius: 7px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.tab:hover {
  color: var(--text);
  background: var(--hover);
}

.tab.on {
  background: linear-gradient(135deg, rgb(139 92 246 / 26%), rgb(79 70 229 / 22%));
  color: #fff;
}

.cnt {
  font-size: 10.5px;
  min-width: 17px;
  height: 17px;
  line-height: 17px;
  text-align: center;
  border-radius: 999px;
  padding: 0 3px;
  background: rgb(148 163 184 / 14%);
  color: var(--text-3);
}

.tab.on .cnt {
  background: rgb(255 255 255 / 14%);
  color: #fff;
}

/* ---------- 就绪摘要 ---------- */
.ready {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--text-2);
  margin: 14px 0 12px;
}

.r-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--text-3);
  flex: none;
}

.ready.ok .r-dot {
  background: var(--ok);
  box-shadow: 0 0 6px rgb(34 197 94 / 70%);
}

.ready.warn {
  color: var(--warn);
}

.ready.warn .r-dot {
  background: var(--warn);
  box-shadow: 0 0 6px rgb(245 158 11 / 70%);
}

.r-hint {
  margin-left: auto;
  color: var(--text-3);
  font-size: 12px;
}

/* ---------- 主从布局 ---------- */
.split {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  animation: pane-in 0.18s ease-out;
}

@keyframes pane-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.rail {
  width: 258px;
  flex: none;
  padding: 10px;
  max-height: calc(100vh - 190px);
  overflow-y: auto;
}

.rhead {
  padding: 2px 6px 10px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 500;
  border-bottom: 1px solid var(--border);
  margin-bottom: 8px;
}

.item {
  display: block;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text);
  border-radius: 10px;
  padding: 8px 10px;
  margin-bottom: 2px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.item:hover {
  background: var(--hover);
}

.item.active {
  background: rgb(99 102 241 / 14%);
  border-color: rgb(99 102 241 / 32%);
}

.i1 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 7px;
}

.ik {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icount {
  font-size: 10.5px;
  min-width: 17px;
  height: 17px;
  line-height: 17px;
  text-align: center;
  border-radius: 999px;
  padding: 0 3px;
  flex: none;
  background: rgb(148 163 184 / 14%);
  color: var(--text-3);
}

.ist {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 3px;
}

.ist .dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--text-3);
  flex: none;
}

.ist .dot.ok {
  background: var(--ok);
}

.ist .dot.warn {
  background: var(--warn);
}

/* ---------- 供应商详情 ---------- */
.detail {
  flex: 1;
  min-width: 0;
  padding: 14px 16px;
  min-height: 300px;
}

.dhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.dtl {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.pname {
  font-weight: 600;
  font-size: 14.5px;
}

.pk {
  font-size: 11.5px;
  color: var(--text-3);
  cursor: help;
}

.pdesc {
  font-size: 12px;
  margin: 4px 0 10px;
}

.dempty {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 0 6px;
  font-size: 12.5px;
}

.inst {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.iname {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.tag-default {
  background: var(--accent-weak);
  color: var(--accent);
  font-size: 10.5px;
  border-radius: 999px;
  padding: 0 8px;
}

.tmsg {
  font-size: 11.5px;
  color: var(--ok);
  word-break: break-word;
}

.tmsg.bad {
  color: var(--bad);
}

.ops {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* ---------- 「…」溢出菜单 ---------- */
.mwrap {
  position: relative;
}

.mbtn {
  padding: 2px 7px;
}

.menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 40;
  min-width: 132px;
  padding: 4px;
  background: var(--panel-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-lg);
  animation: menu-in 0.12s ease-out;
}

.menu.up {
  top: auto;
  bottom: calc(100% + 4px);
}

.menu:focus {
  outline: none;
}

@keyframes menu-in {
  from {
    opacity: 0;
  }
}

.mi {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: none;
  color: var(--text);
  font-size: 12.5px;
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
}

.mi:hover {
  background: var(--hover);
}

.mi.bad {
  color: var(--bad);
}

.mi.bad:hover {
  background: var(--bad-weak);
}

.msep {
  height: 1px;
  background: var(--border);
  margin: 4px 2px;
}

/* ---------- 用量计费（折叠） ---------- */
.pricing {
  margin-top: 14px;
}

.psum {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-radius: calc(var(--radius) - 1px);
  cursor: pointer;
  user-select: none;
  list-style: none;
}

.psum::-webkit-details-marker {
  display: none;
}

.psum:hover {
  background: var(--hover);
}

.pt {
  font-weight: 600;
  font-size: 14px;
}

.chev {
  margin-left: auto;
  display: inline-flex;
  color: var(--text-3);
  transition: transform 0.16s ease;
}

.pricing[open] .chev {
  transform: rotate(180deg);
}

.pbody {
  padding: 0 16px 14px;
  border-top: 1px solid var(--border);
}

.pbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 0;
}

.pops {
  margin-left: auto;
  display: flex;
  gap: 8px;
  flex: none;
}

.pmsg {
  font-size: 12px;
  color: var(--ok);
  margin-bottom: 8px;
}

.pmsg.bad {
  color: var(--bad);
}

.pbody .tbl td input,
.pbody .tbl td select {
  width: 100%;
}

.unpriced {
  margin-top: 12px;
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}

.uphead {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  margin-bottom: 6px;
}

.uprow {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
  padding: 3px 0;
}

.uk {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .split,
  .menu {
    animation: none;
  }

  .chev {
    transition: none;
  }
}

/* ---------- 供应商凭证卡片 ---------- */
.cred-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}

.cred-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--bg);
}

.cred-card.no-key {
  border-color: var(--warn);
  border-style: dashed;
}

.cc-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cc-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-1);
}

.cc-key {
  font-size: 11.5px;
  color: var(--text-3);
}

.cc-key.warn {
  color: var(--warn);
}

.cc-meta {
  display: flex;
  gap: 10px;
  font-size: 11.5px;
}

.cred-card .btn {
  align-self: flex-start;
  margin-top: 2px;
}
</style>
