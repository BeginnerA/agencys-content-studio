<script setup lang="ts">
import AssetGrid from '../../components/asset/AssetGrid.vue'
import { purposeText } from '../../lib/format'
import type { ProjectDetailApi } from './use-project-detail'
const props = defineProps<{ s: ProjectDetailApi }>()
const { activeTab, assets, assetLoading, assetTotal, assetErr, loadAssets, purposeFilter, purposes, tagFilter, allTags, tagSelectMode, checkedIds, bulkTagInput, bulkBusy, onToggleCheck, toggleTagSelect, applyBulkTag, filteredAssets, favOnly, assetNotice, assetBusy, onFavorite, onAssetChanged, onAssetRemoved, doCleanupVersions, doGc } = props.s
</script>

<template>
      <section v-show="activeTab === 'assets'" role="tabpanel" aria-labelledby="ptab-assets">
        <div class="panel block">
          <div class="bh">
            <span class="bt">资产</span>
            <span class="muted">{{ filteredAssets.length }} 个</span>
            <div style="margin-left: auto; display: flex; gap: 8px; align-items: center">
              <label class="fav-ck muted">
                <input v-model="favOnly" type="checkbox" /> 仅收藏
              </label>
              <select v-model="purposeFilter" style="width: 150px" aria-label="按用途筛选资产">
                <option value="all">全部用途</option>
                <template v-for="p in purposes" :key="p">
                  <option v-if="p !== 'all'" :value="p">
                    {{ purposeText(p) }}
                  </option>
                </template>
              </select>
              <select v-model="tagFilter" style="width: 130px" aria-label="按标签筛选资产">
                <option value="all">全部标签</option>
                <option v-for="t in allTags" :key="t" :value="t">{{ t }}</option>
              </select>
              <button
                class="btn sm"
                :class="{ danger: tagSelectMode }"
                :disabled="bulkBusy"
                :title="tagSelectMode ? '退出批量选择（已选自动清空）' : '选择多个资产批量追加标签'"
                @click="toggleTagSelect"
              >
                {{ tagSelectMode ? '退出批量' : '批量打标' }}
              </button>
              <button
                class="btn sm"
                :disabled="assetBusy"
                title="每组保留最新 / 收藏 / 在用版本，其余软删（可回溯）"
                @click="doCleanupVersions"
              >
                清理历史版本
              </button>
              <button
                class="btn sm danger"
                :disabled="assetBusy"
                title="物理删除已清理资产的磁盘文件（不可逆）"
                @click="doGc"
              >
                回收空间
              </button>
              <button class="btn sm" @click="loadAssets()">刷新</button>
            </div>
          </div>
          <div v-if="assetErr" class="err-text">{{ assetErr }}</div>
          <div v-if="assetNotice" class="asset-notice">{{ assetNotice }}</div>
          <!-- [M21] 批量打标工具条（选择模式下展示；应用 = 追加去重） -->
          <div v-if="tagSelectMode" class="bulk">
            <span class="muted">已选 {{ checkedIds.length }} 项</span>
            <input
              v-model="bulkTagInput"
              type="text"
              placeholder="输入标签（追加去重）"
              aria-label="批量标签"
              style="width: 200px"
              :disabled="bulkBusy"
              @keydown.enter.prevent="applyBulkTag"
            />
            <button
              class="btn sm primary"
              :disabled="bulkBusy || !checkedIds.length || !bulkTagInput.trim()"
              @click="applyBulkTag"
            >
              {{ bulkBusy ? '应用中…' : '应用' }}
            </button>
            <button class="btn sm" :disabled="bulkBusy" @click="toggleTagSelect">取消</button>
            <span class="muted">点击卡片切换选中（不打开预览）</span>
          </div>
          <AssetGrid
            :assets="filteredAssets"
            :loading="assetLoading"
            :selectable="tagSelectMode"
            :checked-ids="checkedIds"
            @toggle-check="onToggleCheck"
            @favorite="onFavorite"
            @changed="onAssetChanged"
            @removed="onAssetRemoved"
          />
          <div v-if="assetTotal > assets.length" class="muted trunc">仅显示前 {{ assets.length }} 个资产（共 {{ assetTotal }} 个）</div>
        </div>
      </section>
</template>

<style scoped>
/* ---------- 区块 ---------- */
.block {
  padding: 12px 16px 16px;
  margin-bottom: 18px;
}
.bh {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.bt {
  font-weight: 600;
  font-size: 14px;
}
.trunc {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}
/* [M12] 资产维护（收藏筛选 / 清理 / 回收） */
.fav-ck {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}

.asset-notice {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--ok);
  background: var(--ok-weak);
  border: 1px solid rgb(34 197 94 / 24%);
  border-radius: 8px;
  padding: 7px 10px;
}

/* [M21] 批量打标工具条 */
.bulk {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 12px;
  padding: 8px 12px;
  border: 1px solid rgb(99 102 241 / 32%);
  border-radius: 8px;
  background: var(--accent-weak);
}
</style>
