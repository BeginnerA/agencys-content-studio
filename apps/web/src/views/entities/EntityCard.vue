<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import type { EntityItem } from '../../lib/types'
import type { EntitiesApi } from './use-entities'
const props = defineProps<{ s: EntitiesApi; c: EntityItem }>()
const { cfg, busy, selected, voiceLabel, openEdit, removeItem, toggleSel, photoOf, ratioCls } = props.s
</script>

<template>
      <div class="card panel" :class="{ picked: selected.has(c.id) }">
        <div class="photo" :class="ratioCls">
          <label class="pick" :title="selected.has(c.id) ? '取消选择' : '加入批量选择'">
            <input type="checkbox" :checked="selected.has(c.id)" @change="toggleSel(c.id)" />
          </label>
          <img v-if="photoOf(c)" :src="photoOf(c)!" :alt="`${c.name} 参考图`" loading="lazy" />
          <div v-else class="ph"><Icon :name="cfg.icon" :size="30" /></div>
        </div>
        <div class="body">
          <div class="top">
            <span class="nm">{{ c.name }}</span>
            <span class="badge" :class="{ skip: c.scope === 'global' }">{{ c.scope === 'global' ? '全局' : `项目#${c.projectId}` }}</span>
          </div>
          <div v-if="c.aliases.length" class="aliases muted">别名：{{ c.aliases.join('、') }}</div>
          <div class="summary">{{ c.appearance || c.summary || '—' }}</div>
          <div v-if="c.states.length" class="states">
            <span v-for="s in c.states.slice(0, 2)" :key="s" class="chip state" :title="s">{{ s }}</span>
            <span v-if="c.states.length > 2" class="chip">+{{ c.states.length - 2 }}</span>
          </div>
          <div class="meta muted">
            <span v-if="c.voice"><Icon name="speaker-wave" :size="12" /> {{ voiceLabel(c.voice) }}</span>
            <span v-if="c.refAssetIds.length" class="chip">{{ c.refAssetIds.length }} 张{{ cfg.refLabel }}</span>
          </div>
          <div class="ops">
            <button class="btn tiny" @click="openEdit(c)"><Icon name="pencil" :size="12" /> 编辑</button>
            <button class="btn tiny danger" :disabled="busy" @click="removeItem(c)"><Icon name="trash" :size="12" /> 删除</button>
          </div>
        </div>
      </div>
</template>

<style scoped>
.card {
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* [M13] 卡片多选态 */
.card.picked {
  border-color: var(--accent);
}

.photo {
  position: relative;
  background: rgb(148 163 184 / 8%);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.pick {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 1;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background: rgb(8 11 20 / 55%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.pick input {
  width: 15px;
  height: 15px;
  cursor: pointer;
}

.photo.pc {
  aspect-ratio: 3 / 4;
}

.photo.ps {
  aspect-ratio: 16 / 9;
}

.photo.pp {
  aspect-ratio: 4 / 3;
}

.photo img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.photo .ph {
  color: var(--text-3);
  opacity: 0.6;
}

.body {
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.nm {
  font-size: 15px;
  font-weight: 600;
}

.aliases {
  font-size: 11.5px;
}

/* [M13] 状态变体 chips */
.states {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.states .state {
  font-size: 11px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.summary {
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.5;
  min-height: 37px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.meta .chip {
  font-size: 11px;
}

.ops {
  display: flex;
  gap: 6px;
  margin-top: 2px;
}
.btn.tiny {
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 7px;
}

.btn.tiny.danger:hover {
  border-color: rgb(248 113 113 / 60%);
  color: var(--bad);
}
</style>
