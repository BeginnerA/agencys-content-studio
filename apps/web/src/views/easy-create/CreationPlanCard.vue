<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from '../../components/common/Icon.vue'
import { fmtCost } from '../../lib/format'
import type { useEasyCreate } from './use-creation-chat'

const props = defineProps<{ s: ReturnType<typeof useEasyCreate> }>()

const detail = computed(() => props.s.state.detail)
const plan = computed(() => detail.value?.session.plan ?? null)
const pf = computed(() => detail.value?.session.preflight ?? null)
const exec = computed(() => pf.value?.execution ?? null)
const est = computed(() => pf.value?.estimate ?? null)

const modeText = computed(() => (plan.value?.mode === 'dynamic' ? '动态视频镜头' : '多图配音（静态画面）'))
const modeHint = computed(() =>
  plan.value?.mode === 'dynamic'
    ? '每条镜头为真实 AI 生成视频；不会静默降级为静态图。'
    : '本模式使用静态画面 + 旁白字幕，非动态视频，已明确标注。',
)
const videoModeText = computed(() => (exec.value?.videoMode === 'i2v' ? '分镜图 → 图生视频' : exec.value?.videoMode === 't2v' ? '文生视频' : '—'))

const providers = computed(() => {
  const e = exec.value
  if (!e) return [] as Array<{ k: string; v: string }>
  const rows: Array<{ k: string; v: string }> = [{ k: '配音', v: `${e.endpoints.audio.provider} · ${e.endpoints.audio.model}` }]
  if (e.endpoints.image) rows.push({ k: '画面', v: `${e.endpoints.image.provider} · ${e.endpoints.image.model}` })
  if (e.endpoints.video) rows.push({ k: '视频', v: `${e.endpoints.video.provider} · ${e.endpoints.video.model}（${videoModeText.value}）` })
  if (pf.value?.planningModel) rows.unshift({ k: '规划', v: `${pf.value.planningModel.provider} · ${pf.value.planningModel.model}` })
  return rows
})

const showScript = ref(false)
const showShots = ref(false)
const acceptUnpriced = ref(false)

const ready = computed(() => !!pf.value?.ready)
const blockers = computed(() => pf.value?.issues ?? [])
// 方案已被确认（进入 started/starting）后本卡只读，旧方案不能再启动
const confirmed = computed(() => !!detail.value && ['starting', 'started'].includes(detail.value.session.status))

async function onConfirm(): Promise<void> {
  await props.s.confirm(acceptUnpriced.value)
  acceptUnpriced.value = false
}
</script>

<template>
  <div v-if="plan" class="card panel">
    <header class="ch">
      <div class="ct">
        <span class="badge" :class="plan.mode === 'dynamic' ? 'running' : 'pending'">{{ modeText }}</span>
        <h2>{{ plan.title }}</h2>
      </div>
      <span v-if="confirmed" class="badge succeeded"><Icon name="check" :size="12" /> 已确认</span>
    </header>

    <p class="sum">{{ plan.summary }}</p>
    <p class="mode-hint"><Icon name="alert" :size="12" /> {{ modeHint }}</p>

    <div class="meta">
      <span class="chip"><Icon name="clock" :size="12" /> {{ plan.duration }} 秒</span>
      <span class="chip">{{ plan.aspectRatio }} 画幅</span>
      <span class="chip">{{ plan.shots.length }} 个镜头</span>
      <span class="chip">{{ plan.language }}</span>
      <span class="chip">{{ plan.style }}</span>
    </div>

    <div class="grid2">
      <div class="box">
        <div class="bl">供应商 / 模型（实际调用，确认即冻结）</div>
        <ul class="prov">
          <li v-for="p in providers" :key="p.k"><b>{{ p.k }}</b><span class="mono">{{ p.v }}</span></li>
        </ul>
      </div>
      <div class="box">
        <div class="bl">费用预估</div>
        <div class="cost">
          <div><span class="cl">已发生规划</span><span class="mono">{{ fmtCost(s.state.detail?.planningUsage.cost ?? 0) }}</span></div>
          <div><span class="cl">预计制作费用</span><span class="mono hi">{{ fmtCost(est?.knownCost ?? 0) }}</span></div>
          <div v-if="est?.imageCount"><span class="cl">静态画面</span><span class="mono">{{ est.imageCount }} 张</span></div>
          <div v-if="est?.videoSeconds"><span class="cl">视频时长</span><span class="mono">{{ est.videoSeconds }} 秒</span></div>
        </div>
        <div v-if="est?.unpriced.length" class="unpriced">
          <Icon name="alert" :size="12" /> 未计价项（不按零元处理）：{{ est.unpriced.join('、') }}
        </div>
      </div>
    </div>

    <div class="fold">
      <button class="lnk" type="button" :aria-expanded="showScript" @click="showScript = !showScript">
        <Icon :name="showScript ? 'chevron-down' : 'chevron-right'" :size="13" /> 旁白脚本
      </button>
      <pre v-if="showScript" class="pre">{{ plan.script }}</pre>
      <button class="lnk" type="button" :aria-expanded="showShots" @click="showShots = !showShots">
        <Icon :name="showShots ? 'chevron-down' : 'chevron-right'" :size="13" /> 分镜（{{ plan.shots.length }} 镜）
      </button>
      <ol v-if="showShots" class="shots">
        <li v-for="sh in plan.shots" :key="sh.id">
          <span class="sidx mono">{{ sh.duration }}s</span>
          <div>
            <div class="sp">画面：{{ sh.image_prompt }}</div>
            <div v-if="plan.mode === 'dynamic'" class="sm">运动：{{ sh.motion_prompt }}</div>
          </div>
        </li>
      </ol>
    </div>

    <div v-if="!ready && blockers.length" class="blockers" role="alert">
      <div class="bt">暂不可开始制作——需先解决：</div>
      <ul>
        <li v-for="(b, i) in blockers" :key="i">{{ b.message }}</li>
      </ul>
      <RouterLink class="btn sm" to="/settings"><Icon name="sliders" :size="13" /> 前往 AI 配置</RouterLink>
    </div>

    <footer v-else-if="!confirmed" class="cf">
      <label v-if="s.hasUnpriced.value" class="acc">
        <input v-model="acceptUnpriced" type="checkbox" /> 我已了解并接受上述未计价项的实际扣费
      </label>
      <button
        class="btn ok big"
        type="button"
        :disabled="s.state.busyAction || (s.hasUnpriced.value && !acceptUnpriced)"
        @click="onConfirm"
      >
        <Icon name="bolt" :size="15" /> {{ s.state.busyAction ? '启动中…' : '按此方案开始制作' }}
      </button>
      <button class="btn sm" type="button" :disabled="s.state.busyAction" @click="s.refreshPreflight()">
        <Icon name="refresh" :size="13" /> 重新预检
      </button>
    </footer>
  </div>
</template>

<style scoped>
.card { padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; }
.ch { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.ct { display: flex; flex-direction: column; gap: 6px; }
.ct .badge { align-self: flex-start; }
.ch h2 { font-size: 17px; margin: 0; font-weight: 700; letter-spacing: 0.2px; }
.sum { margin: 0; color: var(--text-2); font-size: 13.5px; line-height: 1.7; }
.mode-hint { margin: 0; font-size: 12px; color: var(--text-3); display: inline-flex; gap: 5px; align-items: center; }
.mode-hint .ic { color: var(--accent-h); }
.meta { display: flex; flex-wrap: wrap; gap: 7px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.box { background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px; padding: 11px 13px; }
.bl { font-size: 11.5px; color: var(--text-3); margin-bottom: 8px; }
.prov { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 5px; }
.prov li { display: flex; gap: 8px; font-size: 12.5px; }
.prov b { color: var(--text-2); font-weight: 500; flex: none; width: 34px; }
.prov .mono { color: var(--text); word-break: break-all; }
.cost { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; }
.cost > div { display: flex; justify-content: space-between; gap: 10px; }
.cl { color: var(--text-2); }
.hi { color: #a5b4fc; font-weight: 600; }
.unpriced { margin-top: 8px; font-size: 11.5px; color: var(--warn); display: flex; gap: 5px; align-items: flex-start; }
.fold { display: flex; flex-direction: column; gap: 4px; }
.lnk { display: inline-flex; align-items: center; gap: 4px; background: none; border: none; color: var(--text-2); cursor: pointer; font-size: 12.5px; padding: 3px 0; text-align: left; }
.lnk:hover { color: #fff; }
.pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font-size: 12.5px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; color: var(--text); margin: 2px 0 8px; }
.shots { margin: 2px 0 4px; padding-left: 2px; list-style: none; display: flex; flex-direction: column; gap: 8px; }
.shots li { display: flex; gap: 10px; font-size: 12.5px; align-items: flex-start; }
.sidx { flex: none; width: 38px; color: var(--run); }
.sp { color: var(--text); }
.sm { color: var(--text-3); margin-top: 2px; }
.blockers { border: 1px solid rgb(248 113 113 / 32%); background: var(--bad-weak); border-radius: 10px; padding: 11px 13px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.bt { color: var(--bad); font-size: 13px; font-weight: 600; }
.blockers ul { margin: 0; padding-left: 18px; color: var(--text-2); font-size: 12.5px; line-height: 1.7; }
.cf { display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--border); padding-top: 12px; }
.acc { font-size: 12.5px; color: var(--warn); display: flex; gap: 7px; align-items: center; }
.big { align-self: flex-start; padding: 9px 20px; font-size: 14px; }
@media (max-width: 640px) {
  .grid2 { grid-template-columns: 1fr; }
}
</style>
