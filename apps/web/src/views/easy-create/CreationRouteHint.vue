<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from '../../components/common/Icon.vue'
import type { CreationRouteHintView } from '../../lib/types'

/**
 * 载体路由建议条：方案命中「轻内容能力之外」的意图信号（连载/多角色质感/反推/超长单条）时，
 * 由服务端确定性派生随 plan 消息 payload 透出，本组件只做非阻断展示与升级路径说明。
 * 红线：绝不自动切换执行模板（确认即执行不变量）；无建议时父级不渲染本组件。
 * 「看看怎么升级」按目标分流：episode/series 走毕业通道（成片后一键），其余指到专业端模板建项目。
 */
const props = defineProps<{ hint: CreationRouteHintView }>()

const expanded = ref(false)

// 毕业通道覆盖的两个目标（成片后一键升级专业链）
const graduable = computed(
  () => props.hint.target === 'series-setup' || props.hint.target === 'mengbao-episode',
)
const graduateAction = computed(() =>
  props.hint.target === 'series-setup' ? '立项为连载系列' : '本集升级为专业成片',
)
</script>

<template>
  <div class="ec-route-hint" :class="{ open: expanded }">
    <div class="rh-bar">
      <Icon name="sparkles" :size="13" class="rh-ic" />
      <span class="rh-title">这更像〈{{ hint.label }}〉</span>
      <span class="rh-reason muted">{{ hint.reason }}</span>
      <button class="rh-btn" type="button" @click="expanded = !expanded">
        {{ expanded ? '收起' : '看看怎么升级' }}
      </button>
    </div>
    <div v-if="expanded" class="rh-body">
      <p>
        当前方案仍会按轻松创作正常制作，本建议不改变任何执行内容。想要
        〈{{ hint.label }}〉 的完整能力，可以：
      </p>
      <ol>
        <template v-if="graduable">
          <li>先点「开始制作」拿到本片，完成后在成片页用「{{ graduateAction }}」一键升级专业链（已批准剧本自动作强锚定，不重复计费生成）。</li>
          <li>或到专业端用〈{{ hint.label }}〉模板直接建项目，走完整专业流程。</li>
        </template>
        <template v-else>
          <li>到专业端用〈{{ hint.label }}〉模板建项目，走完整专业流程（本目标的专属链路，轻松创作不做替代）。</li>
        </template>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.ec-route-hint {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 11px;
  border: 1px dashed var(--border);
  border-radius: 10px;
  background: var(--panel-2);
}

.ec-route-hint.open {
  border-style: solid;
}

.rh-bar {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.rh-ic {
  color: var(--accent);
  flex: none;
}

.rh-title {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text);
}

.rh-reason {
  font-size: 11.5px;
  min-width: 0;
}

.rh-btn {
  margin-left: auto;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--panel);
  color: var(--accent);
  font-size: 11.5px;
  font-weight: 600;
  padding: 3px 9px;
  cursor: pointer;
  white-space: nowrap;
}

.rh-btn:hover {
  border-color: var(--accent);
}

.rh-body {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  border-top: 1px solid var(--border);
  padding-top: 7px;
}

.rh-body p {
  margin: 0 0 4px;
}

.rh-body ol {
  margin: 0;
  padding-left: 18px;
}
</style>
