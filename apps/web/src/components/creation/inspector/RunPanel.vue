<script setup lang="ts">
import type { CanvasDocNode } from '../../../lib/types'
import { fmtTime } from '../../../lib/format'
import Icon from '../../common/Icon.vue'
import { RUN_CLS, RUN_TEXT } from './internals'
import type { InspectorApi, InspectorForm } from './use-inspector-form'

const props = defineProps<{
  node: CanvasDocNode
  form: InspectorForm
  openRunDetail: InspectorApi['openRunDetail']
  cancelRun: InspectorApi['cancelRun']
}>()
const form = props.form
</script>

<template>
      <!-- ===== [M17] run 节点：内嵌运行 ===== -->
      <template v-if="node.kind === 'run'">
        <section class="sec">
          <div class="sec-h">运行</div>
          <template v-if="node.run">
            <div class="kvs">
              <div class="kv"><span class="k">运行</span><span class="v mono">#{{ node.run.id }}</span></div>
              <div class="kv"><span class="k">模板</span><span class="v mono">{{ node.run.templateKey }}</span></div>
              <div class="kv">
                <span class="k">状态</span>
                <span class="v">
                  <span class="badge" :class="RUN_CLS[node.run.status] ?? 'pending'">
                    {{ RUN_TEXT[node.run.status] ?? node.run.status }}
                  </span>
                </span>
              </div>
              <div class="kv"><span class="k">步骤</span><span class="v mono">{{ node.run.steps.succeeded }}/{{ node.run.steps.total }} 成功</span></div>
              <div v-if="node.run.startedAt" class="kv"><span class="k">开始</span><span class="v mono">{{ fmtTime(node.run.startedAt) }}</span></div>
              <div v-if="node.run.completedAt" class="kv"><span class="k">结束</span><span class="v mono">{{ fmtTime(node.run.completedAt) }}</span></div>
            </div>
            <div class="ops">
              <button type="button" class="btn sm" @click="openRunDetail">
                <Icon name="doc" :size="12" /> 打开运行详情
              </button>
              <button v-if="form.canCancelRun" type="button" class="btn sm danger" :disabled="form.opBusy" @click="cancelRun">
                <Icon name="stop" :size="12" /> 取消运行
              </button>
            </div>
            <div class="muted mini">画布内进度由轮询实时更新；详情页可查看每步输入输出。</div>
          </template>
          <div v-else class="err-text">运行数据缺失或被删除（可能已超出保留期）</div>
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

.ops {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.sp {
  flex: 1;
}

.mini {
  font-size: 11px;
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
