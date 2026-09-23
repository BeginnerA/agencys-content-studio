<script setup lang="ts">
/**
 * [M36·G12.2 / G12.3] 合规词库视图 + 补充建议采纳
 * - 词库只读视图：GET /compliance/rules（source='file' 在位 / 'builtin' 缺失兜底基准地板）
 * - 补充建议（Tier B）：从既有已付费复审结论聚合候选新词（零新 LLM 计费），勾选后一键追加进词库
 * 不猜测/保留人工：建议一律 warn 起步（升 block 属法务判断）；追加只增不覆盖、去重。
 */
import { computed, onMounted, ref } from 'vue'
import Icon from '../../components/common/Icon.vue'
import ProvenanceBadge from '../../components/common/ProvenanceBadge.vue'
import { complianceApi, projectApi } from '../../lib/api'
import type { ComplianceRulesView, Project, SuggestedRule } from '../../lib/types'

const loading = ref(true)
const err = ref('')
const msg = ref('')

const projects = ref<Project[]>([])
const projectId = ref<number | ''>('')

const view = ref<ComplianceRulesView | null>(null)
const suggestions = ref<SuggestedRule[]>([])
const selected = ref<Set<string>>(new Set())
const loadingSuggest = ref(false)
const adopting = ref(false)

const catList = computed(() =>
  view.value ? Object.entries(view.value.byCategory).sort((a, b) => b[1] - a[1]) : [],
)

function keyOf(r: SuggestedRule): string {
  return `${r.category}\u0000${r.word}`
}

async function loadRules() {
  err.value = ''
  try {
    view.value = await complianceApi.rules()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

async function loadSuggest() {
  loadingSuggest.value = true
  err.value = ''
  msg.value = ''
  selected.value = new Set()
  try {
    const r = await complianceApi.suggest(projectId.value === '' ? undefined : (projectId.value as number))
    suggestions.value = r.items
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loadingSuggest.value = false
  }
}

function toggle(r: SuggestedRule) {
  const k = keyOf(r)
  if (selected.value.has(k)) selected.value.delete(k)
  else selected.value.add(k)
}

function toggleAll() {
  if (selected.value.size === suggestions.value.length) selected.value = new Set()
  else selected.value = new Set(suggestions.value.map(keyOf))
}

async function adopt() {
  const picked = suggestions.value.filter((r) => selected.value.has(keyOf(r)))
  if (!picked.length) return
  adopting.value = true
  err.value = ''
  msg.value = ''
  try {
    const r = await complianceApi.appendRules(
      picked.map((p) => ({ category: p.category, word: p.word, level: p.level })),
    )
    msg.value = `已追加 ${r.added} 条新词进词库（当前词库 ${r.total} 条）`
    await loadRules()
    await loadSuggest()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    adopting.value = false
  }
}

onMounted(async () => {
  loading.value = true
  try {
    const [pr] = await Promise.all([projectApi.list(), loadRules()])
    projects.value = pr.items
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="compliance-panel">
    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="loading" class="empty">加载中…</div>

    <template v-if="!loading">
      <!-- 词库视图 -->
      <div class="panel cp-view">
        <div class="cp-header">
          <h3><Icon name="check" :size="15" /> 合规词库</h3>
          <!-- [M37·G13] 统一徽标：仅兜底时提示（用户自有词库非「自动值」，不加噪） -->
          <ProvenanceBadge
            v-if="view?.source === 'builtin'"
            kind="builtin"
            text="基准词库兜底"
            title="词库文件缺失，已启用内置《广告法》基准地板兜底（补齐后自动恢复用户词库）"
          />
        </div>
        <div class="cp-total">
          共 <strong>{{ view?.total ?? 0 }}</strong> 条规则
        </div>
        <div v-if="catList.length" class="cp-cats">
          <span v-for="[c, n] in catList" :key="c" class="cat">
            {{ c }} <b>{{ n }}</b>
          </span>
        </div>
      </div>

      <!-- 补充建议 -->
      <div class="panel cp-suggest">
        <div class="cp-header">
          <h3>
            <Icon name="sparkles" :size="15" /> 词库补充建议
            <ProvenanceBadge
              kind="suggest"
              text="复审结论聚合"
              title="候选词来自已付费的合规复审产物（零新计费）；仅提示未执行，需人工勾选采纳"
            />
          </h3>
          <div class="cp-tools">
            <select v-model="projectId">
              <option value="">全域项目</option>
              <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <button class="btn primary sm" :disabled="loadingSuggest" @click="loadSuggest">
              <Icon name="sparkles" :size="12" /> {{ loadingSuggest ? '聚合中…' : '生成建议' }}
            </button>
          </div>
        </div>
        <p class="muted sm">
          从既有合规复审结论中聚合高频风险词（零新计费）。建议一律 warn 起步，是否升级为 block 属法务人工判断。
        </p>

        <div v-if="suggestions.length" class="cp-sg-actions">
          <button class="btn sm" @click="toggleAll">
            {{ selected.size === suggestions.length ? '取消全选' : '全选' }}
          </button>
          <button
            class="btn sm primary"
            :disabled="adopting || !selected.size"
            @click="adopt"
          >
            {{ adopting ? '追加中…' : `采纳选中 ${selected.size} 条` }}
          </button>
        </div>

        <table v-if="suggestions.length" class="tbl">
          <thead>
            <tr>
              <th style="width: 34px"></th>
              <th>类别</th>
              <th>候选词</th>
              <th>级别</th>
              <th>次数</th>
              <th>依据</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in suggestions" :key="keyOf(r)">
              <td>
                <input type="checkbox" :checked="selected.has(keyOf(r))" @change="toggle(r)" />
              </td>
              <td>{{ r.category }}</td>
              <td><strong>{{ r.word }}</strong></td>
              <td class="muted">{{ r.level }}</td>
              <td class="mono">{{ r.times }}</td>
              <td class="sm muted">{{ r.evidence }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else-if="!loadingSuggest" class="empty sm" style="padding: 12px 0">
          暂无可聚合的新词建议（需先有合规复审产物）。点击「生成建议」聚合。
        </div>

        <div v-if="msg" class="cp-msg ok">{{ msg }}</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.compliance-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.cp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  gap: 12px;
}
.cp-header h3 {
  margin: 0;
  font-size: 15px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.sm {
  font-size: 12px;
}
.muted {
  color: var(--text-3);
}
.mono {
  font-family: var(--mono, monospace);
}
.cp-total {
  font-size: 13px;
  margin-bottom: 8px;
}
.cp-cats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.cat {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 6px;
  background: var(--code-bg);
  border: 1px solid var(--border);
  color: var(--text-2);
}
.cat b {
  color: var(--text);
}
.cp-tools {
  display: flex;
  gap: 8px;
  align-items: center;
}
.cp-tools select {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 2px 10px;
  line-height: 1.4;
  color: var(--text);
  font-size: 12px;
}
.cp-sg-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
.cp-msg.ok {
  margin-top: 10px;
  font-size: 12px;
  color: var(--ok, #16a34a);
}
.err-text {
  color: var(--danger, #dc2626);
  font-size: 12px;
}
.tbl td {
  vertical-align: top;
}
</style>
