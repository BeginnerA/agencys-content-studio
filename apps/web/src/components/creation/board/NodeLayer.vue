<script setup lang="ts">
/**
 * [M28] 创作画布节点层（自 CreationBoard.vue 整块迁移：节点卡 v-for + 端口 + 状态徽标）
 * —— 指针事件转发父级处理（node-pointerdown / out-pointerdown），保持原交互语义
 */
import type { CanvasDocNode } from '../../../lib/types'
import Icon from '../../common/Icon.vue'
import {
  PORT_TEXT,
  inputPortsOf,
  hasOutPort,
  genIcon,
  isAudio,
  isLlm,
  isTextAsset,
  specLine,
  promptTitle,
  textBody,
  kindText,
  thumbOf,
  entityThumb,
  metaText,
  stText,
  stCls,
  runText,
  runCls,
} from './internals'

const props = defineProps<{
  renderNodes: CanvasDocNode[]
  selectedIds: number[]
  hotPort: string | null
  nodeStyle: (n: CanvasDocNode) => Record<string, string>
  setNodeEl: (id: number, el: unknown) => void
}>()
const emit = defineEmits<{
  'node-pointerdown': [ev: PointerEvent, n: CanvasDocNode]
  'out-pointerdown': [ev: PointerEvent, n: CanvasDocNode]
}>()

// ---- 节点卡类名（自 CreationBoard.vue 逐字迁移；props.selectedIds 语义不变）----
function cardCls(n: CanvasDocNode): Record<string, boolean> {
  const runSt = n.run?.status
  return {
    asset: n.kind === 'asset',
    gen: n.kind === 'gen',
    sel: props.selectedIds.includes(n.id),
    busy: n.status === 'processing' || n.status === 'pending' || runSt === 'running' || runSt === 'queued' || runSt === 'waiting_input',
    bad: n.status === 'failed' || runSt === 'failed',
    ok: n.status === 'succeeded' || runSt === 'completed',
  }
}
</script>

<template>

      <div
        v-for="n in renderNodes"
        :key="n.id"
        :ref="(el) => setNodeEl(n.id, el)"
        class="cnode"
        :class="cardCls(n)"
        :style="nodeStyle(n)"
        :title="n.title"
        @pointerdown="emit('node-pointerdown', $event, n)"
        @dblclick.stop
      >
        <span
          v-for="(p, i) in inputPortsOf(n)"
          :key="p"
          class="port in"
          :class="{ hot: hotPort === `${n.id}:${p}` }"
          :data-in-port="p"
          :data-node-id="n.id"
          :data-port="p"
          :style="{ top: `${46 + i * 22}px` }"
          :title="`输入：${PORT_TEXT[p] ?? p}`"
          @pointerdown.stop
          @dblclick.stop
        />
        <span
          v-if="hasOutPort(n)"
          class="port out"
          :title="'拖拽到目标节点的输入端口以连线'"
          @pointerdown="emit('out-pointerdown', $event, n)"
          @dblclick.stop
        />

        <template v-if="n.kind === 'asset'">
          <div class="cn-media">
            <img v-if="thumbOf(n)" :src="thumbOf(n)!" draggable="false" alt="" loading="lazy" />
            <span v-else class="cn-ph">
              <Icon :name="n.asset?.kind === 'video' ? 'video' : 'photo'" :size="20" />
              <em>{{ n.asset ? n.asset.name : '资产缺失' }}</em>
            </span>
          </div>
          <div class="cn-foot">
            <span v-if="n.seq != null" class="cn-seq">#{{ n.seq }}</span>
            <Icon name="photo" :size="11" />
            <span class="cn-title">{{ n.title }}</span>
          </div>
        </template>

        <template v-else-if="n.kind === 'text'">
          <div class="cn-head">
            <span v-if="n.seq != null" class="cn-seq">#{{ n.seq }}</span>
            <Icon name="doc" :size="13" />
            <span class="cn-title">{{ n.title }}</span>
          </div>
          <div class="cn-prompt">{{ textBody(n) }}</div>
          <div v-if="n.readiness && !n.readiness.ready" class="cn-warn" :title="n.readiness.problems.join('；')">
            <Icon name="alert" :size="11" /> {{ n.readiness.problems.length }} 项未就绪
          </div>
        </template>

        <template v-else-if="n.kind === 'entity'">
          <div class="cn-head">
            <span v-if="n.seq != null" class="cn-seq">#{{ n.seq }}</span>
            <Icon name="users" :size="13" />
            <span class="cn-title">{{ n.title }}</span>
            <span v-if="n.entity" class="cn-kind">{{ kindText(n.entity.kind) }}</span>
          </div>
          <div v-if="entityThumb(n)" class="cn-media">
            <img :src="entityThumb(n)!" draggable="false" alt="" loading="lazy" />
          </div>
          <div class="cn-meta">参考图 {{ n.entity?.refCount ?? 0 }} 张</div>
          <div v-if="n.readiness && !n.readiness.ready" class="cn-warn" :title="n.readiness.problems.join('；')">
            <Icon name="alert" :size="11" /> {{ n.readiness.problems.length }} 项未就绪
          </div>
        </template>

        <template v-else-if="n.kind === 'run'">
          <div class="cn-head">
            <span v-if="n.seq != null" class="cn-seq">#{{ n.seq }}</span>
            <Icon name="play_circle" :size="13" />
            <span class="cn-title">{{ n.title }}</span>
            <span v-if="runText(n)" class="badge" :class="runCls(n)">{{ runText(n) }}</span>
          </div>
          <div class="cn-meta mono">{{ n.run?.templateKey ?? '运行缺失' }}</div>
          <div v-if="n.run" class="cn-meta mono">步骤 {{ n.run.steps.succeeded }}/{{ n.run.steps.total }}</div>
        </template>

        <template v-else>
          <div class="cn-head">
            <span v-if="n.seq != null" class="cn-seq">#{{ n.seq }}</span>
            <Icon :name="genIcon(n)" :size="13" />
            <span class="cn-title">{{ n.title }}</span>
            <span v-if="stText(n)" class="badge" :class="stCls(n)">{{ stText(n) }}</span>
          </div>
          <div class="cn-prompt" :title="promptTitle(n)">{{ specLine(n) }}</div>
          <div v-if="thumbOf(n)" class="cn-media">
            <img :src="thumbOf(n)!" draggable="false" alt="" loading="lazy" />
          </div>
          <div v-else-if="isAudio(n)" class="cn-media cn-audio">
            <Icon name="speaker-wave" :size="18" />
            <em>音频</em>
          </div>
          <div v-else-if="isTextAsset(n) || (isLlm(n) && n.status === 'succeeded')" class="cn-media cn-audio">
            <Icon name="doc" :size="18" />
            <em>文本产物</em>
          </div>
          <div v-if="n.readiness && !n.readiness.ready" class="cn-warn" :title="n.readiness.problems.join('；')">
            <Icon name="alert" :size="11" /> {{ n.readiness.problems.length }} 项未就绪
          </div>
          <div v-else-if="metaText(n)" class="cn-meta mono">{{ metaText(n) }}</div>
          <div v-if="n.latestTask?.errorMsg" class="cn-err" :title="n.latestTask.errorMsg">
            {{ n.latestTask.errorMsg }}
          </div>
        </template>
      </div>
</template>

<style scoped>

/* ---- 节点卡 ---- */
.cnode {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--border-strong);
  border-radius: 10px;
  background: var(--panel);
  color: var(--text);
  cursor: grab;
  transition: border-color 0.15s, box-shadow 0.15s;
  touch-action: none;
}

.cnode:hover {
  border-color: rgb(148 163 184 / 55%);
  box-shadow: 0 6px 16px rgb(0 0 0 / 22%);
}

.cnode.sel {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent);
}

.cnode.busy {
  border-left-color: var(--run);
  animation: cb-pulse 1.6s ease-in-out infinite;
}

.cnode.ok {
  border-left-color: var(--ok);
}

.cnode.bad {
  border-left-color: var(--bad);
}

@keyframes cb-pulse {
  50% {
    box-shadow: 0 0 0 3px rgb(129 140 248 / 16%);
  }
}

.cn-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--text-2);
}

.cn-title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  font-size: 12.5px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cn-head .badge {
  flex: none;
}

/* 故事板序号徽标（[M17] seq） */
.cn-seq {
  flex: none;
  font-size: 10.5px;
  font-weight: 700;
  color: var(--accent-h);
  background: rgb(99 102 241 / 14%);
  border-radius: 5px;
  padding: 1px 5px;
  font-variant-numeric: tabular-nums;
}

/* 实体类型徽标 */
.cn-kind {
  flex: none;
  font-size: 10px;
  color: var(--text-3);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 0 5px;
}

.cn-prompt {
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--text-3);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}

.cn-media {
  height: 88px;
  border-radius: 7px;
  overflow: hidden;
  background: var(--bg);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
}

.cn-media img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* 音频占位（无缩略图） */
.cn-audio {
  flex-direction: column;
  gap: 5px;
  color: var(--text-3);
}

.cn-audio em {
  font-size: 10.5px;
  font-style: normal;
}

.cn-ph {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  color: var(--text-3);
}

.cn-ph em {
  font-size: 10.5px;
  font-style: normal;
  max-width: 180px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cn-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-3);
  min-width: 0;
}

.cn-warn {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--warn);
}

.cn-meta {
  font-size: 10.5px;
  color: var(--text-3);
}

.cn-err {
  font-size: 10.5px;
  color: var(--bad);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---- 端口 ---- */
.port {
  position: absolute;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--panel-2);
  border: 2px solid rgb(148 163 184 / 70%);
  z-index: 2;
}

.port.in {
  left: -7px;
  cursor: crosshair;
}

.port.in:hover,
.port.in.hot {
  border-color: var(--accent-h);
  background: var(--accent-h);
  transform: scale(1.25);
}

.port.out {
  right: -7px;
  top: 50%;
  margin-top: -5px;
  cursor: crosshair;
}

.port.out:hover {
  border-color: var(--ok);
  background: var(--ok);
  transform: scale(1.25);
}
</style>
