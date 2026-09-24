<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { confirmDialog } from '../../lib/confirm'
import Icon from '../../components/common/Icon.vue'
import AssetPreviewer from '../../components/asset/previewer/index.vue'
import AssetPickerModal from './AssetPickerModal.vue'
import MessageRefBubble from './MessageRefBubble.vue'
import AttachmentTray from './AttachmentTray.vue'
import { assetApi } from '../../lib/api'
import { CREATION_ROLE_LABELS, creationSystemLabel } from '../../lib/types'
import { isAttachment, refAssetId } from './ref-utils'
import type { Asset, CreationChatMessage } from '../../lib/types'
import type { useEasyCreate } from './use-creation-chat'

const props = defineProps<{ s: ReturnType<typeof useEasyCreate> }>()
const draft = ref('')
const scroller = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
// 从素材选取弹窗
const showPicker = ref(false)

// 新消息滚动到底部（尊重 reduced-motion：无平滑）
watch(
  () => [
    props.s.state.detail?.messages.length ?? 0,
    props.s.state.detail?.session.status,
  ],
  () =>
    void nextTick(() => {
      if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
    }),
)

const uploading = () => props.s.uploadingAttachments.value

const started = computed(() => !!props.s.state.detail?.session.runId)
const inputLocked = computed(() => props.s.first.locked.value || planning() || props.s.state.loadingDetail)
watch(() => props.s.first.state.ticket?.content, (content, previous) => {
  if (props.s.first.active.value && content !== undefined) draft.value = content
  else if (previous !== undefined) draft.value = ''
}, { immediate: true })
watch(draft, (value) => props.s.first.setContent(value), { flush: 'sync' })
watch(() => props.s.state.currentId, () => { draft.value = ''; previewAsset.value = null; showPicker.value = false; previewSeq++ })

// system 留痕按类型给来源标签与图标（审阅 / 返修 / 合成）：机器记录不伪装成策划助手的话
function whoLabel(m: CreationChatMessage): string {
  return m.role === 'system' ? creationSystemLabel(m.payload?.kind) : CREATION_ROLE_LABELS[m.role]
}
function avatarIcon(m: CreationChatMessage): string {
  if (m.role === 'user') return 'users'
  if (m.role !== 'system') return 'wand'
  const kind = m.payload?.kind
  return kind === 'rework' || kind === 'rework_plan' || kind === 'recompose' ? 'pencil' : 'eye'
}

async function submit(): Promise<void> {
  const text = draft.value.trim()
  const id = props.s.state.currentId
  if (!text || planning() || props.s.first.busy.value || uploading() || props.s.state.loadingDetail) return
  const replan = props.s.first.active.value && props.s.first.state.phase === 'failed'
  if (replan && !await confirmDialog({ title: '重新规划', message: '上次规划失败。重新规划将再次调用模型，可能再次产生规划及参考解析费用。是否继续？', confirmText: '确认重新规划' })) return
  if (id !== props.s.state.currentId) return
  const ok = await props.s.send(text, replan)
  if (ok && id === props.s.state.currentId && draft.value.trim() === text) draft.value = ''
}

// 素材弹窗确认：逐个登记为参考（服务端校验/复制；托盘内去重与上限由状态机把守；串行保证托盘顺序）
async function onPickAssets(picked: Asset[]): Promise<void> {
  showPicker.value = false
  const id = props.s.state.currentId
  for (const a of picked) { if (id !== props.s.state.currentId) break; await props.s.addAssetReference(a) }
}

// 对话内参考素材：缩略图展示 + 点击查看（复用统一 AssetPreviewer，零新预览实现；
// 展示元信息纯函数另拆 ref-utils，气泡组件另拆 MessageRefBubble）
const previewAsset = ref<Asset | null>(null)
const refLoading = ref<number | null>(null)
let previewSeq = 0
async function openRefPreview(m: CreationChatMessage): Promise<void> {
  const id = refAssetId(m)
  if (!id || refLoading.value === id) return
  refLoading.value = id
  const token = ++previewSeq
  try {
    const { asset } = await assetApi.detail(id)
    if (token === previewSeq) previewAsset.value = asset
  } catch (e) {
    if (token === previewSeq) props.s.state.error = `无法打开参考素材：${(e as Error).message}`
  } finally {
    if (token === previewSeq) refLoading.value = null
  }
}

// 追问问题：点击填入输入框，便于用户直接作答
function useQuestion(q: string): void {
  if (inputLocked.value) return
  draft.value = draft.value.trim() ? `${draft.value.trim()}\n${q}` : q
}

const planning = () =>
  props.s.state.detail?.session.status === 'planning' || props.s.state.busySend || props.s.first.state.phase === 'sending'

// 参考附件：选件即预校验+上传（不计费）；role 默认按 kind 推断可改
function pickFiles(): void {
  fileInput.value?.click()
}
async function onFiles(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  const id = props.s.state.currentId
  for (const f of files) { if (id !== props.s.state.currentId) break; await props.s.addAttachment(f) }
}
</script>

<template>
  <section class="conv panel" aria-label="创作对话">
    <div ref="scroller" class="msgs" role="log" aria-live="polite">
      <div v-if="!s.state.detail?.messages.length" class="hello">
        <span class="hello-ic">
          <Icon name="sparkles" :size="20" />
        </span>
        <p class="hello-t">用一句话描述你想做的视频</p>
        <p class="muted">比如「做一条 30 秒的咖啡科普短视频，轻松一点」。</p>
        <p class="muted">
          未指定时默认竖屏 9:16、中文旁白、30
          秒、动态镜头。产品参数、价格、功效缺失不会编造。
        </p>
      </div>
      <div
        v-for="m in s.state.detail?.messages ?? []"
        :key="m.id"
        class="msg"
        :class="m.role"
      >
        <span class="avatar" :class="m.role" aria-hidden="true">
          <Icon :name="avatarIcon(m)" :size="15" />
        </span>
        <div class="mcol">
          <div class="who">{{ whoLabel(m) }}</div>
          <MessageRefBubble
            v-if="isAttachment(m)"
            :m="m"
            :loading="refLoading === refAssetId(m)"
            :shots="s.state.detail?.session.plan?.shots ?? null"
            @open="openRefPreview(m)"
          />
          <div v-else class="bubble">{{ m.content }}</div>
          <div
            v-if="m.payload?.kind === 'clarify' && m.payload.questions?.length"
            class="qs"
          >
            <div class="qs-h">
              <Icon name="chat" :size="12" /> 点击下方问题可直接作答
            </div>
            <button
              v-for="(q, i) in m.payload.questions"
              :key="i"
              class="qs-item"
              type="button"
              :disabled="inputLocked"
              @click="useQuestion(q)"
            >
              <span class="qs-ic" aria-hidden="true">
                <Icon name="chevron-right" :size="14" />
              </span>
              <span class="qs-tx">{{ q }}</span>
            </button>
          </div>
        </div>
      </div>
      <div v-if="planning()" class="msg assistant">
        <span class="avatar assistant" aria-hidden="true">
          <Icon name="wand" :size="15" />
        </span>
        <div class="mcol">
          <div class="who">策划助手</div>
          <div class="bubble wait">
            <span class="dot" /><span class="dot" /><span class="dot" />
            正在理解需求并生成方案…（本步骤会调用模型，可能产生费用）
          </div>
        </div>
      </div>
    </div>

    <div v-if="s.state.error || s.state.detail?.session.error" class="err-text pad" role="alert">{{ s.state.error || s.state.detail?.session.error }}</div>
    <p v-if="s.first.state.warning" class="muted pad" role="status">{{ s.first.state.warning }}</p>
    <p v-if="s.first.state.phase === 'uploading'" class="muted pad" role="status">正在核对会话并登记参考，全部成功后才提交规划。</p>
    <div v-if="s.state.notice && !s.state.error" class="muted pad note-text">
      {{ s.state.notice }}
    </div>

    <form class="composer" @submit.prevent="submit">
      <AttachmentTray v-if="!started && s.state.attachments.length" :s="s" />
      <label class="ec-input-label" for="ec-detail-input">{{ started ? '记录下一版建议，不会修改当前制作' : '补充要求或修改方案' }}</label>
      <textarea
        id="ec-detail-input"
        v-model="draft"
        rows="2"
        :maxlength="6000"
        :disabled="inputLocked"
        :placeholder="started ? (s.rework.canUse.value ? '写下下一版想调整的内容；只想改个别镜头？用成果面板的局部返修' : '写下下一版想调整的内容') : '描述需求或回答助手的追问'"
        aria-label="创作需求"
        @keydown.enter.exact.prevent="submit"
      />
      <!-- [布局重设计] 按钮行只放按钮：左工具簇 / 右动作簇两端对齐；计费提示降为下方独立 helper 行 -->
      <div class="crow">
        <input
          ref="fileInput"
          class="file-in"
          type="file"
          accept="image/*,video/*,audio/*"
          multiple
          @change="onFiles"
        />
        <div v-if="!started" class="crow-tools">
          <button
            class="btn sm ghost att-btn"
            type="button"
            :disabled="s.attachmentsLocked.value"
            @click="pickFiles"
          >
            <Icon name="upload" :size="13" /> 添加参考
          </button>
          <button
            class="btn sm ghost att-btn"
            type="button"
            :disabled="s.attachmentsLocked.value"
            title="从各项目素材库选取存量图 / 视频 / 音频"
            @click="showPicker = true"
          >
            <Icon name="arrange" :size="13" /> 从素材选取
          </button>
        </div>
        <div class="crow-actions">
          <button
            v-if="!s.state.detail?.progress"
            class="btn sm ghost"
            type="button"
            :disabled="s.state.loadingDetail || s.first.busy.value"
            @click="s.refreshStatus"
          >
            <Icon name="refresh" :size="13" /> 更新状态
          </button>
          <button
            class="btn primary"
            type="submit"
            :disabled="planning() || s.first.busy.value || uploading() || s.state.loadingDetail || !draft.trim()"
          >
            <Icon name="send" :size="13" />
            {{ s.first.busy.value || uploading() ? '处理中…' : started ? '记录建议' : s.first.state.phase === 'failed' ? '重新规划' : s.first.state.phase === 'uncertain' ? '核对后继续' : s.first.active.value ? '继续生成方案' : '发送' }}
          </button>
        </div>
      </div>
      <p v-if="!started" class="muted cost-hint">
        <Icon name="alert" :size="12" />
        上传/选取参考本身不计费；参考视频解析会额外调用多模态/转写，媒体制作在确认方案后进行。
      </p>
    </form>

    <AssetPreviewer
      v-if="previewAsset"
      :assets="[previewAsset]"
      :index="0"
      @close="previewAsset = null"
    />

    <AssetPickerModal
      v-if="showPicker"
      @close="showPicker = false"
      @pick="onPickAssets"
    />
  </section>
</template>

<style scoped>
.ec-input-label { display: block; margin-bottom: 8px; color: var(--text-2); font-size: 13px; }
.composer .btn {
  min-height: 30px;
  padding: 4px 12px;
  font-size: 12px;
  border-radius: 8px;
}
.conv {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.msgs {
  flex: 1;
  overflow-y: auto;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.hello {
  margin: auto;
  text-align: center;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.7;
  max-width: 380px;
}

.hello-ic {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  border-radius: 14px;
  margin-bottom: 10px;
  background: var(--accent-weak);
  border: 1px solid rgb(99 102 241 / 35%);
  color: var(--accent-h);
}

.hello-t {
  margin: 0 0 6px;
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text);
}

.hello p {
  margin: 4px 0 0;
}

.msg {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.msg.user {
  flex-direction: row-reverse;
}

.avatar {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  margin-top: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.avatar.assistant {
  background: var(--accent-weak);
  border: 1px solid rgb(99 102 241 / 34%);
  color: var(--accent-h);
}

.avatar.user {
  background: var(--grad-brand);
  color: #fff;
  box-shadow: 0 4px 12px -6px rgb(79 70 229 / 60%);
}

/* 审阅决策留痕：系统记录与助手回复视觉区分（虚线 + 弱化色），不伪装成策划助手的话 */
.avatar.system {
  background: var(--raised);
  border: 1px dashed var(--border-strong);
  color: var(--text-2);
}

.msg.system .bubble {
  background: var(--panel-2);
  border-style: dashed;
  color: var(--text-2);
}

.mcol {
  min-width: 0;
  max-width: 82%;
  display: flex;
  flex-direction: column;
}

.msg.user .mcol {
  align-items: flex-end;
}

.msg .who {
  font-size: 11px;
  color: var(--text-3);
  margin-bottom: 4px;
  padding: 0 2px;
}

.bubble {
  display: inline-block;
  padding: 10px 14px;
  border-radius: 13px;
  font-size: 13.5px;
  line-height: 1.68;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-top-left-radius: 5px;
}

.msg.user .bubble {
  background: var(--grad-brand);
  border-color: rgb(99 102 241 / 55%);
  color: #fff;
  border-top-left-radius: 13px;
  border-top-right-radius: 5px;
  box-shadow: 0 6px 18px -12px rgb(79 70 229 / 70%);
}

.msg.assistant .bubble.wait {
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--run);
  display: inline-block;
  animation: blink 1.1s infinite;
}

.dot:nth-child(2) {
  animation-delay: 0.18s;
}

.dot:nth-child(3) {
  animation-delay: 0.36s;
}

.qs {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

/* 追问区标题：点明“可点击直接作答”的交互预期 */
.qs-h {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-3);
  padding-left: 2px;
}

.qs-h .ic {
  color: var(--accent-h);
}

/* 建议卡：左对齐整宽卡片（替代旧胶囊 pill），前置动作图标 + 悬停反馈 */
.qs-item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--border-strong);
  background: var(--raised);
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.55;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s,
    box-shadow 0.15s,
    transform 0.15s;
}

.qs-ic {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-weak);
  border: 1px solid rgb(99 102 241 / 30%);
  color: var(--accent-h);
  margin-top: 1px;
  transition:
    background 0.15s,
    color 0.15s,
    border-color 0.15s;
}

.qs-tx {
  min-width: 0;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.qs-item:hover {
  border-color: var(--accent);
  background: var(--accent-weak);
  box-shadow: 0 6px 16px -12px rgb(79 70 229 / 70%);
  transform: translateX(2px);
}

.qs-item:hover .qs-ic {
  background: var(--grad-brand);
  border-color: transparent;
  color: #fff;
}

.qs-item:active {
  transform: translateX(0);
}

.qs-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.pad {
  padding: 0 16px;
  margin: 0;
}

/* 托盘提示（如重复选取）：弱于错误的中性反馈，避免误报红色 */
.note-text {
  padding-bottom: 6px;
  line-height: 1.5;
}

.composer {
  border-top: 1px solid var(--border);
  padding: 13px 16px;
  background:
    linear-gradient(180deg, transparent, rgb(99 102 241 / 4%)), var(--panel);
}

.composer textarea {
  font-size: 16px;
  line-height: 1.6;
}

.crow {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
  flex-wrap: wrap;
}

/* 左工具簇（参考附件）与右动作簇（状态/发送）：两端对齐，簇内 8px 间距 */
.crow-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.crow-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

/* 计费提示：输入行下方独立 helper 行，整行换行不挤按钮 */
.cost-hint {
  display: flex;
  align-items: baseline;
  gap: 5px;
  margin: 8px 2px 0;
  font-size: 11.5px;
  line-height: 1.5;
}

.cost-hint .ic {
  color: var(--warn);
  flex: none;
  align-self: center;
}

.file-in {
  display: none;
}

.att-btn {
  flex: none;
}

@media (prefers-reduced-motion: reduce) {
  .dot {
    animation: none;
  }

  .qs-item,
  .qs-item:hover,
  .qs-item:active {
    transform: none;
  }
}
</style>
