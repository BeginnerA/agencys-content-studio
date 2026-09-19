<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import Icon from '../../components/common/Icon.vue'
import { creationStatusLabel, creationStatusTone } from '../../lib/types'
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

// 状态徽标（与列表页共用 creationStatusLabel/Tone）：ready 但预检未过时显「待完善配置」；started 控制态按 run 真实状态派生（progress 已带 run 状态）
const confirmable = computed(() => session.value?.status === 'ready' && session.value?.preflight?.ready === true)
const statusLabel = computed(() =>
  session.value ? creationStatusLabel(session.value.status, confirmable.value, detail.value?.progress?.status ?? null) : '')
const statusBadge = computed(() =>
  session.value ? creationStatusTone(session.value.status, detail.value?.progress?.status ?? null) : 'pending')

function load(): void {
  if (id.value) void s.open(id.value)
}

onMounted(load)
watch(() => route.params.id, load)
onUnmounted(() => s.leave())
</script>

<template>
  <div class="ecw">
    <header class="appbar panel">
      <RouterLink class="back" to="/create">
        <Icon name="chevron-left" :size="16" /> 轻松创作
      </RouterLink>
      <span class="sep" aria-hidden="true" />
      <div class="wt">
        <span v-if="session" class="badge" :class="statusBadge">{{ statusLabel }}</span>
        <span class="wname">{{ session?.plan?.title || '创作会话' }}</span>
      </div>
      <nav class="wlinks" aria-label="专业工作台">
        <RouterLink v-if="projectId" class="wl" :to="`/projects/${projectId}`">
          <Icon name="folder" :size="13" /> 项目
        </RouterLink>
        <RouterLink class="wl" to="/settings">
          <Icon name="sliders" :size="13" /> AI 配置
        </RouterLink>
      </nav>
    </header>

    <div v-if="s.state.loadingDetail && !detail" class="empty pad">加载中…</div>

    <div v-else class="cols">
      <ConversationPanel class="col conv" :s="s" />
      <div class="col ec-side">
        <CreationResult :s="s" />
        <CreationProgress :s="s" />
        <CreationPlanCard v-if="hasPlan" :s="s" />
        <div v-if="!hasPlan && !detail?.progress && !detail?.result" class="panel idle">
          <Icon name="wand" :size="22" />
          <p class="idle-t">策划助手正在听你描述</p>
          <p class="muted">左侧继续补充需求，方案会在这里生成。确认方案前不会产生媒体制作费用。</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ecw {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  height: calc(100dvh - 44px);
  min-height: 540px;
}

.appbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 11px 16px;
  border-radius: 12px;
  background: linear-gradient(180deg, rgb(99 102 241 / 6%), transparent 60%), var(--panel);
}

.back {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--text-2);
  text-decoration: none;
  font-size: 13px;
  white-space: nowrap;
  padding: 3px 6px 3px 2px;
  border-radius: 7px;
  transition: color 0.15s, background 0.15s;
}

.back:hover {
  color: #fff;
  background: var(--hover);
  text-decoration: none;
}

.sep {
  width: 1px;
  height: 18px;
  background: var(--border-strong);
  flex: none;
}

.wt {
  display: flex;
  align-items: center;
  gap: 9px;
  flex: 1;
  min-width: 0;
}

.wname {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wlinks {
  display: flex;
  gap: 6px;
}

.wl {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  color: var(--text-2);
  text-decoration: none;
  padding: 5px 11px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-2);
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}

.wl:hover {
  border-color: var(--accent);
  color: #fff;
  background: var(--raised);
  text-decoration: none;
}

.wl .ic {
  color: var(--accent-h);
}

.pad {
  padding: 24px;
}

.cols {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
}

.conv {
  min-height: 0;
  height: 100%;
}

.ec-side {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
}

.idle {
  padding: 30px 22px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 6px;
}

.idle .ic {
  color: var(--accent-h);
  margin-bottom: 4px;
}

.idle-t {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.idle p.muted {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  max-width: 300px;
}

@media (max-width: 900px) {
  .ecw {
    height: auto;
    min-height: calc(100dvh - 44px);
  }

  .cols {
    grid-template-columns: 1fr;
  }

  .conv {
    height: auto;
    min-height: 60vh;
  }

  .ec-side {
    height: auto;
    overflow: visible;
  }
}
</style>
