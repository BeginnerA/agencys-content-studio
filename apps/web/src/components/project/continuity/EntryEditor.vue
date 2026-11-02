<script setup lang="ts">
/**
 * M70 台账条目编辑器（brief 11.3）：原文/条目并排，可定位 UTF-16 引文；
 * 排除/新增/改写必须留 editNote；空条目要显式勾选 noChanges。
 * 并发 409 由父组件处理：保留本地编辑并提示重新载入，绝不自动覆盖。
 */
import { computed, ref, toRaw, watch } from 'vue'
import type {
  ContinuityItem,
  EntryDoc,
  EntryView,
} from '../../../lib/types/continuity'

const props = defineProps<{ entry: EntryView; sourceText: string }>()
const emit = defineEmits<{ save: [doc: EntryDoc] }>()

/** structuredClone 不接受 Vue 响应式 Proxy，必须先去响应式包装再克隆。 */
function cloneDoc(doc: EntryDoc | null): EntryDoc | null {
  return doc ? structuredClone(toRaw(doc)) : null
}

const doc = ref<EntryDoc | null>(cloneDoc(props.entry.doc))
watch(
  () => props.entry.id + ':' + props.entry.revision,
  () => {
    doc.value = cloneDoc(props.entry.doc)
  },
)
const activeItemId = ref<string | null>(null)
const addOpen = ref(false)

const activeItem = computed<ContinuityItem | null>(
  () => doc.value?.items.find((i) => i.id === activeItemId.value) ?? null,
)

function quoteOf(item: ContinuityItem): string {
  const ev = item.evidence[0]
  if (!ev) return ''
  return props.sourceText.slice(ev.start, ev.end)
}

/** 人工变更必须留说明：排除/改写/新增都会强制 editNote（服务端 superRefine 同口径）。 */
function touch(item: ContinuityItem) {
  if (item.origin === 'extracted') item.origin = 'edited'
  if (!item.editNote.trim()) item.editNote = '人工修订'
}

function excludeItem(item: ContinuityItem) {
  item.included = false
  touch(item)
  if (!item.editNote.trim() || item.editNote === '人工修订')
    item.editNote = '人工排除'
}

function includeItem(item: ContinuityItem) {
  item.included = true
  touch(item)
}

function onEdit(item: ContinuityItem) {
  touch(item)
}

const CHANNELS = ['fact', 'plan', 'knowledge'] as const
const OPERATIONS = ['set', 'close', 'retract'] as const
const newChannel = ref<(typeof CHANNELS)[number]>('fact')
const newTopic = ref('')
const newOperation = ref<(typeof OPERATIONS)[number]>('set')
const newValue = ref('')
const newNote = ref('')
const newKnower = ref('')

function addItem() {
  const d = doc.value
  if (!d || !newTopic.value || !newValue.value.trim() || !newNote.value.trim())
    return
  d.items.push({
    id: `m_${crypto.randomUUID().slice(0, 8)}`,
    topicKey: newTopic.value,
    channel: newChannel.value,
    operation: newOperation.value,
    subjects: d.subjects.length ? [d.subjects[0]!.key] : [],
    value: newValue.value.trim(),
    previous: null,
    evidence: [],
    origin: 'manual',
    editNote: newNote.value.trim(),
    included: true,
    ...(newChannel.value === 'knowledge'
      ? {
          knower: newKnower.value || d.subjects[0]?.key || '',
          epistemic: 'knows' as const,
        }
      : {}),
  })
  newValue.value = ''
  newNote.value = ''
  addOpen.value = false
}

/** 本集无新增变化必须显式（EntryDocSchema: noChanges === items 全部未纳入）。 */
const noChangesOk = computed(() => {
  const d = doc.value
  if (!d) return false
  const included = d.items.some((i) => i.included)
  return included ? !d.noChanges : d.noChanges
})

const manualNotesOk = computed(() =>
  (doc.value?.items ?? []).every(
    (i) => i.origin === 'extracted' || i.editNote.trim().length > 0,
  ),
)

function save() {
  if (!doc.value) return
  emit('save', cloneDoc(doc.value)!)
}
</script>

<template>
  <div v-if="doc" class="ee-box">
    <div class="ee-cols">
      <div class="ee-src">
        <div class="ee-sec">来源原文（所选不可变版本，UTF-16 引文定位）</div>
        <pre class="ee-text mono">{{ sourceText }}</pre>
        <div v-if="activeItem" class="ee-quote">
          <span class="muted">当前条目引文：</span>
          <blockquote>
            {{ quoteOf(activeItem) || '（无引文——人工条目）' }}
          </blockquote>
          <span
            v-for="(ev, i) in activeItem.evidence"
            :key="i"
            class="muted mono ee-ev"
          >
            [{{ ev.start }},{{ ev.end }})
          </span>
        </div>
      </div>
      <div class="ee-items">
        <div class="ee-sec">
          条目（{{ doc.items.filter((i) => i.included).length }}/{{
            doc.items.length
          }}
          纳入）
          <button class="btn sm" @click="addOpen = !addOpen">
            {{ addOpen ? '收起' : '+ 新增' }}
          </button>
        </div>
        <div
          v-for="item in doc.items"
          :key="item.id"
          class="ee-item"
          :class="{ off: !item.included, act: activeItemId === item.id }"
          @click="activeItemId = item.id"
        >
          <div class="ee-item-head">
            <label class="ee-inc">
              <input
                type="checkbox"
                :checked="item.included"
                @change="item.included ? excludeItem(item) : includeItem(item)"
              />
              {{ item.included ? '纳入' : '已排除' }}
            </label>
            <span class="mono ee-keys"
              >#{{ item.topicKey }} · {{ item.channel }} ·
              {{ item.operation }}</span
            >
            <span
              class="badge"
              :class="item.origin === 'extracted' ? '' : 'running'"
            >
              {{
                item.origin === 'extracted'
                  ? '提取'
                  : item.origin === 'manual'
                    ? '人工'
                    : '改写'
              }}
            </span>
          </div>
          <input v-model="item.value" class="ee-val" @input="onEdit(item)" />
          <input
            v-model="item.editNote"
            class="ee-note"
            placeholder="变更说明（人工/改写必填）"
            @input="onEdit(item)"
          />
          <div v-if="item.channel === 'knowledge'" class="ee-know">
            <span class="muted">knower</span>
            <select v-model="item.knower" @change="onEdit(item)">
              <option v-for="s in doc.subjects" :key="s.key" :value="s.key">
                {{ s.label }}
              </option>
            </select>
          </div>
          <div v-if="item.previous" class="muted ee-prev">
            previous → 第 {{ item.previous.unitOrdinal }} 集 entry #{{
              item.previous.entryId
            }}（改写/排除前序时请同步修订此引用）
          </div>
        </div>
        <div v-if="addOpen" class="ee-add">
          <select v-model="newChannel">
            <option v-for="c in CHANNELS" :key="c" :value="c">{{ c }}</option>
          </select>
          <select v-model="newOperation">
            <option v-for="o in OPERATIONS" :key="o" :value="o">{{ o }}</option>
          </select>
          <select v-model="newTopic">
            <option v-for="t in doc.topics" :key="t.key" :value="t.key">
              {{ t.label }}
            </option>
          </select>
          <input v-model="newValue" placeholder="内容" />
          <input
            v-model="newKnower"
            v-if="newChannel === 'knowledge'"
            placeholder="knower subject key"
          />
          <input v-model="newNote" placeholder="新增说明（必填）" />
          <button
            class="btn sm primary"
            :disabled="!newTopic || !newValue.trim() || !newNote.trim()"
            @click="addItem"
          >
            加入
          </button>
        </div>
        <div v-if="doc.warnings.length" class="ee-warn">
          <span class="badge running">警示</span>
          <span v-for="(w, i) in doc.warnings" :key="i" class="muted ee-w">{{
            w
          }}</span>
        </div>
        <label class="ee-nc" :class="{ ok: noChangesOk }">
          <input v-model="doc.noChanges" type="checkbox" />
          本集无新增变化（noChanges，显式声明）
        </label>
      </div>
    </div>
    <div class="ee-ops">
      <span v-if="!manualNotesOk" class="err-text"
        >人工/改写条目必须填写变更说明</span
      >
      <span v-else-if="!noChangesOk" class="err-text"
        >条目全部排除时必须显式勾选「本集无新增变化」</span
      >
      <button
        class="btn primary"
        :disabled="!manualNotesOk || !noChangesOk"
        @click="save"
      >
        保存草稿（revision {{ entry.revision }} → +1）
      </button>
    </div>
  </div>
</template>

<style scoped>
.ee-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ee-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.ee-sec {
  font-size: 12.5px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.ee-text {
  max-height: 300px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 11.5px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  margin: 0;
}
.ee-quote blockquote {
  margin: 4px 0;
  padding: 4px 8px;
  border-left: 3px solid var(--accent-h);
  font-size: 12px;
}
.ee-ev {
  font-size: 11px;
}
.ee-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ee-item {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: pointer;
}
.ee-item.act {
  border-color: var(--accent-h);
}
.ee-item.off {
  opacity: 0.55;
}
.ee-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ee-inc {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}
.ee-keys {
  font-size: 11px;
  color: var(--text-3);
}
.ee-val {
  font-size: 12.5px;
}
.ee-note {
  font-size: 11.5px;
  color: var(--text-2);
}
.ee-know {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
}
.ee-prev {
  font-size: 11.5px;
}
.ee-add {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
  border: 1px dashed var(--border);
  border-radius: 6px;
  padding: 8px;
}
.ee-warn {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
  font-size: 11.5px;
}
.ee-nc {
  font-size: 12px;
  display: flex;
  gap: 6px;
  align-items: center;
}
.ee-nc.ok {
  color: var(--text-2);
}
.ee-ops {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: flex-end;
}
.ee-ops .err-text {
  font-size: 12px;
}
</style>
