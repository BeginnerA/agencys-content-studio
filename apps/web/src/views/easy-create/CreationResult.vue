<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../../components/common/Icon.vue'
import {
  createEditExchangeDownload,
  EDIT_EX_FORMATS,
  editExEnabled,
  editExTitle,
  probeEditExchangeFormats,
} from '../../lib/edit-exchange'
import { fmtDur } from '../../lib/format'
import type { EditExchangeFormat, EditExchangeFormatsResult } from '../../lib/api'
import type { useEasyCreate } from './use-creation-chat'

const props = defineProps<{ s: ReturnType<typeof useEasyCreate> }>()
const router = useRouter()

const result = computed(() => props.s.state.detail?.result ?? null)
const plan = computed(() => props.s.state.detail?.session.plan ?? null)
const runStarted = computed(() => !!props.s.state.detail?.session.runId)
// 毕业通道：仅对剧情/对白（短剧）方案开放——旁白口播不属于“升级短剧”诉求
const canGraduate = computed(
  () =>
    !!plan.value &&
    runStarted.value &&
    (plan.value.genre === 'story' || plan.value.performance === 'dialogue'),
)
const gradPanel = ref(false)
const gradBusy = ref(false)
async function graduate(mode: 'episode' | 'series') {
  if (gradBusy.value) return
  gradBusy.value = true
  try {
    const res = await props.s.graduate(mode)
    if (res) {
      gradPanel.value = false
      await router.push(`/runs/${res.runId}`)
    }
  } finally {
    gradBusy.value = false
  }
}
const runId = computed(() => props.s.state.detail?.session.runId ?? null)
const projectId = computed(
  () => props.s.state.detail?.session.projectId ?? null,
)
const fileUrl = computed(() =>
  result.value ? `/api/v1/assets/${result.value.videoId}/file` : '',
)
const downloadUrl = computed(() =>
  fileUrl.value ? `${fileUrl.value}?download=1` : '',
)
const coverUrl = computed(() =>
  result.value?.coverId
    ? `/api/v1/assets/${result.value.coverId}/thumb?v=2`
    : null,
)

// ===== 剪辑工程交换导出（成片导出为多轨工程继续精剪）=====
const editExFormats = ref<EditExchangeFormatsResult | null>(null)
const editExBusy = ref(false)
const editExErr = ref('')

/** 成片就绪（result + runId 均存在）才探测能力；本组件常驻挂载，需 watch 而非 onMounted */
const editExRunId = computed(() =>
  result.value && runId.value != null ? runId.value : null,
)
watch(
  editExRunId,
  async (id) => {
    editExFormats.value = id != null ? await probeEditExchangeFormats(id) : null
  },
  { immediate: true },
)

async function exportEditEx(format: EditExchangeFormat) {
  const id = editExRunId.value
  if (id == null || editExBusy.value) return
  editExBusy.value = true
  editExErr.value = ''
  try {
    await createEditExchangeDownload(id, format)
  } catch (e) {
    editExErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    editExBusy.value = false
  }
}
</script>

<template>
  <div v-if="result" class="card panel ok-card" aria-label="成片结果">
    <header class="rh">
      <h2><Icon name="check" :size="16" /> 制作完成</h2>
      <span v-if="result.duration" class="chip">{{
        fmtDur(result.duration)
      }}</span>
    </header>
    <p class="note">
      已通过基础交付检查（可解码、时长与旁白字幕文件完整）。基础检查不等于内容质量或事实准确性保证。
    </p>

    <video
      class="player"
      :src="fileUrl"
      :poster="coverUrl ?? undefined"
      controls
      preload="metadata"
      playsinline
    />

    <footer class="rf">
      <a class="btn ok" :href="downloadUrl" download>
        <Icon name="download" :size="14" /> 下载 MP4
      </a>
      <RouterLink v-if="runId" class="btn" :to="`/runs/${runId}`">
        <Icon name="external" :size="13" /> 查看制作详情
      </RouterLink>
      <RouterLink v-if="projectId" class="btn sm" :to="`/projects/${projectId}`"
        >查看项目</RouterLink
      >
    </footer>

    <!-- 毕业通道（M56）：把已确认方案升级到专业链（同项目建未启动任务，核对预算后再制作） -->
    <div v-if="canGraduate" class="graduate">
      <button
        class="btn sm grad-toggle"
        :disabled="gradBusy || props.s.state.busyAction"
        @click="gradPanel = !gradPanel"
      >
        <Icon name="sparkles" :size="13" /> 升级专业成片
      </button>
      <div v-if="gradPanel" class="grad-panel">
        <p class="note">
          会在同一项目《{{ plan?.title }}》创建一个<strong>尚未开始</strong>的专业链任务（零计费）。
          专业流程会重新生成剧本并在剧本闸口请你复核，随后点亮角色定妆照、逐句配音、背景音乐与品牌等能力；到任务详情核对预算后再启动。
        </p>
        <div class="grad-btns">
          <button class="btn ok" :disabled="gradBusy || props.s.state.busyAction" @click="graduate('episode')">
            <Icon name="film" :size="13" /> 本集升级为专业成片
          </button>
          <button class="btn" :disabled="gradBusy || props.s.state.busyAction" @click="graduate('series')">
            <Icon name="layers" :size="13" /> 立项为连载系列
          </button>
        </div>
      </div>
    </div>

    <!-- 导出剪辑工程：成片→多轨工程（FCPXML/EDL/OTIO），到剪辑软件继续精剪 -->
    <div v-if="editExFormats?.final_video" class="editex">
      <span class="editex-lab">导出剪辑工程（多轨精剪）</span>
      <div class="editex-btns">
        <button
          v-for="f in EDIT_EX_FORMATS"
          :key="f.key"
          class="btn sm"
          :aria-busy="editExBusy"
          :disabled="editExBusy || !editExEnabled(editExFormats, f.key)"
          :title="editExTitle(editExFormats, f.key, editExBusy)"
          @click="exportEditEx(f.key)"
        >
          <Icon name="cube" :size="12" /> {{ f.label }}
        </button>
      </div>
      <p v-if="editExErr" class="note err">{{ editExErr }}</p>
    </div>
  </div>
</template>

<style scoped>
.card {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background:
    linear-gradient(180deg, rgb(34 197 94 / 7%), transparent 34%), var(--panel);
}

.ok-card {
  border-color: rgb(34 197 94 / 34%);
}

.rh {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.rh h2 {
  font-size: 15px;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 700;
  color: var(--ok);
}

.rh h2 .ic {
  color: var(--ok);
}

.note {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.6;
}

.player {
  width: 100%;
  max-height: 60vh;
  border-radius: 12px;
  background: #000;
  border: 1px solid var(--border-strong);
  object-fit: contain;
  box-shadow: var(--shadow);
}

.rf {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* 剪辑工程交换导出区 */
.editex {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 4px;
  border-top: 1px solid var(--border);
}

.editex-lab {
  font-size: 12px;
  color: var(--text-3);
}

.editex-btns {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.editex .err {
  color: var(--danger, #dc2626);
}

/* 毕业通道 */
.graduate {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 4px;
  border-top: 1px solid var(--border);
}

.grad-toggle {
  align-self: flex-start;
}

.grad-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.grad-btns {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
