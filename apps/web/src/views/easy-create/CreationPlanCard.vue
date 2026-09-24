<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from '../../components/common/Icon.vue'
import { PROJECT_GENRES } from '../../lib/scene'
import { fmtCost } from '../../lib/format'
import type { useEasyCreate } from './use-creation-chat'
import PlanRefs from './PlanRefs.vue'
import CreationStartupOptions from './CreationStartupOptions.vue'
import CreationDialogueCast from './CreationDialogueCast.vue'

const props = defineProps<{ s: ReturnType<typeof useEasyCreate> }>()

const detail = computed(() => props.s.state.detail)
const plan = computed(() => detail.value?.session.plan ?? null)
const pf = computed(() => detail.value?.session.preflight ?? null)
const exec = computed(() => pf.value?.execution ?? null)
const est = computed(() => pf.value?.estimate ?? null)

// 已采纳参考素材（来自服务端编译的 plan.refs）
const refs = computed(() => plan.value?.refs ?? [])

const modeText = computed(() =>
  plan.value?.performance === 'dialogue'
    ? '人物原生对白（动态视频）'
    : plan.value?.mode === 'dynamic'
      ? '动态视频镜头'
      : '多图配音（静态画面）',
)
const modeHint = computed(() =>
  plan.value?.performance === 'dialogue'
    ? '人物在剧情内以原生音画开口交谈，台词随实际音轨逐镜转写为字幕；不使用旁白配音或多角色朗读冒充对白。'
    : plan.value?.mode === 'dynamic'
      ? '每条镜头为真实 AI 生成视频；不会静默降级为静态图。'
      : '本模式使用静态画面 + 旁白字幕，非动态视频，已明确标注。',
)
const scriptLabel = computed(() =>
  plan.value?.performance === 'dialogue' ? '台词/脚本' : '旁白脚本',
)
const videoModeText = computed(() =>
  exec.value?.videoMode === 'i2v'
    ? '分镜图 → 图生视频'
    : exec.value?.videoMode === 't2v'
      ? '文生视频'
      : '—',
)

const providers = computed(() => {
  const e = exec.value
  if (!e) return [] as Array<{ k: string; v: string }>
  const dialogue = plan.value?.performance === 'dialogue'
  const rows: Array<{ k: string; v: string }> = []
  // 对白无独立 TTS 配音端点：不展示虚构的「配音」行，改展示严格逐镜原声转写（ASR）端点
  if (dialogue) {
    if (e.asr)
      rows.push({ k: '原声转写核验', v: `${e.asr.provider} · ${e.asr.model}` })
  } else if (e.endpoints.audio) {
    rows.push({
      k: '配音',
      v: `${e.endpoints.audio.provider} · ${e.endpoints.audio.model}`,
    })
  }
  if (e.endpoints.image)
    rows.push({
      k: '画面',
      v: `${e.endpoints.image.provider} · ${e.endpoints.image.model}`,
    })
  if (e.endpoints.video)
    rows.push({
      k: dialogue ? '原生对白视频' : '视频',
      v: `${e.endpoints.video.provider} · ${e.endpoints.video.model}（${videoModeText.value}）`,
    })
  if (pf.value?.planningModel)
    rows.unshift({
      k: '规划',
      v: `${pf.value.planningModel.provider} · ${pf.value.planningModel.model}`,
    })
  return rows
})

const showScript = ref(false)
const showShots = ref(false)
const acceptUnpriced = ref(false)
// 启动方式选项（审阅闸 + 画质 + 品牌）收敛进 CreationStartupOptions（令本卡守 ≤800 行）；父持模板 ref，confirm 时读回三值
const optBox = ref<InstanceType<typeof CreationStartupOptions> | null>(null)

const ready = computed(() => !!pf.value?.ready)
const blockers = computed(() => pf.value?.issues ?? [])
// 方案已被确认（进入 started/starting）后本卡只读，旧方案不能再启动
const confirmed = computed(
  () =>
    !!detail.value &&
    ['starting', 'started'].includes(detail.value.session.status),
)

// ===== 「将创建的项目」：默认智能填写，确认前可逐项覆盖；点开始制作才真正立项 =====
const proj = computed(() => detail.value?.session.project ?? null)
const showProject = computed(() => !!proj.value?.isDraft && !confirmed.value)
// [简化] 不提供「默认模板」设置项：轻松创作出片模板由服务端 recipe 固定，项目默认模板已按载体自动派生，
// 需要调整可到项目编辑页修改（此页用户无专业模板心智，下拉只是噪声）。
/** 任一字段的本地编辑都要置 dirty，阻止后续服务端回读冲掉正在输入的内容 */
function touchProject(): void {
  props.s.projectDraft.dirty = true
}

async function onConfirm(): Promise<void> {
  await props.s.confirm(
    acceptUnpriced.value,
    optBox.value?.reviewGate ?? false,
    optBox.value?.resolution || undefined,
    optBox.value?.brandApply ?? true,
  )
  acceptUnpriced.value = false
}
</script>

<template>
  <div v-if="plan" class="card panel">
    <header class="ch">
      <div class="ct">
        <span
          class="badge"
          :class="plan.mode === 'dynamic' ? 'running' : 'pending'"
          >{{ modeText }}</span
        >
        <h2>{{ plan.title }}</h2>
      </div>
      <span v-if="confirmed" class="badge succeeded">
        <Icon name="check" :size="12" /> 已确认
      </span>
    </header>

    <p class="sum">{{ plan.summary }}</p>
    <p class="mode-hint"><Icon name="alert" :size="12" /> {{ modeHint }}</p>

    <div class="meta">
      <span class="chip">
        <Icon name="clock" :size="12" /> {{ plan.duration }} 秒
      </span>
      <span class="chip">{{ plan.aspectRatio }} 画幅</span>
      <span class="chip">{{ plan.shots.length }} 个镜头</span>
      <span class="chip">{{ plan.language }}</span>
      <span class="chip chip-style">{{ plan.style }}</span>
      <span v-if="refs.length" class="chip ref-chip">
        <Icon name="photo" :size="12" /> {{ refs.length }} 项参考
      </span>
    </div>

    <CreationDialogueCast v-if="plan.performance === 'dialogue' && plan" :plan="plan" />

    <div class="sections">
      <div class="sec">
        <div class="sh">
          <Icon name="cog" :size="13" /> 供应商 / 模型<span class="sh-hint"
            >实际调用 · 确认即冻结</span
          >
        </div>
        <ul class="prov">
          <li v-for="p in providers" :key="p.k">
            <span class="pk">{{ p.k }}</span
            ><span class="pv mono">{{ p.v }}</span>
          </li>
        </ul>
      </div>
      <div class="sec">
        <div class="sh"><Icon name="chart" :size="13" /> 费用预估</div>
        <div class="cost">
          <div>
            <span class="cl">已发生规划</span
            ><span class="mono">{{
              fmtCost(s.state.detail?.planningUsage.cost ?? 0)
            }}</span>
          </div>
          <div class="cost-main">
            <span class="cl">预计制作费用</span
            ><span class="mono hi">{{ fmtCost(est?.knownCost ?? 0) }}</span>
          </div>
          <div v-if="est?.imageCount">
            <span class="cl">静态画面</span
            ><span class="mono">{{ est.imageCount }} 张</span>
          </div>
          <div v-if="est?.videoSeconds">
            <span class="cl">视频时长</span
            ><span class="mono">{{ est.videoSeconds }} 秒</span>
          </div>
        </div>
        <div v-if="est?.unpriced.length" class="unpriced">
          <Icon name="alert" :size="12" />
          <span>未计价项（不按零元处理）：{{ est.unpriced.join('、') }}</span>
        </div>
      </div>
    </div>

    <div v-if="showProject && proj" class="project">
      <div class="bl">
        <Icon name="folder" :size="13" /> 将创建的项目
        <span class="bl-hint muted"
          >默认已按方案智能填写 —— 点「开始制作」时才立项，在此之前不进项目列表；任何一项都可改</span
        >
      </div>
      <div class="pj-grid">
        <label class="pj-f"
          ><span>名称</span>
          <input
            v-model="s.projectDraft.name"
            type="text"
            :maxlength="60"
            placeholder="项目名称"
            @input="touchProject"
          />
        </label>
        <label class="pj-f"
          ><span>载体</span>
          <select v-model="s.projectDraft.genre" @change="touchProject">
            <option v-for="g in PROJECT_GENRES" :key="g.value" :value="g.value">
              {{ g.label }}
            </option>
          </select>
        </label>
        <label class="pj-f pj-wide"
          ><span>标签</span>
          <input
            v-model="s.projectDraft.tagsText"
            type="text"
            placeholder="多个标签用逗号分隔，≤ 6 个"
            @input="touchProject"
          />
        </label>
        <label class="pj-f pj-wide"
          ><span>简介</span>
          <textarea
            v-model="s.projectDraft.brief"
            rows="2"
            :maxlength="500"
            placeholder="项目简介（默认取方案摘要）"
            @input="touchProject"
          />
        </label>
      </div>
      <p class="pj-note muted">
        <Icon name="alert" :size="11" />
        确认时才会创建项目并出现在项目列表；非法值（如超字数）会回落平台校验的合理值并在对话中说明，不阻断制作。
      </p>
    </div>

    <PlanRefs
      v-if="refs.length"
      :refs="refs"
      :video-analysis-count="est?.videoAnalysisCount ?? 0"
    />

    <div class="fold">
      <button
        class="lnk"
        type="button"
        :aria-expanded="showScript"
        @click="showScript = !showScript"
      >
        <Icon
          :name="showScript ? 'chevron-down' : 'chevron-right'"
          :size="13"
        />
        {{ scriptLabel }}
      </button>
      <pre v-if="showScript" class="pre">{{ plan.script }}</pre>
      <button
        class="lnk"
        type="button"
        :aria-expanded="showShots"
        @click="showShots = !showShots"
      >
        <Icon :name="showShots ? 'chevron-down' : 'chevron-right'" :size="13" />
        分镜（{{ plan.shots.length }} 镜）
      </button>
      <ol v-if="showShots" class="shots">
        <li v-for="sh in plan.shots" :key="sh.id">
          <span class="sidx mono">{{ sh.duration }}s</span>
          <div>
            <div class="sp">画面：{{ sh.image_prompt }}</div>
            <div v-if="plan.mode === 'dynamic'" class="sm">
              运动：{{ sh.motion_prompt }}
            </div>
          </div>
        </li>
      </ol>
    </div>

    <div v-if="!ready && blockers.length" class="blockers" role="alert">
      <div class="bt">暂不可开始制作——需先解决：</div>
      <ul>
        <li v-for="(b, i) in blockers" :key="i">{{ b.message }}</li>
      </ul>
      <div class="bx-actions">
        <RouterLink class="btn sm" to="/settings">
          <Icon name="sliders" :size="13" /> 前往 AI 配置
        </RouterLink>
        <button
          class="btn sm"
          type="button"
          :disabled="s.state.busyAction"
          @click="s.refreshPreflight()"
        >
          <Icon name="refresh" :size="13" />
          {{ s.state.busyAction ? '预检中…' : '重新预检' }}
        </button>
      </div>
      <span class="bx-tip"
        >改好 AI
        配置（如视频能力声明）后点「重新预检」刷新——仅重算，不计费、不启动制作</span
      >
    </div>

    <footer v-else-if="!confirmed" class="cf">
      <CreationStartupOptions ref="optBox" :pf="pf" :plan="plan" />
      <label v-if="s.hasUnpriced.value" class="acc">
        <input v-model="acceptUnpriced" type="checkbox" />
        我已了解并接受上述未计价项的实际扣费
      </label>
      <button
        class="btn ok big"
        type="button"
        :disabled="
          s.state.busyAction || (s.hasUnpriced.value && !acceptUnpriced)
        "
        @click="onConfirm"
      >
        <Icon name="bolt" :size="15" />
        {{ s.state.busyAction ? '启动中…' : '按此方案开始制作' }}
      </button>
      <button
        class="btn sm"
        type="button"
        :disabled="s.state.busyAction"
        @click="s.refreshPreflight()"
      >
        <Icon name="refresh" :size="13" /> 重新预检
      </button>
    </footer>
  </div>
</template>

<style scoped>
.card {
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 13px;
  background:
    linear-gradient(180deg, rgb(99 102 241 / 6%), transparent 30%), var(--panel);
}

.ch {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.ct {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}

.ct .badge {
  align-self: flex-start;
}

.ch h2 {
  font-size: 18px;
  margin: 0;
  font-weight: 700;
  letter-spacing: 0.2px;
  line-height: 1.35;
  color: var(--text);
}

.sum {
  margin: 0;
  color: var(--text-2);
  font-size: 13.5px;
  line-height: 1.75;
}

.mode-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
  display: inline-flex;
  gap: 5px;
  align-items: flex-start;
  line-height: 1.5;
}

.mode-hint .ic {
  color: var(--accent-h);
  flex: none;
  margin-top: 2px;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

/* 全局 .chip 为 nowrap：短标签无碍，但风格描述是整句长文本，nowrap 会把卡片横向撑爆（小屏页面出现水平滚动、内容错位裁切） */
.meta .chip {
  max-width: 100%;
}

.chip-style {
  white-space: normal;
  word-break: break-word;
  line-height: 1.6;
  border-radius: 12px; /* 换行后胶囊 999px 圆角会吃掉文字，改小圆角 */
}

/* ---------- 分区（供应商 / 费用） ---------- */
.sections {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sec {
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 11px;
  padding: 12px 14px;
}

.sh {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 10px;
}

.sh .ic {
  color: var(--accent-h);
}

.sh-hint {
  margin-left: auto;
  font-size: 11px;
  font-weight: 400;
  color: var(--text-3);
}

.prov {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.prov li {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 12.5px;
}

.pk {
  flex: none;
  width: 38px;
  color: var(--text-3);
}

.pv {
  flex: 1;
  min-width: 0;
  color: var(--text);
  word-break: break-all;
  line-height: 1.5;
}

.cost {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 12.5px;
}

.cost > div {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
}

.cl {
  color: var(--text-2);
}

.cost-main {
  padding-top: 8px;
  margin-top: 1px;
  border-top: 1px dashed var(--border-strong);
}

.cost-main .cl {
  color: var(--text);
  font-weight: 500;
}

.hi {
  color: #a5b4fc;
  font-weight: 700;
  font-size: 14px;
}

.unpriced {
  margin-top: 10px;
  font-size: 11.5px;
  color: var(--warn);
  display: flex;
  gap: 6px;
  align-items: flex-start;
  line-height: 1.5;
}

.unpriced .ic {
  flex: none;
  margin-top: 1px;
}

.fold {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-top: 1px solid var(--border);
  padding-top: 10px;
}

.lnk {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: none;
  border: none;
  color: var(--text-2);
  cursor: pointer;
  font-size: 13px;
  padding: 4px 0;
  text-align: left;
  font-weight: 500;
}

.lnk:hover {
  color: #fff;
}

.pre {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 11px 13px;
  font-size: 12.5px;
  line-height: 1.75;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
  margin: 3px 0 9px;
}

.shots {
  margin: 3px 0 4px;
  padding-left: 2px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.shots li {
  display: flex;
  gap: 10px;
  font-size: 12.5px;
  align-items: flex-start;
}

.sidx {
  flex: none;
  width: 38px;
  color: var(--run);
}

.sp {
  color: var(--text);
  line-height: 1.6;
}

.sm {
  color: var(--text-3);
  margin-top: 2px;
  line-height: 1.6;
}

.blockers {
  border: 1px solid rgb(248 113 113 / 32%);
  background: var(--bad-weak);
  border-radius: 11px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  align-items: flex-start;
}

.bt {
  color: var(--bad);
  font-size: 13px;
  font-weight: 600;
}

.blockers ul {
  margin: 0;
  padding-left: 18px;
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.75;
}

.bx-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.bx-tip {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.5;
}

.cf {
  display: flex;
  flex-direction: column;
  gap: 11px;
  border-top: 1px solid var(--border);
  padding-top: 13px;
}

.acc {
  font-size: 12.5px;
  color: var(--warn);
  display: flex;
  gap: 7px;
  align-items: center;
  line-height: 1.5;
}

.big {
  align-self: stretch;
  justify-content: center;
  padding: 11px 20px;
  font-size: 14.5px;
  font-weight: 600;
}

.ref-chip {
  color: #a5b4fc;
  border-color: rgb(99 102 241 / 45%);
  background: var(--accent-weak);
}

/* ---------- 将创建的项目（立项预览 + 可覆盖） ---------- */
.project {
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 11px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.project > .bl {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-2);
  font-weight: 600;
}

.project > .bl .ic {
  color: var(--accent-h);
  align-self: center;
}

.bl-hint {
  font-size: 11px;
  font-weight: 400;
  line-height: 1.5;
}

.pj-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px 12px;
}

.pj-wide {
  grid-column: 1 / -1;
}

.pj-f {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.pj-f > span {
  font-size: 11.5px;
  color: var(--text-3);
}

.pj-f input,
.pj-f select,
.pj-f textarea {
  font-size: 12.5px;
  border-radius: 8px;
}

.pj-f textarea {
  resize: vertical;
  line-height: 1.6;
}

.pj-note {
  margin: 0;
  font-size: 11.5px;
  display: flex;
  gap: 5px;
  align-items: flex-start;
  line-height: 1.5;
}

.pj-note .ic {
  color: var(--warn);
  flex: none;
  margin-top: 2px;
}

@media (max-width: 560px) {
  .pj-grid {
    grid-template-columns: 1fr;
  }
}
</style>
