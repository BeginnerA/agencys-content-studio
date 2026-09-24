<script setup lang="ts">
/**
 * 参考素材列表（自 CreationPlanCard.vue 逐字迁移，行为零变更）：
 * 已冻结进方案的参考素材缩略 + 角色/提示 + 参考视频解析计数提示。
 */
import Icon from '../../components/common/Icon.vue'
import { REF_ROLE_LABELS } from '../../lib/types'
import type { CreationRef } from '../../lib/types'

defineProps<{ refs: CreationRef[]; videoAnalysisCount: number }>()

const thumbFor = (r: CreationRef): string | null =>
  r.kind === 'image' || r.kind === 'video'
    ? `/api/v1/assets/${r.assetId}/thumb?v=2`
    : null
const refKindIcon = (k: CreationRef['kind']): string =>
  k === 'image' ? 'photo' : k === 'video' ? 'film' : 'doc'
function roleHint(r: CreationRef): string {
  switch (r.role) {
    case 'style':
      return '作为画风 / 主体参考注入图像生成'
    case 'first_frame':
      return r.shotId
        ? `作为镜头 ${r.shotId} 的图生视频首帧`
        : '作为图生视频首帧'
    case 'subject':
      return '用于主体 / 角色跨镜一致性'
    case 'content':
      return '解析视频可见/可听内容以约束方案'
    case 'bgm':
      return '合成期作为背景乐混入（仅用户素材，不额外生成）'
    default:
      return ''
  }
}
</script>

<template>
  <div class="refs">
    <div class="bl">
      参考素材（已冻结进方案 · 确认即执行 · 编辑/删除会使旧确认失效）
    </div>
    <ul class="reft">
      <li v-for="r in refs" :key="r.assetId + ':' + r.role" class="refi">
        <span class="ref-thumb">
          <img
            v-if="thumbFor(r)"
            :src="thumbFor(r) ?? ''"
            :alt="REF_ROLE_LABELS[r.role]"
            loading="lazy"
          />
          <Icon v-else :name="refKindIcon(r.kind)" :size="15" />
        </span>
        <span class="ref-body">
          <span class="ref-role">
            <Icon name="check" :size="11" /> {{ REF_ROLE_LABELS[r.role]
            }}<span v-if="r.shotId" class="ref-shot mono"> · {{ r.shotId }}</span>
          </span>
          <span class="ref-hint muted">{{ roleHint(r) }}</span>
        </span>
        <span class="ref-kind mono">{{ r.kind }}</span>
      </li>
    </ul>
    <p v-if="videoAnalysisCount > 0" class="ref-note">
      <Icon name="alert" :size="11" /> 含
      {{ videoAnalysisCount }} 段参考视频解析（多模态 + 转写），价格依供应商，见上方未计价项。
    </p>
  </div>
</template>

<style scoped>
.refs {
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 11px;
  padding: 12px 14px;
}

.refs > .bl {
  font-size: 12px;
  color: var(--text-2);
  font-weight: 600;
  margin-bottom: 10px;
}

.reft {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.refi {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ref-thumb {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--raised);
  border: 1px solid var(--border);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}

.ref-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.ref-body {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.ref-role {
  font-size: 12.5px;
  color: var(--text);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.ref-role .ic {
  color: var(--run);
}

.ref-shot {
  color: var(--text-3);
}

.ref-hint {
  font-size: 11.5px;
  line-height: 1.5;
}

.ref-kind {
  flex: none;
  font-size: 11px;
  color: var(--text-3);
}

.ref-note {
  margin: 10px 0 0;
  font-size: 11.5px;
  color: var(--warn);
  display: flex;
  gap: 5px;
  align-items: flex-start;
  line-height: 1.5;
}

.ref-note .ic {
  color: var(--warn);
  flex: none;
  margin-top: 1px;
}
</style>
