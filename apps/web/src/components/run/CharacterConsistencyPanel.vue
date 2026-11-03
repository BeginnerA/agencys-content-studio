<script setup lang="ts">
/**
 * 逐出镜实体一致性面板：读取分层参考链路的一致性评价结果，并可手动触发一轮评价。
 *
 * 口径（与结果表落库粒度一致，必须先讲清再读分）：
 *  - 一行 = 一次运行 × 一个出镜实体；episodeIdx 恒为 0（执行期问题已跨集聚合进 issues）；
 *  - 逐角色分是 0–10 的多模态评分，与运行级 0–1 自报一致性分（质量评分四维之一）同名不同源，两者不可互相换算；
 *  - 删除素材档案会连带清掉它的分层登记行与一致性结果行（外键不放开、历史不迁移），所以列表不长期保留已删实体的行；
 *    name 缺失只可能是这道级联清理落地前留下的历史行，界面按「实体 #id」兜底展示，不作为常规形态对外承诺。
 * 触发评价前必须弹费用确认：每个出镜实体串行调用一次多模态评分，产生供应商费用。
 * score=null 行的 note 呈现服务端原文；原文含「不属于本项目」时补一句基准换图指引。
 */
import { onMounted, ref, watch } from 'vue'
import Icon from '../common/Icon.vue'
import { confirmDialog } from '../../lib/confirm'
import { fmtTime } from '../../lib/format'
import {
  consistencyApi,
  type CharacterConsistencyEntity,
} from '../../lib/api/runs'

const props = defineProps<{
  runId: number
}>()

const entities = ref<CharacterConsistencyEntity[]>([])
const loading = ref(true)
const running = ref(false)
const errText = ref('')

/** score=null 且 note 指向「参考图不在本项目资产域」时补的转换指引（池外基准图无法评分的根因处置） */
function poolGuidance(e: CharacterConsistencyEntity): string | null {
  if (e.score !== null || !e.note || !e.note.includes('不属于本项目'))
    return null
  return '基准参考图请改用本项目内的素材'
}

async function load(): Promise<void> {
  loading.value = true
  errText.value = ''
  try {
    const res = await consistencyApi.getCharacter(props.runId)
    entities.value = res.entities
  } catch (e) {
    errText.value = e instanceof Error ? e.message : String(e)
    entities.value = []
  } finally {
    loading.value = false
  }
}

/** 费用确认 → 触发评价（同步串行、耗时随实体数增长）→ 回读落库结果（issues 等以 GET 口径为准） */
async function triggerEval(): Promise<void> {
  if (running.value) return
  const ok = await confirmDialog({
    title: '运行评价',
    message:
      '将逐角色调用多模态评分，产生供应商费用：每个出镜实体串行发起一次图像多模态调用，耗时随实体数增长。确认继续？',
    confirmText: '运行评价',
  })
  if (!ok) return
  running.value = true
  errText.value = ''
  try {
    await consistencyApi.triggerEval(props.runId)
    await load()
  } catch (e) {
    errText.value = e instanceof Error ? e.message : String(e)
  } finally {
    running.value = false
  }
}

function severityLabel(s: string): string {
  return s === 'blocking' ? '阻断' : s === 'warning' ? '警告' : s
}

function severityClass(s: string): string {
  return s === 'blocking'
    ? 'badge failed'
    : s === 'warning'
      ? 'badge queued'
      : 'badge'
}

onMounted(() => {
  void load()
})

watch(
  () => props.runId,
  () => void load(),
)
</script>

<template>
  <div class="panel cc">
    <div class="cc-head">
      <Icon name="users" :size="15" />
      <span class="cc-title">逐出镜实体一致性</span>
      <span v-if="loading" class="muted">加载中…</span>
      <button
        class="btn sm"
        :disabled="loading || running"
        @click="triggerEval"
      >
        <Icon :name="running ? 'refresh' : 'play'" :size="12" />
        {{ running ? '评价中…' : '运行评价' }}
      </button>
    </div>

    <!-- 口径标注：粒度 + 分值来源，避免与运行级自报分混读 -->
    <p class="muted cc-scope">
      口径：一行 = 运行 × 出镜实体（episodeIdx 恒
      0，问题按整场运行聚合）；逐角色分为 0–10 多模态评分，与运行级 0–1
      自报一致性分同名不同源，不可互相换算。
    </p>

    <div v-if="errText" class="err-text">{{ errText }}</div>

    <div v-if="!loading && !entities.length && !errText" class="empty cc-empty">
      <Icon name="shield" :size="18" />
      <p>尚未运行评价；门禁将显示待人工确认</p>
    </div>

    <div v-for="e in entities" :key="e.entityId" class="cc-row">
      <div class="cc-main">
        <div class="cc-line1">
          <span class="cc-name">{{
            e.name ?? `实体 #${e.entityId}（已删除）`
          }}</span>
          <span v-if="e.score === null" class="badge skip">无法评价</span>
          <span v-else class="chip mono">{{ e.score }} / 10</span>
          <span v-if="e.issues.count > 0" class="badge failed"
            >问题 {{ e.issues.count }}</span
          >
          <span v-else class="muted">无问题</span>
        </div>
        <div class="cc-line2 muted">
          <span title="评价抽样的成图数 / 该实体本次运行成图总数"
            >成图 {{ e.assetSampled }}/{{ e.assetTotal }}</span
          >
          <span title="评分时该实体启用的分层参考行数"
            >参考 {{ e.refCount }}</span
          >
          <span v-if="e.model" class="mono"
            >{{ e.provider ?? '?' }} / {{ e.model }}</span
          >
          <span>{{ fmtTime(e.evaluatedAt) }}</span>
        </div>
        <div v-if="e.issues.severities.length" class="cc-sevs">
          <span
            v-for="(s, i) in e.issues.severities"
            :key="`sev-${i}`"
            :class="severityClass(s)"
          >
            {{ severityLabel(s) }}
          </span>
        </div>
        <div v-if="e.score === null && e.note" class="cc-note">
          {{ e.note }}
        </div>
        <div v-if="poolGuidance(e)" class="cc-guide">
          <Icon name="alert" :size="12" />
          {{ poolGuidance(e) }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cc {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cc-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cc-head .btn {
  margin-left: auto;
}
.cc-title {
  font-size: 13px;
  font-weight: 600;
}
.cc-scope {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
}
.cc-empty p {
  margin: 6px 0 0;
  font-size: 12px;
}
.cc-row {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  padding: 8px 10px;
}
.cc-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cc-line1 {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.cc-name {
  font-size: 12.5px;
  font-weight: 600;
}
.cc-line2 {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11px;
}
.cc-sevs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.cc-note {
  font-size: 11.5px;
  color: var(--text-2);
  background: var(--panel);
  border-radius: var(--radius-sm);
  padding: 5px 8px;
  word-break: break-all;
}
.cc-guide {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--warn);
  background: var(--warn-weak);
  border-radius: var(--radius-sm);
  padding: 5px 8px;
}
</style>
