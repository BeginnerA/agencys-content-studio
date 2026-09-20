<script setup lang="ts">
/**
 * [M20] 平台导出预设管理（B8）
 * 查看/编辑各平台导出规格（画幅/时长/命名/水印等）
 */
import { onMounted, ref } from 'vue'
import Icon from '../../components/common/Icon.vue'
import ProvenanceBadge from '../../components/common/ProvenanceBadge.vue'
import { exportApi } from '../../lib/api'
import type { ExportPreset } from '../../lib/types'

const loading = ref(true)
const err = ref('')
const saving = ref(false)
const presets = ref<ExportPreset[]>([])
const editing = ref(false)
const editItems = ref<ExportPreset[]>([])
// [M36·G12.1] 从平台目录一键补全缺失预设
const seeding = ref(false)
const seedMsg = ref('')
/** [M37·G13] 本次补全条数（>0 才挂来源徽标，「无需补全」不加噪） */
const seedAdded = ref(0)

async function load() {
  loading.value = true
  err.value = ''
  try {
    const r = await exportApi.presets()
    presets.value = r.items
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())

function startEdit() {
  editItems.value = presets.value.map((p) => ({ ...p }))
  editing.value = true
}

async function saveEdit() {
  saving.value = true
  err.value = ''
  try {
    const r = await exportApi.savePresets(editItems.value)
    presets.value = r.items
    editing.value = false
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

function addPreset() {
  editItems.value.push({
    platform: 'other',
    label: '新平台',
    aspect: '9:16',
    maxDuration: 60,
    namingPattern: '{project}_{template}_run{run}',
    includeCover: true,
    includeSubtitle: true,
  })
}

function removePreset(idx: number) {
  editItems.value.splice(idx, 1)
}

/** [M36·G12.1] 从单一真源目录补全尚未配置的平台预设（仅填缺失、不覆盖已配） */
async function seedFromCatalog() {
  seeding.value = true
  err.value = ''
  seedMsg.value = ''
  try {
    const r = await exportApi.seed()
    presets.value = r.items
    seedMsg.value = r.added > 0 ? `已从平台目录补全 ${r.added} 个缺失预设` : '所有已知平台均已配置，无需补全'
    seedAdded.value = r.added
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    seeding.value = false
  }
}
</script>

<template>
  <div class="presets-panel">
    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="loading" class="empty">加载中…</div>

    <template v-if="!loading">
      <!-- 查看模式 -->
      <div v-if="!editing" class="presets-view">
        <div class="pv-header">
          <h3>平台导出预设</h3>
          <div class="pv-actions">
            <button class="btn sm" :disabled="seeding" @click="seedFromCatalog">
              <Icon name="download" :size="12" /> {{ seeding ? '补全中…' : '从平台目录补全' }}
            </button>
            <button class="btn sm" @click="startEdit">
              <Icon name="edit" :size="12" /> 编辑
            </button>
          </div>
        </div>
        <div v-if="seedMsg" class="seed-msg">
          <ProvenanceBadge
            v-if="seedAdded > 0"
            kind="auto"
            text="平台目录"
            title="预设由平台导出规格单一真源目录自动生成（仅补缺失、不覆盖已配）"
          />
          {{ seedMsg }}
        </div>
        <table class="tbl">
          <thead>
            <tr>
              <th>平台</th>
              <th>画幅</th>
              <th>最长时长</th>
              <th>命名规则</th>
              <th>封面</th>
              <th>字幕</th>
              <th>水印</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in presets" :key="p.platform">
              <td>
                <strong>{{ p.label }}</strong>
                <span class="muted sm">{{ p.platform }}</span>
              </td>
              <td class="mono">{{ p.aspect }}</td>
              <td class="mono">{{ p.maxDuration }}s</td>
              <td class="mono sm">{{ p.namingPattern }}</td>
              <td>{{ p.includeCover ? '✓' : '—' }}</td>
              <td>{{ p.includeSubtitle ? '✓' : '—' }}</td>
              <td>{{ p.watermark ? '✓' : '—' }}</td>
            </tr>
            <tr v-if="!presets.length">
              <td colspan="7">
                <div class="empty" style="padding: 12px 0">暂无预设</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 编辑模式 -->
      <div v-else class="presets-edit">
        <h3>编辑平台预设</h3>
        <div v-for="(p, i) in editItems" :key="i" class="pe-row panel">
          <div class="pe-grid">
            <label
              >平台标识 <input v-model="p.platform" placeholder="douyin"
            /></label>
            <label
              >显示名称 <input v-model="p.label" placeholder="抖音"
            /></label>
            <label
              >画幅
              <select v-model="p.aspect">
                <option value="9:16">9:16</option>
                <option value="16:9">16:9</option>
                <option value="1:1">1:1</option>
                <option value="4:5">4:5</option>
              </select>
            </label>
            <label
              >最长时长(s)
              <input
                v-model.number="p.maxDuration"
                type="number"
                min="10"
                max="3600"
            /></label>
            <label class="wide"
              >命名规则
              <input
                v-model="p.namingPattern"
                placeholder="{project}_{template}_run{run}"
            /></label>
          </div>
          <div class="pe-checks">
            <label
              ><input v-model="p.includeCover" type="checkbox" /> 含封面</label
            >
            <label
              ><input v-model="p.includeSubtitle" type="checkbox" />
              含字幕</label
            >
            <label
              ><input v-model="p.watermark" type="checkbox" /> 含水印</label
            >
          </div>
          <button class="btn sm del" @click="removePreset(i)">
            <Icon name="trash" :size="12" />
          </button>
        </div>
        <div class="pe-foot">
          <button class="btn sm" @click="addPreset">+ 添加平台</button>
          <div class="pe-actions">
            <button class="btn sm" @click="editing = false">取消</button>
            <button class="btn sm primary" :disabled="saving" @click="saveEdit">
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.pv-actions {
  display: flex;
  gap: 8px;
}
.seed-msg {
  margin-bottom: 10px;
  font-size: 12px;
  color: var(--text-2);
}
.pv-header h3 {
  margin: 0;
  font-size: 15px;
}
.sm {
  font-size: 12px;
}
.muted {
  color: var(--text-3);
}
.pe-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
  margin-bottom: 8px;
  position: relative;
}
.pe-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  flex: 1;
}
.pe-grid label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--text-3);
}
.pe-grid input,
.pe-grid select {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 8px;
  color: var(--text);
  font-size: 12px;
}
.pe-grid .wide {
  grid-column: span 3;
}
.pe-checks {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.pe-checks label {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.del {
  position: absolute;
  top: 8px;
  right: 8px;
}
.pe-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
}
.pe-actions {
  display: flex;
  gap: 8px;
}
</style>
