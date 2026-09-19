<script setup lang="ts">
/**
 * [M15] 流水线画布页 · 空态引导（views/canvas/index.vue 拆分：M26 红线纯重构，模板/样式逐字搬移）
 * 展示「最近运行 + 模板」快捷入口；点击经 emit 回页面路由跳转（goRun / goTemplate）。
 */
import { runStatus } from '../../lib/format'
import type { Run, TemplateMeta } from '../../lib/types'
import Icon from '../../components/common/Icon.vue'

defineProps<{ runs: Run[]; tplMetas: TemplateMeta[] }>()
const emit = defineEmits<{
  'open-run': [id: number]
  'open-template': [key: string]
}>()
</script>

<template>
  <div class="cv-guide">
    <div class="gd-card panel">
      <Icon name="flow" :size="30" />
      <div class="gd-t">流水线画布</div>
      <p class="muted gd-desc">
        选择一条运行查看实时流水线（状态 / 闸门 / 任务 / 产物，可直接操作），
        或选择一个模板预览编排设计（调度依赖 / 数据引用 / 条件与闸门）。
      </p>
      <div class="gd-sec">
        <div class="gd-h">最近运行</div>
        <div v-if="runs.length" class="chips">
          <button
            v-for="r in runs.slice(0, 8)"
            :key="r.id"
            type="button"
            class="chip chipbtn"
            @click="emit('open-run', r.id)"
          >
            #{{ r.id }} · {{ r.templateKey }} · {{ runStatus(r.status).text }}
          </button>
        </div>
        <div v-else class="muted">暂无运行记录（可从项目页启动一条）</div>
      </div>
      <div class="gd-sec">
        <div class="gd-h">模板</div>
        <div v-if="tplMetas.length" class="chips">
          <button
            v-for="t in tplMetas"
            :key="t.key"
            type="button"
            class="chip chipbtn"
            @click="emit('open-template', t.key)"
          >
            {{ t.name }}
          </button>
        </div>
        <div v-else class="muted">workspace/templates 下暂无模板</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cv-guide {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
  overflow-y: auto;
}

.gd-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  max-width: 640px;
  padding: 26px 28px;
}

.gd-t {
  font-size: 18px;
  font-weight: 700;
}

.gd-desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
}

.gd-sec {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 6px;
}

.gd-h {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.chipbtn {
  cursor: pointer;
  font: inherit;
}

.chipbtn:hover {
  border-color: var(--accent);
  color: #fff;
}
</style>
