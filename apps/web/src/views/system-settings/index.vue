<script setup lang="ts">
/**
 * [M20] 系统设置页
 * 平台级统一设置入口：含「AI 配置」（由独立菜单迁入）与「品牌」「通知」「运行」「数据」Tab。
 * 支持 ?tab= 直达指定分类（旧 /settings 深链经路由重定向至 ?tab=ai）。
 */
import { ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AiConfigPanel from '../settings/index.vue'
import BrandPreview from '../../components/brand/BrandPreview.vue'
import BrandSettings from '../../components/brand/BrandSettings.vue'
import Icon from '../../components/common/Icon.vue'
import { settingsApi } from '../../lib/api'
import {
  DEFAULT_NOTIFY_PREFS,
  invalidateNotifyPrefs,
  notifyPermission,
  requestNotifyPermission,
  type NotifyPrefs,
} from '../../lib/notify'
import type { BrandConfig } from '../../lib/types'

// Tab 定义（后续新增设置类别只需追加到数组）
const TABS = [
  { key: 'ai', label: 'AI 配置', icon: 'sliders', hint: '模型网关 / 密钥 / 定价（密钥仅存本地）' },
  { key: 'brand', label: '品牌', icon: 'brush', hint: '水印 / 片头 / 片尾 / 字幕样式（平台默认；项目与 run 可覆盖）' },
  { key: 'notify', label: '通知', icon: 'bell', hint: '长任务离开页面也能感知（仅后台标签页推送）' },
  { key: 'run', label: '运行', icon: 'sliders', hint: '全局并发上限（跨批次与多开任务的总闸门）' },
  { key: 'data', label: '数据', icon: 'trash', hint: '回收站保留期与自动清理（过期画布定时彻底删除）' },
] as const
type TabKey = (typeof TABS)[number]['key']

const route = useRoute()
const TAB_KEYS = TABS.map((t) => t.key) as readonly string[]
/** 从 ?tab= 解析初始分类（非法/缺省回退首个 Tab「AI 配置」） */
function tabFromQuery(): TabKey {
  const q = route.query.tab
  const v = Array.isArray(q) ? q[0] : q
  return TAB_KEYS.includes(v as string) ? (v as TabKey) : 'ai'
}

const activeTab = ref<TabKey>(tabFromQuery())
// 页内已切换时，外部再次导航携带 ?tab= 仍能联动（如 /settings 重定向）
watch(
  () => route.query.tab,
  () => {
    if (route.path === '/system') activeTab.value = tabFromQuery()
  },
)

// 品牌配置快照（用于预览联动）
const brandSnapshot = ref<BrandConfig>({})
const wmFileSnapshot = ref('')
const introFileSnapshot = ref('')
const outroFileSnapshot = ref('')
const wmPreviewTs = ref(0)

/** 从 API 读取已保存的品牌配置，刷新预览快照 */
async function refreshPreview() {
  try {
    const r = await settingsApi.list()
    const raw = r.items.find((it) => it.key === 'brand')?.value
    const b = (raw && typeof raw === 'object' ? raw : {}) as BrandConfig
    brandSnapshot.value = b
    const wf = b.watermark?.file
    wmFileSnapshot.value = typeof wf === 'string' ? wf : ''
    const inf = b.intro?.file
    introFileSnapshot.value = typeof inf === 'string' ? inf : ''
    const outf = b.outro?.file
    outroFileSnapshot.value = typeof outf === 'string' ? outf : ''
    wmPreviewTs.value = Date.now()
  } catch {
    /* 预览加载失败静默 */
  }
}

/** [M20 fix] 表单实时预览：BrandSettings 表单变化时直接更新预览快照 */
function onPreviewForm(data: { brand: BrandConfig; wmFile: string }) {
  brandSnapshot.value = data.brand
  wmFileSnapshot.value = data.wmFile
  introFileSnapshot.value = (data.brand.intro?.file as string) || ''
  outroFileSnapshot.value = (data.brand.outro?.file as string) || ''
  wmPreviewTs.value = Date.now()
}

// ---------- [M21] 通知设置（settings key 'notify'；变更即存） ----------

const PERM_TEXT: Record<string, string> = {
  granted: '已授权',
  default: '未授权',
  denied: '已拒绝',
  unsupported: '当前环境不支持',
}

const notifyPerm = ref(notifyPermission())
const notifyPrefs = ref<NotifyPrefs>({ ...DEFAULT_NOTIFY_PREFS })
const notifySaving = ref(false)
const notifyHint = ref('')

async function loadNotify() {
  try {
    const r = await settingsApi.list()
    const raw = r.items.find((it) => it.key === 'notify')?.value
    notifyPrefs.value = { ...DEFAULT_NOTIFY_PREFS, ...(raw && typeof raw === 'object' ? raw : {}) }
  } catch {
    /* 读取失败默认全开 */
  }
}

async function saveNotify() {
  notifySaving.value = true
  notifyHint.value = ''
  try {
    await settingsApi.put('notify', { ...notifyPrefs.value })
    invalidateNotifyPrefs() // 失效推送侧缓存，下一事件重读
    notifyHint.value = '已保存'
    window.setTimeout(() => {
      if (notifyHint.value === '已保存') notifyHint.value = ''
    }, 2000)
  } catch (err) {
    notifyHint.value = err instanceof Error ? err.message : '保存失败'
  } finally {
    notifySaving.value = false
  }
}

async function askPermission() {
  await requestNotifyPermission()
  notifyPerm.value = notifyPermission()
}

// ---------- [M21] 运行设置（settings key 'concurrency'） ----------

const CONC_LO = 1
const CONC_HI = 6
const concMax = ref(3)
const concSaving = ref(false)
const concHint = ref('')

async function loadRun() {
  try {
    const r = await settingsApi.list()
    const raw = r.items.find((it) => it.key === 'concurrency')?.value
    const n = Number((raw && typeof raw === 'object' ? (raw as { max?: unknown }).max : undefined))
    concMax.value = Number.isFinite(n) ? Math.min(CONC_HI, Math.max(CONC_LO, Math.round(n))) : 3
  } catch {
    /* 读取失败保持默认 3 */
  }
}

async function saveRun() {
  concSaving.value = true
  concHint.value = ''
  // 前端先行归一（与服务端读取链 clamp 语义对齐：0→1 / 99→6 / 非法→默认 3）
  const raw = Number(concMax.value)
  const n = Number.isFinite(raw) ? Math.min(CONC_HI, Math.max(CONC_LO, Math.round(raw))) : 3
  concMax.value = n
  try {
    await settingsApi.put('concurrency', { max: n })
    concHint.value = '已保存（对后续调度生效）'
    window.setTimeout(() => {
      if (concHint.value.startsWith('已保存')) concHint.value = ''
    }, 2500)
  } catch (err) {
    concHint.value = err instanceof Error ? err.message : '保存失败'
  } finally {
    concSaving.value = false
  }
}

// ---------- [M22] 数据设置（settings key 'trash'：回收站保留期 + 自动清理） ----------

const TRASH_LO = 1
const TRASH_HI = 365
const trashDays = ref(30)
const trashAuto = ref(true)
const trashSaving = ref(false)
const trashHint = ref('')

async function loadData() {
  try {
    const r = await settingsApi.list()
    const raw = r.items.find((it) => it.key === 'trash')?.value
    const o = raw && typeof raw === 'object' ? (raw as { retentionDays?: unknown; autoPurge?: unknown }) : {}
    const n = Number(o.retentionDays)
    trashDays.value = Number.isFinite(n) ? Math.min(TRASH_HI, Math.max(TRASH_LO, Math.round(n))) : 30
    trashAuto.value = typeof o.autoPurge === 'boolean' ? o.autoPurge : true
  } catch {
    /* 读取失败保持默认（30 天 / 开启） */
  }
}

async function saveData() {
  trashSaving.value = true
  trashHint.value = ''
  // 前端先行归一（与服务端读取链 clamp 语义对齐：0→1 / 999→365 / 非法→默认 30）
  const raw = Number(trashDays.value)
  const n = Number.isFinite(raw) ? Math.min(TRASH_HI, Math.max(TRASH_LO, Math.round(raw))) : 30
  trashDays.value = n
  try {
    await settingsApi.put('trash', { retentionDays: n, autoPurge: trashAuto.value })
    trashHint.value = '已保存（启动时与每 6 小时扫描生效）'
    window.setTimeout(() => {
      if (trashHint.value.startsWith('已保存')) trashHint.value = ''
    }, 2500)
  } catch (err) {
    trashHint.value = err instanceof Error ? err.message : '保存失败'
  } finally {
    trashSaving.value = false
  }
}

// 初始加载
refreshPreview()
loadNotify()
loadRun()
loadData()
</script>

<template>
  <div>
    <div class="page-h">
      <h1>设置</h1>
      <span class="sub">平台级通用配置</span>
      <div class="tabs" role="tablist" aria-label="设置分类">
        <button
          v-for="t in TABS"
          :key="t.key"
          class="tab"
          role="tab"
          :aria-selected="activeTab === t.key"
          :class="{ on: activeTab === t.key }"
          @click="activeTab = t.key"
        >
          <Icon :name="t.icon" :size="13" :stroke-width="1.8" />
          {{ t.label }}
        </button>
      </div>
    </div>

    <!-- AI 配置 Tab（由独立菜单迁入；保留能力子 Tab：文本/图片/视频/语音/音色库 + 定价） -->
    <AiConfigPanel v-if="activeTab === 'ai'" />
    <!-- 品牌 Tab -->
    <div v-if="activeTab === 'brand'" class="sys-brand">
      <div class="sys-brand-form">
        <BrandSettings scope="platform" @changed="refreshPreview" @preview="onPreviewForm" />
      </div>
      <aside class="sys-brand-preview">
        <BrandPreview
          :brand="brandSnapshot"
          :wm-file="wmFileSnapshot"
          :wm-preview-ts="wmPreviewTs"
          :intro-file="introFileSnapshot"
          :outro-file="outroFileSnapshot"
        />
      </aside>
    </div>
    <!-- 通知 Tab（[M21] C2：权限 + 三类开关，变更即存） -->
    <div v-if="activeTab === 'notify'" class="sys-notify">
      <div class="panel nf-card">
        <div class="nf-head">
          <h3>浏览器通知</h3>
          <span class="muted">
            run 终态 / 闸门到达 / 批次收敛时推送系统通知（仅后台标签页；权限未授予时静默跳过，不影响前台使用）
          </span>
        </div>

        <div class="nf-row">
          <span class="nf-lb">通知权限</span>
          <span class="nf-perm" :class="notifyPerm">{{ PERM_TEXT[notifyPerm] }}</span>
          <button v-if="notifyPerm === 'default'" class="btn" type="button" @click="askPermission">请求权限</button>
          <span v-else-if="notifyPerm === 'denied'" class="muted">
            已在浏览器中拒绝，请在地址栏「站点设置 → 通知」中恢复
          </span>
        </div>

        <label class="nf-ck">
          <input v-model="notifyPrefs.enabled" type="checkbox" @change="saveNotify" />
          <span>启用通知</span>
        </label>
        <div class="nf-sub" :class="{ off: !notifyPrefs.enabled }">
          <label class="nf-ck">
            <input
              v-model="notifyPrefs.run_terminal"
              type="checkbox"
              :disabled="!notifyPrefs.enabled"
              @change="saveNotify"
            />
            <span class="muted">运行终态（完成 / 失败）</span>
          </label>
          <label class="nf-ck">
            <input
              v-model="notifyPrefs.gate"
              type="checkbox"
              :disabled="!notifyPrefs.enabled"
              @change="saveNotify"
            />
            <span class="muted">闸门到达（等待审阅）</span>
          </label>
          <label class="nf-ck">
            <input
              v-model="notifyPrefs.batch"
              type="checkbox"
              :disabled="!notifyPrefs.enabled"
              @change="saveNotify"
            />
            <span class="muted">批次收敛（完成 / 部分失败 / 失败）</span>
          </label>
        </div>

        <div class="nf-foot muted">
          <span v-if="notifySaving">保存中…</span>
          <span v-else-if="notifyHint">{{ notifyHint }}</span>
        </div>
      </div>
    </div>
    <!-- 运行 Tab（[M21] C6：全局并发上限） -->
    <div v-if="activeTab === 'run'" class="sys-run">
      <div class="panel rc-card">
        <div class="rc-head">
          <h3>全局并发上限</h3>
          <span class="muted">
            跨批次与多开任务的总闸门：同时处于执行中的 run 数不超过该值；超出部分留「排队中」等待，运行结束后自动补位
          </span>
        </div>

        <div class="rc-row">
          <span class="rc-lb">并发上限</span>
          <input
            v-model.number="concMax"
            class="rc-num"
            type="number"
            :min="CONC_LO"
            :max="CONC_HI"
            step="1"
            aria-label="全局并发上限（1–6）"
            @keydown.enter="saveRun"
          />
          <span class="muted">（1–6，默认 3）</span>
          <button class="btn primary" type="button" :disabled="concSaving" @click="saveRun">
            {{ concSaving ? '保存中…' : '保存' }}
          </button>
        </div>

        <div class="rc-note muted">
          配置存于 settings「concurrency」；环境变量 CSTUDIO_GLOBAL_MAX_CONCURRENT 可在未配置时兜底。批次内并发仍由批次自身的 max_concurrent（1–3）控制，批内 run 同样受全局闸门约束。
        </div>
        <div class="rc-foot muted">
          <span v-if="concHint">{{ concHint }}</span>
        </div>
      </div>
    </div>
    <!-- 数据 Tab（[M22] ⑥：回收站保留期自动清理） -->
    <div v-if="activeTab === 'data'" class="sys-data">
      <div class="panel rc-card">
        <div class="rc-head">
          <h3>回收站自动清理</h3>
          <span class="muted">过期软删画布将连同节点/连线/分组/快照一并彻底清理（生成任务留痕保留）</span>
        </div>

        <div class="rc-row">
          <span class="rc-lb">保留期</span>
          <input
            v-model.number="trashDays"
            class="rc-num"
            type="number"
            :min="TRASH_LO"
            :max="TRASH_HI"
            step="1"
            aria-label="回收站保留期（1–365 天）"
            @keydown.enter="saveData"
          />
          <span class="muted">天（1–365，默认 30）</span>
        </div>

        <label class="rc-ck">
          <input v-model="trashAuto" type="checkbox" />
          <span>启用自动清理（服务启动时 + 每 6 小时扫描一次）</span>
        </label>

        <div class="rc-row">
          <button class="btn primary" type="button" :disabled="trashSaving" @click="saveData">
            {{ trashSaving ? '保存中…' : '保存' }}
          </button>
        </div>

        <div class="rc-note muted">
          配置存于 settings「trash」；回收站弹窗内的「彻底删除」手动操作不受影响。关闭自动清理后，过期画布将一直保留至手动处理。
        </div>
        <div class="rc-foot muted">
          <span v-if="trashHint">{{ trashHint }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sys-brand {
  display: grid;
  grid-template-columns: 1fr 340px;
  gap: 24px;
  align-items: start;
}

.sys-brand-form {
  min-width: 0;
}

.sys-brand-preview {
  position: sticky;
  top: 16px;
}

@media (max-width: 960px) {
  .sys-brand {
    grid-template-columns: 1fr;
  }
  .sys-brand-preview {
    position: static;
  }
}

/* [M21] 通知设置卡片 */
.sys-notify {
  max-width: 640px;
}

.nf-card {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.nf-head h3 {
  margin: 0 0 4px;
  font-size: 14px;
}

.nf-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
}

.nf-lb {
  font-size: 12.5px;
  color: var(--text-2);
}

.nf-perm {
  font-size: 12px;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  color: var(--text-2);
}

.nf-perm.granted {
  color: var(--ok);
  border-color: var(--ok);
  background: var(--ok-weak);
}

.nf-perm.denied {
  color: var(--bad);
  border-color: var(--bad);
  background: rgb(248 113 113 / 12%);
}

.nf-perm.default {
  color: var(--warn);
  border-color: var(--warn);
  background: var(--warn-weak);
}

.nf-ck {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}

.nf-sub {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 10px 0 2px 24px;
  border-top: 1px dashed var(--border);
}

.nf-sub.off {
  opacity: 0.55;
}

.nf-foot {
  min-height: 16px;
  font-size: 11.5px;
}

/* [M21] 运行设置卡片 */
.sys-run {
  max-width: 640px;
}

.rc-card {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.rc-head h3 {
  margin: 0 0 4px;
  font-size: 14px;
}

.rc-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
}

.rc-lb {
  font-size: 12.5px;
  color: var(--text-2);
}

.rc-num {
  width: 72px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 8px;
  font-size: 13px;
  color: var(--text);
  font-family: inherit;
}

.rc-num:focus {
  outline: none;
  border-color: var(--accent);
}

.rc-note {
  font-size: 11.5px;
  line-height: 1.6;
}

.rc-foot {
  min-height: 16px;
  font-size: 11.5px;
}

/* [M22] 数据设置卡片 */
.sys-data {
  max-width: 640px;
}

.rc-ck {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
  padding: 2px;
}
</style>
