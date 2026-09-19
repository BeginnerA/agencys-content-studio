<script setup lang="ts">
import type { CanvasDocNode } from '../../../lib/types'
import { KIND_TEXT } from '../../../lib/format'
import VersionHistoryPanel from '../../version/VersionHistoryPanel.vue'
import { assetThumb, entKindText } from './internals'

const props = defineProps<{
  node: CanvasDocNode
  openPreview: (assetId: number | null) => Promise<void>
}>()
</script>

<template>
  <!-- ===== [M17] entity 节点：实体直通 ===== -->
  <template v-if="node.kind === 'entity'">
    <section class="sec">
      <div class="sec-h">实体</div>
      <template v-if="node.entity">
        <button
          v-if="node.entity.asset"
          type="button"
          class="resbox"
          title="点击预览参考图"
          @click="openPreview(node.entity.asset.id)"
        >
          <img
            v-if="assetThumb(node.entity.asset)"
            :src="assetThumb(node.entity.asset)!"
            alt=""
          />
          <span v-else class="muted">{{
            KIND_TEXT[node.entity.asset.kind] ?? node.entity.asset.kind
          }}</span>
        </button>
        <div class="kvs">
          <div class="kv">
            <span class="k">名称</span
            ><span class="v">{{ node.entity.name }}</span>
          </div>
          <div class="kv">
            <span class="k">类型</span
            ><span class="v">{{ entKindText(node.entity.kind) }}</span>
          </div>
          <div class="kv">
            <span class="k">参考图</span
            ><span class="v mono">{{ node.entity.refCount }} 张</span>
          </div>
        </div>
        <div class="muted mini">
          下游节点执行时按实体参考图注入（受实体截断策略约束）。
        </div>
        <!-- [M29·R02] 实体档案「历史 · 影响」（版本快照可还原；影响仅报告不生成） -->
        <details class="verbox">
          <summary>历史 · 影响</summary>
          <VersionHistoryPanel kind="entity" :obj-id="node.entity.id" />
        </details>
      </template>
      <div v-else class="err-text">实体数据缺失（可能已被删除）</div>
    </section>
  </template>
</template>

<style scoped>
.sec {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--border);
  padding-top: 10px;
}

.sec-h {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
  letter-spacing: 0.4px;
}

.mini {
  font-size: 11px;
}

.resbox {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--code-bg);
  overflow: hidden;
  cursor: pointer;
  padding: 0;
  min-height: 84px;
}

.resbox:hover {
  border-color: var(--accent);
}

.resbox img {
  display: block;
  width: 100%;
  max-height: 190px;
  object-fit: contain;
}

.kvs {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.kv {
  display: flex;
  gap: 8px;
  font-size: 12px;
}

.kv .k {
  flex: none;
  width: 48px;
  color: var(--text-3);
}

.kv .v {
  min-width: 0;
  color: var(--text-2);
  word-break: break-all;
}

/* [M29·R02] 实体版本面板（折叠，避免撑高默认视图） */
.verbox {
  border-top: 1px solid var(--border);
  padding-top: 8px;
}

.verbox > summary {
  cursor: pointer;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
  list-style: none;
}

.verbox > summary::-webkit-details-marker {
  display: none;
}

.verbox > summary::before {
  content: '▸ ';
  color: var(--text-3);
}

.verbox[open] > summary::before {
  content: '▾ ';
}

.verbox[open] > summary {
  margin-bottom: 8px;
}
</style>
