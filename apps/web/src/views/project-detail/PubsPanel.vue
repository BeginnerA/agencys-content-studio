<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import { fmtTime, PLATFORM_TEXT } from '../../lib/format'
import type { ProjectDetailApi } from './use-project-detail'
const props = defineProps<{ s: ProjectDetailApi }>()
const { activeTab, pubs, pubSummary, pubLoading, pubErr, assetNameOf, openPublish, removePub } = props.s
</script>

<template>
      <section v-show="activeTab === 'pubs'" role="tabpanel" aria-labelledby="ptab-pubs">
        <div class="panel block">
          <div class="bh">
            <span class="bt">发布记录</span>
            <span class="muted">已发布 {{ pubs.length }} 条 · 播放 {{ pubSummary.views }} · 互动 {{ pubSummary.interactions }}</span>
            <div class="bh-ops">
              <button class="btn sm" @click="openPublish(null)">
                <Icon name="plus" :size="12" :stroke-width="2.2" /> 标记发布
              </button>
            </div>
          </div>
          <div v-if="pubErr" class="err-text">{{ pubErr }}</div>
          <div v-if="pubLoading && !pubs.length" class="empty" style="padding: 16px 0">加载中…</div>
          <table v-else-if="pubs.length" class="tbl">
            <thead>
              <tr>
                <th>平台</th>
                <th>资产</th>
                <th>日期</th>
                <th>播放 / 点赞 / 评论 / 收藏 / 转发</th>
                <th>链接</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="pub in pubs" :key="pub.id">
                <td><span class="badge">{{ PLATFORM_TEXT[pub.platform] ?? pub.platform }}</span></td>
                <td class="muted">{{ assetNameOf(pub.assetId) }}</td>
                <td class="muted">{{ pub.publishedAt ? fmtTime(pub.publishedAt) : '—' }}</td>
                <td class="mono" style="font-size: 12px">
                  {{ pub.metrics?.views ?? 0 }} / {{ pub.metrics?.likes ?? 0 }} / {{ pub.metrics?.comments ?? 0 }} /
                  {{ pub.metrics?.favorites ?? 0 }} / {{ pub.metrics?.shares ?? 0 }}
                </td>
                <td>
                  <a v-if="pub.url" :href="pub.url" target="_blank" rel="noopener"><Icon name="external" :size="12" /> 打开</a>
                  <span v-else class="muted">—</span>
                </td>
                <td>
                  <div class="ops">
                    <button class="btn sm" @click="openPublish(pub)">编辑</button>
                    <button class="btn sm danger" @click="removePub(pub)">删除</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty" style="padding: 16px 0">还没有发布记录——发布后回来登记，积累复盘数据</div>
        </div>
      </section>
</template>

<style scoped>
/* ---------- 区块 ---------- */
.block {
  padding: 12px 16px 16px;
  margin-bottom: 18px;
}
.bh {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.bt {
  font-weight: 600;
  font-size: 14px;
}
.ops {
  display: flex;
  gap: 6px;
}
.bh-ops {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
</style>
