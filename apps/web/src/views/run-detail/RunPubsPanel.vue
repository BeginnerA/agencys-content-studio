<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import { fmtTime, PLATFORM_TEXT } from '../../lib/format'
import type { ExtrasApi } from './use-run-extras'
const props = defineProps<{ e: ExtrasApi }>()
const { showPublish, publications, assetNameOf, removePub } = props.e
</script>

<template>
  <!-- [M4] 发布记录（本 run 登记） -->
  <div class="panel mini">
    <div class="lhead">
      <span class="lt">发布记录</span>
      <button class="btn sm" @click="showPublish = true">
        <Icon name="plus" :size="12" :stroke-width="2.2" /> 标记发布
      </button>
    </div>
    <div v-if="publications.length" class="mrows">
      <div v-for="pub in publications" :key="pub.id" class="mrow">
        <span class="badge">{{
          PLATFORM_TEXT[pub.platform] ?? pub.platform
        }}</span>
        <span class="muted">{{ assetNameOf(pub.assetId) }}</span>
        <span class="muted">{{
          pub.publishedAt ? fmtTime(pub.publishedAt) : '—'
        }}</span>
        <span class="muted mono">播放 {{ pub.metrics?.views ?? 0 }}</span>
        <span class="grow" />
        <a
          v-if="pub.url"
          :href="pub.url"
          target="_blank"
          rel="noopener"
          title="打开链接"
        >
          <Icon name="external" :size="12" />
        </a>
        <button class="btn sm danger" @click="removePub(pub)">删除</button>
      </div>
    </div>
    <div v-else class="empty" style="padding: 10px 0">
      未登记发布——发布后回来标记，积累复盘数据
    </div>
  </div>
</template>

<style scoped>
/* [M4] 右栏辅助面板（成本 / 导出包 / 发布记录） */
.mini {
  padding: 10px 14px;
}

.mrows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
  max-height: 220px;
  overflow-y: auto;
}

.mrow {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.grow {
  flex: 1;
}

.lhead {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.lt {
  font-weight: 600;
  font-size: 13px;
}
</style>
