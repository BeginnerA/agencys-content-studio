<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Icon from '../../components/common/Icon.vue'
import type { CreationPlan, CreationPreflight } from '../../lib/types'
import CreationReviewGate from './CreationReviewGate.vue'
import CreationResolution from './CreationResolution.vue'
import CreationBrand from './CreationBrand.vue'

/**
 * 确认卡「启动方式选项」聚合（审阅闸 + 画质 + 品牌风格）。
 * 三项均为「启动方式」而非执行数据（不入 planHash）：改勾选不作废已确认方案、零计费。
 * 收进一个轻组件的目的：CreationPlanCard 本体已达 ≤800 行红线，将三项的本地状态与预检回落 watch 上移，
 * 令父组件净减行数；父通过 defineExpose 读回 reviewGate / resolution / brandApply（expose 的 ref 自动解包）。
 */
const props = defineProps<{ pf: CreationPreflight | null; plan: CreationPlan | null }>()

// 中途审阅：勾选即本次用带闸门的同构变体模板（easy-video-review），不勾选 = 免审（行为与旧版逐字一致）
const reviewGate = ref(false)
// 画质档位：'' = 模型默认（confirm 不传键）。预检重建后所选档不在新 choices 内 → 清空，不拿旧档撞 422
const resolution = ref('')
// 品牌叠加：默认 on = 继承平台/项目已配品牌；取消 = 本次成片逐次不叠加（仅 false 时 confirm 传键）
const brandApply = ref(true)

watch(
  () => props.pf?.resolutionOptions,
  (o) => {
    if (resolution.value && (!o || !o.choices.includes(resolution.value))) resolution.value = ''
  },
)

const dynamic = computed(() => props.plan?.mode === 'dynamic')
const bgmCount = computed(() => props.plan?.refs.filter((r) => r.role === 'bgm').length ?? 0)
// 免核验对白路线提示：仅预检判定当前对白方案走 estimated 时展示（诚实告知字幕非实测）
const dialogueEstimated = computed(() => props.plan?.performance === 'dialogue' && props.pf?.dialogueMode === 'estimated')

defineExpose({ reviewGate, resolution, brandApply })
</script>

<template>
  <CreationReviewGate v-model="reviewGate" :dynamic="dynamic" />
  <!-- 画质选择：仅 dynamic 且预检透出了已背书档位时展示（slideshow / 无视频实例不现） -->
  <CreationResolution v-if="dynamic && pf?.resolutionOptions" v-model="resolution" :options="pf.resolutionOptions" />
  <!-- 品牌风格：仅平台/项目已配品牌（brandSummary.available）时展示；未配品牌不打扰 -->
  <CreationBrand v-if="pf?.brandSummary?.available" v-model="brandApply" :summary="pf.brandSummary" :bgm-count="bgmCount" />
  <!-- 免核验对白告知条：模型原生出声、字幕按台词估算（非实测），交付前强制人工审阅 -->
  <p v-if="dialogueEstimated" class="ec-est-hint">
    <Icon name="alert" :size="13" /> 免核验对白：由视频模型原生生成人声与口型，字幕按批准台词估算（非实测），成片必须经你收听审阅后才会交付；如需逐字核验可在设置中恢复「严格 ASR 核验」。
  </p>
</template>

<style scoped>
.ec-est-hint {
  margin: 0;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel-2);
  font-size: 11.5px;
  color: var(--text-2);
  line-height: 1.55;
}

.ec-est-hint .ic {
  color: var(--accent-h);
  vertical-align: -2px;
}
</style>
