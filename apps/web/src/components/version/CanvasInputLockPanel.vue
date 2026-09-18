<script setup lang="ts">
/**
 * [M29·R02] 画布 gen 节点「锁定下次执行输入」控件（三操作分离之锁版）。
 * 仅影响下一次执行的输入选择：把某上游节点贡献的资产固定到指定版本资产（spec.pin 加法字段）。
 * 默认走「最新 / 采纳」；锁定不改选片（adoptedTaskId）、不改内容版本、不触发生成。解除锁定即回落默认。
 */
import { computed, ref, watch } from 'vue'
import type { CanvasDocEdge, CanvasDocNode } from '../../lib/types'
import { canvasLockApi } from '../../lib/api'
import Icon from '../common/Icon.vue'

const props = defineProps<{ node: CanvasDocNode; nodes: CanvasDocNode[]; edges: CanvasDocEdge[] }>()
const emit = defineEmits<{ notice: [msg: string] }>()

interface Candidate { assetId: number; name: string }

const loading = ref(false)
const busyNode = ref<number | null>(null)
const err = ref('')
/** 当前锁定：上游节点 id → 资产 id */
const pins = ref<Record<number, number>>({})
/** 每个上游待锁定的选中资产（默认 = 当前解析资产） */
const selected = ref<Record<number, number>>({})

const incoming = computed(() => props.edges.filter((e) => e.to === props.node.id))

/** 上游节点可锁定的候选资产（gen → 结果画廊 / 当前产物；asset → 该资产；entity/run → 无单资产） */
function candidatesOf(up: CanvasDocNode | undefined): Candidate[] {
  if (!up) return []
  if (up.kind === 'gen' && up.results?.length) {
    const list = up.results
      .filter((r) => r.assetId != null && r.asset)
      .map((r) => ({ assetId: r.assetId, name: r.asset!.name }))
    if (list.length) return list
  }
  if (up.assetId != null) return [{ assetId: up.assetId, name: up.asset?.name ?? `资产 #${up.assetId}` }]
  return []
}

function selectedFor(up: CanvasDocNode, cands: Candidate[]): number | null {
  const pinned = pins.value[up.id]
  if (pinned != null) return pinned
  const sel = selected.value[up.id]
  if (sel != null && cands.some((c) => c.assetId === sel)) return sel
  return up.assetId ?? cands[0]?.assetId ?? null
}

async function loadPins() {
  if (props.node.kind !== 'gen') return
  loading.value = true
  err.value = ''
  try {
    const r = await canvasLockApi.list(props.node.id)
    const map: Record<number, number> = {}
    for (const it of r.items) map[it.upstreamNodeId] = it.assetId
    pins.value = map
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function lock(up: CanvasDocNode, assetId: number | null) {
  if (assetId == null || busyNode.value) return
  busyNode.value = up.id
  err.value = ''
  try {
    const r = await canvasLockApi.lock(props.node.id, up.id, assetId)
    const map: Record<number, number> = {}
    for (const it of r.items) map[it.upstreamNodeId] = it.assetId
    pins.value = map
    emit('notice', `已锁定「${up.title}」下次执行输入`)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busyNode.value = null
  }
}

async function unlock(up: CanvasDocNode) {
  if (busyNode.value) return
  busyNode.value = up.id
  err.value = ''
  try {
    const r = await canvasLockApi.unlock(props.node.id, up.id)
    const map: Record<number, number> = {}
    for (const it of r.items) map[it.upstreamNodeId] = it.assetId
    pins.value = map
    emit('notice', `已解除「${up.title}」锁定，回落最新 / 采纳`)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busyNode.value = null
  }
}

function onPick(up: CanvasDocNode, ev: Event) {
  const v = Number((ev.target as HTMLSelectElement).value)
  selected.value = { ...selected.value, [up.id]: Number.isInteger(v) ? v : -1 }
}

interface LockRow { up: CanvasDocNode; cands: Candidate[]; sel: number | null }
/** 预解析上游：可锁定行（含候选资产与当前选中）+ 无资产可锁定的说明行 */
const resolved = computed(() => {
  const lockable: LockRow[] = []
  const notes: { id: number; title: string }[] = []
  for (const e of incoming.value) {
    const up = props.nodes.find((n) => n.id === e.from)
    const cands = candidatesOf(up)
    if (up && cands.length) lockable.push({ up, cands, sel: selectedFor(up, cands) })
    else notes.push({ id: e.from, title: up?.title ?? `节点 #${e.from}` })
  }
  return { lockable, notes }
})

watch(() => props.node?.id, () => { selected.value = {}; void loadPins() }, { immediate: true })
</script>

<template>
  <section class="sec">
    <div class="sec-h">
      <Icon name="link" :size="12" /> 锁定输入（下次执行）
    </div>
    <p class="hint">默认每次执行使用上游最新 / 采纳产物。锁定后<strong>仅下一次执行</strong>改用选定的历史资产，不改选片、不生成。</p>
    <div v-if="loading" class="muted pad">加载中…</div>
    <div v-else-if="!incoming.length" class="muted pad">无上游连线。</div>
    <ul v-else class="llist">
      <li v-for="row in resolved.lockable" :key="row.up.id" class="lrow">
        <div class="lmain">
          <div class="lname">{{ row.up.title }}</div>
          <div class="lsub">
            <span v-if="pins[row.up.id] != null" class="badge-pinned">已锁定 → #{{ pins[row.up.id] }}</span>
            <span v-else class="muted">跟随最新 / 采纳</span>
          </div>
        </div>
        <select
          class="lsel"
          :value="row.sel ?? undefined"
          :disabled="busyNode === row.up.id"
          @change="onPick(row.up, $event)"
        >
          <option v-for="c in row.cands" :key="c.assetId" :value="c.assetId">{{ c.name }}</option>
        </select>
        <button
          v-if="pins[row.up.id] != null"
          type="button"
          class="btn sm"
          :disabled="busyNode === row.up.id"
          title="解除锁定，回落最新 / 采纳"
          @click="unlock(row.up)"
        >
          解锁
        </button>
        <button
          v-else
          type="button"
          class="btn sm"
          :disabled="busyNode === row.up.id || row.sel == null"
          title="锁定下次执行使用选定资产"
          @click="lock(row.up, row.sel)"
        >
          {{ busyNode === row.up.id ? '处理中…' : '锁定' }}
        </button>
      </li>
      <li v-for="note in resolved.notes" :key="'n' + note.id" class="lnote muted">
        {{ note.title }}：无独立资产可锁定（实体 / 运行按策略注入）
      </li>
    </ul>
    <div v-if="err" class="err-text">{{ err }}</div>
  </section>
</template>

<style scoped>
.sec {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--border);
  padding-top: 10px;
}

.sec-h {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
  letter-spacing: 0.4px;
}

.hint {
  font-size: 11px;
  color: var(--text-3);
  margin: 0;
  line-height: 1.6;
}

.hint strong {
  color: var(--text-2);
}

.pad {
  padding: 6px 2px;
  font-size: 12px;
}

.llist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.lrow {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 5px 8px;
  background: var(--code-bg);
  font-size: 12px;
}

.lmain {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.lname {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lsub {
  font-size: 10.5px;
}

.badge-pinned {
  color: var(--accent);
  font-weight: 600;
}

.lsel {
  flex: none;
  max-width: 120px;
  font-size: 11.5px;
  padding: 4px 6px;
}

.lnote {
  font-size: 11px;
  padding: 3px 2px;
}
</style>
