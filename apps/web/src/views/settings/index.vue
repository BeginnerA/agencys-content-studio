<script setup lang="ts">
import ApiConfigForm from '../../components/config/ApiConfigForm.vue'
import VendorCredentialForm from '../../components/config/VendorCredentialForm.vue'
import Icon from '../../components/common/Icon.vue'
import VoiceLibrary from '../../components/config/VoiceLibrary.vue'
import CredsPanel from './CredsPanel.vue'
import ProviderRail from './ProviderRail.vue'
import ProviderDetail from './ProviderDetail.vue'
import PricingPanel from './PricingPanel.vue'
import { useSettingsPage } from './use-settings'

const s = useSettingsPage()
const {
  TABS,
  activeTab,
  credentials,
  err,
  loading,
  editing,
  editingCred,
  showCredForm,
  tabOf,
  cntOf,
  readiness,
  load,
} = s

// 多语句 handler 抽为单函数：prettier 在 semi:false 下会删模板属性里的分隔分号，产生非法 JS
async function onCredSaved() {
  await load()
  showCredForm.value = false
}
</script>

<template>
  <div class="ai-config">
    <div class="ai-bar">
      <span class="ai-hint">密钥仅存本地 data/secrets.json（不入库）</span>
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
          <span v-if="t.types.length" class="cnt">{{ cntOf(t.key) }}</span>
        </button>
      </div>
    </div>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="loading" class="empty">加载中…</div>

    <template v-else>
      <!-- 音色库 tab：声音克隆（列表/试听/删除 + 新建复刻） -->
      <VoiceLibrary v-if="activeTab === 'voices'" />

      <template v-else>
        <!-- 就绪摘要（当前能力） -->
        <div class="ready" :class="readiness.tone">
          <span class="r-dot" />
          <span>{{ readiness.text }}</span>
          <span class="r-hint">{{ tabOf(activeTab).hint }}</span>
        </div>

        <CredsPanel :s="s" />

        <!-- 主从布局：左供应商列表 / 右供应商详情 -->
        <div :key="activeTab" class="split">
          <ProviderRail :s="s" />

          <ProviderDetail :s="s" />
        </div>

        <PricingPanel :s="s" />
      </template>
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
      @saved="onCredSaved()"
      @close="showCredForm = false"
    />
  </div>
</template>

<style scoped>
/* ---------- 嵌入「设置」页的能力子 Tab 栏（不再自带页头 h1） ---------- */
.ai-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 0 14px;
}

.ai-hint {
  color: var(--text-3);
  font-size: 12px;
}

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
  transition:
    background 0.15s,
    color 0.15s;
}

.tab:hover {
  color: var(--text);
  background: var(--hover);
}

.tab.on {
  background: linear-gradient(
    135deg,
    rgb(139 92 246 / 26%),
    rgb(79 70 229 / 22%)
  );
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
@media (prefers-reduced-motion: reduce) {
  .split,
  .menu {
    animation: none;
  }

  .chev {
    transition: none;
  }
}
</style>
