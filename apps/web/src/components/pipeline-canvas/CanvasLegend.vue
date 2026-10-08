<script setup lang="ts">
/**
 * 画布图例（左下角；不拦截拖拽）
 * 自 CanvasBoard.vue 拆出（m26 split-audit 红线恢复，纯静态块原样迁移，行为零变更）。
 */
</script>

<template>
  <div class="cv-legend" aria-hidden="true">
    <span class="lg">
      <svg width="26" height="8" viewBox="0 0 26 8">
        <path d="M1 4h24" stroke="rgb(148 163 184 / 55%)" stroke-width="2" />
      </svg>
      调度依赖
    </span>
    <span class="lg">
      <svg width="26" height="8" viewBox="0 0 26 8">
        <path
          d="M1 4h24"
          stroke="var(--ok)"
          stroke-width="2"
          stroke-dasharray="5 4"
        />
      </svg>
      数据引用
    </span>
  </div>
</template>

<style scoped>
.cv-legend {
  position: absolute;
  left: 14px;
  bottom: 14px;
  display: flex;
  gap: 14px;
  font-size: 11px;
  color: var(--text-3);
  background: rgb(15 23 42 / 84%);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 5px 11px;
  pointer-events: none;
}

.lg {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
