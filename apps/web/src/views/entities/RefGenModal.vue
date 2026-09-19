<script setup lang="ts">
import Modal from '../../components/common/Modal.vue'
import Icon from '../../components/common/Icon.vue'
import type { EntitiesApi } from './use-entities'
const props = defineProps<{ s: EntitiesApi }>()
const {
  showRefGen,
  refVariants,
  refSubmitting,
  refErr,
  refPid,
  selItems,
  selNoAppearance,
  refPlanned,
  refLive,
  submitRefGen,
} = props.s
</script>

<template>
  <!-- [M19 P6] 批量生成参考图弹窗：变体数 + 预估张数（实际校验与入队在服务端） -->
  <Modal
    v-if="showRefGen"
    title="批量生成参考图"
    :width="560"
    @close="showRefGen = false"
  >
    <div class="rgbox">
      <div class="rg-lbl">
        所选素材（{{ selItems.length }} 项 · 项目#{{ refPid }}）
      </div>
      <div class="rg-chips">
        <span v-for="c in selItems" :key="c.id" class="chip">{{ c.name }}</span>
      </div>
      <div v-if="selNoAppearance.length" class="rg-warn">
        <Icon name="alert" :size="12" /> 缺 appearance 锚定：{{
          selNoAppearance.join('、')
        }}——服务端会整单拒绝，请先补全或批量润色。
      </div>
      <label class="fld">
        每个素材生成变体数
        <select v-model.number="refVariants">
          <option :value="1">1 张</option>
          <option :value="2">2 张</option>
          <option :value="3">3 张</option>
          <option :value="4">4 张</option>
        </select>
      </label>
      <div class="rg-note">
        将生成
        <b>{{ refPlanned }}</b>
        张：出图配置取项目设置里的图像端点/模型/尺寸，提示词 = appearance +
        项目画风词块 + negative；已有参考图会作为锚定输入（最多 4
        张），完成后自动追加挂接，可进编辑弹窗挑拣。
      </div>
      <div v-if="refLive.length" class="muted rg-note2">
        该项目另有 {{ refLive.length }} 个任务正在出图，本次将一并排队。
      </div>
      <div v-if="refErr" class="err-text">{{ refErr }}</div>
    </div>
    <template #footer>
      <button class="btn" @click="showRefGen = false">取消</button>
      <button
        class="btn primary"
        :disabled="refSubmitting || !refPlanned"
        @click="submitRefGen"
      >
        {{ refSubmitting ? '入队中…' : `开始生成（${refPlanned} 张）` }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.rgbox {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rg-lbl {
  font-size: 12.5px;
  color: var(--text-2);
}

.rg-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.rg-warn {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid rgb(245 158 11 / 20%);
  border-radius: 8px;
  background: var(--warn-weak);
  color: var(--warn);
  font-size: 12px;
  line-height: 1.5;
}

.rg-note,
.rg-note2 {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-2);
}

.rg-note2 {
  color: var(--text-3);
}

.rgbox b {
  color: var(--accent);
}
</style>
