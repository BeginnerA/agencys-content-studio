<script setup lang="ts">
/**
 * 创作画布 · 缩放栏 + 操作指南悬浮件（自 board/index.vue 原样搬出，行为零变更）：
 * 不拦截视口手势（pointerdown/dblclick/keydown 全部 stop）；zoomBy/fitView 经函数 props 直传，
 * 状态真源仍在父级 useBoardViewport / useBoardInteractions。
 */
import Icon from '../../common/Icon.vue'

defineProps<{
  zoom: number
  zoomBy: (f: number) => void
  fitView: () => void
}>()
</script>

<template>
  <!-- 缩放控制（右下角；不拦截视口手势） -->
  <div
    class="cb-zoombar"
    role="group"
    aria-label="画布缩放"
    @pointerdown.stop
    @dblclick.stop
    @keydown.stop
  >
    <button
      type="button"
      class="zb"
      title="缩小"
      aria-label="缩小"
      @click="zoomBy(1 / 1.25)"
    >
      <Icon name="zoom-out" :size="13" />
    </button>
    <button
      type="button"
      class="pct"
      title="恢复 100% 缩放"
      aria-label="恢复 100% 缩放"
      @click="zoomBy(1 / zoom)"
    >
      {{ Math.round(zoom * 100) }}%
    </button>
    <button
      type="button"
      class="zb"
      title="放大"
      aria-label="放大"
      @click="zoomBy(1.25)"
    >
      <Icon name="zoom-in" :size="13" />
    </button>
    <button
      type="button"
      class="zb zb-fit"
      title="适应全部节点（F）"
      @click="fitView"
    >
      适应
    </button>
  </div>

  <details
    class="cb-help"
    @pointerdown.stop
    @dblclick.stop
    @keydown.stop
    @keydown.esc.prevent="
      ($event.currentTarget as HTMLDetailsElement).open = false
    "
  >
    <summary>操作指南</summary>
    <div class="help-card panel">
      <strong>画布操作</strong>
      <dl>
        <div>
          <dt>框选节点</dt>
          <dd>空白处左键拖动</dd>
        </div>
        <div>
          <dt>平移画布</dt>
          <dd>空格 + 拖动 / 中键</dd>
        </div>
        <div>
          <dt>缩放 / 适应</dt>
          <dd>滚轮 / F</dd>
        </div>
        <div>
          <dt>新建节点</dt>
          <dd>双击空白处</dd>
        </div>
        <div>
          <dt>多选 / 全选</dt>
          <dd>Shift + 单击 / Ctrl+A</dd>
        </div>
        <div>
          <dt>复制 / 成组</dt>
          <dd>Ctrl+D / Ctrl+G</dd>
        </div>
        <div>
          <dt>撤销 / 重做</dt>
          <dd>Ctrl+Z / Ctrl+Shift+Z</dd>
        </div>
        <div>
          <dt>删除 / 取消选择</dt>
          <dd>Del / Esc</dd>
        </div>
        <div>
          <dt>选中联动</dt>
          <dd>流动紫虚线 = 下一步 · 淡紫 = 上一步</dd>
        </div>
      </dl>
    </div>
  </details>
</template>

<style scoped>
/* ---- 缩放栏 / 提示 ---- */
.cb-zoombar {
  position: absolute;
  right: 14px;
  bottom: 14px;
  display: flex;
  align-items: center;
  gap: 2px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 3px;
  box-shadow: 0 6px 18px rgb(0 0 0 / 30%);
}

.zb {
  display: flex;
  align-items: center;
  border: none;
  background: none;
  color: var(--text-2);
  padding: 6px 8px;
  min-width: 32px;
  min-height: 32px;
  justify-content: center;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
}

.zb:hover {
  background: var(--hover);
  color: #fff;
}

.zb-fit {
  font-size: 11px;
}

.pct {
  min-width: 48px;
  min-height: 32px;
  border: none;
  background: none;
  font: inherit;
  font-size: 11px;
  color: var(--text-2);
  text-align: center;
  cursor: pointer;
  padding: 4px 2px;
  border-radius: 6px;
}

.pct:hover {
  background: var(--hover);
  color: #fff;
}

.cb-help {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 4;
  font-size: 12px;
  color: var(--text-2);
}
.cb-help summary {
  display: flex;
  align-items: center;
  min-height: 40px;
  padding: 6px 12px;
  list-style: none;
  cursor: pointer;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 9px;
}
.cb-help summary::-webkit-details-marker {
  display: none;
}
.cb-help summary:hover,
.cb-help[open] summary {
  color: var(--text);
  border-color: var(--border-strong);
}
.help-card {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  width: 300px;
  max-width: calc(100cqw - 28px);
  padding: 14px;
  color: var(--text);
  box-shadow: var(--shadow-lg);
}
.help-card dl {
  display: grid;
  gap: 10px;
  margin: 12px 0 0;
}
.help-card dl > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.help-card dd {
  margin: 0;
  color: var(--text-2);
  text-align: right;
}
/* 容器查询依赖父级 .cb-viewport 的 container 声明（DOM 上下文，跨组件生效） */
@container canvas-viewport (max-width: 340px) {
  .cb-help {
    bottom: 64px;
  }
  .cb-zoombar {
    right: 8px;
    bottom: 10px;
  }
}
@media (pointer: coarse) {
  .zb,
  .pct,
  .cb-help summary {
    min-height: 44px;
  }
}
</style>
