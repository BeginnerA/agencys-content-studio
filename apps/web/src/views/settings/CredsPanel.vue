<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import type { SettingsApi } from './use-settings'
const props = defineProps<{ s: SettingsApi }>()
const { credentials, editingCred, showCredForm, openNewCred, removeCred } =
  props.s

// 多语句 handler 抽为单函数：prettier 在 semi:false 下会删模板属性里的分隔分号，产生非法 JS
function editCred(cr: (typeof credentials.value)[number]) {
  editingCred.value = cr
  showCredForm.value = true
}
</script>

<template>
  <!-- 密钥保管（厂商/网关）：API Key 统一增删改，实例共享；密钥仅存本地 secrets.json -->
  <section class="creds-page">
    <div class="creds-head">
      <div class="ch-left">
        <h2 class="ch-title"><Icon name="key" :size="15" /> 密钥保管（厂商/网关）</h2>
        <p class="ch-sub">
          每个厂商或网关只需配置一次 API Key，所有模型实例共享；可自由添加自建网关条目。
        </p>
      </div>
      <button class="btn primary sm" @click="openNewCred()">
        <Icon name="plus" :size="13" /> 添加密钥
      </button>
    </div>

    <div v-if="!credentials.length" class="empty">
      暂无保管条目——点击右上角「添加密钥」新建厂商/网关的 API Key
    </div>

    <div v-else class="cred-grid">
      <div
        v-for="cr in credentials"
        :key="cr.id"
        class="cred-card"
        :class="{ 'no-key': !cr.hasKey }"
      >
        <div class="cc-head">
          <span class="cc-name">{{ cr.name }}</span>
          <span class="cc-tag" :class="cr.source">{{
            cr.source === 'seed' ? '内置' : '自建'
          }}</span>
        </div>
        <div class="cc-keyrow">
          <span v-if="cr.hasKey" class="cc-key mono">{{ cr.apiKeyMasked }}</span>
          <span v-else class="cc-key warn">未配置 Key</span>
        </div>
        <div class="cc-meta">
          <span class="muted">{{ cr.configCount }} 个实例</span>
          <span v-if="cr.vendor" class="muted mono">{{ cr.vendor }}</span>
        </div>
        <div class="cc-acts">
          <button class="btn sm" @click="editCred(cr)">
            {{ cr.hasKey ? '修改' : '配置 Key' }}
          </button>
          <button
            class="btn sm danger"
            :disabled="cr.configCount > 0"
            :title="
              cr.configCount > 0
                ? '仍有 ' + cr.configCount + ' 个实例引用，先解除绑定才能删除'
                : '删除该条目（连同本地密钥）'
            "
            @click="removeCred(cr)"
          >
            <Icon name="trash" :size="12" /> 删除
          </button>
        </div>
      </div>
    </div>

    <p class="creds-note muted">
      删除内置条目后不会在重启时重新出现；之后重新「添加密钥」填相同厂商标识即可恢复并再次填入 Key。自建条目删除后彻底移除。
    </p>
  </section>
</template>

<style scoped>
/* ---------- 页头 ---------- */
.creds-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  margin: 14px 0 12px;
}

.ch-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 3px;
}

.ch-sub {
  font-size: 12px;
  color: var(--text-3);
  margin: 0;
}

/* ---------- 密钥保管卡片 ---------- */
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

.cc-tag {
  font-size: 10.5px;
  padding: 1px 7px;
  border-radius: 999px;
  background: rgb(148 163 184 / 14%);
  color: var(--text-3);
  flex: none;
}

.cc-tag.user {
  background: rgb(139 92 246 / 18%);
  color: #a78bfa;
}

.cc-keyrow {
  min-height: 16px;
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

.cc-acts {
  display: flex;
  gap: 8px;
  margin-top: 2px;
}

.cred-card .btn {
  align-self: flex-start;
}

.cred-card .btn.danger:not(:disabled) {
  color: var(--danger, #f87171);
}

.creds-note {
  font-size: 11.5px;
  margin: 12px 0 0;
}
</style>
