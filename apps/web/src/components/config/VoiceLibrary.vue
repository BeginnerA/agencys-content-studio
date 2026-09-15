<script setup lang="ts">
/**
 * [M19 P8] 平台音色库（spec §2.2 ⑧）：克隆音色列表 / 试听 / 删除 + 新建（样本 → 供应商声音复刻）。
 * - 供应商下拉按能力位矩阵渲染：available=false（未登记克隆协议）置灰不可选
 * - 样本硬校验前置（≤10MB、wav/mp3）；复刻为同步调用，成功才落行，失败显示供应商详情且不落库
 * - 音色引用语法 clone:{id}：角色库 voice / params.voice / voice_hint 任一级写此值即命中（引用失效自动降级）
 * 密钥不落本表——服务端经 Settings → 语音合成实例解析端点与 Key。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { voiceCloneApi } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import type { VoiceCloneItem, VoiceCloneProvider } from '../../lib/types'
import { fmtSize, fmtTime } from '../../lib/format'
import Icon from '../common/Icon.vue'

const SAMPLE_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_TEST_TEXT = '大家好，这是一段克隆音色的试听效果。'

const items = ref<VoiceCloneItem[]>([])
const providers = ref<VoiceCloneProvider[]>([])
const loading = ref(true)
const busy = ref(false)
const err = ref('')
const notice = ref('')
const warns = ref<string[]>([])

// ---------- 新建表单 ----------
const fName = ref('')
const fProvider = ref('')
const fModel = ref('')
const fFile = ref<File | null>(null)
/** 文件输入重挂键（提交成功/清除后清掉原生 input 的脏残留） */
const fileKey = ref(0)

const providerSpec = computed(() => providers.value.find((p) => p.key === fProvider.value) ?? null)
const canCreate = computed(
  () => !!fName.value.trim() && !!providerSpec.value?.available && !!fFile.value && !busy.value,
)

function onPick(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0] ?? null
  err.value = ''
  if (!f) {
    fFile.value = null
    return
  }
  if (!/\.(wav|mp3)$/i.test(f.name) && !/audio\/(wav|x-wav|wave|mpeg|mp3)/i.test(f.type)) {
    err.value = '样本需为 WAV 或 MP3 音频文件'
    fFile.value = null
    fileKey.value += 1
    return
  }
  if (f.size > SAMPLE_MAX_BYTES) {
    err.value = `样本超过 10MB 上限（${fmtSize(f.size)}）——请截取 10~20 秒人声片段`
    fFile.value = null
    fileKey.value += 1
    return
  }
  fFile.value = f
}

async function load() {
  loading.value = true
  try {
    const res = await voiceCloneApi.list()
    items.value = res.items
    providers.value = res.providers
    if (!fProvider.value) fProvider.value = res.providers.find((p) => p.available)?.key ?? ''
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
onMounted(() => void load())

async function doCreate() {
  if (!canCreate.value || !fFile.value) return
  busy.value = true
  err.value = ''
  notice.value = ''
  warns.value = []
  try {
    const res = await voiceCloneApi.create({
      name: fName.value.trim(),
      provider: fProvider.value,
      file: fFile.value,
      targetModel: fModel.value.trim() || undefined,
    })
    warns.value = res.warnings ?? []
    notice.value = `✓ 音色「${res.clone.name}」复刻完成（#${res.clone.id}）——角色声线填 clone:${res.clone.id} 即可使用`
    fName.value = ''
    fModel.value = ''
    fFile.value = null
    fileKey.value += 1
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

// ---------- 列表操作 ----------
async function doDelete(r: VoiceCloneItem) {
  const ok = await confirmDialog({
    title: '移除音色',
    message: `从音色库移除「${r.name}」（clone:${r.id}）？供应商侧音色不会被删除，可在供应商控制台清理；引用它的声线将自动降级。`,
    confirmText: '移除',
    danger: true,
  })
  if (!ok) return
  err.value = ''
  try {
    const res = await voiceCloneApi.remove(r.id)
    if (previewId.value === r.id) stopPreview()
    notice.value = `✓ ${res.note}`
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

const testText = ref(DEFAULT_TEST_TEXT)
const previewId = ref<number | null>(null)
const previewUrl = ref('')
const previewing = ref<number | null>(null)

function stopPreview() {
  previewId.value = null
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
}

async function doPreview(r: VoiceCloneItem) {
  if (previewing.value !== null) return
  const text = testText.value.trim()
  if (!text) {
    err.value = '试听文本不能为空'
    return
  }
  if (text.length > 200) {
    err.value = `试听文本上限 200 字（当前 ${text.length} 字）`
    return
  }
  err.value = ''
  previewing.value = r.id
  try {
    const blob = await voiceCloneApi.test(r.id, text)
    stopPreview()
    previewId.value = r.id
    previewUrl.value = URL.createObjectURL(blob)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    previewing.value = null
  }
}

async function copyRef(r: VoiceCloneItem) {
  const token = `clone:${r.id}`
  try {
    await navigator.clipboard.writeText(token)
    notice.value = `✓ 已复制引用令牌 ${token}`
  } catch {
    err.value = `浏览器拒绝剪贴板访问——请手动填写：${token}`
  }
}

onBeforeUnmount(() => {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
})

function metaOf(r: VoiceCloneItem): { protocol?: string; prefix?: string } {
  try {
    return JSON.parse(r.meta || '{}') as { protocol?: string; prefix?: string }
  } catch {
    return {}
  }
}
</script>

<template>
  <div class="vl">
    <div class="vl-sum">
      <Icon name="speaker-wave" :size="14" />
      <b>平台音色库</b>
      <span class="muted">
        样本要求：WAV / MP3、含 ≥5 秒连续清晰人声（建议 10~20 秒）、≤10MB；复刻成功后在角色声线填
        <code class="mono">clone:{id}</code> 引用
      </span>
    </div>

    <!-- 新建克隆音色 -->
    <section class="vl-sec">
      <div class="vl-h"><Icon name="plus" :size="13" /> 新建克隆音色</div>
      <div class="vl-grid">
        <label class="vl-f">
          <span>音色名</span>
          <input v-model="fName" type="text" maxlength="64" placeholder="如：萌宝-童声A（同名会被拒绝）" />
        </label>
        <label class="vl-f">
          <span>供应商</span>
          <select v-model="fProvider">
            <option value="" disabled>选择供应商</option>
            <option v-for="p in providers" :key="p.key" :value="p.key" :disabled="!p.available">
              {{ p.name }}{{ p.available ? '' : '（不支持克隆）' }}
            </option>
          </select>
        </label>
        <label class="vl-f">
          <span>目标模型</span>
          <input v-model="fModel" type="text" placeholder="留空 = 供应商默认克隆模型" />
        </label>
        <label class="vl-f">
          <span>样本文件</span>
          <input :key="fileKey" type="file" accept=".wav,.mp3,audio/wav,audio/mpeg" @change="onPick" />
        </label>
      </div>
      <div class="vl-row">
        <span class="muted grow">
          {{ fFile ? `已选样本：${fFile.name} · ${fmtSize(fFile.size)}` : '未选择样本（本地文件以 Base64 内联提交，不落盘）' }}
        </span>
        <button class="btn sm primary" :disabled="!canCreate" @click="doCreate">
          <Icon name="sparkles" :size="13" /> {{ busy ? '复刻中（约 10~60 秒）…' : '开始复刻' }}
        </button>
      </div>
      <div v-if="!providers.some((p) => p.available)" class="vl-tip">
        当前 audio 供应商目录中无可克隆协议的供应商——需在「语音合成」tab 配置支持声音复刻的实例后方可使用
      </div>
    </section>

    <!-- 音色列表 -->
    <section class="vl-sec">
      <div class="vl-h">
        <Icon name="inbox" :size="13" /> 音色列表（{{ items.length }}）
        <span class="vl-tip grow">试听不落资产、不计费</span>
      </div>

      <div class="vl-row">
        <input v-model="testText" type="text" class="grow" maxlength="200" placeholder="试听文本（≤200 字）" />
      </div>

      <div v-if="loading" class="muted">加载中…</div>
      <div v-else-if="!items.length" class="muted">暂无克隆音色——填写上方表单开始复刻</div>
      <table v-else class="vl-tbl">
        <thead>
          <tr>
            <th>音色名</th>
            <th>供应商 / 模型</th>
            <th>voice_id</th>
            <th>引用</th>
            <th>创建时间</th>
            <th style="width: 158px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in items" :key="r.id">
            <td>
              <div class="vl-name">{{ r.name }}</div>
              <div v-if="metaOf(r).protocol" class="muted mono">{{ metaOf(r).protocol }}</div>
            </td>
            <td class="mono">{{ r.providerKey }}<br />{{ r.model }}</td>
            <td class="mono vl-dim" :title="r.voiceId">{{ r.voiceId }}</td>
            <td>
              <button class="vl-ref mono" title="点击复制引用令牌" @click="copyRef(r)">clone:{{ r.id }}</button>
            </td>
            <td class="muted">{{ fmtTime(r.createdAt) }}</td>
            <td>
              <div class="vl-acts">
                <button class="btn sm" :disabled="previewing !== null" @click="doPreview(r)">
                  <Icon name="play" :size="12" /> {{ previewing === r.id ? '合成中…' : '试听' }}
                </button>
                <button class="btn sm danger" @click="doDelete(r)">
                  <Icon name="trash" :size="12" />
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="previewUrl" class="vl-preview">
        <span class="muted">试听 #{{ previewId }}：</span>
        <audio :src="previewUrl" controls autoplay />
        <button class="btn sm" @click="stopPreview">
          <Icon name="x" :size="12" /> 关闭
        </button>
      </div>
    </section>

    <div v-if="err" class="err-text">{{ err }}</div>
    <div v-if="notice" class="vl-ok"><Icon name="check" :size="12" /> {{ notice }}</div>
    <ul v-if="warns.length" class="vl-warns">
      <li v-for="(w, i) in warns" :key="i"><Icon name="alert" :size="12" /> {{ w }}</li>
    </ul>
  </div>
</template>

<style scoped>
.vl {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 13px;
}

.vl-sum {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 13px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
}

.vl-sec {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 11px 13px;
  background: var(--panel);
}

.vl-h {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 12.5px;
}

.vl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}

.vl-f {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-2);
}

.vl-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.grow {
  flex: 1;
  min-width: 0;
}

.vl-tip {
  font-size: 11.5px;
  color: var(--text-3);
}

.vl-tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.vl-tbl th {
  text-align: left;
  font-weight: 500;
  font-size: 11.5px;
  color: var(--text-3);
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
}

.vl-tbl td {
  padding: 7px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}

.vl-name {
  font-weight: 600;
}

.vl-dim {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}

.vl-ref {
  border: 1px dashed var(--border-strong);
  background: transparent;
  color: var(--accent);
  border-radius: 6px;
  padding: 2px 6px;
  font-size: 11.5px;
  cursor: pointer;
}

.vl-acts {
  display: flex;
  align-items: center;
  gap: 6px;
}

.vl-preview {
  display: flex;
  align-items: center;
  gap: 10px;
}

.vl-preview audio {
  height: 34px;
  min-width: 300px;
}

.vl-ok {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ok);
  font-size: 12.5px;
}

.vl-warns {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 8px 12px 8px 26px;
  border: 1px solid var(--warn);
  border-radius: 8px;
  background: var(--warn-weak);
  color: var(--warn);
  font-size: 12px;
  list-style: none;
}

.vl-warns li {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
</style>
