<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ApiConfigForm from '../components/ApiConfigForm.vue'
import Icon from '../components/Icon.vue'
import { configApi } from '../lib/api'
import type { ApiConfig, ApiProvider } from '../lib/types'

// 配置按能力分类成 tab：图片 / 视频 / 文本（serviceType → tab 映射）
const TABS = [
  { key: 'image', label: '图片生成', icon: 'photo', types: ['image'], hint: '分镜 / 角色 / 封面出图' },
  { key: 'video', label: '视频生成', icon: 'film', types: ['video', 'audio'], hint: '图生视频与配音（M2 启用）' },
  { key: 'text', label: '文本生成', icon: 'pencil', types: ['llm'], hint: '剧本 / 文案 / 结构化输出（LLM）' },
] as const
type TabKey = (typeof TABS)[number]['key']

const activeTab = ref<TabKey>('image')

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
onMounted(() => void load())

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
  color: #c4b5fd;
  box-shadow: inset 0 0 0 1px rgb(139 92 246 / 45%);
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
  background: rgb(139 92 246 / 22%);
  color: #c4b5fd;
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
  box-shadow: 0 0 6px rgb(124 58 237 / 70%);
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
</style>
