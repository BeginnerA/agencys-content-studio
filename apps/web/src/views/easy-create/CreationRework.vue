<script setup lang="ts">
import { computed } from 'vue'
import Icon from '../../components/common/Icon.vue'
import { fmtCost } from '../../lib/format'
import type { CreationReworkTarget } from '../../lib/types'
import type { useEasyCreate } from './use-creation-chat'

/**
 * [M42] 局部返修面板（成果面板内展开，入口独立于消息输入框）。
 * 两步式：解析指令（一次文本模型小额调用、零媒体计费）→ 逐镜「原→新」+ 预估费用 → 显式确认才重置目标镜并续跑。
 * 本组件只呈现服务端解析结果：不本地估算金额、不猜镜头，unclear 时不给可确认的计费出口。
 */
const props = defineProps<{ s: ReturnType<typeof useEasyCreate> }>()
const rw = props.s.rework
const state = rw.state

/** 本模式可落地的侧（服务端已按模式收口：图文成片改画面、动态成片改动态提示词） */
const isImage = (t: CreationReworkTarget) => t.imagePrompt !== null
const fieldOf = (t: CreationReworkTarget) => (isImage(t) ? '画面提示词' : '动态提示词')
const fromOf = (t: CreationReworkTarget) => (isImage(t) ? t.imageFrom : t.motionFrom) ?? ''
const toOf = (t: CreationReworkTarget) => (isImage(t) ? t.imagePrompt : t.motionPrompt) ?? ''
const costOf = (t: CreationReworkTarget) => (isImage(t) ? t.imageCost : t.motionCost)
const costText = (t: CreationReworkTarget) => (costOf(t) === null ? '价格未知' : fmtCost(costOf(t)))

const canParse = computed(
  () => !state.busy && !rw.tooLong.value && state.instruction.trim().length >= rw.minInstruction && rw.canUse.value,
)

async function onParse(): Promise<void> {
  await rw.parse()
}
async function onApply(): Promise<void> {
  await rw.apply()
}
</script>

<template>
  <section v-if="state.open" id="ec-rework" class="ec-rework" aria-label="局部返修">
    <h3 class="ec-rework-title">局部返修：只重做个别镜头</h3>
    <p class="muted">
      写完点「解析返修指令」只会调用一次文本模型定位镜头（计入规划费用），不会启动任何生成；看清预览并确认后才开始重新生成。
    </p>

    <label class="ec-rework-label" for="ec-rework-instruction">想改哪一镜？改成什么样</label>
    <textarea
      id="ec-rework-instruction"
      v-model="state.instruction"
      rows="3"
      :maxlength="rw.maxInstruction"
      :disabled="state.busy"
      placeholder="例：第 2 镜：改成夜晚街景，霓虹反光"
      aria-describedby="ec-rework-hint"
    />
    <p id="ec-rework-hint" class="muted ec-rework-hint">
      新提示词会整体替换原提示词，请把仍需要的主体 / 构图 / 光线 / 风格一并写全。改文案、配音、音乐或整体风格请复制需求重新规划整版。
    </p>
    <p v-if="rw.tooShort.value" class="err-text">返修指令至少 {{ rw.minInstruction }} 字：请写清楚要返修第几镜、改成什么样子。</p>
    <p v-if="rw.tooLong" role="alert" class="err-text">返修指令最多 {{ rw.maxInstruction }} 字，请精简后再解析。</p>

    <div class="ec-rework-rows">
      <button class="btn sm primary" type="button" :disabled="!canParse" @click="onParse">
        <Icon name="wand" :size="13" /> {{ state.busy ? '解析中…' : '解析返修指令' }}
      </button>
      <button class="btn sm" type="button" :disabled="state.busy" @click="rw.close()">收起</button>
      <span v-if="state.busy" role="status" class="muted">正在定位镜头，尚未启动任何生成…</span>
    </div>
    <p v-if="state.error" role="alert" class="err-text">{{ state.error }}</p>

    <div v-if="rw.unclear.value" class="ec-rework-unclear" role="status">
      <Icon name="alert" :size="14" />
      <div>
        <strong>这条指令还没能定位到具体镜头</strong>
        <p>{{ rw.unclear.value }}</p>
      </div>
    </div>

    <div v-else-if="state.preview" class="ec-rework-preview">
      <h4>解析结果 · 确认后才会开始重新生成</h4>
      <ul class="ec-rework-targets">
        <li v-for="t in rw.targets.value" :key="t.shotId">
          <div class="ec-rework-th">
            <span>第 {{ t.index }} 镜 · {{ fieldOf(t) }}</span>
            <span class="badge" :class="{ queued: costOf(t) === null }">{{ costText(t) }}</span>
          </div>
          <p class="ec-rework-from"><span>原</span>{{ fromOf(t) }}</p>
          <p class="ec-rework-to"><span>新</span>{{ toOf(t) }}</p>
        </li>
      </ul>
      <ul v-if="rw.notes.value.length" class="ec-rework-notes">
        <li v-for="(n, i) in rw.notes.value" :key="i">
          <Icon name="alert" :size="12" /> {{ n }}
        </li>
      </ul>
      <p class="ec-rework-estimate">
        预估生成费用 <strong>{{ fmtCost(rw.knownCost.value) }}</strong>
        <span v-if="rw.unpriced.value.length">（另有 {{ rw.unpriced.value.length }} 项价格未知，见下）</span>
      </p>
      <template v-if="rw.unpriced.value.length">
        <ul class="ec-rework-unpriced">
          <li v-for="(u, i) in rw.unpriced.value" :key="i">{{ u }}</li>
        </ul>
        <label class="ec-rework-check">
          <input v-model="state.acceptUnpriced" type="checkbox" />
          我已了解上述生成项价格未知，仍要继续返修
        </label>
      </template>
      <div class="ec-rework-rows">
        <button class="btn sm primary" type="button" :disabled="!rw.confirmable.value" @click="onApply">
          确认返修（将重新生成，可能计费）
        </button>
        <button class="btn sm" type="button" :disabled="state.busy" @click="rw.close()">先不返修</button>
      </div>
      <p class="muted">
        只重做上面列出的镜头：其它镜头、台词、配音与字幕保持不动；返修完成后成片会自动重新合成（本地合成不再计费）。
      </p>
    </div>
  </section>
</template>

<style scoped>
.ec-rework {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 12px 0 4px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-2);
  min-width: 0;
}

.ec-rework-title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}

.ec-rework h4 {
  margin: 6px 0 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}

.ec-rework p {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}

.ec-rework-label {
  display: block;
  margin-top: 2px;
  color: var(--text-2);
  font-size: 12.5px;
}

.ec-rework textarea {
  font-size: 16px;
  line-height: 1.6;
  min-height: 66px;
}

.ec-rework-hint {
  color: var(--text-3);
}

.ec-rework-rows {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ec-rework-rows .btn {
  min-height: 44px;
}

.ec-rework-unclear {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  background: var(--raised);
  color: var(--text-2);
}

.ec-rework-unclear svg {
  flex: none;
  margin-top: 2px;
  color: var(--warn);
}

.ec-rework-unclear strong {
  font-size: 12.5px;
}

.ec-rework-targets {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ec-rework-targets li {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel);
  min-width: 0;
}

.ec-rework-th {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}

.ec-rework-from,
.ec-rework-to {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin-top: 6px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-2);
}

.ec-rework-from span,
.ec-rework-to span {
  flex: none;
  padding: 1px 5px;
  border-radius: 5px;
  font-size: 10.5px;
  background: var(--raised);
  border: 1px solid var(--border);
  color: var(--text-3);
}

.ec-rework-to {
  color: var(--text);
}

.ec-rework-to span {
  background: var(--accent-weak);
  border-color: rgb(99 102 241 / 34%);
  color: var(--accent-h);
}

.ec-rework-notes,
.ec-rework-unpriced {
  margin: 6px 0 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-2);
}

.ec-rework-notes {
  list-style: none;
  padding-left: 0;
}

.ec-rework-notes svg {
  color: var(--warn);
}

.ec-rework-estimate {
  margin-top: 8px !important;
  font-size: 12.5px !important;
  color: var(--text);
}

.ec-rework-unpriced {
  color: var(--warn);
}

.ec-rework-check {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-2);
  cursor: pointer;
}

.ec-rework-check input {
  width: 16px;
  height: 16px;
  margin-top: 1px;
  accent-color: var(--accent);
}

.ec-rework :is(button, a, textarea, input):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
