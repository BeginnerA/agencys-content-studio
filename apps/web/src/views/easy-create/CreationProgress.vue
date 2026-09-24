<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Icon from '../../components/common/Icon.vue'
import { runStatus, stepStatus } from '../../lib/format'
import { configDriftText } from '../../lib/confirm'
import type { useEasyCreate } from './use-creation-chat'

const props = defineProps<{ s: ReturnType<typeof useEasyCreate> }>()

const detail = computed(() => props.s.state.detail)
const prog = computed(() => detail.value?.progress ?? null)
const stages = computed(() => prog.value?.stages ?? [])
const total = computed(() => stages.value.filter((s) => s.applicable === true).length)
const done = computed(() => stages.value.filter((s) => s.applicable === true && s.status === 'succeeded').length)
const active = computed(
  () =>
    !!prog.value &&
    ['queued', 'running', 'processing', 'pending'].includes(prog.value.status),
)
const settledBad = computed(
  () => !!prog.value && ['failed', 'cancelled'].includes(prog.value.status),
)
// 挂起在人工闸：等的是用户决策（上方审阅面板），不是失败也不是「默默运行中」
const waiting = computed(() => prog.value?.status === 'waiting_input')
const recovery = computed(() => prog.value?.recovery)
const acceptUnpriced = ref(false)
const acceptConfigDrift = ref(false)
const configDrift = computed(() => recovery.value?.configDrift ?? [])
const configUnavailable = computed(() => configDrift.value.some((d) => d.to === null))
const canRetry = computed(() => !!recovery.value?.resumable && !configUnavailable.value && recovery.value.requiredTaskIds.every((id) => resubmitIds.value.includes(id)) && (!recovery.value.unpriced.length || acceptUnpriced.value) && (!configDrift.value.length || acceptConfigDrift.value))
// 运行态/步骤态文案（后端 status 为宽字符串，经映射兜底，未知态原样显示）
// waiting_input 在轻松创作里说「等待审阅」（专业工作台沿用 format.ts 的「待审阅」）；徽章复用全局 .waiting_input 色类
const runMeta = computed(() =>
  prog.value?.status === 'waiting_input'
    ? { text: '等待审阅', cls: 'waiting_input' }
    : runStatus((prog.value?.status ?? '') as never),
)
const stepMeta = (s: string) => s === 'not_applicable' ? { text: '不适用' } : s === 'unknown' ? { text: '信息待核实' } : s === 'waiting_input' ? { text: '等待审阅' } : stepStatus(s as never)
// 无编号的请求必须逐项核实；有编号的未完成任务默认恢复查询。
const resubmitIds = ref<number[]>([])
watch(() => JSON.stringify([detail.value?.session.id, prog.value?.runId, detail.value?.session.planRevision, detail.value?.session.planHash, recovery.value]), () => {
  resubmitIds.value = []
  acceptUnpriced.value = false
  acceptConfigDrift.value = false
}, { flush: 'sync' })

function toggle(id: number): void {
  const i = resubmitIds.value.indexOf(id)
  if (i >= 0) resubmitIds.value.splice(i, 1)
  else resubmitIds.value.push(id)
}

async function onCancel(): Promise<void> {
  await props.s.cancel()
}
async function onRetry(): Promise<void> {
  if (canRetry.value) await props.s.retry(resubmitIds.value, acceptUnpriced.value, acceptConfigDrift.value)
}
</script>

<template>
  <div v-if="prog" class="card panel" aria-label="制作进度">
    <header class="ph">
      <h2><Icon name="film" :size="16" /> 制作进度</h2>
      <span class="badge" :class="runMeta.cls">{{ runMeta.text }}</span>
    </header>

    <p class="ec-progress-summary" aria-live="polite">已完成 {{ done }}/{{ total }} 个适用阶段</p>
    <p v-if="waiting" class="ec-progress-summary">已按你勾选的审阅在画面生成后暂停，请在上方审阅面板确认是否继续。</p>

    <ol class="steps">
      <li v-for="st in stages" :key="st.key">
        <span class="badge" :class="st.status"
          >{{ st.title }} · {{ stepMeta(st.status).text }}</span
        >
        <span v-if="st.total !== null" class="ec-progress-count">{{ st.completed }}/{{ st.total }} {{ st.key === 'voice' ? '句' : '镜' }}</span>
      </li>
    </ol>

    <div v-if="prog.issue" class="runerr" role="alert">
      <Icon name="alert" :size="13" /> {{ prog.issue.summary }}
    </div>
    <details v-if="prog.issue?.details.length" class="ec-progress-technical">
      <summary>技术详情</summary>
      <p v-for="d in prog.issue.details" :key="d.message">{{ d.scopes.join('、') }}：{{ d.message }}</p>
    </details>

    <div v-if="settledBad && recovery?.resumable" class="verify">
      <p class="vt">恢复将复用成功产物；{{ recovery.queryTaskCount }} 个有编号的未完成任务默认恢复查询。后续制作及核实后重新提交可能产生费用，不承诺预算硬封顶。</p>
      <p v-if="recovery.requiredTaskIds.length" class="vt">以下无编号请求必须先在供应商侧逐项核实失败，全部勾选后才可恢复。</p>
      <label
        v-for="t in prog.uncertainTasks.filter((x) => !x.hasExternalId)"
        :key="t.id"
        class="vrow"
      >
        <input
          type="checkbox"
          :checked="resubmitIds.includes(t.id)"
          :disabled="s.state.busyAction"
          @change="toggle(t.id)"
        />
        {{ t.label }} · 任务 #{{ t.id }}（{{ t.kind }} ·
        {{ t.provider || '供应商未知' }}）已核实失败，授权重新提交
      </label>
      <template v-if="configDrift.length">
        <p class="vt">已批准配置已变化，恢复需重新确认；同型号也可能发生价格或协议变化。</p>
        <ul class="ec-progress-drift">
          <li v-for="d in configDrift" :key="d.service">{{ configDriftText(d) }}</li>
        </ul>
        <p v-if="configUnavailable" class="vt" role="alert">当前无可用配置，暂不能恢复。请检查实例是否启用、协议是否合格及凭据是否可用，再点击“更新状态”。</p>
        <label v-else class="vrow">
          <input v-model="acceptConfigDrift" type="checkbox" :disabled="s.state.busyAction" />
          我接受改用当前配置，模型、协议或价格可能与批准时不同，后续制作可能产生费用
        </label>
      </template>
      <label v-if="recovery.unpriced.length" class="vrow">
        <input v-model="acceptUnpriced" type="checkbox" :disabled="s.state.busyAction" />
        我接受未计价项目可能产生费用：{{ recovery.unpriced.join('、') }}
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
        v-else-if="recovery?.resumable"
        class="btn primary sm"
        type="button"
        :disabled="s.state.busyAction || !canRetry"
        @click="onRetry"
      >
        <Icon name="refresh" :size="13" /> {{ s.state.busyAction ? '恢复中…' : '恢复制作' }}
      </button>
      <button class="btn sm" type="button" :disabled="s.state.loadingDetail" @click="s.refreshStatus()">更新状态</button>
      <RouterLink class="btn sm" :to="`/runs/${prog.runId}`"
        ><Icon name="external" :size="13" /> 查看制作详情</RouterLink
      >
    </footer>
    <small class="ec-progress-local">更新状态只重新读取本地记录，不主动查询供应商。</small>
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
.ec-progress-drift { margin: 0; padding-left: 20px; color: var(--text-2); overflow-wrap: anywhere; }
.ec-progress-summary { margin: 0; font-weight: 600; }
.ec-progress-technical { overflow-wrap: anywhere; color: var(--text-2); }
.ec-progress-technical summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; }
.ec-progress-count, .ec-progress-local { color: var(--text-2); }
.vrow { min-height: 44px; font-size: 13px; }
.pf .btn { min-height: 44px; }
</style>
