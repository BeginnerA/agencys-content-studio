<script setup lang="ts">
/**
 * [M35 G11] 项目详情页「下一步建议」条。
 * - 数据源：GET /projects/:id/next-steps（服务端规则引擎，零 LLM、零计费，≤3 条）
 * - 实时：run.completed / run.failed 触发重拉；不猜测、不自动执行（用户点击才路由）
 * - auto 条目仅作进度提示（虚线 chip、无 hover）；action 条目 = 按钮 + cta
 * - 空态：不渲染（隐藏容器）
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { projectApi } from '../../lib/api'
import { studioOff, studioOn } from '../../lib/socket'
import type { NextStep } from '../../lib/types'
import Icon from '../common/Icon.vue'
import ProvenanceBadge from '../common/ProvenanceBadge.vue'

const props = defineProps<{ projectId: number }>()
const router = useRouter()
const steps = ref<NextStep[]>([])

async function reload(): Promise<void> {
  try {
    const { items } = await projectApi.nextSteps(props.projectId)
    steps.value = items
  } catch {
    // 静默：下一步建议为增量能力，失败不影响主流程
    steps.value = []
  }
}

function onSettled(): void {
  void reload()
}

function onClick(s: NextStep): void {
  if (s.route) router.push(s.route)
}

watch(
  () => props.projectId,
  () => void reload(),
)

onMounted(() => {
  void reload()
  studioOn('run.completed', onSettled)
  studioOn('run.failed', onSettled)
})
onBeforeUnmount(() => {
  studioOff('run.completed', onSettled)
  studioOff('run.failed', onSettled)
})

defineExpose({ reload })
</script>

<template>
  <div
    v-if="steps.length"
    class="next-steps"
    role="complementary"
    aria-label="下一步建议"
  >
    <span class="lead muted"
      ><Icon name="sparkles" :size="12" /> 下一步</span
    >
    <!-- [M37·G13] 来源可追溯：规则引擎是本条唯一来源（前端静态标注即事实），强化「仅建议不执行」可见性 -->
    <ProvenanceBadge
      kind="suggest"
      text="规则引擎"
      title="由服务端规则引擎按项目状态推导（零 LLM、零计费）；仅提示不自动执行，点击才会跳转"
    />
    <template v-for="s in steps" :key="s.key">
      <span
        v-if="s.auto"
        class="chip auto"
        :title="s.hint"
        aria-live="polite"
      >
        <span class="dot" aria-hidden="true"></span>
        {{ s.title }}
      </span>
      <button
        v-else
        class="chip action"
        type="button"
        :title="s.hint"
        @click="onClick(s)"
      >
        {{ s.title }}
        <span v-if="s.cta" class="cta">→ {{ s.cta }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.next-steps {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 4px 0 14px;
}

.next-steps .lead {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-3);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font: inherit;
  font-size: 12.5px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel-2);
  color: var(--text);
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
}

.chip:hover {
  border-color: rgb(99 102 241 / 45%);
  background: var(--panel);
}

.chip.auto {
  cursor: default;
  background: transparent;
  border-style: dashed;
  color: var(--text-2);
}

.chip.auto:hover {
  border-color: var(--border);
  background: transparent;
}

.chip .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--brand, #6366f1);
  box-shadow: 0 0 0 3px rgb(99 102 241 / 18%);
}

.chip .cta {
  font-size: 11.5px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
</style>
