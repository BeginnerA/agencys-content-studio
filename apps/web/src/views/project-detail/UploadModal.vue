<script setup lang="ts">
import Modal from '../../components/common/Modal.vue'
import type { ProjectDetailApi } from './use-project-detail'
const props = defineProps<{ s: ProjectDetailApi }>()
const { showUpload, uploadPurpose, uploadFilesSel, uploading, uploadErr, onUploadChange, doUpload } = props.s
</script>

<template>
    <Modal v-if="showUpload" title="上传素材（入库为资产，sha256 去重）" :width="520" @close="showUpload = false">
      <label class="fld">
        用途
        <select v-model="uploadPurpose">
          <option value="source">素材 source（设定/参考底稿）</option>
          <option value="reference_character">角色参考 reference_character</option>
          <option value="brief">题材简报 brief</option>
          <option value="archive">归档 archive</option>
        </select>
      </label>
      <label class="fld">
        文件（可多选）
        <input type="file" multiple @change="onUploadChange" />
      </label>
      <div v-if="uploadFilesSel.length" class="muted">{{ uploadFilesSel.length }} 个文件待上传</div>
      <div v-if="uploadErr" class="err-text">{{ uploadErr }}</div>
      <template #footer>
        <button class="btn" @click="showUpload = false">取消</button>
        <button class="btn primary" :disabled="uploading || !uploadFilesSel.length" @click="doUpload">
          {{ uploading ? '上传中…' : '上传' }}
        </button>
      </template>
    </Modal>
</template>
