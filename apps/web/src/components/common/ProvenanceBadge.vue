<script setup lang="ts">
/**
 * 自动值来源可追溯徽标（纯展示，无状态无 emit）
 * 统一 – 各触点散落的「为何是这个值」标注：一个组件、四类语义、一套视觉。
 * 文案纪律（拍板）：对用户不暴露内部术语 Tier A/B——
 *   auto=自动（系统直接填入，可改）· endorse=背书（平台真源表担保，免手填核实）
 *   suggest=建议（仅提示未执行，需人工采纳）· builtin=内置（代码级兜底，文件缺失时）
 * 色板与全局 token 同源（accent / ok / warn 系列），不引入新色值。
 */
withDefaults(
  defineProps<{
    /** 来源语义分类（决定前缀词与色板） */
    kind: 'auto' | 'endorse' | 'suggest' | 'builtin'
    /** 来源短语，如「沿用上次运行」→ 渲染为「自动 · 沿用上次运行」 */
    text: string
    /** hover 详情（定价核实锚点、供应商/模型名等长信息收进这里） */
    title?: string
  }>(),
  { title: undefined },
)

const PREFIX: Record<'auto' | 'endorse' | 'suggest' | 'builtin', string> = {
  auto: '自动',
  endorse: '背书',
  suggest: '建议',
  builtin: '内置',
}
</script>

<template>
  <span class="prov" :class="kind" :title="title" :aria-label="`${PREFIX[kind]} · ${text}`">
    <i class="prov-prefix">{{ PREFIX[kind] }}</i>
    <span class="prov-sep" aria-hidden="true">·</span>
    <span class="prov-text">{{ text }}</span>
  </span>
</template>

<style scoped>
.prov {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  font-size: 10px;
  line-height: 1.6;
  vertical-align: 1px;
  white-space: nowrap;
  cursor: default;
}
.prov-prefix {
  font-style: normal;
  font-weight: 600;
}
.prov-sep {
  opacity: 0.55;
}
/* auto：系统直接填入（靛紫，与既有 .src-chip 同族） */
.prov.auto {
  color: var(--accent-h);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
}
/* endorse：真源表背书（绿 = 已担保） */
.prov.endorse {
  color: var(--ok);
  background: var(--ok-weak);
  border-color: color-mix(in srgb, var(--ok) 35%, transparent);
}
/* suggest：仅建议未执行（琥珀 = 需人工确认） */
.prov.suggest {
  color: var(--warn);
  background: var(--warn-weak);
  border-color: color-mix(in srgb, var(--warn) 35%, transparent);
}
/* builtin：代码级兜底（中性灰 = 非用户数据） */
.prov.builtin {
  color: var(--text-2);
  background: var(--hover);
  border-color: var(--border-strong);
}
</style>
