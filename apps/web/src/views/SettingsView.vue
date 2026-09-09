<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ApiConfigForm from '../components/ApiConfigForm.vue'
import { configApi } from '../lib/api'
import type { ApiConfig, ApiProvider } from '../lib/types'

const providers = ref<ApiProvider[]>([])
const err = ref('')
const loading = ref(true)

// 编辑/新建弹窗状态：provider + 待编辑 config
const editing = ref<{ provider: ApiProvider; config: ApiConfig | null } | null>(null)
// 测试结果
const testBusy = ref<number | null>(null)
const testMsg = ref<Record<number, string>>({})

const groups = computed(() => {
  const map: Record<string, ApiProvider[]> = {}
  for (const p of providers.value) {
    const key = p.serviceType
    ;(map[key] ??= []).push(p)
  }
  return map
})

const GROUP_TEXT: Record<string, string> = {
  llm: '文本 / LLM',
  image: '图像生成',
  video: '视频生成（M2 启用）',
  audio: '音频（M2 启用）',
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

    <template v-for="(list, st) in groups" :key="st">
      <div class="gname">{{ GROUP_TEXT[st] ?? st }}</div>
      <div v-for="p in list" :key="p.key" class="panel prov">
        <div class="phead">
          <div>
            <span class="pname">{{ p.name }}</span>
            <span class="muted mono pk">{{ p.key }}</span>
          </div>
          <button class="btn sm primary" @click="editing = { provider: p, config: null }">＋ 新建实例</button>
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
.gname {
  font-weight: 600;
  color: var(--text-2);
  margin: 20px 0 8px;
  font-size: 13px;
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
