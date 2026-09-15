<script setup lang="ts">
import SearchSelect from '../../components/common/SearchSelect.vue'
import Icon from '../../components/common/Icon.vue'
import { fmtQty } from '../../lib/format'
import type { SettingsApi } from './use-settings'
const props = defineProps<{ s: SettingsApi }>()
const { PRICE_KINDS, PRICE_UNIT_TEXT, unitOptionsOf, onKindChange, keyOptions, priceRows, unpricedRows, priceBusy, priceMsg, priceMsgBad, addPriceRow, addFromUnpriced, savePricing } = props.s
</script>

<template>
      <!-- [M4] 用量计费（折叠；实例级定价优先，此处为全局兜底） -->
      <details class="panel pricing">
        <summary class="psum">
          <Icon name="chart" :size="14" />
          <span class="pt">全局兜底定价</span>
          <span class="muted">实例未配置定价时回退到此处；记录时快照计价——改价只影响之后用量</span>
          <span v-if="unpricedRows.length" class="badge skip">近 30 天未计价 {{ unpricedRows.length }} 项</span>
          <span class="chev"><Icon name="chevron-down" :size="14" /></span>
        </summary>
        <div class="pbody">
          <div class="pbar">
            <span class="muted">key 形如 {供应商}:{模型}，可选已配置实例；{供应商}:* 通配该供应商全部模型</span>
            <div class="pops">
              <button class="btn sm" @click="addPriceRow">
                <Icon name="plus" :size="12" :stroke-width="2.2" /> 添加行
              </button>
              <button class="btn sm primary" :disabled="priceBusy" @click="savePricing">
                {{ priceBusy ? '保存中…' : '保存' }}
              </button>
            </div>
          </div>
          <div v-if="priceMsg" class="pmsg" :class="{ bad: priceMsgBad }">{{ priceMsg }}</div>

          <table v-if="priceRows.length" class="tbl">
            <thead>
              <tr>
                <th style="width: 128px">类型</th>
                <th>供应商 / 模型（key）</th>
                <th style="width: 220px">单位</th>
                <th style="width: 120px">单价</th>
                <th style="width: 64px"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in priceRows" :key="i">
                <td>
                  <select v-model="r.kind" @change="onKindChange(r)">
                    <option v-for="k in PRICE_KINDS" :key="k.key" :value="k.key">{{ k.label }}</option>
                  </select>
                </td>
                <td>
                  <SearchSelect
                    v-model="r.key"
                    :options="keyOptions"
                    :max-render="200"
                    placeholder="搜索实例或输入 key"
                    aria-label="供应商 / 模型 key"
                  />
                </td>
                <td>
                  <select v-model="r.unit">
                    <option v-for="u in unitOptionsOf(r.kind)" :key="u" :value="u">{{ PRICE_UNIT_TEXT[u] }}</option>
                  </select>
                </td>
                <td><input v-model="r.price" type="number" min="0" step="0.0001" placeholder="0" /></td>
                <td><button class="btn sm danger" @click="priceRows.splice(i, 1)">删除</button></td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty" style="padding: 14px 0">
            暂无定价——未命中定价的用量记为「未计价」（cost 空缺，不计入成本统计）
          </div>

          <div v-if="unpricedRows.length" class="unpriced">
            <div class="uphead">
              <span class="badge skip">近 30 天未计价 {{ unpricedRows.length }} 项</span>
              <span class="muted">「补价」按记录类型自动预填：文本输入/输出两行，图片/视频/语音一行</span>
            </div>
            <div v-for="u in unpricedRows" :key="u.key" class="uprow">
              <span class="mono uk" :title="u.key">{{ u.key }}</span>
              <span class="muted">{{ u.unpriced }} 次 · {{ fmtQty(u.quantity) }}</span>
              <button class="btn sm" style="margin-left: auto" @click="addFromUnpriced(u.key)">补价</button>
            </div>
          </div>
        </div>
      </details>
</template>

<style scoped>
/* ---------- 用量计费（折叠） ---------- */
.pricing {
  margin-top: 14px;
}

.psum {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-radius: calc(var(--radius) - 1px);
  cursor: pointer;
  user-select: none;
  list-style: none;
}

.psum::-webkit-details-marker {
  display: none;
}

.psum:hover {
  background: var(--hover);
}

.pt {
  font-weight: 600;
  font-size: 14px;
}

.chev {
  margin-left: auto;
  display: inline-flex;
  color: var(--text-3);
  transition: transform 0.16s ease;
}

.pricing[open] .chev {
  transform: rotate(180deg);
}

.pbody {
  padding: 0 16px 14px;
  border-top: 1px solid var(--border);
}

.pbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 0;
}

.pops {
  margin-left: auto;
  display: flex;
  gap: 8px;
  flex: none;
}

.pmsg {
  font-size: 12px;
  color: var(--ok);
  margin-bottom: 8px;
}

.pmsg.bad {
  color: var(--bad);
}

.pbody .tbl td input,
.pbody .tbl td select {
  width: 100%;
}

.unpriced {
  margin-top: 12px;
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}

.uphead {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  margin-bottom: 6px;
}

.uprow {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
  padding: 3px 0;
}

.uk {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
  .split,
  .menu {
    animation: none;
  }

  .chev {
    transition: none;
  }
}
</style>
