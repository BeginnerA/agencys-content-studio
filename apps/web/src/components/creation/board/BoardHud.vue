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
    <summary>
      <Icon name="help" :size="13" />
      <span>操作指南</span>
    </summary>
    <div class="help-card">
      <div class="help-head">
        <strong>画布操作</strong>
        <span>鼠标 + 快捷键速查</span>
      </div>

      <section class="help-group">
        <h4>视图</h4>
        <dl>
          <div class="help-row">
            <dt>框选节点</dt>
            <dd><kbd>空白处</kbd><span>左键拖动</span></dd>
          </div>
          <div class="help-row">
            <dt>平移画布</dt>
            <dd>
              <kbd>空格</kbd><span>+</span><kbd>拖动</kbd><span>/ 中键</span>
            </dd>
          </div>
          <div class="help-row">
            <dt>缩放 / 适应</dt>
            <dd><span>滚轮 /</span><kbd>F</kbd></dd>
          </div>
        </dl>
      </section>

      <section class="help-group">
        <h4>节点</h4>
        <dl>
          <div class="help-row help-row-wide">
            <dt>新建节点</dt>
            <dd>
              工具栏「添加节点」选类型（文本 / 图片 / 视频 / 音频 / LLM /
              合成）；<kbd>双击空白</kbd>= 快速建图片节点
            </dd>
          </div>
          <div class="help-row">
            <dt>复制 / 成组</dt>
            <dd><kbd>Ctrl+D</kbd><span>/</span><kbd>Ctrl+G</kbd></dd>
          </div>
          <div class="help-row">
            <dt>撤销 / 重做</dt>
            <dd><kbd>Ctrl+Z</kbd><span>/</span><kbd>Ctrl+Shift+Z</kbd></dd>
          </div>
        </dl>
      </section>

      <section class="help-group">
        <h4>选择与联动</h4>
        <dl>
          <div class="help-row">
            <dt>多选 / 全选</dt>
            <dd><kbd>Shift+单击</kbd><span>/</span><kbd>Ctrl+A</kbd></dd>
          </div>
          <div class="help-row">
            <dt>删除 / 取消</dt>
            <dd><kbd>Del</kbd><span>/</span><kbd>Esc</kbd></dd>
          </div>
          <div class="help-row help-row-wide">
            <dt>选中联动</dt>
            <dd>
              <span class="link-dot link-next"></span>流动紫虚线 = 下一步
              <span class="link-dot link-prev"></span>淡紫 = 上一步
            </dd>
          </div>
        </dl>
      </section>
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
  gap: 6px;
  min-height: 40px;
  padding: 6px 12px;
  list-style: none;
  cursor: pointer;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 9px;
  transition:
    color 0.15s ease,
    border-color 0.15s ease;
}
.cb-help summary .ic {
  color: var(--accent-h);
  opacity: 0.85;
}
.cb-help summary::-webkit-details-marker {
  display: none;
}
.cb-help summary:hover,
.cb-help[open] summary {
  color: var(--text);
  border-color: var(--border-strong);
}
.cb-help[open] summary .ic {
  opacity: 1;
}
.help-card {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  width: 340px;
  max-width: calc(100cqw - 28px);
  max-height: calc(100cqh - 64px);
  padding: 0;
  overflow-y: auto;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
}
.help-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 14px;
  background: var(--grad-brand);
}
.help-head strong {
  font-size: 13px;
  letter-spacing: 0.02em;
  color: #fff;
}
.help-head span {
  font-size: 11px;
  color: rgb(255 255 255 / 78%);
}
.help-group {
  padding: 10px 14px;
}
.help-group + .help-group {
  border-top: 1px solid var(--border);
}
.help-group h4 {
  margin: 0 0 8px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-3);
}
.help-group dl {
  display: grid;
  gap: 7px;
  margin: 0;
}
.help-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.help-row dt {
  flex-shrink: 0;
  color: var(--text);
}
.help-row dd {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  margin: 0;
  color: var(--text-2);
  text-align: right;
}
.help-row-wide {
  flex-direction: column;
  gap: 3px;
  align-items: flex-start;
}
.help-row-wide dd {
  gap: 4px;
  text-align: left;
}
.help-row kbd {
  padding: 1px 6px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text);
  background: var(--code-bg);
  border: 1px solid var(--border-strong);
  border-bottom-width: 2px;
  border-radius: 5px;
}
.link-dot {
  display: inline-block;
  width: 14px;
  height: 0;
  margin: 0 2px;
  vertical-align: middle;
  border-top: 2px dashed var(--accent-h);
}
.link-prev {
  border-top-color: rgb(139 92 246 / 45%);
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
