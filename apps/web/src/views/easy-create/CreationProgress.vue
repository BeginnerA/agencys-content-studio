<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from '../../components/common/Icon.vue'
import { runStatus, stepStatus } from '../../lib/format'
import type { useEasyCreate } from './use-creation-chat'

const props = defineProps<{ s: ReturnType<typeof useEasyCreate> }>()

const detail = computed(() => props.s.state.detail)
const prog = computed(() => detail.value?.progress ?? null)
const plan = computed(() => detail.value?.session.plan ?? null)
const total = computed(() => plan.value?.shots.length ?? 0)
const active = computed(
  () =>
    !!prog.value &&
    ['queued', 'running', 'processing', 'pending'].includes(prog.value.status),
)
const settledBad = computed(
  () => !!prog.value && ['failed', 'cancelled'].includes(prog.value.status),
)
const needsVerify = computed(() => prog.value?.needsVerification ?? false)
// 运行态/步骤态文案（后端 status 为宽字符串，经映射兜底，未知态原样显示）
const runMeta = computed(() => runStatus((prog.value?.status ?? '') as never))
const stepMeta = (s: string) => stepStatus(s as never)
// 无外部任务号且未成功的任务：默认仅恢复查询；勾选=用户已在供应商侧核实失败并授权重新提交
const resubmitIds = ref<number[]>([])

function toggle(id: number): void {
  const i = resubmitIds.value.indexOf(id)
  if (i >= 0) resubmitIds.value.splice(i, 1)
  else resubmitIds.value.push(id)
}

async function onCancel(): Promise<void> {
  await props.s.cancel()
}
async function onRetry(): Promise<void> {
  resubmitIds.value = []
  await props.s.retry([])
}
async function onRetryVerified(): Promise<void> {
  await props.s.retry(resubmitIds.value)
  resubmitIds.value = []
}
</script>

<template>
  <div v-if="prog" class="card panel" aria-label="制作进度">
    <header class="ph">
      <h2><Icon name="film" :size="16" /> 制作进度</h2>
      <span class="badge" :class="runMeta.cls">{{ runMeta.text }}</span>
    </header>

    <div v-if="total" class="bar">
      <div
        class="bfill"
        :style="{
          width: Math.min(100, (prog.completedShots / total) * 100) + '%',
        }"
      />
    </div>
    <div class="shotn">
      <span
        >已完成镜头 <b class="mono">{{ prog.completedShots }}</b> /
        {{ total }}</span
      ><span class="mono pct"
        >{{
          total
            ? Math.round(Math.min(100, (prog.completedShots / total) * 100))
            : 0
        }}%</span
      >
    </div>

    <ol class="steps">
      <li v-for="st in prog.steps" :key="st.key">
        <span class="badge" :class="st.status"
          >{{ st.title }} · {{ stepMeta(st.status).text }}</span
        >
        <span v-if="st.error" class="serr">{{ st.error }}</span>
      </li>
    </ol>

    <div v-if="prog.error" class="runerr" role="alert">
      <Icon name="alert" :size="13" /> {{ prog.error }}
    </div>

    <div v-if="needsVerify" class="verify">
      <p class="vt">
        <Icon name="alert" :size="13" />
        存在受理状态不明的任务，可能已计费。请先在供应商侧核验；不核实则仅恢复查询，不重复提交。
      </p>
      <label
        v-for="t in prog.uncertainTasks.filter((x) => !x.hasExternalId)"
        :key="t.id"
        class="vrow"
      >
        <input
          type="checkbox"
          :checked="resubmitIds.includes(t.id)"
          @change="toggle(t.id)"
        />
        任务 #{{ t.id }}（{{ t.kind }} ·
        {{ t.provider }}）已核实失败，授权重新提交
      </label>
    </div>

    <footer class="pf">
      <button
        v-if="active"
        class="btn danger sm"
        type="button"
        :disabled="s.state.busyAction"
        @click="onCancel"
      >
        <Icon name="stop" :size="13" /> 取消制作
      </button>
      <button
        v-else-if="settledBad"
        class="btn sm"
        type="button"
        :disabled="s.state.busyAction"
        @click="onRetry"
      >
        <Icon name="refresh" :size="13" /> 从断点恢复（复用成功产物）
      </button>
      <button
        v-if="settledBad && resubmitIds.length"
        class="btn primary sm"
        type="button"
        :disabled="s.state.busyAction"
        @click="onRetryVerified"
      >
        恢复并重新提交已核实任务（{{ resubmitIds.length }}）
      </button>
      <RouterLink class="btn sm" :to="`/runs/${prog.runId}`"
        ><Icon name="external" :size="13" /> 专业工作台</RouterLink
      >
    </footer>
  </div>
</template>

<style scoped>
.card {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ph {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.ph h2 {
  font-size: 15px;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 700;
}
.ph h2 .ic {
  color: var(--accent-h);
}
.bar {
  height: 8px;
  border-radius: 999px;
  background: var(--panel-2);
  overflow: hidden;
  border: 1px solid var(--border);
}
.bfill {
  height: 100%;
  background: var(--grad-brand);
  box-shadow: 0 0 12px -2px rgb(99 102 241 / 60%);
  transition: width 0.3s ease;
}
.shotn {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 12.5px;
  color: var(--text-2);
}
.shotn b {
  color: #a5b4fc;
}
.shotn .pct {
  color: var(--text-3);
  font-size: 12px;
}
.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.steps li {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.serr {
  font-size: 12px;
  color: var(--bad);
}
.runerr {
  font-size: 13px;
  color: var(--bad);
  background: var(--bad-weak);
  border: 1px solid rgb(248 113 113 / 28%);
  border-radius: 9px;
  padding: 9px 12px;
  display: flex;
  gap: 7px;
  align-items: flex-start;
}
.verify {
  border: 1px solid rgb(245 158 11 / 30%);
  background: var(--warn-weak);
  border-radius: 9px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.vt {
  margin: 0;
  font-size: 12.5px;
  color: var(--warn);
  display: flex;
  gap: 6px;
  align-items: flex-start;
}
.vrow {
  font-size: 12px;
  color: var(--text-2);
  display: flex;
  gap: 7px;
  align-items: center;
}
.pf {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
</style>
