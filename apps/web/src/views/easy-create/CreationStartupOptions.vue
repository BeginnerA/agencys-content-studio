<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CreationPlan, CreationPreflight } from '../../lib/types'
import CreationReviewGate from './CreationReviewGate.vue'
import CreationResolution from './CreationResolution.vue'
import CreationBrand from './CreationBrand.vue'

/**
 * [M45] 确认卡「启动方式选项」聚合（审阅闸 + 画质 + 品牌风格）。
 * 三项均为「启动方式」而非执行数据（不入 planHash）：改勾选不作废已确认方案、零计费。
 * 收进一个轻组件的目的：CreationPlanCard 本体已达 ≤800 行红线，将三项的本地状态与预检回落 watch 上移，
 * 令父组件净减行数；父通过 defineExpose 读回 reviewGate / resolution / brandApply（expose 的 ref 自动解包）。
 */
const props = defineProps<{ pf: CreationPreflight | null; plan: CreationPlan | null }>()

// [M42] 中途审阅：勾选即本次用带闸门的同构变体模板（easy-video-review），不勾选 = 免审（行为与旧版逐字一致）
const reviewGate = ref(false)
// [M43] 画质档位：'' = 模型默认（confirm 不传键）。预检重建后所选档不在新 choices 内 → 清空，不拿旧档撞 422
const resolution = ref('')
// [M45] 品牌叠加：默认 on = 继承平台/项目已配品牌；取消 = 本次成片逐次不叠加（仅 false 时 confirm 传键）
const brandApply = ref(true)

watch(
  () => props.pf?.resolutionOptions,
  (o) => {
    if (resolution.value && (!o || !o.choices.includes(resolution.value))) resolution.value = ''
  },
)

const dynamic = computed(() => props.plan?.mode === 'dynamic')
const bgmCount = computed(() => props.plan?.refs.filter((r) => r.role === 'bgm').length ?? 0)

defineExpose({ reviewGate, resolution, brandApply })
</script>

<template>
  <CreationReviewGate v-model="reviewGate" :dynamic="dynamic" />
  <!-- [M43] 画质选择：仅 dynamic 且预检透出了已背书档位时展示（slideshow / 无视频实例不现） -->
  <CreationResolution v-if="dynamic && pf?.resolutionOptions" v-model="resolution" :options="pf.resolutionOptions" />
  <!-- [M45] 品牌风格：仅平台/项目已配品牌（brandSummary.available）时展示；未配品牌不打扰 -->
  <CreationBrand v-if="pf?.brandSummary?.available" v-model="brandApply" :summary="pf.brandSummary" :bgm-count="bgmCount" />
</template>
