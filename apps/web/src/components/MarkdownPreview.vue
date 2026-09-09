<script setup lang="ts">
import { computed } from 'vue'
import MarkdownIt from 'markdown-it'

const props = defineProps<{ source: string; compact?: boolean }>()

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
const html = computed(() => {
  if (!props.source) return ''
  const body = md.render(props.source)
  return props.compact ? body.replace(/<h[1-6][^>]*>.*?<\/h[1-6]>/gs, (m) => `<div class="md-h">${m.replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/s, '$1')}</div>`) : body
})
</script>

<template>
  <div class="md" v-html="html" />
</template>

<style scoped>
.md {
  font-size: 13.5px;
  line-height: 1.75;
  word-break: break-word;
}

.md :deep(h1),
.md :deep(h2),
.md :deep(h3) {
  margin: 14px 0 8px;
  font-size: 16px;
}

.md :deep(p) {
  margin: 6px 0;
}

.md :deep(ul),
.md :deep(ol) {
  padding-left: 22px;
  margin: 6px 0;
}

.md :deep(li) {
  margin: 3px 0;
}

.md :deep(code) {
  font-family: var(--mono);
  background: #f0f2f5;
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 12px;
}

.md :deep(pre) {
  background: #0f172a;
  color: #e2e8f0;
  border-radius: 8px;
  padding: 12px;
  overflow-x: auto;
}

.md :deep(pre code) {
  background: none;
  color: inherit;
  padding: 0;
}

.md :deep(blockquote) {
  border-left: 3px solid var(--border);
  margin: 8px 0;
  padding: 2px 12px;
  color: var(--text-2);
}

.md :deep(table) {
  border-collapse: collapse;
  margin: 8px 0;
}

.md :deep(th),
.md :deep(td) {
  border: 1px solid var(--border);
  padding: 4px 10px;
  font-size: 12.5px;
}

.md-h {
  font-weight: 600;
  margin: 10px 0 4px;
}

.md-h:not(:first-child) {
  border-top: 1px dashed var(--border);
  padding-top: 8px;
}
</style>
