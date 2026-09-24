<script setup lang="ts">
/**
 * 重跑弹窗（spec §4.1）——支持两种范围：
 * - 仅本步骤（单步重跑）：二选一复用成功子任务（默认）/ 全部重跑（reset_tasks=true）；succeeded 下游照常跳过
 * - 级联到末尾（cascade）：从本步起重做到末尾，目标步尊重 reset_tasks、下游一律全量重置，
 *   提交前先拉 rerun-cascade 预览（级联步骤清单 + 预估计费子任务数），二次确认后执行
 * - 无任务型步骤（ai_text 单跑 / tts / ffmpeg_merge）：复用/全部选项禁用，仅整体重执行
 * - 确认 → stepApi.rerun / rerunCascade → emit done({note})（父级刷新 + 展示服务端 note）
 * allowSingle / allowCascade 由父级据可重跑性下发（级联正是「下游 failed 致单步不可用」的解法）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { stepApi, taskApi } from '../../lib/api'
import type { ChainRerunPreview, RunStep } from '../../lib/types'
import Icon from '../common/Icon.vue'
import Modal from '../common/Modal.vue'

const props = withDefaults(
  defineProps<{
    runId: number
    step: RunStep
    /** 单步重跑是否可用；默认 true（画布抽屉旧用法零改动即纯单步行为） */
    allowSingle?: boolean
    /** 级联重跑是否可用；默认 false（本期仅运行详情页下发） */
    allowCascade?: boolean
  }>(),
  { allowSingle: true, allowCascade: false },
)
const emit = defineEmits<{ close: []; done: [result: { note: string }] }>()

const scope = ref<'single' | 'cascade'>(
  props.allowSingle ? 'single' : 'cascade',
)
// 仅当两种范围都可用时才显示范围选择器；只允许一种时锁定该范围、保持界面简洁
const showScope = computed(() => props.allowSingle && props.allowCascade)
const mode = ref<'reuse' | 'all'>('reuse')
const loading = ref(true)
const busy = ref(false)
const err = ref('')
const total = ref(0)
const succeeded = ref(0)

// 级联预览
const preview = ref<ChainRerunPreview | null>(null)
const previewLoading = ref(false)
const previewErr = ref('')

const noTasks = computed(() => !loading.value && total.value === 0)
/** 复用模式预计执行数（非 succeeded 数；含 failed/cancelled/pending/processing） */
const willRun = computed(() =>
  mode.value === 'all' ? total.value : total.value - succeeded.value,
)
const canSubmit = computed(() => {
  if (busy.value || loading.value) return false
  if (scope.value === 'cascade')
    return !previewLoading.value && !!preview.value && !previewErr.value
  return true
})

async function loadPreview(): Promise<void> {
  if (scope.value !== 'cascade') return
  previewLoading.value = true
  previewErr.value = ''
  try {
    preview.value = await stepApi.describeCascade(
      props.runId,
      props.step.stepKey,
      { reset_tasks: mode.value === 'all' },
    )
  } catch (e) {
    previewErr.value = e instanceof Error ? e.message : String(e)
    preview.value = null
  } finally {
    previewLoading.value = false
  }
}

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
  if (scope.value === 'cascade') void loadPreview()
})

watch(scope, (s) => {
  if (s === 'cascade' && !preview.value && !previewLoading.value) void loadPreview()
})
watch(mode, () => {
  if (scope.value === 'cascade') void loadPreview()
})

async function submit() {
  if (!canSubmit.value) return
  busy.value = true
  err.value = ''
  try {
    const reset_tasks = mode.value === 'all'
    const res =
      scope.value === 'cascade'
        ? await stepApi.rerunCascade(props.runId, props.step.stepKey, {
            reset_tasks,
          })
        : await stepApi.rerun(props.runId, props.step.stepKey, { reset_tasks })
    emit('done', { note: res.note })
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal title="重跑步骤" :width="540" @close="emit('close')">
    <div class="rr">
      <div class="rr-target">
        <Icon name="refresh" :size="13" />
        <span class="tt">{{ step.title }}</span>
        <span class="muted mono">{{ step.stepKey }}</span>
      </div>

      <!-- 重跑范围（仅两种都可用时供选择） -->
      <div v-if="showScope" class="rr-scope">
        <label class="rr-opt">
          <input
            v-model="scope"
            type="radio"
            value="single"
            :disabled="busy"
          />
          <span class="rr-opt-main">
            <span class="tt">仅本步骤</span>
            <span class="muted">只重跑该步骤；已成功的其他步骤照常跳过。</span>
          </span>
        </label>
        <label class="rr-opt">
          <input
            v-model="scope"
            type="radio"
            value="cascade"
            :disabled="busy"
          />
          <span class="rr-opt-main">
            <span class="tt">级联到末尾<em v-if="!allowSingle">（推荐）</em></span>
            <span class="muted">
              从本步起重做到末尾，下游步骤按新产物依次重做（可解开「首帧不理想但下游已失败」的死角）。
            </span>
          </span>
        </label>
      </div>
      <!-- 仅级联可用（单步因其他失败步不可行）：锁定级联并说明原因 -->
      <div v-else-if="!allowSingle && allowCascade" class="rr-note">
        <Icon name="alert" :size="12" />
        <span
          >存在其他失败步骤，单步重跑会立刻打回——已为你锁定「级联到末尾」。</span
        >
      </div>

      <!-- 目标步子任务口径（复用 / 全部） -->
      <div v-if="loading" class="muted">正在统计子任务…</div>
      <template v-else>
        <div v-if="noTasks" class="rr-note">
          <Icon name="alert" :size="12" />
          <span>该步骤为整体执行型（无子任务），将整体重新执行。</span>
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
              >目标步复用成功子任务<em v-if="!noTasks">（默认）</em></span
            >
            <span class="muted"
              >本步已成功的子任务不重做（0 调用）；失败 /
              未完成的重做。下游仍会全部重做。</span
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
            <span class="tt">目标步全部重跑</span>
            <span class="muted"
              >本步全部子任务归零并重做（如换了模型想重出首帧）。
              <template v-if="scope === 'cascade'"
                >下游一并全部重做。</template
              ></span
            >
          </span>
        </label>

        <div v-if="!noTasks && scope === 'single'" class="rr-count">
          <span class="muted">共 {{ total }} 个子任务：</span>
          <template v-if="mode === 'reuse'">
            <span class="ok">{{ succeeded }} 个成功将复用</span>
            <span class="muted">，预计执行 {{ willRun }} 个</span>
          </template>
          <template v-else>
            <span class="bad">{{ total }} 个将全部重新执行（计费）</span>
          </template>
        </div>
      </template>

      <!-- 级联预览明细 -->
      <div v-if="scope === 'cascade'" class="rr-chain">
        <div v-if="previewLoading" class="muted">正在计算级联范围…</div>
        <div v-else-if="previewErr" class="err-text">{{ previewErr }}</div>
        <template v-else-if="preview">
          <div class="rr-chain-sum">
            <Icon name="alert" :size="12" />
            <span
              >从本步起重做
              <b>{{ preview.chain.length }}</b> 步，其中
              <b class="bad">{{ preview.chargedSteps }}</b> 步含生成计费，预计
              <b>{{ preview.totalTasksToRun }}</b> 个子任务。</span
            >
          </div>
          <ul class="rr-chain-list">
            <li v-for="c in preview.chain" :key="c.stepKey">
              <span class="dot" :class="{ tgt: c.isTarget }" />
              <span class="nm">{{ c.title }}</span>
              <span class="muted mono ac">{{ c.actionKey }}</span>
              <span v-if="c.isTarget" class="tag tgt">目标</span>
              <span v-if="c.charged" class="tag charge"
                >计费 {{ c.tasksToRun }}<template v-if="c.tasksTotal">/{{ c.tasksTotal }}</template></span
              >
              <span v-else class="tag run">执行</span>
            </li>
          </ul>
          <div class="rr-chain-warn muted">
            下游多版本选片将重置为默认；含人工闸的步骤可能再次挂起等待放行；历史产物版本保留。
          </div>
        </template>
      </div>

      <div v-if="mode === 'all' && !noTasks" class="rr-warn">
        <Icon name="alert" :size="12" />
        <span
          >全量重跑会重新调用生成服务（图像 / 视频 /
          语音均可能计费）。</span
        >
      </div>

      <div v-if="err" class="err-text">{{ err }}</div>
    </div>

    <template #footer>
      <button class="btn" :disabled="busy" @click="emit('close')">取消</button>
      <button class="btn primary" :disabled="!canSubmit" @click="submit">
        <Icon name="refresh" :size="13" />
        {{
          busy
            ? '提交中…'
            : scope === 'cascade'
              ? '确认级联重跑'
              : '确认重跑'
        }}
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

.rr-scope,
.rr {
  display: flex;
  flex-direction: column;
  gap: 9px;
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

.rr-chain {
  border-top: 1px dashed var(--border);
  padding-top: 9px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.rr-chain-sum {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12.5px;
  color: var(--warn);
  background: var(--warn-weak);
  border-radius: 8px;
  padding: 7px 10px;
}

.rr-chain-sum b {
  font-weight: 700;
}

.rr-chain-sum .bad {
  color: var(--bad);
}

.rr-chain-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
}

.rr-chain-list li {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
}

.rr-chain-list .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--border-strong);
  flex: none;
}

.rr-chain-list .dot.tgt {
  background: var(--accent);
}

.rr-chain-list .nm {
  font-weight: 500;
}

.rr-chain-list .ac {
  font-size: 11px;
}

.rr-chain-list .tag {
  margin-left: auto;
  font-size: 11px;
  border-radius: 999px;
  padding: 1px 8px;
  border: 1px solid transparent;
  flex: none;
}

.rr-chain-list .tag.tgt {
  color: var(--accent);
  background: var(--accent-weak);
  border-color: rgb(99 102 241 / 26%);
}

.rr-chain-list .tag.charge {
  color: var(--bad);
  background: var(--bad-weak);
}

.rr-chain-list .tag.run {
  color: var(--text-3);
  background: var(--surface-2);
}

.rr-chain-warn {
  font-size: 11.5px;
  line-height: 1.5;
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
</style>
