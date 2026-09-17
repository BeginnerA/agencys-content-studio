<script setup lang="ts">
import Modal from '../../components/common/Modal.vue'
import type { ProjectDetailApi } from './use-project-detail'
const props = defineProps<{ s: ProjectDetailApi }>()
const { showFetch, fetchUrl, fetching, fetchErr, doFetchSource } = props.s
</script>

<template>
  <Modal v-if="showFetch" title="从 URL 抓取正文（入库为素材资产）" :width="520" @close="showFetch = false">
    <label class="fld">
      网页地址
      <input
        v-model="fetchUrl"
        type="url"
        placeholder="https://example.com/article"
        :disabled="fetching"
        @keydown.enter.prevent="doFetchSource"
      />
    </label>
    <div class="muted hint">
      服务端抓取正文（超时 15s / ≤5MB / 内网地址已拦截）；提取不足 200 字符视为反爬页失败，请改用文件导入。
    </div>
    <div class="disclaimer">
      ⚠ 版权提示：抓取内容仅供个人素材整理，请遵守目标站点服务条款与版权规定，由抓取者承担相应责任。
    </div>
    <div v-if="fetchErr" class="err-text">{{ fetchErr }}</div>
    <template #footer>
      <button class="btn" :disabled="fetching" @click="showFetch = false">取消</button>
      <button class="btn primary" :disabled="fetching || !fetchUrl.trim()" @click="doFetchSource">
        {{ fetching ? '抓取中…' : '抓取入库' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.hint {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
}
.disclaimer {
  margin-top: 10px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--warn, #b45309);
  background: rgb(245 158 11 / 10%);
  border: 1px solid rgb(245 158 11 / 28%);
  border-radius: 8px;
}
</style>
