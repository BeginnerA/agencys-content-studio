<script setup lang="ts">
/**
 * 成片字幕烧录开关（run 级 _compose.subtitleBurn 的可复用勾选）。
 * 一处组件收口三处通用「重新合成」入口：运行详情合成卡 / 节点抽屉 / 合成设置弹窗。
 * - 单一真源：读回显 + 写落库都走 composeApi（getConfig/updateConfig），与轻松创作确认卡、
 *   ffmpeg-merge 烧录门同一 _compose 键——切换后点「重新合成」即进入成片（零计费、本地合成）。
 * - 自治回显：挂载拉一次 config；非终态 run（getConfig 会 409）或加载失败 → 自动隐藏，不打扰、不报错。
 * - 关 = 成片画面不含硬字幕，字幕文件（.srt）仍生成可单独下载；仅切断烧录，不动严格交付校验。
 */
import { onMounted, ref } from 'vue'
import { composeApi } from '../../lib/api'
import Icon from '../common/Icon.vue'

const props = defineProps<{ runId: number; disabled?: boolean }>()

const show = ref(false)
const on = ref(true)
const busy = ref(false)
const tip = ref('')

onMounted(async () => {
  try {
    const c = await composeApi.getConfig(props.runId)
    on.value = c.config.subtitleBurn !== false
    show.value = true
  } catch {
    // 活跃 / 不可编辑 run：此刻重新合成亦不可用，隐藏开关
    show.value = false
  }
})

async function toggle(v: boolean): Promise<void> {
  if (busy.value) return
  busy.value = true
  tip.value = ''
  const prev = on.value
  on.value = v
  try {
    await composeApi.updateConfig(props.runId, { subtitleBurn: v })
    tip.value = v
      ? '已开启：重新合成后成片含硬字幕'
      : '已关闭：重新合成后成片不含字幕（字幕文件仍生成，可单独下载）'
  } catch (e) {
    on.value = prev
    tip.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <label
    v-if="show"
    class="sbt"
    :title="
      on
        ? '成片烧录硬字幕；取消后重新合成成片不含字幕'
        : '已关闭：重新合成后成片不含字幕（字幕文件仍生成，可单独下载）'
    "
  >
    <input
      type="checkbox"
      :checked="on"
      :disabled="busy || disabled"
      aria-label="在成片烧录字幕"
      @change="toggle(($event.target as HTMLInputElement).checked)"
    />
    <span class="sbt-t"><Icon name="doc" :size="13" /> 成片字幕</span>
    <span v-if="tip" class="sbt-tip muted">{{ tip }}</span>
  </label>
</template>

<style scoped>
.sbt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 6px;
  font-size: 12.5px;
  cursor: pointer;
  user-select: none;
}
.sbt input {
  width: 15px;
  height: 15px;
  accent-color: var(--accent);
  cursor: pointer;
}
.sbt-t {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.sbt-tip {
  font-size: 11.5px;
}
</style>
