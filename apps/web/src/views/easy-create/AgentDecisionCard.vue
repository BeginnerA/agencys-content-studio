<script setup lang="ts">
/**
 * Agent 调度决策确认卡（M63 切片 5）：服务端 sideCards 下发 key='decisionCard' 时渲染（route 形态待确认态）。
 * 呈现「谁点的将 · 打算怎么做 · 为什么 · 具体执行体预览」，确认按钮走 s.confirmRoute（decisionHash+decisionRevision 闸）。
 * 与 easy 的 CreationPlanCard 分列：easy 有逐镜方案 + recipe 冻结，route 只读预览服务端归一后的权威决策，不臆造成本明细（金额在 confirm 时按物化输入最终核算）。
 * 角色名从服务端随消息下发的 agentRole→roleName 派生（后端注册表为真源，前端不硬编码角色名）。
 */
import { computed } from 'vue'
import Icon from '../../components/common/Icon.vue'
import type { useEasyCreate } from './use-creation-chat'
import type { AgentDecisionView, InputSpecView } from '../../lib/types'

const props = defineProps<{ s: ReturnType<typeof useEasyCreate>; confirmable?: boolean }>()

const session = computed(() => props.s.state.detail?.session ?? null)
const decision = computed<AgentDecisionView | null>(() => session.value?.decision ?? null)
const busy = computed(() => props.s.state.busyAction)
// confirmable 优先取服务端下发的卡片 props（= status ready 且预检 ready）；缺省时按 ready + 有 decisionHash 兜底判定
const canConfirm = computed(
  () =>
    props.confirmable ??
    (session.value?.status === 'ready' && !!session.value?.decisionHash),

)
const modeText = computed(() => {
  switch (decision.value?.mode) {
    case 'template': return '命中专业模板'
    case 'chain': return '多步执行链'
    case 'synth': return '临时编排（未命中既有模板，智能合成）'
    case 'easy': return '单条成片'
    default: return '执行计划'
  }
})

/** 角色名：扫描消息中带同 agentRole 的 roleName（服务端注册表投影）；找不到回落 key 本身，不伪装 */
function roleName(key?: string | null): string {
  if (!key) return '智能助手'
  const hit = (props.s.state.detail?.messages ?? []).find((m) => m.agentRole === key)
  return hit?.roleName || key
}
const speakerName = computed(() => roleName(decision.value?.roleKey))
const teamNames = computed(() => (decision.value?.team ?? []).map((t) => `${roleName(t.roleKey)}｜${t.stage}`))

/** inputSpec 摘要：逐字段展示来源kind + 可读值（只读预览，用户可在对话中改需求重新规划） */
const specRows = (spec?: Record<string, InputSpecView> | null): Array<{ field: string; text: string }> =>
  Object.entries(spec ?? {}).map(([field, item]) => {
    let text: string
    switch (item.kind) {
      case 'text': text = String(item.value ?? ''); break
      case 'number': text = String(item.value ?? ''); break
      case 'boolean': text = item.value ? '是' : '否'; break
      case 'asset': text = `素材 #${item.assetId ?? '?'}`; break
      case 'assets': text = `素材 ${(item.assetIds ?? []).map((x) => `#${x}`).join('、')}`; break
      case 'prev': text = `上游产物 ${item.ref ?? ''}`; break
      case 'default': text = '（用默认值）'; break
      default: text = '—'
    }
    return { field, text }
  })

const templateKey = computed(() => decision.value?.templateRun?.templateKey ?? null)
const templateSpecs = computed(() => specRows(decision.value?.templateRun?.inputSpec))
const chainSegs = computed(() => decision.value?.chain ?? [])
const synth = computed(() => decision.value?.synth ?? null)
const synthSpecs = computed(() => specRows(decision.value?.synth?.inputSpec))

async function onConfirm(): Promise<void> {
  await props.s.confirmRoute()
}
</script>

<template>
  <div v-if="decision" class="card panel" aria-label="执行计划">
    <header class="ph">
      <h2><Icon name="compass" :size="16" /> {{ modeText }}</h2>
      <span class="who-badge">{{ speakerName }}</span>
    </header>

    <p class="rationale">{{ decision.rationale }}</p>

    <!-- template：目标模板 + 输入物化预览 -->
    <div v-if="decision.mode === 'template' && decision.templateRun" class="blk">
      <div class="blk-h">执行模板</div>
      <code class="tk">{{ templateKey }}</code>
      <ul v-if="templateSpecs.length" class="spec">
        <li v-for="r in templateSpecs" :key="r.field"><span class="f">{{ r.field }}</span>{{ r.text }}</li>
      </ul>
    </div>

    <!-- synth：临时模板 + 步数 -->
    <div v-else-if="decision.mode === 'synth' && synth" class="blk">
      <div class="blk-h">临时编排模板</div>
      <p class="synth-n">{{ synth.name }} · {{ synth.stepCount }} 步</p>
      <code class="tk">{{ synth.templateKey }}</code>
      <ul v-if="synthSpecs.length" class="spec">
        <li v-for="r in synthSpecs" :key="r.field"><span class="f">{{ r.field }}</span>{{ r.text }}</li>
      </ul>
      <p class="hint">临时模板仅本会话可见，随会话删除自动回收。</p>
    </div>

    <!-- chain：段序列预览 -->
    <div v-else-if="decision.mode === 'chain'" class="blk">
      <div class="blk-h">执行链（{{ chainSegs.length }} 段）</div>
      <ol class="chain">
        <li v-for="(seg, i) in chainSegs" :key="i">
          <span class="idx">{{ i + 1 }}</span>
          <div class="seg"><b>{{ seg.title }}</b><code>{{ seg.templateKey }}</code></div>
        </li>
      </ol>
      <p class="hint">段间将暂停回到对话请求你的批准（安全默认，不自动级联计费）。</p>
    </div>

    <!-- 编队 -->
    <div v-if="teamNames.length" class="blk">
      <div class="blk-h">智能编队</div>
      <ul class="team"><li v-for="(t, i) in teamNames" :key="i">{{ t }}</li></ul>
    </div>

    <!-- 越界升级建议 / 能力回落说明（可见不静默） -->
    <div v-if="decision.escalateTo" class="note warn">
      <Icon name="alert" :size="13" /> 建议改用「{{ decision.escalateTo.templateKey }}」：{{ decision.escalateTo.reason }}
    </div>
    <div v-for="n in decision.capabilityNotes ?? []" :key="n" class="note">
      <Icon name="info" :size="13" /> {{ n }}
    </div>

    <footer class="pf">
      <button class="btn primary" type="button" :disabled="!canConfirm || busy" @click="onConfirm">
        <Icon name="check" :size="13" /> {{ busy ? '启动中…' : '确认执行计划' }}
      </button>
      <button class="btn sm ghost" type="button" :disabled="busy" @click="s.refreshPreflight()">
        <Icon name="refresh" :size="13" /> 更新预检
      </button>
    </footer>
    <small v-if="!canConfirm" class="muted">执行计划尚不可确认（配置待完善或已过时），请在左侧继续对话重新规划或点「更新预检」。</small>
    <small v-else class="muted">确认后才立项并启动制作，可能产生媒体费用。</small>
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
  gap: 8px;
}
.ph h2 {
  font-size: 15px;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 700;
}
.ph h2 .ic { color: var(--accent-h); }
.who-badge {
  font-size: 11.5px;
  color: var(--accent-h);
  background: var(--accent-weak);
  border: 1px solid rgb(99 102 241 / 30%);
  border-radius: 999px;
  padding: 2px 10px;
  white-space: nowrap;
}
.rationale {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
.blk {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.blk-h {
  font-size: 11.5px;
  color: var(--text-3);
  font-weight: 600;
}
.tk {
  align-self: flex-start;
  font-size: 12px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px 8px;
  color: var(--text-2);
  overflow-wrap: anywhere;
}
.synth-n { margin: 0; font-size: 13px; color: var(--text); }
.spec, .team, .chain {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.spec li {
  font-size: 12.5px;
  color: var(--text-2);
  display: flex;
  gap: 8px;
  word-break: break-word;
}
.spec .f {
  color: var(--text);
  font-weight: 600;
  min-width: 90px;
  flex: none;
}
.chain li {
  display: flex;
  gap: 9px;
  align-items: flex-start;
}
.chain .idx {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--accent-weak);
  color: var(--accent-h);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
}
.chain .seg { display: flex; flex-direction: column; gap: 2px; }
.chain .seg b { font-size: 13px; color: var(--text); }
.chain .seg code { font-size: 11.5px; color: var(--text-2); }
.team li { font-size: 12.5px; color: var(--text-2); }
.note {
  display: flex;
  gap: 7px;
  align-items: flex-start;
  font-size: 12.5px;
  color: var(--text-2);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 8px 11px;
}
.note.warn { color: var(--warn); border-color: rgb(245 158 11 / 30%); background: var(--warn-weak); }
.pf {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.hint, .muted { font-size: 11.5px; color: var(--text-3); line-height: 1.6; margin: 0; }
</style>
