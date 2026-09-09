<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import { getSocket } from './lib/socket'

onMounted(() => {
  // 全局单连接：先连接便于页面级 join room（重复 connect 由 io 单例避免）
  const s = getSocket()
  if (!s.connected) s.connect()
})

onBeforeUnmount(() => {
  // 不主动断开：单页内多个视图共享连接
})
</script>

<template>
  <div class="layout">
    <aside class="side">
      <div class="logo">
        Content Studio
        <small>模板化流水线工作台</small>
      </div>
      <RouterLink class="nav" to="/">📁 项目</RouterLink>
      <RouterLink class="nav" to="/settings">⚙️ AI 配置</RouterLink>
    </aside>
    <main class="main">
      <RouterView />
    </main>
  </div>
</template>
