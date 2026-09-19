<script setup lang="ts">
/**
 * [M11] 单步重跑弹窗（spec §4.1）
 * - 二选一：复用成功子任务（默认，succeeded 不动）/ 全部重跑（reset_tasks=true，全量重执行）
 * - 计数：taskApi.list(?run_id) 前端按 step.id 过滤（该端点无 step_id 参数，limit 200 对本场景足够）
 * - 无任务型步骤（ai_text 单跑 / tts / ffmpeg_merge）：单选整组禁用，仅整体重执行
 * - 确认 → stepApi.rerun → emit done(result)（父级刷新 + 展示服务端 note）
 */
import { computed, onMounted, ref } from 'vue'
import { stepApi, taskApi } from '../../lib/api'
import type { RerunResult, RunStep } from '../../lib/types'
import Icon from '../common/Icon.vue'
import Modal from '../common/Modal.vue'

const props = defineProps<{ runId: number; step: RunStep }>()
const emit = defineEmits<{ close: []; done: [result: RerunResult] }>()

const mode = ref<'reuse' | 'all'>('reuse')
const loading = ref(true)
const busy = ref(false)
const err = ref('')
const total = ref(0)
const succeeded = ref(0)

const noTasks = computed(() => !loading.value && total.value === 0)
/** 复用模式预计执行数（非 succeeded 数；含 failed/cancelled/pending/processing） */
const willRun = computed(() =>
  mode.value === 'all' ? total.value : total.value - succeeded.value,
)

onMounted(async () => {
  try {
    const r = await taskApi.list(`?run_id=${props.runId}`)
    const mine = r.items.filter((t) => t.stepId === props.step.id)
    total.value = mine.length
    succeeded.value = mine.filter((t) => t.status === 'succeeded').length
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
})

async function submit() {
  if (busy.value || loading.value) return
  busy.value = true
  err.value = ''
  try {
    const res = await stepApi.rerun(props.runId, props.step.stepKey, {
      reset_tasks: mode.value === 'all',
    })
    emit('done', res)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal title="单步重跑" :width="500" @close="emit('close')">
    <div class="rr">
      <div class="rr-target">
        <Icon name="refresh" :size="13" />
        <span class="tt">{{ step.title }}</span>
        <span class="muted mono">{{ step.stepKey }}</span>
      </div>

      <div v-if="loading" class="muted">正在统计子任务…</div>
      <template v-else>
        <div v-if="noTasks" class="rr-note">
          <Icon name="alert" :size="12" />
          <span
            >该步骤为整体执行型（无子任务），重跑将重新执行整个步骤；下游产物不变，如需生效请重跑下游或重新合成。</span
          >
        </div>

        <label class="rr-opt" :class="{ disabled: noTasks }">
          <input
            v-model="mode"
            type="radio"
            value="reuse"
            :disabled="noTasks || busy"
          />
          <span class="rr-opt-main">
            <span class="tt"
              >复用成功子任务<em v-if="!noTasks">（默认）</em></span
            >
            <span class="muted"
              >已成功的子任务不重跑（0 调用）；失败 /
              未完成的子任务重新执行。</span
            >
          </span>
        </label>

        <label class="rr-opt" :class="{ disabled: noTasks }">
          <input
            v-model="mode"
            type="radio"
            value="all"
            :disabled="noTasks || busy"
          />
          <span class="rr-opt-main">
            <span class="tt">全部重跑</span>
            <span class="muted"
              >该步骤全部子任务归零并重新执行（可能产生生成费用）。</span
            >
          </span>
        </label>

        <div v-if="!noTasks" class="rr-count">
          <span class="muted">共 {{ total }} 个子任务：</span>
          <template v-if="mode === 'reuse'">
            <span class="ok">{{ succeeded }} 个成功将复用</span>
            <span class="muted">，预计执行 {{ willRun }} 个</span>
          </template>
          <template v-else>
            <span class="bad">{{ total }} 个将全部重新执行（计费）</span>
          </template>
        </div>

        <div v-if="mode === 'all' && !noTasks" class="rr-warn">
          <Icon name="alert" :size="12" />
          <span
            >全量重跑会重新调用生成服务（图像 / 视频 /
            语音均可能计费），历史产物版本保留。</span
          >
        </div>

        <div class="muted rr-tip">
          重跑后 run 重新入队；已成功的其他步骤照常跳过。
        </div>
      </template>

      <div v-if="err" class="err-text">{{ err }}</div>
    </div>

    <template #footer>
      <button class="btn" :disabled="busy" @click="emit('close')">取消</button>
      <button class="btn primary" :disabled="busy || loading" @click="submit">
        <Icon name="refresh" :size="13" /> {{ busy ? '提交中…' : '确认重跑' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.rr {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 13px;
}

.rr-target {
  display: flex;
  align-items: center;
  gap: 7px;
}

.rr-target .tt {
  font-weight: 600;
}

.rr-opt {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px 11px;
  cursor: pointer;
  transition: border-color 0.15s;
}

.rr-opt:not(.disabled):hover {
  border-color: var(--border-strong);
}

.rr-opt.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.rr-opt input {
  margin-top: 2px;
}

.rr-opt-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rr-opt-main .tt {
  font-weight: 600;
  font-size: 13px;
}

.rr-opt-main .tt em {
  font-style: normal;
  color: var(--text-3);
  font-weight: 400;
}

.rr-opt-main .muted {
  font-size: 12px;
}

.rr-count {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  font-size: 12.5px;
}

.rr-count .ok {
  color: var(--ok);
  font-weight: 600;
}

.rr-count .bad {
  color: var(--bad);
  font-weight: 600;
}

.rr-warn,
.rr-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  border-radius: 8px;
  padding: 7px 10px;
}

.rr-warn {
  color: var(--bad);
  background: var(--bad-weak);
}

.rr-note {
  color: var(--warn);
  background: var(--warn-weak);
}

.rr-tip {
  font-size: 11.5px;
}
</style>
