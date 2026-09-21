<script setup lang="ts">
/**
 * [M26-split] 画布内编辑节（自 drawer/index.vue 的 [M23] 编辑区原样搬出，行为零变更）：
 * 标题 / 输入字段本地草稿编辑；patch 经 emit('edit') 转交父级回流（受控：值经父级 useCanvasEdit overlay）。
 * v-if 守卫留在父级调用点；.sec 等布局样式子级自带一份（父级同名规则仅命中子组件根元素，内部元素需子级作用域）。
 */
import type { EditNodeState, StepOverride } from '../../../lib/types'

const props = defineProps<{ editNode: EditNodeState }>()
const emit = defineEmits<{
  edit: [key: string, patch: StepOverride]
}>()

// ---- [M23] 编辑区输入转交（受控：值经父级 useCanvasEdit overlay 回流） ----
function onEditTitle(e: Event): void {
  if (!props.editNode) return
  emit('edit', props.editNode.key, {
    title: (e.target as HTMLInputElement).value,
  })
}
function onEditText(fieldKey: string, e: Event): void {
  if (!props.editNode) return
  emit('edit', props.editNode.key, {
    texts: { [fieldKey]: (e.target as HTMLInputElement).value },
  })
}
</script>

<template>
  <section class="sec">
    <div class="sec-h sh-row">
      <span>画布内编辑</span>
      <span class="sp" />
      <span class="etag">草稿</span>
    </div>
    <div class="efld">
      <label class="efl" :for="`edt-title-${editNode.key}`">
        步骤标题
        <em v-if="editNode.titleDirty" class="edot" title="已修改" />
      </label>
      <input
        :id="`edt-title-${editNode.key}`"
        type="text"
        :class="{ ebad: editNode.title.trim() === '' }"
        :value="editNode.title"
        placeholder="标题不能为空"
        @input="onEditTitle"
      />
      <div v-if="editNode.title.trim() === ''" class="err-text eerr">
        标题不能为空
      </div>
    </div>
    <div class="efld">
      <div class="efl">输入字段</div>
      <div v-if="editNode.fields.length" class="eflist">
        <div v-for="f in editNode.fields" :key="f.key" class="efrow">
          <label class="efk mono" :for="`edt-${editNode.key}-${f.key}`">
            {{ f.key }}
            <em v-if="f.dirty" class="edot" title="已修改" />
          </label>
          <input
            v-if="f.editable"
            :id="`edt-${editNode.key}-${f.key}`"
            type="text"
            :value="f.value"
            @input="onEditText(f.key, $event)"
          />
          <div v-else class="efro" :title="f.value">
            <span class="efro-t mono">{{ f.value }}</span>
            <span class="efro-tag">只读</span>
          </div>
        </div>
      </div>
      <div v-else class="muted">该步骤无输入字段</div>
    </div>
    <div class="muted hint">
      编辑为本地草稿，不改动原模板文件；重置与退出编辑在顶栏操作。
    </div>
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
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
  letter-spacing: 0.4px;
}

.sh-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sp {
  flex: 1;
}

.hint {
  font-size: 11.5px;
}

/* ---- [M23] 画布内编辑区 ---- */
.etag {
  font-size: 10.5px;
  color: var(--warn);
  border: 1px solid rgb(251 191 36 / 35%);
  border-radius: 999px;
  padding: 1px 8px;
  font-weight: 400;
}

.efld {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.efl {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--text-2);
}

.edot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warn);
  flex: none;
}

input.ebad {
  border-color: var(--bad);
}

.eerr {
  font-size: 11px;
}

.eflist {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.efrow {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.efk {
  font-size: 11px;
  color: var(--accent-h);
  display: flex;
  align-items: center;
  gap: 4px;
}

.efro {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 5px 8px;
  min-width: 0;
}

.efro-t {
  flex: 1;
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.efro-tag {
  flex: none;
  font-size: 10px;
  color: var(--text-3);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 6px;
}
</style>
