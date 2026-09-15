<script setup lang="ts">
import Icon from '../../components/common/Icon.vue'
import type { SettingsApi } from './use-settings'
const props = defineProps<{ s: SettingsApi }>()
const { testBusy, selectedProvider, openNew, openEdit, remove, test, msgOf, menuFor, menuUp, toggleMenu, closeMenu, menuAct, menuSetDefault, menuToggle } = props.s
</script>

<template>
        <section v-if="selectedProvider" class="panel detail">
          <div class="dhead">
            <div class="dtl">
              <span class="pname">{{ selectedProvider.name }}</span>
              <span class="pk mono" :title="`供应商 key：${selectedProvider.key}`">{{ selectedProvider.key }}</span>
            </div>
            <button class="btn sm primary" @click="openNew">
              <Icon name="plus" :size="13" :stroke-width="2.2" /> 新建实例
            </button>
          </div>
          <div class="pdesc muted">{{ selectedProvider.description }}</div>

          <div v-if="!selectedProvider.configs.length" class="dempty">
            <span class="muted">未配置实例——流水线调用该能力将失败</span>
            <button class="btn sm" @click="openNew">立即配置</button>
          </div>

          <table v-else class="tbl">
            <thead>
              <tr>
                <th>实例</th>
                <th>模型</th>
                <th style="width: 90px">状态</th>
                <th style="width: 176px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="cfg in selectedProvider.configs" :key="cfg.id">
                <td>
                  <div class="inst">
                    <span class="iname">
                      {{ cfg.name }}
                      <span v-if="cfg.isDefault" class="tag-default">默认</span>
                    </span>
                    <span v-if="msgOf(cfg.id)" class="tmsg" :class="{ bad: msgOf(cfg.id).startsWith('✗') }">
                      {{ msgOf(cfg.id) }}
                    </span>
                  </div>
                </td>
                <td class="mono" style="font-size: 12px">{{ cfg.model || '—' }}</td>
                <td>
                  <span class="badge" :class="cfg.isActive ? 'succeeded' : 'cancelled'">
                    {{ cfg.isActive ? '启用' : '停用' }}
                  </span>
                </td>
                <td>
                  <div class="ops">
                    <button class="btn sm" :disabled="testBusy === cfg.id" @click="test(cfg)">
                      {{ testBusy === cfg.id ? '测试中…' : '测试' }}
                    </button>
                    <button class="btn sm" @click="openEdit(cfg)">编辑</button>
                    <div class="mwrap" data-menu-root>
                      <button
                        class="btn sm mbtn"
                        aria-haspopup="menu"
                        aria-label="更多操作"
                        :aria-expanded="menuFor === cfg.id"
                        title="更多操作"
                        @click="toggleMenu(cfg, $event)"
                      >
                        <Icon name="more" :size="14" />
                      </button>
                      <div
                        v-if="menuFor === cfg.id"
                        class="menu"
                        :class="{ up: menuUp }"
                        role="menu"
                        aria-label="实例操作"
                        tabindex="-1"
                        @keydown.esc.stop="closeMenu(true)"
                      >
                        <button v-if="!cfg.isDefault" class="mi" role="menuitem" @click="menuAct(() => menuSetDefault(cfg))">
                          设为默认
                        </button>
                        <button class="mi" role="menuitem" @click="menuAct(() => menuToggle(cfg))">
                          {{ cfg.isActive ? '停用' : '启用' }}
                        </button>
                        <div class="msep" />
                        <button class="mi bad" role="menuitem" @click="menuAct(() => remove(cfg))">删除</button>
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
</template>

<style scoped>
/* ---------- 供应商详情 ---------- */
.detail {
  flex: 1;
  min-width: 0;
  padding: 14px 16px;
  min-height: 300px;
}

.dhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.dtl {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.pname {
  font-weight: 600;
  font-size: 14.5px;
}

.pk {
  font-size: 11.5px;
  color: var(--text-3);
  cursor: help;
}

.pdesc {
  font-size: 12px;
  margin: 4px 0 10px;
}

.dempty {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 0 6px;
  font-size: 12.5px;
}

.inst {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.iname {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.tag-default {
  background: var(--accent-weak);
  color: var(--accent);
  font-size: 10.5px;
  border-radius: 999px;
  padding: 0 8px;
}

.tmsg {
  font-size: 11.5px;
  color: var(--ok);
  word-break: break-word;
}

.tmsg.bad {
  color: var(--bad);
}

.ops {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* ---------- 「…」溢出菜单 ---------- */
.mwrap {
  position: relative;
}

.mbtn {
  padding: 2px 7px;
}

.menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 40;
  min-width: 132px;
  padding: 4px;
  background: var(--panel-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-lg);
  animation: menu-in 0.12s ease-out;
}

.menu.up {
  top: auto;
  bottom: calc(100% + 4px);
}

.menu:focus {
  outline: none;
}

@keyframes menu-in {
  from {
    opacity: 0;
  }
}

.mi {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: none;
  color: var(--text);
  font-size: 12.5px;
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
}

.mi:hover {
  background: var(--hover);
}

.mi.bad {
  color: var(--bad);
}

.mi.bad:hover {
  background: var(--bad-weak);
}

.msep {
  height: 1px;
  background: var(--border);
  margin: 4px 2px;
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
