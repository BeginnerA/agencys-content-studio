<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import { getSocket } from './lib/socket'
import Icon from './components/Icon.vue'

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
        <span class="mark"><Icon name="bolt" :size="16" :stroke-width="2" /></span>
        <span class="lt">
          百工工作室
          <small>模板化流水线工作台</small>
        </span>
      </div>
      <nav class="navs">
        <RouterLink class="nav" to="/"><Icon name="folder" :size="16" /> 项目</RouterLink>
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
