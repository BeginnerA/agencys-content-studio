<script setup lang="ts">
/**
 * 项目危险操作弹窗：归档（逻辑删，可恢复）/ 彻底删除（事务清库 + 删磁盘文件，需输入项目名确认）。
 * 已归档项目仅显示彻底删除区（归档操作隐藏）。
 */
import { computed, ref } from 'vue'
import Modal from '../common/Modal.vue'
import Icon from '../common/Icon.vue'
import { ApiError, projectApi } from '../../lib/api'
import type { Project } from '../../lib/types'

const props = defineProps<{
  project: Pick<Project, 'id' | 'name' | 'status'>
}>()
const emit = defineEmits<{ archived: []; purged: []; close: [] }>()

const isArchived = computed(() => props.project.status === 'archived')
const confirmText = ref('')
const busy = ref(false)
const err = ref('')

const nameMatched = computed(
  () => confirmText.value.trim() === props.project.name,
)

async function run(fn: () => Promise<unknown>, done: () => void) {
  busy.value = true
  err.value = ''
  try {
    await fn()
    done()
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

function doArchive() {
  void run(
    () => projectApi.archive(props.project.id),
    () => emit('archived'),
  )
}

function doPurge() {
  if (!nameMatched.value) return
  void run(
    () => projectApi.purge(props.project.id),
    () => emit('purged'),
  )
}
</script>

<template>
  <Modal
    :title="`管理项目「${project.name}」`"
    :width="520"
    @close="emit('close')"
  >
    <!-- 归档（可恢复；已归档项目隐藏） -->
    <section v-if="!isArchived" class="zone">
      <div class="zt">归档项目</div>
      <p class="zd">
        归档后项目从默认列表隐藏，数据与磁盘文件全部保留，可在「已归档」页恢复。
      </p>
      <button class="btn" :disabled="busy" @click="doArchive">
        <Icon name="inbox" :size="14" /> 归档项目
      </button>
    </section>

    <!-- 彻底删除（不可恢复） -->
    <section class="zone" :class="{ sep: !isArchived }">
      <div class="zt bad">彻底删除</div>
      <p class="zd">
        将永久删除数据库中全部记录（运行 / 资产 / 批次 / 发布 / 成本 / 记忆 /
        角色）与磁盘文件（素材、成片、日志），
        <b class="bad">此操作不可恢复</b
        >。项目还有未完成的运行时会拒绝删除，请先取消。
      </p>
      <label class="fld">
        输入项目名 <b>{{ project.name }}</b> 以确认
        <input
          v-model="confirmText"
          type="text"
          placeholder="与项目名完全一致才能删除"
        />
      </label>
      <button
        class="btn danger"
        :disabled="busy || !nameMatched"
        @click="doPurge"
      >
        <Icon name="trash" :size="14" /> 彻底删除
      </button>
    </section>

    <div v-if="err" class="err-text">{{ err }}</div>

    <template #footer>
      <button class="btn" @click="emit('close')">关闭</button>
    </template>
  </Modal>
</template>

<style scoped>
.zone {
  padding: 2px 0;
}

.zone.sep {
  border-top: 1px dashed var(--border-strong);
  margin-top: 14px;
  padding-top: 14px;
}

.zt {
  font-size: 13.5px;
  font-weight: 600;
}

.zt.bad {
  color: var(--bad);
}

.zd {
  color: var(--text-2);
  font-size: 12.5px;
  margin: 6px 0 10px;
  line-height: 1.65;
}

.bad {
  color: var(--bad);
}
</style>
