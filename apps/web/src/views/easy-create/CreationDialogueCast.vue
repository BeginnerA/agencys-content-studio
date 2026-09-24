<script setup lang="ts">
import { computed } from 'vue'
import Icon from '../../components/common/Icon.vue'
import type { CreationPlan, CreationCast } from '../../lib/types'

/**
 * 对白方案卡补充区：角色表（声线描述 / 外貌）+ 按镜发言者与台词。
 * 独立轻组件（方案卡本体已近长度红线）；只读投影，不新增编辑能力，不改任何旁白/图文呈现。
 * 台词按镜头播放顺序展示真实文本与发言角色，供用户核对「谁在说、说什么」后再确认制作。
 */
const props = defineProps<{ plan: CreationPlan }>()

const cast = computed<CreationCast[]>(() => props.plan.cast ?? [])
const castName = (id?: string): string =>
  cast.value.find((c) => c.id === id)?.name ?? '—'

// 逐镜发言者与台词：发言者取该镜台词的 speaker（一镜一发言者，已由服务端契约保证）
const turns = computed(() =>
  props.plan.shots.map((shot, i) => {
    const lines = shot.lines
      .map((lid) => props.plan.lines.find((l) => l.id === lid))
      .filter((l): l is NonNullable<typeof l> => !!l)
    return {
      shotId: shot.id,
      index: i + 1,
      duration: shot.duration,
      speaker: castName(lines[0]?.speaker),
      characters: (shot.characters ?? []).map(castName).join('、') || '—',
      lines,
    }
  }),
)
</script>

<template>
  <section v-if="cast.length" class="ec-dialogue" aria-label="人物对白设定">
    <div class="sh">
      <Icon name="users" :size="13" /> 对白角色<span class="sh-hint"
        >开口人物 · 声线由原生音画生成，非独立配音</span
      >
    </div>
    <ul class="cast">
      <li v-for="c in cast" :key="c.id">
        <span class="cname">{{ c.name }}</span>
        <span class="cvoice">声线：{{ c.voice }}</span>
        <span class="cappear muted">外貌：{{ c.appearance }}</span>
      </li>
    </ul>
    <ol class="turns">
      <li v-for="t in turns" :key="t.shotId">
        <span class="tidx mono">{{ t.index }}·{{ t.duration }}s</span>
        <div class="tbody">
          <div class="tsay">
            <span class="twho">{{ t.speaker }}</span>
            <span v-for="l in t.lines" :key="l.id" class="tline"
              >「{{ l.text }}」</span
            >
          </div>
          <div class="twho-c muted">出场：{{ t.characters }}</div>
        </div>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.ec-dialogue {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-2);
}

.sh {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}

.sh .ic {
  color: var(--accent);
}

.sh-hint {
  font-weight: 400;
  font-size: 11.5px;
  color: var(--text-3);
  margin-left: 2px;
}

.cast {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.cast li {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  min-width: 148px;
  flex: 1 1 148px;
}

.cname {
  font-size: 12.5px;
  font-weight: 700;
}

.cvoice {
  font-size: 11.5px;
  color: var(--text-2);
}

.cappear {
  font-size: 11px;
  line-height: 1.5;
}

.turns {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.turns li {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.tidx {
  flex: none;
  font-size: 11px;
  color: var(--text-3);
  padding-top: 1px;
  min-width: 44px;
}

.tbody {
  min-width: 0;
}

.tsay {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text);
}

.twho {
  font-weight: 700;
  color: var(--accent);
  margin-right: 5px;
}

.tline {
  display: inline;
}

.twho-c {
  font-size: 11px;
}
</style>
