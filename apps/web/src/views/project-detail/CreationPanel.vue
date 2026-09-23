<script setup lang="ts">
/**
 * [对白严格 ASR 开关] 项目详情「创作」分区：人物对白严格 ASR 核验的项目级覆盖。
 * 三态：继承全局默认 / 强制严格（开）/ 强制关闭（免 ASR）。
 * 读-合并-写 projects.settings.dialogue_asr（与品牌 project scope 同构）；未设 = 删除该键（继承）。
 * 分片①：仅落配置读写，尚未接线门禁（实际放行 preflight/dialogue 属后续分片），保存不改变现有出片行为。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { projectApi, settingsApi } from '../../lib/api'
import type { ProjectDetailApi } from './use-project-detail'

const props = defineProps<{ s: ProjectDetailApi }>()
const { projectId, activeTab, loadCore } = props.s

type Mode = 'inherit' | 'strict' | 'off'

const loading = ref(true)
const busy = ref(false)
const err = ref('')
const notice = ref('')

const globalStrict = ref(true) // 全局默认（settings.dialogue_asr.strict）
const overrideStrict = ref<boolean | null>(null) // 项目覆盖（null = 继承）
const mode = ref<Mode>('inherit')

const effectiveStrict = computed(() =>
  overrideStrict.value === null ? globalStrict.value : overrideStrict.value,
)
const effectiveText = computed(() =>
  effectiveStrict.value ? '严格 ASR 核验（开启）' : '免 ASR 创作（关闭）',
)
const sourceText = computed(() =>
  overrideStrict.value === null ? '来源：全局默认' : '来源：本项目覆盖',
)

async function load() {
  loading.value = true
  err.value = ''
  try {
    const [s, p] = await Promise.all([
      settingsApi.list(),
      projectApi.detail(projectId),
    ])
    const g = s.items.find((it) => it.key === 'dialogue_asr')?.value
    globalStrict.value =
      g && typeof g === 'object' && typeof (g as { strict?: unknown }).strict === 'boolean'
        ? (g as { strict: boolean }).strict
        : true
    const ps = (p.project.settings ?? {}) as Record<string, unknown>
    const d = ps['dialogue_asr']
    overrideStrict.value =
      d && typeof d === 'object' && typeof (d as { strict?: unknown }).strict === 'boolean'
        ? (d as { strict: boolean }).strict
        : null
    mode.value =
      overrideStrict.value === null ? 'inherit' : overrideStrict.value ? 'strict' : 'off'
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function save() {
  if (busy.value) return
  busy.value = true
  err.value = ''
  notice.value = ''
  try {
    const p = await projectApi.detail(projectId)
    const settings = { ...((p.project.settings ?? {}) as Record<string, unknown>) }
    if (mode.value === 'inherit') delete settings['dialogue_asr']
    else settings['dialogue_asr'] = { strict: mode.value === 'strict' }
    await projectApi.update(projectId, { settings })
    await load()
    void loadCore({ silent: true })
    notice.value =
      mode.value === 'inherit'
        ? '已清除项目覆盖（回落全局默认）'
        : mode.value === 'strict'
          ? '已保存：本项目强制严格 ASR 核验'
          : '已保存：本项目允许免 ASR 创作（对白免逐字核验、字幕估算）'
    window.setTimeout(() => {
      if (notice.value.startsWith('已')) notice.value = ''
    }, 2500)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

onMounted(load)
// 首次切到「创作」Tab 或从全局改回时重读（全局默认可能在设置页被改动）
watch(activeTab, (t) => {
  if (t === 'creation') void load()
})
</script>

<template>
  <section
    v-show="activeTab === 'creation'"
    role="tabpanel"
    aria-labelledby="ptab-creation"
    class="proj-creation"
  >
    <div class="pc-card panel">
      <div class="pc-head">
        <h3>人物对白严格 ASR 核验</h3>
        <span class="muted">
          对本项目的新建方案生效。默认继承全局设置；此处覆盖仅影响本项目，不改动其它项目与全局默认。
        </span>
      </div>

      <div v-if="loading" class="muted">加载中…</div>
      <template v-else>
        <div class="pc-state">
          当前生效：<strong>{{ effectiveText }}</strong>
          <span class="muted">· {{ sourceText }}</span>
          <span class="muted">· 全局默认：{{ globalStrict ? '严格' : '免 ASR' }}</span>
        </div>

        <div class="pc-radios" role="radiogroup" aria-label="对白严格 ASR 覆盖模式">
          <label class="pc-radio">
            <input v-model="mode" type="radio" value="inherit" :disabled="busy" />
            继承全局默认
          </label>
          <label class="pc-radio">
            <input v-model="mode" type="radio" value="strict" :disabled="busy" />
            强制严格核验（开）
          </label>
          <label class="pc-radio">
            <input v-model="mode" type="radio" value="off" :disabled="busy" />
            强制关闭（免 ASR 创作）
          </label>
        </div>

        <div class="pc-actions">
          <button
            class="btn primary"
            type="button"
            :disabled="busy"
            @click="save"
          >
            {{ busy ? '保存中…' : '保存' }}
          </button>
          <span v-if="notice" class="pc-notice">{{ notice }}</span>
        </div>

        <div class="pc-note muted">
          关闭后：人物对白不再强制 whisper-1 逐字核验，字幕改按批准台词估算时间轴（非实测），但仍强制视频自带原声（对白绝不混
          TTS）。仅影响新建方案，已批准的会话不受影响。
        </div>
      </template>

      <div v-if="err" class="err-text">{{ err }}</div>
    </div>
  </section>
</template>

<style scoped>
.proj-creation {
  max-width: 720px;
}

.pc-card {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.pc-head h3 {
  margin: 0 0 4px;
  font-size: 14px;
}

.pc-state {
  font-size: 13px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
}

.pc-radios {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
}

.pc-radio {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}

.pc-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.pc-notice {
  font-size: 12px;
  color: var(--ok);
}

.pc-note {
  font-size: 11.5px;
  line-height: 1.6;
}
</style>
