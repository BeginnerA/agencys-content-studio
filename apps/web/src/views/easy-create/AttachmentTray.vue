<script setup lang="ts">
/**
 * [M26-split] 输入区上方「参考素材托盘」（自 ConversationPanel.vue 原样搬出，行为零变更）：
 * 缩略图 / 上传状态 / 用途下拉 / 重试 / 移除。状态与操作真源在 useEasyCreate（s 透传），本组件纯展示 + 直连。
 */
import Icon from '../../components/common/Icon.vue'
import { REF_ROLE_LABELS, REF_VALID_ROLES } from '../../lib/types'
import type { CreationRefRole } from '../../lib/types'
import type { useEasyCreate } from './use-creation-chat'
import { kindIcon } from './ref-utils'

const props = defineProps<{ s: ReturnType<typeof useEasyCreate> }>()

function onRoleChange(clientId: string, role: string): void {
  void props.s.changeAttachmentRole(clientId, role as CreationRefRole)
}
</script>

<template>
  <div class="atts">
    <div class="att-h">
      <Icon name="photo" :size="12" /> 参考素材 · 发送后编译进方案并影响制作
    </div>
    <div
      v-for="a in s.state.attachments"
      :key="a.clientId"
      class="att"
      :class="{ 'att-errored': a.error }"
    >
      <span class="att-thumb">
        <img
          v-if="a.thumbUrl"
          :src="a.thumbUrl"
          :alt="a.name"
          loading="lazy"
        />
        <Icon v-else :name="kindIcon(a.kind)" :size="16" />
      </span>
      <span class="att-main">
        <span class="att-name" :title="a.name">{{ a.name }}</span>
        <span class="att-sub">
          <span v-if="a.uploading" class="muted">上传中…</span>
          <span v-else-if="a.error" class="att-err">{{ a.error }}</span>
          <span v-else-if="a.assetId" class="ok">已就绪</span>
        </span>
      </span>
      <select
        class="att-role"
        :value="a.role"
        :disabled="a.uploading"
        :aria-label="'参考用途：' + a.name"
        @change="
          onRoleChange(a.clientId, ($event.target as HTMLSelectElement).value)
        "
      >
        <option v-for="r in REF_VALID_ROLES[a.kind]" :key="r" :value="r">
          {{ REF_ROLE_LABELS[r] }}
        </option>
      </select>
      <button
        v-if="a.error && !a.uploading"
        class="icobtn"
        type="button"
        title="重试上传"
        aria-label="重试上传"
        @click="s.retryAttachment(a.clientId)"
      >
        <Icon name="refresh" :size="14" />
      </button>
      <button
        class="icobtn"
        type="button"
        title="移除参考"
        aria-label="移除参考"
        @click="s.removeAttachment(a.clientId)"
      >
        <Icon name="x" :size="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.atts {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-2);
  padding: 9px 11px;
  margin-bottom: 9px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.att-h {
  font-size: 11.5px;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.att-h .ic {
  color: var(--accent-h);
}

.att {
  display: flex;
  align-items: center;
  gap: 8px;
}

.att-thumb {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 7px;
  overflow: hidden;
  background: var(--raised);
  border: 1px solid var(--border);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}

.att-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.att-main {
  min-width: 0;
  /* 全局 select{width:100%} 曾把用途下拉撑满整行、文件名挤成竖排；下方 .att-role width:auto 修正后，这里再给最小可读宽度兜底 */
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.att-name {
  font-size: 12.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.att-sub {
  font-size: 11px;
}

.att-sub .ok {
  color: var(--run);
}

.att-err {
  color: var(--bad);
}

.att-role {
  flex: none;
  width: auto; /* 覆盖全局 select{width:100%}，防止撑满 .att 行挤没文件名 */
  font-size: 12px;
  padding: 3px 6px;
  border-radius: 7px;
  background: var(--raised);
  border: 1px solid var(--border-strong);
  color: var(--text);
}

.icobtn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: none;
  border: 1px solid transparent;
  color: var(--text-3);
  cursor: pointer;
}

.icobtn:hover {
  border-color: var(--border-strong);
  color: #fff;
}
</style>
