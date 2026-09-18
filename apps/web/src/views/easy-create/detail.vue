<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import Icon from '../../components/common/Icon.vue'
import ConversationPanel from './ConversationPanel.vue'
import CreationPlanCard from './CreationPlanCard.vue'
import CreationProgress from './CreationProgress.vue'
import CreationResult from './CreationResult.vue'
import { useEasyCreate } from './use-creation-chat'

const s = useEasyCreate()
const route = useRoute()

const id = computed(() => Number(route.params.id))
const detail = computed(() => s.state.detail)
const session = computed(() => detail.value?.session ?? null)
const hasPlan = computed(() => !!detail.value?.session.plan)
const projectId = computed(() => session.value?.projectId ?? null)

// 状态标签（与列表页一致，复用同一份映射）
const STATUS_TEXT: Record<string, string> = {
  draft: '草稿', planning: '规划中', ready: '待确认', starting: '启动中', started: '制作中',
}
const statusBadge = (st: string): string =>
  st === 'started' || st === 'starting' ? 'running' : st === 'ready' ? 'pending' : st === 'draft' ? 'cancelled' : 'pending'

function load(): void {
  if (id.value) void s.open(id.value)
}

onMounted(load)
watch(() => route.params.id, load)
onUnmounted(() => s.leave())
</script>

<template>
  <div class="ecw">
    <header class="wbar">
      <RouterLink class="back" to="/create"><Icon name="chevron-left" :size="15" /> 轻松创作</RouterLink>
      <div class="wt">
        <span v-if="session" class="badge" :class="statusBadge(session.status)">{{ STATUS_TEXT[session.status] ?? session.status }}</span>
        <span class="wname">{{ session?.plan?.title || '创作会话' }}</span>
      </div>
      <nav class="wlinks" aria-label="专业工作台">
        <RouterLink v-if="projectId" class="wl" :to="`/projects/${projectId}`"><Icon name="folder" :size="13" /> 项目</RouterLink>
        <RouterLink class="wl" to="/settings"><Icon name="sliders" :size="13" /> AI 配置</RouterLink>
      </nav>
    </header>

    <div v-if="s.state.loadingDetail && !detail" class="empty pad">加载中…</div>

    <div v-else class="cols">
      <ConversationPanel class="col conv" :s="s" />
      <div class="col side">
        <CreationResult :s="s" />
        <CreationProgress :s="s" />
        <CreationPlanCard v-if="hasPlan" :s="s" />
        <div v-if="!hasPlan && !detail?.progress && !detail?.result" class="panel idle">
          <p class="muted">左侧继续描述需求，策划助手会生成方案。确认方案前不会产生媒体制作费用。</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ecw { display: flex; flex-direction: column; gap: 14px; min-height: 100dvh; }
.wbar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.back { display: inline-flex; align-items: center; gap: 3px; color: var(--text-2); text-decoration: none; font-size: 13px; white-space: nowrap; }
.back:hover { color: #fff; }
.wt { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.wname { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wlinks { display: flex; gap: 6px; }
.wl { display: inline-flex; align-items: center; gap: 4px; font-size: 12.5px; color: var(--text-2); text-decoration: none; padding: 4px 10px; border: 1px solid var(--border); border-radius: 8px; }
.wl:hover { border-color: var(--accent); color: #fff; text-decoration: none; }
.wl .ic { color: var(--accent-h); }
.pad { padding: 24px; }
.cols { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 14px; align-items: start; flex: 1; }
.conv { min-height: 60vh; }
.side { display: flex; flex-direction: column; gap: 14px; }
.idle { padding: 16px 18px; }
.idle p { margin: 0; font-size: 13px; line-height: 1.7; }
@media (max-width: 900px) {
  .cols { grid-template-columns: 1fr; }
  .conv { min-height: 48vh; }
}
</style>
