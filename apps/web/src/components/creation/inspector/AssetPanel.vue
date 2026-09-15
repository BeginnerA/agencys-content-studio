<script setup lang="ts">
import type { CanvasDocNode } from '../../../lib/types'
import { KIND_TEXT, purposeText } from '../../../lib/format'
import { assetThumb } from './internals'

const props = defineProps<{
  node: CanvasDocNode
  openPreview: (assetId: number | null) => Promise<void>
}>()
</script>

<template>
      <!-- ===== asset 节点：素材信息 ===== -->
      <template v-if="node.kind === 'asset'">
        <section class="sec">
          <div class="sec-h">素材</div>
          <button v-if="node.asset" type="button" class="resbox" title="点击预览" @click="openPreview(node.assetId)">
            <img v-if="assetThumb(node.asset)" :src="assetThumb(node.asset)!" alt="" />
            <span v-else class="muted">{{ KIND_TEXT[node.asset.kind] ?? node.asset.kind }}</span>
          </button>
          <div v-else class="err-text">引用的资产已不存在（#{{ node.assetId ?? '?' }}）</div>
          <div v-if="node.asset" class="kvs">
            <div class="kv">
              <span class="k">类型</span>
              <span class="v">
                {{ KIND_TEXT[node.asset.kind] ?? node.asset.kind }}
                <template v-if="node.asset.purpose"> · {{ purposeText(node.asset.purpose) }}</template>
              </span>
            </div>
            <div v-if="node.asset.width && node.asset.height" class="kv">
              <span class="k">尺寸</span>
              <span class="v mono">{{ node.asset.width }}×{{ node.asset.height }}</span>
            </div>
            <div v-if="node.asset.duration" class="kv">
              <span class="k">时长</span>
              <span class="v mono">{{ node.asset.duration }}s</span>
            </div>
          </div>
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

</style>
