<script setup lang="ts">
/**
 * 共用承接预览/冻结面：只读 preview 展示 + 逐项缺口填写理由 + 显式费用同意。
 * 超限（canFreeze=false）必须阻断冻结；「关闭连续性」是显式选择（emit skip，由入口决定语义）。
 * 冻结成功 emit frozen(approval)；调用方（本面板 / 各入口）持有 useContinuityApproval 状态。
 */
import { computed, ref, watch } from 'vue'
import type {
  Acceptance,
  Approval,
  DuplicateCostAcceptance,
} from '../../lib/types/continuity'
import type { ContinuityApprovalState } from '../../composables/use-continuity-approval'

const props = defineProps<{
  state: ContinuityApprovalState
  busyLabel?: string
}>()
const emit = defineEmits<{ frozen: [approval: Approval]; skip: [] }>()

const gapReasons = ref<Record<string, string>>({})
const costConsent = ref(false)

const preview = computed(() => props.state.preview.value)
const overLimit = computed(
  () => preview.value !== null && preview.value.chars > preview.value.maxChars,
)
const unknownUseId = computed(() => preview.value?.unknownUseId ?? null)

const acceptedGaps = computed<Acceptance[]>(() => {
  const gaps = preview.value?.doc.gaps ?? []
  return gaps.map((g) => ({
    key: g.key,
    fingerprint: g.fingerprint,
    reason: gapReasons.value[g.key]?.trim() || '已核对',
  }))
})
const gapsReady = computed(() =>
  (preview.value?.doc.gaps ?? []).every(
    (g) => (gapReasons.value[g.key] ?? '').trim().length > 0,
  ),
)

const duplicateConsent = computed<DuplicateCostAcceptance | null>(() =>
  unknownUseId.value !== null && costConsent.value
    ? { useId: unknownUseId.value, accepted: true }
    : null,
)

const freezeDisabled = computed(
  () =>
    props.state.busy.value ||
    !props.state.canFreeze.value ||
    (preview.value !== null &&
      preview.value.doc.gaps.length > 0 &&
      !gapsReady.value) ||
    (unknownUseId.value !== null && !costConsent.value),
)

watch(preview, () => {
  gapReasons.value = {}
  costConsent.value = false
})

async function doFreeze() {
  const approval = await props.state.freeze(
    acceptedGaps.value,
    duplicateConsent.value ?? undefined,
  )
  if (approval) emit('frozen', approval)
}

function errorText(): string {
  const e = props.state.error.value
  if (!e) return ''
  if (unknownUseId.value !== null)
    return `${e}（存在未知费用遗留 #${unknownUseId.value}，需勾选费用同意后重试）`
  return e
}
</script>

<template>
  <div class="cp-box">
    <div class="cp-head">
      <label class="cp-plans">
        <input
          v-model="state.includePlans.value"
          type="checkbox"
          :disabled="state.busy.value"
        />
        预览含制作计划（plans）
      </label>
      <button class="btn sm" :disabled="state.busy.value" @click="state.load()">
        {{ state.busy.value ? (busyLabel ?? '刷新中…') : '刷新预览' }}
      </button>
    </div>

    <div v-if="state.error.value" class="err-text">{{ errorText() }}</div>
    <div v-else-if="!preview && state.busy.value" class="muted">
      预览生成中…
    </div>
    <div v-else-if="!preview" class="muted">
      尚无预览（选择目标后点「刷新预览」）。
    </div>

    <template v-if="preview">
      <div class="cp-meta">
        <span class="mono"
          >{{ preview.chars }}/{{ preview.maxChars }} 字符</span
        >
        <span v-if="overLimit" class="badge failed"
          >超限，必须精简或关闭连续性</span
        >
        <span v-else-if="preview.canFreeze" class="badge succeeded"
          >可冻结</span
        >
        <span v-else class="badge running">有缺口待处理</span>
      </div>
      <ul v-if="preview.blockers.length" class="cp-blockers">
        <li v-for="(b, i) in preview.blockers" :key="i">{{ b }}</li>
      </ul>
      <pre class="cp-rendered mono">{{ preview.doc.rendered }}</pre>

      <div v-if="preview.doc.gaps.length" class="cp-gaps">
        <div class="cp-sec">
          缺口（{{ preview.doc.gaps.length }}）—— 逐项填写接受理由
        </div>
        <div v-for="g in preview.doc.gaps" :key="g.key" class="cp-gap">
          <span class="mono">#{{ g.unitOrdinal }} {{ g.kind }}</span>
          <input
            v-model="gapReasons[g.key]"
            class="cp-gap-reason"
            :placeholder="
              g.kind === 'missing_entry'
                ? '如：首集无台账，接受'
                : '接受理由（必填）'
            "
          />
        </div>
      </div>

      <label v-if="unknownUseId !== null" class="cp-cost">
        <input v-model="costConsent" type="checkbox" />
        知晓存在未知费用遗留（调用证据 #{{
          unknownUseId
        }}），重跑可能产生重复计费 —— 明确接受
      </label>

      <div class="cp-ops">
        <button
          class="btn primary"
          :disabled="freezeDisabled"
          @click="doFreeze"
        >
          {{ state.busy.value ? '冻结中…' : '冻结承接包' }}
        </button>
        <button class="btn" :disabled="state.busy.value" @click="emit('skip')">
          关闭连续性（本次不用承接包）
        </button>
      </div>
      <div v-if="state.approval.value" class="cp-ok">
        已冻结：approvalHash
        <span class="mono"
          >{{ state.approval.value.approvalHash.slice(0, 16) }}…</span
        >
        <span class="muted">（同目标重复冻结为幂等回放）</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.cp-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cp-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.cp-plans {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}
.cp-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
}
.cp-blockers {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--text-2);
}
.cp-rendered {
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  margin: 0;
}
.cp-sec {
  font-size: 12.5px;
  font-weight: 600;
  margin-bottom: 4px;
}
.cp-gap {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 2px 0;
  font-size: 12px;
}
.cp-gap-reason {
  flex: 1;
  font-size: 12px;
}
.cp-cost {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  font-size: 12.5px;
  color: var(--text-2);
}
.cp-ops {
  display: flex;
  gap: 8px;
}
.cp-ok {
  font-size: 12px;
  color: var(--text-2);
}
</style>
