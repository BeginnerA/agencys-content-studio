<script setup lang="ts">
import Icon from '../../common/Icon.vue'
import Modal from '../../common/Modal.vue'
import ShotRow from './ShotRow.vue'
import LinesEditor from './LinesEditor.vue'
import { useStoryboardEditor } from './use-storyboard-editor'
import type { RunStep, ShotBoardShot } from '../../../lib/types'

const props = defineProps<{
  runId: number
  step: RunStep
  shots: ShotBoardShot[]
  canOperate: boolean
}>()
const emit = defineEmits<{ close: []; saved: [] }>()
const s = useStoryboardEditor({ props, emit })
const {
  drafts,
  busy,
  err,
  charNames,
  active,
  aliveCount,
  addShot,
  toggleDeleted,
  textField,
  setTextField,
  numFieldText,
  setNumField,
  setBoolField,
  setJsonField,
  durText,
  setDur,
  charList,
  addChar,
  removeChar,
  extraKeys,
  fieldKind,
  addingKey,
  newKey,
  startAddKey,
  commitAddKey,
  removeKey,
  changeCount,
  dirty,
  save,
  requestClose,
} = s
</script>

<template>
  <Modal
    :title="`分镜编辑器 · ${step.title || step.stepKey}`"
    :width="1000"
    @close="requestClose"
  >
    <div class="se">
      <div class="se-hint">
        <Icon name="sliders" :size="12" />
        <span
          >增删 / 改字段 /
          拖拽重排镜头：保存后仅改写分镜与镜头顺序，<b>不触发生成</b>，重新合成后生效。</span
        >
      </div>
      <div v-if="!canOperate" class="se-lock">
        <Icon name="alert" :size="12" /> 当前状态只读（run 执行中或不可返修）
      </div>
      <div v-if="err" class="err-text">{{ err }}</div>

      <div class="se-body">
        <!-- 左栏：镜头列表 -->
        <div class="se-list">
          <ShotRow
            v-for="(d, i) in drafts"
            :key="d.uid"
            :s="s"
            :d="d"
            :i="i"
            :canOperate="canOperate"
          />
          <div v-if="!drafts.length" class="muted se-empty">无镜头</div>
          <button
            class="btn sm se-add"
            :disabled="!canOperate"
            @click="addShot"
          >
            <Icon name="plus" :size="12" /> 新增镜头
          </button>
        </div>

        <!-- 右栏：字段表单 -->
        <div class="se-form">
          <template v-if="active">
            <div v-if="active.deleted" class="se-dead-tip">
              <Icon name="alert" :size="12" />
              <span
                >该镜头已标记删除（保存后从分镜移除；任务 /
                产物保留为历史）</span
              >
              <button class="btn sm" @click="toggleDeleted(active)">
                撤销删除
              </button>
            </div>

            <template v-else>
              <div class="se-field">
                <label>镜头 ID</label>
                <input
                  v-if="active.isNew"
                  v-model="active.id"
                  type="text"
                  class="mono"
                  spellcheck="false"
                  placeholder="如 s5（唯一）"
                  :disabled="!canOperate"
                />
                <div v-else class="se-ro mono">
                  {{ active.id }}<span class="muted">（不可修改）</span>
                </div>
              </div>

              <div class="se-field">
                <label>出图提示词 image_prompt（必填）</label>
                <textarea
                  rows="4"
                  spellcheck="false"
                  :value="textField(active, 'image_prompt')"
                  :disabled="!canOperate"
                  @input="setTextField(active, 'image_prompt', $event)"
                />
              </div>

              <div class="se-field">
                <label>动效提示词 motion_prompt</label>
                <textarea
                  rows="3"
                  spellcheck="false"
                  :value="textField(active, 'motion_prompt')"
                  :disabled="!canOperate"
                  @input="setTextField(active, 'motion_prompt', $event)"
                />
              </div>

              <div class="se-field se-inline">
                <label>时长（秒；空 = 用全局默认）</label>
                <input
                  type="number"
                  min="0.5"
                  max="60"
                  step="0.5"
                  class="se-num"
                  :value="durText(active)"
                  :disabled="!canOperate"
                  @input="setDur(active, $event)"
                />
              </div>

              <div class="se-field">
                <label>角色 characters（回车添加；建议来自实体库）</label>
                <div class="se-tags">
                  <span v-for="c in charList(active)" :key="c" class="se-tag">
                    {{ c }}
                    <button
                      type="button"
                      aria-label="移除角色"
                      :disabled="!canOperate"
                      @click="removeChar(active, c)"
                    >
                      <Icon name="x" :size="10" />
                    </button>
                  </span>
                  <input
                    type="text"
                    class="se-tag-input"
                    list="se-char-names"
                    placeholder="输入角色名回车"
                    :disabled="!canOperate"
                    @keydown.enter.prevent="addChar(active, $event)"
                  />
                  <datalist id="se-char-names">
                    <option v-for="n in charNames" :key="n" :value="n" />
                  </datalist>
                </div>
              </div>

              <div class="se-field">
                <label>台词 lines（回车添加台词 id；建议来自本集台词表）</label>
                <LinesEditor :s="s" :active="active" :canOperate="canOperate" />
              </div>

              <div class="se-field">
                <label>其他字段（array/object 为 JSON 文本，保存时校验）</label>
                <div v-for="k in extraKeys(active)" :key="k" class="se-kv">
                  <span class="se-kv-key mono" :title="k">{{ k }}</span>
                  <template v-if="fieldKind(active.fields[k]) === 'boolean'">
                    <input
                      type="checkbox"
                      :checked="active.fields[k] === true"
                      :disabled="!canOperate"
                      @change="setBoolField(active, k, $event)"
                    />
                    <span class="muted se-kv-hint">{{
                      active.fields[k] === true ? 'true' : 'false'
                    }}</span>
                  </template>
                  <input
                    v-else-if="fieldKind(active.fields[k]) === 'number'"
                    type="number"
                    class="se-num"
                    :value="numFieldText(active.fields[k])"
                    :disabled="!canOperate"
                    @input="setNumField(active, k, $event)"
                  />
                  <textarea
                    v-else-if="fieldKind(active.fields[k]) === 'json'"
                    class="se-json mono"
                    rows="2"
                    spellcheck="false"
                    :value="
                      active.jsonText[k] ?? JSON.stringify(active.fields[k])
                    "
                    :disabled="!canOperate"
                    @input="setJsonField(active, k, $event)"
                  />
                  <input
                    v-else
                    type="text"
                    :value="textField(active, k)"
                    :disabled="!canOperate"
                    @input="setTextField(active, k, $event)"
                  />
                  <button
                    class="se-item-del"
                    title="移除字段（原分镜存在该键时保存为 null 置空）"
                    :disabled="!canOperate"
                    @click="removeKey(active, k)"
                  >
                    <Icon name="trash" :size="12" />
                  </button>
                </div>
                <div v-if="addingKey" class="se-kv se-kv-add">
                  <input
                    v-model="newKey"
                    type="text"
                    class="mono"
                    placeholder="字段名（如 scene / lighting）"
                    spellcheck="false"
                    @keydown.enter.prevent="commitAddKey(active)"
                  />
                  <button class="btn sm" @click="commitAddKey(active)">
                    添加
                  </button>
                  <button class="btn sm" @click="addingKey = false">
                    取消
                  </button>
                </div>
                <button
                  v-else
                  class="btn sm se-add"
                  :disabled="!canOperate"
                  @click="startAddKey"
                >
                  <Icon name="plus" :size="12" /> 添加字段
                </button>
              </div>
            </template>
          </template>
          <div v-else class="muted se-empty">选择左侧镜头以编辑字段</div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="se-foot">
        <span class="muted se-count">
          {{ aliveCount }} 镜{{
            changeCount > 0 ? ` · ${changeCount} 项改动` : ''
          }}
        </span>
        <span class="grow" />
        <button class="btn" :disabled="busy" @click="requestClose">取消</button>
        <button
          class="btn primary"
          :disabled="!canOperate || busy || !dirty"
          @click="save"
        >
          <Icon name="check" :size="12" /> {{ busy ? '保存中…' : '保存' }}
        </button>
      </div>
    </template>
  </Modal>
</template>

<style scoped>
.se-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 10px;
  margin-bottom: 8px;
}

.se-hint b {
  color: var(--text);
}

.se-lock {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--warn);
  background: var(--warn-weak);
  border: 1px solid rgb(245 158 11 / 20%);
  border-radius: 8px;
  padding: 5px 10px;
  margin-bottom: 8px;
}

.se-body {
  display: grid;
  grid-template-columns: 290px 1fr;
  gap: 12px;
  height: min(62vh, 600px);
  min-height: 360px;
}

/* ---------- 左栏 ---------- */

.se-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-2);
}
.se-item-del {
  flex: none;
  border: none;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 2px;
  display: inline-flex;
  border-radius: 6px;
}

.se-item-del:hover:not(:disabled) {
  color: var(--bad);
}

.se-item-del.undo {
  color: var(--accent-h);
}

.se-item-del:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.se-empty {
  font-size: 12px;
  padding: 10px 4px;
  text-align: center;
}

.se-add {
  align-self: flex-start;
}

/* ---------- 右栏 ---------- */

.se-form {
  overflow-y: auto;
  padding-right: 4px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.se-dead-tip {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--warn);
  background: var(--warn-weak);
  border: 1px solid rgb(245 158 11 / 20%);
  border-radius: 8px;
  padding: 8px 10px;
}

.se-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.se-field > label {
  font-size: 11.5px;
  color: var(--text-2);
}

.se-field input[type='text'],
.se-field textarea,
.se-kv input[type='text'],
.se-kv textarea {
  background: var(--code-bg);
  border: 1px solid var(--border-strong);
  color: var(--text);
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 12px;
  font-family: inherit;
  resize: vertical;
  width: 100%;
}

.se-field input:disabled,
.se-field textarea:disabled,
.se-kv input:disabled,
.se-kv textarea:disabled {
  opacity: 0.5;
}

.se-inline {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.se-num {
  width: 88px;
  background: var(--code-bg);
  border: 1px solid var(--border-strong);
  color: var(--text);
  border-radius: 6px;
  padding: 3px 6px;
  font-size: 12px;
  font-family: inherit;
}

.se-ro {
  font-size: 12px;
  color: var(--text);
  padding: 3px 0;
}

.se-ro .muted {
  font-size: 11px;
  margin-left: 6px;
}

/* 角色标签 */

.se-tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  border: 1px solid var(--border-strong);
  background: var(--code-bg);
  border-radius: 8px;
  padding: 5px 8px;
  min-height: 34px;
}

.se-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--text);
  background: rgb(99 102 241 / 16%);
  border: 1px solid rgb(99 102 241 / 28%);
  border-radius: 999px;
  padding: 1px 8px;
}

.se-tag button {
  border: none;
  background: none;
  color: var(--text-2);
  cursor: pointer;
  padding: 0;
  display: inline-flex;
}

.se-tag button:hover:not(:disabled) {
  color: var(--bad);
}

.se-tag-input {
  flex: 1;
  min-width: 120px;
  background: none !important;
  border: none !important;
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
  outline: none;
  padding: 2px 0 !important;
}

/* 动态键值行 */

.se-kv {
  display: grid;
  grid-template-columns: 120px 1fr 26px;
  gap: 6px;
  align-items: center;
  margin-bottom: 6px;
}

.se-kv-key {
  font-size: 11.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.se-kv-hint {
  font-size: 11px;
}

.se-json {
  font-size: 11.5px;
}

.se-kv-add {
  grid-template-columns: 1fr auto auto;
}

.se-kv input[type='checkbox'] {
  accent-color: var(--accent);
  justify-self: start;
  cursor: pointer;
}

/* ---------- 底栏 ---------- */

.se-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.se-count {
  font-size: 12px;
}

@media (max-width: 860px) {
  .se-body {
    grid-template-columns: 1fr;
    height: auto;
  }

  .se-list {
    max-height: 200px;
  }
}
</style>
