<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'
import { getSocket } from './lib/socket'
import Icon from './components/Icon.vue'
import { pending, refreshPending, startPendingWatcher } from './lib/pending'

const route = useRoute()
let stopPendingWatcher: (() => void) | null = null

onMounted(() => {
  // 全局单连接：先连接便于页面级 join room（重复 connect 由 io 单例避免）
  const s = getSocket()
  if (!s.connected) s.connect()
  // 全局待审阅角标：首拉 + 30s 轮询 + 可见性恢复
  stopPendingWatcher = startPendingWatcher()
})

// 路由切换时刷新待审阅角标（导航后数据可能已过期；并发合并避免重复请求）
watch(
  () => route.fullPath,
  () => void refreshPending(),
)

onBeforeUnmount(() => {
  // 不主动断开：单页内多个视图共享连接
  stopPendingWatcher?.()
})
</script>

<template>
  <div class="layout">
    <aside class="side">
      <div class="logo">
        <span class="mark" aria-label="百工工作室">
          <!-- 品牌 mark「榫卯拼块」：紫→靛台面 + 深色卯槽 + 悬停翠绿公件 -->
          <svg viewBox="0 0 84 84" aria-hidden="true">
            <defs>
              <linearGradient id="mkbg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="#8b5cf6" />
                <stop offset=".62" stop-color="#6366f1" />
                <stop offset="1" stop-color="#4f46e5" />
              </linearGradient>
              <linearGradient id="mkg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#4ade80" />
                <stop offset="1" stop-color="#22c55e" />
              </linearGradient>
            </defs>
            <rect width="84" height="84" rx="19" fill="url(#mkbg)" />
            <rect x="22" y="33" width="13" height="24" rx="3.5" fill="#0d1730" />
            <rect x="22" y="33" width="6.5" height="24" rx="3" fill="#16224a" />
            <rect x="41.5" y="28.5" width="25" height="33" rx="8.5" fill="url(#mkg)" />
            <rect x="34.5" y="38" width="7" height="14" rx="2.4" fill="url(#mkg)" />
          </svg>
        </span>
        <span class="lt">
          百工工作室
          <small>模板化流水线工作台</small>
        </span>
      </div>
      <nav class="navs">
        <RouterLink class="nav" to="/">
          <Icon name="folder" :size="16" /> 项目
          <span
            v-if="pending.total > 0"
            class="nbadge"
            :title="`${pending.total} 项待审阅`"
            :aria-label="`${pending.total} 项待审阅`"
          >{{ pending.total }}</span>
        </RouterLink>
        <RouterLink class="nav" to="/templates"><Icon name="doc" :size="16" /> 模板</RouterLink>
        <RouterLink class="nav" to="/memories"><Icon name="sparkles" :size="16" /> 记忆</RouterLink>
        <RouterLink class="nav" to="/characters"><Icon name="users" :size="16" /> 角色</RouterLink>
        <RouterLink class="nav" to="/stats"><Icon name="chart" :size="16" /> 统计</RouterLink>
        <RouterLink class="nav" to="/settings"><Icon name="sliders" :size="16" /> AI 配置</RouterLink>
      </nav>
      <div class="foot">
        agencys · 本地单机<br />
        模板 · 资产 · 闸门
      </div>
    </aside>
    <main class="main">
      <RouterView />
    </main>
  </div>
</template>
