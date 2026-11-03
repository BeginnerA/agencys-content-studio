<script setup lang="ts">
/**
 * 逐镜取用预览（分层面板的只读子区块）：给定一镜的上下文，问服务端实际会取用哪些参考、
 * 为何回退、为何被裁剪——selected / fallbacks / dropped 三列与 reason 原文全部显式呈现，绝不静默收敛。
 * 纯读：本区块不写任何登记行；切换实体即清空上一次预览，避免把旧实体的结果读成新实体的结论。
 */
import { computed, ref, watch } from 'vue'
import Icon from '../common/Icon.vue'
import {
  entityRefsApi,
  type EntityRefRole,
  type SelectionPreview,
} from '../../lib/api/entityRefs'

const props = defineProps<{
  entityId: number
  /** 分层角色的展示词表（与父面板同一份，避免两处各写一套层名） */
  roleLabels: Record<EntityRefRole, string>
}>()

const scene = ref('')
const episode = ref('')
const text = ref('')
const busy = ref(false)
const errText = ref('')
const result = ref<SelectionPreview | null>(null)

watch(
  () => props.entityId,
  () => {
    result.value = null
    errText.value = ''
  },
)

/** 场次/集数入参校验：留空 = 不带该维度；非整数先本地拦住（与服务端 bad_scene/bad_episode 同口径） */
function parseOptionalInt(raw: string): number | null | 'bad' {
  const s = raw.trim()
  if (!s) return null
  const n = Number(s)
  return Number.isInteger(n) ? n : 'bad'
}

/** 三列统一渲染结构：selected/dropped 同构（带层名与资产 id）；fallbacks 服务端已是整句留痕文本 */
const columns = computed(() => {
  const p = result.value
  if (!p) return []
  return [
    {
      cls: 'ok-t',
      label: `入选 ${p.selected.length}`,
      empty: '本上下文无可入选参考',
      rows: p.selected.map((s) => ({
        tag: props.roleLabels[s.role],
        id: s.assetId,
        why: s.reason,
      })),
    },
    {
      cls: 'warn-t',
      label: `回退 ${p.fallbacks.length}`,
      empty: '无回退',
      rows: p.fallbacks.map((f) => ({ tag: '', id: 0, why: f })),
    },
    {
      cls: 'bad-t',
      label: `裁剪 ${p.dropped.length}`,
      empty: '无裁剪',
      rows: p.dropped.map((d) => ({
        tag: props.roleLabels[d.role],
        id: d.assetId,
        why: d.reason,
      })),
    },
  ]
})

async function run(): Promise<void> {
  errText.value = ''
  const sc = parseOptionalInt(scene.value)
  if (sc === 'bad') {
    errText.value = '场次需为整数（如 5），留空表示不带场次上下文'
    return
  }
  const ep = parseOptionalInt(episode.value)
  if (ep === 'bad') {
    errText.value = '集数需为整数（如 2），留空表示不带集上下文'
    return
  }
  busy.value = true
  try {
    result.value = await entityRefsApi.preview(props.entityId, {
      scene: sc ?? undefined,
      episode: ep ?? undefined,
      text: text.value.trim() || undefined,
    })
  } catch (e) {
    result.value = null
    errText.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="pvbox">
    <div class="grp-h">
      <Icon name="eye" :size="12" />
      <span class="grp-t">选择预览</span>
      <span class="muted hint">模拟一镜实际取用哪些参考、为何回退/裁剪</span>
    </div>
    <div class="addrow">
      <input
        v-model="scene"
        type="text"
        inputmode="numeric"
        class="agrow"
        placeholder="场次（可空）"
        aria-label="场次"
      />
      <input
        v-model="episode"
        type="text"
        inputmode="numeric"
        class="agrow"
        placeholder="集数（可空）"
        aria-label="集数"
      />
      <input
        v-model="text"
        type="text"
        class="agrow pvtext"
        placeholder="画面文本（命中状态定位词，可空）"
        aria-label="画面文本"
      />
      <button class="btn sm" :disabled="busy" @click="run">
        <Icon name="search" :size="11" /> {{ busy ? '预览中…' : '预览' }}
      </button>
    </div>
    <div v-if="errText" class="err-text">{{ errText }}</div>
    <div v-for="col in columns" :key="col.label" class="pvcol">
      <span class="pvt" :class="col.cls">{{ col.label }}</span>
      <div v-if="!col.rows.length" class="muted pvl">{{ col.empty }}</div>
      <div v-for="(l, i) in col.rows" :key="i" class="pvl">
        <span v-if="l.tag" class="chip">{{ l.tag }}</span>
        <span v-if="l.id">#{{ l.id }}</span>
        <span class="muted">{{ l.why }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pvbox {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-top: 7px;
  border-top: 1px dashed var(--border);
}
.grp-h {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-2);
}
.grp-t {
  font-weight: 600;
  color: var(--text);
}
.hint {
  font-size: 11px;
}
.addrow {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.agrow {
  font-size: 12px;
  padding: 4px 7px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  min-width: 0;
  max-width: 220px;
}
.pvtext {
  flex: 1;
}
.pvcol {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  background: var(--panel);
}
.pvt {
  font-size: 11.5px;
  font-weight: 600;
}
.ok-t {
  color: var(--ok);
}
.warn-t {
  color: var(--warn);
}
.bad-t {
  color: var(--bad);
}
.pvl {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 11.5px;
  word-break: break-all;
}
</style>
