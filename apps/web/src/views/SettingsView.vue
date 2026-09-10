<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ApiConfigForm from '../components/ApiConfigForm.vue'
import Icon from '../components/Icon.vue'
import { configApi, settingsApi, statsApi } from '../lib/api'
import type { ApiConfig, ApiProvider, UsageItem } from '../lib/types'
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
const err = ref('')
const loading = ref(true)

// 编辑/新建弹窗状态：provider + 待编辑 config
const editing = ref<{ provider: ApiProvider; config: ApiConfig | null } | null>(null)
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

async function load() {
  loading.value = true
  err.value = ''
  try {
    const [p, c] = await Promise.all([configApi.providers(), configApi.list()])
    providers.value = p.items
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

async function remove(cfg: ApiConfig & { name: string }) {
  if (!confirm(`删除实例「${cfg.name}」？`)) return
  try {
    await configApi.remove(cfg.id)
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

async function test(cfg: ApiConfig & { name: string }) {
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

// ===== [M4] 用量单价（settings.pricing 表格编辑器 + 未计价引导） =====
interface PriceRow {
  kind: string
  key: string
  unit: string
  price: string
}

const PRICE_KINDS = ['llm', 'image', 'video', 'tts'] as const
const PRICE_UNITS = ['tokens_in', 'tokens_out', 'image', 'second', 'char'] as const
const PRICE_UNIT_TEXT: Record<string, string> = {
  tokens_in: 'tokens_in（输入 · 元/百万）',
  tokens_out: 'tokens_out（输出 · 元/百万）',
  image: 'image（元/张）',
  second: 'second（元/秒）',
  char: 'char（元/千字符）',
}

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

/** 「补价」预填两行（LLM 输入/输出；媒体类请改「类型/单位」） */
function addFromUnpriced(key: string) {
  priceRows.value.push({ kind: 'llm', key, unit: 'tokens_in', price: '' })
  priceRows.value.push({ kind: 'llm', key, unit: 'tokens_out', price: '' })
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
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="loading" class="empty">加载中…</div>

    <template v-else>
      <div class="tabs" role="tablist" aria-label="按能力分类">
        <button
          v-for="t in TABS"
          :key="t.key"
          role="tab"
          :aria-selected="activeTab === t.key"
          :class="{ on: activeTab === t.key }"
          @click="activeTab = t.key"
        >
          <Icon :name="t.icon" :size="14" :stroke-width="1.8" />
          {{ t.label }}
          <span class="cnt">{{ cntOf(t.key) }}</span>
        </button>
      </div>
      <div class="tab-hint">
        <span class="hint-dot" />{{ tabOf(activeTab).hint }} · 共 {{ cntOf(activeTab) }} 家供应商
      </div>

      <div class="tabpane" :key="activeTab">
        <template v-for="p in visible" :key="p.key">
          <div class="panel prov">
            <div class="phead">
              <div>
                <span class="pname">{{ p.name }}</span>
                <span class="muted mono pk">{{ p.key }}</span>
              </div>
              <button class="btn sm primary" @click="editing = { provider: p, config: null }">
                <Icon name="plus" :size="13" :stroke-width="2.2" /> 新建实例
              </button>
            </div>
            <div class="pdesc muted">{{ p.description }}</div>

            <div v-if="!p.configs.length" class="empty" style="padding: 14px 0; font-size: 12px">
              未配置实例——流水线将无法调用该类型供应商
            </div>
            <table v-else class="tbl">
              <thead>
                <tr>
                  <th>实例</th>
                  <th>模型</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="cfg in p.configs" :key="cfg.id">
                  <td>
                    {{ cfg.name }}
                    <span v-if="cfg.isDefault" class="tag-default">默认</span>
                  </td>
                  <td class="mono" style="font-size: 12px">{{ cfg.model || '—' }}</td>
                  <td>
                    <span class="badge" :class="cfg.isActive ? 'succeeded' : 'cancelled'">
                      {{ cfg.isActive ? '启用' : '停用' }}
                    </span>
                    <span v-if="msgOf(cfg.id)" class="tmsg" :class="{ bad: msgOf(cfg.id).startsWith('✗') }">
                      {{ msgOf(cfg.id) }}
                    </span>
                  </td>
                  <td>
                    <div class="ops">
                      <button class="btn sm" :disabled="testBusy === cfg.id" @click="test(cfg as ApiConfig & { name: string })">
                        {{ testBusy === cfg.id ? '测试中…' : '测试' }}
                      </button>
                      <button v-if="!cfg.isDefault" class="btn sm" @click="setDefault(cfg.id, p.key)">设为默认</button>
                      <button class="btn sm" @click="toggleActive(cfg.id, p.key, cfg.isActive)">
                        {{ cfg.isActive ? '停用' : '启用' }}
                      </button>
                      <button class="btn sm" @click="editing = { provider: p, config: cfg as ApiConfig }">编辑</button>
                      <button class="btn sm danger" @click="remove(cfg as ApiConfig & { name: string })">删除</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>

      <!-- [M4] 用量单价（成本核算 settings.pricing） -->
      <div class="panel pricing">
        <div class="ph">
          <span class="pt">用量单价</span>
          <span class="muted">记录时快照计价——改价只影响之后的用量，不改历史账</span>
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
              <th style="width: 90px">类型</th>
              <th>供应商 / 模型（key）</th>
              <th style="width: 220px">单位</th>
              <th style="width: 120px">单价</th>
              <th style="width: 64px"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in priceRows" :key="i">
              <td>
                <select v-model="r.kind">
                  <option v-for="k in PRICE_KINDS" :key="k" :value="k">{{ k }}</option>
                </select>
              </td>
              <td>
                <input v-model="r.key" type="text" class="mono" placeholder="如 deepseek-chat、volcengine_image:*" />
              </td>
              <td>
                <select v-model="r.unit">
                  <option v-for="u in PRICE_UNITS" :key="u" :value="u">{{ PRICE_UNIT_TEXT[u] }}</option>
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
            <span class="muted">「补价」按 LLM（输入/输出）预填两行，请按实际计费核对类型与单位</span>
          </div>
          <div v-for="u in unpricedRows" :key="u.key" class="uprow">
            <span class="mono uk" :title="u.key">{{ u.key }}</span>
            <span class="muted">{{ u.unpriced }} 次 · {{ fmtQty(u.quantity) }}</span>
            <button class="btn sm" style="margin-left: auto" @click="addFromUnpriced(u.key)">补价</button>
          </div>
        </div>
      </div>
    </template>

    <ApiConfigForm
      v-if="editing"
      :provider="editing.provider"
      :config="editing.config"
      @saved="load()"
      @close="editing = null"
    />
  </div>
</template>

<style scoped>
.tabs {
  display: inline-flex;
  gap: 4px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 11px;
  padding: 4px;
  margin-top: 16px;
}

.tabs button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  padding: 6px 14px;
  border-radius: 8px;
  border: none;
  background: none;
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.15s;
}

.tabs button:hover {
  color: var(--text);
  background: var(--hover);
}

.tabs button.on {
  background: var(--accent-weak);
  color: #a5b4fc;
  box-shadow: inset 0 0 0 1px rgb(99 102 241 / 45%);
}

.cnt {
  font-size: 10.5px;
  min-width: 17px;
  height: 17px;
  line-height: 17px;
  text-align: center;
  border-radius: 999px;
  background: rgb(148 163 184 / 14%);
  color: var(--text-3);
}

.tabs button.on .cnt {
  background: rgb(99 102 241 / 22%);
  color: #a5b4fc;
}

.tab-hint {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-3);
  margin: 10px 0 14px;
}

.hint-dot {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: var(--accent);
  box-shadow: 0 0 6px rgb(99 102 241 / 70%);
}

.tabpane {
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

.prov {
  padding: 14px 16px;
  margin-bottom: 12px;
}

.phead {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.pname {
  font-weight: 600;
  font-size: 14.5px;
}

.pk {
  margin-left: 8px;
  font-size: 11.5px;
}

.pdesc {
  font-size: 12px;
  margin: 4px 0 8px;
}

.tag-default {
  background: var(--accent-weak);
  color: var(--accent);
  font-size: 10.5px;
  border-radius: 999px;
  padding: 0 8px;
  margin-left: 6px;
}

.tmsg {
  font-size: 12px;
  color: var(--ok);
  margin-left: 10px;
}

.tmsg.bad {
  color: var(--bad);
}

.ops {
  display: flex;
  gap: 6px;
}

/* [M4] 用量单价 */
.pricing {
  padding: 14px 16px;
  margin-top: 4px;
}

.ph {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.pt {
  font-weight: 600;
  font-size: 14.5px;
}

.pops {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.pmsg {
  font-size: 12px;
  color: var(--ok);
  margin-bottom: 8px;
}

.pmsg.bad {
  color: var(--bad);
}

.pricing .tbl td input,
.pricing .tbl td select {
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
</style>
