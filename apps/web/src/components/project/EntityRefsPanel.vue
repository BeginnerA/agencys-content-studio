<script setup lang="ts">
/**
 * 实体参考图分层管理面板（基准 / 状态变体 / 多视角三层）。
 * 挂载只做两轮纯读：list（清单 + 实体快照）→ image-caps（参考图能力）。
 * 只写扁平列的历史参考不自动建分层行：检测到即显式提示，用户点「固化为基准」才调回填端点。
 * 分层行是真源：增删改后服务端把 enabled 行重算回写扁平参考列，宿主据此决定保存要不要送扁平列。
 * 服务端错误（bad_role / conflict / not_found / stateKey 校验等）一律呈现 message 原文，不吞掉、不通用化。
 * 逐镜取用预览是同目录只读子区块：selected / fallbacks / dropped 与 reason 原文全部显式呈现。
 */
import { computed, onMounted, ref, watch } from 'vue'
import Icon from '../common/Icon.vue'
import EntityRefPreviewPanel from './EntityRefPreviewPanel.vue'
import {
  entityRefsApi,
  imageCapsApi,
  type EntityRefRole,
  type EntityRefView,
  type ImageCaps,
} from '../../lib/api/entityRefs'
import type { Asset } from '../../lib/types'

const props = defineProps<{
  entityId: number
  /** 实体名（仅标题文案；权威名称以服务端快照为准） */
  entityName: string
  /**
   * 宿主实时下发的状态条目（档案弹层传状态变体输入框的现值）。
   * 未下发（宿主不持有该数据）时用服务端快照兜底；下发空数组按「真的没有状态」处理。
   */
  states?: string[]
  projectId: number
  /** 宿主现成的图片资产数据源；为空时新增登记退化为手输资产 id */
  assets?: Asset[]
}>()

/** 回抛扁平参考列写权状态：count = 当前分层行数（展示用），failed = 清单读取失败；接管判定由宿主合成 */
const emit = defineEmits<{ flat: [s: { count: number; failed: boolean }] }>()

const refs = ref<EntityRefView[]>([])
/** 实体扁平参考列现值快照：用于判定是否存在「有参考、但没登记成分层行」的历史项 */
const flatIds = ref<number[]>([])
/** 服务端快照里的 states：仅在宿主未下发 states 时作为状态候选兜底 */
const snapshotStates = ref<string[]>([])
const caps = ref<ImageCaps | null>(null)
const loading = ref(true)
const errText = ref('')
const notice = ref('')
/** 行内操作 pending（启停/改层/删除共用一把锁，一次只做一个写操作） */
const busyRowId = ref<number | null>(null)
/** 回填（固化为基准）单独一把锁：它整批改写行，不属于单行操作 */
const solidifying = ref(false)

/**
 * 「改判为状态变体」待确认表单：role=state 必须绑定 stateKey，面板不替用户猜值。
 * pendRefId 记哪一行待确认、pendKey 记用户选的条目；确认前不发任何写请求。
 */
const pendRefId = ref<number | null>(null)
const pendKey = ref('')

// 新增登记表单
const addRole = ref<EntityRefRole>('base')
const addAssetSelect = ref<number | ''>('')
const addAssetRaw = ref('')
const addStateKey = ref('')
const addViewKey = ref('')
const addNote = ref('')
const addBusy = ref(false)
const addErr = ref('')

const ROLE_LABEL: Record<EntityRefRole, string> = {
  base: '基准',
  state: '状态变体',
  view: '多视角',
}

const hasAssetOptions = computed(() => (props.assets?.length ?? 0) > 0)

/**
 * 状态条目候选（下拉与失效判定同源）：逐条跟随宿主实时下发的 states，宿主增删条目后
 * 选项与「已失效」标记立即更新，无需关窗重开；宿主删空全部条目时候选就是空集，
 * 已有状态行随即判为失效（服务端不替用户删行，界面只标注、不静默改写）。
 */
const stateKeys = computed(() => props.states ?? snapshotStates.value)

/** 三层分组（base → state → view，组内保持服务端 id 序） */
const groups = computed(() =>
  (['base', 'state', 'view'] as EntityRefRole[]).map((role) => ({
    role,
    label: ROLE_LABEL[role],
    rows: refs.value.filter((r) => r.role === role),
  })),
)

/**
 * 扁平列里尚未登记成分层行的资产（任意 role 的行都算已登记）。
 * 出图挂接、上传、复用这些通道只写扁平列，所以它们留下的参考图处于「可被取用、不可被分层管理」态。
 */
const unregisteredFlat = computed(() => {
  const registered = new Set(refs.value.map((r) => r.assetId))
  return flatIds.value.filter((id) => !registered.has(id))
})

function assetOf(assetId: number): Asset | undefined {
  return props.assets?.find((a) => a.id === assetId)
}

function assetLabel(assetId: number): string {
  const a = assetOf(assetId)
  return a ? `#${assetId} ${a.name}` : `资产 #${assetId}`
}

function assetThumb(assetId: number): string | null {
  const a = assetOf(assetId)
  return a ? (a.urls.thumb ?? a.urls.file) : null
}

/** 三层为空时的语义提示（每层缺失的后果不同，逐层写清） */
const GROUP_EMPTY: Record<EntityRefRole, string> = {
  base: '无基准行：出图与一致性评价将回落扁平参考（未分层语义）',
  state: '无状态变体行：命中剧情节点状态时回退基准并留痕',
  view: '无多视角行：基准用满名额后不再补充视角',
}

/** select 事件值提取（模板内联 as 断言折行代价高，统一走这里） */
function evVal(e: Event): string {
  return (e.target as HTMLSelectElement).value
}

const negChip = computed(() =>
  caps.value?.supportsNegativePrompt ? '负向走供应商通道' : '负向走提示词锚点',
)
const assetInputHint = computed(() =>
  props.projectId
    ? '项目暂无图片资产：手输已有资产 id，或到素材页生成/上传'
    : '全局池暂无图片：手输已有资产 id，或先上传入池',
)

/** 提交用的资产 id：有下拉数据源取下拉值，否则解析手输数字 */
function pickedAssetId(): number | null {
  if (hasAssetOptions.value) {
    return typeof addAssetSelect.value === 'number'
      ? addAssetSelect.value
      : null
  }
  const n = Number(addAssetRaw.value.trim())
  return Number.isInteger(n) && n > 0 ? n : null
}

/** 行上绑定的状态条目是否已不在实体 states 中（只标记，不删行、不静默改值） */
function isStaleState(r: EntityRefView): boolean {
  const keys = stateKeys.value
  return r.role === 'state' && !!r.stateKey && !keys.includes(r.stateKey)
}

/** 角色下拉显示值：待确认行展示用户刚选的「状态变体」，其余行展示服务端现值 */
function roleValueOf(r: EntityRefView): string {
  return pendRefId.value === r.id ? 'state' : r.role
}

async function loadList(): Promise<void> {
  try {
    const snap = await entityRefsApi.list(props.entityId)
    refs.value = snap.refs
    flatIds.value = snap.entity.refAssetIds
    snapshotStates.value = snap.entity.states
    emit('flat', { count: snap.refs.length, failed: false })
  } catch (e) {
    errText.value = e instanceof Error ? e.message : String(e)
    // 读不到清单 = 分层状态未知，同样回抛：宿主据此本轮不回写扁平列
    emit('flat', { count: refs.value.length, failed: true })
  }
}

/** 打开/切换实体的一轮读取：list → caps（纯读；历史扁平参考的固化由用户点按钮触发） */
async function openCycle(): Promise<void> {
  loading.value = true
  errText.value = ''
  notice.value = ''
  cancelStateRole()
  await loadList()
  try {
    caps.value = await imageCapsApi.get()
  } catch (e) {
    caps.value = null
    errText.value =
      errText.value +
      (errText.value ? '；' : '') +
      (e instanceof Error ? e.message : String(e))
  }
  loading.value = false
}

/** 把未登记的历史扁平参考固化为基准分层行（服务端幂等，重跑无新增） */
async function solidifyFlat(): Promise<void> {
  if (solidifying.value) return
  solidifying.value = true
  errText.value = ''
  notice.value = ''
  try {
    const bf = await entityRefsApi.backfill(props.entityId)
    notice.value =
      bf.added > 0
        ? `已把 ${bf.added} 张历史扁平参考固化为基准分层行（可逐行调整层与启停）`
        : '这些历史参考已有分层行（回填幂等，本次无新增）'
    await loadList()
  } catch (e) {
    // 回填失败（如实体已删 404）：回读清单，由清单的同款服务端原文说明当前状态
    errText.value = e instanceof Error ? e.message : String(e)
    await loadList()
  } finally {
    solidifying.value = false
  }
}

async function toggleEnabled(r: EntityRefView): Promise<void> {
  if (busyRowId.value) return
  busyRowId.value = r.id
  errText.value = ''
  try {
    const next = await entityRefsApi.patch(r.id, { enabled: !r.enabled })
    refs.value = refs.value.map((x) => (x.id === r.id ? next : x))
  } catch (e) {
    errText.value = e instanceof Error ? e.message : String(e)
  } finally {
    busyRowId.value = null
  }
}

/**
 * 改层：切到 state 且行上还没有 stateKey → 只打开待确认表单，不发写请求；
 * 字段齐全（切到 base/view，或该行已绑定条目）才直接 PATCH。切离 state 显式清空 stateKey，
 * 否则行上会残留与新层不匹配的状态绑定。
 */
async function changeRole(r: EntityRefView, raw: string): Promise<void> {
  const role = raw as EntityRefRole
  if (busyRowId.value) return
  if (role === 'state' && !r.stateKey) {
    pendRefId.value = r.id
    pendKey.value = ''
    errText.value = ''
    return
  }
  cancelStateRole()
  busyRowId.value = r.id
  errText.value = ''
  try {
    const next = await entityRefsApi.patch(r.id, {
      role,
      stateKey: role === 'state' ? r.stateKey : null,
    })
    refs.value = refs.value.map((x) => (x.id === r.id ? next : x))
  } catch (e) {
    errText.value = e instanceof Error ? e.message : String(e)
    await loadList() // 失败不留半态：以服务端为准回读
  } finally {
    busyRowId.value = null
  }
}

/** 确认改层（该行唯一的写入点）：stateKey 留空时服务端拒 400，原文呈现且保留表单供改选 */
async function confirmStateRole(r: EntityRefView): Promise<void> {
  if (busyRowId.value) return
  busyRowId.value = r.id
  errText.value = ''
  try {
    const next = await entityRefsApi.patch(r.id, {
      role: 'state',
      stateKey: pendKey.value.trim(),
    })
    refs.value = refs.value.map((x) => (x.id === r.id ? next : x))
    cancelStateRole()
  } catch (e) {
    errText.value = e instanceof Error ? e.message : String(e)
    await loadList()
  } finally {
    busyRowId.value = null
  }
}

/** 取消/收起待确认表单：此期间没发出写请求，行仍是原层 */
function cancelStateRole(): void {
  pendRefId.value = null
  pendKey.value = ''
}

async function changeStateKey(r: EntityRefView, key: string): Promise<void> {
  if (busyRowId.value || !key) return
  busyRowId.value = r.id
  errText.value = ''
  try {
    const next = await entityRefsApi.patch(r.id, { stateKey: key })
    refs.value = refs.value.map((x) => (x.id === r.id ? next : x))
  } catch (e) {
    errText.value = e instanceof Error ? e.message : String(e)
    await loadList()
  } finally {
    busyRowId.value = null
  }
}
async function removeRef(r: EntityRefView): Promise<void> {
  if (busyRowId.value) return
  busyRowId.value = r.id
  errText.value = ''
  try {
    await entityRefsApi.remove(r.id)
    refs.value = refs.value.filter((x) => x.id !== r.id)
    cancelStateRole()
    // 删到零行也照实回抛行数：接管是否放开由宿主按「本弹层内出现过分层行」判定
    emit('flat', { count: refs.value.length, failed: false })
  } catch (e) {
    errText.value = e instanceof Error ? e.message : String(e)
    await loadList()
  } finally {
    busyRowId.value = null
  }
}
async function submitAdd(): Promise<void> {
  addErr.value = ''
  const assetId = pickedAssetId()
  if (assetId === null) {
    addErr.value = hasAssetOptions.value
      ? '请选择一张图片资产'
      : 'assetId 需为正整数（宿主未带资产数据源时手输）'
    return
  }
  if (addRole.value === 'state' && !addStateKey.value) {
    addErr.value =
      'role=state 必须选择状态变体（stateKey 需精确命中实体 states 条目）'
    return
  }
  addBusy.value = true
  try {
    await entityRefsApi.add(props.entityId, {
      assetId,
      role: addRole.value,
      stateKey: addRole.value === 'state' ? addStateKey.value : null,
      viewKey:
        addRole.value === 'view' ? addViewKey.value.trim() || null : null,
      note: addNote.value.trim() || null,
    })
    addAssetSelect.value = ''
    addAssetRaw.value = ''
    addStateKey.value = ''
    addViewKey.value = ''
    addNote.value = ''
    // 新增会触发服务端回填 + 派生重算，清单必须以服务端为准整体回读
    await loadList()
  } catch (e) {
    addErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    addBusy.value = false
  }
}

onMounted(() => {
  void openCycle()
})

watch(
  () => props.entityId,
  () => void openCycle(),
)
</script>

<template>
  <div class="eref">
    <div class="eref-head">
      <Icon name="layers" :size="13" />
      <span class="eref-title">参考分层管理（{{ entityName }}）</span>
      <span v-if="loading" class="muted">加载中…</span>
      <button v-else class="btn sm" title="回读清单与能力" @click="openCycle">
        <Icon name="refresh" :size="11" /> 刷新
      </button>
    </div>
    <div v-if="errText" class="err-text">{{ errText }}</div>
    <div v-if="notice" class="eref-notice">{{ notice }}</div>
    <div v-if="caps && !caps.supportsRefs" class="caps-warn" role="status">
      <Icon name="alert" :size="13" />
      <span>当前图像模型不支持参考图，角色一致性仅靠文本锚定</span>
      <p v-for="(n, i) in caps.notes" :key="i" class="caps-note">{{ n }}</p>
    </div>
    <div v-else-if="caps" class="caps-ok" role="status">
      <Icon name="check" :size="13" />
      <span>参考图上限 {{ caps.maxRefs }}</span>
      <span class="chip">{{ negChip }}</span>
      <p v-for="(n, i) in caps.notes" :key="i" class="caps-note">{{ n }}</p>
    </div>

    <!-- 只写扁平列的历史参考：可被取用，但启停与分层归属都管不到它们 -->
    <div v-if="unregisteredFlat.length" class="flat-warn" role="status">
      <Icon name="alert" :size="13" />
      <span>
        有 {{ unregisteredFlat.length }} 张参考图只挂在扁平参考列（
        {{ unregisteredFlat.map((id) => `#${id}`).join(' ') }}
        ），出图按隐式基准取用，但无法逐行管理。
      </span>
      <button
        class="btn sm"
        title="把每张未登记的参考图各登记为一行基准"
        :disabled="solidifying || busyRowId !== null"
        @click="solidifyFlat"
      >
        {{ solidifying ? '固化中…' : '固化为基准' }}
      </button>
    </div>

    <div v-for="g in groups" :key="g.role" class="grp">
      <div class="grp-h">
        <span class="grp-t">{{ g.label }}</span>
        <span class="muted">{{ g.rows.length }} 行</span>
      </div>
      <div v-if="!g.rows.length" class="muted grp-empty">
        {{ GROUP_EMPTY[g.role] }}
      </div>
      <div v-for="r in g.rows" :key="r.id" :class="r.enabled ? 'r' : 'r off'">
        <img
          v-if="assetThumb(r.assetId)"
          class="rthumb"
          :src="assetThumb(r.assetId) ?? ''"
          :alt="assetLabel(r.assetId)"
          loading="lazy"
        />
        <span v-else class="rthumb rph"><Icon name="photo" :size="14" /></span>
        <div class="rmain">
          <div class="rline">
            <span class="rname">{{ assetLabel(r.assetId) }}</span>
            <span v-if="r.stateKey" class="chip">{{ r.stateKey }}</span>
            <span v-if="r.viewKey" class="chip">{{ r.viewKey }}</span>
            <span v-if="!r.enabled" class="badge skip">已停用</span>
            <span v-if="isStaleState(r)" class="badge queued">状态已失效</span>
          </div>
          <div v-if="r.note" class="muted rnote">{{ r.note }}</div>
          <div v-if="isStaleState(r)" class="muted rstale">
            行上的「{{ r.stateKey }}」已不在该实体当前 states
            里：命中该状态时取不到这行，请改选现有条目或停用/删除该行（面板不替你改值）。
          </div>
        </div>
        <div class="rops">
          <select
            class="rsel"
            aria-label="该行的分层角色"
            :value="roleValueOf(r)"
            :disabled="busyRowId !== null"
            @change="changeRole(r, evVal($event))"
          >
            <option value="base">基准</option>
            <option value="state">状态变体</option>
            <option value="view">多视角</option>
          </select>
          <!-- 待确认改层：下拉只预填，确认前该行仍是原层 -->
          <select
            v-if="pendRefId === r.id"
            v-model="pendKey"
            class="rsel"
            aria-label="为该行选择状态条目"
          >
            <option value="" disabled selected>选状态条目…</option>
            <option v-for="s in stateKeys" :key="s" :value="s">{{ s }}</option>
          </select>
          <select
            v-else-if="r.role === 'state'"
            class="rsel"
            aria-label="绑定的状态条目"
            :value="r.stateKey ?? ''"
            :disabled="busyRowId !== null"
            @change="changeStateKey(r, evVal($event))"
          >
            <option v-if="!r.stateKey" value="" disabled selected>
              选状态条目…
            </option>
            <!-- 失效条目仍列出：保留该行现值可见，改选或停用由用户决定 -->
            <option v-if="isStaleState(r)" :value="r.stateKey ?? ''">
              {{ r.stateKey }}（已失效）
            </option>
            <option v-for="s in stateKeys" :key="s" :value="s">
              {{ s }}
            </option>
          </select>
          <template v-if="pendRefId === r.id">
            <button
              class="btn sm primary"
              :disabled="busyRowId !== null"
              @click="confirmStateRole(r)"
            >
              确认改层
            </button>
            <button class="btn sm" @click="cancelStateRole">取消</button>
          </template>
          <template v-else>
            <button
              class="btn sm"
              :title="r.enabled ? '停用该行（不再参与取用与派生）' : '启用该行'"
              :disabled="busyRowId !== null"
              @click="toggleEnabled(r)"
            >
              {{ r.enabled ? '停用' : '启用' }}
            </button>
            <button
              class="btn sm danger"
              title="删除该行"
              :disabled="busyRowId !== null"
              @click="removeRef(r)"
            >
              <Icon name="trash" :size="12" />
            </button>
          </template>
        </div>
      </div>
    </div>

    <div class="addbox">
      <div class="grp-h">
        <Icon name="plus" :size="12" />
        <span class="grp-t">新增登记</span>
      </div>
      <div class="addrow">
        <select
          v-if="hasAssetOptions"
          v-model="addAssetSelect"
          class="agrow"
          aria-label="选择图片资产"
        >
          <option :value="''" disabled selected>选择图片资产…</option>
          <option v-for="a in assets" :key="a.id" :value="a.id">
            #{{ a.id }} {{ a.name }}
          </option>
        </select>
        <input
          v-else
          v-model="addAssetRaw"
          type="number"
          min="1"
          step="1"
          class="agrow"
          placeholder="资产 id（正整数）"
          aria-label="资产 id"
          :title="assetInputHint"
        />
        <select v-model="addRole" class="agrow" aria-label="分层角色">
          <option value="base">基准</option>
          <option value="state">状态变体</option>
          <option value="view">多视角</option>
        </select>
        <select
          v-if="addRole === 'state'"
          v-model="addStateKey"
          class="agrow"
          aria-label="状态条目（需精确命中实体 states）"
        >
          <option value="" disabled selected>选状态条目…</option>
          <option v-for="s in stateKeys" :key="s" :value="s">{{ s }}</option>
        </select>
        <input
          v-if="addRole === 'view'"
          v-model="addViewKey"
          type="text"
          class="agrow"
          placeholder="视角标记（如 正面/侧面）"
          aria-label="视角标记"
        />
        <input
          v-model="addNote"
          type="text"
          class="agrow"
          placeholder="备注（选填）"
          aria-label="备注"
        />
        <button class="btn sm primary" :disabled="addBusy" @click="submitAdd">
          {{ addBusy ? '登记中…' : '登记' }}
        </button>
      </div>
      <div v-if="addRole === 'state' && !stateKeys.length" class="muted aghint">
        该实体未登记任何状态条目：先在上方「状态变体
        states」补充并保存，再来绑定。
      </div>
      <div v-if="addErr" class="err-text">{{ addErr }}</div>
    </div>

    <EntityRefPreviewPanel :entity-id="entityId" :role-labels="ROLE_LABEL" />
  </div>
</template>

<style scoped>
.eref {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  padding: 10px 12px;
}
.eref-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}
.eref-title {
  color: var(--text);
}
.eref-notice {
  font-size: 12px;
  color: var(--ok);
  background: var(--ok-weak);
  border-radius: var(--radius-sm);
  padding: 6px 9px;
}
/* 能力提示条 */
.caps-warn,
.caps-ok {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  border-radius: var(--radius-sm);
  padding: 6px 9px;
}
.caps-warn {
  color: var(--warn);
  background: var(--warn-weak);
}
.caps-ok {
  color: var(--text-2);
  background: var(--ok-weak);
}
.caps-warn > span,
.caps-ok > span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.caps-note {
  margin: 0;
  font-size: 11px;
  color: var(--text-3);
  word-break: break-all;
}
/* 未分层历史参考提示条 */
.flat-warn {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--warn);
  background: var(--warn-weak);
  border-radius: var(--radius-sm);
  padding: 6px 9px;
}
/* 分组 */
.grp,
.addbox {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-top: 7px;
  border-top: 1px dashed var(--border);
}
.grp-h {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-2);
}
.grp-t {
  font-weight: 600;
  color: var(--text);
}
.grp-empty {
  font-size: 11.5px;
}
.r {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  background: var(--panel);
}
.r.off {
  opacity: 0.55;
}
.rthumb {
  flex: none;
  width: 34px;
  height: 42px;
  border-radius: 6px;
  border: 1px solid var(--border);
  object-fit: contain;
  background: var(--img-ph);
}
.rph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}
.rmain {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rline {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
}
.rname {
  font-weight: 500;
  word-break: break-all;
}
.rnote {
  font-size: 11px;
}
.rstale {
  font-size: 11px;
  line-height: 1.5;
}
.rops {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}
.rsel {
  font-size: 11.5px;
  padding: 2px 4px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  color: var(--text);
  max-width: 140px;
}
/* 新增/预览行 */
.addrow {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.agrow {
  font-size: 12px;
  padding: 4px 7px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  min-width: 0;
  max-width: 220px;
}
.aghint {
  font-size: 11.5px;
  line-height: 1.5;
}
</style>
