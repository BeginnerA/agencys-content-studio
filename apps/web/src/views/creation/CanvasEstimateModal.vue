<script setup lang="ts">
import Modal from '../../components/common/Modal.vue'
import { fmtCost, fmtQty } from '../../lib/format'
import type { CanvasViewState } from './use-canvas-view'

const props = defineProps<{ cv: Pick<CanvasViewState,
  | 'showEstimate'
  | 'estimateResult'
  | 'GEN_KIND_TEXT'
  | 'UNIT_TEXT'
> }>()
const cv = props.cv
</script>

<template>
    <!-- [M18] 执行成本预估（批量面板；零副作用） -->
    <Modal v-if="cv.showEstimate && cv.estimateResult" title="执行成本预估" :width="640" @close="cv.showEstimate = false">
      <div class="exp-meta">
        <div class="em-row">
          <span class="em-k">合计</span>
          <span class="em-v">≈ {{ fmtCost(cv.estimateResult.total.amount) }}（仅含有价节点）</span>
        </div>
        <div class="em-row">
          <span class="em-k">状态</span>
          <span class="em-v">
            {{ cv.estimateResult.total.ready }} 就绪 · {{ cv.estimateResult.total.blocked }} 受阻 · {{ cv.estimateResult.total.busy }} 执行中
          </span>
        </div>
      </div>
      <div v-if="cv.estimateResult.total.unpriced" class="warn-t mini">
        {{ cv.estimateResult.total.unpriced }} 个节点未配置单价或按量计费（tokens 不可预知），不计入合计。
      </div>
      <div class="est-list">
        <div v-for="it in cv.estimateResult.nodes" :key="it.nodeId" class="est-node">
          <div class="est-row">
            <span class="badge" :class="it.busy ? 'processing' : it.ready ? 'succeeded' : 'pending'">
              {{ it.busy ? '执行中' : it.ready ? '就绪' : '受阻' }}
            </span>
            <span class="est-t" :title="it.title">{{ it.title }}</span>
            <span class="muted mini">{{ cv.GEN_KIND_TEXT[it.genKind] ?? it.genKind }}</span>
            <span class="sp" />
            <span class="mono mini est-amt">
              {{ it.unpriced ? (it.units.length ? '部分未定价' : '按量计费') : (it.total == null ? '—' : fmtCost(it.total)) }}
            </span>
          </div>
          <div v-if="it.units.length" class="muted mini est-units">
            <span v-for="(u, i) in it.units" :key="i">
              {{ i ? ' · ' : '' }}{{ fmtQty(u.quantity) }} {{ cv.UNIT_TEXT[u.unit] ?? u.unit }}
              <template v-if="u.unitPrice != null"> × {{ fmtCost(u.unitPrice) }}</template>
              <template v-else> × 未定价</template>
            </span>
          </div>
          <div v-if="it.problems.length" class="err-text mini">{{ it.problems.join('；') }}</div>
        </div>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="cv.showEstimate = false">关闭</button>
      </template>
    </Modal>

</template>

<style scoped>
.sp {
  flex: 1;
}

.mini {
  font-size: 11px;
}

.exp-meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}

.em-row {
  display: flex;
  gap: 8px;
  font-size: 12.5px;
}

.em-k {
  flex: none;
  width: 44px;
  color: var(--text-3);
}

.em-v {
  min-width: 0;
  word-break: break-all;
}

/* ===== [M18] 执行成本预估 / 实体参考弹窗 ===== */
.est-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 360px;
  overflow-y: auto;
  margin-top: 8px;
}

.est-node {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.est-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
}

.est-t {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.est-amt {
  flex: none;
}

</style>
