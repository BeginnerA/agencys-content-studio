<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import type { SettingsApi } from './use-settings'
const props = defineProps<{ s: SettingsApi }>()
const { credentials, editingCred, showCredForm } = props.s
</script>

<template>
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
</template>

<style scoped>
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
