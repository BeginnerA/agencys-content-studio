<script setup lang="ts">
/**
 * [M27] 编排链构建器 Modal（spec §2.5 I3）
 * 选模板 → 依上一段 template.next 建议排序 → 设 autoAdvance / budgetCap → 保存 / 保存并启动首段。
 * 段仅引用扁平模板 key（I2 编排层引用，无引擎递归）；运行时深度嵌套明确排除。
 */
import { computed, ref, watch } from 'vue'
import Modal from '../../common/Modal.vue'
import Icon from '../../common/Icon.vue'
import { workflowApi } from '../../../lib/api'
import type { TemplateMeta } from '../../../lib/types'

const props = defineProps<{ projectId: number; templates: TemplateMeta[] }>()
const emit = defineEmits<{ close: []; created: [wfId: number] }>()

const name = ref('')
const segKeys = ref<string[]>([])
const autoAdvance = ref<0 | 1>(0)
const budgetCap = ref('')
const pick = ref('')
const busy = ref(false)
const err = ref('')

const byKey = computed(() => new Map(props.templates.map((t) => [t.key, t])))
const nameOf = (k: string) => byKey.value.get(k)?.name ?? k

/** 下一段建议：末段 template.next 命中项（无末段 / 无 next → 空） */
const suggestions = computed<string[]>(() => {
  const last = segKeys.value[segKeys.value.length - 1]
  if (!last) return []
  return (byKey.value.get(last)?.next ?? []).filter((k) => byKey.value.has(k))
})

watch(pick, (v) => {
  if (v) {
    addSeg(v)
    pick.value = ''
  }
})

function addSeg(k: string) {
  if (k && byKey.value.has(k)) segKeys.value.push(k)
}
function removeAt(i: number) {
  segKeys.value.splice(i, 1)
}
function move(i: number, dir: -1 | 1) {
  const j = i + dir
  if (j < 0 || j >= segKeys.value.length) return
  const arr = segKeys.value
  ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
}

async function save(startAfter: boolean) {
  err.value = ''
  if (!segKeys.value.length) {
    err.value = '至少添加一个模板段'
    return
  }
  busy.value = true
  try {
    const cap = budgetCap.value.trim() === '' ? null : Number(budgetCap.value)
    const { workflow, warnings } = await workflowApi.create(props.projectId, {
      name: name.value.trim() || '未命名编排链',
      segments: segKeys.value.map((k) => ({ templateKey: k })),
      autoAdvance: autoAdvance.value,
      budgetCap: cap,
    })
    if (startAfter) {
      try {
        await workflowApi.start(workflow.id)
      } catch (e) {
        // 启动失败不回滚已建链：提示后仍刷新列表
        err.value = `链已保存，但启动首段失败：${(e as Error).message}`
      }
    }
    const warn = warnings?.length ? `\n提示：${warnings.join('；')}` : ''
    if (!err.value) emit('created', workflow.id)
    if (warn) err.value = (err.value ? err.value + warn : warn.trim())
  } catch (e) {
    err.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal title="新建编排链" :width="620" @close="emit('close')">
    <div class="cb">
      <label class="fld">
        链名称
        <input v-model="name" type="text" placeholder="例如：单集流水线（入库 → 剧本 → 分镜）" />
      </label>

      <div class="fld">
        模板段序列（按执行顺序）
        <div class="seglist">
          <div v-if="!segKeys.length" class="muted mini">尚未添加模板段。用下方选择器添加，或点击建议模板快速追加。</div>
          <div v-for="(k, i) in segKeys" :key="`${k}-${i}`" class="seg">
            <span class="seq mono">{{ i + 1 }}</span>
            <span class="sname" :title="k">{{ nameOf(k) }}</span>
            <span class="skey mono muted">{{ k }}</span>
            <span class="sp" />
            <button type="button" class="mini-btn" :disabled="i === 0" aria-label="上移" @click="move(i, -1)">
              <Icon name="chevron-down" :size="12" class="up" />
            </button>
            <button type="button" class="mini-btn" :disabled="i === segKeys.length - 1" aria-label="下移" @click="move(i, 1)">
              <Icon name="chevron-down" :size="12" />
            </button>
            <button type="button" class="mini-btn del" aria-label="移除该段" @click="removeAt(i)">
              <Icon name="x" :size="12" />
            </button>
          </div>
        </div>

        <select v-model="pick" class="picker" aria-label="选择模板添加为段">
          <option value="">＋ 选择模板追加为段…</option>
          <option v-for="t in templates" :key="t.key" :value="t.key">{{ t.name }}（{{ t.key }}）</option>
        </select>

        <div v-if="suggestions.length" class="suggest">
          <span class="muted mini">下一段建议：</span>
          <button v-for="s in suggestions" :key="s" type="button" class="chip" @click="addSeg(s)">
            {{ nameOf(s) }} ＋
          </button>
        </div>
      </div>

      <div class="row2">
        <label class="sw">
          <input v-model="autoAdvance" type="checkbox" :true-value="1" :false-value="0" />
          <span>自动级联（autoAdvance）</span>
        </label>
        <label class="fld cap">
          链预算上限（元，留空=不设）
          <input v-model="budgetCap" type="number" min="0" step="0.01" placeholder="不限" />
        </label>
      </div>
      <div class="muted mini">
        计费安全：默认关闭自动级联——每段完成仅提示，不自动触发下一段。开启后每跳前仍过项目预算与本链上限，超阈自动暂停。首段启动永远是你点击「启动」。
      </div>

      <div v-if="err" class="err-text">{{ err }}</div>
    </div>
    <template #footer>
      <button type="button" class="btn" @click="emit('close')">取消</button>
      <button type="button" class="btn" :disabled="busy || !segKeys.length" @click="save(false)">仅保存</button>
      <button type="button" class="btn primary" :disabled="busy || !segKeys.length" @click="save(true)">
        <Icon name="play" :size="12" /> {{ busy ? '提交中…' : '保存并启动首段' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.cb {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.fld {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12.5px;
  color: var(--text-2);
}

.seglist {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 4px;
}

.seg {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 9px;
}

.seq {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--chip-bg);
  font-size: 11px;
  color: var(--text-2);
  flex: none;
}

.sname {
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skey {
  font-size: 11px;
}

.mini-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text-2);
  cursor: pointer;
}

.mini-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.mini-btn:not(:disabled):hover {
  background: var(--hover);
}

.mini-btn.del:hover {
  color: var(--bad);
  border-color: var(--bad);
}

.mini-btn :deep(.up) {
  transform: rotate(180deg);
}

.picker {
  margin-top: 6px;
  font: inherit;
  font-size: 12.5px;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 9px;
}

.suggest {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 6px;
}

.chip {
  font: inherit;
  font-size: 11.5px;
  color: var(--accent);
  background: var(--chip-bg);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 10px;
  cursor: pointer;
}

.chip:hover {
  border-color: var(--accent);
}

.row2 {
  display: flex;
  align-items: flex-end;
  gap: 16px;
  flex-wrap: wrap;
}

.sw {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text);
  cursor: pointer;
}

.cap {
  min-width: 180px;
}

input[type='text'],
input[type='number'] {
  font: inherit;
  font-size: 13px;
  color: var(--text);
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 9px;
}

.mini {
  font-size: 11px;
  line-height: 1.6;
}

.err-text {
  font-size: 12px;
  color: var(--bad);
  white-space: pre-wrap;
  line-height: 1.6;
}

.sp {
  flex: 1;
}
</style>
