<script setup lang="ts">
/**
 * 项目表单弹窗（新建 / 编辑双模式）：名称、体裁、默认模板、简介。
 * [优化] 体裁与默认模板弱关联：未手动改过模板时，切体裁预选匹配模板（GENRE_DEFAULT_TPL，命中列表才换）；
 * 编辑模式对字典外的存量体裁值追加临时选项，避免静默改写。
 */
import { computed, onMounted, ref } from 'vue'
import Modal from '../common/Modal.vue'
import {
  ApiError,
  projectApi,
  stylePresetApi,
  templateApi,
} from '../../lib/api'
import type {
  ProjectDetail,
  RecommendItem,
  StylePresetItem,
  TemplateMeta,
} from '../../lib/types'
import {
  filterSelectable,
  GENRE_DEFAULT_TPL,
  PROJECT_GENRES,
  groupTemplates,
  normalizeGenre,
} from '../../lib/scene'

const props = defineProps<{ project?: ProjectDetail | null }>()
const emit = defineEmits<{ done: []; close: [] }>()

const isEdit = computed(() => !!props.project)
const templates = ref<TemplateMeta[]>([])
// [入口收口] 下拉选项只列可手动启动的模板（剔除 conversationOnly）；templates 仍存全量供反查名字/回填
const tplGroups = computed(() => groupTemplates(filterSelectable(templates.value)))
// 当前绑定项为轻松创作专用（不在选项内）→ 单列一条如实标注的选项，避免被误标「已失效」
const boundConversationTpl = computed(() =>
  templates.value.find((t) => t.key === tplKey.value && t.conversationOnly),
)

const name = ref('')
const genre = ref('drama_short')
const tplKey = ref('')
const brief = ref('')
/** [M21] 标签（逗号 / 顿号分隔；提交时拆分为数组去重） */
const tagsInput = ref('')
const err = ref('')
const busy = ref(false)
/** 用户在本弹窗内是否手动改过模板（改过后切体裁不再覆盖） */
const tplTouched = ref(false)
/** [M13] 视觉风格多选绑定：勾选 id 数组（叠加顺序 = 数组顺序）；预设列表含停用项（绑定残留友好显示） */
const presets = ref<StylePresetItem[]>([])
const stylePresetIds = ref<number[]>([])

/** [M35 G7] brief → 自然语言推荐模板（embedding 零成本、失败回落关键词）；仅新建成交展示，编辑不干预既有选择 */
const recommends = ref<RecommendItem[]>([])
const recommendReady = ref(false)
let recTimer: ReturnType<typeof setTimeout> | null = null
async function fireRecommend(text: string): Promise<void> {
  const t = text.trim()
  if (!t || t.length < 4) {
    recommends.value = []
    recommendReady.value = false
    return
  }
  try {
    const r = await templateApi.recommend(t, 3)
    recommends.value = r.items
    recommendReady.value = r.ready
  } catch {
    // 静默：推荐为增量能力，失败不影响表单填写
    recommends.value = []
    recommendReady.value = false
  }
}
function onBriefInput(): void {
  if (isEdit.value) return
  if (recTimer) clearTimeout(recTimer)
  recTimer = setTimeout(() => void fireRecommend(brief.value), 500)
}
function applyRecommend(key: string): void {
  tplKey.value = key
  tplTouched.value = true
}

/** 体裁下拉选项：绑定值为字典外存量值时追加临时项（避免静默改写） */
const genreOptions = computed(() => {
  if (genre.value && !PROJECT_GENRES.some((g) => g.value === genre.value)) {
    return [
      ...PROJECT_GENRES,
      { value: genre.value, label: `${genre.value}（未识别）` },
    ]
  }
  return PROJECT_GENRES
})

/** 绑定的默认模板不在列表中（已删除）→ 追加临时项，避免静默改写 */
const tplMissing = computed(
  () => !!tplKey.value && !templates.value.some((t) => t.key === tplKey.value),
)

/** [M13] 启用中预设（按 sortOrder 展示；勾选叠加顺序 = 数组顺序） */
const activePresets = computed(() =>
  presets.value
    .filter((s) => !!s.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
)

/** [M13] 绑定值不在「启用中」预设里 → 追加可取消条目（已停用/已删，避免静默改写） */
const missingBound = computed(() =>
  stylePresetIds.value
    .filter((id) => !presets.value.some((s) => s.id === id && !!s.isActive))
    .map((id) => {
      const p = presets.value.find((s) => s.id === id)
      return { id, label: p ? `${p.name}（已停用）` : `预设#${id}（已删除）` }
    }),
)

/** 体裁切换 → 弱关联预选模板（仅未手动改过时；命中列表才换） */
function onGenreChange() {
  if (tplTouched.value) return
  const mapped = GENRE_DEFAULT_TPL[genre.value]
  if (mapped && templates.value.some((t) => t.key === mapped))
    tplKey.value = mapped
}

onMounted(async () => {
  // 模板列表自加载（失败不阻塞：新建回退空模板，编辑保留原值）
  // [入口收口] 全量拉取（含 conversationOnly 标记）：下拉选项由 tplGroups 过滤，但保留全量以正确反查名字/回填老项目的 easy-* 默认模板。
  try {
    const t = await templateApi.list()
    templates.value = t.items
  } catch {
    // 静默：模板列表失败不影响基本提交
  }
  const p = props.project
  if (p) {
    name.value = p.name
    genre.value = normalizeGenre(p.genre)
    brief.value = p.brief ?? ''
    tplKey.value = p.templateKey ?? ''
    tagsInput.value = (p.tags ?? []).join('，')
    // [M13] 视觉风格：读 settings.style_preset_ids（数组优先；回退旧单值键；列表失败保留裸值显示）
    const st = p.settings ?? {}
    const rawIds: unknown[] = Array.isArray(st['style_preset_ids'])
      ? st['style_preset_ids']
      : st['style_preset_id'] !== undefined
        ? [st['style_preset_id']]
        : []
    stylePresetIds.value = [
      ...new Set(
        rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0),
      ),
    ]
    try {
      presets.value = (await stylePresetApi.list()).items
    } catch {
      // 静默：预设列表失败不影响基本提交
    }
  } else {
    // 新建：默认体裁短剧 → 预选映射模板（命中才用），否则回退列表第一个
    const mapped = GENRE_DEFAULT_TPL[genre.value]
    tplKey.value =
      mapped && templates.value.some((t) => t.key === mapped)
        ? mapped
        : (templates.value[0]?.key ?? '')
  }
})

async function submit() {
  if (!name.value.trim()) {
    err.value = '请填写项目名'
    return
  }
  busy.value = true
  err.value = ''
  try {
    const body = {
      name: name.value.trim(),
      brief: brief.value.trim(),
      genre: genre.value,
      template_key: tplKey.value || undefined,
      tags: [
        ...new Set(
          tagsInput.value
            .split(/[,，、]/)
            .map((t) => t.trim())
            .filter(Boolean),
        ),
      ],
    }
    if (props.project) {
      // [M13] 读-合并写 settings（保留既有其他键；无勾选 → null + 显式清理旧单值键）
      await projectApi.update(props.project.id, {
        ...body,
        settings: {
          ...(props.project.settings ?? {}),
          style_preset_ids:
            stylePresetIds.value.length > 0 ? stylePresetIds.value : null,
          style_preset_id: null,
        },
      })
    } else {
      await projectApi.create(body)
    }
    emit('done')
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal
    :title="isEdit ? '编辑项目' : '新建项目'"
    :width="560"
    @close="emit('close')"
  >
    <label class="fld">
      项目名 <span class="req">*</span>
      <input v-model="name" type="text" placeholder="如：萌宝镖客" />
    </label>
    <label class="fld">
      体裁
      <select v-model="genre" @change="onGenreChange">
        <option v-for="g in genreOptions" :key="g.value" :value="g.value">
          {{ g.label }}
        </option>
      </select>
    </label>
    <label class="fld">
      默认模板
      <select v-model="tplKey" @change="tplTouched = true">
        <option v-if="tplMissing" :value="tplKey">
          {{ tplKey }}（已失效）
        </option>
        <option
          v-if="boundConversationTpl"
          :value="boundConversationTpl.key"
        >
          {{ boundConversationTpl.name }}（轻松创作专用·由对话页管理）
        </option>
        <optgroup v-for="g in tplGroups" :key="g.key" :label="g.label">
          <option v-for="t in g.items" :key="t.key" :value="t.key">
            {{ t.name }}
          </option>
        </optgroup>
      </select>
    </label>
    <!-- [M35 G7] brief 推荐命中（前 3）：点击徽标预设 tplKey；不自动改选，避免静默覆盖 -->
    <div v-if="recommends.length && !isEdit" class="rec-bar">
      <span class="rec-lead muted">
        ✦ 根据简介推荐
        <span v-if="!recommendReady" class="rec-tag">关键词回落</span>
      </span>
      <button
        v-for="r in recommends"
        :key="r.key"
        class="rec-chip"
        type="button"
        :class="{ on: tplKey === r.key }"
        :title="`score ${r.score.toFixed(2)}・点击预设`"
        @click="applyRecommend(r.key)"
      >
        {{ r.name }}
      </button>
    </div>
    <div v-if="isEdit" class="fldbox">
      视觉风格（可多选；分镜图/首帧图/参考图按勾选顺序拼接注入画风词块）
      <div class="preset-box">
        <label v-for="s in activePresets" :key="s.id" class="prow">
          <input v-model="stylePresetIds" type="checkbox" :value="s.id" />
          <span class="pnm">{{ s.name }}</span>
          <span class="psnip muted">{{ s.snippet }}</span>
        </label>
        <label v-for="m in missingBound" :key="`m${m.id}`" class="prow">
          <input v-model="stylePresetIds" type="checkbox" :value="m.id" />
          <span class="pnm">{{ m.label }}</span>
        </label>
        <div
          v-if="!activePresets.length && !missingBound.length"
          class="muted"
          style="font-size: 12px"
        >
          预设库为空：先到「风格预设」页新建画风词块
        </div>
      </div>
    </div>
    <label class="fld">
      标签（逗号分隔；用于列表筛选与全局搜索）
      <input
        v-model="tagsInput"
        type="text"
        placeholder="如：萌宝，民国，镖局"
      />
    </label>
    <label class="fld">
      简介 brief
      <textarea
        v-model="brief"
        rows="2"
        placeholder="一句话说明本项目定位（将作为创作上下文）"
        @input="onBriefInput"
      />
    </label>
    <div v-if="err" class="err-text">{{ err }}</div>
    <template #footer>
      <button class="btn" @click="emit('close')">取消</button>
      <button class="btn primary" :disabled="busy" @click="submit">
        {{ busy ? (isEdit ? '保存中…' : '创建中…') : isEdit ? '保存' : '创建' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
/* [M13] 风格多选面板：替代旧单选 select；勾选顺序即注入顺序 */
.fldbox {
  display: block;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--text-2);
}

.preset-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 5px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel-2);
  max-height: 180px;
  overflow-y: auto;
}

.prow {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 400;
  cursor: pointer;
}

.prow .pnm {
  flex: none;
  font-size: 13px;
  color: var(--text);
}

.prow .psnip {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* [M35 G7] brief 推荐 chips */
.rec-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: -4px 0 12px;
  font-size: 12px;
}
.rec-lead {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-3);
}
.rec-tag {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--warn-weak, rgb(245 158 11 / 12%));
  color: var(--warn, #b45309);
  font-size: 10.5px;
}
.rec-chip {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  font: inherit;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel-2);
  color: var(--text);
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.rec-chip:hover {
  border-color: rgb(99 102 241 / 45%);
}
.rec-chip.on {
  border-color: var(--brand, #6366f1);
  background: rgb(99 102 241 / 12%);
  font-weight: 600;
}
</style>
