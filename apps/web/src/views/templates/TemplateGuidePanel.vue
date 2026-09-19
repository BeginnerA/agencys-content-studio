<script setup lang="ts">
import {
  kindText,
  fmtDefault,
  stepBadgesOf,
  GUIDE_BADGE_TEXT,
} from './internals'
import Icon from '../../components/common/Icon.vue'
import { SCENE_LABELS, genreText } from '../../lib/scene'
import { actionText } from '../../lib/template-dict'
import type { TemplatesApi } from './use-templates'

const props = defineProps<{ t: TemplatesApi }>()
const { selected, detail, toEdit } = props.t
</script>

<template>
  <template v-if="detail">
    <p class="vdesc">{{ detail.description || '（模板未写介绍）' }}</p>
    <div class="vmeta">
      <span class="chip">{{ genreText(detail.genre) }}</span>
      <span v-if="detail.scene" class="chip">{{
        SCENE_LABELS[detail.scene] ?? detail.scene
      }}</span>
      <span class="chip">v{{ detail.version }}</span>
      <span class="chip">{{ detail.steps.length }} 步</span>
    </div>

    <div class="ih">启动时要填什么</div>
    <table v-if="detail.inputs.length" class="tbl">
      <thead>
        <tr>
          <th>字段</th>
          <th>问题</th>
          <th>类型</th>
          <th>必填</th>
          <th>默认</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="inp in detail.inputs" :key="inp.key">
          <td class="mono">{{ inp.key }}</td>
          <td>{{ inp.label ?? '—' }}</td>
          <td>{{ kindText(inp.kind) }}</td>
          <td>{{ inp.required ? '是' : '否' }}</td>
          <td class="mono">{{ fmtDefault(inp.default) }}</td>
        </tr>
      </tbody>
    </table>
    <div v-else class="muted">此模板不需要填写内容，选中它直接启动即可。</div>

    <div class="ih">流水线会做什么</div>
    <ol class="steplist" role="list">
      <li v-for="(s, i) in detail.steps" :key="s.key" class="step">
        <span class="s-idx">{{ i + 1 }}</span>
        <div class="s-r1">
          <span class="s-title">{{ s.title }}</span>
          <span class="s-act">{{ actionText(s.action) }}</span>
          <span
            v-for="(bd, bi) in stepBadgesOf(s)"
            :key="bi"
            class="s-bd"
            :class="bd.cls"
            :title="bd.tip"
            >{{ GUIDE_BADGE_TEXT[bd.cls] }}</span
          >
        </div>
      </li>
    </ol>

    <div class="ebar">
      <span class="muted"
        >模板文件：workspace/templates/{{ selected }}.yaml ·
        保存后下一个新运行立即生效</span
      >
      <button
        class="btn primary"
        title="打开 YAML 编辑器（高级模式）"
        @click="toEdit"
      >
        <Icon name="pencil" :size="13" /> 编辑 YAML
      </button>
    </div>
  </template>
</template>

<style scoped>
.ebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
}

/* ---------- [说明书改造] 说明书视图 ---------- */
.vdesc {
  font-size: 13px;
  line-height: 1.75;
  color: var(--text-2);
  margin: 0;
}

.vmeta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0 2px;
}

.steplist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}

.step {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 9px 12px;
}

.s-idx {
  flex: none;
  width: 21px;
  height: 21px;
  margin-top: 1px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  color: #a5b4fc;
  background: rgb(99 102 241 / 14%);
}

.s-r1 {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.s-title {
  font-size: 13px;
  font-weight: 600;
}

.s-act {
  font-size: 11.5px;
  color: var(--text-3);
}

.s-bd {
  font-size: 10.5px;
  line-height: 1.7;
  padding: 0 7px;
  border-radius: 5px;
  border: 1px solid transparent;
}

.s-bd.gate {
  color: #c4b5fd;
  border-color: rgb(167 139 250 / 45%);
  background: rgb(139 92 246 / 16%);
}

.s-bd.batch {
  color: #86efac;
  border-color: rgb(74 222 128 / 45%);
  background: rgb(34 197 94 / 14%);
}

.s-bd.when,
.s-bd.any {
  color: #fcd34d;
  border-color: rgb(251 191 36 / 45%);
  background: rgb(245 158 11 / 14%);
}

.ih {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-2);
  margin: 14px 0 8px;
}
</style>
