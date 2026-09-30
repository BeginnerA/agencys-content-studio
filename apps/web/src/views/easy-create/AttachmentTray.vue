<script setup lang="ts">
/**
 * 输入区上方「参考素材托盘」（自 ConversationPanel.vue 原样搬出，行为零变更）：
 * 缩略图 / 上传状态 / 用途下拉 / 重试 / 移除。状态与操作真源在 useEasyCreate（s 透传），本组件纯展示 + 直连。
 * 图片行新增「用于」逐镜绑定下拉：整片（默认）+ 当前方案逐镜；变更即 PATCH（零计费），
 * 方案未生成时只有「整片」一项（服务端无 plan 可校验镜头，绑镜要等方案就绪）。
 */
import { computed, ref } from 'vue'
import Icon from '../../components/common/Icon.vue'
import { REF_ROLE_LABELS, REF_VALID_ROLES } from '../../lib/types'
import type { CreationRefRole } from '../../lib/types'
import type { useEasyCreate } from './use-creation-chat'
import { kindIcon } from './ref-utils'

const props = defineProps<{ s: ReturnType<typeof useEasyCreate> }>()
const fileInput = ref<HTMLInputElement | null>(null)
const replacementId = ref('')
function replaceFile(clientId: string) { replacementId.value = clientId; fileInput.value?.click() }
function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) props.s.replaceAttachmentFile(replacementId.value, file)
  input.value = ''
}

function onRoleChange(clientId: string, role: string): void {
  void props.s.changeAttachmentRole(clientId, role as CreationRefRole)
}

// 可绑镜头候选：当前方案逐镜（镜序 + 提示词摘要）；无方案 → 只剩「整片」
const shotOptions = computed(() => {
  const shots = props.s.state.detail?.session.plan?.shots ?? []
  return shots.map((sh, i) => ({
    id: sh.id,
    label: `第 ${i + 1} 镜 · ${sh.image_prompt.slice(0, 18)}${sh.image_prompt.length > 18 ? '…' : ''}`,
  }))
})

function onShotChange(clientId: string, shotId: string): void {
  void props.s.setAttachmentShot(clientId, shotId)
}

// 逐镜绑定可用性提示：方案未生成时只有「整片」一项，给出说明避免用户误以为下拉框失灵
const shotBindHint = computed(() => {
  if (!props.s.state.detail?.session.plan) return '逐镜绑定需等方案生成后可选，当前仅能「用于整片」'
  if (shotOptions.value.length === 0) return '当前方案没有可绑定的镜头'
  return '选择这张参考图用于整片还是某个镜头'
})
</script>

<template>
  <div class="atts">
    <input ref="fileInput" type="file" accept="image/*,video/*,audio/*" hidden @change="onFile" />
    <div class="att-h">
      <Icon name="photo" :size="12" /> 参考素材 · 全部就绪后随文字提交规划
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
          @error="a.thumbUrl = null"
        />
        <Icon v-else :name="kindIcon(a.kind)" :size="16" />
      </span>
      <span class="att-main">
        <span class="att-name" :title="a.name">{{ a.name }}</span>
        <span class="att-sub">
          <span v-if="a.uploading" class="muted">上传中…</span>
          <span v-else-if="a.error" class="att-err">{{ a.error }}</span>
          <span v-else-if="a.assetId" class="ok">已就绪</span>
          <span v-else class="muted">待提交时登记</span>
        </span>
      </span>
      <select
        class="att-role"
        :value="a.role"
        :disabled="s.attachmentsLocked.value"
        :aria-label="'参考用途：' + a.name"
        @change="
          onRoleChange(a.clientId, ($event.target as HTMLSelectElement).value)
        "
      >
        <option v-for="r in REF_VALID_ROLES[a.kind]" :key="r" :value="r">
          {{ REF_ROLE_LABELS[r] }}
        </option>
      </select>
      <!-- 逐镜绑定（仅图片；读链 recipeRefImageIds/recipeFirstFrameId 只消费 image 的 shotId） -->
      <select
        v-if="a.kind === 'image'"
        class="att-role att-shot"
        :value="a.shotId ?? ''"
        :disabled="s.attachmentsLocked.value || !a.assetId"
        :aria-label="'用于哪一镜：' + a.name"
        :title="shotBindHint"
        @change="
          onShotChange(a.clientId, ($event.target as HTMLSelectElement).value)
        "
      >
        <option value="">用于整片</option>
        <option v-for="sh in shotOptions" :key="sh.id" :value="sh.id">{{ sh.label }}</option>
        <!-- 方案未生成 / 无镜头候选：占位说明项，禁用不可选，仅解释为何只有「用于整片」 -->
        <option v-if="shotOptions.length === 0" value="__hint__" disabled>
          {{ shotBindHint }}
        </option>
      </select>
      <button
        v-if="a.error && !a.uploading && (a.file || a.sourceAssetId) && s.state.currentId"
        class="icobtn"
        type="button"
        title="重试上传"
        aria-label="重试上传"
        :disabled="s.attachmentsLocked.value"
        @click="s.retryAttachment(a.clientId)"
      >
        <Icon name="refresh" :size="14" />
      </button>
      <button v-if="!a.assetId && !a.file && !a.sourceAssetId" class="btn ghost ec-reselect" type="button" :disabled="s.attachmentsLocked.value" @click="replaceFile(a.clientId)">重新选择文件</button>
      <button
        class="icobtn"
        type="button"
        :disabled="s.attachmentsLocked.value"
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
  flex-wrap: wrap;
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
  flex: 1 1 100px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.att-name {
  font-size: 12.5px;
  color: var(--text);
  /* 单行省略：缺 nowrap 时 text-overflow 从不生效，长文件名会折行撑破行高；全名由 :title 悬停展示 */
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
  width: 44px;
  height: 44px;
  border-radius: 7px;
  background: none;
  border: 1px solid transparent;
  color: var(--text-3);
  cursor: pointer;
}

.att-role, .ec-reselect { min-height: 44px; }
.icobtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.icobtn:disabled { opacity: 0.5; cursor: not-allowed; }

.icobtn:hover {
  border-color: var(--border-strong);
  color: #fff;
}
</style>
