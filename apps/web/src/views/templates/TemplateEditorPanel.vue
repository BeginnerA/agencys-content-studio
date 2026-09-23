<script setup lang="ts">
import { useRouter } from 'vue-router'
import TemplateGuidePanel from './TemplateGuidePanel.vue'
import TemplateEditPanel from './TemplateEditPanel.vue'
import TemplateInfoPanel from './TemplateInfoPanel.vue'
import Icon from '../../components/common/Icon.vue'
import type { TemplatesApi } from './use-templates'

const props = defineProps<{ t: TemplatesApi }>()
const {
  selected,
  mode,
  helpDlg,
  yamlText,
  detail,
  loadErr,
  actionErr,
  dirty,
  currentBuiltin,
  toGuide,
  toEdit,
  openCopy,
  removeTemplate,
} = props.t

const router = useRouter()
</script>

<template>
  <section class="panel editor">
    <div v-if="!selected" class="empty" style="padding: 80px 0">
      左侧选择一个模板，查看它做什么、要填什么、怎么运行
    </div>
    <template v-else>
      <div class="ehead">
        <span class="tt">{{ detail?.name ?? selected }}</span>
        <span class="kk mono">{{ selected }}</span>
        <span
          v-if="detail"
          class="badge"
          :class="dirty ? 'queued' : 'succeeded'"
          >{{ dirty ? '未保存' : '已同步' }}</span
        >
        <span
          v-if="currentBuiltin"
          class="badge"
          title="系统内置模板·只读，不可修改/删除；如需定制请「另存为副本」"
          >内置·只读</span
        >
        <span v-if="detail" class="muted"
          >v{{ detail.version }} · {{ detail.steps.length }} 步</span
        >
        <div class="acts">
          <button
            v-if="mode === 'guide'"
            class="btn primary sm"
            :title="currentBuiltin ? '系统内置模板不可直接编辑，请先另存为副本' : '打开 YAML 编辑器（高级模式）'"
            :disabled="currentBuiltin"
            @click="toEdit"
          >
            <Icon name="pencil" :size="12" /> 编辑 YAML
          </button>
          <button
            v-if="mode === 'edit'"
            class="btn sm"
            title="切回说明书视图（编辑内容保留）"
            @click="toGuide"
          >
            <Icon name="eye" :size="12" /> 返回说明
          </button>
          <button
            class="btn sm"
            title="查看全部 YAML 字段的用途说明"
            @click="helpDlg = true"
          >
            <Icon name="sliders" :size="12" /> 字段速查
          </button>
          <button
            class="btn sm"
            title="以当前内容创建新模板"
            :disabled="!yamlText"
            @click="openCopy"
          >
            <Icon name="copy" :size="12" /> 另存为副本
          </button>
          <button
            class="btn sm"
            title="在流水线画布中预览编排设计（依赖边 / 数据引用 / 条件与闸门）"
            @click="router.push(`/canvas?template=${selected}`)"
          >
            <Icon name="flow" :size="12" /> 画布
          </button>
          <button
            v-if="!currentBuiltin"
            class="btn sm danger"
            title="删除模板文件（不可撤销）"
            @click="removeTemplate(selected, detail?.name ?? selected)"
          >
            <Icon name="trash" :size="12" /> 删除
          </button>
        </div>
      </div>
      <div v-if="loadErr" class="err-text">{{ loadErr }}</div>
      <div v-if="actionErr" class="err-text">{{ actionErr }}</div>

      <!-- ===== 说明书视图（默认）：这个模板做什么 / 填什么 / 跑什么 ===== -->
      <template v-if="mode === 'guide'">
        <TemplateGuidePanel :t="t" />
      </template>

      <!-- ===== YAML 高级编辑 ===== -->
      <template v-else>
        <TemplateEditPanel :t="t" />

        <!-- 只读信息：inputs 声明表 + steps 流程图 -->
        <TemplateInfoPanel :t="t" />
      </template>
    </template>
  </section>
</template>

<style scoped>
/* ---------- 编辑器区 ---------- */
.editor {
  flex: 1;
  min-width: 0;
  padding: 14px;
  /* 与左侧模板列表（max-height: calc(100vh - 130px)）等高，两栏对齐；内容超出时面板内部滚动 */
  height: calc(100vh - 130px);
  overflow-y: auto;
}

.ehead {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.ehead .tt {
  font-size: 14.5px;
  font-weight: 700;
}

.ehead .kk {
  font-size: 12px;
  color: var(--text-3);
}

.ehead .acts {
  margin-left: auto;
  display: inline-flex;
  gap: 8px;
}
</style>
