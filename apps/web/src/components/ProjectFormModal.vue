<script setup lang="ts">
/**
 * 项目表单弹窗（新建 / 编辑双模式）：名称、体裁、默认模板、简介。
 * [优化] 体裁与默认模板弱关联：未手动改过模板时，切体裁预选匹配模板（GENRE_DEFAULT_TPL，命中列表才换）；
 * 编辑模式对字典外的存量体裁值追加临时选项，避免静默改写。
 */
import { computed, onMounted, ref } from 'vue'
import Modal from './Modal.vue'
import { ApiError, projectApi, stylePresetApi, templateApi } from '../lib/api'
import type { ProjectDetail, StylePresetItem, TemplateMeta } from '../lib/types'
import { GENRE_DEFAULT_TPL, PROJECT_GENRES, groupTemplates, normalizeGenre } from '../lib/scene'

const props = defineProps<{ project?: ProjectDetail | null }>()
const emit = defineEmits<{ done: []; close: [] }>()

const isEdit = computed(() => !!props.project)
const templates = ref<TemplateMeta[]>([])
const tplGroups = computed(() => groupTemplates(templates.value))

const name = ref('')
const genre = ref('drama_short')
const tplKey = ref('')
const brief = ref('')
const err = ref('')
const busy = ref(false)
/** 用户在本弹窗内是否手动改过模板（改过后切体裁不再覆盖） */
const tplTouched = ref(false)
/** [M8] 视觉风格绑定：0 = 不使用；预设列表含停用项（绑定残留友好显示） */
const presets = ref<StylePresetItem[]>([])
const stylePresetId = ref(0)

/** 体裁下拉选项：绑定值为字典外存量值时追加临时项（避免静默改写） */
const genreOptions = computed(() => {
  if (genre.value && !PROJECT_GENRES.some((g) => g.value === genre.value)) {
    return [...PROJECT_GENRES, { value: genre.value, label: `${genre.value}（未识别）` }]
  }
  return PROJECT_GENRES
})

/** 绑定的默认模板不在列表中（已删除）→ 追加临时项，避免静默改写 */
const tplMissing = computed(() => !!tplKey.value && !templates.value.some((t) => t.key === tplKey.value))

/** [M8] 当前绑定值不在「启用中」预设里 → 追加临时项（已停用/已删，避免静默改写） */
const presetMissing = computed(
  () => stylePresetId.value > 0 && !presets.value.some((s) => s.id === stylePresetId.value && s.isActive),
)
const boundPreset = computed(() => presets.value.find((s) => s.id === stylePresetId.value) ?? null)
const activePresets = computed(() => presets.value.filter((s) => !!s.isActive))

/** 体裁切换 → 弱关联预选模板（仅未手动改过时；命中列表才换） */
function onGenreChange() {
  if (tplTouched.value) return
  const mapped = GENRE_DEFAULT_TPL[genre.value]
  if (mapped && templates.value.some((t) => t.key === mapped)) tplKey.value = mapped
}

onMounted(async () => {
  // 模板列表自加载（失败不阻塞：新建回退空模板，编辑保留原值）
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
    // [M8] 视觉风格：读 settings.style_preset_id（列表失败保留裸值显示）
    const sid = Number((p.settings ?? {})['style_preset_id'])
    stylePresetId.value = Number.isInteger(sid) && sid > 0 ? sid : 0
    try {
      presets.value = (await stylePresetApi.list()).items
    } catch {
      // 静默：预设列表失败不影响基本提交
    }
  } else {
    // 新建：默认体裁短剧 → 预选映射模板（命中才用），否则回退列表第一个
    const mapped = GENRE_DEFAULT_TPL[genre.value]
    tplKey.value = mapped && templates.value.some((t) => t.key === mapped) ? mapped : (templates.value[0]?.key ?? '')
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
    }
    if (props.project) {
      // [M8] 读-合并写 settings（保留既有其他键；不使用 → null）
      await projectApi.update(props.project.id, {
        ...body,
        settings: {
          ...(props.project.settings ?? {}),
          style_preset_id: stylePresetId.value > 0 ? stylePresetId.value : null,
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
  <Modal :title="isEdit ? '编辑项目' : '新建项目'" :width="560" @close="emit('close')">
    <label class="fld">
      项目名 <span class="req">*</span>
      <input v-model="name" type="text" placeholder="如：萌宝镖客" />
    </label>
    <label class="fld">
      体裁
      <select v-model="genre" @change="onGenreChange">
        <option v-for="g in genreOptions" :key="g.value" :value="g.value">{{ g.label }}</option>
      </select>
    </label>
    <label class="fld">
      默认模板
      <select v-model="tplKey" @change="tplTouched = true">
        <option v-if="tplMissing" :value="tplKey">{{ tplKey }}（已失效）</option>
        <optgroup v-for="g in tplGroups" :key="g.key" :label="g.label">
          <option v-for="t in g.items" :key="t.key" :value="t.key">{{ t.name }}</option>
        </optgroup>
      </select>
    </label>
    <label v-if="isEdit" class="fld">
      视觉风格（分镜图/首帧图/参考图统一注入画风词块）
      <select v-model.number="stylePresetId">
        <option v-if="presetMissing" :value="stylePresetId">
          {{ boundPreset ? `${boundPreset.name}（已停用）` : `预设#${stylePresetId}（已删除）` }}
        </option>
        <option :value="0">不使用（零风格注入）</option>
        <option v-for="s in activePresets" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>
    </label>
    <label class="fld">
      简介 brief
      <textarea v-model="brief" rows="2" placeholder="一句话说明本项目定位（将作为创作上下文）" />
    </label>
    <div v-if="err" class="err-text">{{ err }}</div>
    <template #footer>
      <button class="btn" @click="emit('close')">取消</button>
      <button class="btn primary" :disabled="busy" @click="submit">
        {{ busy ? (isEdit ? '保存中…' : '创建中…') : (isEdit ? '保存' : '创建') }}
      </button>
    </template>
  </Modal>
</template>
