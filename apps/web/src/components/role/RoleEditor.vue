<script setup lang="ts">
/**
 * 角色人设文件编辑器：列出所有注册角色，支持从可用 .md 文件中选择覆盖默认 personaFile。
 * 数据来源：GET /roles（含数据库覆盖与代码默认合并）；下拉选项：GET /persona-files。
 * 保存走 PATCH /roles/:key（upsert 到 role_configs 表）。
 */
import { ref, onMounted } from 'vue'
import Icon from '../common/Icon.vue'
import { rolesApi, type RoleConfigItem } from '../../lib/api'

const roles = ref<RoleConfigItem[]>([])
const personaFiles = ref<string[]>([])
const defaults = ref<Record<string, string>>({})
const loading = ref(true)
const saving = ref<Record<string, boolean>>({})
const hints = ref<Record<string, string>>({})

async function load() {
  loading.value = true
  try {
    const [rolesRes, filesRes, defaultsRes] = await Promise.all([
      rolesApi.list(),
      rolesApi.listPersonaFiles(),
      rolesApi.getDefaults(),
    ])
    roles.value = rolesRes.items
    personaFiles.value = filesRes.items
    defaults.value = Object.fromEntries(
      defaultsRes.items.map((d) => [d.roleKey, d.defaultPersonaFile]),
    )
  } catch {
    /* 加载失败保持空列表 */
  } finally {
    loading.value = false
  }
}

async function save(roleKey: string, personaFile: string) {
  saving.value = { ...saving.value, [roleKey]: true }
  hints.value = { ...hints.value, [roleKey]: '' }
  try {
    await rolesApi.update(roleKey, personaFile)
    hints.value = { ...hints.value, [roleKey]: '已保存' }
    window.setTimeout(() => {
      if (hints.value[roleKey] === '已保存') {
        hints.value = { ...hints.value, [roleKey]: '' }
      }
    }, 2000)
  } catch (err) {
    hints.value = {
      ...hints.value,
      [roleKey]: err instanceof Error ? err.message : '保存失败',
    }
  } finally {
    saving.value = { ...saving.value, [roleKey]: false }
  }
}

function isOverridden(roleKey: string, currentFile: string): boolean {
  return defaults.value[roleKey] !== undefined && defaults.value[roleKey] !== currentFile
}

onMounted(load)
</script>

<template>
  <div class="role-editor">
    <div class="re-head">
      <h3>角色人设文件</h3>
      <span class="muted">
        每个角色的人设提示词文件引用可在此覆盖默认值（代码注册表中的初始配置）
      </span>
    </div>

    <div v-if="loading" class="re-loading">加载中…</div>

    <div v-else class="re-list">
      <div v-for="role in roles" :key="role.roleKey" class="re-card">
        <div class="re-info">
          <span class="re-name">{{ role.name }}</span>
          <span class="re-key muted">{{ role.roleKey }}</span>
          <span class="re-blurb muted">{{ role.blurb }}</span>
        </div>

        <div class="re-field">
          <label class="re-label">人设文件引用</label>
          <select
            v-model="role.personaFile"
            class="re-select"
            :class="{ overridden: isOverridden(role.roleKey, role.personaFile) }"
            :disabled="saving[role.roleKey]"
          >
            <option v-for="file in personaFiles" :key="file" :value="file">
              {{ file }}
            </option>
          </select>
          <button
            class="btn primary btn-sm"
            type="button"
            :disabled="saving[role.roleKey]"
            @click="save(role.roleKey, role.personaFile)"
          >
            {{ saving[role.roleKey] ? '保存中…' : '保存' }}
          </button>
        </div>

        <div class="re-hint muted">
          <span v-if="hints[role.roleKey]">{{ hints[role.roleKey] }}</span>
          <span v-else-if="isOverridden(role.roleKey, role.personaFile)">
            <Icon name="edit" :size="11" :stroke-width="2" />
            已覆盖默认值（{{ defaults[role.roleKey] }}）
          </span>
          <span v-else class="default-hint">
            使用代码默认：{{ defaults[role.roleKey] || '未配置' }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.role-editor {
  max-width: 720px;
}

.re-head {
  margin-bottom: 14px;
}

.re-head h3 {
  margin: 0 0 4px;
  font-size: 14px;
}

.re-loading {
  padding: 24px;
  text-align: center;
  color: var(--text-3);
  font-size: 13px;
}

.re-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.re-card {
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.re-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.re-name {
  font-size: 13.5px;
  font-weight: 600;
}

.re-key {
  font-size: 11px;
  font-family: var(--font-mono, monospace);
}

.re-blurb {
  font-size: 12px;
  line-height: 1.5;
  margin-top: 2px;
}

.re-field {
  display: flex;
  align-items: center;
  gap: 10px;
}

.re-label {
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
}

.re-select {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  font-size: 12.5px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  font-family: inherit;
}

.re-select:focus {
  outline: none;
  border-color: var(--accent);
}

.re-select.overridden {
  border-color: var(--accent);
  background: var(--accent-weak, rgb(139 92 246 / 8%));
}

.btn-sm {
  padding: 4px 12px;
  font-size: 12px;
  border-radius: 6px;
}

.re-hint {
  font-size: 11.5px;
  min-height: 16px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.default-hint {
  opacity: 0.6;
}
</style>
