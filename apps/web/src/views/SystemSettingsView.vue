<script setup lang="ts">
/**
 * [M20] 系统设置页
 * 从 AI 配置（/settings）中独立出来的通用设置入口。
 * 当前包含「品牌」Tab；后续可扩展更多设置类别。
 */
import { ref } from 'vue'
import BrandPreview from '../components/BrandPreview.vue'
import BrandSettings from '../components/BrandSettings.vue'
import Icon from '../components/Icon.vue'
import { settingsApi } from '../lib/api'
import type { BrandConfig } from '../lib/types'

// Tab 定义（后续新增设置类别只需追加到数组）
const TABS = [
  { key: 'brand', label: '品牌', icon: 'brush', hint: '水印 / 片头 / 片尾 / 字幕样式（平台默认；项目与 run 可覆盖）' },
] as const
type TabKey = (typeof TABS)[number]['key']

const activeTab = ref<TabKey>('brand')

// 品牌配置快照（用于预览联动）
const brandSnapshot = ref<BrandConfig>({})
const wmFileSnapshot = ref('')
const introFileSnapshot = ref('')
const outroFileSnapshot = ref('')
const wmPreviewTs = ref(0)

/** 从 API 读取已保存的品牌配置，刷新预览快照 */
async function refreshPreview() {
  try {
    const r = await settingsApi.list()
    const raw = r.items.find((it) => it.key === 'brand')?.value
    const b = (raw && typeof raw === 'object' ? raw : {}) as BrandConfig
    brandSnapshot.value = b
    const wf = b.watermark?.file
    wmFileSnapshot.value = typeof wf === 'string' ? wf : ''
    const inf = b.intro?.file
    introFileSnapshot.value = typeof inf === 'string' ? inf : ''
    const outf = b.outro?.file
    outroFileSnapshot.value = typeof outf === 'string' ? outf : ''
    wmPreviewTs.value = Date.now()
  } catch {
    /* 预览加载失败静默 */
  }
}

/** [M20 fix] 表单实时预览：BrandSettings 表单变化时直接更新预览快照 */
function onPreviewForm(data: { brand: BrandConfig; wmFile: string }) {
  brandSnapshot.value = data.brand
  wmFileSnapshot.value = data.wmFile
  introFileSnapshot.value = (data.brand.intro?.file as string) || ''
  outroFileSnapshot.value = (data.brand.outro?.file as string) || ''
  wmPreviewTs.value = Date.now()
}

// 初始加载
refreshPreview()
</script>

<template>
  <div>
    <div class="page-h">
      <h1>设置</h1>
      <span class="sub">平台级通用配置（品牌、后续更多设置项）</span>
      <div class="tabs" role="tablist" aria-label="设置分类">
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
        </button>
      </div>
    </div>

    <!-- 品牌 Tab -->
    <div v-if="activeTab === 'brand'" class="sys-brand">
      <div class="sys-brand-form">
        <BrandSettings scope="platform" @changed="refreshPreview" @preview="onPreviewForm" />
      </div>
      <aside class="sys-brand-preview">
        <BrandPreview
          :brand="brandSnapshot"
          :wm-file="wmFileSnapshot"
          :wm-preview-ts="wmPreviewTs"
          :intro-file="introFileSnapshot"
          :outro-file="outroFileSnapshot"
        />
      </aside>
    </div>
  </div>
</template>

<style scoped>
.sys-brand {
  display: grid;
  grid-template-columns: 1fr 340px;
  gap: 24px;
  align-items: start;
}

.sys-brand-form {
  min-width: 0;
}

.sys-brand-preview {
  position: sticky;
  top: 16px;
}

@media (max-width: 960px) {
  .sys-brand {
    grid-template-columns: 1fr;
  }
  .sys-brand-preview {
    position: static;
  }
}
</style>
